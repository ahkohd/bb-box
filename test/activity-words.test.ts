import { test } from "node:test";
import assert from "node:assert/strict";
import { GAP_WORDS, historyClock, historyGapsWords, historyNetworkSummary, historySummary, historyTicks, partlyReadWords, repeatsLocally, stepWhenWords, readOutWords, bytesWords, gapsOf, hostAtStart, liveTicks, liveWindow, liveWords, memoryOfShare, networkSummary, percentOfShare, rateWords, slotCpuWords, slotLineWords, usageSummary } from "../src/app/activity-words.ts";
import { namedAfterReady } from "../src/app/box-words.ts";

const T0 = Date.UTC(2026, 9, 30, 16, 0, 0);
const at = (step: number) => T0 + step * 5000;
const words = (time: number) => `t${(time - T0) / 5000}`;

test("Live is the Monitor's last 72 readings: the last 6 min, every 5 s, with ticks every 2 minutes", () => {
  assert.equal(liveWords(5000), "the last 6 min, every 5 s");
  const window = liveWindow([{ timestamp: at(71), cpuPercent: 1, memoryPercent: 1, networkRxBytesPerSecond: 0, networkTxBytesPerSecond: 0 }], 5000);
  assert.deepEqual(window, { from: at(0), to: at(71) });
  assert.deepEqual(liveTicks(window).map((tick) => tick.at), [T0, T0 + 120_000, T0 + 240_000]);
});

test("a gap is a reading that failed or came late, with when it began and ended", () => {
  const times = [at(0), at(1), at(2), at(3), at(9), at(10)];
  assert.deepEqual(gapsOf(times, [1, null, null, 4, 5, 6], 5000), [
    { from: at(0), to: at(3) },
    { from: at(3), to: at(9) },
  ]);
  assert.deepEqual(gapsOf([at(0), at(1)], [1, null], 5000), [{ from: at(0), to: at(1) }]);
});

test("the chart's summary says CPU's mean and highest with when, memory's last, and the gaps", () => {
  const times = [at(0), at(1), at(2), at(3)];
  const summary = usageSummary("the last 6 min, every 5 s", times, { cpu: { label: "CPU", values: [10, 80, null, 30] }, memory: { label: "Memory", values: [50, 52, null, 58] } }, gapsOf(times, [10, 80, null, 30], 5000), words);
  assert.equal(summary, "Over the last 6 min, every 5 s: CPU averaged 40%, highest 80% at t1; memory last 58%. No reading from t1 to t3.");
  assert.equal(usageSummary("x", [], { cpu: { label: "CPU", values: [] }, memory: { label: "Memory", values: [] } }, [], words), "No readings over x.");
  assert.match(usageSummary("x", [at(0)], { cpu: { label: "This slot's CPU", values: [40] }, memory: { label: "This slot's memory", values: [20] } }, [], words), /This slot's CPU averaged 40%.*This slot's memory last 20%/);
});

test("G17: the network chart says download's and upload's averages and highest points, and its gaps", () => {
  const times = [at(0), at(1), at(2)];
  const down = [800 * 1024, 2.1 * 1024 ** 2, null];
  const up = [96 * 1024, 96 * 1024, null];
  assert.equal(networkSummary("the last 6 min, every 5 s", times, down, up, gapsOf(times, down, 5000), words), "Over the last 6 min, every 5 s: download averaged 1.4 MB/s, highest 2.1 MB/s at t1; upload averaged 96 KB/s, highest 96 KB/s at t0. No reading from t1 to t2.");
  assert.equal(networkSummary("x", [], [], [], [], words), "No network readings over x.");
});

test("a point read out names the time and each line, or why there is none", () => {
  const series = [
    { key: "cpu", label: "CPU", color: "", values: [20, null], format: (value: number) => `${value}%` },
    { key: "memory", label: "Memory", color: "", values: [50, null], format: (value: number) => `${value}%` },
  ];
  assert.equal(readOutWords(series, 0, "4:10:05 PM", "No reading"), "4:10:05 PM: CPU 20%, Memory 50%");
  assert.equal(readOutWords(series, 1, "4:10:10 PM", "No reading"), "4:10:10 PM: No reading");
});

test("a slot's numbers are against its share: 2 of 4 cores is 50%", () => {
  const share = { slots: 3, cores: 4, memoryBytes: 12 * 1024 ** 3 };
  assert.equal(percentOfShare(2, share), 50);
  assert.equal(percentOfShare(null, share), null);
  assert.equal(memoryOfShare(1.5 * 1024 ** 3, share), 12.5);
  assert.equal(slotCpuWords(1.6, share, "mac-1", 12), "1.6 of its 4 cores, of mac-1's 12");
  assert.equal(slotCpuWords(null, { ...share, cores: 2.4 }, "mac-1", 12), "Its share: 2.4 of mac-1's 12 cores");
  assert.match(slotLineWords("mac-1", 3), /^This slot is a macOS user on mac-1, one of up to 3 slots there\. .* never make this slot busy\.$/);
  assert.equal(hostAtStart("mac-1"), "mac-1", "a Mac's own name keeps its case");
  assert.equal(hostAtStart("its Namespace Mac"), "Its Namespace Mac");
  assert.match(slotLineWords("its Namespace Mac", 4), /^This slot is a macOS user on its Namespace Mac, one of up to 4 slots there\. .*: its Namespace Mac's cores and memory divided by 4\. Its Namespace Mac's numbers are every slot's together/);
});

test("sizes and rates read as a person reads them", () => {
  assert.equal(bytesWords(12 * 1024 ** 3), "12 GiB");
  assert.equal(bytesWords(1.5 * 1024 ** 3), "1.5 GiB");
  assert.equal(bytesWords(0), "0 B");
  assert.equal(rateWords(820 * 1024), "820 KB/s");
  assert.equal(rateWords(2.1 * 1024 ** 2), "2.1 MB/s");
});

test("a claimed spare that keeps its name is named after it was ready, so that step is not in its time to ready", () => {
  assert.equal(namedAfterReady({ spare: 300, total: 300, relabel: 400 }), 400);
  assert.equal(namedAfterReady({ spare: 300, total: 700, relabel: 400 }), null);
  assert.equal(namedAfterReady({ spare: 300, spareResume: 900, total: 1200, relabel: 400 }), 400);
  assert.equal(namedAfterReady({ warm: 300, clone: 1100, total: 3600 }), null);
});

test("history's ticks are every 15 minutes over 1 h, every 6 hours over 24 h and at each midnight over 7 d, in local time", () => {
  const hour = historyTicks("1h", { from: T0 - 59 * 60_000, to: T0 });
  assert.ok(hour.length >= 4 && hour.length <= 5);
  assert.ok(hour.every((tick) => new Date(tick.at).getMinutes() % 15 === 0));
  const day = historyTicks("24h", { from: T0 - 24 * 3_600_000, to: T0 });
  assert.equal(day.length, 4);
  assert.ok(day.every((tick) => new Date(tick.at).getHours() % 6 === 0 && new Date(tick.at).getMinutes() === 0));
  const week = historyTicks("7d", { from: T0 - 7 * 24 * 3_600_000, to: T0 });
  assert.ok(week.length >= 6 && week.length <= 7);
  assert.ok(week.every((tick) => new Date(tick.at).getHours() === 0));
});

test("history's summary gives CPU's mean weighted by the time read, its busiest minute and the step it was in, memory's last, and each gap with why", () => {
  const gaps = [{ from: at(2), to: at(3), kind: "stopped" as const }, { from: at(3), to: at(9), kind: "not-read" as const }];
  const step = (index: number) => `between s${index} and e${index}`;
  const summary = historySummary("the last 24 hours, by 10 minutes", { cpu: { label: "CPU", values: [10, 30, null, null], weights: [600, 600, 0, 0], peaks: [12, 78, null, null] }, memory: { label: "Memory", values: [50, 58, null, null], weights: [600, 600, 0, 0] } }, gaps, step, words, at(5));
  assert.equal(summary, "Over the last 24 hours, by 10 minutes: CPU averaged 20%, busiest minute 78% between s1 and e1; memory last 58%. Stopped from t2 to t3; Not read from t3.");
  assert.equal(historyGapsWords([], words, at(5)), "");
  assert.equal(historyGapsWords([{ from: at(1), to: at(2), kind: "starting" }], () => "yesterday at 10:48 AM", at(5)), " Starting for under a minute from yesterday at 10:48 AM.", "a gap that starts and ends in the same minute is not said as from 10:48 to 10:48");
  assert.equal(GAP_WORDS["no-reading"], "No reading");
  assert.equal(partlyReadWords("7d", 1200), "partly read, 20 min of the hour");
});

test("history's mean counts each step by the time it was read: one minute at 100% and an hour at 0% is about 2%, not 50%", () => {
  const lines = { cpu: { label: "CPU", values: [100, 0], weights: [60, 3600] }, memory: { label: "Memory", values: [40, 40], weights: [60, 3600] } };
  const summary = historySummary("the last 7 days, by the hour", lines, [], (index) => `in hour ${index}`, words, at(5));
  assert.equal(summary, "Over the last 7 days, by the hour: CPU averaged 2%, highest 100% in hour 0; memory last 40%.");
  const network = historyNetworkSummary("the last 7 days, by the hour", [1024 * 1024, 0], [0, 0], [60, 3600], [], (index) => `in hour ${index}`, words, at(5));
  assert.match(network, /^Over the last 7 days, by the hour: download averaged 17 KB\/s, highest 1 MB\/s in hour 0; upload averaged 0 B\/s/);
  assert.equal(historyClock(T0 + 600_000, "UTC"), new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }).format(T0 + 600_000));
  assert.equal(stepWhenWords("24h", T0, 600_000, () => "Today 16:00", "UTC"), `between Today 16:00 and ${historyClock(T0 + 600_000, "UTC")}`);
  assert.equal(stepWhenWords("1h", T0, 60_000, () => "4:00 PM"), "at 4:00 PM");
});

test("on the night clocks go back, 1 h's ticks come every 15 minutes of elapsed time, and the repeated hour's times say which they are", () => {
  const zone = "America/New_York";
  const from = Date.UTC(2026, 10, 1, 5, 0);
  const ticks = historyTicks("1h", { from, to: from + 2 * 3_600_000 }, zone);
  assert.deepEqual(ticks.map((tick) => tick.at), Array.from({ length: 9 }, (_, index) => from + index * 15 * 60_000), "none of the repeated quarter hours goes missing");
  assert.equal(new Set(ticks.map((tick) => tick.words)).size, 9, "1:00 before the change and 1:00 after it are told apart");
  assert.ok(repeatsLocally(from, zone) && repeatsLocally(from + 3_600_000, zone));
  assert.ok(!repeatsLocally(from + 2 * 3_600_000, zone), "2:00, after it, happens once");
  assert.notEqual(historyClock(from, zone), historyClock(from + 3_600_000, zone));
  const day = historyTicks("24h", { from: Date.UTC(2026, 10, 1, 0, 0), to: Date.UTC(2026, 10, 2, 0, 0) }, zone);
  const local = (time: number) => Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: zone }).format(time));
  assert.deepEqual(day.map((tick) => local(tick.at)), [0, 6, 12, 18], "24 h's ticks stay on 0, 6, 12 and 18 local, across the change");
  const week = historyTicks("7d", { from: Date.UTC(2026, 9, 28, 12, 0), to: Date.UTC(2026, 10, 4, 12, 0) }, zone);
  assert.equal(week.length, 7);
  assert.ok(week.every((tick) => local(tick.at) === 0), "7 d's ticks are each local midnight");
});

test("the read-out names the busiest minute only where it is 5 points or more above the mean, and adds a step's note", () => {
  const series = [{ key: "cpu", label: "CPU", color: "", values: [30, 30], peaks: [34, 35], format: (value: number) => `${value}%` }];
  assert.equal(readOutWords(series, 0, "t0", "No reading"), "t0: CPU 30%");
  assert.equal(readOutWords(series, 1, "t1", "No reading", "partly read"), "t1: CPU 30%, busiest minute 35%; partly read");
});
