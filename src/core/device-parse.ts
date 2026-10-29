import {
  ANDROID_FAILURE_CODES,
  ANDROID_FONT_SCALES,
  DEVICE_CLIPBOARD_MOST,
  DEVICE_ERROR_CODES,
  DEVICE_PLATFORMS,
  DEVICE_REQUEST_VERB,
  IOS_CONTENT_SIZES,
  IOS_FAILURE_CODES,
  KEY_MODIFIERS,
  MAX_APP_LENGTH,
  MAX_URL_LENGTH,
  SCREENSHOT_EDGE_LEAST,
  SETTLE_MOST_MS,
  NETWORK_PRESETS,
  ORIENTATIONS,
  POSTURES,
  SWITCH_STEPS,
  TEXT_SIZE_STEPS,
  VIDEO_STEPS,
  batteryProblem,
  deviceModel,
  deviceModels,
  foldScreenFor,
  listWords,
  locationProblem,
  modelNamed,
  platformWord,
  urlProblem,
  type AndroidRuntime,
  type AndroidSettings,
  type AnswerResult,
  type Battery,
  type BoxDevice,
  type DeviceAnswer,
  type DeviceControl,
  type DeviceElement,
  type DeviceError,
  type DeviceHello,
  type DeviceInput,
  type DeviceModel,
  type DeviceOffer,
  type DevicePlatform,
  type DeviceRequest,
  type DeviceServerMessage,
  type DeviceServerVerb,
  type DeviceState,
  type FoldGeometry,
  type FoldableModelName,
  type Geometry,
  type Intent,
  type IosRuntime,
  type IosSettings,
  type IosStatusBar,
  type KeyModifier,
  type LatLon,
  type ModelName,
  type ModelNameOf,
  type NonEmpty,
  type Observed,
  type OfferedDevice,
  type SlimList,
  type OfferedDevices,
  type Override,
  type Point,
  type Power,
  type Runtime,
  type TableModel,
  type TouchContact,
  type VideoEncoding,
  type VideoReport,
  type VideoWant,
} from "./device.ts";
import type { RecordingSummary } from "./device-recording.ts";

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly words: string };

class Refusal extends Error {}

type Fields = Readonly<Record<string, unknown>>;

const MAX_LIST = 64;
const MAX_CONTACTS = 10;
const MAX_TEXT = 100_000;
const MAX_ELEMENT_DEPTH = 64;
const MAX_ELEMENTS = 20_000;
const MAX_GESTURE_MS = 60_000;
const MAX_CAPTION = 200;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function refuse(path: string, problem: string): never {
  throw new Refusal(`${path} ${problem}`);
}

function parsing<T>(read: () => T): Parsed<T> {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, words: error.message };
    throw error;
  }
}

function shown(value: unknown): string {
  if (value === undefined) return "missing";
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

function fields(value: unknown, path: string, keys: readonly string[]): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) refuse(path, `must be an object, not ${shown(value)}.`);
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length) refuse(path, `has ${listWords(extra.map((key) => `"${key}"`))}, which ${extra.length === 1 ? "it does" : "they do"} not take. It takes ${listWords(keys.map((key) => `"${key}"`))}.`);
  return value as Fields;
}

function text(value: unknown, path: string, most = MAX_TEXT): string {
  if (typeof value !== "string" || value === "") refuse(path, `must be text, not ${shown(value)}.`);
  if (value.length > most) refuse(path, `is longer than ${most} characters.`);
  return value;
}

function textOrNull(value: unknown, path: string): string | null {
  return value === null ? null : text(value, path);
}

function anyText(value: unknown, path: string): string {
  if (typeof value !== "string") refuse(path, `must be text, not ${shown(value)}.`);
  if (value.length > MAX_TEXT) refuse(path, `is longer than ${MAX_TEXT} characters.`);
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") refuse(path, `must be true or false, not ${shown(value)}.`);
  return value;
}

function number(value: unknown, path: string, least = 0, most = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < least || value > most) refuse(path, `must be a number from ${least} to ${most}, not ${shown(value)}.`);
  return value;
}

function whole(value: unknown, path: string, least = 0, most = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < least || value > most) refuse(path, `must be a whole number from ${least} to ${most}, not ${shown(value)}.`);
  return value;
}

function positive(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) refuse(path, `must be a number above 0, not ${shown(value)}.`);
  return value;
}

const time = (value: unknown, path: string) => number(value, path);

function oneOf<const T extends string | number>(value: unknown, path: string, options: readonly T[]): T {
  if (!(options as readonly unknown[]).includes(value)) refuse(path, `must be ${listWords(options.map((option) => (typeof option === "string" ? `"${option}"` : String(option))), "or")}, not ${shown(value)}.`);
  return value as T;
}

function list<T>(value: unknown, path: string, read: (item: unknown, path: string) => T, most = MAX_LIST): T[] {
  if (!Array.isArray(value)) refuse(path, `must be a list, not ${shown(value)}.`);
  if (value.length > most) refuse(path, `has ${value.length} items, more than ${most}.`);
  return value.map((item, index) => read(item, `${path}[${index}]`));
}

function nonEmpty<T>(value: unknown, path: string, read: (item: unknown, path: string) => T, most = MAX_LIST): NonEmpty<T> {
  const items = list(value, path, read, most);
  if (!items.length) refuse(path, "must not be empty.");
  return items as unknown as NonEmpty<T>;
}

function platformOf(value: unknown, path: string): DevicePlatform {
  return oneOf(value, path, DEVICE_PLATFORMS);
}

function modelOf<P extends DevicePlatform>(value: unknown, path: string, platform: P): ModelNameOf<P> {
  const name = text(value, path, 200);
  const model = deviceModels(platform).find((each) => each.name === name);
  if (!model) {
    const elsewhere = modelNamed(name);
    refuse(
      path,
      elsewhere && elsewhere.platform !== platform
        ? `names the ${elsewhere.name}, an ${platformWord(elsewhere.platform)} device, where an ${platformWord(platform)} device belongs.`
        : `names no ${platformWord(platform)} device: ${shown(name)}. The ${platformWord(platform)} devices are: ${deviceModels(platform).map((each) => each.name).join(", ")}.`,
    );
  }
  return model.name as ModelNameOf<P>;
}

function anyModel(value: unknown, path: string): ModelName {
  const name = text(value, path, 200);
  const model = deviceModels().find((each) => each.name === name);
  if (!model) refuse(path, `names no device: ${shown(name)}. The devices are: ${deviceModels().map((each) => each.name).join(", ")}.`);
  return model.name;
}

function runtimeOf(value: unknown, path: string): Runtime {
  const platform = platformOf((value as Fields | null)?.platform, `${path}.platform`);
  if (platform === "ios") {
    const read = fields(value, path, ["platform", "os", "build", "xcode", "companion"]);
    const runtime: IosRuntime = {
      platform,
      os: text(read.os, `${path}.os`, 64),
      build: text(read.build, `${path}.build`, 64),
      xcode: text(read.xcode, `${path}.xcode`, 64),
      companion: text(read.companion, `${path}.companion`, 64),
    };
    return runtime;
  }
  const read = fields(value, path, ["platform", "api", "image", "revision", "abi", "emulator", "snapshot"]);
  const snapshot =
    read.snapshot === null
      ? null
      : (() => {
          const origin = fields(read.snapshot, `${path}.snapshot`, ["emulator", "cpu", "made"]);
          return { emulator: text(origin.emulator, `${path}.snapshot.emulator`, 64), cpu: text(origin.cpu, `${path}.snapshot.cpu`, 200), made: text(origin.made, `${path}.snapshot.made`, 64) };
        })();
  const runtime: AndroidRuntime = {
    platform,
    api: whole(read.api, `${path}.api`, 1, 1000),
    image: oneOf(read.image, `${path}.image`, ["google_apis"]),
    revision: whole(read.revision, `${path}.revision`, 1, 1000),
    abi: oneOf(read.abi, `${path}.abi`, ["x86_64"]),
    emulator: text(read.emulator, `${path}.emulator`, 64),
    snapshot,
  };
  return runtime;
}

const SHA256 = /^[0-9a-f]{64}$/;
const SLIM_LIST_NAME = /^[A-Za-z0-9._-]{1,64}$/;

function slimList(value: unknown, path: string): SlimList {
  const read = fields(value, path, ["list", "labels", "sha256"]);
  const list = text(read.list, `${path}.list`, 64);
  if (!SLIM_LIST_NAME.test(list)) refuse(`${path}.list`, `must be a list's name, such as "ios-27.0-24A434", not ${shown(list)}.`);
  const sha256 = text(read.sha256, `${path}.sha256`, 64);
  if (!SHA256.test(sha256)) refuse(`${path}.sha256`, `must be a SHA-256 in hex, not ${shown(sha256)}.`);
  return { list, labels: whole(read.labels, `${path}.labels`, 1, 10_000), sha256 };
}

function offeredDevice(value: unknown, path: string): OfferedDevice {
  const read = fields(value, path, ["model", "native", "runtime", "slim"]);
  const runtime = runtimeOf(read.runtime, `${path}.runtime`);
  if (read.slim !== undefined && runtime.platform !== "ios") refuse(`${path}.slim`, "is only for iOS devices, whose image slims them.");
  const device = { model: modelOf(read.model, `${path}.model`, runtime.platform), native: text(read.native, `${path}.native`, 200), runtime };
  return (read.slim === undefined ? device : { ...device, slim: slimList(read.slim, `${path}.slim`) }) as OfferedDevice;
}

function offeredDevices(value: unknown, path: string): OfferedDevices {
  const devices = nonEmpty(value, path, offeredDevice);
  const platforms = new Set(devices.map((device) => device.runtime.platform));
  if (platforms.size > 1) refuse(path, "mixes iOS and Android devices; an image offers one platform's.");
  const models = devices.map((device) => device.model);
  const twice = models.find((model, index) => models.indexOf(model) !== index);
  if (twice) refuse(path, `lists the ${twice} twice.`);
  return devices as unknown as OfferedDevices;
}

function deviceOffer(value: unknown, path: string): DeviceOffer {
  const read = fields(value, path, ["platform", "devices"]);
  const platform = platformOf(read.platform, `${path}.platform`);
  const devices = offeredDevices(read.devices, `${path}.devices`);
  if (devices[0].runtime.platform !== platform) refuse(`${path}.devices`, `are ${platformWord(devices[0].runtime.platform)} devices, on an ${platformWord(platform)} offer.`);
  return { platform, devices } as DeviceOffer;
}

function boxDevice(value: unknown, path: string): BoxDevice {
  const read = fields(value, path, ["platform", "model", "runtime"]);
  const platform = platformOf(read.platform, `${path}.platform`);
  const runtime = runtimeOf(read.runtime, `${path}.runtime`);
  if (runtime.platform !== platform) refuse(`${path}.runtime`, `is ${platformWord(runtime.platform)}'s, on an ${platformWord(platform)} device.`);
  return { platform, model: modelOf(read.model, `${path}.model`, platform), runtime } as BoxDevice;
}

function observed<T>(value: unknown, path: string, read: (value: unknown, path: string) => T): Observed<T> {
  const known = bool((value as Fields | null)?.known, `${path}.known`);
  if (!known) {
    const unknown = fields(value, path, ["known", "why"]);
    return { known, why: text(unknown.why, `${path}.why`, 1000) };
  }
  const seen = fields(value, path, ["known", "value", "at", "by"]);
  return { known, value: read(seen.value, `${path}.value`), at: time(seen.at, `${path}.at`), by: oneOf(seen.by, `${path}.by`, ["bb-box", "outside"]) };
}

function override<T>(value: unknown, path: string, read: (value: unknown, path: string) => T): Override<T> {
  const given = fields(value, path, ["set", "at"]);
  if (given.set === null) return { set: null, at: given.at === null ? null : time(given.at, `${path}.at`) };
  return { set: read(given.set, `${path}.set`), at: time(given.at, `${path}.at`) };
}

function latLon(value: unknown, path: string): LatLon {
  const read = fields(value, path, ["latitude", "longitude"]);
  const to = { latitude: number(read.latitude, `${path}.latitude`, -90, 90), longitude: number(read.longitude, `${path}.longitude`, -180, 180) };
  const problem = locationProblem(to);
  if (problem) refuse(path, problem);
  return to;
}

function battery(value: unknown, path: string): Battery {
  const read = fields(value, path, ["level", "charging"]);
  const to = { level: whole(read.level, `${path}.level`, 0, 100), charging: bool(read.charging, `${path}.charging`) };
  const problem = batteryProblem(to);
  if (problem) refuse(path, problem);
  return to;
}

const appearance = (value: unknown, path: string) => oneOf(value, path, ["light", "dark"]);

function iosSettings(value: unknown, path: string): IosSettings {
  const read = fields(value, path, ["appearance", "textSize", "location", "statusBar", "changesShowAtStart"]);
  const statusBar = (bar: unknown, at: string): IosStatusBar => {
    const parts = fields(bar, at, ["clean", "battery"]);
    return { clean: bool(parts.clean, `${at}.clean`), battery: parts.battery === null ? null : battery(parts.battery, `${at}.battery`) };
  };
  return {
    appearance: observed(read.appearance, `${path}.appearance`, appearance),
    textSize: observed(read.textSize, `${path}.textSize`, (size, at) => oneOf(size, at, IOS_CONTENT_SIZES)),
    location: override(read.location, `${path}.location`, latLon),
    statusBar: override(read.statusBar, `${path}.statusBar`, statusBar),
    ...(read.changesShowAtStart === undefined ? {} : { changesShowAtStart: bool(read.changesShowAtStart, `${path}.changesShowAtStart`) }),
  };
}

function androidSettings(value: unknown, path: string): AndroidSettings {
  const read = fields(value, path, ["appearance", "fontScale", "location", "battery", "network", "statusBar"]);
  return {
    appearance: observed(read.appearance, `${path}.appearance`, appearance),
    fontScale: observed(read.fontScale, `${path}.fontScale`, (scale, at) => oneOf(scale, at, ANDROID_FONT_SCALES)),
    location: observed(read.location, `${path}.location`, (where, at) => (where === null ? null : latLon(where, at))),
    battery: observed(read.battery, `${path}.battery`, battery),
    network: observed(read.network, `${path}.network`, (preset, at) => oneOf(preset, at, NETWORK_PRESETS)),
    statusBar: override(read.statusBar, `${path}.statusBar`, (bar, at) => oneOf(bar, at, ["clean"])),
  };
}

function power<P extends DevicePlatform>(value: unknown, path: string, platform: P, model: ModelNameOf<P>): Power<P> {
  const is = oneOf((value as Fields | null)?.is, `${path}.is`, ["booting", "booted", "switching", "stopped", "failed"]);
  switch (is) {
    case "booting": {
      const read = fields(value, path, ["is", "since"]);
      return { is, since: time(read.since, `${path}.since`) };
    }
    case "booted": {
      const read = fields(value, path, ["is", "awake"]);
      return { is, awake: bool(read.awake, `${path}.awake`) };
    }
    case "switching": {
      const read = fields(value, path, ["is", "to", "step", "since"]);
      const to = modelOf(read.to, `${path}.to`, platform);
      if (to === model) refuse(`${path}.to`, `is the ${model}, which the box runs already.`);
      return { is, to, step: oneOf(read.step, `${path}.step`, SWITCH_STEPS), since: time(read.since, `${path}.since`) };
    }
    case "stopped":
      fields(value, path, ["is"]);
      return { is };
    case "failed": {
      const read = fields(value, path, ["is", "error", "since"]);
      const error = fields(read.error, `${path}.error`, ["code", "words"]);
      const codes: readonly string[] = platform === "ios" ? IOS_FAILURE_CODES : ANDROID_FAILURE_CODES;
      return { is, error: { code: oneOf(error.code, `${path}.error.code`, codes), words: text(error.words, `${path}.error.words`, 2000) }, since: time(read.since, `${path}.since`) } as Power<P>;
    }
  }
}

function geometry(value: unknown, path: string): Geometry {
  const read = fields(value, path, ["generation", "physical", "content", "video"]);
  return geometryParts(read, path);
}

function geometryParts(read: Fields, path: string): Geometry {
  const video = fields(read.video, `${path}.video`, ["width", "height"]);
  return {
    generation: whole(read.generation, `${path}.generation`),
    physical: oneOf(read.physical, `${path}.physical`, ORIENTATIONS),
    content: oneOf(read.content, `${path}.content`, ORIENTATIONS),
    video: { width: whole(video.width, `${path}.video.width`, 1, 16384), height: whole(video.height, `${path}.video.height`, 1, 16384) },
  };
}

function foldGeometry(value: unknown, path: string): FoldGeometry {
  const read = fields(value, path, ["generation", "physical", "content", "video", "screen"]);
  return { ...geometryParts(read, path), screen: oneOf(read.screen, `${path}.screen`, ["outer", "inner"]) };
}

function deviceState(value: unknown, path: string): DeviceState {
  const platform = platformOf((value as Fields | null)?.platform, `${path}.platform`);
  if (platform === "ios") {
    const read = fields(value, path, ["platform", "model", "power", "geometry", "settings", "at"]);
    const model = modelOf(read.model, `${path}.model`, platform);
    return {
      platform,
      model,
      power: power(read.power, `${path}.power`, platform, model),
      geometry: read.geometry === null ? null : geometry(read.geometry, `${path}.geometry`),
      settings: iosSettings(read.settings, `${path}.settings`),
      at: time(read.at, `${path}.at`),
    };
  }
  const form = oneOf((value as Fields | null)?.form, `${path}.form`, ["phone", "tablet", "foldable"]);
  const model = modelOf((value as Fields).model, `${path}.model`, platform);
  const shape = deviceModel(model);
  if (shape.form !== form) refuse(`${path}.form`, `is ${form}, but the ${model} is a ${shape.form}.`);
  if (shape.form !== "foldable") {
    const read = fields(value, path, ["platform", "form", "model", "power", "geometry", "settings", "at"]);
    return {
      platform,
      form: shape.form,
      model,
      power: power(read.power, `${path}.power`, platform, model),
      geometry: read.geometry === null ? null : geometry(read.geometry, `${path}.geometry`),
      settings: androidSettings(read.settings, `${path}.settings`),
      at: time(read.at, `${path}.at`),
    } as DeviceState;
  }
  const read = fields(value, path, ["platform", "form", "model", "power", "geometry", "posture", "settings", "at"]);
  const posture = observed(read.posture, `${path}.posture`, (given, at) => oneOf(given, at, POSTURES));
  if (posture.known && !shape.postures.includes(posture.value)) refuse(`${path}.posture.value`, `is ${posture.value}, which the ${model} does not take. It takes ${listWords(shape.postures, "or")}.`);
  const fold = read.geometry === null ? null : foldGeometry(read.geometry, `${path}.geometry`);
  if (fold && posture.known && fold.screen !== foldScreenFor(posture.value)) refuse(`${path}.geometry.screen`, `is ${fold.screen}, but a ${model} that is ${posture.value} shows its ${foldScreenFor(posture.value)} screen.`);
  return {
    platform,
    form: "foldable",
    model: model as FoldableModelName,
    power: power(read.power, `${path}.power`, platform, model),
    geometry: fold,
    posture,
    settings: androidSettings(read.settings, `${path}.settings`),
    at: time(read.at, `${path}.at`),
  } as DeviceState;
}

function intent(value: unknown, path: string, platform: DevicePlatform): Intent {
  const read = fields(value, path, ["target", "switching"]);
  const target = modelOf(read.target, `${path}.target`, platform);
  if (read.switching === null) return { target, switching: null } as Intent;
  const switching = fields(read.switching, `${path}.switching`, ["id", "from", "step", "since"]);
  const from = modelOf(switching.from, `${path}.switching.from`, platform);
  if (from === target) refuse(`${path}.switching.from`, `is the ${target}, the switch's own target.`);
  return {
    target,
    switching: { id: requestId(switching.id, `${path}.switching.id`), from, step: oneOf(switching.step, `${path}.switching.step`, SWITCH_STEPS), since: time(switching.since, `${path}.switching.since`) },
  } as Intent;
}

function requestId(value: unknown, path: string): string {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) refuse(path, `must be 1 to 64 letters, digits, ".", "_", ":" or "-", not ${shown(value)}.`);
  return value;
}

function textSizeTo(value: unknown, path: string): DeviceControl & { readonly action: "text_size" } {
  if (typeof value === "number") return { action: "text_size", to: oneOf(value, path, ANDROID_FONT_SCALES) };
  return { action: "text_size", to: oneOf(value, path, [...TEXT_SIZE_STEPS, ...IOS_CONTENT_SIZES]) };
}

function control(value: unknown, path: string): DeviceControl {
  const action = oneOf((value as Fields | null)?.action, `${path}.action`, ["home", "back", "recents", "lock", "wake", "rotate", "posture", "appearance", "text_size", "location", "status_bar", "battery", "network", "install", "switch", "reboot"]);
  const at = (key: string) => `${path}.${key}`;
  switch (action) {
    case "home":
    case "back":
    case "recents":
    case "lock":
    case "wake":
    case "reboot":
      fields(value, path, ["action"]);
      return { action };
    case "rotate": {
      const read = fields(value, path, ["action", "turn", "to"]);
      if ((read.turn === undefined) === (read.to === undefined)) refuse(path, 'takes "turn" or "to", one of them.');
      return read.turn !== undefined ? { action, turn: oneOf(read.turn, at("turn"), ["left", "right"]) } : { action, to: oneOf(read.to, at("to"), ORIENTATIONS) };
    }
    case "posture":
      return { action, to: oneOf(fields(value, path, ["action", "to"]).to, at("to"), POSTURES) };
    case "appearance":
      return { action, to: appearance(fields(value, path, ["action", "to"]).to, at("to")) };
    case "text_size":
      return textSizeTo(fields(value, path, ["action", "to"]).to, at("to"));
    case "location": {
      const to = fields(value, path, ["action", "to"]).to;
      return { action, to: to === null ? null : latLon(to, at("to")) };
    }
    case "status_bar":
      return { action, to: oneOf(fields(value, path, ["action", "to"]).to, at("to"), ["clean", "live"]) };
    case "battery": {
      const to = fields(value, path, ["action", "to"]).to;
      return { action, to: to === null ? null : battery(to, at("to")) };
    }
    case "network":
      return { action, to: oneOf(fields(value, path, ["action", "to"]).to, at("to"), NETWORK_PRESETS) };
    case "install":
      return { action, paths: nonEmpty(fields(value, path, ["action", "paths"]).paths, at("paths"), (each, where) => text(each, where, 4096)) };
    case "switch":
      return { action, device: anyModel(fields(value, path, ["action", "device"]).device, at("device")) };
  }
}

function point(value: unknown, path: string): Point {
  const read = fields(value, path, ["x", "y", "generation"]);
  return { x: number(read.x, `${path}.x`, 0, 16384), y: number(read.y, `${path}.y`, 0, 16384), generation: whole(read.generation, `${path}.generation`) };
}

const gestureMs = (value: unknown, path: string) => whole(value, path, 1, MAX_GESTURE_MS);

function input(value: unknown, path: string): DeviceInput {
  const type = oneOf((value as Fields | null)?.type, `${path}.type`, ["tap", "long_press", "swipe", "pinch", "key", "text"]);
  const at = (key: string) => `${path}.${key}`;
  switch (type) {
    case "tap":
      return { type, at: point(fields(value, path, ["type", "at"]).at, at("at")) };
    case "long_press": {
      const read = fields(value, path, ["type", "at", "ms"]);
      return { type, at: point(read.at, at("at")), ms: gestureMs(read.ms, at("ms")) };
    }
    case "swipe": {
      const read = fields(value, path, ["type", "from", "to", "ms"]);
      return { type, from: point(read.from, at("from")), to: point(read.to, at("to")), ms: gestureMs(read.ms, at("ms")) };
    }
    case "pinch": {
      const read = fields(value, path, ["type", "centre", "from", "to", "ms"]);
      return { type, centre: point(read.centre, at("centre")), from: positive(read.from, at("from")), to: positive(read.to, at("to")), ms: gestureMs(read.ms, at("ms")) };
    }
    case "key": {
      const read = fields(value, path, ["type", "key", "modifiers"]);
      const modifiers = list(read.modifiers, at("modifiers"), (each, where): KeyModifier => oneOf(each, where, KEY_MODIFIERS), KEY_MODIFIERS.length);
      if (new Set(modifiers).size !== modifiers.length) refuse(at("modifiers"), "names a modifier twice.");
      return { type, key: text(read.key, at("key"), 32), modifiers };
    }
    case "text":
      return { type, text: text(fields(value, path, ["type", "text"]).text, at("text")) };
  }
}

function element(value: unknown, path: string, depth: number, count: { seen: number }): DeviceElement {
  if (depth > MAX_ELEMENT_DEPTH) refuse(path, `is nested more than ${MAX_ELEMENT_DEPTH} deep.`);
  if (++count.seen > MAX_ELEMENTS) refuse(path, `is past ${MAX_ELEMENTS} elements.`);
  const read = fields(value, path, ["role", "identifier", "label", "value", "frame", "enabled", "focused", "can", "children"]);
  const frame = fields(read.frame, `${path}.frame`, ["x", "y", "width", "height"]);
  const can = read.can === null ? null : fields(read.can, `${path}.can`, ["tap", "edit", "scroll"]);
  return {
    role: text(read.role, `${path}.role`, 200),
    identifier: textOrNull(read.identifier, `${path}.identifier`),
    label: anyText(read.label, `${path}.label`),
    value: read.value === null ? null : anyText(read.value, `${path}.value`),
    frame: {
      x: number(frame.x, `${path}.frame.x`, -16384, 16384),
      y: number(frame.y, `${path}.frame.y`, -16384, 16384),
      width: number(frame.width, `${path}.frame.width`, 0, 16384),
      height: number(frame.height, `${path}.frame.height`, 0, 16384),
    },
    enabled: bool(read.enabled, `${path}.enabled`),
    focused: bool(read.focused, `${path}.focused`),
    can: can && { tap: bool(can.tap, `${path}.can.tap`), edit: bool(can.edit, `${path}.can.edit`), scroll: bool(can.scroll, `${path}.can.scroll`) },
    children: list(read.children, `${path}.children`, (child, where) => element(child, where, depth + 1, count), MAX_ELEMENTS),
  };
}

function elements(value: unknown, path: string): readonly DeviceElement[] {
  const count = { seen: 0 };
  return list(value, path, (each, where) => element(each, where, 1, count), MAX_ELEMENTS);
}

function contact(value: unknown, path: string): TouchContact {
  const read = fields(value, path, ["id", "x", "y"]);
  return { id: whole(read.id, `${path}.id`, 0, MAX_CONTACTS - 1), x: number(read.x, `${path}.x`, 0, 16384), y: number(read.y, `${path}.y`, 0, 16384) };
}

function contacts(value: unknown, path: string): readonly TouchContact[] {
  const touches = list(value, path, contact, MAX_CONTACTS);
  const ids = touches.map((touch) => touch.id);
  if (new Set(ids).size !== ids.length) refuse(path, "names a contact twice.");
  return touches;
}

function base64(value: unknown, path: string): string {
  if (typeof value !== "string" || value === "" || value.length % 4 !== 0 || !BASE64.test(value)) refuse(path, "must be base64.");
  return value;
}

function request(value: unknown, path: string): DeviceRequest {
  const type = oneOf((value as Fields | null)?.type, `${path}.type`, ["touch", "text", "paste", "control", "input", "owner", "open", "launch", "settle", "at", "screenshot", "tree", "clipboard", "settings", "record", "cap", "result"]);
  const at = (key: string) => `${path}.${key}`;
  switch (type) {
    case "touch": {
      const read = fields(value, path, ["id", "type", "contacts", "generation"]);
      return { id: requestId(read.id, at("id")), type, contacts: contacts(read.contacts, at("contacts")), generation: whole(read.generation, at("generation")) };
    }
    case "text": {
      const read = fields(value, path, ["id", "type", "text"]);
      return { id: requestId(read.id, at("id")), type, text: text(read.text, at("text")) };
    }
    case "paste": {
      const read = fields(value, path, ["id", "type", "text"]);
      return { id: requestId(read.id, at("id")), type, text: text(read.text, at("text"), DEVICE_CLIPBOARD_MOST) };
    }
    case "control": {
      const read = fields(value, path, ["id", "type", "control"]);
      return { id: requestId(read.id, at("id")), type, control: control(read.control, at("control")) };
    }
    case "input": {
      const read = fields(value, path, ["id", "type", "input", "owner"]);
      return { id: requestId(read.id, at("id")), type, input: input(read.input, at("input")), owner: whole(read.owner, at("owner")) };
    }
    case "owner": {
      const read = fields(value, path, ["id", "type", "generation", "holder"]);
      return { id: requestId(read.id, at("id")), type, generation: whole(read.generation, at("generation")), holder: oneOf(read.holder, at("holder"), ["agent", "person"]) };
    }
    case "open": {
      const read = fields(value, path, ["id", "type", "url"]);
      const url = text(read.url, at("url"), MAX_URL_LENGTH);
      const problem = urlProblem(url);
      if (problem) refuse(at("url"), `is not a link to open: ${problem}`);
      return { id: requestId(read.id, at("id")), type, url };
    }
    case "record": {
      const to = oneOf((value as Fields | null)?.to, at("to"), ["start", "caption", "stop"]);
      if (to === "start") {
        const read = fields(value, path, ["id", "type", "to", "position"]);
        const id = requestId(read.id, at("id"));
        return read.position === undefined ? { id, type, to } : { id, type, to, position: oneOf(read.position, at("position"), ["top", "bottom"]) };
      }
      if (to === "caption") {
        const read = fields(value, path, ["id", "type", "to", "kind", "text"]);
        return { id: requestId(read.id, at("id")), type, to, kind: oneOf(read.kind, at("kind"), ["step", "pass", "fail"]), text: text(read.text, at("text"), MAX_CAPTION) };
      }
      return { id: requestId(fields(value, path, ["id", "type", "to"]).id, at("id")), type, to };
    }
    case "launch": {
      const read = fields(value, path, ["id", "type", "app"]);
      return { id: requestId(read.id, at("id")), type, app: text(read.app, at("app"), MAX_APP_LENGTH) };
    }
    case "at": {
      const read = fields(value, path, ["id", "type", "x", "y"]);
      return { id: requestId(read.id, at("id")), type, x: number(read.x, at("x"), 0, 16384), y: number(read.y, at("y"), 0, 16384) };
    }
    case "settle": {
      const read = fields(value, path, ["id", "type", "quietMs", "mostMs", "fromNow"]);
      return { id: requestId(read.id, at("id")), type, quietMs: whole(read.quietMs, at("quietMs"), 0, SETTLE_MOST_MS), mostMs: whole(read.mostMs, at("mostMs"), 0, SETTLE_MOST_MS), fromNow: bool(read.fromNow, at("fromNow")) };
    }
    case "screenshot": {
      const read = fields(value, path, ["id", "type", "longestEdge"]);
      const id = requestId(read.id, at("id"));
      return read.longestEdge === undefined ? { id, type } : { id, type, longestEdge: whole(read.longestEdge, at("longestEdge"), SCREENSHOT_EDGE_LEAST, 16384) };
    }
    case "cap": {
      const read = fields(value, path, ["id", "type", "most", "words"]);
      const most = read.most === null ? null : oneOf(read.most, at("most"), VIDEO_STEPS);
      if (read.words === undefined) return { id: requestId(read.id, at("id")), type, most };
      return { id: requestId(read.id, at("id")), type, most, words: textOrNull(read.words, at("words")) };
    }
    case "tree":
    case "clipboard":
    case "settings":
    case "result":
      return { id: requestId(fields(value, path, ["id", "type"]).id, at("id")), type };
  }
}

function deviceError(value: unknown, path: string): DeviceError {
  const read = fields(value, path, ["code", "words"]);
  return { code: oneOf(read.code, `${path}.code`, DEVICE_ERROR_CODES), words: text(read.words, `${path}.words`, 2000) };
}

function answerResult(value: unknown, path: string): AnswerResult {
  const type = oneOf((value as Fields | null)?.type, `${path}.type`, ["done", "screenshot", "tree", "clipboard", "at", "launched", "settled", "recording"]);
  switch (type) {
    case "done":
      fields(value, path, ["type"]);
      return { type };
    case "screenshot": {
      const read = fields(value, path, ["type", "png", "generation", "source"]);
      const shot = { type, png: base64(read.png, `${path}.png`), generation: whole(read.generation, `${path}.generation`) };
      if (read.source === undefined) return shot;
      const source = fields(read.source, `${path}.source`, ["width", "height"]);
      return { ...shot, source: { width: whole(source.width, `${path}.source.width`, 1, 16384), height: whole(source.height, `${path}.source.height`, 1, 16384) } };
    }
    case "at": {
      const read = fields(value, path, ["type", "element", "generation"]);
      return { type, element: read.element === null ? null : element(read.element, `${path}.element`, 1, { seen: 0 }), generation: whole(read.generation, `${path}.generation`) };
    }
    case "launched": {
      const app = fields(fields(value, path, ["type", "app"]).app, `${path}.app`, ["id", "name"]);
      return { type, app: { id: text(app.id, `${path}.app.id`, MAX_APP_LENGTH), name: anyText(app.name, `${path}.app.name`) } };
    }
    case "settled": {
      const read = fields(value, path, ["type", "frames", "quiet"]);
      return { type, frames: whole(read.frames, `${path}.frames`), quiet: bool(read.quiet, `${path}.quiet`) };
    }
    case "tree": {
      const read = fields(value, path, ["type", "elements", "generation"]);
      return { type, elements: elements(read.elements, `${path}.elements`), generation: whole(read.generation, `${path}.generation`) };
    }
    case "clipboard": {
      const read = fields(value, path, ["type", "text"]);
      if (typeof read.text !== "string") refuse(`${path}.text`, `must be text, not ${shown(read.text)}.`);
      if (read.text.length > DEVICE_CLIPBOARD_MOST) refuse(`${path}.text`, `is longer than ${DEVICE_CLIPBOARD_MOST} characters.`);
      return { type, text: read.text };
    }
    case "recording":
      return { type, recording: recordingSummary(fields(value, path, ["type", "recording"]).recording, `${path}.recording`) };
  }
}

function recordingSummary(value: unknown, path: string): RecordingSummary {
  const read = fields(value, path, ["active", "ended", "seconds", "segments", "lost"]);
  return {
    active: bool(read.active, `${path}.active`),
    ended: read.ended === null ? null : oneOf(read.ended, `${path}.ended`, ["stopped", "limit", "box-stopped"]),
    seconds: number(read.seconds, `${path}.seconds`),
    segments: whole(read.segments, `${path}.segments`),
    lost: list(read.lost, `${path}.lost`, (item, at) => text(item, at, 200), 1000),
  };
}

function answer(value: unknown, path: string): DeviceAnswer {
  const ok = bool((value as Fields | null)?.ok, `${path}.ok`);
  if (ok) {
    const read = fields(value, path, ["id", "ok", "ms", "state", "result"]);
    return { id: requestId(read.id, `${path}.id`), ok, ms: number(read.ms, `${path}.ms`), state: deviceState(read.state, `${path}.state`), result: answerResult(read.result, `${path}.result`) };
  }
  const read = fields(value, path, ["id", "ok", "error", "state"]);
  return { id: requestId(read.id, `${path}.id`), ok, error: deviceError(read.error, `${path}.error`), state: read.state === null ? null : deviceState(read.state, `${path}.state`) };
}

function hello(value: unknown, path: string): DeviceHello {
  const read = fields(value, path, ["protocol", "version", "platform", "devices", "state", "lease", "bootedHere"]);
  const platform = platformOf(read.platform, `${path}.platform`);
  const devices = offeredDevices(read.devices, `${path}.devices`);
  if (devices[0].runtime.platform !== platform) refuse(`${path}.devices`, `are ${platformWord(devices[0].runtime.platform)} devices, from an ${platformWord(platform)} server.`);
  const state = deviceState(read.state, `${path}.state`);
  if (state.platform !== platform) refuse(`${path}.state`, `is an ${platformWord(state.platform)} device's, from an ${platformWord(platform)} server.`);
  if (!devices.some((device) => device.model === state.model)) refuse(`${path}.state.model`, `is the ${state.model}, which the box's devices do not include.`);
  const said = { protocol: whole(read.protocol, `${path}.protocol`, 1), version: whole(read.version, `${path}.version`, 1), platform, devices, state, lease: bool(read.lease, `${path}.lease`) };
  if (read.bootedHere === undefined) return said as DeviceHello;
  const bootedHere = list(read.bootedHere, `${path}.bootedHere`, (item, at) => modelOf(item, at, platform));
  return { ...said, bootedHere } as DeviceHello;
}

const SERVER_VERBS: readonly DeviceServerVerb[] = ["BB_DEVICE_HELLO", "BB_DEVICE_STATE", "BB_DEVICE_TOUCH", "BB_DEVICE_STILL", "BB_DEVICE_ANSWER", "BB_DEVICE_VIDEO"];
const VIDEO_WANTS_MOST = 64;
const VIDEO_FPS_MOST = 1_000;
const VIDEO_CORES_MOST = 64;

function videoWant(value: unknown, path: string): VideoWant {
  const read = fields(value, path, ["for", "step"]);
  return { for: oneOf(read.for, `${path}.for`, ["viewer", "recording", "wait"]), step: oneOf(read.step, `${path}.step`, VIDEO_STEPS) };
}

function videoEncoding(value: unknown, path: string): VideoEncoding {
  const read = fields(value, path, ["way", "encoder", "cores"]);
  return {
    way: oneOf(read.way, `${path}.way`, ["hardware", "software"]),
    encoder: textOrNull(read.encoder, `${path}.encoder`),
    cores: read.cores === null ? null : number(read.cores, `${path}.cores`, 0, VIDEO_CORES_MOST),
  };
}

function videoReport(value: unknown, path: string): VideoReport {
  const read = fields(value, path, ["step", "wants", "cap", "fps", "words", "encoding"]);
  return {
    step: read.step === null ? null : oneOf(read.step, `${path}.step`, VIDEO_STEPS),
    wants: list(read.wants, `${path}.wants`, videoWant, VIDEO_WANTS_MOST),
    cap: read.cap === null ? null : oneOf(read.cap, `${path}.cap`, VIDEO_STEPS),
    fps: number(read.fps, `${path}.fps`, 0, VIDEO_FPS_MOST),
    words: textOrNull(read.words, `${path}.words`),
    ...(read.encoding === undefined ? {} : { encoding: videoEncoding(read.encoding, `${path}.encoding`) }),
  };
}

function serverMessage(verb: DeviceServerVerb, body: unknown): DeviceServerMessage {
  switch (verb) {
    case "BB_DEVICE_HELLO":
      return { verb, hello: hello(body, verb) };
    case "BB_DEVICE_STATE":
      return { verb, state: deviceState(fields(body, verb, ["state"]).state, `${verb}.state`) };
    case "BB_DEVICE_TOUCH": {
      const read = fields(body, verb, ["contacts", "by", "generation"]);
      return { verb, contacts: contacts(read.contacts, `${verb}.contacts`), by: oneOf(read.by, `${verb}.by`, ["agent", "person"]), generation: whole(read.generation, `${verb}.generation`) };
    }
    case "BB_DEVICE_STILL": {
      const read = fields(body, verb, ["png", "generation"]);
      return { verb, png: base64(read.png, `${verb}.png`), generation: whole(read.generation, `${verb}.generation`) };
    }
    case "BB_DEVICE_ANSWER":
      return { verb, answer: answer(body, verb) };
    case "BB_DEVICE_VIDEO":
      return { verb, video: videoReport(fields(body, verb, ["video"]).video, `${verb}.video`) };
  }
}

function splitMessage(message: string): { readonly verb: string; readonly body: unknown } {
  const space = message.indexOf(" ");
  if (space < 1) refuse("The message", "has no verb and JSON value.");
  const verb = message.slice(0, space);
  try {
    return { verb, body: JSON.parse(message.slice(space + 1)) };
  } catch {
    refuse(verb, "is not followed by JSON.");
  }
}

export function parseOfferedDevices(value: unknown): Parsed<OfferedDevices> {
  return parsing(() => offeredDevices(value, "devices"));
}

export function parseDeviceOffer(value: unknown): Parsed<DeviceOffer> {
  return parsing(() => deviceOffer(value, "device"));
}

export function parseBoxDevice(value: unknown): Parsed<BoxDevice> {
  return parsing(() => boxDevice(value, "device"));
}

export function parseDeviceState(value: unknown): Parsed<DeviceState> {
  return parsing(() => deviceState(value, "state"));
}

export function parseIntent(value: unknown, platform: DevicePlatform): Parsed<Intent> {
  return parsing(() => intent(value, "intent", platform));
}

export function parseDeviceControl(value: unknown): Parsed<DeviceControl> {
  return parsing(() => control(value, "control"));
}

export function parseDeviceInput(value: unknown): Parsed<DeviceInput> {
  return parsing(() => input(value, "input"));
}

export function parseDeviceElements(value: unknown): Parsed<readonly DeviceElement[]> {
  return parsing(() => elements(value, "elements"));
}

export function parseDeviceRequest(message: string): Parsed<DeviceRequest> {
  return parsing(() => {
    const { verb, body } = splitMessage(message);
    if (verb !== DEVICE_REQUEST_VERB) refuse(verb, `is not ${DEVICE_REQUEST_VERB}.`);
    return request(body, verb);
  });
}

export function parseDeviceServerMessage(message: string): Parsed<DeviceServerMessage> {
  return parsing(() => {
    const { verb, body } = splitMessage(message);
    const known = SERVER_VERBS.find((each) => each === verb);
    if (!known) refuse(verb, `is not one of the device server's messages: ${SERVER_VERBS.join(", ")}.`);
    return serverMessage(known, body);
  });
}

export function deviceRequestText(request: DeviceRequest): string {
  return `${DEVICE_REQUEST_VERB} ${JSON.stringify(request)}`;
}

export function deviceServerMessageText(message: DeviceServerMessage): string {
  const { verb, ...body } = message;
  switch (message.verb) {
    case "BB_DEVICE_HELLO":
      return `${verb} ${JSON.stringify(message.hello)}`;
    case "BB_DEVICE_ANSWER":
      return `${verb} ${JSON.stringify(message.answer)}`;
    default:
      return `${verb} ${JSON.stringify(body)}`;
  }
}

export type ModelChoice = { readonly ok: true; readonly model: TableModel } | { readonly ok: false; readonly words: string };

export function chooseModel(name: string, platform: DevicePlatform): ModelChoice {
  const model = modelNamed(name, platform);
  if (model) return { ok: true, model };
  const elsewhere = modelNamed(name);
  const own = deviceModels(platform).map((each) => each.name).join(", ");
  return {
    ok: false,
    words: elsewhere
      ? `The ${elsewhere.name} is an ${platformWord(elsewhere.platform)} device, not an ${platformWord(platform)} one. The ${platformWord(platform)} devices are: ${own}.`
      : `There is no ${platformWord(platform)} device called "${name}". The ${platformWord(platform)} devices are: ${own}.`,
  };
}
