// A terminal in a box, in a thread panel tab of its own: xterm over the
// plugin's WebSocket, /terminal, to a shell whose PTY is on BB's server
// (src/plugin/terminal.ts). The plugin keeps the shell while the tab is
// away, so this tab keeps a session ID for the browser tab, as the desktop
// keeps its viewer ID: switching panel tabs attaches to the same shell. When
// the shell ends, the tab says why and offers a new one; it never starts one
// on its own.

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { experimental_Icon as Icon, experimental_usePluginId, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Contract, DesktopState } from "../plugin/contract.ts";
import type { BoxView } from "../plugin/views.ts";
import { forThread, IconButton, message, Notice, StatusDot, useLive, type Tone } from "./common.tsx";
import { claimKept, dropKept, keptFree, releaseKept, type Kept } from "./kept.ts";
import { XTERM_CSS } from "./xterm-css.ts";
import { TerminalGlyph } from "./glyphs.tsx";

export const TERMINAL_ACTION = "terminal";

/** A resize goes to the shell once the size has settled for this long. */
const RESIZE_MS = 100;

/** The params of a box's terminal tab. */
export function terminalParams(boxId: string): { box: string } {
  return { box: boxId };
}

/** Opens a box's terminal tab in the thread's panel. */
export function useOpenTerminal(): (box: BoxView) => void {
  const navigate = useBbNavigate();
  return (box) => {
    navigate.openThreadPanel({ actionId: TERMINAL_ACTION, title: `Terminal: ${box.name}`, params: terminalParams(box.id) });
  };
}

/** A box has a terminal while it runs, when its transport opens a shell. */
export function canOpenTerminal(box: BoxView): boolean {
  return box.state === "ready" && box.terminal;
}

function parseParams(params: unknown): string | null {
  const box = (params as { box?: unknown } | null)?.box;
  return typeof box === "string" && box.length > 0 ? box : null;
}

function socketUrl(path: string, boxId: string, session: string, size: { cols: number; rows: number }): string {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = new URLSearchParams({ box: boxId, session, cols: String(size.cols), rows: String(size.rows) }).toString();
  return url.toString();
}

const encoder = new TextEncoder();

/** xterm's stylesheet, in the page once. */
function ensureStyles(): void {
  const id = "bb-box-xterm-css";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = XTERM_CSS;
  document.head.appendChild(style);
}

/** A BB theme token as a colour xterm takes: the browser resolves the token, a canvas reads it back. */
function tokenColor(token: string, fallback: string): string {
  try {
    const probe = document.createElement("span");
    probe.style.color = `var(${token})`;
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    if (!context || !resolved) return fallback;
    context.fillStyle = resolved;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((part) => part!.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return fallback;
  }
}

const mounted = new Set<string>();

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function storedSession(boxId: string): string | null {
  try {
    return window.sessionStorage.getItem(`bb-box:terminal:${boxId}`);
  } catch {
    return null;
  }
}

function storeSession(boxId: string, id: string): void {
  try {
    window.sessionStorage.setItem(`bb-box:terminal:${boxId}`, id);
  } catch {
    // Storage may be off. Then a remount gets a new shell.
  }
}

/**
 * This tab's session ID for a box. It lasts for the browser tab, so a panel
 * tab that remounts attaches to the same shell. Two tabs on one box mounted
 * at once never share one.
 */
function useSessionId(boxId: string): [string, () => void] {
  const [session, setSession] = useState(() => {
    const stored = storedSession(boxId);
    const id = stored && !mounted.has(stored) ? stored : randomId();
    storeSession(boxId, id);
    return id;
  });
  useEffect(() => {
    mounted.add(session);
    return () => {
      mounted.delete(session);
    };
  }, [session]);
  const renew = () => {
    const id = randomId();
    storeSession(boxId, id);
    setSession(id);
  };
  return [session, renew];
}

type Connection = { readonly state: "connecting" } | { readonly state: "connected" } | { readonly state: "ended"; readonly reason: string };

/**
 * One shell's terminal: xterm and the socket to the plugin, in an element of
 * its own that a tab puts inside its screen area. It is kept across tab
 * switches (037): the element leaves the page and comes back with the shell
 * still in it, so switching back is instant.
 */
export class TerminalClient implements Kept {
  readonly element = document.createElement("div");
  hidden = false;
  onEnded?: () => void;
  connection: Connection = { state: "connecting" };
  readonly #view: Terminal;
  readonly #fit = new FitAddon();
  readonly #url: (size: { cols: number; rows: number }) => string;
  readonly #listeners = new Set<() => void>();
  readonly #observer: ResizeObserver | null;
  #socket: WebSocket | null = null;
  #started = false;
  #disposed = false;
  #resizeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(url: (size: { cols: number; rows: number }) => string) {
    this.#url = url;
    this.element.className = "h-full w-full";
    ensureStyles();
    this.#view = new Terminal({
      cursorBlink: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace",
      fontSize: 13,
      scrollback: 5000,
      allowProposedApi: true,
      theme: { background: tokenColor("--canvas", "#1a1a1a"), foreground: tokenColor("--foreground", "#d0d0d0"), cursor: tokenColor("--foreground", "#d0d0d0"), selectionBackground: tokenColor("--surface-selected", "#44546a") },
    });
    this.#view.loadAddon(this.#fit);
    this.#view.open(this.element);
    this.#view.onData((data) => {
      if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(encoder.encode(data));
    });
    let last = { cols: this.#view.cols, rows: this.#view.rows };
    this.#view.onResize(({ cols, rows }) => {
      if (cols === last.cols && rows === last.rows) return;
      last = { cols, rows };
      clearTimeout(this.#resizeTimer);
      this.#resizeTimer = setTimeout(() => {
        if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify({ type: "resize", cols, rows }));
      }, RESIZE_MS);
    });
    this.#observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.fit());
    this.#observer?.observe(this.element);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(connection: Connection): void {
    this.connection = connection;
    for (const listener of this.#listeners) listener();
  }

  fit(): void {
    try {
      this.#fit.fit();
    } catch {
      // Not in the page yet; the observer fits it when it shows.
    }
  }

  focus(): void {
    this.#view.focus();
  }

  /** Opens the socket, once the element is in the page so the size is right. A shell is started once; a new one takes a new client. */
  start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    this.fit();
    const socket = new WebSocket(this.#url({ cols: this.#view.cols || 80, rows: this.#view.rows || 24 }));
    socket.binaryType = "arraybuffer";
    socket.onopen = () => this.#set({ state: "connected" });
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") return;
      this.#view.write(new Uint8Array(event.data as ArrayBuffer));
    };
    socket.onclose = (event: CloseEvent) => {
      this.#socket = null;
      this.#set({ state: "ended", reason: event.reason || "The connection to the terminal closed." });
      if (this.hidden) this.onEnded?.();
    };
    socket.onerror = () => {
      // The close that follows says what happened.
    };
    this.#socket = socket;
    this.#set({ state: "connecting" });
  }

  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#resizeTimer);
    this.#observer?.disconnect();
    if (this.#socket) {
      this.#socket.onclose = null;
      this.#socket.close();
      this.#socket = null;
    }
    this.#view.dispose();
    this.#listeners.clear();
    this.element.remove();
  }
}

/** The thread panel tab for one box's terminal. */
export function TerminalPanel({ threadId, params }: { threadId: string; params: unknown }) {
  const boxId = parseParams(params);
  if (!boxId) return <Notice>This tab names no box.</Notice>;
  return <BoxTerminal key={boxId} threadId={threadId} boxId={boxId} />;
}

/** One box's terminal; `onBack` adds a back arrow, for the Desktops page. */
export function BoxTerminal({ threadId, boxId, onBack }: { threadId: string; boxId: string; onBack?: { label: string; go: () => void } }) {
  const rpc = useRpc<Contract>();
  const pluginId = experimental_usePluginId();
  const { value: state, error, refresh } = useLive<DesktopState>(`${threadId}/${boxId}/terminal`, () => rpc.call("desktop", { threadId, box: boxId }), forThread(threadId));
  const box = state?.box ?? null;
  const path = state?.terminalPath ?? null;
  const can = box !== null && canOpenTerminal(box);
  const [session, renewSession] = useSessionId(boxId);
  const key = `terminal:${boxId}:${session}`;

  const holder = useRef<HTMLDivElement>(null);
  // A kept terminal shows at once, before the box's state has loaded; the state can only confirm or end it.
  const [connection, setConnection] = useState<Connection>(() => keptFree<TerminalClient>(key)?.connection ?? { state: "connecting" });
  const [acting, setActing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ready = can && path !== null;
  const pathNow = useRef(path);
  pathNow.current = path;
  const wanted = ready || keptFree(key) !== undefined;

  // The shell's terminal is claimed on mount and given back on unmount; the registry keeps it meanwhile (037).
  // A layout effect, so a kept terminal is in the page before it paints.
  useLayoutEffect(() => {
    const screen = holder.current;
    if (!wanted || !screen) return;
    const latestPath = pathNow.current;
    if (keptFree(key) === undefined && !latestPath) return;
    const claimed = claimKept(key, () => new TerminalClient((size) => socketUrl(latestPath!, boxId, session, size)));
    const client = claimed.session;
    screen.appendChild(client.element);
    const unsubscribe = client.subscribe(() => setConnection(client.connection));
    setProblem(null);
    setConnection(client.connection);
    client.start();
    client.fit();
    client.focus();
    return () => {
      unsubscribe();
      client.element.remove();
      if (claimed.kept) releaseKept(key);
      else client.dispose();
    };
  }, [wanted, boxId, session, key]);

  // A box that stops or goes takes its shell with it.
  useEffect(() => {
    if (state && !can) dropKept(key);
  }, [state, can, key]);

  const renew = () => {
    dropKept(key);
    renewSession();
  };

  const start = async () => {
    setActing(true);
    try {
      setProblem((await rpc.call("start", { threadId, box: boxId })).error);
    } catch (caught) {
      setProblem(message(caught));
    } finally {
      setActing(false);
    }
    await refresh();
  };

  let tone: Tone = "busy";
  let words = "Loading…";
  if (error) {
    tone = "bad";
    words = "Could not load";
  } else if (box && box.state !== "ready") {
    tone = box.state === "stopped" ? "off" : box.state === "failed" || box.state === "gone" ? "bad" : "busy";
    words = box.state === "stopped" ? "Stopped" : box.state === "acquiring" || box.state === "starting" ? "Starting" : box.state;
  } else if (box && !box.terminal) {
    tone = "off";
    words = "No terminal";
  } else if (connection.state === "connected") {
    tone = "ok";
    words = "Connected";
  } else if (connection.state === "ended") {
    tone = "off";
    words = "Ended";
  } else {
    words = "Connecting…";
  }
  // Before the box's state has loaded, a kept terminal still shows.
  const showing = connection.state !== "ended" && (state === null || can);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface-recessed px-3 py-2 text-xs">
        {onBack ? <IconButton label={onBack.label} icon="ArrowLeft" onClick={onBack.go} className="-ml-1" /> : null}
        <TerminalGlyph className="text-muted-foreground" />
        <span className="font-medium text-foreground">{box?.name ?? "Terminal"}</span>
        <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <StatusDot tone={tone} />
          <span className="min-w-0">{words}</span>
        </span>
        {can && connection.state === "ended" ? (
          <Button type="button" variant="outline" size="sm" className="ml-auto h-7" onClick={renew}>
            Start a new shell
          </Button>
        ) : null}
      </div>
      {problem ? (
        <p role="alert" className="border-b border-border px-3 py-1.5 text-xs text-destructive-text">
          {problem}
        </p>
      ) : null}
      <div className="relative min-h-0 flex-1 bg-background">
        <div ref={holder} className={cn("absolute inset-0 p-2", !showing && "invisible")} data-testid="terminal-screen" />
        {error ? (
          <Notice>{error}</Notice>
        ) : !state ? null : !box ? (
          <Notice>This box has been released.</Notice>
        ) : box.state === "stopped" ? (
          <Notice
            action={
              box.canStopStart ? (
                <Button type="button" variant="outline" size="sm" className="h-7" disabled={acting} onClick={() => void start()}>
                  <Icon name="Play" aria-hidden />
                  Start
                </Button>
              ) : undefined
            }
          >
            {box.name} is stopped.
          </Notice>
        ) : box.state !== "ready" ? (
          <Notice>
            {box.name} is {box.state === "acquiring" || box.state === "starting" ? "starting…" : box.state === "failed" ? "failed." : box.state === "gone" ? "gone." : "being released."}
          </Notice>
        ) : !box.terminal ? (
          <Notice detail="Its backend reaches it without a shell.">{box.name} has no terminal.</Notice>
        ) : connection.state === "ended" ? (
          <Notice
            detail={connection.reason}
            action={
              <Button type="button" variant="outline" size="sm" className="h-7" onClick={renew}>
                Start a new shell
              </Button>
            }
          >
            The terminal has ended.
          </Notice>
        ) : null}
      </div>
    </div>
  );
}
