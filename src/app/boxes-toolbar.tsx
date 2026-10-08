// The Boxes page's controls, in BB's Automations page's pattern (the
// operator, 8 October 2026): tabs with a count. Classes are that page's own.

import { cn } from "@/lib/utils";

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
