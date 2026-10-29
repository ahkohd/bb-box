import { experimental_Icon as Icon, experimental_usePluginId, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
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
import type { Contract } from "../plugin/contract.ts";
import type { BoxView } from "../plugin/views.ts";
import { hasViewer, OPERATOR } from "./common.tsx";
import { pageUrl } from "./desktop.tsx";
import { TerminalGlyph } from "./glyphs.tsx";
import { openWords, screenGlyph, type BoxOpens } from "./box-opens.tsx";
import { canResize, ResizeDialog } from "./resize.tsx";
import { screensOf, type Screen } from "./screens.ts";
import { canOpenTerminal } from "./terminal.tsx";

export type BoxAction = "release" | "stop" | "start" | "refresh";

export interface ThreadsBox {
  readonly owner: "thread";
  readonly threadId: string;
  readonly held: boolean;
  readonly offersThread: boolean;
  readonly act: (method: BoxAction) => void;
}

export interface YourMachine {
  readonly owner: "yours";
  readonly inBrowser: boolean;
  readonly stop: () => void;
  readonly start: () => void;
  readonly remove: () => void;
}

interface NewThreadDraft {
  readonly prompt: string;
  readonly starting: boolean;
  readonly error: string | null;
}

const MACHINE_SCREENS: readonly Screen[] = ["desktop"];

function isSettling(box: BoxView): boolean {
  return box.state === "acquiring" || box.state === "starting" || box.state === "stopping" || box.state === "releasing";
}

export function BoxMenu({ box, of, opens, resizing, onResizing }: { box: BoxView; of: ThreadsBox | YourMachine; opens: BoxOpens; resizing: boolean; onResizing: (resizing: boolean) => void }) {
  const pluginId = experimental_usePluginId();
  const navigate = useBbNavigate();
  const rpc = useRpc<Contract>();
  const [confirmingRelease, setConfirmingRelease] = useState(false);
  const [newThread, setNewThread] = useState<NewThreadDraft | null>(null);
  const thread = of.owner === "thread" ? of : null;
  const machine = of.owner === "yours" ? of : null;
  const ready = box.state === "ready";
  const managed = !thread?.held;
  const viewsOpen = hasViewer(box) && ready;
  const screens = machine ? MACHINE_SCREENS : screensOf(box);
  const inBrowser = machine ? machine.inBrowser : true;
  const offersNewThread = !!thread && thread.offersThread && !thread.held && ready && box.enrol.state === "enrolled";
  const opensSomething = viewsOpen || canOpenTerminal(box) || !!box.address || offersNewThread;
  const stop = machine ? machine.stop : () => thread?.act("stop");
  const start = machine ? machine.start : () => thread?.act("start");

  const startThread = async () => {
    if (!thread || !newThread?.prompt.trim()) return;
    setNewThread({ ...newThread, starting: true, error: null });
    const result = await rpc.call("thread", { threadId: thread.threadId, box: box.id, prompt: newThread.prompt.trim() }).catch((error: unknown) => ({
      threadId: null,
      error: error instanceof Error ? error.message : String(error),
    }));
    if (result.threadId) {
      setNewThread(null);
      navigate.toThread(result.threadId);
    } else setNewThread((current) => current && { ...current, starting: false, error: result.error });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon" className="size-7 p-0 text-muted-foreground hover:text-foreground" aria-label={`${box.name} actions`}>
            <Icon name="MoreHorizontal" className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-max min-w-40 max-w-72" mobileTitle={box.name}>
          {viewsOpen ? (
            <>
              {screens.map((screen) => (
                <DropdownMenuItem key={screen} onSelect={() => opens.screen(box, screen)}>
                  {screenGlyph(screen)}
                  {openWords(box, screen)}
                </DropdownMenuItem>
              ))}
              {inBrowser ? (
                <DropdownMenuItem onSelect={() => void navigate.openUrl(pageUrl(pluginId, thread?.threadId ?? OPERATOR, box.id))}>
                  <Icon name="ExternalLink" aria-hidden />
                  Open in browser
                </DropdownMenuItem>
              ) : null}
            </>
          ) : null}
          {canOpenTerminal(box) ? (
            <DropdownMenuItem onSelect={() => opens.terminal(box)}>
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
          {offersNewThread ? (
            <DropdownMenuItem onSelect={() => setNewThread({ prompt: "", starting: false, error: null })}>
              <Icon name="MessageSquarePlus" fallback="Plus" aria-hidden />
              New thread on this box…
            </DropdownMenuItem>
          ) : null}
          {opensSomething ? <DropdownMenuSeparator /> : null}
          {managed && box.canStopStart && ready ? (
            <DropdownMenuItem onSelect={stop}>
              <Icon name="Square" aria-hidden />
              Stop
            </DropdownMenuItem>
          ) : null}
          {managed && box.canStopStart && box.state === "stopped" ? (
            <DropdownMenuItem onSelect={start}>
              <Icon name="Play" aria-hidden />
              Start
            </DropdownMenuItem>
          ) : null}
          {managed && canResize(box) ? (
            <DropdownMenuItem onSelect={() => onResizing(true)}>
              <Icon name="Maximize2" aria-hidden />
              Resize…
            </DropdownMenuItem>
          ) : null}
          {thread ? (
            <DropdownMenuItem disabled={isSettling(box)} onSelect={() => thread.act("refresh")}>
              <Icon name="ArrowReloadHorizontal" aria-hidden />
              Check now
            </DropdownMenuItem>
          ) : null}
          {thread && !thread.held ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" disabled={box.state === "releasing"} onSelect={() => setConfirmingRelease(true)}>
                <Icon name="Trash2" aria-hidden />
                Release…
              </DropdownMenuItem>
            </>
          ) : null}
          {machine ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" disabled={box.state === "releasing"} onSelect={machine.remove}>
                <Icon name="Trash2" aria-hidden />
                Remove…
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {thread ? (
        <AlertDialog open={newThread !== null} onOpenChange={(open) => !open && setNewThread(null)}>
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
              value={newThread?.prompt ?? ""}
              onChange={(event) => setNewThread((current) => current && { ...current, prompt: event.target.value })}
              rows={4}
              autoFocus
            />
            {newThread?.error ? <p className="text-sm text-destructive">{newThread.error}</p> : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={newThread?.starting}>Cancel</AlertDialogCancel>
              <Button type="button" disabled={!newThread?.prompt.trim() || newThread.starting} onClick={() => void startThread()}>
                {newThread?.starting ? "Starting…" : "Start thread"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
      <ResizeDialog box={resizing ? box : null} threadId={thread?.threadId} onClose={() => onResizing(false)} />
      {thread ? (
        <AlertDialog open={confirmingRelease} onOpenChange={setConfirmingRelease}>
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
              <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => thread.act("release")}>
                Release
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </>
  );
}
