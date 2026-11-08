import { rgbaPng } from "./png.ts";
import type { Art } from "./record-art.ts";

export type MarkKind = "keyboard" | "play" | "check" | "failed" | "warn" | "cut";

export const MARK_EM = 1.1;

type Point = readonly [number, number];

interface MarkPart {
  readonly d: string;
  readonly stroke: number;
}

const VIEW = 18;

const MARKS: Readonly<Record<MarkKind, readonly MarkPart[]>> = {
  keyboard: [
    {
      d: "M15.25,4H2.75c-1.517,0-2.75,1.233-2.75,2.75v4.5c0,1.517,1.233,2.75,2.75,2.75H15.25c1.517,0,2.75-1.233,2.75-2.75V6.75c0-1.517-1.233-2.75-2.75-2.75Zm-7,3.5c0-.276,.224-.5,.5-.5h.5c.276,0,.5,.224,.5,.5v.5c0,.276-.224,.5-.5,.5h-.5c-.276,0-.5-.224-.5-.5v-.5Zm-2.75,0c0-.276,.224-.5,.5-.5h.5c.276,0,.5,.224,.5,.5v.5c0,.276-.224,.5-.5,.5h-.5c-.276,0-.5-.224-.5-.5v-.5Zm-1,3c0,.276-.224,.5-.5,.5h-.5c-.276,0-.5-.224-.5-.5v-.5c0-.276,.224-.5,.5-.5h.5c.276,0,.5,.224,.5,.5v.5Zm0-2.5c0,.276-.224,.5-.5,.5h-.5c-.276,0-.5-.224-.5-.5v-.5c0-.276,.224-.5,.5-.5h.5c.276,0,.5,.224,.5,.5v.5Zm7.25,3H6.25c-.414,0-.75-.336-.75-.75s.336-.75,.75-.75h5.5c.414,0,.75,.336,.75,.75s-.336,.75-.75,.75Zm.75-3c0,.276-.224,.5-.5,.5h-.5c-.276,0-.5-.224-.5-.5v-.5c0-.276,.224-.5,.5-.5h.5c.276,0,.5,.224,.5,.5v.5Zm2.5,2.5c0,.276-.224,.5-.5,.5h-.5c-.276,0-.5-.224-.5-.5v-.5c0-.276,.224-.5,.5-.5h.5c.276,0,.5,.224,.5,.5v.5Zm0-2.5c0,.276-.224,.5-.5,.5h-.5c-.276,0-.5-.224-.5-.5v-.5c0-.276,.224-.5,.5-.5h.5c.276,0,.5,.224,.5,.5v.5Z",
      stroke: 0,
    },
  ],
  play: [
    {
      d: "M15.1,7.478L5.608,2.222c-.553-.306-1.206-.297-1.749,.023-.538,.317-.859,.877-.859,1.499V14.256c0,.622,.321,1.182,.859,1.499,.279,.164,.586,.247,.895,.247,.293,0,.586-.075,.854-.223l9.491-5.256c.556-.307,.901-.891,.901-1.522s-.345-1.215-.9-1.522Z",
      stroke: 0,
    },
  ],
  check: [
    {
      d: "M6.75009 15H6.74808C6.52058 14.9995 6.30668 14.896 6.16408 14.7188L2.16408 9.7188C1.90528 9.3951 1.95798 8.92339 2.28128 8.66459C2.60548 8.40679 3.07618 8.4576 3.33598 8.7813L6.75398 13.0538L14.6671 3.27839C14.9278 2.95559 15.4015 2.9073 15.7218 3.1671C16.0441 3.4278 16.0939 3.9 15.8331 4.2218L7.33308 14.7218C7.19048 14.8981 6.97669 15 6.75009 15Z",
      stroke: 0,
    },
  ],
  failed: [
    { d: "M14 4L4 14", stroke: 2.25 },
    { d: "M4 4L14 14", stroke: 2.25 },
  ],
  warn: [
    {
      d: "M16.4364 12.5151L11.0101 3.11316C10.5902 2.39096 9.83872 1.96045 8.99982 1.96045C8.16092 1.96045 7.40952 2.39106 6.98952 3.11316C6.98902 3.11366 6.98902 3.11473 6.98852 3.11523L1.56272 12.5156C1.14332 13.2436 1.14332 14.1128 1.56372 14.8398C1.98362 15.5664 2.73562 16 3.57492 16H14.4245C15.2639 16 16.0158 15.5664 16.4357 14.8398C16.8561 14.1127 16.8563 13.2436 16.4364 12.5151ZM8.24992 6.75C8.24992 6.3359 8.58582 6 8.99992 6C9.41402 6 9.74992 6.3359 9.74992 6.75V9.75C9.74992 10.1641 9.41402 10.5 8.99992 10.5C8.58582 10.5 8.24992 10.1641 8.24992 9.75V6.75ZM8.99992 13.5C8.44792 13.5 7.99992 13.0498 7.99992 12.5C7.99992 11.9502 8.44792 11.5 8.99992 11.5C9.55192 11.5 9.99992 11.9502 9.99992 12.5C9.99992 13.0498 9.55192 13.5 8.99992 13.5Z",
      stroke: 0,
    },
  ],
  cut: [
    {
      d: "M17.355,7.906L9.855,3.75c-.391-.216-.855-.21-1.239,.017-.386,.227-.616,.63-.616,1.077v2.311L1.855,3.751c-.392-.217-.855-.21-1.24,.016-.386,.227-.616,.63-.616,1.077V13.156c0,.447,.23,.85,.616,1.077,.197,.116,.416,.175,.634,.175,.208,0,.415-.053,.605-.158l6.145-3.405v2.311c0,.447,.23,.85,.616,1.077,.197,.116,.416,.175,.634,.175,.208,0,.415-.053,.605-.158l7.5-4.156c.397-.22,.645-.639,.645-1.094s-.247-.874-.645-1.094Z",
      stroke: 0,
    },
  ],
};

const ARGUMENTS: Readonly<Record<string, number>> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Z: 0 };

function tokens(d: string): string[] {
  return d.match(/[MmLlHhVvCcSsZz]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) ?? [];
}

function curves(from: Point, c1: Point, c2: Point, to: Point, into: Point[]): void {
  const steps = 12;
  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    const u = 1 - t;
    into.push([
      u ** 3 * from[0] + 3 * u ** 2 * t * c1[0] + 3 * u * t ** 2 * c2[0] + t ** 3 * to[0],
      u ** 3 * from[1] + 3 * u ** 2 * t * c1[1] + 3 * u * t ** 2 * c2[1] + t ** 3 * to[1],
    ]);
  }
}

function pathsOf(d: string): Point[][] {
  const parts = tokens(d);
  const paths: Point[][] = [];
  let index = 0;
  let op = "";
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let cx = 0;
  let cy = 0;
  let current: Point[] = [];
  while (index < parts.length) {
    if (/^[A-Za-z]$/.test(parts[index]!)) op = parts[index++]!;
    if (!op) break;
    const relative = op === op.toLowerCase();
    if (op === "Z" || op === "z") {
      current.push([sx, sy]);
      paths.push(current);
      current = [];
      x = sx;
      y = sy;
      cx = x;
      cy = y;
      continue;
    }
    const count = ARGUMENTS[op.toUpperCase()] ?? 0;
    if (index + count > parts.length) break;
    const args = parts.slice(index, index + count).map(Number);
    index += count;
    const at = (value: number, origin: number) => (relative ? origin + value : value);
    if (op === "M" || op === "m") {
      if (current.length) paths.push(current);
      x = at(args[0]!, x);
      y = at(args[1]!, y);
      sx = x;
      sy = y;
      cx = x;
      cy = y;
      current = [[x, y]];
      op = relative ? "l" : "L";
    } else if (op === "L" || op === "l") {
      x = at(args[0]!, x);
      y = at(args[1]!, y);
      current.push([x, y]);
      cx = x;
      cy = y;
    } else if (op === "H" || op === "h") {
      x = at(args[0]!, x);
      current.push([x, y]);
      cx = x;
      cy = y;
    } else if (op === "V" || op === "v") {
      y = at(args[0]!, y);
      current.push([x, y]);
      cx = x;
      cy = y;
    } else {
      const smooth = op === "S" || op === "s";
      const c1: Point = smooth ? [2 * x - cx, 2 * y - cy] : [at(args[0]!, x), at(args[1]!, y)];
      const c2: Point = smooth ? [at(args[0]!, x), at(args[1]!, y)] : [at(args[2]!, x), at(args[3]!, y)];
      const to: Point = smooth ? [at(args[2]!, x), at(args[3]!, y)] : [at(args[4]!, x), at(args[5]!, y)];
      curves([x, y], c1, c2, to, current);
      cx = c2[0];
      cy = c2[1];
      x = to[0];
      y = to[1];
    }
  }
  if (current.length) paths.push(current);
  return paths;
}

function fillMask(width: number, height: number, paths: readonly (readonly Point[])[]): Uint8Array {
  const out = new Uint8Array(width * height);
  const edges = paths.flatMap((path) => path.slice(0, -1).map((from, at) => [from, path[at + 1]!] as const));
  for (let py = 0; py < height; py++) {
    const y = py + 0.5;
    const hits: number[] = [];
    for (const [from, to] of edges) {
      const [x1, y1] = from;
      const [x2, y2] = to;
      if (!((y1 <= y && y2 > y) || (y2 <= y && y1 > y))) continue;
      hits.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    }
    hits.sort((left, right) => left - right);
    for (let hit = 0; hit + 1 < hits.length; hit += 2) {
      const start = Math.max(0, Math.ceil(hits[hit]! - 0.5));
      const end = Math.min(width, Math.ceil(hits[hit + 1]! - 0.5));
      for (let px = start; px < end; px++) out[py * width + px] = 1;
    }
  }
  return out;
}

function covered(width: number, height: number, paths: readonly (readonly Point[])[]): Float32Array {
  const bigW = width * 2;
  const bigH = height * 2;
  const binary = fillMask(bigW, bigH, paths.map((path) => path.map(([px, py]) => [px * 2, py * 2] as const)));
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

function strokeCover(width: number, height: number, paths: readonly (readonly Point[])[], radius: number): Float32Array {
  const out = new Float32Array(width * height);
  const pad = radius + 1;
  const segments = paths.flatMap((path) => path.slice(0, -1).map((from, at) => [from[0], from[1], path[at + 1]![0], path[at + 1]![1]] as const));
  for (const [x1, y1, x2, y2] of segments) {
    const minX = Math.max(0, Math.floor(Math.min(x1, x2) - pad));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(x1, x2) + pad));
    const minY = Math.max(0, Math.floor(Math.min(y1, y2) - pad));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(y1, y2) + pad));
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy || 1;
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const qx = px + 0.5;
        const qy = py + 0.5;
        const u = Math.max(0, Math.min(1, ((qx - x1) * dx + (qy - y1) * dy) / len2));
        const dist = Math.hypot(qx - (x1 + u * dx), qy - (y1 + u * dy));
        const cover = Math.max(0, Math.min(1, radius + 0.5 - dist));
        const at = py * width + px;
        if (cover > out[at]!) out[at] = cover;
      }
    }
  }
  return out;
}

function paint(width: number, height: number, cover: Float32Array, rgb: readonly [number, number, number]): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < cover.length; i++) {
    const alpha = cover[i]!;
    if (alpha <= 0) continue;
    const at = i * 4;
    rgba[at] = rgb[0];
    rgba[at + 1] = rgb[1];
    rgba[at + 2] = rgb[2];
    rgba[at + 3] = Math.round(Math.min(1, alpha) * 255);
  }
  return rgba;
}

export interface Mark extends Art {
  readonly display: number;
}

const drawn = new Map<string, Mark>();

export function markArt(kind: MarkKind, fontSize: number, rgb: readonly [number, number, number]): Mark {
  const display = Math.max(2, Math.round(fontSize * MARK_EM));
  const key = `${kind}:${display}:${rgb.join(",")}`;
  const hit = drawn.get(key);
  if (hit) return hit;
  const size = display * 2;
  const scale = size / VIEW;
  const cover = new Float32Array(size * size);
  const lay = (next: Float32Array) => {
    for (let i = 0; i < cover.length; i++) cover[i] = Math.max(cover[i]!, next[i]!);
  };
  for (const part of MARKS[kind]) {
    const paths = pathsOf(part.d).map((path) => path.map(([x, y]) => [x * scale, y * scale] as const));
    lay(part.stroke > 0 ? strokeCover(size, size, paths, (part.stroke / 2) * scale) : covered(size, size, paths));
  }
  const art: Mark = { name: `mark-${kind}-${display}.png`, png: rgbaPng(size, size, paint(size, size, cover, rgb)), width: size, height: size, display };
  drawn.set(key, art);
  return art;
}

export function markRgb(hex: string): readonly [number, number, number] {
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}
