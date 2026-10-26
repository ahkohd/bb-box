import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeviceErrorCode, DeviceState, TouchContact } from "../core/device.ts";
import {
  DEVICE_RECORDING_LOG,
  RECORDING_BEHIND_MS,
  RECORDING_CLOCKS_PART_MS,
  RECORD_LIMIT_S,
  TOUCH_SAMPLE_MS,
  lastAt,
  lostWords,
  parseRecordingLog,
  recordingLine,
  segmentFile,
  summarise,
  type CaptionPosition,
  type LostWhy,
  type RecordingEnd,
  type RecordingEntry,
  type RecordingSummary,
  type SegmentGeometry,
  type StepKind,
} from "../core/device-recording.ts";
import { nalUnits } from "./annexb.ts";
import type { EncodedFrame, VideoSource } from "./driver.ts";
import { MkvWriter, parameterSetsOf } from "./mkv.ts";

export interface RecorderClock {
  now(): number;
  monotonic(): number;
  system(): number;
}

export const SYSTEM_RECORDER_CLOCK: RecorderClock = { now: () => Date.now(), monotonic: () => performance.now(), system: () => Number(process.hrtime.bigint()) / 1e6 };

export const WATCH_CLOCKS_EVERY_MS = 1_000;

export interface RecorderOptions {
  readonly dir: string;
  readonly video: () => VideoSource;
  readonly state: () => DeviceState;
  readonly readBack: () => Promise<DeviceState>;
  readonly log: (line: string) => void;
  readonly clock?: RecorderClock;
  readonly limitMs?: number;
}

export type RecordingAnswer = { readonly ok: true; readonly summary: RecordingSummary } | { readonly ok: false; readonly code: DeviceErrorCode; readonly words: string };

type StartEntry = Extract<RecordingEntry, { type: "start" }>;

interface OpenSegment {
  readonly n: number;
  readonly generation: number;
  readonly width: number;
  readonly height: number;
  readonly writer: MkvWriter;
}

interface Running {
  readonly start: StartEntry;
  readonly stopPump: AbortController;
  readonly limit: ReturnType<typeof setTimeout>;
  readonly watch: ReturnType<typeof setInterval>;
  segment: OpenSegment | null;
  nextSegment: number;
  keyAsked: boolean;
  booted: boolean;
  lastTouch: { readonly at: number; readonly count: number } | null;
  pendingTouch: { readonly at: number; readonly contacts: readonly TouchContact[] } | null;
  lastWatchAt: number;
}

const LEFTOVERS = /^(capture(-\d+)?\.mkv|device\.jsonl|clip\.mp4|events|pid|start|position|log|pill.*|compose.*)$/;

function geometryOf(state: DeviceState, frame: EncodedFrame): SegmentGeometry {
  const geometry = state.geometry;
  const video = { width: frame.width, height: frame.height };
  if (!geometry) return { physical: "upright", content: "upright", video };
  const fold = state.platform === "android" && state.form === "foldable" ? state : null;
  const screen = fold && state.geometry && "screen" in state.geometry ? state.geometry.screen : undefined;
  const posture = fold && fold.posture.known ? fold.posture.value : undefined;
  return { physical: geometry.physical, content: geometry.content, video, ...(screen ? { screen } : {}), ...(posture ? { posture } : {}) };
}

function wordsOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DeviceRecorder {
  readonly #options: RecorderOptions;
  readonly #clock: RecorderClock;
  readonly #limitMs: number;
  #running: Running | null = null;

  constructor(options: RecorderOptions) {
    this.#options = options;
    this.#clock = options.clock ?? SYSTEM_RECORDER_CLOCK;
    this.#limitMs = options.limitMs ?? RECORD_LIMIT_S * 1000;
  }

  get recording(): boolean {
    return this.#running !== null;
  }

  get #logPath(): string {
    return join(this.#options.dir, DEVICE_RECORDING_LOG);
  }

  get #pidPath(): string {
    return join(this.#options.dir, "pid");
  }

  #append(entry: RecordingEntry): void {
    appendFileSync(this.#logPath, recordingLine(entry), { mode: 0o600 });
  }

  #atNow(start: StartEntry): number {
    return Math.max(0, Math.round(this.#clock.system() - start.system));
  }

  #frameAt(start: StartEntry, frame: EncodedFrame): number {
    return frame.monotonicMs + (this.#clock.system() - this.#clock.monotonic()) - start.system;
  }

  #readLog() {
    let text = "";
    try {
      text = readFileSync(this.#logPath, "utf8");
    } catch {
      return null;
    }
    return parseRecordingLog(text);
  }

  #summary(): RecordingSummary {
    const log = this.#readLog();
    const running = this.#running;
    return log ? summarise(log, running !== null, running ? this.#atNow(running.start) : undefined) : { active: false, ended: null, seconds: 0, segments: 0, lost: [] };
  }

  start(position: CaptionPosition): RecordingAnswer {
    if (this.#running) return { ok: false, code: "busy", words: "This box's device is recording already. Stop that recording for its clip first." };
    mkdirSync(this.#options.dir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(this.#options.dir)) if (LEFTOVERS.test(name)) rmSync(join(this.#options.dir, name), { force: true, recursive: true });
    const start: StartEntry = { type: "start", at: 0, wall: this.#clock.now(), system: this.#clock.system(), position };
    this.#append(start);
    this.#begin(start, 1);
    this.#options.log(`recording: started, captions at the ${position}`);
    return { ok: true, summary: this.#summary() };
  }

  resume(): void {
    const log = this.#readLog();
    if (!log?.start || log.end) return;
    const start = log.start;
    const bootThen = start.wall - start.system;
    const bootNow = this.#clock.now() - this.#clock.system();
    if (Math.abs(bootNow - bootThen) > RECORDING_CLOCKS_PART_MS) {
      this.#append({ type: "end", at: lastAt(log), ended: "box-stopped" });
      rmSync(this.#pidPath, { force: true });
      this.#options.log("recording: ended, as the box stopped or restarted since it began");
      return;
    }
    if (this.#atNow(start) >= this.#limitMs) {
      this.#append({ type: "end", at: Math.min(this.#limitMs, Math.max(lastAt(log), 0)), ended: "limit" });
      rmSync(this.#pidPath, { force: true });
      this.#options.log("recording: ended, as it passed its limit while the server was down");
      return;
    }
    this.#append({ type: "lost", at: this.#atNow(start), why: "server", words: lostWords("server") });
    const segments = log.entries.flatMap((entry) => (entry.type === "segment" ? [entry.n] : []));
    this.#begin(start, Math.max(0, ...segments) + 1);
    this.#options.log("recording: carried on after the server restarted");
  }

  #begin(start: StartEntry, nextSegment: number): void {
    writeFileSync(this.#pidPath, `${process.pid}\n`, { mode: 0o600 });
    const untilLimit = Math.max(0, this.#limitMs - this.#atNow(start));
    const limit = setTimeout(() => this.#end("limit", this.#limitMs), untilLimit);
    const watch = setInterval(() => this.#watchClocks(), WATCH_CLOCKS_EVERY_MS);
    limit.unref?.();
    watch.unref?.();
    const running: Running = { start, stopPump: new AbortController(), limit, watch, segment: null, nextSegment, keyAsked: false, booted: this.#options.state().power.is === "booted", lastTouch: null, pendingTouch: null, lastWatchAt: this.#atNow(start) };
    this.#running = running;
    void this.#pump(running).catch((error) => this.#options.log(`recording: frames stopped: ${wordsOf(error)}`));
    this.#askKey(running);
  }

  #askKey(running: Running): void {
    running.keyAsked = true;
    this.#options.video().keyframe();
  }

  async #pump(running: Running): Promise<void> {
    for await (const frame of this.#options.video().frames(running.stopPump.signal)) {
      if (this.#running !== running) return;
      await this.#frame(running, frame);
    }
  }

  async #frame(running: Running, frame: EncodedFrame): Promise<void> {
    const start = running.start;
    const at = this.#frameAt(start, frame);
    if (at < 0) return;
    const behind = this.#atNow(start) - at;
    if (behind > RECORDING_BEHIND_MS) {
      if (running.segment) {
        this.#closeSegment(running);
        this.#lost(running, "behind", Math.round(at));
        this.#askKey(running);
      }
      return;
    }
    const open = running.segment;
    if (open && (open.generation !== frame.generation || open.width !== frame.width || open.height !== frame.height)) this.#closeSegment(running);
    if (!running.segment) {
      const sets = frame.key ? parameterSetsOf(nalUnits(frame.data)) : null;
      if (!sets) {
        if (!running.keyAsked) this.#askKey(running);
        return;
      }
      let state = this.#options.state();
      if (state.geometry?.generation !== frame.generation) state = await this.#options.readBack().catch(() => state);
      if (this.#running !== running) return;
      const n = running.nextSegment++;
      const geometry = geometryOf(state, frame);
      const writer = MkvWriter.open(join(this.#options.dir, segmentFile(n)), { width: frame.width, height: frame.height }, sets);
      running.segment = { n, generation: frame.generation, width: frame.width, height: frame.height, writer };
      running.keyAsked = false;
      this.#append({ type: "segment", at: Math.round(at), n, model: state.model, geometry });
      this.#options.log(`recording: segment ${n}, the ${state.model} at ${frame.width}x${frame.height}, ${geometry.physical}`);
    }
    running.segment!.writer.write(at, frame.key, frame.data);
  }

  #closeSegment(running: Running): void {
    this.#flushTouch(running);
    running.segment?.writer.close();
    running.segment = null;
    running.lastTouch = null;
  }

  #lost(running: Running, why: LostWhy, at: number, detail?: string): void {
    const words = lostWords(why, detail);
    this.#append({ type: "lost", at, why, words });
    this.#options.log(`recording: ${words}`);
  }

  #flushTouch(running: Running): void {
    const pending = running.pendingTouch;
    if (!pending || !running.segment) return;
    running.pendingTouch = null;
    this.#append({ type: "touch", at: pending.at, n: running.segment.n, contacts: pending.contacts });
  }

  touch(contacts: readonly TouchContact[]): void {
    const running = this.#running;
    if (!running?.segment) return;
    const at = this.#atNow(running.start);
    const last = running.lastTouch;
    if (contacts.length && last && last.count === contacts.length && at - last.at < TOUCH_SAMPLE_MS) {
      running.pendingTouch = { at, contacts };
      return;
    }
    if (last && last.count !== contacts.length) this.#flushTouch(running);
    running.pendingTouch = null;
    running.lastTouch = { at, count: contacts.length };
    this.#append({ type: "touch", at, n: running.segment.n, contacts: contacts.map(({ id, x, y }) => ({ id, x: Math.round(x), y: Math.round(y) })) });
  }

  stateChanged(state: DeviceState): void {
    const running = this.#running;
    if (!running) return;
    const booted = state.power.is === "booted";
    if (running.booted && !booted) {
      const detail = state.power.is === "switching" ? `The box switched to the ${state.power.to} here` : undefined;
      this.#closeSegment(running);
      this.#lost(running, "device", this.#atNow(running.start), detail);
    }
    running.booted = booted;
  }

  caption(kind: StepKind, text: string): RecordingAnswer {
    const running = this.#running;
    if (!running) return { ok: false, code: "bad-value", words: "This box's device is not recording. Start a recording first." };
    this.#append({ type: "caption", at: this.#atNow(running.start), kind, text });
    return { ok: true, summary: this.#summary() };
  }

  stop(): RecordingAnswer {
    if (this.#running) {
      this.#end("stopped", this.#atNow(this.#running.start));
      return { ok: true, summary: this.#summary() };
    }
    const log = this.#readLog();
    if (log?.start && log.end) return { ok: true, summary: this.#summary() };
    return { ok: false, code: "bad-value", words: "This box's device has no recording." };
  }

  #watchClocks(): void {
    const running = this.#running;
    if (!running) return;
    const start = running.start;
    const wall = this.#clock.now() - start.wall;
    const system = this.#atNow(start);
    if (Math.abs(wall - system) > RECORDING_CLOCKS_PART_MS) {
      this.#end("box-stopped", running.lastWatchAt);
      return;
    }
    running.lastWatchAt = system;
  }

  #end(ended: RecordingEnd, at: number): void {
    const running = this.#running;
    if (!running) return;
    this.#closeSegment(running);
    this.#running = null;
    clearTimeout(running.limit);
    clearInterval(running.watch);
    running.stopPump.abort();
    this.#append({ type: "end", at, ended });
    rmSync(this.#pidPath, { force: true });
    this.#options.log(`recording: ended (${ended}) at ${(at / 1000).toFixed(1)} s`);
  }

  close(): void {
    const running = this.#running;
    if (!running) return;
    this.#closeSegment(running);
    this.#running = null;
    clearTimeout(running.limit);
    clearInterval(running.watch);
    running.stopPump.abort();
  }
}
