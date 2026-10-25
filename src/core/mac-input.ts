// A macOS desktop's input from a person's viewer (#406). macOS 27's Screen
// Sharing shows the console to a viewer that is not Apple's, but ignores its
// keys and pointer. So the relay sends the controlling viewer's input to a
// helper in the box user's desktop session instead: a JXA script that posts
// each event at the HID tap with CGEventPost, as a keyboard and mouse would.
// Tart's macOS images let osascript post events (kTCCServicePostEvent), so
// it needs no grant of ours.
//
// The relay writes one event per line to the helper's stdin, and the helper
// answers on stdout:
//
//   s <width> <height>      the framebuffer's size in pixels; the helper
//                           scales pointer positions to the screen's points
//   k <0|1> <key code>      a key up or down, as a macOS virtual key code
//   u <0|1> <code point>    a character's key up or down, as the character
//                           itself, whatever the keyboard's layout;
//                           answered with "u" once posted
//   p <mask> <x> <y>        the pointer, as RFB's PointerEvent has it:
//                           buttons 1 to 3, and 4 to 7 as wheel notches
//   c <base64>              the viewer's clipboard text, for the pasteboard
//   q                       report the pasteboard if it changed in the box
//   t <id>                  answered with "t <id>" once the lines before it
//                           are posted, to time the path
//
//   ready                   the helper reads events
//   C <base64>              the box's pasteboard text, which changed
//   e <message>             an event the helper could not post
//
// Keys go by position on a US keyboard: the relay maps each X keysym to the
// key that types it there, and the box's own layout then decides what it
// types. A character with no key on a US keyboard, such as é, or whose key
// needs a Shift the viewer does not hold, as ! from a French keyboard, goes
// as the character itself (macCharacter).

import { pause } from "../transports/ready.ts";
import type { ByteChannel, CommandTransport, DisplayInput, DisplayInputEvents } from "../transports/types.ts";
import { command as inBoxCommand } from "./in-box.ts";

/** How long the helper may take to say it reads events. */
const INPUT_START_MS = 15_000;

/**
 * Starts the input helper in the box user's desktop session over `command`,
 * for one viewer, and waits until it reads events. `failed` says why there is
 * none, for an error.
 */
export async function startMacInput(command: CommandTransport, events: DisplayInputEvents, failed: string, signal?: AbortSignal): Promise<DisplayInput> {
  const why = (error: unknown) => `${failed} ${error instanceof Error ? error.message : String(error)}`;
  if (!command.spawn) throw new Error(`${failed} Its commands cannot keep a helper running.`);
  const channel = await command.spawn(inBoxCommand("macos", macInputCommand(), { session: "desktop" }), signal).catch((error: unknown) => {
    throw new Error(why(error));
  });
  const input = new MacInput(channel, events);
  let ended = failed;
  const started = await Promise.race([
    input.ready.then(() => true),
    input.ended.then(
      () => false,
      (error: unknown) => ((ended = why(error)), false),
    ),
    pause(INPUT_START_MS, signal).then(() => false),
  ]);
  if (!started) {
    await input.close().catch(() => undefined);
    throw new Error(ended);
  }
  return input;
}

/** The longest a character waits for the helper to say it posted it. */
const CHARACTER_WAIT_MS = 1_000;
/** How often the helper looks at the box's pasteboard, while a viewer has it. */
const CLIPBOARD_POLL_MS = 1_000;
/** How long closing waits for the helper to post what it was sent: events still queued in it are lost when it exits. */
const CLOSE_GRACE_MS = 200;

/** The helper's script, for `osascript -l JavaScript`. It has no single quotes, so it can be quoted for sh as it is. */
export const MAC_INPUT_SCRIPT = String.raw`ObjC.import("AppKit");
ObjC.import("CoreGraphics");
function run() {
  var out = $.NSFileHandle.fileHandleWithStandardOutput;
  var input = $.NSFileHandle.fileHandleWithStandardInput;
  function say(line) { out.writeData($(line + "\n").dataUsingEncoding($.NSUTF8StringEncoding)); }
  var points = $.NSScreen.mainScreen.frame.size.width;
  var scale = 1;
  var MODIFIERS = { 56: 0x20000, 60: 0x20000, 59: 0x40000, 62: 0x40000, 58: 0x80000, 61: 0x80000, 55: 0x100000, 54: 0x100000 };
  var held = {};
  function flags() { var f = 0; for (var code in held) f |= MODIFIERS[code]; return f; }
  function post(event) { $.CGEventSetFlags(event, flags()); $.CGEventPost($.kCGHIDEventTap, event); }
  // Left, right and middle: the RFB mask bit, the CoreGraphics button, and the down, up and dragged event types.
  var BUTTONS = [[1, 0, 1, 2, 6], [4, 1, 3, 4, 7], [2, 2, 25, 26, 27]];
  var mask = 0, x = 0, y = 0, clicks = { at: 0, x: 0, y: 0, button: -1, count: 0 };
  function pointer(next, px, py) {
    var at = $.CGPointMake(px / scale, py / scale);
    if (px !== x || py !== y) {
      var dragging = BUTTONS.filter(function (b) { return mask & b[0]; })[0];
      post($.CGEventCreateMouseEvent($(), dragging ? dragging[4] : 5, at, dragging ? dragging[1] : 0));
      x = px; y = py;
    }
    BUTTONS.forEach(function (b) {
      if ((next & b[0]) === (mask & b[0])) return;
      var down = (next & b[0]) !== 0;
      if (down) {
        var now = Date.now();
        var again = clicks.button === b[1] && now - clicks.at < 500 && Math.abs(px - clicks.x) < 8 && Math.abs(py - clicks.y) < 8;
        clicks = { at: now, x: px, y: py, button: b[1], count: again ? clicks.count + 1 : 1 };
      }
      var event = $.CGEventCreateMouseEvent($(), down ? b[2] : b[3], at, b[1]);
      $.CGEventSetIntegerValueField(event, 1, clicks.button === b[1] ? clicks.count : 1);
      post(event);
    });
    // Buttons 4 to 7 are one wheel notch each as they go down: up, down, left, right.
    [[8, 3, 0], [16, -3, 0], [32, 0, 3], [64, 0, -3]].forEach(function (w) {
      if ((next & w[0]) && !(mask & w[0])) post($.CGEventCreateScrollWheelEvent2($(), 1, 2, w[1], w[2], 0));
    });
    mask = next;
  }
  var pasteboard = $.NSPasteboard.generalPasteboard;
  var seen = pasteboard.changeCount;
  function handle(line) {
    var f = line.split(" ");
    if (f[0] === "k") {
      var code = Number(f[2]), down = f[1] === "1";
      if (code in MODIFIERS) { if (down) held[code] = 1; else delete held[code]; }
      post($.CGEventCreateKeyboardEvent($(), code, down));
    } else if (f[0] === "u") {
      // The character as the text the key types, in UTF-16 code units, with no modifier: Shift or Option already made it.
      var text = $.NSString.stringWithString(String.fromCodePoint(Number(f[2])));
      var units = Ref("unsigned short", text.length);
      for (var i = 0; i < text.length; i++) units[i] = text.characterAtIndex(i);
      var event = $.CGEventCreateKeyboardEvent($(), 0, f[1] === "1");
      $.CGEventKeyboardSetUnicodeString(event, text.length, units);
      $.CGEventSetFlags(event, 0);
      $.CGEventPost($.kCGHIDEventTap, event);
      say("u");
    } else if (f[0] === "p") pointer(Number(f[1]), Number(f[2]), Number(f[3]));
    else if (f[0] === "s") scale = Number(f[1]) / points || 1;
    else if (f[0] === "c") {
      var text = $.NSString.alloc.initWithDataEncoding($.NSData.alloc.initWithBase64EncodedStringOptions($(f[1] || ""), 0), $.NSUTF8StringEncoding);
      pasteboard.clearContents;
      pasteboard.setStringForType(text, $.NSPasteboardTypeString);
      seen = pasteboard.changeCount;
    } else if (f[0] === "q") {
      if (pasteboard.changeCount === seen) return;
      seen = pasteboard.changeCount;
      var string = pasteboard.stringForType($.NSPasteboardTypeString);
      if (string.isNil()) return;
      say("C " + string.dataUsingEncoding($.NSUTF8StringEncoding).base64EncodedStringWithOptions(0).js);
    } else if (f[0] === "t") say("t " + f[1]);
  }
  say("ready");
  var rest = "";
  for (;;) {
    var data = input.availableData;
    if (Number(data.length) === 0) break;
    rest += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
    var lines = rest.split("\n");
    rest = lines.pop();
    lines.forEach(function (line) {
      try { handle(line); } catch (error) { say("e " + String(error).replace(/\n/g, " ")); }
    });
  }
}`;

/** Runs the helper as the box user in its desktop session, as `command()` puts a desktop command there. */
export function macInputCommand(): string {
  return `exec /usr/bin/osascript -l JavaScript -e '${MAC_INPUT_SCRIPT}'`;
}

/** X keysyms of keys that type no character, by the macOS virtual key code of the same key. */
const SPECIAL: Readonly<Record<number, number>> = {
  0xff08: 51, // BackSpace
  0xff09: 48, // Tab
  0xff0d: 36, // Return
  0xff1b: 53, // Escape
  0xffff: 117, // Delete (forward)
  0xff50: 115, // Home
  0xff51: 123, // Left
  0xff52: 126, // Up
  0xff53: 124, // Right
  0xff54: 125, // Down
  0xff55: 116, // Prior (Page Up)
  0xff56: 121, // Next (Page Down)
  0xff57: 119, // End
  0xff8d: 76, // KP_Enter
  0xffe1: 56, // Shift_L
  0xffe2: 60, // Shift_R
  0xffe3: 59, // Control_L
  0xffe4: 62, // Control_R
  0xffe5: 57, // Caps_Lock
  0xffe7: 55, // Meta_L: Command, as noVNC sends the Command key on a Mac
  0xffe8: 54, // Meta_R
  0xffe9: 58, // Alt_L: Option
  0xffea: 61, // Alt_R
  0xffeb: 55, // Super_L: Command, as the Windows key or Command
  0xffec: 54, // Super_R
};
/** F1 to F12. */
const FUNCTION_KEYS = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111];
/** Each character a US keyboard types, plain and with Shift, by its key's code. */
const US_KEYS: ReadonlyArray<readonly [number, string]> = [
  [0, "aA"], [1, "sS"], [2, "dD"], [3, "fF"], [4, "hH"], [5, "gG"], [6, "zZ"], [7, "xX"], [8, "cC"], [9, "vV"],
  [11, "bB"], [12, "qQ"], [13, "wW"], [14, "eE"], [15, "rR"], [16, "yY"], [17, "tT"], [18, "1!"], [19, "2@"],
  [20, "3#"], [21, "4$"], [22, "6^"], [23, "5%"], [24, "=+"], [25, "9("], [26, "7&"], [27, "-_"], [28, "8*"],
  [29, "0)"], [30, "]}"], [31, "oO"], [32, "uU"], [33, "[{"], [34, "iI"], [35, "pP"], [37, "lL"], [38, "jJ"],
  [39, "'\""], [40, "kK"], [41, ";:"], [42, "\\|"], [43, ",<"], [44, "/?"], [45, "nN"], [46, "mM"], [47, ".>"],
  [49, "  "], [50, "`~"],
];
const PRINTABLE = new Map<number, number>(US_KEYS.flatMap(([code, chars]) => [...chars].map((char) => [char.codePointAt(0)!, code] as const)));
/** The characters a US keyboard types with Shift. */
const SHIFTED = new Set(US_KEYS.filter(([code]) => code !== 49).map(([, chars]) => chars.codePointAt(1)!));

/**
 * The character a key types as itself, not as a key on a US keyboard, or
 * null to send it as the key: one the keyboard has no key for, such as é, or
 * whose key needs Shift when the viewer holds none, or none when it holds
 * Shift, as from a French keyboard, where ! needs no Shift and 1 does. Never
 * while Command or Control is held, so a shortcut stays keys, nor for Space.
 */
export function macCharacter(keysym: number, shift: boolean, shortcut: boolean): number | null {
  // Latin-1 keysyms are their code points; Unicode keysyms carry one above 0x1000000.
  const codePoint = keysym >= 0x1000000 ? keysym - 0x1000000 : keysym > 0x20 && keysym <= 0xff ? keysym : null;
  if (codePoint === null || codePoint <= 0x20 || codePoint > 0x10ffff || shortcut) return null;
  if (!PRINTABLE.has(codePoint)) return codePoint;
  return SHIFTED.has(codePoint) === shift ? null : codePoint;
}

const SHIFT_KEYS = [0xffe1, 0xffe2];
/** Control, and Command as Screen Sharing and this helper name it: Meta or Super. */
const SHORTCUT_KEYS = [0xffe3, 0xffe4, 0xffe7, 0xffe8, 0xffeb, 0xffec];
/** Control, and Command as Tart's VNC server names it: Alt. */
const TART_SHORTCUT_KEYS = [0xffe3, 0xffe4, 0xffe9, 0xffea];

/**
 * Whether a key goes to the input helper as its character rather than to
 * Tart's VNC server, which types by key on a US keyboard and drops what it
 * has none for. `held` is the keysyms the viewer holds down.
 */
export function tartTypesAsCharacter(keysym: number, held: ReadonlySet<number>): boolean {
  const holds = (keys: readonly number[]) => keys.some((key) => held.has(key));
  return macCharacter(keysym, holds(SHIFT_KEYS), holds(TART_SHORTCUT_KEYS)) !== null;
}

/**
 * The macOS virtual key code of the key that types an X keysym on a US
 * keyboard, or null for a key it does not have. Shifted characters map to
 * their key: the viewer sends Shift itself.
 */
export function macKeyCode(keysym: number): number | null {
  if (keysym >= 0xffbe && keysym <= 0xffc9) return FUNCTION_KEYS[keysym - 0xffbe]!;
  if (keysym in SPECIAL) return SPECIAL[keysym]!;
  // Latin-1 keysyms are their code points; Unicode keysyms carry one above 0x1000000.
  const codePoint = keysym >= 0x1000000 ? keysym - 0x1000000 : keysym <= 0xff ? keysym : null;
  return codePoint === null ? null : (PRINTABLE.get(codePoint) ?? null);
}

/** The helper's events, written in order as lines. */
export class MacInput implements DisplayInput {
  readonly #channel: ByteChannel;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #encoder = new TextEncoder();
  readonly #pings = new Map<number, () => void>();
  /** The keysyms of keys held down, as keys. */
  readonly #held = new Set<number>();
  /** The keysyms of keys down as their character, which go up so too. */
  readonly #typed = new Set<number>();
  /** Who waits for each character the helper has yet to say it posted, in order. */
  readonly #posted: (() => void)[] = [];
  #ping = 0;
  #queue: Promise<void> = Promise.resolve();
  readonly #poll: ReturnType<typeof setInterval> | null = null;
  readonly ready: Promise<void>;
  readonly ended: Promise<void>;

  /** `onClipboard` gets the box's pasteboard text when it changes there; `onError` an event the helper could not post. */
  constructor(channel: ByteChannel, events: DisplayInputEvents & { onError?(message: string): void } = {}) {
    this.#channel = channel;
    this.#writer = channel.writable.getWriter();
    let ready!: () => void;
    this.ready = new Promise((resolve) => (ready = resolve));
    this.ended = this.#read(channel.readable, ready, events);
    this.ended.catch(() => undefined);
    if (events.onClipboard) {
      this.#poll = setInterval(() => void this.poll().catch(() => undefined), CLIPBOARD_POLL_MS);
      this.#poll.unref?.();
    }
  }

  async #read(readable: ReadableStream<Uint8Array>, ready: () => void, events: DisplayInputEvents & { onError?(message: string): void }): Promise<void> {
    const decoder = new TextDecoder();
    let rest = "";
    const reader = readable.getReader();
    for (;;) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      rest += decoder.decode(chunk, { stream: true });
      const lines = rest.split("\n");
      rest = lines.pop()!;
      for (const line of lines) {
        const space = line.indexOf(" ");
        const kind = space < 0 ? line : line.slice(0, space);
        const value = space < 0 ? "" : line.slice(space + 1);
        if (line === "ready") ready();
        else if (line === "u") this.#posted.shift()?.();
        else if (kind === "C") events.onClipboard?.(Buffer.from(value, "base64").toString("utf8"));
        else if (kind === "t") this.#pings.get(Number(value))?.();
        else if (kind === "e") events.onError?.(value);
      }
    }
  }

  #send(line: string): Promise<void> {
    const bytes = this.#encoder.encode(`${line}\n`);
    this.#queue = this.#queue.then(() => this.#writer.write(bytes));
    return this.#queue;
  }

  size(width: number, height: number): Promise<void> {
    return this.#send(`s ${width} ${height}`);
  }

  /**
   * A key by its X keysym: as the key that types it on a US keyboard, or as
   * its character (macCharacter). False when it is neither.
   */
  async key(down: boolean, keysym: number): Promise<boolean> {
    const holds = (keys: readonly number[]) => keys.some((key) => this.#held.has(key));
    if (down ? macCharacter(keysym, holds(SHIFT_KEYS), holds(SHORTCUT_KEYS)) !== null : this.#typed.has(keysym)) {
      await this.character(down, keysym);
      return true;
    }
    const code = macKeyCode(keysym);
    if (code === null) return false;
    if (down) this.#held.add(keysym);
    else this.#held.delete(keysym);
    await this.#send(`k ${down ? 1 : 0} ${code}`);
    return true;
  }

  /**
   * A key as its character, whatever key would type it. Resolves once the
   * helper has posted it, so a key that goes to another server after it,
   * as over Tart's VNC server, cannot reach the Mac first; or after
   * CHARACTER_WAIT_MS, should the helper not say.
   */
  async character(down: boolean, keysym: number): Promise<void> {
    const codePoint = keysym >= 0x1000000 ? keysym - 0x1000000 : keysym;
    if (down) this.#typed.add(keysym);
    else this.#typed.delete(keysym);
    let wait: ReturnType<typeof setTimeout> | undefined;
    const posted = new Promise<void>((resolve) => {
      const said = () => {
        clearTimeout(wait);
        resolve();
      };
      this.#posted.push(said);
      wait = setTimeout(() => {
        this.#posted.splice(this.#posted.indexOf(said), 1);
        resolve();
      }, CHARACTER_WAIT_MS);
    });
    await this.#send(`u ${down ? 1 : 0} ${codePoint}`);
    await posted;
  }

  pointer(mask: number, x: number, y: number): Promise<void> {
    return this.#send(`p ${mask} ${x} ${y}`);
  }

  clipboard(text: string): Promise<void> {
    return this.#send(`c ${Buffer.from(text, "utf8").toString("base64")}`);
  }

  /** Asks the helper to report the box's pasteboard if it changed. */
  poll(): Promise<void> {
    return this.#send("q");
  }

  /** Resolves once the helper has posted every event sent before it. */
  async ping(): Promise<void> {
    const id = ++this.#ping;
    const answered = new Promise<void>((resolve) => this.#pings.set(id, resolve));
    await this.#send(`t ${id}`);
    await answered;
    this.#pings.delete(id);
  }

  async close(): Promise<void> {
    if (this.#poll) clearInterval(this.#poll);
    // Releases sent just before are posted, not lost as the helper exits.
    await Promise.race([this.ping().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    await new Promise((resolve) => setTimeout(resolve, CLOSE_GRACE_MS));
    await this.#writer.close().catch(() => undefined);
    await this.#channel.close().catch(() => undefined);
  }
}
