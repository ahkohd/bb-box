import { ANDROID_NO_FORK, ANDROID_SNAPSHOTS, androidSnapshotPlan } from "./android-snapshots.ts";
// The Proxmox QEMU backend: Windows desktops as VMs. A box is a linked clone
// of a Windows template that setup/proxmox-qemu/build.sh makes, in bb-box's
// pool, with a VMID from its range and the static address fixed to it. The
// template is not generalized, so a clone boots as the same installed
// Windows. Its address reaches Windows in the SMBIOS serial, base64 encoded,
// which the template's boot.ps1 reads at each boot. Ownership lives in Proxmox
// tags and the description, as for Proxmox LXC (018). Commands run over SSH
// in PowerShell 7, as the template's box user, an administrator.
//
// An acquire clones, configures (the box's cores and memory, the serial with a
// fresh SMBIOS UUID, the bridge, and no protection, which clones inherit),
// tags, grows the boot disk if the box's size asks for more than the
// template's, starts, waits for port 22 and then for SSH, and then extends C:
// over the space the disk grew by. A stopped VM's disk grows at once, so it
// grows before the start.
//
// The desktop is the VM's console, through the API's VNC proxy. Core runs
// desktop commands as scheduled tasks in the box user's session, and computer
// use through Cua's daemon, which runs there elevated, as SSH does. The
// viewer's size sets the desktop's mode, through a desktop command. A stop
// hibernates the VM, and a start resumes it and sets Windows' clock, which
// the resume leaves behind.
//
// The warm pool keeps hibernated clones at the kind's default size, each
// filled once Windows' desktop is up. Proxmox refuses a hibernated VM's
// config changes, tags too, so bb-box marks a warm VM it claims or deletes
// in memory until the VM resumes or goes. A claim resumes the VM, gives it
// the box's tags, name and description, waits for SSH and sets the clock.

import { SPARES } from "../../core/boxes.ts";
import type { CheckId } from "../../core/checks.ts";
import { withDesktopForkSafety } from "../../core/identity.ts";
import { randomUUID } from "node:crypto";
import { Proxmox, ProxmoxError, parseTags, rootDiskGiB, type FetchLike, type GuestSettings, type PoolGuest, type StorageStatus } from "../proxmox/api.ts";
import { poolPrivileges, snapshotsCheck, type GuestDiskStorage } from "../proxmox/snapshots.ts";
import { ProxmoxSnapshotting, cloneWaitMs, storageOfVolume, storagesMetadata, type KeptGuest } from "../proxmox/snapshotting.ts";
import { armFork, disarm, disarmFork, forkByFullClone } from "../proxmox/forks.ts";
import { WINDOWS_DESKTOP_NO_FORK, WINDOWS_DESKTOP_SNAPSHOTS, windowsDesktopSnapshotPlan } from "./windows-snapshots.ts";
import { EARLIER_GUEST, copyName, copyTags, heldCopyDescription, heldCopyTags, isEarlierGuest, isHeldCopy, macOf, netKeys, netWith, randomMac, untilTemplate, withKeptTag } from "../proxmox/copies.ts";
import { LOW, START_TAG, settle, startsLow, withStartTag } from "../proxmox/start-weight.ts";
import {
  BUILD,
  TAG,
  boxTags,
  buildFromTags,
  describe,
  fromBuild,
  installFromDescription,
  installFromTags,
  installTag,
  isTemplate,
  namesOf,
  ownerFromDescription,
  ownerFromTags,
  templateBuild,
  templateFromTags,
  templateTag,
} from "../proxmox/owner.ts";
import { addressFor, proxmoxFootprint } from "../proxmox/settings.ts";
import { proxmoxFetch, proxmoxHttp, type ProxmoxHttp } from "../proxmox/tls.ts";
import { ReadyPool } from "../pool.ts";
import { Upkeep } from "../warm.ts";
import type { DeviceOffer } from "../../core/device.ts";
import {
  BackendError,
  DEVICE_DISPLAY,
  type AcquireHooks,
  type Backend,
  type BackendContext,
  type BackendImages,
  type Footprint,
  type BoxIdentity,
  type BoxKind,
  type MachineSize,
  type BoxTransports,
  type Capacity,
  type ResizePlan,
  type Resizing,
  type ComputerUse,
  type DoctorCheck,
  type DoctorReport,
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
  SnapshotFailed,
  type CopyHooks,
  type CopyPlan,
  type CopyState,
  type GuestIdentity,
  type HeldCopyLabel,
  type TaskOutcome,
  type TaskRef,
  type WarmShortfall,
  type WithheldKind,
  type IdentitySource,
  type ForkArming,
} from "../types.ts";
import { sizesCheck } from "../fit.ts";
import { WINDOWS_HARDWARE_CURSOR, judgeImage, recordFromJson, recordInDescription } from "../images.ts";
import { displayReason, vmNameScript } from "../proxmox-lxc/backend.ts";
import { SELKIES_DISPLAY, selkiesDisplay } from "../selkies.ts";
import { pause, waitForPort, waitUntilAnswers, type PortCheck } from "../../transports/ready.ts";
import { KeyFile, Ssh, SshTransport, publicKey } from "../../transports/ssh.ts";
import { MIN_DESKTOP, type Display, type DisplaySize, type GuestOs, type SshAccess } from "../../transports/types.ts";
import { CUA_PIPE, WINDOWS_STREAM, WINDOWS_VIDEO, compileDisplay, desktopUp, extendC, setClock, setMode, QEMU_KEY_DELAY_MS, windowsCharacterInput, windowsPointer, windowsTypesAsCharacter } from "../windows.ts";
import type { OpenStream } from "../../core/selkies.ts";
import { openRoute } from "../../transports/route.ts";
import type { QemuConfig } from "./config.ts";
import { storedKeyPair } from "../ssh-key.ts";
import { PRODUCT } from "../../brand.ts";

const MiB = 2 ** 20;
const GiB = 2 ** 30;
const SSH_KEY = "ssh-key";
/** Where the next VMID search starts. */
const NEXT_VMID = "next-vmid";
/** The tag and name of a VM bb-box refreshes or tries an image in (054), which no sweep releases. */
const IMAGE_BOX = "image-box";
const IMAGE_HOSTNAME = "bb-box-image";
/** The tag that names a captured build's image, such as image.standard. */
const IMAGE_TAG = "image.";
/** The tag that names a captured build's kind. */
const KIND_TAG = "kind.";
/** The image a replaced template is kept as, until the next replace of its template (054). */
const ROLLBACK = "rollback";
/** A linked clone of Windows boots and starts sshd in about 20 s; this leaves room for a busy host. */
const READY_TIMEOUT_MS = 180_000;
/** build.sh --replace swaps the template for its new build, which leaves it missing for a moment. A clone waits this long for it. */
const TEMPLATE_WAIT_MS = 10_000;
const TEMPLATE_POLL_MS = 250;
/** Cua Driver as build.sh pins it (039). A task at logon starts its daemon, elevated, on this named pipe. */
const CUA_DRIVER: ComputerUse = { driver: "cua", version: "0.30.4", socket: CUA_PIPE };
/** Where boot.ps1 logs how it set the box's address. */
const BOOT_LOG = "C:\\bb-box\\boot.log";
/** Tags of a warm VM: filling while bb-box makes it, warm once it is ready. */
const WARM = "warm";
const FILLING = "filling";
/** A warm VM's name until a box claims it. */
const WARM_NAME = "bb-box-warm";
/** How often a fill checks whether Windows' desktop is up. */
const DESKTOP_POLL_MS = 1_000;

/** How long a template's answer to whether it has bb-box-stream is kept. */
const STREAM_CHECK_MS = 60_000;

const KIND: BoxKind = {
  id: "windows-desktop",
  label: "Windows desktop",
  description:
    "A Windows 11 VM for Windows apps, browsers and builds, with its desktop shown in the panel and computer use. Commands run in PowerShell 7 as an administrator. What a command starts with Start-Process ends with it; Start-Detached { <cmd> } <log> keeps it running, with a GUI program's output in the log too. A desktop command runs unelevated, and what it opens stays open.",
  requires: [],
  capabilities: {
    os: "windows",
    arch: "x86_64",
    gpu: false,
    features: [],
    command: { transport: "ssh", shell: "powershell", admin: true, inDesktopSession: false, streaming: true },
    // QEMU's VNC server moves the clipboard only through the SPICE guest agent, which the template lacks, so bb-box
    // moves it with Get-Clipboard and Set-Clipboard in the desktop session (#461). A box whose image lacks
    // bb-box-stream has no video display among its transports, and the viewer falls back to VNC.
    // The cursor as the hardware cursor makes it possible; a box's own video display says it only where its image has it.
    displays: [{ id: "desktop", protocol: "rfb", resizable: true, clipboard: "commands" }, { ...WINDOWS_VIDEO, cursor: "stream" }],
    computerUse: CUA_DRIVER,
    enrol: false,
    device: null,
  },
  readyTimeoutMs: READY_TIMEOUT_MS,
};

/**
 * Linux boxes as VMs (057): a linked clone of an Ubuntu template, with its
 * own kernel, which can load modules and run systemd as on a machine. The
 * template sets its address from the SMBIOS fields bb-box gives each clone,
 * as Windows' boot.ps1 does, and takes bb-box's key for the box user, who
 * may use sudo. It joins BB as other Linux boxes do.
 */
const LINUX_KIND: BoxKind = {
  id: "linux",
  label: "Linux",
  description:
    "A Linux VM with its own kernel, for kernel modules, systemd as on a machine, and work a container cannot do. It starts slower and holds its memory while it runs, so ask for it as linux-vm, or as linux-kvm for KVM inside where the host allows it; a linux box elsewhere starts sooner.",
  requires: [],
  capabilities: {
    os: "linux",
    arch: "x86_64",
    gpu: false,
    features: ["docker", "kernel"],
    command: { transport: "ssh", shell: "sh", admin: true, inDesktopSession: false, streaming: true },
    displays: [],
    computerUse: null,
    enrol: true,
    device: null,
  },
  readyTimeoutMs: READY_TIMEOUT_MS,
};

/**
 * Linux desktops as VMs (057): a linked clone of a Linux desktop template,
 * the Linux one with the CPU desktop of Proxmox LXC's, drawn by the CPU. Its
 * desktop is the guest's own VNC server and Selkies, as in an LXC box, not
 * the VM's console.
 */
/** Cua Driver in a Linux desktop, as in Proxmox LXC's. */
const LINUX_CUA_DRIVER: ComputerUse = { driver: "cua", version: "0.28.3", socket: "/home/box/.cache/cua-driver/cua-driver.sock" };
const LINUX_DESKTOP_KIND: BoxKind = {
  id: "linux-desktop-cpu",
  label: "Linux desktop",
  description:
    "A Linux desktop VM drawn by the CPU, with its own kernel, for computer use and browsers where the box needs kernel modules or systemd as on a machine. It starts slower and holds its memory while it runs, so ask for it by its provider; a linux-desktop-cpu box elsewhere starts sooner.",
  requires: [],
  capabilities: {
    ...LINUX_KIND.capabilities,
    displays: [{ id: "desktop", protocol: "rfb", resizable: true }, SELKIES_DISPLAY],
    computerUse: LINUX_CUA_DRIVER,
  },
  readyTimeoutMs: READY_TIMEOUT_MS,
};
/** The Linux kinds, each with its templates' setting. */
const LINUX_KINDS: readonly BoxKind[] = [LINUX_KIND, LINUX_DESKTOP_KIND];

const ANDROID_IMAGE_KIND: BoxKind = {
  id: "android",
  label: "Android emulator",
  description: "The Android template's image boxes, which the refresh builds and checks in.",
  requires: [],
  capabilities: LINUX_KIND.capabilities,
  readyTimeoutMs: READY_TIMEOUT_MS,
};
function isLinuxVmKind(kind: string): boolean {
  return LINUX_KINDS.some((linux) => linux.id === kind);
}

const LINUX_TEMPLATE_KINDS: readonly BoxKind[] = [...LINUX_KINDS, ANDROID_IMAGE_KIND];

function androidKind(device: DeviceOffer): BoxKind {
  return {
    id: ANDROID_IMAGE_KIND.id,
    label: "Android emulator",
    description:
      "An Android emulator device, a phone, foldable or tablet, booted in a Linux VM, for installing, running and testing Android apps, with its screen shown in the panel. Commands run on the Linux host, as the box user with sudo, with the Android SDK in /opt/android-sdk; adb takes the device as emulator-5554.",
    requires: [],
    capabilities: { ...LINUX_KIND.capabilities, features: [...LINUX_KIND.capabilities.features, "kvm"], displays: [DEVICE_DISPLAY], device },
    readyTimeoutMs: READY_TIMEOUT_MS,
  };
}

const ANDROID_DEVICES_KEPT_MS = 60_000;

/** The guest's VNC server, as in Proxmox LXC's desktops, and the password its desktop writes at boot. */
const LINUX_VNC_PORT = 5900;
const LINUX_VNC_PASSWORD_FILE = "/var/lib/bb-box/vnc-password";
/** What the desktop's display service writes once it is up: cpu here. */
const LINUX_DISPLAY_MODE_FILE = "/run/bb-box/display-mode";
const LINUX_DISPLAY_REASON_FILE = "/run/bb-box/display-reason";

/** A doctor check's stable ID and its name. */
type Check = readonly [id: CheckId, name: string];
const API: Check = ["proxmox.api", "Proxmox API"];
const NODE: Check = ["proxmox.node", "Node"];
const MEMORY: Check = ["proxmox.memory", "Node memory"];
const POOL: Check = ["proxmox.pool", "Resource pool"];
const BRIDGE: Check = ["proxmox.bridge", "Network bridge"];
const VMIDS: Check = ["proxmox.vmids", "VMID range"];
const SSH_KEY_CHECK: Check = ["ssh.key", "SSH key"];
const ANDROID_KVM: Check = ["proxmox.android-kvm", "KVM for Android"];
const ANDROID_DISK: Check = ["proxmox.android-disk", "Disk for Android"];
const SNAPSHOTS: Check = ["proxmox.snapshots", "Snapshots"];
const ANDROID_ROOM_GIB = 40;

function powerOf(status: string): PowerState {
  if (status === "running") return "running";
  if (status === "stopped") return "stopped";
  return "unknown";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatMiB(value: number): string {
  if (Math.abs(value) < 1024) return `${Math.round(value)} MiB`;
  return `${(value / 1024).toFixed(1).replace(/\.0$/, "")} GiB`;
}

/** Whether the config's `name` is a disk, not a CD drive. */
function isDisk(config: Record<string, unknown>, name: string): boolean {
  const value = config[name];
  return /^(?:scsi|virtio|sata|ide)\d+$/.test(name) && typeof value === "string" && !/(?:^|,)media=cdrom(?:,|$)/.test(value);
}

/** The disk a VM boots from, such as scsi0: the first disk in its boot order, else its first disk. Null when it has none. */
export function bootDisk(config: Record<string, unknown>): string | null {
  const order = /(?:^|,)order=([^,]+)/.exec(String(config.boot ?? ""))?.[1]?.split(";") ?? [];
  return order.find((name) => isDisk(config, name)) ?? ["scsi0", "virtio0", "sata0", "ide0"].find((name) => isDisk(config, name)) ?? null;
}

/**
 * SMBIOS settings that give Windows its address: the serial is the address
 * with its prefix, a space and the gateway, base64 encoded, as boot.ps1
 * reads it. smbios1 is set whole, so it carries a fresh UUID too.
 */
export function smbios1For(address: string, prefix: number, gateway: string, uuid: string = randomUUID()): string {
  return `base64=1,uuid=${uuid},serial=${Buffer.from(`${address}/${prefix} ${gateway}`).toString("base64")}`;
}

export function withUuid(smbios1: unknown, uuid: string): string {
  const current = typeof smbios1 === "string" ? smbios1 : "";
  if (!current) return `uuid=${uuid}`;
  return /(?:^|,)uuid=/.test(current) ? current.replace(/((?:^|,)uuid=)[^,]*/, `$1${uuid}`) : `${current},uuid=${uuid}`;
}

/** A clone's net0, which keeps the MAC Proxmox gave it, on `bridge`. */
export function net0On(net0: unknown, bridge: string): string {
  const current = typeof net0 === "string" ? net0 : "";
  if (!current) return `virtio,bridge=${bridge}`;
  return /(?:^|,)bridge=/.test(current) ? current.replace(/((?:^|,)bridge=)[^,]*/, `$1${bridge}`) : `${current},bridge=${bridge}`;
}

/** The size a VM's config gives it, or null when it does not say. */
function sizeOf(config: Record<string, unknown>): MachineSize | null {
  const cores = Number(config.cores);
  const memoryMiB = Number(config.memory);
  if (!(Number.isInteger(cores) && cores > 0 && Number.isInteger(memoryMiB) && memoryMiB > 0)) return null;
  const disk = bootDisk(config);
  return { cores, memoryMiB, diskGiB: disk ? rootDiskGiB(config, disk) : null };
}

/** How long a resize's clean shutdown waits for the guest before Proxmox stops it (061). */
const SHUTDOWN_WAIT_S = 120;

export const GROW_ROOT = String.raw`dev=$(findmnt -no SOURCE /)
disk=/dev/$(lsblk -no PKNAME "$dev")
part=$(cat "/sys/class/block/$(basename "$dev")/partition")
sudo growpart "$disk" "$part" >/dev/null
grown=$?
[ "$grown" -le 1 ] || { echo "growpart $disk $part failed with exit code $grown." >&2; exit 1; }
sudo resize2fs "$dev" >/dev/null`;

export const ROOT_FACT = "Root file system";

function rootNotGrown(error: unknown): GuestFact {
  const why = error instanceof Error ? error.message : String(error);
  return { label: ROOT_FACT, value: `Not grown over its disk: ${why.replace(/\.?$/, ".")} Run growpart and resize2fs in the box, or resize its disk again.` };
}

function withRootFact(guest: Guest, unfilled: GuestFact | null): Guest {
  const saidBefore = guest.facts?.some((fact) => fact.label === ROOT_FACT) ?? false;
  if (!saidBefore && !unfilled) return guest;
  return { ...guest, facts: [...(guest.facts ?? []).filter((fact) => fact.label !== ROOT_FACT), ...(unfilled ? [unfilled] : [])] };
}

function gone(vmid: number): BackendError {
  return new BackendError("gone", `The box's VM ${vmid} no longer exists.`);
}

/**
 * Whether a warm VM of `size` serves a box of `wanted`: Proxmox cannot
 * change a hibernated VM, so the cores and memory must be the same, and the
 * disk at least the size asked for.
 */
function serves(size: MachineSize, wanted: MachineSize): boolean {
  if (size.cores !== wanted.cores || size.memoryMiB !== wanted.memoryMiB) return false;
  return wanted.diskGiB === null || (size.diskGiB !== null && size.diskGiB >= wanted.diskGiB);
}

export interface QemuBackendOptions {
  /** Replaces the Proxmox API's fetch; the TLS settings are then ignored. */
  readonly fetch?: FetchLike;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly sshBinary?: string;
  /** Replaces the TCP check for port 22, for tests. */
  readonly portCheck?: PortCheck;
  /** Replaces the kind's readyTimeoutMs, for tests. */
  readonly readyTimeoutMs?: number;
  /** Replaces how long a clone waits for a template that is being replaced, for tests. */
  readonly templateWaitMs?: number;
}

/** Times one step of an acquire. */
type Step = <T>(name: string, run: () => Promise<T>) => Promise<T>;
const untimed: Step = (_name, run) => run();

/** Runs steps, giving `timing` the time each took, whether it succeeded or not. */
function timed(timing: (step: string, ms: number) => void): Step {
  return async (name, run) => {
    const started = performance.now();
    try {
      return await run();
    } finally {
      timing(name, Math.round(performance.now() - started));
    }
  };
}

interface SshKeys {
  readonly ssh: Ssh;
  readonly publicKey: string | null;
  readonly generated: boolean;
}

interface TemplateInfo {
  readonly storage: string;
  readonly bootDisk: string;
  readonly diskGiB: number | null;
}

/** A box the registry is acquiring here, which capacity counts as coming. */
type Pending = { readonly kind: string; readonly size: MachineSize };

/** A warm VM that a claim can take, with the template, build and size it was filled with. */
interface WarmVm {
  readonly guest: PoolGuest;
  readonly template: number;
  readonly build: string | null;
  readonly size: MachineSize;
}

export class ProxmoxQemuBackend implements Backend {
  readonly id: string;
  readonly nature = "virtual" as const;
  readonly label: string;
  readonly hosts: readonly string[];
  readonly hostOs = "linux" as const;
  readonly #config: QemuConfig;
  readonly #context: BackendContext;
  readonly #options: QemuBackendOptions;
  readonly #http: ProxmoxHttp;
  readonly #keyFile = new KeyFile();
  /** VMIDs this process is cloning into. */
  readonly #reserved = new Set<number>();
  /** The template of each acquire running in this process that has chosen one, by box. */
  readonly #acquiring = new Map<string, number>();
  /** Storage, boot disk and its size of each template. */
  readonly #templates = new Map<number, TemplateInfo>();
  #api: Promise<Proxmox> | null = null;
  #ssh: Promise<SshKeys> | null = null;
  /** Where the next VMID search starts, so a deleted box's VMID and address are not reused at once. */
  #nextVmid: number | null = null;
  /** Display helpers compiling for new boxes, by VMID, which a resize waits for. */
  readonly #compiling = new Map<number, Promise<void>>();
  /** The template of each warm VM this process is filling, by VMID. */
  readonly #filling = new Map<number, number>();
  /** Warm VMs that acquires here have claimed, which keep their warm tags until they resume. */
  readonly #claimed = new Set<number>();
  /** Warm VMs this process is deleting, for the same reason. */
  readonly #retiring = new Set<number>();
  /** The ready warm VMs as the pool last listed them, by VMID. */
  readonly #listed = new Map<string, WarmVm>();
  readonly #warm = new ReadyPool<BoxIdentity>({
    members: (signal) => this.#members(signal),
    hold: async (member) => void this.#claimed.add(Number(member.ref)),
  });
  readonly #stopping = new AbortController();
  readonly #upkeep = new Upkeep((signal) => this.#topUp(signal));
  /** Whether each Windows template's image has bb-box-stream (060) and the hardware cursor, and when that was read. */
  readonly #streaming = new Map<number, { has: boolean; cursor: boolean; at: number }>();
  /** Image boxes (054) from before their clone until their capture or removal, which no sweep counts. */
  readonly #imageBoxes = new Set<number>();
  #androidDevices: { readonly offer: DeviceOffer | null; readonly at: number; readonly why: string | null } | null = null;
  #androidReading: Promise<void> | null = null;
  readonly #snapshots: ProxmoxSnapshotting;

  /**
   * Image operations (054): a box from a template, its capture as a template
   * with the image's record in its description, and a template replaced in
   * place under its VMID, as build.sh --replace does. refreshImage runs the
   * Windows refresh script in a Windows box, and the Linux template's guest
   * scripts in a Linux one (057).
   */
  readonly images: BackendImages = {
    list: (signal) => this.#imageList(signal),
    box: (build, label, signal) => this.#imageBox(build, label, signal),
    capture: (box, from, image, signal) => this.#capture(box, from, image, signal),
    replace: (build, current, signal) => this.#replaceTemplate(build, current, signal),
    remove: (ref, signal) => this.#removeImage(ref, signal),
    windows: true,
  };

  constructor(config: QemuConfig, context: BackendContext, options: QemuBackendOptions = {}) {
    this.id = context.id;
    this.#config = config;
    this.#context = context;
    this.#options = options;
    this.#http = options.fetch
      ? proxmoxHttp(options.fetch)
      : proxmoxFetch({ ca: config.proxmox.caCertificate, fingerprint: config.proxmox.tlsFingerprint });
    this.label = `Proxmox QEMU on ${config.proxmox.node ?? new URL(config.proxmox.apiUrl).hostname}`;
    this.hosts = [config.proxmox.node ?? new URL(config.proxmox.apiUrl).hostname];
    this.#snapshots = new ProxmoxSnapshotting(
      {
        label: this.label,
        type: "qemu",
        installId: context.installId,
        pool: config.proxmox.pool,
        tokenUser: config.proxmox.tokenId.split("!")[0] || null,
        client: () => this.client(),
        vmid: (guest) => this.#vmid(guest),
        ownConfig: (api, guest, signal) => this.#ownConfig(api, guest, signal),
        still: (api, guest, signal) => this.#still(api, guest, signal),
        rootDisk: bootDisk,
        disks: (config) => Object.keys(config).filter((key) => (isDisk(config, key) || /^(?:efidisk|tpmstate)\d+$/.test(key)) && storageOfVolume(config[key]) !== null),
        guests: (api, signal) => this.#boxGuests(api, signal),
        copies: (api, signal) => this.#keptGuests(api, signal),
        freeVmids: async (api, signal) => ({ free: this.#freeCount(await api.listPool(this.#config.proxmox.pool, signal)), range: `from ${this.#config.vmids.first} to ${this.#config.vmids.last}` }),
        sizeOf: (config) => sizeOf(config),
      },
      ["disk", "disk-and-memory"],
    );
  }

  identitySource(kind: string): IdentitySource | null {
    return LINUX_KINDS.some((linux) => linux.id === kind) && this.kinds().some((offered) => offered.id === kind) ? "device" : null;
  }

  snapshotting(kind: string): Snapshotting | null {
    if (!this.kinds().some((offered) => offered.id === kind)) return null;
    if (kind === KIND.id) return WINDOWS_DESKTOP_SNAPSHOTS;
    if (kind === ANDROID_IMAGE_KIND.id) return ANDROID_SNAPSHOTS;
    return isLinuxVmKind(kind) ? withDesktopForkSafety(kind, this.#snapshots.offer()) : null;
  }

  async planSnapshots(guest: Guest, kind: string, snapshot: SnapshotRef | null, signal?: AbortSignal): Promise<SnapshotPlan> {
    if (!this.snapshotting(kind)) throw new BackendError("unsupported", `${this.label} takes no snapshots of its ${kind} boxes.`);
    const plan = await this.#snapshots.plan(guest, signal, snapshot);
    if (kind === ANDROID_IMAGE_KIND.id) return androidSnapshotPlan(plan);
    return kind === KIND.id ? windowsDesktopSnapshotPlan(plan) : plan;
  }

  async snapshot(guest: Guest, take: SnapshotTake, hooks: SnapshotHooks, signal?: AbortSignal): Promise<SnapshotTaken> {
    if (take.memory && this.#fromAndroidTemplate(guest)) {
      throw new BackendError("unsupported", "An Android box snapshot holds its disk only. Leave memory out.");
    }
    if (take.memory && this.#fromWindowsTemplate(guest)) {
      throw new BackendError("unsupported", `${this.label} takes snapshots of a windows-desktop box's disk only, so a snapshot of it cannot hold its memory. Leave memory out.`);
    }
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
    if (status.status === "running") await api.stop(vmid, signal);
  }

  async #ownConfig(api: Proxmox, guest: Guest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const config = await this.#guestConfig(api, this.#vmid(guest), signal);
    const names = config ? namesOf(config) : null;
    const box = typeof guest.data?.box === "string" ? guest.data.box : null;
    if (!config || names!.install !== this.#context.installId || names!.box !== box) throw gone(this.#vmid(guest));
    return config;
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

  async guestIdentity(guest: Guest, signal?: AbortSignal): Promise<GuestIdentity> {
    const api = await this.client();
    const config = await this.#ownOrCopyConfig(api, guest, signal);
    const macs: Record<string, string> = {};
    for (const key of netKeys(config)) {
      const mac = macOf(String(config[key]));
      if (mac) macs[key] = mac;
    }
    return { macs, smbios: /(?:^|,)uuid=([^,]+)/.exec(String(config.smbios1 ?? ""))?.[1] ?? null };
  }

  async #claimFree(api: Proxmox, signal?: AbortSignal, noneFree: (range: string) => Error = (range) => new SnapshotFailed(`Every VMID ${range} is in use, so ${PRODUCT} has none for the copy a restore needs. Try again later, or ask the user to make room for the copy.`)): Promise<number> {
    if (this.#nextVmid === null) {
      const stored = await this.#context.storage.get<number>(NEXT_VMID);
      this.#nextVmid ??= typeof stored === "number" && this.#inRange(stored) ? stored : this.#config.vmids.first;
    }
    const vmid = this.#freeVmid(await api.listPool(this.#config.proxmox.pool, signal), this.#nextVmid);
    if (vmid === null) throw noneFree(`from ${this.#config.vmids.first} to ${this.#config.vmids.last}`);
    this.#reserved.add(vmid);
    this.#nextVmid = vmid === this.#config.vmids.last ? this.#config.vmids.first : vmid + 1;
    await this.#context.storage.set(NEXT_VMID, this.#nextVmid);
    return vmid;
  }

  async #fullClone(api: Proxmox, source: number, vmid: number, name: string, description: string, storage: string | null, hooks: CopyHooks, signal?: AbortSignal, snapshot?: string, diskGiB: number | null = null): Promise<void> {
    let upid: string;
    try {
      await hooks.submitting();
      upid = await api.startFullClone({ source, vmid, hostname: name, pool: this.#config.proxmox.pool, storage, description, ...(snapshot ? { snapshot } : {}) }, signal);
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
    if ((await api.status(from, signal))?.status === "running") throw new SnapshotFailed(`Guest ${from} is running, and ${PRODUCT} copies a guest only once it has stopped.`);
    if (config.lock) throw new SnapshotFailed(`Proxmox has guest ${from} locked (${String(config.lock)}), so ${PRODUCT} cannot copy it.`);
    const disk = bootDisk(config);
    const template = typeof source.data?.template === "number" ? source.data.template : null;
    const vmid = await this.#claimFree(api, signal);
    try {
      const copy = this.#guest(api.node, vmid, template, label.box);
      await hooks.claimed(copy);
      await this.#fullClone(api, from, vmid, copyName(vmid), heldCopyDescription(this.#context.installId, label), disk ? storageOfVolume(config[disk]) : null, hooks, signal, undefined, sizeOf(config)?.diskGiB ?? null);
      await disarm(api, vmid, signal);
      await api.configure(vmid, { tags: heldCopyTags(this.#context.installId, label, Date.now(), template), onboot: false }, signal);
      return copy;
    } finally {
      this.#reserved.delete(vmid);
    }
  }

  async copySnapshot(ref: SnapshotRef, label: HeldCopyLabel, hooks: CopyHooks, signal?: AbortSignal): Promise<Guest> {
    if (this.#fromAndroidTemplate(ref.guest)) {
      throw new BackendError("unsupported", `${this.label} keeps no Android snapshot past release: ${ANDROID_NO_FORK}.`);
    }
    if (this.#fromWindowsTemplate(ref.guest)) {
      throw new BackendError("unsupported", `${this.label} keeps no snapshot of a windows-desktop box past its release: ${WINDOWS_DESKTOP_NO_FORK}.`);
    }
    const api = await this.client();
    const from = this.#vmid(ref.guest);
    const config = await this.#ownOrCopyConfig(api, ref.guest, signal);
    const disk = bootDisk(config);
    const template = typeof ref.guest.data?.template === "number" ? ref.guest.data.template : null;
    const vmid = await this.#claimFree(api, signal, (range) => new SnapshotFailed(`Every VMID ${range} is in use, so ${PRODUCT} has none for the held copy. Try again later, or ask the user to make room for the copy.`));
    try {
      const copy = this.#guest(api.node, vmid, template, label.box);
      await hooks.claimed(copy);
      await this.#fullClone(api, from, vmid, copyName(vmid), heldCopyDescription(this.#context.installId, label), disk ? storageOfVolume(config[disk]) : null, hooks, signal, ref.ref, sizeOf(config)?.diskGiB ?? null);
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
    if (!String(config.description ?? "").startsWith(madeFor)) throw new SnapshotFailed(`Guest ${vmid} is not the copy ${PRODUCT} made of snapshot ${label.snapshot}, so ${PRODUCT} does not label it as one.`);
    const template = typeof copy.data?.template === "number" ? copy.data.template : null;
    await disarm(api, vmid, signal);
    await api.configure(vmid, { tags: heldCopyTags(this.#context.installId, label, Date.now(), template), onboot: false, delete: ["protection"] }, signal);
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
      await api.configure(vmid, { tags: withKeptTag(tags, kept), description: heldCopyDescription(this.#context.installId, { box, snapshot: ref.id, kept }) }, signal);
    } catch (error) {
      if (error instanceof ProxmoxError && error.status >= 400) throw new SnapshotFailed(`Proxmox refused to write the keep date on held copy ${vmid}: ${error.message}`);
      throw error;
    }
  }

  async #copyConfig(api: Proxmox, copy: Guest, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    const config = await this.#guestConfig(api, this.#vmid(copy), signal);
    if (!config) return null;
    const tags = parseTags(config.tags);
    const box = typeof copy.data?.box === "string" ? copy.data.box : null;
    return tags.includes(installTag(this.#context.installId)) && (copyTags(tags).box ?? namesOf(config).box) === box ? config : null;
  }

  async disarmCopy(copy: Guest, signal?: AbortSignal): Promise<void> {
    const api = await this.client();
    const vmid = this.#vmid(copy);
    const config = await this.#copyConfig(api, copy, signal);
    if (!config) throw gone(vmid);
    await api.setNetwork(vmid, Object.fromEntries(netKeys(config).map((key) => [key, netWith(String(config[key]), { up: false })])), signal);
    await api.configure(vmid, { onboot: false, smbios1: withUuid(config.smbios1, randomUUID()) }, signal);
  }

  async templateCopy(copy: Guest, signal?: AbortSignal): Promise<void> {
    const api = await this.client();
    const vmid = this.#vmid(copy);
    const config = await this.#copyConfig(api, copy, signal);
    if (!config) throw gone(vmid);
    if (!isTemplate(config)) await api.makeTemplate(vmid, signal);
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
    if (!isHeldCopy(tags) && !isEarlierGuest(tags) && !described) throw new SnapshotFailed(`Guest ${copy.ref} is not a held copy or an earlier guest of box ${box}, so ${PRODUCT} does not delete it as one.`);
    await this.#forget(this.#vmid(copy));
    await api.destroy(this.#vmid(copy), signal);
  }

  async adoptCopy(copy: Guest, box: BoxIdentity, identity: GuestIdentity, hooks: CopyHooks, signal?: AbortSignal): Promise<Guest> {
    const api = await this.client();
    const from = this.#vmid(copy);
    const config = await this.#copyConfig(api, copy, signal);
    if (!config || !isTemplate(config)) throw new SnapshotFailed(`Guest ${from} is not a held copy of box ${box.name} that ${PRODUCT} can use.`);
    const disk = bootDisk(config);
    const template = typeof copy.data?.template === "number" ? copy.data.template : null;
    const vmid = await this.#claimFree(api, signal);
    try {
      const fresh = this.#guest(api.node, vmid, template, box.boxId);
      await hooks.claimed(fresh);
      await this.#fullClone(api, from, vmid, box.name, describe(box, this.#context.installId), disk ? storageOfVolume(config[disk]) : null, hooks, signal, undefined, sizeOf(config)?.diskGiB ?? null);
      const made = (await api.config(vmid, signal)) ?? {};
      const address = addressFor(this.#config, vmid);
      if (!address) throw new SnapshotFailed(`VMID ${vmid} is outside the box range.`);
      const { bridge, prefix, gateway } = this.#config.network;
      const nets: Record<string, string> = {};
      for (const key of netKeys(made)) {
        const mac = identity.macs[key];
        nets[key] = netWith(key === "net0" ? net0On(made[key], bridge) : String(made[key]), { ...(mac ? { mac } : {}), up: true });
      }
      await api.setNetwork(vmid, nets, signal);
      await api.configure(vmid, { tags: boxTags(box, this.#context.installId, template), onboot: true, smbios1: smbios1For(address, prefix, gateway, identity.smbios ?? randomUUID()), delete: ["protection"] }, signal);
      return { ...fresh, size: sizeOf(await api.config(vmid, signal)) };
    } finally {
      this.#reserved.delete(vmid);
    }
  }

  async forkSnapshot(ref: SnapshotRef, box: BoxIdentity, previous: Guest | null, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest> {
    const offer = this.snapshotting(box.kind);
    if (!offer || offer.fork !== "copy") {
      const why = offer?.forkWhy ? `: ${offer.forkWhy}` : "";
      throw new BackendError("unsupported", `${this.label} forks no ${box.kind} boxes${why}.`);
    }
    return forkByFullClone(
      {
        installId: this.#context.installId,
        pool: this.#config.proxmox.pool,
        client: () => this.client(),
        vmid: (guest) => this.#vmid(guest),
        ownConfig: (api, guest, signal) => this.#ownConfig(api, guest, signal),
        sourceConfig: (api, guest, signal) => this.#ownOrCopyConfig(api, guest, signal),
        rootDisk: bootDisk,
        claimVmid: (api, signal) => this.#claimFree(api, signal, (range) => new BackendError("no_capacity", `Not forked: every VMID ${range} is in use, so ${PRODUCT} has none for the fork. Try again later, or ask the user. ${PRODUCT} copied nothing.`)),
        unreserve: (vmid) => this.#reserved.delete(vmid),
        forget: (vmid) => this.#forget(vmid),
        guest: (node, vmid, template, boxId, build) => this.#guest(node, vmid, template, boxId, null, build),
        addressed: async (api, vmid, made, forked, template, signal) => {
          const address = addressFor(this.#config, vmid);
          if (!address) throw new Error(`VMID ${vmid} is outside the box range.`);
          const { bridge, prefix, gateway } = this.#config.network;
          const nets: Record<string, string> = {};
          for (const key of netKeys(made)) nets[key] = netWith(key === "net0" ? net0On(made[key], bridge) : String(made[key]), { mac: randomMac(), up: false });
          await api.setNetwork(vmid, nets, signal);
          await api.configure(
            vmid,
            { cores: forked.size.cores, memory: forked.size.memoryMiB, tags: boxTags(forked, this.#context.installId, template), onboot: false, smbios1: smbios1For(address, prefix, gateway, randomUUID()), delete: ["protection"] },
            signal,
          );
        },
        sizeOf,
        writes: (api) => api,
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
    return armFork({ client: () => this.client(), vmid: (each) => this.#vmid(each), ownConfig: (api, each, signal) => this.#ownConfig(api, each, signal), writes: (api) => api }, guest, arming, signal);
  }

  disarmFork(guest: Guest, signal?: AbortSignal): Promise<void> {
    return disarmFork({ client: () => this.client(), vmid: (each) => this.#vmid(each), installId: this.#context.installId, writes: (api) => api }, guest, signal);
  }

  async retireGuest(guest: Guest, box: BoxIdentity, signal?: AbortSignal): Promise<Guest> {
    const api = await this.client();
    const vmid = this.#vmid(guest);
    const config = await this.#copyConfig(api, guest, signal);
    if (!config) throw gone(vmid);
    await this.#forget(vmid);
    await api.setNetwork(vmid, Object.fromEntries(netKeys(config).map((key) => [key, netWith(String(config[key]), { mac: randomMac(), up: false })])), signal);
    const template = typeof guest.data?.template === "number" ? guest.data.template : null;
    await api.configure(
      vmid,
      { onboot: false, smbios1: withUuid(config.smbios1, randomUUID()), tags: [...boxTags(box, this.#context.installId, template), EARLIER_GUEST], description: `${describe(box, this.#context.installId)}\nearlier guest` },
      signal,
    );
    return guest;
  }

  async #keptGuests(api: Proxmox, signal?: AbortSignal): Promise<KeptGuest[]> {
    const install = installTag(this.#context.installId);
    return (await api.listPool(this.#config.proxmox.pool, signal))
      .filter((guest) => guest.type === "qemu" && this.#inRange(guest.vmid) && guest.tags.includes(install) && (isHeldCopy(guest.tags) || isEarlierGuest(guest.tags)))
      .flatMap((guest): KeptGuest[] => {
        const tags = copyTags(guest.tags);
        const owner = ownerFromTags(guest.tags, guest.name || null) ?? (tags.box ? { boxId: tags.box, threadId: "unknown", name: null, kind: tags.kind, createdAt: null } : null);
        if (!owner) return [];
        return [{ guest: this.#guest(guest.node || api.node, guest.vmid, templateFromTags(guest.tags), owner.boxId), owner, where: isHeldCopy(guest.tags) ? "held-copy" : "earlier", snapshot: tags.snapshot, takenAt: tags.takenAt, kept: tags.kept, template: guest.template, forkSafe: tags.forkSafe }];
      });
  }

  async #boxGuests(api: Proxmox, signal?: AbortSignal): Promise<{ guest: Guest; owner: BoxOwner | null }[]> {
    const install = installTag(this.#context.installId);
    return (await api.listPool(this.#config.proxmox.pool, signal))
      .filter((guest) => guest.type === "qemu" && !guest.template && this.#inRange(guest.vmid) && guest.tags.includes(TAG) && guest.tags.includes(install) && !isEarlierGuest(guest.tags) && !isHeldCopy(guest.tags))
      .flatMap((guest) => {
        const owner = ownerFromTags(guest.tags, guest.name || null);
        return owner ? [{ guest: this.#guest(guest.node || api.node, guest.vmid, templateFromTags(guest.tags), owner.boxId), owner }] : [];
      });
  }

  kinds(): BoxKind[] {
    const kinds: BoxKind[] = [];
    // Windows boxes join BB unless the switch is set off (#539).
    if (this.#config.templates.length) kinds.push(this.#config.enrol ? { ...KIND, capabilities: { ...KIND.capabilities, enrol: true } } : KIND);
    // KVM where the settings say the host allows nested virtualization (057).
    for (const kind of LINUX_KINDS) {
      if (!this.#templatesOf(kind.id).length) continue;
      kinds.push(this.#config.kvm ? { ...kind, capabilities: { ...kind.capabilities, features: [...kind.capabilities.features, "kvm"] } } : kind);
    }
    if (this.#config.androidTemplates.length && this.#config.kvm) {
      if (!this.#androidDevices || Date.now() - this.#androidDevices.at > ANDROID_DEVICES_KEPT_MS) void this.#readAndroidDevices();
      const offer = this.#androidDevices?.offer;
      if (offer) kinds.push(androidKind(offer));
    }
    return kinds;
  }

  #readAndroidDevices(signal?: AbortSignal): Promise<void> {
    this.#androidReading ??= (async () => {
      const api = await this.client();
      const whys: string[] = [];
      let offer: DeviceOffer | null = null;
      for (const template of this.#config.androidTemplates) {
        const config = await api.config(template, signal).catch((error: unknown) => {
          whys.push(`Android template ${template} could not be read: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        });
        if (!config) continue;
        const devices = recordInDescription(String(config.description ?? ""))?.devices ?? null;
        if (devices && devices[0].runtime.platform === "android") {
          offer = { platform: "android", devices } as DeviceOffer;
          break;
        }
        whys.push(`Android template ${template} lists no Android devices in its record, so there is none to boot. bb box doctor says why`);
      }
      const before = JSON.stringify(this.#androidDevices?.offer ?? null);
      this.#androidDevices = { offer, at: Date.now(), why: offer ? null : `${whys.join("; ")}.` };
      if (JSON.stringify(offer) !== before) this.#context.kindsChanged?.();
    })()
      .catch((error) => this.#context.logError("read the Android templates' devices", error))
      .finally(() => (this.#androidReading = null));
    return this.#androidReading;
  }

  async withheldKinds(kind: string, signal?: AbortSignal): Promise<readonly WithheldKind[]> {
    if (kind !== ANDROID_IMAGE_KIND.id || !this.#config.androidTemplates.length) return [];
    if (!this.#config.kvm) {
      return [{ kind, why: "Android templates are listed, but KVM in Linux VM boxes is off in Proxmox QEMU's settings, and the Android emulator needs it. bb box doctor says how to turn it on.", passing: false }];
    }
    if (this.kinds().some((offered) => offered.id === kind)) return [];
    await this.#readAndroidDevices(signal);
    if (this.kinds().some((offered) => offered.id === kind)) return [];
    return [{ kind, why: this.#androidDevices?.why ?? `${PRODUCT} has not read the Android templates' records yet.`, passing: false }];
  }

  #linuxKind(kind: string): boolean {
    return kind === ANDROID_IMAGE_KIND.id || LINUX_KINDS.some((linux) => linux.id === kind);
  }

  /** The templates of a kind's boxes. */
  #templatesOf(kind: string): readonly number[] {
    if (kind === LINUX_KIND.id) return this.#config.linuxTemplates;
    if (kind === ANDROID_IMAGE_KIND.id) return this.#config.androidTemplates;
    return kind === LINUX_DESKTOP_KIND.id ? this.#config.linuxDesktopTemplates : this.#config.templates;
  }

  /** Every template, Windows', Linux' and Android's. */
  #allTemplates(): readonly number[] {
    return [...this.#config.templates, ...this.#config.linuxTemplates, ...this.#config.linuxDesktopTemplates, ...this.#config.androidTemplates];
  }

  /** A template as messages name it: "Linux template 9106", "Android template 9108" or "Windows template 9104". */
  #templateName(template: number): string {
    const kind = this.#kindOf(template);
    return `${this.#flavour(kind)} template ${template}`;
  }

  #flavour(kind: BoxKind): string {
    return kind === LINUX_DESKTOP_KIND ? "Linux desktop" : kind === LINUX_KIND ? "Linux" : kind === ANDROID_IMAGE_KIND ? "Android" : "Windows";
  }

  #androidDisk(template: number, storage: string, freeGiB: number, report: { pass: (check: Check, detail: string) => void; warn: (check: Check, detail: string, fix: string) => void }): void {
    const spare = freeGiB - this.#config.reserve.diskGiB;
    const detail = `${storage}, where Android template ${template} is, has ${freeGiB} GiB free, ${spare} GiB beyond the ${this.#config.reserve.diskGiB} GiB kept free.`;
    if (spare >= ANDROID_ROOM_GIB) report.pass(ANDROID_DISK, `${detail} A refresh's build and trial boxes and an Android box in use need about ${ANDROID_ROOM_GIB} GiB.`);
    else
      report.warn(
        ANDROID_DISK,
        `${detail} A refresh's build and trial boxes and an Android box in use need about ${ANDROID_ROOM_GIB} GiB, so a refresh may wait for room or fail.`,
        `Free space on ${storage}, release boxes, or lower the disk kept free in ${PRODUCT}'s settings.`,
      );
  }

  #fromAndroidTemplate(guest: Guest): boolean {
    const template = guest.data?.template;
    return typeof template === "number" && this.#kindOf(template).id === ANDROID_IMAGE_KIND.id;
  }

  #fromWindowsTemplate(guest: Guest): boolean {
    const template = guest.data?.template;
    return typeof template === "number" && this.#kindOf(template).id === KIND.id;
  }

  /** The OS of a guest from its template: Linux for a Linux template's clone, Windows otherwise. */
  #osOf(template: unknown): GuestOs {
    return this.#kindOf(template).capabilities.os;
  }

  /** build.sh's word for a template's kind: windows, linux, linux-desktop or android. */
  #buildWord(template: number): string {
    const kind = this.#kindOf(template);
    return kind === LINUX_DESKTOP_KIND ? "linux-desktop" : kind === ANDROID_IMAGE_KIND ? "android" : kind.capabilities.os;
  }

  /** The kind of a template's boxes: Windows' unless it is a Linux, Linux desktop or Android template. */
  #kindOf(template: unknown): BoxKind {
    if (typeof template !== "number") return KIND;
    return LINUX_TEMPLATE_KINDS.find((kind) => this.#templatesOf(kind.id).includes(template)) ?? KIND;
  }

  async capacity(kind: string, size: MachineSize, pending: readonly Pending[], signal?: AbortSignal): Promise<Capacity> {
    this.#offer(kind);
    const api = await this.client();
    const guests = await api.listPool(this.#config.proxmox.pool, signal);
    // Linux boxes have no warm pool here: their spares wait hibernated (#612).
    if (this.#linuxKind(kind)) return this.#room(api, size, guests, pending, { ready: 0, target: 0 }, false, signal, kind);
    const ready = await this.#ready(api, guests, signal);
    // Acquires here that hold a warm VM need no other.
    const waiting = Math.max(0, pending.length - this.#claimed.size);
    const fromPool = ready.filter((warm) => serves(warm.size, size)).length > waiting;
    return this.#room(api, size, guests, pending, { ready: ready.length, target: this.#warmTarget() }, fromPool, signal);
  }

  /**
   * Room on the node for a box of `size`, with `pending` boxes still to
   * come. With `fromPool`, the box is a warm VM, which resumes with its
   * memory but needs no VMID or disk of its own.
   */
  async #room(
    api: Proxmox,
    size: MachineSize,
    guests: readonly PoolGuest[],
    pending: readonly Pending[],
    warm: { ready: number; target: number },
    fromPool: boolean,
    signal?: AbortSignal,
    kind: string = KIND.id,
  ): Promise<Capacity> {
    const template = await this.#templateOf(api, this.#choose(guests, kind), signal);
    const { storage } = template;
    const [node, disk] = await Promise.all([api.nodeStatus(signal), api.storageStatus(storage, signal)]);
    const reserve = this.#config.reserve;
    const pendingMiB = pending.reduce((sum, other) => sum + other.size.memoryMiB, 0);
    const memoryTotal = Math.floor(node.memoryTotal / MiB);
    const memoryUsed = memoryTotal - Math.floor(node.memoryAvailable / MiB) + pendingMiB;
    const memoryFree = memoryTotal - memoryUsed;
    const diskTotal = Math.floor(disk.total / MiB);
    const diskUsed = diskTotal - Math.floor(disk.available / MiB);
    const diskFree = diskTotal - diskUsed;
    const { first, last } = this.#config.vmids;
    const used = new Set([...this.#reserved, ...guests.map((guest) => guest.vmid).filter((vmid) => this.#inRange(vmid))]);
    const limits: Limit[] = [
      { resource: "memory", used: memoryUsed, total: memoryTotal, reserve: reserve.memoryMiB, unit: "MiB" },
      { resource: "disk", used: diskUsed, total: diskTotal, reserve: reserve.diskGiB * 1024, unit: "MiB" },
      { resource: "guests", used: used.size, total: last - first + 1, reserve: 0, unit: "count" },
    ];
    const problems: string[] = [];
    // A refusal leads with what binds: the box when it needs more than is free, otherwise what is kept free.
    if (memoryFree - size.memoryMiB < reserve.memoryMiB) {
      const box = `a ${kind} box with ${formatMiB(size.memoryMiB)} memory`;
      problems.push(
        size.memoryMiB > memoryFree
          ? `${api.node} has ${formatMiB(Math.max(0, memoryFree))} of memory free, less than ${box} needs. Release a box or ask for less memory.`
          : `${api.node} has ${formatMiB(memoryFree)} of memory free and keeps ${formatMiB(reserve.memoryMiB)} free, so ${box} does not fit. ` +
            (memoryFree > reserve.memoryMiB
              ? `Release a box, ask for less memory, or lower the memory kept free in ${PRODUCT}'s settings.`
              : `Release a box, or lower the memory kept free in ${PRODUCT}'s settings.`),
      );
    }
    if (node.cpus !== null && size.cores > node.cpus) {
      problems.push(`${api.node} has ${node.cpus} CPU threads, fewer than the ${size.cores} cores asked for. Ask for at most ${node.cpus} cores.`);
    }
    const grow = size.diskGiB !== null && !fromPool ? Math.max(0, size.diskGiB - (template.diskGiB ?? 0)) : 0;
    if (grow > 0 && diskFree - grow * 1024 < reserve.diskGiB * 1024) {
      const storageFree = `The ${storage} storage on ${api.node} has ${Math.floor(diskFree / 1024)} GiB free`;
      problems.push(
        grow * 1024 > diskFree
          ? `${storageFree}, less than the ${Math.ceil(grow)} GiB a ${size.diskGiB} GiB disk adds to the template's. Ask for a smaller disk or release boxes.`
          : `${storageFree} and keeps ${reserve.diskGiB} GiB free, so a ${size.diskGiB} GiB disk, ${Math.ceil(grow)} GiB more than the template's, does not fit. ` +
            `Ask for a smaller disk, release boxes, or lower the disk kept free in ${PRODUCT}'s settings.`,
      );
    }
    if (diskFree < reserve.diskGiB * 1024 && !fromPool) {
      problems.push(
        `The ${storage} storage on ${api.node} has ${Math.floor(diskFree / 1024)} GiB free, less than the ${reserve.diskGiB} GiB kept free. ` +
          `Release boxes, free some space, or lower the disk kept free in ${PRODUCT}'s settings.`,
      );
    }
    if (this.#freeVmid(guests) === null && !fromPool) {
      problems.push(`Every VMID from ${first} to ${last} is in use. Release a box, or widen the VMID range in ${PRODUCT}'s settings.`);
    }
    const ok = problems.length === 0;
    return { ok, message: ok ? null : problems[0]!, warm, hosts: [{ host: api.node, ok, limits }] };
  }

  /**
   * The least used template, counting guests in the range by their template
   * tag, and acquires and fills here that have chosen one.
   */
  #choose(guests: readonly PoolGuest[], kind: string = KIND.id): number {
    const counts = new Map<number, number>();
    const add = (template: number | null) => {
      if (template !== null) counts.set(template, (counts.get(template) ?? 0) + 1);
    };
    for (const guest of guests) if (this.#inRange(guest.vmid)) add(templateFromTags(guest.tags));
    for (const template of this.#acquiring.values()) add(template);
    // A fill's VM counts once, by its tag once it has one.
    const tagged = new Set(guests.filter((guest) => templateFromTags(guest.tags) !== null).map((guest) => guest.vmid));
    for (const [vmid, template] of this.#filling) if (!tagged.has(vmid)) add(template);
    const uses = (template: number) => counts.get(template) ?? 0;
    return this.#templatesOf(kind).reduce((best, template) => (uses(template) < uses(best) ? template : best));
  }

  async acquire(box: BoxIdentity, previous: Guest | null, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest> {
    this.#offer(box.kind);
    const linux = this.#linuxKind(box.kind);
    const os: GuestOs = linux ? "linux" : "windows";
    const deadline = Date.now() + (this.#options.readyTimeoutMs ?? KIND.readyTimeoutMs);
    const api = await this.client();
    const installId = this.#context.installId;
    const step = timed((name, ms) => hooks.timing(name, ms));
    let vmid: number | null = null;
    let claimed: number | null = null;
    let template: number | null = null;
    let build: string | null = null;
    let warm: number | null = null;
    const claim = async (id: number) => {
      claimed = id;
      await hooks.claim(this.#guest(api.node, id, template, box.boxId, null, build));
    };
    try {
      let resumed = false;
      let display: { mode: string; reason: string } | null = null;
      if (previous && this.#inRange(Number(previous.ref)) && (await this.#owns(api, Number(previous.ref), box.boxId, signal))) {
        vmid = Number(previous.ref);
        template = typeof previous.data?.template === "number" ? previous.data.template : null;
        build = typeof previous.data?.build === "string" ? previous.data.build : null;
        resumed = true;
      }
      // Linux boxes have no warm pool here: their spares wait hibernated (#612).
      if (vmid === null && !linux) {
        const member = await step("warm", () =>
          this.#warm.claim(KIND.id, box, {
            fits: (candidate) => {
              const listed = this.#listed.get(candidate.ref);
              return !!listed && serves(listed.size, box.size);
            },
            before: (candidate) => {
              const listed = this.#listed.get(candidate.ref)!;
              template = listed.template;
              build = listed.build;
              return claim(Number(candidate.ref));
            },
            signal,
          }),
        );
        if (member) warm = vmid = Number(member.ref);
      }
      if (warm !== null) {
        const id = warm;
        await hooks.starting();
        await step("resume", () => api.start(id, signal));
        // The tags first, as a running VM tagged warm is deleted. onboot was off while it was warm.
        await step("relabel", async () => {
          // A warm VM keeps its low CPU weight, and the tag, until it is ready (#888).
          const low = parseTags((await api.config(id, signal)).tags).includes(START_TAG);
          await api.configure(id, { tags: withStartTag(boxTags(box, installId, template), low), name: box.name, description: describe(box, installId), onboot: true }, signal);
        });
        const size = api.config(id, signal).then(sizeOf, () => null);
        await this.#waitReady(id, Math.max(1_000, deadline - Date.now()), signal, step);
        await step("clock", () => this.#setClock(id, signal));
        this.#compileDisplay(id);
        this.#kick();
        if (box.threadId !== SPARES) await this.#settle(api, id, signal);
        return this.#guest(api.node, id, template, box.boxId, await size, build);
      }
      if (vmid === null) {
        // Time spent waiting for a template that is being replaced shows apart from the clone.
        let away: number | null = null;
        const cloning = performance.now();
        try {
          const guests = await api.listPool(this.#config.proxmox.pool, signal);
          template = this.#choose(guests, box.kind);
          this.#acquiring.set(box.boxId, template);
          // Read before the clone, so it is never newer than the clone's: a replace in between leaves the box what it has.
          build = (await templateBuild(api, guests, template, signal)) ?? null;
          vmid = await this.#clone(api, guests, template, box.name, describe(box, installId), claim, signal, (ms) => (away = (away ?? 0) + ms));
        } finally {
          if (away !== null) hooks.timing("template", away);
          hooks.timing("clone", Math.round(performance.now() - cloning - (away ?? 0)));
        }
      }
      const id = vmid;
      // A low CPU weight until the box is ready (#888), where its config sets none of its own.
      let low = false;
      const config = await step("configure", async () => {
        const current = await api.config(id, signal);
        low = startsLow(current);
        await api.configure(id, { ...this.#settings(box.size, id, current), ...(low ? LOW : {}) }, signal);
        return current;
      });
      await step("tags", () => api.configure(id, { tags: withStartTag(boxTags(box, installId, template), low) }, signal));
      const grew = await this.#grow(api, id, config, box.size.diskGiB, step, signal);
      await hooks.starting();
      await step("start", async () => {
        if ((await api.status(id, signal))?.status !== "running") await api.start(id, signal);
      });
      // Read while the box comes up: the size it has, as Proxmox gives it.
      const size = api.config(id, signal).then(sizeOf, () => null);
      await this.#waitReady(id, Math.max(1_000, deadline - Date.now()), signal, step, os);
      if (isLinuxVmKind(box.kind)) await step("name", () => this.#nameLinux(id, box.name, signal));
      const unfilled = linux && (grew || (resumed && box.size.diskGiB !== null)) ? await step("grow", () => this.#rootUnfilled(id, signal)) : null;
      // Its desktop starts after SSH, as in Proxmox LXC.
      if (linux && this.#kindOf(template).capabilities.displays.length) {
        display = await step("display", () => this.#linuxDisplay(id, Math.max(1_000, deadline - Date.now()), signal));
      }
      if (!linux) {
        // A resumed acquire may have grown the disk before it stopped.
        if (grew || (resumed && box.size.diskGiB !== null)) await step("extend", () => this.#extend(id, signal));
        this.#compileDisplay(id);
      }
      // A spare keeps its low weight until a box takes it: relabel() puts it back then.
      if (box.threadId !== SPARES) await this.#settle(api, id, signal);
      return withRootFact(this.#guest(api.node, id, template, box.boxId, await size, build, display), unfilled);
    } catch (error) {
      // A clone cut short may still have made the guest; it is ours if it names the box.
      const leftover = vmid ?? claimed;
      if (leftover !== null && (vmid !== null || (await this.#owns(api, leftover, box.boxId).catch(() => false)))) {
        await this.#forget(leftover);
        await api.destroy(leftover).catch((cause) => this.#context.logError("release after a failed acquire", cause));
      }
      throw error;
    } finally {
      this.#acquiring.delete(box.boxId);
      // The box's now, or deleted after a failed claim.
      if (warm !== null) this.#claimed.delete(warm);
    }
  }

  async release(guest: Guest, hooks: ReleaseHooks, signal?: AbortSignal): Promise<void> {
    const started = performance.now();
    await this.disarmFork(guest, signal).catch((error: unknown) => this.#context.logError("disarm before release", error));
    await this.#forget(this.#vmid(guest));
    const api = await this.client();
    if (await this.#still(api, guest, signal)) await api.destroy(this.#vmid(guest), signal);
    hooks.timing("delete", Math.round(performance.now() - started));
  }

  async power(guest: Guest, signal?: AbortSignal): Promise<PowerState | null> {
    const api = await this.client();
    if (!(await this.#still(api, guest, signal))) return null;
    const status = await api.status(this.#vmid(guest), signal);
    return status ? powerOf(status.status) : null;
  }

  /**
   * Resumes a hibernated VM, or boots a stopped one, and waits for SSH. Then
   * sets Windows' clock, which a resume leaves at the time it stopped (039).
   */
  async start(guest: Guest, signal?: AbortSignal, timing: (step: string, ms: number) => void = () => {}, answered?: () => Promise<void>, readyWithinMs?: number): Promise<void> {
    const vmid = this.#vmid(guest);
    const api = await this.client();
    const status = (await this.#still(api, guest, signal)) ? await api.status(vmid, signal) : null;
    if (!status) throw gone(vmid);
    const step = timed(timing);
    // A hibernated VM resumes; one shut down from Windows boots.
    const resumed = status.status !== "running" && status.lock === "suspended";
    if (status.status !== "running") await step(resumed ? "resume" : "boot", () => api.start(vmid, signal));
    const os = this.#osOf(guest.data?.template);
    await this.#waitReady(vmid, this.#options.readyTimeoutMs ?? readyWithinMs ?? READY_TIMEOUT_MS, signal, step, os);
    const kind = this.#kindOf(guest.data?.template);
    if (isLinuxVmKind(kind.id)) {
      const name = (await api.config(vmid, signal)).name;
      if (typeof name === "string" && name) await step("name", () => this.#nameLinux(vmid, name, signal));
    }
    await answered?.();
    // Linux keeps its clock with its own time service.
    if (os === "windows") await step("clock", () => this.#setClock(vmid, signal));
    else if (resumed && this.#kindOf(guest.data?.template) === ANDROID_IMAGE_KIND) await step("clock", () => this.#setLinuxClock(vmid, signal));
  }

  /**
   * A VM's boot disk grows while it runs, and the guest's file system with
   * it; its cores and memory change only when it boots again, as the
   * templates have no CPU or memory hot-plug (061).
   */
  resizing(kind: string): Resizing | null {
    return this.kinds().some((offer) => offer.id === kind) ? { cores: "restart", memory: "restart", disk: "live", shrinks: true } : null;
  }

  async planResize(guest: Guest, kind: string, to: MachineSize, pending: readonly Pending[], signal?: AbortSignal): Promise<ResizePlan> {
    this.#offer(kind);
    const { config, from } = await this.#resizable(guest, to, signal);
    const parts: ResizePlan["parts"][number][] = [];
    if (to.cores !== from.cores) parts.push({ part: "cores", from: from.cores, to: to.cores, way: "restart" });
    if (to.memoryMiB !== from.memoryMiB) parts.push({ part: "memory", from: from.memoryMiB, to: to.memoryMiB, way: "restart" });
    if (to.diskGiB !== null && to.diskGiB !== from.diskGiB) parts.push({ part: "disk", from: from.diskGiB, to: to.diskGiB, way: "live" });
    const api = await this.client();
    const disk = bootDisk(config);
    const storage = disk ? String(config[disk] ?? "").split(":")[0] || null : null;
    const room = await this.#resizeRoom(api, storage, from, to, pending, signal);
    const downSeconds = parts.some((part) => part.way === "restart") ? (this.#osOf(guest.data?.template) === "windows" ? 40 : 20) : null;
    return { parts, room, downSeconds };
  }

  /**
   * Resizes a running VM (061). The disk alone grows live, and then the
   * guest's root file system or C: over it. New cores or memory need
   * `restart`: a clean shutdown, the new config, any larger disk, and a
   * boot. When the VM does not come back at its new size, its old cores and
   * memory go back and it boots again.
   */
  async resize(guest: Guest, _kind: string, to: MachineSize, options: { readonly restart: boolean }, signal?: AbortSignal): Promise<Guest> {
    const vmid = this.#vmid(guest);
    const api = await this.client();
    const { config, from } = await this.#resizable(guest, to, signal);
    const os = this.#osOf(guest.data?.template);
    const restart = to.cores !== from.cores || to.memoryMiB !== from.memoryMiB;
    if (restart && !options.restart) throw new BackendError("unsupported", "A VM's cores and memory change only with a restart.");
    const grows = to.diskGiB !== null && (from.diskGiB === null || to.diskGiB > from.diskGiB);
    if (!restart) {
      const grew = grows && (await this.#grow(api, vmid, config, to.diskGiB, untimed, signal));
      if (grew && os === "windows") await this.#extend(vmid, signal);
      const resized = { ...guest, size: sizeOf(await api.config(vmid, signal)) ?? to };
      return grew && os === "linux" ? withRootFact(resized, await this.#rootUnfilled(vmid, signal)) : resized;
    }
    await this.#forget(vmid);
    await api.shutdown(vmid, SHUTDOWN_WAIT_S, signal);
    await api.configure(vmid, { cores: to.cores, memory: to.memoryMiB }, signal);
    let grew = false;
    try {
      if (grows) grew = await this.#grow(api, vmid, config, to.diskGiB, untimed, signal);
      await this.start(guest, signal);
    } catch (error) {
      // Back to the cores and memory it had, and up again; a disk that grew stays.
      await api.stop(vmid).catch(() => undefined);
      await api.configure(vmid, { cores: from.cores, memory: from.memoryMiB }).catch((cause) => this.#context.logError("resize: put cores and memory back", cause));
      await this.start(guest).catch((cause) => this.#context.logError("resize: start at the old size", cause));
      throw error;
    }
    if (grew && os === "windows") await this.#extend(vmid, signal);
    const resized = { ...guest, size: sizeOf(await api.config(vmid, signal)) ?? to };
    return grew && os === "linux" ? withRootFact(resized, await this.#rootUnfilled(vmid, signal)) : resized;
  }

  /** The VM's config and size, when it is the box's and runs, and the disk asked for is not smaller (061). */
  async #resizable(guest: Guest, to: MachineSize, signal?: AbortSignal): Promise<{ config: Record<string, unknown>; from: MachineSize }> {
    const vmid = this.#vmid(guest);
    const api = await this.client();
    const status = (await this.#still(api, guest, signal)) ? await api.status(vmid, signal) : null;
    if (!status) throw gone(vmid);
    // A hibernated VM's config cannot change, and its session would be lost.
    if (status.status !== "running") throw new BackendError("unsupported", "A stopped VM is resized once it runs: start it first.");
    const config = await api.config(vmid, signal);
    const from = sizeOf(config);
    if (!from) throw new Error(`VM ${vmid} does not say its cores and memory, so ${PRODUCT} cannot resize it.`);
    if (to.diskGiB !== null && from.diskGiB !== null && to.diskGiB < from.diskGiB) {
      throw new BackendError("unsupported", `A VM's disk only grows, and this one's is ${from.diskGiB} GiB.`);
    }
    return { config, from };
  }

  async #rootUnfilled(vmid: number, signal?: AbortSignal): Promise<GuestFact | null> {
    try {
      const result = await (await this.#command(vmid, "linux")).run(GROW_ROOT, { timeoutMs: 60_000, signal, maxOutputBytes: 4096 });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim().split("\n").at(-1) || `exit code ${result.exitCode}`);
      return null;
    } catch (error) {
      if (signal?.aborted) throw error;
      this.#context.logError(`grow the root file system of VM ${vmid}`, error);
      return rootNotGrown(error);
    }
  }

  /** Room on the node for a VM to grow from `from` to `to`: the memory and disk it adds, within the reserves, and cores within the node's (061). */
  async #resizeRoom(api: Proxmox, storage: string | null, from: MachineSize, to: MachineSize, pending: readonly Pending[], signal?: AbortSignal): Promise<Capacity> {
    const [node, disk] = await Promise.all([api.nodeStatus(signal), storage ? api.storageStatus(storage, signal) : Promise.resolve(null)]);
    const reserve = this.#config.reserve;
    const memoryTotal = Math.floor(node.memoryTotal / MiB);
    const memoryUsed = memoryTotal - Math.floor(node.memoryAvailable / MiB) + pending.reduce((sum, other) => sum + other.size.memoryMiB, 0);
    const memoryFree = memoryTotal - memoryUsed;
    const limits: Limit[] = [{ resource: "memory", used: memoryUsed, total: memoryTotal, reserve: reserve.memoryMiB, unit: "MiB" }];
    const problems: string[] = [];
    if (node.cpus !== null && to.cores > node.cpus) problems.push(`${api.node} has ${node.cpus} CPU threads, fewer than the ${to.cores} cores asked for. Ask for at most ${node.cpus} cores.`);
    const memory = to.memoryMiB - from.memoryMiB;
    if (memory > 0 && memoryFree - memory < reserve.memoryMiB) {
      problems.push(
        memory > memoryFree
          ? `${api.node} has ${formatMiB(Math.max(0, memoryFree))} of memory free, less than the ${formatMiB(memory)} more the box needs. Release a box or ask for less memory.`
          : `${api.node} has ${formatMiB(memoryFree)} of memory free and keeps ${formatMiB(reserve.memoryMiB)} free, so the ${formatMiB(memory)} more the box needs does not fit. ` +
              `Release a box, ask for less memory, or lower the memory kept free in ${PRODUCT}'s settings.`,
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
            : `${storageFree} and keeps ${reserve.diskGiB} GiB free, so ${grow} GiB more disk does not fit. Ask for a smaller disk, release boxes, or lower the disk kept free in ${PRODUCT}'s settings.`,
        );
      }
    }
    const ok = problems.length === 0;
    return { ok, message: ok ? null : problems[0]!, warm: null, hosts: [{ host: api.node, ok, limits }] };
  }

  /** A stop hibernates the VM to disk, which frees its memory, and a start resumes it. */
  keepsSession(): boolean {
    return true;
  }

  /** Hibernates the VM, so a start resumes Windows' session as it was, with its apps open (039). */
  async stop(guest: Guest, signal?: AbortSignal): Promise<void> {
    const vmid = this.#vmid(guest);
    const api = await this.client();
    const status = (await this.#still(api, guest, signal)) ? await api.status(vmid, signal) : null;
    if (!status) throw gone(vmid);
    await this.#forget(vmid);
    if (status.status === "running") await api.hibernate(vmid, signal);
  }

  /**
   * This install's guests, from the pool listing, but not warm VMs, which
   * are the pool's. Only a guest not yet tagged costs a config read.
   */
  async held(signal?: AbortSignal): Promise<HeldGuest[]> {
    const api = await this.client();
    const held: HeldGuest[] = [];
    for (const guest of await api.listPool(this.#config.proxmox.pool, signal)) {
      if (guest.type !== "qemu" || guest.template || !this.#inRange(guest.vmid) || this.#reserved.has(guest.vmid)) continue;
      if (isHeldCopy(guest.tags) || isEarlierGuest(guest.tags)) continue;
      if (this.#filling.has(guest.vmid) || guest.tags.includes(WARM)) continue;
      // An image box (054) is no box's, and goes with its refresh.
      if (this.#imageBoxes.has(guest.vmid) || guest.tags.includes(IMAGE_BOX) || guest.tags.some((tag) => tag.startsWith(IMAGE_TAG))) continue;
      let install = installFromTags(guest.tags);
      let owner = ownerFromTags(guest.tags, guest.name || null);
      if (!guest.tags.includes(TAG) || !owner) {
        const config = await api.config(guest.vmid, signal).catch((): Record<string, unknown> => ({}));
        install ??= installFromDescription(config.description);
        owner ??= ownerFromDescription(config.description);
      }
      if (install !== this.#context.installId) continue;
      if (guest.name === copyName(guest.vmid)) owner = null;
      const found = this.#guest(guest.node || api.node, guest.vmid, templateFromTags(guest.tags), owner?.boxId ?? null, guest.size);
      held.push({ ...found, owner, power: powerOf(guest.status), ...(guest.tags.includes(START_TAG) ? { settling: true } : {}) });
    }
    return held;
  }

  /** Records a box's new owner and name on its VM (036). Windows keeps its computer name. */
  async relabel(guest: Guest, box: BoxIdentity, _from: string, signal?: AbortSignal): Promise<void> {
    const api = await this.client();
    const vmid = this.#vmid(guest);
    const installId = this.#context.installId;
    const tags = parseTags((await api.config(vmid, signal)).tags);
    const template = templateFromTags(tags);
    await api.configure(vmid, { name: box.name, description: describe(box, installId) }, signal);
    // A spare's low CPU weight goes back as a box takes it (#888).
    await api.configure(vmid, { tags: withStartTag(boxTags(box, installId, template), tags.includes(START_TAG)) }, signal);
    await this.#settle(api, vmid, signal);
    if (isLinuxVmKind(this.#kindOf(template).id) && (await api.status(vmid, signal))?.status === "running") await this.#nameLinux(vmid, box.name, signal);
  }

  /** Puts back the CPU weight a box's VM had lowered while it started, as the sweep asks for a ready box (#888). */
  async settle(guest: Guest, signal?: AbortSignal): Promise<void> {
    await settle(await this.client(), this.#vmid(guest), signal);
  }

  async transports(guest: Guest): Promise<BoxTransports> {
    const vmid = this.#vmid(guest);
    const kind = this.#kindOf(guest.data?.template);
    const os = kind.capabilities.os;
    const command = await this.#command(vmid, os);
    if (os === "linux") {
      const access = this.#access(vmid);
      // A desktop's own VNC server and Selkies, as in Proxmox LXC's CPU desktops.
      const displays = kind.capabilities.displays.map(
        (display): Display =>
          display.protocol === "selkies"
            ? selkiesDisplay((port) => command.route(port))
            : {
                ...display,
                label: "Desktop",
                open: async (signal) => {
                  const read = await command.run(`cat ${LINUX_VNC_PASSWORD_FILE} 2>/dev/null || :`, { timeoutMs: 15_000, signal, maxOutputBytes: 1024 });
                  if (read.exitCode !== 0) throw new Error(`Cannot read the desktop's VNC password over SSH: ${read.stderr.trim() || `exit code ${read.exitCode}`}.`);
                  const password = read.stdout.trim();
                  return { route: { type: "tcp", host: access.host, port: LINUX_VNC_PORT }, auth: password ? { type: "vnc-password", password } : { type: "none" } };
                },
                minSize: MIN_DESKTOP,
              },
      );
      return { command, displays, access: { ssh: access, dockerHost: `ssh://${access.user}@${access.host}` } };
    }
    const desktop: Display = {
      ...KIND.capabilities.displays[0]!,
      label: "Desktop",
      open: (signal) => this.#console(vmid, signal),
      resize: (size, signal) => this.#resize(vmid, command, size, signal),
      // QEMU's VNC shows the pointer Windows draws once a mouse has moved: out while a person in control watches it.
      pointer: (shown, signal) => windowsPointer(command, shown, signal),
      pointerWhile: "rfb",
      // QEMU passes a viewer's size on to the display driver, which offers it as a mode if it is at least 640x480.
      minSize: MIN_DESKTOP,
    };
    const template = guest.data?.template;
    const streams = typeof template === "number" ? await this.#streams(template) : null;
    if (!streams?.has) return { command, displays: [desktop], access: { ssh: this.#access(vmid), dockerHost: null } };
    const { ssh } = await this.#keys();
    const video: Display = {
      ...WINDOWS_VIDEO,
      ...(streams.cursor ? { cursor: "stream" as const } : {}),
      label: "Desktop, as video",
      open: async () => ({ route: ssh.commandRoute(this.#access(vmid), WINDOWS_STREAM), auth: { type: "none" } }),
    };
    // QEMU types a person's keys by key on a US layout: a character it would type wrong goes to bb-box-stream.
    const stream: OpenStream = (signal) => openRoute(ssh.commandRoute(this.#access(vmid), WINDOWS_STREAM), signal);
    const typing: Display = {
      ...desktop,
      open: async (signal) => ({
        ...(await this.#console(vmid, signal)),
        input: async () => windowsCharacterInput(stream),
        inputTakes: "characters" as const,
        typesAsCharacter: windowsTypesAsCharacter,
        keyDelayMs: QEMU_KEY_DELAY_MS,
      }),
    };
    return { command, displays: [typing, video], access: { ssh: this.#access(vmid), dockerHost: null } };
  }

  /**
   * Whether a Windows template's image has bb-box-stream, as its record lists OpenH264, and the hardware cursor, as it
   * lists that too. Kept a minute.
   */
  async #streams(template: number): Promise<{ readonly has: boolean; readonly cursor: boolean }> {
    const known = this.#streaming.get(template);
    if (known && Date.now() - known.at < STREAM_CHECK_MS) return known;
    const config = await (await this.client()).config(template).catch(() => null);
    const tools = config ? (recordInDescription(String(config.description ?? ""))?.tools ?? {}) : null;
    const has = tools ? tools.openh264 !== undefined : (known?.has ?? false);
    const cursor = tools ? has && tools[WINDOWS_HARDWARE_CURSOR] !== undefined : (known?.cursor ?? false);
    const now = { has, cursor, at: Date.now() };
    this.#streaming.set(template, now);
    return now;
  }

  /**
   * The VM's console, through a VNC proxy of the API's own. Its WebSocket is
   * on the API, so it takes the API's token and trusts the API's certificate
   * as the API calls do; the `cert` in the proxy's answer is another one.
   */
  async #console(vmid: number, signal?: AbortSignal): ReturnType<Display["open"]> {
    const api = await this.client();
    const proxy = await api.vncProxy(vmid, signal).catch((error: unknown) => {
      // The viewer shows only 123 bytes of the reason.
      if (error instanceof ProxmoxError && error.forbidden) throw new Error("The Proxmox token lacks VM.Console. Run setup-token.sh again to add it.");
      throw error;
    });
    const { tlsFingerprint, caCertificate } = this.#config.proxmox;
    const trust = tlsFingerprint ? { fingerprint: tlsFingerprint } : caCertificate ? { ca: caCertificate } : {};
    return {
      route: { type: "websocket", ...api.vncWebSocket(vmid, proxy), protocols: ["binary"], ...trust },
      auth: { type: "vnc-password", password: proxy.password },
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
    const templateCheck = (template: number): Check => [`template.${template}`, this.#templateName(template)];
    const later = [NODE, MEMORY, POOL, ...this.#allTemplates().map(templateCheck), BRIDGE, VMIDS, SNAPSHOTS];
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
          ? `Check the API token ID and secret in ${PRODUCT}'s settings.`
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
        fail(NODE, message(error), `Set the node in ${PRODUCT}'s settings to one the API lists.`);
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
      const pins = (this.#context.images?.pins("windows") ?? Promise.resolve(null)).catch(() => null);
      const linux = this.#config.linuxTemplates.length + this.#config.linuxDesktopTemplates.length > 0;
      const linuxPins = this.#config.linuxTemplates.length ? (this.#context.images?.pins("linux") ?? Promise.resolve(null)).catch(() => null) : Promise.resolve(null);
      const desktopPins = this.#config.linuxDesktopTemplates.length ? (this.#context.images?.pins("linux-desktop") ?? Promise.resolve(null)).catch(() => null) : Promise.resolve(null);
      const android = this.#config.androidTemplates.length > 0;
      const androidPins = android ? (this.#context.images?.pins("android") ?? Promise.resolve(null)).catch(() => null) : Promise.resolve(null);
      const bbApp = linux || android ? (this.#context.images?.bbApp(signal) ?? Promise.resolve(null)).catch(() => null) : Promise.resolve(null);
      const chromeAmd = linux ? (this.#context.images?.chrome?.("x86_64") ?? Promise.resolve(null)).catch(() => null) : Promise.resolve(null);
      for (const template of this.#allTemplates()) {
        const name = templateCheck(template);
        const os = this.#osOf(template);
        try {
          const config = await api.config(template, signal);
          const disk = bootDisk(config);
          const storage = disk ? String(config[disk]).split(":")[0] : "";
          if (!isTemplate(config)) {
            fail(name, `VM ${template} is not a template.`, "Build the template with setup/proxmox-qemu/build.sh, which converts it.");
          } else if (!disk || !storage) {
            fail(name, `VM template ${template} has no boot disk.`, "Rebuild the template with setup/proxmox-qemu/build.sh.");
          } else {
            const free = await api.storageStatus(storage, signal).catch((error: unknown) => error);
            if (free instanceof Error) {
              fail(name, `VM template ${template} is on ${storage}, whose free space cannot be read.`, audit(free, `Give the token Datastore.Audit on /storage/${storage}.`));
            } else {
              this.#templates.set(template, { storage, bootDisk: disk, diskGiB: rootDiskGiB(config, disk) });
              templateStorages.push({ name: storage, type: (free as StorageStatus).type, volume: String(config[disk]) });
              const freeGiB = Math.floor((free as { available: number }).available / GiB);
              const kind = this.#kindOf(template);
              pass(name, `VM template ${template} on ${storage}, ${freeGiB} GiB free.`);
              if (kind === ANDROID_IMAGE_KIND) this.#androidDisk(template, storage, freeGiB, { pass, warn });
              // A Windows image carries no build of BB's app: BB's installer puts it in as a box joins BB. A Linux one does (057).
              const recorded = recordInDescription(String(config.description ?? ""));
              const judged = judgeImage(
                recorded,
                kind === ANDROID_IMAGE_KIND
                  ? { os: "android", pins: await androidPins, bbApp: await bbApp }
                  : os === "linux"
                  ? { os, pins: await (kind === LINUX_DESKTOP_KIND ? desktopPins : linuxPins), bbApp: await bbApp, pinChrome: recorded?.arch === "arm64" ? null : await chromeAmd }
                  : { os, pins: await pins, bbApp: null, joins: this.#config.enrol },
                `Rebuild it with the setup guide's setup/proxmox-qemu/build.sh, as root on ${node}: build.sh ${this.#buildWord(template)} ${template} --replace.`,
              );
              checks.push({ id: `template.${template}.image`, name: `Image of ${name[1]}`, ...judged });
            }
          }
        } catch (error) {
          const missing = error instanceof ProxmoxError && error.gone;
          fail(
            name,
            missing ? `VM ${template} does not exist on ${node}, or is not in pool ${pool}.` : message(error),
            missing
              ? `Build it with setup/proxmox-qemu/build.sh, or remove it from the ${name[1].replace(/ template \d+$/, "")} templates in ${PRODUCT}'s settings.`
              : audit(error, `Give the token VM.Audit and VM.Clone on /vms/${template}.`),
          );
        }
      }

      if (android) {
        if (this.#config.kvm) pass(ANDROID_KVM, "KVM in Linux VM boxes is on, so the host allows nested virtualization, which the Android emulator needs.");
        else
          fail(
            ANDROID_KVM,
            `Android templates are listed, but KVM in Linux VM boxes is off, so ${PRODUCT} takes it that the host does not allow nested virtualization. The Android emulator needs KVM, and the refresh boots its devices.`,
            "Turn on linux-kvm in Proxmox QEMU's settings once build.sh linux says KVM works in a clone; build.sh android stops when it does not.",
          );
      }

      const bridge = this.#config.network.bridge;
      try {
        if (await api.interfaceExists(bridge, signal)) pass(BRIDGE, `${bridge} exists on ${node}.`);
        else fail(BRIDGE, `${node} has no ${bridge}.`, `Create the bridge as the Proxmox LXC setup guide does, or set the bridge in ${PRODUCT}'s settings.`);
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
        // Each refresh's rollback (054, 057): a template in the range, which holds a box's VMID and address until the next refresh.
        const install = installTag(this.#context.installId);
        for (const guest of guests.filter((one) => this.#inRange(one.vmid) && one.tags.includes(install) && one.tags.includes(`${IMAGE_TAG}${ROLLBACK}`))) {
          const target = templateFromTags(guest.tags);
          const os = this.#flavour(LINUX_TEMPLATE_KINDS.find((kind) => guest.tags.includes(`${KIND_TAG}${kind.id}`)) ?? KIND);
          const build = buildFromTags(guest.tags);
          notes.push(
            `VMID ${guest.vmid} is the rollback of ${os} template ${target ?? "unknown"}${build ? `, ${BUILD}${build}` : ""}. It holds a box's VMID and address until the template's next refresh replaces it. To go back to it, list ${guest.vmid} as the ${os} template in ${PRODUCT}'s settings.`,
          );
        }
      } catch (error) {
        fail(VMIDS, message(error), audit(error, `Give the token VM.Audit on /pool/${pool}.`));
      }

      const privileges = await poolPrivileges(api, pool, signal);
      const metadata = await storagesMetadata(api, templateStorages, signal);
      checks.push({ id: SNAPSHOTS[0], name: SNAPSHOTS[1], ...snapshotsCheck({ pool, node, guest: "qemu", privileges, storages: templateStorages, metadata }) });
    }
    notes.unshift(`This install's ID is ${this.#context.installId}. Its VMs carry the tag ${installTag(this.#context.installId)}.`);

    try {
      const keys = await this.#keys();
      if (keys.publicKey) {
        notes.push(`The template must accept this SSH key in C:\\ProgramData\\ssh\\administrators_authorized_keys: ${keys.publicKey}`);
        // build.sh puts BBBOX_SSH_KEY in the template, so a key bb-box made is one it lacks.
        if (keys.generated) {
          warn(
            SSH_KEY_CHECK,
            `${PRODUCT} made a key, which a template from build.sh does not accept; its public key is below.`,
            "Paste BBBOX_SSH_KEY, the key build.sh put in the template, here or in Proxmox LXC's settings. Or add the public key below to the template.",
          );
        } else pass(SSH_KEY_CHECK, `From ${PRODUCT}'s settings; its public key is below.`);
      } else {
        fail(SSH_KEY_CHECK, `ssh-keygen cannot read the SSH private key in ${PRODUCT}'s settings.`, "Paste the whole of BBBOX_SSH_KEY, the private key build.sh put in the template.");
      }
    } catch (error) {
      fail(SSH_KEY_CHECK, message(error), `Check the SSH private key in ${PRODUCT}'s settings: paste the whole of BBBOX_SSH_KEY, the private key build.sh put in the template.`);
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

  maintain(signal?: AbortSignal): Promise<void> {
    return this.#upkeep.run(signal ?? this.#stopping.signal);
  }

  async dispose(): Promise<void> {
    this.#stopping.abort(new Error(`${PRODUCT} is stopping.`));
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
                ? `The Proxmox API lists ${nodes.length} nodes (${nodes.join(", ")}). Set the node in ${PRODUCT}'s settings.`
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

  #proxmox(node: string): Proxmox {
    return new Proxmox({
      apiUrl: this.#config.proxmox.apiUrl,
      tokenId: this.#config.proxmox.tokenId,
      tokenSecret: this.#config.proxmox.tokenSecret,
      node,
      type: "qemu",
      fetch: this.#http.fetch,
      sleep: this.#options.sleep,
    });
  }

  /** A client for calls that name no node. */
  #bare(): Proxmox {
    return this.#proxmox(this.#config.proxmox.node ?? "");
  }

  #offer(kind: string): void {
    if (!this.kinds().some((offered) => offered.id === kind)) throw new BackendError("unsupported", `${this.label} has no ${kind} boxes.`);
  }

  #inRange(vmid: number): boolean {
    return Number.isInteger(vmid) && vmid >= this.#config.vmids.first && vmid <= this.#config.vmids.last;
  }

  #vmid(guest: Guest): number {
    const vmid = Number(guest.ref);
    if (!this.#inRange(vmid)) throw new Error(`Guest ${guest.ref} is outside ${PRODUCT}'s VMID range, so ${PRODUCT} leaves it alone.`);
    return vmid;
  }

  /** `template` and `box` are kept with the box. */
  #guest(
    node: string,
    vmid: number,
    template: number | null = null,
    box: string | null = null,
    size: MachineSize | null = null,
    build: string | null = null,
    display: { mode: string; reason: string } | null = null,
  ): Guest {
    const guest: Guest = { ref: String(vmid), host: node, address: addressFor(this.#config, vmid), size };
    const data = { ...(template !== null ? { template } : {}), ...(build !== null ? { build } : {}), ...(box !== null ? { box } : {}) };
    // A Linux desktop's display mode and why, as Proxmox LXC's desktops show them.
    const facts = display
      ? [{ label: "Display mode", value: display.mode === "cpu" ? "CPU" : display.mode }, ...(display.reason ? [{ label: "Display reason", value: displayReason(display.reason) }] : [])]
      : [];
    return Object.keys(data).length ? { ...guest, data, ...(facts.length ? { facts } : {}) } : guest;
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

  footprint(): Footprint {
    return proxmoxFootprint(this.#config);
  }

  /** A guest of a Windows template listed now, from that template's build as it is now. */
  async asOffered(guest: Guest, kind: string, createdAt: number, signal?: AbortSignal): Promise<boolean> {
    const template = guest.data?.template;
    if (typeof template !== "number" || !this.#allTemplates().includes(template)) return false;
    if (kind === ANDROID_IMAGE_KIND.id && !this.#androidDevices?.offer) return false;
    return fromBuild(guest, await templateBuild(await this.client(), [], template, signal), createdAt);
  }

  /** Whether a guest comes from the build its template has now: false once a refresh has replaced it, or the template is no longer listed; null when the guest or template records no build. */
  async fromCurrentBuild(guest: Guest, _kind: string, signal?: AbortSignal): Promise<boolean | null> {
    const template = guest.data?.template;
    if (typeof template !== "number") return null;
    if (!this.#allTemplates().includes(template)) return false;
    const current = await templateBuild(await this.client(), [], template, signal);
    if (current === undefined) return false;
    const recorded = guest.data?.build;
    return current && typeof recorded === "string" ? recorded === current : null;
  }

  /** Whether the guest at the reference is still `guest` (018): it names this install and the box in `guest.data.box`, or no box when that is absent. */
  async #still(api: Proxmox, guest: Guest, signal?: AbortSignal): Promise<boolean> {
    const config = await this.#guestConfig(api, this.#vmid(guest), signal);
    if (!config) return false;
    const names = namesOf(config);
    const box = typeof guest.data?.box === "string" ? guest.data.box : null;
    return names.install === this.#context.installId && names.box === box;
  }

  /** Whether the guest at `vmid` names the box. Box IDs are unique, so no other install's guest does. */
  async #owns(api: Proxmox, vmid: number, boxId: string, signal?: AbortSignal): Promise<boolean> {
    const config = await this.#guestConfig(api, vmid, signal);
    return !!config && namesOf(config).box === boxId;
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
    const used = new Set<number>([...this.#reserved, ...guests.map((guest) => guest.vmid)]);
    let free = 0;
    for (let vmid = first; vmid <= last; vmid++) if (!used.has(vmid)) free++;
    return free;
  }

  #freeVmid(guests: readonly PoolGuest[], from = this.#config.vmids.first): number | null {
    const { first, last } = this.#config.vmids;
    const count = last - first + 1;
    const used = new Set<number>([...this.#reserved, ...guests.map((guest) => guest.vmid)]);
    for (let step = 0; step < count; step++) {
      const vmid = first + ((from - first + step) % count);
      if (!used.has(vmid)) return vmid;
    }
    return null;
  }

  /** Config for a fresh clone at `vmid`, whose config is `current`. */
  /** settle() for an acquire: a weight not put back now is put back by the sweep, so the box is ready either way. */
  async #settle(api: Proxmox, vmid: number, signal?: AbortSignal): Promise<void> {
    await settle(api, vmid, signal).catch((error: unknown) => this.#context.logError("put a new box's CPU weight back", error instanceof Error ? error : new Error(String(error))));
  }

  #settings(size: MachineSize, vmid: number, current: Record<string, unknown>): GuestSettings {
    const address = addressFor(this.#config, vmid);
    if (!address) throw new Error(`VMID ${vmid} is outside the box range.`);
    const { bridge, prefix, gateway } = this.#config.network;
    return {
      cores: size.cores,
      memory: size.memoryMiB,
      net0: net0On(current.net0, bridge),
      smbios1: smbios1For(address, prefix, gateway),
      onboot: true,
      // Templates are protected against deletion, and clones inherit it.
      delete: ["protection"],
    };
  }

  /**
   * Grows the boot disk to `wanted` GiB when the clone's is smaller. A null
   * size keeps the template's. Proxmox cannot shrink disks, so a smaller size
   * keeps the template's too. True when it grew.
   */
  async #grow(api: Proxmox, vmid: number, config: Record<string, unknown>, wanted: number | null, step: Step, signal?: AbortSignal): Promise<boolean> {
    if (wanted === null) return false;
    const disk = bootDisk(config);
    if (!disk) throw new Error(`VM ${vmid} has no boot disk to grow to ${wanted} GiB.`);
    const current = rootDiskGiB(config, disk);
    if (current !== null && current >= wanted) return false;
    return step("resize", () => api.growRootDisk(vmid, wanted, signal, disk));
  }

  /** Extends C: over the space its disk grew by. */
  async #extend(vmid: number, signal?: AbortSignal): Promise<void> {
    await extendC(await this.#command(vmid), signal);
  }

  /**
   * Compiles the display helper in the background while the box is new, so
   * its first resize is as quick as the rest. A failure is left to the first
   * resize, which compiles it again.
   */
  #compileDisplay(vmid: number): void {
    const compiling = this.#command(vmid)
      .then((command) => compileDisplay(command))
      .catch(() => undefined)
      .finally(() => this.#compiling.delete(vmid));
    this.#compiling.set(vmid, compiling);
  }

  /**
   * Sets the desktop to `size`, or to the listed mode that best covers it,
   * through Windows itself (021), as the display driver does not switch to
   * a viewer's size.
   */
  async #resize(vmid: number, command: SshTransport, size: DisplaySize, signal?: AbortSignal): Promise<void> {
    await this.#compiling.get(vmid);
    await setMode(command, size, signal);
  }

  async #templateOf(api: Proxmox, template: number, signal?: AbortSignal): Promise<TemplateInfo> {
    const cached = this.#templates.get(template);
    if (cached) return cached;
    let config: Record<string, unknown>;
    try {
      config = await api.config(template, signal);
    } catch (error) {
      if (error instanceof ProxmoxError && error.gone) {
        throw new Error(`${this.#templateName(template)} does not exist on ${api.node}, or is not in pool ${this.#config.proxmox.pool}. Run the doctor check in ${PRODUCT}'s panel.`);
      }
      throw error;
    }
    const disk = bootDisk(config);
    const storage = disk ? String(config[disk]).split(":")[0] : "";
    if (!disk || !storage) throw new Error(`${this.#templateName(template)} has no boot disk.`);
    const found = { storage, bootDisk: disk, diskGiB: rootDiskGiB(config, disk) };
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

  /** Waits for `template` until `deadline`: "there" when it was there at once, "back" when it came back, "away" when it was still away. */
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
   * Linked-clones `template` into the next free VMID, round-robin, as the
   * Proxmox LXC backend does. `before` runs before each attempt. A VMID
   * another guest has taken is skipped. When the clone fails while the
   * template is away, it waits for the template, tells `waited` how long,
   * and tries again on the next VMID.
   */
  async #clone(
    api: Proxmox,
    guests: readonly PoolGuest[],
    template: number,
    name: string,
    description: string,
    before: (vmid: number) => Promise<void>,
    signal: AbortSignal,
    waited: (ms: number) => void,
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
          `Every VMID from ${this.#config.vmids.first} to ${this.#config.vmids.last} is in use. Release a box, or widen the VMID range in ${PRODUCT}'s settings.`,
        );
      }
      this.#reserved.add(vmid);
      this.#nextVmid = vmid === this.#config.vmids.last ? this.#config.vmids.first : vmid + 1;
      try {
        await this.#context.storage.set(NEXT_VMID, this.#nextVmid);
        await before(vmid);
        await api.cloneLinked({ template, vmid, hostname: name, pool: this.#config.proxmox.pool, description }, signal);
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
            `${this.#templateName(template)} on ${api.node} was still missing, or not yet a template, after ${Math.round(this.#templateWaitMs / 1000)} s ` +
              `(${message(error)}). Run the doctor check in ${PRODUCT}'s panel.`,
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

  async #nameLinux(vmid: number, name: string, signal?: AbortSignal): Promise<void> {
    try {
      const result = await (await this.#command(vmid, "linux")).run(vmNameScript(name), { timeoutMs: 15_000, signal, maxOutputBytes: 4096 });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `exit code ${result.exitCode}`);
    } catch (error) {
      signal?.throwIfAborted();
      const why = error instanceof Error ? error.message : String(error);
      this.#context.logError("name the box", new Error(`Naming box ${name} inside failed, so it may keep its template's hostname until it next starts: ${why}`));
    }
  }

  async #command(vmid: number, os: GuestOs = "windows"): Promise<SshTransport> {
    return new SshTransport((await this.#keys()).ssh, this.#access(vmid), os);
  }

  /** Closes the shared SSH connection to a guest that is going, as another guest may take its address. */
  async #forget(vmid: number): Promise<void> {
    try {
      const keys = await this.#ssh;
      await keys?.ssh.forget(this.#access(vmid));
    } catch (error) {
      this.#context.logError("ssh", error);
    }
  }

  /** Waits for a Linux desktop's display service to say its mode, as Proxmox LXC's desktops do. */
  async #linuxDisplay(vmid: number, timeoutMs: number, signal?: AbortSignal): Promise<{ mode: string; reason: string }> {
    const deadline = Date.now() + timeoutMs;
    const command = await this.#command(vmid, "linux");
    const sleep = this.#options.sleep ?? pause;
    for (;;) {
      const result = await command.run(`cat ${LINUX_DISPLAY_MODE_FILE} 2>/dev/null && cat ${LINUX_DISPLAY_REASON_FILE} 2>/dev/null; :`, { timeoutMs: 15_000, signal, maxOutputBytes: 4096 });
      const [mode = "", reason = ""] = result.stdout.split("\n").map((line) => line.trim());
      if (mode) return { mode, reason };
      if (Date.now() >= deadline) {
        throw new Error(`The box's desktop did not start: ${LINUX_DISPLAY_MODE_FILE} is missing after ${Math.round(timeoutMs / 1000)} s. Check bb-box-display.service in the Linux desktop template.`);
      }
      await sleep(200, signal);
    }
  }

  async #setLinuxClock(vmid: number, signal?: AbortSignal): Promise<void> {
    const result = await (await this.#command(vmid, "linux")).run(`sudo -n date -u -s @${(Date.now() / 1000).toFixed(3)} >/dev/null`, { timeoutMs: 15_000, signal, maxOutputBytes: 4096 });
    if (result.exitCode !== 0) throw new Error(`Linux could not set its clock: ${result.stderr.trim() || `exit code ${result.exitCode}.`}`);
  }

  /** Sets Windows' clock from BB's server's. */
  async #setClock(vmid: number, signal?: AbortSignal): Promise<void> {
    await setClock(await this.#command(vmid), signal);
  }

  /** Waits for port 22 to open, which is cheap to poll, then for SSH to answer. */
  async #waitReady(vmid: number, timeoutMs: number, signal?: AbortSignal, step: Step = untimed, os: GuestOs = "windows"): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const { host, port, user } = this.#access(vmid);
    const sleep = this.#options.sleep;
    const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;
    const open = await step("network", () => waitForPort(host, port, { timeoutMs, check: this.#options.portCheck, signal, sleep }));
    if (!open) {
      throw new Error(
        `Nothing answered on port ${port} of ${host} within ${seconds(timeoutMs)}. ` +
          (os === "linux"
            ? "Check that BB's server can reach the boxes' subnet, and how the template set the box's address, in journalctl -u bb-box-boot from the VM's console in Proxmox."
            : `Check that BB's server can reach the boxes' subnet, and how boot.ps1 set the box's address in ${BOOT_LOG}, from the VM's console in Proxmox.`),
      );
    }
    const left = Math.max(1_000, deadline - Date.now());
    const command = await this.#command(vmid, os);
    // Through the shared connection, which the box's first commands then use.
    const answers = { probe: (signal?: AbortSignal) => command.answers(signal) };
    const ready = await step("ssh", () => waitUntilAnswers(answers, { timeoutMs: left, intervalMs: 100, signal, sleep }));
    if (!ready) {
      throw new Error(
        `Port ${port} of ${host} is open, but SSH as ${user} did not answer within ${seconds(left)}. ` +
          (os === "linux"
            ? `Check that the template accepts ${PRODUCT}'s key in ~${user}/.ssh/authorized_keys.`
            : `Check that the template accepts ${PRODUCT}'s key in C:\\ProgramData\\ssh\\administrators_authorized_keys.`),
      );
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

  /** Warm VMs to keep: the kind's count, or none while no template is listed. */
  #warmTarget(): number {
    return this.#config.templates.length ? this.#context.warm(KIND.id) : 0;
  }

  /** Whether `guest` is one of this install's warm VMs that no fill, claim or delete here is using. */
  #isWarm(guest: PoolGuest): boolean {
    if (guest.type !== "qemu" || guest.template || !this.#inRange(guest.vmid) || !guest.tags.includes(WARM)) return false;
    if (installFromTags(guest.tags) !== this.#context.installId) return false;
    return !this.#filling.has(guest.vmid) && !this.#claimed.has(guest.vmid) && !this.#retiring.has(guest.vmid);
  }

  /**
   * The warm VMs in `guests` that a claim can take: hibernated, so stopped,
   * at the kind's default size, and from the current build of a template
   * that is listed in the settings.
   */
  async #ready(api: Proxmox, guests: readonly PoolGuest[], signal?: AbortSignal): Promise<WarmVm[]> {
    const wanted = this.#context.kind(KIND.id).defaultSize;
    const builds = new Map<number, string | null | undefined>();
    const ready: WarmVm[] = [];
    for (const guest of guests) {
      if (!this.#isWarm(guest) || guest.status !== "stopped" || !guest.size) continue;
      if (guest.size.cores !== wanted.cores || guest.size.memoryMiB !== wanted.memoryMiB) continue;
      const template = templateFromTags(guest.tags);
      if (template === null || !this.#config.templates.includes(template)) continue;
      if (!builds.has(template)) builds.set(template, await templateBuild(api, guests, template, signal));
      // A template that is away, as while build.sh --replace swaps it, has no build to compare.
      const build = builds.get(template);
      if (build === undefined || build !== buildFromTags(guest.tags)) continue;
      ready.push({ guest, template, build, size: guest.size });
    }
    return ready;
  }

  /** The ready warm VMs, as the shared ready pool sees them. */
  async #members(signal?: AbortSignal): Promise<PoolMember[]> {
    const api = await this.client();
    const ready = await this.#ready(api, await api.listPool(this.#config.proxmox.pool, signal), signal);
    this.#listed.clear();
    for (const warm of ready) this.#listed.set(String(warm.guest.vmid), warm);
    return ready.map(({ guest }) => ({ ref: String(guest.vmid), host: guest.node || api.node, kinds: [KIND.id], state: "free", reason: null, since: 0, generation: 0 }));
  }

  /** Tops up the warm pool in the background after a warm VM is claimed. */
  #kick(): void {
    if (this.#warmTarget() === 0) return;
    this.maintain(this.#stopping.signal).catch((error) => this.#context.logError("warm pool", error));
  }

  /** Deletes the warm VMs that cannot serve or are beyond the count, then fills the pool to the count, one VM at a time. */
  async #topUp(signal: AbortSignal): Promise<void> {
    const api = await this.client();
    const pool = this.#config.proxmox.pool;
    // Chosen while no claim runs, and marked here until they are gone, as
    // Proxmox cannot retag a hibernated VM.
    const retired = await this.#warm.exclusive(async () => {
      const guests = await api.listPool(pool, signal);
      const kept = new Set((await this.#ready(api, guests, signal)).slice(0, this.#warmTarget()).map((warm) => warm.guest.vmid));
      const out = guests.filter((guest) => this.#isWarm(guest) && !kept.has(guest.vmid)).map((guest) => guest.vmid);
      for (const vmid of out) this.#retiring.add(vmid);
      return out;
    });
    for (const vmid of retired) {
      try {
        await this.#forget(vmid);
        await api.destroy(vmid, signal);
      } catch (error) {
        this.#context.logError("retire a warm box", error);
      } finally {
        this.#retiring.delete(vmid);
      }
    }

    const target = this.#warmTarget();
    if (target === 0) {
      this.#context.warmShortfalls([]);
      return;
    }
    const size = this.#context.kind(KIND.id).defaultSize;
    const guests = await api.listPool(pool, signal);
    const ready = (await this.#ready(api, guests, signal)).length;
    for (let missing = target - ready; missing > 0; missing--) {
      signal.throwIfAborted();
      const room = await this.#room(api, size, await api.listPool(pool, signal), [], { ready, target }, false, signal);
      if (!room.ok) {
        this.#context.warmShortfalls([{ kinds: [KIND.id], count: target, have: target - missing, reason: room.message ?? "No host has room for a warm box." }]);
        return;
      }
      await this.#fill(api, size, signal);
    }
    this.#context.warmShortfalls([]);
  }

  /**
   * Makes a warm VM at `size`: a clone, started, with the display helper
   * compiled, and hibernated once Windows' desktop is up. It is tagged warm
   * just before, as Proxmox refuses tags after.
   */
  async #fill(api: Proxmox, size: MachineSize, signal: AbortSignal): Promise<void> {
    const install = installTag(this.#context.installId);
    let vmid: number | null = null;
    const claimed: number[] = [];
    try {
      const guests = await api.listPool(this.#config.proxmox.pool, signal);
      const template = this.#choose(guests);
      // Read before the clone, so it is never newer than the clone's build. A
      // template replaced in between retires the VM later, which is safe.
      const build = await templateBuild(api, guests, template, signal);
      const tags = (state: string) => [TAG, install, state, templateTag(template), ...(build ? [`${BUILD}${build}`] : [])];
      const description = `bb-box warm ${KIND.id}\ninstall ${this.#context.installId}`;
      const before = async (id: number) => {
        this.#filling.set(id, template);
        claimed.push(id);
      };
      vmid = await this.#clone(api, guests, template, WARM_NAME, description, before, signal, () => {});
      const id = vmid;
      const config = await api.config(id, signal);
      // Off at the node's boot, as a warm VM that runs is deleted. A low CPU weight until a box takes it and it is ready (#888).
      const low = startsLow(config);
      await api.configure(id, { ...this.#settings(size, id, config), onboot: false, ...(low ? LOW : {}) }, signal);
      await api.configure(id, { tags: withStartTag(tags(FILLING), low) }, signal);
      const grew = await this.#grow(api, id, config, size.diskGiB, untimed, signal);
      await api.start(id, signal);
      const deadline = Date.now() + (this.#options.readyTimeoutMs ?? READY_TIMEOUT_MS);
      await this.#waitReady(id, Math.max(1_000, deadline - Date.now()), signal);
      if (grew) await this.#extend(id, signal);
      await this.#desktopUp(id, Math.max(1_000, deadline - Date.now()), signal);
      await compileDisplay(await this.#command(id), signal);
      await api.configure(id, { tags: withStartTag(tags(WARM), low) }, signal);
      await this.#forget(id);
      await api.hibernate(id, signal);
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

  /** The configured templates, as standard images, and this install's captured builds and image boxes. */
  async #imageList(signal?: AbortSignal): Promise<{ builds: ImageBuild[]; boxes: string[] }> {
    const api = await this.client();
    const install = installTag(this.#context.installId);
    const builds: ImageBuild[] = [];
    for (const vmid of this.#allTemplates()) {
      const config = await api.config(vmid, signal).catch(() => null);
      if (config && isTemplate(config)) builds.push(this.#imageBuild(vmid, this.#kindOf(vmid).id, "standard", config, true));
    }
    const boxes: string[] = [];
    for (const guest of await api.listPool(this.#config.proxmox.pool, signal)) {
      if (guest.type !== "qemu" || !this.#inRange(guest.vmid) || !guest.tags.includes(install)) continue;
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

  /**
   * A clone of a build's template, started as a box of its kind is, with a
   * Windows box's desktop up, tagged so that no sweep takes it.
   */
  async #imageBox(build: ImageBuild, label: string, signal: AbortSignal): Promise<ImageBox> {
    const api = await this.client();
    const template = Number(build.ref);
    const kind = LINUX_TEMPLATE_KINDS.find((linux) => linux.id === build.kind) ?? KIND;
    const os = kind.capabilities.os;
    let vmid: number | null = null;
    // Each step's time, for the build's check that a box of it answers as quickly as one of the old.
    const steps: { name: string; ms: number }[] = [];
    const step = timed((name, ms) => steps.push({ name, ms }));
    try {
      const guests = await api.listPool(this.#config.proxmox.pool, signal);
      const description = `bb-box image box: ${label}\ninstall ${this.#context.installId}`;
      vmid = await step("clone", () => this.#clone(api, guests, template, IMAGE_HOSTNAME, description, async (id) => void this.#imageBoxes.add(id), signal, () => {}));
      const id = vmid;
      await step("configure", async () => {
        await api.configure(id, this.#settings(this.#context.kind(kind.id).defaultSize, id, await api.config(id, signal)), signal);
        await api.configure(id, { tags: [TAG, installTag(this.#context.installId), IMAGE_BOX, templateTag(template)] }, signal);
      });
      await step("start", () => api.start(id, signal));
      const timeoutMs = this.#options.readyTimeoutMs ?? kind.readyTimeoutMs;
      await this.#waitReady(id, timeoutMs, signal, step, os);
      if (os === "windows") {
        await step("clock", () => this.#setClock(id, signal));
        // The kind's check runs in the desktop session, which comes up soon after SSH.
        await step("desktop", () => this.#desktopUp(id, timeoutMs, signal));
      } else if (kind.capabilities.displays.length) {
        // As does a Linux desktop's check, once its display service is up.
        await step("display", () => this.#linuxDisplay(id, timeoutMs, signal));
      }
      return { ref: String(id), command: await this.#command(id, os), steps };
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
   * (its name, size and network, and an SMBIOS UUID with no address), with
   * its record in the description's second line and the image, kind and
   * build in its tags.
   */
  async #capture(box: ImageBox, from: ImageBuild, image: string, signal: AbortSignal): Promise<ImageBuild> {
    const api = await this.client();
    const vmid = Number(box.ref);
    const linux = LINUX_TEMPLATE_KINDS.some((kind) => kind.id === from.kind);
    // Where the refresh writes the record: finalize.sh's on Linux (049), refresh.ps1's on Windows (054).
    const at = linux ? "/usr/share/bb-box/image.json" : "C:\\bb-box\\image.json";
    const read = await box.command.run(linux ? `cat ${at}` : `Get-Content ${at} -Raw`, { timeoutMs: 15_000, signal, maxOutputBytes: 64 * 1024 });
    const record = read.exitCode === 0 ? recordFromJson(read.stdout.trim()) : null;
    if (!record) throw new Error(`Image box ${vmid} has no image record in ${at}, which the refresh writes.`);
    const source = await api.config(Number(from.ref), signal);
    const build = record.build.startsWith(BUILD) ? record.build : `${BUILD}${record.build}`;
    // Clones start with an empty boot log, as build.sh leaves the template's. finalize.sh empties Linux' logs.
    if (!linux) await box.command.run(`Clear-Content ${BOOT_LOG} -ErrorAction SilentlyContinue`, { timeoutMs: 15_000, signal });
    await this.#forget(vmid);
    await api.shutdown(vmid, 300, signal);
    if (!linux) await this.#freshVariables(api, vmid, signal);
    await api.configure(
      vmid,
      {
        name: typeof source.name === "string" ? source.name : IMAGE_HOSTNAME,
        ...(Number(source.cores) > 0 ? { cores: Number(source.cores) } : {}),
        ...(Number(source.memory) > 0 ? { memory: Number(source.memory) } : {}),
        ...(typeof source.net0 === "string" ? { net0: source.net0 } : {}),
        smbios1: `uuid=${randomUUID()}`,
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
   * Gives a stopped Windows build a new EFI variable store with the same
   * options (060). OVMF writes its console variables again at each boot,
   * and every build boots its box and is captured with what its store
   * gathered, so deleted records pile up from build to build, until the
   * first boot of each box of a build spent 24 s more before Windows. A new
   * store has the same Secure Boot keys; OVMF boots Windows from the disk's
   * \EFI\BOOT\BOOTX64.EFI, and Windows writes its boot entry again. The old
   * store, left unused by the change, goes.
   */
  async #freshVariables(api: Proxmox, vmid: number, signal: AbortSignal): Promise<void> {
    const before = await api.config(vmid, signal);
    if (typeof before.efidisk0 !== "string") return;
    const [volume, ...options] = before.efidisk0.split(",");
    const storage = volume!.split(":")[0];
    await api.configure(vmid, { delete: ["efidisk0"] }, signal);
    await api.configure(vmid, { efidisk0: [`${storage}:1`, ...options.filter((option) => !option.startsWith("size="))].join(",") }, signal);
    const after = await api.config(vmid, signal);
    const unused = Object.keys(after).filter((key) => /^unused\d+$/.test(key) && after[key] === volume);
    if (unused.length) await api.configure(vmid, { delete: unused }, signal);
  }

  /**
   * Puts a captured build in a configured template's place under its VMID,
   * as build.sh --replace does. The old template is first kept as a rollback
   * (054), a template at a free VMID of the range, as rebuilding one from the
   * ISO takes an hour as root on the host. Then the old template goes, the
   * build is cloned into its VMID (linked on LVM-thin, where the clone needs
   * nothing of its origin, else a full copy on the template's storage), made
   * a template with the old one's name and tags but the new build's ID, and
   * the build goes, with the rollback of the replace before. Acquires wait
   * for the template meanwhile, and warm VMs of the old build are retired.
   */
  async #replaceTemplate(build: ImageBuild, current: ImageBuild, signal: AbortSignal): Promise<ImageBuild> {
    if (!current.current || build.current) throw new Error(`Template ${current.ref} is not a configured template, or ${build.ref} is one.`);
    const api = await this.client();
    const [source, target] = [Number(build.ref), Number(current.ref)];
    const old = await api.config(target, signal);
    const disk = bootDisk(old);
    const storage = disk ? (String(old[disk]).split(":")[0] ?? "") : "";
    const os = this.#osOf(target);
    const Os = this.#templateName(target).replace(/ template \d+$/, "");
    if (!storage) throw new Error(`${Os} template ${target} has no boot disk.`);
    const thin = (await api.storageStatus(storage, signal)).type === "lvmthin";
    const name = typeof old.name === "string" ? old.name : `bb-box-${this.#buildWord(target)}`;
    const pool = this.#config.proxmox.pool;
    const install = installTag(this.#context.installId);
    const guests = await api.listPool(pool, signal);
    const earlier = guests
      .filter((guest) => guest.type === "qemu" && this.#inRange(guest.vmid) && !this.#allTemplates().includes(guest.vmid))
      .filter((guest) => guest.tags.includes(install) && guest.tags.includes(`${IMAGE_TAG}${ROLLBACK}`) && templateFromTags(guest.tags) === target)
      .map((guest) => guest.vmid);
    // The old template as it is, at a free VMID, made before anything changes. A VMID taken outside the pool is skipped.
    const oldBuild = buildFromTags(parseTags(old.tags));
    const keptRecord = recordInDescription(String(old.description ?? ""));
    const taken = [...guests];
    let rollback: number;
    let kept: string;
    for (;;) {
      const free = this.#freeVmid(taken, this.#nextVmid ?? this.#config.vmids.first);
      if (free === null) throw new BackendError("no_capacity", `No VMID from ${this.#config.vmids.first} to ${this.#config.vmids.last} is free for the rollback of template ${target}. Release a box first.`);
      kept = `${PRODUCT} rollback of ${Os} template ${target}${oldBuild ? `, ${BUILD}${oldBuild}` : ""}, kept until its next refresh. To use it, list ${free} as the ${Os} template in ${PRODUCT}'s settings.`;
      this.#reserved.add(free);
      try {
        if (thin) await api.cloneLinked({ template: target, vmid: free, hostname: `${name}-rollback`, pool, description: kept }, signal);
        else await api.cloneFull({ template: target, vmid: free, hostname: `${name}-rollback`, storage, pool, description: kept }, signal);
        rollback = free;
        break;
      } catch (error) {
        if (!(error instanceof ProxmoxError && error.alreadyExists)) throw error;
        taken.push({ vmid: free } as PoolGuest);
      } finally {
        this.#reserved.delete(free);
      }
    }
    this.#reserved.add(rollback);
    try {
      await api.makeTemplate(rollback, signal);
      await api.configure(
        rollback,
        {
          description: `${kept}${keptRecord ? `\n${JSON.stringify(keptRecord)}` : ""}`,
          tags: [TAG, install, `${IMAGE_TAG}${ROLLBACK}`, `${KIND_TAG}${current.kind}`, templateTag(target), ...(oldBuild ? [`${BUILD}${oldBuild}`] : [])],
          protection: true,
        },
        signal,
      );
    } finally {
      this.#reserved.delete(rollback);
    }
    const first = String(old.description ?? `bb-box ${os} template.`).split("\n")[0]!;
    const today = new Date().toISOString().slice(0, 10);
    const line = /, (built|refreshed) \d{4}-\d{2}-\d{2}/.test(first) ? first.replace(/, (built|refreshed) \d{4}-\d{2}-\d{2}/, `, refreshed ${today}`) : first;
    const description = `${line}${build.record ? `\n${JSON.stringify(build.record)}` : ""}`;
    const tags = [...parseTags(old.tags).filter((tag) => !tag.startsWith(BUILD)), ...(build.build ? [build.build] : [])];
    // Templates are protected against deletion: the token may clear it in the pool.
    await api.configure(target, { delete: ["protection"] }, signal);
    await api.destroy(target, signal);
    this.#templates.delete(target);
    if (thin) await api.cloneLinked({ template: source, vmid: target, hostname: name, pool, description }, signal);
    else await api.cloneFull({ template: source, vmid: target, hostname: name, storage, pool, description }, signal);
    await api.makeTemplate(target, signal);
    await api.configure(target, { description, tags, protection: true }, signal);
    await api.configure(source, { delete: ["protection"] }, signal);
    await api.destroy(source, signal);
    // The replace worked, so the rollback of the replace before goes.
    for (const vmid of earlier) {
      await api.configure(vmid, { delete: ["protection"] }, signal);
      await api.destroy(vmid, signal);
    }
    return { ...build, ref: String(target), image: "standard", current: true };
  }

  /** Removes an image box or a captured build of this install's, and nothing else. */
  async #removeImage(ref: string, signal?: AbortSignal): Promise<void> {
    const vmid = Number(ref);
    const api = await this.client();
    const config = await this.#guestConfig(api, vmid, signal);
    if (!config) return;
    const tags = parseTags(config.tags);
    const ours = tags.includes(installTag(this.#context.installId)) && (tags.includes(IMAGE_BOX) || tags.some((tag) => tag.startsWith(IMAGE_TAG)));
    if (this.#allTemplates().includes(vmid) || !ours || !this.#inRange(vmid)) throw new Error(`VM ${vmid} is not an image box or build of this install's, so ${PRODUCT} leaves it.`);
    await this.#forget(vmid);
    // A captured build is protected, as templates are.
    if (config.protection) await api.configure(vmid, { delete: ["protection"] }, signal);
    await api.destroy(vmid, signal);
    this.#imageBoxes.delete(vmid);
  }

  /** Waits until Windows' desktop is up. */
  async #desktopUp(vmid: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const command = await this.#command(vmid);
    const up = { probe: (signal?: AbortSignal) => desktopUp(command, signal) };
    if (!(await waitUntilAnswers(up, { timeoutMs, intervalMs: DESKTOP_POLL_MS, signal, sleep: this.#options.sleep }))) {
      throw new Error(
        `Windows' desktop in warm VM ${vmid} was not up within ${Math.round(timeoutMs / 1000)} s: Explorer did not run in a desktop session, ` +
          `or Cua's daemon did not listen on ${CUA_DRIVER.socket}. Check the VM's console in Proxmox, and that the template signs the box user in.`,
      );
    }
  }
}
