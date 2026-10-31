import { useState } from "react";
import { cn } from "@/lib/utils";
import type { MachineEntry } from "../plugin/contract.ts";
import { BoxBadges, deviceModelOf, hasViewer, IconButton, Meta, StatusDot, systemName } from "./common.tsx";
import { statusOf } from "./status.ts";
import { canOpenTerminal } from "./terminal.tsx";
import { BoxGlyph, MonitorGlyph, TerminalGlyph } from "./glyphs.tsx";
import { useResizeNote } from "./resize.tsx";
import { ThreadChips } from "./thread-chips.tsx";
import { BoxMenu } from "./box-menu.tsx";
import { releaseUnfinished, unreachableWhy } from "./box-words.ts";
import type { BoxOpens } from "./box-opens.tsx";
import type { PageLink } from "./box-nav.tsx";
import { openPageOnClick, PAGE_ROW, RowChevron, RowNameLink } from "./box-row.tsx";

/** One of your machines as a row on the Boxes page: name, OS and badges, state and threads, and its actions. */
export function MachineRow({
  entry,
  now,
  busy,
  opens,
  page,
  onLeave,
  onStop,
  onStart,
  onRemove,
  onForget,
}: {
  entry: MachineEntry;
  now: number;
  busy: string | null;
  opens: BoxOpens;
  page: PageLink;
  onLeave: () => void;
  onStop: () => void;
  onStart: () => void;
  onRemove: () => void;
  onForget: () => void;
}) {
  const { box, threads } = entry;
  const status = statusOf(box, now);
  const ready = box.state === "ready";
  const acting = busy !== null && busy.endsWith(`:${box.id}`);
  const stops = box.canStopStart && unreachableWhy(box) === null;
  const [resizing, setResizing] = useState(false);
  const resizeNote = useResizeNote(box, resizing);
  return (
    <div data-resource-row className={cn("grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-3 py-3", PAGE_ROW, box.state === "releasing" && !releaseUnfinished(box) && "opacity-60")} onClick={openPageOnClick(page)}>
      <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
        <BoxGlyph />
      </span>
      <div className="min-w-0">
        <RowNameLink box={box} page={page}>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 truncate text-sm text-foreground">{box.name}</span>
            <span className="min-w-0 truncate text-xs text-muted-foreground">{systemName(box)}</span>
            {deviceModelOf(box) ? <span className="min-w-0 truncate text-xs text-foreground">{deviceModelOf(box)}</span> : null}
            <BoxBadges box={box} />
          </span>
        </RowNameLink>
        <div className="mt-0.5 flex min-w-0 items-start gap-1.5 text-xs leading-snug text-muted-foreground">
          <StatusDot tone={status.tone} />
          <Meta
            items={[
              ...status.items.map((item, index) => (
                <span key={index} className={cn(item.tone === "fg" && "text-foreground", item.tone === "warn" && "text-warning-text", item.tone === "danger" && "text-destructive-text")}>
                  {item.text}
                </span>
              )),
            ]}
          />
        </div>
        <ThreadChips threads={threads} className="mt-1.5" onLeave={onLeave} />
        {box.error ? <p className="mt-0.5 text-xs leading-snug text-destructive-text">{box.error}</p> : null}
        {resizeNote ? <p className={cn("mt-0.5 text-xs leading-snug", resizeNote.failed ? "text-destructive-text" : "text-muted-foreground")}>{resizeNote.text}</p> : null}
      </div>
      <span data-row-action className="flex shrink-0 cursor-default items-center gap-0.5">
        {hasViewer(box) && ready ? <IconButton label="Open desktop" icon={<MonitorGlyph />} onClick={() => opens.screen(box, "desktop")} /> : null}
        {canOpenTerminal(box) ? <IconButton label="Open terminal" icon={<TerminalGlyph />} onClick={() => opens.terminal(box)} /> : null}
        {stops && box.state === "stopped" ? <IconButton label="Start" icon="Play" onClick={onStart} loading={busy === `start:${box.id}`} disabled={acting} /> : null}
        {stops && ready ? <IconButton label="Stop" icon="Square" onClick={onStop} loading={busy === `stop:${box.id}`} disabled={acting} /> : null}
        <BoxMenu box={box} of={{ owner: "yours", inBrowser: true, stop: onStop, start: onStart, remove: onRemove, forget: onForget }} opens={opens} resizing={resizing} onResizing={setResizing} />
        <RowChevron page={page} />
      </span>
    </div>
  );
}
