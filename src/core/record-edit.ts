import type { PlacedKeys } from "./record-keys.ts";
import type { Scene, Span } from "./record-motion.ts";

export const IDLE_LEAST_S = 1;
export const IDLE_KEPT_S = 0.5;
export const IDLE_LEAD_S = 0.25;
export const QUIET_CHANGE_SHARE = 0.003;

const round3 = (value: number) => Math.round(value * 1000) / 1000;

function changedArea(change: { readonly width: number; readonly height: number }): number {
  return Math.max(0, change.width) * Math.max(0, change.height);
}

export function activityMoments(scene: Scene, keys: readonly PlacedKeys[], captions: readonly number[]): number[] {
  const quietMost = scene.width * scene.height * QUIET_CHANGE_SHARE;
  const pointerMoves = scene.samples.slice(1).map((sample) => sample.at);
  return [
    ...captions,
    ...pointerMoves,
    ...scene.clicks.map((click) => click.at),
    ...scene.scrolls.map((scroll) => scroll.at),
    ...scene.typing.map((typing) => typing.at),
    ...keys.map((each) => each.at),
    ...scene.changes.filter((change) => changedArea(change) > quietMost).map((change) => change.at),
  ]
    .filter((at) => Number.isFinite(at) && at >= 0 && at <= scene.length)
    .sort((a, b) => a - b);
}

export function idleStretches(moments: readonly number[], length: number): Span[] {
  const marks = [0, ...moments, length];
  const idle: Span[] = [];
  for (let index = 1; index < marks.length; index++) {
    const before = marks[index - 1]!;
    const after = marks[index]!;
    if (after - before <= IDLE_LEAST_S) continue;
    const from = before + IDLE_KEPT_S;
    const to = index === marks.length - 1 ? after : after - IDLE_LEAD_S;
    if (to > from) idle.push({ from: round3(from), to: round3(to) });
  }
  return idle;
}
