import { PRODUCT } from "../../brand.ts";
import type { SnapshotPlan, Snapshotting } from "../types.ts";

export const ANDROID_NO_FORK = "an Android device and its host have no identity reset BB Box has checked, so a copy of it would keep the box's identity";

const ANDROID_DISK_ONLY = "An Android box's snapshot holds its disk only.";

export const ANDROID_SNAPSHOTS: Snapshotting = {
  scope: "box",
  holds: ["disk"],
  whileRunning: "live",
  restore: "in-place",
  fork: "none",
  keepsPastRelease: "no",
  lives: "host",
  price: null,
  excludes: null,
  forkWhy: ANDROID_NO_FORK,
};

function capital(clause: string): string {
  return `${clause.charAt(0).toUpperCase()}${clause.slice(1)}`;
}

function androidRestoreRefused(plan: SnapshotPlan): string {
  const zfs = plan.storage.type === "zfspool" || plan.storage.type === "zfs";
  const where = zfs ? `${plan.storage.name} is ZFS, which restores only the newest snapshot. ` : "";
  return `${where}The undo of this restore would be a held copy, and ${PRODUCT} makes a held copy only of a box whose identity reset works. ${capital(ANDROID_NO_FORK)}. Put the disk on LVM-thin, Ceph RBD, BTRFS, or a qcow2 disk to restore it. Take and delete still work here.`;
}

function androidRestore(plan: SnapshotPlan): SnapshotPlan["restore"] {
  const restore = plan.restore;
  if (restore.way === "none" || (restore.way === "rollback" && restore.undo === "snapshot")) return restore;
  return {
    way: "none",
    why: androidRestoreRefused(plan),
    undo: "none",
    undoAboutMs: 0,
    undoBytes: null,
    sizeBack: null,
    leavesOnEarlierGuest: 0,
    newer: restore.newer,
    copyAboutMs: restore.copyAboutMs,
  };
}

export function androidSnapshotPlan(plan: SnapshotPlan): SnapshotPlan {
  return {
    storage: plan.storage,
    take: { ...plan.take, memoryAboutMs: null, memory: null, memoryWhy: ANDROID_DISK_ONLY },
    restore: androidRestore(plan),
    keep: {
      way: "no",
      why: `${PRODUCT} keeps a snapshot past a release only when it can fork that snapshot, and ${ANDROID_NO_FORK}.`,
      aboutMs: null,
      bytes: null,
      usedBytes: null,
      price: null,
    },
    fork: { ok: false, why: `${capital(ANDROID_NO_FORK)}.`, aboutMs: 0, bytes: null, size: null },
    locked: plan.locked,
    busy: plan.busy,
  };
}
