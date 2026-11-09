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
import { PRODUCT } from "../../brand.ts";

export const QEMU_KINDS = ["windows-desktop", "linux", "linux-desktop-cpu", "android"] as const;

export interface QemuConfig {
  readonly proxmox: ProxmoxConnection;
  /** VMIDs of the Windows templates, in the order the settings list them. */
  readonly templates: readonly number[];
  /** VMIDs of the Linux templates, for linux boxes as VMs (057). None by default. */
  readonly linuxTemplates: readonly number[];
  /** VMIDs of the Linux desktop templates, for linux-desktop-cpu boxes as VMs (057). None by default. */
  readonly linuxDesktopTemplates: readonly number[];
  readonly androidTemplates: readonly number[];
  readonly vmids: VmidRange;
  readonly network: ProxmoxNetwork;
  /** A null key means bb-box generates one and shows its public key. */
  readonly ssh: { readonly privateKey: string | null; readonly user: string };
  readonly reserve: { readonly memoryMiB: number; readonly diskGiB: number };
  /** Windows boxes join BB as machines, unless set off (#539). */
  readonly enrol: boolean;
  /** Linux VM boxes have KVM, where the host allows nested virtualization (057). Off by default. */
  readonly kvm: boolean;
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
  linuxTemplates: "linux-templates",
  linuxDesktopTemplates: "linux-desktop-templates",
  androidTemplates: "android-templates",
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
  enrol: "windows-enrol",
  kvm: "linux-kvm",
} as const;

export const QEMU_FIELDS: Readonly<Record<string, FieldDescriptor>> = {
  [QEMU_KEYS.url]: {
    type: "string",
    label: "API URL",
    description:
      "The Proxmox API's address, from the Proxmox LXC setup guide's token file. For example https://192.0.2.10:8006/api2/json. Leave it, the token, the fingerprint and the CA certificate empty to use Proxmox LXC's.",
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
      `Pins the Proxmox API's certificate, so ${PRODUCT} trusts that certificate alone. Paste its SHA-256 fingerprint from the setup guide's token file. Leave it empty to check the certificate against its CA instead.`,
    group: "connection",
    default: "",
  },
  [QEMU_KEYS.caCertificate]: {
    type: "string",
    label: "CA certificate",
    description: "The CA that signed the Proxmox API's certificate, for when there is no TLS fingerprint. Paste it as a PEM certificate. Leave it empty when the API's certificate is publicly trusted.",
    experimental_multiline: true,
    group: "connection",
    default: "",
  },
  [QEMU_KEYS.tokenId]: {
    type: "string",
    label: "API token ID",
    description: `The Proxmox API token ${PRODUCT} signs in with, such as bbbox@pve!plugin. The setup guide lists the privileges it needs.`,
    group: "credentials",
    default: "",
  },
  [QEMU_KEYS.tokenSecret]: { type: "string", label: "API token secret", description: "The secret of the API token, from the setup guide's token file.", secret: true, group: "credentials" },
  [QEMU_KEYS.sshPrivateKey]: {
    type: "string",
    label: "SSH private key",
    description:
      `The SSH key ${PRODUCT} reaches boxes with. Paste BBBOX_SSH_KEY, the private key build.sh put in the template, or leave it empty to use Proxmox LXC's. With neither, ${PRODUCT} makes a key, which the template does not accept until you add its public key.`,
    secret: true,
    group: "credentials",
  },
  [QEMU_KEYS.pool]: {
    type: "string",
    label: "Resource pool",
    description: "The Proxmox resource pool boxes are made in. The token needs rights on it.",
    group: "boxes",
    default: QEMU_DEFAULTS.pool,
  },
  [QEMU_KEYS.templates]: {
    type: "string",
    label: "Windows templates",
    description:
      "The templates Windows desktops are linked clones of. List their VMIDs, separated by spaces or commas; a new box is cloned from the least used. setup/proxmox-qemu/build.sh builds one. Empty offers no Windows desktops.",
    group: "boxes",
    default: String(QEMU_DEFAULTS.windowsTemplate),
  },
  [QEMU_KEYS.linuxTemplates]: {
    type: "string",
    label: "Linux templates",
    description:
      "The templates Linux boxes as VMs are linked clones of, for a box with its own kernel. List their VMIDs, separated by spaces or commas. setup/proxmox-qemu/build.sh linux builds one. Empty offers no Linux VMs.",
    group: "boxes",
    default: "",
  },
  [QEMU_KEYS.linuxDesktopTemplates]: {
    type: "string",
    label: "Linux desktop templates",
    description:
      "The templates Linux desktops as VMs are linked clones of, for a desktop with its own kernel. They are drawn by the CPU. List their VMIDs, separated by spaces or commas. setup/proxmox-qemu/build.sh linux-desktop builds one. Empty offers no Linux desktop VMs.",
    group: "boxes",
    default: "",
  },
  [QEMU_KEYS.androidTemplates]: {
    type: "string",
    label: "Android templates",
    description:
      `The templates Android emulator boxes are linked clones of. Each is the Linux template with the Android SDK, the emulator and a booted device for each model. List their VMIDs, separated by spaces or commas. setup/proxmox-qemu/build.sh android builds one, on a host with nested virtualization, and the nightly job refreshes it monthly. ${PRODUCT} offers Android boxes while KVM in Linux VM boxes is on and the template's record lists its devices.`,
    group: "boxes",
    default: "",
  },
  [QEMU_KEYS.enrol]: {
    type: "boolean",
    label: "Windows boxes as BB machines",
    description: "Windows boxes join BB as machines, so threads and terminals can use them. Linux and macOS boxes always do. Off, Windows boxes are boxes only.",
    group: "boxes",
    default: true,
  },
  [QEMU_KEYS.kvm]: {
    type: "boolean",
    label: "KVM in Linux VM boxes",
    description:
      "Lets Linux VM boxes run VMs of their own through /dev/kvm. A box asked for as linux-kvm gets one, and Android emulator boxes need it. Turn it on when the host allows nested virtualization: build.sh linux says whether /dev/kvm works in a clone.",
    group: "boxes",
    default: false,
  },
  [QEMU_KEYS.bridge]: {
    type: "string",
    label: "Network bridge",
    description: "The Proxmox network bridge boxes attach to.",
    group: "advanced",
    default: QEMU_DEFAULTS.bridge,
  },
  [QEMU_KEYS.subnet]: {
    type: "string",
    label: "Subnet",
    description: "The bridge's subnet, in CIDR form such as 10.200.0.0/24. Boxes get static addresses from it; there is no DHCP.",
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
      "The range of addresses boxes get, inside the subnet. The n-th VMID gets the n-th address. Keep it apart from Proxmox LXC's. Empty uses the whole subnet except the gateway.",
    group: "advanced",
    default: QEMU_DEFAULTS.addresses,
  },
  [QEMU_KEYS.vmidFirst]: {
    type: "number",
    label: "First box VMID",
    description: "The first VMID boxes take. Keep other guests out of the range, Proxmox LXC's boxes too.",
    group: "advanced",
    default: QEMU_DEFAULTS.vmidFirst,
  },
  [QEMU_KEYS.vmidLast]: { type: "number", label: "Last box VMID", description: "The last VMID boxes take.", group: "advanced", default: QEMU_DEFAULTS.vmidLast },
  [QEMU_KEYS.sshUser]: {
    type: "string",
    label: "SSH user",
    description: `The user in the template that ${PRODUCT} and BB work as.`,
    group: "advanced",
    default: QEMU_DEFAULTS.sshUser,
  },
  [QEMU_KEYS.reserveMemoryMiB]: {
    type: "number",
    label: "Memory kept free (MiB)",
    description: "Memory the node keeps for itself. A new box is refused if the node would have less than this left.",
    group: "advanced",
    default: QEMU_DEFAULTS.reserveMemoryMiB,
  },
  [QEMU_KEYS.reserveDiskGiB]: {
    type: "number",
    label: "Disk kept free (GiB)",
    description: "Disk the node keeps free. A new box is refused if the template's storage has less free space than this.",
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
function templateList(values: Readonly<Record<string, unknown>>, problem: Problem, key: string, what: string, fallback: string, taken: readonly number[] = []): number[] {
  const raw = values[key];
  const listed = typeof raw === "number" ? (raw > 0 ? String(raw) : "") : text(values, key, fallback);
  const templates: number[] = [];
  for (const entry of listed.split(/[\s,]+/).filter(Boolean)) {
    const vmid = Number(entry);
    if (!wholeInRange(vmid, 100, 999_999_999)) problem(key, `Use VMIDs from 100 for the ${what} templates. "${entry}" is not one.`);
    else if (templates.includes(vmid) || taken.includes(vmid)) problem(key, `Template ${vmid} is listed more than once. List each template once.`);
    else templates.push(vmid);
  }
  return templates;
}

/** Proxmox QEMU's part of bb-box's configuration (029), with each problem at its field. */
export function parseQemuPart(part: BackendPart): ParsedBackend<QemuConfig> {
  const values = part.fields;
  const problems: FieldProblem[] = [];
  const problem: Problem = (path, message) => problems.push({ path, message });

  const proxmox = checkConnection(values, QEMU_KEYS, QEMU_DEFAULTS, problem);
  const templates = templateList(values, problem, QEMU_KEYS.templates, "Windows", String(QEMU_DEFAULTS.windowsTemplate));
  const linuxTemplates = templateList(values, problem, QEMU_KEYS.linuxTemplates, "Linux", "", templates);
  const linuxDesktopTemplates = templateList(values, problem, QEMU_KEYS.linuxDesktopTemplates, "Linux desktop", "", [...templates, ...linuxTemplates]);
  const androidTemplates = templateList(values, problem, QEMU_KEYS.androidTemplates, "Android", "", [...templates, ...linuxTemplates, ...linuxDesktopTemplates]);
  if (!templates.length && !linuxTemplates.length && !linuxDesktopTemplates.length && !androidTemplates.length) problem(QEMU_KEYS.templates, "Set the VMID of at least one Windows, Linux or Android template.");
  const vmids = checkVmids(values, QEMU_KEYS, QEMU_DEFAULTS, [...templates, ...linuxTemplates, ...linuxDesktopTemplates, ...androidTemplates], problem);
  const network = checkNetwork(values, QEMU_KEYS, QEMU_DEFAULTS, vmids, problem);
  const ssh = checkSsh(values, QEMU_KEYS, QEMU_DEFAULTS, problem);
  const reserve = checkReserve(values, QEMU_KEYS, QEMU_DEFAULTS, problem);

  if (problems.length) return { ok: false, problems };
  return { ok: true, config: { proxmox, templates, linuxTemplates, linuxDesktopTemplates, androidTemplates, vmids, network, ssh, reserve, enrol: values[QEMU_KEYS.enrol] !== false, kvm: values[QEMU_KEYS.kvm] === true } };
}
