// What the backends with a warm pool share: their upkeep, one run at a
// time, and why a pool is short of its count.

import type { DoctorCheck, WarmShortfall } from "./types.ts";

/**
 * A backend's upkeep, one run at a time. A call during a run starts one
 * more after it, as the configuration or the pool may have changed since
 * the run read them (#355).
 */
import { PRODUCT } from "../brand.ts";
export class Upkeep {
  readonly #work: (signal: AbortSignal) => Promise<void>;
  #running: Promise<void> | null = null;
  #again = false;

  constructor(work: (signal: AbortSignal) => Promise<void>) {
    this.#work = work;
  }

  /** The run now, for a backend's dispose to wait for. */
  get running(): Promise<void> | null {
    return this.#running;
  }

  run(signal: AbortSignal): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    const running = (async () => {
      do {
        this.#again = false;
        await this.#work(signal);
      } while (this.#again && !signal.aborted);
    })().finally(() => {
      this.#running = null;
    });
    this.#running = running;
    return running;
  }
}

/**
 * The warm pools that a backend's last upkeep left short for want of room
 * (#356). It logs when a pool falls short, when the reason changes and when
 * the pool is no longer short, rather than at every upkeep, and says when
 * what the settings show changes.
 */
export class WarmShortfalls {
  readonly #backend: string;
  readonly #log: (message: string) => void;
  readonly #changed: () => void;
  #short: readonly WarmShortfall[] = [];

  /** `backend` is the backend's ID, for the log. */
  constructor(backend: string, log: (message: string) => void, changed: () => void) {
    this.#backend = backend;
    this.#log = log;
    this.#changed = changed;
  }

  list(): readonly WarmShortfall[] {
    return this.#short;
  }

  /** What an upkeep that ran to its end found. */
  set(short: readonly WarmShortfall[]): void {
    for (const pool of short) {
      const before = this.#short.find((other) => samePool(other, pool));
      if (before && gist(before.reason) === gist(pool.reason)) continue;
      this.#log(`The warm pool of ${kindWords(pool.kinds)} on ${this.#backend} ${shortWords(pool)}`);
    }
    for (const pool of this.#short) {
      if (!short.some((other) => samePool(other, pool))) this.#log(`The warm pool of ${kindWords(pool.kinds)} on ${this.#backend} is no longer short of room.`);
    }
    const shown = (list: readonly WarmShortfall[]) => JSON.stringify(list.map((pool) => [pool.kinds, pool.count, pool.have, gist(pool.reason)]));
    const changed = shown(short) !== shown(this.#short);
    this.#short = short;
    if (changed) this.#changed();
  }
}

/** A doctor's warning for each short pool. */
export function warmChecks(short: readonly WarmShortfall[]): DoctorCheck[] {
  return short.map((pool) => ({
    id: `warm.${pool.kinds.join("+")}`,
    name: `Warm pool of ${kindWords(pool.kinds)}`,
    status: "warn" as const,
    detail: `It ${shortWords(pool)}`,
    fix: `Make room there, or lower the warm count in ${PRODUCT}'s settings.`,
  }));
}

/** "has 0 of its 1 boxes, and no room for another: ..." */
function shortWords(pool: WarmShortfall): string {
  return `has ${pool.have} of its ${pool.count} ${pool.count === 1 ? "box" : "boxes"}, and no room for another: ${pool.reason}`;
}

function kindWords(kinds: readonly string[]): string {
  return kinds.length > 1 ? `${kinds.slice(0, -1).join(", ")} and ${kinds.at(-1)}` : (kinds[0] ?? "no kind");
}

function samePool(a: WarmShortfall, b: WarmShortfall): boolean {
  return a.kinds.join() === b.kinds.join();
}

/** Figures change between upkeeps, such as the disk free, so a reason is another when its words are. */
function gist(reason: string): string {
  return reason.replace(/\d+(?:[.,]\d+)*/g, "#");
}
