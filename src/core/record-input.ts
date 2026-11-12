import type { GuestOs } from "../transports/types.ts";
import { isSecureRole } from "./secure-fields.ts";

export interface InputPoint {
  readonly x: number;
  readonly y: number;
}

export interface InputArea extends InputPoint {
  readonly width: number;
  readonly height: number;
}

export type MouseButton = "left" | "middle" | "right";
export type Modifier = "ctrl" | "alt" | "shift" | "super";

export interface KeyChord {
  readonly key: string;
  readonly modifiers: readonly Modifier[];
}

export interface TypedField {
  readonly role: string;
  readonly name: string;
}

export type ActedInput =
  | { readonly type: "click"; readonly button: MouseButton; readonly count: 1 | 2; readonly point: InputPoint; readonly area: InputArea | null; readonly role?: string | null; readonly window?: InputArea | null }
  | { readonly type: "scroll"; readonly point: InputPoint; readonly window?: InputArea | null }
  | { readonly type: "keys"; readonly key: string; readonly modifiers: readonly string[] }
  | { readonly type: "typing"; readonly characters: number; readonly area: InputArea | null; readonly secret: boolean; readonly role?: string | null; readonly window?: InputArea | null };

export type PersonInput =
  | { readonly type: "pointer"; readonly x: number; readonly y: number; readonly buttons: number }
  | { readonly type: "key"; readonly keysym: number; readonly down: boolean }
  | { readonly type: "released" };

export type MacKeys = "alt-command" | null;

export type InputSpace = "screen" | "picture";
export type InputSource = "agent" | "person";

export type InputEvent =
  | { readonly at: number; readonly by: InputSource; readonly type: "click"; readonly space: InputSpace; readonly button: MouseButton; readonly count: 1 | 2; readonly x: number; readonly y: number; readonly area: InputArea | null; readonly role?: string | null; readonly window?: InputArea | null }
  | { readonly at: number; readonly by: InputSource; readonly type: "scroll"; readonly space: InputSpace; readonly x: number; readonly y: number; readonly window?: InputArea | null }
  | { readonly at: number; readonly by: InputSource; readonly type: "keys"; readonly chord: KeyChord }
  | { readonly at: number; readonly by: InputSource; readonly type: "typing"; readonly characters: number; readonly space: InputSpace; readonly area: InputArea | null; readonly secret: boolean; readonly role?: string | null; readonly window?: InputArea | null; readonly call?: number }
  | { readonly at: number; readonly by: "person"; readonly type: "pointer"; readonly space: "picture"; readonly x: number; readonly y: number; readonly buttons: number };

export const INPUT_EVENTS_MOST = 20_000;
export const PERSON_POINTER_SPACING_MS = 25;

const KEY_NAMES: Readonly<Record<string, string>> = {
  return: "Enter",
  enter: "Enter",
  kp_enter: "Enter",
  tab: "Tab",
  iso_left_tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  backspace: "Backspace",
  back_space: "Backspace",
  delete: "Delete",
  del: "Delete",
  forwarddelete: "Delete",
  left: "Left",
  arrowleft: "Left",
  right: "Right",
  arrowright: "Right",
  up: "Up",
  arrowup: "Up",
  down: "Down",
  arrowdown: "Down",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  page_up: "PageUp",
  prior: "PageUp",
  pagedown: "PageDown",
  page_down: "PageDown",
  next: "PageDown",
  insert: "Insert",
  space: "Space",
};

const MODIFIER_NAMES: Readonly<Record<string, Modifier>> = {
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
  cmd: "super",
  command: "super",
  super: "super",
  meta: "super",
  win: "super",
  windows: "super",
};

const MODIFIER_ORDER: readonly Modifier[] = ["ctrl", "alt", "shift", "super"];

export function keyName(key: string): string {
  const named = KEY_NAMES[key.toLowerCase()];
  if (named) return named;
  const function_ = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(key);
  if (function_) return `F${function_[1]}`;
  if ([...key].length === 1) return key.toUpperCase();
  return key;
}

export function normalChord(key: string, modifiers: readonly string[]): KeyChord {
  const held = new Set(modifiers.map((modifier) => MODIFIER_NAMES[modifier.toLowerCase()]).filter((modifier): modifier is Modifier => !!modifier));
  return { key: keyName(key), modifiers: MODIFIER_ORDER.filter((modifier) => held.has(modifier)) };
}

const NAMED_KEYS = new Set(["Enter", "Tab", "Escape", "Backspace", "Delete", "Left", "Right", "Up", "Down", "Home", "End", "PageUp", "PageDown", "Insert"]);

export function isNamedKey(key: string): boolean {
  return NAMED_KEYS.has(key) || /^F\d+$/.test(key);
}

export type HeldModifierKind = "command" | "shift" | "characters";

export interface HeldModifier {
  readonly modifier: Modifier | null;
  readonly kind: HeldModifierKind;
}

const SHIFT: HeldModifier = { modifier: "shift", kind: "shift" };
const CONTROL: HeldModifier = { modifier: "ctrl", kind: "command" };
const COMMAND: HeldModifier = { modifier: "super", kind: "command" };
const ALT: HeldModifier = { modifier: "alt", kind: "command" };
const OPTION: HeldModifier = { modifier: "alt", kind: "characters" };
const LEVEL_SHIFT: HeldModifier = { modifier: null, kind: "characters" };

export type KeyPress = { readonly type: "keys"; readonly chord: KeyChord } | { readonly type: "typing" };

const TYPING: KeyPress = { type: "typing" };

function isShortcutKey(key: string): boolean {
  return key === "Space" || /^[\x21-\x7e]$/.test(key);
}

function ctrlAltIsAltGr(os: GuestOs): boolean {
  return os === "windows";
}

function shownOf(held: readonly HeldModifier[]): Modifier[] {
  return MODIFIER_ORDER.filter((modifier) => held.some((each) => each.modifier === modifier));
}

export function pressOf(key: string | null, held: readonly HeldModifier[], os: GuestOs): KeyPress {
  const shown = shownOf(held);
  if (key !== null && isNamedKey(key)) return { type: "keys", chord: { key, modifiers: shown } };
  const altGr = ctrlAltIsAltGr(os) && shown.includes("ctrl") && shown.includes("alt");
  const makesCharacters = held.some((each) => each.kind === "characters") || altGr;
  const commands = held.some((each) => each.kind === "command");
  if (key === null || !isShortcutKey(key) || !commands || makesCharacters) return TYPING;
  return { type: "keys", chord: { key, modifiers: shown } };
}

function agentModifier(name: string, os: GuestOs): HeldModifier {
  const modifier = MODIFIER_NAMES[name.toLowerCase()];
  if (modifier === "ctrl") return CONTROL;
  if (modifier === "shift") return SHIFT;
  if (modifier === "super") return COMMAND;
  if (modifier === "alt") return os === "macos" ? OPTION : ALT;
  return LEVEL_SHIFT;
}

export function agentPress(key: string, modifiers: readonly string[], os: GuestOs): KeyPress {
  return pressOf(keyName(key), modifiers.map((each) => agentModifier(each, os)), os);
}

const SECRET_NAME = /pass(word|code|phrase)|\bpin\b|secret|token|api[ _-]?key/i;
const SECRET_PREFIX = /^(sk-|sk_|pk_|rk_|ghp_|gho_|ghs_|github_pat_|glpat-|xox[abpr]-|AKIA|ASIA|AIza|ya29\.|eyJ|-----BEGIN)/;

export function looksLikeSecret(text: string): boolean {
  const trimmed = text.trim();
  if (SECRET_PREFIX.test(trimmed)) return true;
  if (trimmed.length < 16 || /\s/.test(trimmed)) return false;
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((kind) => kind.test(trimmed)).length;
  return kinds >= 3;
}

export function isSecretTyping(role: string | null, name: string | null, text: string): boolean {
  return (!!role && isSecureRole(role)) || (!!name && SECRET_NAME.test(name)) || looksLikeSecret(text);
}

export function typingKeptSecret(field: TypedField | null, text: string): boolean {
  return field === null || isSecretTyping(field.role, field.name, text);
}

const KEYSYM_NAMES: Readonly<Record<number, string>> = {
  0xff0d: "Enter",
  0xff8d: "Enter",
  0xff09: "Tab",
  0xfe20: "Tab",
  0xff1b: "Escape",
  0xff08: "Backspace",
  0xffff: "Delete",
  0xff9f: "Delete",
  0xff51: "Left",
  0xff52: "Up",
  0xff53: "Right",
  0xff54: "Down",
  0xff50: "Home",
  0xff57: "End",
  0xff55: "PageUp",
  0xff56: "PageDown",
  0xff63: "Insert",
  0x20: "Space",
};

const XK_SHIFT = [0xffe1, 0xffe2];
const XK_CONTROL = [0xffe3, 0xffe4];
const XK_META = [0xffe7, 0xffe8];
const XK_ALT = [0xffe9, 0xffea];
const XK_SUPER_OR_HYPER = [0xffeb, 0xffec, 0xffed, 0xffee];
const XK_LEVEL_SHIFTS = [0xfe03, 0xfe04, 0xfe05, 0xfe06, 0xfe07, 0xfe11, 0xfe12, 0xfe13, 0xff7e];

export function keysymModifier(keysym: number, os: GuestOs, macKeys: MacKeys): HeldModifier | null {
  const mac = os === "macos";
  const altIsCommand = mac && macKeys === "alt-command";
  if (XK_SHIFT.includes(keysym)) return SHIFT;
  if (XK_CONTROL.includes(keysym)) return CONTROL;
  if (XK_ALT.includes(keysym)) return altIsCommand ? COMMAND : mac ? OPTION : ALT;
  if (XK_META.includes(keysym)) return altIsCommand ? OPTION : COMMAND;
  if (XK_SUPER_OR_HYPER.includes(keysym)) return altIsCommand ? LEVEL_SHIFT : COMMAND;
  if (XK_LEVEL_SHIFTS.includes(keysym)) return LEVEL_SHIFT;
  return null;
}

const UNICODE_KEYSYM = 0x1000000;

export function keysymKey(keysym: number): string | null {
  const named = KEYSYM_NAMES[keysym];
  if (named) return named;
  if (keysym >= 0xffbe && keysym <= 0xffd5) return `F${keysym - 0xffbe + 1}`;
  const code = keysym >= UNICODE_KEYSYM ? keysym - UNICODE_KEYSYM : keysym;
  if (code >= 0x21 && code <= 0x7e) return String.fromCharCode(code).toUpperCase();
  return null;
}

export function keysymTypes(keysym: number): boolean {
  const characters = keysym >= 0x20 && keysym < 0xfd00;
  const keypadCharacters = keysym >= 0xffaa && keysym <= 0xffb9;
  return characters || keypadCharacters || (keysym >= UNICODE_KEYSYM && keysym <= UNICODE_KEYSYM + 0x10ffff);
}

export type Composition =
  | { readonly kind: "code-point"; readonly digits: number }
  | { readonly kind: "compose"; readonly keysLeft: number }
  | { readonly kind: "dead-key" }
  | { readonly kind: "input-method" };

const XK_MULTI_KEY = 0xff20;
const XK_DEAD_KEYS = [0xfe50, 0xfe93] as const;
const XK_INPUT_METHOD_KEYS = [0xff21, 0xff3f] as const;
const COMPOSE_KEYS_MOST = 3;
const COMPOSITION_ENDS = ["Enter", "Escape", "Space"];
const CODE_POINT_DIGIT = /^[0-9A-F]$/;
const INPUT_METHOD_KEY_NAMES = /^(kanji|henkan(_mode)?|muhenkan|hiragana|katakana|hiragana_katakana|zenkaku|hankaku|zenkaku_hankaku|eisu_toggle|hangul(_\w+)?|kana_lock|kana_shift|eisu_shift|romaji|touroku|massyo)$/i;

const within = (keysym: number, [first, last]: readonly [number, number]) => keysym >= first && keysym <= last;

function compositionOfKeysym(keysym: number): Composition | null {
  if (keysym === XK_MULTI_KEY) return { kind: "compose", keysLeft: COMPOSE_KEYS_MOST };
  if (within(keysym, XK_DEAD_KEYS)) return { kind: "dead-key" };
  return within(keysym, XK_INPUT_METHOD_KEYS) ? { kind: "input-method" } : null;
}

function compositionOfKeyName(name: string): Composition | null {
  const lower = name.toLowerCase();
  if (lower === "multi_key" || lower === "compose") return { kind: "compose", keysLeft: COMPOSE_KEYS_MOST };
  if (lower.startsWith("dead_")) return { kind: "dead-key" };
  return INPUT_METHOD_KEY_NAMES.test(lower) ? { kind: "input-method" } : null;
}

function compositionOfChord(key: string | null, shown: readonly Modifier[], os: GuestOs): Composition | null {
  if (os !== "linux" || !shown.includes("ctrl") || !shown.includes("shift")) return null;
  if (key === "U") return { kind: "code-point", digits: 0 };
  return key === "E" ? { kind: "input-method" } : null;
}

export function afterComposedKey(composition: Composition, key: string | null): Composition | null {
  if (key !== null && COMPOSITION_ENDS.includes(key)) return null;
  switch (composition.kind) {
    case "code-point":
      return key !== null && CODE_POINT_DIGIT.test(key) ? { kind: "code-point", digits: composition.digits + 1 } : composition;
    case "compose":
      return composition.keysLeft > 1 ? { kind: "compose", keysLeft: composition.keysLeft - 1 } : null;
    case "dead-key":
      return null;
    case "input-method":
      return composition;
  }
}

function codePointCommitted(composition: Composition, held: ReadonlyMap<number, HeldModifier>): boolean {
  return composition.kind === "code-point" && composition.digits > 0 && ![...held.values()].some((each) => each.modifier === "ctrl" || each.modifier === "shift");
}

interface Recording {
  readonly offsetMs: number;
  readonly os: GuestOs;
  readonly events: InputEvent[];
  readonly held: Map<number, HeldModifier>;
  lastPointer: { at: number; x: number; y: number; buttons: number } | null;
  calls: number;
  typing: { readonly secret: boolean; readonly window: InputArea | null; readonly call: number } | null;
  composing: Composition | null;
}

export class RecordingInputs {
  readonly #now: () => number;
  readonly #recordings = new Map<string, Recording>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  begin(boxId: string, offsetMs: number, os: GuestOs): void {
    this.#recordings.set(boxId, { offsetMs, os, events: [], held: new Map(), lastPointer: null, calls: 0, typing: null, composing: null });
  }

  recording(boxId: string): boolean {
    return this.#recordings.has(boxId);
  }

  end(boxId: string): readonly InputEvent[] | null {
    const recording = this.#recordings.get(boxId);
    this.#recordings.delete(boxId);
    return recording ? recording.events : null;
  }

  #boxSeconds(recording: Recording, at?: number): number {
    return Math.round((at ?? this.#now()) + recording.offsetMs) / 1000;
  }

  #push(recording: Recording, event: InputEvent): void {
    if (recording.events.length < INPUT_EVENTS_MOST) recording.events.push(event);
  }

  acted(boxId: string, input: ActedInput, sentAt?: number): void {
    const recording = this.#recordings.get(boxId);
    if (!recording) return;
    const at = this.#boxSeconds(recording, sentAt);
    switch (input.type) {
      case "click":
        this.#push(recording, { at, by: "agent", type: "click", space: "screen", button: input.button, count: input.count, x: input.point.x, y: input.point.y, area: input.area, role: input.role ?? null, window: input.window ?? null });
        return;
      case "scroll":
        this.#push(recording, { at, by: "agent", type: "scroll", space: "screen", x: input.point.x, y: input.point.y, window: input.window ?? null });
        return;
      case "keys": {
        recording.typing = null;
        const composing = recording.composing;
        const started = composing ? null : (compositionOfKeyName(input.key) ?? compositionOfChord(keyName(input.key), normalChord(input.key, input.modifiers).modifiers, recording.os));
        recording.composing = composing ? afterComposedKey(composing, keyName(input.key)) : started;
        const press = composing || started ? TYPING : agentPress(input.key, input.modifiers, recording.os);
        if (press.type === "typing") this.#push(recording, { at, by: "agent", type: "typing", characters: 1, space: "screen", area: null, secret: true });
        else this.#push(recording, { at, by: "agent", type: "keys", chord: press.chord });
        return;
      }
      case "typing": {
        const started = input.characters > 0 ? { secret: input.secret, window: input.window ?? null, call: ++recording.calls } : recording.typing;
        if (!started) return;
        recording.typing = input.characters > 0 ? started : null;
        this.#push(recording, { at, by: "agent", type: "typing", characters: input.characters, space: "screen", area: input.area, secret: started.secret, role: input.characters > 0 ? (input.role ?? null) : null, window: started.window, call: started.call });
        return;
      }
    }
  }

  person(boxId: string, input: PersonInput, macKeys: MacKeys = null): void {
    const recording = this.#recordings.get(boxId);
    if (!recording) return;
    const at = this.#boxSeconds(recording);
    if (input.type === "released") {
      this.#letGo(recording, at);
      return;
    }
    if (input.type === "pointer") {
      const last = recording.lastPointer;
      if (last && last.buttons === input.buttons && (at - last.at) * 1000 < PERSON_POINTER_SPACING_MS) return;
      recording.lastPointer = { at, x: input.x, y: input.y, buttons: input.buttons };
      this.#push(recording, { at, by: "person", type: "pointer", space: "picture", x: input.x, y: input.y, buttons: input.buttons });
      return;
    }
    const modifier = keysymModifier(input.keysym, recording.os, macKeys);
    if (modifier) {
      if (input.down) recording.held.set(input.keysym, modifier);
      else recording.held.delete(input.keysym);
      if (recording.composing && codePointCommitted(recording.composing, recording.held)) recording.composing = null;
      return;
    }
    if (!input.down) return;
    const key = keysymKey(input.keysym);
    const composing = recording.composing;
    const started = composing ? null : (compositionOfKeysym(input.keysym) ?? compositionOfChord(key, shownOf([...recording.held.values()]), recording.os));
    recording.composing = composing ? afterComposedKey(composing, key) : started;
    if (!composing && !started && key === null && !keysymTypes(input.keysym)) return;
    const press = composing || started ? TYPING : pressOf(key, [...recording.held.values()], recording.os);
    if (press.type === "typing") this.#push(recording, { at, by: "person", type: "typing", characters: 1, space: "picture", area: null, secret: true });
    else this.#push(recording, { at, by: "person", type: "keys", chord: press.chord });
  }

  #letGo(recording: Recording, at: number): void {
    recording.held.clear();
    recording.composing = null;
    const last = recording.lastPointer;
    if (!last?.buttons) return;
    recording.lastPointer = { ...last, at, buttons: 0 };
    this.#push(recording, { at, by: "person", type: "pointer", space: "picture", x: last.x, y: last.y, buttons: 0 });
  }
}
