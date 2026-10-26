import { createHash } from "node:crypto";
import type { Socket } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const TEXT = 1;
const BINARY = 2;
const CLOSE = 8;
const PING = 9;
const PONG = 10;

export type WsMessage = string | Uint8Array;

export interface Upgrade {
  readonly path: string;
  readonly query: URLSearchParams;
}

function serverFrame(opcode: number, payload: Uint8Array): Buffer {
  const length = payload.byteLength;
  const extra = length < 126 ? 0 : length < 65536 ? 2 : 8;
  const head = Buffer.alloc(2 + extra);
  head[0] = 0x80 | opcode;
  if (extra === 0) head[1] = length;
  else if (extra === 2) {
    head[1] = 126;
    head.writeUInt16BE(length, 2);
  } else {
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([head, payload]);
}

export function acceptKey(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

export class ServerWebSocket {
  readonly #socket: Socket;
  #buffer: Buffer = Buffer.alloc(0);
  #parts: Buffer[] = [];
  #opcode = 0;
  #closed = false;
  onMessage: (message: WsMessage) => void = () => {};
  onClose: () => void = () => {};

  private constructor(socket: Socket, rest: Buffer) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => this.#take(chunk));
    socket.on("close", () => this.#ended());
    socket.on("error", () => this.#ended());
    if (rest.byteLength) queueMicrotask(() => this.#take(rest));
  }

  static accept(socket: Socket): Promise<{ readonly ws: ServerWebSocket; readonly upgrade: Upgrade } | null> {
    return new Promise((resolve) => {
      let head = Buffer.alloc(0);
      const refuse = (status: string) => {
        socket.off("data", onData);
        socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
        resolve(null);
      };
      const onData = (chunk: Buffer) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) {
          if (head.byteLength > MAX_HEADER_BYTES) refuse("431 Request Header Fields Too Large");
          return;
        }
        socket.off("data", onData);
        const lines = head.subarray(0, end).toString("latin1").split("\r\n");
        const target = /^GET (\S+) HTTP\/1\.1$/.exec(lines[0] ?? "")?.[1];
        const key = lines.find((line) => /^sec-websocket-key:/i.test(line))?.replace(/^[^:]*:\s*/, "").trim();
        if (!target || !key) {
          refuse("400 Bad Request");
          return;
        }
        const url = new URL(target, "http://device");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
        resolve({ ws: new ServerWebSocket(socket, head.subarray(end + 4)), upgrade: { path: url.pathname, query: url.searchParams } });
      };
      socket.on("data", onData);
      socket.once("close", () => resolve(null));
      socket.once("error", () => resolve(null));
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  get queuedBytes(): number {
    return this.#socket.writableLength;
  }

  #ended(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.onClose();
  }

  #take(chunk: Buffer): void {
    this.#buffer = this.#buffer.byteLength ? Buffer.concat([this.#buffer, chunk]) : chunk;
    for (;;) {
      if (this.#buffer.byteLength < 2) return;
      const first = this.#buffer[0]!;
      const second = this.#buffer[1]!;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let at = 2;
      if (length === 126) {
        if (this.#buffer.byteLength < 4) return;
        length = this.#buffer.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (this.#buffer.byteLength < 10) return;
        const long = this.#buffer.readBigUInt64BE(2);
        if (long > BigInt(MAX_MESSAGE_BYTES)) {
          this.close(1009);
          return;
        }
        length = Number(long);
        at = 10;
      }
      if (!masked) {
        this.close(1002);
        return;
      }
      if (this.#buffer.byteLength < at + 4 + length) return;
      const mask = this.#buffer.subarray(at, at + 4);
      const payload = Buffer.alloc(length);
      for (let index = 0; index < length; index++) payload[index] = this.#buffer[at + 4 + index]! ^ mask[index & 3]!;
      this.#buffer = this.#buffer.subarray(at + 4 + length);
      this.#frame((first & 0x80) !== 0, first & 0x0f, payload);
      if (this.#closed) return;
    }
  }

  #frame(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode === PING) {
      this.#write(serverFrame(PONG, payload));
      return;
    }
    if (opcode === PONG) return;
    if (opcode === CLOSE) {
      this.close(1000);
      return;
    }
    if (opcode !== 0) this.#opcode = opcode;
    this.#parts.push(payload);
    if (!fin) return;
    const whole = this.#parts.length === 1 ? this.#parts[0]! : Buffer.concat(this.#parts);
    this.#parts = [];
    if (this.#opcode === TEXT) this.onMessage(whole.toString("utf8"));
    else if (this.#opcode === BINARY) this.onMessage(new Uint8Array(whole));
  }

  #write(bytes: Buffer): void {
    if (this.#closed || this.#socket.destroyed) return;
    this.#socket.write(bytes);
  }

  send(message: WsMessage): void {
    this.#write(typeof message === "string" ? serverFrame(TEXT, Buffer.from(message, "utf8")) : serverFrame(BINARY, message));
  }

  close(code = 1000, reason = ""): void {
    if (this.#closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.#write(serverFrame(CLOSE, payload));
    this.#socket.end();
    this.#ended();
  }
}
