import type { KeyChord, Modifier } from "./record-input.ts";

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
}

export interface KeyPill {
  readonly from: number;
  readonly to: number;
  readonly text: string;
  readonly typing: boolean;
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

export function planKeyPills(keys: readonly PlacedKeys[], typing: readonly PlacedKeyTyping[], style: KeyStyle, length: number): KeyPill[] {
  const typed = [...typing].sort((a, b) => a.at - b.at);
  const nearTyping = (at: number) => typed.some((each) => Math.abs(each.at - at) <= TYPING_GAP_S);
  const edits = keys.filter((each) => editsTyping(each.chord) && nearTyping(each.at)).map((each) => ({ at: each.at, secret: false }));
  const bursts: { from: number; to: number; secret: boolean }[] = [];
  for (const each of [...typed, ...edits].sort((a, b) => a.at - b.at)) {
    const last = bursts.at(-1);
    if (last && each.at - last.to <= TYPING_GAP_S) bursts[bursts.length - 1] = { ...last, to: each.at, secret: last.secret || each.secret };
    else bursts.push({ from: each.at, to: each.at, secret: each.secret });
  }
  const typingPills = bursts.filter((burst) => !burst.secret).map((burst): KeyPill => ({ from: burst.from, to: Math.max(burst.to + TYPING_AFTER_S, burst.from + TYPING_LEAST_S), text: TYPING_WORDS, typing: true }));
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
