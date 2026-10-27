import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Http2Server, type ServerHttp2Stream } from "node:http2";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { DeviceState, OfferedDeviceOf } from "../src/core/device.ts";
import { AndroidDriver, foldScreenOf, identityFile, largestFrameBytes, shellQuoted, skinRotation } from "../src/device/android-driver.ts";
import { ADD_EMULATOR_WIFI, AndroidSettingsKeeper, RESTART_WIFI, WIFI_NETWORKS, WIFI_WRITTEN, networkScript, parseDefaultNetwork, parseReading, readScript } from "../src/device/android-controls.ts";
import { panelPoint, touchPanel } from "../src/device/android-input.ts";
import { apkPackage } from "../src/device/apk.ts";
import { EMULATOR_OWN_LOCATION } from "../src/core/device-settings.ts";
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

function utf16Pool(strings: readonly string[]): Buffer {
  const bodies = strings.map((text) => {
    const units = Buffer.from(text, "utf16le");
    const length = Buffer.alloc(2);
    length.writeUInt16LE(text.length);
    return Buffer.concat([length, units, Buffer.alloc(2)]);
  });
  const offsets = Buffer.alloc(strings.length * 4);
  let at = 0;
  bodies.forEach((body, index) => {
    offsets.writeUInt32LE(at, index * 4);
    at += body.length;
  });
  const data = Buffer.concat(bodies);
  const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
  const header = Buffer.alloc(28);
  header.writeUInt16LE(0x0001, 0);
  header.writeUInt16LE(28, 2);
  header.writeUInt32LE(28 + offsets.length + padded.length, 4);
  header.writeUInt32LE(strings.length, 8);
  header.writeUInt32LE(28 + offsets.length, 20);
  return Buffer.concat([header, offsets, padded]);
}

function binaryManifest(pkg: string): Buffer {
  const pool = utf16Pool(["package", "manifest", pkg]);
  const element = Buffer.alloc(36 + 20);
  element.writeUInt16LE(0x0102, 0);
  element.writeUInt16LE(16, 2);
  element.writeUInt32LE(element.length, 4);
  element.writeUInt32LE(0xffffffff, 16);
  element.writeUInt32LE(1, 20);
  element.writeUInt16LE(20, 24);
  element.writeUInt16LE(20, 26);
  element.writeUInt16LE(1, 28);
  element.writeUInt32LE(0xffffffff, 36);
  element.writeUInt32LE(0, 40);
  element.writeUInt32LE(2, 44);
  const header = Buffer.alloc(8);
  header.writeUInt16LE(0x0003, 0);
  header.writeUInt16LE(8, 2);
  header.writeUInt32LE(8 + pool.length + element.length, 4);
  return Buffer.concat([header, pool, element]);
}

function apkWithPackage(pkg: string): Buffer {
  const name = Buffer.from("AndroidManifest.xml");
  const data = binaryManifest(pkg);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const centralAt = local.length + name.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralAt, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

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

const REQUEST_TYPES: Readonly<Record<string, string>> = {
  [GRPC_METHODS.emulator.streamScreenshot]: "ImageFormat",
  [GRPC_METHODS.emulator.getScreenshot]: "ImageFormat",
  [GRPC_METHODS.emulator.sendTouch]: "TouchEvent",
  [GRPC_METHODS.emulator.sendKey]: "KeyboardEvent",
  [GRPC_METHODS.emulator.setClipboard]: "ClipData",
  [GRPC_METHODS.emulator.setPhysicalModel]: "PhysicalModelValue",
  [GRPC_METHODS.emulator.setPosture]: "Posture",
  [GRPC_METHODS.emulator.setBattery]: "BatteryState",
  [GRPC_METHODS.emulator.setGps]: "GpsState",
};

const TURNED_BY_DEGREES: Readonly<Record<number, number>> = { 0: 0, 90: 1, 180: 2, [-90]: 3 };

class FakeEmulatorGrpc {
  readonly server: Http2Server;
  readonly streams = new Set<ServerHttp2Stream>();
  readonly asked: { readonly path: string; readonly authorization: string | undefined; readonly request: Record<string, unknown> }[] = [];
  screen: Screen = { width: 1080, height: 2400 };
  clipboard = "";
  gps = { latitude: 37.422, longitude: -122.0841 };
  battery = { charger: 1, chargeLevel: 100 };
  emulator: FakeEmulator | null = null;
  holdFirstFrame = false;

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
        const type = REQUEST_TYPES[path];
        const request = type ? (decode(EMULATOR_SCHEMA, `${EMU}.${type}`, message) as Record<string, unknown>) : {};
        this.asked.push({ path, authorization, request });
        if (authorization !== `Bearer ${TOKEN}`) {
          respond(16);
          stream.end();
          return;
        }
        respond(0);
        if (path === GRPC_METHODS.emulator.streamScreenshot) {
          this.streams.add(stream);
          stream.on("close", () => this.streams.delete(stream));
          if (!this.holdFirstFrame) this.show(this.screen);
        } else if (path === GRPC_METHODS.emulator.getScreenshot) {
          stream.end(Buffer.from(frame(encode(EMULATOR_SCHEMA, `${EMU}.Image`, { format: { width: this.screen.width, height: this.screen.height }, image: Uint8Array.of(137, 80, 78, 71) }))));
        } else {
          const answer = this.#answer(path, request);
          stream.end(answer ? Buffer.from(frame(answer)) : Buffer.from(frame(new Uint8Array(0))));
        }
      }
    });
  }

  #answer(path: string, request: Record<string, unknown>): Uint8Array | null {
    const methods = GRPC_METHODS.emulator;
    if (path === methods.getClipboard) return encode(EMULATOR_SCHEMA, `${EMU}.ClipData`, { text: this.clipboard });
    if (path === methods.setClipboard) this.clipboard = String(request.text ?? "");
    if (path === methods.getGps) return encode(EMULATOR_SCHEMA, `${EMU}.GpsState`, this.gps);
    if (path === methods.setGps) this.gps = { latitude: Number(request.latitude ?? 0), longitude: Number(request.longitude ?? 0) };
    if (path === methods.getBattery) return encode(EMULATOR_SCHEMA, `${EMU}.BatteryState`, this.battery);
    if (path === methods.setBattery) this.battery = { charger: Number(request.charger ?? 0), chargeLevel: Number(request.chargeLevel ?? 0) };
    if (path === methods.setPhysicalModel) {
      const degrees = ((request.value as { data?: number[] } | undefined)?.data ?? [0, 0, 0])[2] ?? 0;
      const rotation = TURNED_BY_DEGREES[degrees] ?? 0;
      const upright = this.upright;
      setTimeout(() => this.show(rotation % 2 ? { width: upright.height, height: upright.width, rotation } : { width: upright.width, height: upright.height, rotation }), 5);
    }
    if (path === methods.setPosture && this.emulator) {
      const value = Number(request.value ?? 0);
      this.emulator.deviceState = String(value - 1);
      setTimeout(() => this.show(value === 1 ? { width: 1080, height: 2092 } : { width: 2208, height: 1840 }), 5);
    }
    return null;
  }

  get upright(): { readonly width: number; readonly height: number } {
    return (this.screen.rotation ?? 0) % 2 ? { width: this.screen.height, height: this.screen.width } : this.screen;
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
  readonly shells: string[] = [];
  readonly adb: (readonly string[])[] = [];
  night = "no";
  fontScale = "1.0";
  wakefulness = "Awake";
  airplane = "disabled";
  wifi = "1";
  shaped = false;
  deviceState = "2";
  androidId = "91f5432055d42a8c";
  wifiSaved = true;
  wifiWrittenAfterChecks = 0;
  reachable = true;
  routesLostUntilWifiRestarts = false;
  reboots = 0;
  readonly order: string[] = [];
  installed = new Set<string>();
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
    if (command === readScript())
      return [`Night mode: ${this.night}`, this.fontScale, `  mWakefulness=${this.wakefulness}`, this.airplane, this.wifi, this.shaped ? "qdisc netem 8001: root" : "qdisc noqueue 0: root", this.deviceState, this.connectivity()].join("\n@@bb-box@@\n");
    if (command === WIFI_NETWORKS) return this.wifiSaved ? "Network Id      SSID                         Security type\n0            AndroidWifi                      open\n" : "No networks\n";
    if (command === WIFI_WRITTEN) {
      this.order.push("written?");
      if (this.wifiWrittenAfterChecks > 0) this.wifiWrittenAfterChecks--;
      return this.wifiSaved && this.wifiWrittenAfterChecks === 0 ? "2\n" : "0\n";
    }
    if (command === ADD_EMULATOR_WIFI) this.wifiSaved = true;
    if (command === RESTART_WIFI) this.routesLostUntilWifiRestarts = false;
    this.shells.push(command);
    const night = /^cmd uimode night (yes|no)$/.exec(command);
    if (night) this.night = night[1]!;
    const scale = /^settings put system font_scale (\S+)$/.exec(command);
    if (scale) this.fontScale = scale[1]!;
    if (command === "input keyevent KEYCODE_SLEEP") this.wakefulness = "Asleep";
    if (command === "input keyevent KEYCODE_WAKEUP") this.wakefulness = "Awake";
    if (command === "settings get secure android_id") return `${this.androidId}\n`;
    const id = /^settings put secure android_id (\w+)$/.exec(command);
    if (id) this.androidId = id[1]!;
    for (const preset of ["online", "offline", "slow"] as const) {
      if (command !== networkScript(preset)) continue;
      this.airplane = preset === "offline" ? "enabled" : "disabled";
      this.wifi = preset === "offline" ? "0" : "1";
      this.shaped = preset === "slow";
    }
    const path = /^pm path '([^']+)'/.exec(command);
    if (path) return this.installed.has(path[1]!) ? `package:/data/app/${path[1]}/base.apk\n` : "";
    if (command.startsWith("am start -n")) return "Starting: Intent { cmp=com.android.settings/.Settings }\n";
    if (command.startsWith("am start")) return "Starting: Intent { act=android.intent.action.VIEW }\n";
    if (command.startsWith("cmd package query-activities")) return "1 activities found:\n  Activity #0:\n    com.android.settings/.Settings\n";
    return "";
  }
  connectivity(): string {
    if (this.airplane !== "disabled" || this.wifi !== "1" || !this.wifiSaved) return "Active default network: none";
    const capabilities = this.reachable && !this.routesLostUntilWifiRestarts ? "NOT_METERED&INTERNET&NOT_RESTRICTED&TRUSTED&NOT_VPN&VALIDATED&NOT_ROAMING" : "NOT_METERED&INTERNET&NOT_RESTRICTED&TRUSTED&NOT_VPN&NOT_ROAMING";
    return `Active default network: 100\n  NetworkAgentInfo{network{100}  handle{432902426637}  ni{WIFI CONNECTED extra: } Score(Policies : TRANSPORT_PRIMARY&EVER_VALIDATED&IS_VALIDATED ; KeepConnected : 0)  nc{[ Transports: WIFI Capabilities: ${capabilities} LinkUpBandwidth>=12000Kbps ]}  factorySerialNumber=5}`;
  }
  async adbRun(args: readonly string[]): Promise<{ readonly code: number; readonly output: string }> {
    this.adb.push(args);
    if (args[0] === "reboot") {
      this.reboots++;
      this.order.push("reboot");
      if (this.wifiWrittenAfterChecks > 0) this.wifiSaved = false;
      return { code: 0, output: "" };
    }
    if (args[0] === "exec-out") return { code: 0, output: readFileSync(new URL("./fixtures/android-dump-settings.xml", import.meta.url), "utf8") };
    return { code: 0, output: "Performing Streamed Install\nSuccess" };
  }
}

const servers: FakeEmulatorGrpc[] = [];
const drivers: AndroidDriver[] = [];
after(() => {
  for (const driver of drivers) driver.close();
  for (const server of servers) server.close();
});

async function rig(options: { readonly watchMs?: number; readonly adbKey?: string; readonly onlyDump?: boolean } = {}) {
  const grpc = new FakeEmulatorGrpc();
  servers.push(grpc);
  const port = await grpc.listen();
  const emulator = new FakeEmulator();
  grpc.emulator = emulator;
  const dir = tempDir("android-driver");
  if (options.adbKey) {
    mkdirSync(join(dir, ".android"), { recursive: true });
    writeFileSync(join(dir, ".android", "adbkey.pub"), options.adbKey);
  }
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
    home: dir,
    tree: { onlyDump: options.onlyDump ?? true },
  });
  drivers.push(driver);
  const frames: { key: boolean; width: number; height: number; generation: number }[] = [];
  const reading = new AbortController();
  void (async () => {
    for await (const each of driver.video().frames(reading.signal)) frames.push({ key: each.key, width: each.width, height: each.height, generation: each.generation });
  })();
  after(() => reading.abort());
  return { grpc, emulator, driver, frames, lines, paths, port, dir };
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
    assert.deepEqual(inner.posture.known && inner.posture.value, "open");
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
    await driver.control({ action: "reboot" }, AbortSignal.timeout(5000), { personHasControl: false });
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

  test("a screenshot is the emulator's PNG, and lifting with nothing down sends nothing", async () => {
    const { grpc, driver } = await rig();
    await driver.attach(PIXEL_8, AbortSignal.timeout(5000));
    assert.deepEqual([...(await driver.screenshot())], [137, 80, 78, 71]);
    await driver.touch([]);
    await driver.key("a", false);
    assert.equal(grpc.asked.filter((each) => each.path === GRPC_METHODS.emulator.sendTouch).length, 0);
  });

  test("reads the device's elements in the picture's pixels, says what is at a point from that read, and launches an app by name", async () => {
    const { driver, emulator, frames } = await rig();
    await driver.attach(PIXEL_8, AbortSignal.timeout(5000));
    await until("a frame", () => frames.length > 0);
    const tree = await driver.tree();
    assert.equal(tree[0]?.role, "application");
    assert.equal(tree[0]?.label, "com.android.settings", "with no label from the tree server, an app goes by its package");
    const dumps = () => emulator.adb.filter((args) => args[0] === "exec-out").length;
    assert.equal(dumps(), 1);
    assert.equal((await driver.elementAt({ x: 540, y: 890 }))?.label, "Network & internet, Mobile, Wi‑Fi, hotspot");
    assert.equal(dumps(), 1, "a dump read a moment ago answers what is at a point");
    assert.deepEqual(await driver.launchApp("settings", AbortSignal.timeout(5000)), { id: "com.android.settings", name: "com.android.settings" });
    assert.ok(emulator.shells.includes("am start -n 'com.android.settings/com.android.settings.Settings' 2>&1"));
    await assert.rejects(driver.launchApp("Maps", AbortSignal.timeout(5000)), (error: unknown) => error instanceof DriverError && error.code === "bad-value" && /has no app "Maps" to launch\. Its apps are: com\.android\.settings\./.test(error.message));
  });

  test("touches go to the emulator in its panel's own pixels however the device is held, with every finger lifted by pressure 0", async () => {
    const { grpc, driver, frames } = await rig();
    await driver.attach(PIXEL_8, AbortSignal.timeout(5000));
    await until("a frame", () => frames.length === 1);
    const touches = () => grpc.asked.filter((each) => each.path === GRPC_METHODS.emulator.sendTouch).map((each) => each.request.touches);
    await driver.touch([{ id: 0, x: 540, y: 600 }]);
    await driver.touch([
      { id: 0, x: 540, y: 600 },
      { id: 1, x: 100, y: 200 },
    ]);
    await driver.touch([{ id: 1, x: 110, y: 210 }]);
    await driver.touch([]);
    assert.deepEqual(touches(), [
      [{ x: 540, y: 600, pressure: 1 }],
      [
        { x: 540, y: 600, pressure: 1 },
        { x: 100, y: 200, identifier: 1, pressure: 1 },
      ],
      [
        { x: 110, y: 210, identifier: 1, pressure: 1 },
        { x: 540, y: 600 },
      ],
      [{ x: 110, y: 210, identifier: 1 }],
    ]);
    await driver.control({ action: "rotate", turn: "right" }, AbortSignal.timeout(5000), { personHasControl: false });
    assert.equal((await driver.readBack()).geometry?.physical, "turned-right");
    await driver.touch([{ id: 0, x: 300, y: 700 }]);
    assert.deepEqual(touches().at(-1), [{ x: 700, y: 2099, pressure: 1 }]);
  });

  test("a rotate just after the device server reattaches waits for the first picture, so it turns a device held otherwise than upright (F-4)", async () => {
    const { grpc, emulator, driver } = await rig();
    emulator.runningNow = { pid: 7, avd: "pixel_8", grpcPort: 8554, token: TOKEN, discovery: "/nonexistent" };
    grpc.screen = { width: 2400, height: 1080, rotation: 1 };
    grpc.holdFirstFrame = true;
    assert.equal(await driver.attach(PIXEL_8, AbortSignal.timeout(5000)), "reattached");
    const rotating = driver.control({ action: "rotate", to: "upright" }, AbortSignal.timeout(5000), { personHasControl: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    grpc.show(grpc.screen);
    await rotating;
    const turns = grpc.asked.filter((each) => each.path === GRPC_METHODS.emulator.setPhysicalModel);
    assert.equal(turns.length, 1);
    assert.equal((await driver.readBack()).geometry?.physical, "upright");
  });

  test("the panel's pixels: each way the device is held, and the Pixel Fold's outer screen stretched onto its inner panel", () => {
    const phone = { width: 1080, height: 2400 };
    assert.deepEqual(panelPoint({ x: 540, y: 600 }, phone, "upright", phone), { x: 540, y: 600 });
    assert.deepEqual(panelPoint({ x: 1700, y: 300 }, { width: 2400, height: 1080 }, "turned-right", phone), { x: 300, y: 699 });
    assert.deepEqual(panelPoint({ x: 1700, y: 300 }, { width: 2400, height: 1080 }, "turned-left", phone), { x: 779, y: 1700 });
    assert.deepEqual(panelPoint({ x: 0, y: 0 }, phone, "upside-down", phone), { x: 1079, y: 2399 });
    const fold = deviceModel("Pixel Fold");
    assert.deepEqual(touchPanel(fold), { width: 2208, height: 1840 });
    assert.deepEqual(panelPoint({ x: 540, y: 700 }, { width: 1080, height: 2092 }, "upright", touchPanel(fold)), { x: 1104, y: 616 });
    assert.deepEqual(touchPanel(deviceModel("Pixel 8")), phone);
  });

  test("keys go by their W3C names, a key a US keyboard lacks is refused, paste is the Paste key, and the clipboard goes both ways", async () => {
    const { grpc, driver } = await rig();
    await driver.attach(PIXEL_8, AbortSignal.timeout(5000));
    await driver.key("Shift", true);
    await driver.key("a", true);
    await driver.key("a", false);
    await driver.key("Shift", false);
    await driver.key("Enter", true);
    await driver.key("Enter", false);
    await assert.rejects(driver.key("é", true), (error: unknown) => error instanceof DriverError && error.code === "bad-value");
    await driver.setClipboard("日本語 🙂");
    assert.equal(await driver.clipboard(), "日本語 🙂");
    await driver.paste();
    const keys = grpc.asked.filter((each) => each.path === GRPC_METHODS.emulator.sendKey).map((each) => `${each.request.key}${each.request.eventType === 1 ? " up" : " down"}`);
    assert.deepEqual(keys, ["Shift down", "a down", "a up", "Shift up", "Enter down", "Enter up", "Paste down", "Paste up"]);
    assert.equal(driver.pasteLandsMs, 300);
  });

  test("Home, Back and Recents are the emulator's keys; lock and wake wait until Android reads them; each setting is set and read back", async () => {
    const { grpc, emulator, driver } = await rig();
    await driver.attach(PIXEL_8, AbortSignal.timeout(5000));
    const none = { personHasControl: false };
    for (const action of ["home", "back", "recents"] as const) await driver.control({ action }, AbortSignal.timeout(5000), none);
    const pressed = grpc.asked.filter((each) => each.path === GRPC_METHODS.emulator.sendKey && each.request.eventType !== 1).map((each) => each.request.key);
    assert.deepEqual(pressed, ["GoHome", "GoBack", "AppSwitch"]);
    await driver.control({ action: "lock" }, AbortSignal.timeout(5000), none);
    assert.deepEqual((await driver.readBack()).power, { is: "booted", awake: false });
    await driver.control({ action: "wake" }, AbortSignal.timeout(5000), none);
    assert.deepEqual((await driver.readBack()).power, { is: "booted", awake: true });
    await driver.control({ action: "appearance", to: "dark" }, AbortSignal.timeout(5000), none);
    await driver.control({ action: "text_size", to: 1.3 }, AbortSignal.timeout(5000), none);
    await driver.control({ action: "text_size", to: "larger" }, AbortSignal.timeout(5000), none);
    await driver.control({ action: "location", to: { latitude: 51.5007, longitude: -0.1246 } }, AbortSignal.timeout(5000), none);
    await driver.control({ action: "battery", to: { level: 42, charging: false } }, AbortSignal.timeout(5000), none);
    await driver.control({ action: "network", to: "slow" }, AbortSignal.timeout(5000), none);
    const state = await driver.readBack();
    assert.equal(state.platform, "android");
    if (state.platform !== "android") return;
    const value = <T,>(observed: { readonly known: boolean; readonly value?: T; readonly by?: string }) => (observed.known ? [observed.value, observed.by] : null);
    assert.deepEqual(value(state.settings.appearance), ["dark", "bb-box"]);
    assert.deepEqual(value(state.settings.fontScale), [1.5, "bb-box"]);
    assert.deepEqual(value(state.settings.location), [{ latitude: 51.5007, longitude: -0.1246 }, "bb-box"]);
    assert.deepEqual(value(state.settings.battery), [{ level: 42, charging: false }, "bb-box"]);
    assert.deepEqual(value(state.settings.network), ["slow", "bb-box"]);
    assert.ok(emulator.shells.includes(networkScript("slow")));
    emulator.night = "no";
    await driver.readSettings(AbortSignal.timeout(5000));
    const after = await driver.readBack();
    assert.deepEqual(after.platform === "android" && value(after.settings.appearance), ["light", "outside"]);
    await driver.control({ action: "location", to: null }, AbortSignal.timeout(5000), none);
    assert.deepEqual(grpc.gps, EMULATOR_OWN_LOCATION);
    await driver.control({ action: "battery", to: null }, AbortSignal.timeout(5000), none);
    assert.deepEqual(grpc.battery, { charger: 1, chargeLevel: 100 });
  });

  test("a clean status bar is SystemUI's demo mode, showing the battery bb-box set, set again when the device starts, and live leaves it", async () => {
    const { emulator, driver, paths, port, dir } = await rig();
    await driver.attach(PIXEL_8, AbortSignal.timeout(5000));
    const none = { personHasControl: false };
    await driver.control({ action: "status_bar", to: "clean" }, AbortSignal.timeout(5000), none);
    assert.ok(emulator.shells.some((command) => command.includes("-e command enter") && command.includes("-e level 100 -e plugged false")));
    await driver.control({ action: "battery", to: { level: 42, charging: true } }, AbortSignal.timeout(5000), none);
    assert.ok(emulator.shells.some((command) => command.includes("-e level 42 -e plugged true")));
    const state = await driver.readBack();
    assert.equal(state.platform === "android" && state.settings.statusBar.set, "clean");
    emulator.shells.length = 0;
    const again = new AndroidDriver({ paths, log: () => {}, emulator, encoderProgram: FAKE_HELPER, grpc: () => new GrpcClient({ tcp: `http://127.0.0.1:${port}` }), watchMs: 50, clockTickMs: 60_000, home: dir });
    drivers.push(again);
    await again.attach(PIXEL_8, AbortSignal.timeout(5000));
    assert.ok(emulator.shells.some((command) => command.includes("-e command enter")));
    await driver.control({ action: "status_bar", to: "live" }, AbortSignal.timeout(5000), none);
    assert.ok(emulator.shells.some((command) => command.includes("-e command exit")));
  });

  test("the Pixel Fold folds by posture, waits until Android reads it and the picture shows the other screen", async () => {
    const { grpc, driver, frames } = await rig();
    grpc.screen = { width: 2208, height: 1840 };
    await driver.attach(PIXEL_FOLD, AbortSignal.timeout(5000));
    await until("a frame", () => frames.length === 1);
    const none = { personHasControl: false };
    await driver.control({ action: "posture", to: "closed" }, AbortSignal.timeout(5000), none);
    const closed = (await driver.readBack()) as Extract<DeviceState, { form: "foldable" }>;
    assert.equal(closed.geometry?.screen, "outer");
    assert.deepEqual(closed.posture.known && closed.posture.value, "closed");
    await driver.control({ action: "posture", to: "half-open" }, AbortSignal.timeout(5000), none);
    const half = (await driver.readBack()) as Extract<DeviceState, { form: "foldable" }>;
    assert.equal(half.geometry?.screen, "inner");
    assert.deepEqual(half.posture.known && half.posture.value, "half-open");
    await driver.touch([{ id: 0, x: 540, y: 700 }]);
    assert.equal(grpc.asked.filter((each) => each.path === GRPC_METHODS.emulator.setPosture).length, 2);
  });

  test("install runs adb install, then sync so the app reaches the device's disk; one already installed is refused while a person has control", async () => {
    const { emulator, driver, paths } = await rig();
    await driver.attach(PIXEL_8, AbortSignal.timeout(5000));
    const apk = join(paths.dir, "app.apk");
    writeFileSync(apk, apkWithPackage("com.example.app"));
    await driver.control({ action: "install", paths: [apk] }, AbortSignal.timeout(5000), { personHasControl: true });
    assert.deepEqual(emulator.adb, [["install", "-r", apk]]);
    assert.ok(emulator.shells.includes("sync"));
    emulator.installed.add("com.example.app");
    await assert.rejects(driver.control({ action: "install", paths: [apk] }, AbortSignal.timeout(5000), { personHasControl: true }), (error: unknown) => error instanceof DriverError && error.code === "person-has-control");
    const split = join(paths.dir, "split.apk");
    writeFileSync(split, apkWithPackage("com.example.app"));
    await driver.control({ action: "install", paths: [apk, split] }, AbortSignal.timeout(5000), { personHasControl: false });
    assert.deepEqual(emulator.adb.at(-1), ["install-multiple", "-r", apk, split]);
    await assert.rejects(driver.control({ action: "install", paths: [join(paths.dir, "none.apk")] }, AbortSignal.timeout(5000), { personHasControl: false }), /no file at/);
    writeFileSync(join(paths.dir, "text.apk"), "not a zip");
    await assert.rejects(driver.control({ action: "install", paths: [join(paths.dir, "text.apk")] }, AbortSignal.timeout(5000), { personHasControl: false }), /is not an APK/);
  });

  test("an APK's package is read from its binary manifest", async () => {
    const dir = tempDir("apk");
    const path = join(dir, "app.apk");
    writeFileSync(path, apkWithPackage("org.example.shop"));
    assert.equal(await apkPackage(path), "org.example.shop");
    assert.equal(await apkPackage(join(dir, "none.apk")), null);
  });

  test("a link opens through Android's VIEW intent, quoted for the device's shell", async () => {
    const { emulator, driver } = await rig();
    await driver.attach(PIXEL_8, AbortSignal.timeout(5000));
    await driver.openUrl("https://example.com/a b'c", AbortSignal.timeout(5000));
    assert.ok(emulator.shells.includes(`am start -a android.intent.action.VIEW -d ${shellQuoted("https://example.com/a b'c")} 2>&1`));
    assert.equal(shellQuoted("it's"), `'it'\\''s'`);
  });

  test("each box gives each device its own Android ID once, by a reboot of the device, not a restart of Android's framework, and keeps it until the box changes", async () => {
    const { emulator, driver, paths } = await rig({ adbKey: "a key of this box" });
    await driver.attach(PIXEL_8, AbortSignal.timeout(5000));
    const restarts = () => emulator.reboots;
    assert.equal(restarts(), 1);
    assert.ok(emulator.shells.some((command) => command.includes("settings_ssaid.xml") && !command.includes("stop")));
    assert.notEqual(emulator.androidId, "91f5432055d42a8c");
    const marker = JSON.parse(readFileSync(identityFile(paths, "pixel_8"), "utf8")) as { androidId: string };
    assert.equal(marker.androidId, emulator.androidId);
    await driver.attach(PIXEL_8, AbortSignal.timeout(5000));
    assert.equal(restarts(), 1);
    emulator.androidId = "91f5432055d42a8c";
    await driver.attach(PIXEL_8, AbortSignal.timeout(5000));
    assert.equal(restarts(), 2);
  });

  test("the reboot for a device's own Android ID waits until Android has written the emulator's Wi-Fi to its disk, so the device comes back online (F-3)", async () => {
    const { emulator, driver } = await rig({ adbKey: "a key of this box" });
    emulator.wifiWrittenAfterChecks = 3;
    await driver.attach(PIXEL_8, AbortSignal.timeout(10_000));
    assert.deepEqual(emulator.order, ["written?", "written?", "written?", "reboot"]);
    assert.equal(emulator.wifiSaved, true);
    assert.notEqual(emulator.androidId, "91f5432055d42a8c");
    const state = await driver.readBack();
    assert.ok(state.platform === "android" && state.settings.network.known && state.settings.network.value === "online");
  });

  test("a device with no saved Wi-Fi network has the emulator's AndroidWifi saved again as it boots, and comes up online (F-3)", async () => {
    const { emulator, driver, lines } = await rig();
    emulator.wifiSaved = false;
    await driver.attach(PIXEL_8, AbortSignal.timeout(5000));
    assert.ok(emulator.shells.includes(ADD_EMULATOR_WIFI));
    assert.ok(lines.some((line) => /no saved AndroidWifi/.test(line)));
    const state = await driver.readBack();
    assert.ok(state.platform === "android" && state.settings.network.known && state.settings.network.value === "online");
    const before = emulator.shells.filter((command) => command === ADD_EMULATOR_WIFI).length;
    await driver.attach(PIXEL_8, AbortSignal.timeout(5000));
    assert.equal(emulator.shells.filter((command) => command === ADD_EMULATOR_WIFI).length, before);
  });

  test("the network reads online only with a validated default network, and setting it or booting says what the device reads when it has none (F-3)", async () => {
    const emulator = new FakeEmulator();
    const dir = tempDir("android-keeper");
    const keeper = new AndroidSettingsKeeper({
      device: { shell: (command) => emulator.shell(command), gps: async () => EMULATOR_OWN_LOCATION, setGps: async () => {}, battery: async () => ({ level: 100, charging: true }), setBattery: async () => {} },
      file: join(dir, "settings.json"),
      log: () => {},
      now: () => Date.now(),
      settleMs: { setting: 100, network: 300, boot: 300, wifiRestarted: 300, wifiWritten: 300 },
    });
    await keeper.use("Pixel 8", AbortSignal.timeout(5000));
    emulator.reachable = false;
    await keeper.read(AbortSignal.timeout(5000));
    assert.deepEqual(keeper.settings().network, { known: false, why: "The network is none of bb-box's presets: airplane mode disabled, Wi-Fi on, not slowed, a default network Android has not validated." });
    await assert.rejects(keeper.waitNetworkAfterBoot(AbortSignal.timeout(5000)), /bb-box set the network online, and restarted Wi-Fi as the device had no validated network 0\.3 s after the boot, but 0\.3 s later it reads airplane mode disabled, Wi-Fi on, not slowed, a default network Android has not validated\./);
    emulator.wifiSaved = false;
    await assert.rejects(keeper.setNetwork("online", AbortSignal.timeout(5000)), /The network was set to online, but 0\.3 s later the device reads airplane mode disabled, Wi-Fi on, not slowed, no default network\./);
    await assert.rejects(keeper.waitEmulatorWifiWritten(AbortSignal.timeout(5000)), /had not written AndroidWifi to its Wi-Fi store 0\.3 s later/);
    await keeper.setNetwork("offline", AbortSignal.timeout(5000));
    emulator.wifiSaved = true;
    emulator.reachable = true;
    await keeper.setNetwork("online", AbortSignal.timeout(5000));
    assert.ok(keeper.settings().network.known);
  });

  test("a boot whose Wi-Fi network has no validated network 10 s on restarts Wi-Fi once, as Android sometimes adds its routes before the network, and not when Wi-Fi was turned off (F-3)", async () => {
    const emulator = new FakeEmulator();
    const lines: string[] = [];
    const keeper = new AndroidSettingsKeeper({
      device: { shell: (command) => emulator.shell(command), gps: async () => EMULATOR_OWN_LOCATION, setGps: async () => {}, battery: async () => ({ level: 100, charging: true }), setBattery: async () => {} },
      file: join(tempDir("android-keeper"), "settings.json"),
      log: (line) => lines.push(line),
      now: () => Date.now(),
      settleMs: { setting: 100, network: 300, boot: 200, wifiRestarted: 300 },
    });
    await keeper.use("Pixel 8", AbortSignal.timeout(5000));
    emulator.routesLostUntilWifiRestarts = true;
    await keeper.waitNetworkAfterBoot(AbortSignal.timeout(5000));
    assert.equal(emulator.shells.filter((command) => command === RESTART_WIFI).length, 1);
    assert.ok(lines.some((line) => /0\.2 s after the boot the device reads .*a default network Android has not validated\. Restarting Wi-Fi once/.test(line)), lines.join("\n"));
    assert.ok(keeper.settings().network.known);
    emulator.routesLostUntilWifiRestarts = true;
    emulator.reachable = false;
    await assert.rejects(keeper.waitNetworkAfterBoot(AbortSignal.timeout(5000)), /restarted Wi-Fi as the device had no validated network 0\.2 s after the boot, but 0\.3 s later it reads/);
    emulator.wifi = "0";
    const before = emulator.shells.filter((command) => command === RESTART_WIFI).length;
    await assert.rejects(keeper.waitNetworkAfterBoot(AbortSignal.timeout(5000)), /0\.2 s after the boot the device reads airplane mode disabled, Wi-Fi off/);
    assert.equal(emulator.shells.filter((command) => command === RESTART_WIFI).length, before);
  });

  test("a box with no adb key yet leaves the Android ID as it is", async () => {
    const { emulator, driver, lines } = await rig();
    await driver.attach(PIXEL_8, AbortSignal.timeout(5000));
    assert.equal(emulator.androidId, "91f5432055d42a8c");
    assert.ok(lines.some((line) => /no adb key yet/.test(line)));
  });

  test("the read-back reads every setting in one shell command", () => {
    const validated = new FakeEmulator().connectivity();
    const read = parseReading(["Night mode: yes", "1.15", "  mWakefulness=Dozing", "enabled", "0", "qdisc noqueue 0: root", "1", "Active default network: none"].join("\n@@bb-box@@\n"));
    assert.deepEqual(read, { appearance: "dark", fontScale: 1.15, awake: false, network: "offline", radiosOn: false, networkWords: "airplane mode enabled, Wi-Fi off, not slowed, no default network", posture: "half-open" });
    assert.equal(parseReading(["Night mode: no", "null", "", "disabled", "1", "qdisc netem 8001: root", "", validated].join("\n@@bb-box@@\n")).network, "slow");
    assert.equal(parseReading(["Night mode: no", "null", "", "disabled", "1", "qdisc noqueue 0: root", "", validated].join("\n@@bb-box@@\n")).network, "online");
    assert.equal(parseReading(["Night mode: no", "null", "", "disabled", "1", "qdisc noqueue 0: root", "", "Active default network: none"].join("\n@@bb-box@@\n")).network, null);
    assert.equal(parseReading(["Night mode: no", "1.0", "", "enabled", "1", "", "", validated].join("\n@@bb-box@@\n")).network, null);
    assert.deepEqual(parseDefaultNetwork(validated), { id: "100", validated: true });
    assert.deepEqual(parseDefaultNetwork(validated.replace("&VALIDATED", "")), { id: "100", validated: false });
    assert.deepEqual(parseDefaultNetwork(validated.replace("network{100}", "network{101}")), { id: "100", validated: false });
    assert.deepEqual(parseDefaultNetwork("Active default network: none"), { id: null, validated: false });
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

  test("encodes nothing while nothing wants the video, still reading the screen for its geometry, and starts again from the last frame, which is no change (064)", async () => {
    const screens: { width: number; height: number; rotation: number }[] = [];
    let push: () => void = () => {};
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
      log: () => undefined,
    });
    const frames: { key: boolean; unchanged: boolean }[] = [];
    const reading = new AbortController();
    void (async () => {
      for await (const each of video.frames(reading.signal)) frames.push({ key: each.key, unchanged: !!each.unchanged });
    })();
    video.start();
    try {
      video.want(null);
      for (let index = 0; index < 3; index++) {
        screens.push({ width: 64, height: index === 2 ? 32 : 64, rotation: 0 });
        push();
        await until(`screen ${index + 1}`, () => video.framesReceived === index + 1);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(frames.length, 0, "nothing is encoded while nothing wants the video");
      assert.equal(video.framesSkipped, 3);
      assert.deepEqual(video.size, { width: 64, height: 32 }, "the screen's size is still read");
      assert.equal(generation, 2);
      video.want("full");
      await until("the last screen, encoded", () => frames.length === 1);
      assert.deepEqual(frames[0], { key: true, unchanged: true });
      video.keyframe();
      await until("the key frame asked for", () => frames.length === 2);
      assert.deepEqual(frames[1], { key: true, unchanged: true }, "the last frame encoded again is no change");
      screens.push({ width: 64, height: 32, rotation: 0 });
      push();
      await until("a change", () => frames.length === 3);
      assert.equal(frames[2]!.unchanged, false);
    } finally {
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
