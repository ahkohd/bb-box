// The panel's RPC contract. The panel imports only its type.

import type { MachineAccessProblem, MachineSetup } from "./setup-offer.ts";
import type { RunProgress } from "./images.ts";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { machineSchema, monitorStatusSchema, snapshotSchema } from "../monitor/snapshot.ts";
import type { DockerHostView } from "./docker-hosts.ts";
import type { ApplyResult, CheckResult, ConfigState } from "./configuration.ts";
import type { BackendView, BoxView, DoctorView, ImageOptionView, KindView, OfferRoom, ProviderProfile, SizeView } from "./views.ts";
import type { ResizeWay, SizePart } from "../backends/types.ts";

export type { ApplyResult, CheckResult, ConfigState } from "./configuration.ts";

export { TERMINAL_ROUTE, terminalPath } from "./terminal-route.ts";

export interface PanelState {
  readonly boxes: readonly BoxView[];
  readonly kinds: readonly KindView[];
  readonly backends: readonly BackendView[];
  /** The desktop relay's WebSocket path on the BB server. */
  readonly desktopPath: string;
  /** The terminal's WebSocket path on the BB server. */
  readonly terminalPath: string;
  /**
   * The box whose BB machine this thread runs on, when it is not one of the
   * thread's own boxes (036): one of your machines, or another thread's box.
   */
  readonly runsOn: { readonly box: BoxView; readonly owner: "yours" | "thread"; /** The thread that holds it, when another thread's. */ readonly threadId: string | null } | null;
  /** The thread's project has no box image (049), so New box offers to ask an agent to make one. */
  readonly imageOffer: boolean;
  /** The projects' images a box of the thread can choose (049), the project's own marked `mine`. "standard" is a choice too. */
  readonly images: readonly ImageOptionView[];
  /** A BB machine whose Docker desktop image is off, which New box can build first (the setup plan's PR 4). Absent or null for none. */
  readonly desktopOnDemand?: DesktopOnDemandView | null;
  /** Why the desktop box this thread asked to build first was not made once its image was built, and when; absent or null for none. */
  readonly desktopProblem?: { readonly message: string; readonly at: number } | null;
  readonly access?: MachineAccessProblem | null;
}

export interface MachinesState {
  readonly machines: MachineEntry[];
  readonly kinds: KindView[];
  readonly desktopOnDemand?: DesktopOnDemandView | null;
  readonly desktopProblem?: { readonly message: string; readonly at: number } | null;
  readonly access?: MachineAccessProblem | null;
}

export interface DesktopOnDemandView {
  readonly hostId: string;
  readonly name: string;
  readonly kinds: readonly { readonly kind: KindView; readonly took: number | null }[];
}

/** The settings page's Rebuild now: the standard images, most needed first, and where a refresh run is. */
export interface ImagesStatus {
  readonly images: readonly {
    readonly name: string;
    readonly kind: string;
    /** Its build and age, as "build.2026-10-01, 10 days old", or "no record". */
    readonly built: string;
    /** Why it is due, or null. */
    readonly due: string | null;
    /** What its last rebuild did, as a phrase such as "Last rebuilt 2026-10-10", or null. */
    readonly last: string | null;
    readonly backend: string;
    readonly outcome: { readonly state: "refreshed" | "waiting" | "failed"; readonly at: number; readonly reason: string | null } | null;
  }[];
  readonly progress: RunProgress | null;
  /** When the run going on started, or null. */
  readonly running: number | null;
  readonly failures: readonly ImageFailure[];
}

export interface ImageFailure {
  readonly of: "standard" | "project";
  readonly name: string;
  readonly kind: string | null;
  readonly backend: string;
  readonly at: number;
  readonly reason: string;
}

/** One box's desktop or terminal, for its tab. */
export interface DesktopState {
  /** Null when the thread has no such box, for example once it is released. */
  readonly box: BoxView | null;
  readonly desktopPath: string;
  readonly terminalPath: string;
  /**
   * Whether the viewer may show the box as video (056): the general setting
   * is on and the box has a Selkies display. The viewer then picks by its
   * round trip, or as the person chose.
   */
  readonly video: boolean;
  /**
   * Whether the viewer opens the box as video, where it can, before the
   * person chooses: false where its video is shown only by choice, as on a
   * Tart Mac, which opens as VNC. Absent from older plugins, which open video.
   */
  readonly videoByDefault?: boolean;
  /** Whether the desktop is at high resolution, twice the pixels at twice the scale; null where it cannot be. Absent from older plugins. */
  readonly sharp?: boolean | null;
  /** Whether High resolution is switching on or off now: the video viewer holds its last picture until the desktop has its new size and scale. Absent from older plugins. */
  readonly switching?: boolean;
}

/** A box in any thread, or one of your machines, for the Boxes page. */
export interface BoxEntry {
  readonly threadId: string;
  readonly box: BoxView;
  /** "yours" for one of your machines (036). */
  readonly owner: "thread" | "yours";
}

/** One of your machines (036), and the threads on its BB machine. */
export interface MachineEntry {
  readonly box: BoxView;
  readonly threads: readonly ThreadOnBox[];
}

/** What a change to one box returns: the box as it is now, or why the change failed. */
export interface BoxResult {
  /** Null when the box is gone, for example once released. */
  readonly box: BoxView | null;
  readonly error: string | null;
  /** Threads working on the box's BB machine, when a release or stop left it alone for them. Ask, then send `force`. */
  readonly threads?: readonly ThreadOnBox[];
}

/** What a resize did, or with `check`, would do (061); or why it did nothing. */
export interface ResizeResult {
  /** The box as it is now; null when it could not be found. */
  readonly box: BoxView | null;
  readonly from: SizeView | null;
  readonly to: SizeView | null;
  /** Each part that changes and how, the room on the box's host, and a restart's length; null when the box has that size already, or on a refusal. */
  readonly plan: {
    /** Memory in GiB; a disk from null is the base disk. */
    readonly parts: readonly { readonly part: SizePart; readonly from: number | null; readonly to: number; readonly way: ResizeWay }[];
    readonly room: { readonly ok: boolean; readonly message: string | null };
    readonly downSeconds: number | null;
  } | null;
  /** It changed the box. */
  readonly changed: boolean;
  /** What a live change of cores means for BB's count of the machine's processors and its thread limit, or null. */
  readonly machine: string | null;
  /** Refused only because a part needs a restart, which the panel asks about, then sends `restart`. */
  readonly needsRestart: boolean;
  /** Threads working on the box, when a restart was refused for them. Ask, then send `force`. */
  readonly threads?: readonly ThreadOnBox[];
  /** The kind's presets and its largest size, for the picker; empty and null when the kind is not on offer now. */
  readonly presets: readonly ({ readonly name: string } & SizeView)[];
  readonly largest: SizeView | null;
  readonly error: string | null;
}

/** A thread that runs on a box's BB machine. */
export interface ThreadOnBox {
  readonly id: string;
  readonly title: string | null;
  /** Working now: busy, or waiting on a question to the user. An idle thread has finished. */
  readonly running: boolean;
  readonly activeAt?: number;
}

/** What starting a thread on a box returns: the new thread, or why it did not start. */
export interface ThreadResult {
  readonly threadId: string | null;
  readonly error: string | null;
}

const thread = z.object({ threadId: z.string().min(1) });
const oneBox = thread.extend({ box: z.string().min(1) });
/** The viewer ID names one viewer, such as a panel tab, of a box's desktop. */
const viewerId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
/** The longest text, in UTF-16 code units, that a paste through bb-box's own commands carries (#464). */
export const MAX_PASTE_LENGTH = 1_000_000;
const viewer = oneBox.extend({ viewer: viewerId });
const boxResult = z.custom<BoxResult>();
const forceable = oneBox.extend({ force: z.boolean().optional() });
/** One of your machines, by ID or name. */
const machineRef = z.object({ box: z.string().min(1) });
const whole = z.number().int().positive().optional();
/**
 * A preset, and any parts of a custom size (028). Leave the key out for the
 * kind's default: RPC input must be JSON, so `size: undefined` is refused.
 */
const size = z.object({ preset: z.string().min(1).optional(), cores: whole, memoryGiB: whole, diskGiB: whole });
/**
 * A resize (061): parts left out keep what the box has. `check` only plans it. `restart` allows a part that needs one, once the
 * person has said yes; `force` restarts the box though threads work on it. A person holding the desktop's control is not
 * refused: they are the one asking.
 */
const resizing = z.object({ size: size.optional(), check: z.boolean().optional(), restart: z.boolean().optional(), force: z.boolean().optional() });

/** A whole configuration document as JSON (029). bb-box checks it. */
const draft = z.unknown();
/** Where a box goes (044): one provider, or a list for the first with room among them. */
const providers = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

export const contract = defineRpcContract({
  state: { input: thread, output: z.custom<PanelState>() },
  /**
   * `on` names the provider to use, or several for the first with room among them in acquire order (044): each by its name as the form gives it, its backend ID or its one host; without it, the first with room anywhere.
   * `image` is an image's name or "standard" (049); without it, the thread's project's image for the kind.
   */
  acquire: { input: thread.extend({ kind: z.string().min(1), size: size.optional(), on: providers.optional(), image: z.string().min(1).optional(), device: z.string().min(1).optional(), dedicated: z.boolean().optional(), shared: z.boolean().optional() }), output: boxResult },
  /** The projects' images a box can choose (049), marked as the thread's or the project's own, for BB's new-thread inputs, where there is no thread yet. */
  images: { input: z.object({ threadId: z.string().min(1).optional(), projectId: z.string().min(1).optional() }), output: z.custom<ImageOptionView[]>() },
  /** Without `force`, a box a thread is working on is left alone, and the answer names the threads. */
  release: { input: forceable, output: boxResult },
  stop: { input: forceable, output: boxResult },
  start: { input: oneBox, output: boxResult },
  resize: { input: oneBox.merge(resizing), output: z.custom<ResizeResult>() },
  refresh: { input: oneBox, output: boxResult },
  forget: { input: oneBox, output: boxResult },
  desktop: { input: oneBox, output: z.custom<DesktopState>() },
  /** Puts the box's desktop at high resolution, or not: twice the pixels at twice Xfce's scale. Refused, with why, where it cannot be. */
  "desktop.sharp": { input: oneBox.extend({ on: z.boolean() }), output: z.custom<{ readonly error: string | null }>() },
  /** Answers at once: the viewer times it, for its round trip to BB's server (056). */
  ping: { input: z.null(), output: z.null() },
  /**
   * A CPU profile of BB's server process, which runs bb-box, for 1 to 60 s, summed up in lines that are logged too:
   * functions' names, files, lines and times only, and the long garbage collections meanwhile. `keep` keeps the
   * profile as a .cpuprofile file in bb-box's own folder of BB's data, the last five. `allocations` samples the heap's
   * allocations meanwhile, kept as a .heapprofile. `snapshot` writes a full heap snapshot after: it holds BB's server
   * still for as long as that takes, seconds or more on a large heap, and needs as much free memory as the heap uses,
   * or it is refused.
   */
  profile: {
    input: z.object({ seconds: z.number().int().min(1).max(60), keep: z.boolean().optional(), allocations: z.boolean().optional(), snapshot: z.boolean().optional(), collect: z.boolean().optional() }),
    output: z.object({ lines: z.array(z.string()) }),
  },
  takeControl: { input: viewer, output: boxResult },
  handBack: { input: oneBox, output: boxResult },
  /**
   * The box's clipboard text, for the viewer with control to copy: as its desktop's own input last reported it (#406),
   * or read in the box for that viewer where the desktop's server moves none (#464).
   */
  desktopClipboard: { input: oneBox.extend({ viewer: viewerId.optional() }), output: z.object({ text: z.string(), serial: z.number() }).nullable() },
  deviceClipboard: { input: viewer, output: z.object({ text: z.string().nullable(), error: z.string().nullable() }) },
  deviceScreenshot: { input: oneBox, output: z.object({ png: z.string().nullable(), model: z.string().nullable(), error: z.string().nullable() }) },
  /** Puts the viewer with control's text on the box's clipboard, where the desktop's server moves none (#464). */
  desktopPaste: { input: viewer.extend({ text: z.string().max(MAX_PASTE_LENGTH) }), output: z.null() },
  /** Every box across threads, servers as well as desktops, and your machines (036), for the Boxes page. */
  allBoxes: { input: z.null(), output: z.custom<BoxEntry[]>() },
  /** Your machines (036), oldest first, and the kinds that can be yours: on offer, and able to become BB machines. */
  "machines.list": { input: z.null(), output: z.custom<MachinesState>() },
  /** Adds one: returns once it is recorded, and the "changed" signal for "operator" follows its progress. */
  "machines.add": {
    input: z.object({ kind: z.string().min(1), size: size.optional(), name: z.string().min(1).optional(), on: providers.optional() }),
    output: boxResult,
  },
  /** Without `force`, one a thread is working on is left alone, and the answer names the threads. */
  "machines.remove": { input: machineRef.extend({ force: z.boolean().optional() }), output: boxResult },
  "machines.stop": { input: machineRef.extend({ force: z.boolean().optional() }), output: boxResult },
  "machines.start": { input: machineRef, output: boxResult },
  "machines.resize": { input: machineRef.merge(resizing), output: z.custom<ResizeResult>() },
  /** The kinds on offer now, for "New box" in BB's new-thread screen. */
  /** A provider's profile for the form's (i): data the plugin has, and one capacity call to the provider. Asked only when opened. */
  provider: { input: z.object({ backend: z.string().min(1) }), output: z.custom<ProviderProfile>() },
  rooms: { input: z.object({ kind: z.string().min(1), size: size.optional() }), output: z.custom<OfferRoom[]>() },
  kinds: { input: z.null(), output: z.custom<KindView[]>() },
  /** Starts a child thread on a box's BB machine. */
  thread: { input: oneBox.extend({ prompt: z.string().min(1) }), output: z.custom<ThreadResult>() },
  backends: { input: z.null(), output: z.custom<BackendView[]>() },
  doctor: { input: z.null(), output: z.custom<DoctorView>() },
  /** The configuration, its defaults and problems, and each backend's state (029). */
  /** The standard images bb-box rebuilds, most needed first, with why each is due (Rebuild now). Lists each backend's images. */
  "images.list": { input: z.null(), output: z.custom<{ readonly images: ImagesStatus["images"] }>() },
  /** Where a refresh run is, image by image, at once: the run going on, or the last one. */
  "images.progress": { input: z.null(), output: z.custom<Pick<ImagesStatus, "progress" | "running" | "failures">>() },
  /** Starts the night's refresh now; refused, with why, while a run goes on. */
  "images.refresh": { input: z.null(), output: z.custom<{ readonly started: boolean; readonly message: string | null }>() },
  "images.build": { input: z.object({ image: z.string().min(1) }), output: z.custom<{ readonly started: boolean; readonly message: string | null }>() },
  "config.get": { input: z.null(), output: z.custom<ConfigState>() },
  /** Problems with a draft, saving nothing. `test`, a backend's ID, also runs its doctor against the draft, within 30 s. */
  "config.check": { input: z.object({ draft, test: z.string().min(1).optional(), read: z.boolean().optional() }), output: z.custom<CheckResult>() },
  /**
   * Saves a draft whole, if `revision` is the current one, and answers once the backends are rebuilt.
   * The draft's own revision is ignored. A saved answer lists the problems saved anyway, in backends
   * that are off and have no boxes.
   */
  "config.apply": {
    input: z.object({ draft, revision: z.number().int().min(0), operation: z.string().min(1).max(200).optional(), submission: z.unknown().optional() }),
    output: z.custom<ApplyResult>(),
  },
  "config.migrated.remove": { input: z.null(), output: z.custom<{ readonly removed: boolean; readonly state: ConfigState }>() },
  /** BB machines that can host Docker boxes, with Docker as it answers through bb-box's relay (042). `recheck` asks that machine's Docker again rather than taking what it said in the last minute. */
  "docker.hosts": { input: z.object({ recheck: z.string().min(1).max(64).optional() }).nullish(), output: z.custom<{ hosts: DockerHostView[] }>() },
  /** What each BB machine offers first-run setup, the server's first, and what stands in the way of boxes joining BB, if anything. */
  "setup.offer": { input: z.null(), output: z.custom<{ machines: MachineSetup[]; access: MachineAccessProblem | null }>() },
  "setup.desktop": { input: thread.extend({ hostId: z.string().min(1), kind: z.enum(["linux-desktop-cpu", "linux-desktop-wayland-cpu"]).optional(), size: size.optional(), name: z.string().min(1).optional() }), output: z.custom<{ result: ApplyResult }>() },
  /** First-run setup: turns on Docker on BB machine `hostId` with the Linux image alone, which then builds. */
  "setup.docker": { input: z.object({ hostId: z.string().min(1) }), output: z.custom<{ result: ApplyResult; machines: MachineSetup[] }>() },
  /**
   * Turns a BB machine on or off as a Docker host: on adds a Docker backend
   * on it, last in acquire order; off removes it, or turns it off while it
   * has boxes. Answers with the configuration's answer and the list again.
   */
  "docker.host.set": { input: z.object({ hostId: z.string().min(1).max(64), enabled: z.boolean(), operation: z.string().min(1).max(200).optional() }), output: z.custom<{ result: ApplyResult; hosts: DockerHostView[] }>() },
  "monitor.state": { input: z.null(), output: z.object({ enabled: z.boolean(), backgroundMonitoring: z.boolean(), pressureNotifications: z.boolean() }) },
  "monitor.server": { input: z.object({ force: z.boolean() }), output: snapshotSchema },
  "monitor.machines": { input: z.null(), output: z.object({ machines: z.array(machineSchema) }) },
  "monitor.machine": { input: z.object({ machineId: z.string().min(1), force: z.boolean() }), output: snapshotSchema },
  "monitor.alerts": { input: z.null(), output: monitorStatusSchema },
});

export type Contract = typeof contract;
export type { Machine, MonitorSnapshot } from "../monitor/snapshot.ts";
