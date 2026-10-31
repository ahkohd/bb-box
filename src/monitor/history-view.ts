export type HistoryRange = "1h" | "24h" | "7d";

export const HISTORY_RANGES: Readonly<Record<HistoryRange, { readonly stepMs: number; readonly steps: number }>> = {
  "1h": { stepMs: 60_000, steps: 60 },
  "24h": { stepMs: 10 * 60_000, steps: 144 },
  "7d": { stepMs: 60 * 60_000, steps: 168 },
};

export const PENDING_MS = 2 * 60_000;

export type GapKind = "not-made" | "starting" | "stopped" | "not-read" | "no-reading";

const PRECEDENCE: readonly Exclude<GapKind, "no-reading">[] = ["not-made", "stopped", "starting", "not-read"];

export interface HistoryStep {
  readonly at: number;
  readonly covered: number;
  readonly cpuCovered: number;
  readonly memoryCovered: number;
  readonly netCovered: number;
  readonly cpu: number | null;
  readonly cpuBusiest: number | null;
  readonly memory: number | null;
  readonly memoryHighest: number | null;
  readonly disk: number | null;
  readonly down: number | null;
  readonly up: number | null;
  readonly host: number | null;
  readonly high: number;
  readonly partial: boolean;
}

export interface HistoryGap {
  readonly from: number;
  readonly to: number;
  readonly kind: GapKind;
}

export interface Span {
  readonly from: number;
  readonly to: number;
}

export interface HistoryMinute {
  readonly at: number;
  readonly covered: number;
  readonly cpu: number | null;
  readonly memory: number | null;
  readonly disk: number | null;
  readonly down: number | null;
  readonly up: number | null;
  readonly high: number;
}

export interface HistoryHour {
  readonly hour: number;
  readonly covered: number;
  readonly cpuCovered: number;
  readonly memoryCovered: number;
  readonly netCovered: number;
  readonly cpu: number | null;
  readonly cpuBusiest: number | null;
  readonly memory: number | null;
  readonly memoryHighest: number | null;
  readonly disk: number | null;
  readonly down: number | null;
  readonly up: number | null;
  readonly high: number;
}

export interface LoggedEvent {
  readonly kind: string;
  readonly at: number;
}

export interface QuietSpan {
  readonly from: number;
  readonly to: number | null;
}

export interface HistoryInputs {
  readonly range: HistoryRange;
  readonly now: number;
  readonly createdAt: number;
  readonly state: string;
  readonly minutes: readonly HistoryMinute[];
  readonly hours: readonly HistoryHour[];
  readonly host: { readonly minutes: readonly HistoryMinute[]; readonly hours: readonly HistoryHour[] } | null;
  readonly events: readonly LoggedEvent[];
  readonly quiet: readonly QuietSpan[];
}

export interface HistoryShape {
  readonly range: HistoryRange;
  readonly stepMs: number;
  readonly from: number;
  readonly to: number;
  readonly steps: readonly HistoryStep[];
  readonly gaps: readonly HistoryGap[];
}

export function historyWindow(range: HistoryRange, now: number): { from: number; to: number; stepMs: number; steps: number } {
  const { stepMs, steps } = HISTORY_RANGES[range];
  const to = Math.ceil(now / stepMs) * stepMs;
  return { from: to - steps * stepMs, to, stepMs, steps };
}

export const UNREAD_SHOWN_MS = 60_000;

export function partlyRead(covered: number, stepMs: number): boolean {
  return stepMs - covered * 1000 >= UNREAD_SHOWN_MS;
}

interface Sums {
  covered: number;
  cpu: number;
  cpuCovered: number;
  cpuBusiest: number | null;
  memory: number;
  memoryCovered: number;
  memoryHighest: number | null;
  disk: number;
  diskCovered: number;
  down: number;
  up: number;
  netCovered: number;
  high: number;
}

function sums(): Sums {
  return { covered: 0, cpu: 0, cpuCovered: 0, cpuBusiest: null, memory: 0, memoryCovered: 0, memoryHighest: null, disk: 0, diskCovered: 0, down: 0, up: 0, netCovered: 0, high: 0 };
}

function most(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

function addMinute(into: Sums, minute: HistoryMinute, weight: number): void {
  into.covered += weight;
  if (minute.cpu !== null) {
    into.cpu += minute.cpu * weight;
    into.cpuCovered += weight;
    into.cpuBusiest = most(into.cpuBusiest, minute.cpu);
  }
  if (minute.memory !== null) {
    into.memory += minute.memory * weight;
    into.memoryCovered += weight;
    into.memoryHighest = most(into.memoryHighest, minute.memory);
  }
  if (minute.disk !== null) {
    into.disk += minute.disk * weight;
    into.diskCovered += weight;
  }
  if (minute.down !== null && minute.up !== null) {
    into.down += minute.down * weight;
    into.up += minute.up * weight;
    into.netCovered += weight;
  }
  into.high |= minute.high;
}

export function overlaps(start: number, end: number, from: number, stepMs: number, count: number): { readonly index: number; readonly seconds: number }[] {
  const first = Math.max(0, Math.floor((start - from) / stepMs));
  const last = Math.min(count - 1, Math.floor((end - 1 - from) / stepMs));
  const parts: { index: number; seconds: number }[] = [];
  for (let index = first; index <= last; index++) {
    const seconds = (Math.min(end, from + (index + 1) * stepMs) - Math.max(start, from + index * stepMs)) / 1000;
    if (seconds > 0) parts.push({ index, seconds });
  }
  return parts;
}

function bucketsOf(count: number, from: number, stepMs: number, minutes: readonly HistoryMinute[]): (Sums | null)[] {
  const buckets: (Sums | null)[] = Array.from({ length: count }, () => null);
  for (const minute of minutes) {
    for (const { index, seconds } of overlaps(minute.at - minute.covered * 1000, minute.at, from, stepMs, count)) addMinute((buckets[index] ??= sums()), minute, seconds);
  }
  return buckets;
}

function hourBuckets(count: number, from: number, stepMs: number, hours: readonly HistoryHour[]): (HistoryHour | null)[] {
  const buckets: (HistoryHour | null)[] = Array.from({ length: count }, () => null);
  for (const hour of hours) {
    const index = Math.floor((hour.hour - from) / stepMs);
    if (index >= 0 && index < count) buckets[index] = hour;
  }
  return buckets;
}

const mean = (sum: number, covered: number) => (covered > 0 ? sum / covered : null);

function unread(at: number, host: number | null): HistoryStep {
  return { at, covered: 0, cpuCovered: 0, memoryCovered: 0, netCovered: 0, cpu: null, cpuBusiest: null, memory: null, memoryHighest: null, disk: null, down: null, up: null, host, high: 0, partial: false };
}

function stepOfSums(at: number, bucket: Sums | null, host: number | null, partial: boolean, busiest: boolean): HistoryStep {
  if (!bucket) return unread(at, host);
  return {
    at,
    covered: bucket.covered,
    cpuCovered: bucket.cpuCovered,
    memoryCovered: bucket.memoryCovered,
    netCovered: bucket.netCovered,
    cpu: mean(bucket.cpu, bucket.cpuCovered),
    cpuBusiest: busiest ? bucket.cpuBusiest : null,
    memory: mean(bucket.memory, bucket.memoryCovered),
    memoryHighest: busiest ? bucket.memoryHighest : null,
    disk: mean(bucket.disk, bucket.diskCovered),
    down: mean(bucket.down, bucket.netCovered),
    up: mean(bucket.up, bucket.netCovered),
    host,
    high: bucket.high,
    partial,
  };
}

function stepOfHour(at: number, hour: HistoryHour | null, host: number | null, partial: boolean): HistoryStep {
  if (!hour) return unread(at, host);
  return { at, covered: hour.covered, cpuCovered: hour.cpuCovered, memoryCovered: hour.memoryCovered, netCovered: hour.netCovered, cpu: hour.cpu, cpuBusiest: hour.cpuBusiest, memory: hour.memory, memoryHighest: hour.memoryHighest, disk: hour.disk, down: hour.down, up: hour.up, host, high: hour.high, partial };
}

export function lifeSpans(events: readonly LoggedEvent[], createdAt: number, now: number, state: string, readAfter: (at: number) => number | null): { stopped: Span[]; starting: Span[] } {
  const stopped: Span[] = [];
  const starting: Span[] = [];
  let stoppedFrom: number | null = null;
  let startingFrom: number | null = null;
  const sorted = [...events].sort((left, right) => left.at - right.at);
  for (const event of sorted) {
    switch (event.kind) {
      case "made":
        startingFrom = event.at;
        break;
      case "ready":
      case "started":
      case "start-failed":
        if (startingFrom !== null) starting.push({ from: startingFrom, to: event.at });
        startingFrom = null;
        if (stoppedFrom !== null && event.kind !== "start-failed") {
          stopped.push({ from: stoppedFrom, to: event.at });
          stoppedFrom = null;
        }
        break;
      case "start-asked":
        if (stoppedFrom !== null) stopped.push({ from: stoppedFrom, to: event.at });
        stoppedFrom = null;
        startingFrom = event.at;
        break;
      case "stopped":
      case "stopped-unasked":
        if (startingFrom !== null) starting.push({ from: startingFrom, to: event.at });
        startingFrom = null;
        stoppedFrom ??= event.at;
        break;
      default:
        break;
    }
  }
  const until = (from: number, still: boolean) => (still ? now : Math.min(now, readAfter(from) ?? now));
  if (stoppedFrom !== null) stopped.push({ from: stoppedFrom, to: until(stoppedFrom, state === "stopped") });
  if (startingFrom !== null && startingFrom >= createdAt) starting.push({ from: startingFrom, to: until(startingFrom, state === "starting" || state === "acquiring") });
  return { stopped, starting };
}

function overlap(span: Span, from: number, to: number): number {
  return Math.max(0, Math.min(span.to, to) - Math.max(span.from, from));
}

function kindOf(from: number, to: number, kinds: Readonly<Record<Exclude<GapKind, "no-reading">, readonly Span[]>>): GapKind {
  let best: GapKind = "no-reading";
  let bestCovered = 0;
  for (const kind of PRECEDENCE) {
    const covered = kinds[kind].reduce((total, span) => total + overlap(span, from, to), 0);
    if (covered > bestCovered) {
      best = kind;
      bestCovered = covered;
    }
  }
  return best;
}

type KnownSpans = Readonly<Record<Exclude<GapKind, "no-reading">, readonly Span[]>>;

function without(piece: Span, taken: Span): Span[] {
  if (taken.to <= piece.from || taken.from >= piece.to) return [piece];
  return [
    { from: piece.from, to: taken.from },
    { from: taken.to, to: piece.to },
  ].filter((part) => part.to > part.from);
}

function knownWithin(from: number, to: number, kinds: KnownSpans): HistoryGap[] {
  const found: HistoryGap[] = [];
  for (const kind of PRECEDENCE) {
    for (const span of kinds[kind]) {
      let pieces: Span[] = [{ from: Math.max(span.from, from), to: Math.min(span.to, to) }].filter((piece) => piece.to > piece.from);
      for (const taken of found) pieces = pieces.flatMap((piece) => without(piece, taken));
      found.push(...pieces.map((piece) => ({ ...piece, kind })));
    }
  }
  return found;
}

function joined(gaps: readonly HistoryGap[]): HistoryGap[] {
  const out: HistoryGap[] = [];
  for (const gap of [...gaps].sort((left, right) => left.from - right.from)) {
    const last = out.at(-1);
    if (last && last.kind === gap.kind && last.to >= gap.from) out[out.length - 1] = { ...last, to: Math.max(last.to, gap.to) };
    else out.push(gap);
  }
  return out;
}

export function gapsOf(steps: readonly HistoryStep[], stepMs: number, now: number, kinds: KnownSpans): HistoryGap[] {
  const gaps: HistoryGap[] = [];
  for (const step of steps) {
    if (step.at >= now) continue;
    const end = step.at + stepMs;
    if (step.cpu !== null || step.memory !== null) {
      gaps.push(...knownWithin(step.at, Math.min(end, now), kinds));
      continue;
    }
    const kind = kindOf(step.at, Math.min(end, now), kinds);
    if (kind === "no-reading" && end > now - PENDING_MS) continue;
    gaps.push({ from: step.at, to: end, kind });
  }
  return joined(gaps);
}

export function historyShape(inputs: HistoryInputs): HistoryShape {
  const { range, now } = inputs;
  const { from, to, stepMs, steps: count } = historyWindow(range, now);
  const complete = (at: number) => at + stepMs <= now;
  let steps: HistoryStep[];
  if (range === "7d") {
    const own = hourBuckets(count, from, stepMs, inputs.hours);
    const host = inputs.host ? hourBuckets(count, from, stepMs, inputs.host.hours) : null;
    steps = own.map((hour, index) => {
      const at = from + index * stepMs;
      return stepOfHour(at, hour, host?.[index]?.cpu ?? null, hour !== null && complete(at) && partlyRead(hour.covered, stepMs));
    });
  } else {
    const own = bucketsOf(count, from, stepMs, inputs.minutes);
    const host = inputs.host ? bucketsOf(count, from, stepMs, inputs.host.minutes) : null;
    steps = own.map((bucket, index) => {
      const at = from + index * stepMs;
      const hostBucket = host?.[index] ?? null;
      const partial = range !== "1h" && bucket !== null && complete(at) && partlyRead(bucket.covered, stepMs);
      return stepOfSums(at, bucket, hostBucket ? mean(hostBucket.cpu, hostBucket.cpuCovered) : null, partial, range !== "1h");
    });
  }
  const readAfter = (at: number) => steps.find((step) => step.at >= at && (step.cpu !== null || step.memory !== null))?.at ?? null;
  const life = lifeSpans(inputs.events, inputs.createdAt, now, inputs.state, readAfter);
  const quiet = inputs.quiet.map((span) => ({ from: span.from, to: span.to ?? now }));
  const kinds = { "not-made": [{ from: -Infinity, to: inputs.createdAt }], stopped: life.stopped, starting: life.starting, "not-read": quiet };
  return { range, stepMs, from, to, steps, gaps: gapsOf(steps, stepMs, now, kinds) };
}
