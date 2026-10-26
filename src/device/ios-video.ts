import type { VideoSize } from "../core/device.ts";
import { NAL_TYPES, hasPicture, isKeyFrame, nalUnits, spsPictureSize } from "./annexb.ts";
import type { EncodedFrame, VideoSource } from "./driver.ts";
import { FrameFanout } from "./frame-fanout.ts";
import type { StreamOutput } from "./idb.ts";

export const STOP_GRACE_MS = 500;
export const RETRY_LEAST_MS = 100;
export const RETRY_MOST_MS = 2_000;

export interface IosVideoOptions {
  readonly open: (stopped: Promise<void>, signal: AbortSignal) => AsyncIterable<StreamOutput>;
  readonly recover: (error: unknown) => Promise<void>;
  readonly sized: (size: VideoSize) => number;
  readonly log: (line: string) => void;
  readonly monotonic?: () => number;
}

interface Stream {
  readonly end: (why: string) => void;
  readonly asked: () => boolean;
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

function words(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class IosVideo implements VideoSource {
  readonly #options: IosVideoOptions;
  readonly #monotonic: () => number;
  readonly #fanout: FrameFanout;
  #running: Promise<void> | null = null;
  #stopping = new AbortController();
  #stream: Stream | null = null;
  #lastKey: EncodedFrame | null = null;
  #deltaSinceKey = false;
  #size: VideoSize | null = null;
  #generation = 0;
  #parameterSets: Uint8Array | null = null;
  #framesSent = 0;
  #restarts = 0;

  constructor(options: IosVideoOptions) {
    this.#options = options;
    this.#monotonic = options.monotonic ?? (() => performance.now());
    this.#fanout = new FrameFanout({ onBehind: () => this.keyframe() });
  }

  get size(): VideoSize | null {
    return this.#size;
  }

  get framesSent(): number {
    return this.#framesSent;
  }

  get restarts(): number {
    return this.#restarts;
  }

  get running(): boolean {
    return this.#running !== null;
  }

  frames(signal: AbortSignal): AsyncIterable<EncodedFrame> {
    return this.#fanout.frames(signal);
  }

  keyframe(): void {
    if (this.#lastKey && !this.#deltaSinceKey) {
      this.#send({ ...this.#lastKey, monotonicMs: this.#monotonic() });
      return;
    }
    this.restart("a key frame was asked for");
  }

  restart(why: string): void {
    if (!this.#running) return;
    if (this.#stream && !this.#stream.asked()) this.#stream.end(why);
  }

  start(): void {
    if (this.#running) return;
    this.#stopping = new AbortController();
    this.#size = null;
    this.#lastKey = null;
    this.#parameterSets = null;
    this.#running = this.#loop(this.#stopping.signal).finally(() => (this.#running = null));
  }

  async stop(): Promise<void> {
    this.#stopping.abort();
    this.#stream?.end("the video stops");
    await this.#running;
    this.#lastKey = null;
  }

  async #loop(signal: AbortSignal): Promise<void> {
    let retry = 0;
    while (!signal.aborted) {
      let endRequests!: () => void;
      const stopped = new Promise<void>((resolve) => (endRequests = resolve));
      const call = new AbortController();
      let asked: string | null = null;
      const stream: Stream = {
        end: (why) => {
          asked = why;
          endRequests();
          setTimeout(() => call.abort(new Error(`idb_companion did not end its stream within ${STOP_GRACE_MS} ms of being asked`)), STOP_GRACE_MS).unref?.();
        },
        asked: () => asked !== null,
      };
      this.#stream = stream;
      let received = 0;
      try {
        for await (const output of this.#options.open(stopped, AbortSignal.any([signal, call.signal]))) {
          if (output.log) {
            this.#options.log(`video: idb_companion says: ${output.log}`);
            continue;
          }
          if (!output.data?.byteLength) continue;
          received++;
          retry = 0;
          this.#unit(output.data);
        }
        if (!asked && !signal.aborted) throw new Error(received ? "idb_companion ended the video stream" : "idb_companion ended the video stream before its first frame");
      } catch (error) {
        if (signal.aborted) break;
        if (!asked) {
          this.#options.log(`video: the stream failed (${words(error)}); starting it again`);
          await this.#options.recover(error).catch((cause) => this.#options.log(`video: recovering failed: ${words(cause)}`));
          retry = Math.min(RETRY_MOST_MS, Math.max(RETRY_LEAST_MS, retry * 2));
          await wait(retry, signal);
        }
      } finally {
        endRequests();
        this.#stream = null;
      }
      if (asked) this.#restarts++;
    }
  }

  #unit(data: Uint8Array): void {
    const units = nalUnits(data);
    if (!hasPicture(units)) {
      if (units.some((unit) => unit.type === NAL_TYPES.sps || unit.type === NAL_TYPES.pps)) this.#parameterSets = data;
      return;
    }
    let whole = data;
    if (this.#parameterSets) {
      whole = new Uint8Array(this.#parameterSets.byteLength + data.byteLength);
      whole.set(this.#parameterSets);
      whole.set(data, this.#parameterSets.byteLength);
      this.#parameterSets = null;
    }
    const all = whole === data ? units : nalUnits(whole);
    const key = isKeyFrame(all);
    if (key) {
      const sps = all.find((unit) => unit.type === NAL_TYPES.sps);
      const size = sps ? spsPictureSize(sps) : null;
      if (size && (!this.#size || size.width !== this.#size.width || size.height !== this.#size.height)) {
        this.#size = size;
        this.#generation = this.#options.sized(size);
      }
    }
    if (!this.#size) return;
    const frame: EncodedFrame = { data: whole, key, generation: this.#generation, monotonicMs: this.#monotonic(), width: this.#size.width, height: this.#size.height };
    if (key) {
      this.#lastKey = frame;
      this.#deltaSinceKey = false;
    } else this.#deltaSinceKey = true;
    this.#send(frame);
  }

  #send(frame: EncodedFrame): void {
    this.#framesSent++;
    this.#fanout.push(frame);
  }
}
