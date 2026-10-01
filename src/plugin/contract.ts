// The panel's RPC contract. The panel imports only its type.

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { DockerHostView } from "./docker-hosts.ts";
import type { ApplyResult, CheckResult, ConfigState } from "./configuration.ts";
import type { BackendView, BoxView, DoctorView, KindView } from "./views.ts";

export type { ApplyResult, CheckResult, ConfigState } from "./configuration.ts";

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
}

/** One box's desktop or terminal, for its tab. */
export interface DesktopState {
  /** Null when the thread has no such box, for example once it is released. */
  readonly box: BoxView | null;
  readonly desktopPath: string;
  readonly terminalPath: string;
}

/** A desktop box in any thread, or one of your machines, for the Desktops page. */
export interface DesktopEntry {
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

/** A thread that runs on a box's BB machine. */
export interface ThreadOnBox {
  readonly id: string;
  readonly title: string | null;
  /** Working now: busy, or waiting on a question to the user. An idle thread has finished. */
  readonly running: boolean;
}

/** What starting a thread on a box returns: the new thread, or why it did not start. */
export interface ThreadResult {
  readonly threadId: string | null;
  readonly error: string | null;
}

const thread = z.object({ threadId: z.string().min(1) });
const oneBox = thread.extend({ box: z.string().min(1) });
/** The viewer ID names one viewer, such as a panel tab, of a box's desktop. */
const viewer = oneBox.extend({ viewer: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) });
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

/** A whole configuration document as JSON (029). bb-box checks it. */
const draft = z.unknown();

export const contract = defineRpcContract({
  state: { input: thread, output: z.custom<PanelState>() },
  acquire: { input: thread.extend({ kind: z.string().min(1), size: size.optional() }), output: boxResult },
  /** Without `force`, a box a thread is working on is left alone, and the answer names the threads. */
  release: { input: forceable, output: boxResult },
  stop: { input: forceable, output: boxResult },
  start: { input: oneBox, output: boxResult },
  refresh: { input: oneBox, output: boxResult },
  desktop: { input: oneBox, output: z.custom<DesktopState>() },
  takeControl: { input: viewer, output: boxResult },
  handBack: { input: oneBox, output: boxResult },
  desktops: { input: z.null(), output: z.custom<DesktopEntry[]>() },
  /** Your machines (036), oldest first, and the kinds that can be yours: on offer, and able to become BB machines. */
  "machines.list": { input: z.null(), output: z.custom<{ machines: MachineEntry[]; kinds: KindView[] }>() },
  /** Adds one: returns once it is recorded, and the "changed" signal for "operator" follows its progress. */
  "machines.add": {
    input: z.object({ kind: z.string().min(1), size: size.optional(), name: z.string().min(1).optional() }),
    output: boxResult,
  },
  /** Without `force`, one a thread is working on is left alone, and the answer names the threads. */
  "machines.remove": { input: machineRef.extend({ force: z.boolean().optional() }), output: boxResult },
  "machines.stop": { input: machineRef.extend({ force: z.boolean().optional() }), output: boxResult },
  "machines.start": { input: machineRef, output: boxResult },
  /** The kinds on offer now, for "New box" in BB's new-thread screen. */
  kinds: { input: z.null(), output: z.custom<KindView[]>() },
  /** Starts a child thread on a box's BB machine. */
  thread: { input: oneBox.extend({ prompt: z.string().min(1) }), output: z.custom<ThreadResult>() },
  backends: { input: z.null(), output: z.custom<BackendView[]>() },
  doctor: { input: z.null(), output: z.custom<DoctorView>() },
  /** The configuration, its defaults and problems, and each backend's state (029). */
  "config.get": { input: z.null(), output: z.custom<ConfigState>() },
  /** Problems with a draft, saving nothing. `test`, a backend's ID, also runs its doctor against the draft, within 30 s. */
  "config.check": { input: z.object({ draft, test: z.string().min(1).optional() }), output: z.custom<CheckResult>() },
  /**
   * Saves a draft whole, if `revision` is the current one, and answers once the backends are rebuilt.
   * The draft's own revision is ignored. A saved answer lists the problems saved anyway, in backends
   * that are off and have no boxes.
   */
  "config.apply": { input: z.object({ draft, revision: z.number().int().min(0) }), output: z.custom<ApplyResult>() },
  /** BB machines that can host Docker boxes, with Docker as it answers through bb-box's relay (042). */
  "docker.hosts": { input: z.null(), output: z.custom<{ hosts: DockerHostView[] }>() },
  /**
   * Turns a BB machine on or off as a Docker host: on adds a Docker backend
   * on it, last in acquire order; off removes it, or turns it off while it
   * has boxes. Answers with the configuration's answer and the list again.
   */
  "docker.host.set": { input: z.object({ hostId: z.string().min(1).max(64), enabled: z.boolean() }), output: z.custom<{ result: ApplyResult; hosts: DockerHostView[] }>() },
});

export type Contract = typeof contract;
