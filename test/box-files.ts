import { join } from "node:path";
import Database from "better-sqlite3";
import { migrateFile, type DatabaseSource } from "../src/plugin/attached-files.ts";

export function storage(folder: string, refuseAttach = false): DatabaseSource & { close(): void; handle(): Database.Database } {
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

export function bbOf(source: DatabaseSource) {
  return {
    storage: {
      kv: null as never,
      database: source.database,
      migrate: (db: Database.Database, statements: string[]) => void migrateFile(db as never, "main", "_bb_migrations_test", statements),
    },
  };
}
