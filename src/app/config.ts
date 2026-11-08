// Pure helpers for the settings page: reading the configuration state the
// server gives, and building the drafts the page sends back (029).

import type { MachineSize, FieldValue, GpuPart, WarmShortfall } from "../backends/types.ts";
import type { BackendConfig, ConfigDocument, KindConfig, Problem, SecretState, SnapshotSettings } from "../core/document.ts";
import type { Preset } from "../core/sizes.ts";
import type { ConfigState, FieldView } from "../plugin/configuration.ts";

export const PRESET_NAMES: readonly Preset[] = ["small", "medium", "large"];
export const PRESET_LABELS: Readonly<Record<Preset, string>> = { small: "Small", medium: "Medium", large: "Large" };

export type FieldGroup = FieldView["group"];
export const GROUPS: readonly { readonly id: FieldGroup; readonly title: string }[] = [
  { id: "connection", title: "Connection" },
  { id: "credentials", title: "Credentials" },
  { id: "boxes", title: "Boxes" },
  { id: "gpus", title: "GPUs" },
  { id: "ios-hosts", title: "Shared iOS hosts" },
  { id: "advanced", title: "Advanced" },
];

export function isSecretField(field: FieldView): boolean {
  return field.type === "string" && field.secret === true;
}

export function isSecretState(value: unknown): value is SecretState {
  return typeof value === "object" && value !== null && "set" in value && typeof (value as SecretState).set === "boolean";
}

/** The fields of each group, in the driver's order; groups with none are left out. */
export function groupFields(fields: readonly FieldView[]): { readonly id: FieldGroup; readonly title: string; readonly fields: FieldView[] }[] {
  return GROUPS.map((group) => ({ ...group, fields: fields.filter((field) => field.group === group.id && !field.replacedBy) })).filter((group) => group.fields.length > 0);
}

/** Problems at a path, or under it. */
export function problemsUnder(problems: readonly Problem[], path: string): Problem[] {
  return problems.filter((problem) => problem.path === path || problem.path.startsWith(`${path}.`));
}

/** The first problem at exactly a path. */
export function problemAt(problems: readonly Problem[], path: string): string | null {
  return problems.find((problem) => problem.path === path)?.message ?? null;
}

/** Problems under a path that no field of the form shows. */
export function problemsLeft(problems: readonly Problem[], path: string, shown: readonly string[]): Problem[] {
  return problemsUnder(problems, path).filter((problem) => !shown.includes(problem.path));
}

export interface KindSizes {
  readonly enabled: boolean;
  readonly presets: Readonly<Record<Preset, MachineSize>>;
  readonly default: Preset;
  readonly largest: MachineSize;
  /** Spare boxes to keep (032). */
  readonly spares: number;
  readonly gpu: GpuPart | null;
}

/** A kind's sizes as they are: the shipped defaults with the document's changes. */
export function effectiveKind(state: ConfigState, id: string): KindSizes {
  const shipped = state.defaults.kinds[id];
  const change = state.document.kinds[id];
  const presets = {} as Record<Preset, MachineSize>;
  for (const preset of PRESET_NAMES) {
    const base = shipped?.presets[preset] ?? { cores: 2, memoryMiB: 4096, diskGiB: null };
    const part = change?.presets?.[preset];
    presets[preset] = { cores: part?.cores ?? base.cores, memoryMiB: part?.memoryMiB ?? base.memoryMiB, diskGiB: part?.diskGiB === undefined ? base.diskGiB : part.diskGiB };
  }
  const largestBase = shipped?.largest ?? { cores: 16, memoryMiB: 32768, diskGiB: 256 };
  return {
    enabled: change?.enabled ?? shipped?.enabled ?? true,
    presets,
    default: change?.default ?? shipped?.default ?? "small",
    largest: {
      cores: change?.largest?.cores ?? largestBase.cores,
      memoryMiB: change?.largest?.memoryMiB ?? largestBase.memoryMiB,
      diskGiB: change?.largest?.diskGiB ?? largestBase.diskGiB,
    },
    spares: change?.spares ?? 0,
    gpu: change?.gpu ?? null,
  };
}

/** The kind's entry for the document: only what differs from the shipped defaults, or undefined when nothing does. */
export function kindChanges(state: ConfigState, id: string, sizes: KindSizes): KindConfig | undefined {
  const shipped = state.defaults.kinds[id];
  const entry: { enabled?: boolean; presets?: Partial<Record<Preset, MachineSize>>; default?: Preset; largest?: MachineSize; spares?: number; gpu?: GpuPart } = {};
  if (!sizes.enabled) entry.enabled = false;
  if (sizes.spares) entry.spares = sizes.spares;
  if (sizes.gpu) entry.gpu = sizes.gpu;
  if (shipped) {
    const presets: Partial<Record<Preset, MachineSize>> = {};
    for (const preset of PRESET_NAMES) {
      const base = shipped.presets[preset];
      const size = sizes.presets[preset];
      if (size.cores !== base.cores || size.memoryMiB !== base.memoryMiB || size.diskGiB !== base.diskGiB) presets[preset] = size;
    }
    if (Object.keys(presets).length) entry.presets = presets;
    if (sizes.default !== shipped.default) entry.default = sizes.default;
    const largest = sizes.largest;
    if (largest.cores !== shipped.largest.cores || largest.memoryMiB !== shipped.largest.memoryMiB || largest.diskGiB !== shipped.largest.diskGiB) entry.largest = largest;
  } else {
    entry.presets = sizes.presets;
    entry.default = sizes.default;
    entry.largest = sizes.largest;
  }
  return Object.keys(entry).length ? entry : undefined;
}

/** "2 cores · 4 GiB · the image's own disk". */
export function sizeWords(size: MachineSize): string {
  return [`${size.cores} ${size.cores === 1 ? "core" : "cores"}`, `${gib(size.memoryMiB)} GiB`, size.diskGiB === null ? "the image's own disk" : `${size.diskGiB} GiB`].join(" · ");
}

/** Memory in GiB with at most one decimal, for fields. */
export function gib(memoryMiB: number): number {
  return Math.round((memoryMiB / 1024) * 10) / 10;
}

export function mib(memoryGiB: number): number {
  return Math.round(memoryGiB * 1024);
}

/** A backend's entry as the page sends it: a secret may be a new value, kept, or null to clear it. */
export type DraftBackend = Omit<BackendConfig, "fields"> & { readonly fields: Readonly<Record<string, FieldValue | SecretState | null>> };

/** The document with one backend replaced, or added at the end. A draft entry's cleared secrets go to the server as null. */
export function withBackend(document: ConfigDocument, backend: BackendConfig | DraftBackend): ConfigDocument {
  const entry = backend as BackendConfig;
  const present = document.backends.some((candidate) => candidate.id === entry.id);
  return { ...document, backends: present ? document.backends.map((candidate) => (candidate.id === entry.id ? entry : candidate)) : [...document.backends, entry] };
}

export function withoutBackend(document: ConfigDocument, id: string): ConfigDocument {
  return { ...document, backends: document.backends.filter((candidate) => candidate.id !== id) };
}

/** The document with one kind's entry set, or removed when undefined. */
export function withKind(document: ConfigDocument, id: string, config: KindConfig | undefined): ConfigDocument {
  const kinds = { ...document.kinds };
  if (config) kinds[id] = config;
  else delete kinds[id];
  return { ...document, kinds };
}

export function withGeneral(document: ConfigDocument, patch: Partial<ConfigDocument["general"]>): ConfigDocument {
  const general: Record<string, unknown> = { ...document.general, ...patch };
  for (const key of Object.keys(general)) if (general[key] === undefined) delete general[key];
  return { ...document, general };
}

export function withSnapshots(document: ConfigDocument, patch: Partial<SnapshotSettings>): ConfigDocument {
  const snapshots: Record<string, unknown> = { ...document.general.snapshots, ...patch };
  for (const key of Object.keys(snapshots)) if (snapshots[key] === undefined) delete snapshots[key];
  return withGeneral(document, { snapshots: Object.keys(snapshots).length ? (snapshots as SnapshotSettings) : undefined });
}

export function withCeiling(document: ConfigDocument, backendId: string, ceiling: number | undefined): ConfigDocument {
  const ceilings: Record<string, number> = { ...document.general.snapshots?.ceilings };
  if (ceiling === undefined) delete ceilings[backendId];
  else ceilings[backendId] = ceiling;
  return withSnapshots(document, { ceilings: Object.keys(ceilings).length ? ceilings : undefined });
}

export function withMonitor(document: ConfigDocument, patch: Partial<NonNullable<ConfigDocument["monitor"]>>): ConfigDocument {
  const monitor: Record<string, unknown> = { ...document.monitor, ...patch };
  for (const key of Object.keys(monitor)) if (monitor[key] === undefined) delete monitor[key];
  const { monitor: _previous, ...rest } = document;
  return Object.keys(monitor).length ? { ...rest, monitor } : rest;
}

/** A backend's warm count for a kind, as the document has it. */
export function warmOf(backend: BackendConfig | undefined, kind: string): number {
  return backend?.warm?.[kind] ?? 0;
}

/**
 * How the settings page tells the operator a backend's warm pool is short of
 * its count for want of room (#356), in its voice: "Has 0 of 1 ready: no room.
 * <reason>". A shortfall is always a room problem, so "no room" leads, then
 * the backend's own reason gives the specifics.
 */
export function warmShortWords(short: WarmShortfall): string {
  return `Has ${short.have} of ${short.count} ready: no room. ${short.reason}`;
}

/** What a field's control holds while the form is open. A secret is kept, replaced by a string, or cleared by null. */
export type FormValue = FieldValue | SecretState | null;

/** The value a field's control shows: the set value, else empty, with the default as the placeholder. */
export function formValue(fields: Readonly<Record<string, FieldValue | SecretState>>, field: FieldView): FormValue {
  const value = fields[field.key];
  if (value === undefined) return isSecretField(field) ? { set: false } : field.type === "boolean" ? (field.default ?? false) : "";
  return value;
}

function isEmpty(value: FormValue | undefined): boolean {
  return value === undefined || value === null || (typeof value === "string" && !value.trim()) || (isSecretState(value) && !value.set);
}

/** The backend a driver's empty fields take values from, as the server picks it: the first other backend of the type they name. */
/**
 * How the page names `source`, the backend a form's empty fields take from:
 * by its driver's label, as "from Proxmox LXC", unless the configuration has
 * more than one backend of its type, when by its own label or ID (#197).
 */
export function sourceName(document: ConfigDocument, source: BackendConfig, typeLabel: string): string {
  const several = document.backends.filter((backend) => backend.type === source.type).length > 1;
  return several ? (source.label ?? source.id) : typeLabel;
}

export function inheritSource(document: ConfigDocument, fields: readonly FieldView[], id: string): BackendConfig | null {
  const from = fields.find((field) => field.inherits)?.inherits?.from;
  return (from && document.backends.find((other) => other.type === from && other.id !== id)) || null;
}

/**
 * What the form's empty fields take from `source`, the backend their driver
 * inherits from, as the server fills them in: for each set all empty in
 * `values`, the source's values, or whether its secrets are set. Only values
 * the source has are given.
 */
export function inheritedValues(fields: readonly FieldView[], values: Readonly<Record<string, FormValue>>, source: BackendConfig | null): Record<string, FieldValue | SecretState> {
  const out: Record<string, FieldValue | SecretState> = {};
  if (!source) return out;
  for (const field of fields) {
    if (!field.inherits || field.inherits.from !== source.type) continue;
    if (!field.inherits.set.every((key) => isEmpty(values[key]))) continue;
    const value = source.fields[field.key];
    if (!isEmpty(value)) out[field.key] = value!;
  }
  return out;
}

/**
 * The fields for the draft: empty text takes the default, but stays empty where empty turns boxes off and `stored` has
 * the field, so a field saved or cleared to off stays off. Numbers are numbers, and secrets go as the control holds them.
 */
export function draftFields(values: Readonly<Record<string, FormValue>>, fields: readonly FieldView[], stored: Readonly<Record<string, unknown>> = {}): Record<string, FieldValue | SecretState | null> {
  const out: Record<string, FieldValue | SecretState | null> = {};
  for (const field of fields) {
    const value = values[field.key];
    if (value === undefined) continue;
    if (isSecretField(field)) {
      if (value === null || typeof value === "string" || isSecretState(value)) out[field.key] = value === "" ? { set: false } : value;
      continue;
    }
    if (value === null || isSecretState(value)) continue;
    if (field.type === "number") {
      const text = String(value).trim();
      if (text === "") continue;
      const number = Number(text);
      out[field.key] = Number.isFinite(number) ? number : (value as FieldValue);
      continue;
    }
    if (field.type === "boolean") {
      if (typeof value === "boolean" && value !== (field.default ?? false)) out[field.key] = value;
      continue;
    }
    if (typeof value === "string" && value.trim() === "") {
      if (field.offWhenEmpty && typeof stored[field.key] === "string") out[field.key] = "";
      continue;
    }
    out[field.key] = value as FieldValue;
  }
  return out;
}
