// The Docker backend's fields in bb-box's configuration (029), parsed into a
// typed config. The settings page, the conformance run's settings file and
// the tests all go through parseDockerPart.
//
// The backend runs boxes as containers on one Docker host, through the docker
// CLI on BB's server: the local socket, or another host over SSH. Each kind
// runs an image the setup guide builds from the same guest scripts as the
// Proxmox LXC templates (setup/docker/README.md).

import { endpointOf } from "../../host/relay.ts";
import type { BackendPart, FieldDescriptor, FieldProblem, ParsedBackend } from "../types.ts";
import type { VoxlOffer } from "../voxl.ts";

export const DOCKER_KINDS = ["linux", "linux-desktop-cpu", "linux-desktop", "linux-desktop-wayland-cpu"] as const;
export type DockerKind = (typeof DOCKER_KINDS)[number];

/** The images' layout version. setup/docker/build.sh labels each image with it, and the doctor checks the label. */
export const IMAGE_VERSION = "1";

export interface DockerConfig {
  /**
   * A unix://, tcp://, ssh:// or wsl:// address, bb:<machine ID> for a BB
   * machine reached through bb-box's relay (042), or null for the docker
   * CLI's own default: DOCKER_HOST, its context, or the local socket.
   * wsl://distro reaches Docker in that WSL distribution through wsl.exe.
   */
  readonly host: string | null;
  /** The BB machine's ID when the host is one, else null. */
  readonly machine: string | null;
  /** The image of each kind, or null when the kind is off. */
  readonly images: Readonly<Record<DockerKind, string | null>>;
  /** Whether boxes are privileged containers with their own Docker daemon: on unless set (041). */
  readonly docker: boolean;
  /** The network bb-box makes for its boxes and keeps them on. */
  readonly network: string;
  /** The most bb-box containers on the host, counting every install's. */
  readonly boxes: number;
  readonly gpus: boolean;
  readonly desktopsPerGpu: number;
  readonly reserveMemoryMiB: number;
  readonly machineDockerHost: string | null;
  readonly voxl: VoxlOffer;
}

export const DOCKER_DEFAULTS = {
  linuxImage: `bbbox/linux:${IMAGE_VERSION}`,
  desktopImage: `bbbox/linux-desktop:${IMAGE_VERSION}`,
  waylandImage: `bbbox/linux-desktop-wayland:${IMAGE_VERSION}`,
  network: "bbbox",
  boxes: 10,
  desktopsPerGpu: 4,
  reserveMemoryMiB: 4096,
} as const;

/** Field keys in bb-box's configuration (029). Docker had no BB settings before it. */
export const DOCKER_KEYS = {
  host: "host",
  machineDockerHost: "machine-docker-host",
  linuxImage: "linux-image",
  desktopImage: "desktop-image",
  waylandImage: "wayland-desktop-image",
  privileged: "privileged",
  gpuDesktops: "gpu-desktops",
  desktopsPerGpu: "desktops-per-gpu",
  network: "network",
  boxes: "boxes",
  reserveMemoryMiB: "reserve-memory-mib",
  voxl: "voxl",
} as const;

export const DOCKER_FIELDS: Readonly<Record<string, FieldDescriptor>> = {
  [DOCKER_KEYS.host]: {
    type: "string",
    label: "Host",
    description:
      "The Docker daemon boxes run on. Give unix:///path/to/docker.sock, ssh://user@host, tcp://host:port, wsl://distro or wsl://user@distro, or bb:<machine ID> for a BB machine, which bb-box reaches through BB. wsl:// reaches Docker in that WSL distribution through wsl.exe and docker system dial-stdio, not through WSL's localhost forwarder. Over SSH, BB's server user must log in without a prompt. Empty uses the docker CLI's own default on BB's server: DOCKER_HOST, its current context, or the local socket.",
    group: "connection",
    default: "",
  },
  [DOCKER_KEYS.machineDockerHost]: {
    type: "string",
    label: "Docker on the machine",
    description:
      "Where Docker is on a BB machine, when Host is bb:<machine ID>. Give wsl://distro or wsl://user@distro, unix:///path/to/docker.sock, or tcp://host:port. bb-box sends it when that machine's relay opens, and the machine dials it instead of its own DOCKER_HOST or docker context. Empty leaves those. On a Windows machine whose Docker is at tcp://127.0.0.1, set wsl://<distro>: WSL's localhost forwarder drops attached output, so docker exec prints nothing and exits 0.",
    group: "connection",
    default: "",
  },
  [DOCKER_KEYS.linuxImage]: {
    type: "string",
    label: "Linux image",
    description: "The image Linux boxes run. setup/docker/build.sh builds it. Empty turns them off.",
    group: "boxes",
    default: DOCKER_DEFAULTS.linuxImage,
  },
  [DOCKER_KEYS.desktopImage]: {
    type: "string",
    label: "Desktop image",
    description: "The image Linux desktops run: those drawn by the CPU, and those on a GPU when GPU desktops are on. setup/docker/build.sh builds it. Empty turns them off.",
    group: "boxes",
    default: DOCKER_DEFAULTS.desktopImage,
  },
  [DOCKER_KEYS.waylandImage]: {
    type: "string",
    label: "Wayland desktop image",
    description: "The image Linux desktops on Wayland run: Sway, drawn by the CPU. setup/docker/build.sh builds it. Empty turns them off.",
    group: "boxes",
    default: DOCKER_DEFAULTS.waylandImage,
  },
  [DOCKER_KEYS.privileged]: {
    type: "boolean",
    label: "Docker in boxes",
    description:
      "Gives each box its own Docker daemon, started by its first docker command. Each box then runs as a privileged container, which can take over the Docker host. Off, or on rootless Docker, boxes say No Docker.",
    group: "boxes",
    default: true,
  },
  [DOCKER_KEYS.gpuDesktops]: {
    type: "boolean",
    label: "GPU boxes",
    description:
      "Offers Linux servers and desktops on the host's NVIDIA cards, shared or, where whole cards are on, a card to themselves. The NVIDIA Container Toolkit must list the cards as CDI devices (nvidia-ctk cdi generate). With Docker in boxes on, every box can open every card, with a GPU or without: bb-box places boxes on cards, but does not fence them.",
    group: "boxes",
    default: false,
  },
  [DOCKER_KEYS.voxl]: {
    type: "boolean",
    label: "Stream desktops with voxl",
    description:
      "Shows Linux desktops on X11 through voxl in the viewer, in place of Selkies or VNC. Off, they show as before, and each desktop's Display menu can still pick Stream with voxl. Only desktops from an image built with voxl have it.",
    group: "boxes",
    default: false,
  },
  [DOCKER_KEYS.desktopsPerGpu]: {
    type: "number",
    label: "Boxes per card",
    description: "The most boxes on one card, servers and desktops together, running or stopped, of every install that uses the host.",
    group: "advanced",
    default: DOCKER_DEFAULTS.desktopsPerGpu,
  },
  [DOCKER_KEYS.network]: {
    type: "string",
    label: "Network",
    description: "The Docker network bb-box makes for its boxes, apart from the host's other containers.",
    group: "advanced",
    default: DOCKER_DEFAULTS.network,
  },
  [DOCKER_KEYS.boxes]: {
    type: "number",
    label: "Most boxes",
    description: "The most bb-box containers on the host at once, running or stopped. This counts those of every bb-box install that uses the host.",
    group: "advanced",
    default: DOCKER_DEFAULTS.boxes,
  },
  [DOCKER_KEYS.reserveMemoryMiB]: {
    type: "number",
    label: "Memory kept free (MiB)",
    description: "Memory the host keeps for itself. A new box is refused if the host would have less than this left, after the memory limits of the running boxes.",
    group: "advanced",
    default: DOCKER_DEFAULTS.reserveMemoryMiB,
  },
};

/** A string setting, or `fallback` when the key is absent. An empty string stays empty. */
function text(values: Readonly<Record<string, unknown>>, key: string, fallback = ""): string {
  const value = values[key];
  if (value === undefined || value === null) return fallback;
  return typeof value === "string" ? value.trim() : "";
}

function number(values: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const value = values[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

export function voxlOfferOf(setting: unknown): VoxlOffer {
  return setting === true ? "chosen" : "offered";
}

/** An image reference as bb-box passes it to docker: no spaces or quotes, and no leading "-". */
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
const NETWORK = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const UNIX = /^unix:\/\/\/[^\s'"]+$/;
/** A BB machine, by its ID: bb-box reaches its Docker through BB (042). */
export const BB_MACHINE = /^bb:([A-Za-z0-9_-]{1,64})$/;
const SSH = /^ssh:\/\/(?:[a-z_][a-z0-9_.-]{0,31}@)?(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9][A-Za-z0-9.-]*)(?::\d{1,5})?$/;

function directHost(host: string): boolean {
  if (!host.startsWith("tcp://") && !host.startsWith("wsl://")) return false;
  return endpointOf(host) !== null;
}

/** Docker's part of bb-box's configuration (029), with each problem at its field. */
export function parseDockerPart(part: BackendPart): ParsedBackend<DockerConfig> {
  const values = part.fields;
  const problems: FieldProblem[] = [];
  const problem = (path: string, message: string) => problems.push({ path, message });

  const host = text(values, DOCKER_KEYS.host);
  if (host && !UNIX.test(host) && !SSH.test(host) && !BB_MACHINE.test(host) && !directHost(host)) {
    problem(DOCKER_KEYS.host, `Docker: the host "${host}" must be unix:///path/to/docker.sock, ssh://user@host, tcp://host:port, wsl://distro or wsl://user@distro, or bb:<machine ID>, or empty for the docker CLI's default.`);
  }
  const machineTarget = text(values, DOCKER_KEYS.machineDockerHost);
  const machineId = BB_MACHINE.exec(host)?.[1] ?? null;
  if (machineTarget && !endpointOf(machineTarget)) {
    problem(DOCKER_KEYS.machineDockerHost, `Docker: machine-docker-host "${machineTarget}" must be wsl://distro, wsl://user@distro, unix:///path/to/docker.sock or tcp://host:port.`);
  } else if (machineTarget && !machineId) {
    problem(DOCKER_KEYS.machineDockerHost, "Docker: machine-docker-host is for a host of bb:<machine ID>. It names where Docker is on that machine.");
  }

  const linux = text(values, DOCKER_KEYS.linuxImage, DOCKER_DEFAULTS.linuxImage);
  const desktop = text(values, DOCKER_KEYS.desktopImage, DOCKER_DEFAULTS.desktopImage);
  const wayland = text(values, DOCKER_KEYS.waylandImage, DOCKER_DEFAULTS.waylandImage);
  for (const [key, what, image] of [
    [DOCKER_KEYS.linuxImage, "linux", linux],
    [DOCKER_KEYS.desktopImage, "desktop", desktop],
    [DOCKER_KEYS.waylandImage, "Wayland desktop", wayland],
  ] as const) {
    if (image && !IMAGE.test(image)) problem(key, `Docker: the ${what} image "${image}" is not an image reference bb-box can use.`);
  }
  if (!linux && !desktop && !wayland) problem(DOCKER_KEYS.linuxImage, "Docker: give a linux or a desktop image.");
  // On unless set to false (041).
  const privileged = values[DOCKER_KEYS.privileged] !== false;
  const gpu = values[DOCKER_KEYS.gpuDesktops] === true;
  const images: Record<DockerKind, string | null> = {
    linux: linux || null,
    "linux-desktop-cpu": desktop || null,
    "linux-desktop": gpu && desktop ? desktop : null,
    "linux-desktop-wayland-cpu": wayland || null,
  };

  const network = text(values, DOCKER_KEYS.network, DOCKER_DEFAULTS.network);
  if (!NETWORK.test(network)) problem(DOCKER_KEYS.network, `Docker: "${network}" is not a Docker network name.`);
  const boxes = number(values, DOCKER_KEYS.boxes, DOCKER_DEFAULTS.boxes);
  if (!Number.isInteger(boxes) || boxes < 1) problem(DOCKER_KEYS.boxes, "Docker: the most boxes must be a whole number, at least 1.");
  const desktopsPerGpu = number(values, DOCKER_KEYS.desktopsPerGpu, DOCKER_DEFAULTS.desktopsPerGpu);
  if (!Number.isInteger(desktopsPerGpu) || desktopsPerGpu < 1) problem(DOCKER_KEYS.desktopsPerGpu, "Docker: boxes per card must be a whole number, at least 1.");
  const reserveMemoryMiB = number(values, DOCKER_KEYS.reserveMemoryMiB, DOCKER_DEFAULTS.reserveMemoryMiB);
  if (!(reserveMemoryMiB >= 0)) problem(DOCKER_KEYS.reserveMemoryMiB, "Docker: the memory kept free cannot be negative.");

  const voxl = voxlOfferOf(values[DOCKER_KEYS.voxl]);

  if (problems.length) return { ok: false, problems };
  return { ok: true, config: { host: host || null, machine: machineId, images, docker: privileged, network, boxes, gpus: gpu, desktopsPerGpu, reserveMemoryMiB, machineDockerHost: machineTarget || null, voxl } };
}

export function machineDockerHost(backends: readonly { readonly type: string; readonly fields: Readonly<Record<string, unknown>> }[], hostId: string): string | null {
  const values = new Set<string>();
  for (const backend of backends) {
    if (backend.type !== "docker" || backend.fields.host !== `bb:${hostId}`) continue;
    const value = backend.fields[DOCKER_KEYS.machineDockerHost];
    if (typeof value === "string" && value.trim()) values.add(value.trim());
  }
  if (values.size > 1) throw new Error(`BB machine ${hostId} has more than one machine-docker-host: ${[...values].join(", ")}.`);
  return [...values][0] ?? null;
}
