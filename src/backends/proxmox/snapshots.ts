import type { DoctorCheck } from "../types.ts";
import type { GuestType, Proxmox } from "./api.ts";
import { PRODUCT } from "../../brand.ts";

export const SNAPSHOT_PRIVILEGES = ["VM.Snapshot", "VM.Snapshot.Rollback"] as const;

export type SnapshotRestore = "any" | "newest-only" | "none" | "unknown";

export interface GuestDiskStorage {
  readonly name: string;
  readonly type: string;
  readonly volume: string;
}

export interface StorageSnapshots {
  readonly restore: SnapshotRestore;
  readonly words: string;
}

const STORAGE_TYPE_NAMES: Readonly<Record<string, string>> = {
  lvmthin: "LVM-thin",
  lvm: "LVM",
  zfspool: "ZFS",
  zfs: "ZFS over iSCSI",
  rbd: "Ceph RBD",
  btrfs: "BTRFS",
  dir: "directory",
  nfs: "NFS",
  cifs: "CIFS",
  glusterfs: "GlusterFS",
  iscsi: "iSCSI",
  iscsidirect: "iSCSI",
};

const ROLLS_BACK_TO_ANY = new Set(["lvmthin", "rbd", "btrfs"]);
const ROLLS_BACK_TO_NEWEST_ONLY = new Set(["zfspool", "zfs"]);
const HOLDS_DISK_FILES = new Set(["dir", "nfs", "cifs", "glusterfs"]);
const TAKES_NO_SNAPSHOTS = new Set(["iscsi", "iscsidirect"]);

function isQcow2(volume: string): boolean {
  return /\.qcow2(?:,|$)/.test(volume);
}

export function storageSnapshots(storage: GuestDiskStorage, guest: GuestType): StorageSnapshots {
  const type = STORAGE_TYPE_NAMES[storage.type] ?? storage.type;
  const named = (what: string) => `${storage.name} (${what})`;
  if (ROLLS_BACK_TO_ANY.has(storage.type)) return { restore: "any", words: `${named(type)} restores any snapshot.` };
  if (ROLLS_BACK_TO_NEWEST_ONLY.has(storage.type)) return { restore: "newest-only", words: `${named(type)} restores only the newest snapshot.` };
  if (HOLDS_DISK_FILES.has(storage.type)) {
    if (guest === "lxc") return { restore: "none", words: `${named(type)} takes no snapshots of containers.` };
    if (isQcow2(storage.volume)) return { restore: "any", words: `${named(`${type}, qcow2 files`)} restores any snapshot.` };
    return { restore: "none", words: `${named(`${type}, raw files`)} takes no snapshots.` };
  }
  if (storage.type === "lvm") {
    return guest === "lxc"
      ? { restore: "none", words: `${named(type)} takes no snapshots of containers.` }
      : { restore: "none", words: `${named(type)} takes snapshots of VMs only as a preview in Proxmox VE 9, so ${PRODUCT} restores none.` };
  }
  if (TAKES_NO_SNAPSHOTS.has(storage.type)) return { restore: "none", words: `${named(type)} takes no snapshots.` };
  return { restore: "unknown", words: `${PRODUCT} does not know whether ${named(type || "of no type Proxmox names")} takes snapshots.` };
}

export interface SnapshotsCheckInput {
  readonly pool: string;
  readonly node: string;
  readonly guest: GuestType;
  readonly privileges: ReadonlySet<string> | Error;
  readonly storages: readonly GuestDiskStorage[];
  readonly metadata?: readonly { readonly storage: string; readonly unread: string | null }[];
}

function joinedWithAnd(names: readonly string[]): string {
  return names.join(" and ");
}

function whatTheTokenCannotDo(missing: readonly string[]): string {
  if (missing.length === SNAPSHOT_PRIVILEGES.length) return "take or restore snapshots";
  return missing.includes("VM.Snapshot") ? "take or delete snapshots" : "restore snapshots";
}

function storagesThatTakeSnapshots(guest: GuestType): string {
  return guest === "lxc" ? "LVM-thin, ZFS, Ceph RBD or BTRFS" : "LVM-thin, ZFS, Ceph RBD, BTRFS, or qcow2 disks on a directory";
}

export function snapshotsCheck(input: SnapshotsCheckInput): Pick<DoctorCheck, "status" | "detail" | "fix"> {
  const path = `/pool/${input.pool}`;
  const seen = new Map<string, StorageSnapshots>();
  for (const storage of input.storages) {
    const found = storageSnapshots(storage, input.guest);
    seen.set(found.words, found);
  }
  const storages = [...seen.values()];
  const storageWords = storages.map((storage) => storage.words);
  const withoutSnapshots = storages.filter((storage) => storage.restore === "none");
  const fixes: string[] = [];
  let rights: string;
  if (input.privileges instanceof Error) {
    rights = `${PRODUCT} cannot read the token's rights on ${path}: ${input.privileges.message.replace(/\.$/, "")}.`;
    fixes.push("Check that BB's server reaches the Proxmox API, then run the checks again.");
  } else {
    const held = input.privileges;
    const missing = SNAPSHOT_PRIVILEGES.filter((privilege) => !held.has(privilege));
    if (missing.length) {
      rights = `The token lacks ${joinedWithAnd(missing)} on ${path}, so ${PRODUCT} cannot ${whatTheTokenCannotDo(missing)}.`;
      fixes.push(
        `Run host/setup-token.sh from the Proxmox LXC setup guide again, as root on ${input.node}. ` +
          "It keeps the token and its secret, and adds the missing rights to the token's role.",
      );
    } else {
      rights = `The token may take, delete and restore snapshots on ${path}.`;
    }
  }
  if (withoutSnapshots.length) {
    fixes.push(`For snapshots, put the templates on storage that takes them: ${storagesThatTakeSnapshots(input.guest)}.`);
  }
  const unread = (input.metadata ?? []).filter((each) => each.unread !== null);
  for (const each of unread) storageWords.push(`${PRODUCT} cannot read ${each.storage}'s thin metadata (${each.unread!.replace(/\.$/, "")}), so a take checks the pool's data use but not that its metadata is under 80% full.`);
  if (unread.length) fixes.push("Reading a thin pool's metadata takes Sys.Audit on /, a read of the whole cluster, which host/setup-token.sh does not give. Watch the pool's metadata on the host, or give that right.");
  return {
    status: fixes.length ? "warn" : "ok",
    detail: [rights, ...storageWords].join(" "),
    fix: fixes.length ? fixes.join(" ") : null,
  };
}

export function poolPrivileges(api: Proxmox, pool: string, signal?: AbortSignal): Promise<ReadonlySet<string> | Error> {
  return api.privilegesOn(`/pool/${pool}`, signal).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
}
