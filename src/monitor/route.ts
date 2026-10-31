import type { MetricPoint, MonitorSnapshot } from "./snapshot.ts";
import { CONTAINER_FILES, containerCapacity, containerCpuPercent, containerMemory, parseContainer, type ContainerFile } from "./container.ts";
import { NO_PROCESSES, PROCESS_COLUMNS, calculateCpuUsage, gpuPoints, calculateNetworkRates, diskFrom, memoryDetailsFrom, parseMeminfo, parseNetDev, parseNetstatLinks, parseProcStat, parseProcesses, parseVmStatUsedBytes, pushHistory, type CpuTimes, type NetworkTotals, type ProcessScope } from "./collector.ts";
import { assessHealth } from "./health.ts";
import { clampPercentage } from "./numbers.ts";
import { gpuPids, gpuReadingFromSections, nvidiaScript } from "./nvidia.ts";
import { createOwnUsage, macOwnCommand, parseOwnReading, psOwnCommand, type OwnUsage } from "./own-usage.ts";

export type RouteOs = "linux" | "macos";

const MARK = "@@bb-box-monitor:";

function section(name: string, command: string): string {
  return `printf '\\n${MARK}${name}\\n'; ${command} 2>/dev/null`;
}

function processCommand(scope: ProcessScope): string {
  return scope === "user" ? `LC_ALL=C ps -U "$(id -u)" -o ${PROCESS_COLUMNS}` : `LC_ALL=C ps -eo ${PROCESS_COLUMNS}`;
}

export function routeScript(os: RouteOs, scope: ProcessScope): string {
  const common = [section("uname", "uname -srm"), section("hostname", "hostname"), section("df", "df -Pk / | tail -n 1"), section("ps", processCommand(scope)), ...(scope === "user" ? [section("own", os === "macos" ? macOwnCommand() : psOwnCommand())] : [])];
  if (os === "macos") {
    return [
      ...common,
      section("ncpu", "sysctl -n hw.ncpu"),
      section("memsize", "sysctl -n hw.memsize"),
      section("loadavg", "sysctl -n vm.loadavg"),
      section("boottime", "sysctl -n kern.boottime"),
      section("brand", "sysctl -n machdep.cpu.brand_string"),
      section("now", "date +%s"),
      section("vmstat", "LC_ALL=C vm_stat"),
      section("netstat", "LC_ALL=C netstat -ibn"),
    ].join("; ");
  }
  return [
    ...common,
    section("uptime", "cat /proc/uptime"),
    section("stat", "cat /proc/stat"),
    section("meminfo", "cat /proc/meminfo"),
    section("loadavg", "cat /proc/loadavg"),
    section("netdev", "cat /proc/net/dev"),
    section("cpuinfo", "grep -m 1 '^model name' /proc/cpuinfo"),
    ...CONTAINER_FILES.map((name) => section(`cgroup:${name}`, `[ -f /sys/fs/cgroup/${name} ] && cat /sys/fs/cgroup/${name}`)),
    ...(scope === "machine" ? [nvidiaScript(section)] : []),
    "true",
  ].join("; ");
}

export function routeSections(output: string): Map<string, string> {
  const sections = new Map<string, string>();
  const parts = output.split(`\n${MARK}`);
  for (const part of parts.slice(1)) {
    const end = part.indexOf("\n");
    const name = end < 0 ? part : part.slice(0, end);
    sections.set(name.trim(), end < 0 ? "" : part.slice(end + 1).replace(/\n$/, ""));
  }
  return sections;
}

function firstNumber(text: string | undefined): number | null {
  const value = Number((text ?? "").trim().split(/\s+/)[0]);
  return Number.isFinite(value) ? value : null;
}

export function parseMacLoad(text: string | undefined): [number, number, number] | null {
  const values = (text ?? "").replace(/[{}]/g, " ").trim().split(/\s+/).slice(0, 3).map(Number);
  return values.length === 3 && values.every(Number.isFinite) ? [values[0]!, values[1]!, values[2]!] : null;
}

export function parseLinuxLoad(text: string | undefined): [number, number, number] | null {
  const values = (text ?? "").trim().split(/\s+/).slice(0, 3).map(Number);
  return values.length === 3 && values.every(Number.isFinite) ? [values[0]!, values[1]!, values[2]!] : null;
}

export function parseDfRoot(text: string | undefined): MonitorSnapshot["disk"] {
  const fields = (text ?? "").trim().split(/\s+/);
  if (fields.length < 6) return null;
  const [totalKiB, usedKiB, availableKiB] = fields.slice(1, 4).map(Number);
  if (![totalKiB, usedKiB, availableKiB].every((value) => Number.isSafeInteger(value) && value! >= 0)) return null;
  return diskFrom(totalKiB!, totalKiB! - usedKiB!, availableKiB!, 1024, fields[fields.length - 1] ?? "/");
}

function unameParts(text: string | undefined): { platform: string; release: string; arch: string } {
  const [system, release, machine] = (text ?? "").trim().split(/\s+/);
  return { platform: system === "Darwin" ? "darwin" : system === "Linux" ? "linux" : (system ?? "unknown").toLowerCase(), release: release ?? "", arch: machine === "x86_64" ? "x64" : machine === "aarch64" ? "arm64" : (machine ?? "") };
}

function containerFiles(sections: Map<string, string>): Partial<Record<ContainerFile, string>> {
  const files: Partial<Record<ContainerFile, string>> = {};
  for (const name of CONTAINER_FILES) {
    const text = sections.get(`cgroup:${name}`);
    if (text !== undefined && text.trim() !== "") files[name] = text;
  }
  return files;
}

export interface RouteReading {
  readonly sections: Map<string, string>;
  readonly receivedAt: number;
}

export interface RouteOptions {
  readonly os: RouteOs;
  readonly scope: ProcessScope;
  readonly refreshIntervalMs: () => number;
}

export function createRouteCollector(options: RouteOptions) {
  let previousCpu: CpuTimes | null = null;
  let previousPerCore: CpuTimes[] | null = null;
  let previousContainer: { usageMicros: number; at: number } | null = null;
  let previousNetwork: NetworkTotals | null = null;
  let previousNetworkAt: number | null = null;
  const history: MetricPoint[] = [];
  const ownUsage = createOwnUsage();

  function ownOf(sections: Map<string, string>, at: number): OwnUsage | null {
    if (options.scope !== "user" || !sections.has("own")) return null;
    return ownUsage.take(parseOwnReading(sections.get("own") ?? ""), at);
  }

  function snapshot(reading: RouteReading): MonitorSnapshot {
    const { sections } = reading;
    const uname = unameParts(sections.get("uname"));
    const hostname = (sections.get("hostname") ?? "").trim() || "box";
    const disk = parseDfRoot(sections.get("df"));
    const container = options.os === "linux" ? parseContainer(containerFiles(sections)) : null;
    const gpus = options.os === "linux" ? gpuReadingFromSections(sections, container !== null) : null;
    const processes = sections.has("ps") ? parseProcesses(sections.get("ps") ?? "", (command) => command.split("/").pop() ?? command, gpuPids(gpus)) : NO_PROCESSES;
    const timestamp = Date.now();
    const own = ownOf(sections, reading.receivedAt);
    const read = options.os === "macos" ? macSnapshot(sections, uname, hostname, disk, processes, timestamp, reading.receivedAt) : linuxSnapshot(sections, uname, hostname, disk, processes, timestamp, gpus, container);
    return own ? withOwn(read, own) : read;
  }

  function withOwn(read: MonitorSnapshot, own: OwnUsage): MonitorSnapshot {
    const latest = history.at(-1);
    if (latest) {
      history[history.length - 1] = { ...latest, ownCpuCores: own.cpuCores, ownMemoryBytes: own.memoryBytes };
    }
    return { ...read, own, history: [...history] };
  }

  function network(totals: NetworkTotals | null, at: number) {
    const elapsedSeconds = previousNetworkAt === null ? null : (at - previousNetworkAt) / 1000;
    const result = totals === null ? null : { interface: totals.interface, ...calculateNetworkRates(previousNetwork, totals, elapsedSeconds), rxTotalBytes: totals.rxBytes, txTotalBytes: totals.txBytes };
    previousNetwork = totals;
    previousNetworkAt = at;
    return result;
  }

  function linuxSnapshot(sections: Map<string, string>, uname: ReturnType<typeof unameParts>, hostname: string, disk: MonitorSnapshot["disk"], processes: MonitorSnapshot["processes"], timestamp: number, gpus: MonitorSnapshot["gpus"], container: ReturnType<typeof parseContainer>): MonitorSnapshot {
    const uptimeSeconds = firstNumber(sections.get("uptime")) ?? 0;
    const at = uptimeSeconds * 1000;
    const stat = parseProcStat(sections.get("stat") ?? "");
    const visibleCores = stat?.perCore.length ?? 0;
    const capacity = container ? containerCapacity(container, visibleCores) : Math.max(1, visibleCores);
    const cores = Math.max(1, Math.ceil(capacity - 1e-6));
    const sameCoreCount = previousPerCore?.length === stat?.perCore.length;
    const usagePercent = container
      ? containerCpuPercent(previousContainer, { usageMicros: container.usageMicros, at }, capacity)
      : stat ? calculateCpuUsage(sameCoreCount ? previousCpu : null, stat.total) : null;
    const perCoreUsagePercent = stat && (!container || visibleCores === cores)
      ? stat.perCore.map((current, index) => calculateCpuUsage(sameCoreCount ? previousPerCore?.[index] ?? null : null, current))
      : [];
    previousCpu = stat?.total ?? null;
    previousPerCore = stat?.perCore ?? null;
    previousContainer = container ? { usageMicros: container.usageMicros, at } : null;
    const meminfo = parseMeminfo(sections.get("meminfo") ?? "");
    const visibleTotal = meminfo.get("MemTotal") ?? 0;
    const details = memoryDetailsFrom(meminfo, meminfo.get("MemFree") ?? 0);
    const own = container ? containerMemory(container, visibleTotal) : null;
    const totalBytes = own?.totalBytes ?? visibleTotal;
    const availableBytes = own?.availableBytes ?? Math.min(totalBytes, Math.max(0, details.availableBytes));
    const usedBytes = totalBytes - availableBytes;
    const memoryPercent = totalBytes === 0 ? 0 : clampPercentage((usedBytes / totalBytes) * 100);
    const net = network(parseNetDev(sections.get("netdev") ?? ""), at);
    const loadAverage = container ? null : parseLinuxLoad(sections.get("loadavg"));
    return {
      timestamp: new Date(timestamp).toISOString(),
      refreshIntervalMs: options.refreshIntervalMs(),
      host: { hostname, ...uname, uptimeSeconds, ...(container ? { container: true } : {}) },
      cpu: {
        model: (sections.get("cpuinfo") ?? "").replace(/^model name\s*:\s*/, "").trim() || "Unknown CPU",
        cores,
        speedMHz: 0,
        usagePercent,
        perCoreUsagePercent,
        loadAverage,
        stallPercent: container?.cpuStall ?? null,
      },
      memory: {
        totalBytes,
        usedBytes,
        freeBytes: own ? own.availableBytes : (meminfo.get("MemFree") ?? 0),
        availableBytes,
        cachedBytes: own?.cachedBytes ?? details.cachedBytes,
        buffersBytes: own ? 0 : details.buffersBytes,
        swapTotalBytes: own?.swapTotalBytes ?? details.swapTotalBytes,
        swapUsedBytes: own?.swapUsedBytes ?? details.swapUsedBytes,
        usagePercent: memoryPercent,
        stallPercent: container?.memoryStall ?? null,
      },
      disk,
      network: net,
      gpus,
      processes,
      runtime: null,
      health: assessHealth({ cpuPercent: usagePercent, memoryPercent, diskPercent: disk?.usagePercent ?? null, load: loadAverage ? { fiveMinutes: loadAverage[1], cores } : null, cpuStall: container?.cpuStall ?? null, memoryStall: container?.memoryStall ?? null }),
      history: pushHistory(history, { timestamp, cpuPercent: usagePercent, memoryPercent, networkRxBytesPerSecond: net?.rxBytesPerSecond ?? null, networkTxBytesPerSecond: net?.txBytesPerSecond ?? null, ...(gpus ? { gpus: gpuPoints(gpus) } : {}) }),
    };
  }

  function macSnapshot(sections: Map<string, string>, uname: ReturnType<typeof unameParts>, hostname: string, disk: MonitorSnapshot["disk"], processes: MonitorSnapshot["processes"], timestamp: number, receivedAt: number): MonitorSnapshot {
    const cores = Math.max(1, firstNumber(sections.get("ncpu")) ?? 1);
    const totalBytes = firstNumber(sections.get("memsize")) ?? 0;
    const usedFromVmStat = parseVmStatUsedBytes(sections.get("vmstat") ?? "");
    const usedBytes = Math.min(totalBytes, usedFromVmStat ?? 0);
    const memoryPercent = totalBytes === 0 ? 0 : clampPercentage((usedBytes / totalBytes) * 100);
    const bootSeconds = Number(/sec\s*=\s*(\d+)/.exec(sections.get("boottime") ?? "")?.[1]);
    const now = firstNumber(sections.get("now"));
    const uptimeSeconds = Number.isFinite(bootSeconds) && now !== null ? Math.max(0, now - bootSeconds) : 0;
    const loadAverage = parseMacLoad(sections.get("loadavg"));
    const net = network(parseNetstatLinks(sections.get("netstat") ?? ""), receivedAt);
    return {
      timestamp: new Date(timestamp).toISOString(),
      refreshIntervalMs: options.refreshIntervalMs(),
      host: { hostname, ...uname, uptimeSeconds },
      cpu: { model: (sections.get("brand") ?? "").trim() || "Unknown CPU", cores, speedMHz: 0, usagePercent: null, perCoreUsagePercent: [], loadAverage, stallPercent: null },
      memory: { totalBytes, usedBytes, freeBytes: Math.max(0, totalBytes - usedBytes), availableBytes: Math.max(0, totalBytes - usedBytes), cachedBytes: 0, buffersBytes: 0, swapTotalBytes: 0, swapUsedBytes: 0, usagePercent: memoryPercent, stallPercent: null },
      disk,
      network: net,
      processes,
      runtime: null,
      health: assessHealth({ cpuPercent: null, memoryPercent, diskPercent: disk?.usagePercent ?? null, load: loadAverage ? { fiveMinutes: loadAverage[1], cores } : null }),
      history: pushHistory(history, { timestamp, cpuPercent: null, memoryPercent, networkRxBytesPerSecond: net?.rxBytesPerSecond ?? null, networkTxBytesPerSecond: net?.txBytesPerSecond ?? null }),
    };
  }

  function reset() {
    previousCpu = null;
    previousPerCore = null;
    previousContainer = null;
    previousNetwork = null;
    previousNetworkAt = null;
    history.length = 0;
    ownUsage.reset();
  }

  return { snapshot, reset };
}

export type RouteCollector = ReturnType<typeof createRouteCollector>;
