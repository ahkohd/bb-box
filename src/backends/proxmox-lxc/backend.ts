// The Proxmox LXC backend. Boxes are unprivileged containers, linked-cloned
// from one CT template per kind into a resource pool, with a VMID from
// bb-box's range and the static address fixed to it. Ownership lives in
// Proxmox tags (and the description, which the clone sets first), so the
// sweep can find every guest even if bb-box's storage is lost. Both name the
// install as well as the box (018): an install acts only on its own guests,
// and checks the guest still names the box before it acts on a VMID, which
// Proxmox reuses. Commands run over SSH as the templates' box user; desktops
// stream over VNC.
//
// An acquire clones, configures (the box's cores and memory, dropping the
// protection clones inherit), tags, starts, grows the disk if the box's size
// asks for more than the template's (quick only while running), waits for
// port 22 and then for SSH. Proxmox tasks are polled every 50 ms.
//
// Four flavours of template serve four kinds, each with Docker (041): linux
// boxes are clones of a Linux template, linux-desktop of a GPU desktop
// template, linux-desktop-cpu of a CPU-only one, and
// linux-desktop-wayland-cpu of a CPU-only one with Sway (048). A new box is
// cloned from its flavour's least used template; a GPU desktop goes to the
// GPU with the fewest desktops. Every guest carries a "template.<vmid>" tag,
// which is how that use is counted. The warm pool keeps started guests of
// each flavour, tagged "warm", at their template's size. A warm guest serves
// only a box with its cores: a running container takes new memory at once,
// but new cores only when Proxmox next rebalances its CPUs, up to 10 s later,
// and a new clone is quicker than that wait. Claiming one sets the box's
// memory and retags it for its box, so a new box is ready as soon as the tags
// change and any larger disk is applied. It also names the guest after its
// box inside, since Proxmox gives a running container a new hostname only
// when it next starts. build.sh tags each template it makes "build.<id>", and
// a warm guest copies the tag: one whose template now has another, or is
// away, is retired rather than claimed. Guests of other installs, or with no
// install, count against capacity but are otherwise left alone.

import type { CheckId } from "../../core/checks.ts";
import { ReadyPool, type PoolStore } from "../pool.ts";
import { Upkeep } from "../warm.ts";
import { Proxmox, ProxmoxError, parseTags, rootDiskGiB, type FetchLike, type PoolGuest } from "../proxmox/api.ts";
import {
  BUILD,
  TAG,
  boxTags,
  buildFromTags,
  fromBuild,
  templateBuild,
  describe,
  installFromDescription,
  installFromTags,
  installTag,
  isTemplate,
  namesOf,
  ownerFromDescription,
  ownerFromTags,
  templateFromTags,
  templateTag,
} from "../proxmox/owner.ts";
import { addressFor, proxmoxFootprint } from "../proxmox/settings.ts";
import { proxmoxFetch } from "../proxmox/tls.ts";
import {
  BackendError,
  type AcquireHooks,
  type Backend,
  type BackendContext,
  type BackendImages,
  type Footprint,
  type BoxIdentity,
  type BoxKind,
  type BoxSize,
  type BoxTransports,
  type Capacity,
  type CommandCapability,
  type ComputerUse,
  type DoctorCheck,
  type DoctorReport,
  type GpuRoom,
  type Guest,
  type GuestFact,
  type HeldGuest,
  type ImageBox,
  type ImageBuild,
  type Limit,
  type PoolMember,
  type PowerState,
  type ReleaseHooks,
  type Started,
  type WarmShortfall,
} from "../types.ts";
import { sizesCheck } from "../fit.ts";
import { judgeImage, recordFromJson, recordInDescription, type PinSet } from "../images.ts";
import { SELKIES_DISPLAY, SelkiesPresence, WAYLAND_SELKIES_DISPLAY, selkiesDisplay } from "../selkies.ts";
import { pause, waitForPort, waitUntilAnswers, type PortCheck } from "../../transports/ready.ts";
import { quote } from "../../transports/process.ts";
import { KeyFile, Ssh, SshTransport, generateKeyPair, publicKey } from "../../transports/ssh.ts";
import { MIN_DESKTOP, type Display, type DisplaySize, type SshAccess } from "../../transports/types.ts";
import {
  FLAVOUR_KINDS,
  LXC_FLAVOURS,
  flavourOf,
  net0For,
  type LxcConfig,
  type LxcFlavour,
  type LxcFlavourConfig,
  type LxcTemplate,
} from "./config.ts";
import { restartWayvnc, waylandPointer } from "../wayvnc.ts";

const WARM = "warm";
const FILLING = "filling";
const RETIRED = "retired";
const MiB = 2 ** 20;
const GiB = 2 ** 30;
const VNC_PORT = 5900;
/** The desktop template writes a fresh VNC password here, readable by the box user. */
const VNC_PASSWORD_FILE = "/var/lib/bb-box/vnc-password";
/** The desktop's display service writes the path it took, gpu or cpu, and why. */
const DISPLAY_MODE_FILE = "/run/bb-box/display-mode";
const DISPLAY_REASON_FILE = "/run/bb-box/display-reason";
/** The host's NVIDIA driver, as a container sees it: the host's kernel module. */
const NVIDIA_VERSION_FILE = "/sys/module/nvidia/version";
/** The host's NVIDIA driver as a box last saw it, {version, seen}, for the doctor (049). */
const NVIDIA_KEY = "nvidia-host";
/** The cookie a desktop's display :99 writes at each start. */
const DISPLAY_AUTH_FILE = "/run/bb-box/Xauthority";
/** What a program needs to reach the desktop's display as the box user. */
const DISPLAY_ENV = `DISPLAY=:99 XAUTHORITY=${DISPLAY_AUTH_FILE}`;
/** The desktop's display service's script. A Wayland desktop's resizes it (048). */
const DISPLAY_SCRIPT = "/usr/local/libexec/bb-box/display";
/** The user wayvnc signs in, with the VNC password, on a Wayland desktop (048). */
const WAYVNC_USER = "box";
const SSH_KEY = "ssh-key";
/** The hostname a warm guest has until a box claims it. */
const WARM_HOSTNAME = "bb-box-warm";
/** The tag and hostname of a box bb-box builds or tries an image in (049), which no sweep releases. */
const IMAGE_BOX = "image-box";
const IMAGE_HOSTNAME = "bb-box-image";
/** The tag that names a captured build's image (049), such as image.standard. */
const IMAGE_TAG = "image.";
/** The tag that names a captured build's kind. */
const KIND_TAG = "kind.";
/** Where the next VMID search starts. */
const NEXT_VMID = "next-vmid";
/** Clone, start and SSH answering take a few seconds; this leaves room for a busy host. */
const READY_TIMEOUT_MS = 30_000;
/** How long new desktops avoid a GPU whose desktop started without it. */
const AVOID_GPU_MS = 10 * 60_000;
/** The GPU memory a desktop needs free as it starts: its display service's MIN_FREE_VRAM_MIB. */
const DESKTOP_GPU_MIB = 384;
/** Each GPU's memory as bb-box last read it (#603), by GPU. */
const GPUS_KEY = "gpu-readings";
/** How often upkeep reads a GPU's memory in a running desktop that has it. */
const GPU_READ_EVERY_MS = 60_000;
/** How long a reading of a GPU stands for its room. Upkeep reads every 3 minutes, as the sweep runs it. */
const GPU_FRESH_MS = 5 * 60_000;
/** A GPU's free and total memory in MiB, as a desktop that has it reads them. */
const GPU_QUERY = "nvidia-smi --query-gpu=memory.free,memory.total --format=csv,noheader,nounits | head -1";
/** The VM, never started, whose notes carry the host's report of each GPU's memory (#603): host/setup-gpu-report.sh makes it. */
const GPU_REPORT_VM = "bb-box-gpu-memory";
/** How old the host's report may be and still stand: host/bb-box-gpu-memory writes it at least every 4 minutes. */
const GPU_REPORT_FRESH_MS = 10 * 60_000;
/** How long one read of the host's report serves. The host writes it within 15 s of a change. */
const GPU_REPORT_CACHE_MS = 10_000;
/** How long a GPU the host reports full refuses desktops before bb-box looks again. */
const GPU_REPORT_REFUSES_MS = 60_000;
/** How long the views wait for the host's report before they show the readings without it. */
const GPU_REPORT_WAIT_MS = 2_000;
/** build.sh --replace leaves a template missing, then not yet a template, for about 3 s. A clone waits this long for it. */
const TEMPLATE_WAIT_MS = 10_000;
const TEMPLATE_POLL_MS = 250;

/** The Cua Driver the desktop template pins, run by the box user's service. */
const CUA_DRIVER: ComputerUse = { driver: "cua", version: "0.28.3", socket: "/home/box/.cache/cua-driver/cua-driver.sock" };
const SSH_COMMAND: CommandCapability = { transport: "ssh", shell: "sh", admin: true, inDesktopSession: false, streaming: true };

/** The kinds, less their size, which comes from their flavour's settings. */
const OFFERS: readonly (Omit<BoxKind, "size"> & { readonly flavour: LxcFlavour })[] = [
  {
    id: "linux",
    flavour: "linux",
    label: "Linux",
    description: "A Linux box for builds, backend services and the agent's own work.",
    requires: [],
    capabilities: { os: "linux", arch: "x86_64", gpu: false, features: ["docker"], command: SSH_COMMAND, displays: [], computerUse: null, enrol: true },
    readyTimeoutMs: READY_TIMEOUT_MS,
  },
  {
    id: "linux-desktop",
    flavour: "desktop",
    label: "Linux desktop",
    description: "A Linux desktop on the host's GPU, for computer use, browsers and app development.",
    requires: [],
    capabilities: {
      os: "linux",
      arch: "x86_64",
      gpu: true,
      features: ["docker"],
      command: SSH_COMMAND,
      // x0vncserver refuses a viewer's resize on a screen with no RandR outputs
      // (006), so transports() gives this display a resize that runs xrandr (021).
      displays: [{ id: "desktop", protocol: "rfb", resizable: true }],
      computerUse: CUA_DRIVER,
      enrol: true,
    },
    readyTimeoutMs: READY_TIMEOUT_MS,
  },
  {
    id: "linux-desktop-cpu",
    flavour: "desktop-cpu",
    label: "Linux desktop",
    description:
      "A Linux desktop drawn by the CPU, for computer use and browsers when no GPU is needed or free. Graphics are slower; WebGL and Vulkan still work.",
    requires: [],
    capabilities: {
      os: "linux",
      arch: "x86_64",
      gpu: false,
      features: ["docker"],
      command: SSH_COMMAND,
      displays: [{ id: "desktop", protocol: "rfb", resizable: true }, SELKIES_DISPLAY],
      computerUse: CUA_DRIVER,
      enrol: true,
    },
    readyTimeoutMs: READY_TIMEOUT_MS,
  },
  {
    id: "linux-desktop-wayland-cpu",
    flavour: "desktop-wayland-cpu",
    label: "Linux desktop on Wayland",
    description:
      "A Linux desktop on Wayland (Sway), drawn by the CPU, for computer use, browsers and apps built for Wayland. X11-only apps do not run there.",
    requires: [],
    capabilities: {
      os: "linux",
      arch: "x86_64",
      gpu: false,
      features: ["docker"],
      command: SSH_COMMAND,
      // wayvnc refuses a viewer's resize, so transports() gives this display
      // a resize that runs the display script's (048). Video by default, from
      // Selkies on Sway, where the box's image has it (060).
      displays: [{ id: "desktop", protocol: "rfb", resizable: true, refresh: "viewer" }, WAYLAND_SELKIES_DISPLAY],
      computerUse: CUA_DRIVER,
      enrol: true,
    },
    readyTimeoutMs: READY_TIMEOUT_MS,
  },
];

/** How the doctor names each flavour's templates. */
const FLAVOUR_NAMES: Readonly<Record<LxcFlavour, string>> = {
  linux: "Linux",
  desktop: "GPU desktop",
  "desktop-cpu": "CPU desktop",
  "desktop-wayland-cpu": "CPU Wayland desktop",
};

/** A doctor check's stable ID and its name. */
type Check = readonly [id: CheckId, name: string];
const API: Check = ["proxmox.api", "Proxmox API"];
const NODE: Check = ["proxmox.node", "Node"];
const MEMORY: Check = ["proxmox.memory", "Node memory"];
const POOL: Check = ["proxmox.pool", "Resource pool"];
const BRIDGE: Check = ["proxmox.bridge", "Network bridge"];
const VMIDS: Check = ["proxmox.vmids", "VMID range"];
const GPU_REPORT: Check = ["proxmox.gpu-report", "Host's GPU report"];
const SSH_KEY_CHECK: Check = ["ssh.key", "SSH key"];

function powerOf(status: string): PowerState {
  if (status === "running") return "running";
  if (status === "stopped") return "stopped";
  return "unknown";
}

/** A linux-desktop box got no GPU, and no other GPU can take it. */
function noGpu(failed: ReadonlyMap<string, string>, why: string): BackendError {
  const reasons = [...failed].map(([gpu, reason]) => `GPU ${gpu}: ${reason}`).join("; ");
  return new BackendError(
    "no_capacity",
    `The desktop started without a GPU, so bb-box released it (${reasons}). ${why} ` +
      "Try again later, or use a linux-desktop-cpu box, whose desktop runs without a GPU.",
  );
}

/** "just now", "4 minutes ago", "2 hours ago", "3 days ago". */
function ago(ms: number): string {
  const [count, unit] =
    ms < 60_000 ? [0, ""] : ms < 3_600_000 ? [Math.floor(ms / 60_000), "minute"] : ms < 86_400_000 ? [Math.floor(ms / 3_600_000), "hour"] : [Math.floor(ms / 86_400_000), "day"];
  return count ? `${count} ${unit}${count === 1 ? "" : "s"} ago` : "just now";
}

/**
 * Every GPU was last read with less memory free than a desktop needs, so a
 * desktop would start without one (#603), as long ago as `age`. The refusal
 * stands for `minutes`, until the first of the readings is no longer current.
 */
function gpusFull(node: string, full: readonly { readonly gpu: string; readonly freeMiB: number }[], age: number, minutes: number, cpu: boolean): string {
  const later = `try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  return (
    `${full.length === 1 ? "The GPU" : "Every GPU"} on ${node} had less than the ${DESKTOP_GPU_MIB} MiB free a desktop needs, ${ago(age)}: ` +
    `${full.map(({ gpu, freeMiB }) => `${gpu} ${freeMiB} MiB`).join(", ")}. ` +
    (cpu ? `Use a linux-desktop-cpu box, whose desktop runs without a GPU, or ${later}.` : `Free memory on a GPU, or ${later}.`)
  );
}

function gone(vmid: number): BackendError {
  return new BackendError("gone", `The box's container ${vmid} no longer exists.`);
}

function templateInfo(storage: string, config: Record<string, unknown>): TemplateInfo {
  // Proxmox gives a container 512 MiB when its config does not say.
  return { storage, diskGiB: rootDiskGiB(config), memoryMiB: Number(config.memory) || 512 };
}

/** The size a guest's config gives it, or null when it does not say. */
function sizeOf(config: Record<string, unknown>): BoxSize | null {
  const cores = Number(config.cores);
  const memoryMiB = Number(config.memory);
  if (!(Number.isInteger(cores) && cores > 0 && Number.isInteger(memoryMiB) && memoryMiB > 0)) return null;
  return { cores, memoryMiB, diskGiB: rootDiskGiB(config) };
}

function formatMiB(value: number): string {
  if (Math.abs(value) < 1024) return `${Math.round(value)} MiB`;
  return `${(value / 1024).toFixed(1).replace(/\.0$/, "")} GiB`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface LxcBackendOptions {
  /** Replaces the Proxmox API's fetch; the TLS settings are then ignored. */
  readonly fetch?: FetchLike;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly sshBinary?: string;
  /** Where a Wayland box's image has Selkies' launcher, instead of SELKIES_LAUNCHER: a file the fake SSH finds, in tests. */
  readonly selkiesLauncher?: string;
  /** Replaces the TCP check for port 22, for tests. */
  readonly portCheck?: PortCheck;
  /** Replaces each kind's readyTimeoutMs, for tests. */
  readonly readyTimeoutMs?: number;
  /** Replaces how long a clone waits for a template that is being replaced, for tests. */
  readonly templateWaitMs?: number;
  /** Replaces the clock that dates GPU readings (#603), for tests. */
  readonly now?: () => number;
}

/**
 * Names a claimed warm guest after its box inside: the kernel's hostname,
 * /etc/hostname, and the 127.0.1.1 line Proxmox writes in /etc/hosts, so
 * sudo still finds the name. As root, through the sudo every template gives
 * the box user. Only in a guest still named WARM_HOSTNAME, never on a
 * machine a command reaches by mistake, such as a test machine.
 *
 * A desktop's display wrote its cookie for WARM_HOSTNAME, and X clients look
 * it up by the hostname, so after the new name no window could open and
 * xrandr could not resize the desktop. So the script also gives the cookie
 * an entry for any hostname, as the box user, whose file it is. `etc` and
 * `auth` are for tests.
 */
export function warmNameScript(name: string, etc = "/etc", auth = DISPLAY_AUTH_FILE): string {
  return nameScript(WARM_HOSTNAME, name, etc, auth);
}

/** As warmNameScript, for a guest named `from`, as a spare that changes owner and name (036). */
export function nameScript(from: string, name: string, etc = "/etc", auth = DISPLAY_AUTH_FILE): string {
  return String.raw`[ "$(hostname)" = ${quote(from)} ] || exit 0
sudo -n sh -s -- ${quote(name)} ${quote(etc)} ${quote(from)} <<'NAME' || exit
set -e
awk -v old="$3" -v new="$1" '
  $1 == "127.0.1.1" {
    for (i = 2; i <= NF; i++) {
      if ($i == old) $i = new
      else if (index($i, old ".") == 1) $i = new substr($i, length(old) + 1)
      if ($i == new || index($i, new ".") == 1) found = 1
    }
  }
  { print }
  END { if (!found) print "127.0.1.1", new }
' "$2/hosts" > "$2/hosts.bb-box"
cat "$2/hosts.bb-box" > "$2/hosts"
rm -f "$2/hosts.bb-box"
printf '%s\n' "$1" > "$2/hostname"
hostname "$1"
NAME
[ -s ${quote(auth)} ] || exit 0
entries=$(xauth -q -f ${quote(auth)} nlist)
printf '%s\n' "$entries" | sed 's/^..../ffff/' | xauth -q -f ${quote(auth)} nmerge -`;
}

/** A size a desktop can take, in whole pixels, or an error. */
function wholeSize({ width, height }: DisplaySize): DisplaySize {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`The desktop cannot be ${width} by ${height} pixels.`);
  }
  return { width, height };
}

/** Times one step of an acquire. */
type Step = <T>(name: string, run: () => Promise<T>) => Promise<T>;
const untimed: Step = (_name, run) => run();

interface SshKeys {
  readonly ssh: Ssh;
  readonly publicKey: string | null;
  readonly generated: boolean;
}

/** A kind this backend offers now, with its flavour's settings, which list at least one template. */
interface TemplateInfo {
  readonly storage: string;
  readonly diskGiB: number | null;
  /** What its warm guests have until claimed. */
  readonly memoryMiB: number;
}

/** A box the registry is acquiring here, which capacity counts as coming. */
type Pending = { readonly kind: string; readonly size: BoxSize };

interface Offer {
  readonly kind: BoxKind;
  readonly flavour: LxcFlavour;
  readonly config: LxcFlavourConfig;
}

/** The template a new guest of an offer is cloned from, and whether the offer's GPUs have room for it. */
interface Choice {
  readonly template: LxcTemplate;
  readonly gpus: { readonly used: number; readonly total: number | null } | null;
  readonly problem: string | null;
}

/** The path a desktop's display took at boot, and why. */
interface DisplayMode {
  readonly mode: string;
  readonly reason: string;
}

interface HostNvidia {
  readonly version: string;
  /** When a box first saw this version, as an ISO 8601 time. */
  readonly seen: string;
}

/** How to rebuild each flavour's template, as root on the Proxmox host. */
const REBUILD: Readonly<Record<LxcFlavour, (vmid: number) => string>> = {
  linux: (vmid) => `linux ${vmid}`,
  desktop: (vmid) => `desktop ${vmid} --gpu <its GPU's PCI address>`,
  "desktop-cpu": (vmid) => `desktop ${vmid} --cpu`,
  "desktop-wayland-cpu": (vmid) => `desktop ${vmid} --wayland`,
};

const NO_GPUS: ReadonlySet<string> = new Set();

/** A GPU's memory as bb-box keeps it. The total is null until a running desktop reads it. */
interface StoredGpu {
  readonly freeMiB: number;
  readonly totalMiB: number | null;
  readonly at: number;
}

/** The GPUs a set of templates carries, each once. */
function gpusOf(templates: readonly LxcTemplate[]): string[] {
  return [...new Set(templates.flatMap((template) => (template.gpu ? [template.gpu] : [])))];
}

/** A GPU's room as bb-box knows it now (#603). */
interface GpuState extends StoredGpu {
  readonly source: "host" | "desktop";
  /** Until when it refuses desktops, if it has less free than one needs; null once it no longer stands. */
  readonly until: number | null;
}

/** One GPU in the host's report, as nvidia-smi names it, with its memory in MiB. */
export interface ReportedGpu {
  readonly uuid: string;
  readonly bus: string;
  readonly index: string;
  readonly freeMiB: number;
  readonly totalMiB: number;
}

/** The host's report of each GPU's memory: when it was written, in milliseconds since the epoch, and each GPU. */
export interface GpuReport {
  readonly at: number;
  readonly gpus: readonly ReportedGpu[];
}

/**
 * The host's report in the notes host/bb-box-gpu-memory writes: an
 * "at <seconds since the epoch>" line, then a "gpu <UUID> <PCI bus ID>
 * <index> <free MiB> <total MiB>" line per GPU, each indented so that the
 * notes panel shows them as written. Null when the notes hold no report.
 */
export function parseGpuReport(notes: string): GpuReport | null {
  const at = /^\s*at (\d+)\s*$/m.exec(notes);
  if (!at) return null;
  const gpus = [...notes.matchAll(/^\s*gpu (\S+) (\S+) (\d+) (\d+) (\d+)\s*$/gm)].map(([, uuid, bus, index, free, total]) => ({
    uuid: uuid!,
    bus: bus!,
    index: index!,
    freeMiB: Number(free),
    totalMiB: Number(total),
  }));
  return { at: Number(at[1]) * 1000, gpus };
}

/** A PCI address in one form, as nvidia-smi writes 00000000:01:00.0 and lspci 0000:01:00.0. */
function pciAddress(value: string): string | null {
  const match = /^(?:([0-9a-f]{1,8}):)?([0-9a-f]{1,2}):([0-9a-f]{1,2})\.([0-7])$/i.exec(value);
  return match ? `${parseInt(match[1] ?? "0", 16)}:${parseInt(match[2]!, 16)}:${parseInt(match[3]!, 16)}.${match[4]}` : null;
}

/** Whether a template's GPU ID names the reported GPU: by its UUID, as the setup guide suggests, its PCI address, or its index. */
export function namesGpu(id: string, gpu: ReportedGpu): boolean {
  if (id.toLowerCase() === gpu.uuid.toLowerCase() || id === gpu.index) return true;
  const address = pciAddress(id);
  return address !== null && address === pciAddress(gpu.bus);
}

const DISPLAY_MODE_WORDS: Readonly<Record<string, string>> = { gpu: "GPU", cpu: "CPU" };

/**
 * The display service's reason for its path, as a sentence for people. The
 * service writes terse reasons, and templates already built keep them.
 */
export function displayReason(reason: string): string {
  const driver = /^host NVIDIA driver '(.*)' does not match the template's '(.*)'$/.exec(reason);
  if (driver) {
    const [, host, template] = driver;
    if (host === "none") return "The host has no NVIDIA driver loaded.";
    if (template === "none") return "The template has no NVIDIA driver.";
    return `The template was built for NVIDIA driver ${template}, but the host has ${host}.`;
  }
  const low = /^GPU has (\d+) MiB free, below MIN_FREE_VRAM_MIB=(\d+)$/.exec(reason);
  if (low) return `The GPU had ${low[1]} MiB of memory free, less than the ${low[2]} MiB a desktop needs.`;
  const free = /^GPU has (\d+) MiB free$/.exec(reason);
  if (free) return `The GPU had ${free[1]} MiB of memory free.`;
  const fixed = /^DISPLAY_MODE=(\S+)$/.exec(reason);
  if (fixed) return fixed[1] === "cpu" ? "The template has no GPU." : `The template sets the display mode to ${fixed[1]}.`;
  if (reason === "no NVIDIA device nodes") return "The box has no GPU device.";
  if (reason === "nvidia-smi cannot read the GPU") return "The GPU did not answer nvidia-smi.";
  const sentence = reason.charAt(0).toUpperCase() + reason.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/** A guest as SelkiesPresence knows it: its VMID, which a later box may reuse, and the box it holds (018). */
function presenceKey(guest: Guest): string {
  return `${guest.ref}:${String(guest.data?.box ?? "")}`;
}

export class ProxmoxLxcBackend implements Backend {
  readonly id: string;
  readonly nature = "virtual" as const;
  readonly label: string;
  readonly hosts: readonly string[];
  readonly hostOs = "linux" as const;
  readonly #config: LxcConfig;
  readonly #context: BackendContext;
  readonly #options: LxcBackendOptions;
  readonly #http: { fetch: FetchLike; close(): Promise<void> };
  readonly #keyFile = new KeyFile();
  /** Whether each Wayland box's image has Selkies (060). */
  readonly #selkies: SelkiesPresence;
  readonly #warmStore: WarmStore;
  readonly #warm: ReadyPool<BoxIdentity>;
  /** VMIDs this process is cloning into. */
  readonly #reserved = new Set<number>();
  /** Warm guests being prepared: their VMID and their template's. */
  readonly #filling = new Map<number, number>();
  /**
   * Acquires running in this process, by box, with their template once
   * chosen and their VMID once claimed. Once one holds its guest, `held` is
   * the memory that guest had: a warm guest's, or 0 for a new one.
   */
  readonly #acquiring = new Map<string, { readonly flavour: LxcFlavour; template: number | null; vmid: number | null; held: number | null }>();
  /** GPUs whose desktop lately started without them, and until when new desktops avoid them. */
  readonly #avoid = new Map<string, number>();
  /** Each GPU's memory as last read (#603); undefined until read from storage. */
  #gpus: Map<string, StoredGpu> | undefined;
  /** When a desktop on each GPU was last released, which frees memory older readings do not show. */
  readonly #freed = new Map<string, number>();
  /** The host's report of each GPU's memory as last read, and when; null until read, or after a release. */
  #report: { readonly read: number; readonly report: Promise<GpuReport | null> } | null = null;
  /** Root disk storage, disk size and memory of each template. */
  readonly #templates = new Map<number, TemplateInfo>();
  readonly #stopping = new AbortController();
  #api: Promise<Proxmox> | null = null;
  #ssh: Promise<SshKeys> | null = null;
  /** Where the next VMID search starts, so a deleted box's VMID and address are not reused at once. */
  #nextVmid: number | null = null;
  /** The host's NVIDIA driver as a box last saw it; undefined until read from storage. */
  #nvidia: HostNvidia | null | undefined;
  readonly #upkeep = new Upkeep(async (signal) => {
    await this.#readGpus(signal).catch((error) => signal.aborted || this.#context.logError("read GPU memory", error));
    await this.#topUp(signal);
  });
  /** Image boxes (049) from before their clone until their capture or removal, which no sweep counts. */
  readonly #imageBoxes = new Set<number>();

  /**
   * Image operations (049): a box from a template, its capture as a template
   * with the image's record in its description, and a template replaced in
   * place under its VMID, as build.sh --replace does.
   */
  readonly images: BackendImages = {
    list: (signal) => this.#imageList(signal),
    box: (build, label, signal) => this.#imageBox(build, label, signal),
    capture: (box, from, image, signal) => this.#capture(box, from, image, signal),
    replace: (build, current, signal) => this.#replaceTemplate(build, current, signal),
    remove: (ref, signal) => this.#removeImage(ref, signal),
    startsFrom: true,
    spares: true,
  };

  constructor(config: LxcConfig, context: BackendContext, options: LxcBackendOptions = {}) {
    this.id = context.id;
    this.#config = config;
    this.#context = context;
    this.#options = options;
    this.#selkies = new SelkiesPresence(options.selkiesLauncher);
    this.#http = options.fetch
      ? { fetch: options.fetch, close: async () => {} }
      : proxmoxFetch({ ca: config.proxmox.caCertificate, fingerprint: config.proxmox.tlsFingerprint });
    this.label = `Proxmox LXC on ${config.proxmox.node ?? new URL(config.proxmox.apiUrl).hostname}`;
    this.hosts = [config.proxmox.node ?? new URL(config.proxmox.apiUrl).hostname];
    this.#warmStore = new WarmStore(this, config.proxmox.pool);
    this.#warm = new ReadyPool(this.#warmStore);
  }

  kinds(): BoxKind[] {
    return this.#offers().map((offer) => offer.kind);
  }

  async capacity(kind: string, size: BoxSize, pending: readonly Pending[], signal?: AbortSignal): Promise<Capacity> {
    const offer = this.#offer(kind);
    const api = await this.client();
    const guests = await api.listPool(this.#config.proxmox.pool, signal);
    const builds = await this.templateBuilds(api, guests, signal);
    const ready = guests.filter((guest) => this.warmOf(guest, builds)?.flavour === offer.flavour && guest.status === "running");
    const fitting = ready.filter((guest) => guest.size?.cores === size.cores);
    // Acquires here that hold their guest need no warm guest.
    const holding = [...this.#acquiring.values()].filter((acquire) => acquire.flavour === offer.flavour && acquire.held !== null).length;
    const waiting = Math.max(0, pending.filter((other) => flavourOf(other.kind) === offer.flavour).length - holding);
    // Any of them may be claimed, so the one with the least memory is assumed.
    const warmMiB = fitting.length > waiting ? Math.min(...fitting.map((guest) => guest.size?.memoryMiB ?? 0)) : null;
    return this.#room(api, offer, size, guests, pending, { ready: ready.length, target: this.#warmTarget(offer.flavour) }, warmMiB, signal);
  }

  /**
   * Room on the node for a guest of `offer` at `size`, with `pending` guests
   * still to come. A null size is a warm guest at its template's size. With
   * `warmMiB`, the box is a warm guest with that much memory, which needs
   * only the memory it grows by and no VMID, template or GPU of its own.
   */
  async #room(
    api: Proxmox,
    offer: Offer,
    size: BoxSize | null,
    guests: readonly PoolGuest[],
    pending: readonly Pending[],
    warm: { ready: number; target: number },
    warmMiB: number | null,
    signal?: AbortSignal,
  ): Promise<Capacity> {
    const choice = this.#choose(offer, guests, pending, api.node);
    const template = await this.#templateOf(api, choice.template.vmid, signal);
    const { storage } = template;
    const [node, disk] = await Promise.all([api.nodeStatus(signal), api.storageStatus(storage, signal)]);
    const reserve = this.#config.reserve;
    const kind = offer.kind.id;
    // A warm guest an acquire here holds has its memory already, as a warm claim needs only what it adds.
    const heldMiB = [...this.#acquiring.values()].reduce((sum, acquire) => sum + (acquire.held ?? 0), 0);
    const pendingMiB = Math.max(0, pending.reduce((sum, other) => sum + other.size.memoryMiB, 0) - heldMiB);
    const memoryTotal = Math.floor(node.memoryTotal / MiB);
    const memoryUsed = memoryTotal - Math.floor(node.memoryAvailable / MiB) + pendingMiB;
    const memoryFree = memoryTotal - memoryUsed;
    const diskTotal = Math.floor(disk.total / MiB);
    const diskUsed = diskTotal - Math.floor(disk.available / MiB);
    const diskFree = diskTotal - diskUsed;
    const { first, last } = this.#config.vmids;
    const used = new Set([...this.#reserved, ...this.#filling.keys(), ...guests.map((guest) => guest.vmid).filter((vmid) => this.#inRange(vmid))]);

    const limits: Limit[] = [
      { resource: "memory", used: memoryUsed, total: memoryTotal, reserve: reserve.memoryMiB, unit: "MiB" },
      { resource: "disk", used: diskUsed, total: diskTotal, reserve: reserve.diskGiB * 1024, unit: "MiB" },
      { resource: "guests", used: used.size, total: last - first + 1, reserve: 0, unit: "count" },
    ];
    const memoryMiB = size?.memoryMiB ?? template.memoryMiB;
    // The memory a box needs: all of it for a new guest, what it grows by for a warm one. A refusal
    // leads with what binds: the box when it needs more than is free, otherwise the memory kept free.
    const memory = (need: number, grown: boolean): string[] => {
      if (need <= 0 || memoryFree - need >= reserve.memoryMiB) return [];
      const box = grown ? `a warm ${kind} box given ${formatMiB(memoryMiB)}` : `a ${kind} box with ${formatMiB(memoryMiB)} memory`;
      if (need > memoryFree) {
        const needs = grown ? `the ${formatMiB(need)} more ${box} needs` : `${box} needs`;
        return [`${api.node} has ${formatMiB(Math.max(0, memoryFree))} of memory free, less than ${needs}. Release a box or ask for less memory.`];
      }
      return [
        `${api.node} has ${formatMiB(memoryFree)} of memory free and keeps ${formatMiB(reserve.memoryMiB)} free, ` +
          `so ${box}${grown ? `, which needs ${formatMiB(need)} more,` : ""} does not fit. ` +
          (grown || memoryFree > reserve.memoryMiB
            ? "Release a box, ask for less memory, or lower the memory kept free in bb-box's settings."
            : "Release a box, or lower the memory kept free in bb-box's settings."),
      ];
    };
    // What any box of the size needs, new or warm.
    const sized: string[] = [];
    if (size && node.cpus !== null && size.cores > node.cpus) {
      sized.push(`${api.node} has ${node.cpus} CPU threads, fewer than the ${size.cores} cores asked for. Ask for at most ${node.cpus} cores.`);
    }
    const grow = size?.diskGiB != null ? Math.max(0, size.diskGiB - (template.diskGiB ?? 0)) : 0;
    if (grow > 0 && diskFree - grow * 1024 < reserve.diskGiB * 1024) {
      const storageFree = `The ${storage} storage on ${api.node} has ${Math.floor(diskFree / 1024)} GiB free`;
      sized.push(
        grow * 1024 > diskFree
          ? `${storageFree}, less than the ${Math.ceil(grow)} GiB a ${size!.diskGiB} GiB disk adds to the template's. Ask for a smaller disk or release boxes.`
          : `${storageFree} and keeps ${reserve.diskGiB} GiB free, so a ${size!.diskGiB} GiB disk, ${Math.ceil(grow)} GiB more than the template's, does not fit. ` +
            "Ask for a smaller disk, release boxes, or lower the disk kept free in bb-box's settings.",
      );
    }
    // What only a new guest needs.
    const fresh: string[] = [];
    if (diskFree < reserve.diskGiB * 1024) {
      fresh.push(
        `The ${storage} storage on ${api.node} has ${Math.floor(diskFree / 1024)} GiB free, less than the ${reserve.diskGiB} GiB kept free. ` +
          `Release boxes, free some space, or lower the disk kept free in bb-box's settings.`,
      );
    }
    if (this.#freeVmid(guests) === null) {
      fresh.push(`Every VMID from ${first} to ${last} is in use. Release a box, or widen the VMID range in bb-box's settings.`);
    }
    if (choice.gpus) limits.push({ resource: "gpu-desktops", used: choice.gpus.used, total: choice.gpus.total, reserve: 0, unit: "count" });
    if (choice.problem) fresh.push(choice.problem);
    if (offer.kind.capabilities.gpu) {
      const gpus = gpusOf(offer.config.templates);
      const state = await this.#gpuState(gpus);
      for (const gpu of gpus) {
        const known = state.get(gpu);
        if (known?.totalMiB != null) {
          limits.push({ resource: "gpu-memory", id: gpu, used: known.totalMiB - known.freeMiB, total: known.totalMiB, reserve: 0, unit: "MiB" });
        }
      }
      const until = this.#fullUntil(gpus, state);
      if (until !== null) {
        const cpu = this.#offers().some((other) => other.flavour === "desktop-cpu");
        const now = this.#now();
        const minutes = Math.max(1, Math.ceil((until - now) / 60_000));
        const age = now - Math.min(...gpus.map((gpu) => state.get(gpu)!.at));
        fresh.push(gpusFull(api.node, gpus.map((gpu) => ({ gpu, freeMiB: state.get(gpu)!.freeMiB })), age, minutes, cpu));
      }
    }
    const cloned = [...memory(memoryMiB, false), ...sized, ...fresh];
    const problems = warmMiB === null ? cloned : [...memory(memoryMiB - warmMiB, true), ...sized];
    const ok = problems.length === 0;
    return {
      ok,
      message: ok ? null : problems[0]!,
      warm,
      hosts: [{ host: api.node, ok: cloned.length === 0, limits }],
    };
  }

  /**
   * Guests of each template, counting each once: those Proxmox lists, warm
   * guests being made, and acquires under way here that have chosen one.
   */
  #perTemplate(guests: readonly PoolGuest[]): Map<number, number> {
    const templates = new Map<number, number>();
    for (const guest of guests) {
      const template = this.#inRange(guest.vmid) ? templateFromTags(guest.tags) : null;
      if (template !== null) templates.set(guest.vmid, template);
    }
    for (const [vmid, template] of this.#filling) templates.set(vmid, template);
    const counts = new Map<number, number>();
    const add = (template: number) => counts.set(template, (counts.get(template) ?? 0) + 1);
    for (const template of templates.values()) add(template);
    for (const acquire of this.#acquiring.values()) {
      if (acquire.template !== null && (acquire.vmid === null || !templates.has(acquire.vmid))) add(acquire.template);
    }
    return counts;
  }

  /**
   * The least used of the offer's templates. For a GPU desktop, the least
   * used template on the GPU with the fewest desktops, and whether any GPU
   * has room once `pending` acquires that have no template yet are placed.
   * GPUs in `exclude` are left out; at least one GPU must be left.
   */
  #choose(offer: Offer, guests: readonly PoolGuest[], pending: readonly { readonly kind: string }[], node: string, exclude: ReadonlySet<string> = NO_GPUS): Choice {
    const counts = this.#perTemplate(guests);
    const uses = (template: LxcTemplate) => counts.get(template.vmid) ?? 0;
    const least = (templates: readonly LxcTemplate[]) => templates.reduce((best, template) => (uses(template) < uses(best) ? template : best));
    const templates = offer.config.templates.filter((template) => template.gpu === null || !exclude.has(template.gpu));
    if (!offer.kind.capabilities.gpu) return { template: least(templates), gpus: null, problem: null };

    const desktops = new Map<string, number>();
    for (const template of templates) desktops.set(template.gpu!, (desktops.get(template.gpu!) ?? 0) + uses(template));
    const gpu = [...desktops.keys()].reduce((best, id) => (desktops.get(id)! < desktops.get(best)! ? id : best));
    const template = least(templates.filter((candidate) => candidate.gpu === gpu));
    // Acquires the registry has started that this process has not yet placed.
    const acquiring = [...this.#acquiring.values()].filter((acquire) => acquire.flavour === offer.flavour);
    const waiting = pending.filter((other) => flavourOf(other.kind) === offer.flavour).length;
    const unplaced = Math.max(0, waiting - acquiring.length) + acquiring.filter((acquire) => acquire.template === null).length;
    const used = [...desktops.values()].reduce((sum, count) => sum + count, 0) + unplaced;
    const perGpu = this.#config.desktop.perGpu;
    if (perGpu === null) return { template, gpus: { used, total: null }, problem: null };
    const free = [...desktops.values()].reduce((sum, count) => sum + Math.max(0, perGpu - count), 0);
    const cpu = this.#offers().some((other) => other.flavour === "desktop-cpu");
    return {
      template,
      gpus: { used, total: perGpu * desktops.size },
      problem:
        free > unplaced
          ? null
          : `Every GPU on ${node} runs ${perGpu} desktop ${perGpu === 1 ? "box" : "boxes"}, the most bb-box's settings allow. ` +
            (cpu ? "Use a linux-desktop-cpu box, or release a desktop box." : "Release a desktop box, or raise the desktops per GPU."),
    };
  }

  async acquire(box: BoxIdentity, previous: Guest | null, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest> {
    const offer = this.#offer(box.kind);
    const deadline = Date.now() + (this.#options.readyTimeoutMs ?? offer.kind.readyTimeoutMs);
    const api = await this.client();
    const step: Step = async (name, run) => {
      const started = performance.now();
      try {
        return await run();
      } finally {
        hooks.timing(name, Math.round(performance.now() - started));
      }
    };
    const acquiring = { flavour: offer.flavour, template: null as number | null, build: null as string | null, vmid: null as number | null, held: null as number | null };
    this.#acquiring.set(box.boxId, acquiring);
    let vmid: number | null = null;
    let claimed: number | null = null;
    const claim = async (id: number) => {
      claimed = id;
      acquiring.vmid = id;
      await hooks.claim(this.#guest(api.node, id, acquiring.template, box.boxId, null, null, acquiring.build));
    };
    try {
      if (previous && this.#inRange(Number(previous.ref)) && (await this.#owns(api, Number(previous.ref), box.boxId, signal))) {
        vmid = Number(previous.ref);
        acquiring.vmid = vmid;
        acquiring.held = 0;
        acquiring.template = typeof previous.data?.template === "number" ? previous.data.template : null;
        acquiring.build = typeof previous.data?.build === "string" ? previous.data.build : null;
      }
      let warm = false;
      // A box from an image build (049) is a clone of it: no warm guest has it.
      if (vmid === null && !box.from) {
        let memory = 0;
        const member = await step("warm", () =>
          this.#warm.claim(box.kind, box, {
            fits: (candidate) => this.#warmStore.sizeOf(candidate.ref)?.cores === box.size.cores,
            before: (candidate) => {
              acquiring.template = this.#warmStore.templateOf(candidate.ref);
              acquiring.build = this.#warmStore.buildOf(candidate.ref);
              memory = this.#warmStore.sizeOf(candidate.ref)?.memoryMiB ?? 0;
              return claim(Number(candidate.ref));
            },
            signal,
          }),
        );
        if (member) {
          vmid = Number(member.ref);
          warm = true;
          acquiring.held = memory;
          this.#kick();
        } else {
          acquiring.template = null;
          acquiring.build = null;
        }
      }
      // GPUs whose box started without them. A linux-desktop box promises
      // the GPU, so such a box is released and another GPU is tried.
      const failed = new Map<string, string>();
      let started = false;
      for (;;) {
        if (vmid === null) {
          // Time spent waiting for a template that is being replaced shows apart from the clone.
          let away: number | null = null;
          const cloning = performance.now();
          try {
            const guests = await api.listPool(this.#config.proxmox.pool, signal);
            if (box.from) {
              acquiring.template = Number(box.from);
            } else {
              const choice = this.#choose(offer, guests, [], api.node, await this.#placing(offer, new Set(failed.keys())));
              if (failed.size && choice.problem) throw noGpu(failed, choice.problem);
              acquiring.template = choice.template.vmid;
            }
            // Read before the clone, so it is never newer than the clone's: a replace in between leaves the box what it has.
            acquiring.build = (await templateBuild(api, guests, acquiring.template, signal)) ?? null;
            const description = describe(box, this.#context.installId);
            vmid = await this.#clone(api, guests, acquiring.template, box.name, description, claim, signal, (ms) => (away = (away ?? 0) + ms));
            acquiring.held = 0;
          } finally {
            if (away !== null) hooks.timing("template", away);
            hooks.timing("clone", Math.round(performance.now() - cloning - (away ?? 0)));
          }
        }
        const id = vmid;
        const template = acquiring.template;
        if (!warm) {
          await step("configure", () => api.configure(id, this.#settings(box.size, id), signal));
          await step("tags", () => api.configure(id, { tags: boxTags(box, this.#context.installId, template) }, signal));
        }
        if (!started) await hooks.starting();
        started = true;
        await step("start", async () => {
          if ((await api.status(id, signal))?.status !== "running") await api.start(id, signal);
        });
        await this.#grow(api, id, box.size.diskGiB, template, step, signal);
        // Read while the box comes up: the size it has, as Proxmox gives it.
        const size = api.config(id, signal).then(sizeOf, () => null);
        await this.#waitReady(id, box.kind, Math.max(1_000, deadline - Date.now()), signal, step);
        if (warm) await step("name", () => this.#name(id, box.name, signal));
        const display = offer.kind.capabilities.displays.length
          ? await step("display", () => this.#displayMode(id, box.kind, Math.max(1_000, deadline - Date.now()), signal))
          : null;
        await this.#sawDisplay(template, display);
        if (!offer.kind.capabilities.gpu || display?.mode === "gpu") {
          const guest = this.#guest(api.node, id, template, box.boxId, display, await size, acquiring.build);
          // Claimed again, so the box's record shows the display's facts as it becomes ready.
          if (display) await hooks.claim(guest);
          return guest;
        }

        const gpu = this.#gpuOf(template) ?? "unknown";
        const reason = display?.reason || "no reason given";
        failed.set(gpu, reason);
        this.#avoidGpu(this.#gpuOf(template));
        this.#context.logError("acquire", new Error(`Box ${box.name} started without GPU ${gpu} (${reason}), so bb-box released it and tries another GPU.`));
        await this.#forget(id);
        await api.destroy(id, signal);
        vmid = null;
        claimed = null;
        acquiring.vmid = null;
        acquiring.template = null;
        acquiring.build = null;
        acquiring.held = null;
        warm = false;
        const left = offer.config.templates.some((candidate) => candidate.gpu !== null && !failed.has(candidate.gpu));
        if (!left) throw noGpu(failed, `No other GPU on ${api.node} has a linux-desktop template.`);
        if (Date.now() >= deadline) throw noGpu(failed, "There is no time left to try another GPU.");
      }
    } catch (error) {
      // Counted as pending in full again before its guest goes, so never not at all.
      acquiring.held = null;
      // A clone cut short may still have made the guest; it is ours if it names the box.
      const leftover = vmid ?? claimed;
      if (leftover !== null && (vmid !== null || (await this.#owns(api, leftover, box.boxId).catch(() => false)))) {
        await this.#forget(leftover);
        await api.destroy(leftover).catch((cause) => this.#context.logError("release after a failed acquire", cause));
      }
      throw error;
    } finally {
      if (this.#acquiring.get(box.boxId) === acquiring) this.#acquiring.delete(box.boxId);
    }
  }

  async release(guest: Guest, hooks: ReleaseHooks, signal?: AbortSignal): Promise<void> {
    const started = performance.now();
    this.#selkies.forget(presenceKey(guest));
    await this.#forget(this.#vmid(guest));
    const api = await this.client();
    if (await this.#still(api, guest, signal)) await api.destroy(this.#vmid(guest), signal);
    hooks.timing("delete", Math.round(performance.now() - started));
    const gpu = this.#gpuOf(typeof guest.data?.template === "number" ? guest.data.template : null);
    if (gpu) {
      this.#freed.set(gpu, this.#now());
      this.#report = null;
    }
  }

  async power(guest: Guest, signal?: AbortSignal): Promise<PowerState | null> {
    const api = await this.client();
    if (!(await this.#still(api, guest, signal))) return null;
    const status = await api.status(this.#vmid(guest), signal);
    return status ? powerOf(status.status) : null;
  }

  async start(guest: Guest, signal?: AbortSignal): Promise<Started | void> {
    const vmid = this.#vmid(guest);
    const api = await this.client();
    const status = (await this.#still(api, guest, signal)) ? await api.status(vmid, signal) : null;
    if (!status) throw gone(vmid);
    if (status.status !== "running") await api.start(vmid, signal);
    await this.#waitReady(vmid, null, this.#options.readyTimeoutMs ?? READY_TIMEOUT_MS, signal);
    // A GPU desktop's display takes its path again at each boot, and falls back to the CPU when its GPU is short of memory (#597).
    const template = typeof guest.data?.template === "number" ? guest.data.template : null;
    if (!this.#gpuOf(template)) return;
    const display = await this.#displayMode(vmid, "linux-desktop", this.#options.readyTimeoutMs ?? READY_TIMEOUT_MS, signal).catch((error: unknown) => {
      this.#context.logError("display mode", error);
      return null;
    });
    return { facts: this.#facts(template, display) };
  }

  async stop(guest: Guest, signal?: AbortSignal): Promise<void> {
    const vmid = this.#vmid(guest);
    const api = await this.client();
    const status = (await this.#still(api, guest, signal)) ? await api.status(vmid, signal) : null;
    if (!status) throw gone(vmid);
    await this.#forget(vmid);
    if (status.status === "running") await api.stop(vmid, signal);
  }

  /** Closes the shared SSH connection to a guest that is stopping or going, as another guest may take its address. */
  async #forget(vmid: number): Promise<void> {
    try {
      const keys = await this.#ssh;
      await keys?.ssh.forget(this.#access(vmid));
    } catch (error) {
      this.#context.logError("ssh", error);
    }
  }

  /** This install's guests, from the pool listing. Only a guest not yet tagged costs a config read. */
  async held(signal?: AbortSignal): Promise<HeldGuest[]> {
    const api = await this.client();
    const held: HeldGuest[] = [];
    for (const guest of await api.listPool(this.#config.proxmox.pool, signal)) {
      if (guest.type !== "lxc" || guest.template || !this.#inRange(guest.vmid)) continue;
      if (this.#reserved.has(guest.vmid) || this.#filling.has(guest.vmid) || guest.tags.includes(WARM)) continue;
      // Image boxes and captured builds (049) are no box's: their build removes them. A
      // build is a template, but the listing says so only after Proxmox's next status pass.
      if (this.#imageBoxes.has(guest.vmid) || guest.tags.includes(IMAGE_BOX) || guest.tags.some((tag) => tag.startsWith(IMAGE_TAG))) continue;
      let install = installFromTags(guest.tags);
      let owner = ownerFromTags(guest.tags, guest.name || null);
      const labelled = guest.tags.includes(FILLING) || guest.tags.includes(RETIRED);
      let config: Record<string, unknown> | null = null;
      if (!guest.tags.includes(TAG) || (!owner && !labelled)) {
        config = await api.config(guest.vmid, signal).catch((): Record<string, unknown> => ({}));
        install ??= installFromDescription(config.description);
        owner ??= ownerFromDescription(config.description);
      }
      if (install !== this.#context.installId) continue;
      // A running container's listed disk is its filesystem's, which Proxmox
      // reads every 10 s or so: less than the disk, and the old size for a
      // while after a resize. The config gives the disk's, as acquire reads it.
      config ??= await api.config(guest.vmid, signal).catch((): Record<string, unknown> => ({}));
      const size = guest.size && { ...guest.size, diskGiB: rootDiskGiB(config) ?? guest.size.diskGiB };
      const template = templateFromTags(guest.tags);
      const found = this.#guest(guest.node || api.node, guest.vmid, template, owner?.boxId ?? null, null, size);
      held.push({ ...found, owner, power: powerOf(guest.status) });
    }
    return held;
  }

  /**
   * Adds this install to the guest of a box recorded before install IDs,
   * when the guest has none and names the box, and keeps the box ID with the
   * guest. From then on, a guest at the VMID that does not name the box
   * counts as gone.
   */
  async stamp(boxId: string, guest: Guest, signal?: AbortSignal): Promise<Guest> {
    const stamped: Guest = { ...guest, data: { ...guest.data, box: boxId } };
    const api = await this.client();
    const vmid = this.#vmid(guest);
    const config = await this.#guestConfig(api, vmid, signal);
    if (!config) return stamped;
    const names = namesOf(config);
    if (names.install !== null || names.box !== boxId) return stamped;
    const tags = parseTags(config.tags);
    const description = typeof config.description === "string" && config.description.startsWith("bb-box ") ? config.description : null;
    await api.configure(
      vmid,
      {
        tags: [TAG, installTag(this.#context.installId), ...tags.filter((tag) => tag !== TAG)],
        ...(description ? { description: description.replace(/^.*/, (first) => `${first}\ninstall ${this.#context.installId}`) } : {}),
      },
      signal,
    );
    return stamped;
  }

  async transports(guest: Guest, kind: string): Promise<BoxTransports> {
    const vmid = this.#vmid(guest);
    const access = this.#access(vmid);
    const offer = OFFERS.find((candidate) => candidate.id === kind);
    const capabilities = offer?.capabilities;
    const command = await this.#command(vmid);
    // wayvnc offers Apple's sign-in, not a VNC password (048).
    const wayland = offer?.flavour === "desktop-wayland-cpu";
    // A Wayland box of an image built before Selkies was in it has no video (060).
    const video = !wayland || (await this.#selkies.has(presenceKey(guest), command));
    const displays = (capabilities?.displays ?? []).filter((display) => video || display.protocol !== "selkies").map(
      (display): Display =>
        display.protocol === "selkies"
          ? selkiesDisplay((port) => command.route(port), display)
          : {
              ...display,
              label: "Desktop",
              open: async (signal) => {
                const password = await this.#vncPassword(command, signal);
                return {
                  route: { type: "tcp", host: access.host, port: VNC_PORT },
                  auth: !password ? { type: "none" } : wayland ? { type: "apple", user: WAYVNC_USER, password } : { type: "vnc-password", password },
                };
              },
              ...(offer?.flavour === "desktop" ? { resize: (size: DisplaySize, signal?: AbortSignal) => this.#resize(command, size, signal) } : {}),
              ...(wayland ? { resize: (size: DisplaySize, signal?: AbortSignal) => this.#resizeWayland(command, size, signal), restartServer: (signal?: AbortSignal) => restartWayvnc(command, signal), pointer: (shown: boolean, signal?: AbortSignal) => waylandPointer(command, shown, signal) } : {}),
              minSize: MIN_DESKTOP,
            },
    );
    return {
      command,
      displays,
      access: {
        ssh: access,
        dockerHost: capabilities?.features.includes("docker") ? `ssh://${access.user}@${access.host}` : null,
      },
    };
  }

  async doctor(signal?: AbortSignal): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    const notes: string[] = [];
    const pass = ([id, name]: Check, detail: string) => checks.push({ id, name, status: "ok", detail, fix: null });
    const warn = ([id, name]: Check, detail: string, fix: string) => checks.push({ id, name, status: "warn", detail, fix });
    const fail = ([id, name]: Check, detail: string, fix: string) => checks.push({ id, name, status: "fail", detail, fix });
    const skip = (...skipped: Check[]) => {
      for (const [id, name] of skipped) checks.push({ id, name, status: "skipped", detail: "Skipped until the checks above pass.", fix: null });
    };
    const templates = LXC_FLAVOURS.flatMap((flavour) => this.#config.flavours[flavour].templates.map((template) => ({ flavour, template })));
    const templateCheck = ({ flavour, template }: { flavour: LxcFlavour; template: LxcTemplate }): Check => [
      `template.${template.vmid}`,
      `${FLAVOUR_NAMES[flavour]} template ${template.vmid}${template.gpu ? ` (GPU ${template.gpu})` : ""}`,
    ];
    const later = [NODE, MEMORY, POOL, ...templates.map(templateCheck), BRIDGE, VMIDS];
    let version = "";

    try {
      version = await this.#bare().version(signal);
      pass(API, `Proxmox VE ${version} at ${new URL(this.#config.proxmox.apiUrl).host}.`);
    } catch (error) {
      const unauthorised = error instanceof ProxmoxError && error.unauthorised;
      fail(
        API,
        message(error),
        unauthorised
          ? "Check the API token ID and secret in bb-box's settings."
          : "Check the API URL, and that BB's server can reach it. Set the TLS fingerprint from the setup guide's token file, or the CA certificate if a private CA signed the API's certificate.",
      );
      skip(...later);
    }

    let api: Proxmox | null = null;
    if (version) {
      try {
        api = await this.client();
        pass(NODE, `Boxes run on ${api.node}.`);
      } catch (error) {
        fail(NODE, message(error), "Set the node in bb-box's settings to one the API lists.");
        skip(...later.slice(1));
      }
    }

    if (api) {
      const node = api.node;
      const audit = (error: unknown, fix: string) => (error instanceof ProxmoxError && error.forbidden ? fix : `${fix} (${message(error)})`);
      try {
        const status = await api.nodeStatus(signal);
        pass(MEMORY, `${formatMiB(status.memoryAvailable / MiB)} of ${formatMiB(status.memoryTotal / MiB)} available.`);
        const { reserve } = this.#config;
        const largest = { cores: status.cpus ?? Infinity, memoryMiB: Math.floor(status.memoryTotal / MiB) - reserve.memoryMiB, diskGiB: null };
        const sizes = sizesCheck({
          id: "proxmox.sizes",
          name: "Box sizes",
          host: node,
          has: `${status.cpus === null ? "" : `${status.cpus} CPU threads and `}${formatMiB(status.memoryTotal / MiB)} memory`,
          keepsMiB: reserve.memoryMiB,
          kinds: this.kinds().map(({ id }) => ({ kind: id, settings: this.#context.kind(id), largest })),
        });
        if (sizes) checks.push(sizes);
      } catch (error) {
        fail(MEMORY, message(error), audit(error, `Give the token Sys.Audit on /nodes/${node}; the capacity guard needs it.`));
      }

      const pool = this.#config.proxmox.pool;
      try {
        if (await api.poolExists(pool, signal)) pass(POOL, `Pool ${pool} exists.`);
        else fail(POOL, `Pool ${pool} does not exist.`, `Create it (pveum pool add ${pool}) and give the token rights on it.`);
      } catch (error) {
        fail(POOL, message(error), audit(error, `Give the token Pool.Audit on /pool/${pool}.`));
      }

      // What images are judged by (049), read while the templates are.
      const images = this.#context.images;
      const facts = Promise.all([
        images?.pins("linux") ?? null,
        images?.pins("linux-desktop") ?? null,
        images?.bbApp(signal) ?? null,
        this.#hostNvidia(),
      ]).catch(() => [null, null, null, null] as const);
      const pinSet = (flavour: LxcFlavour): PinSet => (flavour === "linux" ? "linux" : "linux-desktop");
      for (const listed of templates) {
        const template = listed.template.vmid;
        const name = templateCheck(listed);
        const docker = OFFERS.some((offer) => offer.flavour === listed.flavour && offer.capabilities.features.includes("docker"));
        try {
          const config = await api.config(template, signal);
          const storage = String(config.rootfs ?? "").split(":")[0];
          if (!isTemplate(config)) {
            fail(name, `CT ${template} is not a template.`, `Convert it with pct template ${template}.`);
          } else if (docker && !/(?:^|,)nesting=1(?:,|$)/.test(String(config.features ?? ""))) {
            fail(name, `CT template ${template} does not have nesting, which Docker needs.`, `Run pct set ${template} --features nesting=1 as root.`);
          } else if (!storage) {
            fail(name, `CT template ${template} has no root disk.`, "Rebuild the template with the setup script.");
          } else {
            const disk = await api.storageStatus(storage, signal).catch((error: unknown) => error);
            if (disk instanceof Error) {
              fail(name, `CT template ${template} is on ${storage}, whose free space cannot be read.`, audit(disk, `Give the token Datastore.Audit on /storage/${storage}.`));
            } else {
              this.#templates.set(template, templateInfo(storage, config));
              pass(name, `CT template ${template} on ${storage}, ${Math.floor((disk as { available: number }).available / GiB)} GiB free.`);
              const [linuxPins, desktopPins, bbApp, nvidia] = await facts;
              const judged = judgeImage(
                recordInDescription(String(config.description ?? "")),
                { os: "linux", pins: pinSet(listed.flavour) === "linux" ? linuxPins : desktopPins, bbApp, hostNvidia: nvidia },
                `Rebuild it with the setup guide's template/build.sh, as root on ${node}: build.sh ${REBUILD[listed.flavour](template)} --replace.`,
              );
              checks.push({ id: `template.${template}.image`, name: `Image of ${name[1]}`, ...judged });
            }
          }
        } catch (error) {
          const missing = error instanceof ProxmoxError && error.gone;
          fail(
            name,
            missing ? `CT ${template} does not exist on ${node}, or is not in pool ${pool}.` : message(error),
            missing
              ? `Build it with the setup guide's template/build.sh, or remove it from the ${FLAVOUR_NAMES[listed.flavour]} templates in bb-box's settings.`
              : audit(error, `Give the token VM.Audit and VM.Clone on /vms/${template}.`),
          );
        }
      }

      // Each GPU's room for a desktop (#603): the host's report, or a reading in a desktop, live where one runs.
      const gpus = gpusOf(this.#config.flavours.desktop.templates);
      if (gpus.length) {
        const setup = "Run host/setup-gpu-report.sh from the setup guide as root";
        const fix = `Run systemctl status bb-box-gpu-memory.timer as root on ${node}, and check the host's clock.`;
        try {
          const vm = await api.vmNotes(GPU_REPORT_VM, signal);
          const report = vm ? parseGpuReport(vm.notes) : null;
          const unnamed = report ? gpus.filter((gpu) => !report.gpus.some((reported) => namesGpu(gpu, reported))) : [];
          if (!vm) {
            checks.push({
              id: GPU_REPORT[0],
              name: GPU_REPORT[1],
              status: "skipped",
              detail:
                `The token can read no VM named ${GPU_REPORT_VM} on ${node}, so bb-box reads GPU memory in desktops: ` +
                `a GPU that other work frees shows as free once a desktop reads it. ${setup} to have the host report it within seconds.`,
              fix: null,
            });
          } else if (!report) warn(GPU_REPORT, `VM ${vm.vmid} (${GPU_REPORT_VM}) has no report in its notes yet.`, fix);
          else if (this.#now() - report.at >= GPU_REPORT_FRESH_MS) {
            warn(GPU_REPORT, `The host's report in VM ${vm.vmid} is from ${ago(this.#now() - report.at)}, so bb-box reads GPU memory in desktops.`, fix);
          } else if (unnamed.length) {
            warn(
              GPU_REPORT,
              `The host's report has no GPU ${unnamed.join(" or ")}, so bb-box reads ${unnamed.length === 1 ? "its" : "their"} memory in desktops.`,
              "Name each GPU in bb-box's settings by the UUID nvidia-smi -L shows on the host.",
            );
          } else {
            pass(GPU_REPORT, `The host reports ${report.gpus.length === 1 ? "1 GPU" : `${report.gpus.length} GPUs`} in VM ${vm.vmid}, written ${ago(this.#now() - report.at)}.`);
          }
        } catch (error) {
          warn(GPU_REPORT, message(error), audit(error, `${setup}: it gives the token PVEAuditor on the VM.`));
        }
        await this.#readGpus(signal).catch(() => undefined);
        const state = await this.#gpuState(gpus);
        const cpu = this.#offers().some((offer) => offer.flavour === "desktop-cpu");
        for (const gpu of gpus) {
          const check: Check = [`gpu.${gpu}`, `GPU ${gpu}`];
          const reading = state.get(gpu);
          if (!reading) {
            checks.push({
              id: check[0],
              name: check[1],
              status: "skipped",
              detail: "No desktop has read its memory yet. A GPU desktop reads it as it starts, and bb-box reads it every few minutes while one runs.",
              fix: null,
            });
            continue;
          }
          const read =
            `${reading.freeMiB}${reading.totalMiB === null ? "" : ` of ${reading.totalMiB}`} MiB free, read ${ago(this.#now() - reading.at)} ` +
            `${reading.source === "host" ? "from the host's report" : "in a desktop"}. A desktop needs ${DESKTOP_GPU_MIB} MiB`;
          if (reading.freeMiB >= DESKTOP_GPU_MIB) pass(check, `${read}.`);
          else {
            warn(
              check,
              `${read}, so new desktop boxes cannot use this GPU.`,
              `Free memory on the GPU: release a desktop box, or stop what else uses it on ${node}.` + (cpu ? " Use linux-desktop-cpu boxes meanwhile." : ""),
            );
          }
        }
      }

      const bridge = this.#config.network.bridge;
      try {
        if (await api.interfaceExists(bridge, signal)) pass(BRIDGE, `${bridge} exists on ${node}.`);
        else fail(BRIDGE, `${node} has no ${bridge}.`, "Create the bridge with the host setup script, or set the bridge in bb-box's settings.");
      } catch (error) {
        fail(BRIDGE, message(error), audit(error, `Give the token Sys.Audit on /nodes/${node}.`));
      }

      try {
        const guests = await api.listPool(pool, signal);
        const { first, last } = this.#config.vmids;
        const used = guests.filter((guest) => this.#inRange(guest.vmid)).length;
        const total = last - first + 1;
        if (used < total) pass(VMIDS, `${total - used} of ${total} VMIDs from ${first} to ${last} are free.`);
        else warn(VMIDS, `All ${total} VMIDs from ${first} to ${last} are in use.`, "Release boxes, or widen the VMID range.");
        const others = await this.#others(api, guests, signal);
        if (others) notes.push(others);
      } catch (error) {
        fail(VMIDS, message(error), audit(error, `Give the token VM.Audit on /pool/${pool}.`));
      }
    }
    notes.unshift(`This install's ID is ${this.#context.installId}. Its containers carry the tag ${installTag(this.#context.installId)}.`);

    try {
      const keys = await this.#keys();
      if (keys.publicKey) {
        notes.push(
          `Box user ${this.#config.ssh.user} in each template must accept this SSH key in ~/.ssh/authorized_keys: ${keys.publicKey}`,
        );
        pass(SSH_KEY_CHECK, keys.generated ? "bb-box made a key; its public key is below." : "From bb-box's settings; its public key is below.");
      } else {
        fail(SSH_KEY_CHECK, "ssh-keygen cannot read the SSH private key in bb-box's settings.", "Paste the whole private key, or clear the setting so bb-box makes one.");
      }
    } catch (error) {
      fail(SSH_KEY_CHECK, message(error), "Check the SSH private key in bb-box's settings, or clear it so bb-box makes one.");
    }

    const ok = checks.every((check) => check.status !== "fail");
    const first = checks.find((check) => check.status === "fail");
    return {
      ok,
      summary: ok ? `Proxmox VE ${version} on ${api?.node ?? "?"}` : `${first!.name}: ${first!.detail}`,
      checks,
      notes,
    };
  }

  /**
   * The doctor's note on containers in bb-box's pool and VMID range that
   * this install leaves alone, counted by the install they name, or null
   * when there are none.
   */
  async #others(api: Proxmox, guests: readonly PoolGuest[], signal?: AbortSignal): Promise<string | null> {
    const counts = new Map<string | null, number>();
    for (const guest of guests) {
      if (guest.type !== "lxc" || guest.template || !this.#inRange(guest.vmid) || this.#reserved.has(guest.vmid) || this.#filling.has(guest.vmid)) continue;
      let install = installFromTags(guest.tags);
      if (install === null && !guest.tags.includes(TAG)) {
        install = installFromDescription((await api.config(guest.vmid, signal).catch((): Record<string, unknown> => ({}))).description);
      }
      if (install === this.#context.installId) continue;
      counts.set(install, (counts.get(install) ?? 0) + 1);
    }
    if (!counts.size) return null;
    const containers = (count: number) => `${count} ${count === 1 ? "container" : "containers"}`;
    const parts = [...counts]
      .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
      .map(([install, count]) => (install === null ? `${containers(count)} with no install ID` : `${containers(count)} of install ${install}`));
    return (
      `This install leaves alone ${parts.join(", ")} in pool ${this.#config.proxmox.pool}. They still count against the host's capacity. ` +
      "If one of these IDs was this install's before it lost its storage, take it back with bb box install-id --set <id>."
    );
  }

  maintain(signal?: AbortSignal): Promise<void> {
    return this.#upkeep.run(signal ?? this.#stopping.signal);
  }

  async dispose(): Promise<void> {
    this.#stopping.abort(new Error("bb-box is stopping."));
    await this.#upkeep.running?.catch(() => undefined);
    await (await this.#ssh?.catch(() => null))?.ssh.dispose();
    await this.#keyFile.dispose();
    await this.#http.close();
  }

  /** The Proxmox client, on the configured node or the API's only node. */
  client(): Promise<Proxmox> {
    if (!this.#api) {
      const pending = (async () => {
        let node = this.#config.proxmox.node;
        if (!node) {
          const nodes = await this.#bare().nodes();
          if (nodes.length !== 1) {
            throw new Error(
              nodes.length
                ? `The Proxmox API lists ${nodes.length} nodes (${nodes.join(", ")}). Set the node in bb-box's settings.`
                : "The Proxmox API lists no online node.",
            );
          }
          node = nodes[0]!;
        }
        return this.#proxmox(node);
      })();
      this.#api = pending;
      pending.catch(() => {
        if (this.#api === pending) this.#api = null;
      });
    }
    return this.#api;
  }

  /**
   * The flavour and template of a guest that is ready in the warm pool, or
   * null. `builds` is templateBuilds of the listing the guest is from: a
   * guest of another build of its template than the one there now, or of a
   * template that is away, is not ready.
   */
  warmOf(guest: PoolGuest, builds: ReadonlyMap<number, string | null>): { readonly flavour: LxcFlavour; readonly template: number } | null {
    if (guest.type !== "lxc" || guest.template || !this.#inRange(guest.vmid) || this.#filling.has(guest.vmid)) return null;
    if (!guest.tags.includes(WARM) || installFromTags(guest.tags) !== this.#context.installId) return null;
    const template = templateFromTags(guest.tags);
    const flavour = template === null ? null : this.#flavourOf(template);
    if (!flavour || template === null || !builds.has(template) || builds.get(template) !== buildFromTags(guest.tags)) return null;
    return { flavour, template };
  }

  /**
   * The build ID of each template that warm guests in `guests` are clones
   * of, as the template is now: null for one without. A template that is
   * away, as while build.sh --replace swaps it, is left out.
   */
  async templateBuilds(api: Proxmox, guests: readonly PoolGuest[], signal?: AbortSignal): Promise<Map<number, string | null>> {
    const named = new Set<number>();
    for (const guest of guests) {
      const template = guest.tags.includes(WARM) ? templateFromTags(guest.tags) : null;
      if (template !== null && this.#flavourOf(template)) named.add(template);
    }
    const builds = new Map<number, string | null>();
    for (const template of named) {
      const build = await templateBuild(api, guests, template, signal);
      if (build !== undefined) builds.set(template, build);
    }
    return builds;
  }

  /** Gives a warm guest its box's name and memory, and retags it. The guest keeps running, and already has the box's cores. */
  async hold(member: PoolMember, box: BoxIdentity, template: number | null, signal?: AbortSignal): Promise<void> {
    const api = await this.client();
    const vmid = Number(member.ref);
    const installId = this.#context.installId;
    await api.configure(vmid, { hostname: box.name, memory: box.size.memoryMiB, description: describe(box, installId) }, signal);
    await api.configure(vmid, { tags: boxTags(box, installId, template) }, signal);
  }

  #proxmox(node: string): Proxmox {
    return new Proxmox({
      apiUrl: this.#config.proxmox.apiUrl,
      tokenId: this.#config.proxmox.tokenId,
      tokenSecret: this.#config.proxmox.tokenSecret,
      node,
      fetch: this.#http.fetch,
      sleep: this.#options.sleep,
    });
  }

  /** A client for calls that name no node. */
  #bare(): Proxmox {
    return this.#proxmox(this.#config.proxmox.node ?? "");
  }

  #offers(): Offer[] {
    const offers: Offer[] = [];
    for (const { flavour, ...kind } of OFFERS) {
      const config = this.#config.flavours[flavour];
      if (!config.templates.length) continue;
      offers.push({ kind, flavour, config });
    }
    return offers;
  }

  /**
   * Warm guests to keep for a flavour: the sum of its kinds' counts, since
   * their guests are the same (029). None while it offers no kind.
   */
  #warmTarget(flavour: LxcFlavour): number {
    if (!this.#config.flavours[flavour].templates.length) return 0;
    return FLAVOUR_KINDS[flavour].reduce((sum, kind) => sum + this.#context.warm(kind), 0);
  }

  /** The flavour whose settings list `template`, or null. */
  #flavourOf(template: number): LxcFlavour | null {
    return LXC_FLAVOURS.find((flavour) => this.#config.flavours[flavour].templates.some((listed) => listed.vmid === template)) ?? null;
  }

  footprint(): Footprint {
    return proxmoxFootprint(this.#config);
  }

  /** A guest of a template the kind's flavour lists now, from that template's build as it is now. */
  async asOffered(guest: Guest, kind: string, createdAt: number, signal?: AbortSignal): Promise<boolean> {
    const template = guest.data?.template;
    const offer = this.#offers().find((candidate) => candidate.kind.id === kind);
    if (typeof template !== "number" || !offer || !offer.config.templates.some((listed) => listed.vmid === template)) return false;
    return fromBuild(guest, await templateBuild(await this.client(), [], template, signal), createdAt);
  }

  /** Whether a guest comes from the build its template has now: false once a refresh has replaced it, or the kind no longer lists the template; null when the guest or template records no build. */
  async fromCurrentBuild(guest: Guest, kind: string, signal?: AbortSignal): Promise<boolean | null> {
    const template = guest.data?.template;
    const offer = this.#offers().find((candidate) => candidate.kind.id === kind);
    if (typeof template !== "number" || !offer) return null;
    if (!offer.config.templates.some((listed) => listed.vmid === template)) return false;
    const current = await templateBuild(await this.client(), [], template, signal);
    if (current === undefined) return false;
    const recorded = guest.data?.build;
    return current && typeof recorded === "string" ? recorded === current : null;
  }

  #offer(kind: string): Offer {
    const offer = this.#offers().find((candidate) => candidate.kind.id === kind);
    if (!offer) throw new BackendError("unsupported", `${this.label} has no ${kind} boxes.`);
    return offer;
  }

  #inRange(vmid: number): boolean {
    return Number.isInteger(vmid) && vmid >= this.#config.vmids.first && vmid <= this.#config.vmids.last;
  }

  #vmid(guest: Guest): number {
    const vmid = Number(guest.ref);
    if (!this.#inRange(vmid)) throw new Error(`Guest ${guest.ref} is outside bb-box's VMID range, so bb-box leaves it alone.`);
    return vmid;
  }

  /**
   * `template`, its `build` and `box` are kept with the box. A GPU desktop's GPU is
   * shown, and a desktop's display mode and why, once it has started.
   */
  #guest(
    node: string,
    vmid: number,
    template: number | null = null,
    box: string | null = null,
    display: DisplayMode | null = null,
    size: BoxSize | null = null,
    build: string | null = null,
  ): Guest {
    const guest: Guest = { ref: String(vmid), host: node, address: addressFor(this.#config, vmid), size };
    const data = { ...(template !== null ? { template } : {}), ...(build !== null ? { build } : {}), ...(box !== null ? { box } : {}) };
    if (!Object.keys(data).length) return guest;
    const facts = this.#facts(template, display);
    return { ...guest, data, ...(facts.length ? { facts } : {}) };
  }

  /** A GPU desktop's GPU, and a desktop's display mode and why, once it has started; with no display mode known, none. */
  #facts(template: number | null, display: DisplayMode | null): GuestFact[] {
    const gpu = this.#gpuOf(template);
    return [
      ...(gpu ? [{ label: "GPU", value: gpu }] : []),
      ...(display ? [{ label: "Display mode", value: DISPLAY_MODE_WORDS[display.mode] ?? display.mode }] : []),
      ...(display?.reason ? [{ label: "Display reason", value: displayReason(display.reason) }] : []),
    ];
  }

  /** A desktop started without its GPU: new desktops go to other GPUs for a while. */
  #avoidGpu(gpu: string | null): void {
    if (gpu) this.#avoid.set(gpu, Date.now() + AVOID_GPU_MS);
  }

  /**
   * The GPUs a new desktop is not placed on: those in `failed`, and those
   * avoided lately or last read full while another GPU is left.
   */
  async #placing(offer: Offer, failed: ReadonlySet<string> = NO_GPUS): Promise<ReadonlySet<string>> {
    const now = Date.now();
    for (const [gpu, until] of this.#avoid) if (until <= now) this.#avoid.delete(gpu);
    const gpus = gpusOf(offer.config.templates);
    const state = await this.#gpuState(gpus);
    const full = gpus.filter((gpu) => this.#fullUntil([gpu], state) !== null);
    const skip = new Set([...failed, ...this.#avoid.keys(), ...full]);
    return offer.config.templates.some((template) => template.gpu !== null && !skip.has(template.gpu)) ? skip : failed;
  }

  /** The GPU a GPU desktop template carries. */
  #gpuOf(template: number | null): string | null {
    return this.#config.flavours.desktop.templates.find((listed) => listed.vmid === template)?.gpu ?? null;
  }

  /** The guest's config, or null when it does not exist. */
  async #guestConfig(api: Proxmox, vmid: number, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    try {
      return await api.config(vmid, signal);
    } catch (error) {
      if (error instanceof ProxmoxError && error.gone) return null;
      throw error;
    }
  }

  /**
   * Whether the guest at the reference is still `guest` (018): it names this
   * install and the box in `guest.data.box`, or no box when that is absent,
   * as for a leftover `held()` found without an owner. Proxmox reuses a VMID
   * once the range wraps, so a box whose container was deleted outside
   * bb-box may find another box's there.
   */
  async #still(api: Proxmox, guest: Guest, signal?: AbortSignal): Promise<boolean> {
    const config = await this.#guestConfig(api, this.#vmid(guest), signal);
    if (!config) return false;
    const names = namesOf(config);
    const box = typeof guest.data?.box === "string" ? guest.data.box : null;
    return names.install === this.#context.installId && names.box === box;
  }

  /** How bb-box and the thread reach a box over SSH. A fresh guest's host key is accepted. */
  #access(vmid: number): SshAccess {
    const address = addressFor(this.#config, vmid);
    if (!address) throw new Error(`VMID ${vmid} has no address.`);
    return { host: address, port: 22, user: this.#config.ssh.user, hostKeys: [] };
  }

  /** The first free VMID from `from`, wrapping round the range. */
  #freeVmid(guests: readonly PoolGuest[], from = this.#config.vmids.first): number | null {
    const { first, last } = this.#config.vmids;
    const count = last - first + 1;
    const used = new Set<number>([...this.#reserved, ...this.#filling.keys(), ...guests.map((guest) => guest.vmid)]);
    for (let step = 0; step < count; step++) {
      const vmid = first + ((from - first + step) % count);
      if (!used.has(vmid)) return vmid;
    }
    return null;
  }

  /** Config for a fresh clone at `vmid`. A null size keeps the template's cores and memory. */
  #settings(size: BoxSize | null, vmid: number) {
    return {
      ...(size ? { cores: size.cores, memory: size.memoryMiB } : {}),
      net0: net0For(this.#config, vmid),
      onboot: true,
      // Templates are protected against deletion, and clones inherit it.
      delete: ["protection"],
    };
  }

  /**
   * Grows a running guest's disk to `wanted` GiB when its template's is
   * smaller. A null size keeps the template's. Proxmox cannot shrink disks,
   * so a smaller size leaves the template's.
   */
  async #grow(api: Proxmox, vmid: number, wanted: number | null, template: number | null, step: Step, signal?: AbortSignal): Promise<void> {
    if (wanted === null) return;
    const templateDisk = template === null ? null : this.#templates.get(template)?.diskGiB;
    if (templateDisk != null && templateDisk >= wanted) return;
    await step("resize", () => api.growRootDisk(vmid, wanted, signal));
  }

  /** Whether the guest at `vmid` names the box. Box IDs are unique, so no other install's guest does. */
  async #owns(api: Proxmox, vmid: number, boxId: string, signal?: AbortSignal): Promise<boolean> {
    const config = await this.#guestConfig(api, vmid, signal);
    return !!config && namesOf(config).box === boxId;
  }

  async #templateOf(api: Proxmox, template: number, signal?: AbortSignal): Promise<TemplateInfo> {
    const cached = this.#templates.get(template);
    if (cached) return cached;
    let config: Record<string, unknown>;
    try {
      config = await api.config(template, signal);
    } catch (error) {
      if (!(error instanceof ProxmoxError && error.gone)) throw error;
      // It may be away while build.sh --replace swaps it.
      if ((await this.#templateBack(api, template, Date.now() + this.#templateWaitMs, signal)) === "away") {
        throw new Error(`CT template ${template} does not exist on ${api.node}, or is not in pool ${this.#config.proxmox.pool}. Run the doctor check in bb-box's panel.`);
      }
      config = await api.config(template, signal);
    }
    const storage = String(config.rootfs ?? "").split(":")[0];
    if (!storage) throw new Error(`CT template ${template} has no root disk.`);
    const found = templateInfo(storage, config);
    this.#templates.set(template, found);
    return found;
  }

  /**
   * Whether `template` is away: missing, not yet a template or locked, as
   * while build.sh --replace swaps it. The token reaches only the pool's
   * guests, so Proxmox may answer 403 for a VMID that is not there.
   */
  async #away(api: Proxmox, template: number, signal?: AbortSignal): Promise<boolean> {
    try {
      const config = await api.config(template, signal);
      return !isTemplate(config) || config.lock !== undefined;
    } catch (error) {
      if (error instanceof ProxmoxError && error.gone) return true;
      throw error;
    }
  }

  /**
   * Waits for `template` until `deadline`: "there" when it was there at
   * once, "back" when it came back, "away" when it was still away.
   */
  async #templateBack(api: Proxmox, template: number, deadline: number, signal?: AbortSignal): Promise<"there" | "back" | "away"> {
    const sleep = this.#options.sleep ?? pause;
    if (!(await this.#away(api, template, signal))) return "there";
    for (;;) {
      if (Date.now() >= deadline) return "away";
      await sleep(TEMPLATE_POLL_MS, signal);
      if (!(await this.#away(api, template, signal))) return "back";
    }
  }

  get #templateWaitMs(): number {
    return this.#options.templateWaitMs ?? TEMPLATE_WAIT_MS;
  }

  /**
   * Linked-clones `template` into the next free VMID, round-robin. `before`
   * runs before each attempt. A VMID another guest has taken is skipped.
   * When the clone fails while the template is away, as while build.sh
   * --replace swaps it, it waits for the template, tells `waited` how long,
   * and tries again on the next VMID.
   */
  async #clone(
    api: Proxmox,
    guests: readonly PoolGuest[],
    template: number,
    hostname: string,
    description: string,
    before: (vmid: number) => Promise<void>,
    signal: AbortSignal,
    waited: (ms: number) => void = () => {},
  ): Promise<number> {
    if (this.#nextVmid === null) {
      const stored = await this.#context.storage.get<number>(NEXT_VMID);
      this.#nextVmid ??= typeof stored === "number" && this.#inRange(stored) ? stored : this.#config.vmids.first;
    }
    const skipped = new Set<number>();
    const deadline = Date.now() + this.#templateWaitMs;
    let again = false;
    for (;;) {
      const vmid = this.#freeVmid([...guests, ...[...skipped].map((id) => ({ vmid: id }) as PoolGuest)], this.#nextVmid);
      if (vmid === null) {
        throw new BackendError(
          "no_capacity",
          `Every VMID from ${this.#config.vmids.first} to ${this.#config.vmids.last} is in use. Release a box, or widen the VMID range in bb-box's settings.`,
        );
      }
      this.#reserved.add(vmid);
      this.#nextVmid = vmid === this.#config.vmids.last ? this.#config.vmids.first : vmid + 1;
      try {
        await this.#context.storage.set(NEXT_VMID, this.#nextVmid);
        await before(vmid);
        await api.cloneLinked({ template, vmid, hostname, pool: this.#config.proxmox.pool, description }, signal);
        return vmid;
      } catch (error) {
        if (error instanceof ProxmoxError && error.alreadyExists) {
          skipped.add(vmid);
          continue;
        }
        if (!(error instanceof ProxmoxError)) throw error;
        const started = performance.now();
        // When bb-box cannot read the template, the clone's error stands.
        const state = await this.#templateBack(api, template, deadline, signal).catch(() => null);
        signal.throwIfAborted();
        if (state === null) throw error;
        if (state === "away") {
          throw new Error(
            `CT template ${template} on ${api.node} was still missing, or not yet a template, after ${Math.round(this.#templateWaitMs / 1000)} s ` +
              `(${message(error)}). Run the doctor check in bb-box's panel.`,
          );
        }
        if (state === "back") {
          waited(Math.round(performance.now() - started));
          continue;
        }
        // The template is there: try once more, as it may have come back since the clone failed.
        if (again) throw error;
        again = true;
        continue;
      } finally {
        this.#reserved.delete(vmid);
      }
    }
  }

  /** The configured templates, as standard images, and this install's captured builds and image boxes. */
  async #imageList(signal?: AbortSignal): Promise<{ builds: ImageBuild[]; boxes: string[] }> {
    const api = await this.client();
    const install = installTag(this.#context.installId);
    const builds: ImageBuild[] = [];
    for (const flavour of LXC_FLAVOURS) {
      for (const { vmid } of this.#config.flavours[flavour].templates) {
        const config = await api.config(vmid, signal).catch(() => null);
        if (config && isTemplate(config)) builds.push(this.#imageBuild(vmid, FLAVOUR_KINDS[flavour][0]!, "standard", config, true));
      }
    }
    const boxes: string[] = [];
    for (const guest of await api.listPool(this.#config.proxmox.pool, signal)) {
      if (guest.type !== "lxc" || !this.#inRange(guest.vmid) || !guest.tags.includes(install)) continue;
      const image = guest.tags.find((tag) => tag.startsWith(IMAGE_TAG))?.slice(IMAGE_TAG.length);
      const kind = guest.tags.find((tag) => tag.startsWith(KIND_TAG))?.slice(KIND_TAG.length);
      if (image && kind) {
        // From its config: the listing says it is a template only after Proxmox's next status pass.
        const config = await this.#guestConfig(api, guest.vmid, signal);
        if (config && isTemplate(config)) builds.push(this.#imageBuild(guest.vmid, kind, image, config, false));
      } else if (guest.tags.includes(IMAGE_BOX)) {
        boxes.push(String(guest.vmid));
      }
    }
    return { builds, boxes };
  }

  #imageBuild(vmid: number, kind: string, image: string, config: Record<string, unknown>, current: boolean): ImageBuild {
    const build = buildFromTags(parseTags(config.tags));
    return { ref: String(vmid), image, kind, build: build ? `${BUILD}${build}` : null, record: recordInDescription(String(config.description ?? "")), current };
  }

  /** A clone of a build's template, started as a box of its kind is, tagged so that no sweep takes it. */
  async #imageBox(build: ImageBuild, label: string, signal: AbortSignal): Promise<ImageBox> {
    const api = await this.client();
    const template = Number(build.ref);
    const offer = this.#offer(build.kind);
    let vmid: number | null = null;
    try {
      const guests = await api.listPool(this.#config.proxmox.pool, signal);
      const description = `bb-box image box: ${label}\ninstall ${this.#context.installId}`;
      vmid = await this.#clone(api, guests, template, IMAGE_HOSTNAME, description, async (id) => void this.#imageBoxes.add(id), signal);
      await api.configure(vmid, this.#settings(null, vmid), signal);
      await api.configure(vmid, { tags: [TAG, installTag(this.#context.installId), IMAGE_BOX, templateTag(template)] }, signal);
      await api.start(vmid, signal);
      await this.#waitReady(vmid, build.kind, this.#options.readyTimeoutMs ?? offer.kind.readyTimeoutMs, signal);
      return { ref: String(vmid), command: await this.#command(vmid) };
    } catch (error) {
      if (vmid !== null) {
        await this.#forget(vmid);
        await api.destroy(vmid).catch((cause) => this.#context.logError("remove an image box", cause));
        this.#imageBoxes.delete(vmid);
      }
      throw error;
    }
  }

  /**
   * Shuts a build box down and makes it a template, configured as `from`
   * (its network without an address, and its hostname), with its record in
   * the description's second line and the image, kind and build in its tags.
   */
  async #capture(box: ImageBox, from: ImageBuild, image: string, signal: AbortSignal): Promise<ImageBuild> {
    const api = await this.client();
    const vmid = Number(box.ref);
    const read = await box.command.run("cat /usr/share/bb-box/image.json", { timeoutMs: 15_000, signal, maxOutputBytes: 64 * 1024 });
    const record = read.exitCode === 0 ? recordFromJson(read.stdout.trim()) : null;
    if (!record) throw new Error(`Image box ${vmid} has no image record in /usr/share/bb-box/image.json, which finalizing writes.`);
    const source = await api.config(Number(from.ref), signal);
    const build = record.build.startsWith(BUILD) ? record.build : `${BUILD}${record.build}`;
    await this.#forget(vmid);
    await api.shutdown(vmid, 60, signal);
    await api.configure(
      vmid,
      {
        hostname: typeof source.hostname === "string" ? source.hostname : IMAGE_HOSTNAME,
        ...(typeof source.net0 === "string" ? { net0: source.net0 } : {}),
        onboot: false,
        description: `bb-box ${image} image of ${from.kind}, built ${new Date().toISOString().slice(0, 10)} from template ${from.ref}.\n${JSON.stringify(record)}`,
        tags: [TAG, installTag(this.#context.installId), `${IMAGE_TAG}${image}`, `${KIND_TAG}${from.kind}`, templateTag(Number(from.ref)), build],
      },
      signal,
    );
    await api.makeTemplate(vmid, signal);
    await api.configure(vmid, { protection: true }, signal);
    this.#imageBoxes.delete(vmid);
    return { ref: String(vmid), image, kind: from.kind, build, record, current: false };
  }

  /**
   * Puts a captured build in a configured template's place under its VMID:
   * the old template goes, the build is cloned into its VMID (linked on
   * LVM-thin, where the clone needs nothing of its origin, else a full copy
   * on the template's storage), made a template with the old one's tags but
   * the new build's ID, and the build goes. Acquires wait for the template
   * meanwhile, and warm guests of the old build are retired.
   */
  async #replaceTemplate(build: ImageBuild, current: ImageBuild, signal: AbortSignal): Promise<ImageBuild> {
    if (!current.current || build.current) throw new Error(`Template ${current.ref} is not a configured template, or ${build.ref} is one.`);
    const api = await this.client();
    const [source, target] = [Number(build.ref), Number(current.ref)];
    const old = await api.config(target, signal);
    const storage = String(old.rootfs ?? "").split(":")[0] ?? "";
    const thin = (await api.storageStatus(storage, signal)).type === "lvmthin";
    const hostname = typeof old.hostname === "string" ? old.hostname : `bb-box-${target}`;
    const first = String(old.description ?? `bb-box ${current.kind} template.`).split("\n")[0]!;
    const today = new Date().toISOString().slice(0, 10);
    const line = /, (built|refreshed) \d{4}-\d{2}-\d{2}/.test(first) ? first.replace(/, (built|refreshed) \d{4}-\d{2}-\d{2}/, `, refreshed ${today}`) : first;
    const description = `${line}${build.record ? `\n${JSON.stringify(build.record)}` : ""}`;
    const tags = [...parseTags(old.tags).filter((tag) => !tag.startsWith(BUILD)), ...(build.build ? [build.build] : [])];
    // Templates are protected against deletion: the token may clear it in the pool.
    await api.configure(target, { delete: ["protection"] }, signal);
    await api.destroy(target, signal);
    this.#templates.delete(target);
    const pool = this.#config.proxmox.pool;
    if (thin) await api.cloneLinked({ template: source, vmid: target, hostname, pool, description }, signal);
    else await api.cloneFull({ template: source, vmid: target, hostname, storage, pool, description }, signal);
    await api.makeTemplate(target, signal);
    await api.configure(target, { description, tags, protection: true }, signal);
    await api.configure(source, { delete: ["protection"] }, signal);
    await api.destroy(source, signal);
    return { ...build, ref: String(target), image: "standard", current: true };
  }

  /** Removes an image box or a captured build of this install's, and nothing else. */
  async #removeImage(ref: string, signal?: AbortSignal): Promise<void> {
    const vmid = Number(ref);
    const api = await this.client();
    const config = await this.#guestConfig(api, vmid, signal);
    if (!config) return;
    const tags = parseTags(config.tags);
    const configured = LXC_FLAVOURS.some((flavour) => this.#config.flavours[flavour].templates.some((template) => template.vmid === vmid));
    const ours = tags.includes(installTag(this.#context.installId)) && (tags.includes(IMAGE_BOX) || tags.some((tag) => tag.startsWith(IMAGE_TAG)));
    if (configured || !ours || !this.#inRange(vmid)) throw new Error(`CT ${vmid} is not an image box or build of this install's, so bb-box leaves it.`);
    await this.#forget(vmid);
    // A captured build is protected, as templates are.
    if (config.protection) await api.configure(vmid, { delete: ["protection"] }, signal);
    await api.destroy(vmid, signal);
    this.#imageBoxes.delete(vmid);
  }

  async #command(vmid: number): Promise<SshTransport> {
    return new SshTransport((await this.#keys()).ssh, this.#access(vmid), "linux");
  }

  /** Records a box's new owner and name on its guest, and names the guest after it inside (036). */
  async relabel(guest: Guest, box: BoxIdentity, from: string, signal?: AbortSignal): Promise<void> {
    const api = await this.client();
    const vmid = Number(guest.ref);
    const installId = this.#context.installId;
    const template = templateFromTags(parseTags((await api.config(vmid, signal)).tags));
    await api.configure(vmid, { hostname: box.name, description: describe(box, installId) }, signal);
    await api.configure(vmid, { tags: boxTags(box, installId, template) }, signal);
    if (from !== box.name) await this.#name(vmid, box.name, signal, from);
  }

  /** Names a claimed warm guest, or one named `from`, after its box inside. A failure is logged, and leaves the guest's name as it was. */
  async #name(vmid: number, name: string, signal?: AbortSignal, from = WARM_HOSTNAME): Promise<void> {
    try {
      const command = await this.#command(vmid);
      const result = await command.run(nameScript(from, name), { timeoutMs: 15_000, signal, maxOutputBytes: 4096 });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `exit code ${result.exitCode}`);
    } catch (error) {
      signal?.throwIfAborted();
      const why = error instanceof Error ? error.message : String(error);
      this.#context.logError("name the box", new Error(`Naming box ${name} inside failed, so it may keep the hostname ${from}, or its desktop may open no windows: ${why}`));
    }
  }

  /** Waits for port 22 to open, which is cheap to poll, then for SSH to answer. */
  async #waitReady(vmid: number, kind: string | null, timeoutMs: number, signal?: AbortSignal, step: Step = untimed): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const { host, port, user } = this.#access(vmid);
    const sleep = this.#options.sleep;
    const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;
    const open = await step("network", () => waitForPort(host, port, { timeoutMs, check: this.#options.portCheck, signal, sleep }));
    if (!open) {
      throw new Error(
        `Nothing answered on port ${port} of ${host} within ${seconds(timeoutMs)}. ` +
          `Check that BB's server can reach the boxes' subnet, and that the ${kind ?? "box's"} template starts sshd.`,
      );
    }
    const left = Math.max(1_000, deadline - Date.now());
    const command = await this.#command(vmid);
    // Through the shared connection, which the box's first commands then use.
    const answers = { probe: (signal?: AbortSignal) => command.answers(signal) };
    const ready = await step("ssh", () => waitUntilAnswers(answers, { timeoutMs: left, intervalMs: 100, signal, sleep }));
    if (!ready) {
      throw new Error(
        `Port ${port} of ${host} is open, but SSH as ${user} did not answer within ${seconds(left)}. ` +
          `Check that user ${user} in the ${kind ?? "box's"} template accepts bb-box's key.`,
      );
    }
  }

  /**
   * Waits for the desktop's display service to say which path it took. It
   * writes the files before it starts the display, soon after boot.
   */
  async #displayMode(vmid: number, kind: string, timeoutMs: number, signal?: AbortSignal): Promise<DisplayMode> {
    const deadline = Date.now() + timeoutMs;
    const command = await this.#command(vmid);
    const sleep = this.#options.sleep ?? pause;
    for (;;) {
      // With the host's NVIDIA driver, which the doctor compares with GPU templates' (049).
      const result = await command.run(
        `cat ${DISPLAY_MODE_FILE} 2>/dev/null && { cat ${DISPLAY_REASON_FILE} 2>/dev/null || echo; cat ${NVIDIA_VERSION_FILE} 2>/dev/null; }; :`,
        { timeoutMs: 15_000, signal, maxOutputBytes: 4096 },
      );
      const [mode = "", reason = "", nvidia = ""] = result.stdout.split("\n").map((line) => line.trim());
      if (mode) {
        if (nvidia) await this.#sawNvidia(nvidia);
        return { mode, reason };
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `The ${kind} box's desktop did not start: ${DISPLAY_MODE_FILE} is missing after ${Math.round(timeoutMs / 1000)} s. ` +
            `Check bb-box-display.service in the ${kind} template.`,
        );
      }
      await sleep(200, signal);
    }
  }

  /** The host's NVIDIA driver as a box last saw it, or null when none has. */
  async #hostNvidia(): Promise<HostNvidia | null> {
    if (this.#nvidia === undefined) this.#nvidia = (await this.#context.storage.get<HostNvidia>(NVIDIA_KEY)) ?? null;
    return this.#nvidia;
  }

  /** Keeps the host's NVIDIA driver a box saw, when it is another than the last. */
  async #sawNvidia(version: string): Promise<void> {
    try {
      if ((await this.#hostNvidia())?.version === version) return;
      this.#nvidia = { version, seen: new Date().toISOString() };
      await this.#context.storage.set(NVIDIA_KEY, this.#nvidia);
    } catch (error) {
      this.#context.logError("record the host's NVIDIA driver", error);
    }
  }

  /** The time GPU readings are dated by. */
  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  /** Each GPU's memory as last read, from storage at first. */
  async #gpuReadings(): Promise<Map<string, StoredGpu>> {
    if (!this.#gpus) {
      const stored = await this.#context.storage.get<Record<string, StoredGpu>>(GPUS_KEY).catch(() => null);
      this.#gpus ??= new Map(Object.entries(stored ?? {}));
    }
    return this.#gpus;
  }

  /** Keeps a reading of a GPU's memory, with the total an earlier one read when this has none. */
  async #sawGpu(gpu: string, freeMiB: number, totalMiB: number | null): Promise<void> {
    try {
      const readings = await this.#gpuReadings();
      readings.set(gpu, { freeMiB, totalMiB: totalMiB ?? readings.get(gpu)?.totalMiB ?? null, at: this.#now() });
      await this.#context.storage.set(GPUS_KEY, Object.fromEntries(readings));
    } catch (error) {
      this.#context.logError("record a GPU's memory", error);
    }
  }

  /** The free memory a GPU desktop's display service saw on its GPU as it started. */
  async #sawDisplay(template: number | null, display: DisplayMode | null): Promise<void> {
    const gpu = this.#gpuOf(template);
    const free = display ? /^GPU has (\d+) MiB free/.exec(display.reason) : null;
    if (gpu && free) await this.#sawGpu(gpu, Number(free[1]), null);
  }

  /**
   * The host's report of each GPU's memory (#603), read at most every 10 s,
   * or null when the token can read none, or it cannot be read. With
   * `waitMs`, null when it takes longer.
   */
  async #hostGpus(waitMs?: number): Promise<{ readonly report: GpuReport | null; readonly read: number }> {
    if (!this.#report || this.#now() - this.#report.read >= GPU_REPORT_CACHE_MS) {
      const report = this.client()
        .then((api) => api.vmNotes(GPU_REPORT_VM))
        .then((vm) => (vm ? parseGpuReport(vm.notes) : null))
        .catch(() => null);
      this.#report = { read: this.#now(), report };
    }
    const { read, report } = this.#report;
    if (waitMs === undefined) return { read, report: await report };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), waitMs)));
    try {
      return { read, report: await Promise.race([report, late]) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Each GPU's room as bb-box knows it now: the host's report while it is
   * under 10 minutes old, else the last reading in a desktop. A GPU the host
   * reports full refuses desktops until bb-box reads the report again, so it
   * has room again within seconds of the host freeing it. A reading in a
   * desktop stands 5 minutes, and only until a desktop on the GPU is
   * released, which frees memory it does not show.
   */
  async #gpuState(gpus: readonly string[], waitMs?: number): Promise<Map<string, GpuState>> {
    const state = new Map<string, GpuState>();
    if (!gpus.length) return state;
    const readings = await this.#gpuReadings();
    const { report, read } = await this.#hostGpus(waitMs);
    const now = this.#now();
    const current = report && now - report.at < GPU_REPORT_FRESH_MS ? report : null;
    for (const gpu of gpus) {
      const reported = current?.gpus.find((candidate) => namesGpu(gpu, candidate));
      if (reported) {
        state.set(gpu, { freeMiB: reported.freeMiB, totalMiB: reported.totalMiB, at: read, source: "host", until: read + GPU_REPORT_REFUSES_MS });
        continue;
      }
      const reading = readings.get(gpu);
      if (!reading) continue;
      const until = reading.at + GPU_FRESH_MS;
      state.set(gpu, { ...reading, source: "desktop", until: until > now && reading.at > (this.#freed.get(gpu) ?? 0) ? until : null });
    }
    return state;
  }

  /** Until when every one of the GPUs refuses desktops, as each has less free than one needs; null when one does not. */
  #fullUntil(gpus: readonly string[], state: ReadonlyMap<string, GpuState>): number | null {
    const now = this.#now();
    const until = gpus.map((gpu) => {
      const known = state.get(gpu);
      return known && known.freeMiB < DESKTOP_GPU_MIB && known.until !== null && known.until > now ? known.until : null;
    });
    return gpus.length && until.every((time) => time !== null) ? Math.min(...(until as number[])) : null;
  }

  /**
   * Reads each GPU's memory with nvidia-smi in a running desktop of this
   * install that has it, where the last reading is a minute old or more and
   * the host does not report the GPU.
   */
  async #readGpus(signal?: AbortSignal): Promise<void> {
    const gpus = gpusOf(this.#config.flavours.desktop.templates);
    if (!gpus.length) return;
    const api = await this.client();
    const readings = await this.#gpuReadings();
    const state = await this.#gpuState(gpus);
    for (const guest of await api.listPool(this.#config.proxmox.pool, signal)) {
      if (guest.status !== "running" || guest.template || !this.#inRange(guest.vmid) || this.#filling.has(guest.vmid) || guest.tags.includes(FILLING)) continue;
      if (installFromTags(guest.tags) !== this.#context.installId) continue;
      const gpu = this.#gpuOf(templateFromTags(guest.tags));
      if (!gpu || state.get(gpu)?.source === "host" || this.#now() - (readings.get(gpu)?.at ?? 0) < GPU_READ_EVERY_MS) continue;
      const result = await (await this.#command(guest.vmid)).run(GPU_QUERY, { timeoutMs: 15_000, signal, maxOutputBytes: 1024 }).catch(() => null);
      const read = result?.exitCode === 0 ? /^(\d+),\s*(\d+)$/.exec(result.stdout.trim()) : null;
      if (read) await this.#sawGpu(gpu, Number(read[1]), Number(read[2]));
    }
  }

  /**
   * The room on the GPUs a kind's boxes would use (#603): the host's report,
   * read at most every 10 s and waited for 2 s at most, else the last
   * readings in desktops.
   */
  async gpuRoom(kind: string): Promise<GpuRoom> {
    const offer = this.#offers().find((candidate) => candidate.kind.id === kind);
    if (!offer?.kind.capabilities.gpu) return { readings: [], fullUntil: null };
    const gpus = gpusOf(offer.config.templates);
    const state = await this.#gpuState(gpus, GPU_REPORT_WAIT_MS);
    return {
      readings: gpus.flatMap((id) => {
        const known = state.get(id);
        return known ? [{ id, freeMiB: known.freeMiB, totalMiB: known.totalMiB, at: known.at, neededMiB: DESKTOP_GPU_MIB, source: known.source }] : [];
      }),
      fullUntil: this.#fullUntil(gpus, state),
    };
  }

  /** The password the desktop wrote at boot, or null when it asks for none. */
  async #vncPassword(command: SshTransport, signal?: AbortSignal): Promise<string | null> {
    const result = await command.run(`cat ${VNC_PASSWORD_FILE} 2>/dev/null || :`, { timeoutMs: 15_000, signal, maxOutputBytes: 1024 });
    if (result.exitCode !== 0) {
      throw new Error(`Cannot read the desktop's VNC password over SSH: ${result.stderr.trim() || `exit code ${result.exitCode}`}.`);
    }
    return result.stdout.trim() || null;
  }

  /**
   * Sets the GPU desktop's size with xrandr, as the box user. With no clamp:
   * a size the X server cannot take fails with xrandr's reason (021). Back on
   * the CPU it does nothing: Xtigervnc has taken the viewer's SetDesktopSize,
   * and an older size that lands after a newer one disconnects its output.
   */
  async #resize(command: SshTransport, size: DisplaySize, signal?: AbortSignal): Promise<void> {
    const { width, height } = wholeSize(size);
    const script = `[ "$(cat ${DISPLAY_MODE_FILE} 2>/dev/null)" = cpu ] || ${DISPLAY_ENV} xrandr --fb ${width}x${height}`;
    const result = await command.run(script, { timeoutMs: 15_000, signal, maxOutputBytes: 4096 });
    if (result.exitCode !== 0) {
      throw new Error(`xrandr could not set the desktop to ${width}x${height}: ${result.stderr.trim() || `exit code ${result.exitCode}`}.`);
    }
  }

  /**
   * Sets a Wayland desktop's size with its display script, as the box user:
   * Sway's output takes the size, and the floating windows are fitted into
   * it (048). A size Sway cannot take fails with the script's reason.
   */
  async #resizeWayland(command: SshTransport, size: DisplaySize, signal?: AbortSignal): Promise<void> {
    const { width, height } = wholeSize(size);
    const result = await command.run(`${DISPLAY_SCRIPT} resize ${width}x${height}`, { timeoutMs: 15_000, signal, maxOutputBytes: 4096 });
    if (result.exitCode !== 0) {
      throw new Error(`Sway could not set the desktop to ${width}x${height}: ${result.stderr.trim() || `exit code ${result.exitCode}`}.`);
    }
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
        const shareDir = await this.#keyFile.shareDir();
        return { ssh: new Ssh({ keyPath, binary: this.#options.sshBinary, shareDir }), publicKey: publicText, generated };
      })();
      this.#ssh = pending;
      pending.catch(() => {
        if (this.#ssh === pending) this.#ssh = null;
      });
    }
    return this.#ssh;
  }

  /** Tops up the warm pool in the background after a warm guest is claimed. */
  #kick(): void {
    if (!LXC_FLAVOURS.some((flavour) => this.#warmTarget(flavour) > 0)) return;
    this.maintain(this.#stopping.signal).catch((error) => this.#context.logError("warm pool", error));
  }

  async #topUp(signal: AbortSignal): Promise<void> {
    const api = await this.client();
    const pool = this.#config.proxmox.pool;
    // Retire warm guests beyond their flavour's target, of a template no longer
    // listed, or of another build of their template, while no claim runs.
    const retired = await this.#warm.exclusive(async () => {
      const guests = await api.listPool(pool, signal);
      const builds = await this.templateBuilds(api, guests, signal);
      const kept = new Map<LxcFlavour, number>();
      const out: number[] = [];
      for (const guest of guests) {
        if (!guest.tags.includes(WARM) || guest.type !== "lxc" || guest.template || !this.#inRange(guest.vmid) || this.#filling.has(guest.vmid)) continue;
        if (installFromTags(guest.tags) !== this.#context.installId) continue;
        const flavour = this.warmOf(guest, builds)?.flavour;
        const count = flavour ? (kept.get(flavour) ?? 0) : 0;
        if (flavour && guest.status === "running" && count < this.#warmTarget(flavour)) {
          kept.set(flavour, count + 1);
          continue;
        }
        await api.configure(guest.vmid, { tags: [TAG, installTag(this.#context.installId), RETIRED] }, signal);
        out.push(guest.vmid);
      }
      return out;
    });
    for (const vmid of retired) {
      await this.#forget(vmid);
      await api.destroy(vmid, signal).catch((error) => this.#context.logError("retire a warm box", error));
    }

    const short: WarmShortfall[] = [];
    for (const flavour of LXC_FLAVOURS) {
      // Any kind of the flavour stands for it: their guests are the same.
      const offer = this.#offers().find((candidate) => candidate.flavour === flavour);
      const target = offer ? this.#warmTarget(flavour) : 0;
      if (!offer || target === 0) continue;
      const guests = await api.listPool(pool, signal);
      const builds = await this.templateBuilds(api, guests, signal);
      const ready = guests.filter((guest) => this.warmOf(guest, builds)?.flavour === flavour && guest.status === "running").length;
      const filling = [...this.#filling.values()].filter((template) => this.#flavourOf(template) === flavour).length;
      for (let missing = target - ready - filling; missing > 0; missing--) {
        signal.throwIfAborted();
        const room = await this.#room(api, offer, null, await api.listPool(pool, signal), [], { ready, target }, null, signal);
        if (!room.ok) {
          const kinds = FLAVOUR_KINDS[flavour].filter((kind) => this.#context.warm(kind) > 0);
          short.push({ kinds, count: target, have: target - missing, reason: room.message ?? "No host has room for a warm box." });
          break;
        }
        await this.#fill(api, offer, signal);
      }
    }
    this.#context.warmShortfalls(short);
  }

  async #fill(api: Proxmox, offer: Offer, signal: AbortSignal): Promise<void> {
    const { flavour } = offer;
    const install = installTag(this.#context.installId);
    let vmid: number | null = null;
    const claimed: number[] = [];
    try {
      const guests = await api.listPool(this.#config.proxmox.pool, signal);
      const template = this.#choose(offer, guests, [], api.node, await this.#placing(offer)).template.vmid;
      // Read before the clone, so it is never newer than the clone's build. A
      // template replaced in between retires the guest later, which is safe.
      const build = await templateBuild(api, guests, template, signal);
      const tags = (state: string) => [TAG, install, state, templateTag(template), ...(build ? [`${BUILD}${build}`] : [])];
      vmid = await this.#clone(
        api,
        guests,
        template,
        WARM_HOSTNAME,
        `bb-box warm ${flavour}\ninstall ${this.#context.installId}`,
        async (id) => {
          this.#filling.set(id, template);
          claimed.push(id);
        },
        signal,
      );
      // At the template's size: a claim sets the box's.
      await api.configure(vmid, this.#settings(null, vmid), signal);
      await api.configure(vmid, { tags: tags(FILLING) }, signal);
      await api.start(vmid, signal);
      await this.#waitReady(vmid, offer.kind.id, this.#options.readyTimeoutMs ?? offer.kind.readyTimeoutMs, signal);
      if (offer.kind.capabilities.gpu) {
        const display = await this.#displayMode(vmid, offer.kind.id, this.#options.readyTimeoutMs ?? offer.kind.readyTimeoutMs, signal);
        await this.#sawDisplay(template, display);
        if (display.mode !== "gpu") {
          this.#avoidGpu(this.#gpuOf(template));
          throw new Error(`A warm linux-desktop box started without GPU ${this.#gpuOf(template) ?? "unknown"} (${display.reason || "no reason given"}), so bb-box released it.`);
        }
      }
      await api.configure(vmid, { tags: tags(WARM) }, signal);
    } catch (error) {
      if (vmid !== null) {
        await this.#forget(vmid);
        await api.destroy(vmid).catch((cause) => this.#context.logError("release a failed warm box", cause));
      }
      throw error;
    } finally {
      for (const id of claimed) this.#filling.delete(id);
    }
  }
}

/** Warm guests, as the shared ready pool sees them. Membership is the "warm" tag. */
class WarmStore implements PoolStore<BoxIdentity> {
  readonly #backend: ProxmoxLxcBackend;
  readonly #pool: string;
  /** The template of each warm guest, as last listed. */
  readonly #templates = new Map<string, number>();
  /** The size of each warm guest, as last listed. */
  readonly #sizes = new Map<string, BoxSize>();
  /** The build of each warm guest's template, which is its own, as last listed. */
  readonly #builds = new Map<string, string>();

  constructor(backend: ProxmoxLxcBackend, pool: string) {
    this.#backend = backend;
    this.#pool = pool;
  }

  async members(signal?: AbortSignal): Promise<PoolMember[]> {
    const api = await this.#backend.client();
    const members: PoolMember[] = [];
    this.#templates.clear();
    this.#sizes.clear();
    this.#builds.clear();
    const guests = await api.listPool(this.#pool, signal);
    const builds = await this.#backend.templateBuilds(api, guests, signal);
    for (const guest of guests) {
      const warm = this.#backend.warmOf(guest, builds);
      if (!warm || guest.status !== "running") continue;
      this.#templates.set(String(guest.vmid), warm.template);
      const build = builds.get(warm.template);
      if (build) this.#builds.set(String(guest.vmid), build);
      if (guest.size) this.#sizes.set(String(guest.vmid), guest.size);
      members.push({
        ref: String(guest.vmid),
        host: guest.node || api.node,
        kinds: FLAVOUR_KINDS[warm.flavour],
        state: "free",
        reason: null,
        since: 0,
        generation: 0,
      });
    }
    return members;
  }

  templateOf(ref: string): number | null {
    return this.#templates.get(ref) ?? null;
  }

  buildOf(ref: string): string | null {
    return this.#builds.get(ref) ?? null;
  }

  sizeOf(ref: string): BoxSize | null {
    return this.#sizes.get(ref) ?? null;
  }

  hold(member: PoolMember, box: BoxIdentity, signal?: AbortSignal): Promise<void> {
    return this.#backend.hold(member, box, this.templateOf(member.ref), signal);
  }
}
