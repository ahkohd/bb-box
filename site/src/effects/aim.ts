export type AimShape = "frame" | "underline";

export interface AimBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Aim extends AimBox {
  corner: number;
}

const clamp = (least: number, value: number, most: number) => Math.min(most, Math.max(least, value));

export function aimFor(shape: AimShape, target: AimBox): Aim {
  const shortSide = Math.min(target.width, target.height);
  if (shape === "underline") {
    const below = target.top + target.height + 1;
    return { left: target.left - 2, top: below, width: target.width + 4, height: 4, corner: clamp(4, target.width * 0.25, 9) };
  }
  const reach = clamp(4, shortSide * 0.15, 7);
  const sideReach = reach + 2;
  return {
    left: target.left - sideReach,
    top: target.top - reach,
    width: target.width + sideReach * 2,
    height: target.height + reach * 2,
    corner: clamp(5, shortSide * 0.3, 12),
  };
}
