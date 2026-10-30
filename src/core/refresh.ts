/**
 * Refreshing a standard image (049): a Linux image's guest scripts run again
 * in a box of it, with the versions a rebuild takes (versions.ts) and BB's
 * app, then finalizing; a Windows image's refresh script installs Windows'
 * updates and the pinned tools in a box of it (054). Then a capture, the
 * checks before replacing on a trial box, and the replace. A failure keeps
 * the old build, removes what the refresh made, and says why with the
 * build's last lines.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { BuildLog } from "./build-log.ts";
import { IMAGE_CONTRACT, WINDOWS_HARDWARE_CURSOR, parseImageRecord, pinsDigest, type ImageRecord } from "../backends/images.ts";
import { KIND_INFO } from "../backends/kinds.ts";
import { BackendError, type BackendImages, type ImageBox, type ImageBuild } from "../backends/types.ts";
import { compareVersions, resolveVersions, stageSetup } from "../backends/versions.ts";
import { quote } from "../transports/process.ts";
import { isSignallablePid } from "../transports/spawns.ts";
import { TransportError, type CommandTransport } from "../transports/types.ts";

/** How each Linux kind's standard image is built, as template/build.sh builds it. */
const BUILDS: Readonly<Record<string, { readonly artifacts: string; readonly finalize: string; readonly gpu: string; readonly session: string; readonly check: string }>> = {
  linux: { artifacts: "linux", finalize: "linux", gpu: "", session: "", check: "bb-box-check-headless" },
  "linux-desktop": { artifacts: "desktop", finalize: "desktop", gpu: "nvidia", session: "", check: "bb-box-check-desktop" },
  "linux-desktop-cpu": { artifacts: "desktop-cpu", finalize: "desktop", gpu: "none", session: "", check: "bb-box-check-desktop" },
  "linux-desktop-wayland-cpu": { artifacts: "desktop-wayland-cpu", finalize: "desktop", gpu: "none", session: "wayland", check: "bb-box-check-desktop" },
  android: { artifacts: "linux", finalize: "android", gpu: "", session: "", check: "bb-box-check-android" },
};

/** Lines of a build's output that its result keeps. */
const KEPT_LINES = 200;
/** How much slower than a box of the old build a box of the new one may answer (049). */
const SLOWER_MS = 5_000;
/** How long a refresh waits for room for one of its boxes, as while threads' boxes take a Mac's two macOS slots (#650), and how often it asks. */
const ROOM = { waitMs: 60 * 60_000, pollMs: 30_000 };
/** Where the build's files go in the box, as build.sh puts them in its CT. */
const BUILD_DIR = "/var/tmp/bb-box-build";
/** Where a Windows refresh's files go in the box (054). */
const WINDOWS_DIR = "C:\\bb-box\\build";
/** How many times a Windows refresh restarts the box for its updates before it gives up (054). */
const WINDOWS_ROUNDS = 5;
/** What refresh.ps1 exits with when Windows needs a restart first. */
const RESTART = 3010;
/**
 * Whether a refresh asked for a restart. The command goes through the ssh
 * program, whose exit code, like any process's, keeps only 8 bits, so 3010
 * arrives as 194.
 */
const restarts = (code: number | null): boolean => code === RESTART || code === (RESTART & 0xff);

export interface RefreshOptions {
  readonly images: BackendImages;
  /** The standard build to refresh: a configured template. */
  readonly current: ImageBuild;
  /** The plugin's setup/ directory. */
  readonly setup: string;
  /** BB's server URL, for the image to have BB's app, or null for none. */
  readonly bbUrl: string | null;
  /** The digest of BB's app the server gives now, or null when it gives none. */
  readonly bbApp: string | null;
  /** Build from the repository's pins alone. */
  readonly pinned?: boolean;
  /** False to try a refresh: the build and its checks, then the build goes and the current one stays. */
  readonly replace?: boolean;
  readonly signal: AbortSignal;
  readonly log?: (line: string) => void;
  readonly buildLogDir?: string;
  /** How long the guest scripts may take. */
  readonly buildTimeoutMs?: number;
  /** Replaces resolveVersions, for tests. */
  readonly versions?: typeof resolveVersions;
  /** Replaces the clock, for tests. */
  readonly now?: () => number;
  /** How long to wait for room for a box when the backend has none, and how often to ask (#650). */
  readonly room?: { readonly waitMs: number; readonly pollMs: number };
  /** How long a Windows box may take to come back after a restart, how often to ask, and how long it must stay up (steadyMs). */
  readonly restart?: WindowsRestart;
}

export interface RefreshCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface RefreshResult {
  readonly ok: boolean;
  /** The new current build when it replaced the old one, else null. */
  readonly build: ImageBuild | null;
  readonly checks: readonly RefreshCheck[];
  /** Why the old build stays, or null. */
  readonly reason: string | null;
  /** The build's last lines of output. */
  readonly output: readonly string[];
  readonly seconds: number;
}

/** The script that runs the guest scripts again in a build box, as root through sudo, from the staged files in setup.tgz. */
export function buildScript(kind: string, bbUrl: string | null, buildId: string): string {
  const build = BUILDS[kind];
  if (!build) throw new Error(`bb-box refreshes no ${kind} image.`);
  const src = `${BUILD_DIR}/proxmox-lxc/template`;
  return [
    "set -euo pipefail",
    `sudo rm -rf ${BUILD_DIR} && sudo install -d -m 0700 ${BUILD_DIR}`,
    `sudo tar -xzf ~/bb-box-setup.tgz -C ${BUILD_DIR} && rm -f ~/bb-box-setup.tgz`,
    // As the image has them: bb-box's key, which its box user accepts, and its DNS servers.
    `awk '$1 == "ssh-ed25519" { print; exit }' ~/.ssh/authorized_keys | sudo tee ${src}/plugin-key.pub >/dev/null`,
    'dns=$(sed -n "s/^DNS=//p" /etc/systemd/resolved.conf.d/10-bb-box.conf 2>/dev/null || true)',
    // A VM's image, as Proxmox QEMU's Linux template (057), keeps its kernel and network: customize-base.sh's vm runtime.
    "runtime=lxc; [ \"$(systemd-detect-virt --container 2>/dev/null)\" != none ] || runtime=vm",
    `sudo tee ${src}/build.env >/dev/null <<EOF`,
    "BOX_USER=box",
    "BOX_RUNTIME=$runtime",
    'BOX_DNS="$dns"',
    `BB_URL=${quote(bbUrl ?? "")}`,
    ...(build.gpu ? [`DESKTOP_GPU=${build.gpu}`] : []),
    ...(build.session ? [`DESKTOP_SESSION=${build.session}`] : []),
    `BUILD_ID=${buildId}`,
    `BOX_IDENTITY_RESET=${kind === "linux" ? "on" : "off"}`,
    "EOF",
    'arch=x86_64; [ "$(uname -m)" = x86_64 ] || arch=arm64',
    `sudo env BBBOX_ENV=/nonexistent BBBOX_BB_URL=${quote(bbUrl ?? "")} bash ${src}/fetch-artifacts.sh ${src}/artifacts ${build.artifacts} "$arch"`,
    `sudo bash ${src}/guest/customize-base.sh ${src}`,
    `[ "$runtime" != vm ] || sudo bash ${BUILD_DIR}/proxmox-qemu/linux/customize-vm.sh ${src}`,
    ...(build.finalize === "desktop" ? [`sudo bash ${src}/guest/customize-desktop.sh ${src}`] : []),
    ...(kind === "android" ? [`sudo bash ${BUILD_DIR}/android/customize-android.sh ${src}`] : []),
    `sudo bash ${src}/guest/finalize.sh ${src} ${build.finalize}`,
  ].join("\n");
}

/** A build ID as build.sh makes one. */
function newBuildId(now: number): string {
  const time = new Date(now).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `build.${time}-${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0")}`;
}

/**
 * The kind's check a trial box runs (049): the backend's own where it has
 * one, else the template's, whose desktop needs its display, which starts
 * soon after boot. Each line says ok or FAIL.
 */
export function trialCheck(images: BackendImages, kind: string, windowsCheck?: string): { readonly name: string; readonly script: string } {
  const own = images.check?.(kind);
  if (own) return { name: "the kind's check", script: own };
  // A Windows image's own check, which the build scripts run (054).
  if (windowsCheck !== undefined) return { name: "the kind's check (check.ps1)", script: windowsCheck };
  const check = BUILDS[kind]?.check ?? "false";
  return {
    name: `the kind's check (${check})`,
    script: `for i in $(seq 1 60); do [ ! -e /etc/systemd/system/bb-box-display.service ] || [ -s /run/bb-box/display-mode ] && break; sleep 1; done; ${check}`,
  };
}

/** A Windows tool's pin in setup/windows/pins.json (054). */
export interface WindowsPin {
  readonly name: string;
  readonly arch: string;
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  readonly components?: readonly string[];
}

/** setup/windows/pins.json's tools for an architecture. */
export async function windowsPins(setup: string, arch: string): Promise<WindowsPin[]> {
  const pins = JSON.parse(await readFile(join(setup, "windows", "pins.json"), "utf8")) as { tools: WindowsPin[] };
  return pins.tools.filter((pin) => pin.arch === arch);
}

/**
 * A new Windows build's record (054): the old one's, with the new build ID,
 * the pinned tools' versions, and the pins digest of the build script whose
 * pins setup/windows/pins.json has. Where the image has bb-box-stream, as
 * every x86_64 image does and an arm64 one does once OpenH264 is pinned for
 * it (060), it lists the hardware cursor, which refresh.ps1 turns on: without
 * it, bb-box does not leave the pointer out of the video.
 */
export function windowsRecord(current: ImageBuild, pins: readonly WindowsPin[], buildId: string, built: number, digest: string): ImageRecord {
  const arch = KIND_INFO[current.kind]?.arch ?? "x86_64";
  const stream = arch === "x86_64" || pins.some((pin) => pin.name === "openh264");
  return {
    contract: IMAGE_CONTRACT,
    image: "standard",
    kind: current.kind,
    arch,
    build: buildId,
    built: new Date(built).toISOString().replace(/\.\d+Z$/, "Z"),
    base: null,
    os: current.record?.os ?? "Windows",
    aptSnapshot: null,
    pins: digest,
    bbApp: null,
    tools: { ...current.record?.tools, ...Object.fromEntries(pins.map((pin) => [pin.name, pin.version])), ...(stream ? { [WINDOWS_HARDWARE_CURSOR]: "1" } : {}) },
    nvidia: null,
    layer: null,
    sizeGiB: null,
    devices: null,
  };
}

/**
 * Starts refresh.ps1 detached from SSH (#707), with Start-Detached, so a
 * link that drops does not end it: its output goes to refresh.log and its
 * exit code to refresh.exit. Prints the PowerShell's process ID and start
 * time, which tell it from a process of the same ID after a restart.
 */
export function windowsStartScript(): string {
  const command = `& '${WINDOWS_DIR}\\refresh.ps1' -Pins '${WINDOWS_DIR}\\pins.json' -Record '${WINDOWS_DIR}\\image.json'; Set-Content -LiteralPath '${WINDOWS_DIR}\\refresh.exit' -Value $LASTEXITCODE`;
  return [
    `Remove-Item -LiteralPath '${WINDOWS_DIR}\\refresh.log', '${WINDOWS_DIR}\\refresh.exit' -Force -ErrorAction SilentlyContinue`,
    `$id = Start-Detached -Command ${quotePs(command)} -Log '${WINDOWS_DIR}\\refresh.log'`,
    `"pid=$id start=$((Get-Process -Id $id).StartTime.ToFileTimeUtc())"`,
  ].join("\n");
}

/**
 * What a detached refresh.ps1 has done since byte `offset` of its log:
 * whether it runs, its exit code once it ended, the log's size, then up to
 * `max` bytes from `offset` in base64. Whether it runs is read first, so a
 * run that has ended has written its exit code by the time it is read.
 */
export function windowsFollowScript(run: { pid: number; start: string }, offset: number, max: number): string {
  return [
    `$f = '${WINDOWS_DIR}\\refresh.log'; $x = '${WINDOWS_DIR}\\refresh.exit'`,
    `$p = Get-Process -Id ${run.pid} -ErrorAction SilentlyContinue`,
    `$alive = [bool]($p -and $p.StartTime.ToFileTimeUtc() -eq ${run.start})`,
    `$code = if (Test-Path -LiteralPath $x) { (Get-Content -LiteralPath $x -Raw).Trim() } else { '' }`,
    `$size = if (Test-Path -LiteralPath $f) { (Get-Item -LiteralPath $f).Length } else { 0 }`,
    `"@alive=$alive"; "@status=$code"; "@size=$size"; '@log'`,
    `if ($size -gt ${offset}) { $s = [IO.File]::Open($f, 'Open', 'Read', 'ReadWrite, Delete'); try { [void]$s.Seek(${offset}, 'Begin'); $b = New-Object byte[] ([Math]::Min($size - ${offset}, ${max})); $n = $s.Read($b, 0, $b.Length); [Convert]::ToBase64String($b, 0, $n) } finally { $s.Close() } }`,
  ].join("\n");
}

/** A Windows follow's answer. */
export function parseWindowsFollow(text: string): { alive: boolean; status: number | null; size: number; bytes: Uint8Array } {
  const at = text.indexOf("@log");
  const head = at < 0 ? text : text.slice(0, at);
  const status = /^@status=(-?\d+)\s*$/m.exec(head)?.[1];
  return {
    alive: /^@alive=True\s*$/m.test(head),
    status: status === undefined ? null : Number(status),
    size: Number(/^@size=(\d+)\s*$/m.exec(head)?.[1] ?? 0),
    bytes: at < 0 ? new Uint8Array() : new Uint8Array(Buffer.from(text.slice(at + 4).replace(/\s+/g, ""), "base64")),
  };
}

/** A string as a PowerShell literal. */
function quotePs(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

/** How much of refresh.ps1's log one look takes. */
const WINDOWS_LOG_CHUNK = 256 * 1024;

/**
 * Runs refresh.ps1 detached in the box and follows its log until it ends,
 * passing its lines on (#707). A look the link misses costs nothing; the
 * box may be out of reach for the restart's timeout before the refresh
 * counts as lost. Null when the run ended without an exit code, as when
 * Windows restarted under it.
 */
async function followWindows(command: CommandTransport, timeoutMs: number, restart: WindowsRestart, signal: AbortSignal, say: (line: string) => void): Promise<{ exitCode: number | null; timedOut: boolean } | null> {
  const started = await command.run(windowsStartScript(), { timeoutMs: 60_000, signal });
  const ids = /pid=(\d+) start=(\d+)/.exec(started.stdout);
  if (started.exitCode !== 0 || !ids) throw new Error(`refresh.ps1 did not start: ${started.stderr.trim() || started.stdout.trim() || `exit code ${started.exitCode}`}`);
  const run = { pid: Number(ids[1]), start: ids[2]! };
  const deadline = Date.now() + timeoutMs;
  const decoder = new TextDecoder();
  let rest = "";
  let offset = 0;
  let heard = Date.now();
  const lines = (text: string) => {
    const all = (rest + text).split(/\r?\n|\r/);
    rest = all.pop() ?? "";
    for (const line of all) if (line.trim()) say(line);
  };
  for (;;) {
    signal.throwIfAborted();
    let more = false;
    try {
      const looked = await command.run(windowsFollowScript(run, offset, WINDOWS_LOG_CHUNK), { timeoutMs: 30_000, signal });
      if (looked.exitCode !== 0) throw new Error(`bb-box could not read refresh.ps1's log: ${looked.stderr.trim() || `exit code ${looked.exitCode}`}`);
      heard = Date.now();
      const seen = parseWindowsFollow(looked.stdout);
      offset += seen.bytes.length;
      lines(decoder.decode(seen.bytes, { stream: true }));
      more = seen.bytes.length >= WINDOWS_LOG_CHUNK;
      if (!more && (seen.status !== null || !seen.alive)) {
        lines(decoder.decode());
        if (rest.trim()) say(rest);
        return seen.status === null ? null : { exitCode: seen.status, timedOut: false };
      }
    } catch (error) {
      if (!(error instanceof TransportError) || error.code !== "unreachable") throw error;
      if (Date.now() - heard > restart.timeoutMs) throw error;
    }
    if (Date.now() > deadline) {
      if (isSignallablePid(run.pid)) await command.run(`taskkill /T /F /PID ${run.pid} *> $null`, { timeoutMs: 30_000, signal }).catch(() => undefined);
      return { exitCode: null, timedOut: true };
    }
    if (!more) await sleep(restart.pollMs, undefined, { signal });
  }
}

/** When a Windows box last started, as it says. */
const BOOTED = "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')";

/** How a refresh restarts a Windows box and waits for it. */
export interface WindowsRestart {
  readonly timeoutMs: number;
  readonly pollMs: number;
  /** How long the box must answer with the same boot time before the next round: 90 s unless given. */
  readonly steadyMs?: number;
}

/** The box's boot time, as it says, or null when it does not answer. */
async function bootedAt(command: CommandTransport, signal: AbortSignal): Promise<string | null> {
  const result = await command.run(BOOTED, { timeoutMs: 15_000, signal }).catch(() => null);
  return result?.exitCode === 0 ? result.stdout.trim() || null : null;
}

/** Restarts a Windows box and waits until it has started anew and stays up. */
async function restartWindows(command: CommandTransport, options: WindowsRestart, say: (line: string) => void, signal: AbortSignal): Promise<void> {
  const before = await bootedAt(command, signal);
  if (!before) throw new Error("The box did not say when it started, before its restart.");
  // The connection may end before the command does.
  await command.run("Restart-Computer -Force", { timeoutMs: 30_000, signal }).catch(() => undefined);
  await steadyWindows(command, before, options, say, signal);
}

/**
 * Waits until a Windows box answers with a boot time other than `before`,
 * and with that same boot time for `steadyMs`. Windows finishes some updates
 * at the boot after the restart that installs them, then restarts once more
 * by itself: SSH answers for some 20 s in between (live, 16 October 2026). A
 * round that started then would meet the box going down again.
 */
async function steadyWindows(command: CommandTransport, before: string | null, options: WindowsRestart, say: (line: string) => void, signal: AbortSignal): Promise<void> {
  const steadyMs = options.steadyMs ?? 90_000;
  const started = Date.now();
  const until = started + options.timeoutMs;
  let seen: string | null = null;
  let since = 0;
  for (;;) {
    await sleep(options.pollMs, undefined, { signal });
    const now = await bootedAt(command, signal);
    if (now && now !== before && now !== seen) {
      say(
        seen
          ? `Windows restarted again by itself, as it finishes its updates: the box answers again ${Math.round((Date.now() - started) / 1000)} s after the restart; waiting for it to stay up ${Math.round(steadyMs / 1000)} s`
          : `the box answers again ${Math.round((Date.now() - started) / 1000)} s after the restart; waiting for it to stay up ${Math.round(steadyMs / 1000)} s, as Windows may restart again to finish its updates`,
      );
      seen = now;
      since = Date.now();
    }
    if (seen && now === seen && Date.now() - since >= steadyMs) return;
    if (Date.now() >= until) {
      throw new Error(
        seen
          ? `The box did not stay up for ${Math.round(steadyMs / 1000)} s within ${Math.round(options.timeoutMs / 60_000)} minutes of its restart.`
          : `The box did not answer within ${Math.round(options.timeoutMs / 60_000)} minutes of its restart.`,
      );
    }
  }
}

/** The record's checks against the old build's: whole, of this contract and kind, and no tool older (049). */
export function recordChecks(record: ImageRecord | null, old: ImageRecord | null, kind: string): RefreshCheck[] {
  if (!record) return [{ name: "the record", ok: false, detail: "The new build has no image record." }];
  const whole = record.contract === IMAGE_CONTRACT && !!record.os && !!record.pins && Object.keys(record.tools).length > 0;
  // A tool named by a hash of its source, as bb-box-stream is, has no order: a new hash is not older.
  const ordered = (version: string) => !/^[0-9a-f]{12,64}$/.test(version);
  const older = old
    ? Object.entries(old.tools).filter(([tool, version]) => {
        const now = record.tools[tool];
        return now !== undefined && ordered(now) && ordered(version) && compareVersions(now, version) < 0;
      })
    : [];
  const missing = old ? Object.keys(old.tools).filter((tool) => record.tools[tool] === undefined) : [];
  return [
    {
      name: "the record",
      ok: whole && parseImageRecord(record) !== null,
      detail: whole ? `Contract ${record.contract}, ${record.os}, ${Object.keys(record.tools).length} tools.` : `It is not whole: ${JSON.stringify(record).slice(0, 300)}`,
    },
    {
      name: "no tool older",
      ok: !older.length && !missing.length,
      detail: older.length || missing.length
        ? [...older.map(([tool, version]) => `${tool} ${record.tools[tool]} is older than ${version}`), ...missing.map((tool) => `${tool} is missing`)].join("; ") + "."
        : old
          ? `Each tool is as new as in ${old.build}, or newer.`
          : `The old build has no record to compare with${kind ? ` for ${kind}` : ""}.`,
    },
  ];
}

/** Runs `script` and says each line of its output as it comes. */
async function streamLines(command: CommandTransport, script: string, timeoutMs: number, signal: AbortSignal, say: (line: string) => void) {
  const rest = { stdout: "", stderr: "" };
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const result = await command.stream(script, {
    timeoutMs,
    signal,
    onOutput: (chunk, from) => {
      const parts = (rest[from] + decoders[from].decode(chunk, { stream: true })).split(/\r?\n|\r/);
      rest[from] = parts.pop() ?? "";
      for (const line of parts) if (line.trim()) say(line);
    },
  });
  for (const left of Object.values(rest)) if (left.trim()) say(left);
  return result;
}

/** Refreshes `current` and replaces it when every check passes. */
export async function refreshImage(options: RefreshOptions): Promise<RefreshResult> {
  const { images, current, signal } = options;
  const now = options.now ?? Date.now;
  const started = now();
  const output: string[] = [];
  const keep = (line: string) => {
    output.push(line);
    if (output.length > KEPT_LINES) output.shift();
  };
  const say = (line: string) => {
    keep(line);
    options.log?.(line);
  };
  const buildLog = new BuildLog(current.ref, started, options.buildLogDir);
  const buildOutput = (line: string) => {
    keep(line);
    const step = buildLog.write(line);
    if (step) options.log?.(step);
  };
  const checks: RefreshCheck[] = [];
  const made: string[] = [];
  // A box of a build, once the backend has room for it (#650). Only the attempt that made it is timed.
  const boxOf = async (build: ImageBuild, label: string): Promise<{ box: ImageBox; ms: number }> => {
    const room = options.room ?? ROOM;
    const until = Date.now() + room.waitMs;
    for (let told = 0; ; ) {
      const at = now();
      try {
        const box = await images.box(build, label, signal);
        return { box, ms: now() - at };
      } catch (error) {
        if (!(error instanceof BackendError && error.code === "no_capacity") || Date.now() >= until) throw error;
        if (Date.now() >= told) {
          say(`no room for the ${label} box: ${error.message} Waiting for room, up to ${Math.ceil((until - Date.now()) / 60_000)} more minutes.`);
          told = Date.now() + 5 * 60_000;
        }
        await sleep(room.pollMs, undefined, { signal });
      }
    }
  };
  const end = (ok: boolean, build: ImageBuild | null, reason: string | null): RefreshResult => ({
    ok,
    build,
    checks,
    reason,
    output,
    seconds: Math.round((now() - started) / 1000),
  });
  const staged = await mkdtemp(join(tmpdir(), "bb-box-refresh-"));
  try {
    const kind = current.kind;
    const windows = KIND_INFO[kind]?.os === "windows";
    if (!BUILDS[kind] && !images.build && !windows) return end(false, null, `bb-box refreshes no ${kind} image.`);
    if (!windows) {
      // A Linux image takes the versions a rebuild takes (versions.ts).
      const versions = await (options.versions ?? resolveVersions)(options.setup, { pinned: !!options.pinned, signal });
      for (const tool of versions.tools) if (tool.version !== tool.pinned || tool.kept?.startsWith("upstream")) say(`version: ${tool.name} ${tool.version} for ${tool.arch}${tool.kept ? ` (${tool.kept})` : ""}`);
      await stageSetup(options.setup, join(staged, "setup"), versions);
    }
    let captured: ImageBuild;
    let windowsCheck: string | undefined;
    if (windows) {
      // A Windows image (054): in a box of it, even where the backend builds its other images with a script.
      const arch = KIND_INFO[kind]!.arch;
      const pins = await windowsPins(options.setup, arch);
      const digest = await pinsDigest(options.setup, arch === "arm64" ? "windows-arm64" : "windows");
      if (!digest) return end(false, null, "bb-box could not read the Windows build script's pins.");
      windowsCheck = await readFile(join(options.setup, "windows", "check.ps1"), "utf8");
      windowsCheck = images.adaptCheck?.(kind, windowsCheck, options.setup) ?? windowsCheck;
      const buildId = newBuildId(now());
      const files: [string, string][] = [
        ["refresh.ps1", await readFile(join(options.setup, "windows", "refresh.ps1"), "utf8")],
        // bb-box-stream.exe (060): its source, and its install, which the refresh runs when either changes.
        ["bb-box-stream.cs", await readFile(join(options.setup, "windows", "bb-box-stream.cs"), "utf8")],
        ["install-stream.ps1", await readFile(join(options.setup, "windows", "install-stream.ps1"), "utf8")],
        // The pointer as the VirtIO GPU's hardware cursor, which bb-box-stream needs to leave it out of the video.
        ["hardware-cursor.ps1", await readFile(join(options.setup, "windows", "hardware-cursor.ps1"), "utf8")],
        // Proxmox's boot.ps1, which gives each clone its address at boot: a refresh keeps the image's first logon's copy otherwise.
        ...(kind === "windows-desktop" ? [["boot.ps1", await readFile(join(options.setup, "proxmox-qemu", "answer", "bb-box", "boot.ps1"), "utf8")] as [string, string]] : []),
        ["pins.json", `${JSON.stringify({ tools: pins }, null, 2)}\n`],
        ["image.json", `${JSON.stringify(windowsRecord(current, pins, buildId, now(), digest))}\n`],
        // The server whose BB app refresh.ps1 installs, so a box enrols without installing it (#916).
        ...(options.bbUrl ? [["bb-url", `${options.bbUrl}\n`] as [string, string]] : []),
      ];
      say(`building ${buildId} in a box of ${current.ref}`);
      const { box } = await boxOf(current, `refresh of ${current.ref}`);
      made.push(box.ref);
      for (const [name, text] of files) await box.command.writeFile(`${WINDOWS_DIR}\\${name}`, new TextEncoder().encode(text), { signal });
      const restart = options.restart ?? { timeoutMs: 20 * 60_000, pollMs: 5_000 };
      for (let round = 1; ; round++) {
        // Detached, so a link that drops does not end the round (#707).
        const built = await followWindows(box.command, options.buildTimeoutMs ?? 3 * 60 * 60_000, restart, signal, buildOutput);
        if (built === null) {
          // The run ended without an exit code, as when Windows restarts by itself: wait for the box, then the round runs again.
          if (round === WINDOWS_ROUNDS) return end(false, null, `refresh.ps1 ended without an exit code in round ${round}, as when Windows restarts by itself.`);
          say(`refresh.ps1 ended without an exit code in round ${round}, as when Windows restarts by itself; waiting for the box`);
          await steadyWindows(box.command, null, restart, say, signal);
          continue;
        }
        if (built.exitCode === 0) break;
        if (!restarts(built.exitCode)) return end(false, null, built.timedOut ? "The build ran out of time." : `The build failed with exit code ${built.exitCode}: ${output.at(-1) ?? ""}. Its whole output is in ${buildLog.path}.`);
        if (round === WINDOWS_ROUNDS) return end(false, null, `Windows still wanted a restart after ${WINDOWS_ROUNDS} rounds of updates.`);
        say(`restarting the box (round ${round} of ${WINDOWS_ROUNDS})`);
        await restartWindows(box.command, restart, say, signal);
      }
      await box.command.run(`Remove-Item '${WINDOWS_DIR}' -Recurse -Force -ErrorAction SilentlyContinue`, { timeoutMs: 60_000, signal });
      captured = await images.capture(box, current, "standard", signal);
      made.splice(made.indexOf(box.ref), 1, captured.ref);
    } else if (images.build) {
      // A backend whose standard images come from a build script, as Docker's do.
      say(`building a new build of ${current.ref}`);
      captured = await images.build(current, join(staged, "setup"), { bbUrl: options.bbUrl, log: buildOutput, signal });
      made.push(captured.ref);
    } else {
      const tar = spawnSync("tar", ["-C", join(staged, "setup"), "-czf", "-", "proxmox-lxc/template", "proxmox-lxc/host/common.sh", "proxmox-qemu/linux", "android"], { maxBuffer: 64 * 1024 * 1024 });
      if (tar.status !== 0) return end(false, null, `tar could not pack the setup files: ${tar.stderr.toString().trim()}`);

      // The build, in a box of the image.
      const buildId = newBuildId(now());
      say(`building ${buildId} in a box of ${current.ref}`);
      const { box } = await boxOf(current, `refresh of ${current.ref}`);
      made.push(box.ref);
      await box.command.writeFile("bb-box-setup.tgz", tar.stdout, { signal });
      const built = await streamLines(box.command, buildScript(kind, options.bbUrl, buildId), options.buildTimeoutMs ?? 90 * 60_000, signal, buildOutput);
      if (built.exitCode !== 0) return end(false, null, built.timedOut ? "The build ran out of time." : `The build failed with exit code ${built.exitCode}: ${output.at(-1) ?? ""}. Its whole output is in ${buildLog.path}.`);

      // The capture.
      captured = await images.capture(box, current, "standard", signal);
      made.splice(made.indexOf(box.ref), 1, captured.ref);
    }
    say(`captured ${captured.build} as ${captured.ref}`);

    // The checks before replacing (049), on a trial box, against a box of the old build.
    const timed = async (build: ImageBuild, label: string) => {
      const { box: trial, ms } = await boxOf(build, label);
      made.push(trial.ref);
      return { trial, ms };
    };
    // Where the backend times its steps, which of them took the time.
    const stepsOf = (box: ImageBox) => (box.steps?.length ? ` (${box.steps.map((one) => `${one.name} ${(one.ms / 1000).toFixed(1)} s`).join(", ")})` : "");
    const baseline = await timed(current, `answer time of ${current.build ?? current.ref}`);
    await images.remove(baseline.trial.ref, signal);
    made.splice(made.indexOf(baseline.trial.ref), 1);
    const { trial, ms } = await timed(captured, `trial of ${captured.build}`);
    const sample = (box: ImageBox, time: number) => `${(time / 1000).toFixed(1)} s${stepsOf(box)}`;
    let answered = { ok: ms <= baseline.ms + SLOWER_MS, detail: `A box of the new build answered in ${sample(trial, ms)}, of the old in ${sample(baseline.trial, baseline.ms)}.` };
    if (!answered.ok) {
      // One stall on the host, as a Mac's SSH can have, is not the build's: a second box of each, and the better of each.
      say(`a box of the new build answered in ${(ms / 1000).toFixed(1)} s, of the old in ${(baseline.ms / 1000).toFixed(1)} s; timing a second box of each`);
      const old = await timed(current, `second answer time of ${current.build ?? current.ref}`);
      await images.remove(old.trial.ref, signal);
      made.splice(made.indexOf(old.trial.ref), 1);
      const again = await timed(captured, `second answer time of ${captured.build}`);
      await images.remove(again.trial.ref, signal);
      made.splice(made.indexOf(again.trial.ref), 1);
      answered = {
        ok: Math.min(ms, again.ms) <= Math.min(baseline.ms, old.ms) + SLOWER_MS,
        detail: `Boxes of the new build answered in ${sample(trial, ms)} and ${sample(again.trial, again.ms)}, of the old in ${sample(baseline.trial, baseline.ms)} and ${sample(old.trial, old.ms)}.`,
      };
    }
    checks.push({ name: "answers as quickly", ...answered });
    const check = trialCheck(images, kind, windowsCheck);
    const ran = await trial.command.run(check.script, { timeoutMs: 10 * 60_000, signal, maxOutputBytes: 256 * 1024 });
    const failed = ran.stdout.split("\n").filter((line) => /\bFAIL\b/.test(line));
    for (const line of ran.stdout.split("\n").filter((line) => line.trim())) say(`check: ${line}`);
    checks.push({
      name: check.name,
      ok: ran.exitCode !== null && !failed.length && ran.stdout.trim() !== "",
      detail: failed.length ? failed.join(" | ").slice(0, 600) : ran.stdout.trim() ? `${ran.stdout.trim().split("\n").length} checks passed.` : `It printed nothing: ${ran.stderr.trim().slice(0, 300)}`,
    });
    if (options.bbUrl) {
      const read = windows
        ? "Get-Content \"$HOME\\.bb-machines\\*\\host-artifact.sha256\" -ErrorAction SilentlyContinue | Select-Object -First 1"
        : "cat ~/.bb-machines/*/host-artifact.sha256 2>/dev/null | head -n 1";
      const app = await trial.command.run(read, { timeoutMs: 15_000, signal });
      const has = app.stdout.trim();
      checks.push({
        name: "BB's app",
        ok: !!has && has === captured.record?.bbApp && (!options.bbApp || has === options.bbApp),
        detail: has ? `The box has BB's app ${has.slice(0, 12)}, the record ${captured.record?.bbApp?.slice(0, 12) ?? "none"}, the server ${options.bbApp?.slice(0, 12) ?? "unknown"}.` : "The box has no BB's app.",
      });
    }
    checks.push(...recordChecks(captured.record, current.record, kind));
    await images.remove(trial.ref, signal);
    made.splice(made.indexOf(trial.ref), 1);

    const failing = checks.filter((one) => !one.ok);
    if (failing.length) return end(false, null, `The new build failed ${failing.map((one) => `${one.name}: ${one.detail}`).join(" ")}`);
    if (options.replace === false) {
      say(`passed its checks; ${current.ref} stays, as this was a try`);
      return end(true, null, null);
    }
    const replaced = await images.replace(captured, current, signal);
    made.splice(made.indexOf(captured.ref), 1);
    say(`replaced ${current.ref} with ${replaced.build}`);
    return end(true, replaced, null);
  } catch (error) {
    return end(false, null, error instanceof Error ? error.message : String(error));
  } finally {
    // What the refresh made and did not hand over goes, the newest first.
    for (const ref of made.reverse()) await images.remove(ref).catch((error) => say(`could not remove ${ref}: ${error instanceof Error ? error.message : String(error)}`));
    await rm(staged, { recursive: true, force: true });
  }
}
