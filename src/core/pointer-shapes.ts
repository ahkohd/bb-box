import type { AgentPlace } from "./pointer.ts";
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

type OpenUntil = "moved" | "typed";

type HoldKind = "click" | "typing";

interface HeldShape {
  readonly kind: HoldKind;
  readonly openUntil: OpenUntil | null;
  readonly request: ShapeRequest;
}

export interface ShapeNow {
  readonly shape: ActionShape;
  readonly changesAt: number | null;
}

const PAST_KEPT_S = 10;
const REPLAY_PAST_S = 1;
const OPEN_MARGIN_S = 1;
const ORIGIN_LEAD_S = 3600;

function asActionShape(shape: PointerShape): ActionShape {
  return shape === "hand" || shape === "ibeam" ? shape : "arrow";
}

function msOf(seconds: number): number {
  return Math.round(seconds * 1000);
}

export class ShapeTimeline {
  #held: HeldShape[] = [];
  #place: { readonly x: number; readonly y: number } | null = null;
  readonly #origin: number;

  constructor(since: number) {
    this.#origin = since - ORIGIN_LEAD_S;
  }

  act(place: AgentPlace, at: number): void {
    const now = at - this.#origin;
    const moved = !this.#place || this.#place.x !== place.x || this.#place.y !== place.y;
    this.#place = { x: place.x, y: place.y };
    if (moved) this.#close("moved", (held) => clickHeld(asActionShape(held.request.shape), held.request.from, now));
    if (place.act === "typed") this.#close("typed", (held) => typingHeld(held.request.from, now));
    const from = now - (place.agoMs ?? 0) / 1000;
    const lasting = place.forMs === undefined ? null : place.forMs / 1000;
    if (place.act === "click" && place.shape) {
      const open = place.shape === "ibeam";
      const request = clickHeld(place.shape, now, open ? Infinity : now);
      if (request) this.#held.push({ kind: "click", openUntil: open ? "moved" : null, request });
    }
    if (place.act === "held" && place.shape) {
      const to = lasting === null ? Infinity : from + lasting;
      this.#held.push({ kind: "click", openUntil: lasting === null ? "moved" : null, request: { from, to, shape: place.shape, rank: CLICK_RANK } });
    }
    if (place.act === "typing" && lasting !== null) {
      this.#held.push({ kind: "typing", openUntil: null, request: { from, to: from + lasting, shape: "ibeam", rank: TYPING_RANK } });
    }
    if (place.act === "typing" && lasting === null && !this.#held.some((held) => held.openUntil === "typed")) {
      this.#held.push({ kind: "typing", openUntil: "typed", request: typingHeld(from, Infinity) });
    }
    this.#held = this.#held.filter((held) => held.openUntil || held.request.to > now - PAST_KEPT_S);
  }

  now(at: number): ShapeNow {
    const now = at - this.#origin;
    const spans = this.#spans(now);
    const next = spans.find((span) => span.from > now);
    return { shape: asActionShape(shapeAt(spans, now)), changesAt: next ? next.from + this.#origin : null };
  }

  replay(at: number): AgentPlace[] {
    const place = this.#place;
    if (!place) return [];
    const now = at - this.#origin;
    return this.#held
      .filter((held) => held.openUntil || held.request.to > now - REPLAY_PAST_S)
      .map((held): AgentPlace => {
        const { from, to, shape } = held.request;
        const lasting = held.openUntil ? {} : { forMs: msOf(to - from) };
        const ago = { agoMs: msOf(now - from) };
        return held.kind === "typing" ? { act: "typing", ...place, ...ago, ...lasting } : { act: "held", ...place, shape: shape === "hand" ? "hand" : "ibeam", ...ago, ...lasting };
      });
  }

  #close(until: OpenUntil, closed: (held: HeldShape) => ShapeRequest | null): void {
    this.#held = this.#held.flatMap((held) => {
      if (held.openUntil !== until) return [held];
      const request = closed(held);
      return request ? [{ ...held, openUntil: null, request }] : [];
    });
  }

  #spans(now: number): ShapeSpan[] {
    const horizon = Math.max(now, ...this.#held.map((held) => held.request.to).filter(Number.isFinite)) + OPEN_MARGIN_S;
    return resolveShapes(
      this.#held.map((held) => ({ ...held.request, to: Math.min(held.request.to, horizon) })),
      horizon,
    );
  }
}
