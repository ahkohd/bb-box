// The panel's RPC contract. The panel imports only its type.

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { ApplyResult, CheckResult, ConfigState } from "./configuration.ts";
import type { BackendView, BoxView, DoctorView, KindView } from "./views.ts";

export type { ApplyResult, CheckResult, ConfigState } from "./configuration.ts";

export interface PanelState {
  readonly boxes: readonly BoxView[];
  readonly kinds: readonly KindView[];
  readonly backends: readonly BackendView[];
  /** The desktop relay's WebSocket path on the BB server. */
  readonly desktopPath: string;
}

/** One box's desktop, for its viewer. */
export interface DesktopState {
  /** Null when the thread has no such box, for example once it is released. */
  readonly box: BoxView | null;
  readonly desktopPath: string;
}

/** A desktop box in any thread, for the Desktops page. */
export interface DesktopEntry {
  readonly threadId: string;
  readonly box: BoxView;
}

/** What a change to one box returns: the box as it is now, or why the change failed. */
export interface BoxResult {
  /** Null when the box is gone, for example once released. */
  readonly box: BoxView | null;
  readonly error: string | null;
}

const thread = z.object({ threadId: z.string().min(1) });
const oneBox = thread.extend({ box: z.string().min(1) });
/** The viewer ID names one viewer, such as a panel tab, of a box's desktop. */
const viewer = oneBox.extend({ viewer: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) });
const boxResult = z.custom<BoxResult>();
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
  release: { input: oneBox, output: boxResult },
  stop: { input: oneBox, output: boxResult },
  start: { input: oneBox, output: boxResult },
  refresh: { input: oneBox, output: boxResult },
  desktop: { input: oneBox, output: z.custom<DesktopState>() },
  takeControl: { input: viewer, output: boxResult },
  handBack: { input: oneBox, output: boxResult },
  desktops: { input: z.null(), output: z.custom<DesktopEntry[]>() },
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
});

export type Contract = typeof contract;
