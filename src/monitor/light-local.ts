import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { cpus, loadavg, platform, totalmem, uptime } from "node:os";
import { promisify } from "node:util";
import { parseNetDev, parseProcStat, parseVmStatUsedBytes, readCpuTimes, readDisk, readMacNetworkTotals, readNetworkTotals, readOwnProcesses, type NetworkTotals } from "./collector.ts";
import { readContainer } from "./container.ts";
import type { LightReading, LightRequest } from "./light.ts";

const execFileAsync = promisify(execFile);

async function text(path: string, signal: AbortSignal): Promise<string | null> {
  return readFile(path, { encoding: "utf8", signal }).catch(() => null);
}

export function defaultInterface(routes: string): string | null {
  for (const line of routes.split("\n").slice(1)) {
    const [name, destination] = line.trim().split(/\s+/);
    if (name && destination === "00000000") return name;
  }
  return null;
}

async function linuxNetwork(signal: AbortSignal): Promise<NetworkTotals | null> {
  const [routes, devices] = await Promise.all([text("/proc/net/route", signal), text("/proc/net/dev", signal)]);
  const name = routes ? defaultInterface(routes) : null;
  if (!devices) return null;
  if (!name) return readNetworkTotals(signal);
  const line = devices.split("\n").find((row) => row.trim().startsWith(`${name}:`));
  return line ? parseNetDev(`\n\n${line}`) : null;
}

async function macUsedBytes(signal: AbortSignal): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("vm_stat", [], { timeout: 1500, maxBuffer: 64 * 1024, signal, env: { ...process.env, LC_ALL: "C" } });
    return parseVmStatUsedBytes(stdout);
  } catch {
    return null;
  }
}

async function diskNow(): Promise<LightReading["disk"]> {
  const disk = await readDisk();
  return disk ? { totalBytes: disk.totalBytes, usedBytes: disk.usedBytes } : null;
}

async function readLinux(request: LightRequest, signal: AbortSignal): Promise<LightReading> {
  const [stat, meminfo, loads, container, disk, network, own] = await Promise.all([
    text("/proc/stat", signal),
    text("/proc/meminfo", signal),
    text("/proc/loadavg", signal),
    readContainer(signal),
    diskNow(),
    linuxNetwork(signal),
    request.own ? readOwnProcesses(signal) : Promise.resolve(null),
  ]);
  const parsed = stat ? parseProcStat(stat) : null;
  const total = Number(/^MemTotal:\s+(\d+)\s+kB$/m.exec(meminfo ?? "")?.[1]) * 1024;
  const available = Number(/^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo ?? "")?.[1]) * 1024;
  const boot = Number(/^btime\s+(\d+)/m.exec(stat ?? "")?.[1]);
  const load = (loads ?? "").trim().split(/\s+/).slice(0, 3).map(Number);
  return {
    os: "linux",
    bootAt: Number.isFinite(boot) ? boot : null,
    visibleCores: parsed?.perCore.length ?? cpus().length,
    memoryTotalBytes: Number.isFinite(total) && total > 0 ? total : null,
    cpu: parsed?.total ?? null,
    memoryUsedBytes: Number.isFinite(total) && Number.isFinite(available) && total > 0 ? Math.max(0, total - available) : null,
    container,
    load: load.length === 3 && load.every(Number.isFinite) ? [load[0]!, load[1]!, load[2]!] : null,
    disk,
    network,
    own,
  };
}

async function readMac(request: LightRequest, signal: AbortSignal): Promise<LightReading> {
  const whole = request.machine;
  const [used, disk, network, own] = await Promise.all([
    whole ? macUsedBytes(signal) : Promise.resolve(null),
    whole ? diskNow() : Promise.resolve(null),
    whole ? readMacNetworkTotals(signal) : Promise.resolve(null),
    request.own ? readOwnProcesses(signal) : Promise.resolve(null),
  ]);
  const list = cpus();
  const loads = loadavg();
  return {
    os: "macos",
    bootAt: whole ? Math.round(Date.now() / 1000 - uptime()) : null,
    visibleCores: list.length,
    memoryTotalBytes: totalmem(),
    cpu: whole && list.length ? readCpuTimes(list) : null,
    memoryUsedBytes: used,
    container: null,
    load: whole ? [loads[0] ?? 0, loads[1] ?? 0, loads[2] ?? 0] : null,
    disk,
    network,
    own,
  };
}

export async function readLightHere(request: LightRequest, signal: AbortSignal): Promise<LightReading> {
  const reading = platform() === "darwin" ? await readMac(request, signal) : await readLinux(request, signal);
  signal.throwIfAborted();
  return reading;
}
