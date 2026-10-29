import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type OptionPage = "boxes" | "images" | "devices" | "network" | "monitor" | "configuration";

export type View =
  | { readonly page: "overview" }
  | { readonly page: "backend"; readonly id: string }
  | { readonly page: "kind"; readonly id: string }
  | { readonly page: "option"; readonly id: OptionPage }
  | { readonly page: "add" }
  | { readonly page: "setup"; readonly type: string };

interface Entry {
  readonly depth: number;
  readonly from: string | null;
  readonly scroll?: number;
  readonly row?: string;
}

interface Nav {
  readonly view: View;
  readonly animate: "forward" | "back" | "none";
  readonly found: string | null;
  readonly cameFrom: View | null;
  readonly returnRow: string | null;
  go(view: View, options?: { found?: string; row?: string }): void;
  back(): void;
  toOverview(): void;
  landAfterSetup(view: View): void;
}

const NavContext = createContext<Nav | null>(null);

export function viewKey(view: View): string {
  return Object.values(view).join("/");
}

export function hashOf(view: View): string {
  return view.page === "overview" ? "" : `#${viewKey(view)}`;
}

export function parseHash(hash: string): View {
  const [page, ...rest] = hash.replace(/^#/, "").split("/");
  const id = decodeURIComponent(rest.join("/"));
  if (page === "backend" && id) return { page, id };
  if (page === "kind" && id) return { page, id };
  if (page === "option" && ["boxes", "images", "devices", "network", "monitor", "configuration"].includes(id)) return { page, id: id as OptionPage };
  if (page === "add") return { page };
  if (page === "setup" && id) return { page, type: id };
  return { page: "overview" };
}

function entryOf(state: unknown): Entry | null {
  return typeof state === "object" && state !== null && "bbbox" in state ? ((state as { bbbox: Entry }).bbbox ?? null) : null;
}

function urlFor(view: View): string {
  return `${location.pathname}${location.search}${hashOf(view)}`;
}

let lastInput: "keyboard" | "pointer" = "pointer";
if (typeof window !== "undefined") {
  window.addEventListener("keydown", () => (lastInput = "keyboard"), true);
  window.addEventListener("pointerdown", () => (lastInput = "pointer"), true);
}

function motionAllowed(): boolean {
  return lastInput === "pointer" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function NavProvider({ children, scroller }: { children: ReactNode; scroller: () => HTMLElement | null }) {
  const [view, setView] = useState<View>(() => parseHash(location.hash));
  const [animate, setAnimate] = useState<"forward" | "back" | "none">("none");
  const [found, setFound] = useState<string | null>(null);
  const [returnRow, setReturnRow] = useState<string | null>(null);
  const [cameFrom, setCameFrom] = useState<View | null>(() => {
    const entry = entryOf(history.state);
    return entry?.from ? parseHash(entry.from) : null;
  });
  const pending = useRef<View | null>(null);

  const remember = useCallback(
    (row?: string) => {
      const entry = entryOf(history.state) ?? { depth: 0, from: null };
      history.replaceState({ ...(history.state ?? {}), bbbox: { ...entry, scroll: scroller()?.scrollTop ?? 0, row: row ?? entry.row } }, "", location.href);
    },
    [scroller],
  );

  useEffect(() => {
    const onPop = () => {
      const entry = entryOf(history.state);
      const next = parseHash(location.hash);
      if (pending.current) {
        const target = pending.current;
        pending.current = null;
        history.replaceState({ ...(history.state ?? {}), bbbox: { depth: (entry?.depth ?? 0) + 0, from: entry?.from ?? null } }, "", urlFor(target));
        setCameFrom(entry?.from ? parseHash(entry.from) : null);
        setAnimate("none");
        setFound(null);
        setReturnRow(null);
        setView(target);
        requestAnimationFrame(() => scroller()?.scrollTo({ top: 0 }));
        return;
      }
      setAnimate(motionAllowed() ? "back" : "none");
      setFound(null);
      setCameFrom(entry?.from ? parseHash(entry.from) : null);
      setReturnRow(entry?.row ?? null);
      setView(next);
      requestAnimationFrame(() => scroller()?.scrollTo({ top: entry?.scroll ?? 0 }));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [scroller]);

  const go = useCallback(
    (next: View, options: { found?: string; row?: string } = {}) => {
      remember(options.row);
      const depth = (entryOf(history.state)?.depth ?? 0) + 1;
      history.pushState({ ...(history.state ?? {}), bbbox: { depth, from: hashOf(view) || "#" } }, "", urlFor(next));
      setAnimate(motionAllowed() ? "forward" : "none");
      setFound(options.found ?? null);
      setReturnRow(null);
      setCameFrom(view);
      setView(next);
      requestAnimationFrame(() => scroller()?.scrollTo({ top: 0 }));
    },
    [remember, scroller, view],
  );

  const back = useCallback(() => {
    if ((entryOf(history.state)?.depth ?? 0) > 0) {
      history.back();
      return;
    }
    go({ page: "overview" });
  }, [go]);

  const toOverview = useCallback(() => {
    if (view.page === "overview") return;
    if (cameFrom?.page === "overview" && (entryOf(history.state)?.depth ?? 0) > 0) {
      history.back();
      return;
    }
    go({ page: "overview" });
  }, [view, cameFrom, go]);

  const landAfterSetup = useCallback(
    (target: View) => {
      const entry = entryOf(history.state);
      if (cameFrom?.page === "add" && (entry?.depth ?? 0) > 1) {
        pending.current = target;
        history.back();
        return;
      }
      history.replaceState({ ...(history.state ?? {}), bbbox: { depth: entry?.depth ?? 0, from: entry?.from ?? null } }, "", urlFor(target));
      setAnimate("none");
      setView(target);
    },
    [cameFrom],
  );

  const nav = useMemo<Nav>(() => ({ view, animate, found, cameFrom, returnRow, go, back, toOverview, landAfterSetup }), [view, animate, found, cameFrom, returnRow, go, back, toOverview, landAfterSetup]);
  return <NavContext.Provider value={nav}>{children}</NavContext.Provider>;
}

export function useNav(): Nav {
  const nav = useContext(NavContext);
  if (!nav) throw new Error("No nav");
  return nav;
}
