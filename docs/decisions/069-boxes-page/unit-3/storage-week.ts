import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openBoxFiles } from "../../../../src/plugin/attached-files.ts";
import { BOX_LOG_MIGRATIONS } from "../../../../src/plugin/box-log-store.ts";
import { BOX_HISTORY_MIGRATIONS, BoxHistoryStore } from "../../../../src/plugin/box-history-store.ts";
import { parseLightOutput } from "../../../../src/monitor/light.ts";

const boxes = Number(process.argv[2] ?? 30);
const days = Number(process.argv[3] ?? 7);
const folder = mkdtempSync(join(tmpdir(), "history-week-"));
const db = new Database(join(folder, "data.db"));
db.pragma("journal_mode = WAL");
const files = openBoxFiles({ database: () => db as never }, { log: BOX_LOG_MIGRATIONS, history: BOX_HISTORY_MIGRATIONS });
let now = Date.UTC(2026, 9, 1);
const store = new BoxHistoryStore({ file: files.history, now: () => now });
const reading = parseLightOutput("linux", "@@stat\ncpu  100 0 100 800 0 0 0 0 0 0\n2\nbtime 1700000000\n@@meminfo\nMemTotal: 4194304 kB\nMemAvailable: 3145728 kB\n@@df\n/dev/root 33554432 8388608 25165824 25% /\n@@net\n  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\n");
const ids = Array.from({ length: boxes }, (_, index) => `bx${String(index).padStart(12, "0")}`);
const size = (path: string) => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};
let largestWal = 0;
for (let minute = 0; minute < days * 24 * 60; minute++) {
  now += 60_000;
  store.prune(() => true);
  ids.forEach((id, index) => {
    const end = now - (60 - index * 2) * 1000;
    store.record(id, { start: end - 60_000, end, cpu: (minute * 7 + index * 13) % 100, memory: 30 + (index % 50), disk: 25 + index / 10, down: 1000 + minute * 3, up: 500 + index, load: index % 3 === 0 ? 0.5 : null, cores: 2, cpuStall: index % 2 ? 1.5 : null, memoryStall: null, high: minute % 97 === 0 ? 1 : 0 }, { at: end, reading });
  });
  if (minute % 60 === 0) store.tally(now, { due: boxes, taken: boxes, skipped: 0, failed: 0, unanswered: 0, readingMs: 900, slowestMs: 80, workers: 2 });
  largestWal = Math.max(largestWal, size(join(folder, "box-history.db-wal")));
}
const counts = db.prepare("SELECT (SELECT COUNT(*) FROM boxhistory.minutes) AS minutes, (SELECT COUNT(*) FROM boxhistory.hours) AS hours").get() as { minutes: number; hours: number };
console.log(JSON.stringify({ boxes, days, minutes: counts.minutes, hours: counts.hours, fileBytes: size(join(folder, "box-history.db")), usedBytes: store.usedBytes(), walBytes: size(join(folder, "box-history.db-wal")), largestWalBytes: largestWal }));
db.close();
