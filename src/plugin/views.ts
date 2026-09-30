// What the panel, the tools and the CLI show about boxes: plain JSON views
// for the panel, and short text for agents. Nothing here holds a credential.

import type { BackendStatus, OfferedKind } from "../backends/index.ts";
import type { DoctorReport } from "../backends/types.ts";
import { extraFeatures, type BoxRecord, type BoxState, type EnrolState } from "../core/boxes.ts";

export interface BoxView {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly kindLabel: string;
  readonly backendLabel: string;
  readonly nature: "virtual" | "real";
  readonly role: "box" | "machine";
  readonly state: BoxState;
  readonly error: string | null;
  readonly createdAt: number;
  readonly readyAt: number | null;
  readonly os: string;
  readonly arch: string;
  readonly gpu: boolean;
  readonly requires: readonly string[];
  /** Features beyond what the kind promises. */
  readonly extras: readonly string[];
  readonly desktop: boolean;
  readonly computerUse: boolean;
  readonly address: string | null;
  readonly facts: readonly { readonly label: string; readonly value: string }[];
  readonly timings: Readonly<Record<string, number>>;
  readonly enrol: { readonly state: EnrolState; readonly hostId: string | null; readonly error: string | null };
  readonly canStopStart: boolean;
}

export function boxView(box: BoxRecord, canStopStart: boolean): BoxView {
  return {
    id: box.id,
    name: box.name,
    kind: box.kind,
    kindLabel: box.kindLabel,
    backendLabel: box.backendLabel,
    nature: box.nature,
    role: box.role,
    state: box.state,
    error: box.error,
    createdAt: box.createdAt,
    readyAt: box.readyAt,
    os: box.capabilities.os,
    arch: box.capabilities.arch,
    gpu: box.capabilities.gpu,
    requires: box.requires,
    extras: extraFeatures(box),
    desktop: box.capabilities.displays.length > 0,
    computerUse: box.capabilities.computerUse !== null,
    address: box.guest?.address ?? null,
    facts: box.guest?.facts ?? [],
    timings: box.timings,
    enrol: box.enrol,
    canStopStart,
  };
}

export interface KindView {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly size: string;
  readonly gpu: boolean;
  readonly desktop: boolean;
  /** The backends that offer it, in the order acquire tries them. */
  readonly backends: readonly string[];
}

export function kindViews(offered: readonly OfferedKind[]): KindView[] {
  const views = new Map<string, KindView>();
  for (const { kind, backend } of offered) {
    const existing = views.get(kind.id);
    if (existing) {
      views.set(kind.id, { ...existing, backends: [...existing.backends, backend.label] });
      continue;
    }
    views.set(kind.id, {
      id: kind.id,
      label: kind.label,
      description: kind.description,
      size: kind.size,
      gpu: kind.capabilities.gpu,
      desktop: kind.capabilities.displays.length > 0,
      backends: [backend.label],
    });
  }
  return [...views.values()];
}

export interface BackendView extends BackendStatus {
  readonly setup: { readonly guide: string; readonly scripts: readonly string[] };
}

export interface DoctorView {
  readonly ok: boolean;
  readonly sections: readonly {
    readonly title: string;
    readonly report: DoctorReport;
  }[];
}

const STATE_WORDS: Record<BoxState, string> = {
  acquiring: "being acquired",
  starting: "starting",
  ready: "ready",
  stopping: "stopping",
  stopped: "stopped",
  failed: "failed",
  gone: "gone",
  releasing: "being released",
};

/** Words for timings bb-box adds after the start-up steps. */
const STEP_WORDS: Readonly<Record<string, string>> = { enrol: "BB enrolment" };

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** One line per box, for lists. */
export function boxLine(box: BoxRecord): string {
  const parts = [`${box.name}: ${box.kindLabel} (${box.kind}), ${STATE_WORDS[box.state]}`];
  if (box.state === "ready" && box.timings.total !== undefined) parts.push(`ready in ${seconds(box.timings.total)}`);
  if (box.enrol.state === "enrolled") parts.push(`enrolled as a BB machine${box.timings.enrol !== undefined ? ` in ${seconds(box.timings.enrol)}` : ""}`);
  if (box.error) parts.push(box.error);
  return `- ${parts.join("; ")}`;
}

/** Everything an agent may want to know about one box. */
export function boxDetail(box: BoxRecord): string {
  const capabilities = box.capabilities;
  const lines = [
    `Box ${box.name} (${box.id})`,
    `State: ${STATE_WORDS[box.state]}${box.error ? `. ${box.error}` : ""}`,
    `Kind: ${box.kindLabel} (${box.kind}) from ${box.backendLabel}`,
    `System: ${capabilities.os} ${capabilities.arch}${capabilities.gpu ? " with a GPU" : ""}${capabilities.displays.length ? ", with a desktop" : ""}`,
  ];
  if (box.requires.length) lines.push(`Features: ${box.requires.join(", ")}`);
  const extras = extraFeatures(box);
  if (extras.length) lines.push(`Also has: ${extras.join(", ")}`);
  if (box.guest?.address) lines.push(`Address: ${box.guest.address}`);
  for (const fact of box.guest?.facts ?? []) lines.push(`${fact.label}: ${fact.value}`);
  const enrol: Record<EnrolState, string> = {
    off: "not enrolled",
    enrolling: "being added, which takes a few seconds. box_run waits for it, so commands have the thread's access",
    enrolled: "enrolled",
    failed: `enrolment failed${box.enrol.error ? `: ${box.enrol.error}` : ""}`,
  };
  lines.push(`BB machine: ${enrol[box.enrol.state]}`);
  const timings = Object.entries(box.timings);
  if (timings.length) lines.push(`Timings: ${timings.map(([step, ms]) => `${STEP_WORDS[step] ?? step} ${seconds(ms)}`).join(", ")}`);
  return lines.join("\n");
}

/** "Next:" hints end every tool result, so an agent always knows what it can do. */
export function next(...hints: string[]): string {
  return hints.length ? `\n\nNext: ${hints.join(" ")}` : "";
}

export function doctorText(view: DoctorView): string {
  const lines: string[] = [];
  for (const { title, report } of view.sections) {
    lines.push(`${title}: ${report.summary}`);
    for (const check of report.checks) {
      lines.push(`  [${check.status}] ${check.name}: ${check.detail}`);
      if (check.fix && check.status !== "ok") lines.push(`        Fix: ${check.fix}`);
    }
    for (const note of report.notes) lines.push(`  Note: ${note}`);
  }
  if (!view.sections.length) lines.push("No backend is on. Turn one on in bb-box's settings.");
  return lines.join("\n");
}
