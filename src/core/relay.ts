// The desktop relay: one per viewer connection. It answers the box's RFB
// security with the password from the box's backend, offers the viewer
// security type None, and then copies bytes both ways. The viewer's messages
// are parsed so input from a viewer without control never reaches the box
// (008, 011), and a resize below the display's smallest size is raised to it.
// A raised size asked for again goes with no screens, so that Xvnc refuses it
// and noVNC stops asking. Pixels pass through undecoded. A display whose
// stream server ignores a viewer's input, as macOS Screen Sharing does
// (#406), gives an input of its own, and the controlling viewer's keys,
// pointer and clipboard go there instead.

import { openRoute } from "../transports/route.ts";
import type { ByteChannel, Display, DisplayAuth, DisplayInput, DisplayOpened } from "../transports/types.ts";
import {
  ClientParser,
  DESKTOP_SIZE,
  EXTENDED_DESKTOP_SIZE,
  RfbError,
  SECURITY_OK,
  StreamReader,
  VERSION_3_8,
  VIEWER_SECURITY,
  boxHandshake,
  concat,
  keyEvent,
  parseVersion,
  pointerEvent,
  qemuKeyEvent,
  readServerInit,
  securityFailure,
  setDesktopSize,
  setEncodings,
  ShortKeyError,
  type ClientMessage,
  type Screen,
  type ServerInit,
} from "./rfb.ts";

/** How long opening the box's display and its handshake may take. */
const CONNECT_TIMEOUT_MS = 20_000;
/** How long a sign-in may hang before a display that can restart its server has it restarted, once, and is tried again (#411). */
export const STALL_MS = 4_000;
/** How long a display that can restart its server has to answer a viewer's first full FramebufferUpdateRequest with any bytes: a full request always gets a frame, on an idle desktop too. */
export const FRAME_WAIT_MS = 5_000;
/** How often a display that can say whether its server still has the desktop is asked, while a viewer is connected. */
export const ATTACHED_CHECK_MS = 30_000;
/** How long a restart of a server that lost the desktop may take. */
const SERVER_RESTART_MS = 20_000;
const SHORT_KEY_RETRIES = 5;
/** How long closing waits for the box to take the releases of held keys and buttons. */
const RELEASE_TIMEOUT_MS = 2_000;
const CLIENT_CUT_TEXT = 6;

/** Whether a message is a viewer's input, which a display's own input takes instead of the stream server. */
function isInput(message: ClientMessage): boolean {
  return message.type === "key" || message.type === "qemu-key" || message.type === "pointer" || (message.type === "other" && message.bytes[0] === CLIENT_CUT_TEXT);
}

/** The viewer's end of the relay: a WebSocket carrying RFB. */
export interface Viewer {
  send(bytes: Uint8Array): void;
  close(code: number, reason: string): void;
}

/** Opens a connection to the box's display, with the authentication it expects. */
export type OpenDisplay = (
  signal: AbortSignal,
) => Promise<{
  readonly channel: ByteChannel;
  readonly auth: DisplayAuth;
  readonly input?: DisplayOpened["input"];
  readonly inputTakes?: DisplayOpened["inputTakes"];
  readonly typesAsCharacter?: DisplayOpened["typesAsCharacter"];
  readonly keyDelayMs?: DisplayOpened["keyDelayMs"];
  readonly restart?: (signal: AbortSignal) => Promise<void>;
  readonly attached?: (signal: AbortSignal) => Promise<boolean>;
}>;

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface RelayOptions {
  readonly viewer: Viewer;
  readonly open: OpenDisplay;
  /** Whether input from this viewer reaches the box now. */
  mayInput(): boolean;
  /** The desktop's size when the viewer joined. */
  onServerInit?(size: Size): void;
  /** The smallest size the viewer may set the desktop to, if the display has one. */
  minSize?(): Size | null;
  /** A resize the relay passed to the box, raised to the smallest size. */
  onResize?(size: Size, screen: Screen | null): void;
  /** Called once when the relay ends: by the viewer, or by the box or an error. */
  onEnd?(by: "viewer" | "box", error: Error | null): void;
  /** The display's input could not be opened, or failed, so this viewer's input goes nowhere. */
  onInputError?(error: Error): void;
  /** Each key as it goes to the box, and by which way, for a viewer that asked for the key log (a diagnostic). */
  keyLog?(line: string): void;
  /** The box's clipboard text changed, as the display's own input reports it. */
  onClipboard?(text: string): void;
  /** The display's server had lost the desktop, as `why` says, and the relay restarted it and ends, so the viewer connects to the new one. */
  onServerRestart?(why: string, error: Error | null): void;
  readonly connectTimeoutMs?: number;
  readonly frameWaitMs?: number;
  readonly attachedCheckMs?: number;
}

interface BoxConnection {
  readonly channel: ByteChannel;
  readonly reader: StreamReader;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly input?: DisplayOpened["input"];
  readonly inputTakes?: DisplayOpened["inputTakes"];
  readonly typesAsCharacter?: DisplayOpened["typesAsCharacter"];
  readonly keyDelayMs?: DisplayOpened["keyDelayMs"];
  readonly restart?: (signal: AbortSignal) => Promise<void>;
  readonly attached?: (signal: AbortSignal) => Promise<boolean>;
}

/**
 * How long a key that goes to the display's input as its character waits after keys went to the server: they
 * reach the box a little later by the server than a character by the input. On a Tart Mac, a burst of keys with no
 * gap at all came out of order, and with 10 ms between keys in order (measured 19 October 2026).
 */
const CHARACTER_AFTER_KEYS_MS = 15;

/** RFB's buttons 4 to 7: the wheel's notches, up, down, left and right. */
const WHEEL = 0x78;

/**
 * Opens the box's display and does its security handshake. Closes the
 * channel if that fails. A display that can restart its server gets
 * STALL_MS for the sign-in; then its server is restarted, once, and the
 * sign-in tried again, all within `timeoutMs`.
 */
export async function connectBox(open: OpenDisplay, timeoutMs = CONNECT_TIMEOUT_MS, stallMs = STALL_MS): Promise<BoxConnection> {
  const signal = AbortSignal.timeout(timeoutMs);
  let restarted = false;
  let shortKeys = 0;
  for (;;) {
    const { channel, auth, input, inputTakes, typesAsCharacter, keyDelayMs, restart, attached } = await open(signal);
    const reader = new StreamReader(channel.readable);
    const writer = channel.writable.getWriter();
    let stall: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"stalled">((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new RfbError("The box's desktop did not finish its handshake in time.")), { once: true });
      if (restart && !restarted) stall = setTimeout(() => resolve("stalled"), stallMs);
    });
    const handshake = boxHandshake(reader, (bytes) => writer.write(bytes), auth).then(() => "done" as const);
    handshake.catch(() => undefined);
    try {
      if (signal.aborted) throw new RfbError("The box's desktop did not finish its handshake in time.");
      if ((await Promise.race([handshake, timedOut])) === "done") {
        return { channel, reader, writer, input, ...(inputTakes ? { inputTakes } : {}), ...(typesAsCharacter ? { typesAsCharacter } : {}), ...(keyDelayMs ? { keyDelayMs } : {}), ...(restart ? { restart } : {}), ...(attached ? { attached } : {}) };
      }
    } catch (error) {
      await channel.close().catch(() => undefined);
      const newKeyOnNewConnection = error instanceof ShortKeyError && ++shortKeys <= SHORT_KEY_RETRIES && !signal.aborted;
      if (newKeyOnNewConnection) continue;
      throw error;
    } finally {
      clearTimeout(stall);
      timedOut.catch(() => undefined);
    }
    await channel.close().catch(() => undefined);
    await restart!(signal);
    restarted = true;
  }
}

function withTimeout<T>(task: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([task, new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  })]).finally(() => clearTimeout(timer));
}

/** The viewer's SetDesktopSize for `size`, with its first screen's size too. */
function resized(bytes: Uint8Array, size: Size): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  view.setUint16(2, size.width);
  view.setUint16(4, size.height);
  if (view.getUint8(6) > 0) {
    view.setUint16(16, size.width);
    view.setUint16(18, size.height);
  }
  return copy;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A WebSocket close reason must fit in 123 bytes. */
function closeReason(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= 123) return text;
  return `${new TextDecoder().decode(bytes.subarray(0, 120)).replace(/�$/, "")}...`;
}

export class RfbRelay {
  readonly #options: RelayOptions;
  readonly #box: Promise<BoxConnection>;
  #phase: "version" | "security" | "init" | "messages" | "ended" = "version";
  #pending: Uint8Array = new Uint8Array(0);
  readonly #parser = new ClientParser();
  #connection: BoxConnection | null = null;
  /** Keys this viewer holds down in the box, and the message that releases each. */
  readonly #held = new Map<string, Uint8Array>();
  #pointer = { mask: 0, x: 0, y: 0 };
  /** The size this viewer's last resize was raised to, until it is asked for again. */
  #raised: Size | null = null;
  #ended = false;
  /** The desktop's size from ServerInit, which a display's own input scales positions from. */
  #size: Size = { width: 0, height: 0 };
  /** The display's own input, once this viewer's first input opens it (#406). */
  #input: Promise<DisplayInput | null> | null = null;
  #inputWanted = false;
  /** The wheel's buttons the display's input last had, where it takes only the wheel. */
  #wheel = 0;
  /** The keysyms of keys down as their character in the display's own input (typesAsCharacter). */
  readonly #typed = new Set<number>();
  /** When the viewer's input last went to the server, for a character to the display's input after it. */
  #wroteAt = 0;
  /** Until when a server that spaces its key events is typing the ones it has (keyDelayMs). */
  #keysUntil = 0;
  /** The keysym of each key down by QEMU's key event, by its scancode. */
  readonly #heldQemu = new Map<number, number>();
  /** The viewer's bytes so far, each taken once those before it are. */
  #received: Promise<void> = Promise.resolve();
  /** When the box's server last sent bytes. */
  #heardAt = 0;
  /** Whether the viewer's first full FramebufferUpdateRequest has been watched for an answer. */
  #askedFull = false;
  /** Timers watching the server: its first frame, and whether it still has the desktop. */
  readonly #watch = new Set<ReturnType<typeof setTimeout>>();
  /** Set once the relay found the server had lost the desktop. */
  #dying = false;

  constructor(options: RelayOptions) {
    this.#options = options;
    this.#box = connectBox(options.open, options.connectTimeoutMs);
    this.#box.catch(() => undefined);
    options.viewer.send(new TextEncoder().encode(VERSION_3_8));
  }

  /**
   * Bytes from the viewer. Resolves once the box has taken them, so the viewer's pace follows the box's. Each takes its
   * turn after those before it, which the caller need not wait for: a key that goes to the display's input, as a
   * character over Tart's VNC server, may wait for it, and the keys after it must not reach the box first.
   */
  receive(bytes: Uint8Array): Promise<void> {
    const mayInput = this.#options.mayInput();
    this.#received = this.#received.then(async () => {
      if (this.#phase === "ended") return;
      try {
        await this.#receive(bytes, mayInput);
      } catch (error) {
        await this.#end("box", error instanceof Error ? error : new Error(String(error)));
      }
    });
    return this.#received;
  }

  async #receive(bytes: Uint8Array, mayInput: boolean): Promise<void> {
    if (this.#phase === "messages") return this.#forward(this.#parser.push(bytes), mayInput);
    this.#pending = concat(this.#pending, bytes);
    if (this.#phase === "version") {
      if (this.#pending.byteLength < 12) return;
      const version = parseVersion(this.#pending.subarray(0, 12));
      this.#pending = this.#pending.subarray(12);
      if (version !== 8) throw new RfbError("The viewer must speak RFB 3.8.");
      this.#options.viewer.send(VIEWER_SECURITY);
      this.#phase = "security";
    }
    if (this.#phase === "security") {
      if (this.#pending.byteLength < 1) return;
      const chosen = this.#pending[0];
      this.#pending = this.#pending.subarray(1);
      if (chosen !== VIEWER_SECURITY[1]) throw new RfbError("The viewer chose a security type the relay did not offer.");
      try {
        this.#connection = await this.#box;
      } catch (error) {
        this.#options.viewer.send(securityFailure(reason(error)));
        await this.#end("box", error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (this.#ended) return;
      this.#options.viewer.send(SECURITY_OK);
      this.#phase = "init";
    }
    if (this.#phase === "init") {
      if (this.#pending.byteLength < 1) return;
      this.#pending = this.#pending.subarray(1);
      const connection = this.#connection!;
      // Always shared: a viewer asking for the desktop alone would disconnect the others.
      await connection.writer.write(Uint8Array.of(1));
      const init: ServerInit = await readServerInit(connection.reader);
      if (this.#ended) return;
      this.#options.viewer.send(init.bytes);
      this.#size = { width: init.width, height: init.height };
      this.#options.onServerInit?.({ width: init.width, height: init.height });
      this.#phase = "messages";
      this.#heardAt = Date.now();
      if (this.#inputWanted) this.#openInputAhead(connection);
      void this.#pump(connection);
      this.#watchAttached(connection);
      const rest = this.#pending;
      this.#pending = new Uint8Array(0);
      if (rest.byteLength) await this.#forward(this.#parser.push(rest), this.#options.mayInput());
    }
  }

  async #pump(connection: BoxConnection): Promise<void> {
    try {
      for (;;) {
        const chunk = await connection.reader.next();
        if (chunk === null) break;
        if (this.#ended) return;
        this.#heardAt = Date.now();
        this.#options.viewer.send(chunk);
      }
      await this.#end("box", null);
    } catch (error) {
      await this.#end("box", error instanceof Error ? error : new Error(String(error)));
    }
  }

  async #forward(messages: ClientMessage[], mayInput: boolean): Promise<void> {
    const connection = this.#connection;
    if (!connection || this.#ended) return;
    // One write, awaited: a write left unawaited to a box that has gone
    // rejects with nobody to catch it, which ends the plugin's process.
    const passing: Uint8Array[] = [];
    for (const message of messages) {
      // A full FramebufferUpdateRequest always gets a frame: a server that sends nothing has lost the desktop (wayvnc 0.7.2).
      if (!this.#askedFull && connection.restart && message.type === "other" && message.bytes[0] === 3 && message.bytes[1] === 0) {
        this.#askedFull = true;
        const asked = Date.now();
        this.#after(this.#options.frameWaitMs ?? FRAME_WAIT_MS, () => {
          if (this.#heardAt < asked) void this.#serverLost(connection, "sent no picture for a full update");
        });
      }
      const bytes = this.#passing(message, mayInput);
      const key = message.type === "key" || message.type === "qemu-key" ? message : null;
      const logKey = (way: string) => key && this.#options.keyLog?.(`${way}: ${key.down ? "down" : "up"} 0x${key.keysym.toString(16)}${key.type === "qemu-key" ? ` scancode ${key.keycode}` : ""}, held [${[...this.#heldKeysyms()].map((held) => `0x${held.toString(16)}`).join(" ")}], at ${Date.now() % 100_000} ms`);
      if (!bytes) {
        logKey("dropped, as the viewer has no control");
        continue;
      }
      if (connection.input && isInput(message) && (connection.inputTakes === "wheel" || connection.inputTakes === "characters")) {
        // A character the stream server would type wrong or not at all goes
        // to the display's input as itself, down and up.
        const key = message.type === "key" || message.type === "qemu-key";
        const scancode = message.type === "qemu-key" ? message.keycode : undefined;
        if (key && (message.down ? connection.typesAsCharacter?.(message.keysym, this.#heldKeysyms(), scancode) : this.#typed.has(message.keysym))) {
          this.#held.delete(message.type === "key" ? `k${message.keysym}` : `q${message.keycode}`);
          this.#heldQemu.delete(scancode ?? -1);
          if (message.down) this.#typed.add(message.keysym);
          else this.#typed.delete(message.keysym);
          // Keys before it reach the server first, and the helper posts it before the keys after it go.
          if (passing.length) await this.#write(connection, passing.splice(0));
          // The server's path into the box is a little slower than the input's, and a server that spaces its key
          // events has a queue of them: keys it took land first.
          const wait = Math.max(this.#wroteAt + CHARACTER_AFTER_KEYS_MS, this.#keysUntil + CHARACTER_AFTER_KEYS_MS) - Date.now();
          if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
          const input = await this.#opened(connection);
          logKey(`to the input as a character, after ${Math.max(0, wait)} ms`);
          if (input && !this.#ended) await input.character?.(message.down, message.keysym);
          continue;
        }
        // The stream server takes all but the wheel; the display's input
        // takes the wheel's buttons, down and up, as a notch is each one going down.
        if (connection.inputTakes === "characters" || message.type !== "pointer" || (message.mask & WHEEL) === this.#wheel) {
          logKey("to the server");
          passing.push(bytes);
          continue;
        }
        this.#wheel = message.mask & WHEEL;
        passing.push(pointerEvent(message.mask & ~WHEEL, message.x, message.y));
        await this.#toInput(connection, { ...message, mask: this.#wheel });
      } else if (connection.input && isInput(message)) {
        logKey("to the input");
        await this.#toInput(connection, message);
      } else {
        logKey("to the server");
        passing.push(bytes);
      }
    }
    if (passing.length) await this.#write(connection, passing);
  }

  /** Writes what passes to the server, noting when, and until when a server that spaces its key events types them. */
  async #write(connection: BoxConnection, passing: Uint8Array[]): Promise<void> {
    await connection.writer.write(passing.reduce(concat));
    const now = Date.now();
    this.#wroteAt = now;
    if (!connection.keyDelayMs) return;
    const keys = passing.reduce((count, bytes) => count + new ClientParser().push(bytes).filter((message) => message.type === "key" || message.type === "qemu-key").length, 0);
    if (keys) this.#keysUntil = Math.max(now, this.#keysUntil) + keys * connection.keyDelayMs;
  }

  /** The keysyms of the keys this viewer holds down in the box. */
  #heldKeysyms(): ReadonlySet<number> {
    const keysyms = new Set<number>(this.#heldQemu.values());
    for (const key of this.#held.keys()) if (key.startsWith("k")) keysyms.add(Number(key.slice(1)));
    return keysyms;
  }

  prepareInput(): void {
    this.#inputWanted = true;
    const connection = this.#connection;
    if (connection && this.#phase === "messages") this.#openInputAhead(connection);
  }

  #openInputAhead(connection: BoxConnection): void {
    if (!connection.input || connection.inputTakes === "characters" || this.#ended) return;
    void this.#opened(connection);
  }

  /** The display's own input, opened at this viewer's first input; null when it cannot be opened. */
  #opened(connection: BoxConnection): Promise<DisplayInput | null> {
    this.#input ??= connection.input!({ onClipboard: (text) => this.#options.onClipboard?.(text) })
      .then(async (input) => {
        await input.size(this.#size.width, this.#size.height);
        return input;
      })
      .catch((error: unknown) => {
        this.#options.onInputError?.(error instanceof Error ? error : new Error(String(error)));
        return null;
      });
    return this.#input;
  }

  /** Sends an input message, which passed the control check, to the display's own input. */
  async #toInput(connection: BoxConnection, message: ClientMessage): Promise<void> {
    const input = await this.#opened(connection);
    if (!input || this.#ended) return;
    switch (message.type) {
      case "key":
      case "qemu-key":
        await input.key(message.down, message.keysym);
        break;
      case "pointer":
        await input.pointer(message.mask, message.x, message.y);
        break;
      case "other": {
        // ClientCutText's Latin-1 text. The extended clipboard, with a negative length, is not taken.
        if (message.bytes[0] !== CLIENT_CUT_TEXT) break;
        const length = new DataView(message.bytes.buffer, message.bytes.byteOffset).getInt32(4);
        if (length >= 0) await input.clipboard(new TextDecoder("latin1").decode(message.bytes.subarray(8, 8 + length)));
        break;
      }
    }
  }

  /** What of a message goes to the box, if any, tracking what the viewer holds down. */
  #passing(message: ClientMessage, mayInput: boolean): Uint8Array | null {
    if (message.type === "other" && message.class === "pass") return message.bytes;
    if (!mayInput) return null;
    switch (message.type) {
      case "key":
        if (message.down) this.#held.set(`k${message.keysym}`, keyEvent(false, message.keysym));
        else this.#held.delete(`k${message.keysym}`);
        break;
      case "qemu-key":
        if (message.down) {
          this.#held.set(`q${message.keycode}`, qemuKeyEvent(false, message.keysym, message.keycode));
          this.#heldQemu.set(message.keycode, message.keysym);
        } else {
          this.#held.delete(`q${message.keycode}`);
          this.#heldQemu.delete(message.keycode);
        }
        break;
      case "pointer":
        this.#pointer = { mask: message.mask, x: message.x, y: message.y };
        break;
      case "resize": {
        const min = this.#options.minSize?.();
        const size = { width: Math.max(message.width, min?.width ?? 0), height: Math.max(message.height, min?.height ?? 0) };
        this.#options.onResize?.(size, message.screen);
        if (size.width === message.width && size.height === message.height) {
          this.#raised = null;
          break;
        }
        // Xvnc sets the raised size and says so, and noVNC asks again while
        // that differs from its pane. So asked for again, the size goes with
        // no screens: Xvnc refuses that layout and noVNC stops asking. QEMU
        // reads only the size, so it takes it as before.
        const again = this.#raised?.width === size.width && this.#raised.height === size.height;
        this.#raised = again ? null : size;
        return again ? setDesktopSize(size.width, size.height, null) : resized(message.bytes, size);
      }
    }
    return message.bytes;
  }

  /** Releases the keys and buttons this viewer holds down in the box. */
  async release(): Promise<void> {
    const connection = this.#connection;
    if (!connection || this.#phase !== "messages") return;
    const messages = [...this.#held.values()];
    this.#held.clear();
    this.#heldQemu.clear();
    const typed = [...this.#typed];
    this.#typed.clear();
    if (typed.length) {
      const input = await (this.#input ?? Promise.resolve(null));
      for (const keysym of typed) await input?.character?.(false, keysym);
    }
    if (this.#pointer.mask !== 0) {
      messages.push(pointerEvent(0, this.#pointer.x, this.#pointer.y));
      this.#pointer = { ...this.#pointer, mask: 0 };
    }
    if (!messages.length) return;
    if (!connection.input || connection.inputTakes === "wheel" || connection.inputTakes === "characters") {
      await connection.writer.write(messages.reduce(concat));
      return;
    }
    const input = await (this.#input ?? Promise.resolve(null));
    for (const message of new ClientParser().push(messages.reduce(concat))) {
      if (input && message.type === "pointer") await input.pointer(message.mask, message.x, message.y);
      else if (input && (message.type === "key" || message.type === "qemu-key")) await input.key(message.down, message.keysym);
    }
  }

  /** Whether this viewer holds any key or button down in the box. */
  get holding(): boolean {
    return this.#held.size > 0 || this.#pointer.mask !== 0;
  }

  /** The viewer went away. */
  close(): Promise<void> {
    return this.#end("viewer", null);
  }

  /** Runs `task` after `ms`, unless the relay ends first. */
  #after(ms: number, task: () => void): void {
    const timer = setTimeout(() => {
      this.#watch.delete(timer);
      if (!this.#ended) task();
    }, ms);
    this.#watch.add(timer);
  }

  /** Asks, at once and then every ATTACHED_CHECK_MS, whether the display's server still has the desktop (wayvnc 0.9.1). */
  #watchAttached(connection: BoxConnection): void {
    if (!connection.restart || !connection.attached) return;
    const check = async () => {
      const has = await connection.attached!(AbortSignal.timeout(SERVER_RESTART_MS)).catch(() => true);
      if (this.#ended) return;
      if (!has) return this.#serverLost(connection, "lost the desktop");
      this.#after(this.#options.attachedCheckMs ?? ATTACHED_CHECK_MS, () => void check());
    };
    void check();
  }

  /** Restarts a server that lost the desktop, and ends the relay, so the viewer connects to the new one. */
  async #serverLost(connection: BoxConnection, why: string): Promise<void> {
    if (this.#dying || this.#ended) return;
    this.#dying = true;
    let failed: Error | null = null;
    try {
      await connection.restart!(AbortSignal.timeout(SERVER_RESTART_MS));
    } catch (error) {
      failed = error instanceof Error ? error : new Error(String(error));
    }
    this.#options.onServerRestart?.(why, failed);
    const words = failed ? `bb-box could not restart it: ${failed.message}` : "bb-box restarted it, and the viewer connects again";
    await this.#end("box", new Error(`The desktop's VNC server ${why}, so ${words}.`));
  }

  async #end(by: "viewer" | "box", error: Error | null): Promise<void> {
    if (this.#ended) return;
    this.#ended = true;
    for (const timer of this.#watch) clearTimeout(timer);
    this.#watch.clear();
    const connection = this.#connection;
    if (connection) {
      if (by === "viewer") await withTimeout(this.release().catch(() => undefined), RELEASE_TIMEOUT_MS);
      this.#phase = "ended";
      connection.reader.cancel();
      await connection.channel.close().catch(() => undefined);
      await this.#input?.then((input) => input?.close()).catch(() => undefined);
    } else {
      this.#phase = "ended";
      // Still connecting: close the box's side whenever it opens.
      void this.#box.then(
        (opened) => {
          opened.reader.cancel();
          return opened.channel.close();
        },
        () => undefined,
      );
    }
    if (by === "box") {
      this.#options.viewer.close(error ? 1011 : 1000, closeReason(error ? error.message : "The box's desktop closed the connection."));
    }
    this.#options.onEnd?.(by, error);
  }
}

/** Opens a box's display through its route. */
export function displayOpener(display: Display): OpenDisplay {
  return async (signal) => {
    const { route, auth, input, inputTakes, typesAsCharacter, keyDelayMs } = await display.open(signal);
    return { channel: await openRoute(route, signal), auth, input, ...(inputTakes ? { inputTakes } : {}), ...(typesAsCharacter ? { typesAsCharacter } : {}), ...(keyDelayMs ? { keyDelayMs } : {}), ...(display.restartServer ? { restart: (each: AbortSignal) => display.restartServer!(each) } : {}), ...(display.restartServer && display.serverAttached ? { attached: (each: AbortSignal) => display.serverAttached!(each) } : {}) };
  };
}

/** Joins the desktop as a shared client of the relay's own, then closes. */
async function joined<T>(open: OpenDisplay, use: (connection: BoxConnection, init: ServerInit) => Promise<T>): Promise<T> {
  const connection = await connectBox(open);
  try {
    await connection.writer.write(Uint8Array.of(1));
    const init = await withTimeout(readServerInit(connection.reader), CONNECT_TIMEOUT_MS);
    if (!init) throw new RfbError("The box's desktop did not describe itself in time.");
    return await use(connection, init);
  } finally {
    connection.reader.cancel();
    await connection.channel.close().catch(() => undefined);
  }
}

/** The desktop's size, from a connection that answers its security as a viewer's would. */
export function desktopSize(open: OpenDisplay): Promise<Size> {
  return joined(open, async (_connection, init) => ({ width: init.width, height: init.height }));
}

/**
 * Sets the desktop to `size` over a connection of the relay's own, when a
 * viewer resized it and has gone. Resolves false when it already has that
 * size.
 */
export function restoreSize(open: OpenDisplay, size: Size, screen: Screen): Promise<boolean> {
  return joined(open, async (connection, init) => {
    if (init.width === size.width && init.height === size.height) return false;
    // TigerVNC answers SetDesktopSize only to a client that understands the
    // answer. DesktopSize too: the Virtualization framework's server ends the
    // VM on an update request from a client without it.
    await connection.writer.write(concat(setEncodings([EXTENDED_DESKTOP_SIZE, DESKTOP_SIZE]), setDesktopSize(size.width, size.height, screen)));
    await connection.writer.write(Uint8Array.of(3, 1, 0, 0, 0, 0, 0, 1, 0, 1));
    await withTimeout(connection.reader.next(), RELEASE_TIMEOUT_MS);
    return true;
  });
}
