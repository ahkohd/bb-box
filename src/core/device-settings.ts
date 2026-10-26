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
  type Orientation,
} from "./device.ts";

export const IOS_DEFAULT_CONTENT_SIZE: IosContentSize = "large";
export const ANDROID_DEFAULT_FONT_SCALE: AndroidFontScale = 1;
export const IOS_DEFAULT_APPEARANCE = "light" as const;

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
    if (state.settings.network.known) parts.push(`network ${state.settings.network.value}`);
  }
  return parts.join(", ");
}
