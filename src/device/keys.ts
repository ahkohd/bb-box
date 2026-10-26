export const MODIFIER_KEYS = ["Shift", "Control", "Alt", "Meta"] as const;
export type ModifierKey = (typeof MODIFIER_KEYS)[number];

export interface UsKey {
  readonly code: string;
  readonly shift: boolean;
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "1234567890";
const SHIFTED_DIGITS = "!@#$%^&*()";
const PUNCTUATION: readonly (readonly [string, string, string])[] = [
  ["Minus", "-", "_"],
  ["Equal", "=", "+"],
  ["BracketLeft", "[", "{"],
  ["BracketRight", "]", "}"],
  ["Backslash", "\\", "|"],
  ["Semicolon", ";", ":"],
  ["Quote", "'", '"'],
  ["Backquote", "`", "~"],
  ["Comma", ",", "<"],
  ["Period", ".", ">"],
  ["Slash", "/", "?"],
];

const NAMED_CODES: Readonly<Record<string, string>> = {
  Enter: "Enter",
  Escape: "Escape",
  Backspace: "Backspace",
  Tab: "Tab",
  " ": "Space",
  CapsLock: "CapsLock",
  Insert: "Insert",
  Home: "Home",
  PageUp: "PageUp",
  Delete: "Delete",
  End: "End",
  PageDown: "PageDown",
  ArrowRight: "ArrowRight",
  ArrowLeft: "ArrowLeft",
  ArrowDown: "ArrowDown",
  ArrowUp: "ArrowUp",
  Shift: "ShiftLeft",
  Control: "ControlLeft",
  Alt: "AltLeft",
  Meta: "MetaLeft",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`F${index + 1}`, `F${index + 1}`])),
};

const US_KEYS: ReadonlyMap<string, UsKey> = new Map<string, UsKey>([
  ...[...LETTERS].flatMap((letter): [string, UsKey][] => [
    [letter, { code: `Key${letter.toUpperCase()}`, shift: false }],
    [letter.toUpperCase(), { code: `Key${letter.toUpperCase()}`, shift: true }],
  ]),
  ...[...DIGITS].flatMap((digit, index): [string, UsKey][] => [
    [digit, { code: `Digit${digit}`, shift: false }],
    [SHIFTED_DIGITS[index]!, { code: `Digit${digit}`, shift: true }],
  ]),
  ...PUNCTUATION.flatMap(([code, plain, shifted]): [string, UsKey][] => [
    [plain, { code, shift: false }],
    [shifted, { code, shift: true }],
  ]),
  ...Object.entries(NAMED_CODES).map(([key, code]): [string, UsKey] => [key, { code, shift: false }]),
]);

export function usKey(key: string): UsKey | null {
  return US_KEYS.get(key) ?? null;
}

export function typedOnUsKeyboard(character: string): boolean {
  return character === "\n" || character === "\t" || (character.length === 1 && US_KEYS.has(character) && character >= " " && character <= "~");
}

export function keyOfCharacter(character: string): string {
  return character === "\n" ? "Enter" : character === "\t" ? "Tab" : character;
}

export function isModifierKey(key: string): key is ModifierKey {
  return (MODIFIER_KEYS as readonly string[]).includes(key);
}

export type KeysymMeaning = { readonly is: "key"; readonly key: string } | { readonly is: "text"; readonly text: string } | { readonly is: "ignored" };

const NAMED_KEYSYMS: ReadonlyMap<number, string> = new Map<number, string>([
  [0xff08, "Backspace"],
  [0xff09, "Tab"],
  [0xff0d, "Enter"],
  [0xff8d, "Enter"],
  [0xff1b, "Escape"],
  [0xffff, "Delete"],
  [0xff9f, "Delete"],
  [0xff50, "Home"],
  [0xff51, "ArrowLeft"],
  [0xff52, "ArrowUp"],
  [0xff53, "ArrowRight"],
  [0xff54, "ArrowDown"],
  [0xff55, "PageUp"],
  [0xff56, "PageDown"],
  [0xff57, "End"],
  [0xff63, "Insert"],
  [0xffe1, "Shift"],
  [0xffe2, "Shift"],
  [0xffe3, "Control"],
  [0xffe4, "Control"],
  [0xffe5, "CapsLock"],
  [0xffe7, "Meta"],
  [0xffe8, "Meta"],
  [0xffeb, "Meta"],
  [0xffec, "Meta"],
  [0xffe9, "Alt"],
  [0xffea, "Alt"],
  [0xff7e, "Alt"],
  [0xfe03, "Alt"],
  ...Array.from({ length: 12 }, (_, index): [number, string] => [0xffbe + index, `F${index + 1}`]),
  ...Array.from({ length: 10 }, (_, index): [number, string] => [0xffb0 + index, String(index)]),
]);

const UNICODE_KEYSYM = 0x1000000;

export function keysymMeaning(keysym: number): KeysymMeaning {
  const named = NAMED_KEYSYMS.get(keysym);
  if (named) return { is: "key", key: named };
  const codePoint = keysym >= UNICODE_KEYSYM && keysym <= UNICODE_KEYSYM + 0x10ffff ? keysym - UNICODE_KEYSYM : keysym >= 0x20 && keysym <= 0xff && keysym !== 0x7f ? keysym : null;
  if (codePoint === null) return { is: "ignored" };
  const character = String.fromCodePoint(codePoint);
  return typedOnUsKeyboard(character) ? { is: "key", key: character } : { is: "text", text: character };
}
