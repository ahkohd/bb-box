import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { after, describe, test } from "node:test";
import { DEVICE_SERVER_VERSION, testDeviceOffer, type OfferedDevices } from "../src/core/device.ts";
import { DeviceLink } from "../src/core/device-link.ts";
import { parseDeviceRequest, parseDeviceServerMessage, deviceRequestText, deviceServerMessageText } from "../src/core/device-parse.ts";
import { DEVICE_RECORDING_LOG, RECORD_DIR, parseRecordingLog, segmentFile, type RecordingEntry } from "../src/core/device-recording.ts";
import { DEVICE_CLIP_HEIGHT_MOST, DEVICE_CLIP_WIDTH, bandHeight, composeGraph, deviceComposeScript, devicePrepared, parseComposed, planDeviceClip, touchTracks, type DeviceComposition } from "../src/core/record-device.ts";
import { parseRecordResult, planClip, recordMakeScript } from "../src/core/record.ts";
import { devicePaths } from "../src/device/paths.ts";
import { DeviceServer } from "../src/device/server.ts";
import { TestDriver } from "../src/device/test-driver.ts";
import { sizeBytes } from "../src/device/mkv.ts";
import type { ByteChannel } from "../src/transports/types.ts";
import { tempDir } from "./helpers.ts";

const servers: DeviceServer[] = [];
after(async () => {
  for (const server of servers) await server.stop();
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const needsFfmpeg = hasFfmpeg ? false : "needs ffmpeg and ffprobe";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function channelTo(path: string): Promise<ByteChannel> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once("error", reject);
    socket.once("connect", () => {
      const web = Duplex.toWeb(socket);
      resolve({ readable: web.readable as ReadableStream<Uint8Array>, writable: web.writable as WritableStream<Uint8Array>, close: async () => void socket.destroy() });
    });
  });
}

async function serve(home: string, options: { limitMs?: number } = {}) {
  const paths = devicePaths(home);
  const offer = testDeviceOffer("ios");
  const driver = new TestDriver(offer.platform);
  const log: string[] = [];
  const server = new DeviceServer({ paths, platform: offer.platform, devices: offer.devices as OfferedDevices, driver, version: DEVICE_SERVER_VERSION, log: (line) => log.push(line), recording: { limitMs: options.limitMs } });
  servers.push(server);
  await server.start();
  for (let tries = 0; server.state.power.is !== "booted" && tries < 200; tries++) await wait(10);
  const control = await DeviceLink.open(await channelTo(paths.socket), { role: "control", started: Date.now(), instance: `test-${servers.length}` });
  return { server, paths, driver, log, control };
}

function readLog(home: string) {
  return parseRecordingLog(readFileSync(join(home, RECORD_DIR, DEVICE_RECORDING_LOG), "utf8"));
}

function ofType<T extends RecordingEntry["type"]>(entries: readonly RecordingEntry[], type: T): Extract<RecordingEntry, { type: T }>[] {
  return entries.filter((entry): entry is Extract<RecordingEntry, { type: T }> => entry.type === type);
}

function runIn(home: string, script: string) {
  return spawnSync("sh", ["-c", script], { env: { ...process.env, HOME: home }, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

async function tap(control: DeviceLink, x: number, y: number) {
  const generation = control.state.geometry?.generation ?? 0;
  const said = await control.request({ type: "input", input: { type: "tap", at: { x, y, generation } }, owner: 1 });
  assert.equal(said.ok, true, JSON.stringify(said));
}

describe("recording a device (063, 7.4)", () => {
  test("record requests and their answers parse and print back", () => {
    for (const request of [
      { id: "a", type: "record", to: "start", position: "bottom" },
      { id: "b", type: "record", to: "start" },
      { id: "c", type: "record", to: "caption", kind: "pass", text: "Saved" },
      { id: "d", type: "record", to: "stop" },
    ] as const) {
      const parsed = parseDeviceRequest(deviceRequestText(request));
      assert.ok(parsed.ok, parsed.ok ? "" : parsed.words);
      assert.deepEqual(parsed.value, request);
    }
    const bad = parseDeviceRequest(deviceRequestText({ id: "e", type: "record", to: "caption", kind: "maybe", text: "x" } as never));
    assert.equal(bad.ok, false);
    const state = { platform: "ios", model: "iPhone 18 Pro", power: { is: "stopped" }, geometry: null, settings: { appearance: { known: false, why: "x" }, textSize: { known: false, why: "x" }, location: { set: null, at: null }, statusBar: { set: null, at: null } }, at: 1 } as const;
    const message = { verb: "BB_DEVICE_ANSWER", answer: { id: "d", ok: true, ms: 3, state, result: { type: "recording", recording: { active: false, ended: "stopped", seconds: 12.5, segments: 2, lost: ["The device restarted here"] } } } } as const;
    const read = parseDeviceServerMessage(deviceServerMessageText(message));
    assert.ok(read.ok, read.ok ? "" : read.words);
    assert.deepEqual(read.value, message);
  });

  test("an EBML size takes the fewest bytes, with its length marker", () => {
    assert.deepEqual([...sizeBytes(0)], [0x80]);
    assert.deepEqual([...sizeBytes(126)], [0xfe]);
    assert.deepEqual([...sizeBytes(127)], [0x40, 0x7f]);
    assert.deepEqual([...sizeBytes(300)], [0x41, 0x2c]);
  });

  test("records the device's own frames into segments, a new one at each turn, with touches and captions on one timeline, and no viewer open", async () => {
    const home = tempDir("device-recording");
    const { control } = await serve(home);
    const started = await control.request({ type: "record", to: "start", position: "top" });
    assert.ok(started.ok && started.result.type === "recording" && started.result.recording.active, JSON.stringify(started));
    const again = await control.request({ type: "record", to: "start" });
    assert.equal(!again.ok && again.error.code, "busy");
    assert.ok(existsSync(join(home, RECORD_DIR, "pid")), "a delivery waits while the pid file names a live process");
    await wait(1200);
    assert.equal((await control.request({ type: "record", to: "caption", kind: "step", text: "It turns right" })).ok, true);
    await tap(control, 100, 200);
    assert.equal((await control.request({ type: "control", control: { action: "rotate", turn: "right" } })).ok, true);
    await wait(1200);
    assert.equal((await control.request({ type: "record", to: "caption", kind: "pass", text: "Turned right" })).ok, true);
    const stopped = await control.request({ type: "record", to: "stop" });
    assert.ok(stopped.ok && stopped.result.type === "recording", JSON.stringify(stopped));
    assert.equal(stopped.result.recording.active, false);
    assert.equal(stopped.result.recording.ended, "stopped");
    assert.ok(!existsSync(join(home, RECORD_DIR, "pid")));

    const log = readLog(home);
    assert.equal(log.unread, 0);
    const segments = ofType(log.entries, "segment");
    assert.ok(segments.length >= 2, JSON.stringify(segments));
    assert.equal(segments[0]!.geometry.physical, "upright");
    assert.equal(segments.at(-1)!.geometry.physical, "turned-right");
    assert.notDeepEqual(segments[0]!.geometry.video, segments.at(-1)!.geometry.video);
    for (const segment of segments) assert.ok(existsSync(join(home, RECORD_DIR, segmentFile(segment.n))));
    const touches = ofType(log.entries, "touch");
    assert.ok(touches.some((touch) => touch.contacts[0]?.x === 100 && touch.contacts[0]?.y === 200));
    assert.ok(touches.some((touch) => touch.contacts.length === 0), "the lift is logged");
    assert.deepEqual(ofType(log.entries, "caption").map((caption) => caption.kind), ["step", "pass"]);
    const times = log.entries.map((entry) => entry.at);
    assert.deepEqual(times, [...times].sort((a, b) => a - b), "one timeline, in order");
    assert.ok(log.end && log.end.at >= 2400 && log.end.at < 6000, `${log.end?.at}`);

    const after = await control.request({ type: "record", to: "stop" });
    assert.ok(after.ok, "a stop after the end still answers with the recording");
    assert.equal((await control.request({ type: "record", to: "caption", kind: "step", text: "late" })).ok, false);
    await control.close();
  });

  test("a recording carries on across a restart of the server, with the gap noted, and ends by itself at its limit", async () => {
    const home = tempDir("device-recording-restart");
    const first = await serve(home, { limitMs: 4000 });
    assert.equal((await first.control.request({ type: "record", to: "start" })).ok, true);
    await wait(900);
    await first.control.close();
    await first.server.stop();
    const second = await serve(home, { limitMs: 4000 });
    for (let tries = 0; tries < 60 && !readLog(home).end; tries++) await wait(100);
    const log = readLog(home);
    const lost = ofType(log.entries, "lost");
    assert.equal(lost.length, 1);
    assert.equal(lost[0]!.why, "server");
    assert.match(lost[0]!.words, /device server restarted/);
    const segments = ofType(log.entries, "segment");
    assert.ok(segments.length >= 2 && segments.at(-1)!.at > lost[0]!.at, JSON.stringify(segments));
    assert.equal(log.end?.ended, "limit");
    assert.equal(log.end?.at, 4000);
    const stopped = await second.control.request({ type: "record", to: "stop" });
    assert.ok(stopped.ok && stopped.result.type === "recording" && stopped.result.recording.ended === "limit");
    await second.control.close();
  });

  test("a device that restarts mid-recording leaves a captioned gap", async () => {
    const home = tempDir("device-recording-reboot");
    const { control } = await serve(home);
    assert.equal((await control.request({ type: "record", to: "start" })).ok, true);
    await wait(600);
    assert.equal((await control.request({ type: "control", control: { action: "reboot" } })).ok, true);
    await wait(900);
    assert.equal((await control.request({ type: "record", to: "stop" })).ok, true);
    const lost = ofType(readLog(home).entries, "lost");
    assert.equal(lost[0]?.why, "device");
    assert.equal(lost[0]?.words, "The device restarted here");
    await control.close();
  });

  test("the canvas fits the largest shape, at most 1280 by 1600, with the captions' band apart from the device", () => {
    const at = (entries: RecordingEntry[]) => parseRecordingLog(entries.map((entry) => JSON.stringify(entry)).join("\n"));
    const start: RecordingEntry = { type: "start", at: 0, wall: 1, system: 1, position: "top" };
    const upright: RecordingEntry = { type: "segment", at: 50, n: 1, model: "iPhone 18 Pro", geometry: { physical: "upright", content: "upright", video: { width: 1206, height: 2622 } } };
    const turned: RecordingEntry = { type: "segment", at: 4000, n: 2, model: "iPhone 18 Pro", geometry: { physical: "turned-left", content: "turned-left", video: { width: 2622, height: 1206 } } };
    const end: RecordingEntry = { type: "end", at: 9000, ended: "stopped" };
    const one = planDeviceClip(at([start, upright, end])) as DeviceComposition;
    assert.equal(one.width, DEVICE_CLIP_WIDTH.least);
    assert.equal(one.height, DEVICE_CLIP_HEIGHT_MOST);
    assert.equal(one.layout.band.y, 0);
    assert.equal(one.layout.band.height, bandHeight(18));
    const phone = one.segments[0]!;
    assert.equal(phone.turns, 0);
    assert.ok(phone.y > one.layout.band.height, "the device sits below the band");
    assert.ok(Math.abs(phone.width / phone.height - 1206 / 2622) < 0.01);
    assert.equal(phone.artFrom, 0);
    const both = planDeviceClip(at([{ ...start, position: "bottom" }, upright, turned, end])) as DeviceComposition;
    assert.equal(both.width, DEVICE_CLIP_WIDTH.most);
    assert.ok(both.height <= DEVICE_CLIP_HEIGHT_MOST);
    assert.equal(both.layout.band.y, both.height - both.layout.band.height);
    const [first, second] = both.segments;
    assert.deepEqual([first!.from, first!.to, second!.from, second!.to], [0.05, 4, 4, 9]);
    assert.equal(second!.turns, 0, "iOS turns its picture with the device, so the turned video is drawn as it comes");
    assert.equal(second!.art.turns, 3, "the body turns a quarter anticlockwise");
    assert.ok(second!.width > second!.height);
    const contentHeld: RecordingEntry = { ...turned, geometry: { physical: "turned-left", content: "upright", video: { width: 1206, height: 2622 } } };
    const held = planDeviceClip(at([start, upright, contentHeld, end])) as DeviceComposition;
    assert.equal(held.segments[1]!.turns, 3, "a picture drawn upright on a turned device turns with the body");
    assert.equal(typeof planDeviceClip(at([start, end])), "string");
  });

  test("touches become intervals at the canvas's points, held 0.3 s after the lift, never overlapping", () => {
    const entries: RecordingEntry[] = [
      { type: "start", at: 0, wall: 1, system: 1, position: "top" },
      { type: "touch", at: 1000, n: 1, contacts: [{ id: 0, x: 10, y: 20 }] },
      { type: "touch", at: 1060, n: 1, contacts: [] },
      { type: "touch", at: 1200, n: 1, contacts: [{ id: 0, x: 30, y: 40 }] },
      { type: "touch", at: 1300, n: 1, contacts: [{ id: 0, x: 50, y: 40 }, { id: 1, x: 70, y: 40 }] },
      { type: "touch", at: 1500, n: 1, contacts: [] },
    ];
    const log = parseRecordingLog(entries.map((entry) => JSON.stringify(entry)).join("\n"));
    const doubled = new Map([[1, { a: 2, b: 0, c: 0, d: 2, e: 5, f: 0 }]]);
    const [first, second] = touchTracks(log, doubled, 10);
    assert.deepEqual(first, [
      { from: 1, to: 1.2, x: 25, y: 40 },
      { from: 1.2, to: 1.3, x: 65, y: 80 },
      { from: 1.3, to: 1.8, x: 105, y: 80 },
    ]);
    assert.deepEqual(second, [{ from: 1.3, to: 1.8, x: 145, y: 80 }]);
  });

  test("captions sit in the band and lost frames are noted beside the device, held long enough to read", () => {
    const plan = planClip(
      {
        ended: "stopped",
        recorded: 20,
        width: 1080,
        height: 1600,
        start: 0,
        position: "top",
        cuts: [[6, 20]],
        events: [{ at: 1, kind: "step", text: "It opens Settings" }],
        notes: [{ at: 6.2, text: "The device restarted here" }],
        layout: { fontSize: 18, band: { y: 0, height: bandHeight(18) } },
      },
      1,
    );
    const step = plan.overlays.find((overlay) => overlay.look === "step")!;
    assert.ok(step.y >= 0 && step.y + 38 <= bandHeight(18));
    const note = plan.overlays.find((overlay) => overlay.look === "note")!;
    assert.ok(note.y > bandHeight(18));
    assert.ok(note.to - note.from >= 2);
    assert.ok(plan.holds.some((hold) => hold.at >= 6), "a note in a cut stretch is held to be read");
    assert.equal(plan.width, 1080);
  });

  test("makes a framed clip with ffmpeg from a real recording: a turn, two captioned steps and a tap, its still stretches held between frames then cut (E15)", { skip: needsFfmpeg, timeout: 120_000 }, async () => {
    const home = tempDir("device-recording-clip");
    const { control } = await serve(home);
    assert.equal((await control.request({ type: "record", to: "start" })).ok, true);
    await wait(1100);
    await control.request({ type: "record", to: "caption", kind: "step", text: "It turns right" });
    await tap(control, 120, 300);
    await control.request({ type: "control", control: { action: "rotate", turn: "right" } });
    await control.request({ type: "record", to: "caption", kind: "pass", text: "Turned right" });
    await wait(1100);
    await control.request({ type: "record", to: "caption", kind: "step", text: "It holds a still end" });
    await wait(2600);
    assert.equal((await control.request({ type: "record", to: "stop" })).ok, true);
    const log = readLog(home);
    for (const segment of ofType(log.entries, "segment")) {
      const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=codec_name,width,height,nb_read_frames", "-of", "json", join(home, RECORD_DIR, segmentFile(segment.n))], { encoding: "utf8" });
      const stream = (JSON.parse(probe.stdout) as { streams: { codec_name: string; width: number; height: number; nb_read_frames: string }[] }).streams[0]!;
      assert.equal(stream.codec_name, "h264");
      assert.deepEqual([stream.width, stream.height], [segment.geometry.video.width, segment.geometry.video.height]);
      assert.ok(Number(stream.nb_read_frames) >= 1);
    }
    const composition = planDeviceClip(log) as DeviceComposition;
    assert.equal(typeof composition, "object");
    assert.match(composeGraph(composition, "cut"), /overlay=eval=frame:x=/);
    const composed = runIn(home, deviceComposeScript(composition, "cut"));
    assert.equal(composed.status, 0, composed.stderr);
    const facts = parseComposed(composed.stdout)!;
    assert.equal(facts.size, `${composition.width}x${composition.height}`);
    assert.ok(facts.cuts.length >= 1 && facts.cuts.every(([from, to]) => from >= 0.5 && to <= composition.length + 0.01), `the card's still seconds, held between its frames, are found and cut: ${JSON.stringify(facts.cuts)}`);
    const plan = planClip(devicePrepared(composition, facts.cuts), 1);
    const made = runIn(home, recordMakeScript(plan, "linux"));
    assert.equal(made.status, 0, made.stderr);
    const result = parseRecordResult(made.stdout)!;
    assert.equal(result.size, `${composition.width}x${composition.height}`);
    assert.ok(Math.abs(result.clip - plan.length) < 0.25, `the clip lasts its plan: ${result.clip} s against ${plan.length} s`);
    assert.ok(plan.length < composition.length + plan.holds.reduce((sum, hold) => sum + hold.seconds, 0), "still stretches were cut");
    await control.close();
  });
});
