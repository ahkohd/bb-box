// A viewer's desktop as video (056): the box's Selkies stream through the
// plugin's relay (&stream=selkies), decoded with WebCodecs onto a canvas. It
// does what DesktopSession does for noVNC, so the toolbar treats both alike:
// control, the clipboard, the cursor rules (#467), Cmd as Ctrl, and the
// viewer's size once it changes while the viewer has control. Its clipboard carries images too, both
// ways (#609), as Selkies' does: an image goes as its binary clipboard
// messages, and anything over a chunk in parts. Keys are the keysyms of noVNC's own
// keyboard handling, sent as Selkies' kd and ku; the pointer and the wheel go
// as its m and m2. Frames are acknowledged as they come, every 50 ms, as
// Selkies' own page does, which is how the relay paces this viewer.
//
// It cannot show a box without WebCodecs, and gives up, for RFB, when its
// first connection ends before a frame, or brings none within FIRST_FRAME_MS
// of asking for video: onFallback says why.

import Keyboard from "@novnc/novnc/core/input/keyboard.js";
import keysyms from "@novnc/novnc/core/input/keysymdef.js";
import { DECODES_VERB, LEVELS_PAST_52, LEVEL_52_MACROBLOCKS, macroblocks } from "../core/h264.ts";
import { POINTER_VERB } from "../core/pointer.ts";
import { BoxPointer } from "./box-pointer.ts";
import type { Kept } from "./kept.ts";
import { KeysAfterPaste, astralKeysym, keyLog, textKeys, typeTextShortcut, OptionComposer, PASTE_LANDS_MS, tabOf, ShiftedLetters, PASTE_CHORD_DELAY_MS, PASTE_EVENT_WAIT_MS, SETTLE_MS, XK_CONTROL_L, XK_META_L, XK_SHIFT_L, XK_V, boxKey, macBrowser, pasteChordKeys, pasteShortcut, retryWait, type Connection, type PasteShortcut } from "./viewer.ts";

/** X's own keysyms for characters past Latin-1, such as 0x20ac for €, which noVNC sends, by their character. */
let named: Map<number, number> | null = null;

/**
 * A character's keysym as its Unicode one, 0x1000000 and the code point, for a Windows or Mac box: its stream types
 * a character its keyboard layout lacks by the character itself, and knows none of X's own names for them.
 */
export function unicodeKeysym(keysym: number): number {
  if (named === null) {
    named = new Map();
    // noVNC's table names characters up to katakana.
    for (let codepoint = 0x100; codepoint <= 0x30ff; codepoint++) {
      const own = keysyms.lookup(codepoint);
      if (own !== (0x1000000 | codepoint)) named.set(own, codepoint);
    }
  }
  const codepoint = named.get(keysym);
  return codepoint === undefined ? keysym : 0x1000000 | codepoint;
}

/** How long a first connection may ask for video and get no frame before the viewer gives up, for RFB. */
export const FIRST_FRAME_MS = 10_000;
/** How often the viewer says which frame it has shown, as Selkies' own page does. */
const ACK_MS = 50;
/** How long a viewer waits for a frame it decodes, while its stream is larger than its browser decodes, before it shows VNC. */
export const FIT_WAIT_MS = 15_000;
/** The longest the viewer holds its last picture through a High resolution switch, so a switch that fails never freezes the view. */
export const HOLD_MAX_MS = 15_000;
/** How long the box's desktop takes to draw at its new scale after its new size: about 0.6 s on a Proxmox LXC box (the owner's note of 18 October 2026). */
export const HOLD_SETTLE_MS = 800;
/** How long the viewer waits for the new size once the switch is over, or once it asked the desktop for its size, before it shows the stream as it is. */
export const HOLD_NO_SIZE_MS = 2_000;
/** How often the viewer checks that its video still moves. */
const WATCH_MS = 1_000;
/** How long frames may come with none shown, or input go with no frame back, before the video starts again from a key frame. */
export const STALL_MS = 3_000;
/** The least time between two such starts, or a start as the window regains focus: each costs the box a key frame. */
export const RESTART_GAP_MS = 10_000;
/** The cross-fade from the held picture to the new one. */
const HOLD_FADE_MS = 150;
/** A frame message: type 4, H.264. */
const VIDEO = 4;
const H264 = 1;
/** The decoder's codec until a key frame's SPS gives the stream's own. The frames are Annex B, so their parameters come with each key frame. */
const CODEC = "avc1.42E01F";
/** A 4:4:4 stream's codec (High 4:4:4 Predictive), as the box sends when every viewer can decode it. */
const FULL_COLOUR_CODEC = "avc1.F4002A";

/**
 * The codec string of an H.264 key frame in Annex B, from its SPS: profile, constraint flags and level, as
 * "avc1.PPCCLL". Null when it carries no SPS. A 4:4:4 stream needs its own profile: a decoder set up for Baseline
 * fails on it.
 */
export function spsCodec(frame: Uint8Array): string | null {
  for (let i = 0; i + 6 < frame.length; i++) {
    if (frame[i] !== 0 || frame[i + 1] !== 0 || frame[i + 2] !== 1 || (frame[i + 3]! & 31) !== 7) continue;
    const hex = (value: number) => value.toString(16).padStart(2, "0").toUpperCase();
    return `avc1.${hex(frame[i + 4]!)}${hex(frame[i + 5]!)}${hex(frame[i + 6]!)}`;
  }
  return null;
}

let fullColour: Promise<boolean> | null = null;
/** Whether this browser decodes 4:4:4 H.264, which keeps coloured text sharp: asked once. */
export function decodesFullColour(): Promise<boolean> {
  fullColour ??=
    typeof VideoDecoder === "undefined" || typeof VideoDecoder.isConfigSupported !== "function"
      ? Promise.resolve(false)
      : VideoDecoder.isConfigSupported({ codec: FULL_COLOUR_CODEC, optimizeForLatency: true }).then(
          (support) => support.supported === true,
          () => false,
        );
  return fullColour;
}

let largest: Promise<number> | null = null;
/**
 * The largest frame this browser decodes as the box's video, in macroblocks at 60 frames a second (#864): past level 5.2 only where
 * it decodes the level's stream, in 4:4:4 too when it decodes 4:4:4, as the box streams it then. Asked once.
 */
export function decodesMacroblocks(): Promise<number> {
  largest ??= (async () => {
    if (typeof VideoDecoder === "undefined" || typeof VideoDecoder.isConfigSupported !== "function") return LEVEL_52_MACROBLOCKS;
    const supported = (codec: string) =>
      VideoDecoder.isConfigSupported({ codec, optimizeForLatency: true }).then(
        (support) => support.supported === true,
        () => false,
      );
    const colour = await decodesFullColour();
    for (const level of LEVELS_PAST_52) {
      if ((await supported(level.codec)) && (!colour || (await supported(`avc1.F400${level.codec.slice(-2)}`)))) return level.macroblocks;
    }
    return LEVEL_52_MACROBLOCKS;
  })();
  return largest;
}

/** Forgets what this browser decodes, for tests. */
export function forgetFullColour(): void {
  fullColour = null;
  largest = null;
}
/** Notches of a wheel turned by pixels, as a mouse's are about this many pixels each. */
const WHEEL_PIXELS = 50;
/** The clipboard's chunk, as Selkies' own: bytes in one message, a multiple of 3 so each chunk's base64 stands alone. */
const CLIPBOARD_CHUNK = Math.floor((16 * 1024) / 3) * 3;
/** The most a clipboard transfer may carry, either way, as Selkies allows. */
export const CLIPBOARD_MAX_BYTES = 64 * 1024 * 1024;
/** Selkies' type for markup copied with its plain text: a JSON object of type to content. */
const FLAVOURS = "application/x-selkies-clipboard-flavours";

/** Whether this browser can show a desktop as video: WebCodecs, which needs a secure context. */
export function canShowVideo(): boolean {
  return typeof VideoDecoder !== "undefined" && (typeof isSecureContext === "undefined" || isSecureContext);
}

function bytesBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Bytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function fromBase64(value: string): string {
  return new TextDecoder().decode(base64Bytes(value));
}

/** The text of a copy Selkies sends whole, by its type: plain text, or the plain text beside copied markup; null for anything else. */
function clipboardText(mime: string, bytes: Uint8Array): string | null {
  const text = new TextDecoder().decode(bytes);
  if (mime === "text/plain") return text;
  if (mime !== FLAVOURS) return null;
  try {
    const flavours = JSON.parse(text) as Record<string, unknown>;
    return typeof flavours["text/plain"] === "string" ? flavours["text/plain"] : null;
  } catch {
    return null;
  }
}

/** Whether a PNG has a visible pixel; true when the browser cannot tell. */
async function visiblePng(data: string): Promise<boolean> {
  if (typeof createImageBitmap === "undefined" || typeof OffscreenCanvas === "undefined") return true;
  try {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) return true;
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) return true;
    return false;
  } catch {
    return true;
  }
}

/**
 * Closes a decoder unless it is closed already: one that failed closed itself, as Safari's can after the window's size changes or
 * while its tab is away, and closing it again throws. That throw, as a tab came back, crashed the panel (19 October 2026).
 */
function closeDecoder(decoder: VideoDecoder | null): void {
  if (decoder && decoder.state !== "closed") decoder.close();
}

export class SelkiesSession implements Kept {
  readonly element = document.createElement("div");
  readonly #canvas = document.createElement("canvas");
  #hidden = false;
  /** Whether the video is stopped, while no tab shows it or the browser hides the page. */
  #stopped = false;
  readonly #onVisibility = () => {
    if (document.visibilityState === "hidden") this.#letGo();
    this.#video();
  };
  /** The window regains focus, as after the person was away: the video starts again, as a tab coming back does. */
  readonly #onFocus = () => {
    if (this.connection.state === "connected" && performance.now() - this.#restarted >= RESTART_GAP_MS) this.#restart();
  };
  onEnded?: () => void;
  /** The box cannot be shown as video here, with why, in a sentence; the viewer shows it over RFB instead. */
  /** The largest frame this browser decodes, in macroblocks, once known; level 5.2's until then. */
  #decodes = LEVEL_52_MACROBLOCKS;
  /** The stream's frame, in macroblocks, as its frames' headers give it. */
  #streamMacroblocks = 0;
  /** While the stream is larger than this browser decodes, as the box shrinks it for this viewer: the wait for a frame it decodes. */
  #fitting: ReturnType<typeof setTimeout> | undefined;
  #onFallback: ((reason: string) => void) | undefined;
  /** Why video gave way while no tab listened, as when it failed while its tab was away: the next tab hears it. */
  #fallback: string | null = null;
  get onFallback(): ((reason: string) => void) | undefined {
    return this.#onFallback;
  }
  set onFallback(handler: ((reason: string) => void) | undefined) {
    this.#onFallback = handler;
    const reason = this.#fallback;
    if (!handler || reason === null) return;
    this.#fallback = null;
    queueMicrotask(() => handler(reason));
  }
  connection: Connection = { state: "connecting" };
  /** The box's OS: the paste chord is Cmd+V on macOS and Ctrl+V elsewhere, and a Mac browser's Cmd stands for Ctrl there. */
  guestOs = "linux";
  onClipboard?: (text: string) => void;
  /** An image the box copied, as Selkies sends it (#609). */
  onClipboardImage?: (image: Blob) => void;
  /** A paste: the text or image pasted, or null when the browser's clipboard had none and the box pasted its own. */
  onPaste?: (pasted: string | Blob | null) => void;
  onPasteFailed?: (error: unknown) => void;
  putClipboard?: (text: string, automatic?: boolean) => Promise<unknown> | null;
  onTypeText?: () => void;
  pasteAllowed?: () => boolean;
  readonly #url: string;
  readonly #listeners = new Set<() => void>();
  readonly #keyboard: Keyboard;
  #socket: WebSocket | null = null;
  #decoder: VideoDecoder | null = null;
  /** The codec the decoder is set up for: the last key frame's. */
  #codec = CODEC;
  /** Frames are dropped until a key frame, after a connect, a reset or a decoder error. */
  #needKey = true;
  /** The frame received last, and the one last acknowledged: the relay paces this viewer by them, as Selkies' own page acknowledges what it received. */
  #received: number | null = null;
  #acked: number | null = null;
  #ackTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * The watch on the video, while it should show: since when frames have come with none shown, and since when input has gone with no
   * frame back. Either for STALL_MS, the video starts again. A page left long in the background, in Chromium (the owner's note of
   * 19 October 2026), showed nothing new as control was taken, until its tab was switched away and back.
   */
  #watchTimer: ReturnType<typeof setInterval> | undefined;
  #undrawnSince: number | null = null;
  #unansweredSince: number | null = null;
  #restarted = -Infinity;
  /** A frame was shown since this session began: a later end reconnects rather than falls back. */
  #everShown = false;
  #failures = 0;
  #retry: ReturnType<typeof setTimeout> | undefined;
  /** Gives up for RFB when a first connection asked for video and got no frame in time. */
  #firstFrame: ReturnType<typeof setTimeout> | undefined;
  #mine = false;
  #resizable = false;
  /** Whether the desktop follows this tab's size: only once the tab's size changes while it has control, as the RFB viewer does. */
  #follow = false;
  /** The tab's size last seen, as "<w>x<h>". */
  #lastSize: string | null = null;
  #disposed = false;
  /** The desktop's size, from its frames. */
  #width = 0;
  #height = 0;
  #mask = 0;
  #pointer = { x: 0, y: 0 };
  #wheel = 0;
  readonly #held = new Set<number>();
  /** The box's cursor as CSS, and whether it has a visible pixel. */
  #cursor: string | null = null;
  /** The box's pointer drawn over the picture for a viewer without control, where bb-box sends where it is (060). */
  readonly #boxPointer = new BoxPointer(this.element);
  #cursorVisible = false;
  readonly #observer: ResizeObserver | null;
  #settle: ReturnType<typeof setTimeout> | undefined;
  /** A Cmd+V or Ctrl+V taken from the keyboard handler, with Shift or not, while the browser's paste event is awaited. */
  #pasteArmed: PasteShortcut | null = null;
  #pasteWait: ReturnType<typeof setTimeout> | undefined;
  /** Each paste's chord still to go, and whether it has Shift: two pastes in quick succession press it twice. */
  readonly #chords = new Map<ReturnType<typeof setTimeout>, boolean>();
  /** Pastes whose text is still on its way to the box. */
  #putting = 0;
  readonly #onPasteEvent = (event: ClipboardEvent) => this.#takePaste(event);
  /**
   * The last picture, held over the video while High resolution switches, with the size it had: the box's desktop changes its scale
   * and its size apart, so between them it shows the old picture in a corner of the new size, or its panel at the old scale. Held
   * too while the desktop takes this tab's new size, so the old picture is not shown at its old size, centred, until the new one
   * comes. `settle`: how long after the first frame of another size it goes.
   */
  #hold: {
    readonly still: HTMLCanvasElement;
    readonly size: string;
    readonly settle: number;
    released: number | null;
    resized: number | null;
    timer?: ReturnType<typeof setTimeout>;
  } | null = null;
  #holdLimit: ReturnType<typeof setTimeout> | undefined;
  /** A copy the box sends in parts, until its last. */
  #incoming: { readonly mime: string; readonly size: number; readonly parts: Uint8Array<ArrayBuffer>[]; received: number } | null = null;
  #transfers = 0;

  constructor(url: string) {
    this.#url = url;
    this.#afterPaste.join(tabOf(url));
    this.#afterPaste.pressChord = (shifted) => this.#pressPaste(shifted);
    this.element.className = "absolute inset-0";
    // No colour of its own: the pane's, in the theme's neutral, shows around a picture that does not fill it, as it does for VNC.
    this.element.style.background = "transparent";
    this.#canvas.style.cssText = "width:100%;height:100%;object-fit:contain;outline:none;display:block";
    this.#canvas.tabIndex = -1;
    this.element.appendChild(this.#canvas);
    this.#keyboard = new Keyboard(this.#canvas);
    this.#keyboard.onkeyevent = (keysym, code, down, _numlock, capslock) => {
      for (const each of this.#letters.keys(keysym, code, down, capslock)) this.#key(each.keysym, each.code, each.down);
    };
    for (const type of ["pointerdown", "pointerup", "pointermove"] as const) this.#canvas.addEventListener(type, (event) => this.#pointerEvent(event));
    this.#canvas.addEventListener("wheel", (event) => this.#wheelEvent(event), { passive: false });
    this.#canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    this.#observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            const size = entries.at(-1)?.contentRect;
            if (!size || size.width <= 0 || size.height <= 0) return;
            const key = `${Math.round(size.width)}x${Math.round(size.height)}`;
            const moved = this.#lastSize !== null && this.#lastSize !== key;
            this.#lastSize = key;
            this.#drawPointer();
            if (!moved || !this.#mine) return;
            this.#follow = true;
            clearTimeout(this.#settle);
            this.#settle = setTimeout(() => this.#sendSize(true), SETTLE_MS);
          });
    this.#observer?.observe(this.element);
    this.element.addEventListener("keydown", (event) => this.#interceptPaste(event), true);
    for (const type of ["keydown", "keyup"] as const) {
      this.element.addEventListener(type, (event) => this.#interceptTypeText(event), true);
      this.element.addEventListener(type, (event) => this.#astralKey(event), true);
    }
    document.addEventListener("paste", this.#onPasteEvent, true);
    document.addEventListener("visibilitychange", this.#onVisibility);
    window.addEventListener("focus", this.#onFocus);
    if (!canShowVideo()) {
      this.connection = { state: "disconnected", reason: "This browser cannot decode video here.", retryMs: 0 };
      queueMicrotask(() => this.#fallBack("This browser cannot decode video here."));
      return;
    }
    this.connect();
  }

  /** No tab shows it now: its video stops, so the relay never counts a hidden viewer as slow. */
  get hidden(): boolean {
    return this.#hidden;
  }

  set hidden(value: boolean) {
    this.#hidden = value;
    if (value) this.#letGo();
    this.#video();
  }

  /**
   * Lets go in the box of what this viewer holds down, as its tab or page goes: the keys' ups would go nowhere, and a Ctrl the box
   * kept held, from Cmd on a Mac, would turn every click and key that came after into a shortcut. As on hand-back; the window's own
   * blur lets go through the keyboard handler.
   */
  #letGo(): void {
    if (!this.#mine) return;
    this.#keyboard._allKeysUp();
    this.#release();
  }

  /** Stops the video while nobody can see it, and starts it again, from a key frame, when they can. */
  #video(): void {
    const stop = this.#hidden || (typeof document !== "undefined" && document.visibilityState === "hidden");
    if (stop === this.#stopped) return;
    this.#stopped = stop;
    // Not connected: the next connection starts as this says.
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) return;
    if (stop) {
      this.#send("STOP_VIDEO");
      closeDecoder(this.#decoder);
      this.#decoder = null;
      return;
    }
    this.#restart();
    this.#awaitFirstFrame(this.#socket);
  }

  /**
   * Starts the video again from a key frame, with a new decoder, and says which frame came last: as a tab coming back, the page
   * coming back into view, control taken, the window regaining focus, or the watch on the video finding it stalled.
   */
  #restart(): void {
    if (this.#stopped || !this.#socket || this.#socket.readyState !== WebSocket.OPEN) return;
    this.#restarted = performance.now();
    this.#undrawnSince = null;
    this.#unansweredSince = null;
    this.#reset();
    this.#acked = null;
    this.#ack();
    this.#send("START_VIDEO");
    this.#send("REQUEST_KEYFRAME");
  }

  /** Starts the video again when frames come and none shows, or input goes and no frame comes back, while it should show. */
  #watch(): void {
    // While the stream is larger than this browser decodes, frames come and none shows until the box makes it smaller (#864).
    if (this.#stopped || this.#fitting !== undefined || this.connection.state !== "connected") return;
    const now = performance.now();
    if (now - this.#restarted < RESTART_GAP_MS) return;
    const since = Math.min(this.#undrawnSince ?? Infinity, this.#unansweredSince ?? Infinity);
    if (now - since >= STALL_MS) this.#restart();
  }

  /**
   * A stream that connects but sends no frame, as a box whose server cannot reach its screen, would leave the viewer
   * waiting: before the first frame ever shown, it ends the connection and falls back to RFB after FIRST_FRAME_MS.
   */
  #awaitFirstFrame(socket: WebSocket): void {
    clearTimeout(this.#firstFrame);
    if (this.#everShown) return;
    this.#firstFrame = setTimeout(() => {
      if (this.#everShown || this.#socket !== socket || this.#stopped || this.#disposed) return;
      this.#drop();
      this.#fallBack(`No video came within ${FIRST_FRAME_MS / 1000} s.`);
    }, FIRST_FRAME_MS);
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
    const socket = new WebSocket(this.#url);
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    this.#reset();
    this.#set({ state: "connecting" });
    socket.onopen = () => {
      socket.send(`SETTINGS,${JSON.stringify({ displayId: "primary" })}`);
      this.#stopped = this.#hidden || document.visibilityState === "hidden";
      socket.send(this.#stopped ? "STOP_VIDEO" : "START_VIDEO");
      if (!this.#stopped) this.#awaitFirstFrame(socket);
      // Whether this browser decodes 4:4:4: the box streams it while every viewer does (the relay keeps this message).
      void decodesFullColour().then((yes) => {
        if (this.#socket === socket && socket.readyState === WebSocket.OPEN) socket.send(`BB_FULLCOLOR,${yes ? 1 : 0}`);
      });
      // The largest frame it decodes: the box keeps High resolution within what every viewer does (#864).
      void decodesMacroblocks().then((most) => {
        this.#decodes = most;
        if (this.#socket === socket && socket.readyState === WebSocket.OPEN) socket.send(`${DECODES_VERB},${most}`);
      });
    };
    socket.onmessage = (event: MessageEvent) => {
      if (this.#socket === socket) this.#message(event.data);
    };
    socket.onclose = (event: CloseEvent) => {
      if (this.#socket === socket) this.#ended(event.reason);
    };
    clearInterval(this.#ackTimer);
    this.#ackTimer = setInterval(() => this.#ack(), ACK_MS);
    clearInterval(this.#watchTimer);
    this.#watchTimer = setInterval(() => this.#watch(), WATCH_MS);
  }

  reconnect(): void {
    this.#failures = 0;
    this.#drop();
    this.connect();
  }

  /** Forgets the connection and its decoder, without ending the session. */
  #drop(): void {
    clearTimeout(this.#fitting);
    this.#fitting = undefined;
    const socket = this.#socket;
    this.#socket = null;
    clearInterval(this.#ackTimer);
    clearInterval(this.#watchTimer);
    this.#undrawnSince = null;
    this.#unansweredSince = null;
    socket?.close();
    closeDecoder(this.#decoder);
    this.#decoder = null;
  }

  /** Video gives way to VNC, for `reason`: the tab showing it hears now, or the next tab to show it. */
  #fallBack(reason: string): void {
    if (this.#onFallback) this.#onFallback(reason);
    else this.#fallback = reason;
  }

  #ended(reason: string): void {
    this.#drop();
    if (this.#disposed) return;
    if (!this.#everShown) {
      this.#fallBack(reason ? reason.replace(/\.?$/, ".") : "The connection ended before the first frame.");
      return;
    }
    const wait = retryWait(this.#failures);
    this.#failures += 1;
    this.#set({ state: "disconnected", reason: reason || "The connection to the desktop ended.", retryMs: wait });
    if (this.hidden) {
      this.onEnded?.();
      return;
    }
    this.#retry = setTimeout(() => this.connect(), wait);
  }

  /** A new decoder, which takes nothing until a key frame. */
  #reset(): void {
    closeDecoder(this.#decoder);
    this.#needKey = true;
    this.#decoder = new VideoDecoder({
      output: (frame) => this.#draw(frame),
      error: (error) => {
        // A decoder this browser cannot make for the stream's codec, as Safari's for H.264 past level 5.2, fails again however often
        // it is made, and making it again at once spun (19 October 2026): the desktop shows over VNC instead, which any size suits.
        if (error?.name === "NotSupportedError") {
          // A stream larger than this browser decodes, as while the box makes it smaller for this viewer (#864): the decoder waits
          // for a key frame of a size it decodes, for a while.
          if (this.#streamMacroblocks > this.#decodes && this.#fitting === undefined) {
            const codec = this.#codec;
            this.#fitting = setTimeout(() => {
              this.#fitting = undefined;
              this.#drop();
              this.#fallBack(`This browser cannot decode the desktop's video at its size (${codec}).`);
            }, FIT_WAIT_MS);
            return;
          }
          this.#drop();
          this.#fallBack(`This browser cannot decode the desktop's video at its size (${this.#codec}).`);
          return;
        }
        // A frame it could not decode: start again from a key frame.
        this.#reset();
        this.#send("REQUEST_KEYFRAME");
      },
    });
    this.#decoder.configure({ codec: this.#codec, optimizeForLatency: true });
  }

  #message(data: unknown): void {
    if (typeof data === "string") {
      this.#text(data);
      return;
    }
    if (!(data instanceof ArrayBuffer)) return;
    const bytes = new Uint8Array(data);
    if (bytes[0] !== VIDEO || bytes.byteLength < 12 || bytes[1]! >> 4 !== H264) return;
    const key = (bytes[1]! & 15) === 1;
    const id = (bytes[2]! << 8) | bytes[3]!;
    this.#received = id;
    this.#undrawnSince ??= performance.now();
    this.#unansweredSince = null;
    this.#streamMacroblocks = macroblocks((bytes[6]! << 8) | bytes[7]!, (bytes[8]! << 8) | bytes[9]!);
    if (this.#fitting !== undefined) {
      if (!key || this.#streamMacroblocks > this.#decodes) return;
      clearTimeout(this.#fitting);
      this.#fitting = undefined;
      this.#reset();
    }
    if (this.#needKey && !key) return;
    this.#needKey = false;
    const decoder = this.#decoder;
    if (!decoder || decoder.state !== "configured") return;
    // A key frame of another profile, as when the box turns 4:4:4 on or off: the decoder takes the stream's own.
    const codec = key ? spsCodec(bytes.subarray(12)) : null;
    if (codec && codec !== this.#codec) {
      this.#codec = codec;
      decoder.configure({ codec, optimizeForLatency: true });
    }
    decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: id, data: bytes.subarray(12) }));
  }

  #text(text: string): void {
    const comma = text.indexOf(",");
    const verb = (comma < 0 ? text : text.slice(0, comma)).split(" ")[0];
    const rest = comma < 0 ? "" : text.slice(comma + 1);
    switch (verb) {
      case "clipboard":
        try {
          this.onClipboard?.(fromBase64(rest));
        } catch {
          // Not text.
        }
        break;
      case "clipboard_binary": {
        const comma = rest.indexOf(",");
        if (comma < 0) break;
        try {
          this.#copied(rest.slice(0, comma), base64Bytes(rest.slice(comma + 1)));
        } catch {
          // Not base64.
        }
        break;
      }
      case "clipboard_start": {
        const [mime = "", size = ""] = rest.split(",");
        const total = Number(size);
        this.#incoming = mime && Number.isInteger(total) && total >= 0 && total <= CLIPBOARD_MAX_BYTES ? { mime, size: total, parts: [], received: 0 } : null;
        break;
      }
      case "clipboard_data": {
        const incoming = this.#incoming;
        if (!incoming) break;
        try {
          const part = base64Bytes(rest);
          incoming.received += part.byteLength;
          if (incoming.received > incoming.size) this.#incoming = null;
          else incoming.parts.push(part);
        } catch {
          this.#incoming = null;
        }
        break;
      }
      case "clipboard_finish": {
        const incoming = this.#incoming;
        this.#incoming = null;
        if (!incoming || incoming.received !== incoming.size) break;
        const bytes = new Uint8Array(incoming.size);
        let offset = 0;
        for (const part of incoming.parts) {
          bytes.set(part, offset);
          offset += part.byteLength;
        }
        this.#copied(incoming.mime, bytes);
        break;
      }
      case "cursor":
        try {
          const cursor = JSON.parse(rest) as { curdata?: string; hotx?: number; hoty?: number };
          if (typeof cursor.curdata !== "string") break;
          const css = `url(data:image/png;base64,${cursor.curdata}) ${cursor.hotx ?? 0} ${cursor.hoty ?? 0}, default`;
          this.#cursor = css;
          this.#boxPointer.image(cursor.curdata, cursor.hotx ?? 0, cursor.hoty ?? 0);
          this.#drawPointer();
          void visiblePng(cursor.curdata).then((visible) => {
            if (this.#cursor !== css) return;
            this.#cursorVisible = visible;
            this.#refreshCursor();
          });
        } catch {
          // A cursor this viewer cannot read keeps the last.
        }
        break;
      case "PIPELINE_RESETTING":
        this.#reset();
        break;
      case POINTER_VERB:
        this.#boxPointer.at(rest);
        this.#drawPointer();
        break;
    }
  }

  /** A copy in the box that came whole: text, or an image. */
  #copied(mime: string, bytes: Uint8Array<ArrayBuffer>): void {
    if (mime.startsWith("image/")) {
      this.onClipboardImage?.(new Blob([bytes], { type: mime }));
      return;
    }
    const text = clipboardText(mime, bytes);
    if (text !== null) this.onClipboard?.(text);
  }

  /**
   * Puts content on the box's clipboard, in Selkies' messages: one, or in
   * parts when it is over a chunk. Text as text, anything else as binary.
   */
  #putOnBox(mime: string, bytes: Uint8Array): void {
    const text = mime === "text/plain";
    if (bytes.byteLength <= CLIPBOARD_CHUNK) {
      this.#send(text ? `cw,${bytesBase64(bytes)}` : `cb,${mime},${bytesBase64(bytes)}`);
      return;
    }
    const id = `bb${Date.now().toString(36)}${(++this.#transfers).toString(36)}`;
    this.#send(text ? `cws,${id},${bytes.byteLength}` : `cbs,${id},${mime},${bytes.byteLength}`);
    for (let offset = 0; offset < bytes.byteLength; offset += CLIPBOARD_CHUNK) {
      this.#send(`${text ? "cwd" : "cbd"},${id},${bytesBase64(bytes.subarray(offset, offset + CLIPBOARD_CHUNK))}`);
    }
    this.#send(`${text ? "cwe" : "cbe"},${id}`);
  }

  #draw(frame: VideoFrame): void {
    try {
      if (this.#disposed) return;
      const width = frame.displayWidth;
      const height = frame.displayHeight;
      const resized = this.#width !== width || this.#height !== height;
      if (this.#canvas.width !== width || this.#canvas.height !== height) {
        this.#canvas.width = width;
        this.#canvas.height = height;
      }
      this.#width = width;
      this.#height = height;
      if (resized) this.#drawPointer();
      this.#canvas.getContext("2d")?.drawImage(frame, 0, 0);
      this.#undrawnSince = null;
      if (this.#hold && this.#hold.resized === null && this.#hold.size !== `${width}x${height}`) {
        this.#hold.resized = performance.now();
        this.#holdUntil();
      }
      if (this.connection.state !== "connected") {
        this.#everShown = true;
        clearTimeout(this.#firstFrame);
        this.#failures = 0;
        this.#set({ state: "connected" });
        this.#apply();
        // Control held before this connection, as after a reload, a reconnect or a switch from VNC: the desktop keeps its size,
        // unless this tab's size changed while it had control.
        this.#sendSize();
      }
    } finally {
      frame.close();
    }
  }

  /** Says which frame came last, when that changed. */
  #ack(): void {
    if (this.#received === null || this.#received === this.#acked) return;
    this.#acked = this.#received;
    this.#send(`CLIENT_FRAME_ACK ${this.#received} 0`);
  }

  #send(message: string): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(message);
    const key = /^(kd|ku),(\d+)$/.exec(message);
    if (key) keyLog("video", key[1] === "kd", Number(key[2]), this.#held);
    if (/^(m|kd|ku),/.test(message)) this.#unansweredSince ??= performance.now();
  }

  /** Input and resizing follow control. The relay drops input from a viewer without control anyway; this keeps it from being sent. */
  setControl(mine: boolean, resizable: boolean): void {
    const was = this.#mine;
    this.#mine = mine;
    this.#resizable = resizable;
    if (was && !mine) this.#release();
    // Control taken: what the person does shows from a fresh key frame, whatever became of the video while they were away.
    if (mine && !was && this.connection.state === "connected") this.#restart();
    this.#apply();
    // Control taken, or lost: the desktop keeps its size until this tab's size changes while it has control.
    if (mine !== was) this.#follow = false;
  }

  #apply(): void {
    if (this.#mine) {
      this.#keyboard.grab();
      if (this.connection.state === "connected") this.#canvas.focus({ preventScroll: true });
    } else this.#keyboard.ungrab();
    this.#refreshCursor();
  }

  /**
   * The local arrow without control, and with it the box's cursor, unless it
   * has no visible pixel (#467): the video leaves the box's own pointer out
   * while a person holds control, so its shape is the browser's.
   */
  #refreshCursor(): void {
    this.#canvas.style.cursor = this.#mine && this.#cursor && this.#cursorVisible ? this.#cursor : "default";
    this.#drawPointer();
  }

  /**
   * The box's pointer over the picture, where bb-box says it is, for a viewer without control: on a Wayland desktop with
   * bb-box-cursor neither stream has it in its picture (060), so people watching the agent would not see where it points.
   * Scaled and placed as the picture is, fitted to the pane. The viewer with control has their own pointer, in the box's
   * shape, instead.
   */
  #drawPointer(): void {
    const width = this.element.clientWidth;
    const height = this.element.clientHeight;
    const scale = this.#width && this.#height ? Math.min(width / this.#width, height / this.#height) : 0;
    const picture = scale
      ? { left: (width - this.#width * scale) / 2, top: (height - this.#height * scale) / 2, width: this.#width * scale, height: this.#height * scale, desktopWidth: this.#width, desktopHeight: this.#height }
      : null;
    this.#boxPointer.place(picture, this.#mine);
  }

  /** The box's OS, for the paste chord and the Cmd mapping. */
  setGuest(os: string): void {
    this.guestOs = os;
  }

  readonly #option = new OptionComposer();
  readonly #letters = new ShiftedLetters();
  readonly #afterPaste = new KeysAfterPaste<[number, string, boolean]>((key) => this.#sendKey(...key));

  #astralKey(event: KeyboardEvent): void {
    const keysym = astralKeysym(event);
    if (keysym === null) return;
    event.stopPropagation();
    event.preventDefault();
    if (event.type !== "keydown" || this.connection.state !== "connected") return;
    this.#key(keysym, event.code || "Unidentified", true);
    this.#key(keysym, event.code || "Unidentified", false);
  }

  #interceptTypeText(event: KeyboardEvent): void {
    if (!this.#mine || this.connection.state !== "connected" || !typeTextShortcut(event, macBrowser())) return;
    event.stopPropagation();
    event.preventDefault();
    if (event.type === "keydown" && !event.repeat) this.onTypeText?.();
  }

  typeText(text: string): void {
    if (this.connection.state !== "connected") return;
    for (const key of textKeys(text)) {
      this.#key(key.keysym, key.code, true);
      this.#key(key.keysym, key.code, false);
    }
  }

  focusDesktop(): void {
    if (this.#mine && this.connection.state === "connected") this.#canvas.focus({ preventScroll: true });
  }

  #key(keysym: number, code: string, down: boolean): void {
    if (!this.#mine) return;
    if (this.#afterPaste.keep([keysym, code, down])) return;
    this.#sendKey(keysym, code, down);
  }

  #sendKey(keysym: number, code: string, down: boolean): void {
    // bb-box's own Mac input names Command and Option as most servers do.
    const mac = macBrowser();
    const key = boxKey(keysym, code, this.guestOs, mac, null);
    for (const each of mac && this.guestOs !== "macos" ? this.#option.keys(key, down) : [{ key, down }]) {
      const sent = this.guestOs === "windows" || this.guestOs === "macos" ? unicodeKeysym(each.key.keysym) : each.key.keysym;
      if (each.down) this.#held.add(sent);
      else this.#held.delete(sent);
      this.#send(`${each.down ? "kd" : "ku"},${sent}`);
    }
  }

  /** Lets go of what this viewer holds down in the box. */
  #release(): void {
    for (const keysym of this.#held) this.#send(`ku,${keysym}`);
    this.#held.clear();
    this.#option.reset();
    this.#letters.reset();
    if (this.#mask) {
      this.#mask = 0;
      this.#send(`m,${this.#pointer.x},${this.#pointer.y},0,0`);
    }
  }

  /** A point on the canvas, in the desktop's pixels: the canvas scales the desktop to fit, centred. */
  #position(event: MouseEvent): { x: number; y: number } {
    const rect = this.#canvas.getBoundingClientRect();
    if (!this.#width || !this.#height || !rect.width || !rect.height) return this.#pointer;
    const scale = Math.min(rect.width / this.#width, rect.height / this.#height);
    const left = rect.left + (rect.width - this.#width * scale) / 2;
    const top = rect.top + (rect.height - this.#height * scale) / 2;
    const x = Math.round((event.clientX - left) / scale);
    const y = Math.round((event.clientY - top) / scale);
    return { x: Math.max(0, Math.min(this.#width - 1, x)), y: Math.max(0, Math.min(this.#height - 1, y)) };
  }

  #pointerEvent(event: PointerEvent): void {
    if (!this.#mine) return;
    this.#pointer = this.#position(event);
    if (event.type !== "pointermove" && event.button >= 0 && event.button <= 2) {
      // Selkies numbers buttons as the Pointer Events do: 1 primary, 2 middle, 4 secondary.
      const bit = 1 << event.button;
      this.#mask = event.type === "pointerdown" ? this.#mask | bit : this.#mask & ~bit;
      if (event.type === "pointerdown") {
        this.#canvas.focus({ preventScroll: true });
        this.#canvas.setPointerCapture?.(event.pointerId);
      }
      event.preventDefault();
    }
    this.#send(`m,${this.#pointer.x},${this.#pointer.y},${this.#mask},0`);
  }

  /** The wheel, in notches: a press and a release of X's wheel button with no move, as Selkies' page sends it. */
  #wheelEvent(event: WheelEvent): void {
    event.preventDefault();
    if (!this.#mine) return;
    this.#wheel += event.deltaMode === 0 ? event.deltaY : event.deltaY * WHEEL_PIXELS;
    const notches = Math.trunc(this.#wheel / WHEEL_PIXELS);
    if (!notches) return;
    this.#wheel -= notches * WHEEL_PIXELS;
    const bit = 1 << (notches < 0 ? 4 : 3);
    const count = Math.min(Math.abs(notches), 64);
    const rest = this.#mask & ~bit;
    this.#send(`m2,0,0,${rest},${count}`);
    this.#send(`m2,0,0,${rest | bit},${count}`);
    this.#send(`m2,0,0,${this.#mask},${count}`);
  }

  /**
   * The viewer's size, for the desktop to take, while it has control and the desktop can resize. `resized`: the tab's size changed,
   * so the picture shown now is held, stretched to the tab, until a frame of the desktop's new size comes (the owner's note of
   * 18 October 2026).
   */
  #sendSize(resized = false): void {
    if (!this.#mine || !this.#resizable || !this.#follow || this.connection.state !== "connected") return;
    const width = Math.floor(this.element.clientWidth);
    const height = Math.floor(this.element.clientHeight);
    if (width <= 0 || height <= 0) return;
    if (resized && !this.#hold && !this.#hasSize(width, height)) {
      this.#holdStill("fill", 0);
      this.release();
    }
    this.#send(`r,${width}x${height}`);
  }

  /**
   * Whether the desktop has the size it takes for this tab's `width` and `height` already: a width a multiple of 8 and an even height,
   * as bb-box sets it, or twice that at High resolution.
   */
  #hasSize(width: number, height: number): boolean {
    return [1, 2].some((scale) => {
      const wide = width * scale;
      const high = height * scale;
      return wide - (wide % 8) === this.#width && high - (high % 2) === this.#height;
    });
  }

  /** Puts text on the box's clipboard, as a viewer's paste does. */
  sendClipboard(text: string): Promise<boolean> {
    if (this.connection.state !== "connected") return Promise.resolve(false);
    const put = this.putClipboard?.(text, true);
    if (put) return put.then((taken) => taken !== false, () => false);
    this.#putOnBox("text/plain", new TextEncoder().encode(text));
    return Promise.resolve(true);
  }

  /** Puts text on the box's clipboard, then presses the box's own paste chord where the cursor is, and says so. */
  paste(text: string, shifted = false): void {
    if (this.connection.state !== "connected") return;
    this.#afterPaste.hold();
    const put = this.putClipboard?.(text);
    if (!put) {
      this.#putOnBox("text/plain", new TextEncoder().encode(text));
      this.#pressPaste(shifted);
      this.onPaste?.(text);
      return;
    }
    this.#putting++;
    put.then(
      () => {
        this.#putting--;
        // The stream switched while the text was on its way: the tab's new session presses the chord.
        if (this.#disposed) this.#afterPaste.handChord(shifted);
        else this.#pressPaste(shifted);
        this.onPaste?.(text);
      },
      (error: unknown) => {
        this.#putting--;
        if (this.#disposed) this.#afterPaste.drop();
        else if (!this.#pasteDue()) this.#afterPaste.release();
        this.onPasteFailed?.(error);
      },
    );
  }

  /** Whether a paste's chord, or the text it waits for, is still to go. */
  #pasteDue(): boolean {
    return this.#chords.size > 0 || this.#putting > 0;
  }

  /** Puts an image on the box's clipboard, then presses the box's paste chord, and says so (#609). */
  async pasteImage(image: Blob): Promise<void> {
    if (this.connection.state !== "connected") return;
    if (image.size > CLIPBOARD_MAX_BYTES) {
      this.onPasteFailed?.(new Error(`The image is ${Math.ceil(image.size / 1024 / 1024)} MiB, more than the ${CLIPBOARD_MAX_BYTES / 1024 / 1024} MiB the desktop takes.`));
      return;
    }
    this.#afterPaste.hold();
    const bytes = new Uint8Array(await image.arrayBuffer());
    if (this.#disposed || this.connection.state !== "connected") {
      this.#afterPaste.drop();
      return;
    }
    this.#putOnBox(image.type || "image/png", bytes);
    this.#pressPaste();
    this.onPaste?.(image);
  }

  #pressPaste(shifted = false): void {
    this.#afterPaste.hold();
    const chord = setTimeout(() => {
      this.#chords.delete(chord);
      this.#sendChord(shifted);
    }, PASTE_CHORD_DELAY_MS);
    this.#chords.set(chord, shifted);
  }

  #sendChord(shifted: boolean): void {
    if (this.connection.state !== "connected") {
      this.#afterPaste.drop();
      return;
    }
    const modifier = { keysym: this.guestOs === "macos" ? XK_META_L : XK_CONTROL_L };
    const held = [...this.#held].map((keysym) => ({ keysym }));
    const modifiers = shifted ? [modifier, { keysym: XK_SHIFT_L }] : [modifier];
    for (const { key, down } of pasteChordKeys(modifiers, { keysym: XK_V }, held)) this.#send(`${down ? "kd" : "ku"},${key.keysym}`);
    // Keys typed since wait for the last paste on its way.
    if (!this.#pasteDue()) this.#afterPaste.releaseIn(PASTE_LANDS_MS);
  }

  /** A Cmd+V (Ctrl+V off a Mac), or with Shift on a box that is not a Mac, while this tab has control: kept from the keyboard handler, left to the browser, whose paste event brings the text. */
  #interceptPaste(event: KeyboardEvent): void {
    if (!this.#mine || this.connection.state !== "connected" || this.pasteAllowed?.() === false) return;
    const shortcut = pasteShortcut(event, this.guestOs, macBrowser());
    if (!shortcut) return;
    event.stopPropagation();
    this.#pasteArmed = shortcut;
    this.#afterPaste.hold();
    clearTimeout(this.#pasteWait);
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
    const image = Array.from(event.clipboardData?.files ?? []).find((file) => file.type.startsWith("image/"));
    const text = event.clipboardData?.getData("text/plain") ?? "";
    event.preventDefault();
    if (image) {
      void this.pasteImage(image);
      return;
    }
    if (text) {
      this.paste(text, shifted);
      return;
    }
    this.#pressPaste(shifted);
    this.onPaste?.(null);
  }

  /**
   * Holds the picture shown now over the video, scaled to the pane as it is, while High resolution switches. Input still goes to the
   * desktop under it.
   */
  hold(): void {
    this.#holdStill("contain", HOLD_SETTLE_MS);
  }

  /** Holds the picture shown now, fitted to the pane by `fit`, until it goes `settle` after the first frame of another size. */
  #holdStill(fit: "contain" | "fill", settle: number): void {
    if (this.#disposed || this.#hold || !this.#width || this.connection.state !== "connected") return;
    const still = document.createElement("canvas");
    still.width = this.#canvas.width;
    still.height = this.#canvas.height;
    still.getContext("2d")?.drawImage(this.#canvas, 0, 0);
    still.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:${fit};pointer-events:none;transition:opacity ${HOLD_FADE_MS}ms ease-out`;
    this.element.appendChild(still);
    this.#hold = { still, size: `${this.#width}x${this.#height}`, settle, released: null, resized: null };
    this.#holdLimit = setTimeout(() => this.#unhold(), HOLD_MAX_MS);
  }

  /** The switch is over on the box's side: the held picture goes once the new size has come and the desktop has drawn at its new scale. */
  release(): void {
    if (!this.#hold || this.#hold.released !== null) return;
    this.#hold.released = performance.now();
    this.#holdUntil();
  }

  /** Whether a picture is held now. */
  get holding(): boolean {
    return this.#hold !== null;
  }

  #holdUntil(): void {
    const hold = this.#hold;
    if (!hold || hold.released === null) return;
    clearTimeout(hold.timer);
    const wait = hold.resized !== null ? hold.resized + hold.settle : hold.released + HOLD_NO_SIZE_MS;
    hold.timer = setTimeout(() => this.#unhold(), Math.max(0, wait - performance.now()));
  }

  /** The new picture shows, faded in over the held one. */
  #unhold(): void {
    const hold = this.#hold;
    if (!hold) return;
    this.#hold = null;
    clearTimeout(hold.timer);
    clearTimeout(this.#holdLimit);
    hold.still.style.opacity = "0";
    setTimeout(() => hold.still.remove(), HOLD_FADE_MS);
  }

  dispose(): void {
    const due = [...this.#chords];
    this.#chords.clear();
    for (const [chord, shifted] of due) {
      clearTimeout(chord);
      this.#sendChord(shifted);
    }
    this.#afterPaste.close();
    this.#unhold();
    this.#disposed = true;
    clearTimeout(this.#retry);
    clearTimeout(this.#firstFrame);
    clearTimeout(this.#settle);
    clearTimeout(this.#pasteWait);
    document.removeEventListener("paste", this.#onPasteEvent, true);
    document.removeEventListener("visibilitychange", this.#onVisibility);
    window.removeEventListener("focus", this.#onFocus);
    this.#observer?.disconnect();
    this.#keyboard.ungrab();
    this.#drop();
    this.#listeners.clear();
    this.element.remove();
  }
}
