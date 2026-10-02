// Settings of the Proxmox LXC backend, parsed into a typed config. Every key
// starts with "proxmox-lxc-". The plugin's settings page, the smoke script's
// settings file and the tests all go through parseLxcSettings.
//
// Templates come in four flavours, each a list of CT templates: Linux ones
// serve linux, GPU desktop ones (each carrying one GPU, named by an ID) serve
// linux-desktop, CPU-only desktop ones serve linux-desktop-cpu, and CPU-only
// Wayland desktop ones serve linux-desktop-wayland-cpu (048). A new box is
// cloned from the flavour's least used template; a GPU desktop goes to the
// GPU with the fewest desktops.
//
// Each VMID in the owned range has a fixed address: the n-th VMID gets the
// n-th address. Proxmox refuses a second guest with the same VMID, so two
// boxes never share an address and no address is stored or leased. VMIDs are
// handed out round-robin, so an address is not reused straight after a box
// is deleted.
//
// The defaults match the generic ones in setup/proxmox-lxc/, so a host set up
// with that guide's defaults needs only the API URL, token, fingerprint and
// SSH key.
//
// The Linux flavour was called headless before 027. Its keys declare no
// default, so an unset one can be told apart and its proxmox-lxc-headless-
// key read instead: saved values carry over.
//
// Each flavour's cores, memory and disk were settings until 028, when box
// sizes replaced them. Their keys stay declared, without defaults, so that
// bb-box can read saved values once into the box-sizes setting.

import type { PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import {
  addressFor,
  checkConnection,
  checkNetwork,
  checkReserve,
  checkSsh,
  checkVmids,
  number,
  text,
  wholeInRange,
  type Problem,
  type ProxmoxConnection,
  type ProxmoxNetwork,
  type VmidRange,
} from "../proxmox/settings.ts";
import {
  fieldLabel,
  isSecret,
  type BackendPart,
  type BoxSize,
  type EarlierBackend,
  type FieldDescriptor,
  type FieldGroup,
  type FieldProblem,
  type FieldValue,
  type ParsedBackend,
  type ParsedSettings,
} from "../types.ts";

export const LXC_FLAVOURS = ["linux", "desktop", "desktop-cpu", "desktop-wayland-cpu"] as const;
export type LxcFlavour = (typeof LXC_FLAVOURS)[number];

/** The kinds each flavour's clones serve. */
export const FLAVOUR_KINDS: Readonly<Record<LxcFlavour, readonly string[]>> = {
  linux: ["linux"],
  desktop: ["linux-desktop"],
  "desktop-cpu": ["linux-desktop-cpu"],
  "desktop-wayland-cpu": ["linux-desktop-wayland-cpu"],
};

export function flavourOf(kind: string): LxcFlavour | null {
  return LXC_FLAVOURS.find((flavour) => FLAVOUR_KINDS[flavour].includes(kind)) ?? null;
}

export interface LxcTemplate {
  /** CT template VMID. */
  readonly vmid: number;
  /** The GPU a GPU desktop template carries, or null. Templates with the same ID share a GPU. */
  readonly gpu: string | null;
}

export interface LxcFlavourConfig {
  /** In the order the settings list them. Empty when the flavour's kinds are off. */
  readonly templates: readonly LxcTemplate[];
}

export interface LxcConfig {
  readonly proxmox: ProxmoxConnection;
  readonly flavours: Readonly<Record<LxcFlavour, LxcFlavourConfig>>;
  readonly desktop: {
    /** The most desktop boxes each GPU runs at once, or null for no limit. */
    readonly perGpu: number | null;
  };
  readonly vmids: VmidRange;
  readonly network: ProxmoxNetwork;
  /** A null key means bb-box generates one and shows its public key. */
  readonly ssh: { readonly privateKey: string | null; readonly user: string };
  readonly reserve: { readonly memoryMiB: number; readonly diskGiB: number };
}

export const LXC_DEFAULTS = {
  pool: "bbbox",
  linuxTemplate: 9100,
  vmidFirst: 9900,
  vmidLast: 9999,
  bridge: "vmbr200",
  subnet: "10.200.0.0/24",
  gateway: "10.200.0.1",
  addresses: "10.200.0.10-10.200.0.254",
  sshUser: "box",
  reserveMemoryMiB: 4096,
  reserveDiskGiB: 50,
} as const;

export const LXC_PREFIX = "proxmox-lxc-";

/** Setting keys. Every key starts with "proxmox-lxc-". */
export const LXC_KEYS = {
  enabled: "proxmox-lxc-enabled",
  url: "proxmox-lxc-url",
  tokenId: "proxmox-lxc-token-id",
  tokenSecret: "proxmox-lxc-token-secret",
  tlsFingerprint: "proxmox-lxc-tls-fingerprint",
  caCertificate: "proxmox-lxc-ca-certificate",
  node: "proxmox-lxc-node",
  pool: "proxmox-lxc-pool",
  vmidFirst: "proxmox-lxc-vmid-first",
  vmidLast: "proxmox-lxc-vmid-last",
  bridge: "proxmox-lxc-bridge",
  subnet: "proxmox-lxc-subnet",
  gateway: "proxmox-lxc-gateway",
  addresses: "proxmox-lxc-addresses",
  sshPrivateKey: "proxmox-lxc-ssh-private-key",
  sshUser: "proxmox-lxc-ssh-user",
  perGpu: "proxmox-lxc-desktops-per-gpu",
  reserveMemoryMiB: "proxmox-lxc-reserve-memory-mib",
  reserveDiskGiB: "proxmox-lxc-reserve-disk-gib",
} as const;

/** The cores, memory and disk keys are those replaced by box sizes (028). */
type FlavourField = "templates" | "warm" | SizeField;
type SizeField = "cores" | "memory-mib" | "disk-gib";
const SIZE_FIELDS: readonly SizeField[] = ["cores", "memory-mib", "disk-gib"];
const FLAVOUR_FIELDS: readonly FlavourField[] = ["templates", "warm", ...SIZE_FIELDS];

export function flavourKey(flavour: LxcFlavour, field: FlavourField): string {
  return `proxmox-lxc-${flavour}-${field}`;
}

/** The Linux flavour's key before 027, read while the new one is unset. */
export function earlierFlavourKey(field: FlavourField): string {
  return `proxmox-lxc-headless-${field}`;
}

/** The settings, with each unset Linux key taken from its key before 027. */
function withEarlierKeys(values: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const merged = { ...values };
  for (const field of FLAVOUR_FIELDS) {
    const key = flavourKey("linux", field);
    if (merged[key] === undefined || merged[key] === null) merged[key] = values[earlierFlavourKey(field)];
  }
  return merged;
}

const FLAVOUR_WORDS: Readonly<Record<LxcFlavour, { readonly name: string; readonly templates: string }>> = {
  linux: {
    name: "Linux",
    templates: "VMIDs of the CT templates linux boxes are linked clones of, separated by spaces or commas. Empty turns them off.",
  },
  desktop: {
    name: "GPU desktop",
    templates:
      "One line per GPU desktop template that linux-desktop boxes are linked clones of: its VMID, a space and the ID of the GPU it carries, such as the UUID nvidia-smi -L shows. Empty turns them off.",
  },
  "desktop-cpu": {
    name: "CPU desktop",
    templates: "VMIDs of the CPU-only desktop templates linux-desktop-cpu boxes are linked clones of, separated by spaces or commas. Empty turns them off.",
  },
  "desktop-wayland-cpu": {
    name: "CPU Wayland desktop",
    templates:
      "VMIDs of the CPU-only Wayland desktop templates linux-desktop-wayland-cpu boxes are linked clones of, separated by spaces or commas. Empty turns them off.",
  },
};

function flavourSettings(flavour: LxcFlavour): Record<string, PluginSettingDescriptor> {
  const { name, templates } = FLAVOUR_WORDS[flavour];
  const linux = flavour === "linux";
  // The Linux keys declare no default (see the top of this file), so their descriptions give it.
  const otherwise = <T,>(fallback: T) => (linux ? {} : { default: fallback });
  const unset = (fallback: string | number) => (linux ? ` Unset means the replaced headless setting's value, or else ${fallback}.` : "");
  return {
    [flavourKey(flavour, "templates")]: {
      type: "string",
      label: `Proxmox LXC: ${name} templates`,
      description: `${templates}${unset(LXC_DEFAULTS.linuxTemplate)}`,
      ...(flavour === "desktop" ? { experimental_multiline: true } : {}),
      ...otherwise(""),
    },
    [flavourKey(flavour, "warm")]: {
      type: "number",
      label: `Proxmox LXC: warm ${name} boxes`,
      description: `Ready boxes kept started and waiting, so a new box is ready at once. 0 turns the warm pool off.${unset(0)}`,
      ...otherwise(0),
    },
  };
}

const SIZE_WORDS: Readonly<Record<SizeField, string>> = { cores: "cores", "memory-mib": "memory (MiB)", "disk-gib": "disk (GiB)" };

/** A flavour's size keys before 028, declared so their saved values can be read once. */
function replacedSizeSettings(flavour: LxcFlavour): Record<string, PluginSettingDescriptor> {
  const kinds = FLAVOUR_KINDS[flavour].join(" and ");
  return Object.fromEntries(
    SIZE_FIELDS.map((field) => [
      flavourKey(flavour, field),
      {
        type: "number",
        label: `Proxmox LXC: ${FLAVOUR_WORDS[flavour].name} ${SIZE_WORDS[field]} (replaced)`,
        description: `Replaced by Box sizes, which took a saved value once as the default size of ${kinds} boxes. Changing it does nothing.`,
      } satisfies PluginSettingDescriptor,
    ]),
  );
}

/** The Linux flavour's keys before 027, declared so their saved values can still be read. */
function earlierFlavourSettings(): Record<string, PluginSettingDescriptor> {
  const current = { ...flavourSettings("linux"), ...replacedSizeSettings("linux") };
  return Object.fromEntries(
    FLAVOUR_FIELDS.map((field) => {
      const { type, label, description } = current[flavourKey("linux", field)]!;
      const size = (SIZE_FIELDS as readonly string[]).includes(field);
      const earlier = {
        type,
        label: size ? label.replace("Linux", "headless") : `${label.replace("Linux", "headless")} (replaced)`,
        description: size ? description : `Replaced by ${flavourKey("linux", field)}, and read only while that is unset. Move the value there.`,
      } as PluginSettingDescriptor;
      return [earlierFlavourKey(field), earlier];
    }),
  );
}

export const LXC_SETTINGS: Record<string, PluginSettingDescriptor> = {
  [LXC_KEYS.enabled]: {
    type: "boolean",
    label: "Proxmox LXC: enabled",
    description: "Offer Linux boxes as containers on a Proxmox VE host.",
    default: true,
  },
  [LXC_KEYS.url]: {
    type: "string",
    label: "Proxmox LXC: API URL",
    description: "For example https://192.0.2.10:8006/api2/json, as the setup guide's token file gives it.",
    default: "",
  },
  [LXC_KEYS.tokenId]: {
    type: "string",
    label: "Proxmox LXC: API token ID",
    description: "For example bbbox@pve!plugin. The setup guide lists the privileges it needs.",
    default: "",
  },
  [LXC_KEYS.tokenSecret]: { type: "string", label: "Proxmox LXC: API token secret", secret: true },
  [LXC_KEYS.tlsFingerprint]: {
    type: "string",
    label: "Proxmox LXC: TLS fingerprint",
    description:
      "The SHA-256 fingerprint of the Proxmox API's certificate, from the setup guide's token file. bb-box then trusts that certificate alone. Leave empty to check the certificate against its CA.",
    default: "",
  },
  [LXC_KEYS.caCertificate]: {
    type: "string",
    label: "Proxmox LXC: CA certificate",
    description: "PEM certificate of the CA that signed the Proxmox API's certificate, when there is no TLS fingerprint. Leave empty for a publicly trusted one.",
    experimental_multiline: true,
    default: "",
  },
  [LXC_KEYS.node]: {
    type: "string",
    label: "Proxmox LXC: node",
    description: "The node boxes run on. Leave empty on a single-node host.",
    default: "",
  },
  [LXC_KEYS.pool]: {
    type: "string",
    label: "Proxmox LXC: resource pool",
    description: "Boxes are made in this pool. The token needs rights on it.",
    default: LXC_DEFAULTS.pool,
  },
  ...flavourSettings("linux"),
  ...flavourSettings("desktop"),
  ...flavourSettings("desktop-cpu"),
  [LXC_KEYS.perGpu]: {
    type: "number",
    label: "Proxmox LXC: desktops per GPU",
    description:
      "A new linux-desktop box goes to the GPU with the fewest desktops, and is refused when every GPU runs this many. 0 means no limit.",
    default: 0,
  },
  [LXC_KEYS.vmidFirst]: {
    type: "number",
    label: "Proxmox LXC: first box VMID",
    description: "Boxes take VMIDs from this range. Keep other guests out of it.",
    default: LXC_DEFAULTS.vmidFirst,
  },
  [LXC_KEYS.vmidLast]: { type: "number", label: "Proxmox LXC: last box VMID", default: LXC_DEFAULTS.vmidLast },
  [LXC_KEYS.bridge]: {
    type: "string",
    label: "Proxmox LXC: network bridge",
    description: "The bridge boxes attach to.",
    default: LXC_DEFAULTS.bridge,
  },
  [LXC_KEYS.subnet]: {
    type: "string",
    label: "Proxmox LXC: subnet",
    description: "The bridge's subnet in CIDR form. Boxes get static addresses; there is no DHCP.",
    default: LXC_DEFAULTS.subnet,
  },
  [LXC_KEYS.gateway]: {
    type: "string",
    label: "Proxmox LXC: gateway",
    description: "The host's address on the bridge.",
    default: LXC_DEFAULTS.gateway,
  },
  [LXC_KEYS.addresses]: {
    type: "string",
    label: "Proxmox LXC: box addresses",
    description: "The range bb-box hands out. The n-th VMID gets the n-th address. Leave empty to use the whole subnet except the gateway.",
    default: LXC_DEFAULTS.addresses,
  },
  [LXC_KEYS.sshPrivateKey]: {
    type: "string",
    label: "Proxmox LXC: SSH private key",
    description:
      "The unencrypted OpenSSH private key the templates were built with (the setup guide's BBBOX_SSH_KEY). Leave empty and bb-box makes one and shows its public key, which the templates must then accept.",
    secret: true,
  },
  [LXC_KEYS.sshUser]: {
    type: "string",
    label: "Proxmox LXC: SSH user",
    description: "The user in the templates that bb-box and BB work as.",
    default: LXC_DEFAULTS.sshUser,
  },
  [LXC_KEYS.reserveMemoryMiB]: {
    type: "number",
    label: "Proxmox LXC: memory kept free (MiB)",
    description: "A new box is refused if the node would have less memory than this left.",
    default: LXC_DEFAULTS.reserveMemoryMiB,
  },
  [LXC_KEYS.reserveDiskGiB]: {
    type: "number",
    label: "Proxmox LXC: disk kept free (GiB)",
    description: "A new box is refused if the template's storage has less free space than this.",
    default: LXC_DEFAULTS.reserveDiskGiB,
  },
  ...replacedSizeSettings("linux"),
  ...replacedSizeSettings("desktop"),
  ...replacedSizeSettings("desktop-cpu"),
  ...earlierFlavourSettings(),
};

/**
 * Settings that came after 029, which BB never declared: fields alone. Of the
 * Wayland flavour (048) only the templates are a field, as warm counts are
 * the configuration's, by kind.
 */
const LATER_SETTINGS: Readonly<Record<string, PluginSettingDescriptor>> = flavourSettings("desktop-wayland-cpu");

/**
 * The backend's fields in bb-box's configuration (029): the settings above
 * without the prefix, in the order the setup guide gives their values.
 */
const FIELD_GROUPS: readonly (readonly [string, FieldGroup])[] = [
  [LXC_KEYS.url, "connection"],
  [LXC_KEYS.node, "connection"],
  [LXC_KEYS.tlsFingerprint, "connection"],
  [LXC_KEYS.caCertificate, "connection"],
  [LXC_KEYS.tokenId, "credentials"],
  [LXC_KEYS.tokenSecret, "credentials"],
  [LXC_KEYS.sshPrivateKey, "credentials"],
  [LXC_KEYS.pool, "boxes"],
  [flavourKey("linux", "templates"), "boxes"],
  [flavourKey("desktop", "templates"), "boxes"],
  [flavourKey("desktop-cpu", "templates"), "boxes"],
  [flavourKey("desktop-wayland-cpu", "templates"), "boxes"],
  [LXC_KEYS.perGpu, "advanced"],
  [LXC_KEYS.bridge, "advanced"],
  [LXC_KEYS.subnet, "advanced"],
  [LXC_KEYS.gateway, "advanced"],
  [LXC_KEYS.addresses, "advanced"],
  [LXC_KEYS.vmidFirst, "advanced"],
  [LXC_KEYS.vmidLast, "advanced"],
  [LXC_KEYS.sshUser, "advanced"],
  [LXC_KEYS.reserveMemoryMiB, "advanced"],
  [LXC_KEYS.reserveDiskGiB, "advanced"],
];

export const LXC_FIELDS: Readonly<Record<string, FieldDescriptor>> = Object.fromEntries(
  FIELD_GROUPS.map(([key, group]) => {
    const setting = LXC_SETTINGS[key] ?? LATER_SETTINGS[key]!;
    const field = { ...setting, label: fieldLabel(setting.label), group } as FieldDescriptor;
    // The Linux templates have a default of their own now that no earlier key stands in for it.
    if (key === flavourKey("linux", "templates")) {
      Object.assign(field, { default: String(LXC_DEFAULTS.linuxTemplate), description: FLAVOUR_WORDS.linux.templates });
    }
    return [key.slice(LXC_PREFIX.length), field];
  }),
);

/** Where each flavour's warm count goes in the configuration: its first kind (029). */
const WARM_KIND: Readonly<Record<LxcFlavour, string>> = {
  linux: "linux",
  desktop: "linux-desktop",
  "desktop-cpu": "linux-desktop-cpu",
  "desktop-wayland-cpu": "linux-desktop-wayland-cpu",
};

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/**
 * The backend's settings from before 029, for the move into the
 * configuration: values that differ from their defaults, with an unset Linux
 * key read from its key before 027. Null when none of its settings was set.
 * The sizes before 028 are read by earlierLxcSizes.
 */
export function readEarlierLxc(input: Readonly<Record<string, unknown>>): EarlierBackend | null {
  const values = withEarlierKeys(input);
  const earlier = new Set(FLAVOUR_FIELDS.map(earlierFlavourKey));
  let any = false;
  const fields: Record<string, FieldValue> = {};
  const secrets: Record<string, string> = {};
  const warm: Record<string, number> = {};
  for (const [key, setting] of Object.entries(LXC_SETTINGS)) {
    const value = values[key];
    if (earlier.has(key) || !isSet(value)) continue;
    if ("default" in setting && value === setting.default) continue;
    if (setting.type === "string" && setting.secret && value === "") continue;
    any = true;
    const name = key.slice(LXC_PREFIX.length);
    const field = LXC_FIELDS[name];
    if (field) {
      if (isSecret(field)) secrets[name] = String(value);
      else if (!("default" in field) || value !== field.default) fields[name] = value as FieldValue;
      continue;
    }
    const flavour = LXC_FLAVOURS.find((candidate) => key === flavourKey(candidate, "warm"));
    if (flavour && typeof value === "number" && value !== 0) warm[WARM_KIND[flavour]] = value;
  }
  if (!any) return null;
  return { enabled: values[LXC_KEYS.enabled] !== false, fields, secrets, warm };
}

/**
 * The size each kind's boxes had under the settings before 028, for the
 * kinds whose flavour had any of them saved. Unset parts are what bb-box
 * made then: 2 cores and 4 GiB for Linux boxes, 4 cores and 8 GiB for
 * desktops, and the template's disk.
 */
export function earlierLxcSizes(input: Readonly<Record<string, unknown>>): Record<string, BoxSize> {
  const values = withEarlierKeys(input);
  const sizes: Record<string, BoxSize> = {};
  for (const flavour of LXC_FLAVOURS) {
    const saved = SIZE_FIELDS.filter((field) => values[flavourKey(flavour, field)] !== undefined && values[flavourKey(flavour, field)] !== null);
    if (!saved.length) continue;
    const linux = flavour === "linux";
    const cores = number(values, flavourKey(flavour, "cores"), linux ? 2 : 4);
    const memoryMiB = number(values, flavourKey(flavour, "memory-mib"), linux ? 4096 : 8192);
    const diskGiB = number(values, flavourKey(flavour, "disk-gib"), 0);
    if (!wholeInRange(cores, 1, 1024) || !wholeInRange(memoryMiB, 256, 16_777_216) || !wholeInRange(diskGiB, 0, 65_536)) continue;
    for (const kind of FLAVOUR_KINDS[flavour]) sizes[kind] = { cores, memoryMiB, diskGiB: diskGiB === 0 ? null : diskGiB };
  }
  return sizes;
}

/**
 * A flavour's template list. Entries are separated by commas or new lines,
 * or by spaces when there are no GPU IDs. A GPU desktop entry is a VMID and a
 * GPU ID, separated by a space or "=".
 */
function templateList(values: Readonly<Record<string, unknown>>, flavour: LxcFlavour, problem: Problem): LxcTemplate[] {
  const key = flavourKey(flavour, "templates");
  const raw = values[key];
  const fallback = flavour === "linux" ? String(LXC_DEFAULTS.linuxTemplate) : "";
  // A settings file may give a lone VMID as a number.
  const listed = typeof raw === "number" ? (raw > 0 ? String(raw) : "") : text(values, key, fallback);
  const gpu = flavour === "desktop";
  const entries = listed.split(gpu ? /[,\n]+/ : /[\s,]+/).map((entry) => entry.trim()).filter(Boolean);
  const name = FLAVOUR_WORDS[flavour].name;
  const templates: LxcTemplate[] = [];
  for (const entry of entries) {
    const [vmidText = "", id = "", ...rest] = entry.split(/\s*=\s*|\s+/);
    const vmid = Number(vmidText);
    if (!wholeInRange(vmid, 100, 999_999_999) || rest.length || (!gpu && id)) {
      problem(
        key,
        gpu
          ? `Use one line per GPU desktop template, with its VMID and its GPU's ID, like "9101 GPU-0a1b2c3d". "${entry}" is not.`
          : `Use VMIDs from 100 for the ${name} templates. "${entry}" is not one.`,
      );
      continue;
    }
    if (gpu && !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(id)) {
      problem(key, `Give GPU desktop template ${vmid} the ID of its GPU, like "${vmid} GPU-0a1b2c3d".`);
      continue;
    }
    templates.push({ vmid, gpu: gpu ? id : null });
  }
  return templates;
}


/** Flat settings, as the tests and the smoke script give them. A problem names no field. */
export function parseLxcSettings(input: Readonly<Record<string, unknown>>): ParsedSettings<LxcConfig> {
  if (input[LXC_KEYS.enabled] === false) return { enabled: false };
  const { config, problems } = checkLxc(withEarlierKeys(input));
  if (problems.length) return { enabled: true, ok: false, problems: problems.map((problem) => problem.message) };
  return { enabled: true, ok: true, config: config! };
}

/** Proxmox LXC's part of bb-box's configuration (029), with each problem at its field. */
export function parseLxcPart(part: BackendPart): ParsedBackend<LxcConfig> {
  const values: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(part.fields)) values[LXC_PREFIX + field] = value;
  const { config, problems } = checkLxc(values);
  return problems.length ? { ok: false, problems } : { ok: true, config: config! };
}

function checkLxc(values: Readonly<Record<string, unknown>>): { config: LxcConfig | null; problems: FieldProblem[] } {
  const problems: FieldProblem[] = [];
  const problem: Problem = (key, message) => problems.push({ path: key.slice(LXC_PREFIX.length), message });

  const proxmox = checkConnection(values, LXC_KEYS, LXC_DEFAULTS, problem);

  const flavours = {} as Record<LxcFlavour, LxcFlavourConfig>;
  for (const flavour of LXC_FLAVOURS) {
    flavours[flavour] = { templates: templateList(values, flavour, problem) };
  }
  const listed = LXC_FLAVOURS.flatMap((flavour) => flavours[flavour].templates.map((template) => template.vmid));
  for (const vmid of new Set(listed.filter((vmid, index) => listed.indexOf(vmid) !== index))) {
    const first = LXC_FLAVOURS.find((flavour) => flavours[flavour].templates.some((template) => template.vmid === vmid))!;
    problem(flavourKey(first, "templates"), `Template ${vmid} is listed more than once. List each template once, under one flavour.`);
  }
  if (!listed.length) problem(flavourKey("linux", "templates"), "Set the VMID of at least one CT template: Linux, GPU desktop, CPU desktop or CPU Wayland desktop.");

  const vmids = checkVmids(values, LXC_KEYS, LXC_DEFAULTS, listed, problem);
  const network = checkNetwork(values, LXC_KEYS, LXC_DEFAULTS, vmids, problem);
  const ssh = checkSsh(values, LXC_KEYS, LXC_DEFAULTS, problem);

  const perGpu = number(values, LXC_KEYS.perGpu, 0);
  if (!wholeInRange(perGpu, 0, 1_000)) problem(LXC_KEYS.perGpu, "Use 0 or more for the desktops per GPU.");

  const reserve = checkReserve(values, LXC_KEYS, LXC_DEFAULTS, problem);

  if (problems.length) return { config: null, problems };
  return {
    problems,
    config: {
      proxmox,
      flavours,
      desktop: { perGpu: perGpu > 0 ? perGpu : null },
      vmids,
      network,
      ssh,
      reserve,
    },
  };
}

/** The static net0 line for a VMID. Proxmox gives the interface a new MAC. */
export function net0For(config: LxcConfig, vmid: number): string {
  const address = addressFor(config, vmid);
  if (!address) throw new Error(`VMID ${vmid} is outside the box range.`);
  return `name=eth0,bridge=${config.network.bridge},ip=${address}/${config.network.prefix},gw=${config.network.gateway},type=veth`;
}
