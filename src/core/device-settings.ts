import {
  ANDROID_FONT_SCALES,
  IOS_CONTENT_SIZES,
  orientationWord,
  type AndroidFontScale,
  type Battery,
  type DeviceControl,
  type DeviceState,
  type IosContentSize,
  type IosStatusBar,
  type LatLon,
  type NetworkPreset,
  type Observed,
  type Orientation,
} from "./device.ts";

export const IOS_DEFAULT_CONTENT_SIZE: IosContentSize = "large";
export const ANDROID_DEFAULT_FONT_SCALE: AndroidFontScale = 1;
export const IOS_DEFAULT_APPEARANCE = "light" as const;

export const NOT_A_NETWORK_PRESET = "The network is none of bb-box's presets: ";

export function notANetworkPreset(reads: string): string {
  return `${NOT_A_NETWORK_PRESET}${reads}.`;
}

function networkWords(network: Observed<NetworkPreset>, outside: string): string | null {
  if (network.known) return `network ${network.value}${outside}`;
  if (!network.why.startsWith(NOT_A_NETWORK_PRESET)) return null;
  return `network none of the presets (${network.why.slice(NOT_A_NETWORK_PRESET.length).replace(/\.$/, "")})`;
}

export const QUARTER_TURNS_CLOCKWISE: readonly Orientation[] = ["upright", "turned-right", "upside-down", "turned-left"];

export function turnedFrom(from: Orientation, turn: "left" | "right"): Orientation {
  const at = QUARTER_TURNS_CLOCKWISE.indexOf(from);
  return QUARTER_TURNS_CLOCKWISE[(at + (turn === "right" ? 1 : 3)) % 4]!;
}

export function nextContentSize(current: IosContentSize, step: "larger" | "smaller" | "default"): IosContentSize {
  if (step === "default") return IOS_DEFAULT_CONTENT_SIZE;
  const at = IOS_CONTENT_SIZES.indexOf(current);
  return IOS_CONTENT_SIZES[Math.min(IOS_CONTENT_SIZES.length - 1, Math.max(0, at + (step === "larger" ? 1 : -1)))]!;
}

export function nextFontScale(current: AndroidFontScale, step: "larger" | "smaller" | "default"): AndroidFontScale {
  if (step === "default") return ANDROID_DEFAULT_FONT_SCALE;
  const at = ANDROID_FONT_SCALES.indexOf(current);
  return ANDROID_FONT_SCALES[Math.min(ANDROID_FONT_SCALES.length - 1, Math.max(0, at + (step === "larger" ? 1 : -1)))]!;
}

export const CONTROL_DEADLINES_MS = { control: 10_000, switch: 120_000, reboot: 120_000, install: 300_000 } as const;

export function controlDeadlineMs(control: DeviceControl, deadlines: { readonly [Kind in keyof typeof CONTROL_DEADLINES_MS]: number } = CONTROL_DEADLINES_MS): number {
  return control.action === "switch" ? deadlines.switch : control.action === "reboot" ? deadlines.reboot : control.action === "install" ? deadlines.install : deadlines.control;
}

export const CLEAN_STATUS_BAR_BATTERY: Battery = { level: 100, charging: false };
export const EMULATOR_OWN_LOCATION: LatLon = { latitude: 37.422, longitude: -122.0841 };
export const EMULATOR_OWN_BATTERY: Battery = { level: 100, charging: true };
export const SLOW_NETWORK = { kbitPerSecond: 473.6, delayMs: 100 } as const;
export const ANDROID_ID_FIRST_BOOT_WORDS = "about 25 s of it giving the device its own Android ID, as each device's first boot in a box does";

export function locationWords(to: LatLon): string {
  return `${to.latitude}, ${to.longitude}`;
}

export function batteryWords(battery: Battery): string {
  return `${battery.level}%${battery.charging ? ", charging" : ""}`;
}

function statusBarWords(bar: IosStatusBar): string {
  const parts = [bar.clean ? "clean" : "live"];
  if (bar.battery) parts.push(`battery shown at ${batteryWords(bar.battery)}`);
  return parts.join(", ");
}

export function deviceStateWords(state: DeviceState): string {
  const power = state.power;
  const parts: string[] = [];
  if (power.is === "booted") parts.push(power.awake ? "booted" : "booted, asleep");
  else if (power.is === "switching") parts.push(`switching to the ${power.to}, ${power.step}`);
  else if (power.is === "failed") parts.push(`failed: ${power.error.words}`);
  else parts.push(power.is);
  if (state.geometry) parts.push(orientationWord(state.geometry.physical), `${state.geometry.video.width}x${state.geometry.video.height}`);
  if (state.platform === "android" && state.form === "foldable" && state.posture.known) parts.push(state.posture.value.replace("-", " "));
  const settings = state.settings;
  const outside = (observed: { readonly known: true; readonly by: "bb-box" | "outside" }) => (observed.by === "outside" ? ", changed outside bb-box" : "");
  if (settings.appearance.known) parts.push(`${settings.appearance.value}${outside(settings.appearance)}`);
  if (state.platform === "ios") {
    if (state.settings.textSize.known) parts.push(`text size ${state.settings.textSize.value}${outside(state.settings.textSize)}`);
    const bar = state.settings.statusBar.set;
    if (bar) parts.push(`status bar ${statusBarWords(bar)}`);
    const location = state.settings.location.set;
    if (location) parts.push(`location ${locationWords(location)}`);
  } else {
    if (state.settings.fontScale.known) parts.push(`font scale ${state.settings.fontScale.value}${outside(state.settings.fontScale)}`);
    const network = networkWords(state.settings.network, state.settings.network.known ? outside(state.settings.network) : "");
    if (network) parts.push(network);
    if (state.settings.statusBar.set === "clean") parts.push("status bar clean");
    const battery = state.settings.battery;
    if (battery.known && (battery.value.level !== EMULATOR_OWN_BATTERY.level || battery.value.charging !== EMULATOR_OWN_BATTERY.charging)) parts.push(`battery ${batteryWords(battery.value)}${outside(battery)}`);
    const location = state.settings.location;
    if (location.known && location.value && (location.value.latitude !== EMULATOR_OWN_LOCATION.latitude || location.value.longitude !== EMULATOR_OWN_LOCATION.longitude))
      parts.push(`location ${locationWords(location.value)}${outside(location)}`);
  }
  return parts.join(", ");
}
