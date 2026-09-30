// A small MCP client over a byte channel: newline-delimited JSON-RPC, as an
// MCP server speaks on its stdin and stdout. Computer use (015) runs the
// driver's MCP server in the box through the command transport's spawn and
// talks to it with this.

import type { ByteChannel } from "../transports/types.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
/** The longest line bb-box reads: a screenshot is one line of base64. */
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const NEWLINE = 0x0a;

export interface McpContent {
  readonly type: string;
  readonly text?: string;
  readonly data?: string;
  readonly mimeType?: string;
}

export interface McpResult {
  readonly content: readonly McpContent[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError: boolean;
}

/** The session ended, or never started. Calls in flight may or may not have been done. */
export class McpClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpClosedError";
  }
}

/** The server answered a request with a JSON-RPC error. */
export class McpError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface Message {
  readonly id?: number | string | null;
  readonly method?: string;
  readonly result?: unknown;
  readonly error?: { code?: number; message?: string };
}

export class McpSession {
  readonly #channel: ByteChannel;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #pending = new Map<number, Pending>();
  readonly #onClose: (error: Error) => void;
  #next = 1;
  #closed: Error | null = null;
  #ended: Promise<void> | null = null;

  private constructor(channel: ByteChannel, onClose: (error: Error) => void) {
    this.#channel = channel;
    this.#writer = channel.writable.getWriter();
    this.#onClose = onClose;
    void this.#read();
  }

  /** Starts a session: initialize, then the initialized notification. Closes the channel if that fails. */
  static async open(
    channel: ByteChannel,
    options: { client: { name: string; version: string }; timeoutMs: number; signal?: AbortSignal; onClose?: (error: Error) => void },
  ): Promise<McpSession> {
    const session = new McpSession(channel, options.onClose ?? (() => {}));
    try {
      await session.request(
        "initialize",
        { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: options.client },
        { timeoutMs: options.timeoutMs, signal: options.signal },
      );
      await session.#send({ jsonrpc: "2.0", method: "notifications/initialized" });
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  get closed(): boolean {
    return this.#closed !== null;
  }

  /** Calls a tool. A result with isError is returned, not thrown: it is the tool's answer. */
  async call(name: string, args: Record<string, unknown>, options: { timeoutMs: number; signal?: AbortSignal }): Promise<McpResult> {
    const result = (await this.request("tools/call", { name, arguments: args }, options)) as Partial<McpResult> | null;
    return {
      content: Array.isArray(result?.content) ? result.content : [],
      structuredContent: result?.structuredContent && typeof result.structuredContent === "object" ? result.structuredContent : undefined,
      isError: result?.isError === true,
    };
  }

  request(method: string, params: unknown, options: { timeoutMs: number; signal?: AbortSignal }): Promise<unknown> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const { signal } = options;
      const settle = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.#pending.delete(id);
      };
      const cancel = (error: Error) => {
        settle();
        void this.#send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: error.message } }).catch(() => {});
        reject(error);
      };
      const abort = () => cancel(signal!.reason instanceof Error ? signal!.reason : new Error("The call was cancelled."));
      const timer = setTimeout(() => cancel(new Error(`The computer-use driver did not answer ${method} within ${Math.round(options.timeoutMs / 1000)} s.`)), options.timeoutMs);
      timer.unref?.();
      this.#pending.set(id, {
        resolve: (value) => {
          settle();
          resolve(value);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      });
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      this.#send({ jsonrpc: "2.0", id, method, params }).catch((error) => this.#end(error));
    });
  }

  /** Ends the session and the command behind it. Calls in flight fail with McpClosedError, saying `reason`. */
  async close(reason = "The computer-use session was closed."): Promise<void> {
    this.#end(new McpClosedError(reason));
    await this.#ended;
  }

  async #send(message: unknown): Promise<void> {
    if (this.#closed) throw this.#closed;
    await this.#writer.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
  }

  #end(error: unknown): void {
    if (this.#closed) return;
    const reason = error instanceof McpClosedError ? error : new McpClosedError(`The computer-use session ended: ${error instanceof Error ? error.message : String(error)}`);
    this.#closed = reason;
    for (const pending of [...this.#pending.values()]) pending.reject(reason);
    this.#pending.clear();
    this.#ended = this.#channel.close().catch(() => {});
    this.#onClose(reason);
  }

  async #read(): Promise<void> {
    const reader = this.#channel.readable.getReader();
    let parts: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        let start = 0;
        for (let at = value.indexOf(NEWLINE); at !== -1; at = value.indexOf(NEWLINE, start)) {
          parts.push(value.subarray(start, at));
          this.#line(Buffer.concat(parts).toString("utf8"));
          parts = [];
          length = 0;
          start = at + 1;
        }
        if (start < value.byteLength) {
          parts.push(value.subarray(start));
          length += value.byteLength - start;
          if (length > MAX_LINE_BYTES) throw new Error(`the driver sent a message over ${MAX_LINE_BYTES / 1024 / 1024} MiB`);
        }
      }
      this.#end(new McpClosedError("The computer-use driver ended the session."));
    } catch (error) {
      this.#end(error);
    } finally {
      reader.releaseLock();
    }
  }

  #line(line: string): void {
    if (!line.trim()) return;
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      // Not JSON-RPC, such as a stray log line: ignore it.
      return;
    }
    if (message.method !== undefined) {
      // A request from the server: answer ping, refuse the rest. Notifications need no answer.
      if (message.id === undefined || message.id === null) return;
      const answer =
        message.method === "ping"
          ? { jsonrpc: "2.0", id: message.id, result: {} }
          : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `bb-box does not handle ${message.method}.` } };
      void this.#send(answer).catch(() => {});
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    if (message.error) pending.reject(new McpError(message.error.code ?? -32603, message.error.message ?? "The driver gave no reason."));
    else pending.resolve(message.result);
  }
}
