import type { DoctorCheck, Guest } from "../backends/types.ts";
import type { Actor } from "../core/box-log.ts";
import {
  BOX_GONE_HOW,
  OPERATION_KINDS,
  OPERATION_STATES,
  OPERATIONS_KEPT_MS,
  PICTURE_STATES,
  SNAPSHOT_STATES,
  type BoxGoneHow,
  type SnapshotLedger,
  type SnapshotOperation,
  type SnapshotRecord,
} from "../core/snapshot.ts";
import { SCHEMA, type AttachedFile } from "./attached-files.ts";

const listed = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");
const ACTORS = ["person", "agent", "command", "bb-box", "outside", "unknown"] as const;

export const SNAPSHOT_MIGRATIONS: readonly string[] = [
  `CREATE TABLE ${SCHEMA}.snapshots (
    id TEXT PRIMARY KEY,
    box TEXT NOT NULL,
    box_name TEXT NOT NULL,
    box_kind TEXT NOT NULL,
    box_system TEXT NOT NULL,
    box_thread TEXT NOT NULL,
    box_gone_at INTEGER,
    box_gone_how TEXT CHECK(box_gone_how IS NULL OR box_gone_how IN (${listed(BOX_GONE_HOW)})),
    backend TEXT NOT NULL,
    backend_label TEXT NOT NULL,
    host TEXT,
    storage TEXT,
    storage_type TEXT,
    guest TEXT NOT NULL CHECK(guest IN ('current', 'earlier', 'held-copy')),
    lives_on TEXT NOT NULL,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
    note TEXT CHECK(note IS NULL OR length(CAST(note AS BLOB)) <= 1024),
    taken_at INTEGER NOT NULL,
    captured_at INTEGER,
    took_ms INTEGER,
    who TEXT NOT NULL CHECK(who IN (${listed(ACTORS)})),
    agent TEXT,
    why TEXT,
    scope TEXT NOT NULL CHECK(scope IN ('box', 'device')),
    holds TEXT NOT NULL CHECK(holds IN ('disk', 'disk-and-memory')),
    excludes TEXT,
    size_bytes INTEGER,
    size_means TEXT CHECK(size_means IS NULL OR size_means IN ('own', 'whole')),
    price TEXT,
    owner TEXT NOT NULL CHECK(owner IN ('thread', 'person')),
    kept_until INTEGER,
    kept_at INTEGER,
    undo_of TEXT,
    fork_safe INTEGER,
    depends_on TEXT NOT NULL DEFAULT '[]',
    picture TEXT CHECK(picture IS NULL OR picture IN (${listed(PICTURE_STATES)})),
    ref TEXT,
    state TEXT NOT NULL CHECK(state IN (${listed(SNAPSHOT_STATES)})),
    error TEXT,
    state_at INTEGER NOT NULL,
    missing_since INTEGER,
    found_at INTEGER,
    UNIQUE(box, name)
  )`,
  `CREATE INDEX ${SCHEMA}.snapshots_by_backend ON snapshots(backend, state)`,
  `CREATE TABLE ${SCHEMA}.snapshot_operations (
    id TEXT PRIMARY KEY,
    request TEXT UNIQUE,
    kind TEXT NOT NULL CHECK(kind IN (${listed(OPERATION_KINDS)})),
    box TEXT NOT NULL,
    guest TEXT,
    snapshots TEXT NOT NULL DEFAULT '[]',
    who TEXT NOT NULL CHECK(who IN (${listed(ACTORS)})),
    agent TEXT,
    why TEXT,
    consent TEXT,
    undo TEXT,
    guests TEXT,
    step TEXT NOT NULL,
    task TEXT,
    state TEXT NOT NULL CHECK(state IN (${listed(OPERATION_STATES)})),
    reserved TEXT,
    error TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX ${SCHEMA}.snapshot_operations_by_state ON snapshot_operations(state)`,
  `ALTER TABLE ${SCHEMA}.snapshot_operations ADD COLUMN request_digest TEXT`,
  `ALTER TABLE ${SCHEMA}.snapshot_operations ADD COLUMN snapshots_gone_at INTEGER`,
];

interface SnapshotRow {
  id: string;
  box: string;
  box_name: string;
  box_kind: string;
  box_system: string;
  box_thread: string;
  box_gone_at: number | null;
  box_gone_how: BoxGoneHow | null;
  backend: string;
  backend_label: string;
  host: string | null;
  storage: string | null;
  storage_type: string | null;
  guest: SnapshotRecord["guest"];
  lives_on: string;
  name: string;
  note: string | null;
  taken_at: number;
  captured_at: number | null;
  took_ms: number | null;
  who: Actor["is"];
  agent: string | null;
  why: string | null;
  scope: SnapshotRecord["scope"];
  holds: SnapshotRecord["holds"];
  excludes: string | null;
  size_bytes: number | null;
  size_means: "own" | "whole" | null;
  price: string | null;
  owner: SnapshotRecord["owner"];
  kept_until: number | null;
  kept_at: number | null;
  undo_of: string | null;
  fork_safe: number | null;
  depends_on: string;
  picture: SnapshotRecord["picture"];
  ref: string | null;
  state: SnapshotRecord["state"];
  error: string | null;
  state_at: number;
  missing_since: number | null;
  found_at: number | null;
}

interface OperationRow {
  id: string;
  request: string | null;
  request_digest: string | null;
  kind: SnapshotOperation["kind"];
  box: string;
  guest: string | null;
  snapshots: string;
  who: Actor["is"];
  agent: string | null;
  why: string | null;
  consent: string | null;
  undo: string | null;
  guests: string | null;
  step: string;
  task: string | null;
  state: SnapshotOperation["state"];
  reserved: string | null;
  error: string | null;
  started_at: number;
  ended_at: number | null;
  updated_at: number;
  snapshots_gone_at: number | null;
}

function actorOf(who: Actor["is"], agent: string | null, why: string | null): Actor {
  switch (who) {
    case "agent":
      return { is: "agent", threadId: agent ?? "" };
    case "bb-box":
      return { is: "bb-box", why: why ?? "" };
    default:
      return { is: who };
  }
}

function actorColumns(by: Actor): { who: Actor["is"]; agent: string | null; why: string | null } {
  return { who: by.is, agent: by.is === "agent" ? by.threadId : null, why: by.is === "bb-box" ? by.why : null };
}

function parsed<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function json(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function guestToKeep(guest: Guest): Guest {
  return { ref: guest.ref, host: guest.host, address: guest.address, size: null, ...(guest.data ? { data: guest.data } : {}) };
}

function recordOf(row: SnapshotRow): SnapshotRecord {
  return {
    id: row.id,
    box: { id: row.box, name: row.box_name, kind: row.box_kind, system: row.box_system, thread: row.box_thread },
    boxGone: row.box_gone_at !== null ? { at: row.box_gone_at, how: row.box_gone_how ?? "unknown" } : null,
    backend: { id: row.backend, label: row.backend_label },
    host: row.host,
    storage: row.storage !== null ? { name: row.storage, type: row.storage_type ?? "" } : null,
    guest: row.guest,
    livesOn: parsed<Guest>(row.lives_on, { ref: "", host: row.host, address: null, size: null }),
    name: row.name,
    note: row.note,
    takenAt: row.taken_at,
    capturedAt: row.captured_at,
    tookMs: row.took_ms,
    by: actorOf(row.who, row.agent, row.why),
    scope: row.scope,
    holds: row.holds,
    excludes: row.excludes,
    size: row.size_bytes !== null && row.size_means !== null ? { bytes: row.size_bytes, means: row.size_means } : null,
    price: parsed(row.price, null),
    owner: row.owner,
    keptUntil: row.kept_until,
    keptAt: row.kept_at,
    undoOf: row.undo_of,
    forkSafe: row.fork_safe,
    dependsOn: parsed<string[]>(row.depends_on, []),
    picture: row.picture,
    ref: row.ref,
    state: row.state,
    error: row.error,
    stateAt: row.state_at,
    missingSince: row.missing_since,
    foundAt: row.found_at,
  };
}

function rowOf(record: SnapshotRecord): SnapshotRow {
  return {
    id: record.id,
    box: record.box.id,
    box_name: record.box.name,
    box_kind: record.box.kind,
    box_system: record.box.system,
    box_thread: record.box.thread,
    box_gone_at: record.boxGone?.at ?? null,
    box_gone_how: record.boxGone?.how ?? null,
    backend: record.backend.id,
    backend_label: record.backend.label,
    host: record.host,
    storage: record.storage?.name ?? null,
    storage_type: record.storage?.type ?? null,
    guest: record.guest,
    lives_on: JSON.stringify(guestToKeep(record.livesOn)),
    name: record.name,
    note: record.note,
    taken_at: record.takenAt,
    captured_at: record.capturedAt,
    took_ms: record.tookMs,
    ...actorColumns(record.by),
    scope: record.scope,
    holds: record.holds,
    excludes: record.excludes,
    size_bytes: record.size?.bytes ?? null,
    size_means: record.size?.means ?? null,
    price: json(record.price),
    owner: record.owner,
    kept_until: record.keptUntil,
    kept_at: record.keptAt,
    undo_of: record.undoOf,
    fork_safe: record.forkSafe,
    depends_on: JSON.stringify(record.dependsOn),
    picture: record.picture,
    ref: record.ref,
    state: record.state,
    error: record.error,
    state_at: record.stateAt,
    missing_since: record.missingSince,
    found_at: record.foundAt,
  };
}

function operationOf(row: OperationRow): SnapshotOperation {
  return {
    id: row.id,
    request: row.request,
    requestDigest: row.request_digest,
    kind: row.kind,
    box: row.box,
    guest: row.guest,
    snapshots: parsed<string[]>(row.snapshots, []),
    by: actorOf(row.who, row.agent, row.why),
    consent: parsed<unknown>(row.consent, null),
    undo: row.undo,
    guests: parsed(row.guests, null),
    step: row.step,
    task: parsed(row.task, null),
    state: row.state,
    reserved: parsed(row.reserved, null),
    error: row.error,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    snapshotsGoneAt: row.snapshots_gone_at,
  };
}

function operationRow(operation: SnapshotOperation, now: number): OperationRow {
  return {
    id: operation.id,
    request: operation.request,
    request_digest: operation.requestDigest,
    kind: operation.kind,
    box: operation.box,
    guest: operation.guest,
    snapshots: JSON.stringify(operation.snapshots),
    ...actorColumns(operation.by),
    consent: json(operation.consent),
    undo: operation.undo,
    guests: json(operation.guests),
    step: operation.step,
    task: json(operation.task),
    state: operation.state,
    reserved: json(operation.reserved),
    error: operation.error,
    started_at: operation.startedAt,
    ended_at: operation.endedAt,
    updated_at: now,
    snapshots_gone_at: operation.snapshotsGoneAt,
  };
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export interface SnapshotStoreDeps {
  readonly file: AttachedFile;
  readonly now?: () => number;
  readonly logError?: (operation: string, error: unknown) => void;
}

const UNSETTLED = "state IN ('running', 'unknown')";

export class SnapshotStore implements SnapshotLedger {
  readonly #file: AttachedFile;
  readonly #now: () => number;
  readonly #logError: (operation: string, error: unknown) => void;
  #failure: { readonly at: number; readonly error: string; count: number } | null = null;

  constructor(deps: SnapshotStoreDeps) {
    this.#file = deps.file;
    this.#now = deps.now ?? Date.now;
    this.#logError = deps.logError ?? (() => {});
  }

  get file(): AttachedFile {
    return this.#file;
  }

  get problem(): string | null {
    if (this.#file.problem) return `bb-box could not set up ${this.#file.spec.file}: ${sentence(this.#file.problem)}`;
    if (this.#failure) return `bb-box could not write to ${this.#file.spec.file}: ${sentence(this.#failure.error)}`;
    return null;
  }

  #table(name: "snapshots" | "snapshot_operations"): string {
    return this.#file.table(name);
  }

  #write<T>(work: () => T): T {
    try {
      const result = work();
      this.#failure = null;
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!this.#failure) this.#logError(`write ${this.#file.spec.file}`, error);
      this.#failure = { at: this.#now(), error: message, count: (this.#failure?.count ?? 0) + 1 };
      throw error;
    }
  }

  record(id: string): SnapshotRecord | null {
    if (this.#file.problem) return null;
    const row = this.#file.db().prepare(`SELECT * FROM ${this.#table("snapshots")} WHERE id = ?`).get(id) as SnapshotRow | undefined;
    return row ? recordOf(row) : null;
  }

  records(filter: { readonly box?: string; readonly backend?: string } = {}): SnapshotRecord[] {
    if (this.#file.problem) return [];
    const where: string[] = [];
    const values: string[] = [];
    if (filter.box !== undefined) {
      where.push("box = ?");
      values.push(filter.box);
    }
    if (filter.backend !== undefined) {
      where.push("backend = ?");
      values.push(filter.backend);
    }
    const rows = this.#file
      .db()
      .prepare(`SELECT * FROM ${this.#table("snapshots")}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY taken_at, id`)
      .all(...values) as SnapshotRow[];
    return rows.map(recordOf);
  }

  operation(id: string): SnapshotOperation | null {
    if (this.#file.problem) return null;
    const row = this.#file.db().prepare(`SELECT * FROM ${this.#table("snapshot_operations")} WHERE id = ?`).get(id) as OperationRow | undefined;
    return row ? operationOf(row) : null;
  }

  byRequest(request: string): SnapshotOperation | null {
    if (this.#file.problem) return null;
    const row = this.#file.db().prepare(`SELECT * FROM ${this.#table("snapshot_operations")} WHERE request = ?`).get(request) as OperationRow | undefined;
    return row ? operationOf(row) : null;
  }

  operationWithTask(task: string): SnapshotOperation | null {
    if (this.#file.problem) return null;
    const row = this.#file.db().prepare(`SELECT * FROM ${this.#table("snapshot_operations")} WHERE json_extract(task, '$.ref') = ? LIMIT 1`).get(task) as OperationRow | undefined;
    return row ? operationOf(row) : null;
  }

  unsettled(): SnapshotOperation[] {
    if (this.#file.problem) return [];
    return (this.#file.db().prepare(`SELECT * FROM ${this.#table("snapshot_operations")} WHERE ${UNSETTLED} ORDER BY started_at, id`).all() as OperationRow[]).map(operationOf);
  }

  pins(): ReadonlyMap<string, SnapshotOperation> {
    const pinned = new Map<string, SnapshotOperation>();
    for (const operation of this.unsettled()) for (const snapshot of operation.snapshots) if (!pinned.has(snapshot)) pinned.set(snapshot, operation);
    return pinned;
  }

  reservedBytes(storage: string): number {
    let bytes = 0;
    for (const operation of this.unsettled()) if (operation.reserved?.storage === storage) bytes += operation.reserved.bytes;
    return bytes;
  }

  changedSince(snapshot: string, at: number): boolean {
    const table = this.#table("snapshot_operations");
    const row = this.#file
      .db()
      .prepare(`SELECT 1 AS found FROM ${table} AS operation, json_each(operation.snapshots) AS pinned WHERE pinned.value = ? AND (operation.${UNSETTLED} OR operation.ended_at >= ?) LIMIT 1`)
      .get(snapshot, at) as { found: number } | undefined;
    return row !== undefined;
  }

  transaction<T>(work: () => T): T {
    return this.#write(() => this.#file.db().transaction(work).immediate());
  }

  insertRecord(record: SnapshotRecord): void {
    this.#write(() => {
      const row = rowOf(record);
      const columns = Object.keys(row);
      this.#file
        .db()
        .prepare(`INSERT INTO ${this.#table("snapshots")} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
        .run(...columns.map((column) => row[column as keyof SnapshotRow]));
    });
  }

  updateRecord(id: string, change: Partial<SnapshotRecord>): SnapshotRecord | null {
    return this.#write(() => {
      const current = this.record(id);
      if (!current) return null;
      const next: SnapshotRecord = { ...current, ...change, id };
      const row = rowOf(next);
      const columns = Object.keys(row).filter((column) => column !== "id");
      this.#file
        .db()
        .prepare(`UPDATE ${this.#table("snapshots")} SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`)
        .run(...columns.map((column) => row[column as keyof SnapshotRow]), id);
      return next;
    });
  }

  removeRecord(id: string): void {
    const operations = this.#table("snapshot_operations");
    const snapshots = this.#table("snapshots");
    this.#write(() => {
      const db = this.#file.db();
      db.prepare(`DELETE FROM ${snapshots} WHERE id = ?`).run(id);
      db.prepare(
        `UPDATE ${operations} SET snapshots_gone_at = ? WHERE snapshots_gone_at IS NULL AND EXISTS (SELECT 1 FROM json_each(snapshots) AS used WHERE used.value = ?) AND NOT EXISTS (SELECT 1 FROM json_each(snapshots) AS used JOIN ${snapshots} AS kept ON kept.id = used.value)`,
      ).run(this.#now(), id);
    });
  }

  insertOperation(operation: SnapshotOperation): void {
    this.#write(() => {
      const row = operationRow(operation, this.#now());
      const columns = Object.keys(row);
      this.#file
        .db()
        .prepare(`INSERT INTO ${this.#table("snapshot_operations")} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
        .run(...columns.map((column) => row[column as keyof OperationRow]));
    });
  }

  updateOperation(id: string, change: Partial<SnapshotOperation>): SnapshotOperation | null {
    return this.#write(() => {
      const current = this.operation(id);
      if (!current) return null;
      const next: SnapshotOperation = { ...current, ...change, id };
      const row = operationRow(next, this.#now());
      const columns = Object.keys(row).filter((column) => column !== "id");
      this.#file
        .db()
        .prepare(`UPDATE ${this.#table("snapshot_operations")} SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`)
        .run(...columns.map((column) => row[column as keyof OperationRow]), id);
      return next;
    });
  }

  prune(now: number): number {
    try {
      const operations = this.#table("snapshot_operations");
      const snapshots = this.#table("snapshots");
      return this.#write(
        () =>
          this.#file
            .db()
            .prepare(
              `DELETE FROM ${operations} WHERE state IN ('done', 'failed') AND ended_at < ? AND COALESCE(snapshots_gone_at, ended_at) < ? AND NOT EXISTS (SELECT 1 FROM json_each(snapshots) AS used JOIN ${snapshots} AS kept ON kept.id = used.value)`,
            )
            .run(now - OPERATIONS_KEPT_MS, now - OPERATIONS_KEPT_MS).changes,
      );
    } catch (error) {
      this.#logError("prune the snapshots' operations", error);
      return 0;
    }
  }

  checks(): DoctorCheck[] {
    const file = this.#file;
    const where = file.attached
      ? `${file.spec.file}, attached to bb-box's database`
      : file.schema !== "main"
        ? file.spec.file
        : `bb-box's database, as its handle refused to attach ${file.spec.file}${file.refusal ? `: ${file.refusal}` : ""}`;
    const fix = "Check that BB's data folder has room and that bb-box's files in it are writable, then restart bb-box. Until then bb-box takes and deletes no snapshots.";
    if (file.problem) return [{ id: "snapshots", name: "Snapshots' records", status: "fail", detail: `bb-box could not set up its snapshots' records in ${where}: ${sentence(file.problem)}`, fix }];
    if (this.#failure) {
      return [
        {
          id: "snapshots",
          name: "Snapshots' records",
          status: "fail",
          detail: `bb-box could not write its snapshots' records in ${where} ${this.#failure.count} ${this.#failure.count === 1 ? "time" : "times"}, last at ${new Date(this.#failure.at).toISOString()}: ${sentence(this.#failure.error)}`,
          fix,
        },
      ];
    }
    let counts: { state: string; count: number }[] = [];
    let unsettled = 0;
    try {
      counts = this.#file.db().prepare(`SELECT state, COUNT(*) AS count FROM ${this.#table("snapshots")} GROUP BY state ORDER BY state`).all() as { state: string; count: number }[];
      unsettled = this.unsettled().length;
    } catch (error) {
      return [{ id: "snapshots", name: "Snapshots' records", status: "fail", detail: `bb-box could not read its snapshots' records in ${where}: ${sentence(error instanceof Error ? error.message : String(error))}`, fix }];
    }
    const total = counts.reduce((sum, row) => sum + row.count, 0);
    const byState = counts.map((row) => `${row.count} ${row.state}`).join(", ");
    const used = file.usedBytes();
    const size = used !== null ? `, ${Math.ceil(used / 1024)} KB used` : "";
    return [
      {
        id: "snapshots",
        name: "Snapshots' records",
        status: file.attached ? "ok" : "warn",
        detail: `bb-box's records of snapshots and their operations, in ${where}: ${total} ${total === 1 ? "snapshot" : "snapshots"}${byState ? ` (${byState})` : ""}, ${unsettled} ${unsettled === 1 ? "operation" : "operations"} not settled${size}.`,
        fix: file.attached ? null : "Nothing is lost: the records live in bb-box's database.",
      },
    ];
  }
}
