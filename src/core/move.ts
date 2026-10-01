// The move from BB's settings into bb-box's configuration document (029),
// once, on the first start of the version that brings the document and
// before any backend is built.
//
// Each step is safe to repeat, so a start cut short after any of them
// finishes the move on the next:
//
// 1. the secrets, under their own key;
// 2. a copy of the non-secret values BB's settings gave, with the time and
//    bb-box's version, so a value that moved wrongly can be compared;
// 3. the document at revision 1. From here on BB's settings drive nothing;
// 4. BB's settings cleared, so no second copy of a secret is left;
// 5. a mark that they are cleared. bb-box declares the old keys until then.

import type { PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { isSecret, type BackendDriver } from "../backends/types.ts";
import { GENERAL_SETTINGS } from "./config.ts";
import { SCHEMA, knownKinds, type BackendConfig, type ConfigDocument, type KindConfig, type Secrets } from "./document.ts";
import { PRESETS, parseSizeChanges, withEarlierSizes } from "./sizes.ts";

export const DOCUMENT_KEY = "config/document";
export const SECRETS_KEY = "config/secrets";
export const COPY_KEY = "config/migrated-from-bb-settings";
export const CLEARED_KEY = "config/bb-settings-cleared";
/** Set once 028 moved the Proxmox LXC sizes into the box-sizes setting. */
export const SIZES_ADOPTED_KEY = "sizes-adopted";

/** What BB's settings held when they moved, without the secrets. */
export interface MovedCopy {
  readonly at: number;
  /** bb-box's version that made the move. */
  readonly version: string;
  /** Each setting BB gave, its declared default included. A secret shows only whether it was set. */
  readonly values: Readonly<Record<string, unknown>>;
  /** Anything the move did not carry over as it was, in words. */
  readonly notes: readonly string[];
}

export interface Kv {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Every key bb-box declared in BB's settings before the document, general and backends. */
export function earlierSettings(drivers: readonly BackendDriver<any>[]): Record<string, PluginSettingDescriptor> {
  const settings: Record<string, PluginSettingDescriptor> = { ...GENERAL_SETTINGS };
  for (const driver of drivers) {
    for (const [key, descriptor] of Object.entries(driver.earlier?.settings ?? {})) {
      if (!key.startsWith(`${driver.type}-`)) throw new Error(`Setting ${key} of backend ${driver.type} must start with "${driver.type}-".`);
      if (key in settings) throw new Error(`Setting ${key} is defined twice.`);
      settings[key] = descriptor;
    }
  }
  return settings;
}

/**
 * The document and secrets BB's settings make. `sizesAdopted` says whether
 * 028's version already moved the Proxmox LXC sizes into box-sizes; if not,
 * the move does it first, so those keys are read once and only once.
 */
export function fromSettings(
  values: Readonly<Record<string, unknown>>,
  drivers: readonly BackendDriver<any>[],
  sizesAdopted: boolean,
): { document: ConfigDocument; secrets: Secrets; notes: string[] } {
  const notes: string[] = [];
  const general: { boxesPerThread?: number; enrol?: boolean } = {};
  const limit = values["boxes-per-thread"];
  if (typeof limit === "number" && Number.isInteger(limit) && limit > 0) general.boxesPerThread = limit;
  else if (limit !== undefined && limit !== 0) notes.push(`Boxes per thread was ${JSON.stringify(limit)}, which bb-box read as no limit, so it was left out.`);
  if (values["enrol-boxes"] === false) general.enrol = false;

  let sizes = values["box-sizes"];
  if (!sizesAdopted) {
    const earlier = Object.assign({}, ...drivers.map((driver) => driver.earlier?.sizes?.(values) ?? {}));
    sizes = withEarlierSizes(sizes, earlier) ?? sizes;
  }
  const parsed = parseSizeChanges(sizes);
  for (const problem of parsed.problems) notes.push(`Box sizes: ${problem} bb-box ignored it, so it was left out.`);
  const kinds: Record<string, KindConfig> = {};
  const known = knownKinds(drivers);
  for (const [kind, change] of Object.entries(parsed.changes)) {
    if (!known.includes(kind)) {
      notes.push(`Box sizes had an entry for ${kind}, which no backend makes, so it was left out.`);
      continue;
    }
    const presets = Object.fromEntries(PRESETS.filter((preset) => change[preset]).map((preset) => [preset, change[preset]]));
    kinds[kind] = {
      ...(Object.keys(presets).length ? { presets } : {}),
      ...(change.default ? { default: change.default } : {}),
      ...(change.largest ? { largest: change.largest } : {}),
    };
  }

  const backends: BackendConfig[] = [];
  const secrets: Record<string, Record<string, string>> = {};
  for (const driver of drivers) {
    const earlier = driver.earlier?.read(values);
    if (!earlier) continue;
    backends.push({
      id: driver.type,
      type: driver.type,
      enabled: earlier.enabled,
      fields: earlier.fields,
      ...(Object.keys(earlier.warm).length ? { warm: earlier.warm } : {}),
      ...(earlier.hosts ? { hosts: earlier.hosts } : {}),
    });
    if (Object.keys(earlier.secrets).length) secrets[driver.type] = { ...earlier.secrets };
  }
  return { document: { schema: SCHEMA, revision: 1, backends, kinds, general }, secrets, notes };
}

/** The settings without their secrets' values: each secret shows only whether it was set. */
export function copyOf(values: Readonly<Record<string, unknown>>, settings: Readonly<Record<string, PluginSettingDescriptor>>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(settings)) {
    const value = values[key];
    if (isSecret(descriptor)) copy[key] = { set: typeof value === "string" && value !== "" };
    else if (value !== undefined) copy[key] = value;
  }
  return copy;
}

export interface MoveOptions {
  readonly kv: Kv;
  readonly drivers: readonly BackendDriver<any>[];
  /** BB's settings as the handle gives them, declared defaults included. */
  readonly values: Readonly<Record<string, unknown>>;
  readonly settings: Readonly<Record<string, PluginSettingDescriptor>>;
  readonly version: string;
  readonly now?: () => number;
}

/** Steps 1 to 3: the secrets, the copy and the document. Returns the document. */
export async function moveSettings(options: MoveOptions): Promise<ConfigDocument> {
  const sizesAdopted = (await options.kv.get<unknown>(SIZES_ADOPTED_KEY)) === true;
  const { document, secrets, notes } = fromSettings(options.values, options.drivers, sizesAdopted);
  await options.kv.set(SECRETS_KEY, secrets);
  const copy: MovedCopy = { at: (options.now ?? Date.now)(), version: options.version, values: copyOf(options.values, options.settings), notes };
  await options.kv.set(COPY_KEY, copy);
  await options.kv.set(DOCUMENT_KEY, document);
  return document;
}

/** Steps 4 and 5: clears every old key in BB's settings, then marks them cleared. */
export async function clearSettings(
  kv: Kv,
  handle: { experimental_set(values: Record<string, null>): Promise<unknown> },
  settings: Readonly<Record<string, PluginSettingDescriptor>>,
  now: () => number = Date.now,
): Promise<void> {
  await handle.experimental_set(Object.fromEntries(Object.keys(settings).map((key) => [key, null])));
  await kv.set(CLEARED_KEY, { at: now() });
}
