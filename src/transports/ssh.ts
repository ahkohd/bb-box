// The SSH command transport, through the system `ssh` client. Boxes are
// fresh machines with new host keys and a known address, so host keys are not
// recorded. Every dial uses port 22 with a 2 s connect timeout and one
// attempt; callers retry on their own 1 s loop.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandLine } from "./process.ts";
import {
  TransportError,
  type CommandTransport,
  type GuestOs,
  type RunOptions,
  type RunResult,
  type StreamOptions,
} from "./types.ts";

export { quote } from "./process.ts";

export interface SshOptions {
  /** Path to the private key file, mode 0600. */
  readonly keyPath: string;
  readonly user: string;
  readonly binary?: string;
  readonly port?: number;
}

export class SshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshError";
  }
}

export class Ssh {
  readonly #options: SshOptions;

  constructor(options: SshOptions) {
    this.#options = options;
  }

  args(host: string, remoteCommand: string): string[] {
    return [
      "-p", String(this.#options.port ?? 22),
      "-i", this.#options.keyPath,
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=2",
      "-o", "ConnectionAttempts=1",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "GlobalKnownHostsFile=/dev/null",
      "-o", "LogLevel=ERROR",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-T",
      `${this.#options.user}@${host}`,
      "--",
      remoteCommand,
    ];
  }

  #line(host: string): CommandLine {
    return new CommandLine({
      argv: (script) => [this.#options.binary ?? "ssh", ...this.args(host, script)],
      error: (message) => new SshError(message),
    });
  }

  /** Runs `remoteCommand` in the box user's shell. */
  run(host: string, remoteCommand: string, options: RunOptions = {}): Promise<RunResult> {
    return this.#line(host).run(remoteCommand, options);
  }

  /** Runs `remoteCommand` and passes its output on as it arrives. */
  stream(host: string, remoteCommand: string, options: StreamOptions): Promise<{ exitCode: number | null; timedOut: boolean }> {
    return this.#line(host).stream(remoteCommand, options);
  }

  /** Writes `data` to `path` in the box, creating parent directories. */
  writeFile(host: string, path: string, data: Uint8Array, options: { mode?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    return this.#line(host).writeFile(path, data, options);
  }

  /** Reads `path` from the box. Fails when it is larger than `maxBytes`. */
  readFile(host: string, path: string, options: { maxBytes: number; timeoutMs?: number; signal?: AbortSignal }): Promise<Buffer> {
    return this.#line(host).readFile(path, options);
  }

  /** True when SSH answers and the shell runs. */
  probe(host: string, signal?: AbortSignal): Promise<boolean> {
    return this.#line(host).probe(signal);
  }
}

/** A box's CommandTransport over SSH. File copies use POSIX tools, so Windows needs another transport for now. */
export class SshTransport implements CommandTransport {
  readonly kind = "ssh";
  readonly #ssh: Ssh;
  readonly #host: string;
  readonly #os: GuestOs;

  constructor(ssh: Ssh, host: string, os: GuestOs) {
    this.#ssh = ssh;
    this.#host = host;
    this.#os = os;
  }

  probe(signal?: AbortSignal): Promise<boolean> {
    return this.#ssh.probe(this.#host, signal);
  }

  /** Exit 255 is also SSH's own failure, so it is checked with a probe. */
  async #reachable(exitCode: number | null, signal?: AbortSignal): Promise<void> {
    if (exitCode === 255 && !(await this.probe(signal))) {
      throw new TransportError("unreachable", `The box at ${this.#host} did not answer on SSH.`);
    }
  }

  async run(script: string, options: RunOptions = {}): Promise<RunResult> {
    const result = await this.#ssh.run(this.#host, script, options);
    await this.#reachable(result.exitCode, options.signal);
    return result;
  }

  async stream(script: string, options: StreamOptions): Promise<{ exitCode: number | null; timedOut: boolean }> {
    const result = await this.#ssh.stream(this.#host, script, options);
    await this.#reachable(result.exitCode, options.signal);
    return result;
  }

  #posixOnly(action: string): void {
    if (this.#os === "windows") throw new TransportError("unsupported", `SSH cannot ${action} on a Windows box yet.`);
  }

  async writeFile(path: string, data: Uint8Array, options: { mode?: string; signal?: AbortSignal } = {}): Promise<void> {
    this.#posixOnly("write files");
    try {
      await this.#ssh.writeFile(this.#host, path, data, options);
    } catch (error) {
      if (error instanceof SshError && !(await this.probe(options.signal))) {
        throw new TransportError("unreachable", `The box at ${this.#host} did not answer on SSH.`);
      }
      throw error;
    }
  }

  async readFile(path: string, options: { maxBytes: number; signal?: AbortSignal }): Promise<Uint8Array> {
    this.#posixOnly("read files");
    try {
      return await this.#ssh.readFile(this.#host, path, options);
    } catch (error) {
      if (error instanceof SshError && !/larger than/.test(error.message) && !(await this.probe(options.signal))) {
        throw new TransportError("unreachable", `The box at ${this.#host} did not answer on SSH.`);
      }
      throw error;
    }
  }
}

/** A private key written to a 0600 file for `ssh -i`. */
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
