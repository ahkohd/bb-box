import type { DeviceModel } from "./device.ts";

const IPHONE_BUTTONS = [
  { edge: "left", from: 0.17, to: 0.21 },
  { edge: "left", from: 0.25, to: 0.31 },
  { edge: "left", from: 0.33, to: 0.39 },
  { edge: "right", from: 0.27, to: 0.37 },
] as const;

const DYNAMIC_ISLAND_PRO = { x: 461, y: 42, width: 284, height: 110, shape: "pill" } as const;
const DYNAMIC_ISLAND = { x: 415, y: 42, width: 376, height: 110, shape: "pill" } as const;

export const DEVICE_MODELS = [
  {
    platform: "ios",
    name: "iPhone 18 Pro",
    form: "phone",
    screen: { pixels: { width: 1206, height: 2622 }, scale: 3, cornerRadius: 186, cutout: DYNAMIC_ISLAND_PRO },
    body: { bezel: 54, radius: 240, buttons: IPHONE_BUTTONS },
  },
  {
    platform: "ios",
    name: "iPhone 17",
    form: "phone",
    screen: { pixels: { width: 1206, height: 2622 }, scale: 3, cornerRadius: 186, cutout: DYNAMIC_ISLAND },
    body: { bezel: 60, radius: 246, buttons: IPHONE_BUTTONS },
  },
  {
    platform: "ios",
    name: "iPad Pro 13-inch (M5)",
    form: "tablet",
    screen: { pixels: { width: 2064, height: 2752 }, scale: 2, cornerRadius: 36, cutout: null },
    body: {
      bezel: 64,
      radius: 100,
      buttons: [
        { edge: "top", from: 0.82, to: 0.9 },
        { edge: "right", from: 0.06, to: 0.12 },
        { edge: "right", from: 0.13, to: 0.19 },
      ],
    },
  },
  {
    platform: "android",
    name: "Pixel 8",
    form: "phone",
    screen: { pixels: { width: 1080, height: 2400 }, scale: 2.625, cornerRadius: 110, cutout: null },
    body: {
      bezel: 48,
      radius: 158,
      buttons: [
        { edge: "right", from: 0.25, to: 0.31 },
        { edge: "right", from: 0.35, to: 0.47 },
      ],
    },
  },
  {
    platform: "android",
    name: "Pixel Fold",
    form: "foldable",
    outer: { pixels: { width: 1080, height: 2092 }, scale: 2.625, cornerRadius: 90, cutout: null },
    inner: { pixels: { width: 2208, height: 1840 }, scale: 2.625, cornerRadius: 60, cutout: null },
    hinge: "vertical",
    postures: ["closed", "half-open", "open"],
    body: {
      bezel: 56,
      radius: 120,
      buttons: [
        { edge: "right", from: 0.24, to: 0.32 },
        { edge: "right", from: 0.36, to: 0.48 },
      ],
    },
  },
  {
    platform: "android",
    name: "Pixel Tablet",
    form: "tablet",
    screen: { pixels: { width: 2560, height: 1600 }, scale: 2, cornerRadius: 48, cutout: null },
    body: {
      bezel: 120,
      radius: 150,
      buttons: [
        { edge: "top", from: 0.08, to: 0.14 },
        { edge: "top", from: 0.8, to: 0.9 },
      ],
    },
  },
] as const satisfies readonly DeviceModel[];

export type TableModel = (typeof DEVICE_MODELS)[number];

export type ModelName = TableModel["name"];
export type IosModelName = Extract<TableModel, { readonly platform: "ios" }>["name"];
export type AndroidModelName = Extract<TableModel, { readonly platform: "android" }>["name"];
export type AndroidModelNameOfForm<Form extends "phone" | "tablet" | "foldable"> = Extract<TableModel, { readonly platform: "android"; readonly form: Form }>["name"];
export type FoldableModelName = AndroidModelNameOfForm<"foldable">;
