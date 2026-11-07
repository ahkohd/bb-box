import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const folder = process.argv[2] ?? join(process.env.HOME, "live-results", "measure");
const runs = readdirSync(folder)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(join(folder, name), "utf8")));
const STREAM_NAMES = { voxl: "voxl", selkies: "Selkies", rfb: "noVNC on Xtigervnc" };
const STREAMER_PROCESS = { voxl: "voxl", selkies: "selkies", rfb: "X server" };
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const span = (values, digits = 0) => {
  const round = (value) => (digits ? value.toFixed(digits) : String(Math.round(value)));
  const [low, high] = [Math.min(...values), Math.max(...values)];
  return low === high ? round(low) : `${round(median(values))} (${round(low)} to ${round(high)})`;
};

for (const link of ["lan", "slow"]) {
  for (const workload of ["scroll", "animation"]) {
    const rows = ["voxl", "selkies", "rfb"]
      .map((stream) => ({ stream, group: runs.filter((run) => run.stream === stream && run.workload === workload && run.link === link) }))
      .filter(({ group }) => group.length);
    if (!rows.length) continue;
    console.log(`\n${workload === "scroll" ? "Scroll" : "1080p animation"}, ${link === "lan" ? "LAN" : "10 Mbit/s and 40 ms round trip"}, ${rows[0].group.length} runs of 20 s each:\n`);
    console.log("| Stream | Frames/s | Worst second | Latency p50, ms | Latency p99, ms | Longest gap, ms | Mbit/s | Streamer, cores | X server, cores |");
    console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const { stream, group } of rows) {
      const streamer = group.map((run) => run.cpuCores[STREAMER_PROCESS[stream]] ?? 0);
      const xServer = group.map((run) => run.cpuCores["X server"] ?? 0);
      console.log(
        `| ${STREAM_NAMES[stream]} | ${span(group.map((run) => run.framesPerSecond), 1)} | ${Math.min(...group.map((run) => run.worstSecond))} | ${span(group.map((run) => run.latencyMs.p50))} | ${span(group.map((run) => run.latencyMs.p99))} | ${Math.max(...group.map((run) => run.longestGapMs))} | ${span(group.map((run) => run.megabitsPerSecond), 1)} | ${stream === "rfb" ? "in the X server" : span(streamer, 2)} | ${span(xServer, 2)} |`,
      );
    }
  }
}
const idle = runs.filter((run) => run.workload === "idle");
if (idle.length) {
  console.log("\nIdle, one viewer watching a still screen, 15 s:\n");
  console.log("| Stream | Streamer, cores | X server, cores | Mbit/s |");
  console.log("| --- | --- | --- | --- |");
  for (const run of idle) console.log(`| ${STREAM_NAMES[run.stream]} | ${run.stream === "rfb" ? "in the X server" : (run.cpuCores[STREAMER_PROCESS[run.stream]] ?? 0).toFixed(2)} | ${(run.cpuCores["X server"] ?? 0).toFixed(2)} | ${run.megabitsPerSecond} |`);
}
