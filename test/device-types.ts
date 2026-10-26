import type { DeviceDisplayCapability, DisplayCapability } from "../src/backends/types.ts";
import type {
  AndroidModel,
  BoxDevice,
  DeviceAnswer,
  DeviceControl,
  DeviceHello,
  DeviceInput,
  DeviceOffer,
  DeviceState,
  FlatModel,
  FoldableModel,
  Intent,
  IosModel,
  IosSettings,
  AndroidSettings,
  OfferedDevice,
  OfferedDevices,
  Override,
  Power,
  Screen,
} from "../src/core/device.ts";

const screen: Screen = { pixels: { width: 1080, height: 2400 }, scale: 2.625, cornerRadius: 110, cutout: null };
const body = { bezel: 48, radius: 158, buttons: [] };
const unknown = { known: false, why: "not read yet" } as const;
const iosSettings: IosSettings = { appearance: unknown, textSize: unknown, location: { set: null, at: null }, statusBar: { set: null, at: null } };
const androidSettings: AndroidSettings = { appearance: unknown, fontScale: unknown, location: unknown, battery: unknown, network: unknown, statusBar: { set: null, at: null } };
const iosRuntime = { platform: "ios", os: "27.0", build: "24A434", xcode: "27A266a", companion: "1.7.7" } as const;
const androidRuntime = { platform: "android", api: 35, image: "google_apis", revision: 9, abi: "x86_64", emulator: "37.2.12.0", snapshot: null } as const;
const booted = { is: "booted", awake: true } as const;

export const legal = {
  phone: { name: "Phone", form: "phone", screen, body } satisfies FlatModel,
  foldable: { name: "Fold", form: "foldable", outer: screen, inner: screen, hinge: "vertical", postures: ["closed", "open"], body } satisfies FoldableModel,
  iosModel: { platform: "ios", name: "iPhone", form: "phone", screen, body } satisfies IosModel,
  androidFoldable: { platform: "android", name: "Fold", form: "foldable", outer: screen, inner: screen, hinge: "vertical", postures: ["open"], body } satisfies AndroidModel,
  offered: { model: "Pixel 8", native: "pixel_8", runtime: androidRuntime } satisfies OfferedDevice,
  offer: { platform: "ios", devices: [{ model: "iPhone 18 Pro", native: "x", runtime: iosRuntime }] } satisfies DeviceOffer,
  iosState: { platform: "ios", model: "iPhone 17", power: booted, geometry: null, settings: iosSettings, at: 0 } satisfies DeviceState,
  phoneState: { platform: "android", form: "phone", model: "Pixel 8", power: booted, geometry: null, settings: androidSettings, at: 0 } satisfies DeviceState,
  foldState: {
    platform: "android",
    form: "foldable",
    model: "Pixel Fold",
    power: booted,
    geometry: { generation: 1, physical: "upright", content: "upright", video: { width: 1080, height: 2092 }, screen: "outer" },
    posture: { known: true, value: "closed", at: 0, by: "bb-box" },
    settings: androidSettings,
    at: 0,
  } satisfies DeviceState,
  rotateTurn: { action: "rotate", turn: "left" } satisfies DeviceControl,
  rotateTo: { action: "rotate", to: "turned-right" } satisfies DeviceControl,
  deviceDisplay: { id: "device", shows: "device", protocol: "selkies", resizable: false } satisfies DisplayCapability,
  desktopDisplay: { id: "desktop", protocol: "rfb", resizable: true } satisfies DisplayCapability,
};

export const illegal = {
  // @ts-expect-error
  flatWithTwoScreens: { name: "Phone", form: "phone", screen, outer: screen, body } satisfies FlatModel,
  // @ts-expect-error
  foldableWithOneScreen: { name: "Fold", form: "foldable", screen, outer: screen, inner: screen, hinge: "vertical", postures: ["open"], body } satisfies FoldableModel,
  // @ts-expect-error
  foldableWithNoPosture: { name: "Fold", form: "foldable", outer: screen, inner: screen, hinge: "vertical", postures: [], body } satisfies FoldableModel,
  // @ts-expect-error
  iosFoldable: { platform: "ios", name: "iPhone Fold", form: "foldable", outer: screen, inner: screen, hinge: "vertical", postures: ["open"], body } satisfies IosModel,
  // @ts-expect-error
  unknownModel: { model: "Pixel 99", native: "x", runtime: androidRuntime } satisfies OfferedDevice,
  // @ts-expect-error
  iosModelAndroidRuntime: { model: "iPhone 18 Pro", native: "x", runtime: androidRuntime } satisfies OfferedDevice,
  // @ts-expect-error
  mixedDevices: [{ model: "iPhone 18 Pro", native: "x", runtime: iosRuntime }, { model: "Pixel 8", native: "y", runtime: androidRuntime }] satisfies OfferedDevices,
  // @ts-expect-error
  emptyOffer: { platform: "android", devices: [] } satisfies DeviceOffer,
  // @ts-expect-error
  offerOfOtherPlatform: { platform: "ios", devices: [{ model: "Pixel 8", native: "x", runtime: androidRuntime }] } satisfies DeviceOffer,
  // @ts-expect-error
  boxDeviceMismatch: { platform: "android", model: "Pixel 8", runtime: iosRuntime } satisfies BoxDevice,
  // @ts-expect-error
  iosPosture: { platform: "ios", model: "iPhone 17", power: booted, geometry: null, posture: unknown, settings: iosSettings, at: 0 } satisfies DeviceState,
  // @ts-expect-error
  phonePosture: { platform: "android", form: "phone", model: "Pixel 8", power: booted, geometry: null, posture: unknown, settings: androidSettings, at: 0 } satisfies DeviceState,
  // @ts-expect-error
  foldableWithoutPosture: { platform: "android", form: "foldable", model: "Pixel Fold", power: booted, geometry: null, settings: androidSettings, at: 0 } satisfies DeviceState,
  // @ts-expect-error
  phoneAsFoldable: { platform: "android", form: "foldable", model: "Pixel 8", power: booted, geometry: null, posture: unknown, settings: androidSettings, at: 0 } satisfies DeviceState,
  // @ts-expect-error
  tabletAsPhone: { platform: "android", form: "phone", model: "Pixel Tablet", power: booted, geometry: null, settings: androidSettings, at: 0 } satisfies DeviceState,
  // @ts-expect-error
  iosStateAndroidModel: { platform: "ios", model: "Pixel 8", power: booted, geometry: null, settings: iosSettings, at: 0 } satisfies DeviceState,
  // @ts-expect-error
  flatGeometryScreen: { platform: "android", form: "phone", model: "Pixel 8", power: booted, geometry: { generation: 1, physical: "upright", content: "upright", video: { width: 1, height: 1 }, screen: "outer" }, settings: androidSettings, at: 0 } satisfies DeviceState,
  // @ts-expect-error
  foldGeometryWithoutScreen: { platform: "android", form: "foldable", model: "Pixel Fold", power: booted, geometry: { generation: 1, physical: "upright", content: "upright", video: { width: 1, height: 1 } }, posture: unknown, settings: androidSettings, at: 0 } satisfies DeviceState,
  // @ts-expect-error
  iosNetwork: { ...iosSettings, network: unknown } satisfies IosSettings,
  // @ts-expect-error
  iosBattery: { ...iosSettings, battery: unknown } satisfies IosSettings,
  // @ts-expect-error
  iosFontScale: { ...iosSettings, textSize: { known: true, value: 1.3, at: 0, by: "bb-box" } } satisfies IosSettings,
  // @ts-expect-error
  androidOddFontScale: { ...androidSettings, fontScale: { known: true, value: 1.2, at: 0, by: "bb-box" } } satisfies AndroidSettings,
  // @ts-expect-error
  bootedWithError: { is: "booted", awake: true, error: { code: "boot-failed", words: "x" } } satisfies Power,
  // @ts-expect-error
  failedWithoutError: { is: "failed", since: 0 } satisfies Power,
  // @ts-expect-error
  iosEmulatorFailed: { is: "failed", error: { code: "emulator-failed", words: "x" }, since: 0 } satisfies Power<"ios">,
  // @ts-expect-error
  bootedWithoutAwake: { is: "booted" } satisfies Power,
  // @ts-expect-error
  iosSwitchToPixel: { is: "switching", to: "Pixel 8", step: "booting", since: 0 } satisfies Power<"ios">,
  // @ts-expect-error
  overrideWithoutTime: { set: { latitude: 1, longitude: 2 }, at: null } satisfies Override<{ latitude: number; longitude: number }>,
  // @ts-expect-error
  observedKnownWithoutValue: { ...iosSettings, appearance: { known: true, at: 0, by: "bb-box" } } satisfies IosSettings,
  // @ts-expect-error
  intentAcrossPlatforms: { target: "iPhone 18 Pro", switching: { id: "a", from: "Pixel 8", step: "booting", since: 0 } } satisfies Intent,
  // @ts-expect-error
  rotateBoth: { action: "rotate", turn: "left", to: "upright" } satisfies DeviceControl,
  // @ts-expect-error
  rotateLandscape: { action: "rotate", to: "landscape" } satisfies DeviceControl,
  // @ts-expect-error
  postureTent: { action: "posture", to: "tent" } satisfies DeviceControl,
  // @ts-expect-error
  installNothing: { action: "install", paths: [] } satisfies DeviceControl,
  // @ts-expect-error
  switchUnknown: { action: "switch", device: "Pixel 99" } satisfies DeviceControl,
  // @ts-expect-error
  tapWithoutGeneration: { type: "tap", at: { x: 1, y: 2 } } satisfies DeviceInput,
  helloAcrossPlatforms: {
    protocol: 1,
    version: 1,
    platform: "ios",
    devices: [{ model: "iPhone 18 Pro", native: "x", runtime: iosRuntime }],
    // @ts-expect-error
    state: { platform: "android", form: "phone", model: "Pixel 8", power: booted, geometry: null, settings: androidSettings, at: 0 },
    lease: true,
  } satisfies DeviceHello,
  // @ts-expect-error
  refusalWithResult: { id: "a", ok: false, result: { type: "done" }, state: null } satisfies DeviceAnswer,
  // @ts-expect-error
  resizableDevice: { id: "device", shows: "device", protocol: "selkies", resizable: true } satisfies DeviceDisplayCapability,
  // @ts-expect-error
  rfbDevice: { id: "device", shows: "device", protocol: "rfb", resizable: false } satisfies DisplayCapability,
  // @ts-expect-error
  deviceNamedDesktop: { id: "desktop", shows: "device", protocol: "selkies", resizable: false } satisfies DeviceDisplayCapability,
  // @ts-expect-error
  deviceByChoice: { id: "device", shows: "device", protocol: "selkies", resizable: false, byChoice: true } satisfies DisplayCapability,
};
