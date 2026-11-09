import type { BoxOwner, Guest, HeldSnapshot, HeldSnapshotState, Holds, Snapshotting, SnapshotStorage } from "../types.ts";
import { endOfUtcDay } from "../../core/snapshot.ts";
import { MSB_VERSION } from "./release.ts";
import { PRODUCT } from "../../brand.ts";


export const SNAPSHOTS_CHECKED_WITH = "0.7.7";
export const MSB_FORK_SAFE_FROM = 7;
export const DISK_TAKE_ABOUT_MS = 400;
export const FULL_TAKE_ABOUT_MS = 1_500;
export const RESTORE_ABOUT_MS = 4_000;
export const STOP_ABOUT_MS = 2_000;
export const SNAPSHOT_MS = 10 * 60_000;
export const MSB_EXCLUDES = "/run, which lives in the box's memory, unless the snapshot holds its memory";
export const DOCKER_GUEST = "/var/lib/docker";

const SNAPSHOT_NAME = /^([a-z0-9][a-z0-9-]*)-(sn[a-z2-7]{12})-r(\d{1,3})$/;
const SNAPSHOT_GROUP = /^bbbox-(bx[a-z0-9]{12})$/;

export function snapshotGroup(boxId: string): string {
  return `bbbox-${boxId}`;
}

export function snapshotName(install: string, snapshot: string, forkSafe: number | null | undefined): string {
  return `${install}-${snapshot}-r${forkSafe ?? 0}`;
}

export interface NamedSnapshot {
  readonly install: string;
  readonly box: string;
  readonly snapshot: string;
  readonly forkSafe: number | null;
}

export function parseSnapshotNaming(group: string, name: string): NamedSnapshot | null {
  const box = SNAPSHOT_GROUP.exec(group)?.[1];
  const found = SNAPSHOT_NAME.exec(name);
  if (!box || !found) return null;
  const reset = Number(found[3]);
  return { install: found[1]!, box, snapshot: found[2]!, forkSafe: reset > 0 ? reset : null };
}

export interface MsbSnapshot {
  readonly id: string;
  readonly group: string;
  readonly name: string;
  readonly holds: Holds;
  readonly availability: string;
  readonly parent: string | null;
  readonly createdAt: number | null;
}

export function groupMember(snapshot: Pick<MsbSnapshot, "group" | "name">): string {
  return `${snapshot.group}:${snapshot.name}`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export function parseSnapshotList(stdout: string): MsbSnapshot[] {
  const listed: unknown = stdout.trim() ? JSON.parse(stdout) : [];
  if (!Array.isArray(listed)) throw new Error("msb's snapshot list is not a list.");
  return listed.flatMap((entry): MsbSnapshot[] => {
    const fields = record(entry);
    const id = text(fields.snapshot_id);
    const group = text(fields.group);
    const name = text(fields.name);
    if (!id || !group || !name) return [];
    const created = text(fields.created_at);
    const at = created ? Date.parse(created) : Number.NaN;
    return [
      {
        id,
        group,
        name,
        holds: fields.scope === "full" ? "disk-and-memory" : "disk",
        availability: text(fields.availability) ?? "unknown",
        parent: text(fields.parent_digest),
        createdAt: Number.isFinite(at) ? at : null,
      },
    ];
  });
}

export interface SnapshotExtras {
  readonly sizes: ReadonlyMap<string, number>;
  readonly kept: ReadonlyMap<string, number>;
}

export function parseSnapshotExtras(values: Readonly<Record<string, string>>): SnapshotExtras {
  const sizes = new Map<string, number>();
  const kept = new Map<string, number>();
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith("kept:")) {
      const until = endOfUtcDay(value);
      if (until !== null) kept.set(key.slice(5), until);
      continue;
    }
    const kib = Number(value);
    if (key.startsWith("size:") && Number.isFinite(kib) && kib > 0) sizes.set(key.slice(5), kib * 1024);
  }
  return { sizes, kept };
}

export function heldStateOf(snapshot: Pick<MsbSnapshot, "availability">): { readonly state: HeldSnapshotState; readonly words: string | null } {
  if (snapshot.availability === "ready") return { state: "complete", words: null };
  return { state: "incomplete", words: `msb lists it as ${snapshot.availability}` };
}

export function dependsOnOf(snapshot: MsbSnapshot, all: readonly MsbSnapshot[], install: string): string[] {
  if (!snapshot.parent) return [];
  const parent = all.find((each) => each.id === snapshot.parent);
  const named = parent ? parseSnapshotNaming(parent.group, parent.name) : null;
  return named && named.install === install ? [named.snapshot] : [];
}

export function dependentsOf(snapshot: MsbSnapshot, all: readonly MsbSnapshot[]): MsbSnapshot[] {
  return all.filter((each) => each.parent === snapshot.id);
}

export function nextHead(snapshot: MsbSnapshot, all: readonly MsbSnapshot[]): MsbSnapshot | null {
  const others = all.filter((each) => each.group === snapshot.group && each.id !== snapshot.id);
  return others.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0] ?? null;
}

export interface HeldInput {
  readonly snapshot: MsbSnapshot;
  readonly named: NamedSnapshot;
  readonly all: readonly MsbSnapshot[];
  readonly guest: Guest;
  readonly owner: BoxOwner | null;
  readonly extras: SnapshotExtras;
  readonly storage: { readonly name: string; readonly type: string };
}

export function heldFrom(input: HeldInput): HeldSnapshot {
  const { snapshot, named, guest, owner, extras } = input;
  const { state, words } = heldStateOf(snapshot);
  return {
    id: named.snapshot,
    ref: snapshot.id,
    box: named.box,
    owner,
    guest,
    where: "current",
    state,
    words,
    holds: snapshot.holds,
    takenAt: snapshot.createdAt,
    keptUntil: extras.kept.get(snapshot.id) ?? null,
    storage: input.storage,
    forkSafe: named.forkSafe,
    dependsOn: dependsOnOf(snapshot, input.all, named.install),
  };
}

export function msbOffer(): Snapshotting {
  return {
    scope: "box",
    holds: ["disk", "disk-and-memory"],
    whileRunning: "pauses",
    restore: "new-guest",
    fork: "copy",
    keepsPastRelease: "as-is",
    lives: "provider",
    price: null,
    excludes: MSB_EXCLUDES,
    forkSafeFrom: MSB_FORK_SAFE_FROM,
  };
}

export function versionRefusal(installed: string | null): string | null {
  if (installed === SNAPSHOTS_CHECKED_WITH && MSB_VERSION === SNAPSHOTS_CHECKED_WITH) return null;
  return `${PRODUCT} takes and deletes microsandbox snapshots only with msb ${SNAPSHOTS_CHECKED_WITH}, whose snapshots its checks measured, and this host has ${installed ? `msb ${installed}` : "no msb installed yet"}${MSB_VERSION === SNAPSHOTS_CHECKED_WITH ? "" : `, while this ${PRODUCT} pins ${MSB_VERSION}`}`;
}

export function msbVersionOf(stdout: string): string | null {
  return /^msb\s+(\S+)/.exec(stdout.trim())?.[1] ?? null;
}

export const HOST_FILE_DOCKER =
  `it was made before ${PRODUCT} could snapshot a box's Docker disk: its Docker data is on a file of the host's, which msb leaves out of a snapshot and cannot give a restored box. A new box can`;

export function storageOf(host: string, totalKiB: number, freeKiB: number): SnapshotStorage {
  const totalBytes = totalKiB > 0 ? totalKiB * 1024 : null;
  const usedBytes = totalKiB > 0 ? Math.max(0, totalKiB - freeKiB) * 1024 : null;
  return {
    key: `microsandbox:${host}`,
    name: "msb's folder",
    type: "msb",
    percentFull: totalBytes && usedBytes !== null ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
    metadataPercentFull: null,
    metadataUnread: null,
    totalBytes,
    usedBytes,
  };
}

export function restoreNetwork(profiles: string): string[] {
  const allowed = profiles.split(",").map((profile) => profile.trim()).filter(Boolean).map((profile) => `allow@${profile}`);
  return ["--net-default", "deny", "--net-rule", ["allow@dns", ...allowed, "allow:ingress@any"].join(",")];
}

export const TAKE_TASK = "take:";
export const DELETE_TASK = "delete:";
export const RESTORED_NAME = /^-[0-9a-f]{8}$/;

export const SNAPSHOT_LABELS = {
  snapshot: "bbbox.snapshot",
  cores: "bbbox.cores",
  memory: "bbbox.memory-mib",
  disk: "bbbox.disk-gib",
} as const;

export interface InspectedSnapshot {
  readonly labels: Readonly<Record<string, string>>;
  readonly diskGiB: number | null;
}

export function parseInspect(stdout: string): InspectedSnapshot {
  const line = (key: string) => stdout.split("\n").find((each) => each.startsWith(`${key}:`))?.slice(key.length + 1).trim() ?? null;
  const labels: Record<string, string> = {};
  for (const pair of (line("Labels") ?? "").split(/,\s*/)) {
    const at = pair.indexOf("=");
    if (at > 0) labels[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }
  const size = /^([0-9.]+)\s*GiB$/.exec(line("Virtual Size") ?? "");
  return { labels, diskGiB: size ? Math.round(Number(size[1])) : null };
}

export function parseHead(stdout: string): string | null {
  const head = record(JSON.parse(stdout)).head;
  return typeof head === "string" && head ? head : null;
}
