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

import { createHash, randomUUID } from "node:crypto";
import { Proxmox, ProxmoxError, parseTags, rootDiskGiB, type FetchLike, type GuestSettings, type PoolGuest } from "../proxmox/api.ts";
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
import { proxmoxFetch } from "../proxmox/tls.ts";
import { ReadyPool } from "../pool.ts";
import {
  BackendError,
  type AcquireHooks,
  type Backend,
  type BackendContext,
  type Footprint,
  type BoxIdentity,
  type BoxKind,
  type BoxSize,
  type BoxTransports,
  type Capacity,
  type ComputerUse,
  type DoctorCheck,
  type DoctorReport,
  type Guest,
  type HeldGuest,
  type Limit,
  type PoolMember,
  type PowerState,
  type ReleaseHooks,
} from "../types.ts";
import { pause, waitForPort, waitUntilAnswers, type PortCheck } from "../../transports/ready.ts";
import { KeyFile, Ssh, SshTransport, generateKeyPair, publicKey } from "../../transports/ssh.ts";
import { desktopScript } from "../../transports/powershell.ts";
import type { Display, DisplaySize, SshAccess } from "../../transports/types.ts";
import type { QemuConfig } from "./config.ts";

const MiB = 2 ** 20;
const GiB = 2 ** 30;
const SSH_KEY = "ssh-key";
/** Where the next VMID search starts. */
const NEXT_VMID = "next-vmid";
/** A linked clone of Windows boots and starts sshd in about 20 s; this leaves room for a busy host. */
const READY_TIMEOUT_MS = 180_000;
/** How long setting the desktop's mode may take, in the desktop session. */
const RESIZE_TIMEOUT_MS = 15_000;
/**
 * The smallest desktop a viewer sets: Windows is hard to use below it. QEMU
 * passes a viewer's size on to the display driver, which offers it as a mode
 * if it is at least 640x480. QEMU answers that it passed the size on, not
 * that it set it, so noVNC does not ask again.
 */
const MIN_DESKTOP = { width: 800, height: 600 };
/** How long setting Windows' clock may take, over SSH. */
const CLOCK_TIMEOUT_MS = 30_000;
/** build.sh --replace swaps the template for its new build, which leaves it missing for a moment. A clone waits this long for it. */
const TEMPLATE_WAIT_MS = 10_000;
const TEMPLATE_POLL_MS = 250;
/** Cua Driver as build.sh pins it (039). A task at logon starts its daemon, elevated, on this named pipe. */
const CUA_DRIVER: ComputerUse = { driver: "cua", version: "0.30.4", socket: "\\\\.\\pipe\\cua-driver" };
/** Where boot.ps1 logs how it set the box's address. */
const BOOT_LOG = "C:\\bb-box\\boot.log";
/** Tags of a warm VM: filling while bb-box makes it, warm once it is ready. */
const WARM = "warm";
const FILLING = "filling";
/** A warm VM's name until a box claims it. */
const WARM_NAME = "bb-box-warm";
/** How often a fill checks whether Windows' desktop is up. */
const DESKTOP_POLL_MS = 1_000;

const KIND: BoxKind = {
  id: "windows-desktop",
  label: "Windows desktop",
  description:
    "A Windows 11 VM for Windows apps, browsers and builds, with its desktop shown in the panel and computer use. Commands run in PowerShell 7 as an administrator. What a command starts with Start-Process ends with it; Start-Detached { <cmd> } <log> keeps it running. A desktop command runs unelevated, and what it opens stays open.",
  requires: [],
  capabilities: {
    os: "windows",
    arch: "x86_64",
    gpu: false,
    features: [],
    command: { transport: "ssh", shell: "powershell", admin: true, inDesktopSession: false, streaming: true },
    displays: [{ id: "desktop", protocol: "rfb", resizable: true }],
    computerUse: CUA_DRIVER,
    enrol: false,
  },
  readyTimeoutMs: READY_TIMEOUT_MS,
};

/**
 * Extends C: to the end of its disk. The template's C: is its disk's last
 * partition, so it can. Windows refuses a resize by less than 1 MB.
 */
export const EXTEND_C = String.raw`try {
  Update-HostStorageCache
  $max = (Get-PartitionSupportedSize -DriveLetter C -ErrorAction Stop).SizeMax
  $size = (Get-Partition -DriveLetter C -ErrorAction Stop).Size
  if ($max - $size -gt 1MB) { Resize-Partition -DriveLetter C -Size $max -ErrorAction Stop }
} catch {
  [Console]::Error.WriteLine("$_")
  exit 1
}`;

/**
 * BbDisplay.Fit sets the desktop to `width` by `height`. QEMU passes a
 * viewer's size on to the display driver, which then takes it beside the
 * modes Windows lists, though Windows does not switch to it. That can take a
 * moment, so it tries for up to 2 s. Else it sets the smallest listed mode
 * that covers the size, which the viewer scales down and so stays sharp, else
 * the largest. The list can hold an earlier viewer's size that the driver no
 * longer takes, so it tries them in turn. Each keeps the colour depth, and the
 * mode is kept for the user's next logon.
 */
const DISPLAY_SOURCE = String.raw`using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
public static class BbDisplay {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Mode {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    public short SpecVersion, DriverVersion, Size, DriverExtra;
    public int Fields, PositionX, PositionY, Orientation, FixedOutput;
    public short Color, Duplex, YResolution, TTOption, Collate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string FormName;
    public short LogPixels;
    public int BitsPerPel, Width, Height, Flags, Frequency;
    public int ICMMethod, ICMIntent, MediaType, DitherType, Reserved1, Reserved2, PanningWidth, PanningHeight;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettings(string device, int index, ref Mode mode);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ChangeDisplaySettingsEx(string device, ref Mode mode, IntPtr window, int flags, IntPtr param);
  static long Area(Mode mode) { return (long)mode.Width * mode.Height; }
  static int Set(Mode mode, int width, int height) {
    mode.Width = width;
    mode.Height = height;
    mode.Fields = 0x80000 | 0x100000; // DM_PELSWIDTH | DM_PELSHEIGHT
    return ChangeDisplaySettingsEx(null, ref mode, IntPtr.Zero, 1, IntPtr.Zero); // CDS_UPDATEREGISTRY
  }
  public static string Fit(int width, int height) {
    var current = new Mode();
    current.Size = (short)Marshal.SizeOf(typeof(Mode));
    if (!EnumDisplaySettings(null, -1, ref current)) return "Windows gave no mode for the display.";
    if (current.Width == width && current.Height == height) return null;
    for (var deadline = DateTime.UtcNow.AddSeconds(2); ; Thread.Sleep(250)) {
      if (Set(current, width, height) == 0) return null;
      if (DateTime.UtcNow > deadline) break;
    }
    var modes = new List<Mode>();
    var mode = current;
    for (int i = 0; EnumDisplaySettings(null, i, ref mode); i++) if (mode.BitsPerPel == current.BitsPerPel) modes.Add(mode);
    modes.Sort((a, b) => {
      bool coversA = a.Width >= width && a.Height >= height, coversB = b.Width >= width && b.Height >= height;
      if (coversA != coversB) return coversA ? -1 : 1;
      return coversA ? Area(a).CompareTo(Area(b)) : Area(b).CompareTo(Area(a));
    });
    int result = -2; // DISP_CHANGE_BADMODE
    foreach (var chosen in modes) {
      if (chosen.Width == current.Width && chosen.Height == current.Height) return null;
      result = Set(current, chosen.Width, chosen.Height);
      if (result == 0) return null;
    }
    return "Windows refused " + width + "x" + height + " and the modes it lists, with " + result + ".";
  }
}`;

/** Named for its source, so a new source compiles afresh. */
const DISPLAY_DLL = `display-${createHash("sha256").update(DISPLAY_SOURCE).digest("hex").slice(0, 12)}.dll`;

/**
 * Loads BbDisplay as $bbDisplay, from a file in the box user's local app
 * data, compiling it there first if it is missing. Add-Type takes up to 3 s
 * in a new PowerShell, and loading the file a few milliseconds. Scripts that
 * compile at once each write a file of their own, and the first to move it
 * into place wins.
 */
export const DISPLAY_HELPER = String.raw`$ErrorActionPreference = 'Stop'
$bbDll = [IO.Path]::Combine([Environment]::GetFolderPath('LocalApplicationData'), 'bb-box', '${DISPLAY_DLL}')
if (-not (Test-Path -LiteralPath $bbDll)) {
  $bbTemp = "$bbDll.$PID"
  New-Item -ItemType Directory -Force -Path (Split-Path $bbDll) | Out-Null
  try {
    Add-Type -OutputAssembly $bbTemp -TypeDefinition @'
${DISPLAY_SOURCE}
'@
    [IO.File]::Move($bbTemp, $bbDll)
  } catch {
    if (-not (Test-Path -LiteralPath $bbDll)) { throw }
  } finally {
    Remove-Item -LiteralPath $bbTemp -ErrorAction Ignore
  }
}
$bbDisplay = [Reflection.Assembly]::LoadFile($bbDll).GetType('BbDisplay')`;

/**
 * Sets the desktop to `width` by `height`, or the listed mode that best
 * covers it. It runs in the box user's desktop session, as the session SSH
 * gives has another display.
 */
export function setMode(width: number, height: number): string {
  return `${DISPLAY_HELPER}
$bbRefused = $bbDisplay::Fit(${width}, ${height})
if ($bbRefused) { [Console]::Error.WriteLine($bbRefused); exit 1 }`;
}

/**
 * Sets Windows' clock to `ms` after the epoch, plus the time PowerShell took
 * to start. A VM resumed from disk keeps the time it stopped at, and Windows
 * does not correct it for a while (039).
 */
export function setClock(ms: number): string {
  return `$bbNow = [DateTimeOffset]::FromUnixTimeMilliseconds(${ms}).LocalDateTime + ((Get-Date) - [Diagnostics.Process]::GetCurrentProcess().StartTime)
Set-Date -Date $bbNow -ErrorAction Stop | Out-Null`;
}

/**
 * Exits 0 once Windows' desktop is up: Explorer runs in a desktop session
 * and Cua's daemon listens on its pipe. A fill hibernates a warm VM then, so
 * a claim resumes a desktop that is ready for computer use.
 */
export const DESKTOP_UP = `if ((Get-Process explorer -ErrorAction SilentlyContinue | Where-Object SessionId -gt 0) -and (Test-Path -LiteralPath '${CUA_DRIVER.socket}')) { exit 0 }
exit 1`;

/** A doctor check's stable ID and its name. */
type Check = readonly [id: string, name: string];
const API: Check = ["proxmox.api", "Proxmox API"];
const NODE: Check = ["proxmox.node", "Node"];
const MEMORY: Check = ["proxmox.memory", "Node memory"];
const POOL: Check = ["proxmox.pool", "Resource pool"];
const BRIDGE: Check = ["proxmox.bridge", "Network bridge"];
const VMIDS: Check = ["proxmox.vmids", "VMID range"];
const SSH_KEY_CHECK: Check = ["ssh.key", "SSH key"];

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

/** A clone's net0, which keeps the MAC Proxmox gave it, on `bridge`. */
export function net0On(net0: unknown, bridge: string): string {
  const current = typeof net0 === "string" ? net0 : "";
  if (!current) return `virtio,bridge=${bridge}`;
  return /(?:^|,)bridge=/.test(current) ? current.replace(/((?:^|,)bridge=)[^,]*/, `$1${bridge}`) : `${current},bridge=${bridge}`;
}

/** The size a VM's config gives it, or null when it does not say. */
function sizeOf(config: Record<string, unknown>): BoxSize | null {
  const cores = Number(config.cores);
  const memoryMiB = Number(config.memory);
  if (!(Number.isInteger(cores) && cores > 0 && Number.isInteger(memoryMiB) && memoryMiB > 0)) return null;
  const disk = bootDisk(config);
  return { cores, memoryMiB, diskGiB: disk ? rootDiskGiB(config, disk) : null };
}

function gone(vmid: number): BackendError {
  return new BackendError("gone", `The box's VM ${vmid} no longer exists.`);
}

/**
 * Whether a warm VM of `size` serves a box of `wanted`: Proxmox cannot
 * change a hibernated VM, so the cores and memory must be the same, and the
 * disk at least the size asked for.
 */
function serves(size: BoxSize, wanted: BoxSize): boolean {
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
type Pending = { readonly kind: string; readonly size: BoxSize };

/** A warm VM that a claim can take, with the template, build and size it was filled with. */
interface WarmVm {
  readonly guest: PoolGuest;
  readonly template: number;
  readonly build: string | null;
  readonly size: BoxSize;
}

export class ProxmoxQemuBackend implements Backend {
  readonly id: string;
  readonly nature = "virtual" as const;
  readonly label: string;
  readonly hosts: readonly string[];
  readonly #config: QemuConfig;
  readonly #context: BackendContext;
  readonly #options: QemuBackendOptions;
  readonly #http: { fetch: FetchLike; close(): Promise<void> };
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
  #maintaining: Promise<void> | null = null;

  constructor(config: QemuConfig, context: BackendContext, options: QemuBackendOptions = {}) {
    this.id = context.id;
    this.#config = config;
    this.#context = context;
    this.#options = options;
    this.#http = options.fetch
      ? { fetch: options.fetch, close: async () => {} }
      : proxmoxFetch({ ca: config.proxmox.caCertificate, fingerprint: config.proxmox.tlsFingerprint });
    this.label = `Proxmox QEMU on ${config.proxmox.node ?? new URL(config.proxmox.apiUrl).hostname}`;
    this.hosts = [config.proxmox.node ?? new URL(config.proxmox.apiUrl).hostname];
  }

  kinds(): BoxKind[] {
    return this.#config.templates.length ? [KIND] : [];
  }

  async capacity(kind: string, size: BoxSize, pending: readonly Pending[], signal?: AbortSignal): Promise<Capacity> {
    this.#offer(kind);
    const api = await this.client();
    const guests = await api.listPool(this.#config.proxmox.pool, signal);
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
    size: BoxSize,
    guests: readonly PoolGuest[],
    pending: readonly Pending[],
    warm: { ready: number; target: number },
    fromPool: boolean,
    signal?: AbortSignal,
  ): Promise<Capacity> {
    const kind = KIND.id;
    const template = await this.#templateOf(api, this.#choose(guests), signal);
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
    if (memoryFree - size.memoryMiB < reserve.memoryMiB) {
      problems.push(
        `${api.node} has ${formatMiB(memoryFree)} of memory free. A ${kind} box with ${formatMiB(size.memoryMiB)} memory needs it all, ` +
          `and ${formatMiB(reserve.memoryMiB)} is kept free. Release a box, ask for less memory, or lower the memory kept free in bb-box's settings.`,
      );
    }
    if (node.cpus !== null && size.cores > node.cpus) {
      problems.push(`${api.node} has ${node.cpus} CPU threads, fewer than the ${size.cores} cores asked for. Ask for at most ${node.cpus} cores.`);
    }
    const grow = size.diskGiB !== null && !fromPool ? Math.max(0, size.diskGiB - (template.diskGiB ?? 0)) : 0;
    if (grow > 0 && diskFree - grow * 1024 < reserve.diskGiB * 1024) {
      problems.push(
        `The ${storage} storage on ${api.node} has ${Math.floor(diskFree / 1024)} GiB free. A ${size.diskGiB} GiB disk needs ${Math.ceil(grow)} GiB more than the template's, ` +
          `and ${reserve.diskGiB} GiB is kept free. Ask for a smaller disk, release boxes, or lower the disk kept free in bb-box's settings.`,
      );
    }
    if (diskFree < reserve.diskGiB * 1024 && !fromPool) {
      problems.push(
        `The ${storage} storage on ${api.node} has ${Math.floor(diskFree / 1024)} GiB free, less than the ${reserve.diskGiB} GiB kept free. ` +
          "Release boxes, free some space, or lower the disk kept free in bb-box's settings.",
      );
    }
    if (this.#freeVmid(guests) === null && !fromPool) {
      problems.push(`Every VMID from ${first} to ${last} is in use. Release a box, or widen the VMID range in bb-box's settings.`);
    }
    const ok = problems.length === 0;
    return { ok, message: ok ? null : problems[0]!, warm, hosts: [{ host: api.node, ok, limits }] };
  }

  /**
   * The least used template, counting guests in the range by their template
   * tag, and acquires and fills here that have chosen one.
   */
  #choose(guests: readonly PoolGuest[]): number {
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
    return this.#config.templates.reduce((best, template) => (uses(template) < uses(best) ? template : best));
  }

  async acquire(box: BoxIdentity, previous: Guest | null, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest> {
    this.#offer(box.kind);
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
      if (previous && this.#inRange(Number(previous.ref)) && (await this.#owns(api, Number(previous.ref), box.boxId, signal))) {
        vmid = Number(previous.ref);
        template = typeof previous.data?.template === "number" ? previous.data.template : null;
        build = typeof previous.data?.build === "string" ? previous.data.build : null;
        resumed = true;
      }
      if (vmid === null) {
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
        await step("relabel", () =>
          api.configure(id, { tags: boxTags(box, installId, template), name: box.name, description: describe(box, installId), onboot: true }, signal),
        );
        const size = api.config(id, signal).then(sizeOf, () => null);
        await this.#waitReady(id, Math.max(1_000, deadline - Date.now()), signal, step);
        await step("clock", () => this.#setClock(id, signal));
        this.#compileDisplay(id);
        this.#kick();
        return this.#guest(api.node, id, template, box.boxId, await size, build);
      }
      if (vmid === null) {
        // Time spent waiting for a template that is being replaced shows apart from the clone.
        let away: number | null = null;
        const cloning = performance.now();
        try {
          const guests = await api.listPool(this.#config.proxmox.pool, signal);
          template = this.#choose(guests);
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
      const config = await step("configure", async () => {
        const current = await api.config(id, signal);
        await api.configure(id, this.#settings(box.size, id, current), signal);
        return current;
      });
      await step("tags", () => api.configure(id, { tags: boxTags(box, installId, template) }, signal));
      const grew = await this.#grow(api, id, config, box.size.diskGiB, step, signal);
      await hooks.starting();
      await step("start", async () => {
        if ((await api.status(id, signal))?.status !== "running") await api.start(id, signal);
      });
      // Read while the box comes up: the size it has, as Proxmox gives it.
      const size = api.config(id, signal).then(sizeOf, () => null);
      await this.#waitReady(id, Math.max(1_000, deadline - Date.now()), signal, step);
      // A resumed acquire may have grown the disk before it stopped.
      if (grew || (resumed && box.size.diskGiB !== null)) await step("extend", () => this.#extend(id, signal));
      this.#compileDisplay(id);
      return this.#guest(api.node, id, template, box.boxId, await size, build);
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
  async start(guest: Guest, signal?: AbortSignal, timing: (step: string, ms: number) => void = () => {}): Promise<void> {
    const vmid = this.#vmid(guest);
    const api = await this.client();
    const status = (await this.#still(api, guest, signal)) ? await api.status(vmid, signal) : null;
    if (!status) throw gone(vmid);
    const step = timed(timing);
    // A hibernated VM resumes; one shut down from Windows boots.
    if (status.status !== "running") await step(status.lock === "suspended" ? "resume" : "boot", () => api.start(vmid, signal));
    await this.#waitReady(vmid, this.#options.readyTimeoutMs ?? READY_TIMEOUT_MS, signal, step);
    await step("clock", () => this.#setClock(vmid, signal));
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
      if (this.#filling.has(guest.vmid) || guest.tags.includes(WARM)) continue;
      let install = installFromTags(guest.tags);
      let owner = ownerFromTags(guest.tags, guest.name || null);
      if (!guest.tags.includes(TAG) || !owner) {
        const config = await api.config(guest.vmid, signal).catch((): Record<string, unknown> => ({}));
        install ??= installFromDescription(config.description);
        owner ??= ownerFromDescription(config.description);
      }
      if (install !== this.#context.installId) continue;
      const found = this.#guest(guest.node || api.node, guest.vmid, templateFromTags(guest.tags), owner?.boxId ?? null, guest.size);
      held.push({ ...found, owner, power: powerOf(guest.status) });
    }
    return held;
  }

  /** Records a box's new owner and name on its VM (036). Windows keeps its computer name. */
  async relabel(guest: Guest, box: BoxIdentity, _from: string, signal?: AbortSignal): Promise<void> {
    const api = await this.client();
    const vmid = this.#vmid(guest);
    const installId = this.#context.installId;
    const template = templateFromTags(parseTags((await api.config(vmid, signal)).tags));
    await api.configure(vmid, { name: box.name, description: describe(box, installId) }, signal);
    await api.configure(vmid, { tags: boxTags(box, installId, template) }, signal);
  }

  async transports(guest: Guest): Promise<BoxTransports> {
    const vmid = this.#vmid(guest);
    const command = await this.#command(vmid);
    const desktop: Display = {
      ...KIND.capabilities.displays[0]!,
      label: "Desktop",
      open: (signal) => this.#console(vmid, signal),
      resize: (size, signal) => this.#resize(vmid, command, size, signal),
      minSize: MIN_DESKTOP,
    };
    return { command, displays: [desktop], access: { ssh: this.#access(vmid), dockerHost: null } };
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
    const templateCheck = (template: number): Check => [`template.${template}`, `Windows template ${template}`];
    const later = [NODE, MEMORY, POOL, ...this.#config.templates.map(templateCheck), BRIDGE, VMIDS];
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

      for (const template of this.#config.templates) {
        const name = templateCheck(template);
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
              pass(name, `VM template ${template} on ${storage}, ${Math.floor((free as { available: number }).available / GiB)} GiB free.`);
            }
          }
        } catch (error) {
          const missing = error instanceof ProxmoxError && error.gone;
          fail(
            name,
            missing ? `VM ${template} does not exist on ${node}, or is not in pool ${pool}.` : message(error),
            missing
              ? "Build it with setup/proxmox-qemu/build.sh, or remove it from the Windows templates in bb-box's settings."
              : audit(error, `Give the token VM.Audit and VM.Clone on /vms/${template}.`),
          );
        }
      }

      const bridge = this.#config.network.bridge;
      try {
        if (await api.interfaceExists(bridge, signal)) pass(BRIDGE, `${bridge} exists on ${node}.`);
        else fail(BRIDGE, `${node} has no ${bridge}.`, "Create the bridge as the Proxmox LXC setup guide does, or set the bridge in bb-box's settings.");
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
      } catch (error) {
        fail(VMIDS, message(error), audit(error, `Give the token VM.Audit on /pool/${pool}.`));
      }
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
            "bb-box made a key, which a template from build.sh does not accept; its public key is below.",
            "Paste BBBOX_SSH_KEY, the key build.sh put in the template, here or in Proxmox LXC's settings. Or add the public key below to the template.",
          );
        } else pass(SSH_KEY_CHECK, "From bb-box's settings; its public key is below.");
      } else {
        fail(SSH_KEY_CHECK, "ssh-keygen cannot read the SSH private key in bb-box's settings.", "Paste the whole of BBBOX_SSH_KEY, the private key build.sh put in the template.");
      }
    } catch (error) {
      fail(SSH_KEY_CHECK, message(error), "Check the SSH private key in bb-box's settings: paste the whole of BBBOX_SSH_KEY, the private key build.sh put in the template.");
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
    if (!this.#maintaining) {
      const run = this.#topUp(signal ?? this.#stopping.signal).finally(() => {
        this.#maintaining = null;
      });
      this.#maintaining = run;
    }
    return this.#maintaining;
  }

  async dispose(): Promise<void> {
    this.#stopping.abort(new Error("bb-box is stopping."));
    await this.#maintaining?.catch(() => undefined);
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
    if (!this.#inRange(vmid)) throw new Error(`Guest ${guest.ref} is outside bb-box's VMID range, so bb-box leaves it alone.`);
    return vmid;
  }

  /** `template` and `box` are kept with the box. */
  #guest(node: string, vmid: number, template: number | null = null, box: string | null = null, size: BoxSize | null = null, build: string | null = null): Guest {
    const guest: Guest = { ref: String(vmid), host: node, address: addressFor(this.#config, vmid), size };
    const data = { ...(template !== null ? { template } : {}), ...(build !== null ? { build } : {}), ...(box !== null ? { box } : {}) };
    return Object.keys(data).length ? { ...guest, data } : guest;
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
  async asOffered(guest: Guest, _kind: string, createdAt: number, signal?: AbortSignal): Promise<boolean> {
    const template = guest.data?.template;
    if (typeof template !== "number" || !this.#config.templates.includes(template)) return false;
    return fromBuild(guest, await templateBuild(await this.client(), [], template, signal), createdAt);
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
  #settings(size: BoxSize, vmid: number, current: Record<string, unknown>): GuestSettings {
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
    const command = await this.#command(vmid);
    const result = await command.run(EXTEND_C, { timeoutMs: 60_000, signal, maxOutputBytes: 4096 });
    if (result.exitCode !== 0) {
      throw new Error(`The box's disk grew, but Windows could not extend C: over it: ${result.stderr.trim() || `exit code ${result.exitCode}`}.`);
    }
  }

  /**
   * Compiles the display helper in the background while the box is new, so
   * its first resize is as quick as the rest. A failure is left to the first
   * resize, which compiles it again.
   */
  #compileDisplay(vmid: number): void {
    const compiling = this.#command(vmid)
      .then((command) => command.run(DISPLAY_HELPER, { timeoutMs: RESIZE_TIMEOUT_MS, maxOutputBytes: 4096 }))
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => this.#compiling.delete(vmid));
    this.#compiling.set(vmid, compiling);
  }

  /**
   * Sets the desktop to `size`, or to the listed mode that best covers it,
   * through Windows itself (021), as the display driver does not switch to
   * a viewer's size.
   */
  async #resize(vmid: number, command: SshTransport, size: DisplaySize, signal?: AbortSignal): Promise<void> {
    const { width, height } = size;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error(`The desktop cannot be ${width} by ${height} pixels.`);
    }
    await this.#compiling.get(vmid);
    const result = await command.run(desktopScript(setMode(width, height), RESIZE_TIMEOUT_MS), { timeoutMs: RESIZE_TIMEOUT_MS + 5_000, signal, maxOutputBytes: 4096 });
    if (result.exitCode !== 0) {
      throw new Error(`Windows could not set the desktop to ${width}x${height}: ${result.stderr.trim() || `exit code ${result.exitCode}.`}`);
    }
  }

  async #templateOf(api: Proxmox, template: number, signal?: AbortSignal): Promise<TemplateInfo> {
    const cached = this.#templates.get(template);
    if (cached) return cached;
    let config: Record<string, unknown>;
    try {
      config = await api.config(template, signal);
    } catch (error) {
      if (error instanceof ProxmoxError && error.gone) {
        throw new Error(`Windows template ${template} does not exist on ${api.node}, or is not in pool ${this.#config.proxmox.pool}. Run the doctor check in bb-box's panel.`);
      }
      throw error;
    }
    const disk = bootDisk(config);
    const storage = disk ? String(config[disk]).split(":")[0] : "";
    if (!disk || !storage) throw new Error(`Windows template ${template} has no boot disk.`);
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
          `Every VMID from ${this.#config.vmids.first} to ${this.#config.vmids.last} is in use. Release a box, or widen the VMID range in bb-box's settings.`,
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
            `Windows template ${template} on ${api.node} was still missing, or not yet a template, after ${Math.round(this.#templateWaitMs / 1000)} s ` +
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

  async #command(vmid: number): Promise<SshTransport> {
    return new SshTransport((await this.#keys()).ssh, this.#access(vmid), "windows");
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

  /** Sets Windows' clock from BB's server's. */
  async #setClock(vmid: number, signal?: AbortSignal): Promise<void> {
    const command = await this.#command(vmid);
    const result = await command.run(setClock(Date.now()), { timeoutMs: CLOCK_TIMEOUT_MS, signal, maxOutputBytes: 4096 });
    if (result.exitCode !== 0) {
      throw new Error(`Windows could not set its clock: ${result.stderr.trim() || `exit code ${result.exitCode}.`}`);
    }
  }

  /** Waits for port 22 to open, which is cheap to poll, then for SSH to answer. */
  async #waitReady(vmid: number, timeoutMs: number, signal?: AbortSignal, step: Step = untimed): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const { host, port, user } = this.#access(vmid);
    const sleep = this.#options.sleep;
    const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;
    const open = await step("network", () => waitForPort(host, port, { timeoutMs, check: this.#options.portCheck, signal, sleep }));
    if (!open) {
      throw new Error(
        `Nothing answered on port ${port} of ${host} within ${seconds(timeoutMs)}. ` +
          `Check that BB's server can reach the boxes' subnet, and how boot.ps1 set the box's address in ${BOOT_LOG}, from the VM's console in Proxmox.`,
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
          `Check that the template accepts bb-box's key in C:\\ProgramData\\ssh\\administrators_authorized_keys.`,
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
    if (target === 0) return;
    const size = this.#context.kind(KIND.id).defaultSize;
    const guests = await api.listPool(pool, signal);
    const ready = (await this.#ready(api, guests, signal)).length;
    for (let missing = target - ready; missing > 0; missing--) {
      signal.throwIfAborted();
      const room = await this.#room(api, size, await api.listPool(pool, signal), [], { ready, target }, false, signal);
      if (!room.ok) {
        this.#context.logError("warm pool", new Error(room.message ?? "No room for a warm box."));
        break;
      }
      await this.#fill(api, size, signal);
    }
  }

  /**
   * Makes a warm VM at `size`: a clone, started, with the display helper
   * compiled, and hibernated once Windows' desktop is up. It is tagged warm
   * just before, as Proxmox refuses tags after.
   */
  async #fill(api: Proxmox, size: BoxSize, signal: AbortSignal): Promise<void> {
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
      // Off at the node's boot, as a warm VM that runs is deleted.
      await api.configure(id, { ...this.#settings(size, id, config), onboot: false }, signal);
      await api.configure(id, { tags: tags(FILLING) }, signal);
      const grew = await this.#grow(api, id, config, size.diskGiB, untimed, signal);
      await api.start(id, signal);
      const deadline = Date.now() + (this.#options.readyTimeoutMs ?? READY_TIMEOUT_MS);
      await this.#waitReady(id, Math.max(1_000, deadline - Date.now()), signal);
      if (grew) await this.#extend(id, signal);
      await this.#desktopUp(id, Math.max(1_000, deadline - Date.now()), signal);
      // A failure is left to the box's first resize, which compiles it again.
      const command = await this.#command(id);
      await command.run(DISPLAY_HELPER, { timeoutMs: RESIZE_TIMEOUT_MS, signal, maxOutputBytes: 4096 }).catch(() => undefined);
      await api.configure(id, { tags: tags(WARM) }, signal);
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

  /** Waits until DESKTOP_UP says Windows' desktop is up. */
  async #desktopUp(vmid: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const command = await this.#command(vmid);
    const up = {
      probe: async (signal?: AbortSignal) =>
        (await command.run(DESKTOP_UP, { timeoutMs: 10_000, signal, maxOutputBytes: 4096 }).catch(() => null))?.exitCode === 0,
    };
    if (!(await waitUntilAnswers(up, { timeoutMs, intervalMs: DESKTOP_POLL_MS, signal, sleep: this.#options.sleep }))) {
      throw new Error(
        `Windows' desktop in warm VM ${vmid} was not up within ${Math.round(timeoutMs / 1000)} s: Explorer did not run in a desktop session, ` +
          `or Cua's daemon did not listen on ${CUA_DRIVER.socket}. Check the VM's console in Proxmox, and that the template signs the box user in.`,
      );
    }
  }
}
