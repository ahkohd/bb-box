import { experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { ThreadOnBox } from "../plugin/contract.ts";

export const SHOWN_CHIPS = 3;
export const SEARCH_FROM = 8;

const ONLY_WHERE_CHIPS_FIT = "@max-md:hidden";
const ONLY_WHERE_CHIPS_STACK = "@md:hidden";

const REPLY_PREFIX = /^\s*Replying to this earlier message in the conversation:\s*/i;

export function threadTitle(thread: ThreadOnBox): string {
  const title = (thread.title ?? "").replace(REPLY_PREFIX, "").replace(/^[\s>"“]+/, "").trim();
  return title || thread.id;
}

export function workingOnWords(threads: readonly ThreadOnBox[], boxName: string): string {
  const [only] = threads;
  if (threads.length === 1 && only) {
    return only.unchecked ? `bb-box could not ask BB whether ${only.title ? threadTitle(only) : "its thread"} is working on ${boxName}` : `${threadTitle(only)} is working on ${boxName}`;
  }
  return threads.some((thread) => thread.unchecked) ? `${threads.length} threads may be working on ${boxName}` : `${threads.length} threads are working on ${boxName}`;
}

export function byActivity(threads: readonly ThreadOnBox[]): ThreadOnBox[] {
  return [...threads].sort((a, b) => Number(b.running) - Number(a.running) || (b.activeAt ?? 0) - (a.activeAt ?? 0));
}

const CHIP = "inline-flex h-6 min-w-0 max-w-56 items-center gap-1 whitespace-nowrap rounded-full border border-border px-2 text-xs leading-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function WorkingMark() {
  return <Icon name="Loading" className="size-3 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-label="Working" />;
}

function ThreadChip({ thread, onOpen }: { thread: ThreadOnBox; onOpen: (id: string) => void }) {
  const title = threadTitle(thread);
  return (
    <button type="button" title={title} className={cn(CHIP, "bg-background text-foreground hover:bg-state-hover")} onClick={() => onOpen(thread.id)}>
      {thread.running ? <WorkingMark /> : null}
      <span className="min-w-0 truncate">{title}</span>
    </button>
  );
}

function matching(threads: readonly ThreadOnBox[], search: string): readonly ThreadOnBox[] {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  return threads.filter((thread) => terms.every((term) => threadTitle(thread).toLowerCase().includes(term)));
}

function MoreThreads({ threads, more, onOpen }: { threads: readonly ThreadOnBox[]; more: number; onOpen: (id: string) => void }) {
  const [search, setSearch] = useState("");
  const found = matching(threads, search);
  return (
    <Popover onOpenChange={(open) => (open ? null : setSearch(""))}>
      <PopoverTrigger asChild>
        <button type="button" className={cn(CHIP, "text-muted-foreground hover:bg-state-hover hover:text-foreground")} aria-label={`${more} more threads`}>
          +{more} more
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-1" mobileTitle={`${threads.length} threads`}>
        {threads.length >= SEARCH_FROM ? (
          <div className="relative p-1">
            <Icon name="Search" className="pointer-events-none absolute left-3.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input aria-label="Search threads" placeholder="Search threads" value={search} onChange={(event) => setSearch(event.target.value)} className="h-8 pl-8 text-sm" autoFocus />
          </div>
        ) : null}
        <ul className="max-h-72 overflow-y-auto" aria-label="All threads on this box">
          {found.map((thread) => {
            const title = threadTitle(thread);
            return (
              <li key={thread.id}>
                <button type="button" title={title} className="flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-foreground hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none" onClick={() => onOpen(thread.id)}>
                  {thread.running ? <WorkingMark /> : null}
                  <span className="min-w-0 truncate">{title}</span>
                </button>
              </li>
            );
          })}
          {!found.length ? <li className="px-2 py-1.5 text-sm text-muted-foreground">No thread matches.</li> : null}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

export function ThreadChips({ threads, className, onLeave }: { threads: readonly ThreadOnBox[]; className?: string; onLeave?: () => void }) {
  const navigate = useBbNavigate();
  const ordered = useMemo(() => byActivity(threads), [threads]);
  if (!ordered.length) return null;
  const shown = ordered.slice(0, SHOWN_CHIPS);
  const open = (id: string) => {
    onLeave?.();
    navigate.toThread(id);
  };
  return (
    <div className={cn("@container min-w-0", className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-1 @max-md:flex-nowrap" role="list" aria-label="Threads on this box">
        {shown.map((thread, index) => (
          <span key={thread.id} role="listitem" className={cn("flex min-w-0 max-w-full", index > 0 && ONLY_WHERE_CHIPS_FIT)}>
            <ThreadChip thread={thread} onOpen={open} />
          </span>
        ))}
        {ordered.length > 1 ? (
          <span className={cn("flex shrink-0", ONLY_WHERE_CHIPS_STACK)}>
            <MoreThreads threads={ordered} more={ordered.length - 1} onOpen={open} />
          </span>
        ) : null}
        {ordered.length > shown.length ? (
          <span className={cn("flex shrink-0", ONLY_WHERE_CHIPS_FIT)}>
            <MoreThreads threads={ordered} more={ordered.length - shown.length} onOpen={open} />
          </span>
        ) : null}
      </div>
    </div>
  );
}
