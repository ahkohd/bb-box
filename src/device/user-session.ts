import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Ran, Runner } from "./simctl.ts";

export const LAUNCHCTL = "/bin/launchctl";
export const PASTEBOARD_SERVER = "/usr/libexec/pboard";
export const PASTEBOARD_SERVER_LABEL = "app.bb-box.pboard";
export const PASTEBOARD_SERVICES = ["com.apple.pasteboard.1", "com.apple.coreservices.uauseractivitypasteboardclient.xpc"] as const;
export const SESSION_JOB_LABEL = "app.bb-box.session-job";
const JOB_EXIT_POLL_MS = 20;
const LAUNCHCTL_MS = 10_000;
const KEPT_ENVIRONMENT = ["HOME", "USER", "LOGNAME", "PATH", "TMPDIR"] as const;

export type SessionRoute = { readonly way: "here" } | { readonly way: "domain"; readonly domain: string; readonly session: "Aqua" | "Background"; readonly ownPasteboardServer: boolean };

export function sessionRoute(managerName: string | null, uid: number, hasGuiDomain: boolean): SessionRoute {
  if (managerName?.trim() === "Aqua") return { way: "here" };
  if (hasGuiDomain) return { way: "domain", domain: `gui/${uid}`, session: "Aqua", ownPasteboardServer: false };
  return { way: "domain", domain: `user/${uid}`, session: "Background", ownPasteboardServer: true };
}

type PlistValue = string | boolean | readonly string[] | Readonly<Record<string, string | boolean>>;

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function plistValue(value: PlistValue, indent: string): string {
  if (typeof value === "string") return `<string>${xml(value)}</string>`;
  if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
  if (Array.isArray(value)) return `<array>\n${(value as readonly string[]).map((each) => `${indent}  <string>${xml(each)}</string>\n`).join("")}${indent}</array>`;
  const entries = Object.entries(value as Readonly<Record<string, string | boolean>>);
  return `<dict>\n${entries.map(([key, each]) => `${indent}  <key>${xml(key)}</key>${plistValue(each, `${indent}  `)}\n`).join("")}${indent}</dict>`;
}

export function launchdPlist(entries: Readonly<Record<string, PlistValue>>): string {
  const body = Object.entries(entries)
    .map(([key, value]) => `  <key>${xml(key)}</key>${plistValue(value, "  ")}\n`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}</dict>\n</plist>\n`;
}

export function pasteboardServerPlist(): string {
  return launchdPlist({
    Label: PASTEBOARD_SERVER_LABEL,
    ProgramArguments: [PASTEBOARD_SERVER],
    MachServices: Object.fromEntries(PASTEBOARD_SERVICES.map((service) => [service, true])),
    LimitLoadToSessionType: "Background",
    EnableTransactions: true,
    POSIXSpawnType: "Interactive",
  });
}

const RUN_AND_KEEP_EXIT = '"$0" "$@" <in >out 2>err; echo $? >exit.new && mv exit.new exit';

export function sessionJobPlist(job: { readonly label: string; readonly dir: string; readonly session: string; readonly program: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> }): string {
  return launchdPlist({
    Label: job.label,
    ProgramArguments: ["/bin/sh", "-c", RUN_AND_KEEP_EXIT, job.program, ...job.args],
    WorkingDirectory: job.dir,
    EnvironmentVariables: job.env,
    LimitLoadToSessionType: job.session,
    ProcessType: "Interactive",
    RunAtLoad: true,
  });
}

function keptEnvironment(): Record<string, string> {
  return Object.fromEntries(KEPT_ENVIRONMENT.flatMap((name) => (process.env[name] ? [[name, process.env[name]!]] : [])));
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface SessionJobsOptions {
  readonly route: Extract<SessionRoute, { way: "domain" }>;
  readonly dir: string;
  readonly run: Runner;
  readonly pollMs?: number;
}

export class SessionJobs {
  readonly #route: Extract<SessionRoute, { way: "domain" }>;
  readonly #dir: string;
  readonly #run: Runner;
  readonly #pollMs: number;
  #serverLoaded = false;
  #swept = false;
  #count = 0;

  constructor(options: SessionJobsOptions) {
    this.#route = options.route;
    this.#dir = options.dir;
    this.#run = options.run;
    this.#pollMs = options.pollMs ?? JOB_EXIT_POLL_MS;
  }

  #launchctl(args: readonly string[]): Promise<Ran> {
    return this.#run(LAUNCHCTL, args, { timeoutMs: LAUNCHCTL_MS });
  }

  async #loaded(label: string): Promise<boolean> {
    return (await this.#launchctl(["print", `${this.#route.domain}/${label}`])).code === 0;
  }

  async pasteboardServerProblem(): Promise<string | null> {
    if (!this.#route.ownPasteboardServer || this.#serverLoaded) return null;
    if (!(await this.#loaded(PASTEBOARD_SERVER_LABEL))) {
      await mkdir(this.#dir, { recursive: true });
      const plist = join(this.#dir, `${PASTEBOARD_SERVER_LABEL}.plist`);
      await writeFile(plist, pasteboardServerPlist());
      const loaded = await this.#launchctl(["bootstrap", this.#route.domain, plist]);
      if (loaded.code !== 0 && !(await this.#loaded(PASTEBOARD_SERVER_LABEL))) {
        return `launchd did not load macOS's pasteboard server in ${this.#route.domain}: ${loaded.stderr.trim() || `exit code ${loaded.code}`}`;
      }
    }
    this.#serverLoaded = true;
    return null;
  }

  async #sweepEarlierServers(): Promise<void> {
    if (this.#swept) return;
    this.#swept = true;
    const ours = `${SESSION_JOB_LABEL}.${process.pid}.`;
    for (const name of await readdir(this.#dir).catch(() => [] as string[])) {
      if (!name.startsWith(`${SESSION_JOB_LABEL}.`) || name.startsWith(ours)) continue;
      await this.#launchctl(["bootout", `${this.#route.domain}/${name}`]);
      await rm(join(this.#dir, name), { recursive: true, force: true });
    }
  }

  async #exitCode(file: string, timeoutMs: number, signal?: AbortSignal): Promise<number | "timed out" | "stopped"> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) return "stopped";
      const written = await stat(file).then(() => readFile(file, "utf8"), () => null);
      if (written !== null && /^\d+\s*$/.test(written)) return Number(written);
      if (Date.now() >= deadline) return "timed out";
      await wait(this.#pollMs);
    }
  }

  readonly run: Runner = async (program, args, options) => {
    const problem = await this.pasteboardServerProblem();
    if (problem) return { code: 1, stdout: "", stderr: problem };
    await this.#sweepEarlierServers();
    const label = `${SESSION_JOB_LABEL}.${process.pid}.${++this.#count}`;
    const dir = join(this.#dir, label);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "in"), options.input ?? "");
    const plist = join(dir, "job.plist");
    await writeFile(plist, sessionJobPlist({ label, dir, session: this.#route.session, program, args, env: { ...keptEnvironment(), ...options.env } }));
    try {
      const loaded = await this.#launchctl(["bootstrap", this.#route.domain, plist]);
      if (loaded.code !== 0) return { code: 1, stdout: "", stderr: `launchd did not start ${program} in ${this.#route.domain}: ${loaded.stderr.trim() || `exit code ${loaded.code}`}` };
      const code = await this.#exitCode(join(dir, "exit"), options.timeoutMs, options.signal);
      if (typeof code !== "number") return { code: 1, stdout: "", stderr: code === "stopped" ? `${program} was stopped` : `${program} did not end within ${options.timeoutMs / 1000} s` };
      const [stdout, stderr] = await Promise.all(["out", "err"].map((name) => readFile(join(dir, name), "utf8").catch(() => "")));
      return { code, stdout: stdout!, stderr: stderr! };
    } finally {
      await this.#launchctl(["bootout", `${this.#route.domain}/${label}`]);
      await rm(dir, { recursive: true, force: true });
    }
  };
}

export interface PasteboardWay {
  readonly run: Runner;
  ready(): Promise<string | null>;
}

export function pasteboardInOwnSession(options: { readonly run: Runner; readonly dir: string; readonly uid?: number; readonly log?: (line: string) => void }): PasteboardWay {
  const uid = options.uid ?? process.getuid?.() ?? 0;
  let chosen: Promise<{ readonly run: Runner; readonly jobs: SessionJobs | null }> | null = null;
  const choose = async () => {
    const manager = await options.run(LAUNCHCTL, ["managername"], { timeoutMs: LAUNCHCTL_MS });
    const gui = await options.run(LAUNCHCTL, ["print", `gui/${uid}`], { timeoutMs: LAUNCHCTL_MS });
    const route = sessionRoute(manager.code === 0 ? manager.stdout : null, uid, gui.code === 0);
    if (route.way === "here") return { run: options.run, jobs: null };
    options.log?.(`pasteboard: this server is not in a desktop session, so the device's clipboard is set and read in ${route.domain}${route.ownPasteboardServer ? ", with macOS's pasteboard server loaded there" : ""}`);
    const jobs = new SessionJobs({ route, dir: options.dir, run: options.run });
    return { run: jobs.run, jobs };
  };
  const route = () => (chosen ??= choose());
  return {
    run: async (program, args, runOptions) => (await route()).run(program, args, runOptions),
    ready: async () => (await route()).jobs?.pasteboardServerProblem() ?? null,
  };
}
