import { pathProblem, type BoxFileSetting } from "../core/box-files.ts";
import type { ConfigDocument, Problem } from "../core/document.ts";
import type { ConfigState } from "../plugin/configuration.ts";
import { effectiveKind, isSecretState, kindChanges, withBackend, withGeneral, withKind, withMonitor } from "./config.ts";

export type Path = string;
export type PlainValue = string | number | boolean | null;

export type EditValue =
  | { readonly kind: "plain"; readonly value: PlainValue }
  | { readonly kind: "secret"; readonly text: string | null }
  | { readonly kind: "new-file"; readonly path: string; readonly text: string | null }
  | { readonly kind: "removed" };

export type Stored = { readonly kind: "value"; readonly value: PlainValue } | { readonly kind: "version"; readonly version: number | null };

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

export function plain(value: PlainValue): EditValue {
  return { kind: "plain", value };
}

export function filePath(path: string): Path {
  return `${FILES}${encodeURIComponent(path)}`;
}

export function newFilePath(id: string): Path {
  return `${FILES}${NEW_MARK}${id}`;
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

export function documentValue(defaults: Defaults, path: Path, value: PlainValue): PlainValue {
  const setting = settingOf(path);
  if (!setting) return value;
  const fallback = defaultOf(defaults, setting.section, setting.key);
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

export function storedAt(state: ConfigState, path: Path, value?: EditValue): Stored {
  const setting = settingOf(path);
  if (setting) {
    const values: Readonly<Record<string, unknown>> = setting.section === "general" ? { ...state.defaults.general, ...state.document.general } : { ...state.defaults.monitor, ...state.document.monitor };
    const found = values[setting.key];
    return { kind: "value", value: typeof found === "string" || typeof found === "number" || typeof found === "boolean" ? found : null };
  }
  const [section, id, key] = path.split("/");
  if (section === "kinds" && id && key === "enabled") return { kind: "value", value: effectiveKind(state, id).enabled };
  if (section === "backends" && id && key === "enabled") return { kind: "value", value: state.document.backends.find((backend) => backend.id === id)?.enabled ?? null };
  if (isFilePath(path)) {
    const file = value?.kind === "new-file" ? value.path.trim() : fileOfPath(path);
    return { kind: "version", version: file ? fileVersion(state.document, file) : null };
  }
  return { kind: "value", value: null };
}

export function conflictOf(state: ConfigState, edit: PathEdit): Conflict | null {
  const stored = storedAt(state, edit.path, edit.value);
  if (sameStored(stored, edit.base)) return null;
  if (edit.value.kind === "removed") return null;
  if (edit.value.kind === "plain") {
    if (stored.kind !== "value") return null;
    if (JSON.stringify(stored.value) === JSON.stringify(documentValue(state.defaults, edit.path, edit.value.value))) return null;
    if (stored.value === null && settingOf(edit.path) === null) return { kind: "removed" };
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
  return !(stored.kind === "value" && JSON.stringify(stored.value) === JSON.stringify(documentValue(state.defaults, edit.path, edit.value.value)));
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

function withFiles(document: ConfigDocument, edits: readonly PathEdit[]): { readonly document: ConfigDocument; readonly sentAs: Record<string, Path>; readonly needed: boolean } {
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

export function candidateOf(state: ConfigState, edits: readonly PathEdit[]): Candidate {
  const conflicts = edits.filter((edit) => conflictOf(state, edit) !== null).map((edit) => edit.path);
  let document = state.document;
  let needed = false;
  for (const edit of edits) {
    if (edit.value.kind !== "plain") continue;
    const setting = settingOf(edit.path);
    const value = documentValue(state.defaults, edit.path, edit.value.value);
    if (isChange(state, edit)) needed = true;
    if (setting) {
      document = writeSetting(state, document, setting.section, setting.key, value);
      continue;
    }
    const [section, id, key] = edit.path.split("/");
    if (section === "kinds" && id && key === "enabled" && typeof value === "boolean") {
      const current = { ...state, document };
      document = withKind(document, id, kindChanges(current, id, { ...effectiveKind(current, id), enabled: value }));
    } else if (section === "backends" && id && key === "enabled" && typeof value === "boolean") {
      const backend = document.backends.find((candidate) => candidate.id === id);
      if (backend) document = withBackend(document, { ...backend, enabled: value });
    }
  }
  const files = withFiles(document, edits);
  return { document: files.document, conflicts, needed: needed || files.needed, sentAs: files.sentAs };
}

export function problemPath(serverPath: string, sentAs: Readonly<Record<string, Path>>): Path {
  const file = /^(general\.files\.\d+)(?:\.(path|content))?$/.exec(serverPath);
  if (file) {
    const at = sentAs[file[1]!];
    if (at) return file[2] ? `${at}/${file[2]}` : at;
    return "files";
  }
  if (serverPath === "general.files") return "files";
  const setting = /^(general|monitor)\.([A-Za-z]+)$/.exec(serverPath);
  if (setting) return `${setting[1]}/${setting[2]}`;
  const kind = /^kinds\.([^.]+)$/.exec(serverPath);
  if (kind) return `kinds/${kind[1]}/enabled`;
  const backend = /^backends\.([^.]+)$/.exec(serverPath);
  if (backend) return `backends/${backend[1]}/enabled`;
  return serverPath;
}

export function draftProblems(problems: readonly Problem[], sentAs: Readonly<Record<string, Path>>): DraftProblem[] {
  return problems.map((problem) => ({ path: problemPath(problem.path, sentAs), message: problem.message }));
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

const SETTING_LABELS: Readonly<Record<string, string>> = {
  "general/boxesPerThread": "Boxes per thread",
  "general/enrol": "Boxes join BB as machines",
  "general/video": "Linux desktops as video",
  "general/nightlyImages": "Rebuild each night",
  "general/defaultKind": "Default kind",
  "monitor/enabled": "Machine status",
  "monitor/refreshIntervalSeconds": "Refresh every",
  "monitor/backgroundMonitoring": "Background monitoring",
  "monitor/pressureNotifications": "Pressure notifications",
};

export function labelOf(path: Path, value?: EditValue): string {
  const setting = SETTING_LABELS[path];
  if (setting) return setting;
  if (value?.kind === "new-file") return `the content of ~/${value.path.trim() || "the new file"}`;
  const file = fileOfPath(path);
  if (file !== null) return `the content of ~/${file}`;
  return path;
}
