// The Docker backend: Linux boxes as containers on one Docker host, through
// the docker CLI on BB's server (cli.ts). Commands, file copies and the
// desktop's stream all go through `docker exec` (transport.ts), so bb-box
// needs no network path to a box, and a Docker host over SSH works as the
// local socket does (031).
//
// - Acquire: the box's container is named bbbox-<box ID>, so it is claimed
//   before anything is made. It is made with its owner in its labels, on a
//   network of bb-box's own, then started; its main process, setup/docker/
//   start, writes /run/bb-box/ready once the box is up. There is no warm
//   pool: a container is ready in about a second.
// - Capacity: the host's memory, less a reserve and the limits of the
//   running bb-box containers; a most-boxes setting, counting every
//   install's; and desktops per GPU for GPU desktops, from the GPUs the
//   NVIDIA Container Toolkit lists as CDI devices. Boxes share the host's
//   disk, so there is no disk limit, and a box keeps its image's disk.
// - Every call that acts on a container inspects it first and acts only on
//   one whose labels name this install and the box (018).

import { hostname as localHostname } from "node:os";
import { performance } from "node:perf_hooks";
import { MIN_DESKTOP, type Display, type DisplaySize } from "../../transports/types.ts";
import {
  type GuestOs,
  BackendError,
  type AcquireHooks,
  type Backend,
  type BackendContext,
  type BoxIdentity,
  type BoxKind,
  type BoxOwner,
  type BoxSize,
  type BoxTransports,
  type Capacity,
  type CommandCapability,
  type ComputerUse,
  type DoctorCheck,
  type DoctorReport,
  type Guest,
  type HeldGuest,
  type HostCapacity,
  type Limit,
  type MachineAccess,
  type PowerState,
  type ReleaseHooks,
} from "../types.ts";
import { DockerCli, LABELS, NO_SUCH, abortable, type ContainerInfo, type DockerInfo } from "./cli.ts";
import { BB_MACHINE, DOCKER_KINDS, IMAGE_VERSION, type DockerConfig, type DockerKind } from "./config.ts";
import { BOX_USER, DockerTransport } from "./transport.ts";

/** The images start a box in about a second; a desktop takes a few more. This leaves room for a busy host. */
const READY_TIMEOUT_MS = 60_000;
/** setup/docker/start writes it once the box is up. /run is a tmpfs, so it is new at each start. */
const READY_FILE = "/run/bb-box/ready";
/** The image's main process. */
const START = "/usr/local/sbin/bb-box-start";
const VNC_PORT = 5900;
/** The desktop image writes a fresh VNC password here at each start, readable by the box user. */
const VNC_PASSWORD_FILE = "/var/lib/bb-box/vnc-password";
const DISPLAY_MODE_FILE = "/run/bb-box/display-mode";
const DISPLAY_ENV = "DISPLAY=:99 XAUTHORITY=/run/bb-box/Xauthority";
const MiB_PER_GiB = 1024;
/** Docker's own default for /dev/shm is 64 MiB, too little for Chrome. */
const SHM_MIN_MiB = 1024;
/** The doctor checks room for a box of the small preset core ships for linux (028). */
const DOCTOR_SIZE: BoxSize = { cores: 2, memoryMiB: 4096, diskGiB: null };
/** Statuses in which a container holds its memory. */
const ACTIVE = new Set(["running", "paused", "restarting"]);

const CUA_DRIVER: ComputerUse = { driver: "cua", version: "0.28.3", socket: "/home/box/.cache/cua-driver/cua-driver.sock" };
const DOCKER_COMMAND: CommandCapability = { transport: "docker", shell: "sh", admin: true, inDesktopSession: false, streaming: true };

type Step = <T>(name: string, run: () => Promise<T>) => Promise<T>;
type Pending = { readonly kind: string; readonly size: BoxSize };

export interface DockerBackendOptions {
  /** The docker CLI, instead of `docker` on the PATH. */
  readonly binary?: string;
  /** The longest an acquire may take, instead of the kind's. */
  readonly readyTimeoutMs?: number;
}

/** A container bb-box is making, counted against the host until docker lists it. */
interface Placing {
  readonly name: string;
  readonly memoryMiB: number;
  readonly gpu: string | null;
}

/** Boxes the registry is acquiring that have not been placed yet. */
interface Unplaced {
  readonly count: number;
  readonly memoryMiB: number;
  readonly gpuDesktops: number;
}

const NONE_UNPLACED: Unplaced = { count: 0, memoryMiB: 0, gpuDesktops: 0 };

interface HostState {
  readonly info: DockerInfo;
  /** Every bb-box container on the host, of every install. */
  readonly containers: readonly ContainerInfo[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatMiB(value: number): string {
  return value >= MiB_PER_GiB ? `${Math.round((value / MiB_PER_GiB) * 10) / 10} GiB` : `${value} MiB`;
}

/** The container of a box. Box IDs are letters and digits; anything else becomes "-". */
export function containerName(boxId: string): string {
  return `bbbox-${boxId.replace(/[^A-Za-z0-9_.-]/g, "-")}`;
}

/** A box's name as a hostname, so the shell prompt and BB's machine name agree with it. */
export function hostnameOf(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return cleaned || "box";
}

function powerOf(status: string): PowerState {
  if (status === "running") return "running";
  if (status === "created" || status === "exited" || status === "dead") return "stopped";
  return "unknown";
}

/** The size the container's limits give it. A box shares the host's disk, so its disk is null. */
function sizeOf(container: ContainerInfo): BoxSize | null {
  if (!container.cores || !container.memoryMiB) return null;
  return { cores: container.cores, memoryMiB: container.memoryMiB, diskGiB: null };
}

/** A container's owner and name since its box changed hands, which its labels cannot say (036). */
interface Relabelled {
  readonly threadId: string;
  readonly name: string;
}

/** The storage key of the host's last known name (#265). */
const NAME_KEY = "host-name";
/** The storage key of the host's OS, learned from a daemon over ssh://. */
const OS_KEY = "host-os";

/** This process's platform as a guest OS word: BB's server, for a local daemon. */
function platformOs(platform: string): GuestOs {
  return platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux";
}

/** The OS of a daemon's machine, from docker info: WSL2's kernel says microsoft; Docker Desktop or OrbStack on another kernel is a Mac; Colima and Rancher Desktop read as plain Linux. */
export function daemonOs(info: Pick<DockerInfo, "kernelVersion" | "operatingSystem">): GuestOs {
  if (/microsoft/i.test(info.kernelVersion)) return "windows";
  if (/docker desktop|orbstack/i.test(info.operatingSystem)) return "macos";
  return "linux";
}

function relabelKey(ref: string): string {
  return `relabel/${ref}`;
}

function ownerOf(labels: Readonly<Record<string, string>>): BoxOwner | null {
  const boxId = labels[LABELS.box];
  const threadId = labels[LABELS.thread];
  if (!boxId || !threadId) return null;
  const created = Number(labels[LABELS.created]);
  return {
    boxId,
    threadId,
    name: labels[LABELS.name] || null,
    kind: labels[LABELS.kind] || null,
    createdAt: Number.isFinite(created) && created > 0 ? created : null,
  };
}

function dataOf(container: ContainerInfo): Record<string, string> {
  const box = container.labels[LABELS.box];
  const gpu = container.labels[LABELS.gpu];
  return { ...(box ? { box } : {}), ...(gpu ? { gpu } : {}) };
}

/**
 * The kinds a config offers: those with an image. A box has Docker when the
 * setting is on and the host is not rootless Docker, which cannot run the
 * privileged containers it needs (041).
 */
export function dockerKinds(config: DockerConfig, rootless = false): BoxKind[] {
  const docker = config.docker && !rootless ? ["docker"] : [];
  const kinds: Record<DockerKind, BoxKind> = {
    linux: {
      id: "linux",
      label: "Linux",
      description: "A Linux container for builds, backend services and the agent's own work.",
      requires: [],
      capabilities: {
        os: "linux",
        arch: "x86_64",
        gpu: false,
        features: docker,
        command: DOCKER_COMMAND,
        displays: [],
        computerUse: null,
        enrol: true,
      },
      readyTimeoutMs: READY_TIMEOUT_MS,
    },
    "linux-desktop": {
      id: "linux-desktop",
      label: "Linux desktop",
      description: "A Linux desktop on the host's GPU, for computer use, browsers and app development.",
      requires: [],
      capabilities: {
        os: "linux",
        arch: "x86_64",
        gpu: true,
        // Never privileged: a privileged container sees every GPU on the
        // host, and Xorg would take the first, not the one placed (041).
        features: [],
        command: DOCKER_COMMAND,
        // As in a Proxmox LXC box, x0vncserver on the GPU refuses a viewer's
        // resize, so transports() gives this display a resize that runs xrandr (021).
        displays: [{ id: "desktop", protocol: "rfb", resizable: true }],
        computerUse: CUA_DRIVER,
        enrol: true,
      },
      readyTimeoutMs: READY_TIMEOUT_MS,
    },
    "linux-desktop-cpu": {
      id: "linux-desktop-cpu",
      label: "Linux desktop",
      description:
        "A Linux desktop drawn by the CPU, for computer use and browsers when no GPU is needed or free. Graphics are slower; WebGL and Vulkan still work.",
      requires: [],
      capabilities: {
        os: "linux",
        arch: "x86_64",
        gpu: false,
        features: docker,
        command: DOCKER_COMMAND,
        displays: [{ id: "desktop", protocol: "rfb", resizable: true }],
        computerUse: CUA_DRIVER,
        enrol: true,
      },
      readyTimeoutMs: READY_TIMEOUT_MS,
    },
  };
  return DOCKER_KINDS.filter((kind) => config.images[kind]).map((kind) => kinds[kind]);
}

/** Where the docker CLI goes, for people: the host of an ssh:// address, a BB machine's name, or the local daemon. */
function hostWords(host: string | null, machines?: MachineAccess): string {
  if (!host) return "the local Docker host";
  const machine = BB_MACHINE.exec(host)?.[1];
  if (machine) return machines?.name(machine) ?? `BB machine ${machine}`;
  if (host.startsWith("ssh://")) return host.slice(6).replace(/^[^@]*@/, "");
  return host;
}

export class DockerBackend implements Backend {
  readonly id: string;
  readonly nature = "virtual" as const;
  readonly #config: DockerConfig;
  readonly #context: BackendContext;
  readonly #options: DockerBackendOptions;
  readonly #kinds: BoxKind[];
  /** The kinds on a rootless Docker host, which has no Docker to give boxes. */
  readonly #rootlessKinds: BoxKind[];
  readonly #cli: DockerCli;
  /** The daemon's facts, as it last gave them. */
  #info: DockerInfo | null = null;
  /** The host's name as last known, kept in storage so a restart shows it before the daemon or BB has answered again (#265). */
  #knownName: string | null = null;
  /** The host's OS as last learned from the daemon over ssh://, kept with the name. */
  #knownOs: GuestOs | null = null;
  /** Containers being acquired, by box ID, until their acquire ends. */
  readonly #placing = new Map<string, Placing>();
  /** Placement is one at a time, so two acquires never take the last room on the host. */
  #placement: Promise<unknown> = Promise.resolve();

  constructor(config: DockerConfig, context: BackendContext, options: DockerBackendOptions = {}) {
    this.id = context.id;
    this.#config = config;
    this.#context = context;
    this.#options = options;
    this.#kinds = dockerKinds(config);
    this.#rootlessKinds = dockerKinds(config, true);
    const machine = config.machine;
    const machines = context.machines;
    this.#cli = machine
      ? new DockerCli(machines?.dockerHost(machine) ?? null, options.binary, async () => {
          if (!machines) throw new Error(`bb-box reaches BB machine ${machine} only when it runs in BB.`);
          await machines.ready(machine);
        })
      : new DockerCli(config.host, options.binary);
    void this.#recallName();
  }

  /** Reads the name kept from the last run, and asks the daemon once when none is kept and the host is not a BB machine. */
  async #recallName(): Promise<void> {
    try {
      const kept = await this.#context.storage.get<string>(NAME_KEY);
      if (kept && !this.#info && !this.#config.machine) this.#knownName = kept;
      const keptOs = await this.#context.storage.get<GuestOs>(OS_KEY);
      if (keptOs && !this.#info) this.#knownOs = keptOs;
      if (!kept && !this.#config.machine && this.#config.host) {
        const info = await this.#cli.info();
        if (!this.#info) this.#info = info;
        await this.#keepName(info.name);
      }
    } catch {
      // The name shows once the doctor or a capacity check has asked.
    }
  }

  /** Remembers the host's name for the next start, when it changed. */
  async #keepName(name: string | null): Promise<void> {
    if (!name || name === this.#knownName) return;
    this.#knownName = name;
    await this.#context.storage.set(NAME_KEY, name).catch(() => {});
  }

  /** Remembers the host's OS, as the daemon over ssh:// said it, for the next start. */
  async #keepOs(os: GuestOs): Promise<void> {
    if (os === this.#knownOs) return;
    this.#knownOs = os;
    await this.#context.storage.set(OS_KEY, os).catch(() => {});
  }

  /**
   * The OS of the machine the daemon runs on: BB's word for a BB machine
   * (its host entry knows a Windows PC under WSL), this process's platform
   * for a local daemon, and the daemon's own words for one over ssh://,
   * where a kernel saying "microsoft" is a Windows PC and Docker Desktop
   * or OrbStack on any other kernel is a Mac. Null until known.
   */
  get hostOs(): GuestOs | null {
    if (this.#config.machine) return this.#context.machines?.platform?.(this.#config.machine) ?? null;
    if (!this.#config.host) return platformOs(process.platform);
    if (this.#info) {
      const os = daemonOs(this.#info);
      void this.#keepOs(os);
      return os;
    }
    return this.#knownOs;
  }

  /** "Docker on" the host as hosts names it, so the kinds' text and the picker agree; "Docker" for a local daemon not yet asked. */
  get label(): string {
    const [host] = this.hosts;
    return host ? `Docker on ${host}` : "Docker";
  }

  /**
   * The Docker host for people: a BB machine by its name in BB, else by its
   * own name once the daemon has answered (docker info's Name), else by its
   * address; none for a local daemon not yet asked.
   */
  get hosts(): readonly string[] {
    if (this.#config.machine) {
      // The machine's name as BB has it (042); the last known one while BB's list has not answered yet.
      const named = this.#context.machines?.name(this.#config.machine) ?? null;
      if (named) void this.#keepName(named);
      return [named ?? this.#knownName ?? hostWords(this.#config.host, this.#context.machines)];
    }
    if (this.#info?.name) {
      void this.#keepName(this.#info.name);
      return [this.#info.name];
    }
    if (this.#knownName) return [this.#knownName];
    return this.#config.host ? [hostWords(this.#config.host)] : [];
  }

  /** The kinds, with Docker until the daemon has said it is rootless. */
  kinds(): BoxKind[] {
    return this.#info?.rootless ? this.#rootlessKinds : this.#kinds;
  }

  /** Whether a box of `kind` is a privileged container with its own Docker daemon (041). */
  #privileged(kind: string): boolean {
    return this.#config.docker && !this.#info?.rootless && kind !== "linux-desktop";
  }

  #kind(id: string): BoxKind {
    const kind = this.kinds().find((candidate) => candidate.id === id);
    if (!kind) throw new BackendError("unsupported", `${this.label} does not offer ${id} boxes.`);
    return kind;
  }

  /** How to build a missing or old image: on a BB machine, through bb-box itself (042). */
  #buildFix(otherwise: string): string {
    const machine = this.#config.machine;
    if (!machine) return otherwise;
    // By its name in BB, which the command takes, else by its ID.
    const named = this.#context.machines?.name(machine) ?? machine;
    return `Run bb box docker-build ${/^[A-Za-z0-9_.-]+$/.test(named) ? named : machine}, or turn ${this.#host} off and on under Docker on BB machines in bb-box's settings, to build it there.`;
  }

  /** The host's name for people: a BB machine's as BB has it, else as the daemon gives it once it has answered. */
  get #host(): string {
    if (this.#config.machine) return hostWords(this.#config.host, this.#context.machines);
    return this.#info?.name || hostWords(this.#config.host);
  }

  async capacity(kind: string, size: BoxSize, pending: readonly Pending[], signal?: AbortSignal): Promise<Capacity> {
    this.#kind(kind);
    // A BB machine that is offline takes no box, said at once from BB's view of it, with no call to it (042).
    const machine = this.#config.machine;
    if (machine && (await abortable(this.#context.machines?.connected(machine) ?? Promise.resolve(null), signal)) !== true) {
      return { ok: false, message: `${this.#host} is offline in BB.`, warm: null, hosts: [{ host: this.#host, ok: false, limits: [] }] };
    }
    let state: HostState;
    try {
      state = await this.#state(signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        ok: false,
        message: `${this.#host} did not answer: ${message(error)}`,
        warm: null,
        hosts: [{ host: this.#host, ok: false, limits: [] }],
      };
    }
    const placed = [...this.#placing.values()];
    const unplaced: Unplaced = {
      count: Math.max(0, pending.length - placed.length),
      memoryMiB: Math.max(0, pending.reduce((sum, other) => sum + other.size.memoryMiB, 0) - placed.reduce((sum, other) => sum + other.memoryMiB, 0)),
      gpuDesktops: Math.max(0, pending.filter((other) => other.kind === "linux-desktop").length - placed.filter((other) => other.gpu).length),
    };
    const room = this.#room(state, kind, size, unplaced);
    return { ok: room.why === null, message: room.why === null ? null : this.#full(kind, room.why), warm: null, hosts: [room.capacity] };
  }

  /** The daemon's facts and every bb-box container on the host. */
  async #state(signal?: AbortSignal): Promise<HostState> {
    const [info, containers] = await Promise.all([this.#cli.info(signal), this.#cli.list({ [LABELS.backend]: "docker" }, signal)]);
    this.#info = info;
    return { info, containers };
  }

  /** Whether a box of `size` fits, and if not, why, with what to do; for a GPU desktop, the GPU it gets. */
  #room(state: HostState, kind: string, size: BoxSize, unplaced: Unplaced = NONE_UNPLACED): { capacity: HostCapacity; why: string | null; gpu: string | null } {
    const { info, containers } = state;
    const host = info.name || this.#host;
    const listed = new Set(containers.map((container) => container.name));
    const active = containers.filter((container) => ACTIVE.has(container.status));
    const holding = new Set(active.map((container) => container.name));
    const placing = [...this.#placing.values()];
    const unlisted = placing.filter((other) => !listed.has(other.name));
    const guests = containers.length + unlisted.length + unplaced.count;
    const memoryUsed =
      active.reduce((sum, container) => sum + (container.memoryMiB ?? 0), 0) +
      placing.filter((other) => !holding.has(other.name)).reduce((sum, other) => sum + other.memoryMiB, 0) +
      unplaced.memoryMiB;
    const memoryFree = info.memoryMiB - memoryUsed;
    const reserve = this.#config.reserveMemoryMiB;
    const limits: Limit[] = [
      { resource: "guests", used: guests, total: this.#config.boxes, reserve: 0, unit: "count" },
      { resource: "memory", used: memoryUsed, total: info.memoryMiB, reserve, unit: "MiB" },
    ];
    // A stopped desktop keeps its GPU, which it takes again when it starts.
    const gpus = kind === "linux-desktop"
      ? info.gpus.map((id) => ({
          id,
          used:
            containers.filter((container) => container.labels[LABELS.gpu] === id).length +
            unlisted.filter((other) => other.gpu === id).length +
            unplaced.gpuDesktops,
        }))
      : [];
    for (const gpu of gpus) limits.push({ resource: "gpu-desktops", id: gpu.id, used: gpu.used, total: this.#config.desktopsPerGpu, reserve: 0, unit: "count" });
    const free = gpus.filter((gpu) => gpu.used < this.#config.desktopsPerGpu).sort((a, b) => a.used - b.used)[0] ?? null;

    let why: string | null = null;
    if (size.diskGiB !== null) {
      why = `a Docker box shares the host's disk, so bb-box cannot give it a ${size.diskGiB} GiB disk of its own. Ask for the base disk`;
    } else if (info.cpus && size.cores > info.cpus) {
      why = `${host} has ${info.cpus} cores, fewer than the ${size.cores} asked for. Ask for at most ${info.cpus} cores`;
    } else if (guests >= this.#config.boxes) {
      why =
        `${host} has ${guests} of the ${this.#config.boxes} bb-box containers it may have, counting stopped boxes and other installs' boxes. ` +
        "Release a box, or raise the most boxes in bb-box's settings";
    } else if (memoryFree - size.memoryMiB < reserve) {
      why =
        `${host} has ${formatMiB(Math.max(0, memoryFree))} of memory free, and a box with ${formatMiB(size.memoryMiB)} would leave less than the ${formatMiB(reserve)} kept free. ` +
        "Ask for less memory, release a box, or lower the memory kept free in bb-box's settings";
    } else if (kind === "linux-desktop" && !gpus.length) {
      why = `${host} lists no NVIDIA GPU as a CDI device. Install the NVIDIA Container Toolkit and generate its CDI spec (setup/docker/README.md), or ask for a linux-desktop-cpu box`;
    } else if (kind === "linux-desktop" && !free) {
      why = `each GPU on ${host} has the ${this.#config.desktopsPerGpu} desktops it may have. Release a GPU desktop, or ask for a linux-desktop-cpu box`;
    }
    return { capacity: { host, ok: why === null, limits }, why, gpu: why === null && free ? free.id : null };
  }

  #full(kind: string, why: string): string {
    return `${this.label} cannot take this ${kind} box: ${why}.`;
  }

  /** Checks room and counts the box against the host, one acquire at a time. */
  #place(box: BoxIdentity, signal: AbortSignal): Promise<{ host: string; gpu: string | null }> {
    const placed = this.#placement.then(async () => {
      const state = await this.#state(signal);
      const room = this.#room(state, box.kind, box.size);
      if (room.why !== null) throw new BackendError("no_capacity", this.#full(box.kind, room.why));
      this.#placing.set(box.boxId, { name: containerName(box.boxId), memoryMiB: box.size.memoryMiB, gpu: room.gpu });
      return { host: room.capacity.host, gpu: room.gpu };
    });
    this.#placement = placed.catch(() => undefined);
    return placed;
  }

  async acquire(box: BoxIdentity, previous: Guest | null, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest> {
    const kind = this.#kind(box.kind);
    const image = this.#config.images[box.kind as DockerKind]!;
    const deadline = Date.now() + (this.#options.readyTimeoutMs ?? kind.readyTimeoutMs);
    const name = containerName(box.boxId);
    const step: Step = async (stepName, run) => {
      const started = performance.now();
      try {
        return await run();
      } finally {
        hooks.timing(stepName, Math.round(performance.now() - started));
      }
    };
    // A container already made for this box is counted, so a resumed acquire is not placed again.
    const resumed = previous?.ref === name;
    let host: string;
    let gpu: string | null;
    if (resumed) {
      host = previous.host ?? this.#host;
      gpu = typeof previous.data?.gpu === "string" ? previous.data.gpu : null;
      this.#placing.set(box.boxId, { name, memoryMiB: box.size.memoryMiB, gpu });
    } else {
      ({ host, gpu } = await step("place", () => this.#place(box, signal)));
    }
    const guest = (address: string | null, size: BoxSize | null = null): Guest => ({
      ref: name,
      host,
      address,
      size,
      data: { box: box.boxId, ...(gpu ? { gpu } : {}) },
    });
    try {
      await hooks.claim(guest(null));
      await step("network", () => this.#network(signal));
      gpu = await step("create", () => this.#create(box, image, gpu, signal));
      await hooks.starting();
      await step("start", () => this.#cli.ok(["container", "start", name], { timeoutMs: 120_000, signal }));
      await step("ready", () => this.#ready(name, deadline, signal));
      const [made] = await this.#cli.inspect([name], signal);
      if (!made) throw new Error(`The container ${name} went from ${host} as it started.`);
      const ready = guest(this.#address(made), sizeOf(made));
      // Claimed again, so the box's record has the address and size as it becomes ready.
      await hooks.claim(ready);
      return ready;
    } catch (error) {
      // Only a container with this box's labels goes, so one of another box's is left alone.
      await this.#remove(name, box.boxId).catch((cause) => this.#context.logError("release after a failed acquire", cause));
      throw error;
    } finally {
      this.#placing.delete(box.boxId);
    }
  }

  async release(guest: Guest, hooks: ReleaseHooks, signal?: AbortSignal): Promise<void> {
    const started = performance.now();
    await this.#remove(guest.ref, this.#boxOf(guest), signal);
    await this.#context.storage.delete(relabelKey(guest.ref));
    hooks.timing("delete", Math.round(performance.now() - started));
  }

  /**
   * A box's new owner and name, as when a spare becomes yours or a thread's
   * (036). A container's labels cannot change, so they are kept in this
   * backend's storage and given over the labels by held(). The hostname
   * inside stays: changing it needs a privilege boxes do not have.
   */
  async relabel(guest: Guest, box: BoxIdentity): Promise<void> {
    await this.#context.storage.set(relabelKey(guest.ref), { threadId: box.threadId, name: box.name } satisfies Relabelled);
  }

  async power(guest: Guest, signal?: AbortSignal): Promise<PowerState | null> {
    let found: ContainerInfo | null;
    try {
      found = await this.#owned(guest.ref, this.#boxOf(guest), signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      return "unknown";
    }
    return found ? powerOf(found.status) : null;
  }

  async start(guest: Guest, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + (this.#options.readyTimeoutMs ?? READY_TIMEOUT_MS);
    const found = await this.#owned(guest.ref, this.#boxOf(guest), signal);
    if (!found) throw this.#gone(guest);
    await this.#cli.ok(["container", "start", found.id], { timeoutMs: 120_000, signal });
    await this.#ready(found.id, deadline, signal);
  }

  async stop(guest: Guest, signal?: AbortSignal): Promise<void> {
    const found = await this.#owned(guest.ref, this.#boxOf(guest), signal);
    if (!found) throw this.#gone(guest);
    await this.#cli.ok(["container", "stop", "--time", "10", found.id], { timeoutMs: 60_000, signal });
  }

  /** This install's containers, from their labels. */
  async held(signal?: AbortSignal): Promise<HeldGuest[]> {
    const [info, containers] = await Promise.all([
      this.#cli.info(signal),
      this.#cli.list({ [LABELS.backend]: "docker", [LABELS.install]: this.#context.installId }, signal),
    ]);
    this.#info = info;
    return Promise.all(
      containers.map(async (container) => {
        const owner = ownerOf(container.labels);
        const relabelled = owner ? await this.#context.storage.get<Relabelled>(relabelKey(container.name)) : undefined;
        return {
          ref: container.name,
          host: info.name || this.#host,
          address: this.#address(container),
          size: sizeOf(container),
          data: dataOf(container),
          owner: owner && relabelled ? { ...owner, threadId: relabelled.threadId, name: relabelled.name } : owner,
          power: powerOf(container.status),
        };
      }),
    );
  }

  async transports(guest: Guest, kind: string): Promise<BoxTransports> {
    // The transport's commands go straight to the CLI, so a BB machine's relay is made ready first.
    await this.#cli.prepare();
    const command = new DockerTransport(this.#cli, guest.ref);
    const capabilities = this.kinds().find((candidate) => candidate.id === kind)?.capabilities;
    const displays = (capabilities?.displays ?? []).map(
      (display): Display => ({
        ...display,
        label: "Desktop",
        open: async (signal) => {
          const password = await this.#vncPassword(command, signal);
          return { route: await command.route(VNC_PORT), auth: password ? { type: "vnc-password", password } : { type: "none" } };
        },
        ...(kind === "linux-desktop" ? { resize: (size: DisplaySize, signal?: AbortSignal) => this.#resize(command, size, signal) } : {}),
        minSize: MIN_DESKTOP,
      }),
    );
    // No SSH server runs in a box, and its Docker is reached only through it, so only BB's server reaches it.
    return { command, displays, access: null };
  }

  async doctor(signal?: AbortSignal): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    const notes: string[] = [`This install's ID is ${this.#context.installId}. Its containers carry the label ${LABELS.install}=${this.#context.installId}.`];
    const push = (id: string, name: string, status: DoctorCheck["status"], detail: string, fix: string | null = null) =>
      checks.push({ id, name, status, detail, fix });
    const skip = (id: string, name: string) => push(id, name, "skipped", "Skipped until the checks above pass.");
    const images = [...new Set(DOCKER_KINDS.map((kind) => this.#config.images[kind]).filter((image): image is string => image !== null))];

    const version = await this.#cli.run(["--version"], { timeoutMs: 15_000, signal }).catch((error: unknown) => error as Error);
    if (version instanceof Error || version.exitCode !== 0) {
      push(
        "docker.cli",
        "docker CLI",
        "fail",
        version instanceof Error ? version.message : version.stderr.trim() || `exit code ${version.exitCode}`,
        "Install the docker CLI on BB's server, on the PATH of the user BB runs as.",
      );
    } else {
      push("docker.cli", "docker CLI", "ok", version.stdout.trim());
    }

    let state: HostState | null = null;
    if (checks[0]!.status === "ok") {
      try {
        state = await this.#state(signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        const fix = this.#config.machine
          ? `Check that ${this.#host} is connected in BB and that Docker runs there. bb box docker-check ${this.#config.machine} reaches it through bb-box's relay.`
          : !this.#config.host
          ? "Start Docker on BB's server, and let the user BB runs as use it (on Linux, add it to the docker group), or set the Docker host in bb-box's settings."
          : this.#config.host.startsWith("ssh://")
            ? `Check that the user BB runs as logs in to ${hostWords(this.#config.host)} over SSH without a prompt, and that the user it logs in as may use Docker there.`
            : `Check that ${this.#config.host} is a Docker socket the user BB runs as may use.`;
        push("docker.daemon", "Docker daemon", "fail", message(error), fix);
      }
    } else {
      skip("docker.daemon", "Docker daemon");
    }

    if (state) {
      const { info } = state;
      const facts = `Docker ${info.version} on ${info.name} (${info.operatingSystem}, ${info.arch}, ${info.cpus} cores, ${formatMiB(info.memoryMiB)})`;
      if (info.osType !== "linux") {
        push("docker.daemon", "Docker daemon", "fail", `${facts} runs ${info.osType || "non-Linux"} containers.`, "Switch Docker to Linux containers.");
      } else if (info.arch !== "x86_64") {
        push(
          "docker.daemon",
          "Docker daemon",
          "warn",
          `${facts}. The images are x86_64, so boxes run under emulation, slowly.`,
          "Use an x86_64 Docker host for everyday boxes.",
        );
      } else {
        push("docker.daemon", "Docker daemon", "ok", `${facts}.`);
      }

      for (const image of images) {
        const kinds = DOCKER_KINDS.filter((kind) => this.#config.images[kind] === image).join(", ");
        const id = `image.${image}`;
        const name = `Image ${image}`;
        const result = await this.#cli.run(["image", "inspect", "--format", "{{json .Config.Labels}}", image], { timeoutMs: 30_000, signal });
        if (result.exitCode !== 0) {
          push(id, name, "fail", `${info.name} has no image ${image}, which ${kinds} boxes run. bb-box never pulls images.`, this.#buildFix("Build it with setup/docker/build.sh, or pull or load it on the Docker host."));
          continue;
        }
        let labels: Record<string, unknown> = {};
        try {
          labels = (JSON.parse(result.stdout) as Record<string, unknown> | null) ?? {};
        } catch {
          // An image without labels prints null.
        }
        const built = labels[LABELS.imageVersion];
        if (built === IMAGE_VERSION) {
          push(id, name, "ok", `For ${kinds} boxes, built by setup/docker/build.sh (layout ${IMAGE_VERSION}).`);
        } else {
          push(
            id,
            name,
            "warn",
            built ? `Built for layout ${String(built)}; this bb-box expects layout ${IMAGE_VERSION}.` : `Not built by setup/docker/build.sh, so boxes may not start.`,
            this.#buildFix("Build it again with this bb-box's setup/docker/build.sh."),
          );
        }
      }

      const network = await this.#cli.run(["network", "inspect", "--format", "{{json .Labels}}", this.#config.network], { timeoutMs: 30_000, signal });
      if (network.exitCode !== 0) {
        push("docker.network", `Network ${this.#config.network}`, "ok", "bb-box makes it with the first box.");
      } else if (network.stdout.includes(`"${LABELS.backend}":"docker"`)) {
        push("docker.network", `Network ${this.#config.network}`, "ok", "Made by bb-box. Its boxes cannot reach each other on it.");
      } else {
        push(
          "docker.network",
          `Network ${this.#config.network}`,
          "warn",
          `bb-box did not make the network ${this.#config.network}, so boxes on it may reach the host's other containers and each other.`,
          "Give bb-box a network name not in use in its settings.",
        );
      }

      if (!this.#config.docker) {
        push("docker.privileged", "Docker in boxes", "ok", "Off: boxes run unprivileged and say No Docker.");
      } else if (info.rootless) {
        push(
          "docker.privileged",
          "Docker in boxes",
          "warn",
          "Rootless Docker cannot run the privileged containers that give boxes Docker, so boxes run unprivileged and say No Docker.",
          "Use rootful Docker to give boxes Docker, or turn off Docker in boxes.",
        );
      } else {
        push(
          "docker.privileged",
          "Docker in boxes",
          "ok",
          `Each box but a GPU desktop is a privileged container with its own Docker daemon, so a box can become root on ${info.name}. This is not a security boundary.`,
        );
      }

      if (this.#config.images["linux-desktop"]) {
        if (info.gpus.length) {
          push("docker.gpus", "GPUs", "ok", `${info.gpus.length} NVIDIA GPU${info.gpus.length === 1 ? "" : "s"} as CDI devices, ${this.#config.desktopsPerGpu} desktops each.`);
        } else {
          push(
            "docker.gpus",
            "GPUs",
            "fail",
            `${info.name} lists no NVIDIA GPU as a CDI device, so no linux-desktop box can start.`,
            "Install the NVIDIA Container Toolkit and generate its CDI spec (setup/docker/README.md), or turn off GPU desktops.",
          );
        }
      }

      const room = this.#room(state, "linux", DOCTOR_SIZE);
      push(
        "docker.capacity",
        `Room on ${info.name}`,
        room.why === null ? "ok" : "warn",
        room.why ??
          room.capacity.limits.map((limit) => `${limit.resource} ${limit.unit === "MiB" ? `${formatMiB(limit.used)} of ${formatMiB(limit.total ?? 0)}` : `${limit.used} of ${limit.total}`}`).join(", "),
        room.why === null ? null : "Release a box, or change the most boxes or the memory kept free in bb-box's settings.",
      );

      const others = new Map<string, number>();
      for (const container of state.containers) {
        const install = container.labels[LABELS.install];
        if (install === this.#context.installId) continue;
        others.set(install || "none", (others.get(install || "none") ?? 0) + 1);
      }
      if (others.size) {
        notes.push(
          `bb-box leaves alone the containers of other installs on ${info.name}: ${[...others].map(([install, count]) => `${count} of install ${install}`).join(", ")}. They still count against its room.`,
        );
      }
    } else {
      for (const image of images) skip(`image.${image}`, `Image ${image}`);
    }

    const ok = checks.every((check) => check.status !== "fail");
    const first = checks.find((check) => check.status === "fail");
    return {
      ok,
      summary: ok ? `Docker ${state?.info.version ?? "?"} on ${state?.info.name ?? this.#host}` : `${first!.name}: ${first!.detail}`,
      checks,
      notes,
    };
  }

  // The host's side.

  #boxOf(guest: Guest): string | null {
    return typeof guest.data?.box === "string" ? guest.data.box : null;
  }

  #gone(guest: Guest): BackendError {
    return new BackendError("gone", `The container ${guest.ref} no longer exists on ${guest.host ?? this.#host}.`);
  }

  /**
   * The container `ref` when its labels name this install and the box, or
   * null. Without a box ID, the box its labels name must be the one its name
   * gives.
   */
  async #owned(ref: string, boxId: string | null, signal?: AbortSignal): Promise<ContainerInfo | null> {
    const [found] = await this.#cli.inspect([ref], signal);
    if (!found) return null;
    const labels = found.labels;
    if (labels[LABELS.backend] !== "docker" || labels[LABELS.install] !== this.#context.installId) return null;
    const box = labels[LABELS.box];
    if (!box || (boxId !== null ? box !== boxId : containerName(box) !== found.name)) return null;
    return found;
  }

  /** Removes the box's container and its volumes, if it is this install's and the box's. */
  async #remove(ref: string, boxId: string | null, signal?: AbortSignal): Promise<void> {
    const found = await this.#owned(ref, boxId, signal);
    if (!found) return;
    const result = await this.#cli.run(["container", "rm", "--force", "--volumes", found.id], { timeoutMs: 120_000, signal });
    if (result.exitCode !== 0 && !NO_SUCH.test(result.stderr) && !/already in progress/i.test(result.stderr)) {
      throw this.#cli.error("docker container rm", result);
    }
  }

  /** The network bb-box keeps its boxes on, made the first time, on which they cannot reach each other. */
  async #network(signal?: AbortSignal): Promise<void> {
    const network = this.#config.network;
    const found = await this.#cli.run(["network", "inspect", "--format", "{{.Name}}", network], { timeoutMs: 30_000, signal });
    if (found.exitCode === 0) return;
    if (!/No such network|not found/i.test(found.stderr)) throw this.#cli.error("docker network inspect", found);
    const made = await this.#cli.run(
      ["network", "create", "--label", `${LABELS.backend}=docker`, "--opt", "com.docker.network.bridge.enable_icc=false", network],
      { timeoutMs: 60_000, signal },
    );
    if (made.exitCode !== 0 && !/already exists/i.test(made.stderr)) throw this.#cli.error("docker network create", made);
  }

  /**
   * Makes the box's container, labelled with its owner from the first write.
   * When a container of that name is there already, it goes on with it if it
   * is this box's, as after a restart, and fails if not. Returns the GPU the
   * container has.
   */
  async #create(box: BoxIdentity, image: string, gpu: string | null, signal: AbortSignal): Promise<string | null> {
    const name = containerName(box.boxId);
    const { cores, memoryMiB } = box.size;
    const labels: Record<string, string> = {
      [LABELS.backend]: "docker",
      [LABELS.install]: this.#context.installId,
      [LABELS.box]: box.boxId,
      [LABELS.thread]: box.threadId,
      [LABELS.name]: box.name,
      [LABELS.kind]: box.kind,
      [LABELS.created]: String(box.createdAt),
      ...(gpu ? { [LABELS.gpu]: gpu } : {}),
    };
    const extra = [
      // Docker's own data on a volume, since overlayfs cannot hold overlayfs.
      ...(this.#privileged(box.kind) ? ["--privileged", "--env", "BBBOX_DOCKERD=1", "--volume", "/var/lib/docker"] : []),
      ...(box.kind === "linux-desktop" && gpu ? ["--device", gpu, "--env", "NVIDIA_DRIVER_CAPABILITIES=all", "--env", "BBBOX_GPU=1"] : []),
    ];
    const args = [
      "container", "create",
      "--pull", "never",
      "--name", name,
      ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      "--hostname", hostnameOf(box.name),
      "--init",
      "--cpus", String(cores),
      "--memory", `${memoryMiB}m`,
      "--memory-swap", `${memoryMiB}m`,
      "--shm-size", `${Math.max(SHM_MIN_MiB, Math.floor(memoryMiB / 2))}m`,
      "--pids-limit", "16384",
      "--restart", "unless-stopped",
      "--stop-timeout", "10",
      "--tmpfs", "/run:exec,mode=755",
      "--network", this.#config.network,
      ...extra,
      image,
      START,
    ];
    const result = await this.#cli.run(args, { timeoutMs: 120_000, signal });
    if (result.exitCode === 0) return gpu;
    if (/Conflict|already in use/i.test(result.stderr)) {
      const found = await this.#owned(name, box.boxId, signal);
      if (!found) throw new Error(`The container ${name} on ${this.#host} belongs to another box, so bb-box left it alone.`);
      return found.labels[LABELS.gpu] ?? null;
    }
    if (/No such image/i.test(result.stderr)) {
      throw new Error(`${this.#host} has no image ${image}, and bb-box never pulls one. Build it with setup/docker/build.sh (setup/docker/README.md).`);
    }
    throw this.#cli.error("docker container create", result);
  }

  /** Waits for the box's main process to say the box is up, in one `docker exec`. */
  async #ready(ref: string, deadline: number, signal?: AbortSignal): Promise<void> {
    const seconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
    const script = `i=0; while [ ! -e ${READY_FILE} ]; do i=$((i+1)); [ "$i" -le ${seconds * 10} ] || exit 3; sleep 0.1; done`;
    const result = await this.#cli.run(["exec", "--user", BOX_USER, ref, "/bin/sh", "-c", script], { timeoutMs: (seconds + 30) * 1000, signal });
    if (result.exitCode === 0) return;
    if (signal?.aborted) throw signal.reason;
    const [found] = await this.#cli.inspect([ref], signal).catch(() => []);
    const logs = await this.#logs(ref, signal);
    const output = logs ? ` Its last output: ${logs}` : "";
    if (found && found.status !== "running") {
      throw new Error(`The container ${ref} stopped as it started (${found.status}, exit code ${found.exitCode ?? "unknown"}).${output}`);
    }
    if (result.exitCode !== 3) throw new Error(`docker exec could not wait for ${ref}: ${result.stderr.trim() || `exit code ${result.exitCode}`}.${output}`);
    throw new Error(`The container ${ref} was not ready within ${seconds} s.${output}`);
  }

  async #logs(ref: string, signal?: AbortSignal): Promise<string> {
    const result = await this.#cli.run(["container", "logs", "--tail", "20", ref], { timeoutMs: 15_000, signal }).catch(() => null);
    if (!result) return "";
    return `${result.stdout}${result.stderr}`.trim().split("\n").slice(-20).join(" | ").slice(-1500);
  }

  /**
   * The container's address on bb-box's network, shown to people, when the
   * BB server can reach it: on Linux with rootful Docker on this machine.
   * Docker Desktop and rootless Docker keep the bridge in a VM or a namespace.
   */
  #address(container: ContainerInfo): string | null {
    const facts = this.#info;
    if (!facts) return null;
    const local = facts.osType === "linux" && !/Docker Desktop/i.test(facts.operatingSystem) && !facts.rootless && facts.name === localHostname();
    return local ? (container.addresses[this.#config.network] ?? null) : null;
  }

  async #vncPassword(command: DockerTransport, signal?: AbortSignal): Promise<string | null> {
    const result = await command.run(`cat ${VNC_PASSWORD_FILE} 2>/dev/null || :`, { timeoutMs: 15_000, signal, maxOutputBytes: 1024 });
    if (result.exitCode !== 0) {
      throw new Error(`Cannot read the desktop's VNC password through docker exec: ${result.stderr.trim() || `exit code ${result.exitCode}`}.`);
    }
    return result.stdout.trim() || null;
  }

  /**
   * Sets the GPU desktop's size with xrandr, as in a Proxmox LXC box (021).
   * Back on the CPU it does nothing: Xtigervnc has taken the viewer's
   * SetDesktopSize.
   */
  async #resize(command: DockerTransport, size: DisplaySize, signal?: AbortSignal): Promise<void> {
    const { width, height } = size;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error(`The desktop cannot be ${width} by ${height} pixels.`);
    }
    const script = `[ "$(cat ${DISPLAY_MODE_FILE} 2>/dev/null)" = cpu ] || ${DISPLAY_ENV} xrandr --fb ${width}x${height}`;
    const result = await command.run(script, { timeoutMs: 15_000, signal, maxOutputBytes: 4096 });
    if (result.exitCode !== 0) {
      throw new Error(`xrandr could not set the desktop to ${width}x${height}: ${result.stderr.trim() || `exit code ${result.exitCode}`}.`);
    }
  }
}
