import assert from "node:assert/strict";
import { test } from "node:test";
import { SnapshotFailed, type Guest, type SnapshotHooks } from "../src/backends/types.ts";
import type { BoxRecord } from "../src/core/boxes.ts";
import type { Caller } from "../src/core/snapshot.ts";
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
