// How long starting each child process holds the event loop. On Linux, libuv
// starts one with fork, on the loop's thread, and the fork's time grows with
// the parent's memory: BB's server, which runs bb-box, held 3.5 GB after ten
// days. The loop watch tells the count and the time each minute, and the
// memory each hour, so a stall can be laid at a spawn's door or not. Each
// hour it tells too which of bb-box's functions started the most, by the names
// on the stack, and how many the helper started (forker.ts).

import { performance } from "node:perf_hooks";

export interface SpawnTotals {
  /** Children started, ever. */
  readonly count: number;
  /** Milliseconds the spawn calls took, all told. */
  readonly ms: number;
  /** Of them, the children the helper started, so BB's server did not fork. */
  readonly helped?: number;
  /** Children started, ever, by who started them. */
  readonly byCaller?: ReadonlyMap<string, number>;
}

let count = 0;
let ms = 0;
let helped = 0;
let longest = 0;
const byCaller = new Map<string, number>();
/** Callers past this many are counted together, so the map stays small. */
const CALLERS = 200;
const OTHERS = "others";

/** Runs `start`, a call that starts a child process, and counts its time; `viaHelper` when the helper forks. */
export function timedSpawn<T>(start: () => T, viaHelper = false): T {
  const began = performance.now();
  try {
    return start();
  } finally {
    const took = performance.now() - began;
    count++;
    ms += took;
    if (viaHelper) helped++;
    if (took > longest) longest = took;
    const caller = spawnCaller();
    const key = byCaller.has(caller) || byCaller.size < CALLERS ? caller : OTHERS;
    byCaller.set(key, (byCaller.get(key) ?? 0) + 1);
  }
}

/** Frames that only pass a spawn on, and say nothing of who wanted it. */
const PLUMBING = new Set(["timedSpawn", "spawnCaller", "callStack", "startChild", "Promise", "Helper.start"]);
const CALLER_FRAMES = 4;

/**
 * Who started a child: the first named functions on the stack past the spawn's own plumbing, innermost first,
 * as "#spawn < ProcessTransport.run < ProxmoxHost.state < Sweep.run". The bundle keeps functions' names but
 * not their files.
 */
export function spawnCaller(stack = callStack()): string {
  const names: string[] = [];
  for (const line of stack.split("\n").slice(1)) {
    const name = /^\s*at (?:async )?(?:new )?([^\s(]+) \(/.exec(line)?.[1];
    if (!name || PLUMBING.has(name)) continue;
    names.push(name);
    if (names.length === CALLER_FRAMES) break;
  }
  return names.join(" < ") || "unknown";
}

function callStack(): string {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 16;
  try {
    return new Error().stack ?? "";
  } finally {
    Error.stackTraceLimit = limit;
  }
}

export function spawnTotals(): SpawnTotals {
  return { count, ms, helped, byCaller: new Map(byCaller) };
}

/** The longest spawn call since the last time this was asked, in ms. */
export function takeLongestSpawn(): number {
  const was = longest;
  longest = 0;
  return was;
}
