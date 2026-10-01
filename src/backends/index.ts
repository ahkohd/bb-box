// The backends built into bb-box, and the set that is active under the
// current settings. Each driver owns the settings under its own prefix and
// has an enable switch, so several backends can be active at once. A backend
// is rebuilt only when its own settings or the install ID change, so a warm
// pool or an open connection survives changes to other settings.

import type { PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { proxmoxLxcDriver } from "./proxmox-lxc/index.ts";
import { sshPoolDriver } from "./ssh-pool/index.ts";
import { tartDriver } from "./tart/index.ts";
import type { Backend, BackendDriver, BackendStorage, BoxKind, DoctorCheck } from "./types.ts";

export const DRIVERS: readonly BackendDriver<any>[] = [proxmoxLxcDriver, sshPoolDriver, tartDriver];

/** Sizes the Proxmox LXC settings gave boxes before 028, read once into the box-sizes setting. */
export { earlierLxcSizes } from "./proxmox-lxc/config.ts";

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

/** What offers of one kind must agree on, in words for the doctor. */
const PROMISES: readonly [string, (kind: BoxKind) => unknown][] = [
  ["OS", (kind) => kind.capabilities.os],
  ["architecture", (kind) => kind.capabilities.arch],
  ["GPU", (kind) => kind.capabilities.gpu],
  ["computer-use driver", (kind) => kind.capabilities.computerUse?.driver ?? "none"],
  ["enrolment", (kind) => kind.capabilities.enrol],
  ["having a desktop", (kind) => kind.capabilities.displays.length > 0],
  ["required features", (kind) => [...kind.requires].sort().join(", ") || "none"],
];

/**
 * Checks that the offers of each kind keep the kind's promise: every offer
 * has the features the kind requires, can reach its computer-use driver, and
 * offers from several backends agree on what an agent relies on. Offers may
 * differ in size, transports and extra features. A problem is a warning,
 * since each box still works.
 */
export function offerChecks(offered: readonly OfferedKind[]): DoctorCheck[] {
  const byKind = new Map<string, OfferedKind[]>();
  for (const offer of offered) byKind.set(offer.kind.id, [...(byKind.get(offer.kind.id) ?? []), offer]);
  const checks: DoctorCheck[] = [];
  for (const [id, offers] of byKind) {
    const problems: string[] = [];
    for (const { kind, backend } of offers) {
      const missing = kind.requires.filter((feature) => !kind.capabilities.features.includes(feature));
      if (missing.length) problems.push(`${backend.label} offers ${id} without ${missing.join(", ")}, which the kind requires.`);
      if (kind.capabilities.computerUse && !kind.capabilities.command) {
        problems.push(`${backend.label} offers ${id} with a computer-use driver but no command transport, so the computer tools cannot reach the driver.`);
      }
    }
    const [first, ...rest] = offers;
    for (const other of rest) {
      for (const [what, value] of PROMISES) {
        const expected = String(value(first!.kind));
        const actual = String(value(other.kind));
        if (expected !== actual) problems.push(`${first!.backend.label} and ${other.backend.label} disagree on ${what} for ${id}: ${expected} and ${actual}.`);
      }
    }
    if (offers.length < 2 && !problems.length) continue;
    checks.push({
      id: `offers.${id}`,
      name: `Offers of ${id}`,
      status: problems.length ? "warn" : "ok",
      detail: problems.length ? problems.join(" ") : `${offers.map((offer) => offer.backend.label).join(" and ")} offer it and agree.`,
      fix: problems.length ? `Make the offers of ${id} match, or switch off all but one of them.` : null,
    });
  }
  return checks;
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
  #installId: string;
  #values: Readonly<Record<string, unknown>> = {};
  #statuses: BackendStatus[] = [];

  constructor(options: {
    storage: BackendStorage;
    /** This install's ID (018), which every backend records on its guests. */
    installId: string;
    logError(operation: string, error: unknown): void;
    drivers?: readonly BackendDriver<any>[];
  }) {
    this.#drivers = options.drivers ?? DRIVERS;
    this.#storage = options.storage;
    this.#installId = options.installId;
    this.#logError = options.logError;
  }

  get installId(): string {
    return this.#installId;
  }

  /** Rebuilds every backend with another install ID, for an install that takes back its old one. */
  async useInstallId(id: string): Promise<void> {
    this.#installId = id;
    await this.configure(this.#values);
  }

  /** Builds, keeps or disposes each backend to match `values`. */
  async configure(values: Readonly<Record<string, unknown>>): Promise<void> {
    this.#values = values;
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
      const signature = JSON.stringify([this.#installId, parsed.config]);
      if (current?.signature !== signature) {
        if (current) await this.#dispose(current);
        const backend = driver.create(parsed.config, {
          storage: scopedStorage(this.#storage, `backend/${driver.type}/`),
          installId: this.#installId,
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
   * Every offer of every kind the active backends have now, in driver order.
   * Several backends may offer the same kind; acquire uses the first with
   * room, and `offerChecks` warns when their offers disagree.
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
