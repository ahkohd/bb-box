import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { abortable } from "../../core/abortable.ts";
import { setupDir } from "../setup-dir.ts";
import type { BackendStorage } from "../types.ts";
import type { RunResult } from "../../transports/types.ts";
import { BoatError, isRunning, isStarting, isStopped, type BoatApi, type Sandbox, type SandboxSize } from "./api.ts";
import { BOAT_TEMPLATE_KINDS, type BoatKind } from "./config.ts";
import type { BoatOwner } from "./owner.ts";
import { PRODUCT } from "../../brand.ts";

export const TEMPLATE_ROLE = "template";
export const TRIAL_ROLE = "template-trial";
export const TEMPLATE_SIZE: SandboxSize = "default";
export const TEMPLATE_REBUILT_AFTER_MS = 7 * 24 * 3_600_000;
export const RETIRED_TEMPLATE_KEPT_MS = 60 * 60_000;
export const LEFT_BUILD_GRACE_MS = 10 * 60_000;
export const BUILD_TTL_SECONDS = 2 * 3600;
export const TEMPLATE_FILES = [
  "android/bb-box-device-firewall",
  "android/bb-box-emulator",
  "android/bb-box-h264/encoder.h",
  "android/bb-box-h264/main.c",
  "android/bb-box-h264/openh264.c",
  "android/bb-box-h264/simulator.m",
  "android/bb-box-h264/x264.c",
  "android/build-h264.sh",
  "android/check-android.sh",
  "android/clear-device-state.sh",
  "android/customize-android.sh",
  "android/device-firewall.nft",
  "android/pins.json",
  "android/prepare-avds.sh",
  "boat/customize-sandbox.sh",
  "boat/template.sh",
  "proxmox-lxc/host/common.sh",
  "proxmox-lxc/template/apt-snapshot",
  "proxmox-lxc/template/baseline-packages.txt",
  "proxmox-lxc/template/desktop-pins.tsv",
  "proxmox-lxc/template/fetch-artifacts.sh",
  "proxmox-lxc/template/guest/apt.sh",
  "proxmox-lxc/template/guest/baseline.sh",
  "proxmox-lxc/template/guest/bb-box-feature.sh",
  "proxmox-lxc/template/guest/bb-box-identity.sh",
  "proxmox-lxc/template/guest/bb-box-nvidia-drivers.sh",
  "proxmox-lxc/template/guest/check-desktop.sh",
  "proxmox-lxc/template/guest/check-headless.sh",
  "proxmox-lxc/template/guest/customize-base.sh",
  "proxmox-lxc/template/guest/customize-desktop.sh",
  "proxmox-lxc/template/guest/files/bb-box-nofbc.c",
  "proxmox-lxc/template/guest/files/chrome-gpu.mjs",
  "proxmox-lxc/template/guest/files/cua-probe.mjs",
  "proxmox-lxc/template/guest/files/display",
  "proxmox-lxc/template/guest/files/selkies",
  "proxmox-lxc/template/guest/files/selkies-probe.mjs",
  "proxmox-lxc/template/guest/files/vnc-password",
  "proxmox-lxc/template/guest/finalize.sh",
  "proxmox-lxc/template/guest/image-record.sh",
  "proxmox-lxc/template/guest/install-bb-app.sh",
  "proxmox-lxc/template/guest/install-tools.sh",
  "proxmox-lxc/template/guest/nvidia-userspace.sh",
  "proxmox-lxc/template/pins.json",
] as const;
const BUILD_DIR = "/var/tmp/bb-box-build";
const BUILD_STATE = "/run/bb-box-build";
const IN_HAND_ELSEWHERE = 75;
export const OUT_OF_BOATS_HOME = "cd /";
const DESKTOP_UP = 'pgrep -x xfwm4 >/dev/null && test -S "$HOME/.cache/cua-driver/cua-driver.sock"';
export const CUA_READY = [
  "for round in 1 2 3 4 5 6; do",
  "  systemctl --user restart bb-box-cua-driver.service",
  '  for attempt in 1 2 3 4; do if timeout 6 node /usr/local/libexec/bb-box/cua-probe.mjs --socket "$HOME/.cache/cua-driver/cua-driver.sock" >/dev/null 2>&1; then exit 0; fi; sleep 1; done',
  "done",
  'echo "Cua Driver did not answer over MCP after 6 restarts in about 3 minutes." >&2',
  "journalctl --user -u bb-box-cua-driver.service -n 5 --no-pager -o cat >&2 2>/dev/null || :",
  "exit 1",
].join("\n");
const BUILD_POLL_MS = 10_000;
const FAILED_BUILD_LOG_LINES = 120;
const BUILD_RENEW_MS = 15 * 60_000;
const CUSTOMIZE_WITHIN_MS = 90 * 60_000;
const FINALIZE_WITHIN_MS = 20 * 60_000;
const GUEST_SCRIPTS_WITHIN_MS = CUSTOMIZE_WITHIN_MS + FINALIZE_WITHIN_MS;
const STAGE_WITHIN_MS = 3 * 60_000;
const STATE_WITHIN_MS = 10 * 60_000;
export const ARCHIVE_WITHIN_MS = 60 * 60_000;
const RECORD = "template/";
const FAILED = "template-failed/";
export const FAILED_BUILD_RETRY_MS = 6 * 3_600_000;
export const LEFT_BUILD_WHY = `a build was going when ${PRODUCT} restarted`;
const RETIRED = "retired-templates";

export const TEMPLATE_STEP: Readonly<Record<BoatKind, "linux" | "desktop" | "android">> = { linux: "linux", "linux-desktop-cpu": "desktop", android: "android" };
export const TEMPLATE_CHECK: Readonly<Record<BoatKind, string>> = { linux: "bb-box-check-headless", "linux-desktop-cpu": "bb-box-check-desktop", android: "bb-box-check-android" };
const USUAL_BUILD_MINUTES: Readonly<Record<BoatKind, number>> = { linux: 6, "linux-desktop-cpu": 12, android: 30 };
const KIND_WORDS: Readonly<Record<BoatKind, string>> = { linux: "Linux", "linux-desktop-cpu": "Linux desktop", android: "Android" };
const ANDROID_DEVICES_FILE = "/usr/share/bb-box/android-devices.json";

export interface TemplateRecord {
  readonly kind: BoatKind;
  readonly sandbox: string;
  readonly key: string;
  readonly builtAt: number;
  readonly buildMs: number;
  readonly usedAt: number | null;
  readonly devices?: readonly unknown[] | null;
}

export interface FailedBuild {
  readonly at: number;
  readonly why: string;
  readonly sandbox?: string;
}

interface RetiredTemplate {
  readonly sandbox: string;
  readonly retiredAt: number;
}

export interface TemplateLabels {
  readonly install: string;
  readonly role: string;
  readonly kind: string;
  readonly key: string;
  readonly template: string;
}

export type TemplateStage = "building" | "checking" | "ready";

export function templateName(kind: BoatKind, stage: TemplateStage): string {
  return stage === "ready" ? `bb-box ${kind} template` : `bb-box ${kind} template, ${stage}`;
}

export interface StagedFiles {
  readonly buildEnv: string;
  readonly publicKey: string;
  readonly licence: string | null;
}

export interface GuestBuild {
  readonly running: boolean;
  readonly started: boolean;
  readonly staged: boolean;
  readonly stateKept: boolean;
  readonly customized: number | null;
  readonly finalized: number | null;
  readonly tail: readonly string[];
}

export type GuestStep = "finished" | "customize-failed" | "finalize-failed" | "running" | "died" | "unstaged";

export class BuildLeftRunning extends Error {}

export interface Reached {
  run(script: string, options: { readonly stdin?: Buffer | string; readonly timeoutMs: number; readonly signal?: AbortSignal }): Promise<RunResult>;
}

export interface TemplateDeps {
  readonly api: BoatApi;
  readonly storage: BackendStorage;
  readonly owner: BoatOwner;
  readonly logName: string;
  readonly labelKeys: TemplateLabels;
  readonly publicKey: () => Promise<string>;
  readonly reach: (sandbox: string, user: "user" | "box", signal?: AbortSignal) => Promise<Reached>;
  readonly forget: (sandbox: string) => Promise<void>;
  readonly answers: (sandbox: string, user: "user" | "box", deadline: number, signal?: AbortSignal) => Promise<void>;
  readonly settled: (sandbox: string, deadline: number, signal?: AbortSignal) => Promise<void>;
  readonly restored: (sandbox: string, deadline: number, signal?: AbortSignal) => Promise<void>;
  readonly cuaReady?: string;
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly log: (line: string) => void;
  readonly fingerprint?: () => string;
  readonly setupArchive?: () => Promise<Buffer>;
  readonly buildEnv?: (kind: BoatKind) => string;
  readonly androidLicence?: () => string | null;
  readonly sizeFor?: (kind: BoatKind) => Promise<SandboxSize>;
}

export const IDENTITY_VALUE_FILE = "/run/ascii-secrets/env.sh";
export const IDENTITY_RESET_KINDS: readonly BoatKind[] = ["linux", "linux-desktop-cpu"];

export function identityBuildSettings(kind: BoatKind): readonly string[] {
  if (!IDENTITY_RESET_KINDS.includes(kind)) return ["BOX_IDENTITY_RESET=off"];
  return ["BOX_IDENTITY_RESET=on", `BOX_IDENTITY_VALUE_FILE=${IDENTITY_VALUE_FILE}`, "BOX_IDENTITY_MACHINE=provider"];
}

export function templateFingerprint(setup = setupDir()): string {
  const hash = createHash("sha256");
  for (const file of TEMPLATE_FILES) {
    const path = join(setup, file);
    hash.update(file).update("\0").update(existsSync(path) ? readFileSync(path) : "").update("\0");
  }
  for (const kind of BOAT_TEMPLATE_KINDS) hash.update(kind).update("\0").update(identityBuildSettings(kind).join("\n")).update("\0");
  return hash.digest("hex").slice(0, 12);
}

export function templateArchive(setup = setupDir()): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-czf", "-", "-C", setup.replace(/\/+$/, ""), ...TEMPLATE_FILES], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`tar could not pack ${PRODUCT}'s template scripts from ${dirname(setup)}: ${stderr.trim() || `exit ${code}`}`))));
  });
}

export function buildEnvFor(buildId: string, kind: BoatKind): string {
  return ["BOX_USER=box", "BOX_RUNTIME=vm", "DESKTOP_GPU=none", "BB_URL=", `BUILD_ID=${buildId}`, ...identityBuildSettings(kind), ""].join("\n");
}

export function buildWaitWords(kind: BoatKind, lastBuildMs: number | null): string {
  const minutes = lastBuildMs ? Math.max(1, Math.round(lastBuildMs / 60_000)) : USUAL_BUILD_MINUTES[kind];
  return `Building boat's ${KIND_WORDS[kind]} template first, which takes about ${minutes} minutes. Later boxes of this kind fork it and start in seconds.`;
}

export function guestJobScript(): string {
  return [
    'echo $$ > "$2/pid"',
    'bash "$1/boat/template.sh" customize "$3" > "$1/log" 2>&1 9>&-',
    "code=$?",
    'echo "$code" > "$2/customized"',
    '[ "$code" = 0 ] || exit 0',
    'bash "$1/boat/template.sh" finalize "$3" > "$2/finalize.log" 2>&1 9>&-',
    'echo "$?" > "$2/finalized"',
  ].join("\n");
}

export function stageScript(kind: BoatKind, files: StagedFiles): string {
  const write = (text: string, file: string, what: string) => `printf %s '${Buffer.from(text).toString("base64")}' | base64 -d > "$d/proxmox-lxc/template/${file}" || fail "could not ${what}"`;
  return [
    OUT_OF_BOATS_HOME,
    `d=${BUILD_DIR}`,
    `s=${BUILD_STATE}`,
    'fail() { echo "$1" >&2; exit 1; }',
    'mkdir -p "$s" || fail "could not make $s"',
    'exec 9>>"$s/lock"',
    `flock -w 5 9 || exit ${IN_HAND_ELSEWHERE}`,
    `[ ! -e "$s/pid" ] || exit ${IN_HAND_ELSEWHERE}`,
    `rm -rf "$d" && mkdir -p "$d" && : > "$d/log" && tar -xzf - -C "$d" || fail "could not unpack ${PRODUCT}'s template scripts"`,
    write(files.buildEnv, "build.env", "write the build's settings"),
    write(`${files.publicKey}\n`, "plugin-key.pub", `write ${PRODUCT}'s key`),
    ...(files.licence ? [write(`${files.licence}\n`, "android-sdk-license", "write the Android SDK licence's acceptance")] : []),
    `setsid nohup sh -c ${quote(guestJobScript())} sh "$d" "$s" ${TEMPLATE_STEP[kind]} </dev/null >/dev/null 2>&1 &`,
  ].join("\n");
}

export function progressScript(): string {
  return [
    `d=${BUILD_DIR}`,
    `s=${BUILD_STATE}`,
    'if [ -e "$s/lock" ] && ! flock -n "$s/lock" true; then echo running=yes; else echo running=no; fi',
    'if [ -s "$s/pid" ]; then echo started=yes; else echo started=no; fi',
    'if [ -e "$d/log" ]; then echo staged=yes; else echo staged=no; fi',
    'if [ -e "$s/lock" ]; then echo state=yes; else echo state=no; fi',
    'echo "customized=$(cat "$s/customized" 2>/dev/null || true)"',
    'echo "finalized=$(cat "$s/finalized" 2>/dev/null || true)"',
    "echo --",
    'if [ -e "$s/finalize.log" ]; then tail -n 20 "$s/finalize.log"; else tail -n 20 "$d/log" 2>/dev/null; fi',
    "exit 0",
  ].join("\n");
}

export function guestBuildFrom(stdout: string): GuestBuild | null {
  const lines = stdout.split("\n");
  const end = lines.indexOf("--");
  if (end < 0) return null;
  const fields = new Map(lines.slice(0, end).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()] as const));
  const flag = (name: string) => fields.get(name) === "yes";
  const code = (name: string) => (/^\d+$/.test(fields.get(name) ?? "") ? Number(fields.get(name)) : null);
  if (!["running", "started", "staged", "state", "customized", "finalized"].every((name) => fields.has(name))) return null;
  return { running: flag("running"), started: flag("started"), staged: flag("staged"), stateKept: flag("state"), customized: code("customized"), finalized: code("finalized"), tail: lines.slice(end + 1).filter((line) => line !== "") };
}

export function guestStep(build: GuestBuild): GuestStep {
  if (build.finalized === 0) return "finished";
  if (build.finalized !== null) return "finalize-failed";
  if (build.customized !== null && build.customized !== 0) return "customize-failed";
  if (build.running) return "running";
  if (build.started || (build.staged && !build.stateKept)) return "died";
  return "unstaged";
}

function followable(sandbox: Sandbox, kind: BoatKind): boolean {
  if (sandbox.dataExpiredAt !== null) return false;
  if (isRunning(sandbox.state) || isStarting(sandbox.state)) return true;
  return isStopped(sandbox.state) && sandbox.name === templateName(kind, "checking");
}

function newestFirst(a: Sandbox, b: Sandbox): number {
  return (b.createdAt ?? 0) - (a.createdAt ?? 0);
}

export const CHECKS_BOAT_ANSWERS_FOR = [/^docker stopped after boot\b/];

export function failedChecks(output: string): string[] {
  return output.split("\n").filter((line) => /\bFAIL\b/.test(line) && !CHECKS_BOAT_ANSWERS_FOR.some((check) => check.test(line)));
}

const DOCKER_SCOPE_DID_NOT_START = /unable to start unit "?docker-[^\s"]+\.scope"?/i;

function dockerUnitDidNotStart(check: RunResult): boolean {
  if (check.exitCode === 0 && !failedChecks(check.stdout).length) return false;
  return DOCKER_SCOPE_DID_NOT_START.test(`${check.stdout}\n${check.stderr}`);
}

export class BoatTemplates {
  readonly #deps: TemplateDeps;
  readonly #building = new Map<BoatKind, Promise<TemplateRecord>>();
  readonly #buildSandboxes = new Set<string>();
  readonly #buildWasRunning = new Map<string, boolean>();
  readonly #failureLeft = new Map<BoatKind, string>();
  #disposed = false;

  constructor(deps: TemplateDeps) {
    this.#deps = deps;
  }

  key(): string {
    return (this.#deps.fingerprint ?? templateFingerprint)();
  }

  building(kind: BoatKind): boolean {
    return this.#building.has(kind);
  }

  buildSandboxes(): ReadonlySet<string> {
    return this.#buildSandboxes;
  }

  async record(kind: BoatKind): Promise<TemplateRecord | null> {
    return (await this.#deps.storage.get<TemplateRecord>(`${RECORD}${kind}`)) ?? null;
  }

  async whyBuild(kind: BoatKind): Promise<string | null> {
    const record = await this.record(kind);
    if (!record) return "there is none yet";
    if (record.key !== this.key()) return `${PRODUCT}'s template scripts changed`;
    if (this.#deps.now() - record.builtAt >= TEMPLATE_REBUILT_AFTER_MS) return "it is a week old";
    return null;
  }

  async forBox(kind: BoatKind, signal: AbortSignal, waiting?: (words: string | null) => Promise<void>): Promise<TemplateRecord> {
    const current = await this.record(kind);
    const there = current ? await this.#usable(current, signal) : false;
    let record = current && there ? current : await this.#adopt(kind, signal);
    if (!record) {
      await waiting?.(buildWaitWords(kind, current?.buildMs ?? null));
      try {
        record = await abortable(this.build(kind, current ? "its template is gone" : "there is none yet"), signal);
      } finally {
        await waiting?.(null);
      }
    }
    const used = { ...record, usedAt: this.#deps.now() };
    await this.#deps.storage.set(`${RECORD}${kind}`, used);
    return used;
  }

  async adoptable(kind: BoatKind, signal?: AbortSignal): Promise<Sandbox | null> {
    const labels = this.#deps.labelKeys;
    return (
      (await this.#deps.api.list({ [labels.role]: TEMPLATE_ROLE, [labels.kind]: kind, [labels.key]: this.key() }, signal))
        .filter((sandbox) => this.#deps.owner.madeByThisBackendId(sandbox.labels) && sandbox.state === "archived" && sandbox.dataExpiredAt === null && sandbox.name === templateName(kind, "ready") && !this.#buildSandboxes.has(sandbox.id))
        .sort(newestFirst)[0] ?? null
    );
  }

  async leftBuild(kind: BoatKind, signal?: AbortSignal): Promise<Sandbox | null> {
    return (await this.#leftBuilds(signal)).find((sandbox) => sandbox.labels[this.#deps.labelKeys.kind] === kind) ?? null;
  }

  async #leftBuilds(signal?: AbortSignal): Promise<Sandbox[]> {
    const labels = this.#deps.labelKeys;
    const recorded = await this.current();
    const kinds = Object.keys(TEMPLATE_STEP) as BoatKind[];
    return (await this.#deps.api.list({ [labels.install]: this.#deps.owner.installId, [labels.role]: TEMPLATE_ROLE, [labels.key]: this.key() }, signal))
      .filter((sandbox) => {
        const kind = kinds.find((each) => each === sandbox.labels[labels.kind]);
        return kind !== undefined && this.#deps.owner.owns(sandbox.labels) && !recorded.has(sandbox.id) && !this.#buildSandboxes.has(sandbox.id) && followable(sandbox, kind);
      })
      .sort(newestFirst);
  }

  async keepAdoptable(kind: BoatKind, signal?: AbortSignal): Promise<TemplateRecord | null> {
    const adopted = await this.#adopt(kind, signal);
    if (adopted) await this.#deps.storage.set(`${RECORD}${kind}`, adopted);
    return adopted;
  }

  async #adopt(kind: BoatKind, signal?: AbortSignal): Promise<TemplateRecord | null> {
    const found = await this.adoptable(kind, signal);
    if (!found) return null;
    this.#deps.log(`${this.#deps.logName}: using the ${kind} template ${found.id}, which bb-box built ${this.#deps.owner.owns(found.labels) ? "before" : "for another install on this account"}.`);
    let devices: readonly unknown[] | null = null;
    if (TEMPLATE_STEP[kind] === "android") {
      const text = await this.#deps.api.latestSnapshotFile(found.id, ANDROID_DEVICES_FILE, signal).catch(() => null);
      try {
        devices = text ? (JSON.parse(text) as unknown[]) : null;
      } catch {
        devices = null;
      }
      if (!Array.isArray(devices) || !devices.length) return null;
    }
    return { kind, sandbox: found.id, key: this.key(), builtAt: found.createdAt ?? this.#deps.now(), buildMs: 0, usedAt: null, ...(devices ? { devices } : {}) };
  }

  async #usable(record: TemplateRecord, signal?: AbortSignal): Promise<boolean> {
    const sandbox = await this.#deps.api.get(record.sandbox, signal);
    return sandbox !== null && sandbox.dataExpiredAt === null && sandbox.state !== "error";
  }

  async due(signal?: AbortSignal): Promise<{ readonly kind: BoatKind; readonly why: string }[]> {
    const due: { kind: BoatKind; why: string }[] = [];
    const left = await this.#leftBuilds(signal);
    for (const kind of Object.keys(TEMPLATE_STEP) as BoatKind[]) {
      if (this.#building.has(kind)) continue;
      const pending = left.find((sandbox) => sandbox.labels[this.#deps.labelKeys.kind] === kind);
      if (pending) {
        if (TEMPLATE_STEP[kind] === "android" && !this.#deps.androidLicence?.()) continue;
        const failed = await this.failedBuild(kind);
        if (failed?.sandbox === pending.id && (await this.failedLately(kind))) continue;
        due.unshift({ kind, why: LEFT_BUILD_WHY });
        continue;
      }
      const record = await this.record(kind);
      if (!record || (await this.failedLately(kind))) continue;
      const why = await this.whyBuild(kind);
      if (!why) continue;
      const adopted = why === "it is a week old" ? null : await this.#adopt(kind, signal);
      if (adopted && adopted.sandbox !== record.sandbox) {
        await this.#deps.storage.set(`${RECORD}${kind}`, { ...adopted, usedAt: record.usedAt });
        if (adopted.sandbox !== record.sandbox && record.key !== adopted.key) await this.#retire(record.sandbox);
        continue;
      }
      due.push({ kind, why });
    }
    return due;
  }

  anyBuilding(): boolean {
    return this.#building.size > 0;
  }

  async failedBuild(kind: BoatKind): Promise<FailedBuild | null> {
    return (await this.#deps.storage.get<FailedBuild>(`${FAILED}${kind}`)) ?? null;
  }

  async failedLately(kind: BoatKind): Promise<boolean> {
    const failed = await this.failedBuild(kind);
    return failed !== null && this.#deps.now() - failed.at < FAILED_BUILD_RETRY_MS;
  }

  build(kind: BoatKind, why: string): Promise<TemplateRecord> {
    let building = this.#building.get(kind);
    if (!building) {
      building = this.#build(kind, why)
        .then(async (record) => {
          await this.#deps.storage.delete(`${FAILED}${kind}`);
          return record;
        })
        .catch(async (error: unknown) => {
          if (!this.#leaving(error)) {
            const sandbox = this.#failureLeft.get(kind);
            await this.#deps.storage.set(`${FAILED}${kind}`, { at: this.#deps.now(), why: (error instanceof Error ? error.message : String(error)).slice(0, 600), ...(sandbox ? { sandbox } : {}) });
          }
          this.#failureLeft.delete(kind);
          throw error;
        })
        .finally(() => this.#building.delete(kind));
      building.catch(() => undefined);
      this.#building.set(kind, building);
    }
    return building;
  }

  async #build(kind: BoatKind, why: string): Promise<TemplateRecord> {
    const { api, now, log } = this.#deps;
    this.#failureLeft.delete(kind);
    const started = now();
    const key = this.key();
    const size = (await this.#deps.sizeFor?.(kind).catch(() => null)) ?? TEMPLATE_SIZE;
    const licence = TEMPLATE_STEP[kind] === "android" ? (this.#deps.androidLicence?.() ?? null) : null;
    this.#stillHere();
    const left = await this.leftBuild(kind);
    if (TEMPLATE_STEP[kind] === "android" && !licence) {
      if (left) throw new BuildLeftRunning(`boat leaves the Android template build ${left.id} until it expires, because the Android SDK's licence is not accepted.`);
      throw new Error("boat's Android template needs the Android SDK's licence accepted in BB Box's settings first.");
    }
    if (left) log(`${this.#deps.logName}: following the ${kind} template build ${left.id}, which ${PRODUCT} started before it restarted, rather than build another.`);
    else log(`${this.#deps.logName}: building the ${kind} template, as ${why}.`);
    const made = left ?? (await this.#create(kind, key, size));
    const since = Math.min(left?.createdAt ?? started, started);
    this.#buildSandboxes.add(made.id);
    try {
      const devices = isStopped(made.state) ? await this.#checkingDevices(made.id, kind) : await this.#runGuestScripts(made.id, kind, licence, since, left !== null);
      this.#stillHere();
      await this.#tryAFork(made.id, kind, TEMPLATE_STEP[kind] === "android" ? (made.size ?? size) : "small");
      await this.#rename(made.id, templateName(kind, "ready"));
      const record: TemplateRecord = { kind, sandbox: made.id, key, builtAt: now(), buildMs: now() - since, usedAt: null, ...(devices ? { devices } : {}) };
      const previous = await this.record(kind);
      await this.#deps.storage.set(`${RECORD}${kind}`, record);
      if (previous && previous.sandbox !== made.id) await this.#retire(previous.sandbox);
      log(`${this.#deps.logName}: the ${kind} template ${made.id} is ready, built in ${Math.round(record.buildMs / 60_000)} minutes.`);
      return record;
    } catch (error) {
      if (this.#leaving(error)) throw error instanceof BuildLeftRunning ? error : new BuildLeftRunning(`${PRODUCT} is stopping, so it leaves boat's template build ${made.id} to the ${PRODUCT} that starts next; its last step ended so: ${error instanceof Error ? error.message : String(error)}`);
      if (await this.#templateStays(made.id, kind)) this.#failureLeft.set(kind, made.id);
      else {
        await this.#deps.forget(made.id);
        await api.delete(made.id).catch((cause) => log(`${this.#deps.logName}: could not delete the failed build ${made.id}: ${cause instanceof Error ? cause.message : String(cause)}`));
      }
      throw error;
    } finally {
      this.#buildSandboxes.delete(made.id);
    }
  }

  async #create(kind: BoatKind, key: string, size: SandboxSize): Promise<Sandbox> {
    const labels = this.#deps.labelKeys;
    return this.#deps.api
      .create({
        size,
        ttlSeconds: BUILD_TTL_SECONDS,
        labels: { ...this.#deps.owner.labels(), [labels.role]: TEMPLATE_ROLE, [labels.kind]: kind, [labels.key]: key },
        name: templateName(kind, "building"),
      })
      .catch((error: unknown) => {
        if (error instanceof BoatError && error.code === "limit_reached")
          throw new BoatError("full", error.status, error.code, `boat's ${KIND_WORDS[kind]} template must be built first, in a sandbox of its own for about ${USUAL_BUILD_MINUTES[kind]} minutes, and the plan's sandboxes at once are all in use. Release or stop a boat box, and ask again.`);
        throw error;
      });
  }

  async #runGuestScripts(id: string, kind: BoatKind, licence: string | null, since: number, followed: boolean): Promise<readonly unknown[] | null> {
    const { api, now } = this.#deps;
    if (followed) await api.extend(id, BUILD_TTL_SECONDS).catch(() => undefined);
    await this.#running(id);
    await this.#deps.answers(id, "user", now() + STATE_WITHIN_MS);
    await this.#follow(id, kind, () => this.#stage(id, kind, licence, `build.${new Date(since).toISOString().replace(/[-:]/g, "").slice(0, 15)}`), since);
    const devices = TEMPLATE_STEP[kind] === "android" ? await this.#devices(id) : null;
    await this.#rename(id, templateName(kind, "checking"));
    this.#stillHere();
    await this.#stop(id);
    return devices;
  }

  async #checkingDevices(id: string, kind: BoatKind): Promise<readonly unknown[] | null> {
    await this.#deps.api.waitArchived(id, this.#deps.now() + ARCHIVE_WITHIN_MS);
    if (TEMPLATE_STEP[kind] !== "android") return null;
    const text = await this.#deps.api.latestSnapshotFile(id, ANDROID_DEVICES_FILE).catch(() => null);
    let devices: unknown = null;
    try {
      devices = text ? JSON.parse(text) : null;
    } catch {
      devices = null;
    }
    if (!Array.isArray(devices) || !devices.length) throw new Error(`boat's Android template ${id} lists no devices in ${ANDROID_DEVICES_FILE}.`);
    return devices;
  }

  async #stage(id: string, kind: BoatKind, licence: string | null, buildId: string): Promise<boolean> {
    this.#stillHere();
    const archive = await (this.#deps.setupArchive ?? templateArchive)();
    const files: StagedFiles = { buildEnv: (this.#deps.buildEnv ?? ((each: BoatKind) => buildEnvFor(buildId, each)))(kind), publicKey: await this.#deps.publicKey(), licence };
    this.#stillHere();
    const staged = await (await this.#deps.reach(id, "user")).run(`sudo -n sh -c ${quote(stageScript(kind, files))}`, { stdin: archive, timeoutMs: STAGE_WITHIN_MS });
    if (staged.exitCode === IN_HAND_ELSEWHERE) {
      this.#deps.log(`${this.#deps.logName}: another bb-box is staging or running the ${kind} template build in ${id}, so this one follows it.`);
      return false;
    }
    if (staged.exitCode !== 0) throw new Error(`boat's template build could not stage its scripts in ${id}: ${staged.stderr.trim().slice(-400) || `exit ${staged.exitCode}`}`);
    return true;
  }

  async #devices(sandbox: string): Promise<readonly unknown[]> {
    const read = await (await this.#deps.reach(sandbox, "user")).run(`cat ${ANDROID_DEVICES_FILE}`, { timeoutMs: 30_000 });
    let devices: unknown = null;
    try {
      devices = JSON.parse(read.stdout);
    } catch {
      devices = null;
    }
    if (read.exitCode !== 0 || !Array.isArray(devices) || !devices.length) throw new Error(`boat's Android template lists no devices in ${ANDROID_DEVICES_FILE}: ${read.stderr.trim().slice(-300) || "it is empty"}`);
    return devices;
  }

  async #tryAFork(template: string, kind: BoatKind, size: SandboxSize): Promise<void> {
    const { api, now, log } = this.#deps;
    const labels = this.#deps.labelKeys;
    const trialLabels = { ...this.#deps.owner.labels(), [labels.role]: TRIAL_ROLE, [labels.kind]: kind, [labels.template]: template };
    const left = (await this.#ownTrials(kind, template)).filter((sandbox) => !this.#buildSandboxes.has(sandbox.id) && (isRunning(sandbox.state) || isStarting(sandbox.state))).sort(newestFirst)[0] ?? null;
    this.#stillHere();
    if (left) log(`${this.#deps.logName}: checking the ${kind} template ${template} in its trial fork ${left.id}, which ${PRODUCT} made before it restarted.`);
    const trial = left ?? (await api.fork(template, { size, ttlSeconds: BUILD_TTL_SECONDS, labels: trialLabels, name: `bb-box ${kind} template trial` }));
    this.#buildSandboxes.add(trial.id);
    let leftRunning = false;
    try {
      await this.#running(trial.id);
      await this.#deps.answers(trial.id, "box", now() + STATE_WITHIN_MS);
      await this.#deps.settled(trial.id, now() + STATE_WITHIN_MS);
      if (TEMPLATE_STEP[kind] === "desktop") {
        this.#stillHere();
        await this.#desktopUp(trial.id, now() + STATE_WITHIN_MS);
        await this.#deps.restored(trial.id, now() + STATE_WITHIN_MS);
        this.#stillHere();
        await this.#must((await this.#deps.reach(trial.id, "box")).run(this.#deps.cuaReady ?? CUA_READY, { timeoutMs: 240_000 }), "get Cua Driver answering in a fork of the template");
      }
      this.#stillHere();
      const readCheck = async () => (await this.#deps.reach(trial.id, "box")).run(TEMPLATE_CHECK[kind], { timeoutMs: 10 * 60_000 });
      let check = await readCheck();
      if (dockerUnitDidNotStart(check)) check = await readCheck();
      const failed = failedChecks(check.stdout);
      if (check.exitCode !== 0 || failed.length) throw new Error(`boat's ${kind} template failed its check in a fork of it: ${failed.join("; ") || check.stderr.trim().slice(-400) || `exit ${check.exitCode}`}`);
    } catch (error) {
      leftRunning = this.#leaving(error);
      throw error;
    } finally {
      this.#buildSandboxes.delete(trial.id);
      if (!leftRunning) {
        await this.#deps.forget(trial.id);
        await api.delete(trial.id).catch((cause) => log(`${this.#deps.logName}: could not delete the template's trial fork ${trial.id}: ${cause instanceof Error ? cause.message : String(cause)}`));
      }
    }
  }

  async #templateStays(id: string, kind: BoatKind): Promise<boolean> {
    if ((await this.record(kind))?.sandbox === id) return true;
    const sandbox = await this.#deps.api.get(id).catch(() => null);
    if (sandbox?.name === templateName(kind, "ready")) return true;
    const trials = await this.#ownTrials(kind, id).catch(() => []);
    if (trials.some((trial) => (isRunning(trial.state) || isStarting(trial.state)) && !this.#buildSandboxes.has(trial.id))) return true;
    return this.#buildStillHoldsItsLock(id);
  }

  async #ownTrials(kind: BoatKind, template: string): Promise<Sandbox[]> {
    const labels = this.#deps.labelKeys;
    const trials = await this.#deps.api.list({ [labels.install]: this.#deps.owner.installId, [labels.role]: TRIAL_ROLE, [labels.kind]: kind, [labels.template]: template });
    return trials.filter((trial) => this.#deps.owner.owns(trial.labels));
  }

  async #progress(id: string): Promise<{ readonly build: GuestBuild | null; readonly complaint: string }> {
    const progress: { readonly exitCode: number | null; readonly stdout: string; readonly stderr: string } = await (await this.#deps.reach(id, "user"))
      .run(`sudo -n sh -c ${quote(progressScript())}`, { timeoutMs: 30_000 })
      .catch((error: unknown) => ({ exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
    return { build: progress.exitCode === 0 ? guestBuildFrom(progress.stdout) : null, complaint: (progress.stderr.trim() || progress.stdout.trim()).slice(-300) };
  }

  async #buildStillHoldsItsLock(id: string): Promise<boolean> {
    const again = (await this.#progress(id)).build;
    if (again?.running) return true;
    return again === null && this.#buildWasRunning.get(id) === true;
  }

  async #desktopUp(sandbox: string, deadline: number): Promise<void> {
    const asBox = await this.#deps.reach(sandbox, "box");
    while (this.#deps.now() < deadline) {
      this.#stillHere();
      const up = await asBox.run(DESKTOP_UP, { timeoutMs: 15_000 }).catch(() => null);
      if (up?.exitCode === 0) return;
      await this.#deps.sleep(1_000);
    }
    throw new Error(`The desktop in a fork of boat's template did not come up: no XFCE window manager or Cua Driver socket within ${Math.round(STATE_WITHIN_MS / 60_000)} minutes.`);
  }

  async #must(running: Promise<RunResult>, what: string): Promise<void> {
    const result = await running;
    if (result.exitCode !== 0) throw new Error(`boat's template build could not ${what}: ${result.stderr.trim().slice(-400) || `exit ${result.exitCode}`}`);
  }

  async #running(id: string): Promise<Sandbox> {
    return this.#deps.api.waitFor(id, (sandbox) => isRunning(sandbox.state), this.#deps.now() + STATE_WITHIN_MS);
  }

  async #rename(id: string, name: string): Promise<void> {
    await this.#deps.api.rename(id, name).catch((cause) => this.#deps.log(`${this.#deps.logName}: could not name the template sandbox ${id} "${name}": ${cause instanceof Error ? cause.message : String(cause)}`));
  }

  async #stop(id: string): Promise<void> {
    await this.#deps.forget(id);
    await this.#deps.api.stop(id).catch(async (error: unknown) => {
      const after = await this.#deps.api.get(id).catch(() => null);
      if (!after || !isStopped(after.state)) throw error;
    });
    await this.#deps.api.waitArchived(id, this.#deps.now() + ARCHIVE_WITHIN_MS);
  }

  #leaving(error: unknown): boolean {
    return error instanceof BuildLeftRunning || this.#disposed;
  }

  #stillHere(): void {
    if (this.#disposed) throw new BuildLeftRunning(`${PRODUCT} is stopping, so it leaves boat's template build to the ${PRODUCT} that starts next.`);
  }

  async #follow(id: string, kind: BoatKind, stage: () => Promise<boolean>, since: number): Promise<void> {
    const { now, sleep, log } = this.#deps;
    const deadline = since + GUEST_SCRIPTS_WITHIN_MS;
    let renewed = now();
    let unanswered = 0;
    let said = "";
    let stagedHere = false;
    this.#buildWasRunning.delete(id);
    for (;;) {
      this.#stillHere();
      if (now() > deadline) throw new Error(`boat's ${kind} template build did not end within ${Math.round(GUEST_SCRIPTS_WITHIN_MS / 60_000)} minutes.`);
      if (now() - renewed >= BUILD_RENEW_MS) {
        await this.#deps.api.extend(id, BUILD_TTL_SECONDS).catch(() => undefined);
        renewed = now();
      }
      const progress = await this.#progress(id);
      const build = progress.build;
      if (!build) {
        unanswered += 1;
        if (unanswered >= 30) throw new Error(`boat's ${kind} template build stopped answering: ${progress.complaint}`);
        await sleep(BUILD_POLL_MS);
        continue;
      }
      unanswered = 0;
      this.#buildWasRunning.set(id, build.running);
      const step = build.tail.filter((line) => /^\d\d:\d\d:\d\d {2}/.test(line)).pop();
      if (step && step !== said) log(`${this.#deps.logName}: ${kind} template: ${(said = step).slice(10)}`);
      const next = guestStep(build);
      if (next === "finished") return;
      if (next === "customize-failed") {
        await this.#logBuildLog(id, kind);
        throw new Error(`boat's ${kind} template build failed with exit ${build.customized}: ${build.tail.join("\n").trim().slice(-600)}`);
      }
      if (next === "finalize-failed") throw new Error(`boat's ${kind} template did not finalize: ${build.tail.join("\n").trim().slice(-400) || `exit ${build.finalized}`}`);
      if (next === "died") throw new Error(`boat's ${kind} template build in ${id} stopped without an exit code: no process holds it${build.started ? ", so its guest scripts died" : `, and its sandbox restarted or an older ${PRODUCT} started it`}.`);
      if (next === "unstaged") {
        if (stagedHere) throw new Error(`boat's ${kind} template build in ${id} was staged, but no process runs its guest scripts.`);
        stagedHere = await stage();
        if (!stagedHere) await sleep(BUILD_POLL_MS);
        continue;
      }
      await sleep(BUILD_POLL_MS);
    }
  }

  async #logBuildLog(id: string, kind: BoatKind): Promise<void> {
    const read = await (await this.#deps.reach(id, "user")).run(`sudo -n tail -n ${FAILED_BUILD_LOG_LINES} ${BUILD_DIR}/log`, { timeoutMs: 30_000 }).catch(() => null);
    if (read?.stdout.trim()) this.#deps.log(`${this.#deps.logName}: ${kind} template build failed; the last ${FAILED_BUILD_LOG_LINES} lines of its log, from sandbox ${id}, which bb-box deletes now:\n${read.stdout.trimEnd()}`);
  }

  async #retire(sandbox: string): Promise<void> {
    const retired = (await this.#deps.storage.get<RetiredTemplate[]>(RETIRED)) ?? [];
    await this.#deps.storage.set(RETIRED, [...retired.filter((each) => each.sandbox !== sandbox), { sandbox, retiredAt: this.#deps.now() }]);
  }

  async current(): Promise<ReadonlySet<string>> {
    const ids = new Set<string>();
    for (const kind of Object.keys(TEMPLATE_STEP) as BoatKind[]) {
      const record = await this.record(kind);
      if (record) ids.add(record.sandbox);
    }
    return ids;
  }

  async tidy(templates: readonly Sandbox[], signal?: AbortSignal): Promise<void> {
    const { api, now, log } = this.#deps;
    const labels = this.#deps.labelKeys;
    const current = await this.current();
    const retired = (await this.#deps.storage.get<RetiredTemplate[]>(RETIRED)) ?? [];
    const keep = new Set([...current, ...this.#buildSandboxes, ...retired.filter((each) => now() - each.retiredAt < RETIRED_TEMPLATE_KEPT_MS).map((each) => each.sandbox)]);
    const leftBuilds = new Set<string>();
    for (const kind of Object.keys(TEMPLATE_STEP) as BoatKind[]) {
      const ofTheseScripts = templates.filter((sandbox) => sandbox.labels[labels.role] === TEMPLATE_ROLE && sandbox.labels[labels.kind] === kind && sandbox.labels[labels.key] === this.key());
      const newest = ofTheseScripts.filter((sandbox) => sandbox.state === "archived" && sandbox.name === templateName(kind, "ready")).sort(newestFirst)[0];
      if (newest) keep.add(newest.id);
      for (const sandbox of ofTheseScripts) if (followable(sandbox, kind)) leftBuilds.add(sandbox.id);
    }
    for (const sandbox of templates) {
      const trialOf = sandbox.labels[labels.template];
      if (leftBuilds.has(sandbox.id) || (sandbox.labels[labels.role] === TRIAL_ROLE && trialOf !== undefined && leftBuilds.has(trialOf) && (isRunning(sandbox.state) || isStarting(sandbox.state)))) keep.add(sandbox.id);
    }
    for (const sandbox of templates) {
      if (keep.has(sandbox.id)) continue;
      if (sandbox.createdAt !== null && now() - sandbox.createdAt < LEFT_BUILD_GRACE_MS) continue;
      await api.delete(sandbox.id, signal);
      log(`${this.#deps.logName}: deleted ${sandbox.labels[labels.role] === TEMPLATE_ROLE && isStopped(sandbox.state) ? "an old template" : "a template build or trial that nothing follows"}, ${sandbox.id}.`);
    }
    const listed = new Set(templates.map((sandbox) => sandbox.id));
    await this.#deps.storage.set(RETIRED, retired.filter((each) => keep.has(each.sandbox) && listed.has(each.sandbox)));
  }

  dispose(): void {
    this.#disposed = true;
  }
}

function quote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function isGone(error: unknown): boolean {
  return error instanceof BoatError && error.kind === "gone";
}
