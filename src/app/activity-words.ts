import type { GapKind, HistoryGap, HistoryRange, MetricPoint, MonitorSnapshot } from "../plugin/contract.ts";
import { clock, dayAndClock, span } from "./box-words.ts";
import type { ChartSeries, Tick } from "./history-chart.tsx";

export const LIVE_POINTS = 72;

const LIVE_TICK_MS = 2 * 60_000;

const STEP_SLACK = 2.5;

export type SlotShare = NonNullable<NonNullable<MonitorSnapshot["slot"]>["share"]>;

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

export function bytesWords(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const index = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1));
  const value = bytes / 1024 ** index;
  const digits = index === 0 || value >= 100 ? 0 : value >= 10 ? 1 : value >= 1 ? 1 : 2;
  return `${Number(value.toFixed(digits))} ${UNITS[index]}`;
}

const RATE_UNITS = ["B/s", "KB/s", "MB/s", "GB/s"] as const;

export function rateWords(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "0 B/s";
  const index = Math.max(0, Math.min(Math.floor(Math.log(bytesPerSecond) / Math.log(1024)), RATE_UNITS.length - 1));
  const value = bytesPerSecond / 1024 ** index;
  const digits = index === 0 || value >= 100 ? 0 : value >= 10 ? 0 : 1;
  return `${Number(value.toFixed(digits))} ${RATE_UNITS[index]}`;
}

export function clockWithSeconds(at: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(at);
}

export function minuteClock(at: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(at);
}

export function liveSpanMs(intervalMs: number): number {
  return LIVE_POINTS * intervalMs;
}

export function liveWords(intervalMs: number): string {
  return `the last ${span(liveSpanMs(intervalMs))}, every ${span(intervalMs)}`;
}

export function longestStepMs(intervalMs: number): number {
  return intervalMs * STEP_SLACK;
}

export function liveWindow(points: readonly MetricPoint[], intervalMs: number): { readonly from: number; readonly to: number } {
  const to = points.at(-1)?.timestamp ?? 0;
  return { from: to - liveSpanMs(intervalMs) + intervalMs, to };
}

export function liveTicks(window: { readonly from: number; readonly to: number }): { at: number; words: string }[] {
  const ticks: { at: number; words: string }[] = [];
  for (let at = Math.ceil(window.from / LIVE_TICK_MS) * LIVE_TICK_MS; at <= window.to; at += LIVE_TICK_MS) ticks.push({ at, words: minuteClock(at) });
  return ticks;
}

export interface Gap {
  readonly from: number;
  readonly to: number;
}

export function gapsOf(times: readonly number[], values: readonly (number | null)[], intervalMs: number): Gap[] {
  const gaps: Gap[] = [];
  let openedAt: number | null = null;
  times.forEach((at, index) => {
    const late = index > 0 && at - times[index - 1]! > longestStepMs(intervalMs);
    if (late && openedAt === null) gaps.push({ from: times[index - 1]!, to: at });
    if (values[index] === null) {
      openedAt ??= index > 0 ? times[index - 1]! : at;
      return;
    }
    if (openedAt !== null) gaps.push({ from: openedAt, to: at });
    openedAt = null;
  });
  if (openedAt !== null) gaps.push({ from: openedAt, to: times.at(-1)! });
  return gaps;
}

function gapsWords(gaps: readonly Gap[], timeWords: (at: number) => string): string {
  if (!gaps.length) return "";
  return ` No reading ${gaps.map((gap) => `from ${timeWords(gap.from)} to ${timeWords(gap.to)}`).join(", ")}.`;
}

interface Measured {
  readonly mean: number;
  readonly highest: number;
  readonly highestAt: number;
  readonly last: number;
}

function measure(times: readonly number[], values: readonly (number | null)[]): Measured | null {
  let sum = 0;
  let read = 0;
  let highest = -Infinity;
  let highestAt = 0;
  let last = 0;
  values.forEach((value, index) => {
    if (value === null) return;
    sum += value;
    read++;
    last = value;
    if (value > highest) {
      highest = value;
      highestAt = times[index]!;
    }
  });
  return read ? { mean: sum / read, highest, highestAt, last } : null;
}

export interface UsageLines {
  readonly cpu: { readonly label: string; readonly values: readonly (number | null)[] };
  readonly memory: { readonly label: string; readonly values: readonly (number | null)[] };
}

const percent = (value: number) => `${Math.round(value)}%`;

export function usageSummary(span: string, times: readonly number[], lines: UsageLines, gaps: readonly Gap[], timeWords: (at: number) => string): string {
  const cpu = measure(times, lines.cpu.values);
  const memory = measure(times, lines.memory.values);
  if (!cpu && !memory) return `No readings over ${span}.`;
  const parts = [
    cpu ? `${lines.cpu.label} averaged ${percent(cpu.mean)}, highest ${percent(cpu.highest)} at ${timeWords(cpu.highestAt)}` : `${lines.cpu.label} not read`,
    memory ? `${lines.memory.label.toLowerCase() === "memory" ? "memory" : lines.memory.label} last ${percent(memory.last)}` : null,
  ].filter(Boolean);
  return `Over ${span}: ${parts.join("; ")}.${gapsWords(gaps, timeWords)}`;
}

export function networkSummary(span: string, times: readonly number[], down: readonly (number | null)[], up: readonly (number | null)[], gaps: readonly Gap[], timeWords: (at: number) => string): string {
  const received = measure(times, down);
  const sent = measure(times, up);
  if (!received && !sent) return `No network readings over ${span}.${gapsWords(gaps, timeWords)}`;
  const parts = [
    received ? `download averaged ${rateWords(received.mean)}, highest ${rateWords(received.highest)} at ${timeWords(received.highestAt)}` : null,
    sent ? `upload averaged ${rateWords(sent.mean)}, highest ${rateWords(sent.highest)} at ${timeWords(sent.highestAt)}` : null,
  ].filter(Boolean);
  return `Over ${span}: ${parts.join("; ")}.${gapsWords(gaps, timeWords)}`;
}

export function percentOfShare(cores: number | null | undefined, share: SlotShare): number | null {
  if (cores === null || cores === undefined) return null;
  return share.cores > 0 ? (cores / share.cores) * 100 : null;
}

export function memoryOfShare(bytes: number | null | undefined, share: SlotShare): number | null {
  if (bytes === null || bytes === undefined) return null;
  return share.memoryBytes > 0 ? (bytes / share.memoryBytes) * 100 : null;
}

export interface NowPercents {
  readonly cpu: number | null;
  readonly memory: number | null;
  readonly ofShare: boolean;
}

export function nowPercents(snapshot: MonitorSnapshot): NowPercents {
  const share = snapshot.slot?.share ?? null;
  if (!share) return { cpu: snapshot.cpu.usagePercent, memory: snapshot.memory.usagePercent, ofShare: false };
  const own = snapshot.own ?? null;
  return { cpu: percentOfShare(own?.cpuCores, share), memory: memoryOfShare(own?.memoryBytes, share), ofShare: true };
}

function coresWords(cores: number): string {
  return Number.isInteger(cores) ? String(cores) : cores.toFixed(1);
}

export function slotCpuWords(cores: number | null, share: SlotShare, host: string, macCores: number): string {
  if (cores === null) return `Its share: ${coresWords(share.cores)} of ${host}'s ${macCores} cores`;
  return `${cores.toFixed(1)} of its ${coresWords(share.cores)} cores, of ${host}'s ${macCores}`;
}

export function hostAtStart(host: string): string {
  return host.startsWith("its ") ? `Its ${host.slice("its ".length)}` : host;
}

export function slotLineWords(host: string, slots: number): string {
  const many = slots === 1 ? "the only slot it holds" : `one of up to ${slots} slots there`;
  return `This slot is a macOS user on ${host}, ${many}. Its CPU and memory are its own processes', measured against its share: ${host}'s cores and memory divided by ${slots === 1 ? "1" : slots}. ${hostAtStart(host)}'s numbers are every slot's together, and never make this slot busy.`;
}

export function memoryPressure(percentUsed: number): { label: string; tone: "neutral" | "warn" | "bad" } {
  if (percentUsed >= 95) return { label: "Critical", tone: "bad" };
  if (percentUsed >= 85) return { label: "High", tone: "warn" };
  return { label: "Normal", tone: "neutral" };
}

export function hostBusy(snapshot: MonitorSnapshot): boolean {
  const cpu = snapshot.cpu.usagePercent;
  const load = snapshot.cpu.loadAverage?.[1];
  return (cpu !== null && cpu >= 85) || (load !== undefined && load / snapshot.cpu.cores >= 1);
}

export const BUSIEST_ABOVE = 5;

export function busiestShown(value: number | null, peak: number | null | undefined): peak is number {
  return value !== null && peak !== null && peak !== undefined && peak - value >= BUSIEST_ABOVE;
}

export function readOutWords(series: readonly ChartSeries[], index: number, when: string, gap: string, note: string | null = null): string {
  const read = series.map((line) => ({ line, value: line.values[index] ?? null, peak: line.peaks?.[index] ?? null }));
  if (!read.some((each) => each.value !== null)) return `${when}: ${gap}`;
  const values = read.map(({ line, value, peak }) => `${line.label} ${value === null ? "no reading" : line.format(value)}${busiestShown(value, peak) ? `, busiest minute ${line.format(peak)}` : ""}`).join(", ");
  return `${when}: ${values}${note ? `; ${note}` : ""}`;
}

export const RANGE_LABELS: Readonly<Record<HistoryRange, string>> = { "1h": "1 h", "24h": "24 h", "7d": "7 d" };

export const RANGE_WORDS: Readonly<Record<HistoryRange, string>> = {
  "1h": "the last hour, by the minute",
  "24h": "the last 24 hours, by 10 minutes",
  "7d": "the last 7 days, by the hour",
};

export const GAP_WORDS: Readonly<Record<GapKind, string>> = {
  "not-made": "Not made yet",
  starting: "Starting",
  stopped: "Stopped",
  "not-read": "Not read",
  "no-reading": "No reading",
};

export function historyTimeWords(range: HistoryRange, now: number): (at: number) => string {
  return range === "1h" ? (at) => clock(at) : (at) => dayAndClock(at, now);
}

function localTicks(from: number, to: number, first: Date, advance: (date: Date) => void, words: (at: number) => string): Tick[] {
  const ticks: Tick[] = [];
  for (let guard = 0; first.getTime() <= to && guard < 400; guard++) {
    const at = first.getTime();
    if (at >= from) ticks.push({ at, words: words(at) });
    advance(first);
  }
  return ticks;
}

export function historyTicks(range: HistoryRange, window: { readonly from: number; readonly to: number }): Tick[] {
  const first = new Date(window.from);
  if (range === "1h") {
    first.setMinutes(Math.floor(first.getMinutes() / 15) * 15, 0, 0);
    return localTicks(window.from, window.to, first, (date) => date.setMinutes(date.getMinutes() + 15), clock);
  }
  if (range === "24h") {
    first.setHours(Math.floor(first.getHours() / 6) * 6, 0, 0, 0);
    return localTicks(window.from, window.to, first, (date) => date.setHours(date.getHours() + 6), clock);
  }
  first.setHours(0, 0, 0, 0);
  return localTicks(window.from, window.to, first, (date) => date.setDate(date.getDate() + 1), (at) => new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(at));
}

export function historyGapsWords(gaps: readonly HistoryGap[], timeWords: (at: number) => string, now: number): string {
  if (!gaps.length) return "";
  return ` ${gaps.map((gap) => `${GAP_WORDS[gap.kind]} from ${timeWords(gap.from)}${gap.to >= now ? "" : ` to ${timeWords(gap.to)}`}`).join("; ")}.`;
}

export interface HistoryLine {
  readonly label: string;
  readonly values: readonly (number | null)[];
  readonly peaks?: readonly (number | null)[];
}

export function historySummary(words: string, times: readonly number[], lines: { readonly cpu: HistoryLine; readonly memory: HistoryLine }, gaps: readonly HistoryGap[], timeWords: (at: number) => string, now: number): string {
  const cpu = measure(times, lines.cpu.values);
  const busiest = measure(times, lines.cpu.values.map((value, index) => lines.cpu.peaks?.[index] ?? value));
  const memory = measure(times, lines.memory.values);
  const gapWords = historyGapsWords(gaps, timeWords, now);
  if (!cpu && !memory) return `No readings over ${words}.${gapWords}`;
  const parts = [
    cpu && busiest ? `${lines.cpu.label} averaged ${percent(cpu.mean)}, highest ${percent(busiest.highest)} at ${timeWords(busiest.highestAt)}` : `${lines.cpu.label} not read`,
    memory ? `${lines.memory.label.toLowerCase() === "memory" ? "memory" : lines.memory.label} last ${percent(memory.last)}` : null,
  ].filter(Boolean);
  return `Over ${words}: ${parts.join("; ")}.${gapWords}`;
}

export function historyNetworkSummary(words: string, times: readonly number[], down: readonly (number | null)[], up: readonly (number | null)[], gaps: readonly HistoryGap[], timeWords: (at: number) => string, now: number): string {
  const received = measure(times, down);
  const sent = measure(times, up);
  const gapWords = historyGapsWords(gaps, timeWords, now);
  if (!received && !sent) return `No network readings over ${words}.${gapWords}`;
  const parts = [
    received ? `download averaged ${rateWords(received.mean)}, highest ${rateWords(received.highest)} at ${timeWords(received.highestAt)}` : null,
    sent ? `upload averaged ${rateWords(sent.mean)}, highest ${rateWords(sent.highest)} at ${timeWords(sent.highestAt)}` : null,
  ].filter(Boolean);
  return `Over ${words}: ${parts.join("; ")}.${gapWords}`;
}

export function stepSpanWords(range: HistoryRange, at: number, stepMs: number, timeWords: (at: number) => string): string {
  if (range === "1h") return timeWords(at);
  return `${timeWords(at)} to ${clock(at + stepMs)}`;
}

export function partlyReadWords(range: HistoryRange, coveredSeconds: number): string {
  return `partly read, ${span(coveredSeconds * 1000)} of ${range === "7d" ? "the hour" : "10 minutes"}`;
}

export function historyBoundsOf(from: number, to: number, stepMs: number): { readonly from: number; readonly to: number } {
  return { from: from + stepMs / 2, to: to - stepMs / 2 };
}
