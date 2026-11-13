import { PRODUCT } from "../brand.ts";
import { desktopDisplays, type DoctorCheck, type KindCapabilities } from "../backends/types.ts";
import { CLIP_FFMPEG_EXITS, buildFor, clipFilters, fetchSize, type ClipFfmpeg, type FetchedOs } from "./record-ffmpeg.ts";

export interface RecordedKind {
  readonly id: string;
  readonly capabilities: KindCapabilities;
}

export interface ClipFfmpegMeasure {
  readonly at: number;
  readonly box: string;
  readonly said: ClipFfmpeg | null;
  readonly refusal: string | null;
}

type Records = "device" | "desktop" | "nothing";

function recordsOn(capabilities: KindCapabilities): Records {
  if (capabilities.device) return "device";
  return desktopDisplays(capabilities.displays).length ? "desktop" : "nothing";
}

function needsWords(os: FetchedOs): string {
  return `ffmpeg and ffprobe with libx264 and the ${clipFilters(os).join(", ")} filters`;
}

function fetchWords(capabilities: KindCapabilities): string {
  if (capabilities.os === "windows") return "Its image has the ffmpeg it needs.";
  const build = buildFor(capabilities.os, capabilities.arch);
  const os = capabilities.os === "macos" ? "macOS" : "Linux";
  if (!build) return `It needs ${needsWords(capabilities.os)} in the box: ${PRODUCT} has no ffmpeg build to fetch for ${os} on ${capabilities.arch}.`;
  return `It needs ${needsWords(capabilities.os)}. When the box has none fit, ${PRODUCT} fetches ffmpeg ${build.version} into the box user's home at its first recording, about ${fetchSize(build)}, and checks its SHA-256. No root is needed.`;
}

function whatWords(capabilities: KindCapabilities): string {
  if (recordsOn(capabilities) === "device") return "box_record records the device's own screen, in its frame, with captioned steps and a step list.";
  const captions = capabilities.os === "macos" ? "drawn with AppKit" : "drawn with ffmpeg's drawtext";
  return `box_record records the desktop, with captioned steps ${captions} and a step list.`;
}

function measureWords(measure: ClipFfmpegMeasure): string {
  const when = new Date(measure.at).toISOString().slice(0, 16).replace("T", " ");
  const where = `In box ${measure.box}, at ${when} UTC`;
  if (measure.refusal) return `${where}: ${measure.refusal}`;
  const said = measure.said!;
  if (said.ffmpeg === "own") return `${where}, its own ffmpeg ${said.version} had all a clip needs.`;
  if (said.ffmpeg === "kept") return `${where}, it used the ffmpeg ${said.version} ${PRODUCT} had fetched into it before.`;
  const lacked = said.missing.includes("ffmpeg") ? "it had no ffmpeg" : `its own ffmpeg lacked ${said.missing.join(", ")}`;
  return `${where}, ${lacked}, so ${PRODUCT} fetched ffmpeg ${said.version} in ${said.seconds.toFixed(1)} s.`;
}

export function recordingChecks(kinds: readonly RecordedKind[], measured: ReadonlyMap<string, ClipFfmpegMeasure>): DoctorCheck[] {
  const seen = new Set<string>();
  return kinds.flatMap((kind): DoctorCheck[] => {
    if (seen.has(kind.id)) return [];
    seen.add(kind.id);
    const id = `recording.${kind.id}` as DoctorCheck["id"];
    const name = `Recordings on ${kind.id}`;
    if (recordsOn(kind.capabilities) === "nothing") return [{ id, name, status: "ok", detail: "box_record records nothing here: a box of this kind has no desktop or device.", fix: null }];
    const measure = measured.get(kind.id);
    const last = measure ? ` ${measureWords(measure)}` : ` No box of this kind has started a recording since ${PRODUCT} started.`;
    return [
      {
        id,
        name,
        status: measure?.refusal ? "warn" : "ok",
        detail: `${whatWords(kind.capabilities)} ${fetchWords(kind.capabilities)}${last}`,
        fix: measure?.refusal ? `Let boxes of ${kind.id} reach the ffmpeg download, or put ffmpeg with libx264 and drawtext in the kind's image.` : null,
      },
    ];
  });
}

export function clipFfmpegRefusal(box: string, capabilities: KindCapabilities, exitCode: number | null, stderr: string): string {
  const why = stderr.trim().split("\n").pop() ?? "";
  const lacks = (words: string) => (words === "ffmpeg" ? "it has no ffmpeg" : `its ffmpeg lacks ${words.split(" ").join(", ")}`);
  if (exitCode === CLIP_FFMPEG_EXITS.noBuild) {
    const os = capabilities.os === "macos" ? "macOS" : "Linux";
    return `Box ${box} cannot make a recording's clip: ${lacks(why || "ffmpeg")}, and ${PRODUCT} has no ffmpeg build to fetch for ${os} on ${capabilities.arch}. Install ffmpeg with libx264 and drawtext in the box, then start again.`;
  }
  if (exitCode === CLIP_FFMPEG_EXITS.fetchFailed) return `Box ${box} cannot make a recording's clip yet: ${why || "the download failed"}. Check that the box can reach the internet, then start again.`;
  return `Box ${box} cannot make a recording's clip: ${why || `getting ffmpeg ended with exit code ${exitCode}`}`;
}
