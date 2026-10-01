// Kind IDs that were renamed (027). The default box has no qualifier, and
// only desktops say so: linux-headless became linux. The earlier IDs stay
// accepted wherever a kind ID comes in: box_acquire, stored records and the
// kind a guest names. What bb-box shows uses the current IDs.

import type { Arch, GuestOs } from "./types.ts";

const RENAMED: ReadonlyMap<string, string> = new Map([
  ["linux-headless", "linux"],
  ["linux-headless-docker", "linux-docker"],
]);

/** The current ID of a kind, given its current or an earlier ID. */
export function currentKindId(id: string): string {
  return RENAMED.get(id) ?? id;
}

/** True when `id` is an earlier ID of a kind that has a new one. */
export function isEarlierKindId(id: string): boolean {
  return RENAMED.has(id);
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
  /** The features every offer of it promises, such as "docker". */
  readonly features: readonly string[];
}

/** The kinds bb-box knows (027). A backend's own kind may describe itself more closely. */
export const KIND_INFO: Readonly<Record<string, KindInfo>> = {
  linux: { label: "Linux", description: "A Linux box for builds, backend services and the agent's own work.", gpu: false, desktop: false, os: "linux", arch: "x86_64", features: [] },
  "linux-docker": { label: "Linux with Docker", description: "A Linux box with Docker, for builds and services that need it.", gpu: false, desktop: false, os: "linux", arch: "x86_64", features: ["docker"] },
  "linux-desktop": { label: "Linux desktop", description: "A Linux desktop on a GPU, for computer use, browsers and app development.", gpu: true, desktop: true, os: "linux", arch: "x86_64", features: [] },
  "linux-desktop-cpu": { label: "Linux desktop", description: "A Linux desktop drawn by the CPU, for computer use and browsers.", gpu: false, desktop: true, os: "linux", arch: "x86_64", features: [] },
  macos: { label: "macOS", description: "A Mac for builds and Apple's tools.", gpu: false, desktop: false, os: "macos", arch: "arm64", features: [] },
  "macos-desktop": { label: "macOS desktop", description: "A macOS desktop for computer use and app development.", gpu: false, desktop: true, os: "macos", arch: "arm64", features: [] },
  "windows-desktop": { label: "Windows desktop", description: "A Windows desktop for computer use, browsers and Windows apps.", gpu: false, desktop: true, os: "windows", arch: "x86_64", features: [] },
};

export function kindInfo(id: string): KindInfo {
  return KIND_INFO[id] ?? { label: id, description: "", gpu: false, desktop: false, os: id.startsWith("macos") ? "macos" : id.startsWith("windows") ? "windows" : "linux", arch: id.startsWith("macos") || /-arm64\b/.test(id) ? "arm64" : "x86_64", features: /-docker\b/.test(id) ? ["docker"] : [] };
}
