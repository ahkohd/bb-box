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
// Storage keys: box/<threadId>/<boxId> holds a BoxRecord, and index/<boxId>
// holds the thread ID, so a box can be found by its ID alone.

import { randomBytes } from "node:crypto";
import type { OfferedKind } from "../backends/index.ts";
import {
  BackendError,
  type AcquireHooks,
  type Backend,
  type BackendStorage,
  type BoxIdentity,
  type BoxKind,
  type BoxTransports,
  type Guest,
  type HeldGuest,
  type KindCapabilities,
  type MachineNature,
  type PowerState,
  type ReleaseHooks,
} from "../backends/types.ts";
import { TransportError, type CommandTransport, type RunResult } from "../transports/types.ts";
import type { GeneralConfig } from "./config.ts";
import { TIMED_OUT_EXITS, canRunInDesktop, command, envScript, type Access, type Session } from "./in-box.ts";
import { generateName, isFriendlyName } from "./names.ts";

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

export interface BoxRecord {
  readonly id: string;
  readonly threadId: string;
  readonly projectId: string | null;
  /** Friendly name, unique within the thread. */
  readonly name: string;
  readonly kind: string;
  readonly kindLabel: string;
  /** The features every offer of the kind has. */
  readonly requires: readonly string[];
  /** The offer's capabilities when the box was acquired. Its features may add to `requires`. */
  readonly capabilities: KindCapabilities;
  readonly backend: string;
  readonly backendLabel: string;
  readonly nature: MachineNature;
  readonly role: BoxRole;
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
  /** Milliseconds per acquire step, "total" from request to ready, and "release.<step>" after a failed release. */
  readonly timings: Readonly<Record<string, number>>;
  readonly enrol: { readonly state: EnrolState; readonly hostId: string | null; readonly error: string | null };
}

export type ThreadLiveness = "live" | "ended" | "unknown";

export interface BoxesDeps {
  readonly kv: BackendStorage;
  readonly backends: {
    get(id: string): Backend | null;
    active(): Backend[];
    kinds(): OfferedKind[];
  };
  general(): Promise<GeneralConfig>;
  /** Tells panels and tools that a thread's boxes changed. */
  notify(threadId: string): void;
  /** A box's record was written, or deleted when `deleted` is true. */
  recorded?(box: BoxRecord, deleted: boolean): void;
  /**
   * Whether a thread still exists and is not archived. "ended" only when BB
   * says so: the sweep releases the thread's boxes and guests on it.
   */
  thread(threadId: string): Promise<ThreadLiveness>;
  /** A thread's project, for a box the sweep restores from its guest. */
  projectOf?(threadId: string): Promise<string | null>;
  /**
   * Enrols a ready box as a BB machine, with the box ID as the key. With
   * `restored`, the sweep has just restored the box, so its enrolment counts
   * from now. Called without awaiting.
   */
  enrol?(box: BoxRecord, options?: { restored?: boolean }): Promise<void>;
  /** Removes a box's BB machine. Awaited before the backend releases the box. */
  unenrol?(box: BoxRecord): Promise<void>;
  /**
   * Starts an enrolled box's BB daemon again after bb-box started the box:
   * BB's bootstrap with the box ID as the key. Called without awaiting.
   */
  reconnect?(box: BoxRecord): Promise<void>;
  /**
   * Which of BB's variables commands in a box enrolled as a BB machine take
   * from its daemon, so they have the thread's access. Null for none.
   */
  access?(box: BoxRecord): Promise<Access | null>;
  logError(operation: string, error: unknown): void;
  /** Records what the sweep did to a guest, and why. */
  log?(message: string): void;
  /** How long a command waits for its box to finish enrolling. */
  readonly enrolWaitMs?: number;
  now?(): number;
  random?(bytes: number): Uint8Array;
}

export type BoxErrorCode =
  | "not_found"
  | "unknown_kind"
  | "limit_reached"
  | "no_capacity"
  | "not_ready"
  | "unsupported"
  | "backend_off"
  | "released"
  | "unreachable";

export class BoxError extends Error {
  readonly code: BoxErrorCode;
  constructor(code: BoxErrorCode, message: string) {
    super(message);
    this.name = "BoxError";
    this.code = code;
  }
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function newBoxId(random: (bytes: number) => Uint8Array): string {
  return `bx${[...random(12)].map((byte) => ID_ALPHABET[byte % 32]).join("")}`;
}

/** Boxes that count against the per-thread limit and hold resources. */
export function isActive(box: BoxRecord): boolean {
  return box.state !== "failed" && box.state !== "gone" && box.state !== "releasing";
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

export function identity(box: BoxRecord): BoxIdentity {
  return { boxId: box.id, threadId: box.threadId, name: box.name, kind: box.kind, createdAt: box.createdAt };
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

/** For releases whose progress nobody watches: leftovers the sweep finds, and guests whose box was forgotten. */
/** How much longer than the timeout in the box bb-box waits before it stops the command itself. */
const LOCAL_TIMEOUT_GRACE_MS = 10_000;
const ENROL_POLL_MS = 250;

const QUIET: ReleaseHooks = { resetting: async () => {}, timing: () => {} };

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
    return (await this.#deps.kv.get<BoxRecord>(recordKey(threadId, boxId))) ?? null;
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
    return boxes.filter((box): box is BoxRecord => !!box).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
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
  async acquire(input: { threadId: string; projectId: string | null; kind: string; role?: BoxRole }): Promise<BoxRecord> {
    const offered = this.#deps.backends.kinds().filter((candidate) => candidate.kind.id === input.kind);
    if (!offered.length) {
      const kinds = this.kinds().map((kind) => kind.id);
      throw new BoxError(
        "unknown_kind",
        kinds.length
          ? `There is no "${input.kind}" kind. The kinds are: ${kinds.join(", ")}.`
          : "No backend is set up, so there are no boxes to acquire. Set one up in bb-box's settings.",
      );
    }
    const role = input.role ?? "box";
    const general = await this.#deps.general();
    const box = await this.#admission.run(() =>
      this.#locked(input.threadId, async () => {
        const existing = await this.list(input.threadId);
        const active = existing.filter((box) => isActive(box) && box.role === "box");
        if (role === "box" && general.perThreadLimit !== null && active.length >= general.perThreadLimit) {
          throw new BoxError(
            "limit_reached",
            `This thread already has ${active.length} boxes, the most allowed: ${active.map((box) => box.name).join(", ")}. Release one first.`,
          );
        }
        const chosen = await this.#choose(offered);
        const box: BoxRecord = {
          id: newBoxId(this.#random),
          threadId: input.threadId,
          projectId: input.projectId,
          name: generateName(new Set(existing.map((box) => box.name)), this.#random),
          kind: chosen.kind.id,
          kindLabel: chosen.kind.label,
          requires: chosen.kind.requires,
          capabilities: chosen.kind.capabilities,
          backend: chosen.backend.id,
          backendLabel: chosen.backend.label,
          nature: chosen.backend.nature,
          role,
          guest: null,
          state: "acquiring",
          error: null,
          createdAt: this.#now(),
          readyAt: null,
          releaseRequestedAt: null,
          resetAt: null,
          timings: {},
          enrol: { state: "off", hostId: null, error: null },
        };
        await this.#deps.kv.set(indexKey(box.id), box.threadId);
        return this.#write(box);
      }),
    );
    this.#startAcquire(box);
    return box;
  }

  /** The first backend with room for the kind, or the reasons none has. */
  async #choose(offered: OfferedKind[]): Promise<OfferedKind> {
    const all = await this.all();
    const reasons: string[] = [];
    for (const candidate of offered) {
      const pending = all.filter((box) => box.backend === candidate.backend.id && isAcquiring(box)).map((box) => box.kind);
      try {
        const capacity = await candidate.backend.capacity(candidate.kind.id, pending);
        if (capacity.ok) return candidate;
        reasons.push(capacity.message ?? `${candidate.backend.label} has no room.`);
      } catch (error) {
        this.#deps.logError("capacity", error);
        reasons.push(describeError(error, `Checking room on ${candidate.backend.label}`));
      }
    }
    throw new BoxError("no_capacity", reasons.join(" "));
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
      guest = await backend.acquire(identity(box), box.guest, hooks, signal);
    } catch (error) {
      // The backend released whatever it claimed before it threw.
      const next = await this.update(box, (current) => {
        if (current.state === "releasing" || this.#disposed) return { guest: null };
        return { state: "failed", guest: null, error: describeError(error, "Acquiring the box"), timings: { ...timings } };
      });
      if (next?.state === "failed") this.#deps.logError("acquire", error);
      return;
    }
    const now = this.#now();
    const next = await this.update(box, (current) =>
      current.state === "releasing"
        ? { guest }
        : { guest, state: "ready", readyAt: now, error: null, timings: { ...timings, total: now - current.createdAt } },
    );
    if (!next) {
      await backend.release(guest, QUIET).catch((error) => this.#deps.logError("release", error));
      return;
    }
    // A release waiting behind this task releases the guest next.
    if (next.state !== "ready") return;
    await this.#enrol(next);
  }

  /** Starts enrolling a ready box as a BB machine, when its kind can enrol and bb-box enrols boxes. */
  async #enrol(box: BoxRecord, options: { restored?: boolean } = {}): Promise<void> {
    const general = await this.#deps.general();
    if (box.capabilities.enrol && general.enrol && this.#deps.enrol) {
      const enrolling = await this.update(box, () => ({ enrol: { state: "enrolling", hostId: null, error: null } }));
      if (enrolling) void this.#deps.enrol(enrolling, options).catch((error) => this.#deps.logError("enrol", error));
    }
  }

  #backendOff(box: BoxRecord): string {
    return `The ${box.backendLabel} backend that holds box ${box.name} is off or its settings need fixing. Fix them in bb-box's settings.`;
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
   * sweep then tries again.
   */
  async release(threadId: string, ref: string): Promise<BoxRecord | null> {
    return this.#release(await this.get(threadId, ref));
  }

  async #release(box: BoxRecord): Promise<BoxRecord | null> {
    const marked = await this.update(box, (current) => ({
      state: "releasing",
      releaseRequestedAt: current.releaseRequestedAt ?? this.#now(),
    }));
    if (!marked) return null;
    this.#acquiring.get(box.id)?.abort(new BoxError("released", `Box ${box.name} was released.`));
    return this.#chain(box.id, () => this.#finishRelease(marked));
  }

  async #finishRelease(initial: BoxRecord): Promise<BoxRecord | null> {
    const box = await this.#read(initial.threadId, initial.id);
    if (!box) return null;
    if (box.enrol.hostId && this.#deps.unenrol) {
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

  /** Releases every box of a thread that ended. Resolves with how many it released. */
  async releaseThread(threadId: string): Promise<number> {
    let count = 0;
    for (const box of await this.list(threadId)) {
      try {
        if (this.#holdsNothing(box)) await this.#forget(box);
        else if ((await this.#release(box)) === null) count++;
      } catch (error) {
        this.#deps.logError("release", error);
      }
    }
    return count;
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

  /** Starts a stopped box, waits until its command transport answers, and reconnects its BB machine. */
  async start(threadId: string, ref: string, signal?: AbortSignal): Promise<BoxRecord> {
    const box = await this.get(threadId, ref);
    return this.#chain(box.id, async () => {
      const current = await this.#stamped((await this.#read(box.threadId, box.id)) ?? box, signal);
      const { start } = this.#stopStart(current);
      if (current.state === "ready") return current;
      this.#require(current, "stopped");
      this.#require((await this.#move(current, "starting")) ?? { ...current, state: "releasing" }, "starting");
      try {
        await start(current.guest!, signal);
      } catch (error) {
        await this.#observe(current, { signal, moving: true }).catch(() => null);
        throw error;
      }
      const started = (await this.#move(current, "ready")) ?? current;
      // A hard stop ends BB's daemon, and nothing in the box starts it again (017).
      if (started.state === "ready" && started.enrol.state === "enrolled" && this.#deps.reconnect) {
        void this.#deps.reconnect(started).catch((error) => this.#deps.logError("reconnect", error));
      }
      return started;
    });
  }

  /** Moves a box to `state` for a stop or start, unless its release began meanwhile. */
  #move(box: BoxRecord, state: "stopping" | "stopped" | "starting" | "ready"): Promise<BoxRecord | null> {
    const moving = state === "stopping" || state === "starting";
    return this.update(box, (current) => (current.state === "releasing" ? {} : moving ? { state, error: null } : { state }));
  }

  /** Throws the reason a box is not in `state`, in words for the user. */
  #require(box: BoxRecord, state: BoxState): void {
    if (box.state === state && box.guest) return;
    const reasons: Record<BoxState, string> = {
      acquiring: `Box ${box.name} is still being acquired. Check its status in a few seconds.`,
      starting: `Box ${box.name} is still starting. Check its status in a few seconds.`,
      ready: `Box ${box.name} is already running.`,
      stopping: `Box ${box.name} is stopping.`,
      stopped: `Box ${box.name} is stopped. Start it first.`,
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
    return this.update(box, (current) => observed(current, power, options.moving));
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
   * thread's access. In a Linux box the timeout stops the script and
   * everything it started, and the local one is a backstop.
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
    if (session === "desktop" && !canRunInDesktop(capabilities.os)) {
      throw new BoxError("unsupported", `bb-box cannot run commands in box ${box.name}'s desktop session yet: its OS is ${capabilities.os}.`);
    }
    const env = await this.#envFile(box);
    options.onSend?.();
    const inBox = capabilities.os === "linux" ? options.timeoutMs : undefined;
    const result = await this.#reach(
      box,
      (transport) =>
        transport.run(command(capabilities.os, script, { cwd: options.cwd, session, env, timeoutMs: inBox }), {
          stdin: options.stdin,
          timeoutMs: inBox === undefined ? options.timeoutMs : inBox + LOCAL_TIMEOUT_GRACE_MS,
          signal: options.signal,
          maxOutputBytes: options.maxOutputBytes,
        }),
      options.signal,
    );
    const stopped = inBox !== undefined && TIMED_OUT_EXITS.includes(result.exitCode ?? -1) && result.durationMs >= inBox;
    return { box, result: stopped ? { ...result, timedOut: true } : result };
  }

  /** Waits a few seconds for a box that is enrolling to finish, and returns it as it is then. */
  async enrolled(box: BoxRecord, signal?: AbortSignal): Promise<BoxRecord> {
    const deadline = this.#now() + (this.#deps.enrolWaitMs ?? 10_000);
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
      const access = (await this.#deps.access?.(box)) ?? undefined;
      return envScript(box.capabilities.os, variables, access);
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
   * guests no box can own, checks power, and lets each backend do its upkeep.
   * Nothing is released for age or idleness, and no guest because its record
   * is missing: only when BB says its thread was archived or deleted.
   */
  async sweep(signal?: AbortSignal): Promise<SweepReport> {
    const liveness = new Map<string, Promise<ThreadLiveness>>();
    const thread = (threadId: string) => {
      let state = liveness.get(threadId);
      if (!state) {
        state = this.#deps.thread(threadId).catch(() => "unknown" as const);
        liveness.set(threadId, state);
      }
      return state;
    };
    let released = 0;
    let leftovers = 0;
    let adopted = 0;
    let kept = 0;
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
          await this.#chain(box.id, () => this.#finishRelease(box));
        } else if ((await thread(box.threadId)) === "ended") {
          if (this.#holdsNothing(box)) await this.#forget(box);
          else if ((await this.#release(box)) === null) released++;
        } else if (isAcquiring(box) && box.readyAt === null) {
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
          const state = await thread(owner.threadId);
          if (state === "live") {
            if (await this.#restore(backend, guest, signal)) adopted++;
          } else if (state === "ended") {
            await this.#releaseLeftover(backend, guest, `its box's thread ${owner.threadId} was archived or deleted`, signal);
            leftovers++;
          } else {
            this.#deps.log?.(`Kept guest ${guest.ref} of box ${owner.boxId} without a record: BB did not say whether thread ${owner.threadId} still exists.`);
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
    }

    for (const backend of this.#deps.backends.active()) {
      signal?.throwIfAborted();
      await backend.maintain?.(signal).catch((error) => this.#deps.logError(`maintain ${backend.id}`, error));
    }
    return { released, leftovers, adopted, kept, resumed };
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
   * the same key, so BB gives back the machine it still has (025).
   */
  async #restore(backend: Backend, held: HeldGuest, signal?: AbortSignal): Promise<boolean> {
    const { owner: found, power, ...guest } = held;
    const owner = found!;
    const kind = backend.kinds().find((candidate) => candidate.id === owner.kind);
    const kindId = owner.kind ?? "unknown";
    const answers = power === "stopped" ? false : await this.#answers(backend, guest, kindId, signal);
    const projectId = (await this.#deps.projectOf?.(owner.threadId).catch(() => null)) ?? null;
    const restored = await this.#locked(owner.threadId, async () => {
      if (await this.#read(owner.threadId, owner.boxId)) return null;
      const existing = await this.list(owner.threadId);
      const taken = new Set(existing.map((box) => box.name));
      const name = owner.name && isFriendlyName(owner.name) && !taken.has(owner.name) ? owner.name : generateName(taken, this.#random);
      const box: BoxRecord = {
        id: owner.boxId,
        threadId: owner.threadId,
        projectId,
        name,
        kind: kindId,
        kindLabel: kind?.label ?? owner.kind ?? "Unknown kind",
        requires: kind?.requires ?? [],
        capabilities: kind?.capabilities ?? UNKNOWN_KIND,
        backend: backend.id,
        backendLabel: backend.label,
        nature: backend.nature,
        role: "box",
        guest,
        state: power === "stopped" ? "stopped" : "ready",
        error:
          power === "stopped" || answers
            ? null
            : "Its guest was running but did not answer when bb-box restored the box's lost record. Stop and start it if commands fail.",
        createdAt: owner.createdAt ?? this.#now(),
        readyAt: owner.createdAt ?? this.#now(),
        releaseRequestedAt: null,
        resetAt: null,
        timings: {},
        enrol: { state: "off", hostId: null, error: null },
      };
      await this.#deps.kv.set(indexKey(box.id), box.threadId);
      return this.#write(box);
    });
    if (restored) {
      this.#deps.log?.(`Restored box ${restored.name} of thread ${restored.threadId} from guest ${guest.ref}, whose record was lost. It is ${restored.state}.`);
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
