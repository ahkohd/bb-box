import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { startMacInput } from "../../core/mac-input.ts";
import { joinScript, leaveScript, tailnetHostname, type Tailnet } from "../../core/tailnet.ts";
import { formatMiB } from "../../core/sizes.ts";
import { MAC_STREAM, MAC_VIDEO, macStreamCommand } from "../mac-stream.ts";
import { CUA_SHA256, CUA_VERSION } from "../tart/backend.ts";
import { qemuVideoSource } from "../tart/qemu-video.ts";
import { KeyFile, Ssh, SshTransport } from "../../transports/ssh.ts";
import type { SshAccess } from "../../transports/types.ts";
import {
  BackendError,
  DEVICE_DISPLAY,
  type MacEncoder,
  type AcquireHooks,
  type Backend,
  type BackendContext,
  type BoxGrants,
  type BoxIdentity,
  type BoxKind,
  type GrantAnswer,
  type GrantRequest,
  type MachineSize,
  type BoxTransports,
  type Capacity,
  type CommandCapability,
  type DoctorCheck,
  type DoctorReport,
  type Guest,
  type GuestFact,
  type HeldGuest,
  type OwnImage,
  type PowerState,
  type ReleaseHooks,
  type CopyHooks,
  type GuestIdentity,
  type HeldSnapshot,
  type SnapshotHooks,
  type SnapshotPlan,
  type SnapshotRef,
  type SnapshotTake,
  type SnapshotTaken,
  type Snapshotting,
  type Started,
  type TaskOutcome,
  type TaskRef,
} from "../types.ts";
import { MacProbeCache, PROBE_TIMEOUT_MS, capabilityCheck, capabilityWords, eachKindOfMacWords, macsVary, measuredByOlderProbe, type MacReport } from "../../core/mac-capabilities.ts";
import { NamespaceMacReports } from "./mac-reports.ts";
import { NAMESPACE_HOST_ROLE, NamespaceHosts, namespaceSlotOf } from "./ios-hosts.ts";
import { NAMESPACE_IOS_HOSTS_DEFAULTS } from "./config.ts";
import { setupDir } from "../setup-dir.ts";
import { NamespaceApi, NamespaceError, type Instance, type InstanceShape, type NamespaceFetch, type PlatformConcurrency } from "./api.ts";
import type { MacShape, NamespaceConfig, NamespaceKind } from "./config.ts";
import { LINUX_IMAGE_TARGETS, LinuxImages, type LinuxImageDeps } from "./linux-images.ts";
import { NamespaceLinux, isLinuxKind, linuxShapeFor, namespaceOffer, snapshotStorageOnMachine, withMachineDeadline } from "./linux.ts";
import { containerName, type DockerBackend } from "../docker/backend.ts";
import { isBoxContainerName, snapshotLinesOf } from "../docker/snapshots.ts";
import type { DockerBackendOptions } from "../docker/backend.ts";
import type { DockerCli } from "../docker/cli.ts";
import { storedKeyPair } from "../ssh-key.ts";
import { PRODUCT } from "../../brand.ts";
import { BACKEND_LABEL, INSTALL_LABEL, NamespaceOwner } from "./owner.ts";
import { MacVmHelper, macVmHelperCommand, type MacGrantState, type MacHelperAnswer } from "../mac-vm-helper.ts";
import { NamespaceGrantReports, grantCheck } from "./grant-reports.ts";

export const LABELS = {
  install: INSTALL_LABEL,
  backend: BACKEND_LABEL,
  box: "bbbox-box",
  thread: "bbbox-thread",
  name: "bbbox-name",
  kind: "bbbox-kind",
  created: "bbbox-created",
  role: "bbbox-role",
} as const;

export const KEEP_AHEAD_MS = 60 * 60_000;
export const MEASURE_ROLE = "measure";
export const MEASURE_LIFE_MS = 20 * 60_000;
export const MEASURE_AGAIN_AFTER_MS = 24 * 60 * 60_000;
const MEASURE_TRIED = "measure-afresh-tried";
const MEASURE_MARGIN_MS = 5 * 60_000;
const READY_TIMEOUT_MS = 5 * 60_000;
const SSH_POLL_MS = 2_000;
const SSH_KEY = "ssh-key";
const LARGEST_MACHINE = "largest-machine";
const USAGE_GRANT = '{"resource_type":"tenant/usage","resource_id":"*","actions":["get"]}';
const LARGEST_ALLOWED = /maximum ([0-9]+)x([0-9]+)/;
const KEEP_UNREACHABLE_ENGINE_ALIVE_MS = 60 * 60_000;
const RELEASED_WHY = "bb-box: the box was released";

function linuxTooBig(size: MachineSize): string {
  return `Namespace's Linux machines have at most 32 cores and 56 GB of memory, less than the ${size.cores} cores and ${Math.round(size.memoryMiB / MIB_PER_GB)} GiB asked for.`;
}

function largestWithin(concurrency: PlatformConcurrency): MacShape | null {
  const fits = MACOS_SHAPES.filter((shape) => shape.cores <= concurrency.maxCores && shape.memoryGB * MIB_PER_GB <= concurrency.maxMemoryMiB);
  return fits.sort((a, b) => b.cores * 100 + b.memoryGB - (a.cores * 100 + a.memoryGB))[0] ?? null;
}

function workspaceFullFor(shape: MacShape, concurrency: PlatformConcurrency): string | null {
  const freeCores = concurrency.maxCores - concurrency.usedCores;
  const freeMemoryMiB = concurrency.maxMemoryMiB - concurrency.usedMemoryMiB;
  if (shape.cores <= freeCores && shape.memoryGB * MIB_PER_GB <= freeMemoryMiB) return null;
  return `Namespace's workspace has ${concurrency.usedCores} of its ${concurrency.maxCores} Mac cores and ${Math.round(concurrency.usedMemoryMiB / MIB_PER_GB)} of its ${Math.round(concurrency.maxMemoryMiB / MIB_PER_GB)} GB of Mac memory in use, and this box needs a ${shape.cores}x${shape.memoryGB} Mac. Release a Mac box, or wait for one to end.`;
}

function largestAllowedIn(message: string): MacShape | null {
  const match = LARGEST_ALLOWED.exec(message);
  return match ? { cores: Number(match[1]), memoryGB: Number(match[2]) } : null;
}
const SCREEN_SHARING_PORT = 5900;
const MAC_DESKTOP_CLIENTS = ["/opt/namespace/vmguest", "/usr/bin/osascript", MAC_STREAM];
const SCREEN_CAPTURE_CLIENTS = ["/opt/namespace/vmguest", MAC_STREAM, "com.trycua.driver"];
const MAC_DESKTOP_SERVICES = ["kTCCServiceScreenCapture", "kTCCServiceAccessibility", "kTCCServicePostEvent"];
const MAC_DESKTOP = [
  "set -eu",
  'export PATH="$PATH:/opt/homebrew/bin"',
  'work=$(mktemp -d); trap \'rm -rf "$work"\' EXIT',
  'ffmpeg_install=; [ -x /opt/homebrew/bin/ffmpeg ] || { HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install --quiet ffmpeg >"$work/ffmpeg.log" 2>&1 & ffmpeg_install=$!; }',
  'cat > "$work/stream.swift"',
  'xcrun swiftc -O -swift-version 5 -o "$work/bb-box-stream" "$work/stream.swift" >"$work/build.log" 2>&1 || { tail -n 5 "$work/build.log" >&2; exit 1; }',
  `sudo -n mkdir -p ${"$(dirname " + MAC_STREAM + ")"}`,
  `sudo -n install -m 0755 "$work/bb-box-stream" ${MAC_STREAM}`,
  'db="/Library/Application Support/com.apple.TCC/TCC.db"; now=$(date +%s)',
  ...MAC_DESKTOP_CLIENTS.flatMap((client) =>
    MAC_DESKTOP_SERVICES.map(
      (service) =>
        `sudo -n sqlite3 "$db" "DELETE FROM access WHERE service = '${service}' AND client = '${client}'; INSERT INTO access (service, client, client_type, auth_value, auth_reason, auth_version, csreq, policy_id, indirect_object_identifier_type, indirect_object_identifier, indirect_object_code_identity, flags, last_modified, pid, pid_version, boot_uuid, last_reminded) VALUES ('${service}', '${client}', 1, 2, 4, 1, NULL, NULL, 0, 'UNUSED', NULL, 0, $now, NULL, NULL, 'UNUSED', $now);"`,
    ),
  ),
  'replayd="$HOME/Library/Group Containers/group.com.apple.replayd"; year=$(date -u +%Y)',
  'mkdir -p "$replayd" && chmod 700 "$replayd"',
  `{ printf '%s' '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>'; for client in ${SCREEN_CAPTURE_CLIENTS.join(" ")}; do printf '%s' "<key>$client</key><dict><key>kScreenCaptureAlertableUsageCount</key><integer>1</integer><key>kScreenCaptureApprovalLastAlerted</key><date>$(date -u +%Y-%m-%dT%H:%M:%SZ)</date><key>kScreenCaptureApprovalLastUsed</key><date>$(date -u +%Y-%m-%dT%H:%M:%SZ)</date><key>kScreenCapturePrivacyHintDate</key><date>$((year + 5))-01-01T00:00:00Z</date><key>kScreenCapturePrivacyHintPolicy</key><integer>2592000</integer></dict>"; done; printf '%s\\n' '</dict></plist>'; } > "$replayd/ScreenCaptureApprovals.plist"`,
  'chmod 600 "$replayd/ScreenCaptureApprovals.plist"',
  "killall -u \"$(id -un)\" replayd 2>/dev/null || :",
  "sudo -n pmset -a displaysleep 0 sleep 0 >/dev/null",
  "caffeinate -u -t 1",
  '[ -z "$ffmpeg_install" ] || wait "$ffmpeg_install" || { echo "Homebrew could not install ffmpeg, which box_record needs:" >&2; tail -n 3 "$work/ffmpeg.log" >&2; }',
].join("\n");
const CUA_ARCHIVE = `cua-driver-rs-${CUA_VERSION}-darwin-arm64`;
const CUA_APP = "/Applications/CuaDriver.app";
const CUA_SOCKET = "/Users/runner/Library/Caches/cua-driver/cua-driver.sock";
const CUA_AGENT = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.trycua.cua-driver</string>
<key>ProgramArguments</key><array><string>${CUA_APP}/Contents/MacOS/cua-driver</string><string>serve</string></array>
<key>EnvironmentVariables</key><dict>
<key>CUA_DRIVER_RS_TELEMETRY_ENABLED</key><string>false</string>
<key>CUA_DRIVER_RS_UPDATE_CHECK</key><string>false</string>
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ProcessType</key><string>Interactive</string>
</dict></plist>`;
export const MAC_CUA = [
  "set -eu",
  'export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"',
  'work=$(mktemp -d); trap \'rm -rf "$work"\' EXIT',
  `curl -fsSL --retry 3 -o "$work/cua.tgz" "https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_VERSION}/${CUA_ARCHIVE}.tar.gz" || { echo "Could not download Cua Driver ${CUA_VERSION}." >&2; exit 1; }`,
  `echo "${CUA_SHA256}  $work/cua.tgz" | shasum -a 256 -c --quiet - >/dev/null 2>&1 || { echo "Cua Driver's archive does not match its pin." >&2; exit 1; }`,
  'tar -xzf "$work/cua.tgz" -C "$work"',
  `sudo -n rm -rf ${CUA_APP}`,
  `sudo -n cp -R "$work/${CUA_ARCHIVE}/CuaDriver.app" /Applications/`,
  "sudo -n mkdir -p /usr/local/bin",
  `sudo -n ln -sf ${CUA_APP}/Contents/MacOS/cua-driver /usr/local/bin/cua-driver`,
  "CUA_DRIVER_RS_TELEMETRY_ENABLED=false cua-driver telemetry disable >/dev/null 2>&1 || :",
  `requirement=$(codesign -d -r- ${CUA_APP} 2>&1 | sed -n 's/^designated => //p' | head -n 1)`,
  '[ -n "$requirement" ] || { echo "Cua Driver has no code requirement." >&2; exit 1; }',
  'printf \'%s\' "$requirement" | csreq -r- -b "$work/cua.csreq"',
  'csreq=$(xxd -p "$work/cua.csreq" | tr -d \'\\n\')',
  'db="/Library/Application Support/com.apple.TCC/TCC.db"; now=$(date +%s)',
  ...["kTCCServiceAccessibility", "kTCCServiceScreenCapture"].map(
    (service) =>
      `sudo -n sqlite3 "$db" "DELETE FROM access WHERE service = '${service}' AND client = 'com.trycua.driver'; INSERT INTO access (service, client, client_type, auth_value, auth_reason, auth_version, csreq, policy_id, indirect_object_identifier_type, indirect_object_identifier, indirect_object_code_identity, flags, last_modified, pid, pid_version, boot_uuid, last_reminded) VALUES ('${service}', 'com.trycua.driver', 0, 2, 4, 1, X'$csreq', NULL, 0, 'UNUSED', NULL, 0, $now, NULL, NULL, 'UNUSED', $now);"`,
  ),
  'agent="$HOME/Library/LaunchAgents/com.trycua.cua-driver.plist"',
  'mkdir -p "$HOME/Library/LaunchAgents"',
  `cat > "$agent" <<'PLIST'\n${CUA_AGENT}\nPLIST`,
  'sudo -n launchctl bootstrap "gui/$(id -u)" "$agent"',
  'socket="$HOME/Library/Caches/cua-driver/cua-driver.sock"',
  'i=0; until [ -S "$socket" ]; do i=$((i + 1)); [ "$i" -lt 60 ] || { echo "Cua Driver did not listen at $socket within 30 s." >&2; exit 1; }; sleep 0.5; done',
  'permissions=$(cua-driver permissions status --json 2>&1) || { echo "Cua Driver did not say its permissions: $permissions" >&2; exit 1; }',
  'printf \'%s\' "$permissions" | grep -q \'"accessibility": *true\' && printf \'%s\' "$permissions" | grep -q \'"screen_recording": *true\' || { echo "Cua Driver lacks Accessibility or Screen Recording: $permissions" >&2; exit 1; }',
].join("\n");
const STALE_DEVICE_MS = 15 * 60_000;
const LINUX_READY_TIMEOUT_MS = 30 * 60_000;
const LINUX_TAILSCALE = [
  "set -eu",
  "if ! command -v tailscale >/dev/null; then",
  '  work=$(mktemp -d); trap \'rm -rf "$work"\' EXIT',
  '  tarball=$(curl -fsSL "https://pkgs.tailscale.com/stable/?mode=json" | sed -n \'s/.*"amd64": *"\\(tailscale_[^"]*_amd64\\.tgz\\)".*/\\1/p\' | head -n 1)',
  '  [ -n "$tarball" ] || { echo "Tailscale\'s download page named no amd64 build." >&2; exit 1; }',
  '  curl -fsSL "https://pkgs.tailscale.com/stable/$tarball" | tar -xzf - -C "$work"',
  '  install -m 0755 "$work"/tailscale_*/tailscale "$work"/tailscale_*/tailscaled /usr/local/bin/',
  "fi",
  "mkdir -p /var/lib/tailscale /var/run/tailscale",
  'pgrep -x tailscaled >/dev/null || { nohup tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock >/var/log/tailscaled.log 2>&1 </dev/null & }',
  "for attempt in 1 2 3 4 5 6 7 8 9 10; do [ -S /var/run/tailscale/tailscaled.sock ] && break; sleep 1; done",
].join("\n");
const MAC_TAILSCALE = [
  "set -eu",
  'export PATH="$PATH:/opt/homebrew/bin"',
  "command -v tailscale >/dev/null || HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install --quiet tailscale >/dev/null",
  'pgrep -x tailscaled >/dev/null || sudo -n sh -c "mkdir -p /var/lib/tailscale; $(command -v tailscaled) --state=/var/lib/tailscale/tailscaled.state --socket=/var/run/tailscaled.socket >/var/log/tailscaled.log 2>&1 </dev/null &"',
  "for attempt in 1 2 3 4 5 6 7 8 9 10; do tailscale status >/dev/null 2>&1 && break; [ -S /var/run/tailscaled.socket ] && break; sleep 1; done",
].join("\n");
const MIB_PER_GB = 1024;

const SSH_COMMAND: CommandCapability = { transport: "ssh", shell: "sh", admin: true, inDesktopSession: false, streaming: true };
const SLOT_COMMAND: CommandCapability = { transport: "ssh", shell: "sh", admin: false, inDesktopSession: false, streaming: true };
const HOST_SHAPE: MacShape = { cores: 6, memoryGB: 14 };
const HOST_READY_TIMEOUT_MS = 20 * 60_000;
const HOST_TAILNET_NAME = "ios-host";
const HOST_SETUP_PATHS = ["setup/ssh-pool/mac-ios.sh", "setup/ssh-pool/mac-home/.zshenv", "setup/tart/ios", "setup/android/build-h264.sh", "setup/android/pins.json", "setup/android/bb-box-h264"];

export function hostSetupArchive(setup = setupDir()): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-czf", "-", "-C", dirname(setup.replace(/\/+$/, "")), ...HOST_SETUP_PATHS], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`tar could not pack the shared iOS host's setup: ${stderr.trim() || `exit ${code}`}`))));
  });
}

export const MACOS_SHAPES: readonly { readonly cores: number; readonly memoryGB: number }[] = [
  { cores: 4, memoryGB: 7 },
  { cores: 4, memoryGB: 14 },
  { cores: 6, memoryGB: 14 },
  { cores: 6, memoryGB: 28 },
  { cores: 8, memoryGB: 14 },
  { cores: 8, memoryGB: 28 },
  { cores: 12, memoryGB: 28 },
  { cores: 12, memoryGB: 56 },
  { cores: 16, memoryGB: 28 },
  { cores: 16, memoryGB: 56 },
];

export function macDiskGiB(shape: { readonly cores: number; readonly memoryGB: number }): number {
  return 48 + Math.max(shape.cores, shape.memoryGB / 2) * 8;
}

function macsAllowedBy(largest: MacShape | null): readonly MacShape[] {
  return largest ? MACOS_SHAPES.filter((shape) => shape.cores <= largest.cores && shape.memoryGB <= largest.memoryGB) : MACOS_SHAPES;
}

function largestOf(shapes: readonly MacShape[]): MacShape | null {
  return [...shapes].sort((a, b) => b.cores * 100 + b.memoryGB - (a.cores * 100 + a.memoryGB))[0] ?? null;
}

export function macShapeFor(size: MachineSize, largest: MacShape | null = null): MacShape | null {
  const fits = macsAllowedBy(largest).filter((shape) => shape.cores >= size.cores && shape.memoryGB * MIB_PER_GB >= size.memoryMiB && (size.diskGiB === null || macDiskGiB(shape) >= size.diskGiB));
  return fits.sort((a, b) => a.cores * 100 + a.memoryGB - (b.cores * 100 + b.memoryGB))[0] ?? null;
}

function memoryWords(memoryMiB: number): string {
  return `${formatMiB(memoryMiB)} of memory`;
}

function macWords(shape: MacShape): string {
  return `${shape.cores}x${shape.memoryGB} Mac, with ${shape.cores} cores, ${memoryWords(shape.memoryGB * MIB_PER_GB)} and ${macDiskGiB(shape)} GiB of disk`;
}

function listWords(parts: readonly string[]): string {
  return parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function askedWords(size: MachineSize): string[] {
  return [`${size.cores} cores`, memoryWords(size.memoryMiB), ...(size.diskGiB !== null ? [`${size.diskGiB} GiB of disk`] : [])];
}

function partsOver(size: MachineSize, largest: MacShape): string[] {
  return [
    ...(size.cores > largest.cores ? [`${size.cores} cores`] : []),
    ...(size.memoryMiB > largest.memoryGB * MIB_PER_GB ? [memoryWords(size.memoryMiB)] : []),
    ...(diskOver(size, largest) ? [`${size.diskGiB} GiB of disk`] : []),
  ];
}

function diskOver(size: MachineSize, largest: MacShape): boolean {
  return size.diskGiB !== null && size.diskGiB > macDiskGiB(largest);
}

function clampedTo(size: MachineSize, largest: MacShape): MachineSize {
  return {
    cores: Math.min(size.cores, largest.cores),
    memoryMiB: Math.min(size.memoryMiB, largest.memoryGB * MIB_PER_GB),
    diskGiB: size.diskGiB === null ? null : Math.min(size.diskGiB, macDiskGiB(largest)),
  };
}

function suggestionWords(shape: MacShape, withDisk: boolean): string {
  const parts = [`${shape.cores} cores`, memoryWords(shape.memoryGB * MIB_PER_GB), ...(withDisk ? [`${macDiskGiB(shape)} GiB of disk`] : [])];
  return `Ask for at most ${listWords(parts)}, which gets its ${shape.cores}x${shape.memoryGB} Mac, or use another backend.`;
}

const HOW_TO_ASK_FOR_DISK = " Give the disk with disk_gib, or --disk-gib on the command line.";

function macTooBig(size: MachineSize, workspaceLargest: MacShape | null): string {
  const largest = largestOf(macsAllowedBy(workspaceLargest));
  if (!largest) return `Namespace's workspace allows Macs of at most ${workspaceLargest?.cores} cores and ${workspaceLargest?.memoryGB} GiB of memory, less than its smallest Mac. Use another backend.`;

  const offers = workspaceLargest ? "Namespace's workspace allows" : "Namespace has";
  const over = partsOver(size, largest);
  const needed = macShapeFor(size);
  const instead = macShapeFor(clampedTo(size, largest), workspaceLargest) ?? largest;

  return [
    `The largest Mac ${offers} is its ${macWords(largest)}: less than the ${listWords(over.length ? over : askedWords(size))} asked for`,
    needed ? `, which needs its ${needed.cores}x${needed.memoryGB} Mac.` : ".",
    ` ${suggestionWords(instead, size.diskGiB !== null)}`,
    diskOver(size, largest) ? HOW_TO_ASK_FOR_DISK : "",
  ].join("");
}

export interface NamespaceBackendOptions {
  readonly fetch?: NamespaceFetch;
  readonly sshBinary?: string;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly readyTimeoutMs?: number;
  readonly streamSource?: string;
  readonly desktopScript?: string;
  readonly cuaScript?: string;
  readonly linuxImageScript?: LinuxImageDeps["buildScript"];
  readonly setupArchive?: () => Promise<Buffer>;
  readonly hostSetupArchive?: () => Promise<Buffer>;
  readonly dockerOptions?: DockerBackendOptions;
  readonly dockerCli?: (instance: string) => DockerCli;
  readonly linuxPullScript?: (ref: string, local: string) => string;
  readonly linuxTailscaleScript?: string;
  readonly macHelper?: string;
  readonly macHelperReadyTimeoutMs?: number;
}

function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });
}

function machineNoBoxHolds(machine: HeldGuest): HeldGuest {
  const { box: _box, ...data } = machine.data ?? {};
  return { ...machine, ref: typeof data.instance === "string" ? data.instance : machine.ref, owner: null, data };
}

function tasksOnMachine<Hooks extends SnapshotHooks>(hooks: Hooks, instance: string): Hooks {
  return { ...hooks, task: (task: TaskRef) => hooks.task({ ...task, host: instance }) };
}

function clock(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

export class NamespaceBackend implements Backend {
  readonly id: string;
  readonly label: string;
  readonly nature = "virtual" as const;
  readonly #config: NamespaceConfig;
  readonly #context: BackendContext;
  readonly #options: NamespaceBackendOptions;
  readonly #api: NamespaceApi;
  readonly #owner: NamespaceOwner;
  readonly #keyFile = new KeyFile();
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #placing = new Set<string>();
  readonly #probes: MacProbeCache;
  readonly #reports: NamespaceMacReports;
  readonly #grantReports: NamespaceGrantReports;
  #macHelper: MacVmHelper | null = null;
  #measuringAfresh: { readonly until: number; readonly done: Promise<void> } | null = null;
  readonly slots: NamespaceHosts;
  #ssh: Promise<{ ssh: Ssh; publicKey: string }> | null = null;
  readonly linuxImages: LinuxImages;
  readonly #linux: NamespaceLinux;

  constructor(config: NamespaceConfig, context: BackendContext, options: NamespaceBackendOptions = {}) {
    if (!config.token) throw new BackendError("unsupported", "Namespace has no API token: set it in BB Box's settings.");
    this.#config = config;
    this.#context = context;
    this.#options = options;
    this.id = context.id;
    this.#owner = new NamespaceOwner(context.id, context.installId);
    this.label = this.#owner.name ? `Namespace (${this.#owner.name})` : "Namespace";
    this.#api = new NamespaceApi({ token: config.token, region: config.region, ...(context.log ? { log: (line: string) => context.log!(line) } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) });
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? sleepFor;
    this.linuxImages = new LinuxImages({
      api: this.#api,
      storage: context.storage,
      owner: this.#owner,
      label: this.label,
      now: this.#now,
      publicKey: async () => (await this.#keys()).publicKey,
      answers: (instance, signal) => this.#answers(instance, this.#now() + (options.readyTimeoutMs ?? READY_TIMEOUT_MS), signal),
      run: async (instance, script, stdin, timeoutMs, signal) => new SshTransport((await this.#keys()).ssh, this.#access(instance), "linux").run(script, { stdin, timeoutMs, signal, maxOutputBytes: 1024 * 1024 }),
      bbUrl: () => context.bbUrl?.() ?? null,
      joinTailnet: async (instance, name, signal) => {
        const tailnet = context.tailnet?.() ?? null;
        if (!tailnet) return null;
        await this.#joinAs(instance, name, tailnet, true, signal);
        return () => this.#leaveTailnetAs(instance, name);
      },
      leaveTailnet: (instance, name) => this.#leaveTailnetAs(instance, name),
      sleep: this.#sleep,
      bbApp: async (signal) => (context.bbUrl?.() ? ((await context.images?.bbApp(signal).catch(() => null)) ?? null) : null),
      log: (line) => context.log?.(line),
      ...(options.linuxImageScript ? { buildScript: options.linuxImageScript } : {}),
      ...(options.setupArchive ? { setupArchive: options.setupArchive } : {}),
    });
    this.#reports = new NamespaceMacReports(context.storage, (operation, error) => context.logError(operation, error));
    this.#grantReports = new NamespaceGrantReports(context.storage, (operation, error) => context.logError(operation, error));
    this.#probes = new MacProbeCache({
      run: async (instance, script, signal) => {
        const result = await new SshTransport((await this.#keys()).ssh, this.#access(instance), "macos").run(script, { timeoutMs: PROBE_TIMEOUT_MS, signal, maxOutputBytes: 64 * 1024 });
        if (result.exitCode !== 0 && !result.stdout.trim()) throw new Error(`Namespace's Mac ${instance} did not answer ${PRODUCT}'s probe: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
        return result.stdout;
      },
      saved: (report) => this.#rememberChip(report, report.mac),
      logError: (operation, error) => context.logError(operation, error),
      now: this.#now,
    });
    void this.#reports
      .load()
      .then((reports) => reports.forEach((report) => this.#rememberChip(report, null)))
      .catch((error) => context.logError("read what Namespace's Macs offered", error));
    this.slots = this.#namespaceHosts();
    this.#linux = new NamespaceLinux({
      context,
      images: this.linuxImages,
      keys: () => this.#keys(),
      access: (instance) => this.#access(instance),
      run: async (instance, script, timeoutMs, signal) => new SshTransport((await this.#keys()).ssh, this.#access(instance), "linux").run(script, { timeoutMs, ...(signal ? { signal } : {}) }),
      shareDir: () => this.#keyFile.shareDir(),
      ...(options.dockerOptions ? { dockerOptions: options.dockerOptions } : {}),
      ...(options.dockerCli ? { dockerCli: options.dockerCli } : {}),
      ...(options.linuxPullScript ? { pullScript: options.linuxPullScript } : {}),
    });
  }

  #namespaceHosts(): NamespaceHosts {
    return new NamespaceHosts({
      installId: this.#context.installId,
      backendId: this.id,
      storage: this.#context.storage,
      settings: () => this.#config.iosHosts ?? NAMESPACE_IOS_HOSTS_DEFAULTS,
      longestLifeMs: () => this.#config.longestLifeHours * 3600_000,
      now: () => this.#now(),
      sleep: (ms, signal) => this.#sleep(ms, signal),
      report: () => this.#reports.forOffer(),
      room: (signal) => this.#hostRoom(signal),
      create: async (tag, shape, signal) => {
        const { publicKey } = await this.#keys();
        return this.#api.create(
          {
            shape: { os: "macos", arch: "arm64", cores: shape.cores, memoryMiB: shape.memoryGB * MIB_PER_GB, selectors: { "macos.version": this.#config.macosVersion } },
            labels: { ...this.#owner.labels(), [LABELS.role]: NAMESPACE_HOST_ROLE, [LABELS.created]: String(this.#now()) },
            deadline: this.#now() + KEEP_AHEAD_MS,
            purpose: `${PRODUCT} shared iOS host`,
            uniqueTag: tag,
            sshPublicKeys: [publicKey],
          },
          signal,
        );
      },
      wait: (instance, signal) => this.#api.wait(instance, signal),
      describe: (instance, signal) =>
        this.#api.describe(instance, signal).catch((error: unknown) => {
          if (error instanceof NamespaceError && error.kind === "gone") return null;
          throw error;
        }),
      destroy: (instance, why, signal) => this.#api.destroy(instance, why, signal),
      extend: async (instance, aheadMs, signal) => void (await this.#api.extend(instance, aheadMs, signal)),
      answers: (instance, deadline, signal) => this.#answers(instance, deadline, signal),
      command: async (instance) => new SshTransport((await this.#keys()).ssh, this.#access(instance), "macos"),
      measure: (instance, signal) => this.#probes.measure(instance, signal),
      joinTailnet: async (instance, signal) => {
        const tailnet = this.#context.tailnet?.() ?? null;
        if (tailnet) await this.#joinAs(instance, HOST_TAILNET_NAME, tailnet, false, signal);
      },
      leaveTailnet: (instance) => (this.#context.tailnet?.() ? this.#leaveTailnetAs(instance, HOST_TAILNET_NAME) : Promise.resolve()),
      setupArchive: () => this.#options.hostSetupArchive?.() ?? hostSetupArchive(),
      publicKey: async () => (await this.#keys()).publicKey,
      log: (message) => this.#context.log?.(message),
      logError: (operation, error) => this.#context.logError(operation, error),
    });
  }

  async #hostRoom(signal?: AbortSignal): Promise<{ readonly shape: MacShape | null; readonly words: string | null }> {
    const { concurrency } = await this.#workspaceLimits(signal);
    const largest = await this.#largestMachine(concurrency);
    const shape = largest ?? HOST_SHAPE;
    const fullFor = concurrency ? workspaceFullFor(shape, concurrency) : null;
    if (fullFor) return { shape, words: fullFor };
    const held = await this.#held(signal);
    if (held.length + this.#placing.size >= this.#config.machines) return { shape, words: `${this.label} has ${held.length} of the ${this.#config.machines} machines ${PRODUCT} may have at once.` };
    return { shape, words: null };
  }

  #rememberChip(report: MacReport, measuredOn: string | null): void {
    const lent = this.slots?.lends("ios") ?? false;
    this.#reports.remember(report, measuredOn);
    if (this.slots && this.slots.lends("ios") !== lent) this.#context.kindsChanged?.();
  }

  macCapabilities(): readonly MacReport[] {
    return this.#reports.all();
  }

  #whyMeasureAfresh(): string | null {
    if (this.slots.offerable().ok) return null;
    const reports = this.macCapabilities();
    const older = reports.find(measuredByOlderProbe);
    if (older) return older === reports[0] ? "its last report came from an older probe and cannot make an offer" : `its report of an ${older.chip ?? "unknown chip"} came from an older probe, and no kind of Mac makes an offer`;
    const unsettled = reports.find((report) => report.capabilities.simulator.is === "unknown");
    return unsettled ? `its last measurement of an ${unsettled.chip ?? "unknown chip"} did not finish` : null;
  }

  #measuredWhole(instance: string): boolean {
    const report = this.#probes.report(instance);
    return !!report && report.capabilities.simulator.is !== "unknown";
  }

  async #measureAfreshIfDue(signal?: AbortSignal): Promise<void> {
    if (!(this.#config.iosHosts ?? NAMESPACE_IOS_HOSTS_DEFAULTS).on || this.#measuringAfresh) return;
    const why = this.#whyMeasureAfresh();
    if (!why) return;
    if (await this.slots.record()) return;
    const mac = (await this.#held(signal)).find((instance) => instance.status === "running" && !isLinuxKind(instance.labels[LABELS.kind] ?? "") && !this.#measuredWhole(instance.id));
    if (mac) return void (await this.#probes.measure(mac.id, signal));
    const tried = await this.#context.storage.get<number>(MEASURE_TRIED);
    if (typeof tried === "number" && this.#now() - tried < MEASURE_AGAIN_AFTER_MS) return;
    const room = await this.#hostRoom(signal);
    if (room.words) return;
    await this.#context.storage.set(MEASURE_TRIED, this.#now());
    const until = this.#now() + MEASURE_LIFE_MS;
    this.#measuringAfresh = { until, done: this.#measureOnAMacOfItsOwn(room.shape ?? HOST_SHAPE, until, why)
      .catch((error) => this.#context.logError("measure a Namespace Mac afresh", error))
      .finally(() => (this.#measuringAfresh = null)) };
  }

  async #measureOnAMacOfItsOwn(shape: MacShape, until: number, why: string): Promise<void> {
    const started = this.#now();
    const within = AbortSignal.timeout(MEASURE_LIFE_MS - MEASURE_MARGIN_MS);
    const { publicKey } = await this.#keys();
    this.#context.log?.(`bb-box is starting a ${shape.cores}x${shape.memoryGB} Namespace Mac to measure what Namespace's Macs offer iOS devices afresh, as ${why}. It is destroyed once measured, and by ${clock(until)} at the latest.`);
    const made = await this.#api.create(
      {
        shape: { os: "macos", arch: "arm64", cores: shape.cores, memoryMiB: shape.memoryGB * MIB_PER_GB, selectors: { "macos.version": this.#config.macosVersion } },
        labels: { ...this.#owner.labels(), [LABELS.role]: MEASURE_ROLE, [LABELS.created]: String(this.#now()) },
        deadline: until,
        purpose: `${PRODUCT} measures what Namespace's Macs offer iOS devices`,
        uniqueTag: this.#owner.uniqueTag(`measure-${this.#now()}`),
        sshPublicKeys: [publicKey],
      },
      within,
    );
    const step = (what: string) => this.#context.log?.(`bb-box's Namespace Mac ${made.id}, made to measure afresh: ${what}, ${Math.round((this.#now() - started) / 1000)} s after it was asked for.`);
    step("made");
    try {
      const ready = await this.#api.wait(made.id, within);
      if (ready.status !== "running") throw new Error(`Namespace's machine ${ready.id} is ${ready.status}, not running.`);
      step("running");
      await this.#answers(ready.id, Math.min(until - MEASURE_MARGIN_MS, this.#now() + (this.#options.readyTimeoutMs ?? READY_TIMEOUT_MS)), within);
      step("answering SSH");
      const report = await this.#probes.measure(ready.id, within);
      step(`measured: an ${report.chip ?? "unknown chip"}, ${capabilityWords(report.capabilities)}`);
    } finally {
      await this.#api
        .destroy(made.id, "bb-box: measured what it offers")
        .then(() => step("destroyed"))
        .catch((error) => this.#context.logError(`destroy Namespace machine ${made.id}, made to measure afresh`, error));
    }
  }

  measuringAfreshUntil(): number | null {
    return this.#measuringAfresh?.until ?? null;
  }

  measureMac(instance: string, signal?: AbortSignal): Promise<MacReport> {
    return this.#probes.measure(instance, signal);
  }

  kinds(): readonly BoxKind[] {
    const readyTimeoutMs = this.#options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    return [
      {
        id: "macos",
        label: "macOS",
        description: "A Mac of its own on Namespace, for builds and Apple's tools, with Xcode. It lasts at most the workspace plan's longest life. Its desktop is not shown.",
        requires: [],
        capabilities: { os: "macos", arch: "arm64", gpu: false, features: ["xcode"], command: SSH_COMMAND, displays: [], computerUse: null, enrol: true, device: null },
        readyTimeoutMs,
      },
      {
        id: "macos-desktop",
        label: "macOS desktop",
        description: "A Mac of its own on Namespace, with its desktop shown in the panel, as video or over Screen Sharing, for Apple's tools and apps, with Xcode. It lasts at most the workspace plan's longest life.",
        requires: [],
        capabilities: {
          os: "macos",
          arch: "arm64",
          gpu: false,
          features: ["xcode"],
          command: SSH_COMMAND,
          displays: [{ id: "desktop", protocol: "rfb", resizable: false, clipboard: "commands" }, MAC_VIDEO],
          computerUse: { driver: "cua", version: CUA_VERSION, socket: CUA_SOCKET },
          enrol: true,
          device: null,
        },
        readyTimeoutMs,
      },
      ...this.#linux.kinds(this.#options.readyTimeoutMs ?? LINUX_READY_TIMEOUT_MS),
      ...this.#iosKind(),
    ];
  }

  offerNote(kind: string): string | null {
    return kind === "ios" && this.slots.lends("ios") ? this.slots.offerNote() : null;
  }

  #iosKind(): BoxKind[] {
    if (!this.slots.lends("ios")) return [];
    const offered = this.slots.offerable();
    if (!offered.ok) return [];
    return [
      {
        id: "ios",
        label: "iOS Simulator",
        description:
          "An iOS Simulator device, in a macOS user of its own on a Namespace Mac shared with other ios boxes, for installing, running and testing iOS apps, with its screen shown in the panel. The Mac is made for the first such box and lives until its last goes, at most the workspace plan's longest life less an hour. Commands run on the Mac as that user, with Xcode; simctl takes booted as the device. No sudo, Homebrew installs or app windows.",
        requires: [],
        slotsOnly: true,
        capabilities: { os: "macos", arch: "arm64", gpu: false, features: [], command: SLOT_COMMAND, displays: [DEVICE_DISPLAY], computerUse: null, enrol: true, device: offered.device },
        readyTimeoutMs: this.#options.readyTimeoutMs ?? HOST_READY_TIMEOUT_MS,
      },
    ];
  }

  async capacity(kind: string, size: MachineSize, pending: readonly { readonly kind: string; readonly size: MachineSize }[], signal?: AbortSignal): Promise<Capacity> {
    if (kind === "ios") return { ok: false, message: "Namespace lends ios boxes only as slots on a shared iOS host, each a macOS user with its own device.", warm: null, hosts: [{ host: this.label, ok: false, limits: [] }] };
    this.#kind(kind);
    const host = this.label;
    if (isLinuxKind(kind) && !linuxShapeFor(size)) return { ok: false, message: linuxTooBig(size), warm: null, hosts: [{ host, ok: false, limits: [] }] };
    const { concurrency } = isLinuxKind(kind) ? { concurrency: null } : await this.#workspaceLimits(signal);
    const largest = isLinuxKind(kind) ? null : await this.#largestMachine(concurrency);
    const shape = isLinuxKind(kind) ? linuxShapeFor(size) : macShapeFor(size, largest);
    if (!shape) return { ok: false, message: macTooBig(size, largest), warm: null, hosts: [{ host, ok: false, limits: [] }] };
    const measuring = this.measuringAfreshUntil();
    const hostWords = this.slots.known()?.instance
      ? " A shared iOS host for ios boxes holds Namespace's Mac now, until its last box goes."
      : measuring !== null
        ? ` ${PRODUCT} is measuring what Namespace's Macs offer on one now, until ${clock(measuring)} at the latest.`
        : "";
    const fullFor = concurrency ? workspaceFullFor(shape, concurrency) : null;
    if (fullFor) return { ok: false, message: `${fullFor}${hostWords}`, warm: null, hosts: [{ host, ok: false, limits: [{ resource: "cpu", used: concurrency!.usedCores, total: concurrency!.maxCores, reserve: 0, unit: "count" }] }] };
    let held: Instance[];
    try {
      held = await this.#api.list({ [LABELS.install]: null }, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      return { ok: false, message: `Namespace did not answer: ${error instanceof Error ? error.message : String(error)}`, warm: null, hosts: [{ host, ok: false, limits: [] }] };
    }
    held = held.filter((instance) => !instance.labels[LABELS.role] && !this.#owner.madeByAnotherBackendOfThisInstall(instance.labels));
    const used = held.length + Math.max(this.#placing.size, pending.length);
    const ok = used < this.#config.machines;
    return {
      ok,
      message: ok ? null : `${this.label} has ${held.length} of the ${this.#config.machines} machines ${PRODUCT} may have at once, counting other ${PRODUCT} installs' in the workspace. Release a box, or raise the most machines in BB Box's settings.`,
      warm: null,
      hosts: [{ host, ok, limits: [{ resource: "machines", used, total: this.#config.machines, reserve: 0, unit: "count" }] }],
    };
  }

  async acquire(box: BoxIdentity, previous: Guest | null, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest> {
    if (previous && namespaceSlotOf(previous)) return this.slots.acquire(box, previous, hooks, signal);
    const kind = this.#kind(box.kind);
    const linux = isLinuxKind(kind) ? kind : null;
    const largest = linux ? null : await this.#largestMachine((await this.#workspaceLimits(signal)).concurrency);
    const shape = linux ? linuxShapeFor(box.size) : macShapeFor(box.size, largest);
    if (!shape) throw new BackendError("no_capacity", linux ? linuxTooBig(box.size) : macTooBig(box.size, largest));
    const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      try {
        return await run();
      } finally {
        hooks.timing(name, Math.round(performance.now() - started));
      }
    };
    const tag = this.#tag(box.boxId);
    const claimed = (instance: Instance | null): Guest => this.#guest(linux ? this.#linux.ref(box.boxId) : tag, box.boxId, instance, shape, linux !== null);
    this.#placing.add(box.boxId);
    let made: Instance | null = previous?.data?.instance && typeof previous.data.instance === "string" ? await this.#api.describe(previous.data.instance, signal).catch(() => null) : null;
    try {
      await hooks.claim(claimed(null));
      const { publicKey } = await this.#keys();
      const instanceShape: InstanceShape = linux
        ? { os: "linux", arch: "amd64", cores: shape.cores, memoryMiB: shape.memoryGB * MIB_PER_GB }
        : { os: "macos", arch: "arm64", cores: shape.cores, memoryMiB: shape.memoryGB * MIB_PER_GB, selectors: { "macos.version": this.#config.macosVersion } };
      made = await step("create", () =>
        this.#api.create(
          {
            shape: instanceShape,
            labels: this.#labels(box, kind),
            deadline: this.#now() + KEEP_AHEAD_MS,
            purpose: `bb-box ${box.kind} box ${box.name}`,
            uniqueTag: tag,
            sshPublicKeys: [publicKey],
          },
          signal,
        ),
      );
      await hooks.claim(claimed(made));
      await hooks.starting();
      const ready = await step("ready", () => this.#api.wait(made!.id, signal));
      if (ready.status !== "running") throw new Error(`Namespace's machine ${ready.id} is ${ready.status}, not running.`);
      await step("ssh", () => this.#answers(ready.id, this.#now() + (this.#options.readyTimeoutMs ?? READY_TIMEOUT_MS), signal));
      if (!linux) await step("grants", () => this.#readyGrants(ready.id, signal));
      if (kind === "macos-desktop") {
        await step("desktop", () => this.#prepareDesktop(ready.id, signal));
        await step("computer use", () => this.#prepareComputerUse(ready.id, signal));
      }
      const tailnet = this.#context.tailnet?.() ?? null;
      if (tailnet) await step("tailnet", () => this.#join(ready.id, box, tailnet, linux !== null, signal));
      if (linux) {
        const machine = claimed(ready);
        const own = (guest: Guest): Guest => ({ ...machine, ...guest, ref: this.#linux.ref(box.boxId), host: ready.continent ?? null, size: machine.size, data: { ...guest.data, box: box.boxId, instance: ready.id }, facts: [...(machine.facts ?? []), ...(guest.facts ?? [])] });
        return await this.#linux.boxOn(ready.id, shape.memoryGB * MIB_PER_GB, box, linux, hooks, own, step, signal);
      }
      const guest = claimed(ready);
      await hooks.claim(guest);
      void this.#probes.measure(ready.id).catch((error) => this.#context.logError(`measure what Namespace's Mac ${ready.id} offers`, error));
      return guest;
    } catch (error) {
      const instance = made?.id ?? (await this.#find(box.boxId).catch(() => null))?.id;
      if (instance) await this.#api.destroy(instance, "bb-box: the box did not start").catch((cause) => this.#context.logError("destroy after a failed acquire", cause));
      const allowed = error instanceof NamespaceError ? largestAllowedIn(error.message) : null;
      if (allowed) {
        await this.#context.storage.set(LARGEST_MACHINE, allowed);
        throw new BackendError("no_capacity", macTooBig(box.size, allowed));
      }
      if (error instanceof NamespaceError && error.kind === "full") throw new BackendError("no_capacity", error.message);
      throw error;
    } finally {
      this.#placing.delete(box.boxId);
    }
  }

  async release(guest: Guest, hooks: ReleaseHooks, signal?: AbortSignal): Promise<void> {
    const started = performance.now();
    if (namespaceSlotOf(guest)) {
      await this.slots.release(guest, signal);
      hooks.timing("release", Math.round(performance.now() - started));
      return;
    }
    const instance = await this.#mine(guest, signal);
    if (!instance) return hooks.timing("destroy", Math.round(performance.now() - started));
    if (hooks.scope === "whole-box") await this.#linux.markReleasingTheBox(instance.id);
    if (await this.#onlyThisContainerGoes(instance, guest, hooks, signal)) {
      hooks.timing("remove container", Math.round(performance.now() - started));
      return;
    }
    await this.#destroyMachine(instance, signal);
    hooks.timing("destroy", Math.round(performance.now() - started));
  }

  async #destroyMachine(instance: Instance, signal?: AbortSignal): Promise<void> {
    if (instance.status === "running" && this.#context.tailnet?.()) await this.#leave(instance.id, signal);
    await this.#api.destroy(instance.id, RELEASED_WHY, signal);
    await this.#linux.forget(instance.id);
    await this.#forget(instance.id);
  }

  async power(guest: Guest, signal?: AbortSignal): Promise<PowerState | null> {
    if (namespaceSlotOf(guest)) return this.slots.power(guest, signal);
    const described = await this.#mine(guest, signal);
    if (!described || described.status === "destroyed" || described.status === "destroying") return null;
    if (described.status === "running" && (await this.#boxLivesInAContainer(described, guest))) return (await this.#linux.part(described.id)).power(guest, signal);
    if (described.status === "running") return "running";
    if (described.status === "suspended") return "stopped";
    return "unknown";
  }

  async held(signal?: AbortSignal): Promise<HeldGuest[]> {
    const slots = await this.slots.held(signal);
    const machines = (await this.#held(signal)).map((instance): HeldGuest => {
      const boxId = instance.labels[LABELS.box] ?? null;
      const created = Number(instance.labels[LABELS.created]);
      const owner =
        boxId && instance.labels[LABELS.thread]
          ? {
              boxId,
              threadId: instance.labels[LABELS.thread]!,
              name: instance.labels[LABELS.name] ?? null,
              kind: instance.labels[LABELS.kind] ?? null,
              createdAt: Number.isFinite(created) ? created : null,
            }
          : null;
      const shape = instance.shape ? { cores: instance.shape.cores, memoryGB: Math.round(instance.shape.memoryMiB / MIB_PER_GB) } : null;
      return { ...this.#guest(this.#refOf(instance), boxId, instance, shape, isLinuxKind(instance.labels[LABELS.kind] ?? "")), owner, power: instance.status === "running" ? "running" : instance.status === "suspended" ? "stopped" : "unknown" };
    });
    const withSnapshots = new Set(await this.#linux.machinesWithSnapshots());
    const releasing = new Set(await this.#linux.machinesReleasingTheirBox());
    const listed: HeldGuest[] = [];
    for (const machine of machines) {
      const instance = typeof machine.data?.instance === "string" ? machine.data.instance : null;
      if (instance && releasing.has(instance)) {
        listed.push(machineNoBoxHolds(machine));
        continue;
      }
      if (!instance || !withSnapshots.has(instance) || machine.power !== "running") {
        listed.push(machine);
        continue;
      }
      try {
        const containers = await this.#containersOfTheBox(instance, machine.owner?.boxId ?? null, signal);
        listed.push(...(containers.length ? containers.map((container) => ({ ...machine, ref: container.ref, power: container.power })) : [machineNoBoxHolds(machine)]));
      } catch (error) {
        if (signal?.aborted) throw error;
        this.#context.logError(`list the containers on Namespace machine ${instance}; ${PRODUCT} leaves it as it is and asks again at its next sweep`, error);
      }
    }
    return [...slots, ...listed];
  }

  async #boxLivesInAContainer(machine: Instance, guest: Guest): Promise<boolean> {
    return typeof guest.data?.box === "string" && isLinuxKind(machine.labels[LABELS.kind] ?? "") && (await this.#linux.snapshotsTakenOn(machine.id));
  }

  async #containersOfTheBox(instance: string, boxId: string | null, signal?: AbortSignal): Promise<readonly HeldGuest[]> {
    const part = await this.#linux.part(instance);
    return (await part.held(signal)).filter((container) => boxId !== null && container.owner?.boxId === boxId);
  }

  async #onlyThisContainerGoes(instance: Instance, guest: Guest, hooks: ReleaseHooks, signal?: AbortSignal): Promise<boolean> {
    if (hooks.scope === "whole-box" || (await this.#linux.releasingTheBox(instance.id))) return false;
    const boxId = typeof guest.data?.box === "string" ? guest.data.box : null;
    if (!boxId || !isLinuxKind(instance.labels[LABELS.kind] ?? "") || !(await this.#linux.snapshotsTakenOn(instance.id)) || instance.status !== "running") return false;
    const others = (await this.#containersOfTheBox(instance.id, boxId, signal)).filter((container) => container.ref !== guest.ref);
    if (!others.length) return false;
    await (await this.#linux.part(instance.id)).release(guest, hooks, signal);
    return true;
  }

  snapshotting(kind: string): Snapshotting | null {
    return isLinuxKind(kind) ? namespaceOffer() : null;
  }

  async start(guest: Guest, signal?: AbortSignal): Promise<Started | void> {
    return (await this.#linuxPart(guest)).start(guest, signal);
  }

  async powerOff(guest: Guest, signal?: AbortSignal): Promise<void> {
    await (await this.#linuxPart(guest)).powerOff(guest, signal);
  }

  async planSnapshots(guest: Guest, kind: string, target: SnapshotRef | null, signal?: AbortSignal): Promise<SnapshotPlan> {
    const plan = await (await this.#linuxPart(guest)).planSnapshots(guest, kind, target, signal);
    return withMachineDeadline(plan, await this.#machineEndsAt(guest, signal), this.#now());
  }

  async #machineEndsAt(guest: Guest, signal?: AbortSignal): Promise<number | null> {
    const machine = await this.#mine(guest, signal).catch((error: unknown) => {
      if (signal?.aborted) throw error;
      return null;
    });
    if (machine?.createdAt != null) return this.#endsAt(machine.createdAt);
    return guest.endsAt ?? null;
  }

  #deadlineOf(machine: Instance): Pick<Guest, "endsAt"> {
    return machine.createdAt === null ? {} : { endsAt: this.#endsAt(machine.createdAt) };
  }

  async snapshot(guest: Guest, take: SnapshotTake, hooks: SnapshotHooks, signal?: AbortSignal): Promise<SnapshotTaken> {
    const instance = this.#instanceOf(guest);
    await this.#linux.markSnapshotsOn(instance, this.#now());
    return (await this.#linux.part(instance)).snapshot(guest, take, tasksOnMachine(hooks, instance), signal);
  }

  async heldSnapshots(signal?: AbortSignal): Promise<readonly HeldSnapshot[]> {
    const all: HeldSnapshot[] = [];
    const withSnapshots = await this.#linux.machinesWithSnapshots();
    if (!withSnapshots.length) return all;
    const running = new Map((await this.#held(signal)).filter((instance) => instance.status === "running").map((instance) => [instance.id, instance]));
    for (const instance of withSnapshots) {
      const machine = running.get(instance);
      if (!machine) continue;
      try {
        all.push(...(await (await this.#linux.part(instance)).heldSnapshots(signal)).map((held) => this.#heldOn(machine, held)));
      } catch (error) {
        if (signal?.aborted) throw error;
        this.#context.logError(`list the snapshots on Namespace machine ${instance}`, error);
      }
    }
    return all;
  }

  async snapshotsOn(guest: Guest, signal?: AbortSignal): Promise<readonly HeldSnapshot[]> {
    const instance = typeof guest.data?.instance === "string" ? guest.data.instance : null;
    if (!instance || !(await this.#linux.snapshotsTakenOn(instance))) return [];
    const machine = await this.#mine(guest, signal);
    if (!machine || machine.status !== "running") return [];
    return (await (await this.#linux.part(instance)).snapshotsOn(guest, signal)).map((held) => this.#heldOn(machine, held));
  }

  async deleteSnapshot(ref: SnapshotRef, hooks: SnapshotHooks, signal?: AbortSignal): Promise<void> {
    const machine = await this.#mine(ref.guest, signal);
    if (!machine || machine.status !== "running") return;
    await (await this.#linux.part(machine.id)).deleteSnapshot(ref, tasksOnMachine(hooks, machine.id), signal);
  }

  async providerTask(task: TaskRef, signal?: AbortSignal): Promise<TaskOutcome> {
    const machine = task.host ? await this.#api.describe(task.host, signal).catch(() => null) : null;
    if (!machine || machine.status !== "running" || !this.#owner.owns(machine.labels)) return { state: "missing", words: "Its Namespace machine is gone, and the box's snapshots went with it." };
    return (await this.#linux.part(machine.id)).providerTask(task);
  }

  async adoptSnapshot(ref: SnapshotRef, box: BoxIdentity, identity: GuestIdentity, hooks: CopyHooks, signal?: AbortSignal): Promise<Guest> {
    const instance = this.#instanceOf(ref.guest);
    const machine = await this.#mine(ref.guest, signal);
    if (!machine || machine.status !== "running") throw new BackendError("gone", `Namespace's machine ${instance} is gone, and the box's snapshots went with it.`);
    const own = (guest: Guest): Guest => ({ ...ref.guest, ...guest, host: ref.guest.host, size: ref.guest.size, ...this.#deadlineOf(machine), data: { ...guest.data, box: box.boxId, instance } });
    const made = await (await this.#linux.part(instance)).adoptSnapshot(ref, box, identity, { ...tasksOnMachine(hooks, instance), claimed: (guest) => hooks.claimed(own(guest)) }, signal);
    return own(made);
  }

  #heldOn(machine: Instance, held: HeldSnapshot): HeldSnapshot {
    const endsAt = machine.createdAt === null ? null : this.#endsAt(machine.createdAt);
    return {
      ...held,
      guest: { ...held.guest, host: machine.continent ?? null, ...this.#deadlineOf(machine), data: { ...held.guest.data, instance: machine.id } },
      storage: held.storage ? { ...held.storage, name: snapshotStorageOnMachine(endsAt) } : null,
    };
  }

  #instanceOf(guest: Guest): string {
    const instance = typeof guest.data?.instance === "string" ? guest.data.instance : null;
    if (!instance) throw new BackendError("gone", `Box ${guest.ref} has no Namespace machine.`);
    return instance;
  }

  async #linuxPart(guest: Guest): Promise<DockerBackend> {
    if (namespaceSlotOf(guest)) throw new BackendError("unsupported", "Namespace's iOS boxes take no snapshots.");
    return this.#linux.part(this.#instanceOf(guest));
  }

  async restartDeviceServer(guest: Guest, signal?: AbortSignal): Promise<void> {
    if (namespaceSlotOf(guest)) await this.slots.restartDeviceServer(guest, signal);
  }

  encoderOf(guest: Guest): MacEncoder | null {
    const ref = namespaceSlotOf(guest);
    if (!ref?.instance) return null;
    const record = this.slots.known();
    const report = this.macCapabilities()[0] ?? null;
    return { mac: ref.instance, chip: report?.chip ?? null, hardware: record?.hardware ?? null, cores: this.#config.largestMachine?.cores ?? HOST_SHAPE.cores };
  }

  async maintain(signal?: AbortSignal, recordedGuests?: ReadonlySet<string>): Promise<void> {
    await this.linuxImages.carryOnLeftBuilds().catch((error) => this.#context.logError("carry on Namespace's image builds", error));
    await this.linuxImages.destroyBuildsNoOneFollows(signal).catch((error) => this.#context.logError("destroy Namespace's build instances no build follows", error));
    for (const { target, why } of await this.linuxImages.due(signal).catch(() => [])) {
      void this.linuxImages.build(target, why).catch((error) => this.#context.logError(`build Namespace's ${target} image`, error));
    }
    await this.slots.maintain(signal);
    await this.#measureAfreshIfDue(signal).catch((error) => this.#context.logError("measure a Namespace Mac afresh", error));
    const held = await this.#finishReleases(await this.#held(signal), signal);
    await this.#tendSnapshots(held, signal);
    await this.#removeStaleDevices(held, signal).catch((error) => this.#context.logError("remove Namespace machines' leftover tailnet devices", error));
    for (const instance of held) {
      if (instance.status !== "running" || instance.createdAt === null) continue;
      if (!(await this.#keptAlive(instance, recordedGuests, signal))) continue;
      const ends = this.#endsAt(instance.createdAt);
      const ahead = Math.min(KEEP_AHEAD_MS, ends - this.#now());
      if (ahead <= 0 || (instance.deadline ?? 0) - this.#now() >= ahead - 5 * 60_000) continue;
      await this.#api.extend(instance.id, ahead, signal).catch((error) => this.#context.logError(`keep Namespace machine ${instance.id} alive`, error));
    }
  }

  async #snapshotChecks(held: readonly Instance[], signal?: AbortSignal): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    for (const instance of held) {
      if (instance.status !== "running" || !(await this.#linux.snapshotsTakenOn(instance.id))) continue;
      const report = await (await this.#linux.part(instance.id)).doctor(signal).catch((error: unknown) => error as Error);
      const lines = report instanceof Error ? { status: "fail" as const, detail: report.message } : snapshotLinesOf(report.checks);
      if (!lines) continue;
      const ends = instance.createdAt === null ? "" : ` They end with the machine at ${clock(this.#endsAt(instance.createdAt))}, the plan's longest life, or at the box's release.`;
      checks.push({ id: `namespace.snapshots.${instance.id}`, name: `Snapshots on ${instance.id}`, status: lines.status, detail: `${lines.detail}${ends}`, fix: null });
    }
    return checks;
  }

  async #tendSnapshots(held: readonly Instance[], signal?: AbortSignal): Promise<void> {
    const running = new Set(held.filter((instance) => instance.status === "running").map((instance) => instance.id));
    const listed = new Set(held.map((instance) => instance.id));
    for (const instance of await this.#linux.machinesWithSnapshots()) {
      if (!listed.has(instance)) await this.#linux.forget(instance);
      if (!running.has(instance)) continue;
      await (await this.#linux.part(instance)).maintain(signal).catch((error) => this.#context.logError(`tend the snapshots on Namespace machine ${instance}`, error));
    }
  }

  async #finishReleases(held: readonly Instance[], signal?: AbortSignal): Promise<Instance[]> {
    const releasing = new Set(await this.#linux.machinesReleasingTheirBox());
    if (!releasing.size) return [...held];
    const listed = new Set(held.map((instance) => instance.id));
    for (const instance of releasing) if (!listed.has(instance)) await this.#linux.forget(instance);
    const left: Instance[] = [];
    for (const instance of held) {
      if (!releasing.has(instance.id) || instance.status === "destroyed" || instance.status === "destroying") {
        left.push(instance);
        continue;
      }
      try {
        await this.#destroyMachine(instance, signal);
        this.#context.log?.(`Destroyed Namespace machine ${instance.id}, whose box's release had not finished.`);
      } catch (error) {
        if (signal?.aborted) throw error;
        this.#context.logError(`destroy Namespace machine ${instance.id}, whose box was released; ${PRODUCT} tries again at its next sweep`, error);
        left.push(instance);
      }
    }
    return left;
  }

  async #keptAlive(instance: Instance, recordedGuests: ReadonlySet<string> | undefined, signal?: AbortSignal): Promise<boolean> {
    if (!this.#recorded(instance, recordedGuests)) return false;
    if (!isLinuxKind(instance.labels[LABELS.kind] ?? "") || !(await this.#linux.snapshotsTakenOn(instance.id))) return true;
    try {
      const containers = await this.#containersOfTheBox(instance.id, instance.labels[LABELS.box] ?? null, signal);
      const live = containers.some((container) => recordedGuests?.has(container.ref) ?? false);
      if (live) await this.#linux.markBoxContainerSeen(instance.id, this.#now());
      return live;
    } catch (error) {
      if (signal?.aborted) throw error;
      const seen = await this.#lastSeenOrGraceFromNow(instance.id);
      const recently = this.#now() - seen < KEEP_UNREACHABLE_ENGINE_ALIVE_MS;
      this.#context.logError(`list the containers on Namespace machine ${instance.id}; ${recently ? "it keeps its deadline moving for now, as its box's container answered within the hour" : "it no longer moves its deadline on, as its box's container has not answered for an hour"}`, error);
      return recently;
    }
  }

  async #lastSeenOrGraceFromNow(instance: string): Promise<number> {
    const seen = await this.#linux.boxContainerLastSeen(instance);
    if (seen !== null) return seen;
    const graceStarts = this.#now();
    await this.#linux.markBoxContainerSeen(instance, graceStarts);
    return graceStarts;
  }

  #recorded(instance: Instance, recordedGuests: ReadonlySet<string> | undefined): boolean {
    const ref = this.#refOf(instance);
    if (recordedGuests?.has(ref)) return true;
    const boxId = instance.labels[LABELS.box];
    return !!boxId && isLinuxKind(instance.labels[LABELS.kind] ?? "") && [...(recordedGuests ?? [])].some((recorded) => isBoxContainerName(containerName(boxId), recorded));
  }

  async transports(guest: Guest, kind: string): Promise<BoxTransports> {
    if (namespaceSlotOf(guest)) return this.slots.transports(guest);
    const instance = typeof guest.data?.instance === "string" ? guest.data.instance : null;
    if (!instance) throw new BackendError("gone", `Box ${guest.ref} has no Namespace machine.`);
    if (isLinuxKind(kind)) return (await this.#linux.part(instance)).transports(guest, kind);
    const { ssh } = await this.#keys();
    const access = this.#access(instance);
    const command = new SshTransport(ssh, access, "macos");
    const displays =
      kind === "macos-desktop"
        ? [
            {
              id: "desktop",
              label: "Desktop",
              protocol: "rfb" as const,
              resizable: false,
              open: async (signal?: AbortSignal) => {
                const signIn = await this.#api.vncSignIn(instance, signal);
                return {
                  route: ssh.route(access, SCREEN_SHARING_PORT),
                  auth: { type: "apple" as const, user: signIn.user, password: signIn.password },
                  input: (events: Parameters<typeof startMacInput>[1], inputSignal?: AbortSignal) =>
                    startMacInput(command, events, `The desktop's input helper did not start on Namespace's machine ${instance}.`, inputSignal),
                };
              },
            },
            { ...MAC_VIDEO, label: "Desktop, as video", open: async () => ({ route: ssh.commandRoute(access, macStreamCommand()), auth: { type: "none" as const } }) },
          ]
        : [];
    return { command, displays, access: { ssh: access, dockerHost: null } };
  }

  async doctor(signal?: AbortSignal): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    const notes: string[] = [];
    let held: Instance[] = [];
    try {
      held = await this.#held(signal);
      checks.push({ id: "namespace.token", name: "API token", status: "ok", detail: `Namespace's API in ${this.#config.region} answers to the token.`, fix: null });
    } catch (error) {
      checks.push({
        id: "namespace.token",
        name: "API token",
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
        fix: "Make a token with nsc token create, as the guide shows, and set it in BB Box's settings.",
      });
    }
    const now = this.#now();
    const described = held.map((instance) => {
      const ends = instance.createdAt === null ? null : this.#endsAt(instance.createdAt);
      const age = instance.createdAt === null ? "" : `, ${Math.round((now - instance.createdAt) / 60_000)} min old`;
      return `${instance.labels[LABELS.name] ?? instance.id}${age}${ends === null ? "" : `, ends ${clock(ends)}`}${instance.continent ? `, in ${instance.continent}` : ""}`;
    });
    const unclaimed = held.filter((instance) => !instance.labels[LABELS.box]);
    checks.push({
      id: "namespace.machines",
      name: "Machines",
      status: unclaimed.length ? "warn" : "ok",
      detail: held.length ? `${held.length} of at most ${this.#config.machines}: ${described.join("; ")}.` : `None now; at most ${this.#config.machines} at once.`,
      fix: unclaimed.length ? `${PRODUCT}'s sweep destroys machines labelled for this install that no box claims.` : null,
    });
    checks.push(await this.#limitsCheck(signal));
    checks.push(await this.#linuxImagesCheck(signal));
    checks.push(...(await this.#snapshotChecks(held, signal)));
    const macs = held.filter((instance) => instance.labels[LABELS.kind] !== undefined && !isLinuxKind(instance.labels[LABELS.kind] as NamespaceKind));
    for (const instance of macs) await this.#probes.measure(instance.id, signal).catch((error) => this.#context.logError(`measure what Namespace's Mac ${instance.id} offers`, error));
    for (const instance of macs.filter((mac) => mac.status === "running")) await this.#measureGrants(instance.id, signal);
    checks.push(grantCheck(await this.#grantReports.all(), await this.#grantReports.failures(), now));
    checks.push(await this.slots.doctor(signal));
    const reports = this.macCapabilities();
    if (!reports.length) checks.push({ id: "devices.namespace", name: "iOS devices on Namespace's Macs", status: "skipped", detail: `Not measured yet: ${PRODUCT} measures each Namespace Mac it starts.`, fix: null });
    for (const report of reports) checks.push(capabilityCheck(`namespace.${report.mac}`, `Namespace's ${report.mac} Macs`, report, now));
    if (reports.length && macsVary(reports)) checks.push({ id: "devices.namespace", name: "iOS devices on Namespace's Macs", status: "ok", detail: `Namespace's Macs vary by machine: ${eachKindOfMacWords(reports)}. A shared iOS host measures its own Mac and streams by its hardware encoder where it has one, in software otherwise.`, fix: null });
    notes.push(`Each machine lives at most ${this.#config.longestLifeHours} hours, the plan's longest life, and its deadline is kept no more than an hour ahead, so a machine ${PRODUCT} loses track of ends within the hour.`);
    const failing = checks.some((check) => check.status === "fail");
    return { ok: !failing, summary: failing ? "Namespace does not answer to the token." : `Namespace answers; ${held.length} machine${held.length === 1 ? "" : "s"}.`, checks, notes };
  }

  #endsAt(createdAt: number): number {
    return createdAt + this.#config.longestLifeHours * 3600_000;
  }

  #guest(tag: string, boxId: string | null, instance: Instance | null, shape: { readonly cores: number; readonly memoryGB: number } | null, linux = false): Guest {
    const endsAt = instance?.createdAt != null ? this.#endsAt(instance.createdAt) : null;
    const facts: GuestFact[] = [
      ...(endsAt !== null ? [{ label: "Ends", value: `${clock(endsAt)}, the plan's longest life` }] : []),
      ...(instance?.continent ? [{ label: "Runs in", value: instance.continent }] : []),
    ];
    return {
      ref: tag,
      host: instance?.continent ?? null,
      address: null,
      size: shape ? { cores: shape.cores, memoryMiB: shape.memoryGB * MIB_PER_GB, diskGiB: linux ? null : macDiskGiB(shape) } : null,
      data: { ...(boxId ? { box: boxId } : {}), ...(instance ? { instance: instance.id } : {}) },
      ...(facts.length ? { facts } : {}),
      ...(endsAt !== null ? { endsAt } : {}),
    };
  }

  #labels(box: BoxIdentity, kind: NamespaceKind): Record<string, string> {
    return {
      ...this.#owner.labels(),
      [LABELS.box]: box.boxId,
      [LABELS.thread]: box.threadId,
      [LABELS.name]: box.name,
      [LABELS.kind]: kind,
      [LABELS.created]: String(box.createdAt),
    };
  }

  #refOf(instance: Instance): string {
    const boxId = instance.labels[LABELS.box] ?? instance.id;
    return isLinuxKind(instance.labels[LABELS.kind] ?? "") ? this.#linux.ref(boxId) : this.#tag(boxId);
  }

  #tag(boxId: string): string {
    return this.#owner.uniqueTag(boxId).slice(0, 120);
  }

  async #held(signal?: AbortSignal): Promise<Instance[]> {
    return (await this.#api.list({ [LABELS.install]: this.#context.installId }, signal)).filter((instance) => !instance.labels[LABELS.role] && this.#owner.owns(instance.labels));
  }

  async #find(boxId: string, signal?: AbortSignal): Promise<Instance | null> {
    const found = await this.#api.list({ [LABELS.install]: this.#context.installId, [LABELS.box]: boxId }, signal);
    return found.find((instance) => this.#owner.owns(instance.labels)) ?? null;
  }

  async #mine(guest: Guest, signal?: AbortSignal): Promise<Instance | null> {
    const boxId = typeof guest.data?.box === "string" ? guest.data.box : null;
    const id = typeof guest.data?.instance === "string" ? guest.data.instance : boxId ? ((await this.#find(boxId, signal))?.id ?? null) : null;
    if (!id) return null;
    const described = await this.#api.describe(id, signal).catch((error: unknown) => {
      if (error instanceof NamespaceError && error.kind === "gone") return null;
      throw error;
    });
    return described && this.#owner.owns(described.labels) ? described : null;
  }

  async #answers(instance: string, deadline: number, signal?: AbortSignal): Promise<void> {
    const { ssh } = await this.#keys();
    const command = new SshTransport(ssh, this.#access(instance), "macos");
    let last = "";
    while (this.#now() < deadline) {
      signal?.throwIfAborted();
      const result = await command.run("true", { timeoutMs: 20_000, signal }).catch((error: unknown) => {
        if (signal?.aborted) throw error;
        return { exitCode: -1, stderr: error instanceof Error ? error.message : String(error) };
      });
      if (result.exitCode === 0) return;
      last = result.stderr.trim();
      await this.#sleep(SSH_POLL_MS, signal);
    }
    throw new Error(`Namespace's machine ${instance} did not answer SSH through ${this.#api.sshGateway} in time${last ? `: ${last}` : ""}.`);
  }

  #access(instance: string): SshAccess {
    return { host: this.#api.sshGateway, port: 22, user: instance, hostKeys: [] };
  }

  async #join(instance: string, box: BoxIdentity, tailnet: Tailnet, linux: boolean, signal?: AbortSignal): Promise<void> {
    await this.#joinAs(instance, box.name, tailnet, linux, signal);
  }

  async #joinAs(instance: string, name: string, tailnet: Tailnet, linux: boolean, signal?: AbortSignal): Promise<void> {
    const { ssh } = await this.#keys();
    const command = new SshTransport(ssh, this.#access(instance), linux ? "linux" : "macos");
    const prepared = await command.run(linux ? (this.#options.linuxTailscaleScript ?? LINUX_TAILSCALE) : MAC_TAILSCALE, { timeoutMs: 180_000, signal });
    if (prepared.exitCode !== 0) throw new Error(`Tailscale did not start on Namespace's machine ${instance}: ${prepared.stderr.trim().slice(-300) || `exit ${prepared.exitCode}`}`);
    const key = await tailnet.mintKey({ description: `${PRODUCT} Namespace ${name}` }, signal);
    const joined = await command.run(joinScript(this.#tailnetHostname(name)), { stdin: key.key, timeoutMs: 90_000, signal });
    if (joined.exitCode !== 0) throw new Error(`Namespace's machine ${instance} did not join the tailnet: ${joined.stderr.trim().slice(-300) || `exit ${joined.exitCode}`}`);
  }

  async #leaveTailnetAs(instance: string, name: string): Promise<void> {
    const tailnet = this.#context.tailnet?.() ?? null;
    await this.#leave(instance);
    if (!tailnet) return;
    const hostname = this.#tailnetHostname(name);
    for (const device of await tailnet.devices().catch(() => [])) if (device.hostname === hostname) await tailnet.removeDevice(device.id).catch(() => undefined);
  }

  async #leave(instance: string, signal?: AbortSignal): Promise<void> {
    const { ssh } = await this.#keys();
    await new SshTransport(ssh, this.#access(instance), "macos").run(leaveScript(), { timeoutMs: 15_000, signal }).catch(() => undefined);
  }

  async #removeStaleDevices(held: readonly Instance[], signal?: AbortSignal): Promise<void> {
    const tailnet = this.#context.tailnet?.();
    if (!tailnet) return;
    const live = new Set(held.map((instance) => this.#tailnetHostname(instance.labels[LABELS.name] ?? instance.id)));
    for (const device of await tailnet.devices(signal)) {
      if (!this.#owner.holdsTailnetHostname(device.hostname) || live.has(device.hostname)) continue;
      if (device.lastSeen !== null && this.#now() - device.lastSeen < STALE_DEVICE_MS) continue;
      await tailnet.removeDevice(device.id, signal);
      this.#context.log?.(`Removed tailnet device ${device.hostname}, whose Namespace machine is gone.`);
    }
  }

  #tailnetHostname(name: string): string {
    return this.#owner.tailnetHostname(name);
  }

  async #forget(instance: string): Promise<void> {
    const { ssh } = await this.#keys();
    await ssh.forget(this.#access(instance)).catch(() => undefined);
  }

  #kind(kind: string): NamespaceKind {
    if (kind !== "macos" && kind !== "macos-desktop" && !isLinuxKind(kind)) throw new BackendError("unsupported", `Namespace offers macos, macos-desktop and Linux boxes, not ${kind}.`);
    return kind;
  }

  #helper(): MacVmHelper {
    this.#macHelper ??= new MacVmHelper(this.#options.macHelper ?? macVmHelperCommand(), this.#options.macHelperReadyTimeoutMs ? { readyMs: this.#options.macHelperReadyTimeoutMs } : {});
    return this.#macHelper;
  }

  async #macCommand(instance: string): Promise<SshTransport> {
    return new SshTransport((await this.#keys()).ssh, this.#access(instance), "macos");
  }

  async #readyGrants(instance: string, signal?: AbortSignal): Promise<void> {
    const answer = await this.#helper().ready(await this.#macCommand(instance), signal);
    await this.#rememberGrants(instance, answer);
    if (!answer.state?.signingIdentity) this.#context.logError("ready the box's grants", new Error(`Namespace's Mac ${instance}: the box's signing identity was not made: ${answer.failure ?? "the helper said signing=0"}`));
  }

  async #measureGrants(instance: string, signal?: AbortSignal): Promise<void> {
    const answer = await this.#helper().measure(await this.#macCommand(instance), signal);
    await this.#rememberGrants(instance, answer.state === null ? answer : { state: answer.state.state, failure: null });
  }

  #rememberGrants(instance: string, answer: MacHelperAnswer<MacGrantState>): Promise<void> {
    if (answer.state === null) return this.#grantReports.rememberFailure(instance, answer.failure, this.#now());
    return this.#grantReports.remember(instance, answer.state, this.#now());
  }

  #macBoxOf(guest: Guest): { readonly instance: string; readonly box: string } | null {
    const box = typeof guest.data?.box === "string" ? guest.data.box : null;
    const instance = typeof guest.data?.instance === "string" ? guest.data.instance : null;
    return box && instance && !namespaceSlotOf(guest) && guest.ref === this.#tag(box) ? { instance, box } : null;
  }

  async grant(guest: Guest, request: GrantRequest, signal?: AbortSignal): Promise<GrantAnswer> {
    if (namespaceSlotOf(guest)) throw new BackendError("unsupported", "A box on a shared iOS host is a macOS user with no console session, so there is nothing to grant macOS permissions to, and a grant in the Mac's own database would reach every box on the host.");
    const mac = this.#macBoxOf(guest);
    if (!mac) throw new BackendError("unsupported", `Only a macOS box has macOS permissions to grant: ${guest.ref} runs Linux.`);
    return this.#helper().grant(await this.#macCommand(mac.instance), `Namespace's Mac ${mac.instance}`, this.#context.installId, mac.box, request, signal);
  }

  async grants(guest: Guest, signal?: AbortSignal): Promise<BoxGrants | null> {
    const mac = this.#macBoxOf(guest);
    if (!mac) return null;
    return (await this.#helper().grants(await this.#macCommand(mac.instance), signal))?.grants ?? null;
  }

  async #prepareDesktop(instance: string, signal?: AbortSignal): Promise<void> {
    const { ssh } = await this.#keys();
    const prepared = await new SshTransport(ssh, this.#access(instance), "macos").run(this.#options.desktopScript ?? MAC_DESKTOP, { stdin: this.#options.streamSource ?? qemuVideoSource(), timeoutMs: 300_000, signal });
    if (prepared.exitCode !== 0) throw new Error(`Namespace's machine ${instance} did not get its desktop ready: ${prepared.stderr.trim().slice(-400) || `exit ${prepared.exitCode}`}`);
  }

  async #prepareComputerUse(instance: string, signal?: AbortSignal): Promise<void> {
    const { ssh } = await this.#keys();
    const prepared = await new SshTransport(ssh, this.#access(instance), "macos").run(this.#options.cuaScript ?? MAC_CUA, { timeoutMs: 300_000, signal });
    if (prepared.exitCode !== 0) throw new Error(`Namespace's machine ${instance} did not get Cua Driver ready: ${prepared.stderr.trim().slice(-400) || `exit ${prepared.exitCode}`}`);
  }

  async ownImages(signal?: AbortSignal): Promise<readonly OwnImage[]> {
    const images: OwnImage[] = [];
    for (const [kind, target] of Object.entries(LINUX_IMAGE_TARGETS)) {
      const record = await this.linuxImages.record(target);
      const due = record ? await this.linuxImages.whyBuild(target, signal).catch(() => null) : null;
      images.push({ kind, ref: record?.ref ?? null, builtAt: record?.builtAt ?? null, due, building: this.linuxImages.building(target) });
    }
    return images;
  }

  async #linuxImagesCheck(signal?: AbortSignal): Promise<DoctorCheck> {
    const lines: string[] = [];
    for (const target of Object.values(LINUX_IMAGE_TARGETS)) {
      const record = await this.linuxImages.record(target);
      const building = this.linuxImages.building(target) ? ", being built now" : "";
      if (!record) {
        lines.push(`${target}: none yet, built when a box first needs it${building}`);
        continue;
      }
      const days = Math.floor((this.#now() - record.builtAt) / (24 * 3_600_000));
      const why = await this.linuxImages.whyBuild(target, signal).catch(() => null);
      lines.push(`${target}: built ${days} day${days === 1 ? "" : "s"} ago${why ? `, due again as ${why}` : ""}${building}`);
    }
    const builders = (await this.linuxImages.buildInstances(signal).catch(() => [])).map((instance) => {
      const age = instance.createdAt === null ? "" : `, ${Math.round((this.#now() - instance.createdAt) / 60_000)} min old`;
      return `${instance.id} (${instance.labels["bbbox-target"] ?? "an image"}${age})`;
    });
    const building = builders.length ? ` Building now: ${builders.join(", ")}.` : " No build machine is running.";
    return { id: "namespace.images", name: "Linux images", status: "ok", detail: `In the workspace's registry: ${lines.join("; ")}.${building}`, fix: null };
  }

  async #limitsCheck(signal?: AbortSignal): Promise<DoctorCheck> {
    const { concurrency, unread } = await this.#workspaceLimits(signal);
    const largest = await this.#largestMachine(concurrency);
    const largestWords = largest ? `the largest Mac ${PRODUCT} asks for is ${largest.cores}x${largest.memoryGB}` : `${PRODUCT} knows no largest Mac yet`;
    if (concurrency) {
      return {
        id: "namespace.limits",
        name: "Workspace limits",
        status: "ok",
        detail: `The workspace allows ${concurrency.maxCores} Mac cores and ${Math.round(concurrency.maxMemoryMiB / MIB_PER_GB)} GB of Mac memory at once, ${concurrency.usedCores} cores in use now; ${largestWords}.`,
        fix: null,
      };
    }
    const refused = unread?.kind === "refused";
    return {
      id: "namespace.limits",
      name: "Workspace limits",
      status: "warn",
      detail: `${refused ? "The token may not read the workspace's limits" : `${PRODUCT} could not read the workspace's limits: ${unread?.message ?? "Namespace gave none for macOS"}`}. So ${largestWords}, from Largest machine in BB Box's settings or Namespace's last refusal, and a full workspace shows only when Namespace refuses a Mac.`,
      fix: refused ? `Make a new token with the grant ${USAGE_GRANT} as well, as the guide shows, and set it in BB Box's settings.` : null,
    };
  }

  async #workspaceLimits(signal?: AbortSignal): Promise<{ readonly concurrency: PlatformConcurrency | null; readonly unread: NamespaceError | null }> {
    try {
      return { concurrency: await this.#api.macConcurrency(signal), unread: null };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof NamespaceError) return { concurrency: null, unread: error };
      throw error;
    }
  }

  async #largestMachine(concurrency: PlatformConcurrency | null): Promise<MacShape | null> {
    const fromWorkspace = concurrency ? largestWithin(concurrency) : ((await this.#context.storage.get<MacShape>(LARGEST_MACHINE)) ?? null);
    const known = [this.#config.largestMachine, fromWorkspace].filter((shape): shape is MacShape => shape !== null);
    if (!known.length) return null;
    return { cores: Math.min(...known.map((shape) => shape.cores)), memoryGB: Math.min(...known.map((shape) => shape.memoryGB)) };
  }

  async dispose(): Promise<void> {
    this.slots.dispose();
    this.linuxImages.dispose();
    await (await this.#ssh?.catch(() => null))?.ssh.dispose();
    await this.#keyFile.dispose();
  }

  #keys(): Promise<{ ssh: Ssh; publicKey: string }> {
    if (!this.#ssh) {
      const pending = (async () => {
        const stored = await storedKeyPair(this.#context.storage, SSH_KEY);
        const keyPath = await this.#keyFile.path(stored.privateKey);
        const shareDir = await this.#keyFile.shareDir();
        return { ssh: new Ssh({ keyPath, binary: this.#options.sshBinary, shareDir }), publicKey: stored.publicKey };
      })();
      this.#ssh = pending;
      pending.catch(() => {
        if (this.#ssh === pending) this.#ssh = null;
      });
    }
    return this.#ssh;
  }
}
