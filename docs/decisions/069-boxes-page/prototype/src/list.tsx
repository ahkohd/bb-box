import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { boxTitleBadges, EmptyPanel, IconButton, RowTitle, StatusDot, systemName, deviceModelOf } from "@/src/app/common.tsx";
import { BoxGlyph } from "@/src/app/glyphs.tsx";
import { PageTabs, SearchRow } from "@/src/app/boxes-toolbar.tsx";
import { choices, filtering, NO_FILTERS, shown, SORT_WORDS, splitGroups, tagCounts, TAG_GROUPS, type Filters, type Sort, type SortKey } from "@/src/app/boxes-filter.ts";
import { ThreadChips } from "@/src/app/thread-chips.tsx";
import { BoxMenu, openingsOf, openView, useReleaseDialog } from "./actions";
import { machineThreads, type FakeBox, type FakeThread } from "./data";
import { go } from "./nav";
import { useStore } from "./store";
import { rowLine, shortSpan, type Line } from "./words";

type Tab = "threads" | "machines";

const TAB_KEY = "bb-box-prototype:boxes-tab";
const LAST_ACTIVE = "active" as SortKey;

Object.assign(SORT_WORDS as Record<string, string>, { [LAST_ACTIVE]: "Last active" });

interface Kept {
  search: string;
  filters: Filters;
  sort: Sort;
  scrollTop: number;
  openedId: string | null;
  openedIndex: number;
}

const keptLists = new Map<Tab, Kept>();

function freshList(): Kept {
  return { search: "", filters: NO_FILTERS, sort: { key: "name", ascending: true }, scrollTop: 0, openedId: null, openedIndex: 0 };
}

function keptTab(): Tab | null {
  try {
    const kept = localStorage.getItem(TAB_KEY);
    return kept === "threads" || kept === "machines" ? kept : null;
  } catch {
    return null;
  }
}

function onControl(event: MouseEvent<HTMLElement>): boolean {
  return event.target instanceof Element && event.target.closest("a, button, [role=menuitem], [data-row-action]") !== null;
}

export function boxHref(id: string): string {
  return `#/box/${encodeURIComponent(id)}`;
}

function lastActive(box: FakeBox, threads: readonly FakeThread[]): number {
  const own = threads.find((thread) => thread.id === box.threadId);
  const onIt = machineThreads(box, threads).map((thread) => thread.activeAt ?? 0);
  return Math.max(own?.activeAt ?? 0, ...onIt, box.started?.askedAt ?? 0, box.view.createdAt);
}

function RowLine({ line }: { line: Line }) {
  return (
    <div className="mt-0.5 flex min-w-0 items-start gap-1.5 text-xs leading-snug text-muted-foreground">
      <StatusDot tone={line.tone} />
      <span data-row-line className="line-clamp-2 min-w-0">
        {line.items.map((item, index) => (
          <span key={index} className={cn(item.tone === "fg" && "text-foreground", item.tone === "warn" && "text-warning-text", item.tone === "danger" && "text-destructive-text")}>
            {index ? <span aria-hidden className="text-subtle-foreground">{" · "}</span> : null}
            {item.text}
          </span>
        ))}
      </span>
    </div>
  );
}

function QuickActions({ box }: { box: FakeBox }) {
  const store = useStore();
  const view = box.view;
  const opens = openingsOf(view).filter((opening) => opening.closedBecause === null);
  const busy = store.busy.has(view.id);
  const reachable = !box.unreachable && !box.backendGone;
  return (
    <>
      {opens.map((opening, index) => (
        <span key={opening.view} className={cn(index > 0 && "max-sm:hidden")}>
          <IconButton label={`Open ${opening.words.toLowerCase()}`} icon={opening.glyph("size-4")} onClick={() => openView(view.id, opening.view, "list")} />
        </span>
      ))}
      {reachable && view.canStopStart && view.state === "stopped" ? <IconButton label="Start" icon="Play" loading={busy} disabled={busy} onClick={() => store.act("start", view.id)} /> : null}
      {reachable && view.canStopStart && view.state === "ready" ? (
        <span className="max-sm:hidden">
          <IconButton label="Stop" icon="Square" loading={busy} disabled={busy} onClick={() => store.act("stop", view.id)} />
        </span>
      ) : null}
    </>
  );
}

function BoxRow({ box, now, onOpen }: { box: FakeBox; now: number; onOpen: (id: string) => void }) {
  const { threads } = useStore();
  const view = box.view;
  const line = rowLine(box, now);
  const release = useReleaseDialog(box);
  const open = () => onOpen(view.id);
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    open();
  };
  const problem = box.operation?.error ?? (view.state === "failed" ? view.error : null);
  return (
    <div
      data-resource-row
      data-box-id={view.id}
      className={cn("group -mx-4 grid min-w-0 cursor-pointer grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-3 px-4 py-3 hover:bg-state-hover/40", view.state === "releasing" && !box.operation && "opacity-60")}
      onClick={(event) => {
        if (!onControl(event)) open();
      }}
    >
      <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
        <BoxGlyph />
      </span>
      <div className="min-w-0">
        <a href={boxHref(view.id)} data-row-link={view.id} onClick={follow} className="block min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <RowTitle name={view.name} os={systemName(view)} device={deviceModelOf(view)} badges={boxTitleBadges(view, false)} />
        </a>
        <RowLine line={line} />
        {problem ? <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-destructive-text">{problem}</p> : null}
        {box.owner === "yours" ? <ThreadChips threads={machineThreads(box, threads)} className="mt-1.5" /> : null}
      </div>
      <span data-row-action className="flex shrink-0 cursor-default items-center gap-0.5 self-center">
        <QuickActions box={box} />
        <BoxMenu box={box} onRelease={release.ask} />
        <a href={boxHref(view.id)} onClick={follow} tabIndex={-1} aria-hidden className="ml-0.5 flex size-7 items-center justify-center rounded-md text-subtle-foreground hover:bg-state-hover hover:text-foreground">
          <Icon name="ChevronRight" className="size-4" aria-hidden />
        </a>
      </span>
      {release.dialog}
    </div>
  );
}

function ThreadState({ thread, now }: { thread: FakeThread; now: number }) {
  if (thread.running) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <Icon name="Loading" className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
        Working
      </span>
    );
  }
  return <span className="shrink-0 text-xs text-subtle-foreground">Idle {shortSpan(now - thread.activeAt)}</span>;
}

function ThreadCard({ thread, rows, now, onOpen }: { thread: FakeThread; rows: readonly FakeBox[]; now: number; onOpen: (id: string) => void }) {
  const openThread = () => go({ page: "thread", id: thread.id });
  return (
    <section aria-label={thread.title} className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-3 pl-4 pr-3 pt-3">
        <button type="button" className="min-w-0 truncate rounded-sm text-left text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={openThread}>
          {thread.title}
        </button>
        <ThreadState thread={thread} now={now} />
        <span className="flex-1" />
        <IconButton label="Open thread" icon="ArrowUpRight" onClick={openThread} />
      </div>
      <div className="divide-y divide-border px-4 pb-1 [&>*:first-child]:pt-1">
        {rows.map((box) => (
          <BoxRow key={box.view.id} box={box} now={now} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

export function BoxesList({ opening }: { opening: Tab | null }) {
  const store = useStore();
  const { now } = store;
  const machines = store.boxes.filter((box) => box.owner === "yours");
  const threaded = store.boxes.filter((box) => box.owner === "thread");
  const [chosen, setChosen] = useState<Tab | null>(() => opening ?? keptTab());
  const tab: Tab = opening ?? chosen ?? (threaded.length ? "threads" : "machines");
  const kept = useRef<Kept>(keptLists.get(tab) ?? freshList());
  const [search, setSearch] = useState(kept.current.search);
  const [filters, setFilters] = useState<Filters>(kept.current.filters);
  const [sort, setSort] = useState<Sort>(kept.current.sort);
  const scroller = useRef<HTMLDivElement>(null);
  const choose = (next: Tab) => {
    setChosen(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      return;
    }
    go({ page: "list", tab: next }, { replace: true });
  };
  const titleOf = (id: string) => store.threads.find((thread) => thread.id === id)?.title ?? id;
  const listed = (tab === "machines" ? machines : threaded).map((box) => ({ box: box.view, fake: box, words: box.owner === "yours" ? machineThreads(box, store.threads).map((thread) => thread.title ?? "") : [titleOf(box.threadId)] }));
  const tabBoxes = listed.map((row) => row.box);
  const offered = choices(tabBoxes);
  const keptFilters = Object.fromEntries(TAG_GROUPS.map((group) => [group, filters[group].filter((value) => offered[group].includes(value))])) as unknown as Filters;
  const byActivity = sort.key === LAST_ACTIVE;
  const rows = shown(listed, search, keptFilters, byActivity ? { key: "name", ascending: true } : sort);
  if (byActivity) rows.sort((a, b) => (lastActive(b.fake, store.threads) - lastActive(a.fake, store.threads)) * (sort.ascending ? 1 : -1));
  const counts = tagCounts(listed, search, keptFilters);
  const narrowed = !!search.trim() || filtering(keptFilters);
  const groups = new Map<string, FakeBox[]>();
  for (const row of rows) groups.set(row.fake.threadId, [...(groups.get(row.fake.threadId) ?? []), row.fake]);
  const threadIds = new Set(threaded.map((box) => box.threadId));
  const order = rows.map((row) => row.box.id);

  useLayoutEffect(() => {
    const memory = kept.current;
    if (scroller.current) scroller.current.scrollTop = memory.scrollTop;
    if (!memory.openedId) return;
    const target = document.querySelector<HTMLElement>(`[data-row-link="${CSS.escape(memory.openedId)}"]`) ?? document.querySelectorAll<HTMLElement>("[data-row-link]")[Math.min(memory.openedIndex, order.length - 1)];
    target?.focus({ preventScroll: true });
    target?.closest("[data-resource-row]")?.scrollIntoView({ block: "nearest" });
  }, []);

  useEffect(() => {
    keptLists.set(tab, { ...kept.current, search, filters, sort });
  }, [tab, search, filters, sort]);

  const openBox = (id: string) => {
    keptLists.set(tab, { search, filters, sort, scrollTop: scroller.current?.scrollTop ?? 0, openedId: id, openedIndex: Math.max(0, order.indexOf(id)) });
    go({ page: "box", id }, { from: "list" });
  };

  return (
    <div className="mx-auto box-border flex h-full min-h-0 w-full max-w-5xl flex-col gap-5 px-4 pb-4 pt-3 md:px-5 md:pt-4">
      <p className="text-sm leading-5 text-muted-foreground">Computers for your threads, and machines of your own.</p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PageTabs
          tabs={[
            { id: "machines", label: "Machines", count: machines.length },
            { id: "threads", label: "Threads", count: threadIds.size },
          ]}
          selected={tab}
          onSelect={choose}
        />
        <div className="flex shrink-0 items-center gap-1.5">
          <IconButton label="BB Box settings" icon="Settings" className="size-8" onClick={() => go({ page: "settings", section: "" })} />
          <Button type="button" variant="secondary" size="sm" className="h-8" onClick={() => store.say("New box opens the form, as today.")}>
            <Icon name="Plus" className="size-4" aria-hidden />
            New box
          </Button>
        </div>
      </div>
      <div role="tabpanel" className="flex min-h-0 flex-1 flex-col gap-5">
        {listed.length ? <SearchRow search={search} onSearch={setSearch} filters={keptFilters} offered={offered} counts={counts} split={splitGroups(tabBoxes)} onFilters={setFilters} sort={sort} onSort={setSort} /> : null}
        <div
          ref={scroller}
          className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-24"
          onScroll={(event) => {
            const memory = keptLists.get(tab);
            if (memory) memory.scrollTop = event.currentTarget.scrollTop;
          }}
        >
          {tab === "machines" && !machines.length ? <EmptyPanel>You have no machines. New box adds one: a box of your own that shows in BB's machine list.</EmptyPanel> : null}
          {tab === "threads" && !threaded.length ? <EmptyPanel>No thread has a box.</EmptyPanel> : null}
          {narrowed && listed.length && !rows.length ? <EmptyPanel>No boxes match.</EmptyPanel> : null}
          {tab === "machines" && rows.length ? (
            <div className="overflow-hidden rounded-lg border border-border bg-card px-4 py-1">
              <div className="divide-y divide-border">
                {rows.map((row) => (
                  <BoxRow key={row.box.id} box={row.fake} now={now} onOpen={openBox} />
                ))}
              </div>
            </div>
          ) : null}
          {tab === "threads"
            ? [...groups].map(([threadId, boxes]) => {
                const thread = store.threads.find((each) => each.id === threadId);
                return thread ? <ThreadCard key={threadId} thread={thread} rows={boxes} now={now} onOpen={openBox} /> : null;
              })
            : null}
        </div>
      </div>
    </div>
  );
}
