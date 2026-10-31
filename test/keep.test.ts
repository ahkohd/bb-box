import assert from "node:assert/strict";
import { test } from "node:test";
import { BY_COMMAND } from "../src/core/box-log.ts";
import { keptUntilAfter, utcDay, type Caller } from "../src/core/snapshot.ts";
import { COMMAND, DAY, THREAD, armedWorld, readIn, readyBox, rejection, standing, untilHeld, world, writeIn, type World } from "./snapshot-world.ts";

const AGENT: Caller = { is: "agent", threadId: THREAD };
const START = Date.UTC(2026, 9, 30, 10, 42);

async function keptBox(state: World, name = "kept one", options: { readonly memory?: boolean } = {}) {
  const box = await readyBox(state);
  writeIn(state, box, "home/state.txt", "before the take");
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name, ...(options.memory ? { memory: true } : {}) })).snapshot!;
  const kept = await state.snapshots.keep(COMMAND, standing(box), taken.id, { days: 30 });
  return { box, taken, kept };
}

test("Keep writes the keep date on the provider's label first, then the record: the person's, 30 days from today by default, logged", async () => {
  const state = armedWorld();
  const box = await readyBox(state);
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "one" })).snapshot!;
  const check = await state.snapshots.checkKeep(COMMAND, standing(box), "one");
  assert.equal(check.keptUntil, keptUntilAfter(START, 30));
  assert.equal(check.way, "held-copy");
  assert.equal(check.renews, false);
  assert.equal(check.usedBytes, 2 * 2 ** 30);
  assert.equal(check.warning, null);
  const answer = await state.snapshots.keep(COMMAND, standing(box), "one");
  assert.equal(answer.snapshot.keptUntil, keptUntilAfter(START, 30));
  assert.equal(answer.snapshot.keptAt, START);
  assert.equal(answer.snapshot.owner, "person");
  assert.deepEqual(state.provider.labels, [`snapshot ${taken.id} kept 2026-11-29`]);
  assert.equal(state.provider.held.get(taken.id)?.keptUntil, keptUntilAfter(START, 30));
  const event = state.log.events(box.id).at(-1)!;
  assert.equal(event.kind, "snapshot-kept");
  assert.equal(event.words, `"one" (${taken.id}): until 2026-11-29.`);
  assert.deepEqual(event.by, BY_COMMAND);
});

test("only the person keeps a snapshot: an agent is refused, and cannot stop keeping one either", async () => {
  const state = armedWorld();
  const box = await readyBox(state);
  await state.snapshots.take(AGENT, box, standing(box), { name: "mine" });
  const refused = await rejection(state.snapshots.keep(AGENT, standing(box), "mine"));
  assert.equal(refused.code, "not_owner");
  assert.match(refused.message, /person's to do/);
  await state.snapshots.keep(COMMAND, standing(box), "mine");
  assert.equal((await rejection(state.snapshots.unkeep(AGENT, standing(box), "mine"))).code, "not_owner");
  assert.equal(state.provider.labels.length, 1);
});

test("Keep is refused for a snapshot no fork could use after a release: taken before the identity reset, or on a backend that keeps nothing past a release", async () => {
  const state = world({ markersOn: false });
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "old image" });
  const refused = await rejection(state.snapshots.keep(COMMAND, standing(box), "old image"));
  assert.equal(refused.code, "unsupported");
  assert.equal(refused.message, `Taken before ${box.name}'s image had the identity reset: "old image" could not be forked after a release, so bb-box does not keep it.`);
  const other = armedWorld();
  other.provider.keepWay = "no";
  const second = await readyBox(other);
  await other.snapshots.take(COMMAND, second, standing(second), { name: "two" });
  assert.match((await rejection(other.snapshots.keep(COMMAND, standing(second), "two"))).message, /has no way to keep a snapshot of a linux box past the box's release/);
  assert.deepEqual([...state.provider.labels, ...other.provider.labels], []);
});

test("a keep date: days from 1 to 365 or a date, never in the past, never past a year; a renewal by default never shortens it", async () => {
  const state = armedWorld();
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  for (const input of [{ days: 0 }, { days: 366 }, { days: 2.5 }]) assert.equal((await rejection(state.snapshots.keep(COMMAND, standing(box), "one", input))).code, "invalid_value", JSON.stringify(input));
  assert.match((await rejection(state.snapshots.keep(COMMAND, standing(box), "one", { until: "29 Nov" }))).message, /yyyy-mm-dd/);
  assert.match((await rejection(state.snapshots.keep(COMMAND, standing(box), "one", { until: "2026-10-29" }))).message, /has passed already/);
  assert.match((await rejection(state.snapshots.keep(COMMAND, standing(box), "one", { until: "2027-12-01" }))).message, /at most 365 days/);
  assert.match((await rejection(state.snapshots.keep(COMMAND, standing(box), "one", { days: 3, until: "2026-12-01" }))).message, /not both/);
  await state.snapshots.keep(COMMAND, standing(box), "one", { until: "2027-01-15" });
  assert.equal(state.store.records()[0]!.keptUntil, Date.UTC(2027, 0, 15, 23, 59, 59, 999));
  const renewal = await state.snapshots.checkKeep(COMMAND, standing(box), "one");
  assert.equal(renewal.renews, true);
  assert.equal(renewal.keptUntil, Date.UTC(2027, 0, 15, 23, 59, 59, 999), "30 days from today would shorten it, so the default keeps the later date");
  const asked = await state.snapshots.checkKeep(COMMAND, standing(box), "one", { days: 10 });
  assert.equal(asked.shortens, true, "a date the person gives may shorten it, and the check says so");
  state.tick(70 * DAY);
  const renewed = await state.snapshots.keep(COMMAND, standing(box), "one");
  assert.equal(renewed.snapshot.keptUntil, keptUntilAfter(START + 70 * DAY, 30));
  assert.equal(state.log.events(box.id).at(-1)?.words?.includes("renewed from 2027-01-15"), true);
});

test("Keep writes nothing when the provider refuses its label, and Stop keeping takes the date off the label and the record", async () => {
  const state = armedWorld();
  const box = await readyBox(state);
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "one" })).snapshot!;
  state.provider.labelFault = new Error("Proxmox PUT failed (403): Permission check failed");
  const refused = await rejection(state.snapshots.keep(COMMAND, standing(box), "one"));
  assert.match(refused.message, /could not write the keep date on .*, so it did not keep "one": Proxmox PUT failed \(403\)/);
  assert.equal(state.store.record(taken.id)?.keptUntil, null);
  await state.snapshots.keep(COMMAND, standing(box), "one");
  const unkept = await state.snapshots.unkeep(COMMAND, standing(box), "one");
  assert.equal(unkept.keptUntil, null);
  assert.equal(state.provider.held.get(taken.id)?.keptUntil, null);
  assert.equal(state.log.events(box.id).at(-1)?.kind, "snapshot-unkept");
  assert.equal((await rejection(state.snapshots.unkeep(COMMAND, standing(box), "one"))).code, "in_use", "not kept");
});

test("the Keep check warns when a release would find no room for the held copy, and when no VMID is free, without refusing", async () => {
  const state = armedWorld();
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  state.provider.percentFull = 84;
  const room = await state.snapshots.checkKeep(COMMAND, standing(box), "one");
  assert.match(room.warning ?? "", /^At today's size, a release would not finish: .*storage fast has \d+ GB free, and with the held copy, about 2\.1 GB, it would be 86% full, past your settings' 85%\.$/);
  state.provider.percentFull = 30;
  state.provider.keepWhy = "Every VMID from 3170 to 3181 is in use now, so a release would have none for the held copy.";
  assert.equal((await state.snapshots.checkKeep(COMMAND, standing(box), "one")).warning, state.provider.keepWhy);
  await state.snapshots.keep(COMMAND, standing(box), "one");
});

test("G15: a release makes a held copy of each kept snapshot before it deletes the guest; the copy is a template of the disk, the record lives on it, and unkept snapshots go with the box", async () => {
  const state = armedWorld();
  const { box, taken } = await keptBox(state, "kept one", { memory: true });
  const plain = (await state.snapshots.take(COMMAND, box, standing(box), { name: "plain" })).snapshot!;
  await state.boxes.release(THREAD, box.id, "done with it", BY_COMMAND);
  const order = state.provider.order.join(" | ");
  assert.ok(state.provider.order.indexOf(`copy-snapshot ${taken.id}`) >= 0, order);
  const kept = state.store.record(taken.id)!;
  assert.equal(kept.guest, "held-copy");
  assert.equal(kept.holds, "disk", "a memory snapshot's copy holds the disk only");
  assert.equal(kept.boxGone?.how, "released");
  assert.equal(kept.ref, kept.livesOn.ref);
  assert.equal(state.provider.copies.get(kept.livesOn.ref)?.state, "template");
  assert.equal(state.provider.copies.get(kept.livesOn.ref)?.disarmed, true);
  assert.equal(state.provider.copies.get(kept.livesOn.ref)?.kept, "2026-11-29");
  assert.equal(state.store.record(plain.id), null, "an unkept one goes with its box");
  assert.equal(await state.backend.power(box.guest!), null, "the guest went only after the copy");
  const kinds = state.kinds(box.id);
  assert.ok(kinds.indexOf("held-copy-made") < kinds.indexOf("released"), kinds.join(" "));
  assert.match(state.log.events(box.id).find((event) => event.kind === "held-copy-made")!.words!, /^"kept one" \(sn\w+\): kept until 2026-11-29, copied in full into guest copy\d, a template that cannot start, in \d+\.\d s\. The copy holds its disk only\.$/);
  const op = state.store.operations({ box: box.id, kind: "hold-copy" })[0]!;
  assert.equal(op.state, "done");
  assert.equal(state.store.pins().has(taken.id), false, "its pin ended with its operation");
});

test("G15: with too little room for the copy, the release stops and deletes nothing; once there is room, the sweep's release finishes", async () => {
  const state = armedWorld();
  const { box, taken } = await keptBox(state);
  state.provider.percentFull = 90;
  const left = await state.boxes.release(THREAD, box.id, "done with it", BY_COMMAND);
  assert.equal(left?.state, "releasing");
  assert.match(left?.error ?? "", /^Release did not finish: bb-box could not copy "kept one", which you kept: .*storage fast has \d+ GB free, and with the held copy, about 2\.1 GB, it would be 92% full, past your settings' 85%\. bb-box tries again in a few minutes\. Release it again, or release it and delete what you kept\.$/);
  assert.notEqual(await state.backend.power(box.guest!), null, "the guest stays");
  assert.equal(state.store.record(taken.id)?.guest, "current");
  assert.equal(state.provider.held.has(taken.id), true);
  assert.equal(state.store.pins().has(taken.id), false);
  assert.equal(state.kinds(box.id).at(-1), "release-failed");
  state.provider.percentFull = 30;
  await state.snapshots.sweep();
  await state.boxes.sweep();
  assert.equal(await state.backend.power(box.guest!), null);
  assert.equal(state.store.record(taken.id)?.guest, "held-copy");
});

test("Release and delete what you kept: bb-box takes each keep off first, at the person's word, and the snapshots go with the box", async () => {
  const state = armedWorld();
  const { box, taken } = await keptBox(state);
  const unkept = await state.snapshots.unkeepForRelease(box, BY_COMMAND);
  assert.deepEqual(unkept.map((record) => record.id), [taken.id]);
  assert.match(state.log.events(box.id).at(-1)?.words ?? "", /it goes with its box again: box .* was released with it, as you asked\.$/);
  await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  assert.equal(state.store.record(taken.id), null);
  assert.equal(state.provider.copies.size, 0);
});

test("G16: a held copy cut short before it is a template is never trusted: after a restart it is deleted and made again from the snapshot, then the release finishes", async () => {
  const state = armedWorld();
  const { box, taken } = await keptBox(state);
  state.holds.step = "copied";
  const releasing = state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  await untilHeld(state, releasing);
  const first = state.store.unsettled().find((operation) => operation.kind === "hold-copy")!;
  assert.equal(first.step, "copy-cloned");
  const untrusted = first.guests!.new!.ref;
  assert.equal(state.provider.copies.get(untrusted)?.state, "copy");
  state.provider.runningCopies.add(untrusted);
  await state.restart();
  await releasing.catch(() => null);
  await state.snapshots.sweep();
  assert.equal(state.provider.copies.has(untrusted), false, "the untrusted copy is deleted");
  const kept = state.store.record(taken.id)!;
  assert.equal(kept.guest, "held-copy");
  assert.notEqual(kept.livesOn.ref, untrusted, "made again");
  assert.equal(state.provider.copies.get(kept.livesOn.ref)?.state, "template");
  assert.ok(state.kinds(box.id).includes("held-copy-started"), "a copy that ran before its template is logged");
  assert.ok(state.logs.some((line) => line.includes(`Deleted guest ${untrusted}, the held copy of snapshot ${taken.id}`)));
  await state.boxes.sweep();
  assert.equal(await state.backend.power(box.guest!), null, "the release finished after the copy");
  assert.equal(state.store.unsettled().length, 0);
});

test("G16: a held copy whose clone finished as a template before a restart is confirmed, not made again", async () => {
  const state = armedWorld();
  const { box, taken } = await keptBox(state);
  const releasing = state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  state.holds.step = null;
  await releasing;
  const copy = state.store.record(taken.id)!.livesOn.ref;
  const op = state.store.operations({ box: box.id, kind: "hold-copy" })[0]!;
  state.store.updateOperation(op.id, { state: "running", step: "copy-disarmed" });
  state.store.updateRecord(taken.id, { guest: "current", livesOn: box.guest!, ref: `bb${taken.id}` });
  await state.restart();
  await state.snapshots.sweep();
  assert.equal(state.store.record(taken.id)?.livesOn.ref, copy);
  assert.equal([...state.provider.copies.keys()].length, 1);
  assert.match(state.log.events(box.id).at(-1)?.words ?? "", /confirmed after bb-box restarted\.$/);
});

test("expiry: a released box's kept snapshot goes at its date with its held copy, and not while a fork uses it", async () => {
  const state = armedWorld();
  const { box, taken } = await keptBox(state);
  await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  const copy = state.store.record(taken.id)!.livesOn.ref;
  state.tick(30 * DAY);
  await state.snapshots.sweep();
  assert.equal(state.store.record(taken.id)?.guest, "held-copy", "not yet: it is kept to the end of its day");
  state.tick(DAY);
  const pin = { ...state.store.operations({ box: box.id, kind: "hold-copy" })[0]!, id: "opforkpinaaaaa", kind: "fork" as const, state: "running" as const, step: "acquiring", startedAt: state.now, endedAt: null };
  state.store.insertOperation(pin);
  await state.snapshots.tidy();
  assert.equal(state.provider.copies.has(copy), true, "a fork's pin holds it past its date");
  state.store.updateOperation(pin.id, { state: "done", endedAt: state.now });
  await state.snapshots.tidy();
  assert.equal(state.provider.copies.has(copy), false);
  assert.equal(state.store.record(taken.id), null);
  const last = state.log.events(box.id).at(-1)!;
  assert.equal(last.kind, "snapshot-deleted");
  assert.deepEqual(last.by, { is: "bb-box", why: "its keep ended" });
});

test("a living box's kept snapshot also goes at its keep date, as a delete by bb-box", async () => {
  const state = armedWorld();
  const { taken } = await keptBox(state);
  state.tick(31 * DAY);
  await state.snapshots.sweep();
  assert.equal(state.store.record(taken.id), null);
  assert.equal(state.provider.held.has(taken.id), false);
});

test("Keep of a released box's held copy renews it, never Stop keeping, and a held copy that is not a template is not renewed", async () => {
  const state = armedWorld();
  const { box, taken } = await keptBox(state);
  await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  const gone = state.snapshots.findGone(box.name, "kept one");
  const renewal = await state.snapshots.checkKeepGone(gone, { days: 60 });
  assert.equal(renewal.gone, true);
  assert.equal(renewal.renews, true);
  await state.snapshots.keepGone(gone, BY_COMMAND, { days: 60 });
  assert.equal(state.store.record(taken.id)?.keptUntil, keptUntilAfter(START, 60));
  assert.equal(state.provider.copies.get(gone.livesOn.ref)?.kept, utcDay(keptUntilAfter(START, 60)));
  assert.match((await rejection(state.snapshots.unkeepGone(state.store.record(taken.id)!, BY_COMMAND))).message, /only its keep holds "kept one"\. Delete it instead, or keep it longer\./);
  state.provider.copies.get(gone.livesOn.ref)!.state = "copy";
  assert.match((await rejection(state.snapshots.keepGone(state.store.record(taken.id)!, BY_COMMAND, { days: 90 }))).message, /is not a template, so bb-box does not keep it longer/);
});

test("with snapshots.db unreadable, a release that its provider's labels say holds a kept snapshot deletes nothing", async () => {
  const state = armedWorld();
  const { box, taken } = await keptBox(state);
  const problem = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(state.store), "problem")!;
  Object.defineProperty(state.store, "problem", { get: () => "bb-box cannot write snapshots.db: disk I/O error." });
  const left = await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  assert.match(left?.error ?? "", /cannot tell whether box .* holds a snapshot you kept, and deleted nothing: its labels on .* say one is kept\./);
  assert.notEqual(await state.backend.power(box.guest!), null);
  assert.equal(state.provider.held.has(taken.id), true);
  void problem;
});

test("a fork of a kept snapshot of a released box needs its held copy to be a template, and becomes one of the person's machines", async () => {
  const state = armedWorld();
  const { box, taken } = await keptBox(state);
  await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  const gone = state.snapshots.findGone(box.name, "kept one");
  const check = await state.snapshots.checkForkGone(gone, {});
  assert.equal(check.asMachine, true);
  assert.equal(check.box, null);
  assert.deepEqual([check.size.cores, check.size.memoryMiB], [2, 4096], "the size its held copy holds");
  assert.equal(readIn(state, box, "home/state.txt"), null, "the box itself is gone");
  state.provider.copies.get(gone.livesOn.ref)!.state = "copy";
  assert.match((await rejection(state.snapshots.checkForkGone(gone, {}))).message, /its held copy, guest copy\d, is not a template, so bb-box does not trust it/);
  void taken;
});

test("G3 with Keep: with snapshots.db's records gone, a released box's kept held copy is found again kept, with its reset version and its box's kind, and still forks", async () => {
  const state = armedWorld();
  const { box, taken } = await keptBox(state);
  await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  state.forgetRecords();
  await state.restart();
  await state.snapshots.sweep();
  const found = state.store.record(taken.id)!;
  assert.equal(found.guest, "held-copy");
  assert.equal(found.keptUntil, keptUntilAfter(START, 30));
  assert.equal(found.foundAt, null, "kept, so not a found orphan");
  assert.notEqual(found.forkSafe, null, "the copy's tag keeps the snapshot's identity reset version");
  assert.equal(found.box.kind, "linux");
  assert.equal(found.box.system, "linux");
  const check = await state.snapshots.checkForkGone(found, {});
  assert.equal(check.asMachine, true);
});
