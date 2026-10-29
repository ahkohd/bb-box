import meta from "./meta.json";

export type FieldValue = string | number | boolean;
export type SecretState = { readonly set: boolean; readonly version: string };
export type Stored = FieldValue | SecretState;

export interface FieldView {
  readonly key: string;
  readonly label: string;
  readonly type: "string" | "number" | "boolean" | "select";
  readonly group: string;
  readonly description?: string;
  readonly default?: FieldValue;
  readonly secret?: boolean;
  readonly experimental_multiline?: boolean;
  readonly options?: readonly string[];
  readonly inherits?: { readonly from: string; readonly label: string; readonly set: readonly string[] };
}

export interface DriverView {
  readonly type: string;
  readonly label: string;
  readonly description: string;
  readonly nature: string;
  readonly kinds: readonly string[];
  readonly several: boolean;
  readonly fields: readonly FieldView[];
  readonly hostFields: readonly FieldView[];
  readonly setup: { readonly guide: string; readonly scripts: readonly string[] };
}

export interface BoxSize {
  readonly cores: number;
  readonly memoryMiB: number;
  readonly diskGiB: number | null;
}

export type Preset = "small" | "medium" | "large";
export const PRESETS: readonly Preset[] = ["small", "medium", "large"];
export const PRESET_LABELS: Record<Preset, string> = { small: "Small", medium: "Medium", large: "Large" };

export interface KindInfo {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly os: string;
  readonly arch: string;
  readonly desktop: boolean;
  readonly gpu: boolean;
  readonly device: string | null;
  readonly drivers: readonly string[];
  readonly sizes: { readonly presets: Record<Preset, BoxSize>; readonly default: Preset; readonly largest: BoxSize };
}

export const DRIVERS = meta.drivers as unknown as readonly DriverView[];
export const KINDS = meta.kinds as unknown as readonly KindInfo[];

export function driverOf(type: string): DriverView {
  return DRIVERS.find((driver) => driver.type === type)!;
}

export function kindOf(id: string): KindInfo {
  return KINDS.find((kind) => kind.id === id)!;
}

export interface HostConfig {
  readonly name: string;
  readonly enabled: boolean;
  readonly fields: Readonly<Record<string, FieldValue>>;
}

export interface BackendConfig {
  readonly id: string;
  readonly type: string;
  readonly label?: string;
  readonly enabled: boolean;
  readonly fields: Readonly<Record<string, Stored>>;
  readonly hosts?: readonly HostConfig[];
  readonly warm?: Readonly<Record<string, number>>;
}

export interface KindConfig {
  readonly enabled: boolean;
  readonly presets: Record<Preset, BoxSize>;
  readonly default: Preset;
  readonly largest: BoxSize;
  readonly spares: number;
}

export interface ProjectImage {
  readonly name: string;
  readonly kinds: readonly string[];
  readonly projects: readonly string[];
  readonly bake: "auto" | "always" | "never";
  readonly script: string;
  readonly check: string;
  readonly source: string;
  readonly updated: string;
  readonly builds: string;
}

export interface BoxFile {
  readonly path: string;
  readonly content: SecretState;
}

export interface Document {
  readonly revision: number;
  readonly backends: readonly BackendConfig[];
  readonly kinds: Readonly<Record<string, KindConfig>>;
  readonly general: {
    readonly defaultKind: string;
    readonly boxesPerThread: number;
    readonly enrol: boolean;
    readonly video: boolean;
    readonly nightlyImages: boolean;
    readonly testDevice: boolean;
    readonly encoderLedger: boolean;
    readonly iosEncoder: "auto" | "hardware" | "software";
    readonly files: readonly BoxFile[];
    readonly tailnet: { readonly mode: "off" | "oauth"; readonly tags: string; readonly clientId: SecretState; readonly clientSecret: SecretState };
  };
  readonly monitor: { readonly enabled: boolean; readonly refreshIntervalSeconds: number; readonly backgroundMonitoring: boolean; readonly pressureNotifications: boolean };
  readonly images: readonly ProjectImage[];
  readonly migrated: string | null;
}

export type CheckStatus = "ok" | "warn" | "fail" | "skipped";

export interface Check {
  readonly id: string;
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly fix?: string;
}

export interface Health {
  readonly summary: string;
  readonly checks: readonly Check[];
  readonly checkedAt: number;
  readonly checkedRevision?: number;
  readonly notes?: readonly string[];
}

export interface WarmShort {
  readonly kind: string;
  readonly ready: number;
  readonly wanted: number;
  readonly reason: string;
}

export interface BackendLive {
  readonly boxes: number;
  readonly offers: readonly string[];
  readonly health: Health | null;
  readonly checking: boolean;
  readonly changedRevision: number;
  readonly warmShort?: readonly WarmShort[];
  readonly building?: string;
  readonly bbMachine?: { readonly name: string; readonly connected: boolean; readonly facts: string };
}

export interface DockerMachine {
  readonly id: string;
  readonly name: string;
  readonly docker: string | null;
  readonly facts: string;
  readonly connected: boolean;
  readonly fault?: string;
}

export interface StandardImage {
  readonly name: string;
  readonly backend: string;
  readonly age: string;
  readonly due: string | null;
  readonly last: string;
  readonly lastState: "refreshed" | "failed" | "waiting" | "skipped" | "not started" | null;
}

export const HOURS = 3_600_000;
export const NOW = Date.now();

function secret(set: boolean, version = "r180"): SecretState {
  return { set, version: set ? version : "none" };
}

function defaultsOf(id: string): KindConfig {
  const { sizes } = kindOf(id);
  return { enabled: true, presets: { ...sizes.presets }, default: sizes.default, largest: sizes.largest, spares: 0 };
}

function kindsConfig(): Record<string, KindConfig> {
  const kinds: Record<string, KindConfig> = {};
  for (const kind of KINDS) kinds[kind.id] = defaultsOf(kind.id);
  kinds["linux"] = { ...kinds["linux"]!, spares: 1 };
  kinds["windows-desktop"] = { ...kinds["windows-desktop"]!, spares: 1 };
  kinds["linux-arm64"] = { ...kinds["linux-arm64"]!, spares: 1 };
  kinds["linux-desktop-wayland-cpu"] = { ...kinds["linux-desktop-wayland-cpu"]!, enabled: false };
  kinds["linux-arm64-desktop-cpu"] = { ...kinds["linux-arm64-desktop-cpu"]!, enabled: false };
  return kinds;
}

const BACKENDS: readonly BackendConfig[] = [
  {
    id: "proxmox-lxc",
    type: "proxmox-lxc",
    enabled: true,
    fields: {
      url: "https://192.0.2.10:8006/api2/json",
      node: "pve-1",
      "tls-fingerprint": "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89",
      "token-id": "bbbox@pve!plugin",
      "token-secret": secret(true),
      "ssh-private-key": secret(true),
      "linux-templates": "9100",
      "desktop-templates": "9101 GPU-0a1b2c3d",
      "desktop-cpu-templates": "9103",
      "desktop-wayland-cpu-templates": "9109",
    },
    warm: { linux: 1, "linux-desktop": 1 },
  },
  { id: "tart", type: "tart", enabled: true, fields: { "ssh-private-key": secret(true), "linux-image": "bb-box-linux", "ios-image": "bb-box-ios", "windows-image": "windows-11-arm", "ios-hosts-on": true }, hosts: [{ name: "mac-1", enabled: true, fields: { address: "192.0.2.30", user: "admin", "host-keys": "192.0.2.30 ssh-ed25519 AAAAC3Nza...example" } }], warm: { macos: 1, "macos-desktop": 1, "windows-arm64-desktop": 1 } },
  { id: "ssh-pool", type: "ssh-pool", enabled: true, fields: { machines: "build-1 192.0.2.21 linux\nmac-2 192.0.2.31 macos,macos-desktop,ios", "known-hosts": "192.0.2.21 ssh-ed25519 AAAAC3Nza...example\n192.0.2.31 ssh-ed25519 AAAAC3Nza...example", "ssh-private-key": secret(false) } },
  { id: "docker", type: "docker", enabled: true, fields: { host: "ssh://box@192.0.2.40" } },
  { id: "docker:pc-1", type: "docker", enabled: true, fields: { host: "bb:host_pc1example" } },
  { id: "microsandbox:mac-1", type: "microsandbox", enabled: true, fields: { host: "ssh://admin@192.0.2.30" } },
  { id: "proxmox-qemu", type: "proxmox-qemu", enabled: true, fields: { "windows-templates": "9104", "android-templates": "9106", "linux-templates": "9105" }, warm: { "windows-desktop": 1 } },
  { id: "hetzner", type: "hetzner", enabled: true, fields: { token: secret(true), "arm-server-type": "cax31" } },
  { id: "namespace", type: "namespace", enabled: false, fields: { token: secret(true), region: "eu" } },
];

export function initialDocument(firstRun: boolean): Document {
  return {
    revision: firstRun ? 0 : 214,
    backends: firstRun ? [] : BACKENDS,
    kinds: kindsConfig(),
    general: {
      defaultKind: "linux",
      boxesPerThread: 0,
      enrol: true,
      video: true,
      nightlyImages: !firstRun,
      testDevice: false,
      encoderLedger: true,
      iosEncoder: "auto",
      files: firstRun ? [] : [{ path: ".pi/agent/models.json", content: secret(true, "r150") }],
      tailnet: firstRun ? { mode: "off", tags: "tag:bb-box", clientId: secret(false), clientSecret: secret(false) } : { mode: "oauth", tags: "tag:bb-box", clientId: secret(true, "r120"), clientSecret: secret(true, "r120") },
    },
    monitor: { enabled: true, refreshIntervalSeconds: 5, backgroundMonitoring: false, pressureNotifications: true },
    images: firstRun
      ? []
      : [
          {
            name: "web-app",
            kinds: ["linux", "linux-desktop-cpu"],
            projects: ["web-app"],
            bake: "auto",
            script: "#!/bin/sh\nset -e\napt-get update\napt-get install -y postgresql-client redis-tools\nnpm install -g pnpm@9",
            check: "psql --version && redis-cli --version && pnpm --version",
            source: ".bb/box-setup.sh and .bb/box-check.sh",
            updated: "26 October",
            builds: "Built ahead after 2 boxes in 14 days; last built 27 October for Linux on Proxmox LXC",
          },
        ],
    migrated: firstRun ? null : "3 October",
  };
}

function ok(id: string, name: string, detail: string): Check {
  return { id, name, status: "ok", detail };
}

export function healthyChecks(backend: BackendConfig): Health {
  const at = NOW - 6 * HOURS;
  switch (backend.type) {
    case "proxmox-lxc":
      return {
        summary: "Proxmox VE 9.2 on pve-1",
        checkedAt: at,
        checks: [
          ok("api", "Proxmox API", "Proxmox VE 9.2.21 at 192.0.2.10:8006."),
          ok("node", "Node", "Boxes run on pve-1."),
          ok("memory", "Node memory", "186 GiB of 251 GiB free."),
          ok("sizes", "Box sizes", "pve-1 holds every kind at its default size."),
          ok("pool", "Resource pool", "bbbox exists, and the token has its rights."),
          ok("t9100", "Linux template 9100", "Standard image built 24 October, 4 days ago."),
          ok("t9101", "GPU desktop template 9101", "Standard image built 24 October, on GPU-0a1b2c3d."),
          ok("t9103", "CPU desktop template 9103", "Standard image built 24 October."),
          ok("t9109", "CPU Wayland desktop template 9109", "Standard image built 24 October."),
          ok("gpu", "GPUs", "1 GPU, 1 desktop on it, room for 3 more."),
          ok("ssh", "SSH into a box", "The key opens a box made from template 9100."),
        ],
      };
    case "tart":
      return {
        summary: "Tart 2.40 and QEMU 11.1 on mac-1",
        checkedAt: at,
        checks: [ok("mac", "Mac mac-1", "Answers over SSH; Tart 2.40, QEMU 11.1."), ok("vms", "VMs", "1 of 2 VMs in use."), ok("memory", "Memory", "41 GiB free, 16 GiB kept back."), ok("images", "Images", "bb-box-macos, bb-box-linux, bb-box-ios and windows-11-arm are on mac-1."), ok("ios", "Shared iOS hosts", "1 host, 6 slots, 1 ready.")],
      };
    case "ssh-pool":
      return {
        summary: "2 machines, 2 free",
        checkedAt: at,
        checks: [ok("build-1", "Machine build-1", "Linux, answers, free."), ok("mac-2", "Machine mac-2", "macOS 26.1, answers, free; lends iOS slots.")],
        notes: ["Give this public key to setup.sh and setup-mac.sh:\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyOnly bb-box"],
      };
    case "docker":
      return backend.id === "docker"
        ? { summary: "Docker 29.8 on docker-1", checkedAt: at, checks: [ok("daemon", "Docker", "29.8.2 on docker-1, 32 cores, 64 GiB."), ok("images", "Images", "bbbox/linux:1, bbbox/linux-desktop:1 and bbbox/linux-desktop-wayland:1 are built."), ok("network", "Network", "bbbox exists.")] }
        : { summary: "Docker 29.8 on pc-1", checkedAt: at, checks: [ok("relay", "BB machine pc-1", "Connected; Docker answers through BB."), ok("daemon", "Docker", "29.8.1, 16 cores, 93 GiB."), ok("images", "Images", "bbbox/linux:1 is built.")] };
    case "microsandbox":
      return { summary: "msb 0.7.7 on mac-1", checkedAt: at, checks: [ok("host", "Host mac-1", "Answers over SSH; macOS on Apple silicon."), ok("msb", "msb", "0.7.7, installed by bb-box."), ok("images", "Images", "bbbox/linux:1-arm64 is imported.")] };
    case "proxmox-qemu":
      return { summary: "Proxmox VE 9.2 on pve-1", checkedAt: at, checks: [ok("api", "Proxmox API", "Uses Proxmox LXC's connection."), ok("t9104", "Windows template 9104", "Built 20 October."), ok("t9105", "Linux template 9105", "Built 24 October; /dev/kvm off."), ok("t9106", "Android template 9106", "Built 22 October; Pixel 8 and Pixel Fold booted once.")] };
    case "hetzner":
      return { summary: "No host now · 4.10 EUR this month", checkedAt: at, checks: [ok("token", "API token", "Reads and writes the project."), ok("spend", "Spend", "4.10 EUR of 20 EUR this month."), ok("image", "Host image", "Snapshot of ubuntu-26.04 built 27 October.")] };
    default:
      return { summary: "Namespace answers", checkedAt: at, checks: [ok("token", "API token", "Valid for the workspace."), ok("machines", "Machines", "None now, at most 2.")] };
  }
}

export const TART_PROBLEM: Health = {
  summary: "mac-1 does not answer",
  checkedAt: NOW - 4 * 60_000,
  checks: [
    { id: "mac", name: "Mac mac-1", status: "fail", detail: "No answer over SSH at 192.0.2.30:22 for 30 s.", fix: "Check that mac-1 is on, awake and on the network, then check again." },
    { id: "vms", name: "VMs", status: "skipped", detail: "Skipped, as the Mac does not answer." },
    { id: "memory", name: "Memory", status: "skipped", detail: "Skipped, as the Mac does not answer." },
    { id: "images", name: "Images", status: "skipped", detail: "Skipped, as the Mac does not answer." },
  ],
};

export function offersOf(backend: BackendConfig): string[] {
  const driver = driverOf(backend.type);
  if (backend.type === "proxmox-qemu") return ["windows-desktop", "linux", "android"];
  if (backend.type === "ssh-pool") return ["linux", "macos", "macos-desktop", "ios"];
  if (backend.type === "tart") return ["macos", "macos-desktop", "linux-arm64", "windows-arm64-desktop", "ios"];
  if (backend.type === "microsandbox") return ["linux-arm64"];
  if (backend.id === "docker:pc-1") return ["linux", "linux-desktop-cpu"];
  if (backend.type === "docker") return ["linux", "linux-desktop-cpu", "linux-desktop-wayland-cpu"];
  if (backend.type === "hetzner") return ["linux", "linux-desktop-cpu", "linux-desktop-wayland-cpu", "linux-arm64"];
  return [...driver.kinds];
}

export const BOX_COUNTS: Record<string, number> = { "proxmox-lxc": 4, tart: 1, "ssh-pool": 1, "microsandbox:mac-1": 1, "proxmox-qemu": 1 };

export const DOCKER_MACHINES: readonly DockerMachine[] = [
  { id: "host_pc1example", name: "pc-1", docker: "29.8.1", facts: "16 cores · 93 GiB memory", connected: true },
  { id: "host_pc2example", name: "pc-2", docker: "29.8.1", facts: "64 cores · 128 GiB memory", connected: true },
  { id: "host_pc3example", name: "pc-3", docker: "28.1.1", facts: "8 cores · 32 GiB memory", connected: true, fault: "Docker answers, but cannot start a container: permission denied on /var/run/docker.sock. Add BB's user on pc-3 to the docker group, then check again." },
  { id: "host_bb1example", name: "bb-1", docker: null, facts: "", connected: true },
  { id: "host_mac1example", name: "mac-1", docker: null, facts: "", connected: true },
  { id: "host_mac2example", name: "mac-2", docker: null, facts: "", connected: true },
  { id: "host_build1example", name: "build-1", docker: null, facts: "", connected: true },
];

export const STANDARD_IMAGES: readonly StandardImage[] = [
  { name: "Linux template 9100", backend: "Proxmox LXC on pve-1", age: "4 days", due: null, last: "Rebuilt last night", lastState: "refreshed" },
  { name: "GPU desktop template 9101", backend: "Proxmox LXC on pve-1", age: "4 days", due: null, last: "Rebuilt last night", lastState: "refreshed" },
  { name: "bbbox/linux:1", backend: "Docker on docker-1", age: "9 days", due: "over a week old", last: "Waited last night: docker-1 had no room", lastState: "waiting" },
  { name: "bb-box-macos", backend: "Tart on mac-1", age: "16 days", due: "macOS 26.1 is out", last: "Failed last night: Tart could not clone it, as mac-1's disk was full", lastState: "failed" },
  { name: "Windows template 9104", backend: "Proxmox QEMU on pve-1", age: "8 days", due: null, last: "Skipped last night: built within the week", lastState: "skipped" },
];

export const SETUP_GROUPS: readonly { readonly title: string; readonly description: string; readonly types: readonly string[] }[] = [
  { title: "On this server or a machine you have", description: "Needs Docker, or a Linux host with KVM, or a Mac.", types: ["docker", "microsandbox", "ssh-pool"] },
  { title: "On a Proxmox VE host", description: "Linux containers and VMs, Windows and Android, with GPU desktops.", types: ["proxmox-lxc", "proxmox-qemu"] },
  { title: "On your Macs with Apple silicon", description: "macOS, iOS Simulator, and Linux and Windows on arm64.", types: ["tart"] },
  { title: "In the cloud, paid by use", description: "Machines made when a box needs one and deleted after.", types: ["hetzner", "namespace"] },
];

export const NEEDS: Record<string, string> = {
  docker: "Docker on BB's server, a host over SSH, or a BB machine.",
  microsandbox: "A Linux host with KVM, or a Mac. bb-box installs msb.",
  "ssh-pool": "Linux machines or Macs you can reach over SSH, set up with setup.sh.",
  "proxmox-lxc": "A Proxmox VE host and four setup scripts run on it.",
  "proxmox-qemu": "Proxmox LXC set up first, and a template from build.sh.",
  tart: "A Mac with Apple silicon, Tart, and an image from prepare-image.sh.",
  hetzner: "A Hetzner Cloud project and a Read & Write API token.",
  namespace: "A Namespace workspace and a token from nsc token create.",
};

export const SETUP_WORDS: Record<string, string> = {
  docker: "Linux boxes, with or without a desktop.",
  microsandbox: "Light Linux boxes as microVMs.",
  "ssh-pool": "Your own Linux machines and Macs.",
  "proxmox-lxc": "Linux boxes and GPU desktops.",
  "proxmox-qemu": "Windows, Android and Linux VMs.",
  tart: "macOS, iOS Simulator and arm64 boxes.",
  hetzner: "Linux boxes on cloud hosts.",
  namespace: "Macs and Linux machines by the minute.",
};
