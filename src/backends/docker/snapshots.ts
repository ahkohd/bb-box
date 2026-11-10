import { NO_PAUSE, type MachineSize, type SnapshotSize, type Snapshotting, type TakePause } from "../types.ts";
import { LXCFS_TARGETS } from "./lxcfs.ts";
import { ENV_A_BOX_IS_GIVEN, labelsOf } from "./box-container.ts";

export const SNAPSHOT_LABEL = "bbbox.snapshot";
export const SNAPSHOT_INSTALL = "bbbox.snapshot.install";
export const SNAPSHOT_BOX = "bbbox.snapshot.box";
export const LAYERS_REFUSED_FROM = 120;
export const RESTORE_START_ABOUT_MS = 5_000;
export const KILL_ABOUT_MS = 1_000;

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
  return { bytes: pauseEstimate({ layerBytes, volumeBytes, store }).addsBytes, means: "whole" };
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

export function dockerOffer(): Snapshotting {
  return {
    scope: "box",
    holds: ["disk"],
    whileRunning: "pauses",
    restore: "new-guest",
    fork: "none",
    keepsPastRelease: "no",
    lives: "host",
    outlivesGuest: true,
    price: null,
    excludes: "running programs, memory, /run and /dev/shm",
  };
}
