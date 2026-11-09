// box_record's scripts (059), run with a fake ffmpeg and ffprobe that say
// what they were asked, and its page for the thread's preview.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pngPixels } from "../src/core/png.ts";
import { textRuns } from "../src/core/record-font.ts";
import { markArt, markRgb } from "../src/core/record-icons.ts";
import { CHANGES_MOST, RECORD_DIR, RECORD_START_EXITS, RECORD_STEP_EXITS, RECORD_STOP_EXITS, SCENE_BUNDLE, analysisGraph, captionText, chaptersOf, clipGraph, parsePrepared, parseRecordResult, planClip, previewHeight, readingSeconds, recordMakeScript, recordPage, recordPrepareScript, recordStartScript, recordStepScript, sceneBundle, type Prepared } from "../src/core/record.ts";
import { fakeFfmpeg, tempDir } from "./helpers.ts";

const skip = process.platform === "linux" ? false : "needs GNU stat and setsid";

function run(script: string, home: string, env: Record<string, string> = {}, wfRecorder = true, darwin = false, ffmpeg8 = false) {
  const bin = fakeFfmpeg({ wfRecorder, darwin, ffmpeg8 });
  return spawnSync("bash", ["-c", script], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...env }, encoding: "utf8" });
}

function stop(home: string, speed: 1 | 2 | 4, stills: "cut" | "keep", darwin = false) {
  const prepared = run(recordPrepareScript(stills), home, {}, true, darwin);
  if (prepared.status !== 0) return { prepared, made: null, plan: null };
  const facts = parsePrepared(prepared.stdout)!;
  const plan = planClip(facts, speed, { zoom: true, frame: false, stills });
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
  assert.match(readFileSync(join(home, "ffmpeg-args"), "utf8"), /-f x11grab -draw_mouse 1 -framerate 15 -i :99 -t 300 /);

  const { prepared, facts, made } = stop(home, 2, "cut");
  assert.equal(prepared.status, 0, prepared.stderr);
  const { scene, ...plain } = facts!;
  assert.deepEqual({ ...plain, start: null }, { ended: "stopped", recorded: 10, width: 1280, height: 720, start: null, position: "top", cuts: [[1.5, 6], [8.5, 10]], events: [] });
  assert.equal(scene?.pointer, "shown", "no display to sample, so the screen's own pointer stays in the picture");
  assert.deepEqual(scene?.brightness?.map((grid) => [grid.at, grid.cells.length, grid.cells[0]]), [[0, 144, 200], [1, 144, 200]], "the brightness under the pointer, a grid a second");
  assert.match(readFileSync(join(home, "ffmpeg-args"), "utf8"), /-map \[grid\] -f rawvideo -pix_fmt gray \S+\/grid\.raw/);
  assert.equal(made!.status, RECORD_STOP_EXITS.made, made!.stderr);
  const { drawing, encoding, ...result } = parseRecordResult(made!.stdout)!;
  assert.deepEqual(result, { ended: "stopped", recorded: 10, clip: 4.2, bytes: 7, size: "1280x720", captions: true });
  assert.ok(drawing! >= 0 && encoding! >= 0, "the time each part took");
  const encoded = readFileSync(join(home, "ffmpeg-args"), "utf8").trim().split("\n").pop()!;
  assert.ok(encoded.includes("setpts=PTS-STARTPTS,select='not(between(t,1.500,6.000)+between(t,8.500,10.000))',setpts='((T-(clip(T-1.500,0,4.5)+clip(T-8.500,0,1.5)))/2)/TB',fps=15,tpad=stop_mode=clone:stop_duration=2,trim=duration=2,scale='min(1280,iw)':-2[v0]"), encoded);
  assert.match(encoded, /-i \S+\/pill-0\.png -itsoffset [\d.]+ -loop 1 -framerate 15 -t [\d.]+ -i \S+\/pill-1\.png -filter_complex /, "the speed and the cut drawn as marks, the cut fading in and out");
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
  assert.equal(args.filter((line) => line.includes("print(tw)")).length, 3, "each pill's words are measured once; the mark is an image");
  assert.match(args.at(-1)!, /-itsoffset [\d.]+ -loop 1 -framerate 15 -t [\d.]+ -i \S+\/pill-0\.png -itsoffset [\d.]+ -loop 1 -framerate 15 -t [\d.]+ -i \S+\/pill-1\.png -itsoffset [\d.]+ -loop 1 -framerate 15 -t [\d.]+ -i \S+\/pill-2\.png -filter_complex /);
  assert.match(args.at(-1)!, /\[v0\]\[q0\]overlay=x=\(W-w\)\/2:y=25:eof_action=pass:enable='between\(t,/);
  assert.equal(plan!.captions.length, 2);
  assert.ok(!existsSync(join(home, RECORD_DIR, "events")), "the steps go with the capture");
});

test("box_record's captions are drawn with FFmpeg 8 too, as on Ubuntu 26.04's Wayland desktops, whose drawtext logs the text's width after an [Eval @ ...] prefix", { skip }, () => {
  const home = tempDir("record-ffmpeg8");
  assert.equal(run(recordStartScript(), home, { DISPLAY: ":99" }).status, RECORD_START_EXITS.started);
  assert.equal(run(recordStepScript("step", "Typing a line"), home).status, RECORD_STEP_EXITS.saved);
  const prepared = run(recordPrepareScript("cut"), home);
  assert.equal(prepared.status, 0, prepared.stderr);
  const made = run(recordMakeScript(planClip(parsePrepared(prepared.stdout)!, 1, { zoom: true, frame: false })), home, {}, true, false, true);
  assert.equal(made.status, RECORD_STOP_EXITS.made, made.stderr);
  assert.equal(parseRecordResult(made.stdout)?.captions, true, "the pills are measured and drawn");
  assert.match(readFileSync(join(home, "ffmpeg-args"), "utf8").trim().split("\n").pop()!, /-i \S+\/pill-0\.png .*-filter_complex .*\[1:v\]format=rgba,fade=t=in.*\[q0\]overlay=/, "the step's pill over the clip");
});

const PREPARED: Prepared = { ended: "stopped", recorded: 30, width: 1920, height: 1080, start: 1000, cuts: [[5.5, 15]], events: [] };

test("a capture that never writes a picture stops itself (075)", { skip }, () => {
  const home = tempDir("record-hung");
  const started = run(recordStartScript(), home, { DISPLAY: ":99" });
  assert.equal(started.status, RECORD_START_EXITS.started, started.stderr);
  const pid = Number(readFileSync(join(home, RECORD_DIR, "pid"), "utf8"));
  const gone = spawnSync("bash", ["-c", `for i in $(seq 1 24); do kill -0 ${pid} 2>/dev/null || exit 0; sleep 0.5; done; exit 1`]);
  assert.equal(gone.status, 0, "the recorder is stopped when the capture stays empty");
});

test("the stop reads what changed on the screen at every frame of the capture, so a change is placed to the frame, and its brightness four times a second (076)", () => {
  const graph = analysisGraph("cut");
  assert.match(graph, /\[a\]scale=480:-2:flags=area,format=gray,split=3\[c\]\[l\]\[g\];\[c\]tblend=all_mode=difference,bbox=min_val=6,nullsink;/, "no frame rate filter before the changes");
  assert.match(graph, /\[l\]fps=4,signalstats/);
  assert.equal(CHANGES_MOST, 15 * 300, "a change on every frame of a 5-minute recording fits");
});

test("box_record starts in zsh with no pills to clear and no glob error, and on a Mac starts ffmpeg in a session of its own with no nohup, which refuses where there is no console to leave, as under Namespace's agent (#1032)", () => {
  const home = tempDir("record-zsh");
  const shell = spawnSync("zsh", ["-fc", ":"]).status === 0 ? "zsh" : "sh";
  const started = spawnSync(shell, ["-c", recordStartScript("linux")], { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" });
  assert.equal(started.status, RECORD_START_EXITS.noDisplay, started.stderr);
  assert.doesNotMatch(started.stderr, /no matches found/);
  const mac = recordStartScript("macos");
  assert.match(mac, /perl -MPOSIX -e '\$SIG\{HUP\} = "IGNORE"; POSIX::setsid\(\); exec @ARGV' ffmpeg /);
  assert.doesNotMatch(mac, /exec @ARGV' nohup/);
});

test("a clip's plan maps each step through the cut stills and the speed, and holds a caption only as long as its reading time needs, a result for at most a second (076)", () => {
  const events: Prepared["events"] = [
    { at: 1002, kind: "step", text: "Open the meetings page" },
    { at: 1010, kind: "pass", text: "It lists three meetings" },
    { at: 1016, kind: "step", text: "It should not recreate existing meetings on 404 or 403" },
    { at: 1029, kind: "fail", text: "A second meeting appeared after the 404" },
  ];
  const plan = planClip({ ...PREPARED, events }, 2);
  assert.deepEqual(plan.holds, [{ at: 2.75, seconds: 1 }, { at: 9.75, seconds: 1 }], "each step reads while it stays up, until the next step, and needs no hold; a result is held a second at most");
  assert.deepEqual(plan.captions.map((caption) => [caption.kind, caption.row, caption.from, caption.to]), [
    ["step", 0, 1, 4.25],
    ["pass", 1, 2.75, 4.25],
    ["step", 0, 4.25, 12.25],
    ["fail", 1, 10.75, 12.25],
  ]);
  assert.ok(plan.captions[3]!.to - plan.captions[3]!.from <= 2.5 + 0.001, "a result fades after about 2.5 s");
  assert.ok(plan.captions[2]!.to - plan.captions[2]!.from > 2.5, "a step caption stays until the next step");
  assert.equal(plan.length, 12.25);
  for (const caption of plan.captions) assert.ok(caption.to - caption.from >= Math.min(readingSeconds(caption.text), 1.5) - 0.001, `${caption.text} is on screen long enough to read`);
  assert.deepEqual([plan.width, plan.height, plan.fontSize, plan.edge, plan.position], [1280, 720, 19, 25, "top"]);
  assert.deepEqual(plan.overlays.slice(4), [
    { look: "mark", text: "2x", size: 13, x: "right", y: 614, from: 0, to: 12.25, fade: 0 },
    { look: "mark", text: "10 s later", size: 13, x: "right", y: 581, from: 2.75, to: 3.95, fade: 0.2 },
  ], "the speed in the bottom corner all along, and the cut over it for a moment");
  assert.match(clipGraph(plan, true), /\[v4\]\[5:v\]overlay=x=W-w-25:y=614:enable='between\(t,0,12\.25\)'\[v5\]/);
  const clock = "(T-(clip(T-5.500,0,9.5)))/2";
  assert.ok(clipGraph(plan, true).includes(`setpts='(${clock}+1*gt(${clock},2.75)+1*gt(${clock},9.75))/TB'`), clipGraph(plan, true));
  assert.match(clipGraph(plan, true), /\[2:v\]format=rgba,fade=t=in:st=2\.75:d=0\.2:alpha=1,fade=t=out:st=4\.25:d=0\.2:alpha=1\[q1\];\[v1\]\[q1\]overlay=x=\(W-w\)\/2:y=71:eof_action=pass:enable='between\(t,2\.75,4\.45\)'\[v2\]/);
  assert.match(clipGraph(plan, true), /\[v5\]\[q5\]overlay=.*\[out\]$/);
  assert.doesNotMatch(clipGraph(plan, false), /overlay/);
  assert.ok(clipGraph(plan, false).includes(",fps=15,tpad=stop_mode=clone:stop_duration=12.25,trim=duration=12.25,"), "a hold at the end lasts though no frame follows it");

  const quiet = planClip({ ...PREPARED, cuts: [], events: [{ at: 1001, kind: "step", text: "Short" }] }, 1);
  assert.deepEqual(quiet.holds, [], "a caption with time enough to read is not held");
  assert.deepEqual(quiet.overlays.filter((overlay) => overlay.look === "mark"), [], "nothing cut and no speed: no mark");
  const short = planClip({ ...PREPARED, cuts: [[5.5, 8]], events: [] }, 1);
  assert.deepEqual(short.overlays, [], "a cut under 3 s has no mark");

  const below = planClip({ ...PREPARED, position: "bottom", events }, 1);
  assert.deepEqual(below.overlays.filter((overlay) => overlay.look !== "mark").map((overlay) => `${overlay.look}:${overlay.y}`), ["step:555", "pass:601", "step:555", "fail:601"], "at the bottom, above a dock, the step over its result");
  assert.deepEqual(below.overlays.filter((overlay) => overlay.look === "mark").map((overlay) => `${overlay.text}:${overlay.y}`), ["10 s later:36"], "the mark in the top corner, away from the captions");
  assert.deepEqual(chaptersOf(plan.captions), [
    { at: 1, real: 2, text: "Open the meetings page", result: { passed: true, text: "It lists three meetings" } },
    { at: 4.25, real: 16, text: "It should not recreate existing meetings on 404 or 403", result: { passed: false, text: "A second meeting appeared after the 404" } },
  ]);
  assert.equal(captionText("a ".repeat(80)).length, 90);
  assert.ok(captionText("a ".repeat(80)).endsWith("…"));

  const stayed = planClip({ ...PREPARED, cuts: [], recorded: 30, events: [
    { at: 1001, kind: "step", text: "Type a line into the note" },
    { at: 1004, kind: "fail", text: "The save was cancelled" },
  ] }, 1);
  const failed = stayed.captions.find((caption) => caption.kind === "fail")!;
  const step = stayed.captions.find((caption) => caption.kind === "step")!;
  assert.equal(failed.to, step.to, "a result stays as long as its step, until the next step or the end (076)");
  const replaced = planClip({ ...PREPARED, cuts: [], events: [
    { at: 1001, kind: "step", text: "Type a line into the note" },
    { at: 1012, kind: "step", text: "Drag the window" },
  ] }, 1);
  assert.equal(replaced.captions[0]!.to, replaced.captions[1]!.from, "the next step replaces the step caption");

  const both = planClip({ ...PREPARED, cuts: [], events: [
    { at: 1002, kind: "step", text: "Cancel the save" },
    { at: 1004, kind: "note", text: "The dialog was cancelled" },
    { at: 1004.4, kind: "fail", text: "The save was cancelled" },
  ] }, 1);
  assert.equal(both.captions.some((caption) => caption.kind === "fail"), false, "a cancel the step asked for is not a failure");
  assert.equal(both.overlays.filter((overlay) => overlay.text.includes("cancelled")).length, 1, "one event has one caption");
  const realFailure = planClip({ ...PREPARED, cuts: [], events: [
    { at: 1002, kind: "step", text: "Save the note" },
    { at: 1004, kind: "note", text: "The dialog was still open" },
    { at: 1004.4, kind: "fail", text: "The folder was missing" },
  ] }, 1);
  assert.equal(realFailure.captions.some((caption) => caption.kind === "fail"), true, "a real failure stays a failure");
  assert.equal(realFailure.overlays.some((overlay) => overlay.look === "note"), false, "the note for that same moment is not a second caption");
});

test("a step's reading time runs while it stays up, through its result, so a quick result does not freeze the step before it (076)", () => {
  const plan = planClip({ ...PREPARED, cuts: [], events: [
    { at: 1001, kind: "step", text: "Type a line into the note" },
    { at: 1001.3, kind: "pass", text: "The line is in" },
    { at: 1003.8, kind: "step", text: "Save it" },
  ] }, 1);
  assert.equal(plan.holds.find((hold) => hold.at === 1), undefined, `the step is up 2.8 s, through its result: ${JSON.stringify(plan.holds)}`);
  const quick = planClip({ ...PREPARED, cuts: [], events: [
    { at: 1001, kind: "step", text: "Type a line into the note" },
    { at: 1001.1, kind: "pass", text: "The line is in" },
    { at: 1001.2, kind: "step", text: "Save it" },
  ] }, 1);
  const stepHold = quick.holds.find((hold) => hold.at === 1)!;
  assert.ok(Math.abs(stepHold.seconds + 0.2 + 1 - readingSeconds("Type a line into the note")) < 0.01, `a step whose whole span is short still gets its reading time: ${JSON.stringify(quick.holds)}`);
  const warned = planClip({ ...PREPARED, cuts: [], events: [
    { at: 1001, kind: "step", text: "Cancel the save" },
    { at: 1004, kind: "fail", text: "The save was cancelled at the last moment" },
    { at: 1004.1, kind: "step", text: "Widen the window" },
  ] }, 1);
  assert.ok(warned.overlays.some((overlay) => overlay.look === "note"), "a cancel the step asked for is a warning");
  assert.ok(warned.holds.every((hold) => hold.seconds <= 1 + 0.001), `a warning is held at most a second, as a result is: ${JSON.stringify(warned.holds)}`);
  const warning = warned.overlays.find((overlay) => overlay.look === "note")!;
  const next = warned.overlays.find((overlay) => overlay.text === "Widen the window")!;
  assert.equal(warning.to, next.from, "and stays until the next step, as a result does");
});

test("a result stays until the next step, and captions fade in and out over 0.2 s, so one step crossfades into the next (076)", () => {
  const plan = planClip({ ...PREPARED, cuts: [], events: [
    { at: 1001, kind: "step", text: "Open the file" },
    { at: 1003, kind: "pass", text: "It opened" },
    { at: 1009, kind: "step", text: "Close the file" },
    { at: 1011, kind: "pass", text: "It closed" },
  ] }, 1);
  const [first, opened, second] = plan.captions;
  assert.equal(opened!.to, second!.from, "the result stays until the next step");
  assert.equal(first!.to, second!.from);
  const graph = clipGraph(plan, true);
  const fadeOf = (index: number) => new RegExp(`\\[${index + 1}:v\\]format=rgba,fade=t=in:st=([\\d.]+):d=0\\.2:alpha=1,fade=t=out:st=([\\d.]+):d=0\\.2:alpha=1\\[q${index}\\]`).exec(graph);
  const out = fadeOf(0)!;
  const into = fadeOf(2)!;
  assert.equal(Number(out[2]), Number(into[1]), "the old step fades out as the new one fades in");
  assert.ok(plan.overlays.every((overlay) => overlay.fade === 0.2));
  const made = recordMakeScript(plan);
  assert.ok(made.includes(`-itsoffset ${second!.from} -loop 1 -framerate 15 -t `), "each faded pill is a still image looped from its own time");
});

test("on Windows box_record runs ffmpeg's gdigrab hidden, and stop closes its console before it would force it, then captions and makes the clip as elsewhere (059)", () => {
  const start = recordStartScript("windows", "bottom");
  assert.match(start, /Join-Path \$HOME '\.local\\state\\bb-box\\recording'/);
  assert.match(start, /Start-Process \$ffmpeg -WindowStyle Hidden -PassThru -RedirectStandardError "\$d\\log"/);
  assert.match(start, /-f gdigrab -framerate 15 -draw_mouse ' \+ \$draw \+ ' -i desktop -t 300 -c:v libx264 -preset ultrafast -crf 0 /);
  assert.match(start, /\$draw = if \(\$mode -eq 'drawn'\) \{ 0 \} else \{ 1 \}/, "the screen's own pointer left out only where the sampler runs");
  assert.match(start, /exit 4 }/);
  assert.match(start, /Set-Content "\$d\\position" 'bottom'/);
  assert.ok(start.indexOf('Set-Content "$d\\start" (Now)') > start.indexOf("Set-Content \"$d\\pointer-mode\" $mode"), "the start is the moment ffmpeg starts, after the sampler");
  assert.match(start, /CultureInfo\]::InvariantCulture/);

  const step = recordStepScript("fail", "Saving   kept the draft", "windows");
  assert.match(step, /if \(-not \(Recording\)\) \{ exit 3 \}/);
  assert.ok(step.includes(`Add-Content "$d\\events" ((Now) + "\`tfail\`t${Buffer.from("Saving kept the draft").toString("base64")}")`), step);

  const prepare = recordPrepareScript("cut", "windows");
  assert.ok(prepare.indexOf("taskkill /PID $p.Id") < prepare.indexOf("taskkill /F /PID $p.Id"), prepare);
  assert.match(prepare, /if \('cut' -eq 'cut'\)/);
  assert.match(prepare, /-vf freezedetect=n=0\.0001:d=1 -map 0:v -f null -/);
  assert.match(prepare, /"start":\{3\},"position":"\{4\}","cuts":\[\{5\}\]/);
  assert.ok(prepare.includes("$grid = Join-Path $d 'grid.raw'"), "the grid's path, as a backslash before an interpolation would hide it");
  assert.match(prepare, /-map '\[grid\]' -f rawvideo -pix_fmt gray \$grid 2>&1/);
  assert.ok(prepare.includes("'G {0} {1}' -f ($i / 144), [BitConverter]::ToString($cells, $i, 144)"), "each second's grid as a line, as on Linux and macOS");
  assert.match(recordPrepareScript("keep", "windows"), /if \('keep' -eq 'cut'\)/);
  const prepared = parsePrepared(`{"ended":"stopped","recorded":20.5,"size":"1280x800","start":100.000,"position":"bottom","cuts":[[3.500,9.000]]}\r\n100.500\tstep\t${Buffer.from("It opens Notepad").toString("base64")}\r\n102.000\tpass\t${Buffer.from("Notepad is open").toString("base64")}\r\n`);
  assert.deepEqual(prepared?.events.map((event) => event.text), ["It opens Notepad", "Notepad is open"]);
  assert.equal(prepared?.position, "bottom");

  const plan = planClip(prepared!, 2);
  const make = recordMakeScript(plan, "windows");
  assert.match(make, /\[Drawing\.Font\]::new\('Segoe UI Semibold', \$fs, \[Drawing\.GraphicsUnit\]::Pixel\)/);
  assert.match(make, /Inter-Medium\.ttf/);
  assert.match(make, /Pill 0 mark-play-\d+\.png \d+ '5f6368' 0\.82 21 'medium'/);
  assert.match(make, /Pill 1 mark-check-\d+\.png \d+ '2a2a2a' 0\.94 21 'medium'/);
  assert.doesNotMatch(make, /'4pa2'/);
  assert.match(make, /-i \$capture( -itsoffset [\d.]+ -loop 1 -framerate 15 -t [\d.]+ -i "\$d\\pill-[01]\.png"){2} -i "\$d\\pill-2\.png" -itsoffset [\d.]+ -loop 1 -framerate 15 -t [\d.]+ -i "\$d\\pill-3\.png" -filter_complex /, "each caption and mark fading in and out, and the speed all along");
  assert.ok(make.includes(`-filter_complex "${clipGraph(plan, true)}" -map '[out]'`), make);
  assert.ok(make.includes(`-i $capture -filter_complex "${clipGraph(plan, false)}" -map '[out]'`), make);
  assert.match(make, /\$drawn = switch \(\$captions\) \{ '1' \{ 'true' \} 'none' \{ 'null' \} default \{ 'false' \} \}/);
  assert.match(recordMakeScript(planClip({ ...prepared!, events: [], cuts: [] }, 1), "windows"), /\$captions = 'none'/);
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
  const listed = recordPage("Box a", "a.mp4", [{ at: 65.5, real: 125, text: "Open <it>", result: { passed: false, text: "It failed" } }]);
  assert.match(listed, /<a href="#" data-at="65\.5"><span class="at">2:05<\/span><span><span style="color:#4f8df5">▶<\/span> Open &#60;it&#62;<br><span style="color:#ff453a">✗<\/span> It failed<\/span><\/a>/);
  assert.match(listed, /v\.currentTime = Number\(a\.dataset\.at\)/);
});

test("a clip with a drawn pointer, rings and a frame is made from the drawing the plugin puts in the box, its graph read from a file (073)", { skip }, () => {
  const home = tempDir("record-scene");
  const dir = join(home, RECORD_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "capture.mkv"), "capture");
  const prepared: Prepared = {
    ...PREPARED,
    cuts: [],
    events: [{ at: 1001, kind: "step", text: "It saves the note" }],
    scene: { pointer: "drawn", screen: null, samples: [{ at: 1000, x: 100, y: 100, buttons: 0 }], changes: [], luma: 50, lag: 0, keys: "pc", inputs: [{ at: 1004, by: "agent", type: "click", space: "screen", button: "left", count: 1, x: 640, y: 400, area: null }, { at: 1006, by: "agent", type: "keys", chord: { key: "S", modifiers: ["ctrl"] } }] },
  };
  const plan = planClip(prepared, 1);
  assert.equal(plan.fps, 30);
  assert.deepEqual(plan.scene!.art.map((art) => art.name), ["ring-left-light-0.png", "ring-left-light-1.png", "ring-left-light-2.png", "ring-left-light-3.png", "ring-left-light-4.png", "ring-left-light-5.png", "cursor-arrow-light.png", "corner.png"]);
  const missing = run(recordMakeScript(plan), home);
  assert.equal(missing.status, RECORD_STOP_EXITS.failed, "no drawing, no clip");
  assert.match(missing.stderr, /drawing was not delivered/);
  writeFileSync(join(dir, SCENE_BUNDLE), sceneBundle(plan)!);
  const made = run(recordMakeScript(plan), home);
  assert.equal(made.status, RECORD_STOP_EXITS.made, made.stderr);
  const encoded = readFileSync(join(home, "ffmpeg-args"), "utf8").trim().split("\n").pop()!;
  assert.ok(encoded.startsWith("-nostdin -loglevel error -y -i capture.mkv -i ring-left-light-0.png"), encoded);
  assert.match(encoded, /-i cursor-arrow-light\.png -i corner\.png -itsoffset [\d.]+ -loop 1 -framerate 30 -t [\d.]+ -i pill-0\.png -itsoffset [\d.]+ -loop 1 -framerate 30 -t [\d.]+ -i pill-1\.png -filter_complex_script clip\.graph -map \[out\]/);
  for (const name of ["overlay.bundle", "pointer.cmd", "clip.graph", "cursor-arrow-light.png"]) assert.ok(!existsSync(join(dir, name)), `${name} goes once the clip is made`);
});

function hole(png: Buffer): boolean {
  const { width, height, rgba } = pngPixels(png);
  const alpha = (x: number, y: number) => rgba[(y * width + x) * 4 + 3] ?? 0;
  const seen = new Uint8Array(width * height);
  const stack: [number, number][] = [[0, 0]];
  seen[0] = 1;
  while (stack.length) {
    const [x, y] = stack.pop()!;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const at = ny * width + nx;
      if (seen[at] || alpha(nx, ny) > 32) continue;
      seen[at] = 1;
      stack.push([nx, ny]);
    }
  }
  for (let at = 0; at < width * height; at++) if ((rgba[at * 4 + 3] ?? 0) <= 32 && !seen[at]) return true;
  return false;
}

test("a clip's marks are the owner's icons, tinted, and its words are Inter, with a fallback per glyph (073)", () => {
  const play = markArt("play", 19, markRgb("4f8df5"));
  assert.equal(play.width, Math.round(19 * 1.1) * 2);
  assert.equal(play.height, play.width);
  const painted = pngPixels(play.png);
  let blue = false;
  for (let i = 0; i < painted.rgba.length; i += 4) {
    if ((painted.rgba[i + 3] ?? 0) > 200 && painted.rgba[i] === 0x4f && painted.rgba[i + 1] === 0x8d && painted.rgba[i + 2] === 0xf5) blue = true;
  }
  assert.equal(blue, true, "the play mark takes the caption's blue");
  assert.equal(hole(markArt("keyboard", 80, markRgb("d0d0d4")).png), true, "the keys are cut out of the filled keyboard");
  assert.equal(hole(markArt("warn", 80, markRgb("ff9f0a")).png), true, "the exclamation is cut out of the filled warning");
  const failed = markArt("failed", 36, markRgb("ff453a"));
  const scale = failed.width / 18;
  const along = Math.hypot(-10, 10);
  const px = Math.round(14 * scale - (-10 / along) * 0.95 * scale);
  const py = Math.round(4 * scale - (10 / along) * 0.95 * scale);
  const ink = pngPixels(failed.png);
  const at = (py * ink.width + px) * 4;
  assert.ok((ink.rgba[at + 3] ?? 0) > 100, "the cross's 2.25 stroke reaches past a thinner stroke");
  assert.deepEqual(textRuns("⌘A", "regular"), [{ font: "regular", text: "⌘A" }]);
  assert.equal(textRuns("⌨", "regular")[0]?.font, "fallback");
  assert.ok(textRuns("⌘⌥⇧⌃←→↑↓⌫⌦×↵⇥", "medium").every((run) => run.font === "medium"));
  const noted: Prepared = { ...PREPARED, cuts: [], events: [{ at: 1001, kind: "note", text: "The window stayed open" }] };
  const plan = planClip(noted, 1);
  assert.ok(plan.overlays.some((overlay) => overlay.look === "note" && overlay.text === "The window stayed open"));
  const linux = recordMakeScript(plan);
  assert.match(linux, /Inter-Regular\.ttf/);
  assert.match(linux, /fc-match -f '%\{file\}' 'DejaVu Sans'/);
  assert.match(linux, /mark-warn-/);
  assert.doesNotMatch(linux, /pill-\$1\.icon/);
  const windows = recordMakeScript(plan, "windows");
  assert.match(windows, /Inter-Medium\.ttf/);
  assert.match(windows, /mark-warn-/);
});
