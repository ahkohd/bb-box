import { rgbaPng } from "./png.ts";
import { RING_STAGES } from "./record-motion.ts";

export interface Art {
  readonly name: string;
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
}

export interface Pointer extends Art {
  readonly hotX: number;
  readonly hotY: number;
}

type Rgba = readonly [number, number, number, number];

const SUPER = 4;

function paint(width: number, height: number, shade: (x: number, y: number) => Rgba | null): Buffer {
  const pixels = new Uint8Array(width * height * 4);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUPER; sy++) {
        for (let sx = 0; sx < SUPER; sx++) {
          const colour = shade(px + (sx + 0.5) / SUPER, py + (sy + 0.5) / SUPER);
          if (!colour) continue;
          r += colour[0] * colour[3];
          g += colour[1] * colour[3];
          b += colour[2] * colour[3];
          a += colour[3];
        }
      }
      const at = (py * width + px) * 4;
      if (a > 0) {
        pixels[at] = Math.round(r / a);
        pixels[at + 1] = Math.round(g / a);
        pixels[at + 2] = Math.round(b / a);
      }
      pixels[at + 3] = Math.round((a / (SUPER * SUPER)) * 255);
    }
  }
  return rgbaPng(width, height, pixels);
}

type Point = readonly [number, number];

export type PointerVariant = "dark" | "light";

type Rgb = readonly [number, number, number];

const INK: Rgb = [24, 24, 27];
const PAPER: Rgb = [250, 250, 250];
const RIGHT_CLICK: Rgb = [79, 141, 245];

const VARIANT_INKS: Readonly<Record<PointerVariant, { readonly fill: Rgb; readonly edge: Rgb }>> = {
  dark: { fill: INK, edge: PAPER },
  light: { fill: PAPER, edge: INK },
};

interface Corner {
  readonly at: Point;
  readonly radius: number;
}

const POINTER_CORNERS: readonly Corner[] = [
  { at: [3.4, 2.4], radius: 1 },
  { at: [3.4, 19.2], radius: 1.4 },
  { at: [7.9, 15.4], radius: 0.8 },
  { at: [10.6, 21.4], radius: 1.2 },
  { at: [14, 19.9], radius: 1.2 },
  { at: [11.3, 14.4], radius: 0.8 },
  { at: [17, 14.1], radius: 1.4 },
];

const POINTER_UNITS = 20;
const POINTER_CANVAS_UNITS = 24;
const POINTER_EDGE_UNITS = 1.55;
const SOFT_EDGE_PX = 0.9;
const ARC_STEPS = 10;

const minus = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const plus = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]];
const times = (a: Point, k: number): Point => [a[0] * k, a[1] * k];
const unit = (a: Point): Point => times(a, 1 / Math.hypot(a[0], a[1]));

interface Fillet {
  readonly centre: Point;
  readonly radius: number;
  readonly bisector: Point;
  readonly half: number;
}

function filletOf(corners: readonly Corner[], index: number): Fillet {
  const { at, radius } = corners[index]!;
  const before = unit(minus(corners[(index - 1 + corners.length) % corners.length]!.at, at));
  const after = unit(minus(corners[(index + 1) % corners.length]!.at, at));
  const half = Math.acos(Math.max(-1, Math.min(1, before[0] * after[0] + before[1] * after[1]))) / 2;
  const bisector = unit(plus(before, after));
  return { centre: plus(at, times(bisector, radius / Math.sin(half))), radius, bisector, half };
}

function roundedOutline(corners: readonly Corner[]): Point[] {
  return corners.flatMap((corner, index) => {
    const { centre, radius, half } = filletOf(corners, index);
    const before = unit(minus(corners[(index - 1 + corners.length) % corners.length]!.at, corner.at));
    const after = unit(minus(corners[(index + 1) % corners.length]!.at, corner.at));
    const reach = radius / Math.tan(half);
    const start = minus(plus(corner.at, times(before, reach)), centre);
    const end = minus(plus(corner.at, times(after, reach)), centre);
    const from = Math.atan2(start[1], start[0]);
    let sweep = Math.atan2(end[1], end[0]) - from;
    if (sweep > Math.PI) sweep -= 2 * Math.PI;
    if (sweep < -Math.PI) sweep += 2 * Math.PI;
    return Array.from({ length: ARC_STEPS + 1 }, (_, step): Point => {
      const angle = from + (sweep * step) / ARC_STEPS;
      return [centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle)];
    });
  });
}

const POINTER_OUTLINE = roundedOutline(POINTER_CORNERS);

function inside(polygon: readonly Point[], x: number, y: number): boolean {
  let within = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) within = !within;
  }
  return within;
}

function edgeDistance(polygon: readonly Point[], x: number, y: number): number {
  let least = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[j]!;
    const [bx, by] = polygon[i]!;
    const dx = bx - ax;
    const dy = by - ay;
    const u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    least = Math.min(least, Math.hypot(x - (ax + u * dx), y - (ay + u * dy)));
  }
  return least;
}

const ramp = (value: number) => Math.max(0, Math.min(1, value));

function inked(fill: Rgb, edge: Rgb, signedPx: number, halfEdgePx: number, opacity = 1): Rgba | null {
  const coverage = ramp(0.5 + (halfEdgePx - signedPx) / SOFT_EDGE_PX);
  if (coverage <= 0) return null;
  const filled = ramp(0.5 + (-halfEdgePx - signedPx) / SOFT_EDGE_PX);
  const mix = (channel: 0 | 1 | 2) => edge[channel] + (fill[channel] - edge[channel]) * filled;
  return [mix(0), mix(1), mix(2), coverage * opacity];
}

function pointerTip(scale: number): Point {
  const { centre, radius, bisector } = filletOf(POINTER_CORNERS, 0);
  return times(minus(centre, times(bisector, radius + POINTER_EDGE_UNITS / 2)), scale);
}

export function pointerArt(height: number, variant: PointerVariant): Pointer {
  const scale = height / POINTER_UNITS;
  const size = Math.ceil(POINTER_CANVAS_UNITS * scale);
  const halfEdgePx = (POINTER_EDGE_UNITS * scale) / 2;
  const { fill, edge } = VARIANT_INKS[variant];
  const png = paint(size, size, (x, y) => {
    const ux = x / scale;
    const uy = y / scale;
    const distancePx = edgeDistance(POINTER_OUTLINE, ux, uy) * scale;
    return inked(fill, edge, inside(POINTER_OUTLINE, ux, uy) ? -distancePx : distancePx, halfEdgePx);
  });
  const [hotX, hotY] = pointerTip(scale);
  return { name: `pointer-${variant}.png`, png, width: size, height: size, hotX: Math.round(hotX), hotY: Math.round(hotY) };
}

export function ringRadius(pointerHeight: number, stage: number): number {
  const progress = (stage + 1) / RING_STAGES;
  return pointerHeight * (0.3 + 0.55 * (1 - (1 - progress) ** 2));
}

export function ringArt(pointerHeight: number, stage: number, kind: "left" | "right", variant: PointerVariant): Art {
  const progress = (stage + 1) / RING_STAGES;
  const radius = ringRadius(pointerHeight, stage);
  const halfStrokePx = Math.max(2.5, pointerHeight * 0.12) / 2;
  const halfEdgePx = (POINTER_EDGE_UNITS * (pointerHeight / POINTER_UNITS)) / 4;
  const opacity = 0.95 * (1 - progress * 0.75);
  const { fill, edge } = VARIANT_INKS[variant];
  const band = kind === "right" ? RIGHT_CLICK : fill;
  const size = Math.ceil((radius + halfStrokePx + halfEdgePx * 2 + SOFT_EDGE_PX) * 2 + 4);
  const centre = size / 2;
  const png = paint(size, size, (x, y) => {
    const fromBand = Math.abs(Math.hypot(x - centre, y - centre) - radius) - halfStrokePx - halfEdgePx;
    return inked(band, edge, fromBand, halfEdgePx, opacity);
  });
  return { name: `ring-${kind}-${variant}-${stage}.png`, png, width: size, height: size };
}

export function pressArt(pointerHeight: number): Art {
  const radius = pointerHeight * 0.55;
  const size = Math.ceil(radius * 2 + 4);
  const centre = size / 2;
  const png = paint(size, size, (x, y) => {
    const from = Math.hypot(x - centre, y - centre);
    if (from <= radius - 1.5) return [128, 128, 132, 0.35];
    if (from <= radius) return [255, 255, 255, 0.75];
    if (from <= radius + 1) return [20, 20, 22, 0.35];
    return null;
  });
  return { name: "press.png", png, width: size, height: size };
}

export function cornerArt(radius: number, background: string): Art {
  const colour = [0, 2, 4].map((at) => parseInt(background.slice(at, at + 2), 16)) as [number, number, number];
  const size = Math.max(1, Math.ceil(radius));
  const png = paint(size, size, (x, y) => (Math.hypot(x - radius, y - radius) > radius ? [colour[0], colour[1], colour[2], 1] : null));
  return { name: "corner.png", png, width: size, height: size };
}
