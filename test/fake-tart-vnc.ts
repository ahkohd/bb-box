// Tart's VNC server, as the VNC holder sees it (#406), and a viewer of the
// holder's socket, as noVNC would be: for the holder's tests and the Tart
// backend's.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { constants, inflateSync } from "node:zlib";
import { StreamReader, vncResponse } from "../src/core/rfb.ts";

export const u16 = (value: number) => Buffer.from([value >> 8, value & 255]);
export const u32 = (value: number) => Buffer.from([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
const i32 = (value: number) => u32(value >>> 0);
const rect = (x: number, y: number, w: number, h: number, encoding: number) => Buffer.concat([u16(x), u16(y), u16(w), u16(h), i32(encoding)]);
/** The pixels of an update's label, which a shorter label pads with red 0. */
const LABEL = 24;

/**
 * Tart's VNC server as far as the holder sees it: it ends on a second
 * connection in its life, and on an update request before DesktopSize is
 * set. It answers requests in order, as Tart seems to: one for the whole
 * screen at once, one for changes only when change() says the screen
 * changed, and nothing behind a request for changes until then.
 */
export class FakeTart {
  readonly server: Server;
  connections = 0;
  crashed = false;
  received: Buffer[] = [];
  /** The labels of the updates sent so far, in order, which each viewer reads back from its pixels' red bytes. */
  tiles: Buffer[] = [];
  size = { width: 1024, height: 768 };
  /** Set for the next update: a new size. */
  resize: { width: number; height: number } | null = null;
  /** Set for the next update: a CopyRect of its red, green and blue to here. */
  copy: { x: number; y: number } | null = null;
  #socket: Socket | null = null;
  #encodings: number[] = [];
  #updates = 0;
  /** Requests not yet answered, in order: true for the whole screen. */
  #queue: boolean[] = [];
  #changed = false;
  /** Every request, in order: true for the whole screen. */
  requests: boolean[] = [];

  readonly password: string;
  /** Its own pixel format, which it sends whatever the client asks: blue, green, red, unused in memory, as macOS draws, or red first. */
  readonly native: "bgrx" | "rgbx";

  /** Settles at its first connection, however long that takes. */
  readonly connected: Promise<void>;
  #connected!: () => void;

  constructor(password: string, native: "bgrx" | "rgbx" = "bgrx") {
    this.password = password;
    this.native = native;
    this.connected = new Promise((resolve) => (this.#connected = resolve));
    this.server = createServer((socket) => void this.#serve(socket));
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return (this.server.address() as { port: number }).port;
  }

  /** The screen changed: the request for changes at the head of the queue is answered, or the next one is. */
  async change(): Promise<void> {
    this.#changed = true;
    await this.#answer();
  }

  /** Answers the queue's requests in order, as far as it can. */
  async #answer(): Promise<void> {
    while (this.#socket && this.#queue.length) {
      const whole = this.#queue[0]!;
      if (!whole && !this.#changed) return;
      this.#queue.shift();
      if (!whole) this.#changed = false;
      await this.#update(this.#socket, whole);
    }
  }

  /** The run ends, as when Tart exits: the connection closes, and the server goes on listening, to catch a reconnection. */
  end(): void {
    this.#socket?.destroy();
  }

  #crash(why: string): void {
    this.crashed = true;
    this.received.push(Buffer.from(`CRASH ${why}`));
    this.#socket?.destroy();
  }

  async #serve(socket: Socket): Promise<void> {
    if (++this.connections > 1) {
      socket.destroy();
      return this.#crash("second connection");
    }
    this.#connected();
    this.#socket = socket;
    const reader = new StreamReader(
      new ReadableStream({
        start: (c) => {
          socket.on("data", (d: Buffer) => c.enqueue(new Uint8Array(d)));
          socket.on("close", () => {
            try {
              c.close();
            } catch {
              // Closed already.
            }
          });
        },
      }),
    );
    try {
      socket.write("RFB 003.008\n");
      await reader.read(12);
      socket.write(Buffer.from([1, 2]));
      assert.equal((await reader.read(1))[0], 2);
      const challenge = randomBytes(16);
      socket.write(challenge);
      const answer = Buffer.from(await reader.read(16));
      if (!answer.equals(Buffer.from(vncResponse(challenge, this.password)))) {
        socket.write(Buffer.concat([u32(1), u32(14), Buffer.from("wrong password")]));
        socket.end();
        return;
      }
      socket.write(u32(0));
      await reader.read(1);
      const shifts = this.native === "bgrx" ? [16, 8, 0] : [0, 8, 16];
      const format = Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, ...shifts, 0, 0, 0]);
      socket.write(Buffer.concat([u16(this.size.width), u16(this.size.height), format, u32(4), Buffer.from("fake")]));
      for (;;) {
        const type = (await reader.read(1))[0]!;
        if (type === 0) this.received.push(Buffer.concat([Buffer.from([0]), Buffer.from(await reader.read(19))]));
        else if (type === 2) {
          const head = Buffer.from(await reader.read(3));
          const body = Buffer.from(await reader.read(4 * head.readUInt16BE(1)));
          this.#encodings = Array.from({ length: body.length / 4 }, (_, i) => body.readInt32BE(i * 4));
          this.received.push(Buffer.concat([Buffer.from([2]), head, body]));
        } else if (type === 3) {
          const body = Buffer.from(await reader.read(9));
          this.received.push(Buffer.concat([Buffer.from([3]), body]));
          if (!this.#encodings.includes(-223)) return this.#crash("update request without DesktopSize");
          this.requests.push(body[0] === 0);
          this.#queue.push(body[0] === 0);
          await this.#answer();
        } else if (type === 4) this.received.push(Buffer.concat([Buffer.from([4]), Buffer.from(await reader.read(7))]));
        else if (type === 5) this.received.push(Buffer.concat([Buffer.from([5]), Buffer.from(await reader.read(5))]));
        else if (type === 6) {
          const head = Buffer.from(await reader.read(7));
          this.received.push(Buffer.concat([Buffer.from([6]), head, Buffer.from(await reader.read(head.readInt32BE(3)))]));
        } else return this.#crash(`client message type ${type}`);
      }
    } catch {
      // The holder went.
    }
  }

  /** A pixel in its own format. */
  pixel(red: number, green: number, blue: number): Buffer {
    return this.native === "bgrx" ? Buffer.from([blue, green, red, 0]) : Buffer.from([red, green, blue, 0]);
  }

  /**
   * An update: its label as a row of pixels whose red is each character and
   * whose green and blue are 0x11 and 0x22, then pure red, green and blue at
   * (8, 8), and the cursor in the first.
   */
  async #update(socket: Socket, whole: boolean): Promise<void> {
    this.#updates++;
    const parts: Buffer[] = [];
    if (this.resize) {
      this.size = this.resize;
      this.resize = null;
      parts.push(rect(0, 0, this.size.width, this.size.height, -223));
    }
    if (this.#updates === 1) parts.push(rect(0, 0, 2, 2, -239), ...Array.from({ length: 4 }, () => this.pixel(200, 100, 50)), Buffer.from([0xc0, 0xc0]));
    const label = Buffer.from(`${whole ? "whole" : "change"} ${this.#updates}; `);
    this.tiles.push(label);
    parts.push(rect(0, 0, LABEL, 1, 0), ...Array.from({ length: LABEL }, (_, x) => this.pixel(label[x] ?? 0, 0x11, 0x22)));
    parts.push(rect(8, 8, 3, 1, 0), this.pixel(255, 0, 0), this.pixel(0, 255, 0), this.pixel(0, 0, 255));
    if (this.copy) parts.push(rect(this.copy.x, this.copy.y, 3, 1, 1), u16(8), u16(8));
    this.copy = null;
    parts.push(rect(0, 0, 0, 0, -224));
    socket.write(Buffer.concat([Buffer.from([0, 0, 0xff, 0xff]), ...parts]));
  }
}

/** A viewer of the holder's socket, as noVNC would be, which draws each update on its own screen. */
export class Viewer {
  readonly socket: Socket;
  readonly reader: StreamReader;
  size = { width: 0, height: 0 };
  /** Its screen's pixels, in noVNC's format: red, green, blue, unused. */
  screen = Buffer.alloc(0);
  /** The Zlib rects' compressed bytes so far, one stream, and how much of what they inflate to is read. */
  #zlib = Buffer.alloc(0);
  #used = 0;
  cursorColour: number[] = [];
  cursor = false;
  /** The bytes it has had from the holder. */
  received = 0;

  constructor(path: string) {
    this.socket = createConnection(path);
    this.reader = new StreamReader(
      new ReadableStream({
        start: (c) => {
          this.socket.on("data", (d: Buffer) => {
            this.received += d.length;
            c.enqueue(new Uint8Array(d));
          });
          this.socket.on("close", () => {
            try {
              c.close();
            } catch {}
          });
        },
      }),
    );
  }

  #resize(width: number, height: number): void {
    this.size = { width, height };
    this.screen = Buffer.alloc(width * height * 4);
  }

  async join(): Promise<void> {
    assert.equal(Buffer.from(await this.reader.read(12)).toString(), "RFB 003.008\n");
    this.socket.write("RFB 003.008\n");
    assert.deepEqual([...(await this.reader.read(2))], [1, 1], "security type None only");
    this.socket.write(Buffer.from([1]));
    assert.deepEqual([...(await this.reader.read(4))], [0, 0, 0, 0]);
    this.socket.write(Buffer.from([1]));
    const init = Buffer.from(await this.reader.read(24));
    this.#resize(init.readUInt16BE(0), init.readUInt16BE(2));
    await this.reader.read(init.readUInt32BE(20));
    // noVNC's first messages: its pixel format, its encodings, and a request for the whole screen.
    this.socket.write(Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.alloc(16, 1)]));
    this.socket.write(Buffer.concat([Buffer.from([2, 0]), u16(2), i32(7), i32(16)]));
    this.socket.write(Buffer.concat([Buffer.from([3, 0]), u16(0), u16(0), u16(this.size.width), u16(this.size.height)]));
  }

  /** A rect's pixels, in noVNC's format: red, green, blue, unused. */
  async #pixels(encoding: number, w: number, h: number): Promise<Buffer> {
    if (encoding === 0) return Buffer.from(await this.reader.read(w * h * 4));
    const length = Buffer.from(await this.reader.read(4)).readUInt32BE(0);
    this.#zlib = Buffer.concat([this.#zlib, Buffer.from(await this.reader.read(length))]);
    const all = inflateSync(this.#zlib, { finishFlush: constants.Z_SYNC_FLUSH });
    const pixels = all.subarray(this.#used, this.#used + w * h * 4);
    this.#used += w * h * 4;
    assert.equal(pixels.length, w * h * 4, "the Zlib rect inflates to its pixels, on this viewer's own stream");
    return pixels;
  }

  /** Reads one whole update, and draws it. */
  async update(): Promise<{ rects: number }> {
    const head = Buffer.from(await this.reader.read(4));
    assert.equal(head[0], 0, "a FramebufferUpdate");
    const count = head.readUInt16BE(2);
    for (let i = 0; i < count; i++) {
      const r = Buffer.from(await this.reader.read(12));
      const [x, y, w, h, encoding] = [r.readUInt16BE(0), r.readUInt16BE(2), r.readUInt16BE(4), r.readUInt16BE(6), r.readInt32BE(8)];
      if (encoding === 0 || encoding === 6) {
        const pixels = await this.#pixels(encoding, w, h);
        assert.ok(x + w <= this.size.width && y + h <= this.size.height, `the rect ${w}x${h} at ${x},${y} is on the screen`);
        for (let line = 0; line < h; line++) pixels.copy(this.screen, ((y + line) * this.size.width + x) * 4, line * w * 4, (line + 1) * w * 4);
      } else if (encoding === -239) {
        const pixels = Buffer.from(await this.reader.read(w * h * 4));
        await this.reader.read(Math.ceil(w / 8) * h);
        this.cursorColour = [pixels[0]!, pixels[1]!, pixels[2]!];
        this.cursor = true;
      } else if (encoding === -223) this.#resize(w, h);
      else assert.fail(`rect encoding ${encoding}`);
    }
    return { rects: count };
  }

  /** The red, green and blue of the three pixels from (x, y). */
  colours(x = 8, y = 8): number[][] {
    return [0, 1, 2].map((dx) => [...this.screen.subarray(((y * this.size.width) + x + dx) * 4, ((y * this.size.width) + x + dx) * 4 + 3)]);
  }

  /** The label at the top left of its screen: each pixel's red, up to the first that has none. */
  get label(): string {
    const chars: number[] = [];
    for (let x = 0; x < LABEL; x++) {
      const [red, green, blue] = this.colours(x, 0)[0]!;
      assert.deepEqual([green, blue], [0x11, 0x22], `a label's pixels keep their green and blue, at ${x},0`);
      if (!red) break;
      chars.push(red);
    }
    return Buffer.from(chars).toString();
  }

  /** A request for changes, as noVNC sends after each update. */
  ask(): void {
    this.socket.write(Buffer.concat([Buffer.from([3, 1]), u16(0), u16(0), u16(this.size.width), u16(this.size.height)]));
  }

  close(): void {
    this.socket.destroy();
  }
}
