// Box sizes (028). Each kind has the presets small, medium and large, a
// default preset and a largest custom size, the same on every offer of the
// kind. bb-box ships them below, and the box-sizes setting changes them per
// kind. A box is made at a preset or a custom size, where any part left out
// comes from the preset, or else the default preset.

import { currentKindId, isEarlierKindId } from "../backends/kinds.ts";
import type { BoxSize } from "../backends/types.ts";

export const PRESETS = ["small", "medium", "large"] as const;
export type Preset = (typeof PRESETS)[number];

export interface KindSizes {
  /** Presets leave the disk at the base, unless the box-sizes setting gives one. */
  readonly presets: Readonly<Record<Preset, BoxSize>>;
  /** The preset a box gets when none is asked for. */
  readonly default: Preset;
  /** The largest custom size. Its disk is always a number. */
  readonly largest: BoxSize;
}

function size(cores: number, memoryGiB: number, diskGiB: number | null = null): BoxSize {
  return { cores, memoryMiB: memoryGiB * 1024, diskGiB };
}

const LINUX: KindSizes = {
  presets: { small: size(2, 4), medium: size(4, 8), large: size(8, 16) },
  default: "small",
  largest: size(16, 32, 256),
};

const DESKTOP: KindSizes = {
  presets: { small: size(4, 8), medium: size(8, 16), large: size(16, 32) },
  default: "small",
  largest: size(32, 64, 256),
};

/**
 * macOS VMs on a Mac, where at most two run, so the presets leave room for a
 * second. For now Tart refuses a disk of a box's own: a box keeps its image's.
 */
const MACOS: KindSizes = {
  presets: { small: size(4, 8), medium: size(6, 16), large: size(8, 32) },
  default: "small",
  largest: size(16, 64, 256),
};

/** What bb-box ships, by kind. A kind with none takes linux's until its backend brings its own. */
const SHIPPED: Readonly<Record<string, KindSizes>> = {
  linux: LINUX,
  "linux-docker": LINUX,
  "linux-desktop": DESKTOP,
  "linux-desktop-cpu": DESKTOP,
  macos: MACOS,
  "macos-desktop": MACOS,
};

/** Part of a size in the box-sizes setting. A disk of null is the base. */
export interface SizeChange {
  readonly cores?: number;
  readonly memoryMiB?: number;
  readonly diskGiB?: number | null;
}

/** One kind's entry in the box-sizes setting. Every part is optional. */
export interface KindSizesChange {
  readonly default?: Preset;
  readonly small?: SizeChange;
  readonly medium?: SizeChange;
  readonly large?: SizeChange;
  readonly largest?: SizeChange;
}

/** The box-sizes setting, by current kind ID. */
export type SizeChanges = Readonly<Record<string, KindSizesChange>>;

/** The sizes of a kind: what bb-box ships, changed by the box-sizes setting. */
export function kindSizes(kind: string, changes: SizeChanges = {}): KindSizes {
  const id = currentKindId(kind);
  return apply(SHIPPED[id] ?? LINUX, changes[id]);
}

/** A kind's presets, smallest first: by cores, then memory. */
export function presetSizes(sizes: KindSizes): BoxSize[] {
  return PRESETS.map((preset) => sizes.presets[preset]).sort((a, b) => a.cores - b.cores || a.memoryMiB - b.memoryMiB);
}

/** The size a box of a kind gets when none is asked for. */
export function defaultSize(sizes: KindSizes): BoxSize {
  return sizes.presets[sizes.default];
}

function apply(sizes: KindSizes, change: KindSizesChange | undefined): KindSizes {
  if (!change) return sizes;
  const changed = (base: BoxSize, part: SizeChange | undefined): BoxSize => ({
    cores: part?.cores ?? base.cores,
    memoryMiB: part?.memoryMiB ?? base.memoryMiB,
    diskGiB: part?.diskGiB === undefined ? base.diskGiB : part.diskGiB,
  });
  return {
    presets: {
      small: changed(sizes.presets.small, change.small),
      medium: changed(sizes.presets.medium, change.medium),
      large: changed(sizes.presets.large, change.large),
    },
    default: change.default ?? sizes.default,
    largest: changed(sizes.largest, change.largest),
  };
}

const PARTS = new Set(["default", "largest", ...PRESETS]);
const FIELDS = new Set(["cores", "memoryMiB", "diskGiB"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWhole(value: unknown, least: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= least;
}

function readChange(kind: string, part: string, value: unknown, problems: string[]): SizeChange | undefined {
  if (!isRecord(value)) {
    problems.push(`${kind}.${part} must be an object with cores, memoryMiB and diskGiB.`);
    return undefined;
  }
  const unknown = Object.keys(value).filter((field) => !FIELDS.has(field));
  if (unknown.length) problems.push(`${kind}.${part} has ${unknown.join(", ")}; use cores, memoryMiB and diskGiB.`);
  if (value.cores !== undefined && !isWhole(value.cores, 1)) problems.push(`${kind}.${part}.cores must be a whole number of at least 1.`);
  if (value.memoryMiB !== undefined && !isWhole(value.memoryMiB, 256)) problems.push(`${kind}.${part}.memoryMiB must be a whole number of at least 256.`);
  const disk = value.diskGiB;
  if (disk !== undefined && !(disk === null && part !== "largest") && !isWhole(disk, 1)) {
    problems.push(`${kind}.${part}.diskGiB must be a whole number of at least 1${part === "largest" ? "" : ", or null for the base disk"}.`);
  }
  return value as SizeChange;
}

function readKind(kind: string, value: unknown, problems: string[]): KindSizesChange | undefined {
  if (!isRecord(value)) {
    problems.push(`${kind} must be an object with default, small, medium, large or largest.`);
    return undefined;
  }
  const before = problems.length;
  const unknown = Object.keys(value).filter((part) => !PARTS.has(part));
  if (unknown.length) problems.push(`${kind} has ${unknown.join(", ")}; use default, small, medium, large and largest.`);
  if (value.default !== undefined && !PRESETS.includes(value.default as Preset)) {
    problems.push(`${kind}.default must be small, medium or large.`);
  }
  for (const part of ["largest", ...PRESETS]) {
    if (value[part] !== undefined) readChange(kind, part, value[part], problems);
  }
  if (problems.length > before) return undefined;
  const change = value as KindSizesChange;
  const sizes = apply(SHIPPED[kind] ?? LINUX, change);
  for (const preset of PRESETS) {
    if (!fits(sizes.presets[preset], sizes.largest)) {
      problems.push(`${kind}'s ${preset} preset, ${describeSize(sizes.presets[preset])}, is above its largest size, ${describeSize(sizes.largest)}.`);
    }
  }
  return problems.length > before ? undefined : change;
}

/**
 * Reads the box-sizes setting: JSON with an entry per kind. A kind whose
 * entry has a problem keeps the shipped sizes, and the problem is returned
 * for the doctor.
 */
export function parseSizeChanges(raw: unknown): { changes: SizeChanges; problems: string[] } {
  if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) return { changes: {}, problems: [] };
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch (error) {
      return { changes: {}, problems: [`Box sizes is not JSON: ${error instanceof Error ? error.message : String(error)}.`] };
    }
  }
  if (!isRecord(value)) return { changes: {}, problems: ["Box sizes must be a JSON object with an entry per kind, such as linux."] };
  const problems: string[] = [];
  const changes: Record<string, KindSizesChange> = {};
  // An earlier kind ID counts only when the current one has no entry.
  const keys = Object.keys(value).sort((a, b) => Number(isEarlierKindId(b)) - Number(isEarlierKindId(a)));
  for (const key of keys) {
    const kind = currentKindId(key);
    const change = readKind(kind, value[key], problems);
    if (change) changes[kind] = change;
  }
  return { changes, problems };
}

/**
 * The box-sizes setting with `earlier` sizes, by kind, as the default preset
 * of each kind that has no entry yet: how sizes saved before 028 carry over.
 * Any larger preset, and the largest, grows to at least that size. Null when
 * nothing changes: every such kind has an entry or was the shipped default,
 * or the setting is not a JSON object, which is left for its owner to fix.
 */
export function withEarlierSizes(raw: unknown, earlier: Readonly<Record<string, BoxSize>>): string | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  let value: unknown = {};
  if (text) {
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;
  const entries: Record<string, unknown> = { ...value };
  const listed = new Set(Object.keys(entries).map(currentKindId));
  let changed = false;
  for (const [kind, size] of Object.entries(earlier)) {
    if (listed.has(kind)) continue;
    const shipped = kindSizes(kind);
    if (sameSize(size, defaultSize(shipped))) continue;
    const change: Record<string, SizeChange> = {};
    for (const preset of PRESETS.slice(PRESETS.indexOf(shipped.default))) {
      const part = changeTo(shipped.presets[preset], size, preset === shipped.default);
      if (part) change[preset] = part;
    }
    const largest = changeTo(shipped.largest, size, false);
    if (largest) change.largest = largest;
    entries[kind] = change;
    changed = true;
  }
  return changed ? JSON.stringify(entries, null, 2) : null;
}

/** The parts of `base` that change for it to be `size`, or with `exact` false, at least `size`. Null when none do. */
function changeTo(base: BoxSize, size: BoxSize, exact: boolean): SizeChange | null {
  const change: { cores?: number; memoryMiB?: number; diskGiB?: number | null } = {};
  if (exact ? size.cores !== base.cores : size.cores > base.cores) change.cores = size.cores;
  if (exact ? size.memoryMiB !== base.memoryMiB : size.memoryMiB > base.memoryMiB) change.memoryMiB = size.memoryMiB;
  const disk = exact ? size.diskGiB !== base.diskGiB : size.diskGiB !== null && (base.diskGiB === null || size.diskGiB > base.diskGiB);
  if (disk) change.diskGiB = size.diskGiB;
  return Object.keys(change).length ? change : null;
}

/** Whether `size` is at most `limit` in every part. A disk of null is the base, which fits. */
export function fits(size: BoxSize, limit: BoxSize): boolean {
  const disk = size.diskGiB === null || limit.diskGiB === null || size.diskGiB <= limit.diskGiB;
  return size.cores <= limit.cores && size.memoryMiB <= limit.memoryMiB && disk;
}

export function sameSize(a: BoxSize, b: BoxSize): boolean {
  return a.cores === b.cores && a.memoryMiB === b.memoryMiB && a.diskGiB === b.diskGiB;
}

/** What a box is asked to be: a preset, and any parts that differ from it. */
export interface SizeRequest {
  readonly preset?: string;
  readonly cores?: number;
  readonly memoryGiB?: number;
  readonly diskGiB?: number;
}

export type SizeChoice = { readonly ok: true; readonly size: BoxSize } | { readonly ok: false; readonly message: string };

/**
 * The size a request asks for, complete: parts left out come from the named
 * preset, or else the default preset. Refuses an unknown preset, a part that
 * is not a whole number of at least 1, and a size above the largest.
 */
export function chooseSize(kind: string, sizes: KindSizes, request: SizeRequest = {}): SizeChoice {
  const presets = `Its presets are ${describePresets(sizes)}`;
  const largest = `the largest is ${describeSize(sizes.largest)}`;
  const name = request.preset?.trim().toLowerCase() || sizes.default;
  if (!PRESETS.includes(name as Preset)) {
    return { ok: false, message: `There is no "${request.preset}" size for a ${kind} box. ${presets}, and ${largest}.` };
  }
  const parts = [request.cores, request.memoryGiB, request.diskGiB];
  if (parts.some((part) => part !== undefined && !isWhole(part, 1))) {
    return { ok: false, message: "Give cores, memory in GiB and disk in GiB as whole numbers of at least 1." };
  }
  const base = sizes.presets[name as Preset];
  const chosen: BoxSize = {
    cores: request.cores ?? base.cores,
    memoryMiB: request.memoryGiB !== undefined ? request.memoryGiB * 1024 : base.memoryMiB,
    diskGiB: request.diskGiB ?? base.diskGiB,
  };
  if (!fits(chosen, sizes.largest)) {
    return { ok: false, message: `A ${kind} box can be at most ${describeSize(sizes.largest)}, not ${describeSize(chosen)}. ${presets}.` };
  }
  return { ok: true, size: chosen };
}

/** For example "4 cores, 8 GiB memory, 32 GiB disk". A disk of null, the base, is left out. */
export function describeSize(size: BoxSize): string {
  const parts = [`${size.cores} ${size.cores === 1 ? "core" : "cores"}`, `${formatMiB(size.memoryMiB)} memory`];
  if (size.diskGiB !== null) parts.push(`${size.diskGiB} GiB disk`);
  return parts.join(", ");
}

/** For example "small (2 cores, 4 GiB memory, the default), medium (...) and large (...)". */
export function describePresets(sizes: KindSizes): string {
  const each = PRESETS.map((preset) => `${preset} (${describeSize(sizes.presets[preset])}${preset === sizes.default ? ", the default" : ""})`);
  return `${each.slice(0, -1).join(", ")} and ${each.at(-1)}`;
}

function formatMiB(value: number): string {
  if (value < 1024) return `${Math.round(value)} MiB`;
  return `${(value / 1024).toFixed(1).replace(/\.0$/, "")} GiB`;
}
