import { useEffect, useState } from "react";

export type Tab = "machines" | "threads" | "snapshots";

export type Route =
  | { readonly page: "list"; readonly tab: Tab }
  | { readonly page: "box"; readonly id: string }
  | { readonly page: "thread"; readonly id: string }
  | { readonly page: "settings"; readonly section: "" | "snapshots" };

const ROUTE_CHANGED = "prototype-route";

export function routeOf(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "box" && parts[1]) return { page: "box", id: parts[1] };
  if (parts[0] === "thread" && parts[1]) return { page: "thread", id: parts[1] };
  if (parts[0] === "settings") return { page: "settings", section: parts[1] === "snapshots" ? "snapshots" : "" };
  if (parts[0] === "machines" || parts[0] === "threads") return { page: "list", tab: parts[0] };
  return { page: "list", tab: "snapshots" };
}

export function pathOf(route: Route): string {
  switch (route.page) {
    case "list":
      return route.tab;
    case "box":
      return `box/${encodeURIComponent(route.id)}`;
    case "thread":
      return `thread/${encodeURIComponent(route.id)}`;
    case "settings":
      return route.section ? `settings/${route.section}` : "settings";
  }
}

export function hrefOf(route: Route): string {
  return `#/${pathOf(route)}`;
}

export function go(route: Route, options: { replace?: boolean } = {}): void {
  const url = `${location.pathname}${location.search}${hrefOf(route)}`;
  if (options.replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  window.dispatchEvent(new Event(ROUTE_CHANGED));
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
