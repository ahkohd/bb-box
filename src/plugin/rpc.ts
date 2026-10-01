// The panel's RPC handlers. A failed change comes back as a message for the
// panel to show, not as an RPC error.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { BoxError, describeError, type BoxRecord } from "../core/boxes.ts";
import { ControlError } from "../core/control.ts";
import { contract, type BoxResult } from "./contract.ts";
import type { BbBox } from "./setup.ts";

export function registerRpc(bb: BbPluginApi, app: BbBox): void {
  const { boxes } = app;
  const change = async (action: string, task: () => Promise<BoxRecord | null>): Promise<BoxResult> => {
    try {
      const box = await task();
      return { box: box ? app.view(box) : null, error: null };
    } catch (error) {
      return { box: null, error: error instanceof ControlError ? error.message : describeError(error, action) };
    }
  };

  const desktopBox = async (threadId: string, ref: string): Promise<BoxRecord> => {
    const box = await boxes.get(threadId, ref);
    if (!box.capabilities.displays.length) throw new ControlError(`Box ${box.name} has no desktop.`);
    return box;
  };

  bb.rpc.register(contract, {
    async state({ threadId }) {
      const list = await boxes.list(threadId);
      return { boxes: list.map(app.view), kinds: await app.kinds(), backends: app.backendViews(), desktopPath: app.desktops.path };
    },
    acquire: ({ threadId, kind, size }) =>
      change("Acquiring a box", async () => boxes.acquire({ threadId, projectId: await app.projectOf(threadId), kind, size })),
    release: ({ threadId, box }) => change("Releasing the box", () => boxes.release(threadId, box)),
    stop: ({ threadId, box }) => change("Stopping the box", () => boxes.stop(threadId, box)),
    start: ({ threadId, box }) => change("Starting the box", () => boxes.start(threadId, box)),
    refresh: ({ threadId, box }) => change("Checking the box", () => boxes.refresh(threadId, box)),
    async desktop({ threadId, box: ref }) {
      // A released box shows as gone, not as an error.
      const box = await boxes.get(threadId, ref).catch((error) => {
        if (error instanceof BoxError && error.code === "not_found") return null;
        throw error;
      });
      return { box: box ? app.view(box) : null, desktopPath: app.desktops.path };
    },
    takeControl: ({ threadId, box: ref, viewer }) =>
      change("Taking control", async () => {
        const box = await desktopBox(threadId, ref);
        await app.desktops.control.take(box.id, viewer);
        return box;
      }),
    handBack: ({ threadId, box: ref }) =>
      change("Handing back control", async () => {
        const box = await desktopBox(threadId, ref);
        await app.desktops.control.handBack(box.id);
        return box;
      }),
    async desktops() {
      const all = await boxes.all();
      return all
        .filter((box) => box.capabilities.displays.length > 0 && box.state !== "releasing")
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((box) => ({ threadId: box.threadId, box: app.view(box) }));
    },
    backends: () => app.backendViews(),
    doctor: () => app.doctor(),
    "config.get": () => app.configuration.state(),
    "config.check": ({ draft, test }) => app.configuration.check(draft, test),
    "config.apply": ({ draft, revision }) => app.configuration.apply(draft, revision),
  });
}
