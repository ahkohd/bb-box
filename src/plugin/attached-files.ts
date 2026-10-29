import { createHash } from "node:crypto";
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
  readonly schema: "boxlog" | "boxhistory";
  readonly file: string;
  readonly capBytes: number;
  readonly sharedCapBytes: number;
}

export const BOX_LOG_FILE: FileSpec = { schema: "boxlog", file: "box-log.db", capBytes: 8 * MB, sharedCapBytes: 4 * MB };
export const BOX_HISTORY_FILE: FileSpec = { schema: "boxhistory", file: "box-history.db", capBytes: 64 * MB, sharedCapBytes: 30 * MB };
export const BOX_HISTORY_MIGRATIONS: readonly string[] = [];

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
  readonly shared: boolean;
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
  return { log: fileOf(BOX_LOG_FILE), history: fileOf(BOX_HISTORY_FILE), shared: false };
}

export function openBoxFiles(storage: DatabaseSource, migrations: { readonly log: readonly string[]; readonly history: readonly string[] }): BoxFiles {
  let current = storage.database();
  const folder = dirname(current.name);
  const specs = [BOX_LOG_FILE, BOX_HISTORY_FILE] as const;
  let refusal: string | null = null;
  try {
    for (const spec of specs) attach(current, spec, join(folder, spec.file));
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
    for (const spec of specs) if (attachedNames(current).has(spec.schema)) current.prepare(`DETACH DATABASE ${spec.schema}`).run();
  }
  const shared = refusal !== null;
  if (shared) {
    mainCaps.set(current, SHARED_CAP_BYTES);
    setCap(current, "main", SHARED_CAP_BYTES);
  }
  const db = (): Database => {
    const handle = storage.database();
    if (handle === current) return handle;
    current = handle;
    if (shared) {
      mainCaps.set(handle, SHARED_CAP_BYTES);
      setCap(handle, "main", SHARED_CAP_BYTES);
    } else for (const spec of specs) attach(handle, spec, join(folder, spec.file));
    return handle;
  };
  const fileOf = (spec: FileSpec, statements: readonly string[]): AttachedFile => {
    const schema = shared ? "main" : spec.schema;
    const ledger = shared ? `_${spec.schema}_migrations` : "_migrations";
    let migrationsRun: number | null = null;
    let problem: string | null = null;
    try {
      migrationsRun = migrateFile(current, schema, ledger, statements);
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    return {
      spec,
      attached: !shared,
      schema,
      path: shared ? current.name : join(folder, spec.file),
      migrationsRun,
      refusal,
      problem,
      db,
      table: (name) => `${schema}.${name}`,
      usedBytes() {
        if (shared) return null;
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
  return { log: fileOf(BOX_LOG_FILE, migrations.log), history: fileOf(BOX_HISTORY_FILE, migrations.history), shared };
}
