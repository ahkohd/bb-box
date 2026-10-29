// Kind IDs that were renamed (027), and aliases (041). The default box has no
// qualifier, and only desktops say so: linux-headless became linux. An alias
// names a kind and the features its box must have: linux-docker is linux
// with Docker. Earlier IDs and aliases stay accepted wherever a kind ID comes
// in: box_acquire, the configuration, stored records and the kind a guest
// names. What bb-box shows uses the current IDs, and backends offer only kinds.

import type { DevicePlatform } from "../core/device.ts";
import type { Arch, GuestOs, Windowing } from "./types.ts";

const RENAMED: ReadonlyMap<string, string> = new Map([
  ["linux-headless", "linux"],
  ["linux-headless-docker", "linux-docker"],
]);

/** What an alias asks for (041). */
export interface KindAlias {
  readonly kind: string;
  readonly features: readonly string[];
}

const ALIASES: ReadonlyMap<string, KindAlias> = new Map([
  ["linux-docker", { kind: "linux", features: ["docker"] }],
  ["linux-arm64-docker", { kind: "linux-arm64", features: ["docker"] }],
  // A Linux VM, with its own kernel (057).
  ["linux-vm", { kind: "linux", features: ["kernel"] }],
  // A Linux VM that can run VMs of its own, through /dev/kvm (057).
  ["linux-kvm", { kind: "linux", features: ["kvm"] }],
]);

/** Features only a VM's offer has (057): its offers come after the others', unless the request asks for one. */
export const VM_FEATURES: readonly string[] = ["kernel", "kvm"];

/** Offers with VMs' after the others', each part in its order (057): the order acquire tries them in. */
export function vmOffersLast<T extends { readonly kind: { readonly capabilities: { readonly features: readonly string[] } } }>(offers: readonly T[]): T[] {
  const vm = (offer: T) => offer.kind.capabilities.features.some((feature) => VM_FEATURES.includes(feature));
  return [...offers.filter((offer) => !vm(offer)), ...offers.filter(vm)];
}

/** A kind, and the features a box of it must have, given a kind's current or earlier ID or an alias. */
export function kindRequest(id: string): KindAlias {
  const renamed = RENAMED.get(id) ?? id;
  return ALIASES.get(renamed) ?? { kind: renamed, features: [] };
}

/** The current ID of a kind, given its current or an earlier ID or an alias. */
export function currentKindId(id: string): string {
  return kindRequest(id).kind;
}

/** True when `id` is an earlier ID of a kind that has a new one, or an alias. */
export function isEarlierKindId(id: string): boolean {
  return RENAMED.has(id) || ALIASES.has(id);
}

/** The aliases, for agents: each with the kind and features it asks for. */
export function kindAliases(): readonly (KindAlias & { readonly id: string })[] {
  return [...ALIASES].map(([id, alias]) => ({ id, ...alias }));
}

/** How the panel and agents name a feature. */
export function featureWord(feature: string): string {
  return feature === "docker" ? "Docker" : feature === "kvm" ? "KVM" : feature;
}

/** What a kind is, in words, for the settings page, which lists kinds no backend offers now. */
export interface KindInfo {
  readonly label: string;
  readonly description: string;
  readonly gpu: boolean;
  readonly desktop: boolean;
  /** The OS, which the panel names the kind by. */
  readonly os: GuestOs;
  /** x86_64 unless the kind is arm64 (040). */
  readonly arch: Arch;
  /** The windowing system a desktop runs (048); x11 for every kind but the Wayland desktop, and for kinds without a desktop. */
  readonly windowing: Windowing;
  /** The features every offer of it promises. None for a Linux kind, whose offers may differ on Docker (041). */
  readonly features: readonly string[];
  readonly device: DevicePlatform | null;
}

/** The kinds bb-box knows (027). A backend's own kind may describe itself more closely. */
export const KIND_INFO: Readonly<Record<string, KindInfo>> = {
  linux: { label: "Linux", description: "A Linux box for builds, backend services and the agent's own work.", gpu: false, desktop: false, os: "linux", arch: "x86_64", windowing: "x11", features: [], device: null },
  "linux-desktop": { label: "Linux desktop", description: "A Linux desktop on a GPU, for computer use, browsers and app development.", gpu: true, desktop: true, os: "linux", arch: "x86_64", windowing: "x11", features: [], device: null },
  "linux-desktop-cpu": { label: "Linux desktop", description: "A Linux desktop drawn by the CPU, for computer use and browsers.", gpu: false, desktop: true, os: "linux", arch: "x86_64", windowing: "x11", features: [], device: null },
  // Sway, streamed by wayvnc, with Xwayland off (048).
  "linux-desktop-wayland-cpu": {
    label: "Linux desktop on Wayland",
    description: "A Linux desktop on Wayland (Sway), drawn by the CPU, for computer use, browsers and apps built for Wayland. X11-only apps do not run there.",
    gpu: false,
    desktop: true,
    os: "linux",
    arch: "x86_64",
    windowing: "wayland",
    features: [],
    device: null,
  },
  "linux-arm64": {
    label: "Linux on arm64",
    description: "A Linux box on arm64. amd64 container images and x86_64 binaries do not run there.",
    gpu: false,
    desktop: false,
    os: "linux",
    arch: "arm64",
    windowing: "x11",
    features: [],
    device: null,
  },
  "linux-arm64-desktop-cpu": {
    label: "Linux desktop on arm64",
    description: "A Linux desktop on arm64, drawn by the CPU. amd64 container images and x86_64 binaries do not run there.",
    gpu: false,
    desktop: true,
    os: "linux",
    arch: "arm64",
    windowing: "x11",
    features: [],
    device: null,
  },
  macos: { label: "macOS", description: "A Mac for builds and Apple's tools.", gpu: false, desktop: false, os: "macos", arch: "arm64", windowing: "x11", features: [], device: null },
  "macos-desktop": { label: "macOS desktop", description: "A macOS desktop for computer use and app development.", gpu: false, desktop: true, os: "macos", arch: "arm64", windowing: "x11", features: [], device: null },
  "windows-desktop": { label: "Windows desktop", description: "A Windows desktop for computer use, browsers and Windows apps.", gpu: false, desktop: true, os: "windows", arch: "x86_64", windowing: "x11", features: [], device: null },
  "windows-arm64-desktop": {
    label: "Windows desktop on arm64",
    description: "A Windows desktop on arm64, for computer use, browsers and Windows apps. x64 apps run under Windows' emulation, more slowly; x64 drivers do not.",
    gpu: false,
    desktop: true,
    os: "windows",
    arch: "arm64",
    windowing: "x11",
    features: [],
    device: null,
  },
  ios: {
    label: "iOS Simulator",
    description: "An iPhone or iPad in the iOS Simulator, for installing, running and testing iOS apps. It runs on a macOS VM, or in a slot on a shared Mac or VM, and is shared with a person in the panel.",
    gpu: false,
    desktop: false,
    os: "macos",
    arch: "arm64",
    windowing: "x11",
    features: [],
    device: "ios",
  },
  android: {
    label: "Android emulator",
    description: "A phone, foldable or tablet in the Android emulator, for installing, running and testing Android apps. It runs on a Linux VM, and is shared with a person in the panel.",
    gpu: false,
    desktop: false,
    os: "linux",
    arch: "x86_64",
    windowing: "x11",
    features: [],
    device: "android",
  },
};

export function kindInfo(id: string): KindInfo {
  return KIND_INFO[id] ?? { label: id, description: "", gpu: false, desktop: false, os: id.startsWith("macos") ? "macos" : id.startsWith("windows") ? "windows" : "linux", arch: id.startsWith("macos") || /-arm64\b/.test(id) ? "arm64" : "x86_64", windowing: "x11", features: [], device: null };
}
