// The backends built into bb-box, and the set built from the configuration
// document (029), in its order. A backend is built when its fields are
// valid, whether it is on or off: off stops new boxes only, so the boxes it
// has keep working. A backend is rebuilt only when its own fields or the
// install ID change. Switches and warm counts reach it live, so a warm pool
// or an open connection survives them and changes to other backends.

import { dockerDriver } from "./docker/index.ts";
import { microsandboxDriver } from "./microsandbox/index.ts";
import { proxmoxLxcDriver } from "./proxmox-lxc/index.ts";
import { proxmoxQemuDriver } from "./proxmox-qemu/index.ts";
import { sshPoolDriver } from "./ssh-pool/index.ts";
import { tartDriver } from "./tart/index.ts";
import { GENERAL_DEFAULTS, backendPart, kindOn, sizeChanges, type BackendConfig, type ConfigDocument, type Problem, type Secrets } from "../core/document.ts";
import { defaultSize, kindSizes, presetSizes } from "../core/sizes.ts";
import type { Backend, BackendContext, BackendDriver, BackendStorage, BoxKind, DoctorCheck, BoxForm, MachineAccess, WarmShortfall } from "./types.ts";
import type { ImageFacts } from "./images.ts";
import { WarmShortfalls } from "./warm.ts";
import { GENERAL_SECRETS } from "../core/box-files.ts";
import { Tailnet, type TailnetFetch } from "../core/tailnet.ts";
import { tailnetUse } from "../core/tailnet-settings.ts";

export const DRIVERS: readonly BackendDriver<any>[] = [proxmoxLxcDriver, proxmoxQemuDriver, sshPoolDriver, tartDriver, dockerDriver, microsandboxDriver];

/** What a backend's boxes are, from its ID, which starts with its driver's type (029). Null for a driver bb-box no longer has. */
export function boxForm(backendId: string, drivers: readonly BackendDriver<any>[] = DRIVERS): BoxForm | null {
  const type = backendId.split(":")[0];
  return drivers.find((driver) => driver.type === type)?.form ?? null;
}

/** The driver's label for a backend ID, as the settings page names it ("Proxmox LXC"); the ID itself for a driver bb-box no longer has. */
export function driverLabel(backendId: string, drivers: readonly BackendDriver<any>[] = DRIVERS): string {
  const type = backendId.split(":")[0]!;
  return drivers.find((driver) => driver.type === type)?.label ?? backendId;
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

/**
 * A layer over a backend's storage for a backend built only to be checked.
 * Reads see the storage. A write of a key the storage does not have yet,
 * such as the SSH key a backend makes on first use, goes through, so the key
 * the check shows is the one the backend uses. Every other write, and every
 * delete, stays in the layer and goes with it, so the live backend's records
 * are never touched.
 */
export function layeredStorage(storage: BackendStorage): BackendStorage {
  const layer = new Map<string, unknown>();
  const deleted = new Set<string>();
  return {
    async get<T>(key: string) {
      if (deleted.has(key)) return undefined;
      if (layer.has(key)) return structuredClone(layer.get(key)) as T;
      return storage.get<T>(key);
    },
    async set(key, value) {
      if (!deleted.has(key) && !layer.has(key) && (await storage.get(key)) === undefined) {
        await storage.set(key, value);
        return;
      }
      deleted.delete(key);
      layer.set(key, structuredClone(value));
    },
    async delete(key) {
      layer.delete(key);
      deleted.add(key);
    },
    async list(prefix = "") {
      const keys = new Set([...(await storage.list(prefix)), ...[...layer.keys()].filter((key) => key.startsWith(prefix))]);
      return [...keys].filter((key) => !deleted.has(key)).sort();
    },
  };
}

export interface BackendStatus {
  readonly id: string;
  readonly type: string;
  /** The backend's display name. */
  readonly label: string;
  readonly nature: Backend["nature"];
  /** Off: no new boxes. Misconfigured: on, or holding boxes, with fields that are not valid, so it is not built. */
  readonly state: "off" | "active" | "misconfigured";
  /** What to fix, in words, when its fields are not valid. */
  readonly problems: readonly string[];
  /** The same, each at its field's path. */
  readonly fieldProblems: readonly Problem[];
  /** The kinds it offers now: none while it or they are off. */
  readonly kinds: readonly string[];
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
 * Warnings for backends whose boxes would take the same guest IDs or
 * addresses in one scope, such as Proxmox QEMU and Proxmox LXC on one
 * cluster and bridge (#194), or the same machine, such as a Mac that is both
 * a Tart host and lent whole by the SSH host pool (047). None when nothing
 * overlaps.
 */
export function overlapChecks(backends: readonly Pick<Backend, "id" | "label" | "footprint">[]): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const marks = backends.flatMap((backend) => (backend.footprint ? [{ backend, footprint: backend.footprint() }] : []));
  for (const [i, a] of marks.entries()) {
    for (const b of marks.slice(i + 1)) {
      const problems: string[] = [];
      const ids = [a.footprint.ids, b.footprint.ids];
      if (ids[0] && ids[1] && ids[0].scope === ids[1].scope && ids[0].first <= ids[1].last && ids[1].first <= ids[0].last) {
        const [from, to] = [Math.max(ids[0].first, ids[1].first), Math.min(ids[0].last, ids[1].last)];
        problems.push(`both use ${from === to ? `ID ${from}` : `IDs ${from} to ${to}`}`);
      }
      const addresses = [a.footprint.addresses, b.footprint.addresses];
      if (addresses[0] && addresses[1] && addresses[0].scope === addresses[1].scope) {
        const theirs = new Set(addresses[1].list);
        const shared = addresses[0].list.filter((address) => theirs.has(address));
        if (shared.length) problems.push(`both give boxes ${shared.length === 1 ? `address ${shared[0]}` : `${shared.length} addresses, from ${shared[0]} to ${shared.at(-1)}`}`);
      }
      const fixes = problems.length ? ["Give them ranges that do not overlap, in their settings."] : [];
      const notes: string[] = [];
      const machines = [a.footprint.machines, b.footprint.machines];
      if (machines[0] && machines[1]) {
        const theirs = new Set(machines[1]);
        const shared = [...new Set(machines[0].filter((machine) => theirs.has(machine)))];
        if (shared.length) {
          problems.push(`both use the ${shared.length === 1 ? "machine" : "machines"} at ${shared.join(", ")}`);
          fixes.push(`List ${shared.length === 1 ? "the machine" : "each machine"} in one of them only.`);
          notes.push(...[a.footprint.machinesNote, b.footprint.machinesNote].filter((note) => note !== undefined));
        }
      }
      if (!problems.length) continue;
      checks.push({
        id: `overlap.${a.backend.id}.${b.backend.id}`,
        name: `${a.backend.label} and ${b.backend.label}`,
        status: "warn",
        detail: [`They ${problems.join(", and ")}, so a box of one could take what a box of the other has.`, ...notes].join(" "),
        fix: fixes.join(" "),
      });
    }
  }
  return checks;
}

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
  readonly id: string;
  readonly driver: BackendDriver<any>;
  /** The fields the backend was built from, to tell when they change. */
  readonly signature: string;
  readonly backend: Backend;
}

export class Backends {
  readonly #drivers: readonly BackendDriver<any>[];
  readonly #storage: BackendStorage;
  readonly #logError: (operation: string, error: unknown) => void;
  readonly #log: (message: string) => void;
  readonly #changed: () => void;
  readonly #kindsChanged: () => void;
  readonly #entries = new Map<string, Entry>();
  /** Each backend's warm pools that are short for want of room, by ID, kept while it is built again. */
  readonly #short = new Map<string, WarmShortfalls>();
  #installId: string;
  #document: ConfigDocument | null = null;
  #secrets: Secrets = {};
  #statuses: BackendStatus[] = [];
  readonly #machines: MachineAccess | undefined;
  readonly #images: ImageFacts | undefined;
  readonly #tailnetFetch: TailnetFetch | undefined;
  #tailnetClient: { readonly made: string; readonly tailnet: Tailnet } | null = null;

  constructor(options: {
    storage: BackendStorage;
    /** This install's ID (018), which every backend records on its guests. */
    installId: string;
    logError(operation: string, error: unknown): void;
    /** Logs what the operator may want to know, such as why a warm pool is short. */
    log?(message: string): void;
    /** Tells open pages that what they show changed, such as a pool's shortfall. */
    changed?(): void;
    /** Says a backend changed a kind's capabilities by itself, so boxes of the kind take them (BackendContext.kindsChanged). */
    kindsChanged?(): void;
    drivers?: readonly BackendDriver<any>[];
    /** BB machines backends reach through bb-box (042). */
    machines?: MachineAccess;
    /** What the doctor judges images by (049). */
    images?: ImageFacts;
    tailnetFetch?: TailnetFetch;
  }) {
    this.#tailnetFetch = options.tailnetFetch;
    this.#machines = options.machines;
    this.#images = options.images;
    this.#drivers = options.drivers ?? DRIVERS;
    this.#storage = options.storage;
    this.#installId = options.installId;
    this.#logError = options.logError;
    this.#log = options.log ?? (() => {});
    this.#changed = options.changed ?? (() => {});
    this.#kindsChanged = options.kindsChanged ?? (() => {});
  }

  get installId(): string {
    return this.#installId;
  }

  get drivers(): readonly BackendDriver<any>[] {
    return this.#drivers;
  }

  /** Rebuilds every backend with another install ID, for an install that takes back its old one. */
  async useInstallId(id: string): Promise<void> {
    this.#installId = id;
    if (this.#document) await this.configure(this.#document, this.#secrets);
  }

  tailnet(): Tailnet | null {
    const use = tailnetUse(this.#document?.general.tailnet, this.#secrets[GENERAL_SECRETS] ?? {});
    if (!use) return null;
    const made = JSON.stringify([use.credentials.clientId, use.credentials.clientSecret, use.tags]);
    if (this.#tailnetClient?.made !== made) {
      this.#tailnetClient = { made, tailnet: new Tailnet({ credentials: use.credentials, tags: use.tags, ...(this.#tailnetFetch ? { fetch: this.#tailnetFetch } : {}) }) };
    }
    return this.#tailnetClient.tailnet;
  }

  /** The context a backend of the configuration gets. Switches and warm counts are read live. */
  context(id: string, storage: BackendStorage = scopedStorage(this.#storage, `backend/${id}/`)): BackendContext {
    return {
      id,
      storage,
      installId: this.#installId,
      logError: this.#logError,
      log: this.#log,
      ...(this.#machines ? { machines: this.#machines } : {}),
      ...(this.#images ? { images: this.#images } : {}),
      warm: (kind) => {
        const document = this.#document;
        const backend = document?.backends.find((candidate) => candidate.id === id);
        if (!document || !backend?.enabled || !kindOn(document, kind)) return 0;
        // Where a stopped box keeps its session, a spare waits stopped: a warm box that is a BB machine already, so it takes a warm one's place (#539).
        const spares = this.get(id)?.keepsSession?.(kind) ? (document.kinds[kind]?.spares ?? 0) : 0;
        return Math.max(0, (backend.warm?.[kind] ?? 0) - spares);
      },
      warmShortfalls: (short) => this.#shortfalls(id).set(short),
      enrols: () => this.#document?.general.enrol ?? GENERAL_DEFAULTS.enrol,
      tailnet: () => this.tailnet(),
      kindsChanged: () => this.#kindsChanged(),
      hostOn: (name) => this.#document?.backends.find((candidate) => candidate.id === id)?.hosts?.find((host) => host.name === name)?.enabled ?? false,
      kind: (kind) => {
        const document = this.#document;
        const backend = document?.backends.find((candidate) => candidate.id === id);
        const sizes = kindSizes(kind, document ? sizeChanges(document.kinds) : {});
        return { enabled: !!document && !!backend?.enabled && kindOn(document, kind), defaultSize: defaultSize(sizes), presets: presetSizes(sizes) };
      },
    };
  }

  /** Builds, keeps or disposes each backend to match the document. */
  async configure(document: ConfigDocument, secrets: Secrets): Promise<void> {
    this.#document = document;
    this.#secrets = secrets;
    const statuses: BackendStatus[] = [];
    const listed = new Set(document.backends.map((backend) => backend.id));
    for (const entry of [...this.#entries.values()]) if (!listed.has(entry.id)) await this.#dispose(entry);
    for (const config of document.backends) {
      const driver = this.#drivers.find((candidate) => candidate.type === config.type);
      const base = { id: config.id, type: config.type, label: config.label ?? driver?.label ?? config.type, nature: driver?.nature ?? ("virtual" as const) };
      const current = this.#entries.get(config.id);
      if (!driver) {
        if (current) await this.#dispose(current);
        const problem = { path: `backends.${config.id}`, message: `This bb-box has no ${config.type} backend.` };
        statuses.push({ ...base, state: "misconfigured", problems: [problem.message], fieldProblems: [problem], kinds: [] });
        continue;
      }
      const parsed = driver.parse(backendPart(config, driver, secrets, document.backends));
      if (!parsed.ok) {
        if (current) await this.#dispose(current);
        const fieldProblems = parsed.problems.map((problem) => ({ path: `backends.${config.id}${problem.path ? `.${problem.path}` : ""}`, message: problem.message }));
        statuses.push({
          ...base,
          state: config.enabled ? "misconfigured" : "off",
          problems: parsed.problems.map((problem) => problem.message),
          fieldProblems,
          kinds: [],
        });
        continue;
      }
      const signature = JSON.stringify([this.#installId, parsed.config]);
      if (current?.signature !== signature) {
        if (current) await this.#dispose(current);
        const backend = driver.create(parsed.config, this.context(config.id));
        this.#entries.set(config.id, { id: config.id, driver, signature, backend });
      }
      statuses.push({ ...base, state: config.enabled ? "active" : "off", problems: [], fieldProblems: [], kinds: [] });
    }
    // The registry tries backends in the document's order.
    const order = [...listed];
    const sorted = [...this.#entries.values()].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    this.#entries.clear();
    for (const entry of sorted) this.#entries.set(entry.id, entry);
    this.#statuses = statuses;
  }

  #shortfalls(id: string): WarmShortfalls {
    let short = this.#short.get(id);
    if (!short) {
      short = new WarmShortfalls(id, this.#log, this.#changed);
      this.#short.set(id, short);
    }
    return short;
  }

  /** The backend's warm pools that its last upkeep left short for want of room (#356), while it is built. */
  warmShort(id: string): readonly WarmShortfall[] {
    return this.#entries.has(id) ? (this.#short.get(id)?.list() ?? []) : [];
  }

  async #dispose(entry: Entry): Promise<void> {
    this.#entries.delete(entry.id);
    await entry.backend.dispose?.().catch((error) => this.#logError(`dispose ${entry.id}`, error));
  }

  /**
   * Each backend of the configuration, then each driver without one as off,
   * so a new install lists every backend bb-box has.
   */
  statuses(): readonly BackendStatus[] {
    const offered = this.kinds();
    const listed = this.#statuses.map((status) => ({
      ...status,
      kinds: [...new Set(offered.filter((offer) => offer.backend.id === status.id).map((offer) => offer.kind.id))],
    }));
    const missing = this.#drivers
      .filter((driver) => !listed.some((status) => status.type === driver.type))
      .map((driver) => ({
        id: driver.type,
        type: driver.type,
        label: driver.label,
        nature: driver.nature,
        state: "off" as const,
        problems: [],
        fieldProblems: [],
        kinds: [],
      }));
    return [...listed, ...missing];
  }

  /** The driver's label for a backend ID, as settings names it, for a provider's name (044). */
  driverLabel(id: string): string {
    return driverLabel(id, this.#drivers);
  }

  /** Every built backend, on or off: their boxes work, and the sweep looks after them. */
  active(): Backend[] {
    return [...this.#entries.values()].map((entry) => entry.backend);
  }

  /** Built backends that are on, for the doctor. */
  on(): Backend[] {
    return [...this.#entries.values()].filter((entry) => this.#config(entry.id)?.enabled).map((entry) => entry.backend);
  }

  get(id: string): Backend | null {
    return this.#entries.get(id)?.backend ?? null;
  }

  #config(id: string): BackendConfig | undefined {
    return this.#document?.backends.find((backend) => backend.id === id);
  }

  /**
   * Every offer new boxes can come from, in the document's order: a kind
   * that is on, from a backend that is on. Several backends may offer the
   * same kind; acquire uses the first with room, and `offerChecks` warns
   * when their offers disagree.
   */
  kinds(): OfferedKind[] {
    const document = this.#document;
    if (!document) return [];
    const offered: OfferedKind[] = [];
    for (const entry of this.#entries.values()) {
      if (!this.#config(entry.id)?.enabled) continue;
      try {
        for (const kind of entry.backend.kinds()) if (kindOn(document, kind.id)) offered.push({ kind, backend: entry.backend });
      } catch (error) {
        this.#logError(`kinds ${entry.id}`, error);
      }
    }
    return offered;
  }

  async dispose(): Promise<void> {
    for (const entry of [...this.#entries.values()].reverse()) await this.#dispose(entry);
  }
}
