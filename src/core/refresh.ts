/**
 * Refreshing a standard Linux image (049): its guest scripts run again in a
 * box of it, with the versions a rebuild takes (versions.ts) and BB's app,
 * then finalizing, a capture, the checks before replacing on a trial box,
 * and the replace. A failure keeps the old build, removes what the refresh
 * made, and says why with the build's last lines.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE_CONTRACT, parseImageRecord, type ImageRecord } from "../backends/images.ts";
import type { BackendImages, ImageBox, ImageBuild } from "../backends/types.ts";
import { compareVersions, resolveVersions, stageSetup } from "../backends/versions.ts";
import { quote } from "../transports/process.ts";

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
/** Where the build's files go in the box, as build.sh puts them in its CT. */
const BUILD_DIR = "/var/tmp/bb-box-build";

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
    `sudo tee ${src}/build.env >/dev/null <<EOF`,
    "BOX_USER=box",
    'BOX_DNS="$dns"',
    `BB_URL=${quote(bbUrl ?? "")}`,
    ...(build.gpu ? [`DESKTOP_GPU=${build.gpu}`] : []),
    ...(build.session ? [`DESKTOP_SESSION=${build.session}`] : []),
    `BUILD_ID=${buildId}`,
    "EOF",
    'arch=x86_64; [ "$(uname -m)" = x86_64 ] || arch=arm64',
    `sudo env BBBOX_ENV=/nonexistent BBBOX_BB_URL=${quote(bbUrl ?? "")} bash ${src}/fetch-artifacts.sh ${src}/artifacts ${build.artifacts} "$arch"`,
    `sudo bash ${src}/guest/customize-base.sh ${src}`,
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
export function trialCheck(images: BackendImages, kind: string): { readonly name: string; readonly script: string } {
  const check = images.check?.(kind) ?? BUILDS[kind]?.check ?? "false";
  return {
    name: images.check ? "the kind's check" : `the kind's check (${check})`,
    script: images.check ? check : `for i in $(seq 1 60); do [ ! -e /etc/systemd/system/bb-box-display.service ] || [ -s /run/bb-box/display-mode ] && break; sleep 1; done; ${check}`,
  };
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
    if (!BUILDS[kind] && !images.build) return end(false, null, `bb-box refreshes no ${kind} image.`);
    const versions = await (options.versions ?? resolveVersions)(options.setup, { pinned: !!options.pinned, signal });
    for (const tool of versions.tools) if (tool.version !== tool.pinned || tool.kept?.startsWith("upstream")) say(`version: ${tool.name} ${tool.version} for ${tool.arch}${tool.kept ? ` (${tool.kept})` : ""}`);
    await stageSetup(options.setup, join(staged, "setup"), versions);
    let captured: ImageBuild;
    if (images.build) {
      // A backend whose standard images come from a build script, as Docker's do.
      say(`building a new build of ${current.ref}`);
      captured = await images.build(current, join(staged, "setup"), { bbUrl: options.bbUrl, log: say, signal });
      made.push(captured.ref);
    } else {
      const tar = spawnSync("tar", ["-C", join(staged, "setup"), "-czf", "-", "proxmox-lxc/template", "proxmox-lxc/host/common.sh"], { maxBuffer: 64 * 1024 * 1024 });
      if (tar.status !== 0) return end(false, null, `tar could not pack the setup files: ${tar.stderr.toString().trim()}`);

      // The build, in a box of the image.
      const buildId = newBuildId(now());
      say(`building ${buildId} in a box of ${current.ref}`);
      const box: ImageBox = await images.box(current, `refresh of ${current.ref}`, signal);
      made.push(box.ref);
      await box.command.writeFile("bb-box-setup.tgz", tar.stdout, { signal });
      const rest = { stdout: "", stderr: "" };
      const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
      const built = await box.command.stream(buildScript(kind, options.bbUrl, buildId), {
        timeoutMs: options.buildTimeoutMs ?? 90 * 60_000,
        signal,
        onOutput: (chunk, from) => {
          const parts = (rest[from] + decoders[from].decode(chunk, { stream: true })).split(/\r?\n|\r/);
          rest[from] = parts.pop() ?? "";
          for (const line of parts) if (line.trim()) say(line);
        },
      });
      for (const left of Object.values(rest)) if (left.trim()) say(left);
      if (built.exitCode !== 0) return end(false, null, built.timedOut ? "The build ran out of time." : `The build failed with exit code ${built.exitCode}: ${output.at(-1) ?? ""}`);

      // The capture.
      captured = await images.capture(box, current, "standard", signal);
      made.splice(made.indexOf(box.ref), 1, captured.ref);
    }
    say(`captured ${captured.build} as ${captured.ref}`);

    // The checks before replacing (049), on a trial box, against a box of the old build.
    const timed = async (build: ImageBuild, label: string) => {
      const at = now();
      const trial = await images.box(build, label, signal);
      made.push(trial.ref);
      return { trial, ms: now() - at };
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
    const check = trialCheck(images, kind);
    const ran = await trial.command.run(check.script, { timeoutMs: 10 * 60_000, signal, maxOutputBytes: 256 * 1024 });
    const failed = ran.stdout.split("\n").filter((line) => /\bFAIL\b/.test(line));
    for (const line of ran.stdout.split("\n").filter((line) => line.trim())) say(`check: ${line}`);
    checks.push({
      name: check.name,
      ok: ran.exitCode !== null && !failed.length && ran.stdout.trim() !== "",
      detail: failed.length ? failed.join(" | ").slice(0, 600) : ran.stdout.trim() ? `${ran.stdout.trim().split("\n").length} checks passed.` : `It printed nothing: ${ran.stderr.trim().slice(0, 300)}`,
    });
    if (options.bbUrl) {
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
