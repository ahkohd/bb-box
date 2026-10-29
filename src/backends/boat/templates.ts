import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { setupDir } from "../setup-dir.ts";
import type { BackendStorage } from "../types.ts";
import type { RunResult } from "../../transports/types.ts";
import { BoatError, isRunning, isStopped, type BoatApi, type Sandbox, type SandboxSize } from "./api.ts";
import type { BoatKind } from "./config.ts";

export const TEMPLATE_ROLE = "template";
export const TRIAL_ROLE = "template-trial";
export const TEMPLATE_SIZE: SandboxSize = "default";
export const TEMPLATE_REBUILT_AFTER_MS = 7 * 24 * 3_600_000;
export const RETIRED_TEMPLATE_KEPT_MS = 60 * 60_000;
export const LEFT_BUILD_GRACE_MS = 10 * 60_000;
export const BUILD_TTL_SECONDS = 2 * 3600;
export const TEMPLATE_INPUTS = ["proxmox-lxc/template", "proxmox-lxc/host/common.sh", "android", "boat"] as const;
const BUILD_DIR = "/var/tmp/bb-box-build";
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
const BUILD_RENEW_MS = 15 * 60_000;
const CUSTOMIZE_WITHIN_MS = 90 * 60_000;
const STATE_WITHIN_MS = 10 * 60_000;
const RECORD = "template/";
const FAILED = "template-failed/";
export const FAILED_BUILD_RETRY_MS = 6 * 3_600_000;
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
}

export interface Reached {
  run(script: string, options: { readonly stdin?: Buffer | string; readonly timeoutMs: number; readonly signal?: AbortSignal }): Promise<RunResult>;
}

export interface TemplateDeps {
  readonly api: BoatApi;
  readonly storage: BackendStorage;
  readonly installId: string;
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

export function templateFingerprint(setup = setupDir()): string {
  const walk = (path: string): string[] => {
    if (!existsSync(path)) return [];
    if (!statSync(path).isDirectory()) return [path];
    return readdirSync(path)
      .sort()
      .flatMap((name) => walk(join(path, name)));
  };
  const hash = createHash("sha256");
  for (const path of TEMPLATE_INPUTS.flatMap((input) => walk(join(setup, input))).filter((path) => !path.endsWith(".md") && !path.includes("/artifacts/")))
    hash.update(relative(setup, path)).update("\0").update(readFileSync(path)).update("\0");
  return hash.digest("hex").slice(0, 12);
}

export function templateArchive(setup = setupDir()): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-czf", "-", "--exclude=artifacts", "-C", setup.replace(/\/+$/, ""), ...TEMPLATE_INPUTS], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`tar could not pack bb-box's template scripts from ${dirname(setup)}: ${stderr.trim() || `exit ${code}`}`))));
  });
}

export function buildEnvFor(buildId: string): string {
  return ["BOX_USER=box", "BOX_RUNTIME=vm", "DESKTOP_GPU=none", "BB_URL=", `BUILD_ID=${buildId}`, ""].join("\n");
}

export function buildWaitWords(kind: BoatKind, lastBuildMs: number | null): string {
  const minutes = lastBuildMs ? Math.max(1, Math.round(lastBuildMs / 60_000)) : USUAL_BUILD_MINUTES[kind];
  return `Building boat's ${KIND_WORDS[kind]} template first, which takes about ${minutes} minutes. Later boxes of this kind fork it and start in seconds.`;
}

export function customizeScript(kind: BoatKind): string {
  return [
    `d=${BUILD_DIR}`,
    'rm -f "$d/exit"',
    `setsid nohup sh -c 'bash "$1/boat/template.sh" customize ${TEMPLATE_STEP[kind]} > "$1/log" 2>&1; echo $? > "$1/exit"' sh "$d" </dev/null >/dev/null 2>&1 &`,
  ].join("\n");
}

export function progressScript(): string {
  return [`d=${BUILD_DIR}`, 'echo "exit=$(cat "$d/exit" 2>/dev/null || true)"', 'tail -n 20 "$d/log" 2>/dev/null'].join("\n");
}

export const CHECKS_BOAT_ANSWERS_FOR = [/^docker stopped after boot\b/];

export function failedChecks(output: string): string[] {
  return output.split("\n").filter((line) => /\bFAIL\b/.test(line) && !CHECKS_BOAT_ANSWERS_FOR.some((check) => check.test(line)));
}

export class BoatTemplates {
  readonly #deps: TemplateDeps;
  readonly #building = new Map<BoatKind, Promise<TemplateRecord>>();
  readonly #buildSandboxes = new Set<string>();
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
    if (record.key !== this.key()) return "bb-box's template scripts changed";
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
        record = await this.build(kind, current ? "its template is gone" : "there is none yet");
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
        .filter((sandbox) => sandbox.state === "archived" && sandbox.dataExpiredAt === null && !this.#buildSandboxes.has(sandbox.id))
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0] ?? null
    );
  }

  async keepAdoptable(kind: BoatKind, signal?: AbortSignal): Promise<TemplateRecord | null> {
    const adopted = await this.#adopt(kind, signal);
    if (adopted) await this.#deps.storage.set(`${RECORD}${kind}`, adopted);
    return adopted;
  }

  async #adopt(kind: BoatKind, signal?: AbortSignal): Promise<TemplateRecord | null> {
    const labels = this.#deps.labelKeys;
    const found = await this.adoptable(kind, signal);
    if (!found) return null;
    this.#deps.log(`boat: using the ${kind} template ${found.id}, which bb-box built ${found.labels[labels.install] === this.#deps.installId ? "before" : "for another install on this account"}.`);
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
    for (const kind of Object.keys(TEMPLATE_STEP) as BoatKind[]) {
      const record = await this.record(kind);
      if (!record || this.#building.has(kind) || (await this.failedLately(kind))) continue;
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
          await this.#deps.storage.set(`${FAILED}${kind}`, { at: this.#deps.now(), why: (error instanceof Error ? error.message : String(error)).slice(0, 600) });
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
    const started = now();
    const key = this.key();
    const labels = this.#deps.labelKeys;
    log(`boat: building the ${kind} template, as ${why}.`);
    const size = (await this.#deps.sizeFor?.(kind).catch(() => null)) ?? TEMPLATE_SIZE;
    const licence = TEMPLATE_STEP[kind] === "android" ? (this.#deps.androidLicence?.() ?? null) : null;
    if (TEMPLATE_STEP[kind] === "android" && !licence) throw new Error("boat's Android template needs the Android SDK's licence accepted in BB Box's settings first.");
    const made = await api
      .create({
        size,
        ttlSeconds: BUILD_TTL_SECONDS,
        labels: { [labels.install]: this.#deps.installId, [labels.role]: TEMPLATE_ROLE, [labels.kind]: kind, [labels.key]: key },
        name: `bb-box ${kind} template`,
      })
      .catch((error: unknown) => {
        if (error instanceof BoatError && error.code === "limit_reached")
          throw new BoatError("full", error.status, error.code, `boat's ${KIND_WORDS[kind]} template must be built first, in a sandbox of its own for about ${USUAL_BUILD_MINUTES[kind]} minutes, and the plan's sandboxes at once are all in use. Release or stop a boat box, and ask again.`);
        throw error;
      });
    this.#buildSandboxes.add(made.id);
    try {
      await this.#running(made.id);
      const asUser = await this.#deps.reach(made.id, "user");
      await this.#deps.answers(made.id, "user", now() + STATE_WITHIN_MS);
      const archive = await (this.#deps.setupArchive ?? templateArchive)();
      await this.#must(asUser.run(`sudo -n rm -rf ${BUILD_DIR} && sudo -n mkdir -p ${BUILD_DIR} && sudo -n tar -xzf - -C ${BUILD_DIR}`, { stdin: archive, timeoutMs: 120_000 }), "unpack bb-box's template scripts");
      const buildId = `build.${new Date(started).toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
      await this.#must(asUser.run(`sudo -n tee ${BUILD_DIR}/proxmox-lxc/template/build.env >/dev/null`, { stdin: (this.#deps.buildEnv ?? (() => buildEnvFor(buildId)))(kind), timeoutMs: 30_000 }), "write the build's settings");
      await this.#must(asUser.run(`sudo -n tee ${BUILD_DIR}/proxmox-lxc/template/plugin-key.pub >/dev/null`, { stdin: `${await this.#deps.publicKey()}\n`, timeoutMs: 30_000 }), "write bb-box's key");
      if (licence) await this.#must(asUser.run(`sudo -n tee ${BUILD_DIR}/proxmox-lxc/template/android-sdk-license >/dev/null`, { stdin: `${licence}\n`, timeoutMs: 30_000 }), "write the Android SDK licence's acceptance");
      await this.#must(asUser.run(`sudo -n sh -c ${quote(customizeScript(kind))}`, { timeoutMs: 30_000 }), "start the guest scripts");
      await this.#follow(made.id, kind);
      const finalized = await (await this.#deps.reach(made.id, "user")).run(`sudo -n bash ${BUILD_DIR}/boat/template.sh finalize ${TEMPLATE_STEP[kind]}`, { timeoutMs: 20 * 60_000 });
      if (finalized.exitCode !== 0) throw new Error(`boat's ${kind} template did not finalize: ${finalized.stderr.trim().slice(-400) || `exit ${finalized.exitCode}`}`);
      const devices = TEMPLATE_STEP[kind] === "android" ? await this.#devices(made.id) : null;
      await this.#stop(made.id);
      await this.#tryAFork(made.id, kind);
      const record: TemplateRecord = { kind, sandbox: made.id, key, builtAt: now(), buildMs: now() - started, usedAt: null, ...(devices ? { devices } : {}) };
      const previous = await this.record(kind);
      await this.#deps.storage.set(`${RECORD}${kind}`, record);
      if (previous && previous.sandbox !== made.id) await this.#retire(previous.sandbox);
      log(`boat: the ${kind} template ${made.id} is ready, built in ${Math.round(record.buildMs / 60_000)} minutes.`);
      return record;
    } catch (error) {
      await this.#deps.forget(made.id);
      await api.delete(made.id).catch((cause) => log(`boat: could not delete the failed build ${made.id}: ${cause instanceof Error ? cause.message : String(cause)}`));
      throw error;
    } finally {
      this.#buildSandboxes.delete(made.id);
    }
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

  async #tryAFork(template: string, kind: BoatKind): Promise<void> {
    const { api, now } = this.#deps;
    const labels = this.#deps.labelKeys;
    const trial = await api.fork(template, { size: "small", ttlSeconds: BUILD_TTL_SECONDS, labels: { [labels.install]: this.#deps.installId, [labels.role]: TRIAL_ROLE, [labels.kind]: kind }, name: `bb-box ${kind} template trial` });
    this.#buildSandboxes.add(trial.id);
    try {
      await this.#running(trial.id);
      await this.#deps.answers(trial.id, "box", now() + STATE_WITHIN_MS);
      await this.#deps.settled(trial.id, now() + STATE_WITHIN_MS);
      if (TEMPLATE_STEP[kind] === "desktop") {
        await this.#desktopUp(trial.id, now() + STATE_WITHIN_MS);
        await this.#deps.restored(trial.id, now() + STATE_WITHIN_MS);
        await this.#must((await this.#deps.reach(trial.id, "box")).run(this.#deps.cuaReady ?? CUA_READY, { timeoutMs: 240_000 }), "get Cua Driver answering in a fork of the template");
      }
      const check = await (await this.#deps.reach(trial.id, "box")).run(TEMPLATE_CHECK[kind], { timeoutMs: 10 * 60_000 });
      const failed = failedChecks(check.stdout);
      if (check.exitCode !== 0 || failed.length) throw new Error(`boat's ${kind} template failed its check in a fork of it: ${failed.join("; ") || check.stderr.trim().slice(-400) || `exit ${check.exitCode}`}`);
    } finally {
      await this.#deps.forget(trial.id);
      await api.delete(trial.id).catch((cause) => this.#deps.log(`boat: could not delete the template's trial fork ${trial.id}: ${cause instanceof Error ? cause.message : String(cause)}`));
      this.#buildSandboxes.delete(trial.id);
    }
  }

  async #desktopUp(sandbox: string, deadline: number): Promise<void> {
    const asBox = await this.#deps.reach(sandbox, "box");
    while (this.#deps.now() < deadline) {
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

  async #stop(id: string): Promise<void> {
    await this.#deps.forget(id);
    await this.#deps.api.stop(id);
    await this.#deps.api.waitFor(id, (sandbox) => sandbox.state === "archived", this.#deps.now() + STATE_WITHIN_MS);
  }

  async #follow(id: string, kind: BoatKind): Promise<void> {
    const { now, sleep, log } = this.#deps;
    const deadline = now() + CUSTOMIZE_WITHIN_MS;
    let renewed = now();
    let unanswered = 0;
    let said = "";
    for (;;) {
      if (this.#disposed) throw new Error("bb-box is stopping, so it gave up boat's template build.");
      if (now() > deadline) throw new Error(`boat's ${kind} template build did not end within ${Math.round(CUSTOMIZE_WITHIN_MS / 60_000)} minutes.`);
      if (now() - renewed >= BUILD_RENEW_MS) {
        await this.#deps.api.extend(id, BUILD_TTL_SECONDS).catch(() => undefined);
        renewed = now();
      }
      const progress: { readonly exitCode: number | null; readonly stdout: string; readonly stderr: string } = await (await this.#deps.reach(id, "user")).run(`sudo -n sh -c ${quote(progressScript())}`, { timeoutMs: 30_000 }).catch((error: unknown) => ({ exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
      if (progress.exitCode !== 0) {
        unanswered += 1;
        if (unanswered >= 30) throw new Error(`boat's ${kind} template build stopped answering: ${progress.stderr.trim().slice(-300)}`);
      } else {
        unanswered = 0;
        const [header = "", ...tail] = progress.stdout.split("\n");
        const step = tail.filter((line) => /^\d\d:\d\d:\d\d {2}/.test(line)).pop();
        if (step && step !== said) log(`boat: ${kind} template: ${(said = step).slice(10)}`);
        const code = /^exit=(\d+)/.exec(header.trim());
        if (code) {
          if (code[1] === "0") return;
          throw new Error(`boat's ${kind} template build failed with exit ${code[1]}: ${tail.join("\n").trim().slice(-600)}`);
        }
      }
      await sleep(BUILD_POLL_MS);
    }
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
    for (const kind of Object.keys(TEMPLATE_STEP) as BoatKind[]) {
      const newest = templates
        .filter((sandbox) => sandbox.labels[labels.role] === TEMPLATE_ROLE && sandbox.labels[labels.kind] === kind && sandbox.labels[labels.key] === this.key() && sandbox.state === "archived")
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
      if (newest) keep.add(newest.id);
    }
    for (const sandbox of templates) {
      if (keep.has(sandbox.id)) continue;
      if (sandbox.createdAt !== null && now() - sandbox.createdAt < LEFT_BUILD_GRACE_MS) continue;
      await api.delete(sandbox.id, signal);
      log(`boat: deleted ${sandbox.labels[labels.role] === TEMPLATE_ROLE && isStopped(sandbox.state) ? "an old template" : "a template build or trial that nothing follows"}, ${sandbox.id}.`);
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
