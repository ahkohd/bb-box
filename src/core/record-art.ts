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

export type PointerVariant = "dark" | "light";

type Rgb = readonly [number, number, number];

const INK: Rgb = [24, 24, 27];
const PAPER: Rgb = [250, 250, 250];
const RIGHT_CLICK: Rgb = [79, 141, 245];

const VARIANT_INKS: Readonly<Record<PointerVariant, { readonly fill: Rgb; readonly edge: Rgb }>> = {
  dark: { fill: INK, edge: PAPER },
  light: { fill: PAPER, edge: INK },
};


const POINTER_UNITS = 20;
const POINTER_EDGE_UNITS = 1.55;
const SOFT_EDGE_PX = 0.9;

const ramp = (value: number) => Math.max(0, Math.min(1, value));

function inked(fill: Rgb, edge: Rgb, signedPx: number, halfEdgePx: number, opacity = 1): Rgba | null {
  const coverage = ramp(0.5 + (halfEdgePx - signedPx) / SOFT_EDGE_PX);
  if (coverage <= 0) return null;
  const filled = ramp(0.5 + (-halfEdgePx - signedPx) / SOFT_EDGE_PX);
  const mix = (channel: 0 | 1 | 2) => edge[channel] + (fill[channel] - edge[channel]) * filled;
  return [mix(0), mix(1), mix(2), coverage * opacity];
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
