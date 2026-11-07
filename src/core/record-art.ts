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

const ARROW: readonly (readonly [number, number])[] = [
  [4, 2.5],
  [4, 19.7],
  [8.6, 15.4],
  [11.6, 22],
  [14.5, 20.7],
  [11.5, 14.2],
  [17.8, 14],
];

function inside(polygon: readonly (readonly [number, number])[], x: number, y: number): boolean {
  let within = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) within = !within;
  }
  return within;
}

function edgeDistance(polygon: readonly (readonly [number, number])[], x: number, y: number): number {
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

export function pointerArt(height: number): Pointer {
  const scale = height / 20;
  const edge = 1.5;
  const size = Math.ceil(24 * scale);
  const png = paint(size, size, (x, y) => {
    const ux = x / scale;
    const uy = y / scale;
    if (edgeDistance(ARROW, ux, uy) <= edge / 2) return [255, 255, 255, 1];
    return inside(ARROW, ux, uy) ? [12, 12, 14, 1] : null;
  });
  return { name: "pointer.png", png, width: size, height: size, hotX: Math.round(4 * scale), hotY: Math.round(2.5 * scale) };
}

export function ringRadius(pointerHeight: number, stage: number): number {
  const progress = (stage + 1) / RING_STAGES;
  return pointerHeight * (0.3 + 0.55 * (1 - (1 - progress) ** 2));
}

export function ringArt(pointerHeight: number, stage: number, kind: "left" | "right"): Art {
  const progress = (stage + 1) / RING_STAGES;
  const radius = ringRadius(pointerHeight, stage);
  const stroke = Math.max(2.5, pointerHeight * 0.12);
  const fade = 0.95 * (1 - progress * 0.75);
  const size = Math.ceil((radius + stroke) * 2 + 4);
  const centre = size / 2;
  const colour: readonly [number, number, number] = kind === "right" ? [79, 141, 245] : [255, 255, 255];
  const png = paint(size, size, (x, y) => {
    const from = Math.hypot(x - centre, y - centre) - radius;
    if (Math.abs(from) <= stroke / 2) return [colour[0], colour[1], colour[2], fade];
    if (Math.abs(from) <= stroke / 2 + 1.25) return [16, 16, 18, fade * 0.55];
    if (from < 0) return [16, 16, 18, fade * 0.1];
    return null;
  });
  return { name: `ring-${kind}-${stage}.png`, png, width: size, height: size };
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
