import { DEVICE_MODELS } from "./device-models.ts";
import { ORIENTATIONS, POSTURES, type FoldScreen, type ModelName, type Orientation, type Posture, type TouchContact, type VideoSize } from "./device.ts";

export const RECORD_LIMIT_S = 300;
export const RECORD_DIR = ".local/state/bb-box/recording";
export const DEVICE_RECORDING_LOG = "device.jsonl";

export type StepKind = "step" | "pass" | "fail";
export type CaptionPosition = "top" | "bottom";
export type LostWhy = "server" | "device" | "behind";
export type RecordingEnd = "stopped" | "limit" | "box-stopped";

export const RECORDING_BEHIND_MS = 2_000;
export const RECORDING_CLOCKS_PART_MS = 5_000;
export const TOUCH_SAMPLE_MS = 40;

export function segmentFile(segment: number): string {
  return `capture-${segment}.mkv`;
}

export interface SegmentGeometry {
  readonly physical: Orientation;
  readonly content: Orientation;
  readonly video: VideoSize;
  readonly screen?: FoldScreen;
  readonly posture?: Posture;
}

export type RecordingEntry =
  | { readonly type: "start"; readonly at: 0; readonly wall: number; readonly system: number; readonly position: CaptionPosition }
  | { readonly type: "segment"; readonly at: number; readonly n: number; readonly model: ModelName; readonly geometry: SegmentGeometry }
  | { readonly type: "lost"; readonly at: number; readonly why: LostWhy; readonly words: string }
  | { readonly type: "touch"; readonly at: number; readonly n: number; readonly contacts: readonly TouchContact[] }
  | { readonly type: "caption"; readonly at: number; readonly kind: StepKind; readonly text: string }
  | { readonly type: "end"; readonly at: number; readonly ended: RecordingEnd };

export interface RecordingSummary {
  readonly active: boolean;
  readonly ended: RecordingEnd | null;
  readonly seconds: number;
  readonly segments: number;
  readonly lost: readonly string[];
}

export function lostWords(why: LostWhy, detail?: string): string {
  if (why === "server") return "The device server restarted here, and frames were lost";
  if (why === "behind") return "Frames were lost here, as the recording fell behind";
  return detail ?? "The device restarted here";
}

export function recordingLine(entry: RecordingEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

type Fields = Readonly<Record<string, unknown>>;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const at = (value: unknown): value is number => finite(value) && value >= 0;
const whole = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
const oneOf = <T extends string>(value: unknown, options: readonly T[]): value is T => typeof value === "string" && (options as readonly string[]).includes(value);

function size(value: unknown): value is VideoSize {
  const read = value as Fields | null;
  return typeof read === "object" && read !== null && whole(read.width) && whole(read.height) && (read.width as number) > 0 && (read.height as number) > 0;
}

function geometry(value: unknown): SegmentGeometry | null {
  const read = value as Fields | null;
  if (typeof read !== "object" || read === null) return null;
  if (!oneOf(read.physical, ORIENTATIONS) || !oneOf(read.content, ORIENTATIONS) || !size(read.video)) return null;
  if (read.screen !== undefined && !oneOf(read.screen, ["outer", "inner"] as const)) return null;
  if (read.posture !== undefined && !oneOf(read.posture, POSTURES)) return null;
  return { physical: read.physical, content: read.content, video: { width: read.video.width, height: read.video.height }, ...(read.screen ? { screen: read.screen as FoldScreen } : {}), ...(read.posture ? { posture: read.posture as Posture } : {}) };
}

function contacts(value: unknown): readonly TouchContact[] | null {
  if (!Array.isArray(value) || value.length > 10) return null;
  const read = value.map((item: Fields | null) => (typeof item === "object" && item !== null && whole(item.id) && finite(item.x) && finite(item.y) ? { id: item.id, x: item.x, y: item.y } : null));
  return read.every((item) => item !== null) ? (read as TouchContact[]) : null;
}

const MODEL_NAMES: readonly ModelName[] = DEVICE_MODELS.map((model) => model.name);

export function parseRecordingEntry(line: string): RecordingEntry | null {
  let read: Fields;
  try {
    read = JSON.parse(line) as Fields;
  } catch {
    return null;
  }
  if (typeof read !== "object" || read === null || !at(read.at)) return null;
  switch (read.type) {
    case "start":
      return read.at === 0 && finite(read.wall) && finite(read.system) && oneOf(read.position, ["top", "bottom"] as const) ? { type: "start", at: 0, wall: read.wall, system: read.system, position: read.position } : null;
    case "segment": {
      const shape = geometry(read.geometry);
      return whole(read.n) && oneOf(read.model, MODEL_NAMES) && shape ? { type: "segment", at: read.at, n: read.n, model: read.model, geometry: shape } : null;
    }
    case "lost":
      return oneOf(read.why, ["server", "device", "behind"] as const) && typeof read.words === "string" ? { type: "lost", at: read.at, why: read.why, words: read.words.slice(0, 200) } : null;
    case "touch": {
      const touching = contacts(read.contacts);
      return whole(read.n) && touching ? { type: "touch", at: read.at, n: read.n, contacts: touching } : null;
    }
    case "caption":
      return oneOf(read.kind, ["step", "pass", "fail"] as const) && typeof read.text === "string" && read.text ? { type: "caption", at: read.at, kind: read.kind, text: read.text.slice(0, 200) } : null;
    case "end":
      return oneOf(read.ended, ["stopped", "limit", "box-stopped"] as const) ? { type: "end", at: read.at, ended: read.ended } : null;
    default:
      return null;
  }
}

export interface RecordingLog {
  readonly start: Extract<RecordingEntry, { type: "start" }> | null;
  readonly entries: readonly RecordingEntry[];
  readonly end: Extract<RecordingEntry, { type: "end" }> | null;
  readonly unread: number;
}

export function parseRecordingLog(text: string): RecordingLog {
  const lines = text.split("\n").filter((line) => line.trim());
  const entries: RecordingEntry[] = [];
  let unread = 0;
  for (const line of lines) {
    const entry = parseRecordingEntry(line);
    if (entry) entries.push(entry);
    else unread++;
  }
  const start = entries.find((entry): entry is Extract<RecordingEntry, { type: "start" }> => entry.type === "start") ?? null;
  const end = entries.find((entry): entry is Extract<RecordingEntry, { type: "end" }> => entry.type === "end") ?? null;
  return { start, entries, end, unread };
}

export function lastAt(log: RecordingLog): number {
  return log.entries.reduce((most, entry) => Math.max(most, entry.at), 0);
}

export function summarise(log: RecordingLog, active: boolean, nowAt?: number): RecordingSummary {
  const seconds = (log.end?.at ?? nowAt ?? lastAt(log)) / 1000;
  const segments = log.entries.filter((entry) => entry.type === "segment").length;
  const lost = log.entries.flatMap((entry) => (entry.type === "lost" ? [entry.words] : []));
  return { active, ended: log.end?.ended ?? null, seconds: Math.round(seconds * 10) / 10, segments, lost };
}
