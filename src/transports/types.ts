// Transports reach inside a box. Backends compose them: a backend says which
// transports reach each of its boxes, and bb-box's core uses them without
// knowing which provider made the box. Commands and file copies go through a
// CommandTransport (SSH now; docker exec, WinRM or an in-box agent later). A
// desktop is streamed from a DisplayEndpoint (VNC now; RDP or WebRTC later).

export type GuestOs = "linux" | "windows" | "macos";
/** Names a command transport for people, for example "ssh" or "docker". The core never branches on it. */
export type CommandTransportKind = string;
/** The desktop viewer picks its stream module by protocol. */
export type DisplayProtocol = "vnc" | "rdp" | "webrtc";

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
  onOutput(chunk: string): void;
}

/**
 * Runs commands in a box and moves files in and out. `script` is in the
 * shell of the box's OS: POSIX sh on Linux and macOS, PowerShell on Windows.
 * The core writes scripts once per OS; see src/core/in-box.ts.
 */
export interface CommandTransport {
  readonly kind: CommandTransportKind;
  /** True when the box answers. Quick: used to poll readiness. */
  probe(signal?: AbortSignal): Promise<boolean>;
  run(script: string, options?: RunOptions): Promise<RunResult>;
  stream(script: string, options: StreamOptions): Promise<{ exitCode: number | null; timedOut: boolean }>;
  /** Writes a file, creating parent directories. A relative path is under the box user's home. */
  writeFile(path: string, data: Uint8Array, options?: { mode?: string; signal?: AbortSignal }): Promise<void>;
  readFile(path: string, options: { maxBytes: number; signal?: AbortSignal }): Promise<Uint8Array>;
}

/** Where a desktop stream connects. The stream module for the protocol turns it into a view in BB. */
export interface DisplayEndpoint {
  readonly protocol: DisplayProtocol;
  readonly host: string;
  readonly port: number;
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
