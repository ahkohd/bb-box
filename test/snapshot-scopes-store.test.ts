import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { openBoxFiles } from "../src/plugin/attached-files.ts";
import { SNAPSHOT_MIGRATIONS, SnapshotStore } from "../src/plugin/snapshot-store.ts";
import { tempDir } from "./helpers.ts";
import { record } from "./snapshot-fixtures.ts";

test("the store keeps home and machine snapshots, and the snapshots it held before its scopes widened", () => {
  const db = new Database(join(tempDir("snapshot-scopes"), "data.db"));
  const source = { database: () => db as never };
  const before = openBoxFiles(source, { log: [], history: [], snapshots: SNAPSHOT_MIGRATIONS.slice(0, -1) });
  db.prepare(`INSERT INTO ${before.snapshots.table("snapshots")} (id, box, box_name, box_kind, box_system, box_thread, backend, backend_label, guest, lives_on, name, taken_at, who, scope, holds, owner, state, state_at, paused_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("snolderaaaaaaaa", "bxolder", "older-box", "linux", "linux", "thr_one", "test", "Test backend", "current", '{"ref":"old","host":null,"address":null,"size":null}', "before the migration", 1, "person", "device", "disk", "person", "ready", 1, 42);

  const after = openBoxFiles(source, { log: [], history: [], snapshots: SNAPSHOT_MIGRATIONS });
  const store = new SnapshotStore({ file: after.snapshots });
  const home = record({ scope: "home" });
  const machine = record({ id: "snmachineaaaaa", name: "machine", scope: "machine" });
  store.insertRecord(home);
  store.insertRecord(machine);

  assert.equal(after.snapshots.migrationsRun, 1);
  assert.equal(store.record(home.id)?.scope, "home");
  assert.equal(store.record(machine.id)?.scope, "machine");
  const older = store.record("snolderaaaaaaaa");
  assert.deepEqual([older?.scope, older?.name, older?.pausedMs], ["device", "before the migration", 42]);
  db.close();
});
