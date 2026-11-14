import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { MonitorSnapshot } from "../plugin/contract.ts";
import type { BoxView } from "../plugin/views.ts";
import { whyClosed } from "./box-opens.tsx";
import { silentWhy } from "./box-words.ts";
import { followPageLink, type PageLink } from "./box-nav.tsx";
import type { BoxViewName } from "./box-route.ts";
import { FolderGlyph, MonitorGlyph, PhoneGlyph, TerminalGlyph } from "./glyphs.tsx";
import { offersFiles } from "./files-open.ts";
import { screensOf, screenWord } from "./screens.ts";
import { useMonitorSnapshot } from "./monitor/use-snapshot.ts";
import { LoadingText } from "./monitor/metric-parts.tsx";
import { loadErrorCopy } from "./monitor/load-error-copy.ts";
import { minuteClock, nowPercents, type NowPercents } from "./activity-words.ts";
import { CHART_COLOURS, CHART_TONES } from "./activity.tsx";
import { LEAVE_TERMINAL_KEYS } from "./terminal.tsx";

export interface ViewChoice {
  readonly view: BoxViewName;
  readonly words: string;
  readonly why: string | null;
}

export function boxViews(box: BoxView): ViewChoice[] {
  const why = silentWhy(box) ?? whyClosed(box);
  const screens = screensOf(box).map((screen): ViewChoice => ({ view: screen, words: screenWord(box, screen), why }));
  const terminal: ViewChoice[] = box.terminal || box.state !== "ready" ? [{ view: "terminal", words: "Terminal", why }] : [];
  const files: ViewChoice[] = offersFiles(box) ? [{ view: "files", words: "Files", why }] : [];
  return [...screens, ...terminal, ...files];
}

export function viewGlyph(view: BoxViewName, className?: string): ReactNode {
  if (view === "files") return <FolderGlyph className={className} />;
  if (view === "terminal") return <TerminalGlyph className={className} />;
  return view === "device" ? <PhoneGlyph className={className} /> : <MonitorGlyph className={className} />;
}

export function otherViewsNow(box: BoxView, shown: BoxViewName): ViewChoice[] {
  return boxViews(box).filter((choice) => choice.view !== shown && choice.why === null);
}

export function ViewSwitchButton({ view, words, hint, onClick }: { view: BoxViewName; words: string; hint?: string; onClick: () => void }) {
  const button = (
    <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 font-normal" data-view-switch={view} onClick={onClick}>
      {viewGlyph(view, "size-3.5")}
      {words}
    </Button>
  );
  if (!hint) return button;
  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent>{hint}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function fromTheTerminalWords(): string {
  return `In the terminal, ${LEAVE_TERMINAL_KEYS} comes here.`;
}

export function OtherViews({ box, shown, without, onSwitch }: { box: BoxView; shown: BoxViewName; without?: readonly BoxViewName[]; onSwitch: (view: BoxViewName) => void }) {
  return (
    <>
      {otherViewsNow(box, shown)
        .filter((choice) => !without?.includes(choice.view))
        .map((choice) => (
          <ViewSwitchButton key={choice.view} view={choice.view} words={choice.words} hint={shown === "terminal" ? fromTheTerminalWords() : undefined} onClick={() => onSwitch(choice.view)} />
        ))}
    </>
  );
}

export const BAR_NUMBERS_SHOWN_KEY = "bb-box:bar-numbers";

function rememberedBarNumbersShown(): boolean {
  try {
    return globalThis.localStorage?.getItem(BAR_NUMBERS_SHOWN_KEY) === "on";
  } catch {
    return false;
  }
}

function rememberBarNumbersShown(shown: boolean): void {
  try {
    if (shown) globalThis.localStorage?.setItem(BAR_NUMBERS_SHOWN_KEY, "on");
    else globalThis.localStorage?.removeItem(BAR_NUMBERS_SHOWN_KEY);
  } catch {
    return;
  }
}

export function useBarNumbersShown(): readonly [boolean, (shown: boolean) => void] {
  const [shown, setShown] = useState(rememberedBarNumbersShown);
  const choose = (next: boolean) => {
    rememberBarNumbersShown(next);
    setShown(next);
  };
  return [shown, choose];
}

function percentWords(value: number | null): string {
  return value === null ? "–" : `${Math.round(value)}%`;
}

export function barNumbersLabel(name: string, percents: NowPercents, staleSince: number | null): string {
  const share = percents.ofShare ? " of its share" : "";
  const whose = percents.ofShare ? "this slot's " : "";
  const read = `${name}: ${whose}CPU ${percentWords(percents.cpu)}${share}, memory ${percentWords(percents.memory)}${share}`;
  const stale = staleSince === null ? "" : `, from ${minuteClock(staleSince)}`;
  return `${read}${stale}. Open ${name}'s page`;
}

function Reading({ colour, label, value }: { colour: string; label: string; value: ReactNode }) {
  return (
    <span className="flex items-center gap-1">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: colour }} />
      {label} {value}
    </span>
  );
}

export function BarNumbers({ machineId, boxId, name, page, everyWidth = false }: { machineId: string; boxId?: string; name: string; page: PageLink; everyWidth?: boolean }) {
  const { container, snapshot, error } = useMonitorSnapshot(machineId, boxId);
  return (
    <div ref={container} data-bar-numbers className={cn("flex items-center", !everyWidth && "max-sm:hidden", CHART_TONES)}>
      <BarReading snapshot={snapshot} error={error} name={name} page={page} />
    </div>
  );
}

const LINK = "flex h-7 cursor-pointer items-center gap-2.5 rounded-md px-1.5 text-xs tabular-nums text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function BarReading({ snapshot, error, name, page }: { snapshot: MonitorSnapshot | null; error: string | null; name: string; page: PageLink }) {
  if (!snapshot && error) {
    return (
      <a href={page.href} onClick={followPageLink(page)} title={loadErrorCopy(error, name)} aria-label={`${loadErrorCopy(error, name)} Open ${name}'s page`} className={LINK}>
        Not answering
      </a>
    );
  }
  if (!snapshot) {
    return (
      <a href={page.href} onClick={followPageLink(page)} aria-label={`${name}'s page`} aria-busy className={LINK}>
        <LoadingText sample="CPU 00%" />
        <LoadingText sample="Memory 00%" />
      </a>
    );
  }
  const percents = nowPercents(snapshot);
  const staleSince = error ? Date.parse(snapshot.timestamp) : null;
  const label = barNumbersLabel(name, percents, staleSince);
  return (
    <a href={page.href} onClick={followPageLink(page)} title={label} aria-label={label} data-cpu={percentWords(percents.cpu)} data-memory={percentWords(percents.memory)} data-read-at={snapshot.timestamp} data-stale={staleSince === null ? undefined : ""} className={LINK}>
      <Reading colour={CHART_COLOURS.cpu} label="CPU" value={percentWords(percents.cpu)} />
      <Reading colour={CHART_COLOURS.memory} label="Memory" value={percentWords(percents.memory)} />
      {staleSince !== null ? <span className="text-warning-text">at {minuteClock(staleSince)}</span> : null}
    </a>
  );
}
