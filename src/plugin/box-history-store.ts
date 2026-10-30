import type { DoctorCheck } from "../backends/types.ts";
import type { QuietWhy, Tally } from "../monitor/box-history.ts";
import { lightReadingSchema, type Kept, type Point } from "../monitor/light.ts";
import { SCHEMA, type AttachedFile } from "./attached-files.ts";

export const MINUTES_KEPT_MS = 24 * 60 * 60_000;
export const HOURS_KEPT_MS = 7 * 24 * 60 * 60_000;
export const SHARED_MINUTE_ROWS = 200_000;
const COUNTERS_BYTES = 4096;
const REFILLED_WITHIN_MS = 5 * 60_000;
const KEY_BYTES = 128;

export const BOX_HISTORY_MIGRATIONS: readonly string[] = [
  `CREATE TABLE ${SCHEMA}.series (n INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE CHECK(length(CAST(key AS BLOB)) <= ${KEY_BYTES}))`,
  `CREATE TABLE ${SCHEMA}.minutes (
    n INTEGER NOT NULL,
    at INTEGER NOT NULL,
    covered INTEGER NOT NULL,
    cpu INTEGER,
    memory INTEGER,
    disk INTEGER,
    down INTEGER,
    up INTEGER,
    load INTEGER,
    cores INTEGER,
    cpu_stall INTEGER,
    memory_stall INTEGER,
    high INTEGER NOT NULL,
    PRIMARY KEY (n, at)
  ) WITHOUT ROWID`,
  `CREATE INDEX ${SCHEMA}.minutes_by_time ON minutes(at)`,
  `CREATE TABLE ${SCHEMA}.hours (
    n INTEGER NOT NULL,
    hour INTEGER NOT NULL,
    covered INTEGER NOT NULL DEFAULT 0,
    cpu_sum INTEGER NOT NULL DEFAULT 0,
    cpu_covered INTEGER NOT NULL DEFAULT 0,
    cpu_busiest INTEGER,
    memory_sum INTEGER NOT NULL DEFAULT 0,
    memory_covered INTEGER NOT NULL DEFAULT 0,
    memory_highest INTEGER,
    disk_sum INTEGER NOT NULL DEFAULT 0,
    disk_covered INTEGER NOT NULL DEFAULT 0,
    down_sum INTEGER NOT NULL DEFAULT 0,
    up_sum INTEGER NOT NULL DEFAULT 0,
    net_covered INTEGER NOT NULL DEFAULT 0,
    high INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (n, hour)
  ) WITHOUT ROWID`,
  `CREATE INDEX ${SCHEMA}.hours_by_time ON hours(hour)`,
  `CREATE TABLE ${SCHEMA}.counters (key TEXT PRIMARY KEY CHECK(length(CAST(key AS BLOB)) <= ${KEY_BYTES}), at INTEGER NOT NULL, reading TEXT NOT NULL CHECK(length(CAST(reading AS BLOB)) <= ${COUNTERS_BYTES}))`,
  `CREATE TABLE ${SCHEMA}.quiet (seq INTEGER PRIMARY KEY AUTOINCREMENT, why TEXT NOT NULL CHECK(why IN ('monitor', 'history')), from_at INTEGER NOT NULL, to_at INTEGER)`,
  `CREATE TABLE ${SCHEMA}.tallies (
    hour INTEGER PRIMARY KEY,
    due INTEGER NOT NULL DEFAULT 0,
    taken INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    unanswered INTEGER NOT NULL DEFAULT 0,
    reading_ms INTEGER NOT NULL DEFAULT 0,
    slowest_ms INTEGER NOT NULL DEFAULT 0,
    workers INTEGER NOT NULL DEFAULT 0
  )`,
];

export interface Quiet {
  readonly why: QuietWhy;
  readonly from: number;
  readonly to: number | null;
}

export interface MinuteRow {
  readonly at: number;
  readonly covered: number;
  readonly cpu: number | null;
  readonly memory: number | null;
  readonly disk: number | null;
  readonly down: number | null;
  readonly up: number | null;
  readonly load: number | null;
  readonly cores: number | null;
  readonly cpuStall: number | null;
  readonly memoryStall: number | null;
  readonly high: number;
}

export interface HourRow {
  readonly hour: number;
  readonly covered: number;
  readonly cpu: number | null;
  readonly cpuBusiest: number | null;
  readonly memory: number | null;
  readonly memoryHighest: number | null;
  readonly disk: number | null;
  readonly down: number | null;
  readonly up: number | null;
  readonly high: number;
}

export interface HistoryFull {
  readonly since: number;
  readonly error: string;
}

const seconds = (ms: number) => Math.round(ms / 1000);
const tenths = (value: number | null) => (value === null || !Number.isFinite(value) ? null : Math.round(value * 10));
const whole = (value: number | null) => (value === null || !Number.isFinite(value) ? null : Math.round(value));
const hundredths = (value: number | null) => (value === null || !Number.isFinite(value) ? null : Math.round(value * 100));
const fromTenths = (value: number | null) => (value === null ? null : value / 10);

export function hourParts(start: number, end: number): { readonly hour: number; readonly seconds: number }[] {
  const parts: { hour: number; seconds: number }[] = [];
  for (let hour = Math.floor(start / 3600) * 3600; hour < end; hour += 3600) {
    const seconds = Math.min(end, hour + 3600) - Math.max(start, hour);
    if (seconds > 0) parts.push({ hour, seconds });
  }
  return parts;
}

function isFull(error: unknown): boolean {
  return error instanceof Error && /full|SQLITE_FULL/i.test(`${error.message} ${(error as { code?: string }).code ?? ""}`);
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export interface BoxHistoryStoreDeps {
  readonly file: AttachedFile;
  readonly now?: () => number;
  readonly sharedMinuteRows?: number;
  readonly logError?: (operation: string, error: unknown) => void;
}

export class BoxHistoryStore {
  readonly #file: AttachedFile;
  readonly #now: () => number;
  readonly #sharedMinuteRows: number;
  readonly #logError: (operation: string, error: unknown) => void;
  readonly #series = new Map<string, number>();
  #full: HistoryFull | null = null;
  #cleared: { at: number; since: number } | null = null;
  readonly #logged = new Set<string>();
  #failed: { at: number; error: string } | null = null;
  #minuteRows: number | null = null;

  constructor(deps: BoxHistoryStoreDeps) {
    this.#file = deps.file;
    this.#now = deps.now ?? Date.now;
    this.#sharedMinuteRows = deps.sharedMinuteRows ?? SHARED_MINUTE_ROWS;
    this.#logError = deps.logError ?? (() => {});
  }

  get file(): AttachedFile {
    return this.#file;
  }

  get full(): HistoryFull | null {
    return this.#full;
  }

  get usable(): boolean {
    return this.#file.problem === null;
  }

  #table(name: string): string {
    return this.#file.table(name);
  }

  #seriesOf(key: string, make: boolean): number | null {
    const known = this.#series.get(key);
    if (known !== undefined) return known;
    const db = this.#file.db();
    const row = db.prepare(`SELECT n FROM ${this.#table("series")} WHERE key = ?`).get(key) as { n: number } | undefined;
    if (row) {
      this.#series.set(key, row.n);
      return row.n;
    }
    if (!make) return null;
    const n = Number(db.prepare(`INSERT INTO ${this.#table("series")} (key) VALUES (?)`).run(key).lastInsertRowid);
    this.#series.set(key, n);
    return n;
  }

  #write(operation: string, work: () => void): boolean {
    if (!this.usable || this.#full) return false;
    try {
      this.#file.db().transaction(work)();
      this.#failed = null;
      return true;
    } catch (error) {
      this.#series.clear();
      if (isFull(error)) {
        this.#fill(error instanceof Error ? error.message : String(error));
      } else {
        if (!this.#failed) this.#logError(operation, error);
        this.#failed = { at: this.#now(), error: error instanceof Error ? error.message : String(error) };
      }
      return false;
    }
  }

  #underRowCap(): boolean {
    if (this.#file.attached) return true;
    this.#minuteRows ??= (this.#file.db().prepare(`SELECT COUNT(*) AS count FROM ${this.#table("minutes")}`).get() as { count: number }).count;
    if (this.#minuteRows < this.#sharedMinuteRows) return true;
    this.#fill(`box history keeps at most ${this.#sharedMinuteRows} minute points in bb-box's database`);
    return false;
  }

  #keepCounters(key: string, kept: Kept): void {
    const reading = JSON.stringify({ ...kept.reading, own: null });
    this.#file.db().prepare(`INSERT INTO ${this.#table("counters")} (key, at, reading) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at, reading = excluded.reading`).run(key, kept.at, reading);
  }

  record(key: string, point: Point, kept: Kept): boolean {
    if (!this.usable || this.#full || !this.#underRowCap()) return false;
    const written = this.#write("write box history", () => {
      const db = this.#file.db();
      const n = this.#seriesOf(key, true)!;
      const at = seconds(point.end);
      const covered = Math.max(1, seconds(point.end - point.start));
      const cpu = tenths(point.cpu);
      const memory = tenths(point.memory);
      const disk = tenths(point.disk);
      const down = whole(point.down);
      const up = whole(point.up);
      const inserted = db
        .prepare(
          `INSERT INTO ${this.#table("minutes")} (n, at, covered, cpu, memory, disk, down, up, load, cores, cpu_stall, memory_stall, high) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(n, at) DO NOTHING`,
        )
        .run(n, at, covered, cpu, memory, disk, down, up, hundredths(point.load), point.cores, tenths(point.cpuStall), tenths(point.memoryStall), point.high).changes;
      const net = down !== null && up !== null;
      const add = db.prepare(
        `INSERT INTO ${this.#table("hours")} (n, hour, covered, cpu_sum, cpu_covered, cpu_busiest, memory_sum, memory_covered, memory_highest, disk_sum, disk_covered, down_sum, up_sum, net_covered, high)
         VALUES (@n, @hour, @covered, @cpuSum, @cpuCovered, @cpu, @memorySum, @memoryCovered, @memory, @diskSum, @diskCovered, @downSum, @upSum, @netCovered, @high)
         ON CONFLICT(n, hour) DO UPDATE SET
           covered = covered + excluded.covered,
           cpu_sum = cpu_sum + excluded.cpu_sum,
           cpu_covered = cpu_covered + excluded.cpu_covered,
           cpu_busiest = CASE WHEN excluded.cpu_busiest IS NULL THEN cpu_busiest WHEN cpu_busiest IS NULL THEN excluded.cpu_busiest ELSE MAX(cpu_busiest, excluded.cpu_busiest) END,
           memory_sum = memory_sum + excluded.memory_sum,
           memory_covered = memory_covered + excluded.memory_covered,
           memory_highest = CASE WHEN excluded.memory_highest IS NULL THEN memory_highest WHEN memory_highest IS NULL THEN excluded.memory_highest ELSE MAX(memory_highest, excluded.memory_highest) END,
           disk_sum = disk_sum + excluded.disk_sum,
           disk_covered = disk_covered + excluded.disk_covered,
           down_sum = down_sum + excluded.down_sum,
           up_sum = up_sum + excluded.up_sum,
           net_covered = net_covered + excluded.net_covered,
           high = high | excluded.high`,
      );
      for (const part of inserted ? hourParts(at - covered, at) : []) {
        add.run({
          n,
          hour: part.hour,
          covered: part.seconds,
          cpuSum: cpu === null ? 0 : cpu * part.seconds,
          cpuCovered: cpu === null ? 0 : part.seconds,
          cpu,
          memorySum: memory === null ? 0 : memory * part.seconds,
          memoryCovered: memory === null ? 0 : part.seconds,
          memory,
          diskSum: disk === null ? 0 : disk * part.seconds,
          diskCovered: disk === null ? 0 : part.seconds,
          downSum: net ? down * part.seconds : 0,
          upSum: net ? up * part.seconds : 0,
          netCovered: net ? part.seconds : 0,
          high: point.high,
        });
      }
      this.#keepCounters(key, kept);
    });
    if (written && this.#minuteRows !== null) this.#minuteRows++;
    return written;
  }

  keep(key: string, kept: Kept): boolean {
    return this.#write("keep box history's counters", () => this.#keepCounters(key, kept));
  }

  counters(): Map<string, Kept> {
    const kept = new Map<string, Kept>();
    if (!this.usable) return kept;
    try {
      for (const row of this.#file.db().prepare(`SELECT key, at, reading FROM ${this.#table("counters")}`).all() as { key: string; at: number; reading: string }[]) {
        const parsed = lightReadingSchema.safeParse(JSON.parse(row.reading));
        if (parsed.success) kept.set(row.key, { at: row.at, reading: parsed.data });
      }
    } catch (error) {
      this.#logError("read box history's counters", error);
    }
    return kept;
  }

  quiet(from: number, to: number): Quiet[] {
    if (!this.usable) return [];
    try {
      return (this.#file.db().prepare(`SELECT why, from_at, to_at FROM ${this.#table("quiet")} WHERE from_at < ? AND (to_at IS NULL OR to_at > ?) ORDER BY from_at`).all(to, from) as { why: QuietWhy; from_at: number; to_at: number | null }[]).map((row) => ({ why: row.why, from: row.from_at, to: row.to_at }));
    } catch (error) {
      this.#logError("read box history's quiet times", error);
      return [];
    }
  }

  openQuiet(): Set<QuietWhy> {
    if (!this.usable) return new Set();
    try {
      return new Set((this.#file.db().prepare(`SELECT why FROM ${this.#table("quiet")} WHERE to_at IS NULL`).all() as { why: QuietWhy }[]).map((row) => row.why));
    } catch {
      return new Set();
    }
  }

  setQuiet(why: QuietWhy, quiet: boolean, at: number): void {
    if (!this.usable || this.#full) return;
    try {
      const db = this.#file.db();
      const open = db.prepare(`SELECT seq FROM ${this.#table("quiet")} WHERE why = ? AND to_at IS NULL`).get(why) as { seq: number } | undefined;
      if (quiet && !open) db.prepare(`INSERT INTO ${this.#table("quiet")} (why, from_at, to_at) VALUES (?, ?, NULL)`).run(why, at);
      if (!quiet && open) db.prepare(`UPDATE ${this.#table("quiet")} SET to_at = ? WHERE seq = ?`).run(at, open.seq);
    } catch (error) {
      this.#once("keep when box history was off", error);
    }
  }

  tally(hourAt: number, add: Tally): void {
    if (!this.usable || this.#full) return;
    try {
      this.#file
        .db()
        .prepare(
          `INSERT INTO ${this.#table("tallies")} (hour, due, taken, skipped, failed, unanswered, reading_ms, slowest_ms, workers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(hour) DO UPDATE SET due = due + excluded.due, taken = taken + excluded.taken, skipped = skipped + excluded.skipped, failed = failed + excluded.failed, unanswered = unanswered + excluded.unanswered, reading_ms = reading_ms + excluded.reading_ms, slowest_ms = MAX(slowest_ms, excluded.slowest_ms), workers = MAX(workers, excluded.workers)`,
        )
        .run(Math.floor(hourAt / 3_600_000) * 3600, add.due, add.taken, add.skipped, add.failed, add.unanswered, Math.round(add.readingMs), Math.round(add.slowestMs), add.workers);
    } catch (error) {
      this.#once("keep box history's tallies", error);
    }
  }

  tallies(from: number, to: number): (Tally & { readonly hour: number })[] {
    if (!this.usable) return [];
    try {
      return (this.#file.db().prepare(`SELECT * FROM ${this.#table("tallies")} WHERE hour >= ? AND hour < ? ORDER BY hour`).all(seconds(from), seconds(to)) as Record<string, number>[]).map((row) => ({
        hour: row.hour! * 1000,
        due: row.due!,
        taken: row.taken!,
        skipped: row.skipped!,
        failed: row.failed!,
        unanswered: row.unanswered!,
        readingMs: row.reading_ms!,
        slowestMs: row.slowest_ms!,
        workers: row.workers!,
      }));
    } catch {
      return [];
    }
  }

  minutes(key: string, from: number, to: number): MinuteRow[] {
    if (!this.usable) return [];
    try {
      const n = this.#seriesOf(key, false);
      if (n === null) return [];
      return (this.#file.db().prepare(`SELECT * FROM ${this.#table("minutes")} WHERE n = ? AND at > ? AND at <= ? ORDER BY at`).all(n, seconds(from), seconds(to)) as Record<string, number | null>[]).map((row) => ({
        at: row.at! * 1000,
        covered: row.covered!,
        cpu: fromTenths(row.cpu ?? null),
        memory: fromTenths(row.memory ?? null),
        disk: fromTenths(row.disk ?? null),
        down: row.down ?? null,
        up: row.up ?? null,
        load: row.load === null || row.load === undefined ? null : row.load / 100,
        cores: row.cores ?? null,
        cpuStall: fromTenths(row.cpu_stall ?? null),
        memoryStall: fromTenths(row.memory_stall ?? null),
        high: row.high ?? 0,
      }));
    } catch (error) {
      this.#logError("read box history", error);
      return [];
    }
  }

  hours(key: string, from: number, to: number): HourRow[] {
    if (!this.usable) return [];
    try {
      const n = this.#seriesOf(key, false);
      if (n === null) return [];
      return (this.#file.db().prepare(`SELECT * FROM ${this.#table("hours")} WHERE n = ? AND hour >= ? AND hour < ? ORDER BY hour`).all(n, Math.floor(seconds(from) / 3600) * 3600, seconds(to)) as Record<string, number | null>[]).map((row) => {
        const mean = (sum: number | null | undefined, covered: number | null | undefined) => (covered ? sum! / covered / 10 : null);
        return {
          hour: row.hour! * 1000,
          covered: row.covered!,
          cpu: mean(row.cpu_sum, row.cpu_covered),
          cpuBusiest: fromTenths(row.cpu_busiest ?? null),
          memory: mean(row.memory_sum, row.memory_covered),
          memoryHighest: fromTenths(row.memory_highest ?? null),
          disk: mean(row.disk_sum, row.disk_covered),
          down: row.net_covered ? row.down_sum! / row.net_covered : null,
          up: row.net_covered ? row.up_sum! / row.net_covered : null,
          high: row.high ?? 0,
        };
      });
    } catch (error) {
      this.#logError("read box history", error);
      return [];
    }
  }

  keptSince(): number | null {
    if (!this.usable) return null;
    try {
      const ledger = this.#file.attached ? this.#table("_migrations") : `main._${this.#file.spec.schema}_migrations`;
      const row = this.#file.db().prepare(`SELECT MIN(applied_at) AS at FROM ${ledger}`).get() as { at: number | null };
      return row.at;
    } catch {
      return null;
    }
  }

  newest(key: string): number | null {
    if (!this.usable) return null;
    try {
      const n = this.#seriesOf(key, false);
      if (n === null) return null;
      const row = this.#file.db().prepare(`SELECT MAX(at) AS at FROM ${this.#table("minutes")} WHERE n = ?`).get(n) as { at: number | null };
      return row.at === null ? null : row.at * 1000;
    } catch {
      return null;
    }
  }

  keys(): string[] {
    if (!this.usable) return [];
    try {
      return (this.#file.db().prepare(`SELECT key FROM ${this.#table("series")} UNION SELECT key FROM ${this.#table("counters")}`).all() as { key: string }[]).map((row) => row.key);
    } catch {
      return [];
    }
  }

  prune(keep: (key: string) => boolean): number {
    if (!this.usable) return 0;
    const now = this.#now();
    try {
      const db = this.#file.db();
      let removed = 0;
      db.transaction(() => {
        removed += db.prepare(`DELETE FROM ${this.#table("minutes")} WHERE at <= ?`).run(seconds(now - MINUTES_KEPT_MS)).changes;
        removed += db.prepare(`DELETE FROM ${this.#table("hours")} WHERE hour < ?`).run(Math.floor(seconds(now - HOURS_KEPT_MS) / 3600) * 3600).changes;
        removed += db.prepare(`DELETE FROM ${this.#table("quiet")} WHERE to_at IS NOT NULL AND to_at < ?`).run(now - HOURS_KEPT_MS).changes;
        removed += db.prepare(`DELETE FROM ${this.#table("tallies")} WHERE hour < ?`).run(seconds(now - HOURS_KEPT_MS)).changes;
        const series = db.prepare(`SELECT n, key FROM ${this.#table("series")}`).all() as { n: number; key: string }[];
        for (const { n, key } of series) {
          if (keep(key)) continue;
          removed += db.prepare(`DELETE FROM ${this.#table("minutes")} WHERE n = ?`).run(n).changes;
          removed += db.prepare(`DELETE FROM ${this.#table("hours")} WHERE n = ?`).run(n).changes;
          removed += db.prepare(`DELETE FROM ${this.#table("series")} WHERE n = ?`).run(n).changes;
          this.#series.delete(key);
        }
        for (const { key } of db.prepare(`SELECT key FROM ${this.#table("counters")}`).all() as { key: string }[]) {
          if (!keep(key)) removed += db.prepare(`DELETE FROM ${this.#table("counters")} WHERE key = ?`).run(key).changes;
        }
      })();
      this.#minuteRows = null;
      this.#truncateLog();
      if (this.#full && this.#roomMade(removed)) {
        this.#cleared = { at: now, since: this.#full.since };
        this.#full = null;
      }
      return removed;
    } catch (error) {
      this.#series.clear();
      this.#logError("prune box history", error);
      return 0;
    }
  }

  #once(operation: string, error: unknown): void {
    if (this.#logged.has(operation)) return;
    this.#logged.add(operation);
    this.#logError(operation, error);
  }

  #truncateLog(): void {
    if (!this.#file.attached) return;
    try {
      this.#file.db().pragma(`${this.#file.schema}.wal_checkpoint(TRUNCATE)`);
    } catch {
      return;
    }
  }

  #roomMade(removed: number): boolean {
    if (this.#file.attached) return removed > 0;
    return (this.#file.db().prepare(`SELECT COUNT(*) AS count FROM ${this.#table("minutes")}`).get() as { count: number }).count < this.#sharedMinuteRows;
  }

  #fill(error: string): void {
    const cleared = this.#cleared;
    const since = cleared && this.#now() - cleared.at < REFILLED_WITHIN_MS ? cleared.since : this.#now();
    const first = this.#full === null && (!cleared || since !== cleared.since);
    this.#full = { since, error };
    if (first) this.#logError("write box history: box history's file is full, so box history stops writing until pruning makes room", new Error(error));
  }

  usedBytes(): number | null {
    try {
      return this.#file.usedBytes();
    } catch {
      return null;
    }
  }

  fullWords(): string | null {
    const full = this.#full;
    if (!full) return null;
    return `Box history's file is full, so bb-box stopped keeping box history at ${new Date(full.since).toISOString()}: ${sentence(full.error)} It starts again once old points age out and make room. The Monitor's alerts and the box log are not affected.`;
  }

  checks(state: string): DoctorCheck[] {
    const file = this.#file;
    if (file.problem) return [{ id: "box-history", name: "Box history", status: "fail", detail: `bb-box could not set up ${file.spec.file}: ${sentence(file.problem)}`, fix: "Check that BB's data folder has room and that bb-box's files in it are writable, then restart bb-box." }];
    const used = this.usedBytes();
    let cap: number | null = null;
    try {
      cap = file.capBytes();
    } catch {
      cap = null;
    }
    const where = file.attached ? `${file.spec.file}, attached to bb-box's database` : `bb-box's database, as its handle refused to attach ${file.spec.file}${file.refusal ? `: ${file.refusal}` : ""}`;
    const size = file.attached && used !== null && cap !== null ? `${(used / 1024 / 1024).toFixed(1)} MB used of its cap of ${(cap / 1024 / 1024).toFixed(1)} MB` : `at most ${this.#sharedMinuteRows} minute points, in a database capped at ${cap !== null ? `${(cap / 1024 / 1024).toFixed(1)} MB` : "an unknown size"}`;
    const full = this.fullWords();
    if (full) return [{ id: "box-history", name: "Box history", status: "warn", detail: `${full} In ${where}, ${size}.`, fix: "Nothing else is affected. If it stays full, see bb box monitor history for what it keeps." }];
    if (this.#failed) return [{ id: "box-history", name: "Box history", status: "warn", detail: `${state} Its last write failed at ${new Date(this.#failed.at).toISOString()}: ${sentence(this.#failed.error)} In ${where}, ${size}.`, fix: "Check that BB's data folder has room and that bb-box's files in it are writable." }];
    return [{ id: "box-history", name: "Box history", status: file.attached ? "ok" : "warn", detail: `${state} In ${where}, ${size}.`, fix: file.attached ? null : "Nothing is lost: box history keeps fewer points in bb-box's database." }];
  }
}
