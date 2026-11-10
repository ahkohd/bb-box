const fract = (value: number) => value - Math.floor(value);
const mix = (from: number, to: number, amount: number) => from + (to - from) * amount;
const smoothstep = (edge0: number, edge1: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

const hash = (x: number, y: number) => fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);

function noise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  return mix(mix(hash(ix, iy), hash(ix + 1, iy), ux), mix(hash(ix, iy + 1), hash(ix + 1, iy + 1), ux), uy);
}

function layered(x: number, y: number): number {
  let total = 0;
  let amount = 0.5;
  for (let octave = 0; octave < 4; octave++) {
    total += amount * noise(x, y);
    x = x * 2.03 + 1.7;
    y = y * 2.03 + 9.2;
    amount *= 0.5;
  }
  return total;
}

export interface StillFieldLook {
  lowest: number;
  quietLeft: number;
  leftFloor: number;
}

export function stillFieldValue(column: number, row: number, columns: number, rows: number, cellAspect: number, look: StillFieldLook): number {
  const seconds = 40;
  const u = ((column + 0.5) * cellAspect) / rows;
  const v = (row + 0.5) / rows;
  const t = seconds * 0.045;
  const driftX = t;
  const driftY = t * 0.35;
  const warpX = layered(u * 1.3 + driftX, v * 1.3 + driftY);
  const warpY = layered(u * 1.3 + 5.2 - driftX, v * 1.3 + 1.3 - driftY);
  const far = smoothstep(look.lowest, 0.82, layered(u * 1.05 + warpX * 1.7 + driftX * 0.4, v * 1.05 + warpY * 1.7 + driftY * 0.4));
  const near = smoothstep(0.58, 0.92, layered(u * 3.1 + warpX * 0.9 - driftX * 1.6, v * 3.1 + warpY * 0.9 - driftY * 1.6));
  const height = (row + 0.5) / rows;
  const across = (column + 0.5) / columns;
  const toLeft = look.leftFloor + (1 - look.leftFloor) * smoothstep(0.1, 0.7, across);
  return Math.min(1, (far * 0.8 + near * 0.45) * smoothstep(0, 0.75, height) * mix(1, toLeft, look.quietLeft));
}
