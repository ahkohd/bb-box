import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { MachineEntry } from "../plugin/contract.ts";
import { BoxBadges, deviceModelOf, hasViewer, IconButton, Meta, OPERATOR, StatusDot, systemName } from "./common.tsx";
import { DESKTOP_PAGE, desktopSubPath } from "./desktop.tsx";
import { statusOf } from "./status.ts";
import { canOpenTerminal } from "./terminal.tsx";
import { BoxGlyph, MonitorGlyph, TerminalGlyph } from "./glyphs.tsx";
import { useResizeNote } from "./resize.tsx";
import { ThreadChips } from "./thread-chips.tsx";
import type { BoxOpens } from "./box-opens.tsx";
import { BoxMenu } from "./box-menu.tsx";

/**
 * One of your machines as a row: name, OS and badges, state and threads, and its actions. In settings its desktop and
 * terminal open with a way back to settings; on the Boxes page, back to the page, and its menu offers a browser tab too.
 */
export function MachineRow({ entry, now, busy, onStop, onStart, onRemove, from = "settings" }: { entry: MachineEntry; now: number; busy: string | null; onStop: () => void; onStart: () => void; onRemove: () => void; from?: "settings" | "boxes" }) {
  const { box, threads } = entry;
  const navigate = useBbNavigate();
  const status = statusOf(box, now);
  const ready = box.state === "ready";
  const back = from === "settings" ? "settings" : undefined;
  const opens: BoxOpens = {
    screen: (machine, screen) => navigate.toPluginPanel(DESKTOP_PAGE, { subPath: desktopSubPath(OPERATOR, machine.id, screen, back) }),
    terminal: (machine) => navigate.toPluginPanel(DESKTOP_PAGE, { subPath: desktopSubPath(OPERATOR, machine.id, "terminal", back) }),
  };
  const acting = busy !== null && busy.endsWith(`:${box.id}`);
  const [resizing, setResizing] = useState(false);
  const resizeNote = useResizeNote(box, resizing);
  return (
    // In settings' card, the first and last rows meet its own padding; on the Boxes page, in Automations' card, every row has the same
    // padding above and below, as Automations' rows do (the operator, 8 October 2026).
    <div data-resource-row className={cn("grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-3 py-3", from === "settings" && "first:pt-0 last:pb-0", box.state === "releasing" && "opacity-60")}>
      <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
        <BoxGlyph />
      </span>
      <div className="min-w-0">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{box.name}</span>
          <span className="min-w-0 truncate text-xs text-muted-foreground">{systemName(box)}</span>
          {deviceModelOf(box) ? <span className="min-w-0 truncate text-xs text-foreground">{deviceModelOf(box)}</span> : null}
          <BoxBadges box={box} />
        </span>
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
        <ThreadChips threads={threads} className="mt-1.5" />
        {box.error ? <p className="mt-0.5 text-xs leading-snug text-destructive-text">{box.error}</p> : null}
        {resizeNote ? <p className={cn("mt-0.5 text-xs leading-snug", resizeNote.failed ? "text-destructive-text" : "text-muted-foreground")}>{resizeNote.text}</p> : null}
      </div>
      <span data-row-action className="flex shrink-0 items-center gap-0.5">
        {hasViewer(box) && ready ? <IconButton label="Open desktop" icon={<MonitorGlyph />} onClick={() => opens.screen(box, "desktop")} /> : null}
        {canOpenTerminal(box) ? <IconButton label="Open terminal" icon={<TerminalGlyph />} onClick={() => opens.terminal(box)} /> : null}
        {box.canStopStart && box.state === "stopped" ? <IconButton label="Start" icon="Play" onClick={onStart} loading={busy === `start:${box.id}`} disabled={acting} /> : null}
        {box.canStopStart && ready ? <IconButton label="Stop" icon="Square" onClick={onStop} loading={busy === `stop:${box.id}`} disabled={acting} /> : null}
        <BoxMenu box={box} of={{ owner: "yours", inBrowser: from === "boxes", stop: onStop, start: onStart, remove: onRemove }} opens={opens} resizing={resizing} onResizing={setResizing} />
      </span>
    </div>
  );
}
