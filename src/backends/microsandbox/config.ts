// The microsandbox backend's fields in bb-box's configuration (029), parsed
// into a typed config (053). The backend runs boxes as libkrun microVMs with
// bb-box's msb on one Linux host with KVM: BB's server, one over ssh://, or
// a BB machine through bb-box's msb relay; a Mac with Apple silicon runs the
// arm64 kinds. Each kind runs one of the images setup/docker/build.sh builds,
// imported into msb from Docker on the host, or built in a microVM there.

import type { BackendPart, FieldDescriptor, FieldProblem, ParsedBackend } from "../types.ts";
import { BB_MACHINE } from "../docker/config.ts";
import { IMAGE_REF } from "./release.ts";

export const MSB_KINDS = ["linux", "linux-desktop-cpu", "linux-arm64", "linux-arm64-desktop-cpu"] as const;
export type MsbKind = (typeof MSB_KINDS)[number];

export interface MsbConfig {
  /** ssh://user@host, bb:<machine ID> for a BB machine reached through bb-box's msb relay, or null for BB's server. */
  readonly host: string | null;
  /** The BB machine's ID when the host is one, else null. */
  readonly machine: string | null;
  /**
   * The image of each kind, or null when the kind is off. A host offers the
   * kinds of its architecture: x86_64 the first two, arm64, as a Mac, the
   * arm64 ones (040).
   */
  readonly images: Readonly<Record<MsbKind, string | null>>;
  /** Whether each box has Docker, on an ext4 disk of its own: on unless set (041). */
  readonly docker: boolean;
  /** The most that disk may grow to, in GiB. It takes only what Docker writes. */
  readonly dockerDiskGiB: number;
  /** A box's root disk when none is asked for, in GiB. It takes only what the box writes. */
  readonly diskGiB: number;
  /** msb's network profiles for each box, such as public,private. */
  readonly network: string;
  /** The most bb-box microVMs on the host, counting every install's. */
  readonly boxes: number;
  readonly reserveMemoryMiB: number;
  /**
   * How many times the host's memory, less the reserve, the running boxes'
   * sizes may add up to (#557). Above 1, a new box also needs memory
   * available on the host now.
   */
  readonly memoryOvercommit: number;
}

export const MSB_DEFAULTS = {
  linuxImage: "bbbox/linux:1",
  desktopImage: "bbbox/linux-desktop:1",
  arm64Image: "bbbox/linux:1-arm64",
  arm64DesktopImage: "bbbox/linux-desktop:1-arm64",
  dockerDiskGiB: 64,
  diskGiB: 32,
  // BB's server is often on a private or tailnet address, which msb's
  // default profile does not reach (053).
  network: "public,private",
  boxes: 20,
  reserveMemoryMiB: 4096,
  memoryOvercommit: 1,
} as const;

/** The most memory overcommit bb-box allows. */
export const MSB_MAX_OVERCOMMIT = 4;

export const MSB_KEYS = {
  host: "host",
  linuxImage: "linux-image",
  desktopImage: "desktop-image",
  arm64Image: "linux-arm64-image",
  arm64DesktopImage: "desktop-arm64-image",
  docker: "docker",
  dockerDiskGiB: "docker-disk-gib",
  diskGiB: "disk-gib",
  network: "network",
  boxes: "boxes",
  reserveMemoryMiB: "reserve-memory-mib",
  memoryOvercommit: "memory-overcommit",
} as const;

export const MSB_FIELDS: Readonly<Record<string, FieldDescriptor>> = {
  [MSB_KEYS.host]: {
    type: "string",
    label: "Host",
    description:
      "The host that runs the boxes, a Linux host with KVM or a Mac: ssh://user@host, or bb:<machine ID> for a BB machine, which bb-box reaches through BB. Empty uses BB's server. bb-box installs its own msb there, in a folder of its own.",
    group: "connection",
    default: "",
  },
  [MSB_KEYS.linuxImage]: {
    type: "string",
    label: "Linux image",
    description: "The image linux boxes run. bb-box imports it from Docker on the host, where setup/docker/build.sh builds it. Empty turns them off.",
    group: "boxes",
    default: MSB_DEFAULTS.linuxImage,
  },
  [MSB_KEYS.desktopImage]: {
    type: "string",
    label: "Desktop image",
    description: "The image linux-desktop-cpu boxes run. bb-box imports it from Docker on the host, where setup/docker/build.sh builds it. Empty turns them off.",
    group: "boxes",
    default: MSB_DEFAULTS.desktopImage,
  },
  [MSB_KEYS.arm64Image]: {
    type: "string",
    label: "Linux image (arm64)",
    description:
      "The image linux-arm64 boxes run, on an arm64 host such as a Mac. bb-box imports it from Docker on the host, or builds it there with setup/docker/build.sh --arch arm64 in a microVM of its own. Empty turns them off.",
    group: "boxes",
    default: MSB_DEFAULTS.arm64Image,
  },
  [MSB_KEYS.arm64DesktopImage]: {
    type: "string",
    label: "Desktop image (arm64)",
    description:
      "The image linux-arm64-desktop-cpu boxes run, on an arm64 host such as a Mac. bb-box imports it from Docker on the host, or builds it there in a microVM of its own. Empty turns them off.",
    group: "boxes",
    default: MSB_DEFAULTS.arm64DesktopImage,
  },
  [MSB_KEYS.docker]: {
    type: "boolean",
    label: "Docker in boxes",
    description: "Give each box its own Docker daemon, started by its first docker command, with its data on a disk of the box's own. Each box has its own kernel, so this needs no privilege on the host.",
    group: "boxes",
    default: true,
  },
  [MSB_KEYS.dockerDiskGiB]: {
    type: "number",
    label: "Docker disk (GiB)",
    description: "The most each box's Docker disk may grow to. It takes only what Docker writes, and goes with the box.",
    group: "advanced",
    default: MSB_DEFAULTS.dockerDiskGiB,
  },
  [MSB_KEYS.diskGiB]: {
    type: "number",
    label: "Root disk (GiB)",
    description: "The most a box's root disk may grow to when no disk size is asked for. It takes only what the box writes.",
    group: "advanced",
    default: MSB_DEFAULTS.diskGiB,
  },
  [MSB_KEYS.network]: {
    type: "string",
    label: "Network profiles",
    description: "msb's network profiles for each box, comma-separated: public reaches the internet, private the host's local networks and tailnet, where BB's server often is.",
    group: "advanced",
    default: MSB_DEFAULTS.network,
  },
  [MSB_KEYS.boxes]: {
    type: "number",
    label: "Most boxes",
    description: "The most bb-box microVMs on the host at once, running or stopped, counting those of every bb-box install that uses it.",
    group: "advanced",
    default: MSB_DEFAULTS.boxes,
  },
  [MSB_KEYS.reserveMemoryMiB]: {
    type: "number",
    label: "Memory kept free (MiB)",
    description: "A new box is refused if the host would have less memory than this left, after the memory of the running boxes.",
    group: "advanced",
    default: MSB_DEFAULTS.reserveMemoryMiB,
  },
  [MSB_KEYS.memoryOvercommit]: {
    type: "number",
    label: "Memory overcommit",
    description: "How many times the host's memory the boxes may take in all, after the memory kept free: 1 to 4. At 1, each box counts at its full memory. Above 1, a new box also needs memory free on the host now. Raise it for mostly idle boxes.",
    group: "advanced",
    default: MSB_DEFAULTS.memoryOvercommit,
  },
};

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

const SSH = /^ssh:\/\/(?:[a-z_][a-z0-9_.-]{0,31}@)?(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9][A-Za-z0-9.-]*)(?::\d{1,5})?$/;
const PROFILES = new Set(["public", "private", "host"]);

/** microsandbox's part of bb-box's configuration (029), with each problem at its field. */
export function parseMsbPart(part: BackendPart): ParsedBackend<MsbConfig> {
  const values = part.fields;
  const problems: FieldProblem[] = [];
  const problem = (path: string, message: string) => problems.push({ path, message });

  const host = text(values, MSB_KEYS.host);
  if (host && !SSH.test(host) && !BB_MACHINE.test(host)) {
    problem(MSB_KEYS.host, `microsandbox: the host "${host}" must be ssh://user@host or bb:<machine ID>, or empty for BB's server.`);
  }
  const linux = text(values, MSB_KEYS.linuxImage, MSB_DEFAULTS.linuxImage);
  const desktop = text(values, MSB_KEYS.desktopImage, MSB_DEFAULTS.desktopImage);
  const arm64 = text(values, MSB_KEYS.arm64Image, MSB_DEFAULTS.arm64Image);
  const arm64Desktop = text(values, MSB_KEYS.arm64DesktopImage, MSB_DEFAULTS.arm64DesktopImage);
  for (const [key, what, image] of [
    [MSB_KEYS.linuxImage, "linux", linux],
    [MSB_KEYS.desktopImage, "desktop", desktop],
    [MSB_KEYS.arm64Image, "arm64 linux", arm64],
    [MSB_KEYS.arm64DesktopImage, "arm64 desktop", arm64Desktop],
  ] as const) {
    if (image && !IMAGE_REF.test(image)) problem(key, `microsandbox: the ${what} image "${image}" is not an image reference bb-box can use.`);
  }
  if (!linux && !desktop && !arm64 && !arm64Desktop) problem(MSB_KEYS.linuxImage, "microsandbox: give a linux or a desktop image.");
  const docker = values[MSB_KEYS.docker] !== false;
  const whole = (key: string, fallback: number, least: number, what: string) => {
    const value = number(values, key, fallback);
    if (!Number.isInteger(value) || value < least) problem(key, `microsandbox: ${what} must be a whole number, at least ${least}.`);
    return value;
  };
  const dockerDiskGiB = whole(MSB_KEYS.dockerDiskGiB, MSB_DEFAULTS.dockerDiskGiB, 4, "the Docker disk");
  const diskGiB = whole(MSB_KEYS.diskGiB, MSB_DEFAULTS.diskGiB, 4, "the root disk");
  const network = text(values, MSB_KEYS.network, MSB_DEFAULTS.network);
  const profiles = network.split(",").map((profile) => profile.trim());
  if (!profiles.length || profiles.some((profile) => !PROFILES.has(profile))) {
    problem(MSB_KEYS.network, `microsandbox: "${network}" is not a list of msb's network profiles: public, private and host.`);
  }
  const boxes = whole(MSB_KEYS.boxes, MSB_DEFAULTS.boxes, 1, "the most boxes");
  const reserveMemoryMiB = number(values, MSB_KEYS.reserveMemoryMiB, MSB_DEFAULTS.reserveMemoryMiB);
  if (!(reserveMemoryMiB >= 0)) problem(MSB_KEYS.reserveMemoryMiB, "microsandbox: the memory kept free cannot be negative.");
  const memoryOvercommit = number(values, MSB_KEYS.memoryOvercommit, MSB_DEFAULTS.memoryOvercommit);
  if (!(memoryOvercommit >= 1 && memoryOvercommit <= MSB_MAX_OVERCOMMIT)) {
    problem(MSB_KEYS.memoryOvercommit, `microsandbox: the memory overcommit must be from 1 to ${MSB_MAX_OVERCOMMIT}, such as 1.5.`);
  }

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    config: {
      host: host || null,
      machine: BB_MACHINE.exec(host)?.[1] ?? null,
      images: { linux: linux || null, "linux-desktop-cpu": desktop || null, "linux-arm64": arm64 || null, "linux-arm64-desktop-cpu": arm64Desktop || null },
      docker,
      dockerDiskGiB,
      diskGiB,
      network: profiles.join(","),
      boxes,
      reserveMemoryMiB,
      memoryOvercommit,
    },
  };
}
