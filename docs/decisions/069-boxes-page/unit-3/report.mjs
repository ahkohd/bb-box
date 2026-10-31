import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RUN = process.argv[2] ?? join(process.env.HOME, "run");
const HOUR = 3_600_000;
const lines = (name) => (existsSync(join(RUN, name)) ? readFileSync(join(RUN, name), "utf8").trim().split("\n").filter(Boolean) : []);
const plan = JSON.parse(readFileSync(join(RUN, "plan.json"), "utf8"));
const boxes = JSON.parse(readFileSync(join(RUN, "boxes.json"), "utf8"));
const start = plan.startedAt;
const samples = lines("samples.jsonl").map((line) => JSON.parse(line)).filter((sample) => sample.at > start + 30_000 && sample.server);
const events = lines("events.jsonl").map((line) => JSON.parse(line));
const hourOf = (at) => Math.floor((at - start) / HOUR);
const eventAt = (name) => events.find((event) => event.event === name)?.at ?? null;

function cpuSeconds(sample) {
  return sample.server.own + sample.server.children + sample.ssh.seconds;
}

function window(from, to) {
  const inside = samples.filter((sample) => sample.at >= from && sample.at <= to);
  if (inside.length < 2) return null;
  const first = inside[0];
  const last = inside.at(-1);
  if (first.server.pid !== last.server.pid) return null;
  const seconds = (last.at - first.at) / 1000;
  const containers = {};
  for (const [name, usage] of Object.entries(last.containers)) {
    const before = first.containers[name];
    if (typeof usage === "number" && typeof before === "number" && usage >= before) containers[name] = ((usage - before) / 1e6 / seconds) * 100;
  }
  return {
    from: first.at,
    to: last.at,
    seconds,
    serverPercent: ((cpuSeconds(last) - cpuSeconds(first)) / seconds) * 100,
    ownPercent: ((last.server.own - first.server.own) / seconds) * 100,
    childrenPercent: ((last.server.children - first.server.children) / seconds) * 100,
    sshPercent: ((last.ssh.seconds - first.ssh.seconds) / seconds) * 100,
    dockerPercent: ((last.docker - first.docker) / seconds) * 100,
    rssMiB: inside.map((sample) => sample.server.rssBytes / 2 ** 20),
    containers,
  };
}

const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
const fixed = (value, digits = 3) => (value === null || value === undefined ? "–" : value.toFixed(digits));

const hours = [];
for (let hour = 0; hour < 26; hour++) {
  const result = window(start + hour * HOUR, start + (hour + 1) * HOUR);
  if (result) hours.push({ hour, ...result });
}

const role = (name) => boxes.find((box) => box.role === name);
const docker = (enrolled) => boxes.filter((box) => box.backend === "docker" && box.enrolled === enrolled && !box.role);
const containerMean = (result, list) => mean(list.map((box) => result.containers[box.container]).filter((value) => typeof value === "number"));

console.log("## Hours\n");
console.log("| Hour from the start | bb-box's server, % of one core (own, children, ssh) | Docker daemon % | Server RSS MiB (min to max) | Idle routed Docker box % | Idle Docker BB machine % |");
console.log("| --- | --- | --- | --- | --- | --- |");
for (const row of hours) {
  console.log(`| ${row.hour} (${new Date(row.from).toISOString().slice(11, 16)}) | ${fixed(row.serverPercent)} (${fixed(row.ownPercent)}, ${fixed(row.childrenPercent)}, ${fixed(row.sshPercent)}) | ${fixed(row.dockerPercent)} | ${Math.round(Math.min(...row.rssMiB))} to ${Math.round(Math.max(...row.rssMiB))} | ${fixed(containerMean(row, docker(false)), 4)} | ${fixed(containerMean(row, docker(true)), 4)} |`);
}

const execs = lines("docker-execs.log").map((line) => {
  const [nanos, name] = line.split(" ");
  return { at: Number(nanos) / 1e6, name };
});
const firstHour = execs.filter((exec) => exec.at >= start && exec.at < start + HOUR);
const perBox = new Map();
for (const exec of firstHour) perBox.set(exec.name, (perBox.get(exec.name) ?? 0) + 1);
console.log("\n## Docker execs in hour 0, per container\n");
for (const box of boxes.filter((each) => each.backend === "docker")) console.log(`- ${box.name} (${box.enrolled ? "BB machine" : "route"}): ${perBox.get(box.container) ?? 0}`);

console.log("\n## Freshness\n");
const excluded = (box, at) => {
  const stopped = role("stopped");
  const cut = role("cut");
  const stopAt = eventAt("stop a box for an hour");
  const startAt = eventAt("start it again");
  const cutAt = eventAt("cut a box's host off for an hour");
  const joinAt = eventAt("join it again");
  if (box.id === stopped?.id && stopAt && at >= stopAt && at < (startAt ?? Infinity) + 3 * 60_000) return true;
  if (box.id === cut?.id && cutAt && at >= cutAt && at < (joinAt ?? Infinity) + 20 * 60_000) return true;
  const off = [["the Monitor off for 10 minutes", "the Monitor on again"], ["history off for 3 minutes", "history on again, by hand (the run script skipped its step, named as an earlier one)"], ["history off, for the A/B of cost", "history on again"], ["history off, five pages open", "history on, five pages open"], ["the Monitor off again, at a quiet time, for 10 minutes", "the Monitor on again, after the quiet 10 minutes"]];
  for (const [from, to] of off) {
    const offAt = eventAt(from);
    const onAt = events.filter((event) => event.event === to && event.at > (offAt ?? Infinity))[0]?.at;
    if (offAt && at >= offAt && at < (onAt ?? Infinity) + 3 * 60_000) return true;
  }
  for (const restart of events.filter((event) => event.event === "bb-box restarted half way" || event.event.startsWith("bb-box installed again"))) {
    if (at >= restart.at && at < restart.at + 3 * 60_000) return true;
  }
  return false;
};
let checked = 0;
const stale = [];
for (const sample of samples) {
  if (!sample.history?.newest) continue;
  const newest = new Map(sample.history.newest.map((row) => [row.key, row.at * 1000]));
  for (const box of boxes) {
    if (excluded(box, sample.at)) continue;
    checked++;
    const at = newest.get(box.id);
    if (!at || sample.at - at >= 120_000) stale.push({ box: box.name, at: new Date(sample.at).toISOString(), age: at ? Math.round((sample.at - at) / 1000) : null });
  }
}
console.log(`${checked - stale.length} of ${checked} box-minutes had a point under 2 minutes old (${fixed(((checked - stale.length) / Math.max(1, checked)) * 100, 2)}%).`);
for (const each of stale.slice(0, 30)) console.log(`- ${each.box} at ${each.at}: newest ${each.age === null ? "none" : `${each.age} s`} old`);

console.log("\n## Storage\n");
const files = samples.filter((sample) => sample.file);
if (files.length) console.log(`box-history.db ${files.at(-1).file.db} bytes at the end; write-ahead log at most ${Math.max(...files.map((sample) => sample.file.wal))} bytes; rows ${JSON.stringify(files.at(-1).history?.rows ?? {})}.`);

console.log("\n## Events\n");
for (const event of events) console.log(`- ${new Date(event.at).toISOString().slice(11, 19)} (minute ${event.minute ?? "–"}): ${event.event}${event.error ? `, failed: ${event.error}` : ""}`);

const tallied = existsSync(join(RUN, "history-report.json")) ? JSON.parse(readFileSync(join(RUN, "history-report.json"), "utf8")) : null;
if (tallied) {
  console.log("\n## Coverage, from box history's own tallies\n");
  console.log("| Hour (UTC) | Due | Taken | Skipped | Failed | Not tried, not answering | Coverage | Mean reading ms | Slowest ms | Most at once |");
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  let due = 0;
  let taken = 0;
  for (const hour of tallied.hours) {
    due += hour.due;
    taken += hour.taken;
    console.log(`| ${new Date(hour.hour).toISOString().slice(0, 13)}:00 | ${hour.due} | ${hour.taken} | ${hour.skipped} | ${hour.failed} | ${hour.unanswered} | ${fixed((hour.taken / Math.max(1, hour.due)) * 100, 2)}% | ${Math.round(hour.readingMs / Math.max(1, hour.taken + hour.failed))} | ${hour.slowestMs} | ${hour.workers} |`);
  }
  console.log(`\nIn all, ${taken} of ${due} due readings taken on time: ${fixed((taken / Math.max(1, due)) * 100, 3)}%.`);
}
