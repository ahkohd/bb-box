import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoxRecord, RecordedSize } from "../src/core/boxes.ts";
import { COMMAND, THREAD, readyBox, standing, world, type World } from "./snapshot-world.ts";

async function stored(state: World, box: BoxRecord): Promise<BoxRecord> {
  return (await state.kv.get<BoxRecord>(`box/${box.threadId}/${box.id}`))!;
}

async function recordAs(state: World, box: BoxRecord, size: RecordedSize): Promise<BoxRecord> {
  return (await state.boxes.update(box, () => ({ size })))!;
}

function withoutGpu(size: RecordedSize): RecordedSize {
  const { gpu: _, ...machine } = size;
  return machine;
}

async function done(state: World): Promise<void> {
  await state.boxes.idle();
  state.snapshots.dispose();
  await state.boxes.dispose();
}

test("071 unit 1: a restore through BB Box keeps the GPU part its box's record has, and keeps a record from before without one", async () => {
  const state = world();
  const whole = await recordAs(state, await readyBox(state), { cores: 2, memoryMiB: 4096, diskGiB: null, gpu: "whole" });
  const old = await readyBox(state);
  await recordAs(state, old, withoutGpu(old.size!));
  for (const box of [whole, old]) {
    const taken = await state.snapshots.take(COMMAND, box, standing(box));
    const answer = await state.snapshots.restore(COMMAND, box, standing(box), taken.snapshot!.id);
    assert.equal(answer.operation.state, "done");
  }
  assert.equal((await stored(state, whole)).size?.gpu, "whole");
  assert.equal(Object.hasOwn((await stored(state, old)).size!, "gpu"), false);
  await done(state);
});

test("071 unit 1: a restore made outside BB Box reads the size back and keeps the GPU part its box's record has", async () => {
  const state = world();
  const box = await recordAs(state, await readyBox(state), { cores: 2, memoryMiB: 4096, diskGiB: null, gpu: "whole" });
  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  state.backend.setSize(box.guest!.ref, { cores: 3, memoryMiB: 4096, diskGiB: null });
  state.provider.outside.push({ task: { ref: "UPID:one", host: "pve-1" }, guest: box.guest!.ref, user: "root@pam", startedAt: state.now + 60_000, outcome: { state: "ok" } });
  state.tick(5 * 60_000);
  await state.snapshots.sweep();
  assert.deepEqual((await stored(state, box)).size, { cores: 3, memoryMiB: 4096, diskGiB: null, gpu: "whole" });
  await done(state);
});

test("071 unit 1: a resize writes no GPU part into a record from before, and keeps the one a record has", async () => {
  const state = world();
  state.backend.resizeWays = { cores: "live", memory: "live", disk: "live", shrinks: true };
  const old = await readyBox(state);
  await recordAs(state, old, withoutGpu(old.size!));
  const answer = await state.boxes.resize(THREAD, old.name, { cores: 3 });
  assert.equal(answer.to.gpu, "none", "it reads as section 1 says");
  const after = await stored(state, old);
  assert.deepEqual([after.size, after.resize?.from, after.resize?.to], [
    { cores: 3, memoryMiB: 4096, diskGiB: null },
    { cores: 2, memoryMiB: 4096, diskGiB: null },
    { cores: 3, memoryMiB: 4096, diskGiB: null },
  ]);
  const whole = await recordAs(state, await readyBox(state), { cores: 2, memoryMiB: 4096, diskGiB: null, gpu: "whole" });
  await state.boxes.resize(THREAD, whole.name, { cores: 3 });
  const resized = await stored(state, whole);
  assert.deepEqual([resized.size?.gpu, resized.resize?.from.gpu, resized.resize?.to.gpu], ["whole", "whole", "whole"]);
  await done(state);
});

test("071 unit 1: a resize cut short by the upgrade is finished by the sweep without writing a GPU part into the record", async () => {
  const state = world();
  const box = await readyBox(state);
  await state.boxes.idle();
  const size = withoutGpu(box.size!);
  await state.boxes.update(box, () => ({ size, resize: { from: size, to: { ...size, cores: 4 }, at: state.now, state: "resizing", ms: null, restart: false, error: null } }));
  await state.restart();
  await state.boxes.sweep();
  const after = await stored(state, box);
  assert.equal(after.resize?.state, "failed");
  assert.deepEqual(after.size, { cores: 2, memoryMiB: 4096, diskGiB: null });
  await done(state);
});
