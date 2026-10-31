import { createHash, randomBytes } from "node:crypto";
import {
  RestoreChanged,
  SnapshotFailed,
  SnapshotIncomplete,
  type Backend,
  type BoxSize,
  type CopyHooks,
  type DoctorCheck,
  type Guest,
  type GuestFact,
  type HeldCopyLabel,
  type HeldSnapshot,
  type KeepsPastRelease,
  type OutsideRollback,
  type Price,
  type SnapshotBill,
  type SnapshotRef,
  type SnapshotHooks,
  type SnapshotPlan,
  type Snapshotting,
  type SnapshotStorage,
  type TaskKind,
  type TaskOutcome,
  type TaskRef,
} from "../backends/types.ts";
import { BoxError, ReleaseWaits, type BoxRecord, type ForkAdmission, type ForkRequest, OPERATOR, forkNameProblem, identity, newBoxId, restoringWords, type RestoringMark } from "./boxes.ts";
import { describeSize } from "./sizes.ts";
import { readForkSafe, type ForkSafety } from "./identity.ts";
import { pictureOfScreen, withinWait, type ScreenPicture } from "./snapshot-picture.ts";
import { UNKNOWN_ACTOR, BY_OUTSIDE, byBbBox, type Actor, type BoxEventKind, type BoxLog } from "./box-log.ts";
import { ceilingOf, SNAPSHOT_LIMITS, snapshotConfig, type SnapshotConfig } from "./document.ts";
import { accountAtFullPrice, billedRate, ceilingVerdict, heldRate, pastCeiling, pendingOn, spentThisMonth, type HeldRate } from "./snapshot-cost.ts";
import {
  FAILED_KEPT_MS,
  LOST_AFTER_MISSING_MS,
  LOST_KEPT_MS,
  UNDOS_PER_BOX,
  countsAgainstLimit,
  dayWords,
  eligible,
  endOfUtcDay,
  keepLabel,
  keptUntilAfter,
  utcDay,
  gbWords,
  heldByProvider,
  holdsWords,
  isKept,
  limitVictim,
  MACHINE_RESTORES_SHIP,
  mayAct,
  nameProblem,
  newOperationId,
  newSnapshotId,
  noteProblem,
  NOT_THE_AGENTS,
  operationWords,
  priceWords,
  restoreRoute,
  roomCandidates,
  roomThresholds,
  stateWords,
  storageGroup,
  timeName,
  undoName,
  undoToReplace,
  uniqueName,
  type Caller,
  type Change,
  type SnapshotLedger,
  type CopyAttempt,
  type SnapshotOperation,
  type PictureState,
  type SnapshotRecord,
  type Standing,
  type StoredPicture,
} from "./snapshot.ts";

const MiB = 1024 * 1024;
const COPY_MS_PER_GIB = 2_400;
const ROOM_DELETES_PER_SWEEP = 5;
const OUTSIDE_LOOK_BACK_MS = 24 * 60 * 60_000;
const OUTSIDE_SLACK_MS = 60_000;

export type HoldStep = "planned" | "task" | "checked" | "stopped" | "copied" | "undo" | "rolled-back" | "adopted" | "started";

export interface SnapshotBoxes {
  find(boxId: string): Promise<BoxRecord | null>;
  all(): Promise<BoxRecord[]>;
  inTurn<T>(boxId: string, task: () => Promise<T>): Promise<T>;
  update(box: Pick<BoxRecord, "threadId" | "id">, change: (current: BoxRecord) => Partial<BoxRecord>): Promise<BoxRecord | null>;
  writeAccess(box: BoxRecord, signal?: AbortSignal): Promise<void>;
  machineBack(box: BoxRecord): boolean;
  fork(request: ForkRequest): Promise<BoxRecord>;
  admitFork(request: ForkAdmission): Promise<void>;
}

export interface ThreadOnTheBox {
  readonly id: string;
  readonly title: string;
  readonly running: boolean;
}

export interface RestoreGuard {
  readonly threads: readonly ThreadOnTheBox[] | null;
  readonly threadsUnread: string | null;
  readonly control: boolean;
  readonly terminals: number | null;
}

export interface YesInTheThread {
  readonly thread: string;
  readonly title: string | null;
  readonly plan: string;
  readonly at: number;
}

export interface RestoreInput {
  readonly undo?: boolean;
  readonly force?: boolean;
  readonly request?: string;
  readonly yes?: YesInTheThread;
  readonly accept?: readonly string[];
  readonly unflushed?: "stop" | "go-on";
  readonly whenStopped?: () => void;
}

export interface RestoreAnswer {
  readonly snapshot: SnapshotRecord | null;
  readonly undo: SnapshotRecord | null;
  readonly operation: SnapshotOperation;
  readonly box: BoxRecord | null;
  readonly from: BoxSize | null;
  readonly to: BoxSize | null;
  readonly anyway: readonly string[];
  readonly replaced: readonly string[];
  readonly earlier?: number | null;
  readonly newGuest?: boolean;
  readonly unflushed?: string | null;
  readonly repeated: boolean;
}

export interface SnapshotsDeps {
  readonly ledger: SnapshotLedger;
  readonly boxes: SnapshotBoxes;
  readonly backends: { get(id: string): Backend | null; active(): Backend[] };
  readonly events?: BoxLog;
  notify(threadId: string): void;
  logError(operation: string, error: unknown): void;
  log?(message: string): void;
  hold?(operation: SnapshotOperation, step: HoldStep, signal: AbortSignal): Promise<void>;
  guard?(box: BoxRecord): Promise<RestoreGuard>;
  machineRestores?(): boolean;
  marksChanged?(): void;
  screen?(box: BoxRecord, signal: AbortSignal): Promise<Uint8Array | null>;
  undoByCopy?(backendId: string): boolean;
  settings?(): SnapshotConfig;
  priced?(backend: Backend, offer: Snapshotting): Snapshotting;
  billed?(backend: Backend, bill: SnapshotBill): SnapshotBill;
  now?(): number;
  random?(bytes: number): Uint8Array;
  readonly timeZone?: string;
}

export const BILL_FRESH_MS = 10 * 60_000;

export interface PaidOnBackend {
  readonly held: HeldRate;
  readonly spent: number;
  readonly ceiling: number;
  readonly past: boolean;
}

const DEFAULT_SETTINGS = snapshotConfig({ general: {} });

export interface TakeInput {
  readonly name?: string;
  readonly note?: string;
  readonly memory?: boolean;
  readonly request?: string;
}

export interface TakeAnswer {
  readonly snapshot: SnapshotRecord | null;
  readonly operation: SnapshotOperation;
  readonly counted: number;
  readonly repeated: boolean;
  readonly evicted?: { readonly name: string; readonly id: string } | null;
  readonly evictionRefused?: string | null;
}

export interface DeleteAnswer {
  readonly snapshot: SnapshotRecord | null;
  readonly operation: SnapshotOperation | null;
  readonly repeated: boolean;
}

export interface ForkInput {
  readonly name?: string;
  readonly asMachine?: boolean;
  readonly request?: string;
  readonly projectId?: string | null;
}

export interface ForkCheck {
  readonly snapshot: SnapshotRecord;
  readonly box: BoxRecord | null;
  readonly threadId: string;
  readonly asMachine: boolean;
  readonly size: BoxSize;
  readonly aboutMs: number;
  readonly bytes: number | null;
  readonly host: string | null;
  readonly storage: string;
}

export interface ForkAnswer {
  readonly box: BoxRecord | null;
  readonly snapshot: SnapshotRecord | null;
  readonly operation: SnapshotOperation;
  readonly repeated: boolean;
}

interface ForkConsent {
  readonly box: string;
  readonly threadId: string;
  readonly name: string | null;
}

function forkConsentOf(operation: Pick<SnapshotOperation, "consent">): ForkConsent | null {
  const fork = (operation.consent as { fork?: Partial<ForkConsent> } | null)?.fork;
  return fork && typeof fork.box === "string" && typeof fork.threadId === "string" ? { box: fork.box, threadId: fork.threadId, name: typeof fork.name === "string" ? fork.name : null } : null;
}

export interface KeepInput {
  readonly days?: number;
  readonly until?: string;
}

export interface KeepCheck {
  readonly snapshot: SnapshotRecord;
  readonly keptUntil: number;
  readonly renews: boolean;
  readonly shortens: boolean;
  readonly way: KeepsPastRelease;
  readonly gone: boolean;
  readonly aboutMs: number | null;
  readonly bytes: number | null;
  readonly usedBytes: number | null;
  readonly host: string | null;
  readonly storage: string | null;
  readonly price: Price | null;
  readonly warning: string | null;
}

export interface KeepAnswer {
  readonly snapshot: SnapshotRecord;
  readonly check: KeepCheck;
  readonly repeated: boolean;
}

export interface HeldOnBackend {
  readonly count: number;
  readonly words: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function heldCopyLabelOf(record: SnapshotRecord): HeldCopyLabel {
  return { box: record.box.id, snapshot: record.id, kept: keepLabel(record.keptUntil), takenAt: record.takenAt, forkSafe: record.forkSafe, kind: record.box.kind };
}

function withAttemptTask(attempts: readonly CopyAttempt[] | null | undefined, task: TaskRef): CopyAttempt[] {
  const all = [...(attempts ?? [])];
  const last = all.pop();
  return [...all, { at: last?.at ?? 0, task }];
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function percentPast(percent: number, past: number): string {
  return Math.round(percent) > past ? `${Math.round(percent)}%` : `${(Math.ceil(percent * 10) / 10).toFixed(1)}%`;
}

function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

function quoted(snapshot: Pick<SnapshotRecord, "name">): string {
  return `"${snapshot.name}"`;
}

function where(snapshot: Pick<SnapshotRecord, "host" | "backend">): string {
  return snapshot.host ?? snapshot.backend.label;
}

const SHARES_BLOCKS = new Set(["lvmthin", "zfspool", "rbd", "btrfs"]);

export function freedWords(snapshot: Pick<SnapshotRecord, "size" | "state" | "storage">): string {
  if (snapshot.state === "failed" || snapshot.state === "lost") return "it held nothing to free";
  if (!snapshot.size) return snapshot.storage && SHARES_BLOCKS.has(snapshot.storage.type) ? "it freed what it no longer shared with its box" : "what it freed is not known";
  return snapshot.size.means === "own" ? `it freed ${gbWords(snapshot.size.bytes)}` : "it freed what it no longer shared with its box";
}

function callerKey(by: Actor): string {
  return by.is === "agent" ? `agent:${by.threadId}` : by.is;
}

export function requestKey(by: Actor, request: string): string {
  return `${callerKey(by)}:${request}`;
}

function requestDigest(kind: SnapshotOperation["kind"], box: string, args: unknown): string {
  return createHash("sha256").update(JSON.stringify({ kind, box, args })).digest("hex");
}

function reusedRequest(request: string): BoxError {
  return new BoxError("reused_request", `Request ID "${request}" was used already, for another take, delete or restore. Make a new one for this.`);
}

const RESTORE_STEPS = [
  "planned",
  "stopping",
  "stopped",
  "undo-submitting",
  "undo-task",
  "undo-ready",
  "copy-claimed",
  "copy-submitting",
  "copy-task",
  "copy-cloned",
  "copy-disarmed",
  "copy-ready",
  "rollback-submitting",
  "rollback-task",
  "rolled-back",
  "adopt-claimed",
  "adopt-submitting",
  "adopt-task",
  "adopted",
  "swapped",
  "retired",
  "starting",
  "access",
  "size",
  "labels",
  "machine",
  "swap-back",
  "done",
] as const;
type RestoreStep = (typeof RESTORE_STEPS)[number];

function stepAt(step: string): number {
  const index = RESTORE_STEPS.indexOf(step as RestoreStep);
  return index < 0 ? 0 : index;
}

export function restoreStepWords(step: string): string | null {
  return RESTORE_STEPS.includes(step as RestoreStep) ? RESTORE_STEP_WORDS[step as RestoreStep] : null;
}

const RESTORE_STEP_WORDS: Readonly<Record<RestoreStep, string>> = {
  planned: "before it began",
  stopping: "the stop",
  stopped: "the stop",
  "undo-submitting": "the undo",
  "undo-task": "the undo",
  "undo-ready": "the undo",
  "copy-claimed": "the undo's copy",
  "copy-submitting": "the undo's copy",
  "copy-task": "the undo's copy",
  "copy-cloned": "the undo's copy",
  "copy-disarmed": "the undo's copy",
  "copy-ready": "the undo's copy",
  "rollback-submitting": "the rollback",
  "rollback-task": "the rollback",
  "rolled-back": "the rollback",
  "adopt-claimed": "the new guest",
  "adopt-submitting": "the new guest",
  "adopt-task": "the new guest",
  adopted: "the new guest",
  swapped: "the swap of guests",
  retired: "the earlier guest",
  starting: "the start",
  size: "reading its size",
  access: "writing its access file",
  labels: "writing its labels",
  machine: "its BB machine",
  "swap-back": "putting its old guest back",
  done: "the end",
};

const FLUSH_WAIT_MS = 15_000;
const UNIX_FLUSH = "sync";
const WINDOWS_FLUSH = "Get-Volume | Where-Object DriveLetter | ForEach-Object { Write-VolumeCache -DriveLetter $_.DriveLetter }";

function unflushedNote(why: string): string {
  const reason = why.replace(/\.$/, "").slice(0, 300);
  return `bb-box could not flush the box's writes to its disk before stopping it (${reason}), so this undo may miss what was written in the last seconds before the restore.`;
}

const BEGINS_A_TASK: ReadonlySet<string> = new Set(["undo-submitting", "copy-claimed", "rollback-submitting", "adopt-claimed"]);

const TIMED_PARTS: Partial<Readonly<Record<RestoreStep, string>>> = {
  stopping: "stop",
  "undo-submitting": "undo",
  "copy-claimed": "undo",
  "rollback-submitting": "rollback",
  "adopt-claimed": "swap",
  starting: "start",
  access: "access",
  machine: "",
};

function stepsWords(took: readonly (readonly [string, number])[]): string {
  return took.length ? ` (${took.map(([part, ms]) => `${part} ${seconds(ms)}`).join(", ")})` : "";
}

function accessFailedWords(error: unknown): string {
  return `It was restored and started, but ${sentence(message(error)).replace(/^./, (first) => first.toLowerCase())} bb-box did not start its BB machine again; its next command writes the access file first, as every command does. What the box itself started at boot may have read the access file the snapshot held, as it can after any restore.`;
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];
}

interface Consent {
  readonly force: boolean;
  readonly anyway: readonly string[];
  readonly agreed: readonly string[];
  readonly yes: YesInTheThread | null;
  readonly evicts: string | null;
  readonly unflushed: "stop" | "go-on";
  readonly unflushedWhy: string | null;
  readonly swapBack: string | null;
}

function consentOf(operation: Pick<SnapshotOperation, "consent">): Consent {
  const consent = operation.consent as { force?: unknown; anyway?: unknown; agreed?: unknown; yes?: YesInTheThread; evicts?: unknown; unflushed?: unknown; unflushedWhy?: unknown; swapBack?: unknown } | null;
  const anyway = texts(consent?.anyway);
  return {
    force: consent?.force === true,
    anyway,
    agreed: Array.isArray(consent?.agreed) ? texts(consent.agreed) : anyway,
    yes: consent?.yes && typeof consent.yes.thread === "string" ? consent.yes : null,
    evicts: typeof consent?.evicts === "string" ? consent.evicts : null,
    unflushed: consent?.unflushed === "go-on" ? "go-on" : "stop",
    unflushedWhy: typeof consent?.unflushedWhy === "string" ? consent.unflushedWhy : null,
    swapBack: typeof consent?.swapBack === "string" ? consent.swapBack : null,
  };
}

export function unflushedOf(operation: Pick<SnapshotOperation, "consent">): string | null {
  return consentOf(operation).unflushedWhy;
}

interface Loss {
  readonly key: string;
  readonly words: string;
}

export function yesWords(yes: Pick<YesInTheThread, "thread" | "title">): string {
  return `on a yes given in ${yes.title ? `"${yes.title}" (${yes.thread})` : `thread ${yes.thread}`}`;
}

export function planDigest(box: Pick<BoxRecord, "id"> & { readonly guest: Guest | null }, target: Pick<SnapshotRecord, "id" | "ref">, undo: "snapshot" | "held-copy" | null, losses: readonly string[], snapshots: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ box: box.id, guest: box.guest?.ref ?? null, target: target.id, ref: target.ref, undo, losses: [...losses].sort(), snapshots: [...snapshots].sort() }))
    .digest("hex")
    .slice(0, 16);
}

export class YesNeeded extends BoxError {
  readonly check: RestoreCheck;
  readonly asks: "machine" | "settings";
  readonly changed: boolean;
  constructor(check: RestoreCheck, asks: "machine" | "settings", changed: boolean) {
    super(
      "needs_yes",
      changed
        ? `What restoring box ${check.box.name} would do changed after the yes was asked for, so bb-box restored nothing and asks again.`
        : asks === "machine"
          ? `Box ${check.box.name} is a box threads run on, so an agent restores it only on a yes given in the thread.`
          : `Settings turn agents' own restores off, so an agent restores box ${check.box.name} only on a yes given in the thread.`,
    );
    this.check = check;
    this.asks = asks;
    this.changed = changed;
  }
}

function threadsWords(threads: readonly ThreadOnTheBox[]): string {
  const named = threads.map((thread) => `"${thread.title}" (${thread.running ? "working" : "idle"})`);
  return named.length <= 1 ? (named[0] ?? "") : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
}

function sizeChangeWords(from: BoxSize | null, to: BoxSize | null): string {
  if (!from || !to) return "";
  if (from.cores === to.cores && from.memoryMiB === to.memoryMiB && (from.diskGiB === to.diskGiB || to.diskGiB === null)) return "";
  return `; its size went from ${describeSize(from)} to ${describeSize(to)}, as it was then`;
}

interface TakeContext {
  readonly box: BoxRecord & { readonly guest: Guest };
  readonly backend: Backend;
  readonly offer: Snapshotting;
  readonly plan: SnapshotPlan;
  readonly memory: boolean;
}

interface TakeSpend {
  readonly storage: SnapshotStorage;
  readonly adds: number;
}

function takeSpends(plan: SnapshotPlan, memory: boolean): TakeSpend[] {
  const spends: TakeSpend[] = [{ storage: plan.storage, adds: plan.take.addsBytes ?? 0 }];
  if (memory && plan.take.memory) spends.push({ storage: plan.take.memory.storage, adds: plan.take.memory.addsBytes });
  return spends;
}

export interface TakeCheck {
  readonly aboutMs: number;
  readonly addsBytes: number | null;
  readonly storage: string;
  readonly host: string | null;
  readonly memory: { readonly aboutMs: number | null; readonly addsBytes: number; readonly storage: string } | null;
  readonly memoryWhy: string | null;
}

interface Prepared {
  readonly box: BoxRecord & { readonly guest: Guest };
  readonly target: SnapshotRecord;
  readonly backend: Backend;
  readonly offer: Snapshotting;
  readonly plan: SnapshotPlan;
  readonly byCopy: boolean;
  readonly swap: boolean;
  readonly fromSnapshot: boolean;
  readonly anyway: readonly string[];
  readonly forkSafe: ForkSafety;
  readonly through: "restore" | "form";
  readonly onAMachine: boolean;
  readonly losses: readonly Loss[];
}

interface Look {
  readonly refusal: string | null;
  readonly onAMachine: boolean;
  readonly working: readonly ThreadOnTheBox[];
  readonly losses: readonly Loss[];
}

export interface RestoreCheck {
  readonly snapshot: SnapshotRecord;
  readonly box: BoxRecord;
  readonly onAMachine: boolean;
  readonly plan: string;
  readonly swap: boolean;
  readonly fromSnapshot: boolean;
  readonly costWords: string | null;
  readonly undo: { readonly kind: "snapshot" | "held-copy"; readonly name: string; readonly aboutMs: number; readonly bytes: number | null; readonly price: Price | null } | null;
  readonly from: BoxSize | null;
  readonly to: BoxSize | null;
  readonly anyway: readonly string[];
  readonly leavesOnEarlierGuest: number;
  readonly replaces: string | null;
  readonly storage: string;
  readonly undoRefused: string | null;
}

interface Restoring {
  readonly swap: boolean;
  readonly fromSnapshot?: boolean;
  readonly operation: SnapshotOperation;
  readonly target: SnapshotRecord;
  readonly undo: SnapshotRecord | null;
  readonly backend: Backend;
  readonly anyway: readonly string[];
  readonly from: BoxSize | null;
  readonly after: string;
  readonly whenStopped?: () => void;
}

type TaskSeen = TaskOutcome | { readonly state: "unreadable"; readonly words: string } | null;

function namesWords(names: readonly string[], hidden: number): string {
  const listed = names.map((name) => `"${name}"`).join(", ");
  if (!hidden) return listed;
  return `${listed}${listed ? ", " : ""}and ${hidden === 1 ? "one other" : `${hidden} others`} you cannot see`;
}

const PERSON: Caller = { is: "person" };

interface KeepConsent {
  readonly from: number | null;
  readonly to: number | null;
  readonly why: string | null;
}

function keepConsentOf(operation: Pick<SnapshotOperation, "consent">): KeepConsent | null {
  const keep = (operation.consent as { keep?: Partial<KeepConsent> } | null)?.keep;
  if (!keep) return null;
  const date = (value: unknown) => (typeof value === "number" ? value : null);
  return { from: date(keep.from), to: date(keep.to), why: typeof keep.why === "string" ? keep.why : null };
}

function trust(held: HeldSnapshot): number {
  if (held.where === "held-copy") return held.state === "complete" ? 3 : 0;
  return held.state === "complete" ? 2 : 1;
}

export function preferredById(listing: readonly HeldSnapshot[]): Map<string, HeldSnapshot> {
  const byId = new Map<string, HeldSnapshot>();
  for (const held of listing) {
    const seen = byId.get(held.id);
    if (!seen || trust(held) > trust(seen)) byId.set(held.id, held);
  }
  return byId;
}

export function standingOfRecord(record: Pick<SnapshotRecord, "box">): Standing {
  return { box: { id: record.box.id, threadId: record.box.thread }, runsOn: false };
}

export class Snapshots {
  readonly #deps: SnapshotsDeps;
  readonly #now: () => number;
  readonly #random: (bytes: number) => Uint8Array;
  readonly #running = new Set<string>();
  readonly #waitedOut = new Set<string>();
  readonly #outsideRunning = new Set<string>();
  readonly #outsideSince = new Map<string, number>();
  readonly #stopping = new AbortController();
  readonly #bills = new Map<string, { readonly at: number; readonly bill: SnapshotBill | null; readonly good: SnapshotBill | null }>();

  constructor(deps: SnapshotsDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#random = deps.random ?? ((bytes) => randomBytes(bytes));
  }

  get ledger(): SnapshotLedger {
    return this.#deps.ledger;
  }

  get settings(): SnapshotConfig {
    return this.#deps.settings?.() ?? DEFAULT_SETTINGS;
  }

  backendOf(id: string): Backend | null {
    return this.#deps.backends.get(id);
  }

  offerFor(backend: Backend | null | undefined, kind: string): Snapshotting | null {
    const offer = backend?.snapshotting?.(kind) ?? null;
    return offer && backend && this.#deps.priced ? this.#deps.priced(backend, offer) : offer;
  }

  async readBill(backend: Backend): Promise<void> {
    if (!backend.snapshotBill) return;
    const at = this.#now();
    try {
      const read = await backend.snapshotBill(this.#stopping.signal);
      const bill = this.#deps.billed ? this.#deps.billed(backend, read) : read;
      this.#bills.set(backend.id, { at, bill, good: bill });
    } catch (error) {
      if (this.#stopping.signal.aborted) throw error;
      const good = this.#bills.get(backend.id)?.good ?? null;
      this.#bills.set(backend.id, { at, bill: null, good });
      this.#deps.log?.(`Could not read what ${backend.label} bills for snapshots, so bb-box takes, undoes and keeps no paid snapshot there until it can: ${message(error)}`);
    }
  }

  #heldOn(backendId: string): HeldRate | null {
    const records = this.#deps.ledger.records({ backend: backendId });
    if (!this.#deps.backends.get(backendId)?.snapshotBill) return heldRate(records, backendId);
    const known = this.#bills.get(backendId);
    if (!known?.bill || this.#now() - known.at > BILL_FRESH_MS) return null;
    return billedRate(known.bill, pendingOn(records, known.bill));
  }

  #heldShown(backendId: string): HeldRate {
    const held = this.#heldOn(backendId);
    if (held) return held;
    const records = this.#deps.ledger.records({ backend: backendId });
    const good = this.#bills.get(backendId)?.good ?? null;
    return good ? accountAtFullPrice(good, pendingOn(records, good)) : { ...heldRate(records, backendId), estimate: true };
  }

  paidOn(backendId: string): PaidOnBackend {
    const ledger = this.#deps.ledger;
    const held = this.#heldShown(backendId);
    const ceiling = ceilingOf(this.settings, backendId);
    return { held, spent: spentThisMonth(ledger.charges(backendId), this.#now()), ceiling, past: pastCeiling(held, ceiling) };
  }

  #event(record: SnapshotRecord, kind: BoxEventKind, by: Actor, words: string): void {
    try {
      this.#deps.events?.record({ box: record.box.id, thread: record.box.thread, name: record.box.name, at: this.#now(), kind, by, words, backend: record.backend.label });
    } catch (error) {
      this.#deps.logError("box log", error);
    }
  }

  #notify(threadId: string): void {
    try {
      this.#deps.notify(threadId);
    } catch (error) {
      this.#deps.logError("notify", error);
    }
  }

  visible(caller: Caller, standing: Standing): SnapshotRecord[] {
    if (!standing.box) return [];
    return this.#deps.ledger.records({ box: standing.box.id }).filter((record) => mayAct(caller, "see", standing, record).ok);
  }

  seen(caller: Caller, standing: Standing): { readonly records: SnapshotRecord[]; readonly hidden: number; readonly counted: number } {
    const records = this.visible(caller, standing);
    const all = standing.box ? this.#deps.ledger.records({ box: standing.box.id }) : [];
    return { records, hidden: all.length - records.length, counted: all.filter(countsAgainstLimit).length };
  }

  find(caller: Caller, standing: Standing, ref: string): SnapshotRecord {
    const seen = this.visible(caller, standing);
    const found = seen.find((record) => record.id === ref) ?? seen.find((record) => record.name === ref);
    if (found) return found;
    const names = seen.map((record) => `"${record.name}"`).join(", ");
    throw new BoxError("not_found", `That box has no snapshot "${ref}".${names ? ` Its snapshots are: ${names}.` : ""}`);
  }

  #requireStore(action: string): void {
    const problem = this.#deps.ledger.problem;
    if (problem) throw new BoxError("unreachable", `${problem} So bb-box ${action} no snapshot until it can.`);
  }

  async take(caller: Caller, box: BoxRecord, standing: Standing, input: TakeInput = {}): Promise<TakeAnswer> {
    const allowed = mayAct(caller, "take", standing);
    if (!allowed.ok) throw new BoxError("not_owner", allowed.why);
    if (input.name !== undefined) {
      const problem = nameProblem(input.name);
      if (problem) throw new BoxError("invalid_name", problem);
    }
    if (input.note !== undefined) {
      const problem = noteProblem(input.note);
      if (problem) throw new BoxError("invalid_name", problem);
    }
    this.#requireStore("takes");
    const by: Actor = caller.is === "agent" ? { is: "agent", threadId: caller.threadId } : caller;
    const digest = input.request ? requestDigest("take", box.id, { name: input.name ?? null, note: input.note ?? null, memory: input.memory === true }) : null;
    if (input.request) this.#earlier(by, input.request, digest);
    return this.#deps.boxes.inTurn(box.id, () => this.#take(caller, box.id, standing, input, by, digest));
  }

  #earlier(by: Actor, request: string, digest: string | null): SnapshotOperation | null {
    const earlier = this.#deps.ledger.byRequest(requestKey(by, request));
    if (!earlier) return null;
    if (earlier.requestDigest !== digest) throw reusedRequest(request);
    return earlier;
  }

  #repeat(operation: SnapshotOperation): TakeAnswer {
    const record = this.#deps.ledger.record(operation.snapshots[0] ?? "");
    const counted = this.#deps.ledger.records({ box: operation.box }).filter(countsAgainstLimit).length;
    return { snapshot: record, operation, counted, repeated: true };
  }

  async #take(caller: Caller, boxId: string, standing: Standing, input: TakeInput, by: Actor, digest: string | null): Promise<TakeAnswer> {
    const ledger = this.#deps.ledger;
    if (input.request) {
      const earlier = this.#earlier(by, input.request, digest);
      if (earlier) return this.#repeat(earlier);
    }
    const { box, backend, offer, plan, memory } = await this.#takeContext(boxId, input.memory === true);
    const safety = await this.#forkSafe(box, backend);
    const spends = takeSpends(plan, memory);
    const reserved = memory && plan.take.memory ? { storage: plan.take.memory.storage.key, bytes: plan.take.memory.addsBytes } : { storage: plan.storage.key, bytes: plan.take.addsBytes ?? 0 };
    const now = this.#now();
    const id = newSnapshotId(this.#random);
    const operationId = newOperationId(this.#random);
    const admitted = ledger.transaction((): { refused: BoxError } | { repeat: SnapshotOperation } | { record: SnapshotRecord; operation: SnapshotOperation; counted: number; evicts: SnapshotRecord | null } => {
      if (input.request) {
        const raced = ledger.byRequest(requestKey(by, input.request));
        if (raced) return raced.requestDigest === digest ? { repeat: raced } : { refused: reusedRequest(input.request) };
      }
      const ofBox = ledger.records({ box: box.id });
      const counted = ofBox.filter(countsAgainstLimit);
      const admission = this.#admit(caller, standing, { box, backend, offer, plan, memory }, spends, now);
      if ("refused" in admission) return { refused: admission.refused };
      const evicts = admission.evicts;
      const name = uniqueName(input.name?.trim() || timeName(now, this.#deps.timeZone), new Set(ofBox.map((record) => record.name)));
      const record: SnapshotRecord = {
        id,
        box: { id: box.id, name: box.name, kind: box.kind, system: box.capabilities.os, thread: box.threadId },
        boxGone: null,
        backend: { id: backend.id, label: backend.label },
        host: box.guest!.host,
        storage: { name: plan.storage.name, type: plan.storage.type },
        guest: "current",
        livesOn: box.guest!,
        name,
        note: input.note?.trim() || null,
        takenAt: now,
        capturedAt: null,
        tookMs: null,
        by,
        scope: offer.scope,
        holds: memory ? "disk-and-memory" : "disk",
        excludes: offer.excludes,
        size: null,
        price: offer.price,
        owner: box.threadId === OPERATOR ? "person" : "thread",
        keptUntil: null,
        keptAt: null,
        undoOf: null,
        forkSafe: safety.version,
        identity: safety.identity,
        dependsOn: [],
        picture: null,
        ref: null,
        state: "taking",
        error: null,
        stateAt: now,
        missingSince: null,
        foundAt: null,
      };
      const operation: SnapshotOperation = {
        id: operationId,
        request: input.request ? requestKey(by, input.request) : null,
        requestDigest: digest,
        kind: "take",
        box: box.id,
        guest: box.guest!.ref,
        snapshots: [id],
        by,
        consent: evicts ? { evicts: evicts.id } : null,
        undo: null,
        guests: null,
        step: "planned",
        task: null,
        state: "running",
        reserved: { ...reserved, price: offer.price },
        error: null,
        startedAt: now,
        endedAt: null,
        snapshotsGoneAt: null,
      };
      ledger.insertRecord(record);
      ledger.insertOperation(operation);
      return { record, operation, counted: counted.length + 1, evicts };
    });
    if ("refused" in admitted) throw admitted.refused;
    if ("repeat" in admitted) return this.#repeat(admitted.repeat);
    this.#notify(box.threadId);
    const taken = await this.#runTake(admitted.record, admitted.operation, box, backend, admitted.counted);
    if (!admitted.evicts) return taken;
    const evicted = await this.#finishEviction(admitted.operation.id, taken.snapshot ?? admitted.record, this.settings.perBox);
    const counted = ledger.records({ box: box.id }).filter(countsAgainstLimit).length;
    return { ...taken, counted, ...evicted, operation: ledger.operation(admitted.operation.id) ?? taken.operation };
  }

  async #finishEviction(operationId: string, record: SnapshotRecord, perBox: number): Promise<{ readonly evicted: { readonly name: string; readonly id: string } | null; readonly evictionRefused: string | null }> {
    const ledger = this.#deps.ledger;
    const operation = ledger.operation(operationId);
    const victim = operation ? ledger.record(consentOf(operation).evicts ?? "") : null;
    let answer: { readonly evicted: { readonly name: string; readonly id: string } | null; readonly evictionRefused: string | null } = { evicted: null, evictionRefused: null };
    if (victim) {
      const why = byBbBox(`the limit of ${perBox} snapshots a box: the agent's new snapshot "${record.name}" took its place`);
      try {
        await this.#delete(victim.id, why, "evict-limit", null);
        answer = { evicted: { name: victim.name, id: victim.id }, evictionRefused: null };
      } catch (error) {
        if (this.#stopping.signal.aborted) throw error;
        const words = sentence(message(error));
        this.#deps.log?.(`Kept snapshot ${victim.id} of box ${victim.box.name} past the limit after an agent's take: ${words}`);
        answer = { evicted: null, evictionRefused: `bb-box could not delete "${victim.name}" to keep box ${victim.box.name} within its ${perBox}: ${words}` };
      }
    }
    ledger.updateOperation(operationId, { state: "done", step: "done", endedAt: this.#now(), error: null });
    return answer;
  }

  async #takeContext(boxId: string, memory: boolean): Promise<TakeContext> {
    const box = await this.#deps.boxes.find(boxId);
    if (!box) throw new BoxError("released", "That box was released, so it takes no snapshot.");
    const restoring = this.#restoreHolding(box);
    if (restoring) throw restoring;
    if ((box.state !== "ready" && box.state !== "stopped") || !box.guest) {
      throw new BoxError("not_ready", `Box ${box.name} is ${box.state}. bb-box takes a snapshot of a box that is running or stopped.`);
    }
    const backend = this.#deps.backends.get(box.backend);
    if (!backend) throw new BoxError("backend_off", `The ${box.backendLabel} backend that holds box ${box.name} is not in bb-box's settings, so it takes no snapshot of it.`);
    await this.readBill(backend);
    const offer = this.offerFor(backend, box.kind);
    if (!offer || !backend.snapshot || !backend.planSnapshots) throw new BoxError("unsupported", `${box.backendLabel} takes no snapshots of its ${box.kind} boxes.`);
    if (memory && !offer.holds.includes("disk-and-memory")) throw new BoxError("unsupported", `${box.backendLabel} takes snapshots of a ${box.kind} box's disk only, so a snapshot of box ${box.name} cannot hold its memory. Leave memory out.`);
    if (!memory && !offer.holds.includes("disk")) throw new BoxError("unsupported", `Every snapshot ${box.backendLabel} takes of a ${box.kind} box holds its memory too. Ask for its memory.`);
    if (memory && box.state !== "ready") throw new BoxError("not_ready", `A snapshot with its memory needs box ${box.name} running, and it is stopped.`);
    this.#requireStore("takes");
    const plan = await backend.planSnapshots(box.guest, box.kind, null, this.#stopping.signal);
    if (plan.locked) throw new BoxError("locked", `${backend.label} left box ${box.name} locked (${plan.locked.lock}), so it takes no snapshot. ${plan.locked.fix}`);
    if (plan.busy) throw new BoxError("try_again", `bb-box cannot take a snapshot of box ${box.name} now: ${plan.busy}`);
    if (!plan.take.ok) throw new BoxError("unsupported", `bb-box cannot take a snapshot of box ${box.name} now: ${plan.take.why ?? `${backend.label} refused it.`}`);
    if (memory && !plan.take.memory) throw new BoxError("unsupported", `bb-box cannot take a snapshot of box ${box.name} with its memory: ${plan.take.memoryWhy ?? "its backend did not say where the memory would go."}`);
    return { box: { ...box, guest: box.guest }, backend, offer, plan, memory };
  }

  #admit(caller: Caller, standing: Standing, context: TakeContext, spends: readonly TakeSpend[], now: number): { readonly refused: BoxError } | { readonly evicts: SnapshotRecord | null } {
    const { box, backend, offer, plan, memory } = context;
    const ledger = this.#deps.ledger;
    const settings = this.settings;
    const ofBox = ledger.records({ box: box.id });
    const counted = ofBox.filter(countsAgainstLimit);
    const evicts = counted.length >= settings.perBox && caller.is === "agent" ? limitVictim(ofBox, caller.threadId, ledger.pins(), now) : null;
    if (counted.length >= settings.perBox && !evicts) {
      const seen = counted.filter((record) => mayAct(caller, "see", standing, record).ok);
      const none = caller.is === "agent" ? " None of them is one an agent of this thread took and nobody kept, which bb-box would delete for a new one." : "";
      return {
        refused: new BoxError(
          "limit_reached",
          `Box ${box.name} holds ${counted.length} snapshots, and your settings allow ${settings.perBox} a box.${none} Delete one first: ${namesWords(seen.map((record) => record.name), counted.length - seen.length)}.`,
        ),
      };
    }
    for (const spend of spends) {
      const adds = spends.filter((other) => other.storage.key === spend.storage.key).reduce((sum, other) => sum + other.adds, 0);
      const room = this.#roomProblem(box, spend.storage, ledger.reservedBytes(spend.storage.key) + adds, memory, settings.roomPercent);
      if (room) return { refused: new BoxError("try_again", room) };
    }
    const paid = ceilingVerdict({
      change: "take",
      backend: backend.label,
      held: this.#heldOn(backend.id),
      price: offer.price,
      bytes: memory && plan.take.memory ? plan.take.memory.addsBytes : (plan.take.addsBytes ?? null),
      ceiling: ceilingOf(settings, backend.id),
      byPerson: caller.is !== "agent",
    });
    return paid.ok ? { evicts } : { refused: new BoxError("limit_reached", paid.why) };
  }

  async checkTake(caller: Caller, box: BoxRecord, standing: Standing, input: { readonly memory?: boolean } = {}): Promise<TakeCheck> {
    const allowed = mayAct(caller, "take", standing);
    if (!allowed.ok) throw new BoxError("not_owner", allowed.why);
    const memory = input.memory === true;
    const context = await this.#takeContext(box.id, memory);
    const admission = this.#admit(caller, standing, context, takeSpends(context.plan, memory), this.#now());
    if ("refused" in admission) throw admission.refused;
    const { plan } = context;
    return {
      aboutMs: memory ? (plan.take.memoryAboutMs ?? plan.take.aboutMs) : plan.take.aboutMs,
      addsBytes: memory && plan.take.memory ? plan.take.memory.addsBytes : plan.take.addsBytes,
      storage: memory && plan.take.memory ? plan.take.memory.storage.name : plan.storage.name,
      host: context.box.guest.host,
      memory: plan.take.memory ? { aboutMs: plan.take.memoryAboutMs, addsBytes: plan.take.memory.addsBytes, storage: plan.take.memory.storage.name } : null,
      memoryWhy: plan.take.memory ? null : plan.take.memoryWhy,
    };
  }

  async #screenPicture(box: BoxRecord): Promise<{ readonly state: PictureState; readonly picture: ScreenPicture | null } | null> {
    const screen = this.#deps.screen;
    if (!screen) return null;
    if (!box.capabilities.displays.length && !box.device) return { state: "none", picture: null };
    if (!this.settings.pictures) return { state: "off", picture: null };
    try {
      const png = await withinWait((signal) => screen(box, signal));
      return png ? { state: "taken", picture: pictureOfScreen(png) } : { state: "none", picture: null };
    } catch (error) {
      this.#deps.log?.(`Took no picture of box ${box.name}'s screen for its snapshot: ${message(error)}`);
      return { state: "failed", picture: null };
    }
  }

  async #keepPicture(snapshotId: string, box: BoxRecord): Promise<void> {
    const outcome = await this.#screenPicture(box);
    if (!outcome) return;
    try {
      const kept = outcome.picture ? this.#deps.ledger.putPicture({ snapshot: snapshotId, jpeg: outcome.picture.jpeg, width: outcome.picture.width, height: outcome.picture.height, at: this.#now() }) : true;
      if (!kept) this.#deps.log?.(`Kept no picture of box ${box.name}'s screen: pictures of kept snapshots fill the 48 MB bb-box holds for them.`);
      this.#deps.ledger.updateRecord(snapshotId, { picture: kept ? outcome.state : "failed" });
    } catch (error) {
      this.#deps.logError("keep a snapshot's picture", error);
    }
  }

  picture(caller: Caller, standing: Standing, ref: string): StoredPicture | null {
    const target = this.find(caller, standing, ref);
    const allowed = mayAct(caller, "see-picture", standing, target);
    if (!allowed.ok) throw new BoxError("not_owner", allowed.why);
    return target.picture === "taken" ? this.#deps.ledger.picture(target.id) : null;
  }

  async rename(caller: Caller, standing: Standing, ref: string, name: string): Promise<SnapshotRecord> {
    const problem = nameProblem(name);
    if (problem) throw new BoxError("invalid_name", problem);
    const wanted = name.trim();
    return this.#relabel(caller, standing, ref, "rename", (current, ofBox) => {
      const taken = ofBox.find((other) => other.id !== current.id && other.name === wanted);
      if (taken) return new BoxError("invalid_name", `Box ${current.box.name} has a snapshot named ${quoted(taken)} already. Give this one another name.`);
      return { name: wanted };
    });
  }

  async annotate(caller: Caller, standing: Standing, ref: string, note: string): Promise<SnapshotRecord> {
    const problem = noteProblem(note);
    if (problem) throw new BoxError("invalid_name", problem);
    return this.#relabel(caller, standing, ref, "note", () => ({ note: note.trim() || null }));
  }

  async checkKeep(caller: Caller, standing: Standing, ref: string, input: KeepInput = {}): Promise<KeepCheck> {
    const target = this.find(caller, standing, ref);
    const allowed = mayAct(caller, "keep", standing, target);
    if (!allowed.ok) throw new BoxError("not_owner", allowed.why);
    return this.#keepCheck(target, input);
  }

  async keep(caller: Caller, standing: Standing, ref: string, input: KeepInput = {}): Promise<KeepAnswer> {
    const target = this.find(caller, standing, ref);
    const allowed = mayAct(caller, "keep", standing, target);
    if (!allowed.ok) throw new BoxError("not_owner", allowed.why);
    this.#requireStore("keeps");
    await this.#keepCheck(target, input);
    const by: Actor = caller.is === "agent" ? { is: "agent", threadId: caller.threadId } : caller;
    return this.#deps.boxes.inTurn(target.box.id, () => this.#keepNow(target.id, by, input));
  }

  async unkeep(caller: Caller, standing: Standing, ref: string): Promise<SnapshotRecord> {
    const target = this.find(caller, standing, ref);
    const allowed = mayAct(caller, "unkeep", standing, target);
    if (!allowed.ok) throw new BoxError("not_owner", allowed.why);
    this.#requireStore("stops keeping");
    const by: Actor = caller.is === "agent" ? { is: "agent", threadId: caller.threadId } : caller;
    return this.#deps.boxes.inTurn(target.box.id, () => this.#unkeepNow(target.id, by, null));
  }

  async checkKeepGone(record: SnapshotRecord, input: KeepInput = {}): Promise<KeepCheck> {
    return this.#keepCheck(record, input);
  }

  async keepGone(record: SnapshotRecord, by: Actor, input: KeepInput = {}): Promise<KeepAnswer> {
    this.#requireStore("keeps");
    await this.#keepCheck(record, input);
    return this.#deps.boxes.inTurn(record.box.id, () => this.#keepNow(record.id, by, input));
  }

  async unkeepGone(record: SnapshotRecord, by: Actor): Promise<SnapshotRecord> {
    this.#requireStore("stops keeping");
    return this.#deps.boxes.inTurn(record.box.id, () => this.#unkeepNow(record.id, by, null));
  }

  async checkForkGone(record: SnapshotRecord, input: ForkInput = {}): Promise<ForkCheck> {
    return this.checkFork(PERSON, { id: record.box.id }, standingOfRecord(record), record.id, input);
  }

  async forkGone(record: SnapshotRecord, caller: Exclude<Caller, { is: "agent" }>, input: ForkInput = {}): Promise<ForkAnswer> {
    return this.fork(caller, { id: record.box.id }, standingOfRecord(record), record.id, input);
  }

  async unkeepForRelease(box: Pick<BoxRecord, "id" | "name">, by: Actor): Promise<SnapshotRecord[]> {
    this.#requireStore("stops keeping");
    const waiting = this.#deps.ledger.records({ box: box.id }).filter((record) => record.keptUntil !== null && record.guest !== "held-copy");
    const unkept: SnapshotRecord[] = [];
    for (const record of waiting) unkept.push(await this.#deps.boxes.inTurn(box.id, () => this.#unkeepNow(record.id, by, `box ${box.name} was released with it, as you asked`)));
    return unkept;
  }

  #keepDate(current: SnapshotRecord, input: KeepInput, now: number): number {
    if (input.days !== undefined && input.until !== undefined) throw new BoxError("invalid_value", "Give a number of days or a date to keep it until, not both.");
    const most = keptUntilAfter(now, SNAPSHOT_LIMITS.keepDays.most);
    let until: number;
    if (input.until !== undefined) {
      const end = endOfUtcDay(input.until.trim());
      if (end === null) throw new BoxError("invalid_value", `Give the date as yyyy-mm-dd, such as ${utcDay(keptUntilAfter(now, this.settings.keepDays))}; "${input.until}" is not one.`);
      until = end;
    } else {
      const days = input.days ?? this.settings.keepDays;
      const { least, most: longest } = SNAPSHOT_LIMITS.keepDays;
      if (!Number.isInteger(days) || days < least || days > longest) throw new BoxError("invalid_value", `bb-box keeps a snapshot for ${least} to ${longest} days; ${days} is not.`);
      const renewing = input.days === undefined && current.keptUntil !== null && current.keptUntil > now;
      until = renewing ? Math.min(keptUntilAfter(current.keptUntil!, days), most) : keptUntilAfter(now, days);
    }
    if (until <= now) throw new BoxError("invalid_value", `${utcDay(until)} has passed already. Keep it until a day from tomorrow on.`);
    if (until > most) throw new BoxError("invalid_value", `bb-box keeps a snapshot at most ${SNAPSHOT_LIMITS.keepDays.most} days from today, so until ${utcDay(most)} at the latest.`);
    if (input.days === undefined && input.until === undefined && current.keptUntil !== null && current.keptUntil > until) return current.keptUntil;
    return until;
  }

  #refOf(record: SnapshotRecord, box: BoxRecord | null): SnapshotRef {
    return { id: record.id, ref: record.ref ?? "", guest: this.#guestOf(record, box), ...(record.guest === "held-copy" ? { from: "held-copy" as const } : {}) };
  }

  #forkableAfterRelease(record: SnapshotRecord, backend: Backend, offer: Snapshotting): void {
    const name = record.box.name;
    if (record.box.system !== "linux") throw new BoxError("unsupported", `bb-box keeps only a snapshot it can fork after its box's release, and it forks Linux boxes only. Box ${name} runs ${record.box.system}.`);
    if (record.forkSafe === null) throw new BoxError("unsupported", `Taken before ${name}'s image had the identity reset: ${quoted(record)} could not be forked after a release, so bb-box does not keep it.`);
    const safeFrom = offer.forkSafeFrom ?? 1;
    if (record.forkSafe < safeFrom) {
      throw new BoxError("unsupported", `${name} had version ${record.forkSafe} of the identity reset when ${quoted(record)} was taken, and bb-box forks ${backend.label}'s boxes only from version ${safeFrom}: it could not be forked after a release, so bb-box does not keep it.`);
    }
  }

  #copyRoom(host: string | null, storage: SnapshotStorage, bytes: number, reserved: number): string | null {
    const on = `${host ? `${host}'s ` : ""}storage ${storage.name || "of its disk"}`;
    if (storage.totalBytes === null || storage.usedBytes === null || storage.totalBytes <= 0) return `bb-box cannot read how full ${on} is, so it cannot tell whether the held copy fits`;
    const free = Math.max(0, storage.totalBytes - storage.usedBytes - reserved);
    const beside = reserved > 0 ? `, beside ${gbWords(reserved)} that snapshots and copies being made there hold` : "";
    const past = this.settings.roomPercent;
    const after = ((storage.usedBytes + reserved + bytes) / storage.totalBytes) * 100;
    if (bytes > free) return `${on} has ${gbWords(free)} free${beside}, and the held copy needs about ${gbWords(bytes)}`;
    if (after > past) return `${on} has ${gbWords(free)} free${beside}, and with the held copy, about ${gbWords(bytes)}, it would be ${percentPast(after, past)} full, past your settings' ${past}%`;
    return null;
  }

  async #keepCheck(record: SnapshotRecord, input: KeepInput): Promise<KeepCheck> {
    const ledger = this.#deps.ledger;
    const now = this.#now();
    const current = ledger.record(record.id) ?? record;
    const verdict = eligible(current, "keep", { pin: ledger.pins().get(current.id) ?? null, now });
    if (!verdict.ok) throw new BoxError(current.state === "taking" ? "try_again" : "in_use", verdict.why);
    const keptUntil = this.#keepDate(current, input, now);
    if (current.scope !== "box") throw new BoxError("unsupported", `${quoted(current)} holds box ${current.box.name}'s device only, and lives in the box, so bb-box cannot keep it past the box's release.`);
    const backend = this.#deps.backends.get(current.backend.id);
    if (!backend) throw new BoxError("backend_off", `The ${current.backend.label} backend that holds ${quoted(current)} is not in bb-box's settings, so bb-box cannot keep it.`);
    const offer = this.offerFor(backend, current.box.kind);
    if (offer?.forkWhy) throw new BoxError("unsupported", `bb-box keeps only a snapshot it can fork after its box's release, and ${offer.forkWhy}. So it does not keep ${quoted(current)}.`);
    const way: KeepsPastRelease = offer?.keepsPastRelease ?? "no";
    if (!offer || way === "no") throw new BoxError("unsupported", `${backend.label} has no way to keep a snapshot of a ${current.box.kind} box past the box's release, so bb-box does not keep ${quoted(current)}.`);
    if (!backend.labelKept) throw new BoxError("unsupported", `${backend.label} cannot write a keep date on its snapshots, so bb-box does not keep ${quoted(current)}.`);
    this.#forkableAfterRelease(current, backend, offer);
    const gone = current.boxGone !== null;
    let aboutMs: number | null = null;
    let bytes: number | null = null;
    let usedBytes: number | null = null;
    let storage: string | null = null;
    let warning: string | null = null;
    if (current.guest === "held-copy") {
      if (!backend.copyPlan) throw new BoxError("unsupported", `${backend.label} cannot read its held copies, so bb-box does not keep ${quoted(current)} longer.`);
      const copy = await backend.copyPlan(current.livesOn, this.#stopping.signal);
      if (copy.state !== "template") throw new BoxError("failed", `${quoted(current)}'s held copy, guest ${current.livesOn.ref}, is ${copy.state === "gone" ? "gone" : "not a template"}, so bb-box does not keep it longer. Delete it.`);
    } else {
      if (gone) throw new BoxError("unsupported", `Box ${current.box.name} is gone and ${quoted(current)} has no held copy, so there is nothing a keep date would hold: bb-box keeps such a snapshot until you delete it.`);
      const box = await this.#deps.boxes.find(current.box.id);
      if (!box) throw new BoxError("released", `Box ${current.box.name} was released, so bb-box cannot keep ${quoted(current)} now.`);
      if (box.state === "releasing") throw new BoxError("not_ready", `Box ${box.name} is being released, so bb-box keeps no more of its snapshots.`);
      if (!backend.planSnapshots) throw new BoxError("unsupported", `${backend.label} cannot plan its snapshots, so bb-box does not keep ${quoted(current)}.`);
      const guest = this.#guestOf(current, box);
      const plan = await backend.planSnapshots(guest, box.kind, this.#refOf(current, box), this.#stopping.signal);
      if (plan.busy) throw new BoxError("try_again", `bb-box cannot keep ${quoted(current)} now: ${plan.busy}`);
      if (plan.locked) throw new BoxError("locked", `${backend.label} left box ${box.name} locked (${plan.locked.lock}), so bb-box keeps none of its snapshots now. ${plan.locked.fix}`);
      if (!plan.fork.ok) throw new BoxError("unsupported", `bb-box keeps only a snapshot it can fork after its box's release, and it cannot fork ${quoted(current)}: ${plan.fork.why ?? `${backend.label} refused it.`}`);
      aboutMs = plan.keep.aboutMs;
      bytes = plan.keep.bytes;
      usedBytes = plan.keep.usedBytes ?? null;
      storage = plan.storage.name;
      const room = way === "held-copy" ? this.#copyRoom(guest.host, plan.storage, usedBytes ?? bytes ?? 0, ledger.reservedBytes(plan.storage.key)) : null;
      warning = plan.keep.why ?? (room ? `At today's size, a release would not finish: ${room}.` : null);
    }
    const renews = current.keptUntil !== null;
    await this.readBill(backend);
    const paid = ceilingVerdict({
      change: renews ? "renew" : "keep",
      backend: backend.label,
      held: this.#heldOn(backend.id),
      price: current.price,
      bytes: null,
      ceiling: ceilingOf(this.settings, backend.id),
      byPerson: true,
    });
    if (!paid.ok) throw new BoxError("limit_reached", paid.why);
    return {
      snapshot: current,
      keptUntil,
      renews,
      shortens: current.keptUntil !== null && keptUntil < current.keptUntil,
      way,
      gone,
      aboutMs,
      bytes,
      usedBytes,
      host: current.livesOn.host ?? current.host,
      storage,
      price: current.price,
      warning,
    };
  }

  async #keepNow(id: string, by: Actor, input: KeepInput): Promise<KeepAnswer> {
    const ledger = this.#deps.ledger;
    const record = ledger.record(id);
    if (!record) throw new BoxError("not_found", `bb-box has no snapshot ${id}: it was deleted.`);
    const check = await this.#keepCheck(record, input);
    if (record.keptUntil === check.keptUntil) return { snapshot: record, check, repeated: true };
    const kept = await this.#writeKeep(record, by, check.keptUntil, null);
    return { snapshot: kept, check, repeated: false };
  }

  async #writeKeep(record: SnapshotRecord, by: Actor, to: number | null, why: string | null): Promise<SnapshotRecord> {
    const ledger = this.#deps.ledger;
    const signal = this.#stopping.signal;
    const backend = this.#deps.backends.get(record.backend.id);
    if (!backend?.labelKept) throw new BoxError("backend_off", `bb-box cannot reach the ${record.backend.label} backend that holds ${quoted(record)}, so it cannot write its keep date there.`);
    const box = record.boxGone ? null : await this.#deps.boxes.find(record.box.id);
    const now = this.#now();
    const opened = ledger.transaction((): SnapshotOperation | string => {
      const current = ledger.record(record.id);
      if (!current) return `bb-box has no snapshot ${record.id}: it was deleted.`;
      const verdict = eligible(current, to === null ? "unkeep" : "keep", { pin: ledger.pins().get(record.id) ?? null, now });
      if (!verdict.ok) return verdict.why;
      const operation: SnapshotOperation = {
        id: newOperationId(this.#random),
        request: null,
        requestDigest: null,
        kind: "keep",
        box: current.box.id,
        guest: current.livesOn.ref,
        snapshots: [current.id],
        by,
        consent: { keep: { from: current.keptUntil, to, why } },
        undo: null,
        guests: null,
        step: "labelling",
        task: null,
        state: "running",
        reserved: null,
        error: null,
        startedAt: now,
        endedAt: null,
        snapshotsGoneAt: null,
      };
      ledger.insertOperation(operation);
      return operation;
    });
    if (typeof opened === "string") throw new BoxError("in_use", opened);
    this.#running.add(opened.id);
    try {
      await this.#deps.hold?.(opened, "planned", signal);
      try {
        await backend.labelKept(this.#refOf(record, box), keepLabel(to), signal);
      } catch (error) {
        if (signal.aborted) throw error;
        const words = sentence(message(error));
        if (error instanceof SnapshotFailed) {
          ledger.updateOperation(opened.id, { state: "failed", endedAt: this.#now(), error: words });
          throw new BoxError("failed", to === null ? `bb-box could not take the keep date off ${quoted(record)} on ${where(record)}, so it is still kept: ${words}` : `bb-box could not write the keep date on ${where(record)}, so it did not keep ${quoted(record)}: ${words}`);
        }
        ledger.updateOperation(opened.id, { state: "unknown", error: words });
        throw new BoxError("unreachable", `bb-box could not confirm that ${where(record)} has the keep date of ${quoted(record)} now: ${words} It checks its label at its next sweep, and until then deletes nothing of it.`);
      }
      ledger.updateOperation(opened.id, { step: "labelled" });
      return this.#keepRecorded(opened, record, to, "");
    } finally {
      this.#running.delete(opened.id);
    }
  }

  #keepRecorded(operation: SnapshotOperation, record: SnapshotRecord, to: number | null, after: string): SnapshotRecord {
    const ledger = this.#deps.ledger;
    const now = this.#now();
    const why = keepConsentOf(operation)?.why ?? null;
    const done = ledger.transaction(() => {
      const updated = ledger.updateRecord(record.id, to === null ? { keptUntil: null, keptAt: null } : { keptUntil: to, keptAt: now, owner: "person" });
      ledger.updateOperation(operation.id, { state: "done", step: "done", endedAt: now, error: null });
      return updated;
    });
    const kept = done ?? record;
    if (to === null) this.#event(kept, "snapshot-unkept", operation.by, `"${kept.name}" (${kept.id}): it goes with its box again${why ? `: ${why}` : ""}${after}.`);
    else {
      const from = record.keptUntil !== null ? `, renewed from ${utcDay(record.keptUntil)}` : "";
      const last = record.unflushed ? " It may miss the box's last writes before it." : "";
      this.#event(kept, "snapshot-kept", operation.by, `"${kept.name}" (${kept.id}): until ${utcDay(to)}${from}${after}.${last}`);
    }
    this.#notify(kept.box.thread);
    return kept;
  }

  #recoverKeep(operation: SnapshotOperation, listing: readonly HeldSnapshot[]): boolean {
    const ledger = this.#deps.ledger;
    const record = ledger.record(operation.snapshots[0] ?? "");
    const keep = keepConsentOf(operation);
    const now = this.#now();
    if (!record || !keep) {
      ledger.updateOperation(operation.id, { state: "failed", endedAt: now, error: "Its snapshot's record is gone." });
      return true;
    }
    const found = listing.find((held) => held.id === record.id && held.guest.ref === record.livesOn.ref) ?? null;
    if (found && found.keptUntil === keep.to) {
      this.#keepRecorded(operation, record, keep.to, ", confirmed from its label after bb-box restarted");
      return true;
    }
    const words = found ? `Its label on ${where(record)} says ${found.keptUntil === null ? "no keep date" : `kept until ${utcDay(found.keptUntil)}`}, so the change did not reach it, and bb-box kept the record as it was.` : `${where(record)} no longer lists it, so bb-box changed nothing.`;
    ledger.updateOperation(operation.id, { state: "failed", endedAt: now, error: words });
    this.#notify(record.box.thread);
    return true;
  }

  async #settleKeeps(backend: Backend, box: Pick<BoxRecord, "id" | "name">): Promise<void> {
    const ledger = this.#deps.ledger;
    const cut = ledger.unsettled().filter((operation) => operation.kind === "keep" && operation.box === box.id && !this.#running.has(operation.id));
    if (!cut.length) return;
    const cannot = (why: string) => new BoxError("unreachable", `bb-box could not confirm a change to the keep date of a snapshot of box ${box.name}, so it deleted nothing: ${why}`);
    if (!backend.heldSnapshots) throw cannot(`${backend.label} cannot list its snapshots.`);
    let listing: readonly HeldSnapshot[];
    try {
      listing = await backend.heldSnapshots(this.#stopping.signal);
    } catch (error) {
      if (this.#stopping.signal.aborted) throw error;
      throw cannot(sentence(message(error)));
    }
    for (const operation of cut) this.#recoverKeep(operation, listing);
  }

  async #unkeepNow(id: string, by: Actor, why: string | null): Promise<SnapshotRecord> {
    const ledger = this.#deps.ledger;
    const record = ledger.record(id);
    if (!record) throw new BoxError("not_found", `bb-box has no snapshot ${id}: it was deleted.`);
    const verdict = eligible(record, "unkeep", { pin: ledger.pins().get(id) ?? null, now: this.#now() });
    if (!verdict.ok) throw new BoxError("in_use", verdict.why);
    if (record.boxGone) throw new BoxError("unsupported", `Box ${record.box.name} is gone, and only its keep holds ${quoted(record)}. Delete it instead, or keep it longer.`);
    return this.#writeKeep(record, by, null, why);
  }

  async holdKept(box: BoxRecord, by: Actor): Promise<void> {
    const ledger = this.#deps.ledger;
    const backend = this.#deps.backends.get(box.backend);
    const offer = this.offerFor(backend, box.kind);
    if (offer?.lives === "provider" && backend && box.guest) await this.#dropWithRelease(box, backend);
    if (offer?.keepsPastRelease !== "held-copy" || !box.guest) return;
    if (ledger.problem) {
      const kept = await this.#keptLabelsOn(backend!, box);
      if (kept.length) throw new ReleaseWaits("unreachable", `bb-box cannot read its snapshots' records, so it cannot copy what box ${box.name} holds that you kept, and deleted nothing: its labels on ${box.backendLabel} say ${kept.length === 1 ? "one is" : `${kept.length} are`} kept.`);
      return;
    }
    await this.#settleKeeps(backend!, box);
    const labelled = await this.#keptLabelsOn(backend!, box);
    const unrecorded = labelled.find((held) => {
      const record = ledger.record(held.id);
      return !record || record.keptUntil === null || record.keptUntil <= this.#now();
    });
    if (unrecorded) {
      throw new ReleaseWaits("try_again", `Box ${box.name}'s label on ${box.backendLabel} says snapshot ${unrecorded.id} is kept until ${utcDay(unrecorded.keptUntil!)}, and bb-box's records do not say so yet, so it deleted nothing. bb-box checks its records against the labels at its next sweep.`);
    }
    const ofBox = ledger.records({ box: box.id });
    const untrusted = ofBox.find((record) => record.guest === "held-copy" && record.keptUntil !== null && record.keptUntil > this.#now() && record.state !== "ready" && heldByProvider(record));
    if (untrusted) {
      throw new ReleaseWaits("failed", `The held copy of ${quoted(untrusted)}, which you kept, guest ${untrusted.livesOn.ref}, is not a template, so bb-box does not trust it, and deleted nothing. Delete that snapshot, then release the box again.`);
    }
    const now = this.#now();
    const waiting = ofBox.filter((record) => record.keptUntil !== null && record.keptUntil > now && record.guest !== "held-copy" && heldByProvider(record)).sort((a, b) => a.takenAt - b.takenAt || a.id.localeCompare(b.id));
    for (const record of waiting) {
      if (record.state !== "ready") {
        throw new BoxError(record.state === "unavailable" ? "unreachable" : "failed", `bb-box cannot copy ${quoted(record)}, which you kept, while it is ${stateWords(record)}, so it deleted nothing.`);
      }
      if (record.forkSafe === null) {
        throw new BoxError("unsupported", `bb-box cannot tell whether a fork could use ${quoted(record)}, which you kept: its record was found again without its identity reset's version. So it deleted nothing. Release the box and delete what you kept, or delete that snapshot first.`);
      }
      const cutShort = ledger.unsettled().find((operation) => operation.kind === "hold-copy" && operation.snapshots[0] === record.id) ?? null;
      await this.#holdCopy(record, box, by, cutShort);
    }
  }

  async #dropWithRelease(box: BoxRecord, backend: Backend): Promise<void> {
    const stays = (why: string) =>
      new ReleaseWaits("unreachable", `Box ${box.name}'s snapshots live on ${backend.label}'s account, not on the box, and would go on costing after its release, so bb-box released nothing: ${why} Release the box again.`);
    const words = await this.#dropProviderSnapshots(backend, box.id, box.guest!, byBbBox("its box was released"));
    if (words) throw stays(words);
  }

  #onProvider(record: SnapshotRecord): boolean {
    const backend = this.#deps.backends.get(record.backend.id);
    return backend ? this.#livesOnProvider(backend) : false;
  }

  #livesOnProvider(backend: Backend): boolean {
    return backend.kinds().some((kind) => this.offerFor(backend, kind.id)?.lives === "provider");
  }

  async #listedFor(backend: Backend, boxId: string, guest: Guest): Promise<readonly HeldSnapshot[] | string> {
    if (!backend.snapshotsOn) return `${backend.label} cannot list one box's snapshots.`;
    try {
      return (await backend.snapshotsOn(guest, this.#stopping.signal)).filter((held) => held.box === boxId && held.where !== "held-copy");
    } catch (error) {
      if (this.#stopping.signal.aborted) throw error;
      return `bb-box could not list the box's snapshots on ${backend.label}: ${sentence(message(error))}`;
    }
  }

  async #dropProviderSnapshots(backend: Backend, boxId: string, guest: Guest, by: Actor): Promise<string | null> {
    const ledger = this.#deps.ledger;
    if (!backend.deleteSnapshot) return `${backend.label} cannot delete its snapshots.`;
    const listed = await this.#listedFor(backend, boxId, guest);
    if (typeof listed === "string") return listed;
    const now = this.#now();
    const kept = (id: string, label: number | null) => (label !== null && label > now) || (!ledger.problem && (ledger.record(id)?.keptUntil ?? null) !== null);
    for (const held of listed) if (held.keptUntil !== null && held.keptUntil > now && (ledger.problem || ledger.record(held.id)?.keptUntil === null)) return `${backend.label}'s label says snapshot ${held.id} is kept, and bb-box's records do not say so.`;
    if (!ledger.problem) {
      for (const record of ledger.records({ box: boxId })) {
        if (record.keptUntil !== null || record.backend.id !== backend.id || !heldByProvider(record)) continue;
        try {
          await this.#delete(record.id, by, "delete", null);
        } catch (error) {
          if (this.#stopping.signal.aborted) throw error;
          return `bb-box could not delete ${quoted(record)}: ${sentence(message(error))}`;
        }
      }
    }
    for (const held of listed) {
      if (kept(held.id, held.keptUntil) || (!ledger.problem && ledger.record(held.id))) continue;
      try {
        await backend.deleteSnapshot({ id: held.id, ref: held.ref, guest: held.guest }, { submitting: async () => {}, task: async () => {} }, this.#stopping.signal);
        this.#deps.log?.(`Deleted snapshot ${held.id} of box ${boxId} on ${backend.label}, which bb-box had no record of, with its box.`);
      } catch (error) {
        if (this.#stopping.signal.aborted) throw error;
        return `bb-box could not delete snapshot ${held.id}: ${sentence(message(error))}`;
      }
    }
    const after = await this.#listedFor(backend, boxId, guest);
    if (typeof after === "string") return `${after.replace(/\.$/, "")}, to confirm the deletes.`;
    const left = after.filter((held) => !kept(held.id, held.keptUntil));
    return left.length ? `${backend.label} still lists ${left.length === 1 ? `snapshot ${left[0]!.id}` : `${left.length} of its snapshots`} after their deletes.` : null;
  }

  async #keptLabelsOn(backend: Backend, box: BoxRecord): Promise<readonly HeldSnapshot[]> {
    const cannot = (why: string) => new ReleaseWaits("unreachable", `bb-box could not read the labels of box ${box.name}'s snapshots on ${box.backendLabel}, so it cannot tell whether one is kept, and deleted nothing: ${why}`);
    if (!backend.snapshotsOn) throw cannot(`${backend.label} cannot list one guest's snapshots.`);
    let listing: readonly HeldSnapshot[];
    try {
      listing = await backend.snapshotsOn(box.guest!, this.#stopping.signal);
    } catch (error) {
      if (this.#stopping.signal.aborted) throw error;
      throw cannot(sentence(message(error)));
    }
    const now = this.#now();
    return listing.filter((held) => held.where !== "held-copy" && held.keptUntil !== null && held.keptUntil > now);
  }

  async holdKeptOn(backendId: string, guestRef: string, by: Actor, boxId: string | null = null): Promise<string | null> {
    const ledger = this.#deps.ledger;
    if (ledger.problem) return `bb-box cannot read its snapshots' records (${ledger.problem.replace(/\.$/, "")}), so it keeps every guest that may hold one`;
    const backend = this.#deps.backends.get(backendId);
    if (backend && !backend.snapshot) return null;
    if (!backend?.heldSnapshots) return "bb-box cannot read its snapshots' labels on its backend, so it keeps the guest";
    let listing: readonly HeldSnapshot[];
    try {
      listing = await backend.heldSnapshots(this.#stopping.signal);
    } catch (error) {
      if (this.#stopping.signal.aborted) throw error;
      return `bb-box could not read its snapshots' labels (${sentence(message(error)).replace(/\.$/, "")}), so it keeps the guest until it can`;
    }
    const now = this.#now();
    if (boxId && this.#livesOnProvider(backend)) {
      const guest = listing.find((held) => held.guest.ref === guestRef)?.guest ?? { ref: guestRef, host: null, address: null, size: null, data: { box: boxId } };
      const words = await this.#dropProviderSnapshots(backend, boxId, guest, by);
      return words ? `its box's snapshots live on ${backend.label}'s account and would go on costing, and ${words.charAt(0).toLowerCase()}${words.slice(1).replace(/\.$/, "")}; bb-box tries again at its next sweep` : null;
    }
    for (const held of listing.filter((each) => each.guest.ref === guestRef && each.where !== "held-copy" && each.keptUntil !== null && each.keptUntil > now)) {
      const record = ledger.record(held.id);
      if (!record || record.keptUntil === null) return `its label says snapshot ${held.id} is kept until ${utcDay(held.keptUntil!)}, and bb-box's records do not say so yet, so it keeps the guest until they do`;
    }
    const waiting = ledger.records({ backend: backendId }).filter((record) => record.livesOn.ref === guestRef && record.guest !== "held-copy" && record.keptUntil !== null && record.keptUntil > now && heldByProvider(record));
    for (const record of waiting) {
      if (record.state !== "ready") return `it holds ${quoted(record)}, which you kept, and which is ${stateWords(record)}`;
      if (record.forkSafe === null) return `it holds ${quoted(record)}, which you kept, and bb-box cannot tell whether a fork could use it, as its record was found again without its identity reset's version`;
      try {
        const cutShort = ledger.unsettled().find((operation) => operation.kind === "hold-copy" && operation.snapshots[0] === record.id) ?? null;
        await this.#deps.boxes.inTurn(record.box.id, () => this.#holdCopy(record, null, by, cutShort));
      } catch (error) {
        if (this.#stopping.signal.aborted) throw error;
        return `bb-box could not copy ${quoted(record)}, which you kept, before releasing it: ${sentence(message(error))}`;
      }
    }
    return null;
  }

  leftoverReleased(backendId: string, guestRef: string, boxId: string | null, why: string): void {
    const ledger = this.#deps.ledger;
    try {
      const backend = this.#deps.backends.get(backendId);
      if (backend && this.#livesOnProvider(backend)) return;
      const gone = ledger.records({ backend: backendId }).filter((record) => record.livesOn.ref === guestRef && record.guest !== "held-copy");
      const now = this.#now();
      const outlive = boxId ? ledger.records({ box: boxId }).filter((record) => record.guest === "held-copy" && record.boxGone === null) : [];
      if (!gone.length && !outlive.length) return;
      const by = byBbBox(`its guest ${guestRef} was released: ${why.replace(/\.$/, "")}`);
      ledger.transaction(() => {
        for (const record of gone) {
          ledger.removeRecord(record.id);
          ledger.insertOperation(this.#settled(record, by, now));
        }
        for (const record of outlive) ledger.updateRecord(record.id, { boxGone: { at: now, how: "released" } });
      });
      for (const record of gone) if (heldByProvider(record)) this.#event(record, "snapshot-deleted", by, `"${record.name}" (${record.id}): it went with guest ${guestRef}.`);
      for (const thread of new Set(gone.map((record) => record.box.thread))) this.#notify(thread);
    } catch (error) {
      this.#deps.logError(`settle the snapshots of released guest ${guestRef}`, error);
    }
  }

  async #holdCopy(record: SnapshotRecord, box: BoxRecord | null, by: Actor, existing: SnapshotOperation | null): Promise<SnapshotRecord> {
    const ledger = this.#deps.ledger;
    const signal = this.#stopping.signal;
    const backend = this.#deps.backends.get(record.backend.id);
    const copier = backend?.copySnapshot && backend.disarmCopy && backend.templateCopy && backend.copyState && backend.deleteCopy ? backend : null;
    if (!copier) throw new BoxError("unsupported", `${record.backend.label} cannot make held copies, so bb-box cannot keep ${quoted(record)} past the release of box ${record.box.name}.`);
    const source = existing?.guests?.old ?? this.#guestOf(record, box);
    const refused = (words: string, code: BoxError["code"]) => new BoxError(code, `bb-box could not copy ${quoted(record)}, which you kept: ${words}`);
    let operation: SnapshotOperation;
    if (existing) operation = existing;
    else {
      if (!copier.planSnapshots) throw refused(`${copier.label} cannot say where it would be copied, so bb-box deleted nothing.`, "unsupported");
      let plan: SnapshotPlan;
      try {
        plan = await copier.planSnapshots(source, record.box.kind, this.#refOf(record, box), signal);
      } catch (error) {
        if (signal.aborted) throw error;
        throw refused(`bb-box could not read where it would be copied, so it deleted nothing: ${sentence(message(error))}`, "unreachable");
      }
      if (plan.locked) throw refused(`${copier.label} left guest ${source.ref} locked (${plan.locked.lock}). ${plan.locked.fix}`, "locked");
      if (plan.busy) throw refused(plan.busy, "try_again");
      const bytes = plan.keep.usedBytes ?? plan.keep.bytes ?? 0;
      const admitted = ledger.transaction((): SnapshotOperation | string => {
        const room = this.#copyRoom(source.host, plan.storage, bytes, ledger.reservedBytes(plan.storage.key));
        if (room) return `${room}.`;
        const made: SnapshotOperation = {
          id: newOperationId(this.#random),
          request: null,
          requestDigest: null,
          kind: "hold-copy",
          box: record.box.id,
          guest: source.ref,
          snapshots: [record.id],
          by,
          consent: null,
          undo: null,
          guests: { old: source, new: null },
          step: "planned",
          task: null,
          state: "running",
          reserved: { storage: plan.storage.key, bytes, price: null },
          error: null,
          startedAt: this.#now(),
          endedAt: null,
          snapshotsGoneAt: null,
        };
        ledger.insertOperation(made);
        return made;
      });
      if (typeof admitted === "string") throw refused(admitted, "try_again");
      operation = admitted;
    }
    this.#running.add(operation.id);
    const step = (change: Partial<SnapshotOperation>) => {
      operation = ledger.updateOperation(operation.id, change) ?? { ...operation, ...change };
    };
    const after = existing ? " after it was cut short" : "";
    const fail = (words: string, code: BoxError["code"] = "failed"): never => {
      step({ state: "failed", endedAt: this.#now(), error: words });
      throw new BoxError(code, `bb-box could not copy ${quoted(record)}, which you kept: ${words}`);
    };
    try {
      let finished: Guest | null = null;
      if (existing) {
        const resumed = await this.#resumeCopy(record, operation, copier, source, after);
        if (resumed && "made" in resumed) return resumed.made;
        if (resumed) {
          finished = resumed.finish;
          step({ step: "copy-cloned", guests: { old: source, new: finished }, state: "running", error: null });
        } else step({ step: "planned", task: null, guests: { old: source, new: null }, state: "running", error: null });
      }
      if (!finished) await this.#deps.hold?.(operation, "planned", signal);
      const began = this.#now();
      const label = heldCopyLabelOf(record);
      const makeTemplate = async (made: Guest) => {
        await copier.disarmCopy!(made, signal);
        step({ step: "copy-disarmed" });
        await copier.templateCopy!(made, signal);
        if ((await copier.copyState!(made, signal)) !== "template") throw new SnapshotFailed(`${copier.label} did not make guest ${made.ref} a template.`);
      };
      let copy: Guest | null = finished;
      try {
        if (finished) copy = await copier.labelCopy!(finished, label, signal);
        else {
          const hooks: CopyHooks = {
            claimed: async (claimed) => step({ step: "copy-claimed", guests: { old: source, new: claimed } }),
            submitting: async () => {
              const at = this.#now();
              step({ step: "copy-submitting", task: null, stepAt: at, attempts: [...(operation.attempts ?? []), { at, task: null }] });
            },
            task: async (task) => {
              step({ step: "copy-task", task, attempts: withAttemptTask(operation.attempts, task) });
              await this.#deps.hold?.(operation, "task", signal);
            },
          };
          copy = await copier.copySnapshot!({ id: record.id, ref: record.ref ?? "", guest: source }, label, hooks, signal);
        }
        step({ step: "copy-cloned", guests: { old: source, new: copy } });
        await this.#deps.hold?.(operation, "copied", signal);
        await makeTemplate(copy);
      } catch (error) {
        if (signal.aborted) throw error;
        let words = sentence(message(error));
        const partial = copy ?? operation.guests?.new ?? null;
        const task = partial && partial.ref !== source.ref ? await this.#copyTaskSeen(operation, copier, source) : null;
        if (partial && task === "ok" && copier.labelCopy) {
          try {
            this.#deps.log?.(`Guest ${partial.ref}, the copy of snapshot ${record.id} of box ${record.box.name}, which ${copier.label} finished as bb-box's wait for it ran out, becomes its held copy now.`);
            const labelled = await copier.labelCopy(partial, label, signal);
            step({ step: "copy-cloned", guests: { old: source, new: labelled } });
            await makeTemplate(labelled);
            return this.#copyMade(record, operation, labelled, `once ${copier.label} finished it, as bb-box's wait for it ran out`);
          } catch (again) {
            if (signal.aborted) throw again;
            words = sentence(message(again));
          }
        }
        if (partial && task === "running") {
          const still = `${words} ${copier.label} may still be making its copy, guest ${partial.ref}: bb-box waits for that task, and makes the copy a template once it ends well.`;
          step({ state: "unknown", error: still });
          this.#waitedOut.add(operation.id);
          throw new ReleaseWaits("failed", `bb-box could not copy ${quoted(record)}, which you kept: ${still}`);
        }
        if (partial && partial.ref !== source.ref && !(await this.#dropCopy(copier, partial, record))) {
          step({ state: "unknown", error: `${words} Its part-made copy, guest ${partial.ref}, is not deleted yet; bb-box tries again at its next sweep.` });
          throw new ReleaseWaits("failed", `bb-box could not copy ${quoted(record)}, which you kept: ${words} Its part-made copy, guest ${partial.ref}, is not deleted yet; bb-box tries again at its next sweep.`);
        }
        return fail(words);
      }
      return this.#copyMade(record, operation, copy, finished ? `once ${copier.label} finished it, after bb-box's wait for it ran out` : `in ${seconds(this.#now() - began)}`);
    } finally {
      this.#running.delete(operation.id);
    }
  }

  async #copyTaskSeen(operation: SnapshotOperation, backend: Backend, source: Guest): Promise<"running" | "ok" | null> {
    const current = this.#deps.ledger.operation(operation.id) ?? operation;
    if (current.step !== "copy-submitting" && current.step !== "copy-task") return null;
    const task = await this.#taskOf(current, backend, source, this.#stopping.signal, "copy");
    if (task?.state === "running" || task?.state === "unreadable") return "running";
    return task?.state === "ok" ? "ok" : null;
  }

  async #dropCopy(backend: Backend, copy: Guest, record: SnapshotRecord): Promise<boolean> {
    try {
      await backend.deleteCopy!(copy, this.#stopping.signal);
      return true;
    } catch (error) {
      if (this.#stopping.signal.aborted) throw error;
      this.#deps.logError(`delete the part-made held copy ${copy.ref} of snapshot ${record.id}`, error);
      return false;
    }
  }

  async #resumeCopy(record: SnapshotRecord, operation: SnapshotOperation, backend: Backend, source: Guest, after: string): Promise<{ readonly made: SnapshotRecord } | { readonly finish: Guest } | null> {
    const signal = this.#stopping.signal;
    const unsure = (words: string): never => {
      this.#deps.ledger.updateOperation(operation.id, { state: "unknown", error: words });
      throw new ReleaseWaits("try_again", `bb-box could not confirm the held copy of ${quoted(record)}: ${words} It checks again at its next sweep.`);
    };
    let clonedWell = false;
    if (operation.step === "copy-submitting" || operation.step === "copy-task") {
      const task = await this.#taskOf(operation, backend, source, signal, "copy");
      if (task?.state === "unreadable") unsure(`bb-box could not read the copy's task: ${sentence(task.words)}`);
      if (task?.state === "running") unsure(`${backend.label} was still making the copy when bb-box looked.`);
      clonedWell = task?.state === "ok";
    }
    const waitedOut = this.#waitedOut.delete(operation.id);
    const copy = this.#deps.ledger.operation(operation.id)?.guests?.new ?? null;
    if (!copy) return null;
    const plan = backend.copyPlan ? await backend.copyPlan(copy, signal).catch(() => null) : { state: await backend.copyState!(copy, signal).catch(() => "gone" as const), size: null, running: false };
    if (!plan) return unsure(`bb-box could not read its copy, guest ${copy.ref}.`);
    if (plan.state === "template") return { made: this.#copyMade(record, operation, copy, `confirmed${after}`) };
    if (plan.state === "copy" && clonedWell && waitedOut && !plan.running && backend.labelCopy) {
      this.#deps.log?.(`Guest ${copy.ref}, the copy of snapshot ${record.id} of box ${record.box.name} that ${backend.label} finished after bb-box's wait for it ran out, becomes its held copy now.`);
      return { finish: copy };
    }
    if (plan.state === "copy") {
      if (plan.running) this.#event(record, "held-copy-started", byBbBox("its held copy ran before it was a template"), `"${record.name}" (${record.id}): its copy, guest ${copy.ref}, was running before it was a template. bb-box deletes it and makes it again from the snapshot.`);
      if (!(await this.#dropCopy(backend, copy, record))) unsure(`bb-box could not delete its copy, guest ${copy.ref}, which is not a template yet and so not trusted.`);
      this.#deps.log?.(`Deleted guest ${copy.ref}, the held copy of snapshot ${record.id} of box ${record.box.name}: it was not a template yet${after}, so it is not trusted. bb-box makes it again from the snapshot.`);
    }
    return null;
  }

  #copyMade(record: SnapshotRecord, operation: SnapshotOperation, copy: Guest, how: string): SnapshotRecord {
    const ledger = this.#deps.ledger;
    const now = this.#now();
    const moved = ledger.transaction(() => {
      const updated = ledger.updateRecord(record.id, { guest: "held-copy", livesOn: copy, host: copy.host, ref: copy.ref, holds: "disk", stateAt: now, missingSince: null, error: null });
      ledger.updateOperation(operation.id, { state: "done", step: "done", endedAt: now, error: null, guests: { old: operation.guests?.old ?? null, new: copy } });
      return updated;
    });
    const made = moved ?? record;
    this.#event(made, "held-copy-made", operation.by, `"${made.name}" (${made.id}): kept until ${keepLabel(made.keptUntil) ?? "its date"}, copied in full into guest ${copy.ref}, a template that cannot start, ${how}.${record.holds === "disk-and-memory" ? " The copy holds its disk only." : ""}`);
    this.#notify(made.box.thread);
    return made;
  }

  async #recoverHoldCopy(operation: SnapshotOperation): Promise<boolean> {
    const ledger = this.#deps.ledger;
    const record = ledger.record(operation.snapshots[0] ?? "");
    if (!record || record.guest === "held-copy") {
      ledger.updateOperation(operation.id, record ? { state: "done", step: "done", endedAt: this.#now(), error: null } : { state: "failed", endedAt: this.#now(), error: "Its snapshot's record is gone." });
      return true;
    }
    const box = await this.#deps.boxes.find(record.box.id);
    try {
      await this.#holdCopy(record, box, operation.by, operation);
    } catch (error) {
      if (this.#stopping.signal.aborted) throw error;
      this.#deps.log?.(`The held copy of snapshot ${record.id} of box ${record.box.name}, cut short, did not finish: ${message(error)}`);
    }
    return true;
  }

  async #relabel(
    caller: Caller,
    standing: Standing,
    ref: string,
    change: "rename" | "note",
    next: (current: SnapshotRecord, ofBox: readonly SnapshotRecord[]) => Partial<SnapshotRecord> | BoxError,
  ): Promise<SnapshotRecord> {
    const target = this.find(caller, standing, ref);
    const allowed = mayAct(caller, change, standing, target);
    if (!allowed.ok) throw new BoxError("not_owner", allowed.why);
    this.#requireStore(change === "rename" ? "renames" : "notes");
    const ledger = this.#deps.ledger;
    const now = eligible(target, change, { pin: ledger.pins().get(target.id) ?? null, now: this.#now() });
    if (!now.ok) throw new BoxError("in_use", now.why);
    const outcome = await this.#deps.boxes.inTurn(target.box.id, async () =>
      ledger.transaction((): SnapshotRecord | BoxError => {
        const current = ledger.record(target.id);
        if (!current) return new BoxError("not_found", `bb-box has no snapshot ${target.id}: it was deleted.`);
        const verdict = eligible(current, change, { pin: ledger.pins().get(current.id) ?? null, now: this.#now() });
        if (!verdict.ok) return new BoxError("in_use", verdict.why);
        const changes = next(current, ledger.records({ box: current.box.id }));
        if (changes instanceof BoxError) return changes;
        return ledger.updateRecord(current.id, changes) ?? current;
      }),
    );
    if (outcome instanceof BoxError) throw outcome;
    this.#notify(outcome.box.thread);
    return outcome;
  }

  lastRestore(boxId: string): { readonly operation: SnapshotOperation; readonly running: boolean } | null {
    const operation = this.#deps.ledger.operations({ box: boxId, kind: "restore" }).at(-1);
    return operation ? { operation, running: this.#running.has(operation.id) } : null;
  }

  async guardOf(box: BoxRecord): Promise<RestoreGuard> {
    return this.#deps.guard ? this.#deps.guard(box) : { threads: [], threadsUnread: null, control: false, terminals: 0 };
  }

  async #flushWrites(box: BoxRecord, backend: Backend, guest: Guest, signal: AbortSignal): Promise<string | null> {
    if (box.state !== "ready") return null;
    try {
      return await withinWait(async (late) => {
        const both = AbortSignal.any([signal, late]);
        const command = (await backend.transports(guest, box.kind)).command;
        if (!command) return "bb-box has no way to run a command in it";
        const ran = await command.run(box.capabilities.os === "windows" ? WINDOWS_FLUSH : UNIX_FLUSH, { timeoutMs: FLUSH_WAIT_MS, signal: both, maxOutputBytes: 4096 });
        return ran.exitCode === 0 ? null : `${ran.stderr.trim() || `it ended with exit code ${ran.exitCode}`}`;
      }, FLUSH_WAIT_MS);
    } catch (error) {
      if (signal.aborted) throw error;
      return message(error);
    }
  }

  async #forkSafe(box: BoxRecord, backend: Backend): Promise<ForkSafety> {
    const none: ForkSafety = { version: null, identity: null };
    if (box.state !== "ready" || box.capabilities.os !== "linux" || !box.guest) return none;
    try {
      const command = (await backend.transports(box.guest, box.kind)).command;
      return command ? await readForkSafe(command, this.#stopping.signal) : none;
    } catch (error) {
      if (this.#stopping.signal.aborted) throw error;
      this.#deps.log?.(`Could not read box ${box.name}'s identity reset at a take, so the snapshot is not fork-safe: ${message(error)}`);
      return none;
    }
  }

  #roomProblem(box: BoxRecord, storage: SnapshotStorage, adds: number, memory: boolean, roomPercent: number): string | null {
    const on = `${box.guest?.host ? `${box.guest.host}'s ` : ""}storage ${storage.name}`;
    const past = roomThresholds(roomPercent);
    const percent = storage.totalBytes && storage.usedBytes !== null ? ((storage.usedBytes + adds) / storage.totalBytes) * 100 : storage.percentFull;
    if (percent > past.takes) {
      const now = storage.percentFull > past.takes ? `is ${Math.round(storage.percentFull)}% full` : `would be ${Math.round(percent)}% full with ${memory ? "its memory" : "it"}`;
      return `${on} ${now}, and your settings take no snapshot past ${past.takes}%: a full thin pool stops every box there. Delete snapshots or release boxes on it first, or raise the limit in Settings, Snapshots.`;
    }
    if (storage.metadataPercentFull !== null && storage.metadataPercentFull > past.metadata) {
      return `${on}'s metadata is ${Math.round(storage.metadataPercentFull)}% full, and bb-box takes no snapshot past ${past.metadata}%, 5 points below your settings' ${past.takes}%. Delete snapshots on it first.`;
    }
    return null;
  }

  #hooks(operation: SnapshotOperation): SnapshotHooks {
    return {
      submitting: async () => {
        this.#deps.ledger.updateOperation(operation.id, { step: "submitting" });
      },
      task: async (task) => {
        this.#deps.ledger.updateOperation(operation.id, { step: "task", task });
        await this.#deps.hold?.(operation, "task", this.#stopping.signal);
      },
    };
  }

  async #runTake(record: SnapshotRecord, operation: SnapshotOperation, box: BoxRecord, backend: Backend, counted: number): Promise<TakeAnswer> {
    const ledger = this.#deps.ledger;
    this.#running.add(operation.id);
    try {
      await this.#deps.hold?.(operation, "planned", this.#stopping.signal);
      const unflushed = await this.#flushWrites(box, backend, box.guest!, this.#stopping.signal);
      if (unflushed) {
        record = ledger.updateRecord(record.id, { unflushed }) ?? record;
        this.#deps.log?.(`Took snapshot ${record.id} of box ${box.name} without flushing its writes first: ${unflushed}`);
      }
      const stillWhileTaken = record.holds === "disk" && this.offerFor(backend, box.kind)?.whileRunning === "live";
      const picturing = this.#keepPicture(record.id, box);
      if (!stillWhileTaken) await picturing;
      const began = this.#now();
      let taken;
      try {
        taken = await backend.snapshot!(box.guest!, { id: record.id, box: box.id, memory: record.holds === "disk-and-memory", forkSafe: record.forkSafe }, this.#hooks(operation), this.#stopping.signal);
      } catch (error) {
        if (this.#stopping.signal.aborted) throw error;
        throw this.#takeFailed(record, operation, error);
      } finally {
        await picturing;
      }
      const now = this.#now();
      const evicting = consentOf(operation).evicts !== null;
      const ready = ledger.transaction(() => {
        const updated = ledger.updateRecord(record.id, { state: "ready", ref: taken.ref, holds: taken.holds, capturedAt: taken.capturedAt, size: taken.size, tookMs: now - began, stateAt: now, error: null });
        const done = ledger.updateOperation(operation.id, evicting ? { step: "evicting", error: null } : { state: "done", step: "done", endedAt: now, error: null });
        return { updated, done };
      });
      const snapshot = ready.updated ?? record;
      this.#event(snapshot, "snapshot-taken", record.by, `"${snapshot.name}" (${snapshot.id}): ${holdsWords(snapshot)}, in ${seconds(now - began)}.`);
      this.#notify(box.threadId);
      return { snapshot, operation: ready.done ?? operation, counted, repeated: false };
    } finally {
      this.#running.delete(operation.id);
    }
  }

  #takeFailed(record: SnapshotRecord, operation: SnapshotOperation, error: unknown): BoxError {
    const ledger = this.#deps.ledger;
    const now = this.#now();
    const words = sentence(message(error));
    if (error instanceof SnapshotFailed || error instanceof SnapshotIncomplete) {
      const incomplete = error instanceof SnapshotIncomplete;
      ledger.transaction(() => {
        ledger.updateRecord(record.id, { state: incomplete ? "incomplete" : "failed", error: words, stateAt: now });
        ledger.updateOperation(operation.id, { state: "failed", endedAt: now, error: words });
      });
      this.#event(record, "snapshot-failed", record.by, `"${record.name}": ${words}${incomplete ? ` Part of it is left on ${where(record)}.` : ""}`);
      this.#notify(record.box.thread);
      return new BoxError(
        "failed",
        incomplete
          ? `bb-box could not finish snapshot "${record.name}" of box ${record.box.name}: ${words} Part of it is left on ${where(record)}: delete it to finish the clean-up there.`
          : `bb-box could not take snapshot "${record.name}" of box ${record.box.name}: ${words}`,
      );
    }
    ledger.updateOperation(operation.id, { state: "unknown", error: words });
    this.#deps.log?.(`Could not confirm the take of snapshot ${record.id} of box ${record.box.name}: ${words}`);
    return new BoxError("unreachable", `bb-box could not confirm the take of snapshot "${record.name}" of box ${record.box.name}: ${words} It checks again at its next sweep, within a few minutes; bb box snapshot list says how it ended.`);
  }

  async delete(caller: Caller, standing: Standing, ref: string, options: { readonly request?: string } = {}): Promise<DeleteAnswer> {
    const by: Actor = caller.is === "agent" ? { is: "agent", threadId: caller.threadId } : caller;
    const request = options.request ? { key: requestKey(by, options.request), given: options.request, digest: requestDigest("delete", standing.box?.id ?? "", { snapshot: ref }) } : null;
    if (request) {
      this.#requireStore("deletes");
      const earlier = this.#earlier(by, request.given, request.digest);
      if (earlier) return this.#deletedBefore(earlier);
    }
    const record = this.find(caller, standing, ref);
    const allowed = mayAct(caller, "delete", standing, record);
    if (!allowed.ok) throw new BoxError("not_owner", allowed.why);
    return this.#deps.boxes.inTurn(record.box.id, () => this.#delete(record.id, by, "delete", request));
  }

  #deletedBefore(operation: SnapshotOperation): DeleteAnswer {
    return { snapshot: this.#deps.ledger.record(operation.snapshots[0] ?? ""), operation, repeated: true };
  }

  findGone(boxRef: string, ref: string): SnapshotRecord {
    const ofBox = this.#deps.ledger.records().filter((record) => record.boxGone !== null && (record.box.id === boxRef || record.box.name === boxRef));
    const found = ofBox.find((record) => record.id === ref) ?? ofBox.find((record) => record.name === ref);
    if (!found) throw new BoxError("not_found", `bb-box has no snapshot "${ref}" of a box ${boxRef} that is gone.`);
    return found;
  }

  async deleteGone(record: SnapshotRecord, by: Actor): Promise<DeleteAnswer> {
    return this.#deps.boxes.inTurn(record.box.id, () => this.#delete(record.id, by, "delete", null));
  }

  #guestOf(record: SnapshotRecord, box: BoxRecord | null): Guest {
    return record.guest === "current" && box?.guest ? box.guest : record.livesOn;
  }

  async #delete(id: string, by: Actor, change: Change, request: { readonly key: string; readonly given: string; readonly digest: string } | null): Promise<DeleteAnswer> {
    const ledger = this.#deps.ledger;
    if (request) {
      const earlier = this.#earlier(by, request.given, request.digest);
      if (earlier) return this.#deletedBefore(earlier);
    }
    const record = ledger.record(id);
    if (!record) throw new BoxError("not_found", `bb-box has no snapshot ${id}: it was deleted already.`);
    const verdict = eligible(record, change, { pin: ledger.pins().get(id) ?? null, now: this.#now() });
    if (!verdict.ok) throw new BoxError(record.state === "unavailable" ? "unreachable" : "in_use", verdict.why);
    this.#requireStore("deletes");
    if (record.state === "failed") {
      ledger.removeRecord(id);
      this.#notify(record.box.thread);
      return { snapshot: record, operation: null, repeated: false };
    }
    if (record.state === "lost") {
      ledger.removeRecord(id);
      this.#event(record, "snapshot-deleted", by, `"${record.name}" (${record.id}): bb-box had lost it, so there was nothing to free.`);
      this.#notify(record.box.thread);
      return { snapshot: record, operation: null, repeated: false };
    }
    const backend = this.#deps.backends.get(record.backend.id);
    if (!backend) throw new BoxError("backend_off", `The ${record.backend.label} backend that holds snapshot "${record.name}" is not in bb-box's settings, so bb-box cannot delete it.`);
    if (!backend.deleteSnapshot) throw new BoxError("unsupported", `${backend.label} cannot delete snapshots.`);
    const box = await this.#deps.boxes.find(record.box.id);
    const before = record.state;
    const now = this.#now();
    const operation: SnapshotOperation = {
      id: newOperationId(this.#random),
      request: request?.key ?? null,
      requestDigest: request?.digest ?? null,
      kind: "delete",
      box: record.box.id,
      guest: this.#guestOf(record, box).ref,
      snapshots: [id],
      by,
      consent: null,
      undo: null,
      guests: null,
      step: "planned",
      task: null,
      state: "running",
      reserved: null,
      error: null,
      startedAt: now,
      endedAt: null,
      snapshotsGoneAt: null,
    };
    const raced = ledger.transaction((): SnapshotOperation | "reused" | null => {
      if (request) {
        const earlier = ledger.byRequest(request.key);
        if (earlier) return earlier.requestDigest === request.digest ? earlier : "reused";
      }
      ledger.updateRecord(id, { state: "deleting", stateAt: now });
      ledger.insertOperation(operation);
      return null;
    });
    if (raced === "reused") throw reusedRequest(request!.given);
    if (raced) return this.#deletedBefore(raced);
    this.#notify(record.box.thread);
    return this.#runDelete({ ...record, state: "deleting" }, operation, backend, box, before);
  }

  async #runDelete(record: SnapshotRecord, operation: SnapshotOperation, backend: Backend, box: BoxRecord | null, before: SnapshotRecord["state"]): Promise<DeleteAnswer> {
    const ledger = this.#deps.ledger;
    this.#running.add(operation.id);
    try {
      await this.#deps.hold?.(operation, "planned", this.#stopping.signal);
      try {
        if (record.guest === "held-copy") {
          if (!backend.deleteCopy) throw new SnapshotFailed(`${backend.label} cannot delete held copies.`);
          await backend.deleteCopy(record.livesOn, this.#stopping.signal);
        } else {
          await backend.deleteSnapshot!({ id: record.id, ref: record.ref ?? "", guest: this.#guestOf(record, box) }, this.#hooks(operation), this.#stopping.signal);
        }
      } catch (error) {
        if (this.#stopping.signal.aborted) throw error;
        throw this.#deleteFailed(record, operation, before, error);
      }
      const now = this.#now();
      const done = ledger.transaction(() => {
        ledger.removeRecord(record.id);
        return ledger.updateOperation(operation.id, { state: "done", step: "done", endedAt: now, error: null });
      });
      this.#event(record, "snapshot-deleted", operation.by, `"${record.name}" (${record.id}): ${record.guest === "held-copy" ? `its held copy, guest ${record.livesOn.ref}, is deleted` : freedWords(record)}.`);
      if (record.guest === "earlier") await this.#deleteEarlierIfEmpty(record, backend);
      this.#notify(record.box.thread);
      return { snapshot: record, operation: done ?? operation, repeated: false };
    } finally {
      this.#running.delete(operation.id);
    }
  }

  async #deleteEarlierIfEmpty(record: SnapshotRecord, backend: Backend): Promise<void> {
    const left = this.#deps.ledger.records({ box: record.box.id }).filter((other) => other.guest === "earlier" && other.livesOn.ref === record.livesOn.ref);
    if (left.length || !backend.deleteCopy) return;
    try {
      await backend.deleteCopy(record.livesOn, this.#stopping.signal);
      this.#event(record, "snapshot-deleted", byBbBox("the last snapshot on an earlier guest went"), `The earlier guest ${record.livesOn.ref} of box ${record.box.name} is deleted: its last snapshot went.`);
    } catch (error) {
      if (this.#stopping.signal.aborted) throw error;
      this.#deps.log?.(`Could not delete the earlier guest ${record.livesOn.ref} of box ${record.box.name}, whose last snapshot went: ${message(error)} The next sweep tries again.`);
    }
  }

  #deleteFailed(record: SnapshotRecord, operation: SnapshotOperation, before: SnapshotRecord["state"], error: unknown): BoxError {
    const ledger = this.#deps.ledger;
    const now = this.#now();
    const words = sentence(message(error));
    if (error instanceof SnapshotFailed || error instanceof SnapshotIncomplete) {
      const incomplete = error instanceof SnapshotIncomplete;
      ledger.transaction(() => {
        ledger.updateRecord(record.id, { state: incomplete ? "incomplete" : before, error: words, stateAt: now });
        ledger.updateOperation(operation.id, { state: "failed", endedAt: now, error: words });
      });
      this.#notify(record.box.thread);
      return new BoxError(
        "failed",
        incomplete
          ? `bb-box could not finish deleting snapshot "${record.name}" of box ${record.box.name}: ${words} Part of it is left on ${where(record)}: delete it again to finish.`
          : `bb-box could not delete snapshot "${record.name}" of box ${record.box.name}: ${words}`,
      );
    }
    ledger.updateOperation(operation.id, { state: "unknown", error: words });
    this.#deps.log?.(`Could not confirm the delete of snapshot ${record.id} of box ${record.box.name}: ${words}`);
    return new BoxError("unreachable", `bb-box could not confirm the delete of snapshot "${record.name}" of box ${record.box.name}: ${words} It checks again at its next sweep, within a few minutes.`);
  }

  boxEnded(box: Pick<BoxRecord, "id" | "name" | "threadId">, how: "released" | "forgotten"): void {
    const ledger = this.#deps.ledger;
    try {
      const records = ledger.records({ box: box.id });
      if (!records.length) return;
      const now = this.#now();
      const gone: SnapshotRecord[] = [];
      const outlives: SnapshotRecord[] = [];
      ledger.transaction(() => {
        for (const operation of ledger.unsettled()) {
          if (operation.box !== box.id || this.#running.has(operation.id)) continue;
          ledger.updateOperation(operation.id, { state: "failed", endedAt: now, error: `Its box was ${how}.` });
        }
        for (const record of records) {
          if (how === "forgotten") {
            ledger.updateRecord(record.id, { boxGone: { at: now, how }, ...(heldByProvider(record) ? { state: "unavailable", error: "its box was forgotten while bb-box had no working backend for it", stateAt: now } : {}) });
            continue;
          }
          if (record.keptUntil !== null || (record.guest !== "current" && heldByProvider(record) && record.state !== "taking")) {
            ledger.updateRecord(record.id, { boxGone: { at: now, how } });
            continue;
          }
          if (heldByProvider(record) && this.#onProvider(record)) {
            ledger.updateRecord(record.id, { boxGone: { at: now, how } });
            outlives.push(record);
            continue;
          }
          ledger.removeRecord(record.id);
          ledger.insertOperation(this.#settled(record, byBbBox("its box was released"), now));
          gone.push(record);
        }
      });
      for (const record of gone) if (heldByProvider(record)) this.#event(record, "snapshot-deleted", byBbBox("its box was released"), `"${record.name}" (${record.id}): it went with its box.`);
      if (outlives.length) this.#deps.log?.(`Box ${box.name} was ${how} with ${outlives.length} of its snapshots still on its provider's account: bb-box deletes them at its next sweep.`);
      this.#notify(box.threadId);
    } catch (error) {
      this.#deps.logError(`settle the snapshots of box ${box.name}`, error);
    }
  }

  #settled(record: SnapshotRecord, by: Actor, now: number): SnapshotOperation {
    return {
      id: newOperationId(this.#random),
      request: null,
      requestDigest: null,
      kind: "delete",
      box: record.box.id,
      guest: record.livesOn.ref,
      snapshots: [record.id],
      by,
      consent: null,
      undo: null,
      guests: null,
      step: "done",
      task: null,
      state: "done",
      reserved: null,
      error: null,
      startedAt: now,
      endedAt: now,
      snapshotsGoneAt: now,
    };
  }

  holdsGuest(backendId: string, guestRef: string, ended = false): string | null {
    const ledger = this.#deps.ledger;
    if (ledger.problem) return `bb-box cannot read its snapshots' records (${ledger.problem.replace(/\.$/, "")}), so it keeps every guest that may hold one`;
    const pins = ledger.pins();
    const using = ledger.unsettled().find((operation) => operation.guests?.old?.ref === guestRef || operation.guests?.new?.ref === guestRef);
    if (using) return `${operationWords(using)}, which bb-box has not settled, uses it`;
    const keeps = (record: SnapshotRecord) => (ended ? (record.keptUntil !== null && record.guest !== "held-copy") || pins.has(record.id) : record.foundAt !== null || record.keptUntil !== null || record.guest !== "current" || pins.has(record.id));
    const held = ledger.records({ backend: backendId }).filter((record) => record.livesOn.ref === guestRef && keeps(record));
    if (!held.length) return null;
    const why = held.map((record) => (pins.has(record.id) ? "in use by an operation" : record.keptUntil !== null ? "kept" : record.guest === "held-copy" ? "a held copy" : record.guest === "earlier" ? "on an earlier guest" : "found, and kept until you delete it"));
    return `it holds ${held.length === 1 ? "a snapshot" : `${held.length} snapshots`} bb-box keeps: ${[...new Set(why)].join(", ")}`;
  }

  async restore(caller: Caller, box: BoxRecord, standing: Standing, ref: string, input: RestoreInput = {}): Promise<RestoreAnswer> {
    const by: Actor = caller.is === "agent" ? { is: "agent", threadId: caller.threadId } : caller;
    const target = this.find(caller, standing, ref);
    const allowed = mayAct(caller, "restore", standing, target);
    if (!allowed.ok) throw new BoxError("not_owner", allowed.why);
    if (caller.is === "agent" && input.undo === false) throw new BoxError("not_owner", `An agent's restore always takes an undo first. ${NOT_THE_AGENTS}`);
    if (caller.is === "agent" && input.force) throw new BoxError("not_owner", `Restoring past what a box would lose is the person's to do. ${NOT_THE_AGENTS}`);
    if (caller.is !== "agent" && input.yes) throw new BoxError("not_owner", "A yes given in a thread answers an agent's restore only.");
    if (caller.is === "agent" && input.unflushed === "go-on") throw new BoxError("not_owner", `Restoring with an undo that may miss the box's last writes is the person's to do. ${NOT_THE_AGENTS}`);
    this.#requireStore("restores");
    const digest = input.request ? requestDigest("restore", box.id, { snapshot: target.id, undo: input.undo !== false, force: input.force === true }) : null;
    if (input.request) {
      const earlier = this.#earlier(by, input.request, digest);
      if (earlier) return this.#restoredBefore(earlier);
    }
    try {
      return await this.#deps.boxes.inTurn(box.id, () => this.#restore(caller, standing, box.id, target.id, input, by, digest));
    } finally {
      this.#marksChanged();
    }
  }

  #marksChanged(): void {
    try {
      this.#deps.marksChanged?.();
    } catch (error) {
      this.#deps.logError("tell who holds turns that restores changed", error);
    }
  }

  #restoredBefore(operation: SnapshotOperation): RestoreAnswer {
    const ledger = this.#deps.ledger;
    return {
      snapshot: ledger.record(operation.snapshots[0] ?? ""),
      undo: operation.undo ? ledger.record(operation.undo) : null,
      operation,
      box: null,
      from: null,
      to: null,
      anyway: [],
      replaced: [],
      repeated: true,
    };
  }

  async #restore(caller: Caller, standing: Standing, boxId: string, targetId: string, input: RestoreInput, by: Actor, digest: string | null): Promise<RestoreAnswer> {
    const ledger = this.#deps.ledger;
    if (input.request) {
      const earlier = this.#earlier(by, input.request, digest);
      if (earlier) return this.#restoredBefore(earlier);
    }
    const prepared = await this.#prepare(caller, standing, boxId, targetId, input);
    const { box, target, backend, offer, plan, byCopy, swap, fromSnapshot, anyway, forkSafe } = prepared;
    if (prepared.through === "form" || input.yes) {
      const check = this.#checkOf(caller, prepared, input);
      const stale = input.yes !== undefined && input.yes.plan !== check.plan;
      if (prepared.through === "form" && (!input.yes || stale)) throw new YesNeeded(check, prepared.onAMachine ? "machine" : "settings", input.yes !== undefined);
      if (stale) throw new BoxError("in_use", `What restoring box ${box.name} would do changed after the yes was asked for, so bb-box restored nothing. Ask again with box_restore if it is still wanted.`);
    }
    const wantsUndo = input.undo !== false;
    const now = this.#now();
    const operationId = newOperationId(this.#random);
    const undoId = wantsUndo ? newSnapshotId(this.#random) : null;
    const undoBytes = this.#undoBytes(box, plan, byCopy);
    const admitted = ledger.transaction((): { refused: BoxError } | { repeat: SnapshotOperation } | { undo: SnapshotRecord | null; operation: SnapshotOperation } => {
      if (input.request) {
        const raced = ledger.byRequest(requestKey(by, input.request));
        if (raced) return raced.requestDigest === digest ? { repeat: raced } : { refused: reusedRequest(input.request) };
      }
      let undo: SnapshotRecord | null = null;
      if (undoId) {
        const refused = this.#undoRefused(caller, box, backend, offer, plan, undoBytes);
        if (refused) return { refused };
        const names = new Set(ledger.records({ box: box.id }).map((record) => record.name));
        undo = {
          id: undoId,
          box: { id: box.id, name: box.name, kind: box.kind, system: box.capabilities.os, thread: box.threadId },
          boxGone: null,
          backend: { id: backend.id, label: backend.label },
          host: box.guest!.host,
          storage: { name: plan.storage.name, type: plan.storage.type },
          guest: byCopy ? "held-copy" : "current",
          livesOn: box.guest!,
          name: uniqueName(undoName(now, this.#deps.timeZone), names),
          note: null,
          takenAt: now,
          capturedAt: null,
          tookMs: null,
          by,
          scope: offer.scope,
          holds: "disk",
          excludes: offer.excludes,
          size: null,
          price: offer.price,
          owner: box.threadId === OPERATOR ? "person" : "thread",
          keptUntil: null,
          keptAt: null,
          undoOf: operationId,
          forkSafe: forkSafe.version,
          identity: forkSafe.identity,
          dependsOn: [],
          picture: null,
          ref: null,
          state: "taking",
          error: null,
          stateAt: now,
          missingSince: null,
          foundAt: null,
        };
      }
      const operation: SnapshotOperation = {
        id: operationId,
        request: input.request ? requestKey(by, input.request) : null,
        requestDigest: digest,
        kind: "restore",
        box: box.id,
        guest: box.guest!.ref,
        snapshots: undo ? [target.id, undo.id] : [target.id],
        by,
        consent: { force: input.force === true, anyway, agreed: prepared.losses.filter((loss) => anyway.includes(loss.words)).map((loss) => loss.key), ...(input.yes ? { yes: input.yes } : {}), unflushed: input.unflushed ?? "stop", ...(fromSnapshot ? { newGuest: true } : {}) },
        undo: undo?.id ?? null,
        guests: null,
        step: "planned",
        task: null,
        state: "running",
        reserved: undo ? { storage: plan.storage.key, bytes: undoBytes, price: offer.price } : null,
        error: null,
        startedAt: now,
        endedAt: null,
        snapshotsGoneAt: null,
      };
      if (undo) ledger.insertRecord(undo);
      ledger.insertOperation(operation);
      return { undo, operation };
    });
    if ("refused" in admitted) throw admitted.refused;
    if ("repeat" in admitted) return this.#restoredBefore(admitted.repeat);
    const { undo, operation } = admitted;
    const past = anyway.length ? `; restored anyway, though ${anyway.join(", and ")}` : "";
    this.#event(target, "restore-asked", by, `To ${quoted(target)} (${target.id}), taken ${dayWords(target.takenAt)}; ${undo ? `an undo first, "${undo.name}"` : "no undo"}${past}${input.yes ? `; ${yesWords(input.yes)}` : ""}.`);
    this.#notify(box.threadId);
    const mark: RestoringMark = { operation: operation.id, snapshot: target.id, name: target.name, at: now, ran: box.state === "ready" };
    await this.#deps.boxes.update(box, (current) => (current.state === "releasing" ? {} : { restoring: mark }));
    this.#marksChanged();
    if (undo) await this.#keepPicture(undo.id, box);
    return this.#runRestore({ swap, fromSnapshot, operation, target, undo, backend, anyway, from: box.guest!.size, after: "", ...(input.whenStopped ? { whenStopped: input.whenStopped } : {}) }, "planned");
  }

  #rules() {
    const settings = this.settings;
    return { agentsRestore: settings.agentsRestore, agentsMemory: settings.agentsMemory, machineRestores: this.#deps.machineRestores?.() ?? MACHINE_RESTORES_SHIP };
  }

  async #prepare(caller: Caller, standing: Standing, boxId: string, targetId: string, input: RestoreInput): Promise<Prepared> {
    const ledger = this.#deps.ledger;
    const box = await this.#deps.boxes.find(boxId);
    if (!box) throw new BoxError("released", "That box was released, so it restores nothing.");
    const target = ledger.record(targetId);
    if (!target) throw new BoxError("not_found", `bb-box has no snapshot ${targetId}: it was deleted.`);
    const restoring = this.#restoreHolding(box);
    if (restoring) throw restoring;
    if ((box.state !== "ready" && box.state !== "stopped") || !box.guest) throw new BoxError("not_ready", `Box ${box.name} is ${box.state}. bb-box restores a box that is running or stopped.`);
    const backend = this.#deps.backends.get(box.backend);
    if (!backend) throw new BoxError("backend_off", `The ${box.backendLabel} backend that holds box ${box.name} is not in bb-box's settings, so it restores nothing there.`);
    await this.readBill(backend);
    const offer = this.offerFor(backend, box.kind);
    const fromSnapshot = target.guest !== "held-copy" && offer?.restore === "new-guest";
    if (!offer || offer.restore === "none" || !backend.planSnapshots || !backend.powerOff || !backend.start || !backend.snapshot || (fromSnapshot ? !backend.adoptSnapshot : !backend.rollbackSnapshot)) {
      throw new BoxError("unsupported", `${box.backendLabel} restores no snapshots of its ${box.kind} boxes.`);
    }
    if (target.box.id !== box.id) throw new BoxError("unsupported", `Snapshot ${quoted(target)} is of box ${target.box.name}, not ${box.name}.`);
    if (target.guest === "earlier") throw new BoxError("unsupported", `Snapshot ${quoted(target)} is on ${box.name}'s earlier guest, so it cannot be restored there, only forked.`);
    if (target.state !== "ready") throw new BoxError("not_ready", `Snapshot ${quoted(target)} is ${stateWords(target)}, so bb-box does not restore it.`);
    this.#requireStore("restores");
    const swap = target.guest === "held-copy" || fromSnapshot;
    const plan = await backend.planSnapshots(box.guest, box.kind, target.guest === "held-copy" ? null : { id: target.id, ref: target.ref ?? "", guest: target.livesOn }, this.#stopping.signal);
    if (plan.busy) throw new BoxError("try_again", `bb-box cannot restore box ${box.name} now: ${plan.busy}`);
    const byCopy = this.#restoreOrder(box, backend, plan, target, swap, fromSnapshot) === "copy";
    const seen = await this.#lookOn(box, standing.runsOn);
    if (seen.refusal) throw new BoxError("in_use", `${seen.refusal} bb-box changed nothing.`);
    const route = restoreRoute(caller, this.#rules(), { onAMachine: seen.onAMachine, memory: target.holds === "disk-and-memory" });
    if (!route.ok) throw new BoxError(seen.onAMachine ? "in_use" : "not_owner", `${route.why} bb-box changed nothing.`);
    if (seen.onAMachine && input.undo === false) throw new BoxError("not_owner", `bb-box always takes an undo before it restores a box threads run on, as box ${box.name} is. bb-box changed nothing.`);
    const anyway = this.#consented(caller, route.through, seen.onAMachine, box, target, seen.losses, input);
    const forkSafe = input.undo === false ? { version: null, identity: null } : await this.#forkSafe(box, backend);
    if (byCopy && input.undo !== false && forkSafe.version === null) {
      throw new BoxError(
        "unsupported",
        `bb-box would copy box ${box.name} in full as the undo of this restore, and it makes such a copy only of a box whose identity reset works now, so that a copy that started before it is disarmed gives up the box's identity. Box ${box.name} has none that bb-box could read${box.state === "ready" ? "" : ", as it is stopped"}.${caller.is === "agent" ? "" : " Restore without an undo, with --no-undo, or start the box first."}`,
      );
    }
    return { box: { ...box, guest: box.guest }, target, backend, offer, plan, byCopy, swap, fromSnapshot, anyway, forkSafe, through: route.through, onAMachine: seen.onAMachine, losses: seen.losses };
  }

  async checkFork(caller: Caller, box: Pick<BoxRecord, "id">, standing: Standing, ref: string, input: ForkInput = {}): Promise<ForkCheck> {
    const prepared = await this.#prepareFork(caller, standing, box, ref, input);
    return {
      snapshot: prepared.target,
      box: prepared.box,
      threadId: prepared.threadId,
      asMachine: prepared.threadId === OPERATOR,
      size: prepared.size,
      aboutMs: prepared.plan.fork.aboutMs,
      bytes: prepared.plan.fork.bytes,
      host: prepared.target.livesOn.host,
      storage: prepared.plan.storage.name,
    };
  }

  async fork(caller: Caller, box: Pick<BoxRecord, "id">, standing: Standing, ref: string, input: ForkInput = {}): Promise<ForkAnswer> {
    const by: Actor = caller.is === "agent" ? { is: "agent", threadId: caller.threadId } : caller;
    if (caller.is === "agent" && input.asMachine) throw new BoxError("not_owner", `Only the person makes a fork one of their machines. ${NOT_THE_AGENTS}`);
    this.#requireStore("forks");
    const digest = input.request ? requestDigest("fork", box.id, { snapshot: ref, name: input.name ?? null, asMachine: input.asMachine === true }) : null;
    if (input.request) {
      const earlier = this.#earlier(by, input.request, digest);
      if (earlier) return this.#forkedBefore(earlier);
    }
    return this.#deps.boxes.inTurn(box.id, async () => {
      if (input.request) {
        const earlier = this.#earlier(by, input.request, digest);
        if (earlier) return this.#forkedBefore(earlier);
      }
      const prepared = await this.#prepareFork(caller, standing, box, ref, input);
      const { target, plan } = prepared;
      const source = prepared.box ?? { id: target.box.id, name: target.box.name, threadId: target.box.thread, kind: target.box.kind, guest: null };
      const backend = prepared.backend;
      const sourceMacs = Object.values((await backend.guestIdentity!(target.livesOn, this.#stopping.signal)).macs);
      const ledger = this.#deps.ledger;
      const now = this.#now();
      const forkId = newBoxId(this.#random);
      const operation: SnapshotOperation = {
        id: newOperationId(this.#random),
        request: input.request ? requestKey(by, input.request) : null,
        requestDigest: digest,
        kind: "fork",
        box: source.id,
        guest: target.livesOn.ref,
        snapshots: [target.id],
        by,
        consent: { fork: { box: forkId, threadId: prepared.threadId, name: input.name ?? null } },
        undo: null,
        guests: null,
        step: "planned",
        task: null,
        state: "running",
        reserved: null,
        error: null,
        startedAt: now,
        endedAt: null,
        snapshotsGoneAt: null,
      };
      ledger.insertOperation(operation);
      let made: BoxRecord;
      try {
        made = await this.#deps.boxes.fork({
          id: forkId,
          threadId: prepared.threadId,
          projectId: prepared.threadId === OPERATOR ? null : (input.projectId ?? null),
          ...(input.name !== undefined ? { name: input.name } : {}),
          backend: backend.id,
          backendLabel: backend.label,
          kind: source.kind,
          size: prepared.size,
          origin: {
            operation: operation.id,
            snapshot: { id: target.id, name: target.name, takenAt: target.takenAt, ref: target.ref ?? "", livesOn: target.livesOn, identity: target.identity ?? null, ...(target.guest === "held-copy" ? { from: "held-copy" as const } : {}) },
            source: { id: source.id, name: source.name, threadId: source.threadId, macs: sourceMacs, address: source.guest?.address ?? target.livesOn.address ?? null },
          },
          who: by,
        });
      } catch (error) {
        ledger.updateOperation(operation.id, { state: "failed", endedAt: this.#now(), error: sentence(message(error)) });
        throw error;
      }
      const started = ledger.updateOperation(operation.id, { step: "acquiring", consent: { fork: { box: made.id, threadId: made.threadId, name: made.name } } }) ?? operation;
      this.#event(target, "fork-asked", by, `"${target.name}" (${target.id}) into box ${made.name} (${made.id})${made.threadId === OPERATOR ? ", one of your machines" : ""}, up to about ${seconds(plan.fork.aboutMs)} to copy.${target.unflushed ? " The snapshot may miss the box's last writes before it." : ""}`);
      this.#notify(target.box.thread);
      return { box: made, snapshot: target, operation: started, repeated: false };
    });
  }

  async checkForkOfBox(caller: Caller, box: BoxRecord, standing: Standing, input: ForkInput = {}): Promise<void> {
    const named = input.name === undefined ? null : forkNameProblem(input.name);
    if (named) throw new BoxError("invalid_name", named);
    const allowed = mayAct(caller, "fork", standing);
    if (!allowed.ok) throw new BoxError("not_owner", allowed.why);
    if (caller.is === "agent" && input.asMachine) throw new BoxError("not_owner", `Only the person makes a fork one of their machines. ${NOT_THE_AGENTS}`);
    this.#requireStore("forks");
    if (box.capabilities.os !== "linux") throw new BoxError("unsupported", `bb-box forks Linux boxes only, as only they reset their identity at a fork's first boot. Box ${box.name} runs ${box.capabilities.os}.`);
    const holding = this.#restoreHolding(box);
    if (holding) throw holding;
    if (box.state !== "ready" || !box.guest) throw new BoxError("not_ready", `Box ${box.name} is ${box.state}. bb-box forks a box as it is now only while it runs, so it can read its identity reset; start it first.`);
    const backend = this.#deps.backends.get(box.backend);
    if (!backend) throw new BoxError("backend_off", `The ${box.backendLabel} backend that holds box ${box.name} is not in bb-box's settings, so it forks nothing.`);
    const offer = this.offerFor(backend, box.kind);
    if (offer?.forkWhy) throw new BoxError("unsupported", `bb-box does not fork box ${box.name}: ${offer.forkWhy}.`);
    if (!offer || offer.fork !== "copy" || !backend.forkSnapshot || !backend.armFork || !backend.planSnapshots || !backend.guestIdentity) throw new BoxError("unsupported", `${backend.label} does not fork ${box.kind} boxes.`);
    const plan = await backend.planSnapshots(box.guest, box.kind, null, this.#stopping.signal);
    if (plan.busy) throw new BoxError("try_again", `bb-box cannot fork box ${box.name} now: ${plan.busy}`);
    if (!plan.fork.ok) throw new BoxError("unsupported", `bb-box cannot fork box ${box.name}: ${plan.fork.why ?? `${backend.label} refused it.`}`);
    if (!plan.take.ok) throw new BoxError("unsupported", `bb-box cannot take the snapshot to fork box ${box.name} from: ${plan.take.why ?? `${backend.label} refused it.`}`);
    const safety = await this.#forkSafe(box, backend);
    const safeFrom = offer.forkSafeFrom ?? 1;
    if (safety.version === null) throw new BoxError("unsupported", `Box ${box.name} has no working identity reset now, so a copy of it would not give up its identity, and bb-box does not fork it.`);
    if (safety.version < safeFrom) throw new BoxError("unsupported", `Box ${box.name} has version ${safety.version} of the identity reset, and bb-box forks ${backend.label}'s boxes only from version ${safeFrom}.`);
    const asMachine = caller.is !== "agent" && (input.asMachine === true || box.threadId === OPERATOR);
    await this.#deps.boxes.admitFork({
      threadId: asMachine ? OPERATOR : caller.is === "agent" ? caller.threadId : box.threadId,
      ...(input.name !== undefined ? { name: input.name } : {}),
      backend: backend.id,
      backendLabel: backend.label,
      kind: box.kind,
      size: box.guest.size ?? box.size ?? null,
    });
  }

  async #forkedBefore(operation: SnapshotOperation): Promise<ForkAnswer> {
    const fork = forkConsentOf(operation);
    return { box: fork ? await this.#deps.boxes.find(fork.box) : null, snapshot: this.#deps.ledger.record(operation.snapshots[0] ?? ""), operation, repeated: true };
  }

  async #prepareFork(caller: Caller, standing: Standing, _box: Pick<BoxRecord, "id">, ref: string, input: ForkInput) {
    const named = input.name === undefined ? null : forkNameProblem(input.name);
    if (named) throw new BoxError("invalid_name", named);
    const target = this.find(caller, standing, ref);
    const allowed = mayAct(caller, "fork", standing, target);
    if (!allowed.ok) throw new BoxError("not_owner", allowed.why);
    if (caller.is === "agent" && input.asMachine) throw new BoxError("not_owner", `Only the person makes a fork one of their machines. ${NOT_THE_AGENTS}`);
    this.#requireStore("forks");
    const source = await this.#deps.boxes.find(target.box.id);
    const heldCopy = target.guest === "held-copy";
    const name = target.box.name;
    if ((!source || target.boxGone) && !heldCopy) throw new BoxError("released", `Box ${name} was released, and ${quoted(target)} has no held copy, so bb-box cannot fork it.`);
    if (target.state !== "ready") throw new BoxError(target.state === "taking" ? "try_again" : "unsupported", `Snapshot ${quoted(target)} is ${stateWords(target)}, so bb-box does not fork it.`);
    if (target.scope !== "box") throw new BoxError("unsupported", `Snapshot ${quoted(target)} holds ${name}'s device only, so it does not fork.`);
    if (target.box.system !== "linux") throw new BoxError("unsupported", `bb-box forks Linux boxes only, as only they reset their identity at a fork's first boot. Box ${name} runs ${target.box.system}.`);
    const notYet = this.offerFor(this.#deps.backends.get(target.backend.id), source?.kind ?? target.box.kind)?.forkWhy;
    if (notYet) throw new BoxError("unsupported", `bb-box does not fork ${quoted(target)}: ${notYet}.`);
    if (target.forkSafe === null) {
      throw new BoxError("unsupported", `${name} had no working identity reset when ${quoted(target)} was taken, so bb-box does not fork it: a copy of it would not give up ${name}'s identity, and could act as ${name}.`);
    }
    const backend = this.#deps.backends.get(target.backend.id);
    if (!backend) throw new BoxError("backend_off", `The ${target.backend.label} backend that holds snapshot ${quoted(target)} is not in bb-box's settings, so it forks nothing.`);
    const kind = source?.kind ?? target.box.kind;
    const offer = this.offerFor(backend, kind);
    if (!offer || offer.fork !== "copy" || !backend.forkSnapshot || !backend.armFork || !backend.planSnapshots || !backend.guestIdentity || (heldCopy && !backend.copyPlan)) throw new BoxError("unsupported", `${backend.label} does not fork ${kind} boxes.`);
    const safeFrom = offer.forkSafeFrom ?? 1;
    if (target.forkSafe < safeFrom) {
      throw new BoxError(
        "unsupported",
        `${name} had version ${target.forkSafe} of the identity reset when ${quoted(target)} was taken, and bb-box forks ${backend.label}'s boxes only from version ${safeFrom}, which keeps a copy from coming up as its source in every case bb-box checks. Take a snapshot of a box whose image has version ${safeFrom} or later.`,
      );
    }
    if (source) {
      const holding = this.#restoreHolding(source);
      if (holding) throw holding;
    }
    const plan = heldCopy ? await this.#copyForkPlan(target, backend) : await backend.planSnapshots(target.livesOn, kind, this.#refOf(target, source), this.#stopping.signal);
    if (plan.busy) throw new BoxError("try_again", `bb-box cannot fork ${quoted(target)} now: ${plan.busy}`);
    if (!plan.fork.ok || !plan.fork.size) throw new BoxError("unsupported", `bb-box cannot fork ${quoted(target)} of box ${name}: ${plan.fork.why ?? `${backend.label} refused it.`}`);
    const asMachine = caller.is !== "agent" && (input.asMachine === true || !source || source.threadId === OPERATOR || isKept(target));
    const threadId = asMachine ? OPERATOR : caller.is === "agent" ? caller.threadId : source!.threadId;
    return { target, box: source, backend, plan, threadId, size: plan.fork.size };
  }

  async #copyForkPlan(target: SnapshotRecord, backend: Backend): Promise<Pick<SnapshotPlan, "fork" | "storage" | "busy">> {
    const copy = await backend.copyPlan!(target.livesOn, this.#stopping.signal);
    const storage = { key: "", name: target.storage?.name ?? "", type: target.storage?.type ?? "", percentFull: 0, metadataPercentFull: null, metadataUnread: null, totalBytes: null, usedBytes: null };
    const bytes = copy.size?.diskGiB != null ? copy.size.diskGiB * 1024 * MiB : null;
    const aboutMs = Math.round((copy.size?.diskGiB ?? 0) * COPY_MS_PER_GIB);
    if (copy.state !== "template") {
      return { storage, busy: null, fork: { ok: false, why: `its held copy, guest ${target.livesOn.ref}, is ${copy.state === "gone" ? "gone" : "not a template, so bb-box does not trust it"}`, aboutMs, bytes, size: null } };
    }
    if (!copy.size) return { storage, busy: null, fork: { ok: false, why: `bb-box could not read the size its held copy, guest ${target.livesOn.ref}, holds`, aboutMs, bytes, size: null } };
    return { storage, busy: null, fork: { ok: true, why: null, aboutMs, bytes, size: copy.size } };
  }

  forkEnded(box: BoxRecord): void {
    const operationId = box.fork?.operation;
    const operation = operationId ? this.#deps.ledger.operation(operationId) : null;
    if (!operation || operation.kind !== "fork" || (operation.state !== "running" && operation.state !== "unknown")) return;
    this.#settleFork(operation, box);
  }

  #settleFork(operation: SnapshotOperation, box: BoxRecord | null): void {
    const ledger = this.#deps.ledger;
    const now = this.#now();
    const target = ledger.record(operation.snapshots[0] ?? "");
    const fork = forkConsentOf(operation);
    const named = box ? `box ${box.name} (${box.id})` : `box ${fork?.name ?? fork?.box ?? "unknown"}`;
    if (box?.state === "failed" && box.guest) {
      const pending = `Its guest ${box.guest.ref} is not deleted yet; bb-box tries again at each sweep.`;
      if (operation.error !== pending) {
        ledger.updateOperation(operation.id, { state: "unknown", error: pending });
        if (target) this.#event(target, "fork-failed", operation.by, `"${target.name}" into ${named}: ${sentence(box.error ?? "it failed")}`);
      }
      return;
    }
    if (box?.state === "ready") {
      ledger.updateOperation(operation.id, { state: "done", step: "done", endedAt: now, error: null });
      const total = typeof box.timings.total === "number" ? `, ready in ${seconds(box.timings.total)}` : "";
      if (target) this.#event(target, "forked", operation.by, `"${target.name}" into ${named}${total}.`);
    } else {
      const why = box ? (box.state === "failed" ? (box.error ?? "it failed") : `it was ${box.state === "releasing" ? "released" : box.state} before it was ready`) : "its box is gone";
      ledger.updateOperation(operation.id, { state: "failed", step: "done", endedAt: now, error: sentence(why) });
      if (target) this.#event(target, "fork-failed", operation.by, `"${target.name}" into ${named}: ${sentence(why)}`);
    }
    if (target) this.#notify(target.box.thread);
  }

  async #recoverForks(waiting: readonly SnapshotOperation[]): Promise<number> {
    let settled = 0;
    for (const operation of waiting) {
      const fork = forkConsentOf(operation);
      const box = fork ? await this.#deps.boxes.find(fork.box) : null;
      if (box && (box.state === "acquiring" || box.state === "starting")) continue;
      if (box?.state === "failed" && box.guest) continue;
      this.#settleFork(operation, box);
      settled++;
    }
    return settled;
  }

  #restoreHolding(box: BoxRecord): BoxError | null {
    const cutShort = this.#deps.ledger.unsettled().find((operation) => operation.box === box.id && operation.kind === "restore" && !this.#running.has(operation.id));
    if (cutShort) {
      return new BoxError("not_ready", `bb-box could not confirm ${operationWords(cutShort)} on box ${box.name}: ${cutShort.error ?? "it was cut short"} It checks again at each sweep; bb box sweep checks now, and bb box doctor says why.`);
    }
    return box.restoring ? new BoxError("not_ready", restoringWords(box, box.restoring)) : null;
  }

  #undoBytes(box: BoxRecord, plan: SnapshotPlan, byCopy: boolean): number {
    return byCopy ? (box.guest?.size?.diskGiB ?? 0) * 1024 * MiB : (plan.restore.undoBytes ?? 0);
  }

  #undoRefused(caller: Caller, box: BoxRecord, backend: Backend, offer: Snapshotting, plan: SnapshotPlan, undoBytes: number): BoxError | null {
    const ledger = this.#deps.ledger;
    const settings = this.settings;
    const instead = caller.is === "agent" ? "" : " Or restore without an undo, with --no-undo.";
    const room = this.#roomProblem(box, plan.storage, ledger.reservedBytes(plan.storage.key) + undoBytes, false, settings.roomPercent);
    if (room) return new BoxError("try_again", `bb-box would take an undo of box ${box.name} before restoring it, and ${room.charAt(0).toLowerCase()}${room.slice(1)}${instead}`);
    const paid = ceilingVerdict({
      change: "undo",
      backend: backend.label,
      held: this.#heldOn(backend.id),
      price: offer.price,
      bytes: undoBytes || null,
      ceiling: ceilingOf(settings, backend.id),
      byPerson: caller.is !== "agent",
    });
    return paid.ok ? null : new BoxError("limit_reached", `bb-box would take an undo of box ${box.name} before restoring it. ${paid.why}${instead}`);
  }

  async checkRestore(caller: Caller, box: BoxRecord, standing: Standing, ref: string, input: RestoreInput = {}, answer: { readonly undoRefusal?: boolean } = {}): Promise<RestoreCheck> {
    const target = this.find(caller, standing, ref);
    const allowed = mayAct(caller, "restore", standing, target);
    if (!allowed.ok) throw new BoxError("not_owner", allowed.why);
    return this.#checkOf(caller, await this.#prepare(caller, standing, box.id, target.id, input), input, answer);
  }

  #checkOf(caller: Caller, prepared: Prepared, input: RestoreInput, answer: { readonly undoRefusal?: boolean } = {}): RestoreCheck {
    const undoBytes = this.#undoBytes(prepared.box, prepared.plan, prepared.byCopy);
    const refused = input.undo === false ? null : this.#undoRefused(caller, prepared.box, prepared.backend, prepared.offer, prepared.plan, undoBytes);
    if (refused && !answer.undoRefusal) throw refused;
    const restore = prepared.plan.restore;
    const ofBox = this.#deps.ledger.records({ box: prepared.box.id });
    const onGuest = prepared.swap && !prepared.fromSnapshot ? ofBox.filter((record) => record.guest === "current" && record.livesOn.ref === prepared.box.guest?.ref).length : 0;
    const undos = ofBox.filter((record) => record.undoOf !== null && record.keptUntil === null && heldByProvider(record));
    const replaces = input.undo !== false && undos.length + 1 > UNDOS_PER_BOX ? (undoToReplace(ofBox.filter((record) => record.id !== prepared.target.id), this.#deps.ledger.pins(), this.#now())?.name ?? null) : null;
    const undo: RestoreCheck["undo"] =
      input.undo === false || refused
        ? null
        : prepared.byCopy
          ? { kind: "held-copy", name: undoName(this.#now(), this.#deps.timeZone), aboutMs: restore.copyAboutMs ?? restore.undoAboutMs, bytes: undoBytes || null, price: null }
          : { kind: "snapshot", name: undoName(this.#now(), this.#deps.timeZone), aboutMs: restore.undoAboutMs, bytes: restore.undoBytes, price: prepared.offer.price };
    return {
      snapshot: prepared.target,
      box: prepared.box,
      onAMachine: prepared.onAMachine,
      plan: planDigest(prepared.box, prepared.target, undo?.kind ?? null, prepared.losses.map((loss) => loss.key), ofBox.map((record) => record.id)),
      swap: prepared.swap,
      fromSnapshot: prepared.fromSnapshot,
      costWords: restore.costWords ?? null,
      undo,
      undoRefused: refused?.message ?? null,
      from: prepared.box.guest?.size ?? null,
      to: prepared.swap ? null : restore.sizeBack,
      anyway: prepared.losses.map((loss) => loss.words),
      leavesOnEarlierGuest: onGuest,
      replaces,
      storage: prepared.plan.storage.name,
    };
  }

  #restoreOrder(box: BoxRecord, backend: Backend, plan: SnapshotPlan, target: SnapshotRecord, swap: boolean, fromSnapshot: boolean): "rollback" | "copy" {
    if (plan.locked) throw new BoxError("locked", `${backend.label} left box ${box.name} locked (${plan.locked.lock}), so bb-box restores nothing. ${plan.locked.fix}`);
    if (fromSnapshot) {
      if (plan.restore.way !== "new-guest") throw new BoxError("unsupported", `bb-box cannot restore box ${box.name} to ${quoted(target)}: ${plan.restore.why ?? `${backend.label} restores none of its snapshots now.`}`);
      return "rollback";
    }
    const copies = !!(backend.copyGuest && backend.disarmCopy && backend.templateCopy && backend.copyState && backend.deleteCopy && backend.adoptCopy && backend.retireGuest && backend.guestIdentity);
    if (swap) {
      if (!copies) throw new BoxError("unsupported", `${backend.label} cannot make a box's guest from a held copy, so bb-box cannot restore ${quoted(target)}.`);
      if (!this.#deps.undoByCopy?.(backend.id)) {
        throw new BoxError("unsupported", `Restoring ${quoted(target)}, a held copy, makes box ${box.name} a new guest, and bb-box does that only in live checks until such restores are checked on ZFS. bb-box changed nothing.`);
      }
      return "copy";
    }
    this.#restoreWay(box, backend, plan, target);
    if (!this.#deps.undoByCopy?.(backend.id) || !copies) return "rollback";
    const newer = plan.restore.newer;
    if (newer > 0) {
      throw new BoxError(
        "unsupported",
        `Live checks run ZFS's order on ${backend.label}: as on ZFS, bb-box restores only the newest snapshot there, and ${quoted(target)} has ${newer === 1 ? "1 newer one" : `${newer} newer ones`}. Delete ${newer === 1 ? "it" : "them"} yourself first. bb-box never deletes newer snapshots to make a rollback possible.`,
      );
    }
    return "copy";
  }

  #restoreWay(box: BoxRecord, backend: Backend, plan: SnapshotPlan, target: SnapshotRecord): void {
    const restore = plan.restore;
    if (restore.way === "none") throw new BoxError("unsupported", `bb-box cannot restore box ${box.name} to ${quoted(target)}: ${restore.why ?? `${backend.label} restores none of its snapshots.`}`);
    const where = `${box.guest?.host ? `${box.guest.host}'s ` : ""}storage ${plan.storage.name}`;
    if (restore.way === "rollback-newest-only") {
      throw new BoxError(
        "unsupported",
        `${where} is ZFS, which restores only the newest snapshot, and bb-box's restores on ZFS stay off until they are checked there. bb-box changed nothing.`,
      );
    }
    if (restore.way !== "rollback") throw new BoxError("unsupported", `${backend.label} restores no snapshots of its ${box.kind} boxes in place.`);
  }

  async #lookOn(box: BoxRecord, runsOn: boolean): Promise<Look> {
    const guard: RestoreGuard = this.#deps.guard ? await this.#deps.guard(box) : { threads: [], threadsUnread: null, control: false, terminals: 0 };
    if (guard.threads === null) {
      return {
        refusal: `bb-box could not tell which threads run on box ${box.name} (${(guard.threadsUnread ?? "BB did not answer").replace(/\.$/, "")}), so it restores nothing: a restore would take their work with it.`,
        onAMachine: true,
        working: [],
        losses: [],
      };
    }
    const onAMachine = runsOn || guard.threads.length > 0;
    if (onAMachine && !this.#rules().machineRestores) {
      const who = guard.threads.length ? `${threadsWords(guard.threads)} ${guard.threads.length === 1 ? "runs" : "run"} on it` : "the thread asking runs on it";
      return {
        refusal: `Box ${box.name} is a box threads run on: ${who}. A restore would take their worktrees, uncommitted files and sessions there with it, and bb-box does not restore such a box yet: that stays off until bb-box can hold every turn on it while it restores. Move those threads off it, or archive them, first.`,
        onAMachine,
        working: [],
        losses: [],
      };
    }
    const losses: Loss[] = guard.threads.map((thread) => ({ key: `thread:${thread.id}`, words: `"${thread.title}" runs on it: its worktree, uncommitted files and session there go` }));
    if (runsOn && !guard.threads.length) losses.push({ key: "thread:asking", words: "the thread asking runs on it: its worktree, uncommitted files and session there go" });
    if (guard.control) losses.push({ key: "control", words: "a person holds control of its desktop" });
    if (guard.terminals === null) losses.push({ key: "terminals:unknown", words: "bb-box could not tell whether a BB terminal is open on it" });
    else if (guard.terminals > 0) losses.push({ key: `terminals:${guard.terminals}`, words: guard.terminals === 1 ? "a BB terminal is open on it" : `${guard.terminals} BB terminals are open on it` });
    return { refusal: null, onAMachine, working: guard.threads.filter((thread) => thread.running), losses };
  }

  #consented(caller: Caller, through: "restore" | "form", onAMachine: boolean, box: BoxRecord, target: SnapshotRecord, losses: readonly Loss[], input: RestoreInput): string[] {
    if (!losses.length) return [];
    if (caller.is === "agent" && through === "form" && onAMachine) return losses.map((loss) => loss.words);
    if (caller.is !== "agent" && input.force) {
      const accept = input.accept;
      const unseen = accept ? losses.filter((loss) => !accept.includes(loss.words)) : [];
      if (unseen.length) {
        throw new BoxError("in_use", `Since you looked, more would go with box ${box.name}: ${unseen.map((loss) => loss.words).join("; ")}. Look at what the restore would end again before restoring. bb-box changed nothing.`);
      }
      return losses.map((loss) => loss.words);
    }
    const fix = caller.is === "agent" ? "Ask the person to end it first, or to restore the box themselves." : "Restore anyway with --force.";
    throw new BoxError("in_use", `Restoring box ${box.name} to ${quoted(target)} would end what is on it now: ${losses.map((loss) => loss.words).join("; ")}. ${fix} bb-box changed nothing.`);
  }

  async #stillAdmitted(context: Restoring, box: BoxRecord): Promise<string | null> {
    const seen = await this.#lookOn(box, false);
    if (seen.refusal) return `Since the restore was asked: ${seen.refusal.charAt(0).toLowerCase()}${seen.refusal.slice(1)}`;
    if (seen.working.length) {
      return `a turn runs on it now: ${threadsWords(seen.working)} ${seen.working.length === 1 ? "is" : "are"} working there, and bb-box changes a box threads run on only while no turn runs on it. Ask again once ${seen.working.length === 1 ? "it is" : "they are"} idle.`;
    }
    const consented = new Set(consentOf(context.operation).agreed);
    const fresh = seen.losses.filter((loss) => !consented.has(loss.key) && !consented.has(loss.words));
    if (!fresh.length) return null;
    return `Since the restore was asked, something more would go with box ${box.name}'s disk: ${fresh.map((loss) => loss.words).join("; ")}.${context.operation.by.is === "agent" ? "" : " Ask again, with --force if you mean it."}`;
  }

  #stepHooks(operation: SnapshotOperation, part: "undo" | "rollback"): SnapshotHooks {
    return {
      submitting: async () => {
        this.#deps.ledger.updateOperation(operation.id, { step: `${part}-submitting`, task: null });
      },
      task: async (task) => {
        this.#deps.ledger.updateOperation(operation.id, { step: `${part}-task`, task });
        await this.#deps.hold?.(operation, "task", this.#stopping.signal);
      },
    };
  }

  async #moved(box: BoxRecord, change: Partial<BoxRecord>): Promise<BoxRecord> {
    return (await this.#deps.boxes.update(box, (current) => (current.state === "releasing" ? {} : change))) ?? box;
  }

  async #sizeOf(backend: Backend, guest: Guest, signal?: AbortSignal): Promise<BoxSize | null> {
    try {
      return (await backend.held(signal)).find((held) => held.ref === guest.ref)?.size ?? null;
    } catch (error) {
      if (signal?.aborted) throw error;
      return null;
    }
  }

  async #runRestore(context: Restoring, from: RestoreStep): Promise<RestoreAnswer> {
    const ledger = this.#deps.ledger;
    const { operation, target, backend } = context;
    const signal = this.#stopping.signal;
    const reach = stepAt(from);
    const ahead = (step: RestoreStep) => reach <= stepAt(step);
    const took: [string, number][] = [];
    let stepBegan = this.#now();
    let timed: string | null = null;
    const at = (step: RestoreStep, also: Partial<SnapshotOperation> = {}) => {
      const part = TIMED_PARTS[step];
      const begins = part !== undefined && part !== timed;
      if (begins) {
        if (timed) took.push([timed, this.#now() - stepBegan]);
        timed = part;
        stepBegan = this.#now();
      }
      ledger.updateOperation(operation.id, { step, stepAt: this.#now(), ...(BEGINS_A_TASK.has(step) ? { task: null } : {}), ...also });
      if (begins) this.#notify(target.box.thread);
    };
    const admitted = async (box: BoxRecord, step: RestoreStep): Promise<void> => {
      const late = await this.#stillAdmitted(context, box);
      if (!late) return;
      if (box.state === "stopped" || box.state === "stopping" || reach > stepAt("stopping")) await this.#putBack(context, box, step, late);
      await this.#neverBegan(context, box, late);
      throw new BoxError("in_use", `bb-box did not restore box ${box.name}: ${late} bb-box changed nothing.`);
    };
    this.#running.add(operation.id);
    const replaced: string[] = [];
    try {
      let box = await this.#deps.boxes.find(operation.box);
      if (!box?.guest) throw this.#restoreGone(context);
      let guest = context.swap ? (ledger.operation(operation.id)?.guests?.old ?? box.guest) : box.guest;
      let undo = context.undo ? ledger.record(context.undo.id) : null;
      if (ahead("stopping")) {
        if (from === "planned") await this.#deps.hold?.(operation, "planned", signal);
        await admitted(box, "planned");
        const unflushed = undo ? await this.#flushWrites(box, backend, guest, signal) : null;
        if (unflushed) {
          const consent = consentOf(operation);
          if (consent.unflushed !== "go-on") {
            const words = `bb-box could not flush box ${box.name}'s writes to its disk before stopping it (${unflushed.replace(/\.$/, "")}), so its undo could miss what was written in the last seconds before the restore.`;
            await this.#neverBegan(context, box, words);
            throw new BoxError("unflushed", `${words} bb-box changed nothing.`);
          }
          ledger.updateOperation(operation.id, { consent: { ...(operation.consent as object), unflushedWhy: unflushed } });
          undo = ledger.updateRecord(undo!.id, { note: unflushedNote(unflushed), unflushed }) ?? undo;
        }
        await admitted(box, "planned");
        await this.#deps.hold?.(operation, "checked", signal);
        at("stopping");
        box = await this.#moved(box, box.state === "ready" ? { state: "stopping", error: null } : { error: null });
        try {
          await backend.powerOff!(guest, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          return await this.#putBack(context, box, "stopping", sentence(message(error)));
        }
        box = await this.#moved(box, { state: "stopped", stoppedAt: this.#now() });
        at("stopped");
        context.whenStopped?.();
        await this.#deps.hold?.(operation, "stopped", signal);
        await admitted(box, "stopped");
      }
      if (undo && undo.guest === "current" && reach < stepAt("undo-ready")) {
        at("undo-submitting");
        const takenAt = this.#now();
        let taken;
        try {
          taken = await backend.snapshot!(guest, { id: undo.id, box: box.id, memory: false, forkSafe: undo.forkSafe }, this.#stepHooks(operation, "undo"), signal);
        } catch (error) {
          if (signal.aborted) throw error;
          const words = sentence(message(error));
          if (error instanceof SnapshotFailed || error instanceof SnapshotIncomplete) {
            const incomplete = error instanceof SnapshotIncomplete;
            ledger.updateRecord(undo.id, { state: incomplete ? "incomplete" : "failed", error: words, stateAt: this.#now() });
            this.#event(undo, "snapshot-failed", undo.by, `"${undo.name}", the undo of a restore: ${words}${incomplete ? ` Part of it is left on ${where(undo)}.` : ""}`);
            return await this.#putBack(context, box, "undo-task", `bb-box could not take the undo "${undo.name}": ${words}`);
          }
          throw this.#restoreUnsure(context, box, "undo-task", words);
        }
        const now = this.#now();
        undo = ledger.updateRecord(undo.id, { state: "ready", ref: taken.ref, holds: taken.holds, capturedAt: taken.capturedAt, size: taken.size, tookMs: now - takenAt, stateAt: now, error: null }) ?? undo;
        at("undo-ready");
        this.#event(undo, "snapshot-taken", undo.by, `"${undo.name}" (${undo.id}): ${holdsWords(undo)}, the undo of the restore to ${quoted(target)}, in ${seconds(now - takenAt)}.`);
        await this.#deps.hold?.(operation, "undo", signal);
      }
      if (undo && undo.guest === "held-copy" && reach < stepAt("copy-ready")) {
        at("copy-claimed");
        const copying = undo;
        const begun = this.#now();
        const hooks: CopyHooks = {
          claimed: async (copy) => {
            ledger.updateRecord(copying.id, { livesOn: copy, host: copy.host, ref: copy.ref });
          },
          submitting: async () => {
            ledger.updateOperation(operation.id, { step: "copy-submitting", task: null });
          },
          task: async (task) => {
            ledger.updateOperation(operation.id, { step: "copy-task", task });
            await this.#deps.hold?.(operation, "task", signal);
          },
        };
        let copy: Guest;
        try {
          copy = await backend.copyGuest!(guest, { box: box.id, snapshot: copying.id, kept: null }, hooks, signal);
          at("copy-cloned");
          await this.#deps.hold?.(operation, "copied", signal);
          await backend.disarmCopy!(copy, signal);
          at("copy-disarmed");
          await backend.templateCopy!(copy, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          const words = sentence(message(error));
          const partial = this.#copyOf(ledger.record(copying.id));
          if (partial && partial.ref !== guest.ref) await backend.deleteCopy!(partial, signal).catch((cause: unknown) => this.#deps.logError(`delete the part-made copy ${partial.ref} of box ${box!.name}`, cause));
          ledger.updateRecord(copying.id, { state: "failed", error: words, stateAt: this.#now() });
          this.#event(copying, "snapshot-failed", copying.by, `"${copying.name}", the undo of a restore, as a held copy: ${words}`);
          return await this.#putBack(context, box, "copy-task", `bb-box could not copy box ${box.name} for its undo: ${words}`);
        }
        const now = this.#now();
        undo = ledger.updateRecord(copying.id, { state: "ready", ref: copy.ref, livesOn: copy, host: copy.host, capturedAt: begun, tookMs: now - begun, stateAt: now, error: null }) ?? copying;
        at("copy-ready");
        this.#event(undo, "held-copy-made", undo.by, `"${undo.name}" (${undo.id}): a held copy of the stopped box, guest ${copy.ref}, a template that cannot start, the undo of the restore to ${quoted(target)}, in ${seconds(now - begun)}.`);
        await this.#deps.hold?.(operation, "undo", signal);
      }
      if (reach < stepAt(context.swap ? "adopted" : "rolled-back")) {
        await admitted(box, context.swap ? "adopt-claimed" : "rollback-submitting");
        if (context.after && undo) await this.#undoStillThere(context, box, undo);
      }
      if (!context.swap && reach < stepAt("rolled-back")) {
        at("rollback-submitting");
        try {
          await backend.rollbackSnapshot!(guest, { id: target.id, ref: target.ref ?? "", guest }, this.#stepHooks(operation, "rollback"), signal);
        } catch (error) {
          if (signal.aborted) throw error;
          const words = sentence(message(error));
          if (error instanceof SnapshotFailed) return await this.#putBack(context, box, "rollback-submitting", `${backend.label} refused the rollback: ${words}`);
          if (error instanceof RestoreChanged) return await this.#leftStopped(context, box, "rollback-task", words, false);
          throw this.#restoreUnsure(context, box, "rollback-task", words);
        }
        at("rolled-back");
        await this.#deps.hold?.(operation, "rolled-back", signal);
      }
      if (context.swap) {
        if (reach < stepAt("adopted")) {
          at("adopt-claimed", { guests: { old: guest, new: null } });
          const size = guest.size ?? box.size ?? null;
          if (!size) throw this.#restoreUnsure(context, box, "adopt-claimed", "bb-box does not know the box's size to give its new guest.");
          let fresh: Guest;
          try {
            const passed = backend.guestIdentity ? await backend.guestIdentity(guest, signal) : { macs: {}, smbios: null };
            const hooks: CopyHooks = {
              claimed: async (made) => {
                ledger.updateOperation(operation.id, { step: "adopt-claimed", guests: { old: guest, new: made } });
              },
              submitting: async () => {
                ledger.updateOperation(operation.id, { step: "adopt-submitting", task: null });
              },
              task: async (task) => {
                ledger.updateOperation(operation.id, { step: "adopt-task", task });
                await this.#deps.hold?.(operation, "task", signal);
              },
            };
            fresh = context.fromSnapshot
              ? await backend.adoptSnapshot!({ id: target.id, ref: target.ref ?? "", guest: target.livesOn }, identity(box, size), passed, hooks, signal)
              : await backend.adoptCopy!(target.livesOn, identity(box, size), passed, hooks, signal);
          } catch (error) {
            if (signal.aborted) throw error;
            const words = sentence(message(error));
            const made = ledger.operation(operation.id)?.guests?.new ?? null;
            if (!(await this.#discardAdoption(box, backend, made))) {
              throw this.#restoreUnsure(context, box, "adopt-task", `bb-box could not make box ${box.name}'s new guest from ${quoted(target)} (${words.replace(/\.$/, "")}), nor confirm the part-made guest ${made?.ref ?? ""} gone, so it does not start the old guest again: both would act as the box.`);
            }
            return await this.#putBack(context, box, "adopt-task", `bb-box could not make box ${box.name}'s new guest from ${quoted(target)}: ${words}`);
          }
          ledger.updateOperation(operation.id, { step: "adopted", guests: { old: guest, new: fresh } });
          at("adopted");
          await this.#deps.hold?.(operation, "adopted", signal);
        }
        const guests = ledger.operation(operation.id)?.guests;
        const old = guests?.old ?? guest;
        const fresh = guests?.new ?? null;
        if (!fresh) throw this.#restoreUnsure(context, box, "adopted", "bb-box has no record of the box's new guest.");
        if (reach < stepAt("swapped")) {
          if (box.guest?.ref !== fresh.ref) box = await this.#moved(box, { guest: { ...fresh, facts: box.guest?.facts } });
          ledger.transaction(() => {
            for (const record of ledger.records({ box: box!.id })) {
              if (record.guest !== "current" || record.livesOn.ref !== old.ref) continue;
              ledger.updateRecord(record.id, context.fromSnapshot ? { livesOn: fresh } : { guest: "earlier", livesOn: old });
            }
            ledger.updateOperation(operation.id, { step: "swapped" });
          });
          at("swapped");
        }
        if (reach < stepAt("retired") && !context.fromSnapshot) {
          const size = old.size ?? box.size ?? null;
          try {
            if (!size) throw new Error("bb-box does not know the box's size.");
            await backend.retireGuest!(old, identity(box, size), signal);
          } catch (error) {
            if (signal.aborted) throw error;
            throw this.#restoreUnsure(context, box, "retired", `bb-box could not disarm the box's earlier guest ${old.ref}: ${sentence(message(error))} It tries again at its next sweep, and the box stays stopped until then.`);
          }
          at("retired");
        }
        guest = box.guest ?? fresh;
      }

      let facts: readonly GuestFact[] | undefined;
      const startParts: string[] = [];
      let accessWritten = false;
      let accessFailed: unknown = null;
      const accessFirst = async (): Promise<void> => {
        at("access");
        try {
          await this.#deps.boxes.writeAccess(box!, signal);
        } catch (error) {
          accessFailed = error;
          throw error;
        }
        accessWritten = true;
      };
      if (ahead("starting")) {
        at("starting");
        box = await this.#moved(box, { state: "starting" });
        try {
          facts = (await backend.start!(guest, signal, (part, ms) => startParts.push(`${part} ${seconds(ms)}`), accessFirst))?.facts;
        } catch (error) {
          if (signal.aborted) throw error;
          if (accessFailed && context.fromSnapshot) return await this.#swapBack(context, box, `bb-box could not write its new guest's access file: ${sentence(message(accessFailed))}`);
          if (accessFailed) return await this.#leftStopped(context, box, "access", accessFailedWords(accessFailed), true);
          if (context.fromSnapshot) return await this.#swapBack(context, box, `Its new guest did not start: ${sentence(message(error))}`);
          return await this.#leftStopped(context, box, "starting", `It was restored, but did not start: ${sentence(message(error))}`, true);
        }
        await this.#deps.hold?.(operation, "started", signal);
      }
      let to = box.guest?.size ?? null;
      if (ahead("size")) {
        at("size");
        to = (await this.#sizeOf(backend, guest, signal)) ?? to;
        box = await this.#moved(box, { guest: { ...guest, ...(to ? { size: to } : {}), ...(facts ? { facts } : {}) }, ...(to ? { size: to } : {}) });
      }
      if (ahead("access") && !accessWritten) {
        try {
          await accessFirst();
        } catch (error) {
          if (signal.aborted) throw error;
          if (context.fromSnapshot) return await this.#swapBack(context, box, `bb-box could not write its new guest's access file: ${sentence(message(error))}`);
          return await this.#leftStopped(context, box, "access", accessFailedWords(error), true);
        }
      }
      if (ahead("labels")) {
        at("labels");
        const size = to ?? box.size ?? null;
        if (backend.relabel && size) await backend.relabel(guest, identity(box, size), box.name, signal).catch((error: unknown) => this.#deps.logError(`write the labels of box ${box!.name} after its restore`, error));
      }
      if (ahead("machine")) {
        at("machine");
        box = await this.#moved(box, { state: "ready", error: null, restoring: null });
        this.#deps.boxes.machineBack(box);
      }
      if (context.fromSnapshot) {
        const old = ledger.operation(operation.id)?.guests?.old ?? null;
        if (old && old.ref !== box.guest?.ref) await this.#dropOldGuest(box, backend, old);
      }
      if (timed) took.push([timed, this.#now() - stepBegan]);
      if (startParts.length) this.#deps.log?.(`Restored box ${box.name}: its start took ${startParts.join(", ")}.`);
      const now = this.#now();
      const done = ledger.transaction(() => ledger.updateOperation(operation.id, { state: "done", step: "done", endedAt: now, error: null }));
      box = await this.#moved(box, { restoring: null, state: "ready" });
      undo = undo ? ledger.record(undo.id) : null;
      const sized = sizeChangeWords(context.from, to);
      const left = context.swap && !context.fromSnapshot ? ledger.records({ box: box.id }).filter((record) => record.guest === "earlier" && record.livesOn.ref === ledger.operation(operation.id)?.guests?.old?.ref).length : 0;
      const old = context.swap ? (ledger.operation(operation.id)?.guests?.old ?? null) : null;
      let gone = false;
      if (old && left === 0 && !context.fromSnapshot && backend.deleteCopy) {
        gone = await backend.deleteCopy(old, signal).then(
          () => true,
          (error: unknown) => {
            this.#deps.log?.(`Could not delete box ${box!.name}'s earlier guest ${old.ref}, which holds no snapshot: ${message(error)}`);
            return false;
          },
        );
      }
      const swapped = context.fromSnapshot
        ? `; a new guest made from it runs the box now, with the box's own identity, and its old guest ${old?.ref ?? ""} is deleted`
        : context.swap
        ? gone
          ? `; a new guest made from its held copy runs the box now, and its old guest ${old!.ref}, which held no snapshot, is deleted`
          : `; a new guest made from its held copy runs the box now, and ${left === 1 ? "1 snapshot stays" : `${left} snapshots stay`} on its earlier guest: fork only`
        : "";
      const yes = consentOf(operation).yes;
      const unflushed = unflushedOf(ledger.operation(operation.id) ?? operation);
      const unflushedWords = unflushed && undo ? `; bb-box could not flush its writes before the stop (${unflushed.replace(/\.$/, "")}), so its undo may miss the last of them` : "";
      this.#event(target, "restored", operation.by, `To ${quoted(target)} (${target.id}), taken ${dayWords(target.takenAt)}, in ${seconds(now - operation.startedAt)}${stepsWords(took)}${context.after}; ${undo ? `its undo is "${undo.name}"` : "no undo"}${unflushedWords}${swapped}${sized}${yes ? `; ${yesWords(yes)}` : ""}.`);
      replaced.push(...(await this.#replaceUndos(box.id, target.id)));
      this.#notify(box.threadId);
      return { snapshot: ledger.record(target.id), undo, operation: done ?? operation, box, from: context.from, to, anyway: context.anyway, replaced, earlier: context.swap && !context.fromSnapshot ? left : null, newGuest: context.fromSnapshot === true, unflushed: undo ? unflushed : null, repeated: false };
    } finally {
      this.#running.delete(operation.id);
    }
  }

  #copyOf(undo: SnapshotRecord | null): Guest | null {
    return undo?.guest === "held-copy" && undo.ref !== null ? undo.livesOn : null;
  }

  async #discardAdoption(box: BoxRecord, backend: Backend, made: Guest | null): Promise<boolean> {
    if (!made) return true;
    const current = (await this.#deps.boxes.find(box.id))?.guest?.ref ?? null;
    if (made.ref === current || this.#deps.ledger.records().some((record) => record.livesOn.ref === made.ref && record.backend.id === backend.id)) {
      this.#deps.log?.(`Left guest ${made.ref} of box ${box.name} alone: it is the box's guest, or a snapshot lives on it, so it is not a new guest made part way.`);
      return true;
    }
    const gone = await this.#confirmGone(backend, made, box);
    if (gone) this.#deps.log?.(`Deleted guest ${made.ref}, the new guest part made for the restore of box ${box.name}. bb-box makes it again, or puts the box back.`);
    return gone;
  }

  async #confirmGone(backend: Backend, guest: Guest, box: Pick<BoxRecord, "name">): Promise<boolean> {
    try {
      await backend.release(guest, { resetting: async () => {}, timing: () => {} }, this.#stopping.signal);
      if ((await backend.power(guest, this.#stopping.signal)) !== null) throw new Error(`${backend.label} still lists it after its delete.`);
      return true;
    } catch (cause) {
      if (this.#stopping.signal.aborted) throw cause;
      this.#deps.logError(`delete guest ${guest.ref}, made for the restore of box ${box.name}`, cause);
      return false;
    }
  }

  async #swapBack(context: Restoring, box: BoxRecord, words: string): Promise<never> {
    const ledger = this.#deps.ledger;
    const guests = ledger.operation(context.operation.id)?.guests;
    const old = guests?.old ?? null;
    const fresh = guests?.new ?? null;
    if (!old || !fresh) throw this.#restoreUnsure(context, box, "swap-back", `${words} bb-box has no record of the box's old or new guest to put back.`);
    const said = consentOf(ledger.operation(context.operation.id) ?? context.operation).swapBack ?? words;
    ledger.updateOperation(context.operation.id, { step: "swap-back", consent: { ...(ledger.operation(context.operation.id)?.consent as object), swapBack: said } });
    if (!(await this.#confirmGone(context.backend, fresh, box))) {
      throw this.#restoreUnsure(context, box, "swap-back", `${said} bb-box could not confirm the new guest ${fresh.ref} gone or stopped, so it does not start the old guest ${old.ref} again: both would act as the box. It tries again at its next sweep.`);
    }
    ledger.transaction(() => {
      for (const record of ledger.records({ box: box.id })) if (record.guest === "current" && record.livesOn.ref === fresh.ref) ledger.updateRecord(record.id, { livesOn: old });
    });
    const back = box.guest?.ref === old.ref ? box : await this.#moved(box, { guest: { ...old, facts: box.guest?.facts } });
    return this.#putBack(context, back, "swap-back", `${said} bb-box deleted the new guest and kept the old one.`);
  }

  async #dropOldGuest(box: BoxRecord, backend: Backend, old: Guest): Promise<void> {
    try {
      await backend.release(old, { resetting: async () => {}, timing: () => {} }, this.#stopping.signal);
      this.#deps.log?.(`Deleted guest ${old.ref}, box ${box.name}'s guest before its restore: its snapshots live on ${backend.label}'s account, not on it.`);
    } catch (error) {
      if (this.#stopping.signal.aborted) throw error;
      this.#deps.logError(`delete guest ${old.ref}, box ${box.name}'s guest before its restore; the sweep releases it as a leftover`, error);
    }
  }

  async #undoStillThere(context: Restoring, box: BoxRecord, undo: SnapshotRecord): Promise<void> {
    const { backend } = context;
    let there: boolean | null = null;
    let words = "";
    try {
      if (undo.guest === "held-copy") {
        const copy = this.#copyOf(undo);
        there = copy !== null && (await backend.copyState!(copy, this.#stopping.signal)) === "template";
        words = `its held copy, guest ${undo.livesOn.ref}, is gone or no longer a template`;
      } else {
        const found = (await backend.heldSnapshots!(this.#stopping.signal)).find((held) => held.id === undo.id);
        there = found?.state === "complete";
        words = `${where(undo)} no longer has it whole`;
      }
    } catch (error) {
      if (this.#stopping.signal.aborted) throw error;
      throw this.#restoreUnsure(context, box, "undo-ready", `bb-box could not check that the undo "${undo.name}" is still there: ${sentence(message(error))}`);
    }
    if (there) return;
    this.#deps.ledger.updateRecord(undo.id, { state: "lost", error: words, stateAt: this.#now() });
    this.#event(undo, "snapshot-lost", UNKNOWN_ACTOR, `"${undo.name}" (${undo.id}), the undo of a restore: ${words}.`);
    await this.#putBack(context, box, "undo-ready", `Its undo "${undo.name}" was not there when bb-box went on with the restore: ${words}.`);
  }

  async #replaceUndos(boxId: string, target: string): Promise<string[]> {
    const ledger = this.#deps.ledger;
    const replaced: string[] = [];
    for (;;) {
      const records = ledger.records({ box: boxId });
      const undos = records.filter((record) => record.undoOf !== null && record.keptUntil === null && heldByProvider(record));
      if (undos.length <= UNDOS_PER_BOX) return replaced;
      const victim = undoToReplace(
        records.filter((record) => record.id !== target),
        ledger.pins(),
        this.#now(),
      );
      if (!victim) return replaced;
      try {
        await this.#delete(victim.id, byBbBox("a newer undo replaced it"), "replace-undo", null);
        replaced.push(victim.name);
      } catch (error) {
        this.#deps.log?.(`Did not replace undo ${victim.id} of box ${victim.box.name}: ${message(error)}`);
        return replaced;
      }
    }
  }

  #restoreGone(context: Restoring): BoxError {
    const ledger = this.#deps.ledger;
    const now = this.#now();
    ledger.transaction(() => {
      ledger.updateOperation(context.operation.id, { state: "failed", endedAt: now, error: "Its box is gone." });
      if (context.undo && ledger.record(context.undo.id)?.state === "taking") ledger.removeRecord(context.undo.id);
    });
    return new BoxError("released", "That box was released, so it restores nothing.");
  }

  async #observedWords(backend: Backend, guest: Guest): Promise<string> {
    const power = await backend.power(guest, this.#stopping.signal).catch(() => "unknown" as const);
    return power === null ? "bb-box then found its guest gone" : power === "unknown" ? "bb-box could not then read whether it runs" : `bb-box then found it ${power}`;
  }

  async #putBack(context: Restoring, box: BoxRecord, step: RestoreStep, words: string): Promise<never> {
    const ledger = this.#deps.ledger;
    const { operation, backend, target } = context;
    const guest = box.guest!;
    const ran = box.restoring?.ran ?? true;
    let back: string;
    if (ran) {
      try {
        const started = await backend.start!(guest, this.#stopping.signal);
        box = await this.#moved(box, { state: "ready", error: null, restoring: null, ...(started?.facts ? { guest: { ...guest, facts: started.facts } } : {}) });
        back = `bb-box started box ${box.name} again as it was`;
        this.#deps.boxes.machineBack(box);
      } catch (error) {
        if (this.#stopping.signal.aborted) throw error;
        box = await this.#moved(box, { state: "stopped", error: sentence(message(error)) });
        back = `bb-box could not start box ${box.name} again: ${sentence(message(error)).replace(/\.$/, "")}`;
      }
    } else {
      box = await this.#moved(box, { state: "stopped" });
      back = `box ${box.name} stays stopped, as it was`;
    }
    const now = this.#now();
    ledger.transaction(() => {
      ledger.updateOperation(operation.id, { state: "failed", endedAt: now, error: words });
      if (context.undo && ledger.record(context.undo.id)?.state === "taking") ledger.removeRecord(context.undo.id);
    });
    await this.#moved(box, { restoring: null });
    const observed = await this.#observedWords(backend, guest);
    this.#event(target, "restore-failed", operation.by, `At ${RESTORE_STEP_WORDS[step]}${context.after}: ${words} Nothing on its disk changed; ${back}. ${sentence(observed)}`);
    this.#notify(box.threadId);
    throw new BoxError("failed", `bb-box did not restore box ${box.name} to ${quoted(target)}: ${words} Nothing on its disk changed, and ${back}.`);
  }

  async #leftStopped(context: Restoring, box: BoxRecord, step: RestoreStep, words: string, restored: boolean): Promise<never> {
    const ledger = this.#deps.ledger;
    const { operation, backend, target } = context;
    const guest = box.guest!;
    const power = await backend.power(guest, this.#stopping.signal).catch(() => null);
    const now = this.#now();
    ledger.updateOperation(operation.id, { state: "failed", endedAt: now, error: words });
    box = await this.#moved(box, { state: power === "running" ? "ready" : "stopped", error: words, restoring: null });
    const undo = context.undo ? ledger.record(context.undo.id) : null;
    const observed = await this.#observedWords(backend, guest);
    this.#event(target, "restore-failed", operation.by, `At ${RESTORE_STEP_WORDS[step]}${context.after}: ${words} ${sentence(observed)}`);
    this.#notify(box.threadId);
    const undoWords = undo?.state === "ready" ? ` Its undo "${undo.name}" holds its disk as it was before.` : "";
    throw new BoxError(
      "failed",
      restored
        ? `bb-box restored box ${box.name} to ${quoted(target)}, but could not finish: ${words}`
        : `bb-box could not finish restoring box ${box.name} to ${quoted(target)}: ${words} The box is stopped, and its disk may be part-restored.${undoWords}`,
    );
  }

  #restoreUnsure(context: Restoring, box: BoxRecord, step: RestoreStep, words: string): BoxError {
    this.#deps.ledger.updateOperation(context.operation.id, { state: "unknown", error: `It was at ${RESTORE_STEP_WORDS[step]} when bb-box lost track of it: ${words}` });
    this.#deps.log?.(`Could not confirm the restore of box ${box.name} to snapshot ${context.target.id}, at ${RESTORE_STEP_WORDS[step]}: ${words}`);
    return new BoxError(
      "unreachable",
      `bb-box could not confirm the restore of box ${box.name} to ${quoted(context.target)}: it was at ${RESTORE_STEP_WORDS[step]}, and ${words.replace(/^./, (first) => first.toLowerCase())} It checks again at its next sweep, within a few minutes; bb box sweep checks now.`,
    );
  }

  async #recoverRestore(operation: SnapshotOperation, backend: Backend, byId: ReadonlyMap<string, HeldSnapshot>, signal?: AbortSignal): Promise<boolean> {
    const ledger = this.#deps.ledger;
    const target = ledger.record(operation.snapshots[0] ?? "");
    const undo = operation.undo ? ledger.record(operation.undo) : null;
    const box = await this.#deps.boxes.find(operation.box);
    const after = " after bb-box restarted";
    if (!target || !box?.guest) {
      const now = this.#now();
      ledger.transaction(() => {
        ledger.updateOperation(operation.id, { state: "failed", endedAt: now, error: !target ? "Its snapshot's record is gone." : "Its box is gone." });
        if (undo?.state === "taking") ledger.removeRecord(undo.id);
      });
      if (box) await this.#moved(box, { restoring: null });
      return true;
    }
    const fromSnapshot = (operation.consent as { newGuest?: unknown } | null)?.newGuest === true;
    const context: Restoring = { swap: target.guest === "held-copy" || fromSnapshot, fromSnapshot, operation, target, undo, backend, anyway: [], from: null, after };
    const unsure = async (words: string): Promise<boolean> => {
      ledger.updateOperation(operation.id, { state: "unknown", error: words });
      if (!box.restoring) await this.#moved(box, { restoring: { operation: operation.id, snapshot: target.id, name: target.name, at: operation.startedAt, ran: true } });
      return false;
    };
    const settle = async (work: () => Promise<unknown>): Promise<boolean> => {
      try {
        await work();
      } catch (error) {
        if (signal?.aborted || this.#stopping.signal.aborted) throw error;
        this.#deps.log?.(`Settled the restore of box ${box.name}${after}: ${message(error)}`);
      }
      const now = ledger.operation(operation.id);
      return now?.state === "done" || now?.state === "failed";
    };
    const step = operation.step as RestoreStep;
    if (!RESTORE_STEPS.includes(step)) return unsure(`bb-box does not know the step "${operation.step}" it had reached.`);
    if (step === "swap-back") return settle(() => this.#swapBack(context, box, "bb-box restarted while it put the box's old guest back."));
    if (step === "planned") return this.#neverBegan(context, box, "bb-box restarted before the restore began.");
    if (step === "stopping") {
      const power = await backend.power(box.guest, signal).catch(() => "unknown" as const);
      if (power === "unknown") return unsure("bb-box could not read whether the box had stopped when it restarted.");
      if (power === "running" && box.restoring?.ran !== false) return this.#neverBegan(context, box, "bb-box restarted before the box stopped.");
      return settle(() => this.#runRestore(context, "stopped"));
    }
    if (step === "undo-submitting" || step === "undo-task") {
      if (!undo) return settle(() => this.#runRestore(context, "undo-ready"));
      const task = await this.#taskOf(operation, backend, box.guest, signal, "take");
      const found = byId.get(undo.id) ?? null;
      if (task?.state === "unreadable") return unsure(`bb-box could not read the undo's task on ${where(target)}: ${sentence(task.words)}`);
      if (task?.state === "running" || found?.state === "in-progress") return unsure(`The undo's task on ${where(target)} was still running when bb-box looked.`);
      if (found?.state === "complete" && task?.state === "ok") {
        const now = this.#now();
        ledger.updateRecord(undo.id, { state: "ready", ref: found.ref, holds: found.holds, capturedAt: found.takenAt ?? undo.takenAt, stateAt: now, error: null });
        ledger.updateOperation(operation.id, { step: "undo-ready" });
        this.#event(undo, "snapshot-taken", undo.by, `"${undo.name}" (${undo.id}): ${holdsWords(undo)}, the undo of the restore to ${quoted(target)}, confirmed${after}.`);
        return settle(() => this.#runRestore(context, "undo-ready"));
      }
      if (!found && task === null && step === "undo-submitting") return settle(() => this.#runRestore(context, "stopped"));
      if (!found && task?.state === "missing") return unsure(`Proxmox no longer has the undo's task, and ${where(target)} has no such snapshot, so bb-box cannot tell how it ended.`);
      if (found?.state === "complete" && task?.state !== "failed") return unsure(`${where(target)} has the undo, but bb-box cannot find the task that took it, so it cannot confirm it complete.`);
      const words = found ? sentence(found.words ?? `${where(target)} left part of the undo`) : task?.state === "failed" ? sentence(task.words) : `The undo's task on ${where(target)} ended, but the guest has no such snapshot.`;
      ledger.updateRecord(undo.id, { state: found ? "incomplete" : "failed", ref: found?.ref ?? undo.ref, error: words, stateAt: this.#now() });
      return settle(() => this.#putBack(context, box, "undo-task", `bb-box could not take the undo "${undo.name}": ${words}`));
    }
    if (step.startsWith("copy-") && step !== "copy-ready") {
      if (!undo || !backend.copyState || !backend.deleteCopy) return unsure("bb-box cannot check the undo's copy on this backend.");
      const copy = this.#copyOf(undo);
      if (step === "copy-submitting" || step === "copy-task") {
        const task = await this.#taskOf(operation, backend, operation.guests?.old ?? box.guest, signal, "copy");
        if (task?.state === "unreadable") return unsure(`It was copying the box for its undo, and bb-box could not read the copy's task: ${sentence(task.words)}`);
        if (task?.state === "running") return unsure("It was copying the box for its undo, and Proxmox's copy was still running when bb-box looked.");
      }
      const state = copy ? await backend.copyState(copy, signal).catch(() => "unread" as const) : "gone";
      if (state === "unread") return unsure("bb-box could not read the undo's copy.");
      if (state === "template" && copy) {
        const now = this.#now();
        ledger.transaction(() => {
          ledger.updateRecord(undo.id, { state: "ready", ref: copy.ref, livesOn: copy, host: copy.host, capturedAt: undo.takenAt, stateAt: now, error: null });
          ledger.updateOperation(operation.id, { step: "copy-ready" });
        });
        this.#event(undo, "held-copy-made", undo.by, `"${undo.name}" (${undo.id}): a held copy of the stopped box, guest ${copy.ref}, a template that cannot start, confirmed${after}.`);
        return settle(() => this.#runRestore(context, "copy-ready"));
      }
      if (state === "copy" && copy) {
        await backend.deleteCopy(copy, signal);
        this.#deps.log?.(`Deleted guest ${copy.ref}, the undo's copy for the restore of box ${box.name}: bb-box restarted before it was a template, so it is not trusted. bb-box makes it again from the stopped box.`);
      }
      ledger.transaction(() => {
        ledger.updateRecord(undo.id, { ref: null, livesOn: box.guest!, host: box.guest!.host });
        ledger.updateOperation(operation.id, { step: "stopped", task: null });
      });
      return settle(() => this.#runRestore({ ...context, undo: ledger.record(undo.id) }, "stopped"));
    }
    if (step === "adopt-claimed" || step === "adopt-submitting" || step === "adopt-task") {
      const fresh = operation.guests?.new ?? null;
      if (fresh && box.guest.ref === fresh.ref) return settle(() => this.#runRestore(context, "adopted"));
      if (step !== "adopt-claimed" && (operation.task || backend.findTasks)) {
        const task = await this.#taskOf(operation, backend, target.livesOn, signal, "copy");
        if (task?.state === "unreadable") return unsure(`It was making the box's new guest, and bb-box could not read the copy's task: ${sentence(task.words)}`);
        if (task?.state === "running") return unsure("It was making the box's new guest, and Proxmox's copy was still running when bb-box looked.");
      }
      if (!(await this.#discardAdoption(box, backend, fresh))) return unsure(`It was making the box's new guest, and bb-box could not confirm the part-made guest ${fresh?.ref ?? ""} gone, so it starts neither.`);
      ledger.updateOperation(operation.id, { step: "copy-ready", task: null, guests: { old: operation.guests?.old ?? box.guest, new: null } });
      return settle(() => this.#runRestore(context, "copy-ready"));
    }
    if (step === "rollback-submitting" || step === "rollback-task") {
      const task = await this.#taskOf(operation, backend, box.guest, signal, "rollback");
      if (task?.state === "unreadable") return unsure(`It was rolling back, and bb-box could not read the rollback's task: ${sentence(task.words)}`);
      if (task?.state === "running") return unsure("It was rolling back, and Proxmox's rollback was still running when bb-box looked.");
      if (task?.state === "ok") return settle(() => this.#runRestore(context, "rolled-back"));
      if (task?.state === "failed") return settle(() => this.#leftStopped(context, box, "rollback-task", `Proxmox's rollback task failed: ${sentence(task.words).replace(/\.$/, "")}.`, false));
      if (task === null && step === "rollback-submitting") return settle(() => this.#runRestore(context, undo?.guest === "held-copy" ? "copy-ready" : "undo-ready"));
      return unsure("It was rolling back, and Proxmox no longer has the rollback's task, so bb-box cannot tell how it ended.");
    }
    return settle(() => this.#runRestore(context, step));
  }

  async #neverBegan(context: Restoring, box: BoxRecord, words: string): Promise<boolean> {
    const ledger = this.#deps.ledger;
    const now = this.#now();
    ledger.transaction(() => {
      ledger.updateOperation(context.operation.id, { state: "failed", endedAt: now, error: words });
      if (context.undo && ledger.record(context.undo.id)?.state === "taking") ledger.removeRecord(context.undo.id);
    });
    await this.#moved(box, { restoring: null, ...(box.state === "stopping" ? { state: "ready" as const } : {}) });
    this.#event(context.target, "restore-failed", context.operation.by, `${words} Nothing changed.`);
    this.#notify(box.threadId);
    return true;
  }

  async recover(signal?: AbortSignal): Promise<number> {
    const ledger = this.#deps.ledger;
    if (ledger.problem) return 0;
    const waiting = ledger.unsettled().filter((operation) => !this.#running.has(operation.id));
    const forks = waiting.filter((operation) => operation.kind === "fork");
    const others = waiting.filter((operation) => operation.kind !== "fork");
    const settledHere = (forks.length ? await this.#recoverForks(forks) : 0) + (others.length ? await this.#recoverWaiting(others, signal) : 0);
    await this.#clearStaleMarks();
    this.#marksChanged();
    return settledHere;
  }

  async #clearStaleMarks(): Promise<void> {
    const ledger = this.#deps.ledger;
    for (const box of await this.#deps.boxes.all()) {
      const mark = box.restoring;
      if (!mark || this.#running.has(mark.operation)) continue;
      const operation = ledger.operation(mark.operation);
      if (operation && (operation.state === "running" || operation.state === "unknown")) continue;
      await this.#deps.boxes.update(box, (current) => (current.restoring?.operation === mark.operation ? { restoring: null } : {}));
      this.#deps.log?.(`Cleared box ${box.name}'s mark of a restore to "${mark.name}": ${operation ? `that restore ${operation.state === "done" ? "is done" : "failed"}` : "bb-box has no record of that restore"}, so nothing holds the box any more.`);
    }
  }

  async #recoverWaiting(waiting: readonly SnapshotOperation[], signal?: AbortSignal): Promise<number> {
    const ledger = this.#deps.ledger;
    const byBackend = new Map<string, SnapshotOperation[]>();
    for (const operation of waiting) {
      const record = ledger.record(operation.snapshots[0] ?? "");
      const backendId = record?.backend.id ?? (await this.#deps.boxes.find(operation.box))?.backend ?? null;
      if (!record || !backendId) {
        ledger.updateOperation(operation.id, { state: "failed", endedAt: this.#now(), error: "Its snapshot's record is gone." });
        continue;
      }
      byBackend.set(backendId, [...(byBackend.get(backendId) ?? []), operation]);
    }
    let settled = 0;
    for (const [backendId, operations] of byBackend) {
      signal?.throwIfAborted();
      const backend = this.#deps.backends.get(backendId);
      const unknown = (error: string) => {
        for (const operation of operations) ledger.updateOperation(operation.id, { state: "unknown", error });
      };
      if (!backend?.heldSnapshots) {
        unknown("Its backend is not in bb-box's settings, so bb-box cannot see how it ended.");
        continue;
      }
      let listing: readonly HeldSnapshot[];
      try {
        listing = await backend.heldSnapshots(signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        unknown(`bb-box could not list ${backend.label}'s snapshots: ${sentence(message(error))}`);
        continue;
      }
      const byId = preferredById(listing);
      for (const operation of operations) {
        try {
          if (await this.#deps.boxes.inTurn(operation.box, () => this.#recoverOne(operation.id, backend, byId, listing, signal))) settled++;
        } catch (error) {
          if (signal?.aborted) throw error;
          this.#deps.logError(`settle snapshot operation ${operation.id}`, error);
        }
      }
    }
    return settled;
  }

  async #taskOf(operation: SnapshotOperation, backend: Backend, guest: Guest, signal?: AbortSignal, kind: TaskKind = operation.kind === "delete" ? "delete" : "take"): Promise<TaskSeen> {
    let ref = operation.task;
    if (!ref && operation.step.endsWith("submitting")) {
      if (!backend.findTasks) return { state: "unreadable", words: `${backend.label} cannot say whether it accepted the request` };
      try {
        const thisAttempt = operation.kind === "restore" || operation.kind === "hold-copy";
        const earlier = new Set((operation.attempts ?? []).slice(0, -1).flatMap((attempt) => (attempt.task ? [attempt.task.ref] : [])));
        const since = thisAttempt ? (operation.stepAt ?? operation.startedAt) : operation.startedAt;
        const candidates = (await backend.findTasks(guest, kind, since, signal)).filter((candidate) => !earlier.has(candidate.ref) && !this.#deps.ledger.operationWithTask(candidate.ref));
        if (thisAttempt && candidates.length > 1) return { state: "unreadable", words: `${backend.label} lists ${candidates.length} tasks that could be this step's, so bb-box cannot tell which is` };
        ref = candidates[0] ?? null;
      } catch (error) {
        if (signal?.aborted) throw error;
        return { state: "unreadable", words: message(error) };
      }
      if (ref) this.#deps.ledger.updateOperation(operation.id, { step: operation.step.replace(/submitting$/, "task"), task: ref, ...(operation.kind === "hold-copy" ? { attempts: withAttemptTask(operation.attempts, ref) } : {}) });
    }
    if (!ref) return null;
    if (!backend.providerTask) return { state: "unreadable", words: `${backend.label} cannot read its tasks` };
    try {
      return await backend.providerTask(ref, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      return { state: "unreadable", words: message(error) };
    }
  }

  async #recoverOne(operationId: string, backend: Backend, byId: ReadonlyMap<string, HeldSnapshot>, listing: readonly HeldSnapshot[], signal?: AbortSignal): Promise<boolean> {
    const ledger = this.#deps.ledger;
    const operation = ledger.operation(operationId);
    if (!operation || (operation.state !== "running" && operation.state !== "unknown") || this.#running.has(operation.id)) return false;
    if (operation.kind === "restore") return this.#recoverRestore(operation, backend, byId, signal);
    if (operation.kind === "hold-copy") return this.#recoverHoldCopy(operation);
    if (operation.kind === "keep") return this.#recoverKeep(operation, listing);
    const record = ledger.record(operation.snapshots[0] ?? "");
    const now = this.#now();
    if (!record) {
      ledger.updateOperation(operation.id, { state: "failed", endedAt: now, error: "Its snapshot's record is gone." });
      return true;
    }
    if (operation.kind === "take" && operation.step === "evicting" && record.state === "ready") {
      await this.#finishEviction(operation.id, record, this.settings.perBox);
      this.#notify(record.box.thread);
      return true;
    }
    const found = byId.get(record.id) ?? null;
    const box = await this.#deps.boxes.find(record.box.id);
    const task = await this.#taskOf(operation, backend, this.#guestOf(record, box), signal);
    const unsure = (words: string): boolean => {
      ledger.updateOperation(operation.id, { state: "unknown", error: words });
      return false;
    };
    if (task?.state === "unreadable") return unsure(`bb-box could not read its task on ${where(record)}: ${sentence(task.words)}`);
    if (task?.state === "running" || found?.state === "in-progress") return unsure(`Its task on ${where(record)} was still running when bb-box looked.`);
    const after = "after bb-box restarted";
    if (operation.kind === "take") {
      if (found?.state === "complete" && task?.state === "ok") {
        const evicting = consentOf(operation).evicts !== null;
        const updated = ledger.transaction(() => {
          const ready = ledger.updateRecord(record.id, { state: "ready", ref: found.ref, holds: found.holds, capturedAt: found.takenAt ?? record.takenAt, stateAt: now, error: null });
          ledger.updateOperation(operation.id, evicting ? { step: "evicting", error: null } : { state: "done", step: "done", endedAt: now, error: null });
          return ready;
        });
        this.#event(updated ?? record, "snapshot-taken", record.by, `"${record.name}" (${record.id}): ${holdsWords({ holds: found.holds, scope: record.scope })}, confirmed ${after}.`);
        if (evicting) await this.#finishEviction(operation.id, updated ?? record, this.settings.perBox);
        this.#notify(record.box.thread);
        return true;
      }
      if (found?.state === "complete" && task?.state !== "failed") return unsure(`${where(record)} has the snapshot, but bb-box cannot find the task that took it, so it cannot confirm it complete.`);
      if (!found && task?.state === "missing") return unsure(`Proxmox no longer has its task, and ${where(record)} has no such snapshot, so bb-box cannot tell how it ended.`);
      const words = found
        ? found.state === "complete"
          ? `Proxmox's task failed (${(task as { words: string }).words.replace(/\.$/, "")}), though it left the snapshot with no part-made state, so bb-box does not count it as taken.`
          : sentence(found.words ?? `${where(record)} left part of it`)
        : task?.state === "failed"
          ? sentence(task.words)
          : task?.state === "ok"
            ? `Its task on ${where(record)} ended, but the guest has no such snapshot.`
            : operation.step === "planned"
              ? `bb-box restarted before the take began, and ${where(record)} has no such snapshot.`
              : `${where(record)} has no task and no snapshot for it: the take did not begin.`;
      ledger.transaction(() => {
        ledger.updateRecord(record.id, { state: found ? "incomplete" : "failed", ref: found?.ref ?? record.ref, error: words, stateAt: now });
        ledger.updateOperation(operation.id, { state: "failed", endedAt: now, error: words });
      });
      this.#event(record, "snapshot-failed", record.by, `"${record.name}": ${words}${found ? ` Part of it is left on ${where(record)}.` : ""}`);
      this.#notify(record.box.thread);
      return true;
    }
    if (operation.kind === "delete") {
      if (!found) {
        ledger.transaction(() => {
          ledger.removeRecord(record.id);
          ledger.updateOperation(operation.id, { state: "done", step: "done", endedAt: now, error: null });
        });
        this.#event(record, "snapshot-deleted", operation.by, `"${record.name}" (${record.id}): ${freedWords(record)}, confirmed ${after}.`);
        this.#notify(record.box.thread);
        return true;
      }
      if (found.state === "incomplete") {
        const words = sentence(found.words ?? `${where(record)} left part of it`);
        ledger.transaction(() => {
          ledger.updateRecord(record.id, { state: "incomplete", ref: found.ref, error: words, stateAt: now });
          ledger.updateOperation(operation.id, { state: "failed", endedAt: now, error: words });
        });
        this.#notify(record.box.thread);
        return true;
      }
      if (task === null || task.state === "missing") {
        ledger.updateOperation(operation.id, { state: "running", error: null });
        await this.#runDelete({ ...record, ref: found.ref }, { ...operation, state: "running" }, backend, box, "ready").catch((error) => this.#deps.logError(`finish deleting snapshot ${record.id}`, error));
        return true;
      }
      const words = task.state === "failed" ? sentence(task.words) : `Its task on ${where(record)} ended, but the snapshot is still there.`;
      ledger.transaction(() => {
        ledger.updateRecord(record.id, { state: "ready", ref: found.ref, error: words, stateAt: now });
        ledger.updateOperation(operation.id, { state: "failed", endedAt: now, error: words });
      });
      this.#notify(record.box.thread);
      return true;
    }
    return false;
  }

  async reconcile(signal?: AbortSignal): Promise<void> {
    const ledger = this.#deps.ledger;
    if (ledger.problem) return;
    const checked = new Set<string>();
    for (const backend of this.#deps.backends.active()) {
      signal?.throwIfAborted();
      if (!backend.heldSnapshots) continue;
      checked.add(backend.id);
      const listedAt = this.#now();
      let listing: readonly HeldSnapshot[];
      try {
        listing = await backend.heldSnapshots(signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        this.#unreachable(backend.id, sentence(message(error)), listedAt);
        continue;
      }
      const boxes = new Map((await this.#deps.boxes.all()).map((box) => [box.id, box]));
      const untrusted = this.#reconcileWith(backend, listing, listedAt, boxes);
      for (const copy of untrusted) await this.#dropUntrusted(backend, copy, signal);
    }
    const now = this.#now();
    for (const record of ledger.records()) {
      if (checked.has(record.backend.id) || this.#deps.backends.get(record.backend.id)) continue;
      this.#unreachable(record.backend.id, "its backend is not in bb-box's settings", now);
    }
  }

  #unreachable(backendId: string, words: string, at: number): void {
    const ledger = this.#deps.ledger;
    const pins = ledger.pins();
    for (const record of ledger.records({ backend: backendId })) {
      if (record.state !== "ready" || pins.has(record.id) || record.stateAt >= at) continue;
      const updated = ledger.updateRecord(record.id, { state: "unavailable", error: words, stateAt: this.#now() });
      this.#event(updated ?? record, "snapshot-unavailable", UNKNOWN_ACTOR, `"${record.name}" (${record.id}): ${words}`);
      this.#notify(record.box.thread);
    }
  }

  async #dropUntrusted(backend: Backend, copy: HeldSnapshot, signal?: AbortSignal): Promise<void> {
    if (!backend.deleteCopy) return;
    try {
      await backend.deleteCopy(copy.guest, signal);
      this.#deps.log?.(`Deleted guest ${copy.guest.ref}, a held copy of snapshot ${copy.id} that is not a template, found beside the snapshot it copies: such a copy is never trusted, and a release makes it again.`);
    } catch (error) {
      if (signal?.aborted) throw error;
      this.#deps.log?.(`Could not delete guest ${copy.guest.ref}, a held copy of snapshot ${copy.id} that is not a template: ${message(error)} The next sweep tries again.`);
    }
  }

  #reconcileWith(backend: Backend, listing: readonly HeldSnapshot[], listedAt: number, boxes: ReadonlyMap<string, BoxRecord>): HeldSnapshot[] {
    const ledger = this.#deps.ledger;
    const pins = ledger.pins();
    const now = this.#now();
    const preferred = preferredById(listing);
    const touched = new Set<string>();
    for (const record of ledger.records({ backend: backend.id })) {
      if (pins.has(record.id) || record.stateAt >= listedAt || ledger.changedSince(record.id, listedAt)) continue;
      const held = listing.find((each) => each.id === record.id && each.guest.ref === record.livesOn.ref) ?? preferred.get(record.id);
      if (held) {
        const state = held.state === "complete" ? "ready" : held.state === "incomplete" ? "incomplete" : record.state;
        const back = record.boxGone && boxes.has(record.box.id) ? { boxGone: null, foundAt: null } : {};
        const later = held.keptUntil !== null && held.keptUntil > now && (record.keptUntil === null || held.keptUntil > record.keptUntil);
        if (later) this.#deps.log?.(`Took the keep date of snapshot ${record.id} of box ${record.box.name}, ${utcDay(held.keptUntil!)}, from its label on ${where(record)}: it is later than bb-box's record${record.keptUntil === null ? ", which had none" : ` of ${utcDay(record.keptUntil)}`}.`);
        const change = {
          ...(state !== record.state ? { state, stateAt: now, error: held.state === "incomplete" ? (held.words ?? null) : null } : {}),
          ...(record.missingSince !== null ? { missingSince: null } : {}),
          ...(record.ref === null ? { ref: held.ref } : {}),
          ...(record.storage === null && held.storage ? { storage: held.storage } : {}),
          ...(later ? { keptUntil: held.keptUntil, keptAt: record.keptAt ?? now, owner: "person" as const } : {}),
          ...back,
        };
        if (Object.keys(change).length) {
          ledger.updateRecord(record.id, change);
          touched.add(record.box.thread);
        }
        continue;
      }
      if (record.state === "failed" || record.state === "lost") continue;
      if (record.state === "incomplete") {
        ledger.removeRecord(record.id);
        this.#event(record, "snapshot-deleted", BY_OUTSIDE, `"${record.name}" (${record.id}): ${where(record)} no longer has it.`);
        touched.add(record.box.thread);
        continue;
      }
      if (record.missingSince === null) {
        ledger.updateRecord(record.id, { missingSince: listedAt });
        continue;
      }
      if (listedAt - record.missingSince >= LOST_AFTER_MISSING_MS) {
        const lost = ledger.updateRecord(record.id, { state: "lost", stateAt: now, error: null });
        this.#event(lost ?? record, "snapshot-lost", UNKNOWN_ACTOR, `"${record.name}" (${record.id}): ${where(record)} no longer has it.`);
        touched.add(record.box.thread);
      }
    }
    for (const held of preferred.values()) {
      if (held.state === "in-progress" || ledger.record(held.id) || ledger.changedSince(held.id, listedAt)) continue;
      const restored = this.#recordAgain(backend, held, boxes.get(held.box) ?? null, now);
      ledger.insertRecord(restored);
      touched.add(restored.box.thread);
      this.#deps.log?.(
        restored.foundAt !== null
          ? `Found snapshot ${held.id} of box ${held.box} on ${restored.host ?? backend.label}, which is not in bb-box's records and whose box is gone. It is listed until you delete it.`
          : `Found snapshot ${held.id} of box ${restored.box.name} on ${restored.host ?? backend.label} without a record, and gave it one again${restored.keptUntil !== null ? ", as kept" : ""}.`,
      );
    }
    for (const thread of touched) this.#notify(thread);
    const copying = new Set(ledger.unsettled().flatMap((operation) => [operation.guests?.old?.ref, operation.guests?.new?.ref].filter((ref): ref is string => !!ref)));
    return listing.filter((held) => held.where === "held-copy" && held.state !== "complete" && preferred.get(held.id) !== held && !copying.has(held.guest.ref) && ledger.record(held.id)?.livesOn.ref !== held.guest.ref);
  }

  #priceOfFound(backend: Backend, kind: string | null): Price | null {
    const ofKind = kind ? this.offerFor(backend, kind)?.price : undefined;
    if (ofKind !== undefined) return ofKind;
    return backend.kinds().map((each) => this.offerFor(backend, each.id)?.price ?? null).find((price) => price !== null) ?? null;
  }

  #recordAgain(backend: Backend, held: HeldSnapshot, box: BoxRecord | null, now: number): SnapshotRecord {
    const live = box !== null && box.backend === backend.id;
    const takenAt = held.takenAt ?? now;
    const names = new Set(this.#deps.ledger.records({ box: held.box }).map((record) => record.name));
    const kept = held.keptUntil !== null && held.keptUntil > now;
    const owner = held.owner;
    return {
      id: held.id,
      box: live
        ? { id: box.id, name: box.name, kind: box.kind, system: box.capabilities.os, thread: box.threadId }
        : { id: held.box, name: owner?.name ?? held.box, kind: owner?.kind ?? "unknown", system: (owner?.kind ? backend.kinds().find((kind) => kind.id === owner.kind)?.capabilities.os : undefined) ?? "unknown", thread: owner?.threadId ?? "unknown" },
      boxGone: live ? null : { at: now, how: "unknown" },
      backend: { id: backend.id, label: backend.label },
      host: held.guest.host,
      storage: held.storage,
      guest: held.where,
      livesOn: held.guest,
      name: uniqueName(timeName(takenAt, this.#deps.timeZone), names),
      note: null,
      takenAt,
      capturedAt: held.takenAt,
      tookMs: null,
      by: UNKNOWN_ACTOR,
      scope: "box",
      holds: held.holds,
      excludes: null,
      size: null,
      price: this.#priceOfFound(backend, live ? box.kind : (owner?.kind ?? null)),
      owner: kept || (live ? box.threadId === OPERATOR : owner?.threadId === OPERATOR) ? "person" : "thread",
      keptUntil: kept ? held.keptUntil : null,
      keptAt: null,
      undoOf: null,
      forkSafe: held.forkSafe ?? null,
      dependsOn: [],
      picture: null,
      ref: held.ref,
      state: held.state === "incomplete" ? "incomplete" : "ready",
      error: held.state === "incomplete" ? held.words : null,
      stateAt: now,
      missingSince: null,
      foundAt: live || kept ? null : now,
    };
  }

  async tidy(signal?: AbortSignal): Promise<void> {
    const ledger = this.#deps.ledger;
    if (ledger.problem) return;
    const now = this.#now();
    const pins = ledger.pins();
    const automatic: { record: SnapshotRecord; change: Change; by: Actor }[] = [];
    for (const record of ledger.records()) {
      if (pins.has(record.id)) continue;
      if (record.state === "failed" && now - record.stateAt >= FAILED_KEPT_MS) {
        ledger.removeRecord(record.id);
        continue;
      }
      if (record.state === "lost" && now - record.stateAt >= LOST_KEPT_MS) {
        ledger.removeRecord(record.id);
        this.#deps.log?.(`Removed bb-box's record of snapshot ${record.id} of box ${record.box.name}, lost for 7 days.`);
        continue;
      }
      if (eligible(record, "expire", { pin: null, now }).ok) automatic.push({ record, change: "expire", by: byBbBox("its keep ended") });
      else if (record.boxGone?.how === "released" && record.keptUntil === null && this.#onProvider(record) && eligible(record, "delete", { pin: null, now }).ok) automatic.push({ record, change: "delete", by: byBbBox("its box was released") });
    }
    for (const { record, change, by } of automatic) {
      signal?.throwIfAborted();
      await this.#deleteAutomatically(record, change, by);
    }
    await this.#deleteGuestsOfGoneBoxes(signal);
    await this.#sweepRoom(signal);
    ledger.prune(now);
  }

  async #deleteGuestsOfGoneBoxes(signal?: AbortSignal): Promise<void> {
    const ledger = this.#deps.ledger;
    const pins = ledger.pins();
    const byGuest = new Map<string, SnapshotRecord[]>();
    for (const record of ledger.records()) {
      if (record.guest === "current" || record.boxGone?.how !== "released" || record.keptUntil !== null || pins.has(record.id) || !heldByProvider(record)) continue;
      const key = `${record.backend.id}|${record.livesOn.ref}`;
      byGuest.set(key, [...(byGuest.get(key) ?? []), record]);
    }
    for (const records of byGuest.values()) {
      signal?.throwIfAborted();
      const first = records[0]!;
      const backend = this.#deps.backends.get(first.backend.id);
      if (!backend?.deleteCopy) continue;
      const all = ledger.records({ box: first.box.id }).filter((record) => record.livesOn.ref === first.livesOn.ref);
      if (all.some((record) => record.keptUntil !== null || pins.has(record.id))) continue;
      try {
        await backend.deleteCopy(first.livesOn, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        this.#deps.log?.(`Could not delete guest ${first.livesOn.ref}, ${first.guest === "held-copy" ? "a held copy" : "the earlier guest"} of released box ${first.box.name}: ${message(error)} The next sweep tries again.`);
        continue;
      }
      const now = this.#now();
      ledger.transaction(() => {
        for (const record of all) {
          ledger.removeRecord(record.id);
          ledger.insertOperation(this.#settled(record, byBbBox("its box was released"), now));
        }
      });
      for (const record of all) this.#event(record, "snapshot-deleted", byBbBox("its box was released"), `"${record.name}" (${record.id}): it went with ${record.guest === "held-copy" ? "its held copy" : "its box's earlier guest"}, guest ${record.livesOn.ref}.`);
    }
  }

  async #deleteAutomatically(record: SnapshotRecord, change: Change, by: Actor): Promise<boolean> {
    try {
      await this.#deps.boxes.inTurn(record.box.id, () => this.#delete(record.id, by, change, null));
      return true;
    } catch (error) {
      this.#deps.log?.(`Did not delete snapshot ${record.id} of box ${record.box.name}: ${message(error)}`);
      return false;
    }
  }

  async #sweepRoom(signal?: AbortSignal): Promise<void> {
    const ledger = this.#deps.ledger;
    const byStorage = new Map<string, SnapshotRecord[]>();
    for (const record of roomCandidates(ledger.records(), ledger.pins(), this.#now())) {
      if (!record.storage) continue;
      const key = storageGroup(record.backend.id, record.host, record.storage.name);
      byStorage.set(key, [...(byStorage.get(key) ?? []), record]);
    }
    for (const candidates of byStorage.values()) {
      for (let deleted = 0; deleted < ROOM_DELETES_PER_SWEEP && candidates.length; ) {
        signal?.throwIfAborted();
        const first = candidates[0]!;
        const backend = this.#deps.backends.get(first.backend.id);
        const box = await this.#deps.boxes.find(first.box.id);
        if (!backend?.planSnapshots || !box?.guest) break;
        const plan = await backend.planSnapshots(box.guest, box.kind, null, signal).catch(() => null);
        if (!plan || plan.storage.percentFull <= roomThresholds(this.settings.roomPercent).sweep) break;
        candidates.shift();
        const why = `${first.host ? `${first.host}'s ` : ""}storage ${plan.storage.name} was ${Math.round(plan.storage.percentFull)}% full`;
        if (await this.#deleteAutomatically(first, "evict-room", byBbBox(why))) deleted++;
      }
    }
  }

  async outsideRestores(signal?: AbortSignal): Promise<void> {
    const ledger = this.#deps.ledger;
    if (ledger.problem) return;
    for (const backend of this.#deps.backends.active()) {
      signal?.throwIfAborted();
      if (!backend.outsideRollbacks) continue;
      const checkedAt = this.#now();
      const since = this.#outsideSince.get(backend.id) ?? checkedAt - OUTSIDE_LOOK_BACK_MS;
      let found: readonly OutsideRollback[];
      try {
        found = await backend.outsideRollbacks(since, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        this.#deps.log?.(`Could not read ${backend.label}'s rollback tasks, so bb-box checked for no restore made outside it: ${message(error)}`);
        continue;
      }
      const boxes = (await this.#deps.boxes.all()).filter((box) => box.backend === backend.id && box.guest);
      const restoring = new Set(ledger.unsettled().filter((operation) => operation.kind === "restore").map((operation) => operation.box));
      let earliestRunning: number | null = null;
      for (const rollback of found) {
        const box = boxes.find((candidate) => candidate.guest!.ref === rollback.guest);
        if (!box || ledger.operationWithTask(rollback.task.ref)) continue;
        if (box.restoring || restoring.has(box.id) || this.#runningOn(box.id)) {
          earliestRunning = Math.min(earliestRunning ?? rollback.startedAt, rollback.startedAt);
          continue;
        }
        const told = `Proxmox's task ${rollback.task.ref}, by ${rollback.user || "a user Proxmox does not name"}, at ${dayWords(rollback.startedAt)}`;
        if (rollback.outcome.state === "running") {
          earliestRunning = Math.min(earliestRunning ?? rollback.startedAt, rollback.startedAt);
          if (this.#outsideRunning.has(rollback.task.ref)) continue;
          this.#outsideRunning.add(rollback.task.ref);
          this.#boxEvent(box, "restore-outside-running", BY_OUTSIDE, `${told}, is still running. bb-box looks again at its next sweep.`);
          continue;
        }
        if (rollback.outcome.state === "missing") continue;
        this.#outsideRunning.delete(rollback.task.ref);
        const ok = rollback.outcome.state === "ok";
        const now = this.#now();
        const words = rollback.outcome.state === "failed" ? sentence(rollback.outcome.words) : null;
        ledger.insertOperation({
          id: newOperationId(this.#random),
          request: null,
          requestDigest: null,
          kind: "restore",
          box: box.id,
          guest: rollback.guest,
          snapshots: [],
          by: BY_OUTSIDE,
          consent: null,
          undo: null,
          guests: null,
          step: "done",
          task: rollback.task,
          state: ok ? "done" : "failed",
          reserved: null,
          error: words,
          startedAt: rollback.startedAt,
          endedAt: now,
          snapshotsGoneAt: now,
        });
        if (ok) {
          const straightened = await this.#deps.boxes.inTurn(box.id, () => this.#straighten(box.id, backend)).catch((error: unknown) => `bb-box could not set it straight: ${sentence(message(error))}`);
          this.#boxEvent(box, "restored-outside", BY_OUTSIDE, `${told}, ended OK: its disk went back to an earlier snapshot. ${straightened}`);
        } else {
          const observed = await this.#observedWords(backend, box.guest!);
          this.#boxEvent(box, "restore-outside-failed", BY_OUTSIDE, `${told}, failed: ${words} ${sentence(observed)}`);
        }
        this.#notify(box.threadId);
      }
      this.#outsideSince.set(backend.id, Math.min(earliestRunning ?? checkedAt, checkedAt) - OUTSIDE_SLACK_MS);
    }
  }

  #runningOn(boxId: string): boolean {
    for (const id of this.#running) if (this.#deps.ledger.operation(id)?.box === boxId) return true;
    return false;
  }

  async #straighten(boxId: string, backend: Backend): Promise<string> {
    const box = await this.#deps.boxes.find(boxId);
    if (!box?.guest) return "Its box is gone.";
    const done: string[] = [];
    const size = await this.#sizeOf(backend, box.guest, this.#stopping.signal);
    if (size && describeSize(size) !== describeSize(box.guest.size ?? size)) {
      await this.#deps.boxes.update(box, (current) => (current.guest ? { guest: { ...current.guest, size }, size } : {}));
      done.push(`read its size back, ${describeSize(size)}, as it was then`);
    }
    if (backend.relabel) {
      const size = box.guest.size ?? box.size ?? null;
      if (size) {
        await backend.relabel(box.guest, identity(box, size), box.name, this.#stopping.signal);
        done.push("wrote its labels again");
      }
    }
    if ((await backend.power(box.guest, this.#stopping.signal)) === "running" && box.state === "ready") {
      await this.#deps.boxes.writeAccess(box, this.#stopping.signal);
      done.push("wrote its access file");
      if (this.#deps.boxes.machineBack(box)) done.push("started its BB machine again");
    } else {
      done.push("writes its access file when it next starts");
    }
    return `bb-box ${done.join(", ")}.`;
  }

  #boxEvent(box: Pick<BoxRecord, "id" | "threadId" | "name" | "backendLabel">, kind: BoxEventKind, by: Actor, words: string): void {
    try {
      this.#deps.events?.record({ box: box.id, thread: box.threadId, name: box.name, at: this.#now(), kind, by, words, backend: box.backendLabel });
    } catch (error) {
      this.#deps.logError("box log", error);
    }
  }

  async sweep(signal?: AbortSignal): Promise<void> {
    await this.recover(signal);
    for (const backend of this.#deps.backends.active()) await this.readBill(backend);
    await this.reconcile(signal);
    await this.outsideRestores(signal);
    await this.tidy(signal);
  }

  async restoreChecks(signal?: AbortSignal): Promise<DoctorCheck[]> {
    const ledger = this.#deps.ledger;
    if (ledger.problem) return [];
    const checks: DoctorCheck[] = [];
    for (const operation of ledger.unsettled()) {
      if (operation.kind !== "restore" || this.#running.has(operation.id)) continue;
      const box = await this.#deps.boxes.find(operation.box);
      const name = box?.name ?? operation.box;
      checks.push({
        id: `snapshots.restore.${name}`,
        name: `Restore of ${name}`,
        status: "fail",
        detail: `bb-box could not confirm ${operationWords(operation)} on box ${name}: ${operation.error ?? "it was cut short"}`,
        fix: "bb-box checks again at each sweep, and bb box sweep checks now. Until it can confirm the restore, it keeps the snapshots it used, and the box stays as the restore left it.",
      });
    }
    const ids = [...new Set(ledger.records().filter((record) => record.boxGone === null).map((record) => record.box.id))];
    for (const id of ids) {
      signal?.throwIfAborted();
      const box = await this.#deps.boxes.find(id);
      const backend = box?.guest ? this.#deps.backends.get(box.backend) : null;
      if (!box?.guest || !backend?.planSnapshots) continue;
      const plan = await backend.planSnapshots(box.guest, box.kind, null, signal).catch(() => null);
      if (!plan?.locked) continue;
      checks.push({
        id: `snapshots.locked.${box.name}`,
        name: `${box.name} locked`,
        status: "fail",
        detail: `${backend.label} left box ${box.name} locked (${plan.locked.lock}), so bb-box takes, deletes and restores none of its snapshots.`,
        fix: plan.locked.fix,
      });
    }
    return checks;
  }

  heldOn(backendId: string): HeldOnBackend | null {
    const held = this.#deps.ledger.records({ backend: backendId }).filter(heldByProvider);
    if (!held.length) return null;
    const known = held.filter((record) => record.size !== null);
    const bytes = known.reduce((sum, record) => sum + record.size!.bytes, 0);
    const size = known.length === held.length ? gbWords(bytes) : known.length ? `at least ${gbWords(bytes)}` : "an unknown size";
    const priced = held.filter((record) => record.price !== null);
    const price = priced.length ? `, ${priced.map((record) => priceWords(record.price)).join(" and ")}` : ", at no charge";
    const hosts = [...new Set(held.map(where))].join(" and ");
    return { count: held.length, words: `${held.length} ${held.length === 1 ? "snapshot" : "snapshots"} on ${hosts}, ${size}${price}` };
  }

  forgetBackend(backendId: string): SnapshotRecord[] {
    const ledger = this.#deps.ledger;
    const records = ledger.records({ backend: backendId });
    const now = this.#now();
    ledger.transaction(() => {
      for (const operation of ledger.unsettled()) {
        if (operation.snapshots.some((id) => records.some((record) => record.id === id))) ledger.updateOperation(operation.id, { state: "failed", endedAt: now, error: "Its backend's snapshots were forgotten." });
      }
      for (const record of records) ledger.removeRecord(record.id);
    });
    for (const thread of new Set(records.map((record) => record.box.thread))) this.#notify(thread);
    return records;
  }

  dispose(): void {
    this.#stopping.abort(new BoxError("restarting", "bb-box is stopping."));
  }
}

export function snapshotCount(ledger: SnapshotLedger, boxId: string): number {
  return ledger.records({ box: boxId }).filter(countsAgainstLimit).length;
}
