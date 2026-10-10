// A viewer's desktop as video (056): the box's Selkies stream through the
// plugin's relay (&stream=selkies), decoded with WebCodecs onto a canvas. It
// does what DesktopSession does for noVNC, so the toolbar treats both alike:
// control, the clipboard, the cursor rules (#467), Cmd as Ctrl, and the
// viewer's size while it has control. Its clipboard carries images too, both
// ways (#609), as Selkies' does: an image goes as its binary clipboard
// messages, and anything over a chunk in parts. Keys are the keysyms of noVNC's own
// keyboard handling, sent as Selkies' kd and ku; the pointer and the wheel go
// as its m and m2. Frames are acknowledged as they come, every 50 ms, as
// Selkies' own page does, which is how the relay paces this viewer.
//
// It cannot show a box without WebCodecs, and gives up, for RFB, when its
// first connection ends before a frame: onFallback says why.

import Keyboard from "@novnc/novnc/core/input/keyboard.js";
import type { Kept } from "./kept.ts";
import { MAX_RETRY_MS, PASTE_CHORD_DELAY_MS, PASTE_EVENT_WAIT_MS, SETTLE_MS, XK_CONTROL_L, XK_META_L, XK_V, isCommandKey, macBrowser, type Connection } from "./viewer.ts";

/** How often the viewer says which frame it has shown, as Selkies' own page does. */
const ACK_MS = 50;
/** A frame message: type 4, H.264. */
const VIDEO = 4;
const H264 = 1;
/** The decoder's codec. The frames are Annex B, so their parameters come with each key frame. */
const CODEC = "avc1.42E01F";
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

export class SelkiesSession implements Kept {
  readonly element = document.createElement("div");
  readonly #canvas = document.createElement("canvas");
  #hidden = false;
  /** Whether the video is stopped, while no tab shows it or the browser hides the page. */
  #stopped = false;
  readonly #onVisibility = () => this.#video();
  onEnded?: () => void;
  /** The box cannot be shown as video here, with why, in a sentence; the viewer shows it over RFB instead. */
  onFallback?: (reason: string) => void;
  connection: Connection = { state: "connecting" };
  /** The box's OS: the paste chord is Cmd+V on macOS and Ctrl+V elsewhere, and a Mac browser's Cmd stands for Ctrl there. */
  guestOs = "linux";
  onClipboard?: (text: string) => void;
  /** An image the box copied, as Selkies sends it (#609). */
  onClipboardImage?: (image: Blob) => void;
  /** A paste: the text or image pasted, or null when the browser's clipboard had none and the box pasted its own. */
  onPaste?: (pasted: string | Blob | null) => void;
  onPasteFailed?: (error: unknown) => void;
  putClipboard?: (text: string) => Promise<unknown> | null;
  pasteAllowed?: () => boolean;
  readonly #url: string;
  readonly #listeners = new Set<() => void>();
  readonly #keyboard: Keyboard;
  #socket: WebSocket | null = null;
  #decoder: VideoDecoder | null = null;
  /** Frames are dropped until a key frame, after a connect, a reset or a decoder error. */
  #needKey = true;
  /** The frame received last, and the one last acknowledged: the relay paces this viewer by them, as Selkies' own page acknowledges what it received. */
  #received: number | null = null;
  #acked: number | null = null;
  #ackTimer: ReturnType<typeof setInterval> | undefined;
  /** A frame was shown since this session began: a later end reconnects rather than falls back. */
  #everShown = false;
  #failures = 0;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #mine = false;
  #resizable = false;
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
  #cursorVisible = false;
  readonly #observer: ResizeObserver | null;
  #settle: ReturnType<typeof setTimeout> | undefined;
  #pasteArmed: number | null = null;
  #pasteWait: ReturnType<typeof setTimeout> | undefined;
  #chord: ReturnType<typeof setTimeout> | undefined;
  readonly #onPasteEvent = (event: ClipboardEvent) => this.#takePaste(event);
  /** A copy the box sends in parts, until its last. */
  #incoming: { readonly mime: string; readonly size: number; readonly parts: Uint8Array<ArrayBuffer>[]; received: number } | null = null;
  #transfers = 0;

  constructor(url: string) {
    this.#url = url;
    this.element.className = "absolute inset-0";
    // noVNC's screen colour, so a desktop looks the same while either stream connects.
    this.element.style.background = "rgb(40, 40, 40)";
    this.#canvas.style.cssText = "width:100%;height:100%;object-fit:contain;outline:none;display:block";
    this.#canvas.tabIndex = -1;
    this.element.appendChild(this.#canvas);
    this.#keyboard = new Keyboard(this.#canvas);
    this.#keyboard.onkeyevent = (keysym, _code, down) => this.#key(keysym, down);
    for (const type of ["pointerdown", "pointerup", "pointermove"] as const) this.#canvas.addEventListener(type, (event) => this.#pointerEvent(event));
    this.#canvas.addEventListener("wheel", (event) => this.#wheelEvent(event), { passive: false });
    this.#canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    this.#observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            clearTimeout(this.#settle);
            this.#settle = setTimeout(() => this.#sendSize(), SETTLE_MS);
          });
    this.#observer?.observe(this.element);
    this.element.addEventListener("keydown", (event) => this.#interceptPaste(event), true);
    document.addEventListener("paste", this.#onPasteEvent, true);
    document.addEventListener("visibilitychange", this.#onVisibility);
    if (!canShowVideo()) {
      this.connection = { state: "disconnected", reason: "This browser cannot decode video here.", retryMs: 0 };
      queueMicrotask(() => this.onFallback?.("This browser cannot decode video here."));
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
    this.#video();
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
      return;
    }
    this.#reset();
    this.#send("START_VIDEO");
    this.#send("REQUEST_KEYFRAME");
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
    };
    socket.onmessage = (event: MessageEvent) => {
      if (this.#socket === socket) this.#message(event.data);
    };
    socket.onclose = (event: CloseEvent) => {
      if (this.#socket === socket) this.#ended(event.reason);
    };
    clearInterval(this.#ackTimer);
    this.#ackTimer = setInterval(() => this.#ack(), ACK_MS);
  }

  reconnect(): void {
    this.#failures = 0;
    this.#drop();
    this.connect();
  }

  /** Forgets the connection and its decoder, without ending the session. */
  #drop(): void {
    const socket = this.#socket;
    this.#socket = null;
    clearInterval(this.#ackTimer);
    socket?.close();
    this.#decoder?.close();
    this.#decoder = null;
  }

  #ended(reason: string): void {
    this.#drop();
    if (this.#disposed) return;
    if (!this.#everShown) {
      this.onFallback?.(reason ? reason.replace(/\.?$/, ".") : "The connection ended before the first frame.");
      return;
    }
    const wait = Math.min(MAX_RETRY_MS, 1000 * 2 ** this.#failures);
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
    this.#decoder?.close();
    this.#needKey = true;
    this.#decoder = new VideoDecoder({
      output: (frame) => this.#draw(frame),
      error: () => {
        // A frame it could not decode: start again from a key frame.
        this.#reset();
        this.#send("REQUEST_KEYFRAME");
      },
    });
    this.#decoder.configure({ codec: CODEC, optimizeForLatency: true });
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
    if (this.#needKey && !key) return;
    this.#needKey = false;
    const decoder = this.#decoder;
    if (!decoder || decoder.state !== "configured") return;
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
      if (this.#canvas.width !== width || this.#canvas.height !== height) {
        this.#canvas.width = width;
        this.#canvas.height = height;
      }
      this.#width = width;
      this.#height = height;
      this.#canvas.getContext("2d")?.drawImage(frame, 0, 0);
      if (this.connection.state !== "connected") {
        this.#everShown = true;
        this.#failures = 0;
        this.#set({ state: "connected" });
        this.#apply();
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
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(message);
  }

  /** Input and resizing follow control. The relay drops input from a viewer without control anyway; this keeps it from being sent. */
  setControl(mine: boolean, resizable: boolean): void {
    const was = this.#mine;
    this.#mine = mine;
    this.#resizable = resizable;
    if (was && !mine) this.#release();
    this.#apply();
    if (mine && !was) this.#sendSize();
  }

  #apply(): void {
    if (this.#mine) {
      this.#keyboard.grab();
      if (this.connection.state === "connected") this.#canvas.focus({ preventScroll: true });
    } else this.#keyboard.ungrab();
    this.#refreshCursor();
  }

  /** The local arrow without control, and with it the box's cursor, unless it has no visible pixel (#467). */
  #refreshCursor(): void {
    this.#canvas.style.cursor = this.#mine && this.#cursor && this.#cursorVisible ? this.#cursor : "default";
  }

  /** The box's OS, for the paste chord and the Cmd mapping. */
  setGuest(os: string): void {
    this.guestOs = os;
  }

  #key(keysym: number, down: boolean): void {
    if (!this.#mine) return;
    const sent = macBrowser() && this.guestOs !== "macos" && isCommandKey(keysym) ? XK_CONTROL_L : keysym;
    if (down) this.#held.add(sent);
    else this.#held.delete(sent);
    this.#send(`${down ? "kd" : "ku"},${sent}`);
  }

  /** Lets go of what this viewer holds down in the box. */
  #release(): void {
    for (const keysym of this.#held) this.#send(`ku,${keysym}`);
    this.#held.clear();
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

  /** The viewer's size, for the desktop to take, while it has control and the desktop can resize. */
  #sendSize(): void {
    if (!this.#mine || !this.#resizable || this.connection.state !== "connected") return;
    const width = Math.floor(this.element.clientWidth);
    const height = Math.floor(this.element.clientHeight);
    if (width > 0 && height > 0) this.#send(`r,${width}x${height}`);
  }

  /** Puts text on the box's clipboard, as a viewer's paste does. */
  sendClipboard(text: string): void {
    if (this.connection.state !== "connected") return;
    const put = this.putClipboard?.(text);
    if (put) put.catch(() => undefined);
    else this.#putOnBox("text/plain", new TextEncoder().encode(text));
  }

  /** Puts text on the box's clipboard, then presses the box's own paste chord where the cursor is, and says so. */
  paste(text: string): void {
    if (this.connection.state !== "connected") return;
    const put = this.putClipboard?.(text);
    if (!put) {
      this.#putOnBox("text/plain", new TextEncoder().encode(text));
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

  /** Puts an image on the box's clipboard, then presses the box's paste chord, and says so (#609). */
  async pasteImage(image: Blob): Promise<void> {
    if (this.connection.state !== "connected") return;
    if (image.size > CLIPBOARD_MAX_BYTES) {
      this.onPasteFailed?.(new Error(`The image is ${Math.ceil(image.size / 1024 / 1024)} MiB, more than the ${CLIPBOARD_MAX_BYTES / 1024 / 1024} MiB the desktop takes.`));
      return;
    }
    const bytes = new Uint8Array(await image.arrayBuffer());
    if (this.connection.state !== "connected") return;
    this.#putOnBox(image.type || "image/png", bytes);
    this.#pressPaste();
    this.onPaste?.(image);
  }

  #pressPaste(): void {
    clearTimeout(this.#chord);
    this.#chord = setTimeout(() => {
      if (this.connection.state !== "connected") return;
      const modifier = this.guestOs === "macos" ? XK_META_L : XK_CONTROL_L;
      for (const message of [`kd,${modifier}`, `kd,${XK_V}`, `ku,${XK_V}`, `ku,${modifier}`]) this.#send(message);
    }, PASTE_CHORD_DELAY_MS);
  }

  /** A Cmd+V (Ctrl+V off a Mac) while this tab has control: kept from the keyboard handler, left to the browser, whose paste event brings the text. */
  #interceptPaste(event: KeyboardEvent): void {
    if (!this.#mine || this.connection.state !== "connected" || this.pasteAllowed?.() === false) return;
    if (event.key.toLowerCase() !== "v" || event.altKey || event.shiftKey) return;
    if (!(macBrowser() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return;
    event.stopPropagation();
    this.#pasteArmed = Date.now();
    clearTimeout(this.#pasteWait);
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
    const image = Array.from(event.clipboardData?.files ?? []).find((file) => file.type.startsWith("image/"));
    const text = event.clipboardData?.getData("text/plain") ?? "";
    event.preventDefault();
    if (image) {
      void this.pasteImage(image);
      return;
    }
    if (text) {
      this.paste(text);
      return;
    }
    this.#pressPaste();
    this.onPaste?.(null);
  }

  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#retry);
    clearTimeout(this.#settle);
    clearTimeout(this.#pasteWait);
    clearTimeout(this.#chord);
    document.removeEventListener("paste", this.#onPasteEvent, true);
    document.removeEventListener("visibilitychange", this.#onVisibility);
    this.#observer?.disconnect();
    this.#keyboard.ungrab();
    this.#drop();
    this.#listeners.clear();
    this.element.remove();
  }
}
