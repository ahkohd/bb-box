// Settings of the Tart backend, parsed into a typed config. In bb-box's
// configuration (029) the Macs are the backend's hosts, each with its
// address, user and host keys, and parseTartPart reads them. Before it, they
// were BB settings starting with "tart-", which the tests still use through
// parseTartSettings, and which bb-box moves into the configuration once.
//
// The backend runs macOS VMs, and Linux VMs on arm64 (040), with Tart on one
// or more Macs, and Windows VMs on arm64 with QEMU (046). bb-box reaches each
// Mac over SSH as its host user, runs `tart` or QEMU there, and reaches each
// VM through the Mac, since the VMs sit on the Mac's own NAT, or QEMU's. Each
// kind is cloned from an image on every Mac, prepared by the setup guide: a
// Tart VM, or for Windows a directory of QEMU's.

import type { PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { normalisePrivateKey } from "../../transports/ssh.ts";
import { hostKeysFor } from "../ssh-pool/config.ts";
import { fieldLabel, isSecret, type BackendPart, type EarlierBackend, type FieldDescriptor, type FieldProblem, type FieldValue, type ParsedBackend, type ParsedSettings } from "../types.ts";

export const TART_KINDS = ["macos", "macos-desktop", "linux-arm64", "linux-arm64-desktop-cpu", "windows-arm64-desktop"] as const;
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
  /** The image on each Mac that boxes of the kind are cloned from, or null when the kind is off: a Tart VM, or QEMU's for Windows. */
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
  /** Windows boxes join BB as machines, unless set off, as on Proxmox QEMU (#539). */
  readonly windowsEnrol: boolean;
  /** macOS desktops open as video by default, where every Mac's image has bb-box-stream (060); else VNC, with video a choice. Off by default. */
  readonly video: boolean;
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
  linuxImage: "tart-linux-image",
  linuxDesktopImage: "tart-linux-desktop-image",
  windowsImage: "tart-windows-image",
  windowsEnrol: "tart-windows-enrol",
  video: "tart-video",
  vmsPerHost: "tart-vms-per-host",
  reserveMemoryMiB: "tart-reserve-memory-mib",
  reserveDiskGiB: "tart-reserve-disk-gib",
} as const;

const IMAGE_KEYS: Readonly<Record<TartKind, string>> = {
  macos: TART_KEYS.macosImage,
  "macos-desktop": TART_KEYS.desktopImage,
  "linux-arm64": TART_KEYS.linuxImage,
  "linux-arm64-desktop-cpu": TART_KEYS.linuxDesktopImage,
  "windows-arm64-desktop": TART_KEYS.windowsImage,
};
/** The macOS kinds have an image by default; the Linux and Windows ones are off until given one. */
const IMAGE_DEFAULTS: Readonly<Record<TartKind, string>> = {
  macos: TART_DEFAULTS.image,
  "macos-desktop": TART_DEFAULTS.image,
  "linux-arm64": "",
  "linux-arm64-desktop-cpu": "",
  "windows-arm64-desktop": "",
};

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
    description: "The user in the macOS images that bb-box and BB work as. It is logged in to the desktop automatically. Linux boxes work as box.",
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
  [TART_KEYS.linuxImage]: {
    type: "string",
    label: "Tart: Linux image",
    description:
      "The Tart VM on each Mac that linux-arm64 boxes are cloned from, as setup/tart/prepare-linux-image.sh builds it (bb-box-linux). Empty turns them off.",
    default: "",
  },
  [TART_KEYS.linuxDesktopImage]: {
    type: "string",
    label: "Tart: Linux desktop image",
    description:
      "The Tart VM on each Mac that linux-arm64-desktop-cpu boxes are cloned from, as setup/tart/prepare-linux-image.sh --desktop builds it (bb-box-linux-desktop). Empty turns them off.",
    default: "",
  },
  [TART_KEYS.windowsImage]: {
    type: "string",
    label: "Tart: Windows image",
    description:
      "The Windows image on each Mac, in ~/.bb-box/qemu/images, that windows-arm64-desktop boxes are made from, run by QEMU. Empty turns them off.",
    default: "",
  },
  [TART_KEYS.windowsEnrol]: {
    type: "boolean",
    label: "Tart: Windows boxes as BB machines",
    description: "Windows boxes join BB as machines, so threads and terminals can use them, as Linux and macOS boxes do. Off, they are boxes only.",
    default: true,
  },
  [TART_KEYS.video]: {
    type: "boolean",
    label: "Tart: Video by default for macOS desktops",
    description:
      "macOS desktops open as video, from bb-box-stream in the image, not VNC. Off by default: they open as VNC, which is already smooth on a Tart Mac, at 52 to 55 frames a second, and a person can choose video under Display. Video uses much less bandwidth, about 1.2 Mbit/s against 20 while scrolling, but a key shows a little later, about 57 ms against 31.",
    default: false,
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
export function parseHosts(value: string): { hosts: TartHost[]; problems: string[]; skipped: string[] } {
  const hosts: TartHost[] = [];
  const problems: string[] = [];
  /** Lines in the wrong form, which give no Mac. */
  const skipped: string[] = [];
  for (const line of value.split("\n").map((entry) => entry.trim())) {
    if (!line || line.startsWith("#")) continue;
    const [name, target, ...rest] = line.split(/\s+/);
    const match = /^([^@\s]+)@(\[[0-9a-fA-F:.]+\]|[^:@\s]+)(?::(\d+))?$/.exec(target ?? "");
    if (!name || !match || rest.length) {
      problems.push(`Tart: Mac line "${line}" must be a name, a space and user@address, for example mac1 bbbox-admin@192.0.2.20.`);
      skipped.push(line);
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
  return { hosts, problems, skipped };
}

/** Adds a problem with the setting at `key`. */
type Problem = (key: string, message: string) => void;

/** Flat settings, as the tests give them. A problem names no field. */
export function parseTartSettings(values: Readonly<Record<string, unknown>>): ParsedSettings<TartConfig> {
  if (values[TART_KEYS.enabled] !== true) return { enabled: false };
  const problems: string[] = [];
  const problem: Problem = (_key, message) => problems.push(message);

  const { hosts, problems: hostProblems } = parseHosts(text(values, TART_KEYS.hosts));
  problems.push(...hostProblems);
  if (!hosts.length && !hostProblems.length) problems.push("Tart: list at least one Mac.");

  const hostKeys = keyLines(text(values, TART_KEYS.hostKeys), (message) => problems.push(message));
  if (!hostKeys.length) problems.push("Tart: give each Mac's SSH host key, as ssh-keyscan -t ed25519 <address> prints it.");

  const config = checkTart(values, hosts, hostKeys, problem);
  if (problems.length) return { enabled: true, ok: false, problems };
  return { enabled: true, ok: true, config };
}

/** known_hosts lines, without comments, each checked. */
function keyLines(value: string, problem: (message: string) => void): string[] {
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  for (const line of lines) {
    if (line.split(/\s+/).length < 3) problem(`Tart: host key line "${line}" must be a known_hosts line: address, key type and key.`);
  }
  return lines;
}

/** What a Tart backend is besides its Macs. */
function checkTart(values: Readonly<Record<string, unknown>>, hosts: readonly TartHost[], hostKeys: readonly string[], problem: Problem): TartConfig {
  const kinds = {} as Record<TartKind, TartKindConfig>;
  for (const kind of TART_KINDS) {
    const image = text(values, IMAGE_KEYS[kind], IMAGE_DEFAULTS[kind]);
    if (image && !VM_NAME.test(image)) problem(IMAGE_KEYS[kind], `Tart: the ${kind} image "${image}" is not ${kind.startsWith("windows") ? "an image" : "a Tart VM"} name bb-box can use.`);
    kinds[kind] = { image: image || null };
  }
  if (TART_KINDS.every((kind) => !kinds[kind].image)) problem(TART_KEYS.macosImage, "Tart: give an image for macOS, Linux or Windows boxes.");

  const vmsPerHost = number(values, TART_KEYS.vmsPerHost, MACOS_VMS_PER_MAC);
  if (!Number.isInteger(vmsPerHost) || vmsPerHost < 1 || vmsPerHost > MACOS_VMS_PER_MAC) {
    problem(TART_KEYS.vmsPerHost, `Tart: VMs per Mac must be 1 or ${MACOS_VMS_PER_MAC}.`);
  }
  const reserveMemoryMiB = number(values, TART_KEYS.reserveMemoryMiB, TART_DEFAULTS.reserveMemoryMiB);
  const reserveDiskGiB = number(values, TART_KEYS.reserveDiskGiB, TART_DEFAULTS.reserveDiskGiB);
  if (!(reserveMemoryMiB >= 0) || !(reserveDiskGiB >= 0)) {
    problem(reserveMemoryMiB >= 0 ? TART_KEYS.reserveDiskGiB : TART_KEYS.reserveMemoryMiB, "Tart: the memory and disk kept free cannot be negative.");
  }

  const vmUser = text(values, TART_KEYS.vmUser, TART_DEFAULTS.vmUser);
  if (!USER.test(vmUser)) problem(TART_KEYS.vmUser, `Tart: "${vmUser}" is not a user name.`);
  const keyText = text(values, TART_KEYS.sshPrivateKey);
  const privateKey = keyText ? normalisePrivateKey(keyText) : null;
  if (keyText && !privateKey) problem(TART_KEYS.sshPrivateKey, "Tart: use an unencrypted OpenSSH private key, or leave it empty for bb-box to make one.");

  return {
    hosts,
    hostKeys,
    kinds,
    vmsPerHost,
    ssh: { privateKey, vmUser },
    reserve: { memoryMiB: reserveMemoryMiB, diskGiB: reserveDiskGiB },
    windowsEnrol: values[TART_KEYS.windowsEnrol] !== false,
    video: values[TART_KEYS.video] === true,
  };
}

export const TART_PREFIX = "tart-";

/** The image fields name their kinds in words, where the settings named them by ID. */
const IMAGE_LABELS: Readonly<Record<string, string>> = {
  [TART_KEYS.macosImage]: "macOS image",
  [TART_KEYS.desktopImage]: "macOS desktop image",
  [TART_KEYS.linuxImage]: "Linux image (arm64)",
  [TART_KEYS.linuxDesktopImage]: "Linux desktop image (arm64)",
  [TART_KEYS.windowsImage]: "Windows image (arm64)",
};

/** The backend's fields in bb-box's configuration: the settings above without the prefix, but the Macs. */
export const TART_FIELDS: Readonly<Record<string, FieldDescriptor>> = Object.fromEntries(
  ([
    [TART_KEYS.sshPrivateKey, "credentials"],
    [TART_KEYS.macosImage, "boxes"],
    [TART_KEYS.desktopImage, "boxes"],
    [TART_KEYS.linuxImage, "boxes"],
    [TART_KEYS.linuxDesktopImage, "boxes"],
    [TART_KEYS.windowsImage, "boxes"],
    [TART_KEYS.windowsEnrol, "boxes"],
    [TART_KEYS.video, "boxes"],
    [TART_KEYS.vmUser, "advanced"],
    [TART_KEYS.vmsPerHost, "advanced"],
    [TART_KEYS.reserveMemoryMiB, "advanced"],
    [TART_KEYS.reserveDiskGiB, "advanced"],
  ] as const).map(([key, group]) => {
    const setting = TART_SETTINGS[key]!;
    return [key.slice(TART_PREFIX.length), { ...setting, label: IMAGE_LABELS[key] ?? fieldLabel(setting.label), group } as FieldDescriptor];
  }),
);

/** Each Mac's fields. A Mac's name and switch are the host's own. */
export const TART_HOST_FIELDS: Readonly<Record<string, FieldDescriptor>> = {
  address: { type: "string", label: "Address", description: "The Mac's address, with :port when SSH is not on 22. For example 192.0.2.20.", group: "connection", default: "" },
  user: { type: "string", label: "User", description: "The user bb-box logs in to the Mac as, which runs tart.", group: "connection", default: "" },
  "host-keys": {
    type: "string",
    label: "Host keys",
    description: "The Mac's SSH host keys as known_hosts lines. ssh-keyscan -t ed25519 <address> prints one. bb-box checks them on every connection.",
    experimental_multiline: true,
    group: "connection",
    default: "",
  },
};

/** Tart's part of bb-box's configuration (029), with each problem at its field. */
export function parseTartPart(part: BackendPart): ParsedBackend<TartConfig> {
  const problems: FieldProblem[] = [];
  const hosts: TartHost[] = [];
  const hostKeys: string[] = [];
  part.hosts.forEach((host, n) => {
    const at = (field: string) => (message: string) => problems.push({ path: `hosts.${n}.${field}`, message });
    const user = String(host.fields.user ?? "").trim();
    const address = String(host.fields.address ?? "").trim();
    const match = /^(\[[0-9a-fA-F:.]+\]|[^:@\s]+)(?::(\d+))?$/.exec(address);
    const port = match?.[2] ? Number(match[2]) : 22;
    if (!user || !USER.test(user)) at("user")(`Give the user bb-box logs in to Mac ${host.name} as.`);
    if (!match || !Number.isInteger(port) || port < 1 || port > 65535) at("address")(`Give Mac ${host.name}'s address, such as 192.0.2.20, with :port when SSH is not on 22.`);
    const keys = keyLines(String(host.fields["host-keys"] ?? ""), at("host-keys"));
    if (!keys.length) at("host-keys")(`Give Mac ${host.name}'s SSH host key, as ssh-keyscan -t ed25519 <address> prints it.`);
    if (match) hosts.push({ name: host.name, user, address: match[1]!.replace(/^\[|\]$/g, ""), port });
    hostKeys.push(...keys.filter((key) => !hostKeys.includes(key)));
  });
  const values: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(part.fields)) values[TART_PREFIX + field] = value;
  const config = checkTart(values, hosts, hostKeys, (key, message) => problems.push({ path: key.slice(TART_PREFIX.length), message }));
  return problems.length ? { ok: false, problems } : { ok: true, config };
}

/** The backend's settings from before 029 that differ from their defaults, with each Mac as a host. Null when none does. */
export function readEarlierTart(values: Readonly<Record<string, unknown>>): EarlierBackend | null {
  let any = false;
  const fields: Record<string, FieldValue> = {};
  const secrets: Record<string, string> = {};
  for (const [key, setting] of Object.entries(TART_SETTINGS)) {
    const value = values[key];
    if (value === undefined || value === null || ("default" in setting && value === setting.default)) continue;
    if (isSecret(setting) && value === "") continue;
    any = true;
    const name = key.slice(TART_PREFIX.length);
    if (!(name in TART_FIELDS)) continue;
    if (isSecret(setting)) secrets[name] = String(value);
    else fields[name] = value as FieldValue;
  }
  if (!any) return null;
  // The Macs as they were. A mistake made Tart misconfigured before. A line in the wrong form gives no
  // Mac, so it is left out; any other mistake moves with its Mac, for the checks to name. Both are noted.
  const { hosts, problems, skipped } = parseHosts(text(values, TART_KEYS.hosts));
  const keys = text(values, TART_KEYS.hostKeys)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  // Each Mac gets the lines that name it, and every Mac the lines that name none, as all Macs had them before.
  const named = hosts.map((host) => hostKeysFor(keys, { host: host.address, port: host.port }));
  const unnamed = keys.filter((line) => !named.some((lines) => lines.includes(line)));
  return {
    enabled: values[TART_KEYS.enabled] === true,
    fields,
    secrets,
    warm: {},
    notes: [
      ...skipped.map((line) => `Tart: Mac line "${line}" is not a name, a space and user@address, so the Mac was left out; add it on the settings page.`),
      ...problems.filter((problem) => !skipped.some((line) => problem.includes(`"${line}"`))).map((problem) => `${problem} Fix it on the settings page.`),
    ],
    hosts: hosts.map((host, n) => ({
      name: host.name,
      enabled: true,
      fields: {
        address: host.port === 22 ? host.address : `${host.address.includes(":") ? `[${host.address}]` : host.address}:${host.port}`,
        user: host.user,
        "host-keys": [...new Set([...named[n]!, ...unnamed])].join("\n"),
      },
    })),
  };
}
