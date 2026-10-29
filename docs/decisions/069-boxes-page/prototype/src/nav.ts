import { useEffect, useState } from "react";

export type ViewName = "desktop" | "device" | "terminal";

export type Route =
  | { readonly page: "list"; readonly tab: "threads" | "machines" | null }
  | { readonly page: "box"; readonly id: string; readonly fromSettings?: boolean }
  | { readonly page: "view"; readonly id: string; readonly view: ViewName; readonly fromSettings?: boolean }
  | { readonly page: "thread"; readonly id: string }
  | { readonly page: "settings"; readonly section: string };

export type CameFrom = "list" | "box" | null;

const ROUTE_CHANGED = "prototype-route";
const FROM_SETTINGS = "from-settings";

export function routeOf(hash: string): Route {
  const all = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const fromSettings = all.at(-1) === FROM_SETTINGS;
  const parts = fromSettings ? all.slice(0, -1) : all;
  if (parts[0] === "box" && parts[1] && !parts[2]) return { page: "box", id: parts[1], fromSettings };
  if (parts[0] === "box" && parts[1] && (parts[2] === "desktop" || parts[2] === "device" || parts[2] === "terminal")) return { page: "view", id: parts[1], view: parts[2], fromSettings };
  if (parts[0] === "thread" && parts[1]) return { page: "thread", id: parts[1] };
  if (parts[0] === "settings") return { page: "settings", section: parts[1] ?? "" };
  if (parts[0] === "machines") return { page: "list", tab: "machines" };
  if (parts[0] === "threads") return { page: "list", tab: "threads" };
  return { page: "list", tab: null };
}

export function pathOf(route: Route): string {
  const settings = (path: string, from?: boolean) => (from ? `${path}/${FROM_SETTINGS}` : path);
  switch (route.page) {
    case "list":
      return route.tab ?? "";
    case "box":
      return settings(`box/${encodeURIComponent(route.id)}`, route.fromSettings);
    case "view":
      return settings(`box/${encodeURIComponent(route.id)}/${route.view}`, route.fromSettings);
    case "thread":
      return `thread/${encodeURIComponent(route.id)}`;
    case "settings":
      return `settings/${route.section}`;
  }
}

export function go(route: Route, options: { replace?: boolean; from?: CameFrom } = {}): void {
  const url = `${location.pathname}${location.search}#/${pathOf(route)}`;
  const state = { from: options.from ?? null };
  if (options.replace) history.replaceState(state, "", url);
  else history.pushState(state, "", url);
  window.dispatchEvent(new Event(ROUTE_CHANGED));
}

export function cameFrom(): CameFrom {
  const from = (history.state as { from?: unknown } | null)?.from;
  return from === "list" || from === "box" ? from : null;
}

export function goBackOr(route: Route, expected: readonly CameFrom[], replace = false): void {
  const from = cameFrom();
  if (from && expected.includes(from)) history.back();
  else go(route, { replace });
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => routeOf(location.hash));
  useEffect(() => {
    const read = () => setRoute(routeOf(location.hash));
    window.addEventListener("popstate", read);
    window.addEventListener("hashchange", read);
    window.addEventListener(ROUTE_CHANGED, read);
    return () => {
      window.removeEventListener("popstate", read);
      window.removeEventListener("hashchange", read);
      window.removeEventListener(ROUTE_CHANGED, read);
    };
  }, []);
  return route;
}
