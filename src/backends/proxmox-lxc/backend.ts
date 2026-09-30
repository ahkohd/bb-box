// The Proxmox LXC backend. Boxes are unprivileged containers, linked-cloned
// from one CT template per kind into a resource pool, with a VMID from
// bb-box's range and the static address fixed to it. Ownership lives in
// Proxmox tags (and the description, which the clone sets first), so the
// sweep can find every guest even if bb-box's storage is lost. Commands run
// over SSH as the templates' box user; desktops stream over VNC.
//
// An acquire clones, configures (dropping the protection clones inherit),
// tags, starts, grows the disk if asked (quick only while running), waits for
// port 22 and then for SSH. Proxmox tasks are polled every 50 ms.
//
// Three flavours of template serve four kinds: linux-headless and
// linux-headless-docker are clones of a headless template, linux-desktop of a
// GPU desktop template and linux-desktop-cpu of a CPU-only one. A new box is
// cloned from its flavour's least used template; a GPU desktop goes to the
// GPU with the fewest desktops. Every guest carries a "template.<vmid>" tag,
// which is how that use is counted. The warm pool keeps started guests of
// each flavour, tagged "warm". Claiming one retags it for its box, so a new
// box is ready as soon as the tags change.

import type { TLSSocket } from "node:tls";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";
import { ReadyPool, type PoolStore } from "../pool.ts";
import { Proxmox, ProxmoxError, parseTags, rootDiskGiB, type FetchLike, type PoolGuest } from "../proxmox/api.ts";
import {
  BackendError,
  type AcquireHooks,
  type Backend,
  type BackendContext,
  type BoxIdentity,
  type BoxKind,
  type BoxOwner,
  type BoxTransports,
  type Capacity,
  type CommandCapability,
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
import { waitForPort, waitUntilAnswers, type PortCheck } from "../../transports/ready.ts";
import { KeyFile, Ssh, SshTransport, generateKeyPair, publicKey } from "../../transports/ssh.ts";
import type { Display, SshAccess } from "../../transports/types.ts";
import {
  FLAVOUR_KINDS,
  LXC_FLAVOURS,
  addressFor,
  flavourOf,
  net0For,
  type LxcConfig,
  type LxcFlavour,
  type LxcFlavourConfig,
  type LxcTemplate,
} from "./config.ts";

const TAG = "bb-box";
const WARM = "warm";
const FILLING = "filling";
const RETIRED = "retired";
const MiB = 2 ** 20;
const GiB = 2 ** 30;
const VNC_PORT = 5900;
/** The desktop template writes a fresh VNC password here, readable by the box user. */
const VNC_PASSWORD_FILE = "/var/lib/bb-box/vnc-password";
const SSH_KEY = "ssh-key";
/** Where the next VMID search starts. */
const NEXT_VMID = "next-vmid";
/** Clone, start and SSH answering take a few seconds; this leaves room for a busy host. */
const READY_TIMEOUT_MS = 30_000;

/** The Cua Driver the desktop template pins, run by the box user's service. */
const CUA_DRIVER: ComputerUse = { driver: "cua", version: "0.28.3", socket: "/home/box/.cache/cua-driver/cua-driver.sock" };
const SSH_COMMAND: CommandCapability = { transport: "ssh", shell: "sh", admin: true, inDesktopSession: false, streaming: true };

/** The kinds, less their size, which comes from their flavour's settings. */
const OFFERS: readonly (Omit<BoxKind, "size"> & { readonly flavour: LxcFlavour })[] = [
  {
    id: "linux-headless",
    flavour: "headless",
    label: "Linux headless",
    description: "A Linux container for builds, backend services and the agent's own work.",
    requires: [],
    capabilities: { os: "linux", arch: "x86_64", gpu: false, features: ["docker"], command: SSH_COMMAND, displays: [], computerUse: null, enrol: true },
    readyTimeoutMs: READY_TIMEOUT_MS,
  },
  {
    id: "linux-headless-docker",
    flavour: "headless",
    label: "Linux headless with Docker",
    description: "A Linux container with Docker inside, for builds and services that need it.",
    requires: ["docker"],
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
      displays: [{ id: "desktop", protocol: "rfb", resizable: true }],
      computerUse: CUA_DRIVER,
      enrol: true,
    },
    readyTimeoutMs: READY_TIMEOUT_MS,
  },
  {
    id: "linux-desktop-cpu",
    flavour: "desktop-cpu",
    label: "Linux desktop on the CPU",
    description:
      "A Linux desktop drawn by the CPU, for computer use and browsers when no GPU is needed or free. Graphics are slower; WebGL and Vulkan still work.",
    requires: [],
    capabilities: {
      os: "linux",
      arch: "x86_64",
      gpu: false,
      features: ["docker"],
      command: SSH_COMMAND,
      displays: [{ id: "desktop", protocol: "rfb", resizable: true }],
      computerUse: CUA_DRIVER,
      enrol: true,
    },
    readyTimeoutMs: READY_TIMEOUT_MS,
  },
];

/** The tag that says which template a guest is a clone of. */
function templateTag(template: number): string {
  return `template.${template}`;
}

export function templateFromTags(tags: readonly string[]): number | null {
  const vmid = Number(tags.find((tag) => /^template\.\d+$/.test(tag))?.slice(9));
  return Number.isInteger(vmid) && vmid > 0 ? vmid : null;
}

/** How the doctor names each flavour's templates. */
const FLAVOUR_NAMES: Readonly<Record<LxcFlavour, string>> = { headless: "Headless", desktop: "GPU desktop", "desktop-cpu": "CPU desktop" };

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

const tagPattern = /^[a-z0-9_][a-z0-9_+.-]*$/i;

export function boxTags(box: BoxIdentity, template: number | null): string[] {
  const tags = [TAG, `box.${box.boxId}`, `kind.${box.kind}`, `created.${Math.floor(box.createdAt / 1000)}`];
  if (tagPattern.test(`thread.${box.threadId}`)) tags.splice(1, 0, `thread.${box.threadId}`);
  if (template !== null) tags.push(templateTag(template));
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

/** `templateDiskGiB` is the templates' own disk, when known. */
function size(config: LxcFlavourConfig, templateDiskGiB: number | null): string {
  const cores = `${config.cores} ${config.cores === 1 ? "core" : "cores"}`;
  const disk = Math.max(config.diskGiB ?? 0, templateDiskGiB ?? 0);
  return `${cores}, ${formatMiB(config.memoryMiB)} memory, ${disk ? `${Math.round(disk)} GiB disk` : "the template's disk"}`;
}

function formatMiB(value: number): string {
  if (Math.abs(value) < 1024) return `${Math.round(value)} MiB`;
  return `${(value / 1024).toFixed(1).replace(/\.0$/, "")} GiB`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A fetch for the Proxmox API. With a fingerprint it trusts that certificate
 * alone, which suits Proxmox's self-signed one; otherwise it trusts `ca`, or
 * the system roots when that is null.
 */
function proxmoxFetch(tls: { ca: string | null; fingerprint: string | null }): { fetch: FetchLike; close(): Promise<void> } {
  let agent: Agent;
  if (tls.fingerprint) {
    const expected = tls.fingerprint;
    // No cached sessions: a resumed session may not carry the certificate to check.
    const connect = buildConnector({ rejectUnauthorized: false, maxCachedSessions: 0 });
    agent = new Agent({
      connect: (options, callback) =>
        connect(options, (error, socket) => {
          if (error) return callback(error, null);
          if (options.protocol !== "https:") return callback(null, socket!);
          const actual = (socket as TLSSocket).getPeerCertificate().fingerprint256;
          if (actual === expected) return callback(null, socket!);
          socket!.destroy();
          callback(
            new Error(
              `the API's certificate has SHA-256 fingerprint ${actual || "(none)"}, not the one in bb-box's settings. ` +
                "If the certificate was renewed, set the new fingerprint.",
            ),
            null,
          );
        }),
    });
  } else if (tls.ca) {
    agent = new Agent({ connect: { ca: tls.ca } });
  } else {
    return { fetch: (url, init) => fetch(url, init), close: async () => {} };
  }
  return { fetch: (url, init) => undiciFetch(url, { ...init, dispatcher: agent }), close: () => agent.close() };
}

export interface LxcBackendOptions {
  /** Replaces the Proxmox API's fetch; the TLS settings are then ignored. */
  readonly fetch?: FetchLike;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly sshBinary?: string;
  /** Replaces the TCP check for port 22, for tests. */
  readonly portCheck?: PortCheck;
  /** Replaces each kind's readyTimeoutMs, for tests. */
  readonly readyTimeoutMs?: number;
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

export class ProxmoxLxcBackend implements Backend {
  readonly id = "proxmox-lxc";
  readonly nature = "virtual" as const;
  readonly label: string;
  readonly #config: LxcConfig;
  readonly #context: BackendContext;
  readonly #options: LxcBackendOptions;
  readonly #http: { fetch: FetchLike; close(): Promise<void> };
  readonly #keyFile = new KeyFile();
  readonly #warmStore: WarmStore;
  readonly #warm: ReadyPool<BoxIdentity>;
  /** VMIDs this process is cloning into. */
  readonly #reserved = new Set<number>();
  /** Warm guests being prepared: their VMID and their template's. */
  readonly #filling = new Map<number, number>();
  /** Acquires running in this process, by box, with their template once chosen and their VMID once claimed. */
  readonly #acquiring = new Map<string, { readonly flavour: LxcFlavour; template: number | null; vmid: number | null }>();
  /** Root disk storage and size of each template. */
  readonly #templates = new Map<number, { readonly storage: string; readonly diskGiB: number | null }>();
  readonly #stopping = new AbortController();
  #api: Promise<Proxmox> | null = null;
  #ssh: Promise<SshKeys> | null = null;
  /** Where the next VMID search starts, so a deleted box's VMID and address are not reused at once. */
  #nextVmid: number | null = null;
  #maintaining: Promise<void> | null = null;

  constructor(config: LxcConfig, context: BackendContext, options: LxcBackendOptions = {}) {
    this.#config = config;
    this.#context = context;
    this.#options = options;
    this.#http = options.fetch
      ? { fetch: options.fetch, close: async () => {} }
      : proxmoxFetch({ ca: config.proxmox.caCertificate, fingerprint: config.proxmox.tlsFingerprint });
    this.label = `Proxmox LXC on ${config.proxmox.node ?? new URL(config.proxmox.apiUrl).hostname}`;
    this.#warmStore = new WarmStore(this, config.proxmox.pool);
    this.#warm = new ReadyPool(this.#warmStore);
  }

  kinds(): BoxKind[] {
    return this.#offers().map((offer) => offer.kind);
  }

  async capacity(kind: string, pending: readonly string[], signal?: AbortSignal): Promise<Capacity> {
    const offer = this.#offer(kind);
    const api = await this.client();
    const guests = await api.listPool(this.#config.proxmox.pool, signal);
    const ready = guests.filter((guest) => this.warmOf(guest)?.flavour === offer.flavour && guest.status === "running").length;
    const waiting = pending.filter((other) => flavourOf(other) === offer.flavour).length;
    return this.#room(api, offer, guests, pending, { ready, target: offer.config.warm }, ready > waiting, signal);
  }

  /** Room on the node for one more guest of `offer`, with `pending` guests still to come. */
  async #room(
    api: Proxmox,
    offer: Offer,
    guests: readonly PoolGuest[],
    pending: readonly string[],
    warm: { ready: number; target: number },
    fromWarm: boolean,
    signal?: AbortSignal,
  ): Promise<Capacity> {
    const choice = this.#choose(offer, guests, pending, api.node);
    const { storage } = await this.#templateOf(api, choice.template.vmid, signal);
    const [node, disk] = await Promise.all([api.nodeStatus(signal), api.storageStatus(storage, signal)]);
    const reserve = this.#config.reserve;
    const kind = offer.kind.id;
    const pendingMiB = pending.reduce((sum, other) => {
      const flavour = flavourOf(other);
      return sum + (flavour ? this.#config.flavours[flavour].memoryMiB : 0);
    }, 0);
    const memoryTotal = Math.floor(node.memoryTotal / MiB);
    const memoryUsed = memoryTotal - Math.floor(node.memoryAvailable / MiB) + pendingMiB;
    const diskTotal = Math.floor(disk.total / MiB);
    const diskUsed = diskTotal - Math.floor(disk.available / MiB);
    const { first, last } = this.#config.vmids;
    const used = new Set([...this.#reserved, ...this.#filling.keys(), ...guests.map((guest) => guest.vmid).filter((vmid) => this.#inRange(vmid))]);

    const limits: Limit[] = [
      { resource: "memory", used: memoryUsed, total: memoryTotal, reserve: reserve.memoryMiB, unit: "MiB" },
      { resource: "disk", used: diskUsed, total: diskTotal, reserve: reserve.diskGiB * 1024, unit: "MiB" },
      { resource: "guests", used: used.size, total: last - first + 1, reserve: 0, unit: "count" },
    ];
    const problems: string[] = [];
    if (memoryTotal - memoryUsed - offer.config.memoryMiB < reserve.memoryMiB) {
      problems.push(
        `${api.node} has ${formatMiB(memoryTotal - memoryUsed)} of memory free. A ${kind} box needs ${formatMiB(offer.config.memoryMiB)} and ${formatMiB(reserve.memoryMiB)} is kept free. ` +
          `Release a box, or lower the ${offer.flavour} memory or the memory kept free in bb-box's settings.`,
      );
    }
    if (diskTotal - diskUsed < reserve.diskGiB * 1024) {
      problems.push(
        `The ${storage} storage on ${api.node} has ${Math.floor((diskTotal - diskUsed) / 1024)} GiB free, less than the ${reserve.diskGiB} GiB kept free. ` +
          `Release boxes, free some space, or lower the disk kept free in bb-box's settings.`,
      );
    }
    if (this.#freeVmid(guests) === null) {
      problems.push(`Every VMID from ${first} to ${last} is in use. Release a box, or widen the VMID range in bb-box's settings.`);
    }
    if (choice.gpus) limits.push({ resource: "gpu-desktops", used: choice.gpus.used, total: choice.gpus.total, reserve: 0, unit: "count" });
    if (choice.problem) problems.push(choice.problem);
    const fits = problems.length === 0;
    const ok = fits || fromWarm;
    return {
      ok,
      message: ok ? null : problems[0]!,
      warm,
      hosts: [{ host: api.node, ok: fits, limits }],
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
   */
  #choose(offer: Offer, guests: readonly PoolGuest[], pending: readonly string[], node: string): Choice {
    const counts = this.#perTemplate(guests);
    const uses = (template: LxcTemplate) => counts.get(template.vmid) ?? 0;
    const least = (templates: readonly LxcTemplate[]) => templates.reduce((best, template) => (uses(template) < uses(best) ? template : best));
    const templates = offer.config.templates;
    if (!offer.kind.capabilities.gpu) return { template: least(templates), gpus: null, problem: null };

    const desktops = new Map<string, number>();
    for (const template of templates) desktops.set(template.gpu!, (desktops.get(template.gpu!) ?? 0) + uses(template));
    const gpu = [...desktops.keys()].reduce((best, id) => (desktops.get(id)! < desktops.get(best)! ? id : best));
    const template = least(templates.filter((candidate) => candidate.gpu === gpu));
    // Acquires the registry has started that this process has not yet placed.
    const acquiring = [...this.#acquiring.values()].filter((acquire) => acquire.flavour === offer.flavour);
    const waiting = pending.filter((kind) => flavourOf(kind) === offer.flavour).length;
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
    const acquiring = { flavour: offer.flavour, template: null as number | null, vmid: null as number | null };
    this.#acquiring.set(box.boxId, acquiring);
    let vmid: number | null = null;
    let claimed: number | null = null;
    const claim = async (id: number) => {
      claimed = id;
      acquiring.vmid = id;
      await hooks.claim(this.#guest(api.node, id, acquiring.template));
    };
    try {
      if (previous && this.#inRange(Number(previous.ref)) && (await this.#owns(api, Number(previous.ref), box.boxId, signal))) {
        vmid = Number(previous.ref);
        acquiring.vmid = vmid;
        acquiring.template = typeof previous.data?.template === "number" ? previous.data.template : null;
      }
      let warm = false;
      if (vmid === null) {
        const member = await step("warm", () =>
          this.#warm.claim(box.kind, box, {
            before: (candidate) => {
              acquiring.template = this.#warmStore.templateOf(candidate.ref);
              return claim(Number(candidate.ref));
            },
            signal,
          }),
        );
        if (member) {
          vmid = Number(member.ref);
          warm = true;
          this.#kick();
        } else {
          acquiring.template = null;
        }
      }
      if (vmid === null) {
        vmid = await step("clone", async () => {
          const guests = await api.listPool(this.#config.proxmox.pool, signal);
          acquiring.template = this.#choose(offer, guests, [], api.node).template.vmid;
          return this.#clone(api, guests, acquiring.template, box.name, describe(box), claim, signal);
        });
      }
      const id = vmid;
      const template = acquiring.template;
      if (!warm) {
        await step("configure", () => api.configure(id, this.#settings(offer.config, id), signal));
        await step("tags", () => api.configure(id, { tags: boxTags(box, template) }, signal));
      }
      await hooks.starting();
      await step("start", async () => {
        if ((await api.status(id, signal))?.status !== "running") await api.start(id, signal);
      });
      if (!warm && template !== null) await this.#grow(api, id, offer.config, template, step, signal);
      await this.#waitReady(id, box.kind, Math.max(1_000, deadline - Date.now()), signal, step);
      return this.#guest(api.node, id, template);
    } catch (error) {
      // A clone cut short may still have made the guest; it is ours if it names the box.
      const leftover = vmid ?? claimed;
      if (leftover !== null && (vmid !== null || (await this.#owns(api, leftover, box.boxId).catch(() => false)))) {
        await api.destroy(leftover).catch((cause) => this.#context.logError("release after a failed acquire", cause));
      }
      throw error;
    } finally {
      if (this.#acquiring.get(box.boxId) === acquiring) this.#acquiring.delete(box.boxId);
    }
  }

  async release(guest: Guest, hooks: ReleaseHooks, signal?: AbortSignal): Promise<void> {
    const started = performance.now();
    await (await this.client()).destroy(this.#vmid(guest), signal);
    hooks.timing("delete", Math.round(performance.now() - started));
  }

  async power(guest: Guest, signal?: AbortSignal): Promise<PowerState | null> {
    const status = await (await this.client()).status(this.#vmid(guest), signal);
    if (!status) return null;
    return powerOf(status.status);
  }

  async start(guest: Guest, signal?: AbortSignal): Promise<void> {
    const vmid = this.#vmid(guest);
    const api = await this.client();
    const status = await api.status(vmid, signal);
    if (!status) throw new BackendError("gone", `Container ${vmid} no longer exists.`);
    if (status.status !== "running") await api.start(vmid, signal);
    await this.#waitReady(vmid, null, this.#options.readyTimeoutMs ?? READY_TIMEOUT_MS, signal);
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
      held.push({ ...this.#guest(guest.node || api.node, guest.vmid), owner, power: powerOf(guest.status) });
    }
    return held;
  }

  async transports(guest: Guest, kind: string): Promise<BoxTransports> {
    const vmid = this.#vmid(guest);
    const access = this.#access(vmid);
    const capabilities = OFFERS.find((offer) => offer.id === kind)?.capabilities;
    const command = await this.#command(vmid);
    const displays = (capabilities?.displays ?? []).map(
      (display): Display => ({
        ...display,
        label: "Desktop",
        open: async (signal) => {
          const password = await this.#vncPassword(command, signal);
          return {
            route: { type: "tcp", host: access.host, port: VNC_PORT },
            auth: password ? { type: "vnc-password", password } : { type: "none" },
          };
        },
      }),
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

      for (const listed of templates) {
        const template = listed.template.vmid;
        const name = templateCheck(listed);
        const docker = OFFERS.some((offer) => offer.flavour === listed.flavour && offer.capabilities.features.includes("docker"));
        try {
          const config = await api.config(template, signal);
          const storage = String(config.rootfs ?? "").split(":")[0];
          const diskGiB = rootDiskGiB(config);
          if (config.template !== 1 && config.template !== "1") {
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
              this.#templates.set(template, { storage, diskGiB });
              pass(name, `CT template ${template} on ${storage}, ${Math.floor((disk as { available: number }).available / GiB)} GiB free.`);
            }
          }
        } catch (error) {
          const missing = error instanceof ProxmoxError && error.notFound;
          fail(
            name,
            missing ? `CT ${template} does not exist on ${node}.` : message(error),
            missing
              ? `Build it with the setup guide's template/build.sh, or remove it from the ${FLAVOUR_NAMES[listed.flavour]} templates in bb-box's settings.`
              : audit(error, `Give the token VM.Audit and VM.Clone on /vms/${template}.`),
          );
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
      } catch (error) {
        fail(VMIDS, message(error), audit(error, `Give the token VM.Audit on /pool/${pool}.`));
      }
    }

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

  /** The flavour and template of a guest that is ready in the warm pool, or null. */
  warmOf(guest: PoolGuest): { readonly flavour: LxcFlavour; readonly template: number } | null {
    if (guest.type !== "lxc" || guest.template || !this.#inRange(guest.vmid) || this.#filling.has(guest.vmid)) return null;
    if (!guest.tags.includes(WARM)) return null;
    const template = templateFromTags(guest.tags);
    const flavour = template === null ? null : this.#flavourOf(template);
    return flavour && template !== null ? { flavour, template } : null;
  }

  /** Retags a warm guest for its box. The guest keeps running. */
  async hold(member: PoolMember, box: BoxIdentity, template: number | null, signal?: AbortSignal): Promise<void> {
    const { config } = this.#offer(box.kind);
    const api = await this.client();
    const vmid = Number(member.ref);
    await api.configure(vmid, { hostname: box.name, cores: config.cores, memory: config.memoryMiB, description: describe(box) }, signal);
    await api.configure(vmid, { tags: boxTags(box, template) }, signal);
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
      const disks = config.templates.map((template) => this.#templates.get(template.vmid)?.diskGiB ?? 0);
      offers.push({ kind: { ...kind, size: size(config, Math.min(...disks) || null) }, flavour, config });
    }
    return offers;
  }

  /** The flavour whose settings list `template`, or null. */
  #flavourOf(template: number): LxcFlavour | null {
    return LXC_FLAVOURS.find((flavour) => this.#config.flavours[flavour].templates.some((listed) => listed.vmid === template)) ?? null;
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

  /** `template` is kept with the box, and a GPU desktop's GPU is shown. */
  #guest(node: string, vmid: number, template: number | null = null): Guest {
    const guest: Guest = { ref: String(vmid), host: node, address: addressFor(this.#config, vmid) };
    if (template === null) return guest;
    const gpu = this.#config.flavours.desktop.templates.find((listed) => listed.vmid === template)?.gpu;
    return { ...guest, data: { template }, ...(gpu ? { facts: [{ label: "GPU", value: gpu }] } : {}) };
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

  /** Config for a fresh clone at `vmid` of one of `config`'s templates. */
  #settings(config: LxcFlavourConfig, vmid: number) {
    return {
      cores: config.cores,
      memory: config.memoryMiB,
      net0: net0For(this.#config, vmid),
      onboot: true,
      // Templates are protected against deletion, and clones inherit it.
      delete: ["protection"],
    };
  }

  /** Grows a running guest's disk when the settings ask for more than the template has. */
  async #grow(api: Proxmox, vmid: number, config: LxcFlavourConfig, template: number, step: Step, signal?: AbortSignal): Promise<void> {
    const wanted = config.diskGiB;
    if (wanted === null) return;
    const templateDisk = this.#templates.get(template)?.diskGiB;
    if (templateDisk != null && templateDisk >= wanted) return;
    await step("resize", () => api.growRootDisk(vmid, wanted, signal));
  }

  async #owns(api: Proxmox, vmid: number, boxId: string, signal?: AbortSignal): Promise<boolean> {
    if (!(await api.status(vmid, signal))) return false;
    const config = await api.config(vmid, signal);
    const owner = ownerFromTags(parseTags(config.tags)) ?? ownerFromDescription(config.description);
    return owner?.boxId === boxId;
  }

  async #templateOf(api: Proxmox, template: number, signal?: AbortSignal): Promise<{ storage: string; diskGiB: number | null }> {
    const cached = this.#templates.get(template);
    if (cached) return cached;
    let config: Record<string, unknown>;
    try {
      config = await api.config(template, signal);
    } catch (error) {
      if (error instanceof ProxmoxError && error.notFound) throw new Error(`CT template ${template} does not exist on ${api.node}. Run the doctor check in bb-box's panel.`);
      throw error;
    }
    const storage = String(config.rootfs ?? "").split(":")[0];
    if (!storage) throw new Error(`CT template ${template} has no root disk.`);
    const found = { storage, diskGiB: rootDiskGiB(config) };
    this.#templates.set(template, found);
    return found;
  }

  /**
   * Linked-clones `template` into the next free VMID, round-robin. `before`
   * runs before each attempt. A VMID another guest has taken is skipped.
   */
  async #clone(
    api: Proxmox,
    guests: readonly PoolGuest[],
    template: number,
    hostname: string,
    description: string,
    before: (vmid: number) => Promise<void>,
    signal: AbortSignal,
  ): Promise<number> {
    if (this.#nextVmid === null) {
      const stored = await this.#context.storage.get<number>(NEXT_VMID);
      this.#nextVmid ??= typeof stored === "number" && this.#inRange(stored) ? stored : this.#config.vmids.first;
    }
    const skipped = new Set<number>();
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
        throw error;
      } finally {
        this.#reserved.delete(vmid);
      }
    }
  }

  async #command(vmid: number): Promise<SshTransport> {
    return new SshTransport((await this.#keys()).ssh, this.#access(vmid), "linux");
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
    const ready = await step("ssh", () => waitUntilAnswers(command, { timeoutMs: left, intervalMs: 100, signal, sleep }));
    if (!ready) {
      throw new Error(
        `Port ${port} of ${host} is open, but SSH as ${user} did not answer within ${seconds(left)}. ` +
          `Check that user ${user} in the ${kind ?? "box's"} template accepts bb-box's key.`,
      );
    }
  }

  /** The password the desktop wrote at boot, or null when it asks for none. */
  async #vncPassword(command: SshTransport, signal?: AbortSignal): Promise<string | null> {
    const result = await command.run(`cat ${VNC_PASSWORD_FILE} 2>/dev/null || :`, { timeoutMs: 15_000, signal, maxOutputBytes: 1024 });
    if (result.exitCode !== 0) {
      throw new Error(`Cannot read the desktop's VNC password over SSH: ${result.stderr.trim() || `exit code ${result.exitCode}`}.`);
    }
    return result.stdout.trim() || null;
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
        return { ssh: new Ssh({ keyPath, binary: this.#options.sshBinary }), publicKey: publicText, generated };
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
    if (!LXC_FLAVOURS.some((flavour) => this.#config.flavours[flavour].warm > 0)) return;
    this.maintain(this.#stopping.signal).catch((error) => this.#context.logError("warm pool", error));
  }

  async #topUp(signal: AbortSignal): Promise<void> {
    const api = await this.client();
    const pool = this.#config.proxmox.pool;
    // Retire warm guests beyond their flavour's target, or of a template no longer listed, while no claim runs.
    const retired = await this.#warm.exclusive(async () => {
      const guests = await api.listPool(pool, signal);
      const kept = new Map<LxcFlavour, number>();
      const out: number[] = [];
      for (const guest of guests) {
        if (!guest.tags.includes(WARM) || guest.type !== "lxc" || guest.template || !this.#inRange(guest.vmid) || this.#filling.has(guest.vmid)) continue;
        const flavour = this.warmOf(guest)?.flavour;
        const count = flavour ? (kept.get(flavour) ?? 0) : 0;
        if (flavour && guest.status === "running" && count < this.#config.flavours[flavour].warm) {
          kept.set(flavour, count + 1);
          continue;
        }
        await api.configure(guest.vmid, { tags: [TAG, RETIRED] }, signal);
        out.push(guest.vmid);
      }
      return out;
    });
    for (const vmid of retired) await api.destroy(vmid, signal).catch((error) => this.#context.logError("retire a warm box", error));

    for (const flavour of LXC_FLAVOURS) {
      // Any kind of the flavour stands for it: their guests are the same.
      const offer = this.#offers().find((candidate) => candidate.flavour === flavour);
      if (!offer || offer.config.warm === 0) continue;
      const { config } = offer;
      const guests = await api.listPool(pool, signal);
      const ready = guests.filter((guest) => this.warmOf(guest)?.flavour === flavour && guest.status === "running").length;
      const filling = [...this.#filling.values()].filter((template) => this.#flavourOf(template) === flavour).length;
      for (let missing = config.warm - ready - filling; missing > 0; missing--) {
        signal.throwIfAborted();
        const room = await this.#room(api, offer, await api.listPool(pool, signal), [], { ready, target: config.warm }, false, signal);
        if (!room.ok) {
          this.#context.logError("warm pool", new Error(room.message ?? "No room for a warm box."));
          break;
        }
        await this.#fill(api, offer, signal);
      }
    }
  }

  async #fill(api: Proxmox, offer: Offer, signal: AbortSignal): Promise<void> {
    const { flavour, config } = offer;
    let vmid: number | null = null;
    const claimed: number[] = [];
    try {
      const guests = await api.listPool(this.#config.proxmox.pool, signal);
      const template = this.#choose(offer, guests, [], api.node).template.vmid;
      vmid = await this.#clone(
        api,
        guests,
        template,
        "bb-box-warm",
        `bb-box warm ${flavour}`,
        async (id) => {
          this.#filling.set(id, template);
          claimed.push(id);
        },
        signal,
      );
      await api.configure(vmid, this.#settings(config, vmid), signal);
      await api.configure(vmid, { tags: [TAG, FILLING, templateTag(template)] }, signal);
      await api.start(vmid, signal);
      await this.#grow(api, vmid, config, template, untimed, signal);
      await this.#waitReady(vmid, offer.kind.id, this.#options.readyTimeoutMs ?? offer.kind.readyTimeoutMs, signal);
      await api.configure(vmid, { tags: [TAG, WARM, templateTag(template)] }, signal);
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
  /** The template of each warm guest, as last listed. */
  readonly #templates = new Map<string, number>();

  constructor(backend: ProxmoxLxcBackend, pool: string) {
    this.#backend = backend;
    this.#pool = pool;
  }

  async members(signal?: AbortSignal): Promise<PoolMember[]> {
    const api = await this.#backend.client();
    const members: PoolMember[] = [];
    this.#templates.clear();
    for (const guest of await api.listPool(this.#pool, signal)) {
      const warm = this.#backend.warmOf(guest);
      if (!warm || guest.status !== "running") continue;
      this.#templates.set(String(guest.vmid), warm.template);
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

  hold(member: PoolMember, box: BoxIdentity, signal?: AbortSignal): Promise<void> {
    return this.#backend.hold(member, box, this.templateOf(member.ref), signal);
  }
}
