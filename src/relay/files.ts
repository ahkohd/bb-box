// The server's end of a file copy through the thread's machine's worker
// (#492, src/host/files.ts). A copy makes a one-time secret, asks the
// worker to copy the file over a WebSocket to FILE_ROUTE with it, and opens
// one channel on that socket's Mux once it connects. The channel carries the
// file's bytes one way, with the Mux's flow control, and bb-box closes the
// link when it is done with it.

import { randomBytes } from "node:crypto";
import { Mux, type Channel } from "./mux.ts";
import type { RelaySocket } from "./hub.ts";

/** The route the worker connects to, under the plugin's HTTP routes. */
export const FILE_ROUTE = "/file-relay";
/** How long a copy waits for the worker's socket. */
export const FILE_ACCEPT_MS = 15_000;

/** What the worker's "file" call takes, less the route's path, which the deps add. */
export interface FileCall {
  readonly secret: string;
  readonly file: string;
  readonly root?: string;
  readonly direction: "send" | "receive";
  /** What a received file must be before it replaces `file`. */
  readonly expect?: FileDone;
}

/** What went through on the worker's side: its size and SHA-256 in hex. */
export interface FileDone {
  readonly bytes: number;
  readonly sha256: string;
}

export interface FileRelayDeps {
  /** Calls the machine's worker's "file", which answers once its side is done. */
  call(hostId: string, request: FileCall, signal?: AbortSignal): Promise<FileDone>;
  logError(operation: string, error: unknown): void;
  readonly acceptMs?: number;
  readonly pingMs?: number;
  readonly deadMs?: number;
}

interface Pending {
  readonly opened: (mux: Mux) => void;
  settled: boolean;
}

export class FileRelay {
  readonly #deps: FileRelayDeps;
  readonly #pending = new Map<string, Pending>();

  constructor(deps: FileRelayDeps) {
    this.#deps = deps;
  }

  /** The handler for bb-box's WebSocket route, which the worker connects to. */
  route(url: URL) {
    const secret = url.searchParams.get("s") ?? "";
    const pending = this.#pending.get(secret);
    this.#pending.delete(secret);
    let mux: Mux | null = null;
    return {
      onOpen: (socket: RelaySocket) => {
        if (!pending || pending.settled) {
          socket.close(1008, "This copy's secret is unknown or used.");
          return;
        }
        pending.settled = true;
        mux = new Mux({ send: (data) => socket.send(data), close: (code, reason) => socket.close(code, reason) }, { opener: true, pingMs: this.#deps.pingMs, deadMs: this.#deps.deadMs });
        pending.opened(mux);
      },
      onMessage: (_socket: RelaySocket, data: string | Uint8Array) => {
        if (typeof data !== "string") mux?.receive(data);
      },
      onClose: () => mux?.close("the machine's side closed"),
      onError: (_socket: RelaySocket, error: Error) => this.#deps.logError("file relay", error),
    };
  }

  /**
   * Copies a file on machine `hostId` through its worker: `use` gets the
   * channel, which carries the file from the worker for `send`, or takes it
   * to the worker for `receive`, and must end it then. Resolves with what
   * the worker says went through, and what `use` returned.
   */
  async copy<T>(hostId: string, file: Omit<FileCall, "secret">, use: (channel: Channel) => Promise<T>, signal?: AbortSignal): Promise<{ done: FileDone; result: T }> {
    const secret = randomBytes(16).toString("hex");
    let opened!: (mux: Mux) => void;
    const linked = new Promise<Mux>((resolve) => (opened = resolve));
    const pending: Pending = { opened, settled: false };
    this.#pending.set(secret, pending);
    const call = this.#deps.call(hostId, { ...file, secret }, signal);
    call.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`The thread's machine did not connect to bb-box for the copy within ${(this.#deps.acceptMs ?? FILE_ACCEPT_MS) / 1000} s.`)), this.#deps.acceptMs ?? FILE_ACCEPT_MS);
    });
    let mux: Mux;
    try {
      // The call fails first when the worker cannot read the file or reach bb-box.
      mux = await Promise.race([linked, call.then(() => Promise.reject(new Error("The thread's machine ended the copy before it connected."))), late]);
    } finally {
      clearTimeout(timer);
      pending.settled = true;
      this.#pending.delete(secret);
    }
    try {
      const channel = mux.open();
      // Closing the link resets the channel once its streams are done with it.
      channel.on("error", () => undefined);
      let result: T;
      try {
        result = await use(channel);
      } catch (error) {
        // The worker's own failure, such as a file it cannot read, says more than the channel it reset.
        const failed = await Promise.race([call.then(() => null, (reason: unknown) => reason), new Promise((resolve) => setTimeout(() => resolve(null), 2_000))]);
        throw failed ?? error;
      }
      return { done: await call, result };
    } finally {
      mux.close("the copy ended");
    }
  }
}
