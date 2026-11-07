// Transports reach inside a box. Backends compose them: a backend says which
// transports reach each of its boxes, and bb-box's core uses them without
// knowing which provider made the box. Commands and file copies go through a
// CommandTransport (SSH now; docker exec or a guest agent later). A desktop
// is a Display, whose route leads to a stream server inside the box. Routes
// are plain data, opened only by openRoute in route.ts.

export type GuestOs = "linux" | "windows" | "macos";
export type Arch = "x86_64" | "arm64";
/** The desktop viewer picks its client by protocol: noVNC for "rfb", and for "selkies" the relay carries Selkies' WebSocket (056); for "voxl" it translates voxl's into the same video client's (072). */
export type DisplayProtocol = "rfb" | "selkies" | "voxl";

/** A two-way byte stream with backpressure. */
export interface ByteChannel {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  /** Closes both directions and frees what the route holds, such as a process. */
  close(): Promise<void>;
}

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

/** A shell in a box on a PTY, for a person's terminal. */
export interface Terminal extends ByteChannel {
  /** Sets the PTY's size; the shell gets SIGWINCH. The latest wins. */
  resize(size: TerminalSize): Promise<void>;
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
      /** Subprotocols to ask for, such as "binary". */
      readonly protocols?: readonly string[];
      /** SHA-256 of a self-signed certificate to pin, in hex with or without colons. */
      readonly fingerprint?: string;
      /** PEM certificates to trust instead of the system roots, when there is no fingerprint. */
      readonly ca?: string;
    };

/**
 * What the stream server in the box expects. The relay answers it; the
 * browser never sees it. `apple` is macOS Screen Sharing's sign-in (RFB
 * security type 30), which shows the screen of the user it signs in as (047).
 */
export type DisplayAuth =
  | { readonly type: "none" }
  | { readonly type: "vnc-password"; readonly password: string }
  | { readonly type: "apple"; readonly user: string; readonly password: string };

export interface DisplaySize {
  readonly width: number;
  readonly height: number;
}

/**
 * A display's input, for a stream server that ignores a viewer's keys and
 * pointer, as macOS Screen Sharing ignores a viewer that is not Apple's
 * (#406). Positions are in the framebuffer's pixels.
 */
export interface DisplayInput {
  /** Resolves once sent; false when the box has no key that types the keysym. */
  key(down: boolean, keysym: number): Promise<boolean>;
  /** A key as the character it types, whatever key would; for a display whose stream server drops it (typesAsCharacter). */
  character?(down: boolean, keysym: number): Promise<void>;
  /** RFB's PointerEvent: a button mask and a position. */
  pointer(mask: number, x: number, y: number): Promise<void>;
  /** The viewer's clipboard text, for the box's. */
  clipboard(text: string): Promise<void>;
  /** The framebuffer's size, which positions are in. */
  size(width: number, height: number): Promise<void>;
  /** Resolves once every event sent before it has reached the box, to time the path. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface DisplayInputEvents {
  /** The box's clipboard text, when it changes there. */
  onClipboard?(text: string): void;
}

/** What a display's open() gives: the stream, its sign-in, and its input when the stream server ignores a viewer's. */
export interface DisplayOpened {
  readonly route: Route;
  readonly auth: DisplayAuth;
  /** Opens the display's input for one viewer; core sends that viewer's input there instead of to the stream server. */
  readonly input?: (events: DisplayInputEvents, signal?: AbortSignal) => Promise<DisplayInput>;
  /**
   * What of the viewer's input goes to `input`: all of it (the default);
   * only the wheel, RFB's buttons 4 to 7, for a stream server that takes
   * keys and clicks but drops the wheel, as Tart's macOS VMs' does; or only
   * keys typesAsCharacter picks, as on Windows over QEMU's VNC server. The
   * rest goes to the stream server, as without `input`.
   */
  readonly inputTakes?: "all" | "wheel" | "characters";
  /**
   * With inputTakes "wheel" or "characters": whether a key goes to `input`
   * as its character instead of to the stream server, which would type it
   * wrong or not at all, given the keysyms the viewer holds down and, for a
   * QEMU key event, the key's scancode (XT, as QEMU takes it).
   */
  readonly typesAsCharacter?: (keysym: number, held: ReadonlySet<number>, scancode?: number) => boolean;
  /**
   * How long the stream server spaces the key events it takes, which a
   * character sent to `input` waits out: QEMU's VNC server types each key
   * event 10 ms after the one before (its key-delay-ms), so a burst queues.
   */
  readonly keyDelayMs?: number;
}

/** A change of the box's pointer, from bb-box-cursor (060). */
export type BoxPointer =
  | { readonly type: "enter" }
  /** The pointer left the output, as when the seat's last pointer went. */
  | { readonly type: "leave" }
  /** Where its hotspot is, in the desktop's pixels. */
  | { readonly type: "position"; readonly x: number; readonly y: number }
  /** A new image: width*height pixels of 32-bit ARGB, little-endian, and its hotspot. */
  | { readonly type: "image"; readonly width: number; readonly height: number; readonly hotX: number; readonly hotY: number; readonly argb: Uint8Array }
  /** A new image as Selkies' own cursor message, as bb-box-stream.exe sends it (#865). */
  | { readonly type: "shape"; readonly message: string };

export interface Display {
  readonly id: string;
  readonly label: string;
  readonly protocol: DisplayProtocol;
  readonly resizable: boolean;
  /**
   * How a video display leaves the box's pointer out while a person holds
   * control, as DisplayCapability's cursor says: here for this box, as its
   * image can, where the kind's says what its images can at best.
   */
  readonly cursor?: "stream" | "selkies";
  readonly opensFirst?: boolean;
  /** Called once per viewer connection, because tickets can be single use. */
  open(signal?: AbortSignal): Promise<DisplayOpened>;
  /**
   * For a video display whose video comes from elsewhere than the box's own
   * stream server, as a Windows VM's from QEMU on its Mac (#865): opens the
   * box's stream server, which takes the keys and sends the clipboard and
   * the pointer's shape, while `open` gives each viewer its video and takes
   * its pointer.
   */
  openInput?(signal?: AbortSignal): Promise<DisplayOpened>;
  /**
   * Sets the display's size the backend's own way, for a stream server that
   * may not act on a viewer's SetDesktopSize (021). A display with it is
   * resizable. Core sends the box a SetDesktopSize for the size first, so it
   * may do nothing when the stream server took that, and setting a size the
   * display already has must succeed. Rejects with the box's reason when the
   * box refuses the size.
   */
  resize?(size: DisplaySize, signal?: AbortSignal): Promise<void>;
  /**
   * Starts the display's server again, for one that stopped answering a
   * viewer's sign-in: wayvnc 0.7.2 can freeze there (#411). A sign-in that
   * hangs for a few seconds has it called once, then tries again.
   */
  restartServer?(signal?: AbortSignal): Promise<void>;
  /**
   * Whether the display's server still has the desktop, for one that can
   * lose it and stay up, sending no picture or a placeholder: wayvnc after
   * it lost Sway. False when it has lost it, true when it has it or cannot
   * tell. Only with restartServer, which brings a server that has it.
   */
  serverAttached?(signal?: AbortSignal): Promise<boolean>;
  /**
   * Puts the box's own pointer in the display's picture, or takes it out,
   * for a server that cannot leave it out itself: Sway's headless output
   * paints it into every frame wayvnc sends (#707). Out while a person
   * holds control, whose browser draws its own; in otherwise.
   */
  pointer?(shown: boolean, signal?: AbortSignal): Promise<void>;
  /**
   * "rfb" when `pointer` takes the pointer out only while the person in
   * control watches this display, not the video, which leaves it out
   * itself and shows its shape on the person's own pointer: Windows, whose
   * pointer comes out as blank ones, which the video would show too.
   */
  readonly pointerWhile?: "rfb";
  /**
   * Follows the box's pointer, where its image has bb-box-cursor (060):
   * where it is and what it looks like, as it changes, until `signal` ends it
   * or the helper does. Neither of a Wayland desktop's streams sends either.
   */
  followPointer?(onEvent: (event: BoxPointer) => void, signal: AbortSignal): Promise<void>;
  /**
   * The smallest size a viewer may set. Core raises a smaller SetDesktopSize
   * to it, and the viewer scales the desktop down to fit its pane. Xvnc sets
   * the raised size and says so, and noVNC asks again while that differs
   * from its pane, so core sends a raised size asked for again with no
   * screens. Xvnc refuses that, and QEMU reads only the size.
   */
  readonly minSize?: DisplaySize;
}

/** The smallest size a viewer sets a Linux or Windows desktop to: their apps are hard to use below it. */
export const MIN_DESKTOP: DisplaySize = { width: 800, height: 600 };

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
export interface FileSize {
  readonly bytes: number;
  readonly sha256: string;
}

export interface CommandTransport {
  /** True when the box answers. Quick: used to poll readiness. */
  probe(signal?: AbortSignal): Promise<boolean>;
  run(script: string, options?: RunOptions): Promise<RunResult>;
  stream(script: string, options: StreamOptions): Promise<{ exitCode: number | null; timedOut: boolean }>;
  /** Writes a file, creating parent directories. A relative path is under the box user's home. Windows boxes ignore `mode`. */
  writeFile(path: string, data: Uint8Array, options?: { mode?: string; signal?: AbortSignal }): Promise<void>;
  readFile(path: string, options: { maxBytes: number; signal?: AbortSignal }): Promise<Uint8Array>;
  writeFileSummed?(path: string, data: Uint8Array, options?: { signal?: AbortSignal }): Promise<FileSize | null>;
  readFileSummed?(path: string, options: { maxBytes: number; signal?: AbortSignal }): Promise<{ readonly data: Uint8Array; readonly sum: FileSize } | null>;
  /** A route to a TCP port inside the box, for a display served there. */
  route?(port: number, signal?: AbortSignal): Promise<Route>;
  /**
   * Starts a long-running command whose stdin and stdout are the channel,
   * such as the computer-use driver's MCP server. Closing the channel ends it.
   */
  spawn?(script: string, signal?: AbortSignal): Promise<ByteChannel>;
  /**
   * The box user's login shell on a PTY, for a person's terminal. The PTY is
   * on BB's server, so nothing runs in the box (src/transports/terminal.ts).
   * Closing it hangs the shell up.
   */
  terminal?(size: TerminalSize, signal?: AbortSignal): Promise<Terminal>;
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
