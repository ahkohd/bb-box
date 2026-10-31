import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export type Database = ReturnType<BbPluginApi["storage"]["database"]>;
export type DatabaseSource = Pick<BbPluginApi["storage"], "database">;

const MB = 1024 * 1024;
export const MONITOR_CAP_BYTES = 10 * MB;
export const SHARED_CAP_BYTES = 48 * MB;
export const WAL_LIMIT_BYTES = 4 * MB;
export const SCHEMA = "$schema";

export interface FileSpec {
  readonly schema: "boxlog" | "boxhistory" | "boxsnapshots";
  readonly file: string;
  readonly capBytes: number;
  readonly sharedCapBytes: number;
}

export const BOX_LOG_FILE: FileSpec = { schema: "boxlog", file: "box-log.db", capBytes: 8 * MB, sharedCapBytes: 4 * MB };
export const BOX_HISTORY_FILE: FileSpec = { schema: "boxhistory", file: "box-history.db", capBytes: 64 * MB, sharedCapBytes: 30 * MB };
export const SNAPSHOTS_FILE: FileSpec = { schema: "boxsnapshots", file: "snapshots.db", capBytes: 64 * MB, sharedCapBytes: 8 * MB };

export interface AttachedFile {
  readonly spec: FileSpec;
  readonly attached: boolean;
  readonly schema: string;
  readonly path: string;
  readonly migrationsRun: number | null;
  readonly refusal: string | null;
  readonly problem: string | null;
  db(): Database;
  table(name: string): string;
  usedBytes(): number | null;
  capBytes(): number | null;
}

const mainCaps = new WeakMap<Database, number>();

export function mainCapBytes(db: Database): number {
  return mainCaps.get(db) ?? MONITOR_CAP_BYTES;
}

function setCap(db: Database, schema: string, bytes: number): void {
  const pageSize = Number(db.pragma(`${schema}.page_size`, { simple: true }));
  db.pragma(`${schema}.max_page_count = ${Math.floor(bytes / pageSize)}`);
}

function hashOf(statement: string): string {
  return createHash("sha256").update(statement).digest("hex");
}

export function migrateFile(db: Database, schema: string, ledger: string, statements: readonly string[]): number {
  db.exec(`CREATE TABLE IF NOT EXISTS ${schema}.${ledger} (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, statement_hash TEXT NOT NULL)`);
  const applied = new Map((db.prepare(`SELECT id, statement_hash FROM ${schema}.${ledger} ORDER BY id`).all() as { id: number; statement_hash: string }[]).map((row) => [row.id, row.statement_hash]));
  const hashes = statements.map(hashOf);
  hashes.forEach((hash, index) => {
    const recorded = applied.get(index);
    if (recorded !== undefined && recorded !== hash) throw new Error(`${schema} migration ${index} does not match the recorded statement; append a new migration instead of changing or reusing an index`);
  });
  const record = db.prepare(`INSERT INTO ${schema}.${ledger} (id, applied_at, statement_hash) VALUES (?, ?, ?)`);
  let ran = 0;
  db.transaction(() => {
    statements.forEach((statement, index) => {
      if (applied.has(index)) return;
      db.exec(statement.replaceAll(SCHEMA, schema));
      record.run(index, Date.now(), hashes[index]);
      ran++;
    });
  })();
  return ran;
}

function attachedNames(db: Database): Set<string> {
  return new Set((db.prepare("PRAGMA database_list").all() as { name: string }[]).map((row) => row.name));
}

function attach(db: Database, spec: FileSpec, path: string): void {
  if (!attachedNames(db).has(spec.schema)) db.prepare(`ATTACH DATABASE ? AS ${spec.schema}`).run(path);
  db.pragma(`${spec.schema}.journal_mode = WAL`);
  db.pragma(`${spec.schema}.journal_size_limit = ${WAL_LIMIT_BYTES}`);
  setCap(db, spec.schema, spec.capBytes);
}

export interface BoxFiles {
  readonly log: AttachedFile;
  readonly history: AttachedFile;
  readonly snapshots: AttachedFile;
  readonly shared: boolean;
  readonly snapshotsMoved: number;
}

export const SNAPSHOT_TABLES = ["snapshots", "snapshot_operations", "snapshot_charges", "snapshot_pictures"] as const;

export interface FileMigrations {
  readonly log: readonly string[];
  readonly history: readonly string[];
  readonly snapshots?: readonly string[];
}

export function unopenedFiles(error: unknown): BoxFiles {
  const problem = error instanceof Error ? error.message : String(error);
  const fileOf = (spec: FileSpec): AttachedFile => ({
    spec,
    attached: false,
    schema: "main",
    path: spec.file,
    migrationsRun: null,
    refusal: null,
    problem,
    db() {
      throw new Error(problem);
    },
    table: (name) => `main.${name}`,
    usedBytes: () => null,
    capBytes: () => null,
  });
  return { log: fileOf(BOX_LOG_FILE), history: fileOf(BOX_HISTORY_FILE), snapshots: fileOf(SNAPSHOTS_FILE), shared: false, snapshotsMoved: 0 };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function existingFile(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

function detach(db: Database, spec: FileSpec): void {
  if (attachedNames(db).has(spec.schema)) db.prepare(`DETACH DATABASE ${spec.schema}`).run();
}

function columnsOf(db: Database, schema: string, table: string): string[] {
  return (db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string }[]).map((row) => row.name);
}

export function moveFromMain(db: Database, spec: FileSpec, tables: readonly string[]): number {
  const present = new Set((db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name));
  const found = tables.filter((table) => present.has(table));
  if (!found.length) return 0;
  let moved = 0;
  db.transaction(() => {
    for (const table of found) {
      const into = new Set(columnsOf(db, spec.schema, table));
      const columns = columnsOf(db, "main", table).filter((column) => into.has(column));
      moved += db.prepare(`INSERT OR IGNORE INTO ${spec.schema}.${table} (${columns.join(", ")}) SELECT ${columns.join(", ")} FROM main.${table}`).run().changes;
      db.exec(`DROP TABLE main.${table}`);
    }
    db.exec(`DROP TABLE IF EXISTS main._${spec.schema}_migrations`);
  })();
  return moved;
}

export function openBoxFiles(storage: DatabaseSource, migrations: FileMigrations): BoxFiles {
  let current = storage.database();
  const folder = dirname(current.name);
  const specs = [BOX_LOG_FILE, BOX_HISTORY_FILE] as const;
  let refusal: string | null = null;
  try {
    for (const spec of specs) attach(current, spec, join(folder, spec.file));
  } catch (error) {
    refusal = message(error);
    for (const spec of specs) detach(current, spec);
  }
  const shared = refusal !== null;
  const snapshotsPath = join(folder, SNAPSHOTS_FILE.file);
  let snapshots: { readonly is: "attached" } | { readonly is: "shared"; readonly refusal: string } | { readonly is: "closed"; readonly problem: string };
  try {
    attach(current, SNAPSHOTS_FILE, snapshotsPath);
    snapshots = { is: "attached" };
  } catch (error) {
    detach(current, SNAPSHOTS_FILE);
    snapshots = existingFile(snapshotsPath)
      ? { is: "closed", problem: `its existing ${SNAPSHOTS_FILE.file} cannot be opened: ${message(error).replace(/\.$/, "")}` }
      : { is: "shared", refusal: message(error) };
  }
  const mainShared = shared || snapshots.is === "shared";
  if (mainShared) {
    mainCaps.set(current, SHARED_CAP_BYTES);
    setCap(current, "main", SHARED_CAP_BYTES);
  }
  const db = (): Database => {
    const handle = storage.database();
    if (handle === current) return handle;
    current = handle;
    if (mainShared) {
      mainCaps.set(handle, SHARED_CAP_BYTES);
      setCap(handle, "main", SHARED_CAP_BYTES);
    }
    if (!shared) for (const spec of specs) attach(handle, spec, join(folder, spec.file));
    if (snapshots.is === "attached") attach(handle, SNAPSHOTS_FILE, snapshotsPath);
    return handle;
  };
  const fileOf = (spec: FileSpec, statements: readonly string[], inMain: boolean, refused: string | null): AttachedFile => {
    const schema = inMain ? "main" : spec.schema;
    const ledger = inMain ? `_${spec.schema}_migrations` : "_migrations";
    let migrationsRun: number | null = null;
    let problem: string | null = null;
    try {
      migrationsRun = migrateFile(current, schema, ledger, statements);
    } catch (error) {
      problem = message(error);
    }
    return {
      spec,
      attached: !inMain,
      schema,
      path: inMain ? current.name : join(folder, spec.file),
      migrationsRun,
      refusal: refused,
      problem,
      db,
      table: (name) => `${schema}.${name}`,
      usedBytes() {
        if (inMain) return null;
        const handle = db();
        const pages = Number(handle.pragma(`${schema}.page_count`, { simple: true })) - Number(handle.pragma(`${schema}.freelist_count`, { simple: true }));
        return pages * Number(handle.pragma(`${schema}.page_size`, { simple: true }));
      },
      capBytes() {
        const handle = db();
        return Number(handle.pragma(`${schema}.max_page_count`, { simple: true })) * Number(handle.pragma(`${schema}.page_size`, { simple: true }));
      },
    };
  };
  const closed = (problem: string): AttachedFile => ({
    spec: SNAPSHOTS_FILE,
    attached: false,
    schema: SNAPSHOTS_FILE.schema,
    path: snapshotsPath,
    migrationsRun: null,
    refusal: null,
    problem,
    db() {
      throw new Error(problem);
    },
    table: (name) => `${SNAPSHOTS_FILE.schema}.${name}`,
    usedBytes: () => null,
    capBytes: () => null,
  });
  const snapshotsFile =
    snapshots.is === "closed"
      ? closed(snapshots.problem)
      : fileOf(SNAPSHOTS_FILE, migrations.snapshots ?? [], snapshots.is === "shared", snapshots.is === "shared" ? snapshots.refusal : null);
  let snapshotsMoved = 0;
  if (snapshots.is === "attached" && !snapshotsFile.problem) snapshotsMoved = moveFromMain(current, SNAPSHOTS_FILE, SNAPSHOT_TABLES);
  return { log: fileOf(BOX_LOG_FILE, migrations.log, shared, refusal), history: fileOf(BOX_HISTORY_FILE, migrations.history, shared, refusal), snapshots: snapshotsFile, shared, snapshotsMoved };
}
