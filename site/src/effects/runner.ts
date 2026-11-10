export type ObstacleKind = "spike" | "spikes" | "crate";

export interface Obstacle {
  kind: ObstacleKind;
  glyphs: string;
  centre: number;
}

export interface Pose {
  lift: number;
  turn: number;
}

export const run = {
  pxPerSecond: 170,
  segmentPx: 260,
  firstSegment: 1,
  jumpSeconds: 0.5,
  jumpPx: 30,
  wobblePx: 90,
};

const glyphsOf: Record<ObstacleKind, string> = { spike: "/\\", spikes: "/\\/\\", crate: "[#]" };

export function hashed(index: number, salt: number): number {
  const value = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453;
  return value - Math.floor(value);
}

export function obstacle(index: number): Obstacle {
  const pick = hashed(index, 2);
  const kind: ObstacleKind = pick < 0.45 ? "spike" : pick < 0.75 ? "spikes" : "crate";
  return { kind, glyphs: glyphsOf[kind], centre: index * run.segmentPx + hashed(index, 1) * run.wobblePx };
}

export const travelled = (seconds: number) => seconds * run.pxPerSecond;

const apexSeconds = (centre: number, runnerX: number) => (centre - runnerX) / run.pxPerSecond;

export function pose(seconds: number, runnerX: number): Pose {
  const near = Math.round((runnerX + travelled(seconds)) / run.segmentPx);
  for (let index = Math.max(run.firstSegment, near - 1); index <= near + 1; index++) {
    const start = apexSeconds(obstacle(index).centre, runnerX) - run.jumpSeconds / 2;
    const progress = (seconds - start) / run.jumpSeconds;
    if (progress < 0 || progress > 1) continue;
    const eased = progress * progress * (3 - 2 * progress);
    return { lift: 4 * run.jumpPx * progress * (1 - progress), turn: eased * (Math.PI / 2) };
  }
  return { lift: 0, turn: 0 };
}

export function obstaclesBetween(fromX: number, toX: number): Obstacle[] {
  const first = Math.max(run.firstSegment, Math.floor(fromX / run.segmentPx) - 1);
  const last = Math.ceil(toX / run.segmentPx) + 1;
  const found: Obstacle[] = [];
  for (let index = first; index <= last; index++) found.push(obstacle(index));
  return found;
}
