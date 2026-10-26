import { clockwiseTurns, isSideways, type Body, type BodyButton, type Cutout, type DeviceModel, type FoldScreen, type Orientation, type Posture, type QuarterTurns, type Screen, type VideoSize } from "./device.ts";

export function turnsBetween(from: Orientation, to: Orientation): -1 | 0 | 1 | 2 {
  const ahead = (clockwiseTurns(to) - clockwiseTurns(from) + 4) % 4;
  return ahead === 3 ? -1 : (ahead as 0 | 1 | 2);
}

export interface Affine {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export interface Point2 {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function followedBy(first: Affine, second: Affine): Affine {
  return {
    a: second.a * first.a + second.c * first.b,
    b: second.b * first.a + second.d * first.b,
    c: second.a * first.c + second.c * first.d,
    d: second.b * first.c + second.d * first.d,
    e: second.a * first.e + second.c * first.f + second.e,
    f: second.b * first.e + second.d * first.f + second.f,
  };
}

export function chain(...steps: readonly Affine[]): Affine {
  return steps.reduce(followedBy, IDENTITY);
}

export function inverse(m: Affine): Affine {
  const determinant = m.a * m.d - m.b * m.c;
  return {
    a: m.d / determinant,
    b: -m.b / determinant,
    c: -m.c / determinant,
    d: m.a / determinant,
    e: (m.c * m.f - m.d * m.e) / determinant,
    f: (m.b * m.e - m.a * m.f) / determinant,
  };
}

export function applied(m: Affine, point: Point2): Point2 {
  return { x: m.a * point.x + m.c * point.y + m.e, y: m.b * point.x + m.d * point.y + m.f };
}

export function moved(x: number, y: number): Affine {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
}

export function scaled(by: number): Affine {
  return { a: by, b: 0, c: 0, d: by, e: 0, f: 0 };
}

export function quarterTurned(turns: number): Affine {
  const quarter = (((turns % 4) + 4) % 4) as QuarterTurns;
  const [cos, sin] = ([[1, 0], [0, 1], [-1, 0], [0, -1]] as const)[quarter];
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

export function pictureTurned(turns: number, size: VideoSize): Affine {
  const quarter = ((turns % 4) + 4) % 4;
  const shifts: readonly Affine[] = [moved(0, 0), moved(size.height, 0), moved(size.width, size.height), moved(0, size.width)];
  return followedBy(quarterTurned(quarter), shifts[quarter]!);
}

export function cssMatrix(m: Affine): string {
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  return `matrix(${[m.a, m.b, m.c, m.d, m.e, m.f].map(round).join(",")})`;
}

export interface ButtonShape extends Rect {
  readonly edge: BodyButton["edge"];
}

export interface FrameShape {
  readonly body: { readonly width: number; readonly height: number; readonly radius: number };
  readonly band: number;
  readonly screen: Rect & { readonly radius: number };
  readonly pixels: VideoSize;
  readonly cutout: (Rect & { readonly shape: Cutout["shape"] }) | null;
  readonly buttons: readonly ButtonShape[];
  readonly crease: { readonly hinge: "vertical" | "horizontal"; readonly at: number; readonly shaded: boolean } | null;
  readonly framed: boolean;
}

export type FrameView = { readonly screen: FoldScreen; readonly posture: Posture } | null;

export const BUTTON_DEPTH_OF_BEZEL = 0.16;
export const BAND_OF_BEZEL = 0.3;

function activeScreen(model: DeviceModel, view: FrameView): Screen {
  if (model.form !== "foldable") return model.screen;
  return view?.screen === "outer" ? model.outer : model.inner;
}

function buttonShapes(body: Body, width: number, height: number): readonly ButtonShape[] {
  const depth = Math.max(3, Math.round(body.bezel * BUTTON_DEPTH_OF_BEZEL));
  return body.buttons.map((button) => {
    const along = button.edge === "top" ? width : height;
    const from = button.from * along;
    const length = (button.to - button.from) * along;
    if (button.edge === "top") return { edge: "top", x: from, y: -depth, width: length, height: depth };
    if (button.edge === "left") return { edge: "left", x: -depth, y: from, width: depth, height: length };
    return { edge: "right", x: width, y: from, width: depth, height: length };
  });
}

export function frameShape(model: DeviceModel, view: FrameView, framed: boolean): FrameShape {
  const screen = activeScreen(model, view);
  const bezel = framed ? model.body.bezel : 0;
  const width = screen.pixels.width + bezel * 2;
  const height = screen.pixels.height + bezel * 2;
  const folded = model.form === "foldable" && view?.screen === "inner" ? { hinge: model.hinge, posture: view.posture } : null;
  return {
    body: { width, height, radius: framed ? model.body.radius : screen.cornerRadius },
    band: framed ? Math.max(2, Math.round(bezel * BAND_OF_BEZEL)) : 0,
    screen: { x: bezel, y: bezel, width: screen.pixels.width, height: screen.pixels.height, radius: screen.cornerRadius },
    pixels: screen.pixels,
    cutout: screen.cutout ? { x: bezel + screen.cutout.x, y: bezel + screen.cutout.y, width: screen.cutout.width, height: screen.cutout.height, shape: screen.cutout.shape } : null,
    buttons: framed ? buttonShapes(model.body, width, height) : [],
    crease: folded ? { hinge: folded.hinge, at: folded.hinge === "vertical" ? bezel + screen.pixels.width / 2 : bezel + screen.pixels.height / 2, shaded: folded.posture === "half-open" } : null,
    framed,
  };
}

export function outerBounds(shape: FrameShape): Rect {
  const left = Math.min(0, ...shape.buttons.map((button) => button.x));
  const top = Math.min(0, ...shape.buttons.map((button) => button.y));
  const right = Math.max(shape.body.width, ...shape.buttons.map((button) => button.x + button.width));
  const bottom = Math.max(shape.body.height, ...shape.buttons.map((button) => button.y + button.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function videoToScreen(shape: FrameShape, content: Orientation, video: VideoSize): Affine {
  const turns = clockwiseTurns(content);
  const upright = turns % 2 === 1 ? { width: video.height, height: video.width } : video;
  return chain(pictureTurned(4 - turns, video), scaled(shape.screen.width / upright.width), moved(shape.screen.x, shape.screen.y));
}

export interface Placement {
  readonly scale: number;
  readonly content: VideoSize;
  readonly centre: Point2;
}

export interface FitRequest {
  readonly area: VideoSize;
  readonly margin: number;
  readonly below: number;
  readonly beside?: number;
  readonly pixelRatio: number;
  readonly pixelForPixel: boolean;
}

export function placement(shape: FrameShape, physical: Orientation, fit: FitRequest): Placement {
  const bounds = outerBounds(shape);
  const sideways = isSideways(physical);
  const across = sideways ? bounds.height : bounds.width;
  const down = sideways ? bounds.width : bounds.height;
  const ownPixels = 1 / Math.max(fit.pixelRatio, 0.01);
  const beside = fit.beside ?? 0;
  const room = { width: Math.max(1, fit.area.width - fit.margin * 2 - beside), height: Math.max(1, fit.area.height - fit.margin * 2 - fit.below) };
  const scale = fit.pixelForPixel ? ownPixels : Math.min(ownPixels, room.width / across, room.height / down);
  const content = { width: Math.max(fit.area.width, across * scale + fit.margin * 2 + beside), height: Math.max(fit.area.height, down * scale + fit.margin * 2 + fit.below) };
  return { scale, content, centre: { x: (content.width - beside) / 2, y: (content.height - fit.below) / 2 } };
}

export function bodyToStage(shape: FrameShape, turns: number, place: Placement): Affine {
  return chain(moved(-shape.body.width / 2, -shape.body.height / 2), quarterTurned(turns), scaled(place.scale), moved(place.centre.x, place.centre.y));
}

export function videoToStage(shape: FrameShape, physical: Orientation, content: Orientation, video: VideoSize, place: Placement): Affine {
  return followedBy(videoToScreen(shape, content, video), bodyToStage(shape, clockwiseTurns(physical), place));
}

export function stageToVideo(shape: FrameShape, physical: Orientation, content: Orientation, video: VideoSize, place: Placement, at: Point2): Point2 | null {
  const point = applied(inverse(videoToStage(shape, physical, content, video, place)), at);
  if (point.x < 0 || point.y < 0 || point.x >= video.width || point.y >= video.height) return null;
  return { x: Math.floor(point.x), y: Math.floor(point.y) };
}

export function screenOnStage(shape: FrameShape, physical: Orientation, place: Placement): Rect {
  const toStage = bodyToStage(shape, clockwiseTurns(physical), place);
  const corners = [
    applied(toStage, { x: shape.screen.x, y: shape.screen.y }),
    applied(toStage, { x: shape.screen.x + shape.screen.width, y: shape.screen.y + shape.screen.height }),
  ];
  const x = Math.min(corners[0]!.x, corners[1]!.x);
  const y = Math.min(corners[0]!.y, corners[1]!.y);
  return { x, y, width: Math.abs(corners[0]!.x - corners[1]!.x), height: Math.abs(corners[0]!.y - corners[1]!.y) };
}
