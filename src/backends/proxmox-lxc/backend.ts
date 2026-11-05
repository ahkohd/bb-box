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

import { randomBytes } from "node:crypto";
import { SPARES } from "../../core/boxes.ts";
import { LOW, START_CPUUNITS, START_TAG, startsLow, withStartTag } from "../proxmox/start-weight.ts";
import type { CheckId } from "../../core/checks.ts";
import { ReadyPool, type PoolStore } from "../pool.ts";
import { Upkeep } from "../warm.ts";
import { Proxmox, ProxmoxError, parseTags, rootDiskGiB, type FetchLike, type GuestSettings, type PoolGuest, type StorageStatus } from "../proxmox/api.ts";
import { poolPrivileges, snapshotsCheck, type GuestDiskStorage } from "../proxmox/snapshots.ts";
import { withDesktopForkSafety } from "../../core/identity.ts";
import { forkCapacityWords } from "../../core/snapshot-refusals.ts";
import { offersGpuPart } from "../../core/gpu.ts";
import { ProxmoxSnapshotting, cloneWaitMs, storageOfVolume, storagesMetadata, type KeptGuest } from "../proxmox/snapshotting.ts";
import { armFork, disarm, disarmFork, forkByFullClone, type ForkWrites } from "../proxmox/forks.ts";
import { NoLongerOurs, OwnedGuests, boxOwner, carriesAnother, copyOwner, describedOwner, eitherOwner, imageOwner, madeOwner, sameDescription, templateOwner, unstampedOwner, warmOwner, type GuestOwner, type PowerAction } from "./owned.ts";
import { EARLIER_GUEST, copyName, copyTags, heldCopyDescription, heldCopyTags, isEarlierGuest, isHeldCopy, macOf, netKeys, netWith, randomMac, untilTemplate, withKeptTag } from "../proxmox/copies.ts";
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
import { proxmoxFetch, proxmoxHttp, type ProxmoxHttp } from "../proxmox/tls.ts";
import {
  BackendError,
  type AcquireHooks,
  type Backend,
  type BackendContext,
  type BackendImages,
  type Footprint,
  type BoxIdentity,
  type BoxKind,
  type CardClaim,
  type GpuHandoff,
  type GpuPart,
  type GpuRestoreFacts,
  type MachineSize,
  type BoxTransports,
  type Capacity,
  type ResizePlan,
  type Resizing,
  type CommandCapability,
  type ComputerUse,
  type DoctorCheck,
  type DoctorReport,
  type GpuMarkRequest,
  type GpuMarking,
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
  type BoxOwner,
  type HeldSnapshot,
  type SnapshotHooks,
  type SnapshotPlan,
  type SnapshotRef,
  type SnapshotTake,
  type SnapshotTaken,
  type Snapshotting,
  type OutsideRollback,
  type TaskKind,
  type CopyHooks,
  SnapshotFailed,
  type CopyPlan,
  type CopyState,
  type GuestIdentity,
  type HeldCopyLabel,
  type Started,
  type TaskOutcome,
  type TaskRef,
  type WarmShortfall,
  type IdentitySource,
  type ForkArming,
} from "../types.ts";
import { sizesCheck } from "../fit.ts";
import { currentKindId } from "../kinds.ts";
import { GPU_HELPER_CLOCK_AHEAD_MS, GPU_HELPER_FRESH_MS, STOPS_ONLY_UNTESTED_FROM, atLeast, judgeGpuHelper, parseGpuHelper } from "./gpu-helper.ts";
import { isOurGuest, lookAtEach, markGpus, type MarkingSetup } from "./gpu-mark.ts";
import { answerTo, cardName, claimMarkerOf, deviceSetOf, gpuDeviceLines, judgeGpuMigration, linesDiffer, linesFor, markerOf, markerTag, NO_HELPER_LINES, parseHelperLines, pendingDeviceChange, rawGpuLines, reportedDriver, withGpuTagsOf, withMarker, type ClaimMarker, type HelperCard, type HelperLines, type HelperPower, type LedgerClaim, type MarkAnswer } from "./gpu-marking.ts";
import {
  ANSWER_POLL_MS,
  ANSWER_WAIT_MS,
  cardUuid,
  cardsView,
  claimOf,
  nextGeneration,
  notAnsweredWords,
  outstandingRequests,
  placeShared,
  refusalWords,
  reservationsOn,
  settleOutstanding,
  underCardLock,
  waitForAnswer,
  type Answering,
  type CardsView,
  type OwnGuest,
  type Placed,
  type Reservation,
  loadOf,
} from "./gpu-claims.ts";
import {
  CARD_CHECK_COMMAND,
  CARD_CHECK_EVERY_MS,
  CARDS_SEEN_COMMAND,
  SERVER_GPU_MIB,
  cardFactWords,
  cardsSeenIn,
  judgeCardCheck,
  noCardRoomRefusal,
  serverRefusal,
  templateUserspace,
  type CardCheck,
  type Refusal,
} from "./gpu-servers.ts";
import { judgeImage, recordFromJson, recordInDescription, type PinSet } from "../images.ts";
import { CURSOR_HELPER, GPU_VIDEO_MARKER, ImageFile, SELKIES_DISPLAY, followPointer, SelkiesPresence, WAYLAND_SELKIES_DISPLAY, selkiesDisplay } from "../selkies.ts";
import { pause, waitForPort, waitUntilAnswers, type PortCheck } from "../../transports/ready.ts";
import { quote } from "../../transports/process.ts";
import { KeyFile, Ssh, SshTransport, publicKey } from "../../transports/ssh.ts";
import { MIN_DESKTOP, type BoxPointer, type Display, type DisplaySize, type SshAccess } from "../../transports/types.ts";
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
import { restartWayvnc, wayvncAttached, waylandPointer } from "../wayvnc.ts";
import { storedKeyPair } from "../ssh-key.ts";

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
const VM_BOOT_SCRIPT = "/usr/local/sbin/bb-box-boot";
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
const RETAG_TRIES = 5;
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
    capabilities: { os: "linux", arch: "x86_64", gpu: false, features: ["docker"], command: SSH_COMMAND, displays: [], computerUse: null, enrol: true, device: null },
    readyTimeoutMs: READY_TIMEOUT_MS,
    gpuParts: ["none", "shared"],
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
      // Video with NVENC (#863), by choice: a box of an image built before has none.
      displays: [{ id: "desktop", protocol: "rfb", resizable: true }, { ...SELKIES_DISPLAY, byChoice: true }],
      computerUse: CUA_DRIVER,
      enrol: true,
      device: null,
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
      device: null,
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
      device: null,
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
const GPU_HELPER: Check = ["proxmox.gpu-helper", "Host's GPU helper"];
const GPU_MIGRATION: Check = ["proxmox.gpu-migration", "Markers on GPU guests"];
const GPU_CARDS: Check = ["proxmox.gpu-cards", "Boxes on their cards"];
const SNAPSHOTS: Check = ["proxmox.snapshots", "Snapshots"];
const SSH_KEY_CHECK: Check = ["ssh.key", "SSH key"];

function powerOf(status: string): PowerState {
  if (status === "running") return "running";
  if (status === "stopped") return "stopped";
  return "unknown";
}

/** A linux-desktop box got no GPU, and no other GPU can take it. */
function noGpu(failed: ReadonlyMap<string, string>, why: string, server = false): BackendError {
  const reasons = [...failed].map(([gpu, reason]) => `GPU ${gpu}: ${reason}`).join("; ");
  if (server) return new BackendError("no_capacity", `The box did not get its card, so bb-box released it (${reasons}). ${why} Try again later, or ask for gpu none.`);
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
function sizeOf(config: Record<string, unknown>): MachineSize | null {
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
  /** Where a Wayland box's image has bb-box-cursor, instead of CURSOR_HELPER: a file the test finds, in tests. */
  readonly cursorHelper?: string;
  /** Where a GPU desktop's image has what gives it video, instead of GPU_VIDEO_MARKER: a file the test finds, in tests. */
  readonly gpuVideoMarker?: string;
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
  return `[ "$(hostname)" = ${quote(from)} ] || exit 0\n${renameInside(quote(from), name, etc, auth)}`;
}

export function vmNameScript(name: string, etc = "/etc", auth = DISPLAY_AUTH_FILE, marker = VM_BOOT_SCRIPT): string {
  return `[ -x ${quote(marker)} ] || exit 0\nfrom=$(hostname)\n[ "$from" != ${quote(name)} ] || exit 0\n${renameInside('"$from"', name, etc, auth)}`;
}

function renameInside(from: string, name: string, etc: string, auth: string): string {
  return String.raw`sudo -n sh -s -- ${quote(name)} ${quote(etc)} ${from} <<'NAME' || exit
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
type Pending = { readonly kind: string; readonly size: MachineSize };

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
  readonly agentProblem?: string | null;
}

interface CardMismatch {
  readonly card: string;
  readonly seen: readonly string[];
  readonly at: number;
}

function refusedChoice(template: LxcTemplate, refusal: Refusal): Choice {
  return { template, gpus: null, problem: refusal.person, agentProblem: refusal.agent };
}

function sentenceStart(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1).replace(/\.$/, "");
}

function forkOfDesktopWithNoCard(offer: Offer): Offer {
  return { ...offer, kind: { ...offer.kind, capabilities: { ...offer.kind.capabilities, gpu: false } } };
}

function gpuPartOf(offer: Offer, size: { readonly gpu?: GpuPart } | null): GpuPart {
  return size?.gpu ?? (offer.kind.capabilities.gpu ? "shared" : "none");
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
const REBUILD: Readonly<Record<LxcFlavour, (vmid: number, gpu: string | null) => string>> = {
  linux: (vmid) => `linux ${vmid}`,
  desktop: (vmid, gpu) => (gpu ? `desktop ${vmid} --gpu <its GPU's PCI address>` : `desktop ${vmid}`),
  "desktop-cpu": (vmid) => `desktop ${vmid} --cpu`,
  "desktop-wayland-cpu": (vmid) => `desktop ${vmid} --wayland`,
};

const NO_GPUS: ReadonlySet<string> = new Set();

const NO_CARDS: CardsView = { is: "none" };

interface NewPlacement {
  readonly card: HelperCard;
  readonly template: LxcTemplate;
  readonly reservation: Reservation;
  readonly lines: HelperLines;
}

interface StartGate {
  readonly claim: CardClaim | null;
  readonly reservation: Reservation | null;
  readonly gpu: string | null;
}

const UNGATED: StartGate = { claim: null, reservation: null, gpu: null };

interface HeldClaim {
  readonly part: GpuPart;
  readonly card: string | null;
  readonly generation: number;
}

const NO_CLAIM: HeldClaim = { part: "none", card: null, generation: 0 };

interface CardPin {
  readonly part: GpuPart;
  readonly card: string;
  readonly node: string;
  readonly reservation: Reservation | null;
}

function ledgerBoxOf(install: string, box: string): string {
  return `${install}/${box}`;
}

function grantedAs(claim: LedgerClaim | null, marker: ClaimMarker): boolean {
  return claim?.answer === "granted" && claim.generation === marker.generation && claim.part === marker.part && (claim.card ?? null) === (marker.card ?? null);
}

function startsAtBoot(config: Readonly<Record<string, unknown>>): boolean {
  return config.onboot === 1 || config.onboot === "1" || config.onboot === true;
}

function carriesNoCard(config: Readonly<Record<string, unknown>>): boolean {
  return (claimMarkerOf(parseTags(config.tags))?.part ?? "none") === "none" && !gpuDeviceLines(config).length;
}

const POWER_ON_THE_NODE_FROM = [0, 4, 0];
const WARM_BOUND_FROM = [0, 4, 1];
const POWER_NODES = "gpu-helper-power";
const UNSTARTED = "unstarted-clones";

interface PowerNode {
  readonly version: string;
  readonly seen: string;
}
const POWER_WAIT_MS = 120_000;
const DELETED_UNANSWERED_MS = 5_000;
const POWER_TAG = /^bb-power\.(start|stop|shutdown|delete)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.g\d+\.n[0-9a-f]{8,32}$/;

function powerBox(config: Record<string, unknown>, helper: string): string | null {
  const description = typeof config.description === "string" ? config.description : "";
  const tags = parseTags(config.tags);
  if (!description.startsWith("bb-box ") || /^bb-box install \S+ box \S+ held copy of snapshot /.test(description)) return null;
  if (tags.includes("held-copy") || tags.includes(EARLIER_GUEST) || /^earlier guest$/m.test(description) || !/^install \S+$/m.test(description)) return null;
  const box = /^box (\S+)$/m.exec(description)?.[1];
  if (box) return box;
  const warm = /^bb-box warm \S+$/m.test(description) ? /^warm ([0-9a-f]+)$/m.exec(description)?.[1] : undefined;
  return warm && atLeast(helper, WARM_BOUND_FROM) ? `warm-${warm}` : null;
}


const POWER_REFUSALS: Readonly<Record<string, string>> = {
  "not-the-box": "the guest at that VMID is not the box bb-box asked for",
  generation: "its GPU marker changed meanwhile",
  withdrawn: "the request was gone when the helper read the guest under its lock",
  "no-claim": "the helper holds no granted claim for its GPU marker",
  lines: "its device lines are not its claim's card's",
  "whole-taken": "another guest holds its card whole",
  unreadable: "a guest whose config cannot be read may hold its card",
  "no-cards": "the helper has no full reading of the cards",
  "unknown-card": "the helper does not list its card",
  "card-nodes": "the helper could not find its card's device nodes",
  "card-busy": "another guest is running on its card, and one of the two holds or claims the card whole",
  unsettled: "a guest the helper's lost ledger left unresolved may hold its card",
  pending: "a device change is pending, which a start would apply",
  untested: "the helper was not tested on this node's pve-container, so it only stops guests on it",
  running: "it is running",
  template: "it is a template",
  "not-served": "its pool is not one the helper serves",
  "not-bb-box": "its description names no bb-box install",
  failed: "Proxmox's own call failed",
};

function powerWords(answer: HelperPower): string {
  const why = POWER_REFUSALS[answer.reason ?? ""] ?? `the helper's reason was ${answer.reason ?? "none"}`;
  return answer.detail ? `${why} (${answer.detail})` : why;
}

function blockedWords(view: Extract<CardsView, { is: "blocked" }>): string {
  return `bb-box cannot claim a card for a GPU desktop now. ${view.why}${view.fix ? ` ${view.fix}` : ""}`;
}

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
  readonly #http: ProxmoxHttp;
  readonly #keyFile = new KeyFile();
  /** Whether each Wayland box's image has Selkies (060). */
  readonly #selkies: SelkiesPresence;
  /** Whether each GPU desktop's image has video with NVENC (#863). */
  readonly #gpuVideo: ImageFile;
  /** Whether each Wayland box's image has bb-box-cursor (060). */
  readonly #cursor: ImageFile;
  readonly #cursorHelper: string;
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
    await this.#checkCards(signal).catch((error) => signal.aborted || this.#context.logError("check boxes' cards", error));
    await this.#topUp(signal);
  });
  /** Image boxes (049) from before their clone until their capture or removal, which no sweep counts. */
  readonly #imageBoxes = new Set<number>();
  readonly #sightings = new Map<number, { readonly words: string; readonly at: number }>();
  #powerNodes: Record<string, PowerNode> | undefined;
  #unstarted: Record<string, Record<string, string>> | undefined;
  #settling: Promise<void> | null = null;
  readonly #written = new Map<number, number>();
  readonly #forkGpu = new Map<string, { readonly part: GpuPart; readonly card: string | null; readonly reservation: Reservation | null; readonly node: string }>();
  readonly #pins = new Map<string, CardPin>();
  readonly #mismatches = new Map<number, CardMismatch>();
  #cardsCheckedAt = 0;
  readonly #snapshots: ProxmoxSnapshotting;

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
    this.#gpuVideo = new ImageFile(options.gpuVideoMarker ?? GPU_VIDEO_MARKER, "-e");
    this.#cursorHelper = options.cursorHelper ?? CURSOR_HELPER;
    this.#cursor = new ImageFile(this.#cursorHelper);
    this.#http = options.fetch
      ? proxmoxHttp(options.fetch)
      : proxmoxFetch({ ca: config.proxmox.caCertificate, fingerprint: config.proxmox.tlsFingerprint });
    this.label = `Proxmox LXC on ${config.proxmox.node ?? new URL(config.proxmox.apiUrl).hostname}`;
    this.hosts = [config.proxmox.node ?? new URL(config.proxmox.apiUrl).hostname];
    this.#warmStore = new WarmStore(this, config.proxmox.pool);
    this.#warm = new ReadyPool(this.#warmStore);
    this.#snapshots = new ProxmoxSnapshotting(
      {
        label: this.label,
        type: "lxc",
        installId: context.installId,
        pool: config.proxmox.pool,
        tokenUser: config.proxmox.tokenId.split("!")[0] || null,
        client: () => this.client(),
        vmid: (guest) => this.#vmid(guest),
        ownConfig: (api, guest, signal) => this.#ownConfig(api, guest, signal),
        still: (api, guest, signal) => this.#still(api, guest, signal),
        rootDisk: () => "rootfs",
        disks: (config) => Object.keys(config).filter((key) => (key === "rootfs" || /^mp\d+$/.test(key)) && storageOfVolume(config[key]) !== null),
        guests: (api, signal) => this.#boxGuests(api, signal),
        copies: (api, signal) => this.#keptGuests(api, signal),
        freeVmids: async (api, signal) => ({ free: this.#freeCount(await api.listPool(this.#config.proxmox.pool, signal)), range: `from ${this.#config.vmids.first} to ${this.#config.vmids.last}` }),
        sizeOf: (config) => sizeOf(config),
      },
      ["disk"],
    );
  }

  identitySource(kind: string): IdentitySource | null {
    return this.#offers().some((offer) => offer.kind.id === kind) ? "eth" : null;
  }

  snapshotting(kind: string): Snapshotting | null {
    return this.#offers().some((offer) => offer.kind.id === kind) ? withDesktopForkSafety(kind, this.#snapshots.offer()) : null;
  }

  async planSnapshots(guest: Guest, kind: string, snapshot: SnapshotRef | null, signal?: AbortSignal): Promise<SnapshotPlan> {
    this.#offer(kind);
    return this.#snapshots.plan(guest, signal, snapshot);
  }

  snapshot(guest: Guest, take: SnapshotTake, hooks: SnapshotHooks, signal?: AbortSignal): Promise<SnapshotTaken> {
    return this.#snapshots.take(guest, take, hooks, signal);
  }

  deleteSnapshot(ref: SnapshotRef, hooks: SnapshotHooks, signal?: AbortSignal): Promise<void> {
    return this.#snapshots.delete(ref, hooks, signal);
  }

  heldSnapshots(signal?: AbortSignal): Promise<readonly HeldSnapshot[]> {
    return this.#snapshots.held(signal);
  }

  snapshotsOn(guest: Guest, signal?: AbortSignal): Promise<readonly HeldSnapshot[]> {
    return this.#snapshots.on(guest, signal);
  }

  providerTask(task: TaskRef, signal?: AbortSignal): Promise<TaskOutcome> {
    return this.#snapshots.task(task, signal);
  }

  findTasks(guest: Guest, operation: TaskKind, since: number, signal?: AbortSignal): Promise<readonly TaskRef[]> {
    return this.#snapshots.findTasks(guest, operation, since, signal);
  }

  rollbackSnapshot(guest: Guest, ref: SnapshotRef, hooks: SnapshotHooks, signal?: AbortSignal): Promise<void> {
    return this.#snapshots.rollback(guest, ref, hooks, signal);
  }

  outsideRollbacks(since: number, signal?: AbortSignal): Promise<readonly OutsideRollback[]> {
    return this.#snapshots.outsideRollbacks(since, signal);
  }

  async powerOff(guest: Guest, signal?: AbortSignal): Promise<void> {
    const vmid = this.#vmid(guest);
    const api = await this.client();
    const status = (await this.#still(api, guest, signal)) ? await api.status(vmid, signal) : null;
    if (!status) throw gone(vmid);
    await this.#forget(vmid);
    if (status.status === "running") await this.#owned(api).stop(vmid, this.#boxOf(guest), signal);
    const key = this.#cardKey(api);
    await underCardLock(key, async () => reservationsOn(key).dropStopped(vmid));
  }

  guestIdentity(guest: Guest, signal?: AbortSignal): Promise<GuestIdentity> {
    return this.#identityOf(guest, signal);
  }

  async #ownOrCopyConfig(api: Proxmox, guest: Guest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const config = await this.#guestConfig(api, this.#vmid(guest), signal);
    if (config && isHeldCopy(parseTags(config.tags))) {
      const copy = await this.#copyConfig(api, guest, signal);
      if (!copy) throw gone(this.#vmid(guest));
      return copy;
    }
    return this.#ownConfig(api, guest, signal);
  }

  async #identityOf(guest: Guest, signal?: AbortSignal): Promise<GuestIdentity> {
    const api = await this.client();
    const config = await this.#ownOrCopyConfig(api, guest, signal);
    const macs: Record<string, string> = {};
    for (const key of netKeys(config)) {
      const mac = macOf(String(config[key]));
      if (mac) macs[key] = mac;
    }
    return { macs, smbios: null };
  }

  async #claimFree(api: Proxmox, signal?: AbortSignal, noneFree: (range: string) => Error = (range) => new SnapshotFailed(`Every VMID ${range} is in use, so bb-box has none for the copy a restore needs. Try again later, or ask the user to make room for the copy.`)): Promise<number> {
    if (this.#nextVmid === null) {
      const stored = await this.#context.storage.get<number>(NEXT_VMID);
      this.#nextVmid ??= typeof stored === "number" && this.#inRange(stored) ? stored : this.#config.vmids.first;
    }
    await this.#ownRange(api, signal);
    const vmid = this.#freeVmid(await api.listPool(this.#config.proxmox.pool, signal), this.#nextVmid);
    if (vmid === null) throw noneFree(`from ${this.#config.vmids.first} to ${this.#config.vmids.last}`);
    this.#reserved.add(vmid);
    this.#nextVmid = vmid === this.#config.vmids.last ? this.#config.vmids.first : vmid + 1;
    await this.#context.storage.set(NEXT_VMID, this.#nextVmid);
    return vmid;
  }

  async #fullClone(api: Proxmox, source: number, vmid: number, hostname: string, description: string, storage: string | null, hooks: CopyHooks, signal?: AbortSignal, snapshot?: string, diskGiB: number | null = null): Promise<void> {
    let upid: string;
    try {
      await hooks.submitting();
      upid = await api.startFullClone({ source, vmid, hostname, pool: this.#config.proxmox.pool, storage, description, ...(snapshot ? { snapshot } : {}) }, signal);
    } catch (error) {
      if (error instanceof ProxmoxError && error.status >= 400) throw new SnapshotFailed(`Proxmox refused to copy guest ${source}: ${error.message}`);
      throw error;
    }
    await hooks.task({ ref: upid, host: api.node });
    try {
      await api.waitTask(upid, signal, cloneWaitMs(diskGiB));
    } catch (error) {
      if (error instanceof ProxmoxError && error.method === "TASK" && error.status === 500) throw new SnapshotFailed(`Proxmox's copy of guest ${source} failed: ${error.message}`);
      throw error;
    }
  }

  async copyGuest(source: Guest, label: HeldCopyLabel, hooks: CopyHooks, signal?: AbortSignal): Promise<Guest> {
    const api = await this.client();
    const from = this.#vmid(source);
    const config = await this.#ownConfig(api, source, signal);
    if ((await api.status(from, signal))?.status === "running") throw new SnapshotFailed(`Guest ${from} is running, and bb-box copies a guest only once it has stopped.`);
    const template = typeof source.data?.template === "number" ? source.data.template : null;
    const vmid = await this.#claimFree(api, signal);
    try {
      const copy = this.#guest(api.node, vmid, template, label.box);
      await hooks.claimed(copy);
      await this.#fullClone(api, from, vmid, copyName(vmid), heldCopyDescription(this.#context.installId, label), storageOfVolume(config.rootfs), hooks, signal, undefined, sizeOf(config)?.diskGiB ?? null);
      const owner = copyOwner(this.#context.installId, label.box);
      await disarm(this.#writesFor(api, owner), vmid, signal);
      const cloned = (await api.config(vmid, signal)) ?? {};
      const none = await this.#noneFor(api, vmid, cloned, signal);
      const tags = heldCopyTags(this.#context.installId, label, this.#now(), template);
      await this.#owned(api).configure(vmid, owner, { tags: none ? withMarker(tags, none.marker) : tags, onboot: false }, signal);
      if (none?.wait) await this.#askMarker(api, vmid, none.marker, signal);
      return copy;
    } finally {
      this.#reserved.delete(vmid);
    }
  }

  async copySnapshot(ref: SnapshotRef, label: HeldCopyLabel, hooks: CopyHooks, signal?: AbortSignal): Promise<Guest> {
    const api = await this.client();
    const from = this.#vmid(ref.guest);
    const config = await this.#ownOrCopyConfig(api, ref.guest, signal);
    const template = typeof ref.guest.data?.template === "number" ? ref.guest.data.template : null;
    const vmid = await this.#claimFree(api, signal, (range) => new SnapshotFailed(`Every VMID ${range} is in use, so bb-box has none for the held copy. Try again later, or ask the user to make room for the copy.`));
    try {
      const copy = this.#guest(api.node, vmid, template, label.box);
      await hooks.claimed(copy);
      await this.#fullClone(api, from, vmid, copyName(vmid), heldCopyDescription(this.#context.installId, label), storageOfVolume(config.rootfs), hooks, signal, ref.ref, sizeOf(config)?.diskGiB ?? null);
      return await this.labelCopy(copy, label, signal);
    } finally {
      this.#reserved.delete(vmid);
    }
  }

  async labelCopy(copy: Guest, label: HeldCopyLabel, signal?: AbortSignal): Promise<Guest> {
    const api = await this.client();
    const vmid = this.#vmid(copy);
    const config = await this.#copyConfig(api, copy, signal);
    if (!config) throw gone(vmid);
    const madeFor = `bb-box install ${this.#context.installId} box ${label.box} held copy of snapshot ${label.snapshot}`;
    if (!String(config.description ?? "").startsWith(madeFor)) throw new SnapshotFailed(`Guest ${vmid} is not the copy bb-box made of snapshot ${label.snapshot}, so bb-box does not label it as one.`);
    const template = typeof copy.data?.template === "number" ? copy.data.template : null;
    const owner = copyOwner(this.#context.installId, this.#boxData(copy));
    await disarm(this.#writesFor(api, owner), vmid, signal);
    const none = await this.#noneFor(api, vmid, config, signal);
    const tags = heldCopyTags(this.#context.installId, label, this.#now(), template);
    await this.#owned(api).configure(vmid, owner, { tags: none ? withMarker(tags, none.marker) : tags, onboot: false, delete: ["protection"] }, signal);
    if (none?.wait) await this.#askMarker(api, vmid, none.marker, signal);
    return { ...copy, size: sizeOf(await api.config(vmid, signal)) };
  }

  async copyPlan(copy: Guest, signal?: AbortSignal): Promise<CopyPlan> {
    const api = await this.client();
    const config = await this.#copyConfig(api, copy, signal);
    if (!config) return { state: "gone", size: null, running: false };
    const running = (await api.status(this.#vmid(copy), signal))?.status === "running";
    return { state: isTemplate(config) && isHeldCopy(parseTags(config.tags)) ? "template" : "copy", size: sizeOf(config), running };
  }

  async labelKept(ref: SnapshotRef, kept: string | null, signal?: AbortSignal): Promise<void> {
    if (ref.from !== "held-copy") return this.#snapshots.labelKept(ref, kept, signal);
    const api = await this.client();
    const vmid = this.#vmid(ref.guest);
    const config = await this.#copyConfig(api, ref.guest, signal);
    if (!config) throw gone(vmid);
    const tags = parseTags(config.tags);
    const box = copyTags(tags).box ?? (typeof ref.guest.data?.box === "string" ? ref.guest.data.box : "");
    try {
      await this.#owned(api).configure(vmid, copyOwner(this.#context.installId, this.#boxData(ref.guest)), { tags: withKeptTag(tags, kept), description: heldCopyDescription(this.#context.installId, { box, snapshot: ref.id, kept }) }, signal);
    } catch (error) {
      if (error instanceof ProxmoxError && error.status >= 400) throw new SnapshotFailed(`Proxmox refused to write the keep date on held copy ${vmid}: ${error.message}`);
      throw error;
    }
  }

  async #copyConfig(api: Proxmox, copy: Guest, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    const config = await this.#guestConfig(api, this.#vmid(copy), signal);
    if (!config) return null;
    const tags = parseTags(config.tags);
    const names = namesOf(config);
    const box = typeof copy.data?.box === "string" ? copy.data.box : null;
    const ours = tags.includes(installTag(this.#context.installId)) && (copyTags(tags).box ?? names.box) === box;
    return ours ? config : null;
  }

  async disarmCopy(copy: Guest, signal?: AbortSignal): Promise<void> {
    const api = await this.client();
    const vmid = this.#vmid(copy);
    const config = await this.#copyConfig(api, copy, signal);
    if (!config) throw gone(vmid);
    const owner = copyOwner(this.#context.installId, this.#boxData(copy));
    await this.#owned(api).setNetwork(vmid, owner, (now) => Object.fromEntries(netKeys(now).map((key) => [key, netWith(String(now[key]), { up: false })])), signal);
    await this.#owned(api).configure(vmid, owner, { onboot: false }, signal);
  }

  async templateCopy(copy: Guest, signal?: AbortSignal): Promise<void> {
    const api = await this.client();
    const vmid = this.#vmid(copy);
    const config = await this.#copyConfig(api, copy, signal);
    if (!config) throw gone(vmid);
    if (!isTemplate(config)) await this.#owned(api).makeTemplate(vmid, copyOwner(this.#context.installId, this.#boxData(copy)), signal);
    await untilTemplate(() => this.#copyConfig(api, copy, signal), isTemplate, (ms) => (this.#options.sleep ?? pause)(ms, signal), TEMPLATE_POLL_MS, vmid);
  }

  async copyState(copy: Guest, signal?: AbortSignal): Promise<CopyState> {
    const api = await this.client();
    const config = await this.#copyConfig(api, copy, signal);
    if (!config) return "gone";
    return isTemplate(config) && isHeldCopy(parseTags(config.tags)) ? "template" : "copy";
  }

  async deleteCopy(copy: Guest, signal?: AbortSignal): Promise<void> {
    const api = await this.client();
    const config = await this.#copyConfig(api, copy, signal);
    if (!config) return;
    const tags = parseTags(config.tags);
    const box = typeof copy.data?.box === "string" ? copy.data.box : "";
    const described = typeof config.description === "string" && config.description.startsWith(`bb-box install ${this.#context.installId} box ${box} held copy of snapshot `);
    if (!isHeldCopy(tags) && !isEarlierGuest(tags) && !described) throw new SnapshotFailed(`Guest ${copy.ref} is not a held copy or an earlier guest of box ${box}, so bb-box does not delete it as one.`);
    await this.#forget(this.#vmid(copy));
    await this.#owned(api).destroy(this.#vmid(copy), copyOwner(this.#context.installId, this.#boxData(copy)), signal);
  }

  async adoptCopy(copy: Guest, box: BoxIdentity, identity: GuestIdentity, hooks: CopyHooks, signal?: AbortSignal): Promise<Guest> {
    const api = await this.client();
    const from = this.#vmid(copy);
    const config = await this.#copyConfig(api, copy, signal);
    if (!config || !isTemplate(config)) throw new SnapshotFailed(`Guest ${from} is not a held copy of box ${box.name} that bb-box can use.`);
    const template = typeof copy.data?.template === "number" ? copy.data.template : null;
    const vmid = await this.#claimFree(api, signal);
    try {
      const fresh = this.#guest(api.node, vmid, template, box.boxId);
      await hooks.claimed(fresh);
      await this.#fullClone(api, from, vmid, box.name, describe(box, this.#context.installId), storageOfVolume(config.rootfs), hooks, signal, undefined, sizeOf(config)?.diskGiB ?? null);
      const made = (await api.config(vmid, signal)) ?? {};
      const nets: Record<string, string> = {};
      for (const key of netKeys(made)) {
        const mac = identity.macs[key];
        const value = key === "net0" ? `${net0For(this.#config, vmid)}${mac ? `,hwaddr=${mac}` : ""}` : netWith(String(made[key]), { ...(mac ? { mac } : {}), up: true });
        nets[key] = value;
      }
      const owner = madeOwner(this.#context.installId, box.boxId);
      await this.#owned(api).setNetwork(vmid, owner, nets, signal);
      await this.#owned(api).configure(vmid, owner, { tags: boxTags(box, this.#context.installId, template), onboot: false, delete: ["protection"] }, signal);
      return { ...fresh, size: sizeOf(await api.config(vmid, signal)) };
    } finally {
      this.#reserved.delete(vmid);
    }
  }

  async #helperOrEmpty(api: Proxmox, signal?: AbortSignal): Promise<HelperLines> {
    return (await this.#helperLines(api, signal).catch(() => null)) ?? NO_HELPER_LINES;
  }

  async #askMarker(api: Proxmox, vmid: number, marker: ClaimMarker, signal?: AbortSignal): Promise<void> {
    const view = await this.#cardsView(api, signal);
    if (view.is === "none") return;
    const answer = await this.#askHelper(api, vmid, marker, signal);
    if (answer.is === "granted") return;
    const why = answer.is === "refused" ? answer.why : notAnsweredWords(api.node, answer);
    throw new SnapshotFailed(`The host's GPU helper on ${api.node} did not grant ${markerTag(marker)}: ${why}`);
  }

  async #writeClaim(api: Proxmox, vmid: number, owner: GuestOwner, marker: ClaimMarker, signal?: AbortSignal, also: GuestSettings = {}): Promise<void> {
    await this.#writeMarker(api, vmid, marker, owner, signal, also);
    await this.#askMarker(api, vmid, marker, signal);
  }

  async #noneFor(api: Proxmox, vmid: number, config: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<{ readonly marker: ClaimMarker; readonly wait: boolean } | null> {
    const marker = claimMarkerOf(parseTags(config.tags));
    const lines = gpuDeviceLines(config);
    if (!markerOf(parseTags(config.tags)) && !lines.length) return null;
    if (marker?.part === "none" && !lines.length) return { marker, wait: false };
    return { marker: await this.#nextClaim(api, vmid, "none", null, marker?.generation ?? 0, signal), wait: true };
  }

  async #nextClaim(api: Proxmox, vmid: number, part: GpuPart, card: string | null, onGuest: number, signal?: AbortSignal, boxId: string | null = null): Promise<ClaimMarker> {
    const lines = await this.#helperOrEmpty(api, signal);
    let generation = nextGeneration(lines, vmid, onGuest, this.#written.get(vmid) ?? 0);
    for (const written of this.#written.values()) generation = Math.max(generation, written + 1);
    const named = boxId === null ? null : ledgerBoxOf(this.#context.installId, boxId);
    for (const [other, entry] of lines.ledger) {
      if (other === vmid || named === null || entry.box !== named) continue;
      generation = Math.max(generation, entry.answered + 1, (entry.claim?.generation ?? 0) + 1);
    }
    return { part, card: part === "none" ? null : card, generation };
  }

  async #holdClaim(api: Proxmox, vmid: number, owner: GuestOwner, held: HeldClaim, boxId: string | null, signal?: AbortSignal, also: GuestSettings = {}): Promise<boolean> {
    const view = await this.#cardsView(api, signal);
    if (view.is === "none") return false;
    const marker = claimMarkerOf(parseTags((await api.config(vmid, signal)).tags));
    const card = held.part === "none" ? null : held.card;
    const entry = (view.is === "on" ? view.lines : await this.#helperOrEmpty(api, signal)).ledger.get(vmid);
    const asHeld = marker !== null && marker.part === held.part && marker.card === card && marker.generation >= held.generation;
    if (asHeld && grantedAs(entry?.claim ?? null, marker)) return false;
    if (asHeld && marker.generation > (entry?.answered ?? 0)) {
      await this.#askMarker(api, vmid, marker, signal);
      return false;
    }
    await this.#writeClaim(api, vmid, owner, await this.#nextClaim(api, vmid, held.part, card, Math.max(marker?.generation ?? 0, held.generation), signal, boxId), signal, also);
    return true;
  }

  async #linesMatch(api: Proxmox, vmid: number, held: HeldClaim, signal?: AbortSignal): Promise<void> {
    const view = await this.#cardsView(api, signal);
    if (view.is === "none") return;
    const config = await api.config(vmid, signal);
    const cards = (view.is === "on" ? view.lines : await this.#helperOrEmpty(api, signal)).cards;
    const card = held.part === "none" ? null : (cards.find((each) => each.uuid === held.card) ?? null);
    const wanted = held.part === "none" ? [] : card ? linesFor(card, deviceSetOf(parseTags(config.tags), typeof config.description === "string" ? config.description : "")) : null;
    const named = held.part === "none" ? "no card" : card ? cardName(card) : `card ${held.card}`;
    if (!wanted) throw new SnapshotFailed(`The host's GPU helper on ${api.node} lists no device nodes for ${named}, so bb-box cannot check CT ${vmid}'s lines against its claim.`);
    const { lacks, extra } = linesDiffer(gpuDeviceLines(config), wanted);
    if (!lacks.length && !extra.length) return;
    const wrong = [...(lacks.length ? [`it lacks ${lacks.join(", ")}`] : []), ...(extra.length ? [`it has ${extra.join(", ")}`] : [])].join(", and ");
    throw new SnapshotFailed(`CT ${vmid}'s device lines do not match its claim, ${named}, after the host's GPU helper granted it: ${wrong}.`);
  }

  async readGpuClaim(guest: Guest, signal?: AbortSignal): Promise<GpuHandoff | null> {
    const api = await this.client();
    const vmid = this.#vmid(guest);
    const lines = await this.#helperOrEmpty(api, signal);
    const claim = lines.ledger.get(vmid)?.claim ?? null;
    if (claim?.answer === "granted") {
      const index = lines.cards.find((card) => card.uuid === claim.card)?.index ?? null;
      return { part: claim.part, card: claim.part === "none" ? null : claim.card, generation: claim.generation, index };
    }
    const marker = claimMarkerOf(parseTags((await api.config(vmid, signal)).tags));
    if (marker) return { part: marker.part, card: marker.card, generation: marker.generation, index: null };
    return guest.claim ? { part: guest.claim.part, card: guest.claim.card, generation: guest.claim.generation, index: null } : null;
  }

  async keepGpuClaim(guest: Guest, held: GpuHandoff, signal?: AbortSignal): Promise<void> {
    const api = await this.client();
    const vmid = this.#vmid(guest);
    if (held.part === "none" && carriesNoCard(await api.config(vmid, signal))) return;
    await this.#holdClaim(api, vmid, this.#boxOf(guest), held, this.#boxData(guest), signal);
  }

  async bootsWithNode(guest: Guest, signal?: AbortSignal): Promise<boolean> {
    const api = await this.client();
    return startsAtBoot(await api.config(this.#vmid(guest), signal));
  }

  async releaseGpuClaim(guest: Guest, signal?: AbortSignal): Promise<void> {
    const api = await this.client();
    const vmid = this.#vmid(guest);
    const owner = this.#boxOf(guest);
    const config = await api.config(vmid, signal);
    const gpuGuest = markerOf(parseTags(config.tags)) !== null || gpuDeviceLines(config).length > 0;
    const written = gpuGuest && (await this.#holdClaim(api, vmid, owner, NO_CLAIM, this.#boxData(guest), signal, { onboot: false }));
    if (!written && startsAtBoot(await api.config(vmid, signal))) await this.#owned(api).configure(vmid, owner, { onboot: false }, signal);
  }

  async armReturned(guest: Guest, held: GpuHandoff, bootsWithNode: boolean | null, signal?: AbortSignal): Promise<void> {
    await this.#armWithClaim(guest, this.#boxOf(guest), held, bootsWithNode, signal);
  }

  async armAdopted(guest: Guest, held: GpuHandoff | null, bootsWithNode: boolean | null, signal?: AbortSignal): Promise<void> {
    await this.#armWithClaim(guest, madeOwner(this.#context.installId, this.#boxData(guest)), held, bootsWithNode ?? true, signal);
  }

  async #armWithClaim(guest: Guest, owner: GuestOwner, held: GpuHandoff | null, bootsWithNode: boolean | null, signal?: AbortSignal): Promise<void> {
    const api = await this.client();
    const vmid = this.#vmid(guest);
    const wanted = held ?? NO_CLAIM;
    if (wanted.part !== "none" || !carriesNoCard(await api.config(vmid, signal))) {
      await this.#holdClaim(api, vmid, owner, wanted, this.#boxData(guest), signal);
      await this.#linesMatch(api, vmid, wanted, signal);
    }
    if (bootsWithNode !== null) await this.#owned(api).configure(vmid, owner, { onboot: bootsWithNode }, signal);
  }

  async holdGpuCard(guest: Guest, held: GpuHandoff, signal?: AbortSignal): Promise<void> {
    const box = this.#boxData(guest);
    if (box === null || held.part === "none" || held.card === null) return;
    const kept = this.#pins.get(box);
    if (kept && kept.card === held.card && kept.part === held.part) return;
    this.dropGpuCard(box);
    const api = await this.client();
    const view = await this.#cardsView(api, signal);
    if (view.is === "none") return;
    if (view.is === "blocked") throw new BackendError("no_capacity", blockedWords(view));
    await this.#settled(api);
    const key = this.#cardKey(api);
    const vmid = this.#vmid(guest);
    const pin: CardPin = { part: held.part, card: held.card, node: key, reservation: null };
    const reservation = await underCardLock(key, async () => {
      const fresh = await this.#cardsView(api, signal);
      if (fresh.is !== "on") throw new BackendError("no_capacity", fresh.is === "blocked" ? blockedWords(fresh) : `The GPU helper's report on ${api.node} went while bb-box held box ${box}'s card.`);
      const refused = await this.#noRoomOn(api, fresh, pin, vmid, signal);
      if (refused) throw new BackendError("no_capacity", refused);
      return reservationsOn(key).add(held.card!, held.part, DESKTOP_GPU_MIB, box, null);
    });
    this.#pins.set(box, { ...pin, reservation });
  }

  dropGpuCard(boxId: string): void {
    const pin = this.#pins.get(boxId);
    this.#pins.delete(boxId);
    if (pin?.reservation) reservationsOn(pin.node).drop(pin.reservation);
  }

  async #noRoomOn(api: Proxmox, view: Extract<CardsView, { is: "on" }>, pin: CardPin, vmid: number, signal?: AbortSignal): Promise<string | null> {
    const card = view.lines.cards.find((each) => each.uuid === pin.card);
    if (!card) return `The GPU helper on ${api.node} no longer lists card ${pin.card}, which the box holds. A restore keeps a box on its card, so bb-box does not move it to another one.`;
    const reservations = reservationsOn(this.#cardKey(api));
    const ours = (await this.#ownGuests(api, signal)).filter((guest) => guest.vmid !== vmid);
    const input = {
      lines: view.lines,
      memory: view.memory,
      installId: this.#context.installId,
      reserved: reservations.live(view.lines, this.#now()).filter((reservation) => reservation !== pin.reservation),
      limit: pin.part === "whole" ? null : this.#config.desktop.perGpu,
      needMiB: 0,
      candidates: new Set([card.uuid]),
      prefer: card.uuid,
      vmid,
      outstanding: outstandingRequests(view.lines, ours, reservations.inFlight()),
      gone: reservations.gone(view.lines, this.#now()),
    };
    const placed = placeShared(input);
    if (placed.is === "placed") return null;
    const named = cardName(card);
    return `${named.charAt(0).toUpperCase()}${named.slice(1)}, which the box holds, cannot take it now: ${placed.reasons.join("; ")}. A restore keeps a box on its card, so bb-box does not move it to another one. Release another desktop box on ${named}, or try again later.`;
  }

  #pinOf(guest: Guest): CardPin | null {
    const box = this.#boxData(guest);
    return box === null ? null : (this.#pins.get(box) ?? null);
  }

  async #gateOnPin(api: Proxmox, vmid: number, owner: GuestOwner, guest: Guest, pin: CardPin, signal?: AbortSignal): Promise<StartGate> {
    const notStarted = (why: string) => new Error(`Container ${vmid} was not started: ${why} It is stopped, with its disk as it was.`);
    const marker = claimMarkerOf(parseTags((await this.#owned(api).read(vmid, owner, signal)).tags));
    if (!marker || marker.part !== pin.part || marker.card !== pin.card) {
      throw notStarted(`its GPU marker is ${marker ? markerTag(marker) : "missing"}, and the box holds ${pin.part} card ${pin.card}, which a restore keeps.`);
    }
    await this.#settled(api);
    const { view, granted, answer } = await this.#answered(api, vmid, marker, signal);
    if (!granted) throw notStarted(answer.is === "refused" ? `the host's GPU helper refused its marker ${markerTag(marker)}, as ${answer.why}.` : notAnsweredWords(api.node, answer));
    if (view.is !== "on") throw notStarted(view.is === "blocked" ? blockedWords(view) : `the GPU helper's report on ${api.node} went.`);
    const key = this.#cardKey(api);
    return underCardLock(key, async () => {
      const fresh = await this.#cardsView(api, signal);
      if (fresh.is !== "on") throw notStarted(fresh.is === "blocked" ? blockedWords(fresh) : `the GPU helper's report on ${api.node} went.`);
      const refused = await this.#noRoomOn(api, fresh, pin, vmid, signal);
      if (refused) throw notStarted(refused);
      const box = this.#boxData(guest);
      if (box !== null) this.#pins.delete(box);
      const reservation = pin.reservation ?? reservationsOn(key).add(pin.card, pin.part, DESKTOP_GPU_MIB, box, vmid);
      reservation.vmid = vmid;
      return { claim: claimOf(marker, "granted"), reservation, gpu: this.#gpuIdOf(marker.card, fresh.notes) };
    });
  }

  async gpuRestoreFacts(guest: Guest, signal?: AbortSignal): Promise<GpuRestoreFacts> {
    const api = await this.client();
    const view = await this.#cardsView(api, signal);
    const driver = view.is === "on" ? reportedDriver(view.notes) : ((await this.#hostNvidia())?.version ?? null);
    return { held: await this.readGpuClaim(guest, signal), driver };
  }

  async placeForkGpu(box: BoxIdentity, gpu: GpuPart, signal?: AbortSignal): Promise<void> {
    this.clearForkGpu(box.boxId);
    const desktop = currentKindId(box.kind) === "linux-desktop";
    if (gpu === "whole") throw new BackendError("no_capacity", `Not forked: a whole card is not offered for a fork yet. Fork it with gpu shared or none. bb-box copied nothing.`);
    if (gpu === "shared" && !desktop) throw new BackendError("unsupported", `A fork of a ${box.kind} box takes gpu none. Fork it with gpu none. bb-box copied nothing.`);
    if (gpu === "none") {
      if (desktop) this.#forkGpu.set(box.boxId, { part: "none", card: null, reservation: null, node: "" });
      return;
    }
    const api = await this.client();
    const offer = this.#offers().find((candidate) => candidate.flavour === "desktop");
    if (!offer) throw new BackendError("unsupported", `Not forked: ${api.node} has no GPU desktop to place a fork on. Fork it with gpu none. bb-box copied nothing.`);
    try {
      const placed = await this.#placeNew(api, offer, box.boxId, new Set(), new Set(), signal);
      this.#forkGpu.set(box.boxId, { part: "shared", card: placed.card.uuid, reservation: placed.reservation, node: this.#cardKey(api) });
    } catch (error) {
      const words = error instanceof Error ? error.message : String(error);
      throw new BackendError("no_capacity", forkCapacityWords(words, gpu));
    }
  }

  clearForkGpu(boxId: string): void {
    const plan = this.#forkGpu.get(boxId);
    this.#forkGpu.delete(boxId);
    if (plan?.reservation) reservationsOn(plan.node).drop(plan.reservation);
  }

  async forkSnapshot(ref: SnapshotRef, box: BoxIdentity, previous: Guest | null, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest> {
    this.#offer(box.kind);
    return forkByFullClone(
      {
        installId: this.#context.installId,
        pool: this.#config.proxmox.pool,
        client: () => this.client(),
        vmid: (guest) => this.#vmid(guest),
        ownConfig: (api, guest, signal) => this.#ownConfig(api, guest, signal),
        sourceConfig: (api, guest, signal) => this.#ownOrCopyConfig(api, guest, signal),
        rootDisk: () => "rootfs",
        claimVmid: (api, signal) => this.#claimFree(api, signal, (range) => new BackendError("no_capacity", `Not forked: every VMID ${range} is in use, so bb-box has none for the fork. Try again later, or ask the user. bb-box copied nothing.`)),
        unreserve: (vmid) => this.#reserved.delete(vmid),
        forget: (vmid) => this.#forget(vmid),
        guest: (node, vmid, template, boxId, build) => this.#guest(node, vmid, template, boxId, null, null, build, null),
        addressed: async (api, vmid, made, forked, template, signal) => {
          const nets: Record<string, string> = { net0: `${net0For(this.#config, vmid)},hwaddr=${randomMac()},link_down=1` };
          for (const key of netKeys(made)) if (key !== "net0") nets[key] = netWith(String(made[key]), { mac: randomMac(), up: false });
          const owner = madeOwner(this.#context.installId, forked.boxId);
          await this.#owned(api).setNetwork(vmid, owner, nets, signal);
          const plan = this.#forkGpu.get(forked.boxId);
          const onGuest = claimMarkerOf(parseTags(made.tags))?.generation ?? 0;
          const marker = plan ? await this.#nextClaim(api, vmid, plan.part, plan.card, onGuest, signal) : null;
          const tags = marker ? withMarker(boxTags(forked, this.#context.installId, template), marker) : boxTags(forked, this.#context.installId, template);
          await this.#owned(api).configure(vmid, owner, { cores: forked.size.cores, memory: forked.size.memoryMiB, tags, onboot: false, delete: ["protection"] }, signal);
          if (marker) {
            await this.#askMarker(api, vmid, marker, signal);
            if (plan?.reservation) {
              plan.reservation.vmid = vmid;
              reservationsOn(plan.node).settle(plan.reservation, this.#now());
            }
            this.#forkGpu.delete(forked.boxId);
          }
        },
        writes: (api, box, made) => this.#writesFor(api, made ? madeOwner(this.#context.installId, box) : boxOwner(this.#context.installId, box)),
        sizeOf,
        logError: (operation, error) => this.#context.logError(operation, error),
      },
      ref,
      box,
      previous,
      hooks,
      signal,
    );
  }

  boxAddresses(): readonly string[] {
    return this.#config.network.addresses;
  }

  armFork(guest: Guest, arming: ForkArming, signal?: AbortSignal): Promise<void> {
    return armFork({ client: () => this.client(), vmid: (each) => this.#vmid(each), ownConfig: (api, each, signal) => this.#ownConfig(api, each, signal), writes: (api, box, made) => this.#writesFor(api, made ? madeOwner(this.#context.installId, box) : boxOwner(this.#context.installId, box)) }, guest, arming, signal);
  }

  disarmFork(guest: Guest, signal?: AbortSignal): Promise<void> {
    return disarmFork({ client: () => this.client(), vmid: (each) => this.#vmid(each), installId: this.#context.installId, writes: (api, box, made) => this.#writesFor(api, made ? madeOwner(this.#context.installId, box) : boxOwner(this.#context.installId, box)) }, guest, signal);
  }

  async retireGuest(guest: Guest, box: BoxIdentity, signal?: AbortSignal): Promise<Guest> {
    const api = await this.client();
    const vmid = this.#vmid(guest);
    const config = await this.#copyConfig(api, guest, signal);
    if (!config) throw gone(vmid);
    await this.#forget(vmid);
    const owner = copyOwner(this.#context.installId, this.#boxData(guest));
    await this.#owned(api).setNetwork(vmid, owner, (now) => Object.fromEntries(netKeys(now).map((key) => [key, netWith(String(now[key]), { mac: randomMac(), up: false })])), signal);
    const template = typeof guest.data?.template === "number" ? guest.data.template : null;
    const kept = claimMarkerOf(parseTags(config.tags));
    const lines = gpuDeviceLines(config);
    const none = kept?.part === "none" && !lines.length ? kept : kept || lines.length ? await this.#nextClaim(api, vmid, "none", null, kept?.generation ?? 0, signal) : null;
    const tags = [...boxTags(box, this.#context.installId, template), EARLIER_GUEST];
    await this.#owned(api).configure(vmid, owner, { onboot: false, tags: none ? withMarker(tags, none) : tags, description: `${describe(box, this.#context.installId)}\nearlier guest` }, signal);
    if (none && none !== kept) await this.#askMarker(api, vmid, none, signal);
    return guest;
  }

  async #keptGuests(api: Proxmox, signal?: AbortSignal): Promise<KeptGuest[]> {
    const install = installTag(this.#context.installId);
    return (await api.listPool(this.#config.proxmox.pool, signal))
      .filter((guest) => guest.type === "lxc" && this.#inRange(guest.vmid) && guest.tags.includes(install) && (isHeldCopy(guest.tags) || isEarlierGuest(guest.tags)))
      .flatMap((guest): KeptGuest[] => {
        const tags = copyTags(guest.tags);
        const owner = ownerFromTags(guest.tags, guest.name || null) ?? (tags.box ? { boxId: tags.box, threadId: "unknown", name: null, kind: tags.kind, createdAt: null } : null);
        if (!owner) return [];
        const where = isHeldCopy(guest.tags) ? "held-copy" : "earlier";
        return [{ guest: this.#guest(guest.node || api.node, guest.vmid, templateFromTags(guest.tags), owner.boxId), owner, where, snapshot: tags.snapshot, takenAt: tags.takenAt, kept: tags.kept, template: guest.template, forkSafe: tags.forkSafe }];
      });
  }

  async #boxGuests(api: Proxmox, signal?: AbortSignal): Promise<{ guest: Guest; owner: BoxOwner | null }[]> {
    const install = installTag(this.#context.installId);
    return (await api.listPool(this.#config.proxmox.pool, signal))
      .filter((guest) => guest.type === "lxc" && !guest.template && this.#inRange(guest.vmid) && guest.tags.includes(TAG) && guest.tags.includes(install) && !isEarlierGuest(guest.tags) && !isHeldCopy(guest.tags))
      .flatMap((guest) => {
        const owner = ownerFromTags(guest.tags, guest.name || null);
        return owner ? [{ guest: this.#guest(guest.node || api.node, guest.vmid, templateFromTags(guest.tags), owner.boxId), owner }] : [];
      });
  }

  kinds(): BoxKind[] {
    return this.#offers().map((offer) => offer.kind);
  }

  async capacity(kind: string, size: MachineSize & { readonly gpu?: GpuPart }, pending: readonly Pending[], signal?: AbortSignal): Promise<Capacity> {
    const offer = this.#offer(kind);
    const gpu = gpuPartOf(offer, size);
    const api = await this.client();
    const guests = await api.listPool(this.#config.proxmox.pool, signal);
    const builds = await this.templateBuilds(api, guests, signal);
    const ready = guests.filter((guest) => this.warmOf(guest, builds)?.flavour === offer.flavour && guest.status === "running");
    const fitting = this.#warmServes(offer, gpu) ? ready.filter((guest) => guest.size?.cores === size.cores) : [];
    // Acquires here that hold their guest need no warm guest.
    const holding = [...this.#acquiring.values()].filter((acquire) => acquire.flavour === offer.flavour && acquire.held !== null).length;
    const waiting = Math.max(0, pending.filter((other) => flavourOf(other.kind) === offer.flavour).length - holding);
    // Any of them may be claimed, so the one with the least memory is assumed.
    const warmMiB = fitting.length > waiting ? Math.min(...fitting.map((guest) => guest.size?.memoryMiB ?? 0)) : null;
    return this.#room(api, offer, size, guests, pending, { ready: ready.length, target: this.#warmTarget(offer.flavour) }, warmMiB, signal, gpu);
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
    size: MachineSize | null,
    guests: readonly PoolGuest[],
    pending: readonly Pending[],
    warm: { ready: number; target: number },
    warmMiB: number | null,
    signal?: AbortSignal,
    gpu: GpuPart = gpuPartOf(offer, null),
  ): Promise<Capacity> {
    const choice = await this.#choice(api, offer, guests, pending, signal, gpu);
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
    if (offer.kind.capabilities.gpu && gpu !== "none") {
      const gpus = this.#gpuIds(offer, (await this.#hostGpus()).report);
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
      ...(!ok && problems[0] === choice.problem && choice.agentProblem ? { agentMessage: choice.agentProblem } : {}),
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
    if (!templates.some((template) => template.gpu !== null)) {
      return refusedChoice(least(templates), {
        person: `The desktop templates on ${node} carry no card's device lines, and ${node} has no GPU helper to give a desktop its card. Set up the helper with host/setup-gpu.sh, as root on ${node}, or ask for gpu none.`,
        agent: `Not made: ${node} has no GPU helper to give a desktop its card. Ask for gpu none, or ask the user. bb-box changed nothing.`,
      });
    }

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
    const ours = boxOwner(this.#context.installId, box.boxId);
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
    let placed: NewPlacement | null = null;
    let gated: Reservation | null = null;
    let cardClaim: CardClaim | null = null;
    let heldGpu: string | null = null;
    let cardSeen: CardCheck | null = null;
    const gpuPart = box.size.gpu;
    const withCard = gpuPart !== "none";
    const dropPlacement = () => {
      reservationsOn(this.#cardKey(api)).drop(placed?.reservation ?? null);
      reservationsOn(this.#cardKey(api)).drop(gated);
      placed = null;
      gated = null;
      cardClaim = null;
      heldGpu = null;
    };
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
      if (vmid === null && !box.from && this.#warmServes(offer, gpuPart)) {
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
      const refusedCards = new Set<string>();
      let started = false;
      for (;;) {
        if (vmid === null) {
          // Time spent waiting for a template that is being replaced shows apart from the clone.
          let away: number | null = null;
          const cloning = performance.now();
          try {
            const untested = withCard ? await this.#untestedHere(api, signal) : null;
            if (untested) throw new BackendError("no_capacity", untested);
            const guests = await api.listPool(this.#config.proxmox.pool, signal);
            const view = !box.from && withCard ? await this.#cardsView(api, signal) : NO_CARDS;
            if (box.from) {
              acquiring.template = Number(box.from);
            } else if (offer.flavour === "linux" && withCard) {
              placed = await step("place", () => this.#placeServer(api, box.boxId, refusedCards, new Set(failed.keys()), signal));
              acquiring.template = placed.template.vmid;
            } else if (offer.flavour === "desktop" && !withCard) {
              const choice = this.#noCardChoice(offer, guests, api.node);
              if (choice.problem) throw new BackendError("no_capacity", choice.problem, choice.agentProblem ?? null);
              acquiring.template = choice.template.vmid;
            } else if (view.is === "blocked") {
              throw new BackendError("no_capacity", blockedWords(view));
            } else if (view.is === "on") {
              placed = await step("place", () => this.#placeNew(api, offer, box.boxId, refusedCards, new Set(failed.keys()), signal));
              acquiring.template = placed.template.vmid;
            } else {
              const choice = this.#choose(offer, guests, [], api.node, await this.#placing(offer, new Set(failed.keys())));
              if (failed.size && choice.problem) throw noGpu(failed, choice.problem);
              acquiring.template = choice.template.vmid;
            }
            // Read before the clone, so it is never newer than the clone's: a replace in between leaves the box what it has.
            acquiring.build = (await templateBuild(api, guests, acquiring.template, signal)) ?? null;
            const description = describe(box, this.#context.installId);
            vmid = await this.#clone(api, guests, acquiring.template, box.name, description, claim, signal, (ms) => (away = (away ?? 0) + ms));
            if (placed) placed.reservation.vmid = vmid;
            reservationsOn(this.#cardKey(api)).made(vmid);
            acquiring.held = 0;
          } finally {
            if (away !== null) hooks.timing("template", away);
            hooks.timing("clone", Math.round(performance.now() - cloning - (away ?? 0)));
          }
        }
        const id = vmid;
        const template = acquiring.template;
        if (!warm) {
          // A low CPU weight until the box is ready (#888), where its config sets none of its own.
          let low = false;
          let had: string[] = [];
          await step("configure", async () => {
            const config = await this.#owned(api).read(id, ours, signal);
            low = startsLow(config);
            had = parseTags(config.tags);
            await this.#owned(api).writeOn(id, ours, config, { ...this.#settings(box.size, id), ...(low ? LOW : {}) }, signal);
          });
          const asked: ClaimMarker | null = placed ? { part: "shared", card: placed.card.uuid, generation: nextGeneration(placed.lines, id, 0, this.#written.get(id) ?? 0) } : null;
          const labels = withStartTag(boxTags(box, this.#context.installId, template), low);
          await step("tags", () => this.#owned(api).configure(id, ours, (config) => ({ tags: asked ? withMarker(labels, asked) : withGpuTagsOf(parseTags(config.tags), labels) }), signal));
          if (asked && placed) {
            const card = placed.card;
            const answer = await step("gpu", () => this.#askHelper(api, id, asked, signal));
            if (answer.is !== "granted") {
              dropPlacement();
              await this.#forget(id);
              await this.#owned(api).destroy(id, ours, signal);
              vmid = null;
              claimed = null;
              acquiring.vmid = null;
              acquiring.template = null;
              acquiring.build = null;
              acquiring.held = null;
              if (answer.is === "refused" && refusedCards.size === 0) {
                refusedCards.add(card.uuid);
                this.#context.logError("acquire", new Error(`The GPU helper on ${api.node} refused ${cardName(card)} for box ${box.name}, as ${answer.why}, so bb-box released its guest and places it once more, on another card.`));
                continue;
              }
              throw new BackendError(
                "no_capacity",
                answer.is === "refused"
                  ? `The host's GPU helper on ${api.node} refused ${cardName(card)} for box ${box.name}, as ${answer.why}${refusedCards.size ? ", after it had refused another card" : ""}. bb-box released the guest it had made; nothing else changed. Try again, or run bb box doctor.`
                  : notAnsweredWords(api.node, answer),
              );
            }
            cardClaim = claimOf(asked, "granted");
          }
        }
        if (!placed && withCard) {
          if ((await api.status(id, signal))?.status === "running") cardClaim = await step("gpu", () => this.#markedClaim(api, id, signal));
          else {
            const gate = await step("gpu", () => this.#gateStart(api, id, ours, signal, (why) => `bb-box did not start the guest it had made for box ${box.name}, and releases it: ${why}`));
            gated = gate.reservation;
            cardClaim = gate.claim;
            heldGpu = gate.gpu;
          }
        }
        if (!started) await hooks.starting();
        started = true;
        await step("start", async () => {
          if ((await api.status(id, signal))?.status === "running") return;
          await this.#owned(api).start(id, ours, signal);
        });
        await this.#grow(api, id, ours, box.size.diskGiB, template, step, signal);
        // Read while the box comes up: the size it has, as Proxmox gives it.
        const size = api.config(id, signal).then(sizeOf, () => null);
        await this.#waitReady(id, box.kind, Math.max(1_000, deadline - Date.now()), signal, step);
        if (warm) await step("name", () => this.#name(id, box.name, signal));
        const display = offer.kind.capabilities.displays.length
          ? await step("display", () => this.#displayMode(id, box.kind, Math.max(1_000, deadline - Date.now()), signal))
          : null;
        await this.#sawDisplay(heldGpu ?? this.#gpuOf(template), display);
        const claimedCard = cardClaim?.part !== "none" ? (cardClaim?.card ?? null) : null;
        if (claimedCard) cardSeen = await step("card", () => this.#checkCard(api, id, claimedCard, signal));
        const offCard = cardSeen && !cardSeen.ok ? cardSeen.why : null;
        const offGpu = withCard && offer.kind.capabilities.displays.length > 0 && display?.mode !== "gpu" ? display?.reason || "no reason given" : null;
        if (!offCard && !offGpu) {
          // A spare keeps its low weight until a box takes it: relabel() puts it back then.
          if (box.threadId !== SPARES) await this.#settle(api, id, ours, signal);
          const gpuFact = cardClaim && claimedCard ? await this.#cardFact(api, cardClaim.part, claimedCard, cardSeen, placed?.lines ?? null, signal) : cardClaim ? heldGpu : undefined;
          const made = this.#guest(api.node, id, template, box.boxId, display, await size, acquiring.build, gpuFact);
          const guest = cardClaim ? { ...made, claim: cardClaim } : made;
          reservationsOn(this.#cardKey(api)).settle(placed?.reservation ?? null, this.#now());
          reservationsOn(this.#cardKey(api)).settle(gated, this.#now());
          // Claimed again, so the box's record shows the display's facts as it becomes ready.
          if (display) await hooks.claim(guest);
          return guest;
        }

        const gpu = heldGpu ?? this.#gpuOf(template) ?? (claimedCard ? `GPU-${claimedCard}` : "unknown");
        const reason = offCard ?? offGpu ?? "no reason given";
        failed.set(gpu, reason);
        this.#avoidGpu(gpu === "unknown" ? null : gpu);
        this.#context.logError("acquire", new Error(`Box ${box.name} started without GPU ${gpu} (${reason}), so bb-box released it and tries another GPU.`));
        dropPlacement();
        await this.#forget(id);
        await this.#owned(api).destroy(id, ours, signal);
        vmid = null;
        claimed = null;
        acquiring.vmid = null;
        acquiring.template = null;
        acquiring.build = null;
        acquiring.held = null;
        warm = false;
        const everyCard = offer.flavour === "linux" || offer.config.templates.some((candidate) => candidate.gpu === null);
        const left = everyCard || offer.config.templates.some((candidate) => candidate.gpu !== null && !failed.has(candidate.gpu));
        if (!left) throw noGpu(failed, `No other GPU on ${api.node} has a linux-desktop template.`);
        if (Date.now() >= deadline) throw noGpu(failed, "There is no time left to try another GPU.", offer.flavour === "linux");
      }
    } catch (error) {
      dropPlacement();
      // Counted as pending in full again before its guest goes, so never not at all.
      acquiring.held = null;
      // A clone cut short may still have made the guest; it is ours if it names the box.
      const leftover = vmid ?? claimed;
      if (leftover !== null && !(error instanceof NoLongerOurs) && (vmid !== null || (await this.#owns(api, leftover, box.boxId).catch(() => false)))) {
        await this.#forget(leftover);
        await this.#owned(api).destroy(leftover, ours).catch((cause) => this.#context.logError("release after a failed acquire", cause));
      }
      throw error;
    } finally {
      if (this.#acquiring.get(box.boxId) === acquiring) this.#acquiring.delete(box.boxId);
    }
  }

  async release(guest: Guest, hooks: ReleaseHooks, signal?: AbortSignal): Promise<void> {
    const started = performance.now();
    this.#selkies.forget(presenceKey(guest));
    this.#gpuVideo.forget(presenceKey(guest));
    this.#cursor.forget(presenceKey(guest));
    await this.#forget(this.#vmid(guest));
    const api = await this.client();
    if (await this.#still(api, guest, signal)) {
      await this.#owned(api).destroy(this.#vmid(guest), this.#boxOf(guest), signal, () =>
        this.disarmFork(guest, signal).catch((error: unknown) => this.#context.logError("disarm before release", error)),
      );
    }
    reservationsOn(this.#cardKey(api)).dropGuest(this.#vmid(guest));
    reservationsOn(this.#cardKey(api)).deleted(this.#vmid(guest), this.#now());
    hooks.timing("delete", Math.round(performance.now() - started));
    const gpu = guest.claim?.card ? await this.#heldGpu(guest.claim.card) : this.#gpuOf(typeof guest.data?.template === "number" ? guest.data.template : null);
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

  async start(guest: Guest, signal?: AbortSignal, timing?: (step: string, ms: number) => void, answered?: () => Promise<void>, readyWithinMs?: number): Promise<Started | void> {
    const vmid = this.#vmid(guest);
    const api = await this.client();
    const status = (await this.#still(api, guest, signal)) ? await api.status(vmid, signal) : null;
    if (!status) throw gone(vmid);
    const step: Step = timing
      ? async (name, run) => {
          const began = performance.now();
          try {
            return await run();
          } finally {
            timing(name, Math.round(performance.now() - began));
          }
        }
      : untimed;
    const owner = this.#boxOf(guest);
    let gate = UNGATED;
    const tags = parseTags((await api.config(vmid, signal)).tags);
    const marked = claimMarkerOf(tags) !== null;
    const kind = tags.find((tag) => tag.startsWith(KIND_TAG))?.slice(KIND_TAG.length) ?? null;
    const server = kind !== null && flavourOf(currentKindId(kind)) === "linux";
    const pin = this.#pinOf(guest);
    const startedHere = status.status !== "running";
    if (status.status === "running") {
      if (marked) gate = { ...UNGATED, gpu: await this.#grantedGpu(api, vmid, signal) };
    } else {
      if (pin) gate = await step("gpu", () => this.#gateOnPin(api, vmid, owner, guest, pin, signal));
      else if (marked) gate = await step("gpu", () => this.#gateStart(api, vmid, owner, signal));
      const reservations = reservationsOn(this.#cardKey(api));
      try {
        await step("boot", () => this.#owned(api).start(vmid, owner, signal));
      } catch (error) {
        reservations.drop(gate.reservation);
        throw error;
      }
      reservations.settle(gate.reservation, this.#now());
    }
    const readyMs = this.#options.readyTimeoutMs ?? readyWithinMs ?? READY_TIMEOUT_MS;
    await this.#waitReady(vmid, null, readyMs, signal, step);
    let checked: CardCheck | null = null;
    const running = !startedHere && marked ? await this.#grantedClaim(api, vmid, signal) : null;
    const held = gate.claim ?? running;
    const claimedCard = held && held.part !== "none" ? held.card : null;
    if (claimedCard) {
      checked = await step("card", () => this.#checkCard(api, vmid, claimedCard, signal));
      if (startedHere && !checked.ok && server && !this.#userspaceOff(checked)) {
        const moved = await this.#startOnAnotherCard(api, vmid, owner, gate, checked.why, readyMs, step, signal);
        gate = moved.gate;
        checked = moved.checked;
      }
    }
    await answered?.();
    const claimed = gate.claim ? { claim: gate.claim } : {};
    const template = typeof guest.data?.template === "number" ? guest.data.template : null;
    const now = gate.claim ?? running;
    const cardWords = now?.card && now.part !== "none" ? await this.#cardFact(api, now.part, now.card, checked, null, signal) : null;
    const gpuFact = cardWords && checked && !checked.ok ? `${cardWords}: ${checked.why}` : (cardWords ?? (marked ? gate.gpu : undefined));
    if (server) return cardWords && gpuFact ? { facts: this.#facts(template, null, gpuFact), ...claimed } : gate.claim ? claimed : undefined;
    // A GPU desktop's display takes its path again at each boot, and falls back to the CPU when its GPU is short of memory (#597).
    if (!this.#gpuOf(template) && !gate.gpu) return gate.claim ? claimed : undefined;
    const display = await this.#displayMode(vmid, "linux-desktop", this.#options.readyTimeoutMs ?? READY_TIMEOUT_MS, signal).catch((error: unknown) => {
      this.#context.logError("display mode", error);
      return null;
    });
    return { facts: this.#facts(template, display, gpuFact), ...claimed };
  }

  #userspaceOff(checked: CardCheck): boolean {
    return !checked.ok && /its NVIDIA userspace is \S+ and the host's driver/.test(checked.why);
  }

  async #startOnAnotherCard(
    api: Proxmox,
    vmid: number,
    owner: GuestOwner,
    gate: StartGate,
    why: string,
    readyMs: number,
    step: Step,
    signal?: AbortSignal,
  ): Promise<{ readonly gate: StartGate; readonly checked: CardCheck }> {
    const card = gate.claim!.card!;
    const named = await this.#cardFact(api, gate.claim!.part, card, null, null, signal);
    const left = (more: string) => new Error(`The box did not get ${named.split(",")[0]}: ${why}. ${more} It is stopped, with its disk as it was. Start tries again; bb box doctor has more.`);
    const reservations = reservationsOn(this.#cardKey(api));
    reservations.drop(gate.reservation);
    await step("stop", () => this.#owned(api).stop(vmid, owner, signal));
    await underCardLock(this.#cardKey(api), async () => reservations.dropStopped(vmid));
    const moved = await step("gpu", () => this.#gateStart(api, vmid, owner, signal, (refused) => refused, new Set([card]))).catch((error: unknown) => {
      throw left(`bb-box could not place it on another card: ${message(error)}`);
    });
    if (!moved.claim?.card || moved.claim.card === card) {
      reservations.drop(moved.reservation);
      throw left("No other card has room for it.");
    }
    try {
      await step("boot", () => this.#owned(api).start(vmid, owner, signal));
    } catch (error) {
      reservations.drop(moved.reservation);
      throw error;
    }
    reservations.settle(moved.reservation, this.#now());
    await this.#waitReady(vmid, null, readyMs, signal, step);
    const checked = await step("card", () => this.#checkCard(api, vmid, moved.claim!.card!, signal));
    if (checked.ok) return { gate: moved, checked };
    await this.#owned(api).stop(vmid, owner, signal).catch((error: unknown) => this.#context.logError("stop a box that did not get its card", error));
    throw left(`bb-box moved it to another card, and it did not get that one either: ${checked.why}.`);
  }

  async stop(guest: Guest, signal?: AbortSignal): Promise<void> {
    const vmid = this.#vmid(guest);
    const api = await this.client();
    const status = (await this.#still(api, guest, signal)) ? await api.status(vmid, signal) : null;
    if (!status) throw gone(vmid);
    await this.#forget(vmid);
    if (status.status === "running") await this.#owned(api).stop(vmid, this.#boxOf(guest), signal);
    const key = this.#cardKey(api);
    await underCardLock(key, async () => reservationsOn(key).dropStopped(vmid));
  }

  /**
   * A container takes new cores and memory while it runs, and Proxmox grows
   * its root disk and file system online, so every part of a resize is
   * live (061). New memory shows at once; new cores when Proxmox next
   * spreads its guests' CPUs, up to about 10 s later.
   */
  resizing(kind: string): Resizing | null {
    return this.#offers().some((offer) => offer.kind.id === kind) ? { cores: "live", memory: "live", disk: "live", shrinks: true } : null;
  }

  async planResize(guest: Guest, kind: string, to: MachineSize, pending: readonly Pending[], signal?: AbortSignal): Promise<ResizePlan> {
    this.#offer(kind);
    const api = await this.client();
    const config = await this.#ownConfig(api, guest, signal);
    const from = sizeOf(config);
    if (!from) throw new Error(`Container ${this.#vmid(guest)} does not say its cores and memory, so bb-box cannot resize it.`);
    if (to.diskGiB !== null && from.diskGiB !== null && to.diskGiB < from.diskGiB) {
      throw new BackendError("unsupported", `A container's disk only grows, and this one's is ${from.diskGiB} GiB.`);
    }
    const parts: ResizePlan["parts"][number][] = [];
    if (to.cores !== from.cores) parts.push({ part: "cores", from: from.cores, to: to.cores, way: "live" });
    if (to.memoryMiB !== from.memoryMiB) parts.push({ part: "memory", from: from.memoryMiB, to: to.memoryMiB, way: "live" });
    if (to.diskGiB !== null && to.diskGiB !== from.diskGiB) parts.push({ part: "disk", from: from.diskGiB, to: to.diskGiB, way: "live" });
    const storage = String(config.rootfs ?? "").split(":")[0] || null;
    const room = await this.#resizeRoom(api, storage, from, to, pending, signal);
    return { parts, room, downSeconds: null };
  }

  /**
   * Resizes a container while it runs, or while it is stopped, which then
   * starts at the new size: cores and memory first, which can go back, then
   * the disk, which cannot. When the disk fails, cores and memory go back
   * to what they were (061).
   */
  async resize(guest: Guest, _kind: string, to: MachineSize, _options: { readonly restart: boolean }, signal?: AbortSignal): Promise<Guest> {
    const vmid = this.#vmid(guest);
    const api = await this.client();
    const from = sizeOf(await this.#ownConfig(api, guest, signal));
    if (!from) throw new Error(`Container ${vmid} does not say its cores and memory, so bb-box cannot resize it.`);
    if (to.diskGiB !== null && from.diskGiB !== null && to.diskGiB < from.diskGiB) {
      throw new BackendError("unsupported", `A container's disk only grows, and this one's is ${from.diskGiB} GiB.`);
    }
    const changed = to.cores !== from.cores || to.memoryMiB !== from.memoryMiB;
    const owner = this.#boxOf(guest);
    if (changed) await this.#owned(api).configure(vmid, owner, { cores: to.cores, memory: to.memoryMiB }, signal);
    if (to.diskGiB !== null && (from.diskGiB === null || to.diskGiB > from.diskGiB)) {
      try {
        await this.#owned(api).growRootDisk(vmid, owner, to.diskGiB, signal);
      } catch (error) {
        if (changed) {
          await this.#owned(api).configure(vmid, owner, { cores: from.cores, memory: from.memoryMiB }).catch((cause) => this.#context.logError("resize: put cores and memory back", cause));
        }
        throw error;
      }
    }
    return { ...guest, size: sizeOf(await api.config(vmid, signal)) ?? to };
  }

  /** The guest's config, when the guest at its VMID is still the box's (018); BackendError("gone") otherwise. */
  async #ownConfig(api: Proxmox, guest: Guest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const config = await this.#guestConfig(api, this.#vmid(guest), signal);
    const names = config ? namesOf(config) : null;
    const box = typeof guest.data?.box === "string" ? guest.data.box : null;
    if (!config || names!.install !== this.#context.installId || names!.box !== box) throw gone(this.#vmid(guest));
    return config;
  }

  /**
   * Room on the node for a container to grow from `from` to `to` (061):
   * the memory and disk it adds, kept within the node's reserves, and cores
   * within the node's CPU threads. A shrink always fits.
   */
  async #resizeRoom(api: Proxmox, storage: string | null, from: MachineSize, to: MachineSize, pending: readonly Pending[], signal?: AbortSignal): Promise<Capacity> {
    const [node, disk] = await Promise.all([api.nodeStatus(signal), storage ? api.storageStatus(storage, signal) : Promise.resolve(null)]);
    const reserve = this.#config.reserve;
    const heldMiB = [...this.#acquiring.values()].reduce((sum, acquire) => sum + (acquire.held ?? 0), 0);
    const pendingMiB = Math.max(0, pending.reduce((sum, other) => sum + other.size.memoryMiB, 0) - heldMiB);
    const memoryTotal = Math.floor(node.memoryTotal / MiB);
    const memoryUsed = memoryTotal - Math.floor(node.memoryAvailable / MiB) + pendingMiB;
    const memoryFree = memoryTotal - memoryUsed;
    const limits: Limit[] = [{ resource: "memory", used: memoryUsed, total: memoryTotal, reserve: reserve.memoryMiB, unit: "MiB" }];
    const problems: string[] = [];
    if (node.cpus !== null && to.cores > node.cpus) {
      problems.push(`${api.node} has ${node.cpus} CPU threads, fewer than the ${to.cores} cores asked for. Ask for at most ${node.cpus} cores.`);
    }
    const memory = to.memoryMiB - from.memoryMiB;
    if (memory > 0 && memoryFree - memory < reserve.memoryMiB) {
      problems.push(
        memory > memoryFree
          ? `${api.node} has ${formatMiB(Math.max(0, memoryFree))} of memory free, less than the ${formatMiB(memory)} more the box needs. Release a box or ask for less memory.`
          : `${api.node} has ${formatMiB(memoryFree)} of memory free and keeps ${formatMiB(reserve.memoryMiB)} free, so the ${formatMiB(memory)} more the box needs does not fit. ` +
              "Release a box, ask for less memory, or lower the memory kept free in bb-box's settings.",
      );
    }
    const grow = to.diskGiB !== null ? Math.max(0, to.diskGiB - (from.diskGiB ?? to.diskGiB)) : 0;
    if (disk) {
      const diskTotal = Math.floor(disk.total / MiB);
      const diskFree = Math.floor(disk.available / MiB);
      limits.push({ resource: "disk", used: diskTotal - diskFree, total: diskTotal, reserve: reserve.diskGiB * 1024, unit: "MiB" });
      if (grow > 0 && diskFree - grow * 1024 < reserve.diskGiB * 1024) {
        const storageFree = `The ${storage} storage on ${api.node} has ${Math.floor(diskFree / 1024)} GiB free`;
        problems.push(
          grow * 1024 > diskFree
            ? `${storageFree}, less than the ${grow} GiB more the disk needs. Ask for a smaller disk or release boxes.`
            : `${storageFree} and keeps ${reserve.diskGiB} GiB free, so ${grow} GiB more disk does not fit. Ask for a smaller disk, release boxes, or lower the disk kept free in bb-box's settings.`,
        );
      }
    }
    const ok = problems.length === 0;
    return { ok, message: ok ? null : problems[0]!, warm: null, hosts: [{ host: api.node, ok, limits }] };
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
      if (isHeldCopy(guest.tags) || isEarlierGuest(guest.tags)) continue;
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
      if (guest.name === copyName(guest.vmid)) owner = null;
      // A running container's listed disk is its filesystem's, which Proxmox
      // reads every 10 s or so: less than the disk, and the old size for a
      // while after a resize. The config gives the disk's, as acquire reads it.
      config ??= await api.config(guest.vmid, signal).catch((): Record<string, unknown> => ({}));
      const size = guest.size && { ...guest.size, diskGiB: rootDiskGiB(config) ?? guest.size.diskGiB };
      const template = templateFromTags(guest.tags);
      const marker = claimMarkerOf(parseTags(config.tags)) ?? claimMarkerOf(guest.tags);
      const gpu = marker ? await this.#heldGpu(marker.card) : undefined;
      const found = this.#guest(guest.node || api.node, guest.vmid, template, owner?.boxId ?? null, null, size, null, gpu);
      held.push({ ...found, owner, power: powerOf(guest.status), ...(guest.tags.includes(START_TAG) ? { settling: true } : {}) });
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
    await this.#owned(api).writeOn(
      vmid,
      unstampedOwner(boxId),
      config,
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
    // A Wayland box of an image built before Selkies was in it has no video (060), nor a GPU desktop's of an image built
    // before its Selkies encoded with NVENC (#863).
    const video =
      offer?.flavour === "desktop" ? await this.#gpuVideo.has(presenceKey(guest), command) : !wayland || (await this.#selkies.has(presenceKey(guest), command));
    // An image with bb-box-cursor (060): Sway 1.11, whose streams paint no pointer, so none is hidden, and Sway keeps a theme
    // the cursor session and wayvnc send as the pointer's shape. One without keeps #707's hidden theme.
    const sends = wayland && (await this.#cursor.has(presenceKey(guest), command));
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
              ...(wayland ? { resize: (size: DisplaySize, signal?: AbortSignal) => this.#resizeWayland(command, size, signal), restartServer: (signal?: AbortSignal) => restartWayvnc(command, signal), serverAttached: async (signal?: AbortSignal) => (await wayvncAttached(command, signal)) !== false, pointer: (shown: boolean, signal?: AbortSignal) => waylandPointer(command, shown || sends, signal) } : {}),
              ...(sends ? { followPointer: (onEvent: (event: BoxPointer) => void, signal: AbortSignal) => followPointer(command, onEvent, signal, this.#cursorHelper) } : {}),
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
    const later = [NODE, MEMORY, POOL, ...templates.map(templateCheck), BRIDGE, VMIDS, SNAPSHOTS];
    const templateStorages: GuestDiskStorage[] = [];
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
        images?.chrome?.("x86_64") ?? null,
      ]).catch(() => [null, null, null, null, null] as const);
      const pinSet = (flavour: LxcFlavour): PinSet => (flavour === "linux" ? "linux" : "linux-desktop");
      const reportNotes = api.vmNotes(GPU_REPORT_VM, signal).catch(() => null);
      const reportDriver = reportNotes.then((vm) => (vm ? reportedDriver(vm.notes) : null));
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
              templateStorages.push({ name: storage, type: (disk as StorageStatus).type, volume: String(config.rootfs) });
              pass(name, `CT template ${template} on ${storage}, ${Math.floor((disk as { available: number }).available / GiB)} GiB free.`);
              const [linuxPins, desktopPins, bbApp, nvidia, chromeAmd] = await facts;
              const recorded = recordInDescription(String(config.description ?? ""));
              const rebuild = `Rebuild it with the setup guide's template/build.sh, as root on ${node}: build.sh ${REBUILD[listed.flavour](template, listed.template.gpu)} --replace.`;
              const server = listed.flavour === "linux";
              const judged = judgeImage(
                recorded,
                { os: "linux", pins: pinSet(listed.flavour) === "linux" ? linuxPins : desktopPins, bbApp, hostNvidia: server ? null : nvidia, pinChrome: recorded?.arch === "arm64" ? null : chromeAmd },
                rebuild,
              );
              const driver = (await reportDriver) ?? nvidia?.version ?? null;
              const offDriver = server && recorded?.nvidia && driver && recorded.nvidia !== driver;
              const userspaceWords = `The Linux template has NVIDIA's userspace ${recorded?.nvidia}, and the host's driver is ${driver}. New boxes with a GPU are not made from it until it is rebuilt with build.sh linux. Boxes with no GPU are made as usual.`;
              checks.push({
                id: `template.${template}.image`,
                name: `Image of ${name[1]}`,
                ...(offDriver ? { status: judged.status === "fail" ? "fail" : "warn", detail: judged.status === "ok" ? userspaceWords : `${judged.detail} ${userspaceWords}`, fix: judged.fix ?? rebuild } : judged),
              });
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
      const notesSeen = await reportNotes;
      const reportedCards = notesSeen ? (parseGpuReport(notesSeen.notes)?.gpus ?? []) : [];
      const named = gpusOf(this.#config.flavours.desktop.templates);
      const gpus = [...named, ...reportedCards.filter((card) => !named.some((id) => namesGpu(id, card))).map((card) => card.uuid)];
      if (gpus.length) {
        const setup = "Run host/setup-gpu-report.sh from the setup guide as root";
        const status = (unit: string) => `Run systemctl status ${unit} as root on ${node}, and check the host's clock.`;
        try {
          const vm = await api.vmNotes(GPU_REPORT_VM, signal);
          const report = vm ? parseGpuReport(vm.notes) : null;
          const helper = vm ? parseGpuHelper(vm.notes) : null;
          const fix = status(helper ? "bb-box-gpu" : "bb-box-gpu-memory.timer");
          const unnamed = report ? gpus.filter((gpu) => !report.gpus.some((reported) => namesGpu(gpu, reported))) : [];
          if (!helper) {
            warn(
              GPU_HELPER,
              `${node} has no GPU helper, so its servers get no GPU, and no box gets a whole card or changes card. GPU desktops go on as before, on the cards their templates name. GPU on servers, whole cards and changes of card need host/setup-gpu.sh.`,
              `Run host/setup-gpu.sh from the setup guide as root on ${node}.`,
            );
          }
          if (vm && helper) {
            if (helper.version) await this.#rememberPower(this.#cardKey(api), helper.version);
            const verdict = judgeGpuHelper(helper, { node, pool, vmid: vm.vmid, ageMs: report ? this.#now() - report.at : null, ago });
            checks.push({ id: GPU_HELPER[0], name: GPU_HELPER[1], ...verdict });
            checks.push({ id: GPU_CARDS[0], name: GPU_CARDS[1], ...this.#cardsCheck(vm.notes) });
            if (verdict.status === "fail") skip(GPU_MIGRATION);
            else {
              try {
                const setup = this.#markingSetup();
                const ours = (await api.listPool(pool, signal)).filter((guest) => isOurGuest(guest, setup, node));
                const looks = await lookAtEach(api, ours, signal);
                const guests = ours.map((guest, at) => ({ name: guest.name, look: looks[at]! }));
                checks.push({ id: GPU_MIGRATION[0], name: GPU_MIGRATION[1], ...judgeGpuMigration(parseHelperLines(vm.notes), guests, { ...setup, node, vmid: vm.vmid }) });
              } catch (error) {
                warn(GPU_MIGRATION, message(error), audit(error, `Give the token VM.Audit on /pool/${pool}.`));
              }
            }
          }
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

      const helper = await this.#helperLines(api, signal).catch(() => null);
      if (helper?.ledgerReported) {
        for (const card of helper.cards) {
          const holders = helper.holders.filter((holder) => holder.card === card.uuid);
          const whole = holders.filter((holder) => holder.part === "whole");
          const check: Check = [`gpu.${card.uuid}.whole`, `GPU ${card.index} whole`];
          const named = holders.map((holder) => `CT ${holder.vmid}`).join(", ");
          if (whole.length === 1 && holders.length === 1) pass(check, `CT ${whole[0]!.vmid} holds card ${card.index} whole, and no other guest has its lines.`);
          else if (whole.length === 0) pass(check, `No box holds card ${card.index} whole.`);
          else fail(check, `Card ${card.index} is held whole and also by another guest: ${named}. A claim went wrong.`, "Stop the guests that should not hold it. bb-box does not move them.");
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
        const foreign = await this.#foreignInRange(api, signal);
        const seen = [...this.#sightings.values()].map((sighting) => `${sighting.words} (${ago(this.#now() - sighting.at)})`);
        const unseen = `The token sees only the guests it has VM.Audit on, those of pool ${pool}, so a guest elsewhere in the range, or another install's range that overlaps this one, is not seen: this check is no proof that the range is this install's alone.`;
        if (foreign.length || seen.length) {
          fail(
            VMIDS,
            [foreign.length ? `A guest that is not this install's is in its VMID range from ${first} to ${last}: ${foreign.join("; ")}.` : "", ...seen, unseen].filter(Boolean).join(" "),
            "Give each install a VMID range of its own: move or delete each guest that is not this install's, or change this install's VMID range in bb-box's settings. bb-box takes no VMID meanwhile.",
          );
        } else if (used < total) pass(VMIDS, `${total - used} of ${total} VMIDs from ${first} to ${last} are free, and no guest the token can see there is another install's or not bb-box's. ${unseen}`);
        else warn(VMIDS, `All ${total} VMIDs from ${first} to ${last} are in use. ${unseen}`, "Release boxes, or widen the VMID range.");
        const others = await this.#others(api, guests, signal);
        if (others) notes.push(others);
      } catch (error) {
        fail(VMIDS, message(error), audit(error, `Give the token VM.Audit on /pool/${pool}.`));
      }

      const privileges = await poolPrivileges(api, pool, signal);
      const metadata = await storagesMetadata(api, templateStorages, signal);
      checks.push({ id: SNAPSHOTS[0], name: SNAPSHOTS[1], ...snapshotsCheck({ pool, node, guest: "lxc", privileges, storages: templateStorages, metadata }) });
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

  #cardsCheck(notes: string): Omit<DoctorCheck, "id" | "name"> {
    const lines = parseHelperLines(notes);
    const index = (card: string) => lines.cards.find((listed) => listed.uuid === card)?.index ?? card;
    const helperSays = [...notes.matchAll(/^\s*mismatch (\d+) (\S+)\s*$/gm)].map(([, vmid, card]) => `CT ${vmid} runs on lines that are not its claim's card ${index(cardUuid(card!))}, as the GPU helper reports`);
    const boxesSay = [...this.#mismatches].map(([vmid, mismatch]) => `CT ${vmid} holds card ${index(mismatch.card)}, and nvidia-smi in it listed ${mismatch.seen.length ? mismatch.seen.map((card) => `card ${index(card)}`).join(" and ") : "no card"}, ${ago(this.#now() - mismatch.at)}`);
    const wrong = [...helperSays, ...boxesSay];
    if (!wrong.length) {
      const read = this.#cardsCheckedAt
        ? `Every running box with a GPU listed its claimed card in nvidia-smi ${ago(this.#now() - this.#cardsCheckedAt)}`
        : "bb-box has not yet run nvidia-smi in the running boxes with a GPU, as it does every 10 minutes";
      return { status: "ok", detail: `${read}, and the GPU helper reports no running guest on another card's lines.`, fix: null };
    }
    return {
      status: "fail",
      detail: `${wrong.join("; ")}. bb-box places no new box on those cards until it is put right, and does not stop the boxes.`,
      fix: "Restart each box named: its start places it on its card again. If it comes back on the wrong card, the node's card numbering changed; bb box doctor's GPU helper check has more.",
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
    await this.#http.destroy();
    await this.#upkeep.running?.catch(() => undefined);
    await (await this.#ssh?.catch(() => null))?.ssh.dispose();
    await this.#keyFile.dispose();
  }

  /** The Proxmox client, on the configured node or the API's only node. */
  client(): Promise<Proxmox> {
    if (!this.#api) {
      const pending = (async () => {
        let node = this.#config.proxmox.node;
        if (!node) {
          const nodes = await this.#bare().nodes(this.#stopping.signal);
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
    const owner = boxOwner(installId, box.boxId);
    const warm = warmOwner(installId, String((await this.#guestConfig(api, vmid, signal))?.description ?? ""));
    await this.#owned(api).configure(vmid, eitherOwner(warm, owner), { hostname: box.name, memory: box.size.memoryMiB, description: describe(box, installId) }, signal);
    // A warm guest keeps its low CPU weight, and the tag, until the box is ready (#888).
    await this.#retag(api, vmid, owner, (tags) => withStartTag(boxTags(box, installId, template), tags.includes(START_TAG)), signal);
  }

  async #retag(api: Proxmox, vmid: number, owner: GuestOwner, tagsFor: (tags: readonly string[]) => string[], signal?: AbortSignal): Promise<void> {
    await this.#owned(api).configure(vmid, owner, (config) => {
      const tags = parseTags(config.tags);
      return { tags: withGpuTagsOf(tags, tagsFor(tags)) };
    }, signal);
  }

  #owned(api: Proxmox): OwnedGuests {
    return new OwnedGuests(api, (vmid, words) => this.#sighted(vmid, words), {
      helperFor: (vmid, config, action, signal) => this.#powerHelper(api, vmid, config, action, signal),
      ask: (vmid, action, owner, helper, signal) => this.#askPower(api, vmid, action, owner, helper, signal),
      acted: (vmid, action) => (action === "start" || action === "delete" ? this.#dropUnstarted(api, vmid) : Promise.resolve()),
    });
  }

  #sighted(vmid: number, words: string): void {
    this.#sightings.set(vmid, { words, at: this.#now() });
    this.#context.logError("a guest that is not this install's", new Error(words));
  }

  async #powerHelper(api: Proxmox, vmid: number, config: Record<string, unknown>, action: PowerAction, signal?: AbortSignal): Promise<string | null> {
    const marked = claimMarkerOf(parseTags(config.tags)) !== null;
    const gpu = marked || gpuDeviceLines(config).length > 0;
    if (!this.#inRange(vmid) && (!gpu || isTemplate(config))) return null;
    const key = this.#cardKey(api);
    let vm: { readonly vmid: number; readonly notes: string } | null = null;
    let unread: unknown = null;
    try {
      vm = await api.vmNotes(GPU_REPORT_VM, signal);
    } catch (error) {
      unread = error;
    }
    const helper = vm ? parseGpuHelper(vm.notes) : null;
    const throughIt = `Run systemctl status bb-box-gpu as root on ${api.node}, and check the host's clock.`;
    if (vm && helper?.version) {
      await this.#rememberPower(key, helper.version);
      if (!atLeast(helper.version, POWER_ON_THE_NODE_FROM)) return null;
      const pool = this.#config.proxmox.pool;
      if (helper.serves && !helper.serves.listed.includes(pool) && helper.serves.unlisted === 0) return null;
      const at = /^\s*at (\d+)\s*$/m.exec(vm.notes);
      const ageMs = at ? this.#now() - Number(at[1]) * 1000 : null;
      const only = `bb-box starts, stops and deletes this install's guests on ${api.node} only through it. ${throughIt}`;
      if (ageMs === null) throw new Error(`The GPU helper on ${api.node} has written no time in VM ${vm.vmid}'s report, and ${only}`);
      if (ageMs >= GPU_HELPER_FRESH_MS) throw new Error(`The GPU helper on ${api.node} last reported ${ago(ageMs)}, in VM ${vm.vmid}, and ${only}`);
      if (ageMs <= -GPU_HELPER_CLOCK_AHEAD_MS) throw new Error(`The GPU helper's report in VM ${vm.vmid} is dated ahead of this BB server's clock, so bb-box cannot tell whether the helper still runs, and ${only}`);
      if (helper.tested === false && atLeast(helper.version, STOPS_ONLY_UNTESTED_FROM)) {
        if (await this.#plainGuest(api, vmid, config, signal)) return null;
        if (action === "delete" && (await this.#unusedClone(api, vmid, config, signal))) return null;
      }
      return helper.version;
    }
    const why = unread !== null ? `bb-box cannot read the GPU helper's report on ${api.node} (${message(unread)})` : vm ? `VM ${vm.vmid}'s report has no helper line bb-box can read, as while host/setup-gpu.sh restarts the helper` : `the token can read no VM named ${GPU_REPORT_VM} on ${api.node}`;
    if (await this.#powerKnown(key)) {
      throw new Error(`CT ${vmid} was not acted on: ${why}, and the GPU helper there, which starts, stops and deletes this install's guests, has done so before. Try again in a minute. ${throughIt}`);
    }
    if (marked || (gpu && unread !== null)) {
      throw new Error(`CT ${vmid} was not acted on: ${why}, and bb-box starts, stops and deletes a guest with a GPU marker or a GPU's device lines only while it can read the helper. Try again in a minute. ${throughIt}`);
    }
    return null;
  }

  async #unstartedClones(): Promise<Record<string, Record<string, string>>> {
    this.#unstarted ??= (await this.#context.storage.get<Record<string, Record<string, string>>>(UNSTARTED).catch((error: unknown) => {
      this.#context.logError("read the clones bb-box has not started", error);
      return null;
    })) ?? {};
    return this.#unstarted;
  }

  async #cloning(api: Proxmox, vmid: number, description: string): Promise<void> {
    const all = await this.#unstartedClones();
    const key = this.#cardKey(api);
    this.#unstarted = { ...all, [key]: { ...all[key], [String(vmid)]: description } };
    await this.#context.storage.set(UNSTARTED, this.#unstarted).catch((error: unknown) => this.#context.logError("record a clone bb-box has not started", error));
  }

  async #dropUnstarted(api: Proxmox, vmid: number): Promise<void> {
    const all = await this.#unstartedClones();
    const key = this.#cardKey(api);
    if (all[key]?.[String(vmid)] === undefined) return;
    const { [String(vmid)]: _started, ...rest } = all[key];
    this.#unstarted = { ...all, [key]: rest };
    await this.#context.storage.set(UNSTARTED, this.#unstarted).catch((error: unknown) => this.#context.logError("record that bb-box started or deleted a clone", error));
  }

  async #unusedClone(api: Proxmox, vmid: number, config: Record<string, unknown>, signal?: AbortSignal): Promise<boolean> {
    const recorded = (await this.#unstartedClones())[this.#cardKey(api)]?.[String(vmid)];
    const tags = parseTags(config.tags);
    const filling = tags.includes(FILLING) && installFromTags(tags) === this.#context.installId && installFromDescription(config.description) === this.#context.installId;
    if (!(recorded !== undefined ? sameDescription(config.description, recorded) : filling)) return false;
    return (await api.status(vmid, signal))?.status === "stopped";
  }

  async #untestedHere(api: Proxmox, signal?: AbortSignal): Promise<string | null> {
    const vm = await api.vmNotes(GPU_REPORT_VM, signal).catch(() => null);
    const helper = vm ? parseGpuHelper(vm.notes) : null;
    if (!helper?.version || helper.tested !== false || !atLeast(helper.version, STOPS_ONLY_UNTESTED_FROM)) return null;
    const pool = this.#config.proxmox.pool;
    if (helper.serves && !helper.serves.listed.includes(pool) && helper.serves.unlisted === 0) return null;
    return `The GPU helper on ${api.node}, bb-box-gpu ${helper.version}, was not tested on pve-container ${helper.pveContainer}, so it starts no GPU desktop there, and bb-box makes none. Install a bb-box-gpu release newer than ${helper.version} that was tested on pve-container ${helper.pveContainer}: run host/setup-gpu.sh from that BB Box release, as root on ${api.node}.`;
  }

  async #plainGuest(api: Proxmox, vmid: number, config: Record<string, unknown>, signal?: AbortSignal): Promise<boolean> {
    if (markerOf(parseTags(config.tags)) !== null || gpuDeviceLines(config).length > 0 || rawGpuLines(config).length > 0) return false;
    return !pendingDeviceChange(await api.pendingChanges(vmid, signal));
  }

  async #powerKnown(key: string): Promise<boolean> {
    if (this.#powerNodes === undefined) {
      try {
        this.#powerNodes = (await this.#context.storage.get<Record<string, PowerNode>>(POWER_NODES)) ?? {};
      } catch (error) {
        this.#context.logError("read which nodes' GPU helpers start, stop and delete guests", error);
        return true;
      }
    }
    return atLeast(this.#powerNodes[key]?.version ?? null, POWER_ON_THE_NODE_FROM);
  }

  async #rememberPower(key: string, version: string): Promise<void> {
    await this.#powerKnown(key);
    if (this.#powerNodes?.[key]?.version === version) return;
    this.#powerNodes = { ...this.#powerNodes, [key]: { version, seen: new Date(this.#now()).toISOString() } };
    await this.#context.storage.set(POWER_NODES, this.#powerNodes).catch((error: unknown) => this.#context.logError("record which nodes' GPU helpers start, stop and delete guests", error));
  }

  async #askPower(api: Proxmox, vmid: number, action: PowerAction, owner: GuestOwner, helper: string, signal?: AbortSignal): Promise<void> {
    const nonce = randomBytes(8).toString("hex");
    const plain = new OwnedGuests(api);
    let tag = "";
    await plain.configure(vmid, owner, (config) => {
      const tags = parseTags(config.tags);
      tag = `bb-power.${action}.${this.#context.installId}.${powerBox(config, helper) ?? "-"}.g${markerOf(tags)?.generation ?? 0}.n${nonce}`;
      if (!POWER_TAG.test(tag)) throw new Error(`bb-box cannot ask the GPU helper on ${api.node} to ${action} CT ${vmid}: its install or box ID makes the request ${tag}, which is not a Proxmox tag the helper reads.`);
      return { tags: [...tags.filter((each) => !each.startsWith("bb-power.")), tag] };
    }, signal);
    try {
      await this.#awaitPower(api, plain, vmid, action, owner, tag, nonce, signal);
    } finally {
      await plain.configure(vmid, owner, (config) => {
        const tags = parseTags(config.tags);
        return tags.includes(tag) ? { tags: tags.filter((each) => each !== tag) } : null;
      }, signal).catch(() => undefined);
    }
  }

  async #awaitPower(api: Proxmox, plain: OwnedGuests, vmid: number, action: PowerAction, owner: GuestOwner, tag: string, nonce: string, signal?: AbortSignal): Promise<void> {
    let goneAt: number | null = null;
    for (let waited = 0; ; waited += ANSWER_POLL_MS) {
      const answer = (await this.#helperLines(api, signal))?.power.find((each) => each.vmid === vmid && each.nonce === nonce) ?? null;
      if (answer?.answer === "done") return;
      if (answer) {
        const words = `The GPU helper on ${api.node} did not ${action} CT ${vmid}, as ${powerWords(answer)}.`;
        if (answer.reason !== "not-the-box") throw new Error(words);
        this.#sighted(vmid, `${words} bb-box acts on it no more.`);
        throw new NoLongerOurs(`${words} bb-box acts on it no more.`);
      }
      if (waited >= POWER_WAIT_MS) throw new Error(`The GPU helper on ${api.node} did not answer bb-box's request to ${action} CT ${vmid} within ${POWER_WAIT_MS / 1000} s, so bb-box withdrew it. Run bb box doctor.`);
      const now = await plain.readIfThere(vmid, owner, signal).catch((error: unknown) => {
        if (error instanceof NoLongerOurs) this.#sighted(vmid, error.message);
        throw error;
      });
      if (!now && action !== "delete") throw new NoLongerOurs(`CT ${vmid} has gone while bb-box asked the GPU helper on ${api.node} to ${action} it.`);
      if (!now) {
        goneAt ??= waited;
        if (waited - goneAt >= DELETED_UNANSWERED_MS) return;
      } else if (!parseTags(now.tags).includes(tag)) {
        throw new Error(`bb-box's request to ${action} CT ${vmid} was taken off it before the GPU helper on ${api.node} answered, as when bb-box asks it something else about the box meanwhile.`);
      }
      await (this.#options.sleep ?? pause)(ANSWER_POLL_MS, signal);
    }
  }

  async #foreignInRange(api: Proxmox, signal?: AbortSignal): Promise<string[]> {
    const install = this.#context.installId;
    const busy = new Set<number>([...this.#reserved, ...this.#filling.keys(), ...this.#imageBoxes, ...[...this.#acquiring.values()].flatMap((acquire) => (acquire.vmid === null ? [] : [acquire.vmid]))]);
    const templates = new Set(LXC_FLAVOURS.flatMap((flavour) => this.#config.flavours[flavour].templates.map((template) => template.vmid)));
    const found: string[] = [];
    for (const guest of await api.visibleGuests(signal)) {
      if (!this.#inRange(guest.vmid) || busy.has(guest.vmid) || templates.has(guest.vmid)) continue;
      const tagged = installFromTags(guest.tags);
      if (tagged === install) continue;
      const config = await this.#guestConfig(api, guest.vmid, signal).catch(() => null);
      const described = config ? installFromDescription(config.description) : null;
      if (config && !carriesAnother(config, install) && described === install) continue;
      if (tagged === null && guest.tags.includes(TAG) && (described === null || described === install)) continue;
      const theirs = tagged ?? described;
      found.push(theirs ? `CT ${guest.vmid}, of install ${theirs}` : `CT ${guest.vmid}, which is not bb-box's`);
    }
    return found;
  }

  #rangeWords(foreign: readonly string[]): string {
    const { first, last } = this.#config.vmids;
    return `bb-box takes no VMID from ${first} to ${last} while a guest that is not this install's is in that range: ${foreign.join("; ")}. Give each install a VMID range of its own: move or delete ${foreign.length === 1 ? "it" : "them"}, or change this install's VMID range in bb-box's settings.`;
  }

  async #ownRange(api: Proxmox, signal?: AbortSignal): Promise<void> {
    const foreign = await this.#foreignInRange(api, signal);
    if (foreign.length) throw new BackendError("no_capacity", this.#rangeWords(foreign));
  }

  #boxData(guest: Guest): string | null {
    return typeof guest.data?.box === "string" ? guest.data.box : null;
  }

  #boxOf(guest: Guest): GuestOwner {
    return boxOwner(this.#context.installId, this.#boxData(guest));
  }

  #writesFor(api: Proxmox, owner: GuestOwner): ForkWrites {
    const owned = this.#owned(api);
    return {
      config: (vmid, signal) => api.config(vmid, signal),
      setNetwork: (vmid, settings, signal) => owned.setNetwork(vmid, owner, settings, signal),
      destroy: (vmid, signal) => owned.destroy(vmid, owner, signal),
    };
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
      const gpuParts = flavour === "desktop" ? { gpuParts: config.templates.some((template) => template.gpu === null) ? (["none", "shared"] as const) : (["shared"] as const) } : {};
      offers.push({ kind: { ...kind, ...gpuParts }, flavour, config });
    }
    return offers;
  }

  #warmServes(offer: Offer, gpu: GpuPart): boolean {
    return offer.kind.capabilities.gpu ? gpu !== "none" : gpu === "none";
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
    size: MachineSize | null = null,
    build: string | null = null,
    gpu: string | null | undefined = undefined,
  ): Guest {
    const guest: Guest = { ref: String(vmid), host: node, address: addressFor(this.#config, vmid), size };
    const data = { ...(template !== null ? { template } : {}), ...(build !== null ? { build } : {}), ...(box !== null ? { box } : {}) };
    if (!Object.keys(data).length) return guest;
    const facts = this.#facts(template, display, gpu);
    return { ...guest, data, ...(facts.length ? { facts } : {}) };
  }

  /** A GPU desktop's GPU, and a desktop's display mode and why, once it has started; with no display mode known, none. */
  #facts(template: number | null, display: DisplayMode | null, held?: string | null): GuestFact[] {
    const gpu = held === undefined ? this.#gpuOf(template) : held;
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
    const gpus = this.#gpuIds(offer, (await this.#hostGpus()).report);
    const state = await this.#gpuState(gpus);
    const full = gpus.filter((gpu) => this.#fullUntil([gpu], state) !== null);
    const skip = new Set([...failed, ...this.#avoid.keys(), ...full]);
    return gpus.some((gpu) => !skip.has(gpu)) ? skip : failed;
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
  #freeCount(guests: readonly PoolGuest[]): number {
    const { first, last } = this.#config.vmids;
    const used = new Set<number>([...this.#reserved, ...this.#filling.keys(), ...guests.map((guest) => guest.vmid)]);
    let free = 0;
    for (let vmid = first; vmid <= last; vmid++) if (!used.has(vmid)) free++;
    return free;
  }

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
  #settings(size: MachineSize | null, vmid: number) {
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
  async #grow(api: Proxmox, vmid: number, owner: GuestOwner, wanted: number | null, template: number | null, step: Step, signal?: AbortSignal): Promise<void> {
    if (wanted === null) return;
    const templateDisk = template === null ? null : this.#templates.get(template)?.diskGiB;
    if (templateDisk != null && templateDisk >= wanted) return;
    await step("resize", () => this.#owned(api).growRootDisk(vmid, owner, wanted, signal));
  }

  /** Whether the guest at `vmid` names the box. Box IDs are unique, so no other install's guest does. */
  async #owns(api: Proxmox, vmid: number, boxId: string, signal?: AbortSignal): Promise<boolean> {
    const config = await this.#guestConfig(api, vmid, signal);
    return !!config && boxOwner(this.#context.installId, boxId).owns(config);
  }

  #image(): GuestOwner {
    return imageOwner(this.#context.installId, IMAGE_BOX, IMAGE_TAG);
  }

  async #grantedClaim(api: Proxmox, vmid: number, signal?: AbortSignal): Promise<LedgerClaim | null> {
    const lines = await this.#helperLines(api, signal).catch(() => null);
    const claim = lines?.ledger.get(vmid)?.claim ?? null;
    return claim?.answer === "granted" && claim.part !== "none" && claim.card ? claim : null;
  }

  async #grantedGpu(api: Proxmox, vmid: number, signal?: AbortSignal): Promise<string | null> {
    const lines = await this.#helperLines(api, signal).catch(() => null);
    const claim = lines?.ledger.get(vmid)?.claim;
    return claim?.answer === "granted" && claim.part !== "none" && claim.card ? this.#heldGpu(claim.card) : null;
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
    await this.#ownRange(api, signal);
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
        await this.#cloning(api, vmid, description);
        await api.cloneLinked({ template, vmid, hostname, pool: this.#config.proxmox.pool, description }, signal);
        return vmid;
      } catch (error) {
        if (error instanceof ProxmoxError && error.alreadyExists) {
          await this.#dropUnstarted(api, vmid);
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
      await this.#owned(api).configure(vmid, this.#image(), this.#settings(null, vmid), signal);
      await this.#owned(api).configure(vmid, this.#image(), { tags: [TAG, installTag(this.#context.installId), IMAGE_BOX, templateTag(template)] }, signal);
      await this.#owned(api).start(vmid, this.#image(), signal);
      await this.#waitReady(vmid, build.kind, this.#options.readyTimeoutMs ?? offer.kind.readyTimeoutMs, signal);
      return { ref: String(vmid), command: await this.#command(vmid) };
    } catch (error) {
      if (vmid !== null) {
        await this.#forget(vmid);
        await this.#owned(api).destroy(vmid, this.#image()).catch((cause) => this.#context.logError("remove an image box", cause));
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
    await this.#owned(api).shutdown(vmid, this.#image(), 60, signal);
    await this.#owned(api).configure(
      vmid,
      this.#image(),
      {
        hostname: typeof source.hostname === "string" ? source.hostname : IMAGE_HOSTNAME,
        ...(typeof source.net0 === "string" ? { net0: source.net0 } : {}),
        onboot: false,
        description: `bb-box ${image} image of ${from.kind}, built ${new Date().toISOString().slice(0, 10)} from template ${from.ref}.\n${JSON.stringify(record)}`,
        tags: [TAG, installTag(this.#context.installId), `${IMAGE_TAG}${image}`, `${KIND_TAG}${from.kind}`, templateTag(Number(from.ref)), build],
      },
      signal,
    );
    await this.#owned(api).makeTemplate(vmid, this.#image(), signal);
    await this.#owned(api).configure(vmid, this.#image(), { protection: true }, signal);
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
    const configured = templateOwner(this.#context.installId, target, old);
    await this.#owned(api).writeOn(target, configured, old, { delete: ["protection"] }, signal);
    await this.#owned(api).destroy(target, configured, signal);
    this.#templates.delete(target);
    const pool = this.#config.proxmox.pool;
    if (thin) await api.cloneLinked({ template: source, vmid: target, hostname, pool, description }, signal);
    else await api.cloneFull({ template: source, vmid: target, hostname, storage, pool, description }, signal);
    await this.#owned(api).makeTemplate(target, describedOwner(this.#context.installId, description), signal);
    await this.#owned(api).configure(target, describedOwner(this.#context.installId, description), { description, tags, protection: true }, signal);
    await this.#owned(api).configure(source, this.#image(), { delete: ["protection"] }, signal);
    await this.#owned(api).destroy(source, this.#image(), signal);
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
    if (config.protection) await this.#owned(api).writeOn(vmid, this.#image(), config, { delete: ["protection"] }, signal);
    await this.#owned(api).destroy(vmid, this.#image(), signal);
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
    const was = eitherOwner(this.#boxOf(guest), boxOwner(installId, box.boxId));
    await this.#owned(api).configure(vmid, was, { hostname: box.name, description: describe(box, installId) }, signal);
    await this.#retag(api, vmid, was, (tags) => withStartTag(boxTags(box, installId, templateFromTags(tags)), tags.includes(START_TAG)), signal);
    // A spare's low CPU weight goes back as a box takes it (#888).
    await this.#settle(api, vmid, boxOwner(installId, box.boxId), signal);
    if (from !== box.name) await this.#name(vmid, box.name, signal, from);
  }

  /** Puts back the CPU weight a box's guest had lowered while it started, as the sweep asks for a ready box (#888). */
  async settle(guest: Guest, signal?: AbortSignal): Promise<void> {
    await this.#settleWeight(await this.client(), this.#vmid(guest), this.#boxOf(guest), signal);
  }

  async #settleWeight(api: Proxmox, vmid: number, owner: GuestOwner, signal?: AbortSignal): Promise<void> {
    const owned = this.#owned(api);
    const config = await owned.read(vmid, owner, signal);
    if (!parseTags(config.tags).includes(START_TAG)) return;
    if (Number(config.cpuunits) === START_CPUUNITS) await owned.writeOn(vmid, owner, config, { delete: ["cpuunits"] }, signal);
    await owned.configure(vmid, owner, (now) => ({ tags: withStartTag(parseTags(now.tags), false) }), signal);
  }

  /** settle() for an acquire or a claim: a weight not put back now is put back by the sweep. */
  async #settle(api: Proxmox, vmid: number, owner: GuestOwner, signal?: AbortSignal): Promise<void> {
    await this.#settleWeight(api, vmid, owner, signal).catch((error: unknown) => this.#context.logError("put a new box's CPU weight back", error instanceof Error ? error : new Error(String(error))));
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
  async #sawDisplay(gpu: string | null, display: DisplayMode | null): Promise<void> {
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
      const marked = claimMarkerOf(guest.tags);
      const gpu = marked ? (marked.card ? await this.#heldGpu(marked.card) : null) : this.#gpuOf(templateFromTags(guest.tags));
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
    if (offer?.flavour === "linux") return this.#serverRoom();
    if (!offer?.kind.capabilities.gpu) return { readings: [], fullUntil: null };
    const gpus = this.#gpuIds(offer, (await this.#hostGpus(GPU_REPORT_WAIT_MS)).report);
    const state = await this.#gpuState(gpus, GPU_REPORT_WAIT_MS);
    return {
      readings: gpus.flatMap((id) => {
        const known = state.get(id);
        return known ? [{ id, freeMiB: known.freeMiB, totalMiB: known.totalMiB, at: known.at, neededMiB: DESKTOP_GPU_MIB, source: known.source }] : [];
      }),
      fullUntil: this.#fullUntil(gpus, state),
    };
  }

  #gpuIds(offer: Offer, report: GpuReport | null): string[] {
    const named = gpusOf(offer.config.templates);
    if (!report || !offer.config.templates.some((template) => template.gpu === null)) return named;
    return [...named, ...report.gpus.filter((gpu) => !named.some((id) => namesGpu(id, gpu))).map((gpu) => gpu.uuid)];
  }

  async #serverRoom(): Promise<GpuRoom> {
    const api = await this.client();
    const view = await this.#cardsView(api);
    const ready = await this.#serverReady(api, view);
    if ("why" in ready || view.is !== "on") return { readings: [], fullUntil: null, parts: ["none"], withheld: "why" in ready ? `${api.node}: ${ready.why}` : null };
    const reservations = reservationsOn(this.#cardKey(api));
    const reserved = reservations.live(view.lines, this.#now());
    const gone = reservations.gone(view.lines, this.#now());
    const cards = view.lines.cards.map((card) => {
      const load = loadOf(card, { lines: view.lines, memory: view.memory, installId: this.#context.installId, reserved, vmid: null, gone });
      return { index: card.index, boxes: load.boxes, whole: load.whole !== null, freeMiB: load.freeMiB, totalMiB: view.memory.get(card.uuid)?.totalMiB ?? null };
    });
    const at = parseGpuReport(view.notes)?.at ?? null;
    return { readings: [], fullUntil: null, parts: ["none", "shared"], withheld: null, cards, host: api.node, limit: this.#config.desktop.perGpu, at, neededMiB: SERVER_GPU_MIB };
  }

  #cardKey(api: Proxmox): string {
    return `${this.#config.proxmox.apiUrl}#${api.node}`;
  }

  async #cardsView(api: Proxmox, signal?: AbortSignal): Promise<CardsView> {
    const vm = await api.vmNotes(GPU_REPORT_VM, signal);
    const view = vm ? cardsView(vm.notes, { node: api.node, pool: this.#config.proxmox.pool, vmid: vm.vmid, now: this.#now(), ago }) : NO_CARDS;
    if (view.is !== "none") return view;
    const marked = (await this.#ownGuests(api, signal)).filter((guest) => claimMarkerOf(guest.tags) !== null).length;
    if (!marked) return NO_CARDS;
    return {
      is: "blocked",
      why: `The GPU helper on ${api.node} is not reporting: ${vm ? `VM ${vm.vmid}'s report has no helper line` : `the token can read no VM named ${GPU_REPORT_VM}`}, as while host/setup-gpu.sh restarts the helper or once it is removed, and ${marked === 1 ? "1 guest" : `${marked} guests`} of this install ${marked === 1 ? "carries a GPU marker" : "carry GPU markers"}.`,
      fix: `Try again in a minute. If it lasts, run systemctl status bb-box-gpu as root on ${api.node}, and put the helper back with host/setup-gpu.sh.`,
    };
  }

  async #helperLines(api: Proxmox, signal?: AbortSignal): Promise<HelperLines | null> {
    const vm = await api.vmNotes(GPU_REPORT_VM, signal);
    return vm ? parseHelperLines(vm.notes) : null;
  }

  #answering(api: Proxmox, signal?: AbortSignal): Answering {
    return { read: () => this.#helperLines(api, signal), sleep: this.#options.sleep ?? pause, signal };
  }

  async #ownGuests(api: Proxmox, signal?: AbortSignal): Promise<OwnGuest[]> {
    const install = installTag(this.#context.installId);
    return (await api.listPool(this.#config.proxmox.pool, signal))
      .filter((guest) => guest.type === "lxc" && !guest.template && this.#inRange(guest.vmid) && guest.tags.includes(install))
      .map((guest) => ({ vmid: guest.vmid, tags: guest.tags }));
  }

  #settled(api: Proxmox): Promise<void> {
    this.#settling ??= (async () => {
      const left = await settleOutstanding(this.#answering(api, this.#stopping.signal), () => this.#ownGuests(api, this.#stopping.signal));
      if (left.length) {
        this.#context.logError(
          "GPU claims",
          new Error(`The GPU helper on ${api.node} had not answered ${left.map(({ vmid, marker }) => `CT ${vmid}'s ${marker}`).join(", ")} a minute after bb-box started. bb-box places nothing on their cards and does not start them until it answers. Run bb box doctor.`),
        );
      }
    })().catch((error: unknown) => {
      this.#settling = null;
      throw error;
    });
    return this.#settling;
  }

  #onCards(notes: string, everyCard: boolean): Set<string> {
    const desktop = this.#offers().find((offer) => offer.flavour === "desktop");
    if (!desktop || !this.#context.kind(desktop.kind.id).enabled) return new Set();
    return new Set(this.#templatesByCard(desktop, notes, everyCard).keys());
  }

  #cardsFor(kind: string | null, view: Extract<CardsView, { is: "on" }>): Set<string> {
    if (kind !== null && flavourOf(currentKindId(kind)) === "linux") {
      const linux = this.#offers().find((offer) => offer.flavour === "linux");
      return linux && this.#context.kind(linux.kind.id).enabled ? new Set(view.lines.cards.map((card) => card.uuid)) : new Set();
    }
    return this.#onCards(view.notes, view.writes);
  }

  async #heldGpu(card: string | null): Promise<string | null> {
    if (card === null) return null;
    const { report } = await this.#hostGpus();
    const gpu = report?.gpus.find((candidate) => cardUuid(candidate.uuid) === card);
    const template = gpu ? this.#config.flavours.desktop.templates.find((listed) => listed.gpu !== null && namesGpu(listed.gpu, gpu)) : undefined;
    return template?.gpu ?? `GPU-${card}`;
  }

  #templatesByCard(offer: Offer, notes: string, everyCard = false): Map<string, LxcTemplate[]> {
    const gpus = parseGpuReport(notes)?.gpus ?? [];
    const byCard = new Map<string, LxcTemplate[]>();
    for (const template of offer.config.templates) {
      const named = template.gpu === null ? (everyCard ? gpus : []) : gpus.filter((candidate) => namesGpu(template.gpu!, candidate)).slice(0, 1);
      for (const gpu of named) {
        const card = cardUuid(gpu.uuid);
        byCard.set(card, [...(byCard.get(card) ?? []), template]);
      }
    }
    return byCard;
  }

  async #placement(api: Proxmox, offer: Offer, view: Extract<CardsView, { is: "on" }>, guests: readonly PoolGuest[], refused: ReadonlySet<string>, failed: ReadonlySet<string>): Promise<Placed> {
    const skip = await this.#placing(offer, failed);
    const on = this.#onCards(view.notes, view.writes);
    const byCard = new Map([...this.#templatesByCard(offer, view.notes, view.writes)].filter(([card]) => on.has(card)));
    if (!byCard.size) {
      const ids = offer.config.templates.map((template) => template.gpu ?? `template ${template.vmid}`).join(", ");
      const unnamed = offer.config.templates.every((template) => template.gpu === null);
      return {
        is: "refused",
        reasons: [
          unnamed
            ? "the desktop templates carry no card's device lines, and the GPU helper has writes off, so it cannot give a desktop its card"
            : `no GPU desktop template's GPU ID (${ids}) names a card the GPU helper's report lists; name each by the UUID nvidia-smi -L shows`,
        ],
        loads: [],
      };
    }
    const avoided = this.#cardsAvoided(view.notes, skip);
    const open = [...byCard].filter(([card, templates]) => !refused.has(card) && !avoided.has(card) && templates.some((template) => template.gpu === null || !skip.has(template.gpu)));
    const lastResort = this.#cardsAvoided(view.notes, failed);
    const candidates = new Set((open.length ? open : [...byCard].filter(([card]) => !refused.has(card) && !lastResort.has(card))).map(([card]) => card));
    const reservations = reservationsOn(this.#cardKey(api));
    const install = installTag(this.#context.installId);
    const ours = guests.filter((guest) => guest.type === "lxc" && !guest.template && this.#inRange(guest.vmid) && guest.tags.includes(install)).map((guest) => ({ vmid: guest.vmid, tags: guest.tags }));
    return placeShared({
      lines: view.lines,
      memory: view.memory,
      installId: this.#context.installId,
      reserved: reservations.live(view.lines, this.#now()),
      limit: this.#config.desktop.perGpu,
      needMiB: DESKTOP_GPU_MIB,
      candidates,
      prefer: null,
      vmid: null,
      outstanding: outstandingRequests(view.lines, ours, reservations.inFlight()),
      gone: reservations.gone(view.lines, this.#now()),
    });
  }

  #placementRefused(node: string, placed: Extract<Placed, { is: "refused" }>): string {
    const cpu = this.#offers().some((other) => other.flavour === "desktop-cpu");
    return `${refusalWords(node, placed.reasons)} ${cpu ? "Use a linux-desktop-cpu box, or release a desktop box." : "Release a desktop box, or raise the desktops per GPU."}`;
  }

  async #placeNew(api: Proxmox, offer: Offer, boxId: string | null, refused: ReadonlySet<string>, failed: ReadonlySet<string>, signal?: AbortSignal): Promise<NewPlacement> {
    await this.#settled(api);
    const key = this.#cardKey(api);
    return underCardLock(key, async () => {
      const view = await this.#cardsView(api, signal);
      if (view.is === "blocked") throw new BackendError("no_capacity", blockedWords(view));
      if (view.is === "none") throw new BackendError("no_capacity", `The GPU helper's report on ${api.node} went while bb-box placed a desktop. Try again.`);
      const guests = await api.listPool(this.#config.proxmox.pool, signal);
      const placed = await this.#placement(api, offer, view, guests, refused, failed);
      if (placed.is === "refused") throw new BackendError("no_capacity", this.#placementRefused(api.node, placed));
      const counts = this.#perTemplate(guests);
      const uses = (template: LxcTemplate) => counts.get(template.vmid) ?? 0;
      const template = this.#templatesByCard(offer, view.notes, view.writes)
        .get(placed.card.uuid)!
        .reduce((best, candidate) => (uses(candidate) < uses(best) ? candidate : best));
      const reservation = reservationsOn(key).add(placed.card.uuid, "shared", DESKTOP_GPU_MIB, boxId, null);
      return { card: placed.card, template, reservation, lines: view.lines };
    });
  }

  #askHelper(api: Proxmox, vmid: number, marker: ClaimMarker, signal?: AbortSignal): Promise<MarkAnswer> {
    this.#written.set(vmid, Math.max(this.#written.get(vmid) ?? 0, marker.generation));
    return waitForAnswer(this.#answering(api, signal), vmid, marker);
  }

  async #markedClaim(api: Proxmox, vmid: number, signal?: AbortSignal): Promise<CardClaim | null> {
    const marker = claimMarkerOf(parseTags((await api.config(vmid, signal)).tags));
    if (!marker || marker.part === "none") return null;
    const view = await this.#cardsView(api, signal);
    if (view.is === "none") return null;
    await this.#settled(api);
    const lines = view.is === "on" ? view.lines : await this.#helperLines(api, signal);
    const claim = lines?.ledger.get(vmid)?.claim ?? null;
    const asMarked = claim?.answer === "granted" && claim.generation === marker.generation && claim.part === marker.part && claim.card === marker.card;
    if (asMarked) return claimOf(marker, "granted");
    if (view.is === "blocked") throw new BackendError("no_capacity", blockedWords(view));
    if (marker.generation <= (lines?.ledger.get(vmid)?.answered ?? 0)) return null;
    const answer = await this.#askHelper(api, vmid, marker, signal);
    if (answer.is === "granted") return claimOf(marker, "granted");
    throw new BackendError("no_capacity", answer.is === "refused" ? `The host's GPU helper on ${api.node} refused CT ${vmid}'s marker ${markerTag(marker)}, as ${answer.why}. bb-box released the guest; nothing else changed.` : notAnsweredWords(api.node, answer));
  }

  async #writeMarker(api: Proxmox, vmid: number, marker: ClaimMarker, owner: GuestOwner, signal?: AbortSignal, also: GuestSettings = {}): Promise<void> {
    await this.#owned(api).configure(vmid, owner, (config) => ({ tags: withMarker(parseTags(config.tags), marker), ...also }), signal);
    this.#written.set(vmid, Math.max(this.#written.get(vmid) ?? 0, marker.generation));
  }

  async #answered(api: Proxmox, vmid: number, marker: ClaimMarker, signal?: AbortSignal): Promise<{ readonly view: CardsView; readonly granted: boolean; readonly answer: MarkAnswer }> {
    for (let waited = 0; ; waited += ANSWER_POLL_MS) {
      const view = await this.#cardsView(api, signal);
      const lines = view.is === "on" ? view.lines : await this.#helperLines(api, signal);
      const answer: MarkAnswer = lines?.ledgerReported ? answerTo(lines, vmid, marker, true) : { is: "unanswered" };
      if (answer.is === "granted" && view.is !== "none") return { view, granted: true, answer };
      if (view.is === "on" && (answer.is === "refused" || marker.generation <= (lines?.ledger.get(vmid)?.answered ?? 0))) {
        return { view, granted: false, answer: answer.is === "refused" ? answer : { is: "refused", why: "the helper answered it and holds another claim for it" } };
      }
      if (view.is === "on" && !view.writes && answer.is === "would") return { view, granted: false, answer };
      if (waited >= ANSWER_WAIT_MS) return { view, granted: false, answer };
      await (this.#options.sleep ?? pause)(ANSWER_POLL_MS, signal);
    }
  }

  async #askAgain(api: Proxmox, vmid: number, owner: GuestOwner, onGuest: number, claim: { readonly part: GpuPart; readonly card: string | null }, lines: HelperLines, notStarted: (why: string) => Error, signal?: AbortSignal): Promise<ClaimMarker> {
    const again: ClaimMarker = { part: claim.part, card: claim.card, generation: nextGeneration(lines, vmid, onGuest, this.#written.get(vmid) ?? 0) };
    await this.#writeMarker(api, vmid, again, owner, signal);
    const answer = await this.#askHelper(api, vmid, again, signal);
    if (answer.is === "refused") throw notStarted(`the host's GPU helper refused ${markerTag(again)}, as ${answer.why}.`);
    if (answer.is !== "granted") throw notStarted(notAnsweredWords(api.node, answer));
    return again;
  }

  #gpuIdOf(card: string | null, notes: string): string | null {
    if (card === null) return null;
    const desktop = this.#offers().find((offer) => offer.flavour === "desktop");
    const named = desktop ? this.#templatesByCard(desktop, notes).get(card)?.[0]?.gpu : undefined;
    return named ?? `GPU-${card}`;
  }

  async #gateStart(
    api: Proxmox,
    vmid: number,
    owner: GuestOwner,
    signal?: AbortSignal,
    notStartedWords = (why: string) => `Container ${vmid} was not started: ${why} It is stopped, with its disk as it was.`,
    leaving: ReadonlySet<string> = NO_GPUS,
  ): Promise<StartGate> {
    const tags = parseTags((await this.#owned(api).read(vmid, owner, signal)).tags);
    const marker = claimMarkerOf(tags);
    const kind = tags.find((tag) => tag.startsWith(KIND_TAG))?.slice(KIND_TAG.length) ?? null;
    const server = kind !== null && flavourOf(currentKindId(kind)) === "linux";
    if (!marker || marker.part === "none") return UNGATED;
    await this.#settled(api);
    const notStarted = (why: string) => new Error(notStartedWords(why));
    const { view, granted, answer } = await this.#answered(api, vmid, marker, signal);
    if (view.is === "none") return UNGATED;
    if (view.is === "blocked") {
      if (granted) return { claim: claimOf(marker, "granted"), reservation: null, gpu: await this.#heldGpu(marker.card) };
      throw notStarted(`bb-box cannot see a grant of its GPU marker ${markerTag(marker)}. ${view.why}${view.fix ? ` ${view.fix}` : ""}`);
    }
    const gpu = (claim: CardClaim): StartGate => ({ claim, reservation: null, gpu: this.#gpuIdOf(claim.card, view.notes) });
    const claim = view.lines.ledger.get(vmid)?.claim ?? null;
    const standing = claim?.answer === "granted" && claim.part !== "none" && claim.card !== null && view.lines.cards.some((card) => card.uuid === claim.card) ? claim : null;
    const unanswered = () => notStarted(answer.is === "refused" ? `the host's GPU helper refused its marker ${markerTag(marker)}, as ${answer.why}.` : notAnsweredWords(api.node, answer));
    if (!view.writes) {
      if (granted) return gpu(claimOf(marker, "granted"));
      if (!standing) throw unanswered();
      return gpu(claimOf(await this.#askAgain(api, vmid, owner, marker.generation, standing, view.lines, notStarted, signal), "granted"));
    }
    if (granted && marker.part === "whole") return gpu(claimOf(marker, "granted"));
    if (!granted && answer.is !== "refused") throw unanswered();
    if (!granted && standing?.part === "whole") return gpu(claimOf(await this.#askAgain(api, vmid, owner, marker.generation, standing, view.lines, notStarted, signal), "granted"));
    const key = this.#cardKey(api);
    const reservations = reservationsOn(key);
    const decided = await underCardLock(key, async () => {
      const fresh = await this.#cardsView(api, signal);
      if (fresh.is !== "on") throw notStarted(fresh.is === "blocked" ? blockedWords(fresh) : `the GPU helper's report on ${api.node} went.`);
      const ours = (await this.#ownGuests(api, signal)).filter((guest) => guest.vmid !== vmid);
      const placed = placeShared({
        lines: fresh.lines,
        memory: fresh.memory,
        installId: this.#context.installId,
        reserved: reservations.live(fresh.lines, this.#now()),
        limit: this.#config.desktop.perGpu,
        needMiB: 0,
        candidates: new Set([...this.#cardsFor(kind, fresh), ...(standing?.card ? [standing.card] : [])].filter((card) => !leaving.has(card))),
        prefer: standing?.card ?? claim?.card ?? marker.card,
        vmid,
        outstanding: outstandingRequests(fresh.lines, ours, reservations.inFlight()),
        gone: reservations.gone(fresh.lines, this.#now()),
      });
      if (placed.is === "refused") throw notStarted(`${refusalWords(api.node, placed.reasons)} Release another desktop box, or start it again later.`);
      return { card: placed.card, lines: fresh.lines, notes: fresh.notes, reservation: reservations.add(placed.card.uuid, "shared", server ? SERVER_GPU_MIB : DESKTOP_GPU_MIB, null, vmid) };
    });
    if (granted && decided.card.uuid === marker.card) return { claim: claimOf(marker, "granted"), reservation: decided.reservation, gpu: this.#gpuIdOf(marker.card, decided.notes) };
    const moved: ClaimMarker = { part: "shared", card: decided.card.uuid, generation: nextGeneration(decided.lines, vmid, marker.generation, this.#written.get(vmid) ?? 0) };
    try {
      await this.#writeMarker(api, vmid, moved, owner, signal);
      const movedAnswer = await this.#askHelper(api, vmid, moved, signal);
      if (movedAnswer.is === "refused") throw notStarted(`the host's GPU helper refused ${cardName(decided.card)}, as ${movedAnswer.why}.`);
      if (movedAnswer.is !== "granted") throw notStarted(notAnsweredWords(api.node, movedAnswer));
      return { claim: claimOf(moved, "granted"), reservation: decided.reservation, gpu: this.#gpuIdOf(moved.card, decided.notes) };
    } catch (error) {
      reservations.drop(decided.reservation);
      throw error;
    }
  }

  async #choice(api: Proxmox, offer: Offer, guests: readonly PoolGuest[], pending: readonly Pending[], signal?: AbortSignal, gpu: GpuPart = gpuPartOf(offer, null)): Promise<Choice> {
    if (offer.flavour === "linux" && gpu !== "none") return this.#serverChoice(api, offer, guests, signal);
    if (offer.flavour === "desktop" && gpu === "none") {
      return offersGpuPart(offer.kind, "none") ? this.#noCardChoice(offer, guests, api.node) : this.#choose(forkOfDesktopWithNoCard(offer), guests, pending, api.node);
    }
    const before = this.#choose(offer, guests, pending, api.node);
    if (!offer.kind.capabilities.gpu) return before;
    const view = await this.#cardsView(api, signal);
    if (view.is === "none") return before;
    if (view.is === "blocked") return { ...before, problem: blockedWords(view) };
    const placed = await this.#placement(api, offer, view, guests, NO_GPUS, NO_GPUS);
    const acquiring = [...this.#acquiring.values()].filter((acquire) => acquire.flavour === offer.flavour);
    const waiting = pending.filter((other) => flavourOf(other.kind) === offer.flavour).length;
    const unplaced = Math.max(0, waiting - acquiring.length) + acquiring.filter((acquire) => acquire.template === null).length;
    const limit = this.#config.desktop.perGpu;
    const own = placed.loads.reduce((sum, load) => sum + load.own, 0);
    const room = limit === null ? null : placed.loads.reduce((sum, load) => sum + Math.max(0, limit - load.own), 0);
    const gpus = { used: own + unplaced, total: limit === null ? null : limit * placed.loads.length };
    if (placed.is === "refused") return { template: before.template, gpus, problem: this.#placementRefused(api.node, placed) };
    const counts = this.#perTemplate(guests);
    const uses = (template: LxcTemplate) => counts.get(template.vmid) ?? 0;
    const template = this.#templatesByCard(offer, view.notes, view.writes)
      .get(placed.card.uuid)!
      .reduce((best, candidate) => (uses(candidate) < uses(best) ? candidate : best));
    const full = room !== null && room <= unplaced;
    return { template, gpus, problem: full ? this.#placementRefused(api.node, { is: "refused", reasons: placed.loads.map((load) => `${cardName(load.card)} has ${load.own} of this install's boxes`), loads: placed.loads }) : null };
  }

  #noCardChoice(offer: Offer, guests: readonly PoolGuest[], node: string): Choice {
    const counts = this.#perTemplate(guests);
    const templates = offer.config.templates.filter((template) => template.gpu === null);
    if (!templates.length) {
      return refusedChoice(offer.config.templates[0]!, {
        person: `Every desktop template on ${node} carries a card's device lines, so none gives a desktop with no GPU. Ask for linux-desktop-cpu, or build a desktop template with no card with build.sh desktop, as root on ${node}.`,
        agent: `Not made: every desktop template on ${node} carries a card. Ask for linux-desktop-cpu, or ask the user. bb-box changed nothing.`,
      });
    }
    return { template: templates.reduce((best, template) => ((counts.get(template.vmid) ?? 0) < (counts.get(best.vmid) ?? 0) ? template : best)), gpus: null, problem: null };
  }

  async #serverTemplates(api: Proxmox, driver: string | null, signal?: AbortSignal): Promise<{ readonly fitting: LxcTemplate[]; readonly others: string[] }> {
    const fitting: LxcTemplate[] = [];
    const others: string[] = [];
    for (const template of this.#config.flavours.linux.templates) {
      const userspace = await api.config(template.vmid, signal).then(templateUserspace, () => null);
      if (userspace !== null && userspace === driver) fitting.push(template);
      else others.push(`template ${template.vmid} has ${userspace === null ? "none" : userspace}`);
    }
    return { fitting, others };
  }

  #leastUsed(templates: readonly LxcTemplate[], guests: readonly PoolGuest[]): LxcTemplate {
    const counts = this.#perTemplate(guests);
    return templates.reduce((best, template) => ((counts.get(template.vmid) ?? 0) < (counts.get(best.vmid) ?? 0) ? template : best));
  }

  async #serverReady(api: Proxmox, view: CardsView, signal?: AbortSignal): Promise<{ readonly templates: LxcTemplate[] } | { readonly why: string; readonly fix: string }> {
    const node = api.node;
    if (view.is === "none") return { why: "it has no GPU helper to give a box a card", fix: `Set up the helper with host/setup-gpu.sh, as root on ${node}.` };
    if (view.is === "blocked") return { why: sentenceStart(view.why), fix: view.fix ?? "Run bb box doctor." };
    if (!view.writes) return { why: "its GPU helper has writes off, so it gives no box a card", fix: `Turn writes on with host/setup-gpu.sh --writes on --check, then --writes on, as root on ${node}.` };
    const untested = await this.#untestedHere(api, signal);
    if (untested) return { why: "its GPU helper was not tested on the node's pve-container, so it gives no box a card", fix: untested };
    const driver = reportedDriver(view.notes);
    const { fitting, others } = await this.#serverTemplates(api, driver, signal);
    if (!fitting.length) {
      return { why: `no Linux template there has NVIDIA's userspace for its driver ${driver ?? "(not reported)"}: ${others.join(", ")}`, fix: `Rebuild one with build.sh linux <vmid> --replace, as root on ${node}.` };
    }
    return { templates: fitting };
  }

  async #checkCard(api: Proxmox, vmid: number, card: string, signal?: AbortSignal): Promise<CardCheck> {
    const result = await (await this.#command(vmid)).run(CARD_CHECK_COMMAND, { timeoutMs: 30_000, signal, maxOutputBytes: 8192 }).catch((error: unknown) => {
      if (signal?.aborted) throw error;
      this.#context.logError("check a box's card", new Error(`bb-box could not run nvidia-smi in CT ${vmid}, so it went on without the check: ${message(error)}`));
      return null;
    });
    if (!result) return { ok: true, card: { uuid: card, model: "", memoryMiB: null } };
    const driver = await this.#helperDriver(api, signal);
    return judgeCardCheck(`${result.stdout}\n${result.stderr}`, card, driver);
  }

  async #helperDriver(api: Proxmox, signal?: AbortSignal): Promise<string | null> {
    const vm = await api.vmNotes(GPU_REPORT_VM, signal).catch(() => null);
    return vm ? reportedDriver(vm.notes) : null;
  }

  async #cardFact(api: Proxmox, part: GpuPart, card: string, seen: CardCheck | null, lines: HelperLines | null, signal?: AbortSignal): Promise<string> {
    const known = lines ?? (await this.#helperLines(api, signal).catch(() => null));
    const index = known?.cards.find((listed) => listed.uuid === card)?.index ?? null;
    return cardFactWords(part, index, seen?.ok ? seen.card : null);
  }

  async #checkCards(signal: AbortSignal): Promise<void> {
    if (this.#now() - this.#cardsCheckedAt < CARD_CHECK_EVERY_MS) return;
    this.#cardsCheckedAt = this.#now();
    const api = await this.client();
    const lines = await this.#helperLines(api, signal);
    if (!lines?.ledgerReported) return;
    const install = installTag(this.#context.installId);
    const checked = new Set<number>();
    for (const guest of await api.listPool(this.#config.proxmox.pool, signal)) {
      if (guest.type !== "lxc" || guest.template || guest.status !== "running" || !this.#inRange(guest.vmid) || !guest.tags.includes(install) || guest.tags.includes(FILLING)) continue;
      const claim = lines.ledger.get(guest.vmid)?.claim ?? null;
      const marker = claimMarkerOf(guest.tags);
      if (claim?.answer !== "granted" || claim.part === "none" || !claim.card || marker?.card !== claim.card) continue;
      checked.add(guest.vmid);
      const result = await (await this.#command(guest.vmid)).run(CARDS_SEEN_COMMAND, { timeoutMs: 15_000, signal, maxOutputBytes: 4096 }).catch(() => null);
      if (!result) continue;
      const seen = cardsSeenIn(result.stdout) ?? [];
      if (seen.includes(claim.card)) this.#mismatches.delete(guest.vmid);
      else {
        if (!this.#mismatches.has(guest.vmid)) this.#context.logError("check boxes' cards", new Error(`CT ${guest.vmid} holds card ${claim.card}, and nvidia-smi in it lists ${seen.length ? seen.join(" and ") : "no card"}. bb-box places no new box on either card until it is put right, and does not stop it: Restart places it again.`));
        this.#mismatches.set(guest.vmid, { card: claim.card, seen, at: this.#now() });
      }
    }
    for (const vmid of this.#mismatches.keys()) if (!checked.has(vmid)) this.#mismatches.delete(vmid);
  }

  #cardsNamed(notes: string, ids: Iterable<string>): Set<string> {
    const gpus = parseGpuReport(notes)?.gpus ?? [];
    const named = new Set<string>();
    for (const id of ids) for (const gpu of gpus) if (namesGpu(id, gpu)) named.add(cardUuid(gpu.uuid));
    return named;
  }

  #cardsAvoided(notes: string, failed: ReadonlySet<string>): Set<string> {
    const now = Date.now();
    for (const [gpu, until] of this.#avoid) if (until <= now) this.#avoid.delete(gpu);
    const mismatched = [...this.#mismatches.values()].flatMap((mismatch) => [mismatch.card, ...mismatch.seen]);
    return new Set([...this.#cardsNamed(notes, [...failed, ...this.#avoid.keys()]), ...mismatched]);
  }

  #serverPlacement(api: Proxmox, view: Extract<CardsView, { is: "on" }>, guests: readonly PoolGuest[], refused: ReadonlySet<string>, failed: ReadonlySet<string>): Placed {
    const reservations = reservationsOn(this.#cardKey(api));
    const install = installTag(this.#context.installId);
    const ours = guests.filter((guest) => guest.type === "lxc" && !guest.template && this.#inRange(guest.vmid) && guest.tags.includes(install)).map((guest) => ({ vmid: guest.vmid, tags: guest.tags }));
    const avoided = this.#cardsAvoided(view.notes, failed);
    const reserved = reservations.live(view.lines, this.#now());
    const gone = reservations.gone(view.lines, this.#now());
    const reasons: string[] = [];
    const candidates = new Set<string>();
    for (const card of view.lines.cards) {
      if (refused.has(card.uuid)) reasons.push(`the GPU helper refused ${cardName(card)} for this box`);
      else if (avoided.has(card.uuid)) reasons.push(`${cardName(card)} is left out for now, as a box lately did not see it`);
      else {
        const load = loadOf(card, { lines: view.lines, memory: view.memory, installId: this.#context.installId, reserved, vmid: null, gone });
        if (load.freeMiB !== null && load.freeMiB < SERVER_GPU_MIB) reasons.push(`${cardName(card)} has ${load.freeMiB} MiB free when last read, less than the ${SERVER_GPU_MIB} MiB a new server needs`);
        else candidates.add(card.uuid);
      }
    }
    const placed = placeShared({
      lines: view.lines,
      memory: view.memory,
      installId: this.#context.installId,
      reserved,
      limit: this.#config.desktop.perGpu,
      needMiB: SERVER_GPU_MIB,
      candidates,
      prefer: null,
      vmid: null,
      outstanding: outstandingRequests(view.lines, ours, reservations.inFlight()),
      gone,
    });
    return placed.is === "refused" ? { ...placed, reasons: [...reasons, ...placed.reasons] } : placed;
  }

  #placementReasons(placed: Extract<Placed, { is: "refused" }>): string {
    const reasons = placed.reasons;
    if (reasons.length <= 1) return reasons.join("");
    return `${reasons.slice(0, -1).join(", ")} and ${reasons.at(-1)}`;
  }

  async #serverChoice(api: Proxmox, offer: Offer, guests: readonly PoolGuest[], signal?: AbortSignal): Promise<Choice> {
    const before = this.#leastUsed(offer.config.templates, guests);
    const view = await this.#cardsView(api, signal);
    const ready = await this.#serverReady(api, view, signal);
    if ("why" in ready) return refusedChoice(before, serverRefusal(api.node, ready.why, ready.fix));
    const placed = this.#serverPlacement(api, view as Extract<CardsView, { is: "on" }>, guests, NO_GPUS, NO_GPUS);
    const template = this.#leastUsed(ready.templates, guests);
    if (placed.is === "refused") return refusedChoice(template, noCardRoomRefusal(api.node, this.#placementReasons(placed)));
    return { template, gpus: null, problem: null };
  }

  async #placeServer(api: Proxmox, boxId: string, refused: ReadonlySet<string>, failed: ReadonlySet<string>, signal?: AbortSignal): Promise<NewPlacement> {
    await this.#settled(api);
    const ready = await this.#serverReady(api, await this.#cardsView(api, signal), signal);
    if ("why" in ready) throw new BackendError("no_capacity", serverRefusal(api.node, ready.why, ready.fix).person);
    const key = this.#cardKey(api);
    return underCardLock(key, async () => {
      const view = await this.#cardsView(api, signal);
      if (view.is !== "on" || !view.writes) throw new BackendError("no_capacity", `The GPU helper's report on ${api.node} changed while bb-box placed a server. Try again.`);
      const guests = await api.listPool(this.#config.proxmox.pool, signal);
      const placed = this.#serverPlacement(api, view, guests, refused, failed);
      if (placed.is === "refused") throw new BackendError("no_capacity", noCardRoomRefusal(api.node, this.#placementReasons(placed)).person);
      const reservation = reservationsOn(key).add(placed.card.uuid, "shared", SERVER_GPU_MIB, boxId, null);
      return { card: placed.card, template: this.#leastUsed(ready.templates, guests), reservation, lines: view.lines };
    });
  }

  async markGpus(request: GpuMarkRequest, signal?: AbortSignal): Promise<GpuMarking> {
    return markGpus(await this.client(), this.#markingSetup(), request, signal);
  }

  #markingSetup(): MarkingSetup {
    return {
      backend: this.id,
      label: this.label,
      pool: this.#config.proxmox.pool,
      installId: this.#context.installId,
      reportVm: GPU_REPORT_VM,
      madeAndRemovedByBbBox: (tags) => tags.includes(FILLING) || tags.includes(RETIRED) || tags.includes(IMAGE_BOX) || tags.some((tag) => tag.startsWith(IMAGE_TAG)),
      now: () => this.#now(),
      sleep: this.#options.sleep ?? pause,
      ago,
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
          const stored = await storedKeyPair(this.#context.storage, SSH_KEY);
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
      const out: { readonly vmid: number; readonly warm: GuestOwner }[] = [];
      for (const guest of guests) {
        if (!guest.tags.includes(WARM) || guest.type !== "lxc" || guest.template || !this.#inRange(guest.vmid) || this.#filling.has(guest.vmid)) continue;
        if (installFromTags(guest.tags) !== this.#context.installId) continue;
        const flavour = this.warmOf(guest, builds)?.flavour;
        const count = flavour ? (kept.get(flavour) ?? 0) : 0;
        if (flavour && guest.status === "running" && count < this.#warmTarget(flavour)) {
          kept.set(flavour, count + 1);
          continue;
        }
        const warm = warmOwner(this.#context.installId, String((await this.#guestConfig(api, guest.vmid, signal))?.description ?? ""));
        await this.#owned(api).configure(guest.vmid, warm, { tags: [TAG, installTag(this.#context.installId), RETIRED] }, signal);
        out.push({ vmid: guest.vmid, warm });
      }
      return out;
    });
    for (const { vmid, warm } of retired) {
      await this.#forget(vmid);
      await this.#owned(api).destroy(vmid, warm, signal).catch((error) => this.#context.logError("retire a warm box", error));
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
      const untested = offer.kind.capabilities.gpu && target - ready - filling > 0 ? await this.#untestedHere(api, signal) : null;
      if (untested) {
        short.push({ kinds: FLAVOUR_KINDS[flavour].filter((kind) => this.#context.warm(kind) > 0), count: target, have: ready + filling, reason: untested });
        continue;
      }
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
    let placed: NewPlacement | null = null;
    let warmGuest: GuestOwner | null = null;
    try {
      const guests = await api.listPool(this.#config.proxmox.pool, signal);
      const view = offer.kind.capabilities.gpu ? await this.#cardsView(api, signal) : NO_CARDS;
      if (view.is === "blocked") throw new Error(blockedWords(view));
      if (view.is === "on") placed = await this.#placeNew(api, offer, null, NO_GPUS, NO_GPUS, signal);
      const template = placed ? placed.template.vmid : this.#choose(offer, guests, [], api.node, await this.#placing(offer)).template.vmid;
      // Read before the clone, so it is never newer than the clone's build. A
      // template replaced in between retires the guest later, which is safe.
      const build = await templateBuild(api, guests, template, signal);
      const tags = (state: string) => [TAG, install, state, templateTag(template), ...(build ? [`${BUILD}${build}`] : [])];
      const made = `bb-box warm ${flavour}\ninstall ${this.#context.installId}\nwarm ${randomBytes(6).toString("hex")}`;
      warmGuest = warmOwner(this.#context.installId, made);
      vmid = await this.#clone(
        api,
        guests,
        template,
        WARM_HOSTNAME,
        made,
        async (id) => {
          this.#filling.set(id, template);
          claimed.push(id);
        },
        signal,
      );
      if (placed) placed.reservation.vmid = vmid;
      reservationsOn(this.#cardKey(api)).made(vmid);
      // At the template's size: a claim sets the box's. A low CPU weight until a box takes it and it is ready (#888).
      const cloned = await this.#owned(api).read(vmid, warmGuest, signal);
      const low = startsLow(cloned);
      await this.#owned(api).writeOn(vmid, warmGuest, cloned, { ...this.#settings(null, vmid), ...(low ? LOW : {}) }, signal);
      const asked: ClaimMarker | null = placed ? { part: "shared", card: placed.card.uuid, generation: nextGeneration(placed.lines, vmid, 0, this.#written.get(vmid) ?? 0) } : null;
      const marked = asked ? [markerTag(asked)] : [];
      await this.#owned(api).configure(vmid, warmGuest, { tags: [...withStartTag(tags(FILLING), low), ...marked] }, signal);
      if (asked && placed) {
        const answer = await this.#askHelper(api, vmid, asked, signal);
        if (answer.is === "refused") throw new Error(`The host's GPU helper on ${api.node} refused ${cardName(placed.card)} for a warm linux-desktop box, as ${answer.why}, so bb-box released it.`);
        if (answer.is !== "granted") throw new Error(notAnsweredWords(api.node, answer));
      }
      await this.#owned(api).start(vmid, warmGuest, signal);
      await this.#waitReady(vmid, offer.kind.id, this.#options.readyTimeoutMs ?? offer.kind.readyTimeoutMs, signal);
      if (offer.kind.capabilities.gpu) {
        const display = await this.#displayMode(vmid, offer.kind.id, this.#options.readyTimeoutMs ?? offer.kind.readyTimeoutMs, signal);
        await this.#sawDisplay(this.#gpuOf(template), display);
        if (display.mode !== "gpu") {
          this.#avoidGpu(this.#gpuOf(template));
          throw new Error(`A warm linux-desktop box started without GPU ${this.#gpuOf(template) ?? "unknown"} (${display.reason || "no reason given"}), so bb-box released it.`);
        }
      }
      await this.#owned(api).configure(vmid, warmGuest, { tags: [...withStartTag(tags(WARM), low), ...marked] }, signal);
      reservationsOn(this.#cardKey(api)).settle(placed?.reservation ?? null, this.#now());
    } catch (error) {
      reservationsOn(this.#cardKey(api)).drop(placed?.reservation ?? null);
      if (vmid !== null) {
        await this.#forget(vmid);
        if (warmGuest) await this.#owned(api).destroy(vmid, warmGuest).catch((cause) => this.#context.logError("release a failed warm box", cause));
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
  readonly #sizes = new Map<string, MachineSize>();
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

  sizeOf(ref: string): MachineSize | null {
    return this.#sizes.get(ref) ?? null;
  }

  hold(member: PoolMember, box: BoxIdentity, signal?: AbortSignal): Promise<void> {
    return this.#backend.hold(member, box, this.templateOf(member.ref), signal);
  }
}
