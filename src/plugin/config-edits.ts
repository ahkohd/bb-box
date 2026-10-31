import { PluginCliError } from "@get-bb/plugin-sdk";
import type { FieldValue } from "../backends/types.ts";
import { GENERAL_DEFAULTS, MONITOR_DEFAULTS, MONITOR_REFRESH_SECONDS, SNAPSHOT_DEFAULTS, SNAPSHOT_LIMITS, isCents, sizeChanges, type BackendConfig, type ConfigDocument, type HostConfig, type KindConfig, type SecretState } from "../core/document.ts";
import { PRESETS, describeSize, kindSizes, type Preset, type SizeChange } from "../core/sizes.ts";
import { DEFAULT_TAILNET_TAGS } from "../core/tailnet.ts";
import type { FieldView } from "./configuration.ts";

export interface Change {
  readonly path: string;
  readonly words: string;
}

export interface Edited {
  readonly document: ConfigDocument;
  readonly changes: readonly Change[];
}

export interface FieldEdits {
  readonly set?: readonly (readonly [string, string])[];
  readonly setFromFile?: readonly (readonly [string, string])[];
  readonly unset?: readonly string[];
  readonly addLines?: readonly (readonly [string, string])[];
  readonly removeLines?: readonly (readonly [string, string])[];
  readonly secrets?: ReadonlyMap<string, string>;
  readonly clearSecrets?: readonly string[];
}

export interface BackendEdit extends FieldEdits {
  readonly enabled?: boolean;
  readonly label?: string | null;
  readonly warm?: readonly (readonly [string, number])[];
}

export interface DriverShape {
  readonly type: string;
  readonly label: string;
  readonly kinds: readonly string[];
  readonly fields: readonly FieldView[];
  readonly hostFields: readonly FieldView[];
}

const SECRET_INPUT_HINT = "Give a secret with --secret <field>=<VARIABLE> and --secrets-file <dotenv file> or --secrets-stdin, or with --secret-file <field>=<file>.";

function invalid(message: string, hint?: string): PluginCliError {
  return new PluginCliError(message, { code: "invalid_input", ...(hint ? { hint } : {}) });
}

export function pairOf(text: string, what: string): [string, string] {
  const at = text.indexOf("=");
  if (at <= 0) throw invalid(`Give ${what} as <name>=<value>, not "${text.length > 40 ? `${text.slice(0, 40)}…` : text}".`);
  return [text.slice(0, at).trim(), text.slice(at + 1)];
}

function isSecretState(value: unknown): value is SecretState {
  return typeof value === "object" && value !== null && "set" in value;
}

function isSecretField(field: FieldView): boolean {
  return field.type === "string" && (field as { secret?: boolean }).secret === true;
}

function shown(value: unknown): string {
  if (value === undefined) return "unset";
  if (isSecretState(value)) return value.set ? "set" : "not set";
  if (typeof value === "string" && value.includes("\n")) return `${value.split("\n").filter((line) => line.trim()).length} lines`;
  return JSON.stringify(value);
}

function defaultWords(field: FieldView): string {
  return field.default === undefined || field.default === "" ? "unset" : `${JSON.stringify(field.default)}, the default`;
}

function fieldNamed(fields: readonly FieldView[], key: string, owner: string): FieldView {
  const field = fields.find((candidate) => candidate.key === key);
  if (!field) throw invalid(`${owner} has no field "${key}". Its fields are ${fields.map((each) => each.key).join(", ") || "none"}.`, "bb box backend fields <type> lists them, with what each takes.");
  return field;
}

function plainField(fields: readonly FieldView[], key: string, owner: string): FieldView {
  const field = fieldNamed(fields, key, owner);
  if (isSecretField(field)) throw invalid(`${field.label} (${key}) is a secret, so it is never given on the command line, where other processes can read it.`, SECRET_INPUT_HINT);
  return field;
}

const TRUE_WORDS = new Set(["true", "on", "yes", "1"]);
const FALSE_WORDS = new Set(["false", "off", "no", "0"]);

export function booleanOf(text: string, name: string): boolean {
  const word = text.trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  throw invalid(`${name} is true or false, not "${text}".`);
}

function wholeOf(text: string, name: string, least: number, most: number): number {
  const value = Number(text.trim());
  if (!text.trim() || !Number.isInteger(value) || value < least || value > most) throw invalid(`${name} is a whole number from ${least} to ${most}, not "${text}".`);
  return value;
}

function valueOf(field: FieldView, raw: string): FieldValue {
  const name = `${field.label} (${field.key})`;
  if (field.type === "boolean") return booleanOf(raw, name);
  if (field.type === "number") {
    const value = Number(raw.trim());
    if (!raw.trim() || !Number.isFinite(value)) throw invalid(`${name} is a number, not "${raw}". --unset ${field.key} gives it its default.`);
    return value;
  }
  if (field.type === "select") {
    const options = (field as { options?: readonly string[] }).options ?? [];
    if (!options.includes(raw)) throw invalid(`${name} is one of ${options.join(", ")}, not "${raw}".`);
  }
  return raw;
}

function linesOf(value: unknown): string[] {
  return typeof value === "string" ? value.split("\n").filter((line) => line.trim()) : [];
}

function lineMatches(line: string, text: string): boolean {
  const trimmed = line.trim();
  const wanted = text.trim();
  return trimmed === wanted || trimmed.startsWith(`${wanted} `) || trimmed.startsWith(`${wanted}\t`);
}

function editedFields(
  current: Readonly<Record<string, FieldValue | SecretState>>,
  fields: readonly FieldView[],
  edits: FieldEdits,
  owner: string,
  path: string,
  secretsAllowed: boolean,
): { fields: Record<string, FieldValue | SecretState>; changes: Change[] } {
  const next: Record<string, FieldValue | SecretState> = { ...current };
  const changes: Change[] = [];
  const effective = (field: FieldView) => (next[field.key] === undefined ? field.default : next[field.key]);
  const note = (key: string, words: string) => changes.push({ path: `${path}.${key}`, words });
  for (const key of edits.unset ?? []) {
    const field = fieldNamed(fields, key, owner);
    if (isSecretField(field)) throw invalid(`${field.label} (${key}) is a secret: clear it with --clear-secret ${key}.`);
    if (next[key] === undefined) continue;
    note(key, `${shown(next[key])} → ${defaultWords(field)}`);
    delete next[key];
  }
  const setPlain = (key: string, raw: string) => {
    const field = plainField(fields, key, owner);
    const value = valueOf(field, raw);
    if (next[key] === value) return;
    const before = next[key] === undefined ? defaultWords(field) : shown(next[key]);
    next[key] = value;
    note(key, `${before} → ${value === "" ? '"" (empty)' : shown(value)}`);
  };
  for (const [key, raw] of edits.set ?? []) setPlain(key, raw);
  for (const [key, text] of edits.setFromFile ?? []) setPlain(key, text.replace(/\r\n/g, "\n").replace(/\n+$/, ""));
  for (const [key, line] of edits.addLines ?? []) {
    const field = plainField(fields, key, owner);
    if (field.type !== "string") throw invalid(`${field.label} (${key}) is a ${field.type}, not lines of text.`);
    const lines = linesOf(effective(field));
    if (lines.some((each) => each.trim() === line.trim())) continue;
    next[key] = [...lines, line.trim()].join("\n");
    note(key, `added the line "${line.trim()}"`);
  }
  for (const [key, text] of edits.removeLines ?? []) {
    const field = plainField(fields, key, owner);
    const lines = linesOf(effective(field));
    const kept = lines.filter((line) => !lineMatches(line, text));
    if (kept.length === lines.length) throw invalid(`No line of ${field.label} (${key}) is "${text}" or starts with it.`);
    next[key] = kept.join("\n");
    for (const line of lines.filter((each) => lineMatches(each, text))) note(key, `removed the line "${line.trim()}"`);
  }
  for (const [key, value] of edits.secrets ?? []) {
    const field = fieldNamed(fields, key, owner);
    if (!isSecretField(field)) throw invalid(`${field.label} (${key}) is not a secret: give it with --field ${key}=<value>.`);
    if (!secretsAllowed) throw invalid(`${owner} keeps no secrets.`);
    if (!value.trim()) throw invalid(`The value for ${key} is empty. To clear a secret, use --clear-secret ${key}.`);
    const before = next[key];
    next[key] = value;
    note(key, isSecretState(before) && before.set ? "replaced" : "set");
  }
  for (const key of edits.clearSecrets ?? []) {
    const field = fieldNamed(fields, key, owner);
    if (!isSecretField(field)) throw invalid(`${field.label} (${key}) is not a secret: use --unset ${key}.`);
    const before = next[key];
    if (isSecretState(before) && !before.set) continue;
    next[key] = { set: false };
    note(key, "cleared");
  }
  return { fields: next, changes };
}

export function backendIdOf(type: string, id: string | undefined): string {
  if (!id) return type;
  return id.includes(":") || id === type ? id : `${type}:${id}`;
}

export function findBackend(document: ConfigDocument, ref: string): BackendConfig {
  const backend = document.backends.find((candidate) => candidate.id === ref) ?? (document.backends.filter((candidate) => candidate.type === ref).length === 1 ? document.backends.find((candidate) => candidate.type === ref) : undefined);
  if (!backend) {
    const ids = document.backends.map((candidate) => candidate.id);
    throw new PluginCliError(`There is no backend ${ref}.${ids.length ? ` There are ${ids.join(", ")}.` : " There is none yet."}`, { code: "not_found", hint: "bb box backend list lists them, and bb box backend add <type> adds one." });
  }
  return backend;
}

export function driverOf(drivers: readonly DriverShape[], type: string): DriverShape {
  const driver = drivers.find((candidate) => candidate.type === type);
  if (!driver) throw invalid(`There is no backend type "${type}". The types are ${drivers.map((each) => each.type).join(", ")}.`, "bb box backend types lists them.");
  return driver;
}

function warmChanges(backend: BackendConfig, driver: DriverShape, warm: readonly (readonly [string, number])[] | undefined, path: string) {
  const next: Record<string, number> = { ...backend.warm };
  const changes: Change[] = [];
  for (const [kind, count] of warm ?? []) {
    if (!driver.kinds.includes(kind)) throw invalid(`${driver.label} makes ${driver.kinds.join(", ")}, not ${kind}.`);
    const before = next[kind] ?? 0;
    if (before === count) continue;
    if (count === 0) delete next[kind];
    else next[kind] = count;
    changes.push({ path: `${path}.warm.${kind}`, words: `${before} → ${count} warm` });
  }
  return { warm: next, changes };
}

function withBackend(document: ConfigDocument, backend: BackendConfig): ConfigDocument {
  return { ...document, backends: document.backends.map((candidate) => (candidate.id === backend.id ? backend : candidate)) };
}

function withoutEmpty<T extends object>(value: T, key: keyof T): T {
  const copy = { ...value };
  const part = copy[key];
  if (part && typeof part === "object" && !Object.keys(part).length) delete copy[key];
  return copy;
}

export function addBackend(document: ConfigDocument, drivers: readonly DriverShape[], type: string, id: string, edit: BackendEdit): Edited {
  const driver = driverOf(drivers, type);
  if (!id.startsWith(`${type}:`) && id !== type) throw invalid(`A ${type} backend's ID is "${type}", or "${type}:<name>".`);
  if (document.backends.some((backend) => backend.id === id)) {
    throw new PluginCliError(`There is a backend ${id} already.`, { code: "invalid_input", hint: `bb box backend set ${id} changes it; --id <name> adds another ${type} backend beside it, where the type allows it.` });
  }
  const path = `backends.${id}`;
  const base: BackendConfig = { id, type, enabled: edit.enabled ?? true, fields: {} };
  const fields = editedFields({}, driver.fields, edit, `Backend ${id}`, path, true);
  const warm = warmChanges(base, driver, edit.warm, path);
  const label = edit.label?.trim();
  const backend = withoutEmpty({ ...base, ...(label ? { label } : {}), fields: fields.fields, warm: warm.warm }, "warm");
  return {
    document: { ...document, backends: [...document.backends, backend] },
    changes: [{ path, words: `added, ${backend.enabled ? "on" : "off"}` }, ...fields.changes, ...warm.changes],
  };
}

export function setBackend(document: ConfigDocument, drivers: readonly DriverShape[], ref: string, edit: BackendEdit): Edited {
  const backend = findBackend(document, ref);
  const driver = driverOf(drivers, backend.type);
  const path = `backends.${backend.id}`;
  const changes: Change[] = [];
  let enabled = backend.enabled;
  if (edit.enabled !== undefined && edit.enabled !== backend.enabled) {
    enabled = edit.enabled;
    changes.push({ path: `${path}.enabled`, words: enabled ? "off → on" : "on → off" });
  }
  let label = backend.label;
  if (edit.label !== undefined) {
    const next = edit.label === null ? undefined : edit.label.trim() || undefined;
    if (next !== label) changes.push({ path: `${path}.label`, words: `${label ? JSON.stringify(label) : "the type's name"} → ${next ? JSON.stringify(next) : "the type's name"}` });
    label = next;
  }
  const fields = editedFields(backend.fields, driver.fields, edit, `Backend ${backend.id}`, path, true);
  const warm = warmChanges(backend, driver, edit.warm, path);
  const { label: _dropped, ...rest } = backend;
  const next = withoutEmpty({ ...rest, ...(label ? { label } : {}), enabled, fields: fields.fields, warm: warm.warm }, "warm");
  return { document: withBackend(document, next), changes: [...changes, ...fields.changes, ...warm.changes] };
}

export function removeBackend(document: ConfigDocument, ref: string): Edited {
  const backend = findBackend(document, ref);
  return { document: { ...document, backends: document.backends.filter((candidate) => candidate.id !== backend.id) }, changes: [{ path: `backends.${backend.id}`, words: "removed, with its secrets and warm boxes" }] };
}

const HOST_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

function hostDriver(backend: BackendConfig, drivers: readonly DriverShape[]): DriverShape {
  const driver = driverOf(drivers, backend.type);
  if (!driver.hostFields.length) {
    throw invalid(`${driver.label} has no hosts of its own.${driver.fields.some((field) => field.key === "machines") ? ` Its machines are lines of its machines field: bb box backend set ${backend.id} --add-line machines="<name> <address> <kinds>".` : ""}`);
  }
  return driver;
}

export interface HostEdit extends FieldEdits {
  readonly enabled?: boolean;
}

export function addHost(document: ConfigDocument, drivers: readonly DriverShape[], ref: string, name: string, edit: HostEdit): Edited {
  const backend = findBackend(document, ref);
  const driver = hostDriver(backend, drivers);
  if (!HOST_NAME.test(name)) throw invalid(`Name the host with lower-case letters, digits and "-", such as mac-1, not "${name}".`);
  if ((backend.hosts ?? []).some((host) => host.name === name)) throw invalid(`Backend ${backend.id} has a host ${name} already.`, `bb box backend host set ${backend.id} ${name} changes it.`);
  const path = `backends.${backend.id}.hosts.${name}`;
  const fields = editedFields({}, driver.hostFields, edit, `Host ${name} of backend ${backend.id}`, path, false);
  const host: HostConfig = { name, enabled: edit.enabled ?? true, fields: fields.fields as Record<string, FieldValue> };
  return { document: withBackend(document, { ...backend, hosts: [...(backend.hosts ?? []), host] }), changes: [{ path, words: `added, ${host.enabled ? "on" : "off"}` }, ...fields.changes] };
}

function hostOf(backend: BackendConfig, name: string): HostConfig {
  const host = (backend.hosts ?? []).find((candidate) => candidate.name === name);
  if (!host) throw new PluginCliError(`Backend ${backend.id} has no host ${name}.${backend.hosts?.length ? ` Its hosts are ${backend.hosts.map((each) => each.name).join(", ")}.` : ""}`, { code: "not_found" });
  return host;
}

export function setHost(document: ConfigDocument, drivers: readonly DriverShape[], ref: string, name: string, edit: HostEdit): Edited {
  const backend = findBackend(document, ref);
  const driver = hostDriver(backend, drivers);
  const host = hostOf(backend, name);
  const path = `backends.${backend.id}.hosts.${name}`;
  const fields = editedFields(host.fields, driver.hostFields, edit, `Host ${name} of backend ${backend.id}`, path, false);
  const enabled = edit.enabled ?? host.enabled;
  const changes = [...(enabled !== host.enabled ? [{ path: `${path}.enabled`, words: enabled ? "off → on" : "on → off" }] : []), ...fields.changes];
  const next: HostConfig = { ...host, enabled, fields: fields.fields as Record<string, FieldValue> };
  return { document: withBackend(document, { ...backend, hosts: (backend.hosts ?? []).map((candidate) => (candidate.name === name ? next : candidate)) }), changes };
}

export function removeHost(document: ConfigDocument, drivers: readonly DriverShape[], ref: string, name: string): Edited {
  const backend = findBackend(document, ref);
  hostDriver(backend, drivers);
  hostOf(backend, name);
  return { document: withBackend(document, { ...backend, hosts: (backend.hosts ?? []).filter((host) => host.name !== name) }), changes: [{ path: `backends.${backend.id}.hosts.${name}`, words: "removed" }] };
}

export interface KindEdit {
  readonly enabled?: boolean;
  readonly makeDefault?: boolean;
  readonly defaultPreset?: Preset;
  readonly preset?: Preset;
  readonly size?: { readonly cores?: number; readonly memoryGiB?: number; readonly diskGiB?: number | null };
  readonly largest?: { readonly cores?: number; readonly memoryGiB?: number; readonly diskGiB?: number };
  readonly spares?: number;
  readonly reset?: boolean;
}

function sizeChangeOf(part: { readonly cores?: number; readonly memoryGiB?: number; readonly diskGiB?: number | null } | undefined): SizeChange | null {
  if (!part) return null;
  const change: { cores?: number; memoryMiB?: number; diskGiB?: number | null } = {};
  if (part.cores !== undefined) change.cores = part.cores;
  if (part.memoryGiB !== undefined) change.memoryMiB = Math.round(part.memoryGiB * 1024);
  if (part.diskGiB !== undefined) change.diskGiB = part.diskGiB;
  return Object.keys(change).length ? change : null;
}

function sizesWords(kind: string, kinds: Readonly<Record<string, KindConfig>>): Map<string, string> {
  const sizes = kindSizes(kind, sizeChanges(kinds));
  const words = new Map<string, string>();
  for (const preset of PRESETS) words.set(preset, describeSize(sizes.presets[preset]));
  words.set("default", sizes.default);
  words.set("largest", describeSize(sizes.largest));
  return words;
}

export function setKind(document: ConfigDocument, knownKinds: readonly string[], kind: string, edit: KindEdit): Edited {
  if (!knownKinds.includes(kind)) throw invalid(`There is no kind "${kind}". The kinds are ${knownKinds.join(", ")}.`);
  if (edit.makeDefault && edit.enabled === false) throw invalid("The default kind stays on. Leave out --off, or choose another default.");
  const defaultKind = document.general.defaultKind ?? GENERAL_DEFAULTS.defaultKind;
  if (edit.enabled === false && !edit.makeDefault && kind === defaultKind) {
    throw invalid(`${kind} is the default kind, which stays on, as on the settings page. Choose another default first: bb box kind set <kind> --make-default.`);
  }
  const before = document.kinds[kind] ?? {};
  let entry: KindConfig = edit.reset ? {} : { ...before };
  if (edit.enabled !== undefined) entry = edit.enabled ? withoutKey(entry, "enabled") : { ...entry, enabled: false };
  if (edit.defaultPreset) entry = { ...entry, default: edit.defaultPreset };
  const sizes = kindSizes(kind, sizeChanges({ ...document.kinds, [kind]: entry }));
  const size = sizeChangeOf(edit.size);
  if (size) {
    const preset = edit.preset ?? sizes.default;
    entry = { ...entry, presets: { ...entry.presets, [preset]: { ...entry.presets?.[preset], ...size } } };
  } else if (edit.preset) throw invalid("--preset names the preset that --cores, --memory-gib and --disk-gib change. Give one of them with it.");
  const largest = sizeChangeOf(edit.largest);
  if (largest) entry = { ...entry, largest: { ...entry.largest, ...largest } };
  if (edit.spares !== undefined) entry = edit.spares === 0 ? withoutKey(entry, "spares") : { ...entry, spares: edit.spares };
  const kinds: Record<string, KindConfig> = { ...document.kinds };
  if (Object.keys(entry).length) kinds[kind] = entry;
  else delete kinds[kind];
  const path = `kinds.${kind}`;
  const changes: Change[] = [];
  if ((before.enabled !== false) !== (entry.enabled !== false)) changes.push({ path: `${path}.enabled`, words: entry.enabled === false ? "on → off" : "off → on" });
  const was = sizesWords(kind, document.kinds);
  const now = sizesWords(kind, kinds);
  for (const part of ["default", ...PRESETS, "largest"]) {
    if (was.get(part) !== now.get(part)) changes.push({ path: `${path}.${part === "default" ? "default" : part === "largest" ? "largest" : `presets.${part}`}`, words: `${was.get(part)} → ${now.get(part)}` });
  }
  if ((before.spares ?? 0) !== (entry.spares ?? 0)) changes.push({ path: `${path}.spares`, words: `${before.spares ?? 0} → ${entry.spares ?? 0} spare` });
  let general = document.general;
  if (edit.makeDefault && document.general.defaultKind !== kind) {
    changes.push({ path: "general.defaultKind", words: `${document.general.defaultKind ?? GENERAL_DEFAULTS.defaultKind} → ${kind}` });
    general = { ...general, defaultKind: kind };
  }
  return { document: { ...document, kinds, general }, changes };
}

export function kindSizeWords(kind: string, document: ConfigDocument): string {
  const words = sizesWords(kind, document.kinds);
  return `${kind}: ${PRESETS.map((preset) => `${preset} ${words.get(preset)}${preset === words.get("default") ? " (default)" : ""}`).join("; ")}; largest ${words.get("largest")}.`;
}

function withoutKey<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const { [key]: _gone, ...rest } = value;
  return rest;
}

type OptionType = { readonly kind: "boolean" } | { readonly kind: "whole"; readonly least: number; readonly most: number } | { readonly kind: "amount"; readonly least: number; readonly most: number } | { readonly kind: "choice"; readonly values: readonly string[] } | { readonly kind: "text" } | { readonly kind: "tags" } | { readonly kind: "secret" };

export interface OptionInfo {
  readonly name: string;
  readonly type: OptionType;
  readonly default: unknown;
  readonly help: string;
}

export const OPTIONS: readonly OptionInfo[] = [
  { name: "general.defaultKind", type: { kind: "text" }, default: GENERAL_DEFAULTS.defaultKind, help: "The kind a thread gets when it asks for none. It must be on." },
  { name: "general.boxesPerThread", type: { kind: "whole", least: 0, most: 10_000 }, default: GENERAL_DEFAULTS.boxesPerThread, help: "The most boxes a thread may hold at once; 0 for no limit." },
  { name: "general.enrol", type: { kind: "boolean" }, default: GENERAL_DEFAULTS.enrol, help: "Whether boxes join BB as machines, so threads and terminals can use them." },
  { name: "general.video", type: { kind: "boolean" }, default: GENERAL_DEFAULTS.video, help: "Whether Linux desktops drawn on the CPU show as video." },
  { name: "general.nightlyImages", type: { kind: "boolean" }, default: GENERAL_DEFAULTS.nightlyImages, help: "Whether bb-box rebuilds the standard images that are due at 03:00 each night." },
  { name: "general.identityResetBackends", type: { kind: "tags" }, default: "", help: "The backends whose new Linux boxes get an identity marker, so that a copy of one resets its identity (070), comma-separated backend IDs. None by default." },
  { name: "general.testDevice", type: { kind: "boolean" }, default: GENERAL_DEFAULTS.testDevice, help: "Advanced: whether Linux and macOS boxes offer the test device in place of a phone." },
  { name: "general.encoderLedger", type: { kind: "boolean" }, default: GENERAL_DEFAULTS.encoderLedger, help: "Advanced: whether each Mac's video encoder is shared out fairly between its iOS streams." },
  { name: "general.iosEncoder", type: { kind: "choice", values: ["auto", "hardware", "software"] }, default: GENERAL_DEFAULTS.iosEncoder, help: "Advanced: how an ios box's device video is encoded." },
  { name: "general.tailnet.mode", type: { kind: "choice", values: ["off", "oauth"] }, default: "off", help: "oauth joins the machines bb-box rents to your tailnet with a Tailscale OAuth client; off joins none." },
  { name: "general.tailnet.tags", type: { kind: "tags" }, default: DEFAULT_TAILNET_TAGS.join(","), help: "The tags machines join the tailnet with, comma-separated." },
  { name: "general.tailnet.clientId", type: { kind: "secret" }, default: null, help: "The Tailscale OAuth client's ID. A secret: give it with --secret." },
  { name: "general.tailnet.clientSecret", type: { kind: "secret" }, default: null, help: "The Tailscale OAuth client's secret. A secret: give it with --secret." },
  { name: "general.snapshots.perBox", type: { kind: "whole", ...SNAPSHOT_LIMITS.perBox }, default: SNAPSHOT_DEFAULTS.perBox, help: "The most snapshots a box holds; kept ones count, undos are counted apart." },
  { name: "general.snapshots.roomPercent", type: { kind: "whole", ...SNAPSHOT_LIMITS.roomPercent }, default: SNAPSHOT_DEFAULTS.roomPercent, help: "How full a host's storage may be, in percent, for bb-box to take a snapshot there; 7 points above it, bb-box deletes agents' snapshots nobody kept." },
  { name: "general.snapshots.keepDays", type: { kind: "whole", ...SNAPSHOT_LIMITS.keepDays }, default: SNAPSHOT_DEFAULTS.keepDays, help: "How many days Keep keeps a snapshot from the day it is kept, unless a date is given; bb-box deletes it after." },
  { name: "general.snapshots.agentsRestore", type: { kind: "boolean" }, default: SNAPSHOT_DEFAULTS.agentsRestore, help: "Whether an agent restores its thread's own boxes without asking, always with an undo; off, it asks for a yes in the thread through a form." },
  { name: "general.snapshots.agentsMemory", type: { kind: "boolean" }, default: SNAPSHOT_DEFAULTS.agentsMemory, help: "Whether an agent may restore a snapshot that holds a box's memory; off, only the person restores one." },
  { name: "monitor.enabled", type: { kind: "boolean" }, default: MONITOR_DEFAULTS.enabled, help: "Whether the Monitor runs: machine status in BB's sidebar, its sampling, background monitoring and its notifications. The sidebar changes when BB next loads." },
  { name: "monitor.refreshIntervalSeconds", type: { kind: "whole", least: MONITOR_REFRESH_SECONDS.least, most: MONITOR_REFRESH_SECONDS.most }, default: MONITOR_DEFAULTS.refreshIntervalSeconds, help: "Seconds between readings while machine status is open." },
  { name: "monitor.backgroundMonitoring", type: { kind: "boolean" }, default: MONITOR_DEFAULTS.backgroundMonitoring, help: "Whether bb-box checks BB's server's CPU and memory every 30 s while nobody looks." },
  { name: "monitor.pressureNotifications", type: { kind: "boolean" }, default: MONITOR_DEFAULTS.pressureNotifications, help: "Whether background monitoring shows a toast when CPU or memory stays high." },
  { name: "monitor.boxHistory", type: { kind: "boolean" }, default: MONITOR_DEFAULTS.boxHistory, help: "Whether bb-box keeps each box's history: a light reading of every running box once a minute, for the 1 h, 24 h and 7 d of a box's page." },
];

const CEILING_OPTION = /^general\.snapshots\.ceilings\.([A-Za-z0-9][A-Za-z0-9._-]*)$/;

export function ceilingOption(backend: string): OptionInfo {
  return {
    name: `general.snapshots.ceilings.${backend}`,
    type: { kind: "amount", ...SNAPSHOT_LIMITS.ceiling },
    default: SNAPSHOT_DEFAULTS.ceiling,
    help: `The most a month, in the provider's currency, that the paid snapshots held on backend ${backend} may cost, kept or not, undos included; a take, an undo, a Keep or a renewal past it is refused.`,
  };
}

export function optionsOf(document: ConfigDocument): OptionInfo[] {
  return [...OPTIONS, ...document.backends.map((backend) => ceilingOption(backend.id))];
}

export function optionNamed(name: string): OptionInfo {
  const full = name.startsWith("general.") || name.startsWith("monitor.") ? name : `general.${name}`;
  const ceiling = CEILING_OPTION.exec(full);
  if (ceiling) return ceilingOption(ceiling[1]!);
  const option = OPTIONS.find((candidate) => candidate.name === full);
  if (!option) throw invalid(`There is no option "${name}". The options are ${OPTIONS.map((each) => each.name).join(", ")}.`, "bb box option list shows each with its value.");
  return option;
}

function optionValue(option: OptionInfo, raw: string): unknown {
  const { type } = option;
  if (type.kind === "boolean") return booleanOf(raw, option.name);
  if (type.kind === "whole") return wholeOf(raw, option.name, type.least, type.most);
  if (type.kind === "amount") {
    const amount = Number(raw.trim().replace(/^\$/, ""));
    if (!raw.trim() || !isCents(amount, type.least, type.most)) throw invalid(`${option.name} is an amount a month from ${type.least} to ${type.most}, in whole cents, such as 5 or 7.50, not "${raw}".`);
    return amount;
  }
  if (type.kind === "choice") {
    if (!type.values.includes(raw)) throw invalid(`${option.name} is ${type.values.join(", ")}, not "${raw}".`);
    return raw;
  }
  if (type.kind === "tags") return raw.split(",").map((tag) => tag.trim()).filter(Boolean);
  if (type.kind === "secret") throw invalid(`${option.name} is a secret, so it is never given on the command line, where other processes can read it.`, "Give it with --secret <option>=<VARIABLE> and --secrets-file <dotenv file> or --secrets-stdin.");
  if (!raw.trim()) throw invalid(`Give ${option.name} a value, or unset it with bb box option unset ${option.name}.`);
  return raw.trim();
}

function partsOf(document: ConfigDocument) {
  return {
    general: { ...document.general } as Record<string, unknown>,
    monitor: { ...document.monitor } as Record<string, unknown>,
    tailnet: { ...(document.general.tailnet ?? { mode: "off" }) } as Record<string, unknown>,
    snapshots: { ...document.general.snapshots } as Record<string, unknown>,
  };
}

export function optionCurrent(document: ConfigDocument, option: OptionInfo): unknown {
  const [part, key, sub] = option.name.split(".") as [string, string, string | undefined];
  if (part === "monitor") return (document.monitor as Record<string, unknown> | undefined)?.[key];
  if (key === "tailnet") return (document.general.tailnet as Record<string, unknown> | undefined)?.[sub!];
  if (key === "snapshots" && sub === "ceilings") return document.general.snapshots?.ceilings?.[option.name.slice("general.snapshots.ceilings.".length)];
  if (key === "snapshots") return (document.general.snapshots as Record<string, unknown> | undefined)?.[sub!];
  return (document.general as Record<string, unknown>)[key];
}

function optionShown(value: unknown): string {
  if (Array.isArray(value)) return value.join(",");
  return shown(value);
}

function rebuilt(document: ConfigDocument, parts: ReturnType<typeof partsOf>, tailnetTouched: boolean): ConfigDocument {
  const general = { ...parts.general };
  if (tailnetTouched) general.tailnet = parts.tailnet;
  if (parts.snapshots.ceilings && !Object.keys(parts.snapshots.ceilings).length) delete parts.snapshots.ceilings;
  if (Object.keys(parts.snapshots).length) general.snapshots = parts.snapshots;
  else delete general.snapshots;
  const monitor = Object.keys(parts.monitor).length ? parts.monitor : undefined;
  const { monitor: _old, ...rest } = document;
  return { ...rest, general: general as ConfigDocument["general"], ...(monitor ? { monitor: monitor as ConfigDocument["monitor"] } : {}) };
}

export function setOptions(document: ConfigDocument, values: readonly (readonly [string, string])[], secrets: ReadonlyMap<string, string>, unset: readonly string[] = []): Edited {
  const parts = partsOf(document);
  const changes: Change[] = [];
  let tailnetTouched = false;
  const put = (option: OptionInfo, value: unknown) => {
    const [part, key, sub] = option.name.split(".") as [string, string, string | undefined];
    const ceiling = key === "snapshots" && sub === "ceilings" ? option.name.slice("general.snapshots.ceilings.".length) : null;
    if (ceiling !== null && value !== undefined && !document.backends.some((backend) => backend.id === ceiling)) {
      throw invalid(`There is no backend "${ceiling}" for a ceiling on paid snapshots.`, "bb box config show lists the backends' IDs.");
    }
    if (ceiling !== null) parts.snapshots.ceilings = { ...(parts.snapshots.ceilings as Record<string, number> | undefined) };
    const target = part === "monitor" ? parts.monitor : key === "tailnet" ? parts.tailnet : ceiling !== null ? (parts.snapshots.ceilings as Record<string, unknown>) : key === "snapshots" ? parts.snapshots : parts.general;
    const field = ceiling ?? (key === "tailnet" || key === "snapshots" ? sub! : key);
    if (key === "tailnet") tailnetTouched = true;
    const before = target[field];
    if (JSON.stringify(before) === JSON.stringify(value)) return;
    if (value === undefined) delete target[field];
    else target[field] = value;
    const words = option.type.kind === "secret" ? (value === null ? "cleared" : isSecretState(before) && before.set ? "replaced" : "set") : `${before === undefined ? `${optionShown(option.default)}, the default` : optionShown(before)} → ${value === undefined ? `${optionShown(option.default)}, the default` : optionShown(value)}`;
    changes.push({ path: option.name, words });
  };
  for (const name of unset) {
    const option = optionNamed(name);
    if (option.type.kind === "secret") put(option, null);
    else if (option.name === "general.tailnet.mode") {
      if (document.general.tailnet) {
        changes.push({ path: "general.tailnet", words: "removed: the tailnet is off" });
        delete parts.general.tailnet;
      }
    } else put(option, undefined);
  }
  for (const [name, raw] of values) put(optionNamed(name), optionValue(optionNamed(name), raw));
  for (const [name, value] of secrets) {
    const option = optionNamed(name);
    if (option.type.kind !== "secret") throw invalid(`${option.name} is not a secret: give it as ${option.name}=<value>.`);
    if (!value.trim()) throw invalid(`The value for ${option.name} is empty. To clear it, use bb box option unset ${option.name}.`);
    put(option, value);
  }
  if (tailnetTouched && parts.tailnet.mode !== "oauth" && [...secrets.keys()].some((name) => optionNamed(name).name.startsWith("general.tailnet."))) {
    throw invalid("The tailnet keeps its OAuth client only with general.tailnet.mode=oauth. Give it in the same command.");
  }
  return { document: rebuilt(document, parts, tailnetTouched), changes };
}

export function parseDotenv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.replace(/^\s*export\s+/, "");
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) continue;
    const name = match[1]!;
    let rest = match[2]!.replace(/^\s+/, "");
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const quote = rest[0]!;
      let body = rest.slice(1);
      while (!closes(body, quote) && index + 1 < lines.length) {
        index += 1;
        body += `\n${lines[index]}`;
      }
      const end = closingAt(body, quote);
      const inner = end === -1 ? body : body.slice(0, end);
      values.set(name, quote === '"' ? unescaped(inner) : inner);
      continue;
    }
    rest = rest.replace(/\s+#.*$/, "").trim();
    values.set(name, rest);
  }
  return values;
}

function closingAt(body: string, quote: string): number {
  for (let at = 0; at < body.length; at += 1) {
    if (quote === '"' && body[at] === "\\") {
      at += 1;
      continue;
    }
    if (body[at] === quote) return at;
  }
  return -1;
}

function closes(body: string, quote: string): boolean {
  return closingAt(body, quote) !== -1;
}

function unescaped(text: string): string {
  return text.replace(/\\(.)/g, (_all, character: string) => ({ n: "\n", r: "\r", t: "\t" })[character as "n" | "r" | "t"] ?? character);
}
