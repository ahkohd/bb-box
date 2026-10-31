import { useLayoutEffect, useRef, type RefObject } from "react";
import { NO_FILTERS, SORT_WORDS, TAG_GROUPS, type Filters, type Sort } from "./boxes-filter.ts";
import type { ListTab } from "./box-route.ts";

export interface RowLeft {
  readonly tab: ListTab;
  readonly boxId: string;
  readonly index: number;
}

export interface ListScroll {
  readonly tab: ListTab;
  readonly top: number;
}

export interface ListPlace {
  readonly search: string;
  readonly filters: Filters;
  readonly sort: Sort;
  readonly scroll: ListScroll | null;
  readonly left: RowLeft | null;
}

export const NAME_SORT: Sort = { key: "name", ascending: true };

export const FRESH_PLACE: ListPlace = { search: "", filters: NO_FILTERS, sort: NAME_SORT, scroll: null, left: null };

const STORAGE_KEY = "bb-box:boxes-list";

export const ROW_NAME = "data-row-name";

let place: ListPlace | null = null;

function isTab(value: unknown): value is ListTab {
  return value === "machines" || value === "threads" || value === "snapshots";
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function filtersFrom(value: unknown): Filters | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!TAG_GROUPS.every((group) => isStrings(record[group]))) return null;
  return Object.fromEntries(TAG_GROUPS.map((group) => [group, record[group]])) as unknown as Filters;
}

function sortFrom(value: unknown): Sort | null {
  if (typeof value !== "object" || value === null) return null;
  const { key, ascending } = value as Record<string, unknown>;
  return typeof key === "string" && Object.hasOwn(SORT_WORDS, key) && typeof ascending === "boolean" ? ({ key, ascending } as Sort) : null;
}

function scrollFrom(value: unknown): ListScroll | null {
  if (typeof value !== "object" || value === null) return null;
  const { tab, top } = value as Record<string, unknown>;
  return isTab(tab) && typeof top === "number" && Number.isFinite(top) && top >= 0 ? { tab, top } : null;
}

function leftFrom(value: unknown): RowLeft | null {
  if (typeof value !== "object" || value === null) return null;
  const { tab, boxId, index } = value as Record<string, unknown>;
  return isTab(tab) && typeof boxId === "string" && typeof index === "number" && Number.isInteger(index) && index >= 0 ? { tab, boxId, index } : null;
}

export function placeFrom(text: string | null): ListPlace | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  return {
    search: typeof record.search === "string" ? record.search : "",
    filters: filtersFrom(record.filters) ?? NO_FILTERS,
    sort: sortFrom(record.sort) ?? NAME_SORT,
    scroll: scrollFrom(record.scroll),
    left: leftFrom(record.left),
  };
}

function storedPlace(): ListPlace | null {
  try {
    return placeFrom(window.sessionStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function store(kept: ListPlace): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
  } catch {
    return;
  }
}

export function listPlace(): ListPlace {
  place ??= storedPlace() ?? FRESH_PLACE;
  return place;
}

export function keepListPlace(change: Partial<ListPlace>): void {
  place = { ...listPlace(), ...change };
  store(place);
}

export function noteListScroll(scroll: ListScroll): void {
  place = { ...listPlace(), scroll };
}

export function saveListPlace(): void {
  if (place) store(place);
}

export function forgetListPlace(): void {
  place = null;
}

function rowNames(list: ParentNode): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>(`[${ROW_NAME}]`));
}

export function leaveRow(list: HTMLElement | null, tab: ListTab, boxId: string): void {
  const index = list ? rowNames(list).findIndex((name) => name.getAttribute(ROW_NAME) === boxId) : -1;
  keepListPlace({ left: { tab, boxId, index: Math.max(0, index) }, ...(list ? { scroll: { tab, top: list.scrollTop } } : {}) });
}

export function rowToReturnTo(list: ParentNode, left: RowLeft): HTMLElement | null {
  const names = rowNames(list);
  return names.find((name) => name.getAttribute(ROW_NAME) === left.boxId) ?? names[Math.min(left.index, names.length - 1)] ?? null;
}

function focusRow(list: ParentNode, left: RowLeft): void {
  const name = rowToReturnTo(list, left);
  if (!name) return;
  name.focus({ preventScroll: true });
  name.closest("[data-resource-row]")?.scrollIntoView?.({ block: "nearest" });
}

function focusLost(): boolean {
  return !document.activeElement || document.activeElement === document.body;
}

export function returnToPlace(list: HTMLElement, tab: ListTab): RowLeft | null {
  const { scroll, left } = listPlace();
  if (scroll?.tab === tab) list.scrollTop = scroll.top;
  if (left?.tab !== tab) return null;
  keepListPlace({ left: null });
  focusRow(list, left);
  return left;
}

export function useReturnToPlace(list: RefObject<HTMLElement | null>, tab: ListTab, settled: boolean, boxes: unknown, machines: unknown): void {
  const returned = useRef(false);
  const returning = useRef<RowLeft | null>(null);
  const remembered = useRef({ boxes, machines });
  useLayoutEffect(() => {
    if (returned.current || !settled || !list.current) return;
    returned.current = true;
    returning.current = returnToPlace(list.current, tab);
  }, [list, settled, tab]);
  useLayoutEffect(() => {
    const left = returning.current;
    if (!left || !list.current) return;
    if (focusLost()) focusRow(list.current, left);
    if (boxes !== remembered.current.boxes && machines !== remembered.current.machines) returning.current = null;
  }, [list, boxes, machines]);
}
