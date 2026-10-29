import type { BackendPart, FieldDescriptor, FieldProblem, ParsedBackend } from "../types.ts";

export const BOAT_TEMPLATE_KINDS = ["linux", "linux-desktop-cpu"] as const;
export type BoatKind = (typeof BOAT_TEMPLATE_KINDS)[number];
export const BOAT_KINDS: readonly BoatKind[] = ["linux"];

export interface BoatConfig {
  readonly key: string;
  readonly mostBoxes: number;
  readonly leaseMinutes: number;
}

export const BOAT_DEFAULTS = {
  mostBoxes: 2,
  leaseMinutes: 30,
} as const;

export const LEASE_MINUTES_RANGE = { least: 10, most: 120 } as const;

export const BOAT_KEYS = {
  key: "api-key",
  mostBoxes: "most-boxes",
  leaseMinutes: "lease-minutes",
} as const;

export const BOAT_FIELDS: Readonly<Record<string, FieldDescriptor>> = {
  [BOAT_KEYS.key]: {
    type: "string",
    label: "API key",
    description:
      "The boat.dev API key bb-box makes and deletes sandboxes with. Make one in boat's dashboard, or with boat api-key create, starting boat_. A key that expires stops bb-box's boxes there when it does. It is kept as a secret and never shown.",
    secret: true,
    group: "credentials",
  },
  [BOAT_KEYS.mostBoxes]: {
    type: "number",
    label: "Most boxes",
    description:
      "The most boat sandboxes bb-box runs at once, a template being built included. Each box is one sandbox, billed by the second while it runs: $0.018 an hour for 2 cores and 4 GB, $0.036 for 4 and 8, $0.072 for 8 and 16. A stopped box costs nothing. The free trial allows 2 at once.",
    group: "boxes",
    default: BOAT_DEFAULTS.mostBoxes,
  },
  [BOAT_KEYS.leaseMinutes]: {
    type: "number",
    label: "Auto-stop (minutes)",
    description:
      "How long a box runs on after bb-box last renewed it. bb-box renews each box it holds every few minutes, so a box stops this long after bb-box stops for good, and keeps its disk. From 10 to 120: the free trial allows at most 120.",
    group: "advanced",
    default: BOAT_DEFAULTS.leaseMinutes,
  },
};

function text(values: Readonly<Record<string, unknown>>, key: string): string {
  const value = values[key];
  return typeof value === "string" ? value.trim() : "";
}

function number(values: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const value = values[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

export function parseBoatPart(part: BackendPart): ParsedBackend<BoatConfig> {
  const values = part.fields;
  const problems: FieldProblem[] = [];
  const problem = (path: string, message: string) => problems.push({ path, message });
  const key = text(values, BOAT_KEYS.key);
  if (!key) problem(BOAT_KEYS.key, "boat.dev: set the API key, from boat's dashboard or boat api-key create.");
  else if (!/^(boat|box)_[A-Za-z0-9_-]+$/.test(key)) problem(BOAT_KEYS.key, "boat.dev: an API key starts with boat_, as boat's dashboard shows it.");
  const mostBoxes = number(values, BOAT_KEYS.mostBoxes, BOAT_DEFAULTS.mostBoxes);
  if (!Number.isInteger(mostBoxes) || mostBoxes < 1) problem(BOAT_KEYS.mostBoxes, "boat.dev: the most boxes must be a whole number, at least 1.");
  const leaseMinutes = number(values, BOAT_KEYS.leaseMinutes, BOAT_DEFAULTS.leaseMinutes);
  if (!Number.isInteger(leaseMinutes) || leaseMinutes < LEASE_MINUTES_RANGE.least || leaseMinutes > LEASE_MINUTES_RANGE.most)
    problem(BOAT_KEYS.leaseMinutes, `boat.dev: the auto-stop must be a whole number of minutes from ${LEASE_MINUTES_RANGE.least} to ${LEASE_MINUTES_RANGE.most}.`);
  if (problems.length) return { ok: false, problems };
  return { ok: true, config: { key, mostBoxes, leaseMinutes } };
}
