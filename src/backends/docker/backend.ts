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
//   install's; and boxes per card for GPU boxes, from the cards the
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
  type BackendStorage,
  type DockerDaemonIdentity,
  type DockerDaemonReached,
  type BoxIdentity,
  type BoxKind,
  type CapacityAsking,
  type GpuPart,
  type GpuRefusal,
  type GpuResize,
  type GpuRoom,
  type GuestFact,
  type ResizeTarget,
  type Started,
  type BoxOwner,
  type MachineSize,
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
  type IdentitySource,
} from "../types.ts";
import { sizesCheck } from "../fit.ts";
import { endpointOf } from "../../host/relay.ts";
import { ATTACH_PING, forwarderReason, isLocalhost, readAfterHalfClose } from "./attach.ts";
import { DockerCli, LABELS, NO_SUCH, abortable, sshReuse, type ContainerInfo, type DockerInfo } from "./cli.ts";
import { containerLxcfsProbeArgs, lxcfsFromContainerProbe, lxcfsFromProbe, lxcfsMountArgs, lxcfsProbeArgs, type LxcfsOnHost } from "./lxcfs.ts";
import { allotCpus, cpusBothAllow, cpusToPinTo, daemonCpusFromRefusal, formatCpuList, hostCpusFromProbe, movesOntoFreeCpus, resizeCpus, type CpuList } from "./cpus.ts";
import { BB_MACHINE, DOCKER_KINDS, IMAGE_VERSION, type DockerConfig, type DockerKind } from "./config.ts";
import { judgeImage, recordFromJson, type ImageRecord } from "../images.ts";
import { CURSOR_HELPER, ImageFile, SELKIES_DISPLAY, followPointer, SelkiesPresence, WAYLAND_SELKIES_DISPLAY, selkiesDisplay } from "../selkies.ts";
import { BOX_USER, DockerTransport } from "./transport.ts";
import { restartWayvnc, wayvncAttached, waylandPointer } from "../wayvnc.ts";
import { IDENTITY_VARIABLE } from "../../core/identity.ts";
import { dockerImageBuilding } from "./building.ts";
import { backendsOn, daemonKey, daemonShare, engineKey, joinDaemon, leaveDaemon, underDaemonLock, type DaemonShare } from "./daemons.ts";
import { WHOLE_CARDS_OFF, WHOLE_CARDS_OFF_FOR_RESIZE } from "../../core/gpu.ts";
import { SERVER_GPU_MIB, type CardCheck } from "../card-check.ts";
import {
  ALL_CARDS_DEVICE,
  AVOID_CARD_MS,
  DESKTOP_GPU_MIB,
  DOCKER_CARD_CHECK,
  PROBE_SCRIPT,
  READING_FRESH_MS,
  READING_KEPT_MS,
  auditCards,
  wholeHoldersOnNoCard,
  cardName,
  cardKeyOf,
  cardOfLabels,
  cardOfUuid,
  cardRooms,
  hostListsCards,
  oneDeviceForEveryCardOf,
  cardsOnHost,
  claimOf,
  cudaVisible,
  deviceCard,
  environmentScript,
  factWords,
  holderName,
  judgeDockerCardCheck,
  noCardsRefusal,
  parseProbe,
  partOfLabel,
  placeCard,
  placementOf,
  placementRefusal,
  reachWords,
  seeItWords,
  threadsNamed,
  wrongCard,
  type BoxWhat,
  type CardHolder,
  type CardPart,
  type CardsOnHost,
  type DockerCard,
  type ProbedCard,
  type ThreadTitles,
} from "./gpus.ts";

/** The images start a box in about a second; a desktop takes a few more. This leaves room for a busy host. */
const READY_TIMEOUT_MS = 60_000;
/** setup/docker/start writes it once the box is up. /run is a tmpfs, so it is new at each start. */
const READY_FILE = "/run/bb-box/ready";
const MACHINE_ATTACH_FIX = "Set machine-docker-host to wsl://<distro> on this backend. The host stays bb:<machine ID>. dockerd stays on its unix socket.";
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
const PROBES_REFRESHED_AFTER_MS = 6 * 60_000;
const CPUS_NOT_AVAILABLE = /Requested CPUs are not available|for cpuset cpus/i;

export const CUA_DRIVER: ComputerUse = { driver: "cua", version: "0.28.3", socket: "/home/box/.cache/cua-driver/cua-driver.sock" };
const DOCKER_COMMAND: CommandCapability = { transport: "docker", shell: "sh", admin: true, inDesktopSession: false, streaming: true };

type Step = <T>(name: string, run: () => Promise<T>) => Promise<T>;
type Pending = { readonly kind: string; readonly size: MachineSize };
type CardPlacing = ({ readonly is: "placed"; readonly card: DockerCard } | { readonly is: "refused"; readonly refusal: GpuRefusal }) & { readonly limits: readonly Limit[] };
type StoredPart = { readonly part: CardPart; readonly generation: number };
type PartRecord = StoredPart & { readonly writtenUnder: DockerDaemonIdentity };
const GPU_PARTS = "docker/gpu-part/";
const GPU_PART_KEY = (containerId: string) => `${GPU_PARTS}${containerId}`;
const GPU_FACT = "GPU";
const GPU_CHECK_FACT = "GPU check";
const CARDS_FACT = "Cards";
const TITLE_WAIT_MS = 2_000;

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
  readonly now?: () => number;
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
  readonly backendId: string;
  readonly name: string;
  readonly memoryMiB: number;
  readonly gpu: string | null;
  readonly cpus: CpuList | null;
  readonly card: string | null;
  readonly part: GpuPart;
  readonly needMiB: number;
  readonly boxName: string;
  readonly threadId: string;
}

interface MadeGpu {
  readonly gpu: string | null;
  readonly card: string | null;
  readonly part: GpuPart;
}

interface WrongCard {
  readonly is: "wrong";
  readonly card: string;
  readonly named: string;
  readonly why: string;
}

type CheckedFacts = { readonly is: "facts"; readonly facts: readonly GuestFact[] } | WrongCard;

function madeOnCard(card: DockerCard | null, part: GpuPart): MadeGpu {
  if (!card) return { gpu: null, card: null, part: "none" };
  return { gpu: card.device, card: card.uuidKnown ? card.uuid : null, part };
}

function madeOf(guest: Guest): MadeGpu {
  const gpu = typeof guest.data?.gpu === "string" ? guest.data.gpu : null;
  if (!gpu) return { gpu: null, card: null, part: "none" };
  const card = typeof guest.data?.card === "string" ? guest.data.card : deviceCard(gpu);
  return { gpu, card, part: guest.data?.part === "whole" ? "whole" : "shared" };
}

interface PlacedBox {
  readonly host: string;
  readonly gpu: string | null;
  readonly card: DockerCard | null;
  readonly part: GpuPart;
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
  readonly placing: readonly Placing[];
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
function sizeOf(container: ContainerInfo): MachineSize | null {
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

function dataOf(container: ContainerInfo, card: string | null, part: GpuPart): Record<string, string> {
  const box = container.labels[LABELS.box];
  const gpu = container.labels[LABELS.gpu];
  return { ...(box ? { box } : {}), ...(gpu ? { gpu, part } : {}), ...(card ? { card } : {}) };
}

function guestCard(guest: Guest): { readonly card: string; readonly part: CardPart } | null {
  const card = typeof guest.data?.card === "string" ? guest.data.card : typeof guest.data?.gpu === "string" ? deviceCard(guest.data.gpu) : null;
  if (!card) return null;
  return { card, part: guest.data?.part === "whole" ? "whole" : "shared" };
}

function neededMiB(kind: string): number {
  return kind === "linux-desktop" ? DESKTOP_GPU_MIB : SERVER_GPU_MIB;
}

function boxWhat(kind: string): BoxWhat {
  return kind === "linux-desktop" ? "desktop" : "server";
}

function withoutGpuFacts(facts: readonly GuestFact[] | undefined): GuestFact[] {
  return (facts ?? []).filter((fact) => fact.label !== GPU_FACT && fact.label !== GPU_CHECK_FACT && fact.label !== CARDS_FACT);
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function listOf(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function machineSize(size: MachineSize): MachineSize {
  return { cores: size.cores, memoryMiB: size.memoryMiB, diskGiB: size.diskGiB };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
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
        device: null,
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
        device: null,
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
        device: null,
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
        device: null,
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
  if (host.startsWith("wsl://")) return host.slice("wsl://".length);
  return host;
}

const SETGID_PROBE = ["setpriv", "--reuid=65534", "--regid=65534", "--clear-groups", "/usr/sbin/unix_chkpwd", "nobody", "chkexpiry"];

export function refusedByAppArmor(result: { readonly exitCode: number | null; readonly stderr: string }): boolean {
  return result.exitCode === 127 && /cannot apply additional memory protection after relocation: Permission denied/.test(result.stderr);
}

function daemonIdentityOf(info: DockerInfo): DockerDaemonIdentity {
  return { engineId: info.id, name: info.name, rootDir: info.rootDir };
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
  #share: DaemonShare<Placing> | null = null;
  readonly #reservedIn = new Map<string, DaemonShare<Placing>>();
  #joined = false;
  #hostCpus: { readonly at: number; readonly cpus: CpuList } | null = null;
  #daemonCpus: CpuList | null = null;
  #lxcfs: { readonly at: number; readonly on: LxcfsOnHost | null } | null = null;
  #reading: { readonly at: number; readonly probed: readonly ProbedCard[] | null; readonly unread: string | null } | null = null;
  #probing: Promise<void> | null = null;
  #lastProbed: readonly ProbedCard[] | null = null;

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
  identitySource(kind: string): IdentitySource | null {
    return this.kinds().some((offered) => offered.id === kind) ? "value" : null;
  }

  kinds(): BoxKind[] {
    const kinds = this.#info?.rootless ? this.#rootlessKinds : this.#gpuBusId === false ? this.#oldDesktopKinds : this.#kinds;
    return kinds.map((kind) => {
      const parts = this.#gpuParts(kind.id);
      return parts ? { ...kind, gpuParts: parts } : kind;
    });
  }

  #wholeOn(): boolean {
    return this.#context.wholeCards?.() ?? false;
  }

  #gpuParts(kind: string): readonly GpuPart[] | null {
    if (!this.#config.gpus) return null;
    const whole: readonly GpuPart[] = this.#wholeOn() ? ["whole"] : [];
    if (kind === "linux" && this.#config.images.linux) return ["none", "shared", ...whole];
    if (kind === "linux-desktop" && this.#config.images["linux-desktop"]) return ["shared", ...whole];
    return null;
  }

  #gpuAsked(kind: string, gpu: GpuPart | undefined): GpuPart {
    if (gpu !== undefined) return gpu;
    return kind === "linux-desktop" ? "shared" : "none";
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
    return `Run bb box docker-build ${/^[A-Za-z0-9_.-]+$/.test(named) ? named : machine}, or turn Docker on ${this.#host} off and on in bb-box's settings, to build it there.`;
  }

  /** The host's name for people: a BB machine's as BB has it, else as the daemon gives it once it has answered. */
  get #host(): string {
    if (this.#config.machine) return hostWords(this.#config.host, this.#context.machines);
    return this.#info?.name || hostWords(this.#config.host);
  }

  async capacity(kind: string, size: MachineSize & { readonly gpu?: GpuPart }, pending: readonly Pending[], signal?: AbortSignal, asking?: CapacityAsking): Promise<Capacity> {
    this.#kind(kind);
    const part = this.#gpuAsked(kind, size.gpu);
    const refusedPart = this.#partRefusal(kind, part);
    if (refusedPart) return { ok: false, message: refusedPart.person, agentMessage: refusedPart.agent, warm: null, hosts: [{ host: this.#host, ok: false, limits: [] }] };
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
    const placed = state.placing;
    const unplaced: Unplaced = {
      count: Math.max(0, pending.length - placed.length),
      memoryMiB: Math.max(0, pending.reduce((sum, other) => sum + other.size.memoryMiB, 0) - placed.reduce((sum, other) => sum + other.memoryMiB, 0)),
      gpuDesktops: Math.max(0, pending.filter((other) => other.kind === "linux-desktop").length - placed.filter((other) => other.gpu).length),
    };
    const shared = this.#sharedDaemonRefusal(part);
    if (shared) return { ok: false, message: shared.person, agentMessage: shared.agent, warm: null, hosts: [{ host: state.info.name || this.#host, ok: false, limits: [] }] };
    const room = this.#room(state, kind, size, unplaced);
    if (room.why !== null || part === "none") return { ok: room.why === null, message: room.why === null ? null : this.#full(kind, room.why), warm: null, hosts: [room.capacity] };
    const onCard = await this.#cardPlacement(state, kind, part, asking?.threadId ?? null, kind === "linux-desktop" && part === "shared" ? unplaced.gpuDesktops : 0, READING_KEPT_MS, signal);
    const limits = [...room.capacity.limits, ...onCard.limits];
    if (onCard.is === "refused") return { ok: false, message: onCard.refusal.person, agentMessage: onCard.refusal.agent, warm: null, hosts: [{ ...room.capacity, ok: false, limits }] };
    return { ok: true, message: null, warm: null, hosts: [{ ...room.capacity, limits }] };
  }

  #partRefusal(kind: string, part: GpuPart): GpuRefusal | null {
    if (part === "none") return kind === "linux-desktop" ? { person: `${this.label} gives linux-desktop boxes a GPU. Ask for a linux-desktop-cpu box for a desktop drawn by the CPU.`, agent: "Not made: a linux-desktop on Docker always has a GPU. Ask for a linux-desktop-cpu box, or ask the user. bb-box changed nothing." } : null;
    if (!this.#gpuParts(kind)?.includes(part)) {
      if (part === "whole" && this.#gpuParts(kind)?.includes("shared")) return WHOLE_CARDS_OFF;
      return {
        person: `${this.label} gives ${kind} boxes no GPU${this.#config.gpus ? "" : ": GPU boxes are off in its settings"}. Ask for gpu none.`,
        agent: `Not made: ${this.label} gives ${kind} boxes no GPU. Ask for gpu none, or ask the user. bb-box changed nothing.`,
      };
    }
    return null;
  }

  async #titles(threads: readonly string[]): Promise<ThreadTitles> {
    const lookup = this.#context.threadTitle;
    const titles = new Map<string, string | null>();
    if (!lookup) return titles;
    await Promise.all(
      threads.map(async (threadId) => {
        titles.set(threadId, await Promise.race([lookup(threadId).catch(() => null), sleep(TITLE_WAIT_MS).then(() => null)]));
      }),
    );
    return titles;
  }

  get #storageOfEveryBackend(): BackendStorage {
    return this.#context.sharedStorage ?? this.#context.storage;
  }

  async #storedPart(containerId: string): Promise<StoredPart | null> {
    const stored = await this.#storageOfEveryBackend.get<PartRecord>(GPU_PART_KEY(containerId)).catch(() => undefined);
    return stored && (stored.part === "shared" || stored.part === "whole") && Number.isInteger(stored.generation) ? { part: stored.part, generation: stored.generation } : null;
  }

  async #writtenUnder(signal?: AbortSignal): Promise<DockerDaemonIdentity> {
    await this.#shared(signal);
    return this.#info ? daemonIdentityOf(this.#info) : { engineId: "", name: "", rootDir: "" };
  }

  async dockerDaemons(signal?: AbortSignal): Promise<readonly DockerDaemonReached[]> {
    const [info, containers] = await Promise.all([this.#cli.info(signal), this.#cli.ids({ [LABELS.backend]: "docker", [LABELS.install]: this.#context.installId }, signal)]);
    return [{ ...daemonIdentityOf(info), containers }];
  }

  async #partOf(container: ContainerInfo): Promise<StoredPart> {
    const mine = container.labels[LABELS.install] === this.#context.installId;
    const switched = mine ? await this.#storedPart(container.id) : null;
    return switched ?? { part: partOfLabel(container.labels[LABELS.gpuPart]), generation: 1 };
  }

  async #dropPartsOfGoneContainers(state: HostState, signal?: AbortSignal): Promise<void> {
    const here = daemonIdentityOf(state.info);
    const there = new Set(state.containers.map((container) => container.id));
    const keys = (await this.#storageOfEveryBackend.list(GPU_PARTS).catch(() => [] as string[])).filter((key) => !there.has(key.slice(GPU_PARTS.length)));
    const gone = await Promise.all(keys.map(async (key) => ({ key, writtenUnder: (await this.#storageOfEveryBackend.get<PartRecord>(key).catch(() => undefined))?.writtenUnder })));
    const ofThisEngine = gone.filter((record) => record.writtenUnder !== undefined && record.writtenUnder.engineId === here.engineId);
    if (!ofThisEngine.length) return;
    const reached = await (this.#context.dockerDaemonsReached?.(signal) ?? Promise.resolve(null)).catch(() => null);
    if (!reached) return;
    const listedSomewhere = new Set(reached.flatMap((daemon) => daemon.containers));
    await Promise.all(ofThisEngine.filter((record) => !listedSomewhere.has(record.key.slice(GPU_PARTS.length))).map((record) => this.#storageOfEveryBackend.delete(record.key).catch(() => undefined)));
  }

  #readCards(info: DockerInfo, signal?: AbortSignal): Promise<void> {
    this.#probing ??= (async () => {
      const at = this.#now();
      const image = this.#probeImage();
      if (!image) {
        this.#reading = { at, probed: null, unread: "no box image is on the host to read them from" };
        return;
      }
      const devices = info.allGpus ? [ALL_CARDS_DEVICE] : info.gpus;
      const result = await this.#cli
        .run(["container", "run", "--rm", "--pull", "never", "--network", "none", ...devices.flatMap((device) => ["--device", device]), image, "sh", "-c", PROBE_SCRIPT], { timeoutMs: 30_000, signal })
        .catch((error: unknown) => ({ exitCode: null, stdout: "", stderr: message(error), timedOut: false }));
      const probed = result.exitCode === 0 ? parseProbe(result.stdout) : [];
      const said = `${result.stderr}`.trim().split("\n").at(-1) || `exit code ${result.exitCode ?? "none"}`;
      this.#reading = probed.length ? { at, probed, unread: null } : { at, probed: null, unread: `nvidia-smi in a container given the cards answered ${result.exitCode === 0 ? "with no card" : said}` };
      if (probed.length) this.#lastProbed = probed;
    })().finally(() => {
      this.#probing = null;
    });
    return this.#probing;
  }

  async #cardsOn(info: DockerInfo, signal?: AbortSignal, freshMs = READING_FRESH_MS): Promise<CardsOnHost> {
    if (!info.gpus.length && !info.allGpus) return { cards: [], oneDeviceForEveryCard: false, readAt: null, unread: null };
    if (!this.#reading || this.#now() - this.#reading.at > freshMs) await this.#readCards(info, signal);
    const reading = this.#reading;
    const lastKnown = this.#lastProbed?.map((card) => ({ ...card, freeMiB: null }));
    return cardsOnHost({ devices: info.gpus, allListed: info.allGpus, probed: reading?.probed ?? lastKnown ?? null, readAt: reading?.probed ? reading.at : null, unread: reading?.unread ?? null });
  }

  #avoidedCards(): ReadonlySet<string> {
    const now = this.#now();
    for (const [card, until] of this.#avoided) if (until <= now) this.#avoided.delete(card);
    return new Set(this.#avoided.keys());
  }

  async #holders(state: HostState, cards: CardsOnHost): Promise<CardHolder[]> {
    const placing = new Map(state.placing.map((each) => [each.name, each]));
    const held = await Promise.all(
      state.containers.map(async (container): Promise<CardHolder | null> => {
        if (container.labels[LABELS.imageBox] || placing.has(container.name)) return null;
        const card = cardOfLabels(container.labels, cards.cards, LABELS.gpuCard, LABELS.gpu);
        if (!card) return null;
        const own = container.labels[LABELS.install] === this.#context.installId;
        const relabelled = own ? await this.#context.storage.get<Relabelled>(relabelKey(container.name)).catch(() => undefined) : undefined;
        return {
          card,
          part: (await this.#partOf(container)).part,
          name: relabelled?.name ?? (container.labels[LABELS.name] || container.name),
          threadId: own ? (relabelled?.threadId ?? container.labels[LABELS.thread] ?? null) : null,
          otherInstall: !own,
          state: ACTIVE.has(container.status) ? "running" : "stopped",
          container: container.name,
          needMiB: 0,
        };
      }),
    );
    const making = [...placing.values()].flatMap((each): CardHolder[] => {
      const card = each.part !== "none" ? cardKeyOf(each.card, each.gpu, cards.cards) : null;
      return card ? [{ card, part: each.part as CardPart, name: each.boxName, threadId: each.threadId, otherInstall: false, state: "making", container: each.name, needMiB: each.needMiB }] : [];
    });
    return [...held.filter((holder): holder is CardHolder => holder !== null), ...making];
  }

  async #cardPlacement(state: HostState, kind: string, part: CardPart, threadId: string | null, unplacedPerCard: number, freshMs: number, signal?: AbortSignal): Promise<CardPlacing> {
    const host = state.info.name || this.#host;
    const what = boxWhat(kind);
    const cards = await this.#cardsOn(state.info, signal, freshMs);
    if (!cards.cards.length) {
      const why = cards.unread ? `bb-box could not read its cards: ${cards.unread}` : "it lists no NVIDIA card as a CDI device";
      return { is: "refused", refusal: noCardsRefusal(host, why, what), limits: [] };
    }
    const holders = await this.#holders(state, cards);
    const lost = wholeHoldersOnNoCard(holders, cards.cards);
    if (lost.length) {
      const names = listOf(lost.map((holder) => holderName(holder, new Map(), { to: "agent", threadId: null })));
      const why = `${names} ${lost.length === 1 ? "holds" : "hold"} a card whole that bb-box cannot match to a card it reads now${cards.unread ? `, as it could not read the cards: ${cards.unread}` : ""}`;
      return {
        is: "refused",
        refusal: {
          person: `${capitalise(host)} cannot give a box a GPU now: ${why}. Run bb box doctor.`,
          agent: `Not made: ${host} cannot give a box a GPU now: ${why}. Ask for gpu none, or ask the user. bb-box changed nothing.`,
        },
        limits: [],
      };
    }
    const limits: Limit[] = cards.cards.map((card) => ({
      resource: "gpu-desktops",
      id: cards.oneDeviceForEveryCard ? cudaVisible(card.uuid) : card.device,
      used: holders.filter((holder) => holder.card === card.uuid).length + unplacedPerCard,
      total: this.#config.desktopsPerGpu,
      reserve: 0,
      unit: "count",
    }));
    const result = placeCard({ part, needMiB: neededMiB(kind), what, cards: cards.cards, holders, perCard: this.#config.desktopsPerGpu, avoided: this.#avoidedCards(), unplacedPerCard });
    if (result.is === "placed") return { is: "placed", card: result.card, limits };
    return { is: "refused", refusal: placementRefusal(host, part, what, result.blocks, await this.#titles(threadsNamed(result.blocks)), threadId), limits };
  }

  /** The daemon's facts and every bb-box container on the host. */
  async #state(signal?: AbortSignal): Promise<HostState> {
    const [info, containers] = await Promise.all([this.#cli.info(signal), this.#cli.list({ [LABELS.backend]: "docker" }, signal)]);
    this.#info = info;
    const share = this.#shareOf(info);
    return { info, containers, placing: await this.#placingOnDaemon(share, info, signal) };
  }

  async #placingOnDaemon(share: DaemonShare<Placing>, info: DockerInfo, signal?: AbortSignal): Promise<Placing[]> {
    const here = daemonKey(info, this.#daemonFallback);
    const owners = new Map<string, Promise<string | null>>();
    const ownerDaemon = (backendId: string): Promise<string | null> => {
      let read = owners.get(backendId);
      if (!read) {
        const owner = share.backends.get(backendId);
        read = owner ? owner.daemonNow(signal).catch(() => null) : Promise.resolve(null);
        owners.set(backendId, read);
      }
      return read;
    };
    const entries = [...share.placing.values()];
    const counted = await Promise.all(entries.map(async (each) => ((await ownerDaemon(each.backendId)) ?? here) === here));
    return entries.filter((_, index) => counted[index]);
  }

  async #daemonRead(signal?: AbortSignal): Promise<string> {
    return daemonKey(await this.#cli.info(signal), this.#daemonFallback);
  }

  #shareOf(info: DockerInfo): DaemonShare<Placing> {
    const daemon = engineKey(info, this.#daemonFallback);
    if (this.#share?.daemon === daemon) return this.#share;
    if (this.#share && this.#joined) leaveDaemon(this.#share, this.id);
    this.#joined = false;
    this.#share = daemonShare<Placing>(daemon);
    return this.#share;
  }

  get #daemonFallback(): string {
    return this.#config.machine ?? this.#config.host ?? "local";
  }

  #daemonNow(): string {
    return this.#info ? daemonKey(this.#info, this.#daemonFallback) : `host:${this.#daemonFallback}`;
  }

  #join(): void {
    if (!this.#share || this.#joined) return;
    joinDaemon(this.#share, this.id, { on: () => this.#context.on?.() ?? true, daemon: () => this.#daemonNow(), daemonNow: (signal) => this.#daemonRead(signal) });
    this.#joined = true;
  }

  async #shared(signal?: AbortSignal): Promise<DaemonShare<Placing>> {
    if (this.#share) return this.#share;
    const info = await this.#cli.info(signal);
    this.#info = info;
    return this.#shareOf(info);
  }

  #reserve(boxId: string, placing: Placing): void {
    const share = this.#share;
    if (!share) return;
    this.#unreserve(boxId);
    share.placing.set(boxId, placing);
    this.#reservedIn.set(boxId, share);
  }

  #unreserve(boxId: string): void {
    this.#reservedIn.get(boxId)?.placing.delete(boxId);
    this.#reservedIn.delete(boxId);
  }

  get #avoided(): Map<string, number> {
    return this.#share?.avoided ?? new Map();
  }

  #otherBackendOnDaemon(): string | null {
    if (!this.#share) return null;
    const first = backendsOn(this.#share, this.#daemonNow()).find((id) => id !== this.id && id < this.id) ?? null;
    return first;
  }

  #sharedDaemonRefusal(part: GpuPart): GpuRefusal | null {
    this.#join();
    if (part === "none") return null;
    const other = this.#otherBackendOnDaemon();
    if (other === null) return null;
    return {
      person: `${this.label} reaches the same Docker daemon as the backend ${other}, so bb-box places no GPU box through it: two backends on one daemon would each count only their own boxes on its cards. Ask for gpu none here, or remove one of them in BB Box's settings.`,
      agent: `Not made: ${this.label} reaches the same Docker daemon as another backend, so bb-box places no GPU box through it. Ask for gpu none, or for another provider, or ask the user. bb-box changed nothing.`,
    };
  }

  async dispose(): Promise<void> {
    if (this.#share && this.#joined) leaveDaemon(this.#share, this.id);
    this.#share = null;
    this.#joined = false;
  }

  /** Whether a box of `size` fits, and if not, why, with what to do. */
  #room(state: HostState, _kind: string, size: MachineSize, unplaced: Unplaced = NONE_UNPLACED): { capacity: HostCapacity; why: string | null } {
    const { info, containers } = state;
    const host = info.name || this.#host;
    const listed = new Set(containers.map((container) => container.name));
    const active = containers.filter((container) => ACTIVE.has(container.status));
    const holding = new Set(active.map((container) => container.name));
    const placing = state.placing;
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
    }
    return { capacity: { host, ok: why === null, limits }, why };
  }

  #full(kind: string, why: string): string {
    return `${this.label} cannot take this ${kind} box: ${why}.`;
  }

  async #underPlacement<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return underDaemonLock(await this.#shared(signal), work, signal);
  }

  #pinsCpus(info: DockerInfo): boolean {
    return info.cpuset && info.cpus > 0;
  }

  #cpusHeldBesides(state: HostState, name: string | null): CpuList[] {
    const running = new Set(state.containers.filter((container) => ACTIVE.has(container.status)).map((container) => container.name));
    return [
      ...state.containers.filter((container) => running.has(container.name) && container.name !== name && container.cpus).map((container) => container.cpus!),
      ...state.placing.filter((other) => !running.has(other.name) && other.name !== name && other.cpus).map((other) => other.cpus!),
    ];
  }

  #learnRefusal(error: unknown): boolean {
    const said = message(error);
    if (!CPUS_NOT_AVAILABLE.test(said)) return false;
    this.#daemonCpus = daemonCpusFromRefusal(said) ?? this.#daemonCpus;
    return true;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  async maintain(signal?: AbortSignal): Promise<void> {
    await this.#underPlacement(async () => {
      const state = await this.#state(signal);
      await this.#dropPartsOfGoneContainers(state, signal);
      if (!state.containers.some((container) => ACTIVE.has(container.status))) return;
      if (this.#hostCpus && this.#now() - this.#hostCpus.at < PROBES_REFRESHED_AFTER_MS) return;
      await this.#lxcfsOnHost(signal, true);
      if (!this.#pinsCpus(state.info)) return;
      this.#daemonCpus = null;
      await this.#probedCpus(state.info, signal, true);
      await this.#moveSharingBoxes(signal);
    }, signal);
  }

  #probeImage(): string | null {
    return DOCKER_KINDS.map((kind) => this.#config.images[kind]).find((each): each is string => Boolean(each)) ?? null;
  }

  async #lxcfsOnHost(signal?: AbortSignal, again = false): Promise<LxcfsOnHost | null> {
    if (!again && this.#lxcfs && this.#now() - this.#lxcfs.at < HOST_CPUS_KEPT_FOR_MS) return this.#lxcfs.on;
    const image = this.#probeImage();
    let on = image ? lxcfsFromProbe(await this.#cli.run(lxcfsProbeArgs(image), { timeoutMs: 30_000, signal })) : null;
    if (image && on && !on.serves) on = lxcfsFromContainerProbe(await this.#cli.run(containerLxcfsProbeArgs(image), { timeoutMs: 30_000, signal }));
    this.#lxcfs = { at: this.#now(), on };
    return on;
  }

  async #cpusOfHost(info: DockerInfo, signal?: AbortSignal, again = false): Promise<CpuList> {
    return cpusBothAllow(await this.#probedCpus(info, signal, again), this.#daemonCpus);
  }

  async #probedCpus(info: DockerInfo, signal?: AbortSignal, again = false): Promise<CpuList> {
    if (!again && this.#hostCpus && this.#now() - this.#hostCpus.at < HOST_CPUS_KEPT_FOR_MS) return this.#hostCpus.cpus;
    if (!again) this.#daemonCpus = null;
    const image = this.#probeImage();
    const probe = image
      ? await this.#cli.run(["container", "run", "--rm", "--pull", "never", "--network", "none", image, "cat", "/sys/fs/cgroup/cpuset.cpus.effective"], { timeoutMs: 30_000, signal })
      : null;
    const cpus = hostCpusFromProbe(probe?.exitCode === 0 ? probe.stdout : null, info.cpus);
    this.#hostCpus = { at: this.#now(), cpus };
    return cpus;
  }

  async #allot(state: HostState, name: string, cores: number, signal?: AbortSignal, again = false): Promise<CpuList | null> {
    const host = await this.#cpusToPinTo(state.info, cores, signal, again);
    return host ? allotCpus(host, this.#cpusHeldBesides(state, name), cores) : null;
  }

  async #cpusToPinTo(info: DockerInfo, cores: number, signal?: AbortSignal, again = false): Promise<CpuList | null> {
    if (!this.#pinsCpus(info)) return null;
    return cpusToPinTo(await this.#probedCpus(info, signal, again), this.#daemonCpus, cores);
  }

  /** Checks room and counts the box against the host, one acquire at a time. */
  #place(box: BoxIdentity, signal: AbortSignal): Promise<PlacedBox> {
    return this.#underPlacement(async () => {
      this.#unreserve(box.boxId);
      const state = await this.#state(signal);
      const room = this.#room(state, box.kind, box.size);
      if (room.why !== null) throw new BackendError("no_capacity", this.#full(box.kind, room.why));
      const part = this.#gpuAsked(box.kind, box.size.gpu);
      const shared = this.#sharedDaemonRefusal(part);
      if (shared) throw new BackendError("no_capacity", shared.person, shared.agent);
      const refusedPart = this.#partRefusal(box.kind, part);
      if (refusedPart) throw new BackendError("unsupported", refusedPart.person, refusedPart.agent);
      let card: DockerCard | null = null;
      if (part !== "none") {
        const placed = await this.#cardPlacement(state, box.kind, part, box.threadId, 0, READING_FRESH_MS, signal);
        if (placed.is === "refused") throw new BackendError("no_capacity", placed.refusal.person, placed.refusal.agent);
        card = placed.card;
      }
      const name = containerName(box.boxId);
      const cpus = await this.#allot(state, name, box.size.cores, signal);
      this.#reserve(box.boxId, this.#placingOf(box, card?.device ?? null, card?.uuid ?? null, part, cpus));
      return { host: room.capacity.host, gpu: card?.device ?? null, card, part, cpus };
    }, signal);
  }

  #placingOf(box: BoxIdentity, gpu: string | null, card: string | null, part: GpuPart, cpus: CpuList | null): Placing {
    return { backendId: this.id, name: containerName(box.boxId), memoryMiB: box.size.memoryMiB, gpu, cpus, card, part: card ? part : "none", needMiB: card ? neededMiB(box.kind) : 0, boxName: box.name, threadId: box.threadId };
  }

  #resumePlacement(box: BoxIdentity, gpu: string | null, card: string | null, part: GpuPart, signal: AbortSignal, again = false): Promise<CpuList | null> {
    return this.#underPlacement(async () => {
      const name = containerName(box.boxId);
      const cpus = await this.#allot(await this.#state(signal), name, box.size.cores, signal, again);
      this.#reserve(box.boxId, this.#placingOf(box, gpu, card, part, cpus));
      if (again) await this.#moveSharingBoxes(signal).catch((error) => this.#context.logError("moving boxes onto the host's CPUs as they are now", error));
      return cpus;
    }, signal);
  }

  async #moveSharingBoxes(signal?: AbortSignal): Promise<void> {
    const state = await this.#state(signal);
    if (!this.#pinsCpus(state.info)) return;
    const running = state.containers.filter((container) => ACTIVE.has(container.status) && container.cpus);
    const runningNames = new Set(state.containers.filter((container) => ACTIVE.has(container.status)).map((container) => container.name));
    const mine = running.filter((container) => container.labels[LABELS.install] === this.#context.installId);
    const held = [
      ...running.filter((container) => !mine.includes(container)).map((container) => container.cpus!),
      ...state.placing.filter((other) => !runningNames.has(other.name) && other.cpus).map((other) => other.cpus!),
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
    let made: MadeGpu;
    let placedCard: DockerCard | null = null;
    let cpus: CpuList | null;
    if (resumed) {
      host = previous.host ?? this.#host;
      made = madeOf(previous);
      cpus = await this.#resumePlacement(box, made.gpu, made.card ?? made.gpu, made.part, signal);
    } else {
      const placed = await step("place", () => this.#place(box, signal));
      host = placed.host;
      cpus = placed.cpus;
      placedCard = placed.card;
      made = madeOnCard(placed.card, placed.part);
    }
    const guest = (address: string | null, size: MachineSize | null = null): Guest => ({
      ref: name,
      host,
      address,
      size,
      data: { box: box.boxId, ...(made.gpu ? { gpu: made.gpu, part: made.part } : {}), ...(made.card ? { card: made.card } : {}) },
    });
    const missed: WrongCard[] = [];
    try {
      await hooks.claim(guest(null));
      await step("network", () => this.#network(signal));
      for (;;) {
        made = await step("create", async () => {
          let lxcfs = await this.#lxcfsOnHost(signal);
          try {
            return await this.#create(box, image, made, cpus, lxcfs, signal);
          } catch (error) {
            if (cpus && this.#learnRefusal(error)) cpus = await this.#resumePlacement(box, made.gpu, made.card ?? made.gpu, made.part, signal, true);
            else if (lxcfs?.serves && /lxcfs/i.test(message(error))) lxcfs = await this.#lxcfsOnHost(signal, true);
            else throw error;
            return this.#create(box, image, made, cpus, lxcfs, signal);
          }
        });
        if (!missed.length) await hooks.starting();
        await step("start", () => this.#cli.ok(["container", "start", name], { timeoutMs: 120_000, signal }));
        await step("ready", () => this.#ready(name, deadline, signal));
        const [container] = await this.#cli.inspect([name], signal);
        if (!container) throw new Error(`The container ${name} went from ${host} as it started.`);
        const checked = await this.#cardFacts(box, container, made, placedCard, step, signal);
        if (checked.is === "facts") {
          const ready: Guest = {
            ...guest(this.#address(container), sizeOf(container)),
            ...(checked.facts.length ? { facts: checked.facts } : {}),
            ...(made.card && made.part !== "none" ? { claim: claimOf(made.card, made.part, 1) } : {}),
          };
          // Claimed again, so the box's record has the address and size as it becomes ready.
          await hooks.claim(ready);
          return ready;
        }
        missed.push(checked);
        await this.#remove(name, box.boxId);
        this.#avoided.set(checked.card, this.#now() + AVOID_CARD_MS);
        if (missed.length > 1) throw this.#missedCards(box, host, missed, null);
        const again = await step("place", () => this.#place(box, signal)).catch((error: unknown) => {
          throw error instanceof BackendError && error.code === "no_capacity" ? this.#missedCards(box, host, missed, { person: error.message, agent: error.agentMessage ?? error.message }) : error;
        });
        cpus = again.cpus;
        placedCard = again.card;
        made = madeOnCard(again.card, again.part);
        await hooks.claim(guest(null));
      }
    } catch (error) {
      // Only a container with this box's labels goes, so one of another box's is left alone.
      await this.#remove(name, box.boxId).catch((cause) => this.#context.logError("release after a failed acquire", cause));
      throw error;
    } finally {
      this.#unreserve(box.boxId);
    }
  }

  async #cardFacts(box: BoxIdentity, container: ContainerInfo, made: MadeGpu, placed: DockerCard | null, step: Step, signal: AbortSignal): Promise<CheckedFacts> {
    const reach = this.#reachFacts(box.kind, made.gpu !== null);
    if (!made.gpu || made.part === "none") return { is: "facts", facts: reach };
    const part = made.part;
    const card = made.card;
    if (!card) return { is: "facts", facts: [{ label: GPU_FACT, value: factWords(part, placed, null) }, ...(placed ? [{ label: GPU_CHECK_FACT, value: seeItWords(placed) }] : []), ...reach] };
    await step("gpu", () => this.#writeEnvironment(container.name, card, signal));
    const check = await step("card check", () => this.#checkCard(container.name, card, signal));
    const known = placed ?? (await this.#knownCard(card, signal));
    if (!check.ok && wrongCard(check, card)) return { is: "wrong", card, named: cardName(known ?? { index: null, uuid: card }), why: check.why };
    const seen = known ?? { uuid: card, uuidKnown: true, index: null };
    return { is: "facts", facts: [{ label: GPU_FACT, value: factWords(part, known, check) }, { label: GPU_CHECK_FACT, value: seeItWords(seen) }, ...reach] };
  }

  #missedCards(box: BoxIdentity, host: string, missed: readonly WrongCard[], refusal: GpuRefusal | null): BackendError {
    const said = missed.map((wrong, at) => `${at ? "then " : ""}${wrong.named}: ${wrong.why}`).join("; ");
    const cards = listOf(missed.map((wrong) => wrong.named));
    const person = `${box.name} did not get its card on ${host}: ${said}. bb-box removed what it made, and new boxes leave ${cards} out for 10 minutes.${refusal ? ` No other card could take it: ${refusal.person}` : " Run bb box doctor."}`;
    const agentRefusal = refusal?.agent.replace(/^Not made: /, "").replace(/ bb-box changed nothing\.$/, "");
    const agent = `Not made: ${box.name} did not get its card: ${said}. bb-box removed what it made.${agentRefusal ? ` No other card could take it: ${agentRefusal}` : " Ask the user."}`;
    return new BackendError("no_capacity", person, agent);
  }

  #reachFacts(kind: string, hasCard: boolean): GuestFact[] {
    const words = this.cardReach(kind, hasCard);
    return words ? [{ label: CARDS_FACT, value: words }] : [];
  }

  cardReach(kind: string, hasCard = false): string | null {
    const info = this.#info;
    if (!info || !hostListsCards(info) || !this.kinds().some((offer) => offer.id === kind)) return null;
    return reachWords(info.name || this.#host, this.#privileged(kind), oneDeviceForEveryCardOf(info) && hasCard);
  }

  async #knownCard(card: string, signal?: AbortSignal): Promise<DockerCard | null> {
    if (!this.#info) return null;
    const cards = await this.#cardsOn(this.#info, signal, READING_KEPT_MS).catch(() => null);
    return cards?.cards.find((each) => each.uuid === card) ?? null;
  }

  async #writeEnvironment(ref: string, card: string, signal?: AbortSignal): Promise<void> {
    const result = await this.#cli.run(["exec", "--user", "0", ref, "/bin/sh", "-c", environmentScript(card)], { timeoutMs: 30_000, signal });
    if (result.exitCode !== 0) throw new Error(`bb-box could not point CUDA at ${cudaVisible(card)} in /etc/environment of ${ref}: ${result.stderr.trim() || `exit code ${result.exitCode}`}.`);
  }

  async #checkCard(ref: string, card: string, signal?: AbortSignal): Promise<CardCheck> {
    const command = new DockerTransport(this.#cli, ref);
    const once = async () => {
      const result = await command.run(DOCKER_CARD_CHECK, { timeoutMs: 30_000, signal, maxOutputBytes: 16 * 1024 }).catch((error: unknown) => ({ exitCode: null, stdout: "", stderr: message(error), timedOut: false }));
      return judgeDockerCardCheck(`${result.stdout}\n${result.stderr}`, card);
    };
    const first = await once();
    return !first.ok && first.reading === "incomplete" ? once() : first;
  }

  async release(guest: Guest, hooks: ReleaseHooks, signal?: AbortSignal): Promise<void> {
    const started = performance.now();
    this.#selkies.forget(guest.ref);
    this.#cursor.forget(guest.ref);
    const removed = await this.#remove(guest.ref, this.#boxOf(guest), signal);
    await this.#context.storage.delete(relabelKey(guest.ref));
    if (removed) await this.#storageOfEveryBackend.delete(GPU_PART_KEY(removed));
    await this.#underPlacement(() => this.#moveSharingBoxes(signal), signal).catch((error) => this.#context.logError("moving boxes onto CPUs a release freed", error));
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

  async start(guest: Guest, signal?: AbortSignal): Promise<Started | void> {
    const deadline = Date.now() + (this.#options.readyTimeoutMs ?? READY_TIMEOUT_MS);
    const found = await this.#owned(guest.ref, this.#boxOf(guest), signal);
    if (!found) throw this.#gone(guest);
    await this.#cli.ok(["container", "start", found.id], { timeoutMs: 120_000, signal });
    await this.#ready(found.id, deadline, signal);
    const held = typeof guest.data?.card === "string" ? guestCard(guest) : null;
    if (!held) return;
    const stored = await this.#partOf(found);
    const check = await this.#checkCard(found.name, held.card, signal);
    const known = await this.#knownCard(held.card, signal);
    const kept = withoutGpuFacts(guest.facts);
    const reach = (guest.facts ?? []).filter((fact) => fact.label === CARDS_FACT);
    return {
      facts: [{ label: GPU_FACT, value: factWords(stored.part, known, check) }, { label: GPU_CHECK_FACT, value: seeItWords({ uuid: held.card, uuidKnown: true, index: null }) }, ...reach, ...kept],
      claim: claimOf(held.card, stored.part, stored.generation),
    };
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
    if (!this.kinds().some((offer) => offer.id === kind)) return null;
    return { cores: "live", memory: "live", disk: "no", shrinks: true, ...(this.#gpuParts(kind) ? { gpu: { add: "no", share: "live", move: "no" } } : {}) };
  }

  async planResize(guest: Guest, kind: string, to: ResizeTarget, pending: readonly Pending[], signal?: AbortSignal): Promise<ResizePlan> {
    this.#kind(kind);
    const found = await this.#owned(guest.ref, this.#boxOf(guest), signal);
    if (!found) throw this.#gone(guest);
    const from = sizeOf(found) ?? guest.size;
    if (!from) throw new Error(`Container ${found.name} has no CPU or memory limit, so bb-box cannot resize it.`);
    const parts: ResizePlan["parts"][number][] = [];
    if (to.cores !== from.cores) parts.push({ part: "cores", from: from.cores, to: to.cores, way: "live" });
    if (to.memoryMiB !== from.memoryMiB) parts.push({ part: "memory", from: from.memoryMiB, to: to.memoryMiB, way: "live" });
    if (to.diskGiB !== null) parts.push({ part: "disk", from: null, to: to.diskGiB, way: "no" });
    const gpu = to.gpu === undefined ? null : await this.#planGpu(await this.#state(signal), found, kind, to.gpu, signal);
    return { parts, room: await this.#resizeRoom(from, to, pending, signal), downSeconds: null, ...(gpu ? { gpu } : {}) };
  }

  async #planGpu(state: HostState, found: ContainerInfo, kind: string, to: GpuPart, signal?: AbortSignal): Promise<GpuResize | null> {
    const cards = await this.#cardsOn(state.info, signal, READING_FRESH_MS);
    const card = found.labels[LABELS.gpu] ? cardOfLabels(found.labels, cards.cards, LABELS.gpuCard, LABELS.gpu) : null;
    const stored = card ? await this.#partOf(found) : null;
    const from: GpuPart = stored?.part ?? "none";
    if (from === to) return null;
    const host = state.info.name || this.#host;
    const relabelled = await this.#context.storage.get<Relabelled>(relabelKey(found.name)).catch(() => undefined);
    const name = relabelled?.name ?? (found.labels[LABELS.name] || found.name);
    const known = card ? (cards.cards.find((each) => each.uuid === card) ?? null) : null;
    const placement = known ? placementOf(known) : null;
    const named = card ? cardName(known ?? { index: null, uuid: card }) : null;
    if (from === "none" || to === "none") {
      const change = from === "none" ? `gain a card` : `lose ${named}`;
      const words = `GPU: ${from} → ${to} · Cannot change on Docker. A container's devices are fixed when it is made, so ${name} cannot ${change}. Make a new box with the GPU it needs.`;
      const refusal: GpuRefusal = {
        person: `${capitalise(name)} cannot ${change} on Docker: a container's devices are fixed when it is made. Make a new box with the GPU it needs.`,
        agent: `Not resized: ${name} cannot ${change} on Docker: a container's devices are fixed when it is made. Acquire a new box with the GPU it needs, or ask the user. bb-box changed nothing.`,
      };
      return { from, to, way: "no", card: placement, others: [], words, refusal };
    }
    if (to === "whole" && !this.#wholeOn()) return { from, to, way: "no", card: placement, others: [], words: WHOLE_CARDS_OFF_FOR_RESIZE.person, refusal: WHOLE_CARDS_OFF_FOR_RESIZE };
    const shared = this.#sharedDaemonRefusal(to);
    if (shared) {
      const refusal = { person: shared.person, agent: shared.agent.replace(/^Not made: /, "Not resized: ") };
      return { from, to, way: "live", card: placement, others: [], words: refusal.person, refusal };
    }
    if (to === "whole" && known && !known.uuidKnown) {
      const refusal: GpuRefusal = {
        person: `No card is free for ${name} alone: bb-box could not read ${named}, so it cannot tell what uses it. Keep the GPU shared, or run bb box doctor.`,
        agent: `Not resized: no card is free for ${name} alone: bb-box could not read ${named}. Keep the GPU shared, or ask the user. bb-box changed nothing.`,
      };
      return { from, to, way: "live", card: placement, others: [], words: refusal.person, refusal };
    }
    const reach = reachWords(host, this.#privileged(kind), cards.oneDeviceForEveryCard);
    const tail = reach ? ` ${reach}` : "";
    if (to === "shared") {
      const words = `GPU: whole ${named} → shared · Live. ${capitalise(named!)} opens to other boxes, up to ${this.#config.desktopsPerGpu}. They share its memory and its time. Nothing in ${name} stops.${tail}`;
      return { from, to, way: "live", card: placement, others: [], words, refusal: null };
    }
    const holders = (await this.#holders(state, cards)).filter((holder) => holder.card === card && holder.container !== found.name);
    const others = holders.map((holder) => ({ name: holder.name, stopped: holder.state === "stopped" }));
    if (holders.length) {
      const titles = await this.#titles([...new Set(holders.flatMap((holder) => (holder.threadId ? [holder.threadId] : [])))]);
      const list = (audience: "person" | "agent") => holders.map((holder) => `${holderName(holder, titles, audience === "person" ? { to: "person" } : { to: "agent", threadId: null })}${holder.state === "stopped" ? " (stopped)" : holder.state === "making" ? " (being made)" : ""}`);
      const on = (audience: "person" | "agent") => `${capitalise(named!)} has ${listOf(list(audience))} on it, and on Docker a box cannot move to another card`;
      const refusal: GpuRefusal = {
        person: `No card is free for ${name} alone. ${on("person")}. Release ${holders.length === 1 ? "it" : "one of them"}, or keep the GPU shared.`,
        agent: `Not resized: no card is free for ${name} alone. ${on("agent")}. Keep the GPU shared, or ask the user. bb-box changed nothing.`,
      };
      return { from, to, way: "live", card: placement, others, words: refusal.person, refusal };
    }
    const words = `GPU: shared → whole ${named} · Live. ${capitalise(named!)} becomes ${name}'s alone: no other box is placed on it while ${name} holds it. Nothing in ${name} stops.${tail}`;
    return { from, to, way: "live", card: placement, others: [], words, refusal: null };
  }

  /** Changes a container's CPUs and memory, swap with it, as `docker update` does at once, running or stopped (061). */
  async resize(guest: Guest, kind: string, to: ResizeTarget, _options: { readonly restart: boolean }, signal?: AbortSignal): Promise<Guest> {
    if (to.diskGiB !== null) throw new BackendError("unsupported", "A Docker box shares its host's disk, so it has no disk of its own to grow.");
    return this.#underPlacement(async () => {
      const found = await this.#owned(guest.ref, this.#boxOf(guest), signal);
      if (!found) throw this.#gone(guest);
      const from = sizeOf(found);
      const state = await this.#state(signal);
      const gpu = to.gpu === undefined ? null : await this.#planGpu(state, found, kind, to.gpu, signal);
      if (gpu?.refusal) throw new BackendError(gpu.way === "no" ? "unsupported" : "no_capacity", gpu.refusal.person, gpu.refusal.agent);
      if (gpu && gpu.way !== "live") throw new BackendError("unsupported", gpu.words);
      const pinTo = async (again: boolean) => {
        const host = await this.#cpusToPinTo(state.info, to.cores, signal, again);
        return host ? resizeCpus(host, this.#cpusHeldBesides(state, found.name), found.cpus ?? [], to.cores) : null;
      };
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
      const resized: Guest = { ...guest, size: (now && sizeOf(now)) ?? machineSize(to) };
      return gpu ? this.#switchShare(resized, found, gpu, signal) : resized;
    }, signal);
  }

  async #switchShare(guest: Guest, found: ContainerInfo, change: GpuResize, signal?: AbortSignal): Promise<Guest> {
    const held = guestCard(guest);
    const card = change.card?.card ?? held?.card ?? found.labels[LABELS.gpuCard] ?? null;
    if (!card || change.to === "none") return guest;
    const part = change.to;
    const generation = (await this.#partOf(found)).generation + 1;
    const claimed = cardOfUuid(card);
    await this.#storageOfEveryBackend.set(GPU_PART_KEY(found.id), { part, generation, writtenUnder: await this.#writtenUnder(signal) } satisfies PartRecord);
    const known = await this.#knownCard(card, signal);
    const facts = guest.facts?.some((fact) => fact.label === GPU_FACT)
      ? guest.facts.map((fact) => (fact.label === GPU_FACT ? { ...fact, value: factWords(part, known, null) } : fact))
      : [{ label: GPU_FACT, value: factWords(part, known, null) }, { label: GPU_CHECK_FACT, value: seeItWords({ uuid: card, uuidKnown: true, index: null }) }, ...(guest.facts ?? [])];
    return { ...guest, data: { ...guest.data, ...(claimed ? { card } : {}), part }, facts, ...(claimed ? { claim: claimOf(card, part, generation) } : {}) };
  }

  /** Room on the host for a container to grow from `from` to `to`: the memory it adds, kept within the reserve, and cores within the host's (061). */
  async #resizeRoom(from: MachineSize, to: MachineSize, pending: readonly Pending[], signal?: AbortSignal): Promise<Capacity> {
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

  async gpuRoom(kind: string): Promise<GpuRoom> {
    const offered = this.#gpuParts(kind);
    if (!offered) return { readings: [], fullUntil: null };
    let state: HostState;
    try {
      state = await this.#state();
    } catch (error) {
      return { readings: [], fullUntil: null, parts: kind === "linux" ? ["none"] : [], withheld: `${this.#host} did not answer: ${message(error)}` };
    }
    const host = state.info.name || this.#host;
    const cards = await this.#cardsOn(state.info, undefined, READING_KEPT_MS);
    if (!cards.cards.length) {
      const why = cards.unread ? `bb-box could not read its cards: ${cards.unread}` : "it lists no NVIDIA card as a CDI device";
      return { readings: [], fullUntil: null, parts: kind === "linux" ? ["none"] : [], withheld: `${host}: ${why}` };
    }
    const holders = await this.#holders(state, cards);
    const whole = offered.includes("whole");
    const ask = { needMiB: neededMiB(kind), what: boxWhat(kind), cards: cards.cards, holders, perCard: this.#config.desktopsPerGpu, avoided: this.#avoidedCards() } as const;
    const freeForWhole = (card: DockerCard) => whole && placeCard({ ...ask, part: "whole", only: card.uuid }).is === "placed";
    return {
      readings: [],
      fullUntil: null,
      parts: offered,
      withheld: null,
      cards: cardRooms({ cards: cards.cards, holders, freeForWhole }),
      host,
      limit: this.#config.desktopsPerGpu,
      at: cards.readAt,
      neededMiB: neededMiB(kind),
      wholeOff: !this.#wholeOn(),
      reach: reachWords(host, this.#privileged(kind), cards.oneDeviceForEveryCard),
    };
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
    this.#shareOf(info);
    return Promise.all(
      // An image box (049) is no box's: its build removes it.
      containers.filter((container) => !container.labels[LABELS.imageBox]).map(async (container) => {
        const owner = ownerOf(container.labels);
        const relabelled = owner ? await this.#context.storage.get<Relabelled>(relabelKey(container.name)) : undefined;
        const card = container.labels[LABELS.gpu] ? (container.labels[LABELS.gpuCard] ?? null) : null;
        const part = container.labels[LABELS.gpu] ? await this.#partOf(container) : null;
        return {
          ref: container.name,
          host: info.name || this.#host,
          address: this.#address(container),
          size: sizeOf(container),
          data: dataOf(container, card, part?.part ?? "none"),
          ...(card && part ? { claim: claimOf(card, part.part, part.generation) } : {}),
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
        this.#config.host?.startsWith("wsl://")
          ? `Check that wsl.exe can start ${hostWords(this.#config.host)} and that docker system dial-stdio there reaches Docker.`
          : "Install the docker CLI on BB's server, on the PATH of the user BB runs as.",
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
            : this.#config.host.startsWith("wsl://")
              ? `Check that wsl.exe can start ${hostWords(this.#config.host)} and that docker system dial-stdio there reaches Docker.`
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
      await this.#attached(push, signal);

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
              `Docker on ${info.name} keeps the CPUs it had when it started (${formatCpuList(daemon)}), but its containers may now have ${formatCpuList(probed)}, as when Proxmox moves an LXC container's CPUs. A box is pinned to CPUs in both (${formatCpuList(cpusBothAllow(probed, daemon))}) when there are as many as its cores. One with more cores is not pinned, so it keeps all its cores' time, and gets OMP_NUM_THREADS set to its cores, which nproc follows.`,
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
      await this.#checkLxcfs(info, state.containers, push, signal);
      await this.#checkAppArmor(info, push, signal);

      // What images are judged by (049).
      const judging = Promise.all([
        this.#context.images?.pins("linux") ?? null,
        this.#context.images?.pins("linux-desktop") ?? null,
        this.#context.images?.bbApp(signal) ?? null,
        this.#context.images?.chrome?.("x86_64") ?? null,
        this.#context.images?.chrome?.("arm64") ?? null,
      ]).catch(() => [null, null, null, null, null] as const);
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
          const [linuxPins, desktopPins, app, chromeAmd, chromeArm] = await judging;
          const judged = judgeImage(
            record,
            { os: "linux", pins: serves.includes("linux") ? linuxPins : desktopPins, bbApp: app, pinChrome: record?.arch === "arm64" ? chromeArm : chromeAmd },
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

      this.#checkOneBackend(push);
      if (this.#config.gpus) await this.#checkCards(state, push, signal);

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

  #checkOneBackend(push: (id: CheckId, name: string, status: DoctorCheck["status"], detail: string, fix?: string | null) => void): void {
    const sharing = this.#share ? backendsOn(this.#share, this.#daemonNow()).filter((id) => id !== this.id) : [];
    if (!sharing.length) return;
    const refused = this.#otherBackendOnDaemon();
    const fix = "Remove the other backend in BB Box's settings, or point it at another Docker host.";
    if (refused) {
      push("docker.one-backend", "One backend for this daemon", "warn", `${this.label} reaches the same Docker daemon as the backend ${refused}, so bb-box places no GPU box through it, as two backends on one daemon would each count only their own boxes on its cards. Boxes with no GPU are made as usual.`, fix);
      return;
    }
    push("docker.one-backend", "One backend for this daemon", "warn", `The ${sharing.length === 1 ? "backend" : "backends"} ${listOf(sharing)} ${sharing.length === 1 ? "reaches" : "reach"} the same Docker daemon as this one, so bb-box places GPU boxes there through this one alone.`, fix);
  }

  async #checkCards(state: HostState, push: (id: CheckId, name: string, status: DoctorCheck["status"], detail: string, fix?: string | null) => void, signal?: AbortSignal): Promise<void> {
    const { info } = state;
    const fix = "Install the NVIDIA Container Toolkit and generate its CDI spec (setup/docker/README.md), or turn off GPU boxes.";
    const cards = await this.#cardsOn(info, signal, 0);
    if (!cards.cards.length) {
      const why = cards.unread ? `lists cards as CDI devices, but bb-box could not read them: ${cards.unread}` : "lists no NVIDIA card as a CDI device";
      push("docker.gpus", "GPUs", "fail", `${info.name} ${why}, so no box there can have a GPU.`, fix);
      return;
    }
    const holders = await this.#holders(state, cards);
    const listed = cards.cards.map((card) => `${cardName(card)}${card.model ? `, ${card.model}` : ""}${card.totalMiB !== null ? `, ${Math.round(card.totalMiB / 1024)} GiB` : ""}${card.freeMiB !== null ? `, ${card.freeMiB} MiB free when read` : ""}`).join("; ");
    const one = cards.oneDeviceForEveryCard ? ` Docker gives them as one device, ${ALL_CARDS_DEVICE}, as in WSL.` : "";
    const reach = reachWords(info.name, this.#config.docker && !info.rootless, cards.oneDeviceForEveryCard);
    const unread = cards.unread ? ` bb-box could not read them just now (${cards.unread}), so it names them as last read and their free memory is not known: no box gets a whole card until it can read them.` : "";
    const facts = `${cards.cards.length} NVIDIA card${cards.cards.length === 1 ? "" : "s"} as CDI devices (${listed}), up to ${this.#config.desktopsPerGpu} boxes each.${one}${reach ? ` ${reach}` : ""}${unread}`;
    const others = holders.filter((holder) => holder.otherInstall);
    const lost = wholeHoldersOnNoCard(holders, cards.cards);
    const lostNames = listOf(lost.map((holder) => holderName(holder, new Map(), { to: "agent", threadId: null })));
    const fixes = [
      lost.length ? `Release ${lostNames}, or give ${info.name} ${lost.length === 1 ? "its card" : "their cards"} back.` : null,
      others.length ? "Give each install its own Docker host for GPU boxes, or switch none of them between shared and whole." : null,
      unread ? `Check that nvidia-smi answers in a container given the cards on ${info.name}: docker run --rm --device ${info.allGpus ? ALL_CARDS_DEVICE : (info.gpus[0] ?? ALL_CARDS_DEVICE)} <a box image> nvidia-smi -L.` : null,
    ].filter((fix): fix is string => fix !== null);
    if (fixes.length) {
      const otherWords = others.length ? ` Another install's GPU boxes are on ${info.name}: ${listOf(others.map((holder) => holder.name))}. bb-box counts them on their cards, but sees the GPU part they were made with, not a later switch, and they see this install's boxes the same way.` : "";
      const lostWords = lost.length ? ` ${lostNames} ${lost.length === 1 ? "holds" : "hold"} a card whole that bb-box cannot match to a card it reads now, so it places no GPU box on ${info.name} until it can.` : "";
      push("docker.gpus", "GPUs", lost.length ? "fail" : "warn", `${facts}${otherWords}${lostWords}`, fixes.join(" "));
    } else {
      push("docker.gpus", "GPUs", "ok", facts);
    }
    for (const audit of auditCards(cards.cards, holders, this.#config.desktopsPerGpu)) {
      const card = audit.card;
      const named = (list: readonly CardHolder[]) => listOf(list.map((holder) => holderName(holder, new Map(), { to: "agent", threadId: null })));
      const label = card.index === null ? cudaVisible(card.uuid) : String(card.index);
      if (audit.whole.length) {
        const clean = audit.whole.length === 1 && !audit.others.length;
        push(
          `gpu.${card.uuid}.whole`,
          `GPU ${label} whole`,
          clean ? "ok" : "fail",
          clean ? `${capitalise(cardName(card))} is ${named(audit.whole)}'s whole card, with no other box on it.` : `${capitalise(cardName(card))} is held whole by ${named(audit.whole)}, and ${named(audit.holders.filter((holder) => !audit.whole.includes(holder) || audit.whole.length > 1))} ${audit.holders.length - 1 === 1 ? "is" : "are"} on it too: a placement went wrong.`,
          clean ? null : "Release the boxes that should not be on the card, or switch the whole box to shared.",
        );
      }
      if (audit.over) {
        push(
          `gpu.${card.uuid}.limit`,
          `GPU ${label} boxes`,
          "warn",
          `${capitalise(cardName(card))} has ${audit.holders.length} boxes, ${audit.over} over the limit of ${this.#config.desktopsPerGpu}: ${named(audit.holders)}. They keep running; no new box goes on ${cardName(card)} until it has room.`,
          "Release boxes on the card, or raise the boxes per card in bb-box's Docker settings.",
        );
      }
    }
  }

  // The host's side.

  async #checkAppArmor(info: DockerInfo, push: (id: CheckId, name: string, status: DoctorCheck["status"], detail: string, fix?: string | null) => void, signal?: AbortSignal): Promise<void> {
    const name = "Programs in boxes under the host's AppArmor";
    if (!info.apparmor) {
      push("docker.apparmor", name, "ok", `${info.name} runs no AppArmor, so no profile of its own confines programs in boxes.`);
      return;
    }
    const image = this.#probeImage();
    if (!image) {
      push("docker.apparmor", name, "skipped", "Skipped until a box image is on the host, as bb-box tries a setgid program in a container of it.");
      return;
    }
    const probe = await this.#cli.run(
      ["container", "run", "--rm", "--pull", "never", "--network", "none", ...(this.#config.docker ? ["--privileged"] : []), image, ...SETGID_PROBE],
      { timeoutMs: 30_000, signal },
    );
    if (!refusedByAppArmor(probe)) {
      push("docker.apparmor", name, "ok", `Setgid programs in boxes on ${info.name}, as sudo runs, work under its AppArmor profiles.`);
      return;
    }
    push(
      "docker.apparmor",
      name,
      "warn",
      `${info.name} is itself a container, and its own AppArmor profile for unix_chkpwd cannot see into boxes, so sudo fails in them with "account validation failure", and unix_chkpwd with "cannot apply additional memory protection after relocation".`,
      `On ${info.name}, as root, disable that profile: ln -s /etc/apparmor.d/unix-chkpwd /etc/apparmor.d/disable/ && apparmor_parser -R /etc/apparmor.d/unix-chkpwd. Both last across a reboot. This only drops AppArmor's confinement of unix_chkpwd on ${info.name}; boxes need not be made again.`,
    );
  }

  async #checkLxcfs(
    info: DockerInfo,
    containers: readonly ContainerInfo[],
    push: (id: CheckId, name: string, status: DoctorCheck["status"], detail: string, fix?: string | null) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const name = "Memory and CPUs a box sees";
    const lxcfs = await this.#lxcfsOnHost(signal, true);
    if (lxcfs === null) {
      push("docker.lxcfs", name, "skipped", "Skipped until a box image is on the host, as bb-box looks for LXCFS from a container of it.");
      return;
    }
    if (!lxcfs.serves) {
      const desktop = /Docker Desktop/i.test(info.operatingSystem);
      push(
        "docker.lxcfs",
        name,
        "warn",
        `${info.name} has no LXCFS, so in a box free, /proc/meminfo and /proc/cpuinfo say the host's memory and CPUs, though the box's limits hold.` +
          (desktop ? " Docker Desktop's VM cannot have LXCFS." : ""),
        desktop
          ? null
          : `Install LXCFS on ${info.name}, as root: apt install lxcfs, or the distribution's package, then systemctl enable --now lxcfs. Boxes made after see their own memory and CPUs; boxes made before keep the host's until they are made again. Reload LXCFS (systemctl reload lxcfs) rather than restart it, as a restart breaks the files of the boxes running. If ${info.name} is itself a container, LXCFS cannot run in it: it runs on the machine that runs the container, as Proxmox VE's does for its LXC containers, and bb-box then uses the files it gives the container.`,
      );
      return;
    }
    const where = lxcfs.via === "host" ? `LXCFS on ${info.name}` : `the LXCFS of the machine that runs ${info.name}'s own container`;
    const mine = containers.filter((container) => container.lxcfs && ACTIVE.has(container.status) && container.labels[LABELS.install] === this.#context.installId);
    const broken = (
      await Promise.all(
        mine.map(async (container) => {
          const read = await this.#cli.run(["exec", container.id, "head", "-c", "1", "/proc/meminfo"], { timeoutMs: 10_000, signal }).catch(() => null);
          return read && read.exitCode !== 0 && /Transport endpoint is not connected/i.test(read.stderr) ? container.labels[LABELS.name] || container.name : null;
        }),
      )
    ).filter((each): each is string => each !== null);
    if (broken.length) {
      push(
        "docker.lxcfs",
        name,
        "warn",
        `${where.charAt(0).toUpperCase()}${where.slice(1)} was restarted under running boxes, so in ${broken.join(", ")} free, /proc/meminfo and /proc/cpuinfo fail with "Transport endpoint is not connected".`,
        `Stop and start each of them, from the panel or with box_stop and box_start, to see its memory again. Reload LXCFS (systemctl reload lxcfs) rather than restart it.`,
      );
      return;
    }
    push("docker.lxcfs", name, "ok", `Boxes on ${info.name} see their own memory and CPUs through ${where}, in free, /proc/meminfo and /proc/cpuinfo.`);
  }

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
  async #remove(ref: string, boxId: string | null, signal?: AbortSignal): Promise<string | null> {
    const found = await this.#owned(ref, boxId, signal);
    if (!found) return null;
    const result = await this.#cli.run(["container", "rm", "--force", "--volumes", found.id], { timeoutMs: 120_000, signal });
    if (result.exitCode !== 0 && !NO_SUCH.test(result.stderr) && !/already in progress/i.test(result.stderr)) {
      throw this.#cli.error("docker container rm", result);
    }
    return found.id;
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
  async #create(box: BoxIdentity, image: string, made: MadeGpu, cpus: CpuList | null, lxcfs: LxcfsOnHost | null, signal: AbortSignal): Promise<MadeGpu> {
    const name = containerName(box.boxId);
    const { cores, memoryMiB } = box.size;
    const { gpu, card, part } = made;
    const labels: Record<string, string> = {
      [LABELS.backend]: "docker",
      [LABELS.install]: this.#context.installId,
      [LABELS.box]: box.boxId,
      [LABELS.thread]: box.threadId,
      [LABELS.name]: box.name,
      [LABELS.kind]: box.kind,
      [LABELS.created]: String(box.createdAt),
      ...(gpu ? { [LABELS.gpu]: gpu } : {}),
      ...(gpu && card ? { [LABELS.gpuCard]: card, [LABELS.gpuPart]: part } : {}),
    };
    if (box.kind === "linux-desktop" && gpu) await this.#readGpuBusId(signal);
    const privileged = this.#privileged(box.kind);
    const desktopGpuId = gpu && gpu !== ALL_CARDS_DEVICE ? gpu.slice(gpu.indexOf("=") + 1) : card ? cudaVisible(card) : null;
    const seesEveryCard = privileged || gpu === ALL_CARDS_DEVICE;
    const extra = [
      // Docker's own data on a volume, since overlayfs cannot hold overlayfs.
      ...(privileged ? ["--privileged", "--env", "BBBOX_DOCKERD=1", "--volume", "/var/lib/docker"] : []),
      ...(gpu ? ["--device", gpu, "--env", "NVIDIA_DRIVER_CAPABILITIES=all"] : []),
      ...(gpu && card ? ["--env", `CUDA_VISIBLE_DEVICES=${cudaVisible(card)}`, "--env", `NVIDIA_VISIBLE_DEVICES=${cudaVisible(card)}`, "--env", `BBBOX_GPU_CARD=${cudaVisible(card)}`] : []),
      ...(box.kind === "linux-desktop" && gpu ? ["--env", "BBBOX_GPU=1"] : []),
      // A privileged container sees every GPU on the host, and Xorg would
      // take the first, so the box's start points Xorg at the one placed, by
      // its UUID or index, as nvidia-smi --id takes it (#283).
      ...(box.kind === "linux-desktop" && gpu && seesEveryCard && desktopGpuId ? ["--env", `BBBOX_GPU_ID=${desktopGpuId}`] : []),
    ];
    const args = [
      "container", "create",
      "--pull", "never",
      "--name", name,
      ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      "--hostname", hostnameOf(box.name),
      "--init",
      "--env", `${IDENTITY_VARIABLE}=${box.boxId}`,
      "--cpus", String(cores),
      ...(cpus ? ["--cpuset-cpus", formatCpuList(cpus)] : ["--env", `OMP_NUM_THREADS=${Math.ceil(cores)}`]),
      ...(lxcfs ? lxcfsMountArgs(lxcfs) : []),
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
    if (result.exitCode === 0) return made;
    if (/Conflict|already in use/i.test(result.stderr)) {
      const found = await this.#owned(name, box.boxId, signal);
      if (!found) throw new Error(`The container ${name} on ${this.#host} belongs to another box, so bb-box left it alone.`);
      const foundGpu = found.labels[LABELS.gpu] ?? null;
      const foundCard = foundGpu ? (found.labels[LABELS.gpuCard] ?? deviceCard(foundGpu)) : null;
      return { gpu: foundGpu, card: foundCard, part: foundCard ? partOfLabel(found.labels[LABELS.gpuPart]) : "none" };
    }
    if (/No such image/i.test(result.stderr)) {
      const building = dockerImageBuilding(this.#config.machine, image);
      throw new Error(
        building
          ? `${this.#host} has no image ${image} yet. bb-box is still building it.`
          : `${this.#host} has no image ${image}, and bb-box never pulls one. Build it with setup/docker/build.sh (setup/docker/README.md).`,
      );
    }
    throw this.#cli.error("docker container create", result);
  }

  /** An image's labels, or null when the host has no such image. */
  async #imageLabels(ref: string, signal?: AbortSignal): Promise<(Record<string, unknown> & { readonly [SIZE]?: number | null }) | null> {
    const result = await this.#cli.run(["image", "inspect", "--format", IMAGE_FORMAT, ref], { timeoutMs: 30_000, signal });
    if (result.exitCode !== 0) {
      if (/No such image|not found|No such object/i.test(result.stderr) || !result.stderr.trim()) return null;
      throw this.#cli.error("docker image inspect", result);
    }
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
      builds.push(labels ? this.#imageBuild(image, kind, "standard", labels, true) : { ref: image, image: "standard", kind, build: null, record: null, current: true });
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

  async #attached(push: (id: CheckId, name: string, status: DoctorCheck["status"], detail: string, fix?: string | null) => void, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    if (this.#config.machine) {
      if (this.hostOs !== "windows") return;
      const probe = this.#context.machines?.dockerProbe;
      if (!probe) return;
      let answer: { endpoint: string; attached: boolean | null };
      try {
        answer = await probe(this.#config.machine, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        push("docker.attach", "Attached output", "fail", `An attached command on ${this.#host} failed: ${message(error)}`, MACHINE_ATTACH_FIX);
        return;
      }
      const named = answer.endpoint.includes("://") ? answer.endpoint : `tcp://${answer.endpoint}`;
      const tcp = endpointOf(named);
      if (!tcp || !("host" in tcp) || !isLocalhost(tcp.host)) return;
      const where = `${tcp.host}:${tcp.port}`;
      if (answer.attached === false) {
        push("docker.attach", "Attached output", "fail", forwarderReason(where), MACHINE_ATTACH_FIX);
        return;
      }
      push("docker.attach", "Attached output", "ok", `An attached command's output comes back from tcp://${where} on ${this.#host}.`);
      return;
    }
    const address = this.#config.host;
    const tcp = address ? endpointOf(address) : null;
    if (!tcp || !("host" in tcp) || !isLocalhost(tcp.host) || this.hostOs !== "windows") return;
    const where = `${tcp.host}:${tcp.port}`;
    let text = "";
    let failed: string | null = null;
    try {
      text = await readAfterHalfClose(tcp.port, tcp.host, ATTACH_PING);
    } catch (error) {
      if (signal?.aborted) throw error;
      failed = message(error);
    }
    if (text.trim()) {
      push("docker.attach", "Attached output", "ok", `An attached command's output comes back from tcp://${where}.`);
      return;
    }
    push(
      "docker.attach",
      "Attached output",
      "fail",
      failed ? `An attached command to tcp://${where} failed: ${failed}` : forwarderReason(where),
      "Set the Docker host to wsl://<distro>, as setup/docker-wsl does. dockerd stays on its unix socket.",
    );
  }

  /** Waits for the box's main process to say the box is up, in one `docker exec`. */
  async #ready(ref: string, deadline: number, signal?: AbortSignal): Promise<void> {
    const seconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
    const script = `i=0; while [ ! -e ${READY_FILE} ]; do i=$((i+1)); [ "$i" -le ${seconds * 10} ] || exit 3; sleep 0.1; done; echo bb-box-ready`;
    const result = await this.#cli.run(["exec", "--user", BOX_USER, ref, "/bin/sh", "-c", script], { timeoutMs: (seconds + 30) * 1000, signal });
    if (result.exitCode === 0 && result.stdout.includes("bb-box-ready")) return;
    if (result.exitCode === 0) throw new Error(`docker exec ended without an exit status: ${ref} printed nothing, so exit 0 is not the command's status.`);
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
