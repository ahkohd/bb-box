// One box in the Box panel: its name, kind and status line, its details
// when open, its quick actions and its menu, and the release confirmation.

import { experimental_Icon as Icon, experimental_usePluginId, useBbNavigate, useRpc, UrlLink } from "@get-bb/plugin-sdk/app";
import { useState, type MouseEvent, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { Contract } from "../plugin/contract.ts";
import type { BoxView } from "../plugin/views.ts";
import { IconButton, isArm64Badge, KindBadges, lacksDocker, osName, relativeTime, RowTitle, SETTINGS_PATH, StatusLine } from "./common.tsx";
import { runsWayland } from "./boxes-filter.ts";
import { pageUrl, useOpenDesktop } from "./desktop.tsx";
import { JoinHelp } from "./first-run.tsx";
import { enrolWords, startWords, statusOf, timingWords } from "./status.ts";
import { canOpenTerminal, useOpenTerminal } from "./terminal.tsx";
import { BoxGlyph, MonitorGlyph, TerminalGlyph } from "./glyphs.tsx";
import { canResize, ResizeDialog, useResizeNote } from "./resize.tsx";

export type BoxAction = "release" | "stop" | "start" | "refresh";

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
  opens?: { readonly desktop: (box: BoxView) => void; readonly terminal: (box: BoxView) => void };
  /** Last words on the status line, such as the Boxes page's who has control and thread title. */
  meta?: readonly (string | null)[];
  /** A quick action before the menu, such as the Boxes page's Open thread. */
  extra?: ReactNode;
  /** "New thread on this box…": a child of `threadId`'s thread. Off on the Boxes page, where "this thread" names none. */
  threading?: boolean;
}) {
  const pluginId = experimental_usePluginId();
  const navigate = useBbNavigate();
  const openInPanel = useOpenDesktop();
  const terminalInPanel = useOpenTerminal();
  const openDesktop = opens?.desktop ?? openInPanel;
  const openTerminal = opens?.terminal ?? terminalInPanel;
  const [busy, setBusy] = useState<BoxAction | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [resizing, setResizing] = useState(false);
  const resizeNote = useResizeNote(box, resizing);
  const rpc = useRpc<Contract>();
  /** The new-thread dialog: closed, or its prompt, whether it is starting and why it did not. */
  const [threading, setThreading] = useState<{ prompt: string; starting: boolean; error: string | null } | null>(null);
  const startThread = async () => {
    if (!threading?.prompt.trim()) return;
    setThreading({ ...threading, starting: true, error: null });
    const result = await rpc.call("thread", { threadId, box: box.id, prompt: threading.prompt.trim() }).catch((error: unknown) => ({
      threadId: null,
      error: error instanceof Error ? error.message : String(error),
    }));
    if (result.threadId) {
      setThreading(null);
      navigate.toThread(result.threadId);
    } else setThreading((current) => current && { ...current, starting: false, error: result.error });
  };
  const run = async (method: BoxAction) => {
    setBusy(method);
    try {
      await act(method, box);
    } finally {
      setBusy(null);
    }
  };
  const settling = box.state === "acquiring" || box.state === "starting" || box.state === "stopping" || box.state === "releasing";
  const status = statusOf(box, now, myViewers());
  const ready = box.state === "ready";
  const showsError = box.error !== null;

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
          <RowTitle name={box.name} os={osName(box.os)} badges={<KindBadges desktop={box.desktop} wayland={runsWayland(box)} gpu={box.gpu} noDocker={lacksDocker(box)} arm64={isArm64Badge(box.os, box.arch)} forms={box.form ? [box.form] : []} machine={held !== null} />} />
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
                Remove or stop it in{" "}
                <UrlLink href={SETTINGS_PATH} className="text-foreground underline-offset-2 hover:underline">
                  BB Box's settings
                </UrlLink>
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
        {box.desktop && ready ? <IconButton label="Open desktop" icon={<MonitorGlyph />} onClick={() => openDesktop(box)} /> : null}
        {canOpenTerminal(box) ? <IconButton label="Open terminal" icon={<TerminalGlyph />} onClick={() => openTerminal(box)} /> : null}
        {!held && box.canStopStart && box.state === "stopped" ? <IconButton label="Start" icon="Play" onClick={() => void run("start")} loading={busy === "start"} disabled={busy !== null} /> : null}
        {!held && box.canStopStart && ready ? <IconButton label="Stop" icon="Square" onClick={() => void run("stop")} loading={busy === "stop"} disabled={busy !== null} /> : null}
        {extra}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="size-7 p-0 text-muted-foreground hover:text-foreground" aria-label={`${box.name} actions`}>
              <Icon name="MoreHorizontal" className="size-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-max min-w-40 max-w-72" mobileTitle={box.name}>
            {box.desktop && ready ? (
              <>
                <DropdownMenuItem onSelect={() => openDesktop(box)}>
                  <MonitorGlyph />
                  Open desktop
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void navigate.openUrl(pageUrl(pluginId, threadId, box.id))}>
                  <Icon name="ExternalLink" aria-hidden />
                  Open in browser
                </DropdownMenuItem>
              </>
            ) : null}
            {canOpenTerminal(box) ? (
              <DropdownMenuItem onSelect={() => openTerminal(box)}>
                <TerminalGlyph />
                Open terminal
              </DropdownMenuItem>
            ) : null}
            {box.address ? (
              <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(box.address ?? "")}>
                <Icon name="Copy" aria-hidden />
                Copy address
              </DropdownMenuItem>
            ) : null}
            {offersThread && !held && ready && box.enrol.state === "enrolled" ? (
              <DropdownMenuItem onSelect={() => setThreading({ prompt: "", starting: false, error: null })}>
                <Icon name="MessageSquarePlus" fallback="Plus" aria-hidden />
                New thread on this box…
              </DropdownMenuItem>
            ) : null}
            {(box.desktop && ready) || canOpenTerminal(box) || box.address || (offersThread && !held && ready && box.enrol.state === "enrolled") ? <DropdownMenuSeparator /> : null}
            {!held && box.canStopStart && ready ? (
              <DropdownMenuItem onSelect={() => void run("stop")}>
                <Icon name="Square" aria-hidden />
                Stop
              </DropdownMenuItem>
            ) : null}
            {!held && box.canStopStart && box.state === "stopped" ? (
              <DropdownMenuItem onSelect={() => void run("start")}>
                <Icon name="Play" aria-hidden />
                Start
              </DropdownMenuItem>
            ) : null}
            {!held && canResize(box) ? (
              <DropdownMenuItem onSelect={() => setResizing(true)}>
                <Icon name="Maximize2" aria-hidden />
                Resize…
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem disabled={settling} onSelect={() => void run("refresh")}>
              <Icon name="ArrowReloadHorizontal" aria-hidden />
              Check now
            </DropdownMenuItem>
            {held ? null : (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" disabled={box.state === "releasing"} onSelect={() => setConfirming(true)}>
              <Icon name="Trash2" aria-hidden />
                  Release…
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
      <AlertDialog open={threading !== null} onOpenChange={(open) => !open && setThreading(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>New thread on {box.name}</AlertDialogTitle>
            <AlertDialogDescription>
              A child of this thread, working in a worktree of the project on the box. It is archived with this thread.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            aria-label="Prompt"
            placeholder="What should it do on the box?"
            value={threading?.prompt ?? ""}
            onChange={(event) => setThreading((current) => current && { ...current, prompt: event.target.value })}
            rows={4}
            autoFocus
          />
          {threading?.error ? <p className="text-sm text-destructive">{threading.error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={threading?.starting}>Cancel</AlertDialogCancel>
            <Button type="button" disabled={!threading?.prompt.trim() || threading.starting} onClick={() => void startThread()}>
              {threading?.starting ? "Starting…" : "Start thread"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ResizeDialog box={resizing ? box : null} threadId={threadId} onClose={() => setResizing(false)} />
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Release {box.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {box.nature === "real"
                ? "The machine will be reset and returned to its pool. Anything in the box user's home will be deleted."
                : "Its disk and everything on it will be deleted. Copy out anything you want to keep first."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => void run("release")}>
              Release
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
