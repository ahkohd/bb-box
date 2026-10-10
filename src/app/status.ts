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
export const STEP_WORDS: Readonly<Record<string, string>> = {
  template: "waiting for the template",
  enrol: "BB enrolment",
  total: "total",
  spare: "claiming a spare",
  spareResume: "resuming it",
  spareReconnect: "BB machine reconnecting",
  relabel: "naming it for its owner",
  clock: "setting the clock",
};

/** A warning when a GPU desktop's display runs on the CPU, from its facts; null otherwise, since the row's badge says what the kind has. */
export function displayWord(box: BoxView): StatusItem | null {
  if (!box.desktop || !box.gpu) return null;
  const mode = box.facts.find((fact) => fact.label.toLowerCase() === "display mode")?.value.toLowerCase();
  return mode?.includes("cpu") ? { text: "Display on the CPU", tone: "warn" } : null;
}

/** Who holds the desktop's input, as a status item, or null while the agent does. */
export function controlWord(box: BoxView, myViewers: ReadonlySet<string>): StatusItem | null {
  if (!box.control || box.control.owner === "agent") return null;
  if (box.control.owner === "none") return { text: "Control is changing hands" };
  return { text: box.control.holder && myViewers.has(box.control.holder) ? "You have control" : "Another viewer has control", tone: "fg" };
}

/** "4 cores, 8 GiB memory, 32 GiB disk" as "4 cores · 8 GiB · 32 GiB", for a status line. */
export function compactSize(words: string): string {
  return words
    .split(", ")
    .map((part) => part.replace(/ memory$/, "").replace(/ disk$/, ""))
    .join(" · ");
}

/**
 * What the status line says of an enrolled box's BB machine: how long it took
 * to join BB, or for a spare that waited stopped, how long after the claim BB
 * showed it connected again with the thread's access (#539). A claimed spare
 * that ran has neither, and says "BB machine".
 */
function machineWords(box: BoxView): string {
  if (box.role === "machine") return "This thread's machine";
  const ms = box.timings.enrol ?? box.timings.spareReconnect;
  return ms !== undefined ? `BB machine in ${seconds(ms)}` : "BB machine";
}

/**
 * A box's status line: the state first, then what to act on (a desktop's
 * display on the CPU, who has control, a failed join), then the BB machine's
 * timing and the size. A narrow row cuts the line from its end, and the
 * details say the timing and size too.
 */
export function statusOf(box: BoxView, now: number, myViewers: ReadonlySet<string> = new Set()): Status {
  const alerts: StatusItem[] = [];
  const display = displayWord(box);
  if (display) alerts.push(display);
  const control = controlWord(box, myViewers);
  if (control) alerts.push(control);
  const size: StatusItem[] = box.size ? [{ text: compactSize(box.size) }] : [];

  switch (box.state) {
    case "acquiring":
    case "starting":
      return { tone: "busy", items: [{ text: "Starting" }, { text: seconds(Math.max(0, now - box.createdAt)) }, ...alerts, ...size] };
    case "stopping":
      return { tone: "busy", items: [{ text: "Stopping…" }, ...alerts, ...size] };
    case "releasing":
      return { tone: "busy", items: [{ text: "Releasing…" }] };
    case "stopped":
      return { tone: "off", items: [{ text: "Stopped" }, ...alerts, ...size] };
    case "failed":
      return { tone: "bad", items: [{ text: "Failed", tone: "danger" }] };
    case "gone":
      return { tone: "bad", items: [{ text: "Gone" }, { text: "deleted outside bb-box" }] };
    case "ready": {
      const state: StatusItem = { text: box.timings.total !== undefined ? `Ready in ${seconds(box.timings.total)}` : "Ready" };
      switch (box.enrol.state) {
        case "enrolling":
          return { tone: "ok", items: [state, ...alerts, { text: "Joining BB…" }, ...size] };
        case "enrolled":
          return { tone: "ok", items: [state, ...alerts, { text: machineWords(box) }, ...size] };
        case "failed":
          return { tone: "ok", items: [state, { text: "Could not join BB", tone: "warn" }, ...alerts, ...size] };
        default:
          return { tone: "ok", items: [state, ...alerts, ...size] };
      }
    }
  }
}

function stepWords(timings: [string, number][]): string {
  // A time keeps to its unit and to the word before it, so a narrow row never starts a line with "s" or a lone time.
  return timings.map(([step, ms]) => `${STEP_WORDS[step] ?? step}\u00a0${seconds(ms).replace(" ", "\u00a0")}`).join(" · ");
}

/** The box's acquire timings as words, in the order they happened, for its details. */
export function timingWords(box: BoxView): string {
  return stepWords(Object.entries(box.timings).filter(([step]) => !step.startsWith("release.") && !step.startsWith("start.")));
}

/** The timings of the box's last start as words, in the order they happened. */
export function startWords(box: BoxView): string {
  return stepWords(Object.entries(box.timings).flatMap(([step, ms]): [string, number][] => (step.startsWith("start.") ? [[step.slice("start.".length), ms]] : [])));
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
      return box.enrols ? "off" : "not for this kind";
  }
}
