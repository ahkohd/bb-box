import type { CaptionPosition, RecordingSummary, StepKind } from "./device-recording.ts";
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

export interface SlimList {
  readonly list: string;
  readonly labels: number;
  readonly sha256: string;
}

interface PlatformParts {
  readonly ios: { readonly model: IosModelName; readonly runtime: IosRuntime; readonly failure: IosFailureCode; readonly built: { readonly slim?: SlimList } };
  readonly android: { readonly model: AndroidModelName; readonly runtime: AndroidRuntime; readonly failure: AndroidFailureCode; readonly built: { readonly slim?: never } };
}

export type ModelNameOf<P extends DevicePlatform> = PlatformParts[P]["model"];

export type OfferedDeviceOf<P extends DevicePlatform> = {
  readonly model: ModelNameOf<P>;
  readonly native: string;
  readonly runtime: PlatformParts[P]["runtime"];
} & PlatformParts[P]["built"];

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
  readonly changesShowAtStart?: boolean;
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
  "held-elsewhere",
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
  | { readonly id: string; readonly type: "paste"; readonly text: string }
  | { readonly id: string; readonly type: "control"; readonly control: DeviceControl }
  | { readonly id: string; readonly type: "input"; readonly input: DeviceInput; readonly owner: number }
  | { readonly id: string; readonly type: "owner"; readonly generation: number; readonly holder: ControlHolder }
  | { readonly id: string; readonly type: "open"; readonly url: string }
  | { readonly id: string; readonly type: "screenshot"; readonly longestEdge?: number }
  | { readonly id: string; readonly type: "tree" }
  | { readonly id: string; readonly type: "clipboard" }
  | { readonly id: string; readonly type: "settings" }
  | { readonly id: string; readonly type: "at"; readonly x: number; readonly y: number }
  | { readonly id: string; readonly type: "launch"; readonly app: string }
  | { readonly id: string; readonly type: "settle"; readonly quietMs: number; readonly mostMs: number; readonly fromNow: boolean }
  | { readonly id: string; readonly type: "record"; readonly to: "start"; readonly position?: CaptionPosition }
  | { readonly id: string; readonly type: "record"; readonly to: "caption"; readonly kind: StepKind; readonly text: string }
  | { readonly id: string; readonly type: "record"; readonly to: "stop" }
  | { readonly id: string; readonly type: "cap"; readonly most: VideoStep | null; readonly words?: string | null }
  | { readonly id: string; readonly type: "result" };

export type DeviceRequestType = DeviceRequest["type"];

export type DeviceRead = { readonly type: "tree" } | { readonly type: "clipboard" } | { readonly type: "at"; readonly x: number; readonly y: number } | { readonly type: "screenshot"; readonly longestEdge?: number } | { readonly type: "settle"; readonly quietMs: number; readonly mostMs: number; readonly fromNow: boolean };
export type DeviceAgentRequest = { readonly type: "open"; readonly url: string } | { readonly type: "launch"; readonly app: string };

export type DeviceHello = {
  readonly [P in DevicePlatform]: {
    readonly protocol: number;
    readonly version: number;
    readonly platform: P;
    readonly devices: NonEmpty<OfferedDeviceOf<P>>;
    readonly state: DeviceStateOf<P>;
    readonly lease: boolean;
    readonly bootedHere?: readonly ModelNameOf<P>[];
  };
}[DevicePlatform];

export interface LaunchedApp {
  readonly id: string;
  readonly name: string;
}

export type AnswerResult =
  | { readonly type: "done" }
  | { readonly type: "screenshot"; readonly png: string; readonly generation: number; readonly source?: VideoSize }
  | { readonly type: "tree"; readonly elements: readonly DeviceElement[]; readonly generation: number }
  | { readonly type: "clipboard"; readonly text: string }
  | { readonly type: "at"; readonly element: DeviceElement | null; readonly generation: number }
  | { readonly type: "launched"; readonly app: LaunchedApp }
  | { readonly type: "settled"; readonly frames: number; readonly quiet: boolean }
  | { readonly type: "recording"; readonly recording: RecordingSummary };

export type DeviceAnswer =
  | { readonly id: string; readonly ok: true; readonly ms: number; readonly state: DeviceState; readonly result: AnswerResult }
  | { readonly id: string; readonly ok: false; readonly error: DeviceError; readonly state: DeviceState | null };

export type DeviceServerMessage =
  | { readonly verb: "BB_DEVICE_HELLO"; readonly hello: DeviceHello }
  | { readonly verb: "BB_DEVICE_STATE"; readonly state: DeviceState }
  | { readonly verb: "BB_DEVICE_TOUCH"; readonly contacts: readonly TouchContact[]; readonly by: ControlHolder; readonly generation: number }
  | { readonly verb: "BB_DEVICE_STILL"; readonly png: string; readonly generation: number }
  | { readonly verb: "BB_DEVICE_ANSWER"; readonly answer: DeviceAnswer }
  | { readonly verb: "BB_DEVICE_VIDEO"; readonly video: VideoReport };

export type WantFor = "viewer" | "recording" | "wait";

export interface VideoWant {
  readonly for: WantFor;
  readonly step: VideoStep;
}

export type VideoEncoderWay = "hardware" | "software";

export interface VideoEncoding {
  readonly way: VideoEncoderWay;
  readonly encoder: string | null;
  readonly cores: number | null;
}

export interface VideoReport {
  readonly step: VideoStep | null;
  readonly wants: readonly VideoWant[];
  readonly cap: VideoStep | null;
  readonly fps: number;
  readonly words: string | null;
  readonly encoding?: VideoEncoding;
}

export type DeviceServerVerb = DeviceServerMessage["verb"];
export const DEVICE_REQUEST_VERB = "BB_DEVICE";
export const DEVICE_ANSWER_VERB = "BB_DEVICE_ANSWER" satisfies DeviceServerVerb;
export const DEVICE_STILLS_VERB = "BB_DEVICE_STILLS";
export const STILLS_EVERY_MS = 200;
export const DEVICE_FIRST_FRAME_MS = 3_000;

export function stillsRequestText(on: boolean): string {
  return `${DEVICE_STILLS_VERB} ${JSON.stringify({ on })}`;
}

export function stillsAsked(message: string): boolean | null {
  const match = /^BB_DEVICE_STILLS \{"on":(true|false)\}$/.exec(message);
  return match ? match[1] === "true" : null;
}

export const DEVICE_VIEW_VERB = "BB_DEVICE_VIEW";
export const DRAWN_PIXELS_MOST = 16_384;

export function viewRequestText(drawn: VideoSize): string {
  return `${DEVICE_VIEW_VERB} ${JSON.stringify({ width: Math.round(drawn.width), height: Math.round(drawn.height) })}`;
}

export function viewAsked(message: string): VideoSize | null {
  const match = /^BB_DEVICE_VIEW \{"width":(\d{1,5}),"height":(\d{1,5})\}$/.exec(message);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 && width <= DRAWN_PIXELS_MOST && height <= DRAWN_PIXELS_MOST ? { width, height } : null;
}

export const VIDEO_STEPS = ["third", "half", "two-thirds", "full"] as const;
export type VideoStep = (typeof VIDEO_STEPS)[number];
export const VIDEO_STEP_SCALES: { readonly [Step in VideoStep]: number } = { third: 1 / 3, half: 1 / 2, "two-thirds": 2 / 3, full: 1 };
export const VIDEO_STEP_SLACK = 0.05;

export function stepCovering(share: number): VideoStep {
  return VIDEO_STEPS.find((step) => VIDEO_STEP_SCALES[step] >= share - VIDEO_STEP_SLACK) ?? "full";
}

export function largerStep(a: VideoStep, b: VideoStep): VideoStep {
  return VIDEO_STEPS.indexOf(a) >= VIDEO_STEPS.indexOf(b) ? a : b;
}

export function smallerStep(a: VideoStep, b: VideoStep): VideoStep {
  return VIDEO_STEPS.indexOf(a) <= VIDEO_STEPS.indexOf(b) ? a : b;
}

export function drawnShare(drawn: VideoSize, screens: readonly { readonly pixels: VideoSize }[]): number {
  const drawnAspect = drawn.width / drawn.height;
  const nearest = [...screens].sort((a, b) => Math.abs(a.pixels.width / a.pixels.height - drawnAspect) - Math.abs(b.pixels.width / b.pixels.height - drawnAspect))[0];
  if (!nearest) return 1;
  return Math.max(drawn.width / nearest.pixels.width, drawn.height / nearest.pixels.height);
}

export const PERSON_HAS_CONTROL_WORDS = "A person has control of this box's device. Wait for them to hand it back, or take it back with computer_take_control when they ask.";

export const LOCATION_RANGE = { latitude: 90, longitude: 180 } as const;
export const BATTERY_LEVELS = { least: 0, most: 100 } as const;

const PLATFORM_WORDS: Readonly<Record<DevicePlatform, string>> = { ios: "iOS", android: "Android" };

export function platformWord(platform: DevicePlatform): string {
  return PLATFORM_WORDS[platform];
}

export type QuarterTurns = 0 | 1 | 2 | 3;

const CLOCKWISE_TURNS: Readonly<Record<Orientation, QuarterTurns>> = { upright: 0, "turned-right": 1, "upside-down": 2, "turned-left": 3 };

export function clockwiseTurns(orientation: Orientation): QuarterTurns {
  return CLOCKWISE_TURNS[orientation];
}

export function isSideways(orientation: Orientation): boolean {
  return clockwiseTurns(orientation) % 2 === 1;
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

export function actionSupport(model: DeviceModel, action: DeviceAction): Support {
  const reason = lacking(model, action);
  return reason === null ? SUPPORTED : refused("unsupported", `${reason} The ${model.name}'s actions are: ${actionsOf(model).join(", ")}.`);
}

export function supports(model: DeviceModel, control: DeviceControl): Support {
  const support = actionSupport(model, control.action);
  return support.supported ? valueProblem(model, control) : support;
}

export const DEVICE_PROTOCOL = 2;
export const DEVICE_PROTOCOLS = { least: 1, most: 2 } as const;
export const DEVICE_SERVER_VERSION = 31;
export const CLIPBOARD_READ_SINCE_VERSION = 28;
export const PASTE_REQUEST_SINCE_VERSION = 29;
export const DEVICE_CLIPBOARD_MOST = 100_000;
export const FRAME_GENERATIONS_SINCE_VERSION = 9;
export const SETTINGS_ASKED_SINCE_VERSION = 24;
export const VIDEO_REPORTS_SINCE_VERSION = 25;

export function frameGenerationOf(header: Uint8Array): number {
  return (header[10]! << 8) | header[11]!;
}

export function speaksProtocol(protocol: number): boolean {
  return protocol >= DEVICE_PROTOCOLS.least && protocol <= DEVICE_PROTOCOLS.most;
}

export const MAX_URL_LENGTH = 2048;
export const MAX_APP_LENGTH = 512;
export const SETTLE_MOST_MS = 30_000;
export const SCREENSHOT_EDGE_LEAST = 64;

export function urlProblem(url: string): string | null {
  if (url.length > MAX_URL_LENGTH) return `A link takes at most ${MAX_URL_LENGTH} characters.`;
  if (/\s/.test(url)) return "A link has no spaces. Write %20 for a space.";
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:./.test(url)) return "A link starts with its scheme, such as https:// or an app's own, such as myapp://.";
  return null;
}

export function linkFrom(typed: string): string {
  const trimmed = typed.trim();
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:(.*)$/.exec(trimmed);
  if (scheme && !/^\d+(\/|$)/.test(scheme[1]!)) return trimmed;
  return trimmed ? `https://${trimmed}` : "";
}

export const DEVICE_HUB_PROCESS = "DeviceHub";

export const IOS_COMPANION_PAIRINGS = [{ xcode: "27.0", companion: "1.7.7" }] as const satisfies readonly { readonly xcode: string; readonly companion: string }[];

export const IOS_PAIRINGS_WORDS = `The pairings checked are: ${IOS_COMPANION_PAIRINGS.map((pairing) => `Xcode ${pairing.xcode} with idb_companion ${pairing.companion}`).join(", ")}.`;

export function companionWorksWith(xcode: string, companion: string): boolean {
  return IOS_COMPANION_PAIRINGS.some((pairing) => pairing.xcode === xcode && pairing.companion === companion);
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
