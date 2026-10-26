import { readFile, rename, writeFile } from "node:fs/promises";
import { ANDROID_DEFAULT_FONT_SCALE, CLEAN_STATUS_BAR_BATTERY, EMULATOR_OWN_BATTERY, EMULATOR_OWN_LOCATION, SLOW_NETWORK, nextFontScale } from "../core/device-settings.ts";
import {
  ANDROID_FONT_SCALES,
  type AndroidFontScale,
  type AndroidSettings,
  type Battery,
  type LatLon,
  type NetworkPreset,
  type Observed,
  type Override,
  type Posture,
  type TextSizeStep,
} from "../core/device.ts";
import { DriverError } from "./driver.ts";

type Appearance = "light" | "dark";

export const NETWORK_SETTLE_MS = 8_000;
export const BOOT_NETWORK_MS = 20_000;
export const WIFI_WRITTEN_MS = 30_000;
export const SETTING_SETTLE_MS = 3_000;
export const EMULATOR_WIFI = "AndroidWifi";
export const WIFI_STORE = "/data/misc/apexdata/com.android.wifi/WifiConfigStore.xml";
const POLL_MS = 100;

const DEMO = "am broadcast -a com.android.systemui.demo";
const SLOW_SHAPING = [
  `tc qdisc replace dev wlan0 root netem delay ${SLOW_NETWORK.delayMs}ms rate ${SLOW_NETWORK.kbitPerSecond * 1000}bit`,
  "ip link set ifb0 up",
  `tc qdisc replace dev ifb0 root netem rate ${SLOW_NETWORK.kbitPerSecond * 1000}bit`,
  "tc filter replace dev wlan0 ingress prio 100 protocol all u32 match u32 0 0 action mirred egress redirect dev ifb0",
].join("; ");
const NO_SHAPING = "tc filter del dev wlan0 ingress prio 100; tc qdisc del dev ifb0 root; ip link set ifb0 down; tc qdisc del dev wlan0 root";
const RADIOS_ON = "cmd connectivity airplane-mode disable; svc wifi enable; svc data enable";
const RADIOS_OFF = "cmd connectivity airplane-mode enable; svc wifi disable; svc data disable";
const READ_PARTS = [
  "cmd uimode night",
  "settings get system font_scale",
  "dumpsys power 2>/dev/null | grep -m1 mWakefulness=",
  "cmd connectivity airplane-mode",
  "settings get global wifi_on",
  "su 0 tc qdisc show dev wlan0",
  "cmd device_state print-state",
  "dumpsys connectivity | grep -E '^Active default network:|^  NetworkAgentInfo[{]'",
] as const;
const PART_MARK = "@@bb-box@@";

export function asRoot(script: string): string {
  return `su 0 sh -c '${script.replaceAll("'", "'\\''")}' 2>/dev/null`;
}

export function networkScript(preset: NetworkPreset): string {
  const shaping = asRoot(preset === "slow" ? `${NO_SHAPING}; ${SLOW_SHAPING}` : NO_SHAPING);
  return `${preset === "offline" ? RADIOS_OFF : RADIOS_ON}; ${shaping}; true`;
}

export function demoScript(battery: Battery): readonly string[] {
  return [
    "settings put global sysui_demo_allowed 1",
    `${DEMO} -e command enter`,
    `${DEMO} -e command clock -e hhmm 0941`,
    `${DEMO} -e command network -e wifi show -e level 4 -e fully true`,
    `${DEMO} -e command network -e mobile show -e datatype none -e level 4 -e fully true`,
    `${DEMO} -e command battery -e level ${battery.level} -e plugged ${battery.charging} -e powersave false`,
    `${DEMO} -e command notifications -e visible false`,
    `${DEMO} -e command status -e volume hide -e bluetooth hide -e location hide -e alarm hide -e sync hide -e tty hide -e eri hide -e mute hide -e speakerphone hide`,
  ];
}

export const DEMO_EXIT = `${DEMO} -e command exit`;

export const WIFI_NETWORKS = "cmd wifi list-networks 2>/dev/null; true";
export const ADD_EMULATOR_WIFI = `cmd wifi add-network ${EMULATOR_WIFI} open`;
export const WIFI_WRITTEN = asRoot(`grep -c ${EMULATOR_WIFI} ${WIFI_STORE}; true`);

export interface DefaultNetwork {
  readonly id: string | null;
  readonly validated: boolean;
}

export function parseDefaultNetwork(printed: string): DefaultNetwork {
  const id = /^Active default network: (\d+)/m.exec(printed)?.[1] ?? null;
  if (id === null) return { id, validated: false };
  const agent = printed.split("\n").find((line) => line.includes(`NetworkAgentInfo{network{${id}}`)) ?? "";
  const capabilities = /Capabilities: (\S+)/.exec(agent)?.[1]?.split("&") ?? [];
  return { id, validated: capabilities.includes("VALIDATED") };
}

function defaultNetworkWords(network: DefaultNetwork): string {
  if (network.id === null) return "no default network";
  return network.validated ? "a validated default network" : "a default network Android has not validated";
}

export interface DeviceReading {
  readonly appearance: Appearance | null;
  readonly fontScale: number | null;
  readonly awake: boolean | null;
  readonly network: NetworkPreset | null;
  readonly networkWords: string;
  readonly posture: Posture | null;
}

const POSTURE_STATES: Readonly<Record<string, Posture>> = { "0": "closed", "1": "half-open", "2": "open" };

export function readScript(): string {
  return READ_PARTS.map((part) => `${part} 2>/dev/null`).join(`; echo ${PART_MARK}; `);
}

export function parseReading(printed: string): DeviceReading {
  const parts = printed.split(PART_MARK).map((part) => part.trim());
  const [night = "", scale = "", power = "", airplane = "", wifi = "", shaping = "", fold = "", connectivity = ""] = parts;
  const nightMode = /Night mode:\s*(\w+)/.exec(night)?.[1];
  const appearance = nightMode === "yes" ? "dark" : nightMode === "no" ? "light" : null;
  const fontScale = scale === "null" || scale === "" ? 1 : Number.parseFloat(scale);
  const wakefulness = /mWakefulness=(\w+)/.exec(power)?.[1];
  const awake = wakefulness === undefined ? null : wakefulness === "Awake";
  const airplaneOn = airplane === "enabled" ? true : airplane === "disabled" ? false : null;
  const wifiOn = wifi === "1" ? true : wifi === "0" ? false : null;
  const shaped = /netem/.test(shaping);
  const reached = parseDefaultNetwork(connectivity);
  let network: NetworkPreset | null = null;
  if (airplaneOn === true && wifiOn === false && !reached.validated) network = "offline";
  else if (airplaneOn === false && wifiOn === true && reached.validated) network = shaped ? "slow" : "online";
  const networkWords = `airplane mode ${airplane || "unread"}, Wi-Fi ${wifiOn === null ? "unread" : wifiOn ? "on" : "off"}, ${shaped ? "slowed" : "not slowed"}, ${defaultNetworkWords(reached)}`;
  return { appearance, fontScale: Number.isFinite(fontScale) ? fontScale : null, awake, network, networkWords, posture: POSTURE_STATES[fold.split("\n")[0]!.trim()] ?? null };
}

export function fontScaleStep(read: number): AndroidFontScale | null {
  return ANDROID_FONT_SCALES.find((scale) => Math.abs(scale - read) < 0.001) ?? null;
}

export interface AndroidDeviceAccess {
  shell(command: string, signal: AbortSignal): Promise<string>;
  gps(signal: AbortSignal): Promise<LatLon>;
  setGps(to: LatLon, signal: AbortSignal): Promise<void>;
  battery(signal: AbortSignal): Promise<Battery>;
  setBattery(to: Battery, signal: AbortSignal): Promise<void>;
}

interface SetByBbBox {
  readonly appearance: Appearance;
  readonly fontScale: AndroidFontScale;
  readonly network: NetworkPreset;
  readonly location: LatLon | null;
  readonly battery: Battery | null;
}

interface ModelSettings {
  readonly statusBar: Override<"clean">;
  readonly setByBbBox: SetByBbBox;
}

const FRESH: ModelSettings = {
  statusBar: { set: null, at: null },
  setByBbBox: { appearance: "light", fontScale: ANDROID_DEFAULT_FONT_SCALE, network: "online", location: null, battery: null },
};

const NOT_READ = { known: false as const, why: "Not read from the device yet." };

function sameSpot(a: LatLon, b: LatLon): boolean {
  return Math.abs(a.latitude - b.latitude) < 1e-5 && Math.abs(a.longitude - b.longitude) < 1e-5;
}

function sameBattery(a: Battery, b: Battery): boolean {
  return a.level === b.level && a.charging === b.charging;
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });

export interface AndroidSettingsOptions {
  readonly device: AndroidDeviceAccess;
  readonly file: string;
  readonly log: (line: string) => void;
  readonly now: () => number;
  readonly settleMs?: { readonly setting: number; readonly network: number; readonly boot?: number; readonly wifiWritten?: number };
}

export class AndroidSettingsKeeper {
  readonly #options: AndroidSettingsOptions;
  #all: Record<string, ModelSettings> = {};
  #model: string | null = null;
  #loaded = false;
  #appearance: Observed<Appearance> = NOT_READ;
  #fontScale: Observed<AndroidFontScale> = NOT_READ;
  #location: Observed<LatLon | null> = NOT_READ;
  #battery: Observed<Battery> = NOT_READ;
  #network: Observed<NetworkPreset> = NOT_READ;
  #networkWords = "nothing";
  #posture: Observed<Posture> = NOT_READ;
  #awake: boolean | null = null;

  constructor(options: AndroidSettingsOptions) {
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

  #own(): ModelSettings {
    return (this.#model && this.#all[this.#model]) || FRESH;
  }

  async #change(change: Partial<ModelSettings>): Promise<void> {
    if (!this.#model) return;
    this.#all = { ...this.#all, [this.#model]: { ...this.#own(), ...change } };
    await this.#save().catch((error) => this.#options.log(`settings: could not keep what bb-box set: ${error instanceof Error ? error.message : String(error)}`));
  }

  async #setBy(change: Partial<SetByBbBox>): Promise<void> {
    await this.#change({ setByBbBox: { ...this.#own().setByBbBox, ...change } });
  }

  get awake(): boolean | null {
    return this.#awake;
  }

  posture(): Observed<Posture> {
    return this.#posture;
  }

  settings(): AndroidSettings {
    return { appearance: this.#appearance, fontScale: this.#fontScale, location: this.#location, battery: this.#battery, network: this.#network, statusBar: this.#own().statusBar };
  }

  async use(model: string, signal: AbortSignal): Promise<void> {
    await this.#load();
    if (this.#model !== model) {
      this.#appearance = this.#fontScale = this.#location = this.#battery = this.#network = this.#posture = NOT_READ;
      this.#awake = null;
    }
    this.#model = model;
    const own = this.#own();
    if (own.statusBar.set === "clean") {
      this.#options.log("settings: bb-box set a clean status bar on this device, so it sets it again, as a cold boot clears it");
      await this.#demo(own.setByBbBox.battery ?? CLEAN_STATUS_BAR_BATTERY, signal);
    }
  }

  async read(signal: AbortSignal): Promise<void> {
    const at = this.#options.now();
    const own = this.#own().setByBbBox;
    const [printed, gps, battery] = await Promise.all([
      this.#options.device.shell(readScript(), signal),
      this.#options.device.gps(signal).catch(() => null),
      this.#options.device.battery(signal).catch(() => null),
    ]);
    const read = parseReading(printed);
    this.#appearance = read.appearance
      ? { known: true, value: read.appearance, at, by: read.appearance === own.appearance ? "bb-box" : "outside" }
      : { known: false, why: "Android reads its night mode as neither yes nor no." };
    const scale = read.fontScale === null ? null : fontScaleStep(read.fontScale);
    this.#fontScale =
      scale !== null
        ? { known: true, value: scale, at, by: scale === own.fontScale ? "bb-box" : "outside" }
        : { known: false, why: `Android's font scale is ${read.fontScale ?? "unread"}, which is not one of bb-box's steps: ${ANDROID_FONT_SCALES.join(", ")}.` };
    this.#location = gps ? { known: true, value: gps, at, by: own.location && !sameSpot(own.location, gps) ? "outside" : "bb-box" } : { known: false, why: "The emulator did not say where it is." };
    this.#battery = battery ? { known: true, value: battery, at, by: own.battery && !sameBattery(own.battery, battery) ? "outside" : "bb-box" } : { known: false, why: "The emulator did not say how its battery is." };
    this.#networkWords = read.networkWords;
    this.#network = read.network
      ? { known: true, value: read.network, at, by: read.network === own.network ? "bb-box" : "outside" }
      : { known: false, why: `The network is none of bb-box's presets: ${read.networkWords}.` };
    this.#posture = read.posture ? { known: true, value: read.posture, at, by: "bb-box" } : { known: false, why: "Android did not say how the device is folded." };
    if (read.awake !== null) this.#awake = read.awake;
  }

  async #until(check: () => boolean, words: () => string, signal: AbortSignal, ms = this.#options.settleMs?.setting ?? SETTING_SETTLE_MS): Promise<void> {
    const until = performance.now() + ms;
    await this.read(signal);
    while (!check()) {
      if (performance.now() > until) throw new DriverError("failed", words());
      await wait(POLL_MS, signal);
      await this.read(signal);
    }
  }

  async setAppearance(to: Appearance, signal: AbortSignal): Promise<void> {
    await this.#setBy({ appearance: to });
    await this.#options.device.shell(`cmd uimode night ${to === "dark" ? "yes" : "no"}`, signal);
    await this.#until(
      () => this.#appearance.known && this.#appearance.value === to,
      () => `The appearance was set to ${to}, but the device reads ${this.#appearance.known ? this.#appearance.value : "nothing"}.`,
      signal,
    );
  }

  async setFontScale(to: TextSizeStep | AndroidFontScale, signal: AbortSignal): Promise<void> {
    let target: AndroidFontScale;
    if (typeof to === "number") target = to;
    else {
      if (to !== "default") await this.read(signal);
      target = nextFontScale(this.#fontScale.known ? this.#fontScale.value : ANDROID_DEFAULT_FONT_SCALE, to);
    }
    await this.#setBy({ fontScale: target });
    await this.#options.device.shell(`settings put system font_scale ${target}`, signal);
    await this.#until(
      () => this.#fontScale.known && this.#fontScale.value === target,
      () => `The font scale was set to ${target}, but the device reads ${this.#fontScale.known ? this.#fontScale.value : "nothing"}.`,
      signal,
    );
  }

  async setLocation(to: LatLon | null, signal: AbortSignal): Promise<void> {
    const spot = to ?? EMULATOR_OWN_LOCATION;
    await this.#setBy({ location: to });
    await this.#options.device.setGps(spot, signal);
    await this.#until(
      () => this.#location.known && this.#location.value !== null && sameSpot(this.#location.value, spot),
      () => `The location was set to ${spot.latitude}, ${spot.longitude}, but the emulator reads ${this.#location.known && this.#location.value ? `${this.#location.value.latitude}, ${this.#location.value.longitude}` : "nothing"}.`,
      signal,
    );
  }

  async setBattery(to: Battery | null, signal: AbortSignal): Promise<void> {
    const battery = to ?? EMULATOR_OWN_BATTERY;
    await this.#setBy({ battery: to });
    await this.#options.device.setBattery(battery, signal);
    if (this.#own().statusBar.set === "clean") await this.#demo(battery, signal);
    await this.#until(
      () => this.#battery.known && sameBattery(this.#battery.value, battery),
      () => `The battery was set to ${battery.level}%, but the emulator reads ${this.#battery.known ? `${this.#battery.value.level}%` : "nothing"}.`,
      signal,
    );
  }

  async #demo(battery: Battery, signal: AbortSignal): Promise<void> {
    await this.#options.device.shell(`${demoScript(battery).map((line) => `${line} >/dev/null`).join("; ")}; true`, signal);
  }

  async setStatusBar(to: "clean" | "live", signal: AbortSignal): Promise<void> {
    if (to === "clean") await this.#demo(this.#own().setByBbBox.battery ?? CLEAN_STATUS_BAR_BATTERY, signal);
    else await this.#options.device.shell(`${DEMO_EXIT} >/dev/null; settings put global sysui_demo_allowed 0`, signal);
    await this.#change({ statusBar: to === "clean" ? { set: "clean", at: this.#options.now() } : { set: null, at: this.#options.now() } });
  }

  async setNetwork(to: NetworkPreset, signal: AbortSignal): Promise<void> {
    await this.#setBy({ network: to });
    await this.#options.device.shell(networkScript(to), signal);
    await this.#until(
      () => this.#network.known && this.#network.value === to,
      () => `The network was set to ${to}, but ${(this.#options.settleMs?.network ?? NETWORK_SETTLE_MS) / 1000} s later the device reads ${this.#network.known ? this.#network.value : this.#networkWords}.`,
      signal,
      this.#options.settleMs?.network ?? NETWORK_SETTLE_MS,
    );
  }

  async waitNetworkAfterBoot(signal: AbortSignal): Promise<void> {
    const wanted = this.#own().setByBbBox.network;
    const ms = this.#options.settleMs?.boot ?? BOOT_NETWORK_MS;
    await this.#until(
      () => this.#network.known && this.#network.value === wanted,
      () => `bb-box set the network ${wanted}, but ${ms / 1000} s after the boot the device reads ${this.#network.known ? this.#network.value : this.#networkWords}.`,
      signal,
      ms,
    );
  }

  async keepEmulatorWifi(signal: AbortSignal): Promise<void> {
    if ((await this.#options.device.shell(WIFI_NETWORKS, signal)).includes(EMULATOR_WIFI)) return;
    this.#options.log(`network: the device has no saved ${EMULATOR_WIFI}, the emulator's Wi-Fi, so it has no network; saving it again`);
    await this.#options.device.shell(ADD_EMULATOR_WIFI, signal);
  }

  async waitEmulatorWifiWritten(signal: AbortSignal): Promise<void> {
    const ms = this.#options.settleMs?.wifiWritten ?? WIFI_WRITTEN_MS;
    const began = performance.now();
    let checks = 0;
    while (!(Number.parseInt(await this.#options.device.shell(WIFI_WRITTEN, signal), 10) > 0)) {
      if (performance.now() - began > ms) throw new DriverError("failed", `Android had not written ${EMULATOR_WIFI} to its Wi-Fi store ${ms / 1000} s later, so a restart would lose the device's network.`);
      checks++;
      await wait(POLL_MS * 5, signal);
    }
    if (checks > 0) this.#options.log(`network: Android wrote ${EMULATOR_WIFI} to its Wi-Fi store on disk ${((performance.now() - began) / 1000).toFixed(1)} s after bb-box first looked`);
  }

  async waitPosture(to: Posture, signal: AbortSignal): Promise<void> {
    await this.#until(
      () => this.#posture.known && this.#posture.value === to,
      () => `The emulator was asked to be ${to.replace("-", " ")}, but Android reads ${this.#posture.known ? this.#posture.value.replace("-", " ") : "nothing"}.`,
      signal,
    );
  }

  async waitAwake(awake: boolean, signal: AbortSignal): Promise<void> {
    await this.#until(
      () => this.#awake === awake,
      () => `The device was ${awake ? "woken" : "locked"}, but it still reads ${awake ? "asleep" : "awake"}.`,
      signal,
    );
  }
}
