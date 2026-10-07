// The msb relay's channels (053). msb has no daemon or API socket for the
// Docker relay (042) to forward, so bb-box's host entry runs msb on the
// machine, and each run is one channel on a relay of its own. bb-box's msb
// client (msb-client.mjs) stands in for the msb CLI on BB's server: it
// connects to the machine's socket from RelayHub, sends the run's request,
// carries its stdin, and gives back its stdout, stderr and exit status, so
// the backend's transports use plain command lines, as Docker's do (031).
//
// On the channel, each frame is a type byte, its payload's length as a
// big-endian uint32, then the payload. The client sends a request first, as
// JSON, then stdin, the end of stdin, and a terminal's sizes; the machine
// sends stdout, stderr, then the exit, or why it could not run msb.

import { existsSync } from "node:fs";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";

/** The route the machine's worker connects to, under the plugin's HTTP routes. */
export const MSB_ROUTE = "/msb-relay";

export const FRAME = {
  request: 1,
  stdin: 2,
  stdinEnd: 3,
  resize: 4,
  stdout: 16,
  stderr: 17,
  exit: 18,
  failed: 19,
} as const;

/** The most a frame of output or input carries; a request may be larger. */
export const DATA_BYTES = 64 * 1024;
/** The most a request's JSON may be, as the machine reads it. */
export const REQUEST_BYTES = 256 * 1024;

export interface TtySize {
  readonly cols: number;
  readonly rows: number;
}

/** A run of the host's bb-box msb, with these arguments; on a PTY on the machine at `tty`'s size when given. */
export interface MsbRequest {
  readonly args: readonly string[];
  readonly tty?: TtySize;
}

export function frame(type: number, payload: Uint8Array | string = new Uint8Array(0)): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const out = Buffer.alloc(5 + body.length);
  out[0] = type;
  out.writeUInt32BE(body.length, 1);
  out.set(body, 5);
  return out;
}

/** Splits a byte stream into frames, refusing one larger than `limit`. */
export class FrameReader {
  #pending = Buffer.alloc(0);
  readonly #limit: number;

  constructor(limit = REQUEST_BYTES) {
    this.#limit = limit;
  }

  push(chunk: Uint8Array): { type: number; payload: Buffer }[] {
    this.#pending = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : Buffer.from(chunk);
    const frames: { type: number; payload: Buffer }[] = [];
    while (this.#pending.length >= 5) {
      const length = this.#pending.readUInt32BE(1);
      if (length > this.#limit) throw new Error(`a frame of ${length} bytes is larger than the ${this.#limit} the relay takes`);
      if (this.#pending.length < 5 + length) break;
      frames.push({ type: this.#pending[0]!, payload: this.#pending.subarray(5, 5 + length) });
      this.#pending = this.#pending.subarray(5 + length);
    }
    return frames;
  }
}

/** A request from its JSON, or why it is not one. */
export function parseRequest(payload: Uint8Array): MsbRequest | string {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload).toString("utf8"));
  } catch {
    return "the request is not JSON";
  }
  const request = value as { args?: unknown; tty?: unknown };
  if (!request || typeof request !== "object" || !Array.isArray(request.args)) return "the request has no args";
  if (request.args.length > 4096 || !request.args.every((arg) => typeof arg === "string" && !arg.includes("\0"))) return "the request's args are not strings";
  let tty: TtySize | undefined;
  if (request.tty !== undefined) {
    const size = request.tty as { cols?: unknown; rows?: unknown };
    if (!Number.isInteger(size?.cols) || !Number.isInteger(size?.rows)) return "the request's tty is not a size";
    tty = clamp({ cols: size.cols as number, rows: size.rows as number });
  }
  return { args: request.args as string[], ...(tty ? { tty } : {}) };
}

/** A size `stty` takes: whole numbers from 1 to 1000. */
export function clamp(size: TtySize): TtySize {
  const whole = (value: number, fallback: number) => (Number.isFinite(value) && value >= 1 ? Math.min(1000, Math.round(value)) : fallback);
  return { cols: whole(size.cols, 80), rows: whole(size.rows, 24) };
}

/** Answers a client the relay cannot carry with the reason, which it prints. */
export function refuseMsb(socket: Socket, reason: string): void {
  socket.end(frame(FRAME.failed, reason));
}

/**
 * The client's path. In the repository it is beside this file; the
 * plugin's bundle, dist/server.js, has the plugin's files one up.
 */
export function msbClientPath(): string {
  const here = fileURLToPath(new URL("./msb-client.mjs", import.meta.url));
  if (existsSync(here)) return here;
  return fileURLToPath(new URL("../src/relay/msb-client.mjs", import.meta.url));
}

/** The command line that runs `request` on a machine whose msb relay socket is `socket`, with node here. */
export function msbClientArgv(socket: string, request: { readonly args: readonly string[]; readonly tty?: boolean }, node = process.execPath): [string, ...string[]] {
  return [node, msbClientPath(), socket, JSON.stringify(request)];
}
