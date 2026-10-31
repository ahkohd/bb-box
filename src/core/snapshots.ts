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
  type HeldSnapshot,
  type OutsideRollback,
  type SnapshotHooks,
  type SnapshotPlan,
  type Snapshotting,
  type SnapshotStorage,
  type TaskKind,
  type TaskOutcome,
} from "../backends/types.ts";
import { BoxError, type BoxRecord, OPERATOR, identity, restoringWords, type RestoringMark } from "./boxes.ts";
import { describeSize } from "./sizes.ts";
import { readForkSafe } from "./identity.ts";
import { UNKNOWN_ACTOR, BY_OUTSIDE, byBbBox, type Actor, type BoxEventKind, type BoxLog } from "./box-log.ts";
import { ceilingOf, snapshotConfig, type SnapshotConfig } from "./document.ts";
import { ceilingVerdict, heldRate, pastCeiling, spentThisMonth, type HeldRate } from "./snapshot-cost.ts";
import {
  FAILED_KEPT_MS,
  LOST_AFTER_MISSING_MS,
  LOST_KEPT_MS,
  UNDOS_PER_BOX,
  countsAgainstLimit,
  dayWords,
  eligible,
  gbWords,
  heldByProvider,
  holdsWords,
  mayAct,
  nameProblem,
  newOperationId,
  newSnapshotId,
  noteProblem,
  NOT_THE_AGENTS,
  operationWords,
  priceWords,
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
  type SnapshotOperation,
  type SnapshotRecord,
  type Standing,
} from "./snapshot.ts";

const MiB = 1024 * 1024;
const ROOM_DELETES_PER_SWEEP = 5;
const OUTSIDE_LOOK_BACK_MS = 24 * 60 * 60_000;
const OUTSIDE_SLACK_MS = 60_000;

export type HoldStep = "planned" | "task" | "stopped" | "copied" | "undo" | "rolled-back" | "adopted" | "started";

export interface SnapshotBoxes {
  find(boxId: string): Promise<BoxRecord | null>;
  all(): Promise<BoxRecord[]>;
  inTurn<T>(boxId: string, task: () => Promise<T>): Promise<T>;
  update(box: Pick<BoxRecord, "threadId" | "id">, change: (current: BoxRecord) => Partial<BoxRecord>): Promise<BoxRecord | null>;
  writeAccess(box: BoxRecord, signal?: AbortSignal): Promise<void>;
  machineBack(box: BoxRecord): boolean;
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

export interface RestoreInput {
  readonly undo?: boolean;
  readonly force?: boolean;
  readonly request?: string;
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
  undoByCopy?(backendId: string): boolean;
  settings?(): SnapshotConfig;
  priced?(backend: Backend, offer: Snapshotting): Snapshotting;
  now?(): number;
  random?(bytes: number): Uint8Array;
  readonly timeZone?: string;
}

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
}

export interface DeleteAnswer {
  readonly snapshot: SnapshotRecord | null;
  readonly operation: SnapshotOperation | null;
  readonly repeated: boolean;
}

export interface HeldOnBackend {
  readonly count: number;
  readonly words: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
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
  "done",
] as const;
type RestoreStep = (typeof RESTORE_STEPS)[number];

function stepAt(step: string): number {
  const index = RESTORE_STEPS.indexOf(step as RestoreStep);
  return index < 0 ? 0 : index;
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
  done: "the end",
};

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

function consentOf(operation: SnapshotOperation): { readonly force: boolean; readonly anyway: readonly string[] } {
  const consent = operation.consent as { force?: unknown; anyway?: unknown } | null;
  return { force: consent?.force === true, anyway: Array.isArray(consent?.anyway) ? consent.anyway.filter((each): each is string => typeof each === "string") : [] };
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

interface Prepared {
  readonly box: BoxRecord & { readonly guest: Guest };
  readonly target: SnapshotRecord;
  readonly backend: Backend;
  readonly offer: Snapshotting;
  readonly plan: SnapshotPlan;
  readonly byCopy: boolean;
  readonly swap: boolean;
  readonly anyway: readonly string[];
  readonly forkSafe: number | null;
}

export interface RestoreCheck {
  readonly snapshot: SnapshotRecord;
  readonly box: BoxRecord;
  readonly swap: boolean;
  readonly undo: { readonly kind: "snapshot" | "held-copy"; readonly name: string; readonly aboutMs: number; readonly bytes: number | null } | null;
  readonly from: BoxSize | null;
  readonly to: BoxSize | null;
  readonly anyway: readonly string[];
  readonly leavesOnEarlierGuest: number;
  readonly replaces: string | null;
  readonly storage: string;
}

interface Restoring {
  readonly swap: boolean;
  readonly operation: SnapshotOperation;
  readonly target: SnapshotRecord;
  readonly undo: SnapshotRecord | null;
  readonly backend: Backend;
  readonly anyway: readonly string[];
  readonly from: BoxSize | null;
  readonly after: string;
}

type TaskSeen = TaskOutcome | { readonly state: "unreadable"; readonly words: string } | null;

function namesWords(names: readonly string[], hidden: number): string {
  const listed = names.map((name) => `"${name}"`).join(", ");
  if (!hidden) return listed;
  return `${listed}${listed ? ", " : ""}and ${hidden === 1 ? "one other" : `${hidden} others`} you cannot see`;
}

export class Snapshots {
  readonly #deps: SnapshotsDeps;
  readonly #now: () => number;
  readonly #random: (bytes: number) => Uint8Array;
  readonly #running = new Set<string>();
  readonly #outsideRunning = new Set<string>();
  readonly #outsideSince = new Map<string, number>();
  readonly #stopping = new AbortController();

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

  offerFor(backend: Backend | null | undefined, kind: string): Snapshotting | null {
    const offer = backend?.snapshotting?.(kind) ?? null;
    return offer && backend && this.#deps.priced ? this.#deps.priced(backend, offer) : offer;
  }

  paidOn(backendId: string): PaidOnBackend {
    const ledger = this.#deps.ledger;
    const held = heldRate(ledger.records({ backend: backendId }), backendId);
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
    const box = await this.#deps.boxes.find(boxId);
    if (!box) throw new BoxError("released", "That box was released, so it takes no snapshot.");
    const restoring = this.#restoreHolding(box);
    if (restoring) throw restoring;
    if ((box.state !== "ready" && box.state !== "stopped") || !box.guest) {
      throw new BoxError("not_ready", `Box ${box.name} is ${box.state}. bb-box takes a snapshot of a box that is running or stopped.`);
    }
    const backend = this.#deps.backends.get(box.backend);
    if (!backend) throw new BoxError("backend_off", `The ${box.backendLabel} backend that holds box ${box.name} is not in bb-box's settings, so it takes no snapshot of it.`);
    const offer = this.offerFor(backend, box.kind);
    if (!offer || !backend.snapshot || !backend.planSnapshots) throw new BoxError("unsupported", `${box.backendLabel} takes no snapshots of its ${box.kind} boxes.`);
    const memory = input.memory === true;
    if (memory && !offer.holds.includes("disk-and-memory")) throw new BoxError("unsupported", `${box.backendLabel} takes snapshots of a ${box.kind} box's disk only, so a snapshot of box ${box.name} cannot hold its memory. Leave memory out.`);
    if (!memory && !offer.holds.includes("disk")) throw new BoxError("unsupported", `Every snapshot ${box.backendLabel} takes of a ${box.kind} box holds its memory too. Ask for its memory.`);
    if (memory && box.state !== "ready") throw new BoxError("not_ready", `A snapshot with its memory needs box ${box.name} running, and it is stopped.`);
    this.#requireStore("takes");
    const plan = await backend.planSnapshots(box.guest, box.kind, null, this.#stopping.signal);
    if (plan.locked) throw new BoxError("locked", `${backend.label} left box ${box.name} locked (${plan.locked.lock}), so it takes no snapshot. ${plan.locked.fix}`);
    if (!plan.take.ok) throw new BoxError("unsupported", `bb-box cannot take a snapshot of box ${box.name} now: ${plan.take.why ?? `${backend.label} refused it.`}`);
    if (memory && !plan.take.memory) throw new BoxError("unsupported", `bb-box cannot take a snapshot of box ${box.name} with its memory: ${plan.take.memoryWhy ?? "its backend did not say where the memory would go."}`);
    const forkSafe = await this.#forkSafe(box, backend);
    const spends: { readonly storage: SnapshotStorage; readonly adds: number }[] = [{ storage: plan.storage, adds: plan.take.addsBytes ?? 0 }];
    if (memory && plan.take.memory) spends.push({ storage: plan.take.memory.storage, adds: plan.take.memory.addsBytes });
    const reserved = memory && plan.take.memory ? { storage: plan.take.memory.storage.key, bytes: plan.take.memory.addsBytes } : { storage: plan.storage.key, bytes: plan.take.addsBytes ?? 0 };
    const now = this.#now();
    const settings = this.settings;
    const id = newSnapshotId(this.#random);
    const operationId = newOperationId(this.#random);
    const admitted = ledger.transaction((): { refused: BoxError } | { repeat: SnapshotOperation } | { record: SnapshotRecord; operation: SnapshotOperation; counted: number } => {
      if (input.request) {
        const raced = ledger.byRequest(requestKey(by, input.request));
        if (raced) return raced.requestDigest === digest ? { repeat: raced } : { refused: reusedRequest(input.request) };
      }
      const ofBox = ledger.records({ box: box.id });
      const counted = ofBox.filter(countsAgainstLimit);
      if (counted.length >= settings.perBox) {
        const seen = counted.filter((record) => mayAct(caller, "see", standing, record).ok);
        return {
          refused: new BoxError(
            "limit_reached",
            `Box ${box.name} holds ${counted.length} snapshots, and your settings allow ${settings.perBox} a box. Delete one first: ${namesWords(seen.map((record) => record.name), counted.length - seen.length)}.`,
          ),
        };
      }
      for (const spend of spends) {
        const adds = spends.filter((other) => other.storage.key === spend.storage.key).reduce((sum, other) => sum + other.adds, 0);
        const room = this.#roomProblem(box, spend.storage, ledger.reservedBytes(spend.storage.key) + adds, memory, settings.roomPercent);
        if (room) return { refused: new BoxError("no_capacity", room) };
      }
      const paid = ceilingVerdict({
        change: "take",
        backend: backend.label,
        held: heldRate(ledger.records({ backend: backend.id }), backend.id),
        price: offer.price,
        bytes: memory && plan.take.memory ? plan.take.memory.addsBytes : (plan.take.addsBytes ?? null),
        ceiling: ceilingOf(settings, backend.id),
        byPerson: caller.is !== "agent",
      });
      if (!paid.ok) return { refused: new BoxError("limit_reached", paid.why) };
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
        forkSafe,
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
        consent: null,
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
      return { record, operation, counted: counted.length + 1 };
    });
    if ("refused" in admitted) throw admitted.refused;
    if ("repeat" in admitted) return this.#repeat(admitted.repeat);
    this.#notify(box.threadId);
    return this.#runTake(admitted.record, admitted.operation, box, backend, admitted.counted);
  }

  async #forkSafe(box: BoxRecord, backend: Backend): Promise<number | null> {
    if (box.state !== "ready" || box.capabilities.os !== "linux" || !box.guest) return null;
    try {
      const command = (await backend.transports(box.guest, box.kind)).command;
      return command ? await readForkSafe(command, this.#stopping.signal) : null;
    } catch (error) {
      if (this.#stopping.signal.aborted) throw error;
      this.#deps.log?.(`Could not read box ${box.name}'s identity reset at a take, so the snapshot is not fork-safe: ${message(error)}`);
      return null;
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
      const began = this.#now();
      let taken;
      try {
        taken = await backend.snapshot!(box.guest!, { id: record.id, box: box.id, memory: record.holds === "disk-and-memory" }, this.#hooks(operation), this.#stopping.signal);
      } catch (error) {
        if (this.#stopping.signal.aborted) throw error;
        throw this.#takeFailed(record, operation, error);
      }
      const now = this.#now();
      const ready = ledger.transaction(() => {
        const updated = ledger.updateRecord(record.id, { state: "ready", ref: taken.ref, holds: taken.holds, capturedAt: taken.capturedAt, size: taken.size, tookMs: now - began, stateAt: now, error: null });
        const done = ledger.updateOperation(operation.id, { state: "done", step: "done", endedAt: now, error: null });
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
          ledger.removeRecord(record.id);
          ledger.insertOperation(this.#settled(record, byBbBox("its box was released"), now));
          gone.push(record);
        }
      });
      for (const record of gone) if (heldByProvider(record)) this.#event(record, "snapshot-deleted", byBbBox("its box was released"), `"${record.name}" (${record.id}): it went with its box.`);
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

  holdsGuest(backendId: string, guestRef: string): string | null {
    const ledger = this.#deps.ledger;
    if (ledger.problem) return `bb-box cannot read its snapshots' records (${ledger.problem.replace(/\.$/, "")}), so it keeps every guest that may hold one`;
    const pins = ledger.pins();
    if (ledger.unsettled().some((operation) => operation.guests?.old?.ref === guestRef || operation.guests?.new?.ref === guestRef)) return "a restore that bb-box has not settled uses it";
    const held = ledger.records({ backend: backendId }).filter((record) => record.livesOn.ref === guestRef && (record.foundAt !== null || record.keptUntil !== null || record.guest !== "current" || pins.has(record.id)));
    if (!held.length) return null;
    const why = held.map((record) => (pins.has(record.id) ? "in use by an operation" : record.keptUntil !== null ? "kept" : record.guest === "held-copy" ? "a held copy" : record.guest === "earlier" ? "on an earlier guest" : "found and kept 7 days"));
    return `it holds ${held.length === 1 ? "a snapshot" : `${held.length} snapshots`} bb-box keeps: ${[...new Set(why)].join(", ")}`;
  }

  async restore(caller: Caller, box: BoxRecord, standing: Standing, ref: string, input: RestoreInput = {}): Promise<RestoreAnswer> {
    const by: Actor = caller.is === "agent" ? { is: "agent", threadId: caller.threadId } : caller;
    const target = this.find(caller, standing, ref);
    const allowed = mayAct(caller, "restore", standing, target);
    if (!allowed.ok) throw new BoxError("not_owner", allowed.why);
    if (caller.is === "agent" && input.undo === false) throw new BoxError("not_owner", `An agent's restore always takes an undo first. ${NOT_THE_AGENTS}`);
    if (caller.is === "agent" && input.force) throw new BoxError("not_owner", `Restoring past what a box would lose is the person's to do. ${NOT_THE_AGENTS}`);
    if (caller.is === "agent" && !this.settings.agentsRestore) throw new BoxError("not_owner", `Settings turn agents' restores off, so only the person restores box ${box.name}. ${NOT_THE_AGENTS}`);
    if (caller.is === "agent" && target.holds === "disk-and-memory" && !this.settings.agentsMemory) {
      throw new BoxError("not_owner", `Settings let only the person restore a snapshot that holds memory, as ${quoted(target)} does. ${NOT_THE_AGENTS}`);
    }
    this.#requireStore("restores");
    const digest = input.request ? requestDigest("restore", box.id, { snapshot: target.id, undo: input.undo !== false, force: input.force === true }) : null;
    if (input.request) {
      const earlier = this.#earlier(by, input.request, digest);
      if (earlier) return this.#restoredBefore(earlier);
    }
    return this.#deps.boxes.inTurn(box.id, () => this.#restore(caller, standing, box.id, target.id, input, by, digest));
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
    const { box, target, backend, offer, plan, byCopy, swap, anyway, forkSafe } = await this.#prepare(caller, standing, boxId, targetId, input);
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
          forkSafe,
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
        consent: { force: input.force === true, anyway },
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
    this.#event(target, "restore-asked", by, `To ${quoted(target)} (${target.id}), taken ${dayWords(target.takenAt)}; ${undo ? `an undo first, "${undo.name}"` : "no undo"}${past}.`);
    this.#notify(box.threadId);
    const mark: RestoringMark = { operation: operation.id, snapshot: target.id, name: target.name, at: now, ran: box.state === "ready" };
    await this.#deps.boxes.update(box, (current) => (current.state === "releasing" ? {} : { restoring: mark }));
    return this.#runRestore({ swap, operation, target, undo, backend, anyway, from: box.guest!.size, after: "" }, "planned");
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
    const offer = this.offerFor(backend, box.kind);
    if (!offer || offer.restore === "none" || !backend.planSnapshots || !backend.rollbackSnapshot || !backend.powerOff || !backend.start || !backend.snapshot) {
      throw new BoxError("unsupported", `${box.backendLabel} restores no snapshots of its ${box.kind} boxes.`);
    }
    if (target.box.id !== box.id) throw new BoxError("unsupported", `Snapshot ${quoted(target)} is of box ${target.box.name}, not ${box.name}.`);
    if (target.guest === "earlier") throw new BoxError("unsupported", `Snapshot ${quoted(target)} is on ${box.name}'s earlier guest, so it cannot be restored there, only forked.`);
    if (target.state !== "ready") throw new BoxError("not_ready", `Snapshot ${quoted(target)} is ${stateWords(target)}, so bb-box does not restore it.`);
    this.#requireStore("restores");
    const swap = target.guest === "held-copy";
    const plan = await backend.planSnapshots(box.guest, box.kind, swap ? null : { id: target.id, ref: target.ref ?? "", guest: target.livesOn }, this.#stopping.signal);
    const byCopy = this.#restoreOrder(box, backend, plan, target, swap) === "copy";
    const anyway = await this.#guarded(caller, standing, box, target, input.force === true);
    const forkSafe = input.undo === false ? null : await this.#forkSafe(box, backend);
    if (byCopy && input.undo !== false && forkSafe === null) {
      throw new BoxError(
        "unsupported",
        `bb-box would copy box ${box.name} in full as the undo of this restore, and it makes such a copy only of a box whose identity reset works now, so that a copy that started before it is disarmed gives up the box's identity. Box ${box.name} has none that bb-box could read${box.state === "ready" ? "" : ", as it is stopped"}.${caller.is === "agent" ? "" : " Restore without an undo, with --no-undo, or start the box first."}`,
      );
    }
    return { box: { ...box, guest: box.guest }, target, backend, offer, plan, byCopy, swap, anyway, forkSafe };
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
    if (room) return new BoxError("no_capacity", `bb-box would take an undo of box ${box.name} before restoring it, and ${room.charAt(0).toLowerCase()}${room.slice(1)}${instead}`);
    const paid = ceilingVerdict({
      change: "undo",
      backend: backend.label,
      held: heldRate(ledger.records({ backend: backend.id }), backend.id),
      price: offer.price,
      bytes: undoBytes || null,
      ceiling: ceilingOf(settings, backend.id),
      byPerson: caller.is !== "agent",
    });
    return paid.ok ? null : new BoxError("limit_reached", `bb-box would take an undo of box ${box.name} before restoring it. ${paid.why}${instead}`);
  }

  async checkRestore(caller: Caller, box: BoxRecord, standing: Standing, ref: string, input: RestoreInput = {}): Promise<RestoreCheck> {
    const target = this.find(caller, standing, ref);
    const allowed = mayAct(caller, "restore", standing, target);
    if (!allowed.ok) throw new BoxError("not_owner", allowed.why);
    const prepared = await this.#prepare(caller, standing, box.id, target.id, input);
    const undoBytes = this.#undoBytes(prepared.box, prepared.plan, prepared.byCopy);
    const refused = input.undo === false ? null : this.#undoRefused(caller, prepared.box, prepared.backend, prepared.offer, prepared.plan, undoBytes);
    if (refused) throw refused;
    const restore = prepared.plan.restore;
    const ofBox = this.#deps.ledger.records({ box: box.id });
    const onGuest = prepared.swap ? ofBox.filter((record) => record.guest === "current" && record.livesOn.ref === prepared.box.guest?.ref).length : 0;
    const undos = ofBox.filter((record) => record.undoOf !== null && record.keptUntil === null && heldByProvider(record));
    const replaces = input.undo !== false && undos.length + 1 > UNDOS_PER_BOX ? (undoToReplace(ofBox.filter((record) => record.id !== prepared.target.id), this.#deps.ledger.pins(), this.#now())?.name ?? null) : null;
    return {
      snapshot: prepared.target,
      box: prepared.box,
      swap: prepared.swap,
      undo:
        input.undo === false
          ? null
          : prepared.byCopy
            ? { kind: "held-copy", name: undoName(this.#now(), this.#deps.timeZone), aboutMs: restore.copyAboutMs ?? restore.undoAboutMs, bytes: undoBytes || null }
            : { kind: "snapshot", name: undoName(this.#now(), this.#deps.timeZone), aboutMs: restore.undoAboutMs, bytes: restore.undoBytes },
      from: prepared.box.guest?.size ?? null,
      to: prepared.swap ? null : restore.sizeBack,
      anyway: prepared.anyway,
      leavesOnEarlierGuest: onGuest,
      replaces,
      storage: prepared.plan.storage.name,
    };
  }

  #restoreOrder(box: BoxRecord, backend: Backend, plan: SnapshotPlan, target: SnapshotRecord, swap: boolean): "rollback" | "copy" {
    if (plan.locked) throw new BoxError("locked", `${backend.label} left box ${box.name} locked (${plan.locked.lock}), so bb-box restores nothing. ${plan.locked.fix}`);
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

  async #lookOn(box: BoxRecord, runsOn: boolean): Promise<{ readonly refusal: string | null; readonly losses: readonly string[] }> {
    const guard: RestoreGuard = this.#deps.guard ? await this.#deps.guard(box) : { threads: [], threadsUnread: null, control: false, terminals: 0 };
    if (guard.threads === null) {
      return { refusal: `bb-box could not tell which threads run on box ${box.name} (${(guard.threadsUnread ?? "BB did not answer").replace(/\.$/, "")}), so it restores nothing: a restore would take their work with it.`, losses: [] };
    }
    if (runsOn || guard.threads.length) {
      const who = guard.threads.length ? `${threadsWords(guard.threads)} ${guard.threads.length === 1 ? "runs" : "run"} on it` : "the thread asking runs on it";
      return {
        refusal: `Box ${box.name} is a box threads run on: ${who}. A restore would take their worktrees, uncommitted files and sessions there with it, and bb-box does not restore such a box yet: that stays off until bb-box can hold every turn on it while it restores. Move those threads off it, or archive them, first.`,
        losses: [],
      };
    }
    const losses: string[] = [];
    if (guard.control) losses.push("a person holds control of its desktop");
    if (guard.terminals === null) losses.push("bb-box could not tell whether a BB terminal is open on it");
    else if (guard.terminals > 0) losses.push(guard.terminals === 1 ? "a BB terminal is open on it" : `${guard.terminals} BB terminals are open on it`);
    return { refusal: null, losses };
  }

  async #guarded(caller: Caller, standing: Standing, box: BoxRecord, target: SnapshotRecord, force: boolean): Promise<string[]> {
    const seen = await this.#lookOn(box, standing.runsOn);
    if (seen.refusal) throw new BoxError("in_use", `${seen.refusal} bb-box changed nothing.`);
    const losses = [...seen.losses];
    if (losses.length && (caller.is === "agent" || !force)) {
      const fix = caller.is === "agent" ? "Ask the person to end it first, or to restore the box themselves." : "Restore anyway with --force.";
      throw new BoxError("in_use", `Restoring box ${box.name} to ${quoted(target)} would end what is on it now: ${losses.join("; ")}. ${fix} bb-box changed nothing.`);
    }
    return losses;
  }

  async #stillAdmitted(context: Restoring, box: BoxRecord): Promise<string | null> {
    const seen = await this.#lookOn(box, false);
    if (seen.refusal) return `Since the restore was asked: ${seen.refusal.charAt(0).toLowerCase()}${seen.refusal.slice(1)}`;
    const consented = new Set(consentOf(context.operation).anyway);
    const fresh = seen.losses.filter((loss) => !consented.has(loss));
    if (!fresh.length) return null;
    return `Since the restore was asked, something more would go with box ${box.name}'s disk: ${fresh.join("; ")}.${context.operation.by.is === "agent" ? "" : " Ask again, with --force if you mean it."}`;
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
      if (part !== undefined && part !== timed) {
        if (timed) took.push([timed, this.#now() - stepBegan]);
        timed = part;
        stepBegan = this.#now();
      }
      ledger.updateOperation(operation.id, { step, stepAt: this.#now(), ...(BEGINS_A_TASK.has(step) ? { task: null } : {}), ...also });
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
        await this.#deps.hold?.(operation, "stopped", signal);
      }
      if (undo && undo.guest === "current" && reach < stepAt("undo-ready")) {
        at("undo-submitting");
        const takenAt = this.#now();
        let taken;
        try {
          taken = await backend.snapshot!(guest, { id: undo.id, box: box.id, memory: false }, this.#stepHooks(operation, "undo"), signal);
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
            const passed = await backend.guestIdentity!(guest, signal);
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
            fresh = await backend.adoptCopy!(target.livesOn, identity(box, size), passed, hooks, signal);
          } catch (error) {
            if (signal.aborted) throw error;
            const words = sentence(message(error));
            await this.#discardAdoption(box, backend, ledger.operation(operation.id)?.guests?.new ?? null);
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
              if (record.guest === "current" && record.livesOn.ref === old.ref) ledger.updateRecord(record.id, { guest: "earlier", livesOn: old });
            }
            ledger.updateOperation(operation.id, { step: "swapped" });
          });
          at("swapped");
        }
        if (reach < stepAt("retired")) {
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
          if (accessFailed) return await this.#leftStopped(context, box, "access", accessFailedWords(accessFailed), true);
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
      if (timed) took.push([timed, this.#now() - stepBegan]);
      if (startParts.length) this.#deps.log?.(`Restored box ${box.name}: its start took ${startParts.join(", ")}.`);
      const now = this.#now();
      const done = ledger.transaction(() => ledger.updateOperation(operation.id, { state: "done", step: "done", endedAt: now, error: null }));
      box = await this.#moved(box, { restoring: null, state: "ready" });
      undo = undo ? ledger.record(undo.id) : null;
      const sized = sizeChangeWords(context.from, to);
      const left = context.swap ? ledger.records({ box: box.id }).filter((record) => record.guest === "earlier" && record.livesOn.ref === ledger.operation(operation.id)?.guests?.old?.ref).length : 0;
      const old = context.swap ? (ledger.operation(operation.id)?.guests?.old ?? null) : null;
      let gone = false;
      if (old && left === 0 && backend.deleteCopy) {
        gone = await backend.deleteCopy(old, signal).then(
          () => true,
          (error: unknown) => {
            this.#deps.log?.(`Could not delete box ${box!.name}'s earlier guest ${old.ref}, which holds no snapshot: ${message(error)}`);
            return false;
          },
        );
      }
      const swapped = context.swap
        ? gone
          ? `; a new guest made from its held copy runs the box now, and its old guest ${old!.ref}, which held no snapshot, is deleted`
          : `; a new guest made from its held copy runs the box now, and ${left === 1 ? "1 snapshot stays" : `${left} snapshots stay`} on its earlier guest: fork only`
        : "";
      this.#event(target, "restored", operation.by, `To ${quoted(target)} (${target.id}), taken ${dayWords(target.takenAt)}, in ${seconds(now - operation.startedAt)}${stepsWords(took)}${context.after}; ${undo ? `its undo is "${undo.name}"` : "no undo"}${swapped}${sized}.`);
      replaced.push(...(await this.#replaceUndos(box.id, target.id)));
      this.#notify(box.threadId);
      return { snapshot: ledger.record(target.id), undo, operation: done ?? operation, box, from: context.from, to, anyway: context.anyway, replaced, earlier: context.swap ? left : null, repeated: false };
    } finally {
      this.#running.delete(operation.id);
    }
  }

  #copyOf(undo: SnapshotRecord | null): Guest | null {
    return undo?.guest === "held-copy" && undo.ref !== null ? undo.livesOn : null;
  }

  async #discardAdoption(box: BoxRecord, backend: Backend, made: Guest | null): Promise<void> {
    if (!made) return;
    const current = (await this.#deps.boxes.find(box.id))?.guest?.ref ?? null;
    if (made.ref === current || this.#deps.ledger.records().some((record) => record.livesOn.ref === made.ref && record.backend.id === backend.id)) {
      this.#deps.log?.(`Left guest ${made.ref} of box ${box.name} alone: it is the box's guest, or a snapshot lives on it, so it is not a new guest made part way.`);
      return;
    }
    await backend.release(made, { resetting: async () => {}, timing: () => {} }, this.#stopping.signal).catch((cause: unknown) => this.#deps.logError(`delete the part-made guest ${made.ref} of box ${box.name}`, cause));
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
    const context: Restoring = { swap: target.guest === "held-copy", operation, target, undo, backend, anyway: [], from: null, after };
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
      if (step !== "adopt-claimed") {
        const task = await this.#taskOf(operation, backend, target.livesOn, signal, "copy");
        if (task?.state === "unreadable") return unsure(`It was making the box's new guest, and bb-box could not read the copy's task: ${sentence(task.words)}`);
        if (task?.state === "running") return unsure("It was making the box's new guest, and Proxmox's copy was still running when bb-box looked.");
      }
      await this.#discardAdoption(box, backend, fresh);
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
    const settledHere = waiting.length ? await this.#recoverWaiting(waiting, signal) : 0;
    await this.#clearStaleMarks();
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
      const byId = new Map(listing.map((held) => [held.id, held]));
      for (const operation of operations) {
        try {
          if (await this.#deps.boxes.inTurn(operation.box, () => this.#recoverOne(operation.id, backend, byId, signal))) settled++;
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
        const restoring = operation.kind === "restore";
        const candidates = (await backend.findTasks(guest, kind, restoring ? (operation.stepAt ?? operation.startedAt) : operation.startedAt, signal)).filter((candidate) => !this.#deps.ledger.operationWithTask(candidate.ref));
        if (restoring && candidates.length > 1) return { state: "unreadable", words: `${backend.label} lists ${candidates.length} tasks that could be this step's, so bb-box cannot tell which is` };
        ref = candidates[0] ?? null;
      } catch (error) {
        if (signal?.aborted) throw error;
        return { state: "unreadable", words: message(error) };
      }
      if (ref) this.#deps.ledger.updateOperation(operation.id, { step: operation.step.replace(/submitting$/, "task"), task: ref });
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

  async #recoverOne(operationId: string, backend: Backend, byId: ReadonlyMap<string, HeldSnapshot>, signal?: AbortSignal): Promise<boolean> {
    const ledger = this.#deps.ledger;
    const operation = ledger.operation(operationId);
    if (!operation || (operation.state !== "running" && operation.state !== "unknown") || this.#running.has(operation.id)) return false;
    if (operation.kind === "restore") return this.#recoverRestore(operation, backend, byId, signal);
    const record = ledger.record(operation.snapshots[0] ?? "");
    const now = this.#now();
    if (!record) {
      ledger.updateOperation(operation.id, { state: "failed", endedAt: now, error: "Its snapshot's record is gone." });
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
        const updated = ledger.transaction(() => {
          const ready = ledger.updateRecord(record.id, { state: "ready", ref: found.ref, holds: found.holds, capturedAt: found.takenAt ?? record.takenAt, stateAt: now, error: null });
          ledger.updateOperation(operation.id, { state: "done", step: "done", endedAt: now, error: null });
          return ready;
        });
        this.#event(updated ?? record, "snapshot-taken", record.by, `"${record.name}" (${record.id}): ${holdsWords({ holds: found.holds, scope: record.scope })}, confirmed ${after}.`);
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
      this.#reconcileWith(backend, listing, listedAt, boxes);
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

  #reconcileWith(backend: Backend, listing: readonly HeldSnapshot[], listedAt: number, boxes: ReadonlyMap<string, BoxRecord>): void {
    const ledger = this.#deps.ledger;
    const pins = ledger.pins();
    const now = this.#now();
    const found = new Map(listing.map((held) => [held.id, held]));
    const touched = new Set<string>();
    for (const record of ledger.records({ backend: backend.id })) {
      if (pins.has(record.id) || record.stateAt >= listedAt || ledger.changedSince(record.id, listedAt)) continue;
      const held = found.get(record.id);
      if (held) {
        const state = held.state === "complete" ? "ready" : held.state === "incomplete" ? "incomplete" : record.state;
        const back = record.boxGone && boxes.has(record.box.id) ? { boxGone: null } : {};
        const change = {
          ...(state !== record.state ? { state, stateAt: now, error: held.state === "incomplete" ? (held.words ?? null) : null } : {}),
          ...(record.missingSince !== null ? { missingSince: null } : {}),
          ...(record.ref === null ? { ref: held.ref } : {}),
          ...(record.storage === null && held.storage ? { storage: held.storage } : {}),
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
    for (const held of listing) {
      if (held.state === "in-progress" || ledger.record(held.id) || ledger.changedSince(held.id, listedAt)) continue;
      const restored = this.#recordAgain(backend, held, boxes.get(held.box) ?? null, now);
      ledger.insertRecord(restored);
      touched.add(restored.box.thread);
      this.#deps.log?.(
        restored.foundAt !== null
          ? `Found snapshot ${held.id} of box ${held.box} on ${restored.host ?? backend.label}, which is not in bb-box's records and whose box is gone. It is listed for 7 days, then deleted.`
          : `Found snapshot ${held.id} of box ${restored.box.name} on ${restored.host ?? backend.label} without a record, and gave it one again${restored.keptUntil !== null ? ", as kept" : ""}.`,
      );
    }
    for (const thread of touched) this.#notify(thread);
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
        : { id: held.box, name: owner?.name ?? held.box, kind: owner?.kind ?? "unknown", system: "unknown", thread: owner?.threadId ?? "unknown" },
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
      price: null,
      owner: kept || (live ? box.threadId === OPERATOR : owner?.threadId === OPERATOR) ? "person" : "thread",
      keptUntil: kept ? held.keptUntil : null,
      keptAt: null,
      undoOf: null,
      forkSafe: null,
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
      if (eligible(record, "remove-found", { pin: null, now }).ok) {
        automatic.push({ record, change: "remove-found", by: byBbBox(`it was found on ${where(record)}, not in bb-box's records, 7 days ago`) });
        continue;
      }
      if (eligible(record, "expire", { pin: null, now }).ok) automatic.push({ record, change: "expire", by: byBbBox("its keep ended") });
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
