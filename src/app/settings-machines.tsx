// "Machines" on the settings page (036): boxes you own, kept as BB
// machines. One row per machine with its state, badges and the threads on
// it; Open desktop, Terminal, Stop or Start, and Remove, which ask before
// taking a machine from a thread that is working on it (034); and "Add
// machine", the New box popover with a name.

import { experimental_Icon as Icon, experimental_usePluginId, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { Contract, MachineEntry, MachinesState } from "../plugin/contract.ts";
import type { BoxView } from "../plugin/views.ts";
import { EmptyPanel, forThread, IconButton, isArm64Badge, KindBadges, lacksDocker, message, Meta, OPERATOR, osName, StatusDot, useLive, useNow } from "./common.tsx";
import { runsWayland } from "./boxes-filter.ts";
import { DESKTOP_PAGE, desktopSubPath, pageUrl } from "./desktop.tsx";
import { ProblemLine, useMachineActions } from "./box-actions.tsx";
import { NewBox, useDesktopOnDemand, useDesktopProblemShownOnce, type SizeRequest } from "./new-box.tsx";
import { Section } from "./settings-fields.tsx";
import { statusOf } from "./status.ts";
import { canOpenTerminal } from "./terminal.tsx";
import { BoxGlyph, MonitorGlyph, TerminalGlyph } from "./glyphs.tsx";
import { canResize, ResizeDialog, useResizeNote } from "./resize.tsx";
import { ThreadChips } from "./thread-chips.tsx";



function isMoving(box: BoxView): boolean {
  return box.state === "acquiring" || box.state === "starting" || box.state === "stopping" || box.state === "releasing";
}

export function MachinesSection() {
  const rpc = useRpc<Contract>();
  const { value: state, error, refresh } = useLive<MachinesState>("machines", () => rpc.call("machines.list"), forThread(OPERATOR));
  const machines = state?.machines ?? [];
  const kinds = state?.kinds ?? [];
  const now = useNow(machines.some((entry) => isMoving(entry.box)));
  // Start, Stop and Remove with their warnings, shared with the Boxes page's Machines.
  const { act, busy, problem, setProblem, askRemove, dialogs } = useMachineActions(refresh);
  const onDemand = useDesktopOnDemand(state?.desktopOnDemand, OPERATOR, refresh);
  useDesktopProblemShownOnce(state?.desktopProblem, setProblem);
  const add = async (kind: string, size?: SizeRequest, name?: string, on?: string | string[]): Promise<string | null> => {
    let refused: string | null;
    try {
      refused = (await rpc.call("machines.add", { kind, ...(size ? { size } : {}), ...(name ? { name } : {}), ...(on ? { on } : {}) })).error;
    } catch (caught) {
      refused = message(caught);
    }
    await refresh();
    return refused;
  };

  return (
    <Section title="Machines" description="Boxes of your own, kept as BB machines." action={<NewBox kinds={kinds} make={add} onDemand={onDemand} machine profile={(backend) => rpc.call("provider", { backend })} rooms={(kind, size) => rpc.call("rooms", { kind, ...(size ? { size } : {}) })} />} plain={!machines.length}>
      {error ? <EmptyPanel role="alert">{error}</EmptyPanel> : null}
      <ProblemLine problem={problem} onDismiss={() => setProblem(null)} className="py-2" />
      {state && !machines.length ? (
        <EmptyPanel>Add a box as a BB machine of your own. It shows in BB's machine list and new-thread picker, and stays until you remove it here.</EmptyPanel>
      ) : null}
      {machines.map((entry) => (
        <MachineRow key={entry.box.id} entry={entry} now={now} busy={busy} onStop={() => void act("stop", entry.box)} onStart={() => void act("start", entry.box)} onRemove={() => askRemove(entry.box)} />
      ))}
      {dialogs}
    </Section>
  );
}

/**
 * One of your machines as a row: name, OS and badges, state and threads, and its actions. In settings its desktop and
 * terminal open with a way back to settings; on the Boxes page, back to the page, and its menu offers a browser tab too.
 */
export function MachineRow({ entry, now, busy, onStop, onStart, onRemove, from = "settings" }: { entry: MachineEntry; now: number; busy: string | null; onStop: () => void; onStart: () => void; onRemove: () => void; from?: "settings" | "boxes" }) {
  const { box, threads } = entry;
  const pluginId = experimental_usePluginId();
  const navigate = useBbNavigate();
  const status = statusOf(box, now);
  const ready = box.state === "ready";
  const back = from === "settings" ? "settings" : undefined;
  const openDesktop = () => navigate.toPluginPanel(DESKTOP_PAGE, { subPath: desktopSubPath(OPERATOR, box.id, "desktop", back) });
  const openTerminal = () => navigate.toPluginPanel(DESKTOP_PAGE, { subPath: desktopSubPath(OPERATOR, box.id, "terminal", back) });
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
          <span className="min-w-0 truncate text-xs text-muted-foreground">{osName(box.os)}</span>
          <KindBadges desktop={box.desktop} wayland={runsWayland(box)} gpu={box.gpu} noDocker={lacksDocker(box)} arm64={isArm64Badge(box.os, box.arch)} forms={box.form ? [box.form] : []} />
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
            {from === "boxes" && box.desktop && ready ? (
              <DropdownMenuItem onSelect={() => void navigate.openUrl(pageUrl(pluginId, OPERATOR, box.id))}>
                <Icon name="ExternalLink" aria-hidden />
                Open in browser
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
            {canResize(box) ? (
              <DropdownMenuItem onSelect={() => setResizing(true)}>
                <Icon name="Maximize2" aria-hidden />
                Resize…
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
      <ResizeDialog box={resizing ? box : null} onClose={() => setResizing(false)} />
    </div>
  );
}
