// What the panel, the tools and the CLI show about boxes: plain JSON views
// for the panel, and short text for agents. Nothing here holds a credential.

import { boxForm, type BackendStatus, type OfferedKind } from "../backends/index.ts";
import type { Arch, BoxForm, BoxSize, DoctorReport, GuestOs } from "../backends/types.ts";
import { extraFeatures, type BoxRecord, type BoxState, type EnrolState } from "../core/boxes.ts";
import type { ControlView } from "../core/control.ts";
import type { Problem } from "../core/document.ts";
import type { MovedCopy } from "../core/move.ts";
import { PRESETS, describeSize, kindSizes, type Preset, type SizeChange, type SizeChanges } from "../core/sizes.ts";
import type { ConfigState } from "./configuration.ts";
import type { ThreadOnBox } from "./contract.ts";
import type { DisplayProtocol } from "../transports/types.ts";

export interface BoxView {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly kindLabel: string;
  readonly backendLabel: string;
  readonly nature: "virtual" | "real";
  /** What the box is, as a badge: an LXC or Docker container, a VM or a physical machine. Null when its backend's driver is gone. */
  readonly form: BoxForm | null;
  readonly role: "box" | "machine";
  /** In words: what the box has, or else what it was asked to be. Null when neither is known. */
  readonly size: string | null;
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
  /** The desktop the viewer shows, when the box has one. */
  readonly display: { readonly protocol: DisplayProtocol; readonly resizable: boolean } | null;
  /** Who controls the desktop's input, when the box has one. */
  readonly control: ControlView | null;
  readonly computerUse: boolean;
  /** A person can open a terminal in it: it is ready and runs commands. Every command transport gives a shell on a PTY on BB's server. */
  readonly terminal: boolean;
  readonly address: string | null;
  readonly facts: readonly { readonly label: string; readonly value: string }[];
  readonly timings: Readonly<Record<string, number>>;
  readonly enrol: { readonly state: EnrolState; readonly hostId: string | null; readonly error: string | null };
  readonly canStopStart: boolean;
}

/** What the box has, read from its guest, or else the size it was asked to be. */
export function boxSize(box: BoxRecord): BoxSize | null {
  return box.guest?.size ?? box.size ?? null;
}

function sizeWords(box: BoxRecord): string | null {
  const size = boxSize(box);
  return size ? describeSize(size) : null;
}

export function boxView(box: BoxRecord, canStopStart: boolean, control: ControlView): BoxView {
  const [display] = box.capabilities.displays;
  return {
    id: box.id,
    name: box.name,
    kind: box.kind,
    kindLabel: box.kindLabel,
    backendLabel: box.backendLabel,
    nature: box.nature,
    form: boxForm(box.backend),
    role: box.role,
    size: sizeWords(box),
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
    display: display ? { protocol: display.protocol, resizable: display.resizable } : null,
    control: display ? control : null,
    computerUse: box.capabilities.computerUse !== null,
    terminal: box.state === "ready" && box.capabilities.command !== null,
    address: box.guest?.address ?? null,
    facts: box.guest?.facts ?? [],
    timings: box.timings,
    enrol: box.enrol,
    canStopStart,
  };
}

export interface SizeView {
  readonly cores: number;
  readonly memoryGiB: number;
  /** Null: the base disk. */
  readonly diskGiB: number | null;
  readonly words: string;
}

function sizeView(size: BoxSize): SizeView {
  return { cores: size.cores, memoryGiB: size.memoryMiB / 1024, diskGiB: size.diskGiB, words: describeSize(size) };
}

export interface KindView {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** The default preset in words. */
  readonly size: string;
  /** Small, medium and large (028). */
  readonly presets: readonly ({ readonly name: Preset } & SizeView)[];
  readonly defaultPreset: Preset;
  /** The largest custom size. */
  readonly largest: SizeView;
  readonly gpu: boolean;
  readonly desktop: boolean;
  /** The OS, which the panel names the kind by; badges say the rest. */
  readonly os: GuestOs;
  /** x86_64 unless the kind is arm64 (040), which the panel shows as a badge. */
  readonly arch: Arch;
  /** The features every offer promises, such as "docker". */
  readonly features: readonly string[];
  /** A box of it can become a BB machine, so a thread can run on it. */
  readonly enrol: boolean;
  /** Its spare boxes (032). */
  readonly spares: SparesView;
  /** The box user can become root on every backend that offers the kind, on none, or, when null, on some. */
  readonly admin: boolean | null;
  /** The backends that offer it, in the order acquire tries them. */
  readonly backends: readonly string[];
  /** What its boxes are on those backends, as badges, each once. */
  readonly forms: readonly BoxForm[];
}

/** A kind's spare boxes (032): how many it keeps, and how many are ready or being made. */
export interface SparesView {
  readonly target: number;
  readonly ready: number;
  readonly making: number;
}

export function kindViews(
  offered: readonly OfferedKind[],
  changes: SizeChanges,
  spares: Readonly<Record<string, { readonly ready: number; readonly making: number }>> = {},
  targets: Readonly<Record<string, number>> = {},
): KindView[] {
  const views = new Map<string, KindView>();
  for (const { kind, backend } of offered) {
    const existing = views.get(kind.id);
    const admin = kind.capabilities.command?.admin ?? false;
    const form = boxForm(backend.id);
    if (existing) {
      views.set(kind.id, {
        ...existing,
        admin: existing.admin === admin ? admin : null,
        backends: [...existing.backends, backend.label],
        forms: form && !existing.forms.includes(form) ? [...existing.forms, form] : existing.forms,
      });
      continue;
    }
    const sizes = kindSizes(kind.id, changes);
    views.set(kind.id, {
      id: kind.id,
      label: kind.label,
      description: kind.description,
      size: describeSize(sizes.presets[sizes.default]),
      presets: PRESETS.map((name) => ({ name, ...sizeView(sizes.presets[name]) })),
      defaultPreset: sizes.default,
      largest: sizeView(sizes.largest),
      gpu: kind.capabilities.gpu,
      desktop: kind.capabilities.displays.length > 0,
      os: kind.capabilities.os,
      arch: kind.capabilities.arch,
      features: kind.requires,
      enrol: kind.capabilities.enrol,
      spares: { target: targets[kind.id] ?? 0, ready: spares[kind.id]?.ready ?? 0, making: spares[kind.id]?.making ?? 0 },
      admin,
      backends: [backend.label],
      forms: form ? [form] : [],
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

/** Words for timings whose names alone do not say what they are. */
const STEP_WORDS: Readonly<Record<string, string>> = {
  template: "waiting for the template",
  enrol: "BB enrolment",
  spare: "claiming a spare",
  relabel: "naming it for its owner",
};

/** Under 0.1 s in milliseconds, which a claim of a spare takes (#186). */
function seconds(ms: number): string {
  return ms < 100 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** One line per box, for lists. */
export function boxLine(box: BoxRecord): string {
  const size = sizeWords(box);
  const parts = [`${box.name}: ${box.kindLabel} (${box.kind}${box.capabilities.gpu ? ", GPU" : ""}${size ? `, ${size}` : ""}), ${STATE_WORDS[box.state]}`];
  if (box.state === "ready" && box.timings.total !== undefined) parts.push(`ready in ${seconds(box.timings.total)}`);
  if (box.role === "machine") parts.push("this thread's machine");
  else if (box.enrol.state === "enrolled") parts.push(`enrolled as a BB machine${box.timings.enrol !== undefined ? ` in ${seconds(box.timings.enrol)}` : ""}`);
  if (box.error) parts.push(box.error);
  return `- ${parts.join("; ")}`;
}

const CONTROL_WORDS: Record<ControlView["owner"], string> = {
  agent: "the agent",
  human: "the user, in bb-box's panel. Leave the desktop's windows alone until they hand control back, or until they ask you to continue: then call computer_take_control",
  none: "changing hands",
};

/** Whether a kind's box user can become root, for kind lists. */
export function adminText(admin: boolean | null): string {
  if (admin === null) return "Root: on some of its backends, through sudo; box_status says for each box.";
  return admin ? "Root: yes, through sudo without a password." : "Root: no, the box user cannot use sudo.";
}

/** Whether this box's user can become root, or Administrator on Windows. */
function adminLine(capabilities: BoxRecord["capabilities"]): string | null {
  const command = capabilities.command;
  if (!command) return null;
  if (capabilities.os === "windows") return `Administrator: ${command.admin ? "yes" : "no"}`;
  return command.admin ? "Root: yes, through sudo without a password" : "Root: no, the box user cannot use sudo. box_list shows the kinds that give root";
}

/** Everything an agent may want to know about one box. */
export function boxDetail(box: BoxRecord, control?: ControlView): string {
  const capabilities = box.capabilities;
  const lines = [
    `Box ${box.name} (${box.id})`,
    `State: ${STATE_WORDS[box.state]}${box.error ? `. ${box.error}` : ""}`,
    `Kind: ${box.kindLabel} (${box.kind}) from ${box.backendLabel}`,
    ...(sizeWords(box) ? [`Size: ${sizeWords(box)}`] : []),
    `System: ${capabilities.os} ${capabilities.arch}${capabilities.gpu ? " with a GPU" : ""}${capabilities.displays.length ? ", with a desktop" : ""}`,
  ];
  const admin = adminLine(capabilities);
  if (admin) lines.push(admin);
  if (box.requires.length) lines.push(`Features: ${box.requires.join(", ")}`);
  const extras = extraFeatures(box);
  if (extras.length) lines.push(`Also has: ${extras.join(", ")}`);
  if (box.guest?.address) lines.push(`Address: ${box.guest.address}`);
  for (const fact of box.guest?.facts ?? []) lines.push(`${fact.label}: ${fact.value}`);
  if (control && capabilities.displays.length) lines.push(`Desktop control: ${CONTROL_WORDS[control.owner]}`);
  const enrol: Record<EnrolState, string> = {
    off:
      box.restoredAt && capabilities.enrol
        ? "not enrolled since bb-box restored its lost record. It enrols again once it runs and answers, if bb-box enrols boxes"
        : "not enrolled",
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
  if (!view.sections.length) lines.push("No backend is on. Turn one on in bb-box's settings, or with bb box config apply.");
  return lines.join("\n");
}

/** One problem per line, with its field's path. */
export function problemsText(problems: readonly Problem[]): string {
  return problems.map((problem) => `  ${problem.path || "(the file)"}: ${problem.message}`).join("\n");
}

function fieldValue(value: unknown): string {
  if (typeof value === "object" && value !== null && "set" in value) return (value as { set: boolean }).set ? "set" : "not set";
  const text = String(value);
  return text.includes("\n") ? `${text.split("\n").length} lines` : JSON.stringify(value);
}

function changeWords(change: SizeChange | undefined): string | null {
  if (!change) return null;
  const parts = [
    change.cores !== undefined ? `${change.cores} cores` : null,
    change.memoryMiB !== undefined ? `${change.memoryMiB / 1024} GiB memory` : null,
    change.diskGiB !== undefined ? (change.diskGiB === null ? "the base disk" : `${change.diskGiB} GiB disk`) : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/** The configuration in words, for bb box config show. Secrets show only as set or not. */
export function configText(state: ConfigState): string {
  const { document } = state;
  const lines = [`bb-box's configuration, revision ${state.revision}.`, ""];
  if (!document.backends.length) lines.push("Backends: none. Add one on bb-box's settings page, or with bb box config apply.");
  else lines.push("Backends, in the order they are tried:");
  for (const backend of document.backends) {
    const status = state.backends.find((candidate) => candidate.id === backend.id);
    const words = { active: "ready", off: "off", misconfigured: "needs setting up" }[status?.state ?? "misconfigured"];
    const offers = status?.kinds.length ? `, offers ${status.kinds.join(", ")}` : "";
    const boxes = status?.boxes ? `, ${status.boxes} ${status.boxes === 1 ? "box" : "boxes"}` : "";
    lines.push(`- ${backend.id} (${status?.label ?? backend.type}): ${backend.enabled ? "on" : "off"}, ${words}${offers}${boxes}.`);
    for (const [key, value] of Object.entries(backend.fields)) lines.push(`    ${key}: ${fieldValue(value)}`);
    const warm = Object.entries(backend.warm ?? {});
    if (warm.length) lines.push(`    warm: ${warm.map(([kind, count]) => `${count} ${kind}`).join(", ")}`);
    for (const host of backend.hosts ?? []) {
      lines.push(`    host ${host.name}: ${host.enabled ? "on" : "off"}${Object.entries(host.fields).map(([key, value]) => `, ${key} ${fieldValue(value)}`).join("")}`);
    }
  }
  lines.push("");
  const kinds = Object.entries(document.kinds);
  if (!kinds.length) lines.push("Kinds: all on, at bb-box's own sizes.");
  else {
    lines.push("Kinds changed from bb-box's own (any other is on, at bb-box's sizes):");
    for (const [id, kind] of kinds) {
      const parts = [
        kind.enabled === false ? "off" : null,
        ...PRESETS.map((preset) => {
          const words = changeWords(kind.presets?.[preset]);
          return words ? `${preset} ${words}` : null;
        }),
        kind.default ? `default ${kind.default}` : null,
        changeWords(kind.largest) ? `largest ${changeWords(kind.largest)}` : null,
      ].filter(Boolean);
      lines.push(`- ${id}: ${parts.join("; ") || "as shipped"}`);
    }
  }
  lines.push("");
  const general = { ...state.defaults.general, ...document.general };
  lines.push(
    `Boxes per thread: ${general.boxesPerThread || "no limit"}. Enrol boxes as BB machines: ${general.enrol ? "yes" : "no"}. Default kind: ${general.defaultKind}.`,
  );
  if (state.problems.length) lines.push("", "Problems:", problemsText(state.problems));
  if (state.migrated) {
    lines.push(
      "",
      `bb-box keeps a copy of the BB settings it moved into this configuration on ${new Date(state.migrated.at).toISOString()}. bb box config migrated shows it, and --remove removes it.`,
    );
  }
  return lines.join("\n");
}

/** The copy of BB's settings the move kept, for bb box config migrated. */
export function movedText(copy: MovedCopy): string {
  const lines = [
    `bb-box ${copy.version} moved these BB settings into its configuration on ${new Date(copy.at).toISOString()}. Secrets show only whether they were set.`,
    "",
    ...Object.entries(copy.values).map(([key, value]) => `${key}: ${fieldValue(value)}`),
  ];
  if (copy.notes.length) lines.push("", "Not carried over as they were:", ...copy.notes.map((note) => `- ${note}`));
  lines.push("", "bb box config migrated --json prints the values in full. --remove removes the copy.");
  return lines.join("\n");
}

/** What a release or stop did to the idle threads on a box: "" when there were none. */
export function idleWords(threads: readonly ThreadOnBox[], stopped: boolean): string {
  if (!threads.length) return "";
  const one = threads.length === 1;
  return stopped
    ? ` ${threadsWords(threads).replace(/^t/, "T")}, idle on it, ${one ? "has" : "have"} no machine until it starts again.`
    : ` ${threadsWords(threads).replace(/^t/, "T")}, idle on it, lost ${one ? "its" : "their"} machine. Archive ${one ? "it" : "them"} if ${one ? "it is" : "they are"} done.`;
}

/** "thread Fix the build (thr_1)", or several. */
export function threadsWords(threads: readonly ThreadOnBox[]): string {
  const each = threads.map((thread) => `${thread.title ? `"${thread.title}" ` : ""}(${thread.id})`);
  return `${threads.length === 1 ? "thread" : "threads"} ${each.join(", ")}`;
}
