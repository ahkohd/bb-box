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
}

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
}

/** A guest's settings. hostname, swap and net0 are a container's; name and smbios1 a VM's. */
export interface GuestSettings {
  readonly hostname?: string;
  readonly name?: string;
  readonly cores?: number;
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
  /** Options to remove, such as "protection", which clones inherit from the template. */
  readonly delete?: readonly string[];
}

export interface GuestStatus {
  readonly vmid: number;
  readonly status: "running" | "stopped" | string;
  readonly name?: string;
  readonly uptime?: number;
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
}

export interface PoolGuest {
  readonly vmid: number;
  readonly name: string;
  readonly node: string;
  readonly type: "lxc" | "qemu";
  readonly status: string;
  readonly template: boolean;
  readonly tags: string[];
  /** From the listing's maxcpu, maxmem and maxdisk, or null when it lacks them. */
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

/** A guest's size from /cluster/resources, which gives memory and disk in bytes. */
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
    return { total: Number(data?.total ?? 0), available: Number(data?.avail ?? 0) };
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

  async configure(vmid: number, settings: GuestSettings, signal?: AbortSignal): Promise<void> {
    const params: Params = {
      hostname: settings.hostname,
      name: settings.name,
      cores: settings.cores,
      memory: settings.memory,
      swap: settings.swap,
      net0: settings.net0,
      smbios1: settings.smbios1,
      tags: settings.tags?.join(";"),
      description: settings.description,
      onboot: settings.onboot === undefined ? undefined : settings.onboot ? 1 : 0,
      delete: settings.delete?.length ? settings.delete.join(",") : undefined,
    };
    if (Object.values(params).every((value) => value === undefined)) return;
    const result = await this.#request<unknown>("PUT", this.#guest(vmid, "/config"), params, signal);
    if (typeof result === "string" && result.startsWith("UPID:")) await this.waitTask(result, signal);
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
    const result = await this.#request<unknown>(
      "PUT",
      this.#guest(vmid, "/resize"),
      { disk, size: `${sizeGiB}G` },
      signal,
    );
    if (typeof result === "string" && result.startsWith("UPID:")) await this.waitTask(result, signal);
    return true;
  }

  async start(vmid: number, signal?: AbortSignal): Promise<void> {
    const upid = await this.#request<string>("POST", this.#guest(vmid, "/status/start"), {}, signal);
    await this.waitTask(upid, signal);
  }

  /** Hard stop: boxes are disposable, so there is no clean shutdown wait. */
  async stop(vmid: number, signal?: AbortSignal): Promise<void> {
    const upid = await this.#request<string>("POST", this.#guest(vmid, "/status/stop"), {}, signal);
    await this.waitTask(upid, signal);
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
      };
    } catch (error) {
      if (error instanceof ProxmoxError && error.gone) return null;
      throw error;
    }
  }

  /** Stops the guest if it runs, then deletes it and its disks. A missing guest counts as deleted. */
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
    const remove = async () => {
      const upid = await this.#request<string>(
        "DELETE",
        this.#guest(vmid),
        { purge: 1, "destroy-unreferenced-disks": 1 },
        signal,
      );
      await this.waitTask(upid, signal);
    };
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

  /** Every guest in the pool, with its tags, in one call. */
  async listPool(pool: string, signal?: AbortSignal): Promise<PoolGuest[]> {
    const data = await this.#request<Record<string, unknown>[]>("GET", "/cluster/resources", { type: "vm" }, signal);
    return (data ?? [])
      .filter((entry) => entry.pool === pool && (entry.type === "lxc" || entry.type === "qemu"))
      .map((entry) => ({
        vmid: Number(entry.vmid),
        name: String(entry.name ?? ""),
        node: String(entry.node ?? ""),
        type: entry.type as "lxc" | "qemu",
        status: String(entry.status ?? "unknown"),
        template: entry.template === 1 || entry.template === true,
        tags: parseTags(entry.tags),
        size: listedSize(entry),
      }))
      .filter((entry) => Number.isInteger(entry.vmid));
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
