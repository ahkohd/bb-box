import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { Duplex } from "node:stream";
import { after, describe, test } from "node:test";
import { DEVICE_PROTOCOL, DEVICE_SERVER_VERSION, PERSON_HAS_CONTROL_WORDS, STILLS_EVERY_MS, drawnShare, screensOf, deviceModel, stepCovering, stillsRequestText, testDeviceOffer, viewAsked, viewRequestText, type DeviceControl, type DeviceState, type OfferedDevices, type VideoReport } from "../src/core/device.ts";
import { DeviceLink, DeviceLinkError, type DeviceRole } from "../src/core/device-link.ts";
import { parseDeviceServerMessage, parseDeviceState, parseIntent } from "../src/core/device-parse.ts";
import { DriverError, type DeviceDriver } from "../src/device/driver.ts";
import { devicePaths } from "../src/device/paths.ts";
import { PcmH264Encoder, yuvFromRgba } from "../src/device/pcm-h264.ts";
import { DeviceServer, KEPT_ANSWERS, SWIPE_HELD_MS, type Deadlines } from "../src/device/server.ts";
import { pngPixels } from "../src/core/png.ts";
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

async function started(options: { platform?: "ios" | "android"; driver?: DeviceDriver; intent?: unknown; deadlines?: Partial<Deadlines>; settingsEveryMs?: number; video?: { holdMs?: number; lingerMs?: number; reportEveryMs?: number } } = {}) {
  const home = tempDir("device");
  const paths = devicePaths(home);
  const offer = testDeviceOffer(options.platform ?? "android");
  const driver = options.driver ?? new TestDriver(offer.platform);
  if (options.intent) {
    execFileSync("mkdir", ["-p", paths.dir]);
    writeFileSync(paths.intent, JSON.stringify(options.intent));
  }
  const log: string[] = [];
  const server = new DeviceServer({ paths, platform: offer.platform, devices: offer.devices as OfferedDevices, driver, version: DEVICE_SERVER_VERSION, log: (line) => log.push(line), deadlines: options.deadlines, settingsEveryMs: options.settingsEveryMs, video: options.video });
  servers.push(server);
  await server.start();
  for (let tries = 0; server.state.power.is !== "booted" && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
  const open = async (role: DeviceRole, extra: { started?: number; instance?: string; onFrame?: (frame: Uint8Array) => void; onText?: (text: string) => void; onVideo?: (video: VideoReport) => void } = {}) => DeviceLink.open(await channelTo(paths.socket), { role, ...extra });
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

  test("refuses the agent's controls while a person holds control, but not an install, nor the person's own from the input connection (063, 6.3)", async () => {
    const { open, driver } = await started();
    const control = await open("control", { started: 1, instance: "a" });
    const input = await open("input");
    assert.equal((await control.request({ type: "owner", generation: 1, holder: "person" })).ok, true);
    const home = await control.request({ type: "control", control: { action: "home" } });
    assert.deepEqual(!home.ok && home.error, { code: "person-has-control", words: PERSON_HAS_CONTROL_WORDS });
    const install = await control.request({ type: "control", control: { action: "install", paths: ["/tmp/app.apk"] } });
    assert.equal(install.ok, true);
    const toolbar = await input.request({ type: "control", control: { action: "appearance", to: "dark" } });
    assert.equal(toolbar.ok, true);
    assert.deepEqual((driver as TestDriver).record.controls.map((each) => each.action), ["install", "appearance"]);
    assert.equal((await control.request({ type: "owner", generation: 2, holder: "agent" })).ok, true);
    assert.equal((await control.request({ type: "control", control: { action: "home" } })).ok, true);
    await input.close();
    await control.close();
  });

  test("reads the device's settings back when a client connects and every so often while a viewer watches, and not while none does", async () => {
    let reads = 0;
    class ReadingDriver extends TestDriver {
      async readSettings(): Promise<void> {
        reads++;
      }
    }
    const { open, log } = await started({ platform: "ios", driver: new ReadingDriver("ios"), settingsEveryMs: 40 });
    const control = await open("control", { started: 1, instance: "a" });
    for (let tries = 0; reads < 1 && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(reads, 1, "one read as the control connection said hello");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(reads, 1, "no reads while no viewer watches");
    const viewer = await open("viewer");
    await viewer.send("START_VIDEO");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(reads >= 4, `${reads} reads while a viewer watched`);
    assert.ok(log.some((line) => /^settings: read back in \d+ ms$/.test(line)));
    await viewer.close();
    await control.close();
  });

  test("a settings request reads the device's settings at once and answers with them, so a change made outside BB Box shows with no viewer watching (F-7)", async () => {
    class OutsideDriver extends TestDriver {
      changedOutside = false;
      seen = false;
      readonly #told: (() => void)[] = [];
      onChange(listener: () => void): void {
        super.onChange(listener);
        this.#told.push(listener);
      }
      async readSettings(): Promise<void> {
        if (!this.changedOutside || this.seen) return;
        this.seen = true;
        for (const listener of this.#told) listener();
      }
      async readBack(): Promise<DeviceState> {
        const state = await super.readBack();
        return this.seen && state.platform === "android" ? { ...state, settings: { ...state.settings, network: { known: true, value: "offline", at: 1, by: "outside" } } } : state;
      }
    }
    const driver = new OutsideDriver("android");
    const { open } = await started({ driver, settingsEveryMs: 60_000 });
    const control = await open("control", { started: 1, instance: "a" });
    driver.changedOutside = true;
    const answer = await control.request({ type: "settings" });
    assert.ok(answer.ok, JSON.stringify(answer));
    assert.deepEqual(answer.state?.platform === "android" && answer.state.settings.network, { known: true, value: "offline", at: 1, by: "outside" });
    assert.deepEqual(control.state.platform === "android" && control.state.settings.network, { known: true, value: "offline", at: 1, by: "outside" });
    await control.close();
  });

  test("a control that fails answers with the state read back after it, not the one before (F-3)", async () => {
    class FailingDriver extends TestDriver {
      failed = false;
      async control(): Promise<void> {
        this.failed = true;
        throw new DriverError("failed", "The network was set to online, but 8 s later the device reads airplane mode disabled, Wi-Fi on, not slowed, no default network.");
      }
      async readBack(): Promise<DeviceState> {
        const state = await super.readBack();
        return this.failed ? { ...state, power: { is: "booted", awake: false } } : state;
      }
    }
    const { open } = await started({ driver: new FailingDriver("android") });
    const link = await open("control", { started: 1, instance: "a" });
    const failed = await link.request({ type: "control", control: { action: "network", to: "online" } });
    assert.equal(!failed.ok && failed.error.words, "The network was set to online, but 8 s later the device reads airplane mode disabled, Wi-Fi on, not slowed, no default network.");
    assert.deepEqual(failed.state?.power, { is: "booted", awake: false });
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

  test("says in its hello which models it booted in this box, kept through a restart of the server", async () => {
    const { open, paths, driver, server } = await started();
    const link = await open("control", { started: 1, instance: "a" });
    assert.deepEqual(link.hello.bootedHere, ["Pixel 8"]);
    const switched = await link.request({ type: "control", control: { action: "switch", device: "Pixel Tablet" } });
    assert.equal(switched.ok, true);
    await link.close();
    const viewer = await open("viewer");
    assert.deepEqual(viewer.hello.bootedHere, ["Pixel 8", "Pixel Tablet"]);
    await viewer.close();
    await server.stop();
    const again = new DeviceServer({ paths, platform: "android", devices: testDeviceOffer("android").devices as OfferedDevices, driver, version: DEVICE_SERVER_VERSION });
    servers.push(again);
    await again.start();
    for (let tries = 0; again.state.power.is !== "booted" && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
    const later = await DeviceLink.open(await channelTo(paths.socket), { role: "viewer" });
    assert.deepEqual(later.hello.bootedHere, ["Pixel 8", "Pixel Tablet"]);
    await later.close();
  });

  test("opens a link from the person's input connection, and refuses the agent's while a person has control", async () => {
    const { open, driver } = await started({ platform: "ios" });
    const control = await open("control", { started: 1, instance: "a" });
    const input = await open("input");
    const opened = await input.request({ type: "open", url: "https://example.com" });
    assert.equal(opened.ok, true);
    assert.deepEqual((driver as TestDriver).record.opened, ["https://example.com"]);
    const agent = await control.request({ type: "open", url: "myapp://settings" });
    assert.equal(agent.ok, true);
    assert.equal((await control.request({ type: "owner", generation: 1, holder: "person" })).ok, true);
    const held = await control.request({ type: "open", url: "myapp://other" });
    assert.equal(!held.ok && held.error.words, PERSON_HAS_CONTROL_WORDS);
    assert.deepEqual((driver as TestDriver).record.opened, ["https://example.com", "myapp://settings"]);
    for (const link of [control, input]) await link.close();
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

  test("puts no viewer's clipboard on the device from either connection, whole or in parts; it goes only with a paste", async () => {
    const { open, driver } = await started();
    const text = (words: string) => Buffer.from(words, "utf8").toString("base64");
    const viewer = await open("viewer");
    await viewer.send(`cw,${text("from a viewer")}`);
    const input = await open("input");
    await input.send(`cw,${text("Hello device")}`);
    const long = "é".repeat(9000);
    const bytes = Buffer.from(long, "utf8");
    await input.send(`cws,part1,${bytes.byteLength}`);
    await input.send(`cwd,part1,${bytes.subarray(0, 9000).toString("base64")}`);
    await input.send(`cwd,part1,${bytes.subarray(9000).toString("base64")}`);
    await input.send("cwe,part1");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await driver.clipboard(), "");
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

async function eventually(what: string, check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("the device server's video at the viewer's size (064, unit 1)", () => {
  test("reads a viewer's drawn size, and picks the smallest step that covers it, less 5%", () => {
    assert.deepEqual(viewAsked(viewRequestText({ width: 603.4, height: 1311.6 })), { width: 603, height: 1312 });
    assert.equal(viewAsked('BB_DEVICE_VIEW {"width":0,"height":10}'), null);
    assert.equal(viewAsked('BB_DEVICE_VIEW {"width":20000,"height":10}'), null);
    assert.equal(viewAsked("BB_DEVICE_VIEW {}"), null);
    const phone = screensOf(deviceModel("iPhone 18 Pro"));
    const stepOf = (width: number, height: number) => stepCovering(drawnShare({ width, height }, phone));
    assert.equal(stepOf(402, 874), "third");
    assert.equal(stepOf(450, 980), "third", "a share 5% over a third is still a third");
    assert.equal(stepOf(560, 1300), "half");
    assert.equal(stepOf(700, 1520), "two-thirds");
    assert.equal(stepOf(1300, 2100), "full");
    assert.equal(stepOf(1206, 2622), "full");
    assert.equal(stepOf(2000, 5000), "full");
  });

  test("streams at the step of the largest viewer, holds a change for 1 s, takes a recording, a wait and a cap, and closes after the last want's linger", async () => {
    const { open, driver, server, log } = await started({ platform: "ios", video: { holdMs: 150, lingerMs: 400 } });
    const steps = (driver as TestDriver).record.steps;
    await eventually("the boot's word to the video", () => steps.length === 1);
    assert.deepEqual(steps, [null], "nothing wants the video at boot");
    const small = await open("viewer");
    await small.send(viewRequestText({ width: 560, height: 1300 }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(server.videoStep, null, "a viewer's size alone asks for no video");
    await small.send("START_VIDEO");
    await eventually("a half for the small viewer", () => server.videoStep === "half");
    const old = await open("viewer");
    await old.send("START_VIDEO");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(server.videoStep, "half", "a change waits for its hold");
    await eventually("full size for a viewer that never said its size", () => server.videoStep === "full");
    await old.close();
    await eventually("a half again", () => server.videoStep === "half");
    await small.send(viewRequestText({ width: 1206, height: 2622 }));
    await small.send(viewRequestText({ width: 560, height: 1300 }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(server.videoStep, "half", "a wish that comes back within the hold changes nothing");
    await small.send("STOP_VIDEO");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(server.videoStep, "half", "the stream lingers after its last viewer");
    await eventually("the stream to close", () => server.videoStep === null, 2_000);
    assert.deepEqual(steps.slice(1), ["half", "full", "half", null]);

    const control = await open("control", { started: 1, instance: "a" });
    const waited = await control.request({ type: "settle", quietMs: 30, mostMs: 500, fromNow: true });
    assert.equal(waited.ok, true);
    assert.equal(server.videoStep, "third", "the agent's wait opened the stream at a third");
    await eventually("the wait's linger to end", () => server.videoStep === null, 2_000);

    const recording = await control.request({ type: "record", to: "start" });
    assert.equal(recording.ok, true);
    assert.equal(server.videoStep, "two-thirds");
    assert.equal((await control.request({ type: "record", to: "stop" })).ok, true);
    const watcher = await open("viewer");
    await watcher.send("START_VIDEO");
    await eventually("full size", () => server.videoStep === "full");
    const input = await open("input");
    const inputCap = await input.request({ type: "cap", most: "third" });
    assert.equal(!inputCap.ok && inputCap.error.code, "superseded", "only the lease holder caps the video");
    await input.close();
    assert.equal((await control.request({ type: "cap", most: "third" })).ok, true);
    await eventually("the cap", () => server.videoStep === "third");
    assert.equal((await control.request({ type: "cap", most: null })).ok, true);
    await eventually("full size again", () => server.videoStep === "full");
    assert.ok(log.some((line) => line.startsWith("video: the stream at half, for viewer ")));
    await watcher.close();
    await control.close();
  });

  test("does not count a stream's opening frame, nor a key frame sent again, as a change on the screen", async () => {
    const stopped = new TestDriver("ios", { now: () => Date.UTC(2026, 9, 26), monotonic: () => performance.now() });
    const { open } = await started({ platform: "ios", driver: stopped, video: { holdMs: 50, lingerMs: 100 } });
    const control = await open("control", { started: 1, instance: "a" });
    const first = await control.request({ type: "settle", quietMs: 0, mostMs: 0, fromNow: false });
    const before = first.ok && first.result.type === "settled" ? first.result.frames : -1;
    const viewer = await open("viewer");
    await viewer.send("START_VIDEO");
    await viewer.send("REQUEST_KEYFRAME");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const again = await control.request({ type: "settle", quietMs: 0, mostMs: 0, fromNow: false });
    assert.equal(again.ok && again.result.type === "settled" ? again.result.frames : -1, before);
    await viewer.close();
    await control.close();
  });
});

describe("the device server's part in the agent's computer use (063, 7.1)", () => {
  test("settles once no frame has come for the quiet time, counting the frames seen, and gives up at the most", async () => {
    const { open } = await started({ platform: "ios" });
    const control = await open("control", { started: 1, instance: "a" });
    const began = performance.now();
    const still = await control.request({ type: "settle", quietMs: 50, mostMs: 2_000, fromNow: true });
    assert.equal(still.ok && still.result.type === "settled" && still.result.quiet, true);
    assert.ok(performance.now() - began >= 45, "waits the quiet time at least");
    const before = still.ok && still.result.type === "settled" ? still.result.frames : -1;
    assert.equal((await control.request({ type: "open", url: "https://example.com" })).ok, true);
    const after = await control.request({ type: "settle", quietMs: 50, mostMs: 2_000, fromNow: true });
    assert.ok(after.ok && after.result.type === "settled" && after.result.frames > before, "the card drawn again is a frame");
    const cut = await control.request({ type: "settle", quietMs: 5_000, mostMs: 100, fromNow: true });
    assert.equal(cut.ok && cut.result.type === "settled" && cut.result.quiet, false);
    await control.close();
  });

  test("launches an app by its ID or name for the lease holder, names the device's apps for one it lacks, and refuses while a person has control", async () => {
    const { open, driver } = await started({ platform: "ios" });
    const control = await open("control", { started: 1, instance: "a" });
    const input = await open("input");
    const byName = await control.request({ type: "launch", app: "test card" });
    assert.deepEqual(byName.ok && byName.result, { type: "launched", app: { id: "com.example.test-card", name: "Test Card" } });
    const missing = await control.request({ type: "launch", app: "com.example.none" });
    assert.equal(!missing.ok && missing.error.code, "bad-value");
    assert.match(!missing.ok ? missing.error.words : "", /Its apps are: Test Card \(com\.example\.test-card\)\./);
    const fromInput = await input.request({ type: "launch", app: "Test Card" });
    assert.equal(!fromInput.ok && fromInput.error.code, "superseded");
    assert.equal((await control.request({ type: "owner", generation: 1, holder: "person" })).ok, true);
    const held = await control.request({ type: "launch", app: "Test Card" });
    assert.deepEqual(!held.ok && held.error, { code: "person-has-control", words: PERSON_HAS_CONTROL_WORDS });
    assert.deepEqual((driver as TestDriver).record.launched, ["com.example.test-card"]);
    for (const link of [control, input]) await link.close();
  });

  test("scales the agent's screenshot within its longest edge, and says the size it came from", async () => {
    const { open } = await started({ platform: "ios" });
    const control = await open("control", { started: 1, instance: "a" });
    const whole = await control.request({ type: "screenshot" });
    assert.ok(whole.ok && whole.result.type === "screenshot");
    const full = pngPixels(Buffer.from(whole.result.png, "base64"));
    assert.equal(whole.result.source, undefined);
    const small = await control.request({ type: "screenshot", longestEdge: 200 });
    assert.ok(small.ok && small.result.type === "screenshot");
    const scaled = pngPixels(Buffer.from(small.result.png, "base64"));
    assert.equal(Math.max(scaled.width, scaled.height), 200);
    assert.deepEqual(small.result.source, { width: full.width, height: full.height });
    assert.equal(Math.round((scaled.width / scaled.height) * 100), Math.round((full.width / full.height) * 100));
    await control.close();
  });

  test("eases the agent's swipe out and holds its end before it lifts, so a list stops where the finger does", async () => {
    const { open, driver } = await started({ platform: "ios" });
    const control = await open("control", { started: 1, instance: "a" });
    const generation = control.state.geometry!.generation;
    const answer = await control.request({ type: "input", input: { type: "swipe", from: { x: 100, y: 600, generation }, to: { x: 100, y: 200, generation }, ms: 160 }, owner: 1 });
    assert.equal(answer.ok, true);
    const touches = (driver as TestDriver).record.touches;
    assert.deepEqual(touches.at(-1), []);
    const path = touches.filter((contacts) => contacts.length).map((contacts) => contacts[0]!.y);
    const held = path.filter((y) => Math.abs(y - 200) <= 1).length;
    assert.ok(held >= SWIPE_HELD_MS / 16, `the finger held its end for ${held} reports`);
    const steps = path.slice(1, path.indexOf(200) + 1).map((y, index) => path[index]! - y);
    assert.ok(steps[0]! > steps.at(-1)!, `the swipe eases out: ${steps.join(", ")}`);
    await control.close();
  });
});

describe("the device server's reports to the encoder ledger (064, unit 6)", () => {
  test("tells the lease holder what wants the stream, by whom, and its frames a second; and its viewers the ledger's words", async () => {
    const { open, server } = await started({ platform: "ios", video: { holdMs: 50, lingerMs: 200, reportEveryMs: 50 } });
    const reports: VideoReport[] = [];
    const control = await open("control", { started: 1, instance: "a", onVideo: (video) => reports.push(video) });
    await eventually("a first report", () => reports.length > 0);
    assert.deepEqual(reports[0]!.wants, []);
    assert.equal(reports[0]!.step, null);
    const told: (string | null)[] = [];
    const viewer = await open("viewer", { onVideo: (video) => told.push(video.words) });
    await viewer.send(viewRequestText({ width: 560, height: 1300 }));
    await viewer.send("START_VIDEO");
    await eventually("a viewer's want", () => reports.at(-1)?.wants.some((want) => want.for === "viewer" && want.step === "half") === true);
    assert.equal((await control.request({ type: "record", to: "start" })).ok, true);
    await eventually("a recording's want", () => reports.at(-1)?.wants.some((want) => want.for === "recording" && want.step === "two-thirds") === true);
    await eventually("the stream at two thirds", () => reports.at(-1)?.step === "two-thirds");
    assert.equal(typeof reports.at(-1)!.fps, "number");
    assert.equal((await control.request({ type: "record", to: "stop" })).ok, true);
    const words = "Shown at a lower resolution: this Mac's video encoder is busy with 1 other device (box ios-2).";
    assert.equal((await control.request({ type: "cap", most: "third", words })).ok, true);
    await eventually("the viewer told", () => told.includes(words));
    await eventually("the cap reported", () => reports.at(-1)?.cap === "third" && reports.at(-1)?.words === words);
    await eventually("the stream at the cap", () => server.videoStep === "third");
    const later = await open("viewer", { onVideo: (video) => told.push(`later: ${video.words}`) });
    await eventually("a new viewer told at once", () => told.includes(`later: ${words}`));
    assert.equal((await control.request({ type: "cap", most: null, words: null })).ok, true);
    await eventually("the words cleared", () => told.includes(null));
    assert.equal((await control.request({ type: "cap", most: null })).ok, true, "a cap with no words, as an older BB Box sends, still reads");
    await later.close();
    await viewer.close();
    await eventually("no want reported", () => reports.at(-1)?.wants.length === 0);
    await control.close();
  });
});
