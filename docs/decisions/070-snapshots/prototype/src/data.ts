export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export type Holds = "disk" | "disk-and-memory";
export type WhileRunning = "live" | "pauses" | "suspends" | "stopped-only";
export type Screen = "linux" | "macos" | "phone" | "none";
export type KeepsPastRelease = "as-is" | "held-copy" | "no";
export type UndoWay = "snapshot" | "held-copy" | "suspend-copy";

export interface Price {
  readonly amount: number;
  readonly currency: "USD" | "EUR";
  readonly per: "day";
}

export interface Snapshotting {
  readonly scope: "box" | "device";
  readonly holds: readonly Holds[];
  readonly whileRunning: WhileRunning;
  readonly restore: "in-place" | "new-guest";
  readonly fork: "copy" | "none";
  readonly keeps: KeepsPastRelease;
  readonly keepsWhyNot: string | null;
  readonly price: Price | null;
  readonly takesAboutMs: number;
  readonly memorySecondsPerGiB: number | null;
  readonly sizeKnown: boolean;
  readonly forkWords: string;
  readonly excludes: string | null;
}

export interface Storage {
  readonly name: string;
  readonly type: string;
  readonly newestOnly: boolean;
  readonly full: number;
}

export type Actor = { readonly is: "person" } | { readonly is: "agent"; readonly threadId: string } | { readonly is: "command" } | { readonly is: "bb-box"; readonly why: string } | { readonly is: "form"; readonly threadId: string };

export const BY_PERSON: Actor = { is: "person" };

export function byAgent(threadId: string): Actor {
  return { is: "agent", threadId };
}

export interface FakeThread {
  readonly id: string;
  readonly title: string;
  readonly running: boolean;
}

export type BoxState = "ready" | "stopped" | "restoring" | "starting" | "released" | "unconfirmed";

export interface FakeBox {
  readonly id: string;
  readonly name: string;
  readonly kindLabel: string;
  readonly os: string;
  readonly badges: readonly string[];
  readonly backend: string;
  readonly backendLabel: string;
  readonly host: string;
  readonly vmid: number;
  readonly storage: Storage | null;
  readonly threadId: string | null;
  readonly workspaces: readonly string[];
  readonly personControl: boolean;
  readonly terminalOpen: boolean;
  readonly state: BoxState;
  readonly step: string | null;
  readonly screen: Screen;
  readonly cores: number;
  readonly memoryGiB: number;
  readonly diskGiB: number;
  readonly usedGB: number;
  readonly createdAt: number;
  readonly releasedAt: number | null;
  readonly snapshotting: Snapshotting | null;
  readonly noSnapshotsWhy: string | null;
  readonly cannotTakeWhy: string | null;
  readonly locked: string | null;
  readonly execution: boolean;
  readonly forkReset: boolean;
  readonly forkedFrom: { readonly box: string; readonly snapshot: string; readonly takenAt: number } | null;
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
  readonly undoWay: UndoWay | null;
  readonly heldCopyGB: number | null;
  readonly sizeThen: { readonly cores: number; readonly memoryGiB: number } | null;
  readonly forkSafe: boolean;
  readonly onEarlierGuest: boolean;
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

export type NoticeKind = "restored" | "unconfirmed" | "finished-after-restart" | "storage";

export interface RestoreNotice {
  readonly kind: NoticeKind;
  readonly boxId: string;
  readonly at: number;
  readonly to: string;
  readonly toAt: number;
  readonly by: Actor;
  readonly consentIn: string | null;
  readonly undoId: string | null;
}

const PROXMOX_LXC: Snapshotting = {
  scope: "box",
  holds: ["disk"],
  whileRunning: "live",
  restore: "in-place",
  fork: "copy",
  keeps: "held-copy",
  keepsWhyNot: null,
  price: null,
  takesAboutMs: 700,
  memorySecondsPerGiB: null,
  sizeKnown: true,
  forkWords: "A full copy",
  excludes: null,
};

const PROXMOX_QEMU: Snapshotting = {
  ...PROXMOX_LXC,
  holds: ["disk", "disk-and-memory"],
  takesAboutMs: 1_100,
  memorySecondsPerGiB: 0.92,
};

const TART_MACOS: Snapshotting = {
  scope: "box",
  holds: ["disk-and-memory"],
  whileRunning: "suspends",
  restore: "in-place",
  fork: "none",
  keeps: "no",
  keepsWhyNot: "Tart's macOS forks come in unit 8; until then a kept copy could not be used after the release.",
  price: null,
  takesAboutMs: 20_000,
  memorySecondsPerGiB: null,
  sizeKnown: true,
  forkWords: "",
  excludes: null,
};

const BOAT: Snapshotting = {
  scope: "box",
  holds: ["disk"],
  whileRunning: "live",
  restore: "new-guest",
  fork: "copy",
  keeps: "as-is",
  keepsWhyNot: null,
  price: { amount: 0.056, currency: "USD", per: "day" },
  takesAboutMs: 30_000,
  memorySecondsPerGiB: null,
  sizeKnown: false,
  forkWords: "A new sandbox from it: about 4 s",
  excludes: "/tmp, caches, the build cache and SSH host keys",
};

const ANDROID_DEVICE: Snapshotting = {
  ...PROXMOX_QEMU,
  scope: "device",
  holds: ["disk-and-memory"],
  takesAboutMs: 14_800,
  memorySecondsPerGiB: null,
  fork: "none",
  keeps: "no",
  keepsWhyNot: "A device snapshot lives in the box, and goes with it.",
};

export const SNAPSHOTTING = { PROXMOX_LXC, PROXMOX_QEMU, TART_MACOS, BOAT, ANDROID_DEVICE };

const LVM_THIN_1: Storage = { name: "local-lvm", type: "LVM-thin", newestOnly: false, full: 62 };
const LVM_THIN_2: Storage = { name: "local-lvm", type: "LVM-thin", newestOnly: false, full: 41 };
const ZFS_3: Storage = { name: "tank", type: "ZFS", newestOnly: true, full: 48 };
const APFS: Storage = { name: "the VMs' volume", type: "APFS", newestOnly: false, full: 58 };

export function threadsAt(): FakeThread[] {
  return [
    { id: "thr_login", title: "Fix the sign-in flow in Safari", running: true },
    { id: "thr_migrate", title: "Move the orders table to Postgres 17", running: true },
    { id: "thr_checkout", title: "iOS checkout: QA the new payment sheet", running: false },
    { id: "thr_docs", title: "Write the API guide's examples", running: false },
    { id: "thr_android", title: "Android: deep links from email", running: false },
    { id: "thr_cache", title: "Cache warm-up experiment", running: false },
    { id: "thr_cleanup", title: "Clean up the disk", running: true },
  ];
}

function box(base: Partial<FakeBox> & Pick<FakeBox, "id" | "name" | "kindLabel" | "backend" | "backendLabel" | "host" | "threadId" | "createdAt">): FakeBox {
  return {
    os: "Linux",
    badges: [],
    vmid: 200 + Math.floor(Math.random() * 90),
    storage: LVM_THIN_1,
    workspaces: base.threadId ? [base.threadId] : [],
    personControl: false,
    terminalOpen: false,
    state: "ready",
    step: null,
    screen: "none",
    cores: 4,
    memoryGiB: 8,
    diskGiB: 32,
    usedGB: 12,
    releasedAt: null,
    snapshotting: PROXMOX_LXC,
    noSnapshotsWhy: null,
    cannotTakeWhy: null,
    locked: null,
    execution: false,
    forkReset: true,
    forkedFrom: null,
    ...base,
  };
}

export function boxesAt(now: number): FakeBox[] {
  return [
    box({ id: "bxamberfox2q7k", name: "amber-fox", kindLabel: "Linux desktop", badges: ["Desktop", "LXC"], backend: "Proxmox LXC", backendLabel: "Proxmox LXC on pve-1", host: "pve-1", vmid: 214, threadId: "thr_login", workspaces: ["thr_login", "thr_docs"], personControl: true, terminalOpen: true, createdAt: now - 6 * HOUR, screen: "linux", memoryGiB: 16, cores: 8 }),
    box({ id: "bxbrisklake8m3", name: "brisk-lake", kindLabel: "Linux VM", badges: ["VM"], backend: "Proxmox QEMU", backendLabel: "Proxmox QEMU on pve-1", host: "pve-1", threadId: "thr_migrate", createdAt: now - 9 * HOUR, snapshotting: PROXMOX_QEMU, cores: 8, memoryGiB: 16, diskGiB: 64, usedGB: 21 }),
    box({ id: "bxtidyglade3z", name: "tidy-glade", kindLabel: "Linux", badges: ["LXC"], backend: "Proxmox LXC", backendLabel: "Proxmox LXC on pve-3", host: "pve-3", storage: ZFS_3, threadId: "thr_cache", createdAt: now - 7 * HOUR, usedGB: 9 }),
    box({ id: "bxsilverpine6z", name: "silver-pine", kindLabel: "macOS", os: "macOS", badges: ["Desktop", "VM"], backend: "Tart", backendLabel: "Tart on mac-2", host: "mac-2", storage: APFS, threadId: "thr_checkout", createdAt: now - 30 * HOUR, snapshotting: TART_MACOS, screen: "macos", cores: 6, memoryGiB: 16, diskGiB: 96, usedGB: 41 }),
    box({ id: "bxrosyreef4k1", name: "rosy-reef", kindLabel: "Android", os: "Android", badges: ["Pixel 9", "Emulator"], backend: "Proxmox QEMU", backendLabel: "Proxmox QEMU on pve-1", host: "pve-1", threadId: "thr_android", createdAt: now - 26 * HOUR, snapshotting: ANDROID_DEVICE, screen: "phone", diskGiB: 48 }),
    box({ id: "bxquickwren7d", name: "quick-wren", kindLabel: "Linux", badges: ["VM"], backend: "boat.dev", backendLabel: "boat.dev", host: "boat", storage: null, threadId: "thr_docs", createdAt: now - 3 * DAY, snapshotting: BOAT, cores: 2, memoryGiB: 4, diskGiB: 51 }),
    box({ id: "bxcalmharbor4w", name: "calm-harbor", kindLabel: "iOS", os: "iOS", badges: ["iPhone 17 Pro", "Shared"], backend: "Tart", backendLabel: "a shared iOS host on mac-1", host: "mac-1", storage: null, threadId: "thr_checkout", createdAt: now - 2 * HOUR, snapshotting: null, noSnapshotsWhy: "iOS boxes on a shared host have no snapshots: a Simulator device saves no running state, and a slot is a user on a shared Mac.", screen: "phone" }),
    box({ id: "bxworkpc5n2hq", name: "work-pc", kindLabel: "Linux desktop", badges: ["Desktop", "LXC"], backend: "Proxmox LXC", backendLabel: "Proxmox LXC on pve-1", host: "pve-1", threadId: null, workspaces: ["thr_cleanup"], execution: true, createdAt: now - 60 * DAY, screen: "linux", usedGB: 28 }),
    box({ id: "bxdevdesk9x1p", name: "dev-desk", kindLabel: "Linux desktop", badges: ["Desktop", "LXC"], backend: "Proxmox LXC", backendLabel: "Proxmox LXC on pve-2", host: "pve-2", storage: LVM_THIN_2, threadId: null, execution: true, createdAt: now - 40 * DAY, cannotTakeWhy: "pve-2's token cannot take snapshots: it lacks VM.Snapshot and VM.Snapshot.Rollback.", screen: "linux" }),
    box({ id: "bxbuildpool2s", name: "build-pool", kindLabel: "Linux", badges: ["Physical"], backend: "SSH host pool", backendLabel: "the SSH host pool", host: "pool", storage: null, threadId: "thr_docs", createdAt: now - 5 * HOUR, snapshotting: null, noSnapshotsWhy: "Boxes on the SSH host pool have no snapshots: bb-box has no root on the machine." }),
    box({ id: "bxgreyridge5t", name: "grey-ridge", kindLabel: "Linux", badges: ["LXC"], backend: "Proxmox LXC", backendLabel: "Proxmox LXC on pve-1", host: "pve-1", threadId: null, workspaces: [], createdAt: now - 30 * DAY, releasedAt: now - 18 * DAY, state: "released" }),
  ];
}

const USD_DAY: Price = { amount: 0.056, currency: "USD", per: "day" };
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function timeName(at: number, now: number): string {
  const date = new Date(at);
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === new Date(now).toDateString()) return `Today ${clock}`;
  return `${WEEKDAYS[date.getDay()]} ${clock}`;
}

function snap(base: Partial<FakeSnap> & Pick<FakeSnap, "id" | "boxId" | "name" | "takenAt" | "by">): FakeSnap {
  return { note: null, tookMs: 700, holds: "disk", sizeGB: null, price: null, keptUntil: null, undoOf: null, undoWay: null, heldCopyGB: null, sizeThen: null, forkSafe: true, onEarlierGuest: false, picture: null, state: "ready", error: null, ...base };
}

export function snapshotsAt(now: number): FakeSnap[] {
  return [
    snap({ id: "snamb01thursd", boxId: "bxamberfox2q7k", name: timeName(now - 5 * HOUR - 20 * MINUTE, now), takenAt: now - 5 * HOUR - 20 * MINUTE, by: BY_PERSON, sizeGB: 3.4, keptUntil: now + 29 * DAY, picture: 11, note: "Signed in to the staging site, cookies set.", sizeThen: { cores: 4, memoryGiB: 8 } }),
    snap({ id: "snamb02migrat", boxId: "bxamberfox2q7k", name: "before the migration", takenAt: now - 2 * HOUR - 5 * MINUTE, by: byAgent("thr_login"), sizeGB: 1.2, picture: 23 }),
    snap({ id: "snamb03playwr", boxId: "bxamberfox2q7k", name: "after installing Playwright", takenAt: now - 41 * MINUTE, by: byAgent("thr_login"), sizeGB: 0.4, picture: 37, tookMs: 640 }),
    snap({ id: "snbri01today0", boxId: "bxbrisklake8m3", name: timeName(now - 7 * HOUR, now), takenAt: now - 7 * HOUR, by: BY_PERSON, sizeGB: 2.2, forkSafe: false, note: "Taken before brisk-lake's image had the identity reset." }),
    snap({ id: "snbri02schema", boxId: "bxbrisklake8m3", name: "schema v41", takenAt: now - 3 * HOUR, by: byAgent("thr_migrate"), sizeGB: 0.9, note: "Before the column renames." }),
    snap({ id: "snbri03pgupgr", boxId: "bxbrisklake8m3", name: "before pg_upgrade", takenAt: now - 25 * MINUTE, by: byAgent("thr_migrate"), sizeGB: 13.8, holds: "disk-and-memory", tookMs: 14_700 }),
    snap({ id: "snbri04indexe", boxId: "bxbrisklake8m3", name: "before dropping old indexes", takenAt: now - 9 * MINUTE, by: byAgent("thr_migrate"), state: "failed", tookMs: null, error: "Proxmox: VM 214 is locked (backup)." }),
    snap({ id: "sntid01cachea", boxId: "bxtidyglade3z", name: "cache cold", takenAt: now - 6 * HOUR, by: byAgent("thr_cache"), sizeGB: 0.8 }),
    snap({ id: "sntid02cacheb", boxId: "bxtidyglade3z", name: "cache warm, first pass", takenAt: now - 3 * HOUR, by: byAgent("thr_cache"), sizeGB: 1.1 }),
    snap({ id: "sntid03cachec", boxId: "bxtidyglade3z", name: "cache warm, tuned", takenAt: now - 50 * MINUTE, by: byAgent("thr_cache"), sizeGB: 0.5 }),
    snap({ id: "snsil01clean0", boxId: "bxsilverpine6z", name: "clean install", takenAt: now - 28 * HOUR, by: BY_PERSON, holds: "disk-and-memory", sizeGB: 7.1, picture: 5, tookMs: 19_400 }),
    snap({ id: "snsil02xcode0", boxId: "bxsilverpine6z", name: "after Xcode signed in", takenAt: now - 4 * HOUR, by: byAgent("thr_checkout"), holds: "disk-and-memory", sizeGB: 7.9, picture: 19, tookMs: 21_200 }),
    snap({ id: "snros01signed", boxId: "bxrosyreef4k1", name: "app signed in", takenAt: now - 20 * HOUR, by: byAgent("thr_android"), holds: "disk-and-memory", sizeGB: 2.5, picture: 8, tookMs: 14_800 }),
    snap({ id: "snros02deepln", boxId: "bxrosyreef4k1", name: "before the deep link test", takenAt: now - 90 * MINUTE, by: byAgent("thr_android"), holds: "disk-and-memory", sizeGB: 2.4, picture: 14, tookMs: 14_600 }),
    snap({ id: "snwor01upgrad", boxId: "bxworkpc5n2hq", name: "before the upgrade", takenAt: now - 2 * HOUR, by: byAgent("thr_cleanup"), sizeGB: 2.0, picture: 31 }),
    snap({ id: "snqui01green0", boxId: "bxquickwren7d", name: "docs build green", takenAt: now - 2 * DAY, by: byAgent("thr_docs"), price: USD_DAY, tookMs: 41_000 }),
    snap({ id: "snqui03kept00", boxId: "bxquickwren7d", name: "release notes draft", takenAt: now - 5 * DAY, by: BY_PERSON, price: USD_DAY, keptUntil: now + 20 * DAY, tookMs: 36_000 }),
    snap({ id: "sngre01rcset0", boxId: "bxgreyridge5t", name: "release candidate set-up", takenAt: now - 19 * DAY, by: BY_PERSON, heldCopyGB: 13.1, keptUntil: now + 3 * DAY - 2 * HOUR, note: "Everything for the 4.2 release checks, built." }),
  ];
}
