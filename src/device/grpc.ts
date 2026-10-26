import { connect as connectHttp2, constants, type ClientHttp2Session } from "node:http2";
import { connect as connectSocket } from "node:net";

const PREFIX_BYTES = 5;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const UNKNOWN = 2;
const RESOURCE_EXHAUSTED = 8;
const INTERNAL = 13;

export type GrpcTarget = { readonly tcp: string } | { readonly socket: string };

export class GrpcError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GrpcError";
    this.status = status;
  }
}

export function frame(message: Uint8Array): Uint8Array {
  const out = new Uint8Array(PREFIX_BYTES + message.byteLength);
  new DataView(out.buffer).setUint32(1, message.byteLength);
  out.set(message, PREFIX_BYTES);
  return out;
}

export class Deframer {
  #buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    const joined = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    joined.set(this.#buffer);
    joined.set(chunk, this.#buffer.byteLength);
    this.#buffer = joined;
    const messages: Uint8Array[] = [];
    while (this.#buffer.byteLength >= PREFIX_BYTES) {
      const view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset);
      if (this.#buffer[0] !== 0) throw new GrpcError(INTERNAL, "The server sent a compressed message, which the client did not ask for.");
      const length = view.getUint32(1);
      if (length > MAX_MESSAGE_BYTES) throw new GrpcError(RESOURCE_EXHAUSTED, `The server sent a message of ${length} bytes, more than the client takes.`);
      if (this.#buffer.byteLength < PREFIX_BYTES + length) break;
      messages.push(this.#buffer.slice(PREFIX_BYTES, PREFIX_BYTES + length));
      this.#buffer = this.#buffer.subarray(PREFIX_BYTES + length);
    }
    return messages;
  }
}

export interface CallOptions {
  readonly metadata?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export class GrpcClient {
  readonly #session: ClientHttp2Session;

  constructor(target: GrpcTarget) {
    this.#session = "tcp" in target ? connectHttp2(target.tcp) : connectHttp2("http://localhost", { createConnection: () => connectSocket(target.socket) });
    this.#session.on("error", () => undefined);
  }

  close(): void {
    this.#session.close();
  }

  async *call(path: string, requests: Iterable<Uint8Array> | AsyncIterable<Uint8Array>, options: CallOptions = {}): AsyncIterable<Uint8Array> {
    const stream = this.#session.request(
      { ":method": "POST", ":path": path, "content-type": "application/grpc", te: "trailers", ...options.metadata },
      { signal: options.signal },
    );
    stream.on("error", () => undefined);
    let status: number | null = null;
    let words = "";
    let httpStatus = 0;
    stream.on("response", (headers) => {
      httpStatus = Number(headers[":status"] ?? 0);
      if (headers["grpc-status"] !== undefined) {
        status = Number(headers["grpc-status"]);
        words = decodeURIComponent(String(headers["grpc-message"] ?? ""));
      }
    });
    stream.on("trailers", (trailers) => {
      status = Number(trailers["grpc-status"] ?? UNKNOWN);
      words = decodeURIComponent(String(trailers["grpc-message"] ?? ""));
    });
    const sending = (async () => {
      for await (const request of requests) {
        if (!stream.write(frame(request))) await new Promise((resolve) => stream.once("drain", resolve));
      }
      stream.end();
    })();
    sending.catch(() => stream.close(constants.NGHTTP2_CANCEL));
    const deframer = new Deframer();
    for await (const chunk of stream) for (const message of deframer.push(chunk as Uint8Array)) yield message;
    if (httpStatus !== 0 && httpStatus !== 200) throw new GrpcError(UNKNOWN, `The server answered HTTP ${httpStatus}.`);
    if (status === null) throw new GrpcError(UNKNOWN, "The server ended the call with no status.");
    if (status !== 0) throw new GrpcError(status, words || `gRPC status ${status}`);
  }

  async unary(path: string, request: Uint8Array, options: CallOptions = {}): Promise<Uint8Array> {
    const answers: Uint8Array[] = [];
    for await (const answer of this.call(path, [request], options)) answers.push(answer);
    if (answers.length !== 1) throw new GrpcError(UNKNOWN, `The server sent ${answers.length} answers to a call that takes one.`);
    return answers[0]!;
  }
}
