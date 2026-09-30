// The panel's RPC contract. The panel imports only its type.

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { BackendView, BoxView, DoctorView, KindView } from "./views.ts";

export interface PanelState {
  readonly boxes: readonly BoxView[];
  readonly kinds: readonly KindView[];
  readonly backends: readonly BackendView[];
}

/** What a change to one box returns: the box as it is now, or why the change failed. */
export interface BoxResult {
  /** Null when the box is gone, for example once released. */
  readonly box: BoxView | null;
  readonly error: string | null;
}

const thread = z.object({ threadId: z.string().min(1) });
const oneBox = thread.extend({ box: z.string().min(1) });
const boxResult = z.custom<BoxResult>();

export const contract = defineRpcContract({
  state: { input: thread, output: z.custom<PanelState>() },
  acquire: { input: thread.extend({ kind: z.string().min(1) }), output: boxResult },
  release: { input: oneBox, output: boxResult },
  stop: { input: oneBox, output: boxResult },
  start: { input: oneBox, output: boxResult },
  refresh: { input: oneBox, output: boxResult },
  doctor: { input: z.null(), output: z.custom<DoctorView>() },
});

export type Contract = typeof contract;
