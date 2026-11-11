import type { MacGrantState } from "../mac-vm-helper.ts";
import type { BackendStorage, DoctorCheck, GrantBlock } from "../types.ts";
import { PRODUCT } from "../../brand.ts";

export interface MacGrantReport {
  readonly machine: string;
  readonly macos: string | null;
  readonly blockedBy: GrantBlock | null;
  readonly at: number;
}

export const GRANT_REPORTS_KEY = "mac-grants";
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

export class NamespaceGrantReports {
  readonly #storage: BackendStorage;
  readonly #logError: (operation: string, error: unknown) => void;
  #reports: MacGrantReport[] = [];
  #loaded: Promise<void> | null = null;

  constructor(storage: BackendStorage, logError: (operation: string, error: unknown) => void) {
    this.#storage = storage;
    this.#logError = logError;
  }

  load(): Promise<void> {
    this.#loaded ??= this.#storage
      .get<unknown[]>(GRANT_REPORTS_KEY)
      .then((saved) => {
        const loaded = (Array.isArray(saved) ? saved : []).map(reportFromJson).filter((report): report is MacGrantReport => report !== null);
        const measuredSince = new Set(this.#reports.map((report) => report.machine));
        this.#reports = [...loaded.filter((report) => !measuredSince.has(report.machine)), ...this.#reports].slice(-GRANT_REPORTS_KEPT);
      })
      .catch((error) => this.#logError("read whether Namespace's Macs could grant macOS permissions", error));
    return this.#loaded;
  }

  async remember(machine: string, state: MacGrantState, at: number): Promise<void> {
    await this.load();
    const report: MacGrantReport = { machine, macos: state.macos, blockedBy: state.blockedBy, at };
    this.#reports = [...this.#reports.filter((known) => known.machine !== machine), report].slice(-GRANT_REPORTS_KEPT);
    await this.#storage.set(GRANT_REPORTS_KEY, this.#reports).catch((error) => this.#logError("keep whether Namespace's Macs could grant macOS permissions", error));
  }

  async all(): Promise<readonly MacGrantReport[]> {
    await this.load();
    return this.#reports;
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

export function grantCheck(reports: readonly MacGrantReport[], now: number): DoctorCheck {
  const id = "namespace.grants";
  const name = "macOS permissions on Namespace's Macs";
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
