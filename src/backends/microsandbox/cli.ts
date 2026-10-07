// bb-box's msb on the backend's host, as a command line on BB's server
// (053): bin/msb in bb-box's msb folder on BB's server, the same over
// ssh://, or bb-box's msb client for a BB machine, which its host entry runs
// there (src/relay/msb.ts). Each gives the run's stdin, stdout, stderr and
// exit status as its own, so the transport and the backend use plain
// command lines, as Docker's do (031). The scripts of release.ts run the
// same three ways.

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { abortable } from "../../core/abortable.ts";
import { Capture, quote } from "../../transports/process.ts";
import type { MachineAccess } from "../types.ts";
import { msbScript, type MsbScript } from "./release.ts";

const MiB = 1024 * 1024;

export interface MsbResult {
  /** Null when the command was killed. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface ScriptResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** What says the host itself could not be reached, so nothing was done there. */
const UNREACHABLE = /bb-box could not run msb on the BB machine|ssh: |Connection (refused|closed|timed out)|Could not resolve hostname|Permission denied \(publickey/i;
/** What msb says of a sandbox or image it does not have. */
export const NOT_FOUND = /not found/i;

export class MsbError extends Error {
  /** The host could not be reached, so nothing was done. */
  readonly unreachable: boolean;
  constructor(message: string, unreachable = false) {
    super(message);
    this.name = "MsbError";
    this.unreachable = unreachable;
  }
}

export interface MsbCliOptions {
  /** bb-box's msb folder on BB's server, for a backend with no host. */
  readonly dir?: string;
  /** The ssh client for an ssh:// host. */
  readonly ssh?: string;
  /** Runs a script in place of the host, for tests. */
  readonly script?: (name: MsbScript, args: readonly string[], signal?: AbortSignal) => Promise<ScriptResult>;
}

/** `ssh`'s arguments for an ssh:// host: its user and port, then the host. */
function sshTarget(host: string): string[] {
  const url = new URL(host);
  const name = url.hostname.replace(/^\[(.*)\]$/, "$1");
  return [...(url.username ? ["-l", decodeURIComponent(url.username)] : []), ...(url.port ? ["-p", url.port] : []), "--", name];
}

export interface RunOptions {
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export class MsbCli {
  /** ssh://user@host, bb:<machine>, or null for BB's server. */
  readonly host: string | null;
  readonly #machine: string | null;
  readonly #machines: MachineAccess | undefined;
  readonly #options: MsbCliOptions;
  readonly #dir: string;

  constructor(host: string | null, machine: string | null, machines: MachineAccess | undefined, options: MsbCliOptions = {}) {
    this.host = host;
    this.#machine = machine;
    this.#machines = machines;
    this.#options = options;
    this.#dir = options.dir ?? join(homedir(), ".local", "share", "bb-box", "microsandbox");
  }

  #access() {
    const machine = this.#machine!;
    const access = this.#machines?.msb?.(machine);
    if (!access) throw new MsbError(`bb-box reaches BB machine ${machine} only when it runs in BB.`, true);
    return access;
  }

  /** The command line for `msb <args>` on the host; on a PTY there with `tty`, for a terminal. */
  argv(args: readonly string[], options: { readonly tty?: boolean } = {}): [string, ...string[]] {
    if (this.#machine) return this.#access().argv(args, options);
    if (this.host) {
      const remote = `exec "$HOME/.local/share/bb-box/microsandbox/bin/msb" ${args.map(quote).join(" ")}`;
      return [this.#options.ssh ?? "ssh", "-o", "BatchMode=yes", options.tty ? "-tt" : "-T", ...sshTarget(this.host), remote];
    }
    return [join(this.#dir, "bin", "msb"), ...args];
  }

  /** Makes the host ready to use: for a BB machine, its msb relay. Throws an MsbError when it cannot. */
  async prepare(signal?: AbortSignal): Promise<void> {
    if (!this.#machine) return;
    try {
      await abortable(this.#access().ready(signal), signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new MsbError(error instanceof Error ? error.message : String(error), true);
    }
  }

  async run(args: readonly string[], options: RunOptions = {}): Promise<MsbResult> {
    await this.prepare(options.signal);
    return this.#spawn(this.argv(args), options);
  }

  /** Runs `msb <args>` and returns its output, or throws an MsbError that says what failed. */
  async ok(args: readonly string[], options: RunOptions = {}): Promise<string> {
    const result = await this.run(args, options);
    if (result.exitCode === 0) return result.stdout;
    throw this.error(`msb ${args[0]}`, result);
  }

  error(action: string, result: MsbResult | ScriptResult): MsbError {
    if ("timedOut" in result && result.timedOut) return new MsbError(`${action} did not finish in time.`);
    const said = result.stderr.trim().split("\n").slice(-3).join(" ").replace(/^error: /, "").slice(0, 600);
    return new MsbError(`${action} failed: ${said || `exit code ${result.exitCode}`}`, UNREACHABLE.test(said));
  }

  /** Runs one of bb-box's scripts on the host. */
  async script(name: MsbScript, args: readonly string[] = [], signal?: AbortSignal): Promise<ScriptResult> {
    if (this.#options.script) return this.#options.script(name, args, signal);
    if (this.#machine) {
      try {
        return await this.#access().script(name, args, signal);
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        throw new MsbError(error instanceof Error ? error.message : String(error), true);
      }
    }
    const timeoutMs = name === "import" || name === "transfer" ? 30 * 60_000 : name === "install" ? 10 * 60_000 : 60_000;
    const command = this.host
      ? [this.#options.ssh ?? "ssh", "-o", "BatchMode=yes", "-T", ...sshTarget(this.host), `sh -c ${quote(msbScript(name))} bb-box-msb ${args.map(quote).join(" ")}`]
      : ["sh", "-c", msbScript(name), "bb-box-msb", ...args];
    return this.#spawn(command as [string, ...string[]], { timeoutMs, signal }, this.host ? {} : { BBBOX_MSB_DIR: this.#dir });
  }

  #spawn(argv: readonly [string, ...string[]], options: RunOptions, env: Record<string, string> = {}): Promise<MsbResult> {
    const [binary, ...rest] = argv;
    const stdout = new Capture(8 * MiB);
    const stderr = new Capture(64 * 1024);
    return new Promise((resolve, reject) => {
      options.signal?.throwIfAborted();
      const child = spawn(binary, rest, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
      let timedOut = false;
      const kill = () => child.kill("SIGKILL");
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, options.timeoutMs ?? 60_000);
      options.signal?.addEventListener("abort", kill, { once: true });
      const done = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", kill);
      };
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.stdin.on("error", () => {});
      child.once("error", (error) => {
        done();
        reject(new MsbError(`Cannot run ${binary}: ${error.message}`, true));
      });
      child.once("close", (code) => {
        done();
        if (options.signal?.aborted && !timedOut) return reject(options.signal.reason);
        resolve({ exitCode: code, stdout: stdout.text(), stderr: stderr.text(), timedOut });
      });
      child.stdin.end(options.stdin ?? "");
    });
  }

  // What msb says, parsed.

  /** A sandbox as `msb inspect --format json` gives it, or null when there is none. */
  async inspect(name: string, signal?: AbortSignal): Promise<SandboxInfo | null> {
    const result = await this.run(["inspect", name, "--format", "json"], { timeoutMs: 30_000, signal });
    if (result.exitCode !== 0) {
      if (NOT_FOUND.test(result.stderr) && !UNREACHABLE.test(result.stderr)) return null;
      throw this.error("msb inspect", result);
    }
    return parseSandbox(result.stdout);
  }

  /** The names of every sandbox with all of `labels`, running or not. */
  async list(labels: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<{ name: string; status: string }[]> {
    const filters = Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
    const text = await this.ok(["ls", "--format", "json", ...filters], { timeoutMs: 30_000, signal });
    const list: unknown = text.trim() ? JSON.parse(text) : [];
    return (Array.isArray(list) ? list : []).map((entry) => record(entry)).map((entry) => ({ name: String(entry.name ?? ""), status: String(entry.status ?? "") }));
  }

  /** Every sandbox with its cores and memory, as `msb status --all` gives them. */
  async status(signal?: AbortSignal): Promise<{ name: string; status: string; cpus: number; memoryMiB: number }[]> {
    const text = await this.ok(["status", "--all", "--format", "json"], { timeoutMs: 30_000, signal });
    const list: unknown = text.trim() ? JSON.parse(text) : [];
    return (Array.isArray(list) ? list : []).map((entry) => record(entry)).map((entry) => ({
      name: String(entry.name ?? ""),
      status: String(entry.status ?? ""),
      cpus: Number(entry.cpus) || 0,
      memoryMiB: Number(entry.memory_mib) || 0,
    }));
  }

  /** An image's labels, or null when msb has no such image. */
  async imageLabels(ref: string, signal?: AbortSignal): Promise<Record<string, string> | null> {
    const result = await this.run(["image", "inspect", ref, "--format", "json"], { timeoutMs: 30_000, signal });
    if (result.exitCode !== 0) {
      if (NOT_FOUND.test(result.stderr) && !UNREACHABLE.test(result.stderr)) return null;
      throw this.error("msb image inspect", result);
    }
    return strings(record(record(JSON.parse(result.stdout)).config).labels);
  }
}

export interface SandboxInfo {
  readonly name: string;
  /** Running, Stopped, Crashed, and others msb may add. */
  readonly status: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly cpus: number | null;
  readonly memoryMiB: number | null;
  readonly diskGiB: number | null;
  readonly image: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function strings(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record(value))) if (typeof entry === "string") result[key] = entry;
  return result;
}

export function parseSandbox(text: string): SandboxInfo {
  const sandbox = record(JSON.parse(text));
  const config = record(sandbox.config);
  const resources = record(config.resources);
  const oci = record(record(config.image).Oci);
  const disk = Number(record(oci.root_disk).size_mib);
  return {
    name: String(sandbox.name ?? ""),
    status: String(sandbox.status ?? ""),
    labels: strings(config.labels),
    cpus: Number(resources.cpus) || null,
    memoryMiB: Number(resources.memory_mib) || null,
    diskGiB: Number.isFinite(disk) && disk > 0 ? Math.round(disk / 1024) : null,
    image: typeof oci.reference === "string" ? oci.reference : null,
  };
}
