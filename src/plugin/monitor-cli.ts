import { cliCommand, type BbPluginApi, type PluginCliResult } from "@get-bb/plugin-sdk";
import { PRESSURE_CHANNEL } from "../monitor/pressure.ts";
import type { MonitorSnapshot } from "../monitor/snapshot.ts";
import { MONITOR_OFF_WORDS, type Monitor } from "./monitor.ts";
import type { BoxHistoryApp, HistoryReport } from "./box-history.ts";

const jsonOption = { json: { type: "boolean", description: "Print JSON." } } as const;

function out(text: string): PluginCliResult {
  return { exitCode: 0, stdout: `${text}\n` };
}

export function monitorSnapshotText(snapshot: MonitorSnapshot): string {
  const { cpu } = snapshot;
  const stall = cpu.stallPercent;
  const load = cpu.loadAverage
    ? `Load: ${cpu.loadAverage.map((value) => value.toFixed(2)).join(" / ")}`
    : `Load: not shown, as this is a container and its load average is its host's${stall ? `. CPU pressure: ${stall.map((value) => `${value.toFixed(1)}%`).join(" / ")} over 10 s, 1 and 5 min` : ""}`;
  return [
    `CPU: ${cpu.usagePercent === null ? "sampling" : `${cpu.usagePercent.toFixed(1)}%`} (${cpu.cores} cores)`,
    load,
    `Memory: ${snapshot.memory.usagePercent.toFixed(1)}% used`,
    `Disk: ${snapshot.disk ? `${snapshot.disk.usagePercent.toFixed(1)}% used` : "unavailable"}`,
    snapshot.processes.available ? `Processes: ${snapshot.processes.total} total, ${snapshot.processes.running} running` : "Processes: unavailable",
    `Updated: ${snapshot.timestamp}`,
  ].join("\n");
}

const monitorOff = (): PluginCliResult => ({ exitCode: 1, stderr: `${MONITOR_OFF_WORDS}\n` });

function ago(at: number | null, now: number): string {
  if (at === null) return "no point yet";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  return seconds < 120 ? `newest point ${seconds} s ago` : `newest point ${Math.round(seconds / 60)} min ago`;
}

export function historyReportText(report: HistoryReport, words: string, now: number): string {
  const hours = report.hours.map((hour) => `${new Date(hour.hour).toISOString().slice(0, 13)}:00Z  due ${hour.due}, taken ${hour.taken}, skipped ${hour.skipped}, failed ${hour.failed}, not tried ${hour.unanswered}; readings took ${hour.taken + hour.failed ? Math.round(hour.readingMs / (hour.taken + hour.failed)) : 0} ms on average, ${hour.slowestMs} ms at most; up to ${hour.workers} at once`);
  const boxes = report.newest.map((box) => `${box.name} (${box.box}): ${ago(box.at, now)}`);
  return [
    words,
    report.full ?? null,
    report.usedBytes === null ? null : `box-history.db: ${(report.usedBytes / 1024 / 1024).toFixed(2)} MB used.`,
    report.paused.length ? `Not read until they answer: ${report.paused.join(", ")}.` : null,
    hours.length ? ["By the hour:", ...hours].join("\n") : "Nothing tallied yet.",
    boxes.length ? ["Boxes read:", ...boxes].join("\n") : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function monitorCommands(bb: BbPluginApi, monitor: Monitor, history?: BoxHistoryApp) {
  return {
    "monitor snapshot": cliCommand({
      summary: "Show BB's server's CPU, load, memory, disk and processes, as the Monitor reads them. --json gives the whole reading, with its recent history.",
      options: jsonOption,
      async run({ options }) {
        if (!monitor.config().enabled) return monitorOff();
        const snapshot = await monitor.server();
        return options.json ? { exitCode: 0, stdout: `${JSON.stringify(snapshot)}\n` } : out(monitorSnapshotText(snapshot));
      },
    }),
    "monitor health": cliCommand({
      summary: "Show the pressure on BB's server. Exits 2 when it is critical; with --json it exits 0, and status says.",
      options: jsonOption,
      async run({ options }) {
        if (!monitor.config().enabled) return monitorOff();
        const { health } = await monitor.server();
        if (options.json) return { exitCode: 0, stdout: `${JSON.stringify(health)}\n` };
        return {
          exitCode: health.status === "critical" ? 2 : 0,
          stdout: `${health.issues.length === 0 ? "healthy — no resource pressure detected" : `${health.status}\n${health.issues.map((issue) => `- ${issue.message}`).join("\n")}`}\n`,
        };
      },
    }),
    "monitor logs": cliCommand({
      summary: "Show background monitoring's diagnostic records, oldest first: the last 100, or --limit up to 500. --json gives JSON lines.",
      options: { ...jsonOption, limit: { type: "integer", min: 1, max: 500, description: "How many of the latest records, 1 to 500. 100 by default." } },
      async run({ options }) {
        const entries = monitor.logs(options.limit ?? 100);
        if (options.json) return { exitCode: 0, stdout: entries.length ? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "" };
        return out(entries.length ? entries.map((entry) => `${new Date(entry.timestamp).toISOString()} ${entry.type} ${JSON.stringify(entry)}`).join("\n") : "No monitoring logs yet. Turn on background monitoring under Monitor in BB Box's settings to collect them.");
      },
    }),
    "monitor test-alert": cliCommand({
      summary: "Show a labelled preview of a pressure alert in every BB window that is open and visible. Needs background monitoring and its notifications on.",
      async run() {
        const config = monitor.config();
        if (!config.enabled) return monitorOff();
        if (!config.backgroundMonitoring || !config.pressureNotifications) return { exitCode: 1, stderr: "Turn on background monitoring and its notifications under Monitor in BB Box's settings first.\n" };
        bb.realtime.publish(PRESSURE_CHANNEL, { type: "test" });
        return out("Test alert sent to the BB windows that are open. Keep BB visible to see it; it is not an OS notification.");
      },
    }),
    ...(history
      ? {
          "monitor history": cliCommand({
            summary: "Show box history (069): whether it reads boxes, how many readings were due, taken, skipped and failed each hour, each box's newest point, and the room its file uses. --hours chooses how many hours, 24 by default.",
            options: { ...jsonOption, hours: { type: "integer", min: 1, max: 168, description: "How many of the last hours to tally, 1 to 168. 24 by default." } },
            async run({ options }) {
              const report = history.report(options.hours ?? 24);
              if (options.json) return { exitCode: 0, stdout: `${JSON.stringify({ ...report, words: history.stateWords() })}\n` };
              return out(historyReportText(report, history.stateWords(), Date.now()));
            },
          }),
        }
      : {}),
  };
}
