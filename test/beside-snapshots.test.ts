import assert from "node:assert/strict";
import { test } from "node:test";
import { BY_COMMAND } from "../src/core/box-log.ts";
import type { Guest } from "../src/backends/types.ts";
import { keptUntilAfter } from "../src/core/snapshot.ts";
import { STOPPED_ANOTHER_WAY, resetOffWords } from "../src/core/identity.ts";
import { spawnSync } from "node:child_process";
import { keepCostWords, takenText } from "../src/plugin/snapshot-words.ts";
import { COMMAND, THREAD, armedWorld, identityGuest, readyBox, rejection, standing, untilHeld, withIdentitySource, world, type World } from "./snapshot-world.ts";

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

test("where every snapshot holds the memory, as on a Tart macOS box, a take that does not say holds it, the check plans it, and one that asks for none is refused in words", async () => {
  const state = beside(world());
  state.provider.memoryOnly = true;
  const box = await readyBox(state);
  const check = await state.snapshots.checkTake(COMMAND, box, standing(box));
  assert.equal(check.storage, "fast");
  assert.ok(check.memory, "the check plans the memory");
  const taken = await state.snapshots.take(COMMAND, box, standing(box), { name: "unsaid" });
  assert.equal(taken.snapshot?.holds, "disk-and-memory");
  const refused = await rejection(state.snapshots.take(COMMAND, box, standing(box), { name: "no memory", memory: false }));
  assert.equal(refused.code, "unsupported");
  assert.match(refused.message, /^Every snapshot Fake host takes of a linux box holds its memory too, so a snapshot of box \S+ cannot leave it out\. Take it with its memory\.$/);
  assert.equal(state.store.records().length, 1);
});

test("snapshots beside the guest: a release deletes the unkept ones, keeps a kept one as it is with no held copy, and deletes the guest though it had one", async () => {
  const state = beside(armedWorld());
  const box = await readyBox(state);
  const kept = (await state.snapshots.take(COMMAND, box, standing(box), { name: "kept one" })).snapshot!;
  const plain = (await state.snapshots.take(COMMAND, box, standing(box), { name: "plain" })).snapshot!;
  const check = await state.snapshots.checkKeep(COMMAND, standing(box), kept.id);
  assert.equal(check.way, "as-is");
  assert.match(keepCostWords(check), /^If \S+ is released, it stays where it is until Sun 29 Nov; nothing is copied then, and from then on it takes its whole size, up to 17 GB on fake's fast, as its box no longer shares its blocks\.$/);
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
  assert.match(keepCostWords(again), /^Its box was released, and it stays where it is on fake until BB Box deletes it after Tue 29 Dec\.$/);
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

test("070 close-out: bb-box's own stop of a box whose snapshots are taken stopped, as on Tart, reads its identity reset just before, so a snapshot of it stopped is fork-safe and keeps; a start forgets the reading, and a box stopped another way takes snapshots that neither fork nor keep, with words to stop it with bb-box", async () => {
  const state = beside(armedWorld());
  const box = await readyBox(state);
  await state.boxes.stop(THREAD, box.id, undefined, BY_COMMAND);
  const stopped = (await state.boxes.find(box.id))!;
  assert.equal(stopped.state, "stopped");
  const version = stopped.stopForkSafety?.version ?? null;
  assert.ok(version !== null && version >= 7, "read from the guest just before the stop");
  assert.ok(stopped.stopForkSafety?.identity?.machineId, "with the box's machine ID, which a fork's check compares");
  const taken = (await state.snapshots.take(COMMAND, stopped, standing(stopped), { name: "stopped", memory: false })).snapshot!;
  assert.equal(state.store.record(taken.id)?.forkSafe, version);
  await state.snapshots.keep(COMMAND, standing(stopped), taken.id, { days: 30 });
  assert.notEqual(state.store.record(taken.id)?.keptUntil, null);
  await state.boxes.start(THREAD, box.id, undefined, BY_COMMAND);
  assert.equal((await state.boxes.find(box.id))!.stopForkSafety ?? null, null, "a start forgets it");
  await state.backend.stop!(box.guest!);
  await state.boxes.refresh(THREAD, box.id);
  const outside = (await state.boxes.find(box.id))!;
  assert.deepEqual([outside.state, outside.stopForkSafety ?? null], ["stopped", null]);
  const other = (await state.snapshots.take(COMMAND, outside, standing(outside), { name: "outside", memory: false })).snapshot!;
  assert.equal(state.store.record(other.id)?.forkSafe, null);
  const keep = await rejection(state.snapshots.keep(COMMAND, standing(outside), other.id, { days: 30 }));
  assert.match(keep.message, new RegExp(`does not keep it\\. ${escaped(STOPPED_ANOTHER_WAY)}\\.$`));
  const fork = await rejection(state.snapshots.fork(COMMAND, outside, standing(outside), other.id));
  assert.match(fork.message, new RegExp(`could act as \\S+\\. ${escaped(STOPPED_ANOTHER_WAY)}\\.$`));
});

test("070 close-out: where snapshots are taken from a running box, bb-box's stop reads nothing, and a stopped box's snapshots stay as they were", async () => {
  const state = armedWorld();
  const box = await readyBox(state);
  await state.boxes.stop(THREAD, box.id, undefined, BY_COMMAND);
  assert.equal((await state.boxes.find(box.id))!.stopForkSafety ?? null, null);
});

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("070 close-out review (Astra's high, Opus 2): a box bb-box stopped that then ran outside bb-box, started and stopped before any sweep, takes a snapshot that is not fork-safe: the reading holds only while the guest's mark is the one bb-box saw at its stop", async () => {
  const state = beside(armedWorld());
  const box = await readyBox(state);
  await state.boxes.stop(THREAD, box.id, undefined, BY_COMMAND);
  assert.ok((await state.boxes.find(box.id))!.stopForkSafety?.mark, "a mark of the stopped guest, kept with the reading");
  await state.backend.start!(box.guest!);
  await state.backend.stop!(box.guest!);
  const stale = (await state.boxes.find(box.id))!;
  assert.equal(stale.state, "stopped");
  assert.ok(stale.stopForkSafety, "the record has not seen the run");
  const taken = (await state.snapshots.take(COMMAND, stale, standing(stale), { name: "after a run outside", memory: false })).snapshot!;
  assert.deepEqual([state.store.record(taken.id)?.forkSafe, state.store.record(taken.id)?.forkSafeWhy], [null, "unread"]);
  const keep = await rejection(state.snapshots.keep(COMMAND, standing(stale), taken.id, { days: 30 }));
  assert.match(keep.message, new RegExp(`${escaped(STOPPED_ANOTHER_WAY)}\\.$`));
});

test("070 close-out review (Astra's high): a stop that failed, though the guest stopped, keeps no reading, so its snapshot is not fork-safe", async () => {
  const state = beside(armedWorld());
  const box = await readyBox(state);
  const stop = state.backend.stop!.bind(state.backend);
  Object.assign(state.backend, {
    stop: async (guest: Guest) => {
      await stop(guest);
      throw new Error("the answer was lost");
    },
  });
  await assert.rejects(state.boxes.stop(THREAD, box.id, undefined, BY_COMMAND), /the answer was lost/);
  const after = (await state.boxes.find(box.id))!;
  assert.deepEqual([after.state, after.stopForkSafety ?? null], ["stopped", null]);
  const taken = (await state.snapshots.take(COMMAND, after, standing(after), { name: "after a failed stop", memory: false })).snapshot!;
  assert.deepEqual([state.store.record(taken.id)?.forkSafe, state.store.record(taken.id)?.forkSafeWhy], [null, "unread"]);
});

test("070 close-out review (Opus 1, Astra's low): a box whose reset was off when bb-box stopped it takes a snapshot whose fork and Keep refusals say to refresh the Linux image and make the box again, never to stop it with bb-box", async () => {
  const guest = identityGuest();
  const state = beside(world({ identityTool: guest.tool, identityRoot: guest.root }));
  withIdentitySource(state, "eth");
  const box = await readyBox(state);
  assert.equal(spawnSync(guest.tool, ["disable"]).status, 0);
  await state.boxes.stop(THREAD, box.id, undefined, BY_COMMAND);
  const stopped = (await state.boxes.find(box.id))!;
  assert.deepEqual([stopped.stopForkSafety?.version ?? null, stopped.stopForkSafety?.resetOff], [null, true], "the reading ran, and found the reset off");
  const taken = (await state.snapshots.take(COMMAND, stopped, standing(stopped), { name: "reset off", memory: false })).snapshot!;
  assert.deepEqual([state.store.record(taken.id)?.forkSafe, state.store.record(taken.id)?.forkSafeWhy], [null, "reset-off"]);
  const keep = await rejection(state.snapshots.keep(COMMAND, standing(stopped), taken.id, { days: 30 }));
  assert.match(keep.message, new RegExp(`${escaped(resetOffWords("linux"))}\\.$`));
  assert.match(resetOffWords("linux"), /refresh the Linux image and make the box again$/);
  assert.doesNotMatch(keep.message, /stop it with bb-box/);
  const fork = await rejection(state.snapshots.fork(COMMAND, stopped, standing(stopped), taken.id));
  assert.match(fork.message, new RegExp(`${escaped(resetOffWords("linux"))}\\.$`));
});

test("070 close-out review (Opus 3): a restore drops the stopped box's reading as it begins, so the disk it puts back is never vouched for by a reading of another", async () => {
  const state = beside(armedWorld());
  const box = await readyBox(state);
  const target = (await state.snapshots.take(COMMAND, box, standing(box), { name: "target", memory: false })).snapshot!;
  await state.boxes.stop(THREAD, box.id, undefined, BY_COMMAND);
  const stopped = (await state.boxes.find(box.id))!;
  assert.ok(stopped.stopForkSafety);
  state.holds.step = "planned";
  const held = state.snapshots.restore(COMMAND, stopped, standing(stopped), target.id).catch((error: unknown) => error);
  await untilHeld(state, held);
  const restoring = (await state.boxes.find(box.id))!;
  assert.ok(restoring.restoring, "the restore has begun");
  assert.equal(restoring.stopForkSafety ?? null, null);
  await state.restart();
  await held;
});
