export const DEFAULT_EXPLORER_PX = 360;
export const NARROW_BELOW_PX = 700;

export function showsOneSurface(frameWidth: number): boolean {
  return frameWidth < NARROW_BELOW_PX;
}
