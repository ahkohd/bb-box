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
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Contract, DesktopState } from "../plugin/contract.ts";
import type { BoxView } from "../plugin/views.ts";
import { forThread, message, Notice, StatusDot, useLive, type Tone } from "./common.tsx";
import { XTERM_CSS } from "./xterm-css.ts";

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

/** The thread panel tab for one box's terminal. */
export function TerminalPanel({ threadId, params }: { threadId: string; params: unknown }) {
  const boxId = parseParams(params);
  if (!boxId) return <Notice>This tab names no box.</Notice>;
  return <BoxTerminal key={boxId} threadId={threadId} boxId={boxId} />;
}

function BoxTerminal({ threadId, boxId }: { threadId: string; boxId: string }) {
  const rpc = useRpc<Contract>();
  const pluginId = experimental_usePluginId();
  const { value: state, error, refresh } = useLive<DesktopState>(`${threadId}/${boxId}/terminal`, () => rpc.call("desktop", { threadId, box: boxId }), forThread(threadId));
  const box = state?.box ?? null;
  const path = state?.terminalPath ?? null;
  const can = box !== null && canOpenTerminal(box);
  const [session, renew] = useSessionId(boxId);

  const holder = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const [connection, setConnection] = useState<Connection>({ state: "connecting" });
  const [acting, setActing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // The terminal view lives as long as the tab; connections come and go in it.
  useEffect(() => {
    if (!holder.current) return;
    ensureStyles();
    const view = new Terminal({
      cursorBlink: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace",
      fontSize: 13,
      scrollback: 5000,
      allowProposedApi: true,
      theme: { background: tokenColor("--canvas", "#1a1a1a"), foreground: tokenColor("--foreground", "#d0d0d0"), cursor: tokenColor("--foreground", "#d0d0d0"), selectionBackground: tokenColor("--surface-selected", "#44546a") },
    });
    const fitter = new FitAddon();
    view.loadAddon(fitter);
    view.open(holder.current);
    terminal.current = view;
    fit.current = fitter;
    try {
      fitter.fit();
    } catch {
      // A hidden holder has no size yet; the observer fits it when it shows.
    }
    return () => {
      view.dispose();
      terminal.current = null;
      fit.current = null;
    };
  }, []);

  // One socket per session while the box runs. The plugin keeps the shell between sockets.
  useEffect(() => {
    const view = terminal.current;
    if (!can || !path || !view) return;
    try {
      fit.current?.fit();
    } catch {
      // Not shown yet; the size goes with the first resize.
    }
    view.reset();
    setProblem(null);
    setConnection({ state: "connecting" });
    const socket = new WebSocket(socketUrl(path, boxId, session, { cols: view.cols || 80, rows: view.rows || 24 }));
    socket.binaryType = "arraybuffer";
    socket.onopen = () => setConnection({ state: "connected" });
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") return;
      view.write(new Uint8Array(event.data as ArrayBuffer));
    };
    socket.onclose = (event: CloseEvent) => setConnection({ state: "ended", reason: event.reason || "The connection to the terminal closed." });
    socket.onerror = () => {
      // The close that follows says what happened.
    };
    const input = view.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
    });
    let last = { cols: view.cols, rows: view.rows };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resized = view.onResize(({ cols, rows }) => {
      if (cols === last.cols && rows === last.rows) return;
      last = { cols, rows };
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols, rows }));
      }, RESIZE_MS);
    });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            try {
              fit.current?.fit();
            } catch {
              // Not shown yet.
            }
          });
    if (observer && holder.current) observer.observe(holder.current);
    view.focus();
    return () => {
      clearTimeout(timer);
      input.dispose();
      resized.dispose();
      observer?.disconnect();
      socket.onclose = null;
      socket.close();
    };
  }, [can, path, boxId, session]);

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
  const showing = can && connection.state !== "ended";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface-recessed px-3 py-2 text-xs">
        <Icon name={`${pluginId}/terminal`} className="size-4 shrink-0 text-muted-foreground" aria-hidden />
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
