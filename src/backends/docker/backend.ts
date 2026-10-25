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

import type { CheckId } from "../../core/checks.ts";
import { spawn } from "node:child_process";
import { timedSpawn } from "../../transports/spawns.ts";
import { randomBytes } from "node:crypto";
import { hostname as localHostname } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { MIN_DESKTOP, type BoxPointer, type Display, type DisplaySize } from "../../transports/types.ts";
import {
  type GuestOs,
  BackendError,
  type AcquireHooks,
  type Backend,
  type BackendContext,
  type BackendImages,
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
  type Guest,
  type HeldGuest,
  type HostCapacity,
  type ImageBox,
  type ImageBuild,
  type Limit,
  type MachineAccess,
  type PowerState,
  type ReleaseHooks,
} from "../types.ts";
import { sizesCheck } from "../fit.ts";
import { DockerCli, LABELS, NO_SUCH, abortable, sshReuse, type ContainerInfo, type DockerInfo } from "./cli.ts";
import { allotCpus, cpusBothAllow, daemonCpusFromRefusal, formatCpuList, hostCpusFromProbe, movesOntoFreeCpus, resizeCpus, type CpuList } from "./cpus.ts";
import { BB_MACHINE, DOCKER_KINDS, IMAGE_VERSION, type DockerConfig, type DockerKind } from "./config.ts";
import { judgeImage, recordFromJson, type ImageRecord } from "../images.ts";
import { CURSOR_HELPER, ImageFile, SELKIES_DISPLAY, followPointer, SelkiesPresence, WAYLAND_SELKIES_DISPLAY, selkiesDisplay } from "../selkies.ts";
import { BOX_USER, DockerTransport } from "./transport.ts";
import { restartWayvnc, wayvncAttached, waylandPointer } from "../wayvnc.ts";

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
/** The Wayland desktop's display script, which resizes it (048). */
const DISPLAY_SCRIPT = "/usr/local/libexec/bb-box/display";
/** The user wayvnc signs in, with the VNC password, on a Wayland desktop (048). */
const WAYVNC_USER = "box";
const MiB_PER_GiB = 1024;
/** Docker's own default for /dev/shm is 64 MiB, too little for Chrome. */
const SHM_MIN_MiB = 1024;
/** Statuses in which a container holds its memory. */
const ACTIVE = new Set(["running", "paused", "restarting"]);
const HOST_CPUS_KEPT_FOR_MS = 10 * 60_000;
const CPUS_NOT_AVAILABLE = /Requested CPUs are not available|for cpuset cpus/i;

export const CUA_DRIVER: ComputerUse = { driver: "cua", version: "0.28.3", socket: "/home/box/.cache/cua-driver/cua-driver.sock" };
const DOCKER_COMMAND: CommandCapability = { transport: "docker", shell: "sh", admin: true, inDesktopSession: false, streaming: true };

type Step = <T>(name: string, run: () => Promise<T>) => Promise<T>;
type Pending = { readonly kind: string; readonly size: BoxSize };

export interface DockerBackendOptions {
  /** The docker CLI, instead of `docker` on the PATH. */
  readonly binary?: string;
  readonly cliReachingAHostAnotherBackendMade?: DockerCli;
  /** The ssh client the docker CLI runs for an ssh:// host, instead of `ssh` on the PATH. */
  readonly ssh?: string;
  /** Where a Wayland box's image has Selkies' launcher, instead of SELKIES_LAUNCHER: a file the fake docker finds, in tests. */
  readonly selkiesLauncher?: string;
  /** Where a Wayland box's image has bb-box-cursor, instead of CURSOR_HELPER: a file the test finds, in tests. */
  readonly cursorHelper?: string;
  /** The longest an acquire may take, instead of the kind's. */
  readonly readyTimeoutMs?: number;
  /** Runs setup/docker/build.sh with `args`, for tests; bash by default. Resolves with its exit code. */
  readonly script?: (script: string, args: readonly string[], env: NodeJS.ProcessEnv, onLine: (line: string) => void, signal: AbortSignal) => Promise<number | null>;
}

/** setup/docker/build.sh's target for the image of each kind. */
const BUILD_TARGET: Readonly<Record<DockerKind, string>> = {
  linux: "linux",
  "linux-desktop-cpu": "desktop",
  "linux-desktop": "desktop",
  "linux-desktop-wayland-cpu": "desktop-wayland",
};

/**
 * A Docker box's checks as the box user (049): the tools, Docker on first
 * use in a box that has it, and a desktop's display and Chrome's DevTools,
 * which a host's AppArmor profile for Chrome can refuse (#596). A line per
 * check, with ok or FAIL, as the templates' checks print them.
 */
export const DOCKER_CHECK = String.raw`t() { name=$1; shift; if out=$("$@" 2>&1); then echo "$name ok   $(echo "$out" | head -n 1)"; else echo "$name FAIL $(echo "$out" | head -n 1)"; fi; }
for tool in node git gh claude codex pi rg fd jj uv; do t "$tool" "$tool" --version; done
[ "${"$"}{BBBOX_DOCKERD:-0}" != 1 ] || t "docker on first use" docker version --format '{{.Server.Version}}'
if [ -e /usr/local/libexec/bb-box/display ]; then
  for i in $(seq 1 60); do [ -s /run/bb-box/display-mode ] && break; sleep 1; done
  t "display" cat /run/bb-box/display-mode
  ! command -v google-chrome >/dev/null || t "Chrome DevTools" sh -c 'd=$(mktemp -d); google-chrome --headless=new --no-first-run --user-data-dir="$d" --remote-debugging-port=9334 about:blank >/dev/null 2>&1 & c=$!; v=; for i in $(seq 1 60); do v=$(curl -sf http://127.0.0.1:9334/json/version) && break; sleep 0.25; done; kill $c; wait $c; rm -rf "$d"; echo "$v" | grep -o "Chrome/[0-9.]*"'
fi`;

/** Runs a script with bash, a line of its output at a time. */
function runScript(script: string, args: readonly string[], env: NodeJS.ProcessEnv, onLine: (line: string) => void, signal: AbortSignal): Promise<number | null> {
  return new Promise((resolve) => {
    const child = timedSpawn(() => spawn("bash", [script, ...args], { env, stdio: ["ignore", "pipe", "pipe"], signal }), "Docker backend script");
    let rest = "";
    const read = (chunk: Buffer) => {
      const lines = (rest + chunk.toString("utf8")).split(/\r?\n|\r/);
      rest = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onLine(line);
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", (error) => {
      onLine(error.message);
      resolve(null);
    });
    child.on("close", (code) => {
      if (rest.trim()) onLine(rest);
      resolve(code);
    });
  });
}

/** A container bb-box is making, counted against the host until docker lists it. */
interface Placing {
  readonly name: string;
  readonly memoryMiB: number;
  readonly gpu: string | null;
  readonly cpus: CpuList | null;
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

/** Where #imageLabels keeps the image's size beside its labels. */
const SIZE = Symbol("size");

/** What `docker image inspect` gives of an image: its size in bytes, then its labels. */
const IMAGE_FORMAT = "{{.Size}} {{json .Config.Labels}}";

/** An image's labels and size, from `docker image inspect --format IMAGE_FORMAT`. */
function imageFacts(text: string): { labels: Record<string, unknown>; sizeBytes: number | null } {
  const space = text.indexOf(" ");
  const size = Number(text.slice(0, space));
  let labels: Record<string, unknown> = {};
  try {
    labels = (JSON.parse(text.slice(space + 1)) as Record<string, unknown> | null) ?? {};
  } catch {
    // An image without labels prints null.
  }
  return { labels, sizeBytes: space > 0 && Number.isFinite(size) && size > 0 ? size : null };
}

/**
 * An image's record with Docker's size of the image (#474): what finalizing
 * measures in a container is the Docker host's whole filesystem, and records
 * built before the fix carry it.
 */
function withSize(record: ImageRecord | null, sizeBytes: number | null): ImageRecord | null {
  return record && sizeBytes !== null ? { ...record, sizeGiB: Math.round((sizeBytes / 1024 ** 3) * 10) / 10 } : record;
}

function dataOf(container: ContainerInfo): Record<string, string> {
  const box = container.labels[LABELS.box];
  const gpu = container.labels[LABELS.gpu];
  return { ...(box ? { box } : {}), ...(gpu ? { gpu } : {}) };
}

/**
 * The kinds a config offers: those with an image. A box has Docker when the
 * setting is on and the host is not rootless Docker, which cannot run the
 * privileged containers it needs (041). A GPU desktop has it only when its
 * image can point Xorg at the GPU placed (`gpuDocker`), as an image built
 * before #283 cannot.
 */
export function dockerKinds(config: DockerConfig, rootless = false, gpuDocker = true): BoxKind[] {
  const kinds = kindTable(config.docker && !rootless ? ["docker"] : [], gpuDocker);
  return DOCKER_KINDS.filter((kind) => config.images[kind]).map((kind) => kinds[kind]);
}

/** Kind `id` as a Docker backend offers it once its image is set, with Docker in its boxes or not: for a desktop built on demand. */
export function dockerKind(id: DockerKind, docker: boolean): BoxKind {
  return kindTable(docker ? ["docker"] : [], true)[id];
}

function kindTable(docker: string[], gpuDocker: boolean): Record<DockerKind, BoxKind> {
  return {
    linux: {
      id: "linux",
      label: "Linux",
      description: "A Linux box for builds, backend services and the agent's own work.",
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
        features: gpuDocker ? docker : [],
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
        displays: [{ id: "desktop", protocol: "rfb", resizable: true }, SELKIES_DISPLAY],
        computerUse: CUA_DRIVER,
        enrol: true,
      },
      readyTimeoutMs: READY_TIMEOUT_MS,
    },
    "linux-desktop-wayland-cpu": {
      id: "linux-desktop-wayland-cpu",
      label: "Linux desktop on Wayland",
      description:
        "A Linux desktop on Wayland (Sway), drawn by the CPU, for computer use, browsers and apps built for Wayland. X11-only apps do not run there.",
      requires: [],
      capabilities: {
        os: "linux",
        arch: "x86_64",
        gpu: false,
        features: docker,
        command: DOCKER_COMMAND,
        // wayvnc refuses a viewer's resize, so transports() gives this display
        // a resize that runs the display script's (048). Video by default, from
        // Selkies on Sway, where the box's image has it (060).
        displays: [{ id: "desktop", protocol: "rfb", resizable: true, refresh: "viewer" }, WAYLAND_SELKIES_DISPLAY],
        computerUse: CUA_DRIVER,
        enrol: true,
      },
      readyTimeoutMs: READY_TIMEOUT_MS,
    },
  };
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
  /** The kinds when the desktop image cannot point Xorg at the GPU placed, so a GPU desktop has no Docker (#283). */
  readonly #oldDesktopKinds: BoxKind[];
  readonly #cli: DockerCli;
  /** The daemon's facts, as it last gave them. */
  #info: DockerInfo | null = null;
  /** Whether the desktop image's start points Xorg at the GPU placed, from its labels as last seen; null until bb-box has looked (#283). */
  #gpuBusId: boolean | null = null;
  /** The host's name as last known, kept in storage so a restart shows it before the daemon or BB has answered again (#265). */
  #knownName: string | null = null;
  /** The host's OS as last learned, from BB for a BB machine or from the daemon over ssh://, kept with the name. */
  #knownOs: GuestOs | null = null;
  /** Containers being acquired, by box ID, until their acquire ends. */
  readonly #placing = new Map<string, Placing>();
  /** Whether each Wayland box's image has Selkies (060). */
  readonly #selkies: SelkiesPresence;
  /** Whether each Wayland box's image has bb-box-cursor (060). */
  readonly #cursor: ImageFile;
  readonly #cursorHelper: string;

  /**
   * Image operations (049): a container from an image, its commit as an
   * image with its record, a standard image built by setup/docker/build.sh
   * under another tag, and the image's tag moved to a new build.
   */
  readonly images: BackendImages = {
    list: (signal) => this.#imageList(signal),
    box: (build, label, signal) => this.#imageBox(build, label, signal),
    capture: (box, from, image, signal) => this.#capture(box, from, image, signal),
    replace: (build, current, signal) => this.#replaceImage(build, current, signal),
    remove: (ref, signal) => this.#removeImage(ref, signal),
    build: (current, setup, options) => this.#buildStandard(current, setup, options),
    check: () => DOCKER_CHECK,
    startsFrom: true,
    spares: true,
  };
  /** Placement is one at a time, so two acquires never take the last room on the host. */
  #placement: Promise<unknown> = Promise.resolve();
  #hostCpus: { readonly at: number; readonly cpus: CpuList } | null = null;
  #daemonCpus: CpuList | null = null;

  constructor(config: DockerConfig, context: BackendContext, options: DockerBackendOptions = {}) {
    this.id = context.id;
    this.#config = config;
    this.#context = context;
    this.#options = options;
    this.#selkies = new SelkiesPresence(options.selkiesLauncher);
    this.#cursorHelper = options.cursorHelper ?? CURSOR_HELPER;
    this.#cursor = new ImageFile(this.#cursorHelper);
    this.#kinds = dockerKinds(config);
    this.#rootlessKinds = dockerKinds(config, true);
    this.#oldDesktopKinds = dockerKinds(config, false, false);
    const machine = config.machine;
    const machines = context.machines;
    this.#cli = options.cliReachingAHostAnotherBackendMade ?? (machine
      ? new DockerCli(machines?.dockerHost(machine) ?? null, options.binary, async () => {
          if (!machines) throw new Error(`bb-box reaches BB machine ${machine} only when it runs in BB.`);
          await machines.ready(machine);
        })
      : new DockerCli(config.host, options.binary));
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

  /** Remembers the host's OS, as BB or the daemon over ssh:// said it, for the next start. */
  async #keepOs(os: GuestOs): Promise<void> {
    if (os === this.#knownOs) return;
    this.#knownOs = os;
    await this.#context.storage.set(OS_KEY, os).catch(() => {});
  }

  /**
   * The OS of the machine the daemon runs on: BB's word for a BB machine
   * (its host entry knows a Windows PC under WSL), kept so a restart knows
   * it before the host entry has answered again; this process's platform
   * for a local daemon; and the daemon's own words for one over ssh://,
   * where a kernel saying "microsoft" is a Windows PC and Docker Desktop
   * or OrbStack on any other kernel is a Mac. Null until known.
   */
  get hostOs(): GuestOs | null {
    if (this.#config.machine) {
      const live = this.#context.machines?.platform?.(this.#config.machine) ?? null;
      if (live) void this.#keepOs(live);
      return live ?? this.#knownOs;
    }
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

  /** The kinds, with Docker until the daemon has said it is rootless, and a GPU desktop's until its image has said it is too old. */
  kinds(): BoxKind[] {
    if (this.#info?.rootless) return this.#rootlessKinds;
    return this.#gpuBusId === false ? this.#oldDesktopKinds : this.#kinds;
  }

  /**
   * Whether a box of `kind` is a privileged container with its own Docker
   * daemon (041). A privileged GPU desktop sees every GPU on the host, so it
   * is one only when its image's start can point Xorg at the GPU placed (#283).
   */
  #privileged(kind: string): boolean {
    return this.#config.docker && !this.#info?.rootless && (kind !== "linux-desktop" || this.#gpuBusId === true);
  }

  /** Reads from the desktop image's labels whether its start points Xorg at the GPU placed, keeping what was known when it cannot (#283). */
  async #readGpuBusId(signal?: AbortSignal): Promise<void> {
    const image = this.#config.images["linux-desktop"];
    if (!image || !this.#config.docker) return;
    const labels = await this.#imageLabels(image, signal).catch(() => null);
    if (!labels) return;
    this.#gpuBusId = labels[LABELS.gpuBusId] === "1";
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
      [state] = await Promise.all([this.#state(signal), kind === "linux-desktop" ? this.#readGpuBusId(signal) : null]);
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
      // Leads with what binds: the box when it needs more than is free, otherwise the memory kept free.
      const box = `a box with ${formatMiB(size.memoryMiB)}`;
      why =
        size.memoryMiB > memoryFree
          ? `${host} has ${formatMiB(Math.max(0, memoryFree))} of memory free, less than ${box} needs. Ask for less memory or release a box`
          : `${host} has ${formatMiB(memoryFree)} of memory free and keeps ${formatMiB(reserve)} free, so ${box} does not fit. ` +
            (memoryFree > reserve
              ? "Ask for less memory, release a box, or lower the memory kept free in bb-box's settings"
              : "Release a box, or lower the memory kept free in bb-box's settings");
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

  #underPlacement<T>(work: () => Promise<T>): Promise<T> {
    const done = this.#placement.then(work);
    this.#placement = done.catch(() => undefined);
    return done;
  }

  #pinsCpus(info: DockerInfo): boolean {
    return info.cpuset && info.cpus > 0;
  }

  #cpusHeldBesides(state: HostState, name: string | null): CpuList[] {
    const running = new Set(state.containers.filter((container) => ACTIVE.has(container.status)).map((container) => container.name));
    return [
      ...state.containers.filter((container) => running.has(container.name) && container.name !== name && container.cpus).map((container) => container.cpus!),
      ...[...this.#placing.values()].filter((other) => !running.has(other.name) && other.name !== name && other.cpus).map((other) => other.cpus!),
    ];
  }

  #learnRefusal(error: unknown): boolean {
    const said = message(error);
    if (!CPUS_NOT_AVAILABLE.test(said)) return false;
    this.#daemonCpus = daemonCpusFromRefusal(said) ?? this.#daemonCpus;
    return true;
  }

  async #cpusOfHost(info: DockerInfo, signal?: AbortSignal, again = false): Promise<CpuList> {
    return cpusBothAllow(await this.#probedCpus(info, signal, again), this.#daemonCpus);
  }

  async #probedCpus(info: DockerInfo, signal?: AbortSignal, again = false): Promise<CpuList> {
    if (!again && this.#hostCpus && Date.now() - this.#hostCpus.at < HOST_CPUS_KEPT_FOR_MS) return this.#hostCpus.cpus;
    if (!again) this.#daemonCpus = null;
    const image = DOCKER_KINDS.map((kind) => this.#config.images[kind]).find((each): each is string => Boolean(each));
    const probe = image
      ? await this.#cli.run(["container", "run", "--rm", "--pull", "never", "--network", "none", image, "cat", "/sys/fs/cgroup/cpuset.cpus.effective"], { timeoutMs: 30_000, signal })
      : null;
    const cpus = hostCpusFromProbe(probe?.exitCode === 0 ? probe.stdout : null, info.cpus);
    this.#hostCpus = { at: Date.now(), cpus };
    return cpus;
  }

  async #allot(state: HostState, name: string, cores: number, signal?: AbortSignal, again = false): Promise<CpuList | null> {
    if (!this.#pinsCpus(state.info)) return null;
    return allotCpus(await this.#cpusOfHost(state.info, signal, again), this.#cpusHeldBesides(state, name), cores);
  }

  /** Checks room and counts the box against the host, one acquire at a time. */
  #place(box: BoxIdentity, signal: AbortSignal): Promise<{ host: string; gpu: string | null; cpus: CpuList | null }> {
    return this.#underPlacement(async () => {
      const state = await this.#state(signal);
      const room = this.#room(state, box.kind, box.size);
      if (room.why !== null) throw new BackendError("no_capacity", this.#full(box.kind, room.why));
      const name = containerName(box.boxId);
      const cpus = await this.#allot(state, name, box.size.cores, signal);
      this.#placing.set(box.boxId, { name, memoryMiB: box.size.memoryMiB, gpu: room.gpu, cpus });
      return { host: room.capacity.host, gpu: room.gpu, cpus };
    });
  }

  #resumePlacement(box: BoxIdentity, gpu: string | null, signal: AbortSignal, again = false): Promise<CpuList | null> {
    return this.#underPlacement(async () => {
      const name = containerName(box.boxId);
      const cpus = await this.#allot(await this.#state(signal), name, box.size.cores, signal, again);
      this.#placing.set(box.boxId, { name, memoryMiB: box.size.memoryMiB, gpu, cpus });
      if (again) await this.#moveSharingBoxes(signal).catch((error) => this.#context.logError("moving boxes onto the host's CPUs as they are now", error));
      return cpus;
    });
  }

  async #moveSharingBoxes(signal?: AbortSignal): Promise<void> {
    const state = await this.#state(signal);
    if (!this.#pinsCpus(state.info)) return;
    const running = state.containers.filter((container) => ACTIVE.has(container.status) && container.cpus);
    const runningNames = new Set(state.containers.filter((container) => ACTIVE.has(container.status)).map((container) => container.name));
    const mine = running.filter((container) => container.labels[LABELS.install] === this.#context.installId);
    const held = [
      ...running.filter((container) => !mine.includes(container)).map((container) => container.cpus!),
      ...[...this.#placing.values()].filter((other) => !runningNames.has(other.name) && other.cpus).map((other) => other.cpus!),
    ];
    const moves = movesOntoFreeCpus(await this.#cpusOfHost(state.info, signal), mine.map((container) => ({ id: container.id, cpus: container.cpus! })), held);
    for (const move of moves) {
      try {
        await this.#cli.ok(["container", "update", "--cpuset-cpus", formatCpuList(move.cpus), move.id], { timeoutMs: 60_000, signal });
      } catch (error) {
        if (this.#learnRefusal(error)) this.#hostCpus = null;
        throw error;
      }
    }
  }

  async acquire(box: BoxIdentity, previous: Guest | null, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest> {
    const kind = this.#kind(box.kind);
    // A box from an image build (049) is a container of its image.
    const image = box.from ?? this.#config.images[box.kind as DockerKind]!;
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
    let cpus: CpuList | null;
    if (resumed) {
      host = previous.host ?? this.#host;
      gpu = typeof previous.data?.gpu === "string" ? previous.data.gpu : null;
      cpus = await this.#resumePlacement(box, gpu, signal);
    } else {
      ({ host, gpu, cpus } = await step("place", () => this.#place(box, signal)));
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
      gpu = await step("create", async () => {
        try {
          return await this.#create(box, image, gpu, cpus, signal);
        } catch (error) {
          if (!cpus || !this.#learnRefusal(error)) throw error;
          cpus = await this.#resumePlacement(box, gpu, signal, true);
          return this.#create(box, image, gpu, cpus, signal);
        }
      });
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
    this.#selkies.forget(guest.ref);
    this.#cursor.forget(guest.ref);
    await this.#remove(guest.ref, this.#boxOf(guest), signal);
    await this.#context.storage.delete(relabelKey(guest.ref));
    await this.#underPlacement(() => this.#moveSharingBoxes(signal)).catch((error) => this.#context.logError("moving boxes onto CPUs a release freed", error));
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

  /**
   * `docker update` changes a container's CPUs and memory while it runs,
   * within seconds, as its cgroup's limits; a box has no disk of its own
   * (028). `/dev/shm` keeps the size it had at create (061).
   */
  resizing(kind: string): Resizing | null {
    return this.kinds().some((offer) => offer.id === kind) ? { cores: "live", memory: "live", disk: "no", shrinks: true } : null;
  }

  async planResize(guest: Guest, kind: string, to: BoxSize, pending: readonly Pending[], signal?: AbortSignal): Promise<ResizePlan> {
    this.#kind(kind);
    const found = await this.#owned(guest.ref, this.#boxOf(guest), signal);
    if (!found) throw this.#gone(guest);
    const from = sizeOf(found) ?? guest.size;
    if (!from) throw new Error(`Container ${found.name} has no CPU or memory limit, so bb-box cannot resize it.`);
    const parts: ResizePlan["parts"][number][] = [];
    if (to.cores !== from.cores) parts.push({ part: "cores", from: from.cores, to: to.cores, way: "live" });
    if (to.memoryMiB !== from.memoryMiB) parts.push({ part: "memory", from: from.memoryMiB, to: to.memoryMiB, way: "live" });
    if (to.diskGiB !== null) parts.push({ part: "disk", from: null, to: to.diskGiB, way: "no" });
    return { parts, room: await this.#resizeRoom(from, to, pending, signal), downSeconds: null };
  }

  /** Changes a container's CPUs and memory, swap with it, as `docker update` does at once, running or stopped (061). */
  async resize(guest: Guest, _kind: string, to: BoxSize, _options: { readonly restart: boolean }, signal?: AbortSignal): Promise<Guest> {
    if (to.diskGiB !== null) throw new BackendError("unsupported", "A Docker box shares its host's disk, so it has no disk of its own to grow.");
    return this.#underPlacement(async () => {
      const found = await this.#owned(guest.ref, this.#boxOf(guest), signal);
      if (!found) throw this.#gone(guest);
      const from = sizeOf(found);
      const state = await this.#state(signal);
      const pinTo = async (again: boolean) =>
        this.#pinsCpus(state.info) ? resizeCpus(await this.#cpusOfHost(state.info, signal, again), this.#cpusHeldBesides(state, found.name), found.cpus ?? [], to.cores) : null;
      // Memory and swap together, as Docker refuses memory above the swap limit it has.
      const update = (cpus: CpuList | null) =>
        this.#cli.ok(
          ["container", "update", "--cpus", String(to.cores), ...(cpus ? ["--cpuset-cpus", formatCpuList(cpus)] : []), "--memory", `${to.memoryMiB}m`, "--memory-swap", `${to.memoryMiB}m`, found.id],
          { timeoutMs: 60_000, signal },
        );
      const cpus = await pinTo(false);
      const repinned = cpus !== null && formatCpuList(cpus) !== formatCpuList(found.cpus ?? []);
      if (!from || from.cores !== to.cores || from.memoryMiB !== to.memoryMiB || repinned) {
        try {
          await update(cpus);
        } catch (error) {
          if (!cpus || !this.#learnRefusal(error)) throw error;
          await update(await pinTo(true));
        }
      }
      if (from && to.cores < from.cores) await this.#moveSharingBoxes(signal).catch((error) => this.#context.logError("moving boxes onto CPUs a shrink freed", error));
      const [now] = await this.#cli.inspect([found.id], signal);
      return { ...guest, size: (now && sizeOf(now)) ?? to };
    });
  }

  /** Room on the host for a container to grow from `from` to `to`: the memory it adds, kept within the reserve, and cores within the host's (061). */
  async #resizeRoom(from: BoxSize, to: BoxSize, pending: readonly Pending[], signal?: AbortSignal): Promise<Capacity> {
    const state = await this.#state(signal);
    const { info, containers } = state;
    const host = info.name || this.#host;
    const active = containers.filter((container) => ACTIVE.has(container.status));
    const memoryUsed = active.reduce((sum, container) => sum + (container.memoryMiB ?? 0), 0) + pending.reduce((sum, other) => sum + other.size.memoryMiB, 0);
    const memoryFree = info.memoryMiB - memoryUsed;
    const reserve = this.#config.reserveMemoryMiB;
    const limits: Limit[] = [{ resource: "memory", used: memoryUsed, total: info.memoryMiB, reserve, unit: "MiB" }];
    const grow = to.memoryMiB - from.memoryMiB;
    let why: string | null = null;
    if (info.cpus && to.cores > info.cpus) {
      why = `${host} has ${info.cpus} cores, fewer than the ${to.cores} asked for. Ask for at most ${info.cpus} cores.`;
    } else if (grow > 0 && memoryFree - grow < reserve) {
      why =
        grow > memoryFree
          ? `${host} has ${formatMiB(Math.max(0, memoryFree))} of memory free, less than the ${formatMiB(grow)} more the box needs. Ask for less memory or release a box.`
          : `${host} has ${formatMiB(memoryFree)} of memory free and keeps ${formatMiB(reserve)} free, so the ${formatMiB(grow)} more the box needs does not fit. ` +
            "Ask for less memory, release a box, or lower the memory kept free in bb-box's settings.";
    }
    return { ok: why === null, message: why, warm: null, hosts: [{ host, ok: why === null, limits }] };
  }

  /** Whether a container comes from the build its kind's image names now: false once a refresh has moved the tag (049); null without either. */
  async fromCurrentBuild(guest: Guest, kind: string, signal?: AbortSignal): Promise<boolean | null> {
    const image = this.#config.images[kind as DockerKind];
    if (!image) return null;
    const found = await this.#owned(guest.ref, this.#boxOf(guest), signal);
    if (!found?.imageId) return null;
    const current = await this.#cli.run(["image", "inspect", "--format", "{{.Id}}", image], { timeoutMs: 30_000, signal });
    const id = current.exitCode === 0 ? current.stdout.trim() : "";
    return id ? id === found.imageId : null;
  }

  /** This install's containers, from their labels. */
  async held(signal?: AbortSignal): Promise<HeldGuest[]> {
    const [info, containers] = await Promise.all([
      this.#cli.info(signal),
      this.#cli.list({ [LABELS.backend]: "docker", [LABELS.install]: this.#context.installId }, signal),
    ]);
    this.#info = info;
    return Promise.all(
      // An image box (049) is no box's: its build removes it.
      containers.filter((container) => !container.labels[LABELS.imageBox]).map(async (container) => {
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
    // wayvnc offers Apple's sign-in, not a VNC password (048).
    const wayland = kind === "linux-desktop-wayland-cpu";
    // A Wayland box of an image built before Selkies was in it has no video (060).
    const video = !wayland || (await this.#selkies.has(guest.ref, command));
    // An image with bb-box-cursor (060): Sway 1.11, whose streams paint no pointer, so none is hidden, and Sway keeps a theme
    // the cursor session and wayvnc send as the pointer's shape. One without keeps #707's hidden theme.
    const sends = wayland && (await this.#cursor.has(guest.ref, command));
    const displays = (capabilities?.displays ?? []).filter((display) => video || display.protocol !== "selkies").map(
      (display): Display =>
        display.protocol === "selkies"
          ? selkiesDisplay((port) => command.route(port), display)
          : {
              ...display,
              label: "Desktop",
              open: async (signal) => {
                const password = await this.#vncPassword(command, signal);
                return {
                  route: await command.route(VNC_PORT),
                  auth: !password ? { type: "none" } : wayland ? { type: "apple", user: WAYVNC_USER, password } : { type: "vnc-password", password },
                };
              },
              ...(kind === "linux-desktop" ? { resize: (size: DisplaySize, signal?: AbortSignal) => this.#resize(command, size, signal) } : {}),
              ...(wayland ? { resize: (size: DisplaySize, signal?: AbortSignal) => this.#resizeWayland(command, size, signal), restartServer: (signal?: AbortSignal) => restartWayvnc(command, signal), serverAttached: async (signal?: AbortSignal) => (await wayvncAttached(command, signal)) !== false, pointer: (shown: boolean, signal?: AbortSignal) => waylandPointer(command, shown || sends, signal) } : {}),
              ...(sends ? { followPointer: (onEvent: (event: BoxPointer) => void, signal: AbortSignal) => followPointer(command, onEvent, signal, this.#cursorHelper) } : {}),
              minSize: MIN_DESKTOP,
            },
    );
    // No SSH server runs in a box, and its Docker is reached only through it, so only BB's server reaches it.
    return { command, displays, access: null };
  }

  async doctor(signal?: AbortSignal): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    const notes: string[] = [`This install's ID is ${this.#context.installId}. Its containers carry the label ${LABELS.install}=${this.#context.installId}.`];
    const push = (id: CheckId, name: string, status: DoctorCheck["status"], detail: string, fix: string | null = null) =>
      checks.push({ id, name, status, detail, fix });
    const skip = (id: CheckId, name: string) => push(id, name, "skipped", "Skipped until the checks above pass.");
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

      const reuse = await sshReuse(this.#cli.host, this.#options.ssh, signal);
      if (reuse?.shared) {
        push("docker.ssh", "SSH connection reuse", "ok", `The docker calls to ${reuse.host} share one SSH connection.`);
      } else if (reuse) {
        push(
          "docker.ssh",
          "SSH connection reuse",
          "warn",
          `Each docker call to ${reuse.host} logs in over SSH again, which took about 0.2 s on a LAN against 30 ms on a shared connection (#97).`,
          `In the ~/.ssh/config of the user BB runs as, give Host ${reuse.host} the lines ControlMaster auto, ControlPath ~/.ssh/cm-%C and ControlPersist 10m. See setup/docker/README.md.`,
        );
      }

      const limits = ["docker.limits", "CPU and memory limits"] as const;
      const limitsFix = info.rootless
        ? `Have systemd delegate the cgroup controllers to the user that runs rootless Docker on ${info.name}: put Delegate=cpu cpuset io memory pids under [Service] in /etc/systemd/system/user@.service.d/delegate.conf, run sudo systemctl daemon-reload, and restart the host.`
        : `Turn on the kernel's cpu and memory cgroup controllers on ${info.name}. docker info names what is missing in its warnings.`;
      if (!info.cpuLimit) {
        push(...limits, "fail", `Docker on ${info.name} cannot limit a container's CPU, so it refuses the CPU limit each box has, and no box starts.${info.memoryLimit ? "" : " Nor can it limit memory."}`, limitsFix);
      } else if (!info.memoryLimit) {
        push(...limits, "warn", `Docker on ${info.name} cannot limit a container's memory, so boxes there start without their memory limit, and one box can take all of the host's memory.`, limitsFix);
      } else {
        push(...limits, "ok", "Docker limits each box's CPU and memory.");
      }
      if (info.cpuLimit) {
        const pinning = ["docker.cpuset", "Cores a box sees"] as const;
        if (this.#pinsCpus(info)) {
          const probed = await this.#probedCpus(info, signal, true);
          const daemon = this.#daemonCpus;
          if (daemon && formatCpuList(daemon) !== formatCpuList(probed)) {
            push(
              ...pinning,
              "warn",
              `Docker on ${info.name} keeps the CPUs it had when it started (${formatCpuList(daemon)}), but its containers may now have ${formatCpuList(probed)}, as when Proxmox moves an LXC container's CPUs. Boxes are pinned to CPUs in both (${formatCpuList(cpusBothAllow(probed, daemon))}), so a box may see fewer CPUs than it has cores.`,
              `Restart Docker on ${info.name} (sudo systemctl restart docker), which restarts its boxes too, so it takes the CPUs as they are now.`,
            );
          } else {
            push(...pinning, "ok", `Each box is pinned to as many of ${info.name}'s CPUs (${formatCpuList(cpusBothAllow(probed, daemon))}) as it has cores, so nproc, make -j$(nproc) and the like see its cores.`);
          }
        } else {
          push(
            ...pinning,
            "warn",
            `Docker on ${info.name} cannot pin a container to CPUs, so nproc in a box says the host's CPUs, not the box's cores, and make -j$(nproc) and the like start too many jobs. Boxes there get OMP_NUM_THREADS set to their cores, which nproc follows, and which keeps its first value after a resize.`,
            info.rootless
              ? `Have systemd delegate the cpuset cgroup controller to the user that runs rootless Docker on ${info.name}: put Delegate=cpu cpuset io memory pids under [Service] in /etc/systemd/system/user@.service.d/delegate.conf, run sudo systemctl daemon-reload, and restart the host.`
              : `Turn on the kernel's cpuset cgroup controller on ${info.name}. docker info names what is missing in its warnings.`,
          );
        }
      }

      // What images are judged by (049).
      const judging = Promise.all([
        this.#context.images?.pins("linux") ?? null,
        this.#context.images?.pins("linux-desktop") ?? null,
        this.#context.images?.bbApp(signal) ?? null,
      ]).catch(() => [null, null, null] as const);
      for (const image of images) {
        const serves = DOCKER_KINDS.filter((kind) => this.#config.images[kind] === image);
        const kinds = serves.join(", ");
        const id = `image.${image}` as const;
        const name = `Image ${image}`;
        const result = await this.#cli.run(["image", "inspect", "--format", IMAGE_FORMAT, image], { timeoutMs: 30_000, signal });
        if (result.exitCode !== 0) {
          push(id, name, "fail", `${info.name} has no image ${image}, which ${kinds} boxes run. bb-box never pulls images.`, this.#buildFix("Build it with setup/docker/build.sh, or pull or load it on the Docker host."));
          continue;
        }
        const { labels, sizeBytes } = imageFacts(result.stdout.trim());
        const gpuDesktops = image === this.#config.images["linux-desktop"];
        if (gpuDesktops) this.#gpuBusId = labels[LABELS.gpuBusId] === "1";
        const built = labels[LABELS.imageVersion];
        const record = withSize(recordFromJson(labels[LABELS.imageRecord]), sizeBytes);
        if (built === IMAGE_VERSION && gpuDesktops && !this.#gpuBusId && this.#config.docker && !info.rootless) {
          push(
            id,
            name,
            "warn",
            "Built before GPU desktops could have Docker, so they have none: its start cannot point Xorg at the GPU placed in a privileged container (#283).",
            this.#buildFix("Build it again with this bb-box's setup/docker/build.sh to give GPU desktops Docker."),
          );
        } else if (record || built === IMAGE_VERSION) {
          // Its record's contract replaces the layout version (049).
          const [linuxPins, desktopPins, app] = await judging;
          const judged = judgeImage(
            record,
            { os: "linux", pins: serves.includes("linux") ? linuxPins : desktopPins, bbApp: app },
            this.#buildFix("Build it again with this bb-box's setup/docker/build.sh --bb-url <BB's server URL>."),
          );
          push(id, name, judged.status, `For ${kinds} boxes. ${judged.detail}`, judged.fix);
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
          `Each box is a privileged container with its own Docker daemon, so a box can become root on ${info.name}. This is not a security boundary.`,
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

      const room = this.#room(state, "linux", this.#context.kind("linux").defaultSize);
      push(
        "docker.capacity",
        `Room on ${info.name}`,
        room.why === null ? "ok" : "warn",
        room.why ??
          room.capacity.limits.map((limit) => `${limit.resource} ${limit.unit === "MiB" ? `${formatMiB(limit.used)} of ${formatMiB(limit.total ?? 0)}` : `${limit.used} of ${limit.total}`}`).join(", "),
        room.why === null ? null : "Release a box, or change the most boxes or the memory kept free in bb-box's settings.",
      );
      const sizes = sizesCheck({
        id: "docker.sizes",
        name: "Box sizes",
        host: info.name,
        has: `${info.cpus ? `${info.cpus} cores and ` : ""}${formatMiB(info.memoryMiB)} memory`,
        keepsMiB: this.#config.reserveMemoryMiB,
        kinds: DOCKER_KINDS.filter((kind) => this.#config.images[kind]).map((kind) => ({
          kind,
          settings: this.#context.kind(kind),
          largest: { cores: info.cpus || Infinity, memoryMiB: info.memoryMiB - this.#config.reserveMemoryMiB, diskGiB: null },
        })),
      });
      if (sizes) checks.push(sizes);

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
  async #create(box: BoxIdentity, image: string, gpu: string | null, cpus: CpuList | null, signal: AbortSignal): Promise<string | null> {
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
    if (box.kind === "linux-desktop" && gpu) await this.#readGpuBusId(signal);
    const privileged = this.#privileged(box.kind);
    const extra = [
      // Docker's own data on a volume, since overlayfs cannot hold overlayfs.
      ...(privileged ? ["--privileged", "--env", "BBBOX_DOCKERD=1", "--volume", "/var/lib/docker"] : []),
      ...(box.kind === "linux-desktop" && gpu ? ["--device", gpu, "--env", "NVIDIA_DRIVER_CAPABILITIES=all", "--env", "BBBOX_GPU=1"] : []),
      // A privileged container sees every GPU on the host, and Xorg would
      // take the first, so the box's start points Xorg at the one placed, by
      // its UUID or index, as nvidia-smi --id takes it (#283).
      ...(box.kind === "linux-desktop" && gpu && privileged ? ["--env", `BBBOX_GPU_ID=${gpu.slice(gpu.indexOf("=") + 1)}`] : []),
    ];
    const args = [
      "container", "create",
      "--pull", "never",
      "--name", name,
      ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      "--hostname", hostnameOf(box.name),
      "--init",
      "--cpus", String(cores),
      ...(cpus ? ["--cpuset-cpus", formatCpuList(cpus)] : ["--env", `OMP_NUM_THREADS=${Math.ceil(cores)}`]),
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

  /** An image's labels, or null when the host has no such image. */
  async #imageLabels(ref: string, signal?: AbortSignal): Promise<(Record<string, unknown> & { readonly [SIZE]?: number | null }) | null> {
    const result = await this.#cli.run(["image", "inspect", "--format", IMAGE_FORMAT, ref], { timeoutMs: 30_000, signal });
    if (result.exitCode !== 0) return null;
    const { labels, sizeBytes } = imageFacts(result.stdout.trim());
    return { ...labels, [SIZE]: sizeBytes };
  }

  #imageBuild(ref: string, kind: string, image: string, labels: Record<string, unknown> & { readonly [SIZE]?: number | null }, current: boolean): ImageBuild {
    const record = withSize(recordFromJson(labels[LABELS.imageRecord]), labels[SIZE] ?? null);
    return { ref, image, kind, build: record?.build ?? null, record, current };
  }

  /** The configured images, as standard builds, and this install's captured images and image boxes. */
  async #imageList(signal?: AbortSignal): Promise<{ builds: ImageBuild[]; boxes: string[] }> {
    await this.#cli.prepare(signal);
    const install = this.#context.installId;
    const builds: ImageBuild[] = [];
    for (const image of [...new Set(DOCKER_KINDS.map((kind) => this.#config.images[kind]))]) {
      if (!image) continue;
      const labels = await this.#imageLabels(image, signal);
      const kind = DOCKER_KINDS.find((candidate) => this.#config.images[candidate] === image)!;
      if (labels) builds.push(this.#imageBuild(image, kind, "standard", labels, true));
    }
    const listed = await this.#cli.ok(
      ["image", "ls", "--filter", `label=${LABELS.install}=${install}`, "--filter", `label=${LABELS.image}`, "--format", "{{.Repository}}:{{.Tag}}"],
      { timeoutMs: 30_000, signal },
    );
    for (const ref of listed.split("\n").map((line) => line.trim()).filter(Boolean)) {
      const labels = await this.#imageLabels(ref, signal);
      const image = labels?.[LABELS.image];
      if (labels && typeof image === "string" && image) builds.push(this.#imageBuild(ref, String(labels[LABELS.kind] ?? ""), image, labels, false));
    }
    const boxes = await this.#cli.list({ [LABELS.backend]: "docker", [LABELS.install]: install, [LABELS.imageBox]: install }, signal);
    return { builds, boxes: boxes.map((container) => container.name) };
  }

  /** A container from a build's image, made as a box of its kind is, at its default size, labelled so that no sweep takes it. */
  async #imageBox(build: ImageBuild, label: string, signal: AbortSignal): Promise<ImageBox> {
    await this.#cli.prepare(signal);
    await this.#network(signal);
    const kind = this.#kind(build.kind);
    const name = `bbbox-image-${randomBytes(6).toString("hex")}`;
    const { cores, memoryMiB } = this.#context.kind(build.kind).defaultSize;
    const privileged = this.#privileged(build.kind);
    const labels: Record<string, string> = {
      [LABELS.backend]: "docker",
      [LABELS.install]: this.#context.installId,
      [LABELS.imageBox]: this.#context.installId,
      [LABELS.kind]: build.kind,
      [LABELS.name]: label.slice(0, 120),
    };
    const args = [
      "container", "create",
      "--pull", "never",
      "--name", name,
      ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      "--hostname", "bb-box-image",
      "--init",
      "--cpus", String(cores),
      "--memory", `${memoryMiB}m`,
      "--memory-swap", `${memoryMiB}m`,
      "--shm-size", `${Math.max(SHM_MIN_MiB, Math.floor(memoryMiB / 2))}m`,
      "--pids-limit", "16384",
      "--stop-timeout", "10",
      "--tmpfs", "/run:exec,mode=755",
      "--network", this.#config.network,
      ...(privileged ? ["--privileged", "--env", "BBBOX_DOCKERD=1", "--volume", "/var/lib/docker"] : []),
      build.ref,
      START,
    ];
    try {
      await this.#cli.ok(args, { timeoutMs: 120_000, signal });
      await this.#cli.ok(["container", "start", name], { timeoutMs: 120_000, signal });
      await this.#ready(name, Date.now() + (this.#options.readyTimeoutMs ?? kind.readyTimeoutMs), signal);
      return { ref: name, command: new DockerTransport(this.#cli, name) };
    } catch (error) {
      await this.#cli.run(["container", "rm", "--force", "--volumes", name], { timeoutMs: 120_000 }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Stops an image box and commits it as bbbox-image/<image>:<build>, with
   * its record in the image's labels; the container then goes. Docker is
   * off in the image, and the image-box label empty, so a box of it is a box.
   */
  async #capture(box: ImageBox, from: ImageBuild, image: string, signal: AbortSignal): Promise<ImageBuild> {
    const read = await box.command.run("cat /usr/share/bb-box/image.json", { timeoutMs: 15_000, signal, maxOutputBytes: 64 * 1024 });
    const record = read.exitCode === 0 ? recordFromJson(read.stdout.trim()) : null;
    if (!record) throw new Error(`Image box ${box.ref} has no image record in /usr/share/bb-box/image.json, which finalizing writes.`);
    const tag = `bbbox-image/${image}:${record.build.replace(/^build\./, "")}`;
    await this.#cli.ok(["container", "stop", "--time", "30", box.ref], { timeoutMs: 120_000, signal });
    const label = (key: string, value: string) => ["--change", `LABEL ${key}=${JSON.stringify(value)}`];
    await this.#cli.ok(
      [
        "container", "commit",
        ...label(LABELS.imageRecord, JSON.stringify(record)),
        ...label(LABELS.image, image),
        ...label(LABELS.kind, from.kind),
        ...label(LABELS.imageBox, ""),
        "--change", "ENV BBBOX_DOCKERD=0",
        box.ref,
        tag,
      ],
      { timeoutMs: 30 * 60_000, signal },
    );
    await this.#cli.run(["container", "rm", "--force", "--volumes", box.ref], { timeoutMs: 120_000, signal });
    return { ref: tag, image, kind: from.kind, build: record.build, record, current: false };
  }

  /**
   * Moves a standard image's tag to a new build. The old image goes once no
   * container uses it: now if none does, else it stays, untagged, with them.
   */
  async #replaceImage(build: ImageBuild, current: ImageBuild, signal: AbortSignal): Promise<ImageBuild> {
    if (!current.current || build.current) throw new Error(`${current.ref} is not a configured image, or ${build.ref} is one.`);
    const old = (await this.#cli.run(["image", "inspect", "--format", "{{.Id}}", current.ref], { timeoutMs: 30_000, signal })).stdout.trim();
    await this.#cli.ok(["image", "tag", build.ref, current.ref], { timeoutMs: 60_000, signal });
    await this.#cli.ok(["image", "rm", build.ref], { timeoutMs: 60_000, signal });
    if (old) await this.#cli.run(["image", "rm", old], { timeoutMs: 120_000, signal });
    return { ...build, ref: current.ref, image: "standard", current: true };
  }

  /** Removes an image box, a captured image or a refresh's build of this install's, and nothing else. */
  async #removeImage(ref: string, signal?: AbortSignal): Promise<void> {
    await this.#cli.prepare(signal);
    const install = this.#context.installId;
    const [container] = await this.#cli.inspect([ref], signal);
    if (container) {
      if (container.labels[LABELS.imageBox] !== install) throw new Error(`The container ${ref} is not an image box of this install's, so bb-box leaves it.`);
      await this.#cli.run(["container", "rm", "--force", "--volumes", container.id], { timeoutMs: 120_000, signal });
      return;
    }
    const labels = await this.#imageLabels(ref, signal);
    if (!labels) return;
    const configured = DOCKER_KINDS.some((kind) => this.#config.images[kind] === ref);
    const captured = labels[LABELS.install] === install && !!labels[LABELS.image];
    const refreshing = DOCKER_KINDS.some((kind) => this.#config.images[kind] && ref.startsWith(`${this.#config.images[kind]!.replace(/:[^:/]*$/, "")}:refresh-`));
    if (configured || !(captured || refreshing)) throw new Error(`The image ${ref} is not an image build of this install's, so bb-box leaves it.`);
    await this.#cli.run(["image", "rm", ref], { timeoutMs: 120_000, signal });
  }

  /** A new build of a configured image, by setup/docker/build.sh from `setup`, under a tag of its own until it replaces the image. */
  async #buildStandard(current: ImageBuild, setup: string, options: { bbUrl: string | null; log: (line: string) => void; signal: AbortSignal }): Promise<ImageBuild> {
    const kind = DOCKER_KINDS.find((candidate) => this.#config.images[candidate] === current.ref);
    if (!kind || !current.current) throw new Error(`${current.ref} is not a configured image.`);
    const tag = `${current.ref.replace(/:[^:/]*$/, "")}:refresh-${Date.now().toString(36)}`;
    await this.#cli.prepare(options.signal);
    const env = { ...process.env, ...(this.#cli.host ? { DOCKER_HOST: this.#cli.host } : {}) };
    const args = [...(options.bbUrl ? ["--bb-url", options.bbUrl] : []), "--tag", tag, BUILD_TARGET[kind]];
    const code = await (this.#options.script ?? runScript)(join(setup, "docker", "build.sh"), args, env, options.log, options.signal);
    if (code !== 0) {
      await this.#cli.run(["image", "rm", tag], { timeoutMs: 120_000 }).catch(() => undefined);
      throw new Error(`setup/docker/build.sh exited with ${code ?? "a signal"}.`);
    }
    const labels = await this.#imageLabels(tag, options.signal);
    if (!labels) throw new Error(`setup/docker/build.sh made no image ${tag}.`);
    return this.#imageBuild(tag, current.kind, "standard", labels, false);
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
    const { width, height } = wholeSize(size);
    const script = `[ "$(cat ${DISPLAY_MODE_FILE} 2>/dev/null)" = cpu ] || ${DISPLAY_ENV} xrandr --fb ${width}x${height}`;
    const result = await command.run(script, { timeoutMs: 15_000, signal, maxOutputBytes: 4096 });
    if (result.exitCode !== 0) {
      throw new Error(`xrandr could not set the desktop to ${width}x${height}: ${result.stderr.trim() || `exit code ${result.exitCode}`}.`);
    }
  }

  /**
   * Sets the Wayland desktop's size with its display script, as the box user:
   * Sway's output takes the size, and the floating windows are fitted into it,
   * as in a Proxmox LXC box (048). A size Sway cannot take fails with the
   * script's reason.
   */
  async #resizeWayland(command: DockerTransport, size: DisplaySize, signal?: AbortSignal): Promise<void> {
    const { width, height } = wholeSize(size);
    const result = await command.run(`${DISPLAY_SCRIPT} resize ${width}x${height}`, { timeoutMs: 15_000, signal, maxOutputBytes: 4096 });
    if (result.exitCode !== 0) {
      throw new Error(`Sway could not set the desktop to ${width}x${height}: ${result.stderr.trim() || `exit code ${result.exitCode}`}.`);
    }
  }
}

/** A size a desktop can take, in whole pixels, or an error. */
function wholeSize({ width, height }: DisplaySize): DisplaySize {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`The desktop cannot be ${width} by ${height} pixels.`);
  }
  return { width, height };
}
