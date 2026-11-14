import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { scopedStorage } from "../src/backends/index.ts";
import type { Backend, Price } from "../src/backends/types.ts";
import { BY_COMMAND, type BoxEventKind } from "../src/core/box-log.ts";
import { BoxError, Boxes, type BoxRecord } from "../src/core/boxes.ts";
import type { GeneralConfig } from "../src/core/config.ts";
import { checkDocument, emptyDocument, snapshotConfig, type SnapshotSettings } from "../src/core/document.ts";
import { LOST_AFTER_MISSING_MS, keptUntilAfter, snapshotLine, type Caller, type SnapshotOperation, type Standing } from "../src/core/snapshot.ts";
import { Snapshots, type HoldStep } from "../src/core/snapshots.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { quote } from "../src/transports/process.ts";
import { SNAPSHOT_TABLES, migrateFile, moveFromMain, openBoxFiles, unopenedFiles, type DatabaseSource } from "../src/plugin/attached-files.ts";
import { BOX_LOG_MIGRATIONS, BoxLogStore } from "../src/plugin/box-log-store.ts";
import { SNAPSHOT_MIGRATIONS, SnapshotStore } from "../src/plugin/snapshot-store.ts";
import { FakeBackend } from "./fake-backend.ts";
import { FakeSnapshots as Provider, type Held } from "./fake-snapshots.ts";
import { MemoryStorage, tempDir } from "./helpers.ts";

import { COMMAND, DAY, HOUR, THREAD, armedWorld, identityGuest, readyBox, rejection, standing, untilHeld, withIdentitySource, world, writeIn, type World } from "./snapshot-world.ts";

test("a take is recorded and pinned before the backend is asked, records the provider's task before it waits, and is ready once confirmed", async () => {
  const state = world();
  const box = await readyBox(state);
  const answer = await state.snapshots.take(COMMAND, box, standing(box), { note: "a note" });
  assert.equal(state.provider.stepsSeen[0], "task", "the task was recorded before the backend waited on it");
  const snapshot = answer.snapshot!;
  assert.equal(snapshot.state, "ready");
  assert.equal(snapshot.name, "Fri 10:42");
  assert.equal(snapshot.note, "a note");
  assert.deepEqual(snapshot.by, { is: "command" });
  assert.equal(snapshot.ref, `bb${snapshot.id}`);
  assert.equal(snapshot.owner, "thread");
  assert.equal(answer.counted, 1);
  assert.equal(answer.operation.state, "done");
  assert.equal(answer.operation.task?.ref, "task-1");
  assert.equal(state.store.pins().size, 0, "its pin ended with its operation");
  assert.deepEqual(state.kinds(box.id).slice(-1), ["snapshot-taken"]);
  assert.match(state.log.events(box.id).at(-1)!.words!, /^"Fri 10:42" \(sn[a-z2-7]{12}\): disk, in 0\.0 s\.$/);
});

test("a take's check says how long the take pauses the box, by what it holds, and the take keeps the pause its backend measured", async () => {
  const state = world();
  const box = await readyBox(state);
  state.provider.pause = { pauses: true, aboutMs: 5000, basis: { bytes: 1.1e9, of: "disk" } };

  const disk = await state.snapshots.checkTake(COMMAND, box, standing(box));
  const memory = await state.snapshots.checkTake(COMMAND, box, standing(box), { memory: true });

  assert.equal(disk.holds, "disk");
  assert.deepEqual(disk.pause, { pauses: true, aboutMs: 5000, basis: { bytes: 1.1e9, of: "disk" } });
  assert.equal(memory.holds, "disk-and-memory");
  assert.deepEqual(memory.pause, state.provider.memoryPause);
  assert.equal(state.store.records().length, 0, "a check takes nothing");

  state.provider.pausedMs = 3200;
  const taken = (await state.snapshots.take(COMMAND, box, standing(box))).snapshot!;

  assert.equal(taken.pausedMs, 3200);
  assert.match(state.log.events(box.id).at(-1)!.words!, new RegExp(`: disk, in 0\\.0 s\\. It paused ${box.name} for 3\\.2 s\\.$`));
  await state.restart();
  assert.equal(state.store.record(taken.id)?.pausedMs, 3200, "kept in snapshots.db");
});

test("names are unique per box: a repeat gets (2); a long or empty name and a note over 1 KB are refused before anything is recorded", async () => {
  const state = world();
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "before the migration" });
  const second = await state.snapshots.take(COMMAND, box, standing(box), { name: "before the migration" });
  assert.equal(second.snapshot?.name, "before the migration (2)");
  assert.equal((await rejection(state.snapshots.take(COMMAND, box, standing(box), { name: "x".repeat(61) }))).code, "invalid_name");
  assert.equal((await rejection(state.snapshots.take(COMMAND, box, standing(box), { note: "n".repeat(1025) }))).code, "invalid_name");
  assert.equal(state.store.records().length, 2);
});

test("a sixth snapshot is refused, naming the five to delete from; undos do not count", async () => {
  const state = world();
  const box = await readyBox(state);
  for (let n = 1; n <= 5; n++) {
    await state.snapshots.take(COMMAND, box, standing(box), { name: `n${n}` });
    state.tick(60_000);
  }
  const refused = await rejection(state.snapshots.take(COMMAND, box, standing(box)));
  assert.equal(refused.code, "limit_reached");
  assert.equal(refused.message, `Box ${box.name} holds 5 snapshots, and your settings allow 5 a box. Delete one first: "n1", "n2", "n3", "n4", "n5".`);
  state.store.updateRecord(state.store.records()[0]!.id, { undoOf: "oprestore" });
  assert.equal((await state.snapshots.take(COMMAND, box, standing(box))).snapshot?.state, "ready", "an undo is apart from the five");
  const agent: Caller = { is: "agent", threadId: THREAD };
  const refusedAgent = await rejection(state.snapshots.take(agent, box, standing(box)));
  assert.match(refusedAgent.message, /Delete one first: "n2", "n3", "n4", "n5", "Fri 10:47"\.$/);
});

test("room: a take is refused past 85% full, or when it would pass 85%, or past 80% of thin metadata, and reservations of unsettled takes count", async () => {
  const state = world();
  const box = await readyBox(state);
  state.provider.percentFull = 86;
  assert.match((await rejection(state.snapshots.take(COMMAND, box, standing(box)))).message, /storage fast is 86% full, and your settings take no snapshot past 85%/);
  state.provider.percentFull = 84.5;
  const memory = await rejection(state.snapshots.take(COMMAND, box, standing(box), { memory: true }));
  assert.match(memory.message, /would be \d+% full with its memory/);
  state.provider.percentFull = 30;
  state.provider.metadataPercentFull = 81;
  assert.match((await rejection(state.snapshots.take(COMMAND, box, standing(box)))).message, /metadata is 81% full, and BB Box takes no snapshot past 80%, 5 points below your settings' 85%/);
  state.provider.metadataPercentFull = 10;
  state.provider.percentFull = 84;
  const reserved: SnapshotOperation = {
    id: "opreservedaaaa",
    request: null,
    requestDigest: null,
    kind: "take",
    box: "bxother",
    guest: null,
    snapshots: [],
    by: { is: "person" },
    consent: null,
    undo: null,
    guests: null,
    step: "task",
    task: null,
    state: "unknown",
    reserved: { storage: "fake:fast", bytes: 2 * 2 ** 30, price: null },
    error: null,
    startedAt: state.now,
    endedAt: null,
    snapshotsGoneAt: null,
  };
  state.store.insertOperation(reserved);
  assert.match((await rejection(state.snapshots.take(COMMAND, box, standing(box)))).message, /would be 86% full/, "another take's room is still reserved");
  assert.equal(state.store.records().length, 0, "nothing was recorded for a refused take");
});

test("Settings' snapshots per box: a lower limit refuses a take sooner, a higher one allows more, and kept ones still count", async () => {
  const state = world();
  const box = await readyBox(state);
  state.settings = { perBox: 2 };
  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  state.tick(60_000);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "two" });
  const refused = await rejection(state.snapshots.take(COMMAND, box, standing(box), { name: "three" }));
  assert.equal(refused.code, "limit_reached");
  assert.equal(refused.message, `Box ${box.name} holds 2 snapshots, and your settings allow 2 a box. Delete one first: "one", "two".`);
  state.settings = { perBox: 3 };
  assert.equal((await state.snapshots.take(COMMAND, box, standing(box), { name: "three" })).snapshot?.state, "ready");
  state.store.updateRecord(state.store.records()[0]!.id, { keptUntil: state.now + DAY });
  assert.equal((await rejection(state.snapshots.take(COMMAND, box, standing(box)))).code, "limit_reached", "a kept one counts");
});

test("Settings' room: a take is refused past it, and past 5 points below it of thin metadata; the sweep deletes agents' unkept snapshots only 7 points above it", async () => {
  const state = world();
  const box = await readyBox(state);
  state.settings = { roomPercent: 60 };
  state.provider.percentFull = 61;
  assert.match((await rejection(state.snapshots.take(COMMAND, box, standing(box)))).message, /storage fast is 61% full, and your settings take no snapshot past 60%.*raise the limit in Settings, Snapshots\.$/);
  state.provider.percentFull = 40;
  state.provider.metadataPercentFull = 56;
  assert.match((await rejection(state.snapshots.take(COMMAND, box, standing(box)))).message, /metadata is 56% full, and BB Box takes no snapshot past 55%, 5 points below your settings' 60%/);
  state.provider.metadataPercentFull = 10;
  const agent: Caller = { is: "agent", threadId: THREAD };
  const taken = await state.snapshots.take(agent, box, standing(box), { name: "the agent's" });
  assert.equal(taken.snapshot?.state, "ready");
  state.provider.percentFull = 66;
  await state.snapshots.tidy();
  assert.equal(state.store.records().length, 1, "66% is under the sweep's 67%");
  state.provider.percentFull = 68;
  await state.snapshots.tidy();
  assert.equal(state.store.records().length, 0, "past 67%, the sweep deleted the agent's snapshot nobody kept");
  assert.match(state.log.events(box.id).at(-1)!.words ?? "", /the agent's/);
});

test("G10: the paid ceiling bounds the monthly rate held: a take that would pass it is refused before anything is recorded, a lowered ceiling warns and deletes nothing, and a delete keeps the month's spend", async () => {
  const state = world();
  const box = await readyBox(state);
  state.price = { amount: 0.056, currency: "USD", per: "day", known: true };
  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  await state.snapshots.take(COMMAND, box, standing(box), { name: "two" });
  const paid = state.snapshots.paidOn(state.backend.id);
  assert.equal(paid.held.count, 2);
  assert.equal(paid.held.monthly.toFixed(2), "3.36");
  assert.equal(paid.ceiling, 5);
  assert.equal(paid.past, false);
  const refused = await rejection(state.snapshots.take(COMMAND, box, standing(box), { name: "three" }));
  assert.equal(refused.code, "limit_reached");
  assert.equal(refused.message, "It would bring snapshots held on Fake host to about $5.04 a month, past your ceiling of $5.00. Delete one, or raise the ceiling in Settings, Snapshots, Paid snapshots.");
  assert.equal(state.store.records().length, 2, "nothing was recorded for the refused take");
  assert.equal(state.store.unsettled().length, 0);
  state.settings = { ceilings: { [state.backend.id]: 3 } };
  assert.equal(state.snapshots.paidOn(state.backend.id).past, true, "a ceiling lowered below the rate is past");
  await state.snapshots.sweep();
  assert.equal(state.store.records().length, 2, "BB Box never deletes to get under the ceiling");
  assert.match((await rejection(state.snapshots.take(COMMAND, box, standing(box)))).message, /to about \$5\.04 a month, past your ceiling of \$3\.00/);
  state.settings = { ceilings: { [state.backend.id]: 5.04 } };
  assert.equal((await state.snapshots.take(COMMAND, box, standing(box), { name: "three" })).snapshot?.state, "ready", "a rate equal to the ceiling is within it");
  state.tick(12 * HOUR);
  const one = state.store.records().find((record) => record.name === "one")!;
  await state.snapshots.delete(COMMAND, standing(box), one.id);
  state.tick(6 * HOUR);
  const spent = state.snapshots.paidOn(state.backend.id).spent;
  assert.equal(spent.toFixed(4), (0.056 * 0.5 + 0.056 * 0.75 * 2).toFixed(4), "the deleted one's half day is still spent");
  await state.restart();
  assert.equal(state.snapshots.paidOn(state.backend.id).spent.toFixed(4), spent.toFixed(4), "the month's spend outlives a restart");
});

test("a price BB Box does not know is admitted for the person, and refused for an agent", async () => {
  const state = world();
  const box = await readyBox(state);
  state.price = { amount: 0, currency: "USD", per: "day", known: false };
  const agent: Caller = { is: "agent", threadId: THREAD };
  assert.equal((await rejection(state.snapshots.take(agent, box, standing(box)))).message, "BB Box does not know what a snapshot on Fake host costs, so only you can take one there.");
  assert.equal((await state.snapshots.take(COMMAND, box, standing(box))).snapshot?.state, "ready");
  const paid = state.snapshots.paidOn(state.backend.id);
  assert.deepEqual([paid.held.count, paid.held.unknown, paid.held.monthly], [1, 1, 0]);
});

test("a locked guest and a plan that cannot take are refused with their words, before anything is recorded", async () => {
  const state = world();
  const box = await readyBox(state);
  state.provider.locked = { lock: "rollback", fix: "Run `pct unlock 214` on pve-1." };
  const locked = await rejection(state.snapshots.take(COMMAND, box, standing(box)));
  assert.equal(locked.code, "locked");
  assert.equal(locked.message, `Fake host left box ${box.name} locked (rollback), so it takes no snapshot. Run \`pct unlock 214\` on pve-1.`);
  state.provider.locked = null;
  state.provider.takeWhy = "The Proxmox token lacks VM.Snapshot on /pool/bbbox.";
  assert.equal((await rejection(state.snapshots.take(COMMAND, box, standing(box)))).message, `BB Box cannot take a snapshot of box ${box.name} now: The Proxmox token lacks VM.Snapshot on /pool/bbbox.`);
  assert.equal(state.store.records().length, 0);
});

test("a take the provider fails holds nothing and is failed, logged, and removed after 24 hours", async () => {
  const state = world();
  const box = await readyBox(state);
  state.provider.take = "failed";
  const error = await rejection(state.snapshots.take(COMMAND, box, standing(box)));
  assert.equal(error.code, "failed");
  const [failed] = state.store.records();
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.error, "snapshot feature is not available.");
  assert.equal(state.kinds(box.id).at(-1), "snapshot-failed");
  state.tick(23 * HOUR);
  await state.snapshots.tidy();
  assert.equal(state.store.records().length, 1);
  state.tick(HOUR);
  await state.snapshots.tidy();
  assert.equal(state.store.records().length, 0);
});

test("G1: a take the provider leaves part-made is incomplete, never ready; deleting it finishes the clean-up", async () => {
  const state = world();
  const box = await readyBox(state);
  state.provider.take = "incomplete";
  const error = await rejection(state.snapshots.take(COMMAND, box, standing(box)));
  assert.match(error.message, /Part of it is left on .*: delete it to finish the clean-up there\./);
  const [incomplete] = state.store.records();
  assert.equal(incomplete?.state, "incomplete");
  await state.snapshots.sweep();
  assert.equal(state.store.records()[0]?.state, "incomplete", "the reconcile keeps it incomplete, never ready");
  await state.snapshots.delete(COMMAND, standing(box), incomplete!.id);
  assert.equal(state.store.records().length, 0);
  assert.equal(state.provider.held.size, 0);
});

test("a take BB Box cannot confirm stays taking and pinned, and the next sweep settles it from the provider", async () => {
  const state = world();
  const box = await readyBox(state);
  state.provider.take = "unknown";
  const error = await rejection(state.snapshots.take(COMMAND, box, standing(box)));
  assert.equal(error.code, "unreachable");
  const [taking] = state.store.records();
  assert.equal(taking?.state, "taking");
  assert.equal(state.store.unsettled()[0]?.state, "unknown");
  const refused = await rejection(state.snapshots.delete(COMMAND, standing(box), taking!.id));
  assert.match(refused.message, /is in use by the take that began at 10:42 UTC/);
  await state.snapshots.sweep();
  assert.equal(state.store.records()[0]?.state, "ready");
  assert.equal(state.store.unsettled().length, 0);
  assert.match(state.log.events(box.id).at(-1)!.words!, /confirmed after BB Box restarted/);
});

test("G9: two takes at once run one after the other and end in two ready snapshots with their own names", async () => {
  const state = world();
  const box = await readyBox(state);
  let open!: () => void;
  state.provider.gate = new Promise((resolve) => (open = resolve));
  const first = state.snapshots.take(COMMAND, box, standing(box));
  const second = state.snapshots.take(COMMAND, box, standing(box));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(state.store.records().length, 1, "the second waits for the first on the box's queue");
  open();
  state.provider.gate = null;
  const [a, b] = await Promise.all([first, second]);
  assert.equal(state.provider.most, 1);
  assert.deepEqual([a.snapshot?.name, b.snapshot?.name], ["Fri 10:42", "Fri 10:42 (2)"]);
  assert.deepEqual(state.store.records().map((record) => record.state), ["ready", "ready"]);
});

test("G9: a repeated request is the same take, and the same delete, also after the delete finished and after a restart", async () => {
  const state = world();
  const box = await readyBox(state);
  const [a, b] = await Promise.all([state.snapshots.take(COMMAND, box, standing(box), { request: "req-1" }), state.snapshots.take(COMMAND, box, standing(box), { request: "req-1" })]);
  assert.equal(a.operation.id, b.operation.id);
  assert.equal(b.repeated, true);
  assert.equal(state.store.records().length, 1);
  const id = a.snapshot!.id;
  const first = await state.snapshots.delete(COMMAND, standing(box), id, { request: "del-1" });
  assert.equal(first.repeated, false);
  const again = await state.snapshots.delete(COMMAND, standing(box), id, { request: "del-1" });
  assert.equal(again.repeated, true, "the delete's receipt answers once the snapshot is gone");
  assert.equal(again.operation?.id, first.operation?.id);
  assert.equal(again.snapshot, null);
  await state.restart();
  const afterRestart = await state.snapshots.delete(COMMAND, standing(box), id, { request: "del-1" });
  assert.equal(afterRestart.operation?.id, first.operation?.id);
  const take = await state.snapshots.take(COMMAND, box, standing(box), { request: "req-1" });
  assert.equal(take.operation.id, a.operation.id, "and the take's, after a restart");
  assert.equal(take.snapshot, null, "whose snapshot is gone");
});

test("a request ID is bound to its caller, box, kind and arguments: a reuse is refused in plain words, and another caller's is its own", async () => {
  const state = world();
  const one = await readyBox(state);
  const two = await readyBox(state);
  const taken = await state.snapshots.take(COMMAND, one, standing(one), { request: "r", name: "first" });
  const otherBox = await rejection(state.snapshots.take(COMMAND, two, standing(two), { request: "r", name: "first" }));
  assert.equal(otherBox.code, "reused_request");
  assert.equal(otherBox.message, 'Request ID "r" was used already, for another take, delete or restore. Make a new one for this.');
  assert.equal((await rejection(state.snapshots.take(COMMAND, one, standing(one), { request: "r", name: "other" }))).code, "reused_request", "other arguments");
  assert.equal((await rejection(state.snapshots.delete(COMMAND, standing(one), taken.snapshot!.id, { request: "r" }))).code, "reused_request", "a delete with a take's request");
  assert.equal(state.store.records().length, 1);
  const agent: Caller = { is: "agent", threadId: THREAD };
  const agents = await state.snapshots.take(agent, one, standing(one), { request: "r", name: "first" });
  assert.equal(agents.repeated, false, "another caller's request r is its own");
  assert.notEqual(agents.snapshot?.id, taken.snapshot!.id);
  const stranger: Caller = { is: "agent", threadId: "thr_stranger" };
  assert.equal((await rejection(state.snapshots.take(stranger, one, { box: { id: one.id, threadId: THREAD }, runsOn: false }, { request: "r", name: "first" }))).code, "not_owner", "and a stranger gets nothing back");
  assert.equal(state.store.problem, null);
});

test("the same request on two boxes at once makes one take, refuses the other in plain words, and leaves the store sound", async () => {
  const state = world();
  const one = await readyBox(state);
  const two = await readyBox(state);
  const results = await Promise.allSettled([state.snapshots.take(COMMAND, one, standing(one), { request: "both" }), state.snapshots.take(COMMAND, two, standing(two), { request: "both" })]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  const refused = (results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason as BoxError;
  assert.equal(refused.code, "reused_request");
  assert.equal(state.store.records().length, 1);
  assert.equal(state.store.problem, null);
  assert.equal(state.store.checks()[0]?.status, "ok");
});

test("G9: a take and a release: the release waits for the take, then its snapshots go with the box, logged", async () => {
  const state = world();
  const box = await readyBox(state);
  let open!: () => void;
  state.provider.gate = new Promise((resolve) => (open = resolve));
  const take = state.snapshots.take(COMMAND, box, standing(box));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const release = state.boxes.release(THREAD, box.id, "test", BY_COMMAND);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(await state.boxes.find(box.id), "the release waits for the take");
  open();
  state.provider.gate = null;
  const taken = await take;
  assert.equal(taken.snapshot?.state, "ready");
  assert.equal(await release, null);
  assert.equal(state.store.records().length, 0);
  const kinds = state.kinds(box.id);
  assert.deepEqual(kinds.slice(kinds.indexOf("snapshot-taken")), ["snapshot-taken", "released", "snapshot-deleted"]);
  assert.deepEqual(state.log.events(box.id).at(-1)?.by, { is: "bb-box", why: "its box was released" });
});

test("G9: a delete and a take of the same box, and two deletes of one snapshot, end consistent", async () => {
  const state = world();
  const box = await readyBox(state);
  const kept = await state.snapshots.take(COMMAND, box, standing(box), { name: "kept" });
  const [deleted, taken] = await Promise.all([state.snapshots.delete(COMMAND, standing(box), kept.snapshot!.id), state.snapshots.take(COMMAND, box, standing(box), { name: "new" })]);
  assert.equal(deleted.snapshot?.id, kept.snapshot!.id);
  assert.deepEqual(state.store.records().map((record) => record.name), ["new"]);
  const twice = await Promise.allSettled([state.snapshots.delete(COMMAND, standing(box), taken.snapshot!.id), state.snapshots.delete(COMMAND, standing(box), taken.snapshot!.id)]);
  assert.deepEqual(twice.map((each) => each.status), ["fulfilled", "rejected"]);
  assert.match(((twice[1] as PromiseRejectedResult).reason as Error).message, /deleted already/);
  assert.equal(state.provider.held.size, 0);
});

test("restart in the middle of a take: after its task began it is confirmed ready; before the backend was asked it is failed, never taken again", async () => {
  const state = world();
  const box = await readyBox(state);
  state.holds.step = "task";
  const held = state.snapshots.take(COMMAND, box, standing(box), { name: "mid-task" }).catch((error: unknown) => error);
  await untilHeld(state, held);
  assert.equal(state.store.records()[0]?.state, "taking");
  await state.restart();
  await held;
  assert.equal(state.store.unsettled()[0]?.step, "task", "its task was recorded before BB Box stopped");
  assert.equal(await state.snapshots.recover(), 1);
  assert.equal(state.store.records()[0]?.state, "ready");
  assert.equal(state.store.pins().size, 0);

  state.holds.step = "planned";
  const early = state.snapshots.take(COMMAND, box, standing(box), { name: "mid-plan" }).catch((error: unknown) => error);
  await untilHeld(state, early);
  await state.restart();
  await early;
  await state.snapshots.recover();
  const failed = state.store.records().find((record) => record.name === "mid-plan");
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.error, "BB Box restarted before the take began, and fake has no such snapshot.");
  assert.equal(state.provider.held.size, 1, "it was never taken again");
});

test("restart in the middle of a delete: after its task began it is confirmed gone; before the backend was asked it is finished", async () => {
  const state = world();
  const box = await readyBox(state);
  const one = (await state.snapshots.take(COMMAND, box, standing(box), { name: "one" })).snapshot!;
  const two = (await state.snapshots.take(COMMAND, box, standing(box), { name: "two" })).snapshot!;
  state.holds.step = "task";
  const first = state.snapshots.delete(COMMAND, standing(box), one.id).catch((error: unknown) => error);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(state.store.record(one.id)?.state, "deleting");
  await state.restart();
  await first;
  state.holds.step = null;
  await state.snapshots.recover();
  assert.equal(state.store.record(one.id), null);
  assert.match(state.log.events(box.id).at(-1)!.words!, /confirmed after BB Box restarted/);

  state.holds.step = "planned";
  const second = state.snapshots.delete(COMMAND, standing(box), two.id).catch((error: unknown) => error);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await state.restart();
  await second;
  assert.equal(state.provider.held.has(two.id), true, "the backend was never asked");
  await state.snapshots.recover();
  assert.equal(state.store.record(two.id), null);
  assert.equal(state.provider.held.has(two.id), false, "the delete was finished from the step it reached");
  assert.equal(state.store.unsettled().length, 0);
});

test("a delete the provider refuses goes back as it was; one it leaves part-deleted is incomplete", async () => {
  const state = world();
  const box = await readyBox(state);
  const snapshot = (await state.snapshots.take(COMMAND, box, standing(box))).snapshot!;
  state.provider.remove = "failed";
  assert.match((await rejection(state.snapshots.delete(COMMAND, standing(box), snapshot.id))).message, /CT is locked \(backup\)/);
  assert.equal(state.store.record(snapshot.id)?.state, "ready");
  state.provider.remove = "incomplete";
  await rejection(state.snapshots.delete(COMMAND, standing(box), snapshot.id));
  assert.equal(state.store.record(snapshot.id)?.state, "incomplete");
  await state.snapshots.delete(COMMAND, standing(box), snapshot.id);
  assert.equal(state.store.record(snapshot.id), null);
});

test("G2: a listing that fails makes snapshots unavailable, never lost, and they come back ready when it answers", async () => {
  const state = world();
  const box = await readyBox(state);
  const snapshot = (await state.snapshots.take(COMMAND, box, standing(box))).snapshot!;
  state.tick(1000);
  state.provider.listing = new Error("cannot reach the Proxmox API: timed out");
  for (let sweep = 0; sweep < 20; sweep++) {
    await state.snapshots.sweep();
    state.tick(3 * 60_000);
  }
  const unavailable = state.store.record(snapshot.id)!;
  assert.equal(unavailable.state, "unavailable", "an hour cut off");
  assert.match(unavailable.error!, /timed out/);
  assert.equal(state.kinds(box.id).filter((kind) => kind === "snapshot-unavailable").length, 1, "logged once");
  assert.match((await rejection(state.snapshots.delete(COMMAND, standing(box), snapshot.id))).message, /cannot reach .* now/);
  state.provider.listing = null;
  await state.snapshots.sweep();
  assert.equal(state.store.record(snapshot.id)?.state, "ready");
});

test("G2: lost needs two successful listings without it, 10 minutes apart; a lost one goes after 7 days", async () => {
  const state = world();
  const box = await readyBox(state);
  const snapshot = (await state.snapshots.take(COMMAND, box, standing(box))).snapshot!;
  state.tick(1000);
  state.provider.held.delete(snapshot.id);
  await state.snapshots.sweep();
  assert.equal(state.store.record(snapshot.id)?.state, "ready", "once missing is not lost");
  state.tick(LOST_AFTER_MISSING_MS - 1000);
  await state.snapshots.sweep();
  assert.equal(state.store.record(snapshot.id)?.state, "ready");
  state.tick(1000);
  await state.snapshots.sweep();
  assert.equal(state.store.record(snapshot.id)?.state, "lost");
  assert.equal(state.kinds(box.id).at(-1), "snapshot-lost");
  state.tick(7 * DAY);
  await state.snapshots.sweep();
  assert.equal(state.store.record(snapshot.id), null);
});

test("G2: a missing one listed again is ready, and an incomplete one gone from its host is removed", async () => {
  const state = world();
  const box = await readyBox(state);
  const snapshot = (await state.snapshots.take(COMMAND, box, standing(box))).snapshot!;
  state.tick(1000);
  const held = state.provider.held.get(snapshot.id)!;
  state.provider.held.delete(snapshot.id);
  await state.snapshots.sweep();
  state.provider.held.set(snapshot.id, held);
  state.tick(LOST_AFTER_MISSING_MS);
  await state.snapshots.sweep();
  assert.equal(state.store.record(snapshot.id)?.missingSince, null);
  assert.equal(state.store.record(snapshot.id)?.state, "ready");
  held.state = "incomplete";
  await state.snapshots.sweep();
  assert.equal(state.store.record(snapshot.id)?.state, "incomplete");
  state.provider.held.delete(snapshot.id);
  state.tick(1000);
  await state.snapshots.sweep();
  assert.equal(state.store.record(snapshot.id), null);
  assert.deepEqual(state.log.events(box.id).at(-1)?.by, { is: "outside" });
});

test("G2: a backend that leaves the settings makes its snapshots unavailable, and a configuration that removes it is refused, naming them", async () => {
  const state = world();
  const box = await readyBox(state);
  const snapshot = (await state.snapshots.take(COMMAND, box, standing(box))).snapshot!;
  state.tick(1000);
  state.active = false;
  await state.snapshots.sweep();
  assert.equal(state.store.record(snapshot.id)?.state, "unavailable");
  assert.equal(state.store.record(snapshot.id)?.error, "its backend is not in BB Box's settings");
  const held = state.snapshots.heldOn(state.backend.id)!;
  assert.equal(held.words, "1 snapshot on fake, an unknown size, at no charge");
  const problems = checkDocument(emptyDocument(), {}, [], { backends: new Map(), hosts: new Map(), snapshots: new Map([[state.backend.id, held]]) });
  assert.deepEqual(problems, [
    {
      path: `backends.${state.backend.id}`,
      message: `Backend ${state.backend.id} holds 1 snapshot on fake, an unknown size, at no charge, so it cannot be removed or renamed. Delete them first, or forget them with bb box snapshot forget ${state.backend.id}: BB Box then drops its records of them, and they may still exist there and be billed.`,
    },
  ]);
  assert.equal(state.snapshots.forgetBackend(state.backend.id).length, 1);
  assert.equal(state.snapshots.heldOn(state.backend.id), null);
});

test("G3: with snapshots.db's records gone, the next sweep finds every snapshot, kept ones as kept, and deletes none; a gone box's unkept one is listed until the person deletes it", async () => {
  const state = world();
  const box = await readyBox(state);
  const ordinary = (await state.snapshots.take(COMMAND, box, standing(box), { name: "ordinary" })).snapshot!;
  const fromGone: Held = { id: "sngoneaaaaaaaa", box: "bxgoneboxaaaaa", guest: box.guest!, state: "complete", holds: "disk", takenAt: state.now - HOUR, keptUntil: null };
  const keptGone: Held = { id: "snkeptaaaaaaaa", box: "bxkeptboxaaaaa", guest: box.guest!, state: "complete", holds: "disk", takenAt: state.now - HOUR, keptUntil: state.now + 20 * DAY };
  state.provider.held.set(fromGone.id, fromGone);
  state.provider.held.set(keptGone.id, keptGone);
  state.forgetRecords();
  await state.restart();
  state.tick(1000);
  await state.snapshots.sweep();
  const found = new Map(state.store.records().map((record) => [record.id, record]));
  assert.equal(found.size, 3);
  assert.equal(state.provider.held.size, 3, "deletes none");
  const again = found.get(ordinary.id)!;
  assert.equal(again.state, "ready");
  assert.deepEqual(again.by, { is: "unknown" });
  assert.equal(again.name, "Fri 10:42");
  assert.equal(again.box.name, box.name);
  assert.equal(again.boxGone, null);
  const kept = found.get(keptGone.id)!;
  assert.equal(kept.keptUntil, keptGone.keptUntil);
  assert.equal(kept.owner, "person");
  assert.equal(kept.foundAt, null);
  const orphan = found.get(fromGone.id)!;
  assert.notEqual(orphan.foundAt, null);
  assert.equal(orphan.boxGone?.how, "unknown");
  state.tick(7 * DAY - 2000);
  await state.snapshots.sweep();
  assert.equal(state.provider.held.has(fromGone.id), true, "never deleted at once");
  state.tick(60 * DAY);
  await state.snapshots.sweep();
  assert.equal(state.provider.held.has(fromGone.id), true, "a found one stays until the person deletes it");
  assert.equal(state.store.record(fromGone.id)?.foundAt, orphan.foundAt);
  assert.ok(state.logs.some((line) => line.includes(`Found snapshot ${fromGone.id}`) && line.endsWith("It is listed until you delete it.")), state.logs.join("\n"));
  await state.snapshots.deleteGone(state.store.record(fromGone.id)!, BY_COMMAND);
  assert.equal(state.provider.held.has(fromGone.id), false, "the person's delete");
});

test("a record rebuilt from its backend after snapshots.db lost it keeps the size its backend lists", async () => {
  const state = world();
  const box = await readyBox(state);
  state.provider.takenSize = { bytes: 1_100_000_000, means: "whole" };
  state.provider.listsSizes = true;
  const taken = (await state.snapshots.take(COMMAND, box, standing(box))).snapshot!;
  assert.deepEqual(taken.size, { bytes: 1_100_000_000, means: "whole" });

  state.forgetRecords();
  await state.restart();
  state.tick(1000);
  await state.snapshots.sweep();

  assert.deepEqual(state.store.record(taken.id)?.size, { bytes: 1_100_000_000, means: "whole" });
});

test("a forgotten box's snapshots stay as unavailable, marked gone; a released box's go", async () => {
  const state = world();
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box));
  state.active = false;
  await state.boxes.forget(THREAD, box.id, BY_COMMAND);
  const [record] = state.store.records();
  assert.equal(record?.state, "unavailable");
  assert.equal(record?.boxGone?.how, "forgotten");
});

test("an agent sees and deletes only what mayAct lets it; another thread's IDs are not found", async () => {
  const state = world();
  const box = await readyBox(state);
  const byPerson = (await state.snapshots.take(COMMAND, box, standing(box), { name: "the person's" })).snapshot!;
  const agent: Caller = { is: "agent", threadId: THREAD };
  const own = (await state.snapshots.take(agent, box, standing(box), { name: "the agent's" })).snapshot!;
  assert.match((await rejection(state.snapshots.delete(agent, standing(box), byPerson.id))).message, /not taken by an agent of this thread/);
  const stranger: Caller = { is: "agent", threadId: "thr_stranger" };
  const theirs: Standing = { box: { id: box.id, threadId: THREAD }, runsOn: false };
  assert.deepEqual(state.snapshots.visible(stranger, theirs), []);
  const guessed = await rejection(state.snapshots.delete(stranger, theirs, own.id));
  assert.equal(guessed.code, "not_found");
  assert.equal(guessed.message, `That box has no snapshot "${own.id}".`);
  assert.equal((await rejection(state.snapshots.take(stranger, box, theirs))).code, "not_owner");
  const runsOn: Standing = { box: { id: box.id, threadId: THREAD }, runsOn: true };
  const visitor: Caller = { is: "agent", threadId: "thr_visitor" };
  const visiting = (await state.snapshots.take(visitor, box, runsOn, { name: "the visitor's" })).snapshot!;
  assert.deepEqual(state.snapshots.visible(visitor, runsOn).map((record) => record.id), [visiting.id]);
  assert.deepEqual(state.snapshots.seen(visitor, runsOn).hidden, 2);
  await state.snapshots.delete(agent, standing(box), own.id);
});

test("with snapshots.db unwritable, a take is refused before it starts and the doctor fails", async () => {
  const state = world();
  const box = await readyBox(state);
  const broken = unopenedFiles(new Error("disk I/O error"));
  const store = new SnapshotStore({ file: broken.snapshots });
  const snapshots = new Snapshots({ ledger: store, boxes: state.boxes, backends: { get: () => state.backend, active: () => [state.backend] }, notify: () => {}, logError: () => {} });
  const error = await rejection(snapshots.take(COMMAND, box, standing(box)));
  assert.equal(error.code, "unreachable");
  assert.equal(error.message, "BB Box could not set up snapshots.db: disk I/O error. So BB Box takes no snapshot until it can.");
  assert.equal(state.provider.held.size, 0);
  const [check] = store.checks();
  assert.equal(check?.status, "fail");
  assert.equal(check?.id, "snapshots");
});

test("snapshots.db is a file of its own beside BB Box's database, attached with its migrations, and an operation row outlives its snapshot for 30 days only", () => {
  const state = world();
  assert.equal(state.store.file.attached, true);
  assert.equal(state.store.file.spec.file, "snapshots.db");
  assert.equal(state.store.file.migrationsRun, SNAPSHOT_MIGRATIONS.length);
  const [check] = state.store.checks();
  assert.equal(check?.status, "ok");
  assert.match(check!.detail, /^BB Box's records of snapshots and their operations, in snapshots\.db, attached to BB Box's database: 0 snapshots, 0 operations not settled/);
  const done: SnapshotOperation = {
    id: "opdoneaaaaaaaa",
    request: null,
    requestDigest: null,
    kind: "delete",
    box: "bx",
    guest: null,
    snapshots: ["sngoneaaaaaaaa"],
    by: { is: "person" },
    consent: null,
    undo: null,
    guests: null,
    step: "done",
    task: null,
    state: "done",
    reserved: null,
    error: null,
    startedAt: state.now - 31 * DAY,
    endedAt: state.now - 31 * DAY,
    snapshotsGoneAt: null,
  };
  state.store.insertOperation(done);
  state.store.insertOperation({ ...done, id: "oprecentaaaaaa", endedAt: state.now - DAY });
  assert.equal(state.store.prune(state.now), 1);
  assert.ok(state.store.operation("oprecentaaaaaa"));
  assert.equal(state.store.changedSince("sngoneaaaaaaaa", state.now - 2 * DAY), true);
  assert.equal(state.store.changedSince("sngoneaaaaaaaa", state.now), false);
});

const FIRST_BOX_LOG_MIGRATION_HASH = "1d3d8c88fc498e322c14d9c2e6da70f6ce1741b9d0fb03968e67d44fdb0faa3e";

test("the box log's first migration is unchanged, and its next one keeps every event while allowing 070's kinds", () => {
  const root = tempDir("box-log-070");
  const db = new Database(join(root, "data.db"));
  const before = BOX_LOG_MIGRATIONS.slice(0, 3);
  migrateFile(db, "main", "_migrations", before);
  db.prepare("INSERT INTO box_events (box, thread, name, at, kind, who) VALUES ('bx1', 'thr', 'amber-fox', 1, 'stopped', 'person')").run();
  assert.throws(() => db.prepare("INSERT INTO box_events (box, thread, name, at, kind, who) VALUES ('bx1', 'thr', 'amber-fox', 2, 'snapshot-taken', 'person')").run(), /CHECK constraint/);
  assert.equal(migrateFile(db, "main", "_migrations", BOX_LOG_MIGRATIONS.slice(0, 4)), 1);
  db.prepare("INSERT INTO box_events (box, thread, name, at, kind, who) VALUES ('bx1', 'thr', 'amber-fox', 2, 'snapshot-taken', 'person')").run();
  assert.deepEqual(db.prepare("SELECT seq, kind FROM box_events ORDER BY seq").all(), [
    { seq: 1, kind: "stopped" },
    { seq: 2, kind: "snapshot-taken" },
  ]);
  assert.equal(createHash("sha256").update(BOX_LOG_MIGRATIONS[0]!).digest("hex"), FIRST_BOX_LOG_MIGRATION_HASH);
});

test("the box log's migration for identity resets keeps every event and allows identity-reset and enrolled-again (070 unit 2)", () => {
  const root = tempDir("box-log-identity");
  const db = new Database(join(root, "data.db"));
  migrateFile(db, "main", "_migrations", BOX_LOG_MIGRATIONS.slice(0, 4));
  db.prepare("INSERT INTO box_events (box, thread, name, at, kind, who) VALUES ('bx1', 'thr', 'amber-fox', 1, 'snapshot-taken', 'person')").run();
  assert.throws(() => db.prepare("INSERT INTO box_events (box, thread, name, at, kind, who) VALUES ('bx1', 'thr', 'amber-fox', 2, 'identity-reset', 'bb-box')").run(), /CHECK constraint/);
  assert.equal(migrateFile(db, "main", "_migrations", BOX_LOG_MIGRATIONS), 1);
  db.prepare("INSERT INTO box_events (box, thread, name, at, kind, who) VALUES ('bx1', 'thr', 'amber-fox', 2, 'identity-reset', 'bb-box')").run();
  db.prepare("INSERT INTO box_events (box, thread, name, at, kind, who) VALUES ('bx1', 'thr', 'amber-fox', 3, 'enrolled-again', 'bb-box')").run();
  assert.deepEqual(db.prepare("SELECT seq, kind FROM box_events ORDER BY seq").all(), [
    { seq: 1, kind: "snapshot-taken" },
    { seq: 2, kind: "identity-reset" },
    { seq: 3, kind: "enrolled-again" },
  ]);
});

async function heldAt(state: World, step: "task" | "planned", work: () => Promise<unknown>): Promise<void> {
  state.holds.step = step;
  const running = work().catch((error: unknown) => error);
  await untilHeld(state, running);
  await state.restart();
  await running;
  state.holds.step = null;
}

test("after a restart, a take whose task Proxmox no longer has and whose snapshot is absent stays unknown and pinned, never failed", async () => {
  const state = world();
  const box = await readyBox(state);
  await heldAt(state, "task", () => state.snapshots.take(COMMAND, box, standing(box), { name: "vanished" }));
  const [record] = state.store.records();
  state.provider.held.delete(record!.id);
  state.provider.tasks.clear();
  await state.snapshots.recover();
  assert.equal(state.store.record(record!.id)?.state, "taking");
  const [operation] = state.store.unsettled();
  assert.equal(operation?.state, "unknown");
  assert.match(operation!.error!, /no longer has its task, and fake has no such snapshot, so BB Box cannot tell how it ended/);
  assert.equal(state.store.pins().has(record!.id), true, "its pin stays");
});

test("after a restart, a task BB Box cannot read leaves the operation unknown and pinned, whatever the listing shows", async () => {
  const state = world();
  const box = await readyBox(state);
  await heldAt(state, "task", () => state.snapshots.take(COMMAND, box, standing(box), { name: "unread" }));
  state.provider.tasksReadable = false;
  await state.snapshots.recover();
  const [operation] = state.store.unsettled();
  assert.equal(operation?.state, "unknown");
  assert.match(operation!.error!, /could not read its task on fake: cannot reach the provider's task list/);
  state.provider.tasksReadable = true;
  await state.snapshots.recover();
  assert.equal(state.store.records()[0]?.state, "ready", "and settles once the task reads OK");
});

test("a take is ready only when its task succeeded: a failed task with a whole-looking snapshot is incomplete, in a take and after a restart", async () => {
  const state = world();
  const box = await readyBox(state);
  state.provider.take = "ok-task-failed";
  await rejection(state.snapshots.take(COMMAND, box, standing(box), { name: "now" }));
  assert.equal(state.store.records()[0]?.state, "incomplete");
  await heldAt(state, "task", () => state.snapshots.take(COMMAND, box, standing(box), { name: "after" }));
  const after = state.store.records().find((record) => record.name === "after")!;
  for (const [ref, outcome] of state.provider.tasks) if (outcome.state === "ok") state.provider.tasks.set(ref, { state: "failed", words: "vmstate save failed" });
  await state.snapshots.recover();
  const settled = state.store.record(after.id)!;
  assert.equal(settled.state, "incomplete");
  assert.match(settled.error!, /^Proxmox's task failed \(vmstate save failed\), though it left the snapshot with no part-made state/);
});

test("the gap between asking the provider and recording its task: an accepted take whose answer was lost is found and confirmed; one that never arrived is failed, after a restart", async () => {
  const state = world();
  const box = await readyBox(state);
  state.provider.submit = "answer-lost";
  assert.equal((await rejection(state.snapshots.take(COMMAND, box, standing(box), { name: "accepted" }))).code, "unreachable");
  const accepted = state.store.records()[0]!;
  assert.equal(accepted.state, "taking");
  assert.equal(state.store.unsettled()[0]?.step, "submitting");
  assert.equal(state.store.unsettled()[0]?.task, null);
  state.tick(1000);
  state.provider.submit = "never-arrived";
  await rejection(state.snapshots.take(COMMAND, box, standing(box), { name: "never" }));
  await state.restart();
  await state.snapshots.recover();
  assert.equal(state.store.record(accepted.id)?.state, "ready", "its task was found by its guest and time, and read OK");
  const never = state.store.records().find((record) => record.name === "never")!;
  assert.equal(never.state, "failed");
  assert.equal(never.error, "fake has no task and no snapshot for it: the take did not begin.");
  assert.equal(state.store.unsettled().length, 0);
});

test("a release during a sweep's listing leaves no ghost record and no false lost", async () => {
  const state = world();
  const box = await readyBox(state);
  const snapshot = (await state.snapshots.take(COMMAND, box, standing(box))).snapshot!;
  state.tick(1000);
  let open!: () => void;
  state.provider.listingGate = new Promise((resolve) => (open = resolve));
  const sweeping = state.snapshots.reconcile();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await state.boxes.release(THREAD, box.id, "test", BY_COMMAND);
  state.provider.held.delete(snapshot.id);
  state.provider.listingGate = null;
  open();
  await sweeping;
  assert.deepEqual(state.store.records(), [], "the stale listing found nothing to record again");
  state.tick(LOST_AFTER_MISSING_MS * 2);
  await state.snapshots.sweep();
  assert.deepEqual(state.kinds(box.id).filter((kind) => kind === "snapshot-lost"), []);
});

test("the sweeps together: a leftover guest of an ended thread goes at once with its found snapshots; one whose thread BB has not said ended twice stays", async () => {
  const state = world();
  const found = await readyBox(state);
  const plain = await readyBox(state);
  await state.snapshots.take(COMMAND, found, standing(found));
  await state.forgetBox(found);
  await state.forgetBox(plain);
  state.forgetRecords();
  state.threadState = "ended";
  state.tick(1000);
  await state.snapshots.sweep();
  await state.boxes.sweep();
  assert.notEqual(await state.backend.power(found.guest!), null, "BB said the thread ended once only");
  assert.equal(state.store.records().length, 1, "found again");
  state.tick(3 * 60_000);
  await state.snapshots.sweep();
  await state.boxes.sweep();
  assert.equal(await state.backend.power(found.guest!), null, "the guest with a found snapshot goes at once");
  assert.equal(await state.backend.power(plain.guest!), null, "the other leftover goes");
  assert.equal(state.provider.held.size, 0);
  assert.equal(state.store.records().length, 0, "its found snapshot's record went with it");
  assert.equal(state.log.events(found.id).at(-1)?.kind, "snapshot-deleted");
  assert.match(state.log.events(found.id).at(-1)?.words ?? "", /it went with guest /);
});

test("a leftover guest of an ended thread with a kept snapshot gets its held copy first, then goes; the copy stays kept", async () => {
  const state = armedWorld();
  const box = await readyBox(state);
  writeIn(state, box, "home/state.txt", "kept work");
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "kept one" })).snapshot!;
  await state.snapshots.keep(COMMAND, standing(box), taken.id, { days: 30 });
  await state.forgetBox(box);
  state.threadState = "ended";
  for (let sweep = 0; sweep < 2; sweep++) {
    await state.snapshots.sweep();
    await state.boxes.sweep();
    state.tick(3 * 60_000);
  }
  assert.equal(await state.backend.power(box.guest!), null, "the leftover goes once its copy is made");
  const kept = state.store.record(taken.id)!;
  assert.equal(kept.guest, "held-copy");
  assert.equal(kept.keptUntil, keptUntilAfter(Date.UTC(2026, 9, 30, 10, 42), 30));
  assert.equal(state.provider.copies.get(kept.livesOn.ref)?.state, "template");
  assert.ok(state.provider.order.indexOf(`copy-snapshot ${taken.id}`) >= 0);
  assert.ok(state.boxLogs.some((line) => line.startsWith(`Releasing guest ${box.guest!.ref}`)), state.boxLogs.join("\n"));
});

test("with snapshots.db unreadable, the box sweep keeps every leftover guest", async () => {
  const state = world();
  const box = await readyBox(state);
  await state.forgetBox(box);
  state.threadState = "ended";
  const broken = new Snapshots({ ledger: new SnapshotStore({ file: unopenedFiles(new Error("disk I/O error")).snapshots }), boxes: state.boxes, backends: { get: () => state.backend, active: () => [state.backend] }, notify: () => {}, logError: () => {} });
  assert.match(broken.holdsGuest(state.backend.id, box.guest!.ref)!, /cannot read its snapshots' records/);
});

test("a memory take checks and reserves the storage Proxmox saves the memory on, and is refused when BB Box cannot plan it", async () => {
  const state = world();
  const box = await readyBox(state);
  state.provider.memoryStorage = { ...state.provider.storage(), key: "fake:state", name: "state", percentFull: 99, usedBytes: 99 * 2 ** 30 };
  assert.match((await rejection(state.snapshots.take(COMMAND, box, standing(box), { memory: true }))).message, /storage state is 99% full/);
  assert.equal((await state.snapshots.take(COMMAND, box, standing(box))).snapshot?.state, "ready", "a disk take does not use it");
  state.provider.memoryStorage = null;
  state.provider.memoryWhy = "Proxmox would save its memory on one of a, b, and BB Box cannot tell which.";
  assert.equal(
    (await rejection(state.snapshots.take(COMMAND, box, standing(box), { memory: true }))).message,
    `BB Box cannot take a snapshot of box ${box.name} with its memory: Proxmox would save its memory on one of a, b, and BB Box cannot tell which.`,
  );
});

test("reservations are by physical storage: another backend's unsettled take on the same pool counts, one on another pool does not", async () => {
  const state = world();
  const box = await readyBox(state);
  state.provider.percentFull = 84;
  const elsewhere: SnapshotOperation = {
    id: "opotherbackend",
    request: null,
    requestDigest: null,
    kind: "take",
    box: "bxonanotherbackend",
    guest: "3250",
    snapshots: [],
    by: { is: "person" },
    consent: null,
    undo: null,
    guests: null,
    step: "task",
    task: null,
    state: "unknown",
    reserved: { storage: "fake:fast", bytes: 2 * 2 ** 30, price: null },
    error: null,
    startedAt: state.now,
    endedAt: null,
    snapshotsGoneAt: null,
  };
  state.store.insertOperation(elsewhere);
  assert.match((await rejection(state.snapshots.take(COMMAND, box, standing(box)))).message, /would be 86% full/);
  state.provider.storageKey = "fake:other";
  assert.equal((await state.snapshots.take(COMMAND, box, standing(box))).snapshot?.state, "ready");
});

test("an operation's receipt lasts 30 days from the removal of its last snapshot, not from its end", async () => {
  const state = world();
  const box = await readyBox(state);
  const taken = await state.snapshots.take(COMMAND, box, standing(box), { request: "old" });
  state.tick(40 * DAY);
  await state.snapshots.delete(COMMAND, standing(box), taken.snapshot!.id);
  assert.equal(state.store.prune(state.now), 0);
  assert.ok(state.store.operation(taken.operation.id), "the take's receipt is kept");
  state.tick(30 * DAY - 1000);
  state.store.prune(state.now);
  assert.ok(state.store.operation(taken.operation.id));
  state.tick(2000);
  state.store.prune(state.now);
  assert.equal(state.store.operation(taken.operation.id), null);
});

test("an existing snapshots.db that cannot be opened fails closed: no empty ledger, takes refused, the doctor fails", () => {
  const root = tempDir("snapshots-closed");
  writeFileSync(join(root, "snapshots.db"), "this is not a database file, and it is long enough to be read as one".repeat(200));
  let handle: Database.Database | null = null;
  const files = openBoxFiles({ database: () => (handle?.open ? handle : (handle = new Database(join(root, "data.db")))) as never }, { log: BOX_LOG_MIGRATIONS, history: [], snapshots: SNAPSHOT_MIGRATIONS });
  assert.equal(files.shared, false, "the box log still attaches");
  assert.match(files.snapshots.problem ?? "", /^its existing snapshots\.db cannot be opened: /);
  const store = new SnapshotStore({ file: files.snapshots });
  assert.match(store.problem ?? "", /^BB Box could not set up snapshots\.db: its existing snapshots\.db cannot be opened/);
  assert.equal(store.checks()[0]?.status, "fail");
  assert.match(store.checks()[0]!.detail, /^BB Box could not set up its snapshots' records in snapshots\.db: its existing snapshots\.db cannot be opened/);
  const inMain = handle!.prepare("SELECT COUNT(*) AS count FROM main.sqlite_master WHERE name = 'snapshots'").get() as { count: number };
  assert.equal(inMain.count, 0, "no empty ledger in BB Box's database");
});

test("records kept in BB Box's database while its handle refused to attach move into snapshots.db once it can", () => {
  const root = tempDir("snapshots-move");
  let plain: Database.Database | null = null;
  const open = () => (plain?.open ? plain : (plain = new Database(join(root, "data.db"))));
  const refusing: DatabaseSource = {
    database: () =>
      new Proxy(open(), {
        get(target, key) {
          if (key === "prepare") return (sql: string) => {
            if (/^ATTACH/i.test(sql)) throw new Error("this handle attaches nothing");
            return target.prepare(sql);
          };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as never,
  };
  const first = openBoxFiles(refusing, { log: BOX_LOG_MIGRATIONS, history: [], snapshots: SNAPSHOT_MIGRATIONS });
  assert.equal(first.snapshots.attached, false);
  assert.equal(first.snapshots.problem, null, "no file yet, so the fallback is allowed");
  const operation: SnapshotOperation = {
    id: "opbeforemoving",
    request: null,
    requestDigest: null,
    kind: "take",
    box: "bxmoving",
    guest: "1",
    snapshots: [],
    by: { is: "person" },
    consent: null,
    undo: null,
    guests: null,
    step: "done",
    task: null,
    state: "done",
    reserved: null,
    error: null,
    startedAt: 1,
    endedAt: 2,
    snapshotsGoneAt: null,
  };
  new SnapshotStore({ file: first.snapshots }).insertOperation(operation);
  const second = openBoxFiles({ database: open as never }, { log: BOX_LOG_MIGRATIONS, history: [], snapshots: SNAPSHOT_MIGRATIONS });
  assert.equal(second.snapshots.attached, true);
  assert.equal(second.snapshotsMoved, 1);
  assert.equal(new SnapshotStore({ file: second.snapshots }).operation("opbeforemoving")?.state, "done");
  assert.equal(moveFromMain(open(), second.snapshots.spec, SNAPSHOT_TABLES), 0, "nothing is left to move");
});

test("box_status counts every snapshot against the limit while naming only those the caller may see", async () => {
  const state = world();
  const box = await readyBox(state);
  for (const name of ["a", "b", "c"]) await state.snapshots.take(COMMAND, box, standing(box), { name });
  const visitor: Caller = { is: "agent", threadId: "thr_visitor" };
  const runsOn: Standing = { box: { id: box.id, threadId: THREAD }, runsOn: true };
  await state.snapshots.take(visitor, box, runsOn, { name: "mine" });
  const seen = state.snapshots.seen(visitor, runsOn);
  assert.deepEqual(seen.records.map((record) => record.name), ["mine"]);
  assert.equal(seen.hidden, 3);
  assert.equal(seen.counted, 4);
});


test("a box is first ready with its identity marker, written with its backend's source, and each take records the reset's version as forkSafe", async () => {
  const guest = identityGuest();
  const state = world({ identityTool: guest.tool, identityRoot: guest.root });
  withIdentitySource(state, "eth");
  const box = await readyBox(state);
  assert.equal(readFileSync(join(guest.root, "etc/bb-box/identity"), "utf8"), `bb-box identity 1\nbox ${box.id}\nsource eth\nmac bc:24:11:aa:f1:b6\n`);
  assert.equal(typeof box.timings.identity, "number");
  assert.equal(typeof box.identityMarkedAt, "number", "BB Box records that it armed the box, so only armed boxes are checked for a reset");
  assert.deepEqual(state.boxLogs.filter((line) => line.includes("identity marker")), []);
  const taken = (await state.snapshots.take(COMMAND, box, standing(box))).snapshot!;
  assert.equal(taken.forkSafe, 9);
  assert.equal(state.store.record(taken.id)?.forkSafe, 9, "kept on the record, so a restart keeps it");
  assert.doesNotMatch(snapshotLine(taken), /identity reset/);
});

test("a take is not fork-safe, and says so, when the box's image has no identity reset, its backend writes no marker, its marker no longer matches, or its boot check did not run", async () => {
  const notForkSafe = async (state: World, box: BoxRecord, why: string) => {
    const taken = (await state.snapshots.take(COMMAND, box, standing(box))).snapshot!;
    assert.equal(taken.state, "ready", why);
    assert.equal(taken.forkSafe, null, why);
    assert.match(snapshotLine(taken), new RegExp(`not fork-safe: ${box.name} had no working identity reset when it was taken`), why);
  };
  const older = world();
  withIdentitySource(older, "eth");
  const olderBox = await readyBox(older);
  assert.ok(older.boxLogs.some((line) => line === `Wrote no identity marker in box ${olderBox.name}, so a copy of it would not reset, and its snapshots cannot be forked: its image has no identity reset.`));
  await notForkSafe(older, olderBox, "an image from before the change");

  const unsettled = identityGuest();
  const noSource = world({ identityTool: unsettled.tool, identityRoot: unsettled.root });
  await notForkSafe(noSource, await readyBox(noSource), "a backend whose identity source is not settled writes no marker");
  assert.equal(readFileSync(join(unsettled.root, "run/bb-box-identity/boot"), "utf8"), "unarmed\n");

  const changed = identityGuest();
  const moved = world({ identityTool: changed.tool, identityRoot: changed.root });
  withIdentitySource(moved, "eth");
  const movedBox = await readyBox(moved);
  const links = join(changed.root, "ip-link.json");
  writeFileSync(links, readFileSync(links, "utf8").replace("bc:24:11:aa:f1:b6", "bc:24:11:00:00:01"));
  await notForkSafe(moved, movedBox, "its MAC addresses changed since the marker was written, so it would reset at its next boot");

  const unwired = identityGuest({ booted: false });
  const noBoot = world({ identityTool: unwired.tool, identityRoot: unwired.root });
  withIdentitySource(noBoot, "eth");
  await notForkSafe(noBoot, await readyBox(noBoot), "the boot check never ran, so its unit is not wired");

  const switchedOff = identityGuest();
  const off = world({ identityTool: switchedOff.tool, identityRoot: switchedOff.root, markersOn: false });
  withIdentitySource(off, "eth");
  const offBox = await readyBox(off);
  assert.equal(existsSync(join(switchedOff.root, "etc/bb-box/identity")), false, "markers are off for its backend until the rollout turns them on");
  assert.equal(offBox.identityMarkedAt ?? null, null);
  await notForkSafe(off, offBox, "its backend's markers are off");

  const offImage = identityGuest({ on: false });
  const image = world({ identityTool: offImage.tool, identityRoot: offImage.root });
  withIdentitySource(image, "eth");
  const imageBox = await readyBox(image);
  assert.ok(image.boxLogs.some((line) => line.startsWith(`Wrote no identity marker in box ${imageBox.name}`) && line.includes("the identity reset is off in this image")), image.boxLogs.join("\n"));
  await notForkSafe(image, imageBox, "an image whose build left the reset off");
});

test("070 unit 11b review, Opus 4: a value-source box that a reset left with no marker gets it written again at its next start; a box unarmed by hand and a MAC-source box are left as they are", async () => {
  const unmark = (root: string, boot: string) => {
    for (const file of ["etc/bb-box/identity", "var/lib/bb-box/identity-armed"]) spawnSync("rm", ["-f", join(root, file)]);
    mkdirSync(join(root, "run/bb-box-identity"), { recursive: true });
    writeFileSync(join(root, "run/bb-box-identity/boot"), `${boot}\n`);
  };
  const restart = async (state: World, box: BoxRecord) => {
    await state.boxes.stop(THREAD, box.id);
    await state.boxes.start(THREAD, box.id);
  };
  const guest = identityGuest({ booted: false });
  assert.equal(spawnSync(guest.tool, ["boot", "--value", "bxpending"]).status, 0);
  const state = world({ identityTool: guest.tool, identityRoot: guest.root });
  withIdentitySource(state, "value");
  const box = await readyBox(state);
  unmark(guest.root, "reset");
  await restart(state, box);
  assert.equal(readFileSync(join(guest.root, "etc/bb-box/identity"), "utf8"), `bb-box identity 1\nbox ${box.id}\nsource value\nvalue bxpending\n`);
  assert.ok(state.boxLogs.some((line) => line === `Wrote box ${box.name}'s identity marker again: a reset had left it none, as it found no value to write one with.`), state.boxLogs.join("\n"));
  unmark(guest.root, "unarmed");
  await restart(state, box);
  assert.equal(existsSync(join(guest.root, "etc/bb-box/identity")), false, "unarmed by hand, it stays unarmed");
  const lxc = identityGuest();
  const proxmox = world({ identityTool: lxc.tool, identityRoot: lxc.root });
  withIdentitySource(proxmox, "eth");
  const lxcBox = await readyBox(proxmox);
  unmark(lxc.root, "reset");
  await restart(proxmox, lxcBox);
  assert.equal(existsSync(join(lxc.root, "etc/bb-box/identity")), false, "Proxmox's boxes are as they were");
});

test("a Docker box's marker holds the value its start saw, and a box whose start saw none is not armed", async () => {
  const guest = identityGuest({ booted: false });
  assert.equal(spawnSync(guest.tool, ["boot", "--value", "bxpending"]).status, 0);
  const state = world({ identityTool: guest.tool, identityRoot: guest.root });
  withIdentitySource(state, "value");
  const box = await readyBox(state);
  assert.equal(readFileSync(join(guest.root, "etc/bb-box/identity"), "utf8"), `bb-box identity 1\nbox ${box.id}\nsource value\nvalue bxpending\n`);
  assert.equal((await state.snapshots.take(COMMAND, box, standing(box))).snapshot?.forkSafe, 9);

  const before = identityGuest();
  const old = world({ identityTool: before.tool, identityRoot: before.root });
  withIdentitySource(old, "value");
  const oldBox = await readyBox(old);
  assert.ok(old.boxLogs.some((line) => line.startsWith(`Wrote no identity marker in box ${oldBox.name}`) && line.includes("this boot saw no value from bb-box")), old.boxLogs.join("\n"));
  assert.equal(oldBox.state, "ready");
});
