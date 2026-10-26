import { batteryWords, deviceStateWords, locationWords } from "./device-settings.ts";
import {
  ANDROID_FONT_SCALES,
  DEVICE_ACTIONS,
  IOS_CONTENT_SIZES,
  NETWORK_PRESETS,
  ORIENTATIONS,
  POSTURES,
  TEXT_SIZE_STEPS,
  actionSupport,
  listWords,
  modelNamed,
  orientationWord,
  supports,
  type DeviceAction,
  type DeviceAnswer,
  type DeviceControl,
  type DeviceError,
  type DeviceModel,
  type DeviceState,
  type ModelName,
} from "./device.ts";

export interface DeviceControlParameters {
  readonly action: string;
  readonly turn?: string;
  readonly to?: string | number;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly level?: number;
  readonly charging?: boolean;
  readonly paths?: readonly string[];
  readonly device?: string;
}

type ParameterName = Exclude<keyof DeviceControlParameters, "action">;

const PARAMETER_NAMES: readonly ParameterName[] = ["turn", "to", "latitude", "longitude", "level", "charging", "paths", "device"];

const ACTION_PARAMETERS: Readonly<Record<DeviceAction, readonly ParameterName[]>> = {
  home: [],
  back: [],
  recents: [],
  lock: [],
  wake: [],
  rotate: ["turn", "to"],
  posture: ["to"],
  appearance: ["to"],
  text_size: ["to"],
  location: ["latitude", "longitude"],
  status_bar: ["to"],
  battery: ["level", "charging"],
  network: ["to"],
  install: ["paths"],
  switch: ["device"],
  reboot: [],
};

function takesWords(action: DeviceAction, platform: DeviceModel["platform"]): string {
  switch (action) {
    case "rotate":
      return `rotate takes turn, left or right, or to, one of ${listWords(ORIENTATIONS, "or")}, not both.`;
    case "posture":
      return `posture takes to: ${listWords(POSTURES, "or")}.`;
    case "appearance":
      return "appearance takes to: light or dark.";
    case "text_size":
      return platform === "ios"
        ? `text_size on iOS takes to: larger, smaller, default or a content size: ${listWords(IOS_CONTENT_SIZES, "or")}.`
        : `text_size on Android takes to: larger, smaller, default or a font scale: ${listWords(ANDROID_FONT_SCALES.map(String), "or")}.`;
    case "location":
      return "location takes latitude and longitude, both, or neither to clear it.";
    case "status_bar":
      return "status_bar takes to: clean or live.";
    case "battery":
      return "battery takes level, a whole number from 0 to 100, and charging, true or false: both, or neither for the device's own.";
    case "network":
      return `network takes to: ${listWords(NETWORK_PRESETS, "or")}.`;
    case "install":
      return platform === "ios" ? "install takes paths: one .app folder built for the simulator, in the box." : "install takes paths: one .apk, or the split APKs of one app, in the box.";
    case "switch":
      return "switch takes device: a model from box_list.";
    default:
      return `${action} takes no other parameters.`;
  }
}

export type ParsedControl = { readonly ok: true; readonly control: DeviceControl } | { readonly ok: false; readonly error: DeviceError };

function badValue(action: DeviceAction, platform: DeviceModel["platform"], why = ""): ParsedControl {
  return { ok: false, error: { code: "bad-value", words: `${why ? `${why} ` : ""}${takesWords(action, platform)}` } };
}

function oneOf<T extends string | number>(values: readonly T[], value: unknown): T | null {
  return (values as readonly unknown[]).includes(value) ? (value as T) : null;
}

function isAction(action: string): action is DeviceAction {
  return (DEVICE_ACTIONS as readonly string[]).includes(action);
}

export function controlFromParameters(parameters: DeviceControlParameters, model: DeviceModel, offered: readonly ModelName[]): ParsedControl {
  const { action } = parameters;
  if (!isAction(action)) return { ok: false, error: { code: "bad-value", words: `box_device has no action ${action}. Its actions are: ${DEVICE_ACTIONS.join(", ")}.` } };
  const platform = model.platform;
  const available = actionSupport(model, action);
  if (!available.supported) return { ok: false, error: available.error };
  const given = PARAMETER_NAMES.filter((name) => parameters[name] !== undefined);
  const foreign = given.filter((name) => !ACTION_PARAMETERS[action].includes(name));
  if (foreign.length) return badValue(action, platform, `${action} does not take ${listWords(foreign)}.`);
  const control = build(action, parameters, model, offered);
  if (!control.ok) return control;
  const support = supports(model, control.control);
  return support.supported ? control : { ok: false, error: support.error };
}

function build(action: DeviceAction, parameters: DeviceControlParameters, model: DeviceModel, offered: readonly ModelName[]): ParsedControl {
  const platform = model.platform;
  const done = (control: DeviceControl): ParsedControl => ({ ok: true, control });
  switch (action) {
    case "home":
    case "back":
    case "recents":
    case "lock":
    case "wake":
    case "reboot":
      return done({ action });
    case "rotate": {
      if ((parameters.turn === undefined) === (parameters.to === undefined)) return badValue(action, platform);
      if (parameters.turn !== undefined) {
        const turn = oneOf(["left", "right"] as const, parameters.turn);
        return turn ? done({ action, turn }) : badValue(action, platform);
      }
      const to = oneOf(ORIENTATIONS, parameters.to);
      return to ? done({ action, to }) : badValue(action, platform);
    }
    case "posture": {
      const to = oneOf(POSTURES, parameters.to);
      return to ? done({ action, to }) : badValue(action, platform);
    }
    case "appearance": {
      const to = oneOf(["light", "dark"] as const, parameters.to);
      return to ? done({ action, to }) : badValue(action, platform);
    }
    case "text_size": {
      const raw = parameters.to;
      const step = oneOf(TEXT_SIZE_STEPS, raw);
      if (step) return done({ action, to: step });
      if (platform === "ios") {
        const size = oneOf(IOS_CONTENT_SIZES, raw);
        return size ? done({ action, to: size }) : badValue(action, platform);
      }
      const scale = oneOf(ANDROID_FONT_SCALES, typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw);
      return scale !== null ? done({ action, to: scale }) : badValue(action, platform);
    }
    case "location": {
      const { latitude, longitude } = parameters;
      if (latitude === undefined && longitude === undefined) return done({ action, to: null });
      if (latitude === undefined || longitude === undefined) return badValue(action, platform);
      return done({ action, to: { latitude, longitude } });
    }
    case "status_bar": {
      const to = oneOf(["clean", "live"] as const, parameters.to);
      return to ? done({ action, to }) : badValue(action, platform);
    }
    case "battery": {
      const { level, charging } = parameters;
      if (level === undefined && charging === undefined) return done({ action, to: null });
      if (level === undefined || charging === undefined) return badValue(action, platform);
      return done({ action, to: { level, charging } });
    }
    case "network": {
      const to = oneOf(NETWORK_PRESETS, parameters.to);
      return to ? done({ action, to }) : badValue(action, platform);
    }
    case "install": {
      const paths = parameters.paths ?? [];
      if (!paths.length || paths.some((path) => !path.trim())) return badValue(action, platform);
      return done({ action, paths: [paths[0]!, ...paths.slice(1)] });
    }
    case "switch": {
      const wanted = parameters.device;
      if (wanted === undefined) return badValue(action, platform);
      const found = modelNamed(wanted, platform);
      if (!found || !offered.includes(found.name)) {
        return { ok: false, error: { code: "unknown-device", words: `This box has no ${wanted.trim()}. Its devices are: ${listWords(offered)}.` } };
      }
      return done({ action, device: found.name });
    }
  }
}

const DOING: Readonly<Record<DeviceAction, { readonly doing: string; readonly whether: string }>> = {
  home: { doing: "pressing Home", whether: "Home was pressed" },
  back: { doing: "pressing Back", whether: "Back was pressed" },
  recents: { doing: "opening recent apps", whether: "they opened" },
  lock: { doing: "locking the device", whether: "it locked" },
  wake: { doing: "waking the device", whether: "it woke" },
  rotate: { doing: "turning the device", whether: "it turned" },
  posture: { doing: "folding the device", whether: "it folded" },
  appearance: { doing: "setting the appearance", whether: "it changed" },
  text_size: { doing: "setting the text size", whether: "it changed" },
  location: { doing: "setting the location", whether: "it changed" },
  status_bar: { doing: "setting the status bar", whether: "it changed" },
  battery: { doing: "setting the battery", whether: "it changed" },
  network: { doing: "setting the network", whether: "it changed" },
  install: { doing: "installing the app", whether: "it installed" },
  switch: { doing: "switching the device", whether: "it switched" },
  reboot: { doing: "rebooting the device", whether: "it rebooted" },
};

export function lostWords(action: DeviceAction, state: DeviceState | null): string {
  const words = DOING[action];
  const now = state ? ` It is now ${deviceStateWords(state)}.` : "";
  return `The connection to the box ended while ${words.doing}, so bb-box cannot tell whether ${words.whether}.${now} Read box_status before trying again.`;
}

export function doneWords(control: DeviceControl, model: string, platform: DeviceModel["platform"]): string {
  const the = `the ${model}`;
  switch (control.action) {
    case "home":
      return `Pressed Home on ${the}`;
    case "back":
      return `Pressed Back on ${the}`;
    case "recents":
      return `Opened ${the}'s recent apps`;
    case "lock":
      return `Locked ${the}`;
    case "wake":
      return `Woke ${the}`;
    case "rotate":
      return control.turn ? `Turned ${the} ${control.turn}` : `Turned ${the} to ${orientationWord(control.to)}`;
    case "posture":
      return `Set ${the}'s posture to ${control.to.replace("-", " ")}`;
    case "appearance":
      return `Set ${the} to ${control.to}`;
    case "text_size":
      return `Set ${the}'s text size to ${control.to}`;
    case "location":
      return control.to ? `Set ${the}'s location to ${locationWords(control.to)}` : `Cleared ${the}'s location`;
    case "status_bar":
      return control.to === "clean" ? `Made ${the}'s status bar clean` : `Made ${the}'s status bar live`;
    case "battery":
      return control.to
        ? `Set ${the}'s ${platform === "ios" ? "status bar to show its battery at" : "battery to"} ${batteryWords(control.to)}`
        : `Gave ${the} ${platform === "ios" ? "its status bar's live battery" : "its own battery"} back`;
    case "network":
      return `Set ${the}'s network to ${control.to}`;
    case "install":
      return `Installed ${control.paths.join(", ")} on ${the}`;
    case "switch":
      return `Switched the box to the ${control.device}`;
    case "reboot":
      return `Rebooted ${the}`;
  }
}

export function afterWords(control: DeviceControl, platform: DeviceModel["platform"]): string {
  if (platform !== "ios") return "";
  if (control.action === "status_bar" && control.to === "live") return " The status bar is live again, so the battery shows the Mac's.";
  if (control.action === "battery" && control.to) return " Only the status bar's picture changes: the device's battery API is unchanged.";
  if (control.action === "battery") return " The status bar's battery shows the Mac's again.";
  if (control.action === "location" && !control.to) return " Apps see no simulated location.";
  if (control.action === "status_bar") return " It shows 9:41, full signal and Wi-Fi, and a full battery unless battery set one.";
  return "";
}

export function answerText(control: DeviceControl, model: DeviceModel, answer: Extract<DeviceAnswer, { readonly ok: true }>): string {
  return `${doneWords(control, model.name, model.platform)} in ${(answer.ms / 1000).toFixed(1)} s.${afterWords(control, model.platform)} Now: ${deviceStateWords(answer.state)}.`;
}
