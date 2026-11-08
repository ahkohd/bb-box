import type { InputArea, InputSource, KeyChord, Modifier } from "./record-input.ts";

export const KEY_SHOWN_S = 1.2;
export const SAME_KEY_S = 0.8;
export const TYPING_GAP_S = 1.5;
export const TYPING_AFTER_S = 0.6;
export const TYPING_LEAST_S = 1;
export const TYPING_WORDS = "Typing";

export type KeyStyle = "mac" | "pc";

export interface PlacedKeys {
  readonly at: number;
  readonly chord: KeyChord;
}

export interface PlacedKeyTyping {
  readonly at: number;
  readonly secret: boolean;
  readonly characters: number;
  readonly by?: InputSource;
  readonly call?: number;
}

export interface KeyPill {
  readonly from: number;
  readonly to: number;
  readonly text: string;
  readonly typing: boolean;
  readonly avoid?: InputArea | null;
}

const MAC_MODIFIERS: Readonly<Record<Modifier, string>> = { ctrl: "⌃", alt: "⌥", shift: "⇧", super: "⌘" };
const PC_MODIFIERS: Readonly<Record<Modifier, string>> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", super: "Super" };
const MAC_ORDER: readonly Modifier[] = ["ctrl", "alt", "shift", "super"];
const PC_ORDER: readonly Modifier[] = ["ctrl", "super", "alt", "shift"];

const MAC_KEYS: Readonly<Record<string, string>> = {
  Enter: "Return",
  Tab: "Tab",
  Escape: "Esc",
  Backspace: "⌫",
  Delete: "⌦",
  Left: "←",
  Right: "→",
  Up: "↑",
  Down: "↓",
  Home: "Home",
  End: "End",
  PageUp: "Page Up",
  PageDown: "Page Down",
  Insert: "Insert",
  Space: "Space",
};

const PC_KEYS: Readonly<Record<string, string>> = { ...MAC_KEYS, Enter: "Enter", Backspace: "Backspace", Delete: "Delete" };

export function chordWords(chord: KeyChord, style: KeyStyle): string {
  const key = (style === "mac" ? MAC_KEYS : PC_KEYS)[chord.key] ?? chord.key;
  if (style === "mac") return `${MAC_ORDER.filter((each) => chord.modifiers.includes(each)).map((each) => MAC_MODIFIERS[each]).join("")}${key}`;
  return [...PC_ORDER.filter((each) => chord.modifiers.includes(each)).map((each) => PC_MODIFIERS[each]), key].join("+");
}

const sameChord = (a: KeyChord, b: KeyChord) => a.key === b.key && a.modifiers.join() === b.modifiers.join();
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const editsTyping = (chord: KeyChord) => !chord.modifiers.length && (chord.key === "Backspace" || chord.key === "Delete");

interface TypingCall {
  readonly from: number;
  readonly shown: number;
  readonly to: number;
  readonly secret: boolean;
  readonly by?: InputSource;
  readonly call?: number;
}

interface OpenTyping {
  from: number;
  last: number;
  secret: boolean;
  by?: InputSource;
  call?: number;
}

function sameTyping(left: { readonly by?: InputSource; readonly call?: number }, right: { readonly by?: InputSource; readonly call?: number }): boolean {
  if (left.call !== undefined && right.call !== undefined && left.call !== right.call) return false;
  if (left.by && right.by && left.by !== right.by) return false;
  return true;
}

export function planKeyPills(keys: readonly PlacedKeys[], typing: readonly PlacedKeyTyping[], style: KeyStyle, length: number): KeyPill[] {
  const typed = [...typing].sort((a, b) => a.at - b.at || b.characters - a.characters);
  const nearTyping = (at: number) => typed.some((each) => Math.abs(each.at - at) <= TYPING_GAP_S);
  const edits = keys.filter((each) => editsTyping(each.chord) && nearTyping(each.at)).map((each): PlacedKeyTyping => ({ at: each.at, secret: false, characters: 1 }));
  const calls: TypingCall[] = [];
  let open: OpenTyping | null = null;
  const finish = (shown: number) => {
    const current = open;
    if (!current) return;
    calls.push({ from: current.from, shown, to: current.last, secret: current.secret, by: current.by, call: current.call });
    open = null;
  };
  for (const each of [...typed, ...edits].sort((a, b) => a.at - b.at || b.characters - a.characters)) {
    if (each.characters === 0) {
      if (open && sameTyping(open, each)) {
        open.last = each.at;
        finish(each.at);
      }
      continue;
    }
    if (!open) {
      const previous = calls.at(-1);
      if (previous && !previous.secret && !each.secret && each.characters === 1 && sameTyping(previous, each) && each.at - previous.to <= TYPING_GAP_S) {
        calls[calls.length - 1] = { ...previous, to: each.at };
        continue;
      }
      open = { from: each.at, last: each.at, secret: each.secret, by: each.by, call: each.call };
      continue;
    }
    if (!sameTyping(open, each) || each.at - open.last > TYPING_GAP_S) {
      finish(open.from);
      open = { from: each.at, last: each.at, secret: each.secret, by: each.by, call: each.call };
      continue;
    }
    open.last = each.at;
    if (each.characters > 1) open.secret ||= each.secret;
  }
  if (open) finish(open.from);
  const bursts: TypingCall[] = [];
  for (const call of calls) {
    const last = bursts.at(-1);
    if (last && !last.secret && !call.secret && sameTyping(last, call) && call.from - last.to <= TYPING_GAP_S) bursts[bursts.length - 1] = { from: last.from, shown: last.shown, to: Math.max(last.to, call.to), secret: false, by: last.by, call: last.call };
    else bursts.push(call);
  }
  const typingPills = bursts.filter((burst) => !burst.secret).map((burst): KeyPill => ({ from: burst.shown, to: Math.max(burst.to + TYPING_AFTER_S, burst.shown + TYPING_LEAST_S), text: TYPING_WORDS, typing: true }));
  const pressed = keys.filter((each) => !(editsTyping(each.chord) && nearTyping(each.at))).sort((a, b) => a.at - b.at);
  const runs: { from: number; last: number; chord: KeyChord; count: number }[] = [];
  for (const each of pressed) {
    const run = runs.at(-1);
    if (run && sameChord(run.chord, each.chord) && each.at - run.last <= SAME_KEY_S) runs[runs.length - 1] = { ...run, last: each.at, count: run.count + 1 };
    else runs.push({ from: each.at, last: each.at, chord: each.chord, count: 1 });
  }
  const keyPills = runs.map((run): KeyPill => ({ from: run.from, to: run.last + KEY_SHOWN_S, text: `${chordWords(run.chord, style)}${run.count > 1 ? ` ×${run.count}` : ""}`, typing: false }));
  const pills = [...typingPills, ...keyPills].sort((a, b) => a.from - b.from);
  return pills.flatMap((pill, index): KeyPill[] => {
    const later = pills[index + 1];
    const to = Math.min(length, later ? Math.min(pill.to, later.from) : pill.to);
    return to - pill.from >= 0.2 ? [{ ...pill, from: round3(pill.from), to: round3(to) }] : [];
  });
}
