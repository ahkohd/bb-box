import type { EncodedFrame } from "./driver.ts";

export const QUEUED_FRAMES_MOST = 120;

interface Reader {
  readonly queue: EncodedFrame[];
  waitsForKey: boolean;
  wake: (() => void) | null;
}

export class FrameFanout {
  readonly #readers = new Set<Reader>();
  readonly #mostQueued: number;
  readonly #onBehind: () => void;

  constructor(options: { readonly mostQueued?: number; readonly onBehind?: () => void } = {}) {
    this.#mostQueued = options.mostQueued ?? QUEUED_FRAMES_MOST;
    this.#onBehind = options.onBehind ?? (() => undefined);
  }

  get readers(): number {
    return this.#readers.size;
  }

  push(frame: EncodedFrame): void {
    let behind = false;
    for (const reader of this.#readers) {
      if (reader.queue.length >= this.#mostQueued) {
        reader.queue.length = 0;
        reader.waitsForKey = true;
        behind = true;
      }
      if (reader.waitsForKey && !frame.key) continue;
      reader.waitsForKey = false;
      reader.queue.push(frame);
      reader.wake?.();
    }
    if (behind) this.#onBehind();
  }

  async *frames(signal: AbortSignal): AsyncIterable<EncodedFrame> {
    const reader: Reader = { queue: [], waitsForKey: false, wake: null };
    this.#readers.add(reader);
    try {
      while (!signal.aborted) {
        const next = reader.queue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          const done = () => {
            reader.wake = null;
            signal.removeEventListener("abort", done);
            resolve();
          };
          reader.wake = done;
          signal.addEventListener("abort", done, { once: true });
        });
      }
    } finally {
      this.#readers.delete(reader);
    }
  }
}
