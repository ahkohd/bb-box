import { forwardRef, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { BoxDialog, DialogButton } from "./box-dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  BATTERY_LEVELS,
  LOCATION_RANGE,
  NETWORK_PRESETS,
  batteryProblem,
  linkFrom,
  locationProblem,
  urlProblem,
  type DeviceControl,
  type DeviceModel,
  type DeviceState,
  type LatLon,
  type ModelName,
  type NetworkPreset,
  type Posture,
} from "../core/device.ts";
import { SLOW_NETWORK, batteryWords, locationWords } from "../core/device-settings.ts";
import {
  BAR_WORDS,
  LAYOUT,
  PLACES,
  POSTURE_WORDS,
  REBOOT_WORDS,
  appearanceOf,
  asleep,
  barGroups,
  barHeight,
  barWidth,
  batteryOf,
  cleanStatusBar,
  controllable,
  locationOf,
  moreItems,
  overflowControls,
  placeAt,
  postureOf,
  rowControls,
  rowHeight,
  stepWords,
  textSizeSteps,
  waitWords,
  type BarControl,
} from "../core/device-toolbar.ts";
import type { AskKey, DeviceAsk } from "./device-controls.ts";
import type { DeviceLayout, DeviceView } from "./device-stage.ts";
import {
  BackGlyph,
  BatteryGlyph,
  FoldGlyph,
  HomeGlyph,
  LargeTextGlyph,
  LinkGlyph,
  LocationGlyph,
  LockGlyph,
  MonitorGlyph,
  MoonGlyph,
  MoreAcrossGlyph,
  MoreGlyph,
  NetworkGlyph,
  PhoneGlyph,
  RebootGlyph,
  RecentsGlyph,
  RotateLeftGlyph,
  RotateRightGlyph,
  ScreenshotGlyph,
  SmallTextGlyph,
  StatusBarGlyph,
  SunGlyph,
  TextSizeGlyph,
} from "./glyphs.tsx";

export const TOUCH_HINT_KEY = "bb-box:device-touch-hint-seen";
export const TOUCH_HINT_WORDS = "Using a control takes control from the agent.";
const ROW_GAP_PX = 12;
const EDGE_PX = 8;
const HINT_ROOM_PX = 48;

export function toolbarRoom(coarse: boolean, hint: boolean): { readonly beside: number; readonly below: number } {
  return { beside: barWidth(coarse) + LAYOUT.gap, below: rowHeight() + ROW_GAP_PX + (hint ? HINT_ROOM_PX : 0) };
}

export interface DeviceToolbarProps {
  readonly model: DeviceModel;
  readonly state: DeviceState | null;
  readonly layout: DeviceLayout;
  readonly coarse: boolean;
  readonly compact: boolean;
  readonly connected: boolean;
  readonly mine: boolean;
  readonly takesFrom: string | null;
  readonly busy: AskKey | "screenshot" | null;
  readonly view: DeviceView;
  readonly hint: boolean;
  readonly onAsk: (ask: DeviceAsk, by: AskedBy) => void;
  readonly onScreenshot: () => void;
  readonly onView: (view: DeviceView) => void;
}

export type AskedBy = "pointer" | "keyboard" | "menu";

type Dialog = "link" | "place" | "battery" | null;

function clamp(value: number, least: number, most: number): number {
  return Math.max(least, Math.min(most, value));
}

const BAR_ITEM = "data-bar-item";

function moveFocus(event: KeyboardEvent<HTMLElement>, across: boolean): void {
  if (event.defaultPrevented) return;
  const forward = across ? "ArrowRight" : "ArrowDown";
  const back = across ? "ArrowLeft" : "ArrowUp";
  if (![forward, back, "Home", "End"].includes(event.key)) return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(`[${BAR_ITEM}]`));
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (at + (event.key === forward ? 1 : -1) + items.length) % items.length;
  for (const [index, item] of items.entries()) item.tabIndex = index === next ? 0 : -1;
  items[next]?.focus();
}

interface BarButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title"> {
  readonly label: string;
  readonly tip: string;
  readonly side: "right" | "top";
  readonly size: number;
  readonly working: boolean;
  readonly blocked: string | null;
  readonly first: boolean;
}

const BarButton = forwardRef<HTMLButtonElement, BarButtonProps>(function BarButton({ label, tip, side, size, working, blocked, first, className, children, onClick, ...rest }, ref) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={ref}
          type="button"
          {...{ [BAR_ITEM]: "" }}
          tabIndex={first ? 0 : -1}
          aria-label={label}
          aria-disabled={blocked ? true : undefined}
          aria-busy={working || undefined}
          style={{ width: size, height: size }}
          className={cn(
            "relative inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors duration-150 hover:bg-state-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-state-active aria-pressed:text-foreground data-[state=open]:bg-state-active data-[state=open]:text-foreground aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground [&_svg]:size-[18px]",
            working && "text-foreground",
            className,
          )}
          onClick={(event) => {
            if (blocked) {
              event.preventDefault();
              return;
            }
            onClick?.(event);
          }}
          {...rest}
        >
          {children}
          {working ? <span aria-hidden className="pointer-events-none absolute inset-0.5 animate-pulse rounded-md ring-1 ring-primary/50" /> : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-56 text-xs leading-snug">
        {blocked ?? tip}
      </TooltipContent>
    </Tooltip>
  );
});

function Separator({ across }: { across: boolean }) {
  return <span aria-hidden className={cn("shrink-0 self-center bg-border", across ? "mx-1 h-6 w-px" : "my-1 h-px w-6")} />;
}

function glyphOf(control: BarControl, dark: boolean): ReactNode {
  switch (control) {
    case "home":
      return <HomeGlyph />;
    case "back":
      return <BackGlyph />;
    case "recents":
      return <RecentsGlyph />;
    case "rotate-left":
      return <RotateLeftGlyph />;
    case "rotate-right":
      return <RotateRightGlyph />;
    case "fold":
      return <FoldGlyph />;
    case "appearance":
      return dark ? <MoonGlyph /> : <SunGlyph />;
    case "text-size":
      return <TextSizeGlyph />;
    case "screenshot":
      return <ScreenshotGlyph />;
  }
}

export function DeviceToolbar(props: DeviceToolbarProps) {
  const { model, state, layout, coarse, compact, connected, mine, takesFrom, busy, view, hint, onAsk, onScreenshot, onView } = props;
  const across = layout.arrangement === "below";
  const size = across ? LAYOUT.rowTarget : coarse ? LAYOUT.coarseTarget : LAYOUT.fineTarget;
  const side = across ? "top" : "right";
  const dark = appearanceOf(state) === "dark";
  const [dialog, setDialog] = useState<Dialog>(null);
  const [textOpen, setTextOpen] = useState(false);
  const blockedWords = connected && controllable(state) ? null : waitWords(state, connected);
  const takes = !mine && takesFrom ? ` Takes control from ${takesFrom}.` : "";
  const askedBy = useRef<"pointer" | "keyboard">("pointer");
  const control = (ask: DeviceControl) => onAsk({ kind: "control", control: ask }, askedBy.current);
  const fromMenu = (ask: DeviceControl) => onAsk({ kind: "control", control: ask }, "menu");
  const shown: readonly (readonly BarControl[])[] = across ? [rowControls(model)] : barGroups(model);
  const overflow = across ? overflowControls(model) : [];
  const posture = postureOf(state);
  const describedBy = useId();

  const tipOf = (each: BarControl): string => {
    if (each === "appearance") return `Appearance: ${dark ? "dark" : "light"}. Select for ${dark ? "light" : "dark"}.${takes}`;
    if (each === "screenshot") return "Copy the device's screen to this computer as a picture.";
    if (each === "fold") return `Fold: ${posture ? POSTURE_WORDS[posture].toLowerCase() : "not read yet"}.${takes}`;
    return `${BAR_WORDS[each]}.${takes}`;
  };

  const asked = (each: BarControl): boolean => {
    if (!busy) return false;
    if (each === "rotate-left" || each === "rotate-right") return busy === "rotate";
    if (each === "fold") return busy === "posture";
    if (each === "text-size") return busy === "text_size";
    return busy === each;
  };

  const buttonFor = (each: BarControl, first: boolean): ReactNode => {
    const common = {
      key: each,
      label: each === "fold" ? `Fold${posture ? `, ${POSTURE_WORDS[posture].toLowerCase()}` : ""}` : BAR_WORDS[each],
      tip: tipOf(each),
      side,
      size,
      first,
      working: asked(each),
      blocked: each === "screenshot" ? (connected && controllable(state) ? null : blockedWords) : blockedWords,
      "aria-describedby": blockedWords ? describedBy : undefined,
    } as const;
    switch (each) {
      case "home":
      case "back":
      case "recents":
        return (
          <BarButton {...common} onClick={() => control({ action: each })}>
            {glyphOf(each, dark)}
          </BarButton>
        );
      case "rotate-left":
      case "rotate-right":
        return (
          <BarButton {...common} onClick={() => control({ action: "rotate", turn: each === "rotate-left" ? "left" : "right" })}>
            {glyphOf(each, dark)}
          </BarButton>
        );
      case "appearance":
        return (
          <BarButton {...common} aria-pressed={dark} onClick={() => control({ action: "appearance", to: dark ? "light" : "dark" })}>
            {glyphOf(each, dark)}
          </BarButton>
        );
      case "screenshot":
        return (
          <BarButton {...common} onClick={onScreenshot}>
            {glyphOf(each, dark)}
          </BarButton>
        );
      case "fold":
        return (
          <FoldMenu key={each} side={side} model={model} posture={posture} compact={compact} blocked={!!common.blocked} onChoose={(to) => fromMenu({ action: "posture", to })}>
            <BarButton {...common}>{glyphOf(each, dark)}</BarButton>
          </FoldMenu>
        );
      case "text-size":
        return (
          <TextSizePopover key={each} side={side} model={model} state={state} open={textOpen && !common.blocked} onOpenChange={(open) => setTextOpen(open && !common.blocked)} onAsk={fromMenu} busy={busy === "text_size"}>
            <BarButton {...common}>{glyphOf(each, dark)}</BarButton>
          </TextSizePopover>
        );
    }
  };

  const count = shown.flat().length + 1;
  const height = across ? rowHeight() : barHeight(model, coarse);
  const width = across ? count * size + (count + shown.length - 1) * 2 + shown.length * LAYOUT.separator + LAYOUT.barPadding * 2 : barWidth(coarse);
  const { device, area } = layout;
  const position = across
    ? {
        left: clamp(device.x + device.width / 2 - width / 2, EDGE_PX, Math.max(EDGE_PX, area.width - width - EDGE_PX)),
        top: clamp(layout.under + ROW_GAP_PX, EDGE_PX, Math.max(EDGE_PX, area.height - height - EDGE_PX - (hint ? HINT_ROOM_PX : 0))),
      }
    : {
        left: clamp(device.x + device.width + LAYOUT.gap, EDGE_PX, Math.max(EDGE_PX, area.width - width - EDGE_PX)),
        top: clamp(device.y + device.height / 2 - height / 2, EDGE_PX, Math.max(EDGE_PX, area.height - height - EDGE_PX)),
      };
  const hintBelow = position.top + height + HINT_ROOM_PX <= area.height;

  return (
    <TooltipProvider delayDuration={400}>
      <div
        role="toolbar"
        aria-label={`${model.name} controls`}
        aria-orientation={across ? "horizontal" : "vertical"}
        data-testid="device-toolbar"
        data-arrangement={layout.arrangement}
        onKeyDown={(event) => {
          askedBy.current = "keyboard";
          moveFocus(event, across);
        }}
        onPointerDown={() => (askedBy.current = "pointer")}
        style={{ left: position.left, top: position.top, maxHeight: across ? undefined : area.height - EDGE_PX * 2 }}
        className={cn(
          "absolute z-10 flex rounded-xl bg-background/90 p-1 shadow-sm ring-1 ring-border backdrop-blur-sm motion-safe:transition-[left,top] motion-safe:duration-300 motion-safe:ease-out",
          across ? "flex-row items-center gap-0.5" : "flex-col items-center overflow-y-auto",
        )}
      >
        {shown.map((group, index) => (
          <GroupOf key={group.join()} across={across} first={index === 0}>
            {group.map((each, at) => buttonFor(each, index === 0 && at === 0))}
          </GroupOf>
        ))}
        {across ? <Separator across /> : <Separator across={false} />}
        <MoreMenu
          side={side}
          model={model}
          state={state}
          compact={compact}
          overflow={overflow}
          view={view}
          blocked={blockedWords}
          onAsk={fromMenu}
          onScreenshot={onScreenshot}
          onView={onView}
          onDialog={setDialog}
        >
          <BarButton label="More device controls" tip={`More: lock, links, location, status bar, battery, how the device shows, and reboot.`} side={side} size={size} first={false} working={busy !== null && !shown.flat().some(asked)} blocked={null}>
            {across ? <MoreAcrossGlyph /> : <MoreGlyph />}
          </BarButton>
        </MoreMenu>
        {blockedWords ? (
          <span id={describedBy} className="sr-only">
            {blockedWords}
          </span>
        ) : null}
      </div>
      {hint ? (
        <p
          role="note"
          className="pointer-events-none absolute z-10 max-w-44 rounded-md bg-background/90 px-2 py-1 text-xs leading-snug text-muted-foreground shadow-sm ring-1 ring-border"
          style={
            across
              ? { left: clamp(position.left, EDGE_PX, area.width - 176 - EDGE_PX), top: hintBelow ? position.top + height + 8 : Math.max(EDGE_PX, position.top - 48) }
              : { left: Math.max(EDGE_PX, position.left + width - 176), top: hintBelow ? position.top + height + 8 : Math.max(EDGE_PX, position.top - 48) }
          }
        >
          {TOUCH_HINT_WORDS}
        </p>
      ) : null}
      <LinkDialog open={dialog === "link"} onClose={() => setDialog(null)} model={model} onOpen={(url) => onAsk({ kind: "open", url }, "menu")} />
      <PlaceDialog open={dialog === "place"} onClose={() => setDialog(null)} model={model} at={locationOf(state)} onSet={(to) => fromMenu({ action: "location", to })} />
      <BatteryDialog open={dialog === "battery"} onClose={() => setDialog(null)} model={model} at={batteryOf(state)} onSet={(to) => fromMenu({ action: "battery", to })} />
    </TooltipProvider>
  );
}

function GroupOf({ across, first, children }: { across: boolean; first: boolean; children: ReactNode }) {
  return (
    <>
      {first ? null : <Separator across={across} />}
      {children}
    </>
  );
}

function FoldMenu({ side, model, posture, compact, blocked, onChoose, children }: { side: "right" | "top"; model: DeviceModel; posture: Posture | null; compact: boolean; blocked: boolean; onChoose: (to: Posture) => void; children: ReactNode }) {
  const postures = model.form === "foldable" ? model.postures : [];
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild disabled={blocked}>
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} align="start" className="w-max min-w-36" mobileTitle="Fold">
        {compact ? null : <DropdownMenuLabel>Fold</DropdownMenuLabel>}
        {postures.map((each) => (
          <DropdownMenuCheckboxItem key={each} checked={posture === each} onCheckedChange={() => onChoose(each)}>
            {POSTURE_WORDS[each]}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TextSizePopover({
  side,
  model,
  state,
  open,
  onOpenChange,
  onAsk,
  busy,
  children,
}: {
  side: "right" | "top";
  model: DeviceModel;
  state: DeviceState | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAsk: (control: DeviceControl) => void;
  busy: boolean;
  children: ReactNode;
}) {
  const steps = textSizeSteps(model, state);
  const [wanted, setWanted] = useState<number | null>(null);
  useEffect(() => {
    if (!busy) setWanted(null);
  }, [busy, steps.at]);
  const at = wanted ?? steps.at;
  const choose = (index: number) => {
    const clamped = clamp(index, 0, steps.steps.length - 1);
    if (clamped === at) return;
    setWanted(clamped);
    onAsk({ action: "text_size", to: steps.steps[clamped]! });
  };
  const slider = useRef<HTMLDivElement>(null);
  const nowWords = at === null ? steps.words : `${stepWords(steps.steps[at]!)}${at === steps.fallback ? ", the default" : ""}`;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side={side} align="center" className="w-72 p-3" mobileTitle="Text size" aria-label="Text size" autoFocusRef={slider}>
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-sm text-foreground">Text size</p>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {nowWords}
          </p>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground" aria-label="Smaller text" disabled={at === 0} onClick={() => choose((at ?? steps.fallback) - 1)}>
            <SmallTextGlyph />
          </Button>
          <StepSlider sliderRef={slider} count={steps.steps.length} at={at} fallback={steps.fallback} label="Text size" valueText={(index) => stepWords(steps.steps[index]!)} onChoose={choose} />
          <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground" aria-label="Larger text" disabled={at === steps.steps.length - 1} onClick={() => choose((at ?? steps.fallback) + 1)}>
            <LargeTextGlyph />
          </Button>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">{model.platform === "ios" ? "iOS's content sizes" : "Android's font scales"}</p>
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={at === steps.fallback} onClick={() => choose(steps.fallback)}>
            Default
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function StepSlider({ sliderRef, count, at, fallback, label, valueText, onChoose }: { sliderRef: RefObject<HTMLDivElement | null>; count: number; at: number | null; fallback: number; label: string; valueText: (index: number) => string; onChoose: (index: number) => void }) {
  const track = sliderRef;
  const dragging = useRef(false);
  const indexAt = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect || !rect.width) return at ?? fallback;
    return clamp(Math.floor(((clientX - rect.left) / rect.width) * count), 0, count - 1);
  };
  const shown = at ?? fallback;
  return (
    <div
      ref={track}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={1}
      aria-valuemax={count}
      aria-valuenow={shown + 1}
      aria-valuetext={at === null ? "Not read yet" : valueText(at)}
      className="flex h-8 min-w-0 flex-1 cursor-pointer touch-none items-center gap-0.5 rounded-md px-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onKeyDown={(event) => {
        const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 3, PageDown: -3 }[event.key];
        if (step !== undefined) onChoose(shown + step);
        else if (event.key === "Home") onChoose(0);
        else if (event.key === "End") onChoose(count - 1);
        else return;
        event.preventDefault();
      }}
      onPointerDown={(event) => {
        dragging.current = true;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        onChoose(indexAt(event.clientX));
      }}
      onPointerMove={(event) => dragging.current && onChoose(indexAt(event.clientX))}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
    >
      {Array.from({ length: count }, (_, index) => (
        <span key={index} aria-hidden className={cn("h-2 flex-1 rounded-full transition-colors duration-150", at !== null && index <= at ? "bg-foreground/70" : "bg-foreground/15", index === fallback && "h-3")} />
      ))}
    </div>
  );
}

function MenuGroup({ compact, label, now, glyph, children }: { compact: boolean; label: string; now?: string; glyph: ReactNode; children: ReactNode }) {
  if (compact) {
    return (
      <>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>
          {label}
          {now ? <span className="font-normal text-muted-foreground">: {now}</span> : null}
        </DropdownMenuLabel>
        {children}
      </>
    );
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger aria-label={now ? `${label}: ${now}` : label}>
        {glyph}
        <span className="flex-1">{label}</span>
        {now ? <span className="pl-3 text-muted-foreground">{now}</span> : null}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-max min-w-44 max-w-72">{children}</DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function Described({ words, detail }: { words: string; detail: string }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span>{words}</span>
      <span className="text-[11px] leading-snug text-muted-foreground">{detail}</span>
    </span>
  );
}

function MoreMenu({
  side,
  model,
  state,
  compact,
  overflow,
  view,
  blocked,
  onAsk,
  onScreenshot,
  onView,
  onDialog,
  children,
}: {
  side: "right" | "top";
  model: DeviceModel;
  state: DeviceState | null;
  compact: boolean;
  overflow: readonly BarControl[];
  view: DeviceView;
  blocked: string | null;
  onAsk: (control: DeviceControl) => void;
  onScreenshot: () => void;
  onView: (view: DeviceView) => void;
  onDialog: (dialog: Dialog) => void;
  children: ReactNode;
}) {
  const items = moreItems(model);
  const off = blocked !== null;
  const failed = state?.power.is === "failed";
  const dark = appearanceOf(state) === "dark";
  const location = locationOf(state);
  const place = placeAt(location);
  const battery = batteryOf(state);
  const network = state?.platform === "android" && state.settings.network.known ? state.settings.network.value : null;
  const steps = textSizeSteps(model, state);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent side={side} align="end" className="w-max min-w-52 max-w-80" mobileTitle={`${model.name}`}>
        {off ? (
          <p role="note" className="px-2 py-1.5 text-xs text-muted-foreground">
            {blocked}
          </p>
        ) : null}
        {overflow.includes("rotate-right") ? (
          <DropdownMenuItem disabled={off} onSelect={() => onAsk({ action: "rotate", turn: "right" })}>
            <RotateRightGlyph />
            Rotate right
          </DropdownMenuItem>
        ) : null}
        {overflow.includes("appearance") ? (
          <DropdownMenuCheckboxItem className="gap-2" disabled={off} checked={dark} onCheckedChange={(checked) => onAsk({ action: "appearance", to: checked === true ? "dark" : "light" })}>
            <MoonGlyph />
            Dark appearance
          </DropdownMenuCheckboxItem>
        ) : null}
        {overflow.includes("text-size") ? (
          <MenuGroup compact={compact} label="Text size" now={steps.words} glyph={<TextSizeGlyph />}>
            <DropdownMenuItem disabled={off || steps.at === steps.steps.length - 1} onSelect={(event) => (event.preventDefault(), onAsk({ action: "text_size", to: "larger" }))}>
              <LargeTextGlyph />
              Larger text
            </DropdownMenuItem>
            <DropdownMenuItem disabled={off || steps.at === 0} onSelect={(event) => (event.preventDefault(), onAsk({ action: "text_size", to: "smaller" }))}>
              <SmallTextGlyph />
              Smaller text
            </DropdownMenuItem>
            <DropdownMenuItem disabled={off || steps.at === steps.fallback} onSelect={() => onAsk({ action: "text_size", to: "default" })}>
              <TextSizeGlyph />
              Default size
            </DropdownMenuItem>
          </MenuGroup>
        ) : null}
        {overflow.includes("screenshot") ? (
          <DropdownMenuItem disabled={off} onSelect={onScreenshot}>
            <ScreenshotGlyph />
            Copy screenshot
          </DropdownMenuItem>
        ) : null}
        {overflow.length ? <DropdownMenuSeparator /> : null}
        {items.includes("lock") ? (
          asleep(state) ? (
            <DropdownMenuItem disabled={off} onSelect={() => onAsk({ action: "wake" })}>
              <SunGlyph />
              Wake
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled={off} onSelect={() => onAsk({ action: "lock" })}>
              <LockGlyph />
              Lock
            </DropdownMenuItem>
          )
        ) : null}
        {items.includes("open-link") ? (
          <DropdownMenuItem disabled={off} onSelect={() => onDialog("link")}>
            <LinkGlyph />
            Open link…
          </DropdownMenuItem>
        ) : null}
        {items.includes("location") ? (
          <MenuGroup compact={compact} label="Location" now={place?.name ?? (location ? locationWords(location) : "Not set")} glyph={<LocationGlyph />}>
            {PLACES.map((each) => (
              <DropdownMenuCheckboxItem key={each.name} disabled={off} checked={place?.name === each.name} onCheckedChange={() => onAsk({ action: "location", to: { latitude: each.latitude, longitude: each.longitude } })}>
                {each.name}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuCheckboxItem disabled={off} checked={!!location && !place} onCheckedChange={() => onDialog("place")}>
              {location && !place ? `Custom: ${locationWords(location)}` : "Latitude and longitude…"}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem disabled={off} checked={location === null} onCheckedChange={() => onAsk({ action: "location", to: null })}>
              No simulated location
            </DropdownMenuCheckboxItem>
          </MenuGroup>
        ) : null}
        {items.includes("status-bar") ? (
          <DropdownMenuCheckboxItem className="gap-2" disabled={off} checked={cleanStatusBar(state)} onCheckedChange={(checked) => onAsk({ action: "status_bar", to: checked === true ? "clean" : "live" })}>
            <StatusBarGlyph />
            <Described words="Clean status bar" detail="9:41, full signal and battery, for screenshots" />
          </DropdownMenuCheckboxItem>
        ) : null}
        {items.includes("battery") ? (
          <DropdownMenuItem disabled={off} aria-label={`Battery: ${battery ? batteryWords(battery) : model.platform === "ios" ? "the Mac's" : "its own"}`} onSelect={() => onDialog("battery")}>
            <BatteryGlyph />
            <span className="flex-1">Battery…</span>
            <span className="pl-3 text-muted-foreground">{battery ? batteryWords(battery) : model.platform === "ios" ? "The Mac's" : "Its own"}</span>
          </DropdownMenuItem>
        ) : null}
        {items.includes("network") ? (
          <MenuGroup compact={compact} label="Network" now={network ? NETWORK_WORDS[network] : undefined} glyph={<NetworkGlyph />}>
            {NETWORK_PRESETS.map((each) => (
              <DropdownMenuCheckboxItem key={each} disabled={off} checked={network === each} onCheckedChange={() => onAsk({ action: "network", to: each })}>
                <Described words={NETWORK_WORDS[each]} detail={NETWORK_DETAIL[each]} />
              </DropdownMenuCheckboxItem>
            ))}
          </MenuGroup>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem className="gap-2" checked={view.frame} onCheckedChange={(checked) => onView({ ...view, frame: checked === true })}>
          <PhoneGlyph />
          Show frame
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem className="gap-2" checked={view.pixelForPixel} onCheckedChange={(checked) => onView({ ...view, pixelForPixel: checked === true })}>
          <MonitorGlyph />
          Pixel for pixel
        </DropdownMenuCheckboxItem>
        {items.includes("reboot") ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={off && !failed} onSelect={() => onAsk({ action: "reboot" })}>
              <RebootGlyph />
              <Described words="Reboot device" detail={REBOOT_WORDS[model.platform]} />
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const NETWORK_WORDS: Readonly<Record<NetworkPreset, string>> = { online: "Online", offline: "Offline", slow: "Slow" };
const NETWORK_DETAIL: Readonly<Record<NetworkPreset, string>> = {
  online: "Wi-Fi and data at full speed",
  offline: "Airplane mode",
  slow: `${SLOW_NETWORK.kbitPerSecond} kbit/s each way, ${SLOW_NETWORK.delayMs} ms later out`,
};

function FormDialog({ open, title, description, submit, problem, onSubmit, onClose, children }: { open: boolean; title: string; description: string; submit: string; problem: string | null; onSubmit: () => void; onClose: () => void; children: ReactNode }) {
  return (
    <BoxDialog
      open={open}
      title={title}
      description={description}
      refused={problem}
      onClose={onClose}
      onSubmit={() => onSubmit()}
      footer={
        <>
          <DialogButton variant="outline" onClick={onClose}>
            Cancel
          </DialogButton>
          <DialogButton type="submit">{submit}</DialogButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">{children}</div>
    </BoxDialog>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-foreground">
      {label}
      {children}
    </label>
  );
}

function LinkDialog({ open, model, onOpen, onClose }: { open: boolean; model: DeviceModel; onOpen: (url: string) => void; onClose: () => void }) {
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (open) setProblem(null);
  }, [open]);
  return (
    <FormDialog
      open={open}
      title={`Open a link on the ${model.name}`}
      description="A web address opens in the device's browser. An app's own link, such as myapp://settings, opens in that app."
      submit="Open"
      problem={problem}
      onClose={onClose}
      onSubmit={() => {
        const url = linkFrom(typed);
        const why = url ? urlProblem(url) : "Write a link to open.";
        if (why) {
          setProblem(why);
          return;
        }
        onOpen(url);
        onClose();
      }}
    >
      <Field label="Link">
        <Input
          autoFocus
          inputMode="url"
          spellCheck={false}
          placeholder="https://example.com"
          value={typed}
          aria-invalid={problem ? true : undefined}
          onChange={(event) => {
            const next = event.target.value;
            setTyped(next);
            if (!problem) return;
            const url = linkFrom(next);
            setProblem(url ? urlProblem(url) : "Write a link to open.");
          }}
        />
      </Field>
    </FormDialog>
  );
}

function PlaceDialog({ open, model, at, onSet, onClose }: { open: boolean; model: DeviceModel; at: LatLon | null; onSet: (to: LatLon) => void; onClose: () => void }) {
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setProblem(null);
    setLatitude(at ? String(at.latitude) : "");
    setLongitude(at ? String(at.longitude) : "");
  }, [open]);
  return (
    <FormDialog
      open={open}
      title={`Set the ${model.name}'s location`}
      description="Apps on the device see this place as where it is, in decimal degrees."
      submit="Set location"
      problem={problem}
      onClose={onClose}
      onSubmit={() => {
        const to = { latitude: Number(latitude.trim()), longitude: Number(longitude.trim()) };
        const why = latitude.trim() === "" || longitude.trim() === "" ? "Write both a latitude and a longitude." : locationProblem(to);
        if (why) {
          setProblem(why.replace(/^location takes/, "Write"));
          return;
        }
        onSet(to);
        onClose();
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label={`Latitude, -${LOCATION_RANGE.latitude} to ${LOCATION_RANGE.latitude}`}>
          <Input
            autoFocus
            inputMode="decimal"
            placeholder="for example 51.5"
            value={latitude}
            aria-invalid={problem ? true : undefined}
            onChange={(event) => {
              const next = event.target.value;
              setLatitude(next);
              if (!problem) return;
              const to = { latitude: Number(next.trim()), longitude: Number(longitude.trim()) };
              const why = next.trim() === "" || longitude.trim() === "" ? "Write both a latitude and a longitude." : locationProblem(to);
              setProblem(why ? why.replace(/^location takes/, "Write") : null);
            }}
          />
        </Field>
        <Field label={`Longitude, -${LOCATION_RANGE.longitude} to ${LOCATION_RANGE.longitude}`}>
          <Input
            inputMode="decimal"
            placeholder="for example -0.1"
            value={longitude}
            aria-invalid={problem ? true : undefined}
            onChange={(event) => {
              const next = event.target.value;
              setLongitude(next);
              if (!problem) return;
              const to = { latitude: Number(latitude.trim()), longitude: Number(next.trim()) };
              const why = latitude.trim() === "" || next.trim() === "" ? "Write both a latitude and a longitude." : locationProblem(to);
              setProblem(why ? why.replace(/^location takes/, "Write") : null);
            }}
          />
        </Field>
      </div>
    </FormDialog>
  );
}

function BatteryDialog({ open, model, at, onSet, onClose }: { open: boolean; model: DeviceModel; at: { readonly level: number; readonly charging: boolean } | null; onSet: (to: { level: number; charging: boolean } | null) => void; onClose: () => void }) {
  const [level, setLevel] = useState("100");
  const [charging, setCharging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setProblem(null);
    setLevel(String(at?.level ?? 100));
    setCharging(at?.charging ?? false);
  }, [open]);
  return (
    <FormDialog
      open={open}
      title={`The ${model.name}'s battery`}
      description={model.platform === "ios" ? "On iOS only the status bar's picture changes: apps still read the Mac's battery." : "Apps on the device read this level, and whether it charges."}
      submit="Set battery"
      problem={problem}
      onClose={onClose}
      onSubmit={() => {
        const to = { level: Number(level.trim()), charging };
        const why = level.trim() === "" ? "Write a level from 0 to 100." : batteryProblem(to);
        if (why) {
          setProblem(why.replace(/^battery takes a level, a whole number/, "Write a whole number").replace(/, and whether it is charging\.$/, "."));
          return;
        }
        onSet(to);
        onClose();
      }}
    >
      <Field label={`Level, ${BATTERY_LEVELS.least} to ${BATTERY_LEVELS.most}%`}>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={BATTERY_LEVELS.least}
            max={BATTERY_LEVELS.most}
            step={1}
            value={Number(level) || 0}
            onChange={(event) => {
              setLevel(event.target.value);
              setProblem(null);
            }}
            aria-label="Level"
            className="min-w-0 flex-1 accent-foreground"
          />
          <Input
            autoFocus
            inputMode="numeric"
            className="w-16"
            aria-label="Level, in per cent"
            aria-invalid={problem ? true : undefined}
            value={level}
            onChange={(event) => {
              const next = event.target.value;
              setLevel(next);
              if (!problem) return;
              const to = { level: Number(next.trim()), charging };
              const why = next.trim() === "" ? "Write a level from 0 to 100." : batteryProblem(to);
              setProblem(why ? why.replace(/^battery takes a level, a whole number/, "Write a whole number").replace(/, and whether it is charging\.$/, ".") : null);
            }}
          />
        </div>
      </Field>
      <label className="flex items-center gap-2 text-xs text-foreground">
        <input type="checkbox" checked={charging} onChange={(event) => setCharging(event.target.checked)} className="size-4 accent-foreground" />
        Charging
      </label>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 self-start px-2 text-xs"
        onClick={() => {
          onSet(null);
          onClose();
        }}
      >
        {model.platform === "ios" ? "Show the Mac's battery again" : "Use the device's own battery"}
      </Button>
    </FormDialog>
  );
}

export function DevicePicker({
  model,
  offered,
  bootedHere,
  state,
  compact,
  takesFrom,
  onSwitch,
}: {
  model: ModelName;
  offered: readonly ModelName[];
  bootedHere: readonly ModelName[] | null;
  state: DeviceState | null;
  compact: boolean;
  takesFrom: string | null;
  onSwitch: (to: ModelName) => void;
}) {
  const switching = state?.power.is === "switching" ? state.power.to : null;
  const label = switching ? `Switching to the ${switching}…` : model;
  if (offered.length < 2) return <span className="text-foreground">{model}</span>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs font-normal text-foreground" aria-label={`Device: ${label}. Choose another`} disabled={switching !== null}>
          <PhoneGlyph className="text-muted-foreground" />
          {label}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="size-3.5 text-muted-foreground" aria-hidden>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-max min-w-56 max-w-80" mobileTitle="Device">
        {compact ? null : <DropdownMenuLabel>Device</DropdownMenuLabel>}
        {offered.map((each) => {
          const cold = bootedHere !== null && !bootedHere.includes(each) && each !== model;
          return (
            <DropdownMenuCheckboxItem key={each} checked={each === model} onCheckedChange={() => each !== model && onSwitch(each)}>
              {cold ? <Described words={each} detail="Not started in this box yet, so it may take a minute." /> : each}
            </DropdownMenuCheckboxItem>
          );
        })}
        <DropdownMenuSeparator />
        <p className="max-w-72 px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
          Apps are per device: each keeps its own apps and data.{takesFrom ? ` Switching takes control from ${takesFrom}.` : ""}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
