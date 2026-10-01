// Opens routes: the only code that does. A route may hold a secret, so
// nothing here logs it, and errors name only its type and where it leads.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { connect as tcpConnect, isIP, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { Agent, WebSocket, buildConnector } from "undici";
import type { ByteChannel, Route } from "./types.ts";

/** Chunks a reader may fall behind by before the source is paused. */
const HIGH_WATER_BYTES = 256 * 1024;

export class RouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteError";
  }
}

export function openRoute(route: Route, signal?: AbortSignal): Promise<ByteChannel> {
  signal?.throwIfAborted();
  switch (route.type) {
    case "tcp":
      return openTcp(route.host, route.port, signal);
    case "command":
      return openCommand(route.argv, signal);
    case "websocket":
      return openWebSocket(route, signal);
  }
}

/** A web stream over a Node stream that pauses the source while the reader is behind. */
function readableFrom(source: Readable, finished: () => Promise<Error | null>): ReadableStream<Uint8Array> {
  let done = false;
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        source.on("data", (chunk: Buffer) => {
          if (done) return;
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
          if ((controller.desiredSize ?? 1) <= 0) source.pause();
        });
        source.once("end", () => {
          void finished().then((error) => {
            if (done) return;
            done = true;
            if (error) controller.error(error);
            else controller.close();
          });
        });
        source.once("error", (error) => {
          if (done) return;
          done = true;
          controller.error(error);
        });
      },
      pull() {
        source.resume();
      },
      cancel() {
        done = true;
        source.destroy();
      },
    },
    { highWaterMark: HIGH_WATER_BYTES, size: (chunk) => chunk.byteLength },
  );
}

/** A web stream into a Node stream. Each write resolves once the target takes it. */
function writableTo(target: Writable): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write: (chunk) => new Promise((resolve, reject) => target.write(chunk, (error) => (error ? reject(error) : resolve()))),
    close: () => new Promise((resolve) => target.end(resolve)),
    abort: () => {
      target.destroy();
    },
  });
}

function openTcp(host: string, port: number, signal?: AbortSignal): Promise<ByteChannel> {
  return new Promise((resolve, reject) => {
    const socket: Socket = tcpConnect({ host, port });
    const abort = () => socket.destroy(signal!.reason instanceof Error ? signal!.reason : new RouteError("Opening the route was cancelled."));
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(new RouteError(`Cannot connect to ${host}:${port}: ${error.message}`));
    });
    socket.once("connect", () => {
      signal?.removeEventListener("abort", abort);
      socket.removeAllListeners("error");
      socket.on("error", () => {
        // Reported through the streams.
      });
      socket.setNoDelay(true);
      resolve({
        readable: readableFrom(socket, async () => null),
        writable: writableTo(socket),
        close: async () => {
          socket.destroy();
        },
      });
    });
  });
}

function openCommand(argv: readonly [string, ...string[]], signal?: AbortSignal): Promise<ByteChannel> {
  const [binary, ...args] = argv;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    // The signal is for opening only; a route in use is closed with close().
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2_000);
    });
    const exited = new Promise<number | null>((done) => child.once("close", (code) => done(code)));
    child.stdin.on("error", () => {
      // The command may exit before it reads everything.
    });
    child.once("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(new RouteError(`Cannot run ${binary} for the route: ${error.message}`));
    });
    child.once("spawn", () => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(signal.reason);
      resolve({
        readable: readableFrom(child.stdout, async () => {
          const code = await exited;
          if (code === 0 || code === null) return null;
          const detail = stderr.trim().split("\n").slice(-2).join(" ");
          return new RouteError(`The route's ${binary} exited with ${code}${detail ? `: ${detail}` : "."}`);
        }),
        writable: writableTo(child.stdin),
        close: async () => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          await exited;
        },
      });
    });
  });
}

function normalise(fingerprint: string): string {
  return fingerprint.replaceAll(":", "").toLowerCase();
}

/** A dispatcher that accepts only the certificate with `fingerprint`, self-signed or not. */
function pinnedAgent(fingerprint: string): Agent {
  const expected = normalise(fingerprint);
  const plain = buildConnector({});
  return new Agent({
    connect: (options, callback) => {
      if (options.protocol !== "https:" && options.protocol !== "wss:") return plain(options, callback);
      const socket = tlsConnect({
        host: options.hostname,
        port: Number(options.port) || 443,
        servername: isIP(options.hostname) ? undefined : (options.servername ?? options.hostname),
        rejectUnauthorized: false,
        ALPNProtocols: ["http/1.1"],
      });
      socket.once("secureConnect", () => {
        const certificate = socket.getPeerCertificate(false);
        const actual = certificate?.raw ? createHash("sha256").update(certificate.raw).digest("hex") : "";
        if (actual !== expected) {
          socket.destroy();
          callback(new RouteError(`The certificate of ${options.hostname} does not match the pinned fingerprint.`), null);
          return;
        }
        callback(null, socket);
      });
      socket.once("error", (error) => callback(error, null));
    },
  });
}

async function openWebSocket(route: Extract<Route, { type: "websocket" }>, signal?: AbortSignal): Promise<ByteChannel> {
  const where = new URL(route.url).host;
  const dispatcher = route.fingerprint ? pinnedAgent(route.fingerprint) : route.ca ? new Agent({ connect: { ca: route.ca } }) : undefined;
  const socket = new WebSocket(route.url, { headers: route.headers, protocols: route.protocols ? [...route.protocols] : undefined, dispatcher });
  socket.binaryType = "arraybuffer";
  const closeAgent = () => dispatcher?.close().catch(() => undefined);
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      socket.close();
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    socket.addEventListener("open", () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, { once: true });
    socket.addEventListener("error", (event) => {
      signal?.removeEventListener("abort", abort);
      const cause = (event as { error?: unknown }).error;
      reject(new RouteError(`Cannot open the WebSocket to ${where}${cause instanceof Error ? `: ${cause.message}` : "."}`));
    }, { once: true });
  }).catch((error) => {
    void closeAgent();
    throw error;
  });

  let done = false;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      socket.addEventListener("message", (event) => {
        if (done) return;
        const data = event.data;
        controller.enqueue(typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data as ArrayBuffer));
      });
      socket.addEventListener("close", (event) => {
        void closeAgent();
        if (done) return;
        done = true;
        if (event.code === 1000 || event.code === 1005) controller.close();
        else controller.error(new RouteError(`The WebSocket to ${where} closed with ${event.code}${event.reason ? `: ${event.reason}` : "."}`));
      });
    },
    cancel() {
      done = true;
      socket.close();
    },
  });
  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      if (socket.readyState !== WebSocket.OPEN) throw new RouteError(`The WebSocket to ${where} is closed.`);
      socket.send(chunk);
      // WebSocket has no write callback, so wait while too much is queued.
      while (socket.bufferedAmount > HIGH_WATER_BYTES && socket.readyState === WebSocket.OPEN) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    close() {
      socket.close(1000);
    },
    abort() {
      socket.close();
    },
  });
  return {
    readable,
    writable,
    close: async () => {
      if (socket.readyState === WebSocket.CLOSED) return;
      const closed = new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
      socket.close(1000);
      await closed;
    },
  };
}
