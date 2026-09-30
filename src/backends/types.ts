// The backend interface. A backend adapts one provider of machines (Proxmox
// LXC now; Proxmox QEMU, a Mac host, a pool of physical machines, a cloud
// later) to bb-box: acquire and release, address, capacity, and the
// transports that reach each box. bb-box's core depends only on this file and
// src/transports/types.ts, and never names a provider, a hypervisor, a
// container technology or a transport. docs/backends.md explains the design.
//
// A box's life is acquire, then release:
// - A virtual backend acquires by cloning and starting a guest, or by taking
//   a ready one from its warm pool, and releases by deleting it.
// - A real backend acquires by claiming a free machine from a configured pool
//   of existing machines, and releases by resetting it to a clean state and
//   returning it to the pool. It never creates or destroys a machine, and a
//   machine is held by one box, so one thread, at a time.

import type { PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import type { CommandTransport, CommandTransportKind, DisplayEndpoint, DisplayProtocol, GuestOs } from "../transports/types.ts";

export type { GuestOs } from "../transports/types.ts";

/** Whether a backend's boxes are guests it makes and deletes, or existing machines it lends. */
export type MachineNature = "virtual" | "real";

export interface KindCapabilities {
  readonly os: GuestOs;
  /** True for a box with a graphical desktop. */
  readonly desktop: boolean;
  readonly gpu: boolean;
  /** True when Docker runs in the box. */
  readonly docker: boolean;
  /**
   * The transport that runs commands and copies files, or null when bb-box
   * cannot reach inside the box. Commands are in the OS's shell.
   */
  readonly command: CommandTransportKind | null;
  /** The protocol the desktop streams over, or null for a headless box. */
  readonly display: DisplayProtocol | null;
  /** True when the box can enrol as a BB machine, so a thread can run in it. */
  readonly enrol: boolean;
}

/** A kind of box a backend offers, such as linux-headless. */
export interface BoxKind {
  /** Unique across backends. Lower-case letters, digits and "-". */
  readonly id: string;
  readonly label: string;
  /** One sentence for agents and the panel. */
  readonly description: string;
  /** Resources in words, for example "2 cores, 4 GiB memory, 16 GiB disk". */
  readonly size: string;
  readonly capabilities: KindCapabilities;
}

/** The box a backend acquires for, as the registry knows it. */
export interface BoxIdentity {
  readonly boxId: string;
  readonly threadId: string;
  /** Friendly name, unique within the thread. A backend may use it as the hostname. */
  readonly name: string;
  readonly kind: string;
  readonly createdAt: number;
}

/** A backend's handle on the machine behind a box. */
export interface Guest {
  /** The backend's own ID, opaque to the registry: a VMID, a machine name. */
  readonly ref: string;
  /** Where the box answers on the network, when known. Shown to users. */
  readonly address: string | null;
}

export interface BoxOwner {
  readonly boxId: string;
  readonly threadId: string;
  readonly name: string | null;
  readonly kind: string | null;
  readonly createdAt: number | null;
}

/** A guest a backend holds for bb-box, as seen by the safety sweep. */
export interface HeldGuest extends Guest {
  /**
   * The box it was acquired for, or null for a guest an interrupted acquire
   * left behind before it was labelled. The sweep releases those.
   */
  readonly owner: BoxOwner | null;
  readonly power: PowerState;
}

export type PowerState = "running" | "stopped";

export interface AcquireHooks {
  /**
   * Records the guest before the backend makes or changes anything, so a
   * restart can resume the acquire and the sweep can find the guest. Awaited;
   * a backend may call it again if it moves to another guest.
   */
  claim(guest: Guest): Promise<void>;
  /** Moves the box to "starting": the guest exists and is booting. */
  starting(): Promise<void>;
  /** How long a named step took, in milliseconds. Shown in status and the smoke script. */
  timing(step: string, ms: number): void;
}

export interface VirtualCapacity {
  readonly nature: "virtual";
  readonly ok: boolean;
  /** Why a box cannot be acquired now, in words for the user. Null when ok. */
  readonly message: string | null;
  readonly host: string;
  readonly memory: { readonly freeMiB: number; readonly reserveMiB: number };
  readonly disk: { readonly freeGiB: number; readonly reserveGiB: number };
  /** Ready boxes in the warm pool for the kind asked about. */
  readonly warm: number;
}

export interface RealCapacity {
  readonly nature: "real";
  readonly ok: boolean;
  readonly message: string | null;
  /** Machines in the pool that could serve the kind asked about. */
  readonly total: number;
  /** Of those, the ones free now. */
  readonly free: number;
}

export type Capacity = VirtualCapacity | RealCapacity;

/** The transports that reach one box. */
export interface BoxTransports {
  readonly command: CommandTransport | null;
  readonly display: DisplayEndpoint | null;
}

/** Failure codes the registry and tools act on. Any other error is reported as it is. */
export type BackendErrorCode =
  /** The host or pool has no room. The message says why and what to do. */
  | "no_capacity"
  /** The kind cannot do this. */
  | "unsupported"
  /** The guest no longer exists. */
  | "gone";

export class BackendError extends Error {
  readonly code: BackendErrorCode;
  constructor(code: BackendErrorCode, message: string) {
    super(message);
    this.name = "BackendError";
    this.code = code;
  }
}

/**
 * A configured, active backend. Methods that take a guest get the one the
 * backend returned from `acquire`. Every method must be safe to repeat: the
 * registry retries after restarts and the sweep calls `release` for boxes
 * whose release was interrupted.
 */
export interface Backend {
  /** Unique among active backends, stable across restarts. Stored with each box. */
  readonly id: string;
  /** Shown to users, for example "Proxmox LXC on pve". */
  readonly label: string;
  readonly nature: MachineNature;

  /** The kinds this backend can acquire now. */
  kinds(): readonly BoxKind[];

  /**
   * Whether one more box of `kind` fits. `pending` lists the kinds of this
   * backend's boxes still being acquired, which may not show in host figures yet.
   */
  capacity(kind: string, pending: readonly string[], signal?: AbortSignal): Promise<Capacity>;

  /**
   * Makes or claims the guest for `box`, starts it and waits until its
   * command transport answers. `previous` is the guest of an acquire a restart
   * interrupted, which the backend resumes or replaces. On failure the
   * backend releases whatever it claimed before it throws.
   */
  acquire(box: BoxIdentity, previous: Guest | null, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest>;

  /**
   * Deletes a virtual guest, or resets a real machine and returns it to the
   * pool. A guest that no longer exists counts as released.
   */
  release(guest: Guest, signal?: AbortSignal): Promise<void>;

  /** Null when the guest no longer exists. */
  power(guest: Guest, signal?: AbortSignal): Promise<PowerState | null>;
  /** Starts a stopped guest and waits until its command transport answers. */
  start(guest: Guest, signal?: AbortSignal): Promise<void>;
  stop(guest: Guest, signal?: AbortSignal): Promise<void>;

  /** Every guest this backend holds for boxes, for the safety sweep. Excludes free pool members. */
  held(signal?: AbortSignal): Promise<HeldGuest[]>;

  /** The transports that reach a box of `kind`, composed from src/transports. */
  transports(guest: Guest, kind: string): Promise<BoxTransports>;

  /**
   * Checks the setup from end to end and says exactly what is missing: the
   * provider answers, the credentials have the rights they need, each kind's
   * image or template exists, the network is set up. Shown in the panel and
   * by the doctor command.
   */
  doctor(signal?: AbortSignal): Promise<DoctorReport>;

  /** Periodic upkeep, such as topping up a warm pool. Called by the sweep. */
  maintain?(signal?: AbortSignal): Promise<void>;
  dispose?(): Promise<void>;
}

export interface DoctorCheck {
  /** What was checked, for example "Proxmox API". */
  readonly name: string;
  /** Null when the check was skipped because an earlier one failed. */
  readonly ok: boolean | null;
  /** What was found, for example "Proxmox VE 9.2 on pve", or what is wrong. */
  readonly detail: string;
  /** What to do when it failed. */
  readonly fix: string | null;
}

export interface DoctorReport {
  readonly ok: boolean;
  /** One line, for example "Proxmox VE 9.2 on pve". */
  readonly summary: string;
  readonly checks: readonly DoctorCheck[];
  /** Setup notes in plain words, such as a public key to install. Never credentials. */
  readonly notes: readonly string[];
}

/** Storage a backend may use for its own state, such as pool membership. */
export interface BackendStorage {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export interface BackendContext {
  /** Scoped to this backend. */
  readonly storage: BackendStorage;
  logError(operation: string, error: unknown): void;
}

export type ParsedSettings<C> =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly ok: true; readonly config: C }
  | { readonly enabled: true; readonly ok: false; readonly problems: readonly string[] };

/**
 * A backend type built into bb-box. Its settings appear in bb-box's settings
 * under its own prefix, with an enable switch, so several backends can be
 * active at once.
 */
export interface BackendDriver<C = unknown> {
  /** Also the backend ID of its single instance. */
  readonly type: string;
  readonly label: string;
  readonly nature: MachineNature;
  /** Setting keys start with the driver's prefix. One of them enables the backend. */
  readonly settings: Readonly<Record<string, PluginSettingDescriptor>>;
  parse(values: Readonly<Record<string, unknown>>): ParsedSettings<C>;
  create(config: C, context: BackendContext): Backend;
}
