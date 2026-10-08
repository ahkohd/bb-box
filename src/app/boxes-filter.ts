// The Boxes page's search, filters and sort, as BB's Automations page has
// them: words typed match a box's name, kind, provider or thread; the
// filters keep the kinds, providers and states ticked; the sort orders by
// name or by age. Pure, so the tests can check each.

import type { BoxView } from "../plugin/views.ts";

/** A box's state, in the few words the State filter offers. */
export type StateGroup = "Ready" | "Starting" | "Stopped" | "Failed";

export const STATE_GROUPS: readonly StateGroup[] = ["Ready", "Starting", "Stopped", "Failed"];

export function stateGroup(box: BoxView): StateGroup {
  switch (box.state) {
    case "ready":
      return "Ready";
    case "acquiring":
    case "starting":
      return "Starting";
    case "failed":
    case "gone":
      return "Failed";
    default:
      return "Stopped";
  }
}

export interface Filters {
  readonly kinds: readonly string[];
  readonly providers: readonly string[];
  readonly states: readonly StateGroup[];
}

export const NO_FILTERS: Filters = { kinds: [], providers: [], states: [] };

export function filtering(filters: Filters): boolean {
  return filters.kinds.length + filters.providers.length + filters.states.length > 0;
}

export type SortKey = "name" | "created";

export interface Sort {
  readonly key: SortKey;
  readonly ascending: boolean;
}

export const SORT_WORDS: Readonly<Record<SortKey, string>> = { name: "Name", created: "Created" };

/** A row the page lists: a box, and the words beyond its own that a search matches, such as its thread's title. */
export interface Listed {
  readonly box: BoxView;
  readonly words: readonly string[];
}

/** What the filters can offer: the kinds, providers and states of the boxes listed, each once, in order. */
export function choices(boxes: readonly BoxView[]): Filters {
  const kinds = [...new Set(boxes.map((box) => box.kindLabel))].sort((a, b) => a.localeCompare(b));
  const providers = [...new Set(boxes.map((box) => box.backendLabel))].sort((a, b) => a.localeCompare(b));
  const present = new Set(boxes.map(stateGroup));
  return { kinds, providers, states: STATE_GROUPS.filter((group) => present.has(group)) };
}

/** The rows the search and filters keep, in the sort's order. A filter with nothing ticked keeps every row. */
export function shown<T extends Listed>(rows: readonly T[], search: string, filters: Filters, sort: Sort): T[] {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  const kept = rows.filter(({ box, words }) => {
    if (filters.kinds.length && !filters.kinds.includes(box.kindLabel)) return false;
    if (filters.providers.length && !filters.providers.includes(box.backendLabel)) return false;
    if (filters.states.length && !filters.states.includes(stateGroup(box))) return false;
    const text = [box.name, box.kindLabel, box.backendLabel, ...words].join(" ").toLowerCase();
    return terms.every((term) => text.includes(term));
  });
  const order = (a: T, b: T) => (sort.key === "name" ? a.box.name.localeCompare(b.box.name) : a.box.createdAt - b.box.createdAt) || a.box.id.localeCompare(b.box.id);
  return kept.sort((a, b) => (sort.ascending ? order(a, b) : order(b, a)));
}
