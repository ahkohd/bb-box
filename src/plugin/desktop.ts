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
import { macClipboardWatchCommand, startClipboardWatch, type ClipboardWatch } from "../core/mac-clipboard.ts";
import { RfbRelay, desktopSize, displayOpener, restoreSize, type OpenDisplay, type Size } from "../core/relay.ts";
import type { Screen } from "../core/rfb.ts";
import { DEVICE_PATHS, SelkiesBox, SelkiesRelay, type OpenStream } from "../core/selkies.ts";
import { DEVICE_DISPLAY, desktopDisplays, deviceDisplayOf } from "../backends/types.ts";
import { currentKindId, kindInfo } from "../backends/kinds.ts";
import { scaleScript } from "../backends/windows.ts";
import { openRoute } from "../transports/route.ts";
import { LEFT_TO_STREAM_SERVER, type BoxPointer, type ByteChannel, type Display } from "../transports/types.ts";
import { argbToRgba, rgbaPng } from "../core/png.ts";
import { POINTER_NONE, POINTER_VERB } from "../core/pointer.ts";
import { LEVEL_52_MACROBLOCKS, macroblocks } from "../core/h264.ts";

export const DESKTOP_ROUTE = "/desktop";
const VIEWER_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** Each person's control, for the plugin's next instance (045). */
const KEPT_KEY = "desktop-control";
/** The most text bb-box reads from a desktop's clipboard with its own commands (#464): more is left for the box's own copy. */
const MAX_CLIPBOARD_BYTES = 4 * 1024 * 1024;
/** How long reading or writing a box's clipboard with a command may take. */
const CLIPBOARD_TIMEOUT_MS = 10_000;
const CLIPBOARD_WATCH_IDLE_MS = 10_000;
const CLIPBOARD_WATCH_RETRY_MS = 30_000;
/** How long after a VNC viewer's resize its desktop's video viewers follow: the box takes a size in a few milliseconds. */
const FOLLOW_AFTER_MS = 300;
/** How long after bb-box-cursor ends, as when the desktop restarts, it runs again while the box has video viewers (060). */
const POINTER_AGAIN_MS = 2_000;

/** What hears a box's pointer (060): each message, and, where the box's image has no helper, that none will come. */
interface PointerListener {
  send(message: string): void;
  none?(): void;
}
/** How long a box's video stays stopped for its capture to restart: Selkies stops a capture within milliseconds. */
const RESTART_PAUSE_MS = 300;
/**
 * How long a box's video may take to show a size Selkies was told, before bb-box restarts its capture. With no person in control,
 * Selkies moves its capture to the new size itself, and a pause while it does breaks its reconfiguration, leaving its own monitor
 * at the old size; with one, it stops its capture and waits to be restarted, whether the desktop grew or shrank (the owner's note
 * of 18 October 2026).
 */
export const FOLLOW_FRAME_MS = 1_000;
/** How many times bb-box restarts a box's capture for a size before it leaves it: a restart now and then brings no frame. */
const FOLLOW_TRIES = 3;
/** Each box whose desktop is High resolution: its xfwm theme before, and the size High resolution set (the owner's note of 16 October 2026). */
const SHARP_PREFIX = "desktop-sharp/";
/** High resolution's density: twice the pixels, with Xfce's UI scaled to match, so everything keeps its size and text is sharp on a 2x screen. */
const SHARP_SCALE = 2;
/** How long Xfce may take to change its scale. */
const SHARP_TIMEOUT_MS = 30_000;
/** The largest desktop High resolution sets: Xvnc's limit is far above it, Selkies' encoder is not. */
const SHARP_MAX: Size = { width: 7680, height: 4320 };

/**
 * Xfce's panel again, so it takes a new scale, in the background. A restarted panel runs itself again, and that one can find the old
 * one still on D-Bus and quit; where no session manager starts it again, as on Docker, the panel is gone, and the next restart shows
 * "Failed to restart the panel" (the owner's note of 18 October 2026). So only a running panel restarts, and one starts if none runs
 * 3 s later.
 */
const PANEL_AGAIN =
  '(if pgrep -u "$(id -u)" -x xfce4-panel >/dev/null; then xfce4-panel -r; fi; ' +
  'sleep 3; pgrep -u "$(id -u)" -x xfce4-panel >/dev/null || setsid xfce4-panel </dev/null >/dev/null 2>&1 &) >/dev/null 2>&1 &';
/** Xfce at High resolution's scale: GTK's window scale, xfwm's HiDPI theme, and the panel again so it takes the scale. Prints the theme before. */
const SHARP_ON =
  "t=$(xfconf-query -c xfwm4 -p /general/theme 2>/dev/null); " +
  `xfconf-query -c xsettings -p /Gdk/WindowScalingFactor -s ${SHARP_SCALE} 2>/dev/null || xfconf-query -c xsettings -p /Gdk/WindowScalingFactor -n -t int -s ${SHARP_SCALE}; ` +
  `xfconf-query -c xfwm4 -p /general/theme -s Default-xhdpi; ${PANEL_AGAIN} printf '%s' "$t"`;
/** Xfce back at 1x, with the theme it had. */
function sharpOff(theme: string): string {
  const quoted = `'${theme.replaceAll("'", `'\\''`)}'`;
  return `xfconf-query -c xsettings -p /Gdk/WindowScalingFactor -s 1; xfconf-query -c xfwm4 -p /general/theme -s ${quoted}; ${PANEL_AGAIN}`;
}

interface SharpKept {
  readonly theme: string;
  readonly size: Size;
  /** The size it is High resolution of: the viewer's, or the desktop's before; its size is twice this, as viewers' browsers decode. */
  readonly of?: Size;
}

/**
 * Whether a box's desktop can be High resolution: a Linux X11 desktop drawn by the CPU, which Selkies streams, or a
 * Windows desktop on x86_64 streamed as video, at 200% (the owner's note of 18 October 2026). Not a Wayland desktop,
 * which has video too: the owner has it on hold (#707). Nor Windows on arm64, on a Mac: it has not been tried there, and
 * its encoder already limits the video at 1x (060).
 */
export function sharpOffered(box: BoxRecord): boolean {
  const video = desktopDisplays(box.capabilities.displays).some((each) => each.protocol === "selkies");
  const x11 = kindInfo(currentKindId(box.kind)).windowing === "x11";
  return video && ((box.capabilities.os === "linux" && !box.capabilities.gpu && x11) || (box.capabilities.os === "windows" && box.capabilities.arch === "x86_64"));
}

/**
 * `size` times `factor`, within High resolution's largest and at least 640x480, and within `most` macroblocks a frame: the largest
 * every viewer's browser decodes (#864), level 5.2's by default, as Safari's decoder refuses level 6 (the owner's notes of 19 October
 * 2026). Smaller in proportion, in whole macroblocks.
 */
function scaled(size: Size, factor: number, most = LEVEL_52_MACROBLOCKS): Size {
  const width = Math.min(SHARP_MAX.width, Math.max(640, Math.round(size.width * factor)));
  const height = Math.min(SHARP_MAX.height, Math.max(480, Math.round(size.height * factor)));
  const over = macroblocks(width, height) / most;
  if (over <= 1) return { width, height };
  const shrink = Math.sqrt(1 / over);
  return { width: Math.floor((width * shrink) / 16) * 16, height: Math.floor((height * shrink) / 16) * 16 };
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
  controlChanged?(boxId: string): void;
  openDevice?(box: BoxRecord): Promise<ByteChannel>;
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
  /** Whether the box's desktop is switching High resolution on or off now: its viewers hold their last picture until it is done. */
  switching(boxId: string): boolean;
  dispose(): Promise<void>;
}

/** The screen a Selkies viewer's resize sets, through the RFB display: screen 0, as noVNC's before the server names one. */
const SELKIES_SCREEN: Screen = { id: 0, flags: 0 };

async function readyBox(boxes: Boxes, boxId: string, what: string): Promise<BoxRecord> {
  const box = await boxes.find(boxId);
  if (!box) throw new Error("bb-box has no such box. It may have been released.");
  if (box.state !== "ready") throw new Error(`Box ${box.name} is not running, so its ${what} cannot show.`);
  return box;
}

/** The box's displays, when it is running and has one. */
async function displays(boxes: Boxes, boxId: string): Promise<readonly Display[]> {
  const box = await readyBox(boxes, boxId, "desktop");
  const found = (await boxes.transports(box)).displays.filter((each) => each.id !== DEVICE_DISPLAY.id);
  if (!found.length || !desktopDisplays(box.capabilities.displays).length) throw new Error(`Box ${box.name} has no desktop.`);
  return found;
}

/** The RFB display: the box's first. Control and sizes go through it. */
async function display(boxes: Boxes, boxId: string): Promise<Display> {
  const [first] = await displays(boxes, boxId);
  if (first!.protocol !== "rfb") throw new Error(`The viewer cannot show a ${first!.protocol} desktop yet.`);
  return first!;
}

async function deviceBoxRecord(boxes: Boxes, boxId: string): Promise<BoxRecord> {
  const box = await readyBox(boxes, boxId, "device");
  if (!deviceDisplayOf(box.capabilities.displays)) throw new Error(`Box ${box.name} has no device.`);
  return box;
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

export { POINTER_NONE, POINTER_VERB };

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
  const followFrameMs = FOLLOW_FRAME_MS;
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
      deps.controlChanged?.(boxId);
      // A person took control of a box with Selkies viewers: its input connection opens now, not at their first key.
      if (control.view(boxId).owner === "human") {
        selkiesBoxes.get(boxId)?.box.warm();
        deviceBoxes.get(boxId)?.box.warm();
      }
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
      const resize = shown.resize;
      if (resize && (await tellsSizeFirst(boxId))) {
        await resizes.request(boxId, (each) => sizeFirst(boxId, each, resize), size);
        return;
      }
      // SetDesktopSize first, even when the backend resizes: a GPU desktop
      // can come back on the CPU after a stop and start, and take it (021).
      await restoreSize(displayOpener(shown), size, screen);
      if (shown.resize) {
        await resizes.request(
          boxId,
          async (each) => {
            await shown.resize!(each);
          },
          size,
        );
      }
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
      /** The largest frame each viewer's browser decodes, in macroblocks, as it said (#864). */
      decodes: Map<SelkiesRelay, number>;
      /** What the box was last asked to stream: 4:4:4 or not; null before any, as the display may keep the last viewers' choice. */
      fullColour: boolean | null;
      /** Whether the box was last asked to draw its cursor into the video; null before any. */
      cursor: boolean | null;
    }
  >();
  /** Boxes whose video comes from elsewhere than their stream server, as their display said when its input opened (#865). */
  const videoApart = new Set<string>();
  const selkiesBox = (boxId: string): SelkiesBox => {
    // The input goes to the box's stream server: the display's openInput where its video comes from elsewhere.
    const open: OpenStream = async (signal) => {
      const shown = await selkiesDisplay(boxes, boxId);
      if (shown.openInput) videoApart.add(boxId);
      else videoApart.delete(boxId);
      return openRoute((await (shown.openInput ?? shown.open).call(shown, signal)).route, signal);
    };
    const entry = selkiesBoxes.get(boxId) ?? {
      box: new SelkiesBox(open, {
        onError: (error) => deps.logError("open the Selkies input", error),
        apart: () => videoApart.has(boxId),
        // The clipboard and the pointer's shape, which reach the viewers no other way.
        onText: (message) => {
          for (const relay of selkiesBoxes.get(boxId)?.relays ?? []) relay.fromBox(message);
        },
      }),
      viewers: 0,
      relays: new Set(),
      colours: new Map(),
      decodes: new Map(),
      fullColour: null,
      cursor: null,
    };
    entry.viewers += 1;
    selkiesBoxes.set(boxId, entry);
    return entry.box;
  };
  const deviceBoxes = new Map<string, { box: SelkiesBox; viewers: number; relays: Set<SelkiesRelay> }>();
  const deviceStream = (boxId: string): OpenStream => async () => {
    const box = await deviceBoxRecord(boxes, boxId);
    if (!deps.openDevice) throw new Error(`bb-box cannot reach box ${box.name}'s device server.`);
    return deps.openDevice(box);
  };
  const deviceBox = (boxId: string): SelkiesBox => {
    const entry = deviceBoxes.get(boxId) ?? {
      box: new SelkiesBox(deviceStream(boxId), {
        paths: DEVICE_PATHS,
        spacingMs: 0,
        apart: () => true,
        onError: (error) => deps.logError("open the device's input", error),
        onText: (message) => {
          for (const relay of deviceBoxes.get(boxId)?.relays ?? []) relay.fromBox(message);
        },
      }),
      viewers: 0,
      relays: new Set<SelkiesRelay>(),
    };
    entry.viewers += 1;
    deviceBoxes.set(boxId, entry);
    return entry.box;
  };
  const leftDevice = (boxId: string, relay: SelkiesRelay | null): void => {
    const entry = deviceBoxes.get(boxId);
    if (!entry) return;
    if (relay) entry.relays.delete(relay);
    if (--entry.viewers > 0) return;
    deviceBoxes.delete(boxId);
    void entry.box.close();
  };
  /**
   * Each box's pointer from bb-box-cursor, where its image has it (060), while anything listens: its video viewers and its
   * VNC viewers' pointer streams. Sway 1.11's streams send neither its shape nor where it is. One helper runs a box, and again
   * if it ends, as when the desktop restarts; the last image and position are kept for a listener that comes later.
   */
  const pointers = new Map<string, { feed: AbortController; own: boolean; image: string | null; at: string | null; listeners: Set<PointerListener> }>();
  /**
   * Has `listener` told each change of a box's pointer, and the pointer as it is first; or, where the box's image has no
   * helper, that there is none. Gives what stops it.
   */
  const listenPointer = (boxId: string, listener: PointerListener): (() => void) => {
    let entry = pointers.get(boxId);
    if (!entry) {
      const created = { feed: new AbortController(), own: false, image: null, at: null, listeners: new Set<PointerListener>() };
      pointers.set(boxId, created);
      entry = created;
      void (async () => {
        const feed = created.feed;
        const shown = await display(boxes, boxId).catch(() => null);
        const follow = shown?.followPointer;
        if (feed.signal.aborted) return;
        if (!follow) {
          for (const each of [...created.listeners]) each.none?.();
          return;
        }
        created.own = true;
        while (!feed.signal.aborted) {
          await follow((event) => boxPointer(created, event), feed.signal).catch((error) => {
            if (!feed.signal.aborted) deps.logError("follow the desktop's pointer", error);
          });
          if (!feed.signal.aborted) await new Promise((resolve) => setTimeout(resolve, POINTER_AGAIN_MS));
        }
      })();
    }
    const listening = entry;
    listening.listeners.add(listener);
    for (const message of [listening.image, listening.at]) if (message) listener.send(message);
    return () => {
      listening.listeners.delete(listener);
      if (listening.listeners.size || pointers.get(boxId) !== listening) return;
      listening.feed.abort();
      pointers.delete(boxId);
    };
  };
  /**
   * A change of a box's pointer, to each listener, and kept for the next: the shape as Selkies' own cursor message, which
   * the panel shows the person with control, and where it is, which the panel draws for people watching.
   */
  const boxPointer = (entry: { image: string | null; at: string | null; listeners: Set<PointerListener> }, event: BoxPointer): void => {
    let message: string;
    if (event.type === "image") {
      const png = rgbaPng(event.width, event.height, argbToRgba(event.argb)).toString("base64");
      message = `cursor,${JSON.stringify({ curdata: png, hotx: event.hotX, hoty: event.hotY })}`;
      entry.image = message;
    } else if (event.type === "shape") {
      message = event.message;
      entry.image = message;
    } else if (event.type === "position") {
      message = `${POINTER_VERB},${event.x},${event.y}`;
      entry.at = message;
    } else if (event.type === "leave") {
      message = `${POINTER_VERB},`;
      entry.at = message;
    } else return;
    for (const listener of entry.listeners) listener.send(message);
  };
  /** What each video viewer's relay stops listening to the box's pointer with. */
  const unlistens = new Map<SelkiesRelay, () => void>();
  /**
   * Streams a box's display in 4:4:4 while every viewer says it decodes it, and in 4:2:0 otherwise: Selkies sets it for
   * the whole display. It waits for every viewer to say: one that has not, as a page from before this, keeps it as it is.
   */
  /**
   * The largest frame every viewer of a box's video decodes, in macroblocks: one that has not said, as a page from before this, or
   * with none watching, level 5.2's, which every browser decodes (#864).
   */
  const decodesFor = (boxId: string): number => {
    const entry = selkiesBoxes.get(boxId);
    if (!entry?.relays.size) return LEVEL_52_MACROBLOCKS;
    return Math.min(...[...entry.relays].map((relay) => entry.decodes.get(relay) ?? LEVEL_52_MACROBLOCKS));
  };
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
    const next = (pointerRuns.get(boxId) ?? Promise.resolve())
      .then(async () => {
        const shown = await display(boxes, boxId).catch(() => null);
        if (!shown?.pointer) return;
        const view = control.view(boxId);
        // Where the display says so, only while the person watches it, by the viewer they took control with.
        const watching = shown.pointerWhile !== "rfb" || (view.holder !== null && (rfbViewers.get(boxId)?.get(view.holder) ?? 0) > 0);
        await shown.pointer(!(view.owner === "human" && watching));
      })
      .catch((error) => deps.logError("show or hide the desktop's pointer", error));
    // One at a time for each box, each as control and viewers are when it runs.
    pointerRuns.set(boxId, next);
    void next.then(() => {
      if (pointerRuns.get(boxId) === next) pointerRuns.delete(boxId);
    });
  };
  /** Each box's RFB viewers, by viewer ID, with how many connections each has. */
  const rfbViewers = new Map<string, Map<string, number>>();
  const pointerRuns = new Map<string, Promise<void>>();
  const rfbViewer = (boxId: string, viewer: string, change: 1 | -1): void => {
    const viewers = rfbViewers.get(boxId) ?? new Map<string, number>();
    const count = (viewers.get(viewer) ?? 0) + change;
    if (count > 0) viewers.set(viewer, count);
    else viewers.delete(viewer);
    if (viewers.size) rfbViewers.set(boxId, viewers);
    else rfbViewers.delete(boxId);
  };
  const leftSelkies = (boxId: string, relay: SelkiesRelay | null) => {
    const entry = selkiesBoxes.get(boxId);
    if (relay) {
      entry?.relays.delete(relay);
      entry?.colours.delete(relay);
      entry?.decodes.delete(relay);
      unlistens.get(relay)?.();
      unlistens.delete(relay);
    }
    if (entry && entry.viewers > 1) {
      colourFor(boxId);
      fitSharp(boxId);
    }
    if (!entry || --entry.viewers > 0) return;
    selkiesBoxes.delete(boxId);
    videoApart.delete(boxId);
    frameSizes.delete(boxId);
    void entry.box.close();
  };
  /** The size of each box's video, as its frames last gave it. */
  const frameSizes = new Map<string, Size>();
  /** What waits for each box's video to show a size. */
  const frameWaits = new Map<string, Set<(size: Size) => void>>();
  /** Whether a frame of the box's video shows `size`, as Selkies makes it even, within `ms`. */
  const videoAt = (boxId: string, size: Size, ms: number): Promise<boolean> => {
    const even = (each: Size) => `${each.width - (each.width % 2)}x${each.height - (each.height % 2)}`;
    const want = even(size);
    const now = frameSizes.get(boxId);
    if (now && even(now) === want) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waits = frameWaits.get(boxId) ?? new Set();
      frameWaits.set(boxId, waits);
      const done = (shown: boolean) => {
        clearTimeout(timer);
        waits.delete(wake);
        if (!waits.size) frameWaits.delete(boxId);
        resolve(shown);
      };
      const wake = (seen: Size) => {
        if (even(seen) === want) done(true);
      };
      const timer = setTimeout(() => done(false), ms);
      waits.add(wake);
    });
  };
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
  /**
   * Has a box's video show `size`, which Selkies was told: its capture restarts each time no frame of that size comes in time. With
   * no viewer wanting video, as with every tab hidden, no frame comes and none is waited for: the next capture starts at the
   * desktop's size, and a hand-back returns once the desktop is restored.
   */
  const showSize = async (boxId: string, size: Size): Promise<void> => {
    const watched = () => [...(selkiesBoxes.get(boxId)?.relays ?? [])].some((relay) => relay.wantsVideo);
    for (let tries = 0; tries < FOLLOW_TRIES && watched(); tries++) {
      if (await videoAt(boxId, size, followFrameMs)) return;
      await restartVideo(boxId);
    }
  };
  /** Whether a box's video is Selkies on Linux, which follows its RFB desktop's size only when told; a Mac's follows its screen itself (060). */
  const followsByRfb = async (boxId: string): Promise<boolean> => (await boxes.find(boxId))?.capabilities.os === "linux";
  /**
   * Has a box's Selkies capture its desktop at the size the desktop has now,
   * as just set or read through its RFB display, while it has Selkies
   * viewers, and restarts the capture when the video does not show that size
   * in time.
   */
  const followSize = async (boxId: string, shown?: Display, set?: Size): Promise<void> => {
    const entry = selkiesBoxes.get(boxId);
    if (!entry || !(await followsByRfb(boxId))) return;
    const size = set ?? (await desktopSize(displayOpener(shown ?? (await display(boxes, boxId)))));
    await entry.box.follow(size);
    if (frameSizes.has(boxId)) await showSize(boxId, size);
  };
  /** Whether a box's video is told a new size before its desktop takes it, as Selkies on Sway (060). */
  const tellsSizeFirst = async (boxId: string): Promise<boolean> =>
    desktopDisplays((await boxes.find(boxId))?.capabilities.displays ?? []).some((each) => each.protocol === "selkies" && each.tellSize === "first");
  /**
   * Sets a box's desktop to `size` with its backend's resize, having told its
   * video the size first, while it has Selkies viewers. A resize that fails
   * has the video follow the size the desktop kept.
   */
  const sizeFirst = async (boxId: string, size: Size, resize: NonNullable<Display["resize"]>): Promise<void> => {
    const entry = selkiesBoxes.get(boxId);
    if (entry) await entry.box.follow(size);
    try {
      await resize(size);
    } catch (error) {
      if (entry) await followSize(boxId).catch((caught) => deps.logError("have the video follow the desktop's size", caught));
      throw error;
    }
    if (entry && frameSizes.has(boxId)) await showSize(boxId, size);
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
        await showSize(boxId, desktop);
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
    const wanted = sharp ? scaled(size, SHARP_SCALE, decodesFor(boxId)) : size;
    if (sharp) await kv.set(`${SHARP_PREFIX}${boxId}`, { ...sharp, size: wanted, of: size } satisfies SharpKept);
    await setSize(boxId, wanted);
  };
  /** Sets a box's desktop to `size` through its RFB display, then has its video follow. */
  const setSize = async (boxId: string, size: Size): Promise<void> => {
    const shown = await display(boxes, boxId);
    const min = shown.minSize;
    const step = (value: number, least: number, by: number) => Math.max(value, least) - (Math.max(value, least) % by);
    const raised = { width: step(size.width, min?.width ?? 0, 8), height: step(size.height, min?.height ?? 0, 2) };
    const resize = shown.resize;
    if (resize && (await tellsSizeFirst(boxId))) {
      await resizes.request(boxId, (each) => sizeFirst(boxId, each, resize), raised);
      return;
    }
    await resizes.request(
      boxId,
      async (each) => {
        if (shown.resize) {
          if ((await shown.resize(each)) === LEFT_TO_STREAM_SERVER) await restoreSize(displayOpener(shown), each, SELKIES_SCREEN);
          await followSize(boxId, shown, each);
          return;
        }
        await restoreSize(displayOpener(shown), each, SELKIES_SCREEN);
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
    return box?.state === "ready" && desktopDisplays(box.capabilities.displays)[0]?.clipboard === "commands" && clipboardCommands(box.capabilities.os) ? box : null;
  };
  /**
   * One read of a box's clipboard at a time, which the next calls share: a Windows desktop's read takes seconds,
   * longer than the viewer's poll (#461), so reads would pile up in the box.
   */
  const reading = new Map<string, Promise<void>>();
  /** Pastes into each box so far: a read that began before a paste found the old text, which must not come back as a copy. */
  const pastes = new Map<string, number>();
  const watches = new Map<string, { live: boolean; idle: ReturnType<typeof setTimeout>; readonly abort: AbortController; watch: ClipboardWatch | null }>();
  const watchRetry = new Map<string, number>();
  const ownPastes = new Map<string, string>();
  const copiedInBox = (boxId: string, text: string) => {
    if (ownPastes.get(boxId) === text) {
      ownPastes.delete(boxId);
      return;
    }
    ownPastes.delete(boxId);
    clipboards.set(boxId, { text, serial: ++clipboardSerial });
  };
  const stopWatch = (boxId: string) => {
    const entry = watches.get(boxId);
    if (!entry) return;
    watches.delete(boxId);
    clearTimeout(entry.idle);
    entry.abort.abort();
    void entry.watch?.close().catch(() => undefined);
  };
  const watchingClipboard = (box: BoxRecord): boolean => {
    if (box.capabilities.os !== "macos") return false;
    const running = watches.get(box.id);
    if (running) {
      running.idle.refresh();
      return running.live;
    }
    if (Date.now() < (watchRetry.get(box.id) ?? 0)) return false;
    const entry = { live: false, idle: setTimeout(() => stopWatch(box.id), CLIPBOARD_WATCH_IDLE_MS), abort: new AbortController(), watch: null as ClipboardWatch | null };
    entry.idle.unref?.();
    watches.set(box.id, entry);
    void (async () => {
      const channel = await boxes.spawnOwn(box, macClipboardWatchCommand(), { session: "desktop", signal: entry.abort.signal });
      entry.watch = await startClipboardWatch(channel, (text) => copiedInBox(box.id, text), entry.abort.signal);
      if (entry.abort.signal.aborted) {
        await entry.watch.close().catch(() => undefined);
        return;
      }
      entry.live = true;
      await entry.watch.ended;
    })()
      .catch((error: unknown) => {
        if (!entry.abort.signal.aborted) deps.logError(`watch box ${box.name}'s clipboard`, error);
      })
      .finally(() => {
        if (entry.abort.signal.aborted) return;
        watchRetry.set(box.id, Date.now() + CLIPBOARD_WATCH_RETRY_MS);
        if (watches.get(box.id) === entry) stopWatch(box.id);
      });
    return false;
  };

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
      const keyLog = url.searchParams.get("keylog") === "1" ? (line: string) => bb.log.info(`key log, box ${boxId}, viewer ${viewer.slice(0, 8)}: ${line}`) : undefined;
      const device = url.searchParams.get("display") === DEVICE_DISPLAY.id;
      const selkies = !device && url.searchParams.get("stream") === "selkies";
      // A VNC viewer's own stream of the box's pointer (060): it carries no picture and no input, only the pointer messages a
      // video viewer gets, as RFB has no place for where the box's pointer is.
      const pointerOnly = !device && url.searchParams.get("stream") === "pointer";
      let unlistenPointer: (() => void) | null = null;
      let relay: RfbRelay | SelkiesRelay | null = null;
      let shown: Display | null = null;
      const connection: ViewerConnection = {
        viewer,
        release: () => relay?.release() ?? Promise.resolve(),
        prepareInput: () => {
          if (relay instanceof RfbRelay) relay.prepareInput();
        },
      };
      const onEnd = (by: "viewer" | "box", error: Error | null) => {
        relays.delete(relay!);
        if (device) leftDevice(boxId, relay instanceof SelkiesRelay ? relay : null);
        else if (selkies) leftSelkies(boxId, relay instanceof SelkiesRelay ? relay : null);
        else {
          rfbViewer(boxId, viewer, -1);
          pointerFor(boxId);
        }
        // Control goes back to the agent unless the viewer connects again soon (020), so the log says why it may lose it.
        if (by === "box" && control.mayInput(boxId, viewer)) {
          const why = error?.message ?? "It closed the connection.";
          void boxes
            .find(boxId)
            .then((box) =>
              bb.log.warn(`Box ${box?.name ?? boxId}'s ${device ? "device" : "desktop"} ended the connection of the viewer with control. ${why} Control goes back to the agent unless the viewer connects again within ${reconnectMs / 1000} s.`),
            )
            .catch((caught) => deps.logError("log a desktop's end", caught));
        }
        control.detach(boxId, connection, by);
      };
      return {
        onOpen(socket) {
          if (pointerOnly) {
            if (!VIEWER_ID.test(viewer)) {
              socket.close(1008, "The viewer gave no viewer ID, so it cannot be told apart from other tabs.");
              return;
            }
            unlistenPointer = listenPointer(boxId, {
              send: (message) => void socket.send(message),
              none: () => void socket.close(1000, POINTER_NONE),
            });
            return;
          }
          const end = { send: (message: string | Uint8Array) => socket.send(message), close: (code: number, reason: string) => socket.close(code, reason) };
          if (device) {
            if (!VIEWER_ID.test(viewer)) {
              socket.close(1008, "The viewer gave no viewer ID, so it cannot be told apart from other tabs.");
              return;
            }
            const deviceKeyLog = keyLog ? (line: string) => keyLog(`device: ${line}`) : undefined;
            relay = new SelkiesRelay({ viewer: end, box: deviceBox(boxId), open: deviceStream(boxId), mayInput: () => control.mayInput(boxId, viewer), keyLog: deviceKeyLog, onEnd });
            deviceBoxes.get(boxId)?.relays.add(relay);
          } else if (selkies) {
            if (!VIEWER_ID.test(viewer)) {
              socket.close(1008, "The viewer gave no viewer ID, so it cannot be told apart from other tabs.");
              return;
            }
            const open: OpenStream = async (signal) => openRoute((await (await selkiesDisplay(boxes, boxId)).open(signal)).route, signal);
            relay = new SelkiesRelay({
              viewer: end,
              box: selkiesBox(boxId),
              open,
              mayInput: () => control.mayInput(boxId, viewer),
              keyLog,
              onSize: (size) => {
                control.seen(boxId, size);
                frameSizes.set(boxId, size);
                for (const wake of [...(frameWaits.get(boxId) ?? [])]) wake(size);
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
              onDecodes: (most) => {
                const entry = selkiesBoxes.get(boxId);
                if (!entry || !relay || !(relay instanceof SelkiesRelay)) return;
                entry.decodes.set(relay, most);
                fitSharp(boxId);
              },
              ownCursor: () => pointers.get(boxId)?.own ?? false,
              pointerApart: () => videoApart.has(boxId),
              onEnd,
            });
            // Whether the video comes from elsewhere, which then takes the pointer too, known before the first input.
            void selkiesDisplay(boxes, boxId)
              .then((shownDisplay) => (shownDisplay.openInput ? videoApart.add(boxId) : videoApart.delete(boxId)))
              .catch(() => undefined);
            selkiesBoxes.get(boxId)?.relays.add(relay);
            // The box's pointer from bb-box-cursor (060): as it is, then each change.
            const told = relay;
            unlistens.set(told, listenPointer(boxId, { send: (message) => told.tell(message) }));
            keepSharp(boxId);
            cursorFor(boxId);
            // As after a restart of bb-box, the person in control may come back by video only.
            pointerFor(boxId);
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
              keyLog,
              onServerRestart: (why, error) => {
                void boxes
                  .find(boxId)
                  .then((box) =>
                    bb.log.warn(
                      `Box ${box?.name ?? boxId}'s desktop VNC server ${why}, so bb-box ${error ? `could not restart it: ${error.message}` : "restarted it, and the viewer connects again"}.`,
                    ),
                  )
                  .catch((caught) => deps.logError("log a desktop server's restart", caught));
              },
              onServerInit: (size) => control.seen(boxId, size),
              minSize: () => shown?.minSize ?? null,
              onResize: (size, screen) => {
                control.resized(boxId, viewer, screen);
                // The SetDesktopSize still reaches the box, which answers the viewer.
                const resize = shown?.resize;
                if (resize) {
                  resizes
                    .request(
                      boxId,
                      async (each) => {
                        await resize(each);
                      },
                      size,
                    )
                    .catch((error) => deps.logError("resize the desktop", error));
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
          if (!selkies && !device) {
            rfbViewer(boxId, viewer, 1);
            keepSharp(boxId);
            pointerFor(boxId);
          }
        },
        async onMessage(socket, data) {
          if (pointerOnly) return;
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
          unlistenPointer?.();
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
   * size, with Xfce still at 2x, so its size is set again, and Xfce's scale with it. Windows that started again keeps its size but
   * may come back at 100%, so its scale is set again however its size is: the helper does nothing at 200%.
   */
  const keepSharp = (boxId: string): void => {
    void serialSharp(boxId, async () => {
      const kept = await kv.get<SharpKept>(`${SHARP_PREFIX}${boxId}`);
      const box = kept ? await boxes.find(boxId) : null;
      if (!kept || !box || box.state !== "ready") return;
      const now = await desktopSize(displayOpener(await display(boxes, boxId)));
      if (now.width === kept.size.width && now.height === kept.size.height) {
        if (box.capabilities.os === "windows") await xfce(box, scaleScript(200));
        return;
      }
      await sharpOn(box, boxId, kept.size);
    }).catch((error) => deps.logError("keep the desktop at high resolution", error));
  };

  /**
   * A High resolution Linux desktop at the largest size every viewer of its video decodes (#864): smaller when one that decodes less
   * comes, larger again when it goes, as one change, every viewer holding its picture meanwhile. Only while some viewer watches: the
   * last to go leaves it as it is.
   */
  const fitSharp = (boxId: string): void => {
    void serialSharp(boxId, async () => {
      const key = `${SHARP_PREFIX}${boxId}`;
      const kept = await kv.get<SharpKept>(key);
      if (!kept || !selkiesBoxes.get(boxId)?.relays.size) return;
      const box = await boxes.find(boxId);
      if (!box || box.state !== "ready" || box.capabilities.os !== "linux") return;
      const size = scaled(kept.of ?? scaled(kept.size, 1 / SHARP_SCALE, Infinity), SHARP_SCALE, decodesFor(boxId));
      if (size.width === kept.size.width && size.height === kept.size.height) return;
      switching.add(boxId);
      changed(boxId);
      try {
        await kv.set(key, { ...kept, size } satisfies SharpKept);
        await setSize(boxId, size);
      } finally {
        switching.delete(boxId);
        changed(boxId);
      }
    }).catch((error) => deps.logError("fit the desktop to its viewers' video", error));
  };

  /** Boxes whose desktop is switching High resolution now. */
  const switching = new Set<string>();

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
        // Every viewer holds its last picture from here to the end, so the desktop half way between scales never shows.
        switching.add(boxId);
        changed(boxId);
        try {
          if (on) {
            const size = scaled(now, SHARP_SCALE, decodesFor(boxId));
            // Kept first, so a resize while it changes keeps the density; and forgotten if it fails.
            await kv.set(key, { theme: "", size, of: now } satisfies SharpKept);
            control.rescale(boxId, SHARP_SCALE);
            try {
              const theme = await sharpOn(box, boxId, size);
              await kv.set(key, { theme, size, of: now } satisfies SharpKept);
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
        } finally {
          switching.delete(boxId);
          changed(boxId);
        }
      });
    },
    switching: (boxId) => switching.has(boxId),
    async clipboard(boxId, viewer) {
      const box = viewer && control.mayInput(boxId, viewer) ? await byCommands(boxId) : null;
      if (box && !watchingClipboard(box)) {
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
      if (!control.mayInput(boxId, viewer)) {
        throw new Error("Only the tab with control of the desktop can paste into it. Take control, then paste again.");
      }
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
      if (watches.get(boxId)?.live) ownPastes.set(boxId, text);
    },
    async dispose() {
      for (const boxId of [...watches.keys()]) stopWatch(boxId);
      await control.dispose();
      await Promise.all([...relays].map((relay) => relay.close()));
    },
  };
}
