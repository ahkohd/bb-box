import type { InputArea, MouseButton } from "./record-input.ts";

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
}

export interface PlacedScroll {
  readonly at: number;
  readonly x: number;
  readonly y: number;
}

export interface PlacedTyping {
  readonly at: number;
  readonly characters: number;
  readonly area: InputArea | null;
  readonly secret: boolean;
}

export interface ChangedRegion extends InputArea {
  readonly at: number;
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
  for (const sample of samples) {
    if (open && open.buttons && !sample.buttons) {
      const held = sample.at - open.from;
      const drag = held > CLICK_MOST_S || open.moved > CLICK_MOVE_PX;
      presses.push({ from: open.from, to: sample.at, x: open.x, y: open.y, button: buttonOf(open.buttons), drag });
      open = null;
    } else if (open && open.buttons) {
      open.moved = Math.max(open.moved, distance(open, sample));
    }
    if (!open && sample.buttons) open = { from: sample.at, x: sample.x, y: sample.y, buttons: sample.buttons, moved: 0 };
  }
  if (open) {
    const last = samples.at(-1)!;
    presses.push({ from: open.from, to: last.at, x: open.x, y: open.y, button: buttonOf(open.buttons), drag: true });
  }
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
}

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

export function typingFocus(scene: Scene, typing: PlacedTyping, pointer: PointerPlan): InputArea | null {
  if (typing.secret) return null;
  const zooms = (area: InputArea) => viewFor(scene, area, false).zoom > 1;
  if (typing.area && zooms(typing.area)) return typing.area;
  const within = (change: InputArea) => !typing.area || overlap(change, typing.area) > 0;
  const near = scene.changes.filter((change) => change.at >= typing.at - 0.3 && change.at <= typing.at + 1.2 && within(change) && areaOf(change) <= (scene.width * scene.height) / 6);
  if (near.length && zooms(unionOf(near))) return unionOf(near);
  const frame = pointer.frames[Math.min(pointer.frames.length - 1, Math.max(0, Math.round(typing.at * CLIP_FPS)))];
  return frame ? pointArea(frame.x, frame.y) : null;
}

export function focusesOf(scene: Scene, pointer: PointerPlan): Focus[] {
  const small = (area: InputArea | null): area is InputArea => !!area && areaOf(area) <= (scene.width * scene.height) / 9;
  const drags = pointer.drags.flatMap((drag) => {
    const at = (t: number) => pointer.frames[Math.min(pointer.frames.length - 1, Math.max(0, Math.round(t * CLIP_FPS)))];
    const start = at(drag.from);
    const end = at(drag.to);
    return start && end ? [{ at: drag.from, area: pointArea(start.x, start.y) }, { at: drag.to, area: pointArea(end.x, end.y) }] : [];
  });
  const focuses: Focus[] = [
    ...pointer.rings.map((ring) => {
      const click = scene.clicks.find((each) => Math.abs(each.at - ring.at) < 0.001);
      return { at: ring.at, area: small(click?.area ?? null) ? click!.area! : pointArea(ring.x, ring.y) };
    }),
    ...scene.scrolls.map((scroll) => ({ at: scroll.at, area: pointArea(scroll.x, scroll.y) })),
    ...drags,
    ...scene.typing.flatMap((typing) => {
      if (!typing.characters) return [];
      const area = typingFocus(scene, typing, pointer);
      return area ? [{ at: typing.at, area }] : [];
    }),
  ];
  return focuses.sort((a, b) => a.at - b.at);
}

const FULL = (scene: { width: number; height: number }): View => ({ zoom: 1, x: scene.width / 2, y: scene.height / 2 });

export function viewFor(scene: { width: number; height: number }, area: InputArea, single: boolean): View {
  const margin = Math.max(area.width, area.height) * 0.25 + scene.width * 0.04;
  const width = area.width + margin * 2;
  const height = area.height + margin * 2;
  const fits = Math.min(scene.width / width, scene.height / height);
  const zoom = single && area.width === 0 && area.height === 0 ? ZOOM_POINT : Math.min(ZOOM_MOST, fits);
  if (zoom < ZOOM_LEAST) return FULL(scene);
  const halfWidth = scene.width / zoom / 2;
  const halfHeight = scene.height / zoom / 2;
  const x = Math.min(scene.width - halfWidth, Math.max(halfWidth, area.x + area.width / 2));
  const y = Math.min(scene.height - halfHeight, Math.max(halfHeight, area.y + area.height / 2));
  return { zoom: Math.round(zoom * 1000) / 1000, x: Math.round(x), y: Math.round(y) };
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
}

function groupsOf(scene: Scene, focuses: readonly Focus[]): Group[] {
  const groups: Focus[][] = [];
  for (const focus of focuses) {
    const current = groups.at(-1);
    if (current && focus.at - current.at(-1)!.at <= GROUP_GAP_S) current.push(focus);
    else groups.push([focus]);
  }
  return groups.flatMap((members): Group[] => {
    const split: Focus[][] = [[]];
    for (const member of members) {
      const current = split.at(-1)!;
      const widened = unionOf([...current.map((each) => each.area), member.area]);
      if (current.length && viewFor(scene, widened, false).zoom === 1 && viewFor(scene, unionOf(current.map((each) => each.area)), current.length === 1).zoom > 1) split.push([member]);
      else current.push(member);
    }
    return split.map((part) => ({ first: part[0]!.at, last: part.at(-1)!.at, view: viewFor(scene, unionOf(part.map((each) => each.area)), part.length === 1) }));
  });
}

function sameView(a: View, b: View): boolean {
  return a.zoom === b.zoom && a.x === b.x && a.y === b.y;
}

export function planCamera(scene: Scene, pointer: PointerPlan): CameraKey[] {
  const full = FULL(scene);
  const keys: CameraKey[] = [{ at: 0, view: full }];
  const groups = groupsOf(scene, focusesOf(scene, pointer));
  const last = () => keys.at(-1)!;
  const moveTo = (arrive: number, view: View) => {
    const current = last();
    if (sameView(current.view, view)) return;
    const from = Math.max(current.at, arrive - MOVE_S);
    const to = Math.max(from + 0.3, arrive);
    if (from > current.at) keys.push({ at: round3(from), view: current.view });
    keys.push({ at: round3(to), view });
  };
  groups.forEach((group, index) => {
    const nextGroup = groups[index + 1];
    moveTo(group.first - SETTLE_S, group.view);
    if (group.view.zoom === 1) return;
    let hold = Math.min(scene.length, group.last + LINGER_S);
    const shown = viewArea(scene, group.view);
    const screen = scene.width * scene.height;
    const away = scene.changes.find((change) => change.at > group.first && change.at < hold && (areaOf(change) > screen * BIG_CHANGE_SHARE || areaOf(change) - overlap(change, shown) > screen * OUTSIDE_CHANGE_SHARE));
    if (away) hold = Math.max(group.last, away.at);
    if (hold > last().at) keys.push({ at: round3(hold), view: group.view });
    const nextMove = nextGroup ? nextGroup.first - SETTLE_S - MOVE_S : Infinity;
    if (nextMove > hold + MOVE_S + PAN_INSTEAD_S && hold + MOVE_S <= scene.length) keys.push({ at: round3(hold + MOVE_S), view: full });
  });
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
