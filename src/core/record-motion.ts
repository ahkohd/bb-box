import type { PointerShape } from "./record-cursors.ts";
import type { InputArea, InputSource, MouseButton } from "./record-input.ts";
import { TYPING_AFTER_S, TYPING_GAP_S, TYPING_LEAST_S } from "./record-keys.ts";

export const CLIP_FPS = 30;
export const GLIDE_S = 0.5;
export const JUMP_PX = 24;
export const SMOOTHING_FRAMES = 5;
export const SAMPLE_S = 1 / 30;
export const SAME_MOVE_S = 0.4;
export const SAME_MOVE_PX = 48;
export const RING_STAGES = 6;
export const RING_FRAMES_PER_STAGE = 2;
export const RING_S = (RING_STAGES * RING_FRAMES_PER_STAGE) / CLIP_FPS;
export const DOUBLE_RING_GAP_S = 0.12;
export const CLICK_MOST_S = 0.25;
export const CLICK_MOVE_PX = 6;
export const DOUBLE_CLICK_S = 0.4;
export const SAME_CLICK_S = 0.3;
export const SAME_CLICK_PX = 40;

export const ZOOM_MOST = 2;
export const ZOOM_LEAST = 1.3;
export const ZOOM_POINT = 1.8;
export const GROUP_GAP_S = 3;
export const MOVE_S = 0.9;
export const SETTLE_S = 0.15;
export const LINGER_S = 1.5;
export const PAN_INSTEAD_S = 0.6;
export const BIG_CHANGE_SHARE = 0.4;
export const OUTSIDE_CHANGE_SHARE = 0.1;
export const OUTSIDE_SEEN_S = 1.5;
export const OWN_RESULT_S = 0.5;
export const ZOOM_SEEN_LEAST_S = 0.6;
const CARET_LINE_PX = 36;
const CARET_BAND_PX = 640;

export interface PointerSample {
  readonly at: number;
  readonly x: number;
  readonly y: number;
  readonly buttons: number;
}

export interface PlacedClick {
  readonly at: number;
  readonly x: number;
  readonly y: number;
  readonly button: MouseButton;
  readonly count: 1 | 2;
  readonly area: InputArea | null;
  readonly role?: string | null;
  readonly window?: InputArea | null;
}

export interface PlacedScroll {
  readonly at: number;
  readonly x: number;
  readonly y: number;
  readonly window?: InputArea | null;
}

export interface PlacedTyping {
  readonly at: number;
  readonly characters: number;
  readonly area: InputArea | null;
  readonly secret: boolean;
  readonly role?: string | null;
  readonly window?: InputArea | null;
  readonly by?: InputSource;
  readonly call?: number;
}

export interface ChangedRegion extends InputArea {
  readonly at: number;
}

export interface BrightnessSample {
  readonly at: number;
  readonly cells: readonly number[];
}

export interface Scene {
  readonly width: number;
  readonly height: number;
  readonly length: number;
  readonly samples: readonly PointerSample[];
  readonly clicks: readonly PlacedClick[];
  readonly scrolls: readonly PlacedScroll[];
  readonly typing: readonly PlacedTyping[];
  readonly changes: readonly ChangedRegion[];
  readonly brightness?: readonly BrightnessSample[];
  readonly agentCursor?: boolean;
}

export interface PointerFrame {
  readonly x: number;
  readonly y: number;
}

export interface Ring {
  readonly at: number;
  readonly x: number;
  readonly y: number;
  readonly kind: "left" | "right";
}

export interface Span {
  readonly from: number;
  readonly to: number;
}

export interface PointerPlan {
  readonly frames: readonly PointerFrame[];
  readonly visibleFrom: number | null;
  readonly rings: readonly Ring[];
  readonly drags: readonly Span[];
  readonly glides: readonly Span[];
}

interface Keyframe {
  readonly at: number;
  readonly x: number;
  readonly y: number;
  readonly jump: boolean;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

export function bezierEase(x1: number, y1: number, x2: number, y2: number): (u: number) => number {
  const at = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  const slope = (a: number, b: number, s: number) => 3 * a * (1 - s) ** 2 + 6 * (b - a) * s * (1 - s) + 3 * (1 - b) * s * s;
  return (u) => {
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    let s = u;
    for (let step = 0; step < 8; step++) {
      const gap = at(x1, x2, s) - u;
      const tangent = slope(x1, x2, s);
      if (Math.abs(gap) < 1e-6) break;
      if (Math.abs(tangent) < 1e-6) {
        let low = 0;
        let high = 1;
        s = u;
        for (let half = 0; half < 30; half++) {
          if (at(x1, x2, s) < u) low = s;
          else high = s;
          s = (low + high) / 2;
        }
        break;
      }
      s = Math.min(1, Math.max(0, s - gap / tangent));
    }
    return at(y1, y2, s);
  };
}

export const glideEase = bezierEase(0.23, 1, 0.32, 1);

export function easeInOutCubic(u: number): number {
  const v = Math.min(1, Math.max(0, u));
  return v < 0.5 ? 4 * v * v * v : 1 - (-2 * v + 2) ** 3 / 2;
}

function pointerKeyframes(scene: Scene): Keyframe[] {
  const acts = scene.agentCursor ? [] : [...scene.clicks.map((click) => ({ at: click.at, x: click.x, y: click.y })), ...scene.scrolls.map((scroll) => ({ at: scroll.at, x: scroll.x, y: scroll.y }))];
  const sameMove = (sample: PointerSample) => acts.some((act) => Math.abs(act.at - sample.at) <= SAME_MOVE_S && distance(act, sample) <= SAME_MOVE_PX);
  const real = scene.samples.filter((sample, index) => index === 0 || !sameMove(sample)).map((sample) => ({ at: sample.at, x: sample.x, y: sample.y, act: false }));
  const all = [...real, ...acts.map((act) => ({ ...act, act: true }))].sort((a, b) => a.at - b.at);
  return all.map((point, index): Keyframe => {
    const before = all[index - 1];
    const far = !!before && distance(before, point) > JUMP_PX;
    const gap = before ? point.at - before.at : 0;
    return { at: point.at, x: point.x, y: point.y, jump: !!before && far && (point.act || gap > 2 / CLIP_FPS) };
  });
}

function glideStart(keyframes: readonly Keyframe[], index: number): number {
  const keyframe = keyframes[index]!;
  const before = keyframes[index - 1];
  return before ? Math.max(before.at, keyframe.at - GLIDE_S) : keyframe.at;
}

function frameCount(length: number): number {
  return Math.max(1, Math.round(length * CLIP_FPS) + 1);
}

export function planPointer(scene: Scene): PointerPlan {
  const keyframes = pointerKeyframes(scene);
  const count = frameCount(scene.length);
  if (!keyframes.length) return { frames: [], visibleFrom: null, rings: ringsOf(scene, []), drags: [], glides: [] };
  const glides: Span[] = keyframes.flatMap((keyframe, index) => (keyframe.jump ? [{ from: round3(glideStart(keyframes, index)), to: round3(keyframe.at) }] : []));
  const raw: { x: number; y: number; gliding: boolean }[] = [];
  let next = 0;
  for (let frame = 0; frame < count; frame++) {
    const t = frame / CLIP_FPS;
    while (next < keyframes.length && keyframes[next]!.at <= t) next++;
    const after = keyframes[next];
    const before = keyframes[next - 1];
    if (!before) {
      raw.push({ x: keyframes[0]!.x, y: keyframes[0]!.y, gliding: false });
      continue;
    }
    if (!after) {
      raw.push({ x: before.x, y: before.y, gliding: false });
      continue;
    }
    if (after.jump) {
      const from = glideStart(keyframes, next);
      const u = t <= from ? 0 : glideEase((t - from) / Math.max(1e-6, after.at - from));
      raw.push({ x: before.x + (after.x - before.x) * u, y: before.y + (after.y - before.y) * u, gliding: t > from });
      continue;
    }
    const from = Math.max(before.at, after.at - SAMPLE_S);
    const u = t <= from ? 0 : (t - from) / Math.max(1e-6, after.at - from);
    raw.push({ x: before.x + (after.x - before.x) * u, y: before.y + (after.y - before.y) * u, gliding: false });
  }
  const half = Math.floor(SMOOTHING_FRAMES / 2);
  const frames = raw.map((point, index): PointerFrame => {
    if (point.gliding) return { x: Math.round(point.x), y: Math.round(point.y) };
    const window = raw.slice(Math.max(0, index - half), index + half + 1).filter((each) => !each.gliding);
    const x = window.reduce((sum, each) => sum + each.x, 0) / window.length;
    const y = window.reduce((sum, each) => sum + each.y, 0) / window.length;
    return { x: Math.round(x), y: Math.round(y) };
  });
  const first = keyframes[0]!;
  const sampledFromStart = scene.samples.length > 0 && scene.samples[0]!.at <= first.at;
  const moved = keyframes.find((keyframe) => keyframe.x !== first.x || keyframe.y !== first.y);
  const visibleFrom = scene.agentCursor ? (moved ? round3(Math.max(0, moved.at - SAMPLE_S)) : null) : sampledFromStart ? 0 : round3(Math.max(0, first.at - GLIDE_S));
  const presses = pressesOf(scene.samples);
  const sampled = presses.filter((press) => !press.drag).map((press) => ({ at: press.from, x: press.x, y: press.y, button: press.button, count: 1 as const, area: null }));
  return { frames, visibleFrom, rings: ringsOf(scene, sampled), drags: presses.filter((press) => press.drag).map((press) => ({ from: round3(press.from), to: round3(press.to) })), glides };
}

interface Press {
  readonly from: number;
  readonly to: number;
  readonly x: number;
  readonly y: number;
  readonly button: MouseButton;
  readonly drag: boolean;
}

function buttonOf(buttons: number): MouseButton {
  if (buttons & 1) return "left";
  if (buttons & 4) return "right";
  return "middle";
}

export function pressesOf(samples: readonly PointerSample[]): Press[] {
  const presses: Press[] = [];
  let open: { from: number; x: number; y: number; buttons: number; moved: number } | null = null;
  let resting = false;
  const finish = (to: number) => {
    if (!open) return;
    const drag = open.moved > CLICK_MOVE_PX;
    presses.push({ from: open.from, to: drag ? to : open.from, x: open.x, y: open.y, button: buttonOf(open.buttons), drag });
    open = null;
  };
  for (const sample of samples) {
    if (resting) {
      if (!sample.buttons) resting = false;
      continue;
    }
    if (open && !sample.buttons) {
      finish(sample.at);
      continue;
    }
    if (open) {
      open.moved = Math.max(open.moved, distance(open, sample));
      if (open.moved <= CLICK_MOVE_PX && sample.at - open.from > CLICK_MOST_S) {
        finish(open.from);
        resting = true;
      }
      continue;
    }
    if (sample.buttons) open = { from: sample.at, x: sample.x, y: sample.y, buttons: sample.buttons, moved: 0 };
  }
  if (open) finish(samples.at(-1)!.at);
  return presses;
}

function ringsOf(scene: Scene, sampled: readonly PlacedClick[]): Ring[] {
  const acted = scene.clicks;
  const fromSamples = sampled.filter((click) => !acted.some((act) => Math.abs(act.at - click.at) <= SAME_CLICK_S && distance(act, click) <= SAME_CLICK_PX));
  const merged: PlacedClick[] = [];
  for (const click of [...fromSamples].sort((a, b) => a.at - b.at)) {
    const last = merged.at(-1);
    if (last && last.count === 1 && last.button === click.button && click.at - last.at <= DOUBLE_CLICK_S && distance(last, click) <= CLICK_MOVE_PX) merged[merged.length - 1] = { ...last, count: 2 };
    else merged.push(click);
  }
  const clicks = [...acted, ...merged].sort((a, b) => a.at - b.at);
  return clicks.flatMap((click): Ring[] => {
    const kind = click.button === "right" ? "right" : "left";
    const ring = { at: round3(click.at), x: Math.round(click.x), y: Math.round(click.y), kind } as const;
    return click.count === 2 ? [ring, { ...ring, at: round3(click.at + DOUBLE_RING_GAP_S) }] : [ring];
  });
}

export interface View {
  readonly zoom: number;
  readonly x: number;
  readonly y: number;
}

export interface CameraKey {
  readonly at: number;
  readonly view: View;
}

interface Focus {
  readonly at: number;
  readonly area: InputArea;
  readonly contain: boolean;
  readonly fieldClickAt?: number;
}

export const FIELD_TYPING_S = 2;

const pointArea = (x: number, y: number): InputArea => ({ x, y, width: 0, height: 0 });

function unionOf(areas: readonly InputArea[]): InputArea {
  const left = Math.min(...areas.map((area) => area.x));
  const top = Math.min(...areas.map((area) => area.y));
  const right = Math.max(...areas.map((area) => area.x + area.width));
  const bottom = Math.max(...areas.map((area) => area.y + area.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function areaOf(region: InputArea): number {
  return Math.max(0, region.width) * Math.max(0, region.height);
}

function overlap(a: InputArea, b: InputArea): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function foreignTyping(typing: PlacedTyping, each: PlacedTyping): boolean {
  if (typing.call !== undefined && each.call !== undefined && typing.call !== each.call) return true;
  if (typing.by && each.by && typing.by !== each.by) return true;
  return false;
}

export function typingSpan(typing: PlacedTyping, all: readonly PlacedTyping[]): { readonly from: number; readonly to: number } {
  if (!typing.characters) return { from: typing.at, to: typing.at };
  const later = all.filter((each) => each.at > typing.at + 1e-6).sort((a, b) => a.at - b.at);
  let to = typing.at;
  for (const each of later) {
    if (foreignTyping(typing, each)) break;
    if (each.characters === 0) return { from: typing.at, to: each.at };
    if (each.at - to > TYPING_GAP_S) break;
    to = each.at;
  }
  return { from: typing.at, to: typing.at };
}

export function typingFocus(scene: Scene, typing: PlacedTyping, pointer: PointerPlan): InputArea | null {
  if (typing.secret || !typing.characters) return null;
  const span = typingSpan(typing, scene.typing);
  const within = (change: InputArea) => {
    if (typing.area && overlap(change, typing.area) > 0) return true;
    if (!typing.area && typing.window && overlap(change, typing.window) > 0) return true;
    return !typing.area && !typing.window;
  };
  const near = scene.changes.filter((change) => change.at >= span.from - 0.3 && change.at <= span.to + 0.5 && within(change) && areaOf(change) > 0 && !fieldRepaint(change, typing.area));
  const inField = near.map((change) => (typing.area && areaOf(typing.area) > 0 ? intersectionOf(change, typing.area) : change)).filter((area): area is InputArea => !!area && areaOf(area) > 0);
  if (inField.length) return unionOf(inField);
  const field = typing.area && areaOf(typing.area) > 0 ? typing.area : null;
  if (field && viewContaining(scene, field).zoom >= ZOOM_LEAST) return field;
  return caretLine(scene, field, pointer, span.to);
}

function intersectionOf(a: InputArea, b: InputArea): InputArea | null {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

function clickInFieldBefore(scene: Scene, typing: PlacedTyping): PlacedClick | null {
  const field = typing.area;
  if (!field || areaOf(field) <= 0) return null;
  const inField = (click: PlacedClick) => (click.area && areaOf(click.area) > 0 ? overlap(click.area, field) > 0 : coversPoint(field, click.x, click.y, 0));
  const clicks = scene.clicks.filter((click) => click.at <= typing.at && typing.at - click.at <= FIELD_TYPING_S && inField(click));
  return clicks.at(-1) ?? null;
}

function fieldRepaint(change: InputArea, field: InputArea | null | undefined): boolean {
  if (change.height <= CARET_LINE_PX * 3) return false;
  if (!field || areaOf(field) <= 0) return true;
  return overlap(change, field) > areaOf(field) / 2;
}

function caretLine(scene: Scene, field: InputArea | null, pointer: PointerPlan, at: number): InputArea | null {
  const frame = pointer.frames[Math.min(pointer.frames.length - 1, Math.max(0, Math.round(at * CLIP_FPS)))];
  if (!frame) return field;
  if (!field) return pointArea(frame.x, frame.y);
  const height = Math.min(CARET_LINE_PX, field.height);
  const y = Math.min(field.y + Math.max(0, field.height - height), Math.max(field.y, frame.y - height / 2));
  const width = Math.min(field.width, CARET_BAND_PX);
  const x = Math.min(field.x + Math.max(0, field.width - width), Math.max(field.x, frame.x - width / 2));
  return { x, y, width, height };
}

export function pillRegion(scene: Scene, pointer: PointerPlan, from: number, to: number): InputArea | null {
  const regions: InputArea[] = [];
  for (const typing of scene.typing) {
    if (!typing.characters || typing.secret) continue;
    const span = typingSpan(typing, scene.typing);
    if (to < span.from - 0.2 || from > span.to + 1.2) continue;
    const focus = typingFocus(scene, typing, pointer);
    if (focus && areaOf(focus) > 0) regions.push(focus);
  }
  if (regions.length) return unionOf(regions);
  const clicked = scene.clicks.filter((click) => click.area && areaOf(click.area) > 0 && click.at >= from - 1.2 && click.at <= to + 0.2).map((click) => click.area!);
  const changed = scene.changes.filter((change) => change.at >= from - 0.4 && change.at <= to + 0.4 && areaOf(change) > 0 && areaOf(change) <= scene.width * scene.height * 0.5 && (clicked.length === 0 || clicked.some((area) => overlap(change, area) > 0)));
  const areas = [...changed, ...clicked];
  return areas.length ? unionOf(areas) : null;
}

export function focusesOf(scene: Scene, pointer: PointerPlan): Focus[] {
  const small = (area: InputArea | null): area is InputArea => !!area && areaOf(area) <= (scene.width * scene.height) / 9;
  const drags = pointer.drags.flatMap((drag) => {
    const at = (t: number) => pointer.frames[Math.min(pointer.frames.length - 1, Math.max(0, Math.round(t * CLIP_FPS)))];
    const start = at(drag.from);
    const end = at(drag.to);
    if (!start || !end) return [];
    const click = scene.clicks
      .filter((each) => each.window && Math.abs(each.at - drag.from) <= DRAG_CLICK_S && coversPoint(each.window, start.x, start.y, TITLE_PX))
      .sort((a, b) => Math.abs(a.at - drag.from) - Math.abs(b.at - drag.from))[0];
    if (click?.window) {
      const moved = { x: click.window.x + end.x - start.x, y: click.window.y + end.y - start.y, width: click.window.width, height: click.window.height };
      return [{ at: drag.to, area: moved, contain: true }];
    }
    return [{ at: drag.from, area: pointArea(start.x, start.y), contain: false }, { at: drag.to, area: pointArea(end.x, end.y), contain: false }];
  });
  const focuses: Focus[] = [
    ...pointer.rings.map((ring) => {
      const click = scene.clicks.find((each) => Math.abs(each.at - ring.at) < 0.001);
      return { at: ring.at, area: small(click?.area ?? null) ? click!.area! : pointArea(ring.x, ring.y), contain: false };
    }),
    ...scene.scrolls.map((scroll) => ({ at: scroll.at, area: pointArea(scroll.x, scroll.y), contain: false })),
    ...drags,
    ...scene.typing.flatMap((typing): Focus[] => {
      if (!typing.characters) return [];
      const area = typingFocus(scene, typing, pointer);
      if (!area) return [];
      const click = clickInFieldBefore(scene, typing);
      return [{ at: typing.at, area, contain: areaOf(area) > 0, ...(click ? { fieldClickAt: click.at } : {}) }];
    }),
  ];
  return focuses.sort((a, b) => a.at - b.at);
}

const FULL = (scene: { width: number; height: number }): View => ({ zoom: 1, x: scene.width / 2, y: scene.height / 2 });

function fitZoom(scene: { width: number; height: number }, area: InputArea, margin: number): number {
  const width = Math.max(1, area.width + margin * 2);
  const height = Math.max(1, area.height + margin * 2);
  return Math.min(scene.width / width, scene.height / height);
}

function placeView(scene: { width: number; height: number }, zoom: number, area: InputArea): View {
  const safe = Math.max(1, zoom);
  const halfWidth = scene.width / safe / 2;
  const halfHeight = scene.height / safe / 2;
  const x = Math.min(scene.width - halfWidth, Math.max(halfWidth, area.x + area.width / 2));
  const y = Math.min(scene.height - halfHeight, Math.max(halfHeight, area.y + area.height / 2));
  return { zoom: Math.round(safe * 1000) / 1000, x: Math.round(x), y: Math.round(y) };
}

export function viewFor(scene: { width: number; height: number }, area: InputArea, single: boolean): View {
  const margin = Math.max(area.width, area.height) * 0.25 + scene.width * 0.04;
  const fits = fitZoom(scene, area, margin);
  const zoom = single && area.width === 0 && area.height === 0 ? ZOOM_POINT : Math.min(ZOOM_MOST, fits);
  if (zoom < ZOOM_LEAST) return FULL(scene);
  return placeView(scene, zoom, area);
}

export function viewCovers(scene: { width: number; height: number }, view: View, area: InputArea): boolean {
  const shown = viewArea(scene, view);
  const slack = 1.5;
  return area.x >= shown.x - slack && area.y >= shown.y - slack && area.x + area.width <= shown.x + shown.width + slack && area.y + area.height <= shown.y + shown.height + slack;
}

export function viewContaining(scene: { width: number; height: number }, area: InputArea): View {
  if (area.width <= 0 || area.height <= 0) return viewFor(scene, area, true);
  const pad = scene.width * 0.04;
  const generous = Math.max(area.width, area.height) * 0.25 + pad;
  const candidates = [generous, pad, 0].map((margin) => Math.min(ZOOM_MOST, fitZoom(scene, area, margin))).filter((zoom) => zoom >= 1);
  for (const zoom of candidates) {
    const view = placeView(scene, zoom, area);
    if (viewCovers(scene, view, area)) return view;
  }
  const bare = Math.min(ZOOM_MOST, fitZoom(scene, area, 0));
  if (bare >= 1) {
    const view = placeView(scene, bare, area);
    if (viewCovers(scene, view, area)) return view;
  }
  return FULL(scene);
}

function viewArea(scene: { width: number; height: number }, view: View): InputArea {
  const width = scene.width / view.zoom;
  const height = scene.height / view.zoom;
  return { x: view.x - width / 2, y: view.y - height / 2, width, height };
}

interface Group {
  readonly first: number;
  readonly last: number;
  readonly view: View;
  readonly area: InputArea;
  readonly outsideAt: number | null;
  readonly fieldClickAt: number | null;
}

const BRIGHT_COLUMNS = 16;
const BRIGHT_ROWS = 9;
const PAINT_QUIET_S = 0.4;
const PAINT_WITH_ACTION_S = 0.15;
const WINDOW_MIN_W = 120;
const WINDOW_MIN_H = 80;
const BLANK_SPREAD = 18;
const BLANK_SHARE = 0.8;
const PAINT_MOVE_SHARE = 0.25;

function coversFocus(change: InputArea, focus: InputArea): boolean {
  if (focus.width <= 0 || focus.height <= 0) return focus.x >= change.x && focus.x <= change.x + change.width && focus.y >= change.y && focus.y <= change.y + change.height;
  return overlap(change, focus) > 0;
}

function openingOf(scene: Scene, focus: InputArea, at: number): ChangedRegion[] {
  return scene.changes.filter((change) => change.width >= WINDOW_MIN_W && change.height >= WINDOW_MIN_H && change.at >= at - 1.2 && change.at <= at + PAINT_WITH_ACTION_S && coversFocus(change, focus));
}

function cellsUnder(scene: Scene, area: InputArea, at: number): number[] | null {
  const grids = scene.brightness;
  if (!grids?.length || scene.width <= 0 || scene.height <= 0 || area.width < WINDOW_MIN_W || area.height < WINDOW_MIN_H) return null;
  let grid = grids[0]!;
  for (const each of grids) if (each.at <= at + 0.05) grid = each;
  if (grid.at > at + 0.05) return null;
  const x0 = Math.min(BRIGHT_COLUMNS - 1, Math.max(0, Math.floor((area.x / scene.width) * BRIGHT_COLUMNS)));
  const x1 = Math.min(BRIGHT_COLUMNS - 1, Math.max(0, Math.floor(((area.x + area.width - 1) / scene.width) * BRIGHT_COLUMNS)));
  const y0 = Math.min(BRIGHT_ROWS - 1, Math.max(0, Math.floor((area.y / scene.height) * BRIGHT_ROWS)));
  const y1 = Math.min(BRIGHT_ROWS - 1, Math.max(0, Math.floor(((area.y + area.height - 1) / scene.height) * BRIGHT_ROWS)));
  const cells: number[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells.push(grid.cells[y * BRIGHT_COLUMNS + x] ?? 0);
  return cells;
}

function blankRegion(scene: Scene, area: InputArea, at: number): boolean {
  const cells = cellsUnder(scene, area, at);
  if (!cells || cells.length < 4) return false;
  const sorted = [...cells].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)]!;
  const alike = cells.filter((cell) => Math.abs(cell - mid) <= BLANK_SPREAD).length;
  return alike / cells.length >= BLANK_SHARE;
}

function cellsDiffer(left: readonly number[], right: readonly number[]): boolean {
  const count = Math.min(left.length, right.length);
  if (count < 4) return false;
  let moved = 0;
  for (let index = 0; index < count; index++) if (Math.abs(left[index]! - right[index]!) > BLANK_SPREAD) moved += 1;
  return moved / count >= PAINT_MOVE_SHARE;
}

function paintReady(scene: Scene, focus: InputArea, at: number, natural: number): number | null {
  const opened = openingOf(scene, focus, at);
  if (!opened.length) return natural;
  const region = unionOf(opened);
  const ready = Math.max(natural, Math.max(...opened.map((change) => change.at)) + PAINT_QUIET_S);
  const grids = scene.brightness ?? [];
  if (!grids.length) return ready;
  let candidate: number | null = null;
  let candidateCells: readonly number[] | null = null;
  const openedAt = Math.max(...opened.map((change) => change.at));
  for (const grid of grids) {
    if (grid.at < openedAt - 0.05 || grid.at > at + 2) continue;
    if (blankRegion(scene, region, grid.at)) continue;
    const cells = cellsUnder(scene, region, grid.at);
    if (!cells) continue;
    if (candidateCells && cellsDiffer(candidateCells, cells)) {
      candidate = grid.at;
      candidateCells = cells;
      continue;
    }
    if (candidate === null) {
      candidate = grid.at;
      candidateCells = cells;
      continue;
    }
    return Math.max(ready, candidate);
  }
  return candidate === null ? null : Math.max(ready, candidate);
}

function settledBefore(scene: Scene, focus: InputArea, clickAt: number, natural: number): number {
  const opened = openingOf(scene, focus, clickAt).filter((change) => change.at <= clickAt);
  return opened.length ? Math.max(natural, Math.max(...opened.map((change) => change.at)) + PAINT_QUIET_S) : natural;
}

function closeGroups(scene: Scene, focuses: readonly Focus[]): Focus[][] {
  const groups: Focus[][] = [];
  for (const focus of focuses) {
    const current = groups.at(-1);
    if (current && focus.at - current.at(-1)!.at <= GROUP_GAP_S) current.push(focus);
    else groups.push([focus]);
  }
  return groups.flatMap((members): Focus[][] => {
    const split: Focus[][] = [[]];
    for (const member of members) {
      const current = split.at(-1)!;
      if (current.length && viewOfMembers(scene, [...current, member]).zoom === 1 && viewOfMembers(scene, current).zoom > 1) split.push([member]);
      else current.push(member);
    }
    return split;
  });
}

function viewOfMembers(scene: Scene, members: readonly Focus[]): View {
  const area = unionOf(members.map((each) => each.area));
  if (members.some((each) => each.contain)) return viewContaining(scene, area);
  return viewFor(scene, area, members.length === 1);
}

interface Action {
  readonly from: number;
  readonly to: number;
  readonly places: readonly InputArea[];
  readonly window: InputArea | null;
  readonly click: boolean;
}

function placesOf(...places: (InputArea | null | undefined)[]): InputArea[] {
  return places.filter((place): place is InputArea => !!place);
}

function actionsOf(scene: Scene, pointer: PointerPlan): Action[] {
  const frameAt = (t: number) => pointer.frames[Math.min(pointer.frames.length - 1, Math.max(0, Math.round(t * CLIP_FPS)))];
  const plain = (from: number, to: number, places: InputArea[]): Action => ({ from, to, places, window: null, click: false });
  return [
    ...scene.clicks.map((click) => ({ from: click.at, to: click.at, places: placesOf(click.window, click.area, pointArea(click.x, click.y)), window: click.window ?? null, click: true })),
    ...scene.scrolls.map((scroll) => plain(scroll.at, scroll.at, placesOf(scroll.window, pointArea(scroll.x, scroll.y)))),
    ...scene.typing.map((typing) => plain(typing.at, typing.at, placesOf(typing.window, typing.area))),
    ...pointer.drags.map((drag) => {
      const start = frameAt(drag.from);
      const end = frameAt(drag.to);
      return plain(drag.from, drag.to, placesOf(start && pointArea(start.x, start.y), end && pointArea(end.x, end.y)));
    }),
  ];
}

function touches(change: InputArea, place: InputArea): boolean {
  if (place.width > 0 && place.height > 0) return overlap(change, place) > 0;
  return place.x >= change.x && place.x <= change.x + change.width && place.y >= change.y && place.y <= change.y + change.height;
}

function removesMost(change: InputArea, window: InputArea): boolean {
  const whole = areaOf(window);
  return whole > 0 && overlap(change, window) > whole / 2;
}

function actionsOwn(actions: readonly Action[], change: ChangedRegion): boolean {
  return actions.some((action) => {
    if (change.at < action.from - OWN_RESULT_S || change.at > action.to + OWN_RESULT_S) return false;
    if (action.click && action.window && removesMost(change, action.window)) return false;
    return action.places.some((place) => touches(change, place));
  });
}

function showsOutside(scene: Scene, view: View, change: ChangedRegion): boolean {
  const screen = scene.width * scene.height;
  return areaOf(change) > screen * BIG_CHANGE_SHARE || areaOf(change) - overlap(change, viewArea(scene, view)) > screen * OUTSIDE_CHANGE_SHARE;
}

function outsideChangeAt(scene: Scene, members: readonly Focus[], actions: readonly Action[]): number | null {
  const view = viewOfMembers(scene, members);
  if (view.zoom === 1) return null;
  const first = members[0]!.at;
  const until = Math.min(scene.length, members.at(-1)!.at + LINGER_S);
  const outside = scene.changes.filter((change) => change.at > first && change.at < until && showsOutside(scene, view, change) && !actionsOwn(actions, change)).map((change) => change.at);
  return outside.length ? Math.min(...outside) : null;
}

interface Unplanned {
  readonly members: readonly Focus[];
  readonly endsAt: number | null;
}

function earliest(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : Math.min(a, b);
}

function splitAtOutsideChanges(scene: Scene, groups: readonly Focus[][], actions: readonly Action[]): Group[] {
  const planned: Group[] = [];
  const queue: Unplanned[] = groups.map((members) => ({ members, endsAt: null }));
  while (queue.length) {
    const { members, endsAt } = queue.shift()!;
    const outsideAt = earliest(outsideChangeAt(scene, members, actions), endsAt);
    const later = outsideAt === null ? [] : members.filter((each) => each.at > outsideAt);
    if (later.length) {
      queue.unshift({ members: members.filter((each) => each.at <= outsideAt!), endsAt: outsideAt }, { members: later, endsAt });
      continue;
    }
    const typedAfterClick = members.map((each) => each.fieldClickAt).filter((at): at is number => at !== undefined);
    planned.push({ first: members[0]!.at, last: members.at(-1)!.at, view: viewOfMembers(scene, members), area: unionOf(members.map((each) => each.area)), outsideAt, fieldClickAt: typedAfterClick.length ? Math.min(...typedAfterClick) : null });
  }
  return planned;
}

function sameView(a: View, b: View): boolean {
  return a.zoom === b.zoom && a.x === b.x && a.y === b.y;
}

function viewsOverlap(scene: Scene, a: View, b: View): boolean {
  return overlap(viewArea(scene, a), viewArea(scene, b)) > 0;
}

function activeBetween(idle: readonly Span[], from: number, to: number): number {
  if (to <= from) return 0;
  const cut = idle.reduce((sum, span) => sum + Math.max(0, Math.min(to, span.to) - Math.max(from, span.from)), 0);
  return to - from - cut;
}

export function planCamera(scene: Scene, pointer: PointerPlan, idle: readonly Span[] = []): CameraKey[] {
  const full = FULL(scene);
  const keys: CameraKey[] = [{ at: 0, view: full }];
  const groups = splitAtOutsideChanges(scene, closeGroups(scene, focusesOf(scene, pointer)), actionsOf(scene, pointer));
  const last = () => keys.at(-1)!;
  const moveTo = (arrive: number, view: View) => {
    const current = last();
    if (sameView(current.view, view)) return;
    const from = Math.max(current.at, arrive - MOVE_S);
    const to = Math.max(from + 0.3, arrive);
    if (from > current.at) keys.push({ at: round3(from), view: current.view });
    keys.push({ at: round3(to), view });
  };
  let outsideShownUntil = -Infinity;
  let stayedFor: number | null = null;
  const zoomOutStayed = () => {
    if (stayedFor !== null && stayedFor + MOVE_S <= scene.length && last().view.zoom > 1) keys.push({ at: round3(Math.max(stayedFor, last().at) + MOVE_S), view: full });
    stayedFor = null;
  };
  groups.forEach((group, index) => {
    const nextGroup = groups[index + 1];
    const natural = Math.max(group.first - SETTLE_S, outsideShownUntil + MOVE_S);
    const typedField = group.fieldClickAt !== null;
    if (group.view.zoom > 1 && natural > group.last && !typedField) return zoomOutStayed();
    const ready = group.view.zoom === 1 ? natural : typedField ? settledBefore(scene, group.area, group.fieldClickAt!, natural) : paintReady(scene, group.area, group.first, natural);
    if (ready === null) return zoomOutStayed();
    const arrive = ready > natural + 0.02 ? ready + MOVE_S : natural;
    const seen = Math.max(group.last, arrive);
    const hold = Math.min(scene.length, seen + LINGER_S, group.outsideAt ?? Infinity);
    if (group.view.zoom > 1 && hold - arrive < ZOOM_SEEN_LEAST_S) return zoomOutStayed();
    stayedFor = null;
    moveTo(arrive, group.view);
    if (group.view.zoom === 1) return;
    if (hold > last().at) keys.push({ at: round3(hold), view: group.view });
    const leave = Math.max(hold, last().at);
    const zoomsOut = leave + MOVE_S <= scene.length;
    if (group.outsideAt !== null) {
      if (zoomsOut) keys.push({ at: round3(leave + MOVE_S), view: full });
      outsideShownUntil = leave + MOVE_S + OUTSIDE_SEEN_S;
      return;
    }
    const nextMove = nextGroup ? nextGroup.first - SETTLE_S - MOVE_S : Infinity;
    const gap = activeBetween(idle, leave, nextMove);
    const pans = !!nextGroup && (gap <= MOVE_S + PAN_INSTEAD_S || (gap <= GROUP_GAP_S && nextGroup.view.zoom > 1 && viewsOverlap(scene, group.view, nextGroup.view)));
    if (pans) stayedFor = leave;
    else if (zoomsOut) keys.push({ at: round3(leave + MOVE_S), view: full });
  });
  zoomOutStayed();
  return keys;
}

export function cameraAt(keys: readonly CameraKey[], t: number): View {
  const index = keys.findIndex((key) => key.at > t);
  if (index === 0) return keys[0]!.view;
  if (index < 0) return keys.at(-1)!.view;
  const before = keys[index - 1]!;
  const after = keys[index]!;
  if (sameView(before.view, after.view)) return before.view;
  const u = easeInOutCubic((t - before.at) / (after.at - before.at));
  return { zoom: before.view.zoom * (after.view.zoom / before.view.zoom) ** u, x: before.view.x + (after.view.x - before.view.x) * u, y: before.view.y + (after.view.y - before.view.y) * u };
}

export function cameraMoves(keys: readonly CameraKey[]): Span[] {
  return keys.flatMap((key, index) => {
    const before = keys[index - 1];
    return before && !sameView(before.view, key.view) ? [{ from: before.at, to: key.at }] : [];
  });
}

export const SHAPE_HOLD_S = 0.3;
const EDGE_PX = 10;
const TITLE_PX = 36;
const DRAG_CLICK_S = 2;
const FLUSH_PX = 2;

export interface ShapeSpan {
  readonly from: number;
  readonly to: number;
  readonly shape: PointerShape;
}

function textField(role: string | null | undefined): boolean {
  return !!role && (/^(?:text|entry|edit)$/i.test(role) || /textbox|searchbox|textarea|textfield|text field|editable|\bentry\b|\bedit\b/i.test(role));
}

function buttonOrLink(role: string | null | undefined): boolean {
  return !!role && /button|link/i.test(role);
}

function dividerRole(role: string | null | undefined): boolean {
  return !!role && /separator|splitter|divider/i.test(role);
}

function clickShape(role: string | null | undefined): PointerShape {
  if (textField(role)) return "ibeam";
  if (buttonOrLink(role)) return "hand";
  return "arrow";
}

function coversPoint(rect: InputArea, x: number, y: number, pad: number): boolean {
  return x >= rect.x - pad && y >= rect.y - pad && x <= rect.x + rect.width + pad && y <= rect.y + rect.height + pad;
}

function edgeCursor(scene: Scene, rect: InputArea, x: number, y: number): PointerShape {
  const left = x - rect.x;
  const right = rect.x + rect.width - x;
  const top = y - rect.y;
  const bottom = rect.y + rect.height - y;
  const onLeft = left <= EDGE_PX && left >= -EDGE_PX;
  const onRight = right <= EDGE_PX && right >= -EDGE_PX;
  const onTop = top <= EDGE_PX && top >= -EDGE_PX;
  const onBottom = bottom <= EDGE_PX && bottom >= -EDGE_PX;
  if ((onLeft || onRight) && (onTop || onBottom)) {
    if (onTop && onLeft) return "nw";
    if (onTop && onRight) return "ne";
    if (onBottom && onLeft) return "sw";
    return "se";
  }
  if (onLeft) return rect.x <= FLUSH_PX ? "e" : "ew";
  if (onRight) return rect.x + rect.width >= scene.width - FLUSH_PX ? "w" : "ew";
  if (onTop) return rect.y <= FLUSH_PX ? "s" : "ns";
  if (onBottom) return rect.y + rect.height >= scene.height - FLUSH_PX ? "n" : "ns";
  return "grab";
}

function dividerCursor(scene: Scene, area: InputArea): PointerShape {
  if (area.height >= area.width) {
    if (area.x <= FLUSH_PX) return "right";
    if (area.x + area.width >= scene.width - FLUSH_PX) return "left";
    return "col";
  }
  if (area.y <= FLUSH_PX) return "down";
  if (area.y + area.height >= scene.height - FLUSH_PX) return "up";
  return "ns";
}

function dragCursor(scene: Scene, drag: { readonly from: number; readonly x: number; readonly y: number }): PointerShape {
  const divider = scene.clicks
    .filter((click) => dividerRole(click.role) && click.area && coversPoint(click.area, drag.x, drag.y, EDGE_PX))
    .sort((a, b) => Math.abs(a.at - drag.from) - Math.abs(b.at - drag.from))[0];
  if (divider?.area) return dividerCursor(scene, divider.area);
  const windows = [...scene.clicks.map((click) => ({ at: click.at, window: click.window })), ...scene.typing.map((typing) => ({ at: typing.at, window: typing.window }))]
    .filter((each): each is { at: number; window: InputArea } => !!each.window && coversPoint(each.window, drag.x, drag.y, EDGE_PX))
    .sort((a, b) => Math.abs(a.at - drag.from) - Math.abs(b.at - drag.from));
  const window = windows[0]?.window;
  return window ? edgeCursor(scene, window, drag.x, drag.y) : "grab";
}

interface ShapeRequest {
  readonly from: number;
  readonly to: number;
  readonly shape: PointerShape;
  readonly rank: number;
}

function heldShapes(pieces: readonly ShapeSpan[]): ShapeSpan[] {
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
    if (!(last.from === 0 && last.shape === "arrow") && last.to - last.from < SHAPE_HOLD_S) {
      const until = Math.min(piece.to, last.from + SHAPE_HOLD_S);
      out[out.length - 1] = { ...last, to: until };
      if (until < piece.to) out.push({ ...piece, from: until });
      continue;
    }
    out.push({ ...piece });
  }
  return out.map((span) => ({ from: round3(span.from), to: round3(span.to), shape: span.shape }));
}

export function shapeAt(spans: readonly ShapeSpan[], t: number): PointerShape {
  return (spans.find((span) => t >= span.from && t < span.to) ?? spans.at(-1))?.shape ?? "arrow";
}

export function pointerShapes(scene: Scene): ShapeSpan[] {
  const pointer = planPointer(scene);
  const drags = pressesOf(scene.samples).filter((press) => press.drag);
  const requests: ShapeRequest[] = [];
  const glideAway = (at: number) => pointer.glides.find((glide) => glide.from > at + 1e-3)?.from ?? scene.length;
  for (const drag of drags) requests.push({ from: drag.from, to: Math.max(drag.to, drag.from + SHAPE_HOLD_S), shape: dragCursor(scene, drag), rank: 3 });
  for (const click of scene.clicks) {
    if (drags.some((drag) => Math.abs(drag.from - click.at) <= 0.3 && distance(drag, click) <= SAME_MOVE_PX)) continue;
    const shape = clickShape(click.role);
    if (shape === "arrow") continue;
    const held = shape === "ibeam" ? Math.max(click.at + SHAPE_HOLD_S, glideAway(click.at)) : click.at + SHAPE_HOLD_S;
    requests.push({ from: click.at, to: held, shape, rank: 2 });
  }
  for (const typing of scene.typing) {
    if (typing.secret || typing.characters === 0 || !textField(typing.role)) continue;
    const span = typingSpan(typing, scene.typing);
    const tail = span.to + Math.max(TYPING_AFTER_S, TYPING_LEAST_S);
    requests.push({ from: span.from, to: Math.max(tail, span.from + SHAPE_HOLD_S), shape: "ibeam", rank: 1 });
  }
  const marks = [...new Set([0, scene.length, ...requests.flatMap((request) => [request.from, request.to])].filter((time) => time >= 0 && time <= scene.length).map((time) => round3(time)))].sort((a, b) => a - b);
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
  if (!pieces.length) return [{ from: 0, to: round3(scene.length), shape: "arrow" }];
  return heldShapes(pieces);
}

export function keptMotion(cuts: readonly (readonly [number, number])[], kept: readonly Span[], least = 0.4): [number, number][] {
  const windows = [...kept].sort((a, b) => a.from - b.from);
  return cuts.flatMap(([from, to]): [number, number][] => {
    let pieces: [number, number][] = [[from, to]];
    for (const window of windows) {
      pieces = pieces.flatMap(([start, end]): [number, number][] => {
        if (window.to <= start || window.from >= end) return [[start, end]];
        return [
          [start, Math.min(end, window.from)],
          [Math.max(start, window.to), end],
        ].filter(([a, b]) => b - a > 0) as [number, number][];
      });
    }
    return pieces.filter(([a, b]) => b - a >= least).map(([a, b]) => [round3(a), round3(b)]);
  });
}
