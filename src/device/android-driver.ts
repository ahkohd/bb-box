import { createHash, randomBytes } from "node:crypto";
import { open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { turnedFrom } from "../core/device-settings.ts";
import {
  deviceModel,
  deviceModels,
  foldScreenFor,
  screensOf,
  type Battery,
  type DeviceControl,
  type DeviceElement,
  type DeviceState,
  type FoldScreen,
  type LatLon,
  type OfferedDevice,
  type OfferedDeviceOf,
  type Orientation,
  type Posture,
  type Power,
  type TableModel,
  type TouchContact,
  type VideoSize,
} from "../core/device.ts";
import { apkPackage } from "./apk.ts";
import { AndroidSettingsKeeper, asRoot } from "./android-controls.ts";
import { ANDROID_PASTE_LANDS_MS, PASTE_KEY, TouchesDown, emulatorKey, panelPoint, touchPanel } from "./android-input.ts";
import { AndroidVideo, type ScreenFrame } from "./android-video.ts";
import { DriverError, type ControlContext, type DeviceDriver, type VideoSource } from "./driver.ts";
import { Emulator, EmulatorRefused, type EmulatorControl, type RunningEmulator } from "./emulator.ts";
import { GrpcClient } from "./grpc.ts";
import { H264Encoder } from "./h264-encoder.ts";
import { inBox, type DevicePaths } from "./paths.ts";
import { decode, encode } from "./protobuf.ts";
import { EMULATOR_SCHEMA, GRPC_METHODS } from "./schemas.ts";

export const ENCODER_PROGRAM = "/usr/local/bin/bb-box-h264";
export const ENCODER_KBPS = 8_000;
export const ENCODER_FPS = 60;
export const WATCH_MS = 5_000;
export const CLOCK_TICK_MS = 1_000;
export const RESUME_GAP_MS = 5_000;
export const DEVICE_EXITS_WINDOW_MS = 5 * 60_000;
export const CLOCK_LAG_MOST_S = 2;
export const ROTATE_PICTURE_MS = 3_000;
export const FOLD_PICTURE_MS = 3_000;
export const INSTALL_MS = 300_000;
const SCREENSHOT_MS = 10_000;
const INPUT_MS = 5_000;
const KEYDOWN = 0;
const KEYUP = 1;
const ROTATION = 1;
const STEP = 1;
const CHARGER_NONE = 0;
const CHARGER_AC = 1;
const CHARGING = 1;
const DISCHARGING = 2;
const ROTATION_DEGREES: Readonly<Record<Orientation, number>> = { upright: 0, "turned-left": 90, "upside-down": 180, "turned-right": -90 };
const POSTURE_VALUES = { closed: 1, "half-open": 2, open: 3 } as const;
const ADB_KEY = ".android/adbkey.pub";
const SSAID = "/data/system/users/0/settings_ssaid.xml";
const RGB888 = 2;
const PNG = 0;
const MMAP = 1;
const EMU = "android.emulation.control";

const SKIN_ROTATIONS: readonly Orientation[] = ["upright", "turned-left", "upside-down", "turned-right"];

export interface AndroidDriverClock {
  now(): number;
  monotonic(): number;
}

export interface AndroidDriverOptions {
  readonly paths: DevicePaths;
  readonly log: (line: string) => void;
  readonly emulator?: EmulatorControl;
  readonly encoderProgram?: string;
  readonly grpc?: (running: RunningEmulator) => GrpcClient;
  readonly watchMs?: number;
  readonly clockTickMs?: number;
  readonly clock?: AndroidDriverClock;
  readonly home?: string;
}

export function framesFile(paths: DevicePaths): string {
  return join(paths.dir, "frames");
}

export function largestFrameBytes(): number {
  return Math.max(...deviceModels("android").flatMap((model) => screensOf(model).map((screen) => screen.pixels.width * screen.pixels.height * 3)));
}

export function skinRotation(rotation: number): Orientation {
  return SKIN_ROTATIONS[rotation] ?? "upright";
}

function sameShape(a: VideoSize, b: VideoSize): boolean {
  return (a.width === b.width && a.height === b.height) || (a.width === b.height && a.height === b.width);
}

export function foldScreenOf(model: TableModel, video: VideoSize): FoldScreen | null {
  if (model.form !== "foldable") return null;
  return sameShape(video, model.inner.pixels) ? "inner" : "outer";
}

export function shellQuoted(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function withoutTimes(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null, (key, inner) => (key === "at" ? undefined : inner)));
}

interface IdentityMarker {
  readonly box: string;
  readonly androidId: string;
}

export function identityFile(paths: DevicePaths, avd: string): string {
  return join(paths.dir, `android-id-${avd}.json`);
}

function words(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AndroidDriver implements DeviceDriver {
  readonly #options: AndroidDriverOptions;
  readonly #emulator: EmulatorControl;
  readonly #clock: AndroidDriverClock;
  readonly #video: AndroidVideo;
  readonly #listeners = new Set<() => void>();
  readonly #frames: string;
  #target: OfferedDeviceOf<"android"> | null = null;
  #running: RunningEmulator | null = null;
  #client: GrpcClient | null = null;
  #power: Power<"android"> = { is: "stopped" };
  #generation = 0;
  #physical: Orientation = "upright";
  #busy = false;
  #lastExit: number | null = null;
  #watchTimer: ReturnType<typeof setInterval> | null = null;
  #clockTimer: ReturnType<typeof setInterval> | null = null;
  #watching = false;
  #lastTick: { readonly wall: number; readonly mono: number } | null = null;
  #closed = new AbortController();
  readonly #touches = new TouchesDown();
  readonly #settings: AndroidSettingsKeeper;
  readonly pasteLandsMs = ANDROID_PASTE_LANDS_MS;

  constructor(options: AndroidDriverOptions) {
    this.#options = options;
    this.#clock = options.clock ?? { now: () => Date.now(), monotonic: () => performance.now() };
    this.#emulator = options.emulator ?? new Emulator({ dir: options.paths.dir, log: options.log });
    this.#frames = framesFile(options.paths);
    this.#video = new AndroidVideo({
      open: (signal) => this.#screens(signal),
      encoder: () =>
        new H264Encoder({ helper: options.encoderProgram ?? ENCODER_PROGRAM, bitrateKbps: ENCODER_KBPS, framesPerSecond: ENCODER_FPS, threads: 1, sharedMemory: this.#frames }),
      sized: (size, rotation) => this.#sized(size, rotation),
      recover: async () => void this.#look(),
      log: options.log,
    });
    this.#settings = new AndroidSettingsKeeper({
      file: join(options.paths.dir, "android-settings.json"),
      log: options.log,
      now: () => this.#clock.now(),
      device: {
        shell: (command, signal) => this.#emulator.shell(command, { signal }),
        gps: (signal) => this.#gps(signal),
        setGps: (to, signal) => this.#setGps(to, signal),
        battery: (signal) => this.#battery(signal),
        setBattery: (to, signal) => this.#setBattery(to, signal),
      },
    });
  }

  onChange(listener: () => void): void {
    this.#listeners.add(listener);
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }

  #log(line: string): void {
    this.#options.log(line);
  }

  #model(): TableModel {
    if (!this.#target) throw new DriverError("not-booted", "No Android device has started in this box yet.");
    return deviceModel(this.#target.model);
  }

  async #prepareFrames(): Promise<void> {
    const file = await open(this.#frames, "a", 0o600);
    try {
      const { size } = await file.stat();
      const wanted = largestFrameBytes();
      if (size < wanted) await file.truncate(wanted);
    } finally {
      await file.close();
    }
  }

  async attach(target: OfferedDevice, signal: AbortSignal): Promise<"reattached" | "booted"> {
    if (target.runtime.platform !== "android") throw new DriverError("failed", `The ${target.model} is not an Android device.`);
    const android = target as OfferedDeviceOf<"android">;
    this.#target = android;
    this.#busy = true;
    this.#power = { is: "booting", since: this.#clock.now() };
    this.#changed();
    try {
      const how = await this.#start(android, signal, false);
      this.#power = { is: "booted", awake: true };
      this.#watch();
      this.#changed();
      return how;
    } catch (error) {
      this.#power = { is: "failed", error: { code: error instanceof EmulatorRefused ? error.failure : "boot-failed", words: words(error) }, since: this.#clock.now() };
      this.#changed();
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  async #start(target: OfferedDeviceOf<"android">, signal: AbortSignal, cold: boolean): Promise<"reattached" | "booted"> {
    await this.#prepareFrames();
    let running = await this.#emulator.running();
    if (running && running.avd !== target.native) {
      this.#log(`device: the emulator runs ${running.avd}, not ${target.native}; stopping it, which saves its snapshot`);
      await this.#video.stop();
      await this.#emulator.stop(running, signal);
      running = null;
    }
    let how: "reattached" | "booted" = "reattached";
    if (running) {
      await this.#emulator.waitBooted(target.native, running.pid, signal);
    } else {
      how = "booted";
      const began = this.#clock.monotonic();
      const started = await this.#emulator.start(target.native, { cold, signal });
      running = await this.#emulator.waitRunning(target.native, signal);
      await this.#emulator.waitBooted(target.native, running.pid, signal);
      const loaded = started.unsaved
        ? "cold, as its emulator last ended without saving its snapshot, which would lose what was done since"
        : started.cold
          ? "cold, as asked"
          : (await this.#emulator.snapshotLoaded())
            ? "from its snapshot"
            : "cold: its snapshot did not load";
      this.#log(`device: the ${target.model} (${target.native}) booted in ${((this.#clock.monotonic() - began) / 1000).toFixed(1)} s, ${loaded}`);
    }
    this.#connect(running);
    await this.#setClockIfBehind(signal).catch((error) => this.#log(`clock: not checked: ${words(error)}`));
    await this.#settings.keepEmulatorWifi(signal).catch((error) => this.#log(`network: the emulator's Wi-Fi was not checked: ${words(error)}`));
    await this.#ownIdentity(target, running, signal).catch((error) => this.#log(`identity: the ${target.model} keeps the Android ID it has: ${words(error)}`));
    this.#touches.liftAll();
    if (this.#video.running) this.#video.restart(how === "booted" ? "the device booted" : "the server reattached");
    else this.#video.start();
    await this.#settings.use(target.model, signal).catch((error) => this.#log(`settings: ${words(error)}`));
    await this.#settings.read(signal).catch((error) => this.#log(`settings: not read: ${words(error)}`));
    await this.#settings.waitNetworkAfterBoot(signal).catch((error) => this.#log(`network: ${words(error)}`));
    return how;
  }

  async #boxIdentity(): Promise<string | null> {
    const key = await readFile(join(this.#options.home ?? homedir(), ADB_KEY)).catch(() => null);
    return key ? createHash("sha256").update(key).digest("hex") : null;
  }

  async #ownIdentity(target: OfferedDeviceOf<"android">, running: RunningEmulator, signal: AbortSignal): Promise<void> {
    const box = await this.#boxIdentity();
    if (!box) {
      this.#log(`identity: this box has no adb key yet, so the ${target.model}'s Android ID is left as it is`);
      return;
    }
    const file = identityFile(this.#options.paths, target.native);
    const marker = await readFile(file, "utf8").then((text) => JSON.parse(text) as IdentityMarker, () => null);
    const now = (await this.#emulator.shell("settings get secure android_id", { signal })).trim();
    if (marker?.box === box && marker.androidId === now) return;
    const began = this.#clock.monotonic();
    const androidId = randomBytes(8).toString("hex");
    this.#log(`identity: the ${target.model} has the Android ID it came with (${now}), as every box from this image has; giving it its own, which reboots the device once`);
    await this.#settings.waitEmulatorWifiWritten(signal);
    await this.#emulator.shell(asRoot(`rm -f ${SSAID}; setprop sys.boot_completed 0`), { signal });
    const rebooted = await this.#emulator.adbRun(["reboot"], { signal });
    if (rebooted.code !== 0) throw new DriverError("failed", `adb could not reboot the ${target.model}: ${rebooted.output || `it ended with ${rebooted.code}`}`);
    await this.#emulator.waitBooted(target.native, running.pid, signal);
    await this.#emulator.shell(`settings put secure android_id ${androidId}`, { signal });
    const read = (await this.#emulator.shell("settings get secure android_id", { signal })).trim();
    if (read !== androidId) throw new DriverError("failed", `The ${target.model} was given the Android ID ${androidId}, but reads ${read}.`);
    const fresh = `${file}.new`;
    await writeFile(fresh, `${JSON.stringify({ box, androidId } satisfies IdentityMarker)}\n`, { mode: 0o600 });
    await rename(fresh, file);
    this.#log(`identity: the ${target.model} has its own Android ID, ${androidId}, and its apps new IDs, in ${((this.#clock.monotonic() - began) / 1000).toFixed(1)} s`);
  }

  #connect(running: RunningEmulator): void {
    this.#client?.close();
    this.#running = running;
    this.#client = this.#options.grpc?.(running) ?? new GrpcClient({ tcp: `http://127.0.0.1:${running.grpcPort}` });
  }

  #call(): { readonly client: GrpcClient; readonly metadata: Readonly<Record<string, string>> } {
    if (!this.#client || !this.#running) throw new DriverError("not-booted", `The ${this.#target?.model ?? "device"} is not running.`);
    return { client: this.#client, metadata: { authorization: `Bearer ${this.#running.token}` } };
  }

  async *#screens(signal: AbortSignal): AsyncIterable<ScreenFrame> {
    const { client, metadata } = this.#call();
    const request = encode(EMULATOR_SCHEMA, `${EMU}.ImageFormat`, { format: RGB888, transport: { channel: MMAP, handle: `file://${this.#frames}` } });
    for await (const message of client.call(GRPC_METHODS.emulator.streamScreenshot, [request], { metadata, signal })) {
      const image = decode(EMULATOR_SCHEMA, `${EMU}.Image`, message) as { format?: { width?: number; height?: number; rotation?: { rotation?: number } } };
      yield { width: image.format?.width ?? 0, height: image.format?.height ?? 0, rotation: image.format?.rotation?.rotation ?? 0 };
    }
  }

  #sized(size: VideoSize, rotation: number): number {
    this.#generation++;
    this.#physical = skinRotation(rotation);
    this.#log(`video: the ${this.#target?.model ?? "device"} streams at ${size.width}x${size.height}, ${this.#physical.replace("-", " ")}, generation ${this.#generation}`);
    this.#changed();
    return this.#generation;
  }

  #watch(): void {
    if (this.#watchTimer) return;
    this.#watchTimer = setInterval(() => void this.#look(), this.#options.watchMs ?? WATCH_MS);
    this.#watchTimer.unref?.();
    this.#clockTimer = setInterval(() => this.#tick(), this.#options.clockTickMs ?? CLOCK_TICK_MS);
    this.#clockTimer.unref?.();
  }

  async #look(): Promise<void> {
    if (this.#watching || this.#busy || this.#power.is !== "booted" || !this.#running) return;
    this.#watching = true;
    try {
      if (!this.#emulator.alive(this.#running.pid)) await this.#exited();
    } finally {
      this.#watching = false;
    }
  }

  async #exited(): Promise<void> {
    const target = this.#target!;
    const now = this.#clock.now();
    const again = this.#lastExit !== null && now - this.#lastExit < DEVICE_EXITS_WINDOW_MS;
    this.#lastExit = now;
    this.#busy = true;
    try {
      await this.#video.stop();
      this.#client?.close();
      this.#client = null;
      const ended = this.#running?.pid;
      this.#running = null;
      if (again) {
        const said = `The ${target.model} stopped twice within ${DEVICE_EXITS_WINDOW_MS / 60_000} minutes, so bb-box leaves it stopped. Reboot the device, or restart the box, to start it again.`;
        this.#log(`device: ${said}`);
        this.#power = { is: "failed", error: { code: "device-exited", words: said }, since: now };
        this.#changed();
        return;
      }
      this.#log(`device: the emulator running the ${target.model} ended without being asked (process ${ended}); booting it again`);
      this.#power = { is: "booting", since: now };
      this.#changed();
      await this.#start(target, this.#closed.signal, false);
      this.#power = { is: "booted", awake: true };
      this.#log(`device: the ${target.model} is back`);
    } catch (error) {
      this.#power = { is: "failed", error: { code: error instanceof EmulatorRefused ? error.failure : "boot-failed", words: words(error) }, since: this.#clock.now() };
      this.#log(`device: the ${target.model} did not boot again: ${words(error)}`);
    } finally {
      this.#busy = false;
      this.#changed();
    }
  }

  #tick(): void {
    const wall = this.#clock.now();
    const mono = this.#clock.monotonic();
    const last = this.#lastTick;
    this.#lastTick = { wall, mono };
    if (!last) return;
    const tick = this.#options.clockTickMs ?? CLOCK_TICK_MS;
    const gone = Math.max(wall - last.wall, mono - last.mono) - tick;
    const parted = Math.abs(wall - last.wall - (mono - last.mono));
    if (gone > RESUME_GAP_MS || parted > RESUME_GAP_MS) void this.#resumed(Math.round(Math.max(gone, parted) / 1000));
  }

  async #resumed(seconds: number): Promise<void> {
    if (this.#busy || this.#power.is !== "booted" || !this.#running) return;
    this.#log(`resume: the clock moved ${seconds} s past this server's own, as after a stop of the box; checking the ${this.#target?.model}, its clock and its stream`);
    this.#busy = true;
    try {
      const running = await this.#emulator.running();
      if (running && running.pid === this.#running.pid) {
        this.#connect(running);
        await this.#setClockIfBehind(this.#closed.signal).catch((error) => this.#log(`resume: the device's clock was not checked: ${words(error)}`));
        this.#video.restart("the box resumed");
        this.#video.keyframe();
      }
    } finally {
      this.#busy = false;
    }
    await this.#look();
  }

  async #setClockIfBehind(signal: AbortSignal): Promise<void> {
    const device = Number((await this.#emulator.shell("date +%s", { signal })).trim());
    if (!Number.isFinite(device)) return;
    const box = Math.round(this.#clock.now() / 1000);
    const lag = box - device;
    if (lag <= CLOCK_LAG_MOST_S) return;
    await this.#emulator.shell(`su 0 toybox date -u @${box} >/dev/null`, { signal });
    const after = Number((await this.#emulator.shell("date +%s", { signal })).trim());
    this.#log(`clock: the device's clock was ${lag} s behind the box's; set, it is now ${Math.round(this.#clock.now() / 1000) - after} s behind`);
  }

  async shutdown(signal: AbortSignal): Promise<void> {
    this.#busy = true;
    try {
      await this.#video.stop();
      this.#client?.close();
      this.#client = null;
      const running = this.#running ?? (await this.#emulator.running());
      if (running) await this.#emulator.stop(running, signal);
      this.#running = null;
      this.#power = { is: "stopped" };
      this.#changed();
    } finally {
      this.#busy = false;
    }
  }

  close(): void {
    this.#closed.abort();
    if (this.#watchTimer) clearInterval(this.#watchTimer);
    if (this.#clockTimer) clearInterval(this.#clockTimer);
    this.#watchTimer = this.#clockTimer = null;
    void this.#video.stop();
    this.#client?.close();
    this.#client = null;
  }

  video(): VideoSource {
    return this.#video;
  }

  #unary(method: keyof typeof GRPC_METHODS.emulator, request: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
    const { client, metadata } = this.#call();
    return client.unary(GRPC_METHODS.emulator[method], request, { metadata, signal });
  }

  #sendKey(key: string, down: boolean): Promise<Uint8Array> {
    return this.#unary("sendKey", encode(EMULATOR_SCHEMA, `${EMU}.KeyboardEvent`, { key, eventType: down ? KEYDOWN : KEYUP }), AbortSignal.timeout(INPUT_MS));
  }

  async #press(key: string): Promise<void> {
    await this.#sendKey(key, true);
    await this.#sendKey(key, false);
  }

  async touch(contacts: readonly TouchContact[]): Promise<void> {
    if (!contacts.length && !this.#touches.any) return;
    if (!contacts.length && (this.#power.is !== "booted" || !this.#client)) {
      this.#touches.liftAll();
      return;
    }
    this.#booted();
    const model = this.#model();
    const video = this.#video.size;
    if (!video) throw new DriverError("not-booted", `The ${model.name} has sent no picture yet.`);
    const panel = touchPanel(model);
    const touches = this.#touches.next(contacts, (contact) => panelPoint(contact, video, this.#physical, panel));
    await this.#unary("sendTouch", encode(EMULATOR_SCHEMA, `${EMU}.TouchEvent`, { touches }), AbortSignal.timeout(INPUT_MS));
  }

  async key(key: string, down: boolean): Promise<void> {
    if (!down && (this.#power.is !== "booted" || !this.#client)) return;
    this.#booted();
    await this.#sendKey(emulatorKey(key), down);
  }

  async paste(): Promise<void> {
    this.#booted();
    await this.#press(PASTE_KEY);
  }

  async prepareInput(): Promise<void> {}

  async setClipboard(text: string): Promise<void> {
    this.#booted();
    await this.#unary("setClipboard", encode(EMULATOR_SCHEMA, `${EMU}.ClipData`, { text }), AbortSignal.timeout(INPUT_MS));
  }

  async clipboard(): Promise<string> {
    this.#booted();
    const answer = await this.#unary("getClipboard", new Uint8Array(0), AbortSignal.timeout(INPUT_MS));
    return (decode(EMULATOR_SCHEMA, `${EMU}.ClipData`, answer) as { text?: string }).text ?? "";
  }

  async #gps(signal: AbortSignal): Promise<LatLon> {
    const read = decode(EMULATOR_SCHEMA, `${EMU}.GpsState`, await this.#unary("getGps", new Uint8Array(0), signal)) as { latitude?: number; longitude?: number };
    return { latitude: read.latitude ?? 0, longitude: read.longitude ?? 0 };
  }

  async #setGps(to: LatLon, signal: AbortSignal): Promise<void> {
    await this.#unary("setGps", encode(EMULATOR_SCHEMA, `${EMU}.GpsState`, { passiveUpdate: false, latitude: to.latitude, longitude: to.longitude, altitude: 0, satellites: 8 }), signal);
  }

  async #battery(signal: AbortSignal): Promise<Battery> {
    const read = decode(EMULATOR_SCHEMA, `${EMU}.BatteryState`, await this.#unary("getBattery", new Uint8Array(0), signal)) as { charger?: number; chargeLevel?: number };
    return { level: read.chargeLevel ?? 0, charging: (read.charger ?? CHARGER_NONE) !== CHARGER_NONE };
  }

  async #setBattery(to: Battery, signal: AbortSignal): Promise<void> {
    await this.#unary(
      "setBattery",
      encode(EMULATOR_SCHEMA, `${EMU}.BatteryState`, { hasBattery: true, isPresent: true, charger: to.charging ? CHARGER_AC : CHARGER_NONE, chargeLevel: to.level, status: to.charging ? CHARGING : DISCHARGING }),
      signal,
    );
  }

  #booted(): void {
    if (this.#power.is !== "booted" || !this.#running) throw new DriverError("not-booted", `The ${this.#target?.model ?? "device"} is not booted.`);
  }

  async readSettings(signal: AbortSignal): Promise<void> {
    if (this.#busy || this.#power.is !== "booted" || !this.#running) return;
    const before = JSON.stringify([this.#settings.settings(), this.#settings.posture(), this.#settings.awake].map(withoutTimes));
    await this.#settings.read(signal);
    if (JSON.stringify([this.#settings.settings(), this.#settings.posture(), this.#settings.awake].map(withoutTimes)) !== before) this.#changed();
  }

  async control(control: DeviceControl, signal: AbortSignal, context: ControlContext): Promise<void> {
    if (control.action === "reboot") {
      await this.#reboot(signal);
      return;
    }
    this.#booted();
    switch (control.action) {
      case "home":
        await this.#press("GoHome");
        break;
      case "back":
        await this.#press("GoBack");
        break;
      case "recents":
        await this.#press("AppSwitch");
        break;
      case "lock":
        await this.#emulator.shell("input keyevent KEYCODE_SLEEP", { signal });
        await this.#settings.waitAwake(false, signal);
        break;
      case "wake":
        await this.#emulator.shell("input keyevent KEYCODE_WAKEUP", { signal });
        await this.#settings.waitAwake(true, signal);
        break;
      case "rotate":
        await this.#rotate(control.turn ? turnedFrom(this.#physical, control.turn) : control.to, signal);
        break;
      case "posture":
        await this.#fold(control.to, signal);
        break;
      case "appearance":
        await this.#settings.setAppearance(control.to, signal);
        break;
      case "text_size":
        if (typeof control.to === "string" && control.to !== "larger" && control.to !== "smaller" && control.to !== "default") throw new DriverError("bad-value", "Android takes a font scale, not a content size.");
        await this.#settings.setFontScale(control.to, signal);
        break;
      case "location":
        await this.#settings.setLocation(control.to, signal);
        break;
      case "status_bar":
        await this.#settings.setStatusBar(control.to, signal);
        break;
      case "battery":
        await this.#settings.setBattery(control.to, signal);
        break;
      case "network":
        await this.#settings.setNetwork(control.to, signal);
        await this.#setClockIfBehind(signal).catch((error) => this.#log(`clock: not checked after the network changed: ${words(error)}`));
        break;
      case "install":
        await this.#install(control.paths, signal, context);
        break;
      case "switch":
        throw new DriverError("failed", "The device server switches devices itself.");
    }
    await this.#settings.read(signal).catch((error) => this.#log(`settings: not read after ${control.action}: ${words(error)}`));
    this.#changed();
  }

  async #newPicture(since: number, done: () => boolean, waitMs: number, signal: AbortSignal): Promise<boolean> {
    const until = this.#clock.monotonic() + waitMs;
    while (!(this.#generation !== since && done()) && this.#clock.monotonic() < until && !signal.aborted) await new Promise((resolve) => setTimeout(resolve, 20));
    return this.#generation !== since && done();
  }

  async #rotate(to: Orientation, signal: AbortSignal): Promise<void> {
    if (to === this.#physical) return;
    const since = this.#generation;
    const began = this.#clock.monotonic();
    await this.#unary("setPhysicalModel", encode(EMULATOR_SCHEMA, `${EMU}.PhysicalModelValue`, { target: ROTATION, value: { data: [0, 0, ROTATION_DEGREES[to]] }, interpolation: STEP }), signal);
    if (!(await this.#newPicture(since, () => this.#physical === to, ROTATE_PICTURE_MS, signal)))
      throw new DriverError("failed", `The emulator was asked to turn the device ${to.replace("-", " ")}, but its picture is ${this.#physical.replace("-", " ")} ${ROTATE_PICTURE_MS / 1000} s later.`);
    this.#log(`rotate: ${to.replace("-", " ")}, its picture in ${Math.round(this.#clock.monotonic() - began)} ms`);
  }

  async #fold(to: Posture, signal: AbortSignal): Promise<void> {
    const model = this.#model();
    if (model.form !== "foldable") throw new DriverError("unsupported", `The ${model.name} does not fold.`);
    const since = this.#generation;
    const screenBefore = this.#video.size ? foldScreenOf(model, this.#video.size) : null;
    const screen = foldScreenFor(to);
    await this.#unary("setPosture", encode(EMULATOR_SCHEMA, `${EMU}.Posture`, { value: POSTURE_VALUES[to] }), signal);
    await this.#settings.waitPosture(to, signal);
    if (screenBefore === screen) return;
    if (!(await this.#newPicture(since, () => !!this.#video.size && foldScreenOf(model, this.#video.size) === screen, FOLD_PICTURE_MS, signal)))
      throw new DriverError("failed", `The ${model.name} is ${to.replace("-", " ")}, but its picture is still the ${screenBefore ?? "unknown"} screen ${FOLD_PICTURE_MS / 1000} s later.`);
  }

  async #installed(pkg: string, signal: AbortSignal): Promise<boolean> {
    return /^package:/m.test(await this.#emulator.shell(`pm path ${shellQuoted(pkg)} 2>/dev/null; true`, { signal }));
  }

  async #install(paths: readonly string[], signal: AbortSignal, context: ControlContext): Promise<void> {
    const apks = paths.map(inBox);
    for (const apk of apks) {
      const found = await stat(apk).catch(() => null);
      if (!found?.isFile()) throw new DriverError("bad-value", `There is no file at ${apk} in the box. Copy it there with box_copy, or build it in the box.`);
    }
    const pkg = await apkPackage(apks[0]!);
    if (!pkg) throw new DriverError("bad-value", `${apks[0]} is not an APK: it has no AndroidManifest.xml naming a package.`);
    if (context.personHasControl && (await this.#installed(pkg, signal)))
      throw new DriverError("person-has-control", `A person has control of this box's device, and ${pkg} is installed on it already: installing it again would stop it if it is open. Wait for them to hand control back, or take it back with computer_take_control when they ask.`);
    const began = this.#clock.monotonic();
    const ran = await this.#emulator.adbRun(apks.length === 1 ? ["install", "-r", apks[0]!] : ["install-multiple", "-r", ...apks], { signal, timeoutMs: INSTALL_MS });
    if (ran.code !== 0 || !/\bSuccess\b/.test(ran.output)) throw new DriverError("failed", `adb could not install ${pkg}: ${ran.output.split("\n").slice(-3).join(" ") || `it ended with ${ran.code}`}`);
    await this.#emulator.shell("sync", { signal });
    this.#log(`install: ${pkg} from ${apks.join(", ")} in ${((this.#clock.monotonic() - began) / 1000).toFixed(1)} s, written to the device's disk`);
  }

  async openUrl(url: string, signal: AbortSignal): Promise<void> {
    this.#booted();
    const began = this.#clock.monotonic();
    const said = await this.#emulator.shell(`am start -a android.intent.action.VIEW -d ${shellQuoted(url)} 2>&1`, { signal });
    if (/^Error/m.test(said)) throw new DriverError("failed", `Android could not open ${url}: ${said.split("\n").filter((line) => /Error/.test(line)).join(" ")}`);
    this.#log(`open: ${url} in ${Math.round(this.#clock.monotonic() - began)} ms`);
  }

  async #reboot(signal: AbortSignal): Promise<void> {
    const target = this.#target;
    if (!target) throw new DriverError("not-booted", "No Android device has started in this box yet.");
    this.#busy = true;
    const began = this.#clock.monotonic();
    this.#power = { is: "booting", since: this.#clock.now() };
    this.#changed();
    try {
      await this.#video.stop();
      this.#client?.close();
      this.#client = null;
      const running = this.#running ?? (await this.#emulator.running());
      if (running) await this.#emulator.stop(running, signal);
      this.#running = null;
      await this.#start(target, signal, true);
      this.#power = { is: "booted", awake: true };
      this.#lastExit = null;
      this.#log(`device: the ${target.model} rebooted in ${((this.#clock.monotonic() - began) / 1000).toFixed(1)} s`);
    } catch (error) {
      this.#power = { is: "failed", error: { code: error instanceof EmulatorRefused ? error.failure : "boot-failed", words: words(error) }, since: this.#clock.now() };
      throw error;
    } finally {
      this.#busy = false;
      this.#changed();
    }
  }

  async screenshot(): Promise<Uint8Array> {
    this.#booted();
    const { client, metadata } = this.#call();
    const answer = await client.unary(GRPC_METHODS.emulator.getScreenshot, encode(EMULATOR_SCHEMA, `${EMU}.ImageFormat`, { format: PNG }), { metadata, signal: AbortSignal.timeout(SCREENSHOT_MS) });
    const image = decode(EMULATOR_SCHEMA, `${EMU}.Image`, answer) as { image?: Uint8Array };
    if (!image.image?.byteLength) throw new DriverError("failed", "The emulator sent an empty screenshot.");
    return image.image;
  }

  async tree(): Promise<readonly DeviceElement[]> {
    throw new DriverError("unsupported", "This bb-box cannot read an Android device's elements yet.");
  }

  async readBack(): Promise<DeviceState> {
    const model = this.#model();
    if (model.platform !== "android") throw new DriverError("failed", `The ${model.name} is not an Android device.`);
    const size = this.#video.size;
    const booted = this.#power.is === "booted" && !!size;
    const power: Power<"android"> = this.#power.is === "booted" ? { is: "booted", awake: this.#settings.awake ?? true } : this.#power;
    const settings = this.#settings.settings();
    const at = this.#clock.now();
    const geometry = booted && size ? { generation: this.#generation, physical: this.#physical, content: this.#physical, video: size } : null;
    if (model.form === "foldable") {
      return {
        platform: "android",
        form: "foldable",
        model: model.name,
        power,
        geometry: geometry && size ? { ...geometry, screen: foldScreenOf(model, size)! } : null,
        posture: this.#settings.posture(),
        settings,
        at,
      } as DeviceState;
    }
    return { platform: "android", form: model.form, model: model.name, power, geometry, settings, at } as DeviceState;
  }
}
