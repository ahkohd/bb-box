// Settings of the Proxmox LXC backend, parsed into a typed config. Every key
// starts with "proxmox-lxc-". The plugin's settings page, the smoke script's
// settings file and the tests all go through parseLxcSettings.
//
// Templates come in three flavours, each a list of CT templates: headless
// ones serve both headless kinds, GPU desktop ones (each carrying one GPU,
// named by an ID) serve linux-desktop, and CPU-only desktop ones serve
// linux-desktop-cpu. A new box is cloned from the flavour's least used
// template; a GPU desktop goes to the GPU with the fewest desktops.
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

import type { PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import type { ParsedSettings } from "../types.ts";

export const LXC_FLAVOURS = ["headless", "desktop", "desktop-cpu"] as const;
export type LxcFlavour = (typeof LXC_FLAVOURS)[number];

/** The kinds each flavour's clones serve. */
export const FLAVOUR_KINDS: Readonly<Record<LxcFlavour, readonly string[]>> = {
  headless: ["linux-headless", "linux-headless-docker"],
  desktop: ["linux-desktop"],
  "desktop-cpu": ["linux-desktop-cpu"],
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
  readonly cores: number;
  readonly memoryMiB: number;
  /** Root disk size, or null to keep the template's. A larger size is applied while the box runs. */
  readonly diskGiB: number | null;
  /** Ready boxes kept in the warm pool. */
  readonly warm: number;
}

export interface LxcConfig {
  readonly proxmox: {
    readonly apiUrl: string;
    readonly tokenId: string;
    readonly tokenSecret: string;
    readonly caCertificate: string | null;
    /** SHA-256 of the API's certificate, as AA:BB:..., pinned instead of checking its CA. */
    readonly tlsFingerprint: string | null;
    /** Null means the API's only node. */
    readonly node: string | null;
    readonly pool: string;
  };
  readonly flavours: Readonly<Record<LxcFlavour, LxcFlavourConfig>>;
  readonly desktop: {
    /** The most desktop boxes each GPU runs at once, or null for no limit. */
    readonly perGpu: number | null;
  };
  readonly vmids: { readonly first: number; readonly last: number };
  readonly network: {
    readonly bridge: string;
    readonly prefix: number;
    readonly gateway: string;
    /** Address of the n-th VMID in the range. */
    readonly addresses: readonly string[];
  };
  /** A null key means bb-box generates one and shows its public key. */
  readonly ssh: { readonly privateKey: string | null; readonly user: string };
  readonly reserve: { readonly memoryMiB: number; readonly diskGiB: number };
}

export const LXC_DEFAULTS = {
  pool: "bbbox",
  headlessTemplate: 9100,
  vmidFirst: 9900,
  vmidLast: 9999,
  headless: { cores: 2, memoryMiB: 4096 },
  desktop: { cores: 4, memoryMiB: 8192 },
  "desktop-cpu": { cores: 4, memoryMiB: 8192 },
  bridge: "vmbr200",
  subnet: "10.200.0.0/24",
  gateway: "10.200.0.1",
  addresses: "10.200.0.10-10.200.0.254",
  sshUser: "box",
  reserveMemoryMiB: 4096,
  reserveDiskGiB: 50,
} as const;

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

export function flavourKey(flavour: LxcFlavour, field: "templates" | "cores" | "memory-mib" | "disk-gib" | "warm"): string {
  return `proxmox-lxc-${flavour}-${field}`;
}

const FLAVOUR_WORDS: Readonly<Record<LxcFlavour, { readonly name: string; readonly templates: string }>> = {
  headless: {
    name: "headless",
    templates: "VMIDs of the CT templates linux-headless and linux-headless-docker boxes are linked clones of, separated by spaces or commas. Empty turns them off.",
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
};

function flavourSettings(flavour: LxcFlavour): Record<string, PluginSettingDescriptor> {
  const defaults = LXC_DEFAULTS[flavour];
  const { name, templates } = FLAVOUR_WORDS[flavour];
  return {
    [flavourKey(flavour, "templates")]: {
      type: "string",
      label: `Proxmox LXC: ${name} templates`,
      description: templates,
      ...(flavour === "desktop" ? { experimental_multiline: true } : {}),
      default: flavour === "headless" ? String(LXC_DEFAULTS.headlessTemplate) : "",
    },
    [flavourKey(flavour, "cores")]: { type: "number", label: `Proxmox LXC: ${name} cores`, default: defaults.cores },
    [flavourKey(flavour, "memory-mib")]: { type: "number", label: `Proxmox LXC: ${name} memory (MiB)`, default: defaults.memoryMiB },
    [flavourKey(flavour, "disk-gib")]: {
      type: "number",
      label: `Proxmox LXC: ${name} disk (GiB)`,
      description: "0 keeps the template's size, which is quickest. A larger size is applied after the box starts, in about a second.",
      default: 0,
    },
    [flavourKey(flavour, "warm")]: {
      type: "number",
      label: `Proxmox LXC: warm ${name} boxes`,
      description: "Ready boxes kept started and waiting, so a new box is ready at once. 0 turns the warm pool off.",
      default: 0,
    },
  };
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
  ...flavourSettings("headless"),
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
};

export function parseIpv4(value: string): number | null {
  const parts = value.trim().split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result;
}

export function formatIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".");
}

/** A string setting, or `fallback` when the key is absent. An empty string stays empty. */
function text(values: Readonly<Record<string, unknown>>, key: string, fallback = ""): string {
  const value = values[key];
  if (value === undefined || value === null) return fallback;
  return typeof value === "string" ? value.trim() : "";
}

function number(values: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const value = values[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function wholeInRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/**
 * A flavour's template list. Entries are separated by commas or new lines,
 * or by spaces when there are no GPU IDs. A GPU desktop entry is a VMID and a
 * GPU ID, separated by a space or "=".
 */
function templateList(
  values: Readonly<Record<string, unknown>>,
  flavour: LxcFlavour,
  problems: string[],
): LxcTemplate[] {
  const key = flavourKey(flavour, "templates");
  const raw = values[key];
  const fallback = flavour === "headless" ? String(LXC_DEFAULTS.headlessTemplate) : "";
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
      problems.push(
        gpu
          ? `Use one line per GPU desktop template, with its VMID and its GPU's ID, like "9101 GPU-0a1b2c3d". "${entry}" is not.`
          : `Use VMIDs from 100 for the ${name} templates. "${entry}" is not one.`,
      );
      continue;
    }
    if (gpu && !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(id)) {
      problems.push(`Give GPU desktop template ${vmid} the ID of its GPU, like "${vmid} GPU-0a1b2c3d".`);
      continue;
    }
    templates.push({ vmid, gpu: gpu ? id : null });
  }
  return templates;
}

/**
 * An OpenSSH private key in its usual form. Accepts a key pasted into a
 * one-line field, whose line breaks became spaces, and a base64-encoded key file.
 */
export function normalisePrivateKey(value: string): string | null {
  let key = value.trim();
  if (!key) return null;
  if (!key.includes("-----BEGIN")) {
    try {
      const decoded = Buffer.from(key, "base64").toString("utf8").trim();
      if (!decoded.startsWith("-----BEGIN")) return null;
      key = decoded;
    } catch {
      return null;
    }
  }
  const match = /^-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----([\s\S]*?)-----END \1-----$/.exec(key);
  if (!match) return null;
  const body = match[2]!.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(body)) return null;
  const lines = body.match(/.{1,70}/g) ?? [];
  return `-----BEGIN ${match[1]}-----\n${lines.join("\n")}\n-----END ${match[1]}-----\n`;
}

/** A SHA-256 fingerprint as AA:BB:..., from hex with or without colons, or null. */
export function normaliseFingerprint(value: string): string | null {
  const hex = value.trim().replace(/^sha256[:=]?\s*/i, "").replace(/[:\s]/g, "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) return null;
  return hex.match(/../g)!.join(":");
}

export function parseLxcSettings(values: Readonly<Record<string, unknown>>): ParsedSettings<LxcConfig> {
  if (values[LXC_KEYS.enabled] === false) return { enabled: false };
  const problems: string[] = [];

  // The setup guide's token file gives the URL with /api2/json, which the client adds itself.
  const apiUrl = text(values, LXC_KEYS.url).replace(/\/+$/, "").replace(/\/api2\/json$/, "");
  if (!apiUrl) problems.push("Set the Proxmox API URL.");
  else {
    try {
      const url = new URL(apiUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
      if (url.username || url.password) problems.push("Remove credentials from the Proxmox API URL.");
    } catch {
      problems.push("Use an https URL for the Proxmox API, for example https://pve.example.com:8006.");
    }
  }
  const tokenId = text(values, LXC_KEYS.tokenId);
  if (!tokenId) problems.push("Set the Proxmox API token ID.");
  else if (!/^[^\s@!=]+@[^\s@!=]+![^\s@!=]+$/.test(tokenId)) problems.push("Use a token ID like bbbox@pve!plugin.");
  const tokenSecret = text(values, LXC_KEYS.tokenSecret);
  if (!tokenSecret) problems.push("Set the Proxmox API token secret.");
  const fingerprintText = text(values, LXC_KEYS.tlsFingerprint);
  const tlsFingerprint = fingerprintText ? normaliseFingerprint(fingerprintText) : null;
  if (fingerprintText && !tlsFingerprint) problems.push("Use a SHA-256 fingerprint like AB:CD:..., with 32 pairs of hex digits.");
  const caCertificate = text(values, LXC_KEYS.caCertificate) || null;
  if (caCertificate && !caCertificate.includes("-----BEGIN CERTIFICATE-----")) {
    problems.push("Use a PEM certificate for the Proxmox CA, or leave it empty.");
  }
  const node = text(values, LXC_KEYS.node) || null;
  if (node && !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(node)) problems.push("Use the node's name as Proxmox shows it.");
  const pool = text(values, LXC_KEYS.pool, LXC_DEFAULTS.pool);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(pool)) problems.push("Use a Proxmox pool name such as bbbox.");

  const flavours = {} as Record<LxcFlavour, LxcFlavourConfig>;
  for (const flavour of LXC_FLAVOURS) {
    const name = FLAVOUR_WORDS[flavour].name;
    const diskGiB = number(values, flavourKey(flavour, "disk-gib"), 0);
    const config: LxcFlavourConfig = {
      templates: templateList(values, flavour, problems),
      cores: number(values, flavourKey(flavour, "cores"), LXC_DEFAULTS[flavour].cores),
      memoryMiB: number(values, flavourKey(flavour, "memory-mib"), LXC_DEFAULTS[flavour].memoryMiB),
      diskGiB: diskGiB === 0 ? null : diskGiB,
      warm: number(values, flavourKey(flavour, "warm"), 0),
    };
    if (!wholeInRange(config.cores, 1, 128)) problems.push(`Use 1 to 128 cores for ${name} boxes.`);
    if (!wholeInRange(config.memoryMiB, 256, 1_048_576)) problems.push(`Use 256 MiB or more of memory for ${name} boxes.`);
    if (config.diskGiB !== null && !wholeInRange(config.diskGiB, 1, 16_384)) problems.push(`Use 0, or a disk of 1 GiB or more, for ${name} boxes.`);
    if (!wholeInRange(config.warm, 0, 20)) problems.push(`Keep 0 to 20 warm ${name} boxes.`);
    flavours[flavour] = config;
  }
  const listed = LXC_FLAVOURS.flatMap((flavour) => flavours[flavour].templates.map((template) => template.vmid));
  for (const vmid of new Set(listed.filter((vmid, index) => listed.indexOf(vmid) !== index))) {
    problems.push(`Template ${vmid} is listed more than once. List each template once, under one flavour.`);
  }
  if (!listed.length) problems.push("Set the VMID of at least one CT template: headless, GPU desktop or CPU desktop.");

  const first = number(values, LXC_KEYS.vmidFirst, LXC_DEFAULTS.vmidFirst);
  const last = number(values, LXC_KEYS.vmidLast, LXC_DEFAULTS.vmidLast);
  if (!wholeInRange(first, 100, 999_999_999) || !wholeInRange(last, first, 999_999_999)) {
    problems.push("Use a VMID range from 100 whose last VMID is not below its first.");
  }
  for (const vmid of new Set(listed)) {
    if (vmid >= first && vmid <= last) problems.push(`Move template ${vmid} out of the box VMID range.`);
  }

  const bridge = text(values, LXC_KEYS.bridge, LXC_DEFAULTS.bridge);
  if (!bridge) problems.push("Set the network bridge.");
  else if (!/^[A-Za-z0-9_.-]{1,15}$/.test(bridge)) problems.push("Use a Linux bridge name such as vmbr1.");
  const [networkText = "", prefixText = ""] = text(values, LXC_KEYS.subnet, LXC_DEFAULTS.subnet).split("/");
  const network = parseIpv4(networkText);
  const prefix = Number(prefixText);
  const gatewayText = text(values, LXC_KEYS.gateway, LXC_DEFAULTS.gateway);
  const gateway = parseIpv4(gatewayText);
  const addresses: string[] = [];
  if (network === null || !wholeInRange(prefix, 8, 30)) {
    problems.push("Set the subnet in CIDR form, for example 10.10.10.0/24.");
  } else if (gateway === null) {
    problems.push("Set the gateway address, for example 10.10.10.1.");
  } else {
    const size = 2 ** (32 - prefix);
    const base = network - (network % size);
    const broadcast = base + size - 1;
    if (gateway <= base || gateway >= broadcast) problems.push("Put the gateway inside the subnet.");
    let low = base + 1;
    let high = broadcast - 1;
    const range = text(values, LXC_KEYS.addresses, LXC_DEFAULTS.addresses);
    if (range) {
      const [from, to] = range.split("-").map((part) => parseIpv4(part));
      if (from == null || to == null || from > to) {
        problems.push("Use a box address range like 10.10.10.100-10.10.10.199.");
      } else if (from < low || to > high) {
        problems.push("Keep the box address range inside the subnet.");
      } else {
        low = from;
        high = to;
      }
    }
    const count = Number.isInteger(first) && Number.isInteger(last) ? last - first + 1 : 0;
    for (let address = low; address <= high && addresses.length < count; address++) {
      if (address !== gateway) addresses.push(formatIpv4(address));
    }
    if (count > 0 && addresses.length < count) {
      problems.push(`The box address range has ${addresses.length} addresses for ${count} VMIDs. Widen it or narrow the VMID range.`);
    }
  }

  const keyText = text(values, LXC_KEYS.sshPrivateKey);
  const privateKey = keyText ? normalisePrivateKey(keyText) : null;
  if (keyText && !privateKey) problems.push("Use an unencrypted OpenSSH private key, or leave it empty for bb-box to make one.");
  const user = text(values, LXC_KEYS.sshUser) || LXC_DEFAULTS.sshUser;
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) problems.push("Use a Linux user name for SSH.");

  const perGpu = number(values, LXC_KEYS.perGpu, 0);
  if (!wholeInRange(perGpu, 0, 1_000)) problems.push("Use 0 or more for the desktops per GPU.");

  const reserveMemoryMiB = number(values, LXC_KEYS.reserveMemoryMiB, LXC_DEFAULTS.reserveMemoryMiB);
  const reserveDiskGiB = number(values, LXC_KEYS.reserveDiskGiB, LXC_DEFAULTS.reserveDiskGiB);
  if (!wholeInRange(reserveMemoryMiB, 0, 16_777_216)) problems.push("Keep 0 MiB or more of memory free.");
  if (!wholeInRange(reserveDiskGiB, 0, 1_048_576)) problems.push("Keep 0 GiB or more of disk free.");

  if (problems.length) return { enabled: true, ok: false, problems };
  return {
    enabled: true,
    ok: true,
    config: {
      proxmox: { apiUrl, tokenId, tokenSecret, caCertificate, tlsFingerprint, node, pool },
      flavours,
      desktop: { perGpu: perGpu > 0 ? perGpu : null },
      vmids: { first, last },
      network: { bridge, prefix, gateway: gatewayText, addresses },
      ssh: { privateKey, user },
      reserve: { memoryMiB: reserveMemoryMiB, diskGiB: reserveDiskGiB },
    },
  };
}

export function addressFor(config: LxcConfig, vmid: number): string | null {
  return config.network.addresses[vmid - config.vmids.first] ?? null;
}

/** The static net0 line for a VMID. Proxmox gives the interface a new MAC. */
export function net0For(config: LxcConfig, vmid: number): string {
  const address = addressFor(config, vmid);
  if (!address) throw new Error(`VMID ${vmid} is outside the box range.`);
  return `name=eth0,bridge=${config.network.bridge},ip=${address}/${config.network.prefix},gw=${config.network.gateway},type=veth`;
}
