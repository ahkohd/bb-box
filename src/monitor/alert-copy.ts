import type { PressureEvent } from "./pressure.ts";

export const TEST_ALERT_COPY = {
  title: "Test notification",
  description: "This is a preview. No overload was triggered.",
};

export function pressureAlertCopy(notice: Pick<PressureEvent, "metric" | "type" | "threshold" | "value">) {
  const name = notice.metric === "cpu" ? "CPU" : "Memory";
  if (notice.type === "recovery") return {
    title: `${name} usage back to normal`,
    description: `${name} usage dropped to ${Number(notice.value.toFixed(1))}%.`,
  };
  return {
    title: `High ${notice.metric === "cpu" ? "CPU" : "memory"} usage`,
    description: `${name} usage stayed at ${notice.threshold}% or higher for at least one minute.`,
  };
}
