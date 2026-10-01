// bb-box's configuration at run time (029): the document and secrets in
// plugin storage, and the checked writes the settings page and the CLI make.
// Writes go one at a time: storage has no compare-and-set, so the revision
// check and the write must not interleave.

import { layeredStorage, scopedStorage, type Backends } from "../backends/index.ts";
import { kindInfo } from "../backends/kinds.ts";
import type { Arch, BackendDriver, BackendStorage, BoxSize, DoctorReport, FieldDescriptor, MachineNature, BoxForm, GuestOs } from "../backends/types.ts";
import type { BoxRecord } from "../core/boxes.ts";
import {
  GENERAL_DEFAULTS,
  SCHEMA,
  backendPart,
  blocking,
  checkDocument,
  emptyDocument,
  exported,
  generalConfig,
  kindDefaults,
  knownKinds,
  readDraft,
  upgradeDocument,
  withSecretChanges,
  withoutSecrets,
  type ConfigDocument,
  type GeneralConfig,
  type InUse,
  type Problem,
  type Secrets,
} from "../core/document.ts";
import { COPY_KEY, DOCUMENT_KEY, SECRETS_KEY, type MovedCopy } from "../core/move.ts";
import type { Preset } from "../core/sizes.ts";

const DOCTOR_PREFIX = "config/doctor/";
/** The longest a check of a draft may run its backend's doctor. */
export const TEST_TIMEOUT_MS = 30_000;

export type FieldView = FieldDescriptor & {
  readonly key: string;
  /** The backend type whose value the field takes while it and the rest of its set are empty, and that type's label. */
  readonly inherits?: { readonly from: string; readonly label: string; readonly set: readonly string[] };
};

export interface DriverView {
  readonly type: string;
  readonly label: string;
  readonly description: string;
  readonly nature: MachineNature;
  /** The kinds its backends can make. */
  readonly kinds: readonly string[];
  readonly fields: readonly FieldView[];
  readonly hostFields: readonly FieldView[];
  /** Paths in bb-box's repository: the guide first, then the scripts in the order it runs them. */
  readonly setup: { readonly guide: string; readonly scripts: readonly string[] };
}

export interface KindInfoView {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly gpu: boolean;
  readonly desktop: boolean;
  /** The OS, which the settings name the kind by, and the features it promises, for its badges. */
  readonly os: GuestOs;
  readonly arch: Arch;
  readonly features: readonly string[];
  /** Its boxes have Docker on every backend that offers it now, on none, or, when null, on some or while none offers it (041). */
  readonly docker: boolean | null;
  /** Driver types that can make it. */
  readonly drivers: readonly string[];
  /** Its spare boxes now (032): ready to claim, and being made. */
  readonly spares: { readonly ready: number; readonly making: number };
}

export interface DoctorRun {
  readonly report: DoctorReport;
  readonly at: number;
}

export interface BackendState {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  /** What its boxes are, as a badge; null for a driver bb-box no longer has. */
  readonly form: BoxForm | null;
  readonly state: "active" | "off" | "misconfigured";
  readonly problems: readonly Problem[];
  /** Boxes it holds, in any state but gone. */
  readonly boxes: number;
  /** The kinds it offers now: none while it is off or not valid. */
  readonly kinds: readonly string[];
  /** Its doctor's last run, kept across restarts. */
  readonly doctor: DoctorRun | null;
}

export interface ConfigState {
  /** Each secret as { set: true } or { set: false }. */
  readonly document: ConfigDocument;
  readonly revision: number;
  readonly defaults: {
    readonly general: typeof GENERAL_DEFAULTS;
    readonly kinds: Readonly<Record<string, { enabled: true; presets: Record<Preset, BoxSize>; default: Preset; largest: BoxSize }>>;
  };
  readonly kinds: readonly KindInfoView[];
  readonly drivers: readonly DriverView[];
  readonly backends: readonly BackendState[];
  /** Problems with the stored document. */
  readonly problems: readonly Problem[];
  /** The copy of BB's settings the move kept, while it is kept. */
  readonly migrated: { readonly at: number; readonly version: string } | null;
}

export interface CheckResult {
  readonly problems: readonly Problem[];
  /** The tested backend's doctor, when a test was asked for and its fields are valid. */
  readonly doctor: DoctorReport | null;
}

export type ApplyResult =
  /** `problems` are those saved anyway, in a backend that is off and has no boxes, for the page to show. */
  | { readonly ok: true; readonly state: ConfigState; readonly problems: readonly Problem[] }
  | { readonly ok: false; readonly reason: "revision"; readonly state: ConfigState }
  | { readonly ok: false; readonly reason: "problems"; readonly problems: readonly Problem[] };

export interface ConfigurationDeps {
  readonly kv: BackendStorage;
  readonly backends: Backends;
  readonly drivers: readonly BackendDriver<any>[];
  /** Every box record. */
  boxes(): Promise<readonly BoxRecord[]>;
  /** Each kind's spares now, ready and being made. */
  spareCounts?(): Promise<Readonly<Record<string, { readonly ready: number; readonly making: number }>>>;
  /** Tells open panels and pages that the configuration changed. */
  changed(): void;
  logError(operation: string, error: unknown): void;
  readonly now?: () => number;
  readonly testTimeoutMs?: number;
}

function fieldViews(fields: Readonly<Record<string, FieldDescriptor>> | undefined, inherits?: { readonly from: string; readonly label: string; readonly sets: readonly (readonly string[])[] }): FieldView[] {
  return Object.entries(fields ?? {}).map(([key, field]) => {
    const set = inherits?.sets.find((candidate) => candidate.includes(key));
    return set ? { key, ...field, inherits: { from: inherits!.from, label: inherits!.label, set } } : { key, ...field };
  });
}

/** A driver's fields for the settings page. Each it inherits names the type it takes values from, with that type's label. */
export function driverFields(driver: BackendDriver<any>, drivers: readonly BackendDriver<any>[]): FieldView[] {
  const inherits = driver.inherits && { ...driver.inherits, label: drivers.find((other) => other.type === driver.inherits!.from)?.label ?? driver.inherits.from };
  return fieldViews(driver.fields, inherits);
}

function failedReport(detail: string): DoctorReport {
  return { ok: false, summary: "The checks did not finish.", checks: [{ id: "doctor", name: "Checks", status: "fail", detail, fix: null }], notes: [] };
}

/** Runs a doctor for at most `ms`, aborting it then. A doctor that ignores the abort is not waited for. */
export async function boundedDoctor(run: (signal: AbortSignal) => Promise<DoctorReport>, ms: number, outer?: AbortSignal): Promise<DoctorReport> {
  const timeout = AbortSignal.timeout(ms);
  const signal = outer ? AbortSignal.any([outer, timeout]) : timeout;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<DoctorReport>((resolve) => {
    timer = setTimeout(() => resolve(failedReport(`The checks took longer than ${Math.round(ms / 1000)} s.`)), ms + 1_000);
  });
  try {
    return await Promise.race([
      run(signal).catch((error) =>
        failedReport(timeout.aborted ? `The checks took longer than ${Math.round(ms / 1000)} s.` : error instanceof Error ? error.message : String(error)),
      ),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class Configuration {
  readonly #deps: ConfigurationDeps;
  #document: ConfigDocument;
  #secrets: Secrets;
  readonly #doctor = new Map<string, DoctorRun>();
  /** Writes and the reconfiguring after them, one at a time. */
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(deps: ConfigurationDeps, document: ConfigDocument, secrets: Secrets) {
    this.#deps = deps;
    this.#document = document;
    this.#secrets = secrets;
  }

  /** The stored document and secrets, and each backend's last doctor run. */
  static async load(deps: ConfigurationDeps): Promise<Configuration> {
    const stored = (await deps.kv.get<ConfigDocument>(DOCUMENT_KEY)) ?? emptyDocument();
    // Earlier kind IDs move to their kinds once (041), as a write would.
    const upgraded = upgradeDocument(stored);
    const document = upgraded ? { ...upgraded, revision: stored.revision + 1 } : stored;
    if (upgraded) await deps.kv.set(DOCUMENT_KEY, document).catch((error) => deps.logError("move earlier kind IDs in the configuration", error));
    const secrets = (await deps.kv.get<Secrets>(SECRETS_KEY)) ?? {};
    const configuration = new Configuration(deps, document, secrets);
    for (const key of await deps.kv.list(DOCTOR_PREFIX)) {
      const run = await deps.kv.get<DoctorRun>(key);
      if (run) configuration.#doctor.set(key.slice(DOCTOR_PREFIX.length), run);
    }
    return configuration;
  }

  get document(): ConfigDocument {
    return this.#document;
  }

  get secrets(): Secrets {
    return this.#secrets;
  }

  general(): GeneralConfig {
    return generalConfig(this.#document);
  }

  /** Builds the backends from the stored document. */
  configure(): Promise<void> {
    return this.#deps.backends.configure(this.#document, this.#secrets);
  }

  async inUse(): Promise<InUse> {
    const backends = new Map<string, number>();
    const hosts = new Map<string, Map<string, number>>();
    for (const box of await this.#deps.boxes()) {
      if (box.state === "gone") continue;
      backends.set(box.backend, (backends.get(box.backend) ?? 0) + 1);
      // Only the hosts the configuration lists count: a Proxmox node, say, is no host of its backend's.
      const host = box.guest?.host;
      const listed = this.#document.backends.find((backend) => backend.id === box.backend)?.hosts?.some((each) => each.name === host);
      if (!host || !listed) continue;
      const counts = hosts.get(box.backend) ?? new Map<string, number>();
      counts.set(host, (counts.get(host) ?? 0) + 1);
      hosts.set(box.backend, counts);
    }
    return { backends, hosts };
  }

  /** Problems with the stored document. */
  async problems(): Promise<Problem[]> {
    return checkDocument(this.#document, this.#secrets, this.#deps.drivers, await this.inUse());
  }

  async recordDoctor(id: string, report: DoctorReport): Promise<void> {
    const run = { report, at: (this.#deps.now ?? Date.now)() };
    this.#doctor.set(id, run);
    await this.#deps.kv.set(DOCTOR_PREFIX + id, run).catch((error) => this.#deps.logError("doctor report", error));
  }

  async migrated(): Promise<MovedCopy | null> {
    return (await this.#deps.kv.get<MovedCopy>(COPY_KEY)) ?? null;
  }

  async removeMigrated(): Promise<boolean> {
    const had = (await this.migrated()) !== null;
    await this.#deps.kv.delete(COPY_KEY);
    return had;
  }

  /** The document as it leaves bb-box: no secret values. */
  exported(): ConfigDocument {
    return exported(this.#document, this.#secrets, this.#deps.drivers);
  }

  async state(): Promise<ConfigState> {
    // A write's reconfiguring finishes first, so the backends' states match the document.
    await this.#queue.catch(() => {});
    return this.#snapshot();
  }

  async #snapshot(): Promise<ConfigState> {
    const { drivers } = this.#deps;
    const inUse = await this.inUse();
    const statuses = this.#deps.backends.statuses();
    const copy = await this.migrated();
    const spares = (await this.#deps.spareCounts?.()) ?? {};
    const offered = this.#deps.backends.kinds();
    const docker = (id: string): boolean | null => {
      const has = new Set(offered.filter((each) => each.kind.id === id).map((each) => each.kind.capabilities.features.includes("docker")));
      return has.size === 1 ? has.has(true) : null;
    };
    return {
      document: this.exported(),
      revision: this.#document.revision,
      defaults: { general: GENERAL_DEFAULTS, kinds: kindDefaults(drivers) },
      kinds: knownKinds(drivers).map((id) => ({
        id,
        ...kindInfo(id),
        docker: docker(id),
        drivers: drivers.filter((driver) => driver.kinds.includes(id)).map((driver) => driver.type),
        spares: spares[id] ?? { ready: 0, making: 0 },
      })),
      drivers: drivers.map((driver) => ({
        type: driver.type,
        label: driver.label,
        description: driver.description,
        nature: driver.nature,
        kinds: driver.kinds,
        fields: driverFields(driver, drivers),
        hostFields: fieldViews(driver.hostFields),
        setup: driver.setup,
      })),
      backends: this.#document.backends.map((backend) => {
        const status = statuses.find((candidate) => candidate.id === backend.id);
        return {
          id: backend.id,
          type: backend.type,
          label: status?.label ?? backend.label ?? backend.type,
          form: drivers.find((driver) => driver.type === backend.type)?.form ?? null,
          state: status?.state ?? "misconfigured",
          problems: status?.fieldProblems ?? [],
          boxes: inUse.backends.get(backend.id) ?? 0,
          kinds: status?.kinds ?? [],
          doctor: this.#doctor.get(backend.id) ?? null,
        };
      }),
      problems: checkDocument(this.#document, this.#secrets, drivers, inUse),
      migrated: copy ? { at: copy.at, version: copy.version } : null,
    };
  }

  /** The IDs of a draft's backends that are on. */
  enabledIn(input: unknown): string[] {
    return readDraft(input, this.#deps.drivers).document.backends.filter((backend) => backend.enabled).map((backend) => backend.id);
  }

  /**
   * Problems with a draft, saving nothing. With `test`, a backend's ID, also
   * runs that backend's doctor against the draft (029).
   */
  async check(input: unknown, test?: string, signal?: AbortSignal): Promise<CheckResult> {
    const { drivers } = this.#deps;
    const draft = readDraft(input, drivers);
    const secrets = withSecretChanges(this.#secrets, draft.secrets, draft.document);
    const problems = [...draft.problems, ...checkDocument(draft.document, secrets, drivers, await this.inUse())];
    if (test === undefined) return { problems, doctor: null };
    const backend = draft.document.backends.find((candidate) => candidate.id === test);
    if (!backend) return { problems: [...problems, { path: `backends.${test}`, message: `There is no backend ${test} in the configuration to check.` }], doctor: null };
    // A backend of a type this version lacks cannot be built; checkDocument's problem says why.
    const driver = drivers.find((candidate) => candidate.type === backend.type);
    if (!driver) return { problems, doctor: null };
    const parsed = driver.parse(backendPart(backend, driver, secrets, draft.document.backends));
    if (!parsed.ok) return { problems, doctor: null };
    const doctor = await this.#test(backend.id, driver, parsed.config, signal);
    // The report is the backend's own when the draft's fields are those it was built from.
    const stored = this.#document.backends.find((candidate) => candidate.id === backend.id);
    const live = stored && driver.parse(backendPart(stored, driver, this.#secrets, this.#document.backends));
    if (live?.ok && JSON.stringify(live.config) === JSON.stringify(parsed.config)) await this.recordDoctor(backend.id, doctor);
    return { problems, doctor };
  }

  /**
   * A backend built from a draft, only for its doctor: within the time
   * limit, with no acquire or upkeep, and disposed after. Its storage is a
   * layer over the backend's own, so the SSH key it makes on first use is
   * the backend's, and nothing else it writes stays.
   */
  async #test(id: string, driver: BackendDriver<any>, config: unknown, signal?: AbortSignal): Promise<DoctorReport> {
    const storage = layeredStorage(scopedStorage(this.#deps.kv, `backend/${id}/`));
    let backend: ReturnType<BackendDriver<any>["create"]> | null = null;
    try {
      backend = driver.create(config, { ...this.#deps.backends.context(id, storage), warm: () => 0 });
      const built = backend;
      return await boundedDoctor((bounded) => built.doctor(bounded), this.#deps.testTimeoutMs ?? TEST_TIMEOUT_MS, signal);
    } catch (error) {
      return failedReport(error instanceof Error ? error.message : String(error));
    } finally {
      await backend?.dispose?.().catch((error) => this.#deps.logError(`dispose the check of ${id}`, error));
    }
  }

  /**
   * Saves a draft as the whole configuration, if `revision` is the current
   * one or null, and its problems allow it. Then rebuilds what changed,
   * answers with the state after it, and tells open pages. The draft's own
   * revision is ignored.
   */
  apply(input: unknown, revision: number | null): Promise<ApplyResult> {
    const write = this.#queue.catch(() => {}).then(async (): Promise<ApplyResult> => {
      if (revision !== null && revision !== this.#document.revision) return { ok: false, reason: "revision", state: await this.#snapshot() };
      const { drivers } = this.#deps;
      const draft = readDraft(input, drivers);
      const secrets = withSecretChanges(this.#secrets, draft.secrets, draft.document);
      const inUse = await this.inUse();
      const all = [...draft.problems, ...checkDocument(draft.document, secrets, drivers, inUse)];
      const problems = blocking(all, draft.document, inUse, drivers);
      if (problems.length) return { ok: false, reason: "problems", problems };
      const document: ConfigDocument = { ...withoutSecrets(draft.document, drivers), schema: SCHEMA, revision: this.#document.revision + 1 };
      await this.#deps.kv.set(SECRETS_KEY, secrets);
      await this.#deps.kv.set(DOCUMENT_KEY, document);
      this.#document = document;
      this.#secrets = secrets;
      await this.configure().catch((error) => this.#deps.logError("configure", error));
      this.#deps.changed();
      return { ok: true, state: await this.#snapshot(), problems: all };
    });
    this.#queue = write;
    return write;
  }
}
