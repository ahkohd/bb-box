import type { BoxRecord } from "./boxes.ts";

export const REACH_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;
export const REACH_ATTEMPT_MS = 10_000;
export const POWER_CHECK_GAP_MS = 60_000;

export type Reach =
  | { readonly is: "answers"; readonly lastAnswered: number | null }
  | {
      readonly is: "not-answering";
      readonly since: number;
      readonly lastAnswered: number | null;
      readonly nextCheckAt: number | null;
      readonly checking: boolean;
      readonly attempts: number;
      readonly error: string;
      readonly host: string | null;
    };

export interface ReachDeps {
  readonly find: (boxId: string) => Promise<BoxRecord | null>;
  readonly attempt: (box: BoxRecord, signal: AbortSignal) => Promise<string | null>;
  readonly checkable: (box: BoxRecord) => boolean;
  readonly changed: (box: BoxRecord) => void;
  readonly log: (message: string) => void;
  readonly now?: () => number;
  readonly setTimer?: (task: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

interface Unanswered {
  readonly since: number;
  error: string;
  attempts: number;
  nextAt: number | null;
  timer: unknown;
  checking: Promise<void> | null;
  host: string | null;
  name: string;
  thread: string;
}

function delayAfter(attempts: number): number {
  return REACH_DELAYS_MS[Math.min(attempts, REACH_DELAYS_MS.length - 1)]!;
}

function boxWords(box: Pick<BoxRecord, "name" | "threadId">): string {
  return `box ${box.name} of thread ${box.threadId}`;
}

export class ReachCheck {
  readonly #deps: ReachDeps;
  readonly #now: () => number;
  readonly #setTimer: (task: () => void, ms: number) => unknown;
  readonly #clearTimer: (timer: unknown) => void;
  readonly #unanswered = new Map<string, Unanswered>();
  readonly #lastAnswered = new Map<string, number>();
  #disposed = false;

  constructor(deps: ReachDeps) {
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

  notAnswering(boxId: string): boolean {
    return this.#unanswered.has(boxId);
  }

  reach(box: Pick<BoxRecord, "id">): Reach {
    const lastAnswered = this.#lastAnswered.get(box.id) ?? null;
    const known = this.#unanswered.get(box.id);
    if (!known) return { is: "answers", lastAnswered };
    return { is: "not-answering", since: known.since, lastAnswered, nextCheckAt: known.nextAt, checking: known.checking !== null, attempts: known.attempts, error: known.error, host: known.host };
  }

  answered(box: BoxRecord): void {
    this.#lastAnswered.set(box.id, this.#now());
    const known = this.#unanswered.get(box.id);
    if (known) this.#cleared(box.id, known, "it answered a command", box);
  }

  failed(box: BoxRecord, error: string): void {
    if (this.#disposed || !this.#deps.checkable(box)) return;
    const known = this.#unanswered.get(box.id);
    if (known) {
      known.error = error;
      return;
    }
    this.#track(box, error, 0);
  }

  #track(box: BoxRecord, error: string, attempts: number): void {
    const entry: Unanswered = { since: this.#now(), error, attempts, nextAt: null, timer: null, checking: null, host: box.guest?.host ?? null, name: box.name, thread: box.threadId };
    this.#unanswered.set(box.id, entry);
    this.#deps.log(`${attempts ? `Check ${attempts} of ` : ""}${boxWords(box)}: it does not answer: ${error} bb-box checks again in ${delayAfter(attempts) / 60_000} min.`);
    this.#schedule(box.id, entry);
    this.#deps.changed(box);
  }

  async checkNow(box: BoxRecord): Promise<Reach> {
    if (this.#disposed || !this.#deps.checkable(box)) return this.reach(box);
    const known = this.#unanswered.get(box.id);
    if (!known) {
      const error = await this.#try(box);
      if (this.#disposed) return this.reach(box);
      if (error === null) this.#lastAnswered.set(box.id, this.#now());
      else if (!this.#unanswered.has(box.id)) this.#track(box, error, 1);
      return this.reach(box);
    }
    await this.#attempt(box.id, known);
    return this.reach(box);
  }

  forget(boxId: string): void {
    const known = this.#unanswered.get(boxId);
    if (known) this.#clearTimer(known.timer);
    this.#unanswered.delete(boxId);
    this.#lastAnswered.delete(boxId);
  }

  dispose(): void {
    this.#disposed = true;
    for (const known of this.#unanswered.values()) this.#clearTimer(known.timer);
    this.#unanswered.clear();
  }

  #schedule(boxId: string, known: Unanswered): void {
    this.#clearTimer(known.timer);
    const delay = delayAfter(known.attempts);
    known.nextAt = this.#now() + delay;
    known.timer = this.#setTimer(() => void this.#attempt(boxId, known), delay);
  }

  async #try(box: BoxRecord): Promise<string | null> {
    const signal = AbortSignal.timeout(REACH_ATTEMPT_MS);
    try {
      return await this.#deps.attempt(box, signal);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  #attempt(boxId: string, known: Unanswered): Promise<void> {
    if (known.checking) return known.checking;
    this.#clearTimer(known.timer);
    known.timer = null;
    known.nextAt = null;
    const run = (async () => {
      const box = await this.#deps.find(boxId).catch(() => null);
      if (this.#unanswered.get(boxId) !== known || this.#disposed) return;
      if (!box || box.state !== "ready" || !this.#deps.checkable(box)) {
        this.#cleared(boxId, known, box ? `it is ${box.state} now` : "it is gone");
        return;
      }
      known.attempts++;
      const error = await this.#try(box);
      if (this.#unanswered.get(boxId) !== known || this.#disposed) return;
      if (error === null) {
        this.#lastAnswered.set(boxId, this.#now());
        this.#cleared(boxId, known, `it answered check ${known.attempts}`, box);
        return;
      }
      known.error = error;
      this.#schedule(boxId, known);
      this.#deps.log(`Check ${known.attempts} of ${boxWords(box)}: it does not answer: ${error} bb-box checks again in ${delayAfter(known.attempts) / 60_000} min.`);
      this.#deps.changed(box);
    })().finally(() => {
      known.checking = null;
    });
    known.checking = run;
    return run;
  }

  #cleared(boxId: string, known: Unanswered, why: string, box?: BoxRecord): void {
    this.#clearTimer(known.timer);
    this.#unanswered.delete(boxId);
    this.#deps.log(`${boxWords({ name: known.name, threadId: known.thread })} answers again, or no longer needs checking: ${why}.`);
    if (box) this.#deps.changed(box);
  }
}
