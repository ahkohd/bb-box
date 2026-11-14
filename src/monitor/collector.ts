import { execFile } from "node:child_process";
import { readFile, readlink, statfs } from "node:fs/promises";
import { arch, cpus, freemem, hostname, loadavg, platform, release, totalmem, uptime } from "node:os";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { basename } from "node:path";
import type { MetricPoint, MonitorSnapshot, Processes } from "./snapshot.ts";
import { createTailscaleReader, type TailscaleStatusRead } from "./tailscale.ts";
import { readBattery } from "./battery.ts";
import { readMacSensors } from "./mac-sensors.ts";
import { containerCapacity, containerCpuPercent, containerMemory, readContainer, type ContainerCounters } from "./container.ts";
import { assessHealth } from "./health.ts";
import { clampPercentage } from "./numbers.ts";
import { gpuMemoryPercent, gpuPids, type GpuReading } from "./nvidia.ts";
import { readNvidiaHere } from "./nvidia-local.ts";
import { createOwnUsage, developerToolsLook, parseOwnReading, psOwnArgs, readMacOwn, type OwnReading, type OwnUsage } from "./own-usage.ts";

export { clampPercentage } from "./numbers.ts";

const ROOT_MOUNT = "/";
export const HISTORY_LIMIT = 72;
const execFileAsync = promisify(execFile);

export type ProcessScope = "machine" | "user";

export interface CpuTimes { idle: number; total: number }
export interface NetworkTotals { interface: string; rxBytes: number; txBytes: number }
interface MemoryDetails {
  availableBytes: number;
  cachedBytes: number;
  buffersBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
}

export function calculateNetworkRates(previous: NetworkTotals | null, current: NetworkTotals, elapsedSeconds: number | null) {
  if (!previous || previous.interface !== current.interface || elapsedSeconds === null || !Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0 || current.rxBytes < previous.rxBytes || current.txBytes < previous.txBytes) {
    return { rxBytesPerSecond: null, txBytesPerSecond: null };
  }
  return { rxBytesPerSecond: (current.rxBytes - previous.rxBytes) / elapsedSeconds, txBytesPerSecond: (current.txBytes - previous.txBytes) / elapsedSeconds };
}

export function calculateCpuUsage(previous: CpuTimes | null, current: CpuTimes): number | null {
  if (previous === null) return null;
  const idleDelta = current.idle - previous.idle;
  const totalDelta = current.total - previous.total;
  if (totalDelta <= 0 || idleDelta < 0 || idleDelta > totalDelta) return null;
  return clampPercentage(((totalDelta - idleDelta) / totalDelta) * 100);
}

export function cpuTimesFor(cpu: ReturnType<typeof cpus>[number]): CpuTimes {
  return {
    idle: cpu.times.idle,
    total: Object.values(cpu.times).reduce((sum, value) => sum + value, 0),
  };
}

export function readCpuTimes(cpuList: ReturnType<typeof cpus>): CpuTimes {
  return sumCpuTimes(cpuList.map(cpuTimesFor));
}

export function sumCpuTimes(times: readonly CpuTimes[]): CpuTimes {
  return times.reduce((result, current) => ({ idle: result.idle + current.idle, total: result.total + current.total }), { idle: 0, total: 0 });
}

export function parseProcStat(source: string): { total: CpuTimes; perCore: CpuTimes[] } | null {
  let total: CpuTimes | null = null;
  const perCore: CpuTimes[] = [];
  for (const line of source.split("\n")) {
    const match = /^cpu(\d*)\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const times = match[2]!.split(/\s+/).slice(0, 8).map(Number);
    if (times.length < 5 || !times.every(Number.isFinite)) continue;
    const reading = { idle: times[3]! + times[4]!, total: times.reduce((sum, value) => sum + value, 0) };
    if (match[1] === "") total = reading;
    else perCore.push(reading);
  }
  return total ? { total, perCore } : null;
}

export function parseMeminfo(source: string): Map<string, number> {
  const values = new Map<string, number>();
  for (const line of source.split("\n")) {
    const match = /^(\w+):\s+(\d+)\s+kB$/.exec(line.trim());
    if (match) values.set(match[1]!, Number(match[2]) * 1024);
  }
  return values;
}

export function memoryDetailsFrom(values: Map<string, number>, fallbackAvailable: number): MemoryDetails {
  const swapTotalBytes = values.get("SwapTotal") ?? 0;
  const swapFreeBytes = values.get("SwapFree") ?? 0;
  return {
    availableBytes: values.get("MemAvailable") ?? fallbackAvailable,
    cachedBytes: (values.get("Cached") ?? 0) + (values.get("SReclaimable") ?? 0),
    buffersBytes: values.get("Buffers") ?? 0,
    swapTotalBytes,
    swapUsedBytes: Math.max(0, swapTotalBytes - swapFreeBytes),
  };
}

function vmStatPages(source: string, label: string): number | null {
  const count = Number(new RegExp(`^${label}:\\s+(\\d+)\\.`, "m").exec(source)?.[1]);
  return Number.isSafeInteger(count) ? count : null;
}

export function parseVmStatUsedBytes(source: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(source)?.[1]);
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) return null;
  const anonymous = vmStatPages(source, "Anonymous pages");
  const purgeable = vmStatPages(source, "Pages purgeable");
  const wired = vmStatPages(source, "Pages wired down");
  const compressed = vmStatPages(source, "Pages occupied by compressor");
  if (anonymous === null || purgeable === null || wired === null || compressed === null) return null;
  return (Math.max(0, anonymous - purgeable) + wired + compressed) * pageSize;
}

export async function readAvailableMemoryBytes(signal: AbortSignal): Promise<number> {
  if (platform() !== "darwin") return freemem();
  try {
    const { stdout } = await execFileAsync("vm_stat", [], { timeout: 1500, maxBuffer: 64 * 1024, signal, env: { ...process.env, LC_ALL: "C" } });
    const usedBytes = parseVmStatUsedBytes(stdout);
    return usedBytes === null ? freemem() : Math.max(0, totalmem() - usedBytes);
  } catch {
    return freemem();
  }
}

async function readMemoryDetails(signal: AbortSignal): Promise<MemoryDetails> {
  const fallbackAvailable = await readAvailableMemoryBytes(signal);
  const fallback: MemoryDetails = { availableBytes: fallbackAvailable, cachedBytes: 0, buffersBytes: 0, swapTotalBytes: 0, swapUsedBytes: 0 };
  if (platform() !== "linux") return fallback;
  try {
    return memoryDetailsFrom(parseMeminfo(await readFile("/proc/meminfo", { encoding: "utf8", signal })), fallbackAvailable);
  } catch {
    return fallback;
  }
}

export function diskFrom(blocks: number, freeBlocks: number, availableBlocks: number, blockSize: number, mount = ROOT_MOUNT): MonitorSnapshot["disk"] {
  const totalBytes = blocks * blockSize;
  const usedBytes = (blocks - freeBlocks) * blockSize;
  return {
    mount,
    totalBytes,
    usedBytes,
    freeBytes: availableBlocks * blockSize,
    usagePercent: totalBytes === 0 ? 0 : clampPercentage((usedBytes / totalBytes) * 100),
  };
}

export async function readDisk() {
  try {
    const stats = await statfs(ROOT_MOUNT);
    return diskFrom(stats.blocks, stats.bfree, stats.bavail, stats.bsize);
  } catch {
    return null;
  }
}

function busiest(candidates: readonly NetworkTotals[]): NetworkTotals | null {
  return [...candidates].sort((left, right) => right.rxBytes + right.txBytes - left.rxBytes - left.txBytes)[0] ?? null;
}

export function parseNetstatLinks(source: string): NetworkTotals | null {
  return busiest(source.split("\n").flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || !fields[2]?.startsWith("<Link#")) return [];
    const name = fields[0]!.replace(/\*$/, "");
    if (name.startsWith("lo")) return [];
    const rxBytes = Number(fields[fields.length - 5]);
    const txBytes = Number(fields[fields.length - 2]);
    if (!Number.isSafeInteger(rxBytes) || !Number.isSafeInteger(txBytes) || rxBytes < 0 || txBytes < 0) return [];
    return [{ interface: name, rxBytes, txBytes }];
  }));
}

export function parseNetDev(source: string): NetworkTotals | null {
  return busiest(source.split("\n").slice(2).flatMap((line) => {
    const [rawName, rawStats] = line.split(":");
    if (!rawName || !rawStats) return [];
    const name = rawName.trim();
    const stats = rawStats.trim().split(/\s+/).map(Number);
    if (name === "lo" || stats.length < 9 || !Number.isFinite(stats[0]) || !Number.isFinite(stats[8]) || stats[0]! < 0 || stats[8]! < 0) return [];
    return [{ interface: name, rxBytes: stats[0] ?? 0, txBytes: stats[8] ?? 0 }];
  }));
}

export async function readMacNetworkTotals(signal: AbortSignal): Promise<NetworkTotals | null> {
  try {
    const { stdout } = await execFileAsync("netstat", ["-ibn"], { timeout: 1500, maxBuffer: 512 * 1024, signal, env: { ...process.env, LC_ALL: "C" } });
    return parseNetstatLinks(stdout);
  } catch {
    return null;
  }
}

const WINDOWS_NETSH = "/mnt/c/Windows/System32/netsh.exe";
const LOOPBACK_MTU = 4294967295;

export function parseWindowsSubinterfaces(source: string): NetworkTotals | null {
  let rxBytes = 0;
  let txBytes = 0;
  let interfaces = 0;
  for (const line of source.replace(/\r/g, "").split("\n")) {
    const row = /^\s*(\d+)\s+\d+\s+(\d+)\s+(\d+)\s+\S/.exec(line);
    if (!row || Number(row[1]) === LOOPBACK_MTU) continue;
    rxBytes += Number(row[2]);
    txBytes += Number(row[3]);
    interfaces += 1;
  }
  if (interfaces === 0 || !Number.isSafeInteger(rxBytes) || !Number.isSafeInteger(txBytes)) return null;
  return { interface: "Windows", rxBytes, txBytes };
}

let runsInWsl: Promise<boolean> | null = null;

function isWsl(): Promise<boolean> {
  runsInWsl ??= platform() !== "linux"
    ? Promise.resolve(false)
    : readFile("/proc/version", "utf8").then((version) => /microsoft/i.test(version), () => false);
  return runsInWsl;
}

async function readWindowsNetworkTotals(signal: AbortSignal): Promise<NetworkTotals | null> {
  try {
    const { stdout } = await execFileAsync(WINDOWS_NETSH, ["interface", "ipv4", "show", "subinterfaces"], { timeout: 1500, maxBuffer: 64 * 1024, signal, windowsHide: true });
    return parseWindowsSubinterfaces(stdout);
  } catch {
    return null;
  }
}

let windowsCountersSeen = false;

export async function readNetworkTotals(signal: AbortSignal): Promise<NetworkTotals | null> {
  if (platform() === "darwin") return readMacNetworkTotals(signal);
  if (await isWsl()) {
    const windows = await readWindowsNetworkTotals(signal);
    if (windows !== null) windowsCountersSeen = true;
    if (windows !== null || windowsCountersSeen) return windows;
  }
  if (platform() !== "linux") return null;
  try {
    return parseNetDev(await readFile("/proc/net/dev", { encoding: "utf8", signal }));
  } catch {
    return null;
  }
}

export const PROCESS_COLUMNS = "pid=,%cpu=,%mem=,rss=,stat=,comm=";

export function processArgs(scope: ProcessScope, uid: number | null): string[] {
  return scope === "user" && uid !== null ? ["-U", String(uid), "-o", PROCESS_COLUMNS] : ["-eo", PROCESS_COLUMNS];
}

export const TOP_PROCESSES = 6;

function topWith<Row extends { pid: number; cpuPercent: number }>(rows: readonly Row[], pinned: ReadonlySet<number>): Row[] {
  const sorted = [...rows].sort((a, b) => b.cpuPercent - a.cpuPercent || a.pid - b.pid);
  const kept = sorted.filter((row) => pinned.has(row.pid)).slice(0, TOP_PROCESSES);
  const rest = sorted.filter((row) => !pinned.has(row.pid)).slice(0, TOP_PROCESSES - kept.length);
  const chosen = new Set([...kept, ...rest]);
  return sorted.filter((row) => chosen.has(row));
}

export function parseProcesses(source: string, nameOf: (command: string) => string = (command) => command, pinned: ReadonlySet<number> = new Set()): Processes {
  const rows = source.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match || match[6] === "ps") return [];
    const [pid, cpuPercent, memoryPercent, rssKiB] = match.slice(1, 5).map(Number) as [number, number, number, number];
    if (!Number.isSafeInteger(pid) || pid <= 0 || ![cpuPercent, memoryPercent, rssKiB * 1024].every(Number.isFinite)) return [];
    return [{ pid, name: nameOf(match[6]!).slice(0, 128), cpuPercent, memoryPercent, rssBytes: rssKiB * 1024, running: match[5]!.startsWith("R") }];
  });
  return {
    available: true,
    total: rows.length,
    running: rows.filter((row) => row.running).length,
    top: topWith(rows, pinned).map(({ running: _running, ...row }) => row),
  };
}

export const NO_PROCESSES: Processes = { available: false, total: 0, running: 0, top: [] };

async function readProcesses(signal: AbortSignal, scope: ProcessScope, pinned: Promise<ReadonlySet<number>> = Promise.resolve(new Set())): Promise<Processes> {
  try {
    const [{ stdout }, pids] = await Promise.all([execFileAsync("ps", processArgs(scope, process.getuid?.() ?? null), { timeout: 1500, maxBuffer: 512 * 1024, signal, env: { ...process.env, LC_ALL: "C" } }), pinned]);
    const processes = parseProcesses(stdout, platform() === "linux" ? undefined : basename, pids);
    if (platform() === "linux") {
      await Promise.all(processes.top.map(async (entry) => {
        try { entry.name = basename((await readlink(`/proc/${entry.pid}/exe`)).replace(/ \(deleted\)$/, "")).slice(0, 128); }
        catch { return; }
      }));
    }
    return processes;
  } catch {
    return NO_PROCESSES;
  }
}

async function runQuietly(file: string, args: readonly string[], signal: AbortSignal): Promise<string> {
  return (await execFileAsync(file, [...args], { timeout: 3000, maxBuffer: 1024 * 1024, signal, env: { ...process.env, LC_ALL: "C" } })).stdout;
}

const developerToolsThere = developerToolsLook((file, args) => runQuietly(file, args, AbortSignal.timeout(3000)));

async function ownProcessList(signal: AbortSignal, uid: number): Promise<string> {
  const run = (file: string, args: readonly string[]) => runQuietly(file, args, signal);
  if (platform() === "darwin") return readMacOwn(run, uid, developerToolsThere);
  return run("ps", psOwnArgs(uid));
}

export async function readOwnProcesses(signal: AbortSignal): Promise<OwnReading | null> {
  const uid = process.getuid?.();
  if (uid === undefined) return null;
  try {
    return parseOwnReading(await ownProcessList(signal, uid));
  } catch {
    return null;
  }
}

export function gpuPoints(reading: GpuReading | null | undefined): MetricPoint["gpus"] {
  return reading ? reading.cards.map((card) => ({ card: card.index, usage: card.usagePercent, memory: gpuMemoryPercent(card) })) : undefined;
}

export function pushHistory(history: MetricPoint[], point: MetricPoint): MetricPoint[] {
  history.push(point);
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
  return [...history];
}

export function runtimeNow(): MonitorSnapshot["runtime"] {
  const memoryUsage = process.memoryUsage();
  return {
    pid: process.pid,
    nodeVersion: process.version,
    processUptimeSeconds: process.uptime(),
    rssBytes: memoryUsage.rss,
    heapUsedBytes: memoryUsage.heapUsed,
    heapTotalBytes: memoryUsage.heapTotal,
    externalBytes: memoryUsage.external,
  };
}

const BASELINE_WINDOW_MS = 300;

export interface CollectorOptions {
  readonly refreshIntervalMs: () => number;
  readonly scope?: ProcessScope;
  readonly readContainer?: (signal: AbortSignal) => Promise<ContainerCounters | null>;
  readonly readOwn?: (signal: AbortSignal) => Promise<OwnReading | null>;
  readonly readGpus?: (signal: AbortSignal, inContainer: boolean) => Promise<GpuReading | null>;
  readonly readTailscaleStatus?: TailscaleStatusRead;
}

function noReading(): Promise<null> {
  return Promise.resolve(null);
}

export function createCollector(options: CollectorOptions) {
  const scope = options.scope ?? "machine";
  const readTailscale = createTailscaleReader(Date.now, options.readTailscaleStatus);
  const readOwnContainer = options.readContainer ?? ((signal: AbortSignal) => (platform() === "linux" ? readContainer(signal) : noReading()));
  let previousCpuTimes: CpuTimes | null = null;
  let previousPerCoreTimes: CpuTimes[] | null = null;
  let previousContainerUsage: { usageMicros: number; at: number } | null = null;
  let previousNetworkTotals: NetworkTotals | null = null;
  let previousNetworkTimestamp: number | null = null;
  const history: MetricPoint[] = [];
  const ownUsage = createOwnUsage();
  const readOwn = scope === "user" ? options.readOwn ?? readOwnProcesses : noReading;

  async function takeOwn(signal: AbortSignal): Promise<OwnUsage | null> {
    const reading = await readOwn(signal);
    return reading ? ownUsage.take(reading, performance.now()) : null;
  }

  async function takeBaseline(signal: AbortSignal) {
    previousNetworkTotals = await readNetworkTotals(signal);
    previousNetworkTimestamp = performance.now();
    const cpuList = cpus();
    previousCpuTimes = readCpuTimes(cpuList);
    previousPerCoreTimes = cpuList.map(cpuTimesFor);
    const container = await readOwnContainer(signal);
    previousContainerUsage = container ? { usageMicros: container.usageMicros, at: performance.now() } : null;
    await takeOwn(signal);
    await sleep(BASELINE_WINDOW_MS, undefined, { signal });
  }

  const readGpus = options.readGpus ?? ((signal: AbortSignal, inContainer: boolean) => readNvidiaHere(signal, { inContainer, processes: true }));
  let inContainer: Promise<boolean> | null = null;

  async function collect(signal: AbortSignal): Promise<MonitorSnapshot> {
    const whole = scope === "machine";
    inContainer ??= readOwnContainer(signal).then((container) => container !== null, () => false);
    const gpuReading = whole ? inContainer.then((contained) => readGpus(signal, contained)).catch(() => null) : Promise.resolve(null);
    const slowReadings = Promise.all([
      readMemoryDetails(signal),
      readDisk(),
      readProcesses(signal, scope, gpuReading.then(gpuPids)),
      readTailscale(signal),
      whole ? readBattery(signal) : noReading(),
      whole ? readMacSensors(signal) : noReading(),
    ]);
    if (previousCpuTimes === null) {
      await slowReadings;
      await takeBaseline(signal);
    }
    const container = await readOwnContainer(signal);
    const containerAt = performance.now();
    const cpuList = cpus();
    const cpuTimes = readCpuTimes(cpuList);
    const perCoreTimes = cpuList.map(cpuTimesFor);
    const sameCoreCount = previousPerCoreTimes?.length === perCoreTimes.length;
    const visibleCores = Math.max(1, cpuList.length);
    const capacity = container ? containerCapacity(container, cpuList.length) : visibleCores;
    const coreCount = container ? Math.max(1, Math.ceil(capacity - 1e-6)) : visibleCores;
    const usagePercent = container
      ? containerCpuPercent(previousContainerUsage, { usageMicros: container.usageMicros, at: containerAt }, capacity)
      : calculateCpuUsage(sameCoreCount ? previousCpuTimes : null, cpuTimes);
    const perCoreVisible = !container || cpuList.length === coreCount;
    const perCoreUsagePercent = perCoreVisible
      ? perCoreTimes.map((current, index) => calculateCpuUsage(sameCoreCount ? previousPerCoreTimes?.[index] ?? null : null, current))
      : [];
    previousCpuTimes = cpuTimes;
    previousPerCoreTimes = perCoreTimes;
    previousContainerUsage = container ? { usageMicros: container.usageMicros, at: containerAt } : null;
    const userUsage = await takeOwn(signal);

    const [networkReading, [memoryDetails, disk, processes, tailscale, battery, sensors], gpus] = await Promise.all([
      readNetworkTotals(signal).then((totals) => ({ totals, time: performance.now() })),
      slowReadings,
      gpuReading,
    ]);
    signal.throwIfAborted();
    const visibleTotal = totalmem();
    const own = container ? containerMemory(container, visibleTotal) : null;
    const totalBytes = own?.totalBytes ?? visibleTotal;
    const availableBytes = own?.availableBytes ?? Math.min(totalBytes, Math.max(0, memoryDetails.availableBytes));
    const usedBytes = totalBytes - availableBytes;
    const memoryPercent = totalBytes === 0 ? 0 : clampPercentage((usedBytes / totalBytes) * 100);
    const loads = loadavg();
    const timestamp = Date.now();
    const { totals: networkTotals, time: networkTimestamp } = networkReading;
    const elapsedSeconds = previousNetworkTimestamp === null ? null : (networkTimestamp - previousNetworkTimestamp) / 1000;
    const network = networkTotals === null ? null : {
      interface: networkTotals.interface,
      ...calculateNetworkRates(previousNetworkTotals, networkTotals, elapsedSeconds),
      rxTotalBytes: networkTotals.rxBytes,
      txTotalBytes: networkTotals.txBytes,
    };
    previousNetworkTotals = networkTotals;
    previousNetworkTimestamp = networkTimestamp;
    const loadAverage: [number, number, number] | null = container ? null : [loads[0] ?? 0, loads[1] ?? 0, loads[2] ?? 0];

    return {
      timestamp: new Date(timestamp).toISOString(),
      refreshIntervalMs: options.refreshIntervalMs(),
      host: { hostname: hostname(), platform: platform(), release: release(), arch: arch(), uptimeSeconds: uptime(), ...(container ? { container: true } : {}) },
      cpu: {
        model: cpuList[0]?.model.trim() || "Unknown CPU",
        cores: coreCount,
        speedMHz: cpuList.length === 0 ? 0 : cpuList.reduce((sum, cpu) => sum + cpu.speed, 0) / cpuList.length,
        usagePercent,
        perCoreUsagePercent,
        loadAverage,
        stallPercent: container?.cpuStall ?? null,
      },
      memory: {
        totalBytes,
        usedBytes,
        freeBytes: own ? own.availableBytes : freemem(),
        availableBytes,
        cachedBytes: own?.cachedBytes ?? memoryDetails.cachedBytes,
        buffersBytes: own ? 0 : memoryDetails.buffersBytes,
        swapTotalBytes: own?.swapTotalBytes ?? memoryDetails.swapTotalBytes,
        swapUsedBytes: own?.swapUsedBytes ?? memoryDetails.swapUsedBytes,
        usagePercent: memoryPercent,
        stallPercent: container?.memoryStall ?? null,
      },
      disk,
      network,
      tailscale,
      battery,
      sensors,
      gpus,
      processes,
      ...(userUsage ? { own: userUsage } : {}),
      runtime: runtimeNow(),
      health: assessHealth({
        cpuPercent: usagePercent,
        memoryPercent,
        diskPercent: disk?.usagePercent ?? null,
        load: loadAverage ? { fiveMinutes: loadAverage[1], cores: coreCount } : null,
        cpuStall: container?.cpuStall ?? null,
        memoryStall: container?.memoryStall ?? null,
      }),
      history: pushHistory(history, {
        timestamp,
        cpuPercent: usagePercent,
        memoryPercent,
        networkRxBytesPerSecond: network?.rxBytesPerSecond ?? null,
        networkTxBytesPerSecond: network?.txBytesPerSecond ?? null,
        gpuPercent: sensors?.gpuPercent ?? null,
        ...(gpus ? { gpus: gpuPoints(gpus) } : {}),
        ...(userUsage ? { ownCpuCores: userUsage.cpuCores, ownMemoryBytes: userUsage.memoryBytes } : {}),
      }),
    };
  }

  function reset() {
    previousCpuTimes = null;
    previousPerCoreTimes = null;
    previousContainerUsage = null;
    previousNetworkTotals = null;
    previousNetworkTimestamp = null;
    history.length = 0;
    ownUsage.reset();
  }

  return { collect, reset };
}

export type Collector = ReturnType<typeof createCollector>;
