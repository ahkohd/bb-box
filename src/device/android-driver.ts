import { open } from "node:fs/promises";
import { join } from "node:path";
import {
  deviceModel,
  deviceModels,
  screensOf,
  type AndroidSettings,
  type DeviceControl,
  type DeviceElement,
  type DeviceState,
  type FoldScreen,
  type OfferedDevice,
  type OfferedDeviceOf,
  type Orientation,
  type Power,
  type TableModel,
  type TouchContact,
  type VideoSize,
} from "../core/device.ts";
import { AndroidVideo, type ScreenFrame } from "./android-video.ts";
import { DriverError, type DeviceDriver, type VideoSource } from "./driver.ts";
import { Emulator, EmulatorRefused, type EmulatorControl, type RunningEmulator } from "./emulator.ts";
import { GrpcClient } from "./grpc.ts";
import { H264Encoder } from "./h264-encoder.ts";
import type { DevicePaths } from "./paths.ts";
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
const SCREENSHOT_MS = 10_000;
const RGB888 = 2;
const PNG = 0;
const MMAP = 1;
const EMU = "android.emulation.control";

const SKIN_ROTATIONS: readonly Orientation[] = ["upright", "turned-left", "upside-down", "turned-right"];

const NOT_YET = "bb-box cannot do that on an Android device yet: touch, keys and paste, and the device's controls, come in a later version.";

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

function unknownSettings(why: string): AndroidSettings {
  const unknown = { known: false as const, why };
  return { appearance: unknown, fontScale: unknown, location: unknown, battery: unknown, network: unknown, statusBar: { set: null, at: null } };
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
    if (this.#video.running) this.#video.restart(how === "booted" ? "the device booted" : "the server reattached");
    else this.#video.start();
    return how;
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

  async touch(contacts: readonly TouchContact[]): Promise<void> {
    if (!contacts.length) return;
    throw new DriverError("unsupported", NOT_YET);
  }

  async key(_key: string, down: boolean): Promise<void> {
    if (!down) return;
    throw new DriverError("unsupported", NOT_YET);
  }

  async paste(): Promise<void> {
    throw new DriverError("unsupported", NOT_YET);
  }

  async prepareInput(): Promise<void> {}

  async setClipboard(): Promise<void> {
    throw new DriverError("unsupported", NOT_YET);
  }

  async clipboard(): Promise<string> {
    throw new DriverError("unsupported", NOT_YET);
  }

  #booted(): void {
    if (this.#power.is !== "booted" || !this.#running) throw new DriverError("not-booted", `The ${this.#target?.model ?? "device"} is not booted.`);
  }

  async control(control: DeviceControl, signal: AbortSignal): Promise<void> {
    if (control.action === "reboot") {
      await this.#reboot(signal);
      return;
    }
    this.#booted();
    throw new DriverError("unsupported", NOT_YET);
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
    const power: Power<"android"> = this.#power;
    const settings = unknownSettings("This bb-box does not read an Android device's settings yet.");
    const at = this.#clock.now();
    const geometry = booted && size ? { generation: this.#generation, physical: this.#physical, content: this.#physical, video: size } : null;
    if (model.form === "foldable") {
      return {
        platform: "android",
        form: "foldable",
        model: model.name,
        power,
        geometry: geometry && size ? { ...geometry, screen: foldScreenOf(model, size)! } : null,
        posture: { known: false, why: `This bb-box does not read the ${model.name}'s posture yet.` },
        settings,
        at,
      } as DeviceState;
    }
    return { platform: "android", form: model.form, model: model.name, power, geometry, settings, at } as DeviceState;
  }
}
