// The desktop viewer's WebSocket route, /desktop?box=<id>&viewer=<id>, and
// the shared control behind it. Each connection gets its own relay to the
// box's display (007, 011). The viewer ID names one tab of the panel, so only
// the tab that took control sends input (008). A display whose stream server
// cannot resize is resized by its backend (021).

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Boxes } from "../core/boxes.ts";
import { Control, type ViewerConnection } from "../core/control.ts";
import { RfbRelay, displayOpener, restoreSize, type OpenDisplay, type Size } from "../core/relay.ts";
import type { Display } from "../transports/types.ts";

export const DESKTOP_ROUTE = "/desktop";
const VIEWER_ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface DesktopDeps {
  readonly boxes: Boxes;
  /** A box's control changed, or the box did: its thread's panels refetch. */
  notify(threadId: string | null): void;
  logError(operation: string, error: unknown): void;
  /** Stops the agent's computer use before a person takes control (015). */
  pause?(boxId: string): Promise<void>;
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

interface Caller {
  resolve(): void;
  reject(error: unknown): void;
}

/**
 * Backend resizes of each box's desktop, one at a time. A request that
 * arrives while one runs waits, and a later one replaces it, so only the
 * latest size is set. A replaced request settles with the one that replaced it.
 */
class Resizes {
  readonly #waiting = new Map<string, { display: Display; size: Size; callers: Caller[] }>();
  readonly #running = new Set<string>();

  request(boxId: string, display: Display, size: Size): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiting = this.#waiting.get(boxId);
      const callers = [...(waiting?.callers ?? []), { resolve, reject }];
      this.#waiting.set(boxId, { display, size, callers });
      if (!this.#running.has(boxId)) void this.#run(boxId);
    });
  }

  async #run(boxId: string): Promise<void> {
    this.#running.add(boxId);
    try {
      for (let next = this.#waiting.get(boxId); next; next = this.#waiting.get(boxId)) {
        this.#waiting.delete(boxId);
        try {
          await next.display.resize!(next.size);
          for (const caller of next.callers) caller.resolve();
        } catch (error) {
          for (const caller of next.callers) caller.reject(error);
        }
      }
    } finally {
      this.#running.delete(boxId);
    }
  }
}

export function registerDesktop(bb: BbPluginApi, deps: DesktopDeps): Desktops {
  const { boxes } = deps;
  const changed = (boxId: string) => {
    void boxes
      .find(boxId)
      .then((box) => deps.notify(box?.threadId ?? null))
      .catch((error) => deps.logError("notify", error));
  };
  const resizes = new Resizes();
  const control = new Control({
    changed,
    logError: deps.logError,
    staleMs: deps.staleMs,
    pause: deps.pause,
    async restore(boxId, size, screen) {
      const shown = await display(boxes, boxId);
      // SetDesktopSize first, even when the backend resizes: a GPU desktop
      // can come back on the CPU after a stop and start, and take it (021).
      await restoreSize(displayOpener(shown), size, screen);
      if (shown.resize) await resizes.request(boxId, shown, size);
    },
  });
  const relays = new Set<RfbRelay>();

  bb.http.experimental_websocket(
    DESKTOP_ROUTE,
    ({ url }) => {
      const boxId = url.searchParams.get("box") ?? "";
      const viewer = url.searchParams.get("viewer") ?? "";
      let relay: RfbRelay | null = null;
      let shown: Display | null = null;
      return {
        onOpen(socket) {
          const open: OpenDisplay = VIEWER_ID.test(viewer)
            ? async (signal) => displayOpener((shown = await display(boxes, boxId)))(signal)
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
            minSize: () => shown?.minSize ?? null,
            onResize: (size, screen) => {
              control.resized(boxId, viewer, screen);
              // The SetDesktopSize still reaches the box, which answers the viewer.
              if (shown?.resize) {
                resizes.request(boxId, shown, size).catch((error) => deps.logError("resize the desktop", error));
              }
            },
            onEnd: (by, error) => {
              relays.delete(relay!);
              // Control goes back to the agent at once (020), so the log says why the viewer lost it.
              if (by === "box" && control.mayInput(boxId, viewer)) {
                const why = error?.message ?? "It closed the connection.";
                void boxes
                  .find(boxId)
                  .then((box) => bb.log.warn(`Box ${box?.name ?? boxId}'s desktop ended the connection of the viewer with control, so control goes back to the agent. ${why}`))
                  .catch((caught) => deps.logError("log a desktop's end", caught));
              }
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
      await control.dispose();
      await Promise.all([...relays].map((relay) => relay.close()));
    },
  };
}
