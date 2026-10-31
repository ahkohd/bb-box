import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type AcquireHooks,
  RestoreChanged,
  SnapshotFailed,
  SnapshotIncomplete,
  type BoxIdentity,
  type BoxSize,
  type CopyHooks,
  type CopyPlan,
  type CopyState,
  type KeepsPastRelease,
  type GuestIdentity,
  type HeldCopyLabel,
  type Guest,
  type HeldSnapshot,
  type OutsideRollback,
  type SnapshotHooks,
  type SnapshotPlan,
  type SnapshotRef,
  type SnapshotStorage,
  type Snapshotting,
  type TaskKind,
  type TaskOutcome,
  type TaskRef,
} from "../src/backends/types.ts";
import type { FakeBackend } from "./fake-backend.ts";

export interface Held {
  id: string;
  box: string;
  guest: Guest;
  state: HeldSnapshot["state"];
  holds: HeldSnapshot["holds"];
  takenAt: number;
  keptUntil: number | null;
}

export type Outcome = "ok" | "failed" | "incomplete" | "unknown" | "ok-task-failed";
export type RollbackOutcome = "ok" | "refused" | "failed" | "unknown";
export type Submit = "answered" | "answer-lost" | "never-arrived";

export interface UnsettledSteps {
  unsettled(): readonly { readonly snapshots: readonly string[]; readonly step: string }[];
}

const GiB = 2 ** 30;
const OWN_USER = "bb-box@pve";
const MiB = 2 ** 20;

export class FakeSnapshots {
  readonly held = new Map<string, Held>();
  readonly tasks = new Map<string, TaskOutcome>();
  readonly started = new Map<string, { readonly ref: string; readonly at: number; readonly operation: TaskKind; readonly user?: string }>();
  restoreWay: SnapshotPlan["restore"]["way"] = "rollback";
  restoreWhy: string | null = null;
  newer = 0;
  rollback: RollbackOutcome = "ok";
  powerOffFault: Error | null = null;
  readonly order: string[] = [];
  readonly sizes = new Map<string, BoxSize>();
  readonly outside: OutsideRollback[] = [];
  readonly copies = new Map<string, { state: "copy" | "template"; box: string; snapshot: string; disarmed: boolean; takenAt: number; kept?: string | null; forkSafe?: number | null; of?: string }>();
  keepWay: KeepsPastRelease = "held-copy";
  keepWhy: string | null = null;
  keepUsedBytes: number | null = 2 * GiB;
  labelFault: Error | null = null;
  readonly labels: string[] = [];
  readonly runningCopies = new Set<string>();
  copyGate: Promise<void> | null = null;
  copyTemplates = true;
  readonly earlier = new Set<string>();
  copyFault: Error | null = null;
  forkFault: Error | null = null;
  forkWhy: string | null = null;
  onForked: ((made: Guest, ref: SnapshotRef) => Promise<void>) | null = null;
  #copies = 0;
  listing: Error | null = null;
  listingGate: Promise<void> | null = null;
  take: Outcome = "ok";
  remove: Outcome = "ok";
  submit: Submit = "answered";
  tasksReadable = true;
  percentFull = 30;
  metadataPercentFull: number | null = 10;
  storageKey = "fake:fast";
  memoryStorage: SnapshotStorage | null = null;
  memoryWhy: string | null = null;
  locked: SnapshotPlan["locked"] = null;
  busy: string | null = null;
  takeWhy: string | null = null;
  gate: Promise<void> | null = null;
  running = 0;
  most = 0;
  stepsSeen: string[] = [];
  ledger: UnsettledSteps | null = null;
  #tasks = 0;

  storage(): SnapshotStorage {
    return { key: this.storageKey, name: "fast", type: "lvmthin", percentFull: this.percentFull, metadataPercentFull: this.metadataPercentFull, metadataUnread: null, totalBytes: 100 * GiB, usedBytes: (this.percentFull / 100) * 100 * GiB };
  }

  #task(guest: Guest, operation: TaskKind, id: string, outcome: TaskOutcome, now: number): string {
    const ref = `task-${++this.#tasks}`;
    this.tasks.set(ref, outcome);
    this.started.set(`${guest.ref}|${operation}|${id}`, { ref, at: now, operation });
    return ref;
  }

  attach(backend: FakeBackend, now: () => number, root: string | null = null): void {
    const target = backend as unknown as Record<string, unknown>;
    const homeOf = (ref: string) => (root ? join(root, backend.id, ref) : null);
    const savedOf = (id: string) => (root ? join(root, "saved", id) : null);
    const start = backend.start?.bind(backend);
    if (start) {
      target.start = async (guest: Guest, signal?: AbortSignal, timing?: (step: string, ms: number) => void, answered?: () => Promise<void>, readyWithinMs?: number) => {
        this.order.push(readyWithinMs === undefined ? "start" : `start within ${readyWithinMs / 1000} s`);
        return start(guest, signal, timing, answered);
      };
    }
    target.snapshotting = (): Snapshotting => ({ scope: "box", holds: ["disk", "disk-and-memory"], whileRunning: "live", restore: "in-place", fork: "copy", keepsPastRelease: this.keepWay, lives: "host", price: null, excludes: null });
    const release = backend.release.bind(backend);
    target.release = async (guest: Guest, hooks: never) => {
      await release(guest, hooks);
      for (const [id, held] of this.held) if (held.guest.ref === guest.ref && !this.earlier.has(guest.ref)) this.held.delete(id);
    };
    target.planSnapshots = async (_guest: Guest, _kind: string, snapshot: SnapshotRef | null): Promise<SnapshotPlan> => ({
      storage: this.storage(),
      take: {
        ok: this.takeWhy === null && this.busy === null,
        why: this.busy ?? this.takeWhy,
        aboutMs: 1000,
        memoryAboutMs: 5000,
        addsBytes: 0,
        memory: this.memoryWhy ? null : { storage: this.memoryStorage ?? this.storage(), addsBytes: (4096 * 2 + 500) * MiB },
        memoryWhy: this.memoryWhy,
      },
      restore: {
        way: this.restoreWay,
        why: this.restoreWhy,
        undo: this.restoreWay === "rollback" ? "snapshot" : this.restoreWay === "rollback-newest-only" ? "held-copy" : "none",
        undoAboutMs: 1000,
        undoBytes: 0,
        sizeBack: snapshot ? (this.sizes.get(snapshot.id) ?? null) : null,
        leavesOnEarlierGuest: 0,
        newer: this.newer,
        copyAboutMs: 2000,
      },
      keep: { way: this.keepWay, why: this.keepWhy, aboutMs: 2000, bytes: 16 * GiB, usedBytes: this.keepUsedBytes, price: null },
      fork: { ok: this.forkWhy === null, why: this.forkWhy, aboutMs: 2000, bytes: null, size: snapshot ? (this.sizes.get(snapshot.id) ?? null) : null },
      locked: this.locked,
      busy: this.busy,
    });
    target.snapshot = async (guest: Guest, take: { id: string; box: string; memory: boolean }, hooks: SnapshotHooks) => {
      this.running++;
      this.most = Math.max(this.most, this.running);
      try {
        await hooks.submitting();
        const submit = this.submit;
        this.submit = "answered";
        if (submit === "never-arrived") throw new Error("cannot reach the provider: connection reset before the request arrived");
        const outcome = this.take;
        this.take = "ok";
        const held: Held = { id: take.id, box: take.box, guest, state: outcome === "incomplete" ? "incomplete" : "complete", holds: take.memory ? "disk-and-memory" : "disk", takenAt: now(), keptUntil: null };
        if (outcome !== "failed") this.held.set(take.id, held);
        this.order.push(`take ${take.id}`);
        const home = homeOf(guest.ref);
        const saved = savedOf(take.id);
        if (outcome !== "failed" && home && saved && existsSync(home)) cpSync(home, saved, { recursive: true });
        const size = backend.sizeOf(guest.ref) ?? guest.size;
        if (size) this.sizes.set(take.id, size);
        const result: TaskOutcome =
          outcome === "failed" ? { state: "failed", words: "snapshot feature is not available" } : outcome === "incomplete" ? { state: "failed", words: "received interrupt" } : outcome === "ok-task-failed" ? { state: "failed", words: "vmstate save failed" } : { state: "ok" };
        const ref = this.#task(guest, "take", take.id, result, now());
        if (submit === "answer-lost") throw new Error("cannot reach the provider: timed out");
        await hooks.task({ ref, host: guest.host });
        this.stepsSeen.push(this.ledger?.unsettled().find((each) => each.snapshots.includes(take.id))?.step ?? "none");
        if (this.gate) await this.gate;
        if (outcome === "failed") throw new SnapshotFailed("snapshot feature is not available");
        if (outcome === "incomplete") throw new SnapshotIncomplete("Proxmox left it part-made (snapstate prepare): received interrupt.");
        if (outcome === "ok-task-failed") throw new SnapshotIncomplete("Proxmox's task failed (vmstate save failed), though it left the snapshot with no part-made state, so bb-box does not count it as taken.");
        if (outcome === "unknown") throw new Error("cannot reach the provider: timed out");
        return { ref: `bb${take.id}`, holds: held.holds, capturedAt: held.takenAt, size: null };
      } finally {
        this.running--;
      }
    };
    target.deleteSnapshot = async (ref: { id: string; guest: Guest }, hooks: SnapshotHooks) => {
      if (!this.held.has(ref.id)) return;
      await hooks.submitting();
      const submit = this.submit;
      this.submit = "answered";
      if (submit === "never-arrived") throw new Error("cannot reach the provider: connection reset before the request arrived");
      const outcome = this.remove;
      this.remove = "ok";
      let result: TaskOutcome;
      if (outcome === "failed") result = { state: "failed", words: "CT is locked (backup)" };
      else if (outcome === "incomplete") {
        this.held.get(ref.id)!.state = "incomplete";
        result = { state: "failed", words: "received interrupt" };
      } else {
        this.held.delete(ref.id);
        result = { state: "ok" };
      }
      const task = this.#task(ref.guest, "delete", ref.id, result, now());
      if (submit === "answer-lost") throw new Error("cannot reach the provider: timed out");
      await hooks.task({ ref: task, host: null });
      if (this.gate) await this.gate;
      if (outcome === "failed") throw new SnapshotFailed("CT is locked (backup)");
      if (outcome === "incomplete") throw new SnapshotIncomplete("Proxmox left it part-deleted (snapstate delete).");
      if (outcome === "unknown") throw new Error("cannot reach the provider: timed out");
    };
    target.powerOff = async (guest: Guest) => {
      this.order.push("power-off");
      const fault = this.powerOffFault;
      this.powerOffFault = null;
      if (fault) throw fault;
      await backend.stop!(guest);
    };
    target.rollbackSnapshot = async (guest: Guest, ref: SnapshotRef, hooks: SnapshotHooks) => {
      this.order.push(`rollback ${ref.id}`);
      if ((await backend.power(guest)) === "running") throw new SnapshotFailed(`Guest ${guest.ref} is running, and bb-box restores a guest only once it has stopped.`);
      if (!this.held.has(ref.id)) throw new SnapshotFailed(`Guest ${guest.ref} has no snapshot bb${ref.id}.`);
      const outcome = this.rollback;
      this.rollback = "ok";
      await hooks.submitting();
      if (outcome === "refused") throw new SnapshotFailed("CT is locked (backup)");
      const result: TaskOutcome = outcome === "failed" ? { state: "failed", words: "rollback interrupted" } : { state: "ok" };
      const task = this.#task(guest, "rollback", ref.id, result, now());
      if (outcome !== "failed") {
        const home = homeOf(guest.ref);
        const saved = savedOf(ref.id);
        if (home && saved && existsSync(saved)) {
          rmSync(home, { recursive: true, force: true });
          cpSync(saved, home, { recursive: true });
        }
        const size = this.sizes.get(ref.id);
        if (size) backend.setSize(guest.ref, size);
      }
      await hooks.task({ ref: task, host: guest.host });
      if (this.gate) await this.gate;
      if (outcome === "failed") throw new RestoreChanged("Proxmox's rollback task failed: rollback interrupted.");
      if (outcome === "unknown") throw new Error("cannot reach the provider: timed out");
    };
    target.outsideRollbacks = async (since: number): Promise<OutsideRollback[]> => {
      if (!this.tasksReadable) throw new Error("cannot reach the provider's task list: timed out");
      const own = [...this.started.entries()]
        .filter(([, task]) => task.operation === "rollback")
        .map(([key, task]): OutsideRollback => ({ task: { ref: task.ref, host: null }, guest: key.split("|")[0]!, user: "bb-box@pve!plugin", startedAt: task.at, outcome: this.tasks.get(task.ref) ?? { state: "missing", words: "" } }));
      return [...own, ...this.outside].filter((each) => each.startedAt >= since).sort((a, b) => a.startedAt - b.startedAt);
    };
    target.guestIdentity = async (guest: Guest): Promise<GuestIdentity> => ({ macs: { net0: `mac-of-${guest.data?.box ?? guest.ref}` }, smbios: null });
    target.copyGuest = async (source: Guest, label: HeldCopyLabel, hooks: CopyHooks): Promise<Guest> => {
      this.order.push(`copy ${source.ref}`);
      if ((await backend.power(source)) === "running") throw new SnapshotFailed(`Guest ${source.ref} is running, and bb-box copies a guest only once it has stopped.`);
      const copy: Guest = { ref: `copy${++this.#copies}`, host: source.host, address: null, size: source.size, data: { box: label.box } };
      await hooks.claimed(copy);
      await hooks.submitting();
      const fault = this.copyFault;
      this.copyFault = null;
      if (fault) throw fault;
      const task = this.#task(source, "copy", label.snapshot, { state: "ok" }, now());
      this.copies.set(copy.ref, { state: "copy", box: label.box, snapshot: label.snapshot, disarmed: false, takenAt: now() });
      const home = homeOf(source.ref);
      const saved = savedOf(copy.ref);
      if (home && saved && existsSync(home)) cpSync(home, saved, { recursive: true });
      await hooks.task({ ref: task, host: source.host });
      return copy;
    };
    target.copySnapshot = async (ref: SnapshotRef, label: HeldCopyLabel, hooks: CopyHooks): Promise<Guest> => {
      this.order.push(`copy-snapshot ${ref.id}`);
      if (!this.held.has(ref.id)) throw new SnapshotFailed(`Guest ${ref.guest.ref} has no snapshot bb${ref.id}.`);
      const copy: Guest = { ref: `copy${++this.#copies}`, host: ref.guest.host, address: null, size: this.sizes.get(ref.id) ?? ref.guest.size, data: { box: label.box } };
      await hooks.claimed(copy);
      await hooks.submitting();
      const fault = this.copyFault;
      this.copyFault = null;
      const task = this.#task(ref.guest, "copy", label.snapshot, fault ? { state: "failed", words: fault.message } : { state: "ok" }, now());
      if (!fault) this.copies.set(copy.ref, { state: "copy", box: label.box, snapshot: label.snapshot, disarmed: false, takenAt: label.takenAt ?? now(), kept: label.kept, forkSafe: label.forkSafe ?? null, of: ref.id });
      const saved = savedOf(ref.id);
      const into = savedOf(copy.ref);
      if (!fault && saved && into && existsSync(saved)) cpSync(saved, into, { recursive: true });
      await hooks.task({ ref: task, host: ref.guest.host });
      if (this.copyGate) await this.copyGate;
      if (fault) throw fault;
      return copy;
    };
    target.copyPlan = async (copy: Guest): Promise<CopyPlan> => {
      const held = this.copies.get(copy.ref);
      if (!held) return { state: "gone", size: null, running: false };
      return { state: held.state, size: this.sizes.get(held.of ?? held.snapshot) ?? { cores: 2, memoryMiB: 4096, diskGiB: 16 }, running: this.runningCopies.has(copy.ref) };
    };
    target.labelKept = async (ref: SnapshotRef, kept: string | null) => {
      this.labels.push(`${ref.from === "held-copy" ? `copy ${ref.guest.ref}` : `snapshot ${ref.id}`} kept ${kept ?? "none"}`);
      const fault = this.labelFault;
      this.labelFault = null;
      if (fault) throw fault;
      if (ref.from === "held-copy") {
        const held = this.copies.get(ref.guest.ref);
        if (!held) throw new SnapshotFailed(`Guest ${ref.guest.ref} is gone.`);
        held.kept = kept;
        return;
      }
      const held = this.held.get(ref.id);
      if (!held) throw new SnapshotFailed(`Guest ${ref.guest.ref} has no snapshot bb${ref.id}.`);
      held.keptUntil = kept ? Date.parse(`${kept}T00:00:00Z`) + 24 * 60 * 60_000 - 1 : null;
    };
    target.disarmCopy = async (copy: Guest) => {
      const held = this.copies.get(copy.ref);
      if (held) held.disarmed = true;
    };
    target.templateCopy = async (copy: Guest) => {
      this.order.push(`template ${copy.ref}`);
      const held = this.copies.get(copy.ref);
      if (held && this.copyTemplates) held.state = "template";
    };
    target.copyState = async (copy: Guest): Promise<CopyState> => this.copies.get(copy.ref)?.state ?? (this.earlier.has(copy.ref) ? "copy" : "gone");
    target.deleteCopy = async (copy: Guest) => {
      this.order.push(`delete ${copy.ref}`);
      if (!this.copies.has(copy.ref) && !this.earlier.has(copy.ref) && (await backend.power(copy)) !== null) throw new SnapshotFailed(`Guest ${copy.ref} is not a held copy or an earlier guest, so bb-box does not delete it as one.`);
      this.copies.delete(copy.ref);
      this.runningCopies.delete(copy.ref);
      if (this.earlier.has(copy.ref) || (await backend.power(copy)) !== null) {
        this.earlier.delete(copy.ref);
        for (const [id, held] of this.held) if (held.guest.ref === copy.ref) this.held.delete(id);
        await backend.release(copy, { timing: () => {}, resetting: async () => {} } as never);
      }
    };
    target.adoptCopy = async (copy: Guest, box: BoxIdentity, identity: GuestIdentity, hooks: CopyHooks): Promise<Guest> => {
      this.order.push(`adopt ${copy.ref} as ${identity.macs.net0}`);
      if (this.copies.get(copy.ref)?.state !== "template") throw new SnapshotFailed(`Guest ${copy.ref} is not a held copy bb-box can use.`);
      const fresh = await backend.makeGuest(box, savedOf(copy.ref));
      await hooks.claimed(fresh);
      await hooks.submitting();
      const task = this.#task(copy, "copy", fresh.ref, { state: "ok" }, now());
      await hooks.task({ ref: task, host: copy.host });
      return fresh;
    };
    target.forkSnapshot = async (ref: SnapshotRef, box: BoxIdentity, previous: Guest | null, hooks: AcquireHooks): Promise<Guest> => {
      this.order.push(`fork ${ref.id}`);
      if (previous && (await backend.power(previous)) !== null) await backend.release(previous, { timing: () => {}, resetting: async () => {} } as never);
      if (ref.from === "held-copy" ? this.copies.get(ref.guest.ref)?.state !== "template" : !this.held.has(ref.id)) throw new Error(`snapshot bb${ref.id} does not exist`);
      const saved = savedOf(ref.from === "held-copy" ? ref.guest.ref : ref.id);
      const fresh = await backend.makeGuest(box, saved && existsSync(saved) ? saved : null);
      await hooks.claim(fresh);
      const fault = this.forkFault;
      this.forkFault = null;
      if (fault) {
        await backend.release(fresh, { timing: () => {}, resetting: async () => {} } as never);
        throw fault;
      }
      await this.onForked?.(fresh, ref);
      return fresh;
    };
    target.armFork = async (guest: Guest, arming: string) => {
      this.order.push(`arm ${arming} ${guest.ref}`);
    };
    target.disarmFork = async (guest: Guest) => {
      backend.calls.push(`disarm ${guest.ref}`);
    };
    target.retireGuest = async (guest: Guest) => {
      this.order.push(`retire ${guest.ref}`);
      this.earlier.add(guest.ref);
      return guest;
    };
    target.heldSnapshots = async (): Promise<HeldSnapshot[]> => {
      if (this.listing) throw this.listing;
      const listed = [...this.held.values()].map((held) => ({
        id: held.id,
        ref: `bb${held.id}`,
        box: held.box,
        owner: { boxId: held.box, threadId: "thr_one", name: "gone-box", kind: "linux", createdAt: null },
        guest: held.guest,
        where: this.earlier.has(held.guest.ref) ? ("earlier" as const) : ("current" as const),
        state: held.state,
        words: held.state === "incomplete" ? "Proxmox left it part-made (snapstate prepare)." : null,
        holds: held.holds,
        takenAt: held.takenAt,
        keptUntil: held.keptUntil,
        storage: { name: "fast", type: "lvmthin" },
      }));
      const copied = [...this.copies.entries()].map(([ref, held]) => ({
        id: held.snapshot,
        ref,
        box: held.box,
        owner: { boxId: held.box, threadId: "thr_one", name: "gone-box", kind: "linux", createdAt: null },
        guest: { ref, host: null, address: null, size: null, data: { box: held.box } } as Guest,
        where: "held-copy" as const,
        state: held.state === "template" ? ("complete" as const) : ("incomplete" as const),
        words: held.state === "template" ? null : "Its copy is not a template yet, so bb-box does not trust it.",
        holds: "disk" as const,
        takenAt: held.takenAt,
        keptUntil: held.kept ? Date.parse(`${held.kept}T00:00:00Z`) + 24 * 60 * 60_000 - 1 : null,
        storage: null,
        forkSafe: held.forkSafe ?? null,
      }));
      if (this.listingGate) await this.listingGate;
      return [...listed, ...copied];
    };
    target.providerTask = async (task: TaskRef): Promise<TaskOutcome> => {
      if (!this.tasksReadable) throw new Error("cannot reach the provider's task list: timed out");
      return this.tasks.get(task.ref) ?? { state: "missing", words: `no task ${task.ref}` };
    };
    target.findTasks = async (guest: Guest, operation: TaskKind, since: number): Promise<TaskRef[]> => {
      if (!this.tasksReadable) throw new Error("cannot reach the provider's task list: timed out");
      return [...this.started.entries()]
        .filter(([key, task]) => key.startsWith(`${guest.ref}|${operation}|`) && task.at >= since - 5000 && (task.user ?? OWN_USER) === OWN_USER)
        .sort(([, a], [, b]) => a.at - b.at)
        .map(([, task]) => ({ ref: task.ref, host: guest.host }));
    };
  }
}
