import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { test } from "node:test";
import { BY_COMMAND } from "../src/core/box-log.ts";
import type { BoxRecord } from "../src/core/boxes.ts";
import { jpegOf } from "../src/core/jpeg.ts";
import { rgbaPng } from "../src/core/png.ts";
import type { Caller } from "../src/core/snapshot.ts";
import { PICTURE_EDGE, pictureOfScreen } from "../src/core/snapshot-picture.ts";
import { boxSnapshotsView, PERSON, restorePreview, TakeChecks } from "../src/plugin/snapshot-card.ts";
import { PICTURES_HELD_BYTES } from "../src/plugin/snapshot-store.ts";
import { COMMAND, DAY, THREAD, readyBox, rejection, standing, world, type World } from "./snapshot-world.ts";

const AGENT: Caller = { is: "agent", threadId: THREAD };
const OTHER_AGENT: Caller = { is: "agent", threadId: "thr_other" };

function screenPng(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      rgba.set([(x * 255) / width, (y * 255) / height, 90, 255], at);
    }
  }
  return rgbaPng(width, height, rgba);
}

async function desktopBox(state: World): Promise<BoxRecord> {
  const box = await state.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-desktop", who: BY_COMMAND });
  const settled = await state.boxes.settled(box);
  assert.equal(settled?.state, "ready");
  return settled!;
}

function markers(jpeg: Uint8Array): { readonly width: number; readonly height: number } {
  assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8], "it starts as a JPEG");
  assert.deepEqual([...jpeg.subarray(-2)], [0xff, 0xd9], "and ends as one");
  for (let at = 2; at < jpeg.length; ) {
    assert.equal(jpeg[at], 0xff);
    const marker = jpeg[at + 1]!;
    const length = (jpeg[at + 2]! << 8) | jpeg[at + 3]!;
    if (marker === 0xc0) return { height: (jpeg[at + 5]! << 8) | jpeg[at + 6]!, width: (jpeg[at + 7]! << 8) | jpeg[at + 8]! };
    at += 2 + length;
  }
  throw new Error("no frame header");
}

test("a screen's picture is a baseline JPEG at most 320 px on its longest side, of a few tens of KB", () => {
  const wide = pictureOfScreen(screenPng(1568, 980));
  assert.deepEqual({ width: wide.width, height: wide.height }, { width: PICTURE_EDGE, height: 200 });
  assert.deepEqual(markers(wide.jpeg), { width: 320, height: 200 });
  assert.ok(wide.jpeg.length < 40_000, `${wide.jpeg.length} bytes`);
  const tall = pictureOfScreen(screenPng(540, 1170));
  assert.equal(tall.height, PICTURE_EDGE);
  assert.deepEqual(markers(tall.jpeg), { width: tall.width, height: 320 });
  const odd = jpegOf({ width: 17, height: 9, rgba: new Uint8Array(17 * 9 * 4).fill(255) }, 70);
  assert.deepEqual(markers(odd), { width: 17, height: 9 }, "sizes that are not a multiple of 16 are encoded whole");
  assert.throws(() => pictureOfScreen(new Uint8Array([1, 2, 3])), /not a PNG/);
});

test("a take keeps a picture of the screen, which only those who may see the snapshot get; headless boxes and the setting say why there is none", async () => {
  const state = world();
  state.screen = async () => screenPng(1280, 800);
  const box = await desktopBox(state);
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "with a picture" })).snapshot!;
  assert.equal(taken.state, "ready");
  assert.equal(state.store.record(taken.id)?.picture, "taken");
  const picture = state.snapshots.picture(PERSON, standing(box), taken.id);
  assert.deepEqual(markers(picture!.jpeg), { width: 320, height: 200 });
  assert.equal(state.snapshots.picture(AGENT, standing(box), taken.id)?.width, 320, "the agent of the box's thread sees it");
  const refused = await rejection(Promise.resolve().then(() => state.snapshots.picture(OTHER_AGENT, standing(box), taken.id)));
  assert.equal(refused.code, "not_found", "another thread's agent cannot even find it");

  state.settings = { pictures: false };
  const off = (await state.snapshots.take(COMMAND, box, standing(box), { name: "pictures off" })).snapshot!;
  assert.equal(state.store.record(off.id)?.picture, "off");
  assert.equal(state.snapshots.picture(PERSON, standing(box), off.id), null);

  state.settings = {};
  const headless = await readyBox(state);
  const plain = (await state.snapshots.take(COMMAND, headless, standing(headless), { name: "no screen" })).snapshot!;
  assert.equal(state.store.record(plain.id)?.picture, "none");

  await state.snapshots.delete(COMMAND, standing(box), taken.id);
  assert.equal(state.store.picture(taken.id), null, "a picture goes with its snapshot");
});

test("a picture that fails or is late never fails or holds up the snapshot: it waits 2 s at most", async () => {
  const state = world();
  const box = await desktopBox(state);
  state.screen = async () => {
    throw new Error("the driver is not running");
  };
  const failed = (await state.snapshots.take(COMMAND, box, standing(box), { name: "driver down" })).snapshot!;
  assert.equal(failed.state, "ready");
  assert.equal(state.store.record(failed.id)?.picture, "failed");
  assert.ok(state.logs.some((line) => line.includes("driver is not running")));

  let aborted = false;
  state.screen = (_box, signal) =>
    new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      });
    });
  const began = Date.now();
  const late = (await state.snapshots.take(COMMAND, box, standing(box), { name: "late" })).snapshot!;
  const took = Date.now() - began;
  assert.equal(late.state, "ready");
  assert.equal(state.store.record(late.id)?.picture, "failed");
  assert.ok(aborted, "the late picture is asked to stop");
  assert.ok(took < 4_000, `the take took ${took} ms`);
});

test("a restore's undo has a picture from before the stop", async () => {
  const state = world();
  const shots: string[] = [];
  state.screen = async (box) => {
    const now = (await state.boxes.find(box.id))!;
    shots.push(now.state);
    return screenPng(64, 40);
  };
  const box = await desktopBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "target" });
  const answer = await state.snapshots.restore(COMMAND, box, standing(box), "target");
  assert.equal(state.store.record(answer.undo!.id)?.picture, "taken");
  assert.equal(shots.length, 2);
  assert.ok(state.store.picture(answer.undo!.id));
});

test("pictures are capped: past 48 MB the oldest of snapshots nobody kept go first, never a kept one's", async () => {
  const state = world();
  const box = await desktopBox(state);
  const ids: string[] = [];
  for (const name of ["kept", "old", "newer"]) {
    ids.push((await state.snapshots.take(COMMAND, box, standing(box), { name })).snapshot!.id);
    state.tick(60_000);
  }
  state.store.updateRecord(ids[0]!, { keptUntil: state.now + 30 * DAY, keptAt: state.now });
  const third = Math.ceil(PICTURES_HELD_BYTES / 3) + 1;
  for (const [index, id] of ids.entries()) state.store.putPicture({ snapshot: id, jpeg: new Uint8Array(third), width: 320, height: 200, at: state.now + index });
  assert.ok(state.store.picture(ids[0]!), "the kept one keeps its picture");
  assert.equal(state.store.picture(ids[1]!), null, "the oldest unkept one lost its picture");
  assert.equal(state.store.record(ids[1]!)?.picture, null);
  assert.ok(state.store.picture(ids[2]!), "the new one is kept");
});

test("rename and note: the person's and the box's agent's, unique per box, refused while a restore uses the snapshot", async () => {
  const state = world();
  const box = await readyBox(state);
  const first = (await state.snapshots.take(COMMAND, box, standing(box), { name: "first" })).snapshot!;
  await state.snapshots.take(COMMAND, box, standing(box), { name: "second" });
  const renamed = await state.snapshots.rename(PERSON, standing(box), first.id, "  before the upgrade ");
  assert.equal(renamed.name, "before the upgrade");
  assert.match((await rejection(state.snapshots.rename(PERSON, standing(box), first.id, "second"))).message, /has a snapshot named "second" already/);
  assert.match((await rejection(state.snapshots.rename(PERSON, standing(box), first.id, "x".repeat(61)))).message, /at most 60 characters/);
  const noted = await state.snapshots.annotate(PERSON, standing(box), "before the upgrade", "Signed in to the staging site.");
  assert.equal(noted.note, "Signed in to the staging site.");
  assert.equal((await state.snapshots.annotate(PERSON, standing(box), first.id, "   ")).note, null, "an empty note clears it");
  assert.match((await rejection(state.snapshots.annotate(PERSON, standing(box), first.id, "é".repeat(600)))).message, /at most 1024 bytes/);
  assert.equal((await rejection(state.snapshots.rename(AGENT, standing(box), first.id, "mine"))).code, "not_owner", "renaming is the person's");
  assert.equal((await rejection(state.snapshots.rename(OTHER_AGENT, standing(box), first.id, "mine"))).code, "not_found");

  state.holds.step = "stopped";
  const restoring = state.snapshots.restore(COMMAND, box, standing(box), "second");
  while (!state.store.unsettled().some((operation) => operation.kind === "restore" && operation.step === "stopped")) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.match((await rejection(state.snapshots.rename(PERSON, standing(box), "second", "renamed meanwhile"))).message, /in use by the restore/);
  await state.restart();
  void restoring.catch(() => undefined);
});

test("the take check plans and refuses as a take would, and changes nothing", async () => {
  const state = world();
  const box = await readyBox(state);
  const check = await state.snapshots.checkTake(PERSON, box, standing(box));
  assert.ok(check.aboutMs > 0);
  assert.equal(state.store.records({ box: box.id }).length, 0);
  state.settings = { perBox: 1 };
  await state.snapshots.take(COMMAND, box, standing(box), { name: "only" });
  assert.match((await rejection(state.snapshots.checkTake(PERSON, box, standing(box)))).message, /allow 1 a box\. Delete one first: "only"/);
  assert.equal(state.store.records({ box: box.id }).length, 1);
  const checks = new TakeChecks(state.snapshots, () => state.now);
  assert.match((await checks.why(box)) ?? "", /allow 1 a box/);
  state.settings = {};
  assert.equal(await checks.why(box), null, "a changed setting reads the plan again");
});

test("the box page's view: counts, rows newest first, the restore's notice for 24 hours with its undo, and a restore BB Box could not confirm", async () => {
  const state = world();
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "older" });
  state.tick(60_000);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "newer" });
  let view = boxSnapshotsView(state.snapshots, (await state.boxes.find(box.id))!, null, state.now);
  assert.deepEqual(view.records.map((row) => row.name), ["newer", "older"]);
  assert.equal(view.counted, 2);
  assert.equal(view.perBox, 5);
  assert.equal(view.restored, null);
  assert.ok(view.offer?.holds.includes("disk"));

  state.tick(60_000);
  const answer = await state.snapshots.restore(PERSON, box, standing(box), "older");
  view = boxSnapshotsView(state.snapshots, (await state.boxes.find(box.id))!, null, state.now);
  assert.equal(view.restored?.to, "older");
  assert.equal(view.restored?.by.is, "person");
  assert.deepEqual(view.restored?.undo, { id: answer.undo!.id, name: answer.undo!.name, ready: true });
  assert.equal(view.undos, 1);
  assert.equal(view.counted, 2, "undos are counted apart");
  const undoRow = view.records.find((row) => row.id === answer.undo!.id)!;
  assert.equal(undoRow.undoOf?.to, "older");
  state.tick(DAY + 60_000);
  assert.equal(boxSnapshotsView(state.snapshots, (await state.boxes.find(box.id))!, null, state.now).restored, null, "the notice goes after 24 hours");

  state.holds.step = "rolled-back";
  void state.snapshots.restore(PERSON, box, standing(box), "newer").catch(() => undefined);
  while (!state.store.unsettled().some((operation) => operation.step === "rolled-back")) await new Promise((resolve) => setTimeout(resolve, 5));
  view = boxSnapshotsView(state.snapshots, (await state.boxes.find(box.id))!, null, state.now);
  assert.equal(view.restoring?.to, "newer");
  await state.restart();
  view = boxSnapshotsView(state.snapshots, (await state.boxes.find(box.id))!, null, state.now);
  assert.equal(view.restoring, null);
  assert.equal(view.unconfirmed?.to, "newer");
});

test("the restore dialog's preview names every thread, the control and a terminal, and says why a box threads run on is not restored", async () => {
  const state = world();
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "target" });
  state.guard = { threads: [{ id: "thr_a", title: "Fix the sign-in flow", running: true }, { id: "thr_b", title: "Write the API guide", running: false }], threadsUnread: null, control: true, terminals: 1 };
  let preview = await restorePreview(state.snapshots, box, "target");
  assert.deepEqual(preview.threads.map((thread) => thread.title), ["Fix the sign-in flow", "Write the API guide"]);
  assert.equal(preview.control, true);
  assert.equal(preview.terminals, 1);
  assert.match(preview.refusal ?? "", /is a box threads run on/);
  assert.equal(preview.check, null);

  state.guard = { threads: [], threadsUnread: null, control: true, terminals: 1 };
  preview = await restorePreview(state.snapshots, box, "target");
  assert.equal(preview.refusal, null);
  assert.match(preview.check?.undo?.name ?? "", /^before the restore at /);
  assert.equal(preview.check?.undoRefused, null);
  assert.equal(state.store.records({ box: box.id }).length, 1, "nothing changed");

  state.provider.percentFull = 90;
  preview = await restorePreview(state.snapshots, box, "target");
  assert.equal(preview.refusal, null, "a refused undo leaves the restore to the person");
  assert.equal(preview.check?.undo, null);
  assert.match(preview.check?.undoRefused ?? "", /is 90% full/);
  assert.doesNotMatch(preview.check?.undoRefused ?? "", /--no-undo/, "the page's words name no command flag");
});

function pngChunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, Buffer.from(type, "latin1"), body, Buffer.alloc(4)]);
}

function craftedPng(width: number, height: number, rows: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(rows)), pngChunk("IEND", Buffer.alloc(0))]);
}

test("a screen's PNG is bounded before it is inflated, and a corrupt one is refused", () => {
  assert.throws(() => pictureOfScreen(craftedPng(40_000, 40_000, Buffer.alloc(16))), /at most 2048 a side/);
  const bomb = craftedPng(100, 100, Buffer.alloc(64 * 1024 * 1024));
  assert.ok(bomb.length < 200_000, `${bomb.length} bytes`);
  assert.throws(() => pictureOfScreen(bomb), /larger|exceed|range/i);
  assert.throws(() => pictureOfScreen(craftedPng(10, 10, Buffer.alloc(5 * 41))), /not the 410 its size needs/);
  const badFilter = Buffer.alloc(10 * 41);
  badFilter[0] = 9;
  assert.throws(() => pictureOfScreen(craftedPng(10, 10, badFilter)), /filter 9/);
  assert.throws(() => pictureOfScreen(Buffer.concat([screenPng(4, 4), Buffer.alloc(9 * 1024 * 1024)])), /over 8388608/);
  assert.equal(pictureOfScreen(screenPng(64, 40)).width, 64);
});

test("the 48 MB of pictures counts kept ones and the new one: the oldest unkept go first, and a new one that cannot fit is refused", async () => {
  const state = world();
  const box = await desktopBox(state);
  const ids: string[] = [];
  for (const name of ["kept one", "kept two", "unkept"]) {
    ids.push((await state.snapshots.take(COMMAND, box, standing(box), { name })).snapshot!.id);
    state.tick(60_000);
  }
  for (const id of ids.slice(0, 2)) state.store.updateRecord(id, { keptUntil: state.now + 30 * DAY, keptAt: state.now });
  const half = Math.floor(PICTURES_HELD_BYTES / 2) - 1024;
  assert.equal(state.store.putPicture({ snapshot: ids[0]!, jpeg: new Uint8Array(half), width: 320, height: 200, at: 1 }), true);
  assert.equal(state.store.putPicture({ snapshot: ids[1]!, jpeg: new Uint8Array(half), width: 320, height: 200, at: 2 }), true);
  assert.equal(state.store.putPicture({ snapshot: ids[2]!, jpeg: new Uint8Array(16 * 1024), width: 320, height: 200, at: 3 }), false, "kept pictures fill it, so the new one is refused");
  assert.equal(state.store.picture(ids[2]!), null);
  const held = [ids[0]!, ids[1]!].reduce((sum, id) => sum + (state.store.picture(id)?.jpeg.byteLength ?? 0), 0);
  assert.ok(held <= PICTURES_HELD_BYTES);
  assert.equal(state.store.putPicture({ snapshot: ids[2]!, jpeg: new Uint8Array(PICTURES_HELD_BYTES + 1), width: 320, height: 200, at: 4 }), false);

  state.screen = async () => screenPng(1280, 800);
  const late = (await state.snapshots.take(COMMAND, box, standing(box), { name: "no room" })).snapshot!;
  assert.equal(state.store.record(late.id)?.picture, "failed", "a picture that does not fit is recorded as failed");
  assert.ok(state.logs.some((line) => /fill the 48 MB/.test(line)));
});

test("the page's view keeps a failed restore with its reason for 24 hours, a restore whose undo may miss the last writes, and the preview's token follows what it shows", async () => {
  const state = world();
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  state.provider.powerOffFault = new Error("the guest would not stop");
  await rejection(state.snapshots.restore(PERSON, box, standing(box), "one"));
  let view = boxSnapshotsView(state.snapshots, (await state.boxes.find(box.id))!, null, state.now);
  assert.equal(view.failed?.to, "one");
  assert.match(view.failed?.error ?? "", /the guest would not stop/);
  assert.equal(view.restored, null);

  const first = await restorePreview(state.snapshots, box, "one");
  assert.equal((await restorePreview(state.snapshots, box, "one")).token, first.token, "the same state gives the same token");
  state.guard = { threads: [], threadsUnread: null, control: false, terminals: 2 };
  const moved = await restorePreview(state.snapshots, box, "one");
  assert.notEqual(moved.token, first.token, "a terminal opened since changes it");
  assert.deepEqual(moved.check?.anyway, ["2 BB terminals are open on it"]);
  state.guard = { threads: [], threadsUnread: null, control: false, terminals: 0 };

  const transports = state.backend.transports.bind(state.backend);
  state.backend.transports = async (guest, kind) => {
    const found = await transports(guest, kind);
    const command = found.command!;
    return { ...found, command: Object.assign(Object.create(Object.getPrototypeOf(command)), command, { run: async (script: string, options?: Parameters<typeof command.run>[1]) => (script === "sync" ? { exitCode: 1, stdout: "", stderr: "sync failed" } : command.run(script, options)) }) };
  };
  state.tick(60_000);
  const went = await state.snapshots.restore(PERSON, box, standing(box), "one", { unflushed: "go-on" });
  view = boxSnapshotsView(state.snapshots, (await state.boxes.find(box.id))!, null, state.now);
  assert.equal(view.restored?.unflushed, "sync failed");
  assert.equal(view.failed, null, "the later restore replaces the failed one's notice");
  assert.equal((await restorePreview(state.snapshots, box, went.undo!.id)).undoUnflushed, "sync failed", "the undo's own dialog says it");
});
