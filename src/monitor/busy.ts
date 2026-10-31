import { HIGH, type HighReason } from "./light.ts";
import { BUSY_AFTER_MS, BUSY_FRESH_MS, POINTS_JOIN_MS, READING_LATE_MS } from "./busy-times.ts";

export const BUSY_ORDER: readonly HighReason[] = ["cpu", "cpuPressure", "memory", "memoryPressure", "load", "disk"];

export interface BusyPoint {
  readonly at: number;
  readonly covered: number;
  readonly cpu: number | null;
  readonly memory: number | null;
  readonly disk: number | null;
  readonly load: number | null;
  readonly cores: number | null;
  readonly high: number;
}

export interface Busy {
  readonly reason: HighReason;
  readonly value: number | null;
  readonly cores: number | null;
  readonly since: number;
  readonly at: number;
  readonly slot: boolean;
  readonly readAt: number;
}

function startOf(point: BusyPoint): number {
  return point.at - point.covered * 1000;
}

export function highSince(points: readonly BusyPoint[], reason: HighReason): number | null {
  let since: number | null = null;
  for (let index = points.length - 1; index >= 0; index--) {
    const point = points[index]!;
    if ((point.high & HIGH[reason]) === 0) break;
    if (since !== null && since - point.at > POINTS_JOIN_MS) break;
    since = startOf(point);
  }
  return since;
}

function valueFor(reason: HighReason, point: BusyPoint): number | null {
  switch (reason) {
    case "cpu":
    case "cpuPressure":
      return point.cpu;
    case "memory":
    case "memoryPressure":
      return point.memory;
    case "load":
      return point.load;
    case "disk":
      return point.disk;
  }
}

export function busyOf(points: readonly BusyPoint[], now: number, slot: boolean, from = Number.NEGATIVE_INFINITY): Busy | null {
  const newest = points.at(-1);
  if (!newest || newest.at > now + POINTS_JOIN_MS || now - newest.at >= BUSY_FRESH_MS) return null;
  const counted = points.filter((point) => startOf(point) >= from - POINTS_JOIN_MS);
  for (const reason of BUSY_ORDER) {
    const since = highSince(counted, reason);
    if (since !== null && newest.at - since >= BUSY_AFTER_MS - READING_LATE_MS) {
      return { reason, value: valueFor(reason, newest), cores: reason === "load" ? newest.cores : null, since, at: newest.at, slot, readAt: now };
    }
  }
  return null;
}

export function countedFrom(lastStartAt: number, quietEnds: readonly number[]): number {
  return Math.max(lastStartAt, ...quietEnds);
}

export function reachesBack(busy: Busy, points: readonly BusyPoint[]): boolean {
  const oldest = points[0];
  return oldest !== undefined && busy.since <= startOf(oldest);
}
