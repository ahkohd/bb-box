// The Proxmox LXC backend. Boxes are unprivileged containers, linked-cloned
// from one CT template per kind into a resource pool, with a VMID from
// bb-box's range and the static address fixed to it. Ownership lives in
// Proxmox tags (and the description, which the clone sets first), so the
// sweep can find every guest even if bb-box's storage is lost. Commands run
// over SSH as the templates' box user; desktops stream over VNC.
//
// The warm pool keeps started guests tagged "warm". Claiming one retags it for
// its box, so a new box is ready as soon as the tags change.

import { Agent, fetch as undiciFetch } from "undici";
import { ReadyPool, type PoolMember, type PoolStore } from "../pool.ts";
import { Proxmox, ProxmoxError, parseTags, type FetchLike, type PoolGuest } from "../proxmox/api.ts";
import {
  BackendError,
  type AcquireHooks,
  type Backend,
  type BackendContext,
  type BoxIdentity,
  type BoxKind,
  type BoxOwner,
  type BoxTransports,
  type DoctorCheck,
  type DoctorReport,
  type Guest,
  type HeldGuest,
  type KindCapabilities,
  type PowerState,
  type VirtualCapacity,
} from "../types.ts";
import { waitUntilAnswers } from "../../transports/ready.ts";
import { KeyFile, Ssh, SshTransport, generateKeyPair, publicKey } from "../../transports/ssh.ts";
import { LXC_KINDS, addressFor, net0For, type LxcConfig, type LxcKind, type LxcKindConfig } from "./config.ts";

const TAG = "bb-box";
const WARM = "warm";
const FILLING = "filling";
const RETIRED = "retired";
const MiB = 2 ** 20;
const GiB = 2 ** 30;
const VNC_PORT = 5900;
const SSH_KEY = "ssh-key";

const KIND_INFO: Record<LxcKind, { label: string; description: string; capabilities: KindCapabilities }> = {
  "linux-headless": {
    label: "Linux headless",
    description: "A Linux container with Docker, for builds, backend services and the agent's own work.",
    capabilities: { os: "linux", desktop: false, gpu: false, docker: true, command: "ssh", display: null, enrol: true },
  },
  "linux-desktop": {
    label: "Linux desktop",
    description: "A Linux desktop on the host's GPU, for computer use, browsers and app development.",
    capabilities: { os: "linux", desktop: true, gpu: true, docker: true, command: "ssh", display: "vnc", enrol: true },
  },
};

const tagPattern = /^[a-z0-9_][a-z0-9_+.-]*$/i;

export function boxTags(box: BoxIdentity): string[] {
  const tags = [TAG, `box.${box.boxId}`, `kind.${box.kind}`, `created.${Math.floor(box.createdAt / 1000)}`];
  if (tagPattern.test(`thread.${box.threadId}`)) tags.splice(1, 0, `thread.${box.threadId}`);
  return tags;
}

/** Written by the clone, before the tags, so an interrupted acquire still names its box. */
export function describe(box: BoxIdentity): string {
  return [
    `bb-box ${box.name}`,
    `box ${box.boxId}`,
    `thread ${box.threadId}`,
    `kind ${box.kind}`,
    `created ${new Date(box.createdAt).toISOString()}`,
  ].join("\n");
}

export function ownerFromTags(tags: readonly string[], name: string | null = null): BoxOwner | null {
  const value = (prefix: string) => tags.find((tag) => tag.startsWith(prefix))?.slice(prefix.length);
  const threadId = value("thread.");
  const boxId = value("box.");
  if (!tags.includes(TAG) || !threadId || !boxId) return null;
  const created = Number(value("created."));
  return {
    boxId,
    threadId,
    name,
    kind: value("kind.") ?? null,
    createdAt: Number.isFinite(created) && created > 0 ? created * 1000 : null,
  };
}

export function ownerFromDescription(text: unknown): BoxOwner | null {
  if (typeof text !== "string" || !text.startsWith("bb-box ")) return null;
  const field = (name: string) => new RegExp(`^${name} (\\S+)$`, "m").exec(text)?.[1];
  const threadId = field("thread");
  const boxId = field("box");
  if (!threadId || !boxId) return null;
  const created = Date.parse(field("created") ?? "");
  return {
    boxId,
    threadId,
    name: field("bb-box") ?? null,
    kind: field("kind") ?? null,
    createdAt: Number.isFinite(created) ? created : null,
  };
}

function size(kind: LxcKindConfig): string {
  return `${kind.cores} ${kind.cores === 1 ? "core" : "cores"}, ${formatMiB(kind.memoryMiB)} memory, ${kind.diskGiB} GiB disk`;
}

function formatMiB(value: number): string {
  if (Math.abs(value) < 1024) return `${Math.round(value)} MiB`;
  return `${(value / 1024).toFixed(1).replace(/\.0$/, "")} GiB`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A fetch that trusts `ca` for the Proxmox API, or the system roots when it is null. */
function proxmoxFetch(ca: string | null): { fetch: FetchLike; close(): Promise<void> } {
  if (!ca) return { fetch: (url, init) => fetch(url, init), close: async () => {} };
  const agent = new Agent({ connect: { ca } });
  return { fetch: (url, init) => undiciFetch(url, { ...init, dispatcher: agent }), close: () => agent.close() };
}

export interface LxcBackendOptions {
  /** Replaces the Proxmox API's fetch; the CA setting is then ignored. */
  readonly fetch?: FetchLike;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly sshBinary?: string;
  /** How long a started box has to answer on SSH. */
  readonly readyTimeoutMs?: number;
}

interface SshAccess {
  readonly ssh: Ssh;
  readonly publicKey: string | null;
  readonly generated: boolean;
}

export class ProxmoxLxcBackend implements Backend {
  readonly id = "proxmox-lxc";
  readonly nature = "virtual" as const;
  readonly label: string;
  readonly #config: LxcConfig;
  readonly #context: BackendContext;
  readonly #options: LxcBackendOptions;
  readonly #http: { fetch: FetchLike; close(): Promise<void> };
  readonly #keyFile = new KeyFile();
  readonly #warm: ReadyPool<BoxIdentity>;
  /** VMIDs this process is cloning into. */
  readonly #reserved = new Set<number>();
  /** Warm guests being prepared, by VMID. */
  readonly #filling = new Map<number, LxcKind>();
  /** Root disk storage of each template. */
  readonly #storages = new Map<number, string>();
  readonly #stopping = new AbortController();
  #api: Promise<Proxmox> | null = null;
  #ssh: Promise<SshAccess> | null = null;
  #maintaining: Promise<void> | null = null;

  constructor(config: LxcConfig, context: BackendContext, options: LxcBackendOptions = {}) {
    this.#config = config;
    this.#context = context;
    this.#options = options;
    this.#http = options.fetch ? { fetch: options.fetch, close: async () => {} } : proxmoxFetch(config.proxmox.caCertificate);
    this.label = `Proxmox LXC on ${config.proxmox.node ?? new URL(config.proxmox.apiUrl).hostname}`;
    this.#warm = new ReadyPool(new WarmStore(this, config.proxmox.pool));
  }

  kinds(): BoxKind[] {
    return LXC_KINDS.filter((kind) => this.#config.kinds[kind].template !== null).map((kind) => ({
      id: kind,
      ...KIND_INFO[kind],
      size: size(this.#config.kinds[kind]),
    }));
  }

  async capacity(kind: string, pending: readonly string[], signal?: AbortSignal): Promise<VirtualCapacity> {
    const config = this.#kind(kind);
    const api = await this.client();
    const guests = await api.listPool(this.#config.proxmox.pool, signal);
    const warm = guests.filter((guest) => this.warmKind(guest) === kind && guest.status === "running").length;
    const waiting = pending.filter((other) => other === kind).length;
    return this.#room(api, kind, config, guests, pending, warm > waiting, warm, signal);
  }

  /** Room for one more guest of `kind`, with `pending` guests still to come. */
  async #room(
    api: Proxmox,
    kind: string,
    config: LxcKindConfig & { template: number },
    guests: readonly PoolGuest[],
    pending: readonly string[],
    fromWarm: boolean,
    warm: number,
    signal?: AbortSignal,
  ): Promise<VirtualCapacity> {
    const storage = await this.#storageOf(api, config.template, signal);
    const [node, disk] = await Promise.all([api.nodeStatus(signal), api.storageStatus(storage, signal)]);
    const reserve = this.#config.reserve;
    const pendingMiB = pending.reduce((sum, other) => sum + (this.#config.kinds[other as LxcKind]?.memoryMiB ?? 0), 0);
    const freeMiB = Math.floor(node.memoryAvailable / MiB) - pendingMiB;
    const freeGiB = Math.floor(disk.available / GiB);
    const result = {
      nature: "virtual" as const,
      host: api.node,
      memory: { freeMiB, reserveMiB: reserve.memoryMiB },
      disk: { freeGiB, reserveGiB: reserve.diskGiB },
      warm,
    };
    const refuse = (text: string): VirtualCapacity => ({ ...result, ok: false, message: text });
    if (fromWarm) return { ...result, ok: true, message: null };
    if (freeMiB - config.memoryMiB < reserve.memoryMiB) {
      return refuse(
        `${api.node} has ${formatMiB(freeMiB)} of memory free. A ${kind} box needs ${formatMiB(config.memoryMiB)} and ${formatMiB(reserve.memoryMiB)} is kept free. ` +
          `Release a box, or lower the ${kind} memory or the memory kept free in bb-box's settings.`,
      );
    }
    if (freeGiB < reserve.diskGiB) {
      return refuse(
        `The ${storage} storage on ${api.node} has ${freeGiB} GiB free, less than the ${reserve.diskGiB} GiB kept free. ` +
          `Release boxes, free some space, or lower the disk kept free in bb-box's settings.`,
      );
    }
    if (this.#freeVmid(guests) === null) {
      return refuse(
        `Every VMID from ${this.#config.vmids.first} to ${this.#config.vmids.last} is in use. Release a box, or widen the VMID range in bb-box's settings.`,
      );
    }
    return { ...result, ok: true, message: null };
  }

  async acquire(box: BoxIdentity, previous: Guest | null, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest> {
    const kind = this.#kind(box.kind);
    const api = await this.client();
    const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      try {
        return await run();
      } finally {
        hooks.timing(name, Math.round(performance.now() - started));
      }
    };
    let vmid: number | null = null;
    let claimed: number | null = null;
    const claim = async (id: number) => {
      claimed = id;
      await hooks.claim(this.#guest(id));
    };
    try {
      if (previous && this.#inRange(Number(previous.ref)) && (await this.#owns(api, Number(previous.ref), box.boxId, signal))) {
        vmid = Number(previous.ref);
      }
      let warm = false;
      if (vmid === null) {
        const member = await step("warm", () =>
          this.#warm.claim(box.kind, box, { before: (candidate) => claim(Number(candidate.ref)), signal }),
        );
        if (member) {
          vmid = Number(member.ref);
          warm = true;
          this.#kick();
        }
      }
      if (vmid === null) {
        vmid = await step("clone", () => this.#clone(api, kind.template, box.name, describe(box), claim, signal));
      }
      const id = vmid;
      if (!warm) {
        await step("configure", async () => {
          await api.configure(
            id,
            { cores: kind.cores, memory: kind.memoryMiB, net0: net0For(this.#config, id), tags: boxTags(box), onboot: true },
            signal,
          );
          await api.growRootDisk(id, kind.diskGiB, signal);
        });
      }
      await hooks.starting();
      await step("start", async () => {
        if ((await api.status(id, signal))?.status !== "running") await api.start(id, signal);
      });
      await step("ready", () => this.#waitReady(id, box.kind, signal));
      return this.#guest(id);
    } catch (error) {
      // A clone cut short may still have made the guest; it is ours if it names the box.
      const leftover = vmid ?? claimed;
      if (leftover !== null && (vmid !== null || (await this.#owns(api, leftover, box.boxId).catch(() => false)))) {
        await api.destroy(leftover).catch((cause) => this.#context.logError("release after a failed acquire", cause));
      }
      throw error;
    }
  }

  async release(guest: Guest, signal?: AbortSignal): Promise<void> {
    await (await this.client()).destroy(this.#vmid(guest), signal);
  }

  async power(guest: Guest, signal?: AbortSignal): Promise<PowerState | null> {
    const status = await (await this.client()).status(this.#vmid(guest), signal);
    if (!status) return null;
    return status.status === "running" ? "running" : "stopped";
  }

  async start(guest: Guest, signal?: AbortSignal): Promise<void> {
    const vmid = this.#vmid(guest);
    const api = await this.client();
    const status = await api.status(vmid, signal);
    if (!status) throw new BackendError("gone", `Container ${vmid} no longer exists.`);
    if (status.status !== "running") await api.start(vmid, signal);
    await this.#waitReady(vmid, null, signal);
  }

  async stop(guest: Guest, signal?: AbortSignal): Promise<void> {
    const vmid = this.#vmid(guest);
    const api = await this.client();
    if ((await api.status(vmid, signal))?.status === "running") await api.stop(vmid, signal);
  }

  async held(signal?: AbortSignal): Promise<HeldGuest[]> {
    const api = await this.client();
    const held: HeldGuest[] = [];
    for (const guest of await api.listPool(this.#config.proxmox.pool, signal)) {
      if (guest.type !== "lxc" || guest.template || !this.#inRange(guest.vmid)) continue;
      if (this.#reserved.has(guest.vmid) || this.#filling.has(guest.vmid) || guest.tags.includes(WARM)) continue;
      let owner = ownerFromTags(guest.tags, guest.name || null);
      if (!owner && !guest.tags.includes(FILLING) && !guest.tags.includes(RETIRED)) {
        const config = await api.config(guest.vmid, signal).catch((): Record<string, unknown> => ({}));
        owner = ownerFromDescription(config.description);
      }
      held.push({
        ref: String(guest.vmid),
        address: addressFor(this.#config, guest.vmid),
        owner,
        power: guest.status === "running" ? "running" : "stopped",
      });
    }
    return held;
  }

  async transports(guest: Guest, kind: string): Promise<BoxTransports> {
    const vmid = this.#vmid(guest);
    const address = addressFor(this.#config, vmid)!;
    const display = KIND_INFO[kind as LxcKind]?.capabilities.display === "vnc" ? { protocol: "vnc" as const, host: address, port: VNC_PORT } : null;
    return { command: await this.#command(vmid), display };
  }

  async doctor(signal?: AbortSignal): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    const notes: string[] = [];
    const pass = (name: string, detail: string) => checks.push({ name, ok: true, detail, fix: null });
    const fail = (name: string, detail: string, fix: string) => checks.push({ name, ok: false, detail, fix });
    const skip = (...names: string[]) => {
      for (const name of names) checks.push({ name, ok: null, detail: "Skipped until the checks above pass.", fix: null });
    };
    const kinds = LXC_KINDS.filter((kind) => this.#config.kinds[kind].template !== null);
    const later = ["Node", "Node memory", "Resource pool", ...kinds.map((kind) => `${kind} template`), "Network bridge", "VMID range"];
    let version = "";

    try {
      version = await this.#bare().version(signal);
      pass("Proxmox API", `Proxmox VE ${version} at ${new URL(this.#config.proxmox.apiUrl).host}.`);
    } catch (error) {
      const unauthorised = error instanceof ProxmoxError && error.unauthorised;
      fail(
        "Proxmox API",
        message(error),
        unauthorised
          ? "Check the API token ID and secret in bb-box's settings."
          : "Check the API URL, and that BB's server can reach it. For a certificate from a private CA, set the CA certificate.",
      );
      skip(...later);
    }

    let api: Proxmox | null = null;
    if (version) {
      try {
        api = await this.client();
        pass("Node", `Boxes run on ${api.node}.`);
      } catch (error) {
        fail("Node", message(error), "Set the node in bb-box's settings to one the API lists.");
        skip(...later.slice(1));
      }
    }

    if (api) {
      const node = api.node;
      const audit = (error: unknown, fix: string) => (error instanceof ProxmoxError && error.forbidden ? fix : `${fix} (${message(error)})`);
      try {
        const status = await api.nodeStatus(signal);
        pass("Node memory", `${formatMiB(status.memoryAvailable / MiB)} of ${formatMiB(status.memoryTotal / MiB)} available.`);
      } catch (error) {
        fail("Node memory", message(error), audit(error, `Give the token Sys.Audit on /nodes/${node}; the capacity guard needs it.`));
      }

      const pool = this.#config.proxmox.pool;
      try {
        if (await api.poolExists(pool, signal)) pass("Resource pool", `Pool ${pool} exists.`);
        else fail("Resource pool", `Pool ${pool} does not exist.`, `Create it (pveum pool add ${pool}) and give the token rights on it.`);
      } catch (error) {
        fail("Resource pool", message(error), audit(error, `Give the token Pool.Audit on /pool/${pool}.`));
      }

      for (const kind of kinds) {
        const template = this.#config.kinds[kind].template!;
        const name = `${kind} template`;
        try {
          const config = await api.config(template, signal);
          const storage = String(config.rootfs ?? "").split(":")[0];
          if (config.template !== 1 && config.template !== "1") {
            fail(name, `CT ${template} is not a template.`, `Convert it with pct template ${template}.`);
          } else if (KIND_INFO[kind].capabilities.docker && !/(?:^|,)nesting=1(?:,|$)/.test(String(config.features ?? ""))) {
            fail(name, `CT template ${template} does not have nesting, which Docker needs.`, `Run pct set ${template} --features nesting=1 as root.`);
          } else if (!storage) {
            fail(name, `CT template ${template} has no root disk.`, "Rebuild the template with the setup script.");
          } else {
            const disk = await api.storageStatus(storage, signal).catch((error: unknown) => error);
            if (disk instanceof Error) {
              fail(name, `CT template ${template} is on ${storage}, whose free space cannot be read.`, audit(disk, `Give the token Datastore.Audit on /storage/${storage}.`));
            } else {
              this.#storages.set(template, storage);
              pass(name, `CT template ${template} on ${storage}, ${Math.floor((disk as { available: number }).available / GiB)} GiB free.`);
            }
          }
        } catch (error) {
          const missing = error instanceof ProxmoxError && error.notFound;
          fail(
            name,
            missing ? `CT ${template} does not exist on ${node}.` : message(error),
            missing
              ? `Build the ${kind} template with the setup script, or set its VMID in bb-box's settings.`
              : audit(error, `Give the token VM.Audit and VM.Clone on /vms/${template}.`),
          );
        }
      }

      const bridge = this.#config.network.bridge;
      try {
        if (await api.interfaceExists(bridge, signal)) pass("Network bridge", `${bridge} exists on ${node}.`);
        else fail("Network bridge", `${node} has no ${bridge}.`, "Create the bridge with the host setup script, or set the bridge in bb-box's settings.");
      } catch (error) {
        fail("Network bridge", message(error), audit(error, `Give the token Sys.Audit on /nodes/${node}.`));
      }

      try {
        const guests = await api.listPool(pool, signal);
        const { first, last } = this.#config.vmids;
        const used = guests.filter((guest) => this.#inRange(guest.vmid)).length;
        const total = last - first + 1;
        if (used < total) pass("VMID range", `${total - used} of ${total} VMIDs from ${first} to ${last} are free.`);
        else fail("VMID range", `All ${total} VMIDs from ${first} to ${last} are in use.`, "Release boxes, or widen the VMID range.");
      } catch (error) {
        fail("VMID range", message(error), audit(error, `Give the token VM.Audit on /pool/${pool}.`));
      }
    }

    try {
      const access = await this.#sshAccess();
      if (access.publicKey) {
        notes.push(
          `Box user ${this.#config.ssh.user} in each template must accept this SSH key in ~/.ssh/authorized_keys: ${access.publicKey}`,
        );
        pass("SSH key", access.generated ? "bb-box made a key; its public key is below." : "From bb-box's settings; its public key is below.");
      } else {
        fail("SSH key", "ssh-keygen cannot read the SSH private key in bb-box's settings.", "Paste the whole private key, or clear the setting so bb-box makes one.");
      }
    } catch (error) {
      fail("SSH key", message(error), "Check the SSH private key in bb-box's settings, or clear it so bb-box makes one.");
    }

    const ok = checks.every((check) => check.ok !== false);
    const first = checks.find((check) => check.ok === false);
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

  /** The warm kind of a guest that is ready in the warm pool, or null. */
  warmKind(guest: PoolGuest): LxcKind | null {
    if (guest.type !== "lxc" || guest.template || !this.#inRange(guest.vmid) || this.#filling.has(guest.vmid)) return null;
    if (!guest.tags.includes(WARM)) return null;
    const kind = guest.tags.find((tag) => tag.startsWith("kind."))?.slice(5);
    return LXC_KINDS.includes(kind as LxcKind) ? (kind as LxcKind) : null;
  }

  /** Retags a warm guest for its box. The guest keeps running. */
  async hold(member: PoolMember, box: BoxIdentity, signal?: AbortSignal): Promise<void> {
    const kind = this.#kind(box.kind);
    await (await this.client()).configure(
      Number(member.ref),
      { hostname: box.name, cores: kind.cores, memory: kind.memoryMiB, tags: boxTags(box), description: describe(box) },
      signal,
    );
  }

  addressOf(vmid: number): string | null {
    return addressFor(this.#config, vmid);
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

  #kind(kind: string): LxcKindConfig & { template: number } {
    const config = this.#config.kinds[kind as LxcKind];
    if (!config || config.template === null) throw new BackendError("unsupported", `${this.label} has no ${kind} boxes.`);
    return config as LxcKindConfig & { template: number };
  }

  #inRange(vmid: number): boolean {
    return Number.isInteger(vmid) && vmid >= this.#config.vmids.first && vmid <= this.#config.vmids.last;
  }

  #vmid(guest: Guest): number {
    const vmid = Number(guest.ref);
    if (!this.#inRange(vmid)) throw new Error(`Guest ${guest.ref} is outside bb-box's VMID range, so bb-box leaves it alone.`);
    return vmid;
  }

  #guest(vmid: number): Guest {
    return { ref: String(vmid), address: addressFor(this.#config, vmid) };
  }

  #freeVmid(guests: readonly PoolGuest[]): number | null {
    const used = new Set<number>([...this.#reserved, ...this.#filling.keys(), ...guests.map((guest) => guest.vmid)]);
    for (let vmid = this.#config.vmids.first; vmid <= this.#config.vmids.last; vmid++) if (!used.has(vmid)) return vmid;
    return null;
  }

  async #owns(api: Proxmox, vmid: number, boxId: string, signal?: AbortSignal): Promise<boolean> {
    if (!(await api.status(vmid, signal))) return false;
    const config = await api.config(vmid, signal);
    const owner = ownerFromTags(parseTags(config.tags)) ?? ownerFromDescription(config.description);
    return owner?.boxId === boxId;
  }

  async #storageOf(api: Proxmox, template: number, signal?: AbortSignal): Promise<string> {
    const cached = this.#storages.get(template);
    if (cached) return cached;
    let rootfs: string;
    try {
      rootfs = String((await api.config(template, signal)).rootfs ?? "");
    } catch (error) {
      if (error instanceof ProxmoxError && error.notFound) throw new Error(`CT template ${template} does not exist on ${api.node}. Run the doctor check in bb-box's panel.`);
      throw error;
    }
    const storage = rootfs.split(":")[0];
    if (!storage) throw new Error(`CT template ${template} has no root disk.`);
    this.#storages.set(template, storage);
    return storage;
  }

  /**
   * Linked-clones `template` into the first free VMID. `before` runs before
   * each attempt. A VMID another guest has taken is skipped.
   */
  async #clone(
    api: Proxmox,
    template: number,
    hostname: string,
    description: string,
    before: (vmid: number) => Promise<void>,
    signal: AbortSignal,
  ): Promise<number> {
    const guests = await api.listPool(this.#config.proxmox.pool, signal);
    const skipped = new Set<number>();
    for (;;) {
      const vmid = this.#freeVmid([...guests, ...[...skipped].map((id) => ({ vmid: id }) as PoolGuest)]);
      if (vmid === null) {
        throw new BackendError(
          "no_capacity",
          `Every VMID from ${this.#config.vmids.first} to ${this.#config.vmids.last} is in use. Release a box, or widen the VMID range in bb-box's settings.`,
        );
      }
      this.#reserved.add(vmid);
      try {
        await before(vmid);
        await api.cloneLinked({ template, vmid, hostname, pool: this.#config.proxmox.pool, description }, signal);
        return vmid;
      } catch (error) {
        if (error instanceof ProxmoxError && error.alreadyExists) {
          skipped.add(vmid);
          continue;
        }
        throw error;
      } finally {
        this.#reserved.delete(vmid);
      }
    }
  }

  async #command(vmid: number): Promise<SshTransport> {
    const address = addressFor(this.#config, vmid);
    if (!address) throw new Error(`VMID ${vmid} has no address.`);
    return new SshTransport((await this.#sshAccess()).ssh, address, "linux");
  }

  async #waitReady(vmid: number, kind: string | null, signal?: AbortSignal): Promise<void> {
    const timeoutMs = this.#options.readyTimeoutMs ?? 120_000;
    const ready = await waitUntilAnswers(await this.#command(vmid), { timeoutMs, signal, sleep: this.#options.sleep });
    if (!ready) {
      throw new Error(
        `SSH on ${addressFor(this.#config, vmid)} did not answer within ${Math.round(timeoutMs / 1000)} s. ` +
          `Check that the ${kind ?? "box's"} template starts sshd on port 22 and that user ${this.#config.ssh.user} accepts bb-box's key.`,
      );
    }
  }

  #sshAccess(): Promise<SshAccess> {
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
        return { ssh: new Ssh({ keyPath, user: this.#config.ssh.user, binary: this.#options.sshBinary }), publicKey: publicText, generated };
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
    if (!LXC_KINDS.some((kind) => this.#config.kinds[kind].warm > 0)) return;
    this.maintain(this.#stopping.signal).catch((error) => this.#context.logError("warm pool", error));
  }

  async #topUp(signal: AbortSignal): Promise<void> {
    const api = await this.client();
    const pool = this.#config.proxmox.pool;
    // Retire warm guests beyond the target, or of a kind that is off, while no claim runs.
    const retired = await this.#warm.exclusive(async () => {
      const guests = await api.listPool(pool, signal);
      const out: number[] = [];
      for (const kind of LXC_KINDS) {
        const config = this.#config.kinds[kind];
        const target = config.template === null ? 0 : config.warm;
        const warm = guests.filter((guest) => this.warmKind(guest) === kind);
        const running = warm.filter((guest) => guest.status === "running");
        const extra = [...warm.filter((guest) => guest.status !== "running"), ...running.slice(target)];
        for (const guest of extra) {
          await api.configure(guest.vmid, { tags: [TAG, RETIRED] }, signal);
          out.push(guest.vmid);
        }
      }
      return out;
    });
    for (const vmid of retired) await api.destroy(vmid, signal).catch((error) => this.#context.logError("retire a warm box", error));

    for (const kind of LXC_KINDS) {
      const config = this.#config.kinds[kind];
      if (config.template === null || config.warm === 0) continue;
      const guests = await api.listPool(pool, signal);
      const ready = guests.filter((guest) => this.warmKind(guest) === kind && guest.status === "running").length;
      const filling = [...this.#filling.values()].filter((other) => other === kind).length;
      for (let missing = config.warm - ready - filling; missing > 0; missing--) {
        signal.throwIfAborted();
        const room = await this.#room(api, kind, config as LxcKindConfig & { template: number }, await api.listPool(pool, signal), [], false, 0, signal);
        if (!room.ok) {
          this.#context.logError("warm pool", new Error(room.message ?? "No room for a warm box."));
          break;
        }
        await this.#fill(api, kind, config as LxcKindConfig & { template: number }, signal);
      }
    }
  }

  async #fill(api: Proxmox, kind: LxcKind, config: LxcKindConfig & { template: number }, signal: AbortSignal): Promise<void> {
    let vmid: number | null = null;
    const claimed: number[] = [];
    try {
      vmid = await this.#clone(
        api,
        config.template,
        "bb-box-warm",
        `bb-box warm ${kind}`,
        async (id) => {
          this.#filling.set(id, kind);
          claimed.push(id);
        },
        signal,
      );
      await api.configure(
        vmid,
        { cores: config.cores, memory: config.memoryMiB, net0: net0For(this.#config, vmid), tags: [TAG, FILLING, `kind.${kind}`], onboot: true },
        signal,
      );
      await api.growRootDisk(vmid, config.diskGiB, signal);
      await api.start(vmid, signal);
      await this.#waitReady(vmid, kind, signal);
      await api.configure(vmid, { tags: [TAG, WARM, `kind.${kind}`] }, signal);
    } catch (error) {
      if (vmid !== null) await api.destroy(vmid).catch((cause) => this.#context.logError("release a failed warm box", cause));
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

  constructor(backend: ProxmoxLxcBackend, pool: string) {
    this.#backend = backend;
    this.#pool = pool;
  }

  async members(signal?: AbortSignal): Promise<PoolMember[]> {
    const api = await this.#backend.client();
    const members: PoolMember[] = [];
    for (const guest of await api.listPool(this.#pool, signal)) {
      const kind = this.#backend.warmKind(guest);
      if (!kind || guest.status !== "running") continue;
      members.push({ ref: String(guest.vmid), address: this.#backend.addressOf(guest.vmid), kinds: [kind], free: true });
    }
    return members;
  }

  hold(member: PoolMember, box: BoxIdentity, signal?: AbortSignal): Promise<void> {
    return this.#backend.hold(member, box, signal);
  }
}
