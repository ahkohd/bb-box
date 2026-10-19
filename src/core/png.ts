// A PNG of RGBA pixels, as the panel takes a box's cursor image (060): small
// images, so no filtering, and zlib's deflate.

import { deflateSync } from "node:zlib";

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
