import assert from "node:assert/strict";
import { test } from "node:test";
import { SnapshotFailed, type Backend, type Guest, type SnapshotHooks, type SnapshotRef, type TaskOutcome } from "../src/backends/types.ts";
import type { BoxRecord } from "../src/core/boxes.ts";
import type { Caller, SnapshotOperation } from "../src/core/snapshot.ts";
import { COMMAND, THREAD, armedWorld, readIn, readyBox, rejection, standing, untilHeld, untilStep, world, writeIn, type World } from "./snapshot-world.ts";

const AGENT: Caller = { is: "agent", threadId: THREAD };
const hang = (signal?: AbortSignal) => new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));

async function targetBox(state: World): Promise<BoxRecord> {
  const box = await readyBox(state);
  writeIn(state, box, "work.txt", "target");
  await state.snapshots.take(COMMAND, box, standing(box), { name: "target" });
  state.tick(60_000);
  writeIn(state, box, "work.txt", "latest");
  return box;
}

async function current(state: World, box: BoxRecord): Promise<BoxRecord> {
  return (await state.boxes.find(box.id))!;
}

async function heldAt(state: World, box: BoxRecord, step: NonNullable<World["holds"]["step"]>, target = "target", options: { undo?: boolean } = {}): Promise<void> {
  state.holds.step = step;
  const held = state.snapshots.restore(COMMAND, box, standing(box), target, options).catch((error: unknown) => error);
  await untilHeld(state, held);
  await state.restart();
  await held;
}

async function swapReady(state: World): Promise<{ box: BoxRecord; undo: string; old: Guest }> {
  state.undoByCopy = true;
  const box = await readyBox(state);
  writeIn(state, box, "work.txt", "one");
  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  writeIn(state, box, "work.txt", "before");
  const first = await state.snapshots.restore(COMMAND, box, standing(box), "one");
  writeIn(state, box, "work.txt", "after");
  const now = await current(state, box);
  return { box: now, undo: first.undo!.id, old: now.guest! };
}

const ZFS_ORDERS: readonly { readonly name: string; enter(state: World): void }[] = [
  {
    name: "on ZFS storage",
    enter: (state) => {
      state.provider.restoreWay = "rollback-newest-only";
    },
  },
  {
    name: "by the live-check switch",
    enter: (state) => {
      state.undoByCopy = true;
    },
  },
];

test("review A3: a rollback that fails before Proxmox gets it keeps no earlier task, and recovery rolls back rather than taking the undo's task for it", async () => {
  const state = world();
  const box = await targetBox(state);
  Object.assign(state.backend, {
    rollbackSnapshot: async () => {
      throw new Error("config read failed before the rollback was asked for");
    },
  });
  await rejection(state.snapshots.restore(COMMAND, box, standing(box), "target"));
  const operation = state.store.unsettled()[0]!;
  assert.equal(operation.step, "rollback-submitting");
  assert.equal(operation.task, null, "the undo's task is not left on the rollback's step");
  await state.restart();
  assert.equal(await state.snapshots.recover(), 1);
  assert.equal(state.store.operation(operation.id)!.state, "done");
  assert.equal(readIn(state, box, "work.txt"), "target", "the rollback ran");
});

test("review A3: a rollback whose request never arrived is not confirmed by another user's rollback just before it", async () => {
  const state = world();
  const box = await targetBox(state);
  state.provider.started.set(`${box.guest!.ref}|rollback|outside`, { ref: "outside-before-restore", at: state.now - 1000, operation: "rollback", user: "root@pam" });
  state.provider.tasks.set("outside-before-restore", { state: "ok" });
  Object.assign(state.backend, {
    rollbackSnapshot: async (_guest: Guest, _ref: unknown, hooks: SnapshotHooks) => {
      await hooks.submitting();
      throw new Error("the rollback request did not arrive");
    },
  });
  await rejection(state.snapshots.restore(COMMAND, box, standing(box), "target"));
  const operation = state.store.unsettled()[0]!;
  await state.restart();
  await state.snapshots.recover();
  assert.notEqual(state.store.operation(operation.id)!.task?.ref, "outside-before-restore");
  assert.equal(readIn(state, box, "work.txt"), "target", "it rolled back itself");
});

test("review A3: two tasks that could be the step's leave it unknown", async () => {
  const state = world();
  const box = await targetBox(state);
  Object.assign(state.backend, {
    rollbackSnapshot: async (guest: Guest, _ref: unknown, hooks: SnapshotHooks) => {
      await hooks.submitting();
      state.provider.started.set(`${guest.ref}|rollback|a`, { ref: "maybe-a", at: state.now, operation: "rollback" });
      state.provider.started.set(`${guest.ref}|rollback|b`, { ref: "maybe-b", at: state.now, operation: "rollback" });
      throw new Error("the answer was lost");
    },
  });
  await rejection(state.snapshots.restore(COMMAND, box, standing(box), "target"));
  const operation = state.store.unsettled()[0]!;
  await state.restart();
  assert.equal(await state.snapshots.recover(), 0);
  assert.equal(state.store.operation(operation.id)!.state, "unknown");
  assert.match(state.store.operation(operation.id)!.error!, /lists 2 tasks that could be this step's/);
});

test("review A1: recovery does not roll back once its undo is gone; it starts the box again as it was", async () => {
  const state = world();
  const box = await targetBox(state);
  await heldAt(state, box, "undo");
  const operation = state.store.unsettled()[0]!;
  state.provider.held.delete(operation.undo!);
  assert.equal(await state.snapshots.recover(), 1);
  assert.equal(readIn(state, box, "work.txt"), "latest", "nothing on its disk changed");
  assert.equal(state.store.operation(operation.id)!.state, "failed");
  assert.match(state.store.operation(operation.id)!.error!, /Its undo "before the restore at 10:43" was not there when BB Box went on with the restore/);
  assert.equal(state.store.record(operation.undo!)!.state, "lost");
  assert.equal((await current(state, box)).state, "ready");
  assert.equal((await current(state, box)).restoring ?? null, null);
});

test("review A4: the guard is read again before the stop, before the rollback, and before recovery goes on", async () => {
  const state = world();
  const box = await targetBox(state);
  const update = state.boxes.update.bind(state.boxes);
  Object.assign(state.boxes, {
    update: async (...args: Parameters<typeof update>) => {
      const result = await update(...args);
      if (result?.restoring) state.guard = { threads: [{ id: "late", title: "Late workspace", running: true }], threadsUnread: null, control: false, terminals: 0 };
      return result;
    },
  });
  const late = await rejection(state.snapshots.restore(COMMAND, box, standing(box), "target"));
  assert.match(late.message, /Since the restore was asked: box \S+ is a box threads run on: "Late workspace" \(working\) runs on it/);
  assert.equal(readIn(state, box, "work.txt"), "latest");
  assert.deepEqual(state.provider.order.filter((step) => step === "power-off"), [], "nothing stopped");
  Object.assign(state.boxes, { update });
  state.guard = { threads: [], threadsUnread: null, control: false, terminals: 0 };
  await heldAt(state, box, "undo");
  state.guard = { threads: [{ id: "new", title: "New idle workspace", running: false }], threadsUnread: null, control: true, terminals: 1 };
  assert.equal(await state.snapshots.recover(), 1);
  assert.equal(readIn(state, box, "work.txt"), "latest", "recovery did not roll back a box threads now run on");
  assert.equal(state.store.unsettled().length, 0);
  assert.equal((await current(state, box)).state, "ready");
  state.guard = { threads: [], threadsUnread: null, control: false, terminals: 1 };
  const forced = await heldAtWith(state, box, { force: true }, "undo");
  state.guard = { threads: [], threadsUnread: null, control: true, terminals: 1 };
  await state.snapshots.recover();
  assert.equal(state.store.operation(forced)!.state, "failed", "what --force allowed is not more than the person saw");
  assert.match(state.store.operation(forced)!.error!, /something more would go .*: a person holds control of its desktop/);
});

async function heldAtWith(state: World, box: BoxRecord, options: { force?: boolean }, step: NonNullable<World["holds"]["step"]>): Promise<string> {
  state.holds.step = step;
  const held = state.snapshots.restore(COMMAND, box, standing(box), "target", options).catch((error: unknown) => error);
  await untilHeld(state, held);
  const operation = state.store.unsettled().find((each) => each.kind === "restore")!.id;
  await state.restart();
  await held;
  return operation;
}

test("review A2 and Opus 1: a swap with an undo cut short at adopt-claimed keeps its undo's held copy, and finishes", async () => {
  const state = armedWorld();
  const { box, undo } = await swapReady(state);
  Object.assign(state.backend, { guestIdentity: (_guest: Guest, signal?: AbortSignal) => hang(signal) });
  const swapping = state.snapshots.restore(COMMAND, box, standing(box), undo).catch((error: unknown) => error);
  const operation = await untilStep(state, "adopt-claimed");
  assert.equal(operation.guests?.new ?? null, null, "no new guest is named before one is claimed");
  await state.restart();
  await swapping;
  assert.equal(await state.snapshots.recover(), 1);
  const second = state.store.record(operation.undo!)!;
  assert.equal(second.state, "ready");
  assert.ok(state.provider.copies.has(second.livesOn.ref), "the swap's own undo still exists");
  const after = await current(state, box);
  assert.equal(readIn(state, after, "work.txt"), "before");
  assert.equal(state.store.operation(operation.id)!.state, "done");
});

test("Opus 1: a swap whose new guest cannot be made keeps its undo, and with no snapshot on the old guest the state before it is still held", async () => {
  const state = armedWorld();
  const { box, undo } = await swapReady(state);
  await state.snapshots.delete(COMMAND, standing(box), "one");
  Object.assign(state.backend, {
    adoptCopy: async () => {
      throw new SnapshotFailed("Every VMID from 3240 to 3242 is in use.");
    },
  });
  const failed = await rejection(state.snapshots.restore(COMMAND, box, standing(box), undo));
  assert.match(failed.message, /Every VMID from 3240 to 3242 is in use\. Nothing on its disk changed/);
  const second = state.store.records({ box: box.id }).find((record) => record.undoOf && record.id !== undo)!;
  assert.ok(state.provider.copies.has(second.livesOn.ref), "the undo recorded ready still exists");
  assert.equal(readIn(state, await current(state, box), "work.txt"), "after");
});

test("Opus 1: a swap cut short at adopt-task discards only the half-made new guest, never a guest a snapshot lives on", async () => {
  const state = armedWorld();
  const { box, undo } = await swapReady(state);
  state.holds.step = "task";
  const held = state.snapshots.restore(COMMAND, box, standing(box), undo, { undo: false }).catch((error: unknown) => error);
  await untilHeld(state, held);
  const operation = state.store.unsettled().find((each) => each.kind === "restore")!;
  assert.equal(operation.step, "adopt-task");
  const made = operation.guests!.new!;
  await state.restart();
  await held;
  assert.equal(await state.snapshots.recover(), 1);
  assert.equal(await state.backend.power(made), null, "the half-made guest went");
  assert.ok(state.logs.some((line) => line.startsWith(`Deleted guest ${made.ref}, the new guest part made for the restore of box ${box.name}.`)));
  assert.ok(state.provider.copies.has(state.store.record(undo)!.livesOn.ref), "the held copy it was made from stays");
  assert.equal(readIn(state, await current(state, box), "work.txt"), "before");
});

for (const order of ZFS_ORDERS) test(`Opus 2: ZFS's order ${order.name} cut short at rollback-submitting goes on from its held copy, and makes no second one`, async () => {
  const state = armedWorld();
  order.enter(state);
  const box = await targetBox(state);
  Object.assign(state.backend, {
    rollbackSnapshot: async (_guest: Guest, _ref: unknown, hooks: SnapshotHooks, signal?: AbortSignal) => {
      await hooks.submitting();
      return hang(signal);
    },
  });
  const held = state.snapshots.restore(COMMAND, box, standing(box), "target").catch((error: unknown) => error);
  await untilStep(state, "rollback-submitting");
  await state.restart();
  await held;
  await state.snapshots.recover();
  assert.equal(state.provider.copies.size, 1, "one held copy for one undo");
  assert.equal(readIn(state, box, "work.txt"), "target");
});

test("review A5 and Opus 3: a held copy needs the box's identity reset now, and an undo's forkSafe is the disk it holds", async () => {
  const state = world({ markersOn: false });
  state.undoByCopy = true;
  const box = await targetBox(state);
  const refused = await rejection(state.snapshots.restore(COMMAND, box, standing(box), "target"));
  assert.match(refused.message, /makes such a copy only of a box whose identity reset works now/);
  assert.equal(state.provider.copies.size, 0);
  state.undoByCopy = false;
  const target = state.store.records({ box: box.id })[0]!;
  state.store.updateRecord(target.id, { forkSafe: 2 });
  const restored = await state.snapshots.restore(COMMAND, box, standing(box), "target");
  assert.equal(restored.undo?.forkSafe, null, "the undo holds the box's disk now, which had no working reset");
});

test("on ZFS, the check says the undo is a held copy; a box with no working identity reset gets none, and a person may restore it without an undo, by a rollback alone", async () => {
  const armed = armedWorld();
  armed.provider.restoreWay = "rollback-newest-only";
  const ready = await targetBox(armed);
  const check = await armed.snapshots.checkRestore(COMMAND, ready, standing(ready), "target");
  assert.equal(check.undo?.kind, "held-copy");

  const state = world({ markersOn: false });
  state.provider.restoreWay = "rollback-newest-only";
  const box = await targetBox(state);
  state.provider.order.length = 0;
  const refused = await rejection(state.snapshots.restore(COMMAND, box, standing(box), "target"));
  assert.match(refused.message, /makes such a copy only of a box whose identity reset works now/);
  assert.equal(state.provider.order.length, 0, "refused before the box stops");

  const restored = await state.snapshots.restore(COMMAND, box, standing(box), "target", { undo: false });

  assert.equal(restored.undo, null);
  assert.equal(state.provider.copies.size, 0);
  assert.deepEqual(state.provider.order.filter((step) => !step.startsWith("flush")), ["power-off", `rollback ${restored.snapshot!.id}`, "start"]);
  assert.equal(readIn(state, box, "work.txt"), "target");
});

test("on ZFS, a backend that cannot copy a box in full restores nothing, as its undo would be such a copy", async () => {
  const state = armedWorld();
  state.provider.restoreWay = "rollback-newest-only";
  const box = await targetBox(state);
  Object.assign(state.backend, { copyGuest: undefined });
  state.provider.order.length = 0;

  const refused = await rejection(state.snapshots.restore(COMMAND, box, standing(box), "target"));

  assert.match(refused.message, /restores only the newest snapshot, so the undo of a restore there is a full copy of the box, and Fake host cannot make one\. BB Box changed nothing\.$/);
  assert.equal(state.provider.order.length, 0, "refused before the box stops");
});

test("review A7: a box that was a thread's own machine, with no thread on it now, may be restored", async () => {
  const state = world();
  const box = await targetBox(state);
  const moved = (await state.boxes.update(box, () => ({ role: "machine" as const })))!;
  const answer = await state.snapshots.restore(COMMAND, moved, standing(moved), "target");
  assert.equal(answer.operation.state, "done");
});

test("review A8: no take while a restore BB Box could not confirm holds the box", async () => {
  const state = world();
  const box = await targetBox(state);
  state.provider.rollback = "unknown";
  await rejection(state.snapshots.restore(COMMAND, box, standing(box), "target"));
  const refused = await rejection(state.snapshots.take(COMMAND, box, standing(box), { name: "during" }));
  assert.equal(refused.code, "not_ready");
  assert.match(refused.message, /could not confirm the restore that began at/);
});

test("review A9: the access file is written once the box answers, before the backend runs any command of its own", async () => {
  const state = world();
  const box = await readyBox(state);
  writeIn(state, box, ".config/bb-box/env", "BB_STALE=from-before\n");
  await state.snapshots.take(COMMAND, box, standing(box), { name: "stale" });
  const start = state.backend.start!.bind(state.backend);
  let seenByBackend: string | null = null;
  Object.assign(state.backend, {
    start: async (guest: Guest, signal?: AbortSignal, timing?: (step: string, ms: number) => void, answered?: () => Promise<void>) =>
      start(guest, signal, timing, async () => {
        await answered?.();
        seenByBackend = readIn(state, box, ".config/bb-box/env");
      }),
  });
  await state.snapshots.restore(COMMAND, box, standing(box), "stale");
  assert.ok(seenByBackend !== null);
  assert.doesNotMatch(seenByBackend!, /BB_STALE/);
});

test("Opus 4: older undos go only once the restore is done, and --check names the one that would", async () => {
  const state = world();
  const box = await targetBox(state);
  await state.snapshots.restore(COMMAND, box, standing(box), "target");
  state.tick(60_000);
  await state.snapshots.restore(COMMAND, box, standing(box), "target");
  state.tick(60_000);
  const undos = () => state.store.records({ box: box.id }).filter((record) => record.undoOf).map((record) => record.name);
  const before = undos();
  assert.equal(before.length, 2);
  const check = await state.snapshots.checkRestore(COMMAND, box, standing(box), "target");
  assert.equal(check.replaces, before[0]);
  state.provider.rollback = "refused";
  await rejection(state.snapshots.restore(COMMAND, box, standing(box), "target"));
  assert.deepEqual(undos().slice(0, 2), before, "a refused rollback deleted no older undo");
});

test("Opus 5: a restoring mark never outlives its operation", async () => {
  const state = world();
  const box = await targetBox(state);
  await state.boxes.update(box, () => ({ restoring: { operation: "opgonegonegone", snapshot: "sngone", name: "gone", at: state.now, ran: true } }));
  await state.snapshots.recover();
  assert.equal((await current(state, box)).restoring ?? null, null);
  assert.ok(state.logs.some((line) => /Cleared box \S+'s mark of a restore to "gone": bb-box has no record of that restore/.test(line)));
  await state.boxes.start(THREAD, box.name).catch(() => undefined);
});

test("Opus 6: a held copy is restored by a swap with the live-check switch off, as the undo of a restore on ZFS is", async () => {
  const state = armedWorld();
  const { box, undo, old } = await swapReady(state);
  state.undoByCopy = false;

  const undone = await state.snapshots.restore(COMMAND, box, standing(box), undo, { undo: false });

  const after = await current(state, box);
  assert.equal(undone.operation.state, "done");
  assert.notEqual(after.guest!.ref, old.ref, "the box runs on a new guest made from its held copy");
  assert.equal(readIn(state, after, "work.txt"), "before");
});

test("Opus 8: restarts mid-task: an undo's task still running stays unknown, then finishes; a failed one puts the box back", async () => {
  const state = world();
  const box = await targetBox(state);
  await heldAt(state, box, "task");
  const operation = state.store.unsettled()[0]!;
  assert.equal(operation.step, "undo-task");
  state.provider.tasks.set(operation.task!.ref, { state: "running" });
  assert.equal(await state.snapshots.recover(), 0);
  assert.equal(state.store.operation(operation.id)!.state, "unknown");
  state.provider.tasks.set(operation.task!.ref, { state: "ok" });
  assert.equal(await state.snapshots.recover(), 1);
  assert.equal(readIn(state, box, "work.txt"), "target");
  writeIn(state, box, "work.txt", "latest");
  await heldAt(state, box, "task");
  const second = state.store.unsettled()[0]!;
  state.provider.tasks.set(second.task!.ref, { state: "failed", words: "snapshot feature is not available" });
  state.provider.held.delete(second.undo!);
  assert.equal(await state.snapshots.recover(), 1);
  assert.equal(state.store.operation(second.id)!.state, "failed");
  assert.equal(readIn(state, box, "work.txt"), "latest");
  assert.equal((await current(state, box)).state, "ready");
});

test("Opus 8: restarts mid-task: a rollback's task ended OK finishes; one that failed leaves the box stopped", async () => {
  const state = world();
  const box = await targetBox(state);
  await heldAt(state, box, "task", "target", { undo: false });
  const operation = state.store.unsettled()[0]!;
  assert.equal(operation.step, "rollback-task");
  assert.equal(await state.snapshots.recover(), 1);
  assert.equal(state.store.operation(operation.id)!.state, "done");
  assert.equal(readIn(state, box, "work.txt"), "target");
  writeIn(state, box, "work.txt", "latest");
  await heldAt(state, box, "task", "target", { undo: false });
  const second = state.store.unsettled()[0]!;
  state.provider.tasks.set(second.task!.ref, { state: "failed", words: "rollback interrupted" });
  assert.equal(await state.snapshots.recover(), 1);
  assert.equal(state.store.operation(second.id)!.state, "failed");
  assert.equal((await current(state, box)).state, "stopped");
});

for (const order of ZFS_ORDERS) test(`Opus 8: restarts mid-task in ZFS's order ${order.name}: a copy whose task began is deleted and made again`, async () => {
  const state = armedWorld();
  order.enter(state);
  const box = await targetBox(state);
  await heldAt(state, box, "task");
  const operation = state.store.unsettled()[0]!;
  assert.equal(operation.step, "copy-task");
  const first = state.store.record(operation.undo!)!.livesOn.ref;
  assert.equal(await state.snapshots.recover(), 1);
  assert.ok(!state.provider.copies.has(first), "the copy that was not yet a template went");
  const undo = state.store.record(operation.undo!)!;
  assert.equal(state.provider.copies.get(undo.livesOn.ref)?.state, "template");
  assert.equal(state.provider.copies.size, 1);
  assert.equal(readIn(state, box, "work.txt"), "target");
});

test("Opus 8: a swap whose earlier guest cannot be disarmed stays unknown, with the box stopped, and finishes at the next sweep", async () => {
  const state = armedWorld();
  const { box, undo } = await swapReady(state);
  const retire = (state.backend as unknown as { retireGuest: (guest: Guest) => Promise<Guest> }).retireGuest;
  let failures = 1;
  Object.assign(state.backend, {
    retireGuest: async (guest: Guest) => {
      if (failures-- > 0) throw new Error("cannot reach the provider: timed out");
      return retire(guest);
    },
  });
  await rejection(state.snapshots.restore(COMMAND, box, standing(box), undo, { undo: false }));
  const operation = state.store.unsettled()[0]!;
  assert.equal(operation.state, "unknown");
  assert.equal((await current(state, box)).state, "stopped");
  assert.equal(await state.snapshots.recover(), 1);
  assert.equal((await current(state, box)).state, "ready");
  assert.equal(state.provider.earlier.size, 1);
});

test("an agent's restore is refused where a person's would go with --force, at every recheck", async () => {
  const state = world();
  const box = await targetBox(state);
  state.guard = { threads: [], threadsUnread: null, control: false, terminals: 1 };
  assert.equal((await rejection(state.snapshots.restore(AGENT, box, standing(box), "target"))).code, "in_use");
});

async function bootStarts(state: World, box: BoxRecord): Promise<void> {
  await state.backend.start!((await current(state, box)).guest!);
}

function undosOf(state: World, box: BoxRecord) {
  return state.store.records({ box: box.id }).filter((record) => record.undoOf);
}

for (const order of [{ name: "by rollback", enter: (_state: World) => {} }, ...ZFS_ORDERS]) test(`G16 ${order.name}: a node that restarts after the stop starts the box at its boot, and recovery then takes no undo and restores nothing`, async () => {
  const state = armedWorld();
  order.enter(state);
  const box = await targetBox(state);
  await heldAt(state, box, "stopped");
  const operation = state.store.unsettled()[0]!;

  await bootStarts(state, box);
  assert.equal(await state.snapshots.recover(), 1);

  assert.equal(state.store.operation(operation.id)!.state, "failed");
  assert.match(state.store.operation(operation.id)!.error!, /started again before BB Box restored it/);
  assert.deepEqual(undosOf(state, box), []);
  assert.equal(readIn(state, box, "work.txt"), "latest");
  assert.equal((await current(state, box)).state, "ready");
});

const NODE_LOST_IT = "pve-1 restarted after Proxmox began task t1, and kept no record of it, so it is not running.";
const NODE_LOST_IT_TOO: TaskOutcome = { state: "lost", words: NODE_LOST_IT };
const FAILED_AS_THE_NODE_REBOOTED: TaskOutcome = { state: "failed", words: "unexpected status", nodeRestarted: true };

async function takeHeldAtItsTask(state: World, box: BoxRecord): Promise<SnapshotOperation> {
  state.holds.step = "task";
  const held = state.snapshots.take(COMMAND, box, standing(box), { name: "lost" }).catch((error: unknown) => error);
  await untilHeld(state, held);
  await state.restart();
  await held;
  return state.store.unsettled()[0]!;
}

for (const left of [
  { on: "a whole snapshot", provider: "complete", operation: "done", record: "ready" },
  { on: "a part-made snapshot", provider: "incomplete", operation: "failed", record: "incomplete" },
  { on: "no snapshot", provider: null, operation: "failed", record: "failed" },
] as const) {
  test(`G16: a take whose task the node lost, leaving ${left.on} on the guest, is settled by it`, async () => {
    const state = world();
    const box = await readyBox(state);
    const operation = await takeHeldAtItsTask(state, box);
    const id = operation.snapshots[0]!;

    state.provider.tasks.set(operation.task!.ref, NODE_LOST_IT_TOO);
    if (left.provider) state.provider.held.get(id)!.state = left.provider;
    else state.provider.held.delete(id);
    assert.equal(await state.snapshots.recover(), 1);

    assert.equal(state.store.operation(operation.id)!.state, left.operation);
    assert.equal(state.store.record(id)!.state, left.record);
    assert.equal(state.provider.held.has(id), left.provider !== null, "recovery deletes nothing the guest holds");
  });

  test(`G16: an undo whose task the node lost, leaving ${left.on}, is settled by it`, async () => {
    const state = world();
    const box = await targetBox(state);
    await heldAt(state, box, "task");
    const operation = state.store.unsettled()[0]!;
    assert.equal(operation.step, "undo-task");

    state.provider.tasks.set(operation.task!.ref, NODE_LOST_IT_TOO);
    if (left.provider) state.provider.held.get(operation.undo!)!.state = left.provider;
    else state.provider.held.delete(operation.undo!);
    assert.equal(await state.snapshots.recover(), 1);

    assert.equal(state.store.operation(operation.id)!.state, left.operation);
    assert.equal(state.store.record(operation.undo!)!.state, left.record);
    assert.equal(readIn(state, box, "work.txt"), left.provider === "complete" ? "target" : "latest");
    assert.equal((await current(state, box)).state, "ready");
  });
}

function rollbacksRun(state: World): number {
  return state.provider.order.filter((step) => step.startsWith("rollback ")).length;
}

async function rollbackCutShort(state: World, box: BoxRecord, outcome: TaskOutcome = NODE_LOST_IT_TOO): Promise<SnapshotOperation> {
  state.provider.rollback = "unknown";
  await rejection(state.snapshots.restore(COMMAND, box, standing(box), "target"));
  const cut = state.store.unsettled()[0]!;
  assert.equal(cut.step, "rollback-task");
  state.provider.tasks.set(cut.task!.ref, outcome);
  await state.restart();
  return cut;
}

const PART_RESTORED = /BB Box does not roll it back again on its own\. To use it, restore it to a snapshot again, or release it\. A new restore first takes a fresh undo, of this part-restored disk\.$/;

async function endsStoppedAndFailed(state: World, box: BoxRecord, operation: SnapshotOperation, why: RegExp, rollbacks: number): Promise<void> {
  const failed = state.store.operation(operation.id)!;
  assert.equal(failed.state, "failed");
  assert.match(failed.error!, why);
  assert.match(failed.error!, PART_RESTORED);

  const now = await current(state, box);
  assert.equal(now.state, "stopped");
  assert.equal(await state.backend.power(now.guest!), "stopped");
  assert.equal(now.restoring ?? null, null);
  assert.equal(rollbacksRun(state), rollbacks);

  await state.restart();
  assert.equal(await state.snapshots.recover(), 0);
  assert.equal(rollbacksRun(state), rollbacks, "no further rollback at a later sweep");
  assert.equal(await state.backend.power((await current(state, box)).guest!), "stopped");
}

test("with no node restart, a rollback task that failed is not rolled back again, at once or after BB Box restarts", async () => {
  const state = world();
  const box = await targetBox(state);
  state.provider.rollback = "failed";
  await rejection(state.snapshots.restore(COMMAND, box, standing(box), "target"));
  assert.equal(rollbacksRun(state), 1);
  assert.equal((await current(state, box)).state, "stopped");

  const cut = await rollbackCutShort(state, box, { state: "failed", words: "rollback interrupted" });
  assert.equal(await state.snapshots.recover(), 1);
  assert.equal(state.store.operation(cut.id)!.state, "failed");
  assert.match(state.store.operation(cut.id)!.error!, /^The rollback on .+ failed: rollback interrupted\.$/);
  assert.equal(rollbacksRun(state), 2, "one rollback for each restore");
  assert.equal((await current(state, box)).state, "stopped");
});

for (const cut of [
  { how: "lost by its node", outcome: NODE_LOST_IT_TOO, why: /^Its rollback was cut short when its node restarted: pve-1 restarted after Proxmox began task t1/ },
  { how: "failed as its node rebooted", outcome: FAILED_AS_THE_NODE_REBOOTED, why: /^Its rollback was cut short when its node restarted: unexpected status\./ },
  { how: "gone from Proxmox", outcome: { state: "missing", words: "Proxmox has no task t1." } as TaskOutcome, why: /no longer has the rollback's task, so BB Box cannot tell how it ended\./ },
]) {
  for (const boot of [{ nodeStartsIt: false }, { nodeStartsIt: true }]) {
    test(`G16: a rollback ${cut.how} is not rolled back again${boot.nodeStartsIt ? ", and the box its node started is stopped" : ""}: the restore fails and says what to do`, async () => {
      const state = world();
      const box = await targetBox(state);
      const operation = await rollbackCutShort(state, box, cut.outcome);
      if (boot.nodeStartsIt) await bootStarts(state, box);

      assert.equal(await state.snapshots.recover(), 1);

      await endsStoppedAndFailed(state, box, operation, cut.why, 1);
      assert.equal(state.store.record(operation.undo!)!.state, "ready", "its undo is kept");
    });
  }
}

test("G16: a box left part-restored, as when its rollback's task is gone for good, can be restored again, from a fresh undo, and keeps the undo of the restore that failed", async () => {
  const state = world();
  const box = await targetBox(state);
  const operation = await rollbackCutShort(state, box, { state: "missing", words: "Proxmox has no task t1." });
  for (let sweep = 0; sweep < 3; sweep++) await state.snapshots.recover();
  assert.equal(state.store.operation(operation.id)!.state, "failed");
  assert.equal(rollbacksRun(state), 1);
  writeIn(state, box, "work.txt", "part-restored");

  const again = await state.snapshots.restore(COMMAND, await current(state, box), standing(await current(state, box)), "target");

  assert.equal(again.operation.state, "done");
  assert.equal(readIn(state, box, "work.txt"), "target");
  assert.equal(state.store.record(operation.undo!)!.state, "ready");
  assert.equal(undosOf(state, box).length, 2);
});

for (const order of [{ name: "a snapshot", enter: (_state: World) => {} }, { name: "a held copy", enter: (state: World) => void (state.undoByCopy = true) }]) test(`G16: a rollback cut short whose undo, ${order.name}, is gone, and whose box the node started, is stopped and left stopped, never started as unchanged`, async () => {
  const state = armedWorld();
  order.enter(state);
  const box = await targetBox(state);
  const operation = await rollbackCutShort(state, box);
  const undo = state.store.record(operation.undo!)!;
  assert.equal(undo.guest, order.name === "a held copy" ? "held-copy" : "current");
  if (undo.guest === "held-copy") state.provider.copies.delete(undo.ref!);
  else state.provider.held.delete(undo.id);
  await bootStarts(state, box);

  assert.equal(await state.snapshots.recover(), 1);

  await endsStoppedAndFailed(state, box, operation, /^Its rollback was cut short when its node restarted/, 1);
  assert.doesNotMatch(state.boxLogs.join("\n") + state.log.events(box.id).map((event) => event.words).join("\n"), /Nothing on its disk changed/);
});

test("G16: a rollback cut short is not rolled back again, whatever the guard says, and the box the node started is stopped", async () => {
  const state = world();
  const box = await targetBox(state);
  const operation = await rollbackCutShort(state, box);
  await bootStarts(state, box);
  state.guard = { threads: [{ id: "late", title: "Late workspace", running: true }], threadsUnread: null, control: false, terminals: 0 };

  assert.equal(await state.snapshots.recover(), 1);

  await endsStoppedAndFailed(state, box, operation, /^Its rollback was cut short when its node restarted/, 1);
});

test("G16: a rollback cut short whose box runs and will not stop keeps its restore open and tries to stop it at each sweep, never rolling back again, and fails once it stops", async () => {
  const state = world();
  const box = await targetBox(state);
  const operation = await rollbackCutShort(state, box);
  await bootStarts(state, box);
  state.provider.powerOffFault = new Error("the guest would not stop");

  assert.equal(await state.snapshots.recover(), 0);

  const open = state.store.operation(operation.id)!;
  assert.equal(open.state, "unknown");
  assert.match(open.error!, /The box was running, and BB Box could not stop it: the guest would not stop\. BB Box keeps the restore open, so nothing starts the box, and tries to stop it again at each sweep\. You can release the box\./);
  assert.ok((await current(state, box)).restoring, "the box stays held");
  assert.equal(rollbacksRun(state), 1);

  assert.equal(await state.snapshots.recover(), 1);

  await endsStoppedAndFailed(state, box, operation, /^Its rollback was cut short when its node restarted/, 1);
});

test("G16: while BB Box cannot read whether the box runs, its restore stays open at every sweep with no rollback, and release ends it", async () => {
  const state = world();
  const box = await targetBox(state);
  const operation = await rollbackCutShort(state, box);
  Object.assign(state.backend, {
    power: async () => {
      throw new Error("cannot reach the provider: timed out");
    },
  });

  for (const sweep of [1, 2, 3]) {
    assert.equal(await state.snapshots.recover(), 0, `sweep ${sweep}`);
    assert.equal(state.store.operation(operation.id)!.state, "unknown");
    assert.match(state.store.operation(operation.id)!.error!, /BB Box could not read whether the box runs\. .+You can release the box\./);
    assert.equal(rollbacksRun(state), 1);
  }

  await state.restart();
  await state.boxes.release(THREAD, box.name, "done with it");
  await state.boxes.settled(box);
  await state.snapshots.recover();

  assert.equal(await state.boxes.find(box.id), null);
  assert.equal(state.store.unsettled().filter((open) => open.id === operation.id).length, 0);
});

test("G16: a delete whose task the node lost, with the snapshot still on the guest, is deleted again, as one Proxmox has no record of", async () => {
  const state = world();
  const box = await readyBox(state);
  const taken = await state.snapshots.take(COMMAND, box, standing(box), { name: "old" });
  const id = taken.snapshot!.id;
  const held = { ...state.provider.held.get(id)! };
  state.provider.remove = "unknown";
  await state.snapshots.delete(COMMAND, standing(box), id).catch(() => {});
  const operation = state.store.unsettled()[0]!;
  assert.equal(operation.kind, "delete");
  state.provider.tasks.set(operation.task!.ref, NODE_LOST_IT_TOO);
  state.provider.held.set(id, held);
  await state.restart();

  assert.equal(await state.snapshots.recover(), 1);

  assert.equal(state.provider.held.has(id), false);
  assert.equal(state.store.unsettled().length, 0);
});

test("G16: a rollback made outside BB Box whose task the node lost is not logged, as one Proxmox has no record of", async () => {
  const state = world();
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  await state.snapshots.restore(COMMAND, box, standing(box), "one");
  const at = state.now;

  state.provider.outside.push({ task: { ref: "UPID:lost", host: "pve-1" }, guest: box.guest!.ref, user: "root@pam", startedAt: at + 60_000, outcome: NODE_LOST_IT_TOO });
  state.tick(5 * 60_000);
  await state.snapshots.sweep();

  assert.deepEqual(state.log.events(box.id).filter((event) => event.by.is === "outside").map((event) => event.kind), []);
});

function rollbackListings(state: World): [string, FakeTaskListing][] {
  return [...state.provider.started.entries()].filter(([key]) => key.includes("|rollback|"));
}

type FakeTaskListing = World["provider"]["started"] extends Map<string, infer Listing> ? Listing : never;

function forgetRollbackListings(state: World): void {
  for (const [key] of rollbackListings(state)) state.provider.started.delete(key);
}

function answerLostOnceProxmoxAccepts(state: World): void {
  const submit = (state.backend as unknown as Required<Pick<Backend, "rollbackSnapshot">>).rollbackSnapshot;
  Object.assign(state.backend, {
    rollbackSnapshot: async (guest: Guest, ref: SnapshotRef, hooks: SnapshotHooks, signal?: AbortSignal) => {
      await submit(guest, ref, { submitting: hooks.submitting, task: async () => {} }, signal);
      throw new Error("the connection closed before Proxmox answered");
    },
  });
}

async function firstAnswerLost(state: World, box: BoxRecord): Promise<SnapshotOperation> {
  answerLostOnceProxmoxAccepts(state);
  await rejection(state.snapshots.restore(COMMAND, box, standing(box), "target"));
  const operation = state.store.unsettled()[0]!;
  assert.equal(operation.step, "rollback-submitting");
  assert.equal(operation.task, null);
  forgetRollbackListings(state);
  await state.restart();
  return operation;
}

for (const boot of [{ nodeStartsIt: false }, { nodeStartsIt: true }]) test(`with no node restart, an unanswered first rollback is sent once more, as before; when that answer is lost too there is no third${boot.nodeStartsIt ? ", and the box its node started is stopped" : ""}`, async () => {
  const state = world();
  const box = await targetBox(state);
  const operation = await firstAnswerLost(state, box);

  answerLostOnceProxmoxAccepts(state);
  assert.equal(await state.snapshots.recover(), 0);
  assert.equal(rollbacksRun(state), 2);
  assert.equal(state.store.operation(operation.id)!.state, "unknown");
  forgetRollbackListings(state);
  await state.restart();
  if (boot.nodeStartsIt) await bootStarts(state, box);

  assert.equal(await state.snapshots.recover(), 1);

  await endsStoppedAndFailed(state, box, operation, /^BB Box had no answer to its rollback and found no task for it, so it cannot tell whether a rollback began\./, 2);
});

test("an unanswered first rollback sent once more, whose task is then gone, does not leave a box its node started running", async () => {
  const state = world();
  const box = await targetBox(state);
  const operation = await firstAnswerLost(state, box);

  state.provider.rollback = "unknown";
  assert.equal(await state.snapshots.recover(), 0);
  const second = state.store.operation(operation.id)!;
  assert.equal(second.step, "rollback-task");
  state.provider.tasks.set(second.task!.ref, { state: "missing", words: `Proxmox has no task ${second.task!.ref}.` });
  await state.restart();
  await bootStarts(state, box);

  assert.equal(await state.snapshots.recover(), 1);

  await endsStoppedAndFailed(state, box, operation, /no longer has the rollback's task/, 2);
});

test("an unanswered first rollback is not sent again when its box is running, as its node restarted and started it: the box is stopped", async () => {
  const state = world();
  const box = await targetBox(state);
  const operation = await firstAnswerLost(state, box);
  await bootStarts(state, box);

  assert.equal(await state.snapshots.recover(), 1);

  await endsStoppedAndFailed(state, box, operation, /^Box \S+ started again while BB Box had no answer to its rollback, as a node that restarts starts its boxes\./, 1);
});

test("a restore's recorded rollback stays BB Box's own after the restore fails: it is not reported as made outside it, though Proxmox still lists it", async () => {
  const state = world();
  const box = await targetBox(state);
  const operation = await rollbackCutShort(state, box, FAILED_AS_THE_NODE_REBOOTED);
  const [[, first]] = rollbackListings(state) as [[string, FakeTaskListing]];
  assert.equal(first.ref, operation.task!.ref);

  assert.equal(await state.snapshots.recover(), 1);
  assert.equal(state.store.operation(operation.id)!.state, "failed");
  assert.equal(state.store.operationWithTask(first.ref)?.id, operation.id);

  state.tick(5 * 60_000);
  await state.snapshots.sweep();

  assert.deepEqual(outsideEvents(state, box), []);
});

function outsideEvents(state: World, box: BoxRecord): string[] {
  return state.log.events(box.id).filter((event) => event.by.is === "outside").map((event) => event.kind);
}

async function twoRequestsTheFirstListedLate(state: World, box: BoxRecord): Promise<{ operation: SnapshotOperation; first: FakeTaskListing }> {
  answerLostOnceProxmoxAccepts(state);
  await rejection(state.snapshots.restore(COMMAND, box, standing(box), "target"));
  const operation = state.store.unsettled()[0]!;
  const late = rollbackListings(state);
  assert.equal(late.length, 1, "Proxmox ran the first request");
  forgetRollbackListings(state);
  await state.restart();

  assert.equal(await state.snapshots.recover(), 1);
  assert.equal(rollbacksRun(state), 2, "the second request was sent and answered");
  assert.equal(state.store.operation(operation.id)!.state, "done");

  const [[key, first]] = late as [[string, FakeTaskListing]];
  state.provider.started.set(key, first);
  state.provider.tasks.set(first.ref, { state: "failed", words: "rollback interrupted" });
  return { operation, first };
}

test("both of a restore's rollback requests are BB Box's own, though the first's answer was lost and Proxmox lists its task only after the second ended", async () => {
  const state = world();
  const box = await targetBox(state);
  await twoRequestsTheFirstListedLate(state, box);

  state.tick(5 * 60_000);
  await state.snapshots.sweep();

  assert.deepEqual(outsideEvents(state, box), []);
});

test("another user's rollback in the time of a restore's unanswered request is still reported as made outside BB Box", async () => {
  const state = world();
  const box = await targetBox(state);
  const { first } = await twoRequestsTheFirstListedLate(state, box);
  state.provider.started.clear();
  state.provider.outside.push({ task: { ref: "UPID:by-root", host: "pve-1" }, guest: box.guest!.ref, user: "root@pam", startedAt: first.at, outcome: { state: "failed", words: "rollback interrupted" }, ours: false });

  state.tick(5 * 60_000);
  await state.snapshots.sweep();

  assert.deepEqual(outsideEvents(state, box), ["restore-outside-failed"]);
});

const ITS_TASK_GONE: TaskOutcome = { state: "missing", words: "Proxmox has no task t1." };

async function heldAsItCouldNotStop(state: World, box: BoxRecord): Promise<SnapshotOperation> {
  const operation = await rollbackCutShort(state, box, ITS_TASK_GONE);
  await bootStarts(state, box);
  state.provider.powerOffFault = new Error("the guest would not stop");

  assert.equal(await state.snapshots.recover(), 0);

  assert.equal(state.store.operation(operation.id)!.state, "unknown");
  assert.equal(await state.backend.power((await current(state, box)).guest!), "running");
  return operation;
}

for (const later of [
  { reads: "OK", seen: (state: World, ref: string) => void state.provider.tasks.set(ref, { state: "ok" }) },
  { reads: "still running", seen: (state: World, ref: string) => void state.provider.tasks.set(ref, { state: "running" }) },
  { reads: "failed", seen: (state: World, ref: string) => void state.provider.tasks.set(ref, { state: "failed", words: "rollback interrupted" }) },
  {
    reads: "unreadable",
    seen: (state: World) => {
      state.provider.tasksReadable = false;
    },
  },
]) {
  test(`a restore held because BB Box could not stop its box only stops it and fails at a later sweep, after BB Box restarts, though its rollback's task now reads ${later.reads}`, async () => {
    const state = world();
    const box = await targetBox(state);
    const operation = await heldAsItCouldNotStop(state, box);

    later.seen(state, operation.task!.ref);
    await state.restart();
    assert.equal(await state.snapshots.recover(), 1);

    await endsStoppedAndFailed(state, box, operation, /no longer has the rollback's task/, 1);
  });
}

function stopsTried(state: World): number {
  return state.provider.order.filter((step) => step === "power-off").length;
}

function snapshotListingFails(state: World): void {
  Object.assign(state.backend, {
    heldSnapshots: async () => {
      throw new Error("cannot reach the provider: timed out");
    },
  });
}

async function stillHeldAndRunning(state: World, box: BoxRecord, operation: SnapshotOperation): Promise<void> {
  assert.equal(state.store.operation(operation.id)!.state, "unknown");
  assert.ok((await current(state, box)).restoring, "the box stays held");
  assert.equal(await state.backend.power((await current(state, box)).guest!), "running");
}

test("a restore held because BB Box could not stop its box tries to stop it at each sweep, and fails once it reads stopped, while the backend's snapshots cannot be listed", async () => {
  const state = world();
  const box = await targetBox(state);
  const operation = await heldAsItCouldNotStop(state, box);
  await state.restart();
  snapshotListingFails(state);
  const before = stopsTried(state);

  state.provider.powerOffFault = new Error("the guest would not stop");
  assert.equal(await state.snapshots.recover(), 0);
  assert.equal(stopsTried(state), before + 1);
  await stillHeldAndRunning(state, box, operation);

  await state.restart();
  snapshotListingFails(state);
  state.provider.powerOffFault = new Error("the guest would not stop");
  assert.equal(await state.snapshots.recover(), 0);
  assert.equal(stopsTried(state), before + 2);
  await stillHeldAndRunning(state, box, operation);

  assert.equal(await state.snapshots.recover(), 1);
  assert.equal(stopsTried(state), before + 3);

  await endsStoppedAndFailed(state, box, operation, /no longer has the rollback's task/, 1);
});

function starts(state: World): number {
  return state.provider.order.filter((step) => step.startsWith("start")).length;
}

test("a restore held because BB Box could not read its box's power is never started, though its rollback's task later reads OK", async () => {
  const state = world();
  const box = await targetBox(state);
  const operation = await rollbackCutShort(state, box, ITS_TASK_GONE);
  Object.assign(state.backend, {
    power: async () => {
      throw new Error("cannot reach the provider: timed out");
    },
  });
  assert.equal(await state.snapshots.recover(), 0);
  assert.equal(state.store.operation(operation.id)!.state, "unknown");
  const startsBefore = starts(state);

  state.provider.tasks.set(operation.task!.ref, { state: "ok" });
  await state.restart();
  assert.equal(await state.snapshots.recover(), 1);

  assert.equal(starts(state), startsBefore, "BB Box started nothing");
  await endsStoppedAndFailed(state, box, operation, /no longer has the rollback's task/, 1);
});

function afterTheFirstStoppedRead(state: World, then: (guest: Guest) => Promise<void>): void {
  const read = state.backend.power.bind(state.backend);
  let armed = true;
  Object.assign(state.backend, {
    power: async (guest: Guest) => {
      const power = await read(guest);
      if (armed && power === "stopped") {
        armed = false;
        await then(guest);
      }
      return power;
    },
  });
}

for (const final of [
  {
    reads: "running, as the node started it",
    words: /BB Box found the box running when it went to end the restore\./,
    then: (state: World) => async (guest: Guest) => {
      await state.backend.start!(guest);
    },
  },
  {
    reads: "nothing, as BB Box could not read it",
    words: /BB Box could not read whether the box runs\./,
    then: (state: World) => async () => {
      const read = state.backend.power;
      Object.assign(state.backend, {
        power: async (guest: Guest) => {
          Object.assign(state.backend, { power: read });
          throw new Error(`cannot reach the provider for ${guest.ref}: timed out`);
        },
      });
    },
  },
]) {
  test(`a part-restored box whose last power read says ${final.reads} keeps its hold and is stopped at the next sweep, never left ready`, async () => {
    const state = world();
    const box = await targetBox(state);
    const operation = await rollbackCutShort(state, box, ITS_TASK_GONE);
    afterTheFirstStoppedRead(state, final.then(state));

    assert.equal(await state.snapshots.recover(), 0);

    const open = state.store.operation(operation.id)!;
    assert.equal(open.state, "unknown");
    assert.match(open.error!, final.words);
    assert.match(open.error!, /BB Box keeps the restore open, so nothing starts the box, and tries to stop it again at each sweep\. You can release the box\./);
    const held = await current(state, box);
    assert.ok(held.restoring, "the box stays held");
    assert.notEqual(held.state, "ready");

    assert.equal(await state.snapshots.recover(), 1);

    await endsStoppedAndFailed(state, box, operation, /no longer has the rollback's task/, 1);
  });
}

test("with no node restart, a first rollback whose answer never came and whose task cannot be found is asked for again, and a refusal then puts the box back, as before", async () => {
  const state = world();
  const box = await targetBox(state);
  Object.assign(state.backend, {
    rollbackSnapshot: async (_guest: Guest, _ref: SnapshotRef, hooks: SnapshotHooks) => {
      await hooks.submitting();
      throw new Error("the connection closed before Proxmox answered");
    },
  });
  await rejection(state.snapshots.restore(COMMAND, box, standing(box), "target"));
  const operation = state.store.unsettled()[0]!;
  assert.equal(operation.step, "rollback-submitting");
  await state.restart();

  state.provider.rollback = "refused";
  assert.equal(await state.snapshots.recover(), 1);

  const failed = state.store.operation(operation.id)!;
  assert.equal(failed.state, "failed");
  assert.match(failed.error!, /refused the rollback: CT is locked \(backup\)/);
  assert.equal(readIn(state, box, "work.txt"), "latest");
  assert.equal((await current(state, box)).state, "ready");
});
