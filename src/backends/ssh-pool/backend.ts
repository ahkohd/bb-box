// The SSH host pool backend. It lends Linux machines and Macs the operator
// already has, reached over SSH, one box per machine. bb-box logs in as its
// admin user on each machine and runs only its helper as root through sudo:
// setup/ssh-pool/machine.sh, or machine-mac.sh on a Mac. The helper claims
// the machine for a box by making a new user for it, bbx-<generation>, whose
// SSH the box's commands use, and releases it by removing that user and
// everything the user left. The reset generation counts completed resets: a
// claim names the generation it expects, so a machine is never lent twice
// without a reset between.
//
// The truth is on the machine (016, 018). The helper's markers in
// /var/lib/bb-box, or /var/db/bb-box on a Mac, say which install and box
// hold it, or that it is being reset, and every method reads them before it
// acts. bb-box's storage keeps only what the machine cannot say: that a
// machine is out of service and why, the generation it last saw, and the
// box on a machine that does not answer. A new instance on empty storage
// finds every box from the markers.
//
// A reset that fails puts the machine out of service. It comes back when
// returnToService resets it again, or when the operator runs the helper's
// reset on the machine, which bb-box sees as a clean machine at a later
// generation.
//
// A Mac (047) has no whole-machine reset. Its reset makes the next box's
// user ahead and signs it in at the console, so a free Mac is a warm box.
// The box's desktop is the console, through Screen Sharing, which the relay
// signs in to as the box user with a password the helper gives for each
// connection. The macOS offers have xcode, and ios-simulator, while every
// Mac serving them that answered the last survey has Xcode, and an iOS
// runtime.

import type { CheckId } from "../../core/checks.ts";
import {
  BackendError,
  type AcquireHooks,
  type Backend,
  type BackendContext,
  type BoxIdentity,
  type BoxKind,
  type BoxOwner,
  type BoxSize,
  type BoxTransports,
  type Capacity,
  type CommandCapability,
  type DoctorCheck,
  type ComputerUse,
  type DoctorReport,
  type Footprint,
  type Guest,
  type GuestFact,
  type HeldGuest,
  type PoolMember,
  type PowerState,
  type ReleaseHooks,
} from "../types.ts";
import { sizesCheck } from "../fit.ts";
import { quote } from "../../transports/process.ts";
import { pause, waitUntilAnswers } from "../../transports/ready.ts";
import { KeyFile, Ssh, SshTransport, generateKeyPair, publicKey } from "../../transports/ssh.ts";
import type { Arch, Display, DisplayInput, DisplayInputEvents, DisplayOpened, RunResult, SshAccess } from "../../transports/types.ts";
import { command as inBoxCommand } from "../../core/in-box.ts";
import { MacInput, macInputCommand } from "../../core/mac-input.ts";
import { CUA_VERSION } from "../tart/backend.ts";
import { EXAMPLE, hostKeysFor, type SshPoolConfig, type SshPoolHost, type SshPoolKind, type SshPoolMachine } from "./config.ts";
import { EXIT, HELPER_COMMAND, HELPER_VERSION, claimInput, fields, parseDisplay, parseStatus, releaseInput, type MacStatus, type MachineStatus, type Marker, type Xcode } from "./protocol.ts";

const SSH_KEY = "ssh-key";
const RECORD = "machine/";
const USER_PREFIX = "bbx-";
/** The architecture each OS's offers promise, so every machine of it must have. */
const ARCH: Readonly<Record<SshPoolMachine["os"], Arch>> = { linux: "x86_64", macos: "arm64" };
/** The pool's single entry in capacity. */
const POOL_HOST = "SSH host pool";
/** Claiming makes a user; SSH as it answers at once. This leaves room for a slow machine or jump host. */
const READY_TIMEOUT_MS = 60_000;
const STATUS_TIMEOUT_MS = 20_000;
const CLAIM_TIMEOUT_MS = 60_000;
/** The helper waits this long for its lock, and a whole-machine reset may take as long. */
const RESET_TIMEOUT_MS = 15 * 60_000;
const RESET_POLL_MS = 2_000;
/**
 * How long a Mac in a reset may not answer before the pool takes it out of
 * service. Its reset restarts userspace, and macOS 27 can panic and restart
 * the whole Mac then, which keeps it off its network for about a minute
 * (047's live check).
 */
const MAC_SILENCE_MS = 5 * 60_000;
/** A Mac's claim waits for SSH, the box user at the console and, for a desktop, Cua's socket (047). */
const MAC_READY_TIMEOUT_MS = 3 * 60_000;
const MAC_READY_POLL_MS = 1_000;
/** How long the input helper may take to start in the box user's desktop session. */
const INPUT_START_MS = 15_000;

/** Screen Sharing, which a Mac's display reaches through the box user's SSH. */
const SCREEN_SHARING_PORT = 5900;
/** The Cua Driver setup-mac.sh installs, as Tart's image does, with its socket in the box user's home. */
const MAC_CUA: ComputerUse = { driver: "cua", version: CUA_VERSION, socket: "~/Library/Caches/cua-driver/cua-driver.sock" };

const SSH_COMMAND: CommandCapability = { transport: "ssh", shell: "sh", admin: false, inDesktopSession: false, streaming: true };

/** The pool's one offer. With Docker, which gives root, only when every machine has a whole-machine reset (041). */
function linuxOffer(docker: boolean): BoxKind {
  return {
    id: "linux",
    label: "Linux",
    description: docker
      ? "A Linux machine of its own with Docker, and root through sudo, for builds, backend services and the agent's own work."
      : "A Linux machine of its own, for builds, backend services and the agent's own work.",
    requires: [],
    capabilities: {
      os: "linux",
      arch: ARCH.linux,
      gpu: false,
      features: docker ? ["docker"] : [],
      command: docker ? { ...SSH_COMMAND, admin: true } : SSH_COMMAND,
      displays: [],
      computerUse: null,
      enrol: true,
    },
    readyTimeoutMs: READY_TIMEOUT_MS,
  };
}

/** A Mac's offers (047): its box user at the console, with the desktop and computer use for macos-desktop, and Xcode when every Mac has it. */
function macOffer(desktop: boolean, features: readonly string[]): BoxKind {
  const tools = features.includes("ios-simulator") ? " It has Xcode and the iOS Simulator." : features.includes("xcode") ? " It has Xcode." : "";
  return {
    id: desktop ? "macos-desktop" : "macos",
    label: desktop ? "macOS desktop" : "macOS",
    description: desktop
      ? `A Mac of its own, with its desktop shown in the panel and computer use, for Apple's tools and apps.${tools}`
      : `A Mac of its own, for builds and Apple's tools. Its desktop is not shown.${tools}`,
    requires: [],
    capabilities: {
      os: "macos",
      arch: ARCH.macos,
      gpu: false,
      features,
      command: SSH_COMMAND,
      displays: desktop ? [{ id: "desktop", protocol: "rfb", resizable: false }] : [],
      computerUse: desktop ? MAC_CUA : null,
      enrol: true,
    },
    readyTimeoutMs: MAC_READY_TIMEOUT_MS,
  };
}

export interface SshPoolBackendOptions {
  readonly sshBinary?: string;
  /** Replaces the command that runs the helper as root, for tests. */
  readonly helperCommand?: string;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Replaces each kind's readyTimeoutMs, for tests. */
  readonly readyTimeoutMs?: number;
  /** How long a reset may take, and how often a whole-machine reset is checked. For tests. */
  readonly resetTimeoutMs?: number;
  readonly resetPollMs?: number;
  /** How long a Mac in a reset may not answer before it goes out of service (MAC_SILENCE_MS). */
  readonly macSilenceMs?: number;
}

/** What bb-box keeps about a machine. The machine's markers say the rest. */
interface MachineRecord {
  readonly state: PoolMember["state"];
  readonly since: number;
  /** The machine's reset generation when the record was written. */
  readonly generation: number;
  readonly reason: string | null;
  /** The box that holds it, for when the machine does not answer. */
  readonly owner: BoxOwner | null;
  readonly user: string | null;
}

/** What the helper's status said, or why it said nothing. */
interface Probe {
  readonly status: MachineStatus | null;
  /** True when SSH itself failed. */
  readonly unreachable: boolean;
  readonly problem: string | null;
}

/** A machine as bb-box sees it now. */
interface View {
  readonly machine: SshPoolMachine;
  readonly probe: Probe;
  readonly record: MachineRecord | null;
  readonly state: PoolMember["state"];
  readonly reason: string | null;
  readonly generation: number;
  readonly since: number;
}

/** A box being acquired, as capacity sees it. */
interface Acquiring {
  readonly kind: string;
  readonly size: BoxSize;
}

interface SshKeys {
  readonly ssh: Ssh;
  readonly publicKey: string | null;
  readonly generated: boolean;
}

type Check = readonly [id: CheckId, name: string];
/** What a machine's checks are of: machine.<name>.<what> in the catalog. */
type MachineCheck = "ssh" | "sizes" | "helper" | "arch" | "tools" | "docker" | "state" | "filevault" | "signin" | "fulldisk" | "homes" | "sip" | "screensharing" | "grants" | "xcode" | "input";
const SSH_KEY_CHECK: Check = ["ssh.key", "SSH key"];
const MACHINES_CHECK: Check = ["machines", "Machines"];
const DOCKER_CHECK: Check = ["docker", "Docker"];
const XCODE_CHECK: Check = ["xcode", "Xcode"];

const QUIET: ReleaseHooks = { resetting: async () => {}, timing: () => {} };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The last lines of a command's error output, for a reason or a doctor check. */
function said(result: RunResult): string {
  const text = result.stderr.trim().split("\n").slice(-3).join(" ").trim();
  if (text) return text.replace(/\.?$/, ".");
  return result.timedOut ? "It did not finish in time." : `It exited with ${result.exitCode}.`;
}

function whole(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function ownerOf(box: BoxIdentity): BoxOwner {
  return { boxId: box.boxId, threadId: box.threadId, name: box.name, kind: box.kind, createdAt: box.createdAt };
}

function markerOwner(marker: Marker): BoxOwner | null {
  if (!marker.box) return null;
  return { boxId: marker.box, threadId: marker.thread ?? "", name: marker.name, kind: marker.kind, createdAt: marker.createdAt };
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function gib(mib: number): string {
  return `${Number((mib / 1024).toFixed(1))} GiB`;
}

/** A size in words, as core gives it. */
function sizeWords(size: BoxSize): string {
  return [plural(size.cores, "core"), `${gib(size.memoryMiB)} memory`, ...(size.diskGiB !== null ? [`${size.diskGiB} GiB disk`] : [])].join(", ");
}

/** What a machine says it has, in words. */
function hasWords(status: MachineStatus | null): string[] {
  return [
    status?.cores ? plural(status.cores, "core") : "",
    status?.memoryMiB ? `${gib(status.memoryMiB)} memory` : "",
    status?.diskGiB !== null && status?.diskGiB !== undefined ? `${status.diskGiB} GiB free disk` : "",
  ].filter(Boolean);
}

/** A machine's cores and memory. The disk is the machine's, so it is null. */
function machineSize(status: MachineStatus | null): BoxSize | null {
  return status?.cores && status.memoryMiB ? { cores: status.cores, memoryMiB: status.memoryMiB, diskGiB: null } : null;
}

/**
 * The machine is at least the size. The kernel keeps some memory from
 * MemTotal, so a machine has memory M when it shows 90% of it, the margin
 * the conformance suite allows. A disk size needs that much free.
 */
function fits(status: MachineStatus | null, size: BoxSize): boolean {
  const has = machineSize(status);
  if (!has || has.cores < size.cores || has.memoryMiB < size.memoryMiB * 0.9) return false;
  return size.diskGiB === null || (status!.diskGiB ?? 0) >= size.diskGiB;
}

/** BB's installer needs Node.js 22.19 or newer. */
function nodeFits(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 19);
}

const NODE_FIX =
  "Install Node.js 22.19 or newer with npm, such as Node.js 24 from NodeSource or nodejs.org. Debian's and Ubuntu's own nodejs is too old. BB's installer needs it to enrol a box.";
const GIT_FIX = "Install git and gh. On Debian or Ubuntu: sudo apt-get install git gh.";
const MAC_NODE_FIX = "Install Node.js 22.19 or newer with Homebrew: brew install node. BB's installer needs it to enrol a box.";
const MAC_GIT_FIX = "Install git and gh with Homebrew: brew install git gh.";
const FULL_DISK_FIX = "In System Settings, General, Sharing, select the (i) beside Remote Login, and turn on Allow full disk access for remote users.";

/** The setup script for the machine, and how to run it. */
function setupWords(machine: SshPoolMachine): string {
  return machine.os === "macos" ? "setup/ssh-pool/setup-mac.sh" : "setup/ssh-pool/setup.sh";
}

function setupAs(machine: SshPoolMachine): string {
  return machine.os === "macos" ? "with sudo" : "as root";
}

/** Where the helper keeps its state. */
function stateDir(machine: SshPoolMachine): string {
  return machine.os === "macos" ? "/var/db/bb-box" : "/var/lib/bb-box";
}

/** The helper's mode for a release or reset: "machine" only for a Linux machine with a whole-machine reset. A Mac has none (047). */
function resetMode(machine: SshPoolMachine): string[] {
  return machine.os === "linux" && machine.reset === "machine" ? ["machine"] : [];
}

/** Why a free Mac cannot take a box, or null when it can (047). */
function macProblem(mac: MacStatus, generation: number): string | null {
  const user = `${USER_PREFIX}${generation}`;
  const reset = `Reset it there with "sudo /usr/local/libexec/bb-box/machine reset".`;
  if (mac.fileVault) return "FileVault is on, so the Mac cannot sign its box user in. Turn it off, then reset the Mac.";
  if (!mac.fullDisk) return `The helper lacks Full Disk Access, which the Mac's reset needs. ${FULL_DISK_FIX}`;
  if (mac.user !== user) return `Box user ${user} is not made. ${reset}`;
  if (mac.console === user) return null;
  if (mac.console && mac.console !== "root" && !mac.console.startsWith(USER_PREFIX)) return `${mac.console} is signed in at the console, so box user ${user} cannot be. Sign them out. ${reset}`;
  return `Box user ${user} is not signed in at the console. If the Mac has just started, it signs in within a minute or so. If not, check that FileVault is off. ${reset}`;
}

/** The iOS runtime Xcode has, such as "iOS 26.0", or null without one, when boxes have no iOS Simulator. */
function iosRuntime(xcode: Xcode | null | undefined): string | null {
  return xcode?.version ? (xcode.runtimes.find((runtime) => runtime.startsWith("iOS ")) ?? null) : null;
}

/** Tests as the box user that Cua's socket is in its home: the socket may start with ~/, which only the box user's $HOME expands (047). */
function socketTest(socket: string): string {
  return `test -S ${socket.startsWith("~/") ? `"$HOME"/${quote(socket.slice(2))}` : quote(socket)}`;
}

function sameSize(a: BoxSize, b: BoxSize): boolean {
  return a.cores === b.cores && a.memoryMiB === b.memoryMiB && a.diskGiB === b.diskGiB;
}

/** Fewer cores first, then less memory. */
function bySize(a: View, b: View): number {
  const [x, y] = [machineSize(a.probe.status), machineSize(b.probe.status)];
  return (x?.cores ?? 0) - (y?.cores ?? 0) || (x?.memoryMiB ?? 0) - (y?.memoryMiB ?? 0);
}

/** 1 for a machine with a whole-machine reset, which may restart it, so a mixed pool lends it last, as before 041. */
function wholeReset(view: View): number {
  return view.machine.reset === "machine" ? 1 : 0;
}

export class SshPoolBackend implements Backend {
  readonly id: string;
  readonly nature = "real" as const;
  readonly label: string;
  readonly hosts: readonly string[] = [];
  /** linux while every machine runs Linux, macos while every one is a Mac, and null with both (047). */
  readonly hostOs: "linux" | "macos" | null;
  readonly restores: "home" | "machine";
  readonly #config: SshPoolConfig;
  readonly #context: BackendContext;
  readonly #options: SshPoolBackendOptions;
  readonly #keyFile = new KeyFile();
  readonly #machines: ReadonlyMap<string, SshPoolMachine>;
  /** Every Linux machine gives Docker, so the pool's linux boxes have it. */
  readonly #docker: boolean;
  /** Machines this process is resetting, which held() leaves to it. */
  readonly #resetting = new Set<string>();
  /** Machines this process is claiming, whose record the claim writes. */
  readonly #claiming = new Set<string>();
  /** The kinds and sizes of boxes whose acquire in this process has claimed a machine and not finished. */
  readonly #claimed = new Map<string, Acquiring>();
  #ssh: Promise<SshKeys> | null = null;
  /** Claims in this process go one at a time, so two never pick the same machine. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(config: SshPoolConfig, context: BackendContext, options: SshPoolBackendOptions = {}) {
    this.id = context.id;
    this.#config = config;
    this.#context = context;
    this.#options = options;
    this.#machines = new Map(config.machines.map((machine) => [machine.name, machine]));
    this.label = `SSH host pool of ${plural(config.machines.length, "machine")}`;
    this.restores = config.machines.length && config.machines.every((machine) => machine.reset === "machine") ? "machine" : "home";
    const linux = config.machines.filter((machine) => machine.os === "linux");
    this.#docker = linux.length > 0 && linux.every((machine) => machine.docker);
    const systems = new Set(config.machines.map((machine) => machine.os));
    this.hostOs = systems.size > 1 ? null : systems.has("macos") ? "macos" : "linux";
  }

  /** The kinds some machine lists. */
  kinds(): readonly BoxKind[] {
    const listed = new Set(this.#config.machines.flatMap((machine) => machine.kinds));
    return [
      ...(listed.has("linux") ? [linuxOffer(this.#docker)] : []),
      ...(listed.has("macos") ? [macOffer(false, this.#macFeatures("macos"))] : []),
      ...(listed.has("macos-desktop") ? [macOffer(true, this.#macFeatures("macos-desktop"))] : []),
    ];
  }

  /**
   * xcode while every Mac serving `kind` that answered the last survey has
   * Xcode, and ios-simulator while each has an iOS runtime too, as the pool's
   * Docker works (047). One switched off or slow does not hide them.
   */
  #macFeatures(kind: SshPoolKind): string[] {
    const xcodes = (this.#surveyed ?? []).filter((view) => view.probe.status?.mac && this.#lists(view.machine, kind)).map((view) => view.probe.status!.mac!.xcode);
    if (!xcodes.length || !xcodes.every((xcode) => xcode?.version)) return [];
    return xcodes.every((xcode) => iosRuntime(xcode)) ? ["xcode", "ios-simulator"] : ["xcode"];
  }

  /** The machines it lends whole, for the doctor's warning when a Mac is also a Tart host (047). One through a jump host is on another network. */
  footprint(): Footprint {
    const machines = this.#config.machines.filter((machine) => !machine.jump);
    const note = "On macOS 27 and later, each reset of a Mac restarts its user space, which stops every Tart VM on it and ends every SSH session.";
    return {
      machines: machines.map((machine) => machine.admin.host.toLowerCase()),
      ...(machines.some((machine) => machine.os === "macos") ? { machinesNote: note } : {}),
    };
  }

  /**
   * A Mac kind's features follow the Macs that answered the last survey, so
   * a Mac box gets them only when its own Mac answered. Before the first
   * survey, or while its Mac is off, it keeps the features it has (047).
   */
  async asOffered(guest: Guest, kind: string): Promise<boolean> {
    return kind === "linux" || Boolean(this.#surveyed?.some((view) => view.machine.name === guest.ref && view.probe.status?.mac));
  }

  #offer(kind: string): BoxKind {
    const offer = this.kinds().find((candidate) => candidate.id === kind);
    if (!offer) throw new BackendError("unsupported", `The SSH host pool has no machine for kind ${kind}. Its kinds are ${this.kinds().map((other) => other.id).join(", ")}.`);
    return offer;
  }

  async capacity(kind: string, size: BoxSize, pending: readonly Acquiring[], signal?: AbortSignal): Promise<Capacity> {
    this.#offer(kind);
    const all = await this.#survey(signal);
    const views = all.filter((view) => this.#lists(view.machine, kind));
    // Acquires that have not claimed a machine take theirs first, as their claims would; those that have claimed one show as held.
    const taken = new Set<View>();
    for (const box of this.#waiting(pending)) {
      const view = this.#candidates(all, box.kind, box.size).find((candidate) => !taken.has(candidate));
      if (view) taken.add(view);
    }
    const fitting = this.#candidates(views, kind, size);
    const left = fitting.filter((view) => !taken.has(view)).length;
    const ok = left > 0;
    return {
      ok,
      message: ok ? null : this.#full(kind, size, views, fitting.length),
      warm: null,
      hosts: [{ host: POOL_HOST, ok, limits: [{ resource: "machines", used: views.length - left, total: views.length, reserve: 0, unit: "count" }] }],
    };
  }

  /** The acquires in `pending` that have not claimed a machine in this process. */
  #waiting(pending: readonly Acquiring[]): Acquiring[] {
    const waiting = [...pending];
    for (const claimed of this.#claimed.values()) {
      const at = waiting.findIndex((box) => box.kind === claimed.kind && sameSize(box.size, claimed.size));
      if (at >= 0) waiting.splice(at, 1);
    }
    return waiting;
  }

  /** The free machines a box of `kind` at `size` may claim, in the order its claim tries them. */
  #candidates(views: readonly View[], kind: string, size: BoxSize): View[] {
    return views
      .filter((view) => this.#lists(view.machine, kind) && view.state === "free" && this.#ready(view, kind) === null && fits(view.probe.status, size))
      .sort((a, b) => bySize(a, b) || wholeReset(a) - wholeReset(b) || a.since - b.since);
  }

  /** Why no machine is free for `kind` at `size`, in words for the user. `waited` machines would be free but for acquires waiting to claim. */
  #full(kind: string, size: BoxSize, views: readonly View[], waited: number): string {
    const held = views.filter((view) => view.state === "held" && view.probe.status?.owner?.install === this.#context.installId).length;
    const others = views.filter((view) => view.state === "held").length - held;
    const resetting = views.filter((view) => view.state === "resetting").length;
    const out = views.filter((view) => view.state === "out-of-service");
    const unready = views.filter((view) => view.state === "free" && this.#ready(view, kind) !== null);
    const small = views.filter((view) => view.state === "free" && this.#ready(view, kind) === null && !fits(view.probe.status, size));
    const parts = [
      held ? `${plural(held, "is", "are")} held by this install's boxes` : "",
      others ? `${others} by another install` : "",
      resetting ? `${resetting} resetting` : "",
      out.length ? `${out.length} out of service (${out.map((view) => `${view.machine.name}: ${view.reason}`).join("; ")})` : "",
      unready.length ? `${unready.length} not ready for ${kind} (${unready.map((view) => `${view.machine.name}: ${this.#ready(view, kind)}`).join("; ")})` : "",
      small.length
        ? `${small.length} smaller than ${sizeWords(size)} (${small.map((view) => `${view.machine.name}: ${hasWords(view.probe.status).join(", ") || "it did not say its size"}`).join("; ")})`
        : "",
      waited ? `${waited} about to be claimed by other boxes` : "",
    ].filter(Boolean);
    const all = `${plural(views.length, "machine")} that serve${views.length === 1 ? "s" : ""} ${kind}`;
    const why = parts.length ? ` Of the ${all}, ${parts.join(", ")}.` : "";
    return `No machine in the SSH host pool is free for ${kind} at ${sizeWords(size)}.${why} Release a box to free one${small.length ? ", or ask for a smaller size" : ""}.`;
  }

  async acquire(box: BoxIdentity, previous: Guest | null, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest> {
    const kind = this.#offer(box.kind);
    signal.throwIfAborted();
    if (previous) {
      const resumed = await this.#resume(box, previous, kind, hooks, signal);
      if (resumed) return resumed;
    }
    const claimed: Guest[] = [];
    try {
      let started = performance.now();
      const { machine, guest } = await this.#claim(box, kind, hooks, signal, (guest) => claimed.push(guest));
      hooks.timing("claim", performance.now() - started);
      await hooks.starting();
      started = performance.now();
      await this.#waitReady(machine, String(guest.data!.user), kind, signal);
      hooks.timing("ssh", performance.now() - started);
      return guest;
    } catch (error) {
      // Not with the signal, which may be what ended the acquire.
      for (const guest of claimed) await this.release(guest, QUIET).catch((cause) => this.#context.logError(`release ${guest.ref} after a failed acquire`, cause));
      throw error;
    } finally {
      this.#claimed.delete(box.boxId);
    }
  }

  /** Picks up an acquire a restart interrupted, when its machine still names the box; otherwise releases it. */
  async #resume(box: BoxIdentity, previous: Guest, kind: BoxKind, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest | null> {
    const machine = this.#machines.get(previous.ref);
    const generation = whole(previous.data?.generation);
    const user = previous.data?.user;
    if (machine && generation !== null && typeof user === "string") {
      const probe = await this.#status(machine, signal);
      const marker = probe.status?.owner;
      if (probe.status?.marker === "owner" && marker?.install === this.#context.installId && marker.box === box.boxId && marker.generation === generation) {
        await hooks.starting();
        try {
          await this.#waitReady(machine, user, kind, signal);
          return previous;
        } catch (error) {
          signal.throwIfAborted();
          this.#context.logError(`resume ${machine.name}`, error);
        }
      }
    }
    await this.release(previous, QUIET).catch((error) => this.#context.logError(`release ${previous.ref} before a new claim`, error));
    signal.throwIfAborted();
    return null;
  }

  /** Claims the smallest free machine of at least the box's size, then one without a whole-machine reset, then the one free longest, then the first listed. */
  #claim(
    box: BoxIdentity,
    kind: BoxKind,
    hooks: AcquireHooks,
    signal: AbortSignal,
    onClaim: (guest: Guest) => void,
  ): Promise<{ machine: SshPoolMachine; guest: Guest }> {
    return this.#exclusive(async () => {
      const views = (await this.#survey(signal)).filter((view) => this.#lists(view.machine, kind.id));
      const candidates = this.#candidates(views, kind.id, box.size);
      const { publicKey } = await this.#keys();
      if (!publicKey) throw new Error("ssh-keygen cannot read the SSH private key in bb-box's settings. Paste the whole key, or clear it so bb-box makes one.");
      for (const view of candidates) {
        const { machine } = view;
        const generation = view.probe.status!.generation!;
        const user = `${USER_PREFIX}${generation}`;
        const guest = this.#guest(machine, box.boxId, generation, user, machineSize(view.probe.status));
        await hooks.claim(guest);
        onClaim(guest);
        signal.throwIfAborted();
        this.#claiming.add(machine.name);
        try {
          // Without the signal: a claim cut short could finish on the machine after bb-box looked.
          const docker = kind.capabilities.features.includes("docker") ? ["docker"] : [];
          const result = await this.#helper(machine, ["claim", String(generation), ...docker], claimInput(this.#context.installId, box, publicKey), CLAIM_TIMEOUT_MS);
          if (result.exitCode === EXIT.held || result.exitCode === EXIT.moved || result.exitCode === 255 || result.timedOut) continue;
          if (result.exitCode === EXIT.dirty) {
            await this.#outOfService(machine, generation, said(result));
            continue;
          }
          if (result.exitCode !== EXIT.ok) throw new Error(`Machine ${machine.name} could not be claimed: ${said(result)}`);
          this.#claimed.set(box.boxId, { kind: kind.id, size: box.size });
          await this.#write(machine, { state: "held", since: Date.now(), generation, reason: null, owner: ownerOf(box), user });
          return { machine, guest };
        } finally {
          this.#claiming.delete(machine.name);
        }
      }
      throw new BackendError("no_capacity", this.#full(kind.id, box.size, views, 0));
    });
  }

  async #waitReady(machine: SshPoolMachine, user: string, kind: BoxKind, signal: AbortSignal): Promise<void> {
    const timeoutMs = this.#options.readyTimeoutMs ?? kind.readyTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    const command = await this.#command(machine, user);
    // Through the shared connection, which the box's first commands then use.
    const answers = { probe: (signal?: AbortSignal) => command.answers(signal) };
    const ready = await waitUntilAnswers(answers, { timeoutMs, intervalMs: 250, signal, sleep: this.#options.sleep });
    if (!ready) {
      throw new Error(
        `Machine ${machine.name} made box user ${user}, but SSH as ${user} did not answer within ${Math.round(timeoutMs / 1000)} s. ` +
          `Check that sshd on ${machine.name} lets users ${USER_PREFIX}* log in with a key, as the setup guide says.`,
      );
    }
    if (machine.os === "macos") await this.#waitSession(machine, user, kind, command, deadline, timeoutMs, signal);
  }

  /** Waits for a Mac's box user at the console and, for a desktop, Cua's socket in its home, which the box user tests (047). */
  async #waitSession(machine: SshPoolMachine, user: string, kind: BoxKind, command: SshTransport, deadline: number, timeoutMs: number, signal: AbortSignal): Promise<void> {
    const socket = kind.capabilities.computerUse?.socket ?? null;
    const sleep = this.#options.sleep ?? pause;
    for (;;) {
      const status = (await this.#status(machine, signal)).status;
      let missing: "console" | "socket" | null = null;
      if (status?.mac?.console !== user) missing = "console";
      else if (socket) {
        const test = await command.run(socketTest(socket), { timeoutMs: STATUS_TIMEOUT_MS, signal }).catch(() => null);
        if (test?.exitCode !== 0) missing = "socket";
      }
      if (!missing) return;
      signal.throwIfAborted();
      if (Date.now() >= deadline) {
        const within = `within ${Math.round(timeoutMs / 1000)} s`;
        throw new Error(
          missing === "console"
            ? `Box user ${user} was not signed in at ${machine.name}'s console ${within}. Check that FileVault is off and nobody else is signed in there, as the setup guide says.`
            : `Cua Driver's socket did not appear in box user ${user}'s session on ${machine.name} ${within}. Check that setup-mac.sh installed Cua Driver there.`,
        );
      }
      await sleep(MAC_READY_POLL_MS, signal);
    }
  }

  async release(guest: Guest, hooks: ReleaseHooks, signal?: AbortSignal): Promise<void> {
    const machine = this.#machines.get(guest.ref);
    const generation = whole(guest.data?.generation);
    // A machine no longer in the settings is no longer bb-box's to reset.
    if (!machine || generation === null) return;
    const box = typeof guest.data?.box === "string" ? guest.data.box : null;
    const record = await this.#read(machine);
    if (record?.state === "out-of-service") return;
    const probe = await this.#status(machine, signal);
    if (!probe.status) throw new Error(`Machine ${machine.name} cannot be reset now: ${probe.problem} bb-box tries again later.`);
    const { status } = probe;
    const marker = status.owner;
    const ours =
      marker !== null &&
      marker.install === this.#context.installId &&
      marker.generation === generation &&
      (box ? marker.box === box : status.marker === "resetting");
    if (!ours) {
      // Never claimed, already reset, or another box's: there is nothing to do.
      if (status.marker === "none" && status.generation !== null && record && record.state !== "free" && (record.owner?.boxId ?? null) === box) {
        await this.#write(machine, { state: "free", since: Date.now(), generation: status.generation, reason: null, owner: null, user: null });
      }
      return;
    }
    await hooks.resetting();
    const started = performance.now();
    const user = marker.user ?? `${USER_PREFIX}${generation}`;
    this.#resetting.add(machine.name);
    try {
      await this.#write(machine, { state: "resetting", since: Date.now(), generation, reason: null, owner: markerOwner(marker), user });
      await (await this.#keys()).ssh.forget(this.#access(machine, user));
      const args = ["release", String(generation), ...resetMode(machine)];
      const outcome = await this.#reset(machine, args, releaseInput(this.#context.installId, box), signal);
      if (outcome.generation !== null) {
        await this.#write(machine, { state: "free", since: Date.now(), generation: outcome.generation, reason: null, owner: null, user: null });
      } else if (outcome.reason !== null) {
        await this.#outOfService(machine, generation, outcome.reason);
        this.#context.logError(`reset ${machine.name}`, new Error(outcome.reason));
      }
    } finally {
      this.#resetting.delete(machine.name);
    }
    hooks.timing("reset", performance.now() - started);
  }

  /**
   * Runs a release or reset, asking again while a whole-machine reset runs.
   * Gives the new generation, or the reason it failed, or neither when the
   * machine turned out to be another box's.
   */
  async #reset(machine: SshPoolMachine, args: readonly string[], input: string, signal?: AbortSignal): Promise<{ generation: number | null; reason: string | null }> {
    const timeoutMs = this.#options.resetTimeoutMs ?? RESET_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const sleep = this.#options.sleep ?? pause;
    let restoring = false;
    let silentSince: number | null = null;
    for (;;) {
      const result = await this.#helper(machine, args, input, Math.max(1_000, deadline - Date.now()), signal);
      signal?.throwIfAborted();
      // A Mac that drops SSH mid-reset is restarting: ask again until it answers, within a limit.
      if (machine.os === "macos" && (result.exitCode === 255 || result.timedOut)) {
        silentSince ??= Date.now();
        if (Date.now() - silentSince >= (this.#options.macSilenceMs ?? MAC_SILENCE_MS)) {
          return { generation: null, reason: `It did not answer over SSH for ${Math.round((this.#options.macSilenceMs ?? MAC_SILENCE_MS) / 60_000)} minutes during its reset: ${said(result)}` };
        }
        await sleep(this.#options.resetPollMs ?? RESET_POLL_MS, signal);
        continue;
      }
      silentSince = null;
      if (result.exitCode === EXIT.ok) {
        const generation = Number(fields(result.stdout).get("generation"));
        if (Number.isInteger(generation)) return { generation, reason: null };
        return { generation: null, reason: `The helper did not say the machine's new generation: ${result.stdout.trim().slice(0, 200)}` };
      }
      if (result.exitCode === EXIT.notOurs) return { generation: null, reason: null };
      if (result.exitCode === EXIT.restoring) restoring = true;
      else if (!(restoring && (result.exitCode === 255 || result.timedOut))) {
        // In a home reset, SSH failing means the machine went away mid-reset: the sweep finishes it later.
        if (result.exitCode === 255 || result.timedOut) throw new Error(`Machine ${machine.name} stopped answering during its reset: ${said(result)} bb-box finishes the reset later.`);
        return { generation: null, reason: `Its reset failed: ${said(result)}` };
      }
      // The whole-machine reset, or a Mac's sign-in of its next box user, runs on, and may restart the machine.
      if (Date.now() >= deadline) {
        const what = machine.os === "macos" ? "Its reset did not sign the next box user in" : "Its whole-machine reset did not finish";
        return { generation: null, reason: `${what} within ${Math.round(timeoutMs / 60_000)} minutes.` };
      }
      await sleep(this.#options.resetPollMs ?? RESET_POLL_MS, signal);
    }
  }

  async power(guest: Guest, signal?: AbortSignal): Promise<PowerState | null> {
    const machine = this.#machines.get(guest.ref);
    if (!machine) return null;
    const probe = await this.#status(machine, signal);
    if (!probe.status) return "unknown";
    const marker = probe.status.owner;
    const box = guest.data?.box;
    const ours =
      probe.status.marker === "owner" &&
      typeof box === "string" &&
      marker?.install === this.#context.installId &&
      marker.box === box &&
      marker.generation === whole(guest.data?.generation);
    return ours ? "running" : null;
  }

  async held(signal?: AbortSignal): Promise<HeldGuest[]> {
    const held: HeldGuest[] = [];
    for (const { machine, probe, record } of await this.#survey(signal)) {
      if (record?.state === "out-of-service" || this.#resetting.has(machine.name)) continue;
      const { status } = probe;
      if (!status) {
        // The record names the box on a machine that does not answer, so the sweep keeps it.
        if (record?.state === "held" && record.owner && record.user) {
          held.push({ ...this.#guest(machine, record.owner.boxId, record.generation, record.user, null), owner: record.owner, power: "unknown" });
        }
        continue;
      }
      const marker = status.owner;
      if (!marker || marker.install !== this.#context.installId || marker.generation === null) continue;
      const user = marker.user ?? `${USER_PREFIX}${marker.generation}`;
      const owner = status.marker === "owner" ? markerOwner(marker) : null;
      // A machine part-way through its reset has no owner, so the sweep finishes the reset.
      held.push({ ...this.#guest(machine, owner?.boxId ?? null, marker.generation, user, machineSize(status)), owner, power: "running" });
    }
    return held;
  }

  async transports(guest: Guest, kind: string): Promise<BoxTransports> {
    const machine = this.#machines.get(guest.ref);
    if (!machine) throw new BackendError("gone", `Machine ${guest.ref} is no longer in the SSH host pool's settings.`);
    const user = typeof guest.data?.user === "string" ? guest.data.user : `${USER_PREFIX}${guest.data?.generation}`;
    const access = this.#access(machine, user);
    const offer = this.kinds().find((other) => other.id === kind);
    const docker = offer?.capabilities.features.includes("docker") ?? false;
    const host = access.host.includes(":") ? `[${access.host}]` : access.host;
    const { ssh } = await this.#keys();
    const displays = (machine.os === "macos" ? (offer?.capabilities.displays ?? []) : []).map(
      (display): Display => ({ ...display, label: "Desktop", open: (signal) => this.#openDisplay(machine, guest, ssh, access, user, signal) }),
    );
    return {
      command: await this.#command(machine, user),
      displays,
      access: {
        ssh: access,
        // DOCKER_HOST cannot go through a jump host.
        dockerHost: docker && !machine.jump ? `ssh://${user}@${host}${access.port === 22 ? "" : `:${access.port}`}` : null,
      },
    };
  }

  /**
   * A Mac's Screen Sharing, through `ssh -W` as the box user, which the relay
   * signs in to as the box user. The helper's display command gives the
   * password over the admin's SSH at each open, only to the box that holds the
   * Mac. It goes into the sign-in and nowhere else: no error or log quotes
   * the command's output (047). Screen Sharing ignores the viewer's input,
   * so that goes to core's input helper in the box user's desktop session
   * (#406).
   */
  async #openDisplay(machine: SshPoolMachine, guest: Guest, ssh: Ssh, access: SshAccess, user: string, signal?: AbortSignal): Promise<DisplayOpened> {
    const generation = whole(guest.data?.generation);
    const box = typeof guest.data?.box === "string" ? guest.data.box : null;
    if (generation === null || !box) throw new BackendError("gone", `Machine ${machine.name} does not say which box holds it, so its desktop cannot be shown.`);
    const result = await this.#helper(machine, ["display", String(generation)], releaseInput(this.#context.installId, box), STATUS_TIMEOUT_MS, signal);
    if (result.exitCode === EXIT.notOurs) throw new BackendError("gone", `Machine ${machine.name} is no longer this box's, so its desktop cannot be shown.`);
    if (result.exitCode !== EXIT.ok) throw new Error(`Machine ${machine.name} did not give its desktop's sign-in: ${said(result)}`);
    const signIn = parseDisplay(result.stdout);
    if (!signIn || signIn.user !== access.user) {
      throw new Error(`Machine ${machine.name} did not give box user ${access.user}'s sign-in for its desktop. Run this bb-box's setup/ssh-pool/setup-mac.sh on it with sudo.`);
    }
    return {
      route: ssh.route(access, SCREEN_SHARING_PORT),
      auth: { type: "apple", user: signIn.user, password: signIn.password },
      input: (events, signal) => this.#macInput(machine, user, events, signal),
    };
  }

  /** The input helper in the box user's desktop session, for one viewer (#406). */
  async #macInput(machine: SshPoolMachine, user: string, events: DisplayInputEvents, signal?: AbortSignal): Promise<DisplayInput> {
    const failed = `The desktop's input helper did not start on ${machine.name}: box user ${user} may not be signed in to the desktop.`;
    const why = (error: unknown) => `${failed} ${error instanceof Error ? error.message : String(error)}`;
    const command = await this.#command(machine, user);
    const channel = await command.spawn(inBoxCommand("macos", macInputCommand(), { session: "desktop" }), signal).catch((error: unknown) => {
      throw new Error(why(error));
    });
    const input = new MacInput(channel, events);
    let ended = failed;
    const started = await Promise.race([
      input.ready.then(() => true),
      input.ended.then(
        () => false,
        (error: unknown) => ((ended = why(error)), false),
      ),
      pause(INPUT_START_MS, signal).then(() => false),
    ]);
    if (!started) {
      await input.close().catch(() => undefined);
      throw new Error(ended);
    }
    return input;
  }

  async members(signal?: AbortSignal): Promise<readonly PoolMember[]> {
    return (await this.#survey(signal)).map((view) => ({
      ref: view.machine.name,
      host: view.machine.name,
      kinds: view.machine.kinds,
      state: view.state,
      reason: view.state === "out-of-service" ? view.reason : null,
      since: view.since,
      generation: view.generation,
    }));
  }

  /**
   * Resets a machine out of service and lends it again. The reset completes
   * the one that failed, so the generation moves on by one. A machine a box
   * holds, of any install, is left alone, as is one another install resets.
   */
  async returnToService(ref: string, signal?: AbortSignal): Promise<void> {
    const machine = this.#machines.get(ref);
    if (!machine) throw new Error(`There is no machine ${ref} in the SSH host pool.`);
    const view = await this.#look(machine, Date.now(), signal);
    const { status } = view.probe;
    if (status?.marker === "owner" && status.owner) {
      const { install, name, box } = status.owner;
      const of = install === this.#context.installId ? "" : ` of bb-box install ${install || "with no ID"}`;
      throw new Error(`Machine ${ref} is held by box ${name || box || "with no ID"}${of}. Release the box first.`);
    }
    if (view.state === "free") return;
    if (view.state !== "out-of-service") throw new Error(`Machine ${ref} is ${view.state}, not out of service.`);
    if (!status) throw new Error(`Machine ${ref} cannot be reset: ${view.probe.problem}`);
    if (status.owner && status.owner.install !== this.#context.installId) {
      const by = status.owner.install ? `another bb-box install, ${status.owner.install}` : "an operator on the machine";
      throw new Error(`Machine ${ref} is being reset by ${by}. Leave it to finish, or run the reset again on the machine.`);
    }
    this.#resetting.add(ref);
    try {
      const args = ["reset", ...resetMode(machine)];
      const outcome = await this.#reset(machine, args, releaseInput(this.#context.installId, null), signal);
      if (outcome.generation === null) {
        const reason = outcome.reason ?? "Another bb-box install holds it.";
        await this.#outOfService(machine, status.generation ?? view.generation, reason);
        throw new Error(`Machine ${ref} is still out of service. ${reason}`);
      }
      await this.#write(machine, { state: "free", since: Date.now(), generation: outcome.generation, reason: null, owner: null, user: null });
    } finally {
      this.#resetting.delete(ref);
    }
  }

  async doctor(signal?: AbortSignal): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    const macs = this.#config.machines.filter((machine) => machine.os === "macos");
    const owners = macs.length ? (macs.length === this.#config.machines.length ? "/var/db/bb-box/owner" : "/var/lib/bb-box/owner, or /var/db/bb-box/owner on a Mac") : "/var/lib/bb-box/owner";
    const notes: string[] = [`This install's ID is ${this.#context.installId}. The machines it holds name it in ${owners}.`];
    const pass = ([id, name]: Check, detail: string) => checks.push({ id, name, status: "ok", detail, fix: null });
    const warn = ([id, name]: Check, detail: string, fix: string) => checks.push({ id, name, status: "warn", detail, fix });
    const fail = ([id, name]: Check, detail: string, fix: string) => checks.push({ id, name, status: "fail", detail, fix });
    const skip = (...skipped: Check[]) => {
      for (const [id, name] of skipped) checks.push({ id, name, status: "skipped", detail: "An earlier check failed.", fix: null });
    };

    let keys: SshKeys | null = null;
    try {
      keys = await this.#keys();
      if (keys.publicKey) {
        pass(SSH_KEY_CHECK, keys.generated ? "bb-box made a key; its public key is below." : "From bb-box's settings; its public key is below.");
        notes.push(`Give setup/ssh-pool/setup.sh, or setup-mac.sh on a Mac, this public key with --key, so each machine's admin user accepts it: ${keys.publicKey}`);
      } else {
        fail(SSH_KEY_CHECK, "ssh-keygen cannot read the SSH private key in bb-box's settings.", "Paste the whole private key, or clear the setting so bb-box makes one.");
      }
    } catch (error) {
      fail(SSH_KEY_CHECK, message(error), "Check the SSH private key in bb-box's settings, or clear it so bb-box makes one.");
    }

    if (!this.#config.machines.length) {
      fail(MACHINES_CHECK, "The pool has no machines yet.", `Set up a machine with setup.sh, or a Mac with setup-mac.sh, and this public key, then add the line it prints to the machines, like ${EXAMPLE}.`);
    }
    const views = keys?.publicKey ? await this.#survey(signal) : [];
    // Only the doctor asks for Cua's grants, and for Xcode's runtimes again,
    // which may each take the helper seconds. They are separate calls, made
    // together, so each stays within a status's time.
    const macsUp = views.filter((view) => view.probe.status?.mac);
    const desktops = macsUp.filter((view) => this.#lists(view.machine, "macos-desktop"));
    const [grants, xcodes] = await Promise.all([
      Promise.all(desktops.map(async (view) => [view.machine, (await this.#status(view.machine, signal, "grants")).status?.mac?.grants ?? null] as const)).then((entries) => new Map(entries)),
      Promise.all(macsUp.map(async (view) => [view.machine, await this.#status(view.machine, signal, "xcode")] as const)).then((entries) => new Map(entries)),
    ]);
    const others = new Map<string, number>();
    for (const machine of this.#config.machines) {
      const name = machine.name;
      const mac = machine.os === "macos";
      const docker = this.#docker && !mac;
      const setup = `${setupWords(machine)} on ${name} ${setupAs(machine)}`;
      const check = (what: MachineCheck, label: string): Check => [`machine.${name}.${what}`, `${name}: ${label}`];
      const SSH = check("ssh", "SSH"), HELPER = check("helper", "helper"), ARCH_CHECK = check("arch", "architecture");
      const TOOLS = check("tools", "tools"), DOCKER = check("docker", "Docker"), STATE = check("state", "state");
      const FILEVAULT = check("filevault", "FileVault"), SIGNIN = check("signin", "sign-in"), FULL_DISK = check("fulldisk", "Full Disk Access");
      const HOMES = check("homes", "people's homes");
      const SIP = check("sip", "System Integrity Protection");
      const SCREEN = check("screensharing", "Screen Sharing"), GRANTS = check("grants", "Cua Driver's grants"), XCODE = check("xcode", "Xcode");
      const INPUT = check("input", "viewer's input");
      const desktop = this.#lists(machine, "macos-desktop");
      const macChecks = mac ? [FILEVAULT, SIGNIN, FULL_DISK, HOMES, SIP, XCODE, ...(desktop ? [SCREEN, GRANTS, INPUT] : [])] : [];
      const after = [ARCH_CHECK, TOOLS, ...(docker ? [DOCKER] : []), ...macChecks, STATE];
      const rest = [HELPER, ...after];
      const view = views.find((other) => other.machine === machine);
      const where = `${machine.admin.user}@${machine.admin.host}${machine.admin.port === 22 ? "" : `:${machine.admin.port}`}${machine.jump ? ` through ${machine.jump.host}` : ""}`;
      if (!view) {
        skip(SSH, ...rest);
        continue;
      }
      const { probe } = view;
      if (probe.unreachable) {
        const hostKey = /host key/i.test(probe.problem ?? "");
        fail(
          SSH,
          `${where} did not answer: ${probe.problem}`,
          hostKey
            ? `Put ${name}'s current host key in the host keys setting. ${mac ? "setup-mac.sh" : "setup.sh"} prints it.`
            : `Check that ${name} is on and that BB's server reaches it, and that its admin user accepts bb-box's key: run ${mac ? "setup-mac.sh" : "setup.sh"} on it with --key and the public key below.`,
        );
        skip(...rest);
        continue;
      }
      pass(SSH, `${where} answers.`);
      const { status } = probe;
      if (!status || status.helper === null) {
        fail(HELPER, `bb-box's helper did not run: ${probe.problem ?? "it gave no version."}`, `Run ${setup}.`);
        skip(...after);
        continue;
      }
      if (status.helper < HELPER_VERSION || status.generation === null) {
        fail(
          HELPER,
          status.generation === null ? `The machine has no reset generation in ${stateDir(machine)}.` : `The helper is version ${status.helper}; this bb-box needs ${HELPER_VERSION}.`,
          `Run this bb-box's ${setup}.`,
        );
      } else pass(HELPER, `Version ${status.helper}, reset generation ${status.generation}.`);
      const arch = ARCH[machine.os];
      if ((status.mac !== null) !== mac) {
        fail(ARCH_CHECK, `${name} runs ${status.mac ? "macOS" : "Linux"}, but its line lists ${machine.kinds.join(", ")}.`, `List ${status.mac ? "macos or macos-desktop" : "linux"} on ${name}'s line, or take it out of the machines list.`);
      } else if (status.arch === arch) pass(ARCH_CHECK, status.mac ? `macOS ${status.mac.version || "of unknown version"} on ${arch}.` : arch);
      else fail(ARCH_CHECK, `${name} is ${status.arch || "of unknown architecture"}, but its kinds promise ${arch}.`, `Take ${name} out of the machines list: every machine that serves a kind must be ${arch}.`);
      const { missing, enrolment } = status;
      const node = enrolment?.node ?? null;
      const forBB = enrolment ? [...(node === null ? ["node"] : []), ...enrolment.lacks.filter((tool) => tool === "npm")] : [];
      const forGit = enrolment ? enrolment.lacks.filter((tool) => tool !== "npm") : [];
      const oldNode = node !== null && !nodeFits(node);
      const lacks = [...missing, ...forBB, ...forGit];
      const found = [
        ...(lacks.length ? [`${name} lacks ${lacks.join(", ")}.`] : []),
        ...(oldNode ? [`${name} has Node.js ${node}, but BB's installer needs 22.19 or newer.`] : []),
      ].join(" ");
      const [nodeFix, gitFix] = mac ? [MAC_NODE_FIX, MAC_GIT_FIX] : [NODE_FIX, GIT_FIX];
      const fixes = [
        ...(missing.length
          ? [mac ? `Install ${missing.join(", ")}, or run ${setupWords(machine)} again.` : `Install ${missing.join(", ")}. curl-or-wget means either. Boxes need sh, tar and curl or wget to enrol in BB.`]
          : []),
        ...(forBB.length || oldNode ? [nodeFix] : []),
        ...(forGit.length ? [gitFix] : []),
      ];
      if (missing.length || forBB.length || oldNode) fail(TOOLS, found, `On ${name}: ${fixes.join(" ")}`);
      else if (forGit.length) warn(TOOLS, `${found} Boxes there enrol in BB, but cannot use the thread's GitHub access, which git takes through gh.`, `On ${name}: ${gitFix}`);
      else if (!enrolment) {
        warn(TOOLS, `The helper does not say whether ${name} has Node.js, npm, git and gh, which enrolment and the thread's GitHub access need.`, `Run this bb-box's ${setup}.`);
      } else {
        const linger = mac ? "" : status.systemd ? " It has systemd, so BB's daemon lingers." : " There is no systemd, so BB's daemon runs without linger.";
        pass(TOOLS, `Everything the helper, enrolment and the thread's GitHub access need, with Node.js ${node}.${linger}`);
      }
      // A machine's Docker matters only when the pool's boxes get it.
      if (docker) {
        const problem = this.#dockerProblem(view);
        if (problem) {
          fail(DOCKER, `${problem} Its line has reset=machine, so its boxes get Docker.`, `Install Docker on ${name}, and its reset-machine command with setup.sh --reset-hook, as the SSH host pool's setup guide says.`);
        } else pass(DOCKER, "Docker and a whole-machine reset are installed.");
      }
      if (mac && !status.mac) skip(...macChecks);
      else if (mac) this.#macChecks(status, machine, view.state === "out-of-service", grants.get(machine) ?? null, xcodes.get(machine) ?? null, { FILEVAULT, SIGNIN, FULL_DISK, HOMES, SIP, XCODE, SCREEN, GRANTS, INPUT }, { pass, warn, fail });
      // An operator's reset names no install.
      const install = status.owner?.install;
      if (install && install !== this.#context.installId) others.set(install, (others.get(install) ?? 0) + 1);
      const reset = `"sudo /usr/local/libexec/bb-box/machine ${["reset", ...resetMode(machine)].join(" ")}"`;
      if (view.state === "out-of-service") {
        warn(STATE, `Out of service: ${view.reason}`, `Fix the cause on ${name}, then reset it there with ${reset}. bb-box lends it again once it is clean.`);
      } else if (view.state === "resetting" && status.owner && !install) {
        warn(STATE, "An operator's reset on the machine has not finished.", `If it is not still running, run ${reset} on ${name} again. bb-box lends it again once it is clean.`);
      } else pass(STATE, `${this.#describe(view)}${leftoverWords(xcodes.get(machine)?.status?.mac?.leftovers ?? null)}`);
      // A machine shows 90% of its memory, as fits() allows.
      const has = machineSize(status);
      const largest = has && { ...has, memoryMiB: has.memoryMiB / 0.9, diskGiB: status.diskGiB ?? 0 };
      const [id, label] = check("sizes", "box sizes");
      const sizes = largest && sizesCheck({ id, name: label, host: name, has: hasWords(status).join(", "), keepsMiB: 0, kinds: machine.kinds.map((kind) => ({ kind, settings: this.#context.kind(kind), largest })) });
      if (sizes) checks.push(sizes);
    }

    if (others.size) {
      const parts = [...others].map(([install, count]) => `${plural(count, "machine")} held by install ${install}`);
      notes.push(
        `This install leaves alone ${parts.join(", ")}. They still count against capacity. ` +
          "If one of these IDs was this install's before it lost its storage, take it back with bb box install-id --set <id>.",
      );
    }
    const linux = this.#config.machines.filter((machine) => machine.os === "linux");
    const without = linux.filter((machine) => !machine.docker);
    if (linux.some((machine) => machine.docker) && without.length) {
      const names = without.map((machine) => machine.name).join(", ");
      warn(
        DOCKER_CHECK,
        `${names} ${without.length === 1 ? "has" : "have"} no whole-machine reset, so none of the pool's linux boxes have Docker, and each says No Docker.`,
        // bb-box runs one SSH host pool, so the fix is the lines, not a second pool.
        `To give them Docker, set up a whole-machine reset on ${names} and add reset=machine to ${without.length === 1 ? "its line" : "their lines"}, as the SSH host pool's setup guide says.`,
      );
    }
    // What the next survey gives the offers: what the doctor found, or else what the Mac found before.
    const found = new Map(macsUp.map((view) => [view.machine, xcodes.get(view.machine)?.status?.mac?.xcode ?? view.probe.status?.mac?.xcode ?? null]));
    const short = this.#xcodeShort(found);
    if (short) warn(XCODE_CHECK, short.detail, short.fix);
    if (linux.length && !this.#docker) {
      notes.push("A release removes the box's user, its files and its processes. It does not undo changes made as root, which boxes from this pool cannot make, since none of them has Docker.");
    }
    if (macs.length) {
      notes.push(
        "On a Mac, a release removes the box's user, its processes and every file it owns on the Data volume, then signs the next box's user in. It keeps macOS, apps, Homebrew and Cua Driver's grants. " +
          "What a standard user can change for the whole Mac, such as Wi-Fi networks joined, may carry over to the next box. A box can read what any user on the Mac can, so lend Macs set aside for boxes.",
      );
    }

    const ok = checks.every((check) => check.status !== "fail");
    const first = checks.find((check) => check.status === "fail");
    const free = views.filter((view) => view.state === "free").length;
    return {
      ok,
      summary: ok ? `${plural(this.#config.machines.length, "machine")}, ${free} free` : `${first!.name}: ${first!.detail}`,
      checks,
      notes,
    };
  }

  /**
   * The doctor's warning when only some of the Macs that answered and serve
   * a kind have Xcode, or an iOS runtime, so its boxes have neither, or no
   * iOS Simulator. Macs that did not answer are left out, as the offers
   * leave them out; their SSH check fails.
   */
  #xcodeShort(xcodes: ReadonlyMap<SshPoolMachine, Xcode | null>): { detail: string; fix: string } | null {
    const found = new Map<string, string[]>();
    const lacking = new Set<string>();
    for (const kind of ["macos", "macos-desktop"] as const) {
      const serving = [...xcodes.keys()].filter((machine) => this.#lists(machine, kind));
      const without = (has: (xcode: Xcode | null | undefined) => unknown) => serving.filter((machine) => !has(xcodes.get(machine))).map((machine) => machine.name);
      const noXcode = without((xcode) => xcode?.version);
      const noRuntime = without(iosRuntime);
      const [names, what] =
        noXcode.length && noXcode.length < serving.length
          ? [noXcode, "no Xcode, so the pool's KINDS boxes have neither xcode nor ios-simulator"]
          : noRuntime.length && noRuntime.length < serving.length
            ? [noRuntime, "no iOS runtime, so the pool's KINDS boxes have no ios-simulator"]
            : [[], ""];
      if (!names.length) continue;
      for (const name of names) lacking.add(name);
      const problem = `${names.join(", ")} ${names.length === 1 ? "has" : "have"} ${what}`;
      found.set(problem, [...(found.get(problem) ?? []), kind]);
    }
    if (!found.size) return null;
    const names = [...lacking].join(", ");
    return {
      detail: [...found].map(([problem, kinds]) => `${problem.replace("KINDS", kinds.join(" and "))}.`).join(" "),
      fix: `On ${names}, install Xcode in /Applications if it is not there, then run setup/ssh-pool/setup-mac.sh with sudo again, which downloads the iOS platform. Or serve those kinds only from Macs with Xcode.`,
    };
  }

  /** The doctor's checks of what a Mac's boxes need: FileVault off, its box user signed in, Full Disk Access, Xcode when present, Screen Sharing, Cua's grants and the viewer's input (047). */
  #macChecks(
    status: MachineStatus,
    machine: SshPoolMachine,
    outOfService: boolean,
    grants: MacStatus["grants"],
    xcodeProbe: Probe | null,
    ids: Readonly<Record<"FILEVAULT" | "SIGNIN" | "FULL_DISK" | "HOMES" | "SIP" | "XCODE" | "SCREEN" | "GRANTS" | "INPUT", Check>>,
    report: Readonly<Record<"pass", (check: Check, detail: string) => void> & Record<"warn" | "fail", (check: Check, detail: string, fix: string) => void>>,
  ): void {
    const mac = status.mac!;
    const name = machine.name;
    const { pass, warn, fail } = report;
    const reset = `reset ${name} there with "sudo /usr/local/libexec/bb-box/machine reset"`;
    if (mac.fileVault) {
      fail(ids.FILEVAULT, "FileVault is on, so after a restart the Mac waits for a password and signs no box user in.", `Turn FileVault off on ${name} in System Settings, Privacy and Security, wait until it has decrypted the disk, then ${reset}.`);
    } else pass(ids.FILEVAULT, "Off, so the Mac signs its box user in by itself after a restart.");

    // A reset that failed keeps its marker, and signs nobody in.
    if (status.marker === "resetting" && outOfService) warn(ids.SIGNIN, "Its reset stopped before signing the next box user in.", `Fix what the state check says, then ${reset}.`);
    else if (status.marker === "resetting") pass(ids.SIGNIN, "Its reset is signing the next box user in.");
    else if (!mac.user) fail(ids.SIGNIN, `Box user ${USER_PREFIX}${status.generation} is not made.`, `Fix what the state check says, then ${reset}.`);
    else if (mac.console !== mac.user) {
      const person = mac.console && mac.console !== "root" && !mac.console.startsWith(USER_PREFIX) ? mac.console : null;
      fail(
        ids.SIGNIN,
        person ? `${person} is signed in at the console, so box user ${mac.user} cannot be.` : `Box user ${mac.user} is not signed in at the console.`,
        `${person ? `Sign ${person} out, then` : "Check that FileVault is off, then"} ${reset}.`,
      );
    } else if (mac.autologin !== mac.user) {
      fail(ids.SIGNIN, `Box user ${mac.user} is at the console, but the automatic login is ${mac.autologin ? `for ${mac.autologin}` : "off"}, so after a restart it would not sign in.`, `Turn FileVault off if it is on, then ${reset}.`);
    } else pass(ids.SIGNIN, `Box user ${mac.user} is at the console, and signs in by itself after a restart.`);

    if (mac.fullDisk) pass(ids.FULL_DISK, "The helper has it, so a reset can remove the folders macOS protects.");
    else fail(ids.FULL_DISK, "The helper lacks Full Disk Access, so a reset cannot remove the folders macOS protects, such as ~/Library/Mail, and would put the Mac out of service.", `On ${name}: ${FULL_DISK_FIX}`);
    // The people's homes box users can enter, which the doctor's status call lists (047).
    const open = xcodeProbe?.status?.mac?.openHomes ?? null;
    if (open === null) warn(ids.HOMES, "The Mac's helper did not say whose homes box users can enter: it is older than this bb-box's.", `Run setup-mac.sh again on ${name}.`);
    else if (open.length) {
      const homes = open.map((user) => `/Users/${user}`);
      warn(
        ids.HOMES,
        `Box users can enter ${open.length === 1 ? "the home" : "the homes"} of ${open.join(", ")}, which macOS makes readable to the staff group they are in, so a box can read what is there, such as an agent CLI's or BB's credentials.`,
        `On ${name}, as an administrator: sudo chmod 700 ${homes.join(" ")}`,
      );
    } else pass(ids.HOMES, "Box users cannot enter any person's home.");
    // Either way works (058): it says what each gives.
    if (mac.sip === true) pass(ids.SIP, "On. Cua Driver has its grants; any other program a box runs needs a person to grant it macOS permissions, in the desktop's viewer.");
    else if (mac.sip === false) pass(ids.SIP, "Off, so bb-box grants box users' programs the macOS permissions they ask for (box_grant). Keep this Mac for agents: with SIP off, a process with root can change the system.");
    else warn(ids.SIP, "The Mac's helper did not say whether System Integrity Protection is on: it is older than this bb-box's.", `Run setup-mac.sh again on ${name}.`);

    // Xcode is optional, so a Mac without it passes; the pool's check warns when only some Macs have it.
    const xcode = xcodeProbe?.status?.mac?.xcode;
    if (!xcode) {
      warn(
        ids.XCODE,
        `The helper did not say whether the Mac has Xcode.${xcodeProbe?.problem ? ` ${xcodeProbe.problem}` : ""} ${mac.xcode ? "The offers keep what it found before." : "Until it does, boxes here have neither Xcode nor the iOS Simulator."}`,
        `Run this bb-box's setup/ssh-pool/setup-mac.sh on ${name} with sudo, which updates the helper and prepares Xcode. Then run the doctor again.`,
      );
    }
    else if (!xcode.version) pass(ids.XCODE, "None, so boxes here have neither Xcode nor the iOS Simulator.");
    else if (!iosRuntime(xcode)) {
      warn(ids.XCODE, `Xcode ${xcode.version} has no iOS runtime, so boxes here have no iOS Simulator.`, `Run setup/ssh-pool/setup-mac.sh on ${name} with sudo again. It accepts Xcode's licence, runs its first launch and downloads the iOS platform.`);
    } else pass(ids.XCODE, `Xcode ${xcode.version}, with the Simulator's ${xcode.runtimes.join(", ")}.`);

    if (!this.#lists(machine, "macos-desktop")) return;
    if (mac.screenSharing) pass(ids.SCREEN, "On, so macos-desktop boxes show the desktop.");
    else fail(ids.SCREEN, "Screen Sharing is off, so the Mac is not lent for macos-desktop.", `On ${name}, turn on Screen Sharing in System Settings, General, Sharing, and allow all users.`);
    const lacking = [...(grants?.accessibility === false ? ["Accessibility"] : []), ...(grants?.screenRecording === false ? ["Screen Recording"] : [])];
    if (lacking.length) {
      fail(ids.GRANTS, `Cua Driver lacks ${lacking.join(" and ")}, so computer use cannot ${grants?.screenRecording === false ? "see" : "act on"} the desktop.`, `On ${name}, turn on CuaDriver under ${lacking.join(" and under ")}, in System Settings, Privacy and Security.`);
    } else if (grants?.accessibility && grants.screenRecording) pass(ids.GRANTS, "Accessibility and Screen Recording, so computer use works.");
    else warn(ids.GRANTS, "Cua Driver did not say its grants: no box user is at the console, or Cua did not answer.", `Check that the box user is at ${name}'s console and that setup-mac.sh installed Cua Driver there.`);
    // A one-point pointer move, posted in the box user's session as a viewer's input is, and read back (#406).
    if (grants?.input) pass(ids.INPUT, "A pointer move posted in the box user's session moved the pointer, so a person can type and click in the desktop's viewer.");
    else if (grants?.input === false) {
      fail(
        ids.INPUT,
        "A pointer move posted in the box user's session did not move the pointer, so a person cannot type or click in the desktop's viewer.",
        `On ${name}, turn on osascript and sshd-keygen-wrapper under Accessibility, in System Settings, Privacy and Security, as setup-mac.sh's steps for a person say.`,
      );
    } else warn(ids.INPUT, "The Mac did not say whether a viewer's input posts: no box user is at the console, or osascript did not answer.", `Check that the box user is at ${name}'s console.`);
  }

  #describe(view: View): string {
    const status = view.probe.status;
    const owner = status?.owner;
    const size = hasWords(status ?? null);
    const has = size.length ? ` It has ${size.join(", ")}.` : "";
    if (view.state === "held") {
      const by = owner?.install === this.#context.installId ? `box ${owner.name ?? owner.box}` : `install ${owner?.install || "with no ID"}`;
      return `Held by ${by} at reset generation ${view.generation}.${has}`;
    }
    if (view.state === "resetting") return `Resetting after reset generation ${view.generation}.${has}`;
    return `Free at reset generation ${view.generation}.${has}`;
  }

  async dispose(): Promise<void> {
    await (await this.#ssh?.catch(() => null))?.ssh.dispose();
    await this.#keyFile.dispose();
  }

  /** The machine's kinds include `kind`. */
  #lists(machine: SshPoolMachine, kind: string): boolean {
    return machine.kinds.includes(kind as SshPoolKind);
  }

  /** Why a free machine cannot serve `kind` now, or null when it can. */
  #ready(view: View, kind: string): string | null {
    if (kind === "macos-desktop") return view.probe.status?.mac && !view.probe.status.mac.screenSharing ? "Screen Sharing is off." : null;
    return this.kinds().find((offer) => offer.id === kind)?.capabilities.features.includes("docker") ? this.#dockerProblem(view) : null;
  }

  /** Why a machine cannot give its boxes Docker, or null when it can. */
  #dockerProblem(view: View): string | null {
    const status = view.probe.status;
    if (!status) return null;
    if (!status.docker) return "Docker is not installed.";
    if (!status.hook) return "There is no reset-machine command, so a whole-machine reset is not set up.";
    return null;
  }

  #guest(machine: SshPoolMachine, box: string | null, generation: number, user: string, size: BoxSize | null): Guest {
    const facts: GuestFact[] = [
      { label: "Machine", value: machine.name },
      { label: "Reset", value: machine.reset === "machine" ? "Whole machine" : "User and home" },
      ...(machine.labels.length ? [{ label: "Labels", value: machine.labels.join(", ") }] : []),
    ];
    return {
      ref: machine.name,
      host: machine.name,
      address: machine.admin.host,
      size,
      data: { ...(box ? { box } : {}), generation, user },
      facts,
    };
  }

  #access(machine: SshPoolMachine, user: string): SshAccess {
    const pinned = (host: SshPoolHost, as: string): SshAccess => ({
      host: host.host,
      port: host.port,
      user: as,
      hostKeys: hostKeysFor(this.#config.knownHosts, host),
    });
    return { ...pinned(machine.admin, user), ...(machine.jump ? { jump: pinned(machine.jump, machine.jump.user) } : {}) };
  }

  async #command(machine: SshPoolMachine, user: string): Promise<SshTransport> {
    return new SshTransport((await this.#keys()).ssh, this.#access(machine, user), machine.os);
  }

  /** Runs the helper as root through the admin user. */
  async #helper(machine: SshPoolMachine, args: readonly string[], input: string | null, timeoutMs: number, signal?: AbortSignal): Promise<RunResult> {
    const { ssh } = await this.#keys();
    const command = [this.#options.helperCommand ?? HELPER_COMMAND, ...args].join(" ");
    return ssh.run(this.#access(machine, machine.admin.user), command, {
      ...(input !== null ? { stdin: input } : {}),
      timeoutMs,
      signal,
      maxOutputBytes: 64 * 1024,
    });
  }

  /** Reads a machine's status. Only the doctor asks a Mac for `grants` or `xcode`, which may each take the helper seconds. */
  async #status(machine: SshPoolMachine, signal?: AbortSignal, extra: "grants" | "xcode" | null = null): Promise<Probe> {
    try {
      const result = await this.#helper(machine, ["status", ...(extra ? [extra] : [])], null, STATUS_TIMEOUT_MS, signal);
      if (result.exitCode === 0) return { status: parseStatus(result.stdout), unreachable: false, problem: null };
      return { status: null, unreachable: result.exitCode === 255 || result.timedOut, problem: said(result) };
    } catch (error) {
      signal?.throwIfAborted();
      return { status: null, unreachable: true, problem: message(error) };
    }
  }

  /** Looks at every machine at once. A state new to its record starts when the survey does, so machines found free together are claimed as listed. */
  async #survey(signal?: AbortSignal): Promise<View[]> {
    const now = Date.now();
    const views = await Promise.all(this.#config.machines.map((machine) => this.#look(machine, now, signal)));
    this.#surveyed = views;
    return views;
  }

  /** The last survey, which `free` reads without reaching any machine. */
  #surveyed: readonly View[] | null = null;

  /** Free machines for `kind`, from the last survey (an acquire, capacity check or doctor); no SSH here. Null before the first. */
  free(kind: string): number | null {
    if (!this.#surveyed) return null;
    return this.#surveyed.filter((view) => this.#lists(view.machine, kind) && view.state === "free" && this.#ready(view, kind) === null).length;
  }

  /** `machine` as it is now. A state that its record does not have began at `now`, or for a held machine, when its box was made. */
  async #look(machine: SshPoolMachine, now: number, signal?: AbortSignal): Promise<View> {
    const [record, probe] = await Promise.all([this.#read(machine), this.#status(machine, signal)]);
    const { state, reason } = this.#judge(machine, probe, record);
    const marker = probe.status?.owner ?? null;
    const since = record?.state === state ? record.since : state === "held" && marker?.createdAt ? marker.createdAt : now;
    const generation = probe.status?.generation ?? record?.generation ?? 0;
    if (probe.status && !this.#resetting.has(machine.name) && !this.#claiming.has(machine.name)) {
      await this.#sync(machine, record, state, probe.status, since);
    }
    return { machine, probe, record, state, reason, generation, since };
  }

  /**
   * Keeps the record in step with a machine that answers, for when it does
   * not: whose box holds it, and the generation it last had. An operator's
   * reset on the machine puts it back in service, clean at a later generation.
   */
  async #sync(machine: SshPoolMachine, record: MachineRecord | null, state: PoolMember["state"], status: MachineStatus, since: number): Promise<void> {
    const marker = status.owner;
    const generation = status.generation ?? 0;
    if (state === "free") {
      if (record?.state !== "free" || record.generation !== generation) {
        await this.#write(machine, { state, since, generation, reason: null, owner: null, user: null });
      }
    } else if (state === "held" && marker) {
      const owner = marker.install === this.#context.installId ? markerOwner(marker) : null;
      const markerGeneration = marker.generation ?? generation;
      if (record?.state !== "held" || record.owner?.boxId !== owner?.boxId || record.generation !== markerGeneration) {
        await this.#write(machine, { state, since, generation: markerGeneration, reason: null, owner, user: owner ? marker.user : null });
      }
    }
  }

  /** The machine's state from its own word, and from bb-box's record of it. */
  #judge(machine: SshPoolMachine, probe: Probe, record: MachineRecord | null): { state: PoolMember["state"]; reason: string | null } {
    const out = (reason: string) => ({ state: "out-of-service" as const, reason });
    const { status } = probe;
    const setup = `${setupWords(machine)} on it ${setupAs(machine)}`;
    if (probe.unreachable) {
      if (record?.state === "out-of-service") return out(record.reason ?? "A reset failed.");
      // A Mac restarting in its reset, for a while.
      if (machine.os === "macos" && record?.state === "resetting" && Date.now() - record.since < (this.#options.macSilenceMs ?? MAC_SILENCE_MS)) return { state: "resetting", reason: null };
      return out(`It does not answer over SSH: ${probe.problem}`);
    }
    if (!status) return out(`bb-box's helper did not run: ${probe.problem} Run ${setup}.`);
    // Whatever else is wrong, a box holds it: an old helper only stops new claims.
    if (status.marker === "owner") return { state: "held", reason: null };
    if (status.helper === null || status.helper < HELPER_VERSION) return out(`bb-box's helper is missing or too old. Run this bb-box's ${setup}.`);
    if (status.generation === null) return out(`It has no reset generation. Run ${setup}.`);
    if (record?.state === "out-of-service") {
      // Back once the operator has reset it on the machine: clean, at a later generation.
      const back = status.marker === "none" && !status.dirty && status.generation > record.generation;
      if (!back) return out(record.reason ?? "A reset failed.");
    }
    if (status.marker === "resetting") return { state: "resetting", reason: null };
    if ((status.mac !== null) !== (machine.os === "macos")) return out(`It runs ${status.mac ? "macOS" : "Linux"}, but its line lists ${machine.kinds.join(", ")}.`);
    if (status.arch !== ARCH[machine.os]) return out(`It is ${status.arch || "of unknown architecture"}, not ${ARCH[machine.os]}.`);
    if (status.missing.length) return out(`It lacks ${status.missing.join(", ")}.`);
    if (status.dirty) return out(`An earlier box left ${status.dirty}`);
    const mac = status.mac && macProblem(status.mac, status.generation);
    if (mac) return out(mac);
    if (record && status.generation < record.generation) {
      return out(`Its reset generation went back from ${record.generation} to ${status.generation}, as if restored from an older copy. Check it, then reset it.`);
    }
    return { state: "free", reason: null };
  }

  async #read(machine: SshPoolMachine): Promise<MachineRecord | null> {
    return (await this.#context.storage.get<MachineRecord>(`${RECORD}${machine.name}`)) ?? null;
  }

  async #write(machine: SshPoolMachine, record: MachineRecord): Promise<void> {
    await this.#context.storage.set(`${RECORD}${machine.name}`, record);
  }

  async #outOfService(machine: SshPoolMachine, generation: number, reason: string): Promise<void> {
    await this.#write(machine, { state: "out-of-service", since: Date.now(), generation, reason, owner: null, user: null });
  }

  #exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #keys(): Promise<SshKeys> {
    if (!this.#ssh) {
      const pending = (async () => {
        let privateKey = this.#config.privateKey;
        let publicText: string | null = null;
        const generated = !privateKey;
        if (!privateKey) {
          let stored = await this.#context.storage.get<{ privateKey: string; publicKey: string }>(SSH_KEY);
          if (!stored) {
            stored = await generateKeyPair();
            await this.#context.storage.set(SSH_KEY, stored);
          }
          privateKey = stored.privateKey;
          publicText = stored.publicKey;
        }
        const keyPath = await this.#keyFile.path(privateKey);
        publicText ??= await publicKey(keyPath);
        const knownHostsPath = await this.#keyFile.knownHosts(this.#config.knownHosts);
        const shareDir = await this.#keyFile.shareDir();
        return { ssh: new Ssh({ keyPath, knownHostsPath, binary: this.#options.sshBinary, shareDir }), publicKey: publicText, generated };
      })();
      this.#ssh = pending;
      pending.catch(() => {
        if (this.#ssh === pending) this.#ssh = null;
      });
    }
    return this.#ssh;
  }
}

/** What old box users left in a Mac's /private/var/folders, which macOS 27 keeps (047), for the doctor's state check; nothing when none. */
export function leftoverWords(left: { readonly count: number; readonly kib: number } | null): string {
  if (!left?.count) return "";
  const size = left.kib >= 1024 * 1024 ? `${(left.kib / 1024 / 1024).toFixed(1)} GiB` : `${Math.round(left.kib / 1024)} MiB`;
  return ` Old box users left ${left.count === 1 ? "1 folder" : `${left.count} folders`} in /private/var/folders, which macOS keeps, with ${size} that root can see.`;
}
