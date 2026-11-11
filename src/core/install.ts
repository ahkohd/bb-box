// This install's ID (018). Each bb-box install makes a random ID the first
// time it starts and keeps it in plugin storage. Backends record it on every
// guest and act only on guests that carry it, so installs that share a host
// leave each other's guests alone. An install that lost its storage takes its
// old ID back with `bb box install-id --set <id>`.

import { randomInt } from "node:crypto";

export const INSTALL_ID_KEY = "install-id";
export const LONGEST_INSTALL_ID = 32;
const PATTERN = new RegExp(`^[a-z0-9][a-z0-9-]{0,${LONGEST_INSTALL_ID - 1}}$`);
const LETTERS = "abcdefghijklmnopqrstuvwxyz0123456789";

interface Kv {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

/** Lowercase letters, digits and hyphens, starting with a letter or digit, at most 32. A tag or label on any provider. */
export function isInstallId(value: unknown): value is string {
  return typeof value === "string" && PATTERN.test(value);
}

export function newInstallId(): string {
  return Array.from({ length: 10 }, () => LETTERS[randomInt(LETTERS.length)]).join("");
}

/** The stored ID, made and stored the first time. */
export async function loadInstallId(kv: Kv): Promise<string> {
  const stored = await kv.get<unknown>(INSTALL_ID_KEY);
  if (isInstallId(stored)) return stored;
  const id = newInstallId();
  await kv.set(INSTALL_ID_KEY, id);
  return id;
}

/** The ID, or an error that says what an install ID looks like. */
export function requireInstallId(id: string): string {
  if (!isInstallId(id)) {
    throw new Error(`"${id}" is not an install ID: use lowercase letters, digits and hyphens, at most 32, starting with a letter or digit.`);
  }
  return id;
}

export async function storeInstallId(kv: Kv, id: string): Promise<void> {
  await kv.set(INSTALL_ID_KEY, requireInstallId(id));
}
