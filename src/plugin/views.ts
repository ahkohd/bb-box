// What the panel, the tools and the CLI show about boxes: plain JSON views
// for the panel, and short text for agents. Nothing here holds a credential.

import { providerName } from "../core/provider-name.ts";
import { boxForm, driverLabel, type BackendStatus, type OfferedKind } from "../backends/index.ts";
import { kindAliases, kindInfo } from "../backends/kinds.ts";
import type { Arch, BoxForm, BoxSize, Capacity, DoctorReport, GuestOs, Windowing } from "../backends/types.ts";
import type { Versions } from "../backends/versions.ts";
import type { TryResult } from "./bakes.ts";
import type { Draft } from "../core/draft.ts";
import type { ImageView } from "./images.ts";
import { extraFeatures, stopWords, type BoxImage, type BoxRecord, type BoxState, type EnrolState } from "../core/boxes.ts";
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
  /** Why it last stopped without bb-box's request, and what bb-box did, in words (#406). */
  readonly stopped: string | null;
  readonly createdAt: number;
  readonly readyAt: number | null;
  readonly os: string;
  readonly arch: string;
  readonly gpu: boolean;
  readonly requires: readonly string[];
  /** Features beyond what the kind promises. */
  readonly extras: readonly string[];
  /** The box has Docker (041), whichever ID it was asked for by. A Linux box without it says "No Docker". */
  readonly docker: boolean;
  readonly desktop: boolean;
  /** The desktop the viewer shows, when the box has one. */
  readonly display: { readonly protocol: DisplayProtocol; readonly resizable: boolean; readonly clipboard: "commands" | null; readonly refresh: "viewer" | null } | null;
  /** Who controls the desktop's input, when the box has one. */
  readonly control: ControlView | null;
  readonly computerUse: boolean;
  /** A person can open a terminal in it: it is ready and runs commands. Every command transport gives a shell on a PTY on BB's server. */
  readonly terminal: boolean;
  readonly address: string | null;
  readonly facts: readonly { readonly label: string; readonly value: string }[];
  readonly timings: Readonly<Record<string, number>>;
  readonly enrol: { readonly state: EnrolState; readonly hostId: string | null; readonly error: string | null };
  /** Its kind's boxes join BB as machines when enrolment is on; Windows boxes cannot yet. */
  readonly enrols: boolean;
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
    stopped: stopWords(box) || null,
    createdAt: box.createdAt,
    readyAt: box.readyAt,
    os: box.capabilities.os,
    arch: box.capabilities.arch,
    gpu: box.capabilities.gpu,
    requires: box.requires,
    extras: extraFeatures(box),
    docker: box.capabilities.features.includes("docker"),
    desktop: box.capabilities.displays.length > 0,
    display: display ? { protocol: display.protocol, resizable: display.resizable, clipboard: display.clipboard ?? null, refresh: display.refresh ?? null } : null,
    control: display ? control : null,
    computerUse: box.capabilities.computerUse !== null,
    terminal: box.state === "ready" && box.capabilities.command !== null,
    address: box.guest?.address ?? null,
    facts: box.guest?.facts ?? [],
    timings: box.timings,
    enrol: box.enrol,
    enrols: box.capabilities.enrol,
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
  /** The windowing system a desktop runs (048); the New box form offers X11 or Wayland when a system has both. */
  readonly windowing: Windowing;
  /** The features every offer promises, such as "docker". */
  readonly features: readonly string[];
  /** A box of it can become a BB machine, so a thread can run on it. */
  readonly enrol: boolean;
  /** Its spare boxes (032). */
  readonly spares: SparesView;
  /** The box user can become root on every backend that offers the kind, on none, or, when null, on some. */
  readonly admin: boolean | null;
  /** Its boxes have Docker on every backend that offers the kind, on none, or, when null, on some (041). */
  readonly docker: boolean | null;
  /** The backends that offer it, in the order acquire tries them. */
  readonly backends: readonly string[];
  /** What its boxes are on those backends, as badges, each once. */
  readonly forms: readonly BoxForm[];
  /** Each offer, in the order acquire tries them, for the New box form's provider rows. */
  readonly offers: readonly OfferView[];
  /** Its boxes run a computer-use driver, on every backend that offers it. */
  readonly computerUse: boolean;
}

/** One backend's offer of a kind, as the picker's pane shows it. */
export interface OfferView {
  /** The backend's ID, as boxes record it. */
  readonly backend: string;
  /** The provider's name for people and for `on` (044): "Proxmox LXC on pve1", "Docker on devpc", "Tart on 2 Macs". */
  readonly name: string;
  /** The driver's type, for the provider's glyph: "proxmox-lxc", "proxmox-qemu", "docker", "tart", "ssh-pool". */
  readonly type: string;
  /** The driver's label, as settings names the backend: "Proxmox LXC". */
  readonly label: string;
  /** Where its boxes run, by name: a node, each Mac, a Docker host. Empty for a pool and for a local Docker daemon. */
  readonly hosts: readonly string[];
  readonly form: BoxForm | null;
  /** Spare boxes of this kind ready now on this backend (032). */
  readonly ready: number;
  /** Free machines for this kind on a real backend, from its last survey; null for a virtual one or before a survey. */
  readonly free: number | null;
  /** The box user can become root, or Administrator, on this backend. */
  readonly admin: boolean;
  /** Its desktop follows the viewer's size; null for a kind without a desktop. */
  readonly resizable: boolean | null;
  /** The median total of its last cold starts on this backend, in ms; null until it has had one. */
  readonly typicalReadyMs: number | null;
  /** This offer's boxes have Docker (041). */
  readonly docker: boolean;
  /** The OS of the machine the boxes run on, for "Runs on"; null while the backend does not know it yet, which the form treats as "could be any". */
  readonly hostOs: GuestOs | null;
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
  /** Median cold-start totals, keyed "<kind>|<backend>" (the registry's `typicalReady`). */
  typical: Readonly<Record<string, number>> = {},
  /** Spares ready now, keyed "<kind>|<backend>" (the registry's `spareReadyByBackend`). */
  readyByBackend: Readonly<Record<string, number>> = {},
  /** The driver's label for a backend ID, as settings names it; the registry's, which knows the drivers in use. */
  labelOf: (backendId: string) => string = driverLabel,
): KindView[] {
  const views = new Map<string, KindView>();
  for (const { kind, backend } of offered) {
    const existing = views.get(kind.id);
    const admin = kind.capabilities.command?.admin ?? false;
    const docker = kind.capabilities.features.includes("docker");
    const form = boxForm(backend.id);
    const key = `${kind.id}|${backend.id}`;
    const type = backend.id.split(":")[0]!;
    const label = labelOf(backend.id);
    const hosts = backend.hosts ?? [];
    const offer: OfferView = {
      backend: backend.id,
      name: providerName({ label, hosts, type }),
      type,
      label,
      hosts,
      form,
      ready: readyByBackend[key] ?? 0,
      free: backend.free?.(kind.id) ?? null,
      admin,
      resizable: kind.capabilities.displays.length ? (kind.capabilities.displays[0]!.resizable ?? false) : null,
      typicalReadyMs: typical[key] ?? null,
      docker,
      hostOs: backend.hostOs ?? null,
    };
    const computerUse = kind.capabilities.computerUse !== null;
    if (existing) {
      views.set(kind.id, {
        ...existing,
        admin: existing.admin === admin ? admin : null,
        docker: existing.docker === docker ? docker : null,
        backends: [...existing.backends, backend.label],
        forms: form && !existing.forms.includes(form) ? [...existing.forms, form] : existing.forms,
        offers: [...existing.offers, offer],
        computerUse: existing.computerUse && computerUse,
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
      // The windowing system is not in a kind's capabilities; it is known by the kind's ID (048).
      windowing: kindInfo(kind.id).windowing,
      features: kind.requires,
      enrol: kind.capabilities.enrol,
      spares: { target: targets[kind.id] ?? 0, ready: spares[kind.id]?.ready ?? 0, making: spares[kind.id]?.making ?? 0 },
      admin,
      docker,
      backends: [backend.label],
      forms: form ? [form] : [],
      offers: [offer],
      computerUse,
    });
  }
  return [...views.values()];
}

export interface BackendView extends BackendStatus {
  readonly setup: { readonly guide: string; readonly scripts: readonly string[] };
}

/**
 * A provider's profile, behind the (i) on its row in the New box form: read
 * when the row's popover opens, never on every panel load.
 */
export interface ProviderProfile {
  readonly backend: string;
  /** "Proxmox LXC on pve1", as the row names it. */
  readonly name: string;
  /** The driver's description: what the technology is. */
  readonly technology: string;
  readonly nature: "virtual" | "real";
  readonly hosts: readonly string[];
  /** What the machine its boxes run on runs, or null until known. */
  readonly hostOs: GuestOs | null;
  /** The kinds it makes, in acquire order, each with what its boxes are, the usual cold start on it and spares ready. */
  readonly makes: readonly { readonly id: string; readonly label: string; readonly form: BoxForm | null; readonly typicalReadyMs: number | null; readonly ready: number }[];
  /** Boxes on it now, of every thread, in any state but gone. */
  readonly boxes: number;
  /** Room for one more box of the first kind it makes, at the default size; null when it makes nothing or did not answer. */
  readonly room: Capacity | null;
  readonly status: {
    readonly state: "off" | "active" | "misconfigured";
    /** The first thing to fix, when its settings are not valid. */
    readonly problem: string | null;
    /** The doctor's last verdict, summary and time; null before it has run. */
    readonly ok: boolean | null;
    readonly summary: string | null;
    readonly checkedAt: number | null;
  };
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
  clock: "setting the clock",
};

/** Where a box's timings name the steps of its last start. */
const START = "start.";

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
  if (box.unrequestedStop && box.state !== "ready") parts.push(stopWords(box));
  return `- ${parts.join("; ")}`;
}

const CONTROL_WORDS: Record<ControlView["owner"], string> = {
  agent: "the agent",
  human: "the user, in bb-box's panel. Leave the desktop's windows alone until they hand control back, or until they ask you to continue: then call computer_take_control",
  none: "changing hands",
};

/** Whether a kind's box user can become root, or Administrator on Windows, for kind lists. */
export function adminText({ admin, os }: Pick<KindView, "admin" | "os">): string {
  if (os === "windows") {
    if (admin === null) return "Administrator: on some of its backends; box_status says for each box.";
    return admin ? "Administrator: yes, and commands run elevated." : "Administrator: no, the box user is a standard user.";
  }
  if (admin === null) return "Root: on some of its backends, through sudo; box_status says for each box.";
  return admin ? "Root: yes, through sudo without a password." : "Root: no, the box user cannot use sudo.";
}

/** Whether a Linux kind's boxes have Docker (041), for kind lists, naming the alias that makes sure of it. Empty for another OS. */
export function dockerText({ id, docker, os }: Pick<KindView, "id" | "docker" | "os">): string {
  if (os !== "linux") return "";
  if (docker !== null) return docker ? "Docker: yes." : "Docker: no.";
  const alias = kindAliases().find((each) => each.kind === id && each.features.includes("docker"));
  return alias ? `Docker: on some of its backends. Ask for ${alias.id} to be sure of it.` : "Docker: on some of its backends; box_status says for each box.";
}

/** Whether this box's user can become root, or Administrator on Windows. */
function adminLine(capabilities: BoxRecord["capabilities"]): string | null {
  const command = capabilities.command;
  if (!command) return null;
  if (capabilities.os === "windows") return `Administrator: ${command.admin ? "yes" : "no"}`;
  return command.admin ? "Root: yes, through sudo without a password" : "Root: no, the box user cannot use sudo. box_list shows the kinds that give root";
}

/** Everything an agent may want to know about one box. */
/** A box's project's image (049): its name, and what its script did as the box started. */
export function imageWords(image: BoxImage): string {
  const what = {
    pending: "its script runs as the box starts",
    running: "running its script",
    done: `its script ran as the box started${image.seconds !== undefined ? `, in ${image.seconds} s` : ""}`,
    failed: "its script failed",
    baked: `built ${builtOn(image.build)}`,
  };
  return `${image.name}, ${what[image.state]}`;
}

/** A build's day from its ID, build.20261003-021500-3f9c: "3 October", or "ahead" when it has none. */
function builtOn(build: string | null | undefined): string {
  const match = /^build\.(\d{4})(\d{2})(\d{2})-/.exec(build ?? "");
  if (!match) return "ahead";
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return `${day.getUTCDate()} ${day.toLocaleString("en-GB", { month: "long", timeZone: "UTC" })}`;
}

export function boxDetail(box: BoxRecord, control?: ControlView): string {
  const capabilities = box.capabilities;
  const lines = [
    `Box ${box.name} (${box.id})`,
    `State: ${STATE_WORDS[box.state]}${box.error ? `. ${box.error}` : ""}`,
    ...(box.unrequestedStop ? [`Last unrequested stop: ${stopWords(box)}`] : []),
    `Kind: ${box.kindLabel} (${box.kind}) from ${box.backendLabel}`,
    ...(sizeWords(box) ? [`Size: ${sizeWords(box)}`] : []),
    `System: ${capabilities.os} ${capabilities.arch}${capabilities.gpu ? " with a GPU" : ""}${capabilities.displays.length ? ", with a desktop" : ""}`,
  ];
  const admin = adminLine(capabilities);
  if (admin) lines.push(admin);
  // The Docker line says what a "docker" feature would.
  const linux = capabilities.os === "linux";
  if (linux) lines.push(capabilities.features.includes("docker") ? "Docker: yes" : "Docker: no. box_list says which kinds have it");
  const other = (features: readonly string[]) => (linux ? features.filter((feature) => feature !== "docker") : features);
  const requires = other(box.requires);
  if (requires.length) lines.push(`Features: ${requires.join(", ")}`);
  const extras = other(extraFeatures(box));
  if (extras.length) lines.push(`Also has: ${extras.join(", ")}`);
  if (box.image) lines.push(`Image: ${imageWords(box.image)}`);
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
  const words = (timings: [string, number][]) => timings.map(([step, ms]) => `${STEP_WORDS[step] ?? step} ${seconds(ms)}`).join(", ");
  const timings = Object.entries(box.timings);
  const acquire = timings.filter(([step]) => !step.startsWith(START));
  if (acquire.length) lines.push(`Timings: ${words(acquire)}`);
  const start = timings.flatMap(([step, ms]): [string, number][] => (step.startsWith(START) ? [[step.slice(START.length), ms]] : []));
  if (start.length) lines.push(`Last start: ${words(start)}`);
  return lines.join("\n");
}

/** "Next:" hints end every tool result, so an agent always knows what it can do. */
/**
 * Why a box that an acquire stopped waiting for is not ready yet. A restart
 * ends the wait, and the next bb-box goes on acquiring the box (#533).
 */
export function startingWords(box: BoxRecord, restarted: boolean): string {
  return restarted ? `bb-box restarted, as for an update, before box ${box.name} was ready. It goes on starting once bb-box is back, within a minute.` : `Box ${box.name} is still starting.`;
}

export function next(...hints: string[]): string {
  return hints.length ? `\n\nNext: ${hints.join(" ")}` : "";
}

/** An image's line in bb box images list: its build and age, why it is due, and its last rebuild. */
export function imageLine(view: ImageView): string {
  const record = view.build.record;
  const age = record ? Math.floor((Date.now() - Date.parse(record.built)) / 86_400_000) : null;
  const built = record ? `${record.build}, ${age === 0 ? "built today" : `${age} days old`}` : "no record";
  const last = view.last ? `; last rebuild ${new Date(view.last.at).toISOString().slice(0, 10)} ${view.last.ok ? "passed" : view.last.waiting ? `waited: ${view.last.reason}` : `failed: ${view.last.reason}`}` : "";
  return `${view.name} (${view.build.kind}): ${built}; ${view.due ? `due, as ${view.due}` : "not due"}${last}.`;
}

/**
 * A project's image, for a choice of image (049): New box, BB's new-thread
 * inputs, and box_list. A box can also choose "standard", bb-box's own
 * image, which is in no list.
 */
export interface ImageOptionView {
  readonly name: string;
  /** The kinds it covers: a choice shows where one of them is chosen. */
  readonly kinds: readonly string[];
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  /** One of its projects is the thread's: its boxes of these kinds get it unless they choose another. */
  readonly mine: boolean;
  /** Where it is built ahead, so a box there starts from the build; elsewhere its script runs as the box starts. */
  readonly builds: readonly { readonly kind: string; readonly backend: string; readonly build: string | null; /** ISO 8601. */ readonly built: string }[];
  /** Its spares (#440), where it has any: a box claims a ready one at once. */
  readonly spares: readonly { readonly kind: string; readonly backend: string; readonly ready: number; readonly making: number }[];
}

/**
 * A kind's images, for box_list (049): this project's first, the default,
 * then standard, then others with their projects; nothing when no image
 * covers the kind.
 */
export function imagesText(images: readonly ImageOptionView[], kind: string): string {
  const covering = images.filter((image) => image.kinds.includes(kind));
  if (!covering.length) return "";
  const words = (image: ImageOptionView) => {
    const spare = (backend: string) => {
      const count = image.spares.find((one) => one.kind === kind && one.backend === backend);
      return count?.ready ? " with a spare ready" : count?.making ? " with a spare being made" : "";
    };
    const built = image.builds.filter((build) => build.kind === kind).map((build) => `${build.backend}${spare(build.backend)}`);
    return `${image.name}${image.mine ? " (this project's, the default)" : ` (${image.projects.map((project) => project.name).join(", ")})`}${built.length ? `, built ahead on ${built.join(", ")}` : ""}`;
  };
  const mine = covering.filter((image) => image.mine);
  const others = covering.filter((image) => !image.mine);
  return ` Images: ${[...mine.map(words), mine.length ? "standard" : "standard (the default)", ...others.map(words)].join("; ")}.`;
}

/** A draft of a project image's script (049): the files it used, what it left to the agent, the script and the check. */
export function draftText(draft: Draft): string {
  return [
    draft.used.length ? `Drafted from ${draft.used.join(", ")}.` : "No file it reads was given, so the draft is a template to fill in.",
    ...(draft.gaps.length ? ["", "Left to you, also commented at the top of the script:", ...draft.gaps.map((gap) => `- ${gap}`)] : []),
    "",
    "`.bb/box-setup.sh`:",
    "```bash",
    draft.script.trimEnd(),
    "```",
    "",
    "`.bb/box-check.sh`:",
    "```bash",
    draft.check.trimEnd(),
    "```",
  ].join("\n");
}

/** What a try of a script did (049): a line per check, then the build's last lines. */
export function tryText(result: TryResult): string {
  // The first check is the script's own, in the build box; a later one failing means the script passed, and says which to fix.
  const where = `on ${result.backend} (${result.kind}), in ${result.seconds} s, as a build runs it`;
  const failed = result.checks.find((check) => !check.ok);
  const head = result.reason
    ? `The try on ${result.backend} (${result.kind}) did not finish, after ${result.seconds} s: ${result.reason}`
    : result.ok || !failed
      ? `The script ${result.ok ? "passed" : "failed"} ${where}.`
      : failed === result.checks[0]
        ? `The script failed ${where}.`
        : `The script passed ${where}, but this failed: ${failed.name}.`;
  const checks = result.checks.map((check) => `- ${check.name}: ${check.ok ? "ok" : "FAIL"}, ${check.detail}`);
  const lines = result.output.length ? ["", `The build's last ${result.output.length} lines:`, ...result.output] : [];
  const kept = result.kept ? [result.kept.box ? `Kept box ${result.kept.box} (${result.kept.detail}).` : `Kept no box: ${result.kept.detail}`] : [];
  return [head, ...checks, ...kept, ...lines].join("\n");
}

/** What a rebuild of the standard Linux images would take, a line per tool, its architectures together where they agree. */
export function versionsText(versions: Versions): string {
  const lines = new Map<string, { words: string; arches: string[]; why: string }>();
  for (const tool of versions.tools) {
    const words = tool.version === tool.pinned ? `${tool.name} ${tool.version}, as pinned` : `${tool.name} ${tool.version}, pinned ${tool.pinned}`;
    const why = tool.kept ?? (tool.version === tool.pinned ? "nothing newer" : tool.source);
    const key = `${words}\n${why}`;
    const line = lines.get(key) ?? { words, arches: [], why };
    line.arches.push(tool.arch);
    lines.set(key, line);
  }
  const { aptSnapshot } = versions;
  return [
    versions.following
      ? "A rebuild of the standard Linux images now takes, against this bb-box's pins:"
      : "With --pinned, a rebuild of the standard Linux images takes this bb-box's pins alone:",
    ...[...lines.values()].map(({ words, arches, why }) => `  ${words}, for ${arches.join(" and ")}: ${why}.`),
    `  apt snapshot ${aptSnapshot.version}${aptSnapshot.version === aptSnapshot.pinned ? ", as pinned" : `, pinned ${aptSnapshot.pinned}`}.`,
  ].join("\n");
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
