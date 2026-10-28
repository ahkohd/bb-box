import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { UnitReader, type EncodedUnit } from "./h264-encoder.ts";
import type { StreamOutput } from "./idb.ts";

export const SOFTWARE_ENCODER = "/usr/local/bin/bb-box-h264";
export const SOFTWARE_BITRATE_KBPS = 8000;
export const SOFTWARE_FPS = 60;
export const ENCODE_WINDOW_MS = 10_000;
export const HELPER_STOP_MS = 1_000;

const VIDEO_TOOLBOX_FAILURE = /VideoToolbox (?:encode )?error|OSStatus -129\d\d|cannot create compression session/i;

export type IosEncoderMode = "auto" | "hardware" | "software";
export type IosEncoderWay = "hardware" | "software";

export function isIosEncoderMode(value: unknown): value is IosEncoderMode {
  return value === "auto" || value === "hardware" || value === "software";
}

export function hardwareFailed(log: string): boolean {
  return VIDEO_TOOLBOX_FAILURE.test(log);
}

export async function softwareEncoderAt(path: string = SOFTWARE_ENCODER): Promise<boolean> {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
}

export interface SimulatorStreamOptions {
  readonly helper?: string;
  readonly udid: string;
  readonly developer?: string;
  readonly bitrateKbps?: number;
  readonly encoded?: (unit: EncodedUnit) => void;
  readonly described?: (words: string) => void;
}

export function scaleThousandths(scale: number): number {
  return Math.min(1000, Math.max(100, Math.round(scale * 1000)));
}

export async function* simulatorStream(options: SimulatorStreamOptions, stopped: Promise<void>, signal: AbortSignal, scale: number): AsyncIterable<StreamOutput> {
  const args = ["--simulator", options.udid, "--scale", String(scaleThousandths(scale)), "--bitrate", String(options.bitrateKbps ?? SOFTWARE_BITRATE_KBPS), "--fps", String(SOFTWARE_FPS), ...(options.developer ? ["--developer", options.developer] : [])];
  const child = spawn(options.helper ?? SOFTWARE_ENCODER, args, { stdio: ["pipe", "pipe", "pipe"] });
  const reader = new UnitReader();
  const waiting: StreamOutput[] = [];
  let wake: (() => void) | null = null;
  let ended: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null = null;
  let failure: Error | null = null;
  let stderr = "";
  const nudge = () => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  child.stdout.on("data", (chunk: Buffer) => {
    for (const unit of reader.push(chunk)) {
      if (!unit.data.byteLength) continue;
      options.encoded?.(unit);
      waiting.push({ data: unit.data, log: null });
    }
    nudge();
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => {
    stderr = (stderr + text).slice(-4096);
    for (const line of text.split("\n").map((each) => each.trim()).filter(Boolean)) {
      const described = /^bb-box-h264: (.+), \d+ kbit\/s/.exec(line);
      if (described) options.described?.(described[1]!);
      else waiting.push({ data: null, log: line.replace(/^bb-box-h264: /, "") });
    }
    nudge();
  });
  child.stdin.on("error", () => {});
  child.on("error", (error) => {
    failure = new Error(`bb-box-h264 did not start: ${error.message}`);
    nudge();
  });
  child.on("close", (code, why) => {
    ended = { code, signal: why };
    nudge();
  });
  const stop = () => {
    child.stdin.end();
    setTimeout(() => {
      if (!ended) child.kill("SIGTERM");
    }, HELPER_STOP_MS).unref();
  };
  void stopped.then(stop);
  const onAbort = () => {
    if (!ended) child.kill("SIGTERM");
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const next = waiting.shift();
      if (next) {
        yield next;
        continue;
      }
      if (failure) throw failure;
      if (ended) {
        const { code, signal: why } = ended;
        if (code === 0 || signal.aborted) return;
        const said = stderr.trim().split("\n").filter((line) => !/kbit\/s, \d+ threads?$/.test(line)).pop()?.replace(/^bb-box-h264: /, "");
        throw new Error(said ? `bb-box-h264 stopped: ${said}` : `bb-box-h264 stopped with ${why ?? `exit code ${code}`}`);
      }
      await new Promise<void>((resolve) => (wake = resolve));
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (!ended) stop();
  }
}

export class EncodeMeter {
  readonly #window: { readonly at: number; readonly micros: number }[] = [];
  readonly #now: () => number;
  readonly #windowMs: number;

  constructor(now: () => number = () => performance.now(), windowMs = ENCODE_WINDOW_MS) {
    this.#now = now;
    this.#windowMs = windowMs;
  }

  add(micros: number): void {
    this.#window.push({ at: this.#now(), micros });
    this.#trim();
  }

  cores(): number {
    this.#trim();
    const micros = this.#window.reduce((sum, each) => sum + each.micros, 0);
    return Math.round((micros / 1000 / this.#windowMs) * 100) / 100;
  }

  #trim(): void {
    const now = this.#now();
    while (this.#window.length && now - this.#window[0]!.at > this.#windowMs) this.#window.shift();
  }
}
