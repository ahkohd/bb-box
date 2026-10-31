import { inflateSync } from "node:zlib";
import { jpegOf } from "./jpeg.ts";
import { pixelsWithin, pngPixels } from "./png.ts";

export const PICTURE_EDGE = 320;
export const PICTURE_QUALITY = 70;
export const PICTURE_WAIT_MS = 2000;
export const SCREEN_LIMITS = { bytes: 8 * 1024 * 1024, edge: 2048 } as const;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS_OF_COLOUR_TYPE: Readonly<Record<number, number>> = { 2: 3, 6: 4 };

function checkedScreenPng(png: Uint8Array): void {
  if (png.byteLength > SCREEN_LIMITS.bytes) throw new Error(`the PNG is ${png.byteLength} bytes, over ${SCREEN_LIMITS.bytes}`);
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) throw new Error("not a PNG");
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Buffer[] = [];
  for (let offset = 8; offset + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (offset + 12 + length > bytes.length) throw new Error(`the PNG's ${type} chunk runs past its end`);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      channels = CHANNELS_OF_COLOUR_TYPE[body[9]!] ?? 0;
      if (body[8] !== 8 || !channels || body[12] !== 0) throw new Error("only 8-bit RGB or RGBA PNGs, not interlaced, are read");
      if (!width || !height || width > SCREEN_LIMITS.edge || height > SCREEN_LIMITS.edge) throw new Error(`the PNG is ${width}x${height}, and at most ${SCREEN_LIMITS.edge} a side is read`);
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (!channels) throw new Error("the PNG has no header");
  const stride = width * channels + 1;
  const raw = inflateSync(Buffer.concat(data), { maxOutputLength: stride * height });
  if (raw.length !== stride * height) throw new Error(`the PNG's pixels are ${raw.length} bytes, not the ${stride * height} its size needs`);
  for (let row = 0; row < height; row++) {
    const filter = raw[row * stride]!;
    if (filter > 4) throw new Error(`the PNG's row ${row} has filter ${filter}, which is not one`);
  }
}

export interface ScreenPicture {
  readonly jpeg: Buffer;
  readonly width: number;
  readonly height: number;
}

export function pictureOfScreen(png: Uint8Array): ScreenPicture {
  checkedScreenPng(png);
  const pixels = pixelsWithin(pngPixels(png), PICTURE_EDGE);
  return { jpeg: jpegOf(pixels, PICTURE_QUALITY), width: pixels.width, height: pixels.height };
}

export function withinWait<T>(work: (signal: AbortSignal) => Promise<T>, ms: number = PICTURE_WAIT_MS): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`it did not answer within ${ms / 1000} s`));
    }, ms);
  });
  return Promise.race([work(controller.signal), late]).finally(() => clearTimeout(timer));
}
