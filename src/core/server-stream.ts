const RAW = 0;
const COPY_RECT = 1;
const ZLIB = 6;
const TIGHT = 7;
const ZRLE = 16;
const OPEN_H264 = 50;
const DESKTOP_SIZE = -223;
const LAST_RECT = -224;
const CURSOR = -239;
const QEMU_KEY = -258;
const QEMU_LED = -261;
const DESKTOP_NAME = -307;
const EXTENDED_DESKTOP_SIZE = -308;
const PTS = -1000;

const TIGHT_PIXEL = 3;

export interface FrameSize {
  readonly width: number;
  readonly height: number;
}

type Phase = "message" | "header" | "rect" | "extended" | "u32" | "h264" | "tight" | "cut" | "fence" | "colormap";

interface Tight {
  width: number;
  height: number;
  step: "control" | "filter" | "palette" | "compact" | "body";
  high: number;
  filter: number;
  colors: number;
  compact: number;
  compactBytes: number;
}

class PendingBytes {
  #parts: Uint8Array[] = [];
  #at = 0;
  length = 0;

  add(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.#parts.push(bytes);
    this.length += bytes.byteLength;
  }

  take(n: number): Uint8Array | null {
    if (this.length < n) return null;
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const part = this.#parts[0]!;
      const take = Math.min(n - filled, part.byteLength - this.#at);
      out.set(part.subarray(this.#at, this.#at + take), filled);
      filled += take;
      this.#at += take;
      this.length -= take;
      if (this.#at === part.byteLength) {
        this.#parts.shift();
        this.#at = 0;
      }
    }
    return out;
  }

  skip(n: number): boolean {
    if (this.length < n) return false;
    let left = n;
    while (left > 0) {
      const part = this.#parts[0]!;
      const take = Math.min(left, part.byteLength - this.#at);
      left -= take;
      this.#at += take;
      this.length -= take;
      if (this.#at === part.byteLength) {
        this.#parts.shift();
        this.#at = 0;
      }
    }
    return true;
  }

  clear(): void {
    this.#parts = [];
    this.#at = 0;
    this.length = 0;
  }
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export class ServerParser {
  #size: FrameSize;
  #bytesPerPixel: number;
  #lost = false;
  #tightPixelsKnown: boolean;
  #pending = new PendingBytes();
  #discard = 0;
  #phase: Phase = "message";
  #left = 0;
  #tight: Tight | null = null;

  constructor(frame: FrameSize & { readonly bitsPerPixel: number; readonly tightPixelsKnown?: boolean }) {
    this.#size = { width: frame.width, height: frame.height };
    this.#tightPixelsKnown = frame.tightPixelsKnown === true;
    const bytes = frame.bitsPerPixel / 8;
    this.#bytesPerPixel = bytes === 1 || bytes === 2 || bytes === 4 ? bytes : 0;
    this.#lost = this.#bytesPerPixel === 0;
  }

  stop(): void {
    this.#lose();
  }

  get size(): FrameSize {
    return this.#size;
  }

  get tracking(): boolean {
    return !this.#lost;
  }

  read(bytes: Uint8Array): void {
    if (this.#lost || bytes.byteLength === 0) return;

    let rest = bytes;
    if (this.#discard > 0) {
      if (rest.byteLength <= this.#discard) {
        this.#discard -= rest.byteLength;
        return;
      }
      rest = rest.subarray(this.#discard);
      this.#discard = 0;
    }

    this.#pending.add(rest);
    while (!this.#lost && this.#discard === 0) {
      if (!this.#step()) return;
    }
  }

  #step(): boolean {
    switch (this.#phase) {
      case "message":
        return this.#message();
      case "header":
        return this.#header();
      case "rect":
        return this.#rectangle();
      case "extended":
        return this.#extended();
      case "u32":
        return this.#u32();
      case "h264":
        return this.#h264();
      case "tight":
        return this.#tightStep();
      case "cut":
        return this.#cut();
      case "fence":
        return this.#fence();
      case "colormap":
        return this.#colormap();
    }
  }

  #message(): boolean {
    const byte = this.#pending.take(1);
    if (!byte) return false;
    const type = byte[0]!;

    if (type === 0) {
      this.#phase = "header";
      return true;
    }
    if (type === 2 || type === 150) return true;
    if (type === 1) {
      this.#phase = "colormap";
      return true;
    }
    if (type === 3) {
      this.#phase = "cut";
      return true;
    }
    if (type === 248) {
      this.#phase = "fence";
      return true;
    }
    if (type === 250) return this.#pay(3);

    this.#lose();
    return false;
  }

  #header(): boolean {
    const bytes = this.#pending.take(3);
    if (!bytes) return false;

    const count = viewOf(bytes).getUint16(1);
    this.#left = count;
    this.#phase = count === 0 ? "message" : "rect";
    return true;
  }

  #rectangle(): boolean {
    const bytes = this.#pending.take(12);
    if (!bytes) return false;
    const view = viewOf(bytes);
    const x = view.getUint16(0);
    const y = view.getUint16(2);
    const width = view.getUint16(4);
    const height = view.getUint16(6);
    const encoding = view.getInt32(8);

    if (encoding === LAST_RECT) {
      this.#left = 0;
      this.#tight = null;
      this.#phase = "message";
      return true;
    }
    if (encoding === DESKTOP_SIZE) {
      this.#setSize(width, height);
      this.#finishRectangle();
      return true;
    }
    if (encoding === EXTENDED_DESKTOP_SIZE) {
      if (!(x === 1 && y !== 0)) this.#setSize(width, height);
      this.#phase = "extended";
      return true;
    }
    if (encoding === QEMU_KEY) {
      this.#finishRectangle();
      return true;
    }
    if (encoding === QEMU_LED) return this.#finishAfter(1);
    if (encoding === PTS) return this.#finishAfter(8);
    if (encoding === COPY_RECT) return this.#finishAfter(4);
    if (encoding === DESKTOP_NAME) {
      this.#phase = "u32";
      return true;
    }
    if (encoding === ZRLE) {
      this.#phase = "u32";
      return true;
    }
    if (encoding === ZLIB) {
      if (width === 0 || height === 0) {
        this.#finishRectangle();
        return true;
      }
      this.#phase = "u32";
      return true;
    }
    if (encoding === OPEN_H264) {
      this.#phase = "h264";
      return true;
    }
    if (encoding === RAW || encoding === CURSOR) {
      if (this.#bytesPerPixel === 0) {
        this.#lose();
        return false;
      }
      const pixels = width * height * this.#bytesPerPixel;
      const mask = encoding === CURSOR ? Math.ceil(width / 8) * height : 0;
      return this.#finishAfter(pixels + mask);
    }
    if (encoding === TIGHT) {
      if (!this.#tightPixelsKnown) {
        this.#lose();
        return false;
      }
      this.#tight = { width, height, step: "control", high: 0, filter: 0, colors: 0, compact: 0, compactBytes: 0 };
      this.#phase = "tight";
      return true;
    }

    this.#lose();
    return false;
  }

  #extended(): boolean {
    const count = this.#pending.take(1);
    if (!count) return false;
    return this.#finishAfter(3 + 16 * count[0]!);
  }

  #u32(): boolean {
    const bytes = this.#pending.take(4);
    if (!bytes) return false;
    return this.#finishAfter(viewOf(bytes).getUint32(0));
  }

  #h264(): boolean {
    const bytes = this.#pending.take(8);
    if (!bytes) return false;
    return this.#finishAfter(viewOf(bytes).getUint32(0));
  }

  #cut(): boolean {
    const bytes = this.#pending.take(7);
    if (!bytes) return false;
    this.#phase = "message";
    return this.#pay(Math.abs(viewOf(bytes).getInt32(3)));
  }

  #fence(): boolean {
    const bytes = this.#pending.take(8);
    if (!bytes) return false;
    this.#phase = "message";
    return this.#pay(bytes[7]!);
  }

  #colormap(): boolean {
    const bytes = this.#pending.take(5);
    if (!bytes) return false;
    this.#phase = "message";
    return this.#pay(viewOf(bytes).getUint16(3) * 6);
  }

  #tightStep(): boolean {
    const tight = this.#tight;
    if (!tight) {
      this.#lose();
      return false;
    }

    for (;;) {
      if (tight.step === "control") {
        const byte = this.#pending.take(1);
        if (!byte) return false;
        const high = byte[0]! >> 4;
        if (high === 0x08) return this.#finishAfter(TIGHT_PIXEL);
        if (high === 0x09 || high === 0x0a) {
          tight.step = "compact";
          tight.compact = 0;
          tight.compactBytes = 0;
          continue;
        }
        if ((high & 0x08) !== 0) {
          this.#lose();
          return false;
        }
        tight.high = high;
        tight.filter = 0;
        tight.step = (high & 0x04) !== 0 ? "filter" : "body";
        continue;
      }

      if (tight.step === "filter") {
        const byte = this.#pending.take(1);
        if (!byte) return false;
        tight.filter = byte[0]!;
        if (tight.filter > 2) {
          this.#lose();
          return false;
        }
        tight.step = tight.filter === 1 ? "palette" : "body";
        continue;
      }

      if (tight.step === "palette") {
        const byte = this.#pending.take(1);
        if (!byte) return false;
        const colors = byte[0]! + 1;
        tight.colors = colors;
        tight.step = "body";
        if (!this.#pay(colors * TIGHT_PIXEL)) return false;
        continue;
      }

      if (tight.step === "body") {
        const uncompressed = tight.filter === 1 ? paletteBytes(tight.width, tight.height, tight.colors) : tight.width * tight.height * TIGHT_PIXEL;
        if (uncompressed < 12) return this.#finishAfter(uncompressed);
        tight.step = "compact";
        tight.compact = 0;
        tight.compactBytes = 0;
        continue;
      }

      const byte = this.#pending.take(1);
      if (!byte) return false;
      const value = byte[0]!;
      if (tight.compactBytes < 2) {
        tight.compact |= (value & 0x7f) << (7 * tight.compactBytes);
        tight.compactBytes += 1;
        if ((value & 0x80) === 0) return this.#finishAfter(tight.compact);
        continue;
      }
      return this.#finishAfter(tight.compact | (value << 14));
    }
  }

  #setSize(width: number, height: number): void {
    if (width === this.#size.width && height === this.#size.height) return;
    this.#size = { width, height };
  }

  #finishRectangle(): void {
    this.#left -= 1;
    this.#tight = null;
    this.#phase = this.#left > 0 ? "rect" : "message";
  }

  #finishAfter(n: number): boolean {
    this.#finishRectangle();
    return this.#pay(n);
  }

  #pay(n: number): boolean {
    if (n <= 0) return true;
    if (this.#pending.skip(n)) return true;
    this.#discard = n - this.#pending.length;
    this.#pending.clear();
    return false;
  }

  #lose(): void {
    this.#lost = true;
    this.#pending.clear();
    this.#discard = 0;
    this.#tight = null;
    this.#phase = "message";
  }
}

function paletteBytes(width: number, height: number, colors: number): number {
  const bits = colors <= 2 ? 1 : 8;
  return Math.floor((width * bits + 7) / 8) * height;
}
