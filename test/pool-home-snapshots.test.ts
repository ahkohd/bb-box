import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { SshPoolBackend } from "../src/backends/ssh-pool/backend.ts";
import { parseSshPoolSettings } from "../src/backends/ssh-pool/config.ts";
import { HOME_FORK_OFF, SLOT_SNAPSHOTS_LATER } from "../src/backends/ssh-pool/home-snapshots.ts";
import { SLOT_MAC_KEY } from "../src/backends/ssh-pool/slots.ts";
import { BackendError, type Backend, type BackendStorage, type Guest } from "../src/backends/types.ts";
import { BY_COMMAND } from "../src/core/box-log.ts";
import type { BoxRecord } from "../src/core/boxes.ts";
import { restoreCheckText, restoredText, takeCheckText } from "../src/plugin/snapshot-words.ts";
import { FAKE_SSH_BINARY, MemoryStorage, disposedOnceTheFileEnds, fakeSsh, testContext } from "./helpers.ts";
import { COMMAND, THREAD, rejection, standing, untilHeld, world, type World } from "./snapshot-world.ts";

const HELPER = `node ${new URL("./fake-machine.mjs", import.meta.url).pathname}`;
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIDbH0n7Bm2fQzZ0lH8w5j0c0pYh7J6Hq4Xb1x2u3v4w";
const fake = fakeSsh();
const disposed = disposedOnceTheFileEnds();
const NOTES = "notes.txt";

function mac(host: string, flags: Record<string, string> = {}): void {
  const state = join(fake.home(host), ".bb-box-state");
  rmSync(state, { recursive: true, force: true });
  mkdirSync(join(state, "flags"), { recursive: true });
  writeFileSync(join(state, "generation"), "0\n");
  for (const [name, value] of Object.entries({ macos: "", cores: "8", memory: "16384", disk: "200", "homes-snapshot": "apfs", ...flags })) writeFileSync(join(state, "flags", name), value);
  const socket = join(fake.home(host), "Library", "Caches", "cua-driver");
  mkdirSync(socket, { recursive: true });
  rmSync(join(socket, "cua-driver.sock"), { force: true });
  assert.equal(spawnSync(process.execPath, ["-e", "require('node:net').createServer().listen('cua-driver.sock', () => process.exit(0))"], { cwd: socket }).status, 0);
}

function pool(host: string, storage: BackendStorage): SshPoolBackend {
  const parsed = parseSshPoolSettings({
    "ssh-pool-enabled": true,
    "ssh-pool-machines": `mac-1 ${host} macos,macos-desktop`,
    "ssh-pool-known-hosts": `${host} ${HOST_KEY}`,
    "ssh-pool-ssh-private-key": "",
  });
  assert.ok(parsed.enabled && parsed.ok, JSON.stringify(parsed));
  return disposed(new SshPoolBackend(parsed.config, testContext(storage, "test", { id: "fake" }), { sshBinary: FAKE_SSH_BINARY, helperCommand: HELPER, readyTimeoutMs: 0, resetPollMs: 1, sleep: async () => {} }));
}

async function lentMac(host: string, flags: Record<string, string> = {}): Promise<{ state: World; box: BoxRecord; backend: () => SshPoolBackend }> {
  mac(host, flags);
  const made: SshPoolBackend[] = [];
  const state = world({ markersOn: false, backend: (storage) => made[made.push(pool(host, storage)) - 1]! });
  await state.backend.doctor();
  const acquired = await state.boxes.acquire({ threadId: THREAD, projectId: null, kind: "macos", who: BY_COMMAND });
  const box = (await state.boxes.settled(acquired))!;
  assert.equal(box.state, "ready", box.error ?? "");
  return { state, box, backend: () => made.at(-1)! };
}

function write(host: string, text: string): void {
  writeFileSync(join(fake.home(host), NOTES), text);
}

function notes(host: string): string | null {
  const file = join(fake.home(host), NOTES);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

function helperCalls(host: string): string[] {
  return fake.log().filter((entry) => entry.target.endsWith(host)).map((entry) => /machine\.mjs (snapshot \w+)/.exec(entry.command)?.[1] ?? "").filter(Boolean);
}

describe("Home snapshots of a box on a Mac lent whole, through BB Box's snapshots (090)", () => {
  it("takes, lists, restores with an undo, restores the undo, and deletes", async () => {
    const host = "192.0.2.150";
    const { state, box, backend } = await lentMac(host);
    write(host, "at the take\n");

    const taken = await state.snapshots.take(COMMAND, box, standing(box), { name: "before" });
    assert.equal(taken.snapshot?.scope, "home");
    assert.equal(taken.snapshot?.state, "ready");
    assert.equal(taken.snapshot?.pausedMs, 5, "the helper's measured pause");
    write(host, "after the take\n");
    const restored = await state.snapshots.restore(COMMAND, (await state.boxes.find(box.id))!, standing(box), "before");

    assert.equal(notes(host), "at the take\n");
    assert.equal(restored.operation.state, "done");
    assert.ok(restored.undo, "an undo was taken first");
    assert.equal((await state.boxes.find(box.id))?.state, "ready");
    assert.deepEqual(helperCalls(host).filter((call) => ["snapshot stop", "snapshot restore", "snapshot start"].includes(call)), ["snapshot stop", "snapshot restore", "snapshot start"]);

    assert.match(restoredText(restored, box.name), /Everything in its home folder since then went\. Every process of its user ended, and it signed in again where it was\./);
    const check = await state.snapshots.checkRestore(COMMAND, (await state.boxes.find(box.id))!, standing(box), restored.undo!.id);
    assert.match(restoreCheckText(check), /- clear the Mac's automatic login, then end its user's session and every process of its user;/);
    assert.match(restoreCheckText(check), /- put a clone of the snapshot in its home folder's place, and sign its user in again where it was;/);
    assert.match(restoreCheckText(check), /Everything in .+'s home folder since then goes: its files, settings and keychain items\./);
    assert.doesNotMatch(restoreCheckText(check), /on its disk/);

    await state.snapshots.restore(COMMAND, (await state.boxes.find(box.id))!, standing(box), restored.undo!.id);
    assert.equal(notes(host), "after the take\n");

    for (const record of state.store.records({ box: box.id })) await state.snapshots.delete(COMMAND, standing(box), record.id);
    assert.deepEqual(await backend().heldSnapshots(), []);
  });

  it("says before a take that it holds the home folder, on the Mac's /Users", async () => {
    const { state, box } = await lentMac("192.0.2.157");

    const check = await state.snapshots.checkTake(COMMAND, box, standing(box));

    assert.match(takeCheckText(check, box.name), /^A snapshot of box .+ now would hold its home folder, on mac-1's \/Users, and take under a second\./);
  });

  it("refuses a fork and a keep, each with its reason", async () => {
    const host = "192.0.2.151";
    const { state, box } = await lentMac(host);
    await state.snapshots.take(COMMAND, box, standing(box), { name: "before" });

    const fork = await rejection(state.snapshots.fork(COMMAND, box, standing(box), "before"));
    const keep = await rejection(state.snapshots.keep(COMMAND, standing(box), "before"));

    assert.equal(fork.code, "unsupported");
    assert.ok(fork.message.includes(HOME_FORK_OFF), fork.message);
    assert.equal(keep.code, "unsupported");
    assert.match(keep.message, /home folder only, on a machine BB Box lends to other boxes after the release/);
  });

  it("finishes a restore BB Box restarted in the middle of", async () => {
    const host = "192.0.2.152";
    const { state, box } = await lentMac(host);
    write(host, "at the take\n");
    await state.snapshots.take(COMMAND, box, standing(box), { name: "before" });
    write(host, "after the take\n");
    state.holds.step = "undo";
    const held = state.snapshots.restore(COMMAND, (await state.boxes.find(box.id))!, standing(box), "before").catch((error: unknown) => error);
    await untilHeld(state, held);

    await state.restart();
    await held;
    await state.snapshots.recover();

    assert.equal(notes(host), "at the take\n");
    assert.equal((await state.boxes.find(box.id))?.state, "ready");
    assert.deepEqual(state.store.operations({ box: box.id, kind: "restore" }).map((operation) => operation.state), ["done"]);
  });

  it("deletes the box's snapshots when the box is released", async () => {
    const host = "192.0.2.153";
    const { state, box, backend } = await lentMac(host);
    await state.snapshots.take(COMMAND, box, standing(box), { name: "before" });

    await state.boxes.release(THREAD, box.id, "the test is done", BY_COMMAND);

    assert.equal(existsSync(join(fake.home(host), ".bb-box-state", "home-snapshots")), false);
    assert.deepEqual(await backend().heldSnapshots(), []);
  });
});

describe("Where home snapshots are refused (090)", () => {
  it("refuses an iOS slot's box with the reason, and takes nothing", async () => {
    const host = "192.0.2.154";
    mac(host);
    const backend: Backend = pool(host, new MemoryStorage());
    await backend.doctor();
    const slot: Guest = { ref: "mac-1/slot-1", host: "mac-1", address: null, size: null, data: { [SLOT_MAC_KEY]: "mac-1", slot: "1", box: "box_slot" } };

    const plan = await backend.planSnapshots!(slot, "macos", null);
    const take = await backend.snapshot!(slot, { id: "snaaaaaaaaaaaa", box: "box_slot", memory: false }, { submitting: async () => {}, task: async () => {} }).catch((error: unknown) => error);

    assert.deepEqual([plan.take.ok, plan.take.why, plan.restore.way], [false, SLOT_SNAPSHOTS_LATER, "none"]);
    assert.ok(take instanceof BackendError && take.code === "unsupported", String(take));
    assert.deepEqual(helperCalls(host).filter((call) => call !== "snapshot probe" && call !== "snapshot list"), []);
  });

  it("refuses on a Mac whose helper is older, saying how to update it", async () => {
    const host = "192.0.2.155";
    const { state, box } = await lentMac(host, { helper: "2" });

    const refused = await rejection(state.snapshots.take(COMMAND, box, standing(box), { name: "before" }));

    assert.match(refused.message, /helper version 2, and home snapshots need version 3: run this BB Box's setup-mac.sh on it again/);
  });

  it("offers home snapshots for a Mac's kinds only while one of its Macs reports they work", async () => {
    const host = "192.0.2.156";
    mac(host, { "homes-snapshot": "" });
    rmSync(join(fake.home(host), ".bb-box-state", "flags", "homes-snapshot"));
    const without = pool(host, new MemoryStorage());
    await without.doctor();
    mac(host);
    const offering = pool(host, new MemoryStorage());
    await offering.doctor();

    assert.equal(without.snapshotting("macos"), null);
    assert.equal(offering.snapshotting("macos")?.scope, "home");
    assert.equal(offering.snapshotting("macos-desktop")?.restore, "in-place");
    assert.equal(offering.snapshotting("ios"), null);
  });
});
