// One box in the Boxes panel: its name, kind and status line, its details
// when open, its quick actions and its menu, and the release confirmation.

import { experimental_Icon as Icon, experimental_usePluginId, useBbNavigate } from "@get-bb/plugin-sdk/app";
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
import { cn } from "@/lib/utils";
import type { BoxView } from "../plugin/views.ts";
import { IconButton, Meta, relativeTime, StatusDot } from "./common.tsx";
import { pageHref, useOpenDesktop } from "./desktop.tsx";
import { enrolWords, statusOf, timingWords } from "./status.ts";

export type BoxAction = "release" | "stop" | "start" | "refresh";

/** The icon for a box's kind: a monitor for a desktop, a server otherwise. */
export function useBoxGlyph(): (box: Pick<BoxView, "desktop">) => string {
  const pluginId = experimental_usePluginId();
  return (box) => `${pluginId}/${box.desktop ? "monitor" : "server"}`;
}

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

export function BoxRow({
  box,
  threadId,
  open,
  onToggle,
  act,
  now,
}: {
  box: BoxView;
  threadId: string;
  open: boolean;
  onToggle: () => void;
  act: (method: BoxAction, box: BoxView) => Promise<void>;
  now: number;
}) {
  const pluginId = experimental_usePluginId();
  const navigate = useBbNavigate();
  const openDesktop = useOpenDesktop();
  const glyph = useBoxGlyph();
  const [busy, setBusy] = useState<BoxAction | null>(null);
  const [confirming, setConfirming] = useState(false);
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
        <Icon name={glyph(box)} className="size-4" aria-hidden />
      </span>
      <div className="min-w-0">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${box.name}: details`}
          onClick={onToggle}
          className="block w-full min-w-0 cursor-pointer rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate text-sm font-medium text-foreground">{box.name}</span>
            <span className="min-w-0 truncate text-xs font-normal text-muted-foreground">{box.kindLabel}</span>
          </span>
        </button>
        <div className="mt-0.5 flex min-w-0 items-start gap-1.5 text-xs leading-snug text-muted-foreground">
          <StatusDot tone={status.tone} className="mt-[0.3rem]" />
          <Meta
            items={status.items.map((item, index) => (
              <span key={index} className={cn(item.tone === "fg" && "text-foreground", item.tone === "warn" && "text-warning-text", item.tone === "danger" && "text-destructive-text")}>
                {item.text}
              </span>
            ))}
          />
        </div>
        {showsError ? <p className="mt-0.5 text-xs leading-snug text-destructive-text">{box.error}</p> : null}
        {open ? (
          <dl className="mt-2 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs leading-snug">
            {box.address ? <Detail label="Address">{box.address}</Detail> : null}
            {box.size ? <Detail label="Size">{box.size}</Detail> : null}
            <Detail label="Backend">{box.backendLabel}</Detail>
            <Detail label="System">
              {box.os} {box.arch}
              {box.extras.length ? `, with ${box.extras.join(", ")}` : ""}
            </Detail>
            {box.facts.map((fact) => (
              <Detail key={fact.label} label={fact.label}>
                {fact.value}
              </Detail>
            ))}
            <Detail label="BB machine">{enrolWords(box)}</Detail>
            {Object.keys(box.timings).length ? <Detail label="Timings">{timingWords(box)}</Detail> : null}
            <Detail label="Made">{relativeTime(box.createdAt, now)}</Detail>
          </dl>
        ) : null}
      </div>
      <span data-row-action className="flex shrink-0 cursor-default items-center gap-0.5">
        {box.desktop && ready ? <IconButton label="Open desktop" icon={`${pluginId}/monitor`} onClick={() => openDesktop(box)} /> : null}
        {box.canStopStart && box.state === "stopped" ? <IconButton label="Start" icon="Play" onClick={() => void run("start")} loading={busy === "start"} disabled={busy !== null} /> : null}
        {box.canStopStart && ready ? <IconButton label="Stop" icon="Square" onClick={() => void run("stop")} loading={busy === "stop"} disabled={busy !== null} /> : null}
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
                  <Icon name={`${pluginId}/monitor`} aria-hidden />
                  Open desktop
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void navigate.openUrl(pageHref(pluginId, threadId, box.id))}>
                  <Icon name="ExternalLink" aria-hidden />
                  Open desktop in a browser tab
                </DropdownMenuItem>
              </>
            ) : null}
            {box.address ? (
              <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(box.address ?? "")}>
                <Icon name="Copy" aria-hidden />
                Copy address
              </DropdownMenuItem>
            ) : null}
            {(box.desktop && ready) || box.address ? <DropdownMenuSeparator /> : null}
            {box.canStopStart && ready ? (
              <DropdownMenuItem onSelect={() => void run("stop")}>
                <Icon name="Square" aria-hidden />
                Stop
              </DropdownMenuItem>
            ) : null}
            {box.canStopStart && box.state === "stopped" ? (
              <DropdownMenuItem onSelect={() => void run("start")}>
                <Icon name="Play" aria-hidden />
                Start
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem disabled={settling} onSelect={() => void run("refresh")}>
              <Icon name="ArrowReloadHorizontal" aria-hidden />
              Check now
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" disabled={box.state === "releasing"} onSelect={() => setConfirming(true)}>
              <Icon name="Trash2" aria-hidden />
              Release…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
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
