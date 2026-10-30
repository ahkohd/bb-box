import { useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Badge, EmptyPanel, IconButton, StatusDot } from "@/src/app/common.tsx";
import { BoxGlyph } from "@/src/app/glyphs.tsx";
import { PageTabs } from "@/src/app/boxes-toolbar.tsx";
import { DAY, type FakeBox, type FakeSnap } from "./data";
import { go, hrefOf, type Tab } from "./nav";
import { DeleteDialog, freesWords, KeepDialog, SnapshotRow } from "./snapshot-row";
import { useStore } from "./store";
import { day, money, plural, sizeWords, span } from "./words";

type SortKey = "newest" | "oldest" | "largest" | "price" | "box";

const SORT_WORDS: Readonly<Record<SortKey, string>> = { newest: "Newest", oldest: "Oldest", largest: "Largest", price: "Price", box: "Box name" };
const TOOL_BUTTON = "shrink-0 rounded-md text-muted-foreground size-8 p-0 border border-input bg-background select-none";

interface Filter {
  readonly key: string;
  readonly group: string;
  readonly words: string;
  readonly test: (snap: FakeSnap, box: FakeBox) => boolean;
}

function filtersFor(boxes: readonly FakeBox[], now: number): Filter[] {
  const places = [...new Set(boxes.filter((box) => box.snapshotting).map((box) => box.backendLabel))];
  return [
    ...places.map((place) => ({ key: `where:${place}`, group: "Where", words: place.replace(/^a /, ""), test: (_: FakeSnap, box: FakeBox) => box.backendLabel === place })),
    { key: "holds:disk", group: "Holds", words: "Disk", test: (snap) => snap.holds === "disk" },
    { key: "holds:memory", group: "Holds", words: "Disk and memory", test: (snap) => snap.holds === "disk-and-memory" },
    { key: "by:you", group: "Taken by", words: "You", test: (snap) => snap.by.is === "person" },
    { key: "by:agents", group: "Taken by", words: "Agents", test: (snap) => snap.by.is === "agent" },
    { key: "undo", group: "Kind", words: "Undos", test: (snap) => snap.undoOf !== null },
    { key: "kept:yes", group: "Kept", words: "Kept", test: (snap) => snap.keptUntil !== null },
    { key: "kept:no", group: "Kept", words: "Not kept", test: (snap) => snap.keptUntil === null },
    { key: "soon", group: "Goes", words: "Goes within 7 days", test: (snap) => snap.keptUntil !== null && snap.keptUntil - now <= 7 * DAY },
  ];
}

function passes(snap: FakeSnap, box: FakeBox, chosen: ReadonlySet<string>, all: readonly Filter[]): boolean {
  const groups = new Map<string, Filter[]>();
  for (const filter of all) if (chosen.has(filter.key)) groups.set(filter.group, [...(groups.get(filter.group) ?? []), filter]);
  return [...groups.values()].every((filters) => filters.some((filter) => filter.test(snap, box)));
}

function sorted(rows: { snap: FakeSnap; box: FakeBox }[], key: SortKey): { snap: FakeSnap; box: FakeBox }[] {
  const by: Record<SortKey, (a: { snap: FakeSnap; box: FakeBox }, b: { snap: FakeSnap; box: FakeBox }) => number> = {
    newest: (a, b) => b.snap.takenAt - a.snap.takenAt,
    oldest: (a, b) => a.snap.takenAt - b.snap.takenAt,
    largest: (a, b) => (b.snap.sizeGB ?? -1) - (a.snap.sizeGB ?? -1),
    price: (a, b) => (b.snap.price?.amount ?? 0) - (a.snap.price?.amount ?? 0),
    box: (a, b) => a.box.name.localeCompare(b.box.name) || b.snap.takenAt - a.snap.takenAt,
  };
  return [...rows].sort(by[key]);
}

function SummaryLine() {
  const store = useStore();
  const { snaps, boxes, now } = store;
  const counted = snaps.filter((snap) => snap.state !== "failed");
  const undoCount = counted.filter((snap) => snap.undoOf).length;
  const agents = counted.filter((snap) => snap.by.is === "agent").length;
  const byHost = new Map<string, number>();
  for (const snap of counted) {
    const box = boxes.find((each) => each.id === snap.boxId);
    if (box && (snap.heldCopyGB ?? snap.sizeGB) !== null) byHost.set(box.host, (byHost.get(box.host) ?? 0) + (snap.heldCopyGB ?? snap.sizeGB ?? 0));
  }
  const space = [...byHost.values()].reduce((sum, size) => sum + size, 0);
  const rate = store.rate();
  const soon = counted.filter((snap) => snap.keptUntil !== null && snap.keptUntil - now <= 7 * DAY).length;
  const cannot = [...new Set(boxes.filter((box) => box.cannotTakeWhy && box.state !== "released").map((box) => box.host))];
  const fullHosts = [...new Map(boxes.filter((box) => box.storage && box.storage.full >= store.settings.roomPercent).map((box) => [box.host, box.storage!.full])).entries()];
  const failed = snaps.filter((snap) => snap.state === "failed").length;
  const attention = [
    soon ? `${plural(soon, "snapshot goes", "snapshots go")} within 7 days` : null,
    failed ? `${plural(failed, "take")} failed` : null,
    ...cannot.map((host) => `${host} cannot take snapshots`),
    ...fullHosts.map(([host, full]) => `${host}'s storage is ${full}% full: new snapshots refused`),
    rate > store.settings.ceiling ? `boat.dev's ${money(rate)} a month held is past your ${money(store.settings.ceiling)} ceiling` : null,
  ].filter((item): item is string => item !== null);
  return (
    <div className="space-y-1 text-sm leading-5 text-muted-foreground">
      <p>
        {plural(counted.length - undoCount, "snapshot")}{undoCount ? ` and ${plural(undoCount, "undo")}` : ""}, {agents} by agents · {sizeWords(space)} on {plural(byHost.size, "host")}
        {rate > 0 ? ` · boat.dev ${money(rate)} a month held` : ""}
      </p>
      {attention.length ? (
        <p className="flex items-start gap-1.5 text-xs text-warning-text">
          <StatusDot tone="warn" />
          {attention.join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

function BoxHead({ box }: { box: FakeBox }) {
  const store = useStore();
  const thread = box.threadId ? store.threads.find((each) => each.id === box.threadId) : null;
  const released = box.state === "released";
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-4 pr-3 pt-3">
      <BoxGlyph className="size-4 text-muted-foreground" />
      {released ? (
        <span className="text-sm text-muted-foreground">{box.name}</span>
      ) : (
        <a href={hrefOf({ page: "box", id: box.id })} className="rounded-sm text-sm text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          {box.name}
        </a>
      )}
      <span className="text-xs text-muted-foreground">{box.os}</span>
      {box.badges.map((badge) => (
        <Badge key={badge}>{badge}</Badge>
      ))}
      <span className="text-xs text-subtle-foreground">
        · {box.backendLabel}
        {released ? ` · released ${day(box.releasedAt ?? store.now)}` : ""}
      </span>
      <span className="flex-1" />
      {thread ? (
        <a href={hrefOf({ page: "thread", id: thread.id })} className="max-w-64 truncate rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground">
          {thread.title} ↗
        </a>
      ) : (
        <span className="text-xs text-subtle-foreground">{released ? "Kept by you" : "Your machine"}</span>
      )}
    </div>
  );
}

function SnapshotsTab() {
  const store = useStore();
  const { now } = store;
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<SortKey>("newest");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [keeping, setKeeping] = useState(false);
  const all = filtersFor(store.boxes, now);
  const query = search.trim().toLowerCase();
  const rows = store.snaps
    .map((snap) => ({ snap, box: store.boxes.find((box) => box.id === snap.boxId)! }))
    .filter(({ box }) => !!box)
    .filter(({ snap, box }) => passes(snap, box, chosen, all))
    .filter(({ snap, box }) => !query || [snap.name, snap.note ?? "", box.name, store.threads.find((thread) => thread.id === box.threadId)?.title ?? ""].some((text) => text.toLowerCase().includes(query)));
  const ordered = sorted(rows, sort);
  const groups: { box: FakeBox; snaps: FakeSnap[] }[] = [];
  for (const row of ordered) {
    const group = groups.find((each) => each.box.id === row.box.id);
    if (group) group.snaps.push(row.snap);
    else groups.push({ box: row.box, snaps: [row.snap] });
  }
  const counts = (filter: Filter) => store.snaps.filter((snap) => {
    const box = store.boxes.find((each) => each.id === snap.boxId);
    return box ? filter.test(snap, box) : false;
  }).length;
  const toggle = (key: string, on: boolean) => setChosen((current) => {
    const next = new Set(current);
    if (on) next.add(key);
    else next.delete(key);
    return next;
  });
  const picked = store.snaps.filter((snap) => selected.has(snap.id));
  const none = store.boxes.filter((box) => !box.snapshotting && box.state !== "released");
  const doneSelecting = () => {
    setSelected(new Set());
    setSelecting(false);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <SummaryLine />
      <div className="flex w-full min-w-0 flex-wrap items-center gap-2">
        <form role="search" aria-label="Search snapshots" className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:flex-1" onSubmit={(event) => event.preventDefault()}>
          <div className="relative min-w-0 flex-1">
            <Icon name="Search" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input aria-label="Search snapshots" placeholder="Search snapshots" value={search} onChange={(event) => setSearch(event.target.value)} className="h-8 truncate pl-8 text-sm focus:border-ring/60 focus:ring-2 focus:ring-ring/20" />
          </div>
        </form>
        <div className="flex w-max shrink-0 items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" aria-label="Filters" className={cn(TOOL_BUTTON, chosen.size && "bg-state-active text-foreground")}>
                <Icon name="FilterHorizontal" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-max min-w-56 max-w-80">
              {[...new Set(all.map((filter) => filter.group))].map((group, index) => (
                <div key={group}>
                  {index ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuLabel className="font-normal text-subtle-foreground">{group}</DropdownMenuLabel>
                  {all
                    .filter((filter) => filter.group === group)
                    .map((filter) => (
                      <DropdownMenuCheckboxItem key={filter.key} checked={chosen.has(filter.key)} disabled={!counts(filter) && !chosen.has(filter.key)} className="whitespace-nowrap pr-10" onSelect={(event) => event.preventDefault()} onCheckedChange={(on) => toggle(filter.key, on === true)}>
                        <span className="flex-1">{filter.words}</span>
                        <span className="ml-3 text-2xs tabular-nums text-subtle-foreground">{counts(filter)}</span>
                      </DropdownMenuCheckboxItem>
                    ))}
                </div>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" aria-label={`Sort: ${SORT_WORDS[sort]}`} className={TOOL_BUTTON}>
                <Icon name="ArrowUpDown" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-max min-w-40">
              <DropdownMenuLabel className="font-normal text-subtle-foreground">Sort by</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={sort} onValueChange={(value) => setSort(value as SortKey)}>
                {(Object.keys(SORT_WORDS) as SortKey[]).map((key) => (
                  <DropdownMenuRadioItem key={key} value={key}>
                    {SORT_WORDS[key]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button type="button" variant="ghost" aria-pressed={selecting} className={cn("h-8 rounded-md border border-input bg-background px-2.5 text-xs text-muted-foreground", selecting && "bg-state-active text-foreground")} onClick={() => (selecting ? doneSelecting() : setSelecting(true))}>
            {selecting ? "Done" : "Select"}
          </Button>
        </div>
      </div>
      {selecting ? (
        <div role="toolbar" aria-label="Selected snapshots" className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-raised px-3 py-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">
            {picked.length ? `${plural(picked.length, "snapshot")} selected. ${freesWords(picked, store.boxes)}` : "Tick snapshots to keep or delete them together."}
          </span>
          <Button type="button" variant="outline" size="sm" className="h-7" disabled={!picked.length} onClick={() => setKeeping(true)}>
            Keep…
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-7 text-destructive-text" disabled={!picked.length} onClick={() => setDeleting(true)}>
            Delete…
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-24">
        {!store.snaps.length ? <EmptyPanel>No snapshots yet. An agent takes one before a risky change, or take one from a box's page.</EmptyPanel> : null}
        {store.snaps.length && !groups.length ? <EmptyPanel>No snapshots match.</EmptyPanel> : null}
        {groups.map(({ box, snaps }) => (
          <section key={box.id} aria-label={`${box.name}'s snapshots`} className="overflow-hidden rounded-lg border border-border bg-card">
            <BoxHead box={box} />
            <div className="divide-y divide-border px-4">
              {snaps.map((snap) => (
                <SnapshotRow
                  key={snap.id}
                  snap={snap}
                  box={box}
                  byThread={false}
                  selecting={selecting}
                  selected={selected.has(snap.id)}
                  onSelected={(on) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (on) next.add(snap.id);
                      else next.delete(snap.id);
                      return next;
                    })
                  }
                />
              ))}
            </div>
            {box.state === "released" ? <p className="border-t border-border px-4 py-2 text-xs text-subtle-foreground">Holds files and access from its thread. A fork of it gets your access, never the thread's.</p> : null}
          </section>
        ))}
        {none.length && !query && !chosen.size ? (
          <p className="px-1 text-xs leading-snug text-subtle-foreground">
            No snapshots on {none.map((box) => box.name).join(" and ")}: {[...new Set(none.map((box) => box.backendLabel.replace(/ on .*$/, "")))].join(" and ")} {none.length === 1 ? "has" : "have"} none.
          </p>
        ) : null}
      </div>
      {deleting ? <DeleteDialog boxes={store.boxes} snaps={picked} onClose={() => setDeleting(false)} onDone={doneSelecting} /> : null}
      {keeping ? <KeepDialog box={null} snaps={picked} onClose={() => setKeeping(false)} onDone={doneSelecting} /> : null}
    </div>
  );
}

function BoxesTab({ tab }: { tab: "machines" | "threads" }) {
  const store = useStore();
  const shown = store.boxes.filter((box) => box.state !== "released" && (tab === "machines" ? box.threadId === null : box.threadId !== null));
  return (
    <div className="space-y-3">
      <p className="text-xs text-subtle-foreground">A stand-in for decision 069's list. Open a box for its Snapshots card.</p>
      <div className="overflow-hidden rounded-lg border border-border bg-card px-4">
        <div className="divide-y divide-border">
          {shown.map((box) => {
            const count = store.snaps.filter((snap) => snap.boxId === box.id && snap.state !== "failed").length;
            return (
              <a key={box.id} href={hrefOf({ page: "box", id: box.id })} className="-mx-4 flex items-center gap-3 px-4 py-3 hover:bg-state-hover/40">
                <BoxGlyph className="size-4 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="text-sm text-foreground">{box.name}</span> <span className="text-xs text-muted-foreground">{box.os}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <StatusDot tone={box.state === "ready" ? "ok" : "busy"} />
                    {box.state === "ready" ? `Ready · up ${span(store.now - box.createdAt)}` : box.step}
                    {box.snapshotting ? ` · ${plural(count, "snapshot")}` : ""}
                  </span>
                </span>
                <Icon name="ChevronRight" className="size-4 text-subtle-foreground" aria-hidden />
              </a>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function BoxesList({ tab }: { tab: Tab }) {
  const store = useStore();
  const machines = store.boxes.filter((box) => box.threadId === null && box.state !== "released").length;
  const threads = new Set(store.boxes.filter((box) => box.threadId && box.state !== "released").map((box) => box.threadId)).size;
  const snapshots = store.snaps.filter((snap) => snap.state !== "failed").length;
  return (
    <div className="mx-auto box-border flex h-full min-h-0 w-full max-w-5xl flex-col gap-5 px-4 pb-4 pt-3 md:px-5 md:pt-4">
      <p className="text-sm leading-5 text-muted-foreground">Computers for your threads, and machines of your own.</p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PageTabs
          tabs={[
            { id: "machines" as Tab, label: "Machines", count: machines },
            { id: "threads" as Tab, label: "Threads", count: threads },
            { id: "snapshots" as Tab, label: "Snapshots", count: snapshots },
          ]}
          selected={tab}
          onSelect={(next) => go({ page: "list", tab: next }, { replace: true })}
        />
        <div className="flex shrink-0 items-center gap-1.5">
          <IconButton label="BB Box settings" icon="Settings" className="size-8" onClick={() => go({ page: "settings", section: "" })} />
          <Button type="button" variant="secondary" size="sm" className="h-8" onClick={() => store.say("New box opens the form, as today.")}>
            <Icon name="Plus" className="size-4" aria-hidden />
            New box
          </Button>
        </div>
      </div>
      <div role="tabpanel" className="flex min-h-0 flex-1 flex-col">
        {tab === "snapshots" ? <SnapshotsTab /> : <BoxesTab tab={tab} />}
      </div>
    </div>
  );
}
