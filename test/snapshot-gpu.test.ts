import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { Backend } from "../src/backends/types.ts";
import { snapshotGpuWords, snapshotGpuWordsFor } from "../src/core/gpu.ts";
import { snapshotLine } from "../src/core/snapshot.ts";
import { openBoxFiles } from "../src/plugin/attached-files.ts";
import { rowOf } from "../src/plugin/snapshot-card.ts";
import { SNAPSHOT_MIGRATIONS, SnapshotStore } from "../src/plugin/snapshot-store.ts";
import { fakeNvidia, updateCalls, withFakeNvidia } from "./fake-nvidia.ts";
import { tempDir } from "./helpers.ts";
import { record } from "./snapshot-fixtures.ts";
import { COMMAND, armedWorld, readyBox, standing } from "./snapshot-world.ts";

const GPU = { part: "shared", card: "GPU-test-card", index: 1, userspace: "570.86" } as const;

test("the GPU migration preserves older snapshots as unrecorded, and stores all GPU fields across inserts, updates and reopen", () => {
  const db = new Database(join(tempDir("snapshot-gpu-migration"), "data.db"));
  const source = { database: () => db as never };
  const previous = openBoxFiles(source, { log: [], history: [], snapshots: SNAPSHOT_MIGRATIONS.slice(0, -1) });
  db.prepare(`INSERT INTO ${previous.snapshots.table("snapshots")} (id, box, box_name, box_kind, box_system, box_thread, backend, backend_label, guest, lives_on, name, taken_at, who, scope, holds, owner, state, state_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("snolderaaaaaaaa", "bxolder", "older-box", "linux-desktop", "linux", "thr_one", "test", "Test backend", "current", '{"ref":"old","host":null,"address":null,"size":null}', "before the migration", 1, "person", "box", "disk", "person", "ready", 1);
  const files = openBoxFiles(source, { log: [], history: [], snapshots: SNAPSHOT_MIGRATIONS });
  assert.equal(files.snapshots.migrationsRun, 1);
  const store = new SnapshotStore({ file: files.snapshots });
  assert.equal(store.record("snolderaaaaaaaa")?.gpu, null);
  const taken = record({ gpu: GPU });
  store.insertRecord(taken);
  assert.deepEqual(store.record(taken.id)?.gpu, GPU);
  store.updateRecord(taken.id, { note: "kept" });
  assert.deepEqual(store.records().find((snapshot) => snapshot.id === taken.id)?.gpu, GPU);
  const reopened = new SnapshotStore({ file: openBoxFiles(source, { log: [], history: [], snapshots: SNAPSHOT_MIGRATIONS }).snapshots });
  assert.deepEqual(reopened.record(taken.id)?.gpu, GPU);
  reopened.updateRecord(taken.id, { gpu: { part: "none", card: null, index: null, userspace: "none" } });
  assert.equal(store.record(taken.id)?.gpu?.part, "none");
  db.close();
});

test("GPU words stay off non-Linux snapshots without a card, in the CLI and the page", () => {
  const state = armedWorld();
  const base = record();
  for (const system of ["macos", "windows"]) {
    for (const gpu of [null, { part: "none", card: null, index: null, userspace: "none" }] as const) {
      const snapshot = record({ box: { ...base.box, system }, gpu });
      assert.doesNotMatch(snapshotLine(snapshot), /GPU|NVIDIA/);
      assert.equal(rowOf(state.snapshots, snapshot, state.now).gpu, null);
    }
    assert.match(snapshotGpuWordsFor(system, GPU) ?? "", /GPU: shared/);
  }
  assert.match(snapshotGpuWordsFor("linux", { part: "none", card: null, index: null, userspace: "none" }) ?? "", /GPU: none/);
  assert.equal(snapshotGpuWordsFor("linux", null), "GPU not recorded");
});

test("a take through the real store keeps the GPU claim and userspace, shows them, and a restore warns about a changed driver", async () => {
  const state = armedWorld();
  const box = await readyBox(state);
  const withGpu = (await state.boxes.update(box, () => ({ nvidiaUserspace: GPU.userspace })))!;
  const backend: Backend = state.backend;
  withFakeNvidia(backend, fakeNvidia({ file: GPU.userspace, library: GPU.userspace }));
  backend.readGpuClaim = async () => ({ part: GPU.part, card: GPU.card, index: GPU.index, generation: 1 });
  backend.gpuRestoreFacts = async () => ({ held: await backend.readGpuClaim!(withGpu.guest!), driver: "580.142" });
  const taken = (await state.snapshots.take(COMMAND, withGpu, standing(withGpu), { name: "GPU snapshot" })).snapshot!;
  assert.deepEqual(state.store.record(taken.id)?.gpu, GPU);
  assert.match(snapshotLine(taken), /GPU: shared, card 1; NVIDIA userspace: 570\.86/);
  assert.match(rowOf(state.snapshots, taken, state.now).gpu ?? "", /GPU: shared, card 1; NVIDIA userspace: 570\.86/);
  const check = await state.snapshots.checkRestore(COMMAND, withGpu, standing(withGpu), taken.id);
  assert.match(check.userspaceNote ?? "", /userspace 570\.86, and the host's driver is now 580\.142: nvidia-smi will fail/);
  assert.match(snapshotGpuWords(null), /GPU not recorded/);
});

test("071 unit 12: a take reads the box's userspace now, whatever its record says; a restore to a snapshot with an older userspace reads the box again, and the doctor names it; nothing updates it", async () => {
  const state = armedWorld();
  const nvidia = fakeNvidia({ file: "570.86", library: "570.86" });
  withFakeNvidia(state.backend, nvidia);
  const backend: Backend = state.backend;
  const rollback = backend.rollbackSnapshot!.bind(backend);
  const disks = new Map<string, string>();
  backend.rollbackSnapshot = async (guest, ref, hooks) => {
    await rollback(guest, ref, hooks);
    const kept = disks.get(ref.id);
    if (kept) nvidia.file = nvidia.library = kept;
  };
  const plain = await readyBox(state);
  const box = (await state.boxes.update(plain, () => ({ size: { ...plain.size!, gpu: "shared" as const }, nvidiaUserspace: "580.142" })))!;
  const older = (await state.snapshots.take(COMMAND, box, standing(box), { name: "older userspace" })).snapshot!;
  disks.set(older.id, "570.86");
  assert.equal(state.store.record(older.id)?.gpu?.userspace, "570.86", "read from the box, not the record's 580.142");

  nvidia.file = nvidia.library = "580.142";
  const updated = await state.boxes.readUserspace(box);
  assert.equal(updated.nvidiaUserspace, "580.142");
  assert.equal((await state.boxes.userspaceChecks()).some((check) => check.id === `gpu-userspace.${box.name}`), false);

  await state.snapshots.restore(COMMAND, updated, standing(updated), older.id);
  const restored = (await state.boxes.find(box.id))!;
  assert.equal(restored.state, "ready");
  assert.equal(restored.nvidiaUserspace, "570.86", "read again after the restore");
  const named = (await state.boxes.userspaceChecks()).find((check) => check.id === `gpu-userspace.${box.name}`);
  assert.equal(named?.status, "warn");
  assert.equal(named?.detail, `Box ${box.name} has NVIDIA's userspace 570.86, and the host's driver is 580.142: nvidia-smi and CUDA fail in it until its userspace is updated.`);
  assert.deepEqual(updateCalls(nvidia), [], "neither the take, the restore nor the doctor updates it");
});

test("071 unit 12: a restore's start settles an update that failed after its install, once the box it brings back has the host's driver", async () => {
  const state = armedWorld();
  const nvidia = fakeNvidia({ file: "580.142", library: "580.142" });
  withFakeNvidia(state.backend, nvidia);
  const plain = await readyBox(state);
  const box = (await state.boxes.update(plain, () => ({ size: { ...plain.size!, gpu: "shared" as const } })))!;
  const matching = (await state.snapshots.take(COMMAND, box, standing(box), { name: "matching" })).snapshot!;
  const failed = (await state.boxes.update(box, () => ({ userspaceUpdate: { from: "570.86", to: "580.142", at: state.now, state: "failed" as const, step: "check" as const, ms: 1, error: "nvidia-smi in it listed no card" } })))!;
  await state.boxes.readUserspace(failed);
  assert.equal((await state.boxes.find(box.id))?.userspaceUpdate?.state, "failed", "a reading with no start leaves it named");
  await state.snapshots.restore(COMMAND, failed, standing(failed), matching.id);
  assert.equal((await state.boxes.find(box.id))?.userspaceUpdate?.state, "done");
  assert.deepEqual(updateCalls(nvidia), []);
});
