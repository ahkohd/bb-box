export function clampPercentage(value: number): number {
  return Math.min(100, Math.max(0, value));
}
