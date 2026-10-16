// box_record's scripts (059), run with a fake ffmpeg and ffprobe that say
// what they were asked, and its page for the thread's preview.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { RECORD_DIR, RECORD_START_EXITS, RECORD_STOP_EXITS, parseRecordResult, previewHeight, recordPage, recordStartScript, recordStopScript } from "../src/core/record.ts";
import { fakeFfmpeg, tempDir } from "./helpers.ts";

const skip = process.platform === "linux" ? false : "needs GNU stat and setsid";

function run(script: string, home: string, env: Record<string, string> = {}, wfRecorder = true, darwin = false) {
  const bin = fakeFfmpeg({ wfRecorder, darwin });
  return spawnSync("bash", ["-c", script], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...env }, encoding: "utf8" });
}

test("box_record starts once, refuses no display, and stop makes the clip with still stretches cut and the speed (059)", { skip }, () => {
  const home = tempDir("record-home");
  const display = { DISPLAY: ":99" };
  assert.equal(run(recordStartScript(), home).status, RECORD_START_EXITS.noDisplay);
  assert.equal(run(recordStopScript({ speed: 1, stills: "cut" }), home).status, RECORD_STOP_EXITS.none, "no recording yet");

  const started = run(recordStartScript(), home, display);
  assert.equal(started.status, RECORD_START_EXITS.started, started.stderr);
  assert.ok(existsSync(join(home, RECORD_DIR, "pid")));
  assert.equal(run(recordStartScript(), home, display).status, RECORD_START_EXITS.running, "one at a time");
  assert.match(readFileSync(join(home, "ffmpeg-args"), "utf8"), /-f x11grab -framerate 15 -i :99 -t 300 /);

  const stopped = run(recordStopScript({ speed: 2, stills: "cut" }), home);
  assert.equal(stopped.status, RECORD_STOP_EXITS.made, stopped.stderr);
  assert.deepEqual(parseRecordResult(stopped.stdout), { ended: "stopped", recorded: 10, clip: 4.2, bytes: 7, size: "1280x720" });
  const made = readFileSync(join(home, "ffmpeg-args"), "utf8").trim().split("\n").pop()!;
  // Each still stretch keeps its first half second; the last runs to the end.
  assert.match(made, /select='not\(between\(t,1\.500,6\.000\)\+between\(t,8\.500,10\.000\)\)',setpts=N\/\(15\*2\)\/TB,fps=15,scale='min\(1280,iw\)':-2/);
  assert.match(made, /-c:v libx264 .*-crf 28 -tune animation -pix_fmt yuv420p -movflags \+faststart/);
  assert.ok(!existsSync(join(home, RECORD_DIR, "capture.mkv")), "the capture goes once the clip is made");
  assert.equal(readFileSync(join(home, RECORD_DIR, "clip.mp4"), "utf8"), "mp4data");
  assert.equal(run(recordStopScript({ speed: 1, stills: "cut" }), home).status, RECORD_STOP_EXITS.none, "a second stop has nothing");

  // A recording that ended at its limit is stopped no more, and stills kept means no select.
  mkdirSync(join(home, RECORD_DIR), { recursive: true });
  writeFileSync(join(home, RECORD_DIR, "capture.mkv"), "capture");
  const kept = run(recordStopScript({ speed: 1, stills: "keep" }), home);
  assert.equal(parseRecordResult(kept.stdout)?.ended, "limit");
  assert.doesNotMatch(readFileSync(join(home, "ffmpeg-args"), "utf8").trim().split("\n").pop()!, /select=|freezedetect/);
});

test("on Wayland box_record runs wf-recorder with --no-damage under timeout, and a stop ends it through timeout (059)", { skip }, () => {
  const home = tempDir("record-wayland");
  const wayland = { WAYLAND_DISPLAY: "wayland-1" };
  assert.equal(run(recordStartScript(), home, wayland, false).status, RECORD_START_EXITS.noRecorder, "an image without wf-recorder");
  const started = run(recordStartScript(), home, wayland);
  assert.equal(started.status, RECORD_START_EXITS.started, started.stderr);
  assert.match(readFileSync(join(home, "ffmpeg-args"), "utf8"), /^wf-recorder --no-dmabuf --no-damage -r 15 -c libx264 -p preset=ultrafast -p crf=0 -f \S+\/capture\.mkv$/m);
  const stopped = run(recordStopScript({ speed: 1, stills: "cut" }), home);
  assert.equal(stopped.status, RECORD_STOP_EXITS.made, stopped.stderr);
  assert.equal(parseRecordResult(stopped.stdout)?.ended, "stopped");
});

test("on macOS box_record records ffmpeg's avfoundation screen in a session Perl starts, and stop makes the clip (059)", { skip }, () => {
  const home = tempDir("record-macos");
  const started = run(recordStartScript(), home, {}, true, true);
  assert.equal(started.status, RECORD_START_EXITS.started, started.stderr);
  assert.match(readFileSync(join(home, "ffmpeg-args"), "utf8"), /-f avfoundation -capture_cursor 1 -framerate 15 -i 0:none -t 300 -c:v libx264 -preset ultrafast -crf 0 \S+\/capture\.mkv$/m);
  const stopped = run(recordStopScript({ speed: 1, stills: "cut" }), home, {}, true, true);
  assert.equal(stopped.status, RECORD_STOP_EXITS.made, stopped.stderr);
  assert.deepEqual(parseRecordResult(stopped.stdout), { ended: "stopped", recorded: 10, clip: 4.2, bytes: 7, size: "1280x720" });
});

test("box_record's page plays the clip beside it by its name, and its height follows the clip's shape (059)", () => {
  const page = recordPage(`Box "a" <b>`, "box a&b.mp4");
  assert.ok(page.includes(`<video src="box%20a%26b.mp4" autoplay muted loop controls playsinline`), page);
  assert.ok(page.length < 400, "a tiny page");
  assert.ok(page.includes("<title>Box &#34;a&#34; &#60;b&#62;</title>"));
  assert.equal(previewHeight("1280x720"), 368);
  assert.equal(previewHeight("960x1600"), 1075);
  assert.equal(previewHeight("odd"), 400);
  assert.equal(parseRecordResult("no json"), null);
});
