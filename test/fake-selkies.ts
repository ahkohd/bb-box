// A stand-in for a box's Selkies 2.0 (056), as the relay meets it: a
// WebSocket server on in-memory channels, which accepts the upgrade, says
// "MODE websockets", closes with 4029 the next `refuse` connections, as
// Selkies does one that came too soon after another, and records what each connection sends. Pages
// that asked for role=viewer may only ask for video, as in Selkies; others
// are controllers. Frames go to every page that has not asked for no video.

import { createHash } from "node:crypto";
import { createServer, type AddressInfo, type Server } from "node:net";
import { Duplex } from "node:stream";
import type { ByteChannel } from "../src/transports/types.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface SelkiesPage {
  readonly role: "viewer" | "controller";
  readonly path: string;
  /** What the page sent, text and binary, in order. */
  readonly received: (string | Uint8Array)[];
  /** Whether it asked for no video. */
  stopped: boolean;
  closed: boolean;
  /** The close code the server sent it, if it closed it. */
  closedWith: number | null;
  send(message: string | Uint8Array): Promise<void>;
  /** A frame of the server's own, such as a ping. */
  raw(bytes: Uint8Array): Promise<void>;
  close(code: number): Promise<void>;
}

/** A frame from the server: unmasked, and split into `pieces` fragments when asked. */
export function serverFrames(opcode: number, payload: Uint8Array, pieces = 1): Uint8Array[] {
  const frames: Uint8Array[] = [];
  const step = Math.max(1, Math.ceil(payload.byteLength / pieces));
  for (let at = 0, first = true; first || at < payload.byteLength; at += step, first = false) {
    const part = payload.subarray(at, Math.min(payload.byteLength, at + step));
    const last = at + step >= payload.byteLength;
    const length = part.byteLength;
    const extra = length < 126 ? 0 : length < 65536 ? 2 : 8;
    const frame = new Uint8Array(2 + extra + length);
    const view = new DataView(frame.buffer);
    frame[0] = (last ? 0x80 : 0) | (first ? opcode : 0);
    if (extra === 0) frame[1] = length;
    else if (extra === 2) {
      frame[1] = 126;
      view.setUint16(2, length);
    } else {
      frame[1] = 127;
      view.setBigUint64(2, BigInt(length));
    }
    frame.set(part, 2 + extra);
    frames.push(frame);
  }
  return frames;
}

/** A video message as Selkies sends one: type 4, H.264, key or not, its frame id and the screen's size. */
export function videoFrame(id: number, key: boolean, width = 1920, height = 1080, body = 100): Uint8Array {
  const bytes = new Uint8Array(12 + body);
  const view = new DataView(bytes.buffer);
  bytes[0] = 4;
  bytes[1] = 0x10 | (key ? 1 : 0);
  view.setUint16(2, id);
  view.setUint16(6, width);
  view.setUint16(8, height);
  return bytes;
}

export class FakeSelkies {
  readonly pages: SelkiesPage[] = [];
  /** How many of the next connections to close with 4029, as come too soon. */
  refuse: number;
  /** How many it closed so. */
  refused = 0;
  #server: Server | null = null;

  constructor(options: { refuse?: number } = {}) {
    this.refuse = options.refuse ?? 0;
  }

  /** An in-memory connection, as the display's route opens one. */
  channel(): ByteChannel {
    const toServer = new TransformStream<Uint8Array, Uint8Array>();
    const toClient = new TransformStream<Uint8Array, Uint8Array>();
    const writer = toClient.writable.getWriter();
    void this.#serve(toServer.readable.getReader(), writer);
    return {
      readable: toClient.readable,
      writable: toServer.writable,
      async close() {
        await writer.close().catch(() => undefined);
        await toServer.writable.abort().catch(() => undefined);
      },
    };
  }

  /** Listens on the loopback, for a display's TCP route; returns the port. */
  async listen(): Promise<number> {
    const server = createServer((socket) => {
      const { readable, writable } = Duplex.toWeb(socket) as unknown as { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
      void this.#serve(readable.getReader(), writable.getWriter());
    });
    this.#server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    await Promise.all(this.pages.map((page) => page.close(1001)));
    const server = this.#server;
    this.#server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Sends every page that wants video a frame. */
  async frame(id: number, key: boolean, width?: number, height?: number): Promise<void> {
    for (const page of this.pages) if (!page.closed && !page.stopped) await page.send(videoFrame(id, key, width, height));
  }

  /** Sends every page the box's clipboard, as Selkies does. */
  async clipboard(text: string): Promise<void> {
    for (const page of this.pages) if (!page.closed) await page.send(`clipboard,${Buffer.from(text).toString("base64")}`);
  }

  async #serve(reader: ReadableStreamDefaultReader<Uint8Array>, writer: WritableStreamDefaultWriter<Uint8Array>): Promise<void> {
    let buffer = new Uint8Array(0);
    const more = async (): Promise<boolean> => {
      const { value, done } = await reader.read();
      if (done) return false;
      const joined = new Uint8Array(buffer.byteLength + value.byteLength);
      joined.set(buffer);
      joined.set(value, buffer.byteLength);
      buffer = joined;
      return true;
    };
    while (!new TextDecoder().decode(buffer).includes("\r\n\r\n")) if (!(await more())) return;
    const text = new TextDecoder().decode(buffer);
    const end = text.indexOf("\r\n\r\n") + 4;
    buffer = buffer.subarray(end);
    const lines = text.slice(0, end).split("\r\n");
    const path = lines[0]!.split(" ")[1]!;
    const key = lines.find((line) => /^sec-websocket-key:/i.test(line))!.replace(/^[^:]*:\s*/, "");
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    void writer.write(new TextEncoder().encode(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`));
    // Queued, not awaited: a stream's write waits for the reader, and a test
    // may send several messages before it reads one.
    const write = async (bytes: Uint8Array) => {
      if (!page.closed) void writer.write(bytes).catch(() => undefined);
    };
    const page: SelkiesPage = {
      role: new URL(path, "http://box").searchParams.get("role") === "viewer" ? "viewer" : "controller",
      path,
      received: [],
      stopped: false,
      closed: false,
      closedWith: null,
      async send(message) {
        const payload = typeof message === "string" ? new TextEncoder().encode(message) : message;
        for (const frame of serverFrames(typeof message === "string" ? 1 : 2, payload)) await write(frame);
      },
      raw: write,
      async close(code) {
        const payload = new Uint8Array(2);
        new DataView(payload.buffer).setUint16(0, code);
        await write(serverFrames(8, payload)[0]!);
        page.closedWith = code;
        page.closed = true;
        void writer.close().catch(() => undefined);
      },
    };
    if (this.refuse > 0) {
      this.refuse -= 1;
      this.refused += 1;
      await page.close(4029);
      void reader.cancel().catch(() => undefined);
      return;
    }
    this.pages.push(page);
    await page.send("MODE websockets");
    for (;;) {
      while (buffer.byteLength < 2) if (!(await more())) return void (page.closed = true);
      let length = buffer[1]! & 0x7f;
      let at = 2;
      if (length === 126) {
        while (buffer.byteLength < 4) if (!(await more())) return void (page.closed = true);
        length = new DataView(buffer.buffer, buffer.byteOffset).getUint16(2);
        at = 4;
      } else if (length === 127) {
        while (buffer.byteLength < 10) if (!(await more())) return void (page.closed = true);
        length = Number(new DataView(buffer.buffer, buffer.byteOffset).getBigUint64(2));
        at = 10;
      }
      const masked = (buffer[1]! & 0x80) !== 0;
      while (buffer.byteLength < at + (masked ? 4 : 0) + length) if (!(await more())) return void (page.closed = true);
      const opcode = buffer[0]! & 0x0f;
      const mask = masked ? buffer.subarray(at, at + 4) : null;
      const body = buffer.slice(at + (masked ? 4 : 0), at + (masked ? 4 : 0) + length);
      if (mask) for (let index = 0; index < body.byteLength; index++) body[index]! ^= mask[index & 3]!;
      buffer = buffer.subarray(at + (masked ? 4 : 0) + length);
      if (!masked) throw new Error("The client sent an unmasked frame.");
      if (opcode === 8) {
        page.closed = true;
        await writer.close().catch(() => undefined);
        return;
      }
      if (opcode === 10) {
        page.received.push(`pong:${new TextDecoder().decode(body)}`);
        continue;
      }
      const message = opcode === 1 ? new TextDecoder().decode(body) : body;
      page.received.push(message);
      if (message === "STOP_VIDEO") page.stopped = true;
      if (message === "START_VIDEO") page.stopped = false;
    }
  }
}
