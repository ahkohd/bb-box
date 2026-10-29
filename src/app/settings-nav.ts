import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { currentHash, entryOf, hashOf, OPEN_SETTINGS_VIEW_EVENT, OVERVIEW, sameView, viewFromHash, withEntry, type SettingsView } from "./settings-route.ts";

export interface Arrival {
  readonly kind: "open" | "return" | "replace";
  readonly row: string | null;
  readonly scroll: number;
  readonly moving: boolean;
  readonly serial: number;
}

export interface SettingsNav {
  readonly view: SettingsView;
  readonly cameFrom: SettingsView | null;
  readonly arrival: Arrival | null;
  go(view: SettingsView, row?: string): void;
  back(): void;
  toOverview(): void;
  replace(view: SettingsView): void;
}

let lastInput: "keyboard" | "pointer" = "keyboard";
let listening = false;

function listenForInput(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("keydown", () => void (lastInput = "keyboard"), true);
  window.addEventListener("pointerdown", () => void (lastInput = "pointer"), true);
}

export function pointerMotionAllowed(): boolean {
  return lastInput === "pointer" && !(typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

function urlFor(view: SettingsView): string {
  return `${window.location.pathname}${window.location.search}${hashOf(view)}`;
}

export function useSettingsNav(scroller: () => HTMLElement | null): SettingsNav {
  listenForInput();
  const [view, setView] = useState<SettingsView>(() => viewFromHash(window.location.hash));
  const [cameFrom, setCameFrom] = useState<SettingsView | null>(() => {
    const from = entryOf(window.history.state)?.from;
    return from === null || from === undefined ? null : viewFromHash(from);
  });
  const [arrival, setArrival] = useState<Arrival | null>(null);
  const serial = useRef(0);
  const viewRef = useRef(view);
  viewRef.current = view;

  const arrive = useCallback((next: Omit<Arrival, "serial">) => setArrival({ ...next, serial: ++serial.current }), []);

  useEffect(() => {
    const follow = (moving: boolean) => {
      const entry = entryOf(window.history.state);
      const next = viewFromHash(currentHash());
      setCameFrom(entry?.from === null || entry?.from === undefined ? null : viewFromHash(entry.from));
      setView(next);
      arrive({ kind: entry?.row || entry?.scroll ? "return" : "open", row: entry?.row ?? null, scroll: entry?.scroll ?? 0, moving });
    };
    const onPop = () => follow(pointerMotionAllowed());
    const onOpen = () => follow(false);
    const reread = () => {
      if (document.visibilityState === "hidden") return;
      if (hashOf(viewRef.current) !== currentHash()) follow(false);
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", reread);
    window.addEventListener(OPEN_SETTINGS_VIEW_EVENT, onOpen);
    window.addEventListener("focus", reread);
    document.addEventListener("visibilitychange", reread);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("hashchange", reread);
      window.removeEventListener(OPEN_SETTINGS_VIEW_EVENT, onOpen);
      window.removeEventListener("focus", reread);
      document.removeEventListener("visibilitychange", reread);
    };
  }, [arrive]);

  const go = useCallback(
    (next: SettingsView, row?: string) => {
      const here = viewRef.current;
      if (sameView(next, here)) return;
      const entry = entryOf(window.history.state) ?? { depth: 0, from: null };
      window.history.replaceState(withEntry({ ...entry, scroll: scroller()?.scrollTop ?? 0, ...(row ? { row } : {}) }), "", window.location.href);
      window.history.pushState(withEntry({ depth: entry.depth + 1, from: hashOf(here) }), "", urlFor(next));
      setCameFrom(here);
      setView(next);
      arrive({ kind: "open", row: null, scroll: 0, moving: pointerMotionAllowed() });
    },
    [arrive, scroller],
  );

  const back = useCallback(() => {
    if ((entryOf(window.history.state)?.depth ?? 0) > 0) {
      window.history.back();
      return;
    }
    go(OVERVIEW);
  }, [go]);

  const toOverview = useCallback(() => {
    const entry = entryOf(window.history.state);
    if (viewRef.current.page === "overview") return;
    if (entry && entry.depth > 0 && entry.from === "") {
      window.history.back();
      return;
    }
    go(OVERVIEW);
  }, [go]);

  const replace = useCallback(
    (next: SettingsView) => {
      const entry = entryOf(window.history.state) ?? { depth: 0, from: null };
      window.history.replaceState(withEntry({ depth: entry.depth, from: entry.from }), "", urlFor(next));
      setView(next);
      arrive({ kind: "replace", row: null, scroll: 0, moving: false });
    },
    [arrive],
  );

  return useMemo(() => ({ view, cameFrom, arrival, go, back, toOverview, replace }), [view, cameFrom, arrival, go, back, toOverview, replace]);
}

export function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = window.getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll" || overflow === "overlay") && node.scrollHeight > node.clientHeight) return node;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}
