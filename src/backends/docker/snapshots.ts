import { endOfUtcDay } from "../../core/snapshot.ts";
import { NO_PAUSE, type DoctorCheck, type MachineSize, type SnapshotSize, type Snapshotting, type TakePause } from "../types.ts";
import { LXCFS_TARGETS } from "./lxcfs.ts";
import { ENV_A_BOX_IS_GIVEN, IMAGE_HOLDS_FORKS, labelsOf } from "./box-container.ts";

export const SNAPSHOT_LABEL = "bbbox.snapshot";
export const SNAPSHOT_INSTALL = "bbbox.snapshot.install";
export const SNAPSHOT_BOX = "bbbox.snapshot.box";
export const SNAPSHOT_BOX_NAME = "bbbox.snapshot.box-name";
export const SNAPSHOT_THREAD = "bbbox.snapshot.thread";
export const COPY_INTO = "bbbox.snapshot.copy-into";
export const COPY_FOR = "bbbox.snapshot.copy-for";
export const COPY_OP = "bbbox.snapshot.copy-op";
export const KEPT_REPOSITORY = "bbbox-kept";
export const LAYERS_REFUSED_FROM = 120;
export const RESTORE_START_ABOUT_MS = 5_000;
export const KILL_ABOUT_MS = 1_000;
export const DOCKER_FORK_SAFE_FROM = 7;

export const FORK_HOLD_MISSING = "Its box was made from a Docker image that cannot hold a fork's services until BB Box has checked the fork. Rebuild the Docker images with setup/docker/build.sh, make a new box, and take a snapshot of that box.";

const RESTORED_SUFFIX = /^-[0-9a-f]{8}$/;
const VOLUME_COPY_MS_PER_GIB = 15_000;

export type ImageStore = "overlay2" | "containerd";

export interface SnapshotMount {
  readonly type: string;
  readonly name: string;
  readonly destination: string;
  readonly writable: boolean;
}

export interface SnapshotDisk {
  readonly layerBytes: number;
  readonly volumeBytes: number;
  readonly store: ImageStore;
}

export function snapshotImage(install: string, box: string, id: string): string {
  return `bbbox-snapshot/${install}/${box}:${id}`;
}

export function snapshotVolume(id: string): string {
  return `bbbox-snapshot-${id}-docker`;
}

export function keptTag(install: string, id: string, day: string): string {
  return `${KEPT_REPOSITORY}/${install}/${id}:${day}`;
}

export function keptTagsOf(tags: readonly string[], install: string, id: string): readonly string[] {
  const repository = `${KEPT_REPOSITORY}/${install}/${id}:`;
  return tags.filter((tag) => tag.startsWith(repository) && endOfUtcDay(tag.slice(repository.length)) !== null);
}

export function keptUntilOf(tags: readonly string[], install: string, id: string): number | null {
  const ends = keptTagsOf(tags, install, id).map((tag) => endOfUtcDay(tag.slice(tag.lastIndexOf(":") + 1))!);
  return ends.length ? Math.max(...ends) : null;
}

export interface KeepChange {
  readonly to: string | null;
}

function keepChangeMade(tags: readonly string[], install: string, id: string, change: KeepChange): boolean {
  return change.to === null || tags.includes(keptTag(install, id, change.to));
}

export function keptUntilWith(tags: readonly string[], install: string, id: string, change: KeepChange | null): number | null {
  if (change && keepChangeMade(tags, install, id, change)) return change.to === null ? null : endOfUtcDay(change.to);
  return keptUntilOf(tags, install, id);
}

function latestKeepTag(tags: readonly string[]): string {
  return [...tags].sort((a, b) => endOfUtcDay(b.slice(b.lastIndexOf(":") + 1))! - endOfUtcDay(a.slice(a.lastIndexOf(":") + 1))!)[0]!;
}

export function keepTagsToRemove(tags: readonly string[], install: string, id: string, change: KeepChange | null): readonly string[] {
  const kept = keptTagsOf(tags, install, id);
  if (change && keepChangeMade(tags, install, id, change)) return kept.filter((tag) => change.to === null || tag !== keptTag(install, id, change.to));
  if (kept.length <= 1) return [];
  const latest = latestKeepTag(kept);
  return kept.filter((tag) => tag !== latest);
}

export function copyIntoName(volume: string): string {
  return `${volume}-copy`;
}

export function restoredName(boxContainer: string, suffix: string): string {
  return `${boxContainer}-${suffix}`;
}

export function isBoxContainerName(boxContainer: string, name: string): boolean {
  return name === boxContainer || (name.startsWith(boxContainer) && RESTORED_SUFFIX.test(name.slice(boxContainer.length)));
}

export function sizeTakenAt(labels: Readonly<Record<string, string>>): MachineSize | null {
  const cores = Number(labels["bbbox.snapshot.cores"]);
  const memoryMiB = Number(labels["bbbox.snapshot.memory-mib"]);
  return cores > 0 && memoryMiB > 0 ? { cores, memoryMiB, diskGiB: null } : null;
}

export function holdsForks(labels: Readonly<Record<string, string>>): boolean {
  return labels[IMAGE_HOLDS_FORKS] === "1";
}

export function restoreAboutMs(volumeBytes: number): number {
  return Math.ceil(RESTORE_START_ABOUT_MS + volumeBytes * VOLUME_COPY_MS_PER_GIB / 2 ** 30);
}

export function snapshotLabels(install: string, box: string, id: string): Record<string, string> {
  return { [SNAPSHOT_LABEL]: id, [SNAPSHOT_INSTALL]: install, [SNAPSHOT_BOX]: box };
}

export function pauseEstimate(disk: SnapshotDisk): { readonly pauseMs: number; readonly addsBytes: number } {
  const layerFactor = disk.store === "containerd" ? 2 : 1;
  const layerMsPerGiB = disk.store === "containerd" ? 30_000 : 25_000;
  return {
    pauseMs: Math.ceil(4_000 + (disk.layerBytes * layerMsPerGiB + disk.volumeBytes * VOLUME_COPY_MS_PER_GIB) / 2 ** 30),
    addsBytes: Math.ceil(disk.layerBytes * layerFactor + disk.volumeBytes),
  };
}

export function takePause(disk: SnapshotDisk, running: boolean): TakePause {
  if (!running) return NO_PAUSE;
  return { pauses: true, aboutMs: pauseEstimate(disk).pauseMs, basis: { bytes: disk.layerBytes + disk.volumeBytes, of: "disk" } };
}

export function sizeFromLabels(labels: Readonly<Record<string, string>>): SnapshotSize | null {
  const layerBytes = Number(labels["bbbox.snapshot.layer-bytes"]);
  const volumeBytes = Number(labels["bbbox.snapshot.volume-bytes"] ?? 0);
  const store = labels["bbbox.snapshot.store"];
  if (!(layerBytes >= 0 && volumeBytes >= 0) || (store !== "overlay2" && store !== "containerd")) return null;
  return { bytes: pauseEstimate({ layerBytes, volumeBytes, store }).addsBytes, means: "own", estimated: true };
}

export interface RetainedOnEngine {
  readonly unsharedBytes: number | null;
  readonly wholeBytes: number;
}

export interface SnapshotImageLayers {
  readonly layers: readonly string[];
  readonly layerBytes: readonly number[];
  readonly imageBytes: number;
  readonly store: ImageStore;
  readonly volumeBytes: number;
}

function sharedLayers(layers: readonly string[], others: readonly (readonly string[])[]): number {
  const prefixOf = (other: readonly string[]) => {
    let same = 0;
    while (same < layers.length && same < other.length && layers[same] === other[same]) same++;
    return same;
  };
  return Math.max(0, ...others.map(prefixOf));
}

export function retainedOnEngine(image: SnapshotImageLayers, others: readonly (readonly string[])[]): RetainedOnEngine {
  const unpacked = (from: number) => image.layerBytes.slice(from).reduce((sum, bytes) => sum + bytes, 0);
  const keepsLayersPackedToo = image.store === "containerd";
  const wholeBytes = (keepsLayersPackedToo ? image.imageBytes + unpacked(0) : image.imageBytes) + image.volumeBytes;
  if (image.layerBytes.length !== image.layers.length) return { unsharedBytes: null, wholeBytes };
  const shared = sharedLayers(image.layers, others);
  if (shared === 0) return { unsharedBytes: wholeBytes, wholeBytes };
  const ownLayers = unpacked(shared);
  const packedShare = keepsLayersPackedToo && unpacked(0) > 0 ? image.imageBytes * (ownLayers / unpacked(0)) : 0;
  return { unsharedBytes: Math.round(ownLayers + packedShare) + image.volumeBytes, wholeBytes };
}

export function pausedTooLong(task: { readonly startedAt: number; readonly estimateMs: number }, now: number): boolean {
  return now >= task.startedAt + Math.min(15 * 60_000, 3 * task.estimateMs + 60_000);
}

export function layerRefusal(layers: number): string | null {
  return layers >= LAYERS_REFUSED_FROM
    ? "This box's image has 120 or more layers. Make a new box and move its files before taking another snapshot."
    : null;
}

export function mountRefusal(mounts: readonly SnapshotMount[]): string | null {
  const unsupported = mounts.find((mount) => mount.writable
    && !(mount.type === "bind" && LXCFS_TARGETS.includes(mount.destination))
    && !(mount.type === "volume" && mount.destination === "/var/lib/docker" && mount.name)
    && !(mount.type === "tmpfs" && ["/run", "/dev/shm"].includes(mount.destination)));
  return unsupported
    ? `This box uses shared storage at ${unsupported.destination}. BB Box cannot capture it with the box. Move the files into the box before taking a snapshot.`
    : null;
}

export function commitChanges(inherited: Readonly<Record<string, string>>, labels: Readonly<Record<string, string>>): string[] {
  return [
    ...Object.keys(labelsOf()).filter((key) => key in inherited).map((key) => `LABEL ${key}=""`),
    ...ENV_A_BOX_IS_GIVEN.map((key) => `ENV ${key}=`),
    ...Object.entries(labels).map(([key, value]) => `LABEL ${key}=${JSON.stringify(value)}`),
  ];
}

export function dockerOffer(keepOffBecause: string | null = null): Snapshotting {
  return {
    scope: "box",
    holds: ["disk"],
    whileRunning: "pauses",
    restore: "new-guest",
    fork: "copy",
    forkSafeFrom: DOCKER_FORK_SAFE_FROM,
    keepsPastRelease: keepOffBecause ? "no" : "as-is",
    lives: "provider",
    price: null,
    excludes: "running programs, memory, /run and /dev/shm",
    ...(keepOffBecause ? { keepWhy: keepOffBecause } : {}),
  };
}

export interface SnapshotLines {
  readonly status: DoctorCheck["status"];
  readonly detail: string;
}

const STATUS_ORDER: readonly DoctorCheck["status"][] = ["skipped", "ok", "warn", "fail"];

export function snapshotLinesOf(checks: readonly DoctorCheck[]): SnapshotLines | null {
  const lines = checks.filter((check) => check.id.startsWith("docker.snapshot"));
  if (!lines.length) return null;
  const status = lines.map((check) => check.status).reduce((worst, each) => (STATUS_ORDER.indexOf(each) > STATUS_ORDER.indexOf(worst) ? each : worst));
  return { status, detail: lines.map((check) => `${check.name}: ${check.detail}`).join(" ") };
}
