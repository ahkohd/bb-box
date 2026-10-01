// The Tart backend: macOS boxes, and Linux boxes on arm64 (040), as VMs on
// Macs with Apple silicon, made by Tart on Apple's Virtualization framework. bb-box reaches each Mac over SSH
// as its host user and runs `tart` there (see host.ts). VMs sit on the Mac's
// own NAT, so bb-box reaches them through the Mac: commands over SSH with the
// Mac as the jump host, and a macOS desktop through Tart's VNC server, which
// listens on the Mac's loopback. A Linux desktop (linux-arm64-desktop-cpu)
// has its own VNC server in the VM, reached over SSH like its commands.
//
// - Acquire: the box's VM is named bb-box-<box ID>, so it is claimed before
//   anything is made. Its owner file goes first, then the clone (copy on
//   write on APFS), then `tart run` detached from SSH, then its address from
//   the Mac's DHCP leases, then SSH through the Mac.
// - Capacity: per Mac, at most two running macOS VMs, which Apple's licence
//   and the Virtualization framework allow, counting every macOS VM Tart
//   runs there (Linux VMs do not count); memory, less a reserve and the
//   running VMs'; free disk.
// - Stop suspends a macOS VM, which frees its memory and its slot, and start
//   resumes it with a new VNC port and password. A Linux VM is shut down and
//   boots again, since Tart cannot resume one; it runs as user box, with no
//   Tart VNC server, and no warm pool.
// - A VM's address can change when it starts again, so bb-box asks the Mac
//   for it when it does not know it, and forgets it when the VM stops.

import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { quote } from "../../transports/process.ts";
import { pause, waitUntilAnswers } from "../../transports/ready.ts";
import { KeyFile, Ssh, SshTransport, generateKeyPair, publicKey } from "../../transports/ssh.ts";
import { TransportError, type Display, type GuestOs, type RunResult, type SshAccess } from "../../transports/types.ts";
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
  type ComputerUse,
  type DoctorCheck,
  type DoctorReport,
  type Guest,
  type HeldGuest,
  type HostCapacity,
  type Limit,
  type PoolMember,
  type PowerState,
  type ReleaseHooks,
} from "../types.ts";
import { ReadyPool } from "../pool.ts";
import { TART_KINDS, type TartConfig, type TartHost, type TartKind } from "./config.ts";
import {
  claimScript,
  cloneScript,
  deleteScript,
  discardStateScript,
  holdScript,
  relabelScript,
  ownerScript,
  ipScript,
  ownerText,
  parseConfig,
  macScript,
  normalMac,
  parseFields,
  parseMacs,
  parseState,
  parseVnc,
  powerScript,
  startScript,
  stateScript,
  stopScript,
  vmName,
  vncScript,
  warmScript,
  type HostState,
  type VmConfig,
} from "./host.ts";

const SSH_KEY = "ssh-key";
const READY_TIMEOUT_MS = 5 * 60_000;
/** Cua Driver as the images pin it (015). The setup guide's image script installs this release. */
export const CUA_VERSION = "0.30.4";
const MiB_PER_GiB = 1024;

/** The doctor checks room for a box of the small preset core ships for the macOS kinds (028). */
const DOCTOR_SIZE: BoxSize = { cores: 4, memoryMiB: 8192, diskGiB: null };

const SSH_COMMAND: CommandCapability = { transport: "ssh", shell: "sh", admin: true, inDesktopSession: false, streaming: true };

/** The user Linux boxes work as, as in every Linux image bb-box builds. */
const LINUX_USER = "box";
/** The Linux desktop's VNC server, inside the VM, and the password it makes at first boot, readable by the box user. */
const LINUX_VNC_PORT = 5900;
const LINUX_VNC_PASSWORD_FILE = "/var/lib/bb-box/vnc-password";
/** The cookie the Linux desktop's display :99 writes at each start. */
const DISPLAY_AUTH_FILE = "/run/bb-box/Xauthority";
/** The Cua Driver the Linux desktop image pins (desktop-pins.tsv), run by the box user's service. */
const LINUX_CUA: ComputerUse = { driver: "cua", version: "0.28.3", socket: `/home/${LINUX_USER}/.cache/cua-driver/cua-driver.sock` };

/** The guest OS of a Tart kind: linux-arm64 and its kin, or macOS. */
export function guestOsOf(kind: string): GuestOs {
  return kind.startsWith("linux") ? "linux" : "macos";
}

type Step = <T>(name: string, run: () => Promise<T>) => Promise<T>;

export interface TartBackendOptions {
  readonly sshBinary?: string;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The longest an acquire may take, instead of the kind's. */
  readonly readyTimeoutMs?: number;
}

interface SshKeys {
  readonly ssh: Ssh;
  readonly publicKey: string | null;
  readonly generated: boolean;
}

/** A VM bb-box is starting on a Mac, counted against the Mac until Tart lists it running. Keyed by the VM. */
interface Placing {
  readonly host: string;
  readonly vm: string;
  readonly memoryMiB: number;
  /** A macOS VM, which counts against the Mac's two. */
  readonly macos: boolean;
}

/** The prefix of a warm VM's name. A box that takes it keeps the name. */
const WARM_PREFIX = "bb-box-warm-";

/**
 * Warm VMs of one image at one size, which serve every kind whose image and
 * default size they are: one pool when macos and macos-desktop share both.
 */
interface WarmPool {
  readonly image: string;
  readonly size: BoxSize;
  readonly kinds: readonly string[];
  /** The sum of the kinds' warm counts (029). */
  readonly target: number;
}

/** A warm VM bb-box is filling, until it is suspended or a box takes it over. */
interface Fill {
  readonly host: string;
  readonly size: BoxSize;
  readonly kinds: readonly string[];
  readonly abort: AbortController;
  /** The VM's address once it is ready; rejects when the fill fails. */
  readonly ready: Promise<string>;
  /** Settles when the fill has ended, whichever way. */
  readonly done: Promise<void>;
  /** A box took the VM over before its suspend: the fill stops there. */
  adopted: boolean;
}

/** A free warm VM on a Mac, as the state script shows it. */
interface FreeWarm {
  readonly vm: string;
  readonly size: BoxSize;
  readonly kinds: readonly string[];
}

/** How an acquire gets its VM: a clone, a free warm VM, a fill to take over, or its own VM after a restart. */
type Placement =
  | { readonly how: "clone" | "warm" | "resume"; readonly host: TartHost; readonly vm: string }
  | { readonly how: "adopt"; readonly host: TartHost; readonly vm: string; readonly fill: Fill }
  | { readonly how: "wait"; readonly fills: readonly Fill[] };

function sameSize(a: BoxSize, b: BoxSize): boolean {
  return a.cores === b.cores && a.memoryMiB === b.memoryMiB && a.diskGiB === b.diskGiB;
}

/** A VM bb-box filled or held for a warm pool, which is no box's. */
function warmState(fields: Readonly<Record<string, string>>): "warm" | "filling" | null {
  return fields.state === "warm" || fields.state === "filling" ? fields.state : null;
}

/** A Tart error that a VM's saved state did not restore. */
function failedRestore(error: unknown): boolean {
  return /failed to restore/i.test(message(error));
}

type Pending = { readonly kind: string; readonly size: BoxSize };

/** Boxes the registry is acquiring that have not reached a Mac yet, which count on every Mac. */
interface Unplaced {
  /** Those that are macOS VMs. */
  readonly count: number;
  readonly memoryMiB: number;
}

const NONE_UNPLACED: Unplaced = { count: 0, memoryMiB: 0 };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatMiB(value: number): string {
  return value >= MiB_PER_GiB ? `${Math.round((value / MiB_PER_GiB) * 10) / 10} GiB` : `${value} MiB`;
}

function powerOf(state: string | undefined): PowerState {
  if (state === "running") return "running";
  if (state === "stopped" || state === "suspended") return "stopped";
  return "unknown";
}

/** The size a VM's config gives it. Tart keeps no disk size there, so the disk is the image's, as null. */
function sizeOf(config: VmConfig | null | undefined): BoxSize | null {
  if (!config || !config.cpus || !config.memoryMiB) return null;
  return { cores: config.cpus, memoryMiB: config.memoryMiB, diskGiB: null };
}

function ownerOf(fields: Readonly<Record<string, string>>): BoxOwner | null {
  if (!fields.box || !fields.thread) return null;
  const created = Number(fields.created);
  return {
    boxId: fields.box,
    threadId: fields.thread,
    name: fields.name || null,
    kind: fields.kind || null,
    createdAt: Number.isFinite(created) && created > 0 ? created : null,
  };
}

/** The kinds a config offers: those with an image. */
export function tartKinds(config: TartConfig): BoxKind[] {
  const cua: ComputerUse = { driver: "cua", version: CUA_VERSION, socket: `/Users/${config.ssh.vmUser}/Library/Caches/cua-driver/cua-driver.sock` };
  const kinds: Record<TartKind, BoxKind> = {
    macos: {
      id: "macos",
      label: "macOS",
      description: "A macOS VM on a Mac with Apple silicon, for builds and commands. Its desktop is not shown.",
      requires: [],
      capabilities: { os: "macos", arch: "arm64", gpu: false, features: [], command: SSH_COMMAND, displays: [], computerUse: null, enrol: true },
      readyTimeoutMs: READY_TIMEOUT_MS,
    },
    "macos-desktop": {
      id: "macos-desktop",
      label: "macOS desktop",
      description: "A macOS VM on a Mac with Apple silicon, with its desktop shown in the panel and computer use.",
      requires: [],
      capabilities: {
        os: "macos",
        arch: "arm64",
        gpu: false,
        features: [],
        command: SSH_COMMAND,
        displays: [{ id: "desktop", protocol: "rfb", resizable: false }],
        computerUse: cua,
        enrol: true,
      },
      readyTimeoutMs: READY_TIMEOUT_MS,
    },
    "linux-arm64": {
      id: "linux-arm64",
      label: "Linux on arm64",
      description: "A Linux VM on arm64, on a Mac with Apple silicon. amd64 container images and x86_64 binaries do not run there.",
      requires: [],
      capabilities: { os: "linux", arch: "arm64", gpu: false, features: ["docker"], command: SSH_COMMAND, displays: [], computerUse: null, enrol: true },
      readyTimeoutMs: READY_TIMEOUT_MS,
    },
    "linux-arm64-docker": {
      id: "linux-arm64-docker",
      label: "Linux on arm64 with Docker",
      description: "A Linux VM on arm64 with Docker, on a Mac with Apple silicon. amd64 container images and x86_64 binaries do not run there.",
      requires: ["docker"],
      capabilities: { os: "linux", arch: "arm64", gpu: false, features: ["docker"], command: SSH_COMMAND, displays: [], computerUse: null, enrol: true },
      readyTimeoutMs: READY_TIMEOUT_MS,
    },
    "linux-arm64-desktop-cpu": {
      id: "linux-arm64-desktop-cpu",
      label: "Linux desktop on arm64",
      description:
        "A Linux desktop VM on arm64, drawn by the CPU, on a Mac with Apple silicon, for computer use and browsers. amd64 container images and x86_64 binaries do not run there.",
      requires: [],
      capabilities: {
        os: "linux",
        arch: "arm64",
        gpu: false,
        features: ["docker"],
        command: SSH_COMMAND,
        // Xtigervnc takes a viewer's SetDesktopSize itself, as on the Proxmox CPU desktop.
        displays: [{ id: "desktop", protocol: "rfb", resizable: true }],
        computerUse: LINUX_CUA,
        enrol: true,
      },
      readyTimeoutMs: READY_TIMEOUT_MS,
    },
  };
  return TART_KINDS.filter((kind) => config.kinds[kind].image).map((kind) => kinds[kind]);
}

/** A hostname from a box's name: lower-case letters, digits and "-", at most 63. */
export function hostnameOf(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || "box"
  );
}

/**
 * Checks that the VM that answers is `vm`, from the name each VM keeps in a
 * file of its own. A VM resumed after a long suspend may answer at an
 * address its DHCP lease has given to another VM since, and every clone has
 * its image's host keys. Prints "same", or "none" when the VM keeps no name
 * yet; exits 4 when it is another VM.
 */
export function identityScript(vm: string): string {
  return String.raw`f="$HOME/.config/bb-box/vm"
[ -s "$f" ] || { echo none; exit 0; }
if [ "$(cat "$f")" != ${quote(vm)} ]; then echo "The VM that answers is $(cat "$f"), not ${vm}." >&2; exit 4; fi
echo same`;
}

/** Writes the name a VM keeps of itself (identityScript). */
export function rememberScript(vm: string): string {
  return String.raw`mkdir -p "$HOME/.config/bb-box" && printf '%s\n' ${quote(vm)} > "$HOME/.config/bb-box/vm"`;
}

/**
 * Waits in a VM being filled until its desktop is logged in and Cua's
 * daemon listens, so a box that takes it can use its desktop at once. Only
 * in a Virtualization framework VM.
 */
export function desktopScript(): string {
  return String.raw`case "$(sysctl -n hw.model 2>/dev/null)" in VirtualMac*) ;; *) exit 0 ;; esac
i=0
until pgrep -qx Finder && { [ ! -d /Applications/CuaDriver.app ] || [ -S "$HOME/Library/Caches/cua-driver/cua-driver.sock" ]; }; do
  i=$((i + 1)); [ "$i" -lt 900 ] || { echo "The desktop did not log in within 3 minutes." >&2; exit 1; }
  sleep 0.2
done`;
}

/**
 * Waits in a Linux VM until its desktop's display and session run, so the
 * box's desktop opens at once. Nothing to wait for in a VM with no desktop.
 */
export function linuxDesktopScript(): string {
  return String.raw`systemctl cat bb-box-display.service >/dev/null 2>&1 || exit 0
i=0
until systemctl is-active --quiet bb-box-display.service && systemctl is-active --quiet bb-box-session.service; do
  i=$((i + 1)); [ "$i" -lt 600 ] || { echo "The desktop did not start within 2 minutes: display $(systemctl is-active bb-box-display.service), session $(systemctl is-active bb-box-session.service)." >&2; exit 1; }
  sleep 0.2
done`;
}

/**
 * Names a VM after its box: its ComputerName, LocalHostName and HostName,
 * which its prompt, its Bonjour name and its BB machine show; in a Linux VM,
 * its hostname and the 127.0.1.1 line in /etc/hosts. Only in a
 * Virtualization framework VM, never on a machine a command reaches by
 * mistake, such as a test machine.
 *
 * A Linux desktop's display wrote its X cookie for the old hostname, and X
 * clients look it up by the hostname, so the script also gives the cookie an
 * entry for any hostname, as the Proxmox LXC backend does.
 */
export function nameScript(name: string): string {
  const host = quote(hostnameOf(name));
  return `if [ "$(uname -s)" = Linux ]; then
  [ "$(systemd-detect-virt --vm 2>/dev/null)" = apple ] || { echo "not a VM"; exit 0; }
  sudo -n hostnamectl set-hostname ${host} || exit 1
  if grep -q '^127[.]0[.]1[.]1[[:space:]]' /etc/hosts; then sudo -n sed -i "s/^127[.]0[.]1[.]1[[:space:]].*/127.0.1.1 "${host}"/" /etc/hosts; else echo "127.0.1.1 "${host} | sudo -n tee -a /etc/hosts >/dev/null; fi
  auth=${DISPLAY_AUTH_FILE}
  [ -s "$auth" ] || exit 0
  xauth -q -f "$auth" nlist | sed 's/^..../ffff/' | xauth -q -f "$auth" nmerge -
  exit 0
fi
case "$(sysctl -n hw.model 2>/dev/null)" in VirtualMac*) ;; *) echo "not a VM"; exit 0 ;; esac
for key in ComputerName LocalHostName HostName; do sudo -n scutil --set "$key" ${host} || exit 1; done`;
}

/**
 * Asks a Linux VM to shut itself down, after its file systems are written
 * out: `tart stop` does not wait for a Linux guest, and what the guest had not
 * written was lost (an SSH host key made at first boot came back empty).
 * Only in an Apple Virtualization VM that names itself `vm`
 * (rememberScript), never on a machine a command reaches by mistake, such as
 * a test machine. Prints "powering off" when it asked.
 */
export function powerOffScript(vm: string): string {
  return String.raw`[ "$(systemd-detect-virt --vm 2>/dev/null)" = apple ] || { echo "not a VM"; exit 0; }
[ "$(cat "$HOME/.config/bb-box/vm" 2>/dev/null)" = ${quote(vm)} ] || { echo "not ${vm}"; exit 0; }
sync
sudo -n systemctl poweroff --no-block && echo "powering off"`;
}

/** A Mac that did not answer over SSH, or whose script failed. */
class HostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostError";
  }
}

export class TartBackend implements Backend {
  readonly id: string;
  readonly label: string;
  readonly nature = "virtual" as const;
  readonly #config: TartConfig;
  readonly #context: BackendContext;
  readonly #options: TartBackendOptions;
  readonly #kinds: BoxKind[];
  readonly #keyFile = new KeyFile();
  #ssh: Promise<SshKeys> | null = null;
  /** Each VM's address while bb-box knows it: learnt when it starts, forgotten when it stops. */
  readonly #addresses = new Map<string, string>();
  /** Each VM's guest OS, as bb-box last learnt it from its box, for its SSH user. A VM it does not know is macOS. */
  readonly #os = new Map<string, GuestOs>();
  /** VMs being started for boxes or warm pools, by VM, until they run or their start ends. */
  readonly #placing = new Map<string, Placing>();
  /** Placement is one at a time, so two acquires, or an acquire and a fill, never take the last slot of one Mac. */
  #placement: Promise<unknown> = Promise.resolve();
  /** Warm VMs this instance is filling, by VM. */
  readonly #filling = new Map<string, Fill>();
  readonly #warm: ReadyPool<BoxIdentity>;
  readonly #stopping = new AbortController();
  #maintaining: Promise<void> | null = null;

  constructor(config: TartConfig, context: BackendContext, options: TartBackendOptions = {}) {
    this.id = context.id;
    this.#config = config;
    this.#context = context;
    this.#options = options;
    this.#kinds = tartKinds(config);
    this.label = `Tart on ${config.hosts.map((host) => host.name).join(", ")}`;
    this.#warm = new ReadyPool<BoxIdentity>({
      members: (signal) => this.#members(signal),
      hold: (member, box, signal) => this.#hold(member, box, signal),
    });
  }

  kinds(): BoxKind[] {
    return this.#kinds;
  }

  #kind(id: string): BoxKind {
    const kind = this.#kinds.find((candidate) => candidate.id === id);
    if (!kind) throw new BackendError("unsupported", `${this.label} does not offer ${id} boxes.`);
    return kind;
  }

  async capacity(kind: string, size: BoxSize, pending: readonly Pending[], signal?: AbortSignal): Promise<Capacity> {
    this.#kind(kind);
    const states = await this.#states(signal);
    const placed = [...this.#placing.values()];
    const unplaced: Unplaced = {
      count: Math.max(0, pending.filter((other) => guestOsOf(other.kind) === "macos").length - placed.filter((other) => other.macos).length),
      memoryMiB: Math.max(0, pending.reduce((sum, other) => sum + other.size.memoryMiB, 0) - placed.reduce((sum, other) => sum + other.memoryMiB, 0)),
    };
    const os = guestOsOf(kind);
    const hosts = this.#on().map((host) => this.#room(host, states.get(host.name)!, size, unplaced, new Set(), os));
    // A warm VM being filled gives its slot to a box, as #place stops it or takes it over (#145).
    const filling = new Set([...this.#filling].filter(([, fill]) => !fill.adopted).map(([vm]) => vm));
    const ok =
      hosts.some((host) => host.capacity.ok) ||
      (filling.size > 0 && this.#on().some((host) => this.#room(host, states.get(host.name)!, size, unplaced, filling, os).capacity.ok));
    let ready = 0;
    for (const host of this.#on()) {
      const state = states.get(host.name)!;
      if (!(state instanceof Error)) ready += this.#freeWarm(state).filter((warm) => warm.kinds.includes(kind)).length;
    }
    return {
      ok,
      message: ok ? null : this.#full(kind, hosts),
      warm: { ready, target: this.#pools().find((pool) => pool.kinds.includes(kind))?.target ?? 0 },
      hosts: hosts.map((host) => host.capacity),
    };
  }

  /** Each Mac's state, or the error it gave. */
  async #states(signal?: AbortSignal): Promise<Map<string, HostState | Error>> {
    const entries = await Promise.all(
      this.#config.hosts.map(async (host) => [host.name, await this.#state(host, signal).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))] as const),
    );
    return new Map(entries);
  }

  /**
   * Whether a box of `size` fits on the Mac, and if not, why, with what to
   * do. VMs `yielding` count as gone. A Linux VM (`os`) does not count
   * against the Mac's two macOS VMs.
   */
  #room(
    host: TartHost,
    state: HostState | Error,
    size: BoxSize,
    unplaced: Unplaced = NONE_UNPLACED,
    yielding: ReadonlySet<string> = new Set(),
    os: GuestOs = "macos",
  ): { capacity: HostCapacity; why: string | null } {
    if (state instanceof Error) return { capacity: { host: host.name, ok: false, limits: [] }, why: `${host.name} did not answer: ${state.message}` };
    // Every running VM takes memory; only macOS VMs count against Apple's two.
    const running = state.vms.filter((vm) => vm.running && !yielding.has(vm.name));
    const macos = running.filter((vm) => (state.configs.get(vm.name)?.os ?? "darwin") === "darwin");
    const placing = [...this.#placing.values()].filter((other) => other.host === host.name && !yielding.has(other.vm) && !running.some((vm) => vm.name === other.vm));
    const starting = placing.filter((other) => other.macos).length + unplaced.count;
    const memoryUsed =
      running.reduce((sum, vm) => sum + (state.configs.get(vm.name)?.memoryMiB ?? 0), 0) + placing.reduce((sum, other) => sum + other.memoryMiB, 0) + unplaced.memoryMiB;
    const memoryFree = state.memoryMiB - memoryUsed;
    const reserve = this.#config.reserve;
    const diskReserveMiB = reserve.diskGiB * MiB_PER_GiB;
    const limits: Limit[] = [
      { resource: "guests", used: macos.length + starting, total: this.#config.vmsPerHost, reserve: 0, unit: "count" },
      { resource: "memory", used: memoryUsed, total: state.memoryMiB, reserve: reserve.memoryMiB, unit: "MiB" },
      { resource: "disk", used: state.disk.totalMiB - state.disk.freeMiB, total: state.disk.totalMiB, reserve: diskReserveMiB, unit: "MiB" },
    ];
    let why: string | null = null;
    if (size.diskGiB !== null) {
      // Growing a macOS VM's disk needs its recovery partition removed and its APFS container grown inside the guest.
      why = `a Tart box keeps its image's disk, so bb-box cannot give it a ${size.diskGiB} GiB disk yet. Ask for the base disk`;
    } else if (state.cpus && size.cores > state.cpus) {
      why = `${host.name} has ${state.cpus} cores, fewer than the ${size.cores} asked for. Ask for at most ${state.cpus} cores`;
    } else if (os === "macos" && macos.length + starting >= this.#config.vmsPerHost) {
      const names = macos.map((vm) => vm.name).join(", ");
      why =
        `${host.name} runs ${macos.length + starting} of the ${this.#config.vmsPerHost} macOS VMs it may run${names ? ` (${names})` : ""}. ` +
        "Release or stop a macOS box, or stop another VM there";
    } else if (memoryFree - size.memoryMiB < reserve.memoryMiB) {
      why =
        `${host.name} has ${formatMiB(Math.max(0, memoryFree))} of memory free, and a box with ${formatMiB(size.memoryMiB)} would leave less than the ${formatMiB(reserve.memoryMiB)} kept free. ` +
        "Ask for less memory, release a box, or lower the memory kept free in bb-box's settings";
    } else if (state.disk.freeMiB < diskReserveMiB) {
      why = `${host.name} has ${formatMiB(state.disk.freeMiB)} of disk free, less than the ${formatMiB(diskReserveMiB)} kept free. Release boxes or free some space`;
    }
    return { capacity: { host: host.name, ok: why === null, limits }, why };
  }

  /** The Macs that take new boxes now: a Mac that is off keeps its boxes and takes no more (029). */
  #on(): TartHost[] {
    return this.#config.hosts.filter((host) => this.#context.hostOn(host.name));
  }

  #full(kind: string, hosts: readonly { why: string | null }[]): string {
    if (!hosts.length) return `Every Mac is off in bb-box's settings, so none takes a new ${kind} box.`;
    const reasons = [...new Set(hosts.map((host) => host.why).filter((why): why is string => why !== null))];
    return `No Mac can take this ${kind} box: ${reasons.join("; ")}.`;
  }

  /** Runs `task` in the placement chain, one at a time. */
  #chain<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#placement.then(task);
    this.#placement = next.catch(() => undefined);
    return next;
  }

  /**
   * Chooses how a box gets its VM, and counts it against its Mac, one at a
   * time: a free warm VM of the box's own size and kind on a Mac with room;
   * else a clone on the first Mac with room; else a fill on a full Mac,
   * taken over when its size and kinds suit the box, or stopped so its slot
   * is free ("wait", outside the chain, as a fill ends in the chain).
   */
  #place(box: BoxIdentity, signal: AbortSignal): Promise<Placement> {
    return this.#chain(async (): Promise<Placement> => {
      const states = await this.#states(signal);
      const on = this.#on();
      const os = guestOsOf(box.kind);
      const rooms = on.map((host) => ({ host, ...this.#room(host, states.get(host.name)!, box.size, NONE_UNPLACED, new Set(), os) }));
      const count = (host: TartHost, vm: string) => this.#placing.set(vm, { host: host.name, vm, memoryMiB: box.size.memoryMiB, macos: os === "macos" });
      for (const room of rooms) {
        const state = states.get(room.host.name)!;
        if (!room.capacity.ok || state instanceof Error) continue;
        const warm = this.#freeWarm(state).find((free) => free.kinds.includes(box.kind) && sameSize(free.size, box.size));
        if (warm) {
          count(room.host, warm.vm);
          return { how: "warm", host: room.host, vm: warm.vm };
        }
      }
      const chosen = rooms.find((room) => room.capacity.ok);
      if (chosen) {
        count(chosen.host, vmName(box.boxId));
        return { how: "clone", host: chosen.host, vm: vmName(box.boxId) };
      }
      const fills = [...this.#filling.entries()].filter(([, fill]) => !fill.adopted && on.some((host) => host.name === fill.host));
      const suits = fills.find(([, fill]) => fill.kinds.includes(box.kind) && sameSize(fill.size, box.size));
      if (suits) {
        const [vm, fill] = suits;
        fill.adopted = true;
        return { how: "adopt", host: on.find((host) => host.name === fill.host)!, vm, fill };
      }
      if (fills.length) {
        for (const [, fill] of fills) fill.abort.abort(new Error("A box needs the slot this warm VM was taking."));
        return { how: "wait", fills: fills.map(([, fill]) => fill) };
      }
      throw new BackendError("no_capacity", this.#full(box.kind, rooms));
    });
  }

  /** Places a box, waiting once for fills it stopped to let go of their slot. */
  async #placeBox(box: BoxIdentity, signal: AbortSignal): Promise<Exclude<Placement, { how: "wait" }>> {
    for (let attempt = 0; ; attempt++) {
      const placement = await this.#place(box, signal);
      if (placement.how !== "wait") return placement;
      await Promise.all(placement.fills.map((fill) => fill.done));
      if (attempt > 0) throw new BackendError("no_capacity", `No Mac had room for this ${box.kind} box, even after stopping the warm VMs being made.`);
    }
  }

  async acquire(box: BoxIdentity, previous: Guest | null, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest> {
    const kind = this.#kind(box.kind);
    const image = this.#config.kinds[box.kind as TartKind].image!;
    const os = guestOsOf(box.kind);
    const deadline = Date.now() + (this.#options.readyTimeoutMs ?? kind.readyTimeoutMs);
    const step: Step = async (name, run) => {
      const started = performance.now();
      try {
        return await run();
      } finally {
        hooks.timing(name, Math.round(performance.now() - started));
      }
    };
    const owner = ownerText({
      install: this.#context.installId,
      kind: box.kind,
      box: box.boxId,
      thread: box.threadId,
      name: box.name,
      created: box.createdAt,
    });
    let placement: Exclude<Placement, { how: "wait" }> | null = await this.#previous(box, previous, signal);
    if (placement) this.#placing.set(placement.vm, { host: placement.host.name, vm: placement.vm, memoryMiB: box.size.memoryMiB, macos: os === "macos" });
    let started = false;
    const starting = async () => {
      if (!started) await hooks.starting();
      started = true;
    };
    // A warm VM that fails to resume or answers as another VM gives way to a clone, once.
    for (let attempt = 0; ; attempt++) {
      placement ??= await step("place", () => this.#placeBox(box, signal));
      const { host, vm } = placement;
      // A Linux box says so, for its SSH user; a macOS box's data is as it was.
      const data: Readonly<Record<string, string>> = os === "linux" ? { box: box.boxId, os } : { box: box.boxId };
      const guest = (address: string | null, size: BoxSize | null = null): Guest => ({ ref: vm, host: host.name, address, size, data });
      this.#os.set(vm, os);
      let owned = placement.how === "resume";
      try {
        let address: string;
        if (placement.how === "clone") {
          await hooks.claim(guest(null));
          const claimed = (await this.#run(host, claimScript(vm, owner), { signal })).stdout.trim();
          if (claimed !== "claimed") {
            const fields = parseFields(claimed);
            if (fields.install !== this.#context.installId || fields.box !== box.boxId) {
              throw new Error(`VM ${vm} on ${host.name} belongs to another box, so bb-box left it alone.`);
            }
          }
          owned = true;
          await step("clone", () => this.#run(host, cloneScript(image, vm, box.size.cores, box.size.memoryMiB), { timeoutMs: 10 * 60_000, signal }));
          await starting();
          await step("start", () => this.#start(host, vm, deadline, signal));
          address = await step("network", () => this.#address(host, vm, deadline, signal));
        } else if (placement.how === "adopt") {
          const fill = placement.fill;
          await hooks.claim(guest(null));
          const held = (await this.#run(host, holdScript(vm, this.#context.installId, "filling", owner), { signal })).stdout.trim();
          if (held !== "held") throw new Error(`The warm VM ${vm} on ${host.name} being made was no longer there to take over.`);
          owned = true;
          await starting();
          address = await step("warm", () => fill.ready);
          this.#kick();
        } else {
          if (placement.how === "warm") {
            const member = await step("warm", () =>
              this.#warm.claim(box.kind, box, {
                fits: (candidate) => candidate.ref === vm,
                before: async () => hooks.claim(guest(null)),
                signal,
              }),
            );
            if (!member) throw new Error(`The warm VM ${vm} on ${host.name} was taken or retired first.`);
            this.#kick();
          }
          owned = true;
          await starting();
          await step("start", () => this.#start(host, vm, deadline, signal, false));
          address = await step("network", () => this.#address(host, vm, deadline, signal));
        }
        await step("ssh", () => this.#waitReady(host, vm, address, deadline, signal));
        if (os === "linux" && kind.capabilities.displays.length) await step("desktop", () => this.#linuxDesktop(host, vm, address, signal));
        await step("name", () => this.#name(host, address, vm, box.name, signal));
        const size = sizeOf((await this.#state(host, signal)).configs.get(vm));
        // Claimed again, so the box's record has the address and size as it becomes ready.
        await hooks.claim(guest(address, size));
        return guest(address, size);
      } catch (error) {
        if (owned) await this.#delete(host, vm, box.boxId).catch((cause) => this.#context.logError("release after a failed acquire", cause));
        const retry = placement.how !== "clone" && attempt === 0 && !signal.aborted && Date.now() < deadline;
        if (!retry) throw error;
        this.#context.logError("acquire", new Error(`Box ${box.name} could not use VM ${vm} (${message(error)}), so bb-box clones a VM for it.`));
      } finally {
        this.#placing.delete(placement.vm);
      }
      placement = null;
    }
  }

  /**
   * The VM a restarted acquire made or held: bb-box-<box ID>, or a warm VM
   * whose owner file names the box (it was held before the restart). A warm
   * VM still marked warm was not held, and the acquire starts over.
   */
  async #previous(box: BoxIdentity, previous: Guest | null, signal: AbortSignal): Promise<Exclude<Placement, { how: "wait" }> | null> {
    const host = previous ? this.#hostNamed(previous.host) : null;
    if (!previous || !host) return null;
    if (previous.ref === vmName(box.boxId)) return { how: "clone", host, vm: previous.ref };
    if (!previous.ref.startsWith(WARM_PREFIX)) return null;
    const fields = parseFields((await this.#run(host, ownerScript(previous.ref), { signal })).stdout);
    return fields.install === this.#context.installId && fields.box === box.boxId ? { how: "resume", host, vm: previous.ref } : null;
  }

  async release(guest: Guest, hooks: ReleaseHooks, signal?: AbortSignal): Promise<void> {
    const host = this.#hostOf(guest);
    const started = performance.now();
    await this.#delete(host, guest.ref, this.#boxOf(guest), signal);
    hooks.timing("delete", Math.round(performance.now() - started));
  }

  async power(guest: Guest, signal?: AbortSignal): Promise<PowerState | null> {
    const host = this.#hostNamed(guest.host);
    if (!host) return "unknown";
    let result: RunResult;
    try {
      result = await this.#run(host, powerScript(guest.ref, this.#context.installId, this.#boxOf(guest)), { timeoutMs: 30_000, signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      return "unknown";
    }
    const state = result.stdout.trim().split("\n").pop();
    if (state === "gone") return null;
    return powerOf(state);
  }

  async start(guest: Guest, signal?: AbortSignal): Promise<void> {
    const host = this.#hostOf(guest);
    const deadline = Date.now() + (this.#options.readyTimeoutMs ?? READY_TIMEOUT_MS);
    if ((await this.power(guest, signal)) === null) throw this.#gone(guest);
    this.#addresses.delete(guest.ref);
    this.#os.set(guest.ref, this.#osOf(guest));
    await this.#start(host, guest.ref, deadline, signal, true, this.#boxOf(guest));
    const address = await this.#address(host, guest.ref, deadline, signal);
    await this.#waitReady(host, guest.ref, address, deadline, signal);
    await this.#identify(host, address, guest.ref, signal);
    if (this.#osOf(guest) === "linux") await this.#linuxDesktop(host, guest.ref, address, signal);
  }

  async stop(guest: Guest, signal?: AbortSignal): Promise<void> {
    const host = this.#hostOf(guest);
    // A Linux VM shuts itself down, and the Mac waits for it; one that cannot be asked is stopped.
    // Only this install's box is asked, and only when it runs: another install's is "gone" (stopScript).
    let how: "suspend" | "stop" | "shutdown" = "suspend";
    if (this.#osOf(guest) === "linux") {
      const power = await this.power(guest, signal);
      if (power === null) throw this.#gone(guest);
      how = power === "running" && (await this.#powerOff(host, guest, signal)) ? "shutdown" : "stop";
    }
    await this.#forget(host, guest.ref);
    const result = await this.#run(host, stopScript(guest.ref, this.#context.installId, this.#boxOf(guest), how), { timeoutMs: 240_000, signal });
    if (result.stdout.trim() === "gone") throw this.#gone(guest);
  }

  /**
   * Gives a box's VM a new owner and name, as when a spare becomes yours or
   * a thread's (036): its owner file names them, and the VM takes the name
   * inside when it changed. Best effort, as core logs a failure.
   */
  async relabel(guest: Guest, box: BoxIdentity, from: string, signal?: AbortSignal): Promise<void> {
    const host = this.#hostOf(guest);
    const owner = ownerText({ install: this.#context.installId, kind: box.kind, box: box.boxId, thread: box.threadId, name: box.name, created: box.createdAt });
    const result = (await this.#run(host, relabelScript(guest.ref, this.#context.installId, box.boxId, owner), { signal })).stdout.trim();
    if (result !== "relabelled") throw new Error(`The owner file of ${guest.ref} on ${host.name} does not name box ${box.boxId}.`);
    this.#os.set(guest.ref, this.#osOf(guest));
    if (from !== box.name && guest.address) await this.#name(host, guest.address, guest.ref, box.name, signal);
  }

  /** This install's VMs on every Mac that answers, from their owner files. */
  async held(signal?: AbortSignal): Promise<HeldGuest[]> {
    const held: HeldGuest[] = [];
    const states = await this.#states(signal);
    for (const host of this.#config.hosts) {
      const state = states.get(host.name)!;
      if (state instanceof Error) {
        this.#context.logError("held", state);
        continue;
      }
      for (const [vm, fields] of state.owners) {
        if (fields.install !== this.#context.installId) continue;
        // A warm VM is no box's, and neither is one this instance is filling.
        // One being filled when bb-box stopped is listed with no owner, so the
        // sweep releases it.
        const warm = warmState(fields);
        if (warm === "warm" || (warm === "filling" && this.#filling.has(vm))) continue;
        const owner = ownerOf(fields);
        const listed = state.vms.find((candidate) => candidate.name === vm);
        held.push({
          ref: vm,
          host: host.name,
          address: this.#addresses.get(vm) ?? null,
          size: sizeOf(state.configs.get(vm)),
          data: owner ? (guestOsOf(fields.kind ?? "") === "linux" ? { box: owner.boxId, os: "linux" } : { box: owner.boxId }) : {},
          owner,
          // A VM not made yet, after an acquire cut short before its clone, counts as stopped.
          power: listed ? powerOf(listed.state) : "stopped",
        });
      }
    }
    return held;
  }

  // The warm pool: suspended clones at a kind's default size (028), which hold
  // no VM slot and no memory, only disk, until a box takes one and resumes it.

  /** Retires warm VMs that serve no pool now, or beyond their pool's count, then fills what is missing. */
  maintain(signal?: AbortSignal): Promise<void> {
    if (!this.#maintaining) {
      const run = this.#topUp(signal ?? this.#stopping.signal).finally(() => {
        this.#maintaining = null;
      });
      this.#maintaining = run;
    }
    return this.#maintaining;
  }

  /** Tops the pool up in the background after a box takes a warm VM. */
  #kick(): void {
    if (!this.#pools().some((pool) => pool.target > 0)) return;
    this.maintain(this.#stopping.signal).catch((error) => this.#context.logError("warm pool", error));
  }

  /**
   * The warm pools the configuration asks for now: kinds with an image, on,
   * whose default size Tart can make, grouped by image and default size.
   */
  #pools(): WarmPool[] {
    const pools: WarmPool[] = [];
    for (const kind of this.#kinds) {
      const settings = this.#context.kind(kind.id);
      const image = this.#config.kinds[kind.id as TartKind].image;
      // Warm VMs are suspended, which Tart cannot do to a Linux VM (040).
      if (kind.capabilities.os !== "macos") continue;
      if (!settings.enabled || !image || settings.defaultSize.diskGiB !== null) continue;
      const size = settings.defaultSize;
      const index = pools.findIndex((pool) => pool.image === image && sameSize(pool.size, size));
      const target = this.#context.warm(kind.id);
      if (index < 0) pools.push({ image, size, kinds: [kind.id], target });
      else pools[index] = { ...pools[index]!, kinds: [...pools[index]!.kinds, kind.id], target: pools[index]!.target + target };
    }
    return pools;
  }

  /**
   * The kinds a warm VM serves now: those whose image is the VM's, at the
   * build the VM was cloned from, and whose default size is the VM's. A VM
   * saved under another Tart or macOS build serves none, as its state may
   * not restore.
   */
  #servedBy(state: HostState, fields: Readonly<Record<string, string>>, size: BoxSize | null): string[] {
    if (!size || fields.tart !== state.version || fields.macos !== state.macosBuild) return [];
    return this.#pools()
      .filter((pool) => pool.image === fields.image && (state.builds.get(pool.image) ?? "") === (fields.build ?? "") && sameSize(pool.size, size))
      .flatMap((pool) => pool.kinds);
  }

  /** This install's free warm VMs on a Mac: suspended, marked warm, serving a kind now. */
  #freeWarm(state: HostState): FreeWarm[] {
    const free: FreeWarm[] = [];
    for (const [vm, fields] of state.owners) {
      if (fields.install !== this.#context.installId || warmState(fields) !== "warm") continue;
      if (state.vms.find((candidate) => candidate.name === vm)?.state !== "suspended") continue;
      const size = sizeOf(state.configs.get(vm));
      const kinds = this.#servedBy(state, fields, size);
      if (size && kinds.length) free.push({ vm, size, kinds });
    }
    return free;
  }

  /** The pool's members, as ReadyPool sees them: the free warm VMs on the Macs that are on. */
  async #members(signal?: AbortSignal): Promise<PoolMember[]> {
    const states = await this.#states(signal);
    const members: PoolMember[] = [];
    for (const host of this.#on()) {
      const state = states.get(host.name)!;
      if (state instanceof Error) continue;
      for (const warm of this.#freeWarm(state)) {
        members.push({ ref: warm.vm, host: host.name, kinds: warm.kinds, state: "free", reason: null, since: 0, generation: 0 });
      }
    }
    return members;
  }

  /** Hands a warm VM to a box: its owner file names the box from now on. */
  async #hold(member: PoolMember, box: BoxIdentity, signal?: AbortSignal): Promise<void> {
    const host = this.#hostNamed(member.host);
    if (!host) throw new Error(`Mac ${member.host} is not in bb-box's settings.`);
    const owner = ownerText({ install: this.#context.installId, kind: box.kind, box: box.boxId, thread: box.threadId, name: box.name, created: box.createdAt });
    const held = (await this.#run(host, holdScript(member.ref, this.#context.installId, "warm", owner), { signal })).stdout.trim();
    if (held !== "held") throw new Error(`The warm VM ${member.ref} on ${host.name} is no longer free.`);
  }

  async #topUp(signal: AbortSignal): Promise<void> {
    const pools = this.#pools();
    // Retire, while no claim runs, warm VMs that serve no pool now, or beyond
    // their pool's count. A Mac that is off keeps its warm VMs, which count
    // again when it is on.
    const retired = await this.#warm.exclusive(async () => {
      const states = await this.#states(signal);
      const kept = new Map<WarmPool, number>();
      const out: { host: TartHost; vm: string }[] = [];
      for (const host of this.#on()) {
        const state = states.get(host.name)!;
        if (state instanceof Error) continue;
        for (const [vm, fields] of state.owners) {
          if (fields.install !== this.#context.installId || warmState(fields) !== "warm") continue;
          const size = sizeOf(state.configs.get(vm));
          const kinds = this.#servedBy(state, fields, size);
          const pool = pools.find((candidate) => kinds.length && candidate.kinds.includes(kinds[0]!));
          const count = pool ? (kept.get(pool) ?? 0) : 0;
          // Only a suspended warm VM can be claimed: one that someone ran or
          // stopped since is retired. One being claimed no longer says warm.
          const suspended = state.vms.find((candidate) => candidate.name === vm)?.state === "suspended";
          if (pool && suspended && count < pool.target) {
            kept.set(pool, count + 1);
            continue;
          }
          out.push({ host, vm });
        }
      }
      return out;
    });
    for (const { host, vm } of retired) {
      // Its owner file names no box, so a box that held it meanwhile keeps it.
      await this.#delete(host, vm, null, signal).catch((error) => this.#context.logError("retire a warm VM", error));
    }

    for (const pool of pools) {
      if (pool.target === 0) continue;
      const states = await this.#states(signal);
      let ready = 0;
      for (const host of this.#on()) {
        const state = states.get(host.name)!;
        if (!(state instanceof Error)) ready += this.#freeWarm(state).filter((warm) => warm.kinds.includes(pool.kinds[0]!)).length;
      }
      const filling = [...this.#filling.values()].filter((fill) => !fill.adopted && sameSize(fill.size, pool.size) && fill.kinds.includes(pool.kinds[0]!)).length;
      for (let missing = pool.target - ready - filling; missing > 0; missing--) {
        signal.throwIfAborted();
        if (!(await this.#fill(pool, signal))) break;
      }
    }
  }

  /**
   * Makes one warm VM of a pool: clones it, boots it to the logged-in
   * desktop, and suspends it. It takes a VM slot and its memory until then,
   * so it is placed as a box is, and an acquire that needs the slot takes it
   * over or stops it. Resolves false when no Mac has room.
   */
  async #fill(pool: WarmPool, signal: AbortSignal): Promise<boolean> {
    const vm = `${WARM_PREFIX}${randomBytes(6).toString("hex")}`;
    const placed = await this.#chain(async () => {
      const states = await this.#states(signal);
      for (const host of this.#on()) {
        const state = states.get(host.name)!;
        if (state instanceof Error || !this.#room(host, state, pool.size).capacity.ok) continue;
        this.#placing.set(vm, { host: host.name, vm, memoryMiB: pool.size.memoryMiB, macos: true });
        return { host, state };
      }
      return null;
    });
    if (!placed) return false;
    const { host, state } = placed;
    const abort = new AbortController();
    const fillSignal = AbortSignal.any([signal, abort.signal]);
    let ready!: { resolve(address: string): void; reject(error: unknown): void };
    let done!: () => void;
    const fill: Fill = {
      host: host.name,
      size: pool.size,
      kinds: pool.kinds,
      abort,
      ready: new Promise<string>((resolve, reject) => (ready = { resolve, reject })),
      done: new Promise<void>((resolve) => (done = resolve)),
      adopted: false,
    };
    fill.ready.catch(() => undefined);
    this.#filling.set(vm, fill);
    const deadline = Date.now() + (this.#options.readyTimeoutMs ?? READY_TIMEOUT_MS);
    try {
      const owner = ownerText({
        install: this.#context.installId,
        state: "filling",
        image: pool.image,
        build: state.builds.get(pool.image) ?? "",
        tart: state.version,
        macos: state.macosBuild,
      });
      const claimed = (await this.#run(host, claimScript(vm, owner), { signal: fillSignal })).stdout.trim();
      if (claimed !== "claimed") throw new Error(`Warm VM ${vm} on ${host.name} is already there.`);
      await this.#run(host, cloneScript(pool.image, vm, pool.size.cores, pool.size.memoryMiB), { timeoutMs: 10 * 60_000, signal: fillSignal });
      await this.#start(host, vm, deadline, fillSignal, false);
      const address = await this.#address(host, vm, deadline, fillSignal);
      await this.#waitReady(host, vm, address, deadline, fillSignal);
      await this.#identify(host, address, vm, fillSignal);
      const { ssh } = await this.#keys();
      const desktop = await new SshTransport(ssh, this.#vm(await this.#mac(host), address), "macos").run(desktopScript(), {
        timeoutMs: 240_000,
        signal: fillSignal,
        maxOutputBytes: 4096,
      });
      if (desktop.exitCode !== 0) throw new Error(`Warm VM ${vm} on ${host.name}: ${desktop.stderr.trim() || `exit code ${desktop.exitCode}`}`);
      ready.resolve(address);
      // In the chain, so an acquire that takes the VM over and this suspend never cross.
      const adopted = await this.#chain(async () => {
        if (fill.adopted) return true;
        fillSignal.throwIfAborted();
        await this.#forget(host, vm);
        const result = (await this.#run(host, warmScript(vm, this.#context.installId), { timeoutMs: 120_000, signal: fillSignal })).stdout.trim();
        if (result !== "warm") throw new Error(`Warm VM ${vm} on ${host.name} was no longer being filled.`);
        return false;
      });
      if (!adopted) this.#placing.delete(vm);
      return true;
    } catch (error) {
      ready.reject(error);
      if (!fill.adopted) {
        this.#placing.delete(vm);
        await this.#delete(host, vm, null).catch((cause) => this.#context.logError("release a warm VM that failed", cause));
      }
      // Stopped for an acquire that needed the slot: no room for another now.
      if (abort.signal.aborted) return false;
      throw error;
    } finally {
      this.#filling.delete(vm);
      done();
    }
  }

  async transports(guest: Guest, kind: string): Promise<BoxTransports> {
    const host = this.#hostOf(guest);
    const { ssh } = await this.#keys();
    const mac = await this.#mac(host);
    let address: string | null = this.#addresses.get(guest.ref) ?? null;
    if (!address) {
      address = (await this.#lookup(host, guest.ref).catch(() => null)) ?? guest.address;
    }
    if (!address) throw new TransportError("unreachable", `The VM ${guest.ref} on ${host.name} has no address. It may be stopped.`);
    const os = guestOsOf(kind);
    this.#os.set(guest.ref, os);
    const access = this.#vm(mac, address, os);
    const command = new SshTransport(ssh, access, os);
    const capabilities = this.#kinds.find((candidate) => candidate.id === kind)?.capabilities;
    const displays = (capabilities?.displays ?? []).map(
      (display): Display => ({
        ...display,
        label: "Desktop",
        open: async (signal) => {
          // A Linux desktop's own VNC server, through SSH to the VM; a macOS desktop's is Tart's, on the Mac.
          if (os === "linux") {
            const password = await this.#linuxVncPassword(command, signal);
            return { route: ssh.route(access, LINUX_VNC_PORT), auth: password ? { type: "vnc-password", password } : { type: "none" } };
          }
          const vnc = await this.#vnc(host, guest.ref, signal);
          return { route: ssh.route(mac, vnc.port), auth: { type: "vnc-password", password: vnc.password } };
        },
      }),
    );
    return { command, displays, access: { ssh: access, dockerHost: null } };
  }

  async doctor(signal?: AbortSignal): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    const notes: string[] = [`This install's ID is ${this.#context.installId}. Its VMs' owner files on each Mac, in ~/.bb-box/tart/owners, name it.`];
    const push = (id: string, name: string, status: DoctorCheck["status"], detail: string, fix: string | null = null) =>
      checks.push({ id, name, status, detail, fix });

    let keys: SshKeys | null = null;
    try {
      keys = await this.#keys();
      if (keys.publicKey) {
        push("tart.ssh-key", "SSH key", "ok", keys.generated ? "bb-box made a key; its public key is below." : "From bb-box's settings; its public key is below.");
        notes.push(
          `Each Mac's user, user ${this.#config.ssh.vmUser} in each macOS image and user ${LINUX_USER} in the Linux image, must accept this SSH key in ~/.ssh/authorized_keys: ${keys.publicKey}`,
        );
      } else {
        push("tart.ssh-key", "SSH key", "fail", "ssh-keygen cannot read the SSH private key in bb-box's settings.", "Paste the whole private key, or clear the setting so bb-box makes one.");
      }
    } catch (error) {
      push("tart.ssh-key", "SSH key", "fail", message(error), "Check the SSH private key in bb-box's settings, or clear it so bb-box makes one.");
    }

    if (!this.#config.hosts.length) {
      push("tart.hosts", "Macs", "fail", "There are no Macs yet.", "Add a Mac, with its address, user and host key, as setup/tart/README.md says.");
    }
    const states = keys ? await this.#states(signal) : new Map<string, HostState | Error>();
    const others = new Map<string, number>();
    for (const host of this.#config.hosts) {
      const id = `host.${host.name}`;
      const name = `Mac ${host.name}`;
      const images = TART_KINDS.filter((kind) => this.#config.kinds[kind].image);
      const state = states.get(host.name);
      if (!state || state instanceof Error) {
        push(
          id,
          name,
          state ? "fail" : "skipped",
          state ? state.message : "Skipped until the checks above pass.",
          state ? `Check that ${host.user}@${host.address} accepts bb-box's key over SSH, that its host key is in bb-box's settings, and that Tart is installed (setup/tart/README.md).` : null,
        );
        for (const kind of images) push(`image.${host.name}.${kind}`, `${kind} image on ${host.name}`, "skipped", "Skipped until the checks above pass.");
        continue;
      }
      if (state.arch !== "arm64") {
        push(id, name, "fail", `${host.name} is ${state.arch || "not Apple silicon"}; Tart runs macOS VMs on Apple silicon only.`, "Use a Mac with Apple silicon.");
      } else {
        push(id, name, "ok", `macOS ${state.macos} on Apple silicon, Tart ${state.version}.`);
      }
      for (const kind of images) {
        const image = this.#config.kinds[kind].image!;
        const listed = state.vms.find((vm) => vm.name === image);
        const config = state.configs.get(image);
        if (!listed) {
          const script = guestOsOf(kind) === "linux" ? `prepare-linux-image.sh${kind === "linux-arm64-desktop-cpu" ? " --desktop" : ""}` : "prepare-image.sh";
          push(`image.${host.name}.${kind}`, `${kind} image on ${host.name}`, "fail", `${host.name} has no Tart VM ${image}.`, `Prepare it with setup/tart/${script}, or set the image in bb-box's settings.`);
        } else if (config?.os && config.os !== (guestOsOf(kind) === "linux" ? "linux" : "darwin")) {
          const wanted = guestOsOf(kind) === "linux" ? "Linux" : "macOS";
          push(`image.${host.name}.${kind}`, `${kind} image on ${host.name}`, "fail", `${image} on ${host.name} is a ${config.os} VM.`, `Give a ${wanted} image.`);
        } else {
          push(`image.${host.name}.${kind}`, `${kind} image on ${host.name}`, "ok", `${image}${config ? `, ${config.cpus} cores and ${formatMiB(config.memoryMiB)} as prepared` : ""}.`);
        }
      }
      const room = this.#room(host, state, DOCTOR_SIZE);
      push(
        `capacity.${host.name}`,
        `Room on ${host.name}`,
        room.capacity.ok ? "ok" : "warn",
        room.why ?? room.capacity.limits.map((limit) => `${limit.resource} ${limit.unit === "MiB" ? `${formatMiB(limit.used)} of ${formatMiB(limit.total ?? 0)}` : `${limit.used} of ${limit.total}`}`).join(", "),
        room.capacity.ok ? null : "Release or stop a macOS box, or stop another VM on the Mac.",
      );
      for (const [, fields] of state.owners) {
        if (fields.install === this.#context.installId) continue;
        const key = fields.install || "none";
        others.set(key, (others.get(key) ?? 0) + 1);
      }
    }
    if (others.size) {
      notes.push(
        `bb-box leaves alone the VMs of other installs on these Macs: ${[...others].map(([install, count]) => `${count} of install ${install}`).join(", ")}. They still count against each Mac's room.`,
      );
    }
    const ok = checks.every((check) => check.status !== "fail");
    const first = checks.find((check) => check.status === "fail");
    const answering = [...states.values()].find((state): state is HostState => !(state instanceof Error));
    return {
      ok,
      summary: ok ? `Tart ${answering?.version ?? "?"} on ${this.#config.hosts.map((host) => host.name).join(", ")}` : `${first!.name}: ${first!.detail}`,
      checks,
      notes,
    };
  }

  async dispose(): Promise<void> {
    this.#stopping.abort(new Error("bb-box is stopping."));
    await this.#maintaining?.catch(() => undefined);
    const pending = this.#ssh;
    this.#ssh = null;
    const keys = await pending?.catch(() => null);
    await keys?.ssh.dispose().catch(() => undefined);
    await this.#keyFile.dispose();
  }

  // The Mac's side.

  #hostNamed(name: string | null): TartHost | null {
    return this.#config.hosts.find((host) => host.name === name) ?? null;
  }

  #hostOf(guest: Guest): TartHost {
    const host = this.#hostNamed(guest.host);
    if (!host) throw new Error(`Box VM ${guest.ref} is on Mac ${guest.host ?? "unknown"}, which is not in bb-box's Tart settings. Add the Mac back to reach it.`);
    return host;
  }

  #boxOf(guest: Guest): string | null {
    return typeof guest.data?.box === "string" ? guest.data.box : null;
  }

  #gone(guest: Guest): BackendError {
    return new BackendError("gone", `The VM ${guest.ref} no longer exists on ${guest.host}.`);
  }

  async #mac(host: TartHost): Promise<SshAccess> {
    return { host: host.address, port: host.port, user: host.user, hostKeys: this.#config.hostKeys };
  }

  /** SSH to a VM through its Mac, as the user its OS works as. */
  #vm(mac: SshAccess, address: string, os: GuestOs = "macos"): SshAccess {
    return { host: address, port: 22, user: os === "linux" ? LINUX_USER : this.#config.ssh.vmUser, hostKeys: [], jump: mac };
  }

  /** A box's guest OS, from its data: a Linux box's says so (acquire). */
  #osOf(guest: Guest): GuestOs {
    return guest.data?.os === "linux" ? "linux" : "macos";
  }

  /** Runs a script on the Mac. Throws when the Mac does not answer, or the script fails. */
  async #run(host: TartHost, script: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RunResult> {
    const { ssh } = await this.#keys();
    const result = await ssh.run(await this.#mac(host), script, { timeoutMs: options.timeoutMs ?? 60_000, signal: options.signal, maxOutputBytes: 1 << 20 }, "macos");
    if (result.timedOut) throw new HostError(`${host.name} did not finish in time.`);
    if (result.exitCode === 255) throw new HostError(`${host.name} did not answer over SSH as ${host.user}: ${result.stderr.trim() || "no reason given"}.`);
    if (result.exitCode !== 0) {
      throw new HostError(`On ${host.name}: ${result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`}`);
    }
    return result;
  }

  async #state(host: TartHost, signal?: AbortSignal): Promise<HostState> {
    return parseState((await this.#run(host, stateScript(), { timeoutMs: 30_000, signal })).stdout);
  }

  /**
   * Starts the VM, detached from SSH, and fails fast when Tart cannot. A VM
   * whose saved state does not restore, as after an update of macOS or Tart,
   * boots afresh from its disk when `discard` is true; a warm VM gives way to
   * a clone instead.
   */
  async #start(host: TartHost, vm: string, deadline: number, signal?: AbortSignal, discard = true, box: string | null = null): Promise<void> {
    try {
      await this.#launch(host, vm, deadline, signal);
    } catch (error) {
      if (!discard || !failedRestore(error)) throw error;
      this.#context.logError(
        "start",
        new Error(
          `Warning: the saved state of ${box ? `box ${box}'s VM ${vm}` : vm} on ${host.name} did not restore, so it boots afresh from its disk; what ran in it is lost. ` +
            `After an update of macOS or Tart, every stopped box on the Mac does this once. ${message(error)}`,
        ),
      );
      await this.#run(host, discardStateScript(vm), { timeoutMs: 30_000, signal });
      await this.#launch(host, vm, deadline, signal);
    }
  }

  async #launch(host: TartHost, vm: string, deadline: number, signal?: AbortSignal): Promise<void> {
    const seconds = Math.max(5, Math.min(180, Math.round((deadline - Date.now()) / 1000)));
    const { ssh } = await this.#keys();
    const result = await ssh.run(await this.#mac(host), startScript(vm, seconds), { timeoutMs: (seconds + 30) * 1000, signal, maxOutputBytes: 1 << 16 }, "macos");
    if (result.exitCode === 0) return;
    const said = result.stderr.trim();
    if (result.exitCode === 3 && /exceeds the system limit/i.test(said)) {
      throw new BackendError(
        "no_capacity",
        `${host.name} already runs as many VMs as macOS allows, two: ${said.split("\n").pop()}. Release or stop a macOS box, or stop another VM on ${host.name}.`,
      );
    }
    if (result.exitCode === 255) throw new HostError(`${host.name} did not answer over SSH as ${host.user}: ${said || "no reason given"}.`);
    throw new Error(`Tart could not start ${vm} on ${host.name}: ${said || `exit code ${result.exitCode}`}`);
  }

  /** Waits for the VM's DHCP lease on the Mac, and keeps the address. */
  async #address(host: TartHost, vm: string, deadline: number, signal?: AbortSignal): Promise<string> {
    const seconds = Math.max(5, Math.round((deadline - Date.now()) / 1000));
    const result = await this.#run(host, ipScript(vm, seconds), { timeoutMs: (seconds + 30) * 1000, signal }).catch((error: unknown) => {
      throw new Error(`${vm} on ${host.name} got no address within ${seconds} s: ${message(error)}`);
    });
    const address = result.stdout.trim();
    if (!/^[0-9a-f.:]+$/i.test(address)) throw new Error(`Tart gave ${vm} on ${host.name} no address: ${address || "nothing"}.`);
    this.#addresses.set(vm, address);
    return address;
  }

  async #lookup(host: TartHost, vm: string): Promise<string | null> {
    const address = (await this.#run(host, ipScript(vm, 0), { timeoutMs: 15_000 })).stdout.trim();
    if (!/^[0-9a-f.:]+$/i.test(address)) return null;
    this.#addresses.set(vm, address);
    return address;
  }

  /** Waits until SSH to the VM, through the Mac, answers, on the connection its first commands then share. */
  async #waitReady(host: TartHost, vm: string, address: string, deadline: number, signal?: AbortSignal): Promise<void> {
    const { ssh } = await this.#keys();
    const os = this.#os.get(vm) ?? "macos";
    const access = this.#vm(await this.#mac(host), address, os);
    const command = new SshTransport(ssh, access, os);
    const left = Math.max(1_000, deadline - Date.now());
    const answers = { probe: (inner?: AbortSignal) => command.answers(inner) };
    const ready = await waitUntilAnswers(answers, { timeoutMs: left, intervalMs: 500, signal, sleep: this.#options.sleep ?? pause });
    if (!ready) {
      throw new Error(
        `${vm} on ${host.name} did not answer SSH as ${access.user} at ${address} within ${Math.round(left / 1000)} s. ` +
          `Check that the image's user ${access.user} accepts bb-box's key.`,
      );
    }
  }

  async #vnc(host: TartHost, vm: string, signal?: AbortSignal): Promise<{ port: number; password: string }> {
    const vnc = parseVnc((await this.#run(host, vncScript(vm), { timeoutMs: 15_000, signal })).stdout);
    if (!vnc) throw new Error(`Tart's VNC server for ${vm} on ${host.name} is not running. The VM may be stopped.`);
    return vnc;
  }

  /**
   * Checks that the VM that answers at `address` is `vm` (identityScript). A
   * VM that keeps no name, as one made before names were kept or whose file
   * was removed, is named only when the Mac's ARP table, just after bb-box
   * reached the address, gives the MAC address in the VM's config.
   */
  async #identify(host: TartHost, address: string, vm: string, signal?: AbortSignal): Promise<void> {
    const { ssh } = await this.#keys();
    const os = this.#os.get(vm) ?? "macos";
    const command = new SshTransport(ssh, this.#vm(await this.#mac(host), address, os), os);
    const result = await command.run(identityScript(vm), { timeoutMs: 30_000, signal, maxOutputBytes: 4096 });
    if (result.exitCode !== 0) throw new Error(`${host.name}: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
    if (result.stdout.trim() !== "none") return;
    const { answered, expected } = parseMacs((await this.#run(host, macScript(vm, address), { timeoutMs: 15_000, signal })).stdout);
    if (!expected || !answered || normalMac(expected) !== normalMac(answered)) {
      throw new Error(
        `${host.name}: the VM that answers at ${address} keeps no name, and its MAC address is ${answered ?? "unknown"}, not ${vm}'s ${expected ?? "(unknown)"}.`,
      );
    }
    const remembered = await command.run(rememberScript(vm), { timeoutMs: 30_000, signal, maxOutputBytes: 4096 });
    if (remembered.exitCode !== 0) throw new Error(`${host.name}: ${remembered.stderr.trim() || `exit code ${remembered.exitCode}`}`);
  }

  /**
   * Checks the VM is `vm`, then names it after its box. A box whose name could
   * not be set still works, so that only logs.
   */
  async #name(host: TartHost, address: string, vm: string, name: string, signal?: AbortSignal): Promise<void> {
    await this.#identify(host, address, vm, signal);
    const { ssh } = await this.#keys();
    const os = this.#os.get(vm) ?? "macos";
    const command = new SshTransport(ssh, this.#vm(await this.#mac(host), address, os), os);
    const result = await command.run(nameScript(name), { timeoutMs: 30_000, signal, maxOutputBytes: 4096 }).catch((error: unknown) => error);
    if (result instanceof Error || (result as RunResult).exitCode !== 0) {
      const why = result instanceof Error ? result.message : (result as RunResult).stderr.trim() || `exit code ${(result as RunResult).exitCode}`;
      this.#context.logError("name the box", new Error(`Could not name the VM ${vm} on ${host.name} ${hostnameOf(name)}: ${why}`));
    }
  }

  /** Waits for a Linux VM's desktop, when it has one (linuxDesktopScript). */
  async #linuxDesktop(host: TartHost, vm: string, address: string, signal?: AbortSignal): Promise<void> {
    const { ssh } = await this.#keys();
    const command = new SshTransport(ssh, this.#vm(await this.#mac(host), address, "linux"), "linux");
    const result = await command.run(linuxDesktopScript(), { timeoutMs: 150_000, signal, maxOutputBytes: 4096 });
    if (result.exitCode !== 0) throw new Error(`${vm} on ${host.name}: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
  }

  /** The password a Linux desktop made at its first boot, or null when it asks for none. */
  async #linuxVncPassword(command: SshTransport, signal?: AbortSignal): Promise<string | null> {
    const result = await command.run(`cat ${LINUX_VNC_PASSWORD_FILE} 2>/dev/null || :`, { timeoutMs: 15_000, signal, maxOutputBytes: 1024 });
    if (result.exitCode !== 0) throw new Error(`Cannot read the desktop's VNC password over SSH: ${result.stderr.trim() || `exit code ${result.exitCode}`}.`);
    return result.stdout.trim() || null;
  }

  /** Asks a Linux box's VM to shut down (powerOffScript); false when it could not be asked. */
  async #powerOff(host: TartHost, guest: Guest, signal?: AbortSignal): Promise<boolean> {
    try {
      const address = this.#addresses.get(guest.ref) ?? (await this.#lookup(host, guest.ref).catch(() => null)) ?? guest.address;
      if (!address) return false;
      const { ssh } = await this.#keys();
      const command = new SshTransport(ssh, this.#vm(await this.#mac(host), address, "linux"), "linux");
      const result = await command.run(powerOffScript(guest.ref), { timeoutMs: 20_000, signal, maxOutputBytes: 4096 });
      return result.exitCode === 0 && result.stdout.includes("powering off");
    } catch (error) {
      if (signal?.aborted) throw error;
      return false;
    }
  }

  /** Closes the shared SSH connections to a VM that is stopping or going, and forgets its address. */
  async #forget(host: TartHost, vm: string): Promise<void> {
    const address = this.#addresses.get(vm);
    this.#addresses.delete(vm);
    if (!address) return;
    try {
      const { ssh } = await this.#keys();
      await ssh.forget(this.#vm(await this.#mac(host), address, this.#os.get(vm) ?? "macos"));
    } catch (error) {
      this.#context.logError("ssh", error);
    }
  }

  async #delete(host: TartHost, vm: string, boxId: string | null, signal?: AbortSignal): Promise<void> {
    await this.#forget(host, vm);
    await this.#run(host, deleteScript(vm, this.#context.installId, boxId), { timeoutMs: 120_000, signal });
  }

  #keys(): Promise<SshKeys> {
    if (!this.#ssh) {
      const pending = (async () => {
        let privateKey = this.#config.ssh.privateKey;
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
        const knownHostsPath = await this.#keyFile.knownHosts(this.#config.hostKeys);
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

