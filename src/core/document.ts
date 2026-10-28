// bb-box's configuration: one checked document in plugin storage (029). It
// holds what the operator set; a value left out takes bb-box's default, so a
// later release's default reaches it. Secrets are kept apart from it, under
// a key of their own, and never leave bb-box: the document shows each as
// { set: true } or { set: false }.
//
// Every problem has a path, such as "backends.proxmox-lxc.url" or
// "kinds.linux.presets.small", so the settings page can show it by its field.

import { currentKindId, featureWord, isEarlierKindId, kindRequest } from "../backends/kinds.ts";
import { isSecret, type BackendDriver, type BackendPart, type BoxSize, type FieldDescriptor, type FieldValue } from "../backends/types.ts";
import { exportedTailnet, keptTailnetSecrets, readTailnet, tailnetProblems, type TailnetSetting } from "./tailnet-settings.ts";
import { GENERAL_SECRETS, MAX_BOX_FILES, MAX_BOX_FILE_BYTES, contentKey, pathProblem, type BoxFileSetting } from "./box-files.ts";
import { PRESETS, belowLeast, describeSize, fits, kindSizes, type KindSizesChange, type Preset, type SizeChange, type SizeChanges } from "./sizes.ts";

export const SCHEMA = 1;

/** How a secret shows outside bb-box. In a draft, { set: true } keeps it. */
export interface SecretState {
  readonly set: boolean;
}

export interface HostConfig {
  /** Lower-case letters, digits and "-", unique in its backend. */
  readonly name: string;
  /** Off, the host takes no new boxes; its boxes keep working. */
  readonly enabled: boolean;
  /** The host's own fields, as its driver lists them. */
  readonly fields: Readonly<Record<string, FieldValue>>;
}

export interface BackendConfig {
  /** The type, or "<type>:<name>" for another backend of the type. */
  readonly id: string;
  /** The driver. */
  readonly type: string;
  /** Display name. The driver's label when left out. */
  readonly label?: string;
  /** Off, the backend takes no new boxes; its boxes keep working. */
  readonly enabled: boolean;
  /** What the operator set. Stored without secrets; shown with each as its state. */
  readonly fields: Readonly<Record<string, FieldValue | SecretState>>;
  /** Ready guests to keep, by kind. */
  readonly warm?: Readonly<Record<string, number>>;
  /** For a driver with host fields. */
  readonly hosts?: readonly HostConfig[];
}

export interface KindConfig {
  /** Off, no backend offers new boxes of the kind. On when left out. */
  readonly enabled?: boolean;
  /** Changes to the small, medium and large sizes: cores, memoryGiB and diskGiB, each optional. */
  readonly presets?: Partial<Readonly<Record<Preset, SizeChange>>>;
  /** The preset a box gets when it asks for no size. */
  readonly default?: Preset;
  /** The most a custom size may ask for, as a size change. */
  readonly largest?: SizeChange;
  /** Spare boxes to keep: ready, enrolled and owned by no thread (032). None by default, ios and android included: a device spare waits with its device booted and its memory saved to disk (063). */
  readonly spares?: number;
}

/**
 * A project's image (049): a script run as root on a kind's standard image,
 * for the boxes of its projects' threads. Linux for now.
 */
export interface ImageConfig {
  /** The kinds it builds on, such as linux and linux-desktop-cpu. */
  readonly kinds: readonly string[];
  /** The script, run as root in a box of the kind's standard image. */
  readonly script: string;
  /** Run as the box user after the script: the image fails when it fails. */
  readonly check?: string;
  /** When it is built ahead: auto, after two boxes in 14 days; always; or never, so it runs at each start. */
  readonly bake?: ImageBake;
  /** The BB projects whose threads' boxes get it. */
  readonly projects: readonly string[];
  /** Where the files came from in the project's repository, such as .bb/box-setup.sh. */
  readonly source?: { readonly script?: string; readonly check?: string };
  /** When it was set, as an ISO 8601 time. */
  readonly updated?: string;
}

export const IMAGE_BAKES = ["auto", "always", "never"] as const;
export type ImageBake = (typeof IMAGE_BAKES)[number];
/** An image's name: a lower-case letter first, then letters, digits and "-". "standard" is the kinds' own images. */
export const IMAGE_NAME = /^[a-z][a-z0-9-]{0,39}$/;
/** The largest script or check bb-box keeps. */
export const IMAGE_SCRIPT_BYTES = 256 * 1024;

export interface GeneralSettings {
  /** The most boxes a thread may hold at once. 0 means no limit. */
  readonly boxesPerThread?: number;
  /** Whether boxes join BB as machines, so threads and terminals can use them with the thread's credentials. */
  readonly enrol?: boolean;
  /** The kind a thread gets when it asks for none. */
  readonly defaultKind?: string;
  /** Files for every box (#455): paths under the box user's home, whose contents are secrets. */
  readonly files?: readonly BoxFileSetting[];
  /**
   * Whether viewers of a Linux X11 desktop on the CPU show it as video,
   * through Selkies (056), unless one chose VNC in its menu. On unless set
   * off: an install with no value takes the default.
   */
  readonly video?: boolean;
  /**
   * Whether bb-box rebuilds the standard images that are due each night (049), on a schedule of its own at 03:00 on
   * BB's server. Off unless set; first-run setup turns it on.
   */
  readonly nightlyImages?: boolean;
  /**
   * Advanced: whether linux, linux-desktop-cpu, macos and macos-desktop boxes offer the test device (063), a test card
   * served by bb-box's device server in place of a phone, for checking the device path with no simulator or emulator.
   * It stands in for an Android phone or tablet on Linux and an iPhone on macOS, under those models' names, so a box
   * acquired with device "Pixel 8" or "Test device" gets one. Off unless set; the conformance suite turns it on.
   */
  readonly testDevice?: boolean;
  /**
   * Advanced: whether bb-box keeps the iOS devices it streams on each Mac within that Mac's video encoder (064), giving
   * room first to the person in control of a device, then recordings, other viewers and the agent's waits, and showing
   * the others at a lower resolution. Off, every stream of a shared ios box is capped at two thirds and nothing else is.
   * On unless set off.
   */
  readonly encoderLedger?: boolean;
  /**
   * Advanced: how an ios box's device server encodes the device's video (065). auto uses the Mac's hardware H.264
   * encoder where it has one, and bb-box-h264 in software where it has none or its encoder fails; hardware never uses
   * software; software always does, as to test it on a Mac that has an encoder. A box takes it when its device server
   * is delivered. auto unless set.
   */
  readonly iosEncoder?: "auto" | "hardware" | "software";
  /**
   * How bb-box joins machines it makes to the operator's tailnet: off, where BB is reached without one, or through a
   * Tailscale OAuth client, from which it makes a single-use key for each machine. The client's ID and secret are
   * general secrets.
   */
  readonly tailnet?: TailnetSetting;
}

export interface ConfigDocument {
  /** The document's format: 1. */
  readonly schema: typeof SCHEMA;
  /** Counts each save. A file applied with a revision is refused when the configuration has changed since. */
  readonly revision: number;
  /** In the order the registry tries them. */
  readonly backends: readonly BackendConfig[];
  /** Each kind's entry, by its ID: only what differs from its defaults. */
  readonly kinds: Readonly<Record<string, KindConfig>>;
  /** Settings for every backend and kind. */
  readonly general: GeneralSettings;
  /** Projects' images, by name (049). */
  readonly images?: Readonly<Record<string, ImageConfig>>;
}

/** Secret values by backend ID and field. Never leaves bb-box. */
export type Secrets = Readonly<Record<string, Readonly<Record<string, string>>>>;

export interface Problem {
  readonly path: string;
  readonly message: string;
}

export const GENERAL_DEFAULTS = { boxesPerThread: 0, enrol: true, defaultKind: "linux", video: true, nightlyImages: false, testDevice: false, encoderLedger: true, iosEncoder: "auto" } as const;

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

/**
 * The document with each earlier kind ID moved to its kind, or null when it
 * has none. An alias's entry, such as linux-docker's, moves to its kind once,
 * unless the kind has an entry of its own (041). It does not take its
 * "enabled": turning linux-docker off never meant turning linux off. A warm
 * count adds to the kind's, as both were the same guests.
 */
export function upgradeDocument(document: ConfigDocument): ConfigDocument | null {
  const earlier = (id: string) => isEarlierKindId(id);
  const warmed = document.backends.some((backend) => Object.keys(backend.warm ?? {}).some(earlier));
  const defaultKind = document.general.defaultKind;
  if (!Object.keys(document.kinds).some(earlier) && !warmed && !(defaultKind !== undefined && earlier(defaultKind))) return null;

  const kinds: Record<string, KindConfig> = {};
  for (const [id, kind] of Object.entries(document.kinds)) if (!earlier(id)) kinds[id] = kind;
  for (const [id, kind] of Object.entries(document.kinds)) {
    if (!earlier(id)) continue;
    const to = currentKindId(id);
    if (to in kinds) continue;
    const { enabled, ...rest } = kind;
    const moved = kindRequest(id).features.length ? rest : kind;
    if (Object.keys(moved).length) kinds[to] = moved;
  }
  const backends = document.backends.map((backend) => {
    if (!Object.keys(backend.warm ?? {}).some(earlier)) return backend;
    const warm: Record<string, number> = {};
    for (const [id, count] of Object.entries(backend.warm!)) {
      const to = currentKindId(id);
      warm[to] = Math.min(MAX_WARM, (warm[to] ?? 0) + count);
    }
    return { ...backend, warm };
  });
  const general = defaultKind !== undefined && earlier(defaultKind) ? { ...document.general, defaultKind: currentKindId(defaultKind) } : document.general;
  return { ...document, backends, kinds, general };
}

/** Why an earlier kind ID is not a kind of its own, for a problem. */
function earlierWords(id: string): string {
  const { kind, features } = kindRequest(id);
  return features.length ? `${id} is now ${kind} with ${features.map(featureWord).join(", ")}, not a kind of its own. Use ${kind}.` : `${id} is now called ${kind}. Use that.`;
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
  const known = new Set(["schema", "revision", "backends", "kinds", "general", "images"]);
  for (const key of Object.keys(input)) if (!known.has(key)) problem(key, `There is no "${key}" in the configuration. It has backends, kinds, general and images.`);
  if (input.schema !== undefined && input.schema !== SCHEMA) problem("schema", `This bb-box reads schema ${SCHEMA}, not ${String(input.schema)}.`);
  const revision = isWhole(input.revision, 0) ? input.revision : 0;

  const general: Record<string, unknown> = {};
  if (input.general !== undefined) {
    if (!isRecord(input.general)) problem("general", "general must be an object with boxesPerThread, enrol, defaultKind, files, video, nightlyImages, testDevice, encoderLedger, iosEncoder and tailnet.");
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
        } else if (key === "files") {
          const files = readFiles(value, problem, secrets);
          if (files) general[key] = files;
        } else if (key === "video") {
          if (typeof value === "boolean") general[key] = value;
          else problem("general.video", "video is true or false.");
        } else if (key === "nightlyImages") {
          if (typeof value === "boolean") general[key] = value;
          else problem("general.nightlyImages", "nightlyImages is true or false.");
        } else if (key === "testDevice") {
          if (typeof value === "boolean") general[key] = value;
          else problem("general.testDevice", "testDevice is true or false.");
        } else if (key === "encoderLedger") {
          if (typeof value === "boolean") general[key] = value;
          else problem("general.encoderLedger", "encoderLedger is true or false.");
        } else if (key === "iosEncoder") {
          if (value === "auto" || value === "hardware" || value === "software") general[key] = value;
          else problem("general.iosEncoder", "iosEncoder is auto, hardware or software.");
        } else if (key === "tailnet") {
          const changes: Record<string, string | null> = {};
          const tailnet = readTailnet(value, problem, changes);
          if (tailnet) general[key] = tailnet;
          if (Object.keys(changes).length) secrets[GENERAL_SECRETS] = { ...secrets[GENERAL_SECRETS], ...changes };
        } else problem(`general.${key}`, `There is no general setting "${key}". There are boxesPerThread, enrol, defaultKind, files, video, nightlyImages, testDevice, encoderLedger, iosEncoder and tailnet.`);
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
  const images: Record<string, ImageConfig> = {};
  if (input.images !== undefined) {
    if (!isRecord(input.images)) problem("images", "images must be an object with an entry per image, by its name.");
    else for (const [name, value] of Object.entries(input.images)) {
      const image = readImage(`images.${name}`, value, problem);
      if (image) images[name] = image;
    }
  }
  return {
    document: { schema: SCHEMA, revision, backends, kinds, general: general as GeneralSettings, ...(Object.keys(images).length ? { images } : {}) },
    secrets,
    problems,
  };
}

/**
 * The files for every box: each path, checked, and its content into the
 * general secrets' changes. No problem quotes a content.
 */
function readFiles(value: unknown, problem: (path: string, message: string) => void, secrets: Record<string, Record<string, string | null>>): BoxFileSetting[] | undefined {
  if (!Array.isArray(value)) {
    problem("general.files", "files is a list of files, each a path under the box user's home and its content.");
    return undefined;
  }
  if (value.length > MAX_BOX_FILES) problem("general.files", `Give at most ${MAX_BOX_FILES} files for every box.`);
  const changes: Record<string, string | null> = {};
  const files: BoxFileSetting[] = [];
  const seen = new Set<string>();
  value.slice(0, MAX_BOX_FILES).forEach((entry, index) => {
    const at = `general.files.${index}`;
    if (!isRecord(entry) || typeof entry.path !== "string") {
      problem(at, "A file is an object with a path and its content.");
      return;
    }
    const path = entry.path.trim();
    const wrong = pathProblem(path);
    if (wrong) return problem(`${at}.path`, wrong);
    if (seen.has(path)) return problem(`${at}.path`, `${path} is in the list twice.`);
    seen.add(path);
    const content = entry.content;
    if (content === undefined || isSecretState(content)) {
      if (isSecretState(content) && !content.set) changes[contentKey(path)] = null;
    } else if (content === null || content === "") changes[contentKey(path)] = null;
    else if (typeof content !== "string") return problem(`${at}.content`, `${path}'s content is a secret: give it as text, null to clear it, or {"set": true} to keep it.`);
    else if (Buffer.byteLength(content) > MAX_BOX_FILE_BYTES) return problem(`${at}.content`, `${path}'s content is over ${MAX_BOX_FILE_BYTES / 1024 / 1024} MiB.`);
    else changes[contentKey(path)] = content;
    files.push({ path });
  });
  if (Object.keys(changes).length) secrets[GENERAL_SECRETS] = { ...secrets[GENERAL_SECRETS], ...changes };
  return files;
}

/** An image's entry, or undefined when its shape is wrong. */
function readImage(path: string, value: unknown, problem: (path: string, message: string) => void): ImageConfig | undefined {
  if (!isRecord(value)) {
    problem(path, "An image is an object with kinds, script, projects, and optionally check, bake and source.");
    return undefined;
  }
  const strings = (key: string) => (Array.isArray(value[key]) && value[key].every((item: unknown) => typeof item === "string" && item) ? (value[key] as string[]) : null);
  const kinds = strings("kinds");
  const projects = strings("projects");
  let ok = true;
  const bad = (key: string, message: string) => {
    problem(`${path}.${key}`, message);
    ok = false;
  };
  if (!kinds?.length) bad("kinds", "Give the kinds it builds on, such as [\"linux\"].");
  if (!projects?.length) bad("projects", "Give the BB projects whose boxes get it, by their IDs.");
  if (typeof value.script !== "string" || !value.script.trim()) bad("script", "Give its script: the shell script run as root on the kind's standard image.");
  if (value.check !== undefined && typeof value.check !== "string") bad("check", "Its check is a shell script, run as the box user.");
  if (value.bake !== undefined && !(IMAGE_BAKES as readonly unknown[]).includes(value.bake)) bad("bake", `bake is ${IMAGE_BAKES.join(", ")}.`);
  const source = value.source;
  if (source !== undefined && !(isRecord(source) && Object.values(source).every((item) => typeof item === "string"))) bad("source", "source gives the files' paths in the repository, as script and check.");
  if (value.updated !== undefined && (typeof value.updated !== "string" || Number.isNaN(Date.parse(value.updated)))) bad("updated", "updated is an ISO 8601 time.");
  for (const key of Object.keys(value)) {
    if (!["kinds", "script", "check", "bake", "projects", "source", "updated"].includes(key)) bad(key, `An image has no "${key}". It has kinds, script, check, bake, projects, source and updated.`);
  }
  if (!ok) return undefined;
  return {
    kinds: kinds!,
    script: value.script as string,
    ...(typeof value.check === "string" && value.check.trim() ? { check: value.check } : {}),
    ...(value.bake !== undefined ? { bake: value.bake as ImageBake } : {}),
    projects: projects!,
    ...(source !== undefined ? { source: source as ImageConfig["source"] & object } : {}),
    ...(typeof value.updated === "string" ? { updated: value.updated } : {}),
  };
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

/**
 * Whose fields `readFields` reads, for its messages: "Backend tart" or a
 * host of it, and the prefix the backend's keys had in BB's settings, if any.
 */
interface FieldOwner {
  readonly name: string;
  readonly settingsPrefix: string | null;
}

/**
 * Why `key` is not a field of `owner`'s, naming the key it has now when it
 * is the name BB's settings gave it before the document (029), such as
 * "tart-linux-image" for "linux-image".
 */
function unknownField(owner: FieldOwner, key: string, descriptors: Readonly<Record<string, FieldDescriptor>>): string {
  const prefix = owner.settingsPrefix;
  const current = prefix && key.startsWith(prefix) ? key.slice(prefix.length) : null;
  const hint =
    current && Object.hasOwn(descriptors, current)
      ? `That was its name in BB's settings; here it is "${current}".`
      : `The fields are ${Object.keys(descriptors).join(", ") || "none"}.`;
  return `${owner.name} has no field "${key}". ${hint}`;
}

function readFields(
  path: string,
  value: unknown,
  descriptors: Readonly<Record<string, FieldDescriptor>>,
  owner: FieldOwner,
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
      problem(at, unknownField(owner, key, descriptors));
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
  const owner = `Backend ${id}`;
  const fields = readFields(`${path}`, value.fields, driver.fields, { name: owner, settingsPrefix: `${driver.type}-` }, problem, backendSecrets);
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
        hosts!.push({ name: host.name, enabled: host.enabled !== false, fields: readFields(`${at}`, host.fields, driver.hostFields!, { name: `Host ${host.name} of backend ${id}`, settingsPrefix: null }, problem, null) });
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

/** The secrets once a draft's changes are applied. Only backends in the document keep theirs, and only its files theirs. */
export function withSecretChanges(stored: Secrets, changes: SecretChanges, document: ConfigDocument): Secrets {
  const next: Record<string, Record<string, string>> = {};
  const files: Record<string, string> = {};
  for (const file of document.general.files ?? []) {
    const key = contentKey(file.path);
    const change = changes[GENERAL_SECRETS]?.[key];
    const value = change === undefined ? stored[GENERAL_SECRETS]?.[key] : change;
    if (typeof value === "string") files[key] = value;
  }
  Object.assign(files, keptTailnetSecrets(document.general.tailnet, stored[GENERAL_SECRETS] ?? {}, changes[GENERAL_SECRETS] ?? {}));
  if (Object.keys(files).length) next[GENERAL_SECRETS] = files;
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

/**
 * A backend's part for its driver: every declared field, set or default, with
 * its secrets. A set of fields the driver inherits, all empty here, takes the
 * values of the first other backend of the type it names among `backends`,
 * the document's.
 */
export function backendPart(backend: BackendConfig, driver: BackendDriver<any>, secrets: Secrets, backends: readonly BackendConfig[] = []): BackendPart {
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
  const fields = filled(driver.fields, backend.fields, secrets[backend.id] ?? {});
  const inherits = driver.inherits;
  const source = inherits && backends.find((other) => other.type === inherits.from && other.id !== backend.id);
  if (inherits && source) {
    const empty = (value: FieldValue | undefined) => value === undefined || (typeof value === "string" && !value.trim());
    for (const set of inherits.sets) {
      if (!set.every((key) => empty(fields[key]))) continue;
      for (const key of set) {
        const descriptor = driver.fields[key];
        const value = descriptor && isSecret(descriptor) ? secrets[source.id]?.[key] : source.fields[key];
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") fields[key] = value;
      }
    }
  }
  return {
    id: backend.id,
    fields,
    hosts: (backend.hosts ?? []).map((host) => ({ name: host.name, fields: filled(driver.hostFields ?? {}, host.fields, {}) })),
  };
}

/** The document as it leaves bb-box: each secret field as whether it is set. */
export function exported(document: ConfigDocument, secrets: Secrets, drivers: readonly BackendDriver<any>[]): ConfigDocument {
  const files = document.general.files?.map((file) => ({ path: file.path, content: { set: secrets[GENERAL_SECRETS]?.[contentKey(file.path)] !== undefined } }));
  return {
    ...document,
    general: {
      ...document.general,
      ...(files ? { files } : {}),
      ...(document.general.tailnet ? { tailnet: exportedTailnet(document.general.tailnet, secrets[GENERAL_SECRETS] ?? {}) } : {}),
    },
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

/** The document as stored: no secret field, and of the files for every box only their paths. */
export function withoutSecrets(document: ConfigDocument, drivers: readonly BackendDriver<any>[]): ConfigDocument {
  const files = document.general.files?.map((file) => ({ path: file.path }));
  const tailnet = document.general.tailnet;
  return {
    ...document,
    general: { ...document.general, ...(files ? { files } : {}), ...(tailnet ? { tailnet: { mode: tailnet.mode, ...(tailnet.tags ? { tags: tailnet.tags } : {}) } } : {}) },
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
      problem(path, earlierWords(id));
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
      const tooSmall = belowLeast(id, sizes.presets[preset]);
      if (tooSmall) problem(`${path}.presets.${preset}`, `The ${preset} ${id} preset is too small. ${tooSmall}`);
    }
    if (kind.spares !== undefined && !isWhole(kind.spares, 0, MAX_SPARES)) problem(`${path}.spares`, `Keep 0 to ${MAX_SPARES} spare ${id} boxes.`);
  }

  for (const missing of tailnetProblems(document.general.tailnet, secrets[GENERAL_SECRETS] ?? {})) problem(missing.path, missing.message);

  const defaultKind = document.general.defaultKind;
  if (defaultKind !== undefined) {
    if (isEarlierKindId(defaultKind)) problem("general.defaultKind", earlierWords(defaultKind));
    else if (!kinds.includes(defaultKind)) problem("general.defaultKind", `There is no kind "${defaultKind}". The kinds are ${kinds.join(", ")}.`);
    else if (!kindOn(document, defaultKind)) problem("general.defaultKind", `The default kind, ${defaultKind}, is off. Turn it on, or pick another.`);
  }

  const seen = new Set<string>();
  const types = new Set<string>();
  /** Backends of a type that may have several, by type and host. */
  const hosts = new Map<string, string>();
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
      if (isEarlierKindId(kind)) problem(`${path}.warm.${kind}`, earlierWords(kind));
      else if (!driver.kinds.includes(kind)) problem(`${path}.warm.${kind}`, `${driver.label} makes ${driver.kinds.join(", ")}, not ${kind}.`);
      else if (!isWhole(count, 0, MAX_WARM)) problem(`${path}.warm.${kind}`, `Keep 0 to ${MAX_WARM} warm ${kind} boxes.`);
    }
    // Drivers name their guests by type, so two of one type would share them, unless each is on a host of its own (042).
    if (driver.several) {
      const host = `${backend.type} ${driver.several(backend.fields ?? {})}`;
      const other = hosts.get(host);
      if (other !== undefined) problem(path, `${backend.id} and ${other} are both ${driver.label} on ${driver.several(backend.fields ?? {}) || "the default host"}. Give each its own host, or remove one.`);
      else hosts.set(host, backend.id);
    } else if (types.has(backend.type)) problem(path, `bb-box runs one ${driver.label} backend for now. Remove ${backend.id}.`);
    types.add(backend.type);
    const names = new Set<string>();
    for (const [n, host] of (backend.hosts ?? []).entries()) {
      if (names.has(host.name)) problem(`${path}.hosts.${n}.name`, `Host ${host.name} is listed twice. Give each host its own name.`);
      names.add(host.name);
    }
    const parsed = driver.parse(backendPart(backend, driver, secrets, document.backends));
    if (!parsed.ok) for (const each of parsed.problems) problem(each.path ? `${path}.${each.path}` : path, each.message);
  }

  for (const [id, count] of inUse.backends) {
    if (count > 0 && !seen.has(id)) problem(`backends.${id}`, `Backend ${id} has ${plural(count, "box")}, so it cannot be removed or renamed. Turn it off and release them first.`);
  }

  // Projects' images (049): Linux kinds for now, and one image a project's boxes of a kind get.
  const claimed = new Map<string, string>();
  for (const [name, image] of Object.entries(document.images ?? {})) {
    const path = `images.${name}`;
    if (!IMAGE_NAME.test(name) || name === "standard") problem(path, `Name an image with a lower-case letter first, then letters, digits and "-", up to 40, and not "standard". "${name}" is not one.`);
    for (const kind of image.kinds) {
      if (!kinds.includes(kind)) problem(`${path}.kinds`, `There is no kind "${kind}". The kinds are ${kinds.join(", ")}.`);
      else if (!kind.startsWith("linux")) problem(`${path}.kinds`, `An image's script is a Linux one for now, and ${kind} is not a Linux kind.`);
    }
    for (const [key, text] of [["script", image.script], ["check", image.check ?? ""]] as const) {
      const bytes = new TextEncoder().encode(text).length;
      if (bytes > IMAGE_SCRIPT_BYTES) problem(`${path}.${key}`, `The ${key} is ${Math.ceil(bytes / 1024)} KiB; bb-box keeps up to ${IMAGE_SCRIPT_BYTES / 1024} KiB.`);
    }
    for (const project of image.projects) {
      for (const kind of image.kinds) {
        const other = claimed.get(`${project} ${kind}`);
        if (other) problem(`${path}.kinds`, `Project ${project}'s ${kind} boxes would get both ${other} and ${name}. Give each project one image a kind.`);
        else claimed.set(`${project} ${kind}`, name);
      }
    }
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
