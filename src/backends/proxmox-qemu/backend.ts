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
// The desktop's display, desktop commands, stop and start, and the warm pool
// are still to come.

import { randomUUID } from "node:crypto";
import { Proxmox, ProxmoxError, parseTags, rootDiskGiB, type FetchLike, type GuestSettings, type PoolGuest } from "../proxmox/api.ts";
import {
  TAG,
  boxTags,
  describe,
  installFromDescription,
  installFromTags,
  installTag,
  isTemplate,
  namesOf,
  ownerFromDescription,
  ownerFromTags,
  templateFromTags,
} from "../proxmox/owner.ts";
import { addressFor } from "../proxmox/settings.ts";
import { proxmoxFetch } from "../proxmox/tls.ts";
import {
  BackendError,
  type AcquireHooks,
  type Backend,
  type BackendContext,
  type BoxIdentity,
  type BoxKind,
  type BoxSize,
  type BoxTransports,
  type Capacity,
  type DoctorCheck,
  type DoctorReport,
  type Guest,
  type HeldGuest,
  type Limit,
  type PowerState,
  type ReleaseHooks,
} from "../types.ts";
import { pause, waitForPort, waitUntilAnswers, type PortCheck } from "../../transports/ready.ts";
import { KeyFile, Ssh, SshTransport, generateKeyPair, publicKey } from "../../transports/ssh.ts";
import type { SshAccess } from "../../transports/types.ts";
import type { QemuConfig } from "./config.ts";

const MiB = 2 ** 20;
const GiB = 2 ** 30;
const SSH_KEY = "ssh-key";
/** Where the next VMID search starts. */
const NEXT_VMID = "next-vmid";
/** A linked clone of Windows boots and starts sshd in about 20 s; this leaves room for a busy host. */
const READY_TIMEOUT_MS = 180_000;
/** build.sh --replace swaps the template for its new build, which leaves it missing for a moment. A clone waits this long for it. */
const TEMPLATE_WAIT_MS = 10_000;
const TEMPLATE_POLL_MS = 250;
/** Where boot.ps1 logs how it set the box's address. */
const BOOT_LOG = "C:\\bb-box\\boot.log";

const KIND: BoxKind = {
  id: "windows-desktop",
  label: "Windows desktop",
  description: "A Windows 11 VM for Windows apps, browsers and builds. Commands run in PowerShell 7 as an administrator.",
  requires: [],
  capabilities: {
    os: "windows",
    arch: "x86_64",
    gpu: false,
    features: [],
    command: { transport: "ssh", shell: "powershell", admin: true, inDesktopSession: false, streaming: true },
    displays: [],
    computerUse: null,
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

export class ProxmoxQemuBackend implements Backend {
  readonly id: string;
  readonly nature = "virtual" as const;
  readonly label: string;
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

  constructor(config: QemuConfig, context: BackendContext, options: QemuBackendOptions = {}) {
    this.id = context.id;
    this.#config = config;
    this.#context = context;
    this.#options = options;
    this.#http = options.fetch
      ? { fetch: options.fetch, close: async () => {} }
      : proxmoxFetch({ ca: config.proxmox.caCertificate, fingerprint: config.proxmox.tlsFingerprint });
    this.label = `Proxmox QEMU on ${config.proxmox.node ?? new URL(config.proxmox.apiUrl).hostname}`;
  }

  kinds(): BoxKind[] {
    return this.#config.templates.length ? [KIND] : [];
  }

  async capacity(kind: string, size: BoxSize, pending: readonly Pending[], signal?: AbortSignal): Promise<Capacity> {
    this.#offer(kind);
    const api = await this.client();
    const guests = await api.listPool(this.#config.proxmox.pool, signal);
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
    const grow = size.diskGiB !== null ? Math.max(0, size.diskGiB - (template.diskGiB ?? 0)) : 0;
    if (grow > 0 && diskFree - grow * 1024 < reserve.diskGiB * 1024) {
      problems.push(
        `The ${storage} storage on ${api.node} has ${Math.floor(diskFree / 1024)} GiB free. A ${size.diskGiB} GiB disk needs ${Math.ceil(grow)} GiB more than the template's, ` +
          `and ${reserve.diskGiB} GiB is kept free. Ask for a smaller disk, release boxes, or lower the disk kept free in bb-box's settings.`,
      );
    }
    if (diskFree < reserve.diskGiB * 1024) {
      problems.push(
        `The ${storage} storage on ${api.node} has ${Math.floor(diskFree / 1024)} GiB free, less than the ${reserve.diskGiB} GiB kept free. ` +
          "Release boxes, free some space, or lower the disk kept free in bb-box's settings.",
      );
    }
    if (this.#freeVmid(guests) === null) {
      problems.push(`Every VMID from ${first} to ${last} is in use. Release a box, or widen the VMID range in bb-box's settings.`);
    }
    const ok = problems.length === 0;
    return { ok, message: ok ? null : problems[0]!, warm: { ready: 0, target: 0 }, hosts: [{ host: api.node, ok, limits }] };
  }

  /** The least used template, counting guests in the range by their template tag and acquires here that have chosen one. */
  #choose(guests: readonly PoolGuest[]): number {
    const counts = new Map<number, number>();
    const add = (template: number | null) => {
      if (template !== null) counts.set(template, (counts.get(template) ?? 0) + 1);
    };
    for (const guest of guests) if (this.#inRange(guest.vmid)) add(templateFromTags(guest.tags));
    for (const template of this.#acquiring.values()) add(template);
    const uses = (template: number) => counts.get(template) ?? 0;
    return this.#config.templates.reduce((best, template) => (uses(template) < uses(best) ? template : best));
  }

  async acquire(box: BoxIdentity, previous: Guest | null, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest> {
    this.#offer(box.kind);
    const deadline = Date.now() + (this.#options.readyTimeoutMs ?? KIND.readyTimeoutMs);
    const api = await this.client();
    const installId = this.#context.installId;
    const step: Step = async (name, run) => {
      const started = performance.now();
      try {
        return await run();
      } finally {
        hooks.timing(name, Math.round(performance.now() - started));
      }
    };
    let vmid: number | null = null;
    let claimed: number | null = null;
    let template: number | null = null;
    const claim = async (id: number) => {
      claimed = id;
      await hooks.claim(this.#guest(api.node, id, template, box.boxId));
    };
    try {
      let resumed = false;
      if (previous && this.#inRange(Number(previous.ref)) && (await this.#owns(api, Number(previous.ref), box.boxId, signal))) {
        vmid = Number(previous.ref);
        template = typeof previous.data?.template === "number" ? previous.data.template : null;
        resumed = true;
      }
      if (vmid === null) {
        // Time spent waiting for a template that is being replaced shows apart from the clone.
        let away: number | null = null;
        const cloning = performance.now();
        try {
          const guests = await api.listPool(this.#config.proxmox.pool, signal);
          template = this.#choose(guests);
          this.#acquiring.set(box.boxId, template);
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
      return this.#guest(api.node, id, template, box.boxId, await size);
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

  /** This install's guests, from the pool listing. Only a guest not yet tagged costs a config read. */
  async held(signal?: AbortSignal): Promise<HeldGuest[]> {
    const api = await this.client();
    const held: HeldGuest[] = [];
    for (const guest of await api.listPool(this.#config.proxmox.pool, signal)) {
      if (guest.type !== "qemu" || guest.template || !this.#inRange(guest.vmid) || this.#reserved.has(guest.vmid)) continue;
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
    return { command: await this.#command(vmid), displays: [], access: { ssh: this.#access(vmid), dockerHost: null } };
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
          const missing = error instanceof ProxmoxError && error.notFound;
          fail(
            name,
            missing ? `VM ${template} does not exist on ${node}.` : message(error),
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

  async dispose(): Promise<void> {
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
  #guest(node: string, vmid: number, template: number | null = null, box: string | null = null, size: BoxSize | null = null): Guest {
    const guest: Guest = { ref: String(vmid), host: node, address: addressFor(this.#config, vmid), size };
    const data = { ...(template !== null ? { template } : {}), ...(box !== null ? { box } : {}) };
    return Object.keys(data).length ? { ...guest, data } : guest;
  }

  /** The guest's config, or null when it does not exist. */
  async #guestConfig(api: Proxmox, vmid: number, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    try {
      return await api.config(vmid, signal);
    } catch (error) {
      if (error instanceof ProxmoxError && error.notFound) return null;
      throw error;
    }
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

  async #templateOf(api: Proxmox, template: number, signal?: AbortSignal): Promise<TemplateInfo> {
    const cached = this.#templates.get(template);
    if (cached) return cached;
    let config: Record<string, unknown>;
    try {
      config = await api.config(template, signal);
    } catch (error) {
      if (error instanceof ProxmoxError && error.notFound) {
        throw new Error(`Windows template ${template} does not exist on ${api.node}. Run the doctor check in bb-box's panel.`);
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
      if (error instanceof ProxmoxError && (error.notFound || error.forbidden)) return true;
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
}
