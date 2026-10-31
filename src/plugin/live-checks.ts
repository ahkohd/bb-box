import type { Snapshotting } from "../backends/types.ts";
import { MACHINE_RESTORES_SHIP } from "../core/snapshot.ts";

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

export const HOLD_STEPS = ["planned", "task", "checked", "stopped", "copied", "undo", "rolled-back", "adopted", "started", "forked"] as const;
export type HoldStepName = (typeof HOLD_STEPS)[number];

export const HOLD_WORDS: Readonly<Record<HoldStepName, string>> = {
  planned: "its record",
  task: "its provider's task began",
  checked: "a restore's last check for running turns, before its stop",
  stopped: "a restore's stop",
  copied: "a restore's held copy was cloned, before it is a template",
  undo: "a restore's undo",
  "rolled-back": "a restore's rollback",
  adopted: "a swap's new guest was made, before the swap",
  started: "a restored box's start",
  forked: "a fork's copy was made and re-armed, before its first start",
};

export class SnapshotHolds {
  #armed: HoldStepName | null = null;
  #forMs: number | null = null;

  get armed(): HoldStepName | null {
    return this.#armed;
  }

  arm(step: HoldStepName | null, forMs: number | null = null): void {
    this.#armed = step;
    this.#forMs = step ? forMs : null;
  }

  async hold(operation: { readonly id: string; readonly kind: string }, step: HoldStepName, signal: AbortSignal, log: (message: string) => void): Promise<void> {
    if (this.#armed !== step) return;
    const forMs = this.#forMs;
    this.#armed = null;
    this.#forMs = null;
    log(`Holding snapshot operation ${operation.id} (${operation.kind}) after ${HOLD_WORDS[step]}, as a live check asked, ${forMs === null ? "until bb-box stops" : `for ${forMs / 1000} s`}.`);
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const timer = forMs === null ? null : setTimeout(resolve, forMs);
      signal.addEventListener(
        "abort",
        () => {
          if (timer) clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
    if (forMs !== null) log(`Snapshot operation ${operation.id} goes on after its hold of ${forMs / 1000} s.`);
  }
}

export class MachineRestores {
  #on = MACHINE_RESTORES_SHIP;

  get on(): boolean {
    return this.#on;
  }

  set(on: boolean): void {
    this.#on = on;
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

export class ZfsOrder {
  readonly #backends = new Set<string>();

  set(backend: string, on: boolean): void {
    if (on) this.#backends.add(backend);
    else this.#backends.delete(backend);
  }

  has(backend: string): boolean {
    return this.#backends.has(backend);
  }
}
