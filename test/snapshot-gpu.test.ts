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
