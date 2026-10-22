import type { BackendPart, FieldDescriptor, FieldProblem, ParsedBackend } from "../types.ts";

export const NAMESPACE_KINDS = ["macos"] as const;
export type NamespaceKind = (typeof NAMESPACE_KINDS)[number];

export const NAMESPACE_REGIONS = ["us", "eu"] as const;
export type NamespaceRegion = (typeof NAMESPACE_REGIONS)[number];

export interface NamespaceConfig {
  readonly token: string;
  readonly region: NamespaceRegion;
  readonly macosVersion: string;
  readonly machines: number;
  readonly longestLifeHours: number;
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
} as const;

export const NAMESPACE_FIELDS: Readonly<Record<string, FieldDescriptor>> = {
  [NAMESPACE_KEYS.token]: {
    type: "string",
    label: "API token",
    description: "A revocable token for the Namespace workspace, from nsc token create, granted the instance actions the guide lists. It is kept as a secret and never shown.",
    group: "connection",
    secret: true,
  },
  [NAMESPACE_KEYS.region]: {
    type: "string",
    label: "API region",
    description: "us or eu: where bb-box calls Namespace's API and its SSH gateway. Where the machines run is the workspace's regional preference, which Namespace's support sets.",
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
    description: "How long the workspace's plan lets a machine live: 3 hours on Developer, 5 on Team, up to 24 on Business. A box ends then, and its thread hears an hour ahead.",
    group: "boxes",
    default: NAMESPACE_DEFAULTS.longestLifeHours,
  },
};

const VERSION = /^[0-9]{2}(\.[0-9x]+)?$/;

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

  if (problems.length || !isRegion(region)) return { ok: false, problems };
  return { ok: true, config: { token, region, macosVersion, machines, longestLifeHours } };
}
