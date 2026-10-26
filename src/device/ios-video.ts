import type { VideoSize } from "../core/device.ts";
import { NAL_TYPES, hasPicture, isKeyFrame, nalUnits, spsPictureSize } from "./annexb.ts";
import type { EncodedFrame, VideoSource } from "./driver.ts";
import { FrameFanout } from "./frame-fanout.ts";
import type { StreamOutput } from "./idb.ts";

export const STOP_GRACE_MS = 500;
export const RETRY_LEAST_MS = 100;
export const RETRY_MOST_MS = 2_000;
export const SIDEWAYS_FIRST_KEY_WAIT_MS = 150;
export const REGENERATED_FRAME_WAIT_MS = 100;

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
  pictures: number;
}

interface Picture {
  readonly data: Uint8Array;
  readonly key: boolean;
  readonly size: VideoSize | null;
}

function uprightShaped(size: VideoSize): boolean {
  return size.height > size.width;
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
  #heldFirst: { readonly picture: Picture; readonly timer: ReturnType<typeof setTimeout> } | null = null;
  #sidewaysFirstKeysDropped = 0;
  #regenerated: ReturnType<typeof setTimeout> | undefined;

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

  get sidewaysFirstKeysDropped(): number {
    return this.#sidewaysFirstKeysDropped;
  }

  get generation(): number {
    return this.#generation;
  }

  regenerate(generation: number): void {
    this.#generation = generation;
    clearTimeout(this.#regenerated);
    if (this.#lastKey && !this.#deltaSinceKey) {
      this.keyframe();
      return;
    }
    const sent = this.#framesSent;
    this.#regenerated = setTimeout(() => {
      if (this.#framesSent === sent) this.keyframe();
    }, REGENERATED_FRAME_WAIT_MS);
    this.#regenerated.unref?.();
  }

  get running(): boolean {
    return this.#running !== null;
  }

  frames(signal: AbortSignal): AsyncIterable<EncodedFrame> {
    return this.#fanout.frames(signal);
  }

  keyframe(): void {
    if (this.#lastKey && !this.#deltaSinceKey) {
      this.#lastKey = { ...this.#lastKey, generation: this.#generation };
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
    clearTimeout(this.#regenerated);
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
        pictures: 0,
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
          this.#unit(output.data, stream);
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
        if (signal.aborted) this.#forgetHeldFirst();
        else this.#releaseHeldFirst();
      }
      if (asked) this.#restarts++;
    }
  }

  #unit(data: Uint8Array, stream: Stream): void {
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
    const sps = key ? all.find((unit) => unit.type === NAL_TYPES.sps) : undefined;
    const picture: Picture = { data: whole, key, size: sps ? spsPictureSize(sps) : null };
    const first = stream.pictures++ === 0;
    const held = this.#heldFirst;
    if (held) {
      clearTimeout(held.timer);
      this.#heldFirst = null;
      if (picture.key && picture.size && !uprightShaped(picture.size)) {
        this.#sidewaysFirstKeysDropped++;
        this.#options.log(`video: dropped a new stream's first key frame, ${held.picture.size!.width}x${held.picture.size!.height} with the picture on its side, as ${picture.size.width}x${picture.size.height} followed it`);
      } else this.#accept(held.picture);
    }
    if (first && this.#mayBeOnItsSide(picture)) {
      this.#heldFirst = { picture, timer: setTimeout(() => this.#releaseHeldFirst(), SIDEWAYS_FIRST_KEY_WAIT_MS) };
      return;
    }
    this.#accept(picture);
  }

  #mayBeOnItsSide(picture: Picture): boolean {
    if (!picture.key || !picture.size || !uprightShaped(picture.size)) return false;
    return !this.#size || !uprightShaped(this.#size);
  }

  #forgetHeldFirst(): void {
    if (this.#heldFirst) clearTimeout(this.#heldFirst.timer);
    this.#heldFirst = null;
  }

  #releaseHeldFirst(): void {
    const held = this.#heldFirst;
    if (!held) return;
    clearTimeout(held.timer);
    this.#heldFirst = null;
    this.#accept(held.picture);
  }

  #accept(picture: Picture): void {
    const { size } = picture;
    if (size && (!this.#size || size.width !== this.#size.width || size.height !== this.#size.height)) {
      this.#size = size;
      this.#generation = this.#options.sized(size);
    }
    if (!this.#size) return;
    const frame: EncodedFrame = { data: picture.data, key: picture.key, generation: this.#generation, monotonicMs: this.#monotonic(), width: this.#size.width, height: this.#size.height };
    if (picture.key) {
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
