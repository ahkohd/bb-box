// Transports reach inside a box. Backends compose them: a backend says which
// transports reach each of its boxes, and bb-box's core uses them without
// knowing which provider made the box. Commands and file copies go through a
// CommandTransport (SSH now; docker exec or a guest agent later). A desktop
// is a Display, whose route leads to a stream server inside the box. Routes
// are plain data, opened only by openRoute in route.ts.

export type GuestOs = "linux" | "windows" | "macos";
export type Arch = "x86_64" | "arm64";
/** The desktop viewer picks its client by protocol: noVNC for "rfb". */
export type DisplayProtocol = "rfb" | "selkies";

/** A two-way byte stream with backpressure. */
export interface ByteChannel {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  /** Closes both directions and frees what the route holds, such as a process. */
  close(): Promise<void>;
}

/**
 * How to reach one port inside a box. It may hold a secret, such as a
 * single-use console ticket: never log it or send it to the browser.
 */
export type Route =
  | { readonly type: "tcp"; readonly host: string; readonly port: number }
  /** A command whose stdin and stdout carry the bytes, for example `ssh -W 127.0.0.1:5900 host`. */
  | { readonly type: "command"; readonly argv: readonly [string, ...string[]] }
  | {
      readonly type: "websocket";
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
      /** SHA-256 of a self-signed certificate to pin, in hex with or without colons. */
      readonly fingerprint?: string;
    };

/** What the stream server in the box expects. The relay answers it; the browser never sees it. */
export type DisplayAuth = { readonly type: "none" } | { readonly type: "vnc-password"; readonly password: string };

export interface Display {
  readonly id: string;
  readonly label: string;
  readonly protocol: DisplayProtocol;
  readonly resizable: boolean;
  /** Called once per viewer connection, because tickets can be single use. */
  open(signal?: AbortSignal): Promise<{ readonly route: Route; readonly auth: DisplayAuth }>;
}

/** How to reach a box over SSH, for bb-box and for the thread's own machine. */
export interface SshAccess {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  /** known_hosts lines. Pinned for a real machine; empty for a fresh virtual guest, whose first key is accepted. */
  readonly hostKeys: readonly string[];
  /** A host to go through, such as a bastion or the Mac that runs a VM. */
  readonly jump?: SshAccess;
}

export interface RunOptions {
  readonly stdin?: string | Uint8Array;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Output kept per stream. Beyond it, the head and tail are kept. */
  readonly maxOutputBytes?: number;
}

export interface RunResult {
  /** Null when the command was killed. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
}

export interface StreamOptions {
  readonly stdin?: string | Uint8Array;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** A transport that cannot stream calls it once per stream when the command exits. */
  onOutput(chunk: Uint8Array, from: "stdout" | "stderr"): void;
}

/**
 * Runs commands in a box and moves files in and out. `script` is in the
 * shell of the box's OS: POSIX sh on Linux and macOS, PowerShell on Windows.
 * The core writes scripts once per OS; see src/core/in-box.ts.
 */
export interface CommandTransport {
  /** True when the box answers. Quick: used to poll readiness. */
  probe(signal?: AbortSignal): Promise<boolean>;
  run(script: string, options?: RunOptions): Promise<RunResult>;
  stream(script: string, options: StreamOptions): Promise<{ exitCode: number | null; timedOut: boolean }>;
  /** Writes a file, creating parent directories. A relative path is under the box user's home. */
  writeFile(path: string, data: Uint8Array, options?: { mode?: string; signal?: AbortSignal }): Promise<void>;
  readFile(path: string, options: { maxBytes: number; signal?: AbortSignal }): Promise<Uint8Array>;
  /** A route to a TCP port inside the box, for a display served there. */
  route?(port: number, signal?: AbortSignal): Promise<Route>;
}

export type TransportErrorCode =
  /** The box did not answer. It may be stopped or still booting. */
  | "unreachable"
  /** The transport cannot do this for the box's OS. */
  | "unsupported";

export class TransportError extends Error {
  readonly code: TransportErrorCode;
  constructor(code: TransportErrorCode, message: string) {
    super(message);
    this.name = "TransportError";
    this.code = code;
  }
}
