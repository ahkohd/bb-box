import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseImageRecord } from "../src/backends/images.ts";
import { DEVICE_MODELS } from "../src/core/device-models.ts";
import {
  ANDROID_FONT_SCALES,
  DEVICE_ACTIONS,
  IOS_CONTENT_SIZES,
  actionsOf,
  deviceModel,
  deviceModels,
  modelNamed,
  screensOf,
  supports,
  type DeviceAction,
  type DeviceControl,
  type DeviceModel,
  type DeviceRequest,
  type DeviceServerMessage,
  type DeviceState,
  type ModelName,
} from "../src/core/device.ts";
import {
  chooseModel,
  deviceRequestText,
  deviceServerMessageText,
  parseBoxDevice,
  parseDeviceControl,
  parseDeviceElements,
  parseDeviceInput,
  parseDeviceOffer,
  parseDeviceRequest,
  parseDeviceServerMessage,
  parseDeviceState,
  parseIntent,
  parseOfferedDevices,
  type Parsed,
} from "../src/core/device-parse.ts";

const IOS_RUNTIME = { platform: "ios", os: "27.0", build: "24A434", xcode: "27A266a", companion: "1.7.7" } as const;
const ANDROID_RUNTIME = { platform: "android", api: 35, image: "google_apis", revision: 9, abi: "x86_64", emulator: "37.2.12.0", snapshot: { emulator: "37.2.12.0", cpu: "AMD EPYC 7763", made: "build.20261026-020000-ab12" } } as const;
const UNKNOWN = { known: false, why: "not read yet" } as const;
const SEEN_LIGHT = { known: true, value: "light", at: 1, by: "bb-box" } as const;
const IOS_SETTINGS = { appearance: SEEN_LIGHT, textSize: { known: true, value: "large", at: 1, by: "outside" }, location: { set: { latitude: 51.5, longitude: -0.12 }, at: 2 }, statusBar: { set: null, at: null } };
const ANDROID_SETTINGS = { appearance: SEEN_LIGHT, fontScale: { known: true, value: 1.3, at: 1, by: "bb-box" }, location: { known: true, value: null, at: 1, by: "bb-box" }, battery: UNKNOWN, network: { known: true, value: "slow", at: 1, by: "bb-box" }, statusBar: { set: "clean", at: 3 } };
const GEOMETRY = { generation: 3, physical: "turned-left", content: "upright", video: { width: 2622, height: 1206 } };

const iosState = { platform: "ios", model: "iPhone 18 Pro", power: { is: "booted", awake: true }, geometry: GEOMETRY, settings: IOS_SETTINGS, at: 5 };
const phoneState = { platform: "android", form: "phone", model: "Pixel 8", power: { is: "switching", to: "Pixel Fold", step: "booting", since: 4 }, geometry: null, settings: ANDROID_SETTINGS, at: 5 };
const foldState = {
  platform: "android",
  form: "foldable",
  model: "Pixel Fold",
  power: { is: "failed", error: { code: "emulator-failed", words: "The emulator exited." }, since: 9 },
  geometry: { ...GEOMETRY, video: { width: 2208, height: 1840 }, screen: "inner" },
  posture: { known: true, value: "half-open", at: 1, by: "outside" },
  settings: ANDROID_SETTINGS,
  at: 5,
};

function value<T>(parsed: Parsed<T>): T {
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.words);
  return parsed.value;
}

function refusal<T>(parsed: Parsed<T>, words: RegExp): void {
  assert.equal(parsed.ok, false, "refused");
  if (!parsed.ok) assert.match(parsed.words, words);
}

const withChange = (base: object, path: readonly string[], change: unknown): unknown => {
  if (!path.length) return change;
  const [key, ...rest] = path;
  const record = base as Record<string, object>;
  const next = { ...record, [key!]: withChange(record[key!] ?? {}, rest, change) };
  if (change === undefined && !rest.length) delete (next as Record<string, unknown>)[key!];
  return next;
};

describe("the model table", () => {
  test("names each model once, with each platform's default first", () => {
    const names = DEVICE_MODELS.map((model) => model.name);
    assert.equal(new Set(names).size, names.length);
    assert.equal(deviceModels("ios")[0]!.name, "iPhone 18 Pro");
    assert.equal(deviceModels("android")[0]!.name, "Pixel 8");
    assert.deepEqual(deviceModels("ios").map((model) => model.name), ["iPhone 18 Pro", "iPhone 17", "iPad Pro 13-inch (M5)"]);
    assert.deepEqual(deviceModels("android").map((model) => model.name), ["Pixel 8", "Pixel Fold", "Pixel Tablet"]);
  });

  test("has the pixels the research measured", () => {
    const pixels = (name: ModelName) => screensOf(deviceModel(name)).map((screen) => `${screen.pixels.width}x${screen.pixels.height}`);
    assert.deepEqual(pixels("iPhone 18 Pro"), ["1206x2622"]);
    assert.deepEqual(pixels("iPad Pro 13-inch (M5)"), ["2064x2752"]);
    assert.deepEqual(pixels("Pixel 8"), ["1080x2400"]);
    assert.deepEqual(pixels("Pixel Fold"), ["1080x2092", "2208x1840"]);
    assert.deepEqual(pixels("Pixel Tablet"), ["2560x1600"]);
    assert.equal(screensOf(deviceModel("iPhone 18 Pro"))[0].scale, 3);
    assert.equal(screensOf(deviceModel("Pixel 8"))[0].scale, 420 / 160);
  });

  test("draws every screen within its own pixels, and every button on its edge", () => {
    for (const model of DEVICE_MODELS as readonly DeviceModel[]) {
      for (const screen of screensOf(model)) {
        assert.ok(screen.pixels.width > 0 && screen.pixels.height > 0 && screen.scale > 0, model.name);
        assert.ok(screen.cornerRadius >= 0 && screen.cornerRadius * 2 <= Math.min(screen.pixels.width, screen.pixels.height), model.name);
        const cutout = screen.cutout;
        if (cutout) assert.ok(cutout.x >= 0 && cutout.y >= 0 && cutout.x + cutout.width <= screen.pixels.width && cutout.y + cutout.height <= screen.pixels.height, `${model.name}'s cutout`);
      }
      for (const button of model.body.buttons) assert.ok(button.from >= 0 && button.from < button.to && button.to <= 1, `${model.name}'s ${button.edge} button`);
      assert.ok(model.body.radius > 0 && model.body.bezel > 0, model.name);
    }
  });

  test("has foldables only on Android, each with closed and open", () => {
    for (const model of DEVICE_MODELS as readonly DeviceModel[]) {
      if (model.form !== "foldable") continue;
      assert.equal(model.platform, "android");
      assert.ok(model.postures.includes("closed") && model.postures.includes("open"), model.name);
    }
  });

  test("finds a model by its name, whatever its case", () => {
    assert.equal(modelNamed(" pixel fold ")?.name, "Pixel Fold");
    assert.equal(modelNamed("Pixel Fold", "ios"), null);
    assert.deepEqual(chooseModel("iphone 17", "ios"), { ok: true, model: deviceModel("iPhone 17") });
    assert.deepEqual(chooseModel("Pixel 8", "ios"), { ok: false, words: "The Pixel 8 is an Android device, not an iOS one. The iOS devices are: iPhone 18 Pro, iPhone 17, iPad Pro 13-inch (M5)." });
    assert.deepEqual(chooseModel("Pixel 9", "android"), { ok: false, words: 'There is no Android device called "Pixel 9". The Android devices are: Pixel 8, Pixel Fold, Pixel Tablet.' });
  });
});

describe("the devices an image offers", () => {
  const offered = [
    { model: "Pixel 8", native: "pixel_8", runtime: ANDROID_RUNTIME },
    { model: "Pixel Fold", native: "fold", runtime: { ...ANDROID_RUNTIME, snapshot: null } },
  ];

  test("read back as written", () => {
    assert.deepEqual(value(parseOfferedDevices(offered)), offered);
    assert.deepEqual(value(parseDeviceOffer({ platform: "android", devices: offered })), { platform: "android", devices: offered });
    assert.deepEqual(value(parseBoxDevice({ platform: "ios", model: "iPhone 17", runtime: IOS_RUNTIME })), { platform: "ios", model: "iPhone 17", runtime: IOS_RUNTIME });
  });

  test("are refused, in words, when they name no model, mix platforms, repeat or are empty", () => {
    refusal(parseOfferedDevices([]), /^devices must not be empty\.$/);
    refusal(parseOfferedDevices([{ ...offered[0], model: "Pixel 9" }]), /^devices\[0\]\.model names no Android device: "Pixel 9"\. The Android devices are: Pixel 8, Pixel Fold, Pixel Tablet\.$/);
    refusal(parseOfferedDevices([{ ...offered[0], model: "iPhone 17" }]), /names the iPhone 17, an iOS device, where an Android device belongs/);
    refusal(parseOfferedDevices([offered[0], { model: "iPhone 17", native: "x", runtime: IOS_RUNTIME }]), /mixes iOS and Android devices/);
    refusal(parseOfferedDevices([offered[0], offered[0]]), /lists the Pixel 8 twice/);
    refusal(parseOfferedDevices([{ ...offered[0], runtime: { ...ANDROID_RUNTIME, image: "google_apis_playstore" } }]), /devices\[0\]\.runtime\.image must be "google_apis"/);
    refusal(parseOfferedDevices([{ ...offered[0], extra: 1 }]), /devices\[0\] has "extra", which it does not take/);
    refusal(parseDeviceOffer({ platform: "ios", devices: offered }), /are Android devices, on an iOS offer/);
    refusal(parseBoxDevice({ platform: "android", model: "Pixel 8", runtime: IOS_RUNTIME }), /is iOS's, on an Android device/);
  });

  test("come from the image record, which is refused when they do not read", () => {
    const record = { contract: 1, kind: "android", build: "build.1", built: "2026-10-26T02:00:00Z" };
    assert.equal(parseImageRecord(record)?.devices, null);
    assert.deepEqual(parseImageRecord({ ...record, devices: offered })?.devices, offered);
    assert.equal(parseImageRecord({ ...record, devices: [{ ...offered[0], model: "Pixel 99" }] }), null);
  });
});

describe("a device's state", () => {
  test("reads back each arm as written", () => {
    for (const state of [iosState, phoneState, foldState]) assert.deepEqual(value(parseDeviceState(state)), state);
    const tablet = { ...phoneState, form: "tablet", model: "Pixel Tablet", power: { is: "stopped" } };
    assert.deepEqual(value(parseDeviceState(tablet)), tablet);
  });

  test("refuses a state the device cannot be in", () => {
    refusal(parseDeviceState({ ...phoneState, posture: UNKNOWN }), /^state has "posture", which it does not take/);
    refusal(parseDeviceState({ ...iosState, posture: UNKNOWN }), /^state has "posture", which it does not take/);
    refusal(parseDeviceState(withChange(foldState, ["posture"], undefined)), /^state\.posture\.known must be true or false, not missing/);
    refusal(parseDeviceState({ ...phoneState, model: "Pixel Fold" }), /^state\.form is phone, but the Pixel Fold is a foldable\.$/);
    refusal(parseDeviceState({ ...phoneState, form: "tablet" }), /^state\.form is tablet, but the Pixel 8 is a phone\.$/);
    refusal(parseDeviceState({ ...iosState, model: "Pixel 8" }), /an Android device, where an iOS device belongs/);
    refusal(parseDeviceState(withChange(foldState, ["geometry", "screen"], "outer")), /^state\.geometry\.screen is outer, but a Pixel Fold that is half-open shows its inner screen\.$/);
    refusal(parseDeviceState({ ...phoneState, geometry: { ...GEOMETRY, screen: "outer" } }), /^state\.geometry has "screen"/);
    refusal(parseDeviceState(withChange(foldState, ["geometry", "screen"], undefined)), /^state\.geometry\.screen must be "outer" or "inner", not missing/);
    refusal(parseDeviceState(withChange(foldState, ["posture", "value"], "tent")), /^state\.posture\.value must be "closed", "half-open" or "open", not "tent"/);
    refusal(parseDeviceState(withChange(phoneState, ["power", "to"], "Pixel 8")), /^state\.power\.to is the Pixel 8, which the box runs already\.$/);
    refusal(parseDeviceState({ ...iosState, power: { is: "failed", error: { code: "emulator-failed", words: "x" }, since: 1 } }), /^state\.power\.error\.code must be "boot-failed", "device-exited", "companion-failed" or "incompatible"/);
    refusal(parseDeviceState({ ...iosState, power: { is: "booted", awake: true, error: { code: "boot-failed", words: "x" } } }), /^state\.power has "error"/);
    refusal(parseDeviceState({ ...iosState, power: { is: "failed", since: 1 } }), /^state\.power\.error must be an object, not missing/);
    refusal(parseDeviceState({ ...iosState, settings: { ...IOS_SETTINGS, network: UNKNOWN } }), /^state\.settings has "network"/);
    refusal(parseDeviceState({ ...iosState, settings: { ...IOS_SETTINGS, textSize: { known: true, value: 1.3, at: 1, by: "bb-box" } } }), /^state\.settings\.textSize\.value must be "extra-small"/);
    refusal(parseDeviceState({ ...phoneState, settings: { ...ANDROID_SETTINGS, fontScale: { known: true, value: 1.2, at: 1, by: "bb-box" } } }), /^state\.settings\.fontScale\.value must be 0\.85, 1, 1\.15, 1\.3, 1\.5, 1\.8 or 2, not 1\.2/);
    refusal(parseDeviceState({ ...iosState, settings: { ...IOS_SETTINGS, location: { set: { latitude: 1, longitude: 2 }, at: null } } }), /^state\.settings\.location\.at must be a number/);
    refusal(parseDeviceState({ ...iosState, settings: { ...IOS_SETTINGS, appearance: { known: true, at: 1, by: "bb-box" } } }), /^state\.settings\.appearance\.value must be "light" or "dark", not missing/);
    refusal(parseDeviceState({ ...phoneState, settings: { ...ANDROID_SETTINGS, battery: { known: true, value: { level: 101, charging: true }, at: 1, by: "bb-box" } } }), /level must be a whole number from 0 to 100, not 101/);
    refusal(parseDeviceState({ ...iosState, geometry: { ...GEOMETRY, physical: "landscape" } }), /physical must be "upright", "turned-left", "upside-down" or "turned-right", not "landscape"/);
  });
});

describe("the intent file", () => {
  test("reads back a target, and a switch under way", () => {
    assert.deepEqual(value(parseIntent({ target: "Pixel 8", switching: null }, "android")), { target: "Pixel 8", switching: null });
    const switching = { target: "Pixel Fold", switching: { id: "req-7", from: "Pixel 8", step: "waiting", since: 3 } };
    assert.deepEqual(value(parseIntent(switching, "android")), switching);
  });

  test("refuses another platform's model, a switch to itself, and a step it does not know", () => {
    refusal(parseIntent({ target: "iPhone 17", switching: null }, "android"), /^intent\.target names the iPhone 17, an iOS device/);
    refusal(parseIntent({ target: "Pixel 8", switching: { id: "a", from: "Pixel 8", step: "booting", since: 1 } }, "android"), /^intent\.switching\.from is the Pixel 8, the switch's own target\.$/);
    refusal(parseIntent({ target: "Pixel 8", switching: { id: "a", from: "Pixel Fold", step: "rebooting", since: 1 } }, "android"), /step must be "stopping", "booting", "waiting" or "streaming"/);
    refusal(parseIntent({ target: "Pixel 8", switching: { id: "a b", from: "Pixel Fold", step: "booting", since: 1 } }, "android"), /switching\.id must be 1 to 64 letters/);
  });
});

describe("controls", () => {
  const controls: readonly DeviceControl[] = [
    { action: "home" },
    { action: "back" },
    { action: "recents" },
    { action: "lock" },
    { action: "wake" },
    { action: "rotate", turn: "left" },
    { action: "rotate", to: "upside-down" },
    { action: "posture", to: "half-open" },
    { action: "appearance", to: "dark" },
    { action: "text_size", to: "larger" },
    { action: "text_size", to: "accessibility-large" },
    { action: "text_size", to: 1.3 },
    { action: "location", to: { latitude: -33.86, longitude: 151.21 } },
    { action: "location", to: null },
    { action: "status_bar", to: "clean" },
    { action: "battery", to: { level: 20, charging: false } },
    { action: "battery", to: null },
    { action: "network", to: "offline" },
    { action: "install", paths: ["/tmp/a.apk", "/tmp/b.apk"] },
    { action: "switch", device: "Pixel Fold" },
    { action: "reboot" },
  ];

  test("read back as written, every action", () => {
    for (const control of controls) assert.deepEqual(value(parseDeviceControl(control)), control);
    assert.deepEqual([...new Set(controls.map((control) => control.action))].sort(), [...DEVICE_ACTIONS].sort());
  });

  test("are refused, in words, with a parameter of another action, both or neither of rotate's, or a value out of range", () => {
    refusal(parseDeviceControl({ action: "home", to: "dark" }), /^control has "to", which it does not take\. It takes "action"\.$/);
    refusal(parseDeviceControl({ action: "rotate", turn: "left", to: "upright" }), /^control takes "turn" or "to", one of them\.$/);
    refusal(parseDeviceControl({ action: "rotate" }), /^control takes "turn" or "to", one of them\.$/);
    refusal(parseDeviceControl({ action: "posture", to: "tent" }), /must be "closed", "half-open" or "open", not "tent"/);
    refusal(parseDeviceControl({ action: "text_size", to: 1.2 }), /must be 0\.85, 1, 1\.15, 1\.3, 1\.5, 1\.8 or 2, not 1\.2/);
    refusal(parseDeviceControl({ action: "location", to: { latitude: 91, longitude: 0 } }), /latitude must be a number from -90 to 90, not 91/);
    refusal(parseDeviceControl({ action: "battery", to: { level: 50 } }), /charging must be true or false, not missing/);
    refusal(parseDeviceControl({ action: "install", paths: [] }), /paths must not be empty/);
    refusal(parseDeviceControl({ action: "switch", device: "Pixel 99" }), /device names no device: "Pixel 99"/);
    refusal(parseDeviceControl({ action: "shake" }), /^control\.action must be "home", "back"/);
  });
});

describe("supports", () => {
  const platformOnly: Readonly<Partial<Record<DeviceAction, "ios" | "android" | "foldable">>> = { back: "android", recents: "android", posture: "foldable", network: "android", status_bar: "ios" };
  const sample: Readonly<Record<DeviceAction, DeviceControl>> = {
    home: { action: "home" },
    back: { action: "back" },
    recents: { action: "recents" },
    lock: { action: "lock" },
    wake: { action: "wake" },
    rotate: { action: "rotate", turn: "right" },
    posture: { action: "posture", to: "closed" },
    appearance: { action: "appearance", to: "light" },
    text_size: { action: "text_size", to: "default" },
    location: { action: "location", to: null },
    status_bar: { action: "status_bar", to: "live" },
    battery: { action: "battery", to: null },
    network: { action: "network", to: "online" },
    install: { action: "install", paths: ["/tmp/a"] },
    switch: { action: "switch", device: "Pixel 8" },
    reboot: { action: "reboot" },
  };

  test("takes on each model the actions its platform and form have, and refuses the rest as unsupported", () => {
    for (const model of DEVICE_MODELS as readonly DeviceModel[]) {
      for (const action of DEVICE_ACTIONS) {
        const only = platformOnly[action];
        const has = !only || (only === "foldable" ? model.form === "foldable" : model.platform === only);
        const support = supports(model, sample[action]);
        if (has) assert.ok(support.supported || support.error.code !== "unsupported", `${model.name} ${action}`);
        else assert.ok(!support.supported && support.error.code === "unsupported", `${model.name} refuses ${action}`);
      }
    }
    assert.deepEqual(actionsOf(deviceModel("iPhone 18 Pro")), ["home", "lock", "wake", "rotate", "appearance", "text_size", "location", "status_bar", "battery", "install", "switch", "reboot"]);
  });

  test("says why, in the decision's words", () => {
    const refused = (name: ModelName, control: DeviceControl) => {
      const support = supports(deviceModel(name), control);
      assert.ok(!support.supported, `${name} refuses ${control.action}`);
      return support.error;
    };
    assert.deepEqual(refused("iPhone 18 Pro", { action: "back" }), {
      code: "unsupported",
      words: "iOS has no back button. The iPhone 18 Pro's actions are: home, lock, wake, rotate, appearance, text_size, location, status_bar, battery, install, switch, reboot.",
    });
    assert.match(refused("Pixel 8", { action: "posture", to: "open" }).words, /^The Pixel 8 does not fold\. The Pixel Fold does\. /);
    assert.match(refused("iPad Pro 13-inch (M5)", { action: "posture", to: "open" }).words, /^No iOS device folds\. /);
    assert.deepEqual(refused("Pixel Tablet", { action: "text_size", to: "accessibility-large" }), {
      code: "bad-value",
      words: "text_size on Android takes larger, smaller, default or a font scale: 0.85, 1, 1.15, 1.3, 1.5, 1.8 or 2.",
    });
    assert.match(refused("iPhone 17", { action: "text_size", to: 1.3 }).words, /^text_size on iOS takes larger, smaller, default or a content size: extra-small, /);
    assert.equal(refused("iPhone 17", { action: "install", paths: ["/tmp/App.ipa"] }).words, "An .ipa is a build for a physical iPhone. Build for the simulator, for example xcodebuild -sdk iphonesimulator, and install the .app.");
    assert.equal(refused("Pixel 8", { action: "install", paths: ["/tmp/app.aab"] }).words, "Android App Bundles do not install directly. Make APKs with bundletool build-apks --mode=universal.");
    assert.equal(refused("iPhone 17", { action: "install", paths: ["/tmp/A.app", "/tmp/B.app"] }).code, "bad-value");
    assert.equal(refused("Pixel 8", { action: "battery", to: { level: 101, charging: true } }).code, "bad-value");
    assert.equal(refused("Pixel 8", { action: "location", to: { latitude: 0, longitude: 181 } }).code, "bad-value");
    assert.deepEqual(refused("Pixel 8", { action: "switch", device: "iPhone 17" }), {
      code: "unknown-device",
      words: "The iPhone 17 is not an Android device. Android's devices are: Pixel 8, Pixel Fold, Pixel Tablet.",
    });
  });

  test("takes each platform's own text size steps, and the shared ones on both", () => {
    for (const size of IOS_CONTENT_SIZES) assert.ok(supports(deviceModel("iPhone 17"), { action: "text_size", to: size }).supported);
    for (const scale of ANDROID_FONT_SCALES) assert.ok(supports(deviceModel("Pixel 8"), { action: "text_size", to: scale }).supported);
    for (const step of ["larger", "smaller", "default"] as const) {
      assert.ok(supports(deviceModel("iPhone 17"), { action: "text_size", to: step }).supported);
      assert.ok(supports(deviceModel("Pixel Fold"), { action: "text_size", to: step }).supported);
    }
    assert.ok(supports(deviceModel("iPhone 17"), { action: "install", paths: ["/Users/box/Build/App.app/"] }).supported);
    assert.ok(supports(deviceModel("Pixel Fold"), { action: "posture", to: "half-open" }).supported);
  });
});

describe("input and the tree", () => {
  test("read back as written", () => {
    const point = { x: 10.5, y: 20, generation: 2 };
    const inputs = [
      { type: "tap", at: point },
      { type: "long_press", at: point, ms: 1200 },
      { type: "swipe", from: point, to: { ...point, y: 900 }, ms: 300 },
      { type: "pinch", centre: point, from: 100, to: 300, ms: 400 },
      { type: "key", key: "Enter", modifiers: ["meta", "shift"] },
      { type: "text", text: "こんにちは, café" },
    ];
    for (const input of inputs) assert.deepEqual(value(parseDeviceInput(input)), input);
    const tree = [
      {
        role: "button",
        identifier: "com.example:id/ok",
        label: "OK",
        value: null,
        frame: { x: 0, y: 0, width: 100, height: 40 },
        enabled: true,
        focused: false,
        can: { tap: true, edit: false, scroll: false },
        children: [{ role: "static text", identifier: null, label: "", value: "OK", frame: { x: 1, y: 1, width: 10, height: 10 }, enabled: true, focused: false, can: null, children: [] }],
      },
    ];
    assert.deepEqual(value(parseDeviceElements(tree)), tree);
  });

  test("refuses points without a generation, repeated modifiers, empty text, and trees nested past the limit", () => {
    refusal(parseDeviceInput({ type: "tap", at: { x: 1, y: 2 } }), /^input\.at\.generation must be a whole number/);
    refusal(parseDeviceInput({ type: "key", key: "a", modifiers: ["shift", "shift"] }), /names a modifier twice/);
    refusal(parseDeviceInput({ type: "text", text: "" }), /^input\.text must be text/);
    refusal(parseDeviceInput({ type: "long_press", at: { x: 1, y: 2, generation: 0 }, ms: 0 }), /ms must be a whole number from 1 to 60000/);
    let deep: unknown = [];
    for (let level = 0; level < 70; level++) deep = [{ role: "group", identifier: null, label: "", value: null, frame: { x: 0, y: 0, width: 1, height: 1 }, enabled: true, focused: false, can: null, children: deep }];
    refusal(parseDeviceElements(deep), /is nested more than 64 deep/);
  });
});

describe("messages", () => {
  const requests: readonly DeviceRequest[] = [
    { id: "t1", type: "touch", contacts: [{ id: 0, x: 1, y: 2 }, { id: 1, x: 3, y: 4 }], generation: 1 },
    { id: "t2", type: "text", text: "日本語" },
    { id: "c1", type: "control", control: { action: "rotate", turn: "left" } },
    { id: "i1", type: "input", input: { type: "tap", at: { x: 1, y: 1, generation: 1 } }, owner: 4 },
    { id: "o1", type: "owner", generation: 5, holder: "person" },
    { id: "s1", type: "screenshot" },
    { id: "r1", type: "tree" },
    { id: "rec", type: "record", to: "start" },
    { id: "c1", type: "result" },
  ];

  test("each request goes as BB_DEVICE and its JSON, and reads back", () => {
    for (const request of requests) {
      const text = deviceRequestText(request);
      assert.ok(text.startsWith("BB_DEVICE {"));
      assert.deepEqual(value(parseDeviceRequest(text)), request);
    }
  });

  test("each server message goes as its verb and its JSON, and reads back", () => {
    const messages: readonly DeviceServerMessage[] = [
      {
        verb: "BB_DEVICE_HELLO",
        hello: { protocol: 1, version: 3, platform: "ios", devices: [{ model: "iPhone 18 Pro", native: "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro", runtime: IOS_RUNTIME }], state: iosState as DeviceState & { platform: "ios" }, lease: true },
      },
      { verb: "BB_DEVICE_STATE", state: foldState as DeviceState },
      { verb: "BB_DEVICE_TOUCH", contacts: [{ id: 0, x: 5, y: 6 }], by: "agent", generation: 2 },
      { verb: "BB_DEVICE_STILL", png: "iVBORw0KGgo=", generation: 2 },
      { verb: "BB_DEVICE_ANSWER", answer: { id: "s1", ok: true, ms: 22, state: iosState as DeviceState, result: { type: "screenshot", png: "iVBORw0KGgo=", generation: 3 } } },
      { verb: "BB_DEVICE_ANSWER", answer: { id: "c1", ok: true, ms: 300, state: iosState as DeviceState, result: { type: "done" } } },
      { verb: "BB_DEVICE_ANSWER", answer: { id: "c2", ok: false, error: { code: "outcome-unknown", words: "The connection ended while turning the device." }, state: phoneState as DeviceState } },
      { verb: "BB_DEVICE_ANSWER", answer: { id: "c3", ok: false, error: { code: "in-progress", words: "Still turning." }, state: null } },
    ];
    for (const message of messages) {
      const text = deviceServerMessageText(message);
      assert.ok(text.startsWith(`${message.verb} {`), text.slice(0, 40));
      assert.deepEqual(value(parseDeviceServerMessage(text)), message);
    }
  });

  test("are refused, in words, when malformed", () => {
    refusal(parseDeviceRequest("BB_DEVICE"), /has no verb and JSON value/);
    refusal(parseDeviceRequest("BB_DEVICE {nope"), /^BB_DEVICE is not followed by JSON\.$/);
    refusal(parseDeviceRequest('BB_CURSOR {"id":"a","type":"tree"}'), /^BB_CURSOR is not BB_DEVICE\.$/);
    refusal(parseDeviceRequest('BB_DEVICE {"id":"","type":"tree"}'), /^BB_DEVICE\.id must be 1 to 64 letters/);
    refusal(parseDeviceRequest('BB_DEVICE {"id":"a","type":"touch","contacts":[{"id":0,"x":1,"y":1},{"id":0,"x":2,"y":2}],"generation":1}'), /names a contact twice/);
    refusal(parseDeviceRequest('BB_DEVICE {"id":"a","type":"owner","generation":1,"holder":"viewer"}'), /holder must be "agent" or "person"/);
    refusal(parseDeviceServerMessage('BB_DEVICE_NOPE {}'), /^BB_DEVICE_NOPE is not one of the device server's messages/);
    refusal(parseDeviceServerMessage('BB_DEVICE_STILL {"png":"not base64!","generation":1}'), /png must be base64/);
    const hello = { protocol: 1, version: 1, platform: "android", devices: [{ model: "Pixel 8", native: "pixel_8", runtime: ANDROID_RUNTIME }], state: foldState, lease: false };
    refusal(parseDeviceServerMessage(`BB_DEVICE_HELLO ${JSON.stringify(hello)}`), /state\.model is the Pixel Fold, which the box's devices do not include/);
    refusal(parseDeviceServerMessage(`BB_DEVICE_HELLO ${JSON.stringify({ ...hello, platform: "ios" })}`), /are Android devices, from an iOS server/);
    refusal(parseDeviceServerMessage(`BB_DEVICE_ANSWER ${JSON.stringify({ id: "a", ok: false, result: { type: "done" }, state: null })}`), /has "result", which it does not take/);
  });
});
