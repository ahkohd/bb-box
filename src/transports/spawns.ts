// How long starting each child process holds the event loop. On Linux, libuv
// starts one with fork, on the loop's thread, and the fork's time grows with
// the parent's memory: BB's server, which runs bb-box, held 3.5 GB after ten
// days. The loop watch tells the count and the time each minute, and the
// memory each hour, so a stall can be laid at a spawn's door or not. Each
// hour it tells too how many the helper started (forker.ts), and which started
// the most: each spawn by its site, such as "ssh command", and the work it was
// for, such as "sweep" or "tool box_run", which forPurpose sets where the work
// comes in. The bundle is minified, so the stack's names say nothing.

import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

export interface SpawnTotals {
  /** Children started, ever. */
  readonly count: number;
  /** Milliseconds the spawn calls took, all told. */
  readonly ms: number;
  /** Of them, the children the helper started, so BB's server did not fork. */
  readonly helped?: number;
  /** Children started, ever, by their site and the work they were for. */
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

const purposes = new AsyncLocalStorage<string>();

/** Runs `work` with `purpose`, such as "sweep", as what the processes it starts are for. */
export function forPurpose<T>(purpose: string, work: () => T): T {
  return purposes.run(purpose, work);
}

/** `handlers` with each one run for the purpose `${prefix} ${its name}`. */
export function withPurposes<H extends object>(prefix: string, handlers: H): H {
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [name, typeof handler === "function" ? (...args: unknown[]) => forPurpose(`${prefix} ${name}`, () => handler(...args)) : handler]),
  ) as H;
}

/** What a spawn at `site` is counted as. */
export function spawnLabel(site: string): string {
  return `${site} for ${purposes.getStore() ?? "other work"}`;
}

/**
 * Runs `start`, a call that starts a child process at `site`, such as "ssh command", and counts its time; `viaHelper`
 * when the helper forks.
 */
export function timedSpawn<T>(start: () => T, site: string, viaHelper = false): T {
  const began = performance.now();
  try {
    return start();
  } finally {
    const took = performance.now() - began;
    count++;
    ms += took;
    if (viaHelper) helped++;
    if (took > longest) longest = took;
    const caller = spawnLabel(site);
    const key = byCaller.has(caller) || byCaller.size < CALLERS ? caller : OTHERS;
    byCaller.set(key, (byCaller.get(key) ?? 0) + 1);
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
