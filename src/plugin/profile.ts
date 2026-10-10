// A CPU profile of bb-box's own process, on demand only, to name the code
// that holds its event loop: the loop watch found it standing still for
// about half a second, about every 5 s, which every desktop's frames and
// input wait out. One profile at a time, for at most 30 s. It reports only
// functions' names, files, lines and times: no arguments, no data.

import { Session } from "node:inspector";

export const MAX_PROFILE_SECONDS = 30;
/** A run of samples with no idle one this long is a busy span, which the loop could not leave. */
const BUSY_MS = 100;
/** The frames a busy span names, and the spans told. */
const FRAMES_PER_SPAN = 8;
const SPANS_TOLD = 5;
const SELF_TOLD = 10;

interface CallFrame {
  readonly functionName: string;
  readonly url: string;
  readonly lineNumber: number;
}

export interface ProfileNode {
  readonly id: number;
  readonly callFrame: CallFrame;
  readonly children?: readonly number[];
}

/** V8's CPU profile, as the inspector's Profiler.stop gives it. */
export interface CpuProfile {
  readonly nodes: readonly ProfileNode[];
  readonly samples: readonly number[];
  /** Microseconds since the sample before. */
  readonly timeDeltas: readonly number[];
}

let running = false;

/** Profiles bb-box's process for `seconds`, at most 30, and sums it up in lines for people. */
export async function profileLoop(seconds: number): Promise<string[]> {
  if (running) throw new Error("A profile of bb-box is running already: one runs at a time.");
  const span = Math.min(Math.max(1, Math.round(seconds)), MAX_PROFILE_SECONDS);
  running = true;
  const session = new Session();
  const post = <T>(method: string, params: object = {}) =>
    new Promise<T>((resolve, reject) => session.post(method, params, (error, result) => (error ? reject(error) : resolve(result as T))));
  try {
    session.connect();
    await post("Profiler.enable");
    await post("Profiler.setSamplingInterval", { interval: 1000 });
    await post("Profiler.start");
    await new Promise((resolve) => setTimeout(resolve, span * 1000));
    const { profile } = await post<{ profile: CpuProfile }>("Profiler.stop");
    return summarise(profile, span);
  } finally {
    await post("Profiler.disable").catch(() => undefined);
    session.disconnect();
    running = false;
  }
}

/** "name (file:line)": the file from bb-box's folder on, or its name alone. */
function label({ functionName, url, lineNumber }: CallFrame): string {
  if (!url) return functionName || "(anonymous)";
  const path = url.replace(/^file:\/\//, "");
  const inside = path.lastIndexOf("/bb-box/");
  const file = inside >= 0 ? path.slice(inside + "/bb-box/".length) : path.split("/").at(-1)!;
  return `${functionName || "(anonymous)"} (${file}:${lineNumber + 1})`;
}

const IDLE = "(idle)";
/** Frames that name no code of anyone's. */
const NOISE = new Set(["(root)", "(program)", "(garbage collector)", IDLE]);

/**
 * The profile in lines: how busy the process was, each long busy span with
 * the frames it ran under the longest, and the functions with the most time
 * of their own.
 */
export function summarise(profile: CpuProfile, seconds: number): string[] {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const stack = (id: number): string[] => {
    const frames: string[] = [];
    for (let at: number | undefined = id; at !== undefined; at = parents.get(at)) {
      const node = nodes.get(at);
      if (node && !NOISE.has(node.callFrame.functionName) && !node.callFrame.url.startsWith("node:")) frames.push(label(node.callFrame));
    }
    return frames;
  };
  // Each sample's time, in ms, and whether it was idle.
  const samples = profile.samples.map((id, index) => ({ id, ms: (profile.timeDeltas[index + 1] ?? profile.timeDeltas[index] ?? 0) / 1000, idle: nodes.get(id)?.callFrame.functionName === IDLE }));
  const spans: { start: number; ms: number; from: number; to: number }[] = [];
  let at = 0, busy = 0;
  for (let index = 0, from = -1; index <= samples.length; index++) {
    const sample = samples[index];
    if (sample && !sample.idle) {
      if (from < 0) from = index;
    } else if (from >= 0) {
      const ms = samples.slice(from, index).reduce((sum, each) => sum + each.ms, 0);
      if (ms >= BUSY_MS) spans.push({ start: samples.slice(0, from).reduce((sum, each) => sum + each.ms, 0) / 1000, ms, from, to: index });
      from = -1;
    }
    if (sample) {
      at += sample.ms;
      if (!sample.idle) busy += sample.ms;
    }
  }
  const lines = [
    `A CPU profile of bb-box over ${seconds} s: busy ${Math.round((busy / Math.max(at, 1)) * 100)}% of it, with ${spans.length} ${spans.length === 1 ? "span" : "spans"} busy for ${BUSY_MS} ms or more` +
      (spans.length ? `, the longest ${Math.round(Math.max(...spans.map((span) => span.ms)))} ms.` : "."),
  ];
  for (const span of [...spans].sort((a, b) => b.ms - a.ms).slice(0, SPANS_TOLD)) {
    const inclusive = new Map<string, number>();
    for (const sample of samples.slice(span.from, span.to)) for (const frame of new Set(stack(sample.id))) inclusive.set(frame, (inclusive.get(frame) ?? 0) + sample.ms);
    const frames = [...inclusive].sort((a, b) => b[1] - a[1]).slice(0, FRAMES_PER_SPAN);
    lines.push(
      `Busy ${Math.round(span.ms)} ms from ${span.start.toFixed(1)} s, under: ` +
        (frames.length ? frames.map(([frame, ms]) => `${frame} ${Math.round((ms / span.ms) * 100)}%`).join(", ") : "no JavaScript frame") +
        ".",
    );
  }
  const own = new Map<string, number>();
  for (const sample of samples) {
    const node = nodes.get(sample.id);
    if (node && !NOISE.has(node.callFrame.functionName)) own.set(label(node.callFrame), (own.get(label(node.callFrame)) ?? 0) + sample.ms);
  }
  const top = [...own].sort((a, b) => b[1] - a[1]).slice(0, SELF_TOLD);
  if (top.length) lines.push(`Most time of their own: ${top.map(([frame, ms]) => `${frame} ${Math.round(ms)} ms`).join(", ")}.`);
  return lines;
}
