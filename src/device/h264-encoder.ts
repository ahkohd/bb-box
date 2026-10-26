import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { performance } from "node:perf_hooks";

export type H264EncoderName = "x264" | "openh264";

export interface EncodedFrame {
  readonly data: Uint8Array;
  readonly key: boolean;
  readonly generation: number;
  readonly monotonicMs: number;
  readonly width: number;
  readonly height: number;
  readonly again?: boolean;
}

export interface EncodedUnit {
  readonly data: Uint8Array;
  readonly key: boolean;
  readonly width: number;
  readonly height: number;
  readonly encodeMicros: number;
}

export interface RawFrame {
  readonly width: number;
  readonly height: number;
  readonly rgb: Uint8Array;
  readonly generation: number;
}

export interface SharedFrame {
  readonly width: number;
  readonly height: number;
  readonly generation: number;
}

export interface H264EncoderOptions {
  readonly helper: string;
  readonly encoder?: H264EncoderName;
  readonly openh264Library?: string;
  readonly bitrateKbps?: number;
  readonly framesPerSecond?: number;
  readonly threads?: number;
  readonly sharedMemory?: string;
  readonly onEncoded?: (unit: EncodedUnit) => void;
}

export const UNIT_HEADER_BYTES = 17;
const KEY_FLAG = 1;

export class UnitReader {
  #chunks: Buffer[] = [];
  #buffered = 0;
  #header: Omit<EncodedUnit, "data"> & { readonly length: number } | null = null;

  push(chunk: Buffer): EncodedUnit[] {
    this.#chunks.push(chunk);
    this.#buffered += chunk.length;
    const units: EncodedUnit[] = [];
    for (;;) {
      if (!this.#header) {
        if (this.#buffered < UNIT_HEADER_BYTES) break;
        const head = this.#take(UNIT_HEADER_BYTES);
        this.#header = {
          length: head.readUInt32LE(0),
          key: (head[4]! & KEY_FLAG) !== 0,
          width: head.readUInt32LE(5),
          height: head.readUInt32LE(9),
          encodeMicros: head.readUInt32LE(13),
        };
      }
      if (this.#buffered < this.#header.length) break;
      const { length, ...unit } = this.#header;
      units.push({ ...unit, data: this.#take(length) });
      this.#header = null;
    }
    return units;
  }

  get partial(): boolean {
    return this.#header !== null || this.#buffered > 0;
  }

  #take(size: number): Buffer {
    if (size === 0) return Buffer.alloc(0);
    let first = this.#chunks[0]!;
    if (first.length < size) {
      let joined = 0;
      let count = 0;
      while (joined < size) joined += this.#chunks[count++]!.length;
      first = Buffer.concat(this.#chunks.splice(0, count));
      this.#chunks.unshift(first);
    }
    const taken = first.subarray(0, size);
    if (first.length === size) this.#chunks.shift();
    else this.#chunks[0] = first.subarray(size);
    this.#buffered -= size;
    return taken;
  }
}

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function frameCommand(letter: "F" | "S", width: number, height: number): Buffer {
  const command = Buffer.alloc(9);
  command.write(letter, 0, "latin1");
  command.writeUInt32LE(width, 1);
  command.writeUInt32LE(height, 5);
  return command;
}

type Waiting = { readonly frame: RawFrame; readonly at: number } | { readonly shared: SharedFrame; readonly at: number };

interface InFlight {
  readonly generation: number;
  readonly at: number;
  readonly again?: boolean;
}

export class H264EncoderStopped extends Error {}

export class H264Encoder {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #reader = new UnitReader();
  readonly #onEncoded: ((unit: EncodedUnit) => void) | undefined;
  readonly #shared: boolean;
  #waiting: Waiting | null = null;
  #keyWanted = false;
  #inFlight: InFlight | null = null;
  #lastGeneration = 0;
  #lastAt = 0;
  #encoded: EncodedFrame[] = [];
  #wake: (() => void) | null = null;
  #ended: Error | null = null;
  #closed = false;
  #stderr = "";
  readonly description: Promise<string>;

  constructor(options: H264EncoderOptions) {
    const args = [
      ...(options.encoder ? ["--encoder", options.encoder] : []),
      ...(options.openh264Library ? ["--openh264", options.openh264Library] : []),
      ...(options.bitrateKbps ? ["--bitrate", String(options.bitrateKbps)] : []),
      ...(options.framesPerSecond ? ["--fps", String(options.framesPerSecond)] : []),
      ...(options.threads ? ["--threads", String(options.threads)] : []),
    ];
    this.#onEncoded = options.onEncoded;
    this.#shared = options.sharedMemory !== undefined;
    this.#child = spawn(options.helper, args, { stdio: ["pipe", "pipe", "pipe"] });
    let described: (words: string) => void = () => {};
    this.description = new Promise((resolve) => (described = resolve));
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (text: string) => {
      this.#stderr = (this.#stderr + text).slice(-4096);
      const firstLine = this.#stderr.match(/^bb-box-h264: (.+), \d+ kbit\/s/m);
      if (firstLine) described(firstLine[1]!);
    });
    this.#child.stdout.on("data", (chunk: Buffer) => this.#received(chunk));
    this.#child.stdin.on("error", () => {});
    this.#child.on("error", (error) => this.#end(new H264EncoderStopped(`bb-box-h264 did not start: ${error.message}`)));
    this.#child.on("close", (code, signal) => {
      const words = this.#stderr.trim().split("\n").filter((line) => !/kbit\/s, \d+ threads?$/.test(line)).pop();
      if (code === 0 && !this.#reader.partial) this.#end(null);
      else this.#end(new H264EncoderStopped(words ?? `bb-box-h264 stopped with ${signal ?? `exit code ${code}`}`));
      described(words ?? "bb-box-h264 stopped");
    });
    if (options.sharedMemory !== undefined) {
      const path = Buffer.from(options.sharedMemory);
      this.#child.stdin.write(Buffer.concat([Buffer.from("M"), u32(path.length), path]));
    }
  }

  submit(frame: RawFrame): void {
    if (this.#shared) throw new Error("This encoder reads frames from shared memory: use submitShared.");
    if (frame.rgb.length !== frame.width * frame.height * 3) throw new Error(`A ${frame.width}x${frame.height} RGB frame has ${frame.width * frame.height * 3} bytes, not ${frame.rgb.length}.`);
    this.#waiting = { frame, at: performance.now() };
    this.#pump();
  }

  submitShared(shared: SharedFrame): void {
    if (!this.#shared) throw new Error("This encoder reads frames from its pipe: use submit.");
    this.#waiting = { shared, at: performance.now() };
    this.#pump();
  }

  keyframe(): void {
    this.#keyWanted = true;
    this.#pump();
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  async *frames(): AsyncGenerator<EncodedFrame> {
    for (;;) {
      const next = this.#encoded.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.#closed) {
        if (this.#ended) throw this.#ended;
        return;
      }
      await new Promise<void>((resolve) => (this.#wake = resolve));
    }
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.#closed) return resolve();
      this.#child.once("close", () => resolve());
      this.#child.stdin.end();
    });
  }

  #pump(): void {
    if (this.#inFlight || this.#closed) return;
    if (this.#keyWanted) {
      this.#keyWanted = false;
      this.#inFlight = { generation: this.#lastGeneration, at: this.#lastAt, again: true };
      this.#child.stdin.write("K");
      return;
    }
    const waiting = this.#waiting;
    if (!waiting) return;
    this.#waiting = null;
    if ("frame" in waiting) {
      const { frame, at } = waiting;
      this.#sent(frame.generation, at);
      this.#child.stdin.write(frameCommand("F", frame.width, frame.height));
      this.#child.stdin.write(frame.rgb);
    } else {
      const { shared, at } = waiting;
      this.#sent(shared.generation, at);
      this.#child.stdin.write(frameCommand("S", shared.width, shared.height));
    }
  }

  #sent(generation: number, at: number): void {
    this.#lastGeneration = generation;
    this.#lastAt = at;
    this.#inFlight = { generation, at };
  }

  #received(chunk: Buffer): void {
    for (const unit of this.#reader.push(chunk)) {
      const answered = this.#inFlight;
      this.#inFlight = null;
      if (unit.data.length > 0 && answered) {
        this.#onEncoded?.(unit);
        this.#encoded.push({ data: unit.data, key: unit.key, generation: answered.generation, monotonicMs: answered.at, width: unit.width, height: unit.height, ...(answered.again ? { again: true } : {}) });
        this.#wakeReader();
      }
      this.#pump();
    }
  }

  #end(error: Error | null): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#ended = error;
    this.#wakeReader();
  }

  #wakeReader(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }
}
