import type { TouchContact, VideoSize } from "../core/device.ts";

const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;

const FONT: Readonly<Record<string, string>> = {
  A: "01110100011000111111100011000110001",
  B: "11110100011000111110100011000111110",
  C: "01110100011000010000100001000101110",
  D: "11110100011000110001100011000111110",
  E: "11111100001000011110100001000011111",
  F: "11111100001000011110100001000010000",
  G: "01110100011000010111100011000101111",
  H: "10001100011000111111100011000110001",
  I: "01110001000010000100001000010001110",
  J: "00111000100001000010000101001001100",
  K: "10001100101010011000101001001010001",
  L: "10000100001000010000100001000011111",
  M: "10001110111010110101100011000110001",
  N: "10001100011100110101100111000110001",
  O: "01110100011000110001100011000101110",
  P: "11110100011000111110100001000010000",
  Q: "01110100011000110001101011001001101",
  R: "11110100011000111110101001001010001",
  S: "01111100001000001110000010000111110",
  T: "11111001000010000100001000010000100",
  U: "10001100011000110001100011000101110",
  V: "10001100011000110001100010101000100",
  W: "10001100011000110101101011010101010",
  X: "10001100010101000100010101000110001",
  Y: "10001100010101000100001000010000100",
  Z: "11111000010001000100010001000011111",
  "0": "01110100011001110101110011000101110",
  "1": "00100011000010000100001000010001110",
  "2": "01110100010000100010001000100011111",
  "3": "11111000100010000010000011000101110",
  "4": "00010001100101010010111110001000010",
  "5": "11111100001111000001000011000101110",
  "6": "00110010001000011110100011000101110",
  "7": "11111000010001000100010000100001000",
  "8": "01110100011000101110100011000101110",
  "9": "01110100011000101111000010001001100",
  ":": "00000011000110000000011000110000000",
  ".": "00000000000000000000000000110001100",
  "-": "00000000000000011111000000000000000",
  "(": "00010001000100001000010000010000010",
  ")": "01000001000001000010000100010001000",
  "/": "00001000010001000100010001000010000",
  " ": "00000000000000000000000000000000000",
};

export interface Colour {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export const CARD_COLOURS = {
  light: { background: { r: 236, g: 238, b: 242 }, ink: { r: 24, g: 28, b: 36 }, band: { r: 46, g: 110, b: 230 } },
  dark: { background: { r: 18, g: 20, b: 26 }, ink: { r: 230, g: 232, b: 238 }, band: { r: 250, g: 160, b: 40 } },
} as const;

export const TOUCH_COLOUR: Colour = { r: 220, g: 40, b: 60 };

export interface CardContent {
  readonly size: VideoSize;
  readonly appearance: "light" | "dark";
  readonly lines: readonly string[];
  readonly clock: string;
  readonly touches: readonly TouchContact[];
}

export class Canvas {
  readonly size: VideoSize;
  readonly rgba: Uint8Array;

  constructor(size: VideoSize, fill: Colour) {
    this.size = size;
    this.rgba = new Uint8Array(size.width * size.height * 4);
    this.rect(0, 0, size.width, size.height, fill);
  }

  rect(x: number, y: number, width: number, height: number, colour: Colour): void {
    const left = Math.max(0, Math.floor(x));
    const top = Math.max(0, Math.floor(y));
    const right = Math.min(this.size.width, Math.floor(x + width));
    const bottom = Math.min(this.size.height, Math.floor(y + height));
    for (let row = top; row < bottom; row++) {
      for (let column = left; column < right; column++) {
        const at = (row * this.size.width + column) * 4;
        this.rgba[at] = colour.r;
        this.rgba[at + 1] = colour.g;
        this.rgba[at + 2] = colour.b;
        this.rgba[at + 3] = 255;
      }
    }
  }

  disc(centreX: number, centreY: number, radius: number, colour: Colour): void {
    for (let dy = -radius; dy <= radius; dy++) {
      const half = Math.floor(Math.sqrt(radius * radius - dy * dy));
      this.rect(centreX - half, centreY + dy, half * 2 + 1, 1, colour);
    }
  }

  text(words: string, x: number, y: number, scale: number, colour: Colour): void {
    let left = x;
    for (const character of words.toUpperCase()) {
      const glyph = FONT[character] ?? FONT[" "]!;
      for (let row = 0; row < GLYPH_HEIGHT; row++) {
        for (let column = 0; column < GLYPH_WIDTH; column++) {
          if (glyph[row * GLYPH_WIDTH + column] === "1") this.rect(left + column * scale, y + row * scale, scale, scale, colour);
        }
      }
      left += (GLYPH_WIDTH + 1) * scale;
    }
  }
}

export function textWidth(words: string, scale: number): number {
  return words.length * (GLYPH_WIDTH + 1) * scale - scale;
}

function cardScale(size: VideoSize): number {
  return Math.max(2, Math.floor(size.width / 90));
}

export function cardLine(words: string, size: VideoSize): string {
  const scale = cardScale(size);
  const fits = Math.max(1, Math.floor((size.width - scale * 8) / ((GLYPH_WIDTH + 1) * scale)));
  const shown = [...words.toUpperCase()].map((character) => (FONT[character] ? character : character.trim() ? "/" : " ")).join("");
  return shown.length > fits ? shown.slice(0, fits) : shown;
}

export function drawCard(content: CardContent): Canvas {
  const colours = CARD_COLOURS[content.appearance];
  const { width, height } = content.size;
  const canvas = new Canvas(content.size, colours.background);
  const scale = cardScale(content.size);
  const lineHeight = (GLYPH_HEIGHT + 4) * scale;
  canvas.rect(0, 0, width, Math.round(height / 8), colours.band);
  const title = "TEST DEVICE";
  const titleScale = Math.max(1, Math.min(scale * 2, Math.floor((width * 0.9) / ((GLYPH_WIDTH + 1) * title.length))));
  canvas.text(title, Math.round((width - textWidth(title, titleScale)) / 2), Math.round(height / 16 - (GLYPH_HEIGHT * titleScale) / 2), titleScale, colours.background);
  let y = Math.round(height / 8) + lineHeight;
  for (const line of content.lines) {
    canvas.text(line, scale * 4, y, scale, colours.ink);
    y += lineHeight;
  }
  const clockFits = Math.floor((width * 0.9) / ((GLYPH_WIDTH + 1) * Math.max(1, content.clock.length)));
  const clockScale = Math.max(1, Math.min(scale * 3, clockFits));
  canvas.text(content.clock, Math.round((width - textWidth(content.clock, clockScale)) / 2), Math.round(height * 0.6), clockScale, colours.ink);
  for (const touch of content.touches) canvas.disc(Math.round(touch.x), Math.round(touch.y), Math.max(6, scale * 4), TOUCH_COLOUR);
  return canvas;
}
