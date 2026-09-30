// The desktop viewer: noVNC over the plugin's relay (007), with the control
// bar for taking and handing back input (008). It shows in a thread panel
// tab of its own for each box, and on the Desktops page for a browser tab.

import RFB from "@novnc/novnc";
import { experimental_Icon as Icon, experimental_usePluginId, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState } from "react";
import type { Contract, DesktopEntry, DesktopState, PanelState } from "../plugin/contract.ts";
import type { BoxView } from "../plugin/views.ts";
import { BUTTON, message, useLive } from "./common.tsx";

export const DESKTOP_ACTION = "desktop";
export const DESKTOP_PAGE = "desktop";

/** The longest wait between attempts to reconnect to a desktop. */
const MAX_RETRY_MS = 15_000;

/** A change signal for this thread, or for every thread. */
function forThread(threadId: string) {
  return (payload: unknown) => {
    const changed = (payload as { threadId?: unknown } | null)?.threadId;
    return changed === null || changed === undefined || changed === threadId;
  };
}

/** Where the Desktops page shows one box, for a new browser tab. */
export function pageHref(pluginId: string, threadId: string, boxId: string): string {
  return `/plugins/${encodeURIComponent(pluginId)}/${DESKTOP_PAGE}/${encodeURIComponent(threadId)}/${encodeURIComponent(boxId)}`;
}

/** The params of a box's desktop tab. */
export function desktopParams(boxId: string): { box: string } {
  return { box: boxId };
}

function socketUrl(path: string, boxId: string, viewer: string): string {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = new URLSearchParams({ box: boxId, viewer }).toString();
  return url.toString();
}

const mounted = new Set<string>();

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * This viewer's ID for a box. It lasts for the browser tab, so a panel tab
 * that remounts keeps the control it took. Two viewers mounted at once never
 * share one.
 */
function useViewerId(boxId: string): string {
  const [viewer] = useState(() => {
    const key = `bb-box:viewer:${boxId}`;
    let stored: string | null = null;
    try {
      stored = window.sessionStorage.getItem(key);
    } catch {
      // Storage may be off. A new ID only means control is not kept across remounts.
    }
    const id = stored && !mounted.has(stored) ? stored : randomId();
    try {
      window.sessionStorage.setItem(key, id);
    } catch {
      // As above.
    }
    return id;
  });
  useEffect(() => {
    mounted.add(viewer);
    return () => {
      mounted.delete(viewer);
    };
  }, [viewer]);
  return viewer;
}

type Connection = { readonly state: "connecting" } | { readonly state: "connected" } | { readonly state: "disconnected"; readonly reason: string };

function controlText(box: BoxView, mine: boolean): string {
  switch (box.control?.owner) {
    case "human":
      return mine ? "You have control. Hand it back when you are done." : "Another viewer has control.";
    case "none":
      return "Control is changing hands.";
    default:
      return "The agent has control. You are watching.";
  }
}

/** A box's desktop, live, with its control bar. */
export function DesktopViewer({ threadId, boxId, newTab }: { threadId: string; boxId: string; newTab: boolean }) {
  const rpc = useRpc<Contract>();
  const pluginId = experimental_usePluginId();
  const viewer = useViewerId(boxId);
  const { value: state, error, refresh } = useLive<DesktopState>(
    `${threadId}/${boxId}`,
    () => rpc.call("desktop", { threadId, box: boxId }),
    forThread(threadId),
  );
  const box = state?.box ?? null;
  const path = state?.desktopPath ?? null;
  const showing = box !== null && box.state === "ready" && box.display !== null;
  const mine = box?.control?.owner === "human" && box.control.holder === viewer;
  const resizable = box?.display?.resizable ?? false;

  const target = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | null>(null);
  const [connection, setConnection] = useState<Connection>({ state: "connecting" });
  const [attempt, setAttempt] = useState(0);
  const failures = useRef(0);
  const [acting, setActing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!showing || !path || !target.current) return;
    const client = new RFB(target.current, socketUrl(path, boxId, viewer), { shared: true });
    client.scaleViewport = true;
    client.viewOnly = true;
    rfb.current = client;
    setConnection({ state: "connecting" });
    let refused: string | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const onConnect = () => {
      failures.current = 0;
      setConnection({ state: "connected" });
    };
    const onSecurityFailure = (event: Event) => {
      refused = (event as CustomEvent<{ reason?: string }>).detail.reason ?? "The relay refused the connection.";
    };
    const onDisconnect = () => {
      rfb.current = null;
      setConnection({ state: "disconnected", reason: refused ?? "The connection to the desktop ended." });
      const wait = Math.min(MAX_RETRY_MS, 1000 * 2 ** failures.current);
      failures.current += 1;
      retry = setTimeout(() => setAttempt((count) => count + 1), wait);
    };
    client.addEventListener("connect", onConnect);
    client.addEventListener("securityfailure", onSecurityFailure);
    client.addEventListener("disconnect", onDisconnect);
    return () => {
      clearTimeout(retry);
      client.removeEventListener("connect", onConnect);
      client.removeEventListener("securityfailure", onSecurityFailure);
      client.removeEventListener("disconnect", onDisconnect);
      rfb.current = null;
      client.disconnect();
    };
  }, [showing, path, boxId, viewer, attempt]);

  // Input and resizing follow control. The relay drops input from a viewer
  // without control anyway; this keeps noVNC from sending it.
  useEffect(() => {
    const client = rfb.current;
    if (!client || connection.state !== "connected") return;
    client.viewOnly = !mine;
    client.resizeSession = mine && resizable;
    if (mine) client.focus({ preventScroll: true });
  }, [mine, resizable, connection]);

  const act = async (task: () => Promise<{ error: string | null }>) => {
    setActing(true);
    try {
      setProblem((await task()).error);
    } catch (caught) {
      setProblem(message(caught));
    } finally {
      setActing(false);
    }
    await refresh();
  };
  const take = () => act(() => rpc.call("takeControl", { threadId, box: boxId, viewer }));
  const handBack = () => act(() => rpc.call("handBack", { threadId, box: boxId }));
  const reconnect = () => {
    failures.current = 0;
    setAttempt((count) => count + 1);
  };

  let notice: string | null = null;
  if (error) notice = error;
  else if (!state) notice = "Loading the desktop...";
  else if (!box) notice = "This thread has no such box. It may have been released.";
  else if (!box.display) notice = `Box ${box.name} has no desktop.`;
  else if (box.state !== "ready") notice = `The desktop shows when box ${box.name} is running.`;
  else if (connection.state === "connecting") notice = "Connecting to the desktop...";
  else if (connection.state === "disconnected") notice = `${connection.reason} Trying again...`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <Icon name="Monitor" className="size-4 text-muted-foreground" aria-hidden />
        <span className="font-medium text-foreground">{box?.name ?? "Desktop"}</span>
        {box && showing ? <span className="text-muted-foreground">{controlText(box, mine)}</span> : null}
        <span className="ml-auto flex flex-wrap gap-2">
          {showing && !mine ? (
            <button type="button" className={BUTTON} disabled={acting || connection.state !== "connected"} onClick={() => void take()}>
              Take control
            </button>
          ) : null}
          {showing && box?.control?.owner === "human" ? (
            <button type="button" className={BUTTON} disabled={acting} onClick={() => void handBack()}>
              Hand back to the agent
            </button>
          ) : null}
          {showing && connection.state === "disconnected" ? (
            <button type="button" className={BUTTON} onClick={reconnect}>
              Reconnect
            </button>
          ) : null}
          {newTab && box ? (
            <a className={BUTTON} href={pageHref(pluginId, threadId, box.id)} target="_blank" rel="noopener noreferrer">
              <Icon name="ExternalLink" className="size-3" aria-hidden />
              New browser tab
            </a>
          ) : null}
        </span>
      </div>
      {problem ? <p className="px-3 py-1 text-xs text-destructive">{problem}</p> : null}
      <div className="relative min-h-0 flex-1 bg-muted">
        <div ref={target} className="absolute inset-0" data-testid="desktop-screen" />
        {notice ? (
          <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-muted-foreground">
            <p>{notice}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function parseParams(params: unknown): string | null {
  const box = (params as { box?: unknown } | null)?.box;
  return typeof box === "string" && box.length > 0 ? box : null;
}

/** Opens a box's desktop tab in the thread's panel. There is one tab per box. */
export function useOpenDesktop(): (box: BoxView) => void {
  const navigate = useBbNavigate();
  return (box) => {
    navigate.openThreadPanel({ actionId: DESKTOP_ACTION, title: `Desktop: ${box.name}`, params: desktopParams(box.id) });
  };
}

/** The thread panel tab for one box's desktop. Opened bare, it lists the thread's desktops. */
export function DesktopPanel({ threadId, params }: { threadId: string; params: unknown }) {
  const boxId = parseParams(params);
  if (boxId) return <DesktopViewer key={boxId} threadId={threadId} boxId={boxId} newTab />;
  return <DesktopChooser threadId={threadId} />;
}

function DesktopChooser({ threadId }: { threadId: string }) {
  const rpc = useRpc<Contract>();
  const open = useOpenDesktop();
  const { value: state, error } = useLive<PanelState>(threadId, () => rpc.call("state", { threadId }), forThread(threadId));
  const desktops = state?.boxes.filter((box) => box.desktop) ?? [];
  return (
    <div className="space-y-3 p-3 text-sm">
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {state && !desktops.length ? <p className="text-muted-foreground">This thread has no desktop boxes. Make one in the Boxes panel.</p> : null}
      {desktops.map((box) => (
        <button key={box.id} type="button" className={BUTTON} onClick={() => open(box)}>
          <Icon name="Monitor" className="size-3" aria-hidden />
          {box.name}
        </button>
      ))}
    </div>
  );
}

/** The Desktops page: every desktop box, or one box's desktop at <threadId>/<boxId>. */
export function DesktopsPage({ subPath }: { subPath: string }) {
  const [threadId, boxId, ...rest] = subPath.split("/").map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return "";
    }
  });
  if (threadId && boxId && !rest.length) return <DesktopViewer key={`${threadId}/${boxId}`} threadId={threadId} boxId={boxId} newTab={false} />;
  return <DesktopList />;
}

function DesktopList() {
  const rpc = useRpc<Contract>();
  const navigate = useBbNavigate();
  const { value: desktops, error } = useLive<DesktopEntry[]>("desktops", () => rpc.call("desktops"), () => true);
  return (
    <div className="space-y-3 p-4 text-sm">
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {desktops && !desktops.length ? <p className="text-muted-foreground">No thread has a desktop box.</p> : null}
      {desktops?.map(({ threadId, box }) => (
        <div key={box.id} className="flex items-center gap-2">
          <button
            type="button"
            className={BUTTON}
            onClick={() => navigate.toPluginPanel(DESKTOP_PAGE, { subPath: `${encodeURIComponent(threadId)}/${encodeURIComponent(box.id)}` })}
          >
            <Icon name="Monitor" className="size-3" aria-hidden />
            {box.name}
          </button>
          <span className="text-xs text-muted-foreground">
            {box.kindLabel}, {box.state === "ready" ? "running" : box.state}
          </span>
          <button type="button" className={`${BUTTON} ml-auto`} onClick={() => navigate.toThread(threadId)}>
            Open its thread
          </button>
        </div>
      ))}
    </div>
  );
}
