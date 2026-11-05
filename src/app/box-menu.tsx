import { experimental_Icon as Icon, experimental_usePluginId, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { useRef, useState, type ReactNode, type RefObject } from "react";
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
import { hasViewer, OPERATOR } from "./common.tsx";
import { hostOf, notInSettings, releaseUnfinished, silentWhy, unreachableWhy } from "./box-words.ts";
import { pageUrl } from "./desktop.tsx";
import { CameraGlyph, TerminalGlyph } from "./glyphs.tsx";
import { openWords, screenGlyph, type BoxOpens } from "./box-opens.tsx";
import { canResize, ResizeDialog } from "./resize.tsx";
import { screensOf } from "./screens.ts";
import { canOpenTerminal } from "./terminal.tsx";

export type BoxAction = "release" | "stop" | "start" | "refresh" | "forget" | "enrol";

export interface ThreadsBox {
  readonly owner: "thread";
  readonly threadId: string;
  readonly held: boolean;
  readonly offersThread: boolean;
  readonly act: (method: BoxAction, options?: { readonly deleteKept?: boolean }) => void;
}

export interface YourMachine {
  readonly owner: "yours";
  readonly inBrowser: boolean;
  readonly stop: () => void;
  readonly start: () => void;
  readonly remove: () => void;
  readonly forget: () => void;
  readonly check?: () => void;
}

export type MenuPlace = "row" | "page";

export type MenuAsk = "release" | "forget" | "thread" | null;

interface NewThreadDraft {
  readonly prompt: string;
  readonly starting: boolean;
  readonly error: string | null;
}


const NO_DRAFT: NewThreadDraft = { prompt: "", starting: false, error: null };

function isSettling(box: BoxView): boolean {
  return box.state === "acquiring" || box.state === "starting" || box.state === "stopping" || box.state === "releasing";
}

function GatedItem({ why, icon, words, onSelect }: { why: string | null; icon: ReactNode; words: string; onSelect: () => void }) {
  return (
    <DropdownMenuItem disabled={why !== null} onSelect={onSelect}>
      {icon}
      {why ? (
        <span className="min-w-0">
          <span className="block">{words}</span>
          <span className="block text-xs text-muted-foreground">{why}</span>
        </span>
      ) : (
        words
      )}
    </DropdownMenuItem>
  );
}

function forgetWords(box: Pick<BoxView, "name" | "backendLabel">): string {
  const host = hostOf(box.backendLabel);
  return `bb-box removes its record of ${box.name}, and nothing else. Its box is not deleted: if it still runs${host ? ` on ${host}` : ""}, it keeps running there. If its backend comes back, bb-box takes the box back into its records, because a running box left untracked costs money and cannot be released.`;
}

export function BoxMenu({
  box,
  of,
  opens,
  resizing,
  onResizing,
  place = "row",
  onBoxesPage,
  asking,
  onAsking,
  takeSnapshot,
  triggerRef,
}: {
  box: BoxView;
  of: ThreadsBox | YourMachine;
  opens: BoxOpens;
  resizing: boolean;
  onResizing: (resizing: boolean) => void;
  place?: MenuPlace;
  onBoxesPage?: () => void;
  asking?: MenuAsk;
  onAsking?: (ask: MenuAsk) => void;
  takeSnapshot?: { readonly why: string | null; readonly take: () => void } | null;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const pluginId = experimental_usePluginId();
  const navigate = useBbNavigate();
  const rpc = useRpc<Contract>();
  const [ownAsk, setOwnAsk] = useState<MenuAsk>(null);
  const ask = asking !== undefined ? asking : ownAsk;
  const setAsk = onAsking ?? setOwnAsk;
  const confirmingRelease = ask === "release";
  const confirmingForget = ask === "forget";
  const setConfirmingRelease = (open: boolean) => setAsk(open ? "release" : null);
  const setConfirmingForget = (open: boolean) => setAsk(open ? "forget" : null);
  const [draft, setDraft] = useState<NewThreadDraft>(NO_DRAFT);
  const newThread = ask === "thread" ? draft : null;
  const setNewThread = (next: NewThreadDraft | null | ((current: NewThreadDraft) => NewThreadDraft)) => {
    if (typeof next === "function") return setDraft(next);
    setDraft(next ?? NO_DRAFT);
    setAsk(next ? "thread" : null);
  };
  const thread = of.owner === "thread" ? of : null;
  const machine = of.owner === "yours" ? of : null;
  const onPage = place === "page";
  const ready = box.state === "ready";
  const managed = !thread?.held;
  const unreachable = unreachableWhy(box);
  const gone = notInSettings(box);
  const unfinished = releaseUnfinished(box);
  const silent = silentWhy(box);
  const screens = onPage ? (machine ? screensOf(box).filter((screen) => screen === "device") : []) : screensOf(box);
  const viewsOpen = ready && screens.length > 0 && (onPage || hasViewer(box));
  const inBrowser = machine ? machine.inBrowser : true;
  const offersNewThread = !!thread && thread.offersThread && !thread.held && ready && box.enrol.state === "enrolled";
  const offersTerminal = !onPage && canOpenTerminal(box);
  const opensSomething = viewsOpen || offersTerminal || !!onBoxesPage || !!box.address || offersNewThread;
  const stop = machine ? machine.stop : () => thread?.act("stop");
  const start = machine ? machine.start : () => thread?.act("start");
  const check = machine ? machine.check : () => thread?.act("refresh");
  const stops = (box.canStopStart || gone) && !onPage;
  const resizes = canResize(box) || (gone && (ready || box.state === "stopped"));
  const removeWords = machine ? (unfinished ? "Remove again…" : "Remove…") : unfinished ? "Release again…" : "Release…";
  const removable = box.state !== "releasing" || unfinished;
  const againWhenAsked = useRef(unfinished);
  if (!confirmingRelease) againWhenAsked.current = unfinished;

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
    } else setNewThread((current) => ({ ...current, starting: false, error: result.error }));
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button ref={triggerRef} type="button" variant={onPage ? "outline" : "ghost"} size="icon" className={cn("p-0 text-muted-foreground hover:text-foreground", onPage ? "size-8" : "size-7")} aria-label={`${box.name} actions`}>
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
          {offersTerminal ? (
            <DropdownMenuItem onSelect={() => opens.terminal(box)}>
              <TerminalGlyph />
              Open terminal
            </DropdownMenuItem>
          ) : null}
          {onBoxesPage ? (
            <DropdownMenuItem onSelect={onBoxesPage}>
              <Icon name="ArrowUpRight" aria-hidden />
              Open on the Boxes page
            </DropdownMenuItem>
          ) : null}
          {box.address ? (
            <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(box.address ?? "")}>
              <Icon name="Copy" aria-hidden />
              Copy address
            </DropdownMenuItem>
          ) : null}
          {offersNewThread ? (
            <GatedItem why={silent} icon={<Icon name="MessageSquarePlus" fallback="Plus" aria-hidden />} words="New thread on this box…" onSelect={() => setNewThread(NO_DRAFT)} />
          ) : null}
          {opensSomething ? <DropdownMenuSeparator /> : null}
          {managed && stops && ready ? <GatedItem why={unreachable} icon={<Icon name="Square" aria-hidden />} words="Stop" onSelect={stop} /> : null}
          {managed && stops && box.state === "stopped" ? <GatedItem why={unreachable} icon={<Icon name="Play" aria-hidden />} words="Start" onSelect={start} /> : null}
          {managed && resizes ? <GatedItem why={unreachable} icon={<Icon name="Maximize2" aria-hidden />} words="Resize…" onSelect={() => onResizing(true)} /> : null}
          {takeSnapshot ? <GatedItem why={takeSnapshot.why} icon={<CameraGlyph />} words="Take snapshot…" onSelect={takeSnapshot.take} /> : null}
          {check ? (
            <DropdownMenuItem disabled={isSettling(box)} onSelect={check}>
              <Icon name="ArrowReloadHorizontal" aria-hidden />
              Check now
            </DropdownMenuItem>
          ) : null}
          {managed && gone ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirmingForget(true)}>
                <Icon name="Trash2" aria-hidden />
                Forget…
              </DropdownMenuItem>
            </>
          ) : null}
          {thread && !thread.held && !gone ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" disabled={!removable} onSelect={() => setConfirmingRelease(true)}>
                <Icon name="Trash2" aria-hidden />
                {removeWords}
              </DropdownMenuItem>
            </>
          ) : null}
          {machine && !gone ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" disabled={!removable} onSelect={machine.remove}>
                <Icon name="Trash2" aria-hidden />
                {removeWords}
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
              onChange={(event) => setNewThread((current) => ({ ...current, prompt: event.target.value }))}
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
      <AlertDialog open={confirmingForget} onOpenChange={setConfirmingForget}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Forget {box.name}?</AlertDialogTitle>
            <AlertDialogDescription>{forgetWords(box)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => (machine ? machine.forget() : thread?.act("forget"))}>
              Forget
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {thread ? (
        <AlertDialog open={confirmingRelease} onOpenChange={setConfirmingRelease}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{againWhenAsked.current ? `Release ${box.name} again?` : `Release ${box.name}?`}</AlertDialogTitle>
              <AlertDialogDescription>
                {box.nature === "real"
                  ? "The machine will be reset and returned to its pool. Anything in the box user's home will be deleted."
                  : "Its disk and everything on it will be deleted. Copy out anything you want to keep first."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {box.releaseHeldForKept ? <p className="text-sm text-muted-foreground">Its last release stopped before deleting anything: bb-box could not copy a snapshot you kept. Release again tries the copy again; Release and delete what you kept deletes those snapshots with it.</p> : null}
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              {box.releaseHeldForKept ? (
                <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => thread.act("release", { deleteKept: true })}>
                  Release and delete what you kept
                </AlertDialogAction>
              ) : null}
              <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => thread.act("release")}>
                {box.releaseHeldForKept ? "Release again" : "Release"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </>
  );
}
