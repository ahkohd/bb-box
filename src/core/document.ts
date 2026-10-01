// bb-box's configuration: one checked document in plugin storage (029). It
// holds what the operator set; a value left out takes bb-box's default, so a
// later release's default reaches it. Secrets are kept apart from it, under
// a key of their own, and never leave bb-box: the document shows each as
// { set: true } or { set: false }.
//
// Every problem has a path, such as "backends.proxmox-lxc.url" or
// "kinds.linux.presets.small", so the settings page can show it by its field.

import { currentKindId, isEarlierKindId } from "../backends/kinds.ts";
import { isSecret, type BackendDriver, type BackendPart, type BoxSize, type FieldDescriptor, type FieldValue } from "../backends/types.ts";
import { PRESETS, describeSize, fits, kindSizes, type KindSizesChange, type Preset, type SizeChange, type SizeChanges } from "./sizes.ts";

export const SCHEMA = 1;

/** How a secret shows outside bb-box. In a draft, { set: true } keeps it. */
export interface SecretState {
  readonly set: boolean;
}

export interface HostConfig {
  /** Lower-case letters, digits and "-", unique in its backend. */
  readonly name: string;
  readonly enabled: boolean;
  readonly fields: Readonly<Record<string, FieldValue>>;
}

export interface BackendConfig {
  /** The type, or "<type>:<name>" for another backend of the type. */
  readonly id: string;
  /** The driver. */
  readonly type: string;
  /** Display name. The driver's label when left out. */
  readonly label?: string;
  readonly enabled: boolean;
  /** What the operator set. Stored without secrets; shown with each as its state. */
  readonly fields: Readonly<Record<string, FieldValue | SecretState>>;
  /** Ready guests to keep, by kind. */
  readonly warm?: Readonly<Record<string, number>>;
  /** For a driver with host fields. */
  readonly hosts?: readonly HostConfig[];
}

export interface KindConfig {
  readonly enabled?: boolean;
  readonly presets?: Partial<Readonly<Record<Preset, SizeChange>>>;
  readonly default?: Preset;
  readonly largest?: SizeChange;
  /** Spare boxes to keep: ready, enrolled and owned by no thread (032). */
  readonly spares?: number;
}

export interface GeneralSettings {
  /** 0 means no limit. */
  readonly boxesPerThread?: number;
  readonly enrol?: boolean;
  readonly defaultKind?: string;
}

export interface ConfigDocument {
  readonly schema: typeof SCHEMA;
  readonly revision: number;
  /** In the order the registry tries them. */
  readonly backends: readonly BackendConfig[];
  readonly kinds: Readonly<Record<string, KindConfig>>;
  readonly general: GeneralSettings;
}

/** Secret values by backend ID and field. Never leaves bb-box. */
export type Secrets = Readonly<Record<string, Readonly<Record<string, string>>>>;

export interface Problem {
  readonly path: string;
  readonly message: string;
}

export const GENERAL_DEFAULTS = { boxesPerThread: 0, enrol: true, defaultKind: "linux" } as const;

export const MAX_WARM = 20;
export const MAX_SPARES = 10;

export function emptyDocument(revision = 0): ConfigDocument {
  return { schema: SCHEMA, revision, backends: [], kinds: {}, general: {} };
}

/** The general settings with defaults filled in, and each kind's sizes as core reads them. */
export interface GeneralConfig {
  /** Most boxes one thread may hold, or null for no limit. */
  readonly perThreadLimit: number | null;
  /** Enrol boxes whose kind can enrol as BB machines. */
  readonly enrol: boolean;
  /** The kind a box gets when none is asked for. */
  readonly defaultKind: string;
  /** Changes to the shipped box sizes, by kind (028). */
  readonly sizes: SizeChanges;
  /** Spare boxes to keep, by kind (032). A kind that is off keeps none. */
  readonly spares: Readonly<Record<string, number>>;
}

export function generalConfig(document: ConfigDocument): GeneralConfig {
  const limit = document.general.boxesPerThread ?? GENERAL_DEFAULTS.boxesPerThread;
  return {
    perThreadLimit: limit > 0 ? limit : null,
    enrol: document.general.enrol ?? GENERAL_DEFAULTS.enrol,
    defaultKind: document.general.defaultKind ?? GENERAL_DEFAULTS.defaultKind,
    sizes: sizeChanges(document.kinds),
    spares: Object.fromEntries(
      Object.entries(document.kinds).flatMap(([kind, config]) => (config.spares && kindOn(document, kind) ? [[kind, config.spares]] : [])),
    ),
  };
}

/** The kinds' sizes in the form sizes.ts reads. */
export function sizeChanges(kinds: Readonly<Record<string, KindConfig>>): SizeChanges {
  const changes: Record<string, KindSizesChange> = {};
  for (const [kind, config] of Object.entries(kinds)) {
    const change: KindSizesChange = { ...config.presets, ...(config.default ? { default: config.default } : {}), ...(config.largest ? { largest: config.largest } : {}) };
    if (Object.keys(change).length) changes[kind] = change;
  }
  return changes;
}

export function kindOn(document: ConfigDocument, kind: string): boolean {
  return document.kinds[kind]?.enabled !== false;
}

/** Every kind a driver can make, in driver order. */
export function knownKinds(drivers: readonly BackendDriver<any>[]): string[] {
  return [...new Set(drivers.flatMap((driver) => driver.kinds))];
}

/** The ID of the first backend of a type is the type; another is "<type>:<name>". */
const ID = /^([a-z0-9][a-z0-9-]*)(?::([a-z0-9][a-z0-9-]{0,62}))?$/;
const HOST_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWhole(value: unknown, least: number, most = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= least && value <= most;
}

function isSecretState(value: unknown): value is SecretState {
  return isRecord(value) && typeof value.set === "boolean" && Object.keys(value).length === 1;
}

/** What a draft does to the stored secrets: a string replaces one, null clears it. Left out keeps it. */
export type SecretChanges = Readonly<Record<string, Readonly<Record<string, string | null>>>>;

/**
 * A draft as JSON: the document, its secret changes, and problems with its
 * shape. Parts in the wrong shape are left out of the document, so the
 * problems block the write.
 */
export function readDraft(input: unknown, drivers: readonly BackendDriver<any>[]): { document: ConfigDocument; secrets: SecretChanges; problems: Problem[] } {
  const problems: Problem[] = [];
  const secrets: Record<string, Record<string, string | null>> = {};
  const problem = (path: string, message: string) => problems.push({ path, message });
  if (!isRecord(input)) {
    problem("", "The configuration must be a JSON object with backends, kinds and general.");
    return { document: emptyDocument(), secrets, problems };
  }
  const known = new Set(["schema", "revision", "backends", "kinds", "general"]);
  for (const key of Object.keys(input)) if (!known.has(key)) problem(key, `There is no "${key}" in the configuration. It has backends, kinds and general.`);
  if (input.schema !== undefined && input.schema !== SCHEMA) problem("schema", `This bb-box reads schema ${SCHEMA}, not ${String(input.schema)}.`);
  const revision = isWhole(input.revision, 0) ? input.revision : 0;

  const general: Record<string, unknown> = {};
  if (input.general !== undefined) {
    if (!isRecord(input.general)) problem("general", "general must be an object with boxesPerThread, enrol and defaultKind.");
    else {
      for (const [key, value] of Object.entries(input.general)) {
        if (value === undefined || value === null) continue;
        if (key === "boxesPerThread") {
          if (isWhole(value, 0, 10_000)) general[key] = value;
          else problem("general.boxesPerThread", "Use a whole number of boxes per thread, or 0 for no limit.");
        } else if (key === "enrol") {
          if (typeof value === "boolean") general[key] = value;
          else problem("general.enrol", "enrol is true or false.");
        } else if (key === "defaultKind") {
          if (typeof value === "string" && value) general[key] = value;
          else problem("general.defaultKind", "Name the default kind, such as linux.");
        } else problem(`general.${key}`, `There is no general setting "${key}". There are boxesPerThread, enrol and defaultKind.`);
      }
    }
  }

  const kinds: Record<string, KindConfig> = {};
  if (input.kinds !== undefined) {
    if (!isRecord(input.kinds)) problem("kinds", "kinds must be an object with an entry per kind, such as linux.");
    else for (const [id, value] of Object.entries(input.kinds)) {
      const kind = readKind(`kinds.${id}`, value, problem);
      if (kind) kinds[id] = kind;
    }
  }

  const backends: BackendConfig[] = [];
  if (input.backends !== undefined) {
    if (!Array.isArray(input.backends)) problem("backends", "backends must be a list.");
    else input.backends.forEach((value, index) => {
      const backend = readBackend(index, value, drivers, problem, secrets);
      if (backend) backends.push(backend);
    });
  }
  return { document: { schema: SCHEMA, revision, backends, kinds, general: general as GeneralSettings }, secrets, problems };
}

function readSize(path: string, value: unknown, largest: boolean, problem: (path: string, message: string) => void): SizeChange | undefined {
  if (!isRecord(value)) {
    problem(path, "A size is an object with cores, memoryMiB and diskGiB.");
    return undefined;
  }
  const size: { cores?: number; memoryMiB?: number; diskGiB?: number | null } = {};
  for (const [key, part] of Object.entries(value)) {
    if (part === undefined) continue;
    if (key === "cores") {
      if (isWhole(part, 1, 1024)) size.cores = part;
      else problem(`${path}.cores`, "Cores is a whole number from 1 to 1024.");
    } else if (key === "memoryMiB") {
      if (isWhole(part, 256, 16_777_216)) size.memoryMiB = part;
      else problem(`${path}.memoryMiB`, "Memory is a whole number of MiB, at least 256.");
    } else if (key === "diskGiB") {
      if (part === null && !largest) size.diskGiB = null;
      else if (isWhole(part, 1, 65_536)) size.diskGiB = part;
      else problem(`${path}.diskGiB`, `Disk is a whole number of GiB, at least 1${largest ? "" : ", or null for the base disk"}.`);
    } else problem(`${path}.${key}`, `A size has cores, memoryMiB and diskGiB, not "${key}".`);
  }
  return size;
}

function readKind(path: string, value: unknown, problem: (path: string, message: string) => void): KindConfig | undefined {
  if (!isRecord(value)) {
    problem(path, "A kind is an object with enabled, presets, default, largest and spares.");
    return undefined;
  }
  const kind: { enabled?: boolean; presets?: Partial<Record<Preset, SizeChange>>; default?: Preset; largest?: SizeChange; spares?: number } = {};
  for (const [key, part] of Object.entries(value)) {
    if (part === undefined || part === null) continue;
    if (key === "enabled") {
      if (typeof part === "boolean") kind.enabled = part;
      else problem(`${path}.enabled`, "enabled is true or false.");
    } else if (key === "default") {
      if (PRESETS.includes(part as Preset)) kind.default = part as Preset;
      else problem(`${path}.default`, "The default preset is small, medium or large.");
    } else if (key === "largest") {
      kind.largest = readSize(`${path}.largest`, part, true, problem);
    } else if (key === "spares") {
      if (typeof part === "number") kind.spares = part;
      else problem(`${path}.spares`, "Give the spare boxes as a number.");
    } else if (key === "presets") {
      if (!isRecord(part)) {
        problem(`${path}.presets`, "presets is an object with small, medium and large.");
        continue;
      }
      const presets: Partial<Record<Preset, SizeChange>> = {};
      for (const [name, size] of Object.entries(part)) {
        if (size === undefined || size === null) continue;
        if (!PRESETS.includes(name as Preset)) problem(`${path}.presets.${name}`, `The presets are small, medium and large, not "${name}".`);
        else presets[name as Preset] = readSize(`${path}.presets.${name}`, size, false, problem);
      }
      kind.presets = presets;
    } else problem(`${path}.${key}`, `A kind has enabled, presets, default, largest and spares, not "${key}".`);
  }
  return kind;
}

function readFields(
  path: string,
  value: unknown,
  descriptors: Readonly<Record<string, FieldDescriptor>>,
  problem: (path: string, message: string) => void,
  secrets: Record<string, string | null> | null,
): Record<string, FieldValue> {
  const fields: Record<string, FieldValue> = {};
  if (value === undefined) return fields;
  if (!isRecord(value)) {
    problem(path, "fields is an object.");
    return fields;
  }
  for (const [key, raw] of Object.entries(value)) {
    const descriptor = descriptors[key];
    const at = `${path}.${key}`;
    if (!descriptor) {
      problem(at, `There is no field "${key}". The fields are ${Object.keys(descriptors).join(", ") || "none"}.`);
      continue;
    }
    if (isSecret(descriptor) && secrets) {
      if (raw === undefined || isSecretState(raw)) {
        if (isSecretState(raw) && !raw.set) secrets[key] = null;
        continue;
      }
      if (raw === null || typeof raw === "string") secrets[key] = raw === "" ? null : raw;
      else problem(at, `${descriptor.label} is a secret: give it as a string, null to clear it, or {"set": true} to keep it.`);
      continue;
    }
    if (raw === undefined || raw === null) continue;
    const type = descriptor.type === "select" || descriptor.type === "project" ? "string" : descriptor.type;
    if (typeof raw !== type) {
      problem(at, `${descriptor.label} is a ${type}.`);
      continue;
    }
    if (descriptor.type === "select" && !descriptor.options.includes(raw as string)) {
      problem(at, `${descriptor.label} is one of ${descriptor.options.join(", ")}.`);
      continue;
    }
    fields[key] = raw as FieldValue;
  }
  return fields;
}

function readBackend(
  index: number,
  value: unknown,
  drivers: readonly BackendDriver<any>[],
  problem: (path: string, message: string) => void,
  secrets: Record<string, Record<string, string | null>>,
): BackendConfig | null {
  if (!isRecord(value)) {
    problem(`backends.${index}`, "A backend is an object with id, type, enabled and fields.");
    return null;
  }
  const driver = drivers.find((candidate) => candidate.type === value.type);
  if (!driver) return unknownBackend(index, value, drivers, problem);
  const id = typeof value.id === "string" ? value.id : driver.type;
  const match = ID.exec(id);
  if (!match || match[1] !== driver.type) {
    problem(`backends.${index}.id`, `A ${driver.type} backend's ID is "${driver.type}", or "${driver.type}:<name>" with lower-case letters, digits and "-".`);
    return null;
  }
  const path = `backends.${id}`;
  const known = new Set(["id", "type", "label", "enabled", "fields", "warm", "hosts"]);
  for (const key of Object.keys(value)) if (!known.has(key)) problem(`${path}.${key}`, `A backend has id, type, label, enabled, fields, warm and hosts, not "${key}".`);
  let label: string | undefined;
  if (value.label !== undefined && value.label !== null) {
    if (typeof value.label === "string" && value.label.trim() && value.label.length <= 64) label = value.label.trim();
    else problem(`${path}.label`, "Give the backend a name of up to 64 characters, or leave it out.");
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") problem(`${path}.enabled`, "enabled is true or false.");
  const backendSecrets: Record<string, string | null> = {};
  const fields = readFields(`${path}`, value.fields, driver.fields, problem, backendSecrets);
  if (Object.keys(backendSecrets).length) secrets[id] = backendSecrets;

  const warm: Record<string, number> = {};
  if (value.warm !== undefined && value.warm !== null) {
    if (!isRecord(value.warm)) problem(`${path}.warm`, "warm is an object with a count per kind.");
    else for (const [kind, count] of Object.entries(value.warm)) {
      if (typeof count !== "number") problem(`${path}.warm.${kind}`, `Give the warm ${kind} boxes as a number.`);
      else if (count !== 0) warm[kind] = count;
    }
  }

  let hosts: HostConfig[] | undefined;
  if (value.hosts !== undefined && value.hosts !== null) {
    if (!driver.hostFields) problem(`${path}.hosts`, `${driver.label} has no hosts.`);
    else if (!Array.isArray(value.hosts)) problem(`${path}.hosts`, "hosts is a list.");
    else {
      hosts = [];
      value.hosts.forEach((host, n) => {
        const at = `${path}.hosts.${n}`;
        if (!isRecord(host)) return problem(at, "A host is an object with name, enabled and fields.");
        for (const key of Object.keys(host)) if (!["name", "enabled", "fields"].includes(key)) problem(`${at}.${key}`, `A host has name, enabled and fields, not "${key}".`);
        if (typeof host.name !== "string" || !HOST_NAME.test(host.name)) return problem(`${at}.name`, 'Name the host with lower-case letters, digits and "-".');
        if (host.enabled !== undefined && typeof host.enabled !== "boolean") problem(`${at}.enabled`, "enabled is true or false.");
        hosts!.push({ name: host.name, enabled: host.enabled !== false, fields: readFields(`${at}`, host.fields, driver.hostFields!, problem, null) });
      });
    }
  }
  return {
    id,
    type: driver.type,
    ...(label ? { label } : {}),
    enabled: value.enabled === true,
    fields,
    ...(Object.keys(warm).length ? { warm } : {}),
    ...(hosts ? { hosts } : {}),
  };
}

/**
 * A backend of a type this bb-box has no driver for, as after going back to
 * an earlier version: kept as it is, unchecked, so a draft that leaves it
 * alone can still be saved. checkDocument says it cannot run.
 */
function unknownBackend(
  index: number,
  value: Record<string, unknown>,
  drivers: readonly BackendDriver<any>[],
  problem: (path: string, message: string) => void,
): BackendConfig | null {
  const type = value.type;
  const match = typeof value.id === "string" ? ID.exec(value.id) : null;
  if (typeof type !== "string" || !match || match[1] !== type) {
    problem(`backends.${index}.type`, `There is no backend type "${String(type)}". The types are ${drivers.map((each) => each.type).join(", ")}.`);
    return null;
  }
  const fields: Record<string, FieldValue> = {};
  for (const [key, field] of Object.entries(isRecord(value.fields) ? value.fields : {})) {
    if (typeof field === "string" || typeof field === "number" || typeof field === "boolean") fields[key] = field;
  }
  return {
    ...(value as unknown as BackendConfig),
    id: value.id as string,
    type,
    enabled: value.enabled === true,
    fields,
  };
}

/** The secrets once a draft's changes are applied. Only backends in the document keep theirs. */
export function withSecretChanges(stored: Secrets, changes: SecretChanges, document: ConfigDocument): Secrets {
  const next: Record<string, Record<string, string>> = {};
  for (const backend of document.backends) {
    const values: Record<string, string> = { ...stored[backend.id] };
    for (const [field, value] of Object.entries(changes[backend.id] ?? {})) {
      if (value === null) delete values[field];
      else values[field] = value;
    }
    if (Object.keys(values).length) next[backend.id] = values;
  }
  return next;
}

/** A backend's part for its driver: every declared field, set or default, with its secrets. */
export function backendPart(backend: BackendConfig, driver: BackendDriver<any>, secrets: Secrets): BackendPart {
  const filled = (descriptors: Readonly<Record<string, FieldDescriptor>>, set: Readonly<Record<string, unknown>>, secret: Readonly<Record<string, string>>) => {
    const fields: Record<string, FieldValue | undefined> = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (isSecret(descriptor)) fields[key] = secret[key];
      else {
        const value = set[key];
        fields[key] = typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : (descriptor.default as FieldValue | undefined);
      }
    }
    return fields;
  };
  return {
    id: backend.id,
    fields: filled(driver.fields, backend.fields, secrets[backend.id] ?? {}),
    hosts: (backend.hosts ?? []).map((host) => ({ name: host.name, fields: filled(driver.hostFields ?? {}, host.fields, {}) })),
  };
}

/** The document as it leaves bb-box: each secret field as whether it is set. */
export function exported(document: ConfigDocument, secrets: Secrets, drivers: readonly BackendDriver<any>[]): ConfigDocument {
  return {
    ...document,
    backends: document.backends.map((backend) => {
      const driver = drivers.find((candidate) => candidate.type === backend.type);
      const fields: Record<string, FieldValue | SecretState> = {};
      for (const [key, value] of Object.entries(backend.fields)) if (!isSecretState(value)) fields[key] = value;
      for (const [key, descriptor] of Object.entries(driver?.fields ?? {})) {
        if (isSecret(descriptor)) fields[key] = { set: secrets[backend.id]?.[key] !== undefined };
      }
      return { ...backend, fields };
    }),
  };
}

/** The document as stored: no secret field. */
export function withoutSecrets(document: ConfigDocument, drivers: readonly BackendDriver<any>[]): ConfigDocument {
  return {
    ...document,
    backends: document.backends.map((backend) => {
      const driver = drivers.find((candidate) => candidate.type === backend.type);
      const fields: Record<string, FieldValue> = {};
      for (const [key, value] of Object.entries(backend.fields)) {
        if (isSecretState(value) || (driver?.fields[key] && isSecret(driver.fields[key]))) continue;
        fields[key] = value;
      }
      return { ...backend, fields };
    }),
  };
}

/** Boxes in use, for the checks that refuse to remove or rename what has boxes. */
export interface InUse {
  /** Boxes by backend ID, any state but gone, acquiring and releasing too. */
  readonly backends: ReadonlyMap<string, number>;
  /** Boxes by backend ID and the name of a host the configuration lists. */
  readonly hosts: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

export const NOTHING_IN_USE: InUse = { backends: new Map(), hosts: new Map() };

/**
 * Every problem in a document whose shape `readDraft` checked. With `before`,
 * the document it replaces, also refuses removing a backend or host that has
 * boxes.
 */
export function checkDocument(
  document: ConfigDocument,
  secrets: Secrets,
  drivers: readonly BackendDriver<any>[],
  inUse: InUse = NOTHING_IN_USE,
): Problem[] {
  const problems: Problem[] = [];
  const problem = (path: string, message: string) => problems.push({ path, message });
  const kinds = knownKinds(drivers);

  for (const [id, kind] of Object.entries(document.kinds)) {
    const path = `kinds.${id}`;
    if (isEarlierKindId(id)) {
      problem(path, `${id} is now called ${currentKindId(id)}. Use that.`);
      continue;
    }
    if (!kinds.includes(id)) {
      problem(path, `There is no kind "${id}". The kinds are ${kinds.join(", ")}.`);
      continue;
    }
    const sizes = kindSizes(id, sizeChanges({ [id]: kind }));
    for (const preset of PRESETS) {
      if (!fits(sizes.presets[preset], sizes.largest)) {
        problem(`${path}.presets.${preset}`, `The ${preset} ${id} preset, ${describeSize(sizes.presets[preset])}, is above the largest size, ${describeSize(sizes.largest)}.`);
      }
    }
    if (kind.spares !== undefined && !isWhole(kind.spares, 0, MAX_SPARES)) problem(`${path}.spares`, `Keep 0 to ${MAX_SPARES} spare ${id} boxes.`);
  }

  const defaultKind = document.general.defaultKind;
  if (defaultKind !== undefined) {
    if (isEarlierKindId(defaultKind)) problem("general.defaultKind", `${defaultKind} is now called ${currentKindId(defaultKind)}. Use that.`);
    else if (!kinds.includes(defaultKind)) problem("general.defaultKind", `There is no kind "${defaultKind}". The kinds are ${kinds.join(", ")}.`);
    else if (!kindOn(document, defaultKind)) problem("general.defaultKind", `The default kind, ${defaultKind}, is off. Turn it on, or pick another.`);
  }

  const seen = new Set<string>();
  const types = new Set<string>();
  for (const backend of document.backends) {
    const path = `backends.${backend.id}`;
    const driver = drivers.find((candidate) => candidate.type === backend.type);
    if (seen.has(backend.id)) {
      problem(path, `Backend ${backend.id} is listed twice.`);
      continue;
    }
    seen.add(backend.id);
    if (!driver) {
      problem(path, `This version of bb-box has no ${backend.type} backend, so ${backend.id} does not run. Its boxes wait for a version that has it.`);
      continue;
    }
    for (const [kind, count] of Object.entries(backend.warm ?? {})) {
      if (!driver.kinds.includes(kind)) problem(`${path}.warm.${kind}`, `${driver.label} makes ${driver.kinds.join(", ")}, not ${kind}.`);
      else if (!isWhole(count, 0, MAX_WARM)) problem(`${path}.warm.${kind}`, `Keep 0 to ${MAX_WARM} warm ${kind} boxes.`);
    }
    // Drivers still name their guests by type, so two of one type would share them.
    if (types.has(backend.type)) problem(path, `bb-box runs one ${driver.label} backend for now. Remove ${backend.id}.`);
    types.add(backend.type);
    const names = new Set<string>();
    for (const [n, host] of (backend.hosts ?? []).entries()) {
      if (names.has(host.name)) problem(`${path}.hosts.${n}.name`, `Host ${host.name} is listed twice. Give each host its own name.`);
      names.add(host.name);
    }
    const parsed = driver.parse(backendPart(backend, driver, secrets));
    if (!parsed.ok) for (const each of parsed.problems) problem(each.path ? `${path}.${each.path}` : path, each.message);
  }

  for (const [id, count] of inUse.backends) {
    if (count > 0 && !seen.has(id)) problem(`backends.${id}`, `Backend ${id} has ${plural(count, "box")}, so it cannot be removed or renamed. Turn it off and release them first.`);
  }
  for (const [id, hosts] of inUse.hosts) {
    const backend = document.backends.find((candidate) => candidate.id === id);
    if (!backend) continue;
    for (const [name, count] of hosts) {
      if (count > 0 && !(backend.hosts ?? []).some((host) => host.name === name)) {
        problem(`backends.${id}.hosts`, `Host ${name} has ${plural(count, "box")}, so it cannot be removed or renamed. Turn it off and release them first.`);
      }
    }
  }
  return problems;
}

function plural(count: number, word: string): string {
  return `${count} ${count === 1 ? word : word.endsWith("x") ? `${word}es` : `${word}s`}`;
}

/** The backend ID a problem's path is in, or null for the general and kinds parts and the document's shape. */
export function backendOf(problem: Problem, document: ConfigDocument): string | null {
  const match = /^backends\.([^.]+)(?:\.|$)/.exec(problem.path);
  if (!match) return null;
  return document.backends.some((backend) => backend.id === match[1]) ? match[1]! : null;
}

/**
 * The problems that stop a write: all but those of a backend that is off and
 * has no boxes, which can be saved part way through its setup (029).
 */
export function blocking(problems: readonly Problem[], document: ConfigDocument, inUse: InUse, drivers: readonly BackendDriver<any>[]): Problem[] {
  return problems.filter((problem) => {
    const id = backendOf(problem, document);
    if (id === null) return true;
    const backend = document.backends.find((candidate) => candidate.id === id)!;
    // A backend of a type this version lacks cannot be fixed here, so it never stops a save.
    if (!drivers.some((driver) => driver.type === backend.type)) return false;
    return backend.enabled || (inUse.backends.get(id) ?? 0) > 0 || /^backends\.[^.]+$/.test(problem.path);
  });
}

/** The shipped sizes of each kind, for the page's placeholders. */
export function kindDefaults(drivers: readonly BackendDriver<any>[]): Record<string, { enabled: true; presets: Record<Preset, BoxSize>; default: Preset; largest: BoxSize }> {
  return Object.fromEntries(
    knownKinds(drivers).map((kind) => {
      const sizes = kindSizes(kind);
      return [kind, { enabled: true as const, presets: { ...sizes.presets }, default: sizes.default, largest: sizes.largest }];
    }),
  );
}
