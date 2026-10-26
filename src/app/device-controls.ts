import type { DeviceAction, DeviceAnswer, DeviceControl } from "../core/device.ts";

export type DeviceAsk = { readonly kind: "control"; readonly control: DeviceControl } | { readonly kind: "open"; readonly url: string };

export type AskKey = DeviceAction | "open";

export const TAKE_WAIT_MS = 10_000;
export const MOST_QUEUED = 6;

const LATEST_WINS: ReadonlySet<AskKey> = new Set(["posture", "appearance", "text_size", "location", "status_bar", "battery", "network", "switch", "open"]);

export function keyOf(ask: DeviceAsk): AskKey {
  return ask.kind === "open" ? "open" : ask.control.action;
}

export interface DeviceControlsDeps {
  mine(): boolean;
  take(): Promise<string | null>;
  send(ask: DeviceAsk): Promise<DeviceAnswer>;
  answered(ask: DeviceAsk, answer: DeviceAnswer): void;
  changed(): void;
}

function refusal(words: string): DeviceAnswer {
  return { id: "", ok: false, error: { code: "person-has-control", words }, state: null };
}

export class DeviceControls {
  readonly #deps: DeviceControlsDeps;
  readonly #queue: DeviceAsk[] = [];
  #inFlight: DeviceAsk | null = null;
  #taking: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;

  constructor(deps: DeviceControlsDeps) {
    this.#deps = deps;
  }

  get busy(): AskKey | null {
    return this.#inFlight ? keyOf(this.#inFlight) : null;
  }

  get waiting(): readonly AskKey[] {
    return this.#queue.map(keyOf);
  }

  get taking(): boolean {
    return this.#taking !== null;
  }

  ask(ask: DeviceAsk): void {
    if (this.#disposed) return;
    const key = keyOf(ask);
    const same = LATEST_WINS.has(key) ? this.#queue.findIndex((queued) => keyOf(queued) === key) : -1;
    if (same >= 0) this.#queue.splice(same, 1, ask);
    else if (this.#queue.length < MOST_QUEUED) this.#queue.push(ask);
    this.#deps.changed();
    this.#pump();
  }

  mineChanged(): void {
    if (this.#deps.mine() && this.#taking !== null) {
      clearTimeout(this.#taking);
      this.#taking = null;
      this.#deps.changed();
    }
    this.#pump();
  }

  #pump(): void {
    if (this.#disposed || this.#inFlight || !this.#queue.length) return;
    if (!this.#deps.mine()) {
      this.#takeControl();
      return;
    }
    const next = this.#queue.shift()!;
    this.#inFlight = next;
    this.#deps.changed();
    void this.#deps.send(next).then((answer) => {
      if (this.#disposed) return;
      this.#inFlight = null;
      this.#deps.answered(next, answer);
      this.#deps.changed();
      this.#pump();
    });
  }

  #takeControl(): void {
    if (this.#taking !== null) return;
    this.#taking = setTimeout(() => this.#dropAll("Control did not come to this tab. Try Take control."), TAKE_WAIT_MS);
    this.#deps.changed();
    void this.#deps.take().then(
      (error) => {
        if (error !== null) this.#dropAll(error);
        else this.mineChanged();
      },
      (error: unknown) => this.#dropAll(error instanceof Error ? error.message : String(error)),
    );
  }

  #dropAll(words: string): void {
    if (this.#taking !== null) clearTimeout(this.#taking);
    this.#taking = null;
    const dropped = this.#queue.splice(0);
    if (this.#disposed) return;
    for (const ask of dropped.slice(0, 1)) this.#deps.answered(ask, refusal(words));
    this.#deps.changed();
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#taking !== null) clearTimeout(this.#taking);
    this.#queue.length = 0;
  }
}
