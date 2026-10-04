// Each thread's boxes: the registry in plugin storage and every step of a
// box's life. The registry never names a provider or a transport; it works
// through the Backend interface and the box's command transport.
//
// `acquire` records the box and returns at once; the backend acquires it in
// the background and the box is ready when its command transport answers. A
// box lives until someone releases it or its thread is archived or deleted:
// nothing expires. The sweep is the safety net for missed thread events and
// finishes work that a restart interrupted.
//
// A kind can keep spare boxes (032): boxes of the thread SPARES, made at the
// kind's default size and enrolled ahead like any other. An acquire of the
// kind at that size claims one, which moves its record to the thread, and
// core makes another in the background.
//
// Storage keys: box/<threadId>/<boxId> holds a BoxRecord, and index/<boxId>
// holds the thread ID, so a box can be found by its ID alone.

import { foldName, providerKeys, providerName } from "./provider-name.ts";
import { randomBytes } from "node:crypto";
import type { OfferedKind } from "../backends/index.ts";
import { currentKindId, featureWord, isEarlierKindId, kindRequest } from "../backends/kinds.ts";
import {
  BackendError,
  type AcquireHooks,
  type Backend,
  type BackendStorage,
  type BoxIdentity,
  type BoxKind,
  type BoxSize,
  type BoxTransports,
  type Capacity,
  type Guest,
  type HeldGuest,
  type KindCapabilities,
  type MachineNature,
  type PowerState,
  type ReleaseHooks,
  type StopReason,
} from "../backends/types.ts";
import { TransportError, type CommandTransport, type RunResult } from "../transports/types.ts";
import type { GeneralConfig } from "./config.ts";
import type { ImageConfig } from "./document.ts";
import { quote } from "../transports/process.ts";
import { command, envScript, jobScript, timedOutExits, type Access, type Session } from "./in-box.ts";
import { generateName, isFriendlyName } from "./names.ts";
import { chooseSize, defaultSize, kindSizes, sameSize, type SizeRequest } from "./sizes.ts";

export type BoxState =
  /** Recorded; the backend is making or claiming the guest. */
  | "acquiring"
  /** The guest exists and is booting. */
  | "starting"
  /** The command transport answers. */
  | "ready"
  | "stopping"
  | "stopped"
  /** The acquire failed. The backend released what it had claimed. */
  | "failed"
  /** The guest was deleted outside bb-box. */
  | "gone"
  | "releasing";

/** "box" is acquired by a tool or the panel; "machine" is a thread's own BB machine. */
export type BoxRole = "box" | "machine";
export type EnrolState = "off" | "enrolling" | "enrolled" | "failed";

/** A box's project's image (049): its name, and its script's run at start, or the baked build it started from. */
export interface BoxImage {
  readonly name: string;
  readonly state: "pending" | "running" | "done" | "failed" | "baked";
  /** How long its script and check took, once done. */
  readonly seconds?: number;
  /** For a baked image: the build's ID, and its reference, which the box starts from. */
  readonly build?: string | null;
  readonly from?: string;
}

/** Reads /etc/environment, where an image's script sets the box's PATH and variables, as a new session would (049). */
export const LOAD_ENVIRONMENT = "set -a; [ ! -r /etc/environment ] || . /etc/environment; set +a;";

/** How long an image's script may run at start (049), and its check. */
const IMAGE_SCRIPT_MS = 30 * 60_000;
const IMAGE_CHECK_MS = 10 * 60_000;
/** Lines of a failed script's output an acquire's error gives (049). */
const IMAGE_LINES = 20;
/** Where an image's files go in the box while they run. */
const IMAGE_DIR = ".bb-box-image";

export interface BoxRecord {
  readonly id: string;
  readonly threadId: string;
  readonly projectId: string | null;
  /** Friendly name, unique within the thread. */
  readonly name: string;
  readonly kind: string;
  readonly kindLabel: string;
  /** The features every offer of the kind has, and those an alias asked for (041). */
  readonly requires: readonly string[];
  /** The offer's capabilities when the box was acquired. Its features may add to `requires`. */
  readonly capabilities: KindCapabilities;
  readonly backend: string;
  readonly backendLabel: string;
  readonly nature: MachineNature;
  readonly role: BoxRole;
  /**
   * The size asked for (028). Absent for a box recorded before sizes, which
   * was made at what is now the default preset, and for a restored box,
   * whose guest says its size.
   */
  readonly size?: BoxSize;
  /** Set by the backend's claim, before it makes or changes anything. */
  readonly guest: Guest | null;
  readonly state: BoxState;
  /** Why the box failed, or what went wrong with its last change. */
  readonly error: string | null;
  readonly createdAt: number;
  readonly readyAt: number | null;
  readonly releaseRequestedAt: number | null;
  /** When a real backend began resetting the machine, during release. */
  readonly resetAt: number | null;
  /**
   * When the sweep restored the box's lost record from its guest, until the
   * box starts enrolling again. A box restored stopped, or whose guest did
   * not answer, enrols when bb-box starts it or the sweep finds it answering (026).
   */
  readonly restoredAt?: number | null;
  /** Milliseconds per acquire step, "total" from request to ready, and "release.<step>" after a failed release. */
  readonly timings: Readonly<Record<string, number>>;
  readonly enrol: { readonly state: EnrolState; readonly hostId: string | null; readonly error: string | null };
  /** Its project's image (049), whose script runs as root as the box starts, before it is handed over. */
  readonly image?: BoxImage | null;
  /** The last time the box's guest stopped without bb-box's request (#406). A stop bb-box makes forgets it. */
  readonly unrequestedStop?: UnrequestedStop | null;
}

/** A stop bb-box did not make, why, and what bb-box did about it (#406). */
export interface UnrequestedStop {
  /** When the guest stopped, or when bb-box found it stopped. */
  readonly at: number;
  /** The backend's words, or null when it cannot tell. */
  readonly reason: string | null;
  /** The guest did not choose it, as when its VM crashed. */
  readonly crashed: boolean;
  /** When bb-box started the box again, and the error when that failed. */
  readonly restart: { readonly at: number; readonly error: string | null } | null;
}

/**
 * bb-box starts a box whose VM crashed again (#406), unless it did so for
 * the stop before less than this long before, so a VM that keeps crashing
 * stays stopped.
 */
export const RESTART_GAP_MS = 10 * 60_000;

function utc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** Why the box last stopped without bb-box's request, and what bb-box did, in words (#406); empty when it has not. */
export function stopWords(box: BoxRecord): string {
  const stop = box.unrequestedStop;
  if (!stop) return "";
  const words = [`It stopped without a request from bb-box at ${utc(stop.at)}.`, stop.reason ? sentence(stop.reason) : "Its backend does not record why."];
  if (stop.restart?.error) words.push(`bb-box could not start it again: ${sentence(stop.restart.error)}`);
  else if (stop.restart) words.push(box.state === "ready" ? `bb-box started it again at ${utc(stop.restart.at)}.` : "bb-box is starting it again.");
  else if (stop.crashed) words.push(`bb-box left it stopped, as it had started it again after a stop less than ${RESTART_GAP_MS / 60_000} minutes before.`);
  return words.join(" ");
}

/** Whether bb-box is starting the box again after a stop it did not make (#406). */
function restarting(box: BoxRecord): boolean {
  return !!box.unrequestedStop?.restart && !box.unrequestedStop.restart.error;
}

/**
 * What BB says of a thread: "ended" when it returns the thread archived or
 * deleted, "missing" when it says there is no such thread, and "unknown" on
 * any other error.
 */
export type ThreadLiveness = "live" | "ended" | "missing" | "unknown";

/** BB's answer for a thread, with what it said as it came, for the log. */
export interface ThreadAnswer {
  readonly state: ThreadLiveness;
  readonly said: string;
}

/** The thread of spare boxes, which no thread owns yet (032). BB's thread IDs never take this form. */
export const SPARES = "spare";

/** The thread of your machines: boxes you own, kept as BB machines (036). BB's thread IDs never take this form either. */
export const OPERATOR = "operator";

/** Whether boxes of `threadId` belong to a thread, as opposed to the spares or your machines. */
export function ownedByThread(threadId: string): boolean {
  return threadId !== SPARES && threadId !== OPERATOR;
}

/** A name for one of your machines: a hostname label, as it is also its BB machine's name (036). */
const MACHINE_NAME = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function isMachineName(name: string): boolean {
  return MACHINE_NAME.test(name);
}

/** The name of a box's BB machine. A spare's says it is one. */
export function machineName(box: Pick<BoxRecord, "name" | "threadId">): string {
  return box.threadId === SPARES ? `${box.name} (spare)` : box.name;
}

export interface BoxesDeps {
  readonly kv: BackendStorage;
  readonly backends: {
    get(id: string): Backend | null;
    active(): Backend[];
    kinds(): OfferedKind[];
    /** The driver's label for a backend ID, as settings names it ("Proxmox LXC"), for a provider's name (044). */
    driverLabel?(id: string): string;
    /** The built backends that are on, so an `on` naming one that is off is told so (044). */
    on?(): Backend[];
  };
  general(): Promise<GeneralConfig>;
  /** The image a project's boxes of a kind get (049), or image `name` when it covers the kind, from the configuration, or null. */
  image?(projectId: string | null, kind: string, name?: string): { readonly name: string; readonly image: ImageConfig } | null;
  /** A current baked build of an image for a kind on a backend whose images start boxes from builds (049), or null. */
  baked?(name: string, backend: string, kind: string): Promise<{ readonly ref: string; readonly build: string | null } | null>;
  /**
   * Commands an image's script may call, as this bb-box has them, put first
   * on its PATH at start: bb-box-feature, for boxes of images built before
   * standard images had it (049).
   */
  readonly imageTools?: Readonly<Record<string, string>>;
  /** Says a box of an image is ready, whether its script ran at start or it started baked, for baking when used (049). */
  imageReady?(box: BoxRecord): void;
  /** Tells panels and tools that a thread's boxes changed. */
  notify(threadId: string): void;
  /** A box's record was written, or deleted when `deleted` is true. */
  recorded?(box: BoxRecord, deleted: boolean): void;
  /**
   * Whether a thread still exists and is not archived, as BB says. The sweep
   * releases the thread's boxes and guests once BB says at two sweeps running
   * that it ended or that there is no such thread.
   */
  thread(threadId: string): Promise<ThreadAnswer>;
  /** A thread's project, for a box the sweep restores from its guest. */
  projectOf?(threadId: string): Promise<string | null>;
  /**
   * The ID of BB's machine that a box is for its thread, as a "New box"
   * (033), or null when it is none. The sweep asks it for a box it restores.
   */
  machineOf?(boxId: string): Promise<string | null>;
  /**
   * Enrols a ready box as a BB machine, with the box ID as the key. With
   * `restored`, the sweep restored the box and bb-box has just found it
   * answering, so its enrolment counts from now. Called without awaiting.
   */
  enrol?(box: BoxRecord, options?: { restored?: boolean }): Promise<void>;
  /** Removes a box's BB machine. Awaited before the backend releases the box. */
  unenrol?(box: BoxRecord): Promise<void>;
  /**
   * Starts an enrolled box's BB daemon again after bb-box started the box:
   * BB's bootstrap with the box ID as the key. Commands wait for it a while.
   */
  reconnect?(box: BoxRecord): Promise<void>;
  /**
   * A thread, neither archived nor deleted, on a spare's BB machine, or
   * null. A claim skips such a spare, and the spare upkeep makes it yours
   * (036): someone started a thread on it from BB's picker.
   */
  spareThread?(box: BoxRecord): Promise<string | null>;
  /**
   * Gives a claimed spare's BB machine the box's name, and says whether BB
   * shows it disconnected, so it must reconnect. Commands wait a while only
   * for that reconnect, as after a start.
   */
  claimed?(box: BoxRecord): Promise<boolean>;
  /**
   * Which of BB's variables commands in a box enrolled as a BB machine take
   * from its daemon, so they have the thread's access. Null for none.
   */
  access?(box: BoxRecord): Promise<Access | null>;
  logError(operation: string, error: unknown): void;
  /** Records what the sweep did to a guest, and what became of spares, and why. */
  log?(message: string): void;
  /** How long a command waits for its box to finish enrolling, or reconnecting after a start. */
  readonly enrolWaitMs?: number;
  now?(): number;
  random?(bytes: number): Uint8Array;
}

export type BoxErrorCode =
  | "not_found"
  | "unknown_provider"
  | "unknown_kind"
  | "invalid_size"
  | "limit_reached"
  | "no_capacity"
  | "not_ready"
  | "unsupported"
  | "backend_off"
  | "released"
  | "unreachable"
  /** A thread runs on the box's BB machine. */
  | "in_use"
  /** A name for one of your machines that is not a hostname label, or is taken. */
  | "invalid_name"
  /** The box this thread runs on belongs to another owner, who releases or stops it (036). */
  | "not_owner"
  /** bb-box is stopping, as for an update, and takes no new commands (#405). */
  | "restarting";

/** A job a box_run command left running when bb-box restarted (#405). */
export type JobResult =
  | { readonly state: "ended"; readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly truncated: boolean }
  | { readonly state: "running"; readonly stdout: string; readonly stderr: string };

export class BoxError extends Error {
  readonly code: BoxErrorCode;
  constructor(code: BoxErrorCode, message: string) {
    super(message);
    this.name = "BoxError";
    this.code = code;
  }
}

/** #choose finding no offer for a box, with the backends that had no room: only their spares give room (#282). */
/** What `on` named (044): the offers to try, in acquire order; why each named provider that is off was passed over; and every provider named. */
interface Named {
  readonly offers: OfferedKind[];
  readonly out: string[];
  readonly ids: ReadonlySet<string>;
}

class Unplaced extends BoxError {
  readonly full: readonly string[];
  constructor(code: BoxErrorCode, message: string, full: readonly string[]) {
    super(code, message);
    this.full = full;
  }
}

/** The storage key of the cold-start history, see `typicalReady`. */
const READY_HISTORY = "ready-history";
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function newBoxId(random: (bytes: number) => Uint8Array): string {
  return `bx${[...random(12)].map((byte) => ID_ALPHABET[byte % 32]).join("")}`;
}

/** Boxes that count against the per-thread limit and hold resources. */
export function isActive(box: BoxRecord): boolean {
  return box.state !== "failed" && box.state !== "gone" && box.state !== "releasing";
}

/** A box as the log names it. */
function describeBox(box: Pick<BoxRecord, "name" | "threadId">): string {
  return box.threadId === SPARES ? `spare box ${box.name}` : `box ${box.name} of thread ${box.threadId}`;
}

function isAcquiring(box: BoxRecord): boolean {
  return box.state === "acquiring" || box.state === "starting";
}

/** What a guest's power says about a box that is settled, or moving when `moving`: the change, empty for none. */
function observed(current: BoxRecord, power: PowerState | null, moving = false): Partial<BoxRecord> {
  const settled = current.state === "ready" || current.state === "stopped" || current.state === "gone";
  const started = (current.state === "stopping" || current.state === "starting") && current.readyAt !== null;
  if (!settled && !(moving && started)) return {};
  if (power === null) return { state: "gone", error: "The guest was deleted outside bb-box." };
  // The provider cannot tell, for example a machine that does not answer: keep what we know.
  if (power === "unknown") return {};
  const state = power === "running" ? "ready" : "stopped";
  return current.state === state ? {} : { state, error: null };
}

export function identity(box: BoxRecord, size: BoxSize): BoxIdentity {
  return { boxId: box.id, threadId: box.threadId, name: box.name, kind: box.kind, createdAt: box.createdAt, size, ...(box.image?.from ? { from: box.image.from } : {}) };
}

/** The message a user sees for an error: bb-box's and backends' own messages as they are. */
export function describeError(error: unknown, action: string): string {
  if (error instanceof BoxError || error instanceof BackendError || error instanceof TransportError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  return `${action} failed: ${message}`;
}

/** `text` ending with a full stop, so another sentence can follow it. */
function sentence(text: string): string {
  return /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}

/** Waits for `promise`, which never rejects, for up to `ms`, or until `signal` aborts. */
function within(promise: Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener("abort", done, { once: true });
    void promise.then(done);
    if (signal?.aborted) done();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

/** Capabilities for a guest whose kind no backend offers any more: it can only be released. */
const UNKNOWN_KIND: KindCapabilities = {
  os: "linux",
  arch: "x86_64",
  gpu: false,
  features: [],
  command: null,
  displays: [],
  computerUse: null,
  enrol: false,
};

/** How much longer than the timeout in the box bb-box waits before it stops the command itself. */
const LOCAL_TIMEOUT_GRACE_MS = 10_000;
const ENROL_POLL_MS = 250;
/** Long enough for a Mac box's enrolment, which takes 8 to 10 s from ready. */
const ENROL_WAIT_MS = 20_000;

/** For releases whose progress nobody watches: leftovers the sweep finds, and guests whose box was forgotten. */
const QUIET: ReleaseHooks = { resetting: async () => {}, timing: () => {} };

/** The error of a box restored running whose guest did not answer. The sweep clears it once the guest answers. */
const SILENT = "Its guest was running but did not answer when bb-box restored the box's lost record. Stop and start it if commands fail.";

/** Whether a box or offer with `capabilities` has every one of `features`. */
export function hasFeatures(capabilities: Pick<KindCapabilities, "features">, features: readonly string[]): boolean {
  return features.every((feature) => capabilities.features.includes(feature));
}

/** The features a box has beyond what its kind promises. */
export function extraFeatures(box: Pick<BoxRecord, "requires" | "capabilities">): string[] {
  return box.capabilities.features.filter((feature) => !box.requires.includes(feature));
}

const recordKey = (threadId: string, boxId: string) => `box/${threadId}/${boxId}`;
const indexKey = (boxId: string) => `index/${boxId}`;

class Queue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(task, task);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

export interface SweepReport {
  /** Boxes released because their thread ended. */
  readonly released: number;
  /** Guests released that no box owns. */
  readonly leftovers: number;
  /** Records restored from guests whose record was lost. */
  readonly adopted: number;
  /** Guests with no record whose thread BB did not confirm, kept for the next sweep. */
  readonly kept: number;
  /** Boxes and guests whose thread BB said ended at this sweep but not the last, kept for the next. */
  readonly ending: number;
  /** Acquires and releases a restart interrupted, carried on. */
  readonly resumed: number;
}

export class Boxes {
  readonly #deps: BoxesDeps;
  readonly #now: () => number;
  readonly #random: (bytes: number) => Uint8Array;
  /** Serialises capacity checks, so two acquires never take the same room. */
  readonly #admission = new Queue();
  readonly #threads = new Map<string, Queue>();
  /** The latest task per box: acquire, stop, start, release. Tasks for one box run in turn. */
  readonly #work = new Map<string, Promise<unknown>>();
  /** Acquires running in this process, so a release can cancel them. */
  readonly #acquiring = new Map<string, AbortController>();
  /** Reconnects of BB machines after a start or a claim in this process, while they run. */
  readonly #reconnects = new Map<string, Promise<void>>();
  /** By box, the jobs whose results bb-box has, which its next command removes, and whether a command has pruned old ones since this process started (#405). */
  readonly #jobs = new Map<string, { readonly received: Set<string>; pruned: boolean }>();
  /** The run of keepSpares in progress, and whether a call asked for another after it. */
  #keeping: Promise<void> | null = null;
  #keepAgain = false;
  /** The threads BB said had ended at the last sweep. */
  #ending = new Set<string>();
  #disposed = false;

  constructor(deps: BoxesDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#random = deps.random ?? ((bytes) => randomBytes(bytes));
  }

  #locked<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    let queue = this.#threads.get(threadId);
    if (!queue) this.#threads.set(threadId, (queue = new Queue()));
    return queue.run(task);
  }

  /** Runs `task` after the box's earlier tasks settle. */
  #chain<T>(boxId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#work.get(boxId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.#work.set(boxId, settled);
    void settled.then(() => {
      if (this.#work.get(boxId) === settled) this.#work.delete(boxId);
    });
    return next;
  }

  async #read(threadId: string, boxId: string): Promise<BoxRecord | null> {
    const box = await this.#deps.kv.get<BoxRecord>(recordKey(threadId, boxId));
    return box ? this.#current(box) : null;
  }

  /** A stored record with its kind's current ID and label, when the kind was renamed (027). */
  #current(box: BoxRecord): BoxRecord {
    if (!isEarlierKindId(box.kind)) return box;
    const kind = currentKindId(box.kind);
    return { ...box, kind, kindLabel: this.kinds().find((candidate) => candidate.id === kind)?.label ?? box.kindLabel };
  }

  async #write(box: BoxRecord): Promise<BoxRecord> {
    await this.#deps.kv.set(recordKey(box.threadId, box.id), box);
    this.#deps.recorded?.(box, false);
    this.#deps.notify(box.threadId);
    return box;
  }

  async #forget(box: BoxRecord): Promise<void> {
    await this.#deps.kv.delete(recordKey(box.threadId, box.id));
    await this.#deps.kv.delete(indexKey(box.id));
    this.#deps.recorded?.(box, true);
    this.#deps.notify(box.threadId);
  }

  /** Applies a change to the stored record. Null when the box is gone. */
  update(box: Pick<BoxRecord, "threadId" | "id">, change: (current: BoxRecord) => Partial<BoxRecord>): Promise<BoxRecord | null> {
    return this.#locked(box.threadId, async () => {
      const current = await this.#read(box.threadId, box.id);
      if (!current) return null;
      return this.#write({ ...current, ...change(current) });
    });
  }

  async list(threadId: string): Promise<BoxRecord[]> {
    return this.#load(await this.#deps.kv.list(`box/${threadId}/`));
  }

  async all(): Promise<BoxRecord[]> {
    return this.#load(await this.#deps.kv.list("box/"));
  }

  async #load(keys: string[]): Promise<BoxRecord[]> {
    const boxes = await Promise.all(keys.map((key) => this.#deps.kv.get<BoxRecord>(key)));
    return boxes
      .filter((box): box is BoxRecord => !!box)
      .map((box) => this.#current(box))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  /** A box by ID alone. */
  async find(boxId: string): Promise<BoxRecord | null> {
    const threadId = await this.#deps.kv.get<string>(indexKey(boxId));
    return threadId ? this.#read(threadId, boxId) : null;
  }

  /** A thread's box by ID or friendly name. */
  async get(threadId: string, ref: string): Promise<BoxRecord> {
    const boxes = await this.list(threadId);
    const box = boxes.find((candidate) => candidate.id === ref) ?? boxes.find((candidate) => candidate.name === ref);
    if (!box) {
      const names = boxes.map((candidate) => candidate.name).join(", ");
      throw new BoxError("not_found", `This thread has no box "${ref}".${names ? ` Its boxes are: ${names}.` : " It has no boxes."}`);
    }
    return box;
  }

  /** The kinds the active backends offer, once each. */
  kinds(): BoxKind[] {
    const seen = new Set<string>();
    return this.#deps.backends
      .kinds()
      .map((offered) => offered.kind)
      .filter((kind) => !seen.has(kind.id) && !!seen.add(kind.id));
  }

  /**
   * Records a new box and starts acquiring it. Returns at once, once a
   * backend has said the box fits; the box is ready when its command
   * transport answers.
   */
  async acquire(input: {
    threadId: string;
    projectId: string | null;
    kind: string;
    size?: SizeRequest;
    role?: BoxRole;
    name?: string;
    on?: string | readonly string[];
    /** An image's name, or "standard" (049). The project's image for the kind when left out. */
    image?: string;
  }): Promise<BoxRecord> {
    const requested = this.#now();
    const { kind: wanted, features } = kindRequest(input.kind);
    const ofKind = this.#deps.backends.kinds().filter((candidate) => candidate.kind.id === wanted);
    // An alias takes only the offers that have its features (041).
    const everywhere = ofKind.filter((candidate) => hasFeatures(candidate.kind.capabilities, features));
    if (!ofKind.length) {
      const kinds = this.kinds().map((kind) => kind.id);
      throw new BoxError(
        "unknown_kind",
        kinds.length
          ? `There is no "${input.kind}" kind. The kinds are: ${kinds.join(", ")}.`
          : "No backend is set up, so there are no boxes to acquire. Set one up in bb-box's settings.",
      );
    }
    if (!everywhere.length) {
      const lacking = features.map(featureWord).join(" or ");
      const from = [...new Set(ofKind.map((candidate) => candidate.backend.label))].join(" and ");
      throw new BoxError("unknown_kind", `No backend offers ${input.kind} now: ${wanted} boxes from ${from} have no ${lacking}. Ask for ${wanted} if the box can do without it.`);
    }
    // The named providers are the only ones tried, in acquire order (044).
    const named = input.on !== undefined ? this.#on(input.on, input.kind, everywhere) : null;
    const offered = named ? named.offers : everywhere;
    const role = input.role ?? "box";
    const yours = input.threadId === OPERATOR;
    if (yours) {
      if (input.name !== undefined && !isMachineName(input.name)) {
        throw new BoxError("invalid_name", `Name a machine with a lower-case letter first, then letters, digits and "-", up to 32, not ending in "-". "${input.name}" is not one.`);
      }
      const kind = everywhere[0]!.kind;
      if (!kind.capabilities.enrol) throw new BoxError("unsupported", `A ${kind.label} box cannot become a BB machine, so it cannot be one of your machines.`);
    }
    // Spares and your machines are outside the per-thread limit.
    const owned = role === "box" && ownedByThread(input.threadId);
    const claimsSpare = role === "box" && input.threadId !== SPARES;
    const general = await this.#deps.general();
    // The image chosen, or the project's for the kind (049): a thread's own box too, not one of your machines unless chosen. Such a box is made, not a spare, for now.
    const image =
      input.image === "standard" ? null : input.image !== undefined ? (this.#deps.image?.(input.projectId, wanted, input.image) ?? null) : yours ? null : (this.#deps.image?.(input.projectId, wanted) ?? null);
    if (input.image !== undefined && input.image !== "standard" && !image) {
      throw new BoxError("not_found", `There is no image ${input.image} for ${wanted} boxes. box_list names each kind's images; "standard" is bb-box's own.`);
    }
    // Spares left over from a kind that keeps none now are released, not claimed.
    const claims = claimsSpare && !image && (general.spares[wanted] ?? 0) > 0;
    const sized = chooseSize(wanted, kindSizes(wanted, general.sizes), input.size);
    if (!sized.ok) throw new BoxError("invalid_size", sized.message);
    const { box, claimed } = await this.#admission.run(() =>
      this.#locked(input.threadId, async () => {
        const existing = await this.list(input.threadId);
        const active = existing.filter((box) => isActive(box) && box.role === "box");
        if (owned && general.perThreadLimit !== null && active.length >= general.perThreadLimit) {
          throw new BoxError(
            "limit_reached",
            `This thread already has ${active.length} boxes, the most allowed: ${active.map((box) => box.name).join(", ")}. Release one first.`,
          );
        }
        const taken = new Set(existing.filter((box) => box.state !== "gone").map((box) => box.name));
        if (input.name !== undefined && taken.has(input.name)) throw new BoxError("invalid_name", `There is a machine called ${input.name} already.`);
        const spare = claims ? await this.#claim(input, offered, features, sized.size, taken, requested) : null;
        if (spare) return { box: spare.box, claimed: spare.from };
        const chosen = await this.#place({ threadId: input.threadId, named }, offered, everywhere, sized.size, features);
        // A current baked build of the image on the backend chosen starts the box with it (049); otherwise its script runs at start.
        const baked =
          image && chosen.backend.images?.startsFrom ? await this.#deps.baked?.(image.name, chosen.backend.id, chosen.kind.id).catch(() => null) : null;
        const box: BoxRecord = {
          id: newBoxId(this.#random),
          threadId: input.threadId,
          projectId: input.projectId,
          name: input.name ?? generateName(taken, this.#random),
          kind: chosen.kind.id,
          kindLabel: chosen.kind.label,
          requires: [...new Set([...chosen.kind.requires, ...features])],
          capabilities: chosen.kind.capabilities,
          backend: chosen.backend.id,
          backendLabel: chosen.backend.label,
          nature: chosen.backend.nature,
          role,
          size: sized.size,
          guest: null,
          state: "acquiring",
          error: null,
          createdAt: this.#now(),
          readyAt: null,
          releaseRequestedAt: null,
          resetAt: null,
          timings: {},
          enrol: { state: "off", hostId: null, error: null },
          ...(image ? { image: baked ? { name: image.name, state: "baked" as const, build: baked.build, from: baked.ref } : { name: image.name, state: "pending" as const } } : {}),
        };
        await this.#deps.kv.set(indexKey(box.id), box.threadId);
        return { box: await this.#write(box), claimed: null };
      }),
    );
    if (claimed !== null) this.#claimed(box, claimed);
    else this.#startAcquire(box);
    return box;
  }

  /**
   * Moves a spare of an offered kind and the size to the thread, or returns
   * null when none suits (032). Runs in the thread's turn; `taken` holds the
   * names of its boxes. The box's timings are the claim's, from `requested`.
   */
  async #claim(
    input: { threadId: string; projectId: string | null; name?: string },
    offered: OfferedKind[],
    features: readonly string[],
    size: BoxSize,
    taken: Set<string>,
    requested: number,
  ): Promise<{ box: BoxRecord; from: string } | null> {
    return this.#locked(SPARES, async () => {
      for (const spare of await this.list(SPARES)) {
        if (!offered.some((candidate) => candidate.backend.id === spare.backend && candidate.kind.id === spare.kind)) continue;
        // A spare made before its backend's offer gained a feature lacks it.
        if (!hasFeatures(spare.capabilities, features)) continue;
        if (!(await this.#claimable(spare)) || !sameSize(await this.#size(spare), size)) continue;
        try {
          if (this.#deps.spareThread && (await this.#deps.spareThread(spare)) !== null) {
            this.#deps.log?.(`Skipped spare box ${spare.name}: a thread uses its BB machine.`);
            continue;
          }
        } catch (error) {
          this.#deps.logError("claim", error);
          continue;
        }
        const ms = this.#now() - requested;
        const box: BoxRecord = {
          ...spare,
          threadId: input.threadId,
          projectId: input.projectId,
          name: input.name ?? (taken.has(spare.name) ? generateName(taken, this.#random) : spare.name),
          requires: [...new Set([...spare.requires, ...features])],
          timings: { spare: ms, total: ms },
        };
        await this.#deps.kv.set(indexKey(box.id), box.threadId);
        await this.#write(box);
        await this.#deps.kv.delete(recordKey(SPARES, box.id));
        this.#deps.notify(SPARES);
        return { box, from: spare.name };
      }
      return null;
    });
  }

  /**
   * Keeps the last five cold starts of each kind on each backend, by their
   * total time to ready, for "usually about 3 s" in the panel. A claim from
   * a spare (its timings carry `spare`) and a restored record are not starts.
   */
  async #recordReady(box: BoxRecord): Promise<void> {
    const total = box.timings.total;
    if (box.timings.spare !== undefined || box.restoredAt || typeof total !== "number") return;
    const history = (await this.#deps.kv.get<Record<string, number[]>>(READY_HISTORY)) ?? {};
    const key = `${box.kind}|${box.backend}`;
    history[key] = [...(history[key] ?? []), total].slice(-5);
    await this.#deps.kv.set(READY_HISTORY, history);
  }

  /** The median of each kind's last cold starts on each backend, keyed "<kind>|<backend>", in ms. */
  async typicalReady(): Promise<Record<string, number>> {
    const history = (await this.#deps.kv.get<Record<string, number[]>>(READY_HISTORY)) ?? {};
    const typical: Record<string, number> = {};
    for (const [key, totals] of Object.entries(history)) {
      const sorted = [...totals].sort((a, b) => a - b);
      if (!sorted.length) continue;
      const middle = Math.floor(sorted.length / 2);
      typical[key] = sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
    }
    return typical;
  }

  /** Spares ready to claim now, keyed "<kind>|<backend>" (032), for the picker's offers. */
  async spareReadyByBackend(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const spare of await this.list(SPARES)) {
      if (!isActive(spare) || !(await this.#claimable(spare))) continue;
      const key = `${spare.kind}|${spare.backend}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }

  /** Each kind's spares now (032): ready to claim, and being made or made ready. */
  async spareCounts(): Promise<Record<string, { readonly ready: number; readonly making: number }>> {
    const counts: Record<string, { ready: number; making: number }> = {};
    for (const spare of await this.list(SPARES)) {
      if (!isActive(spare)) continue;
      const count = (counts[spare.kind] ??= { ready: 0, making: 0 });
      if (await this.#claimable(spare)) count.ready++;
      else count.making++;
    }
    return counts;
  }

  /** Whether a spare can be claimed now: ready, answering, enrolled when it enrols, and with no task running. */
  async #claimable(spare: BoxRecord): Promise<boolean> {
    if (spare.state !== "ready" || spare.restoredAt || spare.error || this.#work.has(spare.id) || this.#reconnects.has(spare.id)) return false;
    return spare.enrol.state === "enrolled" || (spare.enrol.state === "off" && !(await this.#enrols(spare)));
  }

  /**
   * After a claim: renames the box's BB machine, and makes another spare.
   * Its commands wait only when its machine must reconnect (#128).
   */
  #claimed(box: BoxRecord, from: string): void {
    this.#deps.log?.(`Claimed spare box ${box.name} for thread ${box.threadId}.`);
    this.#renamed(box, from);
    void this.keepSpares();
  }

  /** Makes the box's commands wait a while for `task`, which never rejects. */
  #waitFor(boxId: string, task: Promise<void>): void {
    this.#reconnects.set(boxId, task);
    void task.then(() => {
      if (this.#reconnects.get(boxId) === task) this.#reconnects.delete(boxId);
    });
  }

  /**
   * Gives each box the capabilities its kind has now, where its backend
   * still offers the kind and says the guest comes from what it offers it
   * from. A box keeps the capabilities it was acquired with otherwise, so a
   * release that adds one, such as computer use, reaches long-lived boxes
   * too (#215). What describes the guest as it was made, such as its size
   * and address, is the guest's and stays. Returns how many changed.
   */
  async refreshCapabilities(signal?: AbortSignal): Promise<number> {
    let changed = 0;
    for (const box of await this.all()) {
      if (signal?.aborted) break;
      if (!box.guest || box.state === "gone" || box.state === "releasing") continue;
      const backend = this.#deps.backends.get(box.backend);
      const kind = backend?.kinds().find((candidate) => candidate.id === box.kind);
      if (!backend || !kind) continue;
      // A box asked for by an alias keeps what it was made with when the offer now lacks the alias's features (041).
      if (!hasFeatures(kind.capabilities, box.requires)) continue;
      const requires = [...new Set([...kind.requires, ...box.requires])];
      if (JSON.stringify(box.capabilities) === JSON.stringify(kind.capabilities) && JSON.stringify(box.requires) === JSON.stringify(requires)) continue;
      if (backend.asOffered && !(await backend.asOffered(box.guest, kind.id, box.createdAt, signal).catch((error) => (this.#deps.logError("capabilities", error), false)))) continue;
      const updated = await this.update(box, () => ({ capabilities: kind.capabilities, requires, kindLabel: kind.label })).catch((error) => {
        this.#deps.logError("capabilities", error);
        return null;
      });
      if (!updated) continue;
      changed++;
      this.#deps.log?.(`Box ${box.name} has the capabilities of its kind ${kind.id} now.`);
      this.#deps.notify(box.threadId);
    }
    return changed;
  }

  /**
   * Keeps each kind's spares (032): makes those missing, at the kind's
   * default size, and releases those no kind keeps now, those of another
   * size and those no claim can take. One run at a time; a call during a run
   * starts another after it.
   */
  keepSpares(): Promise<void> {
    if (this.#keeping) {
      this.#keepAgain = true;
      return this.#keeping;
    }
    const keeping = (async () => {
      do {
        this.#keepAgain = false;
        await this.#keepSpares().catch((error) => this.#deps.logError("spares", error));
      } while (this.#keepAgain && !this.#disposed);
    })().finally(() => {
      this.#keeping = null;
    });
    this.#keeping = keeping;
    return keeping;
  }

  async #keepSpares(): Promise<void> {
    if (this.#disposed) return;
    const general = await this.#deps.general();
    const kept = new Map<string, number>();
    for (const spare of await this.list(SPARES)) {
      // Claimed, but this record outlived the move.
      if ((await this.#deps.kv.get<string>(indexKey(spare.id))) !== SPARES) {
        await this.#deps.kv.delete(recordKey(SPARES, spare.id));
        continue;
      }
      if (spare.state === "releasing") continue;
      if (await this.#adoptIfUsed(spare)) continue;
      const count = kept.get(spare.kind) ?? 0;
      if (this.#work.has(spare.id) && isActive(spare)) {
        kept.set(spare.kind, count + 1);
        continue;
      }
      if (this.#holdsNothing(spare)) {
        await this.#forget(spare);
        continue;
      }
      // No claim takes these: stopped, or not enrolled when it should be, as when its machine was removed in BB.
      const failed =
        spare.state === "gone" ||
        spare.state === "stopped" ||
        spare.enrol.state === "failed" ||
        (spare.state === "ready" && spare.enrol.state === "off" && !spare.restoredAt && (await this.#enrols(spare)));
      const unwanted = count >= (general.spares[spare.kind] ?? 0);
      const resized = !sameSize(await this.#size(spare), defaultSize(kindSizes(spare.kind, general.sizes)));
      if (failed || unwanted || resized) {
        await this.#release(spare, failed ? `no claim can take it, as it is ${spare.state} and its enrolment ${spare.enrol.state}` : unwanted ? `bb-box keeps ${count} spare ${spare.kind} boxes` : "its kind's default size changed");
        continue;
      }
      kept.set(spare.kind, count + 1);
    }
    for (const [kind, wanted] of Object.entries(general.spares)) {
      for (let count = kept.get(kind) ?? 0; count < wanted && !this.#disposed; count++) {
        try {
          await this.acquire({ threadId: SPARES, projectId: null, kind });
        } catch (error) {
          if (error instanceof BoxError) this.#deps.log?.(`bb-box keeps ${count} of ${wanted} spare ${kind} boxes for now: ${error.message}`);
          else this.#deps.logError("spares", error);
          break;
        }
      }
    }
  }

  /**
   * Makes a spare yours when a thread started on its BB machine from BB's
   * picker (036): it moves to OPERATOR under the spares' lock, as a claim
   * does, its machine drops "(spare)", and the upkeep makes another spare.
   * A stopped one is yours too, not released as failed, and stays stopped
   * until you start it (#156).
   */
  async #adoptIfUsed(spare: BoxRecord): Promise<boolean> {
    if (!this.#deps.spareThread || (spare.state !== "ready" && spare.state !== "stopped") || spare.enrol.state !== "enrolled" || this.#work.has(spare.id)) return false;
    let threadId: string | null;
    try {
      threadId = await this.#deps.spareThread(spare);
    } catch (error) {
      this.#deps.logError("spares", error);
      return false;
    }
    if (threadId === null) return false;
    const moved = await this.#locked(OPERATOR, () =>
      this.#locked(SPARES, async () => {
        const current = await this.#read(SPARES, spare.id);
        if (!current) return null;
        const taken = new Set((await this.list(OPERATOR)).filter((box) => box.state !== "gone").map((box) => box.name));
        const name = isMachineName(current.name) && !taken.has(current.name) ? current.name : generateName(taken, this.#random);
        const yours: BoxRecord = { ...current, threadId: OPERATOR, projectId: null, name };
        await this.#deps.kv.set(indexKey(yours.id), OPERATOR);
        await this.#write(yours);
        await this.#deps.kv.delete(recordKey(SPARES, yours.id));
        return { box: yours, from: current.name };
      }),
    );
    if (!moved) return false;
    const { box, from } = moved;
    this.#deps.log?.(`Spare box ${box.name} is now yours: thread ${threadId} started on it from BB's picker.`);
    this.#deps.notify(SPARES);
    this.#renamed(box, from);
    return true;
  }

  /**
   * After a spare changed owner, and perhaps name (`from` was its name): the
   * backend records them on the guest and names it inside, BB's machine is
   * renamed, and reconnected if BB shows it disconnected and the box is
   * running; a stopped one reconnects when it starts. Commands wait for
   * the guest's new name only when it changed (#128), so a claim's total
   * then counts the relabel too (#186).
   */
  #renamed(box: BoxRecord, from: string): void {
    const backend = this.#deps.backends.get(box.backend);
    if (backend?.relabel && box.guest) {
      const guest = box.guest;
      const renamed = from !== box.name;
      const started = this.#now();
      const relabel = this.#size(box)
        .then((size) => backend.relabel!(guest, identity(box, size), from))
        .then(async () => {
          const ms = this.#now() - started;
          await this.update(box, ({ timings }) => ({
            timings: { ...timings, relabel: ms, ...(renamed && timings.spare !== undefined ? { total: timings.spare + ms } : {}) },
          }));
        })
        .catch((error) => this.#deps.logError("relabel", error));
      if (renamed) this.#waitFor(box.id, relabel);
    }
    const { claimed, reconnect } = this.#deps;
    if (!box.enrol.hostId || !claimed) return;
    void claimed(box).then(
      (disconnected) => {
        if (disconnected && reconnect && box.state === "ready") this.#waitFor(box.id, reconnect(box).catch((error) => this.#deps.logError("reconnect", error)));
      },
      (error) => this.#deps.logError("claim", error),
    );
  }

  /** A provider's name for people and for `on` (044): "Proxmox LXC on pve1", "Docker on devpc", "Tart on 2 Macs". */
  /**
   * The room one provider has for one more box of a kind at its default
   * size, as the provider says it, with the boxes still being acquired on
   * it counted, for the provider's profile. Null when it does not offer the
   * kind.
   */
  async room(backendId: string, kindId: string, signal?: AbortSignal): Promise<Capacity | null> {
    const candidate = this.#deps.backends.kinds().find((offer) => offer.backend.id === backendId && offer.kind.id === kindId);
    if (!candidate) return null;
    const general = await this.#deps.general();
    const size = defaultSize(kindSizes(kindId, general.sizes));
    const acquiring = (await this.all()).filter((box) => box.backend === backendId && isAcquiring(box));
    const pending = await Promise.all(acquiring.map(async (box) => ({ kind: box.kind, size: await this.#size(box) })));
    return candidate.backend.capacity(kindId, size, pending, signal);
  }

  #providerName(backend: Backend): string {
    return providerName({ label: this.#deps.backends.driverLabel?.(backend.id) ?? backend.label, hosts: backend.hosts ?? [], type: backend.id.split(":")[0]! });
  }

  /**
   * The offers `on` names (044): one provider, or a list for the first with
   * room among them. Each name is matched among the active backends by the
   * provider's name, its backend ID or its one host, without case; a name
   * that matches none, or two, or a provider without the kind, refuses the
   * acquire, and so does an empty list. A name given twice counts once.
   * The offers come in acquire order: the list narrows, never reorders. A
   * named provider that is off is passed over, with its reason in `out`,
   * and `ids` holds every provider named.
   */
  #on(on: string | readonly string[], kind: string, offered: OfferedKind[]): Named {
    const names = (typeof on === "string" ? [on] : on).map((name) => name.trim()).filter((name) => name.length);
    const others = offered.map((candidate) => this.#providerName(candidate.backend));
    if (!names.length) {
      throw new BoxError("unknown_provider", `Name a provider in "on", or leave it out for the first with room. ${kind} comes from: ${others.join(", ")}.`);
    }
    const providers = this.#deps.backends.active();
    const chosen = new Map<string, Backend>();
    for (const name of names) {
      const key = foldName(name);
      const matched = providers.filter((backend) =>
        providerKeys(backend.id, { label: this.#deps.backends.driverLabel?.(backend.id) ?? backend.label, hosts: backend.hosts ?? [], type: backend.id.split(":")[0]! }).includes(key),
      );
      if (!matched.length) {
        throw new BoxError("unknown_provider", `No provider is called "${name}". ${kind} comes from: ${others.join(", ")}. Leave "on" out for the first with room.`);
      }
      if (matched.length > 1) {
        throw new BoxError("unknown_provider", `"${name}" names ${matched.length} providers: ${matched.map((backend) => backend.id).join(", ")}. Give the ID.`);
      }
      chosen.set(matched[0]!.id, matched[0]!);
    }
    const out: string[] = [];
    const ids = new Set<string>();
    for (const backend of chosen.values()) {
      ids.add(backend.id);
      if (this.#deps.backends.on && !this.#deps.backends.on().some((candidate) => candidate.id === backend.id)) {
        out.push(`${this.#providerName(backend)} is off; turn it on in BB Box's settings.`);
        continue;
      }
      if (!offered.some((candidate) => candidate.backend.id === backend.id)) {
        const has = [...new Set(this.#deps.backends.kinds().filter((candidate) => candidate.backend.id === backend.id).map((candidate) => candidate.kind.id))];
        throw new BoxError(
          "unknown_provider",
          `${this.#providerName(backend)} has no ${kind}${has.length ? `; it has: ${has.join(", ")}` : ""}. ${kind} comes from: ${others.join(", ")}.`,
        );
      }
    }
    return { offers: offered.filter((candidate) => ids.has(candidate.backend.id)), out, ids };
  }

  /**
   * Where the box goes: the first offer with room, freeing a spare's room
   * when none has it. With `on`, only the named offers are tried, and a
   * refusal gives each named provider's reason, then names the kind's
   * other providers (044).
   */
  async #place(input: { threadId: string; named: Named | null }, offered: OfferedKind[], everywhere: OfferedKind[], size: BoxSize, features: readonly string[]): Promise<OfferedKind> {
    const choose = () => (input.threadId === SPARES ? this.#choose(offered, size, features) : this.#chooseFreeing(offered, size, features));
    if (!input.named) return choose();
    let reasons: string[];
    if (offered.length) {
      try {
        return await choose();
      } catch (error) {
        if (!(error instanceof BoxError) || error.code !== "no_capacity") throw error;
        reasons = [error.message, ...input.named.out];
      }
    } else {
      reasons = input.named.out;
    }
    const kind = everywhere[0]!.kind.id;
    const others = everywhere.filter((candidate) => !input.named!.ids.has(candidate.backend.id)).map((candidate) => this.#providerName(candidate.backend));
    throw new BoxError("no_capacity", `${reasons.join(" ")}${others.length ? ` ${kind} also comes from ${others.join(", ")}.` : ""} Leave "on" out for the first with room.`);
  }

  /** The first backend with room for a box of the kind and size, and still the features asked for, or the reasons none has. */
  async #choose(offered: OfferedKind[], size: BoxSize, features: readonly string[]): Promise<OfferedKind> {
    const all = await this.all();
    const reasons: string[] = [];
    const full: string[] = [];
    let lacking = 0;
    for (const candidate of offered) {
      const acquiring = all.filter((box) => box.backend === candidate.backend.id && isAcquiring(box));
      const pending = await Promise.all(acquiring.map(async (box) => ({ kind: box.kind, size: await this.#size(box) })));
      try {
        const capacity = await candidate.backend.capacity(candidate.kind.id, size, pending);
        if (!capacity.ok) {
          reasons.push(capacity.message ?? `${candidate.backend.label} has no room.`);
          full.push(candidate.backend.id);
          continue;
        }
        // Checking room can show a backend lacks what it offered, as a rootless Docker host lacks Docker (041).
        const kind = candidate.backend.kinds().find((other) => other.id === candidate.kind.id) ?? candidate.kind;
        const missing = features.filter((feature) => !kind.capabilities.features.includes(feature));
        if (!missing.length) return { ...candidate, kind };
        lacking++;
        reasons.push(`${candidate.kind.id} boxes from ${candidate.backend.label} have no ${missing.map(featureWord).join(" or ")}.`);
      } catch (error) {
        this.#deps.logError("capacity", error);
        reasons.push(describeError(error, `Checking room on ${candidate.backend.label}`));
      }
    }
    // No room makes a box wait; a feature no offer has is no matter of room.
    if (lacking === offered.length) {
      throw new Unplaced("unknown_kind", `${reasons.join(" ")} Ask for ${offered[0]!.kind.id} if the box can do without it.`, full);
    }
    throw new Unplaced("no_capacity", reasons.join(" "), full);
  }

  /**
   * #choose for a thread's box. When no backend has room, a spare of a
   * backend that had none gives its room back and the choice is made once
   * more: on a Mac a spare holds one of its two VM slots (#120).
   */
  async #chooseFreeing(offered: OfferedKind[], size: BoxSize, features: readonly string[]): Promise<OfferedKind> {
    try {
      return await this.#choose(offered, size, features);
    } catch (error) {
      if (!(error instanceof Unplaced)) throw error;
      const spares = (await this.list(SPARES)).filter((spare) => spare.state !== "releasing" && !this.#holdsNothing(spare));
      const spare = error.full.map((backend) => spares.find((spare) => spare.backend === backend)).find((spare) => !!spare);
      if (!spare) throw error;
      if (await this.#release(spare, `a thread's ${offered[0]!.kind.id} box needs its room`)) throw error;
      return this.#choose(offered, size, features);
    }
  }

  /** The size a box was asked to be. One recorded before sizes was made at the default preset. */
  async #size(box: BoxRecord): Promise<BoxSize> {
    return box.size ?? defaultSize(kindSizes(box.kind, (await this.#deps.general()).sizes));
  }

  #startAcquire(box: BoxRecord): void {
    if (this.#acquiring.has(box.id) || this.#disposed) return;
    const controller = new AbortController();
    this.#acquiring.set(box.id, controller);
    void this.#chain(box.id, () => this.#acquire(box, controller.signal))
      .catch((error) => this.#deps.logError("acquire", error))
      .finally(() => this.#acquiring.delete(box.id));
  }

  async #acquire(initial: BoxRecord, signal: AbortSignal): Promise<void> {
    let box = (await this.#read(initial.threadId, initial.id)) ?? initial;
    if (!isAcquiring(box)) return;
    const backend = this.#deps.backends.get(box.backend);
    if (!backend) {
      // The backend was switched off or its settings broke. The claim stays
      // recorded, and the sweep carries on when the backend is back.
      await this.update(box, () => ({ error: this.#backendOff(box) }));
      return;
    }
    const timings: Record<string, number> = { ...box.timings };
    const released = () => new BoxError("released", `Box ${box.name} was released while it was being acquired.`);
    const hooks: AcquireHooks = {
      claim: async (guest) => {
        // Recorded even when a release is waiting, so the release finds it.
        const next = await this.update(box, () => ({ guest }));
        if (!next) throw released();
        box = next;
        if (next.state === "releasing") throw released();
      },
      starting: async () => {
        const next = await this.update(box, (current) =>
          current.state === "releasing" ? {} : { state: "starting", timings: { ...timings } },
        );
        if (!next || next.state === "releasing") throw released();
        box = next;
      },
      timing: (step, ms) => {
        timings[step] = ms;
      },
    };
    let guest: Guest;
    try {
      guest = await backend.acquire(identity(box, await this.#size(box)), box.guest, hooks, signal);
    } catch (error) {
      // The backend released whatever it claimed before it threw.
      const next = await this.update(box, (current) => {
        if (current.state === "releasing" || this.#disposed) return { guest: null };
        return { state: "failed", guest: null, error: describeError(error, "Acquiring the box"), timings: { ...timings } };
      });
      if (next?.state === "failed") this.#deps.logError("acquire", error);
      return;
    }
    // The project's image's script (049), as root, before the box is handed over. A failure releases the box.
    if (box.image && box.image.state !== "done" && box.image.state !== "baked") {
      try {
        await this.#runImage(box, guest, backend, timings, signal);
      } catch (error) {
        await this.update(box, (current) => ({ image: current.image ? { ...current.image, state: "failed" as const } : null }));
        await backend.release(guest, QUIET).catch((cause) => this.#deps.logError("release", cause));
        const next = await this.update(box, (current) => {
          if (current.state === "releasing" || this.#disposed) return { guest: null };
          return { state: "failed", guest: null, error: describeError(error, `Running ${box.image!.name}'s script`), timings: { ...timings } };
        });
        if (next?.state === "failed") this.#deps.logError("acquire", error);
        return;
      }
      box = (await this.#read(box.threadId, box.id)) ?? box;
    }
    const now = this.#now();
    const next = await this.update(box, (current) =>
      current.state === "releasing"
        ? { guest }
        : { guest, state: "ready", readyAt: now, error: null, timings: { ...timings, total: now - current.createdAt } },
    );
    if (next?.state === "ready") void this.#recordReady(next).catch((error) => this.#deps.logError("ready history", error));
    if (next?.state === "ready" && next.image) this.#deps.imageReady?.(next);
    if (!next) {
      await backend.release(guest, QUIET).catch((error) => this.#deps.logError("release", error));
      return;
    }
    // A release waiting behind this task releases the guest next.
    if (next.state !== "ready") return;
    await this.#enrol(next);
  }

  /**
   * Runs the box's project's image's script as root, with BB_BOX_IMAGE,
   * BB_BOX_KIND, BB_BOX_BACKEND and BB_BOX_ARCH, then its check as the box
   * user (049). Throws with the output's last lines when either fails. An
   * image removed since the box was asked for runs nothing.
   */
  async #runImage(box: BoxRecord, guest: Guest, backend: Backend, timings: Record<string, number>, signal: AbortSignal): Promise<void> {
    const found = box.image ? this.#deps.image?.(box.projectId, box.kind, box.image.name) : null;
    if (!found || found.name !== box.image?.name) {
      await this.update(box, () => ({ image: null }));
      return;
    }
    const { name, image } = found;
    const started = this.#now();
    await this.update(box, (current) => ({ image: { name, state: "running" as const } }));
    const command = (await backend.transports(guest, box.kind)).command;
    if (!command) throw new BoxError("unsupported", `A ${box.kindLabel} box takes no commands, so it cannot run ${name}'s script.`);
    const text = new TextEncoder();
    await command.writeFile(`${IMAGE_DIR}/setup.sh`, text.encode(image.script), { mode: "0700", signal });
    if (image.check) await command.writeFile(`${IMAGE_DIR}/check.sh`, text.encode(image.check), { mode: "0700", signal });
    const tools = Object.entries(this.#deps.imageTools ?? {});
    for (const [tool, body] of tools) await command.writeFile(`${IMAGE_DIR}/bin/${tool}`, text.encode(body), { mode: "0755", signal });
    const path = tools.length ? `PATH="$HOME/${IMAGE_DIR}/bin:$PATH" ` : "";
    const env = Object.entries({ BB_BOX_IMAGE: name, BB_BOX_KIND: box.kind, BB_BOX_BACKEND: backend.id, BB_BOX_ARCH: box.capabilities.arch })
      .map(([key, value]) => `${key}=${quote(value)}`)
      .join(" ");
    const failed = (what: string, ran: RunResult, limitMs: number) => {
      const lines = ran.stdout.trimEnd().split("\n").slice(-IMAGE_LINES).join("\n");
      return new Error(`${name}'s ${what} ${ran.timedOut ? `ran out of time after ${limitMs / 60_000} minutes` : `exited with ${ran.exitCode}`}. Its last lines:\n${lines}`);
    };
    const ran = await command.run(`sudo -n env ${path}${env} bash "$HOME/${IMAGE_DIR}/setup.sh" 2>&1`, { timeoutMs: IMAGE_SCRIPT_MS, signal, maxOutputBytes: 256 * 1024 });
    if (ran.exitCode !== 0) throw failed("script", ran, IMAGE_SCRIPT_MS);
    if (image.check) {
      // With the PATH and variables the script set, which a session on a shared connection has not read yet.
      const checked = await command.run(`${LOAD_ENVIRONMENT} env ${env} bash "$HOME/${IMAGE_DIR}/check.sh" 2>&1`, { timeoutMs: IMAGE_CHECK_MS, signal, maxOutputBytes: 256 * 1024 });
      if (checked.exitCode !== 0) throw failed("check", checked, IMAGE_CHECK_MS);
    }
    await command.run(`rm -rf "$HOME/${IMAGE_DIR}"`, { timeoutMs: 30_000, signal }).catch(() => undefined);
    const ms = this.#now() - started;
    timings.image = ms;
    await this.update(box, () => ({ image: { name, state: "done" as const, seconds: Math.round(ms / 1000) } }));
  }

  /** Starts enrolling a ready box as a BB machine, when it can enrol. */
  async #enrol(box: BoxRecord, options: { restored?: boolean } = {}): Promise<void> {
    if (!(await this.#enrols(box))) return;
    const enrolling = await this.update(box, (current) => ({
      enrol: { state: "enrolling", hostId: null, error: null },
      ...(current.restoredAt ? { restoredAt: null } : {}),
    }));
    if (enrolling) void this.#deps.enrol!(enrolling, options).catch((error) => this.#deps.logError("enrol", error));
  }

  /** Whether a box can enrol as a BB machine: its kind can and bb-box enrols boxes. */
  /** A thread's own box (role "machine") is enrolled by the machine provider that made it, with the thread's key. */
  async #enrols(box: BoxRecord): Promise<boolean> {
    // Your machines are BB machines whatever the general setting says (036).
    return box.role !== "machine" && box.capabilities.enrol && !!this.#deps.enrol && (box.threadId === OPERATOR || (await this.#deps.general()).enrol);
  }

  #backendOff(box: BoxRecord): string {
    return `The ${box.backendLabel} backend that holds box ${box.name} is not in bb-box's settings, or its settings need fixing. Fix them in bb-box's settings.`;
  }

  #backend(box: BoxRecord): Backend {
    const backend = this.#deps.backends.get(box.backend);
    if (!backend) throw new BoxError("backend_off", this.#backendOff(box));
    return backend;
  }

  /** Waits until the box's tasks in this process settle, then returns it. */
  async settled(box: Pick<BoxRecord, "threadId" | "id">): Promise<BoxRecord | null> {
    while (this.#work.has(box.id)) await this.#work.get(box.id);
    return this.#read(box.threadId, box.id);
  }

  /** Waits for every task in this process. */
  async idle(): Promise<void> {
    while (this.#work.size) await Promise.all(this.#work.values());
  }

  /**
   * Releases a box: its BB machine is removed, then the backend deletes the
   * guest or resets and returns the machine. Resolves when that is done, with
   * null, or with the box still releasing and the error when it failed; the
   * sweep then tries again. A spare released this way is replaced then, not
   * at the next sweep (#129). `why` says who asked, for the log.
   */
  async release(threadId: string, ref: string, why: string): Promise<BoxRecord | null> {
    const box = await this.get(threadId, ref);
    const left = await this.#release(box, why);
    if (box.threadId === SPARES) void this.keepSpares();
    return left;
  }

  /** Every release starts here, and logs why: who asked, or what bb-box needed. */
  async #release(box: BoxRecord, why: string): Promise<BoxRecord | null> {
    const marked = await this.update(box, (current) => ({
      state: "releasing",
      releaseRequestedAt: current.releaseRequestedAt ?? this.#now(),
    }));
    if (!marked) return null;
    this.#deps.log?.(`Releasing ${describeBox(box)}: ${why}.`);
    this.#acquiring.get(box.id)?.abort(new BoxError("released", `Box ${box.name} was released.`));
    return this.#chain(box.id, () => this.#finishRelease(marked));
  }

  async #finishRelease(initial: BoxRecord): Promise<BoxRecord | null> {
    const box = await this.#read(initial.threadId, initial.id);
    if (!box) return null;
    // A thread's own box (role "machine") has a BB machine that BB owns and removes itself; deleting it
    // from here would wait on BB's removal, which waits on this release.
    if (box.enrol.hostId && this.#deps.unenrol && box.role !== "machine") {
      try {
        await this.#deps.unenrol(box);
      } catch (error) {
        // The machine stays in BB as offline; releasing the box matters more.
        this.#deps.logError("unenrol", error);
      }
    }
    if (box.guest) {
      const backend = this.#deps.backends.get(box.backend);
      if (!backend) return this.update(box, () => ({ error: this.#backendOff(box) }));
      const timings: Record<string, number> = {};
      const hooks: ReleaseHooks = {
        resetting: async () => {
          await this.update(box, (current) => ({ resetAt: current.resetAt ?? this.#now() }));
        },
        timing: (step, ms) => {
          timings[`release.${step}`] = ms;
        },
      };
      try {
        const { guest } = await this.#stamped(box);
        await backend.release(guest!, hooks);
      } catch (error) {
        this.#deps.logError("release", error);
        return this.update(box, (current) => ({
          error: `${sentence(describeError(error, "Releasing the box"))} bb-box tries again in a few minutes.`,
          timings: { ...current.timings, ...timings },
        }));
      }
    }
    await this.#forget(box);
    return null;
  }

  /**
   * Releases every box of a thread that BB said was archived or deleted.
   * Resolves with how many it released. BB is asked again first, and the
   * boxes go now only when it returns the thread archived or deleted. When it
   * finds no such thread, the next sweep releases them if it still finds
   * none; while it says the thread is live, or cannot say, they stay.
   */
  async releaseThread(threadId: string, ended: "archived" | "deleted"): Promise<number> {
    const boxes = await this.list(threadId);
    if (!boxes.length) return 0;
    const { state, said } = await this.#ask(threadId);
    if (state !== "ended") {
      // BB's answer now counts as its first for the next sweep.
      if (state === "missing") this.#ending.add(threadId);
      const now =
        state === "live" ? "says now that it is live" :
        state === "missing" ? "finds no such thread now, and the next sweep releases them if BB still finds none" :
        "cannot say now whether it ended, and the sweep decides";
      this.#deps.log?.(`Kept the boxes of thread ${threadId}: BB said it was ${ended}, but ${now}. BB's answer: ${said}.`);
      return 0;
    }
    let count = 0;
    for (const box of boxes) {
      try {
        if (this.#holdsNothing(box)) await this.#forget(box);
        else if ((await this.#release(box, `its thread was ${ended}. BB's answer: ${said}`)) === null) count++;
      } catch (error) {
        this.#deps.logError("release", error);
      }
    }
    return count;
  }

  /** BB's answer for a thread; an error asking it is no answer. */
  #ask(threadId: string): Promise<ThreadAnswer> {
    return this.#deps.thread(threadId).catch((error: unknown) => ({ state: "unknown" as const, said: describeError(error, "Asking BB") }));
  }

  /** A failed box with no guest: nothing to release, only the record to forget. */
  #holdsNothing(box: BoxRecord): boolean {
    return !box.guest && !isAcquiring(box) && box.state !== "releasing" && !this.#work.has(box.id);
  }

  /** Whether the box's backend can stop and start it. The panel and tools offer stop and start only then. */
  canStopStart(box: BoxRecord): boolean {
    const backend = this.#deps.backends.get(box.backend);
    return !!(backend?.stop && backend.start);
  }

  #stopStart(box: BoxRecord): { stop: NonNullable<Backend["stop"]>; start: NonNullable<Backend["start"]> } {
    const backend = this.#backend(box);
    if (!backend.stop || !backend.start) {
      throw new BoxError("unsupported", `${box.backendLabel} cannot stop and start its boxes, so box ${box.name} keeps running until it is released.`);
    }
    return { stop: backend.stop.bind(backend), start: backend.start.bind(backend) };
  }

  /** Stops a box to free memory while keeping its disk. */
  async stop(threadId: string, ref: string, signal?: AbortSignal): Promise<BoxRecord> {
    const box = await this.get(threadId, ref);
    return this.#chain(box.id, async () => {
      const current = await this.#stamped((await this.#read(box.threadId, box.id)) ?? box, signal);
      const { stop } = this.#stopStart(current);
      if (current.state === "stopped") return current;
      this.#require(current, "ready");
      this.#require((await this.#move(current, "stopping")) ?? { ...current, state: "releasing" }, "stopping");
      try {
        await stop(current.guest!, signal);
      } catch (error) {
        await this.#observe(current, { signal, moving: true }).catch(() => null);
        throw error;
      }
      return (await this.#move(current, "stopped")) ?? current;
    });
  }

  /**
   * Starts a stopped box, waits until its command transport answers, and
   * reconnects its BB machine, or enrols it when the sweep restored it.
   */
  async start(threadId: string, ref: string, signal?: AbortSignal): Promise<BoxRecord> {
    const box = await this.get(threadId, ref);
    return this.#chain(box.id, () => this.#start(box, signal));
  }

  /** start(), in the box's chain. */
  async #start(box: BoxRecord, signal?: AbortSignal): Promise<BoxRecord> {
    const current = await this.#stamped((await this.#read(box.threadId, box.id)) ?? box, signal);
    const { start } = this.#stopStart(current);
    if (current.state === "ready") return current;
    this.#require(current, "stopped");
    this.#require((await this.#move(current, "starting")) ?? { ...current, state: "releasing" }, "starting");
    const timings: Record<string, number> = {};
    const began = this.#now();
    try {
      await start(current.guest!, signal, (step, ms) => {
        timings[`start.${step}`] = ms;
      });
    } catch (error) {
      await this.#observe(current, { signal, moving: true }).catch(() => null);
      throw error;
    }
    timings["start.total"] = this.#now() - began;
    const started = (await this.#move(current, "ready", timings)) ?? current;
    if (started.state === "ready" && started.restoredAt) {
      await this.#enrol(started, { restored: true }).catch((error) => this.#deps.logError("enrol", error));
      return (await this.#read(started.threadId, started.id)) ?? started;
    }
    // A hard stop ends BB's daemon, and nothing in the box starts it again (017).
    if (started.state === "ready" && started.enrol.state === "enrolled" && this.#deps.reconnect) {
      this.#waitFor(started.id, this.#deps.reconnect(started).catch((error) => this.#deps.logError("reconnect", error)));
    }
    return started;
  }

  /**
   * Records why a box's guest stopped when bb-box did not stop it, as its
   * backend says (#406), and starts it again in the background when its VM
   * crashed, unless bb-box started it again after the stop before less than
   * RESTART_GAP_MS before.
   */
  async #stoppedUnrequested(box: BoxRecord, signal?: AbortSignal): Promise<BoxRecord> {
    const backend = this.#deps.backends.get(box.backend);
    let why: StopReason | null = null;
    try {
      why = (await backend?.stopped?.(box.guest!, signal)) ?? null;
    } catch (error) {
      this.#deps.logError("stopped", error);
    }
    const now = this.#now();
    const last = box.unrequestedStop?.restart?.at;
    const restart = !!why?.crashed && !!backend?.start && (last === undefined || now - last >= RESTART_GAP_MS);
    const stop: UnrequestedStop = { at: why?.at ?? now, reason: why?.reason ?? null, crashed: why?.crashed ?? false, restart: restart ? { at: now, error: null } : null };
    const updated = (await this.update(box, (current) => (current.state === "stopped" ? { unrequestedStop: stop } : {}))) ?? box;
    this.#deps.log?.(`${describeBox(box)}: ${stopWords(updated)}`);
    if (restart && updated.unrequestedStop === stop) {
      void this.#chain(box.id, () => this.#start(updated)).catch(async (error) => {
        this.#deps.logError("restart", error);
        const message = describeError(error, "The start");
        await this.update(box, (current) => {
          const last = current.unrequestedStop;
          return last?.restart ? { unrequestedStop: { ...last, restart: { ...last.restart, error: message } } } : {};
        });
      });
    }
    return updated;
  }

  /**
   * Moves a box to `state` for a stop or start, unless its release began
   * meanwhile. A start's timings replace the last start's.
   */
  #move(box: BoxRecord, state: "stopping" | "stopped" | "starting" | "ready", started?: Readonly<Record<string, number>>): Promise<BoxRecord | null> {
    const moving = state === "stopping" || state === "starting";
    return this.update(box, (current) => {
      if (current.state === "releasing") return {};
      if (state === "stopping") return { state, error: null, unrequestedStop: null };
      if (moving) return { state, error: null };
      if (!started) return { state };
      const kept = Object.entries(current.timings).filter(([step]) => !step.startsWith("start."));
      return { state, timings: { ...Object.fromEntries(kept), ...started } };
    });
  }

  /** Throws the reason a box is not in `state`, in words for the user. */
  #require(box: BoxRecord, state: BoxState): void {
    if (box.state === state && box.guest) return;
    const reasons: Record<BoxState, string> = {
      acquiring: `Box ${box.name} is still being acquired. Check its status in a few seconds.`,
      starting: restarting(box)
        ? `Box ${box.name} is starting again. ${stopWords(box)} Check its status in a few seconds.`
        : `Box ${box.name} is still starting. Check its status in a few seconds.`,
      ready: `Box ${box.name} is already running.`,
      stopping: `Box ${box.name} is stopping.`,
      stopped: restarting(box)
        ? `Box ${box.name} is stopped. ${stopWords(box)} Check its status in a few seconds.`
        : `Box ${box.name} is stopped.${box.unrequestedStop ? ` ${stopWords(box)}` : ""} Start it first.`,
      failed: `Box ${box.name} failed: ${box.error ?? "unknown error"} Release it and acquire another.`,
      gone: `Box ${box.name} no longer exists at its provider. Release it and acquire another.`,
      releasing: `Box ${box.name} is being released.`,
    };
    throw new BoxError("not_ready", reasons[box.state]);
  }

  /** Reads the guest's power and updates the box to match. */
  async refresh(threadId: string, ref: string, signal?: AbortSignal): Promise<BoxRecord> {
    const box = await this.get(threadId, ref);
    if (this.#work.has(box.id)) return box;
    return (await this.#observe(box, { signal })) ?? box;
  }

  /**
   * Moves a ready, stopped or gone box to match the guest's power. `moving`
   * also settles a box a failed stop or start left stopping or starting.
   */
  async #observe(
    box: BoxRecord,
    options: { signal?: AbortSignal; power?: PowerState | null; moving?: boolean } = {},
  ): Promise<BoxRecord | null> {
    if (!box.guest) return box;
    const backend = this.#deps.backends.get(box.backend);
    if (!backend) return box;
    const read = async () => backend.power((await this.#stamped(box, options.signal)).guest!, options.signal);
    let power = options.power !== undefined ? options.power : await read();
    // A listing's power can be older than the box, which may have started or
    // stopped since, and a provider's listing can lag (Proxmox's by about
    // 10 s). Before such a reading changes the box, ask about the guest itself.
    if (options.power !== undefined) {
      const current = await this.#read(box.threadId, box.id);
      if (current && Object.keys(observed(current, power, options.moving)).length) power = await read();
    }
    let unrequested = false;
    const updated = await this.update(box, (current) => {
      const change = observed(current, power, options.moving);
      // A ready box stops through stop(), which moves it to stopping first: one that did not was not asked (#406).
      unrequested = current.state === "ready" && change.state === "stopped";
      return change;
    });
    return unrequested && updated ? this.#stoppedUnrequested(updated, options.signal) : updated;
  }

  /**
   * The box with its guest as its backend keeps it now. The guest of a box
   * recorded before install IDs gets this install recorded on it first
   * (018), so the backend's checks know the box.
   */
  async #stamped(box: BoxRecord, signal?: AbortSignal): Promise<BoxRecord> {
    const guest = box.guest;
    const backend = this.#deps.backends.get(box.backend);
    if (!guest || !backend?.stamp || guest.data?.box !== undefined) return box;
    const stamped = await backend.stamp(box.id, guest, signal);
    const updated = await this.update(box, (current) => (current.guest?.ref === guest.ref ? { guest: stamped } : {}));
    return updated ?? { ...box, guest: stamped };
  }

  /** The transports that reach a ready box. */
  async transports(box: BoxRecord): Promise<BoxTransports> {
    this.#require(box, "ready");
    return this.#backend(box).transports(box.guest!, box.kind);
  }

  async #command(box: BoxRecord): Promise<CommandTransport> {
    const { command } = await this.transports(box);
    if (!command) throw new BoxError("unsupported", `bb-box cannot run commands in box ${box.name}: its kind has no command transport.`);
    return command;
  }

  /** Turns an unreachable box into a message that says why, after checking its power. */
  async #reach<T>(box: BoxRecord, task: (transport: CommandTransport) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const transport = await this.#command(box);
    try {
      return await task(transport);
    } catch (error) {
      if (!(error instanceof TransportError) || error.code !== "unreachable") throw error;
      const current = await this.#observe(box, { signal }).catch(() => null);
      if (current && current.state !== "ready") this.#require(current, "ready");
      throw new BoxError("unreachable", `Box ${box.name} is running but does not answer. ${error.message}`);
    }
  }

  /**
   * Runs a script in the box's shell, with the thread's environment. A box
   * still enrolling gets a few seconds to finish, so the command has the
   * thread's access. In a Linux or Windows box the timeout stops the script
   * and everything it started, and the local one is a backstop.
   */
  async run(
    threadId: string,
    ref: string,
    script: string,
    options: {
      stdin?: string | Uint8Array;
      timeoutMs?: number;
      cwd?: string;
      /** "desktop" runs the command in the box's logged-in desktop session, so it can open windows. */
      session?: Session;
      signal?: AbortSignal;
      maxOutputBytes?: number;
      /** False runs at once in a box that is enrolling. */
      waitForEnrolment?: boolean;
      /** Called once the env file's contents are worked out, as the command goes to the box. */
      onSend?: () => void;
      /** A job ID: the command leaves its result in the box, for job(), if it outlives bb-box (#405). */
      job?: string;
    } = {},
  ): Promise<{ box: BoxRecord; result: RunResult }> {
    const found = await this.get(threadId, ref);
    const box = options.waitForEnrolment === false ? found : await this.enrolled(found, options.signal);
    const capabilities = box.capabilities;
    if (options.session === "desktop" && !capabilities.displays.length) {
      throw new BoxError("unsupported", `Box ${box.name} has no desktop. Run the command without session "desktop", or use a desktop box.`);
    }
    // A transport that already runs commands in the desktop session needs no wrapper.
    const session = options.session === "desktop" && !capabilities.command?.inDesktopSession ? "desktop" : "default";
    const env = await this.#envFile(box);
    const jobs = options.job && capabilities.os !== "windows" ? this.#jobsOf(box.id) : null;
    const job = jobs && options.job ? { id: options.job, forget: [...jobs.received], prune: !jobs.pruned } : undefined;
    options.onSend?.();
    // Every box stops a command at its timeout itself; bb-box's own comes a moment later.
    const inBox = options.timeoutMs;
    const result = await this.#reach(
      box,
      (transport) =>
        transport.run(command(capabilities.os, script, { cwd: options.cwd, session, env, timeoutMs: inBox, job }), {
          stdin: options.stdin,
          timeoutMs: inBox === undefined ? options.timeoutMs : inBox + LOCAL_TIMEOUT_GRACE_MS,
          signal: options.signal,
          maxOutputBytes: options.maxOutputBytes,
        }),
      options.signal,
    );
    if (jobs && job) {
      for (const id of job.forget) jobs.received.delete(id);
      jobs.received.add(job.id);
      jobs.pruned = true;
    }
    const stopped = inBox !== undefined && timedOutExits(capabilities.os).includes(result.exitCode ?? -1) && result.durationMs >= inBox;
    return { box, result: stopped ? { ...result, timedOut: true } : result };
  }

  #jobsOf(boxId: string): { readonly received: Set<string>; pruned: boolean } {
    let jobs = this.#jobs.get(boxId);
    if (!jobs) this.#jobs.set(boxId, (jobs = { received: new Set(), pruned: false }));
    return jobs;
  }

  /**
   * Runs a short script of bb-box's own in the box, as for a desktop's
   * clipboard (#464): with no wait for enrolment and without writing the
   * thread's environment first, so it takes one round trip. "desktop" runs
   * it in the box's logged-in desktop session.
   */
  async runOwn(box: BoxRecord, script: string, options: { session?: Session; stdin?: string | Uint8Array; timeoutMs: number; maxOutputBytes?: number; signal?: AbortSignal }): Promise<RunResult> {
    const capabilities = box.capabilities;
    const session = options.session === "desktop" && !capabilities.command?.inDesktopSession ? "desktop" : "default";
    return this.#reach(
      box,
      (transport) =>
        transport.run(command(capabilities.os, script, { session, timeoutMs: options.timeoutMs }), {
          stdin: options.stdin,
          timeoutMs: options.timeoutMs + LOCAL_TIMEOUT_GRACE_MS,
          signal: options.signal,
          maxOutputBytes: options.maxOutputBytes,
        }),
      options.signal,
    );
  }

  /**
   * Job `id` in a Linux or macOS box, which a command left when bb-box
   * restarted (#405): once it has ended, its exit code and output, which the
   * box's next command then removes; while it runs, the end of its output
   * so far; null when the box has no such job.
   */
  async job(threadId: string, ref: string, id: string, options: { signal?: AbortSignal; maxOutputBytes?: number } = {}): Promise<{ box: BoxRecord; job: JobResult | null }> {
    const box = await this.get(threadId, ref);
    if (box.capabilities.os === "windows") {
      throw new BoxError("unsupported", `Box ${box.name} runs Windows, where a command ends with bb-box's connection, so it has no jobs.`);
    }
    const maxOutputBytes = options.maxOutputBytes ?? 128 * 1024;
    const result = await this.#reach(
      box,
      (transport) => transport.run(jobScript(id, maxOutputBytes / 2), { timeoutMs: 30_000, signal: options.signal, maxOutputBytes }),
      options.signal,
    );
    if (result.exitCode === 3) return { box, job: null };
    if (result.exitCode === 4) return { box, job: { state: "running", stdout: result.stdout, stderr: result.stderr } };
    const newline = result.stdout.indexOf("\n");
    const exitCode = Number(result.stdout.slice(0, newline));
    if (result.exitCode !== 0 || newline < 0 || !Number.isInteger(exitCode)) {
      throw new BoxError("unreachable", `Reading job ${id} in box ${box.name} failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}.`);
    }
    this.#jobsOf(box.id).received.add(id);
    return { box, job: { state: "ended", exitCode, stdout: result.stdout.slice(newline + 1), stderr: result.stderr, truncated: result.truncated } };
  }

  /** Where commands in an enrolled box take the thread's access from, if from anywhere. */
  async access(box: BoxRecord): Promise<Access | undefined> {
    return (await this.#deps.access?.(box)) ?? undefined;
  }

  /**
   * Waits a while for a box that is enrolling to finish, or for its BB
   * machine to reconnect after a start, and returns it as it is then.
   */
  async enrolled(box: BoxRecord, signal?: AbortSignal): Promise<BoxRecord> {
    const deadline = this.#now() + (this.#deps.enrolWaitMs ?? ENROL_WAIT_MS);
    const reconnect = this.#reconnects.get(box.id);
    if (reconnect) {
      await within(reconnect, deadline - this.#now(), signal);
      box = (await this.find(box.id)) ?? box;
    }
    while (box.state === "ready" && box.enrol.state === "enrolling" && this.#now() < deadline && !signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, ENROL_POLL_MS));
      box = (await this.find(box.id)) ?? box;
    }
    return box;
  }

  /**
   * The env file for a box: who it is, and once BB knows it as a machine,
   * where to take the thread's access from. Undefined leaves the file as it
   * is, when the access cannot be worked out.
   */
  async #envFile(box: BoxRecord): Promise<string | undefined> {
    const variables: Record<string, string> = {
      BB_BOX_ID: box.id,
      BB_BOX_NAME: box.name,
      BB_BOX_KIND: box.kind,
      BB_THREAD_ID: box.threadId,
    };
    const hostId = box.enrol.hostId;
    if (!hostId) return envScript(box.capabilities.os, variables);
    variables.BB_HOST_ID = hostId;
    try {
      return envScript(box.capabilities.os, variables, await this.access(box));
    } catch (error) {
      this.#deps.logError("access", error);
      return undefined;
    }
  }

  /** Writes a file in the box. A relative path is under the box user's home. */
  async writeFile(
    threadId: string,
    ref: string,
    path: string,
    data: Uint8Array,
    options: { mode?: string; signal?: AbortSignal } = {},
  ): Promise<BoxRecord> {
    const box = await this.get(threadId, ref);
    await this.#reach(box, (transport) => transport.writeFile(path, data, options), options.signal);
    return box;
  }

  async readFile(
    threadId: string,
    ref: string,
    path: string,
    options: { maxBytes: number; signal?: AbortSignal },
  ): Promise<{ box: BoxRecord; data: Uint8Array }> {
    const box = await this.get(threadId, ref);
    const data = await this.#reach(box, (transport) => transport.readFile(path, options), options.signal);
    return { box, data };
  }

  /**
   * The safety net, run at start and every few minutes. In order: releases
   * the boxes of threads that ended, finishes interrupted releases and
   * acquires, restores the records of guests whose record was lost, releases
   * guests no box can own, checks power, keeps the spares, and lets each
   * backend do its upkeep. Nothing is released for age or idleness, and no
   * guest because its record is missing: only when BB says its thread was
   * archived or deleted, at this sweep and the last. One answer is not
   * enough to take a live thread's boxes. Spares belong to no thread, so
   * their thread lives.
   */
  async sweep(signal?: AbortSignal): Promise<SweepReport> {
    const own: ThreadAnswer = { state: "live", said: "bb-box's own" };
    const liveness = new Map<string, Promise<ThreadAnswer>>([
      [SPARES, Promise.resolve(own)],
      [OPERATOR, Promise.resolve(own)],
    ]);
    const thread = (threadId: string) => {
      let answer = liveness.get(threadId);
      if (!answer) {
        answer = this.#ask(threadId);
        liveness.set(threadId, answer);
      }
      return answer;
    };
    // "ended" once BB has said so at two sweeps running, "ending" at the first.
    // A thread BB returns archived or deleted and one it does not find count alike.
    const before = this.#ending;
    const ending = (this.#ending = new Set<string>());
    const verdict = async (threadId: string): Promise<{ state: "live" | "unknown" | "ending" | "ended"; said: string }> => {
      const { state, said } = await thread(threadId);
      if (state === "live" || state === "unknown") return { state, said };
      ending.add(threadId);
      return { state: before.has(threadId) ? "ended" : "ending", said };
    };
    let released = 0;
    let leftovers = 0;
    let adopted = 0;
    let kept = 0;
    let waiting = 0;
    let resumed = 0;

    // First, as at the first start after an upgrade: this install's ID goes on
    // the guests of its boxes from before install IDs, which held() and the
    // backends' checks look for (018).
    for (const box of await this.all()) {
      signal?.throwIfAborted();
      if (!box.guest || box.guest.data?.box !== undefined || this.#work.has(box.id)) continue;
      await this.#stamped(box, signal).catch((error) => this.#deps.logError("sweep", error));
    }

    for (const box of await this.all()) {
      signal?.throwIfAborted();
      if (this.#work.has(box.id)) continue;
      try {
        if (box.state === "releasing") {
          resumed++;
          this.#deps.log?.(`Releasing ${describeBox(box)} again: its release had not finished.`);
          await this.#chain(box.id, () => this.#finishRelease(box));
          continue;
        }
        const { state, said } = await verdict(box.threadId);
        if (state === "ended") {
          if (this.#holdsNothing(box)) await this.#forget(box);
          else if ((await this.#release(box, `BB says its thread ended, at this sweep and the last. BB's answer: ${said}`)) === null) released++;
          continue;
        }
        if (state === "ending") {
          waiting++;
          this.#deps.log?.(`Kept ${describeBox(box)}: BB says its thread ended, and the next sweep releases it if BB says so again. BB's answer: ${said}.`);
        }
        if (isAcquiring(box) && box.readyAt === null) {
          resumed++;
          this.#startAcquire(box);
        }
      } catch (error) {
        this.#deps.logError("sweep", error);
      }
    }

    for (const backend of this.#deps.backends.active()) {
      signal?.throwIfAborted();
      let held: HeldGuest[];
      try {
        held = await backend.held(signal);
      } catch (error) {
        this.#deps.logError(`sweep ${backend.id}`, error);
        continue;
      }
      // Read after held(): a guest there was claimed, so recorded, before.
      const records = (await this.all()).filter((box) => box.backend === backend.id);
      const byRef = new Map<string, BoxRecord[]>();
      for (const box of records) if (box.guest) byRef.set(box.guest.ref, [...(byRef.get(box.guest.ref) ?? []), box]);
      /** Boxes whose guest held() listed. */
      const seen = new Set<string>();
      for (const guest of held) {
        signal?.throwIfAborted();
        try {
          // A reused reference may hold another box's guest now. Only an acquire's guest may not name its box yet.
          const record = byRef.get(guest.ref)?.find((box) => (guest.owner ? box.id === guest.owner.boxId : isAcquiring(box)));
          if (record) {
            seen.add(record.id);
            if (!this.#work.has(record.id)) await this.#observe(record, { signal, power: guest.power });
            continue;
          }
          const owner = guest.owner;
          if (!owner) {
            // An acquire interrupted before its guest named a box: no box can own it.
            await this.#releaseLeftover(backend, guest, "it names no box", signal);
            leftovers++;
            continue;
          }
          const owned = records.find((box) => box.id === owner.boxId);
          if (owned) {
            // Its box has another guest now, or none, as after an acquire that tried again or failed.
            if (isAcquiring(owned) || this.#work.has(owned.id)) continue;
            await this.#releaseLeftover(backend, guest, `its box ${owned.name} ${owned.guest ? `has guest ${owned.guest.ref} now` : "holds no guest"}`, signal);
            leftovers++;
            continue;
          }
          // Its record was lost, as when bb-box lost its storage. The guest
          // names its box and thread, so it goes only when the thread ended.
          const { state, said } = await verdict(owner.threadId);
          if (state === "live") {
            if (await this.#restore(backend, guest, signal)) adopted++;
          } else if (state === "ended") {
            await this.#releaseLeftover(backend, guest, `its box's thread ${owner.threadId} ended, as BB says at this sweep and the last. BB's answer: ${said}`, signal);
            leftovers++;
          } else if (state === "ending") {
            this.#deps.log?.(`Kept guest ${guest.ref} of box ${owner.boxId} without a record: BB says thread ${owner.threadId} ended, and the next sweep releases the guest if BB says so again. BB's answer: ${said}.`);
            waiting++;
          } else {
            this.#deps.log?.(`Kept guest ${guest.ref} of box ${owner.boxId} without a record: BB did not say whether thread ${owner.threadId} still exists. BB's answer: ${said}.`);
            kept++;
          }
        } catch (error) {
          this.#deps.logError("sweep", error);
        }
      }
      for (const box of records) {
        if (!box.guest || seen.has(box.id) || this.#work.has(box.id)) continue;
        if (box.state !== "ready" && box.state !== "stopped") continue;
        await this.#observe(box, { signal }).catch((error) => this.#deps.logError("sweep", error));
      }
      for (const box of records) {
        if (!box.restoredAt || !seen.has(box.id) || this.#work.has(box.id)) continue;
        await this.#enrolAnswering(backend, box, signal).catch((error) => this.#deps.logError("sweep", error));
      }
    }

    signal?.throwIfAborted();
    await this.keepSpares();

    // Every built backend, off ones too: an off backend's warm counts read 0, so its upkeep retires its warm guests (029).
    for (const backend of this.#deps.backends.active()) {
      signal?.throwIfAborted();
      await backend.maintain?.(signal).catch((error) => this.#deps.logError(`maintain ${backend.id}`, error));
    }
    return { released, leftovers, adopted, kept, ending: waiting, resumed };
  }

  /** Enrols a restored box whose guest did not answer at the restore, once it runs and answers (026). */
  async #enrolAnswering(backend: Backend, box: BoxRecord, signal?: AbortSignal): Promise<void> {
    if (!(await this.#enrols(box))) return;
    await this.#chain(box.id, async () => {
      const current = await this.#read(box.threadId, box.id);
      if (current?.state !== "ready" || !current.restoredAt || !current.guest) return;
      if (!(await this.#answers(backend, current.guest, current.kind, signal))) return;
      this.#deps.log?.(`Restored box ${current.name} of thread ${current.threadId} answers now, so it enrols again.`);
      const answering = current.error === SILENT ? await this.update(current, () => ({ error: null })) : current;
      if (answering) await this.#enrol(answering, { restored: true });
    });
  }

  async #releaseLeftover(backend: Backend, guest: HeldGuest, reason: string, signal?: AbortSignal): Promise<void> {
    this.#deps.log?.(`Releasing guest ${guest.ref}${guest.owner ? ` of box ${guest.owner.boxId}` : ""}, which no box records: ${reason}.`);
    await backend.release(guest, QUIET, signal);
  }

  /**
   * Rebuilds the record of a live thread's guest, for example after storage
   * was lost, from what the guest names: its box, thread, name, kind and
   * creation, with its reference, address and data. A running guest is ready
   * when its command transport answers, and enrols again as a BB machine with
   * the same key, so BB gives back the machine it still has (025). Any other
   * enrols later, once it runs and answers (026). A box that is BB's machine
   * for its thread, as a "New box", is that machine again and never enrols.
   */
  async #restore(backend: Backend, held: HeldGuest, signal?: AbortSignal): Promise<boolean> {
    const { owner: found, power, ...guest } = held;
    const owner = found!;
    const asked = kindRequest(owner.kind ?? "unknown");
    const kindId = asked.kind;
    const kind = backend.kinds().find((candidate) => candidate.id === kindId);
    const answers = power === "stopped" ? false : await this.#answers(backend, guest, kindId, signal);
    const yours = owner.threadId === OPERATOR;
    const projectId = yours ? null : ((await this.#deps.projectOf?.(owner.threadId).catch(() => null)) ?? null);
    // A thread's own box is BB's machine for the thread still, and must not
    // enrol as another (#127). When BB does not say, the guest waits for the next sweep.
    const machine = yours ? null : ((await this.#deps.machineOf?.(owner.boxId)) ?? null);
    const restored = await this.#locked(owner.threadId, async () => {
      if (await this.#read(owner.threadId, owner.boxId)) return null;
      const existing = await this.list(owner.threadId);
      const taken = new Set(existing.map((box) => box.name));
      const fits = (name: string) => (yours ? isMachineName(name) : isFriendlyName(name)) && !taken.has(name);
      const name = owner.name && fits(owner.name) ? owner.name : generateName(taken, this.#random);
      const box: BoxRecord = {
        id: owner.boxId,
        threadId: owner.threadId,
        projectId,
        name,
        kind: kindId,
        kindLabel: kind?.label ?? (owner.kind ? kindId : "Unknown kind"),
        requires: [...new Set([...(kind?.requires ?? []), ...asked.features])],
        capabilities: kind?.capabilities ?? UNKNOWN_KIND,
        backend: backend.id,
        backendLabel: backend.label,
        nature: backend.nature,
        role: machine ? "machine" : "box",
        guest,
        state: power === "stopped" ? "stopped" : "ready",
        error: power === "stopped" || answers ? null : SILENT,
        createdAt: owner.createdAt ?? this.#now(),
        readyAt: owner.createdAt ?? this.#now(),
        releaseRequestedAt: null,
        resetAt: null,
        timings: {},
        enrol: machine ? { state: "enrolled", hostId: machine, error: null } : { state: "off", hostId: null, error: null },
        restoredAt: machine ? null : this.#now(),
      };
      await this.#deps.kv.set(indexKey(box.id), box.threadId);
      return this.#write(box);
    });
    if (restored) {
      this.#deps.log?.(`Restored box ${restored.name} of thread ${restored.threadId} from guest ${guest.ref}, whose record was lost${machine ? ", as the thread's machine" : ""}. It is ${restored.state}.`);
      // Only a running guest answers.
      if (answers) await this.#enrol(restored, { restored: true }).catch((error) => this.#deps.logError("enrol", error));
    }
    return restored !== null;
  }

  /** Whether a guest's command transport answers, for a box being restored. */
  async #answers(backend: Backend, guest: Guest, kind: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const { command } = await backend.transports(guest, kind);
      return command ? await command.probe(signal) : true;
    } catch (error) {
      if (signal?.aborted) throw error;
      return false;
    }
  }

  /** Cancels acquires in progress, which a restart then resumes, and waits for running tasks. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const controller of this.#acquiring.values()) controller.abort(new BoxError("released", "bb-box is stopping."));
    await this.idle();
  }
}
