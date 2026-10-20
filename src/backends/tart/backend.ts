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
// - Windows boxes (046) are VMs QEMU runs on Apple's Hypervisor framework
//   (qemu.ts). Each has two ports on the Mac's loopback, for SSH and QEMU's
//   VNC server, reached through the Mac. Stop saves its memory to a file and
//   start restores it, as a box that takes a warm VM does. A running one
//   counts its memory and QEMU's own, but not against the two macOS VMs.

import type { CheckId } from "../../core/checks.ts";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { quote } from "../../transports/process.ts";
import { setupDir } from "../setup-dir.ts";
import { startMacInput, tartTypesAsCharacter } from "../../core/mac-input.ts";
import { MAC_STREAM, MAC_VIDEO, macStreamCommand } from "../mac-stream.ts";
import { EXIT, grantInput, parseGrant, parseGranted } from "../ssh-pool/protocol.ts";
import { pause, waitUntilAnswers } from "../../transports/ready.ts";
import { KeyFile, Ssh, SshTransport, generateKeyPair, publicKey } from "../../transports/ssh.ts";
import {
  MIN_DESKTOP,
  TransportError,
  type BoxPointer,
  type Display,
  type DisplayInputEvents,
  type DisplayOpened,
  type DisplaySize,
  type GuestOs,
  type RunResult,
  type SshAccess,
} from "../../transports/types.ts";
import {
  BackendError,
  type AcquireHooks,
  type Backend,
  type BackendContext,
  type BackendImages,
  type BoxGrants,
  type BoxIdentity,
  type BoxKind,
  type BoxOwner,
  type BoxSize,
  type BoxTransports,
  type Capacity,
  type ResizePlan,
  type Resizing,
  type CommandCapability,
  type ComputerUse,
  type DoctorCheck,
  type DoctorReport,
  type Footprint,
  type GrantAnswer,
  type GrantRequest,
  type Guest,
  type HeldGuest,
  type HostCapacity,
  type ImageBox,
  type ImageBuild,
  type Limit,
  type PoolMember,
  type PowerState,
  type ReleaseHooks,
  type StopReason,
  type WarmShortfall,
} from "../types.ts";
import { sizesCheck } from "../fit.ts";
import { WINDOWS_HARDWARE_CURSOR, judgeImage, recordFromJson, type ImageJudgement, type ImageRecord } from "../images.ts";
import { ReadyPool } from "../pool.ts";
import { Upkeep } from "../warm.ts";
import { CUA_PIPE, WINDOWS_STREAM, WINDOWS_STREAM_EXE, WINDOWS_VIDEO, followWindowsPointer, compileDisplay, desktopUp, extendC, setClock, setMode, QEMU_KEY_DELAY_MS, windowsCharacterInput, windowsPointer, windowsTypesAsCharacter } from "../windows.ts";
import type { OpenStream } from "../../core/selkies.ts";
import { SELKIES_DISPLAY, SELKIES_LAUNCHER, selkiesDisplay } from "../selkies.ts";
import { openRoute } from "../../transports/route.ts";
import { TART_KINDS, type TartConfig, type TartHost, type TartKind } from "./config.ts";
import {
  captureScript,
  claimScript,
  detachedBuildScript,
  followBuildScript,
  parseFollow,
  stopBuildScript,
  cloneScript,
  deleteScript,
  forgetImageScript,
  replaceScript,
  baseScript,
  pruneBaseScript,
  discardStateScript,
  holdScript,
  relabelScript,
  endReason,
  endedScript,
  ownerScript,
  ipScript,
  holderScript,
  ownerText,
  parseConfig,
  macScript,
  normalMac,
  parseEnded,
  parseFields,
  parseMacs,
  parseState,
  powerScript,
  startScript,
  script,
  sizeScript,
  stateScript,
  stopScript,
  vmName,
  warmScript,
  VM_PREFIX,
  type HostState,
  type VmConfig,
} from "./host.ts";
import { VNC_BRIDGE_PY } from "./vnc-holder.ts";
import {
  parseQemuState,
  parseQemuVm,
  qemuBuildsScript,
  qemuCaptureScript,
  qemuCloneScript,
  qemuDeleteScript,
  qemuRemoveBuildScript,
  qemuReplaceScript,
  parseQemuBuilds,
  qemuDiscardScript,
  qemuEndedScript,
  qemuPowerScript,
  qemuStartScript,
  qemuStateBody,
  qemuStopScript,
  qemuWarmScript,
  type QemuState,
  type QemuVm,
} from "./qemu.ts";
import { parseQemuVideo, qemuVideoBuild, qemuVideoBuildScript, qemuVideoOpenScript, qemuVideoSource, qemuVideoSourcePath, qemuVideoStateBody, type QemuVideo } from "./qemu-video.ts";

const SSH_KEY = "ssh-key";
const READY_TIMEOUT_MS = 5 * 60_000;
/** Cua Driver as the images pin it (015). The setup guide's image script installs this release. */
export const CUA_VERSION = "0.30.4";
const MiB_PER_GiB = 1024;

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

/** The user Windows boxes work as: an administrator, whose SSH session is elevated (039). */
const WINDOWS_USER = "box";
const WINDOWS_READY_TIMEOUT_MS = 3 * 60_000;
const WINDOWS_DESKTOP_POLL_MS = 1_000;
const WINDOWS_COMMAND: CommandCapability = { transport: "ssh", shell: "powershell", admin: true, inDesktopSession: false, streaming: true };
/** Cua Driver in the Windows image, on its named pipe, as on Proxmox (039). */
const WINDOWS_CUA: ComputerUse = { driver: "cua", version: CUA_VERSION, socket: CUA_PIPE };
/** What QEMU takes of the Mac's memory beyond a running Windows VM's own (046). */
const QEMU_OVERHEAD_MIB = 2048;

/** The guest OS of a Tart kind: linux-arm64 and its kin, windows-arm64-desktop, or macOS. */
export function guestOsOf(kind: string): GuestOs {
  if (kind.startsWith("windows")) return "windows";
  return kind.startsWith("linux") ? "linux" : "macos";
}

/** What a box takes of its Mac's memory while it runs: a Windows box's QEMU takes more than the box's memory. */
function footprint(kind: string, size: BoxSize): number {
  return size.memoryMiB + (guestOsOf(kind) === "windows" ? QEMU_OVERHEAD_MIB : 0);
}

/** A Mac's state: Tart's VMs and the Mac's own (host.ts), and QEMU's VMs (qemu.ts). */
/** `qemuVideo`: the Mac's build of bb-box-stream for Windows video (#865); null while Windows boxes are off. */
type MacState = HostState & { readonly qemu: QemuState; readonly qemuVideo: QemuVideo | null };

type Step = <T>(name: string, run: () => Promise<T>) => Promise<T>;

/** Where an image's record is in it (049): macOS keeps /usr/share read-only. */
const RECORD_PATH: Readonly<Record<string, string>> = { linux: "/usr/share/bb-box/image.json", macos: "/usr/local/share/bb-box/image.json" };

/**
 * A macOS box's checks as its user (049), as its image has no check of its
 * own: the tools and Cua Driver, and Xcode and bb-box-stream where its
 * record says it has them (#475, 060), a line per check, with ok or FAIL.
 */
export const MAC_CHECK = String.raw`t() { name=$1; shift; if out=$("$@" 2>&1); then echo "$name ok   $(echo "$out" | head -n 1)"; else echo "$name FAIL $(echo "$out" | head -n 1)"; fi; }
t node node --version
t git git --version
t cua-driver /usr/local/bin/cua-driver --version
t "image record" test -s /usr/local/share/bb-box/image.json
if grep -q '"bb-box-stream"' /usr/local/share/bb-box/image.json 2>/dev/null; then
  t bb-box-stream test -x /usr/local/bin/bb-box-stream
fi
if grep -q '"chrome"' /usr/local/share/bb-box/image.json 2>/dev/null; then
  t chrome "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version
  t "chrome policies, as Chrome applies them" sh -c 'node /usr/local/libexec/bb-box/chrome-policies.mjs | grep -x "DefaultBrowserSettingEnabled false .* OK"'
  t "chrome past its first run" test -e "$HOME/Library/Application Support/Google/Chrome/First Run"
fi
if grep -q '"xcode"' /usr/local/share/bb-box/image.json 2>/dev/null; then
  t xcode xcodebuild -version
  t "xcode licence and first launch" sh -c 'xcodebuild -license check && xcodebuild -checkFirstLaunchStatus'
  t metal xcrun -f metal
  t "ios simulator" sh -c 'xcrun simctl list runtimes | grep -m 1 "^iOS "'
fi`;

/** The check a trial box of each kind runs: a Linux image's own, after its display is up, or macOS's above. */
/**
 * Windows' shared check (setup/windows/check.ps1, 054) as a Mac's boxes run
 * it: the clock's check (windows/check-clock.ps1) in place of the address's
 * from the SMBIOS serial, which a Mac's QEMU does not give, as
 * prepare-windows-image.sh builds it.
 */
export function macWindowsCheck(check: string, clock: string): string {
  const out: string[] = [];
  let [replaced, dropping] = [0, false];
  for (const line of check.split("\n")) {
    if (line === "Check 'address from the SMBIOS serial' {") {
      out.push(...clock.replace(/\n$/, "").split("\n"));
      [replaced, dropping] = [replaced + 1, true];
    } else if (dropping) {
      if (line === "}") dropping = false;
    } else out.push(line);
  }
  if (replaced !== 1 || dropping) throw new Error("setup/windows/check.ps1 has changed: adapt Tart's Windows check (macWindowsCheck) to it.");
  return out.join("\n");
}

/** The check a trial box of each kind runs; none of Tart's own for Windows, whose shared check.ps1 runs, adapted (adaptCheck). */
function tartCheck(kind: string): string {
  if (guestOsOf(kind) === "windows") return "";
  if (guestOsOf(kind) === "macos") return MAC_CHECK;
  if (kind === "linux-arm64") return "bb-box-check-headless";
  return "for i in $(seq 1 60); do [ -s /run/bb-box/display-mode ] && break; sleep 1; done; bb-box-check-desktop";
}

export interface TartBackendOptions {
  readonly sshBinary?: string;
  /** bb-box-stream's source for Windows video (#865), instead of mac-stream.swift: a small one, in tests. */
  readonly qemuVideoSource?: string;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The longest an acquire may take, instead of the kind's. */
  readonly readyTimeoutMs?: number;
  /** What runs the Mac helper's VM commands in a macOS VM, instead of machine-mac.sh through sudo: a fake, in tests. */
  readonly macHelper?: string;
  /** Where a macOS VM's bb-box-stream is, instead of MAC_STREAM: a fake, in tests. */
  readonly macStream?: string;
  /** Where a Linux desktop's image has Selkies' launcher, instead of SELKIES_LAUNCHER: a file the test finds, in tests. */
  readonly selkiesLauncher?: string;
}

interface SshKeys {
  readonly ssh: Ssh;
  readonly publicKey: string | null;
  readonly generated: boolean;
}

/** A VM bb-box is starting on a Mac, counted against the Mac until Tart or QEMU runs it. Keyed by the VM. */
interface Placing {
  readonly host: string;
  readonly vm: string;
  /** What it takes of the Mac's memory (footprint). */
  readonly memoryMiB: number;
  /** A macOS VM, which counts against the Mac's two. */
  readonly macos: boolean;
}

/** The longest a standard image's prepare script may run. */
const BUILD_TIMEOUT_MS = 60 * 60_000;
/** How old an image refresh's build VM or an image box is before the upkeep removes it as left over: older than any refresh or try runs. */
const LEFTOVER_MS = 4 * 60 * 60_000;
/** How long the Mac may be out of reach while its prepare script runs, before the build counts as lost (#707). */
const BUILD_LOST_MS = 10 * 60_000;
/** How often bb-box looks at a running build's log. */
const BUILD_POLL_MS = 2_000;
/** The most of a build's log one look takes. */
const BUILD_LOG_CHUNK = 256 * 1024;

/** The prefix of a warm VM's name. A box that takes it keeps the name. */
const WARM_PREFIX = "bb-box-warm-";

/**
 * Warm VMs of one image at one size, which serve every kind whose image and
 * default size they are: one pool when macos and macos-desktop share both.
 */
interface WarmPool {
  readonly image: string;
  /** macOS, whose VMs Tart runs, or Windows, whose VMs QEMU runs (046). */
  readonly os: GuestOs;
  readonly size: BoxSize;
  readonly kinds: readonly string[];
  /** The sum of the kinds' warm counts (029). */
  readonly target: number;
}

/** A warm VM bb-box is filling, until it is suspended or saved, or a box takes it over. */
interface Fill {
  readonly host: string;
  readonly size: BoxSize;
  readonly kinds: readonly string[];
  readonly abort: AbortController;
  /** The VM's address once it is ready, or "" for a Windows VM, reached at its port; rejects when the fill fails. */
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
  /** A macOS VM whose fill ran this Mac helper's vm-ready (058): its claim skips the grants step. */
  readonly ready: boolean;
}

/** How an acquire gets its VM: a clone, a free warm VM, a fill to take over, or its own VM after a restart. */
type Placement =
  | { readonly how: "clone" | "resume"; readonly host: TartHost; readonly vm: string }
  | { readonly how: "warm"; readonly host: TartHost; readonly vm: string; readonly ready: boolean }
  | { readonly how: "adopt"; readonly host: TartHost; readonly vm: string; readonly fill: Fill }
  | { readonly how: "wait"; readonly fills: readonly Fill[] };

function sameSize(a: BoxSize, b: BoxSize): boolean {
  return a.cores === b.cores && a.memoryMiB === b.memoryMiB && a.diskGiB === b.diskGiB;
}

/** A VM bb-box filled or held for a warm pool, which is no box's. */
function warmState(fields: Readonly<Record<string, string>>): "warm" | "filling" | null {
  return fields.state === "warm" || fields.state === "filling" ? fields.state : null;
}

/** A warm VM's size and whether it is saved: from QEMU for a Windows VM, whose owner file names the engine, else from Tart. */
function warmOf(state: MacState, vm: string, fields: Readonly<Record<string, string>>): { readonly size: BoxSize | null; readonly suspended: boolean } {
  if (fields.engine === "qemu") {
    const made = state.qemu.vms.get(vm);
    return { size: made ? { cores: made.cores, memoryMiB: made.memoryMiB, diskGiB: made.diskGiB } : null, suspended: made?.power === "suspended" };
  }
  return { size: sizeOf(state.configs.get(vm)), suspended: state.vms.find((candidate) => candidate.name === vm)?.state === "suspended" };
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

/** Whether Tart keeps its VMs on a volume other than the Mac's own disk, through a link (#632). */
function otherVolume(disk: HostState["disk"]): boolean {
  return disk.volume.startsWith("/Volumes/");
}

/** The free space where Tart keeps its VMs, naming the volume when it is not the Mac's own disk. */
function diskFree(disk: HostState["disk"]): string {
  return `${formatMiB(disk.freeMiB)} of disk free${otherVolume(disk) ? ` on ${disk.volume}` : ""}`;
}

function formatMiB(value: number): string {
  return value >= MiB_PER_GiB ? `${Math.round((value / MiB_PER_GiB) * 10) / 10} GiB` : `${value} MiB`;
}

function powerOf(state: string | undefined): PowerState {
  if (state === "running") return "running";
  if (state === "stopped" || state === "suspended") return "stopped";
  return "unknown";
}

/** About how long a Linux VM's resize restart takes: a shutdown, tart set and a boot, 4.5 s for the boot as measured (061). */
const RESIZE_RESTART_S = 20;

/** Grows a Linux VM's root partition and file system over its disk, while it runs (061): growpart says NOCHANGE when there is nothing to grow. */
const GROW_ROOT = String.raw`dev=$(findmnt -no SOURCE /)
disk=/dev/$(lsblk -no PKNAME "$dev")
part=$(cat "/sys/class/block/$(basename "$dev")/partition")
sudo growpart "$disk" "$part" >/dev/null || :
sudo resize2fs "$dev" >/dev/null`;

/** Tart's disk size, in decimal GB, for a disk of `gib` GiB: 70 GB is 65.2 GiB (061). */
export function decimalGB(gib: number): number {
  return Math.ceil((gib * 2 ** 30) / 1e9);
}

/** The size in `tart get --format json` after a line `@size`, its disk in whole GiB; null when it does not say. */
export function parseTartSize(stdout: string): BoxSize | null {
  const line = stdout.split("@size\n")[1]?.split("\n")[0];
  if (!line) return null;
  try {
    const got = JSON.parse(line) as { CPU?: number; Memory?: number; Disk?: number };
    if (!got.CPU || !got.Memory) return null;
    return { cores: got.CPU, memoryMiB: got.Memory, diskGiB: got.Disk ? Math.floor((got.Disk * 1e9) / 2 ** 30) : null };
  } catch {
    return null;
  }
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
      description: "macOS on a Mac with Apple silicon, for builds and commands. Its desktop is not shown.",
      requires: [],
      capabilities: { os: "macos", arch: "arm64", gpu: false, features: [], command: SSH_COMMAND, displays: [], computerUse: null, enrol: true },
      readyTimeoutMs: READY_TIMEOUT_MS,
    },
    "macos-desktop": {
      id: "macos-desktop",
      label: "macOS desktop",
      description: "macOS on a Mac with Apple silicon, with its desktop shown in the panel and computer use.",
      requires: [],
      capabilities: {
        os: "macos",
        arch: "arm64",
        gpu: false,
        features: [],
        command: SSH_COMMAND,
        // Tart's VNC server shares the pasteboard with its host only (#464),
        // and takes Alt as Command and Meta as Option.
        // And video, once every Mac's image has bb-box-stream (060): #states.
        displays: [{ id: "desktop", protocol: "rfb", resizable: false, clipboard: "commands", macKeys: "alt-command" }],
        computerUse: cua,
        enrol: true,
      },
      readyTimeoutMs: READY_TIMEOUT_MS,
    },
    "linux-arm64": {
      id: "linux-arm64",
      label: "Linux on arm64",
      description: "A Linux box on an arm64 host, such as a Mac with Apple silicon. amd64 container images and x86_64 binaries do not run there.",
      requires: [],
      capabilities: { os: "linux", arch: "arm64", gpu: false, features: ["docker"], command: SSH_COMMAND, displays: [], computerUse: null, enrol: true },
      readyTimeoutMs: READY_TIMEOUT_MS,
    },
    "linux-arm64-desktop-cpu": {
      id: "linux-arm64-desktop-cpu",
      label: "Linux desktop on arm64",
      description:
        "A Linux desktop on an arm64 host, such as a Mac with Apple silicon, drawn by the CPU, for computer use and browsers. amd64 container images and x86_64 binaries do not run there.",
      requires: [],
      capabilities: {
        os: "linux",
        arch: "arm64",
        gpu: false,
        features: ["docker"],
        command: SSH_COMMAND,
        // Xtigervnc takes a viewer's SetDesktopSize itself, as on the Proxmox CPU desktop. Selkies beside it, as on the X11
        // images. Video by choice, as for every Tart desktop: it costs the Mac about 0.9 of a core while someone watches an
        // idle desktop (060).
        displays: [{ id: "desktop", protocol: "rfb", resizable: true }, { ...SELKIES_DISPLAY, byChoice: true }],
        computerUse: LINUX_CUA,
        enrol: true,
      },
      readyTimeoutMs: READY_TIMEOUT_MS,
    },
    "windows-arm64-desktop": {
      id: "windows-arm64-desktop",
      label: "Windows desktop on arm64",
      description:
        "A Windows 11 VM on arm64, on a Mac with Apple silicon, for Windows apps, browsers and builds, with its desktop shown in the panel and computer use. x64 apps run under Windows' emulation, more slowly; x64 drivers do not. Commands run in PowerShell 7 as an administrator. What a command starts with Start-Process ends with it; Start-Detached { <cmd> } <log> keeps it running, with a GUI program's output in the log too. A desktop command runs unelevated, and what it opens stays open.",
      requires: [],
      capabilities: {
        os: "windows",
        arch: "arm64",
        gpu: false,
        features: [],
        command: WINDOWS_COMMAND,
        // QEMU's VNC server, at the listed mode that best covers the viewer. It moves no clipboard without the SPICE
        // guest agent, so bb-box moves it with Get-Clipboard and Set-Clipboard in the desktop session (#461). With
        // lossy=on its JPEG at quality 2 broke text up, and its own refresh of a still area kept some JPEG (056).
        displays: [{ id: "desktop", protocol: "rfb", resizable: true, clipboard: "commands", refresh: "viewer", quality: 4 }],
        computerUse: WINDOWS_CUA,
        // Windows boxes join BB unless the switch is set off (#539).
        enrol: config.windowsEnrol,
      },
      readyTimeoutMs: WINDOWS_READY_TIMEOUT_MS,
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
 * its hostname, /etc/hostname and the 127.0.1.1 line in /etc/hosts. Only in
 * a Virtualization framework VM, never on a machine a command reaches by
 * mistake, such as a test machine.
 *
 * A Linux desktop's display wrote its X cookie for the hostname it had, and
 * X clients look it up by the hostname, so first the cookie gets an entry for
 * any hostname, as the Proxmox LXC backend gives it; images built since have
 * one from the start. It reads the entries before it merges: in one
 * pipeline the two xauth raced for the file's lock, and when the merge won,
 * the read gave up after 20 s and nothing was merged. Then one root shell
 * writes the files and sets the name, without hostnamectl and D-Bus (#251).
 */
export function nameScript(name: string): string {
  const host = quote(hostnameOf(name));
  return `if [ "$(uname -s)" = Linux ]; then
  [ "$(systemd-detect-virt --vm 2>/dev/null)" = apple ] || { echo "not a VM"; exit 0; }
  auth=${DISPLAY_AUTH_FILE}
  # Read, then merge: two xauth at once on the file can wait 20 s for its lock and merge nothing.
  if [ -s "$auth" ]; then entries=$(xauth -q -f "$auth" nlist) && printf '%s\\n' "$entries" | sed 's/^..../ffff/' | xauth -q -f "$auth" nmerge -; fi
  sudo -n sh -s -- ${host} <<'NAME'
set -e
if grep -q '^127[.]0[.]1[.]1[[:space:]]' /etc/hosts; then sed -i "s/^127[.]0[.]1[.]1[[:space:]].*/127.0.1.1 $1/" /etc/hosts; else echo "127.0.1.1 $1" >> /etc/hosts; fi
printf '%s\\n' "$1" > /etc/hostname
hostname "$1"
NAME
  exit
fi
case "$(sysctl -n hw.model 2>/dev/null)" in VirtualMac*) ;; *) echo "not a VM"; exit 0 ;; esac
for key in ComputerName LocalHostName HostName; do sudo -n scutil --set "$key" ${host} || exit 1; done`;
}

/**
 * Sets a macOS VM's clock to `now`, in UTC: a VM resumed from a suspend has
 * the time it was suspended at, and macOS does not notice for a while. Half
 * a second on, for the seconds date drops and the command's way there. Only
 * in a VM, as nameScript.
 */
export function macClockScript(now: number): string {
  const at = new Date(now + 500);
  const two = (value: number) => String(value).padStart(2, "0");
  // BSD date's mmddHHMMccyy.ss.
  const stamp = `${two(at.getUTCMonth() + 1)}${two(at.getUTCDate())}${two(at.getUTCHours())}${two(at.getUTCMinutes())}${at.getUTCFullYear()}.${two(at.getUTCSeconds())}`;
  return `case "$(sysctl -n hw.model 2>/dev/null)" in VirtualMac*) ;; *) echo "not a VM"; exit 0 ;; esac
sudo -n date -u ${stamp} >/dev/null`;
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
  readonly hosts: readonly string[];
  readonly hostOs = "macos" as const;
  readonly nature = "virtual" as const;
  readonly #config: TartConfig;
  readonly #context: BackendContext;
  readonly #options: TartBackendOptions;
  readonly #kinds: BoxKind[];
  readonly #keyFile = new KeyFile();
  #ssh: Promise<SshKeys> | null = null;
  /** Each VM's address while bb-box knows it: learnt when it starts, forgotten when it stops. */
  readonly #addresses = new Map<string, string>();
  /** Whether each macOS VM has bb-box-stream, as its image gives it or not. */
  readonly #streams = new Map<string, boolean>();
  /** Whether each Windows box has bb-box-stream.exe, as its image gives it or not (060). */
  readonly #windowsStreams = new Map<string, boolean>();
  /** The command that runs machine-mac.sh in a macOS VM, made once, for its grants (058). */
  #macHelper: string | null = null;
  /** VMs being started for boxes or warm pools, by VM, until they run or their start ends. */
  readonly #placing = new Map<string, Placing>();
  /** Placement is one at a time, so two acquires, or an acquire and a fill, never take the last slot of one Mac. */
  #placement: Promise<unknown> = Promise.resolve();
  /** Warm VMs this instance is filling, by VM. */
  readonly #filling = new Map<string, Fill>();

  /**
   * Image operations (049) on each Mac: a clone of an image as an image box,
   * its capture as a VM of its own with its record beside it, a new build of
   * a standard image by its prepare script, and the image's name moved to a
   * build. A reference is <Mac>/<VM>. A Windows image's build is a QEMU disk
   * under ~/.bb-box/qemu, refreshed in a box of it (054, #450): its current
   * build is <Mac>/<image>, and another <Mac>/<image>@<build>.
   */
  readonly images: BackendImages = {
    list: (signal) => this.#imageList(signal),
    box: (build, label, signal) => this.#imageBox(build, label, signal),
    capture: (box, from, image, signal) => this.#capture(box, from, image, signal),
    replace: (build, current, signal) => this.#replaceImage(build, current, signal),
    remove: (ref, signal) => this.#removeImage(ref, signal),
    build: (current, setup, options) => this.#buildStandard(current, setup, options),
    check: (kind) => tartCheck(kind),
    adaptCheck: (kind, check, setup) => (guestOsOf(kind) === "windows" ? macWindowsCheck(check, readFileSync(join(setup, "tart", "windows", "check-clock.ps1"), "utf8")) : check),
    // A project's box clones its image's build on the build's Mac (049, #439).
    startsFrom: true,
    windows: true,
  };
  /** Each Windows image box's SSH port on its Mac's loopback, by VM, for its capture to drop its connection (#450). */
  readonly #imagePorts = new Map<string, number>();
  /** Display helpers compiling for new Windows boxes, by VM, which a resize waits for. */
  readonly #compiling = new Map<string, Promise<void>>();
  readonly #warm: ReadyPool<BoxIdentity>;
  readonly #stopping = new AbortController();
  readonly #upkeep = new Upkeep((signal) => this.#topUp(signal));
  /** Whether a Mac has answered, so macos-desktop's video is declared as its image has it (060). */
  #videoKnown = false;
  /** Whether windows-arm64-desktop's video is known: once a Mac has answered, as for macos-desktop's. */
  #windowsVideoKnown = false;
  /** The build of bb-box-stream that Windows video runs on each Mac (#865), from mac-stream.swift's source. */
  #qemuVideo: { readonly source: string; readonly build: string } | null = null;
  /** Each Mac's build of it, while it runs, so a Mac builds it once at a time. */
  readonly #qemuVideoBuilds = new Map<string, Promise<void>>();
  /** The Macs whose build is ready, as their state last said. */
  readonly #qemuVideoReady = new Set<string>();

  constructor(config: TartConfig, context: BackendContext, options: TartBackendOptions = {}) {
    this.id = context.id;
    this.#config = config;
    this.#context = context;
    this.#options = options;
    this.#kinds = tartKinds(config);
    this.label = `Tart on ${config.hosts.map((host) => host.name).join(", ")}`;
    this.hosts = config.hosts.map((host) => host.name);
    this.#warm = new ReadyPool<BoxIdentity>({
      members: (signal) => this.#members(signal),
      hold: (member, box, signal) => this.#hold(member, box, signal),
    });
  }

  kinds(): BoxKind[] {
    return this.#kinds;
  }

  /**
   * Declares macos-desktop's video, from bb-box-stream (060), while every Mac
   * that answered has it in its image's record, as the SSH host pool does from
   * every Mac's survey; and stops declaring it when one does not. The viewer
   * opens it by default only while the backend's video field is on; else it
   * opens VNC, and the person can choose video.
   */
  #declareVideo(states: ReadonlyMap<string, MacState | Error>): void {
    this.#declareWindowsVideo(states);
    const index = this.#kinds.findIndex((kind) => kind.id === "macos-desktop");
    const image = this.#config.kinds["macos-desktop"].image;
    if (index < 0 || !image) {
      this.#videoKnown = true;
      return;
    }
    const answered = [...states.values()].filter((state): state is MacState => !(state instanceof Error));
    if (!answered.length) return;
    this.#videoKnown = true;
    const video = answered.every((state) => state.records.get(image)?.tools?.["bb-box-stream"] !== undefined);
    const kind = this.#kinds[index]!;
    const others = kind.capabilities.displays.filter((display) => display.protocol !== "selkies");
    const displays = video ? [...others, this.#config.video ? MAC_VIDEO : { ...MAC_VIDEO, byChoice: true }] : others;
    if (JSON.stringify(displays) === JSON.stringify(kind.capabilities.displays)) return;
    this.#kinds[index] = { ...kind, capabilities: { ...kind.capabilities, displays } };
  }

  /**
   * A macOS desktop's video follows the Macs' image records, which bb-box
   * reads only once a Mac answers, so before then, as just after bb-box
   * starts, its boxes keep the video they have, as the SSH host pool's Mac
   * boxes keep their features (047).
   */
  async asOffered(_guest: Guest, kind: string): Promise<boolean> {
    if (kind === "windows-arm64-desktop") return this.#windowsVideoKnown;
    return kind !== "macos-desktop" || this.#videoKnown;
  }

  /**
   * Declares windows-arm64-desktop's video (060), while every Mac that
   * answered has bb-box-stream.exe in its Windows image, as OpenH264 in its
   * record says, for the keys and the clipboard, and its own build of
   * bb-box-stream, which gives the video from QEMU (#865). Leaves the pointer
   * out of it while a person holds control where every record lists the
   * hardware cursor too, as on Proxmox. Opens as video: measured, it keeps
   * up with VNC on a LAN and is ahead on a slow link, for under 2% of a core
   * on the Mac (#865).
   */
  #declareWindowsVideo(states: ReadonlyMap<string, MacState | Error>): void {
    const index = this.#kinds.findIndex((kind) => kind.id === "windows-arm64-desktop");
    if (index < 0 || !this.#config.kinds["windows-arm64-desktop"].image) {
      this.#windowsVideoKnown = true;
      return;
    }
    const answered = [...states.values()].filter((state): state is MacState => !(state instanceof Error));
    if (!answered.length) return;
    this.#windowsVideoKnown = true;
    const tools = answered.map((state) => state.qemu.image?.record?.tools ?? {});
    const video = tools.every((each) => each.openh264 !== undefined) && answered.every((state) => state.qemuVideo?.status === "ready");
    const cursor = video && tools.every((each) => each[WINDOWS_HARDWARE_CURSOR] !== undefined);
    const kind = this.#kinds[index]!;
    const others = kind.capabilities.displays.filter((display) => display.protocol !== "selkies");
    const displays = video ? [...others, { ...WINDOWS_VIDEO, ...(cursor ? { cursor: "stream" as const } : {}) }] : others;
    if (JSON.stringify(displays) === JSON.stringify(kind.capabilities.displays)) return;
    this.#kinds[index] = { ...kind, capabilities: { ...kind.capabilities, displays } };
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
      memoryMiB: Math.max(0, pending.reduce((sum, other) => sum + footprint(other.kind, other.size), 0) - placed.reduce((sum, other) => sum + other.memoryMiB, 0)),
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
  async #states(signal?: AbortSignal): Promise<Map<string, MacState | Error>> {
    const entries = await Promise.all(
      this.#config.hosts.map(async (host) => [host.name, await this.#state(host, signal).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))] as const),
    );
    const states = new Map(entries);
    this.#declareVideo(states);
    return states;
  }

  /**
   * Whether a box of `size` fits on the Mac, and if not, why, with what to
   * do. VMs `yielding` count as gone. A Linux or Windows VM (`os`) does not
   * count against the Mac's two macOS VMs, and a Windows VM's QEMU takes
   * memory of its own. A Windows box may ask for a disk larger than the
   * image's, and the Mac must have what it grew by beyond the disk reserve,
   * as on Proxmox, though the overlay takes only what Windows writes. A warm
   * VM (`saved`) is suspended or saved once filled, which writes its memory
   * to disk, so the Mac must have that beyond the disk reserve too.
   */
  #room(
    host: TartHost,
    state: MacState | Error,
    size: BoxSize,
    unplaced: Unplaced = NONE_UNPLACED,
    yielding: ReadonlySet<string> = new Set(),
    os: GuestOs = "macos",
    saved = false,
  ): { capacity: HostCapacity; why: string | null } {
    if (state instanceof Error) return { capacity: { host: host.name, ok: false, limits: [] }, why: `${host.name} did not answer: ${state.message}` };
    // Every running VM takes memory; only macOS VMs count against Apple's two.
    const running = state.vms.filter((vm) => vm.running && !yielding.has(vm.name));
    const macos = running.filter((vm) => (state.configs.get(vm.name)?.os ?? "darwin") === "darwin");
    const windows = [...state.qemu.vms].filter(([name, vm]) => vm.power === "running" && !yielding.has(name));
    const placing = [...this.#placing.values()].filter(
      (other) => other.host === host.name && !yielding.has(other.vm) && !running.some((vm) => vm.name === other.vm) && !windows.some(([name]) => name === other.vm),
    );
    const starting = placing.filter((other) => other.macos).length + unplaced.count;
    const memoryUsed =
      running.reduce((sum, vm) => sum + (state.configs.get(vm.name)?.memoryMiB ?? 0), 0) +
      windows.reduce((sum, [, vm]) => sum + vm.memoryMiB + QEMU_OVERHEAD_MIB, 0) +
      placing.reduce((sum, other) => sum + other.memoryMiB, 0) +
      unplaced.memoryMiB;
    const memoryFree = state.memoryMiB - memoryUsed;
    const needed = os === "windows" ? size.memoryMiB + QEMU_OVERHEAD_MIB : size.memoryMiB;
    const image = this.#config.kinds["windows-arm64-desktop"].image;
    const reserve = this.#config.reserve;
    const diskReserveMiB = reserve.diskGiB * MiB_PER_GiB;
    const grow = os === "windows" && size.diskGiB !== null ? Math.max(0, size.diskGiB - (state.qemu.image?.diskGiB ?? 0)) : 0;
    const limits: Limit[] = [
      { resource: "guests", used: macos.length + starting, total: this.#config.vmsPerHost, reserve: 0, unit: "count" },
      { resource: "memory", used: memoryUsed, total: state.memoryMiB, reserve: reserve.memoryMiB, unit: "MiB" },
      { resource: "disk", ...(otherVolume(state.disk) ? { id: state.disk.volume } : {}), used: state.disk.totalMiB - state.disk.freeMiB, total: state.disk.totalMiB, reserve: diskReserveMiB, unit: "MiB" },
    ];
    let why: string | null = null;
    if (size.diskGiB !== null && os !== "windows") {
      // Growing a macOS VM's disk needs its recovery partition removed and its APFS container grown inside the guest.
      why = `a Tart box keeps its image's disk, so bb-box cannot give it a ${size.diskGiB} GiB disk yet. Ask for the base disk`;
    } else if (state.cpus && size.cores > state.cpus) {
      why = `${host.name} has ${state.cpus} cores, fewer than the ${size.cores} asked for. Ask for at most ${state.cpus} cores`;
    } else if (os === "windows" && !state.qemu.version) {
      why = `${host.name} has no QEMU on the PATH of ${host.user}'s SSH sessions, which Windows boxes need. Install QEMU there, with Homebrew or Nix`;
    } else if (os === "windows" && !state.qemu.image) {
      why = `${host.name} has no Windows image ${image ?? ""} in ~/.bb-box/qemu/images. Prepare it there, or set the Windows image in bb-box's settings`;
    } else if (os === "macos" && macos.length + starting >= this.#config.vmsPerHost) {
      const names = macos.map((vm) => this.#vmWords(vm.name, state.owners.get(vm.name))).join(", ");
      why =
        `${host.name} runs ${macos.length + starting} of the ${this.#config.vmsPerHost} macOS VMs it may run${names ? ` (${names})` : ""}. ` +
        "Release or stop a macOS box, or stop another VM there";
    } else if (memoryFree - needed < reserve.memoryMiB) {
      // Leads with what binds: the box when it needs more than is free, otherwise the memory kept free.
      const box = `a box with ${os === "windows" ? `${formatMiB(size.memoryMiB)}, and ${formatMiB(QEMU_OVERHEAD_MIB)} for QEMU,` : formatMiB(size.memoryMiB)}`;
      why =
        needed > memoryFree
          ? `${host.name} has ${formatMiB(Math.max(0, memoryFree))} of memory free, less than ${box} needs. Ask for less memory or release a box`
          : `${host.name} has ${formatMiB(memoryFree)} of memory free and keeps ${formatMiB(reserve.memoryMiB)} free, so ${box} does not fit. ` +
            (memoryFree > reserve.memoryMiB
              ? "Ask for less memory, release a box, or lower the memory kept free in bb-box's settings"
              : "Release a box, or lower the memory kept free in bb-box's settings");
    } else if (state.disk.freeMiB < diskReserveMiB) {
      why = `${host.name} has ${diskFree(state.disk)}, less than the ${formatMiB(diskReserveMiB)} kept free. Release boxes or free some space`;
    } else if (state.disk.freeMiB - grow * MiB_PER_GiB < diskReserveMiB) {
      why =
        grow * MiB_PER_GiB > state.disk.freeMiB
          ? `${host.name} has ${diskFree(state.disk)}, less than the ${grow} GiB a ${size.diskGiB} GiB disk adds to the Windows image's. ` +
            "Ask for a smaller disk or release boxes"
          : `${host.name} has ${diskFree(state.disk)} and keeps ${formatMiB(diskReserveMiB)} free, ` +
            `so a ${size.diskGiB} GiB disk, ${grow} GiB more than the Windows image's, does not fit. ` +
            "Ask for a smaller disk, release boxes, or lower the disk kept free in bb-box's settings";
    } else if (saved && state.disk.freeMiB - grow * MiB_PER_GiB - size.memoryMiB < diskReserveMiB) {
      const vm = `a warm VM saved with its ${formatMiB(size.memoryMiB)} of memory`;
      why =
        grow * MiB_PER_GiB + size.memoryMiB > state.disk.freeMiB
          ? `${host.name} has ${diskFree(state.disk)}, less than ${vm} needs`
          : `${host.name} has ${diskFree(state.disk)} and keeps ${formatMiB(diskReserveMiB)} free, so ${vm} does not fit`;
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
   * is free ("wait", outside the chain, as a fill ends in the chain). A box
   * from a project's image's build (049) is a clone on the build's Mac: warm
   * VMs and fills are of the standard image.
   */
  #place(box: BoxIdentity, signal: AbortSignal): Promise<Placement> {
    return this.#chain(async (): Promise<Placement> => {
      const states = await this.#states(signal);
      const from = box.from ? this.#imageRef(box.from).host.name : null;
      const on = this.#on().filter((host) => from === null || host.name === from);
      const os = guestOsOf(box.kind);
      const rooms = on.map((host) => ({ host, ...this.#room(host, states.get(host.name)!, box.size, NONE_UNPLACED, new Set(), os) }));
      const count = (host: TartHost, vm: string) => this.#placing.set(vm, { host: host.name, vm, memoryMiB: footprint(box.kind, box.size), macos: os === "macos" });
      for (const room of rooms) {
        const state = states.get(room.host.name)!;
        if (!room.capacity.ok || state instanceof Error || from !== null) continue;
        const warm = this.#freeWarm(state).find((free) => free.kinds.includes(box.kind) && sameSize(free.size, box.size));
        if (warm) {
          count(room.host, warm.vm);
          return { how: "warm", host: room.host, vm: warm.vm, ready: warm.ready };
        }
      }
      const chosen = rooms.find((room) => room.capacity.ok);
      if (chosen) {
        count(chosen.host, vmName(box.boxId));
        return { how: "clone", host: chosen.host, vm: vmName(box.boxId) };
      }
      const fills = from !== null ? [] : [...this.#filling.entries()].filter(([, fill]) => !fill.adopted && on.some((host) => host.name === fill.host));
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
    // A project's image's build, as images.list gives it, <Mac>/<VM>, else the kind's image.
    const image = box.from ? this.#imageRef(box.from).vm : this.#config.kinds[box.kind as TartKind].image!;
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
    if (os === "windows") return this.#acquireWindows(box, previous, image, deadline, hooks, step, signal);
    const owner = this.#owner(box);
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
          await step("start", () => this.#start(host, vm, os, deadline, signal));
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
          await step("start", () => this.#start(host, vm, os, deadline, signal, false));
          address = await step("network", () => this.#address(host, vm, deadline, signal));
        }
        await step("ssh", async () => this.#waitReady(host, vm, this.#vm(await this.#mac(host), address, os), os, deadline, signal));
        if (os === "linux" && kind.capabilities.displays.length) await step("desktop", () => this.#linuxDesktop(host, vm, address, signal));
        await step("identify", () => this.#identify(host, address, vm, os, signal));
        await step("name", () => this.#rename(host, address, vm, os, box.name, signal));
        // A warm VM's fill ran it already, before its suspend, so its claim pays nothing for it.
        if (os === "macos" && !(placement.how === "warm" && placement.ready)) await step("grants", () => this.#vmReady(host, address, vm, signal));
        // A warm VM, or one held before a restart, resumed from a suspend with an old clock.
        if (os === "macos" && (placement.how === "warm" || placement.how === "resume")) await step("clock", () => this.#clock(host, address, signal));
        const size = sizeOf((await this.#state(host, signal)).configs.get(vm));
        // Claimed again, so the box's record has the address and size as it becomes ready.
        await hooks.claim(guest(address, size));
        return guest(address, size);
      } catch (error) {
        if (owned) await this.#delete(host, vm, os, box.boxId).catch((cause) => this.#context.logError("release after a failed acquire", cause));
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
   * Acquires a Windows box (046). A clone claims its VM, bb-box-<box ID>,
   * makes its overlay and ports, starts QEMU, and waits for SSH through the
   * Mac. A disk larger than the image's has C: extended over it then. Then
   * it waits for Windows' desktop, as a box is ready only once Cua can drive
   * it. A clone keeps the clock its image set; a warm VM, or one held before
   * a restart, restores, and its clock is set. A fill taken over runs on.
   */
  async #acquireWindows(
    box: BoxIdentity,
    previous: Guest | null,
    image: string,
    deadline: number,
    hooks: AcquireHooks,
    step: Step,
    signal: AbortSignal,
  ): Promise<Guest> {
    const owner = this.#owner(box);
    // A restarted acquire goes on with the VM it claimed or held.
    let placement: Exclude<Placement, { how: "wait" }> | null = await this.#previous(box, previous, signal);
    if (placement) this.#placing.set(placement.vm, { host: placement.host.name, vm: placement.vm, memoryMiB: footprint(box.kind, box.size), macos: false });
    let started = false;
    const starting = async () => {
      if (!started) await hooks.starting();
      started = true;
    };
    // A warm VM that fails to restore gives way to a clone, once.
    for (let attempt = 0; ; attempt++) {
      placement ??= await step("place", () => this.#placeBox(box, signal));
      const { host, vm } = placement;
      const guest = (made: QemuVm | null): Guest => ({
        ref: vm,
        host: host.name,
        address: null,
        size: made ? { cores: made.cores, memoryMiB: made.memoryMiB, diskGiB: made.diskGiB } : null,
        data: made ? { box: box.boxId, os: "windows", ssh: made.ssh, vnc: made.vnc } : { box: box.boxId, os: "windows" },
      });
      let owned = placement.how === "resume";
      let made: QemuVm | null = null;
      try {
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
          const clone = await step("clone", () => this.#run(host, qemuCloneScript(image, vm, box.size.cores, box.size.memoryMiB, box.size.diskGiB), { timeoutMs: 120_000, signal }));
          made = parseQemuVm(clone.stdout);
          if (!made) throw new Error(`QEMU's VM ${vm} on ${host.name} has no whole config: ${clone.stdout.trim() || "nothing"}`);
          const ports = made;
          await starting();
          await step("start", () => this.#start(host, vm, "windows", deadline, signal));
          const access = this.#windows(await this.#mac(host), ports.ssh);
          await step("ssh", () => this.#waitReady(host, vm, access, "windows", deadline, signal));
          // A restarted acquire extends again, which leaves a C: that fills its disk as it is.
          if (made.diskGiB !== null) {
            const { ssh } = await this.#keys();
            await step("extend", () => extendC(new SshTransport(ssh, access, "windows"), signal));
          }
          await step("desktop", () => this.#windowsDesktop(host, vm, access, deadline, signal));
          this.#compileDisplay(vm, access);
        } else if (placement.how === "adopt") {
          const fill = placement.fill;
          await hooks.claim(guest(null));
          const held = (await this.#run(host, holdScript(vm, this.#context.installId, "filling", owner), { signal })).stdout.trim();
          if (held !== "held") throw new Error(`The warm VM ${vm} on ${host.name} being made was no longer there to take over.`);
          owned = true;
          await starting();
          // Ready once its desktop is up and its display helper compiled.
          await step("warm", () => fill.ready);
          this.#kick();
          made = await this.#made(host, vm, signal);
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
          made = await this.#made(host, vm, signal);
          const ports = made;
          await starting();
          await step("start", () => this.#start(host, vm, "windows", deadline, signal, false));
          const { ssh } = await this.#keys();
          const access = this.#windows(await this.#mac(host), ports.ssh);
          await step("ssh", () => this.#waitReady(host, vm, access, "windows", deadline, signal));
          // A restore leaves Windows' clock at the time it was saved.
          await step("clock", () => setClock(new SshTransport(ssh, access, "windows"), signal));
          // A VM filled by an older bb-box has an older helper.
          this.#compileDisplay(vm, access);
        }
        // Claimed again, so the box's record has the ports and size as it becomes ready.
        await hooks.claim(guest(made));
        return guest(made);
      } catch (error) {
        if (owned) await this.#delete(host, vm, "windows", box.boxId, undefined, made?.ssh).catch((cause) => this.#context.logError("release after a failed acquire", cause));
        const retry = placement.how !== "clone" && attempt === 0 && !signal.aborted && Date.now() < deadline;
        if (!retry) throw error;
        this.#context.logError("acquire", new Error(`Box ${box.name} could not use VM ${vm} (${message(error)}), so bb-box clones a VM for it.`));
      } finally {
        this.#placing.delete(placement.vm);
      }
      placement = null;
    }
  }

  /** A Windows VM's config on its Mac. */
  async #made(host: TartHost, vm: string, signal?: AbortSignal): Promise<QemuVm> {
    const made = (await this.#state(host, signal)).qemu.vms.get(vm);
    if (!made) throw new Error(`QEMU's VM ${vm} on ${host.name} is not there.`);
    return made;
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
    this.#windowsStreams.delete(this.#streamKey(guest));
    await this.#delete(host, guest.ref, this.#osOf(guest), this.#boxOf(guest), signal, this.#sshPort(guest));
    hooks.timing("delete", Math.round(performance.now() - started));
  }

  /**
   * The pool Mac's helper, machine-mac.sh, run in a macOS VM through sudo for
   * the VM's user (058): the VM is the box, so it grants with no owner marker
   * and needs no reset.
   */
  async #vmHelper(command: SshTransport, verb: "vm-ready" | "vm-grant" | "vm-granted", input: string | null, signal?: AbortSignal): Promise<RunResult> {
    return command.run(`${this.#helperCommand()} ${verb} "$(id -un)"`, {
      ...(input !== null ? { stdin: input } : {}),
      timeoutMs: 60_000,
      signal,
      maxOutputBytes: 64 * 1024,
    });
  }

  /** The command that runs machine-mac.sh in a macOS VM, made once. */
  #helperCommand(): string {
    this.#macHelper ??= this.#options.macHelper ?? `sudo -n /bin/sh -c ${quote(readFileSync(join(setupDir(), "ssh-pool", "machine-mac.sh"), "utf8"))} machine`;
    return this.#macHelper;
  }

  /**
   * A short hash of that command, which holds the helper's whole script: a
   * warm VM filled with another helper, older or newer, may lack what this
   * one's vm-ready makes, so its claim runs vm-ready again.
   */
  #helperHash(): string {
    return createHash("sha256").update(this.#helperCommand()).digest("hex").slice(0, 16);
  }

  /**
   * A macOS box's signing identity and default grants, at its start or its
   * warm VM's fill. Best effort: a box without them still works. Whether
   * they were made.
   */
  async #vmReady(host: TartHost, address: string, vm: string, signal?: AbortSignal): Promise<boolean> {
    const { ssh } = await this.#keys();
    const command = new SshTransport(ssh, this.#vm(await this.#mac(host), address, "macos"), "macos");
    const result = await this.#vmHelper(command, "vm-ready", null, signal).catch((error: unknown) => ({ exitCode: null, stdout: "", stderr: message(error) }));
    if (result.exitCode !== 0 || !result.stdout.includes("signing=1")) {
      this.#context.logError("ready the box's grants", new Error(`${vm} on ${host.name}: the box's signing identity was not made: ${result.stderr.trim() || `exit code ${result.exitCode}`}`));
      return false;
    }
    return true;
  }

  /** The command transport of a macOS box, for its grants. */
  async #macCommand(guest: Guest): Promise<SshTransport> {
    if (this.#osOf(guest) !== "macos") throw new BackendError("unsupported", `Only a macOS box has macOS permissions to grant: ${guest.ref} runs ${this.#osOf(guest) === "windows" ? "Windows" : "Linux"}.`);
    return (await this.transports(guest, "macos")).command as SshTransport;
  }

  async grant(guest: Guest, request: GrantRequest, signal?: AbortSignal): Promise<GrantAnswer> {
    const command = await this.#macCommand(guest);
    const box = typeof guest.data?.box === "string" ? guest.data.box : guest.ref;
    const result = await this.#vmHelper(command, "vm-grant", grantInput(this.#context.installId, box, request), signal);
    const said = result.stderr.trim() || `exit code ${result.exitCode}`;
    if (result.exitCode === EXIT.protected || result.exitCode === EXIT.refused) throw new BackendError("unsupported", said);
    if (result.exitCode !== 0) throw new Error(`The VM ${guest.ref} did not grant: ${said}`);
    return parseGrant(result.stdout);
  }

  async grants(guest: Guest, signal?: AbortSignal): Promise<BoxGrants | null> {
    if (this.#osOf(guest) !== "macos") return null;
    const result = await this.#vmHelper(await this.#macCommand(guest), "vm-granted", null, signal).catch(() => null);
    return result?.exitCode === 0 ? parseGranted(result.stdout) : null;
  }

  async power(guest: Guest, signal?: AbortSignal): Promise<PowerState | null> {
    const host = this.#hostNamed(guest.host);
    if (!host) return "unknown";
    let result: RunResult;
    try {
      const script = this.#osOf(guest) === "windows" ? qemuPowerScript : powerScript;
      result = await this.#run(host, script(guest.ref, this.#context.installId, this.#boxOf(guest)), { timeoutMs: 30_000, signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      return "unknown";
    }
    const state = result.stdout.trim().split("\n").pop();
    if (state === "gone") return null;
    return powerOf(state);
  }

  /** How `tart run`, or QEMU for a Windows VM, last exited, with macOS's crash report of it (#406). */
  async stopped(guest: Guest, signal?: AbortSignal): Promise<StopReason | null> {
    const host = this.#hostNamed(guest.host);
    if (!host) return null;
    const windows = this.#osOf(guest) === "windows";
    const script = windows ? qemuEndedScript : endedScript;
    // A crash's report can take 10 s to be written (host.ts).
    const result = await this.#run(host, script(guest.ref, this.#context.installId, this.#boxOf(guest)), { timeoutMs: 40_000, signal });
    const end = parseEnded(result.stdout);
    return end ? endReason(end, windows ? "QEMU" : "tart run") : null;
  }

  async start(guest: Guest, signal?: AbortSignal): Promise<void> {
    const host = this.#hostOf(guest);
    const os = this.#osOf(guest);
    const deadline = Date.now() + (this.#options.readyTimeoutMs ?? (os === "windows" ? WINDOWS_READY_TIMEOUT_MS : READY_TIMEOUT_MS));
    if ((await this.power(guest, signal)) === null) throw this.#gone(guest);
    this.#addresses.delete(guest.ref);
    await this.#start(host, guest.ref, os, deadline, signal, true, this.#boxOf(guest));
    if (os === "windows") {
      // A restore leaves Windows' clock at the time it stopped (046).
      const { ssh } = await this.#keys();
      const access = this.#windows(await this.#mac(host), (await this.#ports(host, guest, signal)).ssh);
      await this.#waitReady(host, guest.ref, access, os, deadline, signal);
      await setClock(new SshTransport(ssh, access, os), signal);
      return;
    }
    const address = await this.#address(host, guest.ref, deadline, signal);
    await this.#waitReady(host, guest.ref, this.#vm(await this.#mac(host), address, os), os, deadline, signal);
    await this.#identify(host, address, guest.ref, os, signal);
    if (os === "linux") await this.#linuxDesktop(host, guest.ref, address, signal);
    // A macOS VM resumes from its suspend with the time it stopped at.
    if (os === "macos") await this.#clock(host, address, signal);
  }

  /**
   * Tart sizes a VM only while it is stopped, and a Linux VM, which a stop
   * shuts down, takes its new CPUs, memory and disk when it boots: each
   * part needs a restart (061). Its root partition then grows online. macOS
   * and Windows VMs, whose stop keeps their session, come later.
   */
  resizing(kind: string): Resizing | null {
    return guestOsOf(kind) === "linux" && this.kinds().some((offer) => offer.id === kind) ? { cores: "restart", memory: "restart", disk: "restart", shrinks: true } : null;
  }

  async planResize(guest: Guest, kind: string, to: BoxSize, pending: readonly Pending[], signal?: AbortSignal): Promise<ResizePlan> {
    if (!this.resizing(kind)) throw new BackendError("unsupported", `${this.label} cannot resize its ${kind} boxes yet.`);
    const { host, from } = await this.#resizable(guest, to, signal);
    const parts: ResizePlan["parts"][number][] = [];
    if (to.cores !== from.cores) parts.push({ part: "cores", from: from.cores, to: to.cores, way: "restart" });
    if (to.memoryMiB !== from.memoryMiB) parts.push({ part: "memory", from: from.memoryMiB, to: to.memoryMiB, way: "restart" });
    if (to.diskGiB !== null && to.diskGiB !== from.diskGiB) parts.push({ part: "disk", from: from.diskGiB, to: to.diskGiB, way: "restart" });
    const state = await this.#state(host, signal).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
    const room = this.#resizeRoom(host, state, from, to, pending);
    return { parts, room, downSeconds: parts.length ? RESIZE_RESTART_S : null };
  }

  /**
   * Resizes a running Linux VM (061): shuts it down, sets its CPUs, memory
   * and disk with tart set, boots it, and grows its root partition and file
   * system over a larger disk. When it does not come back, its old CPUs and
   * memory go back and it boots again; a disk that grew stays.
   */
  async resize(guest: Guest, kind: string, to: BoxSize, options: { readonly restart: boolean }, signal?: AbortSignal): Promise<Guest> {
    if (!this.resizing(kind)) throw new BackendError("unsupported", `${this.label} cannot resize its ${kind} boxes yet.`);
    const { host, from } = await this.#resizable(guest, to, signal);
    if (!options.restart) throw new BackendError("unsupported", "A Tart VM changes size only with a restart.");
    const grows = to.diskGiB !== null && (from.diskGiB === null || to.diskGiB > from.diskGiB);
    const change = (size: BoxSize, diskGB: number | null) => this.#run(host, sizeScript(guest.ref, this.#context.installId, this.#boxOf(guest), { cpus: size.cores, memoryMiB: size.memoryMiB, diskGB }), { timeoutMs: 120_000, signal });
    await this.stop(guest, signal);
    const set = await change(to, grows ? decimalGB(to.diskGiB!) : null);
    if (set.stdout.trim() === "gone") throw this.#gone(guest);
    try {
      await this.start(guest, signal);
    } catch (error) {
      await this.stop(guest).catch(() => undefined);
      await change(from, null).catch((cause) => this.#context.logError("resize: put CPUs and memory back", cause));
      await this.start(guest).catch((cause) => this.#context.logError("resize: start at the old size", cause));
      throw error;
    }
    if (grows) {
      const { ssh } = await this.#keys();
      const deadline = Date.now() + READY_TIMEOUT_MS;
      const address = await this.#address(host, guest.ref, deadline, signal);
      const result = await new SshTransport(ssh, this.#vm(await this.#mac(host), address, "linux"), "linux").run(GROW_ROOT, { timeoutMs: 60_000, signal, maxOutputBytes: 4096 });
      if (result.exitCode !== 0) throw new Error(`The box's disk grew, but Linux could not grow its root file system: ${result.stderr.trim() || `exit code ${result.exitCode}`}.`);
    }
    const read = (await this.#readSize(host, guest, signal)) ?? to;
    return { ...guest, size: read };
  }

  /** A running Linux VM's Mac and size, when it is the box's and the disk asked for is not smaller (061). */
  async #resizable(guest: Guest, to: BoxSize, signal?: AbortSignal): Promise<{ host: TartHost; from: BoxSize }> {
    const host = this.#hostOf(guest);
    const power = await this.power(guest, signal);
    if (power === null) throw this.#gone(guest);
    if (power !== "running") throw new BackendError("unsupported", "A stopped VM is resized once it runs: start it first.");
    const from = await this.#readSize(host, guest, signal);
    if (!from) throw new Error(`Tart did not say the size of ${guest.ref}, so bb-box cannot resize it.`);
    if (to.diskGiB !== null && from.diskGiB !== null && to.diskGiB < from.diskGiB) {
      throw new BackendError("unsupported", `A VM's disk only grows, and this one's is ${from.diskGiB} GiB.`);
    }
    return { host, from };
  }

  /** A VM's size as `tart get` gives it, its disk in GiB; null when Tart does not say. */
  async #readSize(host: TartHost, guest: Guest, signal?: AbortSignal): Promise<BoxSize | null> {
    const result = await this.#run(host, sizeScript(guest.ref, this.#context.installId, this.#boxOf(guest), null), { timeoutMs: 30_000, signal });
    if (result.stdout.trim() === "gone") throw this.#gone(guest);
    return parseTartSize(result.stdout);
  }

  /** Room on the Mac for a VM to grow from `from` to `to` (061): the memory it adds within the reserve, cores within the Mac's, and the disk it adds. */
  #resizeRoom(host: TartHost, state: MacState | Error, from: BoxSize, to: BoxSize, pending: readonly Pending[]): Capacity {
    if (state instanceof Error) return { ok: false, message: `${host.name} did not answer: ${state.message}`, warm: null, hosts: [{ host: host.name, ok: false, limits: [] }] };
    const running = state.vms.filter((vm) => vm.running);
    const memoryUsed =
      running.reduce((sum, vm) => sum + (state.configs.get(vm.name)?.memoryMiB ?? 0), 0) +
      [...state.qemu.vms].filter(([, vm]) => vm.power === "running").reduce((sum, [, vm]) => sum + vm.memoryMiB + QEMU_OVERHEAD_MIB, 0) +
      pending.reduce((sum, other) => sum + other.size.memoryMiB, 0);
    const memoryFree = state.memoryMiB - memoryUsed;
    const reserve = this.#config.reserve;
    const diskReserveMiB = reserve.diskGiB * MiB_PER_GiB;
    const limits: Limit[] = [
      { resource: "memory", used: memoryUsed, total: state.memoryMiB, reserve: reserve.memoryMiB, unit: "MiB" },
      { resource: "disk", used: state.disk.totalMiB - state.disk.freeMiB, total: state.disk.totalMiB, reserve: diskReserveMiB, unit: "MiB" },
    ];
    const grow = to.memoryMiB - from.memoryMiB;
    const disk = to.diskGiB !== null ? Math.max(0, to.diskGiB - (from.diskGiB ?? to.diskGiB)) : 0;
    let why: string | null = null;
    if (state.cpus && to.cores > state.cpus) {
      why = `${host.name} has ${state.cpus} cores, fewer than the ${to.cores} asked for. Ask for at most ${state.cpus} cores.`;
    } else if (grow > 0 && memoryFree - grow < reserve.memoryMiB) {
      why =
        grow > memoryFree
          ? `${host.name} has ${formatMiB(Math.max(0, memoryFree))} of memory free, less than the ${formatMiB(grow)} more the box needs. Ask for less memory or release a box.`
          : `${host.name} has ${formatMiB(memoryFree)} of memory free and keeps ${formatMiB(reserve.memoryMiB)} free, so the ${formatMiB(grow)} more the box needs does not fit. ` +
            "Ask for less memory, release a box, or lower the memory kept free in bb-box's settings.";
    } else if (disk > 0 && state.disk.freeMiB - disk * MiB_PER_GiB < diskReserveMiB) {
      why = `${host.name} has ${diskFree(state.disk)} and keeps ${formatMiB(diskReserveMiB)} free, so ${disk} GiB more disk does not fit. Ask for a smaller disk or release boxes.`;
    }
    return { ok: why === null, message: why, warm: null, hosts: [{ host: host.name, ok: why === null, limits }] };
  }

  /** A stop suspends a macOS VM, and saves a Windows one through QEMU, which frees its memory and its slot. A Linux VM shuts down. */
  keepsSession(kind: string): boolean {
    const os = this.kinds().find((candidate) => candidate.id === kind)?.capabilities.os;
    return os === "macos" || os === "windows";
  }

  async stop(guest: Guest, signal?: AbortSignal): Promise<void> {
    const host = this.#hostOf(guest);
    // A Linux VM shuts itself down, and the Mac waits for it; one that cannot be asked is stopped.
    // Only this install's box is asked, and only when it runs: another install's is "gone" (stopScript).
    const os = this.#osOf(guest);
    if (os === "windows") {
      // QEMU saves the VM, and a start restores it (046).
      const port = this.#sshPort(guest) ?? (await this.#ports(host, guest, signal).catch(() => null))?.ssh ?? null;
      await this.#forget(host, guest.ref, os, port);
      const result = await this.#run(host, qemuStopScript(guest.ref, this.#context.installId, this.#boxOf(guest)), { timeoutMs: 240_000, signal });
      if (result.stdout.trim() === "gone") throw this.#gone(guest);
      return;
    }
    let how: "suspend" | "stop" | "shutdown" = "suspend";
    if (os === "linux") {
      const power = await this.power(guest, signal);
      if (power === null) throw this.#gone(guest);
      how = power === "running" && (await this.#powerOff(host, guest, signal)) ? "shutdown" : "stop";
    }
    await this.#forget(host, guest.ref, os);
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
    const result = (await this.#run(host, relabelScript(guest.ref, this.#context.installId, box.boxId, this.#owner(box)), { signal })).stdout.trim();
    if (result !== "relabelled") throw new Error(`The owner file of ${guest.ref} on ${host.name} does not name box ${box.boxId}.`);
    if (from !== box.name && guest.address) await this.#name(host, guest.address, guest.ref, this.#osOf(guest), box.name, signal);
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
        // An image box or build (049) is no box's: its build removes it.
        if (fields["image-box"] || fields["image-build"]) continue;
        // A warm VM is no box's, and neither is one this instance is filling.
        // One being filled when bb-box stopped is listed with no owner, so the
        // sweep releases it.
        const warm = warmState(fields);
        if (warm === "warm" || (warm === "filling" && this.#filling.has(vm))) continue;
        const owner = ownerOf(fields);
        if (fields.engine === "qemu") {
          // A Windows VM not made yet, after an acquire cut short before its clone, counts as stopped.
          const made = state.qemu.vms.get(vm);
          held.push({
            ref: vm,
            host: host.name,
            address: null,
            size: made ? { cores: made.cores, memoryMiB: made.memoryMiB, diskGiB: made.diskGiB } : null,
            data: owner ? { box: owner.boxId, os: "windows", ...(made ? { ssh: made.ssh, vnc: made.vnc } : {}) } : { os: "windows" },
            owner,
            power: made ? powerOf(made.power) : "stopped",
          });
          continue;
        }
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

  // The warm pool: clones at a kind's default size (028), suspended by Tart or,
  // for Windows, saved by QEMU (046), which hold no VM slot and no memory,
  // only disk, until a box takes one and resumes or restores it.

  /**
   * Retires warm VMs that serve no pool now, or beyond their pool's count,
   * and fills what is missing, then removes what an image refresh or try
   * left when it could not reach the Mac to clean up.
   */
  async maintain(signal?: AbortSignal): Promise<void> {
    try {
      await this.#upkeep.run(signal ?? this.#stopping.signal);
    } finally {
      await this.#leftovers(signal).catch((error) => this.#context.logError("image leftovers", error));
    }
  }

  /**
   * Deletes this install's refresh build VMs, and its image boxes, older
   * than LEFTOVER_MS (#707): a refresh or try removes them as it ends, but
   * not when the Mac was out of reach then, and a running one holds one of
   * the Mac's two macOS slots. A refresh build's name holds its start, and
   * its prepare script's own VM is the name with -build, which has no owner
   * file. Builds of projects' images are the bakes' to remove.
   */
  async #leftovers(signal?: AbortSignal): Promise<void> {
    const states = await this.#states(signal);
    const now = Date.now();
    for (const host of this.#on()) {
      const state = states.get(host.name);
      if (!state || state instanceof Error) continue;
      const names = new Set([...state.vms.map((vm) => vm.name), ...state.owners.keys()]);
      for (const vm of names) {
        signal?.throwIfAborted();
        const fields = state.owners.get(vm);
        if (fields && fields.install !== this.#context.installId) continue;
        const refresh = new RegExp(`^${VM_PREFIX}img-refresh-([0-9a-z]+)(?:-build)?$`).exec(vm);
        const created = refresh ? parseInt(refresh[1]!, 36) : fields?.["image-box"] ? Number(fields.created) : NaN;
        if (!Number.isFinite(created) || now - created < LEFTOVER_MS) continue;
        const os = guestOsOf(fields?.kind ?? "macos");
        await this.#delete(host, vm, os, null, signal);
        await this.#run(host, forgetImageScript(vm), { timeoutMs: 30_000, signal });
        this.#context.log?.(`Removed ${vm} on ${host.name}: ${refresh ? "an image refresh's build" : `an image box (${fields!["image-box"]})`} left ${Math.round((now - created) / 3_600_000)} h ago, as its run could not clean up.`);
      }
    }
  }

  /** Tops the pool up in the background after a box takes a warm VM. */
  #kick(): void {
    if (!this.#pools().some((pool) => pool.target > 0)) return;
    this.maintain(this.#stopping.signal).catch((error) => this.#context.logError("warm pool", error));
  }

  /**
   * The warm pools the configuration asks for now: kinds with an image, on,
   * whose default size has the image's disk, grouped by image, guest OS and
   * default size.
   */
  #pools(): WarmPool[] {
    const pools: WarmPool[] = [];
    for (const kind of this.#kinds) {
      const settings = this.#context.kind(kind.id);
      const image = this.#config.kinds[kind.id as TartKind].image;
      const os = guestOsOf(kind.id);
      // Warm VMs are saved: Tart cannot suspend a Linux VM (040); QEMU saves a Windows one (046).
      if (os === "linux") continue;
      if (!settings.enabled || !image || settings.defaultSize.diskGiB !== null) continue;
      const size = settings.defaultSize;
      const index = pools.findIndex((pool) => pool.image === image && pool.os === os && sameSize(pool.size, size));
      const target = this.#context.warm(kind.id);
      if (index < 0) pools.push({ image, os, size, kinds: [kind.id], target });
      else pools[index] = { ...pools[index]!, kinds: [...pools[index]!.kinds, kind.id], target: pools[index]!.target + target };
    }
    return pools;
  }

  /**
   * The kinds a warm VM serves now: those whose image is the VM's, at the
   * build the VM was cloned from, and whose default size is the VM's. A VM
   * saved under another macOS build, or another version of the engine that
   * saved it, Tart or QEMU, serves none, as its state may not restore.
   */
  #servedBy(state: MacState, fields: Readonly<Record<string, string>>, size: BoxSize | null): string[] {
    const windows = fields.engine === "qemu";
    if (!size || fields.macos !== state.macosBuild || (windows ? fields.qemu !== state.qemu.version : fields.tart !== state.version)) return [];
    const build = windows ? (state.qemu.image?.build ?? "") : null;
    return this.#pools()
      .filter(
        (pool) =>
          (pool.os === "windows") === windows &&
          pool.image === fields.image &&
          (build ?? state.builds.get(pool.image) ?? "") === (fields.build ?? "") &&
          sameSize(pool.size, size),
      )
      .flatMap((pool) => pool.kinds);
  }

  /** This install's free warm VMs on a Mac: saved, marked warm, serving a kind now. */
  #freeWarm(state: MacState): FreeWarm[] {
    const free: FreeWarm[] = [];
    for (const [vm, fields] of state.owners) {
      if (fields.install !== this.#context.installId || warmState(fields) !== "warm") continue;
      const { size, suspended } = warmOf(state, vm, fields);
      if (!suspended) continue;
      const kinds = this.#servedBy(state, fields, size);
      if (size && kinds.length) free.push({ vm, size, kinds, ready: fields.grants === this.#helperHash() });
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
    const held = (await this.#run(host, holdScript(member.ref, this.#context.installId, "warm", this.#owner(box)), { signal })).stdout.trim();
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
      const out: { host: TartHost; vm: string; os: GuestOs }[] = [];
      for (const host of this.#on()) {
        const state = states.get(host.name)!;
        if (state instanceof Error) continue;
        for (const [vm, fields] of state.owners) {
          if (fields.install !== this.#context.installId || warmState(fields) !== "warm") continue;
          // Only a saved warm VM can be claimed: one that someone ran or
          // stopped since is retired. One being claimed no longer says warm.
          const { size, suspended } = warmOf(state, vm, fields);
          const kinds = this.#servedBy(state, fields, size);
          const pool = pools.find((candidate) => kinds.length && candidate.kinds.includes(kinds[0]!));
          const count = pool ? (kept.get(pool) ?? 0) : 0;
          if (pool && suspended && count < pool.target) {
            kept.set(pool, count + 1);
            continue;
          }
          out.push({ host, vm, os: fields.engine === "qemu" ? "windows" : "macos" });
        }
      }
      return out;
    });
    for (const { host, vm, os } of retired) {
      // Its owner file names no box, so a box that held it meanwhile keeps it.
      await this.#delete(host, vm, os, null, signal).catch((error) => this.#context.logError("retire a warm VM", error));
    }

    const short: WarmShortfall[] = [];
    for (const pool of pools) {
      if (pool.target === 0) continue;
      const states = await this.#states(signal);
      let ready = 0;
      for (const host of this.#on()) {
        const state = states.get(host.name)!;
        if (!(state instanceof Error)) ready += this.#freeWarm(state).filter((warm) => warm.kinds.includes(pool.kinds[0]!)).length;
      }
      const filling = [...this.#filling.values()].filter((fill) => !fill.adopted && sameSize(fill.size, pool.size) && fill.kinds.includes(pool.kinds[0]!)).length;
      let have = ready + filling;
      while (have < pool.target) {
        signal.throwIfAborted();
        const made = await this.#fill(pool, signal);
        if (made === true) {
          have++;
          continue;
        }
        if (made !== false) short.push({ kinds: pool.kinds.filter((kind) => this.#context.warm(kind) > 0), count: pool.target, have, reason: made });
        break;
      }
    }
    this.#context.warmShortfalls(short);
  }

  /**
   * Makes one warm VM of a pool: clones it, boots it to the logged-in
   * desktop, and suspends it, or for Windows compiles the display helper
   * and saves it. It takes its memory, and a macOS VM a VM slot, until then,
   * so it is placed as a box is, and an acquire that needs the room takes it
   * over or stops it. Resolves true once made, false when an acquire took
   * its room, or with why no Mac has room.
   */
  async #fill(pool: WarmPool, signal: AbortSignal): Promise<boolean | string> {
    const vm = `${WARM_PREFIX}${randomBytes(6).toString("hex")}`;
    const windows = pool.os === "windows";
    const placed = await this.#chain(async () => {
      const states = await this.#states(signal);
      const whys: string[] = [];
      for (const host of this.#on()) {
        const state = states.get(host.name)!;
        const room = this.#room(host, state, pool.size, NONE_UNPLACED, new Set(), pool.os, true);
        if (state instanceof Error || !room.capacity.ok) {
          whys.push(room.why!);
          continue;
        }
        this.#placing.set(vm, { host: host.name, vm, memoryMiB: footprint(pool.kinds[0]!, pool.size), macos: !windows });
        return { host, state };
      }
      return whys.length ? `${whys.join("; ")}.` : "Every Mac is off in bb-box's settings.";
    });
    if (typeof placed === "string") return placed;
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
    const deadline = Date.now() + (this.#options.readyTimeoutMs ?? (windows ? WINDOWS_READY_TIMEOUT_MS : READY_TIMEOUT_MS));
    // A Windows VM's SSH port on the Mac, once it is made.
    let port: number | null = null;
    // Whether a macOS VM's helper made its signing identity and default grants.
    let granted: string | null = null;
    try {
      const owner = ownerText({
        install: this.#context.installId,
        state: "filling",
        image: pool.image,
        ...(windows
          ? { build: state.qemu.image?.build ?? "", qemu: state.qemu.version, macos: state.macosBuild, engine: "qemu" }
          : { build: state.builds.get(pool.image) ?? "", tart: state.version, macos: state.macosBuild }),
      });
      const claimed = (await this.#run(host, claimScript(vm, owner), { signal: fillSignal })).stdout.trim();
      if (claimed !== "claimed") throw new Error(`Warm VM ${vm} on ${host.name} is already there.`);
      let address = "";
      if (windows) {
        const clone = await this.#run(host, qemuCloneScript(pool.image, vm, pool.size.cores, pool.size.memoryMiB), { timeoutMs: 120_000, signal: fillSignal });
        const made = parseQemuVm(clone.stdout);
        if (!made) throw new Error(`QEMU's VM ${vm} on ${host.name} has no whole config: ${clone.stdout.trim() || "nothing"}`);
        port = made.ssh;
        await this.#start(host, vm, "windows", deadline, fillSignal, false);
        const access = this.#windows(await this.#mac(host), made.ssh);
        await this.#waitReady(host, vm, access, "windows", deadline, fillSignal);
        await this.#windowsDesktop(host, vm, access, deadline, fillSignal);
        // Before the save, so a box that takes the VM resizes its desktop at once.
        const { ssh } = await this.#keys();
        await compileDisplay(new SshTransport(ssh, access, "windows"), fillSignal);
      } else {
        await this.#run(host, cloneScript(pool.image, vm, pool.size.cores, pool.size.memoryMiB), { timeoutMs: 10 * 60_000, signal: fillSignal });
        await this.#start(host, vm, "macos", deadline, fillSignal, false);
        address = await this.#address(host, vm, deadline, fillSignal);
        await this.#waitReady(host, vm, this.#vm(await this.#mac(host), address), "macos", deadline, fillSignal);
        await this.#identify(host, address, vm, "macos", fillSignal);
        const { ssh } = await this.#keys();
        const desktop = await new SshTransport(ssh, this.#vm(await this.#mac(host), address), "macos").run(desktopScript(), {
          timeoutMs: 240_000,
          signal: fillSignal,
          maxOutputBytes: 4096,
        });
        if (desktop.exitCode !== 0) throw new Error(`Warm VM ${vm} on ${host.name}: ${desktop.stderr.trim() || `exit code ${desktop.exitCode}`}`);
        // The signing identity and default grants, before the suspend, so the claim need not make them.
        granted = (await this.#vmReady(host, address, vm, fillSignal)) ? this.#helperHash() : null;
      }
      ready.resolve(address);
      // In the chain, so an acquire that takes the VM over and this save never cross.
      const adopted = await this.#chain(async () => {
        if (fill.adopted) return true;
        fillSignal.throwIfAborted();
        await this.#forget(host, vm, pool.os, port);
        const script = windows ? qemuWarmScript(vm, this.#context.installId) : warmScript(vm, this.#context.installId, granted);
        const result = (await this.#run(host, script, { timeoutMs: windows ? 240_000 : 120_000, signal: fillSignal })).stdout.trim();
        if (result !== "warm") throw new Error(`Warm VM ${vm} on ${host.name} was no longer being filled.`);
        return false;
      });
      if (!adopted) this.#placing.delete(vm);
      return true;
    } catch (error) {
      ready.reject(error);
      if (!fill.adopted) {
        this.#placing.delete(vm);
        await this.#delete(host, vm, pool.os, null, undefined, port).catch((cause) => this.#context.logError("release a warm VM that failed", cause));
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
    const capabilities = this.#kinds.find((candidate) => candidate.id === kind)?.capabilities;
    if (guestOsOf(kind) === "windows") {
      const ports = await this.#ports(host, guest);
      const access = this.#windows(mac, ports.ssh);
      const command = new SshTransport(ssh, access, "windows");
      // Video where the kind declares it and this box has bb-box-stream.exe, for the keys and the clipboard: a box of an
      // older build may not (060).
      const declared = (capabilities?.displays ?? []).some((display) => display.protocol === "selkies");
      const video = declared && (await this.#hasWindowsStream(this.#streamKey(guest), command));
      // The video comes from QEMU's VNC server on the Mac, through the Mac's build of bb-box-stream (#865), where it is ready.
      const fromMac = video && this.#qemuVideoReady.has(host.name);
      const displays = (capabilities?.displays ?? []).flatMap((display): Display[] => {
        if (display.protocol === "selkies") {
          const { byChoice: _byChoice, ...shown } = display;
          if (!fromMac) return [];
          const { build } = this.#videoBuild();
          return [
            {
              ...shown,
              label: "Desktop, as video",
              open: async () => ({ route: ssh.commandRoute(mac, qemuVideoOpenScript(guest.ref, ports.vnc, build)), auth: { type: "none" } }),
              openInput: async () => ({ route: ssh.commandRoute(access, WINDOWS_STREAM), auth: { type: "none" } }),
            },
          ];
        }
        // QEMU types a person's keys by key on a US layout: a character it would type wrong goes to bb-box-stream.
        const stream: OpenStream = (signal) => openRoute(ssh.commandRoute(access, WINDOWS_STREAM), signal);
        return [
          {
            ...display,
            label: "Desktop",
            // QEMU's VNC server listens on the Mac's loopback only, so it asks for no password.
            open: async () => ({
              route: ssh.route(mac, ports.vnc),
              auth: { type: "none" },
              ...(video ? { input: async () => windowsCharacterInput(stream), inputTakes: "characters" as const, typesAsCharacter: windowsTypesAsCharacter, keyDelayMs: QEMU_KEY_DELAY_MS } : {}),
            }),
            resize: (size, signal) => this.#resizeWindows(guest.ref, command, size, signal),
            // QEMU's VNC shows the pointer Windows draws once a mouse has moved: out while a person in control watches it.
            pointer: (shown, signal) => windowsPointer(command, shown, signal),
            pointerWhile: "rfb",
            // Where the pointer is, from bb-box-stream.exe, which bb-box draws for people watching: the video from the Mac
            // has no pointer in it, nor has QEMU's VNC, as Windows puts it on the GPU's cursor plane (#865).
            ...(video ? { followPointer: (onEvent: (event: BoxPointer) => void, signal: AbortSignal) => followWindowsPointer(stream, onEvent, signal) } : {}),
            minSize: MIN_DESKTOP,
          },
        ];
      });
      return { command, displays, access: { ssh: access, dockerHost: null } };
    }
    let address: string | null = this.#addresses.get(guest.ref) ?? null;
    if (!address) {
      address = (await this.#lookup(host, guest.ref).catch(() => null)) ?? guest.address;
    }
    if (!address) throw new TransportError("unreachable", `The VM ${guest.ref} on ${host.name} has no address. It may be stopped.`);
    const os = guestOsOf(kind);
    const access = this.#vm(mac, address, os);
    const command = new SshTransport(ssh, access, os);
    // Video where the kind declares it and this VM has its stream: bb-box-stream on macOS, Selkies' launcher on a Linux
    // desktop (060). A box of an older build, or of a project's image, may not.
    const stream = os === "macos" ? (this.#options.macStream ?? MAC_STREAM) : (this.#options.selkiesLauncher ?? SELKIES_LAUNCHER);
    const video = (capabilities?.displays ?? []).some((display) => display.protocol === "selkies") && (await this.#hasStream(guest.ref, command, stream));
    const displays = (capabilities?.displays ?? []).flatMap((display): Display[] => {
      if (display.protocol === "selkies") {
        if (!video) return [];
        // A Linux desktop's Selkies listens on the VM's loopback, as its VNC server's port is reached: through SSH to the VM.
        if (os === "linux") return [selkiesDisplay(async (port) => ssh.route(access, port), display)];
        return [{ ...display, label: "Desktop, as video", open: async () => ({ route: ssh.commandRoute(access, macStreamCommand()), auth: { type: "none" } }) }];
      }
      return [
        {
          ...display,
          label: "Desktop",
          open: async (signal) => {
            // A Linux desktop's own VNC server, through SSH to the VM.
            if (os === "linux") {
              const password = await this.#linuxVncPassword(command, signal);
              return { route: ssh.route(access, LINUX_VNC_PORT), auth: password ? { type: "vnc-password", password } : { type: "none" } };
            }
            // A macOS desktop is Tart's VNC server, through the run's holder,
            // which keeps the run's one connection to it (#406). The server
            // drops the wheel, so its notches go to the input helper in the
            // VM's desktop session, which posts them as a mouse's. It types by
            // key on a US keyboard, so a character it has no key for, or that
            // needs a Shift the viewer does not hold, goes to the helper too.
            const held = await this.#held(host, mac, guest.ref, ssh, signal);
            return {
              ...held,
              inputTakes: "wheel" as const,
              typesAsCharacter: tartTypesAsCharacter,
              input: (events: DisplayInputEvents, inputSignal?: AbortSignal) =>
                startMacInput(command, events, `The desktop's wheel helper did not start in ${guest.ref}: its user may not be signed in to the desktop.`, inputSignal),
            };
          },
          ...(os === "linux" ? { minSize: MIN_DESKTOP } : {}),
        },
      ];
    });
    return { command, displays, access: { ssh: access, dockerHost: null } };
  }

  /** Its hosts, for the doctor's warning when one is also a Mac the SSH host pool lends whole (047). */
  footprint(): Footprint {
    return { machines: this.#config.hosts.map((host) => host.address.toLowerCase()) };
  }

  async doctor(signal?: AbortSignal): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    const notes: string[] = [`This install's ID is ${this.#context.installId}. Its VMs' owner files on each Mac, in ~/.bb-box/tart/owners, name it.`];
    const push = (id: CheckId, name: string, status: DoctorCheck["status"], detail: string, fix: string | null = null) =>
      checks.push({ id, name, status, detail, fix });

    let keys: SshKeys | null = null;
    try {
      keys = await this.#keys();
      if (keys.publicKey) {
        push("tart.ssh-key", "SSH key", "ok", keys.generated ? "bb-box made a key; its public key is below." : "From bb-box's settings; its public key is below.");
        notes.push(
          `Each Mac's user, user ${this.#config.ssh.vmUser} in each macOS image and user ${LINUX_USER} in the Linux and Windows images, must accept this SSH key in ~/.ssh/authorized_keys: ${keys.publicKey}`,
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
    // What images are judged by (049), read while the Macs are.
    const images = this.#context.images;
    const judging = Promise.all([
      images?.pins("linux") ?? null,
      images?.pins("linux-desktop") ?? null,
      images?.pins("macos") ?? null,
      images?.pins("windows-arm64") ?? null,
      images?.bbApp(signal) ?? null,
    ]).catch(() => [null, null, null, null, null] as const);
    const states = keys ? await this.#states(signal) : new Map<string, MacState | Error>();
    const [linuxPins, desktopPins, macosPins, windowsPins, app] = await judging;
    /** An image's record judged, with the prepare script's command that builds it again as the fix. */
    const judge = (kind: TartKind, image: string, record: ImageRecord | null, on: string): ImageJudgement => {
      const os = guestOsOf(kind);
      const key = "--key '<bb-box's public key>'";
      const command =
        os === "windows"
          ? `prepare-windows-image.sh --iso <ISO> --iso-sha256 <its SHA-256> ${key} --name ${image} --replace`
          : os === "linux"
            ? `prepare-linux-image.sh${kind === "linux-arm64-desktop-cpu" ? " --desktop" : ""} ${key} --name ${image} --bb-url <BB's server URL> --replace`
            : `prepare-image.sh ${key} --name ${image} --bb-url <BB's server URL> --replace`;
      const pins = os === "windows" ? windowsPins : os === "macos" ? macosPins : kind === "linux-arm64-desktop-cpu" ? desktopPins : linuxPins;
      // A Windows image carries no build of BB's app: BB's installer puts it in as a box joins BB.
      return judgeImage(record, { os, pins, bbApp: os === "windows" ? null : app, joins: this.#config.windowsEnrol }, `Build it again on ${on} with setup/tart/${command}.`);
    };
    const others = new Map<string, number>();
    const tart = this.#tart();
    const windowsImage = this.#config.kinds["windows-arm64-desktop"].image;
    for (const host of this.#config.hosts) {
      const id = `host.${host.name}` as const;
      const name = `Mac ${host.name}`;
      const images = TART_KINDS.filter((kind) => guestOsOf(kind) !== "windows" && this.#config.kinds[kind].image);
      const state = states.get(host.name);
      if (!state || state instanceof Error) {
        push(
          id,
          name,
          state ? "fail" : "skipped",
          state ? state.message : "Skipped until the checks above pass.",
          state
            ? `Check that ${host.user}@${host.address} accepts bb-box's key over SSH${tart ? ", that its host key is in bb-box's settings, and that Tart is installed" : " and that its host key is in bb-box's settings"} (setup/tart/README.md).`
            : null,
        );
        if (windowsImage) push(`qemu.${host.name}`, `QEMU on ${host.name}`, "skipped", "Skipped until the checks above pass.");
        for (const kind of [...images, ...(windowsImage ? (["windows-arm64-desktop"] as const) : [])]) {
          push(`image.${host.name}.${kind}`, `${kind} image on ${host.name}`, "skipped", "Skipped until the checks above pass.");
        }
        continue;
      }
      if (state.arch !== "arm64") {
        push(id, name, "fail", `${host.name} is ${state.arch || "not Apple silicon"}; Tart runs macOS VMs on Apple silicon only.`, "Use a Mac with Apple silicon.");
      } else {
        push(id, name, "ok", `macOS ${state.macos} on Apple silicon${tart ? `, Tart ${state.version}` : ""}.`);
      }
      if (windowsImage) this.#doctorQemu(host, state.qemu, windowsImage, push, judge);
      if (windowsImage && state.qemuVideo) this.#doctorQemuVideo(host, state.qemuVideo, push);
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
          const judged = judge(kind, image, state.records.get(image) ?? null, host.name);
          push(
            `image.${host.name}.${kind}`,
            `${kind} image on ${host.name}`,
            judged.status,
            `${image}${config ? `, ${config.cpus} cores and ${formatMiB(config.memoryMiB)} as prepared` : ""}. ${judged.detail}`,
            judged.fix,
          );
        }
      }
      const room = this.#room(host, state, this.#context.kind("macos").defaultSize);
      push(
        `capacity.${host.name}`,
        `Room on ${host.name}`,
        room.capacity.ok ? "ok" : "warn",
        room.why ??
          room.capacity.limits
            .map((limit) => `${limit.resource} ${limit.unit === "MiB" ? `${formatMiB(limit.used)} of ${formatMiB(limit.total ?? 0)}` : `${limit.used} of ${limit.total}`}${limit.id ? ` on ${limit.id}` : ""}`)
            .join(", "),
        room.capacity.ok ? null : "Release or stop a macOS box, or stop another VM on the Mac.",
      );
      const { reserve } = this.#config;
      const sizes = sizesCheck({
        id: `sizes.${host.name}`,
        name: `Box sizes on ${host.name}`,
        host: host.name,
        has: `${state.cpus ? `${state.cpus} cores and ` : ""}${formatMiB(state.memoryMiB)} memory`,
        keepsMiB: reserve.memoryMiB,
        // A Windows VM's QEMU takes memory of its own.
        kinds: [...images, ...(windowsImage ? (["windows-arm64-desktop"] as const) : [])].map((kind) => ({
          kind,
          settings: this.#context.kind(kind),
          largest: { cores: state.cpus || Infinity, memoryMiB: state.memoryMiB - reserve.memoryMiB - (guestOsOf(kind) === "windows" ? QEMU_OVERHEAD_MIB : 0), diskGiB: null },
        })),
      });
      if (sizes) checks.push(sizes);
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
    const answering = [...states.values()].find((state): state is MacState => !(state instanceof Error));
    const engines = [...(tart ? [`Tart ${answering?.version || "?"}`] : []), ...(windowsImage ? [`QEMU ${answering?.qemu.version || "?"}`] : [])].join(" and ");
    return {
      ok,
      summary: ok ? `${engines} on ${this.#config.hosts.map((host) => host.name).join(", ")}` : `${first!.name}: ${first!.detail}`,
      checks,
      notes,
    };
  }

  /** The doctor's checks of QEMU and the Windows image on a Mac that answered (046). */
  #doctorQemu(
    host: TartHost,
    qemu: QemuState,
    image: string,
    push: (id: CheckId, name: string, status: DoctorCheck["status"], detail: string, fix?: string | null) => void,
    judge: (kind: TartKind, image: string, record: ImageRecord | null, on: string) => ImageJudgement,
  ): void {
    const id = `qemu.${host.name}` as const;
    const name = `QEMU on ${host.name}`;
    if (!qemu.version) {
      push(id, name, "fail", `${host.name} has no qemu-system-aarch64 on the PATH of ${host.user}'s SSH sessions.`, "Install QEMU on the Mac, with Homebrew or Nix.");
    } else if (!qemu.hvf) {
      push(id, name, "fail", `QEMU ${qemu.version} is there, but ${host.name} has no Hypervisor framework: kern.hv_support is not 1.`, "Use a Mac with Apple silicon, not a VM.");
    } else if (!qemu.firmware) {
      push(id, name, "fail", `QEMU ${qemu.version} has no UEFI firmware, edk2-aarch64-code.fd, in its share/qemu.`, "Install a QEMU that has its firmware, as Homebrew's and Nix's do.");
    } else {
      push(id, name, "ok", `QEMU ${qemu.version}, with the Hypervisor framework and its UEFI firmware.`);
    }
    const imageId = `image.${host.name}.windows-arm64-desktop` as const;
    const imageName = `windows-arm64-desktop image on ${host.name}`;
    if (!qemu.image) {
      push(imageId, imageName, "fail", `${host.name} has no Windows image ${image} in ~/.bb-box/qemu/images.`, "Prepare it on the Mac, or set the Windows image in bb-box's settings.");
    } else if (!qemu.image.readOnly) {
      push(
        imageId,
        imageName,
        "warn",
        `Build ${qemu.image.build} of ${image} is writable, and every box's disk is an overlay on it, which a change to it breaks.`,
        `Make it read-only: chmod a-w ~/.bb-box/qemu/images/${image}/${qemu.image.build}/disk.qcow2`,
      );
    } else {
      const judged = judge("windows-arm64-desktop", image, qemu.image.record, host.name);
      push(imageId, imageName, judged.status, `${image}, build ${qemu.image.build}. ${judged.detail}`, judged.fix);
    }
  }

  /** Whether the Mac can give Windows boxes video from QEMU (#865), and if not, why: the desktop shows over VNC only. */
  #doctorQemuVideo(
    host: TartHost,
    video: QemuVideo,
    push: (id: CheckId, name: string, status: DoctorCheck["status"], detail: string, fix?: string | null) => void,
  ): void {
    const id = `qemu-video.${host.name}` as const;
    const name = `Windows video on ${host.name}`;
    const off = "Until then, Windows desktops show over VNC only.";
    if (video.status === "ready") {
      push(id, name, "ok", `bb-box's build of bb-box-stream, ${this.#videoBuild().build}, gives Windows desktops video from QEMU.`);
    } else if (video.status === "no-tools") {
      push(id, name, "warn", `${host.name} has no swiftc from Xcode's Command Line Tools, which bb-box builds bb-box-stream with. ${off}`, "Install them on the Mac: xcode-select --install.");
    } else if (video.status === "failed") {
      push(id, name, "warn", `swiftc could not build bb-box-stream: ${video.why} ${off}`, "Update Xcode's Command Line Tools on the Mac, then run the checks again.");
    } else {
      push(id, name, "warn", `bb-box is building bb-box-stream on ${host.name}, which takes about a minute. ${off}`, "Run the checks again in a minute.");
    }
  }

  async dispose(): Promise<void> {
    this.#stopping.abort(new Error("bb-box is stopping."));
    await this.#upkeep.running?.catch(() => undefined);
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

  /** SSH to a Windows VM through its Mac, at the VM's port on the Mac's loopback. */
  #windows(mac: SshAccess, port: number): SshAccess {
    return { host: "127.0.0.1", port, user: WINDOWS_USER, hostKeys: [], jump: mac };
  }

  /** A box's guest OS, from its data: a Linux or Windows box's says so (acquire). */
  #osOf(guest: Guest): GuestOs {
    return guest.data?.os === "linux" || guest.data?.os === "windows" ? guest.data.os : "macos";
  }

  /** A Windows box's SSH port on its Mac, from its data. */
  #sshPort(guest: Guest): number | null {
    return typeof guest.data?.ssh === "number" ? guest.data.ssh : null;
  }

  /** A Windows box's ports on its Mac's loopback: from its data, else from the Mac. */
  async #ports(host: TartHost, guest: Guest, signal?: AbortSignal): Promise<{ readonly ssh: number; readonly vnc: number }> {
    const vnc = guest.data?.vnc;
    const ssh = this.#sshPort(guest);
    if (ssh !== null && typeof vnc === "number") return { ssh, vnc };
    const made = (await this.#state(host, signal)).qemu.vms.get(guest.ref);
    if (!made) throw new TransportError("unreachable", `The VM ${guest.ref} on ${host.name} is not there.`);
    return made;
  }

  /**
   * A running VM as a refusal or the doctor names it: the box it serves, where
   * this install's owner file names one, as a claimed warm VM keeps its warm
   * name (#599); otherwise its own name. The threads of spare boxes and your
   * machines are core's SPARES and OPERATOR.
   */
  #vmWords(vm: string, owner: Readonly<Record<string, string>> | undefined): string {
    if (!owner?.name || owner.install !== this.#context.installId) return vm;
    if (owner.thread === "spare") return `spare box ${owner.name}`;
    if (owner.thread === "operator") return `your machine ${owner.name}`;
    return owner.thread ? `box ${owner.name} of thread ${owner.thread}` : `box ${owner.name}`;
  }

  /** A box's owner file: a Windows box's names its engine, QEMU (046). */
  #owner(box: BoxIdentity): string {
    return ownerText({
      install: this.#context.installId,
      kind: box.kind,
      box: box.boxId,
      thread: box.threadId,
      name: box.name,
      created: box.createdAt,
      ...(guestOsOf(box.kind) === "windows" ? { engine: "qemu" } : {}),
    });
  }

  /** Whether a kind Tart runs has an image, so the Macs need Tart (046). */
  #tart(): boolean {
    return TART_KINDS.some((kind) => guestOsOf(kind) !== "windows" && this.#config.kinds[kind].image);
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

  /** The Mac's state, in one trip: Tart's VMs when a Tart kind has an image, and QEMU's always. */
  async #state(host: TartHost, signal?: AbortSignal): Promise<MacState> {
    const windowsImage = this.#config.kinds["windows-arm64-desktop"].image;
    const video = windowsImage ? this.#videoBuild() : null;
    const text = (await this.#run(host, stateScript(this.#tart(), `${qemuStateBody(windowsImage)}${video ? qemuVideoStateBody(video.build) : ""}`), { timeoutMs: 30_000, signal })).stdout;
    const qemuVideo = video ? parseQemuVideo(text) : null;
    if (qemuVideo?.status === "ready") this.#qemuVideoReady.add(host.name);
    else this.#qemuVideoReady.delete(host.name);
    if (qemuVideo?.status === "missing") this.#buildVideo(host);
    return { ...parseState(text), qemu: parseQemuState(text), qemuVideo };
  }

  /** bb-box-stream's source and its build's name, read once. */
  #videoBuild(): { readonly source: string; readonly build: string } {
    if (!this.#qemuVideo) {
      const source = this.#options.qemuVideoSource ?? qemuVideoSource();
      this.#qemuVideo = { source, build: qemuVideoBuild(source) };
    }
    return this.#qemuVideo;
  }

  /**
   * Builds bb-box-stream on the Mac for Windows video (#865), in the background, unless it builds there already. The
   * Mac's state says how it went: the doctor shows why it failed, and Windows video waits for it.
   */
  #buildVideo(host: TartHost): void {
    if (this.#qemuVideoBuilds.has(host.name)) return;
    const { source, build } = this.#videoBuild();
    const running = (async () => {
      const { ssh } = await this.#keys();
      const mac = new SshTransport(ssh, await this.#mac(host), "macos");
      await this.#run(host, script('mkdir -p "$HOME/.bb-box/qemu/bin" && chmod 700 "$HOME/.bb-box/qemu" "$HOME/.bb-box/qemu/bin"'), { signal: this.#stopping.signal });
      await mac.writeFile(qemuVideoSourcePath(build), new TextEncoder().encode(source), { mode: "600", signal: this.#stopping.signal });
      await this.#run(host, qemuVideoBuildScript(build), { timeoutMs: 15 * 60_000, signal: this.#stopping.signal });
      this.#qemuVideoReady.add(host.name);
    })()
      .catch((error: unknown) => {
        if (!this.#stopping.signal.aborted) this.#context.logError("build bb-box-stream for Windows video", error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => this.#qemuVideoBuilds.delete(host.name));
    this.#qemuVideoBuilds.set(host.name, running);
  }

  /**
   * Starts the VM, detached from SSH, and fails fast when Tart, or QEMU for
   * a Windows VM, cannot. A VM whose saved state does not restore, as after
   * an update of macOS, Tart or QEMU, boots afresh from its disk when
   * `discard` is true; a warm VM gives way to a clone instead.
   */
  async #start(host: TartHost, vm: string, os: GuestOs, deadline: number, signal?: AbortSignal, discard = true, box: string | null = null): Promise<void> {
    try {
      await this.#launch(host, vm, os, deadline, signal);
    } catch (error) {
      if (!discard || !failedRestore(error)) throw error;
      this.#context.logError(
        "start",
        new Error(
          `Warning: the saved state of ${box ? `box ${box}'s VM ${vm}` : vm} on ${host.name} did not restore, so it boots afresh from its disk; what ran in it is lost. ` +
            `After an update of macOS or ${os === "windows" ? "QEMU" : "Tart"}, every stopped box on the Mac does this once. ${message(error)}`,
        ),
      );
      await this.#run(host, os === "windows" ? qemuDiscardScript(vm) : discardStateScript(vm), { timeoutMs: 30_000, signal });
      await this.#launch(host, vm, os, deadline, signal);
    }
  }

  async #launch(host: TartHost, vm: string, os: GuestOs, deadline: number, signal?: AbortSignal): Promise<void> {
    const seconds = Math.max(5, Math.min(180, Math.round((deadline - Date.now()) / 1000)));
    const { ssh } = await this.#keys();
    const windows = os === "windows";
    const script = windows ? qemuStartScript(vm, seconds) : startScript(vm, seconds);
    const result = await ssh.run(await this.#mac(host), script, { timeoutMs: (seconds + 30) * 1000, signal, maxOutputBytes: 1 << 16 }, "macos");
    if (result.exitCode === 0) return;
    const said = result.stderr.trim();
    if (!windows && result.exitCode === 3 && /exceeds the system limit/i.test(said)) {
      throw new BackendError(
        "no_capacity",
        `${host.name} already runs as many VMs as macOS allows, two: ${said.split("\n").pop()}. Release or stop a macOS box, or stop another VM on ${host.name}.`,
      );
    }
    if (result.exitCode === 255) throw new HostError(`${host.name} did not answer over SSH as ${host.user}: ${said || "no reason given"}.`);
    throw new Error(`${windows ? "QEMU" : "Tart"} could not start ${vm} on ${host.name}: ${said || `exit code ${result.exitCode}`}`);
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
  async #waitReady(host: TartHost, vm: string, access: SshAccess, os: GuestOs, deadline: number, signal?: AbortSignal): Promise<void> {
    const { ssh } = await this.#keys();
    const command = new SshTransport(ssh, access, os);
    const left = Math.max(1_000, deadline - Date.now());
    const answers = { probe: (inner?: AbortSignal) => command.answers(inner) };
    const ready = await waitUntilAnswers(answers, { timeoutMs: left, intervalMs: 500, signal, sleep: this.#options.sleep ?? pause });
    if (!ready) {
      throw new Error(
        `${vm} on ${host.name} did not answer SSH as ${access.user} at ${access.host}${access.port === 22 ? "" : `:${access.port}`} within ${Math.round(left / 1000)} s. ` +
          `Check that the image's user ${access.user} accepts bb-box's key.`,
      );
    }
  }

  /** Waits until Windows' desktop is up: Explorer runs in a desktop session, and Cua's daemon listens. */
  async #windowsDesktop(host: TartHost, vm: string, access: SshAccess, deadline: number, signal?: AbortSignal): Promise<void> {
    const { ssh } = await this.#keys();
    const command = new SshTransport(ssh, access, "windows");
    const left = Math.max(1_000, deadline - Date.now());
    const up = { probe: (inner?: AbortSignal) => desktopUp(command, inner) };
    if (!(await waitUntilAnswers(up, { timeoutMs: left, intervalMs: WINDOWS_DESKTOP_POLL_MS, signal, sleep: this.#options.sleep ?? pause }))) {
      throw new Error(
        `Windows' desktop in ${vm} on ${host.name} was not up within ${Math.round(left / 1000)} s: Explorer did not run in a desktop session, ` +
          `or Cua's daemon did not listen on ${CUA_PIPE}. Check that the image signs the box user in.`,
      );
    }
  }

  /**
   * Compiles the display helper in the background while the box is new, so
   * its first resize is as quick as the rest. A failure is left to the first
   * resize, which compiles it again.
   */
  #compileDisplay(vm: string, access: SshAccess): void {
    const compiling = this.#keys()
      .then(({ ssh }) => compileDisplay(new SshTransport(ssh, access, "windows")))
      .catch(() => undefined)
      .finally(() => this.#compiling.delete(vm));
    this.#compiling.set(vm, compiling);
  }

  /**
   * Sets a Windows desktop to the listed mode that best covers `size` (021).
   * The display driver takes a viewer's size only at its next boot (046), so
   * the size itself is tried just once.
   */
  async #resizeWindows(vm: string, command: SshTransport, size: DisplaySize, signal?: AbortSignal): Promise<void> {
    await this.#compiling.get(vm);
    await setMode(command, size, signal, 0);
  }

  /**
   * A viewer's way to the VM's desktop: the run's VNC holder on the Mac,
   * started now if the run began before holders, through a bridge to its
   * socket, which only the Mac's host user can open. Tart's VNC server
   * crashes the VM on a second connection in a run, so bb-box never connects
   * to it but through the holder, which makes the run's only connection.
   */
  async #held(host: TartHost, mac: SshAccess, vm: string, ssh: Ssh, signal?: AbortSignal): Promise<DisplayOpened> {
    const { ssh: shell } = await this.#keys();
    const result = await shell.run(mac, holderScript(vm), { timeoutMs: 30_000, signal, maxOutputBytes: 1 << 16 }, "macos");
    if (result.exitCode === 255) throw new HostError(`${host.name} did not answer over SSH as ${host.user}: ${result.stderr.trim() || "no reason given"}.`);
    if (result.exitCode !== 0) {
      const why = result.stderr.trim() || `exit code ${result.exitCode}`;
      throw new Error(
        result.exitCode === 4
          ? `The desktop's stream for this run of ${vm} has ended: ${why.replace(/\.$/, "")}. Stop and start the box to show its desktop again.`
          : `${host.name} could not start the desktop's stream for ${vm}: ${why}`,
      );
    }
    const socket = `"$HOME"/.bb-box/tart/run/${quote(`${vm}.vnc`)}`;
    return { route: ssh.commandRoute(mac, `exec /usr/bin/python3 -c '${VNC_BRIDGE_PY}' ${socket}`), auth: { type: "none" } };
  }

  /**
   * Checks that the VM that answers at `address` is `vm` (identityScript). A
   * VM that keeps no name, as one made before names were kept or whose file
   * was removed, is named only when the Mac's ARP table, just after bb-box
   * reached the address, gives the MAC address in the VM's config.
   */
  async #identify(host: TartHost, address: string, vm: string, os: GuestOs, signal?: AbortSignal): Promise<void> {
    const { ssh } = await this.#keys();
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

  /** Sets a resumed macOS VM's clock from this server's (macClockScript). A box whose clock could not be set still works, so that only logs. */
  async #clock(host: TartHost, address: string, signal?: AbortSignal): Promise<void> {
    const { ssh } = await this.#keys();
    const command = new SshTransport(ssh, this.#vm(await this.#mac(host), address, "macos"), "macos");
    const result = await command.run(macClockScript(Date.now()), { timeoutMs: 15_000, signal, maxOutputBytes: 4096 }).catch((error: unknown) => ({ exitCode: null, stderr: message(error) }));
    if (result.exitCode !== 0) this.#context.logError("set the clock", new Error(`${host.name}: the VM at ${address} could not set its clock: ${result.stderr.trim() || `exit code ${result.exitCode}`}`));
  }

  /**
   * Checks the VM is `vm`, then names it after its box. A box whose name could
   * not be set still works, so that only logs.
   */
  async #name(host: TartHost, address: string, vm: string, os: GuestOs, name: string, signal?: AbortSignal): Promise<void> {
    await this.#identify(host, address, vm, os, signal);
    await this.#rename(host, address, vm, os, name, signal);
  }

  /** Names a VM already identified (nameScript). */
  async #rename(host: TartHost, address: string, vm: string, os: GuestOs, name: string, signal?: AbortSignal): Promise<void> {
    const { ssh } = await this.#keys();
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

  /** A Windows box as #windowsStreams knows it: its VM, whose name a box that takes a warm VM keeps, and its box (018). */
  #streamKey(guest: Guest): string {
    return `${guest.ref}:${this.#boxOf(guest) ?? ""}`;
  }

  /** Whether a Windows box has bb-box-stream.exe, asked once a box: a box keeps its image's. False, not kept, when it cannot be asked. */
  async #hasWindowsStream(key: string, command: SshTransport): Promise<boolean> {
    const known = this.#windowsStreams.get(key);
    if (known !== undefined) return known;
    const result = await command.run(`if (Test-Path -LiteralPath '${WINDOWS_STREAM_EXE}') { exit 0 } else { exit 3 }`, { timeoutMs: 30_000, maxOutputBytes: 1024 }).catch(() => null);
    if (!result || (result.exitCode !== 0 && result.exitCode !== 3)) return false;
    this.#windowsStreams.set(key, result.exitCode === 0);
    return result.exitCode === 0;
  }

  /**
   * Whether a VM has its video stream, `path`: bb-box-stream on macOS, Selkies' launcher on a Linux desktop. Asked once a VM:
   * a box keeps its image's. False, not kept, when it cannot be asked.
   */
  async #hasStream(vm: string, command: SshTransport, path: string): Promise<boolean> {
    const known = this.#streams.get(vm);
    if (known !== undefined) return known;
    const result = await command.run(`test -x ${quote(path)}`, { timeoutMs: 15_000, maxOutputBytes: 1024 }).catch(() => null);
    if (!result) return false;
    this.#streams.set(vm, result.exitCode === 0);
    return result.exitCode === 0;
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

  /**
   * Closes the shared SSH connections to a VM that is stopping or going, and
   * forgets its address. A Windows VM's are at its SSH `port` on the Mac.
   */
  async #forget(host: TartHost, vm: string, os: GuestOs, port: number | null = null): Promise<void> {
    const address = this.#addresses.get(vm);
    this.#addresses.delete(vm);
    if (os === "windows" ? port === null : !address) return;
    try {
      const { ssh } = await this.#keys();
      const mac = await this.#mac(host);
      await ssh.forget(os === "windows" ? this.#windows(mac, port!) : this.#vm(mac, address!, os));
    } catch (error) {
      this.#context.logError("ssh", error);
    }
  }

  async #delete(host: TartHost, vm: string, os: GuestOs, boxId: string | null, signal?: AbortSignal, port: number | null = null): Promise<void> {
    await this.#forget(host, vm, os, port);
    const script = os === "windows" ? qemuDeleteScript : deleteScript;
    await this.#run(host, script(vm, this.#context.installId, boxId), { timeoutMs: 120_000, signal });
  }

  /** A Mac and a VM from an image reference, <Mac>/<VM>. */
  #imageRef(ref: string): { host: TartHost; vm: string } {
    const at = ref.indexOf("/");
    const host = this.#hostNamed(at > 0 ? ref.slice(0, at) : null);
    if (!host) throw new Error(`${ref} is not an image on a Mac in bb-box's Tart settings.`);
    return { host, vm: ref.slice(at + 1) };
  }

  /** Each Mac's images of its kinds as standard builds, with their records, and this install's captured builds and image boxes. */
  async #imageList(signal?: AbortSignal): Promise<{ builds: ImageBuild[]; boxes: string[] }> {
    const builds: ImageBuild[] = [];
    const boxes: string[] = [];
    const states = await this.#states(signal);
    const windows = this.#config.kinds["windows-arm64-desktop"].image;
    for (const host of this.#config.hosts) {
      const state = states.get(host.name);
      if (!state || state instanceof Error) continue;
      // A Windows image's builds (#450): its current one, and a refresh's builds of this install's, as <Mac>/<image>@<build>.
      if (windows) {
        const listed = parseQemuBuilds((await this.#run(host, qemuBuildsScript(windows), { timeoutMs: 30_000, signal }).catch(() => ({ stdout: "" }))).stdout);
        for (const one of listed) {
          if (one.current) builds.push({ ref: `${host.name}/${windows}`, image: "standard", kind: "windows-arm64-desktop", build: one.record?.build ?? one.build, record: one.record, current: true });
          else if (one.owner.install === this.#context.installId && one.owner["image-build"]) {
            builds.push({ ref: `${host.name}/${windows}@${one.build}`, image: one.owner["image-build"], kind: "windows-arm64-desktop", build: one.record?.build ?? one.build, record: one.record, current: false });
          }
        }
      }
      const exists = (vm: string) => state.vms.some((listed) => listed.name === vm);
      const seen = new Set<string>();
      for (const kind of TART_KINDS) {
        const image = this.#config.kinds[kind].image;
        if (!image || guestOsOf(kind) === "windows" || seen.has(image) || !exists(image)) continue;
        seen.add(image);
        const record = state.records.get(image) ?? null;
        builds.push({ ref: `${host.name}/${image}`, image: "standard", kind, build: record?.build ?? null, record, current: true });
      }
      for (const [vm, fields] of state.owners) {
        if (fields.install !== this.#context.installId) continue;
        if (fields["image-box"]) boxes.push(`${host.name}/${vm}`);
        else if (fields["image-build"] && fields.kind && exists(vm)) {
          const record = state.records.get(vm) ?? null;
          builds.push({ ref: `${host.name}/${vm}`, image: fields["image-build"], kind: fields.kind, build: record?.build ?? null, record, current: false });
        }
      }
    }
    return { builds, boxes };
  }

  /** A clone of a build's VM, started at its kind's default size as a box is, with an owner file that marks it an image box. */
  async #imageBox(build: ImageBuild, label: string, signal: AbortSignal): Promise<ImageBox> {
    const { host, vm: image } = this.#imageRef(build.ref);
    const os = guestOsOf(build.kind);
    const vm = `${VM_PREFIX}image-${randomBytes(6).toString("hex")}`;
    if (os === "windows") return this.#windowsImageBox(host, image, vm, build, label, signal);
    const { cores, memoryMiB } = this.#context.kind(build.kind).defaultSize;
    const deadline = Date.now() + (this.#options.readyTimeoutMs ?? this.#kind(build.kind).readyTimeoutMs);
    const owner = ownerText({ install: this.#context.installId, kind: build.kind, "image-box": label.replace(/[^\w .:-]/g, "").slice(0, 80) || "box", created: Date.now() });
    try {
      if ((await this.#run(host, claimScript(vm, owner), { signal })).stdout.trim() !== "claimed") throw new Error(`VM ${vm} on ${host.name} is taken.`);
      await this.#run(host, cloneScript(image, vm, cores, memoryMiB), { timeoutMs: 10 * 60_000, signal });
      await this.#start(host, vm, os, deadline, signal);
      const address = await this.#address(host, vm, deadline, signal);
      const access = this.#vm(await this.#mac(host), address, os);
      await this.#waitReady(host, vm, access, os, deadline, signal);
      return { ref: `${host.name}/${vm}`, command: new SshTransport((await this.#keys()).ssh, access, os) };
    } catch (error) {
      await this.#delete(host, vm, os, null).catch((cause) => this.#context.logError("remove an image box", cause));
      throw error;
    }
  }

  /**
   * A Windows image box (#450): a QEMU VM that is an overlay on the build,
   * the current one or a refresh's, at the kind's default size, started and
   * reached over SSH as a box is, with an owner file that marks it.
   */
  async #windowsImageBox(host: TartHost, ref: string, vm: string, build: ImageBuild, label: string, signal: AbortSignal): Promise<ImageBox> {
    const [image = "", dir = "current"] = ref.split("@");
    const { cores, memoryMiB } = this.#context.kind(build.kind).defaultSize;
    const deadline = Date.now() + (this.#options.readyTimeoutMs ?? WINDOWS_READY_TIMEOUT_MS);
    const owner = ownerText({ install: this.#context.installId, kind: build.kind, "image-box": label.replace(/[^\w .:-]/g, "").slice(0, 80) || "box", created: Date.now() });
    try {
      if ((await this.#run(host, claimScript(vm, owner), { signal })).stdout.trim() !== "claimed") throw new Error(`VM ${vm} on ${host.name} is taken.`);
      const made = parseQemuVm((await this.#run(host, qemuCloneScript(image, vm, cores, memoryMiB, null, dir), { timeoutMs: 120_000, signal })).stdout);
      if (!made) throw new Error(`QEMU's VM ${vm} on ${host.name} has no whole config.`);
      this.#imagePorts.set(vm, made.ssh);
      await this.#start(host, vm, "windows", deadline, signal);
      const access = this.#windows(await this.#mac(host), made.ssh);
      await this.#waitReady(host, vm, access, "windows", deadline, signal);
      return { ref: `${host.name}/${vm}`, command: new SshTransport((await this.#keys()).ssh, access, "windows") };
    } catch (error) {
      await this.#delete(host, vm, "windows", null).catch((cause) => this.#context.logError("remove an image box", cause));
      throw error;
    }
  }

  /** Stops an image box and keeps it as bb-box-img-<image>-<build>, with its record beside it and an owner file that names its image. */
  async #capture(box: ImageBox, from: ImageBuild, image: string, signal: AbortSignal): Promise<ImageBuild> {
    const { host, vm } = this.#imageRef(box.ref);
    const os = guestOsOf(from.kind);
    if (os === "windows") return this.#captureWindows(box, from, image, signal);
    const read = await box.command.run(`cat ${RECORD_PATH[os] ?? RECORD_PATH.linux}`, { timeoutMs: 15_000, signal, maxOutputBytes: 64 * 1024 });
    const record = read.exitCode === 0 ? recordFromJson(read.stdout.trim()) : null;
    if (!record) throw new Error(`Image box ${vm} on ${host.name} has no image record in ${RECORD_PATH[os]}, which finalizing writes.`);
    await box.command.run("sync", { timeoutMs: 60_000, signal }).catch(() => undefined);
    await this.#forget(host, vm, os);
    const to = `${VM_PREFIX}img-${image.replace(/[^a-z0-9-]/gi, "-")}-${record.build.replace(/^build\./, "")}`;
    const owner = ownerText({ install: this.#context.installId, kind: from.kind, "image-build": image, created: Date.now() });
    await this.#run(host, captureScript(vm, to, JSON.stringify(record), owner), { timeoutMs: 15 * 60_000, signal });
    return { ref: `${host.name}/${to}`, image, kind: from.kind, build: record.build, record, current: false };
  }

  /**
   * Captures a Windows image box as a build of its image (#450): its record,
   * read in the guest, names the build; the guest powers down, and its disk
   * and its base become the build's own read-only disk beside the image's
   * other builds, marked a refresh's build of this install's until replace
   * makes it current. Only a standard image is a Windows one.
   */
  async #captureWindows(box: ImageBox, from: ImageBuild, image: string, signal: AbortSignal): Promise<ImageBuild> {
    const { host, vm } = this.#imageRef(box.ref);
    const target = this.#imageRef(from.ref).vm.split("@")[0]!;
    if (image !== "standard") throw new Error("A Windows image has no project's images: their scripts are Linux's.");
    const read = await box.command.run("Get-Content -Raw -LiteralPath 'C:\\bb-box\\image.json'", { timeoutMs: 30_000, signal, maxOutputBytes: 64 * 1024 });
    const record = read.exitCode === 0 ? recordFromJson(read.stdout.trim()) : null;
    if (!record) throw new Error(`Image box ${vm} on ${host.name} has no image record in C:\\bb-box\\image.json.`);
    const build = record.build.startsWith("build.") ? record.build : `build.${record.build}`;
    await this.#forget(host, vm, "windows", this.#imagePorts.get(vm) ?? null);
    this.#imagePorts.delete(vm);
    const owner = ownerText({ install: this.#context.installId, kind: from.kind, "image-build": image, created: Date.now() });
    await this.#run(host, qemuCaptureScript(vm, target, build, JSON.stringify(record), owner, 180), { timeoutMs: 60 * 60_000, signal });
    await this.#run(host, forgetImageScript(vm), { timeoutMs: 30_000, signal }).catch(() => undefined);
    return { ref: `${host.name}/${target}@${build}`, image, kind: from.kind, build: record.build, record, current: false };
  }

  /** Gives a build the image's name: the image goes, and boxes cloned from it keep running, as copies on write. */
  async #replaceImage(build: ImageBuild, current: ImageBuild, signal: AbortSignal): Promise<ImageBuild> {
    const target = this.#imageRef(current.ref);
    const source = this.#imageRef(build.ref);
    // A Windows image's build becomes current in its own directory (#450); the image's boxes keep the builds they are overlays on.
    if (guestOsOf(current.kind) === "windows") {
      const [image, dir] = source.vm.split("@");
      if (!current.current || build.current || target.host !== source.host || image !== target.vm || !dir) throw new Error(`${build.ref} is not a refresh's build of ${current.ref}.`);
      await this.#run(target.host, qemuReplaceScript(image, dir), { timeoutMs: 10 * 60_000, signal });
      return { ...build, ref: current.ref, image: "standard", current: true };
    }
    if (!current.current || build.current || target.host !== source.host) throw new Error(`${current.ref} is not a configured image, or ${build.ref} is not a build on its Mac.`);
    await this.#run(target.host, replaceScript(source.vm, target.vm), { timeoutMs: 10 * 60_000, signal });
    // The base's copies no tag names, as a pull before the build left them (#475).
    const from = await this.#baseOf(target.host, target.vm, signal).catch(() => "");
    if (from) await this.#run(target.host, pruneBaseScript(from), { timeoutMs: 10 * 60_000, signal }).catch((error: unknown) => this.#context.logError("remove an old base", error));
    return { ...build, ref: current.ref, image: "standard", current: true };
  }

  /** The base an image was prepared from, as its prepare script noted it beside it, or "". */
  async #baseOf(host: TartHost, image: string, signal?: AbortSignal): Promise<string> {
    return (await this.#run(host, `exec /bin/sh -c ${quote(`sed -n 's/^from=//p' "$HOME/.bb-box/tart/images/${image}" 2>/dev/null | head -n 1`)}`, { signal })).stdout.trim();
  }

  /** Removes an image box, a captured build or a refresh's build of this install's, and nothing else. */
  async #removeImage(ref: string, signal?: AbortSignal): Promise<void> {
    const { host, vm } = this.#imageRef(ref);
    // A refresh's build of a Windows image (#450), which goes once no VM is an overlay on it.
    if (vm.includes("@")) {
      const [image = "", dir = ""] = vm.split("@");
      await this.#run(host, qemuRemoveBuildScript(image, dir, this.#context.installId), { timeoutMs: 10 * 60_000, signal });
      return;
    }
    const state = await this.#state(host, signal);
    const fields = state.owners.get(vm);
    const configured = TART_KINDS.some((kind) => this.#config.kinds[kind].image === vm);
    if (configured || !fields || fields.install !== this.#context.installId || !(fields["image-box"] || fields["image-build"])) {
      throw new Error(`${vm} on ${host.name} is not an image box or build of this install's, so bb-box leaves it.`);
    }
    await this.#delete(host, vm, guestOsOf(fields.kind ?? ""), null, signal);
    await this.#run(host, forgetImageScript(vm), { timeoutMs: 30_000, signal });
  }

  /**
   * A new build of a configured image by its prepare script, run on its Mac
   * as the user bb-box logs in as, from a copy of `setup` there, under a name
   * of its own until it replaces the image. The image's user accepts
   * bb-box's key, and a macOS image starts from the base the image did.
   */
  async #buildStandard(current: ImageBuild, setup: string, options: { bbUrl: string | null; log: (line: string) => void; signal: AbortSignal }): Promise<ImageBuild> {
    const { host, vm: image } = this.#imageRef(current.ref);
    const os = guestOsOf(current.kind);
    // A Windows image is refreshed in a box of its current build (054): no prepare script runs for it.
    if (os === "windows") throw new Error("A Windows image is refreshed in a box of its build, not by its prepare script.");
    const { ssh, publicKey: key } = await this.#keys();
    if (!key) throw new Error("bb-box has no SSH public key for the image's user to accept.");
    const stamp = Date.now().toString(36);
    const vm = `${VM_PREFIX}img-refresh-${stamp}`;
    const dir = `.bb-box/tart/setup-${stamp}`;
    // bb-box-stream's source is the pool Mac's (060).
    const tar = spawnSync("tar", ["-C", setup, "-czf", "-", "tart", "proxmox-lxc", "ssh-pool/mac-stream.swift", "ssh-pool/mac-chrome.sh"], { maxBuffer: 64 * 1024 * 1024 });
    if (tar.status !== 0) throw new Error(`tar could not pack the setup files: ${tar.stderr.toString().trim()}`);
    const mac = new SshTransport(ssh, await this.#mac(host), "macos");
    const owner = ownerText({ install: this.#context.installId, kind: current.kind, "image-build": "standard", created: Date.now() });
    // The detached prepare script's pid while it runs.
    let pid: number | null = null;
    await this.#run(host, claimScript(vm, owner), { signal: options.signal });
    try {
      await mac.writeFile(`${dir}.tgz`, tar.stdout, { signal: options.signal });
      const from = await this.#baseOf(host, image, options.signal);
      // A newer push to the base's tag is pulled first, room allowing (#475).
      if (from) {
        const pulled = await this.#run(host, baseScript(from, this.#config.reserve.diskGiB), { timeoutMs: 3 * 60 * 60_000, signal: options.signal });
        for (const line of pulled.stdout.split("\n")) if (line.trim()) options.log(line);
      }
      const args = [
        os === "macos" ? "./prepare-image.sh" : "./prepare-linux-image.sh",
        ...(current.kind === "linux-arm64-desktop-cpu" ? ["--desktop"] : []),
        "--key", key,
        ...(from ? ["--from", from] : []),
        "--name", vm,
        ...(options.bbUrl ? ["--bb-url", options.bbUrl] : []),
      ];
      const prepare = `cd "$HOME/${dir}" 2>/dev/null || { mkdir -p "$HOME/${dir}" && tar -xzf "$HOME/${dir}.tgz" -C "$HOME/${dir}"; }; cd "$HOME/${dir}/tart"`;
      const started = await this.#run(host, detachedBuildScript(dir, prepare, args), { signal: options.signal });
      pid = Number(/^pid=(\d+)$/m.exec(started.stdout)?.[1]) || null;
      const status = await this.#follow(host, dir, BUILD_TIMEOUT_MS, options.log, options.signal);
      pid = null;
      if (status !== 0) throw new Error(`The prepare script on ${host.name} exited with ${status}.`);
      const state = await this.#state(host, options.signal);
      if (!state.vms.some((listed) => listed.name === vm)) throw new Error(`The prepare script on ${host.name} made no VM ${vm}.`);
      const record = state.records.get(vm) ?? null;
      return { ref: `${host.name}/${vm}`, image: "standard", kind: current.kind, build: record?.build ?? null, record, current: false };
    } catch (error) {
      // A build that still runs, as after a cancel or when it ran out of time, stops first.
      if (pid) await this.#run(host, stopBuildScript(pid)).catch(() => undefined);
      // What the prepare script left, its build VM too, goes.
      await this.#run(host, `exec /bin/sh -c ${quote(`PATH=/opt/homebrew/bin:/usr/local/bin:$HOME/.nix-profile/bin:$PATH; tart delete ${quote(`${vm}-build`)} 2>/dev/null; :`)}`).catch(() => undefined);
      await this.#delete(host, vm, os, null).catch(() => undefined);
      await this.#run(host, forgetImageScript(vm)).catch(() => undefined);
      throw error;
    } finally {
      await this.#run(host, `exec /bin/sh -c ${quote(`rm -rf "$HOME/${dir}" "$HOME/${dir}.tgz"`)}`).catch(() => undefined);
    }
  }

  /**
   * Follows a build detachedBuildScript started in `dir` on the Mac until
   * it ends, passing its output on line by line, and returns its exit
   * status. Each look is a short command, so a link that drops or stalls
   * costs only the looks it misses (#707); the Mac may be out of reach for
   * BUILD_LOST_MS before the build counts as lost. Throws when the build
   * runs past `timeoutMs`.
   */
  async #follow(host: TartHost, dir: string, timeoutMs: number, log: (line: string) => void, signal: AbortSignal): Promise<number> {
    const sleep = this.#options.sleep ?? pause;
    const deadline = Date.now() + timeoutMs;
    const decoder = new TextDecoder();
    let rest = "";
    let offset = 0;
    let heard = Date.now();
    const lines = (text: string) => {
      const all = (rest + text).split(/\r?\n|\r/);
      rest = all.pop() ?? "";
      for (const line of all) if (line.trim()) log(line);
    };
    for (;;) {
      signal.throwIfAborted();
      let more = false;
      try {
        const seen = parseFollow((await this.#run(host, followBuildScript(dir, offset, BUILD_LOG_CHUNK), { timeoutMs: 30_000, signal })).stdout);
        heard = Date.now();
        offset += seen.bytes.length;
        lines(decoder.decode(seen.bytes, { stream: true }));
        if (seen.status !== null && offset >= seen.size) {
          lines(decoder.decode());
          if (rest.trim()) log(rest);
          return seen.status;
        }
        more = seen.bytes.length >= BUILD_LOG_CHUNK;
      } catch (error) {
        signal.throwIfAborted();
        if (Date.now() - heard > BUILD_LOST_MS) {
          throw new Error(`bb-box could not reach ${host.name} for ${Math.round(BUILD_LOST_MS / 60_000)} minutes while the prepare script ran there: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (Date.now() > deadline) throw new Error(`The prepare script on ${host.name} ran out of time.`);
      if (!more) await sleep(BUILD_POLL_MS, signal);
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

