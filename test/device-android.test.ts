import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Http2Server, type ServerHttp2Stream } from "node:http2";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { DeviceState, OfferedDeviceOf } from "../src/core/device.ts";
import { AndroidDriver, foldScreenOf, largestFrameBytes, skinRotation } from "../src/device/android-driver.ts";
import { AndroidVideo } from "../src/device/android-video.ts";
import { DriverError } from "../src/device/driver.ts";
import { Emulator, EmulatorRefused, discoveryValues, emulatorUnit, type EmulatorControl, type RunningEmulator } from "../src/device/emulator.ts";
import { Deframer, GrpcClient, frame } from "../src/device/grpc.ts";
import { H264Encoder } from "../src/device/h264-encoder.ts";
import { devicePaths } from "../src/device/paths.ts";
import { DeviceServer } from "../src/device/server.ts";
import { decode, encode } from "../src/device/protobuf.ts";
import { EMULATOR_SCHEMA, GRPC_METHODS } from "../src/device/schemas.ts";
import type { Ran, Runner } from "../src/device/simctl.ts";
import { deviceModel } from "../src/core/device.ts";
import type { BoxRecord } from "../src/core/boxes.ts";
import { wantsDevice } from "../src/plugin/devices.ts";
import { deviceLines, devicesText } from "../src/plugin/views.ts";
import { tempDir } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_HELPER = join(here, "fake-h264.mjs");
const EMU = "android.emulation.control";
const TOKEN = "the-token";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(10);
  }
}

function runtime() {
  return { platform: "android" as const, api: 35, image: "google_apis" as const, revision: 9, abi: "x86_64" as const, emulator: "37.2.12.0", snapshot: null };
}

const PIXEL_8: OfferedDeviceOf<"android"> = { model: "Pixel 8", native: "pixel_8", runtime: runtime() };
const PIXEL_FOLD: OfferedDeviceOf<"android"> = { model: "Pixel Fold", native: "pixel_fold", runtime: runtime() };

interface Screen {
  readonly width: number;
  readonly height: number;
  readonly rotation?: number;
}

class FakeEmulatorGrpc {
  readonly server: Http2Server;
  readonly streams = new Set<ServerHttp2Stream>();
  readonly asked: { readonly path: string; readonly authorization: string | undefined; readonly request: Record<string, unknown> }[] = [];
  screen: Screen = { width: 1080, height: 2400 };

  constructor() {
    this.server = createServer();
    this.server.on("stream", (stream, headers) => this.#stream(stream, String(headers[":path"]), headers.authorization as string | undefined));
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return (this.server.address() as AddressInfo).port;
  }

  #stream(stream: ServerHttp2Stream, path: string, authorization: string | undefined): void {
    stream.on("error", () => undefined);
    const deframer = new Deframer();
    const respond = (status: number) => {
      stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": String(status) }));
    };
    stream.on("data", (chunk: Buffer) => {
      for (const message of deframer.push(new Uint8Array(chunk))) {
        this.asked.push({ path, authorization, request: decode(EMULATOR_SCHEMA, `${EMU}.ImageFormat`, message) as Record<string, unknown> });
        if (authorization !== `Bearer ${TOKEN}`) {
          respond(16);
          stream.end();
          return;
        }
        respond(0);
        if (path === GRPC_METHODS.emulator.streamScreenshot) {
          this.streams.add(stream);
          stream.on("close", () => this.streams.delete(stream));
          this.show(this.screen);
        } else if (path === GRPC_METHODS.emulator.getScreenshot) {
          stream.end(Buffer.from(frame(encode(EMULATOR_SCHEMA, `${EMU}.Image`, { format: { width: this.screen.width, height: this.screen.height }, image: Uint8Array.of(137, 80, 78, 71) }))));
        } else stream.end();
      }
    });
  }

  show(screen: Screen): void {
    this.screen = screen;
    const message = encode(EMULATOR_SCHEMA, `${EMU}.Image`, { format: { width: screen.width, height: screen.height, rotation: { rotation: screen.rotation ?? 0 } }, seq: 1 });
    for (const stream of this.streams) stream.write(Buffer.from(frame(message)));
  }

  endStreams(): void {
    for (const stream of this.streams) stream.end();
  }

  close(): void {
    for (const stream of this.streams) stream.close();
    this.server.close();
  }
}

class FakeEmulator implements EmulatorControl {
  readonly calls: string[] = [];
  runningNow: RunningEmulator | null = null;
  nextPid = 100;
  refuse: EmulatorRefused | null = null;
  readonly dead = new Set<number>();

  async running(): Promise<RunningEmulator | null> {
    return this.runningNow && !this.dead.has(this.runningNow.pid) ? this.runningNow : null;
  }
  async start(avd: string, options: { readonly cold: boolean }): Promise<{ readonly cold: boolean; readonly unsaved: boolean }> {
    this.calls.push(`start ${avd}${options.cold ? " cold" : ""}`);
    if (this.refuse) throw this.refuse;
    this.runningNow = { pid: this.nextPid++, avd, grpcPort: 8554, token: TOKEN, discovery: "/nonexistent" };
    return { cold: options.cold, unsaved: false };
  }
  async waitRunning(avd: string): Promise<RunningEmulator> {
    assert.equal(this.runningNow?.avd, avd);
    return this.runningNow!;
  }
  async waitBooted(): Promise<void> {}
  async snapshotLoaded(): Promise<boolean | null> {
    return true;
  }
  async stop(running: RunningEmulator): Promise<void> {
    this.calls.push(`stop ${running.avd}`);
    this.runningNow = null;
  }
  alive(pid: number): boolean {
    return !this.dead.has(pid);
  }
  async shell(command: string): Promise<string> {
    if (command === "date +%s") return `${Math.round(Date.now() / 1000)}\n`;
    this.calls.push(`shell ${command}`);
    return "";
  }
}

const servers: FakeEmulatorGrpc[] = [];
const drivers: AndroidDriver[] = [];
after(() => {
  for (const driver of drivers) driver.close();
  for (const server of servers) server.close();
});

async function rig(options: { readonly watchMs?: number } = {}) {
  const grpc = new FakeEmulatorGrpc();
  servers.push(grpc);
  const port = await grpc.listen();
  const emulator = new FakeEmulator();
  const dir = tempDir("android-driver");
  const paths = devicePaths(dir);
  mkdirSync(paths.dir, { recursive: true });
  const lines: string[] = [];
  const driver = new AndroidDriver({
    paths,
    log: (line) => lines.push(line),
    emulator,
    encoderProgram: FAKE_HELPER,
    grpc: () => new GrpcClient({ tcp: `http://127.0.0.1:${port}` }),
    watchMs: options.watchMs ?? 50,
    clockTickMs: 60_000,
  });
  drivers.push(driver);
  const frames: { key: boolean; width: number; height: number; generation: number }[] = [];
  const reading = new AbortController();
  void (async () => {
    for await (const each of driver.video().frames(reading.signal)) frames.push({ key: each.key, width: each.width, height: each.height, generation: each.generation });
  })();
  after(() => reading.abort());
  return { grpc, emulator, driver, frames, lines, paths };
}

describe("the Android driver", () => {
  test("boots the device from its snapshot through the emulator's service, streams it through bb-box-h264 by shared memory, and reads its geometry", async () => {
    const { grpc, emulator, driver, frames, paths } = await rig();
    assert.equal(await driver.attach(PIXEL_8, AbortSignal.timeout(5000)), "booted");
    assert.deepEqual(emulator.calls, ["start pixel_8"]);
    await until("a frame", () => frames.length > 0);
    assert.deepEqual(frames[0], { key: true, width: 1080, height: 2400, generation: 1 });
    const asked = grpc.asked.find((each) => each.path === GRPC_METHODS.emulator.streamScreenshot)!;
    assert.equal(asked.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(asked.request, { format: 2, transport: { channel: 1, handle: `file://${join(paths.dir, "frames")}` } });
    assert.ok(statSync(join(paths.dir, "frames")).size >= largestFrameBytes());
    const state = await driver.readBack();
    assert.deepEqual(state.power, { is: "booted", awake: true });
    assert.deepEqual(state.geometry, { generation: 1, physical: "upright", content: "upright", video: { width: 1080, height: 2400 } });
    grpc.show({ width: 1080, height: 2400 });
    await until("a second frame", () => frames.length === 2);
    assert.equal(frames[1]!.key, false);
    driver.video().keyframe();
    await until("a key frame on demand", () => frames.length === 3);
    assert.equal(frames[2]!.key, true);
  });

  test("reattaches to the emulator running its device, and stops one running another device first", async () => {
    const { emulator, driver } = await rig();
    emulator.runningNow = { pid: 7, avd: "pixel_8", grpcPort: 8554, token: TOKEN, discovery: "/nonexistent" };
    assert.equal(await driver.attach(PIXEL_8, AbortSignal.timeout(5000)), "reattached");
    assert.deepEqual(emulator.calls, []);
    assert.equal(await driver.attach(PIXEL_FOLD, AbortSignal.timeout(5000)), "booted");
    assert.deepEqual(emulator.calls, ["stop pixel_8", "start pixel_fold"]);
  });

  test("a turn or a fold starts a new generation; the picture turns with the device as it is held, and a fold names its screen", async () => {
    const { grpc, driver, frames } = await rig();
    grpc.screen = { width: 2208, height: 1840 };
    await driver.attach(PIXEL_FOLD, AbortSignal.timeout(5000));
    await until("a frame", () => frames.length === 1);
    const inner = (await driver.readBack()) as Extract<DeviceState, { form: "foldable" }>;
    assert.equal(inner.geometry?.screen, "inner");
    assert.equal(inner.posture.known, false);
    grpc.show({ width: 1080, height: 2092 });
    await until("the folded frame", () => frames.length === 2);
    assert.deepEqual({ width: frames[1]!.width, height: frames[1]!.height, generation: frames[1]!.generation }, { width: 1080, height: 2092, generation: 2 });
    const outer = (await driver.readBack()) as Extract<DeviceState, { form: "foldable" }>;
    assert.equal(outer.geometry?.screen, "outer");
    grpc.show({ width: 2092, height: 1080, rotation: 3 });
    await until("the turned frame", () => frames.length === 3);
    const turned = await driver.readBack();
    assert.deepEqual(turned.geometry && { physical: turned.geometry.physical, content: turned.geometry.content, generation: turned.geometry.generation }, { physical: "turned-right", content: "turned-right", generation: 3 });
  });

  test("an emulator that ends is booted again; a second end within 5 minutes leaves the device failed, in words, until Reboot boots it cold", async () => {
    const { emulator, driver, lines } = await rig({ watchMs: 20 });
    await driver.attach(PIXEL_8, AbortSignal.timeout(5000));
    emulator.dead.add(emulator.runningNow!.pid);
    await until("booted again", () => emulator.calls.length === 2 && driver.readBack().then((state) => state.power.is === "booted"));
    assert.deepEqual(emulator.calls, ["start pixel_8", "start pixel_8"]);
    emulator.dead.add(emulator.runningNow!.pid);
    await until("failed", () => driver.readBack().then((state) => state.power.is === "failed"));
    const failed = (await driver.readBack()).power;
    assert.equal(failed.is === "failed" && failed.error.code, "device-exited");
    assert.match(failed.is === "failed" ? failed.error.words : "", /stopped twice within 5 minutes/);
    assert.ok(lines.some((line) => /ended without being asked/.test(line)));
    await driver.control({ action: "reboot" }, AbortSignal.timeout(5000));
    assert.deepEqual(emulator.calls.slice(2), ["start pixel_8 cold"]);
    assert.deepEqual((await driver.readBack()).power, { is: "booted", awake: true });
  });

  test("a device whose firewall is missing fails with that code, and its words", async () => {
    const { emulator, driver } = await rig();
    emulator.refuse = new EmulatorRefused("firewall-missing", "The device's firewall is not in place, so the emulator does not start.");
    await assert.rejects(driver.attach(PIXEL_8, AbortSignal.timeout(5000)), /firewall is not in place/);
    const power = (await driver.readBack()).power;
    assert.equal(power.is === "failed" && power.error.code, "firewall-missing");
  });

  test("the device server keeps the driver's own failure, such as a missing firewall, rather than a bare boot failure", async () => {
    const { emulator, driver, paths } = await rig();
    emulator.refuse = new EmulatorRefused("firewall-missing", "The device's firewall is not in place, so the emulator does not start.");
    const server = new DeviceServer({ paths, platform: "android", devices: [PIXEL_8], driver, version: 1, log: () => {} });
    await server.start();
    try {
      await until("failed", () => server.state.power.is === "failed");
      const power = server.state.power;
      assert.equal(power.is === "failed" && power.error.code, "firewall-missing");
    } finally {
      await server.stop();
    }
  });

  test("a screenshot is the emulator's PNG; touch, keys, paste and controls other than reboot are refused for now, and lifting is no input", async () => {
    const { driver } = await rig();
    await driver.attach(PIXEL_8, AbortSignal.timeout(5000));
    assert.deepEqual([...(await driver.screenshot())], [137, 80, 78, 71]);
    await driver.touch([]);
    await driver.key("a", false);
    await assert.rejects(driver.touch([{ id: 0, x: 1, y: 1 }]), (error: unknown) => error instanceof DriverError && error.code === "unsupported");
    await assert.rejects(driver.control({ action: "home" }, AbortSignal.timeout(1000)), (error: unknown) => error instanceof DriverError && error.code === "unsupported");
    await assert.rejects(driver.tree(), /cannot read an Android device's elements yet/);
  });

  test("rotations and screens are read as 063 names them", () => {
    assert.deepEqual([0, 1, 2, 3, 9].map(skinRotation), ["upright", "turned-left", "upside-down", "turned-right", "upright"]);
    const fold = deviceModel("Pixel Fold");
    assert.equal(foldScreenOf(fold, { width: 1840, height: 2208 }), "inner");
    assert.equal(foldScreenOf(fold, { width: 2092, height: 1080 }), "outer");
    assert.equal(foldScreenOf(deviceModel("Pixel 8"), { width: 1080, height: 2400 }), null);
    assert.equal(largestFrameBytes(), 2560 * 1600 * 3);
  });
});

describe("the Android video", () => {
  test("a stopped encoder is started again and given the last frame, which comes as a key frame", async () => {
    process.env.FAKE_H264_FAIL_AFTER = "2";
    const screens: { width: number; height: number; rotation: number }[] = [];
    let push: () => void = () => {};
    const lines: string[] = [];
    let generation = 0;
    const video = new AndroidVideo({
      open: async function* (signal) {
        while (!signal.aborted) {
          const next = screens.shift();
          if (next) yield next;
          else
            await new Promise<void>((resolve) => {
              push = resolve;
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
        }
      },
      encoder: () => new H264Encoder({ helper: FAKE_HELPER, sharedMemory: "/nonexistent" }),
      sized: () => ++generation,
      recover: async () => {},
      log: (line) => lines.push(line),
    });
    const frames: boolean[] = [];
    const reading = new AbortController();
    void (async () => {
      for await (const each of video.frames(reading.signal)) frames.push(each.key);
    })();
    video.start();
    try {
      for (let index = 0; index < 3; index++) {
        screens.push({ width: 64, height: 64, rotation: 0 });
        push();
        await until(`frame ${index + 1}`, () => frames.length === index + 1 || video.encoderRestarts > 0);
      }
      await until("the encoder started again", () => video.encoderRestarts === 1);
      await until("a key frame from the new encoder", () => frames.at(-1) === true && frames.length >= 3);
      assert.deepEqual(frames.slice(0, 2), [true, false]);
      assert.ok(lines.some((line) => /bb-box-h264 stopped \(bb-box-h264: x264 failed to encode a frame\); starting it again/.test(line)));
    } finally {
      delete process.env.FAKE_H264_FAIL_AFTER;
      reading.abort();
      await video.stop();
    }
  });
});

function runner(answers: Record<string, Partial<Ran>>, seen: string[]): Runner {
  return async (program, args) => {
    const line = [program.split("/").pop(), ...args].join(" ");
    seen.push(line);
    const key = Object.keys(answers).find((prefix) => line.startsWith(prefix));
    return { code: 0, stdout: "", stderr: "", ...(key ? answers[key] : {}) };
  };
}

describe("the emulator's service", () => {
  test("its unit checks the firewall before each start, runs the emulator with a token and no window, and marks a stop saved only when the emulator answered it", () => {
    const unit = emulatorUnit("/opt/android-sdk", "/usr/local/bin/bb-box-device-firewall");
    assert.match(unit, /^ExecStartPre=\/usr\/local\/bin\/bb-box-device-firewall check$/m);
    assert.match(unit, /^ExecStart=\/opt\/android-sdk\/emulator\/emulator -avd %i -port 5554 -grpc 8554 -grpc-use-token -gpu swiftshader_indirect -no-window -no-audio -no-boot-anim \$BB_BOX_EMULATOR_BOOT$/m);
    assert.match(unit, /^ExecStop=\/bin\/sh -c 'if \/opt\/android-sdk\/platform-tools\/adb -s emulator-5554 emu kill >\/dev\/null 2>&1; then .*rm -f %h\/\.bb-box\/device\/emulator-unsaved-%i; fi; /m);
    assert.match(unit, /^Restart=no$/m);
  });

  test("reads discovery files: a live process's AVD, port and token; a dead one's file is removed", async () => {
    const home = tempDir("android-home");
    const running = join(home, ".android", "avd", "running");
    mkdirSync(running, { recursive: true });
    writeFileSync(join(running, "pid_41.ini"), "avd.name=pixel_8\ngrpc.port=8554\ngrpc.token=abc=\nport.serial=5554\n");
    writeFileSync(join(running, "pid_42.ini"), "avd.name=pixel_fold\ngrpc.token=old\n");
    const emulator = new Emulator({ dir: join(home, ".bb-box", "device"), home, alive: (pid) => pid === 41, log: () => {}, run: runner({}, []) });
    assert.deepEqual(await emulator.running(), { pid: 41, avd: "pixel_8", grpcPort: 8554, token: "abc=", discovery: join(running, "pid_41.ini") });
    assert.ok(!existsSync(join(running, "pid_42.ini")));
    assert.equal(discoveryValues("a=b=c\nnone\n").get("a"), "b=c");
  });

  test("refuses to start without the firewall, and boots cold after an end that saved no snapshot", async () => {
    const home = tempDir("android-home");
    const dir = join(home, ".bb-box", "device");
    const seen: string[] = [];
    let firewall: Partial<Ran> = { code: 1, stderr: "bb-box-device-firewall: the table inet bb_box_device is not loaded" };
    const emulator = new Emulator({ dir, home, alive: () => true, log: () => {}, manager: async () => "systemd", run: async (program, args, options) => (program.endsWith("firewall") ? { code: 0, stdout: "", stderr: "", ...firewall } : runner({}, seen)(program, args, options)) });
    await assert.rejects(emulator.start("pixel_8", { cold: false, signal: AbortSignal.timeout(1000) }), (error: unknown) => error instanceof EmulatorRefused && error.failure === "firewall-missing" && /not loaded/.test(error.message));
    firewall = { code: 0 };
    assert.deepEqual(await emulator.start("pixel_8", { cold: false, signal: AbortSignal.timeout(1000) }), { cold: false, unsaved: false });
    assert.ok(existsSync(join(dir, "emulator-unsaved-pixel_8")));
    assert.ok(seen.includes("systemctl --user start bb-box-emulator@pixel_8.service"));
    assert.match(readFileSync(join(home, ".config", "systemd", "user", "bb-box-emulator@.service"), "utf8"), /emulator-unsaved-%i/);
    assert.equal(statSync(join(home, ".emulator_console_auth_token")).mode & 0o777, 0o600);
    assert.deepEqual(await emulator.start("pixel_8", { cold: false, signal: AbortSignal.timeout(1000) }), { cold: true, unsaved: true });
  });

  test("without systemd, a stop the emulator answered marks its snapshot saved, and one it did not leaves the mark", async () => {
    const home = tempDir("android-home");
    const dir = join(home, ".bb-box", "device");
    mkdirSync(dir, { recursive: true });
    let answers = 0;
    const emulator = new Emulator({ dir, home, alive: () => false, log: () => {}, manager: async () => "detached", run: async (program, args) => ({ code: args.includes("kill") ? answers : 0, stdout: "", stderr: "" }) });
    const running = { pid: 9, avd: "pixel_8", grpcPort: 8554, token: "t", discovery: join(home, "pid_9.ini") };
    writeFileSync(emulator.unsavedMarker("pixel_8"), "");
    answers = 1;
    await emulator.stop(running, AbortSignal.timeout(1000));
    assert.ok(await emulator.endedUnsaved("pixel_8"), "the emulator did not answer, so nothing says it saved");
    answers = 0;
    await emulator.stop(running, AbortSignal.timeout(1000));
    assert.ok(!(await emulator.endedUnsaved("pixel_8")));
  });
});

describe("an android box in box_list and box_status", () => {
  const offer = { platform: "android" as const, devices: [PIXEL_8, PIXEL_FOLD] as const };
  const box = (change: Partial<BoxRecord> = {}) =>
    ({ id: "bx1", name: "calm-otter", state: "ready", kind: "android", kindLabel: "Android emulator", timings: {}, enrol: { state: "off" }, role: "box", capabilities: { device: offer, displays: [], gpu: false }, ...change }) as unknown as BoxRecord;

  test("wants its device server, names its devices, and gives the device's runtime, state, actions and how adb reaches it", () => {
    assert.ok(wantsDevice(box()));
    assert.equal(devicesText({ devices: { platform: "android", models: ["Pixel 8", "Pixel Fold"] } }), " Devices: Pixel 8 (default), Pixel Fold.");
    const lines = deviceLines(box({ askedDevice: "Pixel Fold" }), null, null);
    assert.equal(lines[0], "Device: Pixel Fold, Android, API 35, Google APIs, emulator 37.2.12.0");
    assert.match(lines[1]!, /^Device state: not known yet/);
    assert.equal(lines[2], "Device commands: adb in box_run reaches the device as emulator-5554, as in adb install app.apk; the Android SDK is in /opt/android-sdk");
    assert.equal(lines.length, 3, "no slimming on Android");
  });
});
