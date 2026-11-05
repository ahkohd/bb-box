import { experimental_usePluginId, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useMemo, type MouseEvent } from "react";
import type { BackTo } from "./common.tsx";
import { SETTINGS_PATH } from "./common.tsx";
import { DESKTOP_PAGE } from "./desktop.tsx";
import type { BoxOpens } from "./box-opens.tsx";
import { boxView, cameFrom, currentPath, LIST, movedTo, rememberMove, subPathOf, wayBack, type BoxesRoute, type BoxPageRoute, type BoxViewRoute, type Origin } from "./box-route.ts";
import { opensInNewTab } from "./modified-click.ts";

const SETTINGS_BACK_WORDS = "Back to BB Box settings";

const LIST_BACK_WORDS = "Back to boxes";

const LIST_ROUTES: readonly BoxesRoute[] = [LIST, { page: "list", tab: "machines" }, { page: "list", tab: "threads" }, { page: "list", tab: "snapshots" }];

export function boxesPath(pluginId: string, route: BoxesRoute): string {
  const subPath = subPathOf(route);
  return `/plugins/${encodeURIComponent(pluginId)}/${DESKTOP_PAGE}${subPath ? `/${subPath}` : ""}`;
}

export function boxesUrl(pluginId: string, route: BoxesRoute): string {
  return new URL(boxesPath(pluginId, route), window.location.origin).href;
}

function leftToTheBrowser(event: MouseEvent<HTMLAnchorElement>): boolean {
  if (!opensInNewTab(event)) return false;
  event.stopPropagation();
  return true;
}

export interface BoxesNav {
  readonly href: (route: BoxesRoute) => string;
  readonly go: (route: BoxesRoute, options?: { readonly replace?: boolean }) => void;
  readonly goBackTo: (route: BoxesRoute) => void;
  readonly onLink: (route: BoxesRoute) => (event: MouseEvent<HTMLAnchorElement>) => void;
  readonly back: (from: BoxPageRoute | BoxViewRoute, boxName: string | null) => WayBackTo;
}

export type WayBackTo = BackTo & { readonly place: string };

export function useBoxesNav(): BoxesNav {
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  return useMemo(() => {
    const href = (route: BoxesRoute) => boxesPath(pluginId, route);
    const go = (route: BoxesRoute, options: { readonly replace?: boolean } = {}) => {
      const to = href(route);
      if (options.replace) movedTo(to);
      else rememberMove({ from: currentPath(), to });
      navigate.toPluginPanel(DESKTOP_PAGE, { subPath: subPathOf(route), ...(options.replace ? { replace: true } : {}) });
    };
    const goBackTo = (route: BoxesRoute) => {
      const alike = route.page === "list" ? LIST_ROUTES : [route];
      if (alike.some((each) => cameFrom(href(each)))) window.history.back();
      else go(route, { replace: true });
    };
    const onLink = (route: BoxesRoute) => (event: MouseEvent<HTMLAnchorElement>) => {
      if (leftToTheBrowser(event)) return;
      event.preventDefault();
      go(route);
    };
    const back = (from: BoxPageRoute | BoxViewRoute, boxName: string | null): WayBackTo => {
      const way = wayBack(from);
      if (way.to === "settings") return { label: SETTINGS_BACK_WORDS, place: "BB Box settings", href: SETTINGS_PATH };
      if (way.to === "list") return { label: LIST_BACK_WORDS, place: "Boxes", go: () => goBackTo(LIST) };
      return { label: boxName ? `Back to ${boxName}` : "Back to the box", place: boxName ?? "The box", go: () => goBackTo(way.route) };
    };
    return { href, go, goBackTo, onLink, back };
  }, [navigate, pluginId]);
}

export function opensFrom(nav: Pick<BoxesNav, "go">, origins: readonly Origin[]): BoxOpens {
  return {
    screen: (box, screen) => nav.go(boxView(box.id, screen, origins)),
    terminal: (box) => nav.go(boxView(box.id, "terminal", origins)),
  };
}

export function useListOpens(): BoxOpens {
  const nav = useBoxesNav();
  return useMemo(() => opensFrom(nav, ["from-list"]), [nav]);
}

export interface PageLink {
  readonly href: string;
  readonly go: () => void;
}

export function followPageLink(page: PageLink): (event: MouseEvent<HTMLAnchorElement>) => void {
  return (event) => {
    if (leftToTheBrowser(event)) return;
    event.preventDefault();
    page.go();
  };
}

export function BoxName({ name, page }: { name: string; page?: PageLink }) {
  if (!page) return <span className="font-normal text-foreground">{name}</span>;
  return (
    <a
      href={page.href}
      title={`${name}'s page`}
      onClick={followPageLink(page)}
      className="rounded-sm font-normal text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {name}
    </a>
  );
}
