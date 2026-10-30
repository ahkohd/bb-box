import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { test } from "node:test";
import { openBoxFiles } from "../src/plugin/attached-files.ts";
import { BOX_LOG_MIGRATIONS, BoxLogStore } from "../src/plugin/box-log-store.ts";
import { BOX_HISTORY_MIGRATIONS, BoxHistoryStore, hourParts } from "../src/plugin/box-history-store.ts";
import { historyRead, historyStateWords, retainedKeys } from "../src/plugin/box-history.ts";
import { BoxHistory, LEAST_WORKERS, MOST_WORKERS, secondOf, spreadSeconds, workersFor, type HistoryBox, type HistoryReach, type HistoryWrites, type Switches, type Tally } from "../src/monitor/box-history.ts";
import { historyShape, type HistoryInputs } from "../src/monitor/history-view.ts";
import { HIGH, baselineWhy, lightScript, machinePoint, measure, parseLightOutput, reasonsOf, type Kept, type LightReading, type Point } from "../src/monitor/light.ts";
import { createMonitorStore } from "../src/monitor/monitor-store.ts";
import { BY_COMMAND, BY_PERSON } from "../src/core/box-log.ts";
import { MONITOR_DEFAULTS } from "../src/core/document.ts";
import type { BoxRecord, Boxes } from "../src/core/boxes.ts";
import type { ReachCheck } from "../src/core/reach.ts";
import { TransportError, type RunResult } from "../src/transports/types.ts";
import { tempDir } from "./helpers.ts";
import { bbOf, storage } from "./box-files.ts";

const T0 = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const GiB = 1024 ** 3;

function linuxOutput(parts: { stat?: string; cores?: number; btime?: number; memTotalKiB?: number; memAvailableKiB?: number; load?: string; df?: string; net?: string; cgroup?: Record<string, string> }): string {
  const lines = [
    "@@stat",
    parts.stat ?? "cpu  100 0 100 800 0 0 0 0 0 0",
    String(parts.cores ?? 2),
    `btime ${parts.btime ?? 1_700_000_000}`,
    "@@meminfo",
    `MemTotal:       ${parts.memTotalKiB ?? 4 * 1024 * 1024} kB`,
    `MemAvailable:   ${parts.memAvailableKiB ?? 3 * 1024 * 1024} kB`,
    "@@loadavg",
    parts.load ?? "0.10 0.20 0.30 1/100 1234",
    "@@df",
    parts.df ?? "/dev/root 33554432 8388608 25165824 25% /",
    "@@net",
    parts.net ?? "  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0",
  ];
  for (const [name, text] of Object.entries(parts.cgroup ?? {})) lines.push(`@@cgroup:${name}`, text);
  return `${lines.join("\n")}\n`;
}

function lxc(usageSeconds: number, cpuset: string, memoryCurrentBytes: number, extra: Record<string, string> = {}): LightReading {
  return parseLightOutput(
    "linux",
    linuxOutput({
      cores: cpuset === "0-1" ? 2 : 4,
      memTotalKiB: 4 * 1024 * 1024,
      cgroup: {
        "cpu.max": "max 100000",
        "cpuset.cpus.effective": cpuset,
        "memory.current": String(memoryCurrentBytes),
        "memory.max": "max",
        "cpu.stat": `usage_usec ${Math.round(usageSeconds * 1e6)}`,
        "memory.stat": "inactive_file 0",
        "cpu.pressure": "some avg10=0.00 avg60=1.50 avg300=0.00 total=0",
        "memory.pressure": "some avg10=0.00 avg60=0.00 avg300=0.00 total=0",
        ...extra,
      },
    }),
  );
}

test("the light reading is one command whose answer is under 1 KB, and reads this machine whole (069 unit 3)", { skip: platform() !== "linux" }, () => {
  const output = execFileSync("sh", ["-c", lightScript("linux", { own: false, machine: true })], { encoding: "utf8" });
  assert.ok(Buffer.byteLength(output) < 1024, `the answer is ${Buffer.byteLength(output)} bytes`);
  const reading = parseLightOutput("linux", output);
  assert.ok(reading.visibleCores > 0);
  assert.ok(reading.cpu === null ? reading.container !== null : reading.cpu.total > 0, "it has CPU counters, its own or its cgroup's");
  assert.ok((reading.memoryTotalBytes ?? 0) > 0);
  assert.ok(reading.disk && reading.disk.totalBytes > 0);
  assert.ok(reading.bootAt !== null);
  const withOwn = parseLightOutput("linux", execFileSync("sh", ["-c", lightScript("linux", { own: true, machine: true })], { encoding: "utf8" }));
  assert.ok((withOwn.own?.rows.length ?? 0) > 0, "a slot's reading adds its user's processes");
});

test("a Mac's light reading parses its memory, load, disk and default interface, and has no CPU counters through its route (069 unit 3)", () => {
  const output = [
    "@@sysctl",
    "12",
    "34359738368",
    "@@boot",
    "{ sec = 1700000000, usec = 0 } Tue Nov 14 22:13:20 2023",
    "@@loadavg",
    "{ 2.10 1.90 1.50 }",
    "@@vmstat",
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages purgeable:                          1000.",
    "Pages wired down:                       200000.",
    "Pages occupied by compressor:            50000.",
    "Anonymous pages:                        500000.",
    "@@df",
    "/dev/disk3s1s1 971350180 400000000 500000000 45% /",
    "@@net",
    "en0   1500  <Link#11>   aa:bb:cc:dd:ee:ff  900  0  123456  800  0  654321  0",
    "",
  ].join("\n");
  const reading = parseLightOutput("macos", output);
  assert.equal(reading.visibleCores, 12);
  assert.equal(reading.memoryTotalBytes, 34359738368);
  assert.equal(reading.cpu, null);
  assert.equal(reading.memoryUsedBytes, (499000 + 200000 + 50000) * 16384);
  assert.deepEqual(reading.load, [2.1, 1.9, 1.5]);
  assert.deepEqual(reading.network, { interface: "en0", rxBytes: 123456, txBytes: 654321 });
  assert.equal(reading.bootAt, 1_700_000_000);
  const slotOnly = lightScript("macos", { own: true, machine: false });
  assert.doesNotMatch(slotOnly, /vm_stat|netstat|df -Pk/, "a slot that does not read its Mac this minute reads only its own processes and the Mac's size");
});

test("G10: the light reader takes 066's container limits: a 2-core, 4 GiB LXC box reads about 100% under two busy cores and 75% at 3 GiB", () => {
  const before: Kept = { at: T0, reading: lxc(1000, "0-1", 3 * GiB) };
  const after: Kept = { at: T0 + MINUTE, reading: lxc(1000 + 120, "0-1", 3 * GiB) };
  const point = machinePoint(before, after);
  assert.equal(Math.round(point.cpu!), 100);
  assert.equal(Math.round(point.memory!), 75);
  assert.equal(point.cores, 2);
  assert.equal(point.load, null, "a container has no load of its own");
  assert.equal(point.cpuStall, 1.5);
  assert.deepEqual(reasonsOf(point.high), ["cpu"], "busy CPU is high by the Monitor's own rule");

  const child = (usage: number) => parseLightOutput("linux", linuxOutput({ cores: 16, memTotalKiB: 64 * 1024 * 1024, cgroup: { "cpu.max": "max 100000", "cpuset.cpus.effective": "0-15", "memory.current": String(8 * GiB), "memory.max": "max", "cpu.stat": `usage_usec ${usage * 1e6}`, "memory.stat": "inactive_file 0" } }));
  const uncapped = machinePoint({ at: T0, reading: child(0) }, { at: T0 + MINUTE, reading: child(60) });
  assert.equal(Math.round(uncapped.cpu! * 100) / 100, 6.25, "an uncapped child cgroup is measured against the 16 CPUs it can use");
  assert.equal(Math.round(uncapped.memory!), 13);

  const quota = (usage: number) => parseLightOutput("linux", linuxOutput({ cores: 8, cgroup: { "cpu.max": "50000 100000", "memory.current": String(GiB), "memory.max": String(2 * GiB), "cpu.stat": `usage_usec ${usage * 1e6}`, "memory.stat": "inactive_file 0" } }));
  const half = machinePoint({ at: T0, reading: quota(0) }, { at: T0 + MINUTE, reading: quota(30) });
  assert.equal(Math.round(half.cpu!), 100, "half a core's quota, used whole, is 100%");
  assert.equal(half.cores, 1);
  assert.equal(Math.round(half.memory!), 50, "memory against a finite memory.max");

  const resized = lxc(1000 + 150, "0-3", 3 * GiB);
  assert.equal(baselineWhy(after, { at: T0 + 2 * MINUTE, reading: resized }, null), "resized", "a live resize from 2 to 4 cores starts a new point");
  const next = measure({ at: T0 + 2 * MINUTE, reading: resized }, { at: T0 + 3 * MINUTE, reading: lxc(1000 + 150 + 240, "0-3", 3 * GiB) }, null);
  assert.equal(next.is, "point");
  assert.equal(next.is === "point" ? Math.round(next.point.cpu!) : null, 100, "and the next point is measured against 4 cores");
  assert.equal(next.is === "point" ? next.point.cores : null, 4);
});

test("G12: counters older than 150 s, from before the box's last start, reset or from another boot start a new baseline", () => {
  const vm = (busy: number, total: number, btime = 1_700_000_000) => parseLightOutput("linux", linuxOutput({ stat: `cpu  ${busy} 0 0 ${total - busy} 0 0 0 0 0 0`, cores: 4, btime }));
  const first: Kept = { at: T0, reading: vm(1000, 10_000) };
  assert.equal(baselineWhy(null, first, null), "first");
  assert.equal(baselineWhy(first, { at: T0 + 149_000, reading: vm(2000, 20_000) }, null), null);
  assert.equal(baselineWhy(first, { at: T0 + 151_000, reading: vm(2000, 20_000) }, null), "stale");
  assert.equal(baselineWhy(first, { at: T0 + MINUTE, reading: vm(2000, 20_000) }, T0 + 30_000), "started");
  assert.equal(baselineWhy(first, { at: T0 + MINUTE, reading: vm(10, 100, 1_700_009_000) }, null), "rebooted");
  assert.equal(baselineWhy(first, { at: T0 + MINUTE, reading: vm(500, 30_000) }, null), "reset");
  const point = machinePoint(first, { at: T0 + MINUTE, reading: vm(1000 + 6_000, 10_000 + 24_000) });
  assert.equal(Math.round(point.cpu!), 25);
  assert.equal(point.load, 0.2);
  assert.equal(point.cores, 4);
});

interface Timer {
  readonly at: number;
  readonly task: () => void;
  readonly id: number;
}

class FakeClock {
  now: number;
  #timers: Timer[] = [];
  #ids = 0;
  constructor(now: number) {
    this.now = now;
  }
  setTimer = (task: () => void, ms: number) => {
    const timer = { at: this.now + ms, task, id: ++this.#ids };
    this.#timers.push(timer);
    return timer;
  };
  clearTimer = (timer: unknown) => {
    this.#timers = this.#timers.filter((each) => each !== timer);
  };
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      await settle();
      const next = this.#timers.reduce<Timer | null>((best, timer) => (timer.at <= end && (!best || timer.at < best.at || (timer.at === best.at && timer.id < best.id)) ? timer : best), null);
      if (!next) break;
      this.#timers = this.#timers.filter((timer) => timer !== next);
      this.now = Math.max(this.now, next.at);
      next.task();
    }
    this.now = end;
    await settle();
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
}

class FakeBox {
  readonly id: string;
  readonly cores: number;
  busyCores = 0;
  #busy = 0;
  #total = 0;
  #at: number;
  boot = 1_700_000_000;
  constructor(id: string, cores: number, at: number) {
    this.id = id;
    this.cores = cores;
    this.#at = at;
  }
  reboot(at: number): void {
    this.#busy = 0;
    this.#total = 0;
    this.#at = at;
    this.boot += 3600;
  }
  reading(at: number): LightReading {
    const seconds = (at - this.#at) / 1000;
    this.#total += this.cores * 100 * seconds;
    this.#busy += this.busyCores * 100 * seconds;
    this.#at = at;
    return parseLightOutput("linux", linuxOutput({ stat: `cpu  ${Math.round(this.#busy)} 0 0 ${Math.round(this.#total - this.#busy)} 0 0 0 0 0 0`, cores: this.cores, btime: this.boot }));
  }
  get box(): HistoryBox {
    return { id: this.id, name: this.id, os: "linux", slot: null, lastStartAt: null };
  }
}

function answering(): HistoryReach & { checks: string[]; answered: Map<string, number>; silent: Set<string>; answers: boolean } {
  const reach = {
    checks: [] as string[],
    answered: new Map<string, number>(),
    silent: new Set<string>(),
    answers: false,
    notAnswering: (id: string) => reach.silent.has(id),
    lastAnswered: (id: string) => reach.answered.get(id) ?? null,
    check: async (id: string) => {
      reach.checks.push(id);
      return reach.answers;
    },
  };
  return reach;
}

class MemoryWrites implements HistoryWrites {
  points = new Map<string, Point[]>();
  baselines = new Map<string, number>();
  tallies: Tally[] = [];
  quiet: { why: string; quiet: boolean; at: number }[] = [];
  #counters = new Map<string, Kept>();
  record(key: string, point: Point, kept: Kept) {
    this.points.set(key, [...(this.points.get(key) ?? []), point]);
    this.#counters.set(key, kept);
    return true;
  }
  keep(key: string, kept: Kept) {
    this.baselines.set(key, (this.baselines.get(key) ?? 0) + 1);
    this.#counters.set(key, kept);
    return true;
  }
  counters() {
    return new Map(this.#counters);
  }
  setQuiet(why: "monitor" | "history", quiet: boolean, at: number) {
    this.quiet.push({ why, quiet, at });
  }
  tally(_at: number, tally: Tally) {
    this.tallies.push(tally);
  }
  prune() {
    return 0;
  }
}

function sumOf(tallies: readonly Tally[]): Tally {
  return tallies.reduce((sum, row) => ({ due: sum.due + row.due, taken: sum.taken + row.taken, skipped: sum.skipped + row.skipped, failed: sum.failed + row.failed, unanswered: sum.unanswered + row.unanswered, readingMs: sum.readingMs + row.readingMs, slowestMs: Math.max(sum.slowestMs, row.slowestMs), workers: Math.max(sum.workers, row.workers) }), { due: 0, taken: 0, skipped: 0, failed: 0, unanswered: 0, readingMs: 0, slowestMs: 0, workers: 0 });
}

function reader(options: { clock: FakeClock; boxes: () => readonly HistoryBox[]; read: (box: HistoryBox, signal: AbortSignal) => Promise<LightReading>; store: HistoryWrites; reach?: HistoryReach; switches?: () => Switches }) {
  const history = new BoxHistory({
    boxes: async () => options.boxes(),
    read: (box, _request, signal) => options.read(box, signal),
    reach: options.reach ?? answering(),
    store: options.store,
    switches: options.switches ?? (() => ({ monitor: true, history: true })),
    retained: async () => () => true,
    now: () => options.clock.now,
    setTimer: options.clock.setTimer,
    clearTimer: options.clock.clearTimer,
  });
  void history.start();
  return history;
}

test("each box has its own second in the minute, in the order of its ID's hash, evenly spread, and the workers grow with the work from 2 to 8 (069 G11)", () => {
  const ids = Array.from({ length: 30 }, (_, index) => `bx${index.toString(36).padStart(12, "0")}`);
  const seconds = spreadSeconds(ids);
  assert.deepEqual([...seconds.values()].sort((a, b) => a - b), Array.from({ length: 30 }, (_, index) => index * 2), "30 boxes are read 2 s apart");
  assert.deepEqual(spreadSeconds([...ids].reverse()), seconds, "the order comes from the IDs, not the list");
  assert.ok(new Set(ids.map(secondOf)).size < 30, "hashes alone clump, which is why the seconds are spread");
  assert.equal(secondOf("bxamberfox2q7k"), secondOf("bxamberfox2q7k"));
  assert.equal(workersFor(30, 100), LEAST_WORKERS);
  assert.equal(workersFor(30, 9_900), 6);
  assert.equal(workersFor(60, 9_900), MOST_WORKERS);
});

test("G11: 30 boxes whose readings all take 9.9 s keep coverage at 99% by growing workers, and a box that does not answer is counted apart", async (t) => {
  const clock = new FakeClock(T0);
  const boxes = Array.from({ length: 30 }, (_, index) => new FakeBox(`bxcoverage${String(index).padStart(4, "0")}`, 2, T0));
  const silent = new FakeBox("bxsilentbox00001", 2, T0);
  const reach = answering();
  reach.silent.add(silent.id);
  const store = new MemoryWrites();
  let reads = 0;
  const history = reader({
    clock,
    boxes: () => [...boxes, silent].map((box) => box.box),
    store,
    reach,
    read: (box) =>
      new Promise((resolve) => {
        reads++;
        clock.setTimer(() => resolve(boxes.find((each) => each.id === box.id)!.reading(clock.now)), 9_900);
      }),
  });
  await clock.advance(61 * MINUTE);
  history.stop();
  const tally = sumOf(store.tallies);
  assert.ok(tally.due >= 30 * 59, `${tally.due} readings were due`);
  t.diagnostic(`coverage ${((tally.taken / tally.due) * 100).toFixed(2)}%: ${tally.taken} of ${tally.due}, ${tally.skipped} skipped, up to ${tally.workers} at once, ${tally.unanswered} not tried`);
  assert.ok(tally.taken / tally.due >= 0.99, `coverage ${(tally.taken / tally.due * 100).toFixed(2)}%: ${tally.taken} of ${tally.due}, ${tally.skipped} skipped`);
  assert.equal(tally.failed, 0);
  assert.ok(tally.workers >= 6 && tally.workers <= MOST_WORKERS, `up to ${tally.workers} at once`);
  assert.ok(tally.unanswered >= 59, "the box that does not answer is counted apart, not as due");
  assert.ok(reads >= tally.taken);
  assert.ok((store.points.get(boxes[0]!.id)?.length ?? 0) >= 58, "each box has a point a minute");
});

test("G11: a box whose readings fail 3 times in a row is read again only once the reach check finds it answers; a failed reading calls nothing else; a box that answers the reach check waits 15 minutes", async () => {
  const clock = new FakeClock(T0);
  const box = new FakeBox("bxfailingbox001", 2, T0);
  const reach = answering();
  const store = new MemoryWrites();
  let failing = true;
  let reads = 0;
  const history = reader({
    clock,
    boxes: () => [box.box],
    store,
    reach,
    read: async () => {
      reads++;
      if (failing) throw new Error("It did not answer a command.");
      return box.reading(clock.now);
    },
  });
  await clock.advance(10 * MINUTE);
  assert.equal(reads, 3, "three tries, then no more");
  assert.deepEqual(reach.checks, [box.id], "the reach check is asked once");
  assert.ok(history.status().paused.includes(box.id));
  failing = false;
  await clock.advance(3 * MINUTE);
  assert.equal(reads, 3, "not read while the reach check has not found it answering");
  reach.answered.set(box.id, clock.now);
  await clock.advance(3 * MINUTE);
  assert.ok(reads >= 5, "read again once it answers");
  assert.ok((store.points.get(box.id)?.length ?? 0) >= 1);
  history.stop();
  const tally = sumOf(store.tallies);
  assert.equal(tally.failed, 3);
  assert.ok(tally.unanswered >= 5, "while paused its readings are not due");

  const odd = new FakeBox("bxoddanswers001", 2, clock.now);
  const quietReach = answering();
  quietReach.answers = true;
  let oddReads = 0;
  const second = reader({
    clock,
    boxes: () => [odd.box],
    store: new MemoryWrites(),
    reach: quietReach,
    read: async () => {
      oddReads++;
      quietReach.answered.set(odd.id, clock.now);
      throw new Error("Its answer could not be read.");
    },
  });
  await clock.advance(5 * MINUTE);
  assert.equal(oddReads, 3);
  assert.deepEqual(quietReach.checks, [odd.id], "a box that fails for another reason is not marked as not answering");
  await clock.advance(10 * MINUTE);
  assert.equal(oddReads, 3, "it answers the reach check, so history waits rather than failing every few minutes");
  await clock.advance(7 * MINUTE);
  assert.ok(oddReads > 3, "and reads it again after 15 minutes");
  second.stop();
});

test("a reading kept badly is not a failed reading of the box, a repeated point is not added twice to its hour, and a stopped reader starts again", async () => {
  const clock = new FakeClock(T0);
  const box = new FakeBox("bxstorefails001", 2, T0);
  const store = new MemoryWrites();
  let broken = true;
  const record = store.record.bind(store);
  store.record = (key, point, kept) => {
    if (broken) throw new Error("disk I/O error");
    return record(key, point, kept);
  };
  const reach = answering();
  const history = reader({ clock, boxes: () => [box.box], store, reach, read: async () => box.reading(clock.now) });
  await clock.advance(6 * MINUTE);
  history.stop();
  const tally = sumOf(store.tallies);
  assert.equal(tally.failed, 0);
  assert.ok(tally.taken >= 4, `${tally.taken} taken`);
  assert.deepEqual(reach.checks, [], "the box answered, so the reach check is not asked");
  broken = false;
  await clock.advance(2 * MINUTE);
  assert.equal(store.points.get(box.id), undefined, "stopped, it reads nothing");
  void history.start();
  await clock.advance(4 * MINUTE + 1000);
  assert.ok((store.points.get(box.id)?.length ?? 0) >= 2, "started again, it reads again: a baseline, as its counters are stale, then a point a minute");
  history.stop();

  const opened = openedHistory(tempDir("history-twice"), () => T0 + HOUR);
  points(opened.store, "bxtwicebox00001", T0, 1, { cpu: 40 });
  points(opened.store, "bxtwicebox00001", T0, 1, { cpu: 40 });
  assert.equal(opened.store.minutes("bxtwicebox00001", 0, T0 * 2).length, 1);
  assert.equal(opened.store.hours("bxtwicebox00001", 0, T0 * 2)[0]!.covered, 60, "the same minute twice adds its minute once");
  opened.source.close();
});

function openedHistory(folder: string, now: () => number, refuseAttach = false, logError?: (operation: string) => void) {
  const source = storage(folder, refuseAttach);
  const files = openBoxFiles(source, { log: BOX_LOG_MIGRATIONS, history: BOX_HISTORY_MIGRATIONS });
  return { source, files, store: new BoxHistoryStore({ file: files.history, now, ...(logError ? { logError } : {}) }), log: new BoxLogStore({ file: files.log, now }) };
}

test("G12: a restart of bb-box taking 30 s loses no point, one taking 4 minutes loses one, and a box restarted inside shows no negative or huge CPU", async () => {
  const folder = tempDir("history-restart");
  const clock = new FakeClock(T0 - 1000);
  const box = new FakeBox("bxrestarting001", 4, T0 - 1000);
  box.busyCores = 1;
  const second = spreadSeconds([box.id]).get(box.id)! * 1000;
  const first = openedHistory(folder, () => clock.now);
  let history = reader({ clock, boxes: () => [box.box], store: first.store, read: async () => box.reading(clock.now) });
  await clock.advance(1000 + second + 5 * MINUTE + 1000);
  history.stop();
  const minutesBefore = first.store.minutes(box.id, T0 - HOUR, clock.now + HOUR).length;
  assert.equal(minutesBefore, 5, "a baseline, then a point a minute");
  first.source.close();

  await clock.advance(MINUTE - 15_000);
  const quick = openedHistory(folder, () => clock.now);
  await clock.advance(30_000);
  history = reader({ clock, boxes: () => [box.box], store: quick.store, read: async () => box.reading(clock.now) });
  await clock.advance(3 * MINUTE);
  history.stop();
  const afterQuick = quick.store.minutes(box.id, T0 - HOUR, clock.now + HOUR);
  assert.equal(afterQuick.length, minutesBefore + 3, "every reading after a 30 s restart, the one missed included, made a point");
  assert.ok(afterQuick.some((minute) => minute.covered > 100), "the point after the missed reading covers both minutes");
  const shown = historyShape({ range: "1h", now: clock.now, createdAt: T0 - HOUR, state: "ready", minutes: afterQuick, hours: [], host: null, events: [], quiet: [] });
  const read = shown.steps.filter((step) => step.cpu !== null);
  assert.ok(read.every((step) => Math.round(step.cpu!) === 25), "every minute reads its 25%");
  assert.deepEqual(shown.gaps.filter((gap) => gap.from >= T0 + second + MINUTE), [], "and no minute after the first point is missing");
  quick.source.close();

  await clock.advance(30_000);
  const slow = openedHistory(folder, () => clock.now);
  await clock.advance(4 * MINUTE);
  history = reader({ clock, boxes: () => [box.box], store: slow.store, read: async () => box.reading(clock.now) });
  await clock.advance(3 * MINUTE);
  history.stop();
  const afterSlow = slow.store.minutes(box.id, T0 - HOUR, clock.now + HOUR);
  assert.equal(afterSlow.length, afterQuick.length + 2, "after 4 minutes the counters are stale: three readings, one baseline and two points");

  history = reader({ clock, boxes: () => [box.box], store: slow.store, read: async () => box.reading(clock.now) });
  await clock.advance(2 * MINUTE);
  box.reboot(clock.now);
  await clock.advance(4 * MINUTE);
  history.stop();
  const all = slow.store.minutes(box.id, T0 - HOUR, clock.now + HOUR);
  assert.ok(all.every((minute) => minute.cpu !== null && minute.cpu >= 0 && minute.cpu <= 100), "no negative or huge CPU across the box's own restart");
  assert.equal(all.length, afterSlow.length + 2 + 3, "the reading after its restart starts a new baseline");
  slow.source.close();
});

test("G13: with the Monitor off nothing is read; with box history off for 3 minutes, then on, those minutes say Not read, also after a restart", async () => {
  const folder = tempDir("history-off");
  const clock = new FakeClock(T0);
  const box = new FakeBox("bxquietbox00001", 2, T0);
  const opened = openedHistory(folder, () => clock.now);
  let switches: Switches = { monitor: false, history: true };
  let reads = 0;
  const history = reader({ clock, boxes: () => [box.box], store: opened.store, switches: () => switches, read: async () => (reads++, box.reading(clock.now)) });
  await clock.advance(10 * MINUTE);
  assert.equal(reads, 0, "the Monitor off for 10 minutes: no reading at all");
  switches = { monitor: true, history: true };
  history.configure();
  await clock.advance(5 * MINUTE);
  assert.ok(reads >= 4);
  const offAt = clock.now;
  switches = { monitor: true, history: false };
  history.configure();
  const readsWhileOff = reads;
  await clock.advance(3 * MINUTE);
  assert.equal(reads, readsWhileOff, "box history off: nothing read in the background");
  switches = { monitor: true, history: true };
  history.configure();
  const onAt = clock.now;
  await clock.advance(5 * MINUTE);
  history.stop();
  opened.source.close();

  const reopened = openedHistory(folder, () => clock.now);
  const quiet = reopened.store.quiet(T0 - HOUR, clock.now + HOUR);
  assert.deepEqual(quiet.map((span) => [span.why, span.from, span.to]), [["monitor", T0, T0 + 10 * MINUTE], ["history", offAt, onAt]]);
  const shown = historyShape({ range: "1h", now: clock.now, createdAt: T0 - HOUR, state: "ready", minutes: reopened.store.minutes(box.id, T0 - HOUR, clock.now), hours: [], host: null, events: [], quiet });
  const off = shown.gaps.filter((gap) => gap.kind === "not-read");
  assert.ok(off.some((gap) => gap.from <= offAt + MINUTE && gap.to >= onAt - MINUTE), "the 3 minutes off say Not read");
  assert.ok(off.some((gap) => gap.from <= T0 && gap.to >= T0 + 9 * MINUTE), "and so do the 10 minutes with the Monitor off");
  reopened.source.close();
});

function points(store: BoxHistoryStore, key: string, from: number, minutes: number, values: Partial<Point>): void {
  for (let index = 0; index < minutes; index++) {
    const end = from + (index + 1) * MINUTE;
    const reading = parseLightOutput("linux", linuxOutput({}));
    store.record(key, { start: end - MINUTE, end, cpu: 50, memory: 40, disk: 25, down: 100, up: 50, load: 0.2, cores: 2, cpuStall: null, memoryStall: null, high: 0, ...values }, { at: end, reading });
  }
}

test("G14: an hour read for 20 minutes at 90% and stopped for the rest shows 90%, marked partly read, not 30%", () => {
  const clock = { now: T0 + 3 * HOUR };
  const opened = openedHistory(tempDir("history-rollup"), () => clock.now);
  points(opened.store, "bxrollupbox0001", T0, 20, { cpu: 90, memory: 60 });
  const hours = opened.store.hours("bxrollupbox0001", T0 - HOUR, T0 + 2 * HOUR);
  assert.equal(hours.length, 1);
  assert.equal(hours[0]!.covered, 20 * 60);
  assert.equal(hours[0]!.cpu, 90);
  const shown = historyShape({
    range: "7d",
    now: clock.now,
    createdAt: T0 - 24 * HOUR,
    state: "stopped",
    minutes: [],
    hours,
    host: null,
    events: [{ kind: "stopped", at: T0 + 20 * MINUTE }],
    quiet: [],
  });
  const hour = shown.steps.find((step) => step.at === T0)!;
  assert.equal(hour.cpu, 90);
  assert.equal(hour.partial, true);
  assert.equal(hour.cpuBusiest, 90);
  assert.equal(shown.gaps.at(-1)?.kind, "stopped", "the hours after it say Stopped");
  opened.source.close();
});

test("a point spread over two hours adds its seconds to each, and a day's minutes keep each 10 minutes' busiest minute", () => {
  assert.deepEqual(hourParts(3600 * 10 - 30, 3600 * 10 + 30), [{ hour: 3600 * 9, seconds: 30 }, { hour: 3600 * 10, seconds: 30 }]);
  const clock = { now: T0 + HOUR };
  const opened = openedHistory(tempDir("history-busiest"), () => clock.now);
  points(opened.store, "bxbusiestbox001", T0, 10, { cpu: 10 });
  points(opened.store, "bxbusiestbox001", T0 + 10 * MINUTE, 1, { cpu: 95 });
  const shown = historyShape({ range: "24h", now: clock.now, createdAt: T0 - HOUR, state: "ready", minutes: opened.store.minutes("bxbusiestbox001", T0 - HOUR, clock.now), hours: [], host: null, events: [], quiet: [] });
  const step = shown.steps.find((each) => each.at === T0)!;
  assert.equal(step.cpu, 10);
  assert.equal(step.cpuBusiest, 10);
  const next = shown.steps.find((each) => each.at === T0 + 10 * MINUTE)!;
  assert.equal(next.cpuBusiest, 95);
  assert.equal(next.partial, true, "a 10-minute step read for 1 minute is partly read");
  opened.source.close();
});

test("each minute's pruning checkpoints box-history.db's write-ahead log and truncates it, so it stays far under its 4 MB", () => {
  const clock = { now: T0 };
  const folder = tempDir("history-wal");
  const opened = openedHistory(folder, () => clock.now);
  let largest = 0;
  for (let minute = 0; minute < 120; minute++) {
    clock.now += MINUTE;
    opened.store.prune(() => true);
    for (let box = 0; box < 30; box++) points(opened.store, `bxwal${String(box).padStart(9, "0")}`, clock.now - MINUTE, 1, {});
    largest = Math.max(largest, statSync(join(folder, "box-history.db-wal")).size);
  }
  assert.ok(largest < 1024 * 1024, `the write-ahead log peaked at ${largest} bytes`);
  opened.source.close();
});

test("history keeps minute points 24 hours and hourly points 7 days, with a set clock", () => {
  const clock = { now: T0 + 30 * MINUTE };
  const opened = openedHistory(tempDir("history-retention"), () => clock.now);
  points(opened.store, "bxretainedbox01", T0, 30, {});
  assert.equal(opened.store.minutes("bxretainedbox01", 0, T0 * 2).length, 30);
  clock.now = T0 + 24 * HOUR + 20 * MINUTE;
  opened.store.prune(() => true);
  assert.equal(opened.store.minutes("bxretainedbox01", 0, T0 * 2).length, 10, "minute points older than 24 hours go");
  assert.equal(opened.store.hours("bxretainedbox01", 0, T0 * 2).length, 1, "the hour stays");
  clock.now = T0 + 7 * 24 * HOUR + 30 * MINUTE;
  opened.store.prune(() => true);
  assert.equal(opened.store.hours("bxretainedbox01", 0, T0 * 2).length, 1, "an hour is kept 7 days");
  clock.now = T0 + 8 * 24 * HOUR + 30 * MINUTE;
  opened.store.prune(() => true);
  assert.equal(opened.store.hours("bxretainedbox01", 0, T0 * 2).length, 0, "and goes after");
  opened.source.close();
});

function record(id: string): BoxRecord {
  return { id, threadId: "thr_one", guest: { ref: id, host: null, data: {} } } as unknown as BoxRecord;
}

test("a released box's points, and a forgotten box's, go 24 hours after it, with a set clock", () => {
  const clock = { now: T0 + HOUR };
  const opened = openedHistory(tempDir("history-ended"), () => clock.now);
  for (const box of ["bxreleasedbox01", "bxforgottenbox1", "bxlivebox000001"]) points(opened.store, box, T0, 30, {});
  opened.store.keep("bxreleasedbox01", { at: T0 + 30 * MINUTE, reading: parseLightOutput("linux", linuxOutput({})) });
  opened.log.record({ box: "bxreleasedbox01", thread: "thr_one", name: "amber-fox", at: T0 + 40 * MINUTE, kind: "released", by: BY_PERSON });
  opened.log.record({ box: "bxforgottenbox1", thread: "thr_one", name: "maple-row", at: T0 + 40 * MINUTE, kind: "forgotten", by: BY_COMMAND });
  const keep = () => retainedKeys([record("bxlivebox000001")], (id) => opened.log.ended(id));
  clock.now = T0 + 40 * MINUTE + 23 * HOUR;
  opened.store.prune(keep());
  for (const box of ["bxreleasedbox01", "bxforgottenbox1", "bxlivebox000001"]) assert.ok(opened.store.hours(box, 0, T0 * 2).length > 0, `${box} is kept for 24 hours after it ended`);
  clock.now = T0 + 40 * MINUTE + 25 * HOUR;
  opened.store.prune(keep());
  assert.deepEqual(opened.store.hours("bxreleasedbox01", 0, T0 * 2), [], "a released box's points go");
  assert.deepEqual(opened.store.hours("bxforgottenbox1", 0, T0 * 2), [], "and a forgotten box's");
  assert.ok(!opened.store.counters().has("bxreleasedbox01"), "with its counters");
  assert.ok(opened.store.hours("bxlivebox000001", 0, T0 * 2).length > 0, "a box that is still here keeps its hours");
  opened.source.close();
});

test("G18: with box history's cap set low, its writes stop and say so in the doctor and Monitor settings; alerts and the box log still write; it starts again once pruning makes room", () => {
  const folder = tempDir("history-full");
  const clock = { now: T0 + 2 * HOUR };
  const logged: string[] = [];
  const opened = openedHistory(folder, () => clock.now, false, (operation) => void logged.push(operation));
  const db = opened.source.handle();
  const pageSize = Number(db.pragma("boxhistory.page_size", { simple: true }));
  db.pragma(`boxhistory.max_page_count = ${Number(db.pragma("boxhistory.page_count", { simple: true })) + 4}`);
  let written = 0;
  for (let box = 0; box < 200 && !opened.store.full; box++) {
    const key = `bxfilling${String(box).padStart(6, "0")}`;
    for (let minute = 0; minute < 60 && !opened.store.full; minute++) {
      const end = T0 + (minute + 1) * MINUTE;
      if (opened.store.record(key, { start: end - MINUTE, end, cpu: 50, memory: 40, disk: 25, down: 100, up: 50, load: null, cores: 2, cpuStall: null, memoryStall: null, high: 0 }, { at: end, reading: parseLightOutput("linux", linuxOutput({})) })) written++;
    }
  }
  assert.ok(opened.store.full, `writes stopped after ${written} points, at ${pageSize * (Number(db.pragma("boxhistory.page_count", { simple: true })))} bytes`);
  const check = opened.store.checks("On.")[0]!;
  assert.equal(check.status, "warn");
  assert.match(check.detail, /Box history's file is full, so bb-box stopped keeping box history/);
  assert.match(opened.store.fullWords() ?? "", /starts again once old points age out/, "Monitor settings show the same words");
  assert.equal(opened.store.record("bxfilling000000", { start: T0, end: T0 + MINUTE, cpu: 1, memory: 1, disk: 1, down: 1, up: 1, load: null, cores: 1, cpuStall: null, memoryStall: null, high: 0 }, { at: T0 + 2 * HOUR, reading: parseLightOutput("linux", linuxOutput({})) }), false, "no write is tried while full");
  const before = logged.length;
  for (let minute = 0; minute < 5; minute++) {
    opened.store.tally(clock.now, { due: 1, taken: 1, skipped: 0, failed: 0, unanswered: 0, readingMs: 1, slowestMs: 1, workers: 2 });
    opened.store.setQuiet("history", minute % 2 === 0, clock.now);
  }
  assert.equal(logged.length, before, "while full, tallies and off times are left alone, with nothing logged each minute");
  const monitor = createMonitorStore(bbOf(opened.source) as never);
  assert.equal(monitor.write([{ type: "sample", timestamp: clock.now, cpu: 10 }]).length, 1, "the Monitor's alerts still write");
  opened.log.record({ box: "bxone", thread: "thr_one", name: "amber-fox", at: clock.now, kind: "stopped", by: BY_PERSON });
  assert.equal(opened.log.failures, null, "the box log still writes");
  clock.now = T0 + 25 * HOUR;
  assert.ok(opened.store.prune(() => true) > 0);
  assert.equal(opened.store.full, null, "pruning made room");
  const end = clock.now;
  assert.ok(opened.store.record("bxfilling000000", { start: end - MINUTE, end, cpu: 1, memory: 1, disk: 1, down: 1, up: 1, load: null, cores: 1, cpuStall: null, memoryStall: null, high: 0 }, { at: end, reading: parseLightOutput("linux", linuxOutput({})) }), "and writing resumes");
  assert.equal(opened.store.checks("On.")[0]!.status, "ok");
  opened.source.close();
});

test("G18 where ATTACH is refused: history stops at its own row cap, before data.db's", () => {
  const clock = { now: T0 + 2 * HOUR };
  const source = storage(tempDir("history-shared"), true);
  const files = openBoxFiles(source, { log: BOX_LOG_MIGRATIONS, history: BOX_HISTORY_MIGRATIONS });
  assert.equal(files.shared, true);
  const store = new BoxHistoryStore({ file: files.history, now: () => clock.now, sharedMinuteRows: 50 });
  const reading = parseLightOutput("linux", linuxOutput({}));
  for (let minute = 0; minute < 60; minute++) store.record("bxsharedbox0001", { start: T0 + minute * MINUTE, end: T0 + (minute + 1) * MINUTE, cpu: 1, memory: 1, disk: 1, down: 1, up: 1, load: null, cores: 1, cpuStall: null, memoryStall: null, high: 0 }, { at: T0, reading });
  assert.equal(store.minutes("bxsharedbox0001", 0, T0 * 2).length, 50);
  assert.match(store.fullWords() ?? "", /at most 50 minute points/);
  clock.now = T0 + 24 * HOUR + 30 * MINUTE;
  store.prune(() => true);
  assert.equal(store.full, null);
  source.close();
});

test("a box's history says why each gap is there: not made yet, starting, stopped, not read, or no reading, and nothing for a reading still to come", () => {
  const now = T0 + 2 * HOUR + 30_000;
  const made = T0 + 10 * MINUTE;
  const minute = (at: number) => ({ at, covered: 60, cpu: 20, memory: 30, disk: 10, down: 1, up: 1, high: 0 });
  const running = [
    ...Array.from({ length: 15 }, (_, index) => minute(made + (index + 2) * MINUTE)),
    ...Array.from({ length: 10 }, (_, index) => minute(T0 + 70 * MINUTE + (index + 1) * MINUTE)),
    ...Array.from({ length: 4 }, (_, index) => minute(T0 + 100 * MINUTE + (index + 1) * MINUTE)),
    ...Array.from({ length: 13 }, (_, index) => minute(T0 + 107 * MINUTE + (index + 1) * MINUTE)),
  ];
  const inputs: HistoryInputs = {
    range: "24h",
    now,
    createdAt: made,
    state: "ready",
    minutes: running,
    hours: [],
    host: null,
    events: [
      { kind: "made", at: made },
      { kind: "ready", at: made + MINUTE },
      { kind: "stopped", at: T0 + 30 * MINUTE },
      { kind: "start-asked", at: T0 + 60 * MINUTE },
      { kind: "started", at: T0 + 70 * MINUTE },
    ],
    quiet: [{ from: T0 + 84 * MINUTE, to: T0 + 96 * MINUTE }],
  };
  const shown = historyShape(inputs);
  const kindAt = (at: number) => shown.gaps.find((gap) => at >= gap.from && at < gap.to)?.kind ?? null;
  assert.equal(kindAt(T0 - HOUR), "not-made");
  assert.equal(kindAt(T0 + 40 * MINUTE), "stopped");
  assert.equal(kindAt(T0 + 60 * MINUTE), "starting");
  assert.equal(kindAt(T0 + 90 * MINUTE), "not-read");
  assert.equal(kindAt(T0 + 2 * HOUR), null, "the step whose reading may still come shows no gap");
  assert.deepEqual(shown.stops, [{ from: T0 + 30 * MINUTE, to: T0 + 60 * MINUTE }]);
  const hourly = historyShape({ ...inputs, range: "1h", minutes: running.filter((each) => each.at <= T0 + 104 * MINUTE) });
  assert.equal(hourly.gaps.find((gap) => gap.from === T0 + 104 * MINUTE)?.kind, "no-reading", "a missing minute with nothing to say why is No reading");
});

test("the doctor says whether box history reads, and its coverage this hour and the last", () => {
  assert.match(historyStateWords({ ...MONITOR_DEFAULTS, enabled: false }, 0, 2, null), /^Off, as the Monitor is off/);
  assert.match(historyStateWords({ ...MONITOR_DEFAULTS, boxHistory: false }, 0, 2, null), /^Off: bb-box reads no box in the background/);
  assert.equal(
    historyStateWords(MONITOR_DEFAULTS, 30, 6, { due: 1800, taken: 1790, skipped: 4, failed: 6, unanswered: 60, readingMs: 0, slowestMs: 0, workers: 6 }),
    "On: bb-box reads 30 boxes once a minute, with up to 6 readings at once. This hour and the last, 1790 of 1800 readings due were taken within 10 s of their second (99.4%); 4 skipped, 6 failed, and 60 not tried as their box did not answer.",
  );
  assert.equal(HIGH.load, 32);
});

test("a history reading goes through a connected BB machine's host entry, else one command through its route; a box that does not answer is told to the reach check, and nothing else is called (069 G7, G11)", async () => {
  const calls: string[] = [];
  const reach = {
    answered: (box: BoxRecord) => void calls.push(`answered ${box.id}`),
    failed: (box: BoxRecord) => void calls.push(`reach check told ${box.id}`),
    notAnswering: () => false,
    reach: () => ({ is: "answers", lastAnswered: null }),
  } as unknown as ReachCheck;
  const answer = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false, truncated: false, durationMs: 5 });
  let route: () => Promise<RunResult> = async () => answer(linuxOutput({}));
  const command = {
    run: async (script: string, options: { timeoutMs?: number }) => {
      calls.push(`route ${options.timeoutMs} ${script.includes("/proc/stat")}`);
      return route();
    },
  };
  const boxes = { find: async (id: string) => records[id] ?? null, all: async () => [], transports: async () => ({ command }) } as unknown as Boxes;
  const linux = { command: {}, os: "linux" };
  const records: Record<string, BoxRecord> = {
    bxmachine00001: { id: "bxmachine00001", name: "amber-fox", state: "ready", enrol: { state: "enrolled", hostId: "host_1", error: null }, capabilities: linux } as unknown as BoxRecord,
    bxroutedbox001: { id: "bxroutedbox001", name: "brisk-lake", state: "ready", enrol: { state: "off", hostId: null, error: null }, capabilities: linux } as unknown as BoxRecord,
    bxwindows00001: { id: "bxwindows00001", name: "maple-row", state: "ready", enrol: { state: "enrolled", hostId: "host_2", error: null }, capabilities: { command: null, os: "windows" } } as unknown as BoxRecord,
  };
  let connected: boolean | null = true;
  let host: () => Promise<LightReading> = async () => parseLightOutput("linux", linuxOutput({}));
  const read = historyRead(
    {
      boxes,
      reach,
      hostLight: async (hostId, request, timeoutMs) => {
        calls.push(`host ${hostId} ${JSON.stringify(request)} ${timeoutMs}`);
        return host();
      },
      connected: async () => connected,
      unreachableHost: async (box) => void calls.push(`machine offline ${box.id}`),
    },
    (id) => records[id],
  );
  const request = { own: false, machine: true };
  const as = (id: string): HistoryBox => ({ id, name: id, os: "linux", slot: null, lastStartAt: null });
  const signal = new AbortController().signal;

  await read(as("bxmachine00001"), request, signal);
  assert.deepEqual(calls.splice(0), ['host host_1 {"own":false,"machine":true} 10000', "answered bxmachine00001"]);

  host = async () => {
    throw new Error("There is no handler monitor.light.");
  };
  await read(as("bxmachine00001"), request, signal);
  assert.deepEqual(calls.splice(0), ['host host_1 {"own":false,"machine":true} 10000', "route 10000 true", "answered bxmachine00001"], "a host entry that cannot answer falls back to the route");

  connected = false;
  await read(as("bxmachine00001"), request, signal);
  assert.deepEqual(calls.splice(0), ["route 10000 true", "answered bxmachine00001"], "a BB machine BB does not see connected is read through its route");

  route = async () => {
    throw new TransportError("unreachable", "ssh: connect to host 10.0.0.31 port 22: Connection timed out");
  };
  await assert.rejects(read(as("bxroutedbox001"), request, signal), /Connection timed out/);
  assert.deepEqual(calls.splice(0), ["route 10000 true", "reach check told bxroutedbox001"], "one command, then the reach check, and no backend call");

  await assert.rejects(read(as("bxwindows00001"), request, signal), /not answering BB/);
  assert.deepEqual(calls.splice(0), ["machine offline bxwindows00001"]);
});
