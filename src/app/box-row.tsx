// One box in the Box panel: its name, kind and status line, its details
// when open, its quick actions and its menu.

import { experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useId, useState, type MouseEvent, type ReactNode } from "react";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { cn } from "@/lib/utils";
import type { BoxView } from "../plugin/views.ts";
import { deviceModelOf, IconButton, osName, relativeTime, RowTitle, boxTitleBadges, StatusLine, systemName } from "./common.tsx";
import { DESKTOP_PAGE, MACHINES_TAB, useOpenScreen } from "./desktop.tsx";
import { JoinHelp, joinAdvice } from "./first-run.tsx";
import { enrolWords, startWords, statusOf, timingWords } from "./status.ts";
import { useOpenTerminal } from "./terminal.tsx";
import { BoxGlyph } from "./glyphs.tsx";
import { openActions, openableNow, type BoxOpens } from "./box-opens.tsx";
import { useResizeNote } from "./resize.tsx";
import { BoxMenu, type BoxAction } from "./box-menu.tsx";
import { releaseUnfinished, unreachableWhy } from "./box-words.ts";
import { followPageLink, type PageLink } from "./box-nav.tsx";
import { ROW_NAME } from "./list-place.ts";
import type { Busy } from "../monitor/busy.ts";
import { rowLine } from "./row-line.ts";
import { rowDescribedBy, RowStatus, useNameFocus } from "./row-status.tsx";

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
  if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return true;
  return event.target instanceof Element && event.target.closest("a, button, [data-row-action]") !== null;
}

function selectingText(): boolean {
  return (window.getSelection?.()?.toString() ?? "") !== "";
}

export type RowOpening = { readonly details: boolean; readonly toggle: () => void } | { readonly page: PageLink };

export const PAGE_ROW = "group -mx-4 cursor-pointer px-4 transition-colors duration-150 hover:bg-state-hover/40 has-[[data-state=open]]:bg-state-hover/40";

export function openPageOnClick(page: PageLink): (event: MouseEvent<HTMLElement>) => void {
  return (event) => {
    if (!onControl(event) && !selectingText()) page.go();
  };
}

export function RowChevron({ page }: { page: PageLink }) {
  return (
    <a href={page.href} tabIndex={-1} aria-hidden onClick={followPageLink(page)} className="ml-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-subtle-foreground transition-colors duration-150 hover:bg-state-hover hover:text-foreground group-hover:text-muted-foreground">
      <Icon name="ChevronRight" className="size-4" aria-hidden />
    </a>
  );
}

export function RowNameLink({ box, page, describedBy, focus, children }: { box: Pick<BoxView, "id" | "name">; page: PageLink; describedBy?: string; focus?: Pick<ReturnType<typeof useNameFocus>, "onFocus" | "onBlur">; children: ReactNode }) {
  return (
    <a href={page.href} aria-label={box.name} aria-describedby={describedBy} onFocus={focus?.onFocus} onBlur={focus?.onBlur} {...{ [ROW_NAME]: box.id }} onClick={followPageLink(page)} className="block min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
      {children}
    </a>
  );
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
  opening,
  act,
  now,
  held = null,
  opens,
  meta = [],
  busy: busyNow = null,
  extra = null,
  threading: offersThread = true,
  onBoxesPage,
}: {
  box: BoxView;
  threadId: string;
  opening: RowOpening;
  act: (method: BoxAction, box: BoxView) => Promise<void>;
  now: number;
  /** Set for the box this thread runs on (036): a "BB machine" badge among the others, no Release, Stop or Start, and a line saying where those are. */
  held?: Held | null;
  /** Where the desktop and terminal open, when not in this thread's panel tabs: the Boxes page opens them on the page. */
  opens?: BoxOpens;
  /** Last words on the status line, such as the Boxes page's who has control and thread title. */
  meta?: readonly (string | null)[];
  busy?: Busy | null;
  /** A quick action before the menu, such as the Boxes page's Open thread. */
  extra?: ReactNode;
  /** "New thread on this box…": a child of `threadId`'s thread. Off on the Boxes page, where "this thread" names none. */
  threading?: boolean;
  onBoxesPage?: () => void;
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
  const page = "page" in opening ? opening.page : null;
  const open = !page && "details" in opening && opening.details;
  const status = statusOf(box, now, myViewers());
  const lineId = useId();
  const nameFocus = useNameFocus();
  const line = page ? rowLine(box, { now, busy: busyNow, viewers: myViewers(), resizeNote }) : null;
  const ready = box.state === "ready";
  const showsError = box.error !== null;
  const compact = useIsCompactViewport();
  const stops = !held && box.canStopStart && unreachableWhy(box) === null;
  const quickActions = [
    ...openableNow(openActions(box, { screen: openScreen, terminal: openTerminal })).map((action) => <IconButton key={action.key} label={action.words} icon={action.glyph()} onClick={action.open} />),
    ...(stops && box.state === "stopped" ? [<IconButton key="start" label="Start" icon="Play" onClick={() => void run("start")} loading={busy === "start"} disabled={busy !== null} />] : []),
    ...(stops && ready ? [<IconButton key="stop" label="Stop" icon="Square" onClick={() => void run("stop")} loading={busy === "stop"} disabled={busy !== null} />] : []),
  ];

  return (
    <div
      data-resource-row
      className={cn("group grid min-w-0 cursor-pointer grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-3 py-3", page && PAGE_ROW, box.state === "releasing" && !releaseUnfinished(box) && "opacity-60")}
      onClick={
        page
          ? openPageOnClick(page)
          : (event) => {
              if (!onControl(event) && "toggle" in opening) opening.toggle();
            }
      }
    >
      <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
        <BoxGlyph />
      </span>
      <div className="min-w-0">
        {page ? (
          <RowNameLink box={box} page={page} describedBy={line ? rowDescribedBy(line, lineId) : undefined} focus={nameFocus}>
            <RowTitle name={box.name} os={systemName(box)} device={deviceModelOf(box)} badges={boxTitleBadges(box, held !== null)} />
          </RowNameLink>
        ) : (
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${box.name}: details`}
            onClick={"toggle" in opening ? opening.toggle : undefined}
            className="block w-full min-w-0 cursor-pointer rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {/* Each line stays one line in the panel's 560 px: the name and kind, then the state and what to act on. */}
            <RowTitle name={box.name} os={systemName(box)} device={deviceModelOf(box)} badges={boxTitleBadges(box, held !== null)} />
          </button>
        )}
        {line ? (
          <RowStatus line={line} id={lineId} nameFocused={nameFocus.focused} />
        ) : (
          <>
          <StatusLine tone={status.tone} items={[...status.items, ...meta]} />
          {box.waitingOn ? <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{box.waitingOn}</p> : null}
          {showsError ? <p className="mt-0.5 text-xs leading-snug text-destructive-text">{box.error}</p> : null}
          {resizeNote ? <p className={cn("mt-0.5 text-xs leading-snug", resizeNote.failed ? "text-destructive-text" : "text-muted-foreground")}>{resizeNote.text}</p> : null}
          {ready && box.enrol.state === "failed" ? (
            <p className="mt-0.5 text-xs leading-snug text-warning-text">
              <JoinHelp words={box.enrol.error} advice={joinAdvice(box)} />
            </p>
          ) : null}
          {box.stopped ? <p className="mt-0.5 text-xs leading-snug text-warning-text">{box.stopped}</p> : null}
          </>
        )}
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
        <BoxMenu box={box} of={{ owner: "thread", threadId, held: held !== null, offersThread, act: (method) => void run(method) }} opens={{ screen: openScreen, terminal: openTerminal }} resizing={resizing} onResizing={setResizing} onBoxesPage={onBoxesPage} />
        {page ? <RowChevron page={page} /> : null}
      </span>
    </div>
  );
}
