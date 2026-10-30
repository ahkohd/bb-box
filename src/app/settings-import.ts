import { GENERAL_SECRETS, contentKey } from "../core/box-files.ts";
import type { BackendConfig, ConfigDocument, ImageConfig } from "../core/document.ts";
import { TAILNET_CLIENT_ID, TAILNET_CLIENT_SECRET } from "../core/tailnet-settings.ts";
import type { ConfigState, DraftRead, FieldView } from "../plugin/configuration.ts";
import { PRESET_NAMES, isSecretField } from "./config.ts";
import {
  BACKEND_ORDER_PATH,
  SIZE_PARTS,
  backendAt,
  backendFieldPath,
  backendPath,
  canonicalJson,
  documentValue,
  fieldAt,
  ceilingPath,
  fileOfPath,
  filePath,
  hostFieldPath,
  hostNoun,
  hostPath,
  imageAt,
  imageDefinitionPath,
  imagePath,
  kindAt,
  kindPath,
  labelOf,
  orderValue,
  plain,
  sizePath,
  snapshotPath,
  SNAPSHOT_KEYS,
  storedAt,
  tailnetKeyOf,
  tailnetPath,
  typeOfBackendId,
  warmPath,
  type Edit,
  type EditValue,
  type Path,
  type PlainValue,
  type SizeName,
} from "./settings-paths.ts";

export const IMPORT_PART = "option/configuration";
export const IMPORT_TEXT = "import/text";

export type ParsedImport = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly line: number | null; readonly column: number | null };

function lineAndColumn(text: string, offset: number): { readonly line: number; readonly column: number } {
  const lines = text.slice(0, offset).split("\n");
  return { line: lines.length, column: lines[lines.length - 1]!.length + 1 };
}

export function parseImport(text: string): ParsedImport {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : "";
    const at = /line (\d+) column (\d+)/.exec(reason);
    if (at) return { ok: false, line: Number(at[1]), column: Number(at[2]) };
    const offset = /position (\d+)/.exec(reason);
    if (offset) return { ok: false, ...lineAndColumn(text, Number(offset[1])) };
    return { ok: false, line: null, column: null };
  }
}

export function invalidWords(parsed: Extract<ParsedImport, { ok: false }>): string {
  const where = parsed.line === null ? "" : `, at line ${parsed.line}, column ${parsed.column}`;
  return `This is not a configuration file: it is not valid JSON${where}. Nothing was checked.`;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function backendEntry(file: unknown, id: string): Record<string, unknown> | null {
  const backends = record(file)?.backends;
  if (!Array.isArray(backends)) return null;
  for (const each of backends) {
    const entry = record(each);
    if (entry && (typeof entry.id === "string" ? entry.id : entry.type) === id) return entry;
  }
  return null;
}

export function pastedSecret(file: unknown, owner: string, key: string): string | null {
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
  if (owner !== GENERAL_SECRETS) return text(record(backendEntry(file, owner)?.fields)?.[key]);
  const general = record(record(file)?.general);
  if (key === TAILNET_CLIENT_ID) return text(record(general?.tailnet)?.clientId);
  if (key === TAILNET_CLIENT_SECRET) return text(record(general?.tailnet)?.clientSecret);
  const files = general?.files;
  if (!Array.isArray(files)) return null;
  for (const each of files) {
    const entry = record(each);
    if (entry && typeof entry.path === "string" && contentKey(entry.path.trim()) === key) return text(entry.content);
  }
  return null;
}

export interface ImportPlan {
  readonly values: readonly (readonly [Path, EditValue])[];
  readonly problems: readonly string[];
  readonly unset: readonly string[];
}

function sameStoredValue(state: ConfigState, file: ConfigState, path: Path): { readonly same: boolean; readonly after: PlainValue } {
  const before = storedAt(state, path);
  const after = storedAt(file, path);
  const value = after.kind === "value" ? after.value : null;
  return { same: before.kind === after.kind && JSON.stringify(before) === JSON.stringify(after), after: value };
}

function driverFields(state: ConfigState, type: string): { readonly fields: readonly FieldView[]; readonly hostFields: readonly FieldView[]; readonly label: string } {
  const driver = state.drivers.find((candidate) => candidate.type === type);
  return { fields: driver?.fields ?? [], hostFields: driver?.hostFields ?? [], label: driver?.label ?? type };
}

export function newBackendName(state: ConfigState, id: string, label?: string | null): string {
  if (label) return label;
  const type = typeOfBackendId(id);
  const driver = driverFields(state, type).label;
  const name = id.slice(type.length + 1);
  return name ? `${driver} (${name})` : driver;
}

export function importPlan(state: ConfigState, read: DraftRead, file: unknown): ImportPlan {
  const values: [Path, EditValue][] = [];
  const problems: string[] = [];
  const unset: string[] = [];
  const target: ConfigState = { ...state, document: read.document };
  const settle = (path: Path) => {
    const { same, after } = sameStoredValue(state, target, path);
    if (!same) values.push([path, plain(after)]);
  };
  const secretOf = (owner: string, key: string) => read.secrets[owner]?.[key];

  for (const key of Object.keys(state.defaults.general)) settle(`general/${key}`);
  for (const key of Object.keys(state.defaults.monitor)) settle(`monitor/${key}`);
  for (const key of SNAPSHOT_KEYS) settle(snapshotPath(key));
  for (const id of new Set([...Object.keys(state.document.general.snapshots?.ceilings ?? {}), ...Object.keys(read.document.general.snapshots?.ceilings ?? {})])) settle(ceilingPath(id));

  settle(tailnetPath("mode"));
  if (read.document.general.tailnet?.mode === "oauth") {
    settle(tailnetPath("tags"));
    for (const [key, path, label] of [
      [TAILNET_CLIENT_ID, tailnetPath("clientId"), "OAuth client ID"],
      [TAILNET_CLIENT_SECRET, tailnetPath("clientSecret"), "OAuth client secret"],
    ] as const) {
      const change = secretOf(GENERAL_SECRETS, key);
      const text = change === "set" ? pastedSecret(file, GENERAL_SECRETS, key) : null;
      if (text !== null) values.push([path, { kind: "secret", text }]);
      else if (change === "cleared") problems.push(`The file clears the tailnet's ${label}. The page cannot clear it alone: give a new one, or leave it out to keep the saved one.`);
    }
  }

  const filesNow = (state.document.general.files ?? []).map((each) => each.path);
  const filesThen = (read.document.general.files ?? []).map((each) => each.path);
  for (const path of filesNow) if (!filesThen.includes(path)) values.push([filePath(path), { kind: "removed" }]);
  for (const path of filesThen) {
    const change = secretOf(GENERAL_SECRETS, contentKey(path));
    const text = change === "set" ? pastedSecret(file, GENERAL_SECRETS, contentKey(path)) : null;
    if (!filesNow.includes(path)) {
      if (text !== null) values.push([filePath(path), { kind: "new-file", path, text }]);
      else problems.push(`~/${path} is a new file for every box, and the file gives no content for it. Give its content, or leave the file out.`);
    } else if (text !== null) values.push([filePath(path), { kind: "secret", text }]);
    else if (change === "cleared") problems.push(`The file clears the content of ~/${path}. Give its content, or {"set": true} to keep the saved one.`);
  }

  for (const info of state.kinds) {
    for (const setting of ["enabled", "default", "spares"] as const) settle(kindPath(info.id, setting));
    for (const size of [...PRESET_NAMES, "largest"] as SizeName[]) for (const part of SIZE_PARTS) settle(sizePath(info.id, size, part));
  }

  const next = read.document.backends;
  const removed = state.document.backends.filter((backend) => !next.some((each) => each.id === backend.id));
  for (const backend of removed) values.push([backendPath(backend.id), { kind: "removed" }]);
  for (const backend of next) {
    const before = state.document.backends.find((each) => each.id === backend.id);
    if (before) planBackend(state, target, backend, before, values, secretOf, file, settle);
    else planNewBackend(state, backend, values, secretOf, file, unset);
  }
  const expected = [...state.document.backends.filter((backend) => !removed.includes(backend)).map((backend) => backend.id), ...next.filter((backend) => !state.document.backends.some((each) => each.id === backend.id)).map((backend) => backend.id)];
  const order = next.map((backend) => backend.id);
  if (orderValue(order) !== orderValue(expected)) values.push([BACKEND_ORDER_PATH, plain(orderValue(order))]);

  const imagesNow = state.document.images ?? {};
  const imagesThen = read.document.images ?? {};
  for (const name of Object.keys(imagesNow)) if (!imagesThen[name]) values.push([imagePath(name), { kind: "removed" }]);
  for (const [name, image] of Object.entries(imagesThen)) {
    const now = imagesNow[name];
    if (!now || canonicalJson(now) !== canonicalJson(image)) values.push([imageDefinitionPath(name), plain(canonicalJson(image))]);
  }

  for (const type of read.unknownTypes) problems.push(`It has a backend of type ${type}, which this BB Box has no driver for, so the page cannot import it.`);
  return { values, problems, unset };
}

type SecretOf = (owner: string, key: string) => DraftRead["secrets"][string][string] | undefined;

function planNewBackend(state: ConfigState, backend: BackendConfig, values: [Path, EditValue][], secretOf: SecretOf, file: unknown, unset: string[]): void {
  const { id } = backend;
  const { fields, hostFields } = driverFields(state, backend.type);
  const name = newBackendName(state, id, backend.label);
  values.push([backendPath(id), { kind: "new-backend", type: backend.type, id, enabled: backend.enabled }]);
  if (backend.label) values.push([`${backendPath(id)}/label`, plain(backend.label)]);
  for (const field of fields) {
    const path = backendFieldPath(id, field.key);
    if (isSecretField(field)) {
      const text = secretOf(id, field.key) === "set" ? pastedSecret(file, id, field.key) : null;
      if (text !== null) values.push([path, { kind: "secret", text }]);
      else unset.push(`the ${field.label} of ${name}`);
      continue;
    }
    const raw = backend.fields[field.key];
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") values.push([path, plain(raw)]);
  }
  for (const [kind, count] of Object.entries(backend.warm ?? {})) values.push([warmPath(id, kind), plain(count)]);
  for (const host of backend.hosts ?? []) {
    const at = hostPath(id, host.name);
    values.push([at, { kind: "new-host", name: host.name, enabled: host.enabled }]);
    for (const field of hostFields) {
      const raw = host.fields[field.key];
      if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") values.push([hostFieldPath(at, field.key), plain(raw)]);
    }
  }
}

function planBackend(state: ConfigState, target: ConfigState, backend: BackendConfig, before: BackendConfig, values: [Path, EditValue][], secretOf: SecretOf, file: unknown, settle: (path: Path) => void): void {
  const { id } = backend;
  const { fields, hostFields } = driverFields(state, backend.type);
  settle(`${backendPath(id)}/enabled`);
  settle(`${backendPath(id)}/label`);
  for (const field of fields) {
    const path = backendFieldPath(id, field.key);
    if (!isSecretField(field)) {
      settle(path);
      continue;
    }
    const change = secretOf(id, field.key);
    const text = change === "set" ? pastedSecret(file, id, field.key) : null;
    if (text !== null) values.push([path, { kind: "secret", text }]);
    else if (change === "cleared" && secretIsSet(state, path)) values.push([path, { kind: "removed" }]);
  }
  for (const kind of new Set([...Object.keys(before.warm ?? {}), ...Object.keys(backend.warm ?? {})])) settle(warmPath(id, kind));
  const hostsThen = backend.hosts ?? [];
  for (const host of before.hosts ?? []) if (!hostsThen.some((each) => each.name === host.name)) values.push([hostPath(id, host.name), { kind: "removed" }]);
  for (const host of hostsThen) {
    const at = hostPath(id, host.name);
    if (!before.hosts?.some((each) => each.name === host.name)) {
      values.push([at, { kind: "new-host", name: host.name, enabled: host.enabled }]);
      for (const field of hostFields) {
        const raw = host.fields[field.key];
        if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") values.push([hostFieldPath(at, field.key), plain(raw)]);
      }
      continue;
    }
    settle(`${at}/enabled`);
    for (const field of hostFields) {
      const path = hostFieldPath(at, field.key);
      const { same, after } = sameStoredValue(state, target, path);
      if (!same) values.push([path, plain(after)]);
    }
  }
}

export interface ImportChange {
  readonly path: Path;
  readonly label: string;
  readonly before: string;
  readonly after: string;
  readonly secret: boolean;
  readonly under: boolean;
}

export interface ImportGroup {
  readonly place: string;
  readonly changes: readonly ImportChange[];
}

const PLACES: Readonly<Record<string, string>> = {
  "general/boxesPerThread": "Boxes",
  "general/enrol": "Boxes",
  "general/defaultKind": "Boxes",
  "general/video": "Boxes",
  "general/nightlyImages": "Images",
  "general/iosEncoder": "Devices",
  "general/encoderLedger": "Devices",
  "general/testDevice": "Devices",
};

const ENCODER_WORDS: Readonly<Record<string, string>> = { auto: "Automatic", hardware: "Hardware only", software: "Software only" };
const TAILNET_WORDS: Readonly<Record<string, string>> = { off: "No tailnet", oauth: "A Tailscale OAuth client" };

function capital(text: string): string {
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
}

function kindLabel(state: ConfigState, id: string): string {
  return state.kinds.find((kind) => kind.id === id)?.label ?? id;
}

function backendName(state: ConfigState, id: string, edits: ReadonlyMap<Path, Edit>): string {
  const config = state.document.backends.find((each) => each.id === id);
  if (config) return state.backends.find((each) => each.id === id)?.label ?? config.label ?? driverFields(state, config.type).label;
  const label = edits.get(`${backendPath(id)}/label`)?.value;
  return newBackendName(state, id, label?.kind === "plain" && typeof label.value === "string" ? label.value : null);
}

function placeOf(state: ConfigState, path: Path, edits: ReadonlyMap<Path, Edit>): string {
  if (PLACES[path]) return PLACES[path]!;
  if (path.startsWith("monitor/")) return "Monitor";
  if (path.startsWith("snapshots/")) return "Snapshots";
  if (tailnetKeyOf(path)) return "Network";
  if (fileOfPath(path) !== null) return "Files for every box";
  const kind = kindAt(path);
  if (kind) return `Kind: ${kindLabel(state, kind.id)}`;
  const backend = backendAt(path);
  if (backend) return backendName(state, backend.id, edits);
  if (imageAt(path)) return "Projects' images";
  if (path === BACKEND_ORDER_PATH) return "Backends";
  return "Other";
}

export function importValueWords(state: ConfigState, path: Path, value: PlainValue, edits: ReadonlyMap<Path, Edit> = new Map()): string {
  if (value === null) {
    if (kindAt(path)?.at === "size") return "The image's own disk";
    const fallback = fieldAt(state, path)?.default;
    if (typeof fallback === "boolean") return `${fallback ? "On" : "Off"}, the default`;
    return fallback === undefined || fallback === "" ? "Empty" : `Empty: ${String(fallback)}, the default`;
  }
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (path === "general/defaultKind") return kindLabel(state, String(value));
  if (path === "general/iosEncoder") return ENCODER_WORDS[String(value)] ?? String(value);
  if (path === tailnetPath("mode")) return TAILNET_WORDS[String(value)] ?? String(value);
  if (path === "monitor/refreshIntervalSeconds") return `${value} s`;
  if (path === snapshotPath("perBox")) return `${value} a box`;
  if (path === snapshotPath("roomPercent")) return `${value}% full`;
  if (path === snapshotPath("keepDays")) return `${value} days`;
  if (path.startsWith(ceilingPath("")) && typeof value === "number") return `${value} a month`;
  if (path === BACKEND_ORDER_PATH) return String(value).split(" ").filter(Boolean).map((id) => backendName(state, id, edits)).join(", then ");
  const kind = kindAt(path);
  if (kind?.at === "size" && kind.part !== "cores") return `${value} GiB`;
  if (kind?.at === "default") return capital(String(value));
  const field = fieldAt(state, path);
  if (field?.type === "number" && typeof value === "number" && /\(([^)]+)\)$/.test(field.label)) return `${value} ${/\(([^)]+)\)$/.exec(field.label)![1]}`;
  return String(value);
}

function imageWords(image: ImageConfig): string {
  const kinds = image.kinds.join(", ");
  const projects = image.projects.length === 1 ? "1 project" : `${image.projects.length} projects`;
  return `On ${kinds}, for ${projects}`;
}

function imageChangeWords(before: ImageConfig | undefined, after: ImageConfig | null): string {
  if (!after) return "Not readable";
  if (!before) return `Added: ${imageWords(after)}`;
  const parts: string[] = [];
  if (before.script !== after.script) parts.push("its script");
  if ((before.check ?? "") !== (after.check ?? "")) parts.push("its check script");
  if (canonicalJson(before.kinds) !== canonicalJson(after.kinds)) parts.push("its kinds");
  if (canonicalJson(before.projects) !== canonicalJson(after.projects)) parts.push("its projects");
  if ((before.bake ?? "auto") !== (after.bake ?? "auto")) parts.push("when it is built ahead");
  if (canonicalJson(before.source ?? null) !== canonicalJson(after.source ?? null)) parts.push("where its files came from");
  const changed = parts.length ? `${capital(parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]!)} ${parts.length > 1 ? "change" : "changes"}` : "Changed";
  return `${changed}: ${imageWords(after)}`;
}

function parsedImage(value: PlainValue): ImageConfig | null {
  try {
    return typeof value === "string" ? (JSON.parse(value) as ImageConfig) : null;
  } catch {
    return null;
  }
}

export function secretIsSet(state: ConfigState, path: Path): boolean {
  const set = (value: unknown) => record(value)?.set === true;
  const at = backendAt(path);
  if (at?.at === "field") return set(state.document.backends.find((backend) => backend.id === at.id)?.fields[at.key]);
  const tailnet = tailnetKeyOf(path);
  if (tailnet === "clientId" || tailnet === "clientSecret") return set(state.document.general.tailnet?.[tailnet]);
  const file = fileOfPath(path);
  return file !== null && set(state.document.general.files?.find((each) => each.path === file)?.content);
}

function storedWords(state: ConfigState, path: Path): string {
  const stored = storedAt(state, path);
  if (stored.kind === "gone") return "Not here";
  if (stored.kind === "version") return secretIsSet(state, path) ? "Set" : "Not set";
  return importValueWords(state, path, stored.value);
}

function isUnderNew(path: Path, edits: ReadonlyMap<Path, Edit>): boolean {
  const at = backendAt(path);
  if (!at || at.at === "backend") return false;
  if (edits.get(backendPath(at.id))?.value.kind === "new-backend") return true;
  return (at.at === "host-field" || at.at === "host-enabled") && edits.get(hostPath(at.id, at.host))?.value.kind === "new-host";
}

function changeOf(state: ConfigState, path: Path, edit: Edit, edits: ReadonlyMap<Path, Edit>): ImportChange {
  const value = edit.value;
  const under = isUnderNew(path, edits);
  const before = under ? "Not here" : storedWords(state, path);
  const base = { path, under, secret: false };
  const at = backendAt(path);
  const image = imageAt(path);
  switch (value.kind) {
    case "new-backend":
      return { ...base, label: "The backend", before: "Not here", after: value.enabled ? "Added, takes new boxes" : "Added, off" };
    case "new-host":
      return { ...base, label: `${capital(hostNoun(typeOfBackendId(at?.id ?? "")))} ${value.name}`, before: "Not here", after: value.enabled ? "Added, takes boxes" : "Added, off" };
    case "new-file":
      return { ...base, label: `~/${value.path}`, before: "Not here", after: "Added, with its content (not shown)", secret: true };
    case "secret":
      if (fileOfPath(path) !== null) return { ...base, label: `~/${fileOfPath(path)}`, before: storedWords(state, path) === "Not set" ? "No content" : "Its content", after: "New content (not shown)", secret: true };
      return { ...base, label: capital(labelOf(path, value, state)), before, after: "A new value (not shown)", secret: true };
    case "removed":
      if (at?.at === "backend") return { ...base, label: "The backend", before: "Here", after: "Removed: its secrets are deleted and its warm boxes go" };
      if (at?.at === "host") return { ...base, label: `${capital(hostNoun(typeOfBackendId(at.id)))} ${at.host}`, before: "Here", after: "Removed" };
      if (at?.at === "field") return { ...base, label: capital(labelOf(path, value, state)), before, after: "Cleared", secret: true };
      if (fileOfPath(path) !== null) return { ...base, label: `~/${fileOfPath(path)}`, before: "Here", after: "Removed, with its content" };
      if (image) return { ...base, label: `The image ${image.name}`, before: "Here", after: "Removed: its builds are deleted" };
      return { ...base, label: capital(labelOf(path, value, state)), before, after: "Removed" };
    case "plain": {
      if (image?.at === "definition") {
        const now = state.document.images?.[image.name];
        return { ...base, label: `The image ${image.name}`, before: now ? imageWords(now) : "Not here", after: imageChangeWords(now, parsedImage(value.value)) };
      }
      const label = kindAt(path)?.at === "enabled" ? "Offered to threads" : at?.at === "enabled" ? "Takes new boxes" : at?.at === "host-enabled" ? `${capital(hostNoun(typeOfBackendId(at.id)))} ${at.host} takes boxes` : capital(labelOf(path, value, state));
      return { ...base, label, before, after: importValueWords(state, path, documentValue(state, path, value.value), edits) };
    }
  }
}

export function importChanges(state: ConfigState, edits: ReadonlyMap<Path, Edit>): ImportGroup[] {
  const groups = new Map<string, ImportChange[]>();
  for (const [path, edit] of edits) {
    if (path === IMPORT_TEXT) continue;
    const place = placeOf(state, path, edits);
    groups.set(place, [...(groups.get(place) ?? []), changeOf(state, path, edit, edits)]);
  }
  return [...groups].map(([place, changes]) => ({ place, changes }));
}

export function importedPaths(edits: ReadonlyMap<Path, Edit>): Path[] {
  return [...edits.keys()].filter((path) => path !== IMPORT_TEXT);
}

export function exportedText(document: ConfigDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export interface SecretToGive {
  readonly owner: string;
  readonly what: string;
}

export function secretsToGive(state: ConfigState): SecretToGive[] {
  const given: SecretToGive[] = [];
  const set = (value: unknown) => record(value)?.set === true;
  for (const backend of state.document.backends) {
    const name = backendName(state, backend.id, new Map());
    for (const field of driverFields(state, backend.type).fields) if (isSecretField(field) && set(backend.fields[field.key])) given.push({ owner: name, what: `the ${field.label}` });
  }
  for (const file of state.document.general.files ?? []) if (set(file.content)) given.push({ owner: "Files for every box", what: `the content of ~/${file.path}` });
  const tailnet = state.document.general.tailnet;
  if (tailnet?.mode === "oauth") {
    if (set(tailnet.clientId)) given.push({ owner: "Network", what: "the OAuth client ID" });
    if (set(tailnet.clientSecret)) given.push({ owner: "Network", what: "the OAuth client secret" });
  }
  return given;
}
