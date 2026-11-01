import assert from "node:assert/strict";
import { test } from "node:test";
import { BY_COMMAND } from "../src/core/box-log.ts";
import { keptUntilAfter } from "../src/core/snapshot.ts";
import { keepCostWords, takenText } from "../src/plugin/snapshot-words.ts";
import { COMMAND, THREAD, armedWorld, readyBox, rejection, standing, world, type World } from "./snapshot-world.ts";

const START = Date.UTC(2026, 9, 30, 10, 42);

function beside(state: World): World {
  state.provider.beside = true;
  state.provider.keepWay = "as-is";
  return state;
}

test("a memory snapshot of a stopped box is taken where the backend's snapshots suspend the box, as its saved memory is on its disk; elsewhere it needs the box running", async () => {
  const live = world();
  const stopped = await readyBox(live);
  await live.boxes.stop(THREAD, stopped.id, undefined, BY_COMMAND);
  const off = (await live.boxes.find(stopped.id))!;
  assert.match((await rejection(live.snapshots.take(COMMAND, off, standing(off), { memory: true }))).message, /needs box \S+ running, and it is stopped/);

  const state = beside(world());
  const box = await readyBox(state);
  await state.boxes.stop(THREAD, box.id, undefined, BY_COMMAND);
  const suspended = (await state.boxes.find(box.id))!;
  const taken = await state.snapshots.take(COMMAND, suspended, standing(suspended), { memory: true, name: "suspended" });
  assert.equal(taken.snapshot?.holds, "disk-and-memory");
});

test("snapshots beside the guest: a release deletes the unkept ones, keeps a kept one as it is with no held copy, and deletes the guest though it had one", async () => {
  const state = beside(armedWorld());
  const box = await readyBox(state);
  const kept = (await state.snapshots.take(COMMAND, box, standing(box), { name: "kept one" })).snapshot!;
  const plain = (await state.snapshots.take(COMMAND, box, standing(box), { name: "plain" })).snapshot!;
  const check = await state.snapshots.checkKeep(COMMAND, standing(box), kept.id);
  assert.equal(check.way, "as-is");
  assert.match(keepCostWords(check), /^If \S+ is released, it stays where it is until 2026-11-29; nothing is copied then, and from then on it takes its whole size, up to 17 GB on fake's fast, as its box no longer shares its blocks\.$/);
  await state.snapshots.keep(COMMAND, standing(box), kept.id, { days: 30 });
  await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  assert.equal(await state.backend.power(box.guest!), null, "the guest went: its kept snapshot lives beside it");
  assert.ok(!state.provider.order.some((step) => step.startsWith("copy-snapshot")), "no held copy");
  const after = state.store.record(kept.id)!;
  assert.deepEqual([after.guest, after.boxGone?.how, after.keptUntil], ["current", "released", keptUntilAfter(START, 30)]);
  assert.ok(state.provider.held.has(kept.id));
  assert.equal(state.store.record(plain.id), null);
  assert.equal(state.provider.held.has(plain.id), false, "the unkept one was deleted with its box, not left beside it");
  assert.equal(state.snapshots.holdsGuest(state.backend.id, box.guest!.ref, true), null);
});

test("a kept snapshot beside a released box is renewed with Keep and forks as one of the person's machines", async () => {
  const state = beside(armedWorld());
  const box = await readyBox(state);
  const kept = (await state.snapshots.take(COMMAND, box, standing(box), { name: "kept one" })).snapshot!;
  state.provider.sizes.set(kept.id, { cores: 2, memoryMiB: 4096, diskGiB: 16 });
  await state.snapshots.keep(COMMAND, standing(box), kept.id, { days: 30 });
  await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  const gone = state.snapshots.findGone(box.name, "kept one");
  const again = await state.snapshots.checkKeepGone(gone, { days: 60 });
  assert.match(keepCostWords(again), /^Its box was released, and it stays where it is on fake until bb-box deletes it after 2026-12-29\.$/);
  const renewed = await state.snapshots.keepGone(gone, BY_COMMAND, { days: 60 });
  assert.equal(renewed.snapshot.keptUntil, keptUntilAfter(START, 60));
  const fork = await state.snapshots.checkForkGone(gone, {});
  assert.equal(fork.asMachine, true);
  assert.deepEqual([fork.size.cores, fork.size.memoryMiB], [2, 4096]);
});

test("a take whose box did not resume after it leaves the box stopped, says so in its answer and its log, and keeps the snapshot", async () => {
  const state = beside(world());
  const box = await readyBox(state);
  state.provider.notResumed = "Tart could not start the VM: the Mac runs as many VMs as macOS allows";
  const taken = await state.snapshots.take(COMMAND, box, standing(box), { name: "one", memory: true });
  assert.equal(taken.snapshot?.state, "ready");
  assert.equal(taken.notResumed, `Box ${box.name} did not resume after it: Tart could not start the VM: the Mac runs as many VMs as macOS allows. It is stopped: start it.`);
  const after = (await state.boxes.find(box.id))!;
  assert.deepEqual([after.state, after.error], ["stopped", taken.notResumed]);
  assert.match(state.log.events(box.id).find((event) => event.kind === "snapshot-taken")!.words!, /did not resume after it: .* It is stopped: start it\.$/);
  assert.match(takenText(taken, box.name, 5), /did not resume after it/);
});
