// A box's terminal for people: a WebSocket route,
// /terminal?box=<id>&session=<id>&cols=<n>&rows=<n>, over a shell whose PTY
// is on BB's server (src/transports/terminal.ts). The plugin owns the
// session, not the socket: a panel tab remounts when a person switches
// tabs, so its socket comes and goes while the shell stays. A socket that
// names a live session attaches to it, gets the last 256 KiB of output and
// resizes the PTY to its own size, so full-screen programs redraw. A newer
// socket replaces an older one. A session with no socket ends after ten
// minutes; one also ends when its shell exits, when its box stops or goes,
// and when the plugin stops. A tab then shows why, and offers a new shell.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Boxes } from "../core/boxes.ts";
import { clampSize } from "../transports/terminal.ts";
import type { Terminal, TerminalSize } from "../transports/types.ts";
import { TERMINAL_ROUTE, terminalPath } from "./contract.ts";

export { TERMINAL_ROUTE };
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** A WebSocket close reason holds at most 123 bytes of UTF-8; the server refuses a longer one. */
const REASON_BYTES = 123;
const BACKLOG_BYTES = 256 * 1024;
const IDLE_MS = 10 * 60_000;

/** The tab that shows a session, as the session sees it. */
export interface TerminalViewer {
  send(bytes: Uint8Array): void;
  close(code: number, reason: string): void;
}

export interface TerminalSessionsDeps {
  /** Opens a shell in the box at `size`. Rejects, in words for the tab, when the box has none. */
  open(boxId: string, size: TerminalSize): Promise<Terminal>;
  logError(operation: string, error: unknown): void;
  /** A line for the plugin's log when a shell opens or ends. */
  log?(message: string): void;
  readonly idleMs?: number;
}

function words(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const utf8 = new TextEncoder();

/** `text` within a close reason's 123 bytes, cut at a character and ended with an ellipsis when it is longer. */
export function closeReason(text: string): string {
  if (utf8.encode(text).byteLength <= REASON_BYTES) return text;
  const room = REASON_BYTES - utf8.encode("…").byteLength;
  let kept = "";
  for (const character of text) {
    if (utf8.encode(kept + character).byteLength > room) break;
    kept += character;
  }
  return `${kept.trimEnd()}…`;
}

/** The last `limit` bytes of output, for a tab that attaches later. */
class Backlog {
  readonly #limit: number;
  #chunks: Uint8Array[] = [];
  #bytes = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  push(chunk: Uint8Array): void {
    this.#chunks.push(chunk);
    this.#bytes += chunk.byteLength;
    while (this.#bytes > this.#limit && this.#chunks.length > 1) {
      this.#bytes -= this.#chunks.shift()!.byteLength;
    }
    if (this.#bytes > this.#limit && this.#chunks.length === 1) {
      const only = this.#chunks[0]!;
      this.#chunks = [only.subarray(only.byteLength - this.#limit)];
      this.#bytes = this.#limit;
    }
  }

  all(): readonly Uint8Array[] {
    return this.#chunks;
  }
}

/** One shell in a box, and the tab showing it when there is one. */
export class TerminalSession {
  readonly boxId: string;
  readonly id: string;
  readonly #terminal: Terminal;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #backlog = new Backlog(BACKLOG_BYTES);
  readonly #idleMs: number;
  readonly #logError: (operation: string, error: unknown) => void;
  readonly #log: (message: string) => void;
  readonly #onEnd: (session: TerminalSession) => void;
  #viewer: TerminalViewer | null = null;
  #idle: ReturnType<typeof setTimeout> | null = null;
  #writes: Promise<void> = Promise.resolve();
  #ended = false;

  constructor(boxId: string, id: string, terminal: Terminal, options: { idleMs: number; logError: (operation: string, error: unknown) => void; log?: (message: string) => void; onEnd: (session: TerminalSession) => void }) {
    this.boxId = boxId;
    this.id = id;
    this.#terminal = terminal;
    this.#writer = terminal.writable.getWriter();
    this.#idleMs = options.idleMs;
    this.#logError = options.logError;
    this.#log = options.log ?? (() => {});
    this.#onEnd = options.onEnd;
    void this.#pump();
    this.#rest();
  }

  get ended(): boolean {
    return this.#ended;
  }

  async #pump(): Promise<void> {
    const reader = this.#terminal.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.#backlog.push(value);
        this.#viewer?.send(value);
      }
      await this.end("The shell exited.");
    } catch (error) {
      await this.end(`The terminal ended: ${words(error)}`);
    }
  }

  /** Shows the session in `viewer`, in place of any other tab, with what the shell printed so far. */
  attach(viewer: TerminalViewer, size: TerminalSize): void {
    if (this.#ended) {
      viewer.close(1000, "The terminal has ended.");
      return;
    }
    const before = this.#viewer;
    this.#viewer = viewer;
    before?.close(1000, "Another tab took this terminal.");
    this.#clearIdle();
    for (const chunk of this.#backlog.all()) viewer.send(chunk);
    this.resize(size);
  }

  /** The tab went away. The shell stays for a while, in case it comes back. */
  detach(viewer: TerminalViewer): void {
    if (this.#viewer !== viewer) return;
    this.#viewer = null;
    this.#rest();
  }

  #rest(): void {
    this.#clearIdle();
    const minutes = Math.max(1, Math.round(this.#idleMs / 60_000));
    this.#idle = setTimeout(() => void this.end(`No tab showed the terminal for ${minutes} ${minutes === 1 ? "minute" : "minutes"}, so it ended.`), this.#idleMs);
  }

  #clearIdle(): void {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = null;
  }

  input(bytes: Uint8Array): void {
    if (this.#ended) return;
    this.#writes = this.#writes.then(() => this.#writer.write(bytes)).catch((error) => this.#logError("write to the terminal", error));
  }

  resize(size: TerminalSize): void {
    if (this.#ended) return;
    // One that fails once the session has ended failed because its PTY went with the shell (#564).
    this.#terminal.resize(clampSize(size)).catch((error) => {
      if (!this.#ended) this.#logError("resize the terminal", error);
    });
  }

  /** Ends the shell, whatever else fails: the tab is told when it can be, and the shell is killed either way. */
  async end(reason: string): Promise<void> {
    if (this.#ended) return;
    this.#ended = true;
    this.#clearIdle();
    const viewer = this.#viewer;
    this.#viewer = null;
    this.#log(`Ended terminal ${this.id} on box ${this.boxId}: ${reason}`);
    try {
      this.#onEnd(this);
      viewer?.close(1000, reason);
    } catch (error) {
      this.#logError("tell the terminal's tab", error);
    }
    try {
      await this.#terminal.close();
    } catch (error) {
      this.#logError("close the terminal", error);
    }
  }
}

/** The sessions the plugin holds, by box and session ID. */
export class TerminalSessions {
  readonly #deps: TerminalSessionsDeps;
  readonly #sessions = new Map<string, TerminalSession>();
  readonly #opening = new Map<string, Promise<TerminalSession>>();

  constructor(deps: TerminalSessionsDeps) {
    this.#deps = deps;
  }

  /** The session `viewer` names, opened when it is new, with the viewer attached. */
  async attach(boxId: string, sessionId: string, viewer: TerminalViewer, size: TerminalSize): Promise<TerminalSession> {
    const key = `${boxId}/${sessionId}`;
    let session = this.#sessions.get(key);
    if (!session) {
      let opening = this.#opening.get(key);
      if (!opening) {
        opening = this.#open(boxId, sessionId, key, size).finally(() => this.#opening.delete(key));
        this.#opening.set(key, opening);
      }
      session = await opening;
    }
    session.attach(viewer, size);
    return session;
  }

  async #open(boxId: string, sessionId: string, key: string, size: TerminalSize): Promise<TerminalSession> {
    const terminal = await this.#deps.open(boxId, clampSize(size));
    const session = new TerminalSession(boxId, sessionId, terminal, {
      idleMs: this.#deps.idleMs ?? IDLE_MS,
      logError: this.#deps.logError,
      log: this.#deps.log,
      onEnd: (ended) => {
        if (this.#sessions.get(key) === ended) this.#sessions.delete(key);
      },
    });
    this.#sessions.set(key, session);
    this.#deps.log?.(`Opened terminal ${sessionId} on box ${boxId}`);
    return session;
  }

  /** Ends every session on a box, telling its tab why. */
  async end(boxId: string, reason: string): Promise<void> {
    await Promise.all([...this.#sessions.values()].filter((session) => session.boxId === boxId).map((session) => session.end(reason)));
  }

  get size(): number {
    return this.#sessions.size;
  }

  openOn(boxId: string): number {
    return [...this.#sessions.values()].filter((session) => session.boxId === boxId).length;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((session) => session.end("bb-box stopped.")));
  }
}

export interface Terminals {
  /** Where the panel opens a terminal's WebSocket, on the BB server's origin. */
  readonly path: string;
  /** Sessions open now. */
  readonly live: number;
  openOn(boxId: string): number;
  /** Ends every session on a box, telling its tab why. */
  end(boxId: string, reason: string): Promise<void>;
  dispose(): Promise<void>;
}

/** A resize the tab sends as a text frame. */
function control(data: string): TerminalSize | null {
  try {
    const parsed = JSON.parse(data) as { type?: unknown; cols?: unknown; rows?: unknown };
    if (parsed?.type === "resize" && typeof parsed.cols === "number" && typeof parsed.rows === "number") return { cols: parsed.cols, rows: parsed.rows };
  } catch {
    // Not control; ignored.
  }
  return null;
}

export function registerTerminals(bb: BbPluginApi, deps: { boxes: Boxes; logError(operation: string, error: unknown): void; idleMs?: number }): Terminals {
  const sessions = new TerminalSessions({
    idleMs: deps.idleMs,
    logError: deps.logError,
    log: (message) => bb.log.info(message),
    async open(boxId, size) {
      const box = await deps.boxes.find(boxId);
      if (!box) throw new Error("bb-box has no such box. It may have been released.");
      if (box.state !== "ready") throw new Error(`Box ${box.name} is not running, so it has no terminal.`);
      const { command } = await deps.boxes.transports(box);
      if (!command?.terminal) throw new Error(`Box ${box.name} has no terminal: its transport cannot open a shell on a PTY.`);
      return command.terminal(size);
    },
  });

  bb.http.experimental_websocket(
    TERMINAL_ROUTE,
    ({ url }) => {
      const boxId = url.searchParams.get("box") ?? "";
      const sessionId = url.searchParams.get("session") ?? "";
      const size = clampSize({ cols: Number(url.searchParams.get("cols")), rows: Number(url.searchParams.get("rows")) });
      let session: TerminalSession | null = null;
      let viewer: TerminalViewer | null = null;
      /** The socket closed, perhaps while its shell was still opening. */
      let closed = false;
      /** Bytes typed before the shell was open. */
      const early: Uint8Array[] = [];
      return {
        async onOpen(socket) {
          viewer = {
            send: (bytes) => socket.send(bytes),
            close: (code, reason) => {
              // The whole reason goes to the log; the socket takes what fits.
              const short = closeReason(reason);
              if (short !== reason) deps.logError("close the terminal", new Error(reason));
              socket.close(code, short);
            },
          };
          if (!SESSION_ID.test(sessionId)) {
            viewer.close(1008, "The tab gave no session ID, so its terminal cannot be kept.");
            return;
          }
          try {
            session = await sessions.attach(boxId, sessionId, viewer, size);
          } catch (error) {
            viewer.close(1011, words(error));
            return;
          }
          // A tab that went while the shell opened leaves it to rest, not to a dead socket.
          if (closed) {
            session.detach(viewer);
            return;
          }
          for (const bytes of early.splice(0)) session.input(bytes);
        },
        onMessage(_socket, data) {
          if (typeof data === "string") {
            const size = control(data);
            if (size) session?.resize(size);
            return;
          }
          if (session) session.input(data);
          else early.push(data);
        },
        onClose() {
          closed = true;
          if (session && viewer) session.detach(viewer);
        },
        onError(_socket, error) {
          deps.logError("terminal", error);
        },
      };
    },
    { auth: "local" },
  );

  return {
    path: terminalPath(bb.pluginId),
    get live() {
      return sessions.size;
    },
    openOn: (boxId) => sessions.openOn(boxId),
    end: (boxId, reason) => sessions.end(boxId, reason),
    dispose: () => sessions.dispose(),
  };
}
