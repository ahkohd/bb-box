// Settings of the Proxmox LXC backend, parsed into a typed config. Every key
// starts with "proxmox-lxc-". The plugin's settings page, the smoke script's
// settings file and the tests all go through parseLxcSettings.
//
// Each VMID in the owned range has a fixed address: the n-th VMID gets the
// n-th address. Proxmox refuses a second guest with the same VMID, so two
// boxes never share an address and no address is stored or leased.

import type { PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import type { ParsedSettings } from "../types.ts";

export const LXC_KINDS = ["linux-headless", "linux-desktop"] as const;
export type LxcKind = (typeof LXC_KINDS)[number];

/** Setting key fragment of each kind. */
const KIND_KEY: Record<LxcKind, "headless" | "desktop"> = { "linux-headless": "headless", "linux-desktop": "desktop" };

export interface LxcKindConfig {
  /** CT template VMID, or null when this kind is not set up. */
  readonly template: number | null;
  readonly cores: number;
  readonly memoryMiB: number;
  readonly diskGiB: number;
  /** Ready boxes kept in the warm pool. */
  readonly warm: number;
}

export interface LxcConfig {
  readonly proxmox: {
    readonly apiUrl: string;
    readonly tokenId: string;
    readonly tokenSecret: string;
    readonly caCertificate: string | null;
    /** Null means the API's only node. */
    readonly node: string | null;
    readonly pool: string;
  };
  readonly kinds: Readonly<Record<LxcKind, LxcKindConfig>>;
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
  pool: "bb-box",
  vmidFirst: 7000,
  vmidLast: 7099,
  "linux-headless": { cores: 2, memoryMiB: 4096, diskGiB: 16 },
  "linux-desktop": { cores: 4, memoryMiB: 8192, diskGiB: 32 },
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
  reserveMemoryMiB: "proxmox-lxc-reserve-memory-mib",
  reserveDiskGiB: "proxmox-lxc-reserve-disk-gib",
} as const;

export function kindKey(kind: LxcKind, field: "template" | "cores" | "memory-mib" | "disk-gib" | "warm"): string {
  return `proxmox-lxc-${KIND_KEY[kind]}-${field}`;
}

function kindSettings(kind: LxcKind): Record<string, PluginSettingDescriptor> {
  const defaults = LXC_DEFAULTS[kind];
  return {
    [kindKey(kind, "template")]: {
      type: "number",
      label: `Proxmox LXC: ${kind} template VMID`,
      description: `The CT template ${kind} boxes are linked clones of. 0 turns the kind off.`,
      default: 0,
    },
    [kindKey(kind, "cores")]: { type: "number", label: `Proxmox LXC: ${kind} cores`, default: defaults.cores },
    [kindKey(kind, "memory-mib")]: { type: "number", label: `Proxmox LXC: ${kind} memory (MiB)`, default: defaults.memoryMiB },
    [kindKey(kind, "disk-gib")]: {
      type: "number",
      label: `Proxmox LXC: ${kind} disk (GiB)`,
      description: "The root disk grows to this size if the template's is smaller.",
      default: defaults.diskGiB,
    },
    [kindKey(kind, "warm")]: {
      type: "number",
      label: `Proxmox LXC: warm ${kind} boxes`,
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
    description: "For example https://pve.example.com:8006.",
    default: "",
  },
  [LXC_KEYS.tokenId]: {
    type: "string",
    label: "Proxmox LXC: API token ID",
    description: "For example bb-box@pve!plugin. The setup guide lists the privileges it needs.",
    default: "",
  },
  [LXC_KEYS.tokenSecret]: { type: "string", label: "Proxmox LXC: API token secret", secret: true },
  [LXC_KEYS.caCertificate]: {
    type: "string",
    label: "Proxmox LXC: CA certificate",
    description: "PEM certificate of the CA that signed the Proxmox API's certificate. Leave empty for a publicly trusted one.",
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
  ...kindSettings("linux-headless"),
  ...kindSettings("linux-desktop"),
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
    description: "The bridge boxes attach to, for example vmbr1.",
    default: "",
  },
  [LXC_KEYS.subnet]: {
    type: "string",
    label: "Proxmox LXC: subnet",
    description: "The bridge's subnet in CIDR form, for example 10.10.10.0/24. Boxes get static addresses; there is no DHCP.",
    default: "",
  },
  [LXC_KEYS.gateway]: {
    type: "string",
    label: "Proxmox LXC: gateway",
    description: "For example 10.10.10.1.",
    default: "",
  },
  [LXC_KEYS.addresses]: {
    type: "string",
    label: "Proxmox LXC: box addresses",
    description:
      "A range such as 10.10.10.100-10.10.10.199. The n-th VMID gets the n-th address. Leave empty to use the whole subnet except the gateway.",
    default: "",
  },
  [LXC_KEYS.sshPrivateKey]: {
    type: "string",
    label: "Proxmox LXC: SSH private key",
    description:
      "An unencrypted OpenSSH private key whose public key is in the templates' authorized_keys. Leave empty and bb-box makes one and shows its public key in the panel.",
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

export function parseLxcSettings(values: Readonly<Record<string, unknown>>): ParsedSettings<LxcConfig> {
  if (values[LXC_KEYS.enabled] === false) return { enabled: false };
  const problems: string[] = [];

  const apiUrl = text(values, LXC_KEYS.url).replace(/\/+$/, "");
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
  else if (!/^[^\s@!=]+@[^\s@!=]+![^\s@!=]+$/.test(tokenId)) problems.push("Use a token ID like bb-box@pve!plugin.");
  const tokenSecret = text(values, LXC_KEYS.tokenSecret);
  if (!tokenSecret) problems.push("Set the Proxmox API token secret.");
  const caCertificate = text(values, LXC_KEYS.caCertificate) || null;
  if (caCertificate && !caCertificate.includes("-----BEGIN CERTIFICATE-----")) {
    problems.push("Use a PEM certificate for the Proxmox CA, or leave it empty.");
  }
  const node = text(values, LXC_KEYS.node) || null;
  if (node && !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(node)) problems.push("Use the node's name as Proxmox shows it.");
  const pool = text(values, LXC_KEYS.pool, LXC_DEFAULTS.pool);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(pool)) problems.push("Use a Proxmox pool name such as bb-box.");

  const kinds = {} as Record<LxcKind, LxcKindConfig>;
  for (const kind of LXC_KINDS) {
    const template = number(values, kindKey(kind, "template"), 0);
    const config: LxcKindConfig = {
      template: template > 0 ? template : null,
      cores: number(values, kindKey(kind, "cores"), LXC_DEFAULTS[kind].cores),
      memoryMiB: number(values, kindKey(kind, "memory-mib"), LXC_DEFAULTS[kind].memoryMiB),
      diskGiB: number(values, kindKey(kind, "disk-gib"), LXC_DEFAULTS[kind].diskGiB),
      warm: number(values, kindKey(kind, "warm"), 0),
    };
    if (config.template !== null && !wholeInRange(config.template, 100, 999_999_999)) {
      problems.push(`Use a VMID from 100 for the ${kind} template.`);
    }
    if (!wholeInRange(config.cores, 1, 128)) problems.push(`Use 1 to 128 ${kind} cores.`);
    if (!wholeInRange(config.memoryMiB, 256, 1_048_576)) problems.push(`Use 256 MiB or more of ${kind} memory.`);
    if (!wholeInRange(config.diskGiB, 1, 16_384)) problems.push(`Use a ${kind} disk of 1 GiB or more.`);
    if (!wholeInRange(config.warm, 0, 20)) problems.push(`Keep 0 to 20 warm ${kind} boxes.`);
    kinds[kind] = config;
  }
  if (!LXC_KINDS.some((kind) => kinds[kind].template !== null)) problems.push("Set the CT template VMID of at least one kind.");

  const first = number(values, LXC_KEYS.vmidFirst, LXC_DEFAULTS.vmidFirst);
  const last = number(values, LXC_KEYS.vmidLast, LXC_DEFAULTS.vmidLast);
  if (!wholeInRange(first, 100, 999_999_999) || !wholeInRange(last, first, 999_999_999)) {
    problems.push("Use a VMID range from 100 whose last VMID is not below its first.");
  }
  for (const kind of LXC_KINDS) {
    const template = kinds[kind].template;
    if (template !== null && template >= first && template <= last) {
      problems.push(`Move the ${kind} template out of the box VMID range.`);
    }
  }

  const bridge = text(values, LXC_KEYS.bridge);
  if (!bridge) problems.push("Set the network bridge.");
  else if (!/^[A-Za-z0-9_.-]{1,15}$/.test(bridge)) problems.push("Use a Linux bridge name such as vmbr1.");
  const [networkText = "", prefixText = ""] = text(values, LXC_KEYS.subnet).split("/");
  const network = parseIpv4(networkText);
  const prefix = Number(prefixText);
  const gatewayText = text(values, LXC_KEYS.gateway);
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
    const range = text(values, LXC_KEYS.addresses);
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

  const reserveMemoryMiB = number(values, LXC_KEYS.reserveMemoryMiB, LXC_DEFAULTS.reserveMemoryMiB);
  const reserveDiskGiB = number(values, LXC_KEYS.reserveDiskGiB, LXC_DEFAULTS.reserveDiskGiB);
  if (!wholeInRange(reserveMemoryMiB, 0, 16_777_216)) problems.push("Keep 0 MiB or more of memory free.");
  if (!wholeInRange(reserveDiskGiB, 0, 1_048_576)) problems.push("Keep 0 GiB or more of disk free.");

  if (problems.length) return { enabled: true, ok: false, problems };
  return {
    enabled: true,
    ok: true,
    config: {
      proxmox: { apiUrl, tokenId, tokenSecret, caCertificate, node, pool },
      kinds,
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
