// Shared test fixtures. Addresses come from 192.0.2.0/24, which is reserved
// for documentation.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendContext, BackendStorage } from "../src/backends/types.ts";
import { Ssh } from "../src/transports/ssh.ts";

export const FAKE_SSH_BINARY = new URL("./fake-ssh.mjs", import.meta.url).pathname;

/** Points the fake ssh at a fresh directory. Tests in one file run one at a time, so the environment variable is safe. */
export function fakeSsh() {
  const dir = mkdtempSync(join(tmpdir(), "bb-box-fake-ssh-"));
  process.env.FAKE_SSH_DIR = dir;
  mkdirSync(join(dir, "down"));
  mkdirSync(join(dir, "up-after"));
  writeFileSync(join(dir, "log"), "");
  const ssh = new Ssh({ keyPath: "/nonexistent/key", user: "box", binary: FAKE_SSH_BINARY });
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
        .map((line) => JSON.parse(line) as { target: string; command: string; args: string[] }),
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

export function testContext(storage: BackendStorage = new MemoryStorage()): BackendContext & { errors: string[] } {
  const errors: string[] = [];
  return {
    storage,
    errors,
    logError: (operation, error) => errors.push(`${operation}: ${error instanceof Error ? error.message : String(error)}`),
  };
}
