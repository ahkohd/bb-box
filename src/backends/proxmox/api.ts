// A small Proxmox VE client for the calls bb-box makes on containers or VMs,
// authenticated with an API token. Each client works on one type of guest.
// Every call goes through one `fetch`, so tests pass a fake API. The token
// secret appears only in the Authorization header, never in errors.

import type { BoxSize } from "../types.ts";

export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<FetchResponse>;

/** Containers or VMs. */
export type GuestType = "lxc" | "qemu";

export interface ProxmoxOptions {
  /** For example https://pve.example.com:8006, with or without /api2/json. */
  readonly apiUrl: string;
  /** user@realm!name */
  readonly tokenId: string;
  readonly tokenSecret: string;
  readonly node: string;
  /** The type of guest the client clones and runs: containers unless it says VMs. */
  readonly type?: GuestType;
  readonly fetch?: FetchLike;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Task poll interval. A linked clone or start finishes in about a second, so polls are close together. */
  readonly taskPollMs?: number;
  readonly taskTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  /** How long a change to a guest keeps trying while another task holds the guest's lock. */
  readonly lockWaitMs?: number;
}

/** Between tries at a guest whose lock another task holds. Proxmox itself waits 10 s for the lock on each. */
const LOCK_RETRY_MS = 1_000;

export class ProxmoxError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  constructor(method: string, path: string, status: number, message: string) {
    super(`Proxmox ${method} ${path} failed (${status}): ${message}`);
    this.name = "ProxmoxError";
    this.status = status;
    this.method = method;
    this.path = path;
  }

  get alreadyExists(): boolean {
    return /already exists/i.test(this.message);
  }

  get notFound(): boolean {
    return this.status === 404 || /does not exist|no such (?:vm|ct|container)/i.test(this.message);
  }

  /** The guest has protection set, which blocks deleting it. */
  get protected(): boolean {
    return /protection mode enabled/i.test(this.message);
  }

  get forbidden(): boolean {
    return this.status === 403;
  }

  /**
   * The guest is not there. The token's rights come from bb-box's pool, so
   * Proxmox answers 403 for a VMID outside it, as for one deleted.
   */
  get gone(): boolean {
    return this.notFound || this.forbidden;
  }

  get unauthorised(): boolean {
    return this.status === 401;
  }

  /** The API could not be reached at all. */
  get unreachable(): boolean {
    return this.status === 0;
  }

  /** Another task held the guest's lock for the 10 s Proxmox waits for it. */
  get locked(): boolean {
    return /can't lock file .* got timeout/i.test(this.message);
  }
}

/** A guest's settings. hostname, swap and net0 are a container's; name and smbios1 a VM's. */
export interface GuestSettings {
  readonly hostname?: string;
  readonly name?: string;
  readonly cores?: number;
  /** The guest's CPU weight against others: 100 by default, as when unset (#888). */
  readonly cpuunits?: number;
  /** MiB */
  readonly memory?: number;
  /** MiB */
  readonly swap?: number;
  readonly net0?: string;
  /** SMBIOS type 1 fields, such as serial=<base64>,base64=1. */
  readonly smbios1?: string;
  readonly tags?: readonly string[];
  readonly description?: string;
  readonly onboot?: boolean;
  /** Whether Proxmox refuses to delete it, as bb-box's templates do. */
  readonly protection?: boolean;
  /** A VM's EFI variable store, such as "local-lvm:1,efitype=4m" for a new one on that storage. */
  readonly efidisk0?: string;
  /** Options to remove, such as "protection", which clones inherit from the template. */
  readonly delete?: readonly string[];
}

export interface GuestStatus {
  readonly vmid: number;
  readonly status: "running" | "stopped" | string;
  readonly name?: string;
  readonly uptime?: number;
  /** The guest's lock, such as "suspended" for a VM hibernated to disk. */
  readonly lock?: string;
}

export interface NodeStatus {
  /** Bytes. */
  readonly memoryTotal: number;
  /** Bytes the node can still give out: MemAvailable where Proxmox reports it, else free. */
  readonly memoryAvailable: number;
  /** The node's CPU threads, or null when Proxmox does not say. */
  readonly cpus: number | null;
}

/** A VNC proxy to a VM's console, for one WebSocket within about 10 s. */
export interface VncProxy {
  readonly port: number;
  /** Authorises the WebSocket. */
  readonly ticket: string;
  /** The console's VNC password, which works for about 30 s after the WebSocket opens. */
  readonly password: string;
}

export interface StorageStatus {
  /** Bytes. */
  readonly total: number;
  readonly available: number;
  /** The storage's type, such as lvmthin, or "" when Proxmox does not say. */
  readonly type: string;
}

export interface StorageConfig {
  readonly type: string;
  readonly shared: boolean;
  readonly path: string | null;
  readonly vgname: string | null;
  readonly thinpool: string | null;
}

export interface ProxmoxSnapshot {
  readonly name: string;
  readonly description: string;
  readonly snaptime: number | null;
  readonly parent: string | null;
  readonly snapstate: string | null;
  readonly vmstate: boolean;
}

export interface PoolGuest {
  readonly vmid: number;
  readonly name: string;
  readonly node: string;
  readonly type: "lxc" | "qemu";
  readonly status: string;
  readonly template: boolean;
  readonly tags: string[];
  /** The guest's CPUs, memory and disk as Proxmox lists them, or null when it does not. A running container's disk is its filesystem's size. */
  readonly size: BoxSize | null;
}

type Params = Record<string, string | number | boolean | undefined>;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(signal!.reason);
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function parseTags(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value.split(/[;,\s]+/).filter(Boolean);
}

/** Size in GiB from a Proxmox size such as 8G, 512M or 1T. */
export function parseSizeGiB(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)([KMGT]?)$/i.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] || "").toUpperCase();
  const factor = unit === "T" ? 1024 : unit === "G" || unit === "" ? 1 : unit === "M" ? 1 / 1024 : 1 / (1024 * 1024);
  return unit === "" ? amount / (1024 * 1024 * 1024) : amount * factor;
}

/** The size in GiB of a guest's root disk, or of its `disk`, from its config, or null when it does not say. */
export function rootDiskGiB(config: Record<string, unknown>, disk = "rootfs"): number | null {
  const size = /(?:^|,)size=([^,]+)/.exec(String(config[disk] ?? ""))?.[1];
  return size ? parseSizeGiB(size) : null;
}

/** A guest's size from Proxmox's maxcpu, maxmem and maxdisk, which give memory and disk in bytes. */
function listedSize(entry: Record<string, unknown>): BoxSize | null {
  const cores = Number(entry.maxcpu);
  const memory = Number(entry.maxmem);
  const disk = Number(entry.maxdisk);
  if (!(cores > 0 && memory > 0)) return null;
  return { cores, memoryMiB: Math.round(memory / 2 ** 20), diskGiB: disk > 0 ? Math.round((disk / 2 ** 30) * 10) / 10 : null };
}

export class Proxmox {
  readonly node: string;
  readonly type: GuestType;
  readonly #base: string;
  readonly #auth: string;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #taskPollMs: number;
  readonly #taskTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #lockWaitMs: number;

  constructor(options: ProxmoxOptions) {
    this.node = options.node;
    this.type = options.type ?? "lxc";
    this.#base = `${options.apiUrl.replace(/\/+$/, "").replace(/\/api2\/json$/, "")}/api2/json`;
    this.#auth = `PVEAPIToken=${options.tokenId}=${options.tokenSecret}`;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#sleep = options.sleep ?? sleep;
    this.#taskPollMs = options.taskPollMs ?? 50;
    this.#taskTimeoutMs = options.taskTimeoutMs ?? 180_000;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#lockWaitMs = options.lockWaitMs ?? 120_000;
  }

  /** Proxmox version, used as a connection check. */
  async version(signal?: AbortSignal): Promise<string> {
    const data = await this.#request<{ version?: string; release?: string }>("GET", "/version", undefined, signal);
    return String(data?.version ?? data?.release ?? "unknown");
  }

  /** Names of the cluster's nodes that are online. */
  async nodes(signal?: AbortSignal): Promise<string[]> {
    const data = await this.#request<Record<string, unknown>[]>("GET", "/nodes", undefined, signal);
    return (data ?? []).filter((entry) => entry.status === undefined || entry.status === "online").map((entry) => String(entry.node));
  }

  async nodeStatus(signal?: AbortSignal): Promise<NodeStatus> {
    const data = await this.#request<{ memory?: Record<string, unknown>; cpuinfo?: Record<string, unknown> }>(
      "GET",
      `/nodes/${enc(this.node)}/status`,
      undefined,
      signal,
    );
    const memory = data?.memory ?? {};
    const total = Number(memory.total ?? 0);
    const available = Number(memory.available ?? memory.free ?? Math.max(0, total - Number(memory.used ?? total)));
    const cpus = Number(data?.cpuinfo?.cpus);
    return { memoryTotal: total, memoryAvailable: available, cpus: Number.isInteger(cpus) && cpus > 0 ? cpus : null };
  }

  async storageStatus(storage: string, signal?: AbortSignal): Promise<StorageStatus> {
    const data = await this.#request<Record<string, unknown>>(
      "GET",
      `/nodes/${enc(this.node)}/storage/${enc(storage)}/status`,
      undefined,
      signal,
    );
    return { total: Number(data?.total ?? 0), available: Number(data?.avail ?? 0), type: typeof data?.type === "string" ? data.type : "" };
  }

  /**
   * Linked clone of a template into the pool, with `hostname` as a
   * container's hostname or a VM's name. Proxmox rejects `storage` for a
   * linked clone, so none is sent. Tags cannot be set here with a pool-scoped
   * token; set them with `configure` once the clone is in the pool.
   */
  async cloneLinked(
    input: { template: number; vmid: number; hostname: string; pool?: string; description?: string },
    signal?: AbortSignal,
  ): Promise<void> {
    const upid = await this.#request<string>(
      "POST",
      this.#guest(input.template, "/clone"),
      { newid: input.vmid, [this.type === "qemu" ? "name" : "hostname"]: input.hostname, full: 0, pool: input.pool, description: input.description },
      signal,
    );
    await this.waitTask(upid, signal);
  }

  /**
   * Full clone of a template into the pool, on `storage`: a copy that needs
   * nothing of the template, for storage where a linked clone would (049).
   */
  async cloneFull(
    input: { template: number; vmid: number; hostname: string; storage: string; pool?: string; description?: string },
    signal?: AbortSignal,
  ): Promise<void> {
    const upid = await this.#request<string>(
      "POST",
      this.#guest(input.template, "/clone"),
      { newid: input.vmid, [this.type === "qemu" ? "name" : "hostname"]: input.hostname, full: 1, storage: input.storage, pool: input.pool, description: input.description },
      signal,
    );
    await this.waitTask(upid, signal);
  }

  /** Makes a stopped guest a template (049), as `pct template` does. */
  async makeTemplate(vmid: number, signal?: AbortSignal): Promise<void> {
    await this.#change("POST", this.#guest(vmid, "/template"), {}, signal);
  }

  async configure(vmid: number, settings: GuestSettings, signal?: AbortSignal): Promise<void> {
    const params: Params = {
      hostname: settings.hostname,
      name: settings.name,
      cores: settings.cores,
      cpuunits: settings.cpuunits,
      memory: settings.memory,
      swap: settings.swap,
      net0: settings.net0,
      smbios1: settings.smbios1,
      tags: settings.tags?.join(";"),
      description: settings.description,
      onboot: settings.onboot === undefined ? undefined : settings.onboot ? 1 : 0,
      protection: settings.protection === undefined ? undefined : settings.protection ? 1 : 0,
      efidisk0: settings.efidisk0,
      delete: settings.delete?.length ? settings.delete.join(",") : undefined,
    };
    if (Object.values(params).every((value) => value === undefined)) return;
    await this.#change("PUT", this.#guest(vmid, "/config"), params, signal);
  }

  /**
   * The VMID and notes of the node's VM named `name`, or null when the token
   * may read no VM of that name: the node's VM list holds only VMs it has
   * VM.Audit on. For a report the host writes in a VM's notes, such as each
   * GPU's memory (#603), which the token reads and cannot change.
   */
  async vmNotes(name: string, signal?: AbortSignal): Promise<{ readonly vmid: number; readonly notes: string } | null> {
    const vms = await this.#request<Record<string, unknown>[]>("GET", `/nodes/${enc(this.node)}/qemu`, undefined, signal);
    const vm = (vms ?? []).find((entry) => entry.name === name);
    if (!vm) return null;
    const vmid = Number(vm.vmid);
    const config = await this.#request<Record<string, unknown>>("GET", `/nodes/${enc(this.node)}/qemu/${vmid}/config`, undefined, signal);
    return { vmid, notes: typeof config?.description === "string" ? config.description : "" };
  }

  async config(vmid: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return (await this.#request<Record<string, unknown>>("GET", this.#guest(vmid, "/config"), undefined, signal)) ?? {};
  }

  /**
   * Grows a guest's root disk to `sizeGiB` if it is smaller: a container's
   * rootfs, or a VM's `disk`, such as scsi0. Proxmox cannot shrink disks. On
   * a running container this takes about a second; on a stopped linked clone
   * it can take much longer. A VM's disk grows as quickly either way.
   */
  async growRootDisk(vmid: number, sizeGiB: number, signal?: AbortSignal, disk = this.type === "qemu" ? "scsi0" : "rootfs"): Promise<boolean> {
    const currentGiB = rootDiskGiB(await this.config(vmid, signal), disk);
    if (currentGiB !== null && currentGiB >= sizeGiB) return false;
    await this.#change("PUT", this.#guest(vmid, "/resize"), { disk, size: `${sizeGiB}G` }, signal);
    return true;
  }

  async start(vmid: number, signal?: AbortSignal): Promise<void> {
    await this.#change("POST", this.#guest(vmid, "/status/start"), {}, signal);
  }

  /**
   * A clean shutdown, as a capture needs (049): the guest stops its services,
   * and is stopped hard after `timeoutS`.
   */
  async shutdown(vmid: number, timeoutS: number, signal?: AbortSignal): Promise<void> {
    await this.#change("POST", this.#guest(vmid, "/status/shutdown"), { timeout: timeoutS, forceStop: 1 }, signal);
  }

  /** Hard stop: boxes are disposable, so there is no clean shutdown wait. */
  async stop(vmid: number, signal?: AbortSignal): Promise<void> {
    await this.#change("POST", this.#guest(vmid, "/status/stop"), {}, signal);
  }

  /**
   * Suspends a VM to disk: its memory goes to a state volume and it stops,
   * locked as `suspended`, so its config cannot change. `start` resumes it,
   * and `destroy` removes it with its state. VMs only.
   */
  async hibernate(vmid: number, signal?: AbortSignal): Promise<void> {
    await this.#change("POST", this.#guest(vmid, "/status/suspend"), { todisk: 1 }, signal);
  }

  /** Null when the guest does not exist. */
  async status(vmid: number, signal?: AbortSignal): Promise<GuestStatus | null> {
    try {
      const data = await this.#request<Record<string, unknown>>(
        "GET",
        this.#guest(vmid, "/status/current"),
        undefined,
        signal,
      );
      return {
        vmid,
        status: String(data?.status ?? "unknown"),
        name: typeof data?.name === "string" ? data.name : undefined,
        uptime: typeof data?.uptime === "number" ? data.uptime : undefined,
        lock: typeof data?.lock === "string" ? data.lock : undefined,
      };
    } catch (error) {
      if (error instanceof ProxmoxError && error.gone) return null;
      throw error;
    }
  }

  /**
   * Stops the guest if it runs, then deletes it and its disks. A missing
   * guest counts as deleted, and a hibernated VM goes with its state.
   */
  async destroy(vmid: number, signal?: AbortSignal): Promise<void> {
    const current = await this.status(vmid, signal);
    if (!current) return;
    if (current.status === "running") {
      try {
        await this.stop(vmid, signal);
      } catch (error) {
        if (!(error instanceof ProxmoxError && error.gone)) throw error;
        return;
      }
    }
    const remove = () => this.#change("DELETE", this.#guest(vmid), { purge: 1, "destroy-unreferenced-disks": 1 }, signal);
    try {
      await remove();
    } catch (error) {
      if (error instanceof ProxmoxError && error.gone) return;
      // A clone keeps the template's protection until it is configured.
      if (!(error instanceof ProxmoxError && error.protected)) throw error;
      await this.configure(vmid, { delete: ["protection"] }, signal);
      await remove();
    }
  }

  /** Opens a VNC proxy to a running VM's console, with a password of its own. */
  async vncProxy(vmid: number, signal?: AbortSignal): Promise<VncProxy> {
    const path = this.#guest(vmid, "/vncproxy");
    const data = await this.#request<Record<string, unknown>>("POST", path, { websocket: true, "generate-password": true }, signal);
    const port = Number(data?.port);
    const { ticket, password } = data ?? {};
    if (!Number.isInteger(port) || typeof ticket !== "string" || typeof password !== "string") {
      throw new ProxmoxError("POST", path, 502, "the answer lacks a port, ticket or password");
    }
    return { port, ticket, password };
  }

  /** Where a WebSocket reaches a VNC proxy, and the headers that authenticate it as this client's token. */
  vncWebSocket(vmid: number, proxy: VncProxy): { url: string; headers: Record<string, string> } {
    const query = new URLSearchParams({ port: String(proxy.port), vncticket: proxy.ticket });
    return { url: `${this.#base.replace(/^http/, "ws")}${this.#guest(vmid, "/vncwebsocket")}?${query}`, headers: { Authorization: this.#auth } };
  }

  startSnapshot(vmid: number, input: { readonly name: string; readonly description: string; readonly memory: boolean }, signal?: AbortSignal): Promise<string> {
    const params: Params = { snapname: input.name, description: input.description, ...(this.type === "qemu" ? { vmstate: input.memory } : {}) };
    return this.#begin("POST", this.#guest(vmid, "/snapshot"), params, signal);
  }

  startSnapshotDelete(vmid: number, name: string, force: boolean, signal?: AbortSignal): Promise<string> {
    return this.#begin("DELETE", this.#guest(vmid, `/snapshot/${enc(name)}`), force ? { force: 1 } : {}, signal);
  }

  startRollback(vmid: number, name: string, signal?: AbortSignal): Promise<string> {
    return this.#begin("POST", this.#guest(vmid, `/snapshot/${enc(name)}/rollback`), {}, signal);
  }

  async snapshotConfig(vmid: number, name: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return (await this.#request<Record<string, unknown>>("GET", this.#guest(vmid, `/snapshot/${enc(name)}/config`), undefined, signal)) ?? {};
  }

  startFullClone(input: { readonly source: number; readonly vmid: number; readonly hostname: string; readonly pool: string; readonly storage: string | null; readonly description: string }, signal?: AbortSignal): Promise<string> {
    return this.#begin(
      "POST",
      this.#guest(input.source, "/clone"),
      { newid: input.vmid, [this.type === "qemu" ? "name" : "hostname"]: input.hostname, full: 1, pool: input.pool, description: input.description, ...(input.storage ? { storage: input.storage } : {}) },
      signal,
    );
  }

  async setNetwork(vmid: number, settings: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<void> {
    if (!Object.keys(settings).length) return;
    await this.#change("PUT", this.#guest(vmid, "/config"), { ...settings }, signal);
  }

  async tasksOfType(type: string, sinceSeconds: number, signal?: AbortSignal): Promise<{ readonly upid: string; readonly vmid: number | null; readonly user: string; readonly start: number; readonly status: string | null }[]> {
    const data = await this.#request<Record<string, unknown>[]>("GET", `/nodes/${enc(this.node)}/tasks`, { typefilter: type, since: sinceSeconds, source: "all", limit: 500 }, signal);
    return (data ?? [])
      .filter((entry) => typeof entry.upid === "string" && entry.type === type)
      .map((entry) => {
        const vmid = Number(entry.id);
        return {
          upid: String(entry.upid),
          vmid: Number.isInteger(vmid) && vmid > 0 ? vmid : null,
          user: typeof entry.user === "string" ? entry.user : "",
          start: Number(entry.starttime ?? 0),
          status: typeof entry.status === "string" && entry.status ? entry.status : null,
        };
      });
  }

  async snapshots(vmid: number, signal?: AbortSignal): Promise<ProxmoxSnapshot[]> {
    const data = await this.#request<Record<string, unknown>[]>("GET", this.#guest(vmid, "/snapshot"), undefined, signal);
    return (data ?? [])
      .filter((entry) => typeof entry.name === "string" && entry.name !== "current")
      .map((entry) => ({
        name: String(entry.name),
        description: typeof entry.description === "string" ? entry.description : "",
        snaptime: typeof entry.snaptime === "number" && entry.snaptime > 0 ? entry.snaptime : null,
        parent: typeof entry.parent === "string" ? entry.parent : null,
        snapstate: typeof entry.snapstate === "string" && entry.snapstate ? entry.snapstate : null,
        vmstate: entry.vmstate === 1 || entry.vmstate === true || entry.vmstate === "1",
      }));
  }

  async taskStatus(upid: string, signal?: AbortSignal): Promise<{ readonly running: boolean; readonly exit: string | null } | null> {
    const node = upid.split(":")[1] || this.node;
    try {
      const data = await this.#request<{ status?: string; exitstatus?: string }>("GET", `/nodes/${enc(node)}/tasks/${enc(upid)}/status`, undefined, signal);
      return { running: data?.status !== "stopped", exit: data?.status === "stopped" ? String(data.exitstatus ?? "") : null };
    } catch (error) {
      if (error instanceof ProxmoxError && (error.status === 404 || (error.status === 500 && /no such task|unable to parse worker upid/i.test(error.message)))) return null;
      throw error;
    }
  }

  async activeTasks(vmid: number, signal?: AbortSignal): Promise<{ readonly upid: string; readonly type: string }[]> {
    const data = await this.#request<Record<string, unknown>[]>("GET", `/nodes/${enc(this.node)}/tasks`, { vmid, source: "active" }, signal);
    return (data ?? []).filter((entry) => typeof entry.upid === "string").map((entry) => ({ upid: String(entry.upid), type: String(entry.type ?? "") }));
  }

  async tasksSince(vmid: number, type: string, sinceSeconds: number, signal?: AbortSignal): Promise<{ readonly upid: string; readonly start: number; readonly status: string | null }[]> {
    const data = await this.#request<Record<string, unknown>[]>("GET", `/nodes/${enc(this.node)}/tasks`, { vmid, typefilter: type, since: sinceSeconds, source: "all" }, signal);
    return (data ?? [])
      .filter((entry) => typeof entry.upid === "string" && entry.type === type)
      .map((entry) => ({ upid: String(entry.upid), start: Number(entry.starttime ?? 0), status: typeof entry.status === "string" ? entry.status : null }));
  }

  async storageConfigs(signal?: AbortSignal): Promise<Map<string, StorageConfig>> {
    const data = await this.#request<Record<string, unknown>[]>("GET", "/storage", undefined, signal);
    return new Map(
      (data ?? [])
        .filter((entry) => typeof entry.storage === "string")
        .map((entry) => [
          String(entry.storage),
          {
            type: String(entry.type ?? ""),
            shared: entry.shared === 1 || entry.shared === true || entry.shared === "1",
            path: typeof entry.path === "string" ? entry.path : null,
            vgname: typeof entry.vgname === "string" ? entry.vgname : null,
            thinpool: typeof entry.thinpool === "string" ? entry.thinpool : null,
          },
        ]),
    );
  }

  async thinPools(signal?: AbortSignal): Promise<{ readonly lv: string; readonly vg: string; readonly metadataSize: number; readonly metadataUsed: number }[]> {
    const data = await this.#request<Record<string, unknown>[]>("GET", `/nodes/${enc(this.node)}/disks/lvmthin`, undefined, signal);
    return (data ?? []).map((entry) => ({ lv: String(entry.lv ?? ""), vg: String(entry.vg ?? ""), metadataSize: Number(entry.metadata_size ?? 0), metadataUsed: Number(entry.metadata_used ?? 0) }));
  }

  async privilegesOn(path: string, signal?: AbortSignal): Promise<Set<string>> {
    const data = await this.#request<Record<string, Record<string, unknown>>>("GET", "/access/permissions", { path }, signal);
    return new Set(Object.keys(data?.[path] ?? {}));
  }

  /** False when the resource pool does not exist. */
  async poolExists(pool: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.#request<unknown>("GET", "/pools", { poolid: pool }, signal);
      return true;
    } catch (error) {
      if (error instanceof ProxmoxError && error.notFound) return false;
      throw error;
    }
  }

  /** False when the node has no such network interface. */
  async interfaceExists(iface: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.#request<unknown>("GET", `/nodes/${enc(this.node)}/network/${enc(iface)}`, undefined, signal);
      return true;
    } catch (error) {
      if (error instanceof ProxmoxError && error.notFound) return false;
      throw error;
    }
  }

  /**
   * Every guest in the pool, with its tags. /cluster/resources lists a guest
   * at once, but gives its name, status and size as Proxmox's status daemon
   * last read them, every 10 s or so: none for a new guest, and the old ones
   * for a while after a change. So they come from each node's own list,
   * which reads them as they are, when the node answers.
   */
  async listPool(pool: string, signal?: AbortSignal): Promise<PoolGuest[]> {
    const data = await this.#request<Record<string, unknown>[]>("GET", "/cluster/resources", { type: "vm" }, signal);
    const listed = (data ?? []).filter((entry) => entry.pool === pool && (entry.type === "lxc" || entry.type === "qemu"));
    const pathOf = (entry: Record<string, unknown>) => `/nodes/${enc(String(entry.node ?? ""))}/${entry.type}`;
    const paths = [...new Set(listed.map(pathOf))];
    const lists = new Map(await Promise.all(paths.map(async (path) => [path, await this.#current(path, signal)] as const)));
    return listed
      .map((entry) => {
        const now = lists.get(pathOf(entry))?.get(Number(entry.vmid));
        const current = now ? { ...entry, name: now.name, status: now.status, template: now.template, maxcpu: now.cpus, maxmem: now.maxmem, maxdisk: now.maxdisk } : entry;
        return {
          vmid: Number(entry.vmid),
          name: String(current.name ?? ""),
          node: String(entry.node ?? ""),
          type: entry.type as "lxc" | "qemu",
          status: String(current.status ?? "unknown"),
          template: current.template === 1 || current.template === true,
          tags: parseTags(entry.tags),
          size: listedSize(current),
        };
      })
      .filter((entry) => Number.isInteger(entry.vmid));
  }

  /** A node's guests of one type by VMID, from `/nodes/<node>/<type>`; none when the node does not answer. */
  async #current(path: string, signal?: AbortSignal): Promise<Map<number, Record<string, unknown>>> {
    try {
      const data = await this.#request<Record<string, unknown>[]>("GET", path, undefined, signal);
      return new Map((data ?? []).map((entry) => [Number(entry.vmid), entry]));
    } catch (error) {
      if (signal?.aborted) throw error;
      return new Map();
    }
  }

  /** Polls a task until it stops. "OK" and "WARNINGS: n" are success. */
  async waitTask(upid: string, signal?: AbortSignal): Promise<void> {
    if (typeof upid !== "string" || !upid.startsWith("UPID:")) return;
    const node = upid.split(":")[1] || this.node;
    const deadline = Date.now() + this.#taskTimeoutMs;
    for (;;) {
      const data = await this.#request<{ status?: string; exitstatus?: string }>(
        "GET",
        `/nodes/${enc(node)}/tasks/${enc(upid)}/status`,
        undefined,
        signal,
      );
      if (data?.status === "stopped") {
        const exit = String(data.exitstatus ?? "");
        if (exit === "OK" || /^WARNINGS: \d+$/.test(exit)) return;
        throw new ProxmoxError("TASK", taskLabel(upid), 500, exit || "task failed");
      }
      if (Date.now() >= deadline) throw new ProxmoxError("TASK", taskLabel(upid), 504, "task did not finish in time");
      await this.#sleep(this.#taskPollMs, signal);
    }
  }

  /**
   * Makes a change to a guest that takes its lock, and waits for its task if
   * it has one. Proxmox waits 10 s for the lock, but a stop can hold it for
   * over a minute while QEMU quits, and the cleanup qmeventd runs after a
   * VM's QEMU exits waits behind a resume and then holds it for about 10 s.
   * So while another task holds the lock, this tries again, for up to
   * `lockWaitMs`.
   */
  async #change(method: "POST" | "PUT" | "DELETE", path: string, params: Params, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.#lockWaitMs;
    for (;;) {
      try {
        return await this.waitTask(await this.#request<string>(method, path, params, signal), signal);
      } catch (error) {
        if (!(error instanceof ProxmoxError && error.locked) || Date.now() >= deadline) throw error;
      }
      await this.#sleep(LOCK_RETRY_MS, signal);
    }
  }

  async #begin(method: "POST" | "DELETE", path: string, params: Params, signal?: AbortSignal): Promise<string> {
    const deadline = Date.now() + this.#lockWaitMs;
    for (;;) {
      try {
        const upid = await this.#request<string>(method, path, params, signal);
        if (typeof upid !== "string" || !upid.startsWith("UPID:")) throw new ProxmoxError(method, path, 502, "the answer has no task");
        return upid;
      } catch (error) {
        if (!(error instanceof ProxmoxError && error.locked) || Date.now() >= deadline) throw error;
      }
      await this.#sleep(LOCK_RETRY_MS, signal);
    }
  }

  /** The path of a guest of the client's type, or of `rest` below it. */
  #guest(vmid: number, rest = ""): string {
    return `/nodes/${enc(this.node)}/${this.type}/${vmid}${rest}`;
  }

  async #request<T>(method: string, path: string, params: Params | undefined, signal?: AbortSignal): Promise<T> {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined) continue;
      form.set(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
    }
    const query = method === "GET" || method === "DELETE" ? form.toString() : "";
    const url = `${this.#base}${path}${query ? `?${query}` : ""}`;
    const headers: Record<string, string> = { Authorization: this.#auth, Accept: "application/json" };
    let body: string | undefined;
    if (method === "POST" || method === "PUT") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = form.toString();
    }
    const timeout = AbortSignal.timeout(this.#requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: FetchResponse;
    try {
      response = await this.#fetch(url, { method, headers, body, signal: combined });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      const reason = timeout.aborted ? "timed out" : fetchFailure(error);
      throw new ProxmoxError(method, path, 0, `cannot reach the Proxmox API: ${reason}`);
    }
    const text = await response.text();
    let parsed: { data?: unknown; message?: unknown; errors?: unknown } | undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const details = [
        response.statusText,
        typeof parsed?.message === "string" ? parsed.message.trim() : "",
        parsed?.errors && typeof parsed.errors === "object"
          ? Object.entries(parsed.errors as Record<string, unknown>).map(([key, value]) => `${key}: ${String(value).trim()}`).join("; ")
          : "",
      ].filter(Boolean);
      const unique = [...new Set(details)].join(" - ") || "request failed";
      throw new ProxmoxError(method, path, response.status, unique.slice(0, 500));
    }
    return parsed?.data as T;
  }
}

/** Why a fetch failed. Node's fetch says only "fetch failed" and puts the reason in `cause`. */
function fetchFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause.message : "";
  return cause && error.message === "fetch failed" ? cause : [error.message, cause].filter(Boolean).join(": ");
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

function taskLabel(upid: string): string {
  // UPID:node:pid:pstart:starttime:type:id:user:
  const parts = upid.split(":");
  return `${parts[5] ?? "task"} ${parts[6] ?? ""}`.trim();
}
