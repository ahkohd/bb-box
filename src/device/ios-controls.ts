import { readFile, rename, writeFile } from "node:fs/promises";
import { CLEAN_STATUS_BAR_BATTERY, IOS_DEFAULT_APPEARANCE, IOS_DEFAULT_CONTENT_SIZE, nextContentSize } from "../core/device-settings.ts";
import { IOS_CONTENT_SIZES, type Battery, type IosContentSize, type IosSettings, type IosStatusBar, type LatLon, type Observed, type Override, type TextSizeStep } from "../core/device.ts";
import { DriverError } from "./driver.ts";
import type { Simctl } from "./simctl.ts";

export const CLEAN_STATUS_BAR = ["--time", "9:41", "--dataNetwork", "wifi", "--wifiMode", "active", "--wifiBars", "3", "--cellularMode", "active", "--cellularBars", "4", "--operatorName", ""] as const;

type Appearance = "light" | "dark";

interface ModelSettings {
  readonly location: Override<LatLon>;
  readonly statusBar: Override<IosStatusBar>;
  readonly setByBbBox: { readonly appearance: Appearance; readonly textSize: IosContentSize };
}

const FRESH: ModelSettings = {
  location: { set: null, at: null },
  statusBar: { set: null, at: null },
  setByBbBox: { appearance: IOS_DEFAULT_APPEARANCE, textSize: IOS_DEFAULT_CONTENT_SIZE },
};

export function batteryOverride(battery: Battery): readonly string[] {
  return ["--batteryState", battery.charging ? "charging" : "discharging", "--batteryLevel", String(battery.level)];
}

export function statusBarOverride(bar: IosStatusBar): readonly string[] {
  return [...(bar.clean ? CLEAN_STATUS_BAR : []), ...(bar.battery ? batteryOverride(bar.battery) : [])];
}

export function overridesListed(printed: string): boolean {
  return printed
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line && !/^Current Status Bar Overrides:$/i.test(line) && !/^=+$/.test(line));
}

function isAppearance(value: string): value is Appearance {
  return value === "light" || value === "dark";
}

function isContentSize(value: string): value is IosContentSize {
  return (IOS_CONTENT_SIZES as readonly string[]).includes(value);
}

export interface IosSettingsOptions {
  readonly simctl: Simctl;
  readonly file: string;
  readonly log: (line: string) => void;
  readonly now: () => number;
  readonly changesShowAtStart?: boolean;
}

export class IosSettingsKeeper {
  readonly #options: IosSettingsOptions;
  #all: Record<string, ModelSettings> = {};
  #model: string | null = null;
  #udid: string | null = null;
  #appearance: Observed<Appearance> = { known: false, why: "Not read from the device yet." };
  #textSize: Observed<IosContentSize> = { known: false, why: "Not read from the device yet." };
  #loaded = false;

  constructor(options: IosSettingsOptions) {
    this.#options = options;
  }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.#options.file, "utf8")) as Record<string, ModelSettings>;
      if (parsed && typeof parsed === "object") this.#all = parsed;
    } catch {
      this.#all = {};
    }
  }

  async #save(): Promise<void> {
    const fresh = `${this.#options.file}.new`;
    await writeFile(fresh, `${JSON.stringify(this.#all)}\n`, { mode: 0o600 });
    await rename(fresh, this.#options.file);
  }

  async use(model: string, udid: string, signal: AbortSignal): Promise<void> {
    await this.#load();
    if (this.#model !== model) {
      this.#appearance = { known: false, why: "Not read from the device yet." };
      this.#textSize = { known: false, why: "Not read from the device yet." };
    }
    this.#model = model;
    this.#udid = udid;
    await this.checkStatusBar(signal);
    const location = this.#own().location.set;
    if (location) await this.#options.simctl.location(udid, location, signal);
  }

  #own(): ModelSettings {
    return (this.#model && this.#all[this.#model]) || FRESH;
  }

  async #change(change: Partial<ModelSettings>): Promise<void> {
    if (!this.#model) return;
    this.#all = { ...this.#all, [this.#model]: { ...this.#own(), ...change } };
    await this.#save().catch((error) => this.#options.log(`settings: could not keep what bb-box set: ${error instanceof Error ? error.message : String(error)}`));
  }

  #device(): string {
    if (!this.#udid) throw new DriverError("not-booted", "No iOS device has started in this box yet.");
    return this.#udid;
  }

  settings(): IosSettings {
    const own = this.#own();
    const atStart = this.#options.changesShowAtStart ? { changesShowAtStart: true } : {};
    return { appearance: this.#appearance, textSize: this.#textSize, location: own.location, statusBar: own.statusBar, ...atStart };
  }

  async read(signal: AbortSignal): Promise<void> {
    const udid = this.#device();
    const own = this.#own();
    const at = this.#options.now();
    const [appearance, textSize] = (await Promise.all([this.#options.simctl.ui(udid, "appearance", undefined, signal), this.#options.simctl.ui(udid, "content_size", undefined, signal)])).map((read) => read.toLowerCase());
    this.#appearance = isAppearance(appearance)
      ? { known: true, value: appearance, at, by: appearance === own.setByBbBox.appearance ? "bb-box" : "outside" }
      : { known: false, why: `simctl reads the appearance as ${appearance || "nothing"}.` };
    this.#textSize = isContentSize(textSize)
      ? { known: true, value: textSize, at, by: textSize === own.setByBbBox.textSize ? "bb-box" : "outside" }
      : { known: false, why: `simctl reads the text size as ${textSize || "nothing"}.` };
  }

  async setAppearance(to: Appearance, signal: AbortSignal): Promise<void> {
    await this.#change({ setByBbBox: { ...this.#own().setByBbBox, appearance: to } });
    await this.#options.simctl.ui(this.#device(), "appearance", to, signal);
    await this.read(signal);
    if (!this.#appearance.known || this.#appearance.value !== to) throw new DriverError("failed", `The appearance was set to ${to}, but the device reads ${this.#appearance.known ? this.#appearance.value : "nothing"}.`);
  }

  async setTextSize(to: TextSizeStep | IosContentSize, signal: AbortSignal): Promise<void> {
    let target: IosContentSize;
    if (to === "larger" || to === "smaller" || to === "default") {
      await this.read(signal);
      target = nextContentSize(this.#textSize.known ? this.#textSize.value : IOS_DEFAULT_CONTENT_SIZE, to);
    } else target = to;
    await this.#change({ setByBbBox: { ...this.#own().setByBbBox, textSize: target } });
    await this.#options.simctl.ui(this.#device(), "content_size", target, signal);
    await this.read(signal);
    if (!this.#textSize.known || this.#textSize.value !== target) throw new DriverError("failed", `The text size was set to ${target}, but the device reads ${this.#textSize.known ? this.#textSize.value : "nothing"}.`);
  }

  async setLocation(to: LatLon | null, signal: AbortSignal): Promise<void> {
    await this.#options.simctl.location(this.#device(), to, signal);
    await this.#change({ location: to ? { set: to, at: this.#options.now() } : { set: null, at: this.#options.now() } });
  }

  async #applyStatusBar(bar: IosStatusBar | null, signal: AbortSignal): Promise<void> {
    const udid = this.#device();
    await this.#options.simctl.statusBar(udid, ["clear"], signal);
    const override = bar ? statusBarOverride(bar) : [];
    if (override.length) await this.#options.simctl.statusBar(udid, ["override", ...override], signal);
    const listed = overridesListed(await this.#options.simctl.statusBar(udid, ["list"], signal));
    if (listed !== override.length > 0) throw new DriverError("failed", override.length ? "simctl took the status bar's overrides, but lists none." : "simctl cleared the status bar's overrides, but still lists some.");
    const kept = bar && override.length ? bar : null;
    await this.#change({ statusBar: kept ? { set: kept, at: this.#options.now() } : { set: null, at: this.#options.now() } });
  }

  async setStatusBar(to: "clean" | "live", signal: AbortSignal): Promise<void> {
    const now = this.#own().statusBar.set;
    await this.#applyStatusBar(to === "clean" ? { clean: true, battery: now?.battery ?? CLEAN_STATUS_BAR_BATTERY } : null, signal);
  }

  async setBattery(to: Battery | null, signal: AbortSignal): Promise<void> {
    const clean = this.#own().statusBar.set?.clean ?? false;
    await this.#applyStatusBar({ clean, battery: to }, signal);
  }

  async checkStatusBar(signal: AbortSignal): Promise<void> {
    const own = this.#own();
    if (!this.#udid || !own.statusBar.set) return;
    const listed = overridesListed(await this.#options.simctl.statusBar(this.#udid, ["list"], signal).catch(() => "unread"));
    if (listed) return;
    this.#options.log("settings: the device lists no status bar overrides, as after its reboot, so bb-box sets them again");
    await this.#applyStatusBar(own.statusBar.set, signal);
  }
}
