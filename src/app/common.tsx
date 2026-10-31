// Pieces the panels share: live state from the server that follows its
// change signals, a ticking clock, words for times, and small controls in
// BB's style.

import type { BoxForm } from "../backends/types.ts";
import { experimental_Icon as Icon, useRealtime, useRealtimeConnectionState, UrlLink } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { BoxView } from "../plugin/views.ts";
import { platformWord } from "../core/device.ts";
import { runsWayland } from "./boxes-filter.ts";
import { screenWord } from "./screens.ts";

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Under 0.1 s in milliseconds, which a claim of a spare takes (#186). */
export function seconds(ms: number): string {
  return ms < 100 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** "just now", "3 minutes ago", "2 hours ago", "yesterday", "4 days ago". */
export function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/** The time now, ticking every `everyMs` while `active`; still otherwise. */
export function useNow(active: boolean, everyMs = 100): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [active, everyMs]);
  return now;
}

/**
 * State from the server for `key`, refetched on each change signal that
 * `relevant` accepts and after a reconnect. Only the newest answer is kept.
 */
/** The last value loaded for each key, so a tab that remounts starts from what it showed and does not go blank while it refetches (037). */
const remembered = new Map<string, unknown>();

/** The value last loaded under `key`, if any, as a view other than its own may want it before loading its own. */
export function rememberedLive<T>(key: string): T | undefined {
  return remembered.get(key) as T | undefined;
}

/** Forgets every remembered value, for tests. */
export function forgetLive(): void {
  remembered.clear();
}

interface LiveRun {
  readonly key: string;
  again: boolean;
  done: Promise<void>;
}

export function useLive<T>(key: string, load: () => Promise<T>, relevant: (payload: unknown) => boolean) {
  const latest = useRef({ load, relevant });
  latest.current = { load, relevant };
  const sequence = useRef(0);
  const running = useRef<LiveRun | null>(null);
  const [value, setValue] = useState<T | null>(() => (remembered.has(key) ? (remembered.get(key) as T) : null));
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback((): Promise<void> => {
    const current = running.current;
    if (current && current.key === key) {
      current.again = true;
      return current.done;
    }
    const run: LiveRun = { key, again: false, done: Promise.resolve() };
    const loadUntilCurrent = async () => {
      do {
        run.again = false;
        const mine = ++sequence.current;
        try {
          const next = await latest.current.load();
          if (mine !== sequence.current) continue;
          remembered.set(key, next);
          setValue(next);
          setError(null);
        } catch (caught) {
          if (mine === sequence.current) setError(message(caught));
        }
      } while (run.again && running.current === run);
    };
    running.current = run;
    run.done = loadUntilCurrent().finally(() => {
      if (running.current === run) running.current = null;
    });
    return run.done;
  }, [key]);
  useEffect(() => {
    setValue(remembered.has(key) ? (remembered.get(key) as T) : null);
    setError(null);
    void refresh();
  }, [key, refresh]);
  useRealtime("changed", (payload) => {
    if (latest.current.relevant(payload)) void refresh();
  });
  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && previous.current !== "connected") void refresh();
    previous.current = connection;
  }, [connection, refresh]);
  return { value, error, refresh };
}

/** A change signal for one thread, or for every thread. */
/** The reserved thread your machines belong to (036). */
export const OPERATOR = "operator";

export function forThread(threadId: string) {
  return (payload: unknown) => {
    const changed = (payload as { threadId?: unknown } | null)?.threadId;
    return changed === null || changed === undefined || changed === threadId;
  };
}

export type Tone = "ok" | "busy" | "off" | "bad" | "warn";

/**
 * BB's status dot: a filled dot in the tone's colour, a ring for off, a
 * spinner for busy, in a box the height of one line of the text beside it
 * (leading-snug), so the dot and the spinner both centre on the status
 * line's first line (the operator's note of 2 October 2026: the spinner
 * had sat low and off-centre against "Starting").
 */
export function StatusDot({ tone, className }: { tone: Tone; className?: string }) {
  return (
    <span aria-hidden className={cn("inline-flex h-[1.375em] shrink-0 items-center", className)}>
      {tone === "busy" ? (
        <Icon name="Loading" className="size-3 animate-spin text-muted-foreground" />
      ) : (
        <span
          className={cn(
            "size-1.5 rounded-full",
            tone === "ok" && "bg-success",
            tone === "warn" && "bg-warning",
            tone === "bad" && "bg-destructive",
            tone === "off" && "border border-muted-foreground",
          )}
        />
      )}
    </span>
  );
}

/** Shows the whole text as a tooltip on hover, only while the trigger, or a part of it marked data-cut, does not show all of it. */
function WhenCut({ full, children }: { full: string; children: ReactNode }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const cut = () => {
    const shown = trigger.current;
    if (!shown) return false;
    const over = (element: Element) => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1;
    return over(shown) || Array.from(shown.querySelectorAll("[data-cut]")).some(over);
  };
  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip open={open} onOpenChange={(next) => setOpen(next && cut())}>
        <TooltipTrigger ref={trigger} asChild>
          {children}
        </TooltipTrigger>
        <TooltipContent>{full}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Text on one line, cut at the end with an ellipsis; when it is cut, hovering shows the whole of it. */
export function OneLine({ children, full, className }: { children: ReactNode; /** The whole text, for the tooltip. */ full: string; className?: string }) {
  return (
    <WhenCut full={full}>
      <span className={cn("block min-w-0 truncate", className)}>{children}</span>
    </WhenCut>
  );
}

/** One item of a status line, coloured by what it says. */
export interface LineItem {
  readonly text: string;
  /** Foreground for what matters, warning or destructive for what is wrong; muted otherwise. */
  readonly tone?: "fg" | "warn" | "danger";
}

/**
 * A box row's second line: its dot, then its items separated by BB's middle
 * dot, on one line however narrow the panel. The state comes first and what
 * to act on next. Items that do not fit drop from the end, whole, with their
 * dot, rather than being cut mid-word: the BB machine's timing and the size
 * go first, and the details say both. The state itself is cut only when it
 * alone does not fit. Hovering a line that lost anything shows all of it.
 */
export function StatusLine({ tone, items }: { tone: Tone; items: readonly (LineItem | string | null | undefined | false)[] }) {
  const shown = items.flatMap((item): LineItem[] => (item ? [typeof item === "string" ? { text: item } : item] : []));
  return (
    <div className="mt-0.5 flex min-w-0 items-start gap-1.5 text-xs leading-snug text-muted-foreground">
      <StatusDot tone={tone} />
      <WhenCut full={shown.map((item) => item.text).join(" · ")}>
        {/* One line high: an item that does not fit wraps to the second line, which is out of sight. */}
        <span data-status-line className="flex h-[1.375em] min-w-0 flex-wrap items-center gap-x-1.5 overflow-hidden">
          {shown.map((item, index) => (
            <span key={index} className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", index === 0 && "min-w-0")}>
              {index ? (
                <span aria-hidden className="text-subtle-foreground">
                  ·
                </span>
              ) : null}
              <span data-cut={index === 0 ? "" : undefined} className={cn(index === 0 && "min-w-0 truncate", item.tone === "fg" && "text-foreground", item.tone === "warn" && "text-warning-text", item.tone === "danger" && "text-destructive-text")}>
                {item.text}
              </span>
            </span>
          ))}
        </span>
      </WhenCut>
    </div>
  );
}

export interface TitleBadge {
  readonly label: string;
  readonly rank: number;
  readonly outranksSystem?: boolean;
}

export interface TitleWidths {
  readonly room: number;
  readonly name: number;
  readonly system: number;
  readonly model: number;
  readonly badges: readonly { readonly width: number; readonly rank: number; readonly outranksSystem?: boolean }[];
}

export interface TitleFit {
  readonly nameRoom: number | null;
  readonly showsSystem: boolean;
  readonly modelRoom: number | null;
  readonly showsModel: boolean;
  readonly showsBadge: readonly boolean[];
}

export const TITLE_GAP_PX = 8;
export const BADGE_GAP_PX = 4;
export const MODEL_LEAST_PX = 32;

function placeParts({ room, name, system, model, badges }: TitleWidths, showsSystem: boolean): TitleFit {
  const noBadges = badges.map(() => false);
  if (name >= room) return { nameRoom: room, showsSystem: false, modelRoom: null, showsModel: false, showsBadge: noBadges };
  const systemCost = showsSystem ? TITLE_GAP_PX + system : 0;
  if (name + systemCost > room) return { nameRoom: null, showsSystem: false, modelRoom: null, showsModel: false, showsBadge: noBadges };
  let left = room - name - systemCost;
  const showsBadge = [...noBadges];
  const byRank = badges.map((_, index) => index).sort((a, b) => badges[a]!.rank - badges[b]!.rank || a - b);
  for (const index of byRank) {
    const cost = badges[index]!.width + (showsBadge.includes(true) ? BADGE_GAP_PX : TITLE_GAP_PX);
    if (cost > left) continue;
    showsBadge[index] = true;
    left -= cost;
  }
  const modelLeft = left - TITLE_GAP_PX;
  if (model > 0 && model <= modelLeft) return { nameRoom: null, showsSystem, modelRoom: null, showsModel: true, showsBadge };
  if (model > 0 && modelLeft >= MODEL_LEAST_PX) return { nameRoom: null, showsSystem, modelRoom: modelLeft, showsModel: true, showsBadge };
  return { nameRoom: null, showsSystem, modelRoom: null, showsModel: false, showsBadge };
}

export function fitTitle(widths: TitleWidths): TitleFit {
  const withSystem = placeParts(widths, true);
  const missesWhatOutranksSystem = (fit: TitleFit) => widths.badges.some((badge, index) => badge.outranksSystem && !fit.showsBadge[index]);
  if (!missesWhatOutranksSystem(withSystem)) return withSystem;
  const withoutSystem = placeParts(widths, false);
  return missesWhatOutranksSystem(withoutSystem) ? withSystem : withoutSystem;
}

const OUT_OF_FLOW = "invisible absolute";

function widthOf(element: Element | null | undefined): number {
  return element ? Math.ceil(element.getBoundingClientRect().width) : 0;
}

function measuredTitle(title: HTMLElement, badges: readonly TitleBadge[]): TitleWidths {
  const part = (name: string) => title.querySelector(`[data-title-part="${name}"]`);
  return {
    room: title.clientWidth,
    name: part("name")?.firstElementChild?.scrollWidth ?? 0,
    system: widthOf(part("system")),
    model: part("model")?.scrollWidth ?? 0,
    badges: Array.from(title.querySelectorAll("[data-badge-rank]")).map((badge, index) => ({ width: widthOf(badge), rank: badges[index]?.rank ?? 0, outranksSystem: badges[index]?.outranksSystem })),
  };
}

function useTitleFit(badges: readonly TitleBadge[], parts: string): [RefObject<HTMLSpanElement | null>, TitleFit | null] {
  const title = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState<TitleFit | null>(null);
  useLayoutEffect(() => {
    const shown = title.current;
    if (!shown || typeof ResizeObserver !== "function") return;
    const refit = () => setFit(fitTitle(measuredTitle(shown, badges)));
    refit();
    const observer = new ResizeObserver(refit);
    observer.observe(shown);
    return () => observer.disconnect();
  }, [parts]);
  return [title, fit];
}

export function RowTitle({ name, os, device = null, badges }: { name: string; os: string; device?: string | null; badges: readonly TitleBadge[] }) {
  const [title, fit] = useTitleFit(badges, [name, os, device ?? "", ...badges.map((badge) => `${badge.rank}:${badge.label}`)].join("\n"));
  return (
    <span ref={title} data-row-title className="relative flex min-w-0 items-center gap-x-2 overflow-hidden whitespace-nowrap">
      <span data-title-part="name" className="min-w-0 shrink-0" style={fit?.nameRoom ? { maxWidth: fit.nameRoom } : undefined}>
        <OneLine full={name} className="text-sm text-foreground">
          {name}
        </OneLine>
      </span>
      <span data-title-part="system" className={cn("shrink-0 text-xs font-normal text-muted-foreground", fit && !fit.showsSystem && OUT_OF_FLOW)}>
        {os}
      </span>
      {device ? (
        <span data-title-part="model" className={cn("min-w-0 shrink-0 truncate text-xs font-normal text-foreground", fit && !fit.showsModel && OUT_OF_FLOW)} style={fit?.modelRoom ? { maxWidth: fit.modelRoom } : undefined}>
          {device}
        </span>
      ) : null}
      {badges.length ? (
        <span data-row-badges className="flex shrink-0 items-center gap-1">
          {badges.map((badge, index) => (
            <Badge key={badge.label} data-badge-rank={badge.rank} className={cn(fit && !fit.showsBadge[index] && OUT_OF_FLOW)}>
              {badge.label}
            </Badge>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Items separated by BB's middle dot, wrapping where they must. Each item
 * carries its dot before it, and the list sits one dot's width to the left in
 * a box that clips, so the dot of whichever item starts a line, the first or
 * a wrapped one, is out of sight: no line begins with a dot (the operator,
 * 8 October 2026).
 */
export function Meta({ items, className }: { items: readonly (ReactNode | null | undefined | false)[]; className?: string }) {
  const visible = items.filter((item) => item !== null && item !== undefined && item !== false);
  return (
    <span className={cn("inline-flex min-w-0 overflow-hidden", className)}>
      <span className="-ml-[1.25em] inline-flex min-w-0 flex-wrap items-center gap-y-0.5">
        {visible.map((item, index) => (
          <span key={index} className="inline-flex min-w-0 items-center">
            <span aria-hidden className="w-[1.25em] shrink-0 text-center text-subtle-foreground">
              ·
            </span>
            <span className="min-w-0">{item}</span>
          </span>
        ))}
      </span>
    </span>
  );
}

/** BB's ghost icon button with a tooltip, for a row's quick actions. */
export function IconButton({
  label,
  icon,
  onClick,
  disabled,
  loading,
  className,
}: {
  label: string;
  /** BB's icon by name, or one of the plugin's own glyphs. */
  icon: string | ReactNode;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  className?: string;
}) {
  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn("size-7 p-0 text-muted-foreground hover:text-foreground", className)}
            aria-label={label}
            aria-busy={loading}
            disabled={disabled}
            onClick={onClick}
          >
            {loading ? <Icon name="Loading" className="size-4 animate-spin" aria-hidden /> : typeof icon === "string" ? <Icon name={icon} className="size-4" aria-hidden /> : icon}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * IconButton's look, as a link: for a place in BB's app, such as its settings. BB's `openUrl` takes only http(s) URLs
 * and returns false for an app path, so a button calling it with one does nothing; `UrlLink` routes an app path in the
 * app, as a real anchor (5 October 2026, when the Boxes page's settings button did nothing).
 */
export function IconLink({ label, icon, href, className }: { label: string; icon: string | ReactNode; href: string; className?: string }) {
  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button asChild variant="ghost" size="icon" className={cn("size-7 p-0 text-muted-foreground hover:text-foreground", className)}>
            <UrlLink href={href} aria-label={label}>
              {typeof icon === "string" ? <Icon name={icon} className="size-4" aria-hidden /> : icon}
            </UrlLink>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** A toolbar's way back: an action, or a place in BB's app, which is a link (see IconLink). */
export type BackTo = { readonly label: string; readonly go: () => void } | { readonly label: string; readonly href: string };

/** The back arrow at a toolbar's start. */
export function BackControl({ back }: { back: BackTo }) {
  return "href" in back ? <IconLink label={back.label} icon="ArrowLeft" href={back.href} className="-ml-1" /> : <IconButton label={back.label} icon="ArrowLeft" onClick={back.go} className="-ml-1" />;
}

/** bb-box's settings page in BB. */
export const SETTINGS_PATH = "/settings/plugins/bb-box";

/** The thread panel action that holds the Box panel, so a bare Desktop or Terminal tab can offer it. */
export const BOXES_ACTION = "boxes";

/** BB's chip: one small bordered word, as its machine picker and settings sections show one. */
export function Badge({ children, tone = "muted", className, "data-badge-rank": rank }: { children: ReactNode; tone?: "muted" | "warn"; className?: string; "data-badge-rank"?: number }) {
  return <span data-badge-rank={rank} className={cn("shrink-0 rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-2xs leading-none", tone === "warn" ? "text-warning-text" : "text-subtle-foreground", className)}>{children}</span>;
}

export function hasViewer(box: Pick<BoxView, "desktop" | "device">): boolean {
  return box.desktop || !!box.device;
}

/** The name the panel gives a kind or a box: its OS. Badges say the rest (the operator, 1 October 2026). */
export function osName(os: string): string {
  return os === "macos" ? "macOS" : os === "windows" ? "Windows" : os === "linux" ? "Linux" : os;
}

export function systemName(box: Pick<BoxView, "os" | "device">): string {
  return box.device ? platformWord(box.device.platform) : osName(box.os);
}

export function deviceModelOf(box: Pick<BoxView, "device">): string | null {
  return box.device?.model ?? null;
}

export function hostFormBadges(box: Pick<BoxView, "form" | "shared">): readonly BoxForm[] {
  return box.form && !box.shared ? [box.form] : [];
}

/** An arm64 kind or box has a badge, except on macOS, which is always arm64 (040). */
export function isArm64Badge(os: string, arch: string): boolean {
  return arch === "arm64" && os !== "macos";
}

/**
 * A Linux kind or box without Docker says "No Docker" (041). Every other
 * Linux box has it, other systems never did, and a kind whose offers differ
 * (docker null) has no badge.
 */
export function lacksDocker({ os, docker }: { readonly os: string; readonly docker: boolean | null }): boolean {
  return os === "linux" && docker === false;
}

/**
 * What a kind or a box is beyond its OS, as badges: Desktop, Wayland, GPU, No Docker
 * (041), arm64 (040; macOS is always arm64, so it has none), then what its
 * boxes are (LXC, Container, VM, Physical), then Ready now for a kind with a
 * spare (032). In a wrapping line they go under the name rather than
 * squeeze it.
 */
export function KindBadges({
  deviceWord = null,
  desktop = false,
  wayland = false,
  gpu,
  noDocker = false,
  arm64 = false,
  forms,
  shared = false,
  ready = false,
  machine = false,
  className,
}: {
  deviceWord?: string | null;
  desktop?: boolean;
  wayland?: boolean;
  gpu: boolean;
  /** The kind, or box, has no Docker (041: every Linux box has it, so only its absence is said). */
  noDocker?: boolean;
  /** The kind is arm64 (040); a badge tells two Linux kinds apart. */
  arm64?: boolean;
  forms: readonly BoxForm[];
  shared?: boolean;
  /** A spare is ready (032). */
  ready?: boolean;
  /** The BB machine this thread runs on (036), in the Box panel and the bare Desktop and Terminal choosers. One of the group, so its gap is the others' (the operator, 4 October 2026). */
  machine?: boolean;
  className?: string;
}) {
  if (!deviceWord && !desktop && !gpu && !noDocker && !arm64 && !forms.length && !shared && !ready && !machine) return null;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", className)}>
      {deviceWord ? <Badge>{deviceWord}</Badge> : null}
      {desktop ? <Badge>Desktop</Badge> : null}
      {wayland ? <Badge>Wayland</Badge> : null}
      {gpu ? <Badge>GPU</Badge> : null}
      {noDocker ? <Badge>No Docker</Badge> : null}
      {arm64 ? <Badge>arm64</Badge> : null}
      {forms.map((form) => (
        <Badge key={form}>{formBadge(form)}</Badge>
      ))}
      {shared ? <Badge>Shared</Badge> : null}
      {ready ? <Badge>Ready now</Badge> : null}
      {machine ? <Badge>BB machine</Badge> : null}
    </span>
  );
}

export const BADGE_RANKS = { device: 0, shared: 1, form: 2, desktop: 3, more: 4 } as const;

export function boxTitleBadges(box: BoxView, machine = false): readonly TitleBadge[] {
  const badge = (label: string | false | null, rank: number) => (label ? [{ label, rank }] : []);
  return [
    ...(box.device ? [{ label: screenWord(box, "device"), rank: BADGE_RANKS.device, outranksSystem: true }] : []),
    ...badge(box.desktop && "Desktop", BADGE_RANKS.desktop),
    ...badge(runsWayland(box) && "Wayland", BADGE_RANKS.more),
    ...badge(box.gpu && "GPU", BADGE_RANKS.more),
    ...badge(lacksDocker(box) && "No Docker", BADGE_RANKS.more),
    ...badge(isArm64Badge(box.os, box.arch) && "arm64", BADGE_RANKS.more),
    ...hostFormBadges(box).map((form) => ({ label: formBadge(form), rank: BADGE_RANKS.form })),
    ...badge(box.shared && "Shared", BADGE_RANKS.shared),
    ...badge(machine && "BB machine", BADGE_RANKS.form),
  ];
}

export function BoxBadges({ box, machine = false }: { box: BoxView; machine?: boolean }) {
  const badges = boxTitleBadges(box, machine);
  if (!badges.length) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {badges.map((badge) => (
        <Badge key={badge.label}>{badge.label}</Badge>
      ))}
    </span>
  );
}

/** A form's badge: the Docker backend's boxes read "Container", so the word Docker means the feature (041). */
export function formBadge(form: BoxForm): string {
  return form === "Docker" ? "Container" : form;
}

/** BB's dashed empty panel. */
export function EmptyPanel({ title, children, className, role }: { title?: string; children?: ReactNode; className?: string; role?: string }) {
  return (
    <div role={role} className={cn("rounded-md border border-dashed border-border px-6 py-6 text-center text-sm text-subtle-foreground", className)}>
      <div className="mx-auto max-w-md">
        {title ? <p className="text-foreground">{title}</p> : null}
        {children}
      </div>
    </div>
  );
}

/** A notice centred on a surface, in BB's card style: a line, a muted second line, at most one action. */
export function ReleasedNotice({ name, back }: { name: string | null; back?: BackTo }) {
  const words = name ? `${name} has been released.` : "This box has been released.";
  if (!back) return <Notice detail="Close this tab when you are done with it.">{words}</Notice>;
  const button = "href" in back ? (
    <Button asChild variant="outline" size="sm" className="h-7">
      <a href={back.href}>{back.label}</a>
    </Button>
  ) : (
    <Button type="button" variant="outline" size="sm" className="h-7" onClick={back.go}>
      {back.label}
    </Button>
  );
  return <Notice action={button}>{words}</Notice>;
}

export function Notice({ children, detail, action }: { children: ReactNode; detail?: ReactNode; action?: ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-4">
      <div className="flex max-w-xs flex-col items-center gap-2 rounded-md border border-border bg-card px-4 py-3 text-center text-sm text-muted-foreground">
        <span>{children}</span>
        {detail ? <span className="text-xs text-subtle-foreground">{detail}</span> : null}
        {action}
      </div>
    </div>
  );
}
