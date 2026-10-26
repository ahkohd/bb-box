// A PNG of RGBA pixels, as the panel takes a box's cursor image (060): small
// images, so no filtering, and zlib's deflate.

import { deflateSync, inflateSync } from "node:zlib";

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/** A PNG of `width` by `height` RGBA pixels, row by row. */
export function rgbaPng(width: number, height: number, rgba: Uint8Array): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", new Uint8Array(0))]);
}

/** RGBA pixels from 32-bit ARGB ones, little-endian as Wayland's ARGB8888 lays them out: B, G, R, A, premultiplied. */
export function argbToRgba(argb: Uint8Array): Uint8Array {
  const rgba = new Uint8Array(argb.length);
  for (let i = 0; i + 3 < argb.length; i += 4) {
    const a = argb[i + 3]!;
    // Wayland's ARGB8888 is premultiplied: a half-clear pixel's colour is half as bright.
    const un = (v: number) => (a === 0 ? 0 : Math.min(255, Math.round((v * 255) / a)));
    rgba[i] = un(argb[i + 2]!);
    rgba[i + 1] = un(argb[i + 1]!);
    rgba[i + 2] = un(argb[i]!);
    rgba[i + 3] = a;
  }
  return rgba;
}

export interface RgbaPixels {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS_OF_COLOUR_TYPE: Readonly<Record<number, number>> = { 2: 3, 6: 4 };

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  return toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
}

export function pngPixels(png: Uint8Array): RgbaPixels {
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) throw new Error("not a PNG");
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Buffer[] = [];
  for (let offset = 8; offset + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      channels = CHANNELS_OF_COLOUR_TYPE[body[9]!] ?? 0;
      if (body[8] !== 8 || !channels || body[12] !== 0) throw new Error("only 8-bit RGB or RGBA PNGs, not interlaced, are read");
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const source = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? rows[row + x - channels]! : 0;
      const up = y ? rows[row - stride + x]! : 0;
      const upLeft = y && x >= channels ? rows[row - stride + x - channels]! : 0;
      const value = raw[source + x]!;
      rows[row + x] = filter === 0 ? value : filter === 1 ? value + left : filter === 2 ? value + up : filter === 3 ? value + ((left + up) >> 1) : value + paeth(left, up, upLeft);
    }
  }
  if (channels === 4) return { width, height, rgba: rows };
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    rgba.set(rows.subarray(pixel * 3, pixel * 3 + 3), pixel * 4);
    rgba[pixel * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

export function clockwiseTurnedPixels(pixels: RgbaPixels, turns: number): RgbaPixels {
  const quarter = ((turns % 4) + 4) % 4;
  if (!quarter) return pixels;
  const { width, height } = pixels;
  const sideways = quarter % 2 === 1;
  const turned = { width: sideways ? height : width, height: sideways ? width : height };
  const source = new Uint32Array(pixels.rgba.buffer.slice(pixels.rgba.byteOffset, pixels.rgba.byteOffset + width * height * 4));
  const target = new Uint32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const to = quarter === 1 ? x * turned.width + (height - 1 - y) : quarter === 2 ? (height - 1 - y) * width + (width - 1 - x) : (width - 1 - x) * turned.width + y;
      target[to] = source[y * width + x]!;
    }
  }
  return { ...turned, rgba: new Uint8Array(target.buffer) };
}
