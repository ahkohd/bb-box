// The panel's RPC contract. The panel imports only its type.

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { BackendView, BoxView, DoctorView, KindView } from "./views.ts";

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

export const contract = defineRpcContract({
  state: { input: thread, output: z.custom<PanelState>() },
  acquire: { input: thread.extend({ kind: z.string().min(1) }), output: boxResult },
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
});

export type Contract = typeof contract;
