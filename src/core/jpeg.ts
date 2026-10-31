import type { RgbaPixels } from "./png.ts";

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54,
  47, 55, 62, 63,
];

const LUMA_QUANTISATION = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120,
  101, 72, 92, 95, 98, 112, 100, 103, 99,
];

const CHROMA_QUANTISATION = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99,
];

interface HuffmanSpec {
  readonly counts: readonly number[];
  readonly symbols: readonly number[];
}

const LUMA_DC: HuffmanSpec = { counts: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], symbols: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const CHROMA_DC: HuffmanSpec = { counts: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], symbols: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };

const LUMA_AC: HuffmanSpec = {
  counts: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  symbols: [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82,
    0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63,
    0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6,
    0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6,
    0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
};

const CHROMA_AC: HuffmanSpec = {
  counts: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  symbols: [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a,
    0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a,
    0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4,
    0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5,
    0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
};

interface Code {
  readonly bits: number;
  readonly length: number;
}

type CodeTable = ReadonlyMap<number, Code>;

function codesOf(spec: HuffmanSpec): CodeTable {
  const codes = new Map<number, Code>();
  let code = 0;
  let next = 0;
  for (let length = 1; length <= 16; length++) {
    for (let count = 0; count < spec.counts[length - 1]!; count++) codes.set(spec.symbols[next++]!, { bits: code++, length });
    code <<= 1;
  }
  return codes;
}

const LUMA_DC_CODES = codesOf(LUMA_DC);
const LUMA_AC_CODES = codesOf(LUMA_AC);
const CHROMA_DC_CODES = codesOf(CHROMA_DC);
const CHROMA_AC_CODES = codesOf(CHROMA_AC);

const COSINES = Array.from({ length: 64 }, (_, index) => {
  const frequency = index >> 3;
  const position = index & 7;
  return Math.cos(((2 * position + 1) * frequency * Math.PI) / 16);
});

function scaledTable(base: readonly number[], quality: number): number[] {
  const bounded = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = bounded < 50 ? 5000 / bounded : 200 - 2 * bounded;
  return base.map((value) => Math.min(255, Math.max(1, Math.floor((value * scale + 50) / 100))));
}

class BitWriter {
  readonly #bytes: number[] = [];
  #buffer = 0;
  #count = 0;

  write(bits: number, length: number): void {
    for (let bit = length - 1; bit >= 0; bit--) {
      this.#buffer = (this.#buffer << 1) | ((bits >> bit) & 1);
      this.#count++;
      if (this.#count === 8) this.#flushByte();
    }
  }

  #flushByte(): void {
    this.#bytes.push(this.#buffer);
    if (this.#buffer === 0xff) this.#bytes.push(0);
    this.#buffer = 0;
    this.#count = 0;
  }

  finish(): number[] {
    if (this.#count) this.write((1 << (8 - this.#count)) - 1, 8 - this.#count);
    return this.#bytes;
  }
}

function magnitudeLength(value: number): number {
  let magnitude = Math.abs(value);
  let length = 0;
  while (magnitude) {
    length++;
    magnitude >>= 1;
  }
  return length;
}

function writeValue(writer: BitWriter, value: number, length: number): void {
  if (length) writer.write(value < 0 ? value + (1 << length) - 1 : value, length);
}

function writeCode(writer: BitWriter, table: CodeTable, symbol: number): void {
  const code = table.get(symbol)!;
  writer.write(code.bits, code.length);
}

function quantised(samples: Float64Array, table: readonly number[]): Int32Array {
  const coefficients = new Int32Array(64);
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let y = 0; y < 8; y++) {
        const down = COSINES[v * 8 + y]!;
        for (let x = 0; x < 8; x++) sum += samples[y * 8 + x]! * COSINES[u * 8 + x]! * down;
      }
      const weight = (u ? 1 : Math.SQRT1_2) * (v ? 1 : Math.SQRT1_2) * 0.25;
      coefficients[v * 8 + u] = Math.round((sum * weight) / table[v * 8 + u]!);
    }
  }
  return coefficients;
}

function encodeBlock(writer: BitWriter, samples: Float64Array, table: readonly number[], previousDc: number, dcCodes: CodeTable, acCodes: CodeTable): number {
  const coefficients = quantised(samples, table);
  const dc = coefficients[0]!;
  const difference = dc - previousDc;
  const dcLength = magnitudeLength(difference);
  writeCode(writer, dcCodes, dcLength);
  writeValue(writer, difference, dcLength);
  let zeros = 0;
  for (let index = 1; index < 64; index++) {
    const value = coefficients[ZIGZAG[index]!]!;
    if (!value) {
      zeros++;
      continue;
    }
    while (zeros > 15) {
      writeCode(writer, acCodes, 0xf0);
      zeros -= 16;
    }
    const length = magnitudeLength(value);
    writeCode(writer, acCodes, (zeros << 4) | length);
    writeValue(writer, value, length);
    zeros = 0;
  }
  if (zeros) writeCode(writer, acCodes, 0x00);
  return dc;
}

function segment(marker: number, body: readonly number[]): number[] {
  const length = body.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...body];
}

function huffmanSegment(tableClass: number, id: number, spec: HuffmanSpec): number[] {
  return [(tableClass << 4) | id, ...spec.counts, ...spec.symbols];
}

export function jpegOf(pixels: RgbaPixels, quality: number): Buffer {
  const { width, height, rgba } = pixels;
  const luma = scaledTable(LUMA_QUANTISATION, quality);
  const chroma = scaledTable(CHROMA_QUANTISATION, quality);
  const yPlane = new Float64Array(width * height);
  const cbPlane = new Float64Array(width * height);
  const crPlane = new Float64Array(width * height);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const r = rgba[pixel * 4]!;
    const g = rgba[pixel * 4 + 1]!;
    const b = rgba[pixel * 4 + 2]!;
    yPlane[pixel] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
    cbPlane[pixel] = -0.168736 * r - 0.331264 * g + 0.5 * b;
    crPlane[pixel] = 0.5 * r - 0.418688 * g - 0.081312 * b;
  }
  const at = (plane: Float64Array, x: number, y: number) => plane[Math.min(height - 1, y) * width + Math.min(width - 1, x)]!;
  const writer = new BitWriter();
  const block = new Float64Array(64);
  let previous = [0, 0, 0];
  for (let top = 0; top < height; top += 16) {
    for (let left = 0; left < width; left += 16) {
      for (const [dx, dy] of [[0, 0], [8, 0], [0, 8], [8, 8]] as const) {
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) block[y * 8 + x] = at(yPlane, left + dx + x, top + dy + y);
        previous = [encodeBlock(writer, block, luma, previous[0]!, LUMA_DC_CODES, LUMA_AC_CODES), previous[1]!, previous[2]!];
      }
      for (const [component, plane] of [[1, cbPlane], [2, crPlane]] as const) {
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const sx = left + x * 2;
            const sy = top + y * 2;
            block[y * 8 + x] = (at(plane, sx, sy) + at(plane, sx + 1, sy) + at(plane, sx, sy + 1) + at(plane, sx + 1, sy + 1)) / 4;
          }
        }
        const dc = encodeBlock(writer, block, chroma, previous[component]!, CHROMA_DC_CODES, CHROMA_AC_CODES);
        previous = component === 1 ? [previous[0]!, dc, previous[2]!] : [previous[0]!, previous[1]!, dc];
      }
    }
  }
  const quantisation = [0, ...ZIGZAG.map((index) => luma[index]!), 1, ...ZIGZAG.map((index) => chroma[index]!)];
  const frame = [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  const huffman = [...huffmanSegment(0, 0, LUMA_DC), ...huffmanSegment(1, 0, LUMA_AC), ...huffmanSegment(0, 1, CHROMA_DC), ...huffmanSegment(1, 1, CHROMA_AC)];
  const scan = [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0];
  return Buffer.from([
    0xff,
    0xd8,
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(0xdb, quantisation),
    ...segment(0xc0, frame),
    ...segment(0xc4, huffman),
    ...segment(0xda, scan),
    ...writer.finish(),
    0xff,
    0xd9,
  ]);
}
