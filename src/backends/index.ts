// The backends built into bb-box, and the set that is active under the
// current settings. Each driver owns the settings under its own prefix and
// has an enable switch, so several backends can be active at once. A backend
// is rebuilt only when its own settings change, so a warm pool or an open
// connection survives changes to other settings.

import type { PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { proxmoxLxcDriver } from "./proxmox-lxc/index.ts";
import type { Backend, BackendDriver, BackendStorage, BoxKind } from "./types.ts";

export const DRIVERS: readonly BackendDriver<any>[] = [proxmoxLxcDriver];

/** Every backend setting, in driver order. Setting keys must be unique. */
export function backendSettings(drivers: readonly BackendDriver<any>[] = DRIVERS): Record<string, PluginSettingDescriptor> {
  const settings: Record<string, PluginSettingDescriptor> = {};
  for (const driver of drivers) {
    for (const [key, descriptor] of Object.entries(driver.settings)) {
      if (!key.startsWith(`${driver.type}-`)) throw new Error(`Setting ${key} of backend ${driver.type} must start with "${driver.type}-".`);
      if (key in settings) throw new Error(`Setting ${key} is defined twice.`);
      settings[key] = descriptor;
    }
  }
  return settings;
}

/** Keys under `prefix`, with the prefix hidden from the backend. */
export function scopedStorage(storage: BackendStorage, prefix: string): BackendStorage {
  return {
    get: (key) => storage.get(prefix + key),
    set: (key, value) => storage.set(prefix + key, value),
    delete: (key) => storage.delete(prefix + key),
    list: async (inner = "") => (await storage.list(prefix + inner)).map((key) => key.slice(prefix.length)),
  };
}

export interface BackendStatus {
  readonly type: string;
  readonly label: string;
  readonly nature: Backend["nature"];
  readonly state: "off" | "active" | "misconfigured";
  /** What to fix in settings, when misconfigured. */
  readonly problems: readonly string[];
}

export interface OfferedKind {
  readonly kind: BoxKind;
  readonly backend: Backend;
}

interface Entry {
  readonly driver: BackendDriver<any>;
  /** The settings the backend was built from, to tell when they change. */
  readonly signature: string;
  readonly backend: Backend;
}

export class Backends {
  readonly #drivers: readonly BackendDriver<any>[];
  readonly #storage: BackendStorage;
  readonly #logError: (operation: string, error: unknown) => void;
  readonly #entries = new Map<string, Entry>();
  #statuses: BackendStatus[] = [];

  constructor(options: {
    storage: BackendStorage;
    logError(operation: string, error: unknown): void;
    drivers?: readonly BackendDriver<any>[];
  }) {
    this.#drivers = options.drivers ?? DRIVERS;
    this.#storage = options.storage;
    this.#logError = options.logError;
  }

  /** Builds, keeps or disposes each backend to match `values`. */
  async configure(values: Readonly<Record<string, unknown>>): Promise<void> {
    const statuses: BackendStatus[] = [];
    for (const driver of this.#drivers) {
      const parsed = driver.parse(values);
      const current = this.#entries.get(driver.type);
      const base = { type: driver.type, label: driver.label, nature: driver.nature };
      if (!parsed.enabled || !parsed.ok) {
        if (current) await this.#dispose(current);
        statuses.push(
          parsed.enabled ? { ...base, state: "misconfigured", problems: parsed.problems } : { ...base, state: "off", problems: [] },
        );
        continue;
      }
      const signature = JSON.stringify(parsed.config);
      if (current?.signature !== signature) {
        if (current) await this.#dispose(current);
        const backend = driver.create(parsed.config, {
          storage: scopedStorage(this.#storage, `backend/${driver.type}/`),
          logError: this.#logError,
        });
        this.#entries.set(driver.type, { driver, signature, backend });
      }
      statuses.push({ ...base, state: "active", problems: [] });
    }
    this.#statuses = statuses;
  }

  async #dispose(entry: Entry): Promise<void> {
    this.#entries.delete(entry.driver.type);
    await entry.backend.dispose?.().catch((error) => this.#logError(`dispose ${entry.driver.type}`, error));
  }

  /** Every driver and whether it is off, active or needs its settings fixed. */
  statuses(): readonly BackendStatus[] {
    return this.#statuses;
  }

  active(): Backend[] {
    return [...this.#entries.values()].map((entry) => entry.backend);
  }

  get(id: string): Backend | null {
    return this.active().find((backend) => backend.id === id) ?? null;
  }

  /**
   * Every kind the active backends offer now. Kind IDs are meant to be
   * unique across backends; if two offer the same kind, it is listed once per
   * backend in driver order, and acquire uses the first with room.
   */
  kinds(): OfferedKind[] {
    const offered: OfferedKind[] = [];
    for (const backend of this.active()) {
      try {
        for (const kind of backend.kinds()) offered.push({ kind, backend });
      } catch (error) {
        this.#logError(`kinds ${backend.id}`, error);
      }
    }
    return offered;
  }

  async dispose(): Promise<void> {
    for (const entry of [...this.#entries.values()].reverse()) await this.#dispose(entry);
  }
}
