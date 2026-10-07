// The desktop viewer's WebSocket route, /desktop?box=<id>&viewer=<id>, and
// the shared control behind it. Each connection gets its own relay to the
// box's display (007, 011): RFB by default, or with &stream=selkies the box's
// Selkies display, beside its RFB one (056). The viewer ID names one tab of
// the panel, so only the tab that took control sends input (008). A display
// whose stream server cannot resize is resized by its backend (021), and a
// Selkies viewer's desktop is resized through the RFB display, which Selkies
// follows. Each person's control is kept in plugin storage for the plugin's
// next instance (045).

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BoxRecord, Boxes } from "../core/boxes.ts";
import { Control, RECONNECT_MS, STALE_MS, type KeptControl, type ViewerConnection } from "../core/control.ts";
import { clipboardCommands } from "../core/in-box.ts";
import { RfbRelay, displayOpener, restoreSize, type OpenDisplay, type Size } from "../core/relay.ts";
import type { Screen } from "../core/rfb.ts";
import { SelkiesBox, SelkiesRelay, type OpenStream } from "../core/selkies.ts";
import { openRoute } from "../transports/route.ts";
import type { Display } from "../transports/types.ts";

export const DESKTOP_ROUTE = "/desktop";
const VIEWER_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** Each person's control, for the plugin's next instance (045). */
const KEPT_KEY = "desktop-control";
/** The most text bb-box reads from a desktop's clipboard with its own commands (#464): more is left for the box's own copy. */
const MAX_CLIPBOARD_BYTES = 4 * 1024 * 1024;
/** How long reading or writing a box's clipboard with a command may take. */
const CLIPBOARD_TIMEOUT_MS = 10_000;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

/** The kept control in storage. What this version cannot read is left out, and the agent keeps that box. */
function keptControl(value: unknown): KeptControl[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): KeptControl[] => {
    if (!isObject(entry) || typeof entry.boxId !== "string" || typeof entry.holder !== "string" || !VIEWER_ID.test(entry.holder)) return [];
    const { size, resized } = entry;
    if (size !== null && !(isObject(size) && isCount(size.width) && isCount(size.height))) return [];
    if (resized !== null && !(isObject(resized) && isCount(resized.id) && isCount(resized.flags))) return [];
    return [{ boxId: entry.boxId, holder: entry.holder, size: size && { width: size.width as number, height: size.height as number }, resized: resized && { id: resized.id as number, flags: resized.flags as number } }];
  });
}

export interface DesktopDeps {
  readonly boxes: Boxes;
  /** A box's control changed, or the box did: its thread's panels refetch. */
  notify(threadId: string | null): void;
  logError(operation: string, error: unknown): void;
  /** Stops the agent's computer use before a person takes control (015). */
  pause?(boxId: string): Promise<void>;
  /** How long a holder's viewer may be gone before the agent has control again. */
  readonly staleMs?: number;
  /** How long a holder's viewer has to connect again after the box ended its connection. */
  readonly reconnectMs?: number;
}

export interface Desktops {
  readonly control: Control;
  /** Where the panel opens the viewer's WebSocket, on the BB server's origin. */
  readonly path: string;
  /**
   * The box's clipboard text, with a count that changes with it, for the
   * viewer with control to copy: as its desktop's own input last reported it
   * (#406), or, where the desktop's server moves none, read in the box now
   * for that viewer (#464). Null before any.
   */
  clipboard(boxId: string, viewer?: string): Promise<{ readonly text: string; readonly serial: number } | null>;
  /**
   * Puts the viewer's text on the box's clipboard, where the desktop's server
   * moves none (#464). Only the viewer with control may; rejects with why
   * the box did not take it.
   */
  paste(boxId: string, viewer: string, text: string): Promise<void>;
  dispose(): Promise<void>;
}

/** The screen a Selkies viewer's resize sets, through the RFB display: screen 0, as noVNC's before the server names one. */
const SELKIES_SCREEN: Screen = { id: 0, flags: 0 };

/** The box's displays, when it is running and has one. */
async function displays(boxes: Boxes, boxId: string): Promise<readonly Display[]> {
  const box = await boxes.find(boxId);
  if (!box) throw new Error("bb-box has no such box. It may have been released.");
  if (box.state !== "ready") throw new Error(`Box ${box.name} is not running, so its desktop cannot show.`);
  const found = (await boxes.transports(box)).displays;
  if (!found.length) throw new Error(`Box ${box.name} has no desktop.`);
  return found;
}

/** The RFB display: the box's first. Control and sizes go through it. */
async function display(boxes: Boxes, boxId: string): Promise<Display> {
  const [first] = await displays(boxes, boxId);
  if (first!.protocol !== "rfb") throw new Error(`The viewer cannot show a ${first!.protocol} desktop yet.`);
  return first!;
}

/** The box's Selkies display (056). */
async function selkiesDisplay(boxes: Boxes, boxId: string): Promise<Display> {
  const found = (await displays(boxes, boxId)).find((each) => each.protocol === "selkies");
  if (!found) throw new Error("This box's desktop has no Selkies stream.");
  return found;
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
  readonly #waiting = new Map<string, { apply: (size: Size) => Promise<void>; size: Size; callers: Caller[] }>();
  readonly #running = new Set<string>();

  /** Sets the size with `apply`, a display's resize or another way. */
  request(boxId: string, apply: (size: Size) => Promise<void>, size: Size): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiting = this.#waiting.get(boxId);
      const callers = [...(waiting?.callers ?? []), { resolve, reject }];
      this.#waiting.set(boxId, { apply, size, callers });
      if (!this.#running.has(boxId)) void this.#run(boxId);
    });
  }

  async #run(boxId: string): Promise<void> {
    this.#running.add(boxId);
    try {
      for (let next = this.#waiting.get(boxId); next; next = this.#waiting.get(boxId)) {
        this.#waiting.delete(boxId);
        try {
          await next.apply(next.size);
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
  const reconnectMs = deps.reconnectMs ?? RECONNECT_MS;
  const staleMs = deps.staleMs ?? STALE_MS;
  const kv = bb.storage.kv;
  /** Each person's control as stored, for the boxes still ready, read again as the first viewer connects (#318). */
  const read = async () => {
    const ready: KeptControl[] = [];
    for (const entry of keptControl(await kv.get<unknown>(KEPT_KEY))) {
      if ((await boxes.find(entry.boxId))?.state === "ready") ready.push(entry);
    }
    return ready;
  };
  const control = new Control({
    changed,
    logError: deps.logError,
    staleMs: deps.staleMs,
    reconnectMs,
    pause: deps.pause,
    keep: (kept) => (kept.length ? kv.set(KEPT_KEY, kept) : kv.delete(KEPT_KEY)),
    read,
    // A deploy or reload looks to a person like the box ending the viewer's connection, so the log says it was bb-box.
    async stopping(boxId, kept) {
      const box = await boxes.find(boxId);
      const name = box?.name ?? boxId;
      bb.log.warn(
        kept
          ? `bb-box is stopping, as for an update or a reload. The viewer with control of box ${name}'s desktop keeps it if it connects again within ${staleMs / 1000} s.`
          : `bb-box is stopping, as for an update or a reload, so control of box ${name}'s desktop goes back to the agent.`,
      );
    },
    async restore(boxId, size, screen) {
      const shown = await display(boxes, boxId);
      // SetDesktopSize first, even when the backend resizes: a GPU desktop
      // can come back on the CPU after a stop and start, and take it (021).
      await restoreSize(displayOpener(shown), size, screen);
      if (shown.resize) await resizes.request(boxId, (each) => shown.resize!(each), size);
    },
  });
  const relays = new Set<{ close(): Promise<void> }>();
  /** Each box's side of its Selkies viewers, while any is connected. */
  const selkiesBoxes = new Map<string, { box: SelkiesBox; viewers: number }>();
  const selkiesBox = (boxId: string, open: OpenStream): SelkiesBox => {
    const entry = selkiesBoxes.get(boxId) ?? { box: new SelkiesBox(open, { onError: (error) => deps.logError("open the Selkies input", error) }), viewers: 0 };
    entry.viewers += 1;
    selkiesBoxes.set(boxId, entry);
    return entry.box;
  };
  const leftSelkies = (boxId: string) => {
    const entry = selkiesBoxes.get(boxId);
    if (!entry || --entry.viewers > 0) return;
    selkiesBoxes.delete(boxId);
    void entry.box.close();
  };
  /** Sets a box's desktop to a Selkies viewer's size, through its RFB display, which Selkies follows. */
  const sizeForSelkies = async (boxId: string, size: Size): Promise<void> => {
    const shown = await display(boxes, boxId);
    const min = shown.minSize;
    const raised = { width: Math.max(size.width, min?.width ?? 0), height: Math.max(size.height, min?.height ?? 0) };
    await resizes.request(
      boxId,
      async (each) => {
        await restoreSize(displayOpener(shown), each, SELKIES_SCREEN);
        if (shown.resize) await shown.resize(each);
      },
      raised,
    );
  };
  const clipboards = new Map<string, { text: string; serial: number }>();
  let clipboardSerial = 0;
  /** The box, when it is running and its desktop's clipboard goes through bb-box's commands. */
  const byCommands = async (boxId: string): Promise<BoxRecord | null> => {
    const box = await boxes.find(boxId);
    return box?.state === "ready" && box.capabilities.displays[0]?.clipboard === "commands" && clipboardCommands(box.capabilities.os) ? box : null;
  };
  /**
   * One read of a box's clipboard at a time, which the next calls share: a Windows desktop's read takes seconds,
   * longer than the viewer's 2 s poll (#461), so reads would pile up in the box.
   */
  const reading = new Map<string, Promise<void>>();
  /** Pastes into each box so far: a read that began before a paste found the old text, which must not come back as a copy. */
  const pastes = new Map<string, number>();

  // Control people had as the last instance stopped. BB starts this one first, so the viewers connect again once that one stops.
  void (async () => {
    const kept = keptControl(await kv.get<unknown>(KEPT_KEY));
    if (!kept.length) return;
    const resumed: KeptControl[] = [];
    for (const entry of kept) {
      const box = await boxes.find(entry.boxId);
      // A box that stopped or went while bb-box was away has a new desktop, or none.
      if (box?.state !== "ready") continue;
      resumed.push(entry);
      bb.log.info(`The viewer with control of box ${box.name}'s desktop as bb-box restarted keeps it if it connects again within ${staleMs / 1000} s.`);
    }
    control.resume(resumed);
  })().catch((error) => deps.logError("resume desktop control", error));

  bb.http.experimental_websocket(
    DESKTOP_ROUTE,
    ({ url }) => {
      const boxId = url.searchParams.get("box") ?? "";
      const viewer = url.searchParams.get("viewer") ?? "";
      const selkies = url.searchParams.get("stream") === "selkies";
      let relay: RfbRelay | SelkiesRelay | null = null;
      let shown: Display | null = null;
      const connection: ViewerConnection = { viewer, release: () => relay?.release() ?? Promise.resolve() };
      const onEnd = (by: "viewer" | "box", error: Error | null) => {
        relays.delete(relay!);
        if (selkies) leftSelkies(boxId);
        // Control goes back to the agent unless the viewer connects again soon (020), so the log says why it may lose it.
        if (by === "box" && control.mayInput(boxId, viewer)) {
          const why = error?.message ?? "It closed the connection.";
          void boxes
            .find(boxId)
            .then((box) =>
              bb.log.warn(`Box ${box?.name ?? boxId}'s desktop ended the connection of the viewer with control. ${why} Control goes back to the agent unless the viewer connects again within ${reconnectMs / 1000} s.`),
            )
            .catch((caught) => deps.logError("log a desktop's end", caught));
        }
        control.detach(boxId, connection, by);
      };
      return {
        onOpen(socket) {
          const end = { send: (message: string | Uint8Array) => socket.send(message), close: (code: number, reason: string) => socket.close(code, reason) };
          if (selkies) {
            if (!VIEWER_ID.test(viewer)) {
              socket.close(1008, "The viewer gave no viewer ID, so it cannot be told apart from other tabs.");
              return;
            }
            const open: OpenStream = async (signal) => openRoute((await (await selkiesDisplay(boxes, boxId)).open(signal)).route, signal);
            relay = new SelkiesRelay({
              viewer: end,
              box: selkiesBox(boxId, open),
              open,
              mayInput: () => control.mayInput(boxId, viewer),
              onSize: (size) => control.seen(boxId, size),
              onResize: (size) => {
                control.resized(boxId, viewer, SELKIES_SCREEN);
                sizeForSelkies(boxId, size).catch((error) => deps.logError("resize the desktop", error));
              },
              onEnd,
            });
          } else {
            const open: OpenDisplay = VIEWER_ID.test(viewer)
              ? async (signal) => displayOpener((shown = await display(boxes, boxId)))(signal)
              : async () => {
                  throw new Error("The viewer gave no viewer ID, so it cannot be told apart from other tabs.");
                };
            relay = new RfbRelay({
              viewer: end,
              open,
              mayInput: () => control.mayInput(boxId, viewer),
              onServerInit: (size) => control.seen(boxId, size),
              minSize: () => shown?.minSize ?? null,
              onResize: (size, screen) => {
                control.resized(boxId, viewer, screen);
                // The SetDesktopSize still reaches the box, which answers the viewer.
                const resize = shown?.resize;
                if (resize) {
                  resizes.request(boxId, (each) => resize(each), size).catch((error) => deps.logError("resize the desktop", error));
                }
              },
              onClipboard: (text) => {
                clipboards.set(boxId, { text, serial: ++clipboardSerial });
              },
              onInputError: (error) => deps.logError("open the desktop's input", error),
              onEnd,
            });
          }
          relays.add(relay);
          control.attach(boxId, connection);
        },
        async onMessage(socket, data) {
          if (relay instanceof SelkiesRelay) {
            await relay.receive(data);
            return;
          }
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
    async clipboard(boxId, viewer) {
      const box = viewer && control.mayInput(boxId, viewer) ? await byCommands(boxId) : null;
      if (box) {
        let read = reading.get(boxId);
        if (!read) {
          const commands = clipboardCommands(box.capabilities.os)!;
          const before = pastes.get(boxId) ?? 0;
          read = (async () => {
            const result = await boxes.runOwn(box, commands.read, { session: "desktop", timeoutMs: CLIPBOARD_TIMEOUT_MS, maxOutputBytes: MAX_CLIPBOARD_BYTES }).catch(() => null);
            // An empty clipboard, or one with no text, such as an image, leaves this computer's clipboard as it is.
            const text = result?.exitCode === 0 && !result.truncated ? result.stdout : "";
            if ((pastes.get(boxId) ?? 0) !== before) return;
            if (text && text !== clipboards.get(boxId)?.text) clipboards.set(boxId, { text, serial: ++clipboardSerial });
          })().finally(() => reading.delete(boxId));
          reading.set(boxId, read);
        }
        await read;
      }
      return clipboards.get(boxId) ?? null;
    },
    async paste(boxId, viewer, text) {
      if (!control.mayInput(boxId, viewer)) throw new Error("Only the tab with control of the desktop can paste into it. Take control, then paste again.");
      const box = await byCommands(boxId);
      if (!box) throw new Error("This desktop takes a viewer's clipboard through its own server, so bb-box does not paste into it.");
      pastes.set(boxId, (pastes.get(boxId) ?? 0) + 1);
      const written = await boxes.runOwn(box, clipboardCommands(box.capabilities.os)!.write, { session: "desktop", stdin: text, timeoutMs: CLIPBOARD_TIMEOUT_MS, maxOutputBytes: 64 * 1024 });
      if (written.exitCode !== 0) {
        const why = written.stderr.trim().split("\n").at(-1) || `the clipboard command exited with code ${written.exitCode}`;
        throw new Error(`Box ${box.name} did not take the text for its clipboard: ${why}`);
      }
      // The box has the viewer's text, so the next read finds no change to copy back.
      clipboards.set(boxId, { text, serial: clipboards.get(boxId)?.serial ?? ++clipboardSerial });
    },
    async dispose() {
      await control.dispose();
      await Promise.all([...relays].map((relay) => relay.close()));
    },
  };
}
