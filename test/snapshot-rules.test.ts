import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANGES,
  FOUND_KEPT_MS,
  SNAPSHOTS_PER_BOX,
  countsAgainstLimit,
  eligible,
  judgeEach,
  limitVictim,
  mayAct,
  nameProblem,
  newOperationId,
  newSnapshotId,
  noteProblem,
  roomCandidates,
  timeName,
  undoToReplace,
  uniqueName,
  type Caller,
  type SnapshotOperation,
  type SnapshotRecord,
  type Standing,
} from "../src/core/snapshot.ts";
import { SET_NOW, operation, record } from "./snapshot-fixtures.ts";

const NOW = SET_NOW;
const MINUTE = 60_000;
const THREAD = "thr_one";
const OTHER = "thr_other";
const AGENT: Caller = { is: "agent", threadId: THREAD };
const PERSON: Caller = { is: "person" };
const COMMAND: Caller = { is: "command" };

function pinsOf(...operations: SnapshotOperation[]): Map<string, SnapshotOperation> {
  const pins = new Map<string, SnapshotOperation>();
  for (const each of operations) if (each.state === "running" || each.state === "unknown") for (const id of each.snapshots) pins.set(id, each);
  return pins;
}

const own: Standing = { box: { id: "bxamberfox2q7k", threadId: THREAD }, runsOn: false };
const runsOnIt: Standing = { box: { id: "bxamberfox2q7k", threadId: OTHER }, runsOn: true };
const anothers: Standing = { box: { id: "bxamberfox2q7k", threadId: OTHER }, runsOn: false };

test("IDs are sn or op and 12 letters and digits, and a name is the time, unique per box with (2) and (3)", () => {
  let seed = 0;
  const random = (bytes: number) => Uint8Array.from({ length: bytes }, () => seed++);
  assert.match(newSnapshotId(random), /^sn[a-z2-7]{12}$/);
  assert.match(newOperationId(random), /^op[a-z2-7]{12}$/);
  assert.equal(timeName(NOW, "UTC"), "Fri 10:42");
  assert.equal(uniqueName("Fri 10:42", new Set()), "Fri 10:42");
  assert.equal(uniqueName("Fri 10:42", new Set(["Fri 10:42"])), "Fri 10:42 (2)");
  assert.equal(uniqueName("Fri 10:42", new Set(["Fri 10:42", "Fri 10:42 (2)"])), "Fri 10:42 (3)");
  const long = "x".repeat(60);
  assert.equal([...uniqueName(long, new Set([long]))].length, 60, "a repeat of a 60-character name stays within 60");
  assert.equal(nameProblem("before the migration"), null);
  assert.match(nameProblem("   ")!, /at least one character/);
  assert.match(nameProblem("y".repeat(61))!, /at most 60 characters/);
  assert.match(nameProblem("two\nlines")!, /one line/);
  assert.equal(noteProblem("n".repeat(1024)), null);
  assert.match(noteProblem("é".repeat(513))!, /at most 1024 bytes; this one is 1026/);
});

test("a pinned snapshot is refused for every change, and the refusal names the operation using it", () => {
  const target = record({ undoOf: "opundo", keptUntil: NOW + 10 * MINUTE });
  const restore = operation("restore", [target.id], { startedAt: Date.UTC(2026, 9, 30, 11, 2) });
  for (const change of CHANGES) {
    const verdict = eligible(target, change, { pin: restore, now: NOW });
    assert.equal(verdict.ok, false, change);
    assert.match((verdict as { why: string }).why, /in use by the restore that began at 11:02 UTC/, change);
  }
});

test("pins end with their operation: done, failed, and settled after a restart", () => {
  const target = record();
  for (const state of ["done", "failed"] as const) {
    const ended = operation("restore", [target.id], { state, endedAt: NOW });
    assert.equal(pinsOf(ended).size, 0, state);
    assert.ok(eligible(target, "delete", { pin: pinsOf(ended).get(target.id) ?? null, now: NOW }).ok, state);
  }
  const unknown = operation("restore", [target.id], { state: "unknown" });
  assert.equal(pinsOf(unknown).get(target.id), unknown, "an operation bb-box could not confirm still pins");
});

test("automatic deletions never take a kept snapshot, the person's, an undo, or one an agent did not take", () => {
  const cases: [Partial<SnapshotRecord>, RegExp][] = [
    [{ keptUntil: NOW + 30 * 24 * 60 * MINUTE }, /is kept/],
    [{ owner: "person" }, /is the person's/],
    [{ undoOf: "oprestore" }, /is an undo/],
    [{ by: { is: "person" } }, /not taken by an agent/],
    [{ by: { is: "command" } }, /not taken by an agent/],
    [{ by: { is: "unknown" } }, /not taken by an agent/],
    [{ state: "incomplete" }, /is incomplete/],
  ];
  for (const change of ["evict-limit", "evict-room"] as const) {
    assert.ok(eligible(record(), change, { pin: null, now: NOW }).ok, change);
    for (const [fields, why] of cases) {
      const verdict = eligible(record(fields), change, { pin: null, now: NOW });
      assert.equal(verdict.ok, false, `${change} ${JSON.stringify(fields)}`);
      assert.match((verdict as { why: string }).why, why);
    }
  }
});

test("a delete is refused while it is taken, deleted or unreachable, and allowed for ready, failed, incomplete and lost ones", () => {
  for (const state of ["ready", "failed", "incomplete", "lost"] as const) assert.ok(eligible(record({ state }), "delete", { pin: null, now: NOW }).ok, state);
  assert.match((eligible(record({ state: "taking" }), "delete", { pin: null, now: NOW }) as { why: string }).why, /still being taken/);
  assert.match((eligible(record({ state: "deleting" }), "delete", { pin: null, now: NOW }) as { why: string }).why, /being deleted already/);
  assert.match((eligible(record({ state: "unavailable" }), "delete", { pin: null, now: NOW }) as { why: string }).why, /cannot reach pve-1 now/);
});

test("expiry takes only a snapshot past its keep date, and found orphans go after 7 days unless kept", () => {
  assert.equal(eligible(record({ keptUntil: NOW + 1 }), "expire", { pin: null, now: NOW }).ok, false);
  assert.equal(eligible(record(), "expire", { pin: null, now: NOW }).ok, false);
  assert.ok(eligible(record({ keptUntil: NOW - 1 }), "expire", { pin: null, now: NOW }).ok);
  const found = record({ foundAt: NOW - FOUND_KEPT_MS + MINUTE, boxGone: { at: NOW, how: "unknown" } });
  assert.equal(eligible(found, "remove-found", { pin: null, now: NOW }).ok, false, "found less than 7 days ago");
  assert.ok(eligible(found, "remove-found", { pin: null, now: NOW + MINUTE }).ok);
  assert.equal(eligible({ ...found, keptUntil: NOW + 7 * 24 * 60 * MINUTE }, "remove-found", { pin: null, now: NOW + MINUTE }).ok, false, "a found snapshot with a keep date stays");
  assert.equal(eligible(record(), "remove-found", { pin: null, now: NOW }).ok, false, "one in bb-box's records is no orphan");
});

test("keep needs a ready snapshot; unkeep a kept one; rename and note anything not being deleted", () => {
  assert.ok(eligible(record(), "keep", { pin: null, now: NOW }).ok);
  assert.equal(eligible(record({ state: "incomplete" }), "keep", { pin: null, now: NOW }).ok, false);
  assert.equal(eligible(record(), "unkeep", { pin: null, now: NOW }).ok, false);
  assert.ok(eligible(record({ keptUntil: NOW + 1 }), "unkeep", { pin: null, now: NOW }).ok);
  assert.ok(eligible(record({ state: "lost" }), "rename", { pin: null, now: NOW }).ok);
  assert.equal(eligible(record({ state: "deleting" }), "note", { pin: null, now: NOW }).ok, false);
});

test("the limit counts kept ones and undos apart, a kept undo as an ordinary snapshot, and nothing that holds nothing", () => {
  assert.equal(SNAPSHOTS_PER_BOX, 5);
  assert.ok(countsAgainstLimit(record()));
  assert.ok(countsAgainstLimit(record({ keptUntil: NOW + 1 })));
  assert.equal(countsAgainstLimit(record({ undoOf: "op1" })), false);
  assert.ok(countsAgainstLimit(record({ undoOf: "op1", keptUntil: NOW + 1 })));
  for (const state of ["failed", "lost", "deleting"] as const) assert.equal(countsAgainstLimit(record({ state })), false, state);
  for (const state of ["taking", "incomplete", "unavailable"] as const) assert.ok(countsAgainstLimit(record({ state })), state);
});

test("the limit's victim is the oldest that an agent of the same thread took and nobody kept, never another thread's, a target, an undo or a kept one", () => {
  const theirs = record({ by: { is: "agent", threadId: OTHER }, takenAt: NOW - 50 * MINUTE });
  const kept = record({ keptUntil: NOW + 1, takenAt: NOW - 49 * MINUTE });
  const undo = record({ undoOf: "op1", takenAt: NOW - 48 * MINUTE });
  const target = record({ takenAt: NOW - 47 * MINUTE });
  const next = record({ takenAt: NOW - 46 * MINUTE });
  const newest = record({ takenAt: NOW - 45 * MINUTE });
  const restore = operation("restore", [target.id]);
  assert.equal(limitVictim([newest, next, target, undo, kept, theirs], THREAD, pinsOf(restore), NOW)?.id, next.id);
  assert.equal(limitVictim([theirs, kept, undo], THREAD, new Map(), NOW), null, "none qualifies, so the take is refused");
});

test("G9: restore twice, then restore the oldest undo: the target stays", () => {
  const before = record({ name: "before the migration" });
  const firstUndo = record({ name: "before the restore at 11:02", undoOf: "op-first", takenAt: NOW + 20 * MINUTE });
  const secondUndo = record({ name: "before the restore at 11:30", undoOf: "op-second", takenAt: NOW + 48 * MINUTE });
  const third = operation("restore", [firstUndo.id], { startedAt: NOW + 60 * MINUTE });
  const pins = pinsOf(third);
  const replaced = undoToReplace([before, firstUndo, secondUndo], pins, NOW + 61 * MINUTE);
  assert.equal(replaced?.id, secondUndo.id, "the oldest undo is the restore's target, so the next oldest goes");
  const onlyTheTarget = undoToReplace([before, firstUndo], pins, NOW + 61 * MINUTE);
  assert.equal(onlyTheTarget, null, "with no undo that may go, the box holds a third until the restore ends");
});

test("G9: restore twice, keep the oldest undo, restore again: the kept undo stays", () => {
  const firstUndo = record({ undoOf: "op-first", takenAt: NOW + 20 * MINUTE, keptUntil: NOW + 30 * 24 * 60 * MINUTE, owner: "person" });
  const secondUndo = record({ undoOf: "op-second", takenAt: NOW + 48 * MINUTE });
  assert.equal(undoToReplace([firstUndo, secondUndo], new Map(), NOW + 61 * MINUTE)?.id, secondUndo.id);
  assert.equal(undoToReplace([firstUndo], new Map(), NOW + 61 * MINUTE), null, "a kept undo is never replaced");
});

test("G9: start a restore, then bulk-delete, bulk-keep and rename its target: each is refused for it and named", () => {
  const target = record({ name: "before the migration" });
  const other = record({ name: "Thu 09:15" });
  const pins = pinsOf(operation("restore", [target.id], { startedAt: Date.UTC(2026, 9, 30, 11, 2) }));
  for (const change of ["delete", "keep", "rename"] as const) {
    const judged = judgeEach([target, other], change, pins, NOW);
    assert.deepEqual(judged.allowed.map((each) => each.id), [other.id], change);
    assert.equal(judged.skipped.length, 1);
    assert.equal(judged.skipped[0]!.snapshot.id, target.id);
    assert.match(judged.skipped[0]!.why, /^"before the migration" is in use by the restore that began at 11:02 UTC\.$/);
  }
});

test("G9: the room sweep picks its candidates, then a restore to one and a keep of another before it deletes: both stay", () => {
  const first = record({ takenAt: NOW - 30 * MINUTE });
  const second = record({ takenAt: NOW - 20 * MINUTE });
  const third = record({ takenAt: NOW - 10 * MINUTE });
  const picked = roomCandidates([third, second, first], new Map(), NOW);
  assert.deepEqual(picked.map((each) => each.id), [first.id, second.id, third.id], "oldest first");
  const restore = operation("restore", [first.id]);
  const keptSecond = { ...second, keptUntil: NOW + 30 * 24 * 60 * MINUTE, owner: "person" as const };
  const now = [first, keptSecond, third];
  const pins = pinsOf(restore);
  const atDeletion = picked.map((chosen) => eligible(now.find((each) => each.id === chosen.id)!, "evict-room", { pin: pins.get(chosen.id) ?? null, now: NOW }));
  assert.deepEqual(
    atDeletion.map((verdict) => verdict.ok),
    [false, false, true],
    "the sweep checks each again at the moment of the change",
  );
});

test("mayAct: on its own box an agent takes, sees, restores and forks; deletes only what an agent of its thread took and nobody kept; never keeps, renames or notes", () => {
  const mine = record();
  const persons = record({ by: { is: "person" } });
  const kept = record({ keptUntil: NOW + 1, owner: "person" });
  const byOtherThreadHere = record({ by: { is: "agent", threadId: OTHER } });
  for (const act of ["take", "see", "restore", "fork"] as const) assert.ok(mayAct(AGENT, act, own, mine).ok, act);
  assert.ok(mayAct(AGENT, "delete", own, mine).ok);
  assert.match((mayAct(AGENT, "delete", own, persons) as { why: string }).why, /not taken by an agent of this thread/);
  assert.match((mayAct(AGENT, "delete", own, byOtherThreadHere) as { why: string }).why, /not taken by an agent of this thread/);
  assert.match((mayAct(AGENT, "delete", own, kept) as { why: string }).why, /is kept/);
  assert.ok(mayAct(AGENT, "see", own, kept).ok, "the thread's agent sees a kept one while its box lives");
  assert.equal(mayAct(AGENT, "see-picture", own, kept).ok, false, "but not its picture");
  for (const act of ["keep", "unkeep", "rename", "note"] as const) assert.equal(mayAct(AGENT, act, own, mine).ok, false, act);
});

test("mayAct: on a box it runs on, an agent takes and sees and deletes only what it took there, and restores, forks and keeps nothing", () => {
  const mineThere = record({ by: { is: "agent", threadId: OTHER }, box: { id: "bxamberfox2q7k", name: "amber-fox", kind: "linux", system: "linux", thread: THREAD } });
  const ownersThere = record({ by: { is: "agent", threadId: THREAD } });
  const caller: Caller = { is: "agent", threadId: OTHER };
  assert.ok(mayAct(caller, "take", runsOnIt).ok);
  assert.ok(mayAct(caller, "see", runsOnIt, mineThere).ok);
  assert.equal(mayAct(caller, "see", runsOnIt, ownersThere).ok, false, "it sees only what it took there");
  assert.ok(mayAct(caller, "delete", runsOnIt, mineThere).ok);
  assert.equal(mayAct(caller, "delete", runsOnIt, { ...mineThere, keptUntil: NOW + 1 }).ok, false);
  assert.match((mayAct(caller, "restore", runsOnIt, mineThere) as { why: string }).why, /restore is off/);
  for (const act of ["fork", "keep", "rename"] as const) assert.equal(mayAct(caller, act, runsOnIt, mineThere).ok, false, act);
});

test("mayAct: another thread's box, a guessed ID or a box that is gone gives an agent nothing, in the same words as a snapshot that does not exist", () => {
  const theirs = record({ box: { id: "bxamberfox2q7k", name: "amber-fox", kind: "linux", system: "linux", thread: OTHER }, by: { is: "agent", threadId: OTHER } });
  for (const act of ["take", "see", "see-picture", "restore", "fork", "delete", "keep"] as const) {
    const verdict = mayAct(AGENT, act, anothers, theirs);
    assert.equal(verdict.ok, false, act);
    assert.equal((verdict as { why: string }).why, "This thread has no such snapshot.", act);
  }
  assert.equal(mayAct(AGENT, "see", { box: null, runsOn: false }, theirs).ok, false);
  assert.equal(mayAct(AGENT, "see", own, record({ boxGone: { at: NOW, how: "released" }, keptUntil: NOW + 1 })).ok, false, "once its box is gone, a kept one is the person's alone");
});

test("mayAct: the person and a bb box command may do everything, on any box", () => {
  const theirs = record({ box: { id: "bxamberfox2q7k", name: "amber-fox", kind: "linux", system: "linux", thread: OTHER } });
  for (const caller of [PERSON, COMMAND]) for (const act of ["take", "see", "see-picture", "restore", "fork", "delete", "keep", "unkeep", "rename", "note"] as const) assert.ok(mayAct(caller, act, anothers, theirs).ok);
});

test("mayAct: a kept snapshot is the person's first: on its own box an agent may see it, and not see its picture, restore, fork, delete, keep or rename it; another thread learns nothing of it", () => {
  const kept = record({ keptUntil: NOW + 30 * 24 * 60 * MINUTE, owner: "person" });
  assert.ok(mayAct(AGENT, "see", own, kept).ok);
  for (const act of ["see-picture", "restore", "fork", "delete", "keep", "unkeep", "rename", "note"] as const) {
    const verdict = mayAct(AGENT, act, own, kept);
    assert.equal(verdict.ok, false, act);
    assert.match((verdict as { why: string }).why, /is kept, so it is the person's/, act);
  }
  const keptThere = record({ keptUntil: NOW + 1, owner: "person", by: { is: "agent", threadId: OTHER } });
  const visitor: Caller = { is: "agent", threadId: OTHER };
  assert.ok(mayAct(visitor, "see", runsOnIt, keptThere).ok, "on a box it runs on, it sees a kept one it took there");
  for (const act of ["see-picture", "delete", "restore"] as const) assert.match((mayAct(visitor, act, runsOnIt, keptThere) as { why: string }).why, /is kept/, act);
  for (const act of ["see", "restore", "delete"] as const) assert.equal((mayAct(AGENT, act, anothers, keptThere) as { why: string }).why, "This thread has no such snapshot.", act);
});
