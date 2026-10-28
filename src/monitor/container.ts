import { readFile } from "node:fs/promises";
import { clampPercentage } from "./numbers.ts";

export const CGROUP_ROOT = "/sys/fs/cgroup";

export type Stall = [number, number, number];

export interface ContainerCounters {
  readonly usageMicros: number;
  readonly cpuCapacity: number | null;
  readonly cpusetCount: number | null;
  readonly memoryCurrentBytes: number;
  readonly inactiveFileBytes: number;
  readonly fileBytes: number;
  readonly memoryLimitBytes: number | null;
  readonly swapCurrentBytes: number | null;
  readonly swapLimitBytes: number | null;
  readonly cpuStall: Stall | null;
  readonly memoryStall: Stall | null;
}

export const CONTAINER_FILES = ["cpu.stat", "cpu.max", "cpuset.cpus.effective", "memory.current", "memory.stat", "memory.max", "memory.swap.current", "memory.swap.max", "cpu.pressure", "memory.pressure"] as const;
export type ContainerFile = (typeof CONTAINER_FILES)[number];

function whole(text: string | undefined): number | null {
  const value = Number(text?.trim());
  return text !== undefined && text.trim() !== "" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function limit(text: string | undefined): number | null {
  return text?.trim() === "max" ? null : whole(text);
}

export function parseFlatKeyed(text: string): Map<string, number> {
  const values = new Map<string, number>();
  for (const line of text.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    const number = Number(value);
    if (key && value !== undefined && Number.isFinite(number)) values.set(key, number);
  }
  return values;
}

export function parseCpuMax(text: string | undefined): number | null {
  const [quota, period] = (text ?? "").trim().split(/\s+/);
  const periodMicros = Number(period);
  const quotaMicros = Number(quota);
  if (quota === "max" || !Number.isFinite(quotaMicros) || !Number.isFinite(periodMicros) || quotaMicros <= 0 || periodMicros <= 0) return null;
  return quotaMicros / periodMicros;
}

export function parseCpuList(text: string | undefined): number | null {
  const ranges = (text ?? "").trim().split(",").filter(Boolean);
  if (!ranges.length) return null;
  let count = 0;
  for (const range of ranges) {
    const bounds = /^(\d+)(?:-(\d+))?$/.exec(range.trim());
    if (!bounds) return null;
    const first = Number(bounds[1]);
    const end = bounds[2] === undefined ? first : Number(bounds[2]);
    if (end < first) return null;
    count += end - first + 1;
  }
  return count;
}

export function parseStall(text: string | undefined): Stall | null {
  const some = /^some\s+avg10=([\d.]+)\s+avg60=([\d.]+)\s+avg300=([\d.]+)/m.exec(text ?? "");
  if (!some) return null;
  const values = some.slice(1, 4).map(Number);
  return values.every(Number.isFinite) ? [clampPercentage(values[0]!), clampPercentage(values[1]!), clampPercentage(values[2]!)] : null;
}

export function inNamespacedCgroup(files: Partial<Record<ContainerFile, string>>): boolean {
  return files["memory.max"] !== undefined || files["cpu.max"] !== undefined;
}

export function parseContainer(files: Partial<Record<ContainerFile, string>>): ContainerCounters | null {
  if (!inNamespacedCgroup(files)) return null;
  const usageMicros = parseFlatKeyed(files["cpu.stat"] ?? "").get("usage_usec");
  const memoryCurrentBytes = whole(files["memory.current"]);
  if (usageMicros === undefined || memoryCurrentBytes === null) return null;
  const memoryStat = parseFlatKeyed(files["memory.stat"] ?? "");
  return {
    usageMicros,
    cpuCapacity: parseCpuMax(files["cpu.max"]),
    cpusetCount: parseCpuList(files["cpuset.cpus.effective"]),
    memoryCurrentBytes,
    inactiveFileBytes: memoryStat.get("inactive_file") ?? 0,
    fileBytes: memoryStat.get("file") ?? 0,
    memoryLimitBytes: limit(files["memory.max"]),
    swapCurrentBytes: whole(files["memory.swap.current"]),
    swapLimitBytes: limit(files["memory.swap.max"]),
    cpuStall: parseStall(files["cpu.pressure"]),
    memoryStall: parseStall(files["memory.pressure"]),
  };
}

export async function readContainer(signal: AbortSignal, root = CGROUP_ROOT): Promise<ContainerCounters | null> {
  const entries = await Promise.all(
    CONTAINER_FILES.map(async (name) => [name, await readFile(`${root}/${name}`, { encoding: "utf8", signal }).catch(() => undefined)] as const),
  );
  signal.throwIfAborted();
  return parseContainer(Object.fromEntries(entries.filter(([, text]) => text !== undefined)));
}

export function containerCapacity(counters: Pick<ContainerCounters, "cpuCapacity" | "cpusetCount">, visibleCores: number): number {
  return Math.max(0.01, Math.min(visibleCores > 0 ? visibleCores : Infinity, counters.cpusetCount ?? Infinity, counters.cpuCapacity ?? Infinity));
}

export function containerCpuPercent(previous: { usageMicros: number; at: number } | null, current: { usageMicros: number; at: number }, capacity: number): number | null {
  if (!previous) return null;
  const usedMicros = current.usageMicros - previous.usageMicros;
  const wallMicros = (current.at - previous.at) * 1000;
  if (usedMicros < 0 || wallMicros <= 0) return null;
  return clampPercentage((usedMicros / (wallMicros * capacity)) * 100);
}

export interface ContainerMemory {
  readonly totalBytes: number;
  readonly usedBytes: number;
  readonly availableBytes: number;
  readonly cachedBytes: number;
  readonly swapTotalBytes: number | null;
  readonly swapUsedBytes: number | null;
}

export function containerMemory(counters: ContainerCounters, visibleTotalBytes: number): ContainerMemory {
  const totalBytes = Math.min(counters.memoryLimitBytes ?? Infinity, visibleTotalBytes > 0 ? visibleTotalBytes : Infinity);
  const known = Number.isFinite(totalBytes) ? totalBytes : counters.memoryCurrentBytes;
  const usedBytes = Math.min(known, Math.max(0, counters.memoryCurrentBytes - counters.inactiveFileBytes));
  const swapLimited = counters.swapLimitBytes !== null && counters.swapLimitBytes > 0;
  return {
    totalBytes: known,
    usedBytes,
    availableBytes: Math.max(0, known - usedBytes),
    cachedBytes: counters.fileBytes,
    swapTotalBytes: swapLimited ? counters.swapLimitBytes : null,
    swapUsedBytes: swapLimited ? (counters.swapCurrentBytes ?? 0) : null,
  };
}
