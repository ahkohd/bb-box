// The Docker backend's fields in bb-box's configuration (029), parsed into a
// typed config. The settings page, the conformance run's settings file and
// the tests all go through parseDockerPart.
//
// The backend runs boxes as containers on one Docker host, through the docker
// CLI on BB's server: the local socket, or another host over SSH. Each kind
// runs an image the setup guide builds from the same guest scripts as the
// Proxmox LXC templates (setup/docker/README.md).

import type { BackendPart, FieldDescriptor, FieldProblem, ParsedBackend } from "../types.ts";

export const DOCKER_KINDS = ["linux", "linux-desktop-cpu", "linux-desktop", "linux-desktop-wayland-cpu"] as const;
export type DockerKind = (typeof DOCKER_KINDS)[number];

/** The images' layout version. setup/docker/build.sh labels each image with it, and the doctor checks the label. */
export const IMAGE_VERSION = "1";

export interface DockerConfig {
  /**
   * A unix:// or ssh:// address, bb:<machine ID> for a BB machine reached
   * through bb-box's relay (042), or null for the docker CLI's own default:
   * DOCKER_HOST, its context, or the local socket.
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
  readonly desktopsPerGpu: number;
  readonly reserveMemoryMiB: number;
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
  linuxImage: "linux-image",
  desktopImage: "desktop-image",
  waylandImage: "wayland-desktop-image",
  privileged: "privileged",
  gpuDesktops: "gpu-desktops",
  desktopsPerGpu: "desktops-per-gpu",
  network: "network",
  boxes: "boxes",
  reserveMemoryMiB: "reserve-memory-mib",
} as const;

export const DOCKER_FIELDS: Readonly<Record<string, FieldDescriptor>> = {
  [DOCKER_KEYS.host]: {
    type: "string",
    label: "Host",
    description:
      "Where the Docker daemon is, as unix:///path/to/docker.sock, ssh://user@host, or bb:<machine ID> for a BB machine, which bb-box reaches through BB. Empty uses the docker CLI's own default on BB's server: DOCKER_HOST, its current context, or the local socket. Over SSH, BB's server user must log in without a prompt.",
    group: "connection",
    default: "",
  },
  [DOCKER_KEYS.linuxImage]: {
    type: "string",
    label: "Linux image",
    description: "The image linux boxes run. setup/docker/build.sh builds it. Empty turns them off.",
    group: "boxes",
    default: DOCKER_DEFAULTS.linuxImage,
  },
  [DOCKER_KEYS.desktopImage]: {
    type: "string",
    label: "Desktop image",
    description: "The image linux-desktop-cpu boxes, and linux-desktop boxes when GPU desktops are on, run. setup/docker/build.sh builds it. Empty turns them off.",
    group: "boxes",
    default: DOCKER_DEFAULTS.desktopImage,
  },
  [DOCKER_KEYS.waylandImage]: {
    type: "string",
    label: "Wayland desktop image",
    description: "The image linux-desktop-wayland-cpu boxes run: Sway on Wayland, drawn by the CPU. setup/docker/build.sh builds it. Empty turns them off.",
    group: "boxes",
    default: DOCKER_DEFAULTS.waylandImage,
  },
  [DOCKER_KEYS.privileged]: {
    type: "boolean",
    label: "Docker in boxes",
    description:
      "Give each box its own Docker daemon, started by its first docker command. Each runs as a privileged container, which can take over the Docker host. Off, or on rootless Docker, boxes say No Docker.",
    group: "boxes",
    default: true,
  },
  [DOCKER_KEYS.gpuDesktops]: {
    type: "boolean",
    label: "GPU desktops",
    description:
      "Offer linux-desktop boxes on the host's NVIDIA GPUs, which the NVIDIA Container Toolkit lists as CDI devices (nvidia-ctk cdi generate).",
    group: "boxes",
    default: false,
  },
  [DOCKER_KEYS.desktopsPerGpu]: {
    type: "number",
    label: "Desktops per GPU",
    description: "The most linux-desktop boxes that share one GPU.",
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
    description: "The most bb-box containers on the host at once, running or stopped, counting those of every bb-box install that uses it.",
    group: "advanced",
    default: DOCKER_DEFAULTS.boxes,
  },
  [DOCKER_KEYS.reserveMemoryMiB]: {
    type: "number",
    label: "Memory kept free (MiB)",
    description: "A new box is refused if the host would have less memory than this left, after the memory limits of the running boxes.",
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

/** An image reference as bb-box passes it to docker: no spaces or quotes, and no leading "-". */
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
const NETWORK = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const UNIX = /^unix:\/\/\/[^\s'"]+$/;
/** A BB machine, by its ID: bb-box reaches its Docker through BB (042). */
export const BB_MACHINE = /^bb:([A-Za-z0-9_-]{1,64})$/;
const SSH = /^ssh:\/\/(?:[a-z_][a-z0-9_.-]{0,31}@)?(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9][A-Za-z0-9.-]*)(?::\d{1,5})?$/;

/** Docker's part of bb-box's configuration (029), with each problem at its field. */
export function parseDockerPart(part: BackendPart): ParsedBackend<DockerConfig> {
  const values = part.fields;
  const problems: FieldProblem[] = [];
  const problem = (path: string, message: string) => problems.push({ path, message });

  const host = text(values, DOCKER_KEYS.host);
  if (host && !UNIX.test(host) && !SSH.test(host) && !BB_MACHINE.test(host)) {
    problem(DOCKER_KEYS.host, `Docker: the host "${host}" must be unix:///path/to/docker.sock, ssh://user@host or bb:<machine ID>, or empty for the docker CLI's default.`);
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
  if (!Number.isInteger(desktopsPerGpu) || desktopsPerGpu < 1) problem(DOCKER_KEYS.desktopsPerGpu, "Docker: desktops per GPU must be a whole number, at least 1.");
  const reserveMemoryMiB = number(values, DOCKER_KEYS.reserveMemoryMiB, DOCKER_DEFAULTS.reserveMemoryMiB);
  if (!(reserveMemoryMiB >= 0)) problem(DOCKER_KEYS.reserveMemoryMiB, "Docker: the memory kept free cannot be negative.");

  if (problems.length) return { ok: false, problems };
  return { ok: true, config: { host: host || null, machine: BB_MACHINE.exec(host)?.[1] ?? null, images, docker: privileged, network, boxes, desktopsPerGpu, reserveMemoryMiB } };
}
