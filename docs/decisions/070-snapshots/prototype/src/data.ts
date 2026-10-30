export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export type Holds = "disk" | "disk-and-memory";
export type WhileRunning = "live" | "pauses" | "suspends" | "stopped-only";
export type Screen = "linux" | "macos" | "phone" | "none";

export interface Price {
  readonly amount: number;
  readonly currency: "USD" | "EUR";
  readonly per: "day";
}

export interface Snapshotting {
  readonly holds: readonly Holds[];
  readonly whileRunning: WhileRunning;
  readonly restore: "in-place" | "new-guest";
  readonly fork: "copy" | "thin" | "none";
  readonly price: Price | null;
  readonly takesAboutMs: number;
  readonly memoryTakesAboutMs: number | null;
  readonly restoresAboutMs: number;
  readonly sizeKnown: boolean;
  readonly forkWords: string;
}

export type Actor = { readonly is: "person" } | { readonly is: "agent"; readonly threadId: string } | { readonly is: "command" } | { readonly is: "bb-box"; readonly why: string };

export const BY_PERSON: Actor = { is: "person" };

export function byAgent(threadId: string): Actor {
  return { is: "agent", threadId };
}

export interface FakeThread {
  readonly id: string;
  readonly title: string;
  readonly running: boolean;
}

export type BoxState = "ready" | "stopped" | "restoring" | "starting" | "released";

export interface FakeBox {
  readonly id: string;
  readonly name: string;
  readonly kindLabel: string;
  readonly os: string;
  readonly badges: readonly string[];
  readonly backend: string;
  readonly backendLabel: string;
  readonly host: string;
  readonly threadId: string | null;
  readonly state: BoxState;
  readonly step: string | null;
  readonly screen: Screen;
  readonly sizeWords: string;
  readonly memoryGiB: number;
  readonly createdAt: number;
  readonly releasedAt: number | null;
  readonly snapshotting: Snapshotting | null;
  readonly noSnapshotsWhy: string | null;
  readonly cannotTakeWhy: string | null;
  readonly forkedFrom: { readonly box: string; readonly snapshot: string; readonly takenAt: number } | null;
  readonly storageFull: number;
}

export type SnapState = "taking" | "ready" | "failed" | "deleting";

export interface FakeSnap {
  readonly id: string;
  readonly boxId: string;
  readonly name: string;
  readonly note: string | null;
  readonly takenAt: number;
  readonly tookMs: number | null;
  readonly by: Actor;
  readonly holds: Holds;
  readonly sizeGB: number | null;
  readonly price: Price | null;
  readonly keptUntil: number | null;
  readonly undoOf: { readonly at: number; readonly to: string } | null;
  readonly picture: number | null;
  readonly state: SnapState;
  readonly error: string | null;
}

export interface BoxEvent {
  readonly boxId: string;
  readonly at: number;
  readonly words: string;
  readonly by: Actor;
}

export interface RestoreNotice {
  readonly boxId: string;
  readonly at: number;
  readonly to: string;
  readonly toAt: number;
  readonly by: Actor;
  readonly undoId: string | null;
}

const PROXMOX_LXC: Snapshotting = {
  holds: ["disk"],
  whileRunning: "live",
  restore: "in-place",
  fork: "copy",
  price: null,
  takesAboutMs: 700,
  memoryTakesAboutMs: null,
  restoresAboutMs: 3_000,
  sizeKnown: true,
  forkWords: "A full copy: about 10 s",
};

const PROXMOX_QEMU: Snapshotting = {
  ...PROXMOX_LXC,
  holds: ["disk", "disk-and-memory"],
  takesAboutMs: 1_100,
  memoryTakesAboutMs: 3_700,
  restoresAboutMs: 4_000,
  forkWords: "A full copy: about 7 s",
};

const TART_MACOS: Snapshotting = {
  holds: ["disk-and-memory"],
  whileRunning: "suspends",
  restore: "in-place",
  fork: "copy",
  price: null,
  takesAboutMs: 20_000,
  memoryTakesAboutMs: null,
  restoresAboutMs: 11_000,
  sizeKnown: true,
  forkWords: "A copy on write: under a second, then a fresh start",
};

const BOAT: Snapshotting = {
  holds: ["disk"],
  whileRunning: "live",
  restore: "new-guest",
  fork: "copy",
  price: { amount: 0.056, currency: "USD", per: "day" },
  takesAboutMs: 30_000,
  memoryTakesAboutMs: null,
  restoresAboutMs: 6_000,
  sizeKnown: false,
  forkWords: "A new sandbox from it: about 4 s",
};

export const SNAPSHOTTING = { PROXMOX_LXC, PROXMOX_QEMU, TART_MACOS, BOAT };

export function threadsAt(): FakeThread[] {
  return [
    { id: "thr_login", title: "Fix the sign-in flow in Safari", running: true },
    { id: "thr_migrate", title: "Move the orders table to Postgres 17", running: true },
    { id: "thr_checkout", title: "iOS checkout: QA the new payment sheet", running: false },
    { id: "thr_docs", title: "Write the API guide's examples", running: false },
    { id: "thr_android", title: "Android: deep links from email", running: false },
  ];
}

function box(base: Partial<FakeBox> & Pick<FakeBox, "id" | "name" | "kindLabel" | "backend" | "backendLabel" | "host" | "threadId" | "createdAt">): FakeBox {
  return {
    os: "Linux",
    badges: [],
    state: "ready",
    step: null,
    screen: "none",
    sizeWords: "4 cores, 8 GiB memory, 32 GiB disk",
    memoryGiB: 8,
    releasedAt: null,
    snapshotting: PROXMOX_LXC,
    noSnapshotsWhy: null,
    cannotTakeWhy: null,
    forkedFrom: null,
    storageFull: 41,
    ...base,
  };
}

export function boxesAt(now: number): FakeBox[] {
  return [
    box({ id: "bxamberfox2q7k", name: "amber-fox", kindLabel: "Linux desktop", badges: ["Desktop", "LXC"], backend: "Proxmox LXC", backendLabel: "Proxmox LXC on pve-1", host: "pve-1", threadId: "thr_login", createdAt: now - 6 * HOUR, screen: "linux" }),
    box({ id: "bxbrisklake8m3", name: "brisk-lake", kindLabel: "Linux VM", badges: ["VM"], backend: "Proxmox QEMU", backendLabel: "Proxmox QEMU on pve-1", host: "pve-1", threadId: "thr_migrate", createdAt: now - 9 * HOUR, snapshotting: PROXMOX_QEMU, sizeWords: "8 cores, 16 GiB memory, 64 GiB disk", memoryGiB: 16 }),
    box({ id: "bxsilverpine6z", name: "silver-pine", kindLabel: "macOS", os: "macOS", badges: ["Desktop", "VM"], backend: "Tart", backendLabel: "Tart on mac-2", host: "mac-2", threadId: "thr_checkout", createdAt: now - 30 * HOUR, snapshotting: TART_MACOS, screen: "macos", sizeWords: "6 cores, 16 GiB memory, 96 GiB disk", memoryGiB: 16, storageFull: 58 }),
    box({ id: "bxrosyreef4k1", name: "rosy-reef", kindLabel: "Android", os: "Android", badges: ["Pixel 9", "Emulator"], backend: "Proxmox QEMU", backendLabel: "Proxmox QEMU on pve-1", host: "pve-1", threadId: "thr_android", createdAt: now - 26 * HOUR, snapshotting: PROXMOX_QEMU, screen: "phone", sizeWords: "4 cores, 8 GiB memory, 48 GiB disk" }),
    box({ id: "bxquickwren7d", name: "quick-wren", kindLabel: "Linux", badges: ["VM"], backend: "boat.dev", backendLabel: "boat.dev", host: "boat", threadId: "thr_docs", createdAt: now - 3 * DAY, snapshotting: BOAT, sizeWords: "2 cores, 4 GiB memory, 51 GiB disk", memoryGiB: 4 }),
    box({ id: "bxcalmharbor4w", name: "calm-harbor", kindLabel: "iOS", os: "iOS", badges: ["iPhone 17 Pro", "Shared"], backend: "Tart", backendLabel: "a shared iOS host on mac-1", host: "mac-1", threadId: "thr_checkout", createdAt: now - 2 * HOUR, snapshotting: null, noSnapshotsWhy: "iOS boxes on a shared host have no snapshots: a Simulator device saves no running state, and a slot is a user on a shared Mac.", screen: "phone" }),
    box({ id: "bxdevdesk9x1p", name: "dev-desk", kindLabel: "Linux desktop", badges: ["Desktop", "LXC"], backend: "Proxmox LXC", backendLabel: "Proxmox LXC on pve-2", host: "pve-2", threadId: null, createdAt: now - 40 * DAY, cannotTakeWhy: "pve-2's token cannot take snapshots: it lacks VM.Snapshot and VM.Snapshot.Rollback.", screen: "linux" }),
    box({ id: "bxbuildpool2s", name: "build-pool", kindLabel: "Linux", badges: ["Physical"], backend: "SSH host pool", backendLabel: "the SSH host pool", host: "pool", threadId: "thr_docs", createdAt: now - 5 * HOUR, snapshotting: null, noSnapshotsWhy: "Boxes on the SSH host pool have no snapshots: bb-box has no root on the machine." }),
    box({ id: "bxgreyridge5t", name: "grey-ridge", kindLabel: "Linux", badges: ["VM"], backend: "boat.dev", backendLabel: "boat.dev", host: "boat", threadId: null, createdAt: now - 30 * DAY, releasedAt: now - 18 * DAY, state: "released", snapshotting: BOAT }),
  ];
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function timeName(at: number, now: number): string {
  const date = new Date(at);
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === new Date(now).toDateString()) return `Today ${clock}`;
  return `${WEEKDAYS[date.getDay()]} ${clock}`;
}

const USD_DAY: Price = { amount: 0.056, currency: "USD", per: "day" };

function snap(base: Partial<FakeSnap> & Pick<FakeSnap, "id" | "boxId" | "name" | "takenAt" | "by">): FakeSnap {
  return { note: null, tookMs: 700, holds: "disk", sizeGB: null, price: null, keptUntil: null, undoOf: null, picture: null, state: "ready", error: null, ...base };
}

export function snapshotsAt(now: number): FakeSnap[] {
  return [
    snap({ id: "snamb01thursd", boxId: "bxamberfox2q7k", name: timeName(now - 5 * HOUR - 20 * MINUTE, now), takenAt: now - 5 * HOUR - 20 * MINUTE, by: BY_PERSON, sizeGB: 3.4, keptUntil: now + 29 * DAY, picture: 11, note: "Signed in to the staging site, cookies set." }),
    snap({ id: "snamb02migrat", boxId: "bxamberfox2q7k", name: "before the migration", takenAt: now - 2 * HOUR - 5 * MINUTE, by: byAgent("thr_login"), sizeGB: 1.2, picture: 23 }),
    snap({ id: "snamb03playwr", boxId: "bxamberfox2q7k", name: "after installing Playwright", takenAt: now - 41 * MINUTE, by: byAgent("thr_login"), sizeGB: 0.4, picture: 37, tookMs: 640 }),
    snap({ id: "snbri01today0", boxId: "bxbrisklake8m3", name: timeName(now - 7 * HOUR, now), takenAt: now - 7 * HOUR, by: BY_PERSON, sizeGB: 2.2 }),
    snap({ id: "snbri02schema", boxId: "bxbrisklake8m3", name: "schema v41", takenAt: now - 3 * HOUR, by: byAgent("thr_migrate"), sizeGB: 0.9, note: "Before the column renames." }),
    snap({ id: "snbri03pgupgr", boxId: "bxbrisklake8m3", name: "before pg_upgrade", takenAt: now - 25 * MINUTE, by: byAgent("thr_migrate"), sizeGB: 13.8, holds: "disk-and-memory", tookMs: 3_690 }),
    snap({ id: "snbri04indexe", boxId: "bxbrisklake8m3", name: "before dropping old indexes", takenAt: now - 9 * MINUTE, by: byAgent("thr_migrate"), state: "failed", tookMs: null, error: "Proxmox: VM 214 is locked (backup)." }),
    snap({ id: "snsil01clean0", boxId: "bxsilverpine6z", name: "clean install", takenAt: now - 28 * HOUR, by: BY_PERSON, holds: "disk-and-memory", sizeGB: 7.1, picture: 5, tookMs: 19_400 }),
    snap({ id: "snsil02xcode0", boxId: "bxsilverpine6z", name: "after Xcode signed in", takenAt: now - 4 * HOUR, by: byAgent("thr_checkout"), holds: "disk-and-memory", sizeGB: 7.9, picture: 19, tookMs: 21_200 }),
    snap({ id: "snros01signed", boxId: "bxrosyreef4k1", name: "app signed in", takenAt: now - 20 * HOUR, by: byAgent("thr_android"), sizeGB: 2.5, picture: 8 }),
    snap({ id: "snros02deepln", boxId: "bxrosyreef4k1", name: "before the deep link test", takenAt: now - 90 * MINUTE, by: byAgent("thr_android"), sizeGB: 0.3, picture: 14 }),
    snap({ id: "snqui01green0", boxId: "bxquickwren7d", name: "docs build green", takenAt: now - 2 * DAY, by: byAgent("thr_docs"), price: USD_DAY, tookMs: 41_000 }),
    snap({ id: "snqui02today0", boxId: "bxquickwren7d", name: timeName(now - 8 * HOUR, now), takenAt: now - 8 * HOUR, by: BY_PERSON, price: USD_DAY, tookMs: 38_000 }),
    snap({ id: "sngre01rcset0", boxId: "bxgreyridge5t", name: "release candidate set-up", takenAt: now - 19 * DAY, by: BY_PERSON, price: USD_DAY, keptUntil: now + 3 * DAY - 2 * HOUR, note: "Everything for the 4.2 release checks, built." }),
  ];
}
