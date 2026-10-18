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
import { RfbRelay, desktopSize, displayOpener, restoreSize, type OpenDisplay, type Size } from "../core/relay.ts";
import type { Screen } from "../core/rfb.ts";
import { SelkiesBox, SelkiesRelay, type OpenStream } from "../core/selkies.ts";
import { scaleScript } from "../backends/windows.ts";
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
/** How long after a VNC viewer's resize its desktop's video viewers follow: the box takes a size in a few milliseconds. */
const FOLLOW_AFTER_MS = 300;
/** How long a box's video stays stopped for its capture to restart: Selkies stops a capture within milliseconds. */
const RESTART_PAUSE_MS = 300;
/** Each box whose desktop is High resolution: its xfwm theme before, and the size High resolution set (the owner's note of 16 October 2026). */
const SHARP_PREFIX = "desktop-sharp/";
/** High resolution's density: twice the pixels, with Xfce's UI scaled to match, so everything keeps its size and text is sharp on a 2x screen. */
const SHARP_SCALE = 2;
/** How long Xfce may take to change its scale. */
const SHARP_TIMEOUT_MS = 30_000;
/** The largest desktop High resolution sets: Xvnc's limit is far above it, Selkies' encoder is not. */
const SHARP_MAX: Size = { width: 7680, height: 4320 };

/** Xfce at High resolution's scale: GTK's window scale, xfwm's HiDPI theme, and the panel again so it takes the scale. Prints the theme before. */
const SHARP_ON =
  "t=$(xfconf-query -c xfwm4 -p /general/theme 2>/dev/null); " +
  `xfconf-query -c xsettings -p /Gdk/WindowScalingFactor -s ${SHARP_SCALE} 2>/dev/null || xfconf-query -c xsettings -p /Gdk/WindowScalingFactor -n -t int -s ${SHARP_SCALE}; ` +
  "xfconf-query -c xfwm4 -p /general/theme -s Default-xhdpi; (xfce4-panel -r >/dev/null 2>&1 &); printf '%s' \"$t\"";
/** Xfce back at 1x, with the theme it had. */
function sharpOff(theme: string): string {
  const quoted = `'${theme.replaceAll("'", `'\\''`)}'`;
  return `xfconf-query -c xsettings -p /Gdk/WindowScalingFactor -s 1; xfconf-query -c xfwm4 -p /general/theme -s ${quoted}; (xfce4-panel -r >/dev/null 2>&1 &)`;
}

interface SharpKept {
  readonly theme: string;
  readonly size: Size;
}

/**
 * Whether a box's desktop can be High resolution: a Linux X11 desktop drawn by the CPU, which Selkies streams, or a
 * Windows desktop streamed as video, at 200% (the owner's note of 18 October 2026).
 */
export function sharpOffered(box: BoxRecord): boolean {
  const video = box.capabilities.displays.some((each) => each.protocol === "selkies");
  return video && ((box.capabilities.os === "linux" && !box.capabilities.gpu) || box.capabilities.os === "windows");
}

/** `size` times `factor`, within High resolution's largest and at least 640x480. */
function scaled(size: Size, factor: number): Size {
  return {
    width: Math.min(SHARP_MAX.width, Math.max(640, Math.round(size.width * factor))),
    height: Math.min(SHARP_MAX.height, Math.max(480, Math.round(size.height * factor))),
  };
}

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
  /** Whether the box's desktop is High resolution, or null where it cannot be. */
  sharp(boxId: string): Promise<boolean | null>;
  /** Makes the box's desktop High resolution, twice the pixels at twice Xfce's scale, or not. */
  setSharp(boxId: string, on: boolean): Promise<void>;
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
    changed(boxId) {
      changed(boxId);
      // A person took control of a box with Selkies viewers: its input connection opens now, not at their first key.
      if (control.view(boxId).owner === "human") selkiesBoxes.get(boxId)?.box.warm();
      cursorFor(boxId);
      pointerFor(boxId);
    },
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
      await followSize(boxId, shown).catch((error) => deps.logError("have the video follow the desktop's size", error));
    },
  });
  const relays = new Set<{ close(): Promise<void> }>();
  /** Each box's side of its Selkies viewers, and their relays, while any is connected. */
  const selkiesBoxes = new Map<
    string,
    {
      box: SelkiesBox;
      viewers: number;
      relays: Set<SelkiesRelay>;
      /** Whether each viewer's browser decodes 4:4:4, as it said. */
      colours: Map<SelkiesRelay, boolean>;
      /** What the box was last asked to stream: 4:4:4 or not; null before any, as the display may keep the last viewers' choice. */
      fullColour: boolean | null;
      /** Whether the box was last asked to draw its cursor into the video; null before any. */
      cursor: boolean | null;
    }
  >();
  const selkiesBox = (boxId: string, open: OpenStream): SelkiesBox => {
    const entry = selkiesBoxes.get(boxId) ?? {
      box: new SelkiesBox(open, { onError: (error) => deps.logError("open the Selkies input", error) }),
      viewers: 0,
      relays: new Set(),
      colours: new Map(),
      fullColour: null,
      cursor: null,
    };
    entry.viewers += 1;
    selkiesBoxes.set(boxId, entry);
    return entry.box;
  };
  /**
   * Streams a box's display in 4:4:4 while every viewer says it decodes it, and in 4:2:0 otherwise: Selkies sets it for
   * the whole display. It waits for every viewer to say: one that has not, as a page from before this, keeps it as it is.
   */
  const colourFor = (boxId: string): void => {
    const entry = selkiesBoxes.get(boxId);
    if (!entry || !entry.relays.size || [...entry.relays].some((relay) => !entry.colours.has(relay))) return;
    const want = [...entry.colours.values()].every(Boolean);
    if (want === entry.fullColour) return;
    entry.fullColour = want;
    entry.box.fullColour(want).catch((error) => deps.logError("set the desktop's colour", error));
  };
  /**
   * The box's cursor in its video (the owner's notes of 17 October 2026): out
   * while a person holds control, whose browser shows the cursor's shape, so
   * the two do not drift apart; in while the agent holds control, so a
   * watcher sees where it points. One capture serves every viewer, so a person watching another
   * person's control sees no cursor in the video either. Only a display that
   * says how (its capability's cursor) is asked.
   */
  const cursorFor = (boxId: string): void => {
    const entry = selkiesBoxes.get(boxId);
    if (!entry || !entry.relays.size) return;
    void (async () => {
      // The box's own video display, which says it where the box's image can, not the kind's.
      const how = (await selkiesDisplay(boxes, boxId).catch(() => null))?.cursor;
      if (!how) return;
      const view = control.view(boxId);
      const want = view.owner !== "human";
      if (want === entry.cursor) return;
      entry.cursor = want;
      await entry.box.cursorInVideo(want, how);
    })().catch((error) => deps.logError("set the desktop's cursor", error));
  };
  /**
   * The box's pointer in its VNC display's picture, where the display can
   * take it out (its pointer, as on Sway, #707): out while a person holds
   * control, so only their browser's pointer shows, not a painted one
   * trailing it; in otherwise, so a watcher sees where the agent points.
   * Asked at each change of control and as a viewer connects.
   */
  const pointerFor = (boxId: string): void => {
    void (async () => {
      const shown = await display(boxes, boxId).catch(() => null);
      if (!shown?.pointer) return;
      await shown.pointer(control.view(boxId).owner !== "human");
    })().catch((error) => deps.logError("show or hide the desktop's pointer", error));
  };
  const leftSelkies = (boxId: string, relay: SelkiesRelay | null) => {
    const entry = selkiesBoxes.get(boxId);
    if (relay) {
      entry?.relays.delete(relay);
      entry?.colours.delete(relay);
    }
    if (entry && entry.viewers > 1) colourFor(boxId);
    if (!entry || --entry.viewers > 0) return;
    selkiesBoxes.delete(boxId);
    frameSizes.delete(boxId);
    void entry.box.close();
  };
  /** The size of each box's video, as its frames last gave it. */
  const frameSizes = new Map<string, Size>();
  /**
   * Restarts a box's video capture, so it takes the desktop's size: Selkies
   * moves a running capture to a larger desktop without its encoder, so the
   * picture keeps its old size, cut from the desktop's top left. A capture
   * that no viewer wants stops, and the next starts at the desktop's size.
   */
  const restartVideo = async (boxId: string): Promise<void> => {
    const paused = [...(selkiesBoxes.get(boxId)?.relays ?? [])].filter((relay) => relay.pause());
    if (!paused.length) return;
    await new Promise((resolve) => setTimeout(resolve, RESTART_PAUSE_MS));
    for (const relay of paused) relay.resume();
  };
  /** Whether a box's video is Selkies on Linux, which follows its RFB desktop's size only when told; a Mac's follows its screen itself (060). */
  const followsByRfb = async (boxId: string): Promise<boolean> => (await boxes.find(boxId))?.capabilities.os === "linux";
  /**
   * Has a box's Selkies capture its desktop at the size the desktop has now,
   * read through its RFB display, while it has Selkies viewers. Selkies
   * follows a desktop that shrinks, not one that grows.
   */
  const followSize = async (boxId: string, shown?: Display): Promise<void> => {
    const entry = selkiesBoxes.get(boxId);
    if (!entry || !(await followsByRfb(boxId))) return;
    const size = await desktopSize(displayOpener(shown ?? (await display(boxes, boxId))));
    await entry.box.follow(size);
    const seen = frameSizes.get(boxId);
    if (seen && (size.width > seen.width || size.height > seen.height)) await restartVideo(boxId);
  };
  /** Each box's check that its video has the desktop's size, while one runs. */
  const matching = new Map<string, Promise<void>>();
  /** A Selkies viewer's frames are `size`: when the desktop has another, as one that grew while no viewer had it follow, the video follows. */
  const matchSize = (boxId: string, size: Size): void => {
    if (matching.has(boxId)) return;
    const check = (async () => {
      const entry = selkiesBoxes.get(boxId);
      if (!entry || !(await followsByRfb(boxId))) return;
      const desktop = await desktopSize(displayOpener(await display(boxes, boxId)));
      // Selkies makes a size even: a desktop an odd width or height has is one pixel larger than its video.
      if (desktop.width - (desktop.width % 2) !== size.width || desktop.height - (desktop.height % 2) !== size.height) {
        await entry.box.follow(desktop);
        await restartVideo(boxId);
      }
    })()
      .catch((error) => deps.logError("have the video follow the desktop's size", error))
      .finally(() => matching.delete(boxId));
    matching.set(boxId, check);
  };
  /**
   * Sets a box's desktop to a Selkies viewer's size, through its RFB display,
   * then has Selkies capture it at that size. Its width is a multiple of 8 and
   * its height even: Selkies widens the screen to the one, and narrows its
   * video to the other.
   */
  const sizeForSelkies = async (boxId: string, size: Size): Promise<void> => {
    // A High resolution desktop keeps its density: the viewer's size, in its CSS pixels, at High resolution's scale.
    const sharp = await kv.get<SharpKept>(`${SHARP_PREFIX}${boxId}`);
    const wanted = sharp ? scaled(size, SHARP_SCALE) : size;
    if (sharp) await kv.set(`${SHARP_PREFIX}${boxId}`, { ...sharp, size: wanted } satisfies SharpKept);
    await setSize(boxId, wanted);
  };
  /** Sets a box's desktop to `size` through its RFB display, then has its video follow. */
  const setSize = async (boxId: string, size: Size): Promise<void> => {
    const shown = await display(boxes, boxId);
    const min = shown.minSize;
    const step = (value: number, least: number, by: number) => Math.max(value, least) - (Math.max(value, least) % by);
    const raised = { width: step(size.width, min?.width ?? 0, 8), height: step(size.height, min?.height ?? 0, 2) };
    await resizes.request(
      boxId,
      async (each) => {
        await restoreSize(displayOpener(shown), each, SELKIES_SCREEN);
        if (shown.resize) await shown.resize(each);
        await followSize(boxId, shown);
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
        if (selkies) leftSelkies(boxId, relay instanceof SelkiesRelay ? relay : null);
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
              onSize: (size) => {
                control.seen(boxId, size);
                frameSizes.set(boxId, size);
                matchSize(boxId, size);
              },
              onResize: (size) => {
                control.resized(boxId, viewer, SELKIES_SCREEN);
                sizeForSelkies(boxId, size).catch((error) => deps.logError("resize the desktop", error));
              },
              onFullColour: (yes) => {
                const entry = selkiesBoxes.get(boxId);
                if (!entry || !relay || !(relay instanceof SelkiesRelay)) return;
                entry.colours.set(relay, yes);
                colourFor(boxId);
              },
              onEnd,
            });
            selkiesBoxes.get(boxId)?.relays.add(relay);
            keepSharp(boxId);
            cursorFor(boxId);
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
                // Video viewers of the same desktop follow, once the box has taken the size.
                if (selkiesBoxes.has(boxId)) {
                  setTimeout(() => void followSize(boxId).catch((error) => deps.logError("have the video follow the desktop's size", error)), FOLLOW_AFTER_MS);
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
          if (!selkies) {
            keepSharp(boxId);
            pointerFor(boxId);
          }
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

  /** Each box's High resolution change or check, while one runs: one at a time. */
  const sharping = new Map<string, Promise<void>>();
  const serialSharp = (boxId: string, task: () => Promise<void>): Promise<void> => {
    const run = (sharping.get(boxId) ?? Promise.resolve()).catch(() => undefined).then(task);
    const kept = run.finally(() => {
      if (sharping.get(boxId) === kept) sharping.delete(boxId);
    });
    sharping.set(boxId, kept.catch(() => undefined));
    return run;
  };
  /** Runs one of High resolution's scripts in the box's desktop session, Xfce's or Windows', and gives what it printed. */
  const xfce = async (box: BoxRecord, script: string): Promise<string> => {
    const result = await boxes.runOwn(box, script, { session: "desktop", timeoutMs: SHARP_TIMEOUT_MS, maxOutputBytes: 4096 });
    const who = box.capabilities.os === "windows" ? "Windows" : "Xfce";
    if (result.exitCode !== 0) throw new Error(`${who} in box ${box.name} did not change its scale: ${result.stderr.trim().split("\n").at(-1) || `exit code ${result.exitCode}`}`);
    return result.stdout.trim();
  };
  /**
   * The desktop at High resolution's scale. Windows caps its scaling by the
   * display's mode, so it is set to twice the pixels first, then to 200%;
   * Xfce takes its scale first. Gives the Xfce theme from before, or "".
   */
  const sharpOn = async (box: BoxRecord, boxId: string, size: Size): Promise<string> => {
    if (box.capabilities.os === "windows") {
      await setSize(boxId, size);
      await xfce(box, scaleScript(200));
      return "";
    }
    const theme = (await xfce(box, SHARP_ON)) || "Arc";
    await setSize(boxId, size);
    return theme;
  };
  /**
   * A High resolution box's desktop as High resolution left it, as a viewer connects: a box that started again comes back at its first
   * size, with Xfce still at 2x, so its size is set again, and Xfce's scale with it.
   */
  const keepSharp = (boxId: string): void => {
    void serialSharp(boxId, async () => {
      const kept = await kv.get<SharpKept>(`${SHARP_PREFIX}${boxId}`);
      const box = kept ? await boxes.find(boxId) : null;
      if (!kept || !box || box.state !== "ready") return;
      const now = await desktopSize(displayOpener(await display(boxes, boxId)));
      if (now.width === kept.size.width && now.height === kept.size.height) return;
      await sharpOn(box, boxId, kept.size);
    }).catch((error) => deps.logError("keep the desktop at high resolution", error));
  };

  return {
    control,
    path: `/api/v1/plugins/${encodeURIComponent(bb.pluginId)}/http${DESKTOP_ROUTE}`,
    async sharp(boxId) {
      const box = await boxes.find(boxId);
      if (!box || !sharpOffered(box)) return null;
      return !!(await kv.get<SharpKept>(`${SHARP_PREFIX}${boxId}`));
    },
    setSharp(boxId, on) {
      return serialSharp(boxId, async () => {
        const box = await boxes.find(boxId);
        if (!box || box.state !== "ready") throw new Error("The box is not running, so its desktop cannot change.");
        if (!sharpOffered(box)) throw new Error(`Box ${box.name}'s desktop cannot be at high resolution: only Linux desktops drawn by the CPU and Windows desktops shown as video can.`);
        const key = `${SHARP_PREFIX}${boxId}`;
        const kept = await kv.get<SharpKept>(key);
        if (on === !!kept) return;
        const now = await desktopSize(displayOpener(await display(boxes, boxId)));
        if (on) {
          const size = scaled(now, SHARP_SCALE);
          // Kept first, so a resize while it changes keeps the density; and forgotten if it fails.
          await kv.set(key, { theme: "", size } satisfies SharpKept);
          control.rescale(boxId, SHARP_SCALE);
          try {
            const theme = await sharpOn(box, boxId, size);
            await kv.set(key, { theme, size } satisfies SharpKept);
          } catch (error) {
            await kv.delete(key);
            control.rescale(boxId, 1 / SHARP_SCALE);
            // Windows took twice the pixels before its scale failed: its size back.
            if (box.capabilities.os === "windows") await setSize(boxId, now).catch((cause) => deps.logError("put the desktop's size back", cause));
            throw error;
          }
        } else {
          // Windows at 100% first, as it caps the scale of a smaller mode.
          await xfce(box, box.capabilities.os === "windows" ? scaleScript(100) : sharpOff(kept!.theme || "Arc"));
          await kv.delete(key);
          control.rescale(boxId, 1 / SHARP_SCALE);
          await setSize(boxId, scaled(now, 1 / SHARP_SCALE));
        }
        changed(boxId);
      });
    },
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
