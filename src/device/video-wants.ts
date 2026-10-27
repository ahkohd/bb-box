import { largerStep, smallerStep, type VideoStep, type VideoWant, type WantFor } from "../core/device.ts";

export const STEP_HOLD_MS = 1_000;
export const STREAM_LINGER_MS = 10_000;

export interface VideoWantsOptions {
  readonly apply: (step: VideoStep | null, wants: readonly string[]) => void;
  readonly changed?: () => void;
  readonly holdMs?: number;
  readonly lingerMs?: number;
}

type Timer = ReturnType<typeof setTimeout>;

export class VideoWants {
  readonly #options: VideoWantsOptions;
  readonly #wants = new Map<string, VideoWant>();
  #cap: VideoStep | null = null;
  #applied: VideoStep | null = null;
  #hold: { readonly step: VideoStep; readonly timer: Timer } | null = null;
  #linger: Timer | null = null;

  constructor(options: VideoWantsOptions) {
    this.#options = options;
  }

  get applied(): VideoStep | null {
    return this.#applied;
  }

  get cap(): VideoStep | null {
    return this.#cap;
  }

  get wanted(): VideoStep | null {
    let most: VideoStep | null = null;
    for (const { step } of this.#wants.values()) most = most ? largerStep(most, step) : step;
    return most && this.#cap ? smallerStep(most, this.#cap) : most;
  }

  wants(): readonly string[] {
    return [...this.#wants].map(([who, want]) => `${who} at ${want.step}`);
  }

  get reported(): readonly VideoWant[] {
    return [...this.#wants.values()];
  }

  set(who: string, step: VideoStep | null, kind: WantFor = "wait"): void {
    const now = this.#wants.get(who);
    if (step === null ? !this.#wants.delete(who) : now?.step === step && now.for === kind) return;
    if (step !== null) this.#wants.set(who, { for: kind, step });
    this.#update();
    this.#options.changed?.();
  }

  capAt(most: VideoStep | null): void {
    if (most === this.#cap) return;
    this.#cap = most;
    this.#update();
    this.#options.changed?.();
  }

  close(): void {
    this.#endHold();
    this.#endLinger();
  }

  #apply(step: VideoStep | null): void {
    this.#applied = step;
    this.#options.apply(step, this.wants());
    this.#options.changed?.();
  }

  #update(): void {
    const wanted = this.wanted;
    if (wanted === null) {
      this.#endHold();
      if (this.#applied !== null && !this.#linger) {
        this.#linger = setTimeout(() => {
          this.#linger = null;
          if (this.wanted === null) this.#apply(null);
        }, this.#options.lingerMs ?? STREAM_LINGER_MS);
        this.#linger.unref?.();
      }
      return;
    }
    this.#endLinger();
    if (this.#applied === null) {
      this.#endHold();
      this.#apply(wanted);
      return;
    }
    if (wanted === this.#applied) {
      this.#endHold();
      return;
    }
    if (this.#hold?.step === wanted) return;
    this.#endHold();
    const timer = setTimeout(() => {
      this.#hold = null;
      const now = this.wanted;
      if (now !== null && now !== this.#applied) this.#apply(now);
    }, this.#options.holdMs ?? STEP_HOLD_MS);
    timer.unref?.();
    this.#hold = { step: wanted, timer };
  }

  #endHold(): void {
    if (this.#hold) clearTimeout(this.#hold.timer);
    this.#hold = null;
  }

  #endLinger(): void {
    if (this.#linger) clearTimeout(this.#linger);
    this.#linger = null;
  }
}
