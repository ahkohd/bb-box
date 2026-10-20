// What both desktop viewers share: noVNC's for RFB (desktop.tsx) and the
// video one for Selkies (selkies.ts, 056).

/** The longest wait between attempts to reconnect to a desktop. */
export const MAX_RETRY_MS = 15_000;
/** Up to how much of a reconnect's wait is added at random, so the pages that lose the plugin together, as in a deploy, do not retry in step. */
export const RETRY_JITTER = 0.25;

/** The wait before the next attempt to reconnect, after `failures` in a row: 1 s, doubling up to MAX_RETRY_MS, and up to RETRY_JITTER more at random. */
export function retryWait(failures: number, random: () => number = Math.random): number {
  const wait = Math.min(MAX_RETRY_MS, 1000 * 2 ** failures);
  return Math.round(wait * (1 + RETRY_JITTER * random()));
}
/** How long the viewer's size must hold before the desktop is asked for it again. */
export const SETTLE_MS = 250;
/** How long the paste chord waits after the text is sent, so a server that fetches the text (the extended clipboard) has it before the paste. */
export const PASTE_CHORD_DELAY_MS = 150;
/** How long a Cmd+V or Ctrl+V waits for the browser's paste event before the box pastes its own clipboard. */
export const PASTE_EVENT_WAIT_MS = 150;
export const XK_SHIFT_L = 0xffe1;
export const XK_SHIFT_R = 0xffe2;
export const XK_CONTROL_L = 0xffe3;
export const XK_CONTROL_R = 0xffe4;
export const XK_META_L = 0xffe7;
export const XK_META_R = 0xffe8;
export const XK_ALT_L = 0xffe9;
export const XK_ALT_R = 0xffea;
export const XK_SUPER_L = 0xffeb;
export const XK_SUPER_R = 0xffec;
export const XK_MODE_SWITCH = 0xff7e;
export const XK_ISO_LEVEL3_SHIFT = 0xfe03;
export const XK_V = 0x76;

/**
 * How a macOS desktop's server names Command and Option. "alt-command" for
 * Tart's VNC server, which takes Alt as Command and Meta as Option, and Super
 * as nothing. Left out, as Screen Sharing and bb-box's own Mac input for
 * video take them: Meta or Super as Command, Alt as Option (measured with each
 * keysym on its own, 19 October 2026).
 */
export type MacKeys = "alt-command";

export type Connection = { readonly state: "connecting" } | { readonly state: "connected" } | { readonly state: "disconnected"; readonly reason: string; readonly retryMs: number };

/** Whether the browser runs on a Mac, where Cmd is the shortcut key: Chrome says "macOS", Safari "MacIntel". */
export function macBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad/i.test(platform);
}

type Modifier = { readonly key: "command" | "option"; readonly right: boolean };

/**
 * The modifier a person pressed, from noVNC's keysym for it. In a Mac's browser noVNC sends the left Cmd as Alt_L,
 * the right one as Super_L, the left Option as Mode_switch and the right one as ISO_Level3_Shift, as RealVNC's viewer
 * does (measured in Safari on macOS, 19 October 2026). Elsewhere Meta and Super are the Windows key, Cmd's place, and
 * Alt is Option's.
 */
function modifierOf(keysym: number, mac: boolean): Modifier | null {
  if (mac) {
    if (keysym === XK_ALT_L) return { key: "command", right: false };
    if (keysym === XK_SUPER_L || keysym === XK_SUPER_R || keysym === XK_ALT_R) return { key: "command", right: true };
    if (keysym === XK_MODE_SWITCH) return { key: "option", right: false };
    if (keysym === XK_ISO_LEVEL3_SHIFT) return { key: "option", right: true };
    return null;
  }
  if (keysym === XK_META_L || keysym === XK_SUPER_L) return { key: "command", right: false };
  if (keysym === XK_META_R || keysym === XK_SUPER_R) return { key: "command", right: true };
  if (keysym === XK_ALT_L) return { key: "option", right: false };
  if (keysym === XK_ALT_R) return { key: "option", right: true };
  return null;
}

/** A modifier key's keysym and DOM code, for noVNC, whose QEMU key events take the code. */
type Key = { readonly keysym: number; readonly code: string };

const CONTROL: readonly [Key, Key] = [{ keysym: XK_CONTROL_L, code: "ControlLeft" }, { keysym: XK_CONTROL_R, code: "ControlRight" }];
const META: readonly [Key, Key] = [{ keysym: XK_META_L, code: "MetaLeft" }, { keysym: XK_META_R, code: "MetaRight" }];
const ALT: readonly [Key, Key] = [{ keysym: XK_ALT_L, code: "AltLeft" }, { keysym: XK_ALT_R, code: "AltRight" }];

/** The key that is Command in a macOS desktop, as its server names it. */
export function commandKey(macKeys: MacKeys | null): Key {
  return (macKeys === "alt-command" ? ALT : META)[0];
}

/**
 * The key the box gets for one a person pressed. On a macOS desktop, Cmd and Option go as its server names Command
 * and Option, from a Mac or not, so Cmd+C copies and a Linux or Windows user's Alt is Option. Elsewhere, from a Mac,
 * Cmd goes as Ctrl, where Cmd+C, Cmd+V, Cmd+A and the rest are the box's Ctrl shortcuts (the operator's note of
 * 4 October 2026), and Option as Alt, the left one through OptionComposer. Other keys go as they are.
 */
export function boxKey(keysym: number, code: string, guestOs: string, mac: boolean, macKeys: MacKeys | null): Key {
  const modifier = modifierOf(keysym, mac);
  if (modifier === null) return { keysym, code };
  const side = modifier.right ? 1 : 0;
  if (guestOs === "macos") {
    const command = macKeys === "alt-command" ? ALT : META;
    const option = macKeys === "alt-command" ? META : ALT;
    return (modifier.key === "command" ? command : option)[side];
  }
  if (mac && modifier.key === "command") return CONTROL[side];
  if (mac && modifier.key === "option") return ALT[side];
  return { keysym, code };
}

/** Whether a keysym types a character: Latin-1, X's own names for characters past it, and Unicode keysyms. */
function typesCharacter(keysym: number): boolean {
  return (keysym > 0x20 && keysym < 0xfd00) || keysym >= 0x1000000;
}

/** The character each key of a US keyboard types, by its DOM code, without and with Shift. */
const US_BY_CODE: Readonly<Record<string, string>> = {
  ...Object.fromEntries([..."abcdefghijklmnopqrstuvwxyz"].map((letter) => [`Key${letter.toUpperCase()}`, letter + letter.toUpperCase()])),
  ...Object.fromEntries([..."0123456789"].map((digit, index) => [`Digit${digit}`, digit + ")!@#$%^&*("[index]])),
  Minus: "-_",
  Equal: "=+",
  BracketLeft: "[{",
  BracketRight: "]}",
  Backslash: "\\|",
  Semicolon: ";:",
  Quote: "'\"",
  Backquote: "`~",
  Comma: ",<",
  Period: ".>",
  Slash: "/?",
};

/**
 * A Mac's left Option on a desktop that is not a Mac, where it would be Alt: on a Mac it composes, Option+E then E
 * typing é, and as Alt it opened the app's menu on Windows instead (the desktop sweep). So it is held back: a
 * character typed while it is held, which the browser composed, goes alone; any other key, such as an arrow, Tab or
 * F4, or a key with Ctrl held, goes after Alt; and Option let go alone sends nothing. The right Option is plain Alt,
 * for Alt+F and the rest of an app's menu keys, and a lone Alt: a key typed with it goes as the character its key
 * types on a US keyboard, f and not the ƒ a Mac makes of Option+F.
 */
export class OptionComposer {
  #held = false;
  #altSent = false;
  #control = new Set<number>();
  #shift = new Set<number>();
  #right = false;
  /** The keysym each key went down as while the right Option was held, by its code, so it goes up as that. */
  readonly #plain = new Map<string, number>();

  /** The key events to send for one the person pressed, as boxKey mapped it. */
  keys(key: Key, down: boolean): { readonly key: Key; readonly down: boolean }[] {
    // A dead key, as Option+E is, which noVNC gives no keysym in Chrome: it types nothing, and would be Alt+E.
    if (!key.keysym) return [];
    if (key.keysym === XK_ALT_L) {
      if (down) {
        this.#held = true;
        return [];
      }
      this.#held = false;
      if (!this.#altSent) return [];
      this.#altSent = false;
      return [{ key: ALT[0], down: false }];
    }
    if (key.keysym === XK_CONTROL_L || key.keysym === XK_CONTROL_R) {
      if (down) this.#control.add(key.keysym);
      else this.#control.delete(key.keysym);
    }
    if (key.keysym === XK_SHIFT_L || key.keysym === XK_SHIFT_R) {
      if (down) this.#shift.add(key.keysym);
      else this.#shift.delete(key.keysym);
    }
    if (key.keysym === XK_ALT_R) this.#right = down;
    const plain = this.#plain.get(key.code);
    if (!down && plain !== undefined) {
      this.#plain.delete(key.code);
      key = { keysym: plain, code: key.code };
    } else if (down && this.#right && typesCharacter(key.keysym) && US_BY_CODE[key.code]) {
      key = { keysym: US_BY_CODE[key.code]!.codePointAt(this.#shift.size ? 1 : 0)!, code: key.code };
      this.#plain.set(key.code, key.keysym);
    }
    if (!down || !this.#held || (typesCharacter(key.keysym) && this.#control.size === 0)) return [{ key, down }];
    if (this.#altSent) return [{ key, down }];
    this.#altSent = true;
    return [
      { key: ALT[0], down: true },
      { key, down },
    ];
  }

  /** Forgets what is held, once the viewer lets go of every key. */
  reset(): void {
    this.#held = false;
    this.#altSent = false;
    this.#right = false;
    this.#control.clear();
    this.#shift.clear();
    this.#plain.clear();
  }
}
