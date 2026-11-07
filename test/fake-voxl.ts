import { createHash } from "node:crypto";
import { createServer, type AddressInfo, type Server } from "node:net";
import { Duplex } from "node:stream";
import type { ByteChannel } from "../src/transports/types.ts";
import { serverFrames } from "./fake-selkies.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface VoxlClient {
  readonly path: string;
  readonly host: string;
  readonly origin: string | null;
  readonly received: (string | Uint8Array)[];
  closed: boolean;
  send(message: string | Uint8Array): Promise<void>;
  close(code: number): Promise<void>;
}

export function voxlVideo(id: number, key: boolean, body: Uint8Array = new Uint8Array([0, 0, 0, 1, 0x65, 1, 2, 3])): Uint8Array {
  const message = new Uint8Array(16 + body.byteLength);
  const view = new DataView(message.buffer);
  message[0] = 0x01;
  message[1] = key ? 1 : 0;
  view.setUint32(2, id);
  view.setUint32(6, 42);
  message[10] = 0;
  message[11] = 1;
  message[12] = 1;
  message.set(body, 16);
  return message;
}

export function voxlCursor(width: number, height: number, hotx: number, hoty: number, rgba: Uint8Array): Uint8Array {
  const message = new Uint8Array(14 + rgba.byteLength);
  const view = new DataView(message.buffer);
  message[0] = 0x03;
  view.setUint16(2, width);
  view.setUint16(4, height);
  view.setUint16(6, hotx);
  view.setUint16(8, hoty);
  view.setUint32(10, 7);
  message.set(rgba, 14);
  return message;
}

export class FakeVoxl {
  readonly clients: VoxlClient[] = [];
  width: number;
  height: number;
  #server: Server | null = null;

  constructor(size: { width: number; height: number } = { width: 1920, height: 1080 }) {
    this.width = size.width;
    this.height = size.height;
  }

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
    await Promise.all(this.clients.map((client) => client.close(1001)));
    const server = this.#server;
    this.#server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  hello(): string {
    return JSON.stringify({ t: "hello", w: this.width, h: this.height, os: "linux", audio: false, stripes: [[0, this.height]] });
  }

  async everyone(message: string | Uint8Array): Promise<void> {
    for (const client of this.clients) if (!client.closed) await client.send(message);
  }

  async resize(width: number, height: number): Promise<void> {
    this.width = width;
    this.height = height;
    await this.everyone(this.hello());
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
    const header = (name: string) => lines.find((line) => line.toLowerCase().startsWith(`${name}:`))?.replace(/^[^:]*:\s*/, "") ?? null;
    const accept = createHash("sha1").update(header("sec-websocket-key")! + GUID).digest("base64");
    void writer.write(new TextEncoder().encode(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`));
    const write = (bytes: Uint8Array) => {
      if (!client.closed) void writer.write(bytes).catch(() => undefined);
    };
    const client: VoxlClient = {
      path: lines[0]!.split(" ")[1]!,
      host: header("host") ?? "",
      origin: header("origin"),
      received: [],
      closed: false,
      async send(message) {
        const payload = typeof message === "string" ? new TextEncoder().encode(message) : message;
        for (const frame of serverFrames(typeof message === "string" ? 1 : 2, payload)) write(frame);
      },
      async close(code) {
        const payload = new Uint8Array(2);
        new DataView(payload.buffer).setUint16(0, code);
        write(serverFrames(8, payload)[0]!);
        client.closed = true;
        void writer.close().catch(() => undefined);
      },
    };
    this.clients.push(client);
    await client.send(this.hello());
    for (;;) {
      while (buffer.byteLength < 2) if (!(await more())) return void (client.closed = true);
      let length = buffer[1]! & 0x7f;
      let at = 2;
      if (length === 126) {
        while (buffer.byteLength < 4) if (!(await more())) return void (client.closed = true);
        length = new DataView(buffer.buffer, buffer.byteOffset).getUint16(2);
        at = 4;
      } else if (length === 127) {
        while (buffer.byteLength < 10) if (!(await more())) return void (client.closed = true);
        length = Number(new DataView(buffer.buffer, buffer.byteOffset).getBigUint64(2));
        at = 10;
      }
      while (buffer.byteLength < at + 4 + length) if (!(await more())) return void (client.closed = true);
      const opcode = buffer[0]! & 0x0f;
      const mask = buffer.subarray(at, at + 4);
      const body = buffer.slice(at + 4, at + 4 + length);
      for (let index = 0; index < body.byteLength; index++) body[index]! ^= mask[index & 3]!;
      buffer = buffer.subarray(at + 4 + length);
      if (opcode === 8) {
        client.received.push("close");
        client.closed = true;
        await writer.close().catch(() => undefined);
        return;
      }
      client.received.push(opcode === 1 ? new TextDecoder().decode(body) : body);
    }
  }
}
