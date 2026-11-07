// box_record's scripts (059), run with a fake ffmpeg and ffprobe that say
// what they were asked, and its page for the thread's preview.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { RECORD_DIR, RECORD_START_EXITS, RECORD_STEP_EXITS, RECORD_STOP_EXITS, SCENE_BUNDLE, captionText, chaptersOf, clipGraph, parsePrepared, parseRecordResult, planClip, previewHeight, readingSeconds, recordMakeScript, recordPage, recordPrepareScript, recordStartScript, recordStepScript, sceneBundle, type Prepared } from "../src/core/record.ts";
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
  const plan = planClip(facts, speed, { zoom: true, frame: false });
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
  assert.equal(made!.status, RECORD_STOP_EXITS.made, made!.stderr);
  const { drawing, encoding, ...result } = parseRecordResult(made!.stdout)!;
  assert.deepEqual(result, { ended: "stopped", recorded: 10, clip: 4.2, bytes: 7, size: "1280x720", captions: true });
  assert.ok(drawing! >= 0 && encoding! >= 0, "the time each part took");
  const encoded = readFileSync(join(home, "ffmpeg-args"), "utf8").trim().split("\n").pop()!;
  assert.ok(encoded.includes("select='not(between(t,1.500,6.000)+between(t,8.500,10.000))',setpts='(((T-STARTT)-(clip((T-STARTT)-1.500,0,4.5)+clip((T-STARTT)-8.500,0,1.5)))/2)/TB',fps=15,tpad=stop_mode=clone:stop_duration=2,trim=duration=2,scale='min(1280,iw)':-2[v0]"), encoded);
  assert.match(encoded, /-i \S+\/pill-0\.png -i \S+\/pill-1\.png -filter_complex /, "the speed and the cut drawn as marks");
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
  assert.equal(args.filter((line) => line.includes("print(tw)")).length, 6, "each pill's text and icon measured: two captions and a cut's mark");
  assert.match(args.at(-1)!, /-i \S+\/pill-0\.png -i \S+\/pill-1\.png -i \S+\/pill-2\.png -filter_complex /);
  assert.match(args.at(-1)!, /\[v0\]\[1:v\]overlay=x=\(W-w\)\/2:y=25:enable='between\(t,/);
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
  assert.match(readFileSync(join(home, "ffmpeg-args"), "utf8").trim().split("\n").pop()!, /-i \S+\/pill-0\.png .*-filter_complex .*\[1:v\]overlay=/, "the step's pill over the clip");
});

const PREPARED: Prepared = { ended: "stopped", recorded: 30, width: 1920, height: 1080, start: 1000, cuts: [[5.5, 15]], events: [] };

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
  assert.deepEqual([plan.width, plan.height, plan.fontSize, plan.edge, plan.position], [1280, 720, 19, 25, "top"]);
  assert.deepEqual(plan.overlays.slice(4), [
    { look: "mark", text: "2x", size: 13, x: "right", y: 614, from: 0, to: 14.786 },
    { look: "mark", text: "10 s later", size: 13, x: "right", y: 581, from: 3.143, to: 4.343 },
  ], "the speed in the bottom corner all along, and the cut over it for a moment");
  assert.match(clipGraph(plan, true), /\[v4\]\[5:v\]overlay=x=W-w-25:y=614:enable='between\(t,0,14\.786\)'\[v5\]/);
  const clock = "((T-STARTT)-(clip((T-STARTT)-5.500,0,9.5)))/2";
  assert.ok(clipGraph(plan, true).includes(`setpts='(${clock}+0.393*gt(${clock},1)+1.643*gt(${clock},2.75)+2.5*gt(${clock},9.75))/TB'`), clipGraph(plan, true));
  assert.match(clipGraph(plan, true), /\[v1\]\[2:v\]overlay=x=\(W-w\)\/2:y=71:enable='between\(t,3\.143,5\.286\)'\[v2\]/);
  assert.match(clipGraph(plan, true), /\[v5\]\[6:v\]overlay=.*\[out\]$/);
  assert.doesNotMatch(clipGraph(plan, false), /overlay/);
  assert.ok(clipGraph(plan, false).includes(",fps=15,tpad=stop_mode=clone:stop_duration=14.786,trim=duration=14.786,"), "a hold at the end lasts though no frame follows it");

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
    { at: 5.286, real: 16, text: "It should not recreate existing meetings on 404 or 403", result: { passed: false, text: "A second meeting appeared after the 404" } },
  ]);
  assert.equal(captionText("a ".repeat(80)).length, 90);
  assert.ok(captionText("a ".repeat(80)).endsWith("…"));
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
  assert.match(recordPrepareScript("keep", "windows"), /if \('keep' -eq 'cut'\)/);
  const prepared = parsePrepared(`{"ended":"stopped","recorded":20.5,"size":"1280x800","start":100.000,"position":"bottom","cuts":[[3.500,9.000]]}\r\n100.500\tstep\t${Buffer.from("It opens Notepad").toString("base64")}\r\n102.000\tpass\t${Buffer.from("Notepad is open").toString("base64")}\r\n`);
  assert.deepEqual(prepared?.events.map((event) => event.text), ["It opens Notepad", "Notepad is open"]);
  assert.equal(prepared?.position, "bottom");

  const plan = planClip(prepared!, 2);
  const make = recordMakeScript(plan, "windows");
  assert.match(make, /\[Drawing\.Font\]::new\('Segoe UI Semibold', \$fs, \[Drawing\.GraphicsUnit\]::Pixel\)/);
  assert.match(make, /Pill 0 '[^']+' '4pa2' '4f8df5' '5f6368' 0\.82 21\n {4}Pill 1 '[^']+' '4pyT' '34c759' '2a2a2a' 0\.94 21/);
  assert.ok(make.includes(`-i $capture -i "$d\\pill-0.png" -i "$d\\pill-1.png" -i "$d\\pill-2.png" -i "$d\\pill-3.png" -filter_complex "${clipGraph(plan, true)}" -map '[out]'`), make);
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
  assert.deepEqual(plan.scene!.art.map((art) => art.name), ["ring-left-0.png", "ring-left-1.png", "ring-left-2.png", "ring-left-3.png", "ring-left-4.png", "ring-left-5.png", "pointer.png", "corner.png"]);
  const missing = run(recordMakeScript(plan), home);
  assert.equal(missing.status, RECORD_STOP_EXITS.failed, "no drawing, no clip");
  assert.match(missing.stderr, /drawing was not delivered/);
  writeFileSync(join(dir, SCENE_BUNDLE), sceneBundle(plan)!);
  const made = run(recordMakeScript(plan), home);
  assert.equal(made.status, RECORD_STOP_EXITS.made, made.stderr);
  const encoded = readFileSync(join(home, "ffmpeg-args"), "utf8").trim().split("\n").pop()!;
  assert.ok(encoded.startsWith("-nostdin -loglevel error -y -i capture.mkv -i ring-left-0.png"), encoded);
  assert.match(encoded, /-i pointer\.png -i corner\.png -i pill-0\.png -i pill-1\.png -filter_complex_script clip\.graph -map \[out\]/);
  for (const name of ["overlay.bundle", "pointer.cmd", "clip.graph", "pointer.png"]) assert.ok(!existsSync(join(dir, name)), `${name} goes once the clip is made`);
});
