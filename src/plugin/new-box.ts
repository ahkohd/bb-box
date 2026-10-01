// "New box" in BB's new-thread screen (033): a thread that starts on a box
// of its own. A second machine provider, ephemeral, makes the box for the
// thread when BB places it there, and BB's project checkout clones the
// project onto it. BB gives the provider the thread's ID as the key. The
// box has role "machine": it is the thread's machine, outside the
// per-thread limit, and goes when BB removes the machine or the thread ends.

import type { BbPluginApi, MachineBootstrapRequest, PluginMachineProviderDeclaration } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { describeError, type BoxRecord, type Boxes } from "../core/boxes.ts";
import { PRESETS } from "../core/sizes.ts";
import { executor } from "./enrol.ts";

export const NEW_BOX_PROVIDER_ID = "bb-box-new";

export const newBoxInputs = z.object({
  kind: z.string().min(1),
  size: z.enum(PRESETS).optional(),
});

export type NewBoxInputs = z.infer<typeof newBoxInputs>;

export interface NewBoxDeps {
  readonly boxes: Boxes;
  /** The thread with this ID, or null when there is none. */
  thread(threadId: string): Promise<{ id: string; projectId: string } | null>;
  bootstrap(request: MachineBootstrapRequest): Promise<{ hostId: string }>;
}

/** The thread's own box, while it has one that is not gone. */
async function machineOf(boxes: Boxes, threadId: string): Promise<BoxRecord | null> {
  return (await boxes.list(threadId)).find((box) => box.role === "machine" && box.state !== "releasing") ?? null;
}

export function newBoxProvider(deps: NewBoxDeps): PluginMachineProviderDeclaration<typeof newBoxInputs> {
  const { boxes } = deps;
  const release = async (box: BoxRecord | null) => {
    if (box) await boxes.release(box.threadId, box.id);
  };
  return {
    id: NEW_BOX_PROVIDER_ID,
    displayName: "New box",
    description: "A new bb-box box for this thread alone, released when the thread is archived.",
    icon: "Box",
    ephemeral: true,
    inputs: newBoxInputs,
    validate({ inputs }) {
      const kind = boxes.kinds().find((candidate) => candidate.id === inputs.kind);
      if (!kind) return { action: "refuse", message: `bb-box has no ${inputs.kind} boxes on offer now.` };
      if (!kind.capabilities.enrol) return { action: "refuse", message: `A ${kind.label} box cannot become a BB machine, so a thread cannot run on it.` };
      return { action: "accept" };
    },
    async create({ inputs, key, checkpoint, report, signal }) {
      const thread = await deps.thread(key);
      if (!thread) return { status: "failed", message: `bb-box makes a new box for the thread that starts on it, and BB named none (key ${key}).` };
      try {
        let box = await machineOf(boxes, thread.id);
        if (!box) {
          report.step("Making a box");
          box = await boxes.acquire({ threadId: thread.id, projectId: thread.projectId, kind: inputs.kind, size: { preset: inputs.size }, role: "machine" });
        }
        await checkpoint({ boxId: box.id });
        box = (await boxes.settled(box)) ?? box;
        signal.throwIfAborted();
        if (box.state !== "ready") return { status: "failed", message: `Box ${box.name} did not start: ${box.error ?? box.state}.` };
        report.step(`Installing BB in box ${box.name}`);
        const { command } = await boxes.transports(box);
        if (!command) return { status: "failed", message: `bb-box cannot run commands in box ${box.name}.` };
        const { hostId } = await deps.bootstrap({ key, executor: executor(command), report, signal });
        await boxes.update(box, () => ({ enrol: { state: "enrolled", hostId, error: null } }));
        return { status: "created", name: box.name, resource: { boxId: box.id } };
      } catch (error) {
        signal.throwIfAborted();
        return { status: "failed", message: describeError(error, "Making the thread's box") };
      }
    },
    // A create cut short: the thread's box, if bb-box made one, goes.
    async reconcileCleanup({ key }) {
      await release(await machineOf(boxes, key));
      return { status: "removed" };
    },
    async remove({ resource }) {
      const boxId = (resource as { boxId?: unknown }).boxId;
      if (typeof boxId === "string") await release(await boxes.find(boxId));
      return { status: "removed" };
    },
  };
}

/** Registers the provider and "New box", paired with BB's project checkout. */
export function registerNewBox(bb: BbPluginApi, deps: NewBoxDeps): void {
  bb.experimental_machines.register(newBoxProvider(deps));
  bb.experimental_environments.register({
    id: NEW_BOX_PROVIDER_ID,
    displayName: "New box",
    description: "A new bb-box box for this thread, with the project cloned onto it.",
    icon: "Box",
    machineProviderId: NEW_BOX_PROVIDER_ID,
    environmentProviderId: "project-checkout",
  });
}
