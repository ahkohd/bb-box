// Kind IDs that were renamed (027). The default box has no qualifier, and
// only desktops say so: linux-headless became linux. The earlier IDs stay
// accepted wherever a kind ID comes in: box_acquire, stored records and the
// kind a guest names. What bb-box shows uses the current IDs.

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
}

/** The kinds bb-box knows (027). A backend's own kind may describe itself more closely. */
export const KIND_INFO: Readonly<Record<string, KindInfo>> = {
  linux: { label: "Linux", description: "A Linux box for builds, backend services and the agent's own work.", gpu: false, desktop: false },
  "linux-docker": { label: "Linux with Docker", description: "A Linux box with Docker, for builds and services that need it.", gpu: false, desktop: false },
  "linux-desktop": { label: "Linux desktop", description: "A Linux desktop on a GPU, for computer use, browsers and app development.", gpu: true, desktop: true },
  "linux-desktop-cpu": { label: "Linux desktop (no GPU)", description: "A Linux desktop without a GPU, for computer use and browsers.", gpu: false, desktop: true },
  macos: { label: "macOS", description: "A Mac for builds and Apple's tools.", gpu: false, desktop: false },
  "macos-desktop": { label: "macOS desktop", description: "A macOS desktop for computer use and app development.", gpu: false, desktop: true },
};

export function kindInfo(id: string): KindInfo {
  return KIND_INFO[id] ?? { label: id, description: "", gpu: false, desktop: false };
}
