import assert from "node:assert/strict";
import { test } from "node:test";
import { snapshotLine } from "../src/core/snapshot.ts";
import { takenText } from "../src/plugin/snapshot-words.ts";
import { COMMAND, flushing, readyBox, standing, world } from "./snapshot-world.ts";

test("070 unit 7: a take of a running box flushes its writes to its disk first, disk only and with memory; a stopped box has nothing to flush", async () => {
  const state = world();
  const box = await readyBox(state);
  flushing(state, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  const disk = (await state.snapshots.take(COMMAND, box, standing(box), { name: "disk" })).snapshot!;
  const memory = (await state.snapshots.take(COMMAND, box, standing(box), { name: "memory", memory: true })).snapshot!;
  assert.deepEqual(state.provider.order, ["flush", `take ${disk.id}`, "flush", `take ${memory.id}`]);
  assert.equal(disk.unflushed ?? null, null);
  assert.doesNotMatch(snapshotLine(disk), /last writes/);
  await state.boxes.stop(box.threadId, box.id);
  state.provider.order.length = 0;
  const stopped = (await state.snapshots.take(COMMAND, box, standing(box), { name: "stopped" })).snapshot!;
  assert.deepEqual(state.provider.order, [`take ${stopped.id}`]);
});

test("070 unit 7: a take whose flush fails still goes ahead, and its record, its answer and the list say it may miss the last writes", async () => {
  const state = world();
  const box = await readyBox(state);
  flushing(state, async () => ({ exitCode: 1, stdout: "", stderr: "sync: Input/output error" }));
  const answer = await state.snapshots.take(COMMAND, box, standing(box), { name: "unflushed" });
  const taken = answer.snapshot!;
  assert.equal(taken.state, "ready", "the take is not stopped");
  assert.equal(taken.unflushed, "sync: Input/output error");
  assert.equal(state.store.record(taken.id)?.unflushed, "sync: Input/output error", "kept on the record");
  assert.match(takenText(answer, box.name, 5), /\nbb-box could not flush the box's writes to its disk before it \(sync: Input\/output error\), so it may miss what was written in the last seconds before it\.\n/);
  assert.match(snapshotLine(taken), / · may miss its last writes$/);
});

test("070 unit 7: a flush that does not answer holds a take 15 s at most, and the take goes ahead", async () => {
  const state = world();
  const box = await readyBox(state);
  flushing(state, () => new Promise(() => undefined));
  const began = Date.now();
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "late" })).snapshot!;
  assert.equal(taken.state, "ready");
  assert.match(taken.unflushed ?? "", /15 s/);
  assert.ok(Date.now() - began < 20_000);
});

test("070 unit 7 reviews: a flush's words longer than the record keeps are cut on a UTF-8 boundary, and the take still goes ahead with its warning", async () => {
  const state = world();
  const box = await readyBox(state);
  const long = "sync: ".concat("défaillance d'entrée-sortie ✗ ".repeat(80));
  flushing(state, async () => ({ exitCode: 1, stdout: "", stderr: long }));
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "long" })).snapshot!;
  assert.equal(taken.state, "ready");
  const kept = state.store.record(taken.id)!.unflushed!;
  assert.ok(new TextEncoder().encode(kept).length <= 1000, String(new TextEncoder().encode(kept).length));
  assert.ok(long.startsWith(kept), "a prefix, whole characters only");
  assert.equal(state.store.problem, null, "the record was written");
});
