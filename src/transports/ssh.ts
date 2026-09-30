// The SSH command transport, through the system `ssh` client, built from a
// box's SshAccess. A box with no pinned host keys is a fresh guest, so its
// first key is accepted and not recorded; pinned keys are checked against a
// known_hosts file the backend writes. A jump host is reached with the same
// key and options. Every dial has a 2 s connect timeout and one attempt;
// callers retry on their own 1 s loop.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandLine, quote } from "./process.ts";
import { openRoute } from "./route.ts";
import {
  TransportError,
  type ByteChannel,
  type CommandTransport,
  type GuestOs,
  type Route,
  type RunOptions,
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
}

export class SshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshError";
  }
}

function pinned(access: SshAccess): boolean {
  return access.hostKeys.length > 0 || (access.jump ? pinned(access.jump) : false);
}

export class Ssh {
  readonly #options: SshOptions;

  constructor(options: SshOptions) {
    this.#options = options;
  }

  get binary(): string {
    return this.#options.binary ?? "ssh";
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
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      ...jump,
    ];
  }

  args(access: SshAccess, remoteCommand: string): string[] {
    return [...this.options(access), "-T", `${access.user}@${access.host}`, "--", remoteCommand];
  }

  /** A route to `port` inside the box, carried by `ssh -W`. */
  route(access: SshAccess, port: number): Route {
    return {
      type: "command",
      argv: [this.binary, ...this.options(access), "-o", "ExitOnForwardFailure=yes", "-W", `127.0.0.1:${port}`, `${access.user}@${access.host}`],
    };
  }

  #line(access: SshAccess): CommandLine {
    return new CommandLine({
      argv: (script) => [this.binary, ...this.args(access, script)],
      error: (message) => new SshError(message),
    });
  }

  /** Runs `remoteCommand` with its stdin and stdout as the channel, over `ssh -T`. */
  spawn(access: SshAccess, remoteCommand: string, signal?: AbortSignal): Promise<ByteChannel> {
    return openRoute({ type: "command", argv: [this.binary, ...this.args(access, remoteCommand)] }, signal);
  }

  /** Runs `remoteCommand` in the box user's shell. */
  run(access: SshAccess, remoteCommand: string, options: RunOptions = {}): Promise<RunResult> {
    return this.#line(access).run(remoteCommand, options);
  }

  /** Runs `remoteCommand` and passes its output on as it arrives. */
  stream(access: SshAccess, remoteCommand: string, options: StreamOptions): Promise<{ exitCode: number | null; timedOut: boolean }> {
    return this.#line(access).stream(remoteCommand, options);
  }

  /** Writes `data` to `path` in the box, creating parent directories. */
  writeFile(access: SshAccess, path: string, data: Uint8Array, options: { mode?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    return this.#line(access).writeFile(path, data, options);
  }

  /** Reads `path` from the box. Fails when it is larger than `maxBytes`. */
  readFile(access: SshAccess, path: string, options: { maxBytes: number; timeoutMs?: number; signal?: AbortSignal }): Promise<Buffer> {
    return this.#line(access).readFile(path, options);
  }

  /** True when SSH answers and the shell runs. */
  probe(access: SshAccess, signal?: AbortSignal): Promise<boolean> {
    return this.#line(access).probe(signal);
  }
}

/** A box's CommandTransport over SSH. File copies use POSIX tools, so Windows needs another transport for now. */
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
    return this.#ssh.probe(this.#access, signal);
  }

  #unreachable(): TransportError {
    return new TransportError("unreachable", `The box at ${this.#access.host} did not answer on SSH.`);
  }

  /** Exit 255 is also SSH's own failure, so it is checked with a probe. */
  async #reachable(exitCode: number | null, signal?: AbortSignal): Promise<void> {
    if (exitCode === 255 && !(await this.probe(signal))) throw this.#unreachable();
  }

  async run(script: string, options: RunOptions = {}): Promise<RunResult> {
    const result = await this.#ssh.run(this.#access, script, options);
    await this.#reachable(result.exitCode, options.signal);
    return result;
  }

  async stream(script: string, options: StreamOptions): Promise<{ exitCode: number | null; timedOut: boolean }> {
    const result = await this.#ssh.stream(this.#access, script, options);
    await this.#reachable(result.exitCode, options.signal);
    return result;
  }

  #posixOnly(action: string): void {
    if (this.#os === "windows") throw new TransportError("unsupported", `SSH cannot ${action} on a Windows box yet.`);
  }

  async writeFile(path: string, data: Uint8Array, options: { mode?: string; signal?: AbortSignal } = {}): Promise<void> {
    this.#posixOnly("write files");
    try {
      await this.#ssh.writeFile(this.#access, path, data, options);
    } catch (error) {
      if (error instanceof SshError && !(await this.probe(options.signal))) throw this.#unreachable();
      throw error;
    }
  }

  async readFile(path: string, options: { maxBytes: number; signal?: AbortSignal }): Promise<Uint8Array> {
    this.#posixOnly("read files");
    try {
      return await this.#ssh.readFile(this.#access, path, options);
    } catch (error) {
      if (error instanceof SshError && !/larger than/.test(error.message) && !(await this.probe(options.signal))) throw this.#unreachable();
      throw error;
    }
  }

  async route(port: number): Promise<Route> {
    return this.#ssh.route(this.#access, port);
  }

  spawn(script: string, signal?: AbortSignal): Promise<ByteChannel> {
    return this.#ssh.spawn(this.#access, script, signal);
  }
}

/** A private key written to a 0600 file for `ssh -i`, and known_hosts files beside it. */
export class KeyFile {
  #dir: string | null = null;
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

  async dispose(): Promise<void> {
    if (this.#dir) await rm(this.#dir, { recursive: true, force: true });
    this.#dir = this.#path = this.#key = null;
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
