import { ANDROID_DEFAULT_FONT_SCALE, IOS_DEFAULT_APPEARANCE, IOS_DEFAULT_CONTENT_SIZE } from "./device-settings.ts";
import {
  ANDROID_FONT_SCALES,
  IOS_CONTENT_SIZES,
  actionSupport,
  orientationWord,
  type AndroidFontScale,
  type DeviceAction,
  type DeviceModel,
  type DeviceState,
  type IosContentSize,
  type LatLon,
  type Posture,
} from "./device.ts";

export const BAR_CONTROLS = ["home", "back", "recents", "rotate-left", "rotate-right", "fold", "appearance", "text-size", "screenshot"] as const;
export type BarControl = (typeof BAR_CONTROLS)[number];

const BAR_GROUPS: readonly (readonly BarControl[])[] = [["home", "back", "recents"], ["rotate-left", "rotate-right", "fold"], ["appearance", "text-size"], ["screenshot"]];
const ROW_CONTROLS: readonly BarControl[] = ["home", "back", "recents", "rotate-left", "fold"];

const BAR_ACTION: Readonly<Record<BarControl, DeviceAction | null>> = {
  home: "home",
  back: "back",
  recents: "recents",
  "rotate-left": "rotate",
  "rotate-right": "rotate",
  fold: "posture",
  appearance: "appearance",
  "text-size": "text_size",
  screenshot: null,
};

export const BAR_WORDS: Readonly<Record<BarControl, string>> = {
  home: "Home",
  back: "Back",
  recents: "Recent apps",
  "rotate-left": "Rotate left",
  "rotate-right": "Rotate right",
  fold: "Fold",
  appearance: "Dark appearance",
  "text-size": "Text size",
  screenshot: "Copy screenshot",
};

function onModel(model: DeviceModel, control: BarControl): boolean {
  const action = BAR_ACTION[control];
  return action === null || actionSupport(model, action).supported;
}

export function barGroups(model: DeviceModel): readonly (readonly BarControl[])[] {
  return BAR_GROUPS.map((group) => group.filter((control) => onModel(model, control))).filter((group) => group.length > 0);
}

export function rowControls(model: DeviceModel): readonly BarControl[] {
  return ROW_CONTROLS.filter((control) => onModel(model, control));
}

export function overflowControls(model: DeviceModel): readonly BarControl[] {
  const row = rowControls(model);
  return barGroups(model)
    .flat()
    .filter((control) => !row.includes(control));
}

export const MORE_ITEMS = ["lock", "open-link", "location", "status-bar", "battery", "network", "reboot"] as const;
export type MoreItem = (typeof MORE_ITEMS)[number];

const MORE_ACTION: Readonly<Record<MoreItem, DeviceAction | null>> = {
  lock: "lock",
  "open-link": null,
  location: "location",
  "status-bar": "status_bar",
  battery: "battery",
  network: "network",
  reboot: "reboot",
};

export function moreItems(model: DeviceModel): readonly MoreItem[] {
  return MORE_ITEMS.filter((item) => {
    const action = MORE_ACTION[item];
    return action === null || actionSupport(model, action).supported;
  });
}

export const LAYOUT = {
  narrowPanel: 480,
  narrowScreen: 280,
  gap: 16,
  barPadding: 4,
  fineTarget: 36,
  coarseTarget: 44,
  rowTarget: 44,
  separator: 9,
} as const;

export function barWidth(coarse: boolean): number {
  return (coarse ? LAYOUT.coarseTarget : LAYOUT.fineTarget) + LAYOUT.barPadding * 2;
}

export function barHeight(model: DeviceModel, coarse: boolean): number {
  const groups = barGroups(model);
  const buttons = groups.flat().length + 1;
  return buttons * (coarse ? LAYOUT.coarseTarget : LAYOUT.fineTarget) + groups.length * LAYOUT.separator + LAYOUT.barPadding * 2;
}

export function rowHeight(): number {
  return LAYOUT.rowTarget + LAYOUT.barPadding * 2;
}

export type Arrangement = "beside" | "below";

export function arrangementFor(panelWidth: number, screenWidthBeside: number, screenWidthBelow: number): Arrangement {
  if (panelWidth < LAYOUT.narrowPanel) return "below";
  return screenWidthBeside < LAYOUT.narrowScreen && screenWidthBelow > screenWidthBeside ? "below" : "beside";
}

export function appearanceOf(state: DeviceState | null): "light" | "dark" {
  const appearance = state?.settings.appearance;
  return appearance?.known ? appearance.value : IOS_DEFAULT_APPEARANCE;
}

export interface TextSizeSteps {
  readonly steps: readonly (IosContentSize | AndroidFontScale)[];
  readonly at: number | null;
  readonly fallback: number;
  readonly words: string;
}

export function contentSizeWords(size: IosContentSize): string {
  const words = size.replace(/-/g, " ");
  return `${words[0]!.toUpperCase()}${words.slice(1)}`;
}

export function fontScaleWords(scale: AndroidFontScale): string {
  return `${Math.round(scale * 100)}%`;
}

export function stepWords(step: IosContentSize | AndroidFontScale): string {
  return typeof step === "number" ? fontScaleWords(step) : contentSizeWords(step);
}

export function textSizeSteps(model: DeviceModel, state: DeviceState | null): TextSizeSteps {
  if (model.platform === "ios") {
    const read = state?.platform === "ios" && state.settings.textSize.known ? state.settings.textSize.value : null;
    const at = read === null ? null : IOS_CONTENT_SIZES.indexOf(read);
    const fallback = IOS_CONTENT_SIZES.indexOf(IOS_DEFAULT_CONTENT_SIZE);
    return { steps: IOS_CONTENT_SIZES, at, fallback, words: read === null ? "Not read yet" : textSizeNowWords(read, read === IOS_DEFAULT_CONTENT_SIZE) };
  }
  const read = state?.platform === "android" && state.settings.fontScale.known ? state.settings.fontScale.value : null;
  const at = read === null ? null : ANDROID_FONT_SCALES.indexOf(read);
  const fallback = ANDROID_FONT_SCALES.indexOf(ANDROID_DEFAULT_FONT_SCALE);
  return { steps: ANDROID_FONT_SCALES, at, fallback, words: read === null ? "Not read yet" : textSizeNowWords(read, read === ANDROID_DEFAULT_FONT_SCALE) };
}

function textSizeNowWords(step: IosContentSize | AndroidFontScale, isDefault: boolean): string {
  return `${stepWords(step)}${isDefault ? ", the default" : ""}`;
}

export function postureOf(state: DeviceState | null): Posture | null {
  return state?.platform === "android" && state.form === "foldable" && state.posture.known ? state.posture.value : null;
}

export const POSTURE_WORDS: Readonly<Record<Posture, string>> = { closed: "Closed", "half-open": "Half open", open: "Open" };

export interface Place extends LatLon {
  readonly name: string;
}

export const PLACES: readonly Place[] = [
  { name: "San Francisco", latitude: 37.7749, longitude: -122.4194 },
  { name: "New York", latitude: 40.7128, longitude: -74.006 },
  { name: "London", latitude: 51.5072, longitude: -0.1276 },
  { name: "Nairobi", latitude: -1.2921, longitude: 36.8219 },
  { name: "Tokyo", latitude: 35.6762, longitude: 139.6503 },
  { name: "Sydney", latitude: -33.8688, longitude: 151.2093 },
];

export function locationOf(state: DeviceState | null): LatLon | null {
  if (!state) return null;
  if (state.platform === "ios") return state.settings.location.set;
  return state.settings.location.known ? state.settings.location.value : null;
}

export function placeAt(location: LatLon | null): Place | null {
  return location ? (PLACES.find((place) => place.latitude === location.latitude && place.longitude === location.longitude) ?? null) : null;
}

export function cleanStatusBar(state: DeviceState | null): boolean {
  if (state?.platform === "ios") return state.settings.statusBar.set?.clean === true;
  return state?.platform === "android" && state.settings.statusBar.set === "clean";
}

export function batteryOf(state: DeviceState | null): { readonly level: number; readonly charging: boolean } | null {
  if (state?.platform === "ios") return state.settings.statusBar.set?.battery ?? null;
  return state?.platform === "android" && state.settings.battery.known ? state.settings.battery.value : null;
}

export const REBOOT_WORDS: Readonly<Record<DeviceModel["platform"], string>> = {
  ios: "Takes about 9 s. Keeps apps and data.",
  android: "Takes about 18 s. Keeps apps and data.",
};

export function asleep(state: DeviceState | null): boolean {
  return state?.power.is === "booted" && !state.power.awake;
}

export function controllable(state: DeviceState | null): boolean {
  return state?.power.is === "booted";
}

export function waitWords(state: DeviceState | null, connected: boolean): string | null {
  if (!connected) return "The controls wait for the connection to the device.";
  const power = state?.power;
  if (!power) return "The controls wait for the device.";
  if (power.is === "booting") return "The controls wait for the device to boot.";
  if (power.is === "switching") return `The controls wait for the ${power.to} to start.`;
  if (power.is === "stopped") return "The device is stopped.";
  if (power.is === "failed") return "The device failed. Reboot it from More.";
  return null;
}

export function changeWords(before: DeviceState | null, after: DeviceState): string | null {
  if (!before) return null;
  const said: string[] = [];
  if (before.model !== after.model) said.push(`Now the ${after.model}`);
  const was = before.power;
  const now = after.power;
  if (was.is !== now.is || (was.is === "booted" && now.is === "booted" && was.awake !== now.awake)) {
    if (now.is === "booted") said.push(was.is === "booted" ? (now.awake ? "Awake" : "Asleep") : now.awake ? "Ready" : "Asleep");
    else if (now.is === "booting") said.push("Booting");
    else if (now.is === "switching") said.push(`Switching to the ${now.to}`);
    else if (now.is === "stopped") said.push("Stopped");
    else said.push(`Failed: ${now.error.words}`);
  }
  if (before.geometry && after.geometry && before.geometry.physical !== after.geometry.physical) {
    const turned = orientationWord(after.geometry.physical);
    said.push(`${turned[0]!.toUpperCase()}${turned.slice(1)}`);
  }
  const posture = postureOf(after);
  if (posture && posture !== postureOf(before)) said.push(POSTURE_WORDS[posture]);
  if (after.settings.appearance.known && appearanceOf(before) !== after.settings.appearance.value && before.settings.appearance.known)
    said.push(after.settings.appearance.value === "dark" ? "Dark appearance" : "Light appearance");
  if (after.platform === "ios" && before.platform === "ios" && after.settings.textSize.known && before.settings.textSize.known && after.settings.textSize.value !== before.settings.textSize.value)
    said.push(`Text size ${contentSizeWords(after.settings.textSize.value).toLowerCase()}`);
  if (after.platform === "android" && before.platform === "android" && after.settings.fontScale.known && before.settings.fontScale.known && after.settings.fontScale.value !== before.settings.fontScale.value)
    said.push(`Text size ${fontScaleWords(after.settings.fontScale.value)}`);
  return said.length ? `${said.join(". ")}.` : null;
}
