// Watches bb-box's own event loop for stalls. Measured on 10 October 2026, a
// desktop's frames through BB's server stood still for about 370 ms, twice
// every 11 s, on VNC and video alike, while the box sent them evenly: a drag
// lagged by up to a second. A timer that runs every 100 ms finds when the
// loop could not run it, and garbage collection meanwhile is counted, so the
// log says whether bb-box's process stalls, and whether collecting garbage is
// why. One line a minute at most, and none while the loop keeps up.

import { PerformanceObserver, constants, performance } from "node:perf_hooks";

const TICK_MS = 100;
/** A gap between ticks this long is a stall: the loop ran nothing else for that long, or ran something that long. */
const STALL_MS = 250;
const REPORT_MS = 60_000;
/** Garbage collections this long are counted. */
const GC_MS = 10;

export interface LoopWatchOptions {
  log(message: string): void;
  /** Milliseconds, as performance.now(), which garbage collection entries use. */
  now?(): number;
  /** Ticks and garbage collection come from the caller, for tests. */
  manual?: boolean;
}

export interface GcEntry {
  readonly startTime: number;
  readonly duration: number;
  readonly major: boolean;
}

export class LoopWatch {
  readonly #options: LoopWatchOptions;
  readonly #now: () => number;
  #last: number;
  #reported: number;
  #stalls: { start: number; end: number }[] = [];
  #gc: GcEntry[] = [];
  readonly #timer: ReturnType<typeof setInterval> | null = null;
  readonly #observer: PerformanceObserver | null = null;

  constructor(options: LoopWatchOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => performance.now());
    this.#last = this.#reported = this.#now();
    if (options.manual) return;
    this.#timer = setInterval(() => this.tick(), TICK_MS);
    this.#timer.unref?.();
    try {
      this.#observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const kind = (entry as unknown as { detail?: { kind?: number } }).detail?.kind;
          this.gc({ startTime: entry.startTime, duration: entry.duration, major: kind === constants.NODE_PERFORMANCE_GC_MAJOR });
        }
      });
      this.#observer.observe({ entryTypes: ["gc"] });
    } catch {
      // Without garbage collection entries the stalls are still told.
    }
  }

  /** The timer's run: a stall when it comes late, and the minute's line when one is due. */
  tick(): void {
    const now = this.#now();
    if (now - this.#last >= STALL_MS) this.#stalls.push({ start: this.#last, end: now });
    this.#last = now;
    if (now - this.#reported < REPORT_MS) return;
    this.#report(now);
  }

  gc(entry: GcEntry): void {
    if (entry.duration >= GC_MS) this.#gc.push(entry);
  }

  #report(now: number): void {
    this.#reported = now;
    const stalls = this.#stalls;
    const gc = this.#gc;
    this.#stalls = [];
    this.#gc = [];
    if (!stalls.length) return;
    const longest = Math.max(...stalls.map((stall) => stall.end - stall.start));
    const inside = gc.filter((entry) => stalls.some((stall) => entry.startTime < stall.end && entry.startTime + entry.duration > stall.start));
    const gcMs = inside.reduce((sum, entry) => sum + entry.duration, 0);
    const major = inside.filter((entry) => entry.major).length;
    const times = stalls.length === 1 ? "once" : `${stalls.length} times`;
    this.#options.log(
      `bb-box's event loop stood still ${times} in the last minute, for up to ${Math.round(longest)} ms: desktops' frames and input waited meanwhile. ` +
        (inside.length
          ? `Garbage collection ran for ${Math.round(gcMs)} ms of it, in ${inside.length} ${inside.length === 1 ? "collection" : "collections"}, ${major} of them major.`
          : "No garbage collection ran then: something else held the loop."),
    );
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#observer?.disconnect();
  }
}
