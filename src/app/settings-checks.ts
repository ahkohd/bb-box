import type { CheckResult } from "../plugin/configuration.ts";
import type { Edit, Path } from "./settings-paths.ts";

export interface FormCheck {
  readonly revision: number;
  readonly edits: string;
  readonly againstDraft: boolean;
  readonly at: number;
  readonly result: CheckResult | null;
  readonly failure: string | null;
}

export interface Fingerprint {
  readonly revision: number;
  readonly edits: string;
}

function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function fingerprintOf(revision: number, edits: ReadonlyMap<Path, Edit>): Fingerprint {
  const ordered = [...edits].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, edit]) => [path, edit.value]);
  return { revision, edits: hashText(JSON.stringify(ordered)) };
}

export type CheckBinding = "current" | "form-changed" | "configuration-changed";

export function bindingOf(check: FormCheck, now: Fingerprint): CheckBinding {
  if (check.edits !== now.edits) return "form-changed";
  if (check.revision !== now.revision) return "configuration-changed";
  return "current";
}

class CheckStore {
  readonly #checks = new Map<string, FormCheck>();
  readonly #running = new Map<string, Fingerprint>();
  readonly #listeners = new Set<() => void>();
  #serial = 0;

  get serial(): number {
    return this.#serial;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(): void {
    this.#serial += 1;
    for (const listener of this.#listeners) listener();
  }

  last(part: string): FormCheck | null {
    return this.#checks.get(part) ?? null;
  }

  running(part: string): boolean {
    return this.#running.has(part);
  }

  async run(part: string, fingerprint: Fingerprint, againstDraft: boolean, check: () => Promise<CheckResult>, now: () => number): Promise<void> {
    if (this.#running.has(part)) return;
    this.#running.set(part, fingerprint);
    this.#notify();
    let result: CheckResult | null = null;
    let failure: string | null = null;
    try {
      result = await check();
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : String(caught);
    }
    this.#running.delete(part);
    this.#checks.set(part, { ...fingerprint, againstDraft, at: now(), result, failure });
    this.#notify();
  }

  forget(part: string): void {
    if (!this.#checks.delete(part)) return;
    this.#notify();
  }
}

let shared: CheckStore | null = null;

export function formChecks(): CheckStore {
  shared ??= new CheckStore();
  return shared;
}

export function forgetFormChecks(): void {
  shared = null;
}
