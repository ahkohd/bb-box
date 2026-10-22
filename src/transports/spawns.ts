// How long starting each child process holds the event loop. On Linux, libuv
// starts one with fork, on the loop's thread, and the fork's time grows with
// the parent's memory: BB's server, which runs bb-box, held 3.5 GB after ten
// days. The loop watch tells the count and the time each minute, and the
// memory each hour, so a stall can be laid at a spawn's door or not.

import { performance } from "node:perf_hooks";

export interface SpawnTotals {
  /** Children started, ever. */
  readonly count: number;
  /** Milliseconds the spawn calls took, all told. */
  readonly ms: number;
}

let count = 0;
let ms = 0;
let longest = 0;

/** Runs `start`, a call that starts a child process, and counts its time. */
export function timedSpawn<T>(start: () => T): T {
  const began = performance.now();
  try {
    return start();
  } finally {
    const took = performance.now() - began;
    count++;
    ms += took;
    if (took > longest) longest = took;
  }
}

export function spawnTotals(): SpawnTotals {
  return { count, ms };
}

/** The longest spawn call since the last time this was asked, in ms. */
export function takeLongestSpawn(): number {
  const was = longest;
  longest = 0;
  return was;
}
