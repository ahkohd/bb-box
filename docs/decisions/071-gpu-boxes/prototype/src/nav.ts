import { useEffect, useState } from "react";

export type Route =
  | { readonly page: "boxes" }
  | { readonly page: "new" }
  | { readonly page: "box"; readonly id: string; readonly resize?: boolean }
  | { readonly page: "settings" }
  | { readonly page: "agent" };

const ROUTE_CHANGED = "prototype-route";

export function routeOf(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "box" && parts[1]) return { page: "box", id: parts[1], ...(parts[2] === "resize" ? { resize: true } : {}) };
  if (parts[0] === "new") return { page: "new" };
  if (parts[0] === "settings") return { page: "settings" };
  if (parts[0] === "agent") return { page: "agent" };
  return { page: "boxes" };
}

export function hrefOf(route: Route): string {
  switch (route.page) {
    case "box":
      return `#/box/${encodeURIComponent(route.id)}${route.resize ? "/resize" : ""}`;
    default:
      return `#/${route.page}`;
  }
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
