import assert from "node:assert/strict";
import { test } from "node:test";
import { SNAPSHOT_DEFAULTS } from "../src/core/document.ts";
import {
  CHANGES,
  countsAgainstLimit,
  daysLeft,
  endOfUtcDay,
  keepEndsWithin,
  keepEndsWords,
  keepLabel,
  keptUntilAfter,
  utcDay,
  eligible,
  judgeEach,
  limitVictim,
  mayAct,
  nameProblem,
  newOperationId,
  newSnapshotId,
  noteProblem,
  restoreRoute,
  roomCandidates,
  ACTS,
  type Act,
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
  assert.equal(pinsOf(unknown).get(target.id), unknown, "an operation BB Box could not confirm still pins");
});

test("automatic deletions never take a kept snapshot, the person's, an undo, or one an agent did not take; the limit goes by who took it, so an agent's on the person's machine may go", () => {
  assert.equal(eligible(record({ owner: "person" }), "evict-limit", { pin: null, now: NOW }).ok, true, "an agent's unkept snapshot on the person's machine");
  assert.match((eligible(record({ owner: "person" }), "evict-room", { pin: null, now: NOW }) as { why: string }).why, /is the person's/);
  assert.match((eligible(record({ owner: "person", by: { is: "command" } }), "evict-limit", { pin: null, now: NOW }) as { why: string }).why, /is the person's/);
  const cases: [Partial<SnapshotRecord>, RegExp][] = [
    [{ keptUntil: NOW + 30 * 24 * 60 * MINUTE }, /is kept/],
    [{ undoOf: "oprestore" }, /is an undo/],
    [{ by: { is: "person" }, owner: "thread" }, /not taken by an agent/],
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

test("expiry takes only a snapshot past its keep date; a found one is never deleted by itself", () => {
  assert.equal(eligible(record({ keptUntil: NOW + 1 }), "expire", { pin: null, now: NOW }).ok, false);
  assert.equal(eligible(record(), "expire", { pin: null, now: NOW }).ok, false);
  assert.ok(eligible(record({ keptUntil: NOW - 1 }), "expire", { pin: null, now: NOW }).ok);
  assert.ok(!(CHANGES as readonly string[]).includes("remove-found"), "found snapshots stay until the person deletes them");
  const found = record({ foundAt: NOW - 30 * 24 * 60 * MINUTE, boxGone: { at: NOW, how: "unknown" }, by: { is: "unknown" }, owner: "thread" });
  for (const change of ["evict-room", "evict-limit", "expire"] as const) assert.equal(eligible(found, change, { pin: null, now: NOW }).ok, false, change);
});

test("keep dates: the end of a UTC day, days from today, and the words from 3 days before", () => {
  const now = Date.UTC(2026, 9, 31, 22, 30);
  assert.equal(keptUntilAfter(now, 30), Date.UTC(2026, 10, 30, 23, 59, 59, 999));
  assert.equal(utcDay(keptUntilAfter(now, 1)), "2026-11-01");
  assert.equal(endOfUtcDay("2026-11-30"), Date.UTC(2026, 10, 30, 23, 59, 59, 999));
  for (const bad of ["2026-02-30", "30 Nov", "2026-11-3", ""]) assert.equal(endOfUtcDay(bad), null, bad);
  assert.equal(keepLabel(null), null);
  assert.equal(keepLabel(Date.UTC(2026, 10, 30, 23, 59, 59, 999)), "2026-11-30");
  const until = Date.UTC(2026, 10, 30, 23, 59, 59, 999);
  const day = 24 * 60 * MINUTE;
  assert.equal(keepEndsWords({ keptUntil: until }, until - 10 * day), "kept until 2026-11-30");
  assert.equal(keepEndsWords({ keptUntil: until }, until - 3 * day + MINUTE), "goes in 3 days");
  assert.equal(keepEndsWords({ keptUntil: until }, until - 2 * day), "goes in 2 days");
  assert.equal(keepEndsWords({ keptUntil: until }, until - 5 * MINUTE), "goes within a day");
  assert.equal(keepEndsWords({ keptUntil: null }, until), null);
  assert.equal(keepEndsWithin({ keptUntil: until }, until - 6 * day, 7), true);
  assert.equal(keepEndsWithin({ keptUntil: until }, until - 8 * day, 7), false);
  assert.equal(daysLeft({ keptUntil: until }, until + day), 0);
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
  assert.equal(SNAPSHOT_DEFAULTS.perBox, 5);
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

test("mayAct: on a box it runs on, an agent takes and sees and deletes only what it took there, restores only through the form, and forks and keeps nothing", () => {
  const mineThere = record({ by: { is: "agent", threadId: OTHER }, box: { id: "bxamberfox2q7k", name: "amber-fox", kind: "linux", system: "linux", thread: THREAD } });
  const ownersThere = record({ by: { is: "agent", threadId: THREAD } });
  const caller: Caller = { is: "agent", threadId: OTHER };
  assert.ok(mayAct(caller, "take", runsOnIt).ok);
  assert.ok(mayAct(caller, "see", runsOnIt, mineThere).ok);
  assert.equal(mayAct(caller, "see", runsOnIt, ownersThere).ok, false, "it sees only what it took there");
  assert.ok(mayAct(caller, "delete", runsOnIt, mineThere).ok);
  assert.equal(mayAct(caller, "delete", runsOnIt, { ...mineThere, keptUntil: NOW + 1 }).ok, false);
  assert.ok(mayAct(caller, "restore", runsOnIt, mineThere).ok, "its restore goes through the form, which restoreRoute decides");
  assert.equal(mayAct(caller, "restore", runsOnIt, ownersThere).ok, false, "never what it did not take there");
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

test("section 3's table, cell by cell, on a set clock: who may take, see, see the picture of, restore, fork, delete and keep on a thread's own box, a box a thread runs on, and a kept snapshot", () => {
  const box = { id: "bxamberfox2q7k", name: "amber-fox", kind: "linux", system: "linux", thread: THREAD };
  const machineBox = { ...box, thread: "operator" };
  const ownBox: Standing = { box: { id: box.id, threadId: THREAD }, runsOn: false };
  const machine: Standing = { box: { id: box.id, threadId: "operator" }, runsOn: true };
  const takenByIt = record({ box, by: { is: "agent", threadId: THREAD }, takenAt: NOW - 5 * MINUTE });
  const takenByAnother = record({ box, by: { is: "agent", threadId: OTHER }, takenAt: NOW - 4 * MINUTE });
  const persons = record({ box, by: { is: "command" }, owner: "person", takenAt: NOW - 3 * MINUTE });
  const kept = record({ box, by: { is: "agent", threadId: THREAD }, keptUntil: NOW + 30 * 24 * 60 * MINUTE, keptAt: NOW, owner: "person" });
  const itTookThere = record({ box: machineBox, by: { is: "agent", threadId: THREAD } });
  const theirsThere = record({ box: machineBox, by: { is: "command" }, owner: "person" });
  const keptThere = record({ box: machineBox, by: { is: "agent", threadId: THREAD }, keptUntil: NOW + 1, owner: "person" });
  type Cell = Readonly<Partial<Record<Act, boolean>>>;
  const yes = (acts: readonly Act[]): Cell => Object.fromEntries(ACTS.filter((act) => act !== "take" || acts.includes("take")).map((act) => [act, acts.includes(act)]));
  const rows: readonly (readonly [string, Caller, Standing, SnapshotRecord | null, Cell])[] = [
    ["its box, before any snapshot", AGENT, ownBox, null, { take: true }],
    ["its box, one its agent took", AGENT, ownBox, takenByIt, yes(["see", "see-picture", "restore", "fork", "delete"])],
    ["its box, one another thread's agent took there", AGENT, ownBox, takenByAnother, yes(["see", "see-picture", "restore", "fork"])],
    ["its box, the person's", AGENT, ownBox, persons, yes(["see", "see-picture", "restore", "fork"])],
    ["its box, a kept one", AGENT, ownBox, kept, yes(["see"])],
    ["a box it runs on, before any snapshot", AGENT, machine, null, { take: true }],
    ["a box it runs on, one it took there", AGENT, machine, itTookThere, yes(["see", "see-picture", "restore", "delete"])],
    ["a box it runs on, one it did not take", AGENT, machine, theirsThere, yes([])],
    ["a box it runs on, a kept one it took", AGENT, machine, keptThere, yes(["see"])],
    ["another thread's box, before any snapshot", AGENT, anothers, null, { take: false }],
    ["another thread's box", AGENT, anothers, takenByAnother, yes([])],
    ["the person, its box", PERSON, ownBox, takenByIt, yes(ACTS)],
    ["the person, a box a thread runs on", PERSON, machine, theirsThere, yes(ACTS)],
    ["the person, a kept one", PERSON, ownBox, kept, yes(ACTS)],
    ["a bb box command", COMMAND, anothers, takenByAnother, yes(ACTS)],
  ];
  for (const [what, caller, standing, snapshot, cell] of rows) {
    for (const act of ACTS) {
      if (cell[act] === undefined) continue;
      assert.equal(mayAct(caller, act, standing, snapshot).ok, cell[act], `${what}: ${act}`);
    }
  }
});

test("restoreRoute: an agent restores its own box at once, through the form when Settings turn that off or the box is one threads run on, and nobody restores a box threads run on until machine restores are on, nor from memory", () => {
  const on = { agentsRestore: true, agentsMemory: true, machineRestores: true };
  const disk = { onAMachine: false, memory: false };
  const onMachine = { onAMachine: true, memory: false };
  assert.deepEqual(restoreRoute(AGENT, on, disk), { ok: true, through: "restore" });
  assert.deepEqual(restoreRoute(AGENT, { ...on, agentsRestore: false }, disk), { ok: true, through: "form" });
  assert.deepEqual(restoreRoute(AGENT, on, onMachine), { ok: true, through: "form" });
  assert.deepEqual(restoreRoute(AGENT, { ...on, agentsRestore: false }, onMachine), { ok: true, through: "form" });
  for (const caller of [AGENT, PERSON, COMMAND]) {
    const off = restoreRoute(caller, { ...on, machineRestores: false }, onMachine);
    assert.equal(off.ok, false);
    assert.match((off as { why: string }).why, /does not restore a box threads run on yet: that stays off until BB Box can hold every turn on it/);
    assert.match((restoreRoute(caller, on, { onAMachine: true, memory: true }) as { why: string }).why, /restored from disk snapshots only/);
  }
  assert.deepEqual(restoreRoute(PERSON, on, onMachine), { ok: true, through: "restore" });
  assert.deepEqual(restoreRoute(COMMAND, { ...on, agentsRestore: false, agentsMemory: false }, { onAMachine: false, memory: true }), { ok: true, through: "restore" });
  assert.match((restoreRoute(AGENT, { ...on, agentsMemory: false }, { onAMachine: false, memory: true }) as { why: string }).why, /^Settings let only the person restore a snapshot that holds memory\./);
  assert.deepEqual(restoreRoute(AGENT, on, { onAMachine: false, memory: true }), { ok: true, through: "restore" });
});
