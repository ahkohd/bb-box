import { readFile } from "node:fs/promises";
import { cpus, loadavg, platform, totalmem } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { calculateCpuUsage, clampPercentage, createCollector, readAvailableMemoryBytes, readCpuTimes, type Collector, type CpuTimes, type ProcessScope } from "../monitor/collector.ts";
import { containerCapacity, containerCpuPercent, containerMemory, readContainer, type ContainerCounters } from "../monitor/container.ts";
import { createDemandSampler } from "../monitor/demand-sampler.ts";
import { stopMacSensors } from "../monitor/mac-sensors.ts";
import { createPressureMonitor, type LightSample } from "../monitor/pressure-monitor.ts";
import { createRouteCollector, routeScript, routeSections, type RouteOs } from "../monitor/route.ts";
import type { Machine, MonitorSnapshot, MonitorStatus, SlotReading } from "../monitor/snapshot.ts";
import { assessHealth } from "../monitor/health.ts";
import type { MonitorConfig } from "../core/document.ts";
import type { DoctorCheck } from "../backends/types.ts";

export const MONITOR_OFF_WORDS = "The Monitor is off. Turn it on under Monitor in BB Box's settings.";
export const SERVER_MACHINE = "server";
export const BOX_MACHINE_PREFIX = "box:";
const SELF_ENROLLED_PROVIDERS: ReadonlySet<string> = new Set(["manual"]);
const MOST_ROUTE_READERS = 16;
const ROUTE_TIMEOUT_MS = 15_000;
const HOST_TIMEOUT_MS = 20_000;
const ROUTE_BASELINE_MS = 300;

export interface MonitoredBox {
  readonly id: string;
  readonly name: string;
  readonly ready: boolean;
  readonly hostId: string | null;
  readonly os: string | null;
  readonly commands: boolean;
  readonly slot: { readonly host: string; readonly most: number } | null;
}

export interface MonitorHost {
  readonly id: string;
  readonly name: string;
  readonly connected: boolean;
  readonly machineProviderId: string | null;
}

export interface MonitorDeps {
  readonly settings: () => MonitorConfig;
  readonly hosts: () => Promise<readonly MonitorHost[]>;
  readonly serverHostId: () => Promise<string | null>;
  readonly boxes: () => Promise<readonly MonitoredBox[]>;
  readonly hostSnapshot: (hostId: string, input: { refreshIntervalMs: number; force: boolean; scope: ProcessScope }, timeoutMs: number) => Promise<MonitorSnapshot>;
  readonly runInBox: (boxId: string, script: string, timeoutMs: number) => Promise<{ exitCode: number | null; stdout: string }>;
  readonly encoderRoom: (boxId: string) => Promise<{ usedPercent: number; words: string } | null>;
  readonly log: { warn(message: string): void };
  readonly serverCollector?: Collector;
  readonly lightSampler?: LightSampler;
}

export interface LightSampler {
  read(signal: AbortSignal): Promise<LightSample>;
  reset(): void;
}

export function unreadableWords(name: string): string {
  return `bb-box cannot read box ${name}: it is not a BB machine and runs no shell bb-box can read.`;
}

export function offlineMachineWords(name: string): string {
  return `bb-box cannot read box ${name} now: its BB machine is not answering BB, and it runs no shell bb-box can read without it.`;
}

export function readableState(state: string): boolean {
  return state === "ready" || state === "stopping";
}

export class MonitorOffError extends Error {
  constructor() {
    super(MONITOR_OFF_WORDS);
    this.name = "MonitorOffError";
  }
}

function isBoxProvider(machineProviderId: string | null): boolean {
  return machineProviderId !== null && !SELF_ENROLLED_PROVIDERS.has(machineProviderId);
}

const SUMMARY_LATE_MS = 3 * 60_000;

export function monitorWords(config: MonitorConfig): string {
  if (!config.enabled) return "Off: no machine status in the sidebar, no sampling, no background monitoring and no Mac sensors helper.";
  const background = config.backgroundMonitoring ? `Background monitoring is on, with its notifications ${config.pressureNotifications ? "on" : "off"}.` : "Background monitoring is off.";
  return `On. Machine status reads every ${config.refreshIntervalSeconds} s while it is open. ${background}`;
}

export function monitorChecks(config: MonitorConfig, latest: readonly { type: string; timestamp: number }[], now = Date.now()): DoctorCheck[] {
  const checks: DoctorCheck[] = [{ id: "monitor", name: "Monitor", status: "ok", detail: monitorWords(config), fix: null }];
  if (!config.enabled || !config.backgroundMonitoring) return checks;
  const summary = [...latest].reverse().find((entry) => entry.type === "summary");
  const error = [...latest].reverse().find((entry) => entry.type === "error");
  const late = !summary || now - summary.timestamp > SUMMARY_LATE_MS;
  const failing = error !== undefined && (!summary || error.timestamp > summary.timestamp);
  checks.push({
    id: "monitor.background",
    name: "Background monitoring",
    status: late || failing ? "warn" : "ok",
    detail: summary ? `Last summary at ${new Date(summary.timestamp).toISOString()}.${failing ? " Its last sample or write failed." : ""}` : "No summary recorded yet.",
    fix: late || failing ? "bb box monitor logs shows its records. It samples every 30 seconds and writes a summary each minute." : null,
  });
  return checks;
}

export function sortMachines(machines: Machine[]): Machine[] {
  return machines.sort((left, right) => Number(right.isServer) - Number(left.isServer) || Number(left.isBox) - Number(right.isBox) || left.name.localeCompare(right.name));
}

export function routeOs(box: MonitoredBox): RouteOs | null {
  if (!box.commands) return null;
  return box.os === "linux" ? "linux" : box.os === "macos" ? "macos" : null;
}

export function listMachines(hosts: readonly MonitorHost[], serverHostId: string | null, boxes: readonly MonitoredBox[]): Machine[] {
  const connectedHosts = new Set(hosts.filter((host) => host.connected).map((host) => host.id));
  const boxOnHost = new Map(boxes.flatMap((box) => (box.hostId ? [[box.hostId, box.id] as const] : [])));
  const fromHosts = hosts
    .map((host) => ({ id: host.id, name: host.name, connected: host.connected, isServer: host.id === serverHostId, isBox: boxOnHost.has(host.id) || isBoxProvider(host.machineProviderId), boxId: boxOnHost.get(host.id) ?? null }))
    .filter((machine) => machine.connected || machine.isServer);
  const routed = boxes
    .filter((box) => box.ready && !(box.hostId && connectedHosts.has(box.hostId)) && routeOs(box) !== null)
    .map((box) => ({ id: `${BOX_MACHINE_PREFIX}${box.id}`, name: box.name, connected: true, isServer: false, isBox: true, boxId: box.id }));
  return sortMachines([...fromHosts, ...routed]);
}

export interface SlotPlace {
  readonly host: string;
  readonly most: number;
  readonly encoder: { usedPercent: number; words: string } | null;
}

export function slotShare(snapshot: MonitorSnapshot, most: number): NonNullable<SlotReading["share"]> {
  const slots = Math.max(1, Math.round(most));
  return { slots, cores: snapshot.cpu.cores / slots, memoryBytes: snapshot.memory.totalBytes / slots };
}

function percentOf(part: number, whole: number): number {
  return whole > 0 ? clampPercentage((part / whole) * 100) : 0;
}

function slotHealth(snapshot: MonitorSnapshot, share: NonNullable<SlotReading["share"]>): MonitorSnapshot["health"] {
  const own = snapshot.own ?? null;
  return assessHealth({
    cpuPercent: own?.cpuCores == null ? null : percentOf(own.cpuCores, share.cores),
    memoryPercent: own ? percentOf(own.memoryBytes, share.memoryBytes) : null,
    diskPercent: snapshot.disk?.usagePercent ?? null,
    load: null,
  });
}

export function asSlotReading(snapshot: MonitorSnapshot, place: SlotPlace): MonitorSnapshot {
  const share = slotShare(snapshot, place.most);
  return { ...snapshot, slot: { host: place.host, encoder: place.encoder, share }, health: slotHealth(snapshot, share) };
}

interface RouteReader {
  readonly sampler: ReturnType<typeof createDemandSampler<MonitorSnapshot>>;
}

export function createMonitor(bb: BbPluginApi, deps: MonitorDeps) {
  let config: MonitorConfig = deps.settings();
  const refreshIntervalMs = () => config.refreshIntervalSeconds * 1000;
  const serverCollector = deps.serverCollector ?? createCollector({ refreshIntervalMs });
  const serverSampler = createDemandSampler({ collect: serverCollector.collect, intervalMs: refreshIntervalMs, reset: serverCollector.reset });
  const routeReaders = new Map<string, RouteReader>();
  const lightSampler = deps.lightSampler ?? createLightSampler();
  const pressure = createPressureMonitor(bb, (signal) => lightSampler.read(signal), () => lightSampler.reset());
  pressure.configure(config.enabled && config.backgroundMonitoring, config.pressureNotifications);

  const requireOn = () => {
    if (!config.enabled) throw new MonitorOffError();
  };

  const forgetReadings = () => {
    serverSampler.forget();
    for (const reader of routeReaders.values()) reader.sampler.dispose();
    routeReaders.clear();
    stopMacSensors();
  };

  const withInterval = (snapshot: MonitorSnapshot): MonitorSnapshot => (snapshot.refreshIntervalMs === refreshIntervalMs() ? snapshot : { ...snapshot, refreshIntervalMs: refreshIntervalMs() });

  function routeReader(box: MonitoredBox, os: RouteOs): RouteReader {
    const known = routeReaders.get(box.id);
    if (known) {
      routeReaders.delete(box.id);
      routeReaders.set(box.id, known);
      return known;
    }
    const scope: ProcessScope = box.slot ? "user" : "machine";
    const collector = createRouteCollector({ os, scope, refreshIntervalMs });
    const script = routeScript(os, scope);
    let warm = false;
    const readOnce = async (signal: AbortSignal) => {
      const result = await deps.runInBox(box.id, script, ROUTE_TIMEOUT_MS);
      signal.throwIfAborted();
      if (result.exitCode !== 0 && !result.stdout.includes("@@bb-box-monitor:")) throw new Error(`Box ${box.name} did not answer the reading (exit code ${result.exitCode ?? "none"}).`);
      return collector.snapshot({ sections: routeSections(result.stdout), receivedAt: performance.now() });
    };
    const sampler = createDemandSampler<MonitorSnapshot>({
      collect: async (signal) => {
        if (!warm) {
          await readOnce(signal);
          await sleep(ROUTE_BASELINE_MS, undefined, { signal });
          warm = true;
        }
        return readOnce(signal);
      },
      intervalMs: refreshIntervalMs,
      reset: () => {
        warm = false;
        collector.reset();
      },
    });
    const reader = { sampler };
    routeReaders.set(box.id, reader);
    for (const [id, oldest] of routeReaders) {
      if (routeReaders.size <= MOST_ROUTE_READERS) break;
      oldest.sampler.dispose();
      routeReaders.delete(id);
    }
    return reader;
  }

  async function machineSnapshot(machineId: string, force: boolean): Promise<MonitorSnapshot> {
    requireOn();
    if (machineId === SERVER_MACHINE) return withInterval(await serverSampler.sample(force));
    const boxes = await deps.boxes();
    if (machineId.startsWith(BOX_MACHINE_PREFIX)) {
      const box = boxes.find((candidate) => candidate.id === machineId.slice(BOX_MACHINE_PREFIX.length));
      if (!box || !box.ready) throw new Error("That box is not running.");
      const os = routeOs(box);
      if (!os) throw new Error(unreadableWords(box.name));
      const snapshot = withInterval(await routeReader(box, os).sampler.sample(force));
      return box.slot ? asSlotReading(snapshot, { ...box.slot, encoder: await deps.encoderRoom(box.id) }) : snapshot;
    }
    const box = boxes.find((candidate) => candidate.hostId === machineId);
    try {
      const snapshot = await deps.hostSnapshot(machineId, { refreshIntervalMs: refreshIntervalMs(), force, scope: box?.slot ? "user" : "machine" }, HOST_TIMEOUT_MS);
      return box?.slot ? asSlotReading(snapshot, { ...box.slot, encoder: await deps.encoderRoom(box.id) }) : snapshot;
    } catch (error) {
      deps.log.warn(`Machine snapshot failed for ${machineId}: ${error instanceof Error ? error.message.slice(0, 500) : String(error)}`);
      throw error;
    }
  }

  return {
    configure(next: MonitorConfig) {
      const was = config;
      config = next;
      if (was.enabled && !next.enabled) forgetReadings();
      if (was.refreshIntervalSeconds !== next.refreshIntervalSeconds) {
        serverSampler.intervalChanged();
        for (const reader of routeReaders.values()) reader.sampler.intervalChanged();
      }
      pressure.configure(next.enabled && next.backgroundMonitoring, next.pressureNotifications);
    },
    config: () => config,
    start: (signal: AbortSignal) => pressure.start(signal),
    async server(force = false): Promise<MonitorSnapshot> {
      requireOn();
      return withInterval(await serverSampler.sample(force));
    },
    async machines(): Promise<Machine[]> {
      if (!config.enabled) return [];
      const [hosts, serverHostId, boxes] = await Promise.all([deps.hosts(), deps.serverHostId(), deps.boxes()]);
      return listMachines(hosts, serverHostId, boxes);
    },
    machine: machineSnapshot,
    status(): MonitorStatus {
      return pressure.status();
    },
    logs: (limit: number) => pressure.logs(limit),
    checks(): DoctorCheck[] {
      let latest: readonly { type: string; timestamp: number }[] = [];
      try {
        latest = config.enabled && config.backgroundMonitoring ? pressure.logs(20) : [];
      } catch {
        latest = [];
      }
      return monitorChecks(config, latest);
    },
    dispose() {
      pressure.dispose();
      serverSampler.dispose();
      for (const reader of routeReaders.values()) reader.sampler.dispose();
      routeReaders.clear();
      stopMacSensors();
    },
  };
}

export type Monitor = ReturnType<typeof createMonitor>;

export function startMonitor(bb: BbPluginApi, deps: MonitorDeps): Monitor {
  const monitor = createMonitor(bb, deps);
  bb.background.service("monitor", { start: (signal) => monitor.start(signal) });
  bb.onDispose(() => monitor.dispose());
  return monitor;
}

export function monitorRpcHandlers(monitor: Monitor) {
  return {
    "monitor.state": async () => {
      const { enabled, backgroundMonitoring, pressureNotifications } = monitor.config();
      return { enabled, backgroundMonitoring, pressureNotifications };
    },
    "monitor.server": ({ force }: { force: boolean }) => monitor.server(force),
    "monitor.machines": async () => ({ machines: await monitor.machines() }),
    "monitor.machine": ({ machineId, force }: { machineId: string; force: boolean }) => monitor.machine(machineId, force),
    "monitor.alerts": async () => monitor.status(),
  };
}

export function createLightSampler(readOwnContainer: (signal: AbortSignal) => Promise<ContainerCounters | null> = (signal) => (platform() === "linux" ? readContainer(signal) : Promise.resolve(null))): LightSampler {
  let previousCpu: CpuTimes | null = null;
  let previousContainer: { usageMicros: number; at: number } | null = null;
  return {
    async read(signal: AbortSignal): Promise<LightSample> {
      const container = await readOwnContainer(signal);
      const runtime = process.memoryUsage();
      if (container) {
        const at = performance.now();
        const cpu = containerCpuPercent(previousContainer, { usageMicros: container.usageMicros, at }, containerCapacity(container, cpus().length));
        previousContainer = { usageMicros: container.usageMicros, at };
        const memory = containerMemory(container, totalmem());
        return { cpu, memory: memory.totalBytes > 0 ? clampPercentage((memory.usedBytes / memory.totalBytes) * 100) : null, load1: null, rssBytes: runtime.rss, heapUsedBytes: runtime.heapUsed, availableBytes: memory.availableBytes, totalBytes: memory.totalBytes };
      }
      let current: CpuTimes;
      let availableBytes: number;
      if (platform() === "linux") {
        const [stat, meminfo] = await Promise.all([readFile("/proc/stat", { encoding: "utf8", signal }), readFile("/proc/meminfo", { encoding: "utf8", signal })]);
        const times = stat.split("\n", 1)[0]!.trim().split(/\s+/).slice(1, 9).map(Number);
        if (times.length < 8 || !times.every(Number.isFinite)) throw new Error("CPU counters unavailable");
        current = { idle: times[3]! + times[4]!, total: times.reduce((sum, value) => sum + value, 0) };
        const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);
        if (!available) throw new Error("Available memory counter unavailable");
        availableBytes = Number(available[1]) * 1024;
      } else {
        current = readCpuTimes(cpus());
        availableBytes = await readAvailableMemoryBytes(signal);
      }
      signal.throwIfAborted();
      const cpu = calculateCpuUsage(previousCpu, current);
      previousCpu = current;
      const totalBytes = totalmem();
      return { cpu, memory: totalBytes > 0 ? clampPercentage((1 - availableBytes / totalBytes) * 100) : null, load1: loadavg()[0] ?? 0, rssBytes: runtime.rss, heapUsedBytes: runtime.heapUsed, availableBytes, totalBytes };
    },
    reset() {
      previousCpu = null;
      previousContainer = null;
    },
  };
}
