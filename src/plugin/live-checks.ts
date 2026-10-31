import type { Snapshotting } from "../backends/types.ts";

export const LIVE_CHECKS_VARIABLE = "BB_BOX_LIVE_CHECKS";
export const DROPPED_REPLY_MESSAGE = "BB Box saved this and dropped its reply, as a live check asked.";

export function liveChecksOn(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return environment[LIVE_CHECKS_VARIABLE] === "1";
}

export class ReplyDrops {
  #armed = 0;

  get armed(): number {
    return this.#armed;
  }

  arm(count: number): void {
    this.#armed = Math.max(0, Math.floor(count));
  }

  take(): boolean {
    if (this.#armed === 0) return false;
    this.#armed -= 1;
    return true;
  }
}

export const HOLD_STEPS = ["planned", "task", "stopped", "copied", "undo", "rolled-back", "adopted", "started"] as const;
export type HoldStepName = (typeof HOLD_STEPS)[number];

export const HOLD_WORDS: Readonly<Record<HoldStepName, string>> = {
  planned: "its record",
  task: "its provider's task began",
  stopped: "a restore's stop",
  copied: "a restore's held copy was cloned, before it is a template",
  undo: "a restore's undo",
  "rolled-back": "a restore's rollback",
  adopted: "a swap's new guest was made, before the swap",
  started: "a restored box's start",
};

export class SnapshotHolds {
  #armed: HoldStepName | null = null;

  get armed(): HoldStepName | null {
    return this.#armed;
  }

  arm(step: HoldStepName | null): void {
    this.#armed = step;
  }

  async hold(operation: { readonly id: string; readonly kind: string }, step: HoldStepName, signal: AbortSignal, log: (message: string) => void): Promise<void> {
    if (this.#armed !== step) return;
    this.#armed = null;
    log(`Holding snapshot operation ${operation.id} (${operation.kind}) after ${HOLD_WORDS[step]}, as a live check asked, until bb-box stops.`);
    await new Promise<never>((_, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
}

export class FakeSnapshotPrices {
  readonly #daily = new Map<string, number>();

  set(backend: string, daily: number | null): void {
    if (daily === null) this.#daily.delete(backend);
    else this.#daily.set(backend, daily);
  }

  priced(backend: { readonly id: string }, offer: Snapshotting): Snapshotting {
    const daily = this.#daily.get(backend.id);
    return daily === undefined ? offer : { ...offer, price: { amount: daily, currency: "USD", per: "day", known: true } };
  }
}
