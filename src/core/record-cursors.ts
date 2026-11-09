import { rgbaPng } from "./png.ts";
import { CURSOR_PARTS, type CursorInk, type CursorPart, type CursorSource } from "./record-cursor-paths.ts";
import type { Pointer, PointerVariant } from "./record-art.ts";

export type PointerShape = CursorSource | "ns" | "w" | "nw" | "se" | "sw" | "down" | "left";

export const CURSOR_VIEW = 32;
export const CURSOR_BODY = 17;
export const CURSOR_READ_PX = 26;
export const CURSOR_SUPERSAMPLE = 2;

const INK: readonly [number, number, number] = [4, 4, 4];
const PAPER: readonly [number, number, number] = [255, 255, 255];
const SHADOW = 0.25;

type Point = readonly [number, number];
type MapPoint = (x: number, y: number) => Point;

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

export function cursorCanvas(sourceWidth: number, contentWidth: number): number {
  const onClip = CURSOR_READ_PX * (CURSOR_VIEW / CURSOR_BODY);
  const onSource = onClip * (sourceWidth / Math.max(1, contentWidth));
  return Math.max(CURSOR_VIEW, Math.round(onSource));
}

export function ringInk(shape: PointerShape, variant: PointerVariant): PointerVariant {
  const inverted = shape === "hand" || shape === "grab";
  if (!inverted) return variant;
  return variant === "dark" ? "light" : "dark";
}

const identity: MapPoint = (x, y) => [x, y];
const mirrorX: MapPoint = (x, y) => [CURSOR_VIEW - x, y];
const mirrorY: MapPoint = (x, y) => [x, CURSOR_VIEW - y];
const rotateCW: MapPoint = (x, y) => [CURSOR_VIEW / 2 + (y - CURSOR_VIEW / 2), CURSOR_VIEW / 2 - (x - CURSOR_VIEW / 2)];
const rotate180: MapPoint = (x, y) => [CURSOR_VIEW - x, CURSOR_VIEW - y];

function placed(shape: PointerShape): { readonly source: CursorSource; readonly map: MapPoint } {
  if (shape === "ns") return { source: "ew", map: rotateCW };
  if (shape === "w") return { source: "e", map: mirrorX };
  if (shape === "nw") return { source: "ne", map: mirrorX };
  if (shape === "se") return { source: "ne", map: mirrorY };
  if (shape === "sw") return { source: "ne", map: rotate180 };
  if (shape === "down") return { source: "up", map: mirrorY };
  if (shape === "left") return { source: "right", map: mirrorX };
  return { source: shape, map: identity };
}

const ARGUMENTS: Readonly<Record<string, number>> = { M: 2, L: 2, H: 1, V: 1, C: 6, Z: 0 };

function commands(d: string): { readonly op: string; readonly args: readonly number[] }[] {
  const tokens = d.match(/[MLHVCZ]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: { op: string; args: number[] }[] = [];
  let op = "";
  let args: number[] = [];
  for (const token of tokens) {
    if (/[A-Z]/.test(token)) {
      op = token;
      args = [];
      if (op === "Z") out.push({ op, args: [] });
      continue;
    }
    args.push(Number(token));
    if (args.length === (ARGUMENTS[op] ?? 0)) {
      out.push({ op, args });
      args = [];
      if (op === "M") op = "L";
    }
  }
  return out;
}

function subpaths(d: string, map: MapPoint): Point[][] {
  const paths: Point[][] = [];
  let current: Point[] = [];
  let x = 0;
  let y = 0;
  let start: Point = [0, 0];
  const add = (nx: number, ny: number) => {
    current.push(map(nx, ny));
    x = nx;
    y = ny;
  };
  for (const command of commands(d)) {
    const [a, b, c, e, f, g] = command.args;
    if (command.op === "M") {
      if (current.length) paths.push(current);
      x = a!;
      y = b!;
      start = [x, y];
      current = [map(x, y)];
    } else if (command.op === "L") add(a!, b!);
    else if (command.op === "H") add(a!, y);
    else if (command.op === "V") add(x, a!);
    else if (command.op === "C") {
      const x1 = a!;
      const y1 = b!;
      const x2 = c!;
      const y2 = e!;
      const x3 = f!;
      const y3 = g!;
      const steps = 8;
      for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        const u = 1 - t;
        current.push(map(u ** 3 * x + 3 * u ** 2 * t * x1 + 3 * u * t ** 2 * x2 + t ** 3 * x3, u ** 3 * y + 3 * u ** 2 * t * y1 + 3 * u * t ** 2 * y2 + t ** 3 * y3));
      }
      x = x3;
      y = y3;
    } else if (command.op === "Z") {
      current.push(map(start[0], start[1]));
      paths.push(current);
      current = [];
      x = start[0];
      y = start[1];
    }
  }
  if (current.length) paths.push(current);
  return paths;
}

function fillMask(width: number, height: number, paths: readonly (readonly Point[])[]): Uint8Array {
  const out = new Uint8Array(width * height);
  const edges = paths.flatMap((path) => path.slice(0, -1).map((from, index) => [from, path[index + 1]!] as const));
  for (let py = 0; py < height; py++) {
    const y = py + 0.5;
    const hits: { x: number; dir: number }[] = [];
    for (const [from, to] of edges) {
      const [x1, y1] = from;
      const [x2, y2] = to;
      if (!((y1 <= y && y2 > y) || (y2 <= y && y1 > y))) continue;
      hits.push({ x: x1 + ((y - y1) / (y2 - y1)) * (x2 - x1), dir: y1 < y2 ? 1 : -1 });
    }
    hits.sort((left, right) => left.x - right.x);
    let wind = 0;
    let from = 0;
    for (const hit of hits) {
      if (wind !== 0) {
        const start = Math.max(0, Math.ceil(from - 0.5));
        const end = Math.min(width, Math.ceil(hit.x - 0.5));
        for (let x = start; x < end; x++) out[py * width + x] = 1;
      }
      wind += hit.dir;
      from = hit.x;
    }
  }
  return out;
}

function covered(width: number, height: number, paths: readonly (readonly Point[])[]): Float32Array {
  const bigW = width * 2;
  const bigH = height * 2;
  const scaled = paths.map((path) => path.map(([x, y]) => [x * 2, y * 2] as const));
  const binary = fillMask(bigW, bigH, scaled);
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let count = 0;
      for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) if (binary[(y * 2 + sy) * bigW + (x * 2 + sx)]) count++;
      out[y * width + x] = count / 4;
    }
  }
  return out;
}

function segmentsOf(paths: readonly (readonly Point[])[]): readonly (readonly [number, number, number, number])[] {
  return paths.flatMap((path) => path.slice(0, -1).map((from, index) => [from[0], from[1], path[index + 1]![0], path[index + 1]![1]] as const));
}

function strokeCover(width: number, height: number, paths: readonly (readonly Point[])[], radius: number): Float32Array {
  const out = new Float32Array(width * height);
  const pad = radius + 1;
  for (const [x1, y1, x2, y2] of segmentsOf(paths)) {
    const minX = Math.max(0, Math.floor(Math.min(x1, x2) - pad));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(x1, x2) + pad));
    const minY = Math.max(0, Math.floor(Math.min(y1, y2) - pad));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(y1, y2) + pad));
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy || 1;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const u = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
        const dist = Math.hypot(px - (x1 + u * dx), py - (y1 + u * dy));
        const cover = Math.max(0, Math.min(1, radius + 0.5 - dist));
        const at = y * width + x;
        if (cover > out[at]!) out[at] = cover;
      }
    }
  }
  return out;
}

function blur(alpha: Float32Array, width: number, height: number, sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel: number[] = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const weight = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(weight);
    sum += weight;
  }
  const weights = kernel.map((weight) => weight / sum);
  const across = new Float32Array(alpha.length);
  const down = new Float32Array(alpha.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let value = 0;
      for (let i = -radius; i <= radius; i++) value += alpha[y * width + Math.min(width - 1, Math.max(0, x + i))]! * weights[i + radius]!;
      across[y * width + x] = value;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let value = 0;
      for (let i = -radius; i <= radius; i++) value += across[Math.min(height - 1, Math.max(0, y + i)) * width + x]! * weights[i + radius]!;
      down[y * width + x] = value;
    }
  }
  return down;
}

function sample(alpha: Float32Array, width: number, height: number, x: number, y: number): number {
  const x0 = Math.min(width - 1, Math.max(0, Math.floor(x)));
  const y0 = Math.min(height - 1, Math.max(0, Math.floor(y)));
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = Math.min(1, Math.max(0, x - x0));
  const ty = Math.min(1, Math.max(0, y - y0));
  const at = (yy: number, xx: number) => alpha[yy * width + xx]!;
  return at(y0, x0) * (1 - tx) * (1 - ty) + at(y0, x1) * tx * (1 - ty) + at(y1, x0) * (1 - tx) * ty + at(y1, x1) * tx * ty;
}

function shadowOf(alpha: Float32Array, width: number, height: number, scale: number): Float32Array {
  const dy = scale;
  const shifted = new Float32Array(alpha.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) shifted[y * width + x] = sample(alpha, width, height, x + 0.5, y + 0.5 - dy);
  const blurred = blur(shifted, width, height, 0.5 * scale);
  const out = new Float32Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) out[i] = blurred[i]! * (1 - alpha[i]!) * SHADOW;
  return out;
}

function colourOf(ink: CursorInk, variant: PointerVariant): readonly [number, number, number] {
  const dark = variant === "dark";
  if (ink === "ink") return dark ? INK : PAPER;
  return dark ? PAPER : INK;
}

function scalePaths(paths: readonly (readonly Point[])[], scale: number): Point[][] {
  return paths.map((path) => path.map(([x, y]) => [x * scale, y * scale]));
}

function hotspotOf(shape: PointerShape, fills: readonly (readonly Point[])[]): Point {
  if (shape === "arrow") return [8.4, 8.4];
  if (shape === "hand") return [12.3, 5.5];
  if (shape === "grab") return boundsCentre(fills);
  if (shape === "e" || shape === "right") return extreme(fills, "e");
  if (shape === "w" || shape === "left") return extreme(fills, "w");
  if (shape === "n" || shape === "up") return extreme(fills, "n");
  if (shape === "s" || shape === "down") return extreme(fills, "s");
  return [CURSOR_VIEW / 2, CURSOR_VIEW / 2];
}

function extreme(paths: readonly (readonly Point[])[], kind: "e" | "n" | "s" | "w"): Point {
  let best = paths[0]?.[0] ?? [CURSOR_VIEW / 2, CURSOR_VIEW / 2];
  for (const path of paths) {
    for (const point of path) {
      if (kind === "e" && point[0] > best[0]) best = point;
      if (kind === "w" && point[0] < best[0]) best = point;
      if (kind === "n" && point[1] < best[1]) best = point;
      if (kind === "s" && point[1] > best[1]) best = point;
    }
  }
  return best;
}

function boundsCentre(paths: readonly (readonly Point[])[]): Point {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const path of paths) {
    for (const [x, y] of path) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (!Number.isFinite(minX)) return [CURSOR_VIEW / 2, CURSOR_VIEW / 2];
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

function viewPaths(parts: readonly CursorPart[], map: MapPoint): Point[][] {
  return parts.flatMap((part) => subpaths(part.d, map));
}

const drawn = new Map<string, Pointer>();

export function cursorArt(shape: PointerShape, variant: PointerVariant, canvas: number): Pointer {
  const key = `${shape}:${variant}:${canvas}`;
  const hit = drawn.get(key);
  if (hit) return hit;
  const { source, map } = placed(shape);
  const parts = CURSOR_PARTS[source];
  const pngSize = even(canvas * CURSOR_SUPERSAMPLE);
  const scale = pngSize / CURSOR_VIEW;
  const outlines = scalePaths(viewPaths(parts.outlines, map), scale);
  const fills = scalePaths(viewPaths(parts.fills, map), scale);
  const strokes = scalePaths(viewPaths(parts.strokes, map), scale);
  const outline = covered(pngSize, pngSize, outlines);
  const fill = covered(pngSize, pngSize, fills);
  const stroke = strokes.length ? strokeCover(pngSize, pngSize, strokes, scale / 2) : null;
  const shadow = shadowOf(outline, pngSize, pngSize, scale);
  const pixels = new Float32Array(pngSize * pngSize * 4);
  const lay = (cover: Float32Array, colour: readonly [number, number, number]) => {
    for (let i = 0; i < cover.length; i++) {
      const sa = cover[i]!;
      if (sa <= 0) continue;
      const at = i * 4;
      const inv = 1 - sa;
      pixels[at] = colour[0] * sa + pixels[at]! * inv;
      pixels[at + 1] = colour[1] * sa + pixels[at + 1]! * inv;
      pixels[at + 2] = colour[2] * sa + pixels[at + 2]! * inv;
      pixels[at + 3] = sa + pixels[at + 3]! * inv;
    }
  };
  lay(shadow, [0, 0, 0]);
  if (parts.outlines[0]) lay(outline, colourOf(parts.outlines[0].ink, variant));
  if (parts.fills[0]) lay(fill, colourOf(parts.fills[0].ink, variant));
  if (stroke && parts.strokes[0]) lay(stroke, colourOf(parts.strokes[0].ink, variant));
  const rgba = new Uint8Array(pngSize * pngSize * 4);
  for (let i = 0; i < pngSize * pngSize; i++) {
    const a = pixels[i * 4 + 3]!;
    const at = i * 4;
    if (a > 0) {
      rgba[at] = Math.round(Math.min(255, pixels[at]! / a));
      rgba[at + 1] = Math.round(Math.min(255, pixels[at + 1]! / a));
      rgba[at + 2] = Math.round(Math.min(255, pixels[at + 2]! / a));
    }
    rgba[at + 3] = Math.round(Math.min(1, a) * 255);
  }
  const spot = hotspotOf(shape, viewPaths(parts.fills, map));
  const overlay = pngSize / CURSOR_SUPERSAMPLE;
  const art: Pointer = {
    name: `cursor-${shape}-${variant}.png`,
    png: rgbaPng(pngSize, pngSize, rgba),
    width: pngSize,
    height: pngSize,
    hotX: Math.round((spot[0] / CURSOR_VIEW) * overlay),
    hotY: Math.round((spot[1] / CURSOR_VIEW) * overlay),
  };
  drawn.set(key, art);
  return art;
}
