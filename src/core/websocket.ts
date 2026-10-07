// A WebSocket client over a byte channel (RFC 6455), for a stream server in
// the box that speaks WebSocket, as Selkies does (056). The relay opens the
// display's route as it does for RFB, then upgrades it here. Messages come
// whole: text as strings, binary as bytes. What this side sends is masked, as
// a client's must be, and the server's pings are answered.

import { createHash, randomBytes } from "node:crypto";
import type { ByteChannel } from "../transports/types.ts";

export type Message = string | Uint8Array;

export class WebSocketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSocketError";
  }
}

/** The largest message taken from the server: a key frame of a 4K screen is a few MB. */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
/** How long closing waits for the server to take the goodbye. */
const CLOSE_WAIT_MS = 1000;
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const TEXT = 1;
const BINARY = 2;
const CLOSE = 8;
const PING = 9;
const PONG = 10;

/** Bytes from a channel, read as needed: chunks are kept apart until a read needs them joined. */
class Bytes {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #chunks: Uint8Array[] = [];
  #length = 0;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  /** Reads one more chunk; false at the end of the stream. */
  async #more(): Promise<boolean> {
    const { value, done } = await this.#reader.read();
    if (done) return false;
    if (value.byteLength) {
      this.#chunks.push(value);
      this.#length += value.byteLength;
    }
    return true;
  }

  /** Exactly `length` bytes, or null if the stream ends first. */
  async read(length: number): Promise<Uint8Array | null> {
    while (this.#length < length) if (!(await this.#more())) return null;
    const out = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const chunk = this.#chunks[0]!;
      const take = Math.min(chunk.byteLength, length - filled);
      out.set(chunk.subarray(0, take), filled);
      filled += take;
      if (take === chunk.byteLength) this.#chunks.shift();
      else this.#chunks[0] = chunk.subarray(take);
    }
    this.#length -= length;
    return out;
  }

  /** The bytes up to and including `end`, or null if the stream ends first or `max` bytes pass without it. */
  async until(end: Uint8Array, max: number): Promise<Uint8Array | null> {
    for (;;) {
      const joined = this.#peek();
      const at = indexOf(joined, end);
      if (at >= 0) return this.read(at + end.byteLength);
      if (joined.byteLength > max) return null;
      if (!(await this.#more())) return null;
    }
  }

  #peek(): Uint8Array {
    if (this.#chunks.length > 1) {
      const joined = new Uint8Array(this.#length);
      let at = 0;
      for (const chunk of this.#chunks) {
        joined.set(chunk, at);
        at += chunk.byteLength;
      }
      this.#chunks = [joined];
    }
    return this.#chunks[0] ?? new Uint8Array(0);
  }

  cancel(): void {
    void this.#reader.cancel().catch(() => undefined);
  }
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let index = 0; index + needle.byteLength <= haystack.byteLength; index++) {
    for (let offset = 0; offset < needle.byteLength; offset++) if (haystack[index + offset] !== needle[offset]) continue outer;
    return index;
  }
  return -1;
}

/** One frame from this side: final, masked. */
export function clientFrame(opcode: number, payload: Uint8Array, mask: Uint8Array = randomBytes(4)): Uint8Array {
  const length = payload.byteLength;
  const extra = length < 126 ? 0 : length < 65536 ? 2 : 8;
  const frame = new Uint8Array(2 + extra + 4 + length);
  const view = new DataView(frame.buffer);
  frame[0] = 0x80 | opcode;
  if (extra === 0) frame[1] = 0x80 | length;
  else if (extra === 2) {
    frame[1] = 0x80 | 126;
    view.setUint16(2, length);
  } else {
    frame[1] = 0x80 | 127;
    view.setBigUint64(2, BigInt(length));
  }
  frame.set(mask, 2 + extra);
  const body = 2 + extra + 4;
  for (let index = 0; index < length; index++) frame[body + index] = payload[index]! ^ mask[index & 3]!;
  return frame;
}

export interface UpgradeOptions {
  /** The Host header: the server in the box, as the route reaches it. */
  readonly host: string;
  /** The path and query, such as /api/websockets?role=viewer. */
  readonly path: string;
  readonly signal?: AbortSignal;
  readonly maxMessageBytes?: number;
}

/** A WebSocket on a box's channel, once the server accepted the upgrade. */
export class BoxWebSocket {
  readonly #channel: ByteChannel;
  readonly #bytes: Bytes;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #max: number;
  #closed = false;
  /** The code and reason the server closed with, once it has. */
  closedWith: { readonly code: number; readonly reason: string } | null = null;

  private constructor(channel: ByteChannel, bytes: Bytes, writer: WritableStreamDefaultWriter<Uint8Array>, max: number) {
    this.#channel = channel;
    this.#bytes = bytes;
    this.#writer = writer;
    this.#max = max;
  }

  /** Upgrades the channel. Closes it if the server refuses or the signal fires first. */
  static async upgrade(channel: ByteChannel, options: UpgradeOptions): Promise<BoxWebSocket> {
    const bytes = new Bytes(channel.readable);
    const writer = channel.writable.getWriter();
    const key = randomBytes(16).toString("base64");
    const aborted = new Promise<never>((_, reject) => {
      if (options.signal?.aborted) reject(new WebSocketError("The box's stream server did not answer in time."));
      options.signal?.addEventListener("abort", () => reject(new WebSocketError("The box's stream server did not answer in time.")), { once: true });
    });
    aborted.catch(() => undefined);
    try {
      await writer.write(
        new TextEncoder().encode(
          `GET ${options.path} HTTP/1.1\r\nHost: ${options.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        ),
      );
      const head = await Promise.race([bytes.until(new TextEncoder().encode("\r\n\r\n"), MAX_HEADER_BYTES), aborted]);
      if (!head) throw new WebSocketError("The box's stream server closed the connection before it answered.");
      const lines = new TextDecoder().decode(head).split("\r\n");
      const status = /^HTTP\/1\.1 (\d{3})/.exec(lines[0] ?? "")?.[1];
      if (status !== "101") throw new WebSocketError(`The box's stream server refused the WebSocket: ${lines[0] || "no status"}.`);
      const accept = lines.find((line) => /^sec-websocket-accept:/i.test(line))?.replace(/^[^:]*:\s*/, "");
      const expected = createHash("sha1").update(key + GUID).digest("base64");
      if (accept !== expected) throw new WebSocketError("The box's stream server answered the WebSocket upgrade wrongly.");
      return new BoxWebSocket(channel, bytes, writer, options.maxMessageBytes ?? MAX_MESSAGE_BYTES);
    } catch (error) {
      bytes.cancel();
      await channel.close().catch(() => undefined);
      throw error;
    }
  }

  /** The next message, or null once the server closed or the channel ended. */
  async next(): Promise<Message | null> {
    let parts: Uint8Array[] = [];
    let size = 0;
    let opcode = 0;
    for (;;) {
      const head = await this.#bytes.read(2);
      if (!head) return this.#ended();
      const fin = (head[0]! & 0x80) !== 0;
      const code = head[0]! & 0x0f;
      if (head[1]! & 0x80) throw new WebSocketError("The box's stream server sent a masked frame.");
      let length = head[1]! & 0x7f;
      if (length === 126) {
        const extended = await this.#bytes.read(2);
        if (!extended) return this.#ended();
        length = new DataView(extended.buffer, extended.byteOffset).getUint16(0);
      } else if (length === 127) {
        const extended = await this.#bytes.read(8);
        if (!extended) return this.#ended();
        const long = new DataView(extended.buffer, extended.byteOffset).getBigUint64(0);
        if (long > BigInt(this.#max)) throw new WebSocketError("The box's stream server sent a message larger than the relay takes.");
        length = Number(long);
      }
      if (size + length > this.#max) throw new WebSocketError("The box's stream server sent a message larger than the relay takes.");
      const payload = length ? await this.#bytes.read(length) : new Uint8Array(0);
      if (!payload) return this.#ended();
      if (code >= CLOSE) {
        if (code === PING) await this.#write(clientFrame(PONG, payload));
        else if (code === CLOSE) {
          const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
          this.closedWith = { code: payload.byteLength >= 2 ? view.getUint16(0) : 1005, reason: new TextDecoder().decode(payload.subarray(2)) };
          await this.close().catch(() => undefined);
          return null;
        }
        continue;
      }
      if (code !== 0) {
        if (parts.length) throw new WebSocketError("The box's stream server began a message inside another.");
        opcode = code;
      } else if (!parts.length) throw new WebSocketError("The box's stream server continued a message it had not begun.");
      parts.push(payload);
      size += length;
      if (!fin) continue;
      const whole = parts.length === 1 ? parts[0]! : joinAll(parts, size);
      parts = [];
      size = 0;
      if (opcode === TEXT) return new TextDecoder().decode(whole);
      if (opcode === BINARY) return whole;
      throw new WebSocketError(`The box's stream server sent a message of unknown type ${opcode}.`);
    }
  }

  #ended(): null {
    this.closedWith ??= { code: 1006, reason: "" };
    return null;
  }

  async #write(bytes: Uint8Array): Promise<void> {
    if (this.#closed) throw new WebSocketError("The WebSocket to the box is closed.");
    await this.#writer.write(bytes);
  }

  /** Sends one message. Resolves once the channel took it, so the sender keeps the channel's pace. */
  send(message: Message): Promise<void> {
    return typeof message === "string" ? this.#write(clientFrame(TEXT, new TextEncoder().encode(message))) : this.#write(clientFrame(BINARY, message));
  }

  /** Says goodbye, then closes the channel. A server that takes no more bytes is not waited for long. */
  async close(code = 1000): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const payload = new Uint8Array(2);
    new DataView(payload.buffer).setUint16(0, code);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.#writer.write(clientFrame(CLOSE, payload)).catch(() => undefined),
      new Promise((resolve) => (timer = setTimeout(resolve, CLOSE_WAIT_MS))),
    ]);
    clearTimeout(timer);
    this.#bytes.cancel();
    await this.#channel.close().catch(() => undefined);
  }
}

function joinAll(parts: readonly Uint8Array[], size: number): Uint8Array {
  const whole = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.byteLength;
  }
  return whole;
}
