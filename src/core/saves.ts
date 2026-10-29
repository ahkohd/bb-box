import { createHash } from "node:crypto";
import { isSecret, type BackendDriver } from "../backends/types.ts";
import { GENERAL_SECRETS, contentKey } from "./box-files.ts";
import { backendPart, type ConfigDocument, type SaveReceipt, type Secrets } from "./document.ts";
import { RECEIPTS_KEPT_AT_LEAST, RECEIPTS_KEPT_AT_MOST, RECEIPTS_KEPT_MS } from "./receipt-window.ts";
import { TAILNET_SECRET_KEYS } from "./tailnet-settings.ts";

export { RECEIPTS_KEPT_AT_LEAST, RECEIPTS_KEPT_AT_MOST, RECEIPTS_KEPT_MS };
export const SAVED_KEY = "config/saved";

export interface StoredReceipt extends SaveReceipt {
  readonly submission: string;
}

export interface SecretStamp {
  readonly version: number;
  readonly digest: string;
}

export interface BackendStamp {
  readonly changed: number;
  readonly digest: string;
}

export interface SaveLedger {
  readonly receipts: readonly StoredReceipt[];
  readonly secrets: Readonly<Record<string, Readonly<Record<string, SecretStamp>>>>;
  readonly backends: Readonly<Record<string, BackendStamp>>;
}

export interface SavedRecord {
  readonly document: ConfigDocument;
  readonly ledger: SaveLedger;
}

export const EMPTY_LEDGER: SaveLedger = { receipts: [], secrets: {}, backends: {} };

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, sortedKeys((value as Record<string, unknown>)[key])]),
  );
}

export function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortedKeys(value)) ?? "undefined").digest("hex");
}

const UNSET_DIGEST = "";

export function secretSlots(document: ConfigDocument, secrets: Secrets, drivers: readonly BackendDriver<any>[]): Map<string, Map<string, string | undefined>> {
  const slots = new Map<string, Map<string, string | undefined>>();
  const slot = (owner: string, key: string) => {
    const keys = slots.get(owner) ?? new Map<string, string | undefined>();
    keys.set(key, secrets[owner]?.[key]);
    slots.set(owner, keys);
  };
  for (const file of document.general.files ?? []) slot(GENERAL_SECRETS, contentKey(file.path));
  if (document.general.tailnet?.mode === "oauth") for (const key of TAILNET_SECRET_KEYS) slot(GENERAL_SECRETS, key);
  for (const backend of document.backends) {
    const driver = drivers.find((candidate) => candidate.type === backend.type);
    for (const [key, descriptor] of Object.entries(driver?.fields ?? {})) if (isSecret(descriptor)) slot(backend.id, key);
  }
  for (const [owner, values] of Object.entries(secrets)) for (const key of Object.keys(values)) slot(owner, key);
  return slots;
}

function backendDigest(document: ConfigDocument, index: number, secrets: Secrets, drivers: readonly BackendDriver<any>[]): string {
  const backend = document.backends[index]!;
  const driver = drivers.find((candidate) => candidate.type === backend.type);
  const hostSwitches = (backend.hosts ?? []).map((host) => [host.name, host.enabled]);
  if (!driver) return digestOf({ backend, hostSwitches });
  return digestOf({ part: backendPart(backend, driver, secrets, document.backends), hostSwitches });
}

export function stampedLedger(ledger: SaveLedger, document: ConfigDocument, secrets: Secrets, drivers: readonly BackendDriver<any>[], revision: number): SaveLedger {
  const stampedSecrets: Record<string, Record<string, SecretStamp>> = {};
  for (const [owner, keys] of secretSlots(document, secrets, drivers)) {
    const stamps: Record<string, SecretStamp> = {};
    for (const [key, value] of keys) {
      const digest = value === undefined ? UNSET_DIGEST : digestOf(value);
      const before = ledger.secrets[owner]?.[key];
      stamps[key] = before && before.digest === digest ? before : { version: revision, digest };
    }
    stampedSecrets[owner] = stamps;
  }
  const stampedBackends: Record<string, BackendStamp> = {};
  document.backends.forEach((backend, index) => {
    const digest = backendDigest(document, index, secrets, drivers);
    const before = ledger.backends[backend.id];
    stampedBackends[backend.id] = before && before.digest === digest ? before : { changed: revision, digest };
  });
  return { receipts: ledger.receipts, secrets: stampedSecrets, backends: stampedBackends };
}

export function stampsMoved(ledger: SaveLedger, revision: number): boolean {
  return (
    Object.values(ledger.secrets).some((keys) => Object.values(keys).some((stamp) => stamp.version === revision)) ||
    Object.values(ledger.backends).some((stamp) => stamp.changed === revision)
  );
}

export function secretVersion(ledger: SaveLedger, owner: string, key: string): number {
  return ledger.secrets[owner]?.[key]?.version ?? 0;
}

export function keptReceipts(receipts: readonly StoredReceipt[], now: number): StoredReceipt[] {
  const newest = receipts.slice(-RECEIPTS_KEPT_AT_MOST);
  return newest.filter((receipt, index) => index >= newest.length - RECEIPTS_KEPT_AT_LEAST || now - receipt.at <= RECEIPTS_KEPT_MS);
}

export function receiptView(receipt: StoredReceipt): SaveReceipt {
  return { operation: receipt.operation, revision: receipt.revision, at: receipt.at };
}

export function submissionDigest(submission: unknown): string {
  return digestOf(submission);
}
