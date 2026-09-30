// A stand-in for a box's VNC server: RFB 3.8 with VNC authentication when it
// has a password, a desktop of a set size, and a record of what each
// connection sent after its ClientInit. It answers every update request with
// an empty update and takes SetDesktopSize.

import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import { Duplex } from "node:stream";
import { ClientParser, StreamReader, concat, vncResponse } from "../src/core/rfb.ts";
import type { ByteChannel } from "../src/transports/types.ts";

export interface FakeRfbOptions {
  readonly password?: string;
  readonly width?: number;
  readonly height?: number;
}

export interface RfbConnection {
  /** The ClientInit's shared flag, once it arrives. */
  shared: number | null;
  /** Every byte after the ClientInit. */
  received: Uint8Array;
  closed: boolean;
  send(bytes: Uint8Array): Promise<void>;
  end(): Promise<void>;
}

const EMPTY_UPDATE = Uint8Array.of(0, 0, 0, 0);

export class FakeRfb {
  width: number;
  height: number;
  readonly password: string | null;
  readonly connections: RfbConnection[] = [];
  #server: Server | null = null;

  constructor(options: FakeRfbOptions = {}) {
    this.width = options.width ?? 1280;
    this.height = options.height ?? 800;
    this.password = options.password ?? null;
  }

  /** An in-memory connection, as a display route would open. */
  channel(): ByteChannel {
    const toServer = new TransformStream<Uint8Array, Uint8Array>();
    const toViewer = new TransformStream<Uint8Array, Uint8Array>();
    const connection = this.#serve(toServer.readable, toViewer.writable);
    return {
      readable: toViewer.readable,
      writable: toServer.writable,
      close: async () => {
        await connection.end();
      },
    };
  }

  /** Listens on a local TCP port, as a box's VNC server does. */
  async listen(): Promise<number> {
    const server = createServer((socket) => {
      const { readable, writable } = Duplex.toWeb(socket) as unknown as { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
      this.#serve(readable, writable);
    });
    this.#server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    await Promise.all(this.connections.map((connection) => connection.end()));
    const server = this.#server;
    this.#server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  #serve(readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>): RfbConnection {
    const reader = new StreamReader(readable);
    const writer = writable.getWriter();
    const connection: RfbConnection = {
      shared: null,
      received: new Uint8Array(0),
      closed: false,
      send: (bytes) => writer.write(bytes),
      end: async () => {
        if (connection.closed) return;
        connection.closed = true;
        reader.cancel();
        await writer.close().catch(() => undefined);
      },
    };
    this.connections.push(connection);
    void this.#run(connection, reader, writer).catch(() => connection.end());
    return connection;
  }

  async #run(connection: RfbConnection, reader: StreamReader, writer: WritableStreamDefaultWriter<Uint8Array>): Promise<void> {
    const u32 = (value: number) => {
      const bytes = new Uint8Array(4);
      new DataView(bytes.buffer).setUint32(0, value);
      return bytes;
    };
    await writer.write(new TextEncoder().encode("RFB 003.008\n"));
    await reader.read(12);
    await writer.write(this.password === null ? Uint8Array.of(1, 1) : Uint8Array.of(1, 2));
    const chosen = (await reader.read(1))[0];
    if (this.password !== null) {
      const challenge = Uint8Array.from({ length: 16 }, (_, index) => index * 7);
      await writer.write(challenge);
      const answer = await reader.read(16);
      if (chosen !== 2 || Buffer.compare(Buffer.from(answer), Buffer.from(vncResponse(challenge, this.password))) !== 0) {
        const reason = new TextEncoder().encode("Authentication failed");
        await writer.write(concat(concat(u32(1), u32(reason.byteLength)), reason));
        await connection.end();
        return;
      }
    }
    await writer.write(u32(0));
    connection.shared = (await reader.read(1))[0]!;
    const name = new TextEncoder().encode("box");
    const init = new Uint8Array(24 + name.byteLength);
    const view = new DataView(init.buffer);
    view.setUint16(0, this.width);
    view.setUint16(2, this.height);
    view.setUint32(20, name.byteLength);
    init.set(name, 24);
    await writer.write(init);

    const parser = new ClientParser();
    for (;;) {
      const chunk = await reader.next();
      if (chunk === null) break;
      connection.received = concat(connection.received, chunk.slice());
      for (const message of parser.push(chunk)) {
        if (message.type === "resize") {
          this.width = message.width;
          this.height = message.height;
        }
        if (message.bytes[0] === 3) await writer.write(EMPTY_UPDATE);
      }
    }
    await connection.end();
  }
}

/** Waits until `check` holds, for up to 5 s. */
export async function until(what: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
