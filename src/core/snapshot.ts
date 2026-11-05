import type { Guest, Holds, Price, SnapshotGuest, SnapshotScope, SnapshotSize, TaskRef } from "../backends/types.ts";
import type { SnapshotGpu } from "./gpu.ts";
import type { Actor } from "./box-log.ts";
import type { Charge } from "./snapshot-cost.ts";
import type { HeldIdentity, NotForkSafe } from "./identity.ts";

export const SNAPSHOT_STATES = ["taking", "ready", "failed", "incomplete", "deleting", "unavailable", "lost"] as const;
export type SnapshotState = (typeof SNAPSHOT_STATES)[number];

export const OPERATION_KINDS = ["take", "restore", "fork", "delete", "hold-copy", "adopt", "expire", "keep"] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

export const OPERATION_STATES = ["running", "done", "failed", "unknown"] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

export const BOX_GONE_HOW = ["released", "forgotten", "unknown"] as const;
export type BoxGoneHow = (typeof BOX_GONE_HOW)[number];

export const PICTURE_STATES = ["taken", "none", "off", "failed"] as const;
export type PictureState = (typeof PICTURE_STATES)[number];

export const UNDOS_PER_BOX = 2;
export const NAME_CHARACTERS = 60;
export const NOTE_BYTES = 1024;
export const METADATA_POINTS_BELOW_ROOM = 5;
export const SWEEP_POINTS_ABOVE_ROOM = 7;
export const LOST_AFTER_MISSING_MS = 10 * 60_000;
export const FAILED_KEPT_MS = 24 * 60 * 60_000;
export const LOST_KEPT_MS = 7 * 24 * 60 * 60_000;
export const DAY_MS = 24 * 60 * 60_000;
export const KEEP_ENDS_SOON_DAYS = 3;
export const KEEP_ENDS_WITHIN_DAYS = 7;
export const OPERATIONS_KEPT_MS = 30 * 24 * 60 * 60_000;

export interface RoomThresholds {
  readonly takes: number;
  readonly metadata: number;
  readonly sweep: number;
}

export function roomThresholds(roomPercent: number): RoomThresholds {
  return { takes: roomPercent, metadata: roomPercent - METADATA_POINTS_BELOW_ROOM, sweep: roomPercent + SWEEP_POINTS_ABOVE_ROOM };
}

export interface SnapshotBox {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly system: string;
  readonly thread: string;
}

export interface SnapshotRecord {
  readonly id: string;
  readonly box: SnapshotBox;
  readonly boxGone: { readonly at: number; readonly how: BoxGoneHow } | null;
  readonly backend: { readonly id: string; readonly label: string };
  readonly host: string | null;
  readonly storage: { readonly name: string; readonly type: string } | null;
  readonly guest: SnapshotGuest;
  readonly livesOn: Guest;
  readonly name: string;
  readonly note: string | null;
  readonly takenAt: number;
  readonly capturedAt: number | null;
  readonly tookMs: number | null;
  readonly by: Actor;
  readonly scope: SnapshotScope;
  readonly holds: Holds;
  readonly excludes: string | null;
  readonly size: SnapshotSize | null;
  readonly price: Price | null;
  readonly owner: "thread" | "person";
  readonly keptUntil: number | null;
  readonly keptAt: number | null;
  readonly undoOf: string | null;
  readonly forkSafe: number | null;
  readonly forkSafeWhy?: NotForkSafe | null;
  readonly identity?: HeldIdentity | null;
  readonly unflushed?: string | null;
  readonly gpu?: SnapshotGpu;
  readonly dependsOn: readonly string[];
  readonly picture: PictureState | null;
  readonly ref: string | null;
  readonly state: SnapshotState;
  readonly error: string | null;
  readonly stateAt: number;
  readonly missingSince: number | null;
  readonly foundAt: number | null;
}

export interface Reservation {
  readonly storage: string;
  readonly bytes: number;
  readonly price: Price | null;
}

export interface SnapshotOperation {
  readonly id: string;
  readonly request: string | null;
  readonly requestDigest: string | null;
  readonly kind: OperationKind;
  readonly box: string;
  readonly guest: string | null;
  readonly snapshots: readonly string[];
  readonly by: Actor;
  readonly consent: unknown;
  readonly undo: string | null;
  readonly guests: { readonly old: Guest | null; readonly new: Guest | null } | null;
  readonly step: string;
  readonly task: TaskRef | null;
  readonly state: OperationState;
  readonly reserved: Reservation | null;
  readonly error: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly snapshotsGoneAt: number | null;
  readonly stepAt?: number | null;
  readonly attempts?: readonly CopyAttempt[] | null;
}

export interface CopyAttempt {
  readonly at: number;
  readonly task: TaskRef | null;
}

export interface StoredPicture {
  readonly snapshot: string;
  readonly jpeg: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly at: number;
}

export interface SnapshotLedger {
  readonly problem: string | null;
  record(id: string): SnapshotRecord | null;
  records(filter?: { readonly box?: string; readonly backend?: string }): SnapshotRecord[];
  operation(id: string): SnapshotOperation | null;
  operations(filter: { readonly box: string; readonly kind: OperationKind }): SnapshotOperation[];
  byRequest(request: string): SnapshotOperation | null;
  operationWithTask(task: string): SnapshotOperation | null;
  unsettled(): SnapshotOperation[];
  pins(): ReadonlyMap<string, SnapshotOperation>;
  reservedBytes(storage: string): number;
  changedSince(snapshot: string, at: number): boolean;
  transaction<T>(work: () => T): T;
  insertRecord(record: SnapshotRecord): void;
  updateRecord(id: string, change: Partial<SnapshotRecord>): SnapshotRecord | null;
  removeRecord(id: string): void;
  insertOperation(operation: SnapshotOperation): void;
  updateOperation(id: string, change: Partial<SnapshotOperation>): SnapshotOperation | null;
  charges(backend?: string): Charge[];
  prune(now: number): number;
  putPicture(picture: StoredPicture): boolean;
  picture(snapshot: string): StoredPicture | null;
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function idWith(prefix: string, random: (bytes: number) => Uint8Array): string {
  return `${prefix}${[...random(12)].map((byte) => ID_ALPHABET[byte % 32]).join("")}`;
}

export function newSnapshotId(random: (bytes: number) => Uint8Array): string {
  return idWith("sn", random);
}

export function newOperationId(random: (bytes: number) => Uint8Array): string {
  return idWith("op", random);
}

export function isSnapshotId(text: string): boolean {
  return /^sn[a-z2-7]{12}$/.test(text);
}

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly why: string };

const YES: Verdict = { ok: true };

function no(why: string): Verdict {
  return { ok: false, why };
}

export function clockWords(at: number): string {
  return `${new Date(at).toISOString().slice(11, 16)} UTC`;
}

export function dayWords(at: number): string {
  return `${new Date(at).toISOString().slice(0, 10)} ${clockWords(at)}`;
}

export function timeName(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(timeZone ? { timeZone } : {}) }).format(at);
}

export function clockName(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(timeZone ? { timeZone } : {}) }).format(at);
}

export function undoName(at: number, timeZone?: string): string {
  return `before the restore at ${clockName(at, timeZone)}`;
}

export function nameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed.length) return "Give the snapshot a name with at least one character, or leave the name out for the time.";
  if ([...trimmed].length > NAME_CHARACTERS) return `A snapshot's name has at most ${NAME_CHARACTERS} characters; "${trimmed}" has ${[...trimmed].length}.`;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return "A snapshot's name is one line, with no control characters.";
  return null;
}

export function noteProblem(note: string): string | null {
  const bytes = new TextEncoder().encode(note).length;
  return bytes > NOTE_BYTES ? `A snapshot's note holds at most ${NOTE_BYTES} bytes; this one is ${bytes}.` : null;
}

export function uniqueName(wanted: string, taken: ReadonlySet<string>): string {
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const room = NAME_CHARACTERS - [...suffix].length;
    const candidate = `${[...wanted].slice(0, room).join("")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function isKept(snapshot: Pick<SnapshotRecord, "keptUntil">): boolean {
  return snapshot.keptUntil !== null;
}

export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function endOfUtcDay(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const start = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(start) || utcDay(start) !== day ? null : start + DAY_MS - 1;
}

export function keptUntilAfter(now: number, days: number): number {
  return endOfUtcDay(utcDay(now + days * DAY_MS))!;
}

export function keepLabel(keptUntil: number | null): string | null {
  return keptUntil === null ? null : utcDay(keptUntil);
}

export function daysLeft(snapshot: Pick<SnapshotRecord, "keptUntil">, now: number): number | null {
  return snapshot.keptUntil === null ? null : Math.max(0, Math.ceil((snapshot.keptUntil - now) / DAY_MS));
}

export function keepEndsWithin(snapshot: Pick<SnapshotRecord, "keptUntil">, now: number, days: number): boolean {
  return snapshot.keptUntil !== null && snapshot.keptUntil - now < days * DAY_MS;
}

export function keepEndsWords(snapshot: Pick<SnapshotRecord, "keptUntil">, now: number): string | null {
  const left = daysLeft(snapshot, now);
  if (left === null) return null;
  if (!keepEndsWithin(snapshot, now, KEEP_ENDS_SOON_DAYS)) return `kept until ${utcDay(snapshot.keptUntil!)}`;
  return left <= 1 ? "goes within a day" : `goes in ${left} days`;
}

export function heldByProvider(snapshot: Pick<SnapshotRecord, "state">): boolean {
  return snapshot.state === "taking" || snapshot.state === "ready" || snapshot.state === "incomplete" || snapshot.state === "unavailable" || snapshot.state === "deleting";
}

export function countsAgainstLimit(snapshot: Pick<SnapshotRecord, "undoOf" | "keptUntil" | "state">): boolean {
  if (snapshot.undoOf !== null && snapshot.keptUntil === null) return false;
  return snapshot.state === "taking" || snapshot.state === "ready" || snapshot.state === "incomplete" || snapshot.state === "unavailable";
}

const OPERATION_WORDS: Readonly<Record<OperationKind, string>> = {
  take: "take",
  restore: "restore",
  fork: "fork",
  delete: "delete",
  "hold-copy": "copy for Keep",
  keep: "keep",
  adopt: "swap of guests",
  expire: "expiry",
};

export function operationWords(operation: Pick<SnapshotOperation, "kind" | "startedAt">): string {
  return `the ${OPERATION_WORDS[operation.kind]} that began at ${clockWords(operation.startedAt)}`;
}

export const CHANGES = ["delete", "expire", "evict-limit", "evict-room", "replace-undo", "keep", "unkeep", "rename", "note"] as const;
export type Change = (typeof CHANGES)[number];

export interface ChangeContext {
  readonly pin: Pick<SnapshotOperation, "kind" | "startedAt"> | null;
  readonly now: number;
}

function quoted(snapshot: Pick<SnapshotRecord, "name">): string {
  return `"${snapshot.name}"`;
}

function whereWords(snapshot: Pick<SnapshotRecord, "host" | "backend">): string {
  return snapshot.host ?? snapshot.backend.label;
}

function notTakenByAnAgent(snapshot: SnapshotRecord): Verdict {
  return snapshot.by.is === "agent" ? YES : no(`${quoted(snapshot)} was not taken by an agent, so bb-box never deletes it by itself.`);
}

function automaticDeletion(snapshot: SnapshotRecord, byAuthor = false): Verdict {
  if (isKept(snapshot)) return no(`${quoted(snapshot)} is kept, so bb-box never deletes it by itself.`);
  if (snapshot.owner === "person" && !(byAuthor && snapshot.by.is === "agent")) return no(`${quoted(snapshot)} is the person's, so bb-box never deletes it by itself.`);
  if (snapshot.undoOf !== null) return no(`${quoted(snapshot)} is an undo, which only a newer undo replaces.`);
  if (snapshot.state !== "ready") return no(`${quoted(snapshot)} is ${snapshot.state}.`);
  return notTakenByAnAgent(snapshot);
}

export function eligible(snapshot: SnapshotRecord, change: Change, context: ChangeContext): Verdict {
  if (context.pin) return no(`${quoted(snapshot)} is in use by ${operationWords(context.pin)}.`);
  switch (change) {
    case "delete":
      if (snapshot.state === "taking") return no(`${quoted(snapshot)} is still being taken.`);
      if (snapshot.state === "deleting") return no(`${quoted(snapshot)} is being deleted already.`);
      if (snapshot.state === "unavailable") return no(`bb-box cannot reach ${whereWords(snapshot)} now, so it cannot delete ${quoted(snapshot)}. Try again once it answers.`);
      return YES;
    case "expire":
      if (snapshot.keptUntil === null || snapshot.keptUntil > context.now) return no(`${quoted(snapshot)} is not past its keep date.`);
      if (snapshot.state !== "ready" && snapshot.state !== "incomplete") return no(`${quoted(snapshot)} is ${snapshot.state}.`);
      return YES;
    case "evict-limit":
      return automaticDeletion(snapshot, true);
    case "evict-room":
      return automaticDeletion(snapshot);
    case "replace-undo":
      if (snapshot.undoOf === null) return no(`${quoted(snapshot)} is not an undo.`);
      if (isKept(snapshot)) return no(`${quoted(snapshot)} is kept, so it is no longer replaced as an undo.`);
      if (snapshot.state !== "ready" && snapshot.state !== "incomplete") return no(`${quoted(snapshot)} is ${snapshot.state}.`);
      return YES;
    case "keep":
      if (snapshot.state !== "ready") return no(`${quoted(snapshot)} is ${snapshot.state}, and only a ready snapshot can be kept.`);
      return YES;
    case "unkeep":
      return isKept(snapshot) ? YES : no(`${quoted(snapshot)} is not kept.`);
    case "rename":
    case "note":
      return snapshot.state === "deleting" ? no(`${quoted(snapshot)} is being deleted.`) : YES;
  }
}

export interface Judged {
  readonly allowed: readonly SnapshotRecord[];
  readonly skipped: readonly { readonly snapshot: SnapshotRecord; readonly why: string }[];
}

export function judgeEach(snapshots: readonly SnapshotRecord[], change: Change, pins: ReadonlyMap<string, SnapshotOperation>, now: number): Judged {
  const allowed: SnapshotRecord[] = [];
  const skipped: { snapshot: SnapshotRecord; why: string }[] = [];
  for (const snapshot of snapshots) {
    const verdict = eligible(snapshot, change, { pin: pins.get(snapshot.id) ?? null, now });
    if (verdict.ok) allowed.push(snapshot);
    else skipped.push({ snapshot, why: verdict.why });
  }
  return { allowed, skipped };
}

function oldestFirst(a: SnapshotRecord, b: SnapshotRecord): number {
  return a.takenAt - b.takenAt || a.id.localeCompare(b.id);
}

export function limitVictim(boxSnapshots: readonly SnapshotRecord[], threadId: string, pins: ReadonlyMap<string, SnapshotOperation>, now: number): SnapshotRecord | null {
  const theirs = boxSnapshots.filter((snapshot) => snapshot.by.is === "agent" && snapshot.by.threadId === threadId);
  return judgeEach([...theirs].sort(oldestFirst), "evict-limit", pins, now).allowed[0] ?? null;
}

export function undoToReplace(boxSnapshots: readonly SnapshotRecord[], pins: ReadonlyMap<string, SnapshotOperation>, now: number): SnapshotRecord | null {
  const undos = boxSnapshots.filter((snapshot) => snapshot.undoOf !== null);
  return judgeEach([...undos].sort(oldestFirst), "replace-undo", pins, now).allowed[0] ?? null;
}

export function roomCandidates(storageSnapshots: readonly SnapshotRecord[], pins: ReadonlyMap<string, SnapshotOperation>, now: number): SnapshotRecord[] {
  return [...judgeEach([...storageSnapshots].sort(oldestFirst), "evict-room", pins, now).allowed];
}

export function storageGroup(backend: string, host: string | null, storage: string): string {
  return `${backend}|${host ?? ""}|${storage}`;
}

export type Caller = { readonly is: "person" } | { readonly is: "command" } | { readonly is: "agent"; readonly threadId: string };

export const ACTS = ["take", "see", "see-picture", "restore", "fork", "delete", "keep", "unkeep", "rename", "note"] as const;
export type Act = (typeof ACTS)[number];

export interface Standing {
  readonly box: { readonly id: string; readonly threadId: string } | null;
  readonly runsOn: boolean;
}

export const NOT_THE_AGENTS = "That is the person's to do: ask them, in the thread.";
export const MACHINE_RESTORES_SHIP = false;
export const MACHINE_RESTORES_OFF = "bb-box does not restore a box threads run on yet: that stays off until bb-box can hold every turn on it while it restores.";
export const MACHINES_RESTORE_DISK_ONLY = "A box threads run on is restored from disk snapshots only: a snapshot with its memory would bring back BB's daemon in the middle of its work.";

function tookIt(snapshot: SnapshotRecord | null, threadId: string): boolean {
  return snapshot?.by.is === "agent" && snapshot.by.threadId === threadId;
}

export function mayAct(caller: Caller, act: Act, standing: Standing, snapshot: SnapshotRecord | null = null): Verdict {
  if (caller.is !== "agent") return YES;
  const box = standing.box;
  const unseen = no("This thread has no such snapshot.");
  if (!box || (snapshot && snapshot.boxGone)) return unseen;
  const thread = caller.threadId;
  if (!standing.runsOn && box.threadId !== thread) return unseen;
  if (standing.runsOn && snapshot && !tookIt(snapshot, thread)) return unseen;
  if (snapshot && isKept(snapshot) && act !== "see") return no(`${quoted(snapshot)} is kept, so it is the person's. ${NOT_THE_AGENTS}`);
  if (standing.runsOn) {
    switch (act) {
      case "take":
      case "see":
      case "see-picture":
      case "delete":
      case "restore":
        return YES;
      default:
        return no(NOT_THE_AGENTS);
    }
  }
  switch (act) {
    case "take":
    case "see":
    case "see-picture":
    case "restore":
    case "fork":
      return YES;
    case "delete":
      if (!snapshot || tookIt(snapshot, thread)) return YES;
      return no(`${quoted(snapshot)} was not taken by an agent of this thread. ${NOT_THE_AGENTS}`);
    default:
      return no(NOT_THE_AGENTS);
  }
}

export interface RestoreRules {
  readonly agentsRestore: boolean;
  readonly agentsMemory: boolean;
  readonly machineRestores: boolean;
}

export interface RestoreCase {
  readonly onAMachine: boolean;
  readonly memory: boolean;
}

export type RestoreRoute = { readonly ok: true; readonly through: "restore" | "form" } | { readonly ok: false; readonly why: string };

export function restoreRoute(caller: Caller, rules: RestoreRules, restore: RestoreCase): RestoreRoute {
  if (restore.onAMachine && !rules.machineRestores) return { ok: false, why: MACHINE_RESTORES_OFF };
  if (restore.onAMachine && restore.memory) return { ok: false, why: MACHINES_RESTORE_DISK_ONLY };
  if (caller.is !== "agent") return { ok: true, through: "restore" };
  if (restore.memory && !rules.agentsMemory) return { ok: false, why: `Settings let only the person restore a snapshot that holds memory. ${NOT_THE_AGENTS}` };
  if (restore.onAMachine || !rules.agentsRestore) return { ok: true, through: "form" };
  return { ok: true, through: "restore" };
}

export function holdsWords(snapshot: Pick<SnapshotRecord, "holds" | "scope">): string {
  if (snapshot.scope === "device") return "device";
  return snapshot.holds === "disk" ? "disk" : "disk and memory";
}

export function byWords(by: Actor): string {
  switch (by.is) {
    case "person":
      return "by you";
    case "agent":
      return `by the agent in thread ${by.threadId}`;
    case "command":
      return "by a bb box command";
    case "bb-box":
      return `by bb-box: ${by.why}`;
    case "outside":
      return "outside bb-box";
    case "unknown":
      return "by someone bb-box has no record of";
  }
}

export function gbWords(bytes: number): string {
  const gb = bytes / 1e9;
  if (gb < 1) return `${Math.max(1, Math.round(gb * 1000))} MB`;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

export function sizeWords(size: SnapshotSize | null): string {
  if (!size) return "size unknown";
  return size.means === "own" ? gbWords(size.bytes) : `${gbWords(size.bytes)}, some shared with its box`;
}

export function priceWords(price: Price | null): string {
  if (!price) return "no charge";
  if (!price.known) return "price unknown";
  const symbol = price.currency === "USD" ? "$" : "EUR ";
  const per = price.per === "GB-month" ? "a GB a month" : `a ${price.per}`;
  return `${symbol}${price.amount} ${per}${price.included ? ` past the plan's ${price.included}` : ""}`;
}

export function stateWords(snapshot: Pick<SnapshotRecord, "state" | "error" | "host" | "backend">): string {
  const error = snapshot.error ? `: ${snapshot.error.replace(/\.$/, "")}` : "";
  switch (snapshot.state) {
    case "taking":
      return "being taken";
    case "ready":
      return "ready";
    case "failed":
      return `failed${error}`;
    case "incomplete":
      return `incomplete${error}. Delete it to finish ${whereWords(snapshot)}'s clean-up`;
    case "deleting":
      return "being deleted";
    case "unavailable":
      return `unavailable: bb-box cannot reach ${whereWords(snapshot)}${snapshot.error ? ` (${snapshot.error.replace(/\.$/, "")})` : ""}`;
    case "lost":
      return `lost: ${whereWords(snapshot)} no longer has it`;
  }
}

export function unflushedWords(why: string): string {
  return `bb-box could not flush the box's writes to its disk before it (${why.replace(/\.$/, "").slice(0, 300)}), so it may miss what was written in the last seconds before it`;
}

const FORKING_SYSTEMS: readonly string[] = ["linux", "macos"];

export function forksOn(system: string): boolean {
  return FORKING_SYSTEMS.includes(system);
}

export const FORKS_ONLY = "bb-box forks Linux and macOS boxes only, as only they reset their identity at a fork's first boot";

export function notForkSafe(snapshot: SnapshotRecord): boolean {
  return snapshot.forkSafe === null && forksOn(snapshot.box.system) && snapshot.scope === "box";
}

export function goneWords(gone: NonNullable<SnapshotRecord["boxGone"]>): string {
  return gone.how === "unknown" ? "its box is gone" : `its box was ${gone.how} ${utcDay(gone.at)}`;
}

export function snapshotLine(snapshot: SnapshotRecord): string {
  const parts = [
    `"${snapshot.name}" (${snapshot.id})`,
    stateWords(snapshot),
    `taken ${dayWords(snapshot.takenAt)}`,
    byWords(snapshot.by),
    holdsWords(snapshot),
    sizeWords(snapshot.size),
    ...(snapshot.price ? [priceWords(snapshot.price)] : []),
    ...(snapshot.keptUntil !== null ? [`kept until ${utcDay(snapshot.keptUntil)}`] : []),
    ...(snapshot.foundAt !== null ? [`found on ${whereWords(snapshot)}, not in bb-box's records`] : []),
    ...(snapshot.undoOf !== null ? ["an undo"] : []),
    ...(snapshot.dependsOn.length ? [`taken after ${snapshot.dependsOn.join(" and ")}`] : []),
    ...(snapshot.boxGone ? [goneWords(snapshot.boxGone)] : []),
    ...(snapshot.guest === "held-copy" ? [`a held copy, guest ${snapshot.livesOn.ref}`] : []),
    ...(snapshot.guest === "earlier" ? [`on ${snapshot.box.name}'s earlier guest ${snapshot.livesOn.ref}: fork only`] : []),
    ...(notForkSafe(snapshot) ? [`not fork-safe: ${snapshot.box.name} had no working identity reset when it was taken`] : []),
    ...(snapshot.unflushed ? ["may miss its last writes"] : []),
  ];
  return parts.join(" · ");
}

export function snapshottingWords(holds: readonly Holds[], whileRunning: string): string {
  const what = holds.includes("disk-and-memory") ? (holds.includes("disk") ? "its disk, or its disk and memory" : "its disk and memory") : "its disk";
  const when = whileRunning === "live" ? "while it runs" : whileRunning === "pauses" ? "pausing it for a moment" : whileRunning === "suspends" ? "suspending it for a few seconds" : "only while it is stopped";
  return `${what}, ${when}`;
}
