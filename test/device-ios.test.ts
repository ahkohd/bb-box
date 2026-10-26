import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { deviceModel, type OfferedDeviceOf } from "../src/core/device.ts";
import { deviceHubScript, parseDeviceHub } from "../src/core/device-delivery.ts";
import { hasPicture, isKeyFrame, nalUnits, spsPictureSize, startsWithStartCode } from "../src/device/annexb.ts";
import type { EncodedFrame } from "../src/device/driver.ts";
import { FrameFanout } from "../src/device/frame-fanout.ts";
import type { StreamOutput } from "../src/device/idb.ts";
import { IosDriver, contentOrientation } from "../src/device/ios-driver.ts";
import { IosVideo } from "../src/device/ios-video.ts";
import { devicePaths } from "../src/device/paths.ts";
import { Simctl, disabledLabels, type Ran, type Runner } from "../src/device/simctl.ts";
import type { BoxRecord } from "../src/core/boxes.ts";
import { testDeviceOffer } from "../src/core/device.ts";
import { wantsDevice } from "../src/plugin/devices.ts";
import { boxLine, deviceLines, devicesText } from "../src/plugin/views.ts";
import { tempDir } from "./helpers.ts";

const IPHONE_SPS = "27640032ac13142404c0149e6a9a80868083c2010898";
const START = [0, 0, 0, 1];
const annexB = (...units: number[][]) => Uint8Array.from(units.flatMap((unit) => [...START, ...unit]));
const KEY = annexB([...Buffer.from(IPHONE_SPS, "hex")], [0x68, 0xee, 0x3c, 0x80], [0x65, 0x88, 0x84, 0x00]);
const DELTA = annexB([0x41, 0x9a, 0x02]);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(10);
  }
}

describe("H.264 Annex B", () => {
  test("splits NAL units, tells key frames, and reads the picture's size from the SPS, cropping and all", () => {
    const units = nalUnits(KEY);
    assert.deepEqual(units.map((unit) => unit.type), [7, 8, 5]);
    assert.ok(isKeyFrame(units) && hasPicture(units) && startsWithStartCode(KEY));
    assert.ok(!isKeyFrame(nalUnits(DELTA)) && hasPicture(nalUnits(DELTA)));
    assert.ok(!hasPicture(nalUnits(annexB([0x67, 0x64]))));
    assert.deepEqual(spsPictureSize(units[0]!), { width: 1206, height: 2622 });
    assert.equal(spsPictureSize(units[1]!), null);
    assert.equal(spsPictureSize({ type: 7, body: Uint8Array.of(0x67, 0x64) }), null);
  });
});

function encoded(key: boolean, at = 0): EncodedFrame {
  return { data: key ? KEY : DELTA, key, generation: 1, monotonicMs: at, width: 1206, height: 2622 };
}

describe("the frame fan-out", () => {
  test("gives every reader every frame, and drops a reader that falls behind to the next key frame", async () => {
    let behind = 0;
    const fanout = new FrameFanout({ mostQueued: 3, onBehind: () => behind++ });
    const stop = new AbortController();
    const quick: boolean[] = [];
    const reading = (async () => {
      for await (const frame of fanout.frames(stop.signal)) quick.push(frame.key);
    })();
    const slow = fanout.frames(stop.signal)[Symbol.asyncIterator]();
    const first = slow.next();
    await until("two readers", () => fanout.readers === 2);
    fanout.push(encoded(true));
    assert.equal((await first).value.key, true);
    for (const key of [false, false, false, false, false, false, true, false]) {
      fanout.push(encoded(key));
      await new Promise((resolve) => setImmediate(resolve));
    }
    await until("the quick reader", () => quick.length === 9);
    assert.equal(behind, 1);
    const kept: boolean[] = [];
    for (let index = 0; index < 2; index++) kept.push((await slow.next()).value.key);
    assert.deepEqual(kept, [true, false]);
    stop.abort();
    await reading;
  });
});

describe("the iOS video", () => {
  function fakeStreams(options: { still?: boolean; failFirst?: boolean } = {}) {
    let opened = 0;
    const open = (stopped: Promise<void>, signal: AbortSignal): AsyncIterable<StreamOutput> => {
      opened++;
      const which = opened;
      return (async function* () {
        if (options.failFirst && which === 1) {
          yield { data: KEY, log: null };
          throw new Error("Premature close");
        }
        yield { data: null, log: "starting" };
        yield { data: KEY, log: null };
        let ended = false;
        void stopped.then(() => (ended = true));
        while (!ended && !signal.aborted) {
          await wait(15);
          if (!options.still) yield { data: DELTA, log: null };
        }
      })();
    };
    return { open, opened: () => opened };
  }

  test("sends key frames on demand: the last again on a still screen, a new stream otherwise, and recovers a stream that fails", async () => {
    const streams = fakeStreams({ still: true });
    const sizes: string[] = [];
    const logs: string[] = [];
    const video = new IosVideo({ open: streams.open, recover: async () => undefined, sized: (size) => (sizes.push(`${size.width}x${size.height}`), sizes.length), log: (line) => logs.push(line) });
    const stop = new AbortController();
    const frames: EncodedFrame[] = [];
    void (async () => {
      for await (const frame of video.frames(stop.signal)) frames.push(frame);
    })();
    video.start();
    await until("the first key frame", () => frames.length === 1);
    assert.deepEqual(sizes, ["1206x2622"]);
    assert.deepEqual({ key: frames[0]!.key, generation: frames[0]!.generation, width: frames[0]!.width }, { key: true, generation: 1, width: 1206 });
    video.keyframe();
    await until("the replayed key frame", () => frames.length === 2);
    assert.equal(frames[1]!.data, frames[0]!.data);
    assert.equal(streams.opened(), 1);
    assert.ok(logs.some((line) => line.includes("idb_companion says: starting")));
    await video.stop();
    stop.abort();

    const busy = fakeStreams();
    const busyVideo = new IosVideo({ open: busy.open, recover: async () => undefined, sized: () => 1, log: () => undefined });
    const seen: EncodedFrame[] = [];
    const halt = new AbortController();
    void (async () => {
      for await (const frame of busyVideo.frames(halt.signal)) seen.push(frame);
    })();
    busyVideo.start();
    await until("deltas", () => seen.filter((frame) => !frame.key).length >= 2);
    busyVideo.keyframe();
    await until("a new stream's key frame", () => busy.opened() === 2 && seen.filter((frame) => frame.key).length === 2);
    assert.equal(busyVideo.restarts, 1);
    await busyVideo.stop();
    halt.abort();

    let recovered = 0;
    const failing = fakeStreams({ failFirst: true });
    const failingVideo = new IosVideo({ open: failing.open, recover: async () => void recovered++, sized: () => 1, log: () => undefined });
    const keys: EncodedFrame[] = [];
    const end = new AbortController();
    void (async () => {
      for await (const frame of failingVideo.frames(end.signal)) if (frame.key) keys.push(frame);
    })();
    failingVideo.start();
    await until("a key frame after the failure", () => keys.length === 2);
    assert.equal(recovered, 1);
    await failingVideo.stop();
    end.abort();
  });
});

describe("iOS helpers", () => {
  test("reads launchctl's disabled services, the content's orientation, and what the doctor saw of Device Hub", () => {
    assert.deepEqual([...disabledLabels('disabled services = {\n\t"com.apple.a" => disabled\n\t"com.apple.b" => enabled\n\t"com.apple.c" => true\n}')], ["com.apple.a", "com.apple.c"]);
    const phone = deviceModel("iPhone 18 Pro");
    assert.equal(contentOrientation("upright", { width: 1206, height: 2622 }, phone), "upright");
    assert.equal(contentOrientation("turned-right", { width: 2622, height: 1206 }, phone), "turned-right");
    assert.equal(contentOrientation("upright", { width: 2622, height: 1206 }, phone), "turned-left");
    assert.equal(contentOrientation("turned-left", { width: 1206, height: 2622 }, phone), "upright");
    assert.deepEqual(parseDeviceHub('none\n{"killed":2,"last":1000}\n'), { running: false, killed: 2, last: 1000 });
    assert.deepEqual(parseDeviceHub("running\n"), { running: true, killed: 0, last: null });
    assert.equal(parseDeviceHub(""), null);
    assert.match(deviceHubScript(), /pgrep -x -U "\$\(id -u\)" DeviceHub/);
  });
});

const LIST = ["com.apple.one", "com.apple.two", "com.apple.three"];
const UDID = "11111111-2222-3333-4444-555555555555";

class FakeSimulator {
  state = "Shutdown";
  readonly disabled = new Set<string>();
  readonly calls: string[] = [];
  readonly runner: Runner = async (_program, args) => {
    const [, verb, ...rest] = args;
    const ok = (stdout = ""): Ran => ({ code: 0, stdout, stderr: "" });
    this.calls.push([verb, ...rest].join(" "));
    switch (verb) {
      case "list":
        return ok(JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [{ udid: UDID, name: "iPhone 18 Pro", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro", state: this.state, isAvailable: true }] } }));
      case "boot":
        if (this.state === "Booted") return { code: 149, stdout: "", stderr: "Unable to boot device in current state: Booted" };
        this.state = "Booted";
        return ok();
      case "bootstatus":
        return ok();
      case "shutdown":
        this.state = "Shutdown";
        return ok();
      case "spawn": {
        const [, , command, target] = rest;
        if (command === "print-disabled") return ok(`disabled services = {\n${[...this.disabled].map((label) => `\t"${label}" => disabled`).join("\n")}\n}`);
        const label = target!.replace("system/", "");
        if (command === "disable") this.disabled.add(label);
        else this.disabled.delete(label);
        return ok();
      }
      default:
        return ok();
    }
  };
}

describe("the iOS driver, against a fake simctl and a fake idb_companion", () => {
  const started: IosDriver[] = [];
  const sleepers: number[] = [];
  const homes: string[] = [];
  after(async () => {
    for (const driver of started) driver.close();
    for (const home of homes) {
      const record = join(devicePaths(home).dir, "companion.json");
      if (existsSync(record)) sleepers.push((JSON.parse(readFileSync(record, "utf8")) as { pid: number }).pid);
    }
    for (const pid of sleepers) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  });

  function setUp() {
    const home = tempDir("ios");
    homes.push(home);
    const paths = devicePaths(home);
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    const lists = join(home, "lists");
    mkdirSync(lists);
    writeFileSync(join(lists, "ios-test.txt"), `${LIST.join("\n")}\n`);
    const program = join(home, "idb_companion");
    const fake = fileURLToPath(new URL("./fake-idb.ts", import.meta.url));
    writeFileSync(program, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
    chmodSync(program, 0o755);
    const log = join(home, "companion-calls.log");
    process.env.FAKE_IDB_LOG = log;
    const target: OfferedDeviceOf<"ios"> = {
      model: "iPhone 18 Pro",
      native: "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro",
      runtime: { platform: "ios", os: "27.0", build: "24A434", xcode: "27.0", companion: "1.7.7" },
      slim: { list: "ios-test", labels: LIST.length, sha256: "0".repeat(64) },
    };
    return { home, paths, lists, program, log, target };
  }

  function driverOf(setup: ReturnType<typeof setUp>, simulator: FakeSimulator, options: { slim?: boolean; hubs?: () => number[] } = {}) {
    const logs: string[] = [];
    const driver = new IosDriver({
      paths: setup.paths,
      slim: options.slim ?? true,
      log: (line) => logs.push(line),
      simctl: new Simctl({ run: simulator.runner }),
      companionProgram: setup.program,
      slimLists: setup.lists,
      watchMs: 50,
      processes: async () => options.hubs?.() ?? [],
    });
    started.push(driver);
    return { driver, logs };
  }

  test("boots its device by name and type, keeps it slim, streams it, and reattaches after a restart with the same idb_companion", async () => {
    const setup = setUp();
    const simulator = new FakeSimulator();
    simulator.disabled.add(LIST[0]!);
    const { driver, logs } = driverOf(setup, simulator);
    assert.equal(await driver.attach(setup.target, AbortSignal.timeout(20_000)), "booted");
    assert.deepEqual([...simulator.disabled].sort(), [...LIST].sort());
    assert.ok(simulator.calls.includes("shutdown " + UDID), "rebooted after slimming");
    assert.ok(logs.some((line) => line.includes("has 1 of the 3 services of ios-test off")));
    const frames: EncodedFrame[] = [];
    const stop = new AbortController();
    void (async () => {
      for await (const frame of driver.video().frames(stop.signal)) frames.push(frame);
    })();
    driver.video().keyframe();
    await until("frames", () => frames.some((frame) => frame.key) && frames.length > 2);
    const state = await driver.readBack();
    assert.equal(state.power.is, "booted");
    assert.deepEqual(state.geometry, { generation: 1, physical: "upright", content: "upright", video: { width: 1206, height: 2622 } });
    assert.deepEqual([...(await driver.screenshot())], [137, 80, 78, 71]);
    await assert.rejects(driver.touch([{ id: 0, x: 1, y: 1 }]), /cannot send touches/);
    stop.abort();
    driver.close();

    const again = driverOf(setup, simulator);
    simulator.calls.length = 0;
    assert.equal(await again.driver.attach(setup.target, AbortSignal.timeout(20_000)), "reattached");
    assert.ok(!simulator.calls.some((call) => call.startsWith("shutdown")));
    const companions = readFileSync(setup.log, "utf8").split("\n").filter((line) => line.includes("listening"));
    assert.equal(companions.length, 1, "the same idb_companion serves the reattached driver");
    again.driver.close();
    await again.driver.shutdown(AbortSignal.timeout(5000));
    assert.equal(simulator.state, "Shutdown");
  });

  test("turns every service of the list on and reboots when slim is off, and kills Device Hub when it starts", async () => {
    const setup = setUp();
    const simulator = new FakeSimulator();
    for (const label of LIST) simulator.disabled.add(label);
    const sleeper = spawn("sleep", ["30"]);
    sleepers.push(sleeper.pid!);
    let hubs = [sleeper.pid!];
    const exited = new Promise<string | null>((resolve) => sleeper.on("exit", (_code, signal) => resolve(signal)));
    const seen = () => {
      const now = hubs;
      hubs = [];
      return now;
    };
    const { driver, logs } = driverOf(setup, simulator, { slim: false, hubs: seen });
    assert.equal(await driver.attach(setup.target, AbortSignal.timeout(20_000)), "booted");
    assert.equal(simulator.disabled.size, 0);
    assert.ok(simulator.calls.includes("shutdown " + UDID));
    assert.equal(await exited, "SIGKILL");
    await until("the kill's record", async () => (await driver.deviceHubKills()).killed === 1);
    assert.ok(logs.some((line) => line.startsWith("device hub: Device Hub started")));
    driver.close();
  });

  test("boots a device that stopped by itself once, and leaves it failed when it stops again within 5 minutes", async () => {
    const setup = setUp();
    const simulator = new FakeSimulator();
    for (const label of LIST) simulator.disabled.add(label);
    const { driver, logs } = driverOf(setup, simulator);
    await driver.attach(setup.target, AbortSignal.timeout(20_000));
    simulator.state = "Shutdown";
    await until("the device back", () => logs.some((line) => line.includes("is back")), 10_000);
    assert.equal(simulator.state, "Booted");
    simulator.state = "Shutdown";
    await until("the device failed", async () => (await driver.readBack()).power.is === "failed", 10_000);
    const power = (await driver.readBack()).power;
    assert.ok(power.is === "failed" && power.error.code === "device-exited" && /stopped twice within 5 minutes/.test(power.error.words));
    driver.close();
  });

  test("starts idb_companion again when it is killed, and the stream comes back with a key frame", async () => {
    const setup = setUp();
    const simulator = new FakeSimulator();
    for (const label of LIST) simulator.disabled.add(label);
    const { driver } = driverOf(setup, simulator);
    await driver.attach(setup.target, AbortSignal.timeout(20_000));
    const keys: EncodedFrame[] = [];
    const stop = new AbortController();
    void (async () => {
      for await (const frame of driver.video().frames(stop.signal)) if (frame.key) keys.push(frame);
    })();
    driver.video().keyframe();
    await until("a key frame", () => keys.length >= 1);
    const record = JSON.parse(readFileSync(join(setup.paths.dir, "companion.json"), "utf8")) as { pid: number };
    process.kill(record.pid, "SIGKILL");
    const before = keys.length;
    await until("a key frame from a new companion", () => keys.length > before, 10_000);
    const now = JSON.parse(readFileSync(join(setup.paths.dir, "companion.json"), "utf8")) as { pid: number };
    assert.notEqual(now.pid, record.pid);
    assert.ok(existsSync(join(setup.paths.dir, "idb.sock")));
    stop.abort();
    driver.close();
    await driver.shutdown(AbortSignal.timeout(5000));
  });
});

describe("an ios box in bb-box's words", () => {
  const offer = {
    platform: "ios",
    devices: [
      { model: "iPhone 18 Pro", native: "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro", runtime: { platform: "ios", os: "27.0", build: "24A434", xcode: "27.0", companion: "1.7.7" } },
      { model: "iPhone 17", native: "com.apple.CoreSimulator.SimDeviceType.iPhone-17", runtime: { platform: "ios", os: "27.0", build: "24A434", xcode: "27.0", companion: "1.7.7" } },
    ],
  };
  const box = (change: Partial<BoxRecord> = {}) =>
    ({ id: "bx1", name: "calm-otter", state: "ready", kind: "ios", kindLabel: "iOS Simulator", timings: {}, enrol: { state: "off" }, role: "box", capabilities: { device: offer, displays: [], gpu: false }, ...change }) as unknown as BoxRecord;

  test("a real device box wants its server whether or not it named a device; a test device only when asked for", () => {
    assert.ok(wantsDevice(box()));
    assert.ok(!wantsDevice(box({ state: "stopped" })));
    const test = box({ capabilities: { device: testDeviceOffer("ios"), displays: [], gpu: false } as never });
    assert.ok(!wantsDevice(test));
    assert.ok(wantsDevice({ ...test, askedDevice: "iPhone 17" } as BoxRecord));
  });

  test("box_list names the kind's devices and a box's; box_status gives the device's runtime, state, commands and slimming", () => {
    assert.equal(devicesText({ devices: { platform: "ios", models: ["iPhone 18 Pro", "iPhone 17"] } }), " Devices: iPhone 18 Pro (default), iPhone 17.");
    assert.equal(devicesText({ devices: null }), "");
    assert.match(boxLine(box({ askedDevice: "iPhone 17" })), /; device: iPhone 17$/);
    const state = {
      platform: "ios",
      model: "iPhone 17",
      power: { is: "booted", awake: true },
      geometry: { generation: 1, physical: "upright", content: "upright", video: { width: 1206, height: 2622 } },
      settings: { appearance: { known: false, why: "" }, textSize: { known: false, why: "" }, location: { set: null, at: null }, statusBar: { set: null, at: null } },
      at: 0,
    } as const;
    assert.deepEqual(deviceLines(box({ slim: false }), state, null), [
      "Device: iPhone 17, iOS 27.0 (24A434), Xcode 27.0, idb_companion 1.7.7",
      "Device state: booted, upright, 1206x2622",
      "Device commands: simctl in box_run takes booted as the iOS device, as in xcrun simctl openurl booted <url>",
      "Slim: off. The device runs every service iOS starts",
    ]);
    assert.match(deviceLines(box(), null, null)[1]!, /^Device state: not known yet/);
    assert.match(deviceLines(box(), null, null)[3]!, /^Slim: on\./);
  });
});
