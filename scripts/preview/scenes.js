// The scenes the preview renders: fixtures for each slot and state.

export const THREAD = "thr_preview";
const DESKTOP_PATH = "/api/v1/plugins/bb-box/http/desktop";
const TERMINAL_PATH = "/api/v1/plugins/bb-box/http/terminal";
const now = Date.now();

function box(overrides = {}) {
  return {
    id: "box_1",
    name: "calm-otter",
    kind: "linux",
    kindLabel: "Linux",
    backendLabel: "Proxmox LXC on pve",
    nature: "virtual",
    form: "LXC",
    role: "box",
    state: "ready",
    error: null,
    createdAt: now - 12 * 60_000,
    readyAt: now - 12 * 60_000 + 2200,
    os: "linux",
    arch: "x86_64",
    gpu: false,
    requires: [],
    extras: ["docker"],
    docker: true,
    desktop: false,
    display: null,
    control: null,
    computerUse: false,
    terminal: true,
    address: "10.200.0.12",
    facts: [{ label: "Template", value: "9100" }],
    timings: { clone: 750, start: 1000, ssh: 450, total: 2200, enrol: 5300 },
    enrol: { state: "enrolled", hostId: "host_1", error: null },
    enrols: true,
    canStopStart: true,
    size: "2 cores, 4 GiB memory",
    ...overrides,
  };
}

const desktop = box({
  id: "box_2",
  name: "bold-heron",
  kind: "linux-desktop",
  kindLabel: "Linux desktop",
  desktop: true,
  gpu: true,
  display: { protocol: "rfb", resizable: true },
  control: { owner: "agent", holder: null },
  computerUse: true,
  address: "10.200.0.14",
  size: "4 cores, 8 GiB memory, 32 GiB disk",
  facts: [
    { label: "GPU", value: "GPU-0a1b2c3d" },
    { label: "Display mode", value: "gpu" },
    { label: "Template", value: "9101" },
  ],
});
const starting = box({ id: "box_3", name: "quiet-fern", state: "acquiring", createdAt: now - 1400, address: null, facts: [], timings: {}, enrol: { state: "off", hostId: null, error: null } });
const stopped = box({ id: "box_4", name: "wild-cove", kind: "linux", kindLabel: "Linux", backendLabel: "SSH host pool", nature: "real", form: "Physical", extras: [], docker: false, state: "stopped", size: "8 cores, 16 GiB memory, 64 GiB disk" });
const failed = box({
  id: "box_5",
  name: "brisk-elm",
  kind: "linux-desktop",
  kindLabel: "Linux desktop",
  desktop: true,
  gpu: true,
  state: "failed",
  error: "No GPU is left: GPU-0a1b has 3 desktops and GPU-7c2d fell back to the CPU. Try a linux-desktop-cpu box.",
  address: null,
  facts: [],
  timings: {},
  enrol: { state: "off", hostId: null, error: null },
});
const gone = box({ id: "box_6", name: "soft-reed", state: "gone", enrol: { state: "off", hostId: null, error: null } });
const refused = box({ id: "box_7", name: "quiet-fern", error: "Stopping the box failed: the host did not answer.", enrol: { state: "failed", hostId: null, error: "BB did not answer within 10 s." } });

function size(cores, memoryGiB, diskGiB = null) {
  return { cores, memoryGiB, diskGiB, words: `${cores} cores, ${memoryGiB} GiB memory${diskGiB === null ? "" : `, ${diskGiB} GiB disk`}` };
}

function kind(id, label, description, cores, desktop, gpu, spares = { target: 0, ready: 0, making: 0 }) {
  return {
    id,
    label,
    description,
    size: size(cores, cores * 2).words,
    presets: [
      { name: "small", ...size(cores, cores * 2) },
      { name: "medium", ...size(cores * 2, cores * 4) },
      { name: "large", ...size(cores * 4, cores * 8) },
    ],
    defaultPreset: "small",
    largest: size(cores * 8, cores * 16, 256),
    gpu,
    desktop,
    os: id.startsWith("macos") ? "macos" : "linux",
    arch: id.startsWith("macos") || id.includes("arm64") ? "arm64" : "x86_64",
    windowing: id.includes("wayland") ? "wayland" : "x11",
    features: [],
    docker: !id.startsWith("macos"),
    enrol: true,
    spares,
    backends: ["Proxmox LXC on pve"],
    forms: ["LXC"],
    offers: [offer("proxmox-lxc", "Proxmox LXC", ["pve"], "LXC", { ready: spares.ready, typicalReadyMs: desktop ? 3100 : 2200, resizable: desktop ? true : null, docker: !id.startsWith("macos") })],
    computerUse: desktop,
  };
}

/** One backend's offer of a kind, for the picker's pane. */
function offer(type, label, hosts, form, extra = {}) {
  const name = hosts.length === 1 ? `${label} on ${hosts[0]}` : hosts.length > 1 ? `${label} on ${hosts.length} ${type === "tart" ? "Macs" : "hosts"}` : label;
  return { backend: type, name, type, label, hosts, form, ready: 0, free: null, admin: true, resizable: null, typicalReadyMs: null, docker: true, hostOs: type === "tart" ? "macos" : "linux", ...extra };
}

export const KINDS = [
  // Linux keeps a spare, ready, so the chooser's Proxmox LXC row says "ready now"; three backends offer it, one without Docker (041).
  {
    ...kind("linux", "Linux", "A Linux box for builds, servers, Docker and the agent's own work.", 2, false, false, { target: 1, ready: 1, making: 0 }),
    forms: ["LXC", "Physical", "Docker"],
    admin: null,
    docker: null,
    offers: [
      offer("proxmox-lxc", "Proxmox LXC", ["pve"], "LXC", { ready: 1, typicalReadyMs: 2200 }),
      offer("ssh-pool", "SSH host pool", [], "Physical", { free: 1, admin: false, docker: false }),
      offer("docker", "Docker", ["docker-host"], "Docker", { typicalReadyMs: 1800 }),
    ],
  },
  kind("linux-desktop", "Linux desktop", "A Linux desktop on the host's GPU, for computer use, browsers and app development.", 4, true, true),
  {
    ...kind("linux-desktop-cpu", "Linux desktop", "A Linux desktop drawn by the CPU. Graphics are slower; nothing else changes.", 4, true, false),
    forms: ["LXC", "Docker"],
    offers: [offer("proxmox-lxc", "Proxmox LXC", ["pve"], "LXC", { typicalReadyMs: 3100, resizable: true }), offer("docker", "Docker", ["docker-host"], "Docker", { resizable: true })],
  },
  {
    ...kind("macos-desktop", "macOS desktop", "A macOS desktop on a Mac.", 4, true, false),
    forms: ["VM"],
    offers: [offer("tart", "Tart", ["mac-mini", "studio"], "VM", { typicalReadyMs: 26000, resizable: false, docker: false })],
  },
  {
    ...kind("windows-desktop", "Windows desktop", "A Windows desktop in a VM.", 4, true, false),
    os: "windows",
    arch: "x86_64",
    enrol: false,
    docker: false,
    forms: ["VM"],
    offers: [offer("proxmox-qemu", "Proxmox QEMU", ["pve"], "VM", { typicalReadyMs: 29000, resizable: true, docker: false })],
  },
];

// A backend offering both an X11 CPU desktop and a Wayland one, so the New box form shows the Display choice (048).
const WAYLAND_KINDS = [
  ...KINDS,
  {
    ...kind("linux-desktop-wayland-cpu", "Linux desktop on Wayland", "A Linux desktop on Wayland (Sway), drawn by the CPU, for computer use, browsers and apps built for Wayland. X11-only apps do not run there.", 4, true, false),
    forms: ["LXC"],
    offers: [offer("proxmox-lxc", "Proxmox LXC", ["pve"], "LXC", { typicalReadyMs: 3200, resizable: true })],
  },
];

const BACKENDS = [
  { type: "proxmox-lxc", label: "Proxmox LXC", nature: "virtual", state: "active", problems: [], setup: { guide: "setup/proxmox-lxc/README.md", scripts: ["setup/proxmox-lxc/host/setup-host.sh", "setup/proxmox-lxc/host/setup-network.sh", "setup/proxmox-lxc/host/setup-token.sh", "setup/proxmox-lxc/template/build.sh"] } },
  { type: "docker", label: "Docker", nature: "virtual", state: "misconfigured", problems: ["Set the Docker host.", "Set the image for Linux boxes."], setup: { guide: "setup/docker/README.md", scripts: ["setup/docker/build.sh"] } },
  { type: "ssh-pool", label: "SSH host pool", nature: "real", state: "off", problems: [], setup: { guide: "setup/ssh-pool/README.md", scripts: [] } },
];

const DOCTOR = {
  ok: false,
  sections: [
    {
      title: "Proxmox LXC",
      report: {
        ok: false,
        summary: "Proxmox VE 9.2 on pve",
        checks: [
          { id: "proxmox.api", name: "Proxmox API", status: "ok", detail: "Proxmox VE 9.2 on pve.", fix: null },
          { id: "proxmox.token", name: "Token rights", status: "ok", detail: "VM.Allocate, VM.Clone, VM.Config.*, VM.PowerMgmt on /pool/bbbox.", fix: null },
          { id: "template.9101", name: "Template 9101", status: "fail", detail: "has no build tag, so warm boxes cannot be checked against it.", fix: "Run build.sh desktop again; it tags the template." },
          { id: "memory", name: "Memory", status: "warn", detail: "pve has 6 GiB free; 4 GiB is kept back, so one Linux box fits.", fix: "Release a box, or lower the memory kept free." },
          { id: "ssh", name: "SSH into a box", status: "skipped", detail: "skipped, since a template check failed.", fix: null },
        ],
        notes: ["Install this public key in the templates:\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB0Zk3Y7XkG0rvmP2tq1u8jq2QwKxH1tO6V6bFm5wQ4a bb-box"],
      },
    },
    { title: "Docker", report: { ok: false, summary: "Its settings need fixing.", checks: [{ id: "settings.0", name: "Settings", status: "fail", detail: "Set the Docker host.", fix: "Fix it in bb-box's settings." }], notes: [] } },
  ],
};

const sizeOf = (cores, memoryGiB, diskGiB = null) => ({ cores, memoryMiB: memoryGiB * 1024, diskGiB });
const DOCTOR_PROXMOX = {
  ok: false,
  summary: "Proxmox VE 9.2 on pve",
  checks: [
    { id: "proxmox.api", name: "Proxmox API", status: "ok", detail: "Proxmox VE 9.2 on pve.", fix: null },
    { id: "proxmox.token", name: "Token rights", status: "ok", detail: "VM.Allocate, VM.Clone, VM.Config.*, VM.PowerMgmt on /pool/bbbox.", fix: null },
    { id: "template.9101", name: "Template 9101", status: "fail", detail: "has no build tag, so warm boxes cannot be checked against it.", fix: "Run build.sh desktop again; it tags the template." },
    { id: "memory", name: "Memory", status: "warn", detail: "pve has 6 GiB free; 4 GiB is kept back, so one Linux box fits.", fix: "Release a box, or lower the memory kept free." },
    { id: "ssh", name: "SSH into a box", status: "skipped", detail: "skipped, since a template check failed.", fix: null },
  ],
  notes: ["Install this public key in the templates:\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB0Zk3Y7XkG0rvmP2tq1u8jq2QwKxH1tO6V6bFm5wQ4a bb-box"],
};
const field = (key, label, group, extra = {}) => ({ key, type: "string", label, group, default: "", ...extra });
const DRIVERS = [
  {
    type: "proxmox-lxc",
    label: "Proxmox LXC",
    description: "Linux containers on a Proxmox VE host, with or without a desktop on its GPU.",
    nature: "virtual",
    kinds: ["linux", "linux-desktop", "linux-desktop-cpu"],
    fields: [
      field("url", "API URL", "connection", { description: "For example https://192.0.2.10:8006, as the setup guide's token file gives it." }),
      field("node", "Node", "connection", { description: "The node boxes run on. Leave empty on a single-node host." }),
      field("tls-fingerprint", "TLS fingerprint", "connection", { description: "The SHA-256 fingerprint of the API's certificate, from the token file." }),
      field("ca-certificate", "CA certificate", "connection", { experimental_multiline: true, description: "PEM certificate of the CA that signed the API's certificate, when there is no fingerprint." }),
      field("token-id", "API token ID", "credentials", { description: "For example bbbox@pve!plugin." }),
      field("token-secret", "API token secret", "credentials", { secret: true }),
      field("ssh-private-key", "SSH private key", "credentials", { secret: true, description: "Leave empty and bb-box makes one and shows its public key, which the templates must then accept." }),
      field("pool", "Resource pool", "boxes", { default: "bbbox", description: "Boxes are made in this pool." }),
      field("linux-templates", "Linux templates", "boxes", { default: "9100", description: "VMIDs of the CT templates Linux boxes are linked clones of, separated by spaces." }),
      field("desktop-templates", "GPU desktop templates", "boxes", { experimental_multiline: true, description: "One line per template: its VMID, a space and the ID of the GPU it carries." }),
      field("desktop-cpu-templates", "CPU desktop templates", "boxes", { description: "VMIDs of the CPU-only desktop templates. Empty turns them off." }),
      { key: "desktops-per-gpu", type: "number", label: "Desktops per GPU", group: "advanced", default: 0, description: "0 means no limit." },
      field("bridge", "Network bridge", "advanced", { default: "vmbr200" }),
      field("subnet", "Subnet", "advanced", { default: "10.200.0.0/24" }),
      field("gateway", "Gateway", "advanced", { default: "10.200.0.1" }),
      field("addresses", "Box addresses", "advanced", { default: "10.200.0.10-10.200.0.254" }),
      { key: "vmid-first", type: "number", label: "First box VMID", group: "advanced", default: 9900 },
      { key: "vmid-last", type: "number", label: "Last box VMID", group: "advanced", default: 9999 },
      field("ssh-user", "SSH user", "advanced", { default: "box" }),
      { key: "reserve-memory-mib", type: "number", label: "Memory kept free (MiB)", group: "advanced", default: 4096 },
      { key: "reserve-disk-gib", type: "number", label: "Disk kept free (GiB)", group: "advanced", default: 50 },
    ],
    hostFields: [],
    setup: { guide: "setup/proxmox-lxc/README.md", scripts: ["setup/proxmox-lxc/host/setup-host.sh", "setup/proxmox-lxc/host/setup-network.sh", "setup/proxmox-lxc/host/setup-token.sh", "setup/proxmox-lxc/template/build.sh"] },
  },
  {
    type: "ssh-pool",
    label: "SSH host pool",
    description: "Your own machines, reached over SSH and reset between boxes.",
    nature: "real",
    kinds: ["linux"],
    fields: [field("machines", "Machines", "boxes", { experimental_multiline: true, description: "One per line: a name, its address and the kinds it serves." }), field("host-keys", "Host keys", "boxes", { experimental_multiline: true }), field("ssh-private-key", "SSH private key", "credentials", { secret: true })],
    hostFields: [],
    setup: { guide: "setup/ssh-pool/README.md", scripts: ["setup/ssh-pool/setup.sh"] },
  },
  {
    type: "tart",
    label: "Tart",
    description: "macOS VMs on your Macs, through Tart.",
    nature: "virtual",
    kinds: ["macos", "macos-desktop"],
    fields: [field("ssh-private-key", "SSH private key", "credentials", { secret: true }), field("vm-user", "VM user", "advanced", { default: "admin" }), field("macos-image", "macOS image", "boxes", { default: "ghcr.io/cirruslabs/macos-sequoia-base:latest" })],
    hostFields: [field("address", "Address", "connection", { description: "The Mac's address, with :port when SSH is not on 22." }), field("user", "User", "connection", { description: "The user bb-box logs in to the Mac as." }), field("host-keys", "Host keys", "connection", { experimental_multiline: true })],
    setup: { guide: "setup/tart/README.md", scripts: ["setup/tart/setup-mac.sh"] },
  },
  {
    type: "docker",
    label: "Docker",
    description: "Linux boxes, with or without a desktop, as containers on a Docker host. It needs only Docker.",
    nature: "virtual",
    kinds: ["linux", "linux-desktop-cpu", "linux-desktop"],
    fields: [
      field("host", "Host", "connection", { description: "unix:///path/to/docker.sock or ssh://user@host. Empty uses the docker CLI's own default." }),
      field("linux-image", "Linux image", "boxes", { default: "bbbox/linux:1" }),
      field("desktop-image", "Desktop image", "boxes", { default: "bbbox/linux-desktop:1" }),
      { key: "privileged", type: "boolean", label: "Docker in boxes", group: "boxes", default: true },
      { key: "gpu-desktops", type: "boolean", label: "GPU desktops", group: "boxes", default: false },
      { key: "boxes", type: "number", label: "Most boxes", group: "advanced", default: 10 },
    ],
    hostFields: [],
    setup: { guide: "setup/docker/README.md", scripts: ["setup/docker/build.sh"] },
  },
];
/** Proxmox QEMU's driver, as the server describes it: Windows desktops, and the switch for their trial as BB machines (#539). */
const PROXMOX_QEMU_DRIVER = {"type": "proxmox-qemu", "label": "Proxmox QEMU", "description": "Windows desktops as VMs on a Proxmox VE host.", "nature": "virtual", "kinds": ["windows-desktop"], "fields": [{"key": "url", "type": "string", "label": "API URL", "description": "For example https://192.0.2.10:8006/api2/json, as the Proxmox LXC setup guide's token file gives it. Leave it, the token, the fingerprint and the CA certificate empty to use Proxmox LXC's.", "group": "connection", "default": "", "inherits": {"from": "proxmox-lxc", "label": "Proxmox LXC", "set": ["url", "token-id", "token-secret", "tls-fingerprint", "ca-certificate"]}}, {"key": "node", "type": "string", "label": "Node", "description": "The node boxes run on. Leave empty on a single-node host.", "group": "connection", "default": ""}, {"key": "tls-fingerprint", "type": "string", "label": "TLS fingerprint", "description": "The SHA-256 fingerprint of the Proxmox API's certificate, from the setup guide's token file. bb-box then trusts that certificate alone. Leave empty to check the certificate against its CA.", "group": "connection", "default": "", "inherits": {"from": "proxmox-lxc", "label": "Proxmox LXC", "set": ["url", "token-id", "token-secret", "tls-fingerprint", "ca-certificate"]}}, {"key": "ca-certificate", "type": "string", "label": "CA certificate", "description": "PEM certificate of the CA that signed the Proxmox API's certificate, when there is no TLS fingerprint. Leave empty for a publicly trusted one.", "experimental_multiline": true, "group": "connection", "default": "", "inherits": {"from": "proxmox-lxc", "label": "Proxmox LXC", "set": ["url", "token-id", "token-secret", "tls-fingerprint", "ca-certificate"]}}, {"key": "token-id", "type": "string", "label": "API token ID", "description": "For example bbbox@pve!plugin. The setup guide lists the privileges it needs.", "group": "credentials", "default": "", "inherits": {"from": "proxmox-lxc", "label": "Proxmox LXC", "set": ["url", "token-id", "token-secret", "tls-fingerprint", "ca-certificate"]}}, {"key": "token-secret", "type": "string", "label": "API token secret", "description": "The secret of the API token, from the setup guide's token file.", "secret": true, "group": "credentials", "inherits": {"from": "proxmox-lxc", "label": "Proxmox LXC", "set": ["url", "token-id", "token-secret", "tls-fingerprint", "ca-certificate"]}}, {"key": "ssh-private-key", "type": "string", "label": "SSH private key", "description": "Paste BBBOX_SSH_KEY, the private key build.sh put in the template, or leave it empty to use Proxmox LXC's. With neither, bb-box makes a key, which the template does not accept until you add its public key.", "secret": true, "group": "credentials", "inherits": {"from": "proxmox-lxc", "label": "Proxmox LXC", "set": ["ssh-private-key"]}}, {"key": "pool", "type": "string", "label": "Resource pool", "description": "Boxes are made in this pool. The token needs rights on it.", "group": "boxes", "default": "bbbox"}, {"key": "windows-templates", "type": "string", "label": "Windows templates", "description": "VMIDs of the Windows templates windows-desktop boxes are linked clones of, separated by spaces or commas. setup/proxmox-qemu/build.sh builds one. A new box is cloned from the least used.", "group": "boxes", "default": "9104"}, {"key": "windows-enrol", "type": "boolean", "label": "Windows boxes as BB machines (trial)", "description": "A trial of Windows boxes that join BB, so threads and terminals can use them. Off unless you are trying it.", "group": "boxes", "default": false}, {"key": "bridge", "type": "string", "label": "Network bridge", "description": "The bridge boxes attach to.", "group": "advanced", "default": "vmbr200"}, {"key": "subnet", "type": "string", "label": "Subnet", "description": "The bridge's subnet in CIDR form. Boxes get static addresses; there is no DHCP.", "group": "advanced", "default": "10.200.0.0/24"}, {"key": "gateway", "type": "string", "label": "Gateway", "description": "The host's address on the bridge.", "group": "advanced", "default": "10.200.0.1"}, {"key": "addresses", "type": "string", "label": "Box addresses", "description": "The range bb-box hands out. The n-th VMID gets the n-th address. Keep it apart from the Proxmox LXC backend's. Leave empty to use the whole subnet except the gateway.", "group": "advanced", "default": "10.200.0.150-10.200.0.254"}, {"key": "vmid-first", "type": "number", "label": "First box VMID", "description": "Boxes take VMIDs from this range. Keep other guests out of it, the Proxmox LXC backend's too.", "group": "advanced", "default": 9700}, {"key": "vmid-last", "type": "number", "label": "Last box VMID", "description": "The end of the range boxes take VMIDs from.", "group": "advanced", "default": 9799}, {"key": "ssh-user", "type": "string", "label": "SSH user", "description": "The user in the template that bb-box and BB work as.", "group": "advanced", "default": "box"}, {"key": "reserve-memory-mib", "type": "number", "label": "Memory kept free (MiB)", "description": "A new box is refused if the node would have less memory than this left.", "group": "advanced", "default": 4096}, {"key": "reserve-disk-gib", "type": "number", "label": "Disk kept free (GiB)", "description": "A new box is refused if the template's storage has less free space than this.", "group": "advanced", "default": 50}], "hostFields": [], "setup": {"guide": "setup/proxmox-qemu/README.md", "scripts": ["setup/proxmox-qemu/build.sh"]}};
/** microsandbox's driver, as the server describes it (053): the fields and help the settings page shows. */
const MICROSANDBOX_DRIVER = {"type": "microsandbox", "label": "microsandbox", "description": "Linux boxes, with or without a desktop, as microVMs that start in under a second, on a Linux host with KVM or a Mac. bb-box installs its own msb there.", "nature": "virtual", "kinds": ["linux", "linux-desktop-cpu", "linux-arm64", "linux-arm64-desktop-cpu"], "fields": [{"key": "host", "type": "string", "label": "Host", "description": "The host that runs the boxes, a Linux host with KVM or a Mac: ssh://user@host, or bb:<machine ID> for a BB machine, which bb-box reaches through BB. Empty uses BB's server. bb-box installs its own msb there, in a folder of its own.", "group": "connection", "default": ""}, {"key": "linux-image", "type": "string", "label": "Linux image", "description": "The image linux boxes run. bb-box imports it from Docker on the host, where setup/docker/build.sh builds it. Empty turns them off.", "group": "boxes", "default": "bbbox/linux:1"}, {"key": "desktop-image", "type": "string", "label": "Desktop image", "description": "The image linux-desktop-cpu boxes run. bb-box imports it from Docker on the host, where setup/docker/build.sh builds it. Empty turns them off.", "group": "boxes", "default": "bbbox/linux-desktop:1"}, {"key": "linux-arm64-image", "type": "string", "label": "Linux image (arm64)", "description": "The image linux-arm64 boxes run, on an arm64 host such as a Mac. bb-box imports it from Docker on the host, or builds it there with setup/docker/build.sh --arch arm64 in a microVM of its own. Empty turns them off.", "group": "boxes", "default": "bbbox/linux:1-arm64"}, {"key": "desktop-arm64-image", "type": "string", "label": "Desktop image (arm64)", "description": "The image linux-arm64-desktop-cpu boxes run, on an arm64 host such as a Mac. bb-box imports it from Docker on the host, or builds it there in a microVM of its own. Empty turns them off.", "group": "boxes", "default": "bbbox/linux-desktop:1-arm64"}, {"key": "docker", "type": "boolean", "label": "Docker in boxes", "description": "Give each box its own Docker daemon, started by its first docker command, with its data on a disk of the box's own. Each box has its own kernel, so this needs no privilege on the host.", "group": "boxes", "default": true}, {"key": "docker-disk-gib", "type": "number", "label": "Docker disk (GiB)", "description": "The most each box's Docker disk may grow to. It takes only what Docker writes, and goes with the box.", "group": "advanced", "default": 64}, {"key": "disk-gib", "type": "number", "label": "Root disk (GiB)", "description": "The most a box's root disk may grow to when no disk size is asked for. It takes only what the box writes.", "group": "advanced", "default": 32}, {"key": "network", "type": "string", "label": "Network profiles", "description": "msb's network profiles for each box, comma-separated: public reaches the internet, private the host's local networks and tailnet, where BB's server often is.", "group": "advanced", "default": "public,private"}, {"key": "boxes", "type": "number", "label": "Most boxes", "description": "The most bb-box microVMs on the host at once, running or stopped, counting those of every bb-box install that uses it.", "group": "advanced", "default": 20}, {"key": "reserve-memory-mib", "type": "number", "label": "Memory kept free (MiB)", "description": "A new box is refused if the host would have less memory than this left, after the memory of the running boxes.", "group": "advanced", "default": 4096}, {"key": "memory-overcommit", "type": "number", "label": "Memory overcommit", "description": "How many times the host's memory the boxes may take in all, after the memory kept free: 1 to 4. At 1, each box counts at its full memory. Above 1, a new box also needs memory free on the host now. Raise it for mostly idle boxes.", "group": "advanced", "default": 1}], "hostFields": [], "setup": {"guide": "setup/microsandbox/README.md", "scripts": []}};
const KIND_INFO = [
  { id: "linux", label: "Linux", description: "A Linux box for builds, backend services and the agent's own work.", gpu: false, desktop: false, os: "linux", arch: "x86_64", features: [], docker: null, spares: { ready: 0, making: 0 }, drivers: ["proxmox-lxc", "ssh-pool", "docker"] },
  { id: "linux-desktop", label: "Linux desktop", description: "A Linux desktop on a GPU.", gpu: true, desktop: true, os: "linux", arch: "x86_64", features: [], docker: true, spares: { ready: 0, making: 0 }, drivers: ["proxmox-lxc", "docker"] },
  { id: "linux-desktop-cpu", label: "Linux desktop", description: "A Linux desktop drawn by the CPU.", gpu: false, desktop: true, os: "linux", arch: "x86_64", features: [], docker: true, spares: { ready: 0, making: 0 }, drivers: ["proxmox-lxc", "docker"] },
  { id: "macos", label: "macOS", description: "A Mac for builds and Apple's tools.", gpu: false, desktop: false, os: "macos", arch: "arm64", features: [], docker: false, spares: { ready: 0, making: 0 }, drivers: ["tart"] },
  { id: "macos-desktop", label: "macOS desktop", description: "A macOS desktop for computer use and app development.", gpu: false, desktop: true, os: "macos", arch: "arm64", features: [], docker: false, spares: { ready: 0, making: 0 }, drivers: ["tart"] },
];
const LINUX_SIZES = { enabled: true, presets: { small: sizeOf(2, 4), medium: sizeOf(4, 8), large: sizeOf(8, 16) }, default: "small", largest: sizeOf(16, 32, 256) };
const DESKTOP_SIZES = { enabled: true, presets: { small: sizeOf(4, 8), medium: sizeOf(8, 16), large: sizeOf(16, 32) }, default: "small", largest: sizeOf(32, 64, 256) };
function configState(options = {}) {
  const document = options.document ?? {
    schema: 1,
    revision: 4,
    backends: [
      { id: "proxmox-lxc", type: "proxmox-lxc", enabled: true, fields: { url: "https://192.0.2.10:8006", node: "pve", "tls-fingerprint": "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89", "token-id": "bbbox@pve!plugin", "token-secret": { set: options.tokenSet ?? true }, "ssh-private-key": { set: true }, "linux-templates": "9800", "desktop-templates": "9801 GPU-0a1b2c3d" }, warm: { linux: 1, "linux-desktop": 1 } },
      { id: "tart", type: "tart", enabled: false, fields: { "ssh-private-key": { set: false } }, hosts: [{ name: "studio", enabled: true, fields: { address: "192.0.2.20", user: "var" } }] },
    ],
    kinds: { "linux-desktop-cpu": { enabled: false }, linux: { default: "medium" } },
    general: {},
  };
  const tokenSet = options.tokenSet ?? true;
  return {
    document,
    revision: document.revision,
    defaults: { general: { boxesPerThread: 0, enrol: true, defaultKind: "linux" }, kinds: { linux: LINUX_SIZES, "linux-desktop": DESKTOP_SIZES, "linux-desktop-cpu": DESKTOP_SIZES, macos: LINUX_SIZES, "macos-desktop": DESKTOP_SIZES } },
    kinds: KIND_INFO,
    drivers: [...DRIVERS, ...(options.drivers ?? [])],
    backends: options.backends ?? [
      tokenSet
        ? { id: "proxmox-lxc", type: "proxmox-lxc", label: "Proxmox LXC on pve", form: "LXC", state: "active", problems: [], boxes: 2, kinds: ["linux", "linux-desktop"], doctor: { report: DOCTOR_PROXMOX, at: now - 2 * 60_000 }, warmShort: options.warmShort ?? [] }
        : { id: "proxmox-lxc", type: "proxmox-lxc", label: "Proxmox LXC", form: "LXC", state: "misconfigured", problems: [{ path: "backends.proxmox-lxc.token-secret", message: "Set the Proxmox API token secret." }], boxes: 0, kinds: [], doctor: null, warmShort: [] },
      { id: "tart", type: "tart", label: "Tart", form: "VM", state: "off", problems: [], boxes: 0, kinds: [], doctor: null, warmShort: [] },
    ],
    problems: tokenSet ? [] : [{ path: "backends.proxmox-lxc.token-secret", message: "Set the Proxmox API token secret." }],
    migrated: { at: now - 3 * 3600_000, version: "0.2.0" },
  };
}

/** Your machines (036) for the settings scene: a desktop a thread works on, and a stopped Linux box. */
const MACHINES = [
  { box: { ...desktop, id: "box_m1", name: "build-1", address: "10.200.0.21", enrol: { state: "enrolled", hostId: "host_m1", error: null } }, threads: [{ id: "thr_a", title: "Fix the login form", running: true }, { id: "thr_b", title: "Docs pass", running: false }] },
  { box: { ...stopped, id: "box_m2", name: "scratch", form: "LXC", backendLabel: "Proxmox LXC on pve", nature: "virtual" }, threads: [] },
];

function rpc(boxes, options = {}) {
  const find = (ref) => boxes.find((candidate) => candidate.id === ref) ?? null;
  return {
    "machines.list": () => ({ machines: options.machines ?? [], kinds: (options.kinds ?? KINDS).filter((kind) => kind.enrol) }),
    provider: ({ backend }) => ({
      backend,
      name: "Proxmox LXC on pve",
      technology: "Linux containers on a Proxmox VE host, with or without a desktop on its GPU.",
      nature: "virtual",
      hosts: ["pve"],
      hostOs: "linux",
      makes: [
        { id: "linux", label: "Linux", form: "LXC", typicalReadyMs: 2200, ready: 1 },
        { id: "linux-desktop", label: "Linux desktop (GPU)", form: "LXC", typicalReadyMs: 3100, ready: 0 },
        { id: "linux-desktop-cpu", label: "Linux desktop", form: "LXC", typicalReadyMs: 3100, ready: 0 },
      ],
      boxes: 2,
      room: {
        ok: true,
        message: null,
        warm: { ready: 1, target: 1 },
        hosts: [{ host: "pve", ok: true, limits: [{ resource: "memory", used: 22 * 1024, total: 64 * 1024, reserve: 4 * 1024, unit: "MiB" }, { resource: "cpu", used: 10, total: 16, reserve: 0, unit: "count" }, { resource: "gpu-desktops", used: 1, total: 1, reserve: 0, unit: "count" }] }],
      },
      status: { state: "active", problem: null, ok: true, summary: "Proxmox VE 9.2 on pve", checkedAt: Date.now() - 120_000 },
    }),
    // Docker on BB machines (042): one hosting boxes, one that could, one with no Docker, one offline.
    "docker.hosts": () => ({
      hosts: options.dockerHosts ?? [
        { hostId: "host_1", name: "devpc", connected: true, docker: { version: "29.8.1", os: "Ubuntu 24.04", arch: "x86_64", cpus: 16, memoryMiB: 64 * 1024 }, problem: null, absent: false, backend: { id: "docker:host_1", enabled: true, boxes: 1 }, images: null },
        { hostId: "host_2", name: "mac-mini", connected: true, docker: { version: "29.8.1", os: "Docker Desktop", arch: "arm64", cpus: 10, memoryMiB: 32 * 1024 }, problem: null, absent: false, backend: null, images: null },
        { hostId: "host_3", name: "laptop", connected: true, docker: null, problem: null, absent: true, backend: null, images: null },
        { hostId: "host_4", name: "attic", connected: false, docker: null, problem: "The machine is offline in BB.", absent: false, backend: { id: "docker:host_4", enabled: true, boxes: 0 }, images: null },
      ],
    }),
    "docker.host.set": () => ({ result: { ok: true, problems: [] }, hosts: [] }),
    "machines.add": () => ({ box: null, error: options.refuse ?? null }),
    "machines.remove": ({ box: ref }) => ({ box: null, error: null }),
    "machines.stop": ({ box: ref }) => ({ box: null, error: null }),
    "machines.start": ({ box: ref }) => ({ box: null, error: null }),
    state: () => ({ boxes, kinds: options.kinds ?? KINDS, backends: BACKENDS, desktopPath: DESKTOP_PATH, terminalPath: TERMINAL_PATH, runsOn: options.runsOn ?? null, imageOffer: options.imageOffer ?? false, images: options.images ?? [] }),
    desktop: ({ box: ref }) => ({ box: find(ref) ?? (options.runsOn?.box.id === ref ? options.runsOn.box : null), desktopPath: DESKTOP_PATH, terminalPath: TERMINAL_PATH, video: options.video ?? false }),
    // The viewer times round trips to BB's server to choose VNC or video (056): this one is as far as options.pingMs.
    ping: () => new Promise((resolve) => setTimeout(() => resolve(null), options.pingMs ?? 0)),
    allBoxes: () => [
      ...(options.machines ?? []).map((entry) => ({ threadId: "operator", box: entry.box, owner: "yours" })),
      ...boxes.map((candidate) => ({ threadId: THREAD, box: candidate, owner: "thread" })),
      ...(options.threadBoxes ?? []).map(([threadId, candidate]) => ({ threadId, box: candidate, owner: "thread" })),
    ],
    acquire: () => ({ box: null, error: options.refuse ?? null }),
    release: ({ box: ref }) => ({ box: find(ref), error: null }),
    stop: ({ box: ref }) => ({ box: find(ref), error: null }),
    start: ({ box: ref }) => ({ box: find(ref), error: null }),
    refresh: ({ box: ref }) => ({ box: find(ref), error: null }),
    takeControl: ({ box: ref }) => ({ box: find(ref), error: null }),
    handBack: ({ box: ref }) => ({ box: find(ref), error: null }),
    backends: () => BACKENDS,
    doctor: () => DOCTOR,
    "config.get": () => configState(options.config ?? {}),
    "config.check": ({ test }) => ({ problems: [], doctor: test === "proxmox-lxc" ? DOCTOR_PROXMOX : null }),
    "config.apply": ({ draft, revision }) => ({ ok: true, state: configState({ ...options.config, document: { ...draft, revision: revision + 1 } }) }),
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const click = (root, role, name) => {
  const element = [...root.querySelectorAll(`[role="${role}"], button, a`)].find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent.trim()) === name && (role === "*" || candidate.getAttribute("role") === role || candidate.tagName.toLowerCase() === role));
  if (!element) throw new Error(`No ${role} "${name}"`);
  element.click();
  return element;
};
/** Clicks the option of a role whose text starts with the words given: an option card's title, a provider row's name. */
const pick = (role, prefix) => {
  const element = [...document.querySelectorAll(`[role="${role}"]`)].find((candidate) => candidate.textContent.trim().startsWith(prefix));
  if (!element) throw new Error(`No ${role} starting "${prefix}"`);
  element.click();
  return element;
};
const openMenu = (root, name) => {
  const trigger = [...root.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-label") === name);
  trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
};

/** Boxes of several threads for the Boxes page's Threads tab: a thread with two, one on a Mac and one stopped. */
const macDesktop = box({
  id: "box_9",
  name: "amber-finch",
  kind: "macos-desktop",
  kindLabel: "macOS desktop",
  backendLabel: "Tart on studio",
  form: "VM",
  os: "macos",
  arch: "arm64",
  desktop: true,
  display: { protocol: "rfb", resizable: false },
  control: { owner: "agent", holder: null },
  computerUse: true,
  extras: [],
  docker: false,
  createdAt: now - 40 * 60_000,
  size: "4 cores, 8 GiB memory, 60 GiB disk",
});
const THREAD_BOXES = [
  ["thr_login", macDesktop],
  ["thr_docs", { ...stopped, id: "box_10", name: "still-pond", createdAt: now - 3 * 3_600_000 }],
];
const THREAD_TITLES = { [THREAD]: "Add dark mode", thr_login: "Fix the login form", thr_docs: "Docs pass" };
/** The Boxes page with your machines and three threads' boxes. */
const boxesPage = (extra = {}) => ({ slot: "boxes-page", width: 1000, props: { subPath: "" }, rpc: rpc([box(), desktop], { machines: MACHINES, threadBoxes: THREAD_BOXES }), threads: THREAD_TITLES, ...extra });
/** Clicks a tab by its label; its count follows the label. */
const openTab = (root, name) => [...root.querySelectorAll("[role=tab]")].find((tab) => tab.textContent.startsWith(name)).click();

const boxesChrome = `<span class="pill"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7z"/><path d="M3.8 7.2 12 11.8l8.2-4.6M12 11.8v9.5"/></svg>Box</span><span>+</span>`;
const terminalChrome = (name) => `<span>Box</span><span class="pill"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></svg>Terminal: ${name}</span><span>+</span>`;
const desktopChrome = (name) => `<span>Box</span><span class="pill"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7z"/><path d="M3.8 7.2 12 11.8l8.2-4.6M12 11.8v9.5"/></svg>${name}</span><span>+</span>`;

export const scenes = {
  "panel-empty": { slot: "boxes", chrome: boxesChrome, rpc: rpc([]) },
  "panel-nobackend": { slot: "boxes", chrome: boxesChrome, rpc: rpc([], { kinds: [] }) },
  "panel-list": { slot: "boxes", chrome: boxesChrome, rpc: rpc([starting, desktop, stopped]) },
  "panel-runs-on": { slot: "boxes", chrome: boxesChrome, rpc: rpc([starting], { runsOn: { box: MACHINES[0].box, owner: "yours", threadId: null } }) },
  "panel-runs-on-only": { slot: "boxes", chrome: boxesChrome, rpc: rpc([], { runsOn: { box: MACHINES[0].box, owner: "yours", threadId: null } }) },
  "panel-list-narrow": {
    slot: "boxes",
    chrome: boxesChrome,
    width: 568,
    height: 520,
    viewport: 600,
    rpc: rpc([starting, desktop, stopped, failed]),
  },
  "panel-list-open": {
    slot: "boxes",
    chrome: boxesChrome,
    rpc: rpc([starting, desktop, stopped]),
    after: (root) => click(root, "button", "bold-heron: details"),
  },
  "panel-problems": { slot: "boxes", chrome: boxesChrome, rpc: rpc([failed, gone, refused]) },
  // Docker and microsandbox on one host, beside Proxmox LXC (053): the provider rows must tell the two on behemoth apart.
  "panel-chooser-microsandbox": {
    slot: "boxes",
    chrome: boxesChrome,
    width: 720,
    height: 900,
    rpc: rpc([], {
      kinds: [
        {
          ...KINDS[0],
          forms: ["LXC", "Docker", "VM"],
          offers: [
            offer("proxmox-lxc", "Proxmox LXC", ["pve"], "LXC", { ready: 1, typicalReadyMs: 2200 }),
            offer("docker", "Docker", ["behemoth"], "Docker", { typicalReadyMs: 1800 }),
            offer("microsandbox", "microsandbox", ["behemoth"], "VM", { typicalReadyMs: 400 }),
          ],
        },
        ...KINDS.slice(1),
      ],
    }),
    after: async (root) => {
      click(root, "button", "New box");
      await wait(300);
    },
  },
  "panel-chooser": {
    slot: "boxes",
    chrome: boxesChrome,
    width: 720,
    height: 840,
    rpc: rpc([]),
    after: async (root) => {
      click(root, "button", "New box");
      await wait(300);
    },
  },
  "panel-chooser-on": {
    slot: "boxes",
    chrome: boxesChrome,
    width: 720,
    height: 840,
    rpc: rpc([]),
    after: async (root) => {
      click(root, "button", "New box");
      await wait(300);
      // Linux has three providers: the Docker machine picked, so the request names it (044).
      pick("radio", "docker-host");
      await wait(200);
    },
  },
  "panel-chooser-profile": {
    slot: "boxes",
    chrome: boxesChrome,
    width: 720,
    height: 980,
    rpc: rpc([]),
    after: async (root) => {
      click(root, "button", "New box");
      await wait(300);
      // The (i) on the first provider row opens its profile.
      click(document.body, "button", "About pve");
      await wait(400);
    },
  },
  "panel-chooser-filter": {
    slot: "boxes",
    chrome: boxesChrome,
    width: 720,
    height: 800,
    rpc: rpc([]),
    after: async (root) => {
      click(root, "button", "New box");
      await wait(300);
      // Kind: Physical keeps the pool only and hides Runs on.
      document.querySelector('[role="combobox"][aria-label="Kind"]')?.click();
      await wait(300);
      [...document.querySelectorAll('[role="option"]')].find((option) => option.textContent.trim() === "Physical")?.click();
      await wait(300);
    },
  },
  "panel-chooser-display": {
    slot: "boxes",
    chrome: boxesChrome,
    width: 720,
    height: 860,
    rpc: rpc([], { kinds: WAYLAND_KINDS }),
    after: async (root) => {
      click(root, "button", "New box");
      await wait(300);
      // A desktop shows the Display choice; Wayland drops the GPU and notes that X11-only apps need X11.
      pick("radio", "Desktop");
      await wait(200);
      document.querySelector('[role="combobox"][aria-label="Display"]')?.click();
      await wait(300);
      [...document.querySelectorAll('[role="option"]')].find((option) => option.textContent.trim() === "Wayland")?.click();
      await wait(300);
    },
  },
  // A Linux box for a project with no box image (049): the footer's dim link offers to make one, opposite Create box.
  "panel-chooser-image": {
    slot: "boxes",
    chrome: boxesChrome,
    width: 720,
    height: 860,
    rpc: rpc([], { imageOffer: true }),
    after: async (root) => {
      click(root, "button", "New box");
      await wait(300);
    },
  },
  // Two projects' images cover Linux (049): a dim sub-label "Image" under the Type cards and one menu, this project's image first, open.
  // This project's image has a spare ready on Proxmox LXC (#440), so that row says "ready now" for it.
  "panel-chooser-images": {
    slot: "boxes",
    chrome: boxesChrome,
    width: 720,
    height: 860,
    rpc: rpc([], { images: [
      { name: "rust-tools", kinds: ["linux"], projects: [{ id: "proj_1", name: "Example" }], mine: true, builds: [{ kind: "linux", backend: "proxmox-lxc", build: "b1", built: "2026-10-02T10:00:00Z" }], spares: [{ kind: "linux", backend: "proxmox-lxc", ready: 1, making: 0 }] },
      { name: "go-tools", kinds: ["linux"], projects: [{ id: "proj_2", name: "Another project" }], mine: false, builds: [], spares: [] },
    ] }),
    after: async (root) => {
      click(root, "button", "New box");
      await wait(300);
      document.querySelector('[role="combobox"][aria-label="Image"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await wait(300);
    },
  },
  "panel-chooser-windows": {
    slot: "boxes",
    chrome: boxesChrome,
    width: 720,
    height: 760,
    rpc: rpc([]),
    after: async (root) => {
      click(root, "button", "New box");
      await wait(300);
      // Windows has no server, so Type snaps to Desktop and Server says Not available.
      pick("radio", "Windows");
      await wait(200);
    },
  },
  "panel-chooser-narrow": {
    slot: "boxes",
    chrome: boxesChrome,
    width: 568,
    height: 1000,
    viewport: 600,
    rpc: rpc([]),
    after: async (root) => {
      click(root, "button", "New box");
      await wait(300);
    },
  },
  "panel-chooser-custom": {
    slot: "boxes",
    chrome: boxesChrome,
    width: 720,
    height: 960,
    rpc: rpc([]),
    after: async (root) => {
      click(root, "button", "New box");
      await wait(300);
      pick("radio", "Desktop");
      await wait(100);
      pick("radio", "Custom");
      await wait(300);
    },
  },
  "panel-stop-refused": {
    slot: "boxes",
    chrome: boxesChrome,
    height: 420,
    rpc: { ...rpc([box(), desktop]), stop: () => ({ box: null, error: "Stopping the box failed: the host did not answer." }) },
    after: async (root) => {
      // A refused change: a red line under the toolbar, with Dismiss.
      click(root, "button", "Stop");
      await wait(400);
    },
  },
  "panel-refused": {
    slot: "boxes",
    chrome: boxesChrome,
    height: 940,
    rpc: rpc([], { refuse: "pve has 10 GiB of memory free and keeps 4 GiB free, so a linux-desktop box with 8 GiB memory does not fit. Release a box, ask for less memory, or lower the memory kept free in bb-box's settings." }),
    after: async (root) => {
      click(root, "button", "New box");
      await wait(300);
      pick("radio", "Desktop");
      pick("radio", "Large");
      click(document.body, "button", "Create box");
      await wait(300);
    },
  },
  "panel-menu": {
    slot: "boxes",
    chrome: boxesChrome,
    height: 420,
    rpc: rpc([starting, desktop, stopped]),
    after: async (root) => {
      openMenu(root, "bold-heron actions");
      await wait(300);
    },
  },
  "panel-release": {
    slot: "boxes",
    chrome: boxesChrome,
    width: 788,
    height: 460,
    rpc: rpc([starting, desktop, stopped]),
    after: async (root) => {
      openMenu(root, "bold-heron actions");
      await wait(300);
      click(document.body, "menuitem", "Release…");
      await wait(400);
    },
  },
  terminal: {
    slot: "terminal",
    chrome: terminalChrome("calm-otter"),
    width: 720,
    height: 420,
    props: { threadId: THREAD, params: { box: "box_1" } },
    rpc: rpc([box()]),
    terminal: { output: "Welcome to Ubuntu 24.04 LTS (GNU/Linux 6.8.0 x86_64)\r\n\r\nbox@calm-otter:~$ ls\r\napp  node_modules  package.json  README.md\r\nbox@calm-otter:~$ " },
  },
  "terminal-ended": {
    slot: "terminal",
    chrome: terminalChrome("calm-otter"),
    width: 720,
    height: 420,
    props: { threadId: THREAD, params: { box: "box_1" } },
    rpc: rpc([box()]),
    terminal: { output: "box@calm-otter:~$ exit\r\nlogout\r\n", end: "The shell exited." },
  },
  "terminal-stopped": { slot: "terminal", chrome: terminalChrome("wild-cove"), width: 720, height: 420, props: { threadId: THREAD, params: { box: "box_4" } }, rpc: rpc([stopped]) },
  "desktop-connecting": { slot: "desktop", chrome: desktopChrome("bold-heron"), width: 720, height: 480, props: { threadId: THREAD, params: { box: "box_2" } }, rpc: rpc([desktop]) },
  // A desktop shown as video (056): the browser is away from BB's network, so the viewer chose video; the menu's Show as video is ticked.
  "desktop-video-menu": {
    slot: "desktop",
    chrome: desktopChrome("bold-heron"),
    width: 720,
    height: 480,
    props: { threadId: THREAD, params: { box: "box_2" } },
    rpc: rpc([{ ...desktop, control: { owner: "human", get holder() { return sessionStorage.getItem("bb-box:viewer:box_2") ?? "viewer"; }, takenFrom: null } }], { video: true, pingMs: 25 }),
    after: async (root) => {
      await wait(500);
      openMenu(root, "Desktop actions");
      await wait(300);
    },
  },
  // Video that cannot start (056): the desktop shows over VNC, and the toolbar says so for a moment, the reason in its tooltip.
  "desktop-video-fallback": {
    slot: "desktop",
    chrome: desktopChrome("bold-heron"),
    width: 720,
    height: 480,
    props: { threadId: THREAD, params: { box: "box_2" } },
    rpc: rpc([desktop], { video: true, pingMs: 25 }),
    terminal: { videoFail: "This box's desktop has no Selkies stream" },
    after: async (root) => {
      await wait(600);
    },
  },
  "desktop-menu": {
    slot: "desktop",
    chrome: desktopChrome("bold-heron"),
    width: 720,
    height: 480,
    props: { threadId: THREAD, params: { box: "box_2" } },
    // This tab holds control: the holder is read when the RPC answers, by which time the tab's viewer ID is in sessionStorage.
    rpc: rpc([{ ...desktop, control: { owner: "human", get holder() { return sessionStorage.getItem("bb-box:viewer:box_2") ?? "viewer"; }, takenFrom: null } }]),
    after: async (root) => {
      await wait(300);
      try {
        openMenu(root, "Desktop actions");
      } catch (error) {
        throw new Error(`${error}; buttons=${JSON.stringify([...root.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent.trim()))}`);
      }
      await wait(300);
    },
  },
  "desktop-stopped": { slot: "desktop", chrome: desktopChrome("bold-heron"), width: 720, height: 480, props: { threadId: THREAD, params: { box: "box_2" } }, rpc: rpc([{ ...desktop, state: "stopped" }]) },
  "desktop-released": { slot: "desktop", chrome: desktopChrome("bold-heron"), width: 720, height: 480, props: { threadId: THREAD, params: { box: "box_2" } }, rpc: rpc([]) },
  "desktop-chooser": { slot: "desktop", chrome: desktopChrome("Desktop"), width: 560, props: { threadId: THREAD, params: null }, rpc: rpc([desktop, { ...desktop, id: "box_8", name: "wild-cove", kindLabel: "Linux desktop", gpu: false, state: "stopped" }]) },
  "boxes-page": boxesPage(),
  "boxes-page-threads": boxesPage({ after: async (root) => { openTab(root, "Threads"); await wait(300); } }),
  "boxes-page-new-menu": boxesPage({
    height: 560,
    after: async (root) => {
      // New box's menu, as New automation's on BB's Automations page.
      openMenu(root, "New box options");
      await wait(300);
    },
  }),
  "boxes-page-empty": { slot: "boxes-page", width: 900, height: 420, props: { subPath: "" }, rpc: rpc([]) },
  "boxes-page-menu": {
    slot: "boxes-page",
    width: 900,
    height: 760,
    props: { subPath: "" },
    rpc: rpc([box(), desktop], { machines: MACHINES }),
    threads: { [THREAD]: "Add dark mode" },
    after: async (root) => {
      // A thread's box on the page has the Box panel's menu (the operator, 5 October 2026).
      openTab(root, "Threads");
      await wait(200);
      openMenu(root, "calm-otter actions");
      await wait(300);
    },
  },
  "boxes-page-add": {
    slot: "boxes-page",
    width: 900,
    height: 1160,
    props: { subPath: "" },
    rpc: rpc([box(), desktop], { machines: MACHINES }),
    threads: { [THREAD]: "Add dark mode" },
    after: async (root) => {
      // The page's New box opens the same form as settings' Add machine, with the Name step (the operator, 4 October 2026).
      click(root, "button", "New box");
      await wait(400);
    },
  },
  "boxes-page-starting": { slot: "boxes-page", width: 900, props: { subPath: "" }, rpc: rpc([starting, desktop]), threads: { [THREAD]: "Add dark mode" } },
  "settings": { slot: "settings", width: 860, props: {}, rpc: rpc([], { machines: MACHINES }) },
  "settings-machines-empty": { slot: "settings", width: 860, height: 420, props: {}, rpc: rpc([]) },
  "settings-machines-add": {
    slot: "settings",
    width: 860,
    height: 900,
    props: {},
    rpc: rpc([]),
    after: async (root) => {
      // Add machine is the same form with a Name step and an Add button (036).
      click(root, "button", "Add machine");
      await wait(300);
    },
  },
  "settings-setup": {
    slot: "settings",
    width: 860,
    props: {},
    rpc: rpc([], { config: { tokenSet: false } }),
    after: async (root) => {
      [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === "Set up")?.click();
      await wait(300);
    },
  },
  "settings-setup-off": {
    slot: "settings",
    width: 860,
    props: {},
    rpc: rpc([]),
    after: async (root) => {
      root.querySelector('button[aria-label="Set up Tart"]')?.click();
      await wait(300);
    },
  },
  // Windows desktops on Proxmox, with their trial as BB machines on (#539): the form shows the switch with the Windows templates.
  "settings-windows-trial": {
    slot: "settings",
    width: 860,
    props: {},
    rpc: rpc([], {
      config: {
        drivers: [PROXMOX_QEMU_DRIVER],
        document: {
          schema: 1,
          revision: 9,
          backends: [
            { id: "proxmox-lxc", type: "proxmox-lxc", enabled: true, fields: { url: "https://192.0.2.10:8006", node: "pve", "token-id": "bbbox@pve!plugin", "token-secret": { set: true }, "ssh-private-key": { set: true }, "linux-templates": "9800" } },
            { id: "proxmox-qemu", type: "proxmox-qemu", enabled: true, fields: { "windows-templates": "9803", "windows-enrol": true, "token-secret": { set: false }, "ssh-private-key": { set: false } } },
          ],
          kinds: {},
          general: {},
        },
        backends: [
          { id: "proxmox-lxc", type: "proxmox-lxc", label: "Proxmox LXC on pve", form: "LXC", state: "active", problems: [], boxes: 2, kinds: ["linux"], doctor: { report: { ok: true, summary: "Proxmox VE 9.2 on pve", checks: [], notes: [] }, at: now - 60_000 }, warmShort: [] },
          { id: "proxmox-qemu", type: "proxmox-qemu", label: "Proxmox QEMU on pve", form: "VM", state: "active", problems: [], boxes: 1, kinds: ["windows-desktop"], doctor: { report: { ok: true, summary: "Proxmox VE 9.2 on pve", checks: [], notes: [] }, at: now - 60_000 }, warmShort: [] },
        ],
      },
    }),
    after: async (root) => {
      root.querySelector('button[aria-label="Set up Proxmox QEMU on pve"]')?.click();
      await wait(300);
    },
  },
  // Two microsandbox backends beside Docker, as an operator with a Linux host and a Mac has them (053): one named in its ID.
  "settings-microsandbox": {
    slot: "settings",
    width: 860,
    props: {},
    rpc: rpc([], {
      config: {
        drivers: [MICROSANDBOX_DRIVER],
        document: {
          schema: 1,
          revision: 9,
          backends: [
            { id: "docker", type: "docker", enabled: true, fields: { host: "ssh://box@behemoth" } },
            { id: "microsandbox", type: "microsandbox", enabled: true, fields: { host: "ssh://box@behemoth" } },
            { id: "microsandbox:homestead", type: "microsandbox", enabled: true, fields: { host: "bb:host_mac1", "memory-overcommit": 2 } },
          ],
          kinds: {},
          general: {},
        },
        backends: [
          { id: "docker", type: "docker", label: "Docker on behemoth", form: "Docker", state: "active", problems: [], boxes: 1, kinds: ["linux", "linux-desktop-cpu"], doctor: { report: { ok: true, summary: "Docker 29.8 on behemoth", checks: [], notes: [] }, at: now - 60_000 }, warmShort: [] },
          { id: "microsandbox", type: "microsandbox", label: "microsandbox on behemoth", form: "microVM", state: "active", problems: [], boxes: 2, kinds: ["linux", "linux-desktop-cpu"], doctor: { report: { ok: true, summary: "msb 0.7.7 on behemoth", checks: [], notes: [] }, at: now - 60_000 }, warmShort: [] },
          { id: "microsandbox:homestead", type: "microsandbox", label: "microsandbox on homestead", form: "microVM", state: "active", problems: [], boxes: 0, kinds: ["linux-arm64", "linux-arm64-desktop-cpu"], doctor: { report: { ok: true, summary: "msb 0.7.7 on homestead", checks: [], notes: [] }, at: now - 60_000 }, warmShort: [] },
        ],
      },
    }),
    after: async (root) => {
      root.querySelector('button[aria-label="Set up microsandbox on homestead"]')?.click();
      await wait(300);
      click(root, "button", "Advanced");
      await wait(300);
    },
  },
  "settings-kind": {
    slot: "settings",
    width: 860,
    props: {},
    rpc: rpc([]),
    after: async (root) => {
      [...root.querySelectorAll("button")].filter((b) => b.textContent.trim() === "Edit")[2]?.click();
      await wait(300);
    },
  },
  // A kind whose warm pool on a backend is short for want of room (#356): its note shows under that backend's warm count.
  "settings-kind-short": {
    slot: "settings",
    width: 860,
    props: {},
    rpc: rpc([], {
      config: {
        warmShort: [
          {
            kinds: ["linux-desktop"],
            count: 1,
            have: 0,
            reason: "pve has 182.9 GiB of memory free and keeps 256 GiB free, so a linux-desktop box with 8 GiB memory does not fit. Release a box, or lower the memory kept free in bb-box's settings.",
          },
        ],
      },
    }),
    after: async (root) => {
      [...root.querySelectorAll("button")].filter((b) => b.textContent.trim() === "Edit")[1]?.click();
      await wait(300);
    },
  },
};
