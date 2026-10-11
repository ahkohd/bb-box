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

import type { CheckId } from "../../core/checks.ts";
import { randomUUID } from "node:crypto";
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
import { Upkeep } from "../warm.ts";
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
  type ComputerUse,
  type DoctorCheck,
  type DoctorReport,
  type Guest,
  type HeldGuest,
  type ImageBox,
  type ImageBuild,
  type Limit,
  type PoolMember,
  type PowerState,
  type ReleaseHooks,
  type WarmShortfall,
} from "../types.ts";
import { sizesCheck } from "../fit.ts";
import { judgeImage, recordFromJson, recordInDescription } from "../images.ts";
import { pause, waitForPort, waitUntilAnswers, type PortCheck } from "../../transports/ready.ts";
import { KeyFile, Ssh, SshTransport, generateKeyPair, publicKey } from "../../transports/ssh.ts";
import { MIN_DESKTOP, type Display, type DisplaySize, type GuestOs, type SshAccess } from "../../transports/types.ts";
import { CUA_PIPE, compileDisplay, desktopUp, extendC, setClock, setMode } from "../windows.ts";
import type { QemuConfig } from "./config.ts";

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
    // moves it with Get-Clipboard and Set-Clipboard in the desktop session (#461).
    displays: [{ id: "desktop", protocol: "rfb", resizable: true, clipboard: "commands" }],
    computerUse: CUA_DRIVER,
    enrol: false,
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
    "A Linux VM with its own kernel, for kernel modules, systemd as on a machine, and work a container cannot do. It starts slower and holds its memory while it runs, so ask for it by its provider or the feature kernel; a linux box elsewhere starts sooner.",
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
  },
  readyTimeoutMs: READY_TIMEOUT_MS,
};

/** A doctor check's stable ID and its name. */
type Check = readonly [id: CheckId, name: string];
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
  readonly hostOs = "linux" as const;
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
  readonly #upkeep = new Upkeep((signal) => this.#topUp(signal));
  /** Image boxes (054) from before their clone until their capture or removal, which no sweep counts. */
  readonly #imageBoxes = new Set<number>();

  /**
   * Image operations (054): a box from a template, its capture as a template
   * with the image's record in its description, and a template replaced in
   * place under its VMID, as build.sh --replace does. refreshImage runs the
   * Windows refresh script in the box.
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
      ? { fetch: options.fetch, close: async () => {} }
      : proxmoxFetch({ ca: config.proxmox.caCertificate, fingerprint: config.proxmox.tlsFingerprint });
    this.label = `Proxmox QEMU on ${config.proxmox.node ?? new URL(config.proxmox.apiUrl).hostname}`;
    this.hosts = [config.proxmox.node ?? new URL(config.proxmox.apiUrl).hostname];
  }

  kinds(): BoxKind[] {
    const kinds: BoxKind[] = [];
    // Windows boxes join BB unless the switch is set off (#539).
    if (this.#config.templates.length) kinds.push(this.#config.enrol ? { ...KIND, capabilities: { ...KIND.capabilities, enrol: true } } : KIND);
    if (this.#config.linuxTemplates.length) kinds.push(LINUX_KIND);
    return kinds;
  }

  /** The templates of a kind's boxes. */
  #templatesOf(kind: string): readonly number[] {
    return kind === LINUX_KIND.id ? this.#config.linuxTemplates : this.#config.templates;
  }

  /** Every template, Windows' and Linux'. */
  #allTemplates(): readonly number[] {
    return [...this.#config.templates, ...this.#config.linuxTemplates];
  }

  /** A template as messages name it: "Linux template 9106" or "Windows template 9104". */
  #templateName(template: number): string {
    return `${this.#osOf(template) === "linux" ? "Linux" : "Windows"} template ${template}`;
  }

  /** The OS of a guest from its template: Linux for a Linux template's clone, Windows otherwise. */
  #osOf(template: unknown): GuestOs {
    return typeof template === "number" && this.#config.linuxTemplates.includes(template) ? "linux" : "windows";
  }

  async capacity(kind: string, size: BoxSize, pending: readonly Pending[], signal?: AbortSignal): Promise<Capacity> {
    this.#offer(kind);
    const api = await this.client();
    const guests = await api.listPool(this.#config.proxmox.pool, signal);
    // Linux boxes have no warm pool here: their spares wait hibernated (#612).
    if (kind === LINUX_KIND.id) return this.#room(api, size, guests, pending, { ready: 0, target: 0 }, false, signal, kind);
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
              ? "Release a box, ask for less memory, or lower the memory kept free in bb-box's settings."
              : "Release a box, or lower the memory kept free in bb-box's settings."),
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
            "Ask for a smaller disk, release boxes, or lower the disk kept free in bb-box's settings.",
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
    const linux = box.kind === LINUX_KIND.id;
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
      await this.#waitReady(id, Math.max(1_000, deadline - Date.now()), signal, step, os);
      // A Linux template's cloud-init grows its root filesystem at each boot.
      if (!linux) {
        // A resumed acquire may have grown the disk before it stopped.
        if (grew || (resumed && box.size.diskGiB !== null)) await step("extend", () => this.#extend(id, signal));
        this.#compileDisplay(id);
      }
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
    const os = this.#osOf(guest.data?.template);
    await this.#waitReady(vmid, this.#options.readyTimeoutMs ?? READY_TIMEOUT_MS, signal, step, os);
    // Linux keeps its clock with its own time service.
    if (os === "windows") await step("clock", () => this.#setClock(vmid, signal));
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
    const os = this.#osOf(guest.data?.template);
    const command = await this.#command(vmid, os);
    if (os === "linux") return { command, displays: [], access: { ssh: this.#access(vmid), dockerHost: null } };
    const desktop: Display = {
      ...KIND.capabilities.displays[0]!,
      label: "Desktop",
      open: (signal) => this.#console(vmid, signal),
      resize: (size, signal) => this.#resize(vmid, command, size, signal),
      // QEMU passes a viewer's size on to the display driver, which offers it as a mode if it is at least 640x480.
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
    const templateCheck = (template: number): Check => [`template.${template}`, this.#templateName(template)];
    const later = [NODE, MEMORY, POOL, ...this.#allTemplates().map(templateCheck), BRIDGE, VMIDS];
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
      const pins = (this.#context.images?.pins("windows") ?? Promise.resolve(null)).catch(() => null);
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
              pass(name, `VM template ${template} on ${storage}, ${Math.floor((free as { available: number }).available / GiB)} GiB free.`);
              // A Linux template's image record comes with its refresh (057).
              if (os === "linux") continue;
              // A Windows image carries no build of BB's app: BB's installer puts it in as a box joins BB.
              const judged = judgeImage(
                recordInDescription(String(config.description ?? "")),
                { os: "windows", pins: await pins, bbApp: null, joins: this.#config.enrol },
                `Rebuild it with the setup guide's setup/proxmox-qemu/build.sh, as root on ${node}: build.sh windows ${template} --replace.`,
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
              ? `Build it with setup/proxmox-qemu/build.sh, or remove it from the ${os === "linux" ? "Linux" : "Windows"} templates in bb-box's settings.`
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
    if (typeof template !== "number" || !this.#allTemplates().includes(template)) return false;
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
        throw new Error(`${this.#templateName(template)} does not exist on ${api.node}, or is not in pool ${this.#config.proxmox.pool}. Run the doctor check in bb-box's panel.`);
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
            `${this.#templateName(template)} on ${api.node} was still missing, or not yet a template, after ${Math.round(this.#templateWaitMs / 1000)} s ` +
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
            ? "Check that BB's server can reach the boxes' subnet, and how the template set the box's address, in journalctl -u bb-box-address from the VM's console in Proxmox."
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
            ? `Check that the template accepts bb-box's key in ~${user}/.ssh/authorized_keys.`
            : `Check that the template accepts bb-box's key in C:\\ProgramData\\ssh\\administrators_authorized_keys.`),
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
      await compileDisplay(await this.#command(id), signal);
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

  /** The configured templates, as standard images, and this install's captured builds and image boxes. */
  async #imageList(signal?: AbortSignal): Promise<{ builds: ImageBuild[]; boxes: string[] }> {
    const api = await this.client();
    const install = installTag(this.#context.installId);
    const builds: ImageBuild[] = [];
    for (const vmid of this.#config.templates) {
      const config = await api.config(vmid, signal).catch(() => null);
      if (config && isTemplate(config)) builds.push(this.#imageBuild(vmid, KIND.id, "standard", config, true));
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
   * A clone of a build's template, started as a box of its kind is, with its
   * desktop up, tagged so that no sweep takes it.
   */
  async #imageBox(build: ImageBuild, label: string, signal: AbortSignal): Promise<ImageBox> {
    const api = await this.client();
    const template = Number(build.ref);
    let vmid: number | null = null;
    try {
      const guests = await api.listPool(this.#config.proxmox.pool, signal);
      const description = `bb-box image box: ${label}\ninstall ${this.#context.installId}`;
      vmid = await this.#clone(api, guests, template, IMAGE_HOSTNAME, description, async (id) => void this.#imageBoxes.add(id), signal, () => {});
      const id = vmid;
      await api.configure(id, this.#settings(this.#context.kind(KIND.id).defaultSize, id, await api.config(id, signal)), signal);
      await api.configure(id, { tags: [TAG, installTag(this.#context.installId), IMAGE_BOX, templateTag(template)] }, signal);
      await api.start(id, signal);
      const timeoutMs = this.#options.readyTimeoutMs ?? KIND.readyTimeoutMs;
      await this.#waitReady(id, timeoutMs, signal);
      await this.#setClock(id, signal);
      // The kind's check runs in the desktop session, which comes up soon after SSH.
      await this.#desktopUp(id, timeoutMs, signal);
      return { ref: String(id), command: await this.#command(id) };
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
    const read = await box.command.run("Get-Content C:\\bb-box\\image.json -Raw", { timeoutMs: 15_000, signal, maxOutputBytes: 64 * 1024 });
    const record = read.exitCode === 0 ? recordFromJson(read.stdout.trim()) : null;
    if (!record) throw new Error(`Image box ${vmid} has no image record in C:\\bb-box\\image.json, which the refresh writes.`);
    const source = await api.config(Number(from.ref), signal);
    const build = record.build.startsWith(BUILD) ? record.build : `${BUILD}${record.build}`;
    // Clones start with an empty boot log, as build.sh leaves the template's.
    await box.command.run(`Clear-Content ${BOOT_LOG} -ErrorAction SilentlyContinue`, { timeoutMs: 15_000, signal });
    await this.#forget(vmid);
    await api.shutdown(vmid, 300, signal);
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
    if (!storage) throw new Error(`Windows template ${target} has no boot disk.`);
    const thin = (await api.storageStatus(storage, signal)).type === "lvmthin";
    const name = typeof old.name === "string" ? old.name : "bb-box-windows";
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
      kept = `bb-box rollback of Windows template ${target}${oldBuild ? `, ${BUILD}${oldBuild}` : ""}, kept until its next refresh. To use it, list ${free} as the Windows template in bb-box's settings.`;
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
    const first = String(old.description ?? "bb-box windows template.").split("\n")[0]!;
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
    if (this.#allTemplates().includes(vmid) || !ours || !this.#inRange(vmid)) throw new Error(`VM ${vmid} is not an image box or build of this install's, so bb-box leaves it.`);
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
