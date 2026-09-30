// The desktop viewer's WebSocket route, /desktop?box=<id>&viewer=<id>, and
// the shared control behind it. Each connection gets its own relay to the
// box's display (007, 011). The viewer ID names one tab of the panel, so only
// the tab that took control sends input (008).

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Boxes } from "../core/boxes.ts";
import { Control, type ViewerConnection } from "../core/control.ts";
import { RfbRelay, displayOpener, restoreSize, type OpenDisplay } from "../core/relay.ts";
import type { Display } from "../transports/types.ts";

export const DESKTOP_ROUTE = "/desktop";
const VIEWER_ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface DesktopDeps {
  readonly boxes: Boxes;
  /** A box's control changed, or the box did: its thread's panels refetch. */
  notify(threadId: string | null): void;
  logError(operation: string, error: unknown): void;
  /** How long a holder's viewer may be gone before the agent has control again. */
  readonly staleMs?: number;
}

export interface Desktops {
  readonly control: Control;
  /** Where the panel opens the viewer's WebSocket, on the BB server's origin. */
  readonly path: string;
  dispose(): Promise<void>;
}

/** The display the viewer shows: the box's first, until boxes have more than one. */
async function display(boxes: Boxes, boxId: string): Promise<Display> {
  const box = await boxes.find(boxId);
  if (!box) throw new Error("bb-box has no such box. It may have been released.");
  if (box.state !== "ready") throw new Error(`Box ${box.name} is not running, so its desktop cannot show.`);
  const [first] = (await boxes.transports(box)).displays;
  if (!first) throw new Error(`Box ${box.name} has no desktop.`);
  if (first.protocol !== "rfb") throw new Error(`The viewer cannot show a ${first.protocol} desktop yet.`);
  return first;
}

function opener(boxes: Boxes, boxId: string): OpenDisplay {
  return async (signal) => displayOpener(await display(boxes, boxId))(signal);
}

export function registerDesktop(bb: BbPluginApi, deps: DesktopDeps): Desktops {
  const { boxes } = deps;
  const changed = (boxId: string) => {
    void boxes
      .find(boxId)
      .then((box) => deps.notify(box?.threadId ?? null))
      .catch((error) => deps.logError("notify", error));
  };
  const control = new Control({
    changed,
    logError: deps.logError,
    staleMs: deps.staleMs,
    async restore(boxId, size, screen) {
      await restoreSize(opener(boxes, boxId), size, screen);
    },
  });
  const relays = new Set<RfbRelay>();

  bb.http.experimental_websocket(
    DESKTOP_ROUTE,
    ({ url }) => {
      const boxId = url.searchParams.get("box") ?? "";
      const viewer = url.searchParams.get("viewer") ?? "";
      let relay: RfbRelay | null = null;
      return {
        onOpen(socket) {
          const open: OpenDisplay = VIEWER_ID.test(viewer)
            ? opener(boxes, boxId)
            : async () => {
                throw new Error("The viewer gave no viewer ID, so it cannot be told apart from other tabs.");
              };
          const connection: ViewerConnection = { viewer, release: () => relay?.release() ?? Promise.resolve() };
          relay = new RfbRelay({
            viewer: {
              send: (bytes) => socket.send(bytes),
              close: (code, reason) => socket.close(code, reason),
            },
            open,
            mayInput: () => control.mayInput(boxId, viewer),
            onServerInit: (size) => control.seen(boxId, size),
            onResize: (_size, screen) => control.resized(boxId, viewer, screen),
            onEnd: (by) => {
              relays.delete(relay!);
              control.detach(boxId, connection, by);
            },
          });
          relays.add(relay);
          control.attach(boxId, connection);
        },
        async onMessage(socket, data) {
          if (typeof data === "string") {
            socket.close(1003, "The desktop relay takes binary messages only.");
            return;
          }
          await relay?.receive(data);
        },
        async onClose() {
          await relay?.close();
        },
        onError(_socket, error) {
          deps.logError("desktop viewer", error);
        },
      };
    },
    { auth: "local" },
  );

  return {
    control,
    path: `/api/v1/plugins/${encodeURIComponent(bb.pluginId)}/http${DESKTOP_ROUTE}`,
    async dispose() {
      control.dispose();
      await Promise.all([...relays].map((relay) => relay.close()));
    },
  };
}
