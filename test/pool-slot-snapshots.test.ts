import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { SshPoolBackend } from "../src/backends/ssh-pool/backend.ts";
import { SLOT_FORK_OFF } from "../src/backends/ssh-pool/home-snapshots.ts";
import { slotUserOf } from "../src/backends/ssh-pool/slots.ts";
import { BY_COMMAND } from "../src/core/box-log.ts";
import type { BoxRecord } from "../src/core/boxes.ts";
import { restoreCheckText, restoredText, takeCheckText } from "../src/plugin/snapshot-words.ts";
import { fakePoolMac, type FakePoolMac } from "./fake-pool-mac.ts";
import { COMMAND, THREAD, rejection, standing, untilHeld, world, type World } from "./snapshot-world.ts";

const STORES = "/var/db/bb-box/home-snapshots";

interface SlotWorld {
  readonly pool: FakePoolMac;
  readonly state: World;
  readonly backend: () => SshPoolBackend;
}

function slotWorld(): SlotWorld {
  const pool = fakePoolMac();
  const made: SshPoolBackend[] = [];
  const state = world({ markersOn: false, backend: (storage) => made[made.push(pool.backend({}, storage)) - 1]! });
  return { pool, state, backend: () => made.at(-1)! };
}

async function slotBox(slots: SlotWorld, thread = THREAD, kind = "ios"): Promise<BoxRecord> {
  await slots.state.backend.doctor();
  await slots.state.backend.members?.();
  const acquired = await slots.state.boxes.acquire({ threadId: thread, projectId: null, kind, shared: true, who: BY_COMMAND });
  const box = (await slots.state.boxes.settled(acquired))!;
  assert.equal(box.state, "ready", box.error ?? "");
  return box;
}

function userOf(box: BoxRecord): string {
  return slotUserOf(box.guest!);
}

function write(slots: SlotWorld, box: BoxRecord, path: string, text: string): void {
  const user = userOf(box);
  const full = join(slots.pool.mac.root, "Users", user, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
  slots.pool.mac.own(`Users/${user}/${path}`, Number(slots.pool.mac.user(user)!.UniqueID));
}

function read(slots: SlotWorld, box: BoxRecord, path: string): string | null {
  const full = join(slots.pool.mac.root, "Users", userOf(box), path);
  return existsSync(full) ? readFileSync(full, "utf8") : null;
}

function slotOf(slots: SlotWorld, box: BoxRecord) {
  return slots.pool.mac.status().slots.find((slot) => slot.user === userOf(box))!;
}

async function fresh(state: World, box: BoxRecord): Promise<BoxRecord> {
  return (await state.boxes.find(box.id))!;
}

describe("Home snapshots of a box in an iOS slot on a pool Mac, through BB Box's snapshots (090 unit 3)", { timeout: 300_000 }, () => {
  it("takes, restores with an undo, restores the undo and deletes, leaving the other slot as it was", async () => {
    const slots = slotWorld();
    const { state } = slots;
    const box = await slotBox(slots);
    const other = await slotBox(slots, "thr_two");
    write(slots, box, "app/data.txt", "at the take\n");
    write(slots, other, "app/data.txt", "the other slot's\n");

    const taken = await state.snapshots.take(COMMAND, box, standing(box), { name: "before" });
    write(slots, box, "app/data.txt", "after the take\n");
    const restored = await state.snapshots.restore(COMMAND, await fresh(state, box), standing(box), "before");

    assert.equal(taken.snapshot?.scope, "home");
    assert.equal(taken.snapshot?.state, "ready");
    assert.equal(read(slots, box, "app/data.txt"), "at the take\n");
    assert.equal(restored.operation.state, "done");
    assert.ok(restored.undo, "an undo was taken first");
    assert.equal((await fresh(state, box)).state, "ready");
    assert.deepEqual([slotOf(slots, box).booted, slotOf(slots, box).loaded], [true, true], "its device boots and its daemons run again");
    assert.equal(await slots.backend().power(box.guest!), "running");
    assert.match(restoredText(restored, box.name), /Everything in its home folder since then went, its device's apps and data with it\. Every process of its user ended, and its device booted again\./);
    assert.equal(read(slots, other, "app/data.txt"), "the other slot's\n");
    assert.deepEqual([slotOf(slots, other).is, slotOf(slots, other).booted], ["held", true]);

    const check = await state.snapshots.checkRestore(COMMAND, await fresh(state, box), standing(box), restored.undo!.id);
    assert.match(restoreCheckText(check), /- shut its device down and stop its daemons, then end every process of its user;/);
    assert.match(restoreCheckText(check), /- put a clone of the snapshot in its home folder's place, start its daemons and boot its device again;/);
    assert.doesNotMatch(restoreCheckText(check), /automatic login|signs? .* in again/);

    await state.snapshots.restore(COMMAND, await fresh(state, box), standing(box), restored.undo!.id);
    assert.equal(read(slots, box, "app/data.txt"), "after the take\n");

    for (const record of state.store.records({ box: box.id })) await state.snapshots.delete(COMMAND, standing(box), record.id);
    assert.deepEqual((await slots.backend().heldSnapshots()).filter((held) => held.box === box.id), []);
  });

  it("tells of a macOS box in a slot, which has no device, that its daemons start again, and names no device", async () => {
    const slots = slotWorld();
    const { state } = slots;
    const box = await slotBox(slots, THREAD, "macos");
    write(slots, box, "app/data.txt", "at the take\n");
    await state.snapshots.take(COMMAND, box, standing(box), { name: "before" });
    write(slots, box, "app/data.txt", "after the take\n");

    const check = await state.snapshots.checkRestore(COMMAND, await fresh(state, box), standing(box), "before");
    const restored = await state.snapshots.restore(COMMAND, await fresh(state, box), standing(box), "before");

    assert.equal(read(slots, box, "app/data.txt"), "at the take\n");
    assert.match(restoreCheckText(check), /- stop its daemons, then end every process of its user;/);
    assert.match(restoreCheckText(check), /- put a clone of the snapshot in its home folder's place, and start its daemons again;/);
    assert.doesNotMatch(restoreCheckText(check), /device|automatic login/);
    assert.match(restoredText(restored, box.name), /Everything in its home folder since then went\. Every process of its user ended, and its daemons started again\./);
    assert.doesNotMatch(restoredText(restored, box.name), /device/);
  });

  it("says before a take that it holds the home folder, on the pool Mac's /Users", async () => {
    const slots = slotWorld();
    const box = await slotBox(slots);

    const check = await slots.state.snapshots.checkTake(COMMAND, box, standing(box));

    assert.match(takeCheckText(check, box.name), /^A snapshot of box .+ now would hold its home folder, on mac-1's \/Users, and take under a second\./);
  });

  it("refuses a fork and a keep of a slot's snapshot, each with its reason", async () => {
    const slots = slotWorld();
    const box = await slotBox(slots);
    await slots.state.snapshots.take(COMMAND, box, standing(box), { name: "before" });

    const fork = await rejection(slots.state.snapshots.fork(COMMAND, box, standing(box), "before"));
    const keep = await rejection(slots.state.snapshots.keep(COMMAND, standing(box), "before"));

    assert.equal(fork.code, "unsupported");
    assert.ok(fork.message.includes(SLOT_FORK_OFF), fork.message);
    assert.match(fork.message, /userspace restart, which ends every session on the Mac/);
    assert.equal(keep.code, "unsupported");
  });

  it("finishes a restore BB Box restarted in the middle of, with the slot stopped", async () => {
    const slots = slotWorld();
    const { state } = slots;
    const box = await slotBox(slots);
    write(slots, box, "app/data.txt", "at the take\n");
    await state.snapshots.take(COMMAND, box, standing(box), { name: "before" });
    write(slots, box, "app/data.txt", "after the take\n");
    state.holds.step = "undo";
    const held = state.snapshots.restore(COMMAND, await fresh(state, box), standing(box), "before").catch((error: unknown) => error);
    await untilHeld(state, held);
    assert.equal(await slots.backend().power(box.guest!), "stopped", "the slot reads as stopped while its restore waits");

    await state.restart();
    await held;
    await state.snapshots.recover();

    assert.equal(read(slots, box, "app/data.txt"), "at the take\n");
    assert.equal((await fresh(state, box)).state, "ready");
    assert.equal(slotOf(slots, box).booted, true);
    assert.deepEqual(state.store.operations({ box: box.id, kind: "restore" }).map((operation) => operation.state), ["done"]);
  });

  it("deletes the slot's snapshots when its box is released", async () => {
    const slots = slotWorld();
    const box = await slotBox(slots);
    await slots.state.snapshots.take(COMMAND, box, standing(box), { name: "before" });
    const user = userOf(box);
    assert.ok(existsSync(join(slots.pool.mac.root, STORES, user)));

    await slots.state.boxes.release(THREAD, box.id, "the test is done", BY_COMMAND);

    assert.equal(existsSync(join(slots.pool.mac.root, STORES, user)), false);
    assert.deepEqual(await slots.backend().heldSnapshots(), []);
  });

  it("offers home snapshots for ios, refusing a fork with the slot's reason", async () => {
    const slots = slotWorld();
    await slotBox(slots);

    const offer = slots.backend().snapshotting("ios");

    assert.equal(offer?.scope, "home");
    assert.equal(offer?.restore, "in-place");
    assert.equal(offer?.forkWhy, SLOT_FORK_OFF);
  });
});
