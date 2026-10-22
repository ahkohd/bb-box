// The SSH command transport, through the system `ssh` client, built from a
// box's SshAccess. A box with no pinned host keys is a fresh guest, so its
// first key is accepted and not recorded; pinned keys are checked against a
// known_hosts file the backend writes. A jump host is reached with the same
// key and options. Every dial has a 2 s connect timeout and one attempt;
// callers retry on their own 1 s loop. A box that stops answering without
// closing the connection, as when it dies, ends it within about 20 s; a box
// that is busy for less, as near its memory limit, keeps its commands.
//
// With a directory for sockets, commands to one box share a connection, so
// each command after the first skips SSH's handshake. bb-box starts the
// shared connection itself, one at a time, and ssh keeps it in the
// background until it has been idle for two minutes. bb-box stops using it
// shortly before then, and never puts more than 8 commands on it at once;
// sshd allows 10 sessions per connection. A command waits for it to open no
// longer than the command's own timeout, or until it is aborted, and then
// dials alone. A command that exits with 255, SSH's own failure, or times
// out stops new commands using the connection it went through, and so does
// a connection whose socket has gone, as ssh removes it when the connection
// ends, for example as the box restarts. A probe always dials afresh, so it
// says whether the box answers; the ready check opens the shared connection
// instead, for the commands that follow.

import { spawn } from "node:child_process";
import { startChild } from "./forker.ts";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandLine, PROBE, failure, quote } from "./process.ts";
import { COMMAND_LIMIT, powershellCommand, readFileScript, scriptText, stageCommand, stagedCommand, stagedName, writeFileScript } from "./powershell.ts";
import { openRoute } from "./route.ts";
import { openTerminal } from "./terminal.ts";
import {
  TransportError,
  type ByteChannel,
  type CommandTransport,
  type GuestOs,
  type Route,
  type RunOptions,
  type Terminal,
  type TerminalSize,
  type RunResult,
  type SshAccess,
  type StreamOptions,
} from "./types.ts";

export { quote } from "./process.ts";

export interface SshOptions {
  /** Path to the private key file, mode 0600. */
  readonly keyPath: string;
  /** A known_hosts file with every pinned key, needed when an access has host keys. */
  readonly knownHostsPath?: string | null;
  readonly binary?: string;
  /** A directory for shared connections' sockets. Without it, every command dials. */
  readonly shareDir?: string | null;
  /** How long a shared connection stays open with nothing using it. */
  readonly shareIdleMs?: number;
  /** After a command's connection is lost, how long the box has to answer again before it counts as unreachable. */
  readonly lostWaitMs?: number;
}

const SHARE_IDLE_MS = 120_000;
/**
 * A link that stalls, as a Mac's over Tailscale can for half a minute when
 * its network changes, or a host too busy to answer at once, gets this long
 * to answer again after it dropped a command, before it counts as gone.
 */
const LOST_WAIT_MS = 15_000;
/** Between probes in that wait. */
const LOST_PROBE_GAP_MS = 2_500;
/** A shared connection this close to closing gets no new commands. */
const SHARE_MARGIN_MS = 10_000;
const SHARE_MAX_SESSIONS = 8;
/** After a shared connection could not be made, commands dial alone for this long. */
const SHARE_RETRY_MS = 5_000;
const SHARE_START_TIMEOUT_MS = 15_000;

/** A connection that commands to one box share. */
interface Shared {
  readonly path: string;
  readonly target: string;
  /** Which box it reaches: see route(). */
  readonly route: string;
  state: "opening" | "open" | "failed" | "retired";
  readonly opened: Promise<boolean>;
  users: number;
  /** When the last command on it finished, or when it opened or failed. */
  since: number;
}

/** A command's place on a shared connection. */
interface Lease {
  readonly args: readonly string[];
  done(failed: boolean): void;
}

export class SshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshError";
  }
}

/**
 * The box an access reaches, through its jump hosts. Boxes behind one host
 * can share a user, host and address, as the Windows VMs on a Mac do,
 * reached through it at 127.0.0.1 on ports of their own.
 */
function route(access: SshAccess): string {
  const self = `${access.user}@${access.host}:${access.port}`;
  return access.jump ? `${self} via ${route(access.jump)}` : self;
}

function pinned(access: SshAccess): boolean {
  return access.hostKeys.length > 0 || (access.jump ? pinned(access.jump) : false);
}

export class Ssh {
  readonly #options: SshOptions;
  readonly #shared = new Map<string, Shared>();
  /** Shared connections new commands no longer use, until their socket goes. */
  readonly #retired = new Set<Shared>();
  #count = 0;

  constructor(options: SshOptions) {
    this.#options = options;
  }

  get binary(): string {
    return this.#options.binary ?? "ssh";
  }

  get lostWaitMs(): number {
    return this.#options.lostWaitMs ?? LOST_WAIT_MS;
  }

  /** Options for every dial to `access`, including the jump host. */
  options(access: SshAccess): string[] {
    const known = this.#options.knownHostsPath;
    if (pinned(access) && !known) throw new SshError(`${access.host} has pinned host keys but no known_hosts file was given.`);
    const hostKeys = access.hostKeys.length
      ? ["-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${known}`]
      : ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null"];
    // ProxyJump would drop -i and these options for the jump host, so the
    // jump is spelled out. ssh expands % in it, so only our own %h:%p is left
    // bare; a nested jump's is escaped for the next ssh to expand.
    const jump = access.jump
      ? [
          "-o",
          `ProxyCommand=${[this.binary, ...this.options(access.jump), "-W", "%h:%p", `${access.jump.user}@${access.jump.host}`]
            .map((part) => (part === "%h:%p" ? part : quote(part.replaceAll("%", "%%"))))
            .join(" ")}`,
        ]
      : [];
    return [
      "-p", String(access.port),
      "-i", this.#options.keyPath,
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=2",
      "-o", "ConnectionAttempts=1",
      ...hostKeys,
      "-o", "GlobalKnownHostsFile=/dev/null",
      "-o", "LogLevel=ERROR",
      "-o", "ServerAliveInterval=5",
      // A link that stalls for up to half a minute keeps its commands (#707).
      "-o", "ServerAliveCountMax=6",
      ...jump,
    ];
  }

  args(access: SshAccess, remoteCommand: string, share: readonly string[] = []): string[] {
    return [...this.options(access), ...share, "-T", `${access.user}@${access.host}`, "--", remoteCommand];
  }

  get #idleMs(): number {
    return this.#options.shareIdleMs ?? SHARE_IDLE_MS;
  }

  /** A place on the box's shared connection, opening it first. Null dials alone. */
  async #lease(access: SshAccess, waitMs?: number, signal?: AbortSignal): Promise<Lease | null> {
    const dir = this.#options.shareDir;
    if (!dir || process.platform === "win32") return null;
    const options = this.options(access);
    const target = `${access.user}@${access.host}`;
    const key = createHash("sha256").update([...options, target].join("\0")).digest("hex").slice(0, 12);
    let shared = this.#shared.get(key);
    const now = Date.now();
    if (shared?.state === "failed" && now - shared.since < SHARE_RETRY_MS) return null;
    const ended = shared?.state === "open" && !existsSync(shared.path);
    if (shared && (ended || shared.state === "failed" || (shared.users === 0 && now - shared.since > this.#idleMs - SHARE_MARGIN_MS))) {
      this.#retire(key, shared);
      shared = undefined;
    }
    if (!shared) {
      shared = this.#open(options, target, route(access), join(dir, `${key}-${++this.#count}`));
      this.#shared.set(key, shared);
    }
    if (shared.users >= SHARE_MAX_SESSIONS) return null;
    shared.users++;
    const finish = (failed: boolean) => {
      shared.users--;
      shared.since = Date.now();
      if (failed) this.#retire(key, shared);
    };
    if (!(await this.#opened(shared, waitMs, signal))) {
      finish(false);
      return null;
    }
    return { args: ["-o", "ControlMaster=no", "-o", `ControlPath=${shared.path}`], done: finish };
  }

  /** Whether `shared` opened within `waitMs`. A wait that ends sooner leaves it opening. */
  #opened(shared: Shared, waitMs?: number, signal?: AbortSignal): Promise<boolean> {
    if (!waitMs && !signal) return shared.opened;
    return new Promise((resolve) => {
      const done = (open: boolean) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        resolve(open);
      };
      const stop = () => done(false);
      const timer = waitMs ? setTimeout(stop, waitMs) : undefined;
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      void shared.opened.then(done);
    });
  }

  /** Starts a shared connection, which ssh keeps in the background once it is up. */
  #open(options: readonly string[], target: string, box: string, path: string): Shared {
    const persist = `${Math.ceil(this.#idleMs / 1000)}s`;
    const argv = [...options, "-o", "ControlMaster=yes", "-o", `ControlPath=${path}`, "-o", `ControlPersist=${persist}`, "-N", target];
    const shared: Shared = {
      path,
      target,
      route: box,
      state: "opening",
      users: 0,
      since: Date.now(),
      opened: new Promise<boolean>((resolve) => {
        // The master stays in the background with no pipe of the helper's held open.
        const child = startChild(this.binary, argv, { stdio: "ignore", site: "ssh master open" });
        const timer = setTimeout(() => child.kill("SIGKILL"), SHARE_START_TIMEOUT_MS);
        const settle = (open: boolean) => {
          clearTimeout(timer);
          if (shared.state === "opening") shared.state = open ? "open" : "failed";
          shared.since = Date.now();
          resolve(open);
        };
        child.on("error", () => settle(false));
        child.on("exit", (code) => settle(code === 0));
      }),
    };
    return shared;
  }

  /** New commands stop using a shared connection. ssh closes it once its commands finish and it has been idle. */
  #retire(key: string, shared: Shared): void {
    if (this.#shared.get(key) === shared) this.#shared.delete(key);
    if (shared.state === "failed") return;
    shared.state = "retired";
    this.#retired.add(shared);
    for (const old of this.#retired) if (!existsSync(old.path)) this.#retired.delete(old);
  }

  /** Closes a shared connection that opened, now. */
  #end(shared: Shared): Promise<void> {
    return shared.opened.then((open) => (open ? this.#close(shared) : undefined));
  }

  /** Closes a shared connection now, and ends what runs on it. */
  #close(shared: Shared): Promise<void> {
    shared.state = "retired";
    return new Promise((resolve) => {
      const child = startChild(this.binary, ["-o", `ControlPath=${shared.path}`, "-O", "exit", shared.target], { stdio: "ignore", site: "ssh master close" });
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      child.on("error", done);
      child.on("exit", done);
    });
  }

  /** Closes the box's shared connections, retired ones too, as before it stops or goes. */
  async forget(access: SshAccess): Promise<void> {
    const box = route(access);
    const closing: Promise<void>[] = [];
    for (const [key, shared] of this.#shared) {
      if (shared.route !== box) continue;
      this.#shared.delete(key);
      closing.push(this.#end(shared));
    }
    for (const shared of this.#retired) {
      if (shared.route !== box) continue;
      this.#retired.delete(shared);
      closing.push(this.#end(shared));
    }
    await Promise.all(closing);
  }

  /** Closes every shared connection, retired ones too. */
  async dispose(): Promise<void> {
    const all = [...this.#shared.values(), ...this.#retired];
    this.#shared.clear();
    this.#retired.clear();
    await Promise.all(all.map((shared) => this.#end(shared)));
  }

  /** Runs `task` with a place on the box's shared connection, when there is one. */
  async #leased<T>(
    access: SshAccess,
    options: { timeoutMs?: number; signal?: AbortSignal },
    task: (share: readonly string[]) => Promise<T>,
    failed: (result: T) => boolean,
  ): Promise<T> {
    const lease = await this.#lease(access, options.timeoutMs, options.signal);
    try {
      const result = await task(lease?.args ?? []);
      lease?.done(failed(result));
      return result;
    } catch (error) {
      lease?.done(error instanceof SshError && /: (exit 255\b|timed out\.)/.test(error.message));
      throw error;
    }
  }

  /**
   * The box user's login shell over `ssh -tt`, on the box's shared connection when there is one: a fresh connection's
   * handshake was most of the shell's first output (#916). The place on it is given back as the terminal closes.
   */
  async terminal(access: SshAccess, size: TerminalSize, signal?: AbortSignal): Promise<Terminal> {
    const lease = await this.#lease(access, undefined, signal);
    let terminal: Terminal;
    try {
      terminal = await openTerminal([this.binary, ...this.options(access), ...(lease?.args ?? []), "-tt", `${access.user}@${access.host}`], size, signal);
    } catch (error) {
      lease?.done(true);
      throw error;
    }
    if (!lease) return terminal;
    let given = false;
    const giveBack = () => {
      if (given) return;
      given = true;
      lease.done(false);
    };
    return {
      ...terminal,
      close: async () => {
        try {
          await terminal.close();
        } finally {
          giveBack();
        }
      },
    };
  }

  /** A route to `port` inside the box, carried by `ssh -W`. */
  /** A route to what a command on the host serves on its stdin and stdout, such as a unix socket through `nc -U`. */
  commandRoute(access: SshAccess, command: string): Route {
    return { type: "command", argv: [this.binary, ...this.args(access, command)] };
  }

  route(access: SshAccess, port: number): Route {
    return {
      type: "command",
      argv: [this.binary, ...this.options(access), "-o", "ExitOnForwardFailure=yes", "-W", `127.0.0.1:${port}`, `${access.user}@${access.host}`],
    };
  }

  /** Scripts for `os`: POSIX sh unless it is Windows. */
  #line(access: SshAccess, os: GuestOs = "linux", share: readonly string[] = []): CommandLine {
    return new CommandLine({
      argv: (script) => [this.binary, ...this.args(access, script, share)],
      error: (message) => new SshError(message),
      posix: os !== "windows",
    });
  }

  /** Runs `remoteCommand` with its stdin and stdout as the channel, over `ssh -T`, and in PowerShell on Windows, as run does. */
  async spawn(access: SshAccess, remoteCommand: string, signal?: AbortSignal, os?: GuestOs): Promise<ByteChannel> {
    const command = os === "windows" ? await this.#powershell(access, remoteCommand, { signal }) : remoteCommand;
    if (typeof command !== "string") throw new SshError(`The command could not start: ${command.stderr.trim() || `exit ${command.exitCode}`}`);
    return openRoute({ type: "command", argv: [this.binary, ...this.args(access, command)] }, signal);
  }

  /** Runs `remoteCommand` in the box user's shell. It returns when that shell exits, even if it left something running. */
  async run(access: SshAccess, remoteCommand: string, options: RunOptions = {}, os?: GuestOs): Promise<RunResult> {
    const command = os === "windows" ? await this.#powershell(access, remoteCommand, options) : remoteCommand;
    if (typeof command !== "string") return command;
    return this.#leased(access, options, (share) => this.#line(access, os, share).run(command, options), lost);
  }

  /** Runs `remoteCommand` and passes its output on as it arrives. */
  async stream(access: SshAccess, remoteCommand: string, options: StreamOptions, os?: GuestOs): Promise<{ exitCode: number | null; timedOut: boolean }> {
    const command = os === "windows" ? await this.#powershell(access, remoteCommand, options) : remoteCommand;
    if (typeof command !== "string") {
      if (command.stderr) options.onOutput(Buffer.from(command.stderr), "stderr");
      return { exitCode: command.exitCode, timedOut: command.timedOut };
    }
    return this.#leased(access, options, (share) => this.#line(access, os, share).stream(command, options), lost);
  }

  /**
   * The command that runs a PowerShell script. One too long for Windows'
   * command line is first written to a file in the box, over stdin; when
   * that fails, its result stands for the script's.
   */
  async #powershell(access: SshAccess, script: string, options: { timeoutMs?: number; signal?: AbortSignal }): Promise<string | RunResult> {
    const command = powershellCommand(script);
    if (command.length <= COMMAND_LIMIT) return command;
    const name = stagedName();
    const staging = { stdin: Buffer.from(scriptText(script), "utf8"), timeoutMs: options.timeoutMs, signal: options.signal };
    const staged = await this.#leased(access, staging, (share) => this.#line(access, "windows", share).run(stageCommand(name), staging), lost);
    return staged.exitCode === 0 ? stagedCommand(name) : staged;
  }

  /** Writes `data` to `path` in the box, creating parent directories. On Windows, `mode` does not apply. */
  async writeFile(access: SshAccess, path: string, data: Uint8Array, options: { mode?: string; timeoutMs?: number; signal?: AbortSignal } = {}, os?: GuestOs): Promise<void> {
    const script = os === "windows" ? await this.#fileScript(access, writeFileScript(path), `write ${path}`, options) : undefined;
    return this.#leased(access, options, (share) => this.#line(access, os, share).writeFile(path, data, { ...options, script }), () => false);
  }

  /** Reads `path` from the box. Fails when it is larger than `maxBytes`. */
  async readFile(access: SshAccess, path: string, options: { maxBytes: number; timeoutMs?: number; signal?: AbortSignal }, os?: GuestOs): Promise<Buffer> {
    const script = os === "windows" ? await this.#fileScript(access, readFileScript(path), `read ${path}`, options) : undefined;
    return this.#leased(access, options, (share) => this.#line(access, os, share).readFile(path, { ...options, script }), () => false);
  }

  /** The command for a Windows file copy's script, whose stdin or stdout is the file's bytes. */
  async #fileScript(access: SshAccess, script: string, action: string, options: { timeoutMs?: number; signal?: AbortSignal }): Promise<string> {
    const command = await this.#powershell(access, script, options);
    if (typeof command !== "string") throw new SshError(failure(action, command));
    return command;
  }

  /** True when SSH answers and the shell runs. */
  probe(access: SshAccess, signal?: AbortSignal, os?: GuestOs): Promise<boolean> {
    return this.#line(access, os).probe(signal);
  }

  /**
   * True when the shell runs, on the box's shared connection, which this
   * opens. The connection costs a probe's handshake, and the box's next
   * commands skip theirs. Without one, it dials afresh as a probe does.
   */
  async answers(access: SshAccess, signal?: AbortSignal, os?: GuestOs): Promise<boolean> {
    return (await this.run(access, PROBE, { timeoutMs: 5_000, signal }, os)).exitCode === 0;
  }
}

/**
 * Whether a command's connection may be gone: SSH's own failure, or a
 * timeout here. Where they can, callers have the box stop a command first,
 * so a timeout here mostly means the box stopped answering.
 */
function lost(result: { exitCode: number | null; timedOut: boolean }): boolean {
  return result.exitCode === 255 || result.timedOut;
}

/** A box's CommandTransport over SSH. File copies use POSIX tools, and PowerShell on Windows. */
export class SshTransport implements CommandTransport {
  readonly #ssh: Ssh;
  readonly #access: SshAccess;
  readonly #os: GuestOs;

  constructor(ssh: Ssh, access: SshAccess, os: GuestOs) {
    this.#ssh = ssh;
    this.#access = access;
    this.#os = os;
  }

  probe(signal?: AbortSignal): Promise<boolean> {
    return this.#ssh.probe(this.#access, signal, this.#os);
  }

  /** True when the box answers on its shared connection, which this opens. */
  answers(signal?: AbortSignal): Promise<boolean> {
    return this.#ssh.answers(this.#access, signal, this.#os);
  }

  #unreachable(): TransportError {
    return new TransportError("unreachable", `The box at ${this.#access.host} did not answer on SSH.`);
  }

  /** Exit 255 is also SSH's own failure, so it is checked with a probe. */
  async #reachable(exitCode: number | null, signal?: AbortSignal): Promise<void> {
    if (exitCode === 255 && !(await this.#answersAgain(signal))) throw this.#unreachable();
  }

  /**
   * Whether the box answers a probe within the Ssh's lost wait, probing
   * every few seconds: a link that stalled answers again soon, and a box
   * that is gone does not.
   */
  async #answersAgain(signal?: AbortSignal): Promise<boolean> {
    const until = Date.now() + this.#ssh.lostWaitMs;
    for (;;) {
      if (await this.probe(signal)) return true;
      const left = until - Date.now();
      if (left <= 0 || signal?.aborted) return false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(LOST_PROBE_GAP_MS, left));
        signal?.addEventListener("abort", done, { once: true });
        function done() {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        }
      });
    }
  }

  async run(script: string, options: RunOptions = {}): Promise<RunResult> {
    const result = await this.#ssh.run(this.#access, script, options, this.#os);
    await this.#reachable(result.exitCode, options.signal);
    return result;
  }

  async stream(script: string, options: StreamOptions): Promise<{ exitCode: number | null; timedOut: boolean }> {
    const result = await this.#ssh.stream(this.#access, script, options, this.#os);
    await this.#reachable(result.exitCode, options.signal);
    return result;
  }

  async writeFile(path: string, data: Uint8Array, options: { mode?: string; signal?: AbortSignal } = {}): Promise<void> {
    try {
      await this.#ssh.writeFile(this.#access, path, data, options, this.#os);
    } catch (error) {
      if (error instanceof SshError && !(await this.#answersAgain(options.signal))) throw this.#unreachable();
      throw error;
    }
  }

  async readFile(path: string, options: { maxBytes: number; signal?: AbortSignal }): Promise<Uint8Array> {
    try {
      return await this.#ssh.readFile(this.#access, path, options, this.#os);
    } catch (error) {
      if (error instanceof SshError && !/larger than/.test(error.message) && !(await this.#answersAgain(options.signal))) throw this.#unreachable();
      throw error;
    }
  }

  async route(port: number): Promise<Route> {
    return this.#ssh.route(this.#access, port);
  }

  spawn(script: string, signal?: AbortSignal): Promise<ByteChannel> {
    return this.#ssh.spawn(this.#access, script, signal, this.#os);
  }

  /** The box user's login shell over `ssh -tt`, on a PTY here. ssh passes TERM and the size on. */
  terminal(size: TerminalSize, signal?: AbortSignal): Promise<Terminal> {
    return this.#ssh.terminal(this.#access, size, signal);
  }
}

/** A private key written to a 0600 file for `ssh -i`, and known_hosts files beside it. */
export class KeyFile {
  #dir: string | null = null;
  #shareDir: string | null = null;
  #path: string | null = null;
  #key: string | null = null;

  async path(privateKey: string): Promise<string> {
    const key = privateKey.replace(/\r\n/g, "\n").trim() + "\n";
    if (this.#path && this.#key === key) return this.#path;
    if (!this.#dir) this.#dir = await mkdtemp(join(tmpdir(), "bb-box-ssh-"));
    const path = join(this.#dir, "id");
    await writeFile(path, key, { mode: 0o600 });
    this.#path = path;
    this.#key = key;
    return path;
  }

  /** Writes known_hosts lines for pinned host keys, and returns the file's path. */
  async knownHosts(lines: readonly string[]): Promise<string> {
    const text = lines.map((line) => line.trim()).filter(Boolean).join("\n") + "\n";
    if (!this.#dir) this.#dir = await mkdtemp(join(tmpdir(), "bb-box-ssh-"));
    const path = join(this.#dir, `known_hosts-${createHash("sha256").update(text).digest("hex").slice(0, 16)}`);
    await writeFile(path, text, { mode: 0o600 });
    return path;
  }

  /** A directory for shared connections' sockets. A socket's path must fit in about 100 bytes, so it is short. */
  async shareDir(): Promise<string> {
    this.#shareDir ??= await mkdtemp(join(tmpdir().length > 40 ? "/tmp" : tmpdir(), "bb-box-cm-"));
    return this.#shareDir;
  }

  async dispose(): Promise<void> {
    for (const dir of [this.#dir, this.#shareDir]) if (dir) await rm(dir, { recursive: true, force: true });
    this.#dir = this.#shareDir = this.#path = this.#key = null;
  }
}

/** A new ed25519 key pair, made with ssh-keygen. */
export async function generateKeyPair(binary = "ssh-keygen"): Promise<{ privateKey: string; publicKey: string }> {
  const dir = await mkdtemp(join(tmpdir(), "bb-box-keygen-"));
  try {
    const path = join(dir, "id");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, ["-q", "-t", "ed25519", "-N", "", "-C", "bb-box", "-f", path], { stdio: "ignore" });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new SshError(`ssh-keygen exited with ${code}.`))));
    });
    const [privateKey, publicKeyText] = await Promise.all([readFile(path, "utf8"), readFile(`${path}.pub`, "utf8")]);
    return { privateKey, publicKey: `${publicKeyText.trim().split(/\s+/).slice(0, 2).join(" ")} bb-box` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * An OpenSSH private key in its usual form. Accepts a key pasted into a
 * one-line field, whose line breaks became spaces, and a base64-encoded key file.
 */
export function normalisePrivateKey(value: string): string | null {
  let key = value.trim();
  if (!key) return null;
  if (!key.includes("-----BEGIN")) {
    try {
      const decoded = Buffer.from(key, "base64").toString("utf8").trim();
      if (!decoded.startsWith("-----BEGIN")) return null;
      key = decoded;
    } catch {
      return null;
    }
  }
  const match = /^-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----([\s\S]*?)-----END \1-----$/.exec(key);
  if (!match) return null;
  const body = match[2]!.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(body)) return null;
  const lines = body.match(/.{1,70}/g) ?? [];
  return `-----BEGIN ${match[1]}-----\n${lines.join("\n")}\n-----END ${match[1]}-----\n`;
}

/** The public key for a private key file, for the template's authorized_keys. */
export function publicKey(keyPath: string, binary = "ssh-keygen"): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(binary, ["-y", "-f", keyPath], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 && out.trim() ? `${out.trim().split(/\s+/).slice(0, 2).join(" ")} bb-box` : null));
  });
}
