import {
  RestoreChanged,
  SnapshotFailed,
  SnapshotIncomplete,
  type BoxOwner,
  type BoxSize,
  type OutsideRollback,
  type RestoreWay,
  type TaskKind,
  type Guest,
  type HeldSnapshot,
  type Holds,
  type SnapshotHooks,
  type SnapshotPlan,
  type SnapshotRef,
  type SnapshotTake,
  type SnapshotTaken,
  type SnapshotStorage,
  type Snapshotting,
  type TaskOutcome,
  type TaskRef,
} from "../types.ts";
import { ProxmoxError, type GuestType, type Proxmox, type ProxmoxSnapshot, type StorageConfig } from "./api.ts";
import { SNAPSHOT_PRIVILEGES, storageSnapshots, type SnapshotRestore } from "./snapshots.ts";

const GiB = 1024 ** 3;
const PRIVILEGES_FRESH_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
const TAKES_ABOUT_MS = 1_000;
const CLOCK_SLACK_S = 5;
const MEMORY_ABOUT_MS_PER_GIB = 1_000;
const COPY_ABOUT_MS_PER_GIB = 2_400;
const TASK_TYPES: Readonly<Record<TaskKind, string>> = { take: "snapshot", delete: "delsnapshot", rollback: "rollback", copy: "clone" };
const LOCKS_A_TASK_LEAVES = new Set(["snapshot", "snapshot-delete", "rollback", "backup", "clone", "create", "disk", "migrate", "copy"]);

export function snapshotName(id: string): string {
  return `bb${id}`;
}

export interface SnapshotLabel {
  readonly install: string;
  readonly box: string;
  readonly snapshot: string;
  readonly kept: string | null;
}

export function snapshotLabel(label: SnapshotLabel): string {
  return `bb-box install ${label.install} box ${label.box} snapshot ${label.snapshot}${label.kept ? ` kept ${label.kept}` : ""}`;
}

export function parseSnapshotLabel(text: string): SnapshotLabel | null {
  const match = /^bb-box install (\S+) box (\S+) snapshot (sn[a-z2-7]{12})(?: kept (\d{4}-\d{2}-\d{2}))?\s*$/.exec(text.trim());
  if (!match) return null;
  return { install: match[1]!, box: match[2]!, snapshot: match[3]!, kept: match[4] ?? null };
}

export function keptUntilOf(date: string | null): number | null {
  if (!date) return null;
  const start = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(start) ? null : start + DAY_MS - 1;
}

export interface KeptGuest {
  readonly guest: Guest;
  readonly owner: BoxOwner | null;
  readonly where: "earlier" | "held-copy";
  readonly snapshot: string | null;
  readonly takenAt: number | null;
  readonly kept: string | null;
  readonly template: boolean;
}

export interface SnapshotGuests {
  readonly label: string;
  readonly type: GuestType;
  readonly installId: string;
  readonly pool: string;
  client(): Promise<Proxmox>;
  vmid(guest: Guest): number;
  ownConfig(api: Proxmox, guest: Guest, signal?: AbortSignal): Promise<Record<string, unknown>>;
  still(api: Proxmox, guest: Guest, signal?: AbortSignal): Promise<boolean>;
  rootDisk(config: Record<string, unknown>): string | null;
  disks(config: Record<string, unknown>): readonly string[];
  sizeOf(config: Record<string, unknown>): BoxSize | null;
  guests(api: Proxmox, signal?: AbortSignal): Promise<readonly { readonly guest: Guest; readonly owner: BoxOwner | null }[]>;
  copies?(api: Proxmox, signal?: AbortSignal): Promise<readonly KeptGuest[]>;
}

const MiB = 1024 * 1024;
const STATE_EXTRA_MIB = 500;
const SHARES_BLOCKS = new Set(["lvmthin", "zfspool", "zfs", "rbd", "btrfs"]);
const TASK_NAMES: Readonly<Record<string, string>> = {
  vzdump: "a backup",
  vzsnapshot: "a snapshot",
  qmsnapshot: "a snapshot",
  vzdelsnapshot: "a snapshot's delete",
  qmdelsnapshot: "a snapshot's delete",
  vzrollback: "a rollback",
  qmrollback: "a rollback",
  vzclone: "a clone",
  qmclone: "a clone",
  vzmigrate: "a migration",
  qmigrate: "a migration",
  move_volume: "a disk move",
  qmmove: "a disk move",
};

function taskWords(error: ProxmoxError): string {
  return /failed \(\d+\): (.*)$/s.exec(error.message)?.[1]?.trim() || error.message;
}

function snapstateWords(snapstate: string): string {
  return snapstate === "prepare" ? "Proxmox left it part-made (snapstate prepare)" : snapstate === "delete" ? "Proxmox left it part-deleted (snapstate delete)" : `Proxmox left it in state ${snapstate}`;
}

function percent(used: number, total: number): number {
  return total > 0 ? Math.round((used / total) * 1000) / 10 : 0;
}

export function storageOfVolume(value: unknown): string | null {
  return /^([A-Za-z][A-Za-z0-9_.-]*):/.exec(String(value ?? ""))?.[1] ?? null;
}

function memoryMiBOf(config: Record<string, unknown>): number {
  const value = /(?:^|current=)(\d+)/.exec(String(config.memory ?? ""))?.[1];
  return value ? Number(value) : 512;
}

export function storageKey(node: string, name: string, shared: boolean): string {
  return shared ? `proxmox:shared:${name}` : `proxmox:${node}:${name}`;
}

export async function thinMetadata(api: Proxmox, name: string, configs: ReadonlyMap<string, StorageConfig> | Error, signal?: AbortSignal): Promise<{ readonly percent: number | null; readonly unread: string | null }> {
  if (configs instanceof Error) return { percent: null, unread: `bb-box cannot read ${name}'s settings: ${configs.message.replace(/\.$/, "")}` };
  const config = configs.get(name);
  if (!config?.vgname || !config.thinpool) return { percent: null, unread: `bb-box cannot read which thin pool ${name} is` };
  let pools;
  try {
    pools = await api.thinPools(signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return { percent: null, unread: `bb-box cannot read the node's thin pools: ${(error instanceof Error ? error.message : String(error)).replace(/\.$/, "")}` };
  }
  const pool = pools.find((each) => each.vg === config.vgname && each.lv === config.thinpool);
  if (!pool || pool.metadataSize <= 0) return { percent: null, unread: `the node lists no thin pool ${config.vgname}/${config.thinpool}` };
  return { percent: percent(pool.metadataUsed, pool.metadataSize), unread: null };
}

export async function storagesMetadata(api: Proxmox, storages: readonly { readonly name: string; readonly type: string }[], signal?: AbortSignal): Promise<{ readonly storage: string; readonly unread: string | null }[]> {
  const thin = [...new Set(storages.filter((storage) => storage.type === "lvmthin").map((storage) => storage.name))];
  if (!thin.length) return [];
  const configs = await api.storageConfigs(signal).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  return Promise.all(thin.map(async (name) => ({ storage: name, unread: (await thinMetadata(api, name, configs, signal)).unread })));
}

type Busy = { readonly is: "task"; readonly name: string } | { readonly is: "idle" } | { readonly is: "unknown" };

export class ProxmoxSnapshotting {
  readonly #guests: SnapshotGuests;
  readonly #holds: readonly Holds[];
  #rights: { readonly at: number; readonly held: ReadonlySet<string> | null } | null = null;
  readonly #now: () => number;

  constructor(guests: SnapshotGuests, holds: readonly Holds[], now: () => number = Date.now) {
    this.#guests = guests;
    this.#holds = holds;
    this.#now = now;
  }

  offer(): Snapshotting {
    return { scope: "box", holds: this.#holds, whileRunning: "live", restore: "in-place", fork: "none", keepsPastRelease: "no", lives: "host", price: null, excludes: null };
  }

  #tool(): string {
    return this.#guests.type === "qemu" ? "qm" : "pct";
  }

  async #privileges(api: Proxmox, signal?: AbortSignal): Promise<ReadonlySet<string> | null> {
    const known = this.#rights;
    if (known && this.#now() - known.at < PRIVILEGES_FRESH_MS) return known.held;
    const held = await api.privilegesOn(`/pool/${this.#guests.pool}`, signal).catch(() => null);
    this.#rights = { at: this.#now(), held };
    return held;
  }

  async #busy(api: Proxmox, vmid: number, signal?: AbortSignal): Promise<Busy> {
    try {
      const running = await api.activeTasks(vmid, signal);
      const first = running[0];
      return first ? { is: "task", name: TASK_NAMES[first.type] ?? `a ${first.type} task` } : { is: "idle" };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { is: "unknown" };
    }
  }

  async #lockWords(api: Proxmox, vmid: number, lock: string, signal?: AbortSignal): Promise<{ readonly running: string | null; readonly fix: string | null }> {
    const unlock = `\`${this.#tool()} unlock ${vmid}\` on ${api.node}`;
    if (!LOCKS_A_TASK_LEAVES.has(lock)) return { running: null, fix: null };
    const busy = await this.#busy(api, vmid, signal);
    if (busy.is === "task") return { running: `Proxmox is running ${busy.name} on guest ${vmid}, which holds its lock (${lock}). Try again when it ends.`, fix: null };
    if (busy.is === "unknown") return { running: null, fix: `If no task is running on guest ${vmid}, run ${unlock}.` };
    return { running: null, fix: `Run ${unlock}.` };
  }

  async #storage(api: Proxmox, name: string, configs: ReadonlyMap<string, StorageConfig> | Error, signal?: AbortSignal): Promise<SnapshotStorage | null> {
    const status = await api.storageStatus(name, signal).catch((error: unknown) => {
      if (signal?.aborted) throw error;
      return null;
    });
    if (!status) return null;
    const config = configs instanceof Error ? undefined : configs.get(name);
    const type = status.type || config?.type || "";
    const used = Math.max(0, status.total - status.available);
    const metadata = type === "lvmthin" ? await thinMetadata(api, name, configs, signal) : { percent: null, unread: null };
    return {
      key: storageKey(api.node, name, config?.shared ?? false),
      name,
      type,
      percentFull: percent(used, status.total),
      metadataPercentFull: metadata.percent,
      metadataUnread: metadata.unread,
      totalBytes: status.total,
      usedBytes: used,
    };
  }

  #memoryTarget(config: Record<string, unknown>, configs: ReadonlyMap<string, StorageConfig> | Error): { readonly name: string } | { readonly why: string } {
    const set = typeof config.vmstatestorage === "string" && config.vmstatestorage ? config.vmstatestorage : null;
    if (set) return { name: set };
    if (configs instanceof Error) return { why: `bb-box cannot read the storage settings Proxmox chooses a memory snapshot's storage by: ${configs.message.replace(/\.$/, "")}` };
    const used = [...new Set(this.#guests.disks(config).map((disk) => storageOfVolume(config[disk])).filter((name): name is string => name !== null))];
    const unread = used.find((name) => !configs.has(name));
    if (unread) return { why: `bb-box cannot read the settings of ${unread}, where one of its disks is, so it cannot tell where Proxmox would save its memory` };
    const shared = used.filter((name) => configs.get(name)!.shared);
    const pool = shared.length ? shared : used;
    if (!pool.length) return { why: "it has no disk on a storage, so bb-box cannot tell where Proxmox would save its memory" };
    const files = pool.filter((name) => configs.get(name)!.path !== null);
    const candidates = files.length ? files : pool;
    if (candidates.length > 1) return { why: `Proxmox would save its memory on one of ${candidates.join(", ")}, and bb-box cannot tell which. Set vmstatestorage on the VM, or take one without memory` };
    return { name: candidates[0]! };
  }

  async plan(guest: Guest, signal?: AbortSignal, target: SnapshotRef | null = null): Promise<SnapshotPlan> {
    const api = await this.#guests.client();
    const vmid = this.#guests.vmid(guest);
    const config = await this.#guests.ownConfig(api, guest, signal);
    const disk = this.#guests.rootDisk(config);
    const volume = disk ? String(config[disk] ?? "") : "";
    const storageName = storageOfVolume(volume) ?? "";
    const configs = await api.storageConfigs(signal).catch((error: unknown) => {
      if (signal?.aborted) throw error;
      return error instanceof Error ? error : new Error(String(error));
    });
    const [storage, privileges] = await Promise.all([storageName ? this.#storage(api, storageName, configs, signal) : Promise.resolve(null), this.#privileges(api, signal)]);
    const type = storage?.type ?? "";
    const lock = typeof config.lock === "string" && config.lock ? config.lock : null;
    const memoryMiB = memoryMiBOf(config);
    const reasons: string[] = [];
    if (privileges && !privileges.has(SNAPSHOT_PRIVILEGES[0])) {
      reasons.push(`The Proxmox token lacks VM.Snapshot on /pool/${this.#guests.pool}, so bb-box cannot take snapshots there. Run host/setup-token.sh from the Proxmox LXC setup guide again, as root on ${api.node}.`);
    }
    const takes = storageName && storage ? storageSnapshots({ name: storageName, type, volume }, this.#guests.type) : null;
    if (!takes) reasons.push(`bb-box could not read the storage guest ${vmid}'s disk is on, so it takes no snapshot of it.`);
    else if (takes.restore === "none" || takes.restore === "unknown") reasons.push(`${takes.words.replace(/\.$/, "")}, so bb-box takes no snapshot there.`);
    const restores: { readonly restore: SnapshotRestore; readonly words: string }[] = takes ? [takes] : [];
    for (const other of this.#guests.disks(config)) {
      const name = storageOfVolume(config[other]);
      if (!name || other === disk) continue;
      const otherType = name === storageName ? type : (configs instanceof Error ? undefined : configs.get(name)?.type) ?? (await api.storageStatus(name, signal).catch(() => null))?.type;
      if (!otherType) {
        reasons.push(`bb-box cannot read storage ${name}, where guest ${vmid}'s ${other} is, so it takes no snapshot of it.`);
        restores.push({ restore: "unknown", words: `bb-box cannot read storage ${name}, where guest ${vmid}'s ${other} is.` });
        continue;
      }
      const verdict = storageSnapshots({ name, type: otherType, volume: String(config[other]) }, this.#guests.type);
      restores.push(verdict);
      if (verdict.restore === "none" || verdict.restore === "unknown") reasons.push(`Guest ${vmid}'s ${other} is on ${name}, and ${verdict.words.replace(/\.$/, "")}, so bb-box takes no snapshot of it.`);
    }
    let locked: SnapshotPlan["locked"] = null;
    if (lock === "suspended") reasons.push("a stopped Proxmox QEMU box is kept suspended to disk, so start it first.");
    else if (lock) {
      const words = await this.#lockWords(api, vmid, lock, signal);
      if (words.running) reasons.push(words.running);
      else if (words.fix) locked = { lock, fix: words.fix };
      else reasons.push(`Proxmox has guest ${vmid} locked (${lock}), so bb-box takes no snapshot of it.`);
    }
    let memory: SnapshotPlan["take"]["memory"] = null;
    let memoryWhy: string | null = null;
    if (this.#holds.includes("disk-and-memory")) {
      const target = this.#memoryTarget(config, configs);
      if ("why" in target) memoryWhy = `${target.why}.`;
      else {
        const memoryStorage = target.name === storageName ? storage : await this.#storage(api, target.name, configs, signal);
        if (!memoryStorage) memoryWhy = `bb-box cannot read storage ${target.name}, where Proxmox would save its memory.`;
        else memory = { storage: memoryStorage, addsBytes: (memoryMiB * 2 + STATE_EXTRA_MIB) * MiB };
      }
    }
    return {
      storage: storage ?? { key: storageKey(api.node, storageName, false), name: storageName, type, percentFull: 0, metadataPercentFull: null, metadataUnread: null, totalBytes: null, usedBytes: null },
      take: {
        ok: reasons.length === 0 && !locked,
        why: reasons[0] ?? null,
        aboutMs: TAKES_ABOUT_MS,
        memoryAboutMs: this.#holds.includes("disk-and-memory") ? TAKES_ABOUT_MS + Math.round((memoryMiB * MiB * MEMORY_ABOUT_MS_PER_GIB) / GiB) : null,
        addsBytes: SHARES_BLOCKS.has(type) ? 0 : null,
        memory,
        memoryWhy,
      },
      restore: await this.#restorePlan(api, guest, config, { type, restores, privileges, lock, takeWhy: reasons[0] ?? null }, target, signal),
      keep: { way: "no", why: "bb-box does not keep snapshots past a release yet.", aboutMs: null, bytes: null, price: null },
      fork: { ok: false, why: "bb-box does not fork snapshots yet.", aboutMs: 0, bytes: null },
      locked,
    };
  }

  async #restorePlan(
    api: Proxmox,
    guest: Guest,
    config: Record<string, unknown>,
    seen: { readonly type: string; readonly restores: readonly { readonly restore: SnapshotRestore; readonly words: string }[]; readonly privileges: ReadonlySet<string> | null; readonly lock: string | null; readonly takeWhy: string | null },
    target: SnapshotRef | null,
    signal?: AbortSignal,
  ): Promise<SnapshotPlan["restore"]> {
    const vmid = this.#guests.vmid(guest);
    const diskGiB = this.#guests.sizeOf(config)?.diskGiB ?? null;
    const copyAboutMs = diskGiB !== null ? Math.round(diskGiB * COPY_ABOUT_MS_PER_GIB) : null;
    const copyBytes = diskGiB !== null ? diskGiB * GiB : null;
    const none = (why: string): SnapshotPlan["restore"] => ({ way: "none", why, undo: "none", undoAboutMs: 0, undoBytes: null, sizeBack: null, leavesOnEarlierGuest: 0, newer: 0, copyAboutMs });
    const weakest = seen.restores.find((each) => each.restore === "none" || each.restore === "unknown");
    if (!seen.restores.length) return none(seen.takeWhy ?? `bb-box could not read the storage guest ${vmid}'s disk is on.`);
    if (weakest) return none(weakest.words);
    if (seen.privileges && !seen.privileges.has(SNAPSHOT_PRIVILEGES[1])) {
      return none(`The Proxmox token lacks VM.Snapshot.Rollback on /pool/${this.#guests.pool}, so bb-box cannot restore snapshots there. Run host/setup-token.sh from the Proxmox LXC setup guide again, as root on ${api.node}.`);
    }
    if (seen.lock === "suspended") return none("a stopped Proxmox QEMU box is kept suspended to disk, so start it first.");
    const way: RestoreWay = seen.restores.some((each) => each.restore === "newest-only") ? "rollback-newest-only" : "rollback";
    const undo = way === "rollback" ? { undo: "snapshot" as const, undoAboutMs: TAKES_ABOUT_MS, undoBytes: SHARES_BLOCKS.has(seen.type) ? 0 : null } : { undo: "held-copy" as const, undoAboutMs: copyAboutMs ?? 0, undoBytes: copyBytes };
    if (!target) return { way, why: null, ...undo, sizeBack: null, leavesOnEarlierGuest: 0, newer: 0, copyAboutMs };
    const name = snapshotName(target.id);
    const listed = await api.snapshots(vmid, signal);
    const found = listed.find((snapshot) => snapshot.name === name);
    if (!found) return none(`Guest ${vmid} has no snapshot ${name}.`);
    if (found.snapstate) return none(`${snapstateWords(found.snapstate)}, so bb-box does not restore it.`);
    const newer = found.snaptime === null ? 0 : listed.filter((snapshot) => snapshot.name !== name && snapshot.snaptime !== null && snapshot.snaptime > found.snaptime!).length;
    const sizeBack = await api
      .snapshotConfig(vmid, name, signal)
      .then((saved) => this.#guests.sizeOf(saved))
      .catch((error: unknown) => {
        if (signal?.aborted) throw error;
        return null;
      });
    return { way, why: null, ...undo, sizeBack, leavesOnEarlierGuest: 0, newer, copyAboutMs };
  }

  async #listed(api: Proxmox, vmid: number, name: string, signal?: AbortSignal): Promise<ProxmoxSnapshot | null> {
    return (await api.snapshots(vmid, signal)).find((snapshot) => snapshot.name === name) ?? null;
  }

  async #waited(api: Proxmox, upid: string, signal?: AbortSignal): Promise<string | null> {
    try {
      await api.waitTask(upid, signal);
      return null;
    } catch (error) {
      if (error instanceof ProxmoxError && error.method === "TASK" && error.status === 500) return taskWords(error);
      throw error;
    }
  }

  #ours(snapshot: ProxmoxSnapshot, id: string, box: string | null): boolean {
    const label = parseSnapshotLabel(snapshot.description);
    return label !== null && label.install === this.#guests.installId && label.snapshot === id && (box === null || label.box === box);
  }

  async take(guest: Guest, take: SnapshotTake, hooks: SnapshotHooks, signal?: AbortSignal): Promise<SnapshotTaken> {
    const api = await this.#guests.client();
    const vmid = this.#guests.vmid(guest);
    const name = snapshotName(take.id);
    let upid: string;
    try {
      if (!(await this.#guests.still(api, guest, signal))) throw new SnapshotFailed(`Guest ${vmid} is no longer the box's.`);
      if (await this.#listed(api, vmid, name, signal)) throw new SnapshotFailed(`Guest ${vmid} has a snapshot named ${name} already.`);
      await hooks.submitting();
      upid = await api.startSnapshot(vmid, { name, description: snapshotLabel({ install: this.#guests.installId, box: take.box, snapshot: take.id, kept: null }), memory: take.memory }, signal);
    } catch (error) {
      if (error instanceof ProxmoxError && error.status >= 400) throw new SnapshotFailed(taskWords(error));
      throw error;
    }
    await hooks.task({ ref: upid, host: api.node });
    const failure = await this.#waited(api, upid, signal);
    const found = await this.#listed(api, vmid, name, signal);
    if (!found) throw new SnapshotFailed(failure ?? `Proxmox's task ended, but guest ${vmid} has no snapshot ${name}.`);
    if (found.snapstate) throw new SnapshotIncomplete(`${snapstateWords(found.snapstate)}${failure ? `: ${failure}` : ""}.`);
    if (failure) throw new SnapshotIncomplete(`Proxmox's task failed (${failure}), though it left the snapshot with no part-made state, so bb-box does not count it as taken.`);
    return { ref: name, holds: found.vmstate ? "disk-and-memory" : "disk", capturedAt: found.snaptime !== null ? found.snaptime * 1000 : this.#now(), size: null };
  }

  async delete(ref: SnapshotRef, hooks: SnapshotHooks, signal?: AbortSignal): Promise<void> {
    const api = await this.#guests.client();
    const vmid = this.#guests.vmid(ref.guest);
    const name = snapshotName(ref.id);
    if (!(await this.#guests.still(api, ref.guest, signal))) return;
    const listed = await this.#listed(api, vmid, name, signal);
    if (!listed) return;
    const box = typeof ref.guest.data?.box === "string" ? ref.guest.data.box : null;
    if (!this.#ours(listed, ref.id, box)) {
      throw new SnapshotFailed(`The snapshot named ${name} on guest ${vmid} is not bb-box's snapshot ${ref.id}: its description says "${listed.description.slice(0, 200)}". bb-box deleted nothing.`);
    }
    const config = await this.#guests.ownConfig(api, ref.guest, signal);
    const lock = typeof config.lock === "string" && config.lock ? config.lock : null;
    if (lock) {
      const words = await this.#lockWords(api, vmid, lock, signal);
      const failed = words.running ?? `Proxmox has guest ${vmid} locked (${lock}), so it cannot delete the snapshot.${words.fix ? ` ${words.fix.replace(/\.$/, "")}, then delete it again.` : ""}`;
      throw listed.snapstate ? new SnapshotIncomplete(`${snapstateWords(listed.snapstate)}. ${failed}`) : new SnapshotFailed(failed);
    }
    let upid: string;
    try {
      await hooks.submitting();
      upid = await api.startSnapshotDelete(vmid, name, listed.snapstate !== null, signal);
    } catch (error) {
      if (error instanceof ProxmoxError && error.status >= 400) {
        if (/does not exist/i.test(error.message)) return;
        throw listed.snapstate ? new SnapshotIncomplete(`${snapstateWords(listed.snapstate)}: ${taskWords(error)}`) : new SnapshotFailed(taskWords(error));
      }
      throw error;
    }
    await hooks.task({ ref: upid, host: api.node });
    const failure = await this.#waited(api, upid, signal);
    const after = await this.#listed(api, vmid, name, signal);
    if (!after) return;
    if (after.snapstate) throw new SnapshotIncomplete(`${snapstateWords(after.snapstate)}${failure ? `: ${failure}` : ""}.`);
    throw new SnapshotFailed(failure ?? "Proxmox's task ended, but the snapshot is still there.");
  }

  async rollback(guest: Guest, ref: SnapshotRef, hooks: SnapshotHooks, signal?: AbortSignal): Promise<void> {
    const api = await this.#guests.client();
    const vmid = this.#guests.vmid(guest);
    const name = snapshotName(ref.id);
    let upid: string;
    try {
      if (!(await this.#guests.still(api, guest, signal))) throw new SnapshotFailed(`Guest ${vmid} is no longer the box's.`);
      const listed = await this.#listed(api, vmid, name, signal);
      if (!listed) throw new SnapshotFailed(`Guest ${vmid} has no snapshot ${name}.`);
      const box = typeof guest.data?.box === "string" ? guest.data.box : null;
      if (!this.#ours(listed, ref.id, box)) throw new SnapshotFailed(`The snapshot named ${name} on guest ${vmid} is not bb-box's snapshot ${ref.id}: its description says "${listed.description.slice(0, 200)}". bb-box changed nothing.`);
      if (listed.snapstate) throw new SnapshotFailed(`${snapstateWords(listed.snapstate)}, so bb-box does not restore it.`);
      if ((await api.status(vmid, signal))?.status === "running") throw new SnapshotFailed(`Guest ${vmid} is running, and bb-box restores a guest only once it has stopped.`);
      const config = await this.#guests.ownConfig(api, guest, signal);
      const lock = typeof config.lock === "string" && config.lock ? config.lock : null;
      if (lock) {
        const words = await this.#lockWords(api, vmid, lock, signal);
        throw new SnapshotFailed(words.running ?? `Proxmox has guest ${vmid} locked (${lock}), so it cannot restore the snapshot.${words.fix ? ` ${words.fix}` : ""}`);
      }
      await hooks.submitting();
      upid = await api.startRollback(vmid, name, signal);
    } catch (error) {
      if (error instanceof ProxmoxError && error.status >= 400) throw new SnapshotFailed(taskWords(error));
      throw error;
    }
    await hooks.task({ ref: upid, host: api.node });
    const failure = await this.#waited(api, upid, signal);
    if (failure) throw new RestoreChanged(`Proxmox's rollback task failed: ${failure.replace(/\.$/, "")}.`);
  }

  async outsideRollbacks(since: number, signal?: AbortSignal): Promise<OutsideRollback[]> {
    const api = await this.#guests.client();
    const guests = new Map((await this.#guests.guests(api, signal)).map(({ guest }) => [this.#guests.vmid(guest), guest]));
    const type = `${this.#guests.type === "qemu" ? "qm" : "vz"}${TASK_TYPES.rollback}`;
    const found: OutsideRollback[] = [];
    for (const task of await api.tasksOfType(type, Math.floor(since / 1000) - CLOCK_SLACK_S, signal)) {
      const guest = task.vmid === null ? undefined : guests.get(task.vmid);
      if (!guest) continue;
      const ref = { ref: task.upid, host: api.node };
      const outcome: TaskOutcome = !task.ended || task.status === null ? await this.task(ref, signal) : task.status === "OK" || /^WARNINGS: \d+$/.test(task.status) ? { state: "ok" } : { state: "failed", words: task.status };
      found.push({ task: ref, guest: guest.ref, user: task.user, startedAt: task.start * 1000, outcome });
    }
    return found.sort((a, b) => a.startedAt - b.startedAt);
  }

  async held(signal?: AbortSignal): Promise<HeldSnapshot[]> {
    const api = await this.#guests.client();
    const held: HeldSnapshot[] = [];
    const kept = (await this.#guests.copies?.(api, signal)) ?? [];
    for (const copy of kept) {
      if (copy.where !== "held-copy" || !copy.snapshot || !copy.owner) continue;
      held.push({
        id: copy.snapshot,
        ref: copy.guest.ref,
        box: copy.owner.boxId,
        owner: copy.owner,
        guest: copy.guest,
        where: "held-copy",
        state: copy.template ? "complete" : "incomplete",
        words: copy.template ? null : "Its copy is not a template yet, so bb-box does not trust it.",
        holds: "disk",
        takenAt: copy.takenAt,
        keptUntil: keptUntilOf(copy.kept),
        storage: null,
      });
    }
    const guests = [...(await this.#guests.guests(api, signal)).map((each) => ({ ...each, where: "current" as const })), ...kept.filter((copy) => copy.where === "earlier").map((copy) => ({ guest: copy.guest, owner: copy.owner, where: "earlier" as const }))];
    for (const { guest, owner, where } of guests) {
      signal?.throwIfAborted();
      const vmid = this.#guests.vmid(guest);
      let listed: ProxmoxSnapshot[];
      try {
        listed = await api.snapshots(vmid, signal);
      } catch (error) {
        if (error instanceof ProxmoxError && error.gone) continue;
        throw error;
      }
      let busy: Busy | null = null;
      for (const snapshot of listed) {
        const label = parseSnapshotLabel(snapshot.description);
        if (!label || label.install !== this.#guests.installId || snapshot.name !== snapshotName(label.snapshot)) continue;
        if (snapshot.snapstate && busy === null) busy = await this.#busy(api, vmid, signal);
        held.push({
          id: label.snapshot,
          ref: snapshot.name,
          box: label.box,
          owner,
          guest,
          where,
          state: snapshot.snapstate ? (busy?.is === "idle" ? "incomplete" : "in-progress") : "complete",
          words: snapshot.snapstate ? `${snapstateWords(snapshot.snapstate)}.` : null,
          holds: snapshot.vmstate ? "disk-and-memory" : "disk",
          takenAt: snapshot.snaptime !== null ? snapshot.snaptime * 1000 : null,
          keptUntil: keptUntilOf(label.kept),
          storage: null,
        });
      }
    }
    return held;
  }

  async task(task: TaskRef, signal?: AbortSignal): Promise<TaskOutcome> {
    const api = await this.#guests.client();
    const status = await api.taskStatus(task.ref, signal);
    if (!status) return { state: "missing", words: `Proxmox has no task ${task.ref}.` };
    if (status.running) return { state: "running" };
    const exit = status.exit ?? "";
    return exit === "OK" || /^WARNINGS: \d+$/.test(exit) ? { state: "ok" } : { state: "failed", words: exit || "the task failed" };
  }

  async findTasks(guest: Guest, operation: TaskKind, since: number, signal?: AbortSignal): Promise<TaskRef[]> {
    const api = await this.#guests.client();
    const vmid = this.#guests.vmid(guest);
    const type = `${this.#guests.type === "qemu" ? "qm" : "vz"}${TASK_TYPES[operation]}`;
    const from = Math.floor(since / 1000) - CLOCK_SLACK_S;
    return (await api.tasksSince(vmid, type, from, signal))
      .filter((task) => task.start >= from)
      .sort((a, b) => a.start - b.start)
      .map((task) => ({ ref: task.upid, host: api.node }));
  }
}
