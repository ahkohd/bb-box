// The words and tone of a box's status line, as the panel shows them. Pure,
// so the tests can check every state.

import type { BoxView } from "../plugin/views.ts";
import { seconds, type Tone } from "./common.tsx";

export interface StatusItem {
  readonly text: string;
  /** Foreground for what matters, warning or destructive for what is wrong; muted otherwise. */
  readonly tone?: "fg" | "warn" | "danger";
}

export interface Status {
  readonly tone: Tone;
  /** The first item is the state. */
  readonly items: readonly StatusItem[];
}

/** Words for timings whose names alone do not say what they are. */
export const STEP_WORDS: Readonly<Record<string, string>> = { template: "waiting for the template", enrol: "BB enrolment", total: "total" };

/** A desktop's display mode from its facts: "GPU", "CPU", or null when it has no desktop. */
export function displayWord(box: BoxView): string | null {
  if (!box.desktop) return null;
  const mode = box.facts.find((fact) => fact.label.toLowerCase() === "display mode")?.value.toLowerCase();
  if (mode) return mode.includes("gpu") ? "GPU" : mode.includes("cpu") ? "CPU" : mode.toUpperCase();
  return box.gpu ? "GPU" : "CPU";
}

/** Who holds the desktop's input, as a status item, or null while the agent does. */
export function controlWord(box: BoxView, myViewers: ReadonlySet<string>): StatusItem | null {
  if (!box.control || box.control.owner === "agent") return null;
  if (box.control.owner === "none") return { text: "Control is changing hands" };
  return { text: box.control.holder && myViewers.has(box.control.holder) ? "You have control" : "Another viewer has control", tone: "fg" };
}

export function statusOf(box: BoxView, now: number, myViewers: ReadonlySet<string> = new Set()): Status {
  const rest: StatusItem[] = [];
  const display = displayWord(box);
  if (display) rest.push({ text: display });
  const control = controlWord(box, myViewers);
  if (control) rest.push(control);

  switch (box.state) {
    case "acquiring":
    case "starting":
      return { tone: "busy", items: [{ text: "Starting" }, { text: seconds(Math.max(0, now - box.createdAt)) }, ...rest] };
    case "stopping":
      return { tone: "busy", items: [{ text: "Stopping…" }, ...rest] };
    case "releasing":
      return { tone: "busy", items: [{ text: "Releasing…" }] };
    case "stopped":
      return { tone: "off", items: [{ text: "Stopped" }, ...rest] };
    case "failed":
      return { tone: "bad", items: [{ text: "Failed", tone: "danger" }] };
    case "gone":
      return { tone: "bad", items: [{ text: "Gone" }, { text: "deleted outside bb-box" }] };
    case "ready": {
      const items: StatusItem[] = [{ text: box.timings.total !== undefined ? `Ready in ${seconds(box.timings.total)}` : "Ready" }];
      switch (box.enrol.state) {
        case "enrolling":
          items.push({ text: "Joining BB…" });
          break;
        case "enrolled":
          items.push({ text: box.timings.enrol !== undefined ? `BB machine in ${seconds(box.timings.enrol)}` : "BB machine" });
          break;
        case "failed":
          items.push({ text: "Could not join BB", tone: "warn" });
          break;
        default:
          break;
      }
      return { tone: "ok", items: [...items, ...rest] };
    }
  }
}

/** The box's timings as words, in the order they happened, for its details. */
export function timingWords(box: BoxView): string {
  return Object.entries(box.timings)
    .filter(([step]) => !step.startsWith("release."))
    .map(([step, ms]) => `${STEP_WORDS[step] ?? step} ${seconds(ms)}`)
    .join(" · ");
}

/** What the BB machine row of the details says. */
export function enrolWords(box: BoxView): string {
  switch (box.enrol.state) {
    case "enrolled":
      return "enrolled";
    case "enrolling":
      return "joining, which takes a few seconds";
    case "failed":
      return `could not join: ${box.enrol.error ?? "no reason given"}`;
    default:
      return "off";
  }
}
