import { experimental_Icon as Icon, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertDialogCancel, AlertDialogDescription } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { BulkCheck, BulkDone, BulkItem, Contract, SnapshotRowView, SnapshotsTabView, TabGroup, TabRow } from "../plugin/contract.ts";
import { Badge, EmptyPanel, message, StatusDot } from "./common.tsx";
import { useThreadTitles } from "./desktop.tsx";
import { useBoxesNav } from "./box-nav.tsx";
import { Refused, Shell, SnapshotRow, type RowPlace } from "./snapshots-card.tsx";
import { gbWords, holdsWords, keepDay, snapshotDay, utcDate } from "./snapshot-words.ts";

const DAY_MS = 24 * 60 * 60_000;
const TOOL_BUTTON = "shrink-0 rounded-md text-muted-foreground size-8 p-0 border border-input bg-background select-none";

export const SNAPSHOT_SORTS = { newest: "Newest", oldest: "Oldest", largest: "Largest", price: "Price", box: "Box name" } as const;
export type SnapshotSort = keyof typeof SNAPSHOT_SORTS;

export const FILTER_GROUPS = ["where", "holds", "by", "kept", "undos", "soon"] as const;
export type FilterGroup = (typeof FILTER_GROUPS)[number];
const FILTER_LABELS: Readonly<Record<FilterGroup, string>> = { where: "Where", holds: "Holds", by: "Taken by", kept: "Kept", undos: "Undos", soon: "Goes within 7 days" };

export type SnapshotFilters = Readonly<Record<FilterGroup, readonly string[]>>;

const NO_FILTERS: SnapshotFilters = { where: [], holds: [], by: [], kept: [], undos: [], soon: [] };

interface Place {
  search: string;
  filters: SnapshotFilters;
  sort: SnapshotSort;
  top: number;
}

const place: Place = { search: "", filters: NO_FILTERS, sort: "newest", top: 0 };

function valuesOf(row: SnapshotRowView, group: TabGroup, now: number): Record<FilterGroup, readonly string[]> {
  return {
    where: [`${group.box.backend}${group.box.host && !group.box.backend.includes(group.box.host) ? ` on ${group.box.host}` : ""}`],
    holds: [holdsWords(row.holds, row.scope)],
    by: [row.by.is === "agent" ? "Agents" : row.by.is === "person" ? "You" : "Others"],
    kept: row.keptUntil !== null ? ["Kept"] : [],
    undos: row.undoOf ? ["Undos"] : [],
    soon: row.keptUntil !== null && row.keptUntil - now < 7 * DAY_MS ? ["Goes within 7 days"] : [],
  };
}

export function matches(row: SnapshotRowView, group: TabGroup, search: string, filters: SnapshotFilters, title: string | null, now: number): boolean {
  const words = search.trim().toLowerCase();
  if (words && ![row.name, row.note ?? "", group.box.name, title ?? ""].some((text) => text.toLowerCase().includes(words))) return false;
  const values = valuesOf(row, group, now);
  return FILTER_GROUPS.every((key) => !filters[key].length || filters[key].some((value) => values[key].includes(value)));
}

function sortRows(rows: readonly { row: TabRow; group: TabGroup }[], sort: SnapshotSort): { row: TabRow; group: TabGroup }[] {
  const size = (row: TabRow) => row.size?.bytes ?? -1;
  const price = (row: TabRow) => (row.price?.known ? row.price.amount : -1);
  return [...rows].sort((a, b) => {
    switch (sort) {
      case "newest":
        return b.row.takenAt - a.row.takenAt;
      case "oldest":
        return a.row.takenAt - b.row.takenAt;
      case "largest":
        return size(b.row) - size(a.row) || b.row.takenAt - a.row.takenAt;
      case "price":
        return price(b.row) - price(a.row) || b.row.takenAt - a.row.takenAt;
      case "box":
        return a.group.box.name.localeCompare(b.group.box.name) || b.row.takenAt - a.row.takenAt;
    }
  });
}

export function tabLineWords(view: SnapshotsTabView): string {
  const line = view.line;
  const total = `${line.count} ${line.count === 1 ? "snapshot" : "snapshots"}${line.undos ? ` and ${line.undos} ${line.undos === 1 ? "undo" : "undos"}` : ""}${line.byAgents ? `, ${line.byAgents} by agents` : ""}`;
  const known = line.hosts.reduce((sum, host) => sum + host.bytes, 0);
  const hosts = line.hosts.length ? `${known ? gbWords(known) : "an unknown size"}${known && line.hosts.some((host) => host.unknown) ? " and more" : ""} on ${line.hosts.length === 1 ? line.hosts[0]!.host : `${line.hosts.length} hosts`}` : null;
  return [total, hosts, ...line.paid].filter(Boolean).join(" · ");
}

function FilterMenu({ filters, offered, counts, onChange }: { filters: SnapshotFilters; offered: SnapshotFilters; counts: Readonly<Record<string, number>>; onChange: (next: SnapshotFilters) => void }) {
  const filtering = FILTER_GROUPS.some((key) => filters[key].length);
  const sections = FILTER_GROUPS.filter((key) => offered[key].length);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" aria-label="Filters" className={cn(TOOL_BUTTON, filtering && "bg-state-active text-foreground")} disabled={!sections.length}>
          <Icon name="FilterHorizontal" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-max min-w-56 max-w-80" mobileTitle="Filters">
        {sections.map((key, index) => (
          <div key={key}>
            {index ? <DropdownMenuSeparator /> : null}
            {offered[key].length > 1 || (key !== "kept" && key !== "undos" && key !== "soon") ? <DropdownMenuLabel className="font-normal text-subtle-foreground">{FILTER_LABELS[key]}</DropdownMenuLabel> : null}
            {offered[key].map((value) => {
              const checked = filters[key].includes(value);
              return (
                <DropdownMenuCheckboxItem
                  key={value}
                  checked={checked}
                  className="justify-between gap-4 whitespace-nowrap pr-10"
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={(on) => onChange({ ...filters, [key]: on === true ? [...filters[key], value] : filters[key].filter((each) => each !== value) })}
                >
                  {value}
                  <span className="text-xs text-subtle-foreground">{counts[`${key}:${value}`] ?? 0}</span>
                </DropdownMenuCheckboxItem>
              );
            })}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BulkDialog({ ids, change, keepDays, now, onClose, onDone }: { ids: readonly string[]; change: "keep" | "delete"; keepDays: number; now: number; onClose: () => void; onDone: () => void }) {
  const rpc = useRpc<Contract>();
  const [until, setUntil] = useState(() => utcDate(now + keepDays * DAY_MS));
  const [check, setCheck] = useState<(BulkCheck & { readonly until: string }) | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<BulkDone | null>(null);
  const describedBy = useId();
  const dated = /^\d{4}-\d{2}-\d{2}$/.test(until);
  useEffect(() => {
    if (change === "keep" && !dated) return;
    let cancelled = false;
    void rpc
      .call("snapshots.bulkCheck", { snapshots: [...ids], change, ...(change === "keep" ? { until } : {}) })
      .then((answer) => {
        if (!cancelled) setCheck({ ...answer, until });
      })
      .catch((error: unknown) => {
        if (!cancelled) setProblem(message(error));
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, ids, change, until, dated]);
  const current = check && check.until === until ? check : null;
  const count = current?.allowed.length ?? 0;
  const apply = async () => {
    if (!current) return;
    setSending(true);
    try {
      const done = await rpc.call("snapshots.bulk", { snapshots: current.allowed.map((each) => each.id), change, ...(change === "keep" ? { until } : {}) });
      onDone();
      if (done.refused.length) setResult(done);
      else onClose();
    } catch (error) {
      setProblem(message(error));
    } finally {
      setSending(false);
    }
  };
  const list = (items: readonly BulkItem[]) => (
    <ul className="max-h-48 space-y-1 overflow-y-auto pl-0">
      {items.map((each) => (
        <li key={each.id} className="text-xs leading-snug">
          <span className="text-foreground">
            "{each.name}"{each.box ? ` of ${each.box}` : ""}
          </span>
          : {each.words}
        </li>
      ))}
    </ul>
  );
  const title = change === "keep" ? `Keep ${ids.length === 1 ? "1 snapshot" : `${ids.length} snapshots`}` : `Delete ${ids.length === 1 ? "1 snapshot" : `${ids.length} snapshots`}?`;
  return (
    <Shell
      title={title}
      onClose={onClose}
      footer={
        result ? (
          <AlertDialogCancel autoFocus>Close</AlertDialogCancel>
        ) : (
          <>
            <AlertDialogCancel autoFocus={change === "delete"} disabled={sending}>
              Cancel
            </AlertDialogCancel>
            <Button type="button" variant={change === "delete" ? "destructive" : "default"} disabled={sending || !count} onClick={() => void apply()}>
              {sending ? (change === "keep" ? "Keeping…" : "Deleting…") : change === "keep" ? `Keep ${count} until ${dated ? keepDay(Date.parse(`${until}T12:00:00Z`)) : "…"}` : `Delete ${count}`}
            </Button>
          </>
        )
      }
    >
      {change === "keep" && !result ? (
        <label className="block space-y-1">
          <span className="text-xs text-foreground">Keep them until the end of</span>
          <Input type="date" value={until} onChange={(event) => setUntil(event.target.value)} className="h-8 w-44" data-first-focus aria-describedby={describedBy} />
        </label>
      ) : null}
      <AlertDialogDescription id={describedBy} asChild>
        <div className="space-y-3 text-xs leading-snug text-muted-foreground">
          {result ? (
            <>
              <p>{result.done.length ? `${result.done.length} done. ` : ""}These were refused at the moment of the change:</p>
              {list(result.refused)}
            </>
          ) : current ? (
            <>
              {current.allowed.length ? (
                <div className="space-y-1">
                  <p className="text-foreground">{change === "keep" ? "Each is kept on its own backend, at its own cost:" : "Each is deleted on its own backend:"}</p>
                  {list(current.allowed)}
                </div>
              ) : null}
              {current.skipped.length ? (
                <div className="space-y-1">
                  <p className="text-warning-text">Skipped, and why:</p>
                  {list(current.skipped)}
                </div>
              ) : null}
              {change === "delete" && current.allowed.length ? <p>It cannot be undone.</p> : null}
            </>
          ) : (
            <p role="status">Checking each snapshot…</p>
          )}
        </div>
      </AlertDialogDescription>
      <Refused words={problem} />
    </Shell>
  );
}

function systemWords(system: string): string {
  return system === "linux" ? "Linux" : system === "windows" ? "Windows" : system === "macos" ? "macOS" : system;
}

function GroupHead({ group, title, onThread }: { group: TabGroup; title: string | null; onThread: () => void }) {
  const nav = useBoxesNav();
  const box = group.box;
  const where = `${box.backend}`;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-4 pr-3 pt-3">
      {box.gone ? (
        <span className="min-w-0 truncate text-sm text-foreground">{box.name}</span>
      ) : (
        <button type="button" className="min-w-0 truncate rounded-sm text-left text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => nav.go({ page: "box", boxId: box.id, origins: ["from-list"] })}>
          {box.name}
        </button>
      )}
      <Badge>{systemWords(box.system)}</Badge>
      {box.kindLabel && box.kindLabel !== systemWords(box.system) ? <Badge>{box.kindLabel}</Badge> : null}
      <span className="min-w-0 truncate text-xs text-muted-foreground">
        {where}
        {box.gone ? ` · ${box.gone.how === "unknown" ? "gone" : box.gone.how} ${snapshotDay(box.gone.at)}` : ""}
      </span>
      <span className="ml-auto flex shrink-0 items-center">
        {box.yours ? (
          <span className="text-xs text-muted-foreground">Your machine</span>
        ) : (
          <button type="button" className="inline-flex max-w-56 items-center gap-1 truncate rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={onThread}>
            <span className="truncate">{title ?? box.threadId}</span>
            <Icon name="ArrowUpRight" className="size-3" aria-hidden />
          </button>
        )}
      </span>
    </div>
  );
}

export function SnapshotsTabPanel({ view, now, onChanged, scroller }: { view: SnapshotsTabView; now: number; onChanged: () => void; scroller: (node: ReactNode) => ReactNode }) {
  const navigate = useBbNavigate();
  const [search, setSearch] = useState(place.search);
  const [filters, setFilters] = useState<SnapshotFilters>(place.filters);
  const [sort, setSort] = useState<SnapshotSort>(place.sort);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulk, setBulk] = useState<"keep" | "delete" | null>(null);
  const selectButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    place.search = search;
    place.filters = filters;
    place.sort = sort;
  }, [search, filters, sort]);
  const threadIds = [...new Set(view.groups.filter((group) => !group.box.yours).map((group) => group.box.threadId))];
  const titles = useThreadTitles(threadIds);
  const agentThreads = useThreadTitles([...new Set(view.groups.flatMap((group) => group.rows.flatMap((row) => (row.by.is === "agent" ? [row.by.threadId] : []))))]);
  const all = useMemo(() => view.groups.flatMap((group) => group.rows.map((row) => ({ row, group }))), [view]);
  const offered = useMemo(() => {
    const seen: Record<FilterGroup, Set<string>> = { where: new Set(), holds: new Set(), by: new Set(), kept: new Set(), undos: new Set(), soon: new Set() };
    for (const { row, group } of all) for (const key of FILTER_GROUPS) for (const value of valuesOf(row, group, now)[key]) seen[key].add(value);
    return Object.fromEntries(FILTER_GROUPS.map((key) => [key, [...seen[key]].sort()])) as unknown as SnapshotFilters;
  }, [all, now]);
  const kept = Object.fromEntries(FILTER_GROUPS.map((key) => [key, filters[key].filter((value) => offered[key].includes(value))])) as unknown as SnapshotFilters;
  const shown = sortRows(
    all.filter(({ row, group }) => matches(row, group, search, kept, group.box.yours ? null : (titles[group.box.threadId] ?? null), now)),
    sort,
  );
  const counts: Record<string, number> = {};
  for (const { row, group } of all.filter(({ row, group }) => matches(row, group, search, NO_FILTERS, group.box.yours ? null : (titles[group.box.threadId] ?? null), now))) {
    for (const key of FILTER_GROUPS) for (const value of valuesOf(row, group, now)[key]) counts[`${key}:${value}`] = (counts[`${key}:${value}`] ?? 0) + 1;
  }
  const groups: { group: TabGroup; rows: TabRow[] }[] = [];
  for (const { row, group } of shown) {
    const last = groups.find((each) => each.group.box.id === group.box.id);
    if (last) last.rows.push(row);
    else groups.push({ group, rows: [row] });
  }
  const live = new Set(all.map(({ row }) => row.id));
  const chosen = [...selected].filter((id) => live.has(id));
  const narrowed = !!search.trim() || FILTER_GROUPS.some((key) => kept[key].length);
  const toggle = (id: string, on: boolean) => setSelected((current) => new Set(on ? [...current, id] : [...current].filter((each) => each !== id)));
  const placeOf = (group: TabGroup): RowPlace => ({
    box: { id: group.box.id, name: group.box.name },
    restores: group.box.restores,
    forks: group.box.forks,
    screen: group.box.screen,
    perBox: group.box.perBox,
    keepDays: view.keepDays,
    wide: true,
    restoreWhy: (row) => (row as TabRow).restoreWhy,
    forkWhy: (row) => (group.box.restoring ? `${group.box.name} is being restored` : row.forkWhy),
  });
  const soonAttention = view.line.attention;
  return (
    <>
      <div className="space-y-1 text-xs leading-snug">
        <p className="text-muted-foreground">{tabLineWords(view)}</p>
        {soonAttention.length ? (
          <p className="flex items-start gap-1.5 text-warning-text">
            <StatusDot tone="warn" />
            <span className="min-w-0">{soonAttention.join(" · ")}</span>
          </p>
        ) : null}
      </div>
      {all.length ? (
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2">
          <form role="search" aria-label="Search snapshots" className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:flex-1" onSubmit={(event) => event.preventDefault()}>
            <div className="relative min-w-0 flex-1">
              <Icon name="Search" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                aria-label="Search snapshots"
                placeholder="Search snapshots"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && search) {
                    event.stopPropagation();
                    setSearch("");
                  }
                }}
                className="h-8 truncate pl-8 text-sm focus:border-ring/60 focus:ring-2 focus:ring-ring/20 focus-visible:ring-2 focus-visible:ring-ring/20"
              />
            </div>
          </form>
          <div className="flex w-max shrink-0 items-center gap-1.5">
            <FilterMenu filters={kept} offered={offered} counts={counts} onChange={setFilters} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" aria-label={`Sort: ${SNAPSHOT_SORTS[sort]}`} className={TOOL_BUTTON}>
                  <Icon name="ArrowUpDown" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-40" mobileTitle="Sort">
                <DropdownMenuLabel className="font-normal text-subtle-foreground">Sort</DropdownMenuLabel>
                {(Object.keys(SNAPSHOT_SORTS) as SnapshotSort[]).map((key) => (
                  <DropdownMenuItem key={key} className="justify-between gap-4" onSelect={() => setSort(key)}>
                    {SNAPSHOT_SORTS[key]}
                    {key === sort ? <Icon name="Check" className="size-3.5 text-muted-foreground" aria-hidden /> : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              ref={selectButton}
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              aria-pressed={selecting}
              onClick={() => {
                setSelecting((on) => !on);
                setSelected(new Set());
              }}
            >
              {selecting ? "Done" : "Select"}
            </Button>
          </div>
        </div>
      ) : null}
      {selecting ? (
        <div role="toolbar" aria-label="Selected snapshots" className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
          <span className="text-muted-foreground" aria-live="polite">
            {chosen.length ? `${chosen.length} selected` : "Tick snapshots to keep or delete them together."}
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <Button type="button" variant="ghost" size="sm" className="h-7" disabled={!shown.length} onClick={() => setSelected(new Set(shown.map(({ row }) => row.id)))}>
              Select all shown
            </Button>
            <Button type="button" variant="outline" size="sm" className="h-7" disabled={!chosen.length} onClick={() => setBulk("keep")}>
              Keep…
            </Button>
            <Button type="button" variant="outline" size="sm" className="h-7 text-destructive-text" disabled={!chosen.length} onClick={() => setBulk("delete")}>
              Delete…
            </Button>
          </span>
        </div>
      ) : null}
      {scroller(
        <>
          {!all.length ? (
            <EmptyPanel>
              No snapshots yet. An agent takes one before a risky change, or take one from a box's page.
              {view.none.length ? <span className="mt-1 block text-subtle-foreground">{view.none.join(", ")} take none.</span> : null}
            </EmptyPanel>
          ) : null}
          {narrowed && all.length && !shown.length ? <EmptyPanel>No snapshots match.</EmptyPanel> : null}
          {groups.map(({ group, rows }) => (
            <section key={group.box.id} aria-label={`${group.box.name}'s snapshots`} className="overflow-hidden rounded-lg border border-border bg-card">
              <GroupHead group={group} title={titles[group.box.threadId] ?? null} onThread={() => navigate.toThread(group.box.threadId)} />
              <ul className="divide-y divide-border px-4">
                {rows.map((row) => (
                  <SnapshotRow
                    key={row.id}
                    place={placeOf(group)}
                    row={row}
                    now={now}
                    titles={agentThreads}
                    onChanged={onChanged}
                    onDeleted={(id) => toggle(id, false)}
                    select={selecting ? { checked: selected.has(row.id), onChange: (on) => toggle(row.id, on) } : null}
                  />
                ))}
              </ul>
            </section>
          ))}
        </>,
      )}
      {bulk ? (
        <BulkDialog
          ids={chosen}
          change={bulk}
          keepDays={view.keepDays}
          now={now}
          onClose={() => {
            setBulk(null);
            window.setTimeout(() => selectButton.current?.focus(), 0);
          }}
          onDone={() => {
            setSelected(new Set());
            onChanged();
          }}
        />
      ) : null}
    </>
  );
}
