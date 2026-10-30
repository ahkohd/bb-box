import { z } from "zod";
import { calculateCpuUsage, parseMeminfo, parseNetDev, parseNetstatLinks, parseProcStat, parseVmStatUsedBytes, type CpuTimes, type NetworkTotals } from "./collector.ts";
import { containerCapacity, containerCpuPercent, containerMemory, parseContainer, type ContainerCounters, type ContainerFile } from "./container.ts";
import { assessHealth } from "./health.ts";
import { clampPercentage } from "./numbers.ts";
import { macOwnCommand, parseOwnReading, psOwnCommand, type OwnReading } from "./own-usage.ts";
import { parseDfRoot, parseLinuxLoad, parseMacLoad } from "./route.ts";

export type LightOs = "linux" | "macos";

const stallSchema = z.tuple([z.number(), z.number(), z.number()]);
const finite = z.number().finite();

export const lightReadingSchema = z
  .object({
    os: z.enum(["linux", "macos"]),
    bootAt: finite.nullable(),
    visibleCores: z.number().int().nonnegative(),
    memoryTotalBytes: finite.nonnegative().nullable(),
    cpu: z.object({ idle: finite, total: finite }).strict().nullable(),
    memoryUsedBytes: finite.nonnegative().nullable(),
    container: z
      .object({
        usageMicros: finite,
        cpuCapacity: finite.nullable(),
        cpusetCount: z.number().int().nullable(),
        memoryCurrentBytes: finite,
        inactiveFileBytes: finite,
        fileBytes: finite,
        memoryLimitBytes: finite.nullable(),
        swapCurrentBytes: finite.nullable(),
        swapLimitBytes: finite.nullable(),
        cpuStall: stallSchema.nullable(),
        memoryStall: stallSchema.nullable(),
      })
      .strict()
      .nullable(),
    load: z.tuple([finite, finite, finite]).nullable(),
    disk: z.object({ totalBytes: finite.nonnegative(), usedBytes: finite.nonnegative() }).strict().nullable(),
    network: z.object({ interface: z.string().max(64), rxBytes: finite.nonnegative(), txBytes: finite.nonnegative() }).strict().nullable(),
    own: z
      .object({
        mode: z.enum(["with-children", "self-only"]),
        rows: z.array(z.object({ pid: z.number().int(), started: z.string().max(64), ppid: z.number().int().nullable(), selfSeconds: finite, childSeconds: finite, memoryBytes: finite }).strict()).max(20_000),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type LightWire = z.infer<typeof lightReadingSchema>;

export interface LightReading {
  readonly os: LightOs;
  readonly bootAt: number | null;
  readonly visibleCores: number;
  readonly memoryTotalBytes: number | null;
  readonly cpu: CpuTimes | null;
  readonly memoryUsedBytes: number | null;
  readonly container: ContainerCounters | null;
  readonly load: [number, number, number] | null;
  readonly disk: { readonly totalBytes: number; readonly usedBytes: number } | null;
  readonly network: NetworkTotals | null;
  readonly own: OwnReading | null;
}

export interface LightRequest {
  readonly own: boolean;
  readonly machine: boolean;
}

const MARK = "@@";

const LINUX_CGROUP_WHOLE: readonly ContainerFile[] = ["cpu.max", "cpuset.cpus.effective", "memory.current", "memory.max"];
const LINUX_CGROUP_LINES: readonly (readonly [ContainerFile, string])[] = [
  ["cpu.stat", "^usage_usec "],
  ["memory.stat", "^inactive_file "],
  ["cpu.pressure", "^some "],
  ["memory.pressure", "^some "],
];

function part(name: string, command: string): string {
  return `printf '${MARK}${name}\\n'; ${command} 2>/dev/null`;
}

function linuxScript(): string {
  const cgroup = "/sys/fs/cgroup";
  return [
    part("stat", "head -n 1 /proc/stat; grep -c '^cpu[0-9]' /proc/stat; grep '^btime' /proc/stat"),
    part("meminfo", "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo"),
    part("loadavg", "cat /proc/loadavg"),
    part("df", "df -Pk / | tail -n 1"),
    part("net", `d=$(awk '$2=="00000000"{print $1; exit}' /proc/net/route); [ -n "$d" ] && grep "^ *$d:" /proc/net/dev`),
    ...LINUX_CGROUP_WHOLE.map((name) => `[ -f ${cgroup}/${name} ] && { ${part(`cgroup:${name}`, `cat ${cgroup}/${name}`)}; }`),
    ...LINUX_CGROUP_LINES.map(([name, pattern]) => `[ -f ${cgroup}/${name} ] && { ${part(`cgroup:${name}`, `grep '${pattern}' ${cgroup}/${name}`)}; }`),
    "true",
  ].join("; ");
}

const VM_STAT_LINES = "page size|Anonymous pages|Pages purgeable|Pages wired down|Pages occupied by compressor";

function macScript(request: LightRequest): string {
  return [
    part("sysctl", "sysctl -n hw.ncpu hw.memsize"),
    ...(request.machine
      ? [
          part("boot", "sysctl -n kern.boottime"),
          part("loadavg", "sysctl -n vm.loadavg"),
          part("vmstat", `LC_ALL=C vm_stat | grep -E '${VM_STAT_LINES}'`),
          part("df", "df -Pk / | tail -n 1"),
          part("net", `d=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}'); [ -n "$d" ] && LC_ALL=C netstat -ibn -I "$d" | grep '<Link#'`),
        ]
      : []),
    ...(request.own ? [part("own", macOwnCommand())] : []),
    "true",
  ].join("; ");
}

export function lightScript(os: LightOs, request: LightRequest): string {
  if (os === "macos") return macScript(request);
  return request.own ? `${linuxScript()}; ${part("own", psOwnCommand())}; true` : linuxScript();
}

export function lightSections(output: string): Map<string, string> {
  const sections = new Map<string, string>();
  for (const piece of `\n${output}`.split(`\n${MARK}`).slice(1)) {
    const end = piece.indexOf("\n");
    sections.set((end < 0 ? piece : piece.slice(0, end)).trim(), end < 0 ? "" : piece.slice(end + 1).replace(/\n$/, ""));
  }
  return sections;
}

function wholeNumber(text: string | undefined): number | null {
  const value = Number((text ?? "").trim());
  return (text ?? "").trim() !== "" && Number.isFinite(value) ? value : null;
}

function diskOf(text: string | undefined): LightReading["disk"] {
  const disk = parseDfRoot(text);
  return disk ? { totalBytes: disk.totalBytes, usedBytes: disk.usedBytes } : null;
}

function linuxReading(sections: Map<string, string>): LightReading {
  const stat = sections.get("stat") ?? "";
  const lines = stat.split("\n");
  const cpu = parseProcStat(lines[0] ?? "")?.total ?? null;
  const visibleCores = wholeNumber(lines.find((line, index) => index > 0 && /^\d+$/.test(line.trim()))) ?? 0;
  const bootAt = wholeNumber(/^btime\s+(\d+)/m.exec(stat)?.[1]);
  const meminfo = parseMeminfo(sections.get("meminfo") ?? "");
  const files: Partial<Record<ContainerFile, string>> = {};
  for (const [name, text] of sections) if (name.startsWith("cgroup:") && text.trim() !== "") files[name.slice("cgroup:".length) as ContainerFile] = text;
  const memoryTotalBytes = meminfo.get("MemTotal") ?? null;
  const available = meminfo.get("MemAvailable");
  return {
    os: "linux",
    bootAt,
    visibleCores,
    memoryTotalBytes,
    cpu,
    memoryUsedBytes: memoryTotalBytes !== null && available !== undefined ? Math.max(0, memoryTotalBytes - available) : null,
    container: parseContainer(files),
    load: parseLinuxLoad(sections.get("loadavg")),
    disk: diskOf(sections.get("df")),
    network: parseNetDev(`\n\n${sections.get("net") ?? ""}`),
    own: sections.has("own") ? parseOwnReading(sections.get("own") ?? "") : null,
  };
}

function macReading(sections: Map<string, string>): LightReading {
  const [cores, memsize] = (sections.get("sysctl") ?? "").trim().split(/\s+/).map(Number);
  const boot = Number(/sec\s*=\s*(\d+)/.exec(sections.get("boot") ?? "")?.[1]);
  return {
    os: "macos",
    bootAt: Number.isFinite(boot) ? boot : null,
    visibleCores: Number.isSafeInteger(cores) && cores! > 0 ? cores! : 0,
    memoryTotalBytes: Number.isFinite(memsize) && memsize! > 0 ? memsize! : null,
    cpu: null,
    memoryUsedBytes: sections.has("vmstat") ? parseVmStatUsedBytes(sections.get("vmstat") ?? "") : null,
    container: null,
    load: sections.has("loadavg") ? parseMacLoad(sections.get("loadavg")) : null,
    disk: diskOf(sections.get("df")),
    network: sections.has("net") ? parseNetstatLinks(sections.get("net") ?? "") : null,
    own: sections.has("own") ? parseOwnReading(sections.get("own") ?? "") : null,
  };
}

export function parseLightOutput(os: LightOs, output: string): LightReading {
  const sections = lightSections(output);
  return os === "macos" ? macReading(sections) : linuxReading(sections);
}

export interface Kept {
  readonly at: number;
  readonly tick?: number | null;
  readonly reading: LightReading;
}

export interface Capacity {
  readonly cores: number;
  readonly memoryBytes: number | null;
}

export function capacityOf(reading: LightReading): Capacity {
  if (reading.container) {
    const memory = containerMemory(reading.container, reading.memoryTotalBytes ?? 0);
    return { cores: containerCapacity(reading.container, reading.visibleCores), memoryBytes: memory.totalBytes };
  }
  return { cores: Math.max(1, reading.visibleCores), memoryBytes: reading.memoryTotalBytes };
}

export interface SlotShare {
  readonly cores: number;
  readonly memoryBytes: number;
}

export function shareOf(macCores: number, macMemoryBytes: number, most: number): SlotShare {
  const slots = Math.max(1, Math.round(most));
  return { cores: macCores / slots, memoryBytes: macMemoryBytes / slots };
}

export const HIGH = { cpu: 1, cpuPressure: 2, memory: 4, memoryPressure: 8, disk: 16, load: 32 } as const;

export type HighReason = keyof typeof HIGH;

const HIGH_LABELS: Readonly<Record<string, HighReason>> = { CPU: "cpu", "CPU pressure": "cpuPressure", Memory: "memory", "Memory pressure": "memoryPressure", Disk: "disk", "System load": "load" };

export function reasonsOf(high: number): HighReason[] {
  return (Object.keys(HIGH) as HighReason[]).filter((reason) => (high & HIGH[reason]) !== 0);
}

export interface Point {
  readonly start: number;
  readonly end: number;
  readonly cpu: number | null;
  readonly memory: number | null;
  readonly disk: number | null;
  readonly down: number | null;
  readonly up: number | null;
  readonly load: number | null;
  readonly cores: number | null;
  readonly cpuStall: number | null;
  readonly memoryStall: number | null;
  readonly high: number;
}

export type Baseline = "first" | "stale" | "clock" | "started" | "rebooted" | "reset" | "resized";

export type Measured = { readonly is: "point"; readonly point: Point } | { readonly is: "baseline"; readonly why: Baseline };

export const COUNTERS_LAST_MS = 150_000;
export const CLOCK_STEP_MS = 1_000;

const BOOT_SLACK_SECONDS = 2;

function counterWent(previous: LightReading, current: LightReading): boolean {
  if (previous.container && current.container) return current.container.usageMicros < previous.container.usageMicros;
  if (previous.cpu && current.cpu) return current.cpu.total < previous.cpu.total || current.cpu.idle < previous.cpu.idle || current.cpu.total - current.cpu.idle < previous.cpu.total - previous.cpu.idle;
  return false;
}

function sameCapacity(previous: LightReading, current: LightReading): boolean {
  const before = capacityOf(previous);
  const now = capacityOf(current);
  return Math.abs(before.cores - now.cores) < 1e-6 && before.memoryBytes === now.memoryBytes && Boolean(previous.container) === Boolean(current.container);
}

function elapsedMs(previous: Kept, current: Kept): number {
  return typeof previous.tick === "number" && typeof current.tick === "number" ? current.tick - previous.tick : current.at - previous.at;
}

export function clockStepped(previous: Kept, current: Kept): boolean {
  if (typeof previous.tick !== "number" || typeof current.tick !== "number") return false;
  return Math.abs(current.at - previous.at - (current.tick - previous.tick)) > CLOCK_STEP_MS;
}

export function baselineWhy(previous: Kept | null, current: Kept, lastStartAt: number | null): Baseline | null {
  if (!previous) return "first";
  if (clockStepped(previous, current)) return "clock";
  const elapsed = elapsedMs(previous, current);
  if (elapsed > COUNTERS_LAST_MS || elapsed <= 0 || current.at <= previous.at) return "stale";
  if (lastStartAt !== null && previous.at < lastStartAt) return "started";
  const bootBefore = previous.reading.bootAt;
  const bootNow = current.reading.bootAt;
  if (bootBefore !== null && bootNow !== null && Math.abs(bootBefore - bootNow) > BOOT_SLACK_SECONDS) return "rebooted";
  if (counterWent(previous.reading, current.reading)) return "reset";
  if (!sameCapacity(previous.reading, current.reading)) return "resized";
  return null;
}

function rates(previous: Kept, current: Kept): { down: number | null; up: number | null } {
  const before = previous.reading.network;
  const now = current.reading.network;
  const seconds = elapsedMs(previous, current) / 1000;
  if (!before || !now || before.interface !== now.interface || seconds <= 0 || now.rxBytes < before.rxBytes || now.txBytes < before.txBytes) return { down: null, up: null };
  return { down: (now.rxBytes - before.rxBytes) / seconds, up: (now.txBytes - before.txBytes) / seconds };
}

function highOf(readings: Parameters<typeof assessHealth>[0]): number {
  return assessHealth(readings).issues.reduce((bits, issue) => bits | (HIGH[HIGH_LABELS[issue.label] ?? "cpu"] ?? 0), 0);
}

function diskPercent(reading: LightReading): number | null {
  const disk = reading.disk;
  return disk && disk.totalBytes > 0 ? clampPercentage((disk.usedBytes / disk.totalBytes) * 100) : null;
}

export function machinePoint(previous: Kept, current: Kept): Point {
  const now = current.reading;
  const container = now.container;
  const capacity = capacityOf(now);
  const cpu = container
    ? containerCpuPercent(previous.reading.container ? { usageMicros: previous.reading.container.usageMicros, at: previous.at } : null, { usageMicros: container.usageMicros, at: previous.at + elapsedMs(previous, current) }, capacity.cores)
    : previous.reading.cpu && now.cpu
      ? calculateCpuUsage(previous.reading.cpu, now.cpu)
      : null;
  const memory = container
    ? (() => {
        const used = containerMemory(container, now.memoryTotalBytes ?? 0);
        return used.totalBytes > 0 ? clampPercentage((used.usedBytes / used.totalBytes) * 100) : null;
      })()
    : now.memoryUsedBytes !== null && now.memoryTotalBytes
      ? clampPercentage((now.memoryUsedBytes / now.memoryTotalBytes) * 100)
      : null;
  const disk = diskPercent(now);
  const load = container ? null : (now.load?.[1] ?? null);
  const cores = Math.max(1, Math.ceil(capacity.cores - 1e-6));
  const cpuStall = container?.cpuStall?.[1] ?? null;
  const memoryStall = container?.memoryStall?.[1] ?? null;
  return {
    start: previous.at,
    end: current.at,
    cpu,
    memory,
    disk,
    ...rates(previous, current),
    load,
    cores,
    cpuStall,
    memoryStall,
    high: highOf({ cpuPercent: cpu, memoryPercent: memory, diskPercent: disk, load: load === null ? null : { fiveMinutes: load, cores }, cpuStall: container?.cpuStall ?? null, memoryStall: container?.memoryStall ?? null }),
  };
}

export function slotPoint(previous: Kept, current: Kept, own: { cpuCores: number | null; memoryBytes: number }, share: SlotShare): Point {
  const cpu = own.cpuCores === null || share.cores <= 0 ? null : (own.cpuCores / share.cores) * 100;
  const memory = share.memoryBytes > 0 ? (own.memoryBytes / share.memoryBytes) * 100 : null;
  return {
    start: previous.at,
    end: current.at,
    cpu,
    memory,
    disk: null,
    down: null,
    up: null,
    load: null,
    cores: null,
    cpuStall: null,
    memoryStall: null,
    high: highOf({ cpuPercent: cpu, memoryPercent: memory, diskPercent: null, load: null }),
  };
}

export function measure(previous: Kept | null, current: Kept, lastStartAt: number | null): Measured {
  const why = baselineWhy(previous, current, lastStartAt);
  if (why || !previous) return { is: "baseline", why: why ?? "first" };
  return { is: "point", point: machinePoint(previous, current) };
}
