// The desktop viewer: noVNC over the plugin's relay (007), with the control
// bar for taking and handing back input (008). It shows in a thread panel
// tab of its own for each box, and on the Boxes page for a browser tab.
// Where the setting allows it, a Linux desktop shows as video instead,
// through Selkies (selkies.ts, 056), when the round trip to BB's server is
// slow or the person chose it.

import RFB from "@novnc/novnc";
import { experimental_Icon as Icon, experimental_usePluginId, UrlLink, useBbNavigate, useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
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
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { BoxResult, BoxEntry, Contract, DesktopState, MachineEntry, MachinesState, PanelState } from "../plugin/contract.ts";
import type { BoxView } from "../plugin/views.ts";
import { BOXES_ACTION, EmptyPanel, forThread, hasViewer, IconButton, rememberedLive, message, Notice, OPERATOR, ReleasedNotice, deviceModelOf, RowTitle, boxTitleBadges, systemName, SETTINGS_PATH, StatusDot, StatusLine, type Tone, useLive, useNow, BackControl, IconLink, type BackTo } from "./common.tsx";
import { POINTER_NONE } from "../core/pointer.ts";
import { BoxPointer } from "./box-pointer.ts";
import { claimKept, dropKept, keptFree, releaseKept, type Kept } from "./kept.ts";
import { refreshLosslessly, type LosslessRefresh } from "./rfb-refresh.ts";
import { controlWord, statusOf } from "./status.ts";
import { BoxTerminal, canOpenTerminal } from "./terminal.tsx";
import { REPOSITORY_URL } from "./settings-backends.tsx";
import { NewBox, useDesktopOnDemand, useDesktopProblemShownOnce, type SizeRequest } from "./new-box.tsx";
import { SetupProgress } from "./first-run.tsx";
import { BoxRow } from "./box-row.tsx";
import type { BoxAction } from "./box-menu.tsx";
import type { BoxOpens } from "./box-opens.tsx";
import { ProblemLine, useMachineActions, useThreadBoxActions } from "./box-actions.tsx";
import { BoxName, useBoxesNav, useListOpens, type PageLink } from "./box-nav.tsx";
import { BoxPage, NotHere, useBoxPage } from "./box-page.tsx";
import { otherView, pageOfView, routeOf, wayBack, type BoxViewRoute } from "./box-route.ts";
import { MachineRow } from "./settings-machines.tsx";
import { DEVICE_HUB_WORDS, SLOW_VIDEO_STILLS_WORDS, STILLS_WORDS, SelkiesSession, base64Bytes, canShowVideo, unicodeKeysym, type DeviceShown } from "./selkies.ts";
import { DEFAULT_DEVICE_VIEW, type DeviceLayout, type DeviceView } from "./device-stage.ts";
import { DeviceControls, type AskKey, type DeviceAsk } from "./device-controls.ts";
import { DevicePicker, DeviceToolbar, TOUCH_HINT_KEY, toolbarRoom, type AskedBy } from "./device-toolbar.tsx";
import { usePointerCoarse } from "@/components/ui/hooks/use-pointer-coarse";
import { SHOWN_AT_START_WORDS, afterWords, doneWords } from "../core/device-control.ts";
import { changeWords, placeAt } from "../core/device-toolbar.ts";
import { locationWords, rebootsToShow } from "../core/device-settings.ts";
import { modelNamed, type DeviceAction, type DeviceAnswer, type DeviceState, type ModelName } from "../core/device.ts";
import {
  KeysAfterPaste,
  astralKeysym,
  textKeys,
  typeTextShortcut,
  typeTextShortcutLabel,
  TYPE_TEXT_PASTE_FROM,
  keyLog,
  keyLogOn,
  PASTE_LANDS_MS,
  tabOf,
  ShiftedLetters,
  isModifier,
  pasteChordKeys,
  pasteShortcut,
  type PasteShortcut,
  XK_SHIFT_L,
  PASTE_CHORD_DELAY_MS,
  PASTE_EVENT_WAIT_MS,
  SETTLE_MS,
  XK_CONTROL_L,
  XK_V,
  OptionComposer,
  boxKey,
  commandKey,
  macBrowser,
  retryWait,
  type Connection,
  type MacKeys,
} from "./viewer.ts";
import { BoxGlyph, HighResolutionGlyph, KeyboardGlyph, MonitorGlyph, PasteGlyph, PhoneGlyph, TerminalGlyph } from "./glyphs.tsx";
import { otherScreen, screenTitle, screensOf, screenWord, type Screen } from "./screens.ts";
import { choices, filtering, NO_FILTERS, shown, splitGroups, TAG_GROUPS, tagCounts, type Filters, type Sort } from "./boxes-filter.ts";
import { PageTabs, SearchRow } from "./boxes-toolbar.tsx";

export const DESKTOP_ACTION = "desktop";
export const DEVICE_ACTION = "device";
const ACTION_TITLES: Readonly<Record<ScreenAction, string>> = { desktop: "Desktop", device: "Device" };
type ScreenAction = typeof DESKTOP_ACTION | typeof DEVICE_ACTION;
export const DESKTOP_PAGE = "desktop";

export const DESKTOP_OWN_PASTE_WORDS = "A paste from the box's own menu, or a middle click, uses the box's own clipboard.";
export const DEVICE_OWN_PASTE_WORDS = "A paste from the device's own menu uses the device's own clipboard.";

export const DEVICE_PASTE_FIELD_WORDS =
  "This computer's clipboard cannot be read here. Paste the text below: it is pasted where the cursor is, and the device's own clipboard is put back after.";

export function ownPasteWords(deviceShown: boolean): string {
  return deviceShown ? DEVICE_OWN_PASTE_WORDS : DESKTOP_OWN_PASTE_WORDS;
}

/** How often a tab with control asks for the box's clipboard. */
const CLIPBOARD_POLL_MS = 500;
const DEVICE_COPY_AFTER_CHORD_MS = 400;
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
/** Each tab's desktop whose video gave way to VNC, by box and viewer. */
const failedVideo = new Set<string>();

type Shows = Screen;

export function displayChoiceKey(boxId: string): string {
  return `bb-box:display:${boxId}`;
}

const lastDisplay = new Map<string, Shows>();

function storedDisplay(boxId: string): Shows | null {
  try {
    const value = window.sessionStorage.getItem(displayChoiceKey(boxId));
    return value === "desktop" || value === "device" ? value : null;
  } catch {
    return null;
  }
}

function storeDisplay(boxId: string, shows: Shows): void {
  try {
    window.sessionStorage.setItem(displayChoiceKey(boxId), shows);
  } catch {
    return;
  }
}

export function deviceViewKey(boxId: string): string {
  return `bb-box:device-view:${boxId}`;
}

function storedDeviceView(boxId: string): DeviceView {
  try {
    const stored = JSON.parse(window.localStorage.getItem(deviceViewKey(boxId)) ?? "null") as Partial<DeviceView> | null;
    return { frame: typeof stored?.frame === "boolean" ? stored.frame : DEFAULT_DEVICE_VIEW.frame, pixelForPixel: typeof stored?.pixelForPixel === "boolean" ? stored.pixelForPixel : DEFAULT_DEVICE_VIEW.pixelForPixel };
  } catch {
    return DEFAULT_DEVICE_VIEW;
  }
}

function storeDeviceView(boxId: string, view: DeviceView): void {
  try {
    window.localStorage.setItem(deviceViewKey(boxId), JSON.stringify(view));
  } catch {
    return;
  }
}

function deviceKeyOf(shown: string): string {
  return `desktop:${shown}:device`;
}

function deviceWaitWords(device: DeviceShown | null): string {
  const power = device?.state?.power;
  if (!power) return "Connecting";
  if (power.is === "booting") return "Booting";
  if (power.is === "switching") return `Switching to the ${power.to}`;
  if (power.is === "stopped") return "Stopped";
  if (power.is === "failed") return power.error.words;
  return power.awake ? "Connecting" : "Asleep";
}

const KEEP_TOOLBAR_FOCUS_MS = 3_000;

const SHOWN_ON_SCREEN: ReadonlySet<DeviceAction> = new Set(["home", "back", "recents", "rotate", "posture", "appearance", "text_size", "lock", "wake"]);

function storedFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function storeFlag(key: string): void {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    return;
  }
}

function downloadPicture(picture: Blob, name: string): void {
  const url = URL.createObjectURL(picture);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Forgets every viewer's last stream, and video that gave way, for tests. */
export function forgetStreams(): void {
  lastStream.clear();
  lastDisplay.clear();
  failedVideo.clear();
}

/**
 * noVNC measures its screen in fractional pixels and asks the box for the
 * floor; after the resize it finds the two unequal and asks for the same
 * floor again, so a pane of 851.5 px kept a one-pixel request outstanding,
 * and a maximise that met it waited for it (#353). Measured in whole
 * pixels, as the request is made, a size that holds is asked for once.
 */
class Viewer extends RFB {
  /** The box's OS, for the keys Cmd and Option go as (boxKey). */
  guestOs = "linux";
  /** How a macOS desktop's server names Command and Option. */
  macKeys: MacKeys | null = null;

  override _screenSize(): { w: number; h: number } {
    const size = super._screenSize();
    return { w: Math.floor(size.w), h: Math.floor(size.h) };
  }

  readonly #option = new OptionComposer();
  readonly afterPaste = new KeysAfterPaste<[number, string, boolean, boolean | null, boolean | null]>((key) => this.#keyEvent(...key));

  readonly #letters = new ShiftedLetters();
  readonly #heldModifiers = new Map<number, string>();

  override _handleKeyEvent(keysym: number, code: string, down: boolean, numlock: boolean | null, capslock: boolean | null): void {
    for (const each of this.#letters.keys(keysym, code, down, capslock)) {
      if (this.afterPaste.keep([each.keysym, each.code, each.down, numlock, capslock])) continue;
      this.#keyEvent(each.keysym, each.code, each.down, numlock, capslock);
    }
  }

  override sendKey(keysym: number, code: string | null, down?: boolean): void {
    keyLog("vnc", down ?? "press", keysym, this.#heldModifiers.keys());
    super.sendKey(keysym, code, down);
  }

  #keyEvent(keysym: number, code: string, down: boolean, numlock: boolean | null, capslock: boolean | null): void {
    // The code too: with QEMU's key events the box takes the scancode, not the keysym.
    const mac = macBrowser();
    const key = boxKey(keysym, code, this.guestOs, mac, this.macKeys);
    const keys = mac && this.guestOs !== "macos" ? this.#option.keys(key, down) : [{ key, down }];
    // A Mac's input and Windows' bb-box-stream type a character the box's layout lacks by the character, and know none
    // of X's own names for them.
    for (const each of keys) {
      const sent = this.guestOs === "macos" || this.guestOs === "windows" ? unicodeKeysym(each.key.keysym) : each.key.keysym;
      if (isModifier(sent)) {
        if (each.down) this.#heldModifiers.set(sent, each.key.code);
        else this.#heldModifiers.delete(sent);
      }
      super._handleKeyEvent(sent, each.key.code, each.down, numlock, capslock);
    }
  }

  typeCharacter(keysym: number, code: string): void {
    for (const down of [true, false]) {
      for (const each of this.#letters.keys(keysym, code, down, false)) this.#keyEvent(each.keysym, each.code, each.down, null, null);
    }
  }

  /** The modifiers the box holds down, as this viewer sent them. */
  heldModifiers(): { readonly keysym: number; readonly code: string }[] {
    return [...this.#heldModifiers].map(([keysym, code]) => ({ keysym, code }));
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

export function screenParams(box: Pick<BoxView, "id" | "device">, screen: Screen): { box: string; shows?: "desktop" } {
  return screen === "desktop" && box.device ? { box: box.id, shows: "desktop" } : { box: box.id };
}

function actionOf(screen: Screen): ScreenAction {
  return screen === "device" ? DEVICE_ACTION : DESKTOP_ACTION;
}

function socketUrl(path: string, boxId: string, viewer: string): string {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = new URLSearchParams({ box: boxId, viewer, ...(keyLogOn() ? { keylog: "1" } : {}) }).toString();
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
function tabViewerId(boxId: string): string {
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
}

function showsTheBoxElsewhere(viewer: string): boolean {
  return mounted.has(viewer);
}

function useViewerId(boxId: string): string | null {
  const [chosen, setChosen] = useState<{ boxId: string; viewer: string } | null>(null);
  useLayoutEffect(() => {
    const viewer = tabViewerId(boxId);
    mounted.add(viewer);
    setChosen({ boxId, viewer });
    return () => {
      mounted.delete(viewer);
    };
  }, [boxId]);
  return chosen?.boxId === boxId ? chosen.viewer : null;
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
  #hidden = false;
  get hidden(): boolean {
    return this.#hidden;
  }
  /**
   * As its tab goes, it lets go in the box of the keys this viewer holds down: their ups would go nowhere, and a Ctrl the box kept
   * held, from Cmd on a Mac, would turn every click and key that came after into a shortcut. noVNC lets go itself as the window
   * loses focus.
   */
  set hidden(value: boolean) {
    this.#hidden = value;
    if (value && this.#mine && this.#client && this.connection.state === "connected") this.#client._keyboard._allKeysUp();
  }
  /**
   * The box's pointer drawn over the picture for a viewer without control, where bb-box sends where it is (060): on a
   * Wayland desktop with bb-box-cursor the VNC picture has no pointer, and RFB has no place for where it is, so it comes on
   * a stream of its own, which ends at once for a desktop without the helper.
   */
  readonly #boxPointer = new BoxPointer(this.element);
  #pointerStream: WebSocket | null = null;
  /** The box's image has no bb-box-cursor: its pointer stream is not opened again. */
  #pointerNone = false;
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
  #macKeys: MacKeys | null = null;
  readonly #observer: ResizeObserver | null;
  #settle: ReturnType<typeof setTimeout> | undefined;
  /** The viewer's size as last observed, so the first observation, at mount, is not taken for a move. */
  #lastSize: string | null = null;
  /**
   * Whether the desktop follows this tab's size: only once the tab's size changes while it has control. Taking control,
   * connecting again or reloading leave the desktop's size as it is, so the picture stays as it was (the owner's note
   * of 16 October 2026: taking control changes who drives the desktop, not what the person sees).
   */
  #follow = false;
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
  onTypeText?: () => void;
  /** A Cmd+V or Ctrl+V taken from noVNC, with Shift or not, while the browser's paste event is awaited. */
  #pasteArmed: PasteShortcut | null = null;
  #pasteWait: ReturnType<typeof setTimeout> | undefined;
  /** Each paste's chord still to go, and whether it has Shift: two pastes in quick succession press it twice. */
  readonly #chords = new Map<ReturnType<typeof setTimeout>, boolean>();
  /** Pastes whose text is still on its way to the box. */
  #putting = 0;
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
            this.#drawPointer();
            if (moved && this.#mine) this.#follow = true;
            if (moved && this.#client) this.#client.resizeSession = false;
            this.#settle = setTimeout(() => this.#nudge(), SETTLE_MS);
          });
    this.#observer?.observe(this.element);
    // Cmd+V (Ctrl+V elsewhere) while this tab has control pastes this computer's text: the browser's paste event
    // carries it with no permission asked, so the keydown is kept from noVNC and left to the browser (4 October 2026).
    this.element.addEventListener("keydown", (event) => this.#interceptPaste(event), true);
    for (const type of ["keydown", "keyup"] as const) {
      this.element.addEventListener(type, (event) => this.#interceptTypeText(event), true);
      this.element.addEventListener(type, (event) => this.#astralKey(event), true);
    }
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
    client.afterPaste.join(tabOf(this.#url));
    client.afterPaste.pressChord = (shifted) => this.#pressPaste(shifted);
    // Not noVNC's dark grey: the pane's colour, in the theme's neutral, shows around a picture that does not fill it.
    client.background = "transparent";
    client.qualityLevel = this.#quality;
    if (this.#viewerRefresh) client.refreshLosslessly();
    client.scaleViewport = true;
    client.viewOnly = !this.#mine;
    client.resizeSession = this.#mine && this.#resizable && this.#follow;
    client.guestOs = this.guestOs;
    client.macKeys = this.#macKeys;
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
      this.#openPointer();
    });
    client.addEventListener("securityfailure", (event: Event) => {
      this.#refused = (event as CustomEvent<{ reason?: string }>).detail.reason ?? "The relay refused the connection.";
    });
    client.addEventListener("disconnect", () => {
      client.stopRefreshing();
      client.afterPaste.leave();
      if (this.#client !== client) return;
      this.#client = null;
      this.#closePointer();
      const wait = retryWait(this.#failures);
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
    // Control taken, or lost: the desktop keeps its size until this tab's size changes while it has control.
    if (mine !== this.#mine) this.#follow = false;
    this.#mine = mine;
    this.#resizable = resizable;
    this.#apply();
  }

  #apply(): void {
    const client = this.#client;
    if (!client || this.connection.state !== "connected") return;
    client.viewOnly = !this.#mine;
    client.resizeSession = this.#mine && this.#resizable && this.#follow;
    client.guestOs = this.guestOs;
    client.macKeys = this.#macKeys;
    client.refreshCursor();
    if (this.#mine && !this.#typing) client.focus({ preventScroll: true });
    this.#drawPointer();
  }

  /** Opens the box's pointer stream (060), unless the box's image has no helper. */
  #openPointer(): void {
    if (this.#pointerNone || this.#pointerStream || this.#disposed) return;
    const stream = new WebSocket(`${this.#url}&stream=pointer`);
    this.#pointerStream = stream;
    stream.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string" && this.#boxPointer.message(event.data)) this.#drawPointer();
    };
    stream.onclose = (event: CloseEvent) => {
      if (this.#pointerStream === stream) this.#pointerStream = null;
      if (event.reason === POINTER_NONE) this.#pointerNone = true;
      this.#boxPointer.at("");
      this.#drawPointer();
    };
  }

  #closePointer(): void {
    const stream = this.#pointerStream;
    this.#pointerStream = null;
    stream?.close();
  }

  /** The box's pointer over noVNC's canvas, wherever noVNC has fitted the picture, for a viewer without control. */
  #drawPointer(): void {
    const canvas = this.element.querySelector("canvas");
    if (!canvas) {
      this.#boxPointer.place(null, true);
      return;
    }
    const outer = this.element.getBoundingClientRect();
    const inner = canvas.getBoundingClientRect();
    this.#boxPointer.place(
      { left: inner.left - outer.left, top: inner.top - outer.top, width: inner.width, height: inner.height, desktopWidth: canvas.width, desktopHeight: canvas.height },
      this.#mine,
    );
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

  /** How a macOS desktop's server names Command and Option, for its keys and the paste chord. */
  setMacKeys(keys: MacKeys | null): void {
    this.#macKeys = keys;
    this.#apply();
  }

  /**
   * Puts text on the box's clipboard, then presses the box's own paste chord, Ctrl+V or Cmd+V, or Ctrl+Shift+V when
   * `shifted`, where the cursor is, and says so with onPaste or onPasteFailed.
   */
  paste(text: string, shifted = false): void {
    if (this.connection.state !== "connected" || !this.#client) return;
    const keys = this.#client.afterPaste;
    keys.hold();
    const put = this.putClipboard?.(text);
    if (!put) {
      this.#client.clipboardPasteFrom(text);
      this.#pressPaste(shifted);
      this.onPaste?.(text);
      return;
    }
    this.#putting++;
    put.then(
      () => {
        this.#putting--;
        // The stream switched while the text was on its way: the tab's new session presses the chord.
        if (this.#disposed) keys.handChord(shifted);
        else this.#pressPaste(shifted);
        this.onPaste?.(text);
      },
      (error: unknown) => {
        this.#putting--;
        if (this.#disposed) keys.drop();
        else if (!this.#pasteDue()) keys.release();
        this.onPasteFailed?.(error);
      },
    );
  }

  /** Whether a paste's chord, or the text it waits for, is still to go. */
  #pasteDue(): boolean {
    return this.#chords.size > 0 || this.#putting > 0;
  }

  /** The box's paste chord, after a short wait for the text to land; the modifier is pressed whether or not the person holds its browser twin. Keys typed since go after it. */
  #pressPaste(shifted = false): void {
    this.#client?.afterPaste.hold();
    const chord = setTimeout(() => {
      this.#chords.delete(chord);
      this.#sendChord(shifted);
    }, PASTE_CHORD_DELAY_MS);
    this.#chords.set(chord, shifted);
  }

  #sendChord(shifted: boolean): void {
    const client = this.#client;
    if (!client || this.connection.state !== "connected") {
      client?.afterPaste.drop();
      return;
    }
    const modifier = this.guestOs === "macos" ? commandKey(this.#macKeys) : { keysym: XK_CONTROL_L, code: "ControlLeft" };
    const modifiers = shifted ? [modifier, { keysym: XK_SHIFT_L, code: "ShiftLeft" }] : [modifier];
    for (const { key, down } of pasteChordKeys(modifiers, { keysym: XK_V, code: "KeyV" }, client.heldModifiers())) client.sendKey(key.keysym, key.code, down);
    // Keys typed since wait for the last paste on its way.
    if (!this.#pasteDue()) client.afterPaste.releaseIn(PASTE_LANDS_MS);
  }

  /** A Cmd+V (Ctrl+V off a Mac), or with Shift on a box that is not a Mac, while this tab has control: kept from noVNC, left to the browser, whose paste event brings the text. */
  #astralKey(event: KeyboardEvent): void {
    const keysym = astralKeysym(event);
    if (keysym === null) return;
    event.stopPropagation();
    event.preventDefault();
    if (event.type === "keydown" && this.#mine && this.connection.state === "connected") this.#client?.typeCharacter(keysym, event.code || "Unidentified");
  }

  #interceptTypeText(event: KeyboardEvent): void {
    if (!this.#mine || this.connection.state !== "connected" || !typeTextShortcut(event, macBrowser())) return;
    event.stopPropagation();
    event.preventDefault();
    if (event.type === "keydown" && !event.repeat) this.onTypeText?.();
  }

  typeText(text: string): void {
    if (!this.#mine || this.connection.state !== "connected") return;
    for (const key of textKeys(text)) this.#client?.typeCharacter(key.keysym, key.code);
  }

  #typing = false;

  setTyping(open: boolean): void {
    if (this.#typing === open) return;
    this.#typing = open;
    if (this.#mine && this.connection.state === "connected") this.#client?._keyboard._allKeysUp();
    if (!open) this.focusDesktop();
  }

  focusDesktop(): void {
    if (this.#mine && this.connection.state === "connected") this.#client?.focus({ preventScroll: true });
  }

  #interceptPaste(event: KeyboardEvent): void {
    if (!this.#mine || this.connection.state !== "connected" || this.pasteAllowed?.() === false) return;
    const shortcut = pasteShortcut(event, this.guestOs, macBrowser());
    if (!shortcut) return;
    event.stopPropagation();
    this.#pasteArmed = shortcut;
    this.#client?.afterPaste.hold();
    clearTimeout(this.#pasteWait);
    // No paste event follows when the clipboard has no text: the box pastes its own then.
    this.#pasteWait = setTimeout(() => {
      if (this.#pasteArmed === null) return;
      const shifted = this.#pasteArmed === "shifted";
      this.#pasteArmed = null;
      this.#pressPaste(shifted);
      this.onPaste?.(null);
    }, PASTE_EVENT_WAIT_MS);
  }

  #takePaste(event: ClipboardEvent): void {
    if (this.#pasteArmed === null) return;
    const shifted = this.#pasteArmed === "shifted";
    this.#pasteArmed = null;
    clearTimeout(this.#pasteWait);
    const text = event.clipboardData?.getData("text/plain") ?? "";
    event.preventDefault();
    if (text) {
      this.paste(text, shifted);
      return;
    }
    this.#pressPaste(shifted);
    this.onPaste?.(null);
  }

  /** The viewer's size has held: noVNC asks for it once, if the desktop differs and this viewer may resize it. */
  #nudge(): void {
    const client = this.#client;
    if (client && this.connection.state === "connected" && this.#mine && this.#resizable && this.#follow) client.resizeSession = true;
  }

  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#retry);
    clearTimeout(this.#settle);
    clearTimeout(this.#pasteWait);
    const due = [...this.#chords];
    this.#chords.clear();
    for (const [chord, shifted] of due) {
      clearTimeout(chord);
      this.#sendChord(shifted);
    }
    this.#client?.afterPaste.close();
    document.removeEventListener("paste", this.#onPasteEvent, true);
    this.#observer?.disconnect();
    this.#closePointer();
    const client = this.#client;
    this.#client = null;
    client?.disconnect();
    this.#listeners.clear();
    this.element.remove();
  }
}

/** What High resolution does, and its cost, for its tooltip (the owner's notes of 17 October 2026). */
export const HIGH_RESOLUTION_WORDS = "Twice the pixels, for sharp text on a high-resolution screen. About three times the CPU while shown; best with 8 cores or more.";
/** The same on Windows, at twice the pixels and 200%, where copying the screen is the limit (the owner's note of 18 October 2026). */
export const WINDOWS_HIGH_RESOLUTION_WORDS =
  "Twice the pixels, for sharp text on a high-resolution screen. About half the frame rate, and keys about 85 ms, while on; more cores do not help.";

/**
 * The desktop menu's Display items (the owner's notes of 17 October 2026): Show as VNC and High resolution, each with
 * its tick, in a submenu; on a small screen, whose menu is a sheet with no submenus, under a Display label.
 */
function DisplayItems({
  compact,
  vnc,
  highResolution,
}: {
  compact: boolean;
  vnc: { checked: boolean; onChange: (checked: boolean) => void } | null;
  highResolution: { checked: boolean; disabled: boolean; words: string; onChange: (checked: boolean) => void } | null;
}) {
  const items = (
    <>
      {vnc ? (
        // A glyph like the other items', so its words line up with theirs; BB's tick sits at the right.
        <DropdownMenuCheckboxItem className="gap-2" checked={vnc.checked} onCheckedChange={vnc.onChange}>
          <MonitorGlyph />
          Show as VNC
        </DropdownMenuCheckboxItem>
      ) : null}
      {highResolution ? <HighResolutionItem {...highResolution} /> : null}
    </>
  );
  if (compact) {
    return (
      <>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Display</DropdownMenuLabel>
        {items}
      </>
    );
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <MonitorGlyph />
        Display
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-max min-w-44">{items}</DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** High resolution, with an info icon whose tooltip says what it does and costs: on pointing at the icon, and as the item has the keyboard's focus. */
function HighResolutionItem({ checked, disabled, words, onChange }: { checked: boolean; disabled: boolean; words: string; onChange: (checked: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip open={open}>
        <DropdownMenuCheckboxItem
          className="gap-2"
          checked={checked}
          disabled={disabled}
          onCheckedChange={onChange}
          aria-describedby={id}
          onFocus={(event) => setOpen(event.currentTarget.matches(":focus-visible"))}
          onBlur={() => setOpen(false)}
        >
          <HighResolutionGlyph />
          High resolution
          <TooltipTrigger asChild>
            {/* The size of the menu's 12 px text and of BB Box's other inline info icons; the padding, taken back by the margin, keeps a 20 px target to point at. */}
            <span data-testid="high-resolution-info" className="-m-1 inline-flex items-center p-1 text-muted-foreground" onPointerEnter={() => setOpen(true)} onPointerLeave={() => setOpen(false)}>
              <Icon name="Info" className="size-3" aria-hidden />
            </span>
          </TooltipTrigger>
          <span id={id} className="sr-only">
            {words}
          </span>
        </DropdownMenuCheckboxItem>
        <TooltipContent side="bottom" align="end" className="max-w-64 text-xs leading-snug">
          {words}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function TypeTextButton({ shortcut, compact, onClick }: { shortcut: string; compact: boolean; onClick: () => void }) {
  const words = `Type text: input methods, emoji and other languages (${shortcut})`;
  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
            aria-label={`Type text (${shortcut})`}
            onClick={onClick}
          >
            <KeyboardGlyph />
            {compact ? null : "Type text"}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-64 text-xs leading-snug">
          {words}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function TypeTextField({
  name,
  value,
  mac,
  long,
  onChange,
  onSend,
  onClose,
}: {
  name: string;
  value: string;
  mac: boolean;
  long: boolean;
  onChange: (value: string) => void;
  onSend: (value: string) => void;
  onClose: () => void;
}) {
  const hintId = useId();
  const enterWhileComposing = useRef(false);
  const commitAfter = useRef(false);
  const hint = long ? "Long text goes as a paste." : "Enter sends it. Shift+Enter starts a new line. Esc closes.";
  return (
    <div role="group" aria-label={`Type text into ${name}`} className="absolute inset-x-2 bottom-2 z-10 mx-auto max-w-xl rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-lg">
      <Textarea
        aria-label="Text to type"
        aria-describedby={hintId}
        placeholder={mac ? "Type or paste text. Press Ctrl+Cmd+Space again for emoji." : "Type or paste text, in any language or input method."}
        value={value}
        rows={2}
        autoFocus
        className="min-h-0 resize-none text-sm"
        onChange={(event) => onChange(event.target.value)}
        onCompositionEnd={() => {
          commitAfter.current = !enterWhileComposing.current;
          enterWhileComposing.current = false;
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) {
            if (event.key === "Enter") enterWhileComposing.current = true;
            return;
          }
          const commit = commitAfter.current && event.keyCode === 229;
          commitAfter.current = false;
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "Enter" && !event.shiftKey && !commit) {
            event.preventDefault();
            onSend(value);
          }
        }}
      />
      <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
        <span id={hintId} aria-live="polite" className="min-w-0 flex-1">
          {hint}
        </span>
        <Button type="button" variant="ghost" size="sm" className="h-7" onClick={onClose}>
          Close
        </Button>
        <Button type="button" size="sm" className="h-7" disabled={!value} onClick={() => onSend(value)}>
          Send
        </Button>
      </div>
    </div>
  );
}

function ScreenGlyph({ screen, className }: { screen: Screen; className?: string }) {
  return screen === "device" ? <PhoneGlyph className={className} /> : <MonitorGlyph className={className} />;
}

function OtherScreenButton({ box, shows, onClick }: { box: BoxView; shows: Screen; onClick: (other: Screen) => void }) {
  const other = otherScreen(box, shows);
  if (!other) return null;
  const word = screenWord(box, other);
  return (
    <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5" onClick={() => onClick(other)}>
      <ScreenGlyph screen={other} className="size-3.5" />
      {word}
    </Button>
  );
}

/** The toolbar's words for who has control. `taken` says the agent took it back from this tab (038). */
function controlText(box: BoxView, mine: boolean, taken: boolean, tookByControl: boolean): string {
  switch (box.control?.owner) {
    case "human":
      return mine ? (tookByControl ? "You have control. Hand back when done." : "You have control.") : "Another viewer has control.";
    case "none":
      return "Control is changing hands…";
    default:
      return taken ? "The agent took control." : "The agent has control.";
  }
}

/** A box's desktop, live, with its control bar. */
export const VIDEO_GUIDE = `${REPOSITORY_URL}/docs/guide/desktops.md#video`;

const insecurePageNoted = { shown: false };

export function forgetInsecurePageNote(): void {
  insecurePageNoted.shown = false;
}

function pageIsInsecure(): boolean {
  return typeof isSecureContext !== "undefined" && !isSecureContext;
}

type DesktopViewerProps = { threadId: string; boxId: string; newTab: boolean; onBack?: BackTo; screen?: Screen | null; openScreen?: (box: BoxView, screen: Screen) => void; page?: PageLink };

export function DesktopViewer(props: DesktopViewerProps) {
  const viewer = useViewerId(props.boxId);
  return viewer === null ? null : <DesktopViewerAs {...props} viewer={viewer} />;
}

function DesktopViewerAs({ threadId, boxId, newTab, onBack, screen = null, openScreen, page, viewer }: DesktopViewerProps & { viewer: string }) {
  const rpc = useRpc<Contract>();
  const pluginId = experimental_usePluginId();
  const navigate = useBbNavigate();
  const { value: state, error, refresh } = useLive<DesktopState>(`${threadId}/${boxId}`, () => rpc.call("desktop", { threadId, box: boxId }), forThread(threadId));
  const box = state?.box ?? null;
  /** The box's name as last seen, so a tab whose box was released still names it. */
  const lastName = useRef<string | null>(null);
  if (box) lastName.current = box.name;
  /** The box is gone from bb-box's records, as once its thread or agent released it: the tab says so, and offers nothing that needs it. */
  const released = state !== null && !box;
  const path = state?.desktopPath ?? null;
  const shown = `${boxId}:${viewer}`;
  const [shows, setShows] = useState<Shows>(() => screen ?? lastDisplay.get(shown) ?? storedDisplay(boxId) ?? "desktop");
  const chooseDisplay = (next: Shows) => {
    lastDisplay.set(shown, next);
    setShows(next);
  };
  const hasDevice = !!box?.device;
  const hasDesktop = !!box?.display;
  useEffect(() => {
    if (!box || screen) return;
    if (!hasDevice) chooseDisplay("desktop");
    else if (!hasDesktop) chooseDisplay("device");
    else chooseDisplay(lastDisplay.get(shown) ?? storedDisplay(boxId) ?? "desktop");
  }, [box !== null, hasDevice, hasDesktop]);
  const deviceShown = shows === "device";
  const showsNow = useRef(shows);
  showsNow.current = shows;
  const showing = box !== null && box.state === "ready" && (deviceShown ? hasDevice : box.display !== null);
  const mine = box?.control?.owner === "human" && box.control.holder === viewer;
  const taken = box?.control?.owner === "agent" && box.control.takenFrom === viewer;
  const resizable = box?.display?.resizable ?? false;

  const target = useRef<HTMLDivElement>(null);
  const session = useRef<ViewerSession | null>(null);
  const mineNow = useRef(false);
  const deviceViewNow = useRef<DeviceView>(DEFAULT_DEVICE_VIEW);
  mineNow.current = mine;
  const boxNow = useRef(box);
  boxNow.current = box;
  // The stream: video whenever the box may show as video (056) and this browser can decode it, unless the
  // person chose VNC in the viewer's menu. Video that cannot start falls back to VNC. Through BB's server, video
  // drags and answers keys as quickly as VNC, in whole frames (056's comparison, corrected).
  const [stream, setStream] = useState<Stream | null>(() => lastStream.get(shown) ?? null);
  // Video that gave way to VNC stays given way for this tab when it comes back, so its return is instant rather than a new try that
  // fails again (the owner's note of 19 October 2026), until the person chooses video again.
  const [videoFailed, setVideoFailedNow] = useState(() => failedVideo.has(shown));
  const setVideoFailed = (failed: boolean) => {
    if (failed) failedVideo.add(shown);
    else failedVideo.delete(shown);
    setVideoFailedNow(failed);
  };
  const decide = (next: Stream) => {
    lastStream.set(shown, next);
    setStream(next);
  };
  const video = state?.video ?? null;
  const videoPossible = video === true && !videoFailed && canShowVideo();
  /** What the viewer opens before the person chooses: VNC where the box's video is shown only by choice, as on a Tart Mac. */
  const firstStream: Stream = state?.videoByDefault === false ? "rfb" : "selkies";
  /** Whether the desktop is at high resolution, twice the pixels at twice the scale; null where it cannot be. */
  const sharp = state?.sharp ?? null;
  /** A small screen's menu is a sheet, which has no submenus: the display's items go in it under a label. */
  const compact = useIsCompactViewport();
  useEffect(() => {
    if (video === null) return;
    if (!videoPossible) {
      decide("rfb");
      if (video === true && !videoFailed && pageIsInsecure() && !insecurePageNoted.shown) {
        insecurePageNoted.shown = true;
        flashFor(
          "This desktop shows over VNC: video needs a secure connection to BB.",
          <UrlLink href={VIDEO_GUIDE} className="underline underline-offset-2">
            Video, in the desktops guide
          </UrlLink>,
          FALLBACK_NOTE_MS,
        );
      }
      return;
    }
    decide(storedChoice(boxId) ?? firstStream);
  }, [video, videoPossible, firstStream]);
  const key = deviceShown ? deviceKeyOf(shown) : stream ? `desktop:${shown}:${stream}` : null;
  // The session of a stream given up for another is ended, not kept.
  const keyBefore = useRef(deviceShown ? null : key);
  useEffect(() => {
    if (deviceShown) return;
    if (keyBefore.current && keyBefore.current !== key) dropKept(keyBefore.current);
    keyBefore.current = key;
  }, [key]);
  // A kept session shows at once, before the box's state has loaded; the state can only confirm or end it.
  const [connection, setConnection] = useState<Connection>(() => (key ? keptFree<ViewerSession>(key)?.connection : undefined) ?? { state: "connecting" });
  const [device, setDevice] = useState<DeviceShown | null>(null);
  const [deviceView, setDeviceView] = useState<DeviceView>(() => storedDeviceView(boxId));
  useEffect(() => setDeviceView(storedDeviceView(boxId)), [boxId]);
  const [deviceLayout, setDeviceLayout] = useState<DeviceLayout | null>(null);
  const coarse = usePointerCoarse();
  const [tookByControl, setTookByControl] = useState(false);
  useEffect(() => {
    if (!mine) setTookByControl(false);
  }, [mine]);
  const [deviceBusy, setDeviceBusy] = useState<AskKey | null>(null);
  const [shooting, setShooting] = useState(false);
  const [hintSeen, setHintSeen] = useState(() => storedFlag(TOUCH_HINT_KEY));
  const [announced, setAnnounced] = useState("");
  const deviceStateBefore = useRef<DeviceState | null>(null);
  const controlsRef = useRef<DeviceControls | null>(null);
  const takeForControl = async (): Promise<string | null> => {
    try {
      const result = await rpc.call("takeControl", { threadId, box: boxId, viewer });
      if (result.error) return result.error;
      setTookByControl(true);
      await refresh();
      return null;
    } catch (caught) {
      return message(caught);
    }
  };
  const takeForControlNow = useRef(takeForControl);
  takeForControlNow.current = takeForControl;
  const answeredNow = useRef<(ask: DeviceAsk, answer: DeviceAnswer) => void>(() => undefined);
  if (!controlsRef.current) {
    controlsRef.current = new DeviceControls({
      mine: () => mineNow.current && session.current instanceof SelkiesSession && !!session.current.device,
      take: () => takeForControlNow.current(),
      send: (ask) => {
        const current = session.current;
        if (!(current instanceof SelkiesSession) || !current.device) return Promise.resolve({ id: "", ok: false, error: { code: "not-booted", words: "The device is not shown here now." }, state: null });
        return ask.kind === "control" ? current.sendDeviceControl(ask.control) : current.openDeviceUrl(ask.url);
      },
      answered: (ask, answer) => answeredNow.current(ask, answer),
      changed: () => setDeviceBusy(controlsRef.current?.busy ?? null),
    });
  }
  const controls = controlsRef.current;
  useEffect(() => () => controls.dispose(), [controls]);
  const askDevice = (ask: DeviceAsk, by: AskedBy = "menu") => {
    if (!hintSeen) {
      setHintSeen(true);
      storeFlag(TOUCH_HINT_KEY);
    }
    const current = session.current instanceof SelkiesSession ? session.current : null;
    if (by === "keyboard") current?.keepFocusElsewhere(KEEP_TOOLBAR_FOCUS_MS);
    controls.ask(ask);
    if (by === "pointer" && mineNow.current) current?.focusDevice();
  };
  /** When the viewer tries again after the connection ended, so its note counts down to it rather than stand still. */
  const retryAt = useMemo(() => (connection.state === "disconnected" ? Date.now() + connection.retryMs : null), [connection]);
  const retryNow = useNow(retryAt !== null, 250);
  const retryIn = retryAt === null ? 0 : Math.ceil((retryAt - retryNow) / 1000);
  const [acting, setActing] = useState(false);
  /** This tab asked for High resolution to switch, and has not yet heard that it is done. */
  const [sharpAsked, setSharpAsked] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** The box's clipboard as last seen: text from its desktop's cut text or the RPC where its input reports it, or an image the video client brought (#609). */
  const [boxClipboard, setBoxClipboard] = useState<string | Blob | null>(null);
  useEffect(() => setBoxClipboard(null), [deviceShown]);
  /**
   * A note for a moment, as BB's own toast, so the toolbar keeps its height (the owner's note of 18 October 2026): a clipboard
   * outcome of the person's own paste or copy, "Pasted", "Copied" or why nothing went, or why video did not start. Never from an
   * automatic attempt, and never a lasting problem line, which is for failures that need action. One at a time for this tab, the
   * next in its place; a sentence stays a little longer, to be read.
   */
  const flashId = `bb-box-desktop:${shown}`;
  /** A note, with a detail under it, for at least `ms`. */
  const flashFor = (words: string, detail?: ReactNode, ms = FLASH_MS) => {
    toast(words, { id: flashId, description: detail, duration: Math.max(ms, words.split(" ").length * 300), closeButton: true });
  };
  useEffect(() => () => void toast.dismiss(flashId), [flashId]);
  /** The field to paste into when this computer's clipboard cannot be read here: null closed, else its text. */
  const [pasteField, setPasteField] = useState<string | null>(null);
  const [typing, setTyping] = useState<string | null>(null);
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
    const claimed = claimKept<ViewerSession>(
      key,
      () =>
        deviceShown
          ? new SelkiesSession(`${socketUrl(latestPath!, boxId, viewer)}&display=device`, { device: { model: boxNow.current?.device?.model ?? null } })
          : stream === "selkies"
            ? new SelkiesSession(`${socketUrl(latestPath!, boxId, viewer)}&stream=selkies`)
            : new DesktopSession(socketUrl(latestPath!, boxId, viewer)),
      // It rested while the box was away, or lost its connection while hidden. A session that throws here is replaced by a fresh one.
      (resumed) => {
        if (resumed.connection.state === "disconnected") resumed.reconnect();
      },
    );
    const current = claimed.session;
    const ownShows = showsNow.current;
    if (current instanceof SelkiesSession && !current.device) {
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
    current.onTypeText = () => setTyping((now) => now ?? "");
    current.setTyping(typingNow.current);
    current.putClipboard = (text) => (ownShows === "desktop" && boxNow.current?.display?.clipboard === "commands" ? rpc.call("desktopPaste", { threadId, box: boxId, viewer, text }) : null);
    current.pasteAllowed = () => !boxNow.current || noClipboardThroughServer(boxNow.current) === null;
    if (current instanceof SelkiesSession && current.device) {
      current.setDeviceView(deviceViewNow.current);
      current.onDeviceAction = (control) => controls.ask({ kind: "control", control });
      const stage = current.deviceStage;
      stage?.setToolbar(toolbarRoom(coarseNow.current, hintNow.current));
      if (stage) stage.onLayout = setDeviceLayout;
    }
    const deviceOf = () => (current instanceof SelkiesSession ? current.device : null);
    const unsubscribe = current.subscribe(() => {
      setConnection(current.connection);
      setDevice(deviceOf());
    });
    setConnection(current.connection);
    setDevice(deviceOf());
    return () => {
      unsubscribe();
      current.onClipboard = undefined;
      current.onPaste = undefined;
      current.onPasteFailed = undefined;
      current.putClipboard = undefined;
      if (current instanceof SelkiesSession) {
        current.onFallback = undefined;
        current.onClipboardImage = undefined;
        current.onDeviceAction = undefined;
        if (current.deviceStage) current.deviceStage.onLayout = undefined;
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
        mineNow.current && showsNow.current === ownShows
          ? {
              handBack: async () => {
                if (showsTheBoxElsewhere(viewer)) return;
                const latest = await rpc.call("desktop", { threadId, box: boxId });
                if (latest.box?.control?.owner === "human" && latest.box.control.holder === viewer) await rpc.call("handBack", { threadId, box: boxId });
              },
            }
          : {},
      );
    };
  }, [wanted, boxId, viewer, key, stream, rpc, threadId, deviceShown]);

  // In the commit that shows who has control, so the toolbar never says "You have control" while input is still off (#116).
  // Through a High resolution switch, asked here or in another tab, the video holds its last picture until the desktop has its new
  // size and scale, so the switch looks like one change (the owner's note of 18 October 2026).
  const switching = sharpAsked || state?.switching === true;
  useEffect(() => {
    const current = session.current;
    if (!(current instanceof SelkiesSession) || current.device) return;
    if (switching) current.hold();
    else current.release();
  }, [switching]);
  useLayoutEffect(() => {
    // A desktop at high resolution keeps its density through the video viewer's resizes; noVNC would ask for its pane's own size, so it asks for none.
    session.current?.setControl(mine, !deviceShown && resizable && !(sharp === true && stream === "rfb"));
    controls.mineChanged();
  }, [mine, resizable, connection, sharp, stream, deviceShown]);
  const coarseNow = useRef(coarse);
  coarseNow.current = coarse;
  const hintShown = coarse && !mine && !hintSeen;
  const hintNow = useRef(hintShown);
  hintNow.current = hintShown;
  useEffect(() => {
    if (session.current instanceof SelkiesSession) session.current.deviceStage?.setToolbar(toolbarRoom(coarse, hintShown));
  }, [coarse, hintShown, connection]);
  const deviceState = device?.state ?? null;
  useEffect(() => {
    if (!deviceState) return;
    const words = changeWords(deviceStateBefore.current, deviceState);
    deviceStateBefore.current = deviceState;
    if (words) setAnnounced(words);
  }, [deviceState]);
  const deviceModelName = box?.device?.model ?? null;
  useEffect(() => {
    if (session.current instanceof SelkiesSession) session.current.setDeviceModel(deviceModelName);
  }, [deviceModelName, connection]);
  useEffect(() => {
    deviceViewNow.current = deviceView;
    if (session.current instanceof SelkiesSession) session.current.setDeviceView(deviceView);
  }, [deviceView]);
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
  // RFB's own: video goes through bb-box's own input, which names them as most do.
  const macKeys = box?.display?.macKeys ?? null;
  useLayoutEffect(() => {
    if (session.current instanceof DesktopSession) session.current.setMacKeys(macKeys);
  }, [macKeys, connection]);

  // A box that stops or goes takes its stream with it.
  useEffect(() => {
    if (state && !showing && key) dropKept(key);
    if (state && box?.state !== "ready") dropKept(deviceKeyOf(shown));
  }, [state, showing, key]);

  // The box's clipboard comes back while this tab has control, when it
  // changes there, as a macOS desktop's input reports it (#406), or as bb-box
  // reads it in a desktop whose server moves none (#464).
  const connected = connection.state === "connected";
  useEffect(() => {
    if (!mine || !connected) return;
    let stopped = false;
    let seen: number | null = null;
    const fromBox = async () => {
      if (deviceShown || !document.hasFocus()) return;
      const latest = await rpc.call("desktopClipboard", { threadId, box: boxId, viewer }).catch(() => undefined);
      if (stopped || latest === undefined) return;
      if (latest === null) {
        seen ??= 0;
        return;
      }
      if (latest.serial === seen) return;
      // The first answer is what the box had before: only later changes are copied.
      const first = seen === null;
      seen = latest.serial;
      if (first) return;
      setBoxClipboard(latest.text);
      await navigator.clipboard?.writeText?.(latest.text).catch(() => undefined);
    };
    void fromBox();
    const timer = setInterval(() => void fromBox(), CLIPBOARD_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [mine, connected, rpc, threadId, boxId, viewer, deviceShown]);

  const copyFromDeviceNow = useRef<() => Promise<void>>(async () => undefined);
  useEffect(() => {
    if (!deviceShown || !mine || !connected) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const copiedOnDevice = (event: KeyboardEvent) => {
      if (!isCopyChord(event) || !target.current?.contains(document.activeElement)) return;
      clearTimeout(timer);
      timer = setTimeout(() => void copyFromDeviceNow.current(), DEVICE_COPY_AFTER_CHORD_MS);
    };
    window.addEventListener("keydown", copiedOnDevice, true);
    return () => {
      window.removeEventListener("keydown", copiedOnDevice, true);
      clearTimeout(timer);
    };
  }, [deviceShown, mine, connected]);

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
  const toggleSharp = async (on: boolean) => {
    setActing(true);
    setSharpAsked(true);
    try {
      setProblem((await rpc.call("desktop.sharp", { threadId, box: boxId, on })).error);
    } catch (caught) {
      setProblem(message(caught));
    } finally {
      setActing(false);
    }
    await refresh();
    setSharpAsked(false);
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
  const typeShortcut = typeTextShortcutLabel(macBrowser());
  const ownPasteId = useId();
  const openTyping = () => {
    if (!mine) {
      flashFor("Take control first, then type text.");
      return;
    }
    setTyping((now) => now ?? "");
  };
  useEffect(() => {
    if (!mine) setTyping(null);
  }, [mine]);
  const closeTyping = () => setTyping(null);
  const typingOpen = typing !== null && mine;
  const typingNow = useRef(false);
  typingNow.current = typingOpen;
  useEffect(() => {
    session.current?.setTyping(typingOpen);
  }, [typingOpen]);
  const sendTyped = (text: string) => {
    if (!text) return;
    const long = !deviceShown && [...text].length > TYPE_TEXT_PASTE_FROM && (!box || noClipboardThroughServer(box) === null);
    if (long) session.current?.paste(text);
    else session.current?.typeText(text);
    setTyping("");
  };
  /**
   * The menu's Paste: this computer's clipboard, read on the click, which is a gesture; where the frame still refuses, a field to paste into.
   * The video client takes an image too, before text (#609).
   */
  const pasteFromComputer = async () => {
    const video = session.current instanceof SelkiesSession ? session.current : null;
    if (video && !video.device && navigator.clipboard?.read) {
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
  const copyFromDevice = async () => {
    const model = modelNamed(device?.state?.model ?? device?.model ?? box?.device?.model ?? "")?.name ?? "device";
    const read = await rpc.call("deviceClipboard", { threadId, box: boxId, viewer }).catch((caught: unknown) => ({ text: null, error: message(caught) }));
    if (read.text === null) {
      flashFor(read.error ?? `The ${model}'s clipboard could not be read.`);
      return;
    }
    if (!read.text) {
      flashFor(`The ${model}'s clipboard has no text.`);
      return;
    }
    setBoxClipboard(read.text);
    try {
      await navigator.clipboard.writeText(read.text);
      flashFor(copiedFromDeviceWords([...read.text].length, model));
    } catch {
      setCopyField(read.text);
    }
  };
  copyFromDeviceNow.current = copyFromDevice;
  /** The menu's Copy: the box's clipboard as last seen, or fetched now where its input reports it, written to this computer's on the click. */
  const copyToComputer = async () => {
    if (deviceShown) {
      await copyFromDevice();
      return;
    }
    let copied = boxClipboard;
    if (copied === null && !deviceShown) {
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

  const deviceModelNow = modelNamed(device?.state?.model ?? device?.model ?? box?.device?.model ?? "");
  answeredNow.current = (ask, answer) => {
    const model = deviceModelNow;
    if (!answer.ok) {
      flashFor(answer.error.words);
      return;
    }
    if (!model) return;
    if (ask.kind === "open") {
      flashFor(`Opened ${ask.url} on the ${model.name}.`);
      return;
    }
    const control = ask.control;
    const took = `${(answer.ms / 1000).toFixed(1)} s`;
    if (rebootsToShow(control, answer.state)) {
      flashFor(`${doneWords(control, model.name, model.platform)} in ${took}.`, `${SHOWN_AT_START_WORDS}.`, 8_000);
      return;
    }
    if (SHOWN_ON_SCREEN.has(control.action)) return;
    if (control.action === "switch") {
      flashFor(`Switched to the ${control.device} in ${took}.`, `Apps are per device. Install your app again on the ${control.device} if it needs it.`, 8_000);
      return;
    }
    const place = control.action === "location" ? placeAt(control.to) : null;
    const done = doneWords(control, model.name, model.platform);
    const said = place && control.action === "location" && control.to ? done.replace(locationWords(control.to), `${place.name}, ${locationWords(control.to)}`) : done;
    flashFor(`${said} in ${took}.${afterWords(control, model.platform)}`);
  };
  const copyDeviceScreen = () => {
    const model = deviceModelNow?.name ?? "device";
    setShooting(true);
    const picture = rpc.call("deviceScreenshot", { threadId, box: boxId }).then((shot) => {
      if (!shot.png) throw new Error(shot.error ?? "The device sent no picture.");
      return new Blob([base64Bytes(shot.png)], { type: "image/png" });
    });
    const copied =
      typeof ClipboardItem !== "undefined" && navigator.clipboard?.write ? navigator.clipboard.write([new ClipboardItem({ "image/png": picture })]) : Promise.reject(new Error("This browser cannot copy pictures."));
    void copied
      .then(
        () => flashFor(`Copied the ${model}'s screen.`),
        async () => {
          try {
            downloadPicture(await picture, `${model} ${new Date().toISOString().slice(0, 19).replace(/:/g, ".")}.png`);
            flashFor(`Downloaded the ${model}'s screen.`, "This browser did not let bb-box put a picture on this computer's clipboard, so it saved it instead.");
          } catch (caught) {
            flashFor(`Could not take the ${model}'s screenshot.`, message(caught));
          }
        },
      )
      .finally(() => setShooting(false));
  };
  const switchDevice = (to: ModelName) => askDevice({ kind: "control", control: { action: "switch", device: to } });
  const takesFrom = mine ? null : box?.control?.owner === "human" ? "another viewer" : "the agent";

  // The toolbar's state: a dot and a few words.
  let tone: Tone = "busy";
  let words = "Loading…";
  if (error) {
    tone = "bad";
    words = "Could not load";
  } else if (released) {
    tone = "off";
    words = "Released";
  } else if (box && !box.display && !box.device) {
    tone = "off";
    words = "No desktop";
  } else if (box && screen === "device" && !hasDevice) {
    tone = "off";
    words = "No device";
  } else if (box && screen === "desktop" && !hasDesktop) {
    tone = "off";
    words = "No desktop";
  } else if (box && box.state !== "ready") {
    tone = box.state === "stopped" ? "off" : box.state === "failed" || box.state === "gone" ? "bad" : "busy";
    words = statusOf(box, Date.now()).items[0]?.text ?? box.state;
  } else if (box && connection.state === "connecting") {
    words = deviceShown ? `${deviceWaitWords(device)}…` : "Connecting…";
  } else if (box && connection.state === "disconnected") {
    tone = "warn";
    words = "Disconnected";
  } else if (box) {
    tone = "ok";
    words = controlText(box, mine, taken, tookByControl);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface-recessed px-3 py-2 text-xs">
        {onBack ? <BackControl back={onBack} /> : null}
        <ScreenGlyph screen={shows} className="text-muted-foreground" />
        <BoxName name={box?.name ?? lastName.current ?? "Desktop"} page={page} />
        {deviceShown && showing && deviceModelNow && device ? (
          <DevicePicker model={deviceModelNow.name} offered={device.offered} bootedHere={device.bootedHere} state={device.state} compact={compact} takesFrom={takesFrom} onSwitch={switchDevice} />
        ) : null}
        <span className={cn("inline-flex min-w-0 items-center gap-1.5", mine || taken ? "text-foreground" : "text-muted-foreground")}>
          <StatusDot tone={tone} />
          <span className="min-w-0">{words}</span>
        </span>
        {box && hasDevice && hasDesktop ? (
          <OtherScreenButton
            box={box}
            shows={shows}
            onClick={(other) => {
              if (screen && openScreen) return openScreen(box, other);
              storeDisplay(boxId, other);
              chooseDisplay(other);
            }}
          />
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
          {showing && mine && connection.state === "connected" ? (
            <TypeTextButton shortcut={typeShortcut} compact={compact} onClick={openTyping} />
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
                {showing && !deviceShown && ((video === true && canShowVideo() && stream) || sharp !== null) ? (
                  <DisplayItems
                    compact={compact}
                    vnc={
                      video === true && canShowVideo() && stream
                        ? {
                            checked: stream === "rfb",
                            onChange: (checked) => {
                              const next = checked ? "rfb" : "selkies";
                              storeChoice(boxId, next);
                              setVideoFailed(false);
                              decide(next);
                            },
                          }
                        : null
                    }
                    highResolution={
                      sharp !== null
                        ? { checked: sharp, disabled: acting, words: guestOs === "windows" ? WINDOWS_HIGH_RESOLUTION_WORDS : HIGH_RESOLUTION_WORDS, onChange: (checked) => void toggleSharp(checked) }
                        : null
                    }
                  />
                ) : null}
                {showing ? (
                  <>
                    <DropdownMenuSeparator />
                    {/* Both wait for the connection; Paste for control too, so the item says there is one to take. */}
                    <DropdownMenuItem disabled={!mine || connection.state !== "connected"} aria-describedby={ownPasteId} onSelect={() => void pasteFromComputer()}>
                      <PasteGlyph />
                      Paste from this computer
                    </DropdownMenuItem>
                    <p id={ownPasteId} className="max-w-64 px-2 pb-1.5 text-xs text-muted-foreground">
                      {ownPasteWords(deviceShown)}
                    </p>
                    <DropdownMenuItem disabled={connection.state !== "connected"} onSelect={() => void copyToComputer()}>
                      <Icon name="Copy" aria-hidden />
                      Copy to this computer
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!mine || connection.state !== "connected"} onSelect={openTyping}>
                      <KeyboardGlyph />
                      Type text
                      <span className="ml-auto pl-4 text-xs text-muted-foreground">{typeShortcut}</span>
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
      {!deviceShown && showing && box?.device?.simulatorHost ? (
        <p role="note" className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          {DEVICE_HUB_WORDS}
        </p>
      ) : null}
      {deviceShown && showing && device?.stills && connection.state === "connected" ? (
        <p role="status" className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          {device.stillsWhileVideoIsSlow ? SLOW_VIDEO_STILLS_WORDS : STILLS_WORDS}
        </p>
      ) : null}
      {deviceShown && showing && device?.videoWords && connection.state === "connected" ? (
        <p role="status" data-testid="device-video-words" className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          {device.videoWords}
        </p>
      ) : null}
      <div className="relative min-h-0 flex-1 bg-muted">
        <div ref={target} className="absolute inset-0" data-testid="desktop-screen" />
        {mine ? <div aria-hidden data-testid="control-ring" className="pointer-events-none absolute inset-0 ring-2 ring-inset ring-primary/60" /> : null}
        {deviceShown && showing && deviceLayout && deviceModelNow && connection.state !== "disconnected" ? (
          <DeviceToolbar
            model={deviceModelNow}
            state={device?.state ?? null}
            layout={deviceLayout}
            coarse={coarse}
            compact={compact}
            connected={connection.state === "connected"}
            mine={mine}
            takesFrom={takesFrom}
            busy={deviceBusy ?? (shooting ? "screenshot" : null)}
            view={deviceView}
            hint={hintShown}
            onAsk={askDevice}
            onScreenshot={copyDeviceScreen}
            onView={(next) => {
              storeDeviceView(boxId, next);
              setDeviceView(next);
            }}
          />
        ) : null}
        {deviceShown ? (
          <p className="sr-only" aria-live="polite" data-testid="device-announcer">
            {announced}
          </p>
        ) : null}
        {typing !== null && mine && connection.state === "connected" ? (
          <TypeTextField
            name={box?.name ?? "the desktop"}
            value={typing}
            mac={macBrowser()}
            long={[...typing].length > TYPE_TEXT_PASTE_FROM}
            onChange={setTyping}
            onSend={sendTyped}
            onClose={closeTyping}
          />
        ) : null}
        {error ? (
          <Notice>{error}</Notice>
        ) : !state ? null : !box ? (
          <ReleasedNotice name={lastName.current} back={onBack} />
        ) : !box.display && !box.device ? (
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
        ) : connection.state === "connecting" && deviceShown && !(device?.model ?? box.device?.model) ? (
          <Notice detail={deviceWaitWords(device)}>The device</Notice>
        ) : connection.state === "connecting" && deviceShown ? null : connection.state === "connecting" ? (
          <Notice>Connecting to the desktop…</Notice>
        ) : connection.state === "disconnected" ? (
          <Notice
            detail={retryIn > 0 ? `Trying again in ${retryIn} s` : "Trying again…"}
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
              {deviceShown
                ? DEVICE_PASTE_FIELD_WORDS
                : stream === "selkies"
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
              {deviceShown ? "Paste into the device" : "Paste into the box"}
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
export function copiedFromDeviceWords(characters: number, model: string): string {
  return `Copied ${characters} ${characters === 1 ? "character" : "characters"} from the ${model}.`;
}

export function isCopyChord(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): boolean {
  return event.metaKey !== event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "c";
}

function nothingFromBox(box: BoxView, mine: boolean): string {
  const windows = noClipboardThroughServer(box);
  if (windows) return windows;
  if (!mine) return "Nothing has come from the box's clipboard yet. Its desktop sends it to the viewer with control: take control, then copy in the box.";
  return "Nothing has come from the box's clipboard yet. Copy something in the box first.";
}

function parseParams(params: unknown): { box: string; shows: "desktop" | null } | null {
  const { box, shows } = (params as { box?: unknown; shows?: unknown } | null) ?? {};
  return typeof box === "string" && box.length > 0 ? { box, shows: shows === "desktop" ? "desktop" : null } : null;
}

function screenNeighbours(state: PanelState | null | undefined): BoxView[] {
  return state ? [...(state.runsOn ? [state.runsOn.box] : []), ...state.boxes].filter(hasViewer) : [];
}

export function useOpenScreen(threadId: string): (box: BoxView, screen: Screen) => void {
  const navigate = useBbNavigate();
  const rpc = useRpc<Contract>();
  const compactViewport = useIsCompactViewport();
  return (box, screen) => {
    const open = (neighbours: readonly BoxView[]) => void navigate.openThreadPanel({ actionId: actionOf(screen), title: screenTitle(box, screen, neighbours, compactViewport), params: screenParams(box, screen) });
    const known = rememberedLive<PanelState>(threadId);
    if (known) return open(screenNeighbours(known));
    void rpc.call("state", { threadId }).then(screenNeighbours, () => []).then(open);
  };
}

/** The thread panel tab for one box's desktop. Opened bare from its launcher row, it opens the thread's desktop, picks among several, or offers the Box panel. */
export function DesktopPanel({ threadId, params }: { threadId: string; params: unknown }) {
  const opened = parseParams(params);
  const openScreen = useOpenScreen(threadId);
  if (opened) return <DesktopViewer key={opened.box} threadId={threadId} boxId={opened.box} newTab screen={opened.shows} openScreen={openScreen} />;
  return <ScreenChooser threadId={threadId} action={DESKTOP_ACTION} />;
}

export function DevicePanel({ threadId, params }: { threadId: string; params: unknown }) {
  const opened = parseParams(params);
  const openScreen = useOpenScreen(threadId);
  if (opened) return <DesktopViewer key={opened.box} threadId={threadId} boxId={opened.box} newTab screen="device" openScreen={openScreen} />;
  return <ScreenChooser threadId={threadId} action={DEVICE_ACTION} />;
}

/** A box as a row: its glyph, name, kind, state (and who has control, for a desktop), with its actions. */
export function BoxLine({ box, meta, machine = false, actions }: { box: BoxView; meta?: string | null; /** The BB machine the thread runs on (036): its badge. */ machine?: boolean; actions?: React.ReactNode }) {
  const status = statusOf(box, Date.now());
  const control = hasViewer(box) && box.state === "ready" && !controlWord(box, new Set()) ? "The agent has control" : null;
  return (
    <div className="grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-3 py-3">
      <span className="flex size-6 items-center justify-center text-muted-foreground"><BoxGlyph /></span>
      <div className="min-w-0">
        <RowTitle name={box.name} os={systemName(box)} device={deviceModelOf(box)} badges={boxTitleBadges(box, machine)} />
        {/* Who has control comes straight after the state, so a narrow chooser keeps it. */}
        <StatusLine tone={status.tone} items={[status.items[0], control, ...status.items.slice(1), meta]} />
      </div>
      <span className="flex shrink-0 items-center gap-1">{actions}</span>
    </div>
  );
}

/**
 * The bare Desktop or Device launcher tab, made a real shortcut (Task A): one box
 * opens straight away, several offer a chooser, and none sends you to the Box panel.
 * The SDK 0.5.29 has no way to hide the launcher row (see docs/bb-requests.md #14),
 * so the shortcut lives here rather than in the action's run().
 */
function ScreenChooser({ threadId, action }: { threadId: string; action: ScreenAction }) {
  const rpc = useRpc<Contract>();
  const navigate = useBbNavigate();
  const openScreen = useOpenScreen(threadId);
  const { value: state, error } = useLive<PanelState>(threadId, () => rpc.call("state", { threadId }), forThread(threadId));
  // The box this thread runs on counts too (the operator, 4 October 2026): listed first, and alone it opens straight away.
  const runsOn = state?.runsOn && hasViewer(state.runsOn.box) ? state.runsOn.box : null;
  const offered = screenNeighbours(state).filter((box) => action === DESKTOP_ACTION || box.device);
  const screenHere = (box: BoxView): Screen => (action === DEVICE_ACTION || !box.desktop ? "device" : "desktop");
  const only = offered.length === 1 ? offered[0]! : null;
  const title = !state ? null : only ? screenWord(only, screenHere(only)) : ACTION_TITLES[action];
  useRetitleBareTabByWhatItShows(action, title);
  useNow(offered.some((box) => box.state === "acquiring" || box.state === "starting"), 1000);
  if (only) return <DesktopViewer key={only.id} threadId={threadId} boxId={only.id} newTab screen={screenHere(only)} openScreen={openScreen} />;
  const noun = action === DEVICE_ACTION ? "device" : "desktop";
  return (
    <div className="p-4">
      {error ? <EmptyPanel role="alert">{error}</EmptyPanel> : null}
      {state && !offered.length ? (
        <EmptyPanel title={`No ${noun} box`}>
          <p className="mt-1">This thread has no {noun} box.</p>
          <Button type="button" variant="outline" size="sm" className="mt-3 h-7" onClick={() => navigate.openThreadPanel({ actionId: BOXES_ACTION, title: "Box" })}>
            Open the Box panel
          </Button>
        </EmptyPanel>
      ) : null}
      {offered.length ? (
        <div className="rounded-lg border border-border bg-card px-4 py-1">
          <div className="divide-y divide-border">
            {offered.map((box) => (
              <BoxLine
                key={box.id}
                box={box}
                machine={box.id === runsOn?.id}
                actions={
                  <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => openScreen(box, screenHere(box))}>
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

function useRetitleBareTabByWhatItShows(action: ScreenAction, title: string | null): void {
  const navigate = useBbNavigate();
  const given = useRef<string>(ACTION_TITLES[action]);
  useEffect(() => {
    if (title === null || title === given.current) return;
    given.current = title;
    navigate.openThreadPanel({ actionId: action, title });
  }, [action, title]);
}

/** The Boxes page: every box across threads and your machines, a box's own page at box/<boxId>, or one of its views. */
export function BoxesPage({ subPath }: { subPath: string }) {
  const route = routeOf(subPath);
  if (route.page === "box") return <BoxPage key={route.boxId} route={route} />;
  if (route.page === "view") return <BoxViewPage key={`${route.boxId}/${route.view}`} route={route} />;
  if (route.tab) return <BoxList key={route.tab} opening={route.tab} />;
  return <BoxList />;
}

function BoxViewPage({ route }: { route: BoxViewRoute }) {
  const nav = useBoxesNav();
  const { value: page, error } = useBoxPage(route.boxId);
  const now = useNow(false);
  const name = page?.box?.name ?? null;
  const back = nav.back(route, name);
  const toPage = pageOfView(route);
  const backToPage = wayBack(route).to === "box";
  const pageLink: PageLink = { href: nav.href(toPage), go: () => (backToPage && "go" in back ? back.go() : nav.go(toPage)) };
  const threadId = route.threadId ?? page?.threadId ?? null;
  if (page && !page.box) return <NotHere page={page} back={nav.back(toPage, null)} now={now} />;
  if (!threadId) return error ? <EmptyPanel role="alert">{error}</EmptyPanel> : null;
  if (route.view === "terminal") return <BoxTerminal threadId={threadId} boxId={route.boxId} onBack={back} page={pageLink} />;
  const switchView = (_box: BoxView, screen: Screen) => nav.go(otherView(route, screen), { replace: true });
  const legacyDesktop = route.threadId !== null && route.view === "desktop";
  return <DesktopViewer threadId={threadId} boxId={route.boxId} newTab={false} onBack={back} screen={legacyDesktop ? null : route.view} openScreen={legacyDesktop ? undefined : switchView} page={pageLink} />;
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

/** The page's tabs: your machines, and the threads' boxes by thread. */
type BoxesTab = "machines" | "threads";

export const MACHINES_TAB = "machines";

export const THREADS_TAB = "threads";

function BoxList({ opening }: { opening?: BoxesTab }) {
  const rpc = useRpc<Contract>();
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const { value: all, error, refresh } = useLive<BoxEntry[]>("allBoxes", () => rpc.call("allBoxes"), () => true);
  // Your machines with the threads on each, as settings lists them: settings' rows, actions and warnings (the operator, 5 October 2026).
  const { value: machinesState, refresh: refreshMachines } = useLive<MachinesState>("machines", () => rpc.call("machines.list"), forThread(OPERATOR));
  const kinds = machinesState?.kinds ?? [];
  const machines = machinesState?.machines ?? [];
  const refreshBoth = () => Promise.all([refresh(), refreshMachines()]);
  const machineActions = useMachineActions(refreshBoth);
  const [problem, setProblem] = useState<string | null>(null);
  const onDemand = useDesktopOnDemand(machinesState?.desktopOnDemand, OPERATOR, refreshBoth);
  useDesktopProblemShownOnce(machinesState?.desktopProblem, setProblem);
  const [open, setOpen] = useState<string | null>(null);
  const threadActions = useThreadBoxActions(() => refreshBoth());
  const listOpens = useListOpens();
  // The tab chosen last, kept in the browser, so the way back from a box's desktop lands on the tab it left.
  const tabKey = `${pluginId}:boxes-tab`;
  const [chosenTab, setChosenTab] = useState<BoxesTab | null>(() => {
    if (opening) return opening;
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
  const actOn = (threadId: string) => (method: BoxAction, box: BoxView) => threadActions.act(threadId, method, box);
  const entries = all ?? [];
  const threads = entries.filter((entry) => entry.owner !== "yours");
  const threadIds = [...new Set(threads.map((entry) => entry.threadId))];
  const titles = useThreadTitles(threadIds);
  const now = useNow(
    entries.some((entry) => entry.box.state === "acquiring" || entry.box.state === "starting" || entry.box.state === "stopping") || machines.some((entry) => entry.box.state === "acquiring" || entry.box.state === "starting"),
    1000,
  );
  const shownProblem = problem ?? threadActions.problem ?? machineActions.problem;
  const tab: BoxesTab = chosenTab ?? (machines.length || !threads.length ? "machines" : "threads");
  const loaded = !!all && !!machinesState;
  // The filters offer what the tab lists, and keep only what it still offers. A machine's search words are the threads on it.
  const tabBoxes = tab === "machines" ? machines.map((entry) => entry.box) : threads.map((entry) => entry.box);
  const offered = choices(tabBoxes);
  const kept = Object.fromEntries(TAG_GROUPS.map((group) => [group, filters[group].filter((value) => offered[group].includes(value))])) as unknown as Filters;
  const machineListed = machines.map((entry) => ({ box: entry.box, entry, words: entry.threads.map((thread) => thread.title ?? "") }));
  const threadListed = threads.map(({ threadId, box }) => ({ box, threadId, words: [titles[threadId] ?? ""] }));
  const machineRows = shown(machineListed, search, kept, sort);
  const threadRows = shown(threadListed, search, kept, sort);
  const counts = tagCounts(tab === "machines" ? machineListed : threadListed, search, kept);
  const split = splitGroups(tabBoxes);
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
            {kinds.length ? <NewBox kinds={kinds} make={add} onDemand={onDemand} access={machinesState?.access ?? null} machine primary profile={(backend) => rpc.call("provider", { backend })} rooms={(kind, size) => rpc.call("rooms", { kind, ...(size ? { size } : {}) })} /> : null}
          </div>
        </div>
        <div role="tabpanel" className="flex min-h-0 flex-1 flex-col gap-5">
          <SetupProgress empty={false} />
          {listed ? <SearchRow search={search} onSearch={setSearch} filters={kept} offered={offered} counts={counts} split={split} onFilters={setFilters} sort={sort} onSort={setSort} /> : null}
          {error ? <EmptyPanel role="alert">{error}</EmptyPanel> : null}
          <ProblemLine
            problem={shownProblem}
            onDismiss={() => {
              setProblem(null);
              threadActions.setProblem(null);
              machineActions.setProblem(null);
            }}
          />
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
            {loaded && tab === "machines" && !machines.length ? <EmptyPanel>You have no machines. New box adds one: a box of your own that shows in BB's machine list.</EmptyPanel> : null}
            {loaded && tab === "threads" && !threads.length ? <EmptyPanel>No thread has a box.</EmptyPanel> : null}
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
                      onStop={() => void machineActions.act("stop", entry.box)}
                      onStart={() => void machineActions.act("start", entry.box)}
                      onRemove={() => machineActions.askRemove(entry.box)}
                      onForget={() => void machineActions.act("forget", entry.box)}
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
                          opens={listOpens}
                          meta={[hasViewer(box) && box.state === "ready" && !controlWord(box, new Set()) ? "The agent has control" : null]}
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
        {threadActions.dialogs}
      </div>
    </div>
  );
}
