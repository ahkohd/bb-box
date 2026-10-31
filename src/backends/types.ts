// The backend interface. A backend adapts one provider of machines (Proxmox
import type { CheckId } from "../core/checks.ts";
import type { Tailnet } from "../core/tailnet.ts";
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
import type { Arch, CommandTransport, Display, DisplayProtocol, GuestOs, SshAccess } from "../transports/types.ts";
import type { DeviceOffer } from "../core/device.ts";
import type { SlotLender } from "../core/device-host.ts";
import type { MacReport } from "../core/mac-capabilities.ts";
import type { ImageFacts, ImageRecord } from "./images.ts";

export type { Arch, GuestOs } from "../transports/types.ts";

/** The windowing system a Linux desktop runs (048): X11, or Wayland (Sway). A kind without a desktop is "x11" and never shows it. */
export type Windowing = "x11" | "wayland";

/** Whether a backend's boxes are guests it makes and deletes, or existing machines it lends. */
export type MachineNature = "virtual" | "real";

/** What a box of a backend is, as a badge: an LXC or Docker container, a VM, or a physical machine. */
export type BoxForm = "LXC" | "Docker" | "VM" | "microVM" | "Physical";

/** How bb-box runs commands in a box of a kind. */
export interface CommandCapability {
  /** A name for people: "ssh", "docker", "guest-agent". The core never branches on it. */
  readonly transport: string;
  /** The language of the in-box scripts. */
  readonly shell: "sh" | "powershell";
  /** The box user can become root or Administrator. */
  readonly admin: boolean;
  /**
   * Commands already run in the logged-in desktop session. False for SSH on
   * macOS and for OpenSSH or WinRM on Windows, which run outside it.
   */
  readonly inDesktopSession: boolean;
  /** Output arrives while the command runs. */
  readonly streaming: boolean;
}

/** Offers of a kind agree on the driver; each template pins its version. */
export interface ComputerUse {
  readonly driver: "cua";
  readonly version: string;
  /**
   * Where `cua-driver serve` listens: a Unix socket, or a named pipe on
   * Windows. A leading `~/` is the home of the user the driver runs as (047).
   */
  readonly socket: string;
}

export interface DesktopDisplayCapability {
  readonly id: string;
  readonly shows?: "desktop";
  readonly protocol: DisplayProtocol;
  readonly resizable: boolean;
  /**
   * "commands" when the display's stream server moves no clipboard, so
   * bb-box moves it for the viewer with control with commands in the box's
   * desktop session: pbcopy and pbpaste on macOS (#464). Left out, the
   * stream server or the display's own input moves it, if anything does.
   */
  readonly clipboard?: "commands";
  /**
   * "viewer" when the display's stream server never sends again, losslessly,
   * what it sent as JPEG once it stops changing, as wayvnc (056): the viewer
   * asks for it again once the screen is still. Left out, the server does so
   * itself, as Xtigervnc, or sends no JPEG, as QEMU without lossy=on and the
   * Tart holder. QEMU with lossy=on sends one, but partly as JPEG still.
   */
  readonly refresh?: "viewer";
  /**
   * The JPEG quality, 0 to 9, the viewer asks the display's server for, where
   * the viewer's own, 2, is too soft to read in motion: QEMU's JPEG at 2 broke
   * text up, and 4 cost it no more (056). Left out, 2.
   */
  readonly quality?: number;
  /**
   * How bb-box has the display's video draw the box's cursor in, or leave it
   * out: bb-box-stream's BB_CURSOR ("stream"), or Selkies' own
   * SET_NATIVE_CURSOR_RENDERING ("selkies"). Both send the cursor's shape as
   * Selkies' cursor messages. bb-box leaves the cursor out of the video while a
   * person holds control, so the browser's own pointer, with the box's shape,
   * does not trail a drawn one, and draws it in otherwise, so a watcher sees
   * where the agent points (the owner's notes of 17 October 2026). Left out,
   * the stream server decides.
   */
  readonly cursor?: "stream" | "selkies";
  /**
   * A video display the viewer shows only once the person chooses it, by
   * unticking Show as VNC: VNC is the default, as on a Tart Mac, where VNC is
   * already smooth. Left out, video is the default where it can show.
   */
  readonly byChoice?: boolean;
  /**
   * "first" when bb-box tells the video display's stream server a new size
   * before the desktop takes it: Selkies capturing Sway sends black frames at
   * its old size from Sway's resize until it is told; told first, it waits
   * for Sway and sends the new size at once (the owner's note of 18 October
   * 2026). Left out, bb-box tells it once the desktop has the size, as
   * Selkies on X11 needs.
   */
  readonly tellSize?: "first";
  /**
   * "alt-command" for a macOS desktop whose stream server takes Alt as
   * Command and Meta as Option, as Tart's VNC server: the viewer sends Cmd and
   * Option, and the paste chord's Command, so. Left out, Meta is Command and
   * Alt Option, as Screen Sharing and bb-box's own Mac input take them.
   */
  readonly macKeys?: "alt-command";
}

export interface DeviceDisplayCapability {
  readonly id: "device";
  readonly shows: "device";
  readonly protocol: "selkies";
  readonly resizable: false;
  readonly clipboard?: never;
  readonly refresh?: never;
  readonly quality?: never;
  readonly cursor?: never;
  readonly byChoice?: never;
  readonly tellSize?: never;
  readonly macKeys?: never;
}

export type DisplayCapability = DesktopDisplayCapability | DeviceDisplayCapability;

export function displayShows(display: DisplayCapability): "desktop" | "device" {
  return display.shows ?? "desktop";
}

export const DEVICE_DISPLAY: DeviceDisplayCapability = { id: "device", shows: "device", protocol: "selkies", resizable: false };

export function desktopDisplays(displays: readonly DisplayCapability[]): readonly DesktopDisplayCapability[] {
  return displays.filter((display): display is DesktopDisplayCapability => displayShows(display) === "desktop");
}

export function deviceDisplayOf(displays: readonly DisplayCapability[]): DeviceDisplayCapability | null {
  return displays.find((display): display is DeviceDisplayCapability => displayShows(display) === "device") ?? null;
}

/**
 * What a box of one offer has. Offers of one kind agree exactly on os, arch,
 * gpu, computerUse, enrol and having a desktop display; doctor warns when
 * they do not. Transports may differ.
 */
export interface KindCapabilities {
  readonly os: GuestOs;
  readonly arch: Arch;
  readonly gpu: boolean;
  /**
   * This offer's features: the kind's `requires`, and any extras. Words such
   * as "docker", "systemd", "xcode" or "ios-simulator".
   */
  readonly features: readonly string[];
  /** Null when bb-box cannot run commands in the box. */
  readonly command: CommandCapability | null;
  /** One per stream; empty for a headless box. The viewer loads its client before the box exists. */
  readonly displays: readonly DisplayCapability[];
  /** The computer-use driver in the box, reached through the command transport's spawn. Null when there is none. */
  readonly computerUse: ComputerUse | null;
  /** The box can enrol as a BB machine. Only when command.shell is "sh" and os is linux or macos. */
  readonly enrol: boolean;
  readonly device: DeviceOffer | null;
}

/** A kind of box a backend offers, such as linux. */
export interface WithheldKind {
  readonly kind: string;
  readonly why: string;
  readonly passing: boolean;
}

export interface BoxKind {
  /**
   * A shared word that names what the kind promises, never what it lacks.
   * Several backends may offer the same kind. Lower-case letters, digits and "-".
   */
  readonly id: string;
  readonly label: string;
  /** One sentence for agents and the panel. */
  readonly description: string;
  /** The features every offer of this kind has. The agent relies on these only. */
  readonly requires: readonly string[];
  readonly capabilities: KindCapabilities;
  /** The longest an acquire of this kind may take, to ready. */
  readonly readyTimeoutMs: number;
  readonly slotsOnly?: boolean;
}

/** Cores, memory and root disk (028). */
export interface BoxSize {
  readonly cores: number;
  readonly memoryMiB: number;
  /** Null: the backend's base disk, the template's, image's or host's. */
  readonly diskGiB: number | null;
}

/**
 * How a part of a box's size changes on an offer (061): while the box runs
 * and everything in it goes on, with a clean shutdown and start that ends
 * what runs in it, or not at all.
 */
export type ResizeWay = "live" | "restart" | "no";

/** What an offer of a kind can resize, and how (061). */
export interface Resizing {
  readonly cores: ResizeWay;
  readonly memory: ResizeWay;
  /** The root disk, which only grows. */
  readonly disk: ResizeWay;
  /** Cores and memory can go down as well as up, the same way. */
  readonly shrinks: boolean;
}

/** A part of a box's size a resize changes. */
export type SizePart = "cores" | "memory" | "disk";

/** What a resize of one box would do, before anything changes (061). */
export interface ResizePlan {
  /** Each part that changes, from what the box has, in cores, MiB or GiB (null: the base disk), and how. */
  readonly parts: readonly { readonly part: SizePart; readonly from: number | null; readonly to: number; readonly way: ResizeWay }[];
  /** Whether the box's host has room for what it grows by, as capacity says it for a new box. */
  readonly room: Capacity;
  /** About how long a restart takes, in seconds, when a part needs one. */
  readonly downSeconds: number | null;
}

/** The box a backend acquires for, as the registry knows it. */
export interface BoxIdentity {
  readonly boxId: string;
  readonly threadId: string;
  /** Friendly name, unique within the thread. A backend may use it as the hostname. */
  readonly name: string;
  readonly kind: string;
  readonly createdAt: number;
  /**
   * The size asked for, always complete. A virtual backend makes it; a pool
   * claims its smallest free machine of at least that size.
   */
  readonly size: BoxSize;
  /**
   * An image build to start from in place of the kind's standard image, as
   * images.list() gives its reference (049): only on a backend whose images
   * say startsFrom. No warm guest serves such a box.
   */
  readonly from?: string;
}

/** A backend's handle on the machine behind a box. */
export interface Guest {
  /** The backend's own ID, opaque to the registry: a VMID, a machine name. */
  readonly ref: string;
  /** Which of the backend's hosts it is on: a Proxmox node, a Docker host, a Mac. */
  readonly host: string | null;
  /** Where the box answers on the network, when known. Shown to users. */
  readonly address: string | null;
  /** The size the box has, read from the guest; null when unknown. */
  readonly size: BoxSize | null;
  /**
   * Small values the backend needs later, stored with the box and passed
   * back. Never a secret. A backend whose references can be reused keeps the
   * box ID as `box` from the claim on (018).
   */
  readonly data?: Readonly<Record<string, string | number | boolean>>;
  /** Short facts shown in order by status and the panel, such as a desktop's display mode. Stored with the box. Never a secret. */
  readonly facts?: readonly GuestFact[];
  readonly endsAt?: number;
}

export interface GuestFact {
  readonly label: string;
  readonly value: string;
}

/** What a start found changed in the guest. */
export interface Started {
  /** The guest's facts now, in place of those kept, as a desktop's display mode when a GPU desktop fell back to the CPU (#597). */
  readonly facts?: readonly GuestFact[];
}

export interface BoxOwner {
  readonly boxId: string;
  readonly threadId: string;
  readonly name: string | null;
  readonly kind: string | null;
  readonly createdAt: number | null;
}

/** A guest a backend holds for this install, as seen by the safety sweep. */
export interface HeldGuest extends Guest {
  /**
   * The box it was acquired for, or null for a guest an interrupted acquire
   * left behind before it was labelled. The sweep releases those. Its
   * `data.box` is this box's ID, or absent when there is no owner.
   */
  readonly owner: BoxOwner | null;
  /** May lag behind the guest: the sweep asks `power()` before it acts on a change. */
  readonly power: PowerState;
  /** The backend lowered something while the guest started, such as its CPU weight, which `settle` puts back (#888). */
  readonly settling?: boolean;
}

/** "unknown" when the provider cannot tell, for example a machine that does not answer. */
export type PowerState = "running" | "stopped" | "unknown";

/** Why a guest stopped without bb-box's request (#406), as its backend recorded it. */
export interface StopReason {
  /** In words: a sentence or two. */
  readonly reason: string;
  /**
   * The guest did not choose to stop: its VM's process crashed or was
   * killed, or its host restarted. bb-box may start such a guest again.
   */
  readonly crashed: boolean;
  /** When it stopped, in ms since the epoch, when the backend knows. */
  readonly at: number | null;
}

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
  waiting?(words: string | null): Promise<void>;
}

/** Whether one more box fits, with the limits of each host. */
export interface Capacity {
  readonly ok: boolean;
  /** What is full and what to release, in words for the user. Null when ok. */
  readonly message: string | null;
  /** The warm pool for the kind asked about. Null for a real backend, whose free machines are its `machines` limit. */
  readonly warm: { readonly ready: number; readonly target: number } | null;
  readonly hosts: readonly HostCapacity[];
}

/** A box needs all its resources on one host, so limits are per host. */
export interface HostCapacity {
  readonly host: string;
  /** One more box of the kind and size fits on this host. */
  readonly ok: boolean;
  readonly limits: readonly Limit[];
}

/**
 * A GPU's memory as bb-box last read it (#603): from the host's report, where
 * the host makes one, or from inside a box that has the GPU, a GPU desktop's
 * display service as it starts, or nvidia-smi in a running one.
 */
export interface GpuReading {
  /** The GPU, as its desktop templates name it. */
  readonly id: string;
  readonly freeMiB: number;
  /** Null until a running box has read it. */
  readonly totalMiB: number | null;
  /** What a GPU desktop needs free on it. */
  readonly neededMiB: number;
  /** When it was read, in milliseconds since the epoch. */
  readonly at: number;
  /** Who read it: the host, which reports every GPU's memory within seconds of a change, or a desktop that has the GPU. */
  readonly source: "host" | "desktop";
}

/** The room on the GPUs a GPU desktop kind's boxes use (#603). */
export interface GpuRoom {
  /** Each GPU that has been read, as last read. */
  readonly readings: readonly GpuReading[];
  /** Until when a new box is refused, as every GPU was lately read full; null when it is not. */
  readonly fullUntil: number | null;
}

export interface Limit {
  readonly resource: "memory" | "disk" | "cpu" | "guests" | "gpu-desktops" | "gpu-memory" | "machines";
  /** Which one, where there are several: a GPU's index or UUID. */
  readonly id?: string;
  readonly used: number;
  /** Null when there is no known ceiling. */
  readonly total: number | null;
  /** The part kept back for the host. */
  readonly reserve: number;
  readonly unit: "MiB" | "count";
}

/** How the thread's own machine reaches a box. */
export interface BoxAccess {
  /** For `ssh <box name>`. */
  readonly ssh: SshAccess | null;
  /** For DOCKER_HOST, when Docker in the box can be reached directly. */
  readonly dockerHost: string | null;
}

/** The transports that reach one box. */
export interface DaemonKeptByHost {
  readonly installerEnvironment: Readonly<Record<string, string>>;
  readonly daemonPort: number | null;
  takeOver(signal: AbortSignal): Promise<void>;
}

export interface BoxTransports {
  readonly command: CommandTransport | null;
  readonly displays: readonly Display[];
  /** Null when only the BB server can reach the box. */
  readonly access: BoxAccess | null;
  readonly daemonKeptByHost?: DaemonKeptByHost;
}

export interface ReleaseHooks {
  /**
   * Records that the machine is being reset, before it is touched, so a
   * restart finishes the reset rather than lending a dirty machine. Real
   * backends call it; virtual ones need not.
   */
  resetting(): Promise<void>;
  /** How long a named step took, in milliseconds. */
  timing(step: string, ms: number): void;
}

/** A machine in a real backend's pool, or a warm guest, as the panel shows it. */
export interface PoolMember {
  readonly ref: string;
  readonly host: string | null;
  /** The kinds it can serve. */
  readonly kinds: readonly string[];
  readonly state: "free" | "held" | "resetting" | "out-of-service";
  /** Why it is out of service. */
  readonly reason: string | null;
  /** When it entered its state. */
  readonly since: number;
  /** Counts resets, so a claim can check the machine was reset since its last box. */
  readonly generation: number;
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
export type IdentitySource = "eth" | "device" | "value";
export type ForkArming = "network" | "boot";

export interface Backend {
  /** Unique among active backends, stable across restarts. Stored with each box. */
  readonly id: string;
  /** Shown to users, for example "Proxmox LXC on pve". */
  readonly label: string;
  /**
   * Where its boxes run, by name, for the panel: a Proxmox node, each Mac of
   * a Tart backend, a Docker host. Empty for a pool, whose machines are the
   * boxes themselves, and for a local Docker daemon.
   */
  readonly hosts?: readonly string[];
  /**
   * The OS of the machine its boxes run on, for the form's "Runs on" (a Mac,
   * a Linux machine, a Windows PC): a Proxmox node and a pool machine are
   * Linux, a Tart host a Mac, a Docker host as the machine says. Null while
   * not yet known.
   */
  readonly hostOs?: GuestOs | null;
  readonly nature: MachineNature;
  /** Real backends: what a release restores, the box user's home or the whole machine. */
  readonly restores?: "home" | "machine";

  hostEstimates?(): Readonly<Record<string, Readonly<Record<string, number>>>>;

  /** The kinds this backend can acquire now. */
  kinds(): readonly BoxKind[];
  withheldKinds?(kind: string, signal?: AbortSignal): Promise<readonly WithheldKind[]>;

  /**
   * Real backends: how many free machines could take a box of `kind`, from
   * what the backend already holds (its last survey), with no call to any
   * machine: the panel asks on every load. Null until it has surveyed.
   */
  free?(kind: string): number | null;
  /**
   * What this backend's boxes of `kind` are, where box_list should say more
   * than its form: a pool's physical machines, lent whole, with their sizes.
   * From what the backend already holds, with no call to any machine. Never
   * names a machine. Null when it has nothing to add.
   */
  offerNote?(kind: string): string | null;

  /**
   * Whether one more box of `kind` and `size` fits. `pending` gives the kind
   * and size of each of this backend's boxes still being acquired, which may
   * not show in host figures yet. A backend that cannot make the size says
   * so in the message, and the registry tries the next offer.
   */
  capacity(
    kind: string,
    size: BoxSize,
    pending: readonly { readonly kind: string; readonly size: BoxSize }[],
    signal?: AbortSignal,
  ): Promise<Capacity>;

  /**
   * Makes or claims the guest for `box`, starts it and waits until its
   * command transport answers, within the kind's `readyTimeoutMs`.
   * `previous` is the guest of an acquire a restart interrupted, which the
   * backend resumes or replaces. On failure the backend releases whatever it
   * claimed before it throws.
   */
  acquire(box: BoxIdentity, previous: Guest | null, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest>;

  /*
   * `release`, `power`, `start` and `stop` first check that the guest at the
   * reference is still `guest` (018): it names this install and the same box
   * as `guest.data.box`, or no box when that is absent, for an ownerless
   * leftover. A guest that does not is another box's, and counts as gone.
   * Real pools check the reset generation instead (016).
   */

  /**
   * Deletes a virtual guest, or resets a real machine and returns it to the
   * pool. A guest that no longer exists counts as released.
   */
  release(guest: Guest, hooks: ReleaseHooks, signal?: AbortSignal): Promise<void>;

  /**
   * The guest's power now, from the guest or its provider, not from a
   * listing or cache that may lag: the sweep acts on it. Null when the guest
   * no longer exists.
   */
  power(guest: Guest, signal?: AbortSignal): Promise<PowerState | null>;
  /**
   * Starts a stopped guest and waits until its command transport answers.
   * Only where the provider can. Gives `timing` the time each step took,
   * where it times them. Resolves with what changed, where starting can
   * change the guest's facts. Throws BackendError("gone") when the guest no
   * longer exists.
   */
  start?(guest: Guest, signal?: AbortSignal, timing?: (step: string, ms: number) => void, answered?: () => Promise<void>, readyWithinMs?: number): Promise<Started | void>;
  /** Only where the provider can. Throws BackendError("gone") when the guest no longer exists. */
  stop?(guest: Guest, signal?: AbortSignal): Promise<void>;

  /**
   * What the offer of `kind` can resize, and how (061), from what the
   * backend holds, with no call to any host. Null, or no method, when it
   * resizes nothing.
   */
  resizing?(kind: string): Resizing | null;
  /**
   * What resizing `guest`, a box of `kind`, to `to` would do: each part's
   * way for this box, and the room on its host for what it grows by, with
   * `pending` counted as for capacity. Changes nothing. Only backends with
   * `resizing`.
   */
  planResize?(
    guest: Guest,
    kind: string,
    to: BoxSize,
    pending: readonly { readonly kind: string; readonly size: BoxSize }[],
    signal?: AbortSignal,
  ): Promise<ResizePlan>;
  /**
   * Resizes `guest` to `to`, its disk with its file system, and returns the
   * guest with its size read back from it. Safe to repeat: a part already
   * at `to` is left alone. Refuses with BackendError("unsupported") a part
   * that needs a restart unless `restart`, and a disk smaller than the
   * box's. When a step fails, it puts back the parts it changed that can go
   * back before it throws. Only backends with `resizing`.
   */
  resize?(guest: Guest, kind: string, to: BoxSize, options: { readonly restart: boolean }, signal?: AbortSignal): Promise<Guest>;
  /**
   * Whether `stop` saves a guest of the kind with its running session, as a
   * hibernate or a suspend does, so that it holds no memory while stopped
   * and `start` resumes it as it was, BB's daemon included. A spare of such
   * a kind waits stopped (#539).
   */
  keepsSession?(kind: string): boolean;
  savedSessionRestoresWithinMs?(kind: string): number | null;
  /**
   * Why the guest stopped, when bb-box finds it stopped without having
   * stopped it (#406), such as its VM process's exit status and crash
   * report. Null when the backend cannot tell. Only backends that record it.
   */
  stopped?(guest: Guest, signal?: AbortSignal): Promise<StopReason | null>;

  /**
   * Grants a program in the box macOS permissions (058). Throws
   * BackendError("unsupported") with the reason when the machine cannot
   * grant, or will not grant to that program. Only backends that can.
   */
  grant?(guest: Guest, request: GrantRequest, signal?: AbortSignal): Promise<GrantAnswer>;
  /** The box's grants, or null where the guest does not say. Only backends with `grant`. */
  grants?(guest: Guest, signal?: AbortSignal): Promise<BoxGrants | null>;

  /**
   * Every guest this backend holds for this install's boxes, for the safety
   * sweep. Excludes free pool members, and guests with another install's ID
   * or none, which still count against capacity. The owner comes from the
   * guest itself, as its labels, so a new instance on empty storage with the
   * same install ID finds it: the sweep rebuilds lost records from it.
   */
  held(signal?: AbortSignal): Promise<HeldGuest[]>;

  readonly slots?: SlotLender;
  macCapabilities?(): readonly MacReport[];
  restartDeviceServer?(guest: Guest, signal?: AbortSignal): Promise<void>;
  encoderOf?(guest: Guest): MacEncoder | null;
  probeEncoder?(mac: string, signal?: AbortSignal): Promise<number | null>;

  /**
   * Puts back what the backend lowered while a guest started, as its CPU weight (#888): the sweep asks for a ready
   * box's guest that held() said is `settling`, as after a restart of bb-box while it started.
   */
  settle?(guest: Guest, signal?: AbortSignal): Promise<void>;

  /**
   * For a box recorded before install IDs (018): records this install on its
   * guest when the guest has no install and names the box, and returns the
   * guest to store, with the box ID as `data.box`. The registry calls it once
   * per such box, before anything else acts on the guest. Only backends
   * whose guests can predate install IDs.
   */
  stamp?(boxId: string, guest: Guest, signal?: AbortSignal): Promise<Guest>;

  /**
   * The box's owner or name changed, as when a spare is claimed or becomes
   * yours (032, 036): records them on the guest, as its owner for the sweep
   * (019), and gives the guest the box's name inside where it was `from`.
   * Without it, a restored record keeps the owner and name the guest was
   * made with. Best effort: core logs a failure and the box carries on under
   * its old labels, so a backend need not retry.
   */
  relabel?(guest: Guest, box: BoxIdentity, from: string, signal?: AbortSignal): Promise<void>;

  /**
   * Whether `guest`, made as a box of `kind` at `createdAt`, comes from what
   * the backend offers the kind from now, such as one of its templates as
   * built now, so the kind's capabilities describe it too. The core then
   * gives an older box what a new release adds to its kind (#215). False
   * when the backend cannot tell. Without it, the core assumes so.
   */
  asOffered?(guest: Guest, kind: string, createdAt: number, signal?: AbortSignal): Promise<boolean>;

  /**
   * Whether `guest`, made as a box of `kind`, comes from the build of the
   * kind's image that the backend starts boxes from now: false once a
   * refresh (049) has replaced that build, null when the backend cannot
   * tell. The upkeep replaces a kind's spare that is false, so a claim never
   * takes an old build, and never waits for this. Without it, the core
   * cannot tell either, and keeps the spare.
   */
  fromCurrentBuild?(guest: Guest, kind: string, signal?: AbortSignal): Promise<boolean | null>;

  /** What its boxes take that another backend's must not, for the doctor. */
  footprint?(): Footprint;

  /** The command transport, the displays, and how the thread reaches a box of `kind`. */
  transports(guest: Guest, kind: string): Promise<BoxTransports>;

  /**
   * Checks the setup from end to end and says exactly what is missing: the
   * provider answers, the credentials have the rights they need, each kind's
   * image or template exists, the network is set up. Shown in the panel and
   * by the doctor command.
   */
  doctor(signal?: AbortSignal): Promise<DoctorReport>;

  /**
   * Periodic upkeep, such as topping up a warm pool. Called by the sweep,
   * and at once when the configuration changes (#355). A call during a run
   * starts another after it.
   */
  maintain?(signal?: AbortSignal, recordedGuests?: ReadonlySet<string>): Promise<void>;
  snapshotting?(kind: string): Snapshotting | null;
  planSnapshots?(guest: Guest, kind: string, snapshot: SnapshotRef | null, signal?: AbortSignal): Promise<SnapshotPlan>;
  snapshot?(guest: Guest, take: SnapshotTake, hooks: SnapshotHooks, signal?: AbortSignal): Promise<SnapshotTaken>;
  deleteSnapshot?(ref: SnapshotRef, hooks: SnapshotHooks, signal?: AbortSignal): Promise<void>;
  heldSnapshots?(signal?: AbortSignal): Promise<readonly HeldSnapshot[]>;
  snapshotsOn?(guest: Guest, signal?: AbortSignal): Promise<readonly HeldSnapshot[]>;
  providerTask?(task: TaskRef, signal?: AbortSignal): Promise<TaskOutcome>;
  findTasks?(guest: Guest, operation: TaskKind, since: number, signal?: AbortSignal): Promise<readonly TaskRef[]>;
  powerOff?(guest: Guest, signal?: AbortSignal): Promise<void>;
  rollbackSnapshot?(guest: Guest, ref: SnapshotRef, hooks: SnapshotHooks, signal?: AbortSignal): Promise<void>;
  outsideRollbacks?(since: number, signal?: AbortSignal): Promise<readonly OutsideRollback[]>;
  guestIdentity?(guest: Guest, signal?: AbortSignal): Promise<GuestIdentity>;
  copyGuest?(source: Guest, label: HeldCopyLabel, hooks: CopyHooks, signal?: AbortSignal): Promise<Guest>;
  copySnapshot?(ref: SnapshotRef, label: HeldCopyLabel, hooks: CopyHooks, signal?: AbortSignal): Promise<Guest>;
  labelCopy?(copy: Guest, label: HeldCopyLabel, signal?: AbortSignal): Promise<Guest>;
  copyPlan?(copy: Guest, signal?: AbortSignal): Promise<CopyPlan>;
  labelKept?(ref: SnapshotRef, kept: string | null, signal?: AbortSignal): Promise<void>;
  disarmCopy?(copy: Guest, signal?: AbortSignal): Promise<void>;
  templateCopy?(copy: Guest, signal?: AbortSignal): Promise<void>;
  copyState?(copy: Guest, signal?: AbortSignal): Promise<CopyState>;
  deleteCopy?(copy: Guest, signal?: AbortSignal): Promise<void>;
  adoptCopy?(copy: Guest, box: BoxIdentity, identity: GuestIdentity, hooks: CopyHooks, signal?: AbortSignal): Promise<Guest>;
  adoptSnapshot?(ref: SnapshotRef, box: BoxIdentity, identity: GuestIdentity, hooks: CopyHooks, signal?: AbortSignal): Promise<Guest>;
  snapshotBill?(signal?: AbortSignal): Promise<SnapshotBill>;
  retireGuest?(guest: Guest, box: BoxIdentity, signal?: AbortSignal): Promise<Guest>;
  identitySource?(kind: string): IdentitySource | null;
  forkSnapshot?(ref: SnapshotRef, box: BoxIdentity, previous: Guest | null, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest>;
  armFork?(guest: Guest, arming: ForkArming, signal?: AbortSignal): Promise<void>;
  disarmFork?(guest: Guest, signal?: AbortSignal): Promise<void>;
  boxAddresses?(): readonly string[];

  /** Pool members and their state, for the panel. */
  members?(signal?: AbortSignal): Promise<readonly PoolMember[]>;
  /** The GPUs a kind's boxes would use, as last read, without asking the provider (#603). Only backends with GPU desktops. */
  gpuRoom?(kind: string): Promise<GpuRoom>;
  /** Puts back a machine the operator has fixed. */
  returnToService?(ref: string, signal?: AbortSignal): Promise<void>;
  /** Building images in boxes and keeping their builds (049). Only backends that can. */
  readonly images?: BackendImages;
  dispose?(): Promise<void>;
}

export type Holds = "disk" | "disk-and-memory";
export type WhileRunning = "live" | "pauses" | "suspends" | "stopped-only";
export type KeepsPastRelease = "as-is" | "held-copy" | "no";
export type SnapshotScope = "box" | "device";
export type SnapshotGuest = "current" | "earlier" | "held-copy";

export interface Price {
  readonly amount: number;
  readonly currency: "USD" | "EUR";
  readonly per: "day" | "month" | "GB-month";
  readonly known: boolean;
  readonly included?: number;
}

export interface SnapshotBill {
  readonly currency: "USD" | "EUR";
  readonly included: number;
  readonly used: number;
  readonly dailyEach: number;
  readonly refs: readonly string[];
}

export interface Snapshotting {
  readonly scope: SnapshotScope;
  readonly holds: readonly Holds[];
  readonly whileRunning: WhileRunning;
  readonly restore: "in-place" | "new-guest" | "none";
  readonly fork: "copy" | "none";
  readonly keepsPastRelease: KeepsPastRelease;
  readonly lives: "host" | "provider";
  readonly price: Price | null;
  readonly excludes: string | null;
  readonly forkSafeFrom?: number;
  readonly forkWhy?: string;
}

export interface SnapshotStorage {
  readonly key: string;
  readonly name: string;
  readonly type: string;
  readonly percentFull: number;
  readonly metadataPercentFull: number | null;
  readonly metadataUnread: string | null;
  readonly totalBytes: number | null;
  readonly usedBytes: number | null;
}

export interface SnapshotPlan {
  readonly storage: SnapshotStorage;
  readonly take: {
    readonly ok: boolean;
    readonly why: string | null;
    readonly aboutMs: number;
    readonly memoryAboutMs: number | null;
    readonly addsBytes: number | null;
    readonly memory: { readonly storage: SnapshotStorage; readonly addsBytes: number } | null;
    readonly memoryWhy: string | null;
  };
  readonly restore: {
    readonly way: RestoreWay;
    readonly why: string | null;
    readonly undo: "snapshot" | "held-copy" | "suspend-copy" | "none";
    readonly undoAboutMs: number;
    readonly undoBytes: number | null;
    readonly sizeBack: BoxSize | null;
    readonly leavesOnEarlierGuest: number;
    readonly newer: number;
    readonly copyAboutMs: number | null;
    readonly costWords?: string | null;
  };
  readonly keep: { readonly way: KeepsPastRelease; readonly why: string | null; readonly aboutMs: number | null; readonly bytes: number | null; readonly usedBytes?: number | null; readonly price: Price | null };
  readonly fork: { readonly ok: boolean; readonly why: string | null; readonly aboutMs: number; readonly bytes: number | null; readonly size: BoxSize | null };
  readonly locked: { readonly lock: string; readonly fix: string } | null;
  readonly busy?: string | null;
}

export interface SnapshotTake {
  readonly id: string;
  readonly box: string;
  readonly memory: boolean;
  readonly forkSafe?: number | null;
}

export interface SnapshotSize {
  readonly bytes: number;
  readonly means: "own" | "whole";
}

export interface SnapshotTaken {
  readonly ref: string;
  readonly holds: Holds;
  readonly capturedAt: number;
  readonly size: SnapshotSize | null;
}

export interface SnapshotRef {
  readonly id: string;
  readonly ref: string;
  readonly guest: Guest;
  readonly from?: "snapshot" | "held-copy";
}

export interface TaskRef {
  readonly ref: string;
  readonly host: string | null;
}

export type TaskOutcome =
  | { readonly state: "running" }
  | { readonly state: "ok" }
  | { readonly state: "failed"; readonly words: string }
  | { readonly state: "missing"; readonly words: string };

export type TaskKind = "take" | "delete" | "rollback" | "copy";
export type RestoreWay = "rollback" | "rollback-newest-only" | "new-guest" | "none";

export interface SnapshotHooks {
  submitting(): Promise<void>;
  task(task: TaskRef): Promise<void>;
}

export interface CopyHooks extends SnapshotHooks {
  claimed(guest: Guest): Promise<void>;
}

export interface OutsideRollback {
  readonly task: TaskRef;
  readonly guest: string;
  readonly user: string;
  readonly startedAt: number;
  readonly outcome: TaskOutcome;
}

export interface GuestIdentity {
  readonly macs: Readonly<Record<string, string>>;
  readonly smbios: string | null;
}

export interface HeldCopyLabel {
  readonly box: string;
  readonly snapshot: string;
  readonly kept: string | null;
  readonly takenAt?: number;
  readonly forkSafe?: number | null;
  readonly kind?: string;
}

export type CopyState = "template" | "copy" | "gone";

export interface CopyPlan {
  readonly state: CopyState;
  readonly size: BoxSize | null;
  readonly running: boolean;
}

export type HeldSnapshotState = "complete" | "incomplete" | "in-progress";

export interface HeldSnapshot {
  readonly id: string;
  readonly ref: string;
  readonly box: string;
  readonly owner: BoxOwner | null;
  readonly guest: Guest;
  readonly where: SnapshotGuest;
  readonly state: HeldSnapshotState;
  readonly words: string | null;
  readonly holds: Holds;
  readonly takenAt: number | null;
  readonly keptUntil: number | null;
  readonly storage: { readonly name: string; readonly type: string } | null;
  readonly forkSafe?: number | null;
}

export class SnapshotFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotFailed";
  }
}

export class SnapshotIncomplete extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotIncomplete";
  }
}

export class RestoreChanged extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreChanged";
  }
}

/** The macOS permissions bb-box can grant a program in a box (058). */
export const GRANT_PERMISSIONS = ["accessibility", "screen-recording", "input-monitoring", "microphone", "camera", "system-audio", "automation"] as const;
export type GrantPermission = (typeof GRANT_PERMISSIONS)[number];

/** What box_grant asks: a program in the box, and the permissions to grant it (058). */
export interface GrantRequest {
  /** An app's path, or a program's path, in the box. */
  readonly program: string;
  readonly permissions: readonly GrantPermission[];
  /** For automation: the bundle ID of the app the program sends Apple events to. */
  readonly target?: string;
}

/** The answer to a grant, permission by permission. */
export interface GrantAnswer {
  /** What macOS knows the program by: an app's bundle ID, or a program's path. */
  readonly client: string;
  readonly granted: readonly GrantPermission[];
  readonly refused: readonly { readonly permission: string; readonly reason: string }[];
}

/** A box's grants, for box_status. */
export interface BoxGrants {
  /** False where the machine cannot grant, as a Mac with SIP on. */
  readonly canGrant: boolean;
  /** Whether the box user has its code-signing identity, "bb-box local code signing". Null where the machine does not say. */
  readonly signingIdentity: boolean | null;
  readonly grants: readonly { readonly permission: string; readonly client: string; readonly target: string | null }[];
}

/** A warm pool below its count because no host had room for another (#356). */
export interface WarmShortfall {
  /** The kinds whose counts make the pool's. */
  readonly kinds: readonly string[];
  /** The pool's count, and the warm guests it has, ready or being made. */
  readonly count: number;
  readonly have: number;
  /** Why no host had room, as an acquire would be told. */
  readonly reason: string;
}

/**
 * What a backend's boxes take that another backend in the same scope must
 * not, so the doctor can warn when two backends overlap (#194).
 */
export interface Footprint {
  /** Guest IDs it may use, such as a Proxmox cluster's VMIDs. */
  readonly ids?: { readonly scope: string; readonly first: number; readonly last: number };
  /** Addresses its boxes may get, such as those on one node's bridge. */
  readonly addresses?: { readonly scope: string; readonly list: readonly string[] };
  /**
   * Machines it lends whole or makes boxes on, by the address bb-box reaches
   * them at, in lower case, such as a pool's Macs and Tart's hosts (047).
   */
  readonly machines?: readonly string[];
  /**
   * What lending its machines does to anything else on them, which the
   * doctor adds when another backend uses one of them (047).
   */
  readonly machinesNote?: string;
}

export interface DoctorCheck {
  /** Stable, for example "proxmox.api" or "template.linux-desktop": one of the catalog's (src/core/checks.ts). */
  readonly id: CheckId;
  /** What was checked, for example "Proxmox API". */
  readonly name: string;
  /** "skipped" when an earlier check failed. */
  readonly status: "ok" | "warn" | "fail" | "skipped";
  /** What was found, for example "Proxmox VE 9.2 on pve", or what is wrong. */
  readonly detail: string;
  /** What to do when it failed or warns. */
  readonly fix: string | null;
}

export interface DoctorReport {
  /** No check failed. Warnings do not count. */
  readonly ok: boolean;
  /** One line, for example "Proxmox VE 9.2 on pve". */
  readonly summary: string;
  readonly checks: readonly DoctorCheck[];
  /** Setup notes in plain words, such as a public key to install. Never credentials. */
  readonly notes: readonly string[];
}

/** Storage a backend may use for its own state, such as pool membership. */
/**
 * A box bb-box builds or tries an image in (049): not a thread's, not
 * enrolled, and apart from boxes, so no sweep releases it.
 */
export interface ImageBox {
  /** The backend's reference, such as a VMID. */
  readonly ref: string;
  /** Commands as the box user, who has sudo without a password. */
  readonly command: CommandTransport;
  /** How long each step of making it took, in order, where the backend times them: for a build's answer check. */
  readonly steps?: readonly { readonly name: string; readonly ms: number }[];
}

/** A build of an image that a backend keeps: on Proxmox LXC, a template. */
export interface ImageBuild {
  readonly ref: string;
  /** "standard" for a kind's own image, or a project's image's name. */
  readonly image: string;
  /** The kind boxes of it are. */
  readonly kind: string;
  /** Its build ID, or null for one built before build IDs. */
  readonly build: string | null;
  readonly record: ImageRecord | null;
  /** Whether boxes start from it now: a standard image in the configuration. */
  readonly current: boolean;
}

/**
 * A backend's image operations (049). A build runs in a box from a build:
 * the kind's current one for a refresh. The box is captured as a new build,
 * a trial box from it is checked, and then it replaces the current one.
 */
export interface BackendImages {
  /** The builds the backend keeps, and the image boxes left by a build that did not end. */
  list(signal?: AbortSignal): Promise<{ readonly builds: readonly ImageBuild[]; readonly boxes: readonly string[] }>;
  /** Starts a box from `build`, as a box of its kind starts, and waits until it answers. */
  box(build: ImageBuild, label: string, signal: AbortSignal): Promise<ImageBox>;
  /**
   * Stops a build box and keeps it as a build of `image`, with the record in
   * its /usr/share/bb-box/image.json, configured as `from` is. The box is
   * then the build.
   */
  capture(box: ImageBox, from: ImageBuild, image: string, signal: AbortSignal): Promise<ImageBuild>;
  /** Puts `build` in `current`'s place, under its reference, so boxes of the kind start from it. `build` itself goes. */
  replace(build: ImageBuild, current: ImageBuild, signal: AbortSignal): Promise<ImageBuild>;
  /** Removes an image box or a build that is not current. */
  remove(ref: string, signal?: AbortSignal): Promise<void>;
  /**
   * Builds a new build of a standard image from `setup`, a copy of the
   * plugin's setup/ with the versions a rebuild takes, without a box: for a
   * backend whose standard images come from a build script, as Docker's do
   * (049). A refresh then checks it on a trial box, as a capture.
   */
  build?(current: ImageBuild, setup: string, options: { readonly bbUrl: string | null; readonly log: (line: string) => void; readonly signal: AbortSignal }): Promise<ImageBuild>;
  /**
   * Why the backend cannot take a refresh's build now, beyond the room for
   * its boxes, such as disk where it builds; null when it can. The refresh
   * then waits for the next night, and the doctor says why.
   */
  room?(build: ImageBuild, signal?: AbortSignal): Promise<string | null>;
  /** The kind's check a trial box runs as the box user, printing a line per check with ok or FAIL, where it is not the template's own. */
  check?(kind: string): string;
  /**
   * The kind's shared check, Windows' setup/windows/check.ps1 (054), as this
   * backend's boxes run it, where a check there differs: `setup` is the
   * plugin's setup/ directory.
   */
  adaptCheck?(kind: string, check: string, setup: string): string;
  /** Whether acquire starts a box from a build in BoxIdentity.from (049). */
  readonly startsFrom?: boolean;
  /**
   * Whether bb-box keeps a spare of a project's image built here (#440): a
   * running, enrolled box. Not on Tart, where a Linux VM cannot be suspended
   * and a spare would hold its whole memory.
   */
  readonly spares?: boolean;
  /** Whether it refreshes its Windows images, in a box (054). */
  readonly windows?: boolean;
}

export interface BackendStorage {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export interface BackendContext {
  /** The backend's ID: its type, or "<type>:<name>" for another of the type (029). */
  readonly id: string;
  /** Scoped to this backend. */
  readonly storage: BackendStorage;
  /**
   * This bb-box install's ID (018). A backend records it on every guest from
   * its first write, warm and part-made guests too, and acts only on guests
   * that carry it.
   */
  readonly installId: string;
  /**
   * Ready guests to keep for a kind: the configuration's count, or 0 while
   * the backend or the kind is off. Read it each time it is needed: a switch
   * or a count changes it without the backend being built again.
   */
  warm(kind: string): number;
  /** Whether a host takes new boxes. Read each time, like `warm`. */
  hostOn(name: string): boolean;
  /** What the configuration says now about a kind here. Read each time, like `warm`. */
  kind(id: string): KindSettings;
  /**
   * Whether bb-box makes new boxes BB machines, as the configuration says
   * now, so a warm guest can be readied for that before its claim. Read each
   * time, like `warm`. Absent where there is no BB.
   */
  enrols?(): boolean;
  tailnet?(): Tailnet | null;
  bbUrl?(): string | null;
  /** BB machines bb-box reaches through BB (042). Absent where there is no BB, as in the conformance run. */
  readonly machines?: MachineAccess;
  /** What the doctor judges images by (049). Absent where bb-box cannot tell, as in the conformance run. */
  readonly images?: ImageFacts;
  /**
   * Tells bb-box which warm pools an upkeep that ran to its end left short
   * for want of room (#356), for the log, the doctor and the settings.
   */
  warmShortfalls(short: readonly WarmShortfall[]): void;
  logError(operation: string, error: unknown): void;
  /** Says what the backend did by itself, as removing what a run left, for bb-box's log. */
  log?(message: string): void;
  /**
   * Says that a kind's capabilities changed by themselves, as when a host
   * reports its video ready after bb-box restarted, so boxes of the kind
   * take them, as they do at bb-box's start (#215), not only new boxes.
   */
  kindsChanged?(): void;
  factsChanged?(): void;
  readonly encoder?: EncoderAccess;
}

export interface MacEncoder {
  readonly mac: string;
  readonly chip: string | null;
  readonly hardware?: boolean | null;
  readonly cores?: number | null;
}

export interface EncoderAccess {
  load(mac: string): number;
  vmStarting(mac: string, chip: string | null): void;
}

/**
 * How a backend reaches a BB machine through bb-box (042): Docker there,
 * through bb-box's relay, and the machine as BB has it, with no call to it.
 */
export interface MachineAccess {
  /**
   * The docker CLI's host for BB machine `hostId`: a unix socket on BB's
   * server that bb-box relays to Docker on the machine. It is the same each
   * time; await `ready` before the first use.
   */
  dockerHost(hostId: string): string;
  /** Listens on the machine's socket, and fails at once, saying so, when BB shows the machine offline. */
  ready(hostId: string): Promise<void>;
  /** The machine's name as BB has it, or null while bb-box does not know it. */
  name(hostId: string): string | null;
  /** The OS of BB machine `hostId`, as bb-box's host entry there reported it (a Windows PC's BB daemon runs in WSL and says windows), or null until it has. */
  platform?(hostId: string): GuestOs | null;
  /** Whether BB shows the machine connected now and has heard from it lately, with no call to it. Null when BB has no such machine. */
  connected(hostId: string): Promise<boolean | null>;
  /** bb-box's msb on BB machine `hostId`, which its host entry runs there (053). */
  msb?(hostId: string): MsbAccess;
}

/** The scripts bb-box runs on an msb host (src/backends/microsandbox/release.ts). */
export type MsbScriptName = "install" | "status" | "images" | "import" | "disk" | "undisk" | "disks" | "memory" | "oom" | "transfer" | "retag";

/** How a backend runs bb-box's msb on a BB machine, through bb-box's msb relay (053). */
export interface MsbAccess {
  /**
   * The command line on BB's server that runs the machine's msb with
   * `args`, on a PTY there with `tty`: stdin, stdout, stderr and the exit
   * status are the run's. It is the same each time; await `ready` first.
   */
  argv(args: readonly string[], options?: { readonly tty?: boolean }): [string, ...string[]];
  /** Listens on the machine's relay socket, and fails at once, saying so, when BB shows the machine offline. */
  ready(signal?: AbortSignal): Promise<void>;
  /** Runs one of bb-box's msb scripts on the machine. */
  script(name: MsbScriptName, args: readonly string[], signal?: AbortSignal): Promise<{ readonly dir: string; readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }>;
}

/** A kind as the configuration has it now (028, 029). Its sizes are the same on every backend. */
export interface KindSettings {
  /** Off when the kind or this backend is: no new boxes of the kind here, and no warm guests. */
  readonly enabled: boolean;
  /** The size of a box made with no size asked for. */
  readonly defaultSize: BoxSize;
  /** Every preset's size, the default's among them, smallest first. */
  readonly presets: readonly BoxSize[];
}

/** A driver's settings parsed from flat keys, as its tests and the smoke script give them. */
export type ParsedSettings<C> =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly ok: true; readonly config: C }
  | { readonly enabled: true; readonly ok: false; readonly problems: readonly string[] };

/** Where the settings page shows a field (029). */
export type FieldGroup = "connection" | "credentials" | "boxes" | "ios-hosts" | "advanced";

/** A field of a backend or of its hosts: BB's setting descriptor and its group. */
export type FieldDescriptor = PluginSettingDescriptor & { readonly group: FieldGroup };

export type FieldValue = string | number | boolean;

/**
 * A field's label from the BB setting it was before 029: without the
 * backend's name in front, such as "Proxmox LXC: ", and with a capital, as
 * the settings page shows it under the backend's own heading.
 */
export function fieldLabel(settingLabel: string): string {
  const label = settingLabel.replace(/^[^:]+: /, "");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function helpParts(help: string): { readonly lead: string; readonly more: string } {
  const end = help.search(/[.!?]\s/);
  if (end === -1) return { lead: help.trim(), more: "" };
  return { lead: help.slice(0, end + 1).trim(), more: help.slice(end + 1).trim() };
}

/** A field BB would keep as a secret: write-only, and kept apart from the configuration. */
export function isSecret(field: PluginSettingDescriptor): boolean {
  return field.type === "string" && field.secret === true;
}

/** A problem with the configuration, at its field's path, such as "url" or "hosts.0.address". */
export interface FieldProblem {
  readonly path: string;
  readonly message: string;
}

/** A backend's part of bb-box's configuration, as its driver parses it. */
export interface BackendPart {
  readonly id: string;
  /** Every declared field: the operator's value or the declared default. Secrets included. */
  readonly fields: Readonly<Record<string, FieldValue | undefined>>;
  readonly hosts: readonly { readonly name: string; readonly fields: Readonly<Record<string, FieldValue | undefined>> }[];
}

export type ParsedBackend<C> =
  | { readonly ok: true; readonly config: C }
  | { readonly ok: false; readonly problems: readonly FieldProblem[] };

/** What a driver read from BB's settings before 029, for the move into the document. */
export interface EarlierBackend {
  /** The backend's switch as it was. */
  readonly enabled: boolean;
  /** Fields whose value differs from their default. */
  readonly fields: Readonly<Record<string, FieldValue>>;
  /** Secret fields that were set. */
  readonly secrets: Readonly<Record<string, string>>;
  /** Ready guests per kind. */
  readonly warm: Readonly<Record<string, number>>;
  readonly hosts?: readonly { readonly name: string; readonly enabled: boolean; readonly fields: Readonly<Record<string, FieldValue>> }[];
  /** What did not move as it was, in words, for the copy. */
  readonly notes?: readonly string[];
}

/**
 * A backend type built into bb-box. The configuration lists its backends,
 * each with this driver's fields, and the settings page shows them (029).
 */
export interface BackendDriver<C = unknown> {
  /** Also the ID of the first backend of the type. */
  readonly type: string;
  readonly label: string;
  /** One line on what the backend is for, shown while it is off. */
  readonly description: string;
  readonly nature: MachineNature;
  /** What its boxes are, as the panel's badge says. */
  readonly form: BoxForm;
  readonly family?: string;
  /** The kinds its backends can make, which take warm counts. */
  readonly kinds: readonly string[];
  readonly warmKinds?: readonly string[];
  readonly sharedKinds?: readonly string[];
  /** In the order the settings page shows them. */
  readonly fields: Readonly<Record<string, FieldDescriptor>>;
  /** Fields of each host, for a backend whose hosts are set up alike. Hosts have a name and a switch besides. */
  readonly hostFields?: Readonly<Record<string, FieldDescriptor>>;
  readonly offWhenEmpty?: readonly string[];
  /**
   * Fields a backend may leave empty to take the values of the first backend
   * of type `from`, such as the connection to a host another backend already
   * uses. Each set goes together, and only when all its fields are empty
   * here, so a connection is never part one backend's and part the other's.
   */
  readonly inherits?: { readonly from: string; readonly sets: readonly (readonly string[])[] };
  /**
   * For a type the configuration may have several backends of, each on a
   * host of its own (042): the host its fields name, which no two of them
   * may share, since each lists its guests on its host.
   */
  readonly several?: (fields: Readonly<Record<string, unknown>>) => string;
  /**
   * Paths in bb-box's repository. The guide is the entry point: the settings
   * page links it first, then the scripts in the order the guide runs them.
   */
  readonly setup: { readonly guide: string; readonly scripts: readonly string[]; readonly needs?: string };
  /** Checks the backend's part and gives each problem at its field. */
  parse(part: BackendPart): ParsedBackend<C>;
  create(config: C, context: BackendContext): Backend;
  /**
   * The BB settings the driver declared before 029, read once when they
   * move into the configuration. The keys start with the driver's type.
   */
  readonly earlier?: {
    readonly settings: Readonly<Record<string, PluginSettingDescriptor>>;
    /** Null when none of its settings was set, so the backend is not in the configuration. */
    read(values: Readonly<Record<string, unknown>>): EarlierBackend | null;
    /** Sizes per kind its settings gave boxes before 028, which become the kinds' default presets once. */
    sizes?(values: Readonly<Record<string, unknown>>): Readonly<Record<string, BoxSize>>;
  };
}
