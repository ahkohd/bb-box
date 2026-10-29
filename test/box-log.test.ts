import assert from "node:assert/strict";
import { chmodSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { BOX_HISTORY_FILE, BOX_LOG_FILE, MONITOR_CAP_BYTES, SHARED_CAP_BYTES, migrateFile, openBoxFiles, type DatabaseSource } from "../src/plugin/attached-files.ts";
import { BOX_LOG_MIGRATIONS, BoxLogStore, SHARED_ROW_CAP } from "../src/plugin/box-log-store.ts";
import { BY_COMMAND, BY_OUTSIDE, BY_PERSON, KEPT_AFTER_THE_END_MS, KEPT_FOR_A_BOX_MS, byAgent, byBbBox, type BoxEvent } from "../src/core/box-log.ts";
import { createMonitorStore } from "../src/monitor/monitor-store.ts";
import { tempDir } from "./helpers.ts";

const MB = 1024 * 1024;
const WORDS = "x".repeat(1100);

function storage(folder: string, refuseAttach = false): DatabaseSource & { close(): void; handle(): Database.Database } {
  let handle: Database.Database | null = null;
  const open = () => {
    if (!handle?.open) {
      handle = new Database(join(folder, "data.db"));
      handle.pragma("journal_mode = WAL");
      handle.pragma("busy_timeout = 5000");
    }
    return handle;
  };
  const refusing = (db: Database.Database) =>
    new Proxy(db, {
      get(target, key) {
        if (key === "prepare") return (sql: string) => (/^\s*ATTACH/i.test(sql) ? (() => { throw new Error("not authorized"); })() : target.prepare(sql));
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  let wrapped: Database.Database | null = null;
  return {
    database: () => {
      const db = open();
      if (!refuseAttach) return db as never;
      if (!wrapped || (wrapped as unknown as { open: boolean }).open === false) wrapped = refusing(db);
      return wrapped as never;
    },
    close: () => handle?.close(),
    handle: () => open(),
  };
}

function bbOf(source: DatabaseSource) {
  return {
    storage: {
      kv: null as never,
      database: source.database,
      migrate: (db: Database.Database, statements: string[]) => void migrateFile(db as never, "main", "_bb_migrations_test", statements),
    },
  };
}

function event(at: number, more: Partial<BoxEvent> = {}): BoxEvent {
  return { box: "bxone", thread: "thr_one", name: "amber-fox", at, kind: "stopped", by: BY_PERSON, ...more };
}

function opened(folder: string, refuseAttach = false) {
  const source = storage(folder, refuseAttach);
  const files = openBoxFiles(source, { log: BOX_LOG_MIGRATIONS, history: ["CREATE TABLE $schema.filler (blob BLOB NOT NULL)"] });
  return { source, files };
}

test("box-log.db and box-history.db are made beside data.db, attached to its handle, migrated once, with their own WAL and caps (069 G4)", () => {
  const folder = tempDir("box-files");
  const first = opened(folder);
  assert.equal(first.files.shared, false);
  assert.ok(existsSync(join(folder, "box-log.db")), "the box log's file is made");
  assert.ok(existsSync(join(folder, "box-history.db")), "box history's file is made");
  assert.equal(first.files.log.migrationsRun, BOX_LOG_MIGRATIONS.length);
  assert.equal(first.files.history.migrationsRun, 1);
  const db = first.source.handle();
  const pageSize = (schema: string) => Number(db.pragma(`${schema}.page_size`, { simple: true }));
  assert.equal(Number(db.pragma("boxlog.max_page_count", { simple: true })), Math.floor(BOX_LOG_FILE.capBytes / pageSize("boxlog")));
  assert.equal(Number(db.pragma("boxhistory.max_page_count", { simple: true })), Math.floor(BOX_HISTORY_FILE.capBytes / pageSize("boxhistory")));
  assert.equal(db.pragma("boxlog.journal_mode", { simple: true }), "wal");
  assert.equal(db.pragma("boxhistory.journal_mode", { simple: true }), "wal");
  assert.equal(Number(db.pragma("boxlog.journal_size_limit", { simple: true })), 4 * MB);
  assert.equal(Number(db.pragma("boxhistory.journal_size_limit", { simple: true })), 4 * MB);
  assert.deepEqual((db.prepare("SELECT name FROM main.sqlite_master WHERE name LIKE 'box_%'").all() as { name: string }[]).map((row) => row.name), [], "nothing of the log goes in data.db");
  first.source.close();

  const second = opened(folder);
  assert.equal(second.files.log.migrationsRun, 0, "a second start runs no migration again");
  assert.equal(second.files.history.migrationsRun, 0);
  second.source.close();

  const appended = openBoxFiles(storage(folder), { log: BOX_LOG_MIGRATIONS.map((statement, index) => (index === 0 ? statement.replace("seq INTEGER", "seq  INTEGER") : statement)), history: [] });
  assert.match(appended.log.problem ?? "", /boxlog migration 0 does not match the recorded statement/, "a changed statement is refused, as the SDK's are");
});

test("a full box-history.db leaves the Monitor's pressure logs and the box log writable (069 G4)", () => {
  const folder = tempDir("box-files-full");
  const { source, files } = opened(folder);
  const db = source.handle();
  db.pragma(`boxhistory.max_page_count = ${Math.ceil(256 * 1024 / Number(db.pragma("boxhistory.page_size", { simple: true })))}`);
  const fill = db.prepare("INSERT INTO boxhistory.filler (blob) VALUES (?)");
  assert.throws(() => {
    for (let i = 0; i < 1000; i++) fill.run(Buffer.alloc(4096));
  }, /full/i, "box history fills at its own cap");
  const monitor = createMonitorStore(bbOf(source) as never);
  const saved = monitor.write([{ type: "sample", timestamp: Date.now(), cpu: 10 }]);
  assert.equal(saved.length, 1, "pressure logs still write");
  assert.equal(Number(db.pragma("main.max_page_count", { simple: true })), Math.floor(MONITOR_CAP_BYTES / Number(db.pragma("main.page_size", { simple: true }))), "data.db keeps the Monitor's 10 MB cap");
  const log = new BoxLogStore({ file: files.log });
  log.record(event(1));
  assert.equal(log.failures, null, "the box log still writes");
  assert.equal(log.view("bxone").lastStop?.at, 1);
});

test("where the handle refuses ATTACH, the tables go in data.db, its cap rises to 48 MB, and the box log keeps under 4 MB (069 G4)", () => {
  const folder = tempDir("box-files-shared");
  const { source, files } = opened(folder, true);
  assert.equal(files.shared, true);
  assert.equal(files.log.attached, false);
  assert.match(files.log.refusal ?? "", /not authorized/);
  assert.ok(!existsSync(join(folder, "box-log.db")));
  assert.equal(files.log.migrationsRun, BOX_LOG_MIGRATIONS.length);
  const db = source.handle();
  const pages = (bytes: number) => Math.floor(bytes / Number(db.pragma("main.page_size", { simple: true })));
  assert.equal(Number(db.pragma("main.max_page_count", { simple: true })), pages(SHARED_CAP_BYTES));
  createMonitorStore(bbOf(source) as never);
  assert.equal(Number(db.pragma("main.max_page_count", { simple: true })), pages(SHARED_CAP_BYTES), "the Monitor's store keeps the raised cap");
  assert.equal(openBoxFiles(source, { log: BOX_LOG_MIGRATIONS, history: [] }).log.migrationsRun, 0, "its migrations run once there too");

  const log = new BoxLogStore({ file: files.log });
  const compacted = () => {
    db.exec("VACUUM");
    db.pragma("wal_checkpoint(TRUNCATE)");
    return statSync(join(folder, "data.db")).size;
  };
  const before = compacted();
  for (let i = 0; i < SHARED_ROW_CAP * 3; i++) log.record(event(i, { box: `bx${i % 40}`, words: WORDS, kind: i % 2 ? "stop-failed" : "stopped", by: byBbBox("y".repeat(300)) }));
  assert.equal(log.failures, null);
  const rows = (db.prepare("SELECT COUNT(*) AS count FROM main.box_events").get() as { count: number }).count;
  assert.ok(rows <= SHARED_ROW_CAP, `at most ${SHARED_ROW_CAP} events, not ${rows}`);
  const grown = compacted() - before;
  assert.ok(grown < 4 * MB, `the box log takes ${grown} bytes of data.db`);
});

test("10,000 events of the longest words keep box-log.db under its 8 MB cap, each event cut to 1 KB (069 G5)", () => {
  const folder = tempDir("box-log-cap");
  const { source, files } = opened(folder);
  const log = new BoxLogStore({ file: files.log });
  for (let i = 0; i < 10_000; i++) log.record(event(i, { box: `bx${i % 30}`, kind: i % 3 ? "stop-failed" : "release-failed", words: WORDS, by: byBbBox("y".repeat(400)), observed: { state: "running", at: i, from: "Proxmox LXC" } }));
  assert.equal(log.failures, null, "no write failed");
  const db = source.handle();
  const pages = Number(db.pragma("boxlog.page_count", { simple: true }));
  assert.ok(pages <= Number(db.pragma("boxlog.max_page_count", { simple: true })));
  assert.ok(statSync(join(folder, "box-log.db")).size <= BOX_LOG_FILE.capBytes, "the file stays under its cap");
  const longest = db.prepare("SELECT MAX(length(CAST(words AS BLOB))) AS words, MAX(length(CAST(why AS BLOB))) AS why FROM boxlog.box_events").get() as { words: number; why: number };
  assert.ok(longest.words <= 1024 && longest.why <= 256);
  assert.equal(log.view("bx0").lastFailed?.operation, "release", "each box keeps its latest event of each kind");
});

test("with box-log.db read-only, writes fail, the doctor says so, and the view claims nothing the log would have said (069 G5)", () => {
  const folder = tempDir("box-log-readonly");
  const first = opened(folder);
  const log = new BoxLogStore({ file: first.files.log });
  log.record(event(100, { kind: "stop-asked", by: BY_PERSON }));
  log.record(event(101, { kind: "stopped", by: BY_PERSON }));
  log.record(event(102, { kind: "released", by: BY_PERSON, box: "bxgone" }));
  first.source.handle().pragma("boxlog.wal_checkpoint(TRUNCATE)");
  first.source.close();
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(join(folder, `box-log.db${suffix}`))) chmodSync(join(folder, `box-log.db${suffix}`), 0o444);
  if (process.getuid?.() === 0) return;
  const gaps: Record<string, number>[] = [];
  const second = opened(folder);
  const readOnly = new BoxLogStore({ file: second.files.log, now: () => 300, gapsChanged: (saved) => void gaps.push({ ...saved }) });
  assert.equal(readOnly.view("bxone").lastStop?.by?.is, "person", "the log still reads");
  readOnly.record(event(200, { kind: "start-asked", by: byAgent("thr_two") }));
  readOnly.record(event(201, { kind: "started", by: byAgent("thr_two") }));
  readOnly.record(event(250, { kind: "stop-asked", by: byAgent("thr_two") }));
  readOnly.record(event(251, { kind: "stopped", by: byAgent("thr_two") }));
  assert.equal(readOnly.failures?.count, 4);
  assert.equal(readOnly.view("bxone").lastStop, null, "no \"by you\" from the stop before");
  assert.equal(readOnly.view("bxone").lastStart, null);
  assert.deepEqual(gaps.at(-1), { bxone: 300 });
  const [check] = readOnly.checks();
  assert.equal(check?.status, "fail");
  assert.match(check?.detail ?? "", /could not write 4 events/);
  const restarted = new BoxLogStore({ file: second.files.log, gaps: gaps.at(-1) });
  assert.equal(restarted.view("bxone").lastStop, null, "the gap is kept across a restart of bb-box");
  second.source.close();
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(join(folder, `box-log.db${suffix}`))) chmodSync(join(folder, `box-log.db${suffix}`), 0o644);
  rmSync(folder, { recursive: true, force: true });
});

test("the log keeps a box's last 7 days and its latest event of each kind, and a released or forgotten box for 24 hours, by a set clock (069)", () => {
  const folder = tempDir("box-log-prune");
  const { files } = opened(folder);
  let now = 0;
  const log = new BoxLogStore({ file: files.log, now: () => now });
  const hour = 60 * 60_000;
  log.record(event(0, { kind: "made", by: BY_COMMAND }));
  log.record(event(1, { kind: "ready", by: BY_COMMAND }));
  log.record(event(2, { kind: "stop-asked", by: BY_PERSON }));
  log.record(event(3, { kind: "stopped", by: BY_PERSON }));
  log.record(event(4 * hour, { kind: "stopped-unasked", by: BY_OUTSIDE }));
  log.record(event(5 * hour, { kind: "stopped", by: byAgent("thr_two") }));
  log.record(event(0, { box: "bxlost", kind: "stopped" }));
  log.record(event(0, { box: "bxgone", kind: "release-asked" }));
  log.record(event(10 * hour, { box: "bxgone", name: "maple-row", kind: "released", backend: "Proxmox LXC" }));
  log.record(event(10 * hour, { box: "bxforgot", name: "fern-hollow", kind: "forgotten", backend: "Proxmox LXC", state: "ready" }));
  const live = new Set(["bxone"]);

  now = 24 * hour;
  assert.equal(log.prune(live), 0, "nothing is due within a day");
  assert.equal(log.ended("bxgone")?.how, "released");
  assert.equal(log.ended("bxforgot")?.how, "forgotten");
  assert.equal(log.ended("bxforgot")?.name, "fern-hollow");
  assert.equal(log.ended("bxone"), null);

  now = 10 * hour + KEPT_AFTER_THE_END_MS + 1;
  log.prune(live);
  assert.equal(log.ended("bxgone"), null, "a released box is forgotten 24 hours after its release");
  assert.deepEqual(log.events("bxgone"), []);
  assert.deepEqual(log.events("bxforgot"), []);
  assert.equal(log.events("bxone").length, 6, "a box that exists keeps its last 7 days");

  now = KEPT_FOR_A_BOX_MS + 4 * hour + 1;
  log.prune(live);
  assert.deepEqual(log.events("bxone").map((each) => each.kind), ["made", "ready", "stop-asked", "stopped-unasked", "stopped"], "older than 7 days, only the latest of each kind stays");
  assert.deepEqual(log.events("bxlost"), [], "a box with no record goes after 7 days");
  assert.equal(log.view("bxone").lastStop?.by?.is, "agent");
});

test("the view gives the last start, the last stop and the last failed operation with what bb-box observed (069 G6)", () => {
  const folder = tempDir("box-log-view");
  const { files } = opened(folder);
  const log = new BoxLogStore({ file: files.log });
  log.record(event(10, { kind: "made", by: byAgent("thr_one") }));
  log.record(event(14, { kind: "ready", by: { is: "unknown" } }));
  assert.deepEqual(log.view("bxone").lastStart, { askedAt: 10, readyAt: 14, failedAt: null, by: { is: "agent", threadId: "thr_one" }, first: true });
  log.record(event(20, { kind: "stop-asked", by: BY_PERSON }));
  log.record(event(21, { kind: "stop-failed", by: BY_PERSON, words: "The provider timed out.", observed: { state: "running", at: 21, from: "Proxmox LXC" } }));
  assert.deepEqual(log.view("bxone").lastFailed, { operation: "stop", at: 21, words: "The provider timed out.", observed: { state: "running", at: 21, from: "Proxmox LXC" }, parts: [] });
  assert.equal(log.view("bxone").lastStop, null, "a failed stop makes no stop");
  log.record(event(30, { kind: "stopped", by: BY_PERSON }));
  assert.equal(log.view("bxone").lastFailed, null, "a stop that then succeeds ends the failure");
  assert.deepEqual(log.view("bxone").lastStop, { at: 30, by: { is: "person" }, asked: true });
  log.record(event(40, { kind: "start-asked", by: BY_COMMAND }));
  log.record(event(41, { kind: "start-failed", by: BY_COMMAND, words: "SSH did not answer.", observed: { state: "unknown", at: 42, from: "Proxmox QEMU" } }));
  assert.deepEqual(log.view("bxone").lastStart, { askedAt: 40, readyAt: null, failedAt: 41, by: { is: "command" }, first: false });
  assert.equal(log.view("bxone").lastFailed?.observed?.state, "unknown");
  log.record(event(50, { kind: "resize-asked", by: BY_PERSON }));
  log.record(event(51, { kind: "resize-failed", by: BY_PERSON, parts: ["memory"], words: "Cores need a restart." }));
  assert.deepEqual(log.view("bxone").lastFailed?.parts, ["memory"]);
  assert.equal(log.view("bxone").lastFailed?.operation, "resize", "the latest failure");
});
