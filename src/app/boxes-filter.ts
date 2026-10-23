import type { BoxView } from "../plugin/views.ts";

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

export type TagGroup = "systems" | "forms" | "has" | "providers" | "states";

export const TAG_GROUPS: readonly TagGroup[] = ["systems", "forms", "has", "providers", "states"];

export const FLAT_TAG_GROUPS: readonly TagGroup[] = ["systems", "forms", "has"];

export const TAG_GROUP_LABELS: Readonly<Record<TagGroup, string>> = { systems: "System", forms: "Form", has: "Has", providers: "Provider", states: "State" };

const TAG_ORDER: Readonly<Partial<Record<TagGroup, readonly string[]>>> = {
  systems: ["Linux", "macOS", "Windows"],
  forms: ["VM", "Container", "microVM", "Physical"],
  has: ["Desktop", "GPU", "KVM", "arm64"],
  states: STATE_GROUPS,
};

export type Filters = Readonly<Record<TagGroup, readonly string[]>>;

export const NO_FILTERS: Filters = { systems: [], forms: [], has: [], providers: [], states: [] };

export function filtering(filters: Filters): boolean {
  return TAG_GROUPS.some((group) => filters[group].length > 0);
}

const SYSTEM_NAMES: Readonly<Record<string, string>> = { linux: "Linux", macos: "macOS", windows: "Windows" };

function formTag(box: BoxView): string | null {
  switch (box.form) {
    case "LXC":
    case "Docker":
      return "Container";
    case null:
      return null;
    default:
      return box.form;
  }
}

export function tagsOf(box: BoxView): Readonly<Record<TagGroup, readonly string[]>> {
  const form = formTag(box);
  const features = [...box.requires, ...box.extras];
  const has = [box.desktop && "Desktop", box.gpu && "GPU", features.includes("kvm") && "KVM", box.arch === "arm64" && "arm64"].filter((tag): tag is string => !!tag);
  return {
    systems: [SYSTEM_NAMES[box.os] ?? box.os],
    forms: form ? [form] : [],
    has,
    providers: [box.provider ?? box.backendLabel],
    states: [stateGroup(box)],
  };
}

export type SortKey = "name" | "created";

export interface Sort {
  readonly key: SortKey;
  readonly ascending: boolean;
}

export const SORT_WORDS: Readonly<Record<SortKey, string>> = { name: "Name", created: "Created" };

export interface Listed {
  readonly box: BoxView;
  readonly words: readonly string[];
}

export function choices(boxes: readonly BoxView[]): Filters {
  const present = (group: TagGroup) => new Set(boxes.flatMap((box) => tagsOf(box)[group]));
  const ordered = (group: TagGroup) => {
    const found = present(group);
    const order = TAG_ORDER[group];
    return order ? order.filter((tag) => found.has(tag)) : [...found].sort((a, b) => a.localeCompare(b));
  };
  return { systems: ordered("systems"), forms: ordered("forms"), has: ordered("has"), providers: ordered("providers"), states: ordered("states") };
}

function matchesGroup(tags: Readonly<Record<TagGroup, readonly string[]>>, filters: Filters, group: TagGroup): boolean {
  return !filters[group].length || filters[group].some((tag) => tags[group].includes(tag));
}

function matchesSearch({ box, words }: Listed, terms: readonly string[]): boolean {
  const text = [box.name, box.kindLabel, box.backendLabel, ...words].join(" ").toLowerCase();
  return terms.every((term) => text.includes(term));
}

const termsOf = (search: string) => search.toLowerCase().split(/\s+/).filter(Boolean);

export function shown<T extends Listed>(rows: readonly T[], search: string, filters: Filters, sort: Sort): T[] {
  const terms = termsOf(search);
  const kept = rows.filter((row) => {
    const tags = tagsOf(row.box);
    return TAG_GROUPS.every((group) => matchesGroup(tags, filters, group)) && matchesSearch(row, terms);
  });
  const order = (a: T, b: T) => (sort.key === "name" ? a.box.name.localeCompare(b.box.name) : a.box.createdAt - b.box.createdAt) || a.box.id.localeCompare(b.box.id);
  return kept.sort((a, b) => (sort.ascending ? order(a, b) : order(b, a)));
}

export type TagCounts = Readonly<Record<TagGroup, Readonly<Record<string, number>>>>;

export function tagCounts(rows: readonly Listed[], search: string, filters: Filters): TagCounts {
  const terms = termsOf(search);
  const searched = rows.filter((row) => matchesSearch(row, terms)).map((row) => tagsOf(row.box));
  const countGroup = (group: TagGroup) => {
    const counts: Record<string, number> = {};
    for (const tags of searched) {
      if (!TAG_GROUPS.every((other) => other === group || matchesGroup(tags, filters, other))) continue;
      for (const tag of tags[group]) counts[tag] = (counts[tag] ?? 0) + 1;
    }
    return counts;
  };
  return { systems: countGroup("systems"), forms: countGroup("forms"), has: countGroup("has"), providers: countGroup("providers"), states: countGroup("states") };
}

export function splitGroups(boxes: readonly BoxView[]): ReadonlySet<TagGroup> {
  const all = boxes.map(tagsOf);
  const splits = (group: TagGroup) => [...new Set(all.flatMap((tags) => tags[group]))].some((tag) => all.some((tags) => !tags[group].includes(tag)));
  return new Set(TAG_GROUPS.filter(splits));
}
