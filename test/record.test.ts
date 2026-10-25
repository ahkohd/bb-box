// box_record's scripts (059), run with a fake ffmpeg and ffprobe that say
// what they were asked, and its page for the thread's preview.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { RECORD_DIR, RECORD_START_EXITS, RECORD_STEP_EXITS, RECORD_STOP_EXITS, captionText, chaptersOf, clipGraph, parsePrepared, parseRecordResult, planClip, previewHeight, readingSeconds, recordMakeScript, recordPage, recordPrepareScript, recordStartScript, recordStepScript, recordStopScript, type Prepared } from "../src/core/record.ts";
import { fakeFfmpeg, tempDir } from "./helpers.ts";

const skip = process.platform === "linux" ? false : "needs GNU stat and setsid";

function run(script: string, home: string, env: Record<string, string> = {}, wfRecorder = true, darwin = false) {
  const bin = fakeFfmpeg({ wfRecorder, darwin });
  return spawnSync("bash", ["-c", script], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...env }, encoding: "utf8" });
}

function stop(home: string, speed: 1 | 2 | 4, stills: "cut" | "keep", darwin = false) {
  const prepared = run(recordPrepareScript(stills), home, {}, true, darwin);
  if (prepared.status !== 0) return { prepared, made: null, plan: null };
  const facts = parsePrepared(prepared.stdout)!;
  const plan = planClip(facts, speed);
  return { prepared, facts, plan, made: run(recordMakeScript(plan), home, {}, true, darwin) };
}

test("box_record starts once, refuses no display, and stop makes the clip with still stretches cut and the speed (059)", { skip }, () => {
  const home = tempDir("record-home");
  const display = { DISPLAY: ":99" };
  assert.equal(run(recordStartScript(), home).status, RECORD_START_EXITS.noDisplay);
  assert.equal(run(recordPrepareScript("cut"), home).status, RECORD_STOP_EXITS.none, "no recording yet");
  assert.equal(run(recordStepScript("step", "Too early"), home).status, RECORD_STEP_EXITS.none, "no step without a recording");

  const started = run(recordStartScript(), home, display);
  assert.equal(started.status, RECORD_START_EXITS.started, started.stderr);
  assert.ok(existsSync(join(home, RECORD_DIR, "pid")));
  assert.match(readFileSync(join(home, RECORD_DIR, "start"), "utf8"), /^\d+\.\d{3}\n$/);
  assert.equal(run(recordStartScript(), home, display).status, RECORD_START_EXITS.running, "one at a time");
  assert.match(readFileSync(join(home, "ffmpeg-args"), "utf8"), /-f x11grab -framerate 15 -i :99 -t 300 /);

  const { prepared, facts, made } = stop(home, 2, "cut");
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.deepEqual({ ...facts!, start: null }, { ended: "stopped", recorded: 10, width: 1280, height: 720, start: null, cuts: [[1.5, 6], [8.5, 10]], events: [] });
  assert.equal(made!.status, RECORD_STOP_EXITS.made, made!.stderr);
  assert.deepEqual(parseRecordResult(made!.stdout), { ended: "stopped", recorded: 10, clip: 4.2, bytes: 7, size: "1280x720", captions: null });
  const encoded = readFileSync(join(home, "ffmpeg-args"), "utf8").trim().split("\n").pop()!;
  assert.ok(encoded.includes("select='not(between(t,1.500,6.000)+between(t,8.500,10.000))',setpts='(((T-STARTT)-(clip((T-STARTT)-1.500,0,4.5)+clip((T-STARTT)-8.500,0,1.5)))/2)/TB',fps=15,scale='min(1280,iw)':-2[out]"), encoded);
  assert.match(encoded, /-c:v libx264 .*-crf 28 -tune animation -pix_fmt yuv420p -movflags \+faststart/);
  assert.ok(!existsSync(join(home, RECORD_DIR, "capture.mkv")), "the capture goes once the clip is made");
  assert.equal(readFileSync(join(home, RECORD_DIR, "clip.mp4"), "utf8"), "mp4data");
  assert.equal(run(recordPrepareScript("cut"), home).status, RECORD_STOP_EXITS.none, "a second stop has nothing");

  mkdirSync(join(home, RECORD_DIR), { recursive: true });
  writeFileSync(join(home, RECORD_DIR, "capture.mkv"), "capture");
  const kept = stop(home, 1, "keep");
  assert.equal(kept.facts!.ended, "limit");
  assert.deepEqual(kept.facts!.cuts, []);
  assert.doesNotMatch(readFileSync(join(home, "ffmpeg-args"), "utf8").trim().split("\n").pop()!, /select=|freezedetect/);
});

test("box_record's steps and results are saved with the box's time while it records, drawn as pills over the clip, and kept on screen for their reading time (059)", { skip }, () => {
  const home = tempDir("record-steps");
  assert.equal(run(recordStartScript(), home, { DISPLAY: ":99" }).status, RECORD_START_EXITS.started);
  assert.equal(run(recordStepScript("step", "It keeps the draft\nwhen saving fails"), home).status, RECORD_STEP_EXITS.saved);
  assert.equal(run(recordStepScript("fail", "The editor closed and lost it"), home).status, RECORD_STEP_EXITS.saved);
  const { facts, plan, made } = stop(home, 1, "cut");
  assert.deepEqual(facts!.events.map((event) => `${event.kind}: ${event.text}`), ["step: It keeps the draft when saving fails", "fail: The editor closed and lost it"]);
  assert.ok(facts!.events.every((event) => event.at >= facts!.start!), "timed by the box's clock, after the capture began");
  assert.equal(made!.status, RECORD_STOP_EXITS.made, made!.stderr);
  assert.equal(parseRecordResult(made!.stdout)?.captions, true);
  const args = readFileSync(join(home, "ffmpeg-args"), "utf8").trim().split("\n");
  assert.equal(args.filter((line) => line.includes("print(tw)")).length, 4, "each pill's text and icon measured");
  assert.match(args.at(-1)!, /-i \S+\/pill-0\.png -i \S+\/pill-1\.png -filter_complex /);
  assert.match(args.at(-1)!, /\[v0\]\[1:v\]overlay=x=\(W-w\)\/2:y=25:enable='between\(t,/);
  assert.equal(plan!.captions.length, 2);
  assert.ok(!existsSync(join(home, RECORD_DIR, "events")), "the steps go with the capture");
});

const PREPARED: Prepared = { ended: "stopped", recorded: 30, width: 1920, height: 1080, start: 1000, cuts: [[5.5, 15]], events: [] };

test("a clip's plan maps each step through the cut stills and the speed, and holds a caption only as long as its reading time needs", () => {
  const events: Prepared["events"] = [
    { at: 1002, kind: "step", text: "Open the meetings page" },
    { at: 1010, kind: "pass", text: "It lists three meetings" },
    { at: 1016, kind: "step", text: "It should not recreate existing meetings on 404 or 403" },
    { at: 1029, kind: "fail", text: "A second meeting appeared after the 404" },
  ];
  const plan = planClip({ ...PREPARED, events }, 2);
  assert.deepEqual(plan.holds, [{ at: 1, seconds: 0.393 }, { at: 2.75, seconds: 1.643 }, { at: 9.75, seconds: 2.5 }], "the long step reads in its own time, and needs no hold");
  assert.deepEqual(plan.captions.map((caption) => [caption.kind, caption.row, caption.from, caption.to]), [
    ["step", 0, 1, 5.286],
    ["pass", 1, 3.143, 5.286],
    ["step", 0, 5.286, 14.786],
    ["fail", 1, 11.786, 14.786],
  ]);
  assert.equal(plan.length, 14.786);
  for (const [index, caption] of plan.captions.entries()) {
    const next = plan.captions.slice(index + 1).find((later) => later.from > caption.from);
    assert.ok((next?.from ?? plan.length) - caption.from >= readingSeconds(caption.text) - 0.001, `${caption.text} is on screen long enough to read`);
  }
  assert.deepEqual([plan.width, plan.height, plan.fontSize, plan.pillHeight, plan.top, plan.gap], [1280, 720, 19, 40, 25, 6]);
  const clock = "((T-STARTT)-(clip((T-STARTT)-5.500,0,9.5)))/2";
  assert.ok(clipGraph(plan, true).includes(`setpts='(${clock}+0.393*gt(${clock},1)+1.643*gt(${clock},2.75)+2.5*gt(${clock},9.75))/TB'`), clipGraph(plan, true));
  assert.match(clipGraph(plan, true), /\[v1\]\[2:v\]overlay=x=\(W-w\)\/2:y=71:enable='between\(t,3\.143,5\.286\)'\[v2\]/);
  assert.match(clipGraph(plan, true), /\[v3\]\[4:v\]overlay=.*\[out\]$/);
  assert.doesNotMatch(clipGraph(plan, false), /overlay/);

  const quiet = planClip({ ...PREPARED, cuts: [], events: [{ at: 1001, kind: "step", text: "Short" }] }, 1);
  assert.deepEqual(quiet.holds, [], "a caption with time enough to read is not held");
  assert.deepEqual(chaptersOf(plan.captions), [
    { at: 1, text: "Open the meetings page", result: { passed: true, text: "It lists three meetings" } },
    { at: 5.286, text: "It should not recreate existing meetings on 404 or 403", result: { passed: false, text: "A second meeting appeared after the 404" } },
  ]);
  assert.equal(captionText("a ".repeat(80)).length, 90);
  assert.ok(captionText("a ".repeat(80)).endsWith("…"));
});

test("on Windows box_record runs ffmpeg's gdigrab hidden, and stop closes its console before it would force it, then makes the clip as elsewhere (059)", () => {
  const start = recordStartScript("windows");
  assert.match(start, /Join-Path \$HOME '\.local\\state\\bb-box\\recording'/);
  assert.match(start, /Start-Process \$ffmpeg -WindowStyle Hidden -PassThru -RedirectStandardError "\$d\\log"/);
  assert.match(start, /-f gdigrab -framerate 15 -draw_mouse 1 -i desktop -t 300 -c:v libx264 -preset ultrafast -crf 0 /);
  assert.match(start, /exit 4 }/);
  const stop = recordStopScript({ speed: 4, stills: "cut" });
  // Without /F, ffmpeg sees its console close and ends its file whole.
  assert.ok(stop.indexOf("taskkill /PID $p.Id") < stop.indexOf("taskkill /F /PID $p.Id"), stop);
  assert.match(stop, /if \('cut' -eq 'cut'\)/);
  assert.match(stop, /-vf freezedetect=n=0\.0001:d=1 -map 0:v -f null -/);
  assert.match(stop, /setpts=N\/\(15\*4\)\/TB,fps=15,scale='min\(1280,iw\)':-2" -an -c:v libx264 -preset medium -crf 28 -tune animation -pix_fmt yuv420p -movflags \+faststart/);
  assert.match(recordStopScript({ speed: 1, stills: "keep" }), /if \('keep' -eq 'cut'\)/);
});

test("box_record's page plays the clip beside it by its name, and its height follows the clip's shape (059)", () => {
  const page = recordPage(`Box "a" <b>`, "box a&b.mp4");
  assert.ok(page.includes(`<video id="clip" src="box%20a%26b.mp4" autoplay muted loop controls playsinline`), page);
  assert.ok(page.length < 400, "a tiny page");
  assert.ok(page.includes("<title>Box &#34;a&#34; &#60;b&#62;</title>"));
  assert.equal(previewHeight("1280x720"), 368);
  assert.equal(previewHeight("960x1600"), 1075);
  assert.equal(previewHeight("odd"), 400);
  assert.equal(parseRecordResult("no json"), null);
  const listed = recordPage("Box a", "a.mp4", [{ at: 65.5, text: "Open <it>", result: { passed: false, text: "It failed" } }]);
  assert.match(listed, /<a href="#" data-at="65\.5"><span class="at">1:05<\/span><span><span style="color:#4f8df5">▶<\/span> Open &#60;it&#62;<br><span style="color:#ff453a">✗<\/span> It failed<\/span><\/a>/);
  assert.match(listed, /v\.currentTime = Number\(a\.dataset\.at\)/);
});
