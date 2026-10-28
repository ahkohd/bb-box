import type { Health } from "./snapshot.ts";
import type { Stall } from "./container.ts";

export const STALL_LIMITS = { cpu: { warning: 25, critical: 50 }, memory: { warning: 10, critical: 25 } } as const;

export interface HealthReadings {
  readonly cpuPercent: number | null;
  readonly memoryPercent: number;
  readonly diskPercent: number | null;
  readonly load: { readonly fiveMinutes: number; readonly cores: number } | null;
  readonly cpuStall?: Stall | null;
  readonly memoryStall?: Stall | null;
}

export function assessHealth(readings: HealthReadings): Health {
  const issues: Health["issues"] = [];
  const addThresholdIssue = (label: string, value: number) => {
    if (value >= 95) issues.push({ severity: "critical", label, message: `${label} is at ${value.toFixed(1)}%.` });
    else if (value >= 85) issues.push({ severity: "warning", label, message: `${label} is at ${value.toFixed(1)}%.` });
  };
  if (readings.cpuPercent !== null) addThresholdIssue("CPU", readings.cpuPercent);
  addThresholdIssue("Memory", readings.memoryPercent);
  if (readings.diskPercent !== null) addThresholdIssue("Disk", readings.diskPercent);
  if (readings.load) {
    const { fiveMinutes, cores } = readings.load;
    const normalizedLoad = fiveMinutes / cores;
    const message = `Five-minute load is ${fiveMinutes.toFixed(2)} across ${cores} cores.`;
    if (normalizedLoad >= 1.5) issues.push({ severity: "critical", label: "System load", message });
    else if (normalizedLoad >= 1) issues.push({ severity: "warning", label: "System load", message });
  }
  const addStallIssue = (label: string, waitedFor: string, stall: Stall | null | undefined, limits: { warning: number; critical: number }) => {
    const minute = stall?.[1];
    if (minute === undefined) return;
    const message = `Tasks waited for ${waitedFor} ${minute.toFixed(1)}% of the last minute.`;
    if (minute >= limits.critical) issues.push({ severity: "critical", label, message });
    else if (minute >= limits.warning) issues.push({ severity: "warning", label, message });
  };
  addStallIssue("CPU pressure", "CPU", readings.cpuStall, STALL_LIMITS.cpu);
  addStallIssue("Memory pressure", "memory", readings.memoryStall, STALL_LIMITS.memory);
  return {
    status: issues.some((issue) => issue.severity === "critical") ? "critical" : issues.length > 0 ? "warning" : "healthy",
    issues,
  };
}
