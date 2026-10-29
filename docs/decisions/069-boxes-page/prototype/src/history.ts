import { DAY, HOUR, MINUTE, type FakeBox } from "./data";

export type Range = "live" | "hour" | "day" | "week";

export const RANGES: readonly { id: Range; label: string; step: number; points: number; words: string }[] = [
  { id: "live", label: "Live", step: 5_000, points: 72, words: "the last 6 minutes, every 5 s" },
  { id: "hour", label: "1 h", step: MINUTE, points: 60, words: "the last hour, by the minute" },
  { id: "day", label: "24 h", step: 10 * MINUTE, points: 144, words: "the last 24 hours, by 10 minutes" },
  { id: "week", label: "7 d", step: HOUR, points: 168, words: "the last 7 days, by the hour" },
];

export type Gap = "not-made" | "stopped" | "starting" | "no-reading" | "off";

export interface Point {
  readonly at: number;
  readonly gap: Gap | null;
  readonly cpu: number | null;
  readonly cpuPeak: number | null;
  readonly memory: number | null;
  readonly disk: number | null;
  readonly rxKiB: number | null;
  readonly txKiB: number | null;
}

function hash(text: string, index: number): number {
  let value = 2166136261 ^ index;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  value = Math.imul(value ^ (value >>> 15), 2246822507);
  value = Math.imul(value ^ (value >>> 13), 3266489909);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function gapAt(box: FakeBox, at: number): Gap | null {
  if (at < box.view.createdAt + 4_000) return "not-made";
  if (box.view.state === "acquiring" || box.view.state === "failed") return "starting";
  if (box.view.state === "starting" && (!box.started || at >= box.started.askedAt)) return "starting";
  if (box.stops?.some((stop) => at >= stop.from && (stop.to === null || at < stop.to))) return "stopped";
  if (box.started && box.started.readyAt === null && at >= box.started.askedAt) return "starting";
  if (box.unreachable && at >= box.unreachable.since) return "no-reading";
  if (box.backendGone && at >= box.backendGone.since) return "no-reading";
  return null;
}

export function running(box: FakeBox, at: number): boolean {
  return gapAt(box, at) === null;
}

export function cpuAt(box: FakeBox, at: number, width: number): { mean: number; peak: number } {
  const base = box.load.busyFrom === undefined ? box.load.cpu : 18;
  if (box.load.busyFrom !== undefined && at >= box.load.busyFrom) {
    const wobble = hash(box.view.id, Math.floor(at / 5_000)) * 6;
    return { mean: clamp(92 + wobble), peak: clamp(98 + wobble / 3) };
  }
  const daily = Math.sin(((at % DAY) / DAY) * Math.PI * 2 - 1.2) * base * 0.35;
  const knot = Math.max(width, 30_000);
  const step = at / knot;
  const share = step - Math.floor(step);
  const eased = share * share * (3 - 2 * share);
  const noise = ((hash(box.view.id, Math.floor(step)) * (1 - eased) + hash(box.view.id, Math.floor(step) + 1) * eased) - 0.5) * base * 0.6;
  const burstSpan = 4 * MINUTE;
  const burst = !box.shared && hash(`${box.view.id}:burst`, Math.floor(at / burstSpan)) > 0.9 ? 30 + hash(`${box.view.id}:size`, Math.floor(at / burstSpan)) * 30 : 0;
  const spread = Math.min(1, burstSpan / Math.max(width, 5_000));
  const mean = clamp(base + daily + noise + burst * spread);
  const peak = clamp(Math.max(mean, base + daily + burst) + 4 + hash(box.view.id, Math.floor(at / Math.max(width, 5_000)) + 3) * 8);
  return { mean, peak };
}

export function pointAt(box: FakeBox, at: number, width: number): Point {
  const gap = gapAt(box, at);
  if (gap) return { at, gap, cpu: null, cpuPeak: null, memory: null, disk: null, rxKiB: null, txKiB: null };
  const cpu = cpuAt(box, at, width);
  const age = Math.min(1, (at - box.view.createdAt) / (30 * MINUTE));
  const memory = clamp(box.load.memory * (0.55 + 0.45 * age) + (hash(`${box.view.id}:m`, Math.floor(at / (2 * MINUTE))) - 0.5) * 6);
  const diskShare = (box.load.diskUsedGiB / box.load.diskGiB) * 100;
  const disk = clamp(diskShare * (0.7 + 0.3 * age));
  const knot = at / Math.max(width, 20_000);
  const share = knot - Math.floor(knot);
  const net = 0.4 + (hash(`${box.view.id}:n`, Math.floor(knot)) * (1 - share) + hash(`${box.view.id}:n`, Math.floor(knot) + 1) * share) * 1.2;
  return { at, gap: null, cpu: cpu.mean, cpuPeak: cpu.peak, memory, disk, rxKiB: box.load.rxKiB * net, txKiB: box.load.txKiB * net };
}

export function hostPointAt(box: FakeBox, at: number, width: number): Point {
  const host = box.shared!;
  const gap = at < box.view.createdAt - 30 * DAY ? "not-made" : null;
  if (gap) return { at, gap, cpu: null, cpuPeak: null, memory: null, disk: null, rxKiB: null, txKiB: null };
  const stand = { ...box, view: { ...box.view, id: `${box.view.id}:host`, createdAt: box.view.createdAt - 30 * DAY }, load: { ...box.load, cpu: host.cpu, memory: host.memory, diskUsedGiB: host.diskUsedGiB, diskGiB: host.diskGiB }, stops: [], started: undefined };
  return pointAt(stand, at, width);
}

export function hostHistory(box: FakeBox, range: Range, now: number): Point[] {
  const spec = RANGES.find((each) => each.id === range)!;
  const end = Math.floor(now / spec.step) * spec.step;
  return Array.from({ length: spec.points }, (_, index) => hostPointAt(box, end - (spec.points - 1 - index) * spec.step, spec.step));
}

export function history(box: FakeBox, range: Range, now: number, offSince: number | null = null): Point[] {
  const spec = RANGES.find((each) => each.id === range)!;
  const end = Math.floor(now / spec.step) * spec.step;
  return Array.from({ length: spec.points }, (_, index) => {
    const at = end - (spec.points - 1 - index) * spec.step;
    const point = pointAt(box, at, spec.step);
    return range !== "live" && offSince !== null && at >= offSince && !point.gap ? { ...point, gap: "off" as const, cpu: null, cpuPeak: null, memory: null, disk: null, rxKiB: null, txKiB: null } : point;
  });
}

export function hasAnyHistory(points: readonly Point[]): boolean {
  return points.some((point) => point.cpu !== null || point.memory !== null);
}

export function busyFor(box: FakeBox, now: number): number | null {
  if (box.load.busyFrom === undefined || !running(box, now)) return null;
  return now - box.load.busyFrom;
}
