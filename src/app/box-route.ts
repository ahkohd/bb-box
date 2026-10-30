export const BOX_PART = "box";

export const ORIGINS = ["from-list", "from-box", "from-settings"] as const;

export type Origin = (typeof ORIGINS)[number];

export const VIEWS = ["desktop", "device", "terminal"] as const;

export type BoxViewName = (typeof VIEWS)[number];

export type ListTab = "machines" | "threads";

export type BoxesRoute =
  | { readonly page: "list"; readonly tab: ListTab | null }
  | { readonly page: "box"; readonly boxId: string; readonly origins: readonly Origin[] }
  | { readonly page: "view"; readonly boxId: string; readonly view: BoxViewName; readonly origins: readonly Origin[]; readonly threadId: string | null };

export type BoxPageRoute = Extract<BoxesRoute, { page: "box" }>;

export type BoxViewRoute = Extract<BoxesRoute, { page: "view" }>;

export type WayBack = { readonly to: "list" } | { readonly to: "settings" } | { readonly to: "box"; readonly route: BoxPageRoute };

export const LIST: BoxesRoute = { page: "list", tab: null };

const MOST_ORIGINS = 2;

function decoded(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

function isOrigin(part: string): part is Origin {
  return (ORIGINS as readonly string[]).includes(part);
}

function isView(part: string): part is BoxViewName {
  return (VIEWS as readonly string[]).includes(part);
}

function originsOf(parts: readonly string[]): Origin[] | null {
  if (parts.length > MOST_ORIGINS || !parts.every(isOrigin)) return null;
  return [...parts];
}

function legacyRoute(threadId: string, boxId: string, rest: readonly string[]): BoxesRoute {
  const fromSettings = rest.at(-1) === "from-settings";
  const parts = fromSettings ? rest.slice(0, -1) : rest;
  const origins: Origin[] = fromSettings ? ["from-settings"] : [];
  if (!parts.length) return { page: "view", boxId, view: "desktop", origins, threadId };
  if (parts.length === 1 && (parts[0] === "device" || parts[0] === "terminal")) return { page: "view", boxId, view: parts[0], origins, threadId };
  return LIST;
}

export function routeOf(subPath: string): BoxesRoute {
  const parts = subPath.split("/").filter(Boolean).map(decoded);
  if (parts.some((part) => part === null || part === "")) return LIST;
  const [first, second, ...rest] = parts as string[];
  if (first === undefined) return LIST;
  if (second === undefined) return first === "machines" || first === "threads" ? { page: "list", tab: first } : LIST;
  if (first !== BOX_PART) return legacyRoute(first, second, rest);
  const [maybeView, ...after] = rest;
  if (maybeView !== undefined && isView(maybeView)) {
    const origins = originsOf(after);
    return origins ? { page: "view", boxId: second, view: maybeView, origins, threadId: null } : LIST;
  }
  const origins = originsOf(rest);
  if (!origins || origins.includes("from-box")) return LIST;
  return { page: "box", boxId: second, origins };
}

export function subPathOf(route: BoxesRoute): string {
  switch (route.page) {
    case "list":
      return route.tab ?? "";
    case "box":
      return [BOX_PART, encodeURIComponent(route.boxId), ...route.origins].join("/");
    case "view":
      if (route.threadId !== null) {
        const tail = route.view === "desktop" ? [] : [route.view];
        return [encodeURIComponent(route.threadId), encodeURIComponent(route.boxId), ...tail, ...route.origins.filter((origin) => origin === "from-settings")].join("/");
      }
      return [BOX_PART, encodeURIComponent(route.boxId), route.view, ...route.origins].join("/");
  }
}

export function boxPage(boxId: string, origins: readonly Origin[] = []): BoxPageRoute {
  return { page: "box", boxId, origins };
}

export function boxView(boxId: string, view: BoxViewName, origins: readonly Origin[] = []): BoxViewRoute {
  return { page: "view", boxId, view, origins, threadId: null };
}

export function viewFromPage(page: BoxPageRoute, view: BoxViewName): BoxViewRoute {
  return boxView(page.boxId, view, ["from-box", ...page.origins]);
}

export function otherView(route: BoxViewRoute, view: BoxViewName): BoxViewRoute {
  return { ...route, view };
}

export function pageOfView(route: BoxViewRoute): BoxPageRoute {
  const [first, ...rest] = route.origins;
  if (first === "from-box") return boxPage(route.boxId, rest);
  return boxPage(route.boxId, first ? [first] : []);
}

export function wayBack(route: BoxPageRoute | BoxViewRoute): WayBack {
  const [first] = route.origins;
  if (first === "from-settings") return { to: "settings" };
  if (route.page === "box") return { to: "list" };
  if (first === "from-list") return { to: "list" };
  return { to: "box", route: pageOfView(route) };
}

export interface Move {
  readonly from: string;
  readonly to: string;
}

let lastMove: Move | null = null;

export function rememberMove(move: Move): void {
  lastMove = move;
}

export function movedTo(path: string): void {
  if (lastMove && lastMove.to === currentPath()) lastMove = { from: lastMove.from, to: path };
}

export function cameFrom(path: string): boolean {
  return lastMove !== null && lastMove.to === currentPath() && lastMove.from === path;
}

export function forgetMoves(): void {
  lastMove = null;
}

export function currentPath(): string {
  return typeof window === "undefined" ? "" : `${window.location.pathname}${window.location.search}`;
}
