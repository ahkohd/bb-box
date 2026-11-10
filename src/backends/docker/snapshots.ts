import type { Snapshotting } from "../types.ts";
import { LXCFS_TARGETS } from "./lxcfs.ts";
import { ENV_A_BOX_IS_GIVEN, labelsOf } from "./box-container.ts";

export const SNAPSHOT_LABEL = "bbbox.snapshot";
export const SNAPSHOT_INSTALL = "bbbox.snapshot.install";
export const SNAPSHOT_BOX = "bbbox.snapshot.box";
export const LAYERS_REFUSED_FROM = 120;

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

export function snapshotLabels(install: string, box: string, id: string): Record<string, string> {
  return { [SNAPSHOT_LABEL]: id, [SNAPSHOT_INSTALL]: install, [SNAPSHOT_BOX]: box };
}

export function pauseEstimate(disk: SnapshotDisk): { readonly pauseMs: number; readonly addsBytes: number } {
  const layerFactor = disk.store === "containerd" ? 2 : 1;
  const layerMsPerGiB = disk.store === "containerd" ? 30_000 : 25_000;
  return {
    pauseMs: Math.ceil(4_000 + (disk.layerBytes * layerMsPerGiB + disk.volumeBytes * 15_000) / 2 ** 30),
    addsBytes: Math.ceil(disk.layerBytes * layerFactor + disk.volumeBytes),
  };
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
    restore: "none",
    fork: "none",
    keepsPastRelease: "no",
    lives: "host",
    outlivesGuest: true,
    price: null,
    excludes: "running programs, memory, /run and /dev/shm",
  };
}
