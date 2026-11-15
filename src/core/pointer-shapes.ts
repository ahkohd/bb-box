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

function holdStep(out: ShapeSpan[], piece: ShapeSpan, firmEnds: readonly number[]): void {
  const last = out.at(-1);
  if (!last) {
    out.push({ ...piece });
    return;
  }
  if (last.shape === piece.shape) {
    out[out.length - 1] = { ...last, to: piece.to };
    return;
  }
  const endsFirmly = firmEnds.some((at) => Math.abs(at - last.to) < FIRM_END_S);
  if (!(last.from === 0 && last.shape === "arrow") && !endsFirmly && last.to - last.from < SHAPE_HOLD_S) {
    const until = Math.min(piece.to, last.from + SHAPE_HOLD_S);
    out[out.length - 1] = { ...last, to: until };
    if (until < piece.to) out.push({ ...piece, from: until });
    return;
  }
  out.push({ ...piece });
}

function heldShapes(pieces: readonly ShapeSpan[], firmEnds: readonly number[]): ShapeSpan[] {
  const out: ShapeSpan[] = [];
  for (const piece of pieces) holdStep(out, piece, firmEnds);
  return out.map((span) => ({ from: round3(span.from), to: round3(span.to), shape: span.shape }));
}

function winner(requests: readonly ShapeRequest[], at: number): PointerShape {
  return requests.filter((request) => request.from <= at && at < request.to).sort((a, b) => b.rank - a.rank || b.from - a.from)[0]?.shape ?? "arrow";
}

export function resolveShapes(requests: readonly ShapeRequest[], length: number, firmEnds: readonly number[] = []): ShapeSpan[] {
  const marks = [...new Set([0, length, ...requests.flatMap((request) => [request.from, request.to])].filter((time) => time >= 0 && time <= length).map((time) => round3(time)))].sort((a, b) => a - b);
  const pieces: ShapeSpan[] = [];
  for (let index = 0; index < marks.length - 1; index++) {
    const from = marks[index]!;
    const to = marks[index + 1]!;
    if (to <= from) continue;
    const shape = winner(requests, (from + to) / 2);
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

export type LiveAct =
  | { readonly act: "click"; readonly x: number; readonly y: number; readonly shape: ActionShape }
  | { readonly act: "scroll" | "typing" | "typed"; readonly x: number; readonly y: number };

export interface LiveShapeNow {
  readonly shape: ActionShape;
  readonly changesAt: number | null;
}

type OpenUntil = "moved" | "typed";

interface LiveHold {
  readonly openUntil: OpenUntil | null;
  readonly request: ShapeRequest;
}

const OPEN_MARGIN_S = 1;
const REACHED_WITHIN_S = 1e-6;

function asActionShape(shape: PointerShape): ActionShape {
  return shape === "hand" || shape === "ibeam" ? shape : "arrow";
}

function piecesBetween(requests: readonly ShapeRequest[], from: number, to: number): ShapeSpan[] {
  const marks = [...new Set([from, to, ...requests.flatMap((request) => [request.from, request.to]).filter((time) => time > from && time < to)])].sort((a, b) => a - b);
  const pieces: ShapeSpan[] = [];
  for (let index = 0; index < marks.length - 1; index++) {
    const start = marks[index]!;
    const end = marks[index + 1]!;
    const shape = winner(requests, (start + end) / 2);
    const last = pieces.at(-1);
    if (last && last.shape === shape) pieces[pieces.length - 1] = { ...last, to: end };
    else pieces.push({ from: start, to: end, shape });
  }
  return pieces;
}

function outranks(newer: ShapeRequest, older: ShapeRequest): boolean {
  return newer.rank === older.rank && newer.shape === older.shape && newer.from >= older.from && newer.to >= older.to;
}

export class LiveShape {
  #holds: LiveHold[] = [];
  #last: ShapeSpan = { from: 0, to: 0, shape: "arrow" };
  #resolvedTo = 0;
  #place: { readonly x: number; readonly y: number } | null = null;
  readonly #origin: number;

  constructor(since: number) {
    this.#origin = since;
  }

  get holdsKept(): number {
    return this.#holds.length;
  }

  act(act: LiveAct, at: number): void {
    const now = Math.max(this.#resolvedTo, at - this.#origin);
    this.#resolve(now);
    const moved = !this.#place || this.#place.x !== act.x || this.#place.y !== act.y;
    this.#place = { x: act.x, y: act.y };
    if (moved) this.#close("moved", (request) => clickHeld(asActionShape(request.shape), request.from, now));
    if (act.act === "typed") this.#close("typed", (request) => typingHeld(request.from, now));
    if (act.act === "click") {
      const open = act.shape === "ibeam";
      const request = clickHeld(act.shape, now, open ? Infinity : now);
      if (request) this.#hold({ openUntil: open ? "moved" : null, request });
    }
    if (act.act === "typing" && !this.#holds.some((hold) => hold.openUntil === "typed")) this.#hold({ openUntil: "typed", request: typingHeld(now, Infinity) });
  }

  now(at: number): LiveShapeNow {
    const now = Math.max(this.#resolvedTo, at - this.#origin) + REACHED_WITHIN_S;
    const spans = this.#ahead(now);
    const next = spans.find((span) => span.from > now);
    return { shape: asActionShape(shapeAt(spans, now)), changesAt: next ? next.from + this.#origin : null };
  }

  #hold(hold: LiveHold): void {
    this.#holds = [...this.#holds, hold];
    this.#compact();
  }

  #compact(): void {
    const holds = this.#holds;
    this.#holds = holds.filter((hold, index) => !holds.some((other, at) => at !== index && outranks(other.request, hold.request) && (other.request.from > hold.request.from || at > index)));
  }

  #close(until: OpenUntil, closed: (request: ShapeRequest) => ShapeRequest | null): void {
    this.#holds = this.#holds.flatMap((hold) => {
      if (hold.openUntil !== until) return [hold];
      const request = closed(hold.request);
      return request ? [{ openUntil: null, request }] : [];
    });
    this.#compact();
  }

  #resolve(now: number): void {
    if (now <= this.#resolvedTo) return;
    const out = [this.#last];
    for (const piece of piecesBetween(this.#requests(now), this.#resolvedTo, now)) holdStep(out, piece, []);
    this.#last = out.at(-1)!;
    this.#resolvedTo = now;
    this.#holds = this.#holds.filter((hold) => hold.request.to > now);
  }

  #requests(horizon: number): ShapeRequest[] {
    return this.#holds.map((hold) => ({ ...hold.request, to: Math.min(hold.request.to, horizon) }));
  }

  #ahead(now: number): ShapeSpan[] {
    const horizon = Math.max(now, this.#last.to, ...this.#holds.map((hold) => hold.request.to).filter(Number.isFinite)) + OPEN_MARGIN_S;
    const out = [this.#last];
    for (const piece of piecesBetween(this.#requests(horizon), this.#resolvedTo, horizon)) holdStep(out, piece, []);
    return out;
  }
}
