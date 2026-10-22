// Watches the event loop bb-box runs on for stalls: BB's server's, which
// bb-box's relays share with BB's own work and other plugins. Measured on 10 October 2026, a
// desktop's frames through BB's server stood still for about 370 ms, twice
// every 11 s, on VNC and video alike, while the box sent them evenly: a drag
// lagged by up to a second. A timer that runs every 100 ms finds when the
// loop could not run it, and garbage collection meanwhile is counted, so the
// log says whether the process stalls, and whether collecting garbage is
// why. A CPU profile (profile.ts) names the code. One line a minute at most, and none while the loop keeps up;
// it tells too how many processes bb-box started that minute, and how long the spawn calls held the loop, as each
// forks BB's server. And five minutes after a start, then once an hour, whatever happened, the server's memory:
// whether its heap grows, which makes each major collection longer.

import { PerformanceObserver, constants, performance } from "node:perf_hooks";
import type { SpawnTotals } from "../transports/spawns.ts";

const TICK_MS = 100;
/** A gap between ticks this long is a stall: the loop ran nothing else for that long, or ran something that long. */
const STALL_MS = 250;
const REPORT_MS = 60_000;
const MEMORY_MS = 60 * 60_000;
/** The first memory line comes this soon after a start, as bb-box often reloads within the hour. */
const FIRST_MEMORY_MS = 5 * 60_000;
const MiB = 1024 * 1024;
/** Garbage collections this long are counted. */
const GC_MS = 10;

export interface LoopWatchOptions {
  log(message: string): void;
  /** Milliseconds, as performance.now(), which garbage collection entries use. */
  now?(): number;
  /** Ticks and garbage collection come from the caller, for tests. */
  manual?: boolean;
  /** The processes bb-box started, ever, and their spawn calls' time; and the longest call since last asked. */
  spawns?(): SpawnTotals;
  longestSpawn?(): number;
  /** The process's memory, as process.memoryUsage() gives it. */
  memory?(): { readonly rss: number; readonly heapUsed: number; readonly heapTotal: number; readonly external: number };
}

export interface GcEntry {
  readonly startTime: number;
  readonly duration: number;
  readonly major: boolean;
}

/** How many of the hour's children the helper started, when it is known. */
function helpedPart(now: SpawnTotals, before: SpawnTotals): string {
  if (now.helped === undefined) return "";
  return `, ${now.helped - (before.helped ?? 0)} of them by the helper`;
}

const MOST_FROM = 5;

/** The callers that started the most of the hour's children. */
function mostFromPart(now: SpawnTotals, before: SpawnTotals): string {
  if (!now.byCaller) return "";
  const most = [...now.byCaller]
    .map(([caller, total]) => [caller, total - (before.byCaller?.get(caller) ?? 0)] as const)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MOST_FROM);
  if (!most.length) return "";
  return `; the most from ${most.map(([caller, count]) => `${caller} (${count})`).join(", ")}`;
}

export class LoopWatch {
  readonly #options: LoopWatchOptions;
  readonly #now: () => number;
  #last: number;
  #reported: number;
  #stalls: { start: number; end: number }[] = [];
  #gc: GcEntry[] = [];
  /** The spawn totals at the last minute's line, and at the last memory line. */
  #spawnedMinute: SpawnTotals = { count: 0, ms: 0 };
  #spawnedHour: SpawnTotals = { count: 0, ms: 0 };
  #memoryAt: number;
  /** When the period the next memory line covers began. */
  #memorySince: number;
  readonly #timer: ReturnType<typeof setInterval> | null = null;
  readonly #observer: PerformanceObserver | null = null;

  constructor(options: LoopWatchOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => performance.now());
    this.#last = this.#reported = this.#memorySince = this.#now();
    this.#memoryAt = this.#memorySince - MEMORY_MS + FIRST_MEMORY_MS;
    this.#spawnedMinute = this.#spawnedHour = options.spawns?.() ?? { count: 0, ms: 0 };
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
    if (now - this.#memoryAt >= MEMORY_MS) this.#memory(now);
    if (now - this.#reported < REPORT_MS) return;
    this.#report(now);
  }

  /** The hour's line, the first five minutes after a start: the server's memory, and the processes bb-box started. */
  #memory(now: number): void {
    const minutes = Math.round((now - this.#memorySince) / 60_000);
    const period = minutes === 60 ? "the last hour" : `the last ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
    this.#memoryAt = this.#memorySince = now;
    const memory = this.#options.memory?.();
    const spawns = this.#options.spawns?.();
    if (!memory && !spawns) return;
    const parts: string[] = [];
    if (memory) {
      parts.push(
        `its heap held ${Math.round(memory.heapUsed / MiB)} MiB of ${Math.round(memory.heapTotal / MiB)} MiB, ${Math.round(memory.external / MiB)} MiB more was outside it, and the process ${Math.round(memory.rss / MiB)} MiB in all`,
      );
    }
    if (spawns) {
      const count = spawns.count - this.#spawnedHour.count;
      parts.push(
        `bb-box started ${count} ${count === 1 ? "process" : "processes"} in ${period}, the spawn calls taking ${Math.round(spawns.ms - this.#spawnedHour.ms)} ms in all` +
          helpedPart(spawns, this.#spawnedHour) +
          mostFromPart(spawns, this.#spawnedHour),
      );
      this.#spawnedHour = spawns;
    }
    this.#options.log(`BB's server, which runs bb-box: ${parts.join("; ")}.`);
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
    const spawns = this.#options.spawns?.();
    const longestSpawn = this.#options.longestSpawn?.() ?? 0;
    const spawned = spawns ? { count: spawns.count - this.#spawnedMinute.count, ms: spawns.ms - this.#spawnedMinute.ms } : null;
    if (spawns) this.#spawnedMinute = spawns;
    if (!stalls.length) return;
    const longest = Math.max(...stalls.map((stall) => stall.end - stall.start));
    const inside = gc.filter((entry) => stalls.some((stall) => entry.startTime < stall.end && entry.startTime + entry.duration > stall.start));
    const gcMs = inside.reduce((sum, entry) => sum + entry.duration, 0);
    const major = inside.filter((entry) => entry.major).length;
    const times = stalls.length === 1 ? "once" : `${stalls.length} times`;
    this.#options.log(
      `BB's server, which runs bb-box, stood still ${times} in the last minute, for up to ${Math.round(longest)} ms: desktops' frames and input waited meanwhile. ` +
        (inside.length
          ? `Garbage collection ran for ${Math.round(gcMs)} ms of it, in ${inside.length} ${inside.length === 1 ? "collection" : "collections"}, ${major} of them major.`
          : "No garbage collection ran then: something else held the loop.") +
        (spawned
          ? ` bb-box started ${spawned.count} ${spawned.count === 1 ? "process" : "processes"} in that minute, the spawn calls taking ${Math.round(spawned.ms)} ms in all, ${Math.round(longestSpawn)} ms at most.`
          : ""),
    );
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#observer?.disconnect();
  }
}
