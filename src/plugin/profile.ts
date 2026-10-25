// A CPU profile of the process bb-box runs in, BB's server, on demand only,
// to name the code that holds its event loop: the loop watch found it standing still for
// about half a second, about every 5 s, which every desktop's frames and
// input wait out. One profile at a time, for at most 60 s. It reports only
// functions' names, files, lines and times: no arguments, no data. The
// profile itself can be kept, as a .cpuprofile file a person opens in
// Chrome's DevTools; and each major garbage collection meanwhile is noted,
// with the heap's size after it, which V8 gives at no cost, as a heap
// snapshot would hold the loop for seconds on a live server.

import { spawn } from "node:child_process";
import { Session } from "node:inspector";
import { PerformanceObserver, constants } from "node:perf_hooks";
import { getHeapSpaceStatistics, getHeapStatistics } from "node:v8";

export const MAX_PROFILE_SECONDS = 60;
/** Garbage collections this long are noted. */
const GC_MS = 10;
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

/** A garbage collection during a profile, from its start in ms, and the heap after it in MiB. */
export interface GcNote {
  readonly at: number;
  readonly ms: number;
  readonly major: boolean;
  readonly heapMiB: number;
  readonly oldMiB: number;
}

export interface ProfileOptions {
  /** Keeps the profile, as a .cpuprofile file: where it went, for the summary, or null when it was not kept. */
  save?(profile: CpuProfile): Promise<string | null>;
  /**
   * Samples the heap's allocations meanwhile too, about one in every 64 KiB, at little cost, and keeps them, as a
   * .heapprofile file: who allocates, which a growing heap is made of.
   */
  allocations?(profile: HeapProfile): Promise<string | null>;
  /** After the profile, a full heap snapshot: where it went. It holds the loop for as long as it takes to write. */
  snapshot?(): Promise<string>;
  fullCollection?: boolean;
}

/** A node of V8's sampled heap profile: the bytes its own frame allocated, sampled. */
export interface HeapProfileNode {
  readonly callFrame: CallFrame;
  readonly selfSize: number;
  readonly children: readonly HeapProfileNode[];
}

export interface HeapProfile {
  readonly head: HeapProfileNode;
}

/** The allocations sampled, by whose code allocated them, as busy time is, and the sites that allocated most. */
export function allocationLines(profile: HeapProfile, seconds: number): string[] {
  const totals = { "bb-box": 0, plugin: 0, bb: 0, node: 0, other: 0 };
  const sites = new Map<string, number>();
  const walk = (node: HeapProfileNode, owners: ReadonlySet<string>) => {
    const owner = ownerOf(node.callFrame.url);
    const here = owner ? new Set([...owners, owner]) : owners;
    if (node.selfSize) {
      const whose = (["bb-box", "plugin", "bb", "node"] as const).find((each) => here.has(each)) ?? "other";
      totals[whose] += node.selfSize;
      if (node.callFrame.url) sites.set(label(node.callFrame), (sites.get(label(node.callFrame)) ?? 0) + node.selfSize);
    }
    for (const child of node.children) walk(child, here);
  };
  walk(profile.head, new Set());
  const mib = (bytes: number) => `${(bytes / MiB).toFixed(1)} MiB`;
  const top = [...sites].sort((a, b) => b[1] - a[1]).slice(0, SELF_TOLD);
  return [
    `Allocations sampled over ${seconds} s, by whose code made them: bb-box ${mib(totals["bb-box"])}, other plugins ${mib(totals.plugin)}, BB ${mib(totals.bb)}, Node alone ${mib(totals.node)}, with no JavaScript frame ${mib(totals.other)}.`,
    ...(top.length ? [`Allocated most: ${top.map(([site, bytes]) => `${site} ${mib(bytes)}`).join(", ")}.`] : []),
  ];
}

const MiB = 1024 * 1024;

/**
 * Profiles BB's server process, which runs bb-box, for `seconds`, at most 60, with each long garbage collection
 * meanwhile, and sums it up in lines for people.
 */
export async function profileLoop(seconds: number, options: ProfileOptions = {}): Promise<string[]> {
  if (running) throw new Error("A profile of BB's server is running already: one runs at a time.");
  const span = Math.min(Math.max(1, Math.round(seconds)), MAX_PROFILE_SECONDS);
  running = true;
  const session = new Session();
  const post = <T>(method: string, params: object = {}) =>
    new Promise<T>((resolve, reject) => session.post(method, params, (error, result) => (error ? reject(error) : resolve(result as T))));
  const gc: GcNote[] = [];
  let observer: PerformanceObserver | null = null;
  const began = performance.now();
  const before = getHeapStatistics();
  try {
    session.connect();
    try {
      // After each long collection, the heap as it is: its used size, and the old space's, cheap to read.
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration < GC_MS) continue;
          const old = getHeapSpaceStatistics().find((space) => space.space_name === "old_space");
          const major = (entry as unknown as { detail?: { kind?: number } }).detail?.kind === constants.NODE_PERFORMANCE_GC_MAJOR;
          gc.push({ at: entry.startTime - began, ms: entry.duration, major, heapMiB: getHeapStatistics().used_heap_size / MiB, oldMiB: (old?.space_used_size ?? 0) / MiB });
        }
      });
      observer.observe({ entryTypes: ["gc"] });
    } catch {
      // Without garbage collection entries the profile is still told.
    }
    await post("Profiler.enable");
    await post("Profiler.setSamplingInterval", { interval: 1000 });
    if (options.allocations) {
      await post("HeapProfiler.enable");
      await post("HeapProfiler.startSampling", { samplingInterval: 65_536 });
    }
    await post("Profiler.start");
    await new Promise((resolve) => setTimeout(resolve, span * 1000));
    const { profile } = await post<{ profile: CpuProfile }>("Profiler.stop");
    const heap = options.allocations ? (await post<{ profile: HeapProfile }>("HeapProfiler.stopSampling")).profile : null;
    const lines = [...summarise(profile, span), ...gcLines(gc, before.used_heap_size / MiB, getHeapStatistics())];
    if (options.fullCollection) lines.push(await collectGarbage(post));
    lines.push(memoryLine(process.memoryUsage()));
    const told = (error: unknown) => `not kept: ${error instanceof Error ? error.message : String(error)}`;
    const saved = await options.save?.(profile).catch(told);
    if (saved) lines.push(`The profile is ${saved}.`);
    if (heap) {
      lines.push(...allocationLines(heap, span));
      const kept = await options.allocations!(heap).catch(told);
      if (kept) lines.push(`The allocations are ${kept}.`);
    }
    lines.push(await spawnCostLine());
    if (options.snapshot) lines.push(`The heap snapshot is ${await options.snapshot().catch(told)}.`);
    return lines;
  } finally {
    observer?.disconnect();
    if (options.allocations) await post("HeapProfiler.disable").catch(() => undefined);
    await post("Profiler.disable").catch(() => undefined);
    session.disconnect();
    running = false;
  }
}

/**
 * What starting a child process costs the loop here: three of `true`, one after another, each spawn call timed, as
 * libuv forks the whole process on the loop's thread on Linux.
 */
export async function spawnCostLine(): Promise<string> {
  const times: number[] = [];
  for (let i = 0; i < 3; i++) {
    const began = performance.now();
    const child = spawn("true", [], { stdio: "ignore" });
    times.push(performance.now() - began);
    await new Promise((resolve) => {
      child.once("exit", resolve);
      child.once("error", resolve);
    });
  }
  return `Starting a process here held the loop for ${times.map((ms) => `${ms.toFixed(1)} ms`).join(", ")}, as the spawn call forks BB's server with ${Math.round(process.memoryUsage().rss / MiB)} MiB in use.`;
}

async function collectGarbage(post: (method: string) => Promise<unknown>): Promise<string> {
  const heapBefore = getHeapStatistics();
  const started = performance.now();
  await post("HeapProfiler.collectGarbage");
  return collectionLine({ beforeBytes: heapBefore.used_heap_size, afterBytes: getHeapStatistics().used_heap_size, heldMs: performance.now() - started });
}

export function collectionLine(collection: { beforeBytes: number; afterBytes: number; heldMs: number }): string {
  return `A full garbage collection, as asked, held BB's server for ${Math.round(collection.heldMs)} ms: its heap went from ${Math.round(collection.beforeBytes / MiB)} to ${Math.round(collection.afterBytes / MiB)} MiB used.`;
}

export function memoryLine(memory: Pick<NodeJS.MemoryUsage, "rss" | "heapUsed" | "heapTotal" | "external" | "arrayBuffers">): string {
  const mib = (bytes: number) => `${Math.round(bytes / MiB)} MiB`;
  return `The process held ${mib(memory.rss)} in all: its heap ${mib(memory.heapUsed)} used of ${mib(memory.heapTotal)}, and outside it ${mib(memory.external)} of external memory, ${mib(memory.arrayBuffers)} of it in ArrayBuffers and Buffers.`;
}

/** The long garbage collections in lines: how many, how long, and the heap after each major one. */
export function gcLines(gc: readonly GcNote[], startMiB: number, end: { used_heap_size: number; heap_size_limit: number }): string[] {
  const major = gc.filter((each) => each.major);
  const minor = gc.filter((each) => !each.major);
  const sum = (list: readonly GcNote[]) => Math.round(list.reduce((total, each) => total + each.ms, 0));
  const heap = `the heap went from ${Math.round(startMiB)} to ${Math.round(end.used_heap_size / MiB)} MiB used, of ${Math.round(end.heap_size_limit / MiB)} MiB at most`;
  if (!gc.length) return [`No garbage collection took ${GC_MS} ms or more; ${heap}.`];
  const lines = [`Garbage collections of ${GC_MS} ms or more: ${major.length} major, ${sum(major)} ms, and ${minor.length} ${minor.length === 1 ? "other" : "others"}, ${sum(minor)} ms; ${heap}.`];
  if (major.length) {
    lines.push(`Each major one, at its start: ${major.map((each) => `${(each.at / 1000).toFixed(1)} s ${Math.round(each.ms)} ms, then ${Math.round(each.heapMiB)} MiB used, ${Math.round(each.oldMiB)} MiB old`).join("; ")}.`);
  }
  return lines;
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

/** Whose code a frame is: bb-box's, another plugin's, Node's own, or BB's, by its file. */
export function ownerOf(url: string): "bb-box" | "plugin" | "node" | "bb" | null {
  if (!url) return null;
  if (url.startsWith("node:")) return "node";
  const path = url.replace(/^file:\/\//, "");
  if (path.includes("/bb-box/")) return "bb-box";
  if (/\/plugins\/[^/]+\//.test(path)) return "plugin";
  return "bb";
}

/**
 * Busy time by whose code it ran under: a sample under any of bb-box's frames is bb-box's, as what bb-box calls of
 * BB's, such as its storage, runs for it; then another plugin's, then BB's own, then Node's alone; and garbage
 * collection and V8's own work, which no frame names.
 */
function ownersLine(
  samples: readonly { id: number; ms: number; idle: boolean }[],
  nodes: ReadonlyMap<number, ProfileNode>,
  parents: ReadonlyMap<number, number>,
  busy: number,
): string {
  const totals = { "bb-box": 0, plugin: 0, bb: 0, node: 0, gc: 0, program: 0 };
  for (const sample of samples) {
    if (sample.idle) continue;
    const name = nodes.get(sample.id)?.callFrame.functionName;
    if (name === "(garbage collector)") {
      totals.gc += sample.ms;
      continue;
    }
    const owners = new Set<string>();
    for (let at: number | undefined = sample.id; at !== undefined; at = parents.get(at)) {
      const owner = ownerOf(nodes.get(at)?.callFrame.url ?? "");
      if (owner) owners.add(owner);
    }
    const owner = (["bb-box", "plugin", "bb", "node"] as const).find((each) => owners.has(each)) ?? "program";
    totals[owner] += sample.ms;
  }
  const share = (ms: number) => `${Math.round(ms)} ms (${Math.round((ms / Math.max(busy, 1)) * 100)}%)`;
  return (
    `Busy time by whose code it ran under: bb-box ${share(totals["bb-box"])}, other plugins ${share(totals.plugin)}, BB ${share(totals.bb)}, ` +
    `Node alone ${share(totals.node)}, garbage collection ${share(totals.gc)}, V8 and native code with no JavaScript frame ${share(totals.program)}.`
  );
}
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
    `A CPU profile of BB's server, which runs bb-box, over ${seconds} s: busy ${Math.round((busy / Math.max(at, 1)) * 100)}% of it, with ${spans.length} ${spans.length === 1 ? "span" : "spans"} busy for ${BUSY_MS} ms or more` +
      (spans.length ? `, the longest ${Math.round(Math.max(...spans.map((span) => span.ms)))} ms.` : "."),
  ];
  lines.push(ownersLine(samples, nodes, parents, busy));
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
