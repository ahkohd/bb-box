// The panel's RPC handlers. A failed change comes back as a message for the
// panel to show, not as an RPC error.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describeError, type BoxRecord } from "../core/boxes.ts";
import { contract, type BoxResult } from "./contract.ts";
import type { BbBox } from "./setup.ts";

export function registerRpc(bb: BbPluginApi, app: BbBox): void {
  const { boxes } = app;
  const change = async (action: string, task: () => Promise<BoxRecord | null>): Promise<BoxResult> => {
    try {
      const box = await task();
      return { box: box ? app.view(box) : null, error: null };
    } catch (error) {
      return { box: null, error: describeError(error, action) };
    }
  };

  bb.rpc.register(contract, {
    async state({ threadId }) {
      const list = await boxes.list(threadId);
      return { boxes: list.map(app.view), kinds: app.kinds(), backends: app.backendViews() };
    },
    acquire: ({ threadId, kind }) =>
      change("Acquiring a box", async () => boxes.acquire({ threadId, projectId: await app.projectOf(threadId), kind })),
    release: ({ threadId, box }) => change("Releasing the box", () => boxes.release(threadId, box)),
    stop: ({ threadId, box }) => change("Stopping the box", () => boxes.stop(threadId, box)),
    start: ({ threadId, box }) => change("Starting the box", () => boxes.start(threadId, box)),
    refresh: ({ threadId, box }) => change("Checking the box", () => boxes.refresh(threadId, box)),
    backends: () => app.backendViews(),
    doctor: () => app.doctor(),
  });
}
