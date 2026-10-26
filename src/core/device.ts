import { DEVICE_MODELS, type AndroidModelName, type AndroidModelNameOfForm, type FoldableModelName, type IosModelName, type ModelName, type TableModel } from "./device-models.ts";

export type { AndroidModelName, FoldableModelName, IosModelName, ModelName, TableModel } from "./device-models.ts";

export const DEVICE_PLATFORMS = ["ios", "android"] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export const ORIENTATIONS = ["upright", "turned-left", "upside-down", "turned-right"] as const;
export type Orientation = (typeof ORIENTATIONS)[number];

export const POSTURES = ["closed", "half-open", "open"] as const;
export type Posture = (typeof POSTURES)[number];

export interface Screen {
  readonly pixels: { readonly width: number; readonly height: number };
  readonly scale: number;
  readonly cornerRadius: number;
  readonly cutout: Cutout | null;
}

export interface Cutout {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly shape: "pill" | "circle";
}

export interface BodyButton {
  readonly edge: "left" | "right" | "top";
  readonly from: number;
  readonly to: number;
}

export interface Body {
  readonly bezel: number;
  readonly radius: number;
  readonly buttons: readonly BodyButton[];
}

export interface FlatModel {
  readonly name: string;
  readonly form: "phone" | "tablet";
  readonly screen: Screen;
  readonly outer?: never;
  readonly inner?: never;
  readonly body: Body;
}

export interface FoldableModel {
  readonly name: string;
  readonly form: "foldable";
  readonly screen?: never;
  readonly outer: Screen;
  readonly inner: Screen;
  readonly hinge: "vertical" | "horizontal";
  readonly postures: readonly [Posture, ...Posture[]];
  readonly body: Body;
}

export type IosModel = FlatModel & { readonly platform: "ios" };
export type AndroidModel = (FlatModel | FoldableModel) & { readonly platform: "android" };
export type DeviceModel = IosModel | AndroidModel;

export interface IosRuntime {
  readonly platform: "ios";
  readonly os: string;
  readonly build: string;
  readonly xcode: string;
  readonly companion: string;
}

export interface SnapshotOrigin {
  readonly emulator: string;
  readonly cpu: string;
  readonly made: string;
}

export interface AndroidRuntime {
  readonly platform: "android";
  readonly api: number;
  readonly image: "google_apis";
  readonly revision: number;
  readonly abi: "x86_64";
  readonly emulator: string;
  readonly snapshot: SnapshotOrigin | null;
}

export type Runtime = IosRuntime | AndroidRuntime;

export type NonEmpty<T> = readonly [T, ...T[]];

interface PlatformParts {
  readonly ios: { readonly model: IosModelName; readonly runtime: IosRuntime; readonly failure: IosFailureCode };
  readonly android: { readonly model: AndroidModelName; readonly runtime: AndroidRuntime; readonly failure: AndroidFailureCode };
}

export type ModelNameOf<P extends DevicePlatform> = PlatformParts[P]["model"];

export interface OfferedDeviceOf<P extends DevicePlatform> {
  readonly model: ModelNameOf<P>;
  readonly native: string;
  readonly runtime: PlatformParts[P]["runtime"];
}

export type OfferedDevice = { readonly [P in DevicePlatform]: OfferedDeviceOf<P> }[DevicePlatform];

export type OfferedDevices = { readonly [P in DevicePlatform]: NonEmpty<OfferedDeviceOf<P>> }[DevicePlatform];

export type DeviceOffer = { readonly [P in DevicePlatform]: { readonly platform: P; readonly devices: NonEmpty<OfferedDeviceOf<P>> } }[DevicePlatform];

export type BoxDevice = { readonly [P in DevicePlatform]: { readonly platform: P; readonly model: ModelNameOf<P>; readonly runtime: PlatformParts[P]["runtime"] } }[DevicePlatform];

export interface VideoSize {
  readonly width: number;
  readonly height: number;
}

export interface Geometry {
  readonly generation: number;
  readonly physical: Orientation;
  readonly content: Orientation;
  readonly video: VideoSize;
}

export type FoldScreen = "outer" | "inner";

export type FoldGeometry = Geometry & { readonly screen: FoldScreen };

export const IOS_FAILURE_CODES = ["boot-failed", "device-exited", "companion-failed", "incompatible"] as const;
export const ANDROID_FAILURE_CODES = ["boot-failed", "device-exited", "emulator-failed", "firewall-missing", "incompatible"] as const;
export type IosFailureCode = (typeof IOS_FAILURE_CODES)[number];
export type AndroidFailureCode = (typeof ANDROID_FAILURE_CODES)[number];
export type FailureCode = IosFailureCode | AndroidFailureCode;

export const SWITCH_STEPS = ["stopping", "booting", "waiting", "streaming"] as const;
export type SwitchStep = (typeof SWITCH_STEPS)[number];

export type Power<P extends DevicePlatform = DevicePlatform> =
  | { readonly is: "booting"; readonly since: number }
  | { readonly is: "booted"; readonly awake: boolean }
  | { readonly is: "switching"; readonly to: ModelNameOf<P>; readonly step: SwitchStep; readonly since: number }
  | { readonly is: "stopped" }
  | { readonly is: "failed"; readonly error: { readonly code: PlatformParts[P]["failure"]; readonly words: string }; readonly since: number };

export type Observed<T> =
  | { readonly known: true; readonly value: T; readonly at: number; readonly by: "bb-box" | "outside" }
  | { readonly known: false; readonly why: string };

export type Override<T> = { readonly set: T; readonly at: number } | { readonly set: null; readonly at: number | null };

export const NETWORK_PRESETS = ["online", "offline", "slow"] as const;
export type NetworkPreset = (typeof NETWORK_PRESETS)[number];

export interface LatLon {
  readonly latitude: number;
  readonly longitude: number;
}

export const IOS_CONTENT_SIZES = [
  "extra-small",
  "small",
  "medium",
  "large",
  "extra-large",
  "extra-extra-large",
  "extra-extra-extra-large",
  "accessibility-medium",
  "accessibility-large",
  "accessibility-extra-large",
  "accessibility-extra-extra-large",
  "accessibility-extra-extra-extra-large",
] as const;
export type IosContentSize = (typeof IOS_CONTENT_SIZES)[number];

export const ANDROID_FONT_SCALES = [0.85, 1, 1.15, 1.3, 1.5, 1.8, 2] as const;
export type AndroidFontScale = (typeof ANDROID_FONT_SCALES)[number];

export interface Battery {
  readonly level: number;
  readonly charging: boolean;
}

export interface IosStatusBar {
  readonly clean: boolean;
  readonly battery: Battery | null;
}

export interface IosSettings {
  readonly appearance: Observed<"light" | "dark">;
  readonly textSize: Observed<IosContentSize>;
  readonly location: Override<LatLon>;
  readonly statusBar: Override<IosStatusBar>;
}

export interface AndroidSettings {
  readonly appearance: Observed<"light" | "dark">;
  readonly fontScale: Observed<AndroidFontScale>;
  readonly location: Observed<LatLon | null>;
  readonly battery: Observed<Battery>;
  readonly network: Observed<NetworkPreset>;
  readonly statusBar: Override<"clean">;
}

export interface IosDeviceState {
  readonly platform: "ios";
  readonly model: IosModelName;
  readonly power: Power<"ios">;
  readonly geometry: Geometry | null;
  readonly settings: IosSettings;
  readonly at: number;
}

type AndroidFlatStateOfForm<Form extends "phone" | "tablet"> = {
  readonly platform: "android";
  readonly form: Form;
  readonly model: AndroidModelNameOfForm<Form>;
  readonly power: Power<"android">;
  readonly geometry: Geometry | null;
  readonly posture?: never;
  readonly settings: AndroidSettings;
  readonly at: number;
};

export type AndroidFlatDeviceState = AndroidFlatStateOfForm<"phone"> | AndroidFlatStateOfForm<"tablet">;

export interface AndroidFoldableDeviceState {
  readonly platform: "android";
  readonly form: "foldable";
  readonly model: FoldableModelName;
  readonly power: Power<"android">;
  readonly geometry: FoldGeometry | null;
  readonly posture: Observed<Posture>;
  readonly settings: AndroidSettings;
  readonly at: number;
}

export type AndroidDeviceState = AndroidFlatDeviceState | AndroidFoldableDeviceState;
export type DeviceState = IosDeviceState | AndroidDeviceState;
export type DeviceStateOf<P extends DevicePlatform> = Extract<DeviceState, { readonly platform: P }>;

export interface IntentOf<P extends DevicePlatform> {
  readonly target: ModelNameOf<P>;
  readonly switching: { readonly id: string; readonly from: ModelNameOf<P>; readonly step: SwitchStep; readonly since: number } | null;
}

export type Intent = { readonly [P in DevicePlatform]: IntentOf<P> }[DevicePlatform];

export const TEXT_SIZE_STEPS = ["larger", "smaller", "default"] as const;
export type TextSizeStep = (typeof TEXT_SIZE_STEPS)[number];

export type DeviceControl =
  | { readonly action: "home" }
  | { readonly action: "back" }
  | { readonly action: "recents" }
  | { readonly action: "lock" }
  | { readonly action: "wake" }
  | { readonly action: "rotate"; readonly turn: "left" | "right"; readonly to?: never }
  | { readonly action: "rotate"; readonly to: Orientation; readonly turn?: never }
  | { readonly action: "posture"; readonly to: Posture }
  | { readonly action: "appearance"; readonly to: "light" | "dark" }
  | { readonly action: "text_size"; readonly to: TextSizeStep | IosContentSize | AndroidFontScale }
  | { readonly action: "location"; readonly to: LatLon | null }
  | { readonly action: "status_bar"; readonly to: "clean" | "live" }
  | { readonly action: "battery"; readonly to: Battery | null }
  | { readonly action: "network"; readonly to: NetworkPreset }
  | { readonly action: "install"; readonly paths: NonEmpty<string> }
  | { readonly action: "switch"; readonly device: ModelName }
  | { readonly action: "reboot" };

export type DeviceAction = DeviceControl["action"];

export const DEVICE_ACTIONS = [
  "home",
  "back",
  "recents",
  "lock",
  "wake",
  "rotate",
  "posture",
  "appearance",
  "text_size",
  "location",
  "status_bar",
  "battery",
  "network",
  "install",
  "switch",
  "reboot",
] as const satisfies readonly DeviceAction[];

export interface Point {
  readonly x: number;
  readonly y: number;
  readonly generation: number;
}

export const KEY_MODIFIERS = ["shift", "control", "alt", "meta"] as const;
export type KeyModifier = (typeof KEY_MODIFIERS)[number];

export type DeviceInput =
  | { readonly type: "tap"; readonly at: Point }
  | { readonly type: "long_press"; readonly at: Point; readonly ms: number }
  | { readonly type: "swipe"; readonly from: Point; readonly to: Point; readonly ms: number }
  | { readonly type: "pinch"; readonly centre: Point; readonly from: number; readonly to: number; readonly ms: number }
  | { readonly type: "key"; readonly key: string; readonly modifiers: readonly KeyModifier[] }
  | { readonly type: "text"; readonly text: string };

export interface ElementFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DeviceElement {
  readonly role: string;
  readonly identifier: string | null;
  readonly label: string;
  readonly value: string | null;
  readonly frame: ElementFrame;
  readonly enabled: boolean;
  readonly focused: boolean;
  readonly can: { readonly tap: boolean; readonly edit: boolean; readonly scroll: boolean } | null;
  readonly children: readonly DeviceElement[];
}

export interface TouchContact {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

export const DEVICE_ERROR_CODES = [
  "unsupported",
  "unknown-device",
  "bad-value",
  "not-booted",
  "busy",
  "stale-geometry",
  "ambiguous",
  "outcome-unknown",
  "superseded",
  "failed",
  "person-has-control",
  "in-progress",
] as const;
export type DeviceErrorCode = (typeof DEVICE_ERROR_CODES)[number];

export interface DeviceError {
  readonly code: DeviceErrorCode;
  readonly words: string;
}

export type ControlHolder = "agent" | "person";

export type DeviceRequest =
  | { readonly id: string; readonly type: "touch"; readonly contacts: readonly TouchContact[]; readonly generation: number }
  | { readonly id: string; readonly type: "text"; readonly text: string }
  | { readonly id: string; readonly type: "control"; readonly control: DeviceControl }
  | { readonly id: string; readonly type: "input"; readonly input: DeviceInput; readonly owner: number }
  | { readonly id: string; readonly type: "owner"; readonly generation: number; readonly holder: ControlHolder }
  | { readonly id: string; readonly type: "screenshot" }
  | { readonly id: string; readonly type: "tree" }
  | { readonly id: string; readonly type: "record"; readonly to: "start" | "stop" }
  | { readonly id: string; readonly type: "result" };

export type DeviceRequestType = DeviceRequest["type"];

export type DeviceHello = {
  readonly [P in DevicePlatform]: {
    readonly protocol: number;
    readonly version: number;
    readonly platform: P;
    readonly devices: NonEmpty<OfferedDeviceOf<P>>;
    readonly state: DeviceStateOf<P>;
    readonly lease: boolean;
  };
}[DevicePlatform];

export type AnswerResult =
  | { readonly type: "done" }
  | { readonly type: "screenshot"; readonly png: string; readonly generation: number }
  | { readonly type: "tree"; readonly elements: readonly DeviceElement[]; readonly generation: number };

export type DeviceAnswer =
  | { readonly id: string; readonly ok: true; readonly ms: number; readonly state: DeviceState; readonly result: AnswerResult }
  | { readonly id: string; readonly ok: false; readonly error: DeviceError; readonly state: DeviceState | null };

export type DeviceServerMessage =
  | { readonly verb: "BB_DEVICE_HELLO"; readonly hello: DeviceHello }
  | { readonly verb: "BB_DEVICE_STATE"; readonly state: DeviceState }
  | { readonly verb: "BB_DEVICE_TOUCH"; readonly contacts: readonly TouchContact[]; readonly by: ControlHolder; readonly generation: number }
  | { readonly verb: "BB_DEVICE_STILL"; readonly png: string; readonly generation: number }
  | { readonly verb: "BB_DEVICE_ANSWER"; readonly answer: DeviceAnswer };

export type DeviceServerVerb = DeviceServerMessage["verb"];
export const DEVICE_REQUEST_VERB = "BB_DEVICE";

export const LOCATION_RANGE = { latitude: 90, longitude: 180 } as const;
export const BATTERY_LEVELS = { least: 0, most: 100 } as const;

const PLATFORM_WORDS: Readonly<Record<DevicePlatform, string>> = { ios: "iOS", android: "Android" };

export function platformWord(platform: DevicePlatform): string {
  return PLATFORM_WORDS[platform];
}

export function orientationWord(orientation: Orientation): string {
  return orientation.replace("-", " ");
}

export function deviceModels(platform?: DevicePlatform): readonly TableModel[] {
  return platform ? DEVICE_MODELS.filter((model) => model.platform === platform) : DEVICE_MODELS;
}

export function deviceModel(name: ModelName): TableModel {
  return DEVICE_MODELS.find((model) => model.name === name)!;
}

export function modelNamed(name: string, platform?: DevicePlatform): TableModel | null {
  const wanted = name.trim().toLowerCase();
  return deviceModels(platform).find((model) => model.name.toLowerCase() === wanted) ?? null;
}

export function isModelOf<P extends DevicePlatform>(platform: P, name: ModelName): name is ModelNameOf<P> {
  return deviceModel(name).platform === platform;
}

export function listWords(items: readonly string[], last = "and"): string {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${last} ${items.at(-1)}`;
}

export function offeredModels(offer: DeviceOffer): readonly ModelName[] {
  return offer.devices.map((device) => device.model);
}

export function offersModel(offer: DeviceOffer | null, name: ModelName): boolean {
  return !!offer && offeredModels(offer).includes(name);
}

export function screensOf(model: DeviceModel): NonEmpty<Screen> {
  return model.form === "foldable" ? [model.outer, model.inner] : [model.screen];
}

export function foldScreenFor(posture: Posture): FoldScreen {
  return posture === "closed" ? "outer" : "inner";
}

export type Support = { readonly supported: true } | { readonly supported: false; readonly error: DeviceError };

const SUPPORTED: Support = { supported: true };

function refused(code: DeviceErrorCode, words: string): Support {
  return { supported: false, error: { code, words } };
}

function lacking(model: DeviceModel, action: DeviceAction): string | null {
  switch (action) {
    case "back":
      return model.platform === "ios" ? "iOS has no back button." : null;
    case "recents":
      return model.platform === "ios" ? "iOS has no command for recent apps." : null;
    case "posture":
      if (model.form === "foldable") return null;
      if (model.platform === "ios") return "No iOS device folds.";
      return `The ${model.name} does not fold. ${foldablesWords()}`;
    case "status_bar":
      return model.platform === "android" ? "bb-box cannot set an Android device's status bar yet." : null;
    case "network":
      return model.platform === "ios" ? "bb-box has no network control for iOS devices." : null;
    default:
      return null;
  }
}

function foldablesWords(): string {
  const foldables = DEVICE_MODELS.filter((model) => model.form === "foldable").map((model) => `The ${model.name}`);
  return foldables.length ? `${listWords(foldables)} ${foldables.length === 1 ? "does" : "do"}.` : "";
}

export function actionsOf(model: DeviceModel): readonly DeviceAction[] {
  return DEVICE_ACTIONS.filter((action) => lacking(model, action) === null);
}

function textSizeWords(platform: DevicePlatform): string {
  return platform === "ios"
    ? `text_size on iOS takes larger, smaller, default or a content size: ${listWords(IOS_CONTENT_SIZES, "or")}.`
    : `text_size on Android takes larger, smaller, default or a font scale: ${listWords(ANDROID_FONT_SCALES.map(String), "or")}.`;
}

function isContentSize(value: unknown): value is IosContentSize {
  return (IOS_CONTENT_SIZES as readonly unknown[]).includes(value);
}

function isFontScale(value: unknown): value is AndroidFontScale {
  return (ANDROID_FONT_SCALES as readonly unknown[]).includes(value);
}

export function locationProblem(to: LatLon): string | null {
  const inRange = (value: number, most: number) => Number.isFinite(value) && Math.abs(value) <= most;
  return inRange(to.latitude, LOCATION_RANGE.latitude) && inRange(to.longitude, LOCATION_RANGE.longitude)
    ? null
    : `location takes a latitude from -${LOCATION_RANGE.latitude} to ${LOCATION_RANGE.latitude} and a longitude from -${LOCATION_RANGE.longitude} to ${LOCATION_RANGE.longitude}.`;
}

export function batteryProblem(to: Battery): string | null {
  return Number.isInteger(to.level) && to.level >= BATTERY_LEVELS.least && to.level <= BATTERY_LEVELS.most
    ? null
    : `battery takes a level, a whole number from ${BATTERY_LEVELS.least} to ${BATTERY_LEVELS.most}, and whether it is charging.`;
}

const extension = (path: string) => /\.([A-Za-z0-9]+)\/?$/.exec(path)?.[1]?.toLowerCase() ?? "";

function installProblem(platform: DevicePlatform, paths: NonEmpty<string>): string | null {
  const kinds = paths.map(extension);
  if (platform === "ios") {
    if (kinds.includes("ipa")) return "An .ipa is a build for a physical iPhone. Build for the simulator, for example xcodebuild -sdk iphonesimulator, and install the .app.";
    if (paths.length !== 1 || kinds[0] !== "app") return "install on iOS takes one .app folder built for the simulator.";
    return null;
  }
  if (kinds.includes("aab")) return "Android App Bundles do not install directly. Make APKs with bundletool build-apks --mode=universal.";
  if (!kinds.every((kind) => kind === "apk")) return "install on Android takes one .apk, or the split APKs of one app.";
  return null;
}

function valueProblem(model: DeviceModel, control: DeviceControl): Support {
  switch (control.action) {
    case "posture":
      return model.form === "foldable" && !model.postures.includes(control.to)
        ? refused("bad-value", `The ${model.name} takes ${listWords(model.postures, "or")}.`)
        : SUPPORTED;
    case "text_size": {
      const wrongStep = model.platform === "ios" ? isFontScale(control.to) : isContentSize(control.to);
      return wrongStep ? refused("bad-value", textSizeWords(model.platform)) : SUPPORTED;
    }
    case "location": {
      const problem = control.to && locationProblem(control.to);
      return problem ? refused("bad-value", problem) : SUPPORTED;
    }
    case "battery": {
      const problem = control.to && batteryProblem(control.to);
      return problem ? refused("bad-value", problem) : SUPPORTED;
    }
    case "install": {
      const problem = installProblem(model.platform, control.paths);
      return problem ? refused("bad-value", problem) : SUPPORTED;
    }
    case "switch": {
      if (isModelOf(model.platform, control.device)) return SUPPORTED;
      const own = deviceModels(model.platform).map((each) => each.name);
      return refused("unknown-device", `The ${control.device} is not an ${platformWord(model.platform)} device. ${platformWord(model.platform)}'s devices are: ${own.join(", ")}.`);
    }
    default:
      return SUPPORTED;
  }
}

export function supports(model: DeviceModel, control: DeviceControl): Support {
  const reason = lacking(model, control.action);
  if (reason !== null) return refused("unsupported", `${reason} The ${model.name}'s actions are: ${actionsOf(model).join(", ")}.`);
  return valueProblem(model, control);
}

export const DEVICE_PROTOCOL = 1;
export const DEVICE_PROTOCOLS = { least: 1, most: 1 } as const;
export const DEVICE_SERVER_VERSION = 1;

export function speaksProtocol(protocol: number): boolean {
  return protocol >= DEVICE_PROTOCOLS.least && protocol <= DEVICE_PROTOCOLS.most;
}

export const TEST_DEVICE_NAME = "Test device";
export const TEST_DEVICE_NATIVE = "bb-box-test-device";
export const TEST_DEVICE_DRIVER = "bb-box test driver";

const TEST_RUNTIMES: { readonly [P in DevicePlatform]: PlatformParts[P]["runtime"] } = {
  ios: { platform: "ios", os: "test", build: "test", xcode: "none", companion: TEST_DEVICE_DRIVER },
  android: { platform: "android", api: 35, image: "google_apis", revision: 1, abi: "x86_64", emulator: TEST_DEVICE_DRIVER, snapshot: null },
};

export const TEST_DEVICE_STAND_INS = { ios: ["iPhone 18 Pro", "iPhone 17"], android: ["Pixel 8", "Pixel Tablet"] } as const satisfies { readonly [P in DevicePlatform]: NonEmpty<ModelNameOf<P>> };

export function testDeviceOffer(platform: DevicePlatform): DeviceOffer {
  if (platform === "ios") return { platform, devices: [TEST_DEVICE_STAND_INS.ios[0], TEST_DEVICE_STAND_INS.ios[1]].map((model) => ({ model, native: TEST_DEVICE_NATIVE, runtime: TEST_RUNTIMES.ios })) as unknown as NonEmpty<OfferedDeviceOf<"ios">> };
  return { platform, devices: [TEST_DEVICE_STAND_INS.android[0], TEST_DEVICE_STAND_INS.android[1]].map((model) => ({ model, native: TEST_DEVICE_NATIVE, runtime: TEST_RUNTIMES.android })) as unknown as NonEmpty<OfferedDeviceOf<"android">> };
}

export function isTestDevice(device: Pick<OfferedDevice, "native">): boolean {
  return device.native === TEST_DEVICE_NATIVE;
}

export function isTestOffer(offer: DeviceOffer | null): boolean {
  return !!offer && offer.devices.every(isTestDevice);
}

export function testDevicePlatformFor(os: "linux" | "macos" | "windows"): DevicePlatform | null {
  return os === "macos" ? "ios" : os === "linux" ? "android" : null;
}
