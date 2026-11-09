import { cornerArt, pressArt, ringArt, type Art, type Pointer, type PointerVariant } from "./record-art.ts";
import { activityMoments, idleStretches } from "./record-edit.ts";
import { CURSOR_BODY, CURSOR_VIEW, cursorArt, cursorCanvas, ringInk, type PointerShape } from "./record-cursors.ts";
import type { InputArea, InputEvent } from "./record-input.ts";
import { planKeyPills, type KeyPill, type KeyStyle, type PlacedKeys, type PlacedKeyTyping } from "./record-keys.ts";
import {
  CLIP_FPS,
  RING_FRAMES_PER_STAGE,
  RING_S,
  RING_STAGES,
  cameraAt,
  cameraMoves,
  pillRegion,
  planCamera,
  planPointer,
  pointerShapes,
  shapeAt,
  type CameraKey,
  type ChangedRegion,
  type PlacedClick,
  type PlacedScroll,
  type PlacedTyping,
  type PointerFrame,
  type PointerPlan,
  type PointerSample,
  type Scene,
  type ShapeSpan,
  type Span,
  type View,
} from "./record-motion.ts";

export type PointerMode = "drawn" | "shown";

export const GRID_COLUMNS = 16;
export const GRID_ROWS = 9;

export interface BrightnessGrid {
  readonly at: number;
  readonly cells: readonly number[];
}

export interface VariantSpan {
  readonly from: number;
  readonly to: number;
  readonly variant: PointerVariant;
}

export interface InkSpan {
  readonly from: number;
  readonly to: number;
  readonly shape: PointerShape;
  readonly variant: PointerVariant;
}

export interface SceneFacts {
  readonly pointer: PointerMode;
  readonly screen: { readonly width: number; readonly height: number } | null;
  readonly samples: readonly PointerSample[];
  readonly changes: readonly ChangedRegion[];
  readonly luma: number | null;
  readonly lag: number;
  readonly keys: KeyStyle;
  readonly agentCursor?: boolean;
  readonly brightness?: readonly BrightnessGrid[];
  readonly inputs?: readonly InputEvent[];
}

export interface SceneOptions {
  readonly zoom: boolean;
  readonly frame: boolean;
  readonly stills?: "cut" | "keep";
  readonly captions?: readonly number[];
}

export interface FrameLayout {
  readonly inset: number;
  readonly radius: number;
  readonly background: string;
}

export interface ScenePlan {
  readonly source: { readonly width: number; readonly height: number };
  readonly content: { readonly width: number; readonly height: number };
  readonly pointer: PointerPlan;
  readonly drawsPointer: boolean;
  readonly camera: readonly CameraKey[];
  readonly zooms: boolean;
  readonly frame: FrameLayout | null;
  readonly pills: readonly KeyPill[];
  readonly kept: readonly Span[];
  readonly art: readonly Art[];
  readonly pointerArt: Pointer | null;
  readonly cursors: readonly Pointer[];
  readonly pointerHeight: number;
  readonly variants: readonly VariantSpan[];
  readonly shapes: readonly ShapeSpan[];
  readonly inks: readonly InkSpan[];
  readonly ringStyles: readonly RingStyle[];
  readonly idle: readonly Span[] | null;
}

export interface RingStyle {
  readonly kind: "left" | "right";
  readonly variant: PointerVariant;
}

export const DARK_BACKGROUND = "161618";
export const LIGHT_BACKGROUND = "ececee";
export const FRAME_INSET_SHARE = 0.035;
export const FRAME_RADIUS_SHARE = 0.01;
export const PILL_KEPT_S = 1;
export const RING_KEPT_S = 0.15;
export const CLIP_WIDTH_MOST = 1280;

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
const round3 = (value: number) => Math.round(value * 1000) / 1000;

function scaled(area: InputArea | null, scale: number): InputArea | null {
  return area ? { x: area.x * scale, y: area.y * scale, width: area.width * scale, height: area.height * scale } : null;
}

export function sceneOf(facts: SceneFacts, size: { readonly width: number; readonly height: number }, start: number, length: number): { readonly scene: Scene; readonly keys: readonly PlacedKeys[]; readonly keyTyping: readonly PlacedKeyTyping[] } {
  const zero = start + facts.lag;
  const onScreen = facts.screen && facts.screen.width > 0 ? size.width / facts.screen.width : 1;
  const time = (at: number) => round3(at - zero);
  const inside = (at: number) => at >= -1 && at <= length + 1;
  const inputs = (facts.inputs ?? []).filter((input) => inside(input.at - zero));
  const spaceScale = (space: "screen" | "picture") => (space === "screen" ? onScreen : 1);
  const sampled = facts.samples.map((sample) => ({ at: time(sample.at), x: sample.x * onScreen, y: sample.y * onScreen, buttons: sample.buttons }));
  const person = inputs.flatMap((input) => (input.type === "pointer" ? [{ at: time(input.at), x: input.x, y: input.y, buttons: input.buttons }] : []));
  const samples = (sampled.length ? sampled : person).filter((sample) => inside(sample.at));
  const clicks: PlacedClick[] = inputs.flatMap((input) => {
    if (input.type !== "click") return [];
    const scale = spaceScale(input.space);
    return [{ at: time(input.at), x: input.x * scale, y: input.y * scale, button: input.button, count: input.count, area: scaled(input.area, scale), role: input.role ?? null, window: scaled(input.window ?? null, scale) }];
  });
  const scrolls: PlacedScroll[] = inputs.flatMap((input) => (input.type === "scroll" ? [{ at: time(input.at), x: input.x * spaceScale(input.space), y: input.y * spaceScale(input.space), window: scaled(input.window ?? null, spaceScale(input.space)) }] : []));
  const typing: PlacedTyping[] = inputs.flatMap((input) =>
    input.type === "typing" ? [{ at: time(input.at), characters: input.characters, area: scaled(input.area, spaceScale(input.space)), secret: input.secret, role: input.role ?? null, window: scaled(input.window ?? null, spaceScale(input.space)), by: input.by, ...(input.call !== undefined ? { call: input.call } : {}) }] : [],
  );
  const keys: PlacedKeys[] = inputs.flatMap((input) => (input.type === "keys" ? [{ at: time(input.at), chord: input.chord }] : []));
  return {
    scene: { width: size.width, height: size.height, length, samples, clicks, scrolls, typing, changes: facts.changes, brightness: facts.brightness ?? [], agentCursor: !!facts.agentCursor },
    keys,
    keyTyping: typing.map((each) => ({ at: each.at, secret: each.secret, characters: each.characters, by: each.by, ...(each.call !== undefined ? { call: each.call } : {}) })),
  };
}

export function contentSize(source: { readonly width: number; readonly height: number }, frame: boolean): { readonly clip: { width: number; height: number }; readonly content: { width: number; height: number }; readonly inset: number } {
  const width = Math.min(CLIP_WIDTH_MOST, source.width || CLIP_WIDTH_MOST);
  if (!frame) {
    const height = source.width ? even((source.height * width) / source.width) : 720;
    return { clip: { width, height }, content: { width, height }, inset: 0 };
  }
  const inset = even(width * FRAME_INSET_SHARE);
  const contentWidth = width - inset * 2;
  const contentHeight = source.width ? even((source.height * contentWidth) / source.width) : 720;
  return { clip: { width, height: contentHeight + inset * 2 }, content: { width: contentWidth, height: contentHeight }, inset };
}

export const BRIGHT_UNDER = 150;
export const DIM_UNDER = 105;
export const VARIANT_LEAST_S = 0.5;

function brightnessUnder(grids: readonly BrightnessGrid[], size: { readonly width: number; readonly height: number }, at: number, x: number, y: number): number | null {
  if (!grids.length || size.width <= 0 || size.height <= 0) return null;
  const nearest = grids.reduce((best, grid) => (Math.abs(grid.at - at) < Math.abs(best.at - at) ? grid : best));
  const column = Math.min(GRID_COLUMNS - 1, Math.max(0, Math.floor((x / size.width) * GRID_COLUMNS)));
  const row = Math.min(GRID_ROWS - 1, Math.max(0, Math.floor((y / size.height) * GRID_ROWS)));
  return nearest.cells[row * GRID_COLUMNS + column] ?? null;
}

function variantFor(under: number | null): PointerVariant | null {
  if (under === null) return null;
  if (under >= BRIGHT_UNDER) return "dark";
  return under <= DIM_UNDER ? "light" : null;
}

export function pointerVariants(frames: readonly PointerFrame[], grids: readonly BrightnessGrid[], size: { readonly width: number; readonly height: number }, pointerHeight: number, luma: number | null): VariantSpan[] {
  const wanted = frames.map((frame, index) => variantFor(brightnessUnder(grids, size, index / CLIP_FPS, frame.x + pointerHeight * 0.25, frame.y + pointerHeight * 0.45)));
  let current: PointerVariant = wanted.find((each) => each !== null) ?? (luma !== null && luma >= 128 ? "dark" : "light");
  const runs: VariantSpan[] = [];
  wanted.forEach((each, index) => {
    current = each ?? current;
    const last = runs.at(-1);
    if (last && last.variant === current) runs[runs.length - 1] = { ...last, to: index + 1 };
    else runs.push({ from: index, to: index + 1, variant: current });
  });
  const least = Math.round(VARIANT_LEAST_S * CLIP_FPS);
  return runs.reduce((kept: VariantSpan[], run) => {
    const last = kept.at(-1);
    if (last && (last.variant === run.variant || run.to - run.from < least)) kept[kept.length - 1] = { ...last, to: run.to };
    else kept.push(run);
    return kept;
  }, []);
}

function variantAt(spans: readonly VariantSpan[], frame: number): PointerVariant {
  return (spans.find((span) => frame >= span.from && frame < span.to) ?? spans.at(-1))?.variant ?? "light";
}

export function backgroundFor(luma: number | null): string {
  return luma !== null && luma >= 128 ? LIGHT_BACKGROUND : DARK_BACKGROUND;
}

function knowsIdle(facts: SceneFacts, options: SceneOptions): boolean {
  return options.stills !== "keep" && facts.pointer === "drawn" && facts.samples.length > 0 && (facts.brightness?.length ?? 0) > 0;
}

export function planScene(facts: SceneFacts, size: { readonly width: number; readonly height: number }, start: number, length: number, options: SceneOptions): ScenePlan {
  const { scene, keys, keyTyping } = sceneOf(facts, size, start, length);
  const idle = knowsIdle(facts, options) ? idleStretches(activityMoments(scene, keys, (options.captions ?? []).map((at) => at - facts.lag)), length) : null;
  const pointer = planPointer(scene);
  const camera = options.zoom ? planCamera(scene, pointer) : [{ at: 0, view: { zoom: 1, x: size.width / 2, y: size.height / 2 } }];
  const zooms = camera.some((key) => key.view.zoom > 1);
  const pills = planKeyPills(keys, keyTyping, facts.keys, length).map((pill) => ({ ...pill, avoid: pillRegion(scene, pointer, pill.from, pill.to) }));
  const drawsPointer = facts.pointer === "drawn" && pointer.frames.length > 0 && pointer.visibleFrom !== null;
  const kept: Span[] = [
    ...(drawsPointer ? pointer.glides : []),
    ...pointer.rings.map((ring) => ({ from: ring.at - RING_KEPT_S, to: ring.at + RING_S })),
    ...pointer.drags,
    ...pills.map((pill) => ({ from: pill.from, to: pill.from + PILL_KEPT_S })),
    ...(zooms ? cameraMoves(camera) : []),
  ].map((span) => ({ from: round3(Math.max(0, span.from)), to: round3(Math.min(length, span.to)) }));
  const { content, inset } = contentSize(size, options.frame);
  const canvas = cursorCanvas(size.width, content.width);
  const pointerHeight = Math.max(16, Math.round((canvas * CURSOR_BODY) / CURSOR_VIEW));
  const variants = pointerVariants(pointer.frames, facts.brightness ?? [], size, pointerHeight, facts.luma);
  const shapes = pointerShapes(scene);
  const inks = inkSpans(shapes, variants, pointer.frames.length);
  const seen: PointerShape[] = [];
  for (const ink of inks) if (!seen.includes(ink.shape)) seen.push(ink.shape);
  const cursors = drawsPointer ? seen.flatMap((shape) => (["dark", "light"] as const).filter((variant) => inks.some((ink) => ink.shape === shape && ink.variant === variant)).map((variant) => cursorArt(shape, variant, canvas))) : [];
  const ringStyles = ringStylesOf(pointer, variants, shapes);
  const frame = options.frame ? { inset, radius: Math.max(4, Math.round(contentSize(size, true).clip.width * FRAME_RADIUS_SHARE)), background: backgroundFor(facts.luma) } : null;
  const art: Art[] = [
    ...ringStyles.flatMap((style) => Array.from({ length: RING_STAGES }, (_, stage) => ringArt(pointerHeight, stage, style.kind, style.variant))),
    ...(drawsPointer && pointer.drags.length ? [pressArt(pointerHeight)] : []),
    ...cursors,
    ...(frame ? [cornerArt(frame.radius, frame.background)] : []),
  ];
  return { source: size, content, pointer, drawsPointer, camera, zooms, frame, pills, kept, art, pointerArt: cursors[0] ?? null, cursors, pointerHeight, variants, shapes, inks, ringStyles, idle };
}

function inkSpans(shapes: readonly ShapeSpan[], variants: readonly VariantSpan[], frames: number): InkSpan[] {
  const out: InkSpan[] = [];
  for (let index = 0; index < frames; index++) {
    const shape = shapeAt(shapes, index / CLIP_FPS);
    const variant = variantAt(variants, index);
    const last = out.at(-1);
    if (last && last.shape === shape && last.variant === variant) out[out.length - 1] = { ...last, to: index + 1 };
    else out.push({ from: index, to: index + 1, shape, variant });
  }
  return out;
}

function ringStylesOf(pointer: PointerPlan, variants: readonly VariantSpan[], shapes: readonly ShapeSpan[]): RingStyle[] {
  const styles = pointer.rings.map((ring): RingStyle => ({ kind: ring.kind, variant: ringInk(shapeAt(shapes, ring.at), variantAt(variants, Math.round(ring.at * CLIP_FPS))) }));
  return styles.filter((style, index) => styles.findIndex((other) => other.kind === style.kind && other.variant === style.variant) === index);
}

const ringTarget = (style: RingStyle, stage: number) => `overlay@ring${style.kind[0]}${style.variant[0]}${stage}`;
const cursorTarget = (name: string) => {
  const match = /^cursor-(.+)-(dark|light)\.png$/.exec(name)!;
  return `overlay@${match[1]}${match[2]![0]}`;
};

export function sceneCommands(plan: ScenePlan): string {
  const lines: { at: number; order: number; text: string }[] = [];
  const at = (frame: number) => round3(frame / CLIP_FPS);
  const art = (name: string) => plan.art.find((each) => each.name === name)!;
  if (plan.drawsPointer && plan.pointerArt) {
    const press = plan.pointer.drags.length ? art("press.png") : null;
    let last: { x: number; y: number; shape: string } | null = null;
    plan.pointer.frames.forEach((frame, index) => {
      const shape = shapeAt(plan.shapes, index / CLIP_FPS);
      if (last && last.x === frame.x && last.y === frame.y && last.shape === shape) return;
      last = { x: frame.x, y: frame.y, shape };
      const parts = plan.cursors.flatMap((cursor) => [`${cursorTarget(cursor.name)} x ${frame.x - cursor.hotX}`, `${cursorTarget(cursor.name)} y ${frame.y - cursor.hotY}`]);
      if (press) parts.push(`overlay@press x ${frame.x - Math.round(press.width / 2)}`, `overlay@press y ${frame.y - Math.round(press.height / 2)}`);
      lines.push({ at: at(index), order: 1, text: parts.join(", ") });
    });
    const visibleFrom = plan.pointer.visibleFrom ?? 0;
    plan.inks.forEach((span, index) => {
      const target = cursorTarget(`cursor-${span.shape}-${span.variant}.png`);
      const to = at(span.to);
      if (to <= visibleFrom && index < plan.inks.length - 1) return;
      lines.push({ at: Math.max(visibleFrom, at(span.from)), order: 2, text: `${target} enable 1` });
      if (index < plan.inks.length - 1) lines.push({ at: to, order: 0, text: `${target} enable 0` });
    });
  }
  for (const ring of plan.pointer.rings) {
    const style: RingStyle = { kind: ring.kind, variant: ringInk(shapeAt(plan.shapes, ring.at), variantAt(plan.variants, Math.round(ring.at * CLIP_FPS))) };
    for (let stage = 0; stage < RING_STAGES; stage++) {
      const image = art(`ring-${style.kind}-${style.variant}-${stage}.png`);
      const from = round3(ring.at + (stage * RING_FRAMES_PER_STAGE) / CLIP_FPS);
      const target = ringTarget(style, stage);
      lines.push({ at: from, order: 2, text: `${target} x ${ring.x - Math.round(image.width / 2)}, ${target} y ${ring.y - Math.round(image.height / 2)}` });
    }
  }
  return lines
    .filter((line) => line.at >= 0)
    .sort((a, b) => a.at - b.at || a.order - b.order)
    .map((line) => `${line.at.toFixed(3)} ${line.text};`)
    .join("\n")
    .concat(lines.length ? "\n" : "");
}

function piecewise(keys: readonly CameraKey[], value: (view: View) => number, geometric: boolean): string {
  const constant = (view: View) => `${Math.round(value(view) * 1000) / 1000}`;
  const parts = keys.map((key, index) => {
    const after = keys[index + 1];
    const from = key.at.toFixed(3);
    if (!after) return `gte(it,${from})*${constant(key.view)}`;
    const to = after.at.toFixed(3);
    const range = `gte(it,${from})*lt(it,${to})`;
    const a = value(key.view);
    const b = value(after.view);
    if (Math.abs(a - b) < 0.0005) return `${range}*${constant(key.view)}`;
    const u = `clip((it-${from})/${(after.at - key.at).toFixed(3)},0,1)`;
    const eased = `if(lt(${u},0.5),4*${u}*${u}*${u},1-pow(2-2*${u},3)/2)`;
    return geometric ? `${range}*${a}*pow(${Math.round((b / a) * 100000) / 100000},${eased})` : `${range}*(${a}+${Math.round((b - a) * 1000) / 1000}*${eased})`;
  });
  return parts.length === 1 ? parts[0]!.replace(/^gte\(it,0\.000\)\*/, "") : parts.join("+");
}

function shown(spans: readonly string[]): string {
  return spans.length ? `'${spans.join("+")}'` : "0";
}

function ringShown(plan: ScenePlan, kind: string, variant: string, stage: number): string {
  return shown(
    plan.pointer.rings.flatMap((ring) => {
      const ink = ringInk(shapeAt(plan.shapes, ring.at), variantAt(plan.variants, Math.round(ring.at * CLIP_FPS)));
      if (ring.kind !== kind || ink !== variant) return [];
      const from = round3(ring.at + (stage * RING_FRAMES_PER_STAGE) / CLIP_FPS);
      const to = round3(from + RING_FRAMES_PER_STAGE / CLIP_FPS);
      return [`between(t,${from.toFixed(3)},${to.toFixed(3)})`];
    }),
  );
}

function dragShown(plan: ScenePlan): string {
  return shown(plan.pointer.drags.map((drag) => `between(t,${drag.from.toFixed(3)},${drag.to.toFixed(3)})`));
}

export function zoomFilter(plan: ScenePlan): string {
  const { width, height } = plan.content;
  if (!plan.zooms) return `scale=${width}:${height}:flags=bicubic`;
  const z = piecewise(plan.camera, (view) => view.zoom, true);
  const x = piecewise(plan.camera, (view) => view.x, false);
  const y = piecewise(plan.camera, (view) => view.y, false);
  return `zoompan=z='max(1,${z})':x='clip((${x})-iw/zoom/2,0,iw-iw/zoom)':y='clip((${y})-ih/zoom/2,0,ih-ih/zoom)':d=1:s=${width}x${height}:fps=${CLIP_FPS}`;
}

export function sceneHead(plan: ScenePlan, firstInput: number): { readonly graph: string; readonly last: string } {
  const lines: string[] = [];
  let label = "h0";
  const commands = plan.drawsPointer || plan.pointer.rings.length;
  lines.push(`[0:v]setpts=PTS-STARTPTS,fps=${CLIP_FPS}${commands ? ",sendcmd=f=pointer.cmd" : ""}[${label}]`);
  let step = 0;
  const into = () => `h${++step}`;
  plan.art.forEach((art, index) => {
    if (art.name === "corner.png") return;
    const input = firstInput + index;
    const ring = /^ring-(left|right)-(dark|light)-(\d)\.png$/.exec(art.name);
    const cursor = /^cursor-(.+)-(dark|light)\.png$/.exec(art.name);
    const target = ring ? ringTarget({ kind: ring[1] as "left" | "right", variant: ring[2] as PointerVariant }, Number(ring[3])) : cursor ? cursorTarget(art.name) : "overlay@press";
    const enable = ring ? ringShown(plan, ring[1]!, ring[2]!, Number(ring[3])) : art.name === "press.png" ? dragShown(plan) : "0";
    const next = into();
    const source = cursor ? `c${index}` : `${input}:v`;
    if (cursor) lines.push(`[${input}:v]format=rgba,scale=iw/2:ih/2:flags=lanczos[${source}]`);
    lines.push(`[${label}][${source}]${target}=x=0:y=0:enable=${enable}:format=auto[${next}]`);
    label = next;
  });
  const zoomed = into();
  lines.push(`[${label}]${zoomFilter(plan)}[${zoomed}]`);
  return { graph: lines.join(";\n"), last: zoomed };
}

export function frameTail(plan: ScenePlan, from: string, cornerInput: number, clip: { readonly width: number; readonly height: number }): { readonly graph: string; readonly last: string } {
  if (!plan.frame) return { graph: "", last: from };
  const { inset, radius, background } = plan.frame;
  const { width, height } = plan.content;
  const right = inset + width - radius;
  const bottom = inset + height - radius;
  const lines = [
    `[${from}]pad=${clip.width}:${clip.height}:${inset}:${inset}:color=0x${background}[f0]`,
    `[${cornerInput}:v]split=4[k0][k1][k2][k3]`,
    "[k1]hflip[k1f]",
    "[k2]vflip[k2f]",
    "[k3]hflip,vflip[k3f]",
    `[f0][k0]overlay=${inset}:${inset}[f1]`,
    `[f1][k1f]overlay=${right}:${inset}[f2]`,
    `[f2][k2f]overlay=${inset}:${bottom}[f3]`,
    `[f3][k3f]overlay=${right}:${bottom}[f4]`,
  ];
  return { graph: lines.join(";\n"), last: "f4" };
}

export function areaOnClip(plan: ScenePlan, area: InputArea, t: number): InputArea {
  const view = cameraAt(plan.camera, t);
  const width = plan.source.width / view.zoom;
  const height = plan.source.height / view.zoom;
  const left = Math.min(plan.source.width - width, Math.max(0, view.x - width / 2));
  const top = Math.min(plan.source.height - height, Math.max(0, view.y - height / 2));
  const scaleX = plan.content.width / width;
  const scaleY = plan.content.height / height;
  return { x: (area.x - left) * scaleX, y: (area.y - top) * scaleY, width: area.width * scaleX, height: area.height * scaleY };
}

export function pointerOnClip(plan: ScenePlan, t: number): { readonly x: number; readonly y: number } | null {
  if (!plan.pointer.frames.length) return null;
  const frame = plan.pointer.frames[Math.min(plan.pointer.frames.length - 1, Math.max(0, Math.round(t * CLIP_FPS)))]!;
  const view = cameraAt(plan.camera, t);
  const width = plan.source.width / view.zoom;
  const height = plan.source.height / view.zoom;
  const left = Math.min(plan.source.width - width, Math.max(0, view.x - width / 2));
  const top = Math.min(plan.source.height - height, Math.max(0, view.y - height / 2));
  return { x: ((frame.x - left) / width) * plan.content.width, y: ((frame.y - top) / height) * plan.content.height };
}

export function bundle(plan: ScenePlan, texts: readonly (readonly [string, string])[]): Buffer {
  const files: [string, Buffer][] = [["pointer.cmd", Buffer.from(sceneCommands(plan))], ...texts.map(([name, text]): [string, Buffer] => [name, Buffer.from(text)]), ...plan.art.map((art): [string, Buffer] => [art.name, art.png])];
  return Buffer.from(files.map(([name, data]) => `${name}\t${data.toString("base64")}\n`).join(""));
}
