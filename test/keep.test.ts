import assert from "node:assert/strict";
import { test } from "node:test";
import { SnapshotFailed, type Backend, type TaskRef } from "../src/backends/types.ts";
import { resetOffWords } from "../src/core/identity.ts";
import { BY_COMMAND } from "../src/core/box-log.ts";
import { keptUntilAfter, utcDay, type Caller } from "../src/core/snapshot.ts";
import { COMMAND, DAY, THREAD, armedWorld, readIn, readyBox, rejection, standing, untilHeld, world, writeIn, type World } from "./snapshot-world.ts";
import { bulkApply, bulkCheck } from "../src/plugin/snapshots-tab.ts";

const AGENT: Caller = { is: "agent", threadId: THREAD };

function provider(state: World): Required<Pick<Backend, "labelKept" | "heldSnapshots" | "planSnapshots" | "copySnapshot">> {
  return state.backend as unknown as Required<Pick<Backend, "labelKept" | "heldSnapshots" | "planSnapshots" | "copySnapshot">>;
}
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
  assert.equal(refused.message, `Taken before ${box.name}'s image had the identity reset: "old image" could not be forked after a release, so BB Box does not keep it. ${resetOffWords("linux")}.`);
  const other = armedWorld();
  other.provider.keepWay = "no";
  const second = await readyBox(other);
  await other.snapshots.take(COMMAND, second, standing(second), { name: "two" });
  assert.match((await rejection(other.snapshots.keep(COMMAND, standing(second), "two"))).message, /has no way to keep a snapshot of a linux box past the box's release/);
  assert.deepEqual([...state.provider.labels, ...other.provider.labels], []);
});

test("a keep date: days from 1 to 365 or a date, never in the past, never past a year; a renewal by default adds the days to the keep date, and never shortens it", async () => {
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
  assert.equal(renewal.keptUntil, Date.UTC(2027, 1, 14, 23, 59, 59, 999), "Keep 30 more days: 30 days from its keep date, not from today");
  const asked = await state.snapshots.checkKeep(COMMAND, standing(box), "one", { days: 10 });
  assert.equal(asked.shortens, true, "a date the person gives may shorten it, and the check says so");
  state.tick(70 * DAY);
  const renewed = await state.snapshots.keep(COMMAND, standing(box), "one");
  assert.equal(renewed.snapshot.keptUntil, Date.UTC(2027, 1, 14, 23, 59, 59, 999));
  assert.equal(state.log.events(box.id).at(-1)?.words?.includes("renewed from 2027-01-15"), true);
  state.tick(60 * DAY);
  await state.snapshots.sweep();
  assert.equal(state.store.record(renewed.snapshot.id), null, "past its date, it went");
  const capped = armedWorld();
  const longBox = await readyBox(capped);
  await capped.snapshots.take(COMMAND, longBox, standing(longBox), { name: "long" });
  await capped.snapshots.keep(COMMAND, standing(longBox), "long", { days: 350 });
  assert.equal((await capped.snapshots.checkKeep(COMMAND, standing(longBox), "long")).keptUntil, keptUntilAfter(START, 365), "never past a year from today");
});

test("Keep writes nothing when the provider refuses its label, and Stop keeping takes the date off the label and the record", async () => {
  const state = armedWorld();
  const box = await readyBox(state);
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "one" })).snapshot!;
  state.provider.labelFault = new SnapshotFailed("Proxmox PUT failed (403): Permission check failed");
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
  assert.match(left?.error ?? "", /^Release did not finish: BB Box could not copy "kept one", which you kept: .*storage fast has \d+ GB free, and with the held copy, about 2\.1 GB, it would be 92% full, past your settings' 85%\. BB Box tries again in a few minutes\. Release it again, or release it and delete what you kept\.$/);
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

test("Release and delete what you kept: BB Box takes each keep off first, at the person's word, and the snapshots go with the box", async () => {
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
  assert.match(state.log.events(box.id).at(-1)?.words ?? "", /confirmed after it was cut short\.$/);
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
  assert.match((await rejection(state.snapshots.keepGone(state.store.record(taken.id)!, BY_COMMAND, { days: 90 }))).message, /is not a template, so BB Box does not keep it longer/);
});

test("with snapshots.db unreadable, a release that its provider's labels say holds a kept snapshot deletes nothing", async () => {
  const state = armedWorld();
  const { box, taken } = await keptBox(state);
  const problem = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(state.store), "problem")!;
  Object.defineProperty(state.store, "problem", { get: () => "BB Box cannot write snapshots.db: disk I/O error." });
  const left = await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  assert.match(left?.error ?? "", /cannot read its snapshots' records, so it cannot copy what box .* holds that you kept, and deleted nothing: its labels on .* say one is kept\. BB Box tries again in a few minutes\.$/);
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
  assert.match((await rejection(state.snapshots.checkForkGone(gone, {}))).message, /its held copy, guest copy\d, is not a template, so BB Box does not trust it/);
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

test("review 1: a renewal cut short after its label is written is recorded at the next sweep, so the copy is not deleted at the old date", async () => {
  const state = armedWorld();
  const { box, taken } = await keptBox(state);
  await state.snapshots.keep(COMMAND, standing(box), taken.id, { days: 1 });
  await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  const copy = state.store.record(taken.id)!.livesOn.ref;
  const update = state.store.updateRecord.bind(state.store);
  state.store.updateRecord = (id, patch) => {
    if (patch.keptUntil) throw new Error("BB Box stopped after the label, before the record");
    return update(id, patch);
  };
  await assert.rejects(state.snapshots.keepGone(state.store.record(taken.id)!, BY_COMMAND, { days: 30 }), /BB Box stopped after the label/);
  assert.equal(state.provider.copies.get(copy)!.kept, utcDay(keptUntilAfter(START, 30)), "the label says the new date");
  const cut = state.store.unsettled().find((operation) => operation.kind === "keep")!;
  assert.equal(cut.step, "labelled", "the keep was recorded before its label, and is unsettled");
  assert.equal(state.store.pins().get(taken.id)?.kind, "keep", "it holds its snapshot until it is settled");
  await state.restart();
  state.tick(2 * DAY);
  await state.snapshots.sweep();
  assert.equal(state.provider.copies.has(copy), true, "not deleted at the old date");
  assert.equal(state.store.record(taken.id)?.keptUntil, keptUntilAfter(START, 30));
  assert.equal(state.store.operation(cut.id)?.state, "done");
  assert.match(state.log.events(box.id).at(-1)?.words ?? "", /confirmed from its label after BB Box restarted/);
});

test("review 1: a keep whose label answer is lost is checked against the label: written, it is recorded; not written, nothing changes; meanwhile nothing deletes it", async () => {
  const state = armedWorld();
  const box = await readyBox(state);
  const one = (await state.snapshots.take(COMMAND, box, standing(box), { name: "one" })).snapshot!;
  const two = (await state.snapshots.take(COMMAND, box, standing(box), { name: "two" })).snapshot!;
  const lost = new Error("cannot reach the provider: timed out");
  const labelKept = provider(state).labelKept.bind(state.backend);
  provider(state).labelKept = async (ref, kept, signal) => {
    if (ref.id === one.id) await labelKept(ref, kept, signal);
    throw lost;
  };
  for (const id of [one.id, two.id]) assert.equal((await rejection(state.snapshots.keep(COMMAND, standing(box), id))).code, "unreachable");
  assert.equal(state.store.record(one.id)?.keptUntil, null);
  assert.match((await rejection(state.snapshots.delete(COMMAND, standing(box), "one"))).message, /is in use by the keep that began/);
  provider(state).labelKept = labelKept;
  await state.snapshots.sweep();
  assert.equal(state.store.record(one.id)?.keptUntil, keptUntilAfter(START, 30), "its label had the date, so it is kept");
  assert.equal(state.store.record(two.id)?.keptUntil, null, "its label did not, so nothing changed");
  assert.equal(state.store.unsettled().filter((operation) => operation.kind === "keep").length, 0);
});

test("review 1: the reconcile takes a later keep date from a label, and never an earlier one", async () => {
  const state = armedWorld();
  const { taken } = await keptBox(state);
  state.provider.held.get(taken.id)!.keptUntil = keptUntilAfter(START, 90);
  state.tick(60_000);
  await state.snapshots.sweep();
  assert.equal(state.store.record(taken.id)?.keptUntil, keptUntilAfter(START, 90));
  state.provider.held.get(taken.id)!.keptUntil = keptUntilAfter(START, 5);
  state.tick(60_000);
  await state.snapshots.sweep();
  assert.equal(state.store.record(taken.id)?.keptUntil, keptUntilAfter(START, 90), "an earlier label never shortens a keep");
});

test("review 2: with records lost while a held copy was not a template, the snapshot is recorded on its source, the untrusted copy is deleted, and the release copies again before it deletes the guest", async () => {
  const state = armedWorld();
  const { box, taken } = await keptBox(state);
  state.holds.step = "copied";
  const releasing = state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  await untilHeld(state, releasing);
  const partial = state.store.unsettled().find((operation) => operation.kind === "hold-copy")!.guests!.new!.ref;
  await state.restart();
  await releasing.catch(() => null);
  state.forgetRecords();
  const listing = provider(state).heldSnapshots.bind(state.backend);
  provider(state).heldSnapshots = async (signal) => [...(await listing(signal))].sort((a, b) => Number(b.where === "held-copy") - Number(a.where === "held-copy"));
  state.tick(1);
  await state.snapshots.reconcile();
  const found = state.store.record(taken.id)!;
  assert.equal(found.guest, "current", "the source is trusted over a copy that is not a template");
  assert.equal(found.keptUntil, keptUntilAfter(START, 30));
  assert.equal(found.forkSafe !== null, true, "and its label's reset version");
  assert.equal(state.provider.copies.has(partial), false, "the untrusted copy is deleted");
  await state.boxes.sweep();
  assert.equal(await state.backend.power(box.guest!), null);
  const kept = state.store.record(taken.id)!;
  assert.equal(kept.guest, "held-copy");
  assert.equal(state.provider.copies.get(kept.livesOn.ref)?.state, "template");
});

test("review 2: a release refuses while a kept snapshot's held copy is not a template, deletes nothing, and offers only what gets past it: deleting that snapshot", async () => {
  const state = armedWorld();
  const { box, taken } = await keptBox(state);
  const untrusted = { ref: "copy9", host: null, address: null, size: null, data: { box: box.id } };
  state.store.updateRecord(taken.id, { guest: "held-copy", livesOn: untrusted, ref: "copy9", state: "incomplete", error: "Its copy is not a template yet, so BB Box does not trust it." });
  const left = await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  assert.equal(left?.error, `Release did not finish: The held copy of "kept one", which you kept, guest copy9, is not a template, so BB Box does not trust it, and deleted nothing. Delete that snapshot, then release the box again. BB Box tries again in a few minutes.`);
  assert.doesNotMatch(left?.error ?? "", /delete what you kept/, "Release and delete what you kept does not clear a held copy, so it is not offered");
  assert.notEqual(await state.backend.power(box.guest!), null);
});

test("review 3: held copies share the room rule with takes: each reserves its room while it is made, a second one past the limit is refused, and an unreadable plan refuses the release", async () => {
  const state = armedWorld();
  const first = await keptBox(state, "first");
  const second = await keptBox(state, "second");
  state.provider.percentFull = 82;
  let unblock!: () => void;
  state.provider.copyGate = new Promise((resolve) => (unblock = resolve));
  const releasing = state.boxes.release(THREAD, first.box.id, "done", BY_COMMAND);
  for (let tries = 0; tries < 1000 && !state.provider.copies.size; tries++) await new Promise((resolve) => setTimeout(resolve, 1));
  const copying = state.store.unsettled().find((operation) => operation.kind === "hold-copy")!;
  assert.deepEqual(copying.reserved, { storage: state.provider.storageKey, bytes: 2 * 2 ** 30, price: null });
  assert.equal(state.store.reservedBytes(state.provider.storageKey), 2 * 2 ** 30);
  const refused = await state.boxes.release(THREAD, second.box.id, "done", BY_COMMAND);
  assert.match(refused?.error ?? "", /has \d+ GB free, beside 2\.1 GB that snapshots and copies being made there hold, and with the held copy, about 2\.1 GB, it would be 86% full, past your settings' 85%/);
  assert.notEqual(await state.backend.power(second.box.guest!), null);
  unblock();
  await releasing;
  assert.equal(state.store.reservedBytes(state.provider.storageKey), 0, "the reservation ends with its copy");
  const unread = armedWorld();
  const third = await keptBox(unread, "third");
  provider(unread).planSnapshots = async () => {
    throw new Error("storage status is unreadable");
  };
  const stopped = await unread.boxes.release(THREAD, third.box.id, "done", BY_COMMAND);
  assert.match(stopped?.error ?? "", /could not read where it would be copied, so it deleted nothing: storage status is unreadable/);
  assert.notEqual(await unread.backend.power(third.box.guest!), null);
});

test("a release leaves BB's machine list only once its kept snapshots are copied, so one that stops for a copy is still a BB machine", async () => {
  const state = armedWorld();
  const { box, taken } = await keptBox(state);
  await state.boxes.update(box, () => ({ enrol: { state: "enrolled", hostId: "host-kept", error: null } }));
  state.provider.percentFull = 90;
  const stopped = await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  assert.match(stopped?.error ?? "", /^Release did not finish: BB Box could not copy "kept one"/);
  assert.deepEqual(state.unenrolled, [], "a release that stopped for a copy keeps the machine in BB");
  state.provider.percentFull = 30;
  const copySnapshot = provider(state).copySnapshot.bind(state.backend);
  provider(state).copySnapshot = async (ref, label, hooks, signal) => {
    assert.deepEqual(state.unenrolled, [], "the copy is made while the machine is still in BB");
    return copySnapshot(ref, label, hooks, signal);
  };
  await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  assert.equal(state.store.record(taken.id)?.guest, "held-copy");
  assert.deepEqual(state.unenrolled, [box.id], "once the copy is made, the machine leaves BB");
});

test("a held copy refused just past the room limit says by how much, not a whole percent equal to the limit", async () => {
  const state = armedWorld();
  const { box } = await keptBox(state);
  state.provider.percentFull = 83.04;
  const left = await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  assert.match(left?.error ?? "", /it would be 85\.1% full, past your settings' 85%\./);
  assert.notEqual(await state.backend.power(box.guest!), null);
});

test("review 4: a living box's kept snapshot found again after records loss keeps its reset version from its label, so its held copy forks; one found without a version stops the release", async () => {
  const state = armedWorld();
  const { box, taken } = await keptBox(state);
  state.forgetRecords();
  await state.restart();
  await state.snapshots.sweep();
  assert.notEqual(state.store.record(taken.id)?.forkSafe, null);
  await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  const kept = state.store.record(taken.id)!;
  assert.equal(kept.guest, "held-copy");
  assert.equal((await state.snapshots.checkForkGone(kept, {})).asMachine, true);
  const old = armedWorld();
  const second = await keptBox(old, "old label");
  old.provider.held.get(second.taken.id)!.forkSafe = null;
  old.forgetRecords();
  await old.restart();
  await old.snapshots.sweep();
  const left = await old.boxes.release(THREAD, second.box.id, "done", BY_COMMAND);
  assert.match(left?.error ?? "", /cannot tell whether a fork could use "[^"]+", which you kept: its record was found again without its identity reset's version\. So it deleted nothing\./);
  assert.notEqual(await old.backend.power(second.box.guest!), null);
});

test("review 5: bulk Keep with no date chosen never shortens a longer keep; a date chosen may, and its row says so", async () => {
  const state = armedWorld();
  const { taken } = await keptBox(state);
  await state.snapshots.keep(COMMAND, standing((await state.boxes.find(taken.box.id))!), taken.id, { days: 90 });
  const untouched = await bulkCheck(state.snapshots, [taken.id], "keep", {}, state.now);
  assert.match(untouched.allowed[0]!.words, new RegExp(`^Until ${utcDay(keptUntilAfter(START, 120))}\\. It is kept until ${utcDay(keptUntilAfter(START, 90))} now\\.`));
  await bulkApply(state.snapshots, [taken.id], "keep", {});
  assert.equal(state.store.record(taken.id)?.keptUntil, keptUntilAfter(START, 120), "30 more days from its keep date");
  const chosen = { until: utcDay(keptUntilAfter(START, 30)) };
  const shorter = await bulkCheck(state.snapshots, [taken.id], "keep", chosen, state.now);
  assert.match(shorter.allowed[0]!.words, new RegExp(`^Until ${chosen.until}\\. This shortens its keep, from ${utcDay(keptUntilAfter(START, 120))}\\.`));
});

test("review: a release copies only keeps whose date has not passed; one past its date goes with the box", async () => {
  const state = armedWorld();
  const { box, taken } = await keptBox(state);
  state.store.updateRecord(taken.id, { keptUntil: START - 1 });
  state.provider.held.get(taken.id)!.keptUntil = START - 1;
  await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  assert.equal(state.provider.copies.size, 0);
  assert.equal(await state.backend.power(box.guest!), null);
});

test("review: a leftover guest of an ended thread whose label says kept, with no kept record, stays until the records agree", async () => {
  const state = armedWorld();
  const { box, taken } = await keptBox(state);
  await state.forgetBox(box);
  state.store.updateRecord(taken.id, { keptUntil: null, keptAt: null });
  state.threadState = "ended";
  provider(state).heldSnapshots = async () => {
    throw new Error("the listing failed");
  };
  for (let sweep = 0; sweep < 2; sweep++) {
    await state.boxes.sweep();
    state.tick(3 * 60_000);
  }
  assert.notEqual(await state.backend.power(box.guest!), null, "a failed listing keeps the guest");
  assert.ok(state.boxLogs.some((line) => line.includes("could not read its snapshots' labels (the listing failed), so it keeps the guest until it can")), state.boxLogs.join("\n"));
  await state.restart();
  state.threadState = "ended";
  await state.boxes.sweep();
  state.tick(3 * 60_000);
  await state.boxes.sweep();
  assert.notEqual(await state.backend.power(box.guest!), null, "a label that says kept keeps the guest");
  assert.ok(state.boxLogs.some((line) => line.includes(`its label says snapshot ${taken.id} is kept until`)), state.boxLogs.join("\n"));
  await state.snapshots.sweep();
  await state.boxes.sweep();
  assert.equal(await state.backend.power(box.guest!), null, "once the reconcile takes the label's date, the copy is made and the guest goes");
  assert.equal(state.store.record(taken.id)?.guest, "held-copy");
});

test("review: a restart while the copy's task still runs leaves it unsettled and pinned, and the next sweep finishes it once the task ends", async () => {
  const state = armedWorld();
  const { box, taken } = await keptBox(state);
  state.holds.step = "task";
  const releasing = state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  await untilHeld(state, releasing);
  const cut = state.store.unsettled().find((operation) => operation.kind === "hold-copy")!;
  assert.equal(cut.step, "copy-task");
  await state.restart();
  await releasing.catch(() => null);
  state.provider.tasks.set(cut.task!.ref, { state: "running" });
  await state.snapshots.recover();
  assert.equal(state.store.operation(cut.id)?.state, "unknown", "a running clone is waited for, not trusted");
  assert.equal(state.store.pins().get(taken.id)?.id, cut.id);
  assert.notEqual(await state.backend.power(box.guest!), null);
  state.provider.tasks.set(cut.task!.ref, { state: "ok" });
  await state.snapshots.sweep();
  await state.boxes.sweep();
  assert.equal(state.store.record(taken.id)?.guest, "held-copy");
  assert.equal(await state.backend.power(box.guest!), null);
  assert.equal(state.provider.copies.size, 1, "the copy that was not a template went, and one template is left");
});

test("a release whose copy outlasts its wait while the provider still makes it leaves the copy's operation unsettled and deletes nothing; once the task ends well, the sweep makes that same copy the template", async () => {
  const state = armedWorld();
  const { box, taken } = await keptBox(state);
  const copySnapshot = provider(state).copySnapshot.bind(state.backend);
  let task: TaskRef | null = null;
  let clones = 0;
  provider(state).copySnapshot = async (ref, label, hooks, signal) => {
    clones++;
    await copySnapshot(ref, label, { ...hooks, task: async (made) => { task = made; await hooks.task(made); } }, signal);
    state.provider.tasks.set(task!.ref, { state: "running" });
    throw new Error("Proxmox TASK vzclone failed (504): task did not finish in time.");
  };
  const left = await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  assert.match(left?.error ?? "", /task did not finish in time\. .* may still be making its copy, guest (copy\d+): BB Box waits for that task, and makes the copy a template once it ends well\. BB Box tries again in a few minutes\.$/);
  const made = /guest (copy\d+):/.exec(left!.error!)![1]!;
  const cut = state.store.operations({ box: box.id, kind: "hold-copy" })[0]!;
  assert.equal(cut.state, "unknown");
  assert.equal(state.store.pins().get(taken.id)?.id, cut.id, "the snapshot stays pinned while its copy is made");
  assert.ok(state.provider.copies.has(made), "a copy still being made is not counted deleted");
  assert.notEqual(await state.backend.power(box.guest!), null);
  await state.snapshots.sweep();
  assert.equal(state.store.operation(cut.id)?.state, "unknown", "while the task runs, the sweep waits for it");
  assert.ok(state.provider.copies.has(made));
  state.provider.tasks.set(task!.ref, { state: "ok" });
  await state.snapshots.sweep();
  assert.equal(state.provider.copies.get(made)?.state, "template", "the same copy, finished well, becomes the held copy");
  assert.equal(clones, 1, "no second clone");
  assert.equal(state.store.record(taken.id)?.livesOn.ref, made);
  state.tick(3 * 60_000);
  await state.boxes.sweep();
  assert.equal(state.store.record(taken.id)?.guest, "held-copy");
  assert.equal(await state.backend.power(box.guest!), null);
  assert.equal(state.provider.copies.size, 1);
});

test("re-review B1: after records loss, every release reads its guest's own labels: it stops while it cannot read them, or while one says kept and the records do not, and copies once they agree", async () => {
  const state = armedWorld();
  const { box, taken } = await keptBox(state);
  state.forgetRecords();
  await state.restart();
  state.provider.listing = new Error("one guest snapshot listing is unreadable");
  await state.snapshots.sweep();
  assert.equal(state.store.problem, null, "a rebuilt store is healthy");
  assert.equal(state.store.record(taken.id), null);
  assert.ok(state.provider.held.get(taken.id)!.keptUntil! > state.now);
  const unread = await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  assert.match(unread?.error ?? "", /^Release did not finish: BB Box could not read the labels of box \S+'s snapshots on .*, so it cannot tell whether one is kept, and deleted nothing: one guest snapshot listing is unreadable\. BB Box tries again in a few minutes\.$/i);
  assert.notEqual(await state.backend.power(box.guest!), null);
  assert.ok(state.provider.held.has(taken.id), "the kept snapshot is still there");
  assert.equal(state.provider.copies.size, 0);
  state.provider.listing = null;
  const unrecorded = await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  assert.match(unrecorded?.error ?? "", new RegExp(`label on .* says snapshot ${taken.id} is kept until \\d{4}-\\d{2}-\\d{2}, and BB Box's records do not say so yet, so it deleted nothing\\. BB Box checks its records against the labels at its next sweep\\. BB Box tries again in a few minutes\\.$`));
  assert.notEqual(await state.backend.power(box.guest!), null);
  await state.snapshots.sweep();
  assert.notEqual(state.store.record(taken.id)?.keptUntil ?? null, null, "the sweep records the label's keep");
  await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  assert.equal(await state.backend.power(box.guest!), null);
  assert.equal(state.store.record(taken.id)?.guest, "held-copy");
  assert.equal(state.provider.copies.size, 1);
});

test("re-review B2: a clone slower than its wait that ends well is labelled and made the held copy once, never discarded and cloned again", async () => {
  const state = armedWorld();
  const { box, taken } = await keptBox(state);
  const copySnapshot = provider(state).copySnapshot.bind(state.backend);
  const tasks: TaskRef[] = [];
  let attempts = 0;
  provider(state).copySnapshot = async (ref, label, hooks, signal) => {
    attempts++;
    await copySnapshot(ref, label, { ...hooks, task: async (task) => { tasks.push(task); await hooks.task(task); } }, signal);
    state.provider.tasks.set(tasks.at(-1)!.ref, { state: "running" });
    throw new Error("Proxmox TASK clone failed (504): task did not finish in time.");
  };
  const first = await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  assert.match(first!.error!, /may still be making its copy/);
  const operation = state.store.unsettled().find((each) => each.kind === "hold-copy")!;
  const copy = operation.guests!.new!.ref;
  state.provider.tasks.set(tasks.at(-1)!.ref, { state: "ok" });
  await state.snapshots.recover();
  assert.equal(attempts, 1, "no second clone");
  assert.equal(state.provider.copies.get(copy)?.state, "template");
  assert.ok(state.provider.order.indexOf(`label ${copy}`) >= 0 && state.provider.order.indexOf(`label ${copy}`) < state.provider.order.indexOf(`template ${copy}`), "it gets its held copy's labels before it is a template");
  assert.equal(state.store.record(taken.id)!.guest, "held-copy");
  assert.equal(state.store.operation(operation.id)?.state, "done");
  state.tick(3 * 60_000);
  await state.boxes.sweep();
  assert.equal(await state.backend.power(box.guest!), null);
});

test("re-review B2 race: a clone that ends well just as its wait runs out is labelled and made the held copy in the same release, never deleted", async () => {
  const state = armedWorld();
  const { box, taken } = await keptBox(state);
  const copySnapshot = provider(state).copySnapshot.bind(state.backend);
  const tasks: TaskRef[] = [];
  let attempts = 0;
  provider(state).copySnapshot = async (ref, label, hooks, signal) => {
    attempts++;
    await copySnapshot(ref, label, { ...hooks, task: async (task) => { tasks.push(task); await hooks.task(task); } }, signal);
    state.provider.tasks.set(tasks.at(-1)!.ref, { state: "ok" });
    throw new Error("Proxmox TASK clone failed (504): task did not finish in time.");
  };
  const left = await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  assert.equal(left, null, "the release finished");
  assert.equal(attempts, 1, "no second clone");
  const copy = state.store.record(taken.id)!.livesOn.ref;
  assert.equal(state.store.record(taken.id)?.guest, "held-copy");
  assert.equal(state.provider.copies.get(copy)?.state, "template", "the clone that finished is the held copy");
  assert.ok(!state.provider.order.includes(`delete ${copy}`), "and was never deleted");
  assert.equal(state.provider.order.filter((each) => each.startsWith("template ")).length, 1);
  assert.equal(state.store.unsettled().filter((each) => each.kind === "hold-copy").length, 0);
  assert.equal(await state.backend.power(box.guest!), null);
});

test("re-review B3: a copy made again after a restart, whose submission answer is lost, takes only a task of its own attempt, so it stays unsettled with its room reserved while that clone runs", async () => {
  const state = armedWorld();
  const { box, taken } = await keptBox(state);
  const tasks: { task: TaskRef; at: number }[] = [];
  const hidden = new Map<string, unknown>();
  let attempts = 0;
  const wrap = () => {
    const backend = state.backend as unknown as Required<Pick<Backend, "copySnapshot" | "findTasks">>;
    const copySnapshot = backend.copySnapshot.bind(state.backend);
    backend.findTasks = async (_guest, _kind, since) => tasks.filter((each) => each.at >= since - 5000).map((each) => each.task);
    backend.copySnapshot = async (ref, label, hooks, signal) => {
      attempts++;
      const copy = await copySnapshot(ref, label, { ...hooks, task: async (task) => { tasks.push({ task, at: state.now }); if (attempts === 1) await hooks.task(task); } }, signal);
      state.provider.tasks.set(tasks.at(-1)!.task.ref, { state: "running" });
      if (attempts === 2) {
        hidden.set(copy.ref, state.provider.copies.get(copy.ref));
        state.provider.copies.delete(copy.ref);
      }
      throw new Error(attempts === 1 ? "task did not finish in time" : "clone submission response lost");
    };
  };
  wrap();
  await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  const operation = state.store.unsettled().find((each) => each.kind === "hold-copy")!;
  assert.equal(operation.task!.ref, tasks[0]!.task.ref);
  state.provider.tasks.set(tasks[0]!.task.ref, { state: "ok" });
  await state.restart();
  wrap();
  state.tick(2_000);
  await state.snapshots.recover();
  const after = state.store.operation(operation.id)!;
  assert.equal(attempts, 2, "after a restart its first copy is not trusted, so it is made again");
  assert.equal(after.state, "unknown");
  assert.equal(after.task?.ref, tasks[1]!.task.ref, "this attempt's task, not the earlier one the provider lists first");
  assert.deepEqual(after.attempts?.map((each) => each.task?.ref), [tasks[0]!.task.ref, tasks[1]!.task.ref]);
  assert.ok(state.store.reservedBytes(state.provider.storageKey) > 0, "its room stays reserved while the clone runs");
  assert.equal(state.provider.tasks.get(tasks[1]!.task.ref)!.state, "running");
  state.provider.tasks.set(tasks[1]!.task.ref, { state: "ok" });
  for (const [ref, held] of hidden) state.provider.copies.set(ref, held as never);
  await state.snapshots.recover();
  assert.equal(attempts, 2);
  assert.equal(state.store.record(taken.id)?.guest, "held-copy");
  assert.equal(state.store.reservedBytes(state.provider.storageKey), 0);
});

test("review: a restart after the record moved to its held copy, before the guest went, finishes the release with no second copy", async () => {
  const state = armedWorld();
  const { box, taken } = await keptBox(state);
  const release = state.backend.release.bind(state.backend);
  let stopped = false;
  state.backend.release = async (guest, hooks) => {
    if (!stopped && guest.ref === box.guest!.ref) {
      stopped = true;
      throw new Error("BB Box stopped");
    }
    return release(guest, hooks);
  };
  await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  assert.equal(state.store.record(taken.id)?.guest, "held-copy");
  assert.notEqual(await state.backend.power(box.guest!), null);
  await state.restart();
  await state.boxes.sweep();
  assert.equal(await state.backend.power(box.guest!), null);
  assert.equal(state.provider.copies.size, 1);
});
