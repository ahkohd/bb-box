import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { Duplex } from "node:stream";
import { after, describe, test } from "node:test";
import { DEVICE_PROTOCOL, DEVICE_SERVER_VERSION, STILLS_EVERY_MS, stillsRequestText, testDeviceOffer, type DeviceControl, type OfferedDevices } from "../src/core/device.ts";
import { DeviceLink, DeviceLinkError, type DeviceRole } from "../src/core/device-link.ts";
import { parseDeviceServerMessage, parseDeviceState, parseIntent } from "../src/core/device-parse.ts";
import type { DeviceDriver } from "../src/device/driver.ts";
import { devicePaths } from "../src/device/paths.ts";
import { PcmH264Encoder, yuvFromRgba } from "../src/device/pcm-h264.ts";
import { DeviceServer, KEPT_ANSWERS, type Deadlines } from "../src/device/server.ts";
import { cardLine, drawCard } from "../src/device/test-card.ts";
import { TestDriver, testVideoSize } from "../src/device/test-driver.ts";
import type { ByteChannel } from "../src/transports/types.ts";
import { tempDir } from "./helpers.ts";

const servers: DeviceServer[] = [];
after(async () => {
  for (const server of servers) await server.stop();
});

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

async function started(options: { platform?: "ios" | "android"; driver?: DeviceDriver; intent?: unknown; deadlines?: Partial<Deadlines> } = {}) {
  const home = tempDir("device");
  const paths = devicePaths(home);
  const offer = testDeviceOffer(options.platform ?? "android");
  const driver = options.driver ?? new TestDriver(offer.platform);
  if (options.intent) {
    execFileSync("mkdir", ["-p", paths.dir]);
    writeFileSync(paths.intent, JSON.stringify(options.intent));
  }
  const log: string[] = [];
  const server = new DeviceServer({ paths, platform: offer.platform, devices: offer.devices as OfferedDevices, driver, version: DEVICE_SERVER_VERSION, log: (line) => log.push(line), deadlines: options.deadlines });
  servers.push(server);
  await server.start();
  for (let tries = 0; server.state.power.is !== "booted" && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
  const open = async (role: DeviceRole, extra: { started?: number; instance?: string; onFrame?: (frame: Uint8Array) => void; onText?: (text: string) => void } = {}) => DeviceLink.open(await channelTo(paths.socket), { role, ...extra });
  return { server, paths, driver, log, open };
}

describe("the device server", () => {
  test("says hello first on every connection, with its protocol, version, devices and state", async () => {
    const { open } = await started({ platform: "ios" });
    for (const role of ["viewer", "input", "control"] as const) {
      const link = await open(role, { started: 1, instance: "a" });
      assert.equal(link.hello.protocol, DEVICE_PROTOCOL);
      assert.equal(link.hello.version, DEVICE_SERVER_VERSION);
      assert.equal(link.hello.platform, "ios");
      assert.equal(link.hello.state.model, "iPhone 18 Pro");
      assert.equal(link.hello.state.power.is, "booted");
      assert.equal(link.hello.lease, role === "control");
      await link.close();
    }
  });

  test("gives the lease to the later-started instance and tells the other it is superseded", async () => {
    const { paths, open, server } = await started();
    let earlierClosed: { superseded: boolean; words: string } | null = null;
    const first = await DeviceLink.open(await channelTo(paths.socket), { role: "control", started: 100, instance: "earlier", onClosed: (why) => (earlierClosed = why) });
    assert.equal(first.hello.lease, true);
    const later = await open("control", { started: 200, instance: "later" });
    assert.equal(later.hello.lease, true);
    for (let tries = 0; !earlierClosed && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(earlierClosed, { superseded: true, words: "superseded: a bb-box instance started later holds this box's device" });
    assert.deepEqual(server.leaseHolder, { started: 200, instance: "later" });
    await assert.rejects(open("control", { started: 150, instance: "earlier" }), (error: unknown) => error instanceof DeviceLinkError && /superseded/.test(error.message));
    assert.deepEqual(server.leaseHolder, { started: 200, instance: "later" });
    const input = await open("input");
    const refused = await input.request({ type: "owner", generation: 1, holder: "person" });
    assert.equal(!refused.ok && refused.error.code, "superseded");
    const taken = await later.request({ type: "owner", generation: 1, holder: "person" });
    assert.equal(taken.ok, true);
    await input.close();
    await later.close();
  });

  test("does a request sent twice with one ID once, and keeps the last answers", async () => {
    const { open, driver } = await started();
    const link = await open("control", { started: 1, instance: "a" });
    const control: DeviceControl = { action: "rotate", turn: "left" };
    const first = await link.request({ type: "control", control }, { id: "rotate-1" });
    const again = await link.request({ type: "control", control }, { id: "rotate-1" });
    assert.equal(first.ok, true);
    assert.deepEqual(again, first);
    assert.equal((driver as TestDriver).record.controls.length, 1);
    assert.equal(link.state.geometry?.physical, "turned-left");
    const result = await link.request({ type: "result" }, { id: "rotate-1" });
    assert.deepEqual(result, first);
    for (let index = 0; index < KEPT_ANSWERS; index++) await link.request({ type: "tree" }, { id: `tree-${index}` });
    const forgotten = await link.request({ type: "result" }, { id: "rotate-1" });
    assert.equal(forgotten.ok, false);
    assert.equal(!forgotten.ok && forgotten.error.code, "outcome-unknown");
    await link.close();
  });

  test("refuses a control the model does not have, and a second control while one runs", async () => {
    const slow = new TestDriver("android");
    const control = slow.control.bind(slow);
    slow.control = async (given, signal) => {
      if (given.action === "home") await new Promise((resolve) => setTimeout(resolve, 200));
      return control(given, signal);
    };
    const { open } = await started({ driver: slow });
    const link = await open("control", { started: 1, instance: "a" });
    const fold = await link.request({ type: "control", control: { action: "posture", to: "open" } });
    assert.equal(!fold.ok && fold.error.code, "unsupported");
    const [home, back] = await Promise.all([link.request({ type: "control", control: { action: "home" } }), link.request({ type: "control", control: { action: "back" } })]);
    assert.equal(home.ok, true);
    assert.equal(!back.ok && back.error.code, "busy");
    await link.close();
  });

  test("answers outcome-unknown, with the state read back, past a control's deadline", async () => {
    const stuck = new TestDriver("android");
    const { open } = await started({ driver: stuck, deadlines: { control: 50 } });
    stuck.control = () => new Promise(() => undefined);
    const link = await open("control", { started: 1, instance: "a" });
    const late = await link.request({ type: "control", control: { action: "home" } });
    assert.equal(!late.ok && late.error.code, "outcome-unknown");
    assert.match(!late.ok ? late.error.words : "", /did not finish within 0.1 s.*booted/);
    assert.equal(late.state?.power.is, "booted");
    const next = await link.request({ type: "control", control: { action: "back" } });
    assert.equal(!next.ok && next.error.code, "busy");
    await link.close();
  });

  test("writes its intent before each step of a switch, and boots the old model again when the new one fails", async () => {
    const { open, paths, driver } = await started();
    const intents: string[] = [];
    const test = driver as TestDriver;
    const attach = test.attach.bind(test);
    test.attach = async (target, signal) => {
      intents.push(readFileSync(paths.intent, "utf8"));
      return attach(target, signal);
    };
    const link = await open("control", { started: 1, instance: "a" });
    const switched = await link.request({ type: "control", control: { action: "switch", device: "Pixel Tablet" } }, { id: "switch-1" });
    assert.equal(switched.ok, true);
    assert.equal(switched.state?.model, "Pixel Tablet");
    const during = parseIntent(JSON.parse(intents[0]!), "android");
    assert.ok(during.ok);
    assert.deepEqual(during.value.switching && { from: during.value.switching.from, step: during.value.switching.step, id: during.value.switching.id }, { from: "Pixel 8", step: "booting", id: "switch-1" });
    const done = parseIntent(JSON.parse(readFileSync(paths.intent, "utf8")), "android");
    assert.deepEqual(done.ok && done.value, { target: "Pixel Tablet", switching: null });
    test.attach = async (target, signal) => {
      if (target.model === "Pixel 8") throw new Error("it would not boot");
      return attach(target, signal);
    };
    const failed = await link.request({ type: "control", control: { action: "switch", device: "Pixel 8" } });
    assert.equal(!failed.ok && failed.error.words, "Could not start the Pixel 8: it would not boot. The Pixel Tablet is back.");
    assert.equal(failed.state?.model, "Pixel Tablet");
    const unknown = await link.request({ type: "control", control: { action: "switch", device: "Pixel Fold" } });
    assert.equal(!unknown.ok && unknown.error.code, "unknown-device");
    const state = parseDeviceState(JSON.parse(readFileSync(paths.state, "utf8")));
    assert.ok(state.ok);
    await link.close();
  });

  test("starts the model its intent names, and finishes a switch that a restart cut short", async () => {
    const { server } = await started({ intent: { target: "Pixel Tablet", switching: { id: "s", from: "Pixel 8", step: "booting", since: 1 } } });
    assert.equal(server.state.model, "Pixel Tablet");
    assert.deepEqual(server.intent, { target: "Pixel Tablet", switching: null });
  });

  test("sends a key frame on request, still screen or not, that ffmpeg decodes at the stream's size", async (t) => {
    const ffmpeg = spawnSync("ffmpeg", ["-version"]);
    if (ffmpeg.status !== 0) {
      t.skip("no ffmpeg here");
      return;
    }
    const { open } = await started();
    const frames: Uint8Array[] = [];
    const viewer = await open("viewer", { onFrame: (frame) => frames.push(frame) });
    await viewer.send("START_VIDEO");
    for (let tries = 0; !frames.length && tries < 200; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
    const count = frames.length;
    await viewer.send("REQUEST_KEYFRAME");
    for (let tries = 0; frames.length === count && tries < 200; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
    const key = frames.at(-1)!;
    assert.equal(key[0], 4);
    assert.equal(key[1]! & 15, 1);
    const width = (key[6]! << 8) | key[7]!;
    const height = (key[8]! << 8) | key[9]!;
    assert.deepEqual({ width, height }, testVideoSize({ width: 1080, height: 2400 }));
    const dir = tempDir("frames");
    writeFileSync(`${dir}/key.h264`, key.subarray(12));
    const probe = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=width,height,nb_read_frames", "-of", "csv=p=0", `${dir}/key.h264`], { encoding: "utf8" }).trim();
    assert.equal(probe, `${width},${height},1`);
    await viewer.close();
  });

  test("sends stills, never video, to a viewer that asks for them: a PNG at the stream's size at once, at most five a second, and none while it stops its video", async () => {
    const { open } = await started();
    const frames: Uint8Array[] = [];
    const stills: { png: string; generation: number; at: number }[] = [];
    const viewer = await open("viewer", {
      onFrame: (frame) => frames.push(frame),
      onText: (text) => {
        const parsed = parseDeviceServerMessage(text);
        if (parsed.ok && parsed.value.verb === "BB_DEVICE_STILL") stills.push({ png: parsed.value.png, generation: parsed.value.generation, at: performance.now() });
      },
    });
    await viewer.send(stillsRequestText(true));
    await viewer.send("START_VIDEO");
    for (let tries = 0; !stills.length && tries < 200; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(stills.length > 0, "a still came at once");
    const png = Buffer.from(stills[0]!.png, "base64");
    assert.equal(png.subarray(1, 4).toString("latin1"), "PNG");
    assert.deepEqual({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }, testVideoSize({ width: 1080, height: 2400 }));
    for (let tries = 0; stills.length < 3 && tries < 1000; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(frames.length, 0);
    assert.ok(stills.length >= 3, "the clock's changes bring more stills");
    for (let index = 1; index < stills.length; index++) assert.ok(stills[index]!.at - stills[index - 1]!.at >= STILLS_EVERY_MS - 20);
    await viewer.send("STOP_VIDEO");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stopped = stills.length;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(stills.length, stopped);
    await viewer.send(stillsRequestText(false));
    await viewer.send("START_VIDEO");
    for (let tries = 0; !frames.length && tries < 200; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(frames[0]![1]! & 15, 1, "video comes back from a key frame");
    await viewer.close();
  });

  test("takes the person's clipboard from the input connection, whole or in parts, and the test card shows it; a viewer's goes nowhere", async () => {
    const { open, driver } = await started();
    const text = (words: string) => Buffer.from(words, "utf8").toString("base64");
    const viewer = await open("viewer");
    await viewer.send(`cw,${text("from a viewer")}`);
    const input = await open("input");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await driver.clipboard(), "");
    await input.send(`cw,${text("Hello device")}`);
    for (let tries = 0; (await driver.clipboard()) !== "Hello device" && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await driver.clipboard(), "Hello device");
    const long = "é".repeat(9000);
    const bytes = Buffer.from(long, "utf8");
    await input.send(`cws,part1,${bytes.byteLength}`);
    await input.send(`cwd,part1,${bytes.subarray(0, 9000).toString("base64")}`);
    await input.send(`cwd,part1,${bytes.subarray(9000).toString("base64")}`);
    await input.send("cwe,part1");
    for (let tries = 0; (await driver.clipboard()) !== long && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await driver.clipboard(), long);
    assert.equal(cardLine("Hello device", testVideoSize({ width: 1080, height: 2400 })), "HELLO DEVICE");
    await input.close();
    await viewer.close();
  });

  test("encodes only the macroblocks that changed, and nothing for a still screen", () => {
    const size = { width: 64, height: 48 };
    const encoder = new PcmH264Encoder(size);
    const card = (clock: string) => yuvFromRgba(size, drawCard({ size, appearance: "light", lines: [], clock, touches: [] }).rgba);
    const key = encoder.encode(card("1"), false);
    assert.equal(key?.key, true);
    assert.equal(encoder.encode(card("1"), false), null);
    const changed = encoder.encode(card("2"), false);
    assert.equal(changed?.key, false);
    assert.ok(changed!.data.byteLength < key!.data.byteLength / 2);
  });
});
