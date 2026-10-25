import { startMacInput } from "../../core/mac-input.ts";
import { joinScript, leaveScript, tailnetHostname, type Tailnet } from "../../core/tailnet.ts";
import { MAC_STREAM, MAC_VIDEO, macStreamCommand } from "../mac-stream.ts";
import { CUA_SHA256, CUA_VERSION } from "../tart/backend.ts";
import { qemuVideoSource } from "../tart/qemu-video.ts";
import { KeyFile, Ssh, SshTransport, generateKeyPair } from "../../transports/ssh.ts";
import type { SshAccess } from "../../transports/types.ts";
import {
  BackendError,
  type AcquireHooks,
  type Backend,
  type BackendContext,
  type BoxIdentity,
  type BoxKind,
  type BoxSize,
  type BoxTransports,
  type Capacity,
  type CommandCapability,
  type DoctorCheck,
  type DoctorReport,
  type Guest,
  type GuestFact,
  type HeldGuest,
  type PowerState,
  type ReleaseHooks,
} from "../types.ts";
import { NamespaceApi, NamespaceError, type Instance, type InstanceShape, type NamespaceFetch, type PlatformConcurrency } from "./api.ts";
import type { MacShape, NamespaceConfig, NamespaceKind } from "./config.ts";
import { LINUX_IMAGE_TARGETS, LinuxImages, type LinuxImageDeps } from "./linux-images.ts";
import { NamespaceLinux, isLinuxKind, linuxShapeFor } from "./linux.ts";
import type { DockerBackendOptions } from "../docker/backend.ts";
import type { DockerCli } from "../docker/cli.ts";

export const LABELS = {
  install: "bbbox-install",
  box: "bbbox-box",
  thread: "bbbox-thread",
  name: "bbbox-name",
  kind: "bbbox-kind",
  created: "bbbox-created",
  role: "bbbox-role",
} as const;

export const KEEP_AHEAD_MS = 60 * 60_000;
const READY_TIMEOUT_MS = 5 * 60_000;
const SSH_POLL_MS = 2_000;
const SSH_KEY = "ssh-key";
const LARGEST_MACHINE = "largest-machine";
const USAGE_GRANT = '{"resource_type":"tenant/usage","resource_id":"*","actions":["get"]}';
const LARGEST_ALLOWED = /maximum ([0-9]+)x([0-9]+)/;

function linuxTooBig(size: BoxSize): string {
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

export function macShapeFor(size: BoxSize, largest: MacShape | null = null): MacShape | null {
  const allowed = largest ? MACOS_SHAPES.filter((shape) => shape.cores <= largest.cores && shape.memoryGB <= largest.memoryGB) : MACOS_SHAPES;
  const fits = allowed.filter((shape) => shape.cores >= size.cores && shape.memoryGB * MIB_PER_GB >= size.memoryMiB && (size.diskGiB === null || macDiskGiB(shape) >= size.diskGiB));
  return fits.sort((a, b) => a.cores * 100 + a.memoryGB - (b.cores * 100 + b.memoryGB))[0] ?? null;
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
  readonly dockerOptions?: DockerBackendOptions;
  readonly dockerCli?: (instance: string) => DockerCli;
  readonly linuxPullScript?: (ref: string, local: string) => string;
  readonly linuxTailscaleScript?: string;
}

function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });
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
  readonly #keyFile = new KeyFile();
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #placing = new Set<string>();
  #ssh: Promise<{ ssh: Ssh; publicKey: string }> | null = null;
  readonly linuxImages: LinuxImages;
  readonly #linux: NamespaceLinux;

  constructor(config: NamespaceConfig, context: BackendContext, options: NamespaceBackendOptions = {}) {
    if (!config.token) throw new BackendError("unsupported", "Namespace has no API token: set it in BB Box's settings.");
    this.#config = config;
    this.#context = context;
    this.#options = options;
    this.id = context.id;
    this.label = "Namespace";
    this.#api = new NamespaceApi({ token: config.token, region: config.region, ...(context.log ? { log: (line: string) => context.log!(line) } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) });
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? sleepFor;
    this.linuxImages = new LinuxImages({
      api: this.#api,
      storage: context.storage,
      labels: { [LABELS.install]: context.installId },
      uniqueTag: (target) => `bbbox-${context.installId}-image-${target}`.replace(/[^A-Za-z0-9-]+/g, "-"),
      now: this.#now,
      publicKey: async () => (await this.#keys()).publicKey,
      answers: (instance, signal) => this.#answers(instance, this.#now() + (options.readyTimeoutMs ?? READY_TIMEOUT_MS), signal),
      run: async (instance, script, stdin, timeoutMs, signal) => new SshTransport((await this.#keys()).ssh, this.#access(instance), "linux").run(script, { stdin, timeoutMs, signal, maxOutputBytes: 1024 * 1024 }),
      bbUrl: () => context.bbUrl?.() ?? null,
      joinTailnet: async (instance, name, signal) => {
        const tailnet = context.tailnet?.() ?? null;
        if (!tailnet) return null;
        await this.#joinAs(instance, name, tailnet, true, signal);
        return async () => {
          await this.#leave(instance);
          const hostname = this.#tailnetHostname(name);
          for (const device of await tailnet.devices().catch(() => [])) if (device.hostname === hostname) await tailnet.removeDevice(device.id).catch(() => undefined);
        };
      },
      bbApp: async (signal) => (context.bbUrl?.() ? ((await context.images?.bbApp(signal).catch(() => null)) ?? null) : null),
      log: (line) => context.log?.(line),
      ...(options.linuxImageScript ? { buildScript: options.linuxImageScript } : {}),
      ...(options.setupArchive ? { setupArchive: options.setupArchive } : {}),
    });
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

  kinds(): readonly BoxKind[] {
    const readyTimeoutMs = this.#options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    return [
      {
        id: "macos",
        label: "macOS",
        description: "A Mac of its own on Namespace, for builds and Apple's tools, with Xcode. It lasts at most the workspace plan's longest life. Its desktop is not shown.",
        requires: [],
        capabilities: { os: "macos", arch: "arm64", gpu: false, features: ["xcode"], command: SSH_COMMAND, displays: [], computerUse: null, enrol: true },
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
        },
        readyTimeoutMs,
      },
      ...this.#linux.kinds(this.#options.readyTimeoutMs ?? LINUX_READY_TIMEOUT_MS),
    ];
  }

  async capacity(kind: string, size: BoxSize, pending: readonly { readonly kind: string; readonly size: BoxSize }[], signal?: AbortSignal): Promise<Capacity> {
    this.#kind(kind);
    const host = "Namespace";
    if (isLinuxKind(kind) && !linuxShapeFor(size)) return { ok: false, message: linuxTooBig(size), warm: null, hosts: [{ host, ok: false, limits: [] }] };
    const { concurrency } = isLinuxKind(kind) ? { concurrency: null } : await this.#workspaceLimits(signal);
    const largest = isLinuxKind(kind) ? null : await this.#largestMachine(concurrency);
    const shape = isLinuxKind(kind) ? linuxShapeFor(size) : macShapeFor(size, largest);
    if (!shape) return { ok: false, message: this.#tooBig(size, largest), warm: null, hosts: [{ host, ok: false, limits: [] }] };
    const fullFor = concurrency ? workspaceFullFor(shape, concurrency) : null;
    if (fullFor) return { ok: false, message: fullFor, warm: null, hosts: [{ host, ok: false, limits: [{ resource: "cpu", used: concurrency!.usedCores, total: concurrency!.maxCores, reserve: 0, unit: "count" }] }] };
    let held: Instance[];
    try {
      held = await this.#api.list({ [LABELS.install]: null }, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      return { ok: false, message: `Namespace did not answer: ${error instanceof Error ? error.message : String(error)}`, warm: null, hosts: [{ host, ok: false, limits: [] }] };
    }
    held = held.filter((instance) => !instance.labels[LABELS.role]);
    const used = held.length + Math.max(this.#placing.size, pending.length);
    const ok = used < this.#config.machines;
    return {
      ok,
      message: ok ? null : `Namespace has ${held.length} of the ${this.#config.machines} machines bb-box may have at once, counting every bb-box install's in the workspace. Release a box, or raise the most machines in BB Box's settings.`,
      warm: null,
      hosts: [{ host, ok, limits: [{ resource: "machines", used, total: this.#config.machines, reserve: 0, unit: "count" }] }],
    };
  }

  async acquire(box: BoxIdentity, previous: Guest | null, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest> {
    const kind = this.#kind(box.kind);
    const linux = isLinuxKind(kind) ? kind : null;
    const largest = linux ? null : await this.#largestMachine((await this.#workspaceLimits(signal)).concurrency);
    const shape = linux ? linuxShapeFor(box.size) : macShapeFor(box.size, largest);
    if (!shape) throw new BackendError("no_capacity", linux ? linuxTooBig(box.size) : this.#tooBig(box.size, largest));
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
      return guest;
    } catch (error) {
      const instance = made?.id ?? (await this.#find(box.boxId).catch(() => null))?.id;
      if (instance) await this.#api.destroy(instance, "bb-box: the box did not start").catch((cause) => this.#context.logError("destroy after a failed acquire", cause));
      const allowed = error instanceof NamespaceError ? largestAllowedIn(error.message) : null;
      if (allowed) {
        await this.#context.storage.set(LARGEST_MACHINE, allowed);
        throw new BackendError("no_capacity", this.#tooBig(box.size, allowed));
      }
      if (error instanceof NamespaceError && error.kind === "full") throw new BackendError("no_capacity", error.message);
      throw error;
    } finally {
      this.#placing.delete(box.boxId);
    }
  }

  async release(guest: Guest, hooks: ReleaseHooks, signal?: AbortSignal): Promise<void> {
    const started = performance.now();
    const instance = await this.#mine(guest, signal);
    if (instance) {
      if (instance.status === "running" && this.#context.tailnet?.()) await this.#leave(instance.id, signal);
      await this.#api.destroy(instance.id, "bb-box: the box was released", signal);
      this.#linux.forget(instance.id);
      await this.#forget(instance.id);
    }
    hooks.timing("destroy", Math.round(performance.now() - started));
  }

  async power(guest: Guest, signal?: AbortSignal): Promise<PowerState | null> {
    const described = await this.#mine(guest, signal);
    if (!described || described.status === "destroyed" || described.status === "destroying") return null;
    if (described.status === "running") return "running";
    if (described.status === "suspended") return "stopped";
    return "unknown";
  }

  async held(signal?: AbortSignal): Promise<HeldGuest[]> {
    return (await this.#held(signal)).map((instance) => {
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
  }

  async maintain(signal?: AbortSignal, recordedGuests?: ReadonlySet<string>): Promise<void> {
    for (const { target, why } of await this.linuxImages.due(signal).catch(() => [])) {
      void this.linuxImages.build(target, why).catch((error) => this.#context.logError(`build Namespace's ${target} image`, error));
    }
    const held = await this.#held(signal);
    await this.#removeStaleDevices(held, signal).catch((error) => this.#context.logError("remove Namespace machines' leftover tailnet devices", error));
    for (const instance of held) {
      if (instance.status !== "running" || instance.createdAt === null) continue;
      if (!recordedGuests?.has(this.#refOf(instance))) continue;
      const ends = this.#endsAt(instance.createdAt);
      const ahead = Math.min(KEEP_AHEAD_MS, ends - this.#now());
      if (ahead <= 0 || (instance.deadline ?? 0) - this.#now() >= ahead - 5 * 60_000) continue;
      await this.#api.extend(instance.id, ahead, signal).catch((error) => this.#context.logError(`keep Namespace machine ${instance.id} alive`, error));
    }
  }

  async transports(guest: Guest, kind: string): Promise<BoxTransports> {
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
      fix: unclaimed.length ? "bb-box's sweep destroys machines labelled for this install that no box claims." : null,
    });
    checks.push(await this.#limitsCheck(signal));
    checks.push(await this.#linuxImagesCheck(signal));
    notes.push(`Each machine lives at most ${this.#config.longestLifeHours} hours, the plan's longest life, and its deadline is kept no more than an hour ahead, so a machine bb-box loses track of ends within the hour.`);
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
      [LABELS.install]: this.#context.installId,
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
    return `bbbox-${this.#context.installId}-${boxId}`.replace(/[^A-Za-z0-9-]+/g, "-").slice(0, 120);
  }

  async #held(signal?: AbortSignal): Promise<Instance[]> {
    return (await this.#api.list({ [LABELS.install]: this.#context.installId }, signal)).filter((instance) => !instance.labels[LABELS.role]);
  }

  async #find(boxId: string, signal?: AbortSignal): Promise<Instance | null> {
    const found = await this.#api.list({ [LABELS.install]: this.#context.installId, [LABELS.box]: boxId }, signal);
    return found[0] ?? null;
  }

  async #mine(guest: Guest, signal?: AbortSignal): Promise<Instance | null> {
    const boxId = typeof guest.data?.box === "string" ? guest.data.box : null;
    const id = typeof guest.data?.instance === "string" ? guest.data.instance : boxId ? ((await this.#find(boxId, signal))?.id ?? null) : null;
    if (!id) return null;
    const described = await this.#api.describe(id, signal).catch((error: unknown) => {
      if (error instanceof NamespaceError && error.kind === "gone") return null;
      throw error;
    });
    return described && described.labels[LABELS.install] === this.#context.installId ? described : null;
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
    const key = await tailnet.mintKey({ description: `bb-box Namespace ${name}` }, signal);
    const joined = await command.run(joinScript(this.#tailnetHostname(name)), { stdin: key.key, timeoutMs: 90_000, signal });
    if (joined.exitCode !== 0) throw new Error(`Namespace's machine ${instance} did not join the tailnet: ${joined.stderr.trim().slice(-300) || `exit ${joined.exitCode}`}`);
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
      if (!device.hostname.startsWith(this.#tailnetHostPrefix()) || live.has(device.hostname)) continue;
      if (device.lastSeen !== null && this.#now() - device.lastSeen < STALE_DEVICE_MS) continue;
      await tailnet.removeDevice(device.id, signal);
      this.#context.log?.(`Removed tailnet device ${device.hostname}, whose Namespace machine is gone.`);
    }
  }

  #tailnetHostPrefix(): string {
    return `bb-box-ns-${tailnetHostname(this.#context.installId)}-`;
  }

  #tailnetHostname(name: string): string {
    return tailnetHostname(`${this.#tailnetHostPrefix()}${name}`);
  }

  async #forget(instance: string): Promise<void> {
    const { ssh } = await this.#keys();
    await ssh.forget(this.#access(instance)).catch(() => undefined);
  }

  #kind(kind: string): NamespaceKind {
    if (kind !== "macos" && kind !== "macos-desktop" && !isLinuxKind(kind)) throw new BackendError("unsupported", `Namespace offers macos, macos-desktop and Linux boxes, not ${kind}.`);
    return kind;
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
    const builders = (await this.#api.list({ [LABELS.install]: this.#context.installId, [LABELS.role]: "image-build" }, signal).catch(() => [])).map((instance) => {
      const age = instance.createdAt === null ? "" : `, ${Math.round((this.#now() - instance.createdAt) / 60_000)} min old`;
      return `${instance.id} (${instance.labels["bbbox-target"] ?? "an image"}${age})`;
    });
    const building = builders.length ? ` Building now: ${builders.join(", ")}.` : " No build machine is running.";
    return { id: "namespace.images", name: "Linux images", status: "ok", detail: `In the workspace's registry: ${lines.join("; ")}.${building}`, fix: null };
  }

  async #limitsCheck(signal?: AbortSignal): Promise<DoctorCheck> {
    const { concurrency, unread } = await this.#workspaceLimits(signal);
    const largest = await this.#largestMachine(concurrency);
    const largestWords = largest ? `the largest Mac bb-box asks for is ${largest.cores}x${largest.memoryGB}` : "bb-box knows no largest Mac yet";
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
      detail: `${refused ? "The token may not read the workspace's limits" : `bb-box could not read the workspace's limits: ${unread?.message ?? "Namespace gave none for macOS"}`}. So ${largestWords}, from Largest machine in BB Box's settings or Namespace's last refusal, and a full workspace shows only when Namespace refuses a Mac.`,
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

  #tooBig(size: BoxSize, workspaceLargest: MacShape | null): string {
    const asked = `${size.cores} cores and ${Math.round(size.memoryMiB / MIB_PER_GB)} GiB`;
    if (!workspaceLargest) {
      const largest = MACOS_SHAPES[MACOS_SHAPES.length - 1]!;
      return `Namespace's largest Mac has ${largest.cores} cores and ${largest.memoryGB} GB of memory, less than the ${asked} asked for.`;
    }
    const needed = macShapeFor(size);
    const instead = macShapeFor({ cores: Math.min(size.cores, workspaceLargest.cores), memoryMiB: Math.min(size.memoryMiB, workspaceLargest.memoryGB * MIB_PER_GB), diskGiB: null }, workspaceLargest);
    return [
      `Namespace's workspace allows Macs of at most ${workspaceLargest.cores} cores and ${workspaceLargest.memoryGB} GB of memory`,
      needed ? `, and ${asked} needs its ${needed.cores}x${needed.memoryGB} Mac.` : `, less than the ${asked} asked for.`,
      instead ? ` Ask for at most ${instead.cores} cores and ${instead.memoryGB} GiB, which gets its ${instead.cores}x${instead.memoryGB} Mac, or use another backend.` : "",
    ].join("");
  }

  async dispose(): Promise<void> {
    await (await this.#ssh?.catch(() => null))?.ssh.dispose();
    await this.#keyFile.dispose();
  }

  #keys(): Promise<{ ssh: Ssh; publicKey: string }> {
    if (!this.#ssh) {
      const pending = (async () => {
        let stored = await this.#context.storage.get<{ privateKey: string; publicKey: string }>(SSH_KEY);
        if (!stored) {
          stored = await generateKeyPair();
          await this.#context.storage.set(SSH_KEY, stored);
        }
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
