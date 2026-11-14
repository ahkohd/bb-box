import { keptConclusive, loadReports, reportKey, withCapabilities, type MacReport, type Measured, type SoftwareEncoderOffer } from "../../core/mac-capabilities.ts";
import type { BackendStorage } from "../types.ts";

export const SOFTWARE_ENCODER_EACH_HOST_BUILDS: Measured<SoftwareEncoderOffer> = { is: "yes", what: { encoder: "OpenH264, built when a shared iOS host starts" } };
export const MACHINES_KEY_PREFIX = "mac-machines/";
export const MACHINES_KEPT_PER_CHIP = 20;

type HardwareByMachine = Map<string, boolean>;

function measuredNothing(report: MacReport): boolean {
  return Object.values(report.capabilities).every((measured) => measured.is === "unknown");
}

export class NamespaceMacReports {
  readonly #storage: BackendStorage;
  readonly #logError: (operation: string, error: unknown) => void;
  readonly #byChip = new Map<string, MacReport>();
  readonly #machines = new Map<string, HardwareByMachine>();
  #offered: readonly MacReport[] | null = null;

  constructor(storage: BackendStorage, logError: (operation: string, error: unknown) => void) {
    this.#storage = storage;
    this.#logError = logError;
  }

  async load(): Promise<MacReport[]> {
    for (const key of await this.#storage.list(MACHINES_KEY_PREFIX)) {
      const saved = await this.#storage.get<Record<string, unknown>>(key);
      if (!saved || typeof saved !== "object") continue;
      const machines: HardwareByMachine = new Map(Object.entries(saved).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
      if (machines.size) this.#machines.set(key.slice(MACHINES_KEY_PREFIX.length), machines);
    }
    this.#offered = null;
    return loadReports(this.#storage);
  }

  remember(report: MacReport, measuredOn: string | null): void {
    const chip = report.chip ?? report.mac;
    const known = this.#byChip.get(chip);
    if (measuredOn) this.#tally(chip, measuredOn, report);
    if (known && known.at > report.at) return;
    if (!report.chip && measuredNothing(report)) return;
    const byChip: MacReport = keptConclusive(known ?? null, { ...report, mac: chip });
    this.#byChip.set(chip, byChip);
    this.#offered = null;
    if (measuredOn) void this.#storage.set(reportKey(chip), byChip).catch((error) => this.#logError(`keep what Namespace's ${chip} Macs offer`, error));
  }

  #tally(chip: string, machine: string, report: MacReport): void {
    const hardware = report.capabilities.hardwareEncoder.is === "yes" ? true : report.capabilities.hardwareEncoder.is === "no" ? false : null;
    if (hardware === null) return;
    const machines = this.#machines.get(chip) ?? new Map<string, boolean>();
    if (machines.get(machine) === hardware) return;
    machines.delete(machine);
    machines.set(machine, hardware);
    while (machines.size > MACHINES_KEPT_PER_CHIP) machines.delete(machines.keys().next().value!);
    this.#machines.set(chip, machines);
    this.#offered = null;
    void this.#storage.set(`${MACHINES_KEY_PREFIX}${chip}`, Object.fromEntries(machines)).catch((error) => this.#logError(`keep which of Namespace's ${chip} Macs had a hardware encoder`, error));
  }

  all(): readonly MacReport[] {
    this.#offered ??= [...this.#byChip.values()].sort((a, b) => b.at - a.at).map((report) => this.#asOffered(report));
    return this.#offered;
  }

  forOffer(): MacReport | null {
    const reports = this.all();
    return reports.find((report) => report.capabilities.simulator.is === "yes") ?? reports.find((report) => report.capabilities.simulator.is === "no") ?? reports[0] ?? null;
  }

  #asOffered(report: MacReport): MacReport {
    const machines = [...(this.#machines.get(report.mac)?.values() ?? [])];
    const offered = report.capabilities.softwareEncoder.is === "yes" ? report : withCapabilities(report, { softwareEncoder: SOFTWARE_ENCODER_EACH_HOST_BUILDS });
    return { ...offered, machines: { withHardwareEncoder: machines.filter(Boolean).length, withoutHardwareEncoder: machines.filter((hardware) => !hardware).length } };
  }
}
