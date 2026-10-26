import { execFile } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEVICE_HUB_PROCESS,
  deviceModel,
  screensOf,
  type DeviceControl,
  type DeviceElement,
  type DeviceState,
  type IosSettings,
  type OfferedDevice,
  type OfferedDeviceOf,
  type Orientation,
  type Power,
  type TableModel,
  type TouchContact,
  type VideoSize,
} from "../core/device.ts";
import { DriverError, type DeviceDriver, type PinchGesture, type VideoSource } from "./driver.ts";
import { Companion, orientation, screenshot, videoStream } from "./idb.ts";
import { IosInput, PasteboardAccess, typesWithOption } from "./ios-input.ts";
import { IosVideo } from "./ios-video.ts";
import type { DevicePaths } from "./paths.ts";
import { Simctl, type SimDevice } from "./simctl.ts";

export const SLIM_LISTS = "/usr/local/share/bb-box/ios";
export const WATCH_MS = 5_000;
export const CLOCK_TICK_MS = 1_000;
export const RESUME_GAP_MS = 5_000;
export const DEVICE_EXITS_WINDOW_MS = 5 * 60_000;
const SHUTTING_DOWN_WAIT_MS = 30_000;
const SLIM_PASSES = 2;

export interface IosDriverClock {
  now(): number;
  monotonic(): number;
}

export interface IosDriverOptions {
  readonly paths: DevicePaths;
  readonly slim: boolean;
  readonly log: (line: string) => void;
  readonly simctl?: Simctl;
  readonly companionProgram?: string;
  readonly slimLists?: string;
  readonly watchMs?: number;
  readonly clockTickMs?: number;
  readonly clock?: IosDriverClock;
  readonly processes?: (name: string) => Promise<number[]>;
  readonly access?: PasteboardAccess;
}

export interface DeviceHubKills {
  readonly killed: number;
  readonly last: number | null;
}

export function iosPaths(paths: DevicePaths) {
  return {
    companion: { socket: join(paths.dir, "idb.sock"), record: join(paths.dir, "companion.json"), log: join(paths.dir, "companion.log") },
    deviceHub: join(paths.dir, "device-hub.json"),
  };
}

function ownProcesses(name: string): Promise<number[]> {
  return new Promise((resolve) =>
    execFile("pgrep", ["-x", "-U", String(process.getuid?.() ?? 0), name], (error, stdout) =>
      resolve(error ? [] : stdout.split("\n").map(Number).filter((pid) => Number.isInteger(pid) && pid > 0)),
    ),
  );
}

function sideways(orientation: Orientation): boolean {
  return orientation === "turned-left" || orientation === "turned-right";
}

export function contentOrientation(physical: Orientation, video: VideoSize, model: TableModel): Orientation {
  const screen = model.form === "foldable" ? model.outer : model.screen;
  const turned = video.width > video.height !== screen.pixels.width > screen.pixels.height;
  if (turned === sideways(physical)) return physical;
  return turned ? "turned-left" : "upright";
}

const NOT_READ = "This bb-box does not read the device's settings yet.";

function unreadSettings(): IosSettings {
  return { appearance: { known: false, why: NOT_READ }, textSize: { known: false, why: NOT_READ }, location: { set: null, at: null }, statusBar: { set: null, at: null } };
}

function words(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class IosDriver implements DeviceDriver {
  readonly #options: IosDriverOptions;
  readonly #simctl: Simctl;
  readonly #clock: IosDriverClock;
  readonly #companion: Companion;
  readonly #video: IosVideo;
  readonly #input: IosInput;
  readonly #listeners = new Set<() => void>();
  readonly #processes: (name: string) => Promise<number[]>;
  readonly #deviceHubFile: string;
  #target: OfferedDeviceOf<"ios"> | null = null;
  #udid: string | null = null;
  #power: Power<"ios"> = { is: "stopped" };
  #generation = 0;
  #physical: Orientation = "upright";
  #busy = false;
  #lastExit: number | null = null;
  #watchTimer: ReturnType<typeof setInterval> | null = null;
  #clockTimer: ReturnType<typeof setInterval> | null = null;
  #watching = false;
  #lastTick: { readonly wall: number; readonly mono: number } | null = null;
  #closed = new AbortController();

  constructor(options: IosDriverOptions) {
    this.#options = options;
    this.#simctl = options.simctl ?? new Simctl();
    this.#clock = options.clock ?? { now: () => Date.now(), monotonic: () => performance.now() };
    this.#processes = options.processes ?? ownProcesses;
    const own = iosPaths(options.paths);
    this.#deviceHubFile = own.deviceHub;
    this.#companion = new Companion({ program: options.companionProgram, paths: own.companion, log: options.log });
    this.#video = new IosVideo({
      open: (stopped, signal) => videoStream(this.#companion.client, stopped, signal),
      recover: (error) => this.#recover(error),
      sized: (size) => this.#sized(size),
      log: options.log,
      monotonic: () => this.#clock.monotonic(),
    });
    this.#input = new IosInput({
      client: () => this.#companion.client,
      scale: () => screensOf(this.#model())[0].scale,
      access: options.access ?? new PasteboardAccess({ udid: () => this.#udid, log: options.log }),
      log: options.log,
    });
  }

  get udid(): string | null {
    return this.#udid;
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
    if (!this.#target) throw new DriverError("not-booted", "No iOS device has started in this box yet.");
    return deviceModel(this.#target.model);
  }

  async #find(target: OfferedDeviceOf<"ios">, signal: AbortSignal): Promise<SimDevice> {
    const devices = await this.#simctl.devices(signal);
    const matching = devices.filter((device) => device.name === target.model && device.type === target.native && device.available);
    if (!matching.length) {
      const seen = devices.filter((device) => device.available).map((device) => device.name);
      throw new DriverError("failed", `This box has no simulator device named ${target.model} of type ${target.native}. Its image should have made it. It has: ${seen.join(", ") || "none"}.`);
    }
    return matching.find((device) => device.state === "Booted") ?? matching[0]!;
  }

  async attach(target: OfferedDevice, signal: AbortSignal): Promise<"reattached" | "booted"> {
    if (target.runtime.platform !== "ios") throw new DriverError("failed", `The ${target.model} is not an iOS device.`);
    const ios = target as OfferedDeviceOf<"ios">;
    this.#target = ios;
    this.#busy = true;
    this.#power = { is: "booting", since: this.#clock.now() };
    this.#changed();
    try {
      const how = await this.#start(ios, signal);
      this.#power = { is: "booted", awake: true };
      this.#watch();
      this.#changed();
      return how;
    } catch (error) {
      this.#power = { is: "failed", error: { code: error instanceof DriverError && /idb_companion/.test(error.message) ? "companion-failed" : "boot-failed", words: words(error) }, since: this.#clock.now() };
      this.#changed();
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  async #start(target: OfferedDeviceOf<"ios">, signal: AbortSignal): Promise<"reattached" | "booted"> {
    let device = await this.#find(target, signal);
    this.#udid = device.udid;
    const began = this.#clock.monotonic();
    if (device.state === "Shutting Down") {
      const until = this.#clock.monotonic() + SHUTTING_DOWN_WAIT_MS;
      while (device.state === "Shutting Down" && this.#clock.monotonic() < until) {
        await wait(250);
        device = (await this.#simctl.device(device.udid, signal)) ?? device;
      }
    }
    const running = device.state === "Booted";
    await this.#simctl.boot(device.udid, signal);
    if (!running) this.#log(`device: the ${target.model} (${device.udid}) booted in ${((this.#clock.monotonic() - began) / 1000).toFixed(1)} s`);
    const rebooted = await this.#slimming(target, device.udid, signal);
    const companion = await this.#companion.ensure(device.udid, signal);
    if (companion === "started") this.#input.close();
    this.#physical = await orientation(this.#companion.client, signal).catch(() => null) ?? "upright";
    if (this.#video.running) this.#video.restart(`idb_companion was ${companion}`);
    else this.#video.start();
    return running && !rebooted ? "reattached" : "booted";
  }

  async #slimList(name: string): Promise<readonly string[] | null> {
    const text = await readFile(join(this.#options.slimLists ?? SLIM_LISTS, `${name}.txt`), "utf8").catch(() => null);
    return text === null ? null : text.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  async #slimming(target: OfferedDeviceOf<"ios">, udid: string, signal: AbortSignal): Promise<boolean> {
    const slim = target.slim;
    if (!slim) return false;
    const labels = await this.#slimList(slim.list);
    if (!labels) {
      this.#log(`slim: this box has no list ${slim.list}, so the ${target.model}'s services are left as they are`);
      return false;
    }
    const began = this.#clock.monotonic();
    const off = async () => {
      const disabled = await this.#simctl.disabled(udid, signal);
      return labels.filter((label) => disabled.has(label));
    };
    let disabled = await off();
    if (this.#options.slim) {
      if (disabled.length === labels.length) {
        this.#log(`slim: the ${target.model} has all ${labels.length} services of ${slim.list} off`);
        return false;
      }
      this.#log(`slim: the ${target.model} has ${disabled.length} of the ${labels.length} services of ${slim.list} off; turning the rest off, then rebooting it`);
      for (let pass = 1; pass <= SLIM_PASSES && disabled.length < labels.length; pass++) {
        for (const label of labels) if (!disabled.includes(label)) await this.#simctl.setService(udid, label, false, signal);
        await this.#simctl.reboot(udid, signal);
        disabled = await off();
      }
      const seconds = ((this.#clock.monotonic() - began) / 1000).toFixed(1);
      if (disabled.length < labels.length) this.#log(`slim: the ${target.model} still has ${labels.length - disabled.length} of its ${labels.length} services on after ${SLIM_PASSES} passes, ${seconds} s`);
      else this.#log(`slim: the ${target.model} has all ${labels.length} services of ${slim.list} off again, in ${seconds} s with its reboots`);
      return true;
    }
    if (!disabled.length) {
      this.#log(`slim: off for this box, and the ${target.model} has every service on`);
      return false;
    }
    this.#log(`slim: off for this box, and the ${target.model} has ${disabled.length} of the ${labels.length} services of ${slim.list} off; turning them on, then rebooting it`);
    for (const label of disabled) await this.#simctl.setService(udid, label, true, signal);
    await this.#simctl.reboot(udid, signal);
    disabled = await off();
    this.#log(`slim: the ${target.model} has ${disabled.length} of those services off now, in ${((this.#clock.monotonic() - began) / 1000).toFixed(1)} s with its reboot`);
    return true;
  }

  #sized(size: VideoSize): number {
    this.#generation++;
    this.#input.close();
    this.#log(`video: the ${this.#target?.model ?? "device"} streams at ${size.width}x${size.height}, generation ${this.#generation}`);
    void this.#readOrientation();
    this.#changed();
    return this.#generation;
  }

  async #readOrientation(): Promise<void> {
    const read = await orientation(this.#companion.client).catch(() => null);
    if (read && read !== this.#physical) {
      this.#physical = read;
      this.#changed();
    }
  }

  async #recover(error: unknown): Promise<void> {
    if (this.#busy || !this.#udid || this.#closed.signal.aborted) return;
    if (!(await this.#companion.alive())) this.#log(`companion: idb_companion is gone (${words(error)}); starting it again`);
    if ((await this.#companion.ensure(this.#udid, this.#closed.signal)) === "started") this.#input.close();
  }

  #watch(): void {
    if (this.#watchTimer) return;
    this.#watchTimer = setInterval(() => void this.#look(), this.#options.watchMs ?? WATCH_MS);
    this.#watchTimer.unref?.();
    this.#clockTimer = setInterval(() => this.#tick(), this.#options.clockTickMs ?? CLOCK_TICK_MS);
    this.#clockTimer.unref?.();
    void this.#look();
  }

  async #look(): Promise<void> {
    if (this.#watching) return;
    this.#watching = true;
    try {
      await this.#deviceHub();
      if (this.#busy || !this.#udid || this.#power.is !== "booted") return;
      const device = await this.#simctl.device(this.#udid).catch(() => undefined);
      if (device === undefined || this.#busy) return;
      if (device?.state !== "Booted") await this.#exited(device?.state ?? "gone");
    } finally {
      this.#watching = false;
    }
  }

  async #deviceHub(): Promise<void> {
    const pids = await this.#processes(DEVICE_HUB_PROCESS).catch(() => []);
    if (!pids.length) return;
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    const known = await this.deviceHubKills();
    const kills: DeviceHubKills = { killed: known.killed + pids.length, last: this.#clock.now() };
    const fresh = `${this.#deviceHubFile}.new`;
    await writeFile(fresh, `${JSON.stringify(kills)}\n`, { mode: 0o600 }).then(() => rename(fresh, this.#deviceHubFile)).catch(() => undefined);
    this.#log(`device hub: Device Hub started (process ${pids.join(", ")}), and was killed, as it takes the device's pasteboard; quitting it would shut the device down`);
  }

  async deviceHubKills(): Promise<DeviceHubKills> {
    try {
      const parsed = JSON.parse(await readFile(this.#deviceHubFile, "utf8")) as Partial<DeviceHubKills>;
      return { killed: typeof parsed.killed === "number" ? parsed.killed : 0, last: typeof parsed.last === "number" ? parsed.last : null };
    } catch {
      return { killed: 0, last: null };
    }
  }

  async #exited(state: string): Promise<void> {
    const target = this.#target!;
    const now = this.#clock.now();
    const again = this.#lastExit !== null && now - this.#lastExit < DEVICE_EXITS_WINDOW_MS;
    this.#lastExit = now;
    this.#busy = true;
    try {
      await this.#video.stop();
      if (again) {
        const words = `The ${target.model} stopped twice within ${DEVICE_EXITS_WINDOW_MS / 60_000} minutes, so bb-box leaves it stopped. Restart the box to start it again.`;
        this.#log(`device: ${words}`);
        this.#power = { is: "failed", error: { code: "device-exited", words }, since: now };
        this.#changed();
        return;
      }
      this.#log(`device: the ${target.model} stopped (${state}) without being asked; booting it again`);
      this.#power = { is: "booting", since: now };
      this.#changed();
      await this.#start(target, this.#closed.signal);
      this.#power = { is: "booted", awake: true };
      this.#log(`device: the ${target.model} is back`);
    } catch (error) {
      this.#power = { is: "failed", error: { code: "boot-failed", words: words(error) }, since: this.#clock.now() };
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
    if (this.#busy || !this.#udid || this.#power.is !== "booted") return;
    this.#log(`resume: the clock moved ${seconds} s past this server's own, as after a stop of the box; starting idb_companion again, as one from before the stop grows without bound, and checking the ${this.#target?.model}`);
    this.#busy = true;
    try {
      await this.#video.stop();
      this.#input.close();
      await this.#companion.restart(this.#udid, this.#closed.signal);
    } catch (error) {
      this.#log(`resume: idb_companion did not start again: ${words(error)}`);
    } finally {
      this.#busy = false;
      this.#video.start();
    }
    await this.#look();
  }

  async shutdown(signal: AbortSignal): Promise<void> {
    this.#busy = true;
    try {
      await this.#video.stop();
      this.#input.close();
      await this.#companion.stop();
      if (this.#udid) await this.#simctl.shutdown(this.#udid, signal);
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
    this.#input.close();
    void this.#video.stop();
    this.#companion.close();
  }

  video(): VideoSource {
    return this.#video;
  }

  async touch(contacts: readonly TouchContact[]): Promise<void> {
    if (!contacts.length && this.#power.is !== "booted") return;
    this.#booted();
    this.#input.touch(contacts);
  }

  async pinch(gesture: PinchGesture, signal: AbortSignal): Promise<void> {
    this.#booted();
    await this.#input.pinch(gesture, signal);
  }

  async key(key: string, down: boolean): Promise<void> {
    if (!down && this.#power.is !== "booted") return;
    this.#booted();
    await this.#input.key(key, down);
  }

  typesAsKeys(character: string): boolean {
    return typesWithOption(character);
  }

  async paste(): Promise<void> {
    this.#booted();
    await this.#input.paste();
  }

  async prepareInput(): Promise<void> {
    if (this.#power.is === "booted") this.#input.prepare();
  }

  #booted(): string {
    if (this.#power.is !== "booted" || !this.#udid) throw new DriverError("not-booted", `The ${this.#target?.model ?? "device"} is not booted.`);
    return this.#udid;
  }

  async setClipboard(text: string): Promise<void> {
    await this.#simctl.setClipboard(this.#booted(), text);
  }

  async clipboard(): Promise<string> {
    return this.#simctl.clipboard(this.#booted());
  }

  async control(control: DeviceControl): Promise<void> {
    throw new DriverError("unsupported", `This bb-box cannot ${control.action.replace("_", " ")} an iOS device yet.`);
  }

  async screenshot(): Promise<Uint8Array> {
    this.#booted();
    return screenshot(this.#companion.client);
  }

  async tree(): Promise<readonly DeviceElement[]> {
    throw new DriverError("unsupported", "This bb-box cannot read an iOS device's elements yet.");
  }

  async readBack(): Promise<DeviceState> {
    const model = this.#model();
    if (model.platform !== "ios") throw new DriverError("failed", `The ${model.name} is not an iOS device.`);
    const size = this.#video.size;
    const geometry =
      this.#power.is === "booted" && size ? { generation: this.#generation, physical: this.#physical, content: contentOrientation(this.#physical, size, model), video: size } : null;
    return { platform: "ios", model: model.name, power: this.#power, geometry, settings: unreadSettings(), at: this.#clock.now() };
  }
}
