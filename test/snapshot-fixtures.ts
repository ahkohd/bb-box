import type { SnapshotOperation, SnapshotRecord } from "../src/core/snapshot.ts";

export const SET_NOW = Date.UTC(2026, 9, 30, 10, 42);
const MINUTE = 60_000;
let made = 0;

function idOf(prefix: string, n: number): string {
  return `${prefix}${n.toString(32).replace(/[0-9]/g, (digit) => "abcdefghij"[Number(digit)]!).padStart(12, "a")}`;
}

export function record(change: Partial<SnapshotRecord> = {}): SnapshotRecord {
  made++;
  return {
    id: idOf("sn", made),
    box: { id: "bxamberfox2q7k", name: "amber-fox", kind: "linux", system: "linux", thread: "thr_one" },
    boxGone: null,
    backend: { id: "proxmox-lxc", label: "Proxmox LXC on pve-1" },
    host: "pve-1",
    storage: { name: "local-lvm", type: "lvmthin" },
    guest: "current",
    livesOn: { ref: "214", host: "pve-1", address: null, size: null, data: { box: "bxamberfox2q7k" } },
    name: `snapshot ${made}`,
    note: null,
    takenAt: SET_NOW - (100 - made) * MINUTE,
    capturedAt: null,
    tookMs: 700,
    by: { is: "agent", threadId: "thr_one" },
    scope: "box",
    holds: "disk",
    excludes: null,
    size: null,
    price: null,
    owner: "thread",
    keptUntil: null,
    keptAt: null,
    undoOf: null,
    forkSafe: null,
    dependsOn: [],
    picture: null,
    ref: null,
    state: "ready",
    error: null,
    stateAt: SET_NOW - MINUTE,
    missingSince: null,
    foundAt: null,
    ...change,
  };
}

export function operation(kind: SnapshotOperation["kind"], snapshots: readonly string[], change: Partial<SnapshotOperation> = {}): SnapshotOperation {
  made++;
  return {
    id: idOf("op", made),
    request: null,
    requestDigest: null,
    kind,
    box: "bxamberfox2q7k",
    guest: "214",
    snapshots,
    by: { is: "person" },
    consent: null,
    undo: null,
    guests: null,
    step: "planned",
    task: null,
    state: "running",
    reserved: null,
    error: null,
    startedAt: SET_NOW - MINUTE,
    endedAt: null,
    snapshotsGoneAt: null,
    ...change,
  };
}
