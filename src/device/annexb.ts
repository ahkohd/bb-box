import type { VideoSize } from "../core/device.ts";

export const NAL_TYPES = { slice: 1, idr: 5, sei: 6, sps: 7, pps: 8, delimiter: 9 } as const;

export interface NalUnit {
  readonly type: number;
  readonly body: Uint8Array;
}

export function nalUnits(data: Uint8Array): NalUnit[] {
  const starts: { readonly at: number; readonly code: number }[] = [];
  for (let at = 0; at + 2 < data.length; at++) {
    if (data[at] !== 0 || data[at + 1] !== 0) continue;
    if (data[at + 2] === 1) {
      starts.push({ at, code: 3 });
      at += 2;
    } else if (data[at + 2] === 0 && data[at + 3] === 1) {
      starts.push({ at, code: 4 });
      at += 3;
    }
  }
  return starts.flatMap((start, index) => {
    const from = start.at + start.code;
    let to = starts[index + 1]?.at ?? data.length;
    while (to > from && data[to - 1] === 0) to--;
    return to > from ? [{ type: data[from]! & 0x1f, body: data.subarray(from, to) }] : [];
  });
}

export function startsWithStartCode(data: Uint8Array): boolean {
  return data[0] === 0 && data[1] === 0 && (data[2] === 1 || (data[2] === 0 && data[3] === 1));
}

export function hasPicture(units: readonly NalUnit[]): boolean {
  return units.some((unit) => unit.type === NAL_TYPES.slice || unit.type === NAL_TYPES.idr);
}

export function isKeyFrame(units: readonly NalUnit[]): boolean {
  return units.some((unit) => unit.type === NAL_TYPES.idr) && units.some((unit) => unit.type === NAL_TYPES.sps) && units.some((unit) => unit.type === NAL_TYPES.pps);
}

function withoutEmulationPrevention(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length);
  let length = 0;
  let zeros = 0;
  for (const byte of body) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    out[length++] = byte;
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, length);
}

class BitReader {
  readonly #bytes: Uint8Array;
  #bit = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  bit(): number {
    const byte = this.#bytes[this.#bit >> 3];
    if (byte === undefined) throw new RangeError("The SPS ends early.");
    const value = (byte >> (7 - (this.#bit & 7))) & 1;
    this.#bit++;
    return value;
  }

  bits(count: number): number {
    let value = 0;
    for (let index = 0; index < count; index++) value = value * 2 + this.bit();
    return value;
  }

  unsigned(): number {
    let zeros = 0;
    while (this.bit() === 0) if (++zeros > 31) throw new RangeError("An SPS field is longer than 32 bits.");
    return 2 ** zeros - 1 + this.bits(zeros);
  }

  signed(): number {
    const value = this.unsigned();
    return value % 2 ? (value + 1) / 2 : -value / 2;
  }
}

const PROFILES_WITH_CHROMA = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

function skipScalingList(reader: BitReader, size: number): void {
  let last = 8;
  let next = 8;
  for (let index = 0; index < size; index++) {
    if (next !== 0) next = (last + reader.signed() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

export function spsPictureSize(sps: NalUnit): VideoSize | null {
  if (sps.type !== NAL_TYPES.sps) return null;
  try {
    const reader = new BitReader(withoutEmulationPrevention(sps.body.subarray(1)));
    const profile = reader.bits(8);
    reader.bits(16);
    reader.unsigned();
    let chromaFormat = 1;
    if (PROFILES_WITH_CHROMA.has(profile)) {
      chromaFormat = reader.unsigned();
      if (chromaFormat === 3) reader.bit();
      reader.unsigned();
      reader.unsigned();
      reader.bit();
      if (reader.bit()) for (let index = 0; index < (chromaFormat === 3 ? 12 : 8); index++) if (reader.bit()) skipScalingList(reader, index < 6 ? 16 : 64);
    }
    reader.unsigned();
    const pictureOrder = reader.unsigned();
    if (pictureOrder === 0) reader.unsigned();
    else if (pictureOrder === 1) {
      reader.bit();
      reader.signed();
      reader.signed();
      const cycle = reader.unsigned();
      for (let index = 0; index < cycle; index++) reader.signed();
    }
    reader.unsigned();
    reader.bit();
    const widthInMacroblocks = reader.unsigned() + 1;
    const heightInMapUnits = reader.unsigned() + 1;
    const framesOnly = reader.bit();
    if (!framesOnly) reader.bit();
    reader.bit();
    const crop = reader.bit() ? { left: reader.unsigned(), right: reader.unsigned(), top: reader.unsigned(), bottom: reader.unsigned() } : { left: 0, right: 0, top: 0, bottom: 0 };
    const cropX = chromaFormat === 1 || chromaFormat === 2 ? 2 : 1;
    const cropY = (chromaFormat === 1 ? 2 : 1) * (2 - framesOnly);
    return {
      width: widthInMacroblocks * 16 - (crop.left + crop.right) * cropX,
      height: heightInMapUnits * 16 * (2 - framesOnly) - (crop.top + crop.bottom) * cropY,
    };
  } catch {
    return null;
  }
}
