import { DOCKER_FIELDS, DOCKER_KEYS, parseDockerPart } from "../docker/config.ts";
import type { BackendPart, FieldDescriptor, FieldProblem, ParsedBackend } from "../types.ts";
import type { HetznerConfig } from "./backend.ts";

export const HETZNER_KINDS = ["linux", "linux-desktop-cpu", "linux-desktop-wayland-cpu"] as const;

export const HETZNER_DEFAULTS = {
  location: "nbg1",
  serverType: "cpx42",
  hostImage: "ubuntu-26.04",
  mostHosts: 2,
  idleMinutes: 30,
  monthlyLimitEurosBeforeVat: 20,
} as const;

export const HETZNER_KEYS = {
  token: "token",
  location: "location",
  serverType: "server-type",
  hostImage: "host-image",
  mostHosts: "most-hosts",
  idleMinutes: "idle-minutes",
  monthlyLimit: "monthly-limit-eur",
  sshFrom: "ssh-from",
} as const;

const DOCKER_FIELDS_ON_A_CLOUD_HOST = [DOCKER_KEYS.linuxImage, DOCKER_KEYS.desktopImage, DOCKER_KEYS.waylandImage, DOCKER_KEYS.privileged, DOCKER_KEYS.boxes, DOCKER_KEYS.reserveMemoryMiB, DOCKER_KEYS.network] as const;

export const HETZNER_FIELDS: Readonly<Record<string, FieldDescriptor>> = {
  [HETZNER_KEYS.token]: {
    type: "string",
    label: "API token",
    description: "A Read & Write API token of the Hetzner Cloud project bb-box makes its hosts in, from the project's Security page. The project should hold nothing else.",
    secret: true,
    group: "credentials",
  },
  [HETZNER_KEYS.location]: {
    type: "string",
    label: "Location",
    description: "Where hosts are made, such as nbg1 (Nuremberg), fsn1 (Falkenstein) or hel1 (Helsinki): near BB's server, as a desktop's stream crosses between them.",
    group: "connection",
    default: HETZNER_DEFAULTS.location,
  },
  [HETZNER_KEYS.serverType]: {
    type: "string",
    label: "Server type",
    description: "The type of every host, such as cpx42 (8 cores, 16 GB, 320 GB disk). A box at its largest must fit one, with the memory kept free.",
    group: "boxes",
    default: HETZNER_DEFAULTS.serverType,
  },
  [HETZNER_KEYS.mostHosts]: {
    type: "number",
    label: "Most hosts",
    description: "The most hosts at once. At this many, a box that fits on none of them is refused.",
    group: "boxes",
    default: HETZNER_DEFAULTS.mostHosts,
  },
  [HETZNER_KEYS.idleMinutes]: {
    type: "number",
    label: "Idle minutes",
    description: "A host with no box for this long is deleted. Hetzner bills by the started hour, so a shorter time saves little and makes acquires wait for a new host more often.",
    group: "boxes",
    default: HETZNER_DEFAULTS.idleMinutes,
  },
  [HETZNER_KEYS.monthlyLimit]: {
    type: "number",
    label: "Monthly limit (EUR)",
    description: "bb-box makes no host that would take this calendar month's spend on hosts past this many euros before VAT. 0 sets no limit. Hetzner has no limit of its own: set a cost alert in its Console too.",
    group: "boxes",
    default: HETZNER_DEFAULTS.monthlyLimitEurosBeforeVat,
  },
  [HETZNER_KEYS.hostImage]: {
    type: "string",
    label: "Host image",
    description: "What hosts start from. An image name, such as ubuntu-26.04, is the base of the host image bb-box builds as a snapshot, with Docker, Tailscale and the box images in it, and rebuilds weekly or when its scripts change, keeping two; until the first is built, hosts start from the image itself. A snapshot's ID makes hosts start from that snapshot, and bb-box builds none.",
    group: "advanced",
    default: HETZNER_DEFAULTS.hostImage,
  },
  [HETZNER_KEYS.sshFrom]: {
    type: "string",
    label: "SSH from",
    description: "Only with the tailnet off: the addresses, as CIDRs separated by commas, that may reach a host's SSH over the internet, such as BB's server's public address. With the tailnet on, a host's SSH is reached on the tailnet alone.",
    group: "advanced",
    default: "",
  },
  ...Object.fromEntries(DOCKER_FIELDS_ON_A_CLOUD_HOST.map((key) => [key, DOCKER_FIELDS[key]!])),
};

const LOCATION = /^[a-z]{3}\d$/;
const SERVER_TYPE = /^[a-z0-9-]{2,32}$/;
const IMAGE_NAME = /^[a-z0-9][a-z0-9._-]{1,62}$/;
const CIDR = /^(?:\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}|[0-9a-fA-F:]+\/\d{1,3})$/;

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

export function parseHetznerPart(part: BackendPart): ParsedBackend<HetznerConfig> {
  const values = part.fields;
  const problems: FieldProblem[] = [];
  const problem = (path: string, message: string) => problems.push({ path, message });

  const token = text(values, HETZNER_KEYS.token);
  if (!token) problem(HETZNER_KEYS.token, "Hetzner Cloud: set the project's API token.");
  else if (!/^\S{20,200}$/.test(token)) problem(HETZNER_KEYS.token, "Hetzner Cloud: the API token is one word, as the Console gives it.");

  const location = text(values, HETZNER_KEYS.location, HETZNER_DEFAULTS.location);
  if (!LOCATION.test(location)) problem(HETZNER_KEYS.location, `Hetzner Cloud: "${location}" is not a location, such as nbg1.`);
  const serverType = text(values, HETZNER_KEYS.serverType, HETZNER_DEFAULTS.serverType);
  if (!SERVER_TYPE.test(serverType)) problem(HETZNER_KEYS.serverType, `Hetzner Cloud: "${serverType}" is not a server type, such as cpx42.`);
  const imageText = text(values, HETZNER_KEYS.hostImage, HETZNER_DEFAULTS.hostImage);
  const hostImage = /^\d+$/.test(imageText) ? Number(imageText) : imageText;
  if (typeof hostImage === "string" && !IMAGE_NAME.test(hostImage)) problem(HETZNER_KEYS.hostImage, `Hetzner Cloud: "${imageText}" is not an image name or a snapshot's ID.`);

  const mostHosts = number(values, HETZNER_KEYS.mostHosts, HETZNER_DEFAULTS.mostHosts);
  if (!Number.isInteger(mostHosts) || mostHosts < 1 || mostHosts > 20) problem(HETZNER_KEYS.mostHosts, "Hetzner Cloud: the most hosts must be a whole number from 1 to 20.");
  const idleMinutes = number(values, HETZNER_KEYS.idleMinutes, HETZNER_DEFAULTS.idleMinutes);
  if (!(idleMinutes >= 5 && idleMinutes <= 24 * 60)) problem(HETZNER_KEYS.idleMinutes, "Hetzner Cloud: the idle minutes must be from 5 to 1440.");
  const monthly = number(values, HETZNER_KEYS.monthlyLimit, HETZNER_DEFAULTS.monthlyLimitEurosBeforeVat);
  if (!(monthly >= 0)) problem(HETZNER_KEYS.monthlyLimit, "Hetzner Cloud: the monthly limit cannot be negative.");
  const sshFrom = text(values, HETZNER_KEYS.sshFrom)
    .split(/[\s,]+/)
    .filter(Boolean);
  for (const cidr of sshFrom) if (!CIDR.test(cidr)) problem(HETZNER_KEYS.sshFrom, `Hetzner Cloud: "${cidr}" is not an address range such as 203.0.113.7/32.`);

  const docker = parseDockerPart({ id: part.id, hosts: [], fields: { ...values, [DOCKER_KEYS.host]: "", [DOCKER_KEYS.gpuDesktops]: false } });
  if (!docker.ok) problems.push(...docker.problems.map((each) => ({ ...each, message: each.message.replace(/^Docker:/, "Hetzner Cloud:") })));

  if (problems.length || !docker.ok) return { ok: false, problems };
  return {
    ok: true,
    config: {
      token,
      location,
      serverType,
      hostImage,
      hostImageLabel: typeof hostImage === "number" ? `snapshot-${hostImage}` : hostImage,
      mostHosts,
      idleMinutes,
      monthlyLimitEurosBeforeVat: monthly === 0 ? null : monthly,
      sshFrom,
      docker: docker.config,
    },
  };
}
