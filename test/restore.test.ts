import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { BoxIdentity, Guest } from "../src/backends/types.ts";
import type { BoxRecord } from "../src/core/boxes.ts";
import type { Caller, SnapshotRecord } from "../src/core/snapshot.ts";
import { COMMAND, DAY, THREAD, readyBox, rejection, standing, world, type World } from "./snapshot-world.ts";

const AGENT: Caller = { is: "agent", threadId: THREAD };

function home(state: World, box: BoxRecord): string {
  return join(state.root, "fake", box.guest!.ref);
}

function write(state: World, box: BoxRecord, path: string, text: string): void {
  const file = join(home(state, box), path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function read(state: World, box: BoxRecord, path: string): string | null {
  const file = join(home(state, box), path);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

async function three(state: World, box: BoxRecord): Promise<SnapshotRecord[]> {
  const taken: SnapshotRecord[] = [];
  for (const name of ["one", "two", "three"]) {
    write(state, box, "work.txt", name);
    taken.push((await state.snapshots.take(COMMAND, box, standing(box), { name })).snapshot!);
    state.tick(60_000);
  }
  return taken;
}

async function current(state: World, box: BoxRecord): Promise<BoxRecord> {
  return (await state.boxes.find(box.id))!;
}

async function untilHeld(state: World, held: Promise<unknown>): Promise<void> {
  let ended = false;
  void held.then(() => (ended = true));
  const deadline = Date.now() + 10_000;
  while (state.holds.step !== null) {
    if (ended) throw new Error(`the restore ended before its hold at ${state.holds.step}: ${String(await held)}`);
    if (Date.now() > deadline) throw new Error(`the restore never reached its hold at ${state.holds.step}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function watchAccess(state: World, box: BoxRecord): { readonly seen: (string | null)[] } {
  const seen: (string | null)[] = [];
  Object.assign(state.backend, {
    relabel: async (_guest: Guest, _identity: BoxIdentity, _from: string) => {
      seen.push(read(state, box, ".config/bb-box/env"));
    },
  });
  return { seen };
}

test("G4 on LVM-thin: a restore to the oldest of three stops the box, takes its undo, rolls back and starts it, and nothing written before the stop is lost", async () => {
  const state = world();
  const box = await readyBox(state);
  const [one, , third] = await three(state, box);
  write(state, box, "work.txt", "written after the last snapshot, before the stop");
  state.tick(2 * 60 * 60_000);
  state.provider.order.length = 0;
  const answer = await state.snapshots.restore(COMMAND, box, standing(box), "one");
  assert.deepEqual(state.provider.order, ["power-off", `take ${answer.undo!.id}`, `rollback ${one!.id}`, "start"]);
  assert.equal(read(state, box, "work.txt"), "one", "the box went back to the oldest");
  assert.equal(answer.operation.state, "done");
  assert.equal(answer.undo?.name, "before the restore at 12:45");
  assert.equal(answer.undo?.state, "ready");
  assert.equal(answer.undo?.undoOf, answer.operation.id);
  assert.equal(state.store.pins().size, 0, "pins ended with the restore");
  const after = await current(state, box);
  assert.equal(after.state, "ready");
  assert.equal(after.restoring ?? null, null);
  assert.ok(state.store.record(third!.id), "every newer snapshot is still there");
  assert.deepEqual(state.kinds(box.id).slice(-3), ["restore-asked", "snapshot-taken", "restored"]);
  assert.match(state.log.events(box.id).at(-1)!.words!, /^To "one" \(sn[a-z2-7]{12}\), taken 2026-10-30 10:42 UTC, in 0\.0 s \(stop 0\.0 s, undo 0\.0 s, rollback 0\.0 s, start 0\.0 s, access 0\.0 s\); its undo is "before the restore at 12:45"\.$/);
  const undone = await state.snapshots.restore(COMMAND, box, standing(box), answer.undo!.id);
  assert.equal(undone.operation.state, "done");
  assert.equal(read(state, box, "work.txt"), "written after the last snapshot, before the stop", "the undo holds what was written before the stop");
});

test("G8: the access file is the first command after the restore, before the labels and BB's machine; the size is read back", async () => {
  const state = world();
  const box = await readyBox(state);
  write(state, box, ".config/bb-box/env", "BB_STALE=from-before\n");
  await state.snapshots.take(COMMAND, box, standing(box), { name: "stale" });
  state.backend.setSize(box.guest!.ref, { cores: 4, memoryMiB: 8192, diskGiB: null });
  await state.boxes.update(box, (latest) => ({ guest: { ...latest.guest!, size: { cores: 4, memoryMiB: 8192, diskGiB: null } } }));
  const watched = watchAccess(state, box);
  const answer = await state.snapshots.restore(COMMAND, box, standing(box), "stale");
  assert.equal(watched.seen.length, 1, "the labels were written once");
  assert.doesNotMatch(watched.seen[0]!, /BB_STALE/, "the access file was written before the labels");
  assert.match(watched.seen[0]!, new RegExp(`BB_BOX_ID=.?${box.id}`));
  assert.deepEqual(answer.to && { cores: answer.to.cores, memoryMiB: answer.to.memoryMiB }, { cores: box.guest!.size!.cores, memoryMiB: box.guest!.size!.memoryMiB });
  assert.match(state.log.events(box.id).at(-1)!.words!, /its size went from 4 cores, 8 GiB memory to/);
  assert.equal((await current(state, box)).guest?.size?.memoryMiB, box.guest!.size!.memoryMiB);
});

test("G9: a box keeps two undos; a new one replaces the oldest that may go, never the restore's target or a kept one", async () => {
  const state = world();
  const box = await readyBox(state);
  await three(state, box);
  const first = await state.snapshots.restore(COMMAND, box, standing(box), "one");
  state.tick(60_000);
  const second = await state.snapshots.restore(COMMAND, box, standing(box), "two");
  state.tick(60_000);
  assert.equal(state.store.records({ box: box.id }).filter((record) => record.undoOf).length, 2);
  const third = await state.snapshots.restore(COMMAND, box, standing(box), first.undo!.id);
  assert.ok(state.store.record(first.undo!.id), "the target, the oldest undo, stays");
  assert.equal(state.store.record(second.undo!.id), null, "the next oldest went instead");
  assert.deepEqual(third.replaced, [second.undo!.name]);
  state.tick(60_000);
  state.store.updateRecord(first.undo!.id, { keptUntil: state.now + 30 * DAY, keptAt: state.now, owner: "person" });
  const fourth = await state.snapshots.restore(COMMAND, box, standing(box), "three");
  assert.ok(state.store.record(first.undo!.id), "a kept undo stays");
  assert.ok(state.store.record(third.undo!.id) && state.store.record(fourth.undo!.id));
  assert.equal(state.store.records({ box: box.id }).filter((record) => record.undoOf && record.keptUntil === null).length, 2);
  assert.ok(state.log.events(box.id).some((event) => event.kind === "snapshot-deleted" && event.by.is === "bb-box" && event.by.why === "a newer undo replaced it"));
});

test("the undo is admitted before the box stops: room and the ceiling refuse it with their own fix, and only the person restores without one", async () => {
  const state = world();
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  state.provider.order.length = 0;
  state.provider.percentFull = 90;
  const room = await rejection(state.snapshots.restore(COMMAND, box, standing(box), "one"));
  assert.equal(room.code, "no_capacity");
  assert.match(room.message, /^bb-box would take an undo of box \S+ before restoring it, and (\S+ )?storage fast is 90% full, and your settings take no snapshot past 85%: .* Or restore without an undo, with --no-undo\.$/);
  const agentRoom = await rejection(state.snapshots.restore(AGENT, box, standing(box), "one"));
  assert.doesNotMatch(agentRoom.message, /--no-undo/);
  assert.equal((await rejection(state.snapshots.restore(AGENT, box, standing(box), "one", { undo: false }))).code, "not_owner");
  assert.deepEqual(state.provider.order, [], "nothing stopped");
  assert.equal(state.store.records({ box: box.id }).length, 1, "no undo was recorded");
  state.provider.percentFull = 30;
  state.price = { amount: 0.2, currency: "USD", per: "day", known: true };
  const priced = await rejection(state.snapshots.restore(COMMAND, box, standing(box), "one"));
  assert.equal(priced.code, "limit_reached");
  assert.match(priced.message, /past your ceiling of \$5\.00\. Delete one, or raise the ceiling in Settings, Snapshots, Paid snapshots\. Or restore without an undo, with --no-undo\.$/);
  assert.deepEqual(state.provider.order, []);
  const without = await state.snapshots.restore(COMMAND, box, standing(box), "one", { undo: false });
  assert.equal(without.undo, null);
  assert.deepEqual(state.provider.order, ["power-off", `rollback ${without.snapshot!.id}`, "start"]);
  assert.match(state.log.events(box.id).find((event) => event.kind === "restore-asked")!.words!, /; no undo\.$/);
});

test("G5: the guard refuses a box threads run on for everyone, and while a person holds control or a terminal is open unless the person restores anyway", async () => {
  const state = world();
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  state.provider.order.length = 0;
  state.guard = { threads: [{ id: "thr_idle", title: "Write the API guide", running: false }], threadsUnread: null, control: false, terminals: 0 };
  for (const caller of [COMMAND, AGENT]) {
    const refused = await rejection(state.snapshots.restore(caller, box, standing(box), "one", caller.is === "agent" ? {} : { force: true }));
    assert.equal(refused.code, "in_use");
    assert.match(refused.message, /is a box threads run on: "Write the API guide" \(idle\) runs on it\. A restore would take their worktrees/);
  }
  state.guard = { threads: null, threadsUnread: "BB did not answer", control: false, terminals: 0 };
  assert.match((await rejection(state.snapshots.restore(COMMAND, box, standing(box), "one"))).message, /could not tell which threads run on box/);
  state.guard = { threads: [], threadsUnread: null, control: true, terminals: 2 };
  const person = await rejection(state.snapshots.restore(COMMAND, box, standing(box), "one"));
  assert.match(person.message, /would end what is on it now: a person holds control of its desktop; 2 BB terminals are open on it\. Restore anyway with --force\. bb-box changed nothing\.$/);
  const agent = await rejection(state.snapshots.restore(AGENT, box, standing(box), "one"));
  assert.match(agent.message, /Ask the person to end it first, or to restore the box themselves\./);
  assert.equal((await rejection(state.snapshots.restore(AGENT, box, standing(box), "one", { force: true }))).code, "not_owner");
  state.guard = { threads: [], threadsUnread: null, control: false, terminals: null };
  assert.match((await rejection(state.snapshots.restore(COMMAND, box, standing(box), "one"))).message, /could not tell whether a BB terminal is open on it/);
  assert.deepEqual(state.provider.order, [], "nothing changed while refused");
  state.guard = { threads: [], threadsUnread: null, control: true, terminals: 1 };
  const anyway = await state.snapshots.restore(COMMAND, box, standing(box), "one", { force: true });
  assert.deepEqual(anyway.anyway, ["a person holds control of its desktop", "a BB terminal is open on it"]);
  assert.match(state.log.events(box.id).find((event) => event.kind === "restore-asked")!.words!, /restored anyway, though a person holds control of its desktop, and a BB terminal is open on it\.$/);
  const runsOn = await rejection(state.snapshots.restore(AGENT, box, { box: { id: box.id, threadId: box.threadId }, runsOn: true }, "one"));
  assert.equal(runsOn.code, "not_found", "an agent on the box it runs on sees no snapshot it did not take");
});

test("a failed undo, a refused rollback or a failed stop leaves the disk as it was and starts the box again; a rollback task that fails leaves it stopped", async () => {
  const state = world();
  const box = await readyBox(state);
  write(state, box, "work.txt", "then");
  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  write(state, box, "work.txt", "now");
  state.provider.take = "failed";
  const undo = await rejection(state.snapshots.restore(COMMAND, box, standing(box), "one"));
  assert.match(undo.message, /^bb-box did not restore box \S+ to "one": bb-box could not take the undo "before the restore at 10:42": snapshot feature is not available\. Nothing on its disk changed, and bb-box started box \S+ again as it was\.$/);
  assert.equal(read(state, box, "work.txt"), "now");
  assert.equal((await current(state, box)).state, "ready");
  assert.equal(state.store.records({ box: box.id }).find((record) => record.undoOf)?.state, "failed");
  state.provider.rollback = "refused";
  const refused = await rejection(state.snapshots.restore(COMMAND, box, standing(box), "one"));
  assert.match(refused.message, /Fake host refused the rollback: CT is locked \(backup\)\. Nothing on its disk changed/);
  assert.equal((await current(state, box)).state, "ready");
  state.provider.powerOffFault = new Error("the guest would not stop");
  assert.match((await rejection(state.snapshots.restore(COMMAND, box, standing(box), "one"))).message, /the guest would not stop\. Nothing on its disk changed/);
  assert.equal(read(state, box, "work.txt"), "now");
  state.provider.rollback = "failed";
  const failed = await rejection(state.snapshots.restore(COMMAND, box, standing(box), "one"));
  assert.match(failed.message, /could not finish restoring box \S+ to "one": Proxmox's rollback task failed: rollback interrupted\. The box is stopped, and its disk may be part-restored\. Its undo "before the restore at 10:42 \(\d\)" holds its disk as it was before\.$/);
  const stopped = await current(state, box);
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.restoring ?? null, null);
  assert.equal(state.store.pins().size, 0);
  assert.ok(state.kinds(box.id).filter((kind) => kind === "restore-failed").length >= 4);
  assert.match(state.log.events(box.id).at(-1)!.words!, /^At the rollback: Proxmox's rollback task failed: rollback interrupted\. bb-box then found it stopped\.$/);
});

test("G7: a locked guest refuses a restore with the host's command, and ZFS restores are refused, before anything changes; a restore across a disk's growth gives the disk back its size then", async () => {
  const state = world();
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  state.provider.order.length = 0;
  state.provider.locked = { lock: "rollback", fix: "Run `pct unlock 214` on pve-1." };
  const locked = await rejection(state.snapshots.restore(COMMAND, box, standing(box), "one"));
  assert.equal(locked.code, "locked");
  assert.equal(locked.message, `Fake host left box ${box.name} locked (rollback), so bb-box restores nothing. Run \`pct unlock 214\` on pve-1.`);
  assert.deepEqual(await state.snapshots.restoreChecks(), [
    { id: `snapshots.locked.${box.name}`, name: `${box.name} locked`, status: "fail", detail: `Fake host left box ${box.name} locked (rollback), so bb-box takes, deletes and restores none of its snapshots.`, fix: "Run `pct unlock 214` on pve-1." },
  ]);
  state.provider.locked = null;
  state.provider.restoreWay = "rollback-newest-only";
  assert.match((await rejection(state.snapshots.restore(COMMAND, box, standing(box), "one"))).message, /storage fast is ZFS, which restores only the newest snapshot, and bb-box's restores on ZFS stay off until they are checked there\./);
  state.provider.restoreWay = "rollback";
  const snapshot = state.store.records({ box: box.id })[0]!;
  state.provider.sizes.set(snapshot.id, { cores: 2, memoryMiB: 4096, diskGiB: 8 });
  assert.deepEqual(state.provider.order, []);
  assert.equal(state.store.unsettled().length, 0);
  await state.boxes.update(box, (latest) => ({ guest: { ...latest.guest!, size: { cores: 2, memoryMiB: 4096, diskGiB: 16 } } }));
  const across = await state.snapshots.restore(COMMAND, box, standing(box), "one");
  assert.deepEqual(across.to, { cores: 2, memoryMiB: 4096, diskGiB: 8 }, "the disk goes back to its size then, as Proxmox gives the snapshot's volume back");
  assert.match(state.log.events(box.id).at(-1)!.words!, /its size went from 2 cores, 4 GiB memory, 16 GiB disk to 2 cores, 4 GiB memory, 8 GiB disk, as it was then\.$/);
});

test("G6: bb-box restarted after the stop, the undo, the rollback and the start: each restore finishes at the next start, and its pins end", async () => {
  for (const step of ["stopped", "undo", "rolled-back", "started"] as const) {
    const state = world();
    const box = await readyBox(state);
    write(state, box, "work.txt", "then");
    await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
    write(state, box, "work.txt", "now");
    state.holds.step = step;
    const held = state.snapshots.restore(COMMAND, box, standing(box), "one").catch((error: unknown) => error);
    await untilHeld(state, held);
    const mid = await current(state, box);
    assert.equal(mid.restoring?.name, "one", `marked as restoring at ${step}`);
    await state.restart();
    await held;
    assert.equal(await state.snapshots.recover(), 1, `settled after ${step}`);
    const after = await current(state, box);
    assert.equal(after.state, "ready", step);
    assert.equal(after.restoring ?? null, null, step);
    assert.equal(read(state, box, "work.txt"), "then", step);
    assert.equal(state.store.pins().size, 0, step);
    const undo = state.store.records({ box: box.id }).find((record) => record.undoOf)!;
    assert.equal(undo.state, "ready", step);
    assert.match(state.log.events(box.id).at(-1)!.words!, /after bb-box restarted; its undo is "before the restore at 10:42"\.$/, step);
  }
});

test("G6: bb-box restarted once a restore was recorded changes nothing; an unconfirmed rollback stays unknown and pinned, and the box says so", async () => {
  const state = world();
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  state.holds.step = "planned";
  const held = state.snapshots.restore(COMMAND, box, standing(box), "one").catch((error: unknown) => error);
  await untilHeld(state, held);
  await state.restart();
  await held;
  await state.snapshots.recover();
  assert.equal((await current(state, box)).state, "ready");
  assert.equal(state.store.records({ box: box.id }).filter((record) => record.undoOf).length, 0, "an undo never begun is not kept");
  assert.equal(state.store.pins().size, 0);
  assert.match(state.log.events(box.id).at(-1)!.words!, /^bb-box restarted before the restore began\. Nothing changed\.$/);
  state.provider.rollback = "unknown";
  const unsure = await rejection(state.snapshots.restore(COMMAND, box, standing(box), "one"));
  assert.equal(unsure.code, "unreachable");
  assert.match(unsure.message, /could not confirm the restore of box \S+ to "one": it was at the rollback/);
  state.provider.tasksReadable = false;
  await state.snapshots.recover();
  const stuck = await current(state, box);
  assert.equal(stuck.restoring?.name, "one");
  assert.equal(state.store.pins().size, 2, "the target and the undo stay pinned");
  assert.match((await rejection(state.boxes.start(THREAD, box.name))).message, /is being restored to snapshot "one"/);
  assert.match((await rejection(state.snapshots.restore(COMMAND, box, standing(box), "one"))).message, /could not confirm the restore that began at/);
  const [doctor] = await state.snapshots.restoreChecks();
  assert.equal(doctor?.id, `snapshots.restore.${box.name}`);
  assert.match(doctor!.detail, /^bb-box could not confirm the restore that began at 10:42 UTC on box \S+: It was rolling back, and bb-box could not read the rollback's task: cannot reach the provider's task list: timed out\.$/);
  await state.backend.start!(stuck.guest!);
  await state.boxes.sweep();
  const swept = await current(state, box);
  assert.equal(swept.state, "stopped", "the sweep does not take a box mid-restore as started outside bb-box");
  assert.equal(swept.restoring?.name, "one");
  await state.backend.stop!(stuck.guest!);
  state.provider.tasksReadable = true;
  await state.snapshots.recover();
  assert.equal((await current(state, box)).state, "ready");
  assert.equal(state.store.pins().size, 0);
});

test("a repeated request is the same restore, and a reuse for another is refused; a stopped box is restored and started", async () => {
  const state = world();
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  const first = await state.snapshots.restore(COMMAND, box, standing(box), "one", { request: "r1" });
  const again = await state.snapshots.restore(COMMAND, box, standing(box), "one", { request: "r1" });
  assert.equal(again.repeated, true);
  assert.equal(again.operation.id, first.operation.id);
  assert.equal((await rejection(state.snapshots.restore(COMMAND, box, standing(box), "one", { request: "r1", undo: false }))).code, "reused_request");
  await state.boxes.stop(THREAD, box.name);
  state.provider.order.length = 0;
  await state.snapshots.restore(COMMAND, box, standing(box), "one", { undo: false });
  assert.deepEqual(state.provider.order.slice(-1), ["start"]);
  assert.equal((await current(state, box)).state, "ready");
});

test("G13: restores made outside bb-box are logged from the provider's tasks by their status, once each, and an OK one sets the box straight", async () => {
  const state = world();
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  await state.snapshots.restore(COMMAND, box, standing(box), "one");
  const relabels = state.backend.relabels.length;
  const at = state.now;
  const outside = (ref: string, outcome: (typeof state.provider.outside)[number]["outcome"], minutes: number) =>
    state.provider.outside.push({ task: { ref, host: "pve-1" }, guest: box.guest!.ref, user: "root@pam", startedAt: at + minutes * 60_000, outcome });
  outside("UPID:one", { state: "ok" }, 1);
  outside("UPID:two", { state: "ok" }, 2);
  outside("UPID:failed", { state: "failed", words: "unable to rollback: no such snapshot" }, 3);
  outside("UPID:running", { state: "running" }, 4);
  state.tick(5 * 60_000);
  await state.snapshots.sweep();
  const events = () => state.log.events(box.id).filter((event) => event.kind.startsWith("restore") && event.by.is === "outside");
  assert.deepEqual(
    events().map((event) => event.kind),
    ["restored-outside", "restored-outside", "restore-outside-failed", "restore-outside-running"],
    "bb-box's own rollback is not logged as made outside it",
  );
  assert.match(events()[0]!.words!, /^Proxmox's task UPID:one, by root@pam, at 2026-10-30 10:43 UTC, ended OK: its disk went back to an earlier snapshot\. bb-box wrote its labels again, wrote its access file\.$/);
  assert.match(events()[2]!.words!, /failed: unable to rollback: no such snapshot\. bb-box then found it running\.$/);
  assert.equal(state.backend.relabels.length, relabels + 2);
  await state.snapshots.sweep();
  assert.equal(events().length, 4, "nothing is logged twice, and a task still running is said once");
  state.provider.outside[3] = { ...state.provider.outside[3]!, outcome: { state: "ok" } };
  await state.restart();
  await state.snapshots.sweep();
  assert.deepEqual(events().map((event) => event.kind).slice(4), ["restored-outside"], "the running task, once ended, after a restart too");
  await state.snapshots.sweep();
  assert.equal(events().length, 5);
});

test("G4 in ZFS's order (the live-check switch): the newest only, after a held copy of the stopped box; undoing it is a swap to a new guest with the box's identity, which leaves an earlier guest, fork only", async () => {
  const state = world();
  state.undoByCopy = true;
  const box = await readyBox(state);
  const first = box.guest!;
  write(state, box, "work.txt", "one");
  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  state.tick(60_000);
  write(state, box, "work.txt", "two");
  await state.snapshots.take(COMMAND, box, standing(box), { name: "two" });
  write(state, box, "work.txt", "before the restore");
  state.provider.newer = 1;
  const older = await rejection(state.snapshots.restore(COMMAND, box, standing(box), "one"));
  assert.match(older.message, /as on ZFS, bb-box restores only the newest snapshot there, and "one" has 1 newer one\. Delete it yourself first\. bb-box never deletes newer snapshots/);
  state.provider.newer = 0;
  state.provider.order.length = 0;
  const restored = await state.snapshots.restore(COMMAND, box, standing(box), "two");
  const copy = restored.undo!;
  assert.deepEqual(state.provider.order, ["power-off", `copy ${first.ref}`, `template ${copy.ref}`, `rollback ${restored.snapshot!.id}`, "start"]);
  assert.equal(copy.guest, "held-copy");
  assert.equal(copy.livesOn.ref, copy.ref);
  assert.equal(state.provider.copies.get(copy.ref!)?.disarmed, true, "disarmed before it is a template");
  assert.equal(read(state, box, "work.txt"), "two");
  assert.ok(state.store.record(state.store.records({ box: box.id }).find((record) => record.name === "one")!.id), "every newer snapshot is still there");
  assert.ok(state.kinds(box.id).includes("held-copy-made"));
  write(state, box, "work.txt", "after the restore");
  state.provider.order.length = 0;
  const undone = await state.snapshots.restore(COMMAND, box, standing(box), copy.id, { undo: false });
  const after = await current(state, box);
  assert.notEqual(after.guest!.ref, first.ref, "the box runs on a new guest");
  assert.deepEqual(state.provider.order, ["power-off", `adopt ${copy.ref} as mac-of-${box.id}`, `retire ${first.ref}`, "start"], "the new guest has the box's own identity");
  assert.equal(read(state, after, "work.txt"), "before the restore", "the held copy held the box as it was before the restore");
  assert.equal(undone.operation.state, "done");
  assert.equal(after.state, "ready");
  const earlier = state.store.records({ box: box.id }).filter((record) => record.guest === "earlier");
  assert.deepEqual(earlier.map((record) => record.name).sort(), ["one", "two"]);
  assert.ok(earlier.every((record) => record.livesOn.ref === first.ref));
  assert.match((await rejection(state.snapshots.restore(COMMAND, after, standing(after), "one"))).message, /is on \S+'s earlier guest, so it cannot be restored there, only forked\./);
  await state.boxes.sweep();
  assert.equal(await state.backend.power(first), "stopped", "the sweep keeps the earlier guest, which is never started or released as a leftover");
  assert.ok(state.store.record(copy.id), "the held copy stays, as the undo it is");
  await state.boxes.release(THREAD, box.name, "done with it");
  await state.boxes.settled(box);
  await state.snapshots.sweep();
  assert.deepEqual(state.store.records({ box: box.id }), [], "a release deletes its held copies and its earlier guest");
  assert.equal(state.provider.copies.size, 0);
  assert.equal(await state.backend.power(first), null);
});

test("G6 and G16 in ZFS's order: a copy cut short before it is a template is deleted and made again, never trusted; a swap cut short after its new guest is made finishes", async () => {
  const state = world();
  state.undoByCopy = true;
  const box = await readyBox(state);
  write(state, box, "work.txt", "one");
  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  write(state, box, "work.txt", "before");
  state.holds.step = "copied";
  const held = state.snapshots.restore(COMMAND, box, standing(box), "one").catch((error: unknown) => error);
  await untilHeld(state, held);
  const untrusted = [...state.provider.copies.keys()][0]!;
  assert.equal(state.provider.copies.get(untrusted)?.state, "copy");
  await state.restart();
  await held;
  state.provider.order.length = 0;
  assert.equal(await state.snapshots.recover(), 1);
  assert.equal(state.provider.order[0], `delete ${untrusted}`, "the copy that was not yet a template went first");
  assert.match(state.provider.order[1]!, /^copy g\d+$/);
  assert.ok(!state.provider.copies.has(untrusted));
  const undo = state.store.records({ box: box.id }).find((record) => record.undoOf)!;
  assert.equal(undo.state, "ready");
  assert.equal(state.provider.copies.get(undo.ref!)?.state, "template");
  assert.equal(read(state, box, "work.txt"), "one");
  assert.equal(state.store.pins().size, 0);
  state.holds.step = "adopted";
  const swapping = state.snapshots.restore(COMMAND, box, standing(box), undo.id, { undo: false }).catch((error: unknown) => error);
  await untilHeld(state, swapping);
  await state.restart();
  await swapping;
  await state.boxes.sweep();
  assert.equal(await state.snapshots.recover(), 1);
  const after = await current(state, box);
  assert.equal(after.state, "ready");
  assert.equal(read(state, after, "work.txt"), "before");
  assert.equal(state.store.pins().size, 0);
  assert.equal([...state.provider.earlier].length, 1, "the old guest was disarmed as the earlier guest");
});
