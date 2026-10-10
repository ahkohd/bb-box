// The desktop viewer: noVNC over the plugin's relay (007), with the control
// bar for taking and handing back input (008). It shows in a thread panel
// tab of its own for each box, and on the Boxes page for a browser tab.
// Where the setting allows it, a Linux desktop shows as video instead,
// through Selkies (selkies.ts, 056), when the round trip to BB's server is
// slow or the person chose it.

import RFB from "@novnc/novnc";
import { experimental_Icon as Icon, experimental_usePluginId, useBbNavigate, useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { BoxResult, BoxEntry, Contract, DesktopState, MachineEntry, PanelState } from "../plugin/contract.ts";
import type { BoxView, KindView } from "../plugin/views.ts";
import { BOXES_ACTION, EmptyPanel, forThread, IconButton, isArm64Badge, KindBadges, lacksDocker, message, Notice, OPERATOR, osName, RowTitle, SETTINGS_PATH, StatusDot, StatusLine, type Tone, useLive, useNow, BackControl, IconLink, type BackTo } from "./common.tsx";
import { claimKept, dropKept, keptFree, releaseKept, type Kept } from "./kept.ts";
import { refreshLosslessly, type LosslessRefresh } from "./rfb-refresh.ts";
import { controlWord, statusOf } from "./status.ts";
import { BoxTerminal, canOpenTerminal } from "./terminal.tsx";
import { NewBox, type SizeRequest } from "./new-box.tsx";
import { BoxRow, type BoxAction } from "./box-row.tsx";
import { InUseDialog, ProblemLine, useMachineActions, type InUse } from "./box-actions.tsx";
import { MachineRow } from "./settings-machines.tsx";
import { SelkiesSession, canShowVideo } from "./selkies.ts";
import {
  MAX_RETRY_MS,
  PASTE_CHORD_DELAY_MS,
  PASTE_EVENT_WAIT_MS,
  SETTLE_MS,
  XK_CONTROL_L,
  XK_META_L,
  XK_V,
  isCommandKey,
  macBrowser,
  type Connection,
} from "./viewer.ts";
import { BoxGlyph, MonitorGlyph, PasteGlyph, TerminalGlyph } from "./glyphs.tsx";
import { choices, filtering, NO_FILTERS, shown, type Filters, type Sort } from "./boxes-filter.ts";
import { PageTabs, SearchRow } from "./boxes-toolbar.tsx";

export const DESKTOP_ACTION = "desktop";
export const DESKTOP_PAGE = "desktop";

/** How often a tab with control asks for the box's clipboard. */
const CLIPBOARD_POLL_MS = 2_000;
/** How long a clipboard note, such as "Copied" or "Pasted", shows in the toolbar at least. */
const FLASH_MS = 3_000;
/**
 * The JPEG quality a desktop is asked for unless its display names one (056),
 * against noVNC's 6: moving text stays readable, and scrolling takes half the
 * traffic. Xtigervnc sends a still area again near losslessly, and wayvnc's
 * and QEMU's viewers ask for it (rfb-refresh.ts), so a still screen is sharp.
 * QEMU on Proxmox and the Tart holder send no JPEG, so it changes nothing
 * there. The compression level stays noVNC's 2: 9 saved under 2% of
 * Xtigervnc's traffic for a tenth of a core more, and halved QEMU's frames.
 */
export const QUALITY_LEVEL = 2;
export { PASTE_CHORD_DELAY_MS, SETTLE_MS };
/** Where the tab keeps the person's choice of stream for a box, from the viewer's menu: VNC, or video again. */
export function streamChoiceKey(boxId: string): string {
  return `bb-box:stream:${boxId}`;
}
/** How long the note that video did not start stays, to be read. */
const FALLBACK_NOTE_MS = 8_000;

type Stream = "rfb" | "selkies";
type ViewerSession = DesktopSession | SelkiesSession;

function storedChoice(boxId: string): Stream | null {
  try {
    const value = window.sessionStorage.getItem(streamChoiceKey(boxId));
    return value === "rfb" || value === "selkies" ? value : null;
  } catch {
    return null;
  }
}

function storeChoice(boxId: string, stream: Stream): void {
  try {
    window.sessionStorage.setItem(streamChoiceKey(boxId), stream);
  } catch {
    // Storage may be off: the choice lasts while the viewer is open.
  }
}

/** The stream each viewer showed last, so a remount finds its kept session before the box's state loads. */
const lastStream = new Map<string, Stream>();

/** Forgets every viewer's last stream, for tests. */
export function forgetStreams(): void {
  lastStream.clear();
}

/**
 * noVNC measures its screen in fractional pixels and asks the box for the
 * floor; after the resize it finds the two unequal and asks for the same
 * floor again, so a pane of 851.5 px kept a one-pixel request outstanding,
 * and a maximise that met it waited for it (#353). Measured in whole
 * pixels, as the request is made, a size that holds is asked for once.
 */
class Viewer extends RFB {
  /**
   * Cmd stands for Ctrl in the box: a Mac browser showing a Linux or Windows
   * desktop, where Cmd+C, Cmd+V, Cmd+A, Cmd+Z and the rest are the box's
   * Ctrl shortcuts, not Super ones (the operator's note of 4 October 2026).
   */
  commandAsControl = false;

  override _screenSize(): { w: number; h: number } {
    const size = super._screenSize();
    return { w: Math.floor(size.w), h: Math.floor(size.h) };
  }

  override _handleKeyEvent(keysym: number, code: string, down: boolean, numlock: boolean | null, capslock: boolean | null): void {
    if (this.commandAsControl && isCommandKey(keysym)) {
      // The code too: with QEMU's key events the box takes the scancode, not the keysym.
      super._handleKeyEvent(XK_CONTROL_L, "ControlLeft", down, numlock, capslock);
      return;
    }
    super._handleKeyEvent(keysym, code, down, numlock, capslock);
  }

  /**
   * The pointer over the desktop (the operator's note of 4 October 2026: a Linux desktop hid it without control). noVNC
   * puts the box's cursor on the canvas whatever the state, and an empty one, as TigerVNC and wayvnc send while the box's
   * pointer is hidden, makes the local pointer invisible. Without control the local arrow, always; with control the
   * box's shape, unless it has no visible pixel, which is the arrow too.
   */
  override _refreshCursor(): void {
    if (this._rfbConnectionState !== "connecting" && this._rfbConnectionState !== "connected") return;
    if (this.viewOnly || !visibleCursor(this._cursorImage)) {
      this._canvas.style.cursor = "default";
      return;
    }
    super._refreshCursor();
  }

  /** noVNC refreshes the cursor at connect and on each cursor the box sends, not when view-only changes: the viewer asks here. */
  refreshCursor(): void {
    this._refreshCursor();
  }

  #refresh: LosslessRefresh | null = null;

  /** Asks for a still area again losslessly, for a desktop whose server sends none itself (rfb-refresh.ts). */
  refreshLosslessly(): void {
    this.#refresh ??= refreshLosslessly(this);
  }

  stopRefreshing(): void {
    this.#refresh?.stop();
  }
}

/** Whether a cursor image has a visible pixel. */
function visibleCursor(image: { rgbaPixels: Uint8Array; w: number; h: number } | undefined): boolean {
  if (!image || image.w <= 0 || image.h <= 0) return false;
  for (let index = 3; index < image.rgbaPixels.length; index += 4) if (image.rgbaPixels[index]) return true;
  return false;
}

/** Where the Boxes page shows one box, for a new browser tab. */
export function pageHref(pluginId: string, threadId: string, boxId: string): string {
  return `/plugins/${encodeURIComponent(pluginId)}/${DESKTOP_PAGE}/${encodeURIComponent(threadId)}/${encodeURIComponent(boxId)}`;
}

/** The same place as a full URL, for `openUrl`, which opens only http(s) URLs (by BB's browser preference) and returns false for a path. */
export function pageUrl(pluginId: string, threadId: string, boxId: string): string {
  return new URL(pageHref(pluginId, threadId, boxId), window.location.origin).href;
}

/** The params of a box's desktop tab. */
export function desktopParams(boxId: string): { box: string } {
  return { box: boxId };
}

function socketUrl(path: string, boxId: string, viewer: string): string {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = new URLSearchParams({ box: boxId, viewer }).toString();
  return url.toString();
}

const mounted = new Set<string>();

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * This viewer's ID for a box. It lasts for the browser tab, so a panel tab
 * that remounts keeps the control it took. Two viewers mounted at once never
 * share one.
 */
function useViewerId(boxId: string): string {
  const [viewer] = useState(() => {
    const key = `bb-box:viewer:${boxId}`;
    let stored: string | null = null;
    try {
      stored = window.sessionStorage.getItem(key);
    } catch {
      // Storage may be off. A new ID only means control is not kept across remounts.
    }
    const id = stored && !mounted.has(stored) ? stored : randomId();
    try {
      window.sessionStorage.setItem(key, id);
    } catch {
      // As above.
    }
    return id;
  });
  useEffect(() => {
    mounted.add(viewer);
    return () => {
      mounted.delete(viewer);
    };
  }, [viewer]);
  return viewer;
}

/**
 * One viewer's desktop: noVNC and its canvas, in an element of its own that
 * a tab puts inside its screen area. It is kept across tab switches (037):
 * the element leaves the page and comes back with the stream still on it,
 * so switching back is instant, with no handshake and no blank frame. While
 * hidden it does not reconnect; a lost connection ends it instead.
 */
export class DesktopSession implements Kept {
  readonly element = document.createElement("div");
  hidden = false;
  onEnded?: () => void;
  connection: Connection = { state: "connecting" };
  readonly #url: string;
  readonly #listeners = new Set<() => void>();
  #client: Viewer | null = null;
  #failures = 0;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #refused: string | null = null;
  #mine = false;
  #resizable = false;
  #disposed = false;
  /** The desktop's server sends no lossless refresh, so the viewer asks for one (rfb-refresh.ts). */
  #viewerRefresh = false;
  /** The JPEG quality the viewer asks for: its display's, else QUALITY_LEVEL. */
  #quality = QUALITY_LEVEL;
  readonly #observer: ResizeObserver | null;
  #settle: ReturnType<typeof setTimeout> | undefined;
  /** The viewer's size as last observed, so the first observation, at mount, is not taken for a move. */
  #lastSize: string | null = null;
  /** The box's OS: the paste chord is Cmd+V on macOS and Ctrl+V elsewhere, and a Mac browser's Cmd stands for Ctrl there. */
  guestOs = "linux";
  /** The box's clipboard text as its desktop sent it (ServerCutText), which noVNC gives only to the viewer with control. */
  onClipboard?: (text: string) => void;
  /** A paste, from a Cmd+V or Ctrl+V the viewer took or the menu: the text pasted, or null when the browser's clipboard had none and the box pasted its own. */
  onPaste?: (text: string | null) => void;
  /** A paste the box did not take, with why. */
  onPasteFailed?: (error: unknown) => void;
  /** Puts the viewer's text on the box's clipboard bb-box's own way, where the desktop's server moves none (#464); null leaves it to noVNC. */
  putClipboard?: (text: string) => Promise<unknown> | null;
  /** Whether the box takes a viewer's clipboard at all; where not, a Cmd+V is left to noVNC as it was. */
  pasteAllowed?: () => boolean;
  /** When a Cmd+V or Ctrl+V was taken from noVNC and the browser's paste event is awaited. */
  #pasteArmed: number | null = null;
  #pasteWait: ReturnType<typeof setTimeout> | undefined;
  #chord: ReturnType<typeof setTimeout> | undefined;
  readonly #onPasteEvent = (event: ClipboardEvent) => this.#takePaste(event);

  constructor(url: string) {
    this.#url = url;
    this.element.className = "absolute inset-0";
    // noVNC 1.7 asks the box for a new size on the first frame of a change,
    // with no wait, and asks for one size at a time without asking again
    // when the box answers that it passed the request on, as QEMU does. So
    // a maximise landed in two steps: the box's queue set the size of that
    // first frame, and the final size came only with the nudge below (the
    // Windows box of 2 October 2026). While the viewer's size moves, noVNC
    // may not ask; once the size has held, the nudge sets resizeSession
    // again, which makes noVNC ask once, for the size that holds. This
    // observer is made before noVNC's own, so it runs first in a frame.
    this.#observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            const size = entries.at(-1)?.contentRect;
            clearTimeout(this.#settle);
            if (!size || size.width <= 0 || size.height <= 0) return;
            const key = `${Math.round(size.width)}x${Math.round(size.height)}`;
            const moved = this.#lastSize !== null && this.#lastSize !== key;
            this.#lastSize = key;
            if (moved && this.#client) this.#client.resizeSession = false;
            this.#settle = setTimeout(() => this.#nudge(), SETTLE_MS);
          });
    this.#observer?.observe(this.element);
    // Cmd+V (Ctrl+V elsewhere) while this tab has control pastes this computer's text: the browser's paste event
    // carries it with no permission asked, so the keydown is kept from noVNC and left to the browser (4 October 2026).
    this.element.addEventListener("keydown", (event) => this.#interceptPaste(event), true);
    document.addEventListener("paste", this.#onPasteEvent, true);
    this.connect();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(connection: Connection): void {
    this.connection = connection;
    for (const listener of this.#listeners) listener();
  }

  connect(): void {
    if (this.#disposed) return;
    clearTimeout(this.#retry);
    this.#refused = null;
    const client = new Viewer(this.element, this.#url, { shared: true });
    client.qualityLevel = this.#quality;
    if (this.#viewerRefresh) client.refreshLosslessly();
    client.scaleViewport = true;
    client.viewOnly = !this.#mine;
    client.resizeSession = this.#mine && this.#resizable;
    client.commandAsControl = macBrowser() && this.guestOs !== "macos";
    client.addEventListener("clipboard", (event: Event) => {
      if (this.#client !== client) return;
      const text = (event as CustomEvent<{ text?: string }>).detail?.text;
      if (typeof text === "string") this.onClipboard?.(text);
    });
    client.addEventListener("connect", () => {
      if (this.#client !== client) return;
      this.#failures = 0;
      this.#set({ state: "connected" });
      this.#apply();
    });
    client.addEventListener("securityfailure", (event: Event) => {
      this.#refused = (event as CustomEvent<{ reason?: string }>).detail.reason ?? "The relay refused the connection.";
    });
    client.addEventListener("disconnect", () => {
      client.stopRefreshing();
      if (this.#client !== client) return;
      this.#client = null;
      const wait = Math.min(MAX_RETRY_MS, 1000 * 2 ** this.#failures);
      this.#failures += 1;
      this.#set({ state: "disconnected", reason: this.#refused ?? "The connection to the desktop ended.", retryMs: wait });
      if (this.hidden) {
        this.onEnded?.();
        return;
      }
      this.#retry = setTimeout(() => this.connect(), wait);
    });
    this.#client = client;
    this.#set({ state: "connecting" });
  }

  reconnect(): void {
    this.#failures = 0;
    clearTimeout(this.#retry);
    const client = this.#client;
    this.#client = null;
    client?.disconnect();
    this.connect();
  }

  /** Input and resizing follow control. The relay drops input from a viewer without control anyway; this keeps noVNC from sending it. */
  setControl(mine: boolean, resizable: boolean): void {
    this.#mine = mine;
    this.#resizable = resizable;
    this.#apply();
  }

  #apply(): void {
    const client = this.#client;
    if (!client || this.connection.state !== "connected") return;
    client.viewOnly = !this.#mine;
    client.resizeSession = this.#mine && this.#resizable;
    client.commandAsControl = macBrowser() && this.guestOs !== "macos";
    client.refreshCursor();
    if (this.#mine) client.focus({ preventScroll: true });
  }

  /** Asks for still areas again losslessly from now on, for a desktop whose server sends none itself. */
  refreshLosslessly(): void {
    this.#viewerRefresh = true;
    this.#client?.refreshLosslessly();
  }

  /** The JPEG quality to ask for from now on; noVNC asks again at once when connected. */
  setQuality(level: number): void {
    this.#quality = level;
    if (this.#client) this.#client.qualityLevel = level;
  }

  /** The box's OS, for the paste chord and the Cmd mapping. */
  setGuest(os: string): void {
    this.guestOs = os;
    this.#apply();
  }

  /** Puts text on the box's clipboard, as a viewer's paste does. */
  sendClipboard(text: string): void {
    if (this.connection.state !== "connected") return;
    const put = this.putClipboard?.(text);
    if (put) put.catch(() => undefined);
    else this.#client?.clipboardPasteFrom(text);
  }

  /** Puts text on the box's clipboard, then presses the box's own paste chord, Ctrl+V or Cmd+V, where the cursor is, and says so with onPaste or onPasteFailed. */
  paste(text: string): void {
    if (this.connection.state !== "connected" || !this.#client) return;
    const put = this.putClipboard?.(text);
    if (!put) {
      this.#client.clipboardPasteFrom(text);
      this.#pressPaste();
      this.onPaste?.(text);
      return;
    }
    put.then(
      () => {
        this.#pressPaste();
        this.onPaste?.(text);
      },
      (error: unknown) => this.onPasteFailed?.(error),
    );
  }

  /** The box's paste chord, after a short wait for the text to land; the modifier is pressed whether or not the person holds its browser twin. */
  #pressPaste(): void {
    clearTimeout(this.#chord);
    this.#chord = setTimeout(() => {
      const client = this.#client;
      if (!client || this.connection.state !== "connected") return;
      const modifier = this.guestOs === "macos" ? { keysym: XK_META_L, code: "MetaLeft" } : { keysym: XK_CONTROL_L, code: "ControlLeft" };
      client.sendKey(modifier.keysym, modifier.code, true);
      client.sendKey(XK_V, "KeyV", true);
      client.sendKey(XK_V, "KeyV", false);
      client.sendKey(modifier.keysym, modifier.code, false);
    }, PASTE_CHORD_DELAY_MS);
  }

  /** A Cmd+V (Ctrl+V off a Mac) on the desktop while this tab has control: kept from noVNC, left to the browser, whose paste event brings the text. */
  #interceptPaste(event: KeyboardEvent): void {
    if (!this.#mine || this.connection.state !== "connected" || this.pasteAllowed?.() === false) return;
    if (event.key.toLowerCase() !== "v" || event.altKey || event.shiftKey) return;
    if (!(macBrowser() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return;
    event.stopPropagation();
    this.#pasteArmed = Date.now();
    clearTimeout(this.#pasteWait);
    // No paste event follows when the clipboard has no text: the box pastes its own then.
    this.#pasteWait = setTimeout(() => {
      if (this.#pasteArmed === null) return;
      this.#pasteArmed = null;
      this.#pressPaste();
      this.onPaste?.(null);
    }, PASTE_EVENT_WAIT_MS);
  }

  #takePaste(event: ClipboardEvent): void {
    if (this.#pasteArmed === null) return;
    this.#pasteArmed = null;
    clearTimeout(this.#pasteWait);
    const text = event.clipboardData?.getData("text/plain") ?? "";
    event.preventDefault();
    if (text) {
      this.paste(text);
      return;
    }
    this.#pressPaste();
    this.onPaste?.(null);
  }

  /** The viewer's size has held: noVNC asks for it once, if the desktop differs and this viewer may resize it. */
  #nudge(): void {
    const client = this.#client;
    if (client && this.connection.state === "connected" && this.#mine && this.#resizable) client.resizeSession = true;
  }

  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#retry);
    clearTimeout(this.#settle);
    clearTimeout(this.#pasteWait);
    clearTimeout(this.#chord);
    document.removeEventListener("paste", this.#onPasteEvent, true);
    this.#observer?.disconnect();
    const client = this.#client;
    this.#client = null;
    client?.disconnect();
    this.#listeners.clear();
    this.element.remove();
  }
}

/** The toolbar's words for who has control. `taken` says the agent took it back from this tab (038); `resizable` says the desktop follows this tab's size while it holds control. */
function controlText(box: BoxView, mine: boolean, taken: boolean, resizable: boolean): string {
  switch (box.control?.owner) {
    case "human":
      if (!mine) return "Another viewer has control.";
      return resizable ? "You have control. The desktop follows this tab's size." : "You have control.";
    case "none":
      return "Control is changing hands…";
    default:
      return taken ? "The agent took control." : "The agent has control.";
  }
}

/** A box's desktop, live, with its control bar. */
export function DesktopViewer({ threadId, boxId, newTab, onBack }: { threadId: string; boxId: string; newTab: boolean; onBack?: BackTo }) {
  const rpc = useRpc<Contract>();
  const pluginId = experimental_usePluginId();
  const navigate = useBbNavigate();
  const viewer = useViewerId(boxId);
  const { value: state, error, refresh } = useLive<DesktopState>(`${threadId}/${boxId}`, () => rpc.call("desktop", { threadId, box: boxId }), forThread(threadId));
  const box = state?.box ?? null;
  const path = state?.desktopPath ?? null;
  const showing = box !== null && box.state === "ready" && box.display !== null;
  const mine = box?.control?.owner === "human" && box.control.holder === viewer;
  const taken = box?.control?.owner === "agent" && box.control.takenFrom === viewer;
  const resizable = box?.display?.resizable ?? false;

  const target = useRef<HTMLDivElement>(null);
  const session = useRef<ViewerSession | null>(null);
  const mineNow = useRef(false);
  mineNow.current = mine;
  const boxNow = useRef(box);
  boxNow.current = box;
  // The stream: video whenever the box may show as video (056) and this browser can decode it, unless the
  // person chose VNC in the viewer's menu. Video that cannot start falls back to VNC. Through BB's server,
  // video drags with a twentieth of VNC's median lag, and answers keys as quickly (056's comparison).
  const shown = `${boxId}:${viewer}`;
  const [stream, setStream] = useState<Stream | null>(() => lastStream.get(shown) ?? null);
  const [videoFailed, setVideoFailed] = useState(false);
  const decide = (next: Stream) => {
    lastStream.set(shown, next);
    setStream(next);
  };
  const video = state?.video ?? null;
  const videoPossible = video === true && !videoFailed && canShowVideo();
  useEffect(() => {
    if (video === null) return;
    if (!videoPossible) {
      decide("rfb");
      return;
    }
    decide(storedChoice(boxId) ?? "selkies");
  }, [video, videoPossible]);
  const key = stream ? `desktop:${shown}:${stream}` : null;
  // The session of a stream given up for another is ended, not kept.
  const keyBefore = useRef(key);
  useEffect(() => {
    if (keyBefore.current && keyBefore.current !== key) dropKept(keyBefore.current);
    keyBefore.current = key;
  }, [key]);
  // A kept session shows at once, before the box's state has loaded; the state can only confirm or end it.
  const [connection, setConnection] = useState<Connection>(() => (key ? keptFree<ViewerSession>(key)?.connection : undefined) ?? { state: "connecting" });
  const [acting, setActing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** The box's clipboard as last seen: text from its desktop's cut text or the RPC where its input reports it, or an image the video client brought (#609). */
  const [boxClipboard, setBoxClipboard] = useState<string | Blob | null>(null);
  /**
   * A clipboard outcome of the person's own paste or copy, for a moment, in
   * the toolbar: "Pasted", "Copied", or why nothing went. Never from an
   * automatic attempt, and never a lasting problem line, which is for
   * failures that need action. A sentence stays a little longer, to be read.
   */
  const [flash, setFlash] = useState<{ readonly words: string; readonly detail?: string } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** A note, with a detail its tooltip shows, for at least `ms`. */
  const flashFor = (words: string, detail?: string, ms = FLASH_MS) => {
    setFlash({ words, detail });
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), Math.max(ms, words.split(" ").length * 300));
  };
  useEffect(() => () => clearTimeout(flashTimer.current), []);
  /** The field to paste into when this computer's clipboard cannot be read here: null closed, else its text. */
  const [pasteField, setPasteField] = useState<string | null>(null);
  /** The box's text shown to copy by hand, when this computer's clipboard cannot be written here. */
  const [copyField, setCopyField] = useState<string | Blob | null>(null);
  const ready = showing && path !== null;
  const pathNow = useRef(path);
  pathNow.current = path;
  const wanted = key !== null && (ready || keptFree(key) !== undefined);

  // The viewer's session is claimed on mount and given back on unmount; the registry keeps it meanwhile (037).
  // A layout effect, so a kept frame is in the page before it paints.
  useLayoutEffect(() => {
    const screen = target.current;
    if (!wanted || !screen || !key) return;
    const latestPath = pathNow.current;
    if (keptFree(key) === undefined && !latestPath) return;
    const claimed = claimKept<ViewerSession>(key, () =>
      stream === "selkies" ? new SelkiesSession(`${socketUrl(latestPath!, boxId, viewer)}&stream=selkies`) : new DesktopSession(socketUrl(latestPath!, boxId, viewer)),
    );
    const current = claimed.session;
    if (current instanceof SelkiesSession) {
      current.onFallback = (reason) => {
        flashFor("Video did not start, so this shows VNC.", reason, FALLBACK_NOTE_MS);
        setVideoFailed(true);
      };
    }
    screen.appendChild(current.element);
    session.current = current;
    // The box's clipboard, as its desktop sends it to the viewer with control, goes to this computer's when the browser lets it,
    // with no note: it can come with no copy of the person's, as when they take control.
    current.onClipboard = (text) => {
      setBoxClipboard(text);
      navigator.clipboard?.writeText?.(text).catch(() => undefined);
    };
    if (current instanceof SelkiesSession) {
      current.onClipboardImage = (image) => {
        setBoxClipboard(image);
        writeImage(image).catch(() => undefined);
      };
    }
    current.onPaste = (pasted: string | Blob | null) => {
      if (pasted) flashFor("Pasted");
    };
    current.onPasteFailed = (error) => setProblem(message(error));
    // A desktop whose server moves no clipboard, as Tart's macOS VMs: bb-box puts the text there itself, as UTF-8 (#464).
    current.putClipboard = (text) => (boxNow.current?.display?.clipboard === "commands" ? rpc.call("desktopPaste", { threadId, box: boxId, viewer, text }) : null);
    current.pasteAllowed = () => !boxNow.current || noClipboardThroughServer(boxNow.current) === null;
    const unsubscribe = current.subscribe(() => setConnection(current.connection));
    setConnection(current.connection);
    // It rested while the box was away, or lost its connection while hidden.
    if (current.connection.state === "disconnected") current.reconnect();
    return () => {
      unsubscribe();
      current.onClipboard = undefined;
      current.onPaste = undefined;
      current.onPasteFailed = undefined;
      current.putClipboard = undefined;
      if (current instanceof SelkiesSession) {
        current.onFallback = undefined;
        current.onClipboardImage = undefined;
      }
      current.element.remove();
      session.current = null;
      if (!claimed.kept) {
        current.dispose();
        return;
      }
      // A hidden tab may hold control for as long as a closed viewer: a minute (008). Then the agent has it back, unless someone else took it meanwhile.
      releaseKept(
        key,
        mineNow.current
          ? {
              handBack: async () => {
                const latest = await rpc.call("desktop", { threadId, box: boxId });
                if (latest.box?.control?.owner === "human" && latest.box.control.holder === viewer) await rpc.call("handBack", { threadId, box: boxId });
              },
            }
          : {},
      );
    };
  }, [wanted, boxId, viewer, key, stream, rpc, threadId]);

  // In the commit that shows who has control, so the toolbar never says "You have control" while input is still off (#116).
  useLayoutEffect(() => {
    session.current?.setControl(mine, resizable);
  }, [mine, resizable, connection]);
  const guestOs = box?.os ?? null;
  useLayoutEffect(() => {
    if (guestOs) session.current?.setGuest(guestOs);
  }, [guestOs, connection]);
  // RFB's own: video has neither.
  const viewerRefresh = box?.display?.refresh === "viewer";
  useLayoutEffect(() => {
    if (viewerRefresh && session.current instanceof DesktopSession) session.current.refreshLosslessly();
  }, [viewerRefresh, connection]);
  const quality = box?.display?.quality ?? QUALITY_LEVEL;
  useLayoutEffect(() => {
    if (session.current instanceof DesktopSession) session.current.setQuality(quality);
  }, [quality, connection]);

  // A box that stops or goes takes its stream with it.
  useEffect(() => {
    if (state && !showing && key) dropKept(key);
  }, [state, showing, key]);

  // The clipboard, both ways, while this tab has control: the browser's goes
  // to the box when the tab gets the focus, and the box's comes back when it
  // changes there, as a macOS desktop's input reports it (#406), or as bb-box
  // reads it in a desktop whose server moves none (#464).
  const connected = connection.state === "connected";
  useEffect(() => {
    if (!mine || !connected) return;
    let stopped = false;
    let sent: string | null = null;
    let seen: number | null = null;
    const toBox = () => {
      navigator.clipboard?.readText?.().then(
        (text) => {
          if (stopped || !text || text === sent) return;
          sent = text;
          session.current?.sendClipboard(text);
        },
        () => undefined,
      );
    };
    const fromBox = async () => {
      if (!document.hasFocus()) return;
      const latest = await rpc.call("desktopClipboard", { threadId, box: boxId, viewer }).catch(() => null);
      if (stopped || !latest || latest.serial === seen) return;
      // The first answer is what the box had before: only later changes are copied.
      const first = seen === null;
      seen = latest.serial;
      if (first) return;
      sent = latest.text;
      setBoxClipboard(latest.text);
      await navigator.clipboard?.writeText?.(latest.text).catch(() => undefined);
    };
    toBox();
    void fromBox();
    window.addEventListener("focus", toBox);
    const timer = setInterval(() => void fromBox(), CLIPBOARD_POLL_MS);
    return () => {
      stopped = true;
      window.removeEventListener("focus", toBox);
      clearInterval(timer);
    };
  }, [mine, connected, rpc, threadId, boxId, viewer]);

  const act = async (task: () => Promise<BoxResult>) => {
    setActing(true);
    try {
      setProblem((await task()).error);
    } catch (caught) {
      setProblem(message(caught));
    } finally {
      setActing(false);
    }
    await refresh();
  };
  const take = () => act(() => rpc.call("takeControl", { threadId, box: boxId, viewer }));
  const handBack = () => act(() => rpc.call("handBack", { threadId, box: boxId }));
  const start = () => act(() => rpc.call("start", { threadId, box: boxId }));
  const reconnect = () => session.current?.reconnect();
  /** Puts text on the box's clipboard and pastes it where the cursor is, then says so; on Windows, says why it will not land. */
  const pasteText = (text: string) => {
    const windows = box ? noClipboardThroughServer(box) : null;
    if (windows) {
      flashFor(windows);
      return;
    }
    session.current?.paste(text);
  };
  /**
   * The menu's Paste: this computer's clipboard, read on the click, which is a gesture; where the frame still refuses, a field to paste into.
   * The video client takes an image too, before text (#609).
   */
  const pasteFromComputer = async () => {
    const video = session.current instanceof SelkiesSession ? session.current : null;
    if (video && navigator.clipboard?.read) {
      const image = await navigator.clipboard.read().then(
        async (items) => {
          for (const item of items) {
            const type = item.types.find((one) => one.startsWith("image/"));
            if (type) return item.getType(type);
          }
          return null;
        },
        () => null,
      );
      if (image) {
        await video.pasteImage(image);
        return;
      }
    }
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setPasteField("");
      return;
    }
    if (!text) {
      flashFor(video ? "This computer's clipboard has no text or image." : "This computer's clipboard has no text.");
      return;
    }
    pasteText(text);
  };
  /** The menu's Copy: the box's clipboard as last seen, or fetched now where its input reports it, written to this computer's on the click. */
  const copyToComputer = async () => {
    let copied = boxClipboard;
    if (copied === null) {
      const latest = await rpc.call("desktopClipboard", { threadId, box: boxId, viewer }).catch(() => null);
      copied = latest?.text ?? null;
      if (copied !== null) setBoxClipboard(copied);
    }
    if (copied === null) {
      if (box) flashFor(nothingFromBox(box, mine));
      return;
    }
    try {
      await (typeof copied === "string" ? navigator.clipboard.writeText(copied) : writeImage(copied));
      flashFor("Copied");
    } catch {
      setCopyField(copied);
    }
  };

  // The toolbar's state: a dot and a few words.
  let tone: Tone = "busy";
  let words = "Loading…";
  if (error) {
    tone = "bad";
    words = "Could not load";
  } else if (box && !box.display) {
    tone = "off";
    words = "No desktop";
  } else if (box && box.state !== "ready") {
    tone = box.state === "stopped" ? "off" : box.state === "failed" || box.state === "gone" ? "bad" : "busy";
    words = statusOf(box, Date.now()).items[0]?.text ?? box.state;
  } else if (box && connection.state === "connecting") {
    words = "Connecting…";
  } else if (box && connection.state === "disconnected") {
    tone = "warn";
    words = "Disconnected";
  } else if (box) {
    tone = "ok";
    words = controlText(box, mine, taken, resizable);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface-recessed px-3 py-2 text-xs">
        {onBack ? <BackControl back={onBack} /> : null}
        <MonitorGlyph className="text-muted-foreground" />
        <span className="font-medium text-foreground">{box?.name ?? "Desktop"}</span>
        <span className={cn("inline-flex min-w-0 items-center gap-1.5", mine || taken ? "text-foreground" : "text-muted-foreground")}>
          <StatusDot tone={tone} />
          <span className="min-w-0">{words}</span>
        </span>
        {flash ? (
          <span role="status" title={flash.detail} className="min-w-0 text-muted-foreground">
            {flash.words}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5">
          {showing && !mine ? (
            <Button type="button" variant="outline" size="sm" className="h-7" disabled={acting || connection.state !== "connected"} onClick={() => void take()}>
              {taken ? "Take control again" : "Take control"}
            </Button>
          ) : null}
          {showing && mine ? (
            <Button type="button" size="sm" className="h-7" disabled={acting} onClick={() => void handBack()}>
              Hand back to the agent
            </Button>
          ) : null}
          {showing && connection.state === "disconnected" ? (
            <Button type="button" variant="outline" size="sm" className="h-7" onClick={reconnect}>
              Reconnect
            </Button>
          ) : null}
          {box ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className="size-7 p-0 text-muted-foreground hover:text-foreground" aria-label="Desktop actions">
                  <Icon name="MoreHorizontal" className="size-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-max min-w-40 max-w-72" mobileTitle={box.name}>
                {newTab ? (
                  <DropdownMenuItem onSelect={() => void navigate.openUrl(pageUrl(pluginId, threadId, box.id))}>
                    <Icon name="ExternalLink" aria-hidden />
                    Open in browser
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onSelect={() => navigate.toThread(threadId)}>
                    <Icon name="ArrowUpRight" aria-hidden />
                    Open thread
                  </DropdownMenuItem>
                )}
                {showing ? (
                  <DropdownMenuItem onSelect={reconnect}>
                    <Icon name="ArrowReloadHorizontal" aria-hidden />
                    Reconnect
                  </DropdownMenuItem>
                ) : null}
                {showing && video === true && canShowVideo() && stream ? (
                  // A glyph like the other items', so its words line up with theirs; BB's tick sits at the right.
                  <DropdownMenuCheckboxItem
                    className="gap-2"
                    checked={stream === "rfb"}
                    onCheckedChange={(checked) => {
                      const next = checked ? "rfb" : "selkies";
                      storeChoice(boxId, next);
                      setVideoFailed(false);
                      decide(next);
                    }}
                  >
                    <MonitorGlyph />
                    Show as VNC
                  </DropdownMenuCheckboxItem>
                ) : null}
                {showing ? (
                  <>
                    <DropdownMenuSeparator />
                    {/* Both wait for the connection; Paste for control too, so the item says there is one to take. */}
                    <DropdownMenuItem disabled={!mine || connection.state !== "connected"} onSelect={() => void pasteFromComputer()}>
                      <PasteGlyph />
                      Paste from this computer
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={connection.state !== "connected"} onSelect={() => void copyToComputer()}>
                      <Icon name="Copy" aria-hidden />
                      Copy to this computer
                    </DropdownMenuItem>
                  </>
                ) : null}
                {box.control?.owner === "human" && !mine ? (
                  <DropdownMenuItem onSelect={() => void handBack()}>
                    <Icon name="ArrowTurnBackward" aria-hidden />
                    Hand back to the agent
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </span>
      </div>
      {problem ? (
        <div className="flex items-start gap-2 border-b border-border px-3 py-1.5 text-xs">
          <p role="alert" className="min-w-0 flex-1 text-destructive-text">
            {problem}
          </p>
          <Button type="button" variant="ghost" size="sm" className="-my-1 h-6 px-2 text-xs" onClick={() => setProblem(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1 bg-muted">
        <div ref={target} className="absolute inset-0" data-testid="desktop-screen" />
        {mine ? <div aria-hidden data-testid="control-ring" className="pointer-events-none absolute inset-0 ring-2 ring-inset ring-primary/60" /> : null}
        {error ? (
          <Notice>{error}</Notice>
        ) : !state ? null : !box ? (
          <Notice>This box has been released.</Notice>
        ) : !box.display ? (
          <Notice>{box.name} has no desktop.</Notice>
        ) : box.state === "stopped" ? (
          <Notice
            detail={box.stopped ?? undefined}
            action={
              box.canStopStart ? (
                <Button type="button" variant="outline" size="sm" className="h-7" disabled={acting} onClick={() => void start()}>
                  <Icon name="Play" aria-hidden />
                  Start
                </Button>
              ) : undefined
            }
          >
            {box.name} is stopped.
          </Notice>
        ) : box.state === "acquiring" || box.state === "starting" ? (
          <Notice detail={box.stopped ?? "The desktop shows once it is ready."}>{box.name} is starting…</Notice>
        ) : box.state === "failed" ? (
          <Notice detail={box.error ?? undefined}>{box.name} failed to start.</Notice>
        ) : box.state === "gone" ? (
          <Notice>{box.name} was deleted outside bb-box.</Notice>
        ) : box.state !== "ready" ? (
          <Notice>{box.name} is being released.</Notice>
        ) : connection.state === "connecting" ? (
          <Notice>Connecting to the desktop…</Notice>
        ) : connection.state === "disconnected" ? (
          <Notice
            detail={`Trying again in ${Math.max(1, Math.round(connection.retryMs / 1000))} s`}
            action={
              <Button type="button" variant="outline" size="sm" className="h-7" onClick={reconnect}>
                Reconnect now
              </Button>
            }
          >
            {connection.reason}
          </Notice>
        ) : null}
      </div>
      <AlertDialog open={pasteField !== null} onOpenChange={(open) => !open && setPasteField(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Paste into {box?.name ?? "the box"}</AlertDialogTitle>
            <AlertDialogDescription>
              {stream === "selkies"
                ? "This computer's clipboard cannot be read here. Paste text or an image below: it goes to the box's clipboard and is pasted where the cursor is."
                : "This computer's clipboard cannot be read here. Paste the text below: it goes to the box's clipboard and is pasted where the cursor is."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            aria-label="Text to paste"
            value={pasteField ?? ""}
            onChange={(event) => setPasteField(event.target.value)}
            onPaste={(event) => {
              // An image pasted here goes to the box at once, as the video client takes images (#609).
              const video = session.current instanceof SelkiesSession ? session.current : null;
              const image = video ? Array.from(event.clipboardData.files).find((file) => file.type.startsWith("image/")) : undefined;
              if (!video || !image) return;
              event.preventDefault();
              setPasteField(null);
              void video.pasteImage(image);
            }}
            rows={4}
            autoFocus
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              type="button"
              disabled={!pasteField}
              onClick={() => {
                if (pasteField) pasteText(pasteField);
                setPasteField(null);
              }}
            >
              Paste into the box
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={copyField !== null} onOpenChange={(open) => !open && setCopyField(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Copied in {box?.name ?? "the box"}</AlertDialogTitle>
            <AlertDialogDescription>
              {copyField instanceof Blob ? "This computer's clipboard cannot be written here. Right-click the image and copy it." : "This computer's clipboard cannot be written here. Select the text and copy it."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {copyField instanceof Blob ? (
            <CopiedImage image={copyField} />
          ) : (
            <Textarea aria-label="Text from the box" readOnly value={copyField ?? ""} rows={4} autoFocus onFocus={(event) => event.currentTarget.select()} />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Writes an image to this computer's clipboard, as PNG, the type browsers take (#609). */
async function writeImage(image: Blob): Promise<void> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) throw new Error("This browser cannot copy images.");
  // A promise, so the browser keeps the click's permission while the PNG is made.
  await navigator.clipboard.write([new ClipboardItem({ "image/png": asPng(image) })]);
}

async function asPng(image: Blob): Promise<Blob> {
  if (image.type === "image/png") return image;
  const bitmap = await createImageBitmap(image);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

/** An image from the box, to copy by hand where the browser will not write it. */
function CopiedImage({ image }: { image: Blob }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const made = URL.createObjectURL(image);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [image]);
  return url ? <img src={url} alt="The image copied in the box" className="max-h-64 max-w-full self-start rounded border border-border object-contain" /> : null;
}

/**
 * Why a box's desktop moves no clipboard either way, or null where it does. A macOS VM on Tart (#464) and a Windows box
 * through QEMU's console (#461), whose servers move none, have it through bb-box's own commands in the box; a pool Mac
 * through its own input. A Windows box from before #461 is told so until bb-box's next start gives it the commands.
 */
function noClipboardThroughServer(box: BoxView): string | null {
  if (box.os === "windows" && box.display?.clipboard !== "commands") return `${box.name}'s desktop does not report its clipboard to viewers, nor take theirs: Windows through QEMU's console moves it only with the SPICE guest agent, which the box does not have.`;
  return null;
}

/** Why nothing has come from the box's clipboard: its desktop's server may not send it, or sends it only to the viewer with control. */
function nothingFromBox(box: BoxView, mine: boolean): string {
  const windows = noClipboardThroughServer(box);
  if (windows) return windows;
  if (!mine) return "Nothing has come from the box's clipboard yet. Its desktop sends it to the viewer with control: take control, then copy in the box.";
  return "Nothing has come from the box's clipboard yet. Copy something in the box first.";
}

function parseParams(params: unknown): string | null {
  const box = (params as { box?: unknown } | null)?.box;
  return typeof box === "string" && box.length > 0 ? box : null;
}

/** Opens a box's desktop tab in the thread's panel. There is one tab per box. */
export function useOpenDesktop(): (box: BoxView) => void {
  const navigate = useBbNavigate();
  return (box) => {
    navigate.openThreadPanel({ actionId: DESKTOP_ACTION, title: box.name, params: desktopParams(box.id) });
  };
}

/** The thread panel tab for one box's desktop. Opened bare from its launcher row, it opens the thread's desktop, picks among several, or offers the Box panel. */
export function DesktopPanel({ threadId, params }: { threadId: string; params: unknown }) {
  const boxId = parseParams(params);
  if (boxId) return <DesktopViewer key={boxId} threadId={threadId} boxId={boxId} newTab />;
  return <DesktopChooser threadId={threadId} />;
}

/** A box as a row: its glyph, name, kind, state (and who has control, for a desktop), with its actions. */
export function BoxLine({ box, meta, machine = false, actions }: { box: BoxView; meta?: string | null; /** The BB machine the thread runs on (036): its badge. */ machine?: boolean; actions?: React.ReactNode }) {
  const status = statusOf(box, Date.now());
  const control = box.desktop && box.state === "ready" && !controlWord(box, new Set()) ? "The agent has control" : null;
  return (
    <div className="grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-3 py-3">
      <span className="flex size-6 items-center justify-center text-muted-foreground"><BoxGlyph /></span>
      <div className="min-w-0">
        <RowTitle name={box.name} os={osName(box.os)} badges={<KindBadges desktop={box.desktop} gpu={box.gpu} noDocker={lacksDocker(box)} arm64={isArm64Badge(box.os, box.arch)} forms={box.form ? [box.form] : []} machine={machine} />} />
        {/* Who has control comes straight after the state, so a narrow chooser keeps it. */}
        <StatusLine tone={status.tone} items={[status.items[0], control, ...status.items.slice(1), meta]} />
      </div>
      <span className="flex shrink-0 items-center gap-1">{actions}</span>
    </div>
  );
}

/**
 * The bare Desktop launcher tab, made a real shortcut (Task A): one desktop opens
 * straight away, several offer a chooser, and none sends you to the Box panel. The
 * SDK 0.5.29 has no way to hide the launcher row (see docs/bb-requests.md #14), so
 * the shortcut lives here rather than in the action's run().
 */
function DesktopChooser({ threadId }: { threadId: string }) {
  const rpc = useRpc<Contract>();
  const navigate = useBbNavigate();
  const open = useOpenDesktop();
  const { value: state, error } = useLive<PanelState>(threadId, () => rpc.call("state", { threadId }), forThread(threadId));
  // The box this thread runs on counts too (the operator, 4 October 2026): listed first, and alone it opens straight away.
  const runsOn = state?.runsOn?.box.desktop ? state.runsOn.box : null;
  const desktops = [...(runsOn ? [runsOn] : []), ...(state?.boxes.filter((box) => box.desktop) ?? [])];
  useNow(desktops.some((box) => box.state === "acquiring" || box.state === "starting"), 1000);
  if (desktops.length === 1) return <DesktopViewer key={desktops[0]!.id} threadId={threadId} boxId={desktops[0]!.id} newTab />;
  return (
    <div className="p-4">
      {error ? <EmptyPanel role="alert">{error}</EmptyPanel> : null}
      {state && !desktops.length ? (
        <EmptyPanel title="No desktop box">
          <p className="mt-1">This thread has no desktop box.</p>
          <Button type="button" variant="outline" size="sm" className="mt-3 h-7" onClick={() => navigate.openThreadPanel({ actionId: BOXES_ACTION, title: "Box" })}>
            Open the Box panel
          </Button>
        </EmptyPanel>
      ) : null}
      {desktops.length ? (
        <div className="rounded-lg border border-border bg-card px-4 py-1">
          <div className="divide-y divide-border">
            {desktops.map((box) => (
              <BoxLine
                key={box.id}
                box={box}
                machine={box.id === runsOn?.id}
                actions={
                  <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => open(box)}>
                    Open
                  </Button>
                }
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The Boxes page: every box across threads and your machines, or one box's desktop or terminal at <threadId>/<boxId>. */
export function BoxesPage({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const [threadId, boxId, ...rest] = subPath.split("/").map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return "";
    }
  });
  // A view opened from the settings page goes back there: a machine of yours is not on the Boxes list the same way.
  const fromSettings = rest.at(-1) === "from-settings";
  const parts = fromSettings ? rest.slice(0, -1) : rest;
  // Settings is a place in BB's app, so its way back is a link (see IconLink); the page's list is this plugin's own panel.
  const back: BackTo = fromSettings ? { label: "Back to settings", href: SETTINGS_PATH } : { label: "Back to boxes", go: () => navigate.toPluginPanel(DESKTOP_PAGE, { subPath: "" }) };
  if (threadId && boxId && parts.length === 1 && parts[0] === "terminal") {
    return <BoxTerminal key={`${threadId}/${boxId}/terminal`} threadId={threadId} boxId={boxId} onBack={back} />;
  }
  if (threadId && boxId && !parts.length) {
    return <DesktopViewer key={`${threadId}/${boxId}`} threadId={threadId} boxId={boxId} newTab={false} onBack={back} />;
  }
  return <BoxList />;
}

/** The titles of the threads whose boxes the page lists, fetched once each; a thread that cannot be read shows its ID. */
export function useThreadTitles(threadIds: readonly string[]): Record<string, string> {
  const sdk = useSdk();
  const [titles, setTitles] = useState<Record<string, string>>({});
  const key = threadIds.join(" ");
  useEffect(() => {
    let cancelled = false;
    for (const threadId of key.split(" ").filter(Boolean)) {
      if (titles[threadId] !== undefined) continue;
      sdk.threads
        .get({ threadId })
        .then((thread) => {
          if (!cancelled) setTitles((current) => ({ ...current, [threadId]: thread.title || threadId }));
        })
        .catch(() => {
          if (!cancelled) setTitles((current) => ({ ...current, [threadId]: threadId }));
        });
    }
    return () => {
      cancelled = true;
    };
    // Titles are fetched once per thread; a change of the set triggers the next round.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, sdk]);
  return titles;
}

/** Where the Boxes page shows one box's desktop, or its terminal; from settings, the back arrow returns there. */
export function desktopSubPath(threadId: string, boxId: string, view: "desktop" | "terminal" = "desktop", from?: "settings"): string {
  const base = `${encodeURIComponent(threadId)}/${encodeURIComponent(boxId)}`;
  return [base, ...(view === "terminal" ? ["terminal"] : []), ...(from === "settings" ? ["from-settings"] : [])].join("/");
}

/** The page's tabs: your machines, and the threads' boxes by thread. */
type BoxesTab = "machines" | "threads";

function BoxList() {
  const rpc = useRpc<Contract>();
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const { value: all, error, refresh } = useLive<BoxEntry[]>("allBoxes", () => rpc.call("allBoxes"), () => true);
  // Your machines with the threads on each, as settings lists them: settings' rows, actions and warnings (the operator, 5 October 2026).
  const { value: machinesState, refresh: refreshMachines } = useLive<{ machines: MachineEntry[]; kinds: KindView[] }>("machines", () => rpc.call("machines.list"), forThread(OPERATOR));
  const kinds = machinesState?.kinds ?? [];
  const machines = machinesState?.machines ?? [];
  const refreshBoth = () => Promise.all([refresh(), refreshMachines()]);
  const machineActions = useMachineActions(refreshBoth);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  /** A release or stop of a thread's box left alone because threads work on it, until the person says: the panel's question. */
  const [inUse, setInUse] = useState<(InUse<"release" | "stop"> & { readonly threadId: string }) | null>(null);
  // The tab chosen last, kept in the browser, so the way back from a box's desktop lands on the tab it left.
  const tabKey = `${pluginId}:boxes-tab`;
  const [chosenTab, setChosenTab] = useState<BoxesTab | null>(() => {
    try {
      const kept = window.localStorage.getItem(tabKey);
      return kept === "machines" || kept === "threads" ? kept : null;
    } catch {
      return null;
    }
  });
  const chooseTab = (tab: BoxesTab) => {
    setChosenTab(tab);
    try {
      window.localStorage.setItem(tabKey, tab);
    } catch {
      // Without storage, the page opens on the first tab with boxes each time.
    }
  };
  // The search, filters and sort, as the Automations page has them; Name, ascending, as its default.
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [sort, setSort] = useState<Sort>({ key: "name", ascending: true });
  // New box makes one of your machines here (the operator, 4 October 2026): a box made here has no thread. The same form as settings'
  // Add machine; the machine then shows under Machines.
  const add = async (kind: string, size?: SizeRequest, name?: string, on?: string | string[]): Promise<string | null> => {
    let refused: string | null;
    try {
      refused = (await rpc.call("machines.add", { kind, ...(size ? { size } : {}), ...(name ? { name } : {}), ...(on ? { on } : {}) })).error;
    } catch (caught) {
      refused = message(caught);
    }
    await refreshBoth();
    setProblem(refused);
    if (!refused) chooseTab("machines");
    return refused;
  };
  /** A thread's box: the panel's Start, Stop, Release and Check now, as that thread, with the panel's in-use guard. */
  const actOn = (threadId: string) => async (method: BoxAction, box: BoxView, force = false) => {
    const guarded = method === "release" || method === "stop";
    let refused: string | null;
    try {
      const answer = await rpc.call(method, { threadId, box: box.id, ...(guarded && force ? { force: true } : {}) });
      refused = answer.error;
      if (guarded && answer.threads?.length) setInUse({ method, box, threads: answer.threads, threadId });
    } catch (caught) {
      refused = message(caught);
    }
    await refreshBoth();
    setProblem(refused);
  };
  const entries = all ?? [];
  const threads = entries.filter((entry) => entry.owner !== "yours");
  const threadIds = [...new Set(threads.map((entry) => entry.threadId))];
  const titles = useThreadTitles(threadIds);
  const now = useNow(
    entries.some((entry) => entry.box.state === "acquiring" || entry.box.state === "starting" || entry.box.state === "stopping") || machines.some((entry) => entry.box.state === "acquiring" || entry.box.state === "starting"),
    1000,
  );
  const shownProblem = problem ?? machineActions.problem;
  const tab: BoxesTab = chosenTab ?? (machines.length || !threads.length ? "machines" : "threads");
  const loaded = !!all && !!machinesState;
  // The filters offer what the tab lists, and keep only what it still offers. A machine's search words are the threads on it.
  const offered = choices(tab === "machines" ? machines.map((entry) => entry.box) : threads.map((entry) => entry.box));
  const kept: Filters = {
    kinds: filters.kinds.filter((value) => offered.kinds.includes(value)),
    providers: filters.providers.filter((value) => offered.providers.includes(value)),
    states: filters.states.filter((value) => offered.states.includes(value)),
  };
  const machineRows = shown(
    machines.map((entry) => ({ box: entry.box, entry, words: entry.threads.map((thread) => thread.title ?? "") })),
    search,
    kept,
    sort,
  );
  const threadRows = shown(
    threads.map(({ threadId, box }) => ({ box, threadId, words: [titles[threadId] ?? ""] })),
    search,
    kept,
    sort,
  );
  // Each thread once, with its boxes, where its first box comes in the sort's order.
  const groups = new Map<string, typeof threadRows>();
  for (const row of threadRows) groups.set(row.threadId, [...(groups.get(row.threadId) ?? []), row]);
  const narrowed = !!search.trim() || filtering(kept);
  const listed = tab === "machines" ? machines.length : threads.length;
  return (
    <div className="h-full min-h-0">
      {/* BB's Automations page's frame and spacing (the operator, 8 October 2026): its width, a line under the title, the tabs
          with the actions at their right; the list scrolls under them. */}
      <div className="mx-auto box-border flex h-full min-h-0 w-full max-w-5xl flex-col gap-5 px-4 pb-4 pt-3 md:px-5 md:pt-4">
        <p className="text-sm leading-5 text-muted-foreground">Computers for your threads, and machines of your own.</p>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <PageTabs
            tabs={[
              { id: "machines", label: "Machines", count: machines.length },
              { id: "threads", label: "Threads", count: threadIds.length },
            ]}
            selected={tab}
            onSelect={chooseTab}
          />
          {/* The settings gear, then New box, where Automations has New automation: a plain button, as BB's new-thread screen
              already offers a thread on a new box (the operator, 8 October 2026). The gear is a link: BB's openUrl does nothing
              with an app path. BB offers no place beside the page's title for it (docs/bb-requests.md #18). */}
          <div className="flex shrink-0 items-center gap-1.5">
            <IconLink label="BB Box settings" icon="Settings" href={SETTINGS_PATH} className="size-8" />
            {kinds.length ? <NewBox kinds={kinds} make={add} machine primary profile={(backend) => rpc.call("provider", { backend })} /> : null}
          </div>
        </div>
        <div role="tabpanel" className="flex min-h-0 flex-1 flex-col gap-5">
          {listed ? <SearchRow search={search} onSearch={setSearch} filters={kept} offered={offered} onFilters={setFilters} sort={sort} onSort={setSort} /> : null}
          {error ? <EmptyPanel role="alert">{error}</EmptyPanel> : null}
          <ProblemLine
            problem={shownProblem}
            onDismiss={() => {
              setProblem(null);
              machineActions.setProblem(null);
            }}
          />
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
            {loaded && tab === "machines" && !machines.length ? <EmptyPanel>You have no machines. New box adds one: a box of your own that shows in BB's machine list.</EmptyPanel> : null}
            {loaded && tab === "threads" && !threads.length ? <EmptyPanel>No thread has a box. A thread gets one from its Box panel, or from its agent.</EmptyPanel> : null}
            {narrowed && listed && !(tab === "machines" ? machineRows : threadRows).length ? <EmptyPanel>No boxes match.</EmptyPanel> : null}
            {tab === "machines" && machineRows.length ? (
              <div className="overflow-hidden rounded-lg border border-border bg-card px-4 py-1">
                <div className="divide-y divide-border">
                  {machineRows.map(({ entry }) => (
                    <MachineRow
                      key={entry.box.id}
                      entry={entry}
                      now={now}
                      busy={machineActions.busy}
                      from="boxes"
                      onStop={() => void machineActions.act("stop", entry.box)}
                      onStart={() => void machineActions.act("start", entry.box)}
                      onRemove={() => machineActions.askRemove(entry.box)}
                    />
                  ))}
                </div>
              </div>
            ) : null}
            {tab === "threads"
              ? [...groups].map(([threadId, rows]) => (
                  // One card per thread, headed by its title, which opens the thread, as a row's title does on the Automations page. The
                  // title and its boxes read as one group (the operator, 10 October 2026): no line under the title, which sits 16 px from
                  // the card's top as the last row does from its bottom, and 8 px above the first row; the rows keep their dividers.
                  <section key={threadId} aria-label={titles[threadId] ?? threadId} className="overflow-hidden rounded-lg border border-border bg-card">
                    <div className="flex items-center gap-3 pl-4 pr-3 pt-3">
                      <button type="button" className="min-w-0 flex-1 truncate rounded-sm text-left text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => navigate.toThread(threadId)}>
                        {titles[threadId] ?? threadId}
                      </button>
                      <IconButton label="Open thread" icon="ArrowUpRight" onClick={() => navigate.toThread(threadId)} />
                    </div>
                    <div className="divide-y divide-border px-4 pb-1 [&>*:first-child]:pt-1">
                      {rows.map(({ box }) => (
                        <BoxRow
                          key={box.id}
                          box={box}
                          threadId={threadId}
                          open={open === box.id}
                          onToggle={() => setOpen((current) => (current === box.id ? null : box.id))}
                          act={actOn(threadId)}
                          now={now}
                          opens={{
                            desktop: (target) => navigate.toPluginPanel(DESKTOP_PAGE, { subPath: desktopSubPath(threadId, target.id) }),
                            terminal: (target) => navigate.toPluginPanel(DESKTOP_PAGE, { subPath: desktopSubPath(threadId, target.id, "terminal") }),
                          }}
                          meta={[box.desktop && box.state === "ready" && !controlWord(box, new Set()) ? "The agent has control" : null]}
                          threading={false}
                        />
                      ))}
                    </div>
                  </section>
                ))
              : null}
          </div>
        </div>
        {machineActions.dialogs}
        <InUseDialog inUse={inUse} words={{ release: "Release", stop: "Stop" }} onClose={() => setInUse(null)} onForce={(found) => void actOn(inUse?.threadId ?? "")(found.method, found.box, true)} />
      </div>
    </div>
  );
}
