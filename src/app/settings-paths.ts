import { pathProblem, type BoxFileSetting } from "../core/box-files.ts";
import type { BackendConfig, ConfigDocument, HostConfig, Problem } from "../core/document.ts";
import type { TailnetSetting } from "../core/tailnet-settings.ts";
import type { FieldValue } from "../backends/types.ts";
import type { ConfigState, FieldView } from "../plugin/configuration.ts";
import { effectiveKind, isSecretField, isSecretState, kindChanges, withBackend, withGeneral, withKind, withMonitor, withoutBackend } from "./config.ts";

export type Path = string;
export type PlainValue = string | number | boolean | null;

export type EditValue =
  | { readonly kind: "plain"; readonly value: PlainValue }
  | { readonly kind: "secret"; readonly text: string | null }
  | { readonly kind: "new-file"; readonly path: string; readonly text: string | null }
  | { readonly kind: "new-host"; readonly name: string; readonly enabled: boolean }
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
  | { readonly kind: "removed" };

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
  return path.includes(`/${NEW_MARK}`);
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
  if (rest[0] !== "hosts" || !rest[1]) return null;
  const host = rest[1];
  const tail = rest.slice(2);
  if (!tail.length) return { at: "host", id, host };
  if (tail.length === 1 && tail[0] === "name") return { at: "host-name", id, host };
  if (tail.length === 1 && tail[0] === "enabled") return { at: "host-enabled", id, host };
  if (tail.length === 2 && tail[0] === "fields" && tail[1]) return { at: "host-field", id, host, key: tail[1] };
  return null;
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

function defaultOf(defaults: Defaults, section: "general" | "monitor", key: string): PlainValue | undefined {
  const values: Readonly<Record<string, unknown>> = section === "general" ? defaults.general : defaults.monitor;
  const value = values[key];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

function settingOf(path: Path): { readonly section: "general" | "monitor"; readonly key: string } | null {
  const [section, key, ...rest] = path.split("/");
  if ((section === "general" || section === "monitor") && key && !rest.length) return { section, key };
  return null;
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
  const type = backendIn(state.document, at.id)?.type ?? at.id.split(":")[0];
  const driver = state.drivers.find((candidate) => candidate.type === type);
  const fields = at.at === "field" ? driver?.fields : driver?.hostFields;
  return fields?.find((field) => field.key === at.key) ?? null;
}

function asPlain(value: unknown): PlainValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null;
}

function fieldValue(field: FieldView | null, value: PlainValue): PlainValue {
  if (!field || value === null) return value;
  if (field.type === "boolean") return value === (field.default ?? false) ? null : value;
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
  if (setting) {
    const values: Readonly<Record<string, unknown>> = setting.section === "general" ? { ...state.defaults.general, ...state.document.general } : { ...state.defaults.monitor, ...state.document.monitor };
    return { kind: "value", value: asPlain(values[setting.key]) };
  }
  const at = backendAt(path);
  if (at) return storedAtBackend(state, at, path);
  const [section, id, key] = path.split("/");
  if (section === "kinds" && id && key === "enabled") return { kind: "value", value: effectiveKind(state, id).enabled };
  if (isFilePath(path)) {
    const file = value?.kind === "new-file" ? value.path.trim() : fileOfPath(path);
    return { kind: "version", version: file ? fileVersion(state.document, file) : null };
  }
  return { kind: "value", value: null };
}

export function conflictOf(state: ConfigState, edit: PathEdit): Conflict | null {
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

function writeSetting(state: ConfigState, document: ConfigDocument, section: "general" | "monitor", key: string, value: PlainValue): ConfigDocument {
  const fallback = defaultOf(state.defaults, section, key);
  const kept = value === fallback ? undefined : value;
  return section === "general" ? withGeneral(document, { [key]: kept } as Partial<ConfigDocument["general"]>) : withMonitor(document, { [key]: kept } as Partial<NonNullable<ConfigDocument["monitor"]>>);
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
    const backend = backendIn(document, id);
    if (!backend) continue;
    if (list.some((edit) => backendAt(edit.path)?.at === "backend" && edit.value.kind === "removed")) {
      document = withoutBackend(document, id);
      needed = true;
      continue;
    }
    const fields: DraftFields = { ...backend.fields };
    let label = backend.label;
    let enabled = backend.enabled;
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
      sentAs[`backends.${id}.hosts.${index}`] = each.from;
    });
    const { label: _label, hosts: _hosts, ...rest } = backend;
    document = withBackend(document, {
      ...rest,
      ...(label ? { label } : {}),
      enabled,
      fields,
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
    const [section, id, key] = edit.path.split("/");
    if (setting) {
      if (isChange(state, edit)) needed = true;
      document = writeSetting(state, document, setting.section, setting.key, documentValue(state, edit.path, edit.value.value));
    } else if (section === "kinds" && id && key === "enabled" && typeof edit.value.value === "boolean") {
      if (isChange(state, edit)) needed = true;
      const current = { ...state, document };
      document = withKind(document, id, kindChanges(current, id, { ...effectiveKind(current, id), enabled: edit.value.value }));
    }
  }
  const backends = withBackendEdits(state, document, edits);
  const files = withFiles(backends.document, edits);
  const tailnet = withTailnet(state, files.document, edits);
  return { document: tailnet.document, conflicts, needed: needed || backends.needed || files.needed || tailnet.needed, sentAs: { ...backends.sentAs, ...files.sentAs } };
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
  const setting = /^(general|monitor)\.([A-Za-z]+)$/.exec(serverPath);
  if (setting) return `${setting[1]}/${setting[2]}`;
  const kind = /^kinds\.([^.]+)$/.exec(serverPath);
  if (kind) return `kinds/${kind[1]}/enabled`;
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

export function draftProblems(problems: readonly Problem[], sentAs: Readonly<Record<string, Path>>): DraftProblem[] {
  return problems.map((problem) => ({ path: problemPath(problem.path, sentAs), message: problem.message }));
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
  const type = backendIn(state.document, id)?.type ?? id.split(":")[0]!;
  return state.drivers.find((driver) => driver.type === type)?.label ?? type;
}

function hostEditProblems(state: ConfigState, edits: readonly PathEdit[]): DraftProblem[] {
  const problems: DraftProblem[] = [];
  const added = edits.flatMap((edit) => (edit.value.kind === "new-host" ? [{ path: edit.path, id: backendAt(edit.path)!.id, name: edit.value.name.trim() }] : []));
  const timesNamed = (id: string, name: string) => added.filter((each) => each.id === id && each.name === name).length;
  for (const { path, id, name } of added) {
    const backend = backendIn(state.document, id);
    const noun = hostNoun(backend?.type ?? id);
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
  return [...fileEditProblems(edits), ...secretEditProblems(state, edits), ...hostEditProblems(state, edits)];
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
  "monitor/enabled": "Machine status",
  "monitor/refreshIntervalSeconds": "Refresh every",
  "monitor/backgroundMonitoring": "Background monitoring",
  "monitor/pressureNotifications": "Pressure notifications",
};

function backendLabelOf(path: Path, value: EditValue | undefined, state: ConfigState | undefined): string | null {
  const at = backendAt(path);
  if (!at) return null;
  if (at.at === "label") return "Name";
  if (at.at === "field" || at.at === "host-field") {
    const label = (state && fieldAt(state, path)?.label) ?? at.key;
    const field = state ? fieldAt(state, path) : null;
    const named = field && isSecretField(field) ? `the ${label}` : label;
    return at.at === "field" ? named : `${named} on ${isNewHost(at.host) ? "the new Mac" : at.host}`;
  }
  if (at.at === "host") return value?.kind === "new-host" ? value.name.trim() || "the new Mac" : at.host;
  return null;
}

export function labelOf(path: Path, value?: EditValue, state?: ConfigState): string {
  const setting = SETTING_LABELS[path];
  if (setting) return setting;
  if (value?.kind === "new-file") return `the content of ~/${value.path.trim() || "the new file"}`;
  const file = fileOfPath(path);
  if (file !== null) return `the content of ~/${file}`;
  return backendLabelOf(path, value, state) ?? path;
}
