// The desktop viewer: noVNC over the plugin's relay (007), with the control
// bar for taking and handing back input (008). It shows in a thread panel
// tab of its own for each box, and on the Boxes page for a browser tab.

import RFB from "@novnc/novnc";
import { experimental_Icon as Icon, experimental_usePluginId, useBbNavigate, useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { BoxResult, BoxEntry, Contract, DesktopState, PanelState } from "../plugin/contract.ts";
import type { BoxView } from "../plugin/views.ts";
import { BOXES_ACTION, EmptyPanel, forThread, IconButton, isArm64Badge, KindBadges, lacksDocker, message, Meta, Notice, osName, SETTINGS_PATH, StatusDot, type Tone, useLive, useNow } from "./common.tsx";
import { claimKept, dropKept, keptFree, releaseKept, type Kept } from "./kept.ts";
import { controlWord, statusOf } from "./status.ts";
import { BoxTerminal, canOpenTerminal } from "./terminal.tsx";
import { MonitorGlyph, ServerGlyph, TerminalGlyph } from "./glyphs.tsx";

export const DESKTOP_ACTION = "desktop";
export const DESKTOP_PAGE = "desktop";

/** The longest wait between attempts to reconnect to a desktop. */
const MAX_RETRY_MS = 15_000;
/** How long the viewer's size must hold before the desktop is asked for it again. */
export const SETTLE_MS = 250;

/**
 * noVNC measures its screen in fractional pixels and asks the box for the
 * floor; after the resize it finds the two unequal and asks for the same
 * floor again, so a pane of 851.5 px kept a one-pixel request outstanding,
 * and a maximise that met it waited for it (#353). Measured in whole
 * pixels, as the request is made, a size that holds is asked for once.
 */
class Viewer extends RFB {
  override _screenSize(): { w: number; h: number } {
    const size = super._screenSize();
    return { w: Math.floor(size.w), h: Math.floor(size.h) };
  }
}

/** Where the Boxes page shows one box, for a new browser tab. */
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

type Connection = { readonly state: "connecting" } | { readonly state: "connected" } | { readonly state: "disconnected"; readonly reason: string; readonly retryMs: number };

/**
 * One viewer's desktop: noVNC and its canvas, in an element of its own that
 * a tab puts inside its screen area. It is kept across tab switches (037):
 * the element leaves the page and comes back with the stream still on it,
 * so switching back is instant, with no handshake and no blank frame. While
 * hidden it does not reconnect; a lost connection ends it instead.
 */
export class DesktopSession implements Kept {
  readonly element = document.createElement("div");
  hidden = false;
  onEnded?: () => void;
  connection: Connection = { state: "connecting" };
  readonly #url: string;
  readonly #listeners = new Set<() => void>();
  #client: RFB | null = null;
  #failures = 0;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #refused: string | null = null;
  #mine = false;
  #resizable = false;
  #disposed = false;
  readonly #observer: ResizeObserver | null;
  #settle: ReturnType<typeof setTimeout> | undefined;
  /** The viewer's size as last observed, so the first observation, at mount, is not taken for a move. */
  #lastSize: string | null = null;

  constructor(url: string) {
    this.#url = url;
    this.element.className = "absolute inset-0";
    // noVNC 1.7 asks the box for a new size on the first frame of a change,
    // with no wait, and asks for one size at a time without asking again
    // when the box answers that it passed the request on, as QEMU does. So
    // a maximise landed in two steps: the box's queue set the size of that
    // first frame, and the final size came only with the nudge below (the
    // Windows box of 2 October 2026). While the viewer's size moves, noVNC
    // may not ask; once the size has held, the nudge sets resizeSession
    // again, which makes noVNC ask once, for the size that holds. This
    // observer is made before noVNC's own, so it runs first in a frame.
    this.#observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            const size = entries.at(-1)?.contentRect;
            clearTimeout(this.#settle);
            if (!size || size.width <= 0 || size.height <= 0) return;
            const key = `${Math.round(size.width)}x${Math.round(size.height)}`;
            const moved = this.#lastSize !== null && this.#lastSize !== key;
            this.#lastSize = key;
            if (moved && this.#client) this.#client.resizeSession = false;
            this.#settle = setTimeout(() => this.#nudge(), SETTLE_MS);
          });
    this.#observer?.observe(this.element);
    this.connect();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(connection: Connection): void {
    this.connection = connection;
    for (const listener of this.#listeners) listener();
  }

  connect(): void {
    if (this.#disposed) return;
    clearTimeout(this.#retry);
    this.#refused = null;
    const client = new Viewer(this.element, this.#url, { shared: true });
    client.scaleViewport = true;
    client.viewOnly = !this.#mine;
    client.resizeSession = this.#mine && this.#resizable;
    client.addEventListener("connect", () => {
      if (this.#client !== client) return;
      this.#failures = 0;
      this.#set({ state: "connected" });
      this.#apply();
    });
    client.addEventListener("securityfailure", (event: Event) => {
      this.#refused = (event as CustomEvent<{ reason?: string }>).detail.reason ?? "The relay refused the connection.";
    });
    client.addEventListener("disconnect", () => {
      if (this.#client !== client) return;
      this.#client = null;
      const wait = Math.min(MAX_RETRY_MS, 1000 * 2 ** this.#failures);
      this.#failures += 1;
      this.#set({ state: "disconnected", reason: this.#refused ?? "The connection to the desktop ended.", retryMs: wait });
      if (this.hidden) {
        this.onEnded?.();
        return;
      }
      this.#retry = setTimeout(() => this.connect(), wait);
    });
    this.#client = client;
    this.#set({ state: "connecting" });
  }

  reconnect(): void {
    this.#failures = 0;
    clearTimeout(this.#retry);
    const client = this.#client;
    this.#client = null;
    client?.disconnect();
    this.connect();
  }

  /** Input and resizing follow control. The relay drops input from a viewer without control anyway; this keeps noVNC from sending it. */
  setControl(mine: boolean, resizable: boolean): void {
    this.#mine = mine;
    this.#resizable = resizable;
    this.#apply();
  }

  #apply(): void {
    const client = this.#client;
    if (!client || this.connection.state !== "connected") return;
    client.viewOnly = !this.#mine;
    client.resizeSession = this.#mine && this.#resizable;
    if (this.#mine) client.focus({ preventScroll: true });
  }

  /** The viewer's size has held: noVNC asks for it once, if the desktop differs and this viewer may resize it. */
  #nudge(): void {
    const client = this.#client;
    if (client && this.connection.state === "connected" && this.#mine && this.#resizable) client.resizeSession = true;
  }

  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#retry);
    clearTimeout(this.#settle);
    this.#observer?.disconnect();
    const client = this.#client;
    this.#client = null;
    client?.disconnect();
    this.#listeners.clear();
    this.element.remove();
  }
}

/** The toolbar's words for who has control. `taken` says the agent took it back from this tab (038); `resizable` says the desktop follows this tab's size while it holds control. */
function controlText(box: BoxView, mine: boolean, taken: boolean, resizable: boolean): string {
  switch (box.control?.owner) {
    case "human":
      if (!mine) return "Another viewer has control.";
      return resizable ? "You have control. The desktop follows this tab's size." : "You have control.";
    case "none":
      return "Control is changing hands…";
    default:
      return taken ? "The agent took control." : "The agent has control.";
  }
}

/** A box's desktop, live, with its control bar. */
export function DesktopViewer({ threadId, boxId, newTab, onBack }: { threadId: string; boxId: string; newTab: boolean; onBack?: { label: string; go: () => void } }) {
  const rpc = useRpc<Contract>();
  const pluginId = experimental_usePluginId();
  const navigate = useBbNavigate();
  const viewer = useViewerId(boxId);
  const { value: state, error, refresh } = useLive<DesktopState>(`${threadId}/${boxId}`, () => rpc.call("desktop", { threadId, box: boxId }), forThread(threadId));
  const box = state?.box ?? null;
  const path = state?.desktopPath ?? null;
  const showing = box !== null && box.state === "ready" && box.display !== null;
  const mine = box?.control?.owner === "human" && box.control.holder === viewer;
  const taken = box?.control?.owner === "agent" && box.control.takenFrom === viewer;
  const resizable = box?.display?.resizable ?? false;

  const target = useRef<HTMLDivElement>(null);
  const session = useRef<DesktopSession | null>(null);
  const mineNow = useRef(false);
  mineNow.current = mine;
  const key = `desktop:${boxId}:${viewer}`;
  // A kept session shows at once, before the box's state has loaded; the state can only confirm or end it.
  const [connection, setConnection] = useState<Connection>(() => keptFree<DesktopSession>(key)?.connection ?? { state: "connecting" });
  const [acting, setActing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ready = showing && path !== null;
  const pathNow = useRef(path);
  pathNow.current = path;
  const wanted = ready || keptFree(key) !== undefined;

  // The viewer's session is claimed on mount and given back on unmount; the registry keeps it meanwhile (037).
  // A layout effect, so a kept frame is in the page before it paints.
  useLayoutEffect(() => {
    const screen = target.current;
    if (!wanted || !screen) return;
    const latestPath = pathNow.current;
    if (keptFree(key) === undefined && !latestPath) return;
    const claimed = claimKept(key, () => new DesktopSession(socketUrl(latestPath!, boxId, viewer)));
    const current = claimed.session;
    screen.appendChild(current.element);
    session.current = current;
    const unsubscribe = current.subscribe(() => setConnection(current.connection));
    setConnection(current.connection);
    // It rested while the box was away, or lost its connection while hidden.
    if (current.connection.state === "disconnected") current.reconnect();
    return () => {
      unsubscribe();
      current.element.remove();
      session.current = null;
      if (!claimed.kept) {
        current.dispose();
        return;
      }
      // A hidden tab may hold control for as long as a closed viewer: a minute (008). Then the agent has it back, unless someone else took it meanwhile.
      releaseKept(
        key,
        mineNow.current
          ? {
              handBack: async () => {
                const latest = await rpc.call("desktop", { threadId, box: boxId });
                if (latest.box?.control?.owner === "human" && latest.box.control.holder === viewer) await rpc.call("handBack", { threadId, box: boxId });
              },
            }
          : {},
      );
    };
  }, [wanted, boxId, viewer, key, rpc, threadId]);

  // In the commit that shows who has control, so the toolbar never says "You have control" while input is still off (#116).
  useLayoutEffect(() => {
    session.current?.setControl(mine, resizable);
  }, [mine, resizable, connection]);

  // A box that stops or goes takes its stream with it.
  useEffect(() => {
    if (state && !showing) dropKept(key);
  }, [state, showing, key]);

  const act = async (task: () => Promise<BoxResult>) => {
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
  const start = () => act(() => rpc.call("start", { threadId, box: boxId }));
  const reconnect = () => session.current?.reconnect();

  // The toolbar's state: a dot and a few words.
  let tone: Tone = "busy";
  let words = "Loading…";
  if (error) {
    tone = "bad";
    words = "Could not load";
  } else if (box && !box.display) {
    tone = "off";
    words = "No desktop";
  } else if (box && box.state !== "ready") {
    tone = box.state === "stopped" ? "off" : box.state === "failed" || box.state === "gone" ? "bad" : "busy";
    words = statusOf(box, Date.now()).items[0]?.text ?? box.state;
  } else if (box && connection.state === "connecting") {
    words = "Connecting…";
  } else if (box && connection.state === "disconnected") {
    tone = "warn";
    words = "Disconnected";
  } else if (box) {
    tone = "ok";
    words = controlText(box, mine, taken, resizable);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface-recessed px-3 py-2 text-xs">
        {onBack ? <IconButton label={onBack.label} icon="ArrowLeft" onClick={onBack.go} className="-ml-1" /> : null}
        <MonitorGlyph className="text-muted-foreground" />
        <span className="font-medium text-foreground">{box?.name ?? "Desktop"}</span>
        <span className={cn("inline-flex min-w-0 items-center gap-1.5", mine || taken ? "text-foreground" : "text-muted-foreground")}>
          <StatusDot tone={tone} />
          <span className="min-w-0">{words}</span>
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {showing && !mine ? (
            <Button type="button" variant="outline" size="sm" className="h-7" disabled={acting || connection.state !== "connected"} onClick={() => void take()}>
              {taken ? "Take control again" : "Take control"}
            </Button>
          ) : null}
          {showing && mine ? (
            <Button type="button" size="sm" className="h-7" disabled={acting} onClick={() => void handBack()}>
              Hand back to the agent
            </Button>
          ) : null}
          {showing && connection.state === "disconnected" ? (
            <Button type="button" variant="outline" size="sm" className="h-7" onClick={reconnect}>
              Reconnect
            </Button>
          ) : null}
          {box ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className="size-7 p-0 text-muted-foreground hover:text-foreground" aria-label="Desktop actions">
                  <Icon name="MoreHorizontal" className="size-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-max min-w-40 max-w-72" mobileTitle={box.name}>
                {newTab ? (
                  <DropdownMenuItem onSelect={() => void navigate.openUrl(pageHref(pluginId, threadId, box.id))}>
                    <Icon name="ExternalLink" aria-hidden />
                    Open in a browser tab
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onSelect={() => navigate.toThread(threadId)}>
                    <Icon name="ArrowUpRight" aria-hidden />
                    Open thread
                  </DropdownMenuItem>
                )}
                {showing ? (
                  <DropdownMenuItem onSelect={reconnect}>
                    <Icon name="ArrowReloadHorizontal" aria-hidden />
                    Reconnect
                  </DropdownMenuItem>
                ) : null}
                {box.control?.owner === "human" && !mine ? (
                  <DropdownMenuItem onSelect={() => void handBack()}>
                    <Icon name="ArrowTurnBackward" aria-hidden />
                    Hand back to the agent
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </span>
      </div>
      {problem ? (
        <p role="alert" className="border-b border-border px-3 py-1.5 text-xs text-destructive-text">
          {problem}
        </p>
      ) : null}
      <div className="relative min-h-0 flex-1 bg-muted">
        <div ref={target} className="absolute inset-0" data-testid="desktop-screen" />
        {mine ? <div aria-hidden data-testid="control-ring" className="pointer-events-none absolute inset-0 ring-2 ring-inset ring-primary/60" /> : null}
        {error ? (
          <Notice>{error}</Notice>
        ) : !state ? null : !box ? (
          <Notice>This box has been released.</Notice>
        ) : !box.display ? (
          <Notice>{box.name} has no desktop.</Notice>
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
        ) : box.state === "acquiring" || box.state === "starting" ? (
          <Notice detail="The desktop shows once it is ready.">{box.name} is starting…</Notice>
        ) : box.state === "failed" ? (
          <Notice detail={box.error ?? undefined}>{box.name} failed to start.</Notice>
        ) : box.state === "gone" ? (
          <Notice>{box.name} was deleted outside bb-box.</Notice>
        ) : box.state !== "ready" ? (
          <Notice>{box.name} is being released.</Notice>
        ) : connection.state === "connecting" ? (
          <Notice>Connecting to the desktop…</Notice>
        ) : connection.state === "disconnected" ? (
          <Notice
            detail={`Trying again in ${Math.max(1, Math.round(connection.retryMs / 1000))} s`}
            action={
              <Button type="button" variant="outline" size="sm" className="h-7" onClick={reconnect}>
                Reconnect now
              </Button>
            }
          >
            {connection.reason}
          </Notice>
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
    navigate.openThreadPanel({ actionId: DESKTOP_ACTION, title: box.name, params: desktopParams(box.id) });
  };
}

/** The thread panel tab for one box's desktop. Opened bare from its launcher row, it opens the thread's desktop, picks among several, or offers the Box panel. */
export function DesktopPanel({ threadId, params }: { threadId: string; params: unknown }) {
  const boxId = parseParams(params);
  if (boxId) return <DesktopViewer key={boxId} threadId={threadId} boxId={boxId} newTab />;
  return <DesktopChooser threadId={threadId} />;
}

/** A box as a row: its glyph, name, kind, state (and who has control, for a desktop), with its actions. */
export function BoxLine({ box, meta, actions }: { box: BoxView; meta?: string | null; actions?: React.ReactNode }) {
  const status = statusOf(box, Date.now());
  const control = box.desktop && box.state === "ready" && !controlWord(box, new Set()) ? "The agent has control" : null;
  return (
    <div className="grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-3 py-3">
      <span className="flex size-6 items-center justify-center text-muted-foreground">{box.desktop ? <MonitorGlyph /> : <ServerGlyph />}</span>
      <div className="min-w-0">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium text-foreground">{box.name}</span>
          <span className="truncate text-xs text-muted-foreground">{osName(box.os)}</span>
          <KindBadges desktop={box.desktop} gpu={box.gpu} noDocker={lacksDocker(box)} arm64={isArm64Badge(box.os, box.arch)} forms={box.form ? [box.form] : []} />
        </span>
        <div className="mt-0.5 flex min-w-0 items-start gap-1.5 text-xs leading-snug text-muted-foreground">
          <StatusDot tone={status.tone} />
          <Meta items={[status.items[0]?.text, ...status.items.slice(1).map((item) => item.text), control, meta]} />
        </div>
      </div>
      <span className="flex shrink-0 items-center gap-1">{actions}</span>
    </div>
  );
}

/**
 * The bare Desktop launcher tab, made a real shortcut (Task A): one desktop opens
 * straight away, several offer a chooser, and none sends you to the Box panel. The
 * SDK 0.5.29 has no way to hide the launcher row (see docs/bb-requests.md #14), so
 * the shortcut lives here rather than in the action's run().
 */
function DesktopChooser({ threadId }: { threadId: string }) {
  const rpc = useRpc<Contract>();
  const navigate = useBbNavigate();
  const open = useOpenDesktop();
  const { value: state, error } = useLive<PanelState>(threadId, () => rpc.call("state", { threadId }), forThread(threadId));
  const desktops = state?.boxes.filter((box) => box.desktop) ?? [];
  useNow(desktops.some((box) => box.state === "acquiring" || box.state === "starting"), 1000);
  if (desktops.length === 1) return <DesktopViewer key={desktops[0]!.id} threadId={threadId} boxId={desktops[0]!.id} newTab />;
  return (
    <div className="p-4">
      {error ? <EmptyPanel role="alert">{error}</EmptyPanel> : null}
      {state && !desktops.length ? (
        <EmptyPanel title="No desktop box">
          <p className="mt-1">This thread has no desktop box.</p>
          <Button type="button" variant="outline" size="sm" className="mt-3 h-7" onClick={() => navigate.openThreadPanel({ actionId: BOXES_ACTION, title: "Box" })}>
            Open the Box panel
          </Button>
        </EmptyPanel>
      ) : null}
      {desktops.length ? (
        <div className="rounded-lg border border-border bg-card px-4 py-1">
          <div className="divide-y divide-border">
            {desktops.map((box) => (
              <BoxLine
                key={box.id}
                box={box}
                actions={
                  <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => open(box)}>
                    Open
                  </Button>
                }
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The Boxes page: every box across threads and your machines, or one box's desktop or terminal at <threadId>/<boxId>. */
export function BoxesPage({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const [threadId, boxId, ...rest] = subPath.split("/").map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return "";
    }
  });
  // A view opened from the settings page goes back there: a machine of yours is not on the Boxes list the same way.
  const fromSettings = rest.at(-1) === "from-settings";
  const parts = fromSettings ? rest.slice(0, -1) : rest;
  const back = fromSettings ? { label: "Back to settings", go: () => void navigate.openUrl(SETTINGS_PATH) } : { label: "Back to boxes", go: () => navigate.toPluginPanel(DESKTOP_PAGE, { subPath: "" }) };
  if (threadId && boxId && parts.length === 1 && parts[0] === "terminal") {
    return <BoxTerminal key={`${threadId}/${boxId}/terminal`} threadId={threadId} boxId={boxId} onBack={back} />;
  }
  if (threadId && boxId && !parts.length) {
    return <DesktopViewer key={`${threadId}/${boxId}`} threadId={threadId} boxId={boxId} newTab={false} onBack={back} />;
  }
  return <BoxList />;
}

/** The titles of the threads whose boxes the page lists, fetched once each; a thread that cannot be read shows its ID. */
export function useThreadTitles(threadIds: readonly string[]): Record<string, string> {
  const sdk = useSdk();
  const [titles, setTitles] = useState<Record<string, string>>({});
  const key = threadIds.join(" ");
  useEffect(() => {
    let cancelled = false;
    for (const threadId of key.split(" ").filter(Boolean)) {
      if (titles[threadId] !== undefined) continue;
      sdk.threads
        .get({ threadId })
        .then((thread) => {
          if (!cancelled) setTitles((current) => ({ ...current, [threadId]: thread.title || threadId }));
        })
        .catch(() => {
          if (!cancelled) setTitles((current) => ({ ...current, [threadId]: threadId }));
        });
    }
    return () => {
      cancelled = true;
    };
    // Titles are fetched once per thread; a change of the set triggers the next round.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, sdk]);
  return titles;
}

/** Where the Boxes page shows one box's desktop, or its terminal; from settings, the back arrow returns there. */
export function desktopSubPath(threadId: string, boxId: string, view: "desktop" | "terminal" = "desktop", from?: "settings"): string {
  const base = `${encodeURIComponent(threadId)}/${encodeURIComponent(boxId)}`;
  return [base, ...(view === "terminal" ? ["terminal"] : []), ...(from === "settings" ? ["from-settings"] : [])].join("/");
}

function BoxList() {
  const rpc = useRpc<Contract>();
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const { value: all, error } = useLive<BoxEntry[]>("allBoxes", () => rpc.call("allBoxes"), () => true);
  const entries = all ?? [];
  const yours = entries.filter((entry) => entry.owner === "yours");
  const threads = entries.filter((entry) => entry.owner !== "yours");
  const titles = useThreadTitles([...new Set(threads.map((entry) => entry.threadId))]);
  useNow(
    entries.some((entry) => entry.box.state === "acquiring" || entry.box.state === "starting"),
    1000,
  );
  // A row's actions: open a desktop, a terminal, a desktop in a browser tab, and the owning thread.
  const actions = (threadId: string, box: BoxView, own: boolean) => (
    <>
      {box.desktop && box.state === "ready" ? (
        <IconButton label="Open desktop" icon={<MonitorGlyph />} onClick={() => navigate.toPluginPanel(DESKTOP_PAGE, { subPath: desktopSubPath(threadId, box.id) })} />
      ) : null}
      {canOpenTerminal(box) ? (
        <IconButton label="Open terminal" icon={<TerminalGlyph />} onClick={() => navigate.toPluginPanel(DESKTOP_PAGE, { subPath: desktopSubPath(threadId, box.id, "terminal") })} />
      ) : null}
      {box.desktop && box.state === "ready" ? (
        <IconButton label="Open desktop in a browser tab" icon="ExternalLink" onClick={() => void navigate.openUrl(pageHref(pluginId, threadId, box.id))} />
      ) : null}
      {own ? null : <IconButton label="Open thread" icon="ArrowUpRight" onClick={() => navigate.toThread(threadId)} />}
    </>
  );
  const card = (list: readonly BoxEntry[], own: boolean) => (
    <div className="rounded-lg border border-border bg-card px-4 py-1">
      <div className="divide-y divide-border">
        {list.map(({ threadId, box }) => (
          <BoxLine key={box.id} box={box} meta={own ? null : (titles[threadId] ?? null)} actions={actions(threadId, box, own)} />
        ))}
      </div>
    </div>
  );
  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        {error ? <EmptyPanel role="alert">{error}</EmptyPanel> : null}
        {all && !entries.length ? <EmptyPanel title="No boxes">No thread has a box, and you have no machines. Make one from a thread's Box panel.</EmptyPanel> : null}
        {yours.length ? (
          <div className="space-y-2">
            <h3 className="text-xs font-medium text-foreground">Your machines</h3>
            {card(yours, true)}
          </div>
        ) : null}
        {threads.length ? (
          <div className="space-y-2">
            {yours.length ? <h3 className="text-xs font-medium text-foreground">Threads</h3> : null}
            {card(threads, false)}
          </div>
        ) : null}
      </div>
    </div>
  );
}
