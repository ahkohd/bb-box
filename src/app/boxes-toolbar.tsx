// The Boxes page's controls, in BB's Automations page's pattern (the
// operator, 8 October 2026): tabs with a count, and a search field with
// Filters and Sort beside it. Classes are that page's own.

import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { filtering, SORT_WORDS, type Filters, type Sort, type SortKey } from "./boxes-filter.ts";

export interface TabSpec<T extends string> {
  readonly id: T;
  readonly label: string;
  /** Shown after the label; none when there are none. */
  readonly count: number;
}

export function PageTabs<T extends string>({ tabs, selected, onSelect }: { tabs: readonly TabSpec<T>[]; selected: T; onSelect: (id: T) => void }) {
  return (
    <div role="tablist" className="flex items-center gap-1">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          type="button"
          aria-selected={tab.id === selected}
          // The count is a separate span with no space before it, so the name says it apart.
          aria-label={tab.count ? `${tab.label} ${tab.count}` : undefined}
          className={cn("inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium", tab.id === selected ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
          {tab.count ? <span className="text-2xs text-subtle-foreground">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

const TOOL_BUTTON = "shrink-0 rounded-md text-muted-foreground size-8 p-0 border border-input bg-background select-none";

/** The search field, then Filters and Sort. */
export function SearchRow({
  search,
  onSearch,
  filters,
  offered,
  onFilters,
  sort,
  onSort,
}: {
  search: string;
  onSearch: (value: string) => void;
  filters: Filters;
  /** What each filter can tick: the kinds, providers and states of the boxes listed. */
  offered: Filters;
  onFilters: (filters: Filters) => void;
  sort: Sort;
  onSort: (sort: Sort) => void;
}) {
  const toggle = <K extends keyof Filters>(key: K, value: Filters[K][number], on: boolean) => {
    const current = filters[key] as readonly string[];
    onFilters({ ...filters, [key]: on ? [...current, value] : current.filter((item) => item !== value) });
  };
  const group = <K extends keyof Filters>(key: K, label: string): ReactNode =>
    offered[key].length > 1 || filters[key].length ? (
      <>
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {offered[key].map((value) => (
          <DropdownMenuCheckboxItem
            key={value}
            checked={(filters[key] as readonly string[]).includes(value)}
            // Ticking one keeps the menu open for the next.
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(on) => toggle(key, value, on === true)}
          >
            {value}
          </DropdownMenuCheckboxItem>
        ))}
      </>
    ) : null;
  const groups = [group("kinds", "Kind"), group("providers", "Provider"), group("states", "State")].filter(Boolean);
  const sortLabel = `Sort: ${SORT_WORDS[sort.key]}, ${sort.ascending ? "ascending" : "descending"}`;
  return (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-2">
      <form role="search" aria-label="Search boxes" className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:flex-1" onSubmit={(event) => event.preventDefault()}>
        <div className="relative min-w-0 flex-1">
          <Icon name="Search" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            aria-label="Search boxes"
            placeholder="Search boxes"
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && search) {
                event.stopPropagation();
                onSearch("");
              }
            }}
            className="h-8 truncate pl-8 text-sm focus:border-ring/60 focus:text-clip focus:ring-2 focus:ring-ring/20 focus-visible:ring-2 focus-visible:ring-ring/20 max-md:pointer-coarse:h-8"
          />
          {search ? (
            <button type="button" aria-label="Clear search" className="absolute right-2 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground" onClick={() => onSearch("")}>
              <Icon name="X" className="size-3.5" aria-hidden />
            </button>
          ) : null}
        </div>
      </form>
      <div className="flex w-max shrink-0 items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" aria-label="Filters" className={cn(TOOL_BUTTON, filtering(filters) && "bg-state-active text-foreground")} disabled={!groups.length}>
              <Icon name="FilterHorizontal" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40" mobileTitle="Filters">
            {groups.map((items, index) => (
              <div key={index}>
                {index ? <DropdownMenuSeparator /> : null}
                {items}
              </div>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" aria-label={sortLabel} className={TOOL_BUTTON}>
              <Icon name="ArrowUpDown" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40" mobileTitle="Sort">
            <DropdownMenuLabel>Sort</DropdownMenuLabel>
            {(Object.keys(SORT_WORDS) as SortKey[]).map((key) => (
              <DropdownMenuItem key={key} className="justify-between gap-4" onSelect={() => onSort(key === sort.key ? { key, ascending: !sort.ascending } : { key, ascending: true })}>
                {SORT_WORDS[key]}
                {key === sort.key ? <Icon name={sort.ascending ? "ArrowUp" : "ArrowDown"} className="size-3.5 text-muted-foreground" aria-hidden /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
