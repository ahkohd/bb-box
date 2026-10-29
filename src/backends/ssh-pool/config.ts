// Settings of the SSH host pool backend, parsed into a typed config. Every
// key starts with "ssh-pool-". The pool is a list of machines, one per line:
//
//   <name> [user@]host[:port] <kind>[,<kind>] [via=[user@]host[:port]] [reset=home|machine] [labels=<word>[,<word>]]
//
// for example
//
//   build-1 bbbox-admin@192.0.2.21 linux
//   build-2 192.0.2.22:2222 linux via=jump@bastion.example.com reset=machine labels=fast
//   mac-mini bbbox-admin@192.0.2.30 macos,macos-desktop
//
// The user is bb-box's admin user on the machine, bbbox-admin by default,
// which setup/ssh-pool/setup.sh makes. "via" is a jump host, reached with the
// same key. "reset=machine" says the machine has a whole-machine reset, so
// its boxes have Docker, which gives root (041). The pool's linux boxes have
// Docker only when every machine does. linux-docker, an alias of linux with
// Docker, may still be listed on such a line. A Mac, set up with
// setup-mac.sh, serves macos, macos-desktop or both, and has no whole-machine
// reset (047). setup.sh and setup-mac.sh print each machine's line and its
// host keys.

import type { PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { kindRequest } from "../kinds.ts";
import { MOST_SLOTS } from "../../core/slot-sizing.ts";
import { normalisePrivateKey } from "../../transports/ssh.ts";
import { fieldLabel, isSecret, type BackendPart, type EarlierBackend, type FieldDescriptor, type FieldProblem, type FieldValue, type ParsedBackend, type ParsedSettings } from "../types.ts";

export const SSH_POOL_KINDS = ["linux", "macos", "macos-desktop", "ios"] as const;
export type SshPoolKind = (typeof SSH_POOL_KINDS)[number];
export const SLOT_KIND = "ios";

export const SSH_POOL_DEFAULTS = { adminUser: "bbbox-admin", port: 22 } as const;

export const SSH_POOL_KEYS = {
  enabled: "ssh-pool-enabled",
  machines: "ssh-pool-machines",
  knownHosts: "ssh-pool-known-hosts",
  sshPrivateKey: "ssh-pool-ssh-private-key",
  iosHostsMost: "ssh-pool-ios-hosts-most",
  iosHostsAhead: "ssh-pool-ios-hosts-ahead",
  iosHostsResettingMost: "ssh-pool-ios-hosts-resetting-most",
  iosHostsDiskReserveGiB: "ssh-pool-ios-hosts-disk-reserve-gib",
} as const;

export interface PoolSlotsConfig {
  readonly most: number;
  readonly ahead: number;
  readonly resettingMost: number;
  readonly diskReserveGiB: number;
  readonly mostSet?: number;
}

export const POOL_SLOTS_DEFAULTS: PoolSlotsConfig = { most: 12, ahead: 1, resettingMost: 4, diskReserveGiB: 40 };

export interface SshPoolHost {
  readonly host: string;
  readonly port: number;
  readonly user: string;
}

export interface SshPoolMachine {
  /** Unique in the pool. Stored with each box as its reference. */
  readonly name: string;
  /** bb-box's admin user on the machine. */
  readonly admin: SshPoolHost;
  readonly jump: SshPoolHost | null;
  readonly kinds: readonly SshPoolKind[];
  /** A Mac serves only macOS kinds, and a Linux machine only linux. */
  readonly os: "linux" | "macos";
  /** It has a whole-machine reset, so its boxes may have Docker, and root through it (041). */
  readonly docker: boolean;
  /** "machine" when the operator's reset-machine restores the whole machine. */
  readonly reset: "home" | "machine";
  readonly labels: readonly string[];
  readonly slotsMost?: number;
}

export interface SshPoolConfig {
  readonly machines: readonly SshPoolMachine[];
  /** known_hosts lines for every machine and jump host. */
  readonly knownHosts: readonly string[];
  /** A null key means bb-box generates one and shows its public key. */
  readonly privateKey: string | null;
  readonly slots: PoolSlotsConfig;
}

export const SSH_POOL_SETTINGS: Record<string, PluginSettingDescriptor> = {
  [SSH_POOL_KEYS.enabled]: {
    type: "boolean",
    label: "SSH host pool: enabled",
    description: "Lend Linux machines and Macs you already have, reached over SSH. Each box has a machine to itself, which is reset when the box is released.",
    default: false,
  },
  [SSH_POOL_KEYS.machines]: {
    type: "string",
    label: "SSH host pool: machines",
    description:
      'Your machines, one line each, with the kinds of box each serves. A line is a name, [user@]host[:port], its kinds, and optionally via=<jump host>, reset=machine and labels=<words>, such as "build-1 192.0.2.21 linux" or "mac-mini 192.0.2.30 macos,macos-desktop". setup/ssh-pool/setup.sh, or setup-mac.sh on a Mac, prints the line for each machine. The kind ios on a Mac lends iOS slots there, each a macOS user with its own device, for iOS boxes asked for with shared: true; ios:<slots> sets how many, where bb-box would estimate them from the Mac.',
    experimental_multiline: true,
    default: "",
  },
  [SSH_POOL_KEYS.knownHosts]: {
    type: "string",
    label: "SSH host pool: host keys",
    description: "The SSH host keys of every machine and jump host. bb-box connects only to a machine whose key is here. Paste the known_hosts lines setup.sh and setup-mac.sh print.",
    experimental_multiline: true,
    default: "",
  },
  [SSH_POOL_KEYS.sshPrivateKey]: {
    type: "string",
    label: "SSH host pool: SSH private key",
    description:
      "The SSH key bb-box logs in to the machines with. Paste an unencrypted OpenSSH private key that their admin user accepts. Leave it empty and bb-box makes one and shows its public key, which you then give setup.sh.",
    secret: true,
  },
  [SSH_POOL_KEYS.iosHostsMost]: {
    type: "number",
    label: "SSH host pool: slots for iOS boxes per Mac",
    description:
      "The most iOS slots each Mac has at once, making, ready or held. This counts only Macs whose line lists ios, and a Mac is lent whole only while it lends no slot. Empty, bb-box estimates it for each Mac: the fewest of its cores over 1.3, its memory over 1.5 GiB after 8 GiB for the Mac, and what its video encoder allows. ios:<slots> on a Mac's line wins.",
  },
  [SSH_POOL_KEYS.iosHostsAhead]: {
    type: "number",
    label: "SSH host pool: ready slots for iOS boxes kept on a Mac",
    description: "Slots each Mac keeps ready, so the next iOS box is ready in seconds. This counts only Macs whose line lists ios, while they are not lent whole.",
    default: POOL_SLOTS_DEFAULTS.ahead,
  },
  [SSH_POOL_KEYS.iosHostsResettingMost]: {
    type: "number",
    label: "SSH host pool: slots a Mac resets at once",
    description: "The most released iOS slots a Mac resets in one pass, sweeping their files.",
    default: POOL_SLOTS_DEFAULTS.resettingMost,
  },
  [SSH_POOL_KEYS.iosHostsDiskReserveGiB]: {
    type: "number",
    label: "SSH host pool: disk a Mac keeps free (GiB)",
    description: "A Mac makes no new iOS slot while it has less free disk than this.",
    default: POOL_SLOTS_DEFAULTS.diskReserveGiB,
  },
};

function text(values: Readonly<Record<string, unknown>>, key: string): string {
  const value = values[key];
  return typeof value === "string" ? value.trim() : "";
}

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const USER = /^[a-z_][a-z0-9_.-]{0,31}$/i;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;
const IPV6 = /^[0-9a-f:.]+(?:%[a-z0-9]+)?$/i;
const LABEL = /^[a-z0-9][a-z0-9_.-]{0,62}$/i;

/** `[user@]host[:port]`, with an IPv6 address in brackets, or null. */
export function parseTarget(value: string, defaultUser: string): SshPoolHost | null {
  const at = value.lastIndexOf("@");
  const user = at >= 0 ? value.slice(0, at) : defaultUser;
  const rest = at >= 0 ? value.slice(at + 1) : value;
  let host: string;
  let portText: string | null = null;
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close < 0) return null;
    host = rest.slice(1, close);
    const after = rest.slice(close + 1);
    if (after && !after.startsWith(":")) return null;
    portText = after ? after.slice(1) : null;
    if (!IPV6.test(host) || !host.includes(":")) return null;
  } else {
    const colon = rest.lastIndexOf(":");
    if (colon >= 0) {
      if (rest.indexOf(":") !== colon) return null;
      host = rest.slice(0, colon);
      portText = rest.slice(colon + 1);
    } else host = rest;
    if (!HOSTNAME.test(host)) return null;
  }
  const port = portText === null ? SSH_POOL_DEFAULTS.port : Number(portText);
  if (!USER.test(user) || !/^\d+$/.test(portText ?? "22") || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port, user };
}

/** How known_hosts names a host: "host", or "[host]:port" off port 22. */
export function knownHostsName(host: { readonly host: string; readonly port: number }): string {
  return host.port === 22 ? host.host : `[${host.host}]:${host.port}`;
}

/** The names a known_hosts line is for, or null for a hashed or wildcard line, which may be for any host. */
function lineNames(line: string): string[] | null {
  const fields = line.trim().split(/\s+/);
  const names = fields[0]?.startsWith("@") ? fields[1] : fields[0];
  if (!names || names.startsWith("|") || /[*?!]/.test(names)) return null;
  return names.split(",");
}

/** The known_hosts lines for `host`, or all of them when some cannot be matched by name. */
export function hostKeysFor(lines: readonly string[], host: { readonly host: string; readonly port: number }): string[] {
  const name = knownHostsName(host);
  const named = lines.filter((line) => lineNames(line)?.includes(name));
  return named.length ? named : lines.some((line) => lineNames(line) === null) ? [...lines] : [];
}

export const EXAMPLE = '"build-1 bbbox-admin@192.0.2.21 linux"';

function parseMachine(line: string, problems: { push(message: string): void }): SshPoolMachine | null {
  const [name = "", target = "", kindList = "", ...options] = line.split(/\s+/);
  const bad = (why: string) => {
    problems.push(`${why} In the machines list, "${line}" should be like ${EXAMPLE}.`);
    return null;
  };
  if (!NAME.test(name)) return bad(`Name each machine with lower-case letters, digits and "-".`);
  const admin = parseTarget(target, SSH_POOL_DEFAULTS.adminUser);
  if (!admin) return bad(`Give machine ${name} an address as [user@]host[:port].`);
  if (!kindList) return bad(`Give machine ${name} the kinds it serves.`);
  const kinds: SshPoolKind[] = [];
  let listsDocker = false;
  let slotsMost: number | undefined;
  for (const listed of kindList.split(",")) {
    const slots = /^ios:(.*)$/.exec(listed);
    if (slots) {
      const most = Number(slots[1]);
      if (!/^\d+$/.test(slots[1]!) || most < 1 || most > MOST_SLOTS) return bad(`Give machine ${name}'s iOS slots as ios:<slots>, a whole number from 1 to ${MOST_SLOTS}, or ios for bb-box's estimate.`);
      slotsMost = most;
    }
    const word = slots ? "ios" : listed;
    const asked = kindRequest(word);
    const kind = SSH_POOL_KINDS.includes(asked.kind as SshPoolKind) ? (asked.kind as SshPoolKind) : null;
    if (!kind || asked.features.some((feature) => feature !== "docker")) {
      return bad(`Machine ${name} cannot serve kind "${word}": the SSH host pool offers linux, with Docker on a machine with reset=machine, and macos, macos-desktop and ios slots on a Mac.`);
    }
    if (!kinds.includes(kind)) kinds.push(kind);
    if (asked.features.includes("docker")) listsDocker = true;
  }
  let jump: SshPoolHost | null = null;
  let reset: "home" | "machine" = "home";
  const labels: string[] = [];
  for (const option of options) {
    const [key, value = ""] = option.split(/=(.*)/s);
    if (key === "via") {
      jump = parseTarget(value, admin.user);
      if (!jump) return bad(`Give machine ${name}'s jump host as via=[user@]host[:port].`);
    } else if (key === "reset") {
      if (value !== "home" && value !== "machine") return bad(`Use reset=home or reset=machine for machine ${name}.`);
      reset = value;
    } else if (key === "labels" || key === "label") {
      for (const label of value.split(",")) {
        if (!LABEL.test(label)) return bad(`Use letters, digits, ".", "_" and "-" in machine ${name}'s labels.`);
        if (!labels.includes(label)) labels.push(label);
      }
    } else return bad(`Machine ${name} has an unknown option "${option}".`);
  }
  const os = kinds[0] === "linux" ? "linux" : "macos";
  if (kinds.some((kind) => (kind === "linux" ? "linux" : "macos") !== os)) {
    return bad(`Machine ${name} lists Linux and macOS kinds. List linux on a Linux machine, and macos, macos-desktop or ios on a Mac.`);
  }
  if (os === "macos" && reset === "machine") {
    problems.push(`Machine ${name} is a Mac, which has no whole-machine reset. Remove reset=machine: its reset removes the box's user and makes a new one.`);
    return null;
  }
  if (listsDocker && reset !== "machine") {
    problems.push(
      `Machine ${name} serves linux-docker, which needs reset=machine: Docker gives the box root, so only a whole-machine reset makes the machine clean. Remove linux-docker, or set up reset-machine as the setup guide says and add reset=machine, which gives its boxes Docker.`,
    );
    return null;
  }
  return { name, admin, jump, kinds, os, docker: reset === "machine", reset, labels, ...(slotsMost !== undefined ? { slotsMost } : {}) };
}

export const SSH_POOL_PREFIX = "ssh-pool-";

/** The backend's fields in bb-box's configuration (029): the settings above without the prefix. */
export const SSH_POOL_FIELDS: Readonly<Record<string, FieldDescriptor>> = Object.fromEntries(
  ([
    [SSH_POOL_KEYS.machines, "boxes"],
    [SSH_POOL_KEYS.knownHosts, "connection"],
    [SSH_POOL_KEYS.sshPrivateKey, "credentials"],
    [SSH_POOL_KEYS.iosHostsMost, "ios-hosts"],
    [SSH_POOL_KEYS.iosHostsAhead, "ios-hosts"],
    [SSH_POOL_KEYS.iosHostsResettingMost, "ios-hosts"],
    [SSH_POOL_KEYS.iosHostsDiskReserveGiB, "ios-hosts"],
  ] as const).map(([key, group]) => {
    const setting = SSH_POOL_SETTINGS[key]!;
    return [key.slice(SSH_POOL_PREFIX.length), { ...setting, label: fieldLabel(setting.label), group } as FieldDescriptor];
  }),
);

/** Flat settings, as the tests give them. A problem names no field. */
export function parseSshPoolSettings(values: Readonly<Record<string, unknown>>): ParsedSettings<SshPoolConfig> {
  if (values[SSH_POOL_KEYS.enabled] !== true) return { enabled: false };
  const { config, problems } = checkSshPool(values);
  if (problems.length) return { enabled: true, ok: false, problems: problems.map((problem) => problem.message) };
  return { enabled: true, ok: true, config: config! };
}

/** The SSH host pool's part of bb-box's configuration (029), with each problem at its field. */
export function parseSshPoolPart(part: BackendPart): ParsedBackend<SshPoolConfig> {
  const values: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(part.fields)) values[SSH_POOL_PREFIX + field] = value;
  const { config, problems } = checkSshPool(values);
  return problems.length ? { ok: false, problems } : { ok: true, config: config! };
}

/** The backend's settings from before 029 that differ from their defaults, or null when none does. */
export function readEarlierSshPool(values: Readonly<Record<string, unknown>>): EarlierBackend | null {
  let any = false;
  const fields: Record<string, FieldValue> = {};
  const secrets: Record<string, string> = {};
  for (const [key, setting] of Object.entries(SSH_POOL_SETTINGS)) {
    const value = values[key];
    if (value === undefined || value === null || ("default" in setting && value === setting.default)) continue;
    if (isSecret(setting) && value === "") continue;
    any = true;
    const name = key.slice(SSH_POOL_PREFIX.length);
    if (!(name in SSH_POOL_FIELDS)) continue;
    if (isSecret(setting)) secrets[name] = String(value);
    else fields[name] = value as FieldValue;
  }
  return any ? { enabled: values[SSH_POOL_KEYS.enabled] === true, fields, secrets, warm: {} } : null;
}

function checkSshPool(values: Readonly<Record<string, unknown>>): { config: SshPoolConfig | null; problems: FieldProblem[] } {
  const all: FieldProblem[] = [];
  const at = (key: string) => ({ push: (message: string) => all.push({ path: key.slice(SSH_POOL_PREFIX.length), message }) });
  const problems = at(SSH_POOL_KEYS.machines);

  const machines: SshPoolMachine[] = [];
  for (const raw of text(values, SSH_POOL_KEYS.machines).split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const machine = parseMachine(line, problems);
    if (!machine) continue;
    if (machines.some((other) => other.name === machine.name)) problems.push(`Machine ${machine.name} is listed twice. Give each machine its own name.`);
    else if (machines.some((other) => other.admin.host === machine.admin.host && other.admin.port === machine.admin.port)) {
      problems.push(`Machines ${machines.find((other) => other.admin.host === machine.admin.host)!.name} and ${machine.name} have the same address. List each machine once.`);
    } else machines.push(machine);
  }
  // A pool with no machines yet is valid, so its doctor can show the public key that setup.sh needs first.

  const knownHosts = text(values, SSH_POOL_KEYS.knownHosts)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const keys = at(SSH_POOL_KEYS.knownHosts);
  for (const line of knownHosts) {
    const fields = line.split(/\s+/);
    if (fields.length < (fields[0]!.startsWith("@") ? 4 : 3)) keys.push(`Use whole known_hosts lines for the host keys, like setup.sh prints. "${line.slice(0, 40)}" is not one.`);
  }
  for (const machine of machines) {
    for (const [what, host] of [["machine", machine.admin], ["jump host", machine.jump]] as const) {
      if (host && !hostKeysFor(knownHosts, host).length) {
        keys.push(`Add the host key of ${what === "machine" ? `machine ${machine.name}` : `machine ${machine.name}'s jump host`}, ${knownHostsName(host)}, to the host keys. setup.sh prints it, or run ssh-keyscan on a network you trust.`);
      }
    }
  }

  const keyText = text(values, SSH_POOL_KEYS.sshPrivateKey);
  const privateKey = keyText ? normalisePrivateKey(keyText) : null;
  if (keyText && !privateKey) at(SSH_POOL_KEYS.sshPrivateKey).push("Paste the whole SSH private key in OpenSSH form, or clear it so bb-box makes one.");

  const slots = checkSlots(values, (key, message) => at(key).push(message));

  if (all.length) return { config: null, problems: all };
  return { config: { machines, knownHosts, privateKey, slots }, problems: all };
}

function wholeSetting(values: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const value = values[key];
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return fallback;
}

function checkSlots(values: Readonly<Record<string, unknown>>, problem: (key: string, message: string) => void): PoolSlotsConfig {
  const read = (key: string, fallback: number, least: number, most: number, words: string): number => {
    const value = wholeSetting(values, key, fallback);
    if (!Number.isInteger(value) || value < least || value > most) problem(key, `SSH host pool: ${words} must be a whole number from ${least} to ${most}.`);
    return value;
  };
  const most = read(SSH_POOL_KEYS.iosHostsMost, POOL_SLOTS_DEFAULTS.most, 1, MOST_SLOTS, "the iOS slots per Mac");
  const mostSet = values[SSH_POOL_KEYS.iosHostsMost] !== undefined && values[SSH_POOL_KEYS.iosHostsMost] !== null && values[SSH_POOL_KEYS.iosHostsMost] !== "";
  return {
    most,
    ...(mostSet ? { mostSet: most } : {}),
    ahead: read(SSH_POOL_KEYS.iosHostsAhead, POOL_SLOTS_DEFAULTS.ahead, 0, MOST_SLOTS, "the ready iOS slots kept on a Mac"),
    resettingMost: read(SSH_POOL_KEYS.iosHostsResettingMost, POOL_SLOTS_DEFAULTS.resettingMost, 1, 64, "the iOS slots a Mac sweeps at once"),
    diskReserveGiB: read(SSH_POOL_KEYS.iosHostsDiskReserveGiB, POOL_SLOTS_DEFAULTS.diskReserveGiB, 0, 4096, "the disk a Mac keeps free of iOS slots"),
  };
}
