import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { currentHash, entryOf, hashOf, OPEN_SETTINGS_VIEW_EVENT, OVERVIEW, sameView, viewFromHash, withEntry, type SettingsView } from "./settings-route.ts";

export interface Arrival {
  readonly kind: "open" | "return" | "replace" | "found";
  readonly row: string | null;
  readonly scroll: number;
  readonly focus?: string;
  readonly inPlace?: boolean;
  readonly serial: number;
}

export interface SettingsNav {
  readonly view: SettingsView;
  readonly cameFrom: SettingsView | null;
  readonly arrival: Arrival | null;
  go(view: SettingsView, row?: string, focus?: string): void;
  find(view: SettingsView, row: string, focus: string | null): void;
  back(): void;
  toOverview(): void;
  replace(view: SettingsView): void;
}

const MOUNT_SERIAL = 1;

function arrivalOnMount(view: SettingsView): Arrival | null {
  if (view.page !== "overview") return { kind: "open", row: null, scroll: 0, serial: MOUNT_SERIAL };
  const entry = entryOf(window.history.state);
  return entry?.row ? { kind: "return", row: entry.row, scroll: entry.scroll ?? 0, serial: MOUNT_SERIAL } : null;
}

function urlFor(view: SettingsView): string {
  return `${window.location.pathname}${window.location.search}${hashOf(view)}`;
}

export function useSettingsNav(scroller: () => HTMLElement | null): SettingsNav {
  const [view, setView] = useState<SettingsView>(() => viewFromHash(window.location.hash));
  const [cameFrom, setCameFrom] = useState<SettingsView | null>(() => {
    const from = entryOf(window.history.state)?.from;
    return from === null || from === undefined ? null : viewFromHash(from);
  });
  const [arrival, setArrival] = useState<Arrival | null>(() => arrivalOnMount(viewFromHash(window.location.hash)));
  const serial = useRef(MOUNT_SERIAL);
  const viewRef = useRef(view);
  viewRef.current = view;

  const arrive = useCallback((next: Omit<Arrival, "serial">) => setArrival({ ...next, serial: ++serial.current }), []);

  useEffect(() => {
    const follow = () => {
      const entry = entryOf(window.history.state);
      const next = viewFromHash(currentHash());
      setCameFrom(entry?.from === null || entry?.from === undefined ? null : viewFromHash(entry.from));
      setView(next);
      arrive({ kind: entry?.row || entry?.scroll ? "return" : "open", row: entry?.row ?? null, scroll: entry?.scroll ?? 0 });
    };
    const reread = () => {
      if (document.visibilityState === "hidden") return;
      if (hashOf(viewRef.current) !== currentHash()) follow();
    };
    window.addEventListener("popstate", follow);
    window.addEventListener("hashchange", reread);
    window.addEventListener(OPEN_SETTINGS_VIEW_EVENT, follow);
    window.addEventListener("focus", reread);
    document.addEventListener("visibilitychange", reread);
    return () => {
      window.removeEventListener("popstate", follow);
      window.removeEventListener("hashchange", reread);
      window.removeEventListener(OPEN_SETTINGS_VIEW_EVENT, follow);
      window.removeEventListener("focus", reread);
      document.removeEventListener("visibilitychange", reread);
    };
  }, [arrive]);

  const push = useCallback(
    (next: SettingsView, row: string | undefined, arrival: Omit<Arrival, "serial">) => {
      const here = viewRef.current;
      const entry = entryOf(window.history.state) ?? { depth: 0, from: null };
      window.history.replaceState(withEntry({ ...entry, scroll: scroller()?.scrollTop ?? 0, ...(row ? { row } : {}) }), "", window.location.href);
      window.history.pushState(withEntry({ depth: entry.depth + 1, from: hashOf(here) }), "", urlFor(next));
      setCameFrom(here);
      setView(next);
      arrive(arrival);
    },
    [arrive, scroller],
  );

  const go = useCallback(
    (next: SettingsView, row?: string, focus?: string) => {
      if (sameView(next, viewRef.current)) return;
      push(next, row, { kind: "open", row: null, scroll: 0, ...(focus ? { focus } : {}) });
    },
    [push],
  );

  const find = useCallback(
    (next: SettingsView, row: string, focus: string | null) => {
      const arrival = { kind: "found" as const, row: null, scroll: 0, ...(focus ? { focus } : {}) };
      if (sameView(next, viewRef.current)) arrive({ ...arrival, inPlace: true });
      else push(next, row, arrival);
    },
    [arrive, push],
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
      arrive({ kind: "replace", row: null, scroll: 0 });
    },
    [arrive],
  );

  return useMemo(() => ({ view, cameFrom, arrival, go, find, back, toOverview, replace }), [view, cameFrom, arrival, go, find, back, toOverview, replace]);
}

export function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = window.getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll" || overflow === "overlay") && node.scrollHeight > node.clientHeight) return node;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}
