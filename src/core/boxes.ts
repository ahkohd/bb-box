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
} from "../backends/types.ts";
import { TransportError, type CommandTransport, type RunResult } from "../transports/types.ts";
import type { GeneralConfig } from "./config.ts";
import { command } from "./in-box.ts";
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
  /** The kind's capabilities when the box was acquired. */
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
  /** Milliseconds per acquire step, and "total" from request to ready. */
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
  /** Whether a thread still exists and is not archived. */
  thread(threadId: string): Promise<ThreadLiveness>;
  /** Enrols a ready box as a BB machine. Called without awaiting. */
  enrol?(box: BoxRecord): Promise<void>;
  /** Removes a box's BB machine. Awaited before the backend releases the box. */
  unenrol?(box: BoxRecord): Promise<void>;
  logError(operation: string, error: unknown): void;
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
const UNKNOWN_KIND: KindCapabilities = { os: "linux", desktop: false, gpu: false, docker: false, command: null, display: null, enrol: false };

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
  /** Records rebuilt from guests whose record was lost. */
  readonly adopted: number;
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
    this.#deps.notify(box.threadId);
    return box;
  }

  async #forget(box: BoxRecord): Promise<void> {
    await this.#deps.kv.delete(recordKey(box.threadId, box.id));
    await this.#deps.kv.delete(indexKey(box.id));
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
      await backend.release(guest).catch((error) => this.#deps.logError("release", error));
      return;
    }
    // A release waiting behind this task releases the guest next.
    if (next.state !== "ready") return;
    const general = await this.#deps.general();
    if (next.capabilities.enrol && general.enrol && this.#deps.enrol) {
      const enrolling = await this.update(next, () => ({ enrol: { state: "enrolling", hostId: null, error: null } }));
      if (enrolling) void this.#deps.enrol(enrolling).catch((error) => this.#deps.logError("enrol", error));
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
      try {
        await backend.release(box.guest);
      } catch (error) {
        this.#deps.logError("release", error);
        return this.update(box, () => ({
          error: `${sentence(describeError(error, "Releasing the box"))} bb-box tries again in a few minutes.`,
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

  /** Stops a box to free memory while keeping its disk. */
  async stop(threadId: string, ref: string, signal?: AbortSignal): Promise<BoxRecord> {
    const box = await this.get(threadId, ref);
    return this.#chain(box.id, async () => {
      const current = (await this.#read(box.threadId, box.id)) ?? box;
      if (current.state === "stopped") return current;
      this.#require(current, "ready");
      const backend = this.#backend(current);
      await this.update(current, () => ({ state: "stopping", error: null }));
      try {
        await backend.stop(current.guest!, signal);
      } catch (error) {
        await this.#observe(current, { signal, moving: true }).catch(() => null);
        throw error;
      }
      return (await this.update(current, () => ({ state: "stopped" }))) ?? current;
    });
  }

  /** Starts a stopped box and waits until its command transport answers. */
  async start(threadId: string, ref: string, signal?: AbortSignal): Promise<BoxRecord> {
    const box = await this.get(threadId, ref);
    return this.#chain(box.id, async () => {
      const current = (await this.#read(box.threadId, box.id)) ?? box;
      if (current.state === "ready") return current;
      this.#require(current, "stopped");
      const backend = this.#backend(current);
      await this.update(current, () => ({ state: "starting", error: null }));
      try {
        await backend.start(current.guest!, signal);
      } catch (error) {
        await this.#observe(current, { signal, moving: true }).catch(() => null);
        throw error;
      }
      return (await this.update(current, () => ({ state: "ready" }))) ?? current;
    });
  }

  /** Throws the reason a box is not in `state`, in words for the user. */
  #require(box: BoxRecord, state: "ready" | "stopped"): void {
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
    const power = options.power !== undefined ? options.power : await backend.power(box.guest, options.signal);
    return this.update(box, (current) => {
      const settled = current.state === "ready" || current.state === "stopped" || current.state === "gone";
      const moving = (current.state === "stopping" || current.state === "starting") && current.readyAt !== null;
      if (!settled && !(options.moving && moving)) return {};
      if (power === null) return { state: "gone", error: "The guest was deleted outside bb-box." };
      const state = power === "running" ? "ready" : "stopped";
      return current.state === state ? {} : { state, error: null };
    });
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

  /** Runs a script in the box's shell, with the thread's environment. */
  async run(
    threadId: string,
    ref: string,
    script: string,
    options: { stdin?: string | Uint8Array; timeoutMs?: number; cwd?: string; signal?: AbortSignal; maxOutputBytes?: number } = {},
  ): Promise<{ box: BoxRecord; result: RunResult }> {
    const box = await this.get(threadId, ref);
    const result = await this.#reach(
      box,
      (transport) =>
        transport.run(command(box.capabilities.os, script, options.cwd), {
          stdin: options.stdin,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          maxOutputBytes: options.maxOutputBytes,
        }),
      options.signal,
    );
    return { box, result };
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
   * acquires, releases guests no box owns, adopts guests of live threads
   * whose record was lost, checks power, and lets each backend do its upkeep.
   * Nothing is released for age or idleness.
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
    let resumed = 0;

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
      const byRef = new Map(records.filter((box) => box.guest).map((box) => [box.guest!.ref, box]));
      const seen = new Set<string>();
      for (const guest of held) {
        signal?.throwIfAborted();
        seen.add(guest.ref);
        try {
          const record = byRef.get(guest.ref);
          if (record) {
            if (!this.#work.has(record.id)) await this.#observe(record, { signal, power: guest.power });
            continue;
          }
          const owner = guest.owner;
          const owned = owner && records.find((box) => box.id === owner.boxId);
          const state = owner && !owned ? await thread(owner.threadId) : "ended";
          if (state === "live") {
            if (await this.#adopt(backend, guest)) adopted++;
          } else if (state === "ended") {
            // No box owns it: an acquire interrupted before its claim was
            // labelled, a box that moved to another guest, or an ended thread.
            await backend.release(guest, signal);
            leftovers++;
          }
        } catch (error) {
          this.#deps.logError("sweep", error);
        }
      }
      for (const box of records) {
        if (!box.guest || seen.has(box.guest.ref) || this.#work.has(box.id)) continue;
        if (box.state !== "ready" && box.state !== "stopped") continue;
        await this.#observe(box, { signal }).catch((error) => this.#deps.logError("sweep", error));
      }
    }

    for (const backend of this.#deps.backends.active()) {
      signal?.throwIfAborted();
      await backend.maintain?.(signal).catch((error) => this.#deps.logError(`maintain ${backend.id}`, error));
    }
    return { released, leftovers, adopted, resumed };
  }

  /** Rebuilds the record of a live thread's guest, for example after storage was lost. */
  async #adopt(backend: Backend, guest: HeldGuest): Promise<boolean> {
    const owner = guest.owner!;
    return this.#locked(owner.threadId, async () => {
      if (await this.#read(owner.threadId, owner.boxId)) return false;
      const existing = await this.list(owner.threadId);
      const taken = new Set(existing.map((box) => box.name));
      const kind = backend.kinds().find((candidate) => candidate.id === owner.kind);
      const name = owner.name && isFriendlyName(owner.name) && !taken.has(owner.name) ? owner.name : generateName(taken, this.#random);
      const box: BoxRecord = {
        id: owner.boxId,
        threadId: owner.threadId,
        projectId: null,
        name,
        kind: owner.kind ?? "unknown",
        kindLabel: kind?.label ?? owner.kind ?? "Unknown kind",
        capabilities: kind?.capabilities ?? UNKNOWN_KIND,
        backend: backend.id,
        backendLabel: backend.label,
        nature: backend.nature,
        role: "box",
        guest: { ref: guest.ref, address: guest.address },
        state: guest.power === "running" ? "ready" : "stopped",
        error: null,
        createdAt: owner.createdAt ?? this.#now(),
        readyAt: owner.createdAt ?? this.#now(),
        releaseRequestedAt: null,
        timings: {},
        enrol: { state: "off", hostId: null, error: null },
      };
      await this.#deps.kv.set(indexKey(box.id), box.threadId);
      await this.#write(box);
      return true;
    });
  }

  /** Cancels acquires in progress, which a restart then resumes, and waits for running tasks. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const controller of this.#acquiring.values()) controller.abort(new BoxError("released", "bb-box is stopping."));
    await this.idle();
  }
}
