// The Proxmox QEMU backend's fields in bb-box's configuration (029), parsed
// into a typed config. The settings page and the tests go through
// parseQemuPart.
//
// Boxes are Windows desktops, linked clones of a QEMU template that
// setup/proxmox-qemu/build.sh makes. The template uses the same host set-up as
// the Proxmox LXC backend: its bridge, pool and SSH key. So the connection and
// the SSH key, left empty, take Proxmox LXC's (QEMU_INHERITS). Each VMID in
// the owned range has a fixed address, as for Proxmox LXC, so the defaults
// give this backend its own VMIDs and addresses on the same bridge and subnet.

import {
  checkConnection,
  checkNetwork,
  checkReserve,
  checkSsh,
  checkVmids,
  text,
  wholeInRange,
  type Problem,
  type ProxmoxConnection,
  type ProxmoxNetwork,
  type VmidRange,
} from "../proxmox/settings.ts";
import type { BackendDriver, BackendPart, FieldDescriptor, FieldProblem, ParsedBackend } from "../types.ts";

export const QEMU_KINDS = ["windows-desktop"] as const;

export interface QemuConfig {
  readonly proxmox: ProxmoxConnection;
  /** VMIDs of the Windows templates, in the order the settings list them. */
  readonly templates: readonly number[];
  readonly vmids: VmidRange;
  readonly network: ProxmoxNetwork;
  /** A null key means bb-box generates one and shows its public key. */
  readonly ssh: { readonly privateKey: string | null; readonly user: string };
  readonly reserve: { readonly memoryMiB: number; readonly diskGiB: number };
}

export const QEMU_DEFAULTS = {
  pool: "bbbox",
  windowsTemplate: 9104,
  vmidFirst: 9700,
  vmidLast: 9799,
  bridge: "vmbr200",
  subnet: "10.200.0.0/24",
  gateway: "10.200.0.1",
  addresses: "10.200.0.150-10.200.0.254",
  sshUser: "box",
  reserveMemoryMiB: 4096,
  reserveDiskGiB: 50,
} as const;

/** Field keys in bb-box's configuration (029). The backend had no BB settings before it. */
export const QEMU_KEYS = {
  url: "url",
  tokenId: "token-id",
  tokenSecret: "token-secret",
  tlsFingerprint: "tls-fingerprint",
  caCertificate: "ca-certificate",
  node: "node",
  pool: "pool",
  templates: "windows-templates",
  vmidFirst: "vmid-first",
  vmidLast: "vmid-last",
  bridge: "bridge",
  subnet: "subnet",
  gateway: "gateway",
  addresses: "addresses",
  sshPrivateKey: "ssh-private-key",
  sshUser: "ssh-user",
  reserveMemoryMiB: "reserve-memory-mib",
  reserveDiskGiB: "reserve-disk-gib",
} as const;

export const QEMU_FIELDS: Readonly<Record<string, FieldDescriptor>> = {
  [QEMU_KEYS.url]: {
    type: "string",
    label: "API URL",
    description:
      "For example https://192.0.2.10:8006/api2/json, as the Proxmox LXC setup guide's token file gives it. Leave it, the token, the fingerprint and the CA certificate empty to use Proxmox LXC's.",
    group: "connection",
    default: "",
  },
  [QEMU_KEYS.node]: {
    type: "string",
    label: "Node",
    description: "The node boxes run on. Leave empty on a single-node host.",
    group: "connection",
    default: "",
  },
  [QEMU_KEYS.tlsFingerprint]: {
    type: "string",
    label: "TLS fingerprint",
    description:
      "The SHA-256 fingerprint of the Proxmox API's certificate, from the setup guide's token file. bb-box then trusts that certificate alone. Leave empty to check the certificate against its CA.",
    group: "connection",
    default: "",
  },
  [QEMU_KEYS.caCertificate]: {
    type: "string",
    label: "CA certificate",
    description: "PEM certificate of the CA that signed the Proxmox API's certificate, when there is no TLS fingerprint. Leave empty for a publicly trusted one.",
    experimental_multiline: true,
    group: "connection",
    default: "",
  },
  [QEMU_KEYS.tokenId]: {
    type: "string",
    label: "API token ID",
    description: "For example bbbox@pve!plugin. The setup guide lists the privileges it needs.",
    group: "credentials",
    default: "",
  },
  [QEMU_KEYS.tokenSecret]: { type: "string", label: "API token secret", description: "The secret of the API token, from the setup guide's token file.", secret: true, group: "credentials" },
  [QEMU_KEYS.sshPrivateKey]: {
    type: "string",
    label: "SSH private key",
    description:
      "Paste BBBOX_SSH_KEY, the private key build.sh put in the template, or leave it empty to use Proxmox LXC's. With neither, bb-box makes a key, which the template does not accept until you add its public key.",
    secret: true,
    group: "credentials",
  },
  [QEMU_KEYS.pool]: {
    type: "string",
    label: "Resource pool",
    description: "Boxes are made in this pool. The token needs rights on it.",
    group: "boxes",
    default: QEMU_DEFAULTS.pool,
  },
  [QEMU_KEYS.templates]: {
    type: "string",
    label: "Windows templates",
    description:
      "VMIDs of the Windows templates windows-desktop boxes are linked clones of, separated by spaces or commas. setup/proxmox-qemu/build.sh builds one. A new box is cloned from the least used.",
    group: "boxes",
    default: String(QEMU_DEFAULTS.windowsTemplate),
  },
  [QEMU_KEYS.bridge]: {
    type: "string",
    label: "Network bridge",
    description: "The bridge boxes attach to.",
    group: "advanced",
    default: QEMU_DEFAULTS.bridge,
  },
  [QEMU_KEYS.subnet]: {
    type: "string",
    label: "Subnet",
    description: "The bridge's subnet in CIDR form. Boxes get static addresses; there is no DHCP.",
    group: "advanced",
    default: QEMU_DEFAULTS.subnet,
  },
  [QEMU_KEYS.gateway]: {
    type: "string",
    label: "Gateway",
    description: "The host's address on the bridge.",
    group: "advanced",
    default: QEMU_DEFAULTS.gateway,
  },
  [QEMU_KEYS.addresses]: {
    type: "string",
    label: "Box addresses",
    description:
      "The range bb-box hands out. The n-th VMID gets the n-th address. Keep it apart from the Proxmox LXC backend's. Leave empty to use the whole subnet except the gateway.",
    group: "advanced",
    default: QEMU_DEFAULTS.addresses,
  },
  [QEMU_KEYS.vmidFirst]: {
    type: "number",
    label: "First box VMID",
    description: "Boxes take VMIDs from this range. Keep other guests out of it, the Proxmox LXC backend's too.",
    group: "advanced",
    default: QEMU_DEFAULTS.vmidFirst,
  },
  [QEMU_KEYS.vmidLast]: { type: "number", label: "Last box VMID", description: "The end of the range boxes take VMIDs from.", group: "advanced", default: QEMU_DEFAULTS.vmidLast },
  [QEMU_KEYS.sshUser]: {
    type: "string",
    label: "SSH user",
    description: "The user in the template that bb-box and BB work as.",
    group: "advanced",
    default: QEMU_DEFAULTS.sshUser,
  },
  [QEMU_KEYS.reserveMemoryMiB]: {
    type: "number",
    label: "Memory kept free (MiB)",
    description: "A new box is refused if the node would have less memory than this left.",
    group: "advanced",
    default: QEMU_DEFAULTS.reserveMemoryMiB,
  },
  [QEMU_KEYS.reserveDiskGiB]: {
    type: "number",
    label: "Disk kept free (GiB)",
    description: "A new box is refused if the template's storage has less free space than this.",
    group: "advanced",
    default: QEMU_DEFAULTS.reserveDiskGiB,
  },
};

/**
 * Fields that, left empty, take Proxmox LXC's values: a host with Linux boxes
 * already has the connection and key that Windows boxes need. The connection
 * goes together, so a URL set here never meets Proxmox LXC's token or
 * certificate.
 */
export const QEMU_INHERITS: NonNullable<BackendDriver["inherits"]> = {
  from: "proxmox-lxc",
  sets: [[QEMU_KEYS.url, QEMU_KEYS.tokenId, QEMU_KEYS.tokenSecret, QEMU_KEYS.tlsFingerprint, QEMU_KEYS.caCertificate], [QEMU_KEYS.sshPrivateKey]],
};

/** The template list: VMIDs separated by spaces or commas. A settings file may give a lone VMID as a number. */
function templateList(values: Readonly<Record<string, unknown>>, problem: Problem): number[] {
  const raw = values[QEMU_KEYS.templates];
  const listed = typeof raw === "number" ? (raw > 0 ? String(raw) : "") : text(values, QEMU_KEYS.templates, String(QEMU_DEFAULTS.windowsTemplate));
  const templates: number[] = [];
  for (const entry of listed.split(/[\s,]+/).filter(Boolean)) {
    const vmid = Number(entry);
    if (!wholeInRange(vmid, 100, 999_999_999)) problem(QEMU_KEYS.templates, `Use VMIDs from 100 for the Windows templates. "${entry}" is not one.`);
    else if (templates.includes(vmid)) problem(QEMU_KEYS.templates, `Template ${vmid} is listed more than once. List each template once.`);
    else templates.push(vmid);
  }
  if (!listed.trim()) problem(QEMU_KEYS.templates, "Set the VMID of at least one Windows template.");
  return templates;
}

/** Proxmox QEMU's part of bb-box's configuration (029), with each problem at its field. */
export function parseQemuPart(part: BackendPart): ParsedBackend<QemuConfig> {
  const values = part.fields;
  const problems: FieldProblem[] = [];
  const problem: Problem = (path, message) => problems.push({ path, message });

  const proxmox = checkConnection(values, QEMU_KEYS, QEMU_DEFAULTS, problem);
  const templates = templateList(values, problem);
  const vmids = checkVmids(values, QEMU_KEYS, QEMU_DEFAULTS, templates, problem);
  const network = checkNetwork(values, QEMU_KEYS, QEMU_DEFAULTS, vmids, problem);
  const ssh = checkSsh(values, QEMU_KEYS, QEMU_DEFAULTS, problem);
  const reserve = checkReserve(values, QEMU_KEYS, QEMU_DEFAULTS, problem);

  if (problems.length) return { ok: false, problems };
  return { ok: true, config: { proxmox, templates, vmids, network, ssh, reserve } };
}
