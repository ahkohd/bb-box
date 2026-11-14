import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { BoxRecord } from "../src/core/boxes.ts";
import { BY_COMMAND } from "../src/core/box-log.ts";
import { BILL_FRESH_MS } from "../src/core/snapshots.ts";
import { accountAtFullPrice, billedRate, billedWords, ceilingVerdict, heldRate, pendingOn } from "../src/core/snapshot-cost.ts";
import type { Guest } from "../src/backends/types.ts";
import { COMMAND, THREAD, armedWorld, readyBox, rejection, standing, untilHeld, world, type World } from "./snapshot-world.ts";

const PRICE = { amount: 0.056, currency: "USD" as const, per: "day" as const, known: true, included: 2 };
const NOT_YET = "this backend's boxes have no identity reset yet, so a fork of one could act as its source";

function onProvider(state: World, included = 2): void {
  state.provider.onProvider = { price: PRICE, forkWhy: NOT_YET };
  state.provider.restoreWay = "new-guest";
  state.provider.bill = { currency: "USD", included, used: 0, dailyEach: 0.056, refs: [] };
  state.provider.billed();
}

function path(state: World, box: BoxRecord, file: string): string {
  return join(state.root, "fake", box.guest!.ref, file);
}

function write(state: World, box: BoxRecord, file: string, text: string): void {
  mkdirSync(dirname(path(state, box, file)), { recursive: true });
  writeFileSync(path(state, box, file), text);
}

function read(state: World, box: BoxRecord, file: string): string | null {
  return existsSync(path(state, box, file)) ? readFileSync(path(state, box, file), "utf8") : null;
}

test("a bill counts only what is past the plan's included snapshots, and a take within them adds nothing to the rate", () => {
  const within = billedRate({ currency: "USD", included: 10, used: 3, dailyEach: 0.056, refs: [] }, 0);
  assert.equal(within.monthly, 0);
  assert.equal(billedWords(within), "3 saved, none billed");
  assert.ok(ceilingVerdict({ change: "take", backend: "boat.dev", held: within, price: PRICE, bytes: null, ceiling: 0, byPerson: false }).ok, "the fourth of ten costs nothing, so even a ceiling of 0 admits it");
  const full = billedRate({ currency: "USD", included: 10, used: 9, dailyEach: 0.056, refs: [] }, 1);
  assert.equal(full.billed!.used, 10, "a take boat has not counted yet is counted");
  const refused = ceilingVerdict({ change: "take", backend: "boat.dev", held: full, price: PRICE, bytes: null, ceiling: 1, byPerson: true });
  assert.deepEqual(refused, { ok: false, why: "It would bring snapshots held on boat.dev to about $1.68 a month, past your ceiling of $1.00. It would be saved snapshot 11 there, and the plan includes 10. Delete one, or raise the ceiling in Settings, Snapshots, Paid snapshots." });
  const past = billedRate({ currency: "USD", included: 10, used: 12, dailyEach: 0.056, refs: [] }, 0);
  assert.equal(Math.round(past.monthly * 100), 336);
  assert.equal(billedWords(past), "12 saved, 2 billed, about $3.36 a month");
  const estimate = accountAtFullPrice({ currency: "USD", included: 10, used: 12, dailyEach: 0.056, refs: [] }, 1);
  assert.equal(Math.round(estimate.monthly * 100), 2184, "an estimate counts all 13 at full price");
  assert.equal(billedWords(estimate), "about $21.84 a month, estimated at full price for the account's 13");
  assert.equal(ceilingVerdict({ change: "take", backend: "boat.dev", held: null, price: PRICE, bytes: null, ceiling: 100, byPerson: true }).ok, false, "with no bill to go by, a paid take is refused");
  assert.equal(ceilingVerdict({ change: "keep", backend: "boat.dev", held: past, price: PRICE, bytes: null, ceiling: 3, byPerson: true }).ok, false, "past the ceiling, Keep is refused though it adds nothing");
  assert.equal(heldRate([], "boat").billed, undefined);
});

test("the ceiling admits takes within the plan's included snapshots and refuses the one past them, from the provider's own bill", async () => {
  const state = world();
  onProvider(state);
  state.settings = { ceilings: { fake: 1 } };
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  await state.snapshots.take(COMMAND, box, standing(box), { name: "two" });
  assert.equal(state.snapshots.paidOn("fake").held.monthly, 0);
  const refused = await rejection(state.snapshots.take(COMMAND, box, standing(box), { name: "three" }));
  assert.equal(refused.code, "limit_reached");
  assert.match(refused.message, /past your ceiling of \$1\.00\. It would be saved snapshot 3 there, and the plan includes 2\./);
  assert.ok(state.provider.billReads >= 3, "each take reads the bill first");
});

test("when the provider's bill cannot be read just now, no paid take is admitted, and Settings show an estimate at full price", async () => {
  const state = world();
  onProvider(state, 10);
  state.settings = { ceilings: { fake: 2 } };
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  state.provider.bill = new Error("boat did not answer");
  const refused = await rejection(state.snapshots.take(COMMAND, box, standing(box), { name: "two" }));
  assert.match(refused.message, /cannot read what .* bills for snapshots just now/);
  assert.equal(state.snapshots.paidOn("fake").held.estimate, true);
  assert.equal(Math.round(state.snapshots.paidOn("fake").held.monthly * 100), 168, "the estimate counts the one held at full price");
  assert.ok(state.logs.some((line) => line.startsWith("Could not read what")));
  state.provider.bill = { currency: "USD", included: 10, used: 0, dailyEach: 0.056, refs: [] };
  await state.snapshots.take(COMMAND, box, standing(box), { name: "two" });
  state.tick(BILL_FRESH_MS + 1);
  assert.equal(state.snapshots.paidOn("fake").held.estimate, true, "a bill older than ten minutes counts the account at full price");
});

test("a provider's new-guest restore stops the box, takes its undo, makes a new guest from the snapshot, deletes the old one and starts the new one as the same box", async () => {
  const state = world();
  onProvider(state, 10);
  const box = await readyBox(state);
  write(state, box, "work.txt", "then");
  const target = (await state.snapshots.take(COMMAND, box, standing(box), { name: "then" })).snapshot!;
  write(state, box, "work.txt", "now");
  const old = box.guest!;
  const check = await state.snapshots.checkRestore(COMMAND, box, standing(box), target.id);
  assert.equal(check.fromSnapshot, true);
  assert.equal(check.leavesOnEarlierGuest, 0);
  assert.equal(check.undo?.kind, "snapshot");
  assert.deepEqual(check.undo?.price, PRICE);
  const answer = await state.snapshots.restore(COMMAND, box, standing(box), target.id);
  assert.equal(answer.newGuest, true);
  assert.equal(answer.earlier, null);
  const after = (await state.boxes.find(box.id))!;
  assert.notEqual(after.guest!.ref, old.ref, "the box runs on its new guest");
  assert.equal(after.state, "ready");
  assert.equal(read(state, after, "work.txt"), "then");
  assert.equal(await state.backend.power(old), null, "the old guest is deleted");
  const order = state.provider.order.filter((step) => !step.startsWith("start within"));
  assert.ok(order.indexOf(`adopt snapshot ${target.id}`) > order.indexOf(`take ${answer.undo!.id}`), order.join(" | "));
  const undo = state.store.record(answer.undo!.id)!;
  assert.equal(undo.guest, "current");
  assert.equal(undo.livesOn.ref, after.guest!.ref, "the box's snapshots follow it to its new guest, as they live on the provider");
  assert.equal(state.store.record(target.id)!.livesOn.ref, after.guest!.ref);
  assert.ok(state.kinds(box.id).includes("restored"));
  const undone = await state.snapshots.restore(COMMAND, after, standing(after), undo.id);
  assert.equal(undone.newGuest, true);
  assert.equal(read(state, (await state.boxes.find(box.id))!, "work.txt"), "now", "the undo holds what the restore replaced");
});

test("a new guest that cannot be made puts the box back on its old guest, started, with its undo kept", async () => {
  const state = world();
  onProvider(state, 10);
  const box = await readyBox(state);
  const target = (await state.snapshots.take(COMMAND, box, standing(box), { name: "then" })).snapshot!;
  state.provider.adoptFault = new Error("boat has no machine free just now.");
  const refused = await rejection(state.snapshots.restore(COMMAND, box, standing(box), target.id));
  assert.equal(refused.code, "failed");
  assert.match(refused.message, /could not make box .*'s new guest from "then": boat has no machine free just now\./);
  const after = (await state.boxes.find(box.id))!;
  assert.equal(after.guest!.ref, box.guest!.ref);
  assert.equal(after.state, "ready");
  assert.deepEqual((await state.backend.held()).filter((guest) => guest.owner?.boxId === box.id).map((guest) => guest.ref), [box.guest!.ref], "the part-made guest is deleted");
});

test("a release deletes the box's snapshots that live on the provider, and stops, deleting nothing more, when one cannot be deleted", async () => {
  const state = world();
  onProvider(state, 10);
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  await state.snapshots.take(COMMAND, box, standing(box), { name: "two" });
  state.provider.remove = "failed";
  const stopped = await state.boxes.release(THREAD, box.id, "done with it", BY_COMMAND);
  assert.match(stopped?.error ?? "", /snapshots live on .*'s account, not on the box, and would go on costing after its release, so BB Box released nothing/);
  assert.notEqual(await state.backend.power(box.guest!), null, "the guest is still there");
  await state.boxes.release(THREAD, box.id, "done with it", BY_COMMAND);
  assert.equal(state.provider.held.size, 0, "nothing is left on the provider");
  assert.equal(state.store.records({ box: box.id }).length, 0);
});

test("Keep and fork are refused in plain words where the backend says forks wait", async () => {
  const state = world();
  onProvider(state, 10);
  const box = await readyBox(state);
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "one" })).snapshot!;
  const keep = await rejection(state.snapshots.keep(COMMAND, standing(box), taken.id));
  assert.equal(keep.message, `BB Box keeps only a snapshot it can fork after its box's release, and ${NOT_YET}. So it does not keep "one".`);
  const fork = await rejection(state.snapshots.fork(COMMAND, box, standing(box), taken.id));
  assert.equal(fork.message, `BB Box does not fork "one": ${NOT_YET}.`);
});

function onlyOldGuest(state: World, old: Guest): void {
  const target = state.backend as unknown as Record<string, unknown>;
  const release = target.release as (guest: Guest, hooks: unknown) => Promise<void>;
  target.release = async (guest: Guest, hooks: unknown) => {
    if (guest.ref !== old.ref) throw new Error("the provider did not answer the delete");
    return release(guest, hooks);
  };
}

function startsOnly(state: World, old: Guest): void {
  const target = state.backend as unknown as Record<string, unknown>;
  const start = target.start as (guest: Guest, ...rest: unknown[]) => Promise<unknown>;
  target.start = async (guest: Guest, ...rest: unknown[]) => {
    if (guest.ref !== old.ref) throw new Error("boat cancelled the sandbox");
    return start(guest, ...rest);
  };
}

test("Astra 1: a part-made new guest that cannot be confirmed gone leaves the old guest stopped and the restore unsettled, never both running", async () => {
  const state = world();
  onProvider(state, 10);
  const box = await readyBox(state);
  const target = (await state.snapshots.take(COMMAND, box, standing(box), { name: "then" })).snapshot!;
  state.provider.adoptFault = new Error("boat has no machine free just now.");
  onlyOldGuest(state, box.guest!);
  const refused = await rejection(state.snapshots.restore(COMMAND, box, standing(box), target.id));
  assert.equal(refused.code, "unreachable");
  assert.match(refused.message, /nor confirm the part-made guest .* gone, so it does not start the old guest again: both would act as the box/);
  assert.equal(await state.backend.power(box.guest!), "stopped");
  assert.equal(state.store.unsettled().find((operation) => operation.kind === "restore")?.state, "unknown");
});

test("Astra 2: the old guest stays until the new one starts; a new guest that does not start is deleted and the old one started again", async () => {
  const state = world();
  onProvider(state, 10);
  const box = await readyBox(state);
  write(state, box, "work.txt", "now");
  const target = (await state.snapshots.take(COMMAND, box, standing(box), { name: "then" })).snapshot!;
  const old = box.guest!;
  startsOnly(state, old);
  const refused = await rejection(state.snapshots.restore(COMMAND, box, standing(box), target.id));
  assert.match(refused.message, /Its new guest did not start: boat cancelled the sandbox\. BB Box deleted the new guest and kept the old one\./);
  const after = (await state.boxes.find(box.id))!;
  assert.equal(after.guest!.ref, old.ref);
  assert.equal(after.state, "ready");
  assert.equal(await state.backend.power(old), "running");
  assert.equal(read(state, after, "work.txt"), "now");
  assert.deepEqual((await state.backend.held()).filter((guest) => guest.owner?.boxId === box.id).map((guest) => guest.ref), [old.ref]);
  assert.equal(state.store.record(target.id)!.livesOn.ref, old.ref);
});

test("Astra 2: a new guest that does not start and cannot be confirmed gone starts neither", async () => {
  const state = world();
  onProvider(state, 10);
  const box = await readyBox(state);
  const target = (await state.snapshots.take(COMMAND, box, standing(box), { name: "then" })).snapshot!;
  const old = box.guest!;
  startsOnly(state, old);
  onlyOldGuest(state, old);
  const refused = await rejection(state.snapshots.restore(COMMAND, box, standing(box), target.id));
  assert.equal(refused.code, "unreachable");
  assert.equal(await state.backend.power(old), "stopped", "the old guest is not started while the new one may still run");
});

test("Opus 5 and Astra 3: a restore cut short at its new guest recovers by its recorded method, without a provider task, even if the offer reads otherwise now", async () => {
  const state = world();
  onProvider(state, 10);
  (state.backend as unknown as Record<string, unknown>).findTasks = undefined;
  const box = await readyBox(state);
  write(state, box, "work.txt", "then");
  const target = (await state.snapshots.take(COMMAND, box, standing(box), { name: "then" })).snapshot!;
  write(state, box, "work.txt", "now");
  state.holds.step = "adopted";
  const held = state.snapshots.restore(COMMAND, box, standing(box), target.id).catch((error: unknown) => error);
  await untilHeld(state, held);
  const cut = state.store.unsettled().find((operation) => operation.kind === "restore")!;
  assert.equal((cut.consent as { newGuest?: boolean }).newGuest, true);
  await state.restart();
  await held;
  onProvider(state, 10);
  state.provider.restoreWay = "none";
  (state.backend as unknown as Record<string, unknown>).findTasks = undefined;
  await state.snapshots.recover();
  const operation = state.store.operation(cut.id)!;
  assert.equal(operation.state, "done", operation.error ?? "");
  const after = (await state.boxes.find(box.id))!;
  assert.equal(read(state, after, "work.txt"), "then");
});

test("Astra 4 and Opus 3: a snapshot boat has not listed yet counts beside the bill, done or not, so two takes cannot both pass the ceiling", async () => {
  const state = world();
  onProvider(state, 1);
  state.provider.billFrozen = true;
  state.settings = { ceilings: { fake: 1 } };
  const box = await readyBox(state);
  const first = (await state.snapshots.take(COMMAND, box, standing(box), { name: "one" })).snapshot!;
  assert.equal(first.state, "ready");
  assert.equal(pendingOn(state.store.records({ backend: "fake" }), { currency: "USD", included: 1, used: 0, dailyEach: 0.056, refs: [] }), 1);
  const refused = await rejection(state.snapshots.take(COMMAND, box, standing(box), { name: "two" }));
  assert.match(refused.message, /It would be saved snapshot 2 there, and the plan includes 1\./);
});

test("Astra 5, Opus 6 and R3: with no current account count from the provider, no paid take is admitted, however the account was when last read", async () => {
  const state = world();
  onProvider(state, 10);
  state.provider.bill = { currency: "USD", included: 10, used: 10, dailyEach: 0.056, refs: [] };
  state.settings = { ceilings: { fake: 5 } };
  const box = await readyBox(state);
  await state.snapshots.readBill(state.backend);
  state.provider.bill = new Error("boat did not answer");
  const refused = await rejection(state.snapshots.take(COMMAND, box, standing(box), { name: "one" }));
  assert.match(refused.message, /cannot read what .* bills for snapshots just now/);
  const fresh = world();
  onProvider(fresh, 10);
  fresh.provider.bill = new Error("boat did not answer");
  const other = await readyBox(fresh);
  const none = await rejection(fresh.snapshots.take(COMMAND, other, standing(other), { name: "one" }));
  assert.match(none.message, /cannot read what .* bills for snapshots just now/);
});

test("Astra 5: a snapshot found again after its records were lost keeps its backend's price", async () => {
  const state = world();
  onProvider(state, 10);
  const box = await readyBox(state);
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "one" })).snapshot!;
  state.forgetRecords();
  await state.snapshots.reconcile();
  assert.deepEqual(state.store.record(taken.id)?.price, PRICE);
});

test("Astra 6: a release deletes the box's snapshots the provider lists though BB Box's records lost them, and confirms them gone", async () => {
  const state = world();
  onProvider(state, 10);
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  state.forgetRecords();
  await state.boxes.release(THREAD, box.id, "done with it", BY_COMMAND);
  assert.equal(state.provider.held.size, 0);
  assert.equal(await state.backend.power(box.guest!), null);
});

test("Astra 6: an ended thread's leftover guest goes only after its box's snapshots on the provider are deleted", async () => {
  const state = world();
  onProvider(state, 10);
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  await state.forgetBox(box);
  state.threadState = "ended";
  await state.boxes.sweep();
  await state.boxes.sweep();
  assert.equal(state.provider.held.size, 0);
  assert.equal(await state.backend.power(box.guest!), null);
});

test("R3: a take is refused during a bill outage though the account was empty when last read, as others may have added snapshots since", async () => {
  const state = world();
  onProvider(state, 10);
  state.settings = { ceilings: { fake: 2 } };
  const box = await readyBox(state);
  await state.snapshots.readBill(state.backend);
  state.provider.bill = new Error("account bill unavailable");
  const refused = await rejection(state.snapshots.take(COMMAND, box, standing(box), { name: "admitted" }));
  assert.equal(refused.code, "limit_reached");
  assert.equal(state.provider.held.size, 0);
});

test("R2: a new guest that goes before its access file is written rolls back to the old guest, which no sweep deletes", async () => {
  const state = world();
  onProvider(state, 10);
  const box = await readyBox(state);
  const target = (await state.snapshots.take(COMMAND, box, standing(box), { name: "target" })).snapshot!;
  const old = box.guest!;
  const writeAccess = state.boxes.writeAccess.bind(state.boxes);
  state.boxes.writeAccess = async (current, signal) => {
    if (current.guest!.ref !== old.ref) {
      await state.backend.release(current.guest!, { resetting: async () => {}, timing: () => {} });
      throw new Error("replacement cancelled before access write");
    }
    return writeAccess(current, signal);
  };
  const refused = await rejection(state.snapshots.restore(COMMAND, box, standing(box), target.id));
  assert.match(refused.message, /could not write its new guest's access file: replacement cancelled before access write\. BB Box deleted the new guest and kept the old one\./);
  const after = (await state.boxes.find(box.id))!;
  assert.equal(after.guest!.ref, old.ref);
  assert.equal(await state.backend.power(old), "running");
  await state.boxes.sweep();
  assert.equal(await state.backend.power(old), "running", "the sweep keeps the box's guest");
});

test("R5: a restart while putting the old guest back resumes it from its journalled step, with the box on its old guest and started", async () => {
  const state = world();
  onProvider(state, 10);
  const box = await readyBox(state);
  const target = (await state.snapshots.take(COMMAND, box, standing(box), { name: "target" })).snapshot!;
  const old = box.guest!;
  startsOnly(state, old);
  const update = state.boxes.update.bind(state.boxes);
  let crashed = false;
  state.boxes.update = (async (...args: Parameters<typeof update>) => {
    const operation = state.store.unsettled().find((each) => each.kind === "restore");
    if (!crashed && operation?.step === "swap-back") {
      crashed = true;
      state.snapshots.dispose();
      throw new Error("BB Box stopped while it put the old guest back");
    }
    return update(...args);
  }) as typeof update;
  await state.snapshots.restore(COMMAND, box, standing(box), target.id).catch(() => {});
  assert.ok(crashed);
  const cut = state.store.unsettled().find((each) => each.kind === "restore")!;
  assert.equal(cut.step, "swap-back");
  await state.restart();
  onProvider(state, 10);
  await state.snapshots.recover();
  assert.equal(state.store.operation(cut.id)!.state, "failed");
  const after = (await state.boxes.find(box.id))!;
  assert.equal(after.guest!.ref, old.ref);
  assert.equal(after.state, "ready");
  assert.equal(await state.backend.power(old), "running");
});

test("070 unit 11b: on a provider that keeps a snapshot as it is, Keep holds it past its box's release, a renewal still works, and it forks as one of the person's machines; one taken under an older identity reset is refused in plain words", async () => {
  const state = armedWorld();
  state.provider.onProvider = { price: PRICE, forkSafeFrom: 8 };
  state.provider.restoreWay = "new-guest";
  state.provider.bill = { currency: "USD", included: 10, used: 0, dailyEach: 0.056, refs: [] };
  state.provider.billed();
  const box = await readyBox(state);
  const kept = (await state.snapshots.take(COMMAND, box, standing(box), { name: "kept" })).snapshot!;
  const older = (await state.snapshots.take(COMMAND, box, standing(box), { name: "older" })).snapshot!;
  assert.equal(kept.forkSafe, 9);
  state.store.updateRecord(older.id, { forkSafe: 7 });
  const refused = await rejection(state.snapshots.keep(COMMAND, standing(box), older.id));
  assert.equal(refused.message, `${box.name} had version 7 of the identity reset when "older" was taken, and BB Box forks ${state.backend.label}'s boxes only from version 8: it could not be forked after a release, so BB Box does not keep it.`);
  const answer = await state.snapshots.keep(COMMAND, standing(box), kept.id);
  assert.equal(answer.check.way, "as-is");
  assert.ok(state.provider.labels.some((label) => label.startsWith(`snapshot ${kept.id} kept `)));
  await state.boxes.release(THREAD, box.id, "done with it", BY_COMMAND);
  const after = state.store.record(kept.id)!;
  assert.equal(after.boxGone?.how, "released");
  assert.notEqual(after.keptUntil, null);
  assert.equal(state.store.record(older.id), null, "what was not kept went with its box");
  assert.ok(state.provider.held.has(kept.id), "the kept one stays on the provider's account as it is");
  state.tick(24 * 60 * 60_000);
  const renewed = await state.snapshots.keepGone(after, BY_COMMAND, { days: 30 });
  assert.ok(renewed.snapshot.keptUntil! > after.keptUntil!, "Keep 30 more days works after the release");
  const check = await state.snapshots.checkForkGone(state.store.record(kept.id)!);
  assert.equal(check.asMachine, true, "a fork of a released box's kept snapshot is one of the person's machines");
  assert.equal(check.box, null);
});

test("070 unit 11b review, Astra 6: a provider's kept snapshot found again after its records were lost, past its keep date, keeps that date, so expiry deletes it rather than leaving it costing with no end", async () => {
  const state = armedWorld();
  state.provider.onProvider = { price: PRICE, forkSafeFrom: 8 };
  state.provider.restoreWay = "new-guest";
  state.provider.bill = { currency: "USD", included: 10, used: 0, dailyEach: 0.056, refs: [] };
  state.provider.billed();
  const box = await readyBox(state);
  const kept = (await state.snapshots.take(COMMAND, box, standing(box), { name: "kept" })).snapshot!;
  await state.snapshots.keep(COMMAND, standing(box), kept.id, { days: 1 });
  await state.boxes.release(THREAD, box.id, "done with it", BY_COMMAND);
  assert.ok(state.provider.held.has(kept.id));
  state.forgetRecords();
  state.tick(3 * 24 * 60 * 60_000);
  await state.snapshots.sweep();
  await state.snapshots.sweep();
  assert.equal(state.provider.held.has(kept.id), false, "past its date, it went, as any kept snapshot does");
  assert.equal(state.store.record(kept.id), null);
});

test("a new-guest restore of a box whose backend is no longer kept for its thread's project, after the reservation changed or the thread moved, is refused before anything changes; the box keeps running (#1458)", async () => {
  const state = world({ projectsFromBb: true });
  onProvider(state, 10);
  state.threadProjects.set(THREAD, "proj_work");
  const box = await readyBox(state);
  const target = (await state.snapshots.take(COMMAND, box, standing(box), { name: "then" })).snapshot!;
  const keptForOthers = /^.+ is kept for certain projects, and this thread's project is not one of them, so BB Box cannot make box \S+ a new guest there, as this restore would\. BB Box changed nothing\.$/;

  state.keptFor = ["proj_home"];
  assert.match((await rejection(state.snapshots.checkRestore(COMMAND, box, standing(box), target.id))).message, keptForOthers);
  assert.match((await rejection(state.snapshots.restore(COMMAND, box, standing(box), target.id))).message, keptForOthers);

  state.keptFor = ["proj_work"];
  state.threadProjects.set(THREAD, "proj_home");
  assert.match((await rejection(state.snapshots.restore(COMMAND, box, standing(box), target.id))).message, keptForOthers, "the thread moved");
  const after = (await state.boxes.find(box.id))!;
  assert.equal(after.guest!.ref, box.guest!.ref, "the box keeps its guest");
  assert.equal(after.state, "ready");

  state.threadProjects.set(THREAD, "proj_work");
  assert.equal((await state.snapshots.restore(COMMAND, box, standing(box), target.id)).newGuest, true, "allowed while the thread is in the project");
});
