const ruleRamp = " .·:-=+*";

export function glyphRule(seed: number, length: number): string {
  return Array.from({ length }, (_, index) => {
    const swell = 0.5 + 0.5 * Math.sin(index * 0.071 + seed) * Math.sin(index * 0.023 + seed * 1.7);
    const grain = 0.5 + 0.5 * Math.sin(index * 12.9898 + seed * 78.233);
    const level = Math.min(ruleRamp.length - 1, Math.floor((swell * 0.8 + grain * 0.25) * ruleRamp.length));
    return ruleRamp[Math.max(0, level)]!;
  }).join("");
}
