import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { freshPressureState, isPressureState, type PressureState, type PressureEvent } from "./pressure.ts";
import { isAlertNotice } from "./alert-receiver.ts";

export const LOG_LIMIT = 4096;
export type LogEntry = { type: string; timestamp: number; [key: string]: string | number | boolean | null };
export type SavedLog = LogEntry & { sequence: number };
export type AlertNotice = PressureEvent & { sequence: number };
function parseNotice(payload: string, sequence?: number): AlertNotice[] {
  try {
    const value = JSON.parse(payload);
    const notice = sequence === undefined ? value : { ...value, sequence };
    return isAlertNotice(notice) ? [notice] : [];
  } catch { return []; }
}

export function createMonitorStore(bb: Pick<BbPluginApi, "storage">) {
  const db = bb.storage.database();
  db.pragma("cache_size = -256");
  db.pragma("busy_timeout = 100");
  db.pragma("wal_autocheckpoint = 64");
  db.pragma("journal_size_limit = 1048576");
  bb.storage.migrate(db, [
    "CREATE TABLE pressure_logs (slot INTEGER PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, type TEXT NOT NULL, payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= 1024))",
    "CREATE TABLE pressure_state (id INTEGER PRIMARY KEY CHECK(id = 1), payload TEXT NOT NULL)",
    "CREATE INDEX pressure_logs_type_sequence ON pressure_logs(type, sequence)",
    "CREATE TABLE pressure_notices (metric TEXT PRIMARY KEY, payload TEXT NOT NULL)",
  ]);
  const pageSize = Number(db.pragma("page_size", { simple: true }));
  db.pragma(`max_page_count = ${Math.floor(10 * 1024 * 1024 / pageSize)}`);
  const latestSequence = db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM pressure_logs");
  const cursor = () => (latestSequence.get() as { sequence: number }).sequence;
  const insert = db.prepare("INSERT OR REPLACE INTO pressure_logs(slot, sequence, type, payload) VALUES (?, ?, ?, ?)");
  const saveState = db.prepare("INSERT OR REPLACE INTO pressure_state(id, payload) VALUES (1, ?)");
  const saveNotice = db.prepare("INSERT OR REPLACE INTO pressure_notices(metric, payload) VALUES (?, ?)");
  const commit = db.transaction((entries: LogEntry[], state?: PressureState) => {
    const sequence = cursor();
    const saved = entries.map((entry, index) => {
      const payload = JSON.stringify(entry);
      if (Buffer.byteLength(payload) > 1024) throw new Error("A monitor log record exceeds 1 KiB");
      const next = sequence + index + 1;
      insert.run(next % LOG_LIMIT, next, entry.type, payload);
      if (entry.type === "incident" || entry.type === "recovery") saveNotice.run(entry.metric, JSON.stringify({ ...entry, sequence: next }));
      return { ...entry, sequence: next };
    });
    if (state) saveState.run(JSON.stringify(state));
    return saved;
  });
  return {
    write(entries: LogEntry[], state?: PressureState): SavedLog[] {
      return commit.immediate(entries, state);
    },
    read(limit = 100): SavedLog[] {
      const count = Math.min(500, Math.max(1, Math.floor(limit)));
      return (db.prepare("SELECT sequence, payload FROM pressure_logs ORDER BY sequence DESC LIMIT ?").all(count) as Array<{ sequence: number; payload: string }>).reverse().flatMap((row) => {
        try {
          const entry = JSON.parse(row.payload);
          if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.type !== "string" || typeof entry.timestamp !== "number" || !Number.isFinite(new Date(entry.timestamp).getTime())) return [];
          if (!Object.values(entry).every((value) => value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))) return [];
          return [{ ...entry, sequence: row.sequence }];
        } catch { return []; }
      });
    },
    alerts(): AlertNotice[] {
      return (db.prepare("SELECT sequence, payload FROM pressure_logs WHERE type IN ('incident','recovery') AND sequence > COALESCE((SELECT MAX(sequence) FROM pressure_logs WHERE type = 'monitor_disabled'), 0) ORDER BY sequence DESC LIMIT 32").all() as Array<{ sequence: number; payload: string }>).reverse().flatMap((row) => parseNotice(row.payload, row.sequence));
    },
    currentNotices(): AlertNotice[] {
      return (db.prepare("SELECT payload FROM pressure_notices WHERE metric IN ('cpu', 'memory') LIMIT 2").all() as Array<{ payload: string }>).flatMap((row) => parseNotice(row.payload));
    },
    state(): PressureState {
      const row = db.prepare("SELECT payload FROM pressure_state WHERE id = 1").get() as { payload: string } | undefined;
      try { const value: unknown = JSON.parse(row?.payload ?? "null"); return isPressureState(value) ? value : freshPressureState(); }
      catch { return freshPressureState(); }
    },
    cursor,
  };
}
