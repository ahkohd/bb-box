// Channels over one message link, for the Docker API relay (042). Each
// channel is a Node Duplex carrying bytes both ways. A side sends only as
// much as the other has granted, INITIAL_WINDOW at first, and grants more as
// its reader drains, since BB's plugin socket has no backpressure (request
// 2). Each direction ends on its own: `docker exec` and `docker cp` close
// their input before their output. A ping every PING_MS finds a dead link.
//
// A frame is one binary message: a type byte, the channel as a big-endian
// uint32, then the payload, at most FRAME_BYTES of data.

import { Duplex } from "node:stream";

/**
 * What a side may send before the other grants more. The worker reaches the
 * server through BB's public URL, so even a PC on the LAN can be tens of ms
 * away: 256 KiB carried 8 MiB/s at 30 ms, 1 MiB 34 MiB/s. Memory stays
 * bounded at this much per open channel on each side.
 */
export const INITIAL_WINDOW = 1024 * 1024;
export const FRAME_BYTES = 64 * 1024;
export const PING_MS = 15_000;
/** A link that has sent nothing for this long is dead. */
export const DEAD_MS = 3 * PING_MS;

const OPEN = 1;
const DATA = 2;
const CREDIT = 3;
const EOF = 4;
const RESET = 5;
const PING = 6;
const PONG = 7;

/** One end of the link: a WebSocket, or an in-memory pair in tests. */
export interface Link {
  send(frame: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface MuxOptions {
  /** A channel the other side opened. Unset refuses them. */
  readonly onOpen?: (channel: Channel) => void;
  /** Called once when the link ends, by either side or a missing ping. */
  readonly onClose?: (reason: string) => void;
  /** Odd for the side that opens channels, even for the other, so IDs never clash. */
  readonly opener: boolean;
  readonly initialWindow?: number;
  readonly frameBytes?: number;
  readonly pingMs?: number;
  readonly deadMs?: number;
}

function frame(type: number, channel: number, payload?: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + (payload?.length ?? 0));
  out[0] = type;
  new DataView(out.buffer).setUint32(1, channel);
  if (payload) out.set(payload, 5);
  return out;
}

function uint32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

export class Mux {
  readonly #link: Link;
  readonly #options: MuxOptions;
  readonly #channels = new Map<number, Channel>();
  #next: number;
  #closed: string | null = null;
  #heard = Date.now();
  readonly #pinger: ReturnType<typeof setInterval>;

  constructor(link: Link, options: MuxOptions) {
    this.#link = link;
    this.#options = options;
    this.#next = options.opener ? 1 : 2;
    const pingMs = options.pingMs ?? PING_MS;
    const deadMs = options.deadMs ?? DEAD_MS;
    this.#pinger = setInterval(() => {
      if (Date.now() - this.#heard > deadMs) this.close(`nothing came over the relay for ${Math.round(deadMs / 1000)} s`);
      else this.send(frame(PING, 0));
    }, pingMs);
    this.#pinger.unref?.();
  }

  get channels(): number {
    return this.#channels.size;
  }

  get closed(): string | null {
    return this.#closed;
  }

  /** How long since the other side last sent anything. Its pings make this at most PING_MS on a live link. */
  get quietMs(): number {
    return Date.now() - this.#heard;
  }

  /** Opens a channel to the other side. */
  open(): Channel {
    if (this.#closed) throw new Error(`The relay is closed: ${this.#closed}`);
    const id = this.#next;
    this.#next += 2;
    const channel = this.#channel(id);
    this.send(frame(OPEN, id));
    return channel;
  }

  /** A message from the link. */
  receive(data: Uint8Array): void {
    if (this.#closed) return;
    this.#heard = Date.now();
    if (data.length < 5) return this.close("a frame was too short");
    const type = data[0]!;
    const id = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1);
    const payload = data.subarray(5);
    if (type === PING) return this.send(frame(PONG, 0));
    if (type === PONG) return;
    if (type === OPEN) {
      if (!this.#options.onOpen || this.#channels.has(id)) return this.send(frame(RESET, id, new TextEncoder().encode("This side opens no channels.")));
      this.#options.onOpen(this.#channel(id));
      return;
    }
    const channel = this.#channels.get(id);
    if (!channel) return;
    if (type === DATA) channel.receiveData(payload);
    else if (type === CREDIT && payload.length === 4) channel.receiveCredit(new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0));
    else if (type === EOF) channel.receiveEof();
    else if (type === RESET) channel.receiveReset(new TextDecoder().decode(payload) || "the other side reset the channel");
  }

  /** Ends the link and every channel on it. */
  close(reason: string): void {
    if (this.#closed) return;
    this.#closed = reason;
    clearInterval(this.#pinger);
    for (const channel of [...this.#channels.values()]) channel.receiveReset(`The relay closed: ${reason}`);
    try {
      this.#link.close(1000, reason.slice(0, 120));
    } catch {}
    this.#options.onClose?.(reason);
  }

  send(data: Uint8Array): void {
    if (this.#closed) return;
    try {
      this.#link.send(data);
    } catch (error) {
      this.close(`sending failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  forget(id: number): void {
    this.#channels.delete(id);
  }

  #channel(id: number): Channel {
    const channel = new Channel(this, id, this.#options.initialWindow ?? INITIAL_WINDOW, this.#options.frameBytes ?? FRAME_BYTES);
    this.#channels.set(id, channel);
    return channel;
  }
}

export class Channel extends Duplex {
  readonly id: number;
  readonly #mux: Mux;
  readonly #window: number;
  readonly #frameBytes: number;
  /** Bytes the other side has let this side send, and has not been sent. */
  #credit: number;
  /** Writes waiting for credit, with how much of each is sent. */
  readonly #pending: { chunk: Uint8Array; sent: number; done: (error?: Error | null) => void }[] = [];
  /** Bytes the other side may send in all: the window and every grant. */
  #allowed: number;
  #received = 0;
  #granted = 0;
  #sentEof = false;
  #gotEof = false;
  #reset = false;
  #granting = false;

  constructor(mux: Mux, id: number, window: number, frameBytes: number) {
    super({ allowHalfOpen: true, readableHighWaterMark: window, writableHighWaterMark: window });
    this.#mux = mux;
    this.id = id;
    this.#window = window;
    this.#frameBytes = frameBytes;
    this.#credit = window;
    this.#allowed = window;
  }

  override _write(chunk: Uint8Array, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.#pending.push({ chunk, sent: 0, done });
    this.#flush();
  }

  override _final(done: (error?: Error | null) => void): void {
    // Every write has been sent: _final follows their callbacks.
    this.#sentEof = true;
    this.#mux.send(frame(EOF, this.id));
    done();
  }

  override _read(): void {
    this.#grantSoon();
  }

  /**
   * Every way of reading goes through read(), but Node calls _read before it
   * takes the chunk it returns, and not again until something is pushed, so
   * credit is granted after each read instead.
   */
  override read(size?: number): any {
    const chunk = super.read(size);
    this.#grantSoon();
    return chunk;
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    const clean = this.#sentEof && this.#gotEof && !error;
    if (!this.#reset && !clean) {
      this.#mux.send(frame(RESET, this.id, new TextEncoder().encode((error?.message ?? "closed").slice(0, 500))));
    }
    for (const { done: write } of this.#pending.splice(0)) write(error ?? new Error("The channel closed."));
    this.#mux.forget(this.id);
    done(error);
  }

  receiveData(payload: Uint8Array): void {
    this.#received += payload.length;
    if (this.#received > this.#allowed) {
      this.destroy(new Error("The other side sent more than it was granted."));
      return;
    }
    // Copied: the payload is a view of the link's message.
    this.push(Buffer.from(payload));
    this.#grantSoon();
  }

  receiveCredit(bytes: number): void {
    this.#credit += bytes;
    this.#flush();
  }

  receiveEof(): void {
    this.#gotEof = true;
    this.push(null);
  }

  receiveReset(reason: string): void {
    this.#reset = true;
    this.destroy(new Error(reason));
  }

  #flush(): void {
    while (this.#pending.length && this.#credit > 0 && !this.destroyed) {
      const head = this.#pending[0]!;
      const size = Math.min(this.#credit, this.#frameBytes, head.chunk.length - head.sent);
      this.#mux.send(frame(DATA, this.id, head.chunk.subarray(head.sent, head.sent + size)));
      this.#credit -= size;
      head.sent += size;
      if (head.sent === head.chunk.length) {
        this.#pending.shift();
        head.done();
      }
    }
  }

  #grantSoon(): void {
    if (this.#granting) return;
    this.#granting = true;
    queueMicrotask(() => {
      this.#granting = false;
      this.#grant();
    });
  }

  /** Grants what the reader has taken, in steps of a quarter window, or all once it has caught up. */
  #grant(): void {
    const consumed = this.#received - this.readableLength;
    const owed = consumed - this.#granted;
    if (owed <= 0 || this.#reset || this.#gotEof) return;
    if (owed < this.#window / 4 && this.readableLength > 0) return;
    this.#granted += owed;
    this.#allowed += owed;
    this.#mux.send(frame(CREDIT, this.id, uint32(owed)));
  }
}
