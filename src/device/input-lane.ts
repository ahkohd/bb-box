export const TEXT_BATCH = { quietMs: 500, most: 2000 } as const;

export type InputWork = (signal: AbortSignal) => Promise<void>;

export interface InputLaneOptions {
  readonly paste: (text: string, signal: AbortSignal) => Promise<void>;
  readonly failed: (error: unknown) => void;
  readonly quietMs?: number;
  readonly most?: number;
}

export function characterCount(text: string): number {
  return [...text].length;
}

export function splitByCharacters(text: string, most: number): string[] {
  const characters = [...text];
  const parts: string[] = [];
  for (let at = 0; at < characters.length; at += most) parts.push(characters.slice(at, at + most).join(""));
  return parts;
}

export class InputLane {
  readonly #options: InputLaneOptions;
  #chain: Promise<void> = Promise.resolve();
  #control = new AbortController();
  #pending = "";
  #quiet: ReturnType<typeof setTimeout> | null = null;
  #queued = 0;

  constructor(options: InputLaneOptions) {
    this.#options = options;
  }

  get busy(): boolean {
    return this.#queued > 0 || this.#pending !== "";
  }

  run(work: InputWork): Promise<void> {
    this.#sendPending();
    return this.#enqueue(work);
  }

  text(characters: string): void {
    this.#pending += characters;
    if (this.#quiet) clearTimeout(this.#quiet);
    if (characterCount(this.#pending) >= (this.#options.most ?? TEXT_BATCH.most)) {
      this.#sendPending();
      return;
    }
    this.#quiet = setTimeout(() => this.#sendPending(), this.#options.quietMs ?? TEXT_BATCH.quietMs);
  }

  async settled(): Promise<void> {
    this.#sendPending();
    await this.#chain;
  }

  cancel(reason: Error): void {
    this.#control.abort(reason);
    this.#control = new AbortController();
    this.#pending = "";
    if (this.#quiet) clearTimeout(this.#quiet);
    this.#quiet = null;
  }

  #sendPending(): void {
    if (this.#quiet) clearTimeout(this.#quiet);
    this.#quiet = null;
    if (!this.#pending) return;
    const text = this.#pending;
    this.#pending = "";
    for (const part of splitByCharacters(text, this.#options.most ?? TEXT_BATCH.most)) this.#enqueue((signal) => this.#options.paste(part, signal)).catch(this.#options.failed);
  }

  #enqueue(work: InputWork): Promise<void> {
    const signal = this.#control.signal;
    this.#queued++;
    const run = this.#chain.then(() => {
      signal.throwIfAborted();
      return work(signal);
    });
    const done = run.finally(() => this.#queued--);
    this.#chain = done.catch(() => undefined);
    return done;
  }
}
