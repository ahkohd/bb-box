import { baselineWhy, machinePoint, shareOf, slotPoint, type Kept, type LightOs, type LightReading, type LightRequest, type Point } from "./light.ts";
import { createOwnUsage, type OwnUsageMeter } from "./own-usage.ts";

export const START_LATE_MS = 10_000;
export const READING_TIMEOUT_MS = 10_000;
export const FAILURES_BEFORE_PAUSE = 3;
export const LEAST_WORKERS = 2;
export const MOST_WORKERS = 8;
export const WORKERS_SPREAD_MS = 50_000;
export const PAUSED_ALONE_MS = 15 * 60_000;
const DURATIONS_KEPT = 200;
const FIRST_GUESS_MS = 2_000;
const MINUTE_MS = 60_000;

export type QuietWhy = "monitor" | "history";

export interface HistoryBox {
  readonly id: string;
  readonly name: string;
  readonly os: LightOs | null;
  readonly slot: { readonly host: string; readonly most: number } | null;
  readonly lastStartAt: number | null;
}

export interface HistoryReach {
  notAnswering(boxId: string): boolean;
  lastAnswered(boxId: string): number | null;
  check(boxId: string): Promise<boolean>;
}

export const NO_TALLY: Tally = { due: 0, taken: 0, skipped: 0, failed: 0, unanswered: 0, readingMs: 0, slowestMs: 0, workers: 0 };

export interface Tally {
  readonly due: number;
  readonly taken: number;
  readonly skipped: number;
  readonly failed: number;
  readonly unanswered: number;
  readonly readingMs: number;
  readonly slowestMs: number;
  readonly workers: number;
}

export interface HistoryWrites {
  record(key: string, point: Point, kept: Kept): boolean;
  keep(key: string, kept: Kept): boolean;
  counters(): Map<string, Kept>;
  setQuiet(why: QuietWhy, quiet: boolean, at: number): void;
  tally(at: number, tally: Tally): void;
  prune(keep: (key: string) => boolean): number;
}

export interface Switches {
  readonly monitor: boolean;
  readonly history: boolean;
}

export interface BoxHistoryDeps {
  readonly boxes: () => Promise<readonly HistoryBox[]>;
  readonly read: (box: HistoryBox, request: LightRequest, signal: AbortSignal) => Promise<LightReading>;
  readonly reach: HistoryReach;
  readonly store: HistoryWrites;
  readonly switches: () => Switches;
  readonly retained: () => Promise<(key: string) => boolean>;
  readonly log?: (message: string) => void;
  readonly now?: () => number;
  readonly setTimer?: (task: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

export function macKey(host: string): string {
  return `mac:${host}`;
}

export function secondOf(boxId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < boxId.length; index++) {
    hash ^= boxId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 60;
}

export function spreadSeconds(ids: readonly string[]): Map<string, number> {
  const order = [...ids].sort((left, right) => secondOf(left) - secondOf(right) || left.localeCompare(right));
  return new Map(order.map((id, index) => [id, Math.floor((index * 60) / Math.max(1, order.length))]));
}

export function workersFor(dueInAMinute: number, p90Ms: number): number {
  return Math.max(LEAST_WORKERS, Math.min(MOST_WORKERS, Math.ceil((dueInAMinute * p90Ms) / WORKERS_SPREAD_MS)));
}

function ninetieth(values: readonly number[]): number {
  if (!values.length) return FIRST_GUESS_MS;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)]!;
}

interface Due {
  readonly box: HistoryBox;
  readonly dueAt: number;
}

interface Counting {
  due: number;
  taken: number;
  skipped: number;
  failed: number;
  unanswered: number;
  readingMs: number;
  slowestMs: number;
  workers: number;
}

function counting(): Counting {
  return { due: 0, taken: 0, skipped: 0, failed: 0, unanswered: 0, readingMs: 0, slowestMs: 0, workers: 0 };
}

export interface HistoryStatus {
  readonly on: boolean;
  readonly boxes: number;
  readonly workers: number;
  readonly paused: readonly string[];
  readonly running: number;
  readonly queued: number;
}

export class BoxHistory {
  readonly #deps: BoxHistoryDeps;
  readonly #now: () => number;
  readonly #setTimer: (task: () => void, ms: number) => unknown;
  readonly #clearTimer: (timer: unknown) => void;
  #counters = new Map<string, Kept>();
  readonly #meters = new Map<string, OwnUsageMeter>();
  #boxes: readonly HistoryBox[] = [];
  readonly #queue: Due[] = [];
  readonly #busy = new Set<string>();
  readonly #lastDue = new Map<string, number>();
  #seconds = new Map<string, number>();
  readonly #failures = new Map<string, number>();
  readonly #pausedAt = new Map<string, number>();
  readonly #answeredWhilePaused = new Set<string>();
  readonly #macRead = new Map<string, number>();
  readonly #durations: number[] = [];
  readonly #runningSince = new Map<string, number>();
  #running = 0;
  #tally = counting();
  #minute = -1;
  #lastTick = 0;
  #timer: unknown = null;
  #started = false;
  #stopped = false;
  #turn: Promise<void> = Promise.resolve();
  #serving: Promise<void> | null = null;

  constructor(deps: BoxHistoryDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#setTimer =
      deps.setTimer ??
      ((task, ms) => {
        const timer = setTimeout(task, ms);
        timer.unref?.();
        return timer;
      });
    this.#clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  start(signal?: AbortSignal): Promise<void> {
    if (this.#started && !this.#stopped && this.#serving) return this.#serving;
    this.#started = true;
    this.#stopped = false;
    this.#counters = this.#deps.store.counters();
    const now = this.#now();
    this.#lastTick = now;
    this.#minute = Math.floor(now / MINUTE_MS);
    this.#sync(this.#deps.switches(), now);
    this.#turn = this.#refresh(now);
    this.#next();
    this.#serving = new Promise((resolve) => {
      if (!signal) return;
      const end = () => {
        this.stop();
        resolve();
      };
      if (signal.aborted) end();
      else signal.addEventListener("abort", end, { once: true });
    });
    return this.#serving;
  }

  stop(): void {
    this.#stopped = true;
    this.#serving = null;
    this.#clearTimer(this.#timer);
    this.#timer = null;
    for (const entry of this.#queue) this.#busy.delete(entry.box.id);
    this.#queue.length = 0;
  }

  configure(): void {
    const now = this.#now();
    const switches = this.#deps.switches();
    this.#sync(switches, now);
    if (!(switches.monitor && switches.history)) {
      this.#drop();
      return;
    }
    if (this.#started && !this.#boxes.length) this.#turn = this.#refresh(now);
  }

  settled(): Promise<void> {
    return this.#turn;
  }

  tick(): void {
    if (this.#stopped) return;
    const now = this.#now();
    const minute = Math.floor(now / MINUTE_MS);
    if (minute !== this.#minute) {
      const ended = this.#minute;
      this.#minute = minute;
      this.#flush(ended * MINUTE_MS);
      this.#turn = this.#refresh(now);
    }
    if (this.#reading()) {
      for (const box of this.#boxes) {
        const second = this.#seconds.get(box.id) ?? secondOf(box.id);
        for (const at of [minute - 1, minute]) {
          const dueAt = at * MINUTE_MS + second * 1000;
          if (dueAt <= this.#lastTick || dueAt > now || (this.#lastDue.get(box.id) ?? -Infinity) >= at) continue;
          this.#lastDue.set(box.id, at);
          this.#due(box, dueAt);
        }
      }
      this.#pump();
    }
    this.#lastTick = now;
  }

  status(): HistoryStatus {
    return { on: this.#reading(), boxes: this.#boxes.length, workers: this.#workers(), paused: [...this.#pausedAt.keys()], running: this.#running, queued: this.#queue.length };
  }

  #next(): void {
    if (this.#stopped) return;
    const now = this.#now();
    this.#timer = this.#setTimer(() => {
      this.tick();
      this.#next();
    }, 1000 - (now % 1000) + 5);
  }

  #reading(): boolean {
    const switches = this.#deps.switches();
    return switches.monitor && switches.history;
  }

  #sync(switches: Switches, at: number): void {
    this.#deps.store.setQuiet("monitor", !switches.monitor, at);
    this.#deps.store.setQuiet("history", !switches.history, at);
  }

  #drop(): void {
    this.#boxes = [];
    for (const entry of this.#queue) this.#busy.delete(entry.box.id);
    this.#queue.length = 0;
  }

  async #refresh(now: number): Promise<void> {
    const switches = this.#deps.switches();
    this.#sync(switches, now);
    if (!(switches.monitor && switches.history)) {
      this.#drop();
      return;
    }
    try {
      this.#boxes = await this.#deps.boxes();
      this.#seconds = spreadSeconds(this.#boxes.map((box) => box.id));
    } catch (error) {
      this.#deps.log?.(`Box history could not list the boxes to read: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const live = new Set(this.#boxes.map((box) => box.id));
    for (const id of this.#lastDue.keys()) if (!live.has(id)) this.#forget(id);
    try {
      const keep = await this.#deps.retained();
      this.#deps.store.prune(keep);
      for (const key of [...this.#counters.keys()]) if (!keep(key)) this.#counters.delete(key);
    } catch (error) {
      this.#deps.log?.(`Box history could not prune: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #forget(boxId: string): void {
    this.#lastDue.delete(boxId);
    this.#failures.delete(boxId);
    this.#pausedAt.delete(boxId);
    this.#answeredWhilePaused.delete(boxId);
    this.#meters.delete(boxId);
  }

  #flush(minuteAt: number): void {
    const tally = this.#tally;
    this.#tally = counting();
    if (tally.due + tally.unanswered + tally.taken + tally.failed === 0) return;
    this.#deps.store.tally(minuteAt, tally);
  }

  #paused(box: HistoryBox): boolean {
    const at = this.#pausedAt.get(box.id);
    if (at === undefined) return false;
    const answers = !this.#answeredWhilePaused.has(box.id);
    const answered = this.#deps.reach.lastAnswered(box.id);
    const alone = this.#now() - at > PAUSED_ALONE_MS && !this.#deps.reach.notAnswering(box.id);
    const foundAnswering = answers && answered !== null && answered > at;
    if (foundAnswering || alone) {
      this.#pausedAt.delete(box.id);
      this.#answeredWhilePaused.delete(box.id);
      this.#failures.delete(box.id);
      this.#deps.log?.(`Box history reads ${box.name} again: ${foundAnswering ? "the reach check found it answers" : `${PAUSED_ALONE_MS / 60_000} minutes have passed`}.`);
      return false;
    }
    return true;
  }

  #due(box: HistoryBox, dueAt: number): void {
    if (this.#paused(box) || this.#deps.reach.notAnswering(box.id)) {
      this.#tally.unanswered++;
      return;
    }
    this.#tally.due++;
    if (this.#busy.has(box.id)) {
      this.#tally.skipped++;
      return;
    }
    this.#busy.add(box.id);
    this.#queue.push({ box, dueAt });
  }

  #workers(): number {
    const now = this.#now();
    const elapsed = [...this.#runningSince.values()].map((since) => now - since);
    return workersFor(this.#boxes.length, ninetieth([...this.#durations, ...elapsed]));
  }

  #pump(): void {
    const target = this.#workers();
    this.#tally.workers = Math.max(this.#tally.workers, target);
    while (this.#running < target && this.#queue.length) {
      const entry = this.#queue.shift()!;
      if (this.#now() - entry.dueAt > START_LATE_MS) {
        this.#tally.skipped++;
        this.#busy.delete(entry.box.id);
        continue;
      }
      void this.#run(entry);
    }
  }

  #limited<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    return new Promise<T>((resolve, reject) => {
      const timer = this.#setTimer(() => {
        const error = new Error(`It did not answer within ${READING_TIMEOUT_MS / 1000} s.`);
        controller.abort(error);
        reject(error);
      }, READING_TIMEOUT_MS);
      work(controller.signal).then(
        (value) => {
          this.#clearTimer(timer);
          resolve(value);
        },
        (error: unknown) => {
          this.#clearTimer(timer);
          reject(error);
        },
      );
    });
  }

  async #run({ box, dueAt }: Due): Promise<void> {
    this.#running++;
    const started = this.#now();
    this.#runningSince.set(box.id, started);
    const minute = Math.floor(dueAt / MINUTE_MS);
    const readsMac = box.slot !== null && this.#macRead.get(box.slot.host) !== minute;
    if (box.slot && readsMac) this.#macRead.set(box.slot.host, minute);
    const request: LightRequest = { own: box.slot !== null, machine: box.slot === null || readsMac };
    let reading: LightReading | null = null;
    try {
      reading = await this.#limited((signal) => this.#deps.read(box, request, signal));
      this.#tally.taken++;
      this.#failures.delete(box.id);
    } catch (error) {
      this.#tally.failed++;
      if (box.slot && readsMac) this.#macRead.delete(box.slot.host);
      this.#failed(box, error);
    } finally {
      const took = this.#now() - started;
      this.#durations.push(took);
      if (this.#durations.length > DURATIONS_KEPT) this.#durations.splice(0, this.#durations.length - DURATIONS_KEPT);
      this.#tally.readingMs += took;
      this.#tally.slowestMs = Math.max(this.#tally.slowestMs, took);
      this.#running--;
      this.#runningSince.delete(box.id);
      this.#busy.delete(box.id);
    }
    if (reading && !this.#stopped && this.#reading()) {
      try {
        this.#take(box, request, { at: this.#now(), reading });
      } catch (error) {
        this.#deps.log?.(`Box history could not keep ${box.name}'s reading: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!this.#stopped && this.#reading()) this.#pump();
  }

  #failed(box: HistoryBox, error: unknown): void {
    const failures = (this.#failures.get(box.id) ?? 0) + 1;
    this.#failures.set(box.id, failures);
    if (failures < FAILURES_BEFORE_PAUSE || this.#pausedAt.has(box.id)) return;
    const words = error instanceof Error ? error.message : String(error);
    this.#pausedAt.set(box.id, this.#now());
    this.#deps.log?.(`Box history could not read ${box.name} ${failures} times in a row (${words}), so it reads it again only once the reach check finds it answers.`);
    void this.#deps.reach.check(box.id).then(
      (answers) => {
        if (!answers || !this.#pausedAt.has(box.id)) return;
        this.#answeredWhilePaused.add(box.id);
        this.#deps.log?.(`${box.name} answers the reach check, so box history waits ${PAUSED_ALONE_MS / 60_000} minutes before it reads it again.`);
      },
      () => undefined,
    );
  }

  #take(box: HistoryBox, request: LightRequest, current: Kept): void {
    const store = this.#deps.store;
    const kept: Kept = { at: current.at, reading: { ...current.reading, own: null } };
    const previous = this.#counters.get(box.id) ?? null;
    const why = baselineWhy(previous, kept, box.lastStartAt);
    if (!box.slot) {
      if (why || !previous) store.keep(box.id, kept);
      else store.record(box.id, machinePoint(previous, kept), kept);
      this.#counters.set(box.id, kept);
      return;
    }
    let meter = this.#meters.get(box.id);
    if (!meter) {
      meter = createOwnUsage();
      this.#meters.set(box.id, meter);
    }
    if (why) meter.reset();
    const own = current.reading.own ? meter.take(current.reading.own, current.at) : null;
    const share = shareOf(current.reading.visibleCores, current.reading.memoryTotalBytes ?? 0, box.slot.most);
    if (why || !previous || !own) store.keep(box.id, kept);
    else store.record(box.id, slotPoint(previous, kept, own, share), kept);
    this.#counters.set(box.id, kept);
    if (!request.machine) return;
    const key = macKey(box.slot.host);
    const before = this.#counters.get(key) ?? null;
    if (baselineWhy(before, kept, null) || !before) store.keep(key, kept);
    else store.record(key, machinePoint(before, kept), kept);
    this.#counters.set(key, kept);
  }
}
