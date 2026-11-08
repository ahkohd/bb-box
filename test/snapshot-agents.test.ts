import assert from "node:assert/strict";
import { test } from "node:test";
import { BY_COMMAND } from "../src/core/box-log.ts";
import { OPERATOR, type BoxRecord } from "../src/core/boxes.ts";
import { emptyDocument, type ConfigDocument } from "../src/core/document.ts";
import { setOptions } from "../src/plugin/config-edits.ts";
import { TurnHold } from "../src/plugin/turn-hold.ts";
import type { Caller } from "../src/core/snapshot.ts";
import { YesNeeded } from "../src/core/snapshots.ts";
import { COMMAND, THREAD, readyBox, rejection, standing, world, type World } from "./snapshot-world.ts";

const AGENT: Caller = { is: "agent", threadId: THREAD };
const OTHER_AGENT: Caller = { is: "agent", threadId: "thr_two" };
const IDLE = { id: "thr_idle", title: "Write the API guide", running: false };
const WORKING = { id: "thr_busy", title: "Fix the sign-in flow", running: true };

function onMachine(box: BoxRecord) {
  return { ...standing(box), runsOn: true };
}

async function current(state: World, box: BoxRecord): Promise<BoxRecord> {
  return (await state.boxes.find(box.id))!;
}

test("an agent's take past the limit deletes the oldest an agent of its thread took and nobody kept, once the new one is ready; never another thread's, a kept one or the person's", async () => {
  const state = world();
  state.settings = { perBox: 3 };
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "the person's" });
  state.tick(60_000);
  await state.snapshots.take(OTHER_AGENT, box, onMachine(box), { name: "another thread's" });
  state.tick(60_000);
  await state.snapshots.take(AGENT, box, standing(box), { name: "first" });
  state.tick(60_000);
  const fourth = await state.snapshots.take(AGENT, box, standing(box), { name: "second" });
  assert.deepEqual(fourth.evicted && fourth.evicted.name, "first");
  assert.equal(fourth.counted, 3);
  assert.deepEqual(state.store.records({ box: box.id }).map((record) => record.name).sort(), ["another thread's", "second", "the person's"]);
  const deleted = state.log.events(box.id).find((event) => event.kind === "snapshot-deleted")!;
  assert.equal(deleted.by.is, "bb-box");
  assert.match((deleted.by as { why: string }).why, /^the limit of 3 snapshots a box: the agent's new snapshot "second" took its place$/);
  state.tick(60_000);
  const second = state.store.records({ box: box.id }).find((record) => record.name === "second")!;
  state.store.updateRecord(second.id, { keptUntil: state.now + 1000, owner: "person" });
  const refused = await rejection(state.snapshots.take(AGENT, box, standing(box), { name: "third" }));
  assert.equal(refused.code, "limit_reached");
  assert.match(refused.message, /None of them is one an agent of this thread took and nobody kept, which bb-box would delete for a new one\. Delete one first: /);
  assert.equal((await rejection(state.snapshots.take(COMMAND, box, standing(box), { name: "the person's second" }))).code, "limit_reached", "the person's take past the limit is refused, never evicting");
  assert.equal(state.store.records({ box: box.id }).length, 3);
});

test("a take or a restore refused only for now says try_again: a host's storage too full, or a task holding the guest's lock", async () => {
  const state = world();
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  state.provider.percentFull = 90;
  const full = await rejection(state.snapshots.take(AGENT, box, standing(box)));
  assert.equal(full.code, "try_again");
  assert.match(full.message, /is 90% full, and your settings take no snapshot past 85%/);
  state.provider.percentFull = 30;
  state.provider.busy = "Proxmox is running a backup on guest 214, which holds its lock (backup). Try again when it ends.";
  const take = await rejection(state.snapshots.take(AGENT, box, standing(box)));
  assert.equal(take.code, "try_again");
  assert.equal(take.message, `bb-box cannot take a snapshot of box ${box.name} now: Proxmox is running a backup on guest 214, which holds its lock (backup). Try again when it ends.`);
  const restore = await rejection(state.snapshots.restore(AGENT, box, standing(box), "one"));
  assert.equal(restore.code, "try_again");
  assert.match(restore.message, /^BB Box cannot restore box \S+ now: Proxmox is running a backup/);
  assert.deepEqual(state.provider.order.filter((step) => step === "power-off"), [], "nothing stopped");
});

test("a box threads run on stays unrestored for everyone until machine restores are on; then the person restores it naming each thread, always with an undo and never from memory", async () => {
  const state = world();
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  await state.snapshots.take(COMMAND, box, standing(box), { name: "with memory", memory: true });
  state.guard = { threads: [IDLE], threadsUnread: null, control: false, terminals: 0 };
  for (const caller of [COMMAND, AGENT]) {
    const off = await rejection(state.snapshots.restore(caller, box, standing(box), "one", caller.is === "agent" ? {} : { force: true }));
    assert.equal(off.code, "in_use");
    assert.match(off.message, /stays off until BB Box can hold every turn on it while it restores/);
  }
  state.machineRestores = true;
  const unforced = await rejection(state.snapshots.restore(COMMAND, box, standing(box), "one"));
  assert.match(unforced.message, /would end what is on it now: "Write the API guide" runs on it: its worktree, uncommitted files and session there go\. Restore anyway with --force\./);
  assert.match((await rejection(state.snapshots.restore(COMMAND, box, standing(box), "one", { force: true, undo: false }))).message, /always takes an undo before it restores a box threads run on/);
  assert.match((await rejection(state.snapshots.restore(COMMAND, box, standing(box), "with memory", { force: true }))).message, /restored from disk snapshots only/);
  assert.deepEqual(state.provider.order.filter((step) => step === "power-off"), [], "nothing stopped while refused");
  const restored = await state.snapshots.restore(COMMAND, box, standing(box), "one", { force: true });
  assert.ok(restored.undo, "an undo was taken");
  assert.deepEqual(restored.anyway, ['"Write the API guide" runs on it: its worktree, uncommitted files and session there go']);
  assert.ok(state.marksChanged >= 2, "the turn hold was told when the mark came and went");
});

test("G17 in the engine: a turn running on a box threads run on refuses the restore before the stop; one that starts as it stops brings the box back with nothing changed", async () => {
  const state = world();
  state.machineRestores = true;
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  state.guard = { threads: [IDLE, WORKING], threadsUnread: null, control: false, terminals: 0 };
  state.provider.order.length = 0;
  const working = await rejection(state.snapshots.restore(COMMAND, box, standing(box), "one", { force: true }));
  assert.match(working.message, /a turn runs on it now: "Fix the sign-in flow" \(working\) is working there, and BB Box changes a box threads run on only while no turn runs on it\./);
  assert.match(working.message, /BB Box changed nothing\.$/);
  assert.deepEqual(state.provider.order, [], "refused before the stop");
  Object.defineProperty(state, "guard", {
    configurable: true,
    get: () => ({ threads: [IDLE, { ...WORKING, running: state.provider.order.includes("power-off") }], threadsUnread: null, control: false, terminals: 0 }),
  });
  const startedAsItStopped = await rejection(state.snapshots.restore(COMMAND, box, standing(box), "one", { force: true }));
  assert.match(startedAsItStopped.message, /a turn runs on it now: "Fix the sign-in flow" \(working\)/);
  assert.match(startedAsItStopped.message, /Nothing on its disk changed, and bb-box started box \S+ again as it was\.$/);
  assert.deepEqual(state.provider.order, ["power-off", "start"], "stopped, found the turn, started again: no undo, no rollback");
  assert.equal((await current(state, box)).state, "ready");
  assert.equal((await current(state, box)).restoring ?? null, null);
  assert.equal(state.store.records({ box: box.id }).length, 1, "the undo's record went with the restore");
  assert.ok(state.log.events(box.id).some((event) => event.kind === "restore-failed" && /At the stop: a turn runs on it now/.test(event.words ?? "")));
});

test("an agent's restore of a box threads run on, or of its own box with its restores off, needs a yes bound to the plan it showed: none or a stale one asks, the right one restores with its undo, logged as given in the thread", async () => {
  const state = world();
  state.machineRestores = true;
  const box = await readyBox(state);
  await state.snapshots.take(AGENT, box, onMachine(box), { name: "one" });
  state.guard = { threads: [{ id: THREAD, title: "Asks", running: false }], threadsUnread: null, control: false, terminals: 0 };
  state.provider.order.length = 0;
  const asked = await rejection(state.snapshots.restore(AGENT, box, onMachine(box), "one"));
  assert.ok(asked instanceof YesNeeded);
  assert.equal(asked.asks, "machine");
  assert.equal(asked.changed, false);
  assert.deepEqual(asked.check.anyway, ['"Asks" runs on it: its worktree, uncommitted files and session there go']);
  assert.equal(asked.check.undo?.kind, "snapshot");
  const plan = asked.check.plan;
  state.guard = { threads: [{ id: THREAD, title: "Asks", running: false }], threadsUnread: null, control: false, terminals: 1 };
  const stale = await rejection(state.snapshots.restore(AGENT, box, onMachine(box), "one", { yes: { thread: THREAD, title: "Asks", plan, at: state.now } }));
  assert.ok(stale instanceof YesNeeded && stale.changed, "a terminal opened since: it asks again");
  assert.notEqual(stale.check.plan, plan);
  assert.deepEqual(state.provider.order, [], "nothing changed");
  const yes = { thread: THREAD, title: "Asks", plan: stale.check.plan, at: state.now };
  const restored = await state.snapshots.restore(AGENT, box, onMachine(box), "one", { yes });
  assert.ok(restored.undo);
  assert.equal(restored.undo!.by.is, "agent");
  const kinds = state.log.events(box.id).filter((event) => event.kind === "restore-asked" || event.kind === "restored");
  assert.equal(kinds.length, 2);
  for (const event of kinds) assert.match(event.words!, /on a yes given in "Asks" \(thr_one\)/);
  assert.doesNotMatch(kinds.map((event) => event.words).join(" "), /your yes|by you/);
  const operation = state.store.operation(restored.operation.id)!;
  assert.deepEqual((operation.consent as { yes: unknown }).yes, yes, "the yes is kept on the operation");

  state.machineRestores = false;
  state.guard = { threads: [], threadsUnread: null, control: false, terminals: 0 };
  state.settings = { agentsRestore: false };
  const settings = await rejection(state.snapshots.restore(AGENT, box, standing(box), "one"));
  assert.ok(settings instanceof YesNeeded && settings.asks === "settings");
  const own = await state.snapshots.restore(AGENT, box, standing(box), "one", { yes: { thread: THREAD, title: null, plan: settings.check.plan, at: state.now } });
  assert.ok(own.undo);
  assert.match(state.log.events(box.id).at(-1)!.words!, /on a yes given in thread thr_one\.$/);
  assert.equal((await rejection(state.snapshots.restore(COMMAND, box, standing(box), "one", { yes: { thread: THREAD, title: null, plan: "x", at: 0 } }))).code, "not_owner", "a yes answers an agent's restore only");
});

test("with agents' restores on, an agent restores its own box at once, with an undo, while no thread runs on it", async () => {
  const state = world();
  const box = await readyBox(state);
  await state.snapshots.take(AGENT, box, standing(box), { name: "one" });
  const restored = await state.snapshots.restore(AGENT, box, standing(box), "one");
  assert.ok(restored.undo);
  assert.equal(restored.operation.state, "done");
});

test("a yes is checked against the plan wherever the restore's route now goes: a stale one restores nothing, even once agents' restores are on again", async () => {
  const state = world();
  const box = await readyBox(state);
  await state.snapshots.take(AGENT, box, standing(box), { name: "before" });
  state.settings = { agentsRestore: false };
  const asked = await rejection(state.snapshots.restore(AGENT, box, standing(box), "before"));
  assert.ok(asked instanceof YesNeeded);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "another" });
  state.settings = {};
  state.provider.order.length = 0;
  const stale = await rejection(state.snapshots.restore(AGENT, box, standing(box), asked.check.snapshot.id, { yes: { thread: THREAD, title: null, plan: asked.check.plan, at: state.now } }));
  assert.equal(stale.code, "in_use");
  assert.match(stale.message, /changed after the yes was asked for, so bb-box restored nothing/);
  assert.deepEqual([...state.provider.order], [], "no stop, no rollback");
});

test("with agents' restores off, the form does not let an agent past a person holding the desktop or a terminal on its own box", async () => {
  const state = world();
  const box = await readyBox(state);
  await state.snapshots.take(AGENT, box, standing(box), { name: "one" });
  state.settings = { agentsRestore: false };
  state.guard = { threads: [], threadsUnread: null, control: true, terminals: 1 };
  const refused = await rejection(state.snapshots.restore(AGENT, box, standing(box), "one"));
  assert.equal(refused.code, "in_use");
  assert.ok(!(refused instanceof YesNeeded), "refused before any form");
  assert.match(refused.message, /a person holds control of its desktop; a BB terminal is open on it\. Ask the person to end it first/);
});

test("what goes is agreed by each thread's ID, so a new thread with the same title on the box is not taken as agreed", async () => {
  const state = world();
  state.machineRestores = true;
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  let reads = 0;
  Object.defineProperty(state, "guard", {
    configurable: true,
    get: () => {
      reads++;
      const threads = [{ id: "thr_a", title: "Fix bug", running: false }];
      if (reads > 1) threads.push({ id: "thr_b", title: "Fix bug", running: false });
      return { threads, threadsUnread: null, control: false, terminals: 0 };
    },
  });
  const refused = await rejection(state.snapshots.restore(COMMAND, box, standing(box), "one", { force: true }));
  assert.match(refused.message, /something more would go with box \S+'s disk: "Fix bug" runs on it/);
  assert.ok(!state.provider.order.includes("power-off"));
});

test("an agent's take past the limit on one of the person's machines replaces the oldest it took there", async () => {
  const state = world();
  state.settings = { perBox: 2 };
  const made = await state.boxes.acquire({ threadId: OPERATOR, projectId: null, kind: "linux", who: BY_COMMAND });
  const box = (await state.boxes.settled(made))!;
  const there = { ...standing(box), runsOn: true };
  await state.snapshots.take(AGENT, box, there, { name: "first" });
  state.tick(60_000);
  await state.snapshots.take(AGENT, box, there, { name: "second" });
  state.tick(60_000);
  const third = await state.snapshots.take(AGENT, box, there, { name: "third" });
  assert.equal(third.snapshot?.owner, "person", "a snapshot of the person's machine is the person's");
  assert.equal(third.evicted?.name, "first");
  assert.deepEqual(state.store.records({ box: box.id }).map((record) => record.name).sort(), ["second", "third"]);
});

test("a take that was to replace one past the limit finishes the replacement after bb-box restarts", async () => {
  const state = world();
  state.settings = { perBox: 3 };
  const box = await readyBox(state);
  const first = (await state.snapshots.take(AGENT, box, standing(box), { name: "first" })).snapshot!;
  state.tick(60_000);
  await state.snapshots.take(AGENT, box, standing(box), { name: "second" });
  state.tick(60_000);
  const third = await state.snapshots.take(AGENT, box, standing(box), { name: "third" });
  state.store.updateOperation(third.operation.id, { state: "running", step: "evicting", endedAt: null, consent: { evicts: first.id } });
  await state.restart();
  await state.snapshots.recover();
  assert.equal(state.store.record(first.id), null, "the oldest went after the restart");
  assert.equal(state.store.operation(third.operation.id)?.state, "done");
  assert.match((state.log.events(box.id).find((event) => event.kind === "snapshot-deleted")!.by as { why: string }).why, /^the limit of 3 snapshots a box/);
});

test("bb box option unsets a ceiling whose backend is gone, and refuses to set one", () => {
  const document = { ...emptyDocument(1), general: { snapshots: { ceilings: { gone: 3 } } } } as ConfigDocument;
  assert.equal(setOptions(document, [], new Map(), ["general.snapshots.ceilings.gone"]).document.general.snapshots, undefined);
  assert.throws(() => setOptions(document, [["general.snapshots.ceilings.gone", "4"]], new Map()), /There is no backend "gone"/);
});

test("the turn hold asks BB again when a form's hold ends with no restore on the box, and says when bb-box could not confirm a restore", async () => {
  let rechecks = 0;
  let boxes: BoxRecord[] = [];
  const hold = new TurnHold({ boxes: async () => boxes, unconfirmed: (operation) => operation === "op_unknown", recheck: () => void rechecks++, logError: () => {} });
  const box = { id: "bx1", name: "dev-desk", enrol: { hostId: "host_1" } } as BoxRecord;
  const release = hold.ask(box, "before");
  assert.equal(hold.decide({ host: { id: "host_1" } as never }).action, "wait");
  release();
  assert.equal(rechecks, 1, "released at once, with no mark to wait for");
  assert.equal(hold.decide({ host: { id: "host_1" } as never }).action, "proceed");
  boxes = [{ ...box, restoring: { operation: "op_unknown", snapshot: "sn1", name: "before", at: 0, ran: true } } as BoxRecord];
  await hold.refresh();
  const unconfirmed = hold.decide({ host: { id: "host_1" } as never });
  assert.match((unconfirmed as { reason: string }).reason, /^bb-box could not confirm its restore of box dev-desk, the machine this thread runs on, so this message waits\./);
  boxes = [];
  await hold.refresh();
  assert.equal(rechecks, 2);
});
