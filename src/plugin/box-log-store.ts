import type { DoctorCheck, SizePart } from "../backends/types.ts";
import {
  BOX_EVENT_KINDS,
  EVENT_WORDS_BYTES,
  KEPT_AFTER_THE_END_MS,
  KEPT_FOR_A_BOX_MS,
  summarize,
  utf8Prefix,
  type Actor,
  type BoxEvent,
  type BoxEventKind,
  type BoxLog,
  type BoxLogView,
  type EndedBox,
  type ObservedState,
} from "../core/box-log.ts";
import { SCHEMA, type AttachedFile } from "./attached-files.ts";

export const BOX_LOG_GAPS_KEY = "box-log/gaps";
const WHY_BYTES = 256;
const SHORT_BYTES = 128;

export const BOX_LOG_MIGRATIONS: readonly string[] = [
  `CREATE TABLE ${SCHEMA}.box_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    box TEXT NOT NULL CHECK(length(CAST(box AS BLOB)) <= ${SHORT_BYTES}),
    thread TEXT NOT NULL CHECK(length(CAST(thread AS BLOB)) <= ${SHORT_BYTES}),
    name TEXT NOT NULL CHECK(length(CAST(name AS BLOB)) <= ${SHORT_BYTES}),
    at INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN (${BOX_EVENT_KINDS.map((kind) => `'${kind}'`).join(", ")})),
    who TEXT NOT NULL CHECK(who IN ('person', 'agent', 'command', 'bb-box', 'outside', 'unknown')),
    agent TEXT CHECK(agent IS NULL OR length(CAST(agent AS BLOB)) <= ${SHORT_BYTES}),
    why TEXT CHECK(why IS NULL OR length(CAST(why AS BLOB)) <= ${WHY_BYTES}),
    words TEXT CHECK(words IS NULL OR length(CAST(words AS BLOB)) <= ${EVENT_WORDS_BYTES}),
    observed TEXT CHECK(observed IS NULL OR observed IN ('running', 'stopped', 'gone', 'unknown')),
    observed_at INTEGER,
    observed_from TEXT CHECK(observed_from IS NULL OR length(CAST(observed_from AS BLOB)) <= ${SHORT_BYTES}),
    parts TEXT CHECK(parts IS NULL OR length(CAST(parts AS BLOB)) <= ${SHORT_BYTES}),
    backend TEXT CHECK(backend IS NULL OR length(CAST(backend AS BLOB)) <= ${SHORT_BYTES}),
    state TEXT CHECK(state IS NULL OR length(CAST(state AS BLOB)) <= ${SHORT_BYTES})
  )`,
  `CREATE INDEX ${SCHEMA}.box_events_by_box ON box_events(box, kind, seq)`,
  `CREATE INDEX ${SCHEMA}.box_events_by_time ON box_events(at)`,
];

export const ATTACHED_ROW_CAP = 20_000;
export const SHARED_ROW_CAP = 1_000;
const PRUNE_AT_SHARE = 0.8;
const PRUNE_TO_SHARE = 0.6;
const CHECK_SPACE_EVERY = 64;

interface Row {
  seq: number;
  box: string;
  thread: string;
  name: string;
  at: number;
  kind: BoxEventKind;
  who: Actor["is"];
  agent: string | null;
  why: string | null;
  words: string | null;
  observed: ObservedState | null;
  observed_at: number | null;
  observed_from: string | null;
  parts: string | null;
  backend: string | null;
  state: string | null;
}

function actorOf(row: Row): Actor {
  switch (row.who) {
    case "agent":
      return { is: "agent", threadId: row.agent ?? "" };
    case "bb-box":
      return { is: "bb-box", why: row.why ?? "" };
    default:
      return { is: row.who };
  }
}

function eventOf(row: Row): BoxEvent {
  return {
    seq: row.seq,
    box: row.box,
    thread: row.thread,
    name: row.name,
    at: row.at,
    kind: row.kind,
    by: actorOf(row),
    words: row.words,
    observed: row.observed && row.observed_at !== null ? { state: row.observed, at: row.observed_at, from: row.observed_from ?? "" } : null,
    parts: row.parts ? (row.parts.split(",") as SizePart[]) : null,
    backend: row.backend,
    state: row.state,
  };
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function short(text: string | null | undefined, bytes = SHORT_BYTES): string | null {
  return text === null || text === undefined ? null : utf8Prefix(text, bytes);
}

export interface WriteFailures {
  readonly count: number;
  readonly firstAt: number;
  readonly lastAt: number;
  readonly lastError: string;
}

export interface BoxLogStoreDeps {
  readonly file: AttachedFile;
  readonly now?: () => number;
  readonly rowCap?: number;
  readonly gaps?: Readonly<Record<string, number>>;
  readonly gapsChanged?: (gaps: Readonly<Record<string, number>>) => void;
  readonly logError?: (operation: string, error: unknown) => void;
}

export class BoxLogStore implements BoxLog {
  readonly #file: AttachedFile;
  readonly #now: () => number;
  readonly #rowCap: number;
  readonly #gaps: Map<string, number>;
  readonly #gapsChanged: (gaps: Readonly<Record<string, number>>) => void;
  readonly #logError: (operation: string, error: unknown) => void;
  #failures: WriteFailures | null = null;
  #written = 0;
  #rows: number | null = null;

  constructor(deps: BoxLogStoreDeps) {
    this.#file = deps.file;
    this.#now = deps.now ?? Date.now;
    this.#rowCap = deps.rowCap ?? (deps.file.attached ? ATTACHED_ROW_CAP : SHARED_ROW_CAP);
    this.#gaps = new Map(Object.entries(deps.gaps ?? {}));
    this.#gapsChanged = deps.gapsChanged ?? (() => {});
    this.#logError = deps.logError ?? (() => {});
  }

  get file(): AttachedFile {
    return this.#file;
  }

  get failures(): WriteFailures | null {
    return this.#failures;
  }

  #table(): string {
    return this.#file.table("box_events");
  }

  record(event: BoxEvent): void {
    try {
      if (this.#file.problem) throw new Error(this.#file.problem);
      this.#insert(event);
    } catch (error) {
      this.#failed(event, error);
    }
  }

  #insert(event: BoxEvent): void {
    const db = this.#file.db();
    const by = event.by;
    const values = [
      event.box,
      event.thread,
      short(event.name),
      event.at,
      event.kind,
      by.is,
      by.is === "agent" ? short(by.threadId) : null,
      by.is === "bb-box" ? short(by.why, WHY_BYTES) : null,
      short(event.words, EVENT_WORDS_BYTES),
      event.observed?.state ?? null,
      event.observed?.at ?? null,
      short(event.observed?.from),
      event.parts?.length ? event.parts.join(",") : null,
      short(event.backend),
      short(event.state),
    ];
    const insert = () =>
      db
        .prepare(
          `INSERT INTO ${this.#table()} (box, thread, name, at, kind, who, agent, why, words, observed, observed_at, observed_from, parts, backend, state) VALUES (${values.map(() => "?").join(", ")})`,
        )
        .run(...values);
    try {
      insert();
    } catch (error) {
      if (!(error instanceof Error && /full/i.test(error.message))) throw error;
      this.#makeRoom(PRUNE_TO_SHARE / 2);
      insert();
    }
    this.#written++;
    this.#rows = this.#rows === null ? this.#count() : this.#rows + 1;
    if (this.#rows > this.#rowCap) this.#trim(this.#rows - Math.floor(this.#rowCap * PRUNE_TO_SHARE));
    if (this.#written % CHECK_SPACE_EVERY === 0) this.#keepWithinCaps();
  }

  #failed(event: BoxEvent, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const at = this.#now();
    const first = this.#failures === null;
    this.#failures = { count: (this.#failures?.count ?? 0) + 1, firstAt: this.#failures?.firstAt ?? at, lastAt: at, lastError: message };
    if (first) this.#logError("write the box log", error);
    this.#gaps.set(event.box, Math.max(event.at, at));
    this.#gapsChanged(Object.fromEntries(this.#gaps));
  }

  #count(): number {
    return (this.#file.db().prepare(`SELECT COUNT(*) AS count FROM ${this.#table()}`).get() as { count: number }).count;
  }

  #keepWithinCaps(): void {
    const used = this.#file.usedBytes();
    if (used !== null && used > this.#file.spec.capBytes * PRUNE_AT_SHARE) this.#makeRoom(PRUNE_TO_SHARE);
  }

  #makeRoom(share: number): void {
    const count = this.#count();
    const used = this.#file.usedBytes();
    const target = used ? Math.floor(count * Math.min(1, (this.#file.spec.capBytes * share) / used)) : Math.floor(count * share);
    this.#trim(Math.max(1, count - target));
  }

  #trim(rows: number): void {
    const db = this.#file.db();
    const table = this.#table();
    const superseded = db
      .prepare(`DELETE FROM ${table} WHERE seq IN (SELECT seq FROM ${table} AS e WHERE seq < (SELECT MAX(seq) FROM ${table} AS f WHERE f.box = e.box AND f.kind = e.kind) ORDER BY seq LIMIT ?)`)
      .run(rows).changes;
    if (superseded < rows) db.prepare(`DELETE FROM ${table} WHERE seq IN (SELECT seq FROM ${table} ORDER BY seq LIMIT ?)`).run(rows - superseded);
    this.#rows = this.#count();
  }

  #latestOfEach(boxId: string): Map<BoxEventKind, BoxEvent> {
    const table = this.#table();
    const rows = this.#file.db().prepare(`SELECT * FROM ${table} WHERE seq IN (SELECT MAX(seq) FROM ${table} WHERE box = ? GROUP BY kind)`).all(boxId) as Row[];
    return new Map(rows.map((row) => [row.kind, eventOf(row)]));
  }

  latestOfEach(boxId: string): Map<BoxEventKind, BoxEvent> {
    if (this.#file.problem) return new Map();
    try {
      return this.#latestOfEach(boxId);
    } catch (error) {
      this.#logError("read the box log", error);
      return new Map();
    }
  }

  latest(boxId: string, kinds: readonly BoxEventKind[]): BoxEvent | null {
    if (this.#file.problem) return null;
    try {
      const row = this.#file
        .db()
        .prepare(`SELECT * FROM ${this.#table()} WHERE box = ? AND kind IN (${kinds.map(() => "?").join(", ")}) ORDER BY seq DESC LIMIT 1`)
        .get(boxId, ...kinds) as Row | undefined;
      return row ? eventOf(row) : null;
    } catch (error) {
      this.#logError("read the box log", error);
      return null;
    }
  }

  events(boxId: string): BoxEvent[] {
    return (this.#file.db().prepare(`SELECT * FROM ${this.#table()} WHERE box = ? ORDER BY seq`).all(boxId) as Row[]).map(eventOf);
  }

  view(boxId: string): BoxLogView {
    return summarize(this.latestOfEach(boxId), this.#gaps.get(boxId) ?? null);
  }

  ended(boxId: string): EndedBox | null {
    const last = this.latest(boxId, BOX_EVENT_KINDS);
    if (!last || (last.kind !== "released" && last.kind !== "forgotten") || this.#now() - last.at > KEPT_AFTER_THE_END_MS) return null;
    if ((this.#gaps.get(boxId) ?? -Infinity) >= last.at) return null;
    return { box: last.box, thread: last.thread, name: last.name, how: last.kind, at: last.at, by: last.by.is === "unknown" ? null : last.by, backend: last.backend ?? null, state: last.state ?? null };
  }

  prune(live: ReadonlySet<string>): number {
    try {
      const db = this.#file.db();
      const table = this.#table();
      const now = this.#now();
      let removed = 0;
      db.transaction(() => {
        removed += db
          .prepare(`DELETE FROM ${table} WHERE box IN (SELECT box FROM ${table} AS e WHERE kind IN ('released', 'forgotten') AND at < ? AND seq = (SELECT MAX(seq) FROM ${table} AS f WHERE f.box = e.box))`)
          .run(now - KEPT_AFTER_THE_END_MS).changes;
        const old = db.prepare(`SELECT seq, box, kind FROM ${table} WHERE at < ?`).all(now - KEPT_FOR_A_BOX_MS) as { seq: number; box: string; kind: string }[];
        const remove = db.prepare(`DELETE FROM ${table} WHERE seq = ?`);
        const newest = db.prepare(`SELECT MAX(seq) AS seq FROM ${table} WHERE box = ? AND kind = ?`);
        for (const row of old) {
          if (live.has(row.box) && (newest.get(row.box, row.kind) as { seq: number }).seq === row.seq) continue;
          removed += remove.run(row.seq).changes;
        }
      })();
      for (const [box, at] of this.#gaps) if (!live.has(box) && now - at > KEPT_FOR_A_BOX_MS) this.#gaps.delete(box);
      this.#rows = null;
      return removed;
    } catch (error) {
      this.#logError("prune the box log", error);
      return 0;
    }
  }

  checks(): DoctorCheck[] {
    const file = this.#file;
    const where = file.attached ? `${file.spec.file}, attached to bb-box's database` : `bb-box's database, as ${file.refusal ? `its handle refused to attach ${file.spec.file}: ${file.refusal}` : "it could not attach its own file"}`;
    const failures = this.#failures;
    if (failures) {
      return [
        {
          id: "box-log",
          name: "Box log",
          status: "fail",
          detail: `bb-box could not write ${failures.count} ${failures.count === 1 ? "event" : "events"} to its box log in ${where}, from ${new Date(failures.firstAt).toISOString()} to ${new Date(failures.lastAt).toISOString()}: ${sentence(failures.lastError)} Boxes, stops, starts and releases still work, and pages say nothing the log would have said about those boxes.`,
          fix: "Check that BB's data folder has room and that bb-box's files in it are writable, then restart bb-box.",
        },
      ];
    }
    if (file.problem) {
      return [{ id: "box-log", name: "Box log", status: "fail", detail: `bb-box could not set up its box log in ${where}: ${sentence(file.problem)}`, fix: "Check that BB's data folder has room and that bb-box's files in it are writable, then restart bb-box." }];
    }
    let rows: number | null = null;
    try {
      rows = this.#count();
    } catch {
      rows = null;
    }
    const used = file.usedBytes();
    const cap = (() => {
      try {
        return file.capBytes();
      } catch {
        return null;
      }
    })();
    const capWords = cap !== null ? `${(cap / 1024 / 1024).toFixed(1)} MB` : "unknown";
    const size = used !== null ? `, ${Math.ceil(used / 1024)} KB used of its cap of ${capWords}` : `, at most ${this.#rowCap} events, in a file capped at ${capWords}`;
    return [
      {
        id: "box-log",
        name: "Box log",
        status: file.attached ? "ok" : "warn",
        detail: `Who stopped, started and released each box, and when, in ${where}: ${rows ?? "an unknown number of"} events${size}.`,
        fix: file.attached ? null : "Nothing is lost: the box log keeps fewer events in bb-box's database.",
      },
    ];
  }
}

export function historyFileChecks(file: AttachedFile): DoctorCheck[] {
  if (file.problem) return [{ id: "box-history", name: "Box history's file", status: "fail", detail: `bb-box could not set up ${file.spec.file}: ${file.problem}`, fix: "Check that BB's data folder has room and that bb-box's files in it are writable, then restart bb-box." }];
  let cap: number | null = null;
  try {
    cap = file.capBytes();
  } catch {
    cap = null;
  }
  const capWords = cap !== null ? `${(cap / 1024 / 1024).toFixed(1)} MB` : "an unknown size";
  return [
    {
      id: "box-history",
      name: "Box history's file",
      status: file.attached ? "ok" : "warn",
      detail: file.attached ? `${file.spec.file}, attached to bb-box's database, capped at ${capWords}.` : `In bb-box's database, as its handle refused to attach ${file.spec.file}${file.refusal ? `: ${file.refusal}` : ""}; the database is capped at ${capWords}.`,
      fix: null,
    },
  ];
}
