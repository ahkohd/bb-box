// The desktop relay for a Selkies display (056): one per viewer connection,
// as RfbRelay is for RFB. It carries messages, not bytes, and never decodes
// video.
//
// Each viewer is a Selkies page of its own, joined as a viewer (role=viewer),
// so Selkies never hands the display from one page to another. A viewer may
// only watch there, so the input of the viewer with control goes over the
// box's input connection, a controller of the relay's own that asks for no
// video (SelkiesBox). The relay passes the viewer's video requests and drops
// everything else it sends, input from a viewer without control included.
//
// Selkies paces a viewer by its own socket's send queue, which the route to
// the box hides, so the relay paces each viewer by the frames it says it has
// shown: past LAG_MS behind, it drops that viewer's frames until the viewer
// has caught up, then asks for a key frame and resumes from it. Selkies takes
// a viewer's key frame request at most once a second and drops the rest, so
// the relay asks on the box's input connection when it is open, which may ask
// four times a second, and otherwise asks again until one comes.
//
// Selkies refuses a connection from an address that connected less than
// 500 ms before, and every connection from the relay comes from the box's
// own loopback, so the box's connections open one at a time, spaced.

import type { ByteChannel } from "../transports/types.ts";
import { BoxWebSocket, WebSocketError, type Message } from "./websocket.ts";

const PATH = "/api/websockets";
/** Selkies' RECONNECT_DEBOUNCE_MS, with a margin. */
const OPEN_SPACING_MS = 550;
/** Selkies' close code for a connection that came too soon. */
const TOO_SOON = 4029;
const OPEN_TRIES = 4;
/**
 * How far behind a viewer may fall, from a frame's send to its
 * acknowledgement, before its frames are dropped. A pause on the way through
 * BB's server, which can last half a second, is not a viewer that cannot
 * keep up.
 */
export const LAG_MS = 1000;
/** How often the relay asks for a key frame for a viewer that caught up, until one comes. */
const KEYFRAME_RETRY_MS = 250;
/** How often the input connection asks for no video, when frames come to it. */
const STOP_ASK_MS = 1000;
const VIDEO = 4;
const JPEG = 3;

/** Opens a channel to the box's Selkies, through the display's route. */
export type OpenStream = (signal: AbortSignal) => Promise<ByteChannel>;

/** What a message from a viewer is, by its first comma-separated field. */
type Kind = "video" | "ack" | "input" | "drop";
const VIDEO_VERBS = new Set(["SETTINGS", "START_VIDEO", "STOP_VIDEO", "REQUEST_KEYFRAME"]);
/** Keys, pointer, typing and the clipboard: what Selkies takes only from a page with control. */
const INPUT_VERBS = new Set(["kd", "ku", "kh", "kr", "m", "m2", "co", "cw", "cb", "cws", "cbs", "cwd", "cbd", "cwe", "cbe", "cr", "REQUEST_CLIPBOARD"]);
/** What Selkies sends of the box's clipboard: only the viewer with control gets it, as with RFB. */
const CLIPBOARD_VERBS = new Set(["clipboard", "clipboard_binary", "clipboard_start", "clipboard_data", "clipboard_finish", "clipboard_reply"]);

function verb(text: string): string {
  const comma = text.indexOf(",");
  const space = text.indexOf(" ");
  const ends = [comma, space].filter((at) => at >= 0);
  return ends.length ? text.slice(0, Math.min(...ends)) : text;
}

export function classify(text: string): Kind {
  const first = verb(text);
  if (first === "CLIENT_FRAME_ACK") return "ack";
  if (VIDEO_VERBS.has(first)) return "video";
  if (INPUT_VERBS.has(first)) return "input";
  return "drop";
}

/** A pointer message without its sequence number: one connection carries every holder's, so a new holder's low numbers are not stale. */
export function unsequenced(text: string): string {
  const fields = text.split(",");
  return (fields[0] === "m" || fields[0] === "m2") && fields.length > 5 ? fields.slice(0, 5).join(",") : text;
}

/** The time, and a wait: the system's, or a test's own, which waits for nothing. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Waits between a box's connections, so Selkies takes each. */
export class Spacing {
  readonly #ms: number;
  readonly #clock: Clock;
  #next = 0;

  constructor(ms: number, clock: Clock) {
    this.#ms = ms;
    this.#clock = clock;
  }

  /** Selkies refused one for coming too soon, as after another client of the box: the next waits a whole spacing from now. */
  refused(): void {
    this.#next = Math.max(this.#next, this.#clock.now() + this.#ms);
  }

  async turn(): Promise<void> {
    const now = this.#clock.now();
    const at = Math.max(now, this.#next);
    this.#next = at + this.#ms;
    if (at > now) await this.#clock.sleep(at - now);
  }
}

/** Opens a WebSocket to the box's Selkies, spaced from the box's other connections, again when Selkies says it came too soon. */
async function connect(open: OpenStream, spacing: Spacing, query: string, signal: AbortSignal): Promise<{ socket: BoxWebSocket; first: Message | null }> {
  for (let attempt = 1; ; attempt++) {
    await spacing.turn();
    const socket = await BoxWebSocket.upgrade(await open(signal), { host: "localhost", path: `${PATH}${query}`, signal });
    // Selkies accepts the upgrade, then closes a connection that came too soon.
    const first = await socket.next();
    if (first !== null || socket.closedWith?.code !== TOO_SOON || attempt >= OPEN_TRIES) return { socket, first };
    spacing.refused();
  }
}

/**
 * A box's side of its Selkies viewers: the spacing of their connections and
 * the input connection, which carries the input of the viewer with control.
 */
export class SelkiesBox {
  readonly #open: OpenStream;
  readonly spacing: Spacing;
  /** The time the box's connections are spaced by, and its viewers paced by. */
  readonly clock: Clock;
  #input: Promise<BoxWebSocket> | null = null;
  /** The input connection, once open. */
  #ready: BoxWebSocket | null = null;
  #stopAsked = 0;
  #closed = false;
  #pinged = 0;
  /** Who waits for each BB_PONG, by its ID. */
  readonly #pongs = new Map<string, () => void>();
  /** The message that last asked the box to draw its cursor into the video, or not, to send again on a new input connection. */
  #cursor: string | null = null;
  readonly onError: (error: Error) => void;
  /**
   * Whether the box's video comes from elsewhere than this stream server (#865), as known once `open` has run: then
   * it captures nothing, and what it sends the input connection of the clipboard and the pointer's shape goes to
   * `onText`, for the viewers, which reach it no other way.
   */
  readonly #apart: () => boolean;
  readonly #onText: (message: string) => void;

  constructor(
    open: OpenStream,
    options: { onError?: (error: Error) => void; spacingMs?: number; clock?: Clock; apart?: () => boolean; onText?: (message: string) => void } = {},
  ) {
    this.#open = open;
    this.onError = options.onError ?? (() => undefined);
    this.#apart = options.apart ?? (() => false);
    this.#onText = options.onText ?? (() => undefined);
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.spacing = new Spacing(options.spacingMs ?? OPEN_SPACING_MS, this.clock);
  }

  /** Opens the input connection, if it is not open, so the first input does not wait for it. */
  warm(): void {
    if (this.#closed) return;
    this.#connection().catch(() => undefined);
  }

  /** Sends one input message to the box; opens the input connection first if needed. */
  async input(message: string): Promise<void> {
    if (this.#closed) return;
    const socket = await this.#connection();
    await socket.send(message);
  }

  /**
   * Whether the box's stream server has taken every message sent before this,
   * as bb-box-stream on Windows says, answering BB_PING with BB_PONG; false
   * after `timeoutMs` without its answer, as from a server that does not say.
   */
  async ping(timeoutMs: number): Promise<boolean> {
    const id = String(++this.#pinged);
    let wait: ReturnType<typeof setTimeout> | undefined;
    let settle!: (answered: boolean) => void;
    const answered = new Promise<boolean>((resolve) => (settle = resolve));
    this.#pongs.set(id, () => settle(true));
    try {
      // The wait starts once it is sent: opening the input connection, over SSH, is not the server's answer.
      await this.input(`BB_PING,${id}`);
      wait = setTimeout(() => settle(false), timeoutMs);
      return await answered;
    } finally {
      clearTimeout(wait);
      this.#pongs.delete(id);
    }
  }

  #connection(): Promise<BoxWebSocket> {
    this.#input ??= (async () => {
      const { socket, first } = await connect(this.#open, this.spacing, "", AbortSignal.timeout(20_000));
      if (first === null) throw new WebSocketError(`The box's Selkies closed the input connection${socket.closedWith ? ` (${socket.closedWith.code})` : ""}.`);
      // Selkies ignores SET_NATIVE_CURSOR_RENDERING on a connection that has sent no SETTINGS yet, after waiting 15 s
      // for them: so a viewer that connected while the agent held control saw no pointer in the video until control
      // changed hands. A SETTINGS that names only the display keeps its size and lets the cursor message through. It
      // starts a capture, so the STOP_VIDEO comes after it: before it, the capture ran with nobody watching, for about
      // a fifth of a core on an idle box; after it, a watching page keeps its video without a restart (measured
      // 18 October 2026).
      await socket.send(`SETTINGS,${JSON.stringify({ displayId: "primary" })}`);
      await socket.send("STOP_VIDEO");
      // A stream server that started again draws its cursor, as by default: it is told again.
      if (this.#cursor !== null) await socket.send(this.#cursor);
      this.#ready = socket;
      void this.#drain(socket);
      return socket;
    })();
    this.#input.catch((error: unknown) => {
      this.#input = null;
      this.onError(error instanceof Error ? error : new Error(String(error)));
    });
    return this.#input;
  }

  /**
   * Has Selkies capture the desktop at `size`, the size it has now. Selkies
   * follows a screen that shrinks, but captures one that grows at its old
   * size, so a viewer sees a small picture, or part of the desktop. A
   * controller's SETTINGS with the size as its manual resolution moves the
   * capture at once, without a restart, and tells every page the new size.
   *
   * It moves it only while the controller wants video: otherwise it stops the
   * capture and waits for a START_VIDEO, which bb-box's restart sends after
   * about a second. The input connection wants none from its STOP_VIDEO, but
   * Selkies counts it as wanting video while pages watch, until the last
   * watching page stops its video, as for a restart of the capture or a hidden
   * tab; then not again. So the input connection asks for video and stops it
   * first: with pages watching, Selkies keeps the capture and the controller
   * wants video, but sends it none (measured 18 October 2026).
   */
  async follow(size: { readonly width: number; readonly height: number }): Promise<void> {
    // Video from elsewhere follows the desktop itself; this server captures nothing.
    if (await this.#videoApart()) return;
    const settings = { displayId: "primary", manual_resolution: true, manual_width: size.width, manual_height: size.height, force_aligned_resolution: false };
    await this.input("START_VIDEO");
    await this.input("STOP_VIDEO");
    await this.input(`SETTINGS,${JSON.stringify(settings)}`);
  }

  /**
   * Streams the display in 4:4:4 or 4:2:0. Selkies takes this from a controller only, for every page of the display, so
   * bb-box asks for 4:4:4 while every viewer decodes it: coloured text keeps its edges, for about a tenth of a core
   * more and the same bandwidth (measured 16 October 2026). Selkies restarts the capture, from a key frame.
   */
  async fullColour(on: boolean): Promise<void> {
    if (await this.#videoApart()) return;
    await this.input(`SETTINGS,${JSON.stringify({ displayId: "primary", video_fullcolor: on })}`);
  }

  /**
   * Has the display's video draw the box's cursor in, or leave it out: out
   * while a person holds control, whose browser shows the cursor's shape
   * itself, so the two do not drift apart. bb-box-stream takes BB_CURSOR
   * ("stream"); Selkies, SET_NATIVE_CURSOR_RENDERING ("selkies"), which
   * restarts its capture.
   */
  async cursorInVideo(on: boolean, how: "stream" | "selkies"): Promise<void> {
    if (this.#closed) return;
    this.#cursor = how === "stream" ? `BB_CURSOR,${on ? 1 : 0}` : `SET_NATIVE_CURSOR_RENDERING,${on ? 1 : 0}`;
    // A connection that opens now says it as it opens.
    if (!this.#ready) {
      await this.#connection();
      return;
    }
    await this.#ready.send(this.#cursor);
  }

  /**
   * Asks for a key frame over the input connection, a controller, which
   * Selkies lets ask four times a second. False when it is not open: the
   * viewer asks itself.
   */
  keyframe(): boolean {
    const socket = this.#ready;
    // Video from elsewhere: each viewer asks its own source.
    if (this.#apart()) return false;
    if (!socket || this.#closed) return false;
    socket.send("REQUEST_KEYFRAME").catch(() => undefined);
    return true;
  }

  /** Whether the video comes from elsewhere, once the input connection has opened, which tells. */
  async #videoApart(): Promise<boolean> {
    if (this.#closed) return false;
    await this.#connection().catch(() => undefined);
    return this.#apart();
  }

  /** Reads what Selkies sends the input connection. It asks for no video again whenever a frame comes, as a new capture sends to every page. */
  async #drain(socket: BoxWebSocket): Promise<void> {
    try {
      for (let message = await socket.next(); message !== null; message = await socket.next()) {
        if (typeof message === "string" && message.startsWith("BB_PONG,")) this.#pongs.get(message.slice(8))?.();
        else if (typeof message === "string" && this.#apart() && (CLIPBOARD_VERBS.has(verb(message)) || verb(message) === "cursor")) this.#onText(message);
        if (typeof message !== "string" && this.clock.now() - this.#stopAsked > STOP_ASK_MS) {
          this.#stopAsked = this.clock.now();
          await socket.send("STOP_VIDEO");
        }
      }
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (this.#ready === socket) this.#ready = null;
      if (this.#input && (await this.#input.catch(() => null)) === socket) this.#input = null;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    const input = this.#input;
    this.#input = null;
    this.#ready = null;
    await input?.then((socket) => socket.close()).catch(() => undefined);
  }
}

/** The viewer's end: BB's plugin WebSocket, which keeps text and binary apart. */
export interface SelkiesViewer {
  send(message: Message): void;
  close(code: number, reason: string): void;
}

export interface SelkiesRelayOptions {
  readonly viewer: SelkiesViewer;
  readonly box: SelkiesBox;
  readonly open: OpenStream;
  /** Whether input from this viewer reaches the box now. */
  mayInput(): boolean;
  /** The desktop's size, from the first frame and each change. */
  onSize?(size: { readonly width: number; readonly height: number }): void;
  /** The viewer with control asked for its size (Selkies' `r,<W>x<H>`). The relay does not pass it on: bb-box sets the size. */
  onResize?(size: { readonly width: number; readonly height: number }): void;
  /** Whether the viewer's browser decodes 4:4:4, as it says once connected (bb-box's `BB_FULLCOLOR,<0|1>`, which goes no further). */
  onFullColour?(yes: boolean): void;
  /** The largest frame the viewer's browser decodes, in macroblocks, as it says once connected (bb-box's `BB_DECODES,<n>`, which goes no further). */
  onDecodes?(macroblocks: number): void;
  onEnd?(by: "viewer" | "box", error: Error | null): void;
  /**
   * Whether bb-box sends this viewer the box's cursor itself, from
   * bb-box-cursor (060): then Selkies' own cursor messages, one arrow
   * whatever the shape on Sway, go no further.
   */
  ownCursor?(): boolean;
  /**
   * Whether the viewer's pointer goes to its own connection, the video's source, rather than the box's stream server:
   * where the video comes from elsewhere, as a Windows VM's from QEMU on its Mac, which takes the pointer as its VNC
   * display does (#865).
   */
  pointerApart?(): boolean;
  readonly connectTimeoutMs?: number;
  /** How far behind the viewer may fall; LAG_MS by default. */
  readonly lagMs?: number;
}

/** Circular distance from a to b on uint16 frame ids. */
function ahead(a: number, b: number): number {
  return (b - a + 65536) % 65536;
}

export class SelkiesRelay {
  readonly #options: SelkiesRelayOptions;
  readonly #socket: Promise<{ socket: BoxWebSocket; first: Message }>;
  #ended = false;
  /** Keys this viewer holds down in the box, by keysym. */
  readonly #held = new Set<string>();
  #pointer = { x: 0, y: 0, mask: 0 };
  /** Whether this viewer's pointer went to the video's source, which then knows where it is (#865). */
  #pointerSent = false;
  /** When each frame went to the viewer, by id, until it says it has shown it. */
  readonly #sent = new Map<number, number>();
  #lastSent: number | null = null;
  #acked: number | null = null;
  /** The viewer fell behind: its frames are dropped until a key frame. */
  #behind = false;
  #keyframeAsked = 0;
  /** The desktop's size as the last frame gave it. */
  #size = "";
  /** Messages from the viewer before the box's side opened; null once it has. */
  #early: string[] | null = [];
  /** The viewer wants video: it has not asked for none, as a hidden tab does. */
  #wants = true;

  constructor(options: SelkiesRelayOptions) {
    this.#options = options;
    this.#socket = (async () => {
      const { socket, first } = await connect(options.open, options.box.spacing, "?role=viewer", AbortSignal.timeout(options.connectTimeoutMs ?? 20_000));
      if (first === null) throw new WebSocketError(`The box's Selkies closed the connection${socket.closedWith ? ` (${socket.closedWith.code})` : ""}.`);
      return { socket, first };
    })();
    this.#socket.catch(() => undefined);
    void this.#pump();
  }

  /** What the box sends, to the viewer, after the viewer's messages that came first. */
  async #pump(): Promise<void> {
    let socket: BoxWebSocket;
    let message: Message | null;
    try {
      ({ socket, first: message } = await this.#socket);
    } catch (error) {
      await this.#end("box", error instanceof Error ? error : new Error(String(error)));
      return;
    }
    try {
      // Messages the viewer sends meanwhile join the list, and are sent in turn.
      for (const text of this.#early ?? []) await socket.send(text);
      this.#early = null;
      for (; message !== null && !this.#ended; message = await socket.next()) this.#toViewer(socket, message);
      const closed = socket.closedWith;
      await this.#end("box", closed && closed.code !== 1000 && closed.code !== 1005 ? new Error(`The box's Selkies closed the connection (${closed.code}).`) : null);
    } catch (error) {
      await this.#end("box", error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * A message of the box's stream server that came by another connection than this viewer's, where its video comes
   * from elsewhere (#865): the clipboard and the pointer's shape, as if it had come by this one.
   */
  fromBox(message: string): void {
    if (this.#ended) return;
    if (CLIPBOARD_VERBS.has(verb(message)) && !this.#options.mayInput()) return;
    if (verb(message) === "cursor" && this.#options.ownCursor?.()) return;
    this.#options.viewer.send(message);
  }

  #toViewer(socket: BoxWebSocket, message: Message): void {
    if (typeof message === "string") {
      this.fromBox(message);
      return;
    }
    if ((message[0] === VIDEO || message[0] === JPEG) && message.byteLength >= 4) {
      const id = (message[2]! << 8) | message[3]!;
      const key = message[0] === VIDEO && (message[1]! & 15) === 1;
      if (!this.#pace(socket, id, key)) return;
      // The size of a frame the viewer gets: one it does not get shows it nothing (the owner's note of 18 October 2026).
      if (message[0] === VIDEO && message.byteLength >= 10) this.#sized((message[6]! << 8) | message[7]!, (message[8]! << 8) | message[9]!);
    }
    this.#options.viewer.send(message);
  }

  #sized(width: number, height: number): void {
    const size = `${width}x${height}`;
    if (!width || !height || size === this.#size) return;
    this.#size = size;
    this.#options.onSize?.({ width, height });
  }

  /**
   * Whether a frame goes to the viewer. More than LAG_MS behind, it gets none
   * until it has shown what it was sent, then none until a key frame. It asks
   * for that only then, as a key frame goes to every viewer of the box, and
   * again every KEYFRAME_RETRY_MS until one comes.
   */
  #pace(socket: BoxWebSocket, id: number, key: boolean): boolean {
    const now = this.#options.box.clock.now();
    // Selkies numbers a capture's frames from 0 again each time it starts one: a key frame that does not follow the last frame sent
    // starts a new capture, which the frames the viewer has not acknowledged from the old one must not hold back for good.
    if (key && this.#lastSent !== null) {
      const step = ahead(this.#lastSent, id);
      if (step === 0 || step >= 32768) {
        this.#sent.clear();
        this.#acked = null;
        this.#behind = false;
      }
    }
    const oldest = this.#oldestUnacked();
    if (!this.#behind && oldest !== null && now - oldest > (this.#options.lagMs ?? LAG_MS)) this.#behind = true;
    if (this.#behind) {
      if (oldest !== null) return false;
      if (!key) {
        if (now - this.#keyframeAsked >= KEYFRAME_RETRY_MS) {
          this.#keyframeAsked = now;
          if (!this.#options.box.keyframe()) socket.send("REQUEST_KEYFRAME").catch(() => undefined);
        }
        return false;
      }
      this.#behind = false;
    }
    this.#sent.set(id, now);
    this.#lastSent = id;
    if (this.#sent.size > 1024) this.#sent.delete(this.#sent.keys().next().value!);
    return true;
  }

  /** When the oldest frame the viewer has not acknowledged went to it, or null when it has shown them all. */
  #oldestUnacked(): number | null {
    for (const [id, at] of this.#sent) {
      if (this.#acked !== null && ahead(id, this.#acked) < 32768) {
        this.#sent.delete(id);
        continue;
      }
      return at;
    }
    return null;
  }

  /** Sends the box a video message for this viewer, after the ones it sent before the box's side opened. */
  async #toBox(message: string): Promise<void> {
    if (this.#early) this.#early.push(message);
    else await (await this.#socket).socket.send(message).catch(() => undefined);
  }

  /**
   * Stops this viewer's video, for a restart of the box's capture, when the
   * viewer wants video; false when it does not. Selkies stops a capture once
   * no page wants its video, and starts the next at the desktop's size.
   */
  pause(): boolean {
    if (this.#ended || !this.#wants) return false;
    void this.#toBox("STOP_VIDEO");
    return true;
  }

  /** Whether this viewer wants video now: not while its tab is hidden. */
  get wantsVideo(): boolean {
    return !this.#ended && this.#wants;
  }

  /** Sends the viewer a message of bb-box's own, such as the box's pointer (060), while it is connected. */
  tell(message: string): void {
    if (!this.#ended) this.#options.viewer.send(message);
  }

  /** Starts this viewer's video again after `pause`, from a key frame, unless it has since asked for none. */
  resume(): void {
    if (this.#ended || !this.#wants) return;
    void this.#toBox("START_VIDEO").then(() => this.#toBox("REQUEST_KEYFRAME"));
  }

  /** A message from the viewer. */
  async receive(message: Message): Promise<void> {
    if (this.#ended || typeof message !== "string") return;
    const colour = /^BB_FULLCOLOR,([01])$/.exec(message);
    if (colour) {
      this.#options.onFullColour?.(colour[1] === "1");
      return;
    }
    const decodes = /^BB_DECODES,(\d{1,7})$/.exec(message);
    if (decodes) {
      this.#options.onDecodes?.(Number(decodes[1]));
      return;
    }
    const resize = /^r,(\d{1,5})x(\d{1,5})$/.exec(message);
    if (resize) {
      if (this.#options.mayInput()) this.#options.onResize?.({ width: Number(resize[1]), height: Number(resize[2]) });
      return;
    }
    switch (classify(message)) {
      case "ack": {
        const id = Number(message.split(" ")[1]);
        if (Number.isInteger(id) && id >= 0 && id < 65536) this.#acked = id;
        return;
      }
      case "video":
        if (message === "STOP_VIDEO") this.#wants = false;
        if (message === "START_VIDEO") this.#wants = true;
        await this.#toBox(message);
        return;
      case "input": {
        if (!this.#options.mayInput()) return;
        this.#track(message);
        const pointer = verb(message) === "m" || verb(message) === "m2";
        if (pointer && this.#options.pointerApart?.()) {
          this.#pointerSent = true;
          await this.#toBox(unsequenced(message));
          return;
        }
        await this.#options.box.input(unsequenced(message));
        // QEMU's VNC server refreshes its picture every 30 ms while it changes, more slowly while it is still, up to every
        // 3 s, and at once again only when a client sends it input (ui/vnc.c, vnc_refresh and protocol_client_msg). A key
        // reaches the box by its stream server, not QEMU, so the pointer as it is, the same place and buttons, goes to the
        // video's source after it: QEMU's tablet is told nothing new, and its picture of the key comes at the next 30 ms.
        if ((verb(message) === "kd" || verb(message) === "ku") && this.#pointerSent && this.#options.pointerApart?.()) {
          await this.#toBox(`m,${this.#pointer.x},${this.#pointer.y},${this.#pointer.mask},0`);
        }
        return;
      }
      case "drop":
        return;
    }
  }

  /** What the viewer holds down, from its keys and pointer. */
  #track(text: string): void {
    const fields = text.split(",");
    if (fields[0] === "kd") this.#held.add(fields[1] ?? "");
    else if (fields[0] === "ku") this.#held.delete(fields[1] ?? "");
    else if (fields[0] === "kr") this.#held.clear();
    else if (fields[0] === "m") this.#pointer = { x: Number(fields[1]) || 0, y: Number(fields[2]) || 0, mask: Number(fields[3]) || 0 };
  }

  /** Releases the keys and buttons this viewer holds down in the box. */
  async release(): Promise<void> {
    const messages = [...this.#held].map((keysym) => `ku,${keysym}`);
    this.#held.clear();
    for (const message of messages) await this.#options.box.input(message);
    if (this.#pointer.mask !== 0) {
      const up = `m,${this.#pointer.x},${this.#pointer.y},0,0`;
      this.#pointer = { ...this.#pointer, mask: 0 };
      // Buttons let go where they were pressed: the video's source lets go of a client's own as it goes, too.
      if (this.#options.pointerApart?.()) await this.#toBox(up);
      else await this.#options.box.input(up);
    }
  }

  get holding(): boolean {
    return this.#held.size > 0 || this.#pointer.mask !== 0;
  }

  close(): Promise<void> {
    return this.#end("viewer", null);
  }

  async #end(by: "viewer" | "box", error: Error | null): Promise<void> {
    if (this.#ended) return;
    this.#ended = true;
    if (by === "viewer") await this.release().catch(() => undefined);
    await this.#socket.then(({ socket }) => socket.close()).catch(() => undefined);
    if (by === "box") this.#options.viewer.close(error ? 1011 : 1000, (error?.message ?? "The box's desktop closed the connection.").slice(0, 120));
    this.#options.onEnd?.(by, error);
  }
}
