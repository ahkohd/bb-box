import type { BackendPart, FieldDescriptor, FieldProblem, ParsedBackend } from "../types.ts";

export const NAMESPACE_KINDS = ["macos", "macos-desktop", "linux", "linux-desktop-cpu", "linux-desktop-wayland-cpu"] as const;
export type NamespaceKind = (typeof NAMESPACE_KINDS)[number];

export const NAMESPACE_REGIONS = ["us", "eu"] as const;
export type NamespaceRegion = (typeof NAMESPACE_REGIONS)[number];

export interface NamespaceIosHosts {
  readonly on: boolean;
  readonly most: number | null;
  readonly ahead: number;
  readonly resettingMost: number;
  readonly diskReserveGiB: number;
}

export interface NamespaceConfig {
  readonly token: string;
  readonly region: NamespaceRegion;
  readonly macosVersion: string;
  readonly machines: number;
  readonly longestLifeHours: number;
  readonly largestMachine: MacShape | null;
  readonly iosHosts?: NamespaceIosHosts;
}

export const NAMESPACE_IOS_HOSTS_DEFAULTS: NamespaceIosHosts = { on: true, most: null, ahead: 1, resettingMost: 2, diskReserveGiB: 20 };

export interface MacShape {
  readonly cores: number;
  readonly memoryGB: number;
}

export const NAMESPACE_DEFAULTS = {
  region: "us",
  macosVersion: "26.x",
  machines: 2,
  longestLifeHours: 3,
} as const;

export const NAMESPACE_KEYS = {
  token: "token",
  region: "region",
  macosVersion: "macos-version",
  machines: "machines",
  longestLifeHours: "longest-life-hours",
  largestMachine: "largest-machine",
  iosHostsOn: "ios-hosts-on",
  iosHostsMost: "ios-hosts-most",
  iosHostsAhead: "ios-hosts-ahead",
  iosHostsResettingMost: "ios-hosts-resetting-most",
  iosHostsDiskReserveGiB: "ios-hosts-disk-reserve-gib",
} as const;

export const NAMESPACE_FIELDS: Readonly<Record<string, FieldDescriptor>> = {
  [NAMESPACE_KEYS.token]: {
    type: "string",
    label: "API token",
    description: "The token bb-box calls Namespace's API with. Make a revocable token for the workspace with nsc token create, granted the instance actions the guide lists.",
    group: "connection",
    secret: true,
  },
  [NAMESPACE_KEYS.region]: {
    type: "string",
    label: "API region",
    description: "Where bb-box calls Namespace's API and its SSH gateway: us or eu. Where the machines run is the workspace's regional preference, which Namespace's support sets.",
    group: "connection",
    default: NAMESPACE_DEFAULTS.region,
  },
  [NAMESPACE_KEYS.macosVersion]: {
    type: "string",
    label: "macOS version",
    description: "The macOS a box runs, as Namespace's base images name it, such as 26.x.",
    group: "boxes",
    default: NAMESPACE_DEFAULTS.macosVersion,
  },
  [NAMESPACE_KEYS.machines]: {
    type: "number",
    label: "Most machines",
    description: "The most Namespace machines bb-box has at once. Each box is one machine, billed by the minute while it exists.",
    group: "boxes",
    default: NAMESPACE_DEFAULTS.machines,
  },
  [NAMESPACE_KEYS.longestLifeHours]: {
    type: "number",
    label: "Longest life (hours)",
    description: "How long the workspace's plan lets a machine live. That is 3 hours on Developer, 5 on Team and up to 24 on Business. A box ends then, and its thread hears an hour ahead.",
    group: "boxes",
    default: NAMESPACE_DEFAULTS.longestLifeHours,
  },
  [NAMESPACE_KEYS.largestMachine]: {
    type: "string",
    label: "Largest machine",
    description: "The largest Mac bb-box asks for, as cores x memory in GB, such as 6x14. A box that needs a larger one is refused before bb-box asks Namespace, so another backend can take it. Empty: the largest the workspace allows, which bb-box reads from Namespace when the token may, or learns the first time Namespace refuses a Mac for its size.",
    group: "boxes",
  },
  [NAMESPACE_KEYS.iosHostsOn]: {
    type: "boolean",
    label: "Shared iOS hosts",
    description:
      "Lends iOS boxes as macOS users on a shared Namespace Mac. A host is made for an iOS box that finds no slot on a pool Mac or a Tart host, and deleted when its last box goes. It lends once bb-box has measured that Namespace's Macs run the iOS Simulator. A host takes the workspace's one Mac, so no macOS box starts on Namespace while it lives.",
    group: "ios-hosts",
    default: NAMESPACE_IOS_HOSTS_DEFAULTS.on,
  },
  [NAMESPACE_KEYS.iosHostsMost]: {
    type: "number",
    label: "Slots a host lends at most",
    description: "The most slots a shared host has at once, making, ready or held. Empty, bb-box estimates it from the Mac's cores, memory and video encoder, as for a pool Mac.",
    group: "ios-hosts",
  },
  [NAMESPACE_KEYS.iosHostsAhead]: {
    type: "number",
    label: "Slots a host keeps ready",
    description: "Slots a shared host keeps ready while it holds a box.",
    group: "ios-hosts",
    default: NAMESPACE_IOS_HOSTS_DEFAULTS.ahead,
  },
  [NAMESPACE_KEYS.iosHostsResettingMost]: {
    type: "number",
    label: "Slots a host resets at once",
    description: "The most released slots a shared host resets at once.",
    group: "ios-hosts",
    default: NAMESPACE_IOS_HOSTS_DEFAULTS.resettingMost,
  },
  [NAMESPACE_KEYS.iosHostsDiskReserveGiB]: {
    type: "number",
    label: "Disk a host keeps free (GiB)",
    description: "A shared host makes no new slot while it has less free disk than this.",
    group: "ios-hosts",
    default: NAMESPACE_IOS_HOSTS_DEFAULTS.diskReserveGiB,
  },
};

const VERSION = /^[0-9]{2}(\.[0-9x]+)?$/;
const SHAPE = /^([0-9]+)\s*x\s*([0-9]+)$/i;

export function parseMacShape(text: string): MacShape | null {
  const match = SHAPE.exec(text.trim());
  return match ? { cores: Number(match[1]), memoryGB: Number(match[2]) } : null;
}

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

function isRegion(value: string): value is NamespaceRegion {
  return (NAMESPACE_REGIONS as readonly string[]).includes(value);
}

export function parseNamespacePart(part: BackendPart): ParsedBackend<NamespaceConfig> {
  const values = part.fields;
  const problems: FieldProblem[] = [];
  const problem = (path: string, message: string) => problems.push({ path, message });

  const token = text(values, NAMESPACE_KEYS.token);
  if (!token) problem(NAMESPACE_KEYS.token, "Namespace: set the API token, from nsc token create as the guide shows.");
  const region = text(values, NAMESPACE_KEYS.region, NAMESPACE_DEFAULTS.region);
  if (!isRegion(region)) problem(NAMESPACE_KEYS.region, `Namespace: the API region must be ${NAMESPACE_REGIONS.join(" or ")}.`);
  const macosVersion = text(values, NAMESPACE_KEYS.macosVersion, NAMESPACE_DEFAULTS.macosVersion);
  if (!VERSION.test(macosVersion)) problem(NAMESPACE_KEYS.macosVersion, `Namespace: "${macosVersion}" is not a macOS version such as 26.x.`);
  const machines = number(values, NAMESPACE_KEYS.machines, NAMESPACE_DEFAULTS.machines);
  if (!Number.isInteger(machines) || machines < 1) problem(NAMESPACE_KEYS.machines, "Namespace: the most machines must be a whole number, at least 1.");
  const longestLifeHours = number(values, NAMESPACE_KEYS.longestLifeHours, NAMESPACE_DEFAULTS.longestLifeHours);
  if (!(longestLifeHours >= 1 && longestLifeHours <= 24)) problem(NAMESPACE_KEYS.longestLifeHours, "Namespace: the longest life must be from 1 to 24 hours.");

  const largestText = text(values, NAMESPACE_KEYS.largestMachine);
  const largestMachine = largestText ? parseMacShape(largestText) : null;
  if (largestText && !largestMachine) problem(NAMESPACE_KEYS.largestMachine, `Namespace: "${largestText}" is not a machine such as 6x14, cores x memory in GB.`);

  const on = values[NAMESPACE_KEYS.iosHostsOn];
  const mostText = values[NAMESPACE_KEYS.iosHostsMost];
  const most = mostText === undefined || mostText === null || mostText === "" ? null : number(values, NAMESPACE_KEYS.iosHostsMost, NaN);
  if (most !== null && !(Number.isInteger(most) && most >= 1 && most <= 64)) problem(NAMESPACE_KEYS.iosHostsMost, "Namespace: the slots a host lends at most must be a whole number from 1 to 64, or empty.");
  const ahead = number(values, NAMESPACE_KEYS.iosHostsAhead, NAMESPACE_IOS_HOSTS_DEFAULTS.ahead);
  const resettingMost = number(values, NAMESPACE_KEYS.iosHostsResettingMost, NAMESPACE_IOS_HOSTS_DEFAULTS.resettingMost);
  const diskReserveGiB = number(values, NAMESPACE_KEYS.iosHostsDiskReserveGiB, NAMESPACE_IOS_HOSTS_DEFAULTS.diskReserveGiB);
  for (const [key, value, least] of [[NAMESPACE_KEYS.iosHostsAhead, ahead, 0], [NAMESPACE_KEYS.iosHostsResettingMost, resettingMost, 1], [NAMESPACE_KEYS.iosHostsDiskReserveGiB, diskReserveGiB, 0]] as const)
    if (!Number.isInteger(value) || value < least) problem(key, `Namespace: ${key} must be a whole number, at least ${least}.`);
  const iosHosts: NamespaceIosHosts = { on: on === undefined || on === null ? NAMESPACE_IOS_HOSTS_DEFAULTS.on : on === true || on === "true", most, ahead, resettingMost, diskReserveGiB };

  if (problems.length || !isRegion(region)) return { ok: false, problems };
  return { ok: true, config: { token, region, macosVersion, machines, longestLifeHours, largestMachine, iosHosts } };
}
