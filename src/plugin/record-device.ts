import type { BoxRecord } from "../core/boxes.ts";
import { isTestOffer, type DeviceAnswer } from "../core/device.ts";
import type { DeviceRequestBody } from "../core/device-link.ts";
import { RECORD_LIMIT_S, parseRecordingLog, type CaptionPosition, type RecordingEnd, type StepKind } from "../core/device-recording.ts";
import { DEVICE_COMPOSE_EXITS, deviceComposeScript, devicePrepared, deviceReadLogScript, parseComposed, planDeviceClip } from "../core/record-device.ts";
import { fontInstallScript } from "../core/record-font.ts";
import { clipFfmpegScript, parseClipFfmpeg, type ClipFfmpeg, type FetchedOs } from "../core/record-ffmpeg.ts";
import { clipFfmpegRefusal, type ClipFfmpegMeasure } from "../core/record-support.ts";
import { RECORD_STOP_EXITS, parseRecordResult, planClip, recordMakeScript, type ClipPlan, type RecordResult, type RecordSpeed } from "../core/record.ts";
import { desktopDisplays } from "../backends/types.ts";
import type { RunResult } from "../transports/types.ts";
import { PRODUCT } from "../brand.ts";

export interface DeviceRecordDeps {
  record(request: Extract<DeviceRequestBody, { readonly type: "record" }>): Promise<DeviceAnswer>;
  run(script: string, timeoutMs: number): Promise<RunResult>;
}

export type DeviceRecordSaid = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly text: string };

export interface DeviceClip {
  readonly plan: ClipPlan;
  readonly made: RecordResult;
  readonly ended: RecordingEnd;
  readonly lost: readonly string[];
  readonly stopWords: string | null;
}

const COMPOSE_TIMEOUT_MS = 240_000;
const READ_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 240_000;

export type ClipFfmpegReady = { readonly ok: true; readonly said: ClipFfmpeg } | { readonly ok: false; readonly text: string };

export async function readyClipFfmpeg(run: DeviceRecordDeps["run"], box: BoxRecord): Promise<ClipFfmpegReady> {
  const os: FetchedOs = box.capabilities.os === "macos" ? "macos" : "linux";
  const result = await run(clipFfmpegScript(os), FETCH_TIMEOUT_MS);
  const said = result.exitCode === 0 ? parseClipFfmpeg(result.stdout) : null;
  if (said) return { ok: true, said };
  return { ok: false, text: clipFfmpegRefusal(box.name, box.capabilities, result.exitCode, result.stderr) };
}

export function fetchedWords(said: ClipFfmpeg): string {
  if (said.ffmpeg !== "fetched") return "";
  const lacked = said.missing.includes("ffmpeg") ? "The box had no ffmpeg" : `The box's ffmpeg lacked ${said.missing.join(", ")}`;
  return ` ${lacked}, so ${PRODUCT} fetched ffmpeg ${said.version} into it for the clip, in ${said.seconds.toFixed(1)} s.`;
}

export function recordsDevice(box: BoxRecord): boolean {
  const offer = box.capabilities.device;
  if (!offer) return false;
  if (!isTestOffer(offer)) return true;
  return (!!box.askedDevice || !!box.device) && !desktopDisplays(box.capabilities.displays).length;
}

function modelWords(box: BoxRecord): string {
  return box.device ? `the ${box.device.model}` : "its device";
}

export async function startDeviceRecording(deps: DeviceRecordDeps, box: BoxRecord, position: CaptionPosition, onReady?: (ready: ClipFfmpegReady) => void): Promise<DeviceRecordSaid> {
  const ready = await readyClipFfmpeg(deps.run, box);
  onReady?.(ready);
  if (!ready.ok) return { ok: false, text: ready.text };
  const answer = await deps.record({ type: "record", to: "start", position });
  if (!answer.ok) {
    const words = answer.error.code === "busy" ? `Box ${box.name}'s device is recording already. Call box_record with box "${box.name}" and action "stop" for its clip.` : `Recording box ${box.name}'s device did not start: ${answer.error.words}`;
    return { ok: false, text: words };
  }
  return { ok: true, text: `Recording box ${box.name}'s device, ${modelWords(box)}, for at most ${RECORD_LIMIT_S / 60} minutes. Only the device's own screen is recorded, in its frame, with no viewer needed.${fetchedWords(ready.said)}` };
}

export async function captionDeviceRecording(deps: DeviceRecordDeps, box: BoxRecord, kind: StepKind, text: string): Promise<DeviceRecordSaid> {
  const answer = await deps.record({ type: "record", to: "caption", kind, text });
  if (!answer.ok) return { ok: false, text: answer.error.code === "bad-value" ? `Box ${box.name}'s device is not recording.` : `Captioning box ${box.name}'s recording failed: ${answer.error.words}` };
  return { ok: true, text: "" };
}

export async function stopDeviceRecording(deps: DeviceRecordDeps, box: BoxRecord, stills: "cut" | "keep", speed: RecordSpeed, os: "linux" | "macos"): Promise<DeviceClip | DeviceRecordSaid> {
  const stopped = await deps.record({ type: "record", to: "stop" }).catch((error: unknown) => ({ ok: false as const, error: { code: "failed" as const, words: error instanceof Error ? error.message : String(error) }, state: null, id: "" }));
  const stopWords = stopped.ok || stopped.error.code === "bad-value" ? null : `The device server did not answer the stop (${stopped.error.words}), so the clip ends where its log does.`;
  const read = await deps.run(deviceReadLogScript(), READ_TIMEOUT_MS);
  if (read.exitCode === RECORD_STOP_EXITS.none) return { ok: false, text: `Box ${box.name}'s device has no recording.` };
  if (read.exitCode !== 0) return { ok: false, text: `Reading box ${box.name}'s recording failed: ${read.stderr.trim() || `exit code ${read.exitCode}`}` };
  const log = parseRecordingLog(read.stdout);
  const composition = planDeviceClip(log);
  if (typeof composition === "string") return { ok: false, text: `Box ${box.name}'s recording has no clip to make. ${composition}` };
  const composed = await deps.run(deviceComposeScript(composition, stills), COMPOSE_TIMEOUT_MS);
  if (composed.exitCode === DEVICE_COMPOSE_EXITS.noRecorder) return { ok: false, text: `Box ${box.name} has no ffmpeg for the clip now. Start a recording again: ${PRODUCT} fetches one as it starts.` };
  const cuts = composed.exitCode === 0 ? parseComposed(composed.stdout) : null;
  if (!cuts) return { ok: false, text: `Framing box ${box.name}'s recording failed: ${composed.stderr.trim() || `exit code ${composed.exitCode}`}` };
  const plan = planClip(devicePrepared(composition, cuts.cuts), speed);
  await deps.run(fontInstallScript(), READ_TIMEOUT_MS).catch(() => undefined);
  const made = await deps.run(recordMakeScript(plan, os), COMPOSE_TIMEOUT_MS);
  const said = made.exitCode === 0 ? parseRecordResult(made.stdout) : null;
  if (!said) return { ok: false, text: `Making the clip in box ${box.name} failed: ${made.stderr.trim() || `exit code ${made.exitCode}`}` };
  const lost = composition.notes.map((note) => note.text);
  return { plan, made: { ...said, recorded: composition.length, ended: composition.ended === "limit" ? "limit" : "stopped" }, ended: composition.ended, lost, stopWords };
}

export function deviceClipWords(clip: DeviceClip): string {
  const lost = clip.lost.length ? ` ${clip.lost.length === 1 ? "One gap" : `${clip.lost.length} gaps`} in the picture ${clip.lost.length === 1 ? "is" : "are"} captioned in the clip: ${clip.lost.join("; ")}.` : "";
  const ended = clip.ended === "box-stopped" ? "It ended early, when the box stopped or restarted." : "";
  return `${ended ? ` ${ended}` : ""}${lost}${clip.stopWords ? ` ${clip.stopWords}` : ""}`;
}

export class ClipFfmpegLedger {
  readonly #last = new Map<string, ClipFfmpegMeasure>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  note(box: BoxRecord, ready: ClipFfmpegReady): void {
    this.#last.set(box.kind, { at: this.#now(), box: box.name, said: ready.ok ? ready.said : null, refusal: ready.ok ? null : ready.text });
  }

  get measured(): ReadonlyMap<string, ClipFfmpegMeasure> {
    return this.#last;
  }
}
