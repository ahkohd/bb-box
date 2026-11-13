import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoxKind } from "../src/backends/types.ts";
import { CLIP_FFMPEG_EXITS } from "../src/core/record-ffmpeg.ts";
import { clipFfmpegRefusal, recordingChecks, type ClipFfmpegMeasure } from "../src/core/record-support.ts";
import { FAKE_KINDS } from "./fake-backend.ts";

const DESKTOP = FAKE_KINDS[1]!;
const MAC_DESKTOP: BoxKind = { ...DESKTOP, id: "macos-desktop", capabilities: { ...DESKTOP.capabilities, os: "macos", arch: "arm64" } };
const WINDOWS_DESKTOP: BoxKind = { ...DESKTOP, id: "windows-desktop", capabilities: { ...DESKTOP.capabilities, os: "windows", arch: "x86_64" } };
const AT = Date.UTC(2026, 10, 13, 15, 30);

function measured(kind: string, measure: Omit<ClipFfmpegMeasure, "at">): ReadonlyMap<string, ClipFfmpegMeasure> {
  return new Map([[kind, { at: AT, ...measure }]]);
}

test("the doctor's fix for a Mac kind asks for ffmpeg with libx264, not drawtext, as AppKit draws a Mac's captions (063)", () => {
  const refusal = clipFfmpegRefusal("box-1", MAC_DESKTOP.capabilities, CLIP_FFMPEG_EXITS.fetchFailed, "BB Box could not fetch https://example.com/ffmpeg.zip: curl: (6) Could not resolve host");

  const [mac] = recordingChecks([MAC_DESKTOP], measured("macos-desktop", { box: "box-1", said: null, refusal, image: false }));

  assert.equal(mac?.status, "warn");
  assert.equal(mac?.fix, "Let boxes of macos-desktop reach the ffmpeg download, or put ffmpeg with libx264 in the kind's image.");
  assert.doesNotMatch(clipFfmpegRefusal("box-1", MAC_DESKTOP.capabilities, CLIP_FFMPEG_EXITS.noBuild, "ffmpeg"), /drawtext/);
  assert.match(clipFfmpegRefusal("box-1", DESKTOP.capabilities, CLIP_FFMPEG_EXITS.noBuild, "drawtext"), /Install ffmpeg with libx264 and drawtext in the box/);
});

test("a Windows desktop's recording start is the kind's last word in the doctor, with the image's own ffmpeg (063)", () => {
  const before = recordingChecks([WINDOWS_DESKTOP], new Map());

  assert.match(before[0]!.detail, /No box of this kind has started a recording since BB Box started\./);

  const [after] = recordingChecks([WINDOWS_DESKTOP], measured("windows-desktop", { box: "win-1", said: null, refusal: null, image: true }));

  assert.match(after!.detail, /In box win-1, at 2026-11-13 15:30 UTC, a recording started with the image's own ffmpeg\./);
  assert.equal(after!.status, "ok");
});
