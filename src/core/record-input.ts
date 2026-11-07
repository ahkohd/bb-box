import type { GuestOs } from "../transports/types.ts";

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

export type ActedInput =
  | { readonly type: "click"; readonly button: MouseButton; readonly count: 1 | 2; readonly point: InputPoint; readonly area: InputArea | null }
  | { readonly type: "scroll"; readonly point: InputPoint }
  | { readonly type: "keys"; readonly chord: KeyChord }
  | { readonly type: "typing"; readonly characters: number; readonly area: InputArea | null; readonly secret: boolean };

export type PersonInput = { readonly type: "pointer"; readonly x: number; readonly y: number; readonly buttons: number } | { readonly type: "key"; readonly keysym: number; readonly down: boolean };

export type InputSpace = "screen" | "picture";
export type InputSource = "agent" | "person";

export type InputEvent =
  | { readonly at: number; readonly by: InputSource; readonly type: "click"; readonly space: InputSpace; readonly button: MouseButton; readonly count: 1 | 2; readonly x: number; readonly y: number; readonly area: InputArea | null }
  | { readonly at: number; readonly by: InputSource; readonly type: "scroll"; readonly space: InputSpace; readonly x: number; readonly y: number }
  | { readonly at: number; readonly by: InputSource; readonly type: "keys"; readonly chord: KeyChord }
  | { readonly at: number; readonly by: InputSource; readonly type: "typing"; readonly characters: number; readonly space: InputSpace; readonly area: InputArea | null; readonly secret: boolean }
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

export function choosesTyping(chord: KeyChord, os: GuestOs): boolean {
  const commanding = chord.modifiers.filter((modifier) => modifier !== "shift" && !(os === "macos" && modifier === "alt"));
  if (commanding.length) return false;
  return !isNamedKey(chord.key);
}

const SECRET_ROLE = /password|secure/i;
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
  return (!!role && SECRET_ROLE.test(role)) || (!!name && SECRET_NAME.test(name)) || looksLikeSecret(text);
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

const KEYSYM_MODIFIERS: Readonly<Record<number, Modifier>> = {
  0xffe1: "shift",
  0xffe2: "shift",
  0xffe3: "ctrl",
  0xffe4: "ctrl",
  0xffe7: "super",
  0xffe8: "super",
  0xffe9: "alt",
  0xffea: "alt",
  0xffeb: "super",
  0xffec: "super",
  0xfe03: "alt",
};

export function keysymModifier(keysym: number): Modifier | null {
  return KEYSYM_MODIFIERS[keysym] ?? null;
}

export function keysymKey(keysym: number): string | null {
  const named = KEYSYM_NAMES[keysym];
  if (named) return named;
  if (keysym >= 0xffbe && keysym <= 0xffd5) return `F${keysym - 0xffbe + 1}`;
  if ((keysym >= 0x21 && keysym <= 0x7e) || (keysym >= 0xa0 && keysym <= 0xff)) return String.fromCodePoint(keysym).toUpperCase();
  if (keysym >= 0x1000000 && keysym <= 0x110ffff) return String.fromCodePoint(keysym - 0x1000000).toUpperCase();
  return null;
}

interface Recording {
  readonly offsetMs: number;
  readonly os: GuestOs;
  readonly events: InputEvent[];
  readonly held: Set<Modifier>;
  lastPointer: { at: number; buttons: number } | null;
  typing: { readonly secret: boolean } | null;
}

export class RecordingInputs {
  readonly #now: () => number;
  readonly #recordings = new Map<string, Recording>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  begin(boxId: string, offsetMs: number, os: GuestOs): void {
    this.#recordings.set(boxId, { offsetMs, os, events: [], held: new Set(), lastPointer: null, typing: null });
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
        this.#push(recording, { at, by: "agent", type: "click", space: "screen", button: input.button, count: input.count, x: input.point.x, y: input.point.y, area: input.area });
        return;
      case "scroll":
        this.#push(recording, { at, by: "agent", type: "scroll", space: "screen", x: input.point.x, y: input.point.y });
        return;
      case "keys":
        recording.typing = null;
        if (choosesTyping(input.chord, recording.os)) this.#push(recording, { at, by: "agent", type: "typing", characters: 1, space: "screen", area: null, secret: false });
        else this.#push(recording, { at, by: "agent", type: "keys", chord: input.chord });
        return;
      case "typing": {
        const started = input.characters > 0 ? { secret: input.secret } : recording.typing;
        if (!started) return;
        recording.typing = input.characters > 0 ? started : null;
        this.#push(recording, { at, by: "agent", type: "typing", characters: input.characters, space: "screen", area: input.area, secret: started.secret });
        return;
      }
    }
  }

  person(boxId: string, input: PersonInput): void {
    const recording = this.#recordings.get(boxId);
    if (!recording) return;
    const at = this.#boxSeconds(recording);
    if (input.type === "pointer") {
      const last = recording.lastPointer;
      if (last && last.buttons === input.buttons && (at - last.at) * 1000 < PERSON_POINTER_SPACING_MS) return;
      recording.lastPointer = { at, buttons: input.buttons };
      this.#push(recording, { at, by: "person", type: "pointer", space: "picture", x: input.x, y: input.y, buttons: input.buttons });
      return;
    }
    const modifier = keysymModifier(input.keysym);
    if (modifier) {
      if (input.down) recording.held.add(modifier);
      else recording.held.delete(modifier);
      return;
    }
    if (!input.down) return;
    const key = keysymKey(input.keysym);
    if (!key) return;
    const chord: KeyChord = { key, modifiers: MODIFIER_ORDER.filter((each) => recording.held.has(each)) };
    if (choosesTyping(chord, recording.os)) this.#push(recording, { at, by: "person", type: "typing", characters: 1, space: "picture", area: null, secret: false });
    else this.#push(recording, { at, by: "person", type: "keys", chord });
  }
}
