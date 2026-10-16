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
import { IMAGE_CONTRACT, parseImageRecord, pinsDigest, type ImageRecord } from "../backends/images.ts";
import { KIND_INFO } from "../backends/kinds.ts";
import { BackendError, type BackendImages, type ImageBox, type ImageBuild } from "../backends/types.ts";
import { compareVersions, resolveVersions, stageSetup } from "../backends/versions.ts";
import { quote } from "../transports/process.ts";
import type { CommandTransport } from "../transports/types.ts";

/** How each Linux kind's standard image is built, as template/build.sh builds it. */
const BUILDS: Readonly<Record<string, { readonly artifacts: string; readonly finalize: string; readonly gpu: string; readonly session: string; readonly check: string }>> = {
  linux: { artifacts: "linux", finalize: "linux", gpu: "", session: "", check: "bb-box-check-headless" },
  "linux-desktop": { artifacts: "desktop", finalize: "desktop", gpu: "nvidia", session: "", check: "bb-box-check-desktop" },
  "linux-desktop-cpu": { artifacts: "desktop-cpu", finalize: "desktop", gpu: "none", session: "", check: "bb-box-check-desktop" },
  "linux-desktop-wayland-cpu": { artifacts: "desktop-wayland-cpu", finalize: "desktop", gpu: "none", session: "wayland", check: "bb-box-check-desktop" },
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
  /** Each line of the build's output, as it comes. */
  readonly log?: (line: string) => void;
  /** How long the guest scripts may take. */
  readonly buildTimeoutMs?: number;
  /** Replaces resolveVersions, for tests. */
  readonly versions?: typeof resolveVersions;
  /** Replaces the clock, for tests. */
  readonly now?: () => number;
  /** How long to wait for room for a box when the backend has none, and how often to ask (#650). */
  readonly room?: { readonly waitMs: number; readonly pollMs: number };
  /** How long a Windows box may take to come back after a restart, and how often to ask. */
  readonly restart?: { readonly timeoutMs: number; readonly pollMs: number };
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
    "EOF",
    'arch=x86_64; [ "$(uname -m)" = x86_64 ] || arch=arm64',
    `sudo env BBBOX_ENV=/nonexistent BBBOX_BB_URL=${quote(bbUrl ?? "")} bash ${src}/fetch-artifacts.sh ${src}/artifacts ${build.artifacts} "$arch"`,
    `sudo bash ${src}/guest/customize-base.sh ${src}`,
    `[ "$runtime" != vm ] || sudo bash ${BUILD_DIR}/proxmox-qemu/linux/customize-vm.sh ${src}`,
    ...(build.finalize === "desktop" ? [`sudo bash ${src}/guest/customize-desktop.sh ${src}`] : []),
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
 * pins setup/windows/pins.json has.
 */
export function windowsRecord(current: ImageBuild, pins: readonly WindowsPin[], buildId: string, built: number, digest: string): ImageRecord {
  const arch = KIND_INFO[current.kind]?.arch ?? "x86_64";
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
    tools: { ...current.record?.tools, ...Object.fromEntries(pins.map((pin) => [pin.name, pin.version])) },
    nvidia: null,
    layer: null,
    sizeGiB: null,
  };
}

/** The script that runs refresh.ps1 in a Windows box, from the files the refresh put there. */
export function windowsRefreshScript(): string {
  return `& '${WINDOWS_DIR}\\refresh.ps1' -Pins '${WINDOWS_DIR}\\pins.json' -Record '${WINDOWS_DIR}\\image.json'; exit $LASTEXITCODE`;
}

/** When a Windows box last started, as it says. */
const BOOTED = "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')";

/** Restarts a Windows box and waits until it answers again, started anew. */
async function restartWindows(command: CommandTransport, options: { readonly timeoutMs: number; readonly pollMs: number }, signal: AbortSignal): Promise<void> {
  const booted = async () => {
    const result = await command.run(BOOTED, { timeoutMs: 15_000, signal }).catch(() => null);
    return result?.exitCode === 0 ? result.stdout.trim() : null;
  };
  const before = await booted();
  if (!before) throw new Error("The box did not say when it started, before its restart.");
  // The connection may end before the command does.
  await command.run("Restart-Computer -Force", { timeoutMs: 30_000, signal }).catch(() => undefined);
  const until = Date.now() + options.timeoutMs;
  for (;;) {
    await sleep(options.pollMs, undefined, { signal });
    const now = await booted();
    if (now && now !== before) return;
    if (Date.now() >= until) throw new Error(`The box did not answer within ${Math.round(options.timeoutMs / 60_000)} minutes of its restart.`);
  }
}

/** The record's checks against the old build's: whole, of this contract and kind, and no tool older (049). */
export function recordChecks(record: ImageRecord | null, old: ImageRecord | null, kind: string): RefreshCheck[] {
  if (!record) return [{ name: "the record", ok: false, detail: "The new build has no image record." }];
  const whole = record.contract === IMAGE_CONTRACT && !!record.os && !!record.pins && Object.keys(record.tools).length > 0;
  const older = old ? Object.entries(old.tools).filter(([tool, version]) => record.tools[tool] !== undefined && compareVersions(record.tools[tool]!, version) < 0) : [];
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
  const say = (line: string) => {
    output.push(line);
    if (output.length > KEPT_LINES) output.shift();
    options.log?.(line);
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
        ["pins.json", `${JSON.stringify({ tools: pins }, null, 2)}\n`],
        ["image.json", `${JSON.stringify(windowsRecord(current, pins, buildId, now(), digest))}\n`],
      ];
      say(`building ${buildId} in a box of ${current.ref}`);
      const { box } = await boxOf(current, `refresh of ${current.ref}`);
      made.push(box.ref);
      for (const [name, text] of files) await box.command.writeFile(`${WINDOWS_DIR}\\${name}`, new TextEncoder().encode(text), { signal });
      for (let round = 1; ; round++) {
        const built = await streamLines(box.command, windowsRefreshScript(), options.buildTimeoutMs ?? 3 * 60 * 60_000, signal, say);
        if (built.exitCode === 0) break;
        if (!restarts(built.exitCode)) return end(false, null, built.timedOut ? "The build ran out of time." : `The build failed with exit code ${built.exitCode}: ${output.at(-1) ?? ""}`);
        if (round === WINDOWS_ROUNDS) return end(false, null, `Windows still wanted a restart after ${WINDOWS_ROUNDS} rounds of updates.`);
        say(`restarting the box (round ${round} of ${WINDOWS_ROUNDS})`);
        await restartWindows(box.command, options.restart ?? { timeoutMs: 20 * 60_000, pollMs: 5_000 }, signal);
      }
      await box.command.run(`Remove-Item '${WINDOWS_DIR}' -Recurse -Force -ErrorAction SilentlyContinue`, { timeoutMs: 60_000, signal });
      captured = await images.capture(box, current, "standard", signal);
      made.splice(made.indexOf(box.ref), 1, captured.ref);
    } else if (images.build) {
      // A backend whose standard images come from a build script, as Docker's do.
      say(`building a new build of ${current.ref}`);
      captured = await images.build(current, join(staged, "setup"), { bbUrl: options.bbUrl, log: say, signal });
      made.push(captured.ref);
    } else {
      const tar = spawnSync("tar", ["-C", join(staged, "setup"), "-czf", "-", "proxmox-lxc/template", "proxmox-lxc/host/common.sh", "proxmox-qemu/linux"], { maxBuffer: 64 * 1024 * 1024 });
      if (tar.status !== 0) return end(false, null, `tar could not pack the setup files: ${tar.stderr.toString().trim()}`);

      // The build, in a box of the image.
      const buildId = newBuildId(now());
      say(`building ${buildId} in a box of ${current.ref}`);
      const { box } = await boxOf(current, `refresh of ${current.ref}`);
      made.push(box.ref);
      await box.command.writeFile("bb-box-setup.tgz", tar.stdout, { signal });
      const built = await streamLines(box.command, buildScript(kind, options.bbUrl, buildId), options.buildTimeoutMs ?? 90 * 60_000, signal, say);
      if (built.exitCode !== 0) return end(false, null, built.timedOut ? "The build ran out of time." : `The build failed with exit code ${built.exitCode}: ${output.at(-1) ?? ""}`);

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
    const baseline = await timed(current, `answer time of ${current.build ?? current.ref}`);
    await images.remove(baseline.trial.ref, signal);
    made.splice(made.indexOf(baseline.trial.ref), 1);
    const { trial, ms } = await timed(captured, `trial of ${captured.build}`);
    checks.push({
      name: "answers as quickly",
      ok: ms <= baseline.ms + SLOWER_MS,
      detail: `A box of the new build answered in ${(ms / 1000).toFixed(1)} s, of the old in ${(baseline.ms / 1000).toFixed(1)} s.`,
    });
    const check = trialCheck(images, kind, windowsCheck);
    const ran = await trial.command.run(check.script, { timeoutMs: 10 * 60_000, signal, maxOutputBytes: 256 * 1024 });
    const failed = ran.stdout.split("\n").filter((line) => /\bFAIL\b/.test(line));
    for (const line of ran.stdout.split("\n").filter((line) => line.trim())) say(`check: ${line}`);
    checks.push({
      name: check.name,
      ok: ran.exitCode !== null && !failed.length && ran.stdout.trim() !== "",
      detail: failed.length ? failed.join(" | ").slice(0, 600) : ran.stdout.trim() ? `${ran.stdout.trim().split("\n").length} checks passed.` : `It printed nothing: ${ran.stderr.trim().slice(0, 300)}`,
    });
    // Windows boxes have no BB app in the image yet.
    if (options.bbUrl && !windows) {
      const app = await trial.command.run("cat ~/.bb-machines/*/host-artifact.sha256 2>/dev/null | head -n 1", { timeoutMs: 15_000, signal });
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
