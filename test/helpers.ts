// Shared test fixtures. Addresses come from 192.0.2.0/24, which is reserved
// for documentation.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseLxcSettings, type LxcConfig } from "../src/backends/proxmox-lxc/config.ts";
import type { BackendContext, BackendStorage, KindSettings } from "../src/backends/types.ts";
import { defaultSize, kindSizes, presetSizes } from "../src/core/sizes.ts";
import { Ssh } from "../src/transports/ssh.ts";
import type { SshAccess } from "../src/transports/types.ts";

export const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";

export const VALID = {
  "proxmox-lxc-url": "https://pve.example.com:8006/",
  "proxmox-lxc-token-id": "bb-box@pve!plugin",
  "proxmox-lxc-token-secret": "s3cret",
  "proxmox-lxc-linux-templates": "9000",
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
  mkdirSync(join(dir, "hold-share"));
  mkdirSync(join(dir, "windows"));
  writeFileSync(join(dir, "log"), "");
  const ssh = new Ssh({ keyPath: "/nonexistent/key", binary: FAKE_SSH_BINARY, shareDir: options.share ? join(dir, "shared") : null });
  return {
    dir,
    ssh,
    home: (host: string) => join(dir, "home", host),
    down: (host: string) => writeFileSync(join(dir, "down", host), ""),
    upAfter: (host: string, dials: number) => writeFileSync(join(dir, "up-after", host), String(dials)),
    /** Makes `host` a Windows box, whose shell is PowerShell. */
    windows: (host: string) => writeFileSync(join(dir, "windows", host), ""),
    /** Keeps a shared connection to `host` from opening until the returned function is called. */
    holdShare: (host: string) => {
      writeFileSync(join(dir, "hold-share", host), "");
      return () => rmSync(join(dir, "hold-share", host));
    },
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

/** Warm counts by kind from the Proxmox LXC settings before 029: each flavour's goes to its first kind. */
export function lxcWarm(values: Readonly<Record<string, unknown>>): Record<string, number> {
  const kinds = { linux: "linux", desktop: "linux-desktop", "desktop-cpu": "linux-desktop-cpu" };
  return Object.fromEntries(Object.entries(kinds).map(([flavour, kind]) => [kind, Number(values[`proxmox-lxc-${flavour}-warm`] ?? 0)]));
}

/** A kind as bb-box ships it, switched on. */
export function shippedKind(id: string): KindSettings {
  const sizes = kindSizes(id);
  return { enabled: true, defaultSize: defaultSize(sizes), presets: presetSizes(sizes) };
}

export function testContext(
  storage: BackendStorage = new MemoryStorage(),
  installId = "test",
  options: { id?: string; warm?: Readonly<Record<string, number>> } = {},
): BackendContext & { errors: string[] } {
  const errors: string[] = [];
  return {
    id: options.id ?? "test",
    storage,
    installId,
    warm: (kind) => options.warm?.[kind] ?? 0,
    hostOn: () => true,
    kind: shippedKind,
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
 * in order, so the last is the newest. With `startOn`, they start `seconds`
 * after that file appears, as BB's do a moment after its daemon connects,
 * and this returns without waiting for them. With `parent`, the program is
 * there, so a box can be told of it before the daemon runs. Stop it when the
 * test ends.
 */
export async function fakeDaemon(
  workers: readonly Readonly<Record<string, string>>[],
  options: { startOn?: { file: string; seconds: number }; parent?: string } = {},
) {
  const parent = options.parent ?? join(tempDir("daemon"), "daemon-bundle");
  const dir = dirname(parent);
  const lines = workers.map(
    (variables) =>
      `env -i ${Object.entries(variables)
        .map(([name, value]) => quote(`${name}=${value}`))
        .join(" ")} sleep 300 &`,
  );
  const { startOn } = options;
  const wait = startOn ? `while [ ! -e ${quote(startOn.file)} ]; do sleep 0.05; done\nsleep ${startOn.seconds}\n` : "";
  const started = `: > ${quote(join(dir, "started"))}\n`;
  writeFileSync(parent, startOn ? `${started}${wait}${lines.join("\n")}\nwait\n` : `${lines.join("\n")}\n${started}wait\n`);
  const daemon = spawn("sh", [parent], { detached: true, stdio: "ignore", env: { PATH: process.env.PATH } });
  const pid = daemon.pid!;
  const running = () => {
    try {
      // Not the `sleep` before them, with `startOn`.
      return execFileSync("ps", ["-o", "pid=,args=", "--ppid", String(pid)], { encoding: "utf8" })
        .split("\n")
        .filter((line) => /\bsleep 300$/.test(line.trim()));
    } catch {
      // ps exits 1 when it finds none.
      return [];
    }
  };
  for (let i = 0; !existsSync(join(dir, "started")) || (!startOn && running().length < workers.length); i++) {
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
