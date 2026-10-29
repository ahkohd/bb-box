// One box in the Box panel: its name, kind and status line, its details
// when open, its quick actions and its menu.

import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useState, type MouseEvent, type ReactNode } from "react";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { cn } from "@/lib/utils";
import type { BoxView } from "../plugin/views.ts";
import { deviceModelOf, IconButton, osName, relativeTime, RowTitle, boxTitleBadges, StatusLine, systemName } from "./common.tsx";
import { DESKTOP_PAGE, MACHINES_TAB, useOpenScreen } from "./desktop.tsx";
import { JoinHelp } from "./first-run.tsx";
import { enrolWords, startWords, statusOf, timingWords } from "./status.ts";
import { useOpenTerminal } from "./terminal.tsx";
import { BoxGlyph } from "./glyphs.tsx";
import { openActions, openableNow, type BoxOpens } from "./box-opens.tsx";
import { useResizeNote } from "./resize.tsx";
import { BoxMenu, type BoxAction } from "./box-menu.tsx";

/** The viewer IDs this browser tab holds, one per box, as the desktop tabs keep them. */
export function myViewers(): Set<string> {
  const mine = new Set<string>();
  try {
    for (let index = 0; index < window.sessionStorage.length; index++) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith("bb-box:viewer:")) mine.add(window.sessionStorage.getItem(key) ?? "");
    }
  } catch {
    // Storage may be off; then no viewer is known to be ours.
  }
  return mine;
}

/** True when the click landed on a control inside the row, which handles it itself. */
function onControl(event: MouseEvent<HTMLElement>): boolean {
  return event.target instanceof Element && event.target.closest("a, button, [data-row-action]") !== null;
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </>
  );
}

/** The box a thread runs on, when it is not the thread's own (036): yours, or another thread's. */
export interface Held {
  readonly owner: "yours" | "thread";
  readonly threadId: string | null;
  readonly threadTitle: string | null;
}

export function BoxRow({
  box,
  threadId,
  open,
  onToggle,
  act,
  now,
  held = null,
  opens,
  meta = [],
  extra = null,
  threading: offersThread = true,
}: {
  box: BoxView;
  threadId: string;
  open: boolean;
  onToggle: () => void;
  act: (method: BoxAction, box: BoxView) => Promise<void>;
  now: number;
  /** Set for the box this thread runs on (036): a "BB machine" badge among the others, no Release, Stop or Start, and a line saying where those are. */
  held?: Held | null;
  /** Where the desktop and terminal open, when not in this thread's panel tabs: the Boxes page opens them on the page. */
  opens?: BoxOpens;
  /** Last words on the status line, such as the Boxes page's who has control and thread title. */
  meta?: readonly (string | null)[];
  /** A quick action before the menu, such as the Boxes page's Open thread. */
  extra?: ReactNode;
  /** "New thread on this box…": a child of `threadId`'s thread. Off on the Boxes page, where "this thread" names none. */
  threading?: boolean;
}) {
  const navigate = useBbNavigate();
  const openInPanel = useOpenScreen(threadId);
  const terminalInPanel = useOpenTerminal();
  const openScreen = opens?.screen ?? openInPanel;
  const openTerminal = opens?.terminal ?? terminalInPanel;
  const [busy, setBusy] = useState<BoxAction | null>(null);
  const [resizing, setResizing] = useState(false);
  const resizeNote = useResizeNote(box, resizing);
  const run = async (method: BoxAction) => {
    setBusy(method);
    try {
      await act(method, box);
    } finally {
      setBusy(null);
    }
  };
  const status = statusOf(box, now, myViewers());
  const ready = box.state === "ready";
  const showsError = box.error !== null;
  const compact = useIsCompactViewport();
  const quickActions = [
    ...openableNow(openActions(box, { screen: openScreen, terminal: openTerminal })).map((action) => <IconButton key={action.key} label={action.words} icon={action.glyph()} onClick={action.open} />),
    ...(!held && box.canStopStart && box.state === "stopped" ? [<IconButton key="start" label="Start" icon="Play" onClick={() => void run("start")} loading={busy === "start"} disabled={busy !== null} />] : []),
    ...(!held && box.canStopStart && ready ? [<IconButton key="stop" label="Stop" icon="Square" onClick={() => void run("stop")} loading={busy === "stop"} disabled={busy !== null} />] : []),
  ];

  return (
    <div
      data-resource-row
      className={cn("group grid min-w-0 cursor-pointer grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-3 py-3", box.state === "releasing" && "opacity-60")}
      onClick={(event) => {
        if (!onControl(event)) onToggle();
      }}
    >
      <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
        <BoxGlyph />
      </span>
      <div className="min-w-0">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${box.name}: details`}
          onClick={onToggle}
          className="block w-full min-w-0 cursor-pointer rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {/* Each line stays one line in the panel's 560 px: the name and kind, then the state and what to act on. */}
          <RowTitle name={box.name} os={systemName(box)} device={deviceModelOf(box)} badges={boxTitleBadges(box, held !== null)} />
        </button>
        <StatusLine tone={status.tone} items={[...status.items, ...meta]} />
        {box.waitingOn ? <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{box.waitingOn}</p> : null}
        {showsError ? <p className="mt-0.5 text-xs leading-snug text-destructive-text">{box.error}</p> : null}
        {resizeNote ? <p className={cn("mt-0.5 text-xs leading-snug", resizeNote.failed ? "text-destructive-text" : "text-muted-foreground")}>{resizeNote.text}</p> : null}
        {ready && box.enrol.state === "failed" ? (
          <p className="mt-0.5 text-xs leading-snug text-warning-text">
            <JoinHelp words={box.enrol.error} />
          </p>
        ) : null}
        {box.stopped ? <p className="mt-0.5 text-xs leading-snug text-warning-text">{box.stopped}</p> : null}
        {held ? (
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
            {held.owner === "yours" ? (
              <>
                Remove or stop it on the{" "}
                <button type="button" className="text-foreground underline-offset-2 hover:underline" onClick={() => navigate.toPluginPanel(DESKTOP_PAGE, { subPath: MACHINES_TAB })}>
                  Boxes page, under Machines
                </button>
                .
              </>
            ) : (
              <>
                Held by{" "}
                {held.threadId ? (
                  <button type="button" className="text-foreground underline-offset-2 hover:underline" onClick={() => navigate.toThread(held.threadId!)}>
                    {held.threadTitle ?? held.threadId}
                  </button>
                ) : (
                  "another thread"
                )}
                .
              </>
            )}
          </p>
        ) : null}
        {open ? (
          <dl className="mt-2 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs leading-snug">
            {box.address ? <Detail label="Address">{box.address}</Detail> : null}
            {box.size ? <Detail label="Size">{box.size}</Detail> : null}
            {deviceModelOf(box) ? <Detail label="Device">{deviceModelOf(box)}</Detail> : null}
            <Detail label="Backend">{box.backendLabel}</Detail>
            <Detail label="System">
              {osName(box.os)} {box.arch}
              {box.extras.length ? `, with ${box.extras.join(", ")}` : ""}
            </Detail>
            {box.facts.map((fact) => (
              <Detail key={fact.label} label={fact.label}>
                {fact.value}
              </Detail>
            ))}
            <Detail label="BB machine">{enrolWords(box)}</Detail>
            {timingWords(box) ? <Detail label="Timings">{timingWords(box)}</Detail> : null}
            {startWords(box) ? <Detail label="Last start">{startWords(box)}</Detail> : null}
            <Detail label="Made">{relativeTime(box.createdAt, now)}</Detail>
          </dl>
        ) : null}
      </div>
      <span data-row-action className="flex shrink-0 cursor-default items-center gap-0.5">
        {compact ? quickActions.slice(0, 1) : quickActions}
        {extra}
        <BoxMenu box={box} of={{ owner: "thread", threadId, held: held !== null, offersThread, act: (method) => void run(method) }} opens={{ screen: openScreen, terminal: openTerminal }} resizing={resizing} onResizing={setResizing} />
      </span>
    </div>
  );
}
