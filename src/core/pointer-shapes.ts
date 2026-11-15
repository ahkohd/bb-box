import type { PointerShape } from "./record-cursors.ts";
import { TYPING_AFTER_S, TYPING_LEAST_S } from "./record-keys.ts";

export const SHAPE_HOLD_S = 0.3;
export const TYPING_TAIL_S = Math.max(TYPING_AFTER_S, TYPING_LEAST_S);

export type ActionShape = "arrow" | "hand" | "ibeam";

export const ACTION_SHAPES: readonly ActionShape[] = ["arrow", "hand", "ibeam"];

export const CURSOR_HOTSPOTS: Readonly<Record<ActionShape, readonly [number, number]>> = { arrow: [8.4, 8.4], hand: [12.3, 5.5], ibeam: [16, 16] };

const DRAG_RANK = 3;
const CLICK_RANK = 2;
const TYPING_RANK = 1;
const FIRM_END_S = 0.002;

export interface ShapeSpan {
  readonly from: number;
  readonly to: number;
  readonly shape: PointerShape;
}

export interface ShapeRequest {
  readonly from: number;
  readonly to: number;
  readonly shape: PointerShape;
  readonly rank: number;
}

export interface TypedText {
  readonly characters: number;
  readonly secret: boolean;
  readonly role?: string | null;
}

export function textField(role: string | null | undefined): boolean {
  return !!role && (/^(?:text|entry|edit)$/i.test(role) || /textbox|searchbox|textarea|textfield|text field|editable|\bentry\b|\bedit\b/i.test(role));
}

function buttonOrLink(role: string | null | undefined): boolean {
  return !!role && /button|link/i.test(role);
}

export function dividerRole(role: string | null | undefined): boolean {
  return !!role && /separator|splitter|divider/i.test(role);
}

export function clickShape(role: string | null | undefined): ActionShape {
  if (textField(role)) return "ibeam";
  if (buttonOrLink(role)) return "hand";
  return "arrow";
}

export function typingShape(typing: TypedText): ActionShape {
  return !typing.secret && typing.characters > 0 && textField(typing.role) ? "ibeam" : "arrow";
}

export function clickHeld(shape: ActionShape, at: number, movedAt: number): ShapeRequest | null {
  if (shape === "arrow") return null;
  const to = shape === "ibeam" ? Math.max(at + SHAPE_HOLD_S, movedAt) : at + SHAPE_HOLD_S;
  return { from: at, to, shape, rank: CLICK_RANK };
}

export function typingHeld(from: number, to: number): ShapeRequest {
  return { from, to: Math.max(to + TYPING_TAIL_S, from + SHAPE_HOLD_S), shape: "ibeam", rank: TYPING_RANK };
}

export function dragHeld(from: number, to: number, shape: PointerShape): ShapeRequest {
  return { from, to: Math.max(to, from + SHAPE_HOLD_S), shape, rank: DRAG_RANK };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function heldShapes(pieces: readonly ShapeSpan[], firmEnds: readonly number[]): ShapeSpan[] {
  const out: ShapeSpan[] = [];
  for (const piece of pieces) {
    const last = out.at(-1);
    if (!last) {
      out.push({ ...piece });
      continue;
    }
    if (last.shape === piece.shape) {
      out[out.length - 1] = { ...last, to: piece.to };
      continue;
    }
    const endsFirmly = firmEnds.some((at) => Math.abs(at - last.to) < FIRM_END_S);
    if (!(last.from === 0 && last.shape === "arrow") && !endsFirmly && last.to - last.from < SHAPE_HOLD_S) {
      const until = Math.min(piece.to, last.from + SHAPE_HOLD_S);
      out[out.length - 1] = { ...last, to: until };
      if (until < piece.to) out.push({ ...piece, from: until });
      continue;
    }
    out.push({ ...piece });
  }
  return out.map((span) => ({ from: round3(span.from), to: round3(span.to), shape: span.shape }));
}

export function resolveShapes(requests: readonly ShapeRequest[], length: number, firmEnds: readonly number[] = []): ShapeSpan[] {
  const marks = [...new Set([0, length, ...requests.flatMap((request) => [request.from, request.to])].filter((time) => time >= 0 && time <= length).map((time) => round3(time)))].sort((a, b) => a - b);
  const pieces: ShapeSpan[] = [];
  for (let index = 0; index < marks.length - 1; index++) {
    const from = marks[index]!;
    const to = marks[index + 1]!;
    if (to <= from) continue;
    const mid = (from + to) / 2;
    const active = requests.filter((request) => request.from <= mid && mid < request.to).sort((a, b) => b.rank - a.rank || b.from - a.from);
    const shape = active[0]?.shape ?? "arrow";
    const last = pieces.at(-1);
    if (last && last.shape === shape) pieces[pieces.length - 1] = { ...last, to };
    else pieces.push({ from, to, shape });
  }
  if (!pieces.length) return [{ from: 0, to: round3(length), shape: "arrow" }];
  return heldShapes(pieces, firmEnds);
}

export function shapeAt(spans: readonly ShapeSpan[], t: number): PointerShape {
  return (spans.find((span) => t >= span.from && t < span.to) ?? spans.at(-1))?.shape ?? "arrow";
}
