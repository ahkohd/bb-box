export const monoCipherGlyphs = "!<>-_\\/[]{}=+*^?#%$01";

const narrowLetters = "fijlrt1!|.,:;'";
const wideLetters = "mwMW@%";
const narrowGlyphs = "ijlt1!|:;";
const wideGlyphs = "MWmw#%@&";
const middleGlyphs = "ABCDEFGHKLNPRSTUVXYZabdeghknopqsuvxyz0234567892$?+<>";

export type GlyphsFor = (glyph: string) => string;

export const monoGlyphsFor: GlyphsFor = () => monoCipherGlyphs;

export const letterGlyphsFor: GlyphsFor = (glyph) => (narrowLetters.includes(glyph) ? narrowGlyphs : wideLetters.includes(glyph) ? wideGlyphs : middleGlyphs);

export interface CipherPiece {
  glyph: string;
  settled: boolean;
}

export function revealTimes(text: string, durationMs: number, random: () => number): number[] {
  const length = Math.max(1, text.length);
  return [...text].map((_, index) => (index / length) * durationMs * 0.7 + random() * durationMs * 0.3);
}

export function cipherFrame(text: string, elapsedMs: number, revealAt: readonly number[], glyphsFor: GlyphsFor, random: () => number): CipherPiece[] {
  return [...text].map((glyph, index) => {
    if (/\s/.test(glyph) || elapsedMs >= (revealAt[index] ?? 0)) return { glyph, settled: true };
    const choices = glyphsFor(glyph);
    return { glyph: choices[Math.floor(random() * choices.length)] ?? glyph, settled: false };
  });
}

export const cipherDuration = (text: string) => Math.min(1500, 380 + text.length * 34);
