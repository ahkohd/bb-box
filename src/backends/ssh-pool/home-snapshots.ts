import { NO_PAUSE, type BoxOwner, type Guest, type HeldSnapshot, type HeldSnapshotState, type SnapshotPlan, type SnapshotStorage, type Snapshotting } from "../types.ts";
import { PRODUCT } from "../../brand.ts";

export const HOME_SNAPSHOTS_HELPER_VERSION = 3;
export const HOME_SNAPSHOT_KINDS: ReadonlySet<string> = new Set(["macos", "macos-desktop"]);
export const TAKE_PAUSE_GUESS_MS = 300;
export const SESSION_END_ABOUT_MS = 1_500;
export const SIGN_IN_ABOUT_MS = 2_000;

export const HOME_KEEP_OFF = `a home snapshot lives on the pool's Mac, which ${PRODUCT} lends to the next box after the release, so the snapshot goes with its box`;
export const HOME_FORK_OFF = `a fork would be a new box user beside its source on the same Mac, and signing that user in needs a userspace restart, which ends the source box's session and every SSH session on the Mac, so ${PRODUCT} forks no home snapshots yet`;
export const HOME_EXCLUDES = "apps installed on the Mac, files outside the home folder, the user's temporary and cache folders, and anything running";
export const SLOT_SNAPSHOTS_LATER = `${PRODUCT} takes no snapshots of iOS slots on the pool's Macs yet`;
export const LINUX_SNAPSHOTS_LATER = `${PRODUCT} takes no snapshots on the pool's Linux machines yet`;

export function homeOffer(): Snapshotting {
  return {
    scope: "home",
    holds: ["disk"],
    whileRunning: "pauses",
    restore: "in-place",
    fork: "none",
    keepsPastRelease: "no",
    lives: "host",
    price: null,
    excludes: HOME_EXCLUDES,
    forkWhy: HOME_FORK_OFF,
    keepWhy: HOME_KEEP_OFF,
  };
}

export function olderHelperWhy(machine: string, version: number | null): string {
  return `its machine, ${machine}, has helper version ${version ?? "unknown"}, and home snapshots need version ${HOME_SNAPSHOTS_HELPER_VERSION}: run this ${PRODUCT}'s setup-mac.sh on it again`;
}

export interface ListedHome {
  readonly id: string;
  readonly box: string;
  readonly thread: string | null;
  readonly name: string | null;
  readonly kind: string | null;
  readonly createdAt: number | null;
  readonly capturedAt: number | null;
  readonly pausedMs: number | null;
  readonly user: string;
  readonly state: HeldSnapshotState;
}

export interface HomeStore {
  readonly totalKiB: number;
  readonly usedKiB: number;
  readonly freeKiB: number;
}

export interface HomeListing {
  readonly snapshots: readonly ListedHome[];
  readonly store: HomeStore | null;
}

const STATES: ReadonlySet<string> = new Set(["complete", "incomplete", "in-progress"]);

function wholeOrNull(value: string | undefined): number | null {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

function lineValues(line: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const part of line.split("\t")) {
    const at = part.indexOf("=");
    if (at > 0) values.set(part.slice(0, at), part.slice(at + 1));
  }
  return values;
}

function listedHome(line: string): ListedHome | null {
  const values = lineValues(line);
  const id = values.get("snapshot");
  const box = values.get("box");
  const user = values.get("user");
  const state = values.get("state") ?? "";
  if (!id || !box || !user || !STATES.has(state)) return null;
  return {
    id,
    box,
    thread: values.get("thread") || null,
    name: values.get("name") || null,
    kind: values.get("kind") || null,
    createdAt: wholeOrNull(values.get("created")),
    capturedAt: wholeOrNull(values.get("captured")),
    pausedMs: wholeOrNull(values.get("paused_ms")),
    user,
    state: state as HeldSnapshotState,
  };
}

export function parseHomeListing(stdout: string): HomeListing {
  const lines = stdout.split("\n");
  const snapshots = lines.filter((line) => line.startsWith("snapshot=")).map(listedHome).filter((each): each is ListedHome => each !== null);
  const store = new Map(lines.filter((line) => line.startsWith("store.")).map((line) => [line.slice(6, line.indexOf("=")), wholeOrNull(line.slice(line.indexOf("=") + 1))]));
  const [total, used, free] = [store.get("total_kib"), store.get("used_kib"), store.get("free_kib")];
  return { snapshots, store: total && used !== undefined && used !== null && free !== undefined && free !== null ? { totalKiB: total, usedKiB: used, freeKiB: free } : null };
}

export function homeRef(machine: string, user: string, id: string): string {
  return `${machine}:${user}/${id}`;
}

export function homeUserOf(ref: string): string | null {
  return /:([A-Za-z0-9_-]+)\/[A-Za-z0-9_-]+$/.exec(ref)?.[1] ?? null;
}

export function homeStorage(machine: string, homes: string, store: HomeStore | null): SnapshotStorage {
  const totalBytes = store ? store.totalKiB * 1024 : null;
  const usedBytes = store ? store.usedKiB * 1024 : null;
  return {
    key: `ssh-pool:${machine}:${homes}`,
    name: homes,
    type: "apfs",
    percentFull: store && store.totalKiB > 0 ? (store.usedKiB / store.totalKiB) * 100 : 0,
    metadataPercentFull: null,
    metadataUnread: null,
    totalBytes,
    usedBytes,
  };
}

export function pauseGuess(listing: HomeListing, box: string): number {
  const paused = listing.snapshots.filter((each) => each.box === box && each.pausedMs !== null && each.pausedMs > 0).map((each) => each.pausedMs!);
  return paused.length ? Math.max(...paused) : TAKE_PAUSE_GUESS_MS;
}

export function homePlan(storage: SnapshotStorage, refusal: string | null, pauseMs: number): SnapshotPlan {
  return {
    storage,
    take: {
      ok: refusal === null,
      why: refusal,
      aboutMs: pauseMs,
      memoryAboutMs: null,
      addsBytes: null,
      pause: refusal ? NO_PAUSE : { pauses: true, aboutMs: pauseMs, basis: null },
      memory: null,
      memoryWhy: "A home snapshot holds the home folder only, not memory or anything running.",
    },
    restore: {
      way: refusal ? "none" : "rollback",
      why: refusal,
      undo: refusal ? "none" : "snapshot",
      undoAboutMs: SESSION_END_ABOUT_MS + pauseMs,
      undoBytes: 0,
      sizeBack: null,
      leavesOnEarlierGuest: 0,
      newer: 0,
      copyAboutMs: null,
    },
    keep: { way: "no", why: HOME_KEEP_OFF, aboutMs: null, bytes: null, price: null },
    fork: { ok: false, why: HOME_FORK_OFF, aboutMs: 0, bytes: null, size: null },
    locked: null,
    busy: null,
  };
}

function ownerOf(listed: ListedHome): BoxOwner | null {
  return listed.thread ? { boxId: listed.box, threadId: listed.thread, name: listed.name, kind: listed.kind, createdAt: listed.createdAt } : null;
}

export function heldHome(machine: Guest, listed: ListedHome, homes: string): HeldSnapshot {
  return {
    id: listed.id,
    ref: homeRef(machine.ref, listed.user, listed.id),
    box: listed.box,
    owner: ownerOf(listed),
    guest: { ...machine, data: { box: listed.box, user: listed.user } },
    where: "current",
    state: listed.state,
    words: listed.state === "incomplete" ? "The take did not finish, and left part of the home's clone." : null,
    holds: "disk",
    takenAt: listed.capturedAt,
    keptUntil: null,
    storage: { name: homes, type: "apfs" },
    size: null,
  };
}

export type HomeTask =
  | { readonly kind: "take"; readonly id: string }
  | { readonly kind: "delete"; readonly user: string; readonly id: string }
  | { readonly kind: "restore"; readonly box: string; readonly generation: number; readonly id: string; readonly operation: string };

export function homeTaskRef(task: HomeTask): string {
  if (task.kind === "restore") return `restore:${task.box}:${task.generation}:${task.id}:${task.operation}`;
  return task.kind === "delete" ? `delete:${task.user}:${task.id}` : `take:${task.id}`;
}

export function parseHomeTask(ref: string): HomeTask | null {
  const parts = ref.split(":");
  if (parts[0] === "take" && parts.length === 2 && parts[1]) return { kind: "take", id: parts[1] };
  if (parts[0] === "delete" && parts.length === 3 && parts[1] && parts[2]) return { kind: "delete", user: parts[1], id: parts[2] };
  if (parts[0] === "restore" && parts.length === 5 && /^\d+$/.test(parts[2]!)) return { kind: "restore", box: parts[1]!, generation: Number(parts[2]), id: parts[3]!, operation: parts[4]! };
  return null;
}
