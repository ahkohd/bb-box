import type { DoctorCheck } from "../types.ts";
import type { CheckId } from "../../core/checks.ts";
import type { Measured } from "../../core/mac-capabilities.ts";
import { PRODUCT } from "../../brand.ts";
import type { SshPoolMachine } from "./config.ts";

export const SNAPSHOT_PROBE_VERSION = 1;
export const SNAPSHOT_REPORT_KEY_PREFIX = "pool-snapshots/";
export const SNAPSHOT_HOOK_PATH = "/usr/local/libexec/bb-box/snapshot-machine";
export const SNAPSHOT_HOOK_CONTRACT = 1;
export const POOL_TAKES_NO_SNAPSHOTS_YET = `${PRODUCT} takes no snapshots on the SSH host pool yet`;

export type HomeWay = "apfs" | "btrfs" | "zfs";

export interface HomeSnapshots {
  readonly way: HomeWay;
  readonly dataset: string | null;
}

export interface HookStorage {
  readonly name: string;
  readonly type: string;
  readonly percentFull: number | null;
}

export interface MachineSnapshots {
  readonly whileRunning: string | null;
  readonly restarts: boolean | null;
  readonly storage: HookStorage | null;
}

export interface PoolSnapshotReport {
  readonly machine: string;
  readonly at: number;
  readonly probe: number;
  readonly homes: string;
  readonly filesystem: string | null;
  readonly freeKiB: number | null;
  readonly home: Measured<HomeSnapshots>;
  readonly hook: Measured<MachineSnapshots>;
}

export interface SnapshotOffers {
  readonly home: Measured<HomeSnapshots>;
  readonly machine: Measured<MachineSnapshots>;
}

const HOME_WAYS: readonly HomeWay[] = ["apfs", "btrfs", "zfs"];

const HOME_WAY_WORDS: Readonly<Record<HomeWay, string>> = {
  apfs: "APFS clones available",
  btrfs: "btrfs subvolumes available",
  zfs: "ZFS datasets available",
};

const HOOK_STORAGE_WORDS: Readonly<Record<string, string>> = {
  lvmthin: "LVM thin",
  "lvm-thin": "LVM thin",
  zfs: "ZFS",
  zfspool: "ZFS",
  btrfs: "btrfs",
  cloud: "a cloud provider's snapshots",
};

function snapshotLines(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.startsWith("snapshot.")) continue;
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice("snapshot.".length, at).trim();
    if (!values.has(key)) values.set(key, line.slice(at + 1).trim());
  }
  return values;
}

function wholeOrNull(value: string | undefined): number | null {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

function homeOf(values: ReadonlyMap<string, string>): Measured<HomeSnapshots> {
  const said = values.get("home");
  const why = values.get("home.why") ?? "";
  const way = values.get("home.how") as HomeWay | undefined;
  if (said === "yes" && way && HOME_WAYS.includes(way)) return { is: "yes", what: { way, dataset: values.get("zfs.dataset") || null } };
  if (said === "no") return { is: "no", why };
  return { is: "unknown", why: why || "the helper did not say" };
}

function describedStorage(value: unknown): HookStorage | null {
  if (!value || typeof value !== "object") return null;
  const { name, type, percentFull } = value as Partial<Record<keyof HookStorage, unknown>>;
  if (typeof name !== "string" || typeof type !== "string") return null;
  return { name, type, percentFull: typeof percentFull === "number" ? percentFull : null };
}

function describedHook(json: string): Measured<MachineSnapshots> {
  let described: unknown;
  try {
    described = JSON.parse(json);
  } catch {
    return { is: "no", why: "its snapshot hook's describe did not print JSON" };
  }
  if (!described || typeof described !== "object") return { is: "no", why: "its snapshot hook's describe did not print a JSON object" };
  const { contract, scope, whileRunning, restarts, storage } = described as Record<string, unknown>;
  if (contract !== SNAPSHOT_HOOK_CONTRACT) return { is: "no", why: `its snapshot hook speaks contract ${JSON.stringify(contract ?? null)}, and ${PRODUCT} speaks ${SNAPSHOT_HOOK_CONTRACT}` };
  if (scope !== "machine") return { is: "no", why: `its snapshot hook describes scope ${JSON.stringify(scope ?? null)}, not "machine"` };
  return {
    is: "yes",
    what: {
      whileRunning: typeof whileRunning === "string" ? whileRunning : null,
      restarts: typeof restarts === "boolean" ? restarts : null,
      storage: describedStorage(storage),
    },
  };
}

function hookOf(values: ReadonlyMap<string, string>): Measured<MachineSnapshots> {
  const said = values.get("hook");
  if (said === "none") return { is: "no", why: "no snapshot hook is installed" };
  if (said === "failed") return { is: "no", why: `its snapshot hook's describe failed: ${values.get("hook.why") || "it said nothing"}` };
  if (said === "found") return describedHook(values.get("hook.describe") ?? "");
  return { is: "unknown", why: "the helper did not say" };
}

export function parseSnapshotReport(text: string, machine: string): PoolSnapshotReport | null {
  const values = snapshotLines(text);
  const probe = wholeOrNull(values.get("probe"));
  const at = wholeOrNull(values.get("at"));
  if (probe === null || at === null) return null;
  return {
    machine,
    at: at * 1000,
    probe,
    homes: values.get("homes") || "/home",
    filesystem: values.get("filesystem") || null,
    freeKiB: wholeOrNull(values.get("free_kib")),
    home: homeOf(values),
    hook: hookOf(values),
  };
}

function rootWhy(machine: SshPoolMachine): string | null {
  if (machine.os === "linux" && machine.reset === "machine") return "its boxes have root through its whole-machine reset, and a home snapshot would not hold what they change outside the home";
  return null;
}

function sharedWhy(machine: SshPoolMachine, listsSlots: boolean): string | null {
  if (listsSlots) return "it lends iOS slots, whose users share it, so no snapshot of the whole machine stands in for one box's";
  return null;
}

export function offersOf(report: PoolSnapshotReport, machine: SshPoolMachine, listsSlots: boolean): SnapshotOffers {
  const withRoot = rootWhy(machine);
  const shared = sharedWhy(machine, listsSlots);
  return {
    home: report.home.is === "yes" && withRoot ? { is: "no", why: withRoot } : report.home,
    machine: report.hook.is === "yes" && shared ? { is: "no", why: shared } : report.hook,
  };
}

function gibWords(kib: number): string {
  const gib = kib / 1024 / 1024;
  return gib >= 10 ? `${Math.round(gib)} GiB` : `${gib.toFixed(1)} GiB`;
}

function filesystemWords(report: PoolSnapshotReport): string {
  return `${report.filesystem ?? "an unknown filesystem"} under ${report.homes}`;
}

const FILESYSTEMS_THAT_SNAPSHOT: ReadonlySet<string> = new Set(["apfs", "btrfs", "zfs"]);

function homeNoWords(report: PoolSnapshotReport, why: string): string {
  if (why) return why;
  if (FILESYSTEMS_THAT_SNAPSHOT.has(report.filesystem ?? "")) return `${filesystemWords(report)}, but the helper did not say why its homes cannot use it`;
  return `${filesystemWords(report)}, which neither clones nor snapshots`;
}

export function homeWords(report: PoolSnapshotReport, home: Measured<HomeSnapshots>): string {
  if (home.is === "yes") {
    const dataset = home.what.dataset ? `, dataset ${home.what.dataset}` : "";
    const free = report.freeKiB !== null ? `, ${gibWords(report.freeKiB)} free` : "";
    return `home snapshots: ${HOME_WAY_WORDS[home.what.way]} under ${report.homes}${dataset}${free}`;
  }
  if (home.is === "no") return `home snapshots: none: ${homeNoWords(report, home.why)}`;
  return `home snapshots: not known: ${home.why}`;
}

function hookStorageWords(storage: HookStorage | null): string {
  if (!storage) return "";
  const type = HOOK_STORAGE_WORDS[storage.type] ?? storage.type;
  const full = storage.percentFull !== null ? `, ${storage.percentFull}% full` : "";
  return `, ${type} (${storage.name}${full})`;
}

export function machineWords(machine: Measured<MachineSnapshots>): string {
  if (machine.is === "yes") return `machine snapshots: hook found: machine scope${hookStorageWords(machine.what.storage)}`;
  if (machine.is === "no") return `machine snapshots: none: ${machine.why}`;
  return `machine snapshots: not known: ${machine.why}`;
}

export function couldOffer(offers: SnapshotOffers): boolean {
  return offers.home.is === "yes" || offers.machine.is === "yes";
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function measuredAgo(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`;
}

export interface MachineSnapshotsCheck {
  readonly id: CheckId;
  readonly name: string;
  readonly machine: SshPoolMachine;
  readonly listsSlots: boolean;
  readonly report: PoolSnapshotReport | null;
  readonly unknownWhy: string | null;
  readonly setupCommand: string;
  readonly now: number;
}

export function machineSnapshotsCheck(check: MachineSnapshotsCheck): DoctorCheck {
  const { id, name, report, machine } = check;
  if (!report) {
    return {
      id,
      name,
      status: "warn",
      detail: `${machine.name} has not said whether it can snapshot: ${check.unknownWhy ?? "it has not been probed yet"}.`,
      fix: `Run this ${PRODUCT}'s ${check.setupCommand}, which installs the helper that probes it. Then run the doctor again.`,
    };
  }
  const offers = offersOf(report, machine, check.listsSlots);
  const detail = `${capitalised(homeWords(report, offers.home))}. ${capitalised(machineWords(offers.machine))}. Probed ${measuredAgo(report.at, check.now)}. ${POOL_TAKES_NO_SNAPSHOTS_YET}.`;
  return { id, name, status: "ok", detail, fix: null };
}

export interface PoolMachineOffers {
  readonly machine: SshPoolMachine;
  readonly offers: SnapshotOffers | null;
}

function namesWords(names: readonly string[]): string {
  return names.length ? ` (${names.join(", ")})` : "";
}

export function poolSnapshotsSummary(id: CheckId, machines: readonly PoolMachineOffers[]): DoctorCheck {
  const total = machines.length;
  const of = (count: number) => `${count} of ${total} ${total === 1 ? "machine" : "machines"}`;
  const home = machines.filter((each) => each.offers?.home.is === "yes").map((each) => each.machine.name);
  const hooked = machines.filter((each) => each.offers?.machine.is === "yes").map((each) => each.machine.name);
  const unknown = machines.filter((each) => !each.offers).map((each) => each.machine.name);
  const parts = [
    `${of(home.length)} could offer home snapshots${namesWords(home)}`,
    `${of(hooked.length)} could offer machine snapshots by a hook${namesWords(hooked)}`,
    ...(unknown.length ? [`${of(unknown.length)} have not said${namesWords(unknown)}`] : []),
  ];
  return { id, name: "Snapshots on the pool's machines", status: "ok", detail: `${capitalised(parts.join("; "))}. ${POOL_TAKES_NO_SNAPSHOTS_YET}.`, fix: null };
}

function homeRefusalWords(report: PoolSnapshotReport, home: Measured<HomeSnapshots>): string {
  if (home.is === "no") return homeNoWords(report, home.why);
  if (home.is === "unknown") return `whether its homes snapshot is not known (${home.why})`;
  return HOME_WAY_WORDS[home.what.way];
}

function machineRefusalWords(machine: Measured<MachineSnapshots>): string {
  return machine.is === "yes" ? "a hook was found" : machine.why;
}

export function noSnapshotsWhy(machine: SshPoolMachine, report: PoolSnapshotReport | null, listsSlots: boolean): string {
  const its = `its machine, ${machine.name},`;
  if (!report) return `${its} has not said whether it can snapshot, and ${POOL_TAKES_NO_SNAPSHOTS_YET}`;
  const offers = offersOf(report, machine, listsSlots);
  if (couldOffer(offers)) {
    const could = [offers.home.is === "yes" ? homeWords(report, offers.home) : null, offers.machine.is === "yes" ? machineWords(offers.machine) : null].filter(Boolean).join("; ");
    return `${its} reports ${could}, but ${POOL_TAKES_NO_SNAPSHOTS_YET}`;
  }
  return `${its} takes no snapshots: for a home snapshot, ${homeRefusalWords(report, offers.home)}; for a machine snapshot, ${machineRefusalWords(offers.machine)}`;
}

export function snapshotReportKey(machine: string): string {
  return `${SNAPSHOT_REPORT_KEY_PREFIX}${machine}`;
}

function measuredFromJson<T>(value: unknown): Measured<T> | null {
  if (!value || typeof value !== "object") return null;
  const { is } = value as { is?: unknown };
  return is === "yes" || is === "no" || is === "unknown" ? (value as Measured<T>) : null;
}

export function snapshotReportFromJson(value: unknown): PoolSnapshotReport | null {
  if (!value || typeof value !== "object") return null;
  const report = value as Partial<PoolSnapshotReport>;
  if (typeof report.machine !== "string" || typeof report.at !== "number" || typeof report.probe !== "number" || typeof report.homes !== "string") return null;
  const home = measuredFromJson<HomeSnapshots>(report.home);
  const hook = measuredFromJson<MachineSnapshots>(report.hook);
  if (!home || !hook) return null;
  return {
    machine: report.machine,
    at: report.at,
    probe: report.probe,
    homes: report.homes,
    filesystem: typeof report.filesystem === "string" ? report.filesystem : null,
    freeKiB: typeof report.freeKiB === "number" ? report.freeKiB : null,
    home,
    hook,
  };
}
