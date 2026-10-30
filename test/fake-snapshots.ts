import { SnapshotFailed, SnapshotIncomplete, type Guest, type HeldSnapshot, type SnapshotHooks, type SnapshotPlan, type SnapshotStorage, type Snapshotting, type TaskOutcome, type TaskRef } from "../src/backends/types.ts";
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
export type Submit = "answered" | "answer-lost" | "never-arrived";

export interface UnsettledSteps {
  unsettled(): readonly { readonly snapshots: readonly string[]; readonly step: string }[];
}

const GiB = 2 ** 30;
const MiB = 2 ** 20;

export class FakeSnapshots {
  readonly held = new Map<string, Held>();
  readonly tasks = new Map<string, TaskOutcome>();
  readonly started = new Map<string, { readonly ref: string; readonly at: number; readonly operation: "take" | "delete" }>();
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

  #task(guest: Guest, operation: "take" | "delete", id: string, outcome: TaskOutcome, now: number): string {
    const ref = `task-${++this.#tasks}`;
    this.tasks.set(ref, outcome);
    this.started.set(`${guest.ref}|${operation}|${id}`, { ref, at: now, operation });
    return ref;
  }

  attach(backend: FakeBackend, now: () => number): void {
    const target = backend as unknown as Record<string, unknown>;
    const offer: Snapshotting = { scope: "box", holds: ["disk", "disk-and-memory"], whileRunning: "live", restore: "none", fork: "none", keepsPastRelease: "no", lives: "host", price: null, excludes: null };
    target.snapshotting = () => offer;
    target.planSnapshots = async (): Promise<SnapshotPlan> => ({
      storage: this.storage(),
      take: {
        ok: this.takeWhy === null,
        why: this.takeWhy,
        aboutMs: 1000,
        memoryAboutMs: 5000,
        addsBytes: 0,
        memory: this.memoryWhy ? null : { storage: this.memoryStorage ?? this.storage(), addsBytes: (4096 * 2 + 500) * MiB },
        memoryWhy: this.memoryWhy,
      },
      restore: { way: "none", why: null, undo: "none", undoAboutMs: 0, undoBytes: null, sizeBack: null, leavesOnEarlierGuest: 0 },
      keep: { way: "no", why: null, aboutMs: null, bytes: null, price: null },
      fork: { ok: false, why: null, aboutMs: 0, bytes: null },
      locked: this.locked,
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
    target.heldSnapshots = async (): Promise<HeldSnapshot[]> => {
      if (this.listing) throw this.listing;
      const listed = [...this.held.values()].map((held) => ({
        id: held.id,
        ref: `bb${held.id}`,
        box: held.box,
        owner: { boxId: held.box, threadId: "thr_one", name: "gone-box", kind: "linux", createdAt: null },
        guest: held.guest,
        where: "current" as const,
        state: held.state,
        words: held.state === "incomplete" ? "Proxmox left it part-made (snapstate prepare)." : null,
        holds: held.holds,
        takenAt: held.takenAt,
        keptUntil: held.keptUntil,
        storage: { name: "fast", type: "lvmthin" },
      }));
      if (this.listingGate) await this.listingGate;
      return listed;
    };
    target.providerTask = async (task: TaskRef): Promise<TaskOutcome> => {
      if (!this.tasksReadable) throw new Error("cannot reach the provider's task list: timed out");
      return this.tasks.get(task.ref) ?? { state: "missing", words: `no task ${task.ref}` };
    };
    target.findTasks = async (guest: Guest, operation: "take" | "delete", since: number): Promise<TaskRef[]> => {
      if (!this.tasksReadable) throw new Error("cannot reach the provider's task list: timed out");
      return [...this.started.entries()]
        .filter(([key, task]) => key.startsWith(`${guest.ref}|${operation}|`) && task.at >= since - 5000)
        .sort(([, a], [, b]) => a.at - b.at)
        .map(([, task]) => ({ ref: task.ref, host: guest.host }));
    };
  }
}
