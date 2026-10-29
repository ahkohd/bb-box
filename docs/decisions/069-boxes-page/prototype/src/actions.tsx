import { useState, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { BoxView } from "@/src/plugin/views.ts";
import { MonitorGlyph, PhoneGlyph, TerminalGlyph } from "@/src/app/glyphs.tsx";
import { screensOf, screenWord, type Screen } from "@/src/app/screens.ts";
import type { FakeBox } from "./data";
import { go, type CameFrom, type ViewName } from "./nav";
import { useStore } from "./store";

export interface Opening {
  readonly view: ViewName;
  readonly words: string;
  readonly glyph: (className?: string) => ReactNode;
  readonly closedBecause: string | null;
}

const NOT_READY: Readonly<Record<string, string>> = {
  acquiring: "is starting",
  starting: "is starting",
  stopping: "is stopping",
  stopped: "is stopped",
  releasing: "is being released",
  failed: "failed",
  gone: "is gone",
};

export function whyClosed(view: BoxView): string | null {
  return view.state === "ready" ? null : `${view.name} ${NOT_READY[view.state]}`;
}

export function openingsOf(view: BoxView): Opening[] {
  const closed = whyClosed(view);
  const screens = screensOf(view).map((screen: Screen): Opening => ({
    view: screen,
    words: screenWord(view, screen),
    glyph: (className) => (screen === "device" ? <PhoneGlyph className={className} /> : <MonitorGlyph className={className} />),
    closedBecause: closed,
  }));
  const shell = view.os !== "windows" || view.enrol.state === "enrolled";
  const terminal: Opening[] = shell ? [{ view: "terminal", words: "Terminal", glyph: (className) => <TerminalGlyph className={className} />, closedBecause: view.terminal ? null : closed ?? `${view.name} runs no shell yet` }] : [];
  return [...screens, ...terminal];
}

export function openView(id: string, view: ViewName, from: CameFrom): void {
  go({ page: "view", id, view }, { from });
}

export function unreachableWhy(box: FakeBox): string | null {
  if (box.backendGone) return `Its backend, ${box.view.backendLabel}, is not in settings`;
  if (box.unreachable) return `${box.view.backendLabel.replace(/^.* on /, "")} does not answer`;
  return null;
}

export function useReleaseDialog(box: FakeBox): { ask: () => void; dialog: ReactNode } {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const view = box.view;
  const yours = box.owner === "yours";
  const forget = !!box.backendGone;
  const dialog = (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{forget ? `Forget ${view.name}?` : yours ? `Remove ${view.name}?` : `Release ${view.name}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {forget
              ? `bb-box removes its record only. Its backend is not in settings, so bb-box cannot delete the box: if it still runs on ${view.backendLabel.replace(/^.* on /, "")}, it keeps running there.`
              : view.nature === "real"
                ? "The machine will be reset and returned to its pool. Anything in the box user's home will be deleted."
                : "Its disk and everything on it will be deleted. Copy out anything you want to keep first."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => store.act(forget ? "forget" : "release", view.id)}>
            {forget ? "Forget" : yours ? "Remove" : "Release"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return { ask: () => setOpen(true), dialog };
}

export function BoxMenu({ box, onRelease, offerOpenings = true, trigger }: { box: FakeBox; onRelease: () => void; offerOpenings?: boolean; trigger?: ReactNode }) {
  const store = useStore();
  const view = box.view;
  const ready = view.state === "ready";
  const settling = view.state === "acquiring" || view.state === "starting" || view.state === "stopping" || view.state === "releasing";
  const openings = offerOpenings ? openingsOf(view).filter((opening) => opening.closedBecause === null) : [];
  const yours = box.owner === "yours";
  const unreachable = unreachableWhy(box);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger ?? (
          <Button type="button" variant="ghost" size="icon" className="size-7 p-0 text-muted-foreground hover:text-foreground" aria-label={`${view.name} actions`}>
            <Icon name="MoreHorizontal" className="size-4" aria-hidden />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-max min-w-44 max-w-72">
        {openings.map((opening) => (
          <DropdownMenuItem key={opening.view} onSelect={() => openView(view.id, opening.view, "list")}>
            {opening.glyph()}
            Open {opening.words.toLowerCase()}
          </DropdownMenuItem>
        ))}
        {view.address ? (
          <DropdownMenuItem onSelect={() => store.say(`Copied ${view.address}`)}>
            <Icon name="Copy" aria-hidden />
            Copy address
          </DropdownMenuItem>
        ) : null}
        {!yours && ready && view.enrol.state === "enrolled" ? (
          <DropdownMenuItem onSelect={() => store.say("New thread on this box opens the Box panel's dialog.")}>
            <Icon name="MessageSquarePlus" aria-hidden />
            New thread on this box…
          </DropdownMenuItem>
        ) : null}
        {openings.length || view.address ? <DropdownMenuSeparator /> : null}
        {view.canStopStart && ready && !unreachable ? (
          <DropdownMenuItem onSelect={() => store.act("stop", view.id)}>
            <Icon name="Square" aria-hidden />
            Stop
          </DropdownMenuItem>
        ) : null}
        {view.canStopStart && view.state === "stopped" && !unreachable ? (
          <DropdownMenuItem onSelect={() => store.act("start", view.id)}>
            <Icon name="Play" aria-hidden />
            Start
          </DropdownMenuItem>
        ) : null}
        {view.resizing && (ready || view.state === "stopped") && !unreachable ? (
          <DropdownMenuItem onSelect={() => store.act("resize", view.id)}>
            <Icon name="Maximize2" aria-hidden />
            Resize…
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem disabled={settling} onSelect={() => store.act("refresh", view.id)}>
          <Icon name="ArrowReloadHorizontal" aria-hidden />
          Check now
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" disabled={(view.state === "releasing" && !box.operation) || (!!box.unreachable && !box.backendGone)} onSelect={onRelease}>
          <Icon name="Trash2" aria-hidden />
          {box.backendGone ? "Forget…" : box.operation?.action === "release" ? "Release again…" : yours ? "Remove…" : "Release…"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
