// Settings of the Tart backend, parsed into a typed config. Every key starts
// with "tart-". The plugin's settings page, the smoke script's settings file
// and the tests all go through parseTartSettings.
//
// The backend runs macOS VMs with Tart on one or more Macs. bb-box reaches
// each Mac over SSH as its host user, runs `tart` there, and reaches each VM
// through the Mac, since the VMs sit on the Mac's own NAT. Each kind is
// cloned from a Tart VM on every Mac, prepared by the setup guide.

import type { PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { normalisePrivateKey } from "../../transports/ssh.ts";
import type { ParsedSettings } from "../types.ts";

export const TART_KINDS = ["macos", "macos-desktop"] as const;
export type TartKind = (typeof TART_KINDS)[number];

/** Apple's macOS licence and the Virtualization framework allow two macOS VMs per Mac. */
export const MACOS_VMS_PER_MAC = 2;

export interface TartHost {
  /** A short name for the Mac, shown as the box's host. */
  readonly name: string;
  readonly user: string;
  readonly address: string;
  readonly port: number;
}

export interface TartKindConfig {
  /** The Tart VM on each Mac that boxes of the kind are cloned from, or null when the kind is off. */
  readonly image: string | null;
}

export interface TartConfig {
  readonly hosts: readonly TartHost[];
  /** known_hosts lines for the Macs. Every Mac's key is pinned. */
  readonly hostKeys: readonly string[];
  readonly kinds: Readonly<Record<TartKind, TartKindConfig>>;
  /** The most macOS VMs bb-box lets run on each Mac, counting every VM Tart lists there. */
  readonly vmsPerHost: number;
  /** A null key means bb-box generates one and shows its public key. */
  readonly ssh: { readonly privateKey: string | null; readonly vmUser: string };
  readonly reserve: { readonly memoryMiB: number; readonly diskGiB: number };
}

export const TART_DEFAULTS = {
  image: "bb-box-macos",
  vmUser: "admin",
  reserveMemoryMiB: 16384,
  reserveDiskGiB: 50,
} as const;

/** Setting keys. Every key starts with "tart-". */
export const TART_KEYS = {
  enabled: "tart-enabled",
  hosts: "tart-hosts",
  hostKeys: "tart-host-keys",
  sshPrivateKey: "tart-ssh-private-key",
  vmUser: "tart-vm-user",
  macosImage: "tart-macos-image",
  desktopImage: "tart-macos-desktop-image",
  vmsPerHost: "tart-vms-per-host",
  reserveMemoryMiB: "tart-reserve-memory-mib",
  reserveDiskGiB: "tart-reserve-disk-gib",
} as const;

const IMAGE_KEYS: Readonly<Record<TartKind, string>> = { macos: TART_KEYS.macosImage, "macos-desktop": TART_KEYS.desktopImage };

export const TART_SETTINGS: Record<string, PluginSettingDescriptor> = {
  [TART_KEYS.enabled]: {
    type: "boolean",
    label: "Tart: enabled",
    description: "Offer macOS boxes as Tart VMs on your Macs with Apple silicon.",
    default: false,
  },
  [TART_KEYS.hosts]: {
    type: "string",
    label: "Tart: Macs",
    description:
      "One line per Mac: a short name, a space, and the user bb-box logs in as, as user@address, with :port when SSH is not on 22. For example mac1 bbbox-admin@192.0.2.20.",
    experimental_multiline: true,
    default: "",
  },
  [TART_KEYS.hostKeys]: {
    type: "string",
    label: "Tart: Mac host keys",
    description:
      "The Macs' SSH host keys as known_hosts lines, one per line. ssh-keyscan -t ed25519 <address> prints one. bb-box checks them on every connection.",
    experimental_multiline: true,
    default: "",
  },
  [TART_KEYS.sshPrivateKey]: {
    type: "string",
    label: "Tart: SSH private key",
    description:
      "The unencrypted OpenSSH private key that each Mac's user and each image's VM user accept. Leave empty and bb-box makes one and shows its public key.",
    secret: true,
  },
  [TART_KEYS.vmUser]: {
    type: "string",
    label: "Tart: VM user",
    description: "The user in the images that bb-box and BB work as. It is logged in to the desktop automatically.",
    default: TART_DEFAULTS.vmUser,
  },
  [TART_KEYS.macosImage]: {
    type: "string",
    label: "Tart: macos image",
    description: "The Tart VM on each Mac that macos boxes, with no desktop shown, are cloned from. Empty turns them off.",
    default: TART_DEFAULTS.image,
  },
  [TART_KEYS.desktopImage]: {
    type: "string",
    label: "Tart: macos-desktop image",
    description: "The Tart VM on each Mac that macos-desktop boxes are cloned from. Empty turns them off.",
    default: TART_DEFAULTS.image,
  },
  [TART_KEYS.vmsPerHost]: {
    type: "number",
    label: "Tart: VMs per Mac",
    description:
      "The most macOS VMs that run on each Mac at once, counting every VM Tart runs there, not only bb-box's. At most 2, which Apple's licence and the Virtualization framework allow.",
    default: MACOS_VMS_PER_MAC,
  },
  [TART_KEYS.reserveMemoryMiB]: {
    type: "number",
    label: "Tart: memory kept free (MiB)",
    description: "A new box is refused if the Mac would have less memory than this left for its own use, after its running VMs.",
    default: TART_DEFAULTS.reserveMemoryMiB,
  },
  [TART_KEYS.reserveDiskGiB]: {
    type: "number",
    label: "Tart: disk kept free (GiB)",
    description: "A new box is refused if the Mac's disk has less free space than this.",
    default: TART_DEFAULTS.reserveDiskGiB,
  },
};

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

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const USER = /^[a-z_][a-z0-9_.-]{0,31}$/i;
/** A Tart VM name, as bb-box passes it: no spaces, quotes or slashes. */
const VM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** One Mac per line: `name user@address[:port]`. */
export function parseHosts(value: string): { hosts: TartHost[]; problems: string[] } {
  const hosts: TartHost[] = [];
  const problems: string[] = [];
  for (const line of value.split("\n").map((entry) => entry.trim())) {
    if (!line || line.startsWith("#")) continue;
    const [name, target, ...rest] = line.split(/\s+/);
    const match = /^([^@\s]+)@(\[[0-9a-fA-F:.]+\]|[^:@\s]+)(?::(\d+))?$/.exec(target ?? "");
    if (!name || !match || rest.length) {
      problems.push(`Tart: Mac line "${line}" must be a name, a space and user@address, for example mac1 bbbox-admin@192.0.2.20.`);
      continue;
    }
    const [, user, rawAddress, rawPort] = match;
    const port = rawPort ? Number(rawPort) : 22;
    if (!NAME.test(name)) problems.push(`Tart: Mac name "${name}" may hold only lower-case letters, digits and "-".`);
    else if (hosts.some((host) => host.name === name)) problems.push(`Tart: Mac name "${name}" is listed twice.`);
    if (!USER.test(user!)) problems.push(`Tart: "${user}" is not a user name.`);
    if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push(`Tart: port ${rawPort} of ${name} is not a port.`);
    hosts.push({ name, user: user!, address: rawAddress!.replace(/^\[|\]$/g, ""), port });
  }
  return { hosts, problems };
}

export function parseTartSettings(values: Readonly<Record<string, unknown>>): ParsedSettings<TartConfig> {
  if (values[TART_KEYS.enabled] !== true) return { enabled: false };
  const problems: string[] = [];

  const { hosts, problems: hostProblems } = parseHosts(text(values, TART_KEYS.hosts));
  problems.push(...hostProblems);
  if (!hosts.length && !hostProblems.length) problems.push("Tart: list at least one Mac.");

  const hostKeys = text(values, TART_KEYS.hostKeys)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  for (const line of hostKeys) {
    if (line.split(/\s+/).length < 3) problems.push(`Tart: host key line "${line}" must be a known_hosts line: address, key type and key.`);
  }
  if (!hostKeys.length) problems.push("Tart: give each Mac's SSH host key, as ssh-keyscan -t ed25519 <address> prints it.");

  const kinds = {} as Record<TartKind, TartKindConfig>;
  for (const kind of TART_KINDS) {
    const image = text(values, IMAGE_KEYS[kind], TART_DEFAULTS.image);
    if (image && !VM_NAME.test(image)) problems.push(`Tart: the ${kind} image "${image}" is not a Tart VM name bb-box can use.`);
    kinds[kind] = { image: image || null };
  }
  if (TART_KINDS.every((kind) => !kinds[kind].image)) problems.push("Tart: give an image for macos or macos-desktop boxes.");

  const vmsPerHost = number(values, TART_KEYS.vmsPerHost, MACOS_VMS_PER_MAC);
  if (!Number.isInteger(vmsPerHost) || vmsPerHost < 1 || vmsPerHost > MACOS_VMS_PER_MAC) {
    problems.push(`Tart: VMs per Mac must be 1 or ${MACOS_VMS_PER_MAC}.`);
  }
  const reserveMemoryMiB = number(values, TART_KEYS.reserveMemoryMiB, TART_DEFAULTS.reserveMemoryMiB);
  const reserveDiskGiB = number(values, TART_KEYS.reserveDiskGiB, TART_DEFAULTS.reserveDiskGiB);
  if (!(reserveMemoryMiB >= 0) || !(reserveDiskGiB >= 0)) problems.push("Tart: the memory and disk kept free cannot be negative.");

  const vmUser = text(values, TART_KEYS.vmUser, TART_DEFAULTS.vmUser);
  if (!USER.test(vmUser)) problems.push(`Tart: "${vmUser}" is not a user name.`);
  const keyText = text(values, TART_KEYS.sshPrivateKey);
  const privateKey = keyText ? normalisePrivateKey(keyText) : null;
  if (keyText && !privateKey) problems.push("Tart: use an unencrypted OpenSSH private key, or leave it empty for bb-box to make one.");

  if (problems.length) return { enabled: true, ok: false, problems };
  return {
    enabled: true,
    ok: true,
    config: {
      hosts,
      hostKeys,
      kinds,
      vmsPerHost,
      ssh: { privateKey, vmUser },
      reserve: { memoryMiB: reserveMemoryMiB, diskGiB: reserveDiskGiB },
    },
  };
}
