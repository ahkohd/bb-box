// Pieces the panels share: live state from the server that follows its
// change signals, a ticking clock, words for times, and small controls in
// BB's style.

import type { BoxForm } from "../backends/types.ts";
import { experimental_Icon as Icon, useRealtime, useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

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

/** Forgets every remembered value, for tests. */
export function forgetLive(): void {
  remembered.clear();
}

export function useLive<T>(key: string, load: () => Promise<T>, relevant: (payload: unknown) => boolean) {
  const latest = useRef({ load, relevant });
  latest.current = { load, relevant };
  const sequence = useRef(0);
  const [value, setValue] = useState<T | null>(() => (remembered.has(key) ? (remembered.get(key) as T) : null));
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const mine = ++sequence.current;
    try {
      const next = await latest.current.load();
      if (mine !== sequence.current) return;
      remembered.set(key, next);
      setValue(next);
      setError(null);
    } catch (caught) {
      if (mine === sequence.current) setError(message(caught));
    }
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

/** Items on one line, separated by BB's middle dot. */
export function Meta({ items, className }: { items: readonly (ReactNode | null | undefined | false)[]; className?: string }) {
  const visible = items.filter((item) => item !== null && item !== undefined && item !== false);
  return (
    <span className={cn("inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5", className)}>
      {visible.map((item, index) => (
        <span key={index} className="inline-flex min-w-0 items-center gap-1.5">
          {index > 0 ? (
            <span aria-hidden className="text-subtle-foreground">
              ·
            </span>
          ) : null}
          <span className="min-w-0">{item}</span>
        </span>
      ))}
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

/** bb-box's settings page in BB. */
export const SETTINGS_PATH = "/settings/plugins/bb-box";

/** The thread panel action that holds the Box panel, so a bare Desktop or Terminal tab can offer it. */
export const BOXES_ACTION = "boxes";

/** BB's chip: one small bordered word, as its machine picker and settings sections show one. */
export function Badge({ children, tone = "muted", className }: { children: ReactNode; tone?: "muted" | "warn"; className?: string }) {
  return <span className={cn("shrink-0 rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-2xs leading-none", tone === "warn" ? "text-warning-text" : "text-subtle-foreground", className)}>{children}</span>;
}

/** The name the panel gives a kind or a box: its OS. Badges say the rest (the operator, 1 October 2026). */
export function osName(os: string): string {
  return os === "macos" ? "macOS" : os === "windows" ? "Windows" : os === "linux" ? "Linux" : os;
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
 * What a kind or a box is beyond its OS, as badges: Desktop, GPU, No Docker
 * (041), arm64 (040; macOS is always arm64, so it has none), then what its
 * boxes are (LXC, Container, VM, Physical), then Ready now for a kind with a
 * spare (032). In a wrapping line they go under the name rather than
 * squeeze it.
 */
export function KindBadges({
  desktop = false,
  gpu,
  noDocker = false,
  arm64 = false,
  forms,
  ready = false,
  className,
}: {
  desktop?: boolean;
  gpu: boolean;
  /** The kind, or box, has no Docker (041: every Linux box has it, so only its absence is said). */
  noDocker?: boolean;
  /** The kind is arm64 (040); a badge tells two Linux kinds apart. */
  arm64?: boolean;
  forms: readonly BoxForm[];
  /** A spare is ready (032). */
  ready?: boolean;
  className?: string;
}) {
  if (!desktop && !gpu && !noDocker && !arm64 && !forms.length && !ready) return null;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", className)}>
      {desktop ? <Badge>Desktop</Badge> : null}
      {gpu ? <Badge>GPU</Badge> : null}
      {noDocker ? <Badge>No Docker</Badge> : null}
      {arm64 ? <Badge>arm64</Badge> : null}
      {forms.map((form) => (
        <Badge key={form}>{formBadge(form)}</Badge>
      ))}
      {ready ? <Badge>Ready now</Badge> : null}
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
        {title ? <p className="font-medium text-foreground">{title}</p> : null}
        {children}
      </div>
    </div>
  );
}

/** A notice centred on a surface, in BB's card style: a line, a muted second line, at most one action. */
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
