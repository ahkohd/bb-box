// Shared test fixtures. Addresses come from 192.0.2.0/24, which is reserved
// for documentation.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLxcSettings, type LxcConfig } from "../src/backends/proxmox-lxc/config.ts";
import type { BackendContext, BackendStorage } from "../src/backends/types.ts";
import { Ssh } from "../src/transports/ssh.ts";
import type { SshAccess } from "../src/transports/types.ts";

export const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";

export const VALID = {
  "proxmox-lxc-url": "https://pve.example.com:8006/",
  "proxmox-lxc-token-id": "bb-box@pve!plugin",
  "proxmox-lxc-token-secret": "s3cret",
  "proxmox-lxc-headless-templates": "9000",
  "proxmox-lxc-bridge": "vmbr1",
  "proxmox-lxc-subnet": "192.0.2.0/24",
  "proxmox-lxc-gateway": "192.0.2.1",
  "proxmox-lxc-addresses": "192.0.2.100-192.0.2.199",
  "proxmox-lxc-ssh-private-key": KEY,
};

export function lxcConfig(values: Record<string, unknown> = {}): LxcConfig {
  const result = parseLxcSettings({ ...VALID, ...values });
  assert.ok(result.enabled && result.ok, JSON.stringify(result));
  return result.config;
}

const temporary: string[] = [];
process.once("exit", () => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

/** A fresh directory, removed when the test process exits. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `bb-box-${prefix}-`));
  temporary.push(dir);
  return dir;
}

export const FAKE_SSH_BINARY = new URL("./fake-ssh.mjs", import.meta.url).pathname;

/** SSH access to a fresh box at `host`, as user box. */
export function at(host: string): SshAccess {
  return { host, port: 22, user: "box", hostKeys: [] };
}

/** Points the fake ssh at a fresh directory. Tests in one file run one at a time, so the environment variable is safe. */
/** A fake ssh client. `share` gives commands to one box a shared connection. */
export function fakeSsh(options: { share?: boolean } = {}) {
  const dir = tempDir("fake-ssh");
  process.env.FAKE_SSH_DIR = dir;
  mkdirSync(join(dir, "down"));
  mkdirSync(join(dir, "up-after"));
  mkdirSync(join(dir, "shared"));
  writeFileSync(join(dir, "log"), "");
  const ssh = new Ssh({ keyPath: "/nonexistent/key", binary: FAKE_SSH_BINARY, shareDir: options.share ? join(dir, "shared") : null });
  return {
    dir,
    ssh,
    home: (host: string) => join(dir, "home", host),
    down: (host: string) => writeFileSync(join(dir, "down", host), ""),
    upAfter: (host: string, dials: number) => writeFileSync(join(dir, "up-after", host), String(dials)),
    log: () =>
      readFileSync(join(dir, "log"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { target: string; command: string; args: string[]; control?: string }),
  };
}

export class MemoryStorage implements BackendStorage {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async list(prefix = ""): Promise<string[]> {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}

export function testContext(storage: BackendStorage = new MemoryStorage(), installId = "test"): BackendContext & { errors: string[] } {
  const errors: string[] = [];
  return {
    storage,
    installId,
    errors,
    logError: (operation, error) => errors.push(`${operation}: ${error instanceof Error ? error.message : String(error)}`),
  };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * A stand-in for BB's daemon in a box: a process running a program at
 * `parent`, whose workers each have only the given variables. Workers start
 * in order, so the last is the newest. Stop it when the test ends.
 */
export async function fakeDaemon(workers: readonly Readonly<Record<string, string>>[]) {
  const dir = tempDir("daemon");
  const parent = join(dir, "daemon-bundle");
  const lines = workers.map(
    (variables) =>
      `env -i ${Object.entries(variables)
        .map(([name, value]) => quote(`${name}=${value}`))
        .join(" ")} sleep 300 &`,
  );
  writeFileSync(parent, `${lines.join("\n")}\n: > ${quote(join(dir, "started"))}\nwait\n`);
  const daemon = spawn("sh", [parent], { detached: true, stdio: "ignore", env: { PATH: process.env.PATH } });
  const pid = daemon.pid!;
  const running = () => {
    try {
      return execFileSync("ps", ["-o", "pid=,comm=", "--ppid", String(pid)], { encoding: "utf8" })
        .split("\n")
        .filter((line) => /\bsleep$/.test(line.trim()));
    } catch {
      // ps exits 1 when it finds none.
      return [];
    }
  };
  for (let i = 0; !existsSync(join(dir, "started")) || running().length < workers.length; i++) {
    if (i > 400) throw new Error("the fake daemon did not start");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return {
    parent,
    /** The workers' process IDs, oldest first. */
    workers: () => running().map((line) => Number(line.trim().split(/\s+/)[0])).sort((a, b) => a - b),
    stop: () => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    },
  };
}
