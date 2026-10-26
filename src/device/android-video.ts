import type { VideoSize } from "../core/device.ts";
import type { EncodedFrame, VideoSource } from "./driver.ts";
import { FrameFanout } from "./frame-fanout.ts";
import type { H264Encoder } from "./h264-encoder.ts";

export const RETRY_LEAST_MS = 100;
export const RETRY_MOST_MS = 2_000;

export interface ScreenFrame {
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
}

export interface AndroidVideoOptions {
  readonly open: (signal: AbortSignal) => AsyncIterable<ScreenFrame>;
  readonly encoder: () => H264Encoder;
  readonly sized: (size: VideoSize, rotation: number) => number;
  readonly recover: (error: unknown) => Promise<void>;
  readonly log: (line: string) => void;
}

interface Shown {
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
  readonly generation: number;
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

function words(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AndroidVideo implements VideoSource {
  readonly #options: AndroidVideoOptions;
  readonly #fanout: FrameFanout;
  #stopping = new AbortController();
  #running: Promise<void> | null = null;
  #encoder: H264Encoder | null = null;
  #encoding: Promise<void> | null = null;
  #shown: Shown | null = null;
  #framesSent = 0;
  #framesReceived = 0;
  #encoderRestarts = 0;
  #streamRestarts = 0;
  #encoderWords: string | null = null;
  #stream: AbortController | null = null;

  constructor(options: AndroidVideoOptions) {
    this.#options = options;
    this.#fanout = new FrameFanout({ onBehind: () => this.keyframe() });
  }

  get size(): VideoSize | null {
    return this.#shown ? { width: this.#shown.width, height: this.#shown.height } : null;
  }

  get rotation(): number | null {
    return this.#shown?.rotation ?? null;
  }

  get running(): boolean {
    return this.#running !== null;
  }

  get framesSent(): number {
    return this.#framesSent;
  }

  get framesReceived(): number {
    return this.#framesReceived;
  }

  get encoderRestarts(): number {
    return this.#encoderRestarts;
  }

  get streamRestarts(): number {
    return this.#streamRestarts;
  }

  get encoderPid(): number | undefined {
    return this.#encoder?.pid;
  }

  get encoderWords(): string | null {
    return this.#encoderWords;
  }

  frames(signal: AbortSignal): AsyncIterable<EncodedFrame> {
    return this.#fanout.frames(signal);
  }

  keyframe(): void {
    this.#encoder?.keyframe();
  }

  start(): void {
    if (this.#running) return;
    this.#stopping = new AbortController();
    this.#shown = null;
    this.#ensureEncoder();
    this.#running = this.#loop(this.#stopping.signal).finally(() => (this.#running = null));
  }

  restart(why: string): void {
    if (!this.#running) return;
    this.#options.log(`video: the stream starts again, as ${why}`);
    this.#stream?.abort(new Error(why));
  }

  async stop(): Promise<void> {
    this.#stopping.abort();
    this.#stream?.abort();
    await this.#running;
    const encoder = this.#encoder;
    this.#encoder = null;
    await encoder?.stop();
    await this.#encoding;
  }

  #ensureEncoder(): H264Encoder {
    if (this.#encoder) return this.#encoder;
    const encoder = this.#options.encoder();
    this.#encoder = encoder;
    void encoder.description.then((said) => {
      if (this.#encoderWords !== said) this.#options.log(`video: bb-box-h264 encodes with ${said}`);
      this.#encoderWords = said;
    });
    this.#encoding = this.#drain(encoder);
    return encoder;
  }

  async #drain(encoder: H264Encoder): Promise<void> {
    let failure: unknown = null;
    try {
      for await (const unit of encoder.frames()) {
        if (encoder !== this.#encoder) continue;
        this.#framesSent++;
        const frame: EncodedFrame = { data: unit.data, key: unit.key, generation: unit.generation, monotonicMs: unit.monotonicMs, width: unit.width, height: unit.height };
        this.#fanout.push(frame);
      }
    } catch (error) {
      failure = error;
    }
    if (encoder !== this.#encoder || this.#stopping.signal.aborted) return;
    this.#encoder = null;
    this.#encoderRestarts++;
    this.#options.log(`video: bb-box-h264 stopped (${failure ? words(failure) : "it ended"}); starting it again`);
    const fresh = this.#ensureEncoder();
    if (this.#shown) fresh.submitShared(this.#shown);
  }

  async #loop(signal: AbortSignal): Promise<void> {
    let retry = 0;
    while (!signal.aborted) {
      const stream = new AbortController();
      this.#stream = stream;
      let received = 0;
      try {
        for await (const screen of this.#options.open(AbortSignal.any([signal, stream.signal]))) {
          received++;
          retry = 0;
          this.#screen(screen);
        }
        if (!signal.aborted && !stream.signal.aborted) throw new Error(received ? "the emulator ended the screen stream" : "the emulator ended the screen stream before its first frame");
      } catch (error) {
        if (signal.aborted) break;
        if (stream.signal.aborted) {
          this.#streamRestarts++;
          continue;
        }
        this.#options.log(`video: the screen stream failed (${words(error)}); starting it again`);
        await this.#options.recover(error).catch((cause) => this.#options.log(`video: recovering failed: ${words(cause)}`));
        retry = Math.min(RETRY_MOST_MS, Math.max(RETRY_LEAST_MS, retry * 2));
        this.#streamRestarts++;
        await wait(retry, signal);
      } finally {
        this.#stream = null;
      }
    }
  }

  #screen(screen: ScreenFrame): void {
    if (!screen.width || !screen.height) return;
    this.#framesReceived++;
    const shown = this.#shown;
    const changed = !shown || shown.width !== screen.width || shown.height !== screen.height || shown.rotation !== screen.rotation;
    this.#shown = { width: screen.width, height: screen.height, rotation: screen.rotation, generation: shown?.generation ?? 0 };
    if (changed) this.#shown = { ...this.#shown, generation: this.#options.sized({ width: screen.width, height: screen.height }, screen.rotation) };
    this.#ensureEncoder().submitShared(this.#shown);
  }
}
