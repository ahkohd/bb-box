import type { MacGrantState } from "../mac-vm-helper.ts";
import type { BackendStorage, DoctorCheck, GrantBlock } from "../types.ts";
import { PRODUCT } from "../../brand.ts";

export interface MacGrantReport {
  readonly machine: string;
  readonly macos: string | null;
  readonly blockedBy: GrantBlock | null;
  readonly at: number;
}

export interface MacGrantFailure {
  readonly machine: string;
  readonly reason: string;
  readonly at: number;
}

export const GRANT_REPORTS_KEY = "mac-grants";
export const GRANT_FAILURES_KEY = "mac-grant-failures";
export const GRANT_REPORTS_KEPT = 20;

const BLOCK_WORDS: Readonly<Record<GrantBlock, string>> = {
  "sip-on": "System Integrity Protection is on",
  "unknown-database": `TCC's database has columns ${PRODUCT} does not know`,
};

function reportFromJson(value: unknown): MacGrantReport | null {
  if (!value || typeof value !== "object") return null;
  const { machine, macos, blockedBy, at } = value as Partial<MacGrantReport>;
  if (typeof machine !== "string" || typeof at !== "number") return null;
  if (blockedBy !== null && blockedBy !== "sip-on" && blockedBy !== "unknown-database") return null;
  return { machine, macos: typeof macos === "string" ? macos : null, blockedBy, at };
}

function failureFromJson(value: unknown): MacGrantFailure | null {
  if (!value || typeof value !== "object") return null;
  const { machine, reason, at } = value as Partial<MacGrantFailure>;
  return typeof machine === "string" && typeof reason === "string" && typeof at === "number" ? { machine, reason, at } : null;
}

function savedList<T>(saved: unknown, fromJson: (value: unknown) => T | null): T[] {
  return (Array.isArray(saved) ? saved : []).map(fromJson).filter((item): item is T => item !== null);
}

function withoutMachine<T extends { readonly machine: string }>(items: readonly T[], machine: string): T[] {
  return items.filter((item) => item.machine !== machine);
}

function keptAfterLoad<T extends { readonly machine: string }>(loaded: readonly T[], replacedSince: ReadonlySet<string>, since: readonly T[]): T[] {
  return [...loaded.filter((item) => !replacedSince.has(item.machine)), ...since].slice(-GRANT_REPORTS_KEPT);
}

export class NamespaceGrantReports {
  readonly #storage: BackendStorage;
  readonly #logError: (operation: string, error: unknown) => void;
  #reports: MacGrantReport[] = [];
  #failures: MacGrantFailure[] = [];
  #loaded: Promise<void> | null = null;

  constructor(storage: BackendStorage, logError: (operation: string, error: unknown) => void) {
    this.#storage = storage;
    this.#logError = logError;
  }

  load(): Promise<void> {
    this.#loaded ??= Promise.all([this.#storage.get<unknown[]>(GRANT_REPORTS_KEY), this.#storage.get<unknown[]>(GRANT_FAILURES_KEY)])
      .then(([savedReports, savedFailures]) => {
        const measuredSince = new Set(this.#reports.map((report) => report.machine));
        const triedSince = new Set([...measuredSince, ...this.#failures.map((failure) => failure.machine)]);
        this.#reports = keptAfterLoad(savedList(savedReports, reportFromJson), measuredSince, this.#reports);
        this.#failures = keptAfterLoad(savedList(savedFailures, failureFromJson), triedSince, this.#failures);
      })
      .catch((error) => this.#logError("read whether Namespace's Macs could grant macOS permissions", error));
    return this.#loaded;
  }

  async remember(machine: string, state: MacGrantState, at: number): Promise<void> {
    await this.load();
    const report: MacGrantReport = { machine, macos: state.macos, blockedBy: state.blockedBy, at };
    this.#reports = [...withoutMachine(this.#reports, machine), report].slice(-GRANT_REPORTS_KEPT);
    this.#failures = withoutMachine(this.#failures, machine);
    await this.#save();
  }

  async rememberFailure(machine: string, reason: string, at: number): Promise<void> {
    await this.load();
    this.#failures = [...withoutMachine(this.#failures, machine), { machine, reason, at }].slice(-GRANT_REPORTS_KEPT);
    await this.#save();
  }

  async #save(): Promise<void> {
    await Promise.all([this.#storage.set(GRANT_REPORTS_KEY, this.#reports), this.#storage.set(GRANT_FAILURES_KEY, this.#failures)]).catch((error) =>
      this.#logError("keep whether Namespace's Macs could grant macOS permissions", error),
    );
  }

  async all(): Promise<readonly MacGrantReport[]> {
    await this.load();
    return this.#reports;
  }

  async failures(): Promise<readonly MacGrantFailure[]> {
    await this.load();
    return this.#failures;
  }
}

function macosWords(reports: readonly MacGrantReport[]): string {
  const versions = [...new Set(reports.map((report) => report.macos).filter((macos): macos is string => macos !== null))];
  return versions.length ? ` (macOS ${versions.join(", ")})` : "";
}

function lastMacsWords(count: number): string {
  return count === 1 ? "the last Mac" : `the last ${count} Macs`;
}

function agoWords(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`;
}

const GRANT_CHECK = { id: "namespace.grants", name: "macOS permissions on Namespace's Macs" } as const;

function failedWords(failures: readonly MacGrantFailure[], now: number): string {
  const latest = Math.max(...failures.map((failure) => failure.at));
  const reasons = [...new Set(failures.map((failure) => failure.reason))].join("; ");
  const macs = failures.length === 1 ? `Namespace's Mac ${failures[0]!.machine}` : `${failures.length} of Namespace's Macs`;
  return `${PRODUCT} could not measure whether box_grant works on ${macs}, most recently ${agoWords(latest, now)}: ${reasons}.`;
}

export function grantCheck(reports: readonly MacGrantReport[], failures: readonly MacGrantFailure[], now: number): DoctorCheck {
  const measured = measuredCheck(reports, now);
  if (!failures.length) return measured;
  const earlier = measured.status === "skipped" ? "" : ` Earlier measurements: ${measured.detail}`;
  return {
    ...GRANT_CHECK,
    status: "warn",
    detail: `${failedWords(failures, now)}${earlier}`,
    fix: [`${PRODUCT} measures each Mac again at each doctor and at each box's start. If it keeps failing, run \`sudo -n true\` in a box on that Mac: the Mac helper needs sudo with no password.`, measured.fix].filter(Boolean).join(" "),
  };
}

function measuredCheck(reports: readonly MacGrantReport[], now: number): DoctorCheck {
  const { id, name } = GRANT_CHECK;
  if (!reports.length) return { id, name, status: "skipped", detail: `Not measured yet: ${PRODUCT} measures each Namespace Mac a macos or macos-desktop box starts on.`, fix: null };
  const latest = Math.max(...reports.map((report) => report.at));
  const measured = `Measured on ${lastMacsWords(reports.length)} ${PRODUCT} started, most recently ${agoWords(latest, now)}.`;
  const blocked = reports.filter((report) => report.blockedBy !== null);
  if (!blocked.length) {
    return { id, name, status: "ok", detail: `box_grant works: System Integrity Protection is off and TCC's database is one ${PRODUCT} knows${macosWords(reports)}. ${measured}`, fix: null };
  }
  const reasons = [...new Set(blocked.flatMap((report) => (report.blockedBy ? [report.blockedBy] : [])))].map((block) => `${BLOCK_WORDS[block]}${macosWords(blocked.filter((report) => report.blockedBy === block))}`).join("; ");
  const works = reports.length - blocked.length;
  const where = works ? `box_grant works on ${works} of them and refuses on the others` : "box_grant refuses";
  return {
    id,
    name,
    status: "warn",
    detail: `${measured} ${where}, as ${reasons}.`,
    fix: `On a Mac that refuses, a person grants permissions in System Settings, in the desktop's viewer. Where TCC's database is new, a newer ${PRODUCT} may know it.`,
  };
}
