import { pathProblem, type BoxFileSetting } from "../core/box-files.ts";
import { SNAPSHOT_DEFAULTS, ceilingOf, snapshotConfig, type BackendConfig, type ConfigDocument, type HostConfig, type ImageBake, type ImageConfig, type Problem } from "../core/document.ts";
import { withImage } from "../core/project-images.ts";
import { isGpuPart } from "../core/gpu.ts";
import type { TailnetSetting } from "../core/tailnet-settings.ts";
import type { FieldValue } from "../backends/types.ts";
import type { Preset } from "../core/sizes.ts";
import type { ConfigState, FieldView } from "../plugin/configuration.ts";
import { effectiveKind, isSecretField, isSecretState, kindChanges, mib, PRESET_LABELS, PRESET_NAMES, withBackend, withCeiling, withGeneral, withKind, withMonitor, withSnapshots, withoutBackend, type KindSizes } from "./config.ts";

export type Path = string;
export type PlainValue = string | number | boolean | null;

export type EditValue =
  | { readonly kind: "plain"; readonly value: PlainValue }
  | { readonly kind: "secret"; readonly text: string | null }
  | { readonly kind: "new-file"; readonly path: string; readonly text: string | null }
  | { readonly kind: "new-host"; readonly name: string; readonly enabled: boolean }
  | { readonly kind: "new-backend"; readonly type: string; readonly id: string; readonly enabled: boolean }
  | { readonly kind: "removed" };

export type Stored = { readonly kind: "value"; readonly value: PlainValue } | { readonly kind: "version"; readonly version: number | null } | { readonly kind: "gone" };

export interface Edit {
  readonly value: EditValue;
  readonly base: Stored;
}

export interface PathEdit extends Edit {
  readonly path: Path;
}

export type Conflict =
  | { readonly kind: "changed"; readonly stored: PlainValue }
  | { readonly kind: "replaced"; readonly version: number }
  | { readonly kind: "added"; readonly version: number }
  | { readonly kind: "removed" }
  | { readonly kind: "taken"; readonly id: string };

export interface DraftProblem {
  readonly path: Path;
  readonly message: string;
}

export interface Candidate {
  readonly document: ConfigDocument;
  readonly conflicts: readonly Path[];
  readonly needed: boolean;
  readonly sentAs: Readonly<Record<string, Path>>;
}

const NEW_MARK = "@new-";
const FILES = "files/";
const HOST_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function plain(value: PlainValue): EditValue {
  return { kind: "plain", value };
}

export function filePath(path: string): Path {
  return `${FILES}${encodeURIComponent(path)}`;
}

export function newFilePath(id: string): Path {
  return `${FILES}${NEW_MARK}${id}`;
}

export function backendPath(id: string): Path {
  return `backends/${id}`;
}

export function newBackendPath(type: string, mark: string): Path {
  return backendPath(`${type}${NEW_MARK}${mark}`);
}

export function isNewBackendId(id: string): boolean {
  return id.includes(NEW_MARK);
}

export function typeOfBackendId(id: string): string {
  return id.split(/[:@]/)[0]!;
}

export function freeBackendId(document: ConfigDocument, type: string, several: boolean): string {
  const taken = (id: string) => document.backends.some((backend) => backend.id === id);
  if (!several || !taken(type)) return type;
  let number = 2;
  while (taken(`${type}:${number}`)) number += 1;
  return `${type}:${number}`;
}

export function backendFieldPath(id: string, key: string): Path {
  return `backends/${id}/fields/${key}`;
}

export function hostPath(id: string, name: string): Path {
  return `backends/${id}/hosts/${name}`;
}

export function newHostPath(id: string, mark: string): Path {
  return hostPath(id, `${NEW_MARK}${mark}`);
}

export function hostFieldPath(host: Path, key: string): Path {
  return `${host}/fields/${key}`;
}

export function backendLabelPath(id: string): Path {
  return `backends/${id}/label`;
}

export function backendEnabledPath(id: string): Path {
  return `backends/${id}/enabled`;
}

export function hostEnabledPath(host: Path): Path {
  return `${host}/enabled`;
}

export type TailnetKey = "mode" | "tags" | "clientId" | "clientSecret";

const TAILNET = "general/tailnet/";
const TAILNET_KEYS: readonly TailnetKey[] = ["mode", "tags", "clientId", "clientSecret"];

export function tailnetPath(key: TailnetKey): Path {
  return `${TAILNET}${key}`;
}

export function tailnetKeyOf(path: Path): TailnetKey | null {
  if (!path.startsWith(TAILNET)) return null;
  const key = path.slice(TAILNET.length);
  return (TAILNET_KEYS as readonly string[]).includes(key) ? (key as TailnetKey) : null;
}

export function isTailnetSecret(key: TailnetKey | null): key is "clientId" | "clientSecret" {
  return key === "clientId" || key === "clientSecret";
}

export function tagsFromText(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((tag) => tag.trim()).filter(Boolean))];
}

export function isProvisional(path: Path): boolean {
  return path.includes(NEW_MARK);
}

export function isFilePath(path: Path): boolean {
  return path.startsWith(FILES) && !path.slice(FILES.length).includes("/");
}

export function fileOfPath(path: Path): string | null {
  if (!isFilePath(path) || isProvisional(path)) return null;
  return decodeURIComponent(path.slice(FILES.length));
}

export type BackendAt =
  | { readonly at: "backend"; readonly id: string }
  | { readonly at: "enabled"; readonly id: string }
  | { readonly at: "label"; readonly id: string }
  | { readonly at: "field"; readonly id: string; readonly key: string }
  | { readonly at: "warm"; readonly id: string; readonly kind: string }
  | { readonly at: "host"; readonly id: string; readonly host: string }
  | { readonly at: "host-name"; readonly id: string; readonly host: string }
  | { readonly at: "host-enabled"; readonly id: string; readonly host: string }
  | { readonly at: "host-field"; readonly id: string; readonly host: string; readonly key: string };

export function backendAt(path: Path): BackendAt | null {
  const [section, id, ...rest] = path.split("/");
  if (section !== "backends" || !id) return null;
  if (!rest.length) return { at: "backend", id };
  if (rest.length === 1 && rest[0] === "enabled") return { at: "enabled", id };
  if (rest.length === 1 && rest[0] === "label") return { at: "label", id };
  if (rest.length === 2 && rest[0] === "fields" && rest[1]) return { at: "field", id, key: rest[1] };
  if (rest.length === 2 && rest[0] === "warm" && rest[1]) return { at: "warm", id, kind: rest[1] };
  if (rest[0] !== "hosts" || !rest[1]) return null;
  const host = rest[1];
  const tail = rest.slice(2);
  if (!tail.length) return { at: "host", id, host };
  if (tail.length === 1 && tail[0] === "name") return { at: "host-name", id, host };
  if (tail.length === 1 && tail[0] === "enabled") return { at: "host-enabled", id, host };
  if (tail.length === 2 && tail[0] === "fields" && tail[1]) return { at: "host-field", id, host, key: tail[1] };
  return null;
}

export function imagePath(name: string): Path {
  return `images/${name}`;
}

export function imageBakePath(name: string): Path {
  return `images/${name}/bake`;
}

export function standardImagePath(name: string): Path {
  return `standard-images/${name}`;
}

export function imageDefinitionPath(name: string): Path {
  return `images/${name}/definition`;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, each: unknown) => (each && typeof each === "object" && !Array.isArray(each) ? Object.fromEntries(Object.entries(each).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : each));
}

export type ImageAt = { readonly at: "image"; readonly name: string } | { readonly at: "bake"; readonly name: string } | { readonly at: "definition"; readonly name: string };

export function imageAt(path: Path): ImageAt | null {
  const [section, name, ...rest] = path.split("/");
  if (section !== "images" || !name) return null;
  if (!rest.length) return { at: "image", name };
  if (rest.length === 1 && rest[0] === "bake") return { at: "bake", name };
  if (rest.length === 1 && rest[0] === "definition") return { at: "definition", name };
  return null;
}

function storedAtImage(document: ConfigDocument, at: ImageAt): Stored {
  const image = document.images?.[at.name];
  if (!image) return { kind: "gone" };
  if (at.at === "definition") return { kind: "value", value: canonicalJson(image) };
  return at.at === "image" ? { kind: "value", value: true } : { kind: "value", value: image.bake ?? "auto" };
}

function definedImage(value: PlainValue): ImageConfig | null {
  if (typeof value !== "string") return null;
  try {
    const image = JSON.parse(value) as ImageConfig | null;
    return image && typeof image === "object" ? image : null;
  } catch {
    return null;
  }
}

function withImageEdits(state: ConfigState, input: ConfigDocument, edits: readonly PathEdit[]): Built {
  let document = input;
  let needed = false;
  for (const edit of edits) {
    const at = imageAt(edit.path);
    if (at?.at === "definition" && edit.value.kind === "plain") {
      const image = definedImage(edit.value.value);
      if (!image) continue;
      document = withImage(document, at.name, image);
      if (isChange(state, edit)) needed = true;
      continue;
    }
    const image = at ? document.images?.[at.name] : undefined;
    if (!at || !image) continue;
    if (at.at === "image" && edit.value.kind === "removed") {
      document = withImage(document, at.name, null);
      needed = true;
    } else if (at.at === "bake" && edit.value.kind === "plain" && typeof edit.value.value === "string") {
      const { bake: _bake, ...rest } = image;
      document = withImage(document, at.name, edit.value.value === "auto" ? rest : { ...rest, bake: edit.value.value as ImageBake });
      if (isChange(state, edit)) needed = true;
    }
  }
  return { document, sentAs: {}, needed };
}

export const BACKEND_ORDER_PATH: Path = "order/backends";

export function orderValue(ids: readonly string[]): string {
  return ids.join(" ");
}

function storedOrder(document: ConfigDocument): Stored {
  return { kind: "value", value: orderValue(document.backends.map((backend) => backend.id)) };
}

function withOrderEdit(state: ConfigState, input: ConfigDocument, edits: readonly PathEdit[]): Built {
  const edit = edits.find((each) => each.path === BACKEND_ORDER_PATH);
  if (edit?.value.kind !== "plain" || typeof edit.value.value !== "string") return { document: input, sentAs: {}, needed: false };
  const order = edit.value.value.split(" ").filter(Boolean);
  const rank = (id: string) => {
    const at = order.indexOf(id);
    return at < 0 ? order.length : at;
  };
  const backends = input.backends.map((backend, index) => ({ backend, index })).sort((a, b) => rank(a.backend.id) - rank(b.backend.id) || a.index - b.index).map((each) => each.backend);
  return { document: { ...input, backends }, sentAs: {}, needed: isChange(state, edit) };
}

export const SIZE_PARTS = ["cores", "memoryGiB", "diskGiB"] as const;
export type SizePart = (typeof SIZE_PARTS)[number];
export type SizeName = Preset | "largest";

export type KindAt =
  | { readonly at: "enabled"; readonly id: string }
  | { readonly at: "size"; readonly id: string; readonly size: SizeName; readonly part: SizePart }
  | { readonly at: "size-row"; readonly id: string; readonly size: SizeName }
  | { readonly at: "default"; readonly id: string }
  | { readonly at: "spares"; readonly id: string }
  | { readonly at: "gpu"; readonly id: string };

export function warmPath(backendId: string, kind: string): Path {
  return `backends/${backendId}/warm/${kind}`;
}

export function kindPath(id: string, setting: "enabled" | "default" | "spares" | "gpu"): Path {
  return `kinds/${id}/${setting}`;
}

export function sizeRowPath(id: string, size: SizeName): Path {
  return size === "largest" ? `kinds/${id}/largest` : `kinds/${id}/presets/${size}`;
}

export function sizePath(id: string, size: SizeName, part: SizePart): Path {
  return `${sizeRowPath(id, size)}/${part}`;
}

function isSizePart(part: string | undefined): part is SizePart {
  return (SIZE_PARTS as readonly (string | undefined)[]).includes(part);
}

function isPreset(name: string | undefined): name is Preset {
  return (PRESET_NAMES as readonly (string | undefined)[]).includes(name);
}

export function kindAt(path: Path): KindAt | null {
  const [section, id, ...rest] = path.split("/");
  if (section !== "kinds" || !id) return null;
  if (rest.length === 1 && (rest[0] === "enabled" || rest[0] === "default" || rest[0] === "spares" || rest[0] === "gpu")) return { at: rest[0], id };
  const size: SizeName | null = rest[0] === "largest" ? "largest" : rest[0] === "presets" && isPreset(rest[1]) ? rest[1] : null;
  if (!size) return null;
  const tail = size === "largest" ? rest.slice(1) : rest.slice(2);
  if (!tail.length) return { at: "size-row", id, size };
  if (tail.length === 1 && isSizePart(tail[0])) return { at: "size", id, size, part: tail[0] };
  return null;
}

function sizeOf(sizes: KindSizes, size: SizeName) {
  return size === "largest" ? sizes.largest : sizes.presets[size];
}

function storedSizePart(sizes: KindSizes, size: SizeName, part: SizePart): PlainValue {
  const box = sizeOf(sizes, size);
  if (part === "cores") return box.cores;
  if (part === "memoryGiB") return box.memoryMiB / 1024;
  return box.diskGiB;
}

function storedAtKind(state: ConfigState, at: KindAt): Stored {
  const sizes = effectiveKind(state, at.id);
  switch (at.at) {
    case "enabled":
      return { kind: "value", value: sizes.enabled };
    case "default":
      return { kind: "value", value: sizes.default };
    case "spares":
      return { kind: "value", value: sizes.spares };
    case "gpu":
      return { kind: "value", value: sizes.gpu };
    case "size":
      return { kind: "value", value: storedSizePart(sizes, at.size, at.part) };
    case "size-row":
      return { kind: "value", value: null };
  }
}

function countValue(value: PlainValue, empty: PlainValue): PlainValue {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (text === "") return empty;
  const number = Number(text);
  return Number.isFinite(number) ? number : value;
}

function kindValue(at: KindAt, value: PlainValue): PlainValue {
  if (at.at === "spares") return countValue(value, 0);
  if (at.at === "size") return countValue(value, at.part === "diskGiB" ? null : "");
  return value;
}

function withSizePart(sizes: KindSizes, size: SizeName, part: SizePart, value: number | null): KindSizes {
  const box = sizeOf(sizes, size);
  const next = part === "cores" ? { ...box, cores: value ?? box.cores } : part === "memoryGiB" ? { ...box, memoryMiB: value === null ? box.memoryMiB : mib(value) } : { ...box, diskGiB: value };
  return size === "largest" ? { ...sizes, largest: next } : { ...sizes, presets: { ...sizes.presets, [size]: next } };
}

function withKindEdit(sizes: KindSizes, at: KindAt, value: PlainValue): KindSizes {
  switch (at.at) {
    case "enabled":
      return typeof value === "boolean" ? { ...sizes, enabled: value } : sizes;
    case "default":
      return isPreset(typeof value === "string" ? value : undefined) ? { ...sizes, default: value as Preset } : sizes;
    case "spares":
      return typeof value === "number" ? { ...sizes, spares: value } : sizes;
    case "gpu":
      return value === null || isGpuPart(value) ? { ...sizes, gpu: value } : sizes;
    case "size":
      return typeof value === "number" || (value === null && at.part === "diskGiB") ? withSizePart(sizes, at.size, at.part, value) : sizes;
    case "size-row":
      return sizes;
  }
}

function withKindEdits(state: ConfigState, input: ConfigDocument, edits: readonly PathEdit[]): Built {
  const byKind = new Map<string, PathEdit[]>();
  for (const edit of edits) {
    const at = kindAt(edit.path);
    if (at && edit.value.kind === "plain") byKind.set(at.id, [...(byKind.get(at.id) ?? []), edit]);
  }
  let document = input;
  let needed = false;
  for (const [id, list] of byKind) {
    const current = { ...state, document };
    let sizes = effectiveKind(current, id);
    for (const edit of list) {
      if (edit.value.kind !== "plain") continue;
      if (isChange(state, edit)) needed = true;
      sizes = withKindEdit(sizes, kindAt(edit.path)!, documentValue(state, edit.path, edit.value.value));
    }
    document = withKind(document, id, kindChanges(current, id, sizes));
  }
  return { document, sentAs: {}, needed };
}

const SIZE_PART_WORDS: Readonly<Record<SizePart, string>> = { cores: "cores", memoryGiB: "memory", diskGiB: "disk" };

export function sizeName(size: SizeName): string {
  return size === "largest" ? "Largest" : PRESET_LABELS[size];
}

function kindEditProblems(edits: readonly PathEdit[]): DraftProblem[] {
  const problems: DraftProblem[] = [];
  const whole = (value: PlainValue, least: number) => typeof value === "number" && Number.isInteger(value) && value >= least;
  for (const edit of edits) {
    if (edit.value.kind !== "plain") continue;
    const at = kindAt(edit.path);
    const warm = backendAt(edit.path)?.at === "warm";
    if (!at && !warm) continue;
    const value = warm ? countValue(edit.value.value, 0) : at ? kindValue(at, edit.value.value) : null;
    if (warm && !whole(value, 0)) problems.push({ path: edit.path, message: "Give the warm boxes as a whole number, 0 for none." });
    else if (at?.at === "spares" && !whole(value, 0)) problems.push({ path: edit.path, message: "Give the spare boxes as a whole number, 0 for none." });
    else if (at?.at === "size") {
      if (at.part === "cores" && !whole(value, 1)) problems.push({ path: edit.path, message: "Give the cores as a whole number, at least 1." });
      else if (at.part === "memoryGiB" && !(typeof value === "number" && value > 0 && Number.isInteger(value * 1024))) problems.push({ path: edit.path, message: "Give the memory in GiB, such as 4 or 0.5." });
      else if (at.part === "diskGiB" && value === null && at.size === "largest") problems.push({ path: edit.path, message: "Give the disk in GiB." });
      else if (at.part === "diskGiB" && value !== null && !whole(value, 1)) problems.push({ path: edit.path, message: `Give the disk as a whole number of GiB${at.size === "largest" ? "" : ", or leave it empty for the image's own"}.` });
    }
  }
  return problems;
}

export function isNewHost(host: string): boolean {
  return host.startsWith(NEW_MARK);
}

export function holdsSecret(value: EditValue): boolean {
  return value.kind === "secret" || value.kind === "new-file";
}

export function secretTextOf(value: EditValue): string | null {
  return value.kind === "secret" || value.kind === "new-file" ? value.text : null;
}

export function withoutSecretText(value: EditValue): EditValue {
  if (value.kind === "secret") return { kind: "secret", text: null };
  if (value.kind === "new-file") return { kind: "new-file", path: value.path, text: null };
  return value;
}

export function sameValue(a: EditValue, b: EditValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameStored(a: Stored, b: Stored): boolean {
  if (a.kind === "gone" || b.kind === "gone") return a.kind === b.kind;
  if (a.kind === "version" && b.kind === "version") return a.version === b.version;
  if (a.kind === "value" && b.kind === "value") return JSON.stringify(a.value) === JSON.stringify(b.value);
  return false;
}

type Defaults = ConfigState["defaults"];
type Section = "general" | "monitor" | "snapshots" | "ceilings";

export const SNAPSHOT_KEYS = ["perBox", "roomPercent", "keepDays", "agentsRestore", "agentsMemory", "pictures"] as const;
export type SnapshotKey = (typeof SNAPSHOT_KEYS)[number];
const CEILINGS = "snapshots/ceilings/";

export function snapshotPath(key: SnapshotKey): Path {
  return `snapshots/${key}`;
}

export function ceilingPath(backendId: string): Path {
  return `${CEILINGS}${backendId}`;
}

function isSnapshotKey(key: string): key is SnapshotKey {
  return (SNAPSHOT_KEYS as readonly string[]).includes(key);
}

function defaultOf(defaults: Defaults, section: Section, key: string): PlainValue | undefined {
  if (section === "snapshots") return isSnapshotKey(key) ? SNAPSHOT_DEFAULTS[key] : undefined;
  if (section === "ceilings") return SNAPSHOT_DEFAULTS.ceiling;
  const values: Readonly<Record<string, unknown>> = section === "general" ? defaults.general : defaults.monitor;
  const value = values[key];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

function settingOf(path: Path): { readonly section: Section; readonly key: string } | null {
  if (path.startsWith(CEILINGS) && path.length > CEILINGS.length) return { section: "ceilings", key: path.slice(CEILINGS.length) };
  const [section, key, ...rest] = path.split("/");
  if ((section === "general" || section === "monitor") && key && !rest.length) return { section, key };
  if (section === "snapshots" && key && isSnapshotKey(key) && !rest.length) return { section, key };
  return null;
}

function storedSetting(state: ConfigState, section: Section, key: string): unknown {
  if (section === "snapshots") return snapshotConfig(state.document)[key as SnapshotKey];
  if (section === "ceilings") return ceilingOf(snapshotConfig(state.document), key);
  const values: Readonly<Record<string, unknown>> = section === "general" ? { ...state.defaults.general, ...state.document.general } : { ...state.defaults.monitor, ...state.document.monitor };
  return values[key];
}

function backendIn(document: ConfigDocument, id: string): BackendConfig | undefined {
  return document.backends.find((backend) => backend.id === id);
}

function hostIn(backend: BackendConfig | undefined, name: string): HostConfig | undefined {
  return backend?.hosts?.find((host) => host.name === name);
}

export function fieldAt(state: ConfigState, path: Path): FieldView | null {
  const at = backendAt(path);
  if (!at || (at.at !== "field" && at.at !== "host-field")) return null;
  const type = backendIn(state.document, at.id)?.type ?? typeOfBackendId(at.id);
  const driver = state.drivers.find((candidate) => candidate.type === type);
  const fields = at.at === "field" ? driver?.fields : driver?.hostFields;
  return fields?.find((field) => field.key === at.key) ?? null;
}

function asPlain(value: unknown): PlainValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null;
}

function fieldValue(field: FieldView | null, value: PlainValue): PlainValue {
  if (!field || value === null) return value;
  if (field.type === "boolean") return field.default === undefined || field.replaces !== undefined || value !== field.default ? value : null;
  if (field.type === "number") {
    if (typeof value !== "string") return value;
    const text = value.trim();
    if (text === "") return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : value;
  }
  if (typeof value !== "string") return value;
  if (field.offWhenEmpty && value === "") return "";
  return value.trim() === "" ? null : value;
}

function tailnetValue(key: TailnetKey, value: PlainValue): PlainValue {
  if (key !== "tags" || typeof value !== "string") return value;
  return tagsFromText(value).join(", ") || null;
}

export function documentValue(state: ConfigState, path: Path, value: PlainValue): PlainValue {
  const tailnetKey = tailnetKeyOf(path);
  if (tailnetKey) return tailnetValue(tailnetKey, value);
  const at = backendAt(path);
  if (at?.at === "field" || at?.at === "host-field") return fieldValue(fieldAt(state, path), value);
  if (at?.at === "warm") return countValue(value, 0);
  const kind = kindAt(path);
  if (kind) return kindValue(kind, value);
  if (at?.at === "label") return typeof value === "string" ? value.trim() || null : value;
  const setting = settingOf(path);
  if (!setting) return value;
  const fallback = defaultOf(state.defaults, setting.section, setting.key);
  if (typeof fallback !== "number" || typeof value !== "string") return value;
  const text = value.trim();
  if (text === "") return fallback;
  const number = Number(text);
  return Number.isFinite(number) ? number : value;
}

function fileVersion(document: ConfigDocument, path: string): number | null {
  const file = document.general.files?.find((candidate) => candidate.path === path);
  if (!file) return null;
  return isSecretState(file.content) ? (file.content.version ?? 0) : 0;
}

function storedAtBackend(state: ConfigState, at: BackendAt, path: Path): Stored {
  const backend = backendIn(state.document, at.id);
  if (!backend) return { kind: "gone" };
  switch (at.at) {
    case "backend":
      return { kind: "value", value: true };
    case "enabled":
      return { kind: "value", value: backend.enabled };
    case "label":
      return { kind: "value", value: backend.label ?? null };
    case "warm":
      return { kind: "value", value: backend.warm?.[at.kind] ?? 0 };
    case "field": {
      const field = fieldAt(state, path);
      const raw = backend.fields[at.key];
      if (field && isSecretField(field)) return { kind: "version", version: isSecretState(raw) ? (raw.version ?? 0) : null };
      return { kind: "value", value: fieldValue(field, asPlain(raw)) };
    }
    case "host":
    case "host-name":
      return hostIn(backend, at.host) ? { kind: "value", value: true } : { kind: "gone" };
    case "host-enabled": {
      const host = hostIn(backend, at.host);
      return host ? { kind: "value", value: host.enabled } : { kind: "gone" };
    }
    case "host-field": {
      const host = hostIn(backend, at.host);
      return host ? { kind: "value", value: fieldValue(fieldAt(state, path), asPlain(host.fields[at.key])) } : { kind: "gone" };
    }
  }
}

function storedAtTailnet(tailnet: TailnetSetting | undefined, key: TailnetKey): Stored {
  if (key === "mode") return { kind: "value", value: tailnet?.mode ?? "off" };
  if (key === "tags") return { kind: "value", value: tailnet?.tags?.length ? tailnet.tags.join(", ") : null };
  const secret = tailnet?.[key];
  return { kind: "version", version: isSecretState(secret) ? (secret.version ?? 0) : null };
}

export function storedAt(state: ConfigState, path: Path, value?: EditValue): Stored {
  const tailnetKey = tailnetKeyOf(path);
  if (tailnetKey) return storedAtTailnet(state.document.general.tailnet, tailnetKey);
  const setting = settingOf(path);
  if (setting) return { kind: "value", value: asPlain(storedSetting(state, setting.section, setting.key)) };
  const at = backendAt(path);
  if (at) return storedAtBackend(state, at, path);
  const image = imageAt(path);
  if (image) return storedAtImage(state.document, image);
  if (path === BACKEND_ORDER_PATH) return storedOrder(state.document);
  const kind = kindAt(path);
  if (kind) return storedAtKind(state, kind);
  if (isFilePath(path)) {
    const file = value?.kind === "new-file" ? value.path.trim() : fileOfPath(path);
    return { kind: "version", version: file ? fileVersion(state.document, file) : null };
  }
  return { kind: "value", value: null };
}

export function conflictOf(state: ConfigState, edit: PathEdit): Conflict | null {
  if (edit.value.kind === "new-backend") return backendIn(state.document, edit.value.id) ? { kind: "taken", id: edit.value.id } : null;
  const stored = storedAt(state, edit.path, edit.value);
  if (sameStored(stored, edit.base)) return null;
  if (stored.kind === "gone") return edit.value.kind === "removed" ? null : { kind: "removed" };
  if (edit.value.kind === "removed") return stored.kind === "version" && stored.version !== null && backendAt(edit.path) !== null ? { kind: "replaced", version: stored.version } : null;
  if (edit.value.kind === "new-host") return null;
  if (edit.value.kind === "plain") {
    if (stored.kind !== "value") return null;
    if (JSON.stringify(stored.value) === JSON.stringify(documentValue(state, edit.path, edit.value.value))) return null;
    return { kind: "changed", stored: stored.value };
  }
  if (stored.kind !== "version") return null;
  if (stored.version === null) return { kind: "removed" };
  if (edit.value.kind === "new-file" && edit.base.kind === "version" && edit.base.version === null) return { kind: "added", version: stored.version };
  return { kind: "replaced", version: stored.version };
}

export function fileIsStored(state: ConfigState, path: Path): boolean {
  const stored = storedAt(state, path);
  return stored.kind === "version" && stored.version !== null;
}

export function isChange(state: ConfigState, edit: PathEdit): boolean {
  if (edit.value.kind !== "plain") return true;
  const stored = storedAt(state, edit.path);
  const value = documentValue(state, edit.path, edit.value.value);
  if (stored.kind === "gone") return value !== null;
  return !(stored.kind === "value" && JSON.stringify(stored.value) === JSON.stringify(value));
}

function writeSetting(state: ConfigState, document: ConfigDocument, section: Section, key: string, value: PlainValue): ConfigDocument {
  const fallback = defaultOf(state.defaults, section, key);
  const kept = value === fallback ? undefined : value;
  switch (section) {
    case "general":
      return withGeneral(document, { [key]: kept } as Partial<ConfigDocument["general"]>);
    case "monitor":
      return withMonitor(document, { [key]: kept } as Partial<NonNullable<ConfigDocument["monitor"]>>);
    case "snapshots":
      return withSnapshots(document, { [key]: kept });
    case "ceilings":
      return withCeiling(document, key, kept as number | undefined);
  }
}

interface FileDraft {
  readonly path: string;
  readonly content?: string;
  readonly from: Path;
}

interface Built {
  readonly document: ConfigDocument;
  readonly sentAs: Record<string, Path>;
  readonly needed: boolean;
}

function withFiles(document: ConfigDocument, edits: readonly PathEdit[]): Built {
  const fileEdits = edits.filter((edit) => isFilePath(edit.path));
  if (!fileEdits.length) return { document, sentAs: {}, needed: false };
  let needed = false;
  let files: FileDraft[] = (document.general.files ?? []).map((file) => ({ path: file.path, from: filePath(file.path) }));
  for (const edit of fileEdits) {
    const path = fileOfPath(edit.path);
    if (path === null) continue;
    if (edit.value.kind === "removed") {
      if (files.some((file) => file.path === path)) needed = true;
      files = files.filter((file) => file.path !== path);
    } else if (edit.value.kind === "secret" && edit.value.text !== null) {
      const text = edit.value.text;
      needed = true;
      files = files.map((file) => (file.path === path ? { ...file, content: text, from: edit.path } : file));
    }
  }
  for (const edit of fileEdits) {
    if (edit.value.kind !== "new-file" || edit.value.text === null) continue;
    const path = edit.value.path.trim();
    const text = edit.value.text;
    needed = true;
    files = files.some((file) => file.path === path) ? files.map((file) => (file.path === path ? { path, content: text, from: edit.path } : file)) : [...files, { path, content: text, from: edit.path }];
  }
  const sentAs: Record<string, Path> = {};
  files.forEach((file, index) => {
    sentAs[`general.files.${index}`] = file.from;
  });
  const sent: BoxFileSetting[] = files.map((file) => (file.content === undefined ? { path: file.path } : { path: file.path, content: file.content }));
  return { document: withGeneral(document, { files: sent.length ? sent : undefined }), sentAs, needed };
}

type DraftFields = Record<string, FieldValue | { readonly set: boolean; readonly version?: number } | null>;

interface HostDraft {
  readonly host: HostConfig;
  readonly from: Path;
}

function setField(fields: Record<string, unknown>, key: string, value: PlainValue): void {
  if (value === null) delete fields[key];
  else fields[key] = value;
}

function withBackendEdits(state: ConfigState, input: ConfigDocument, edits: readonly PathEdit[]): Built {
  const byBackend = new Map<string, PathEdit[]>();
  for (const edit of edits) {
    const at = backendAt(edit.path);
    if (at) byBackend.set(at.id, [...(byBackend.get(at.id) ?? []), edit]);
  }
  let document = input;
  let needed = false;
  const sentAs: Record<string, Path> = {};
  for (const [id, list] of byBackend) {
    const created = list.find((edit) => backendAt(edit.path)?.at === "backend" && edit.value.kind === "new-backend")?.value;
    const backend = backendIn(document, id) ?? (created?.kind === "new-backend" && !backendIn(document, created.id) ? { id: created.id, type: created.type, enabled: created.enabled, fields: {} } : undefined);
    if (!backend) continue;
    if (backend.id !== id) {
      sentAs[`backends.${backend.id}`] = backendPath(id);
      needed = true;
    }
    if (list.some((edit) => backendAt(edit.path)?.at === "backend" && edit.value.kind === "removed")) {
      document = withoutBackend(document, id);
      needed = true;
      continue;
    }
    const fields: DraftFields = { ...backend.fields };
    let label = backend.label;
    let enabled = backend.enabled;
    const warm: Record<string, number> = { ...backend.warm };
    let hosts: HostDraft[] = (backend.hosts ?? []).map((host) => ({ host, from: hostPath(id, host.name) }));
    const newHosts: PathEdit[] = [];
    const editHost = (name: string, change: (host: HostConfig) => HostConfig) => {
      hosts = hosts.map((each) => (each.host.name === name ? { ...each, host: change(each.host) } : each));
    };
    for (const edit of list) {
      const at = backendAt(edit.path)!;
      const changed = isChange(state, edit);
      if (edit.value.kind === "plain") {
        const value = documentValue(state, edit.path, edit.value.value);
        if (at.at === "enabled" && typeof value === "boolean") enabled = value;
        else if (at.at === "label") label = typeof value === "string" ? value : undefined;
        else if (at.at === "field") setField(fields, at.key, value);
        else if (at.at === "warm" && typeof value === "number") {
          if (value) warm[at.kind] = value;
          else delete warm[at.kind];
        }
        else if (at.at === "host-enabled" && typeof value === "boolean") editHost(at.host, (host) => ({ ...host, enabled: value }));
        else if (at.at === "host-field" && !isNewHost(at.host)) {
          editHost(at.host, (host) => {
            const next: Record<string, unknown> = { ...host.fields };
            setField(next, at.key, value);
            return { ...host, fields: next as Record<string, FieldValue> };
          });
        } else continue;
        if (changed) needed = true;
      } else if (edit.value.kind === "secret" && at.at === "field") {
        if (edit.value.text === null) continue;
        fields[at.key] = edit.value.text;
        needed = true;
      } else if (edit.value.kind === "removed" && at.at === "field") {
        fields[at.key] = null;
        needed = true;
      } else if (edit.value.kind === "removed" && at.at === "host") {
        if (hosts.some((each) => each.host.name === at.host)) needed = true;
        hosts = hosts.filter((each) => each.host.name !== at.host);
      } else if (edit.value.kind === "new-host" && at.at === "host") newHosts.push(edit);
    }
    for (const added of newHosts) {
      if (added.value.kind !== "new-host") continue;
      const own: Record<string, unknown> = {};
      for (const edit of list) {
        const at = backendAt(edit.path);
        if (at?.at !== "host-field" || hostPath(id, at.host) !== added.path || edit.value.kind !== "plain") continue;
        setField(own, at.key, documentValue(state, edit.path, edit.value.value));
      }
      hosts = [...hosts, { host: { name: added.value.name.trim(), enabled: added.value.enabled, fields: own as Record<string, FieldValue> }, from: added.path }];
      needed = true;
    }
    hosts.forEach((each, index) => {
      sentAs[`backends.${backend.id}.hosts.${index}`] = each.from;
    });
    const { label: _label, hosts: _hosts, warm: _warm, ...rest } = backend;
    document = withBackend(document, {
      ...rest,
      ...(label ? { label } : {}),
      enabled,
      fields,
      ...(Object.keys(warm).length ? { warm } : {}),
      ...(hosts.length || backend.hosts ? { hosts: hosts.map((each) => each.host) } : {}),
    });
  }
  return { document, sentAs, needed };
}

type TailnetDraft = Omit<TailnetSetting, "clientId" | "clientSecret"> & {
  readonly clientId?: TailnetSetting["clientId"] | string;
  readonly clientSecret?: TailnetSetting["clientSecret"] | string;
};

function withTailnet(state: ConfigState, document: ConfigDocument, edits: readonly PathEdit[]): Built {
  const tailnetEdits = edits.filter((edit) => tailnetKeyOf(edit.path) !== null);
  if (!tailnetEdits.length) return { document, sentAs: {}, needed: false };
  const stored = document.general.tailnet;
  const editOf = (key: TailnetKey) => tailnetEdits.find((edit) => edit.path === tailnetPath(key));
  const modeEdit = editOf("mode");
  const mode = modeEdit?.value.kind === "plain" && (modeEdit.value.value === "off" || modeEdit.value.value === "oauth") ? modeEdit.value.value : (stored?.mode ?? "off");
  const modeChanged = modeEdit !== undefined && isChange(state, modeEdit);
  if (mode === "off") return { document: withGeneral(document, { tailnet: undefined }), sentAs: {}, needed: modeChanged };
  let needed = modeChanged;
  const tagsEdit = editOf("tags");
  let tags = stored?.tags;
  if (tagsEdit?.value.kind === "plain") {
    const value = documentValue(state, tagsEdit.path, tagsEdit.value.value);
    tags = typeof value === "string" ? value.split(", ") : undefined;
    if (isChange(state, tagsEdit)) needed = true;
  }
  const secretOf = (key: "clientId" | "clientSecret") => {
    const edit = editOf(key);
    if (edit?.value.kind === "secret" && edit.value.text !== null) {
      needed = true;
      return edit.value.text;
    }
    return stored?.[key];
  };
  const clientId = secretOf("clientId");
  const clientSecret = secretOf("clientSecret");
  const tailnet: TailnetDraft = { mode, ...(tags?.length ? { tags } : {}), ...(clientId !== undefined ? { clientId } : {}), ...(clientSecret !== undefined ? { clientSecret } : {}) };
  return { document: withGeneral(document, { tailnet: tailnet as TailnetSetting }), sentAs: {}, needed };
}

export function candidateOf(state: ConfigState, edits: readonly PathEdit[]): Candidate {
  const conflicts = edits.filter((edit) => conflictOf(state, edit) !== null).map((edit) => edit.path);
  let document = state.document;
  let needed = false;
  for (const edit of edits) {
    if (edit.value.kind !== "plain") continue;
    const setting = settingOf(edit.path);
    if (!setting) continue;
    if (isChange(state, edit)) needed = true;
    document = writeSetting(state, document, setting.section, setting.key, documentValue(state, edit.path, edit.value.value));
  }
  const kinds = withKindEdits(state, document, edits);
  const backends = withBackendEdits(state, kinds.document, edits);
  const files = withFiles(backends.document, edits);
  const tailnet = withTailnet(state, files.document, edits);
  const images = withImageEdits(state, tailnet.document, edits);
  const order = withOrderEdit(state, images.document, edits);
  return { document: order.document, conflicts, needed: needed || kinds.needed || backends.needed || files.needed || tailnet.needed || images.needed || order.needed, sentAs: { ...backends.sentAs, ...files.sentAs } };
}

function hostProblemPath(id: string, index: string, rest: string | undefined, sentAs: Readonly<Record<string, Path>>): Path {
  const at = sentAs[`backends.${id}.hosts.${index}`];
  if (!at) return `backends/${id}/hosts`;
  if (rest === undefined) return at;
  return rest === "name" || rest === "enabled" ? `${at}/${rest}` : hostFieldPath(at, rest);
}

export function problemPath(serverPath: string, sentAs: Readonly<Record<string, Path>>): Path {
  const file = /^(general\.files\.\d+)(?:\.(path|content))?$/.exec(serverPath);
  if (file) {
    const at = sentAs[file[1]!];
    if (at) return file[2] ? `${at}/${file[2]}` : at;
    return "files";
  }
  if (serverPath === "general.files") return "files";
  const tailnet = /^general\.tailnet(?:\.([A-Za-z]+))?$/.exec(serverPath);
  if (tailnet) return tailnetPath(TAILNET_KEYS.find((key) => key === tailnet[1]) ?? "mode");
  const ceiling = /^general\.snapshots\.ceilings\.(.+)$/.exec(serverPath);
  if (ceiling) return ceilingPath(ceiling[1]!);
  const snapshot = /^general\.snapshots\.([A-Za-z]+)$/.exec(serverPath);
  if (snapshot && isSnapshotKey(snapshot[1]!)) return snapshotPath(snapshot[1]);
  const setting = /^(general|monitor)\.([A-Za-z]+)$/.exec(serverPath);
  if (setting) return `${setting[1]}/${setting[2]}`;
  const kind = /^kinds\.([^.]+)$/.exec(serverPath);
  if (kind) return `kinds/${kind[1]}/enabled`;
  const size = /^kinds\.([^.]+)\.(presets\.[a-z]+|largest)(?:\.(cores|memoryMiB|diskGiB))?$/.exec(serverPath);
  if (size) return `kinds/${size[1]}/${size[2]!.replace(".", "/")}${size[3] ? `/${size[3] === "memoryMiB" ? "memoryGiB" : size[3]}` : ""}`;
  const kindSetting = /^kinds\.([^.]+)\.(default|spares|presets)$/.exec(serverPath);
  if (kindSetting) return `kinds/${kindSetting[1]}/${kindSetting[2]}`;
  const warm = /^backends\.([^.]+)\.warm(?:\.([^.]+))?$/.exec(serverPath);
  if (warm) return warm[2] ? warmPath(warm[1]!, warm[2]) : `backends/${warm[1]}/warm`;
  const host = /^backends\.([^.]+)\.hosts\.(\d+)(?:\.(.+))?$/.exec(serverPath);
  if (host) return hostProblemPath(host[1]!, host[2]!, host[3], sentAs);
  const hosts = /^backends\.([^.]+)\.hosts$/.exec(serverPath);
  if (hosts) return `backends/${hosts[1]}/hosts`;
  const own = /^backends\.([^.]+)\.(label|enabled)$/.exec(serverPath);
  if (own) return `backends/${own[1]}/${own[2]}`;
  const field = /^backends\.([^.]+)\.([^.]+)$/.exec(serverPath);
  if (field && field[2] !== "warm") return backendFieldPath(field[1]!, field[2]!);
  const backend = /^backends\.([^.]+)$/.exec(serverPath);
  if (backend) return `backends/${backend[1]}/enabled`;
  return serverPath;
}

function provisionalBackendPath(path: Path, sentAs: Readonly<Record<string, Path>>): Path {
  for (const [sent, provisional] of Object.entries(sentAs)) {
    const id = /^backends\.([^.]+)$/.exec(sent)?.[1];
    if (!id) continue;
    const saved = backendPath(id);
    if (path === saved || path.startsWith(`${saved}/`)) return `${provisional}${path.slice(saved.length)}`;
  }
  return path;
}

export function draftProblems(problems: readonly Problem[], sentAs: Readonly<Record<string, Path>>): DraftProblem[] {
  return problems.map((problem) => ({ path: provisionalBackendPath(problemPath(problem.path, sentAs), sentAs), message: problem.message }));
}

export function storedProblemPath(state: ConfigState, serverPath: string): Path {
  const sentAs: Record<string, Path> = {};
  for (const backend of state.document.backends) (backend.hosts ?? []).forEach((host, index) => (sentAs[`backends.${backend.id}.hosts.${index}`] = hostPath(backend.id, host.name)));
  return problemPath(serverPath, sentAs);
}

export function hostNoun(type: string): string {
  return type === "tart" ? "Mac" : "host";
}

function driverLabelOf(state: ConfigState, id: string): string {
  const type = backendIn(state.document, id)?.type ?? typeOfBackendId(id);
  return state.drivers.find((driver) => driver.type === type)?.label ?? type;
}

function hostEditProblems(state: ConfigState, edits: readonly PathEdit[]): DraftProblem[] {
  const problems: DraftProblem[] = [];
  const added = edits.flatMap((edit) => (edit.value.kind === "new-host" ? [{ path: edit.path, id: backendAt(edit.path)!.id, name: edit.value.name.trim() }] : []));
  const timesNamed = (id: string, name: string) => added.filter((each) => each.id === id && each.name === name).length;
  for (const { path, id, name } of added) {
    const backend = backendIn(state.document, id);
    const noun = hostNoun(backend?.type ?? typeOfBackendId(id));
    const at = `${path}/name`;
    const example = noun === "Mac" ? "mac-2" : "host-2";
    if (!name) problems.push({ path: at, message: `Name the new ${noun}, such as ${example}.` });
    else if (!HOST_NAME.test(name)) problems.push({ path: at, message: `Name a ${noun} with lower-case letters, digits and "-", such as ${example}.` });
    else if (hostIn(backend, name)) problems.push({ path: at, message: `${name} is already a ${noun} on ${driverLabelOf(state, id)}.` });
    else if (timesNamed(id, name) > 1) problems.push({ path: at, message: `${name} is a new ${noun} here twice. Give each its own name.` });
  }
  return problems;
}

function secretEditProblems(state: ConfigState, edits: readonly PathEdit[]): DraftProblem[] {
  const problems: DraftProblem[] = [];
  for (const edit of edits) {
    if (edit.value.kind !== "secret") continue;
    const tailnetKey = tailnetKeyOf(edit.path);
    if (backendAt(edit.path)?.at !== "field" && !isTailnetSecret(tailnetKey)) continue;
    const label = isTailnetSecret(tailnetKey) ? TAILNET_SECRET_LABELS[tailnetKey] : (fieldAt(state, edit.path)?.label ?? "secret");
    if (edit.value.text === null) problems.push({ path: edit.path, message: `Paste the ${label} again: what you pasted was not kept when the page reloaded.` });
    else if (edit.value.text === "") problems.push({ path: edit.path, message: `Paste the new ${label}, or keep the saved one.` });
  }
  return problems;
}

export function editProblems(state: ConfigState, edits: readonly PathEdit[]): DraftProblem[] {
  return [...fileEditProblems(edits), ...secretEditProblems(state, edits), ...hostEditProblems(state, edits), ...kindEditProblems(edits)];
}

export function fileEditProblems(edits: readonly PathEdit[]): DraftProblem[] {
  const problems: DraftProblem[] = [];
  const newPaths = new Map<string, number>();
  for (const edit of edits) if (edit.value.kind === "new-file") newPaths.set(edit.value.path.trim(), (newPaths.get(edit.value.path.trim()) ?? 0) + 1);
  for (const edit of edits) {
    if (edit.value.kind === "new-file") {
      const path = edit.value.path.trim();
      const wrong = pathProblem(path);
      if (wrong) problems.push({ path: `${edit.path}/path`, message: wrong });
      else if ((newPaths.get(path) ?? 0) > 1) problems.push({ path: `${edit.path}/path`, message: `~/${path} is a new file here twice. Give each its own path.` });
      if (edit.value.text === null) problems.push({ path: `${edit.path}/content`, message: "Paste the content again: what you pasted was not kept when the page reloaded." });
      else if (edit.value.text === "") problems.push({ path: `${edit.path}/content`, message: "Paste the file's content." });
    } else if (edit.value.kind === "secret" && isFilePath(edit.path)) {
      if (edit.value.text === null) problems.push({ path: `${edit.path}/content`, message: "Paste the content again: what you pasted was not kept when the page reloaded." });
      else if (edit.value.text === "") problems.push({ path: `${edit.path}/content`, message: "Paste the file's new content." });
    }
  }
  return problems;
}

export const TAILNET_SECRET_LABELS: Readonly<Record<"clientId" | "clientSecret", string>> = { clientId: "OAuth client ID", clientSecret: "OAuth client secret" };

const SETTING_LABELS: Readonly<Record<string, string>> = {
  "general/boxesPerThread": "Boxes per thread",
  "general/iosEncoder": "iOS video encoding",
  "general/encoderLedger": "Share each Mac's encoder fairly",
  "general/testDevice": "Test device",
  "general/tailnet/mode": "Join machines to the tailnet",
  "general/tailnet/tags": "Tags",
  "general/tailnet/clientId": "the OAuth client ID",
  "general/tailnet/clientSecret": "the OAuth client secret",
  "general/enrol": "Boxes join BB as machines",
  "general/video": "Linux desktops as video",
  "general/nightlyImages": "Rebuild each night",
  "general/defaultKind": "Default kind",
  "snapshots/perBox": "Snapshots per box",
  "snapshots/roomPercent": "Refuse new snapshots when a host's storage is past",
  "snapshots/keepDays": "Keep keeps a snapshot for",
  "snapshots/agentsRestore": "Agents may restore their own boxes",
  "snapshots/agentsMemory": "Agents may restore memory snapshots",
  "snapshots/pictures": "Keep a picture of the screen with each snapshot",
  "monitor/enabled": "Machine status",
  "monitor/refreshIntervalSeconds": "Refresh every",
  "monitor/backgroundMonitoring": "Background monitoring",
  "monitor/pressureNotifications": "Pressure notifications",
  "monitor/boxHistory": "Keep each box's history",
};

function kindLabelOf(path: Path): string | null {
  const at = kindAt(path);
  if (!at) return null;
  switch (at.at) {
    case "enabled":
      return "Offered to threads";
    case "default":
      return "Default size";
    case "spares":
      return "Spare boxes";
    case "gpu":
      return "GPU when not asked for";
    case "size":
      return `${sizeName(at.size)} ${SIZE_PART_WORDS[at.part]}`;
    case "size-row":
      return sizeName(at.size);
  }
}

function backendLabelOf(path: Path, value: EditValue | undefined, state: ConfigState | undefined): string | null {
  const at = backendAt(path);
  if (!at) return null;
  if (at.at === "label") return "Name";
  if (at.at === "warm") {
    return `Warm boxes on ${state?.backends.find((each) => each.id === at.id)?.label ?? (state && backendIn(state.document, at.id)?.label) ?? at.id}`;
  }
  if (at.at === "field" || at.at === "host-field") {
    const label = (state && fieldAt(state, path)?.label) ?? at.key;
    const field = state ? fieldAt(state, path) : null;
    const named = field && isSecretField(field) ? `the ${label}` : label;
    return at.at === "field" ? named : `${named} on ${isNewHost(at.host) ? "the new Mac" : at.host}`;
  }
  if (at.at === "host") return value?.kind === "new-host" ? value.name.trim() || "the new Mac" : at.host;
  return null;
}

function imageLabelOf(path: Path): string | null {
  const at = imageAt(path);
  if (!at) return null;
  return at.at === "bake" ? `When ${at.name} is built ahead` : `The image ${at.name}`;
}

export function labelOf(path: Path, value?: EditValue, state?: ConfigState): string {
  const setting = SETTING_LABELS[path];
  if (setting) return setting;
  const ceiling = settingOf(path);
  if (ceiling?.section === "ceilings") return `The ceiling a month on ${state?.backends.find((backend) => backend.id === ceiling.key)?.label ?? ceiling.key}'s paid snapshots`;
  if (path === BACKEND_ORDER_PATH) return "The order new boxes try the backends in";
  const image = imageLabelOf(path);
  if (image) return image;
  if (value?.kind === "new-file") return `the content of ~/${value.path.trim() || "the new file"}`;
  const file = fileOfPath(path);
  if (file !== null) return `the content of ~/${file}`;
  return backendLabelOf(path, value, state) ?? kindLabelOf(path) ?? path;
}
