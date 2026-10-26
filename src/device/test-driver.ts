import { CLEAN_STATUS_BAR_BATTERY, nextContentSize, nextFontScale } from "../core/device-settings.ts";
import { rgbaPng } from "../core/png.ts";
import {
  deviceModel,
  orientationWord,
  platformWord,
  type AndroidSettings,
  type DeviceControl,
  type DeviceElement,
  type DevicePlatform,
  type DeviceState,
  type Geometry,
  type IosSettings,
  type LaunchedApp,
  type OfferedDevice,
  type Orientation,
  type Power,
  type TouchContact,
  type VideoSize,
  type VideoStep,
} from "../core/device.ts";
import { DriverError, type DeviceDriver, type EncodedFrame, type VideoSource } from "./driver.ts";
import { PcmH264Encoder, yuvFromRgba } from "./pcm-h264.ts";
import { cardLine, drawCard, type CardContent } from "./test-card.ts";

const LONGEST_VIDEO_EDGE = 960;
const REBOOT_MS = 300;
const CLOCK_TICK_MS = 1000;
const QUARTER_TURNS: readonly Orientation[] = ["upright", "turned-right", "upside-down", "turned-left"];

export interface TestDriverClock {
  now(): number;
  monotonic(): number;
}

const SYSTEM_CLOCK: TestDriverClock = { now: () => Date.now(), monotonic: () => performance.now() };

export function testVideoSize(pixels: VideoSize): VideoSize {
  const shrink = Math.max(1, Math.ceil(Math.max(pixels.width, pixels.height) / LONGEST_VIDEO_EDGE));
  const even = (value: number) => Math.max(2, Math.round(value / shrink / 2) * 2);
  return { width: even(pixels.width), height: even(pixels.height) };
}

function sideways(orientation: Orientation): boolean {
  return orientation === "turned-left" || orientation === "turned-right";
}

function turned(from: Orientation, turn: "left" | "right"): Orientation {
  const at = QUARTER_TURNS.indexOf(from);
  return QUARTER_TURNS[(at + (turn === "right" ? 1 : 3)) % 4]!;
}

export const TEST_APP: LaunchedApp = { id: "com.example.test-card", name: "Test Card" };

export interface TestRecord {
  readonly touches: (readonly TouchContact[])[];
  readonly keys: { readonly key: string; readonly down: boolean }[];
  readonly pastes: string[];
  readonly controls: DeviceControl[];
  readonly opened: string[];
  readonly launched: string[];
  readonly steps: (VideoStep | null)[];
  prepared: number;
}

class Frames implements VideoSource {
  readonly #driver: TestDriver;
  constructor(driver: TestDriver) {
    this.#driver = driver;
  }

  frames(signal: AbortSignal): AsyncIterable<EncodedFrame> {
    return this.#driver.frameStream(signal);
  }

  keyframe(): void {
    this.#driver.askKeyframe();
  }

  want(step: VideoStep | null): void {
    this.#driver.wanted(step);
  }
}

export class TestDriver implements DeviceDriver {
  readonly platform: DevicePlatform;
  readonly record: TestRecord = { touches: [], keys: [], pastes: [], controls: [], opened: [], launched: [], steps: [], prepared: 0 };
  readonly #clock: TestDriverClock;
  readonly #listeners = new Set<() => void>();
  readonly #frameWaiters = new Set<() => void>();
  #target: OfferedDevice | null = null;
  #power: Power = { is: "stopped" };
  #physical: Orientation = "upright";
  #generation = 0;
  #appearance: "light" | "dark" = "light";
  #clipboard = "";
  #touches: readonly TouchContact[] = [];
  #iosSettings: IosSettings | null = null;
  #androidSettings: AndroidSettings | null = null;
  #encoder: PcmH264Encoder | null = null;
  #keyAsked = true;
  #latest: EncodedFrame | null = null;
  #lastCard = "";
  #ticker: ReturnType<typeof setInterval> | null = null;
  #frameCount = 0;

  constructor(platform: DevicePlatform, clock: TestDriverClock = SYSTEM_CLOCK) {
    this.platform = platform;
    this.#clock = clock;
  }

  onChange(listener: () => void): void {
    this.#listeners.add(listener);
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
    this.#draw();
  }

  get framesSent(): number {
    return this.#frameCount;
  }

  async attach(target: OfferedDevice, signal: AbortSignal): Promise<"reattached" | "booted"> {
    signal.throwIfAborted();
    if (target.runtime.platform !== this.platform) throw new DriverError("failed", `The test device stands in for an ${platformWord(this.platform)} device, not the ${target.model}.`);
    const same = this.#target?.model === target.model && this.#power.is === "booted";
    this.#target = target;
    if (same) return "reattached";
    this.#physical = "upright";
    this.#generation++;
    this.#encoder = null;
    this.#keyAsked = true;
    const at = this.#clock.now();
    this.#iosSettings = {
      appearance: { known: true, value: this.#appearance, at, by: "bb-box" },
      textSize: { known: true, value: "large", at, by: "bb-box" },
      location: { set: null, at: null },
      statusBar: { set: null, at: null },
    };
    this.#androidSettings = {
      appearance: { known: true, value: this.#appearance, at, by: "bb-box" },
      fontScale: { known: true, value: 1, at, by: "bb-box" },
      location: { known: true, value: null, at, by: "bb-box" },
      battery: { known: true, value: { level: 100, charging: true }, at, by: "bb-box" },
      network: { known: true, value: "online", at, by: "bb-box" },
      statusBar: { set: null, at: null },
    };
    this.#power = { is: "booted", awake: true };
    this.#ticker ??= setInterval(() => this.#draw(), CLOCK_TICK_MS);
    this.#ticker.unref?.();
    this.#changed();
    return "booted";
  }

  async shutdown(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.#power = { is: "stopped" };
    this.#changed();
  }

  close(): void {
    if (this.#ticker) clearInterval(this.#ticker);
    this.#ticker = null;
    for (const wake of this.#frameWaiters) wake();
  }

  video(): VideoSource {
    return new Frames(this);
  }

  #model() {
    if (!this.#target) throw new DriverError("not-booted", "The test device has not started.");
    return deviceModel(this.#target.model);
  }

  #videoSize(): VideoSize {
    const model = this.#model();
    const screen = model.form === "foldable" ? model.outer : model.screen;
    const upright = testVideoSize(screen.pixels);
    return sideways(this.#physical) ? { width: upright.height, height: upright.width } : upright;
  }

  #geometry(): Geometry | null {
    if (this.#power.is !== "booted") return null;
    return { generation: this.#generation, physical: this.#physical, content: this.#physical, video: this.#videoSize() };
  }

  #card(): CardContent {
    const size = this.#videoSize();
    const clock = new Date(this.#clock.now()).toISOString().slice(11, 19);
    const clipboard = this.#clipboard ? ["CLIPBOARD", cardLine(this.#clipboard, size)] : [];
    const opened = this.record.opened.at(-1);
    const link = opened ? ["OPENED", cardLine(opened, size)] : [];
    const lines = [this.#target!.model, `AS AN ${platformWord(this.platform)} DEVICE`, orientationWord(this.#physical), `${size.width}X${size.height}`, `CONTROLS ${this.record.controls.length}`, ...clipboard, ...link];
    return { size, appearance: this.#appearance, lines, clock, touches: this.#touches };
  }

  #draw(): void {
    if (this.#power.is !== "booted" || !this.#target) return;
    const content = this.#card();
    const size = content.size;
    const card = JSON.stringify({ ...content, generation: this.#generation });
    if (card === this.#lastCard && !this.#keyAsked) return;
    const unchanged = card === this.#lastCard;
    this.#lastCard = card;
    if (!this.#encoder || this.#encoder.size.width !== size.width || this.#encoder.size.height !== size.height) {
      this.#encoder = new PcmH264Encoder(size);
      this.#keyAsked = true;
    }
    const canvas = drawCard(content);
    const encoded = this.#encoder.encode(yuvFromRgba(size, canvas.rgba), this.#keyAsked);
    this.#keyAsked = false;
    if (!encoded) return;
    this.#frameCount++;
    this.#latest = { data: encoded.data, key: encoded.key, generation: this.#generation, monotonicMs: this.#clock.monotonic(), width: size.width, height: size.height, ...(unchanged ? { unchanged } : {}) };
    for (const wake of this.#frameWaiters) wake();
  }

  askKeyframe(): void {
    this.#keyAsked = true;
    this.#draw();
  }

  wanted(step: VideoStep | null): void {
    const opens = step !== null && (this.record.steps.at(-1) ?? null) === null;
    this.record.steps.push(step);
    if (opens) this.askKeyframe();
  }

  async *frameStream(signal: AbortSignal): AsyncIterable<EncodedFrame> {
    let seen: EncodedFrame | null = null;
    while (!signal.aborted) {
      const latest = this.#latest;
      if (latest && latest !== seen) {
        seen = latest;
        yield latest;
        continue;
      }
      await new Promise<void>((resolve) => {
        const wake = () => {
          this.#frameWaiters.delete(wake);
          signal.removeEventListener("abort", wake);
          resolve();
        };
        this.#frameWaiters.add(wake);
        signal.addEventListener("abort", wake, { once: true });
      });
    }
  }

  #booted(): void {
    if (this.#power.is !== "booted") throw new DriverError("not-booted", `The ${this.#target?.model ?? "test device"} is not booted.`);
  }

  async touch(contacts: readonly TouchContact[]): Promise<void> {
    this.#booted();
    this.record.touches.push(contacts);
    this.#touches = contacts;
    this.#draw();
  }

  async key(key: string, down: boolean): Promise<void> {
    this.#booted();
    this.record.keys.push({ key, down });
  }

  async paste(): Promise<void> {
    this.#booted();
    this.record.pastes.push(this.#clipboard);
  }

  async prepareInput(): Promise<void> {
    this.record.prepared++;
  }

  async setClipboard(text: string): Promise<void> {
    this.#clipboard = text;
    this.#draw();
  }

  async clipboard(): Promise<string> {
    return this.#clipboard;
  }

  async control(control: DeviceControl, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.#booted();
    this.record.controls.push(control);
    const at = this.#clock.now();
    switch (control.action) {
      case "rotate":
        this.#physical = control.turn ? turned(this.#physical, control.turn) : control.to;
        this.#generation++;
        break;
      case "appearance":
        this.#appearance = control.to;
        if (this.#iosSettings) this.#iosSettings = { ...this.#iosSettings, appearance: { known: true, value: control.to, at, by: "bb-box" } };
        if (this.#androidSettings) this.#androidSettings = { ...this.#androidSettings, appearance: { known: true, value: control.to, at, by: "bb-box" } };
        break;
      case "text_size": {
        const ios = this.#iosSettings;
        const android = this.#androidSettings;
        if (ios?.textSize.known && typeof control.to !== "number") {
          const to = control.to === "larger" || control.to === "smaller" || control.to === "default" ? nextContentSize(ios.textSize.value, control.to) : control.to;
          this.#iosSettings = { ...ios, textSize: { known: true, value: to, at, by: "bb-box" } };
        }
        if (android?.fontScale.known) {
          const to = typeof control.to === "number" ? control.to : control.to === "larger" || control.to === "smaller" || control.to === "default" ? nextFontScale(android.fontScale.value, control.to) : null;
          if (to !== null) this.#androidSettings = { ...android, fontScale: { known: true, value: to, at, by: "bb-box" } };
        }
        break;
      }
      case "location":
        if (this.#iosSettings) this.#iosSettings = { ...this.#iosSettings, location: control.to ? { set: control.to, at } : { set: null, at } };
        if (this.#androidSettings) this.#androidSettings = { ...this.#androidSettings, location: { known: true, value: control.to, at, by: "bb-box" } };
        break;
      case "status_bar":
        if (this.#iosSettings) {
          const battery = this.#iosSettings.statusBar.set?.battery ?? CLEAN_STATUS_BAR_BATTERY;
          this.#iosSettings = { ...this.#iosSettings, statusBar: control.to === "clean" ? { set: { clean: true, battery }, at } : { set: null, at } };
        }
        if (this.#androidSettings) this.#androidSettings = { ...this.#androidSettings, statusBar: control.to === "clean" ? { set: "clean", at } : { set: null, at } };
        break;
      case "battery":
        if (this.#iosSettings) {
          const clean = this.#iosSettings.statusBar.set?.clean ?? false;
          this.#iosSettings = { ...this.#iosSettings, statusBar: clean || control.to ? { set: { clean, battery: control.to }, at } : { set: null, at } };
        }
        if (this.#androidSettings) this.#androidSettings = { ...this.#androidSettings, battery: { known: true, value: control.to ?? { level: 100, charging: true }, at, by: "bb-box" } };
        break;
      case "network":
        if (this.#androidSettings) this.#androidSettings = { ...this.#androidSettings, network: { known: true, value: control.to, at, by: "bb-box" } };
        break;
      case "lock":
        this.#power = { is: "booted", awake: false };
        break;
      case "wake":
        this.#power = { is: "booted", awake: true };
        break;
      case "reboot":
        this.#power = { is: "booting", since: at };
        this.#changed();
        await new Promise((resolve) => setTimeout(resolve, REBOOT_MS));
        this.#power = { is: "booted", awake: true };
        this.#generation++;
        break;
      default:
        break;
    }
    this.#changed();
  }

  async openUrl(url: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.#booted();
    this.record.opened.push(url);
    this.#draw();
  }

  async launchApp(app: string, signal: AbortSignal): Promise<LaunchedApp> {
    signal.throwIfAborted();
    this.#booted();
    if (app !== TEST_APP.id && app.toLowerCase() !== TEST_APP.name.toLowerCase()) throw new DriverError("bad-value", `The test device has no app ${JSON.stringify(app)}. Its apps are: ${TEST_APP.name} (${TEST_APP.id}).`);
    this.record.launched.push(TEST_APP.id);
    this.#draw();
    return TEST_APP;
  }

  async screenshot(): Promise<Uint8Array> {
    this.#booted();
    const content = this.#card();
    return rgbaPng(content.size.width, content.size.height, drawCard(content).rgba);
  }

  async tree(): Promise<readonly DeviceElement[]> {
    this.#booted();
    const size = this.#videoSize();
    return [
      {
        role: "window",
        identifier: "test-card",
        label: "Test device",
        value: null,
        frame: { x: 0, y: 0, width: size.width, height: size.height },
        enabled: true,
        focused: true,
        can: { tap: false, edit: false, scroll: false },
        children: [
          { role: "static text", identifier: "model", label: this.#target!.model, value: null, frame: { x: 0, y: Math.round(size.height / 8), width: size.width, height: 40 }, enabled: true, focused: false, can: null, children: [] },
          { role: "button", identifier: "card", label: "Card", value: null, frame: { x: Math.round(size.width / 4), y: Math.round(size.height / 2), width: Math.round(size.width / 2), height: 80 }, enabled: true, focused: false, can: { tap: true, edit: false, scroll: false }, children: [] },
        ],
      },
    ];
  }

  async elementAt(point: { readonly x: number; readonly y: number }): Promise<DeviceElement | null> {
    const inside = (element: DeviceElement): DeviceElement | null => {
      const { x, y, width, height } = element.frame;
      if (point.x < x || point.y < y || point.x >= x + width || point.y >= y + height) return null;
      for (const child of element.children) {
        const deeper = inside(child);
        if (deeper) return deeper;
      }
      return { ...element, children: [] };
    };
    for (const root of await this.tree()) {
      const found = inside(root);
      if (found) return found;
    }
    return null;
  }

  async readBack(): Promise<DeviceState> {
    const model = this.#model();
    const at = this.#clock.now();
    const geometry = this.#geometry();
    if (model.platform === "ios") return { platform: "ios", model: model.name, power: this.#power as Power<"ios">, geometry, settings: this.#iosSettings!, at };
    if (model.form === "foldable") throw new DriverError("unsupported", "The test device does not stand in for a foldable.");
    return { platform: "android", form: model.form, model: model.name, power: this.#power as Power<"android">, geometry, settings: this.#androidSettings!, at } as DeviceState;
  }
}
