import type { VideoSize } from "../core/device.ts";

const START_CODE = [0, 0, 0, 1] as const;
const I_PCM_IN_I_SLICE = 25;
const I_PCM_IN_P_SLICE = 30;
const SLICE_TYPE_P_ALL = 5;
const SLICE_TYPE_I_ALL = 7;
const NAL_SLICE = 1;
const NAL_IDR = 5;
const NAL_SPS = 7;
const NAL_PPS = 8;
const LOG2_MAX_FRAME_NUM = 16;
const MACROBLOCK = 16;
const LUMA_BYTES = MACROBLOCK * MACROBLOCK;
const CHROMA_SIDE = MACROBLOCK / 2;
const LOWEST_SAMPLE = 1;

class Bits {
  readonly #bytes: number[] = [];
  #current = 0;
  #filled = 0;

  bit(value: number): void {
    this.#current = (this.#current << 1) | (value & 1);
    this.#filled++;
    if (this.#filled === 8) {
      this.#bytes.push(this.#current);
      this.#current = 0;
      this.#filled = 0;
    }
  }

  bits(value: number, count: number): void {
    for (let shift = count - 1; shift >= 0; shift--) this.bit(Math.floor(value / 2 ** shift) & 1);
  }

  unsigned(value: number): void {
    const coded = value + 1;
    const length = Math.floor(Math.log2(coded));
    this.bits(0, length);
    this.bits(coded, length + 1);
  }

  signed(value: number): void {
    this.unsigned(value <= 0 ? -2 * value : 2 * value - 1);
  }

  alignWithZeros(): void {
    while (this.#filled !== 0) this.bit(0);
  }

  byte(value: number): void {
    this.bits(value, 8);
  }

  trailing(): void {
    this.bit(1);
    this.alignWithZeros();
  }

  get aligned(): boolean {
    return this.#filled === 0;
  }

  pushAligned(bytes: Uint8Array): void {
    for (const byte of bytes) this.#bytes.push(byte);
  }

  done(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }
}

function withEmulationPrevention(payload: Uint8Array): number[] {
  const out: number[] = [];
  let zeros = 0;
  for (const byte of payload) {
    if (zeros >= 2 && byte <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out;
}

function nal(referenceIdc: number, type: number, payload: Uint8Array): number[] {
  return [...START_CODE, (referenceIdc << 5) | type, ...withEmulationPrevention(payload)];
}

export interface YuvPicture {
  readonly width: number;
  readonly height: number;
  readonly luma: Uint8Array;
  readonly cb: Uint8Array;
  readonly cr: Uint8Array;
}

export function paddedSize(size: VideoSize): VideoSize {
  return { width: Math.ceil(size.width / MACROBLOCK) * MACROBLOCK, height: Math.ceil(size.height / MACROBLOCK) * MACROBLOCK };
}

export function yuvFromRgba(size: VideoSize, rgba: Uint8Array): YuvPicture {
  const padded = paddedSize(size);
  const luma = new Uint8Array(padded.width * padded.height).fill(16);
  const cb = new Uint8Array((padded.width / 2) * (padded.height / 2)).fill(128);
  const cr = new Uint8Array((padded.width / 2) * (padded.height / 2)).fill(128);
  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      const at = (y * size.width + x) * 4;
      const r = rgba[at]!;
      const g = rgba[at + 1]!;
      const b = rgba[at + 2]!;
      luma[y * padded.width + x] = Math.round(16 + 0.183 * r + 0.614 * g + 0.062 * b);
      if (x % 2 === 0 && y % 2 === 0) {
        const chroma = (y / 2) * (padded.width / 2) + x / 2;
        cb[chroma] = Math.round(128 - 0.101 * r - 0.339 * g + 0.439 * b);
        cr[chroma] = Math.round(128 + 0.439 * r - 0.399 * g - 0.04 * b);
      }
    }
  }
  return { width: padded.width, height: padded.height, luma, cb, cr };
}

function macroblockSamples(picture: YuvPicture, column: number, row: number): Uint8Array {
  const samples = new Uint8Array(LUMA_BYTES + 2 * CHROMA_SIDE * CHROMA_SIDE);
  let at = 0;
  for (let y = 0; y < MACROBLOCK; y++) {
    for (let x = 0; x < MACROBLOCK; x++) samples[at++] = picture.luma[(row * MACROBLOCK + y) * picture.width + column * MACROBLOCK + x]!;
  }
  const chromaWidth = picture.width / 2;
  for (const plane of [picture.cb, picture.cr]) {
    for (let y = 0; y < CHROMA_SIDE; y++) {
      for (let x = 0; x < CHROMA_SIDE; x++) samples[at++] = plane[(row * CHROMA_SIDE + y) * chromaWidth + column * CHROMA_SIDE + x]!;
    }
  }
  for (let index = 0; index < samples.length; index++) if (samples[index]! < LOWEST_SAMPLE) samples[index] = LOWEST_SAMPLE;
  return samples;
}

function sameMacroblock(a: YuvPicture, b: YuvPicture, column: number, row: number): boolean {
  const left = macroblockSamples(a, column, row);
  const right = macroblockSamples(b, column, row);
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

function levelFor(macroblocks: number): number {
  const levels: readonly (readonly [number, number])[] = [
    [1620, 30],
    [3600, 31],
    [5120, 32],
    [8192, 40],
    [8704, 42],
    [22080, 50],
    [36864, 51],
  ];
  return levels.find(([most]) => macroblocks <= most)?.[1] ?? 52;
}

export class PcmH264Encoder {
  readonly #size: VideoSize;
  readonly #columns: number;
  readonly #rows: number;
  #previous: YuvPicture | null = null;
  #frameNum = 0;
  #idrId = 0;

  constructor(size: VideoSize) {
    this.#size = size;
    const padded = paddedSize(size);
    this.#columns = padded.width / MACROBLOCK;
    this.#rows = padded.height / MACROBLOCK;
  }

  get size(): VideoSize {
    return this.#size;
  }

  #sequenceParameters(): number[] {
    const bits = new Bits();
    bits.byte(66);
    bits.bits(0b11000000, 8);
    bits.byte(levelFor(this.#columns * this.#rows));
    bits.unsigned(0);
    bits.unsigned(LOG2_MAX_FRAME_NUM - 4);
    bits.unsigned(2);
    bits.unsigned(1);
    bits.bit(0);
    bits.unsigned(this.#columns - 1);
    bits.unsigned(this.#rows - 1);
    bits.bit(1);
    bits.bit(1);
    const cropRight = (this.#columns * MACROBLOCK - this.#size.width) / 2;
    const cropBottom = (this.#rows * MACROBLOCK - this.#size.height) / 2;
    const cropped = cropRight > 0 || cropBottom > 0;
    bits.bit(cropped ? 1 : 0);
    if (cropped) {
      bits.unsigned(0);
      bits.unsigned(Math.floor(cropRight));
      bits.unsigned(0);
      bits.unsigned(Math.floor(cropBottom));
    }
    bits.bit(0);
    bits.trailing();
    return nal(3, NAL_SPS, bits.done());
  }

  #pictureParameters(): number[] {
    const bits = new Bits();
    bits.unsigned(0);
    bits.unsigned(0);
    bits.bit(0);
    bits.bit(0);
    bits.unsigned(0);
    bits.unsigned(0);
    bits.unsigned(0);
    bits.bit(0);
    bits.bits(0, 2);
    bits.signed(0);
    bits.signed(0);
    bits.signed(0);
    bits.bit(1);
    bits.bit(0);
    bits.bit(0);
    bits.trailing();
    return nal(3, NAL_PPS, bits.done());
  }

  #pcm(bits: Bits, samples: Uint8Array): void {
    bits.alignWithZeros();
    bits.pushAligned(samples);
  }

  #idr(picture: YuvPicture): number[] {
    const bits = new Bits();
    bits.unsigned(0);
    bits.unsigned(SLICE_TYPE_I_ALL);
    bits.unsigned(0);
    bits.bits(0, LOG2_MAX_FRAME_NUM);
    bits.unsigned(this.#idrId);
    bits.bit(0);
    bits.bit(0);
    bits.signed(0);
    bits.unsigned(1);
    for (let row = 0; row < this.#rows; row++) {
      for (let column = 0; column < this.#columns; column++) {
        bits.unsigned(I_PCM_IN_I_SLICE);
        this.#pcm(bits, macroblockSamples(picture, column, row));
      }
    }
    bits.trailing();
    return nal(3, NAL_IDR, bits.done());
  }

  #predicted(picture: YuvPicture, previous: YuvPicture): number[] | null {
    const bits = new Bits();
    bits.unsigned(0);
    bits.unsigned(SLICE_TYPE_P_ALL);
    bits.unsigned(0);
    bits.bits(this.#frameNum, LOG2_MAX_FRAME_NUM);
    bits.bit(0);
    bits.bit(0);
    bits.bit(0);
    bits.signed(0);
    bits.unsigned(1);
    let skipped = 0;
    let changed = 0;
    for (let row = 0; row < this.#rows; row++) {
      for (let column = 0; column < this.#columns; column++) {
        if (sameMacroblock(picture, previous, column, row)) {
          skipped++;
          continue;
        }
        bits.unsigned(skipped);
        skipped = 0;
        changed++;
        bits.unsigned(I_PCM_IN_P_SLICE);
        this.#pcm(bits, macroblockSamples(picture, column, row));
      }
    }
    if (changed === 0) return null;
    if (skipped > 0) bits.unsigned(skipped);
    bits.trailing();
    return nal(2, NAL_SLICE, bits.done());
  }

  encode(picture: YuvPicture, key: boolean): { readonly data: Uint8Array; readonly key: boolean } | null {
    const previous = this.#previous;
    if (key || !previous) {
      this.#frameNum = 0;
      const data = Uint8Array.from([...this.#sequenceParameters(), ...this.#pictureParameters(), ...this.#idr(picture)]);
      this.#idrId = (this.#idrId + 1) % 65536;
      this.#previous = picture;
      return { data, key: true };
    }
    this.#frameNum = (this.#frameNum + 1) % 2 ** LOG2_MAX_FRAME_NUM;
    const slice = this.#predicted(picture, previous);
    if (!slice) {
      this.#frameNum = (this.#frameNum + 2 ** LOG2_MAX_FRAME_NUM - 1) % 2 ** LOG2_MAX_FRAME_NUM;
      return null;
    }
    this.#previous = picture;
    return { data: Uint8Array.from(slice), key: false };
  }
}
