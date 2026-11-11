import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { BackendStorage } from "../../src/backends/types.ts";

export class FileStorage implements BackendStorage {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  #read(): Record<string, unknown> {
    return existsSync(this.#path) ? (JSON.parse(readFileSync(this.#path, "utf8")) as Record<string, unknown>) : {};
  }

  #write(values: Record<string, unknown>): void {
    const next = `${this.#path}.${process.pid}`;
    writeFileSync(next, JSON.stringify(values));
    renameSync(next, this.#path);
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.#read()[key] as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.#write({ ...this.#read(), [key]: value });
  }

  async delete(key: string): Promise<void> {
    const { [key]: _gone, ...rest } = this.#read();
    this.#write(rest);
  }

  async list(prefix = ""): Promise<string[]> {
    return Object.keys(this.#read())
      .filter((key) => key.startsWith(prefix))
      .sort();
  }
}
