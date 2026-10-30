import { SETTINGS_PATH } from "./common.tsx";

export const OPTION_PAGES = ["boxes", "images", "snapshots", "devices", "network", "monitor", "configuration"] as const;

export type OptionPage = (typeof OPTION_PAGES)[number];

export type SettingsView =
  | { readonly page: "overview" }
  | { readonly page: "backend"; readonly id: string }
  | { readonly page: "kind"; readonly id: string }
  | { readonly page: "option"; readonly id: string }
  | { readonly page: "add" }
  | { readonly page: "setup"; readonly type: string };

export const OVERVIEW: SettingsView = { page: "overview" };

export const OPEN_SETTINGS_VIEW_EVENT = "bb-box:open-settings-view";

export function isOptionPage(id: string): id is OptionPage {
  return (OPTION_PAGES as readonly string[]).includes(id);
}

function decoded(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

export function viewFromHash(hash: string): SettingsView {
  const [page = "", ...rest] = hash.replace(/^#/, "").split("/");
  const id = decoded(rest.join("/"));
  if (page === "backend" && id) return { page, id };
  if (page === "kind" && id) return { page, id };
  if (page === "option" && id) return { page, id };
  if (page === "setup" && id) return { page, type: id };
  if (page === "add" && !id) return { page };
  return OVERVIEW;
}

export function hashOf(view: SettingsView): string {
  switch (view.page) {
    case "overview":
      return "";
    case "add":
      return "#add";
    case "setup":
      return `#setup/${encodeURIComponent(view.type)}`;
    default:
      return `#${view.page}/${encodeURIComponent(view.id)}`;
  }
}

export function sameView(a: SettingsView, b: SettingsView): boolean {
  return hashOf(a) === hashOf(b);
}

export function settingsHref(view: SettingsView = OVERVIEW): string {
  return `${SETTINGS_PATH}${hashOf(view)}`;
}

export function onSettingsPage(): boolean {
  return typeof window !== "undefined" && window.location.pathname.replace(/\/+$/, "") === SETTINGS_PATH;
}

export const HISTORY_KEY = "bbBoxSettings";

export interface HistoryEntry {
  readonly depth: number;
  readonly from: string | null;
  readonly scroll?: number;
  readonly row?: string;
}

export function entryOf(state: unknown): HistoryEntry | null {
  if (typeof state !== "object" || state === null || !(HISTORY_KEY in state)) return null;
  return ((state as Record<string, unknown>)[HISTORY_KEY] as HistoryEntry | undefined) ?? null;
}

export function withEntry(entry: HistoryEntry): Record<string, unknown> {
  return { ...((window.history.state as Record<string, unknown> | null) ?? {}), [HISTORY_KEY]: entry };
}

export function currentHash(): string {
  return window.location.hash === "#" ? "" : window.location.hash;
}

export function openSettingsView(view: SettingsView): void {
  const here = currentHash();
  if (here === hashOf(view)) return;
  const depth = entryOf(window.history.state)?.depth ?? 0;
  window.history.pushState(withEntry({ depth: depth + 1, from: here }), "", `${window.location.pathname}${window.location.search}${hashOf(view)}`);
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_VIEW_EVENT, { detail: hashOf(view) }));
}
