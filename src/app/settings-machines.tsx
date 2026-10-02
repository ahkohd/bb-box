// "Your machines" on the settings page (036): boxes you own, kept as BB
// machines. One row per machine with its state, badges and the threads on
// it; Open desktop, Terminal, Stop or Start, and Remove, which ask before
// taking a machine from a thread that is working on it (034); and "Add
// machine", the New box popover with a name.

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
import { cn } from "@/lib/utils";
import type { BoxResult, Contract, MachineEntry, ThreadOnBox } from "../plugin/contract.ts";
import type { BoxView, KindView } from "../plugin/views.ts";
import { EmptyPanel, forThread, IconButton, isArm64Badge, KindBadges, lacksDocker, message, Meta, osName, StatusDot, useLive, useNow } from "./common.tsx";
import { DESKTOP_PAGE, desktopSubPath } from "./desktop.tsx";
import { NewBox, type SizeRequest } from "./new-box.tsx";
import { Section } from "./settings-fields.tsx";
import { statusOf } from "./status.ts";
import { canOpenTerminal } from "./terminal.tsx";
import { MonitorGlyph, ServerGlyph, TerminalGlyph } from "./glyphs.tsx";

/** The reserved thread your machines belong to (036). */
export const OPERATOR = "operator";

type Guarded = "remove" | "stop";

/** The threads on a machine, in a few words: the working ones named first. */
export function threadsWords(threads: readonly ThreadOnBox[]): string | null {
  if (!threads.length) return null;
  const name = (thread: ThreadOnBox) => thread.title ?? thread.id;
  const working = threads.filter((thread) => thread.running);
  if (working.length) return `Working: ${working.map(name).join(", ")}${threads.length > working.length ? ` · ${threads.length - working.length} more` : ""}`;
  return `${threads.length === 1 ? "Thread" : "Threads"}: ${threads.map(name).join(", ")}`;
}

function isMoving(box: BoxView): boolean {
  return box.state === "acquiring" || box.state === "starting" || box.state === "stopping" || box.state === "releasing";
}

export function MachinesSection() {
  const rpc = useRpc<Contract>();
  const { value: state, error, refresh } = useLive<{ machines: MachineEntry[]; kinds: KindView[] }>("machines", () => rpc.call("machines.list"), forThread(OPERATOR));
  const machines = state?.machines ?? [];
  const kinds = state?.kinds ?? [];
  const now = useNow(machines.some((entry) => isMoving(entry.box)));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** A remove or stop left alone because threads work on the machine, until the user says. */
  const [inUse, setInUse] = useState<{ method: Guarded; box: BoxView; threads: readonly ThreadOnBox[] } | null>(null);
  const [removing, setRemoving] = useState<BoxView | null>(null);

  const settle = async (result: Promise<BoxResult>, onThreads?: (threads: readonly ThreadOnBox[]) => void): Promise<string | null> => {
    let refused: string | null;
    try {
      const answer = await result;
      refused = answer.error;
      if (answer.threads?.length) onThreads?.(answer.threads);
    } catch (caught) {
      refused = message(caught);
    }
    await refresh();
    return refused;
  };
  const add = (kind: string, size?: SizeRequest, name?: string, on?: string | string[]) => settle(rpc.call("machines.add", { kind, ...(size ? { size } : {}), ...(name ? { name } : {}), ...(on ? { on } : {}) }));
  const act = async (method: Guarded | "start", box: BoxView, force = false) => {
    setBusy(`${method}:${box.id}`);
    try {
      const input = { box: box.id, ...(method !== "start" && force ? { force: true } : {}) };
      const call = method === "remove" ? rpc.call("machines.remove", input) : method === "stop" ? rpc.call("machines.stop", input) : rpc.call("machines.start", input);
      setProblem(await settle(call, method === "start" ? undefined : (threads) => setInUse({ method, box, threads })));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section title="Your machines" description="Boxes of your own, kept as BB machines." action={<NewBox kinds={kinds} make={add} machine profile={(backend) => rpc.call("provider", { backend })} />} plain={!machines.length}>
      {error ? <EmptyPanel role="alert">{error}</EmptyPanel> : null}
      {problem ? (
        <p role="alert" className="py-2 text-xs leading-snug text-destructive-text">
          {problem}
        </p>
      ) : null}
      {state && !machines.length ? (
        <EmptyPanel>Add a box as a BB machine of your own. It shows in BB's machine list and new-thread picker, and stays until you remove it here.</EmptyPanel>
      ) : null}
      {machines.length ? (
        // A project with a repository needs a source on a machine once, which BB's picker sets up (036).
        <p className="pb-2 text-2xs leading-snug text-subtle-foreground/75">
          To use one for a project with a repository, pick it in BB's new-thread picker.
        </p>
      ) : null}
      {machines.map((entry) => (
        <MachineRow key={entry.box.id} entry={entry} now={now} busy={busy} onStop={() => void act("stop", entry.box)} onStart={() => void act("start", entry.box)} onRemove={() => setRemoving(entry.box)} />
      ))}
      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.nature === "real"
                ? "Its machine leaves BB, and it is reset and returned to its pool. Anything in the box user's home will be deleted."
                : "Its machine leaves BB, and its disk and everything on it will be deleted. Copy out anything you want to keep first."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (removing) void act("remove", removing);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={inUse !== null} onOpenChange={(open) => !open && setInUse(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {inUse?.method === "stop" ? "Stop" : "Remove"} {inUse?.box.name} anyway?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {inUse ? `${inUse.threads.map((thread) => thread.title ?? thread.id).join(", ")} ${inUse.threads.length === 1 ? "is" : "are"} working on it, and would lose ${inUse.threads.length === 1 ? "its" : "their"} machine.` : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => inUse && void act(inUse.method, inUse.box, true)}>
              {inUse?.method === "stop" ? "Stop anyway" : "Remove anyway"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}

/** One of your machines as a row: name, OS and badges, state and threads, and its actions. */
function MachineRow({ entry, now, busy, onStop, onStart, onRemove }: { entry: MachineEntry; now: number; busy: string | null; onStop: () => void; onStart: () => void; onRemove: () => void }) {
  const { box, threads } = entry;
  const pluginId = experimental_usePluginId();
  const navigate = useBbNavigate();
  const status = statusOf(box, now);
  const ready = box.state === "ready";
  const openDesktop = () => navigate.toPluginPanel(DESKTOP_PAGE, { subPath: desktopSubPath(OPERATOR, box.id, "desktop", "settings") });
  const openTerminal = () => navigate.toPluginPanel(DESKTOP_PAGE, { subPath: desktopSubPath(OPERATOR, box.id, "terminal", "settings") });
  const acting = busy !== null && busy.endsWith(`:${box.id}`);
  return (
    <div data-resource-row className={cn("grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-3 py-3 first:pt-0 last:pb-0", box.state === "releasing" && "opacity-60")}>
      <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
        {box.desktop ? <MonitorGlyph /> : <ServerGlyph />}
      </span>
      <div className="min-w-0">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{box.name}</span>
          <span className="min-w-0 truncate text-xs text-muted-foreground">{osName(box.os)}</span>
          <KindBadges desktop={box.desktop} gpu={box.gpu} noDocker={lacksDocker(box)} arm64={isArm64Badge(box.os, box.arch)} forms={box.form ? [box.form] : []} />
        </span>
        <div className="mt-0.5 flex min-w-0 items-start gap-1.5 text-xs leading-snug text-muted-foreground">
          <StatusDot tone={status.tone} className="mt-[0.3rem]" />
          <Meta
            items={[
              ...status.items.map((item, index) => (
                <span key={index} className={cn(item.tone === "fg" && "text-foreground", item.tone === "warn" && "text-warning-text", item.tone === "danger" && "text-destructive-text")}>
                  {item.text}
                </span>
              )),
              threadsWords(threads),
            ]}
          />
        </div>
        {box.error ? <p className="mt-0.5 text-xs leading-snug text-destructive-text">{box.error}</p> : null}
      </div>
      <span data-row-action className="flex shrink-0 items-center gap-0.5">
        {box.desktop && ready ? <IconButton label="Open desktop" icon={<MonitorGlyph />} onClick={openDesktop} /> : null}
        {canOpenTerminal(box) ? <IconButton label="Open terminal" icon={<TerminalGlyph />} onClick={openTerminal} /> : null}
        {box.canStopStart && box.state === "stopped" ? <IconButton label="Start" icon="Play" onClick={onStart} loading={busy === `start:${box.id}`} disabled={acting} /> : null}
        {box.canStopStart && ready ? <IconButton label="Stop" icon="Square" onClick={onStop} loading={busy === `stop:${box.id}`} disabled={acting} /> : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="size-7 p-0 text-muted-foreground hover:text-foreground" aria-label={`${box.name} actions`}>
              <Icon name="MoreHorizontal" className="size-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-max min-w-40 max-w-72" mobileTitle={box.name}>
            {box.desktop && ready ? (
              <DropdownMenuItem onSelect={openDesktop}>
                <MonitorGlyph />
                Open desktop
              </DropdownMenuItem>
            ) : null}
            {canOpenTerminal(box) ? (
              <DropdownMenuItem onSelect={openTerminal}>
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
            {(box.desktop && ready) || canOpenTerminal(box) || box.address ? <DropdownMenuSeparator /> : null}
            {box.canStopStart && ready ? (
              <DropdownMenuItem onSelect={onStop}>
                <Icon name="Square" aria-hidden />
                Stop
              </DropdownMenuItem>
            ) : null}
            {box.canStopStart && box.state === "stopped" ? (
              <DropdownMenuItem onSelect={onStart}>
                <Icon name="Play" aria-hidden />
                Start
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" disabled={box.state === "releasing"} onSelect={onRemove}>
              <Icon name="Trash2" aria-hidden />
              Remove…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </div>
  );
}
