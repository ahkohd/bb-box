// Pieces the panels share: live state from the server that follows its
// change signals, a ticking clock, words for times, and small controls in
// BB's style.

import { experimental_Icon as Icon, useRealtime, useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
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
export function useLive<T>(key: string, load: () => Promise<T>, relevant: (payload: unknown) => boolean) {
  const latest = useRef({ load, relevant });
  latest.current = { load, relevant };
  const sequence = useRef(0);
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const mine = ++sequence.current;
    try {
      const next = await latest.current.load();
      if (mine !== sequence.current) return;
      setValue(next);
      setError(null);
    } catch (caught) {
      if (mine === sequence.current) setError(message(caught));
    }
  }, []);
  useEffect(() => {
    setValue(null);
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
export function forThread(threadId: string) {
  return (payload: unknown) => {
    const changed = (payload as { threadId?: unknown } | null)?.threadId;
    return changed === null || changed === undefined || changed === threadId;
  };
}

export type Tone = "ok" | "busy" | "off" | "bad" | "warn";

/** BB's status dot: a filled dot in the tone's colour, a ring for off, a spinner for busy. */
export function StatusDot({ tone, className }: { tone: Tone; className?: string }) {
  if (tone === "busy") return <Icon name="Loading" className={cn("size-3 shrink-0 animate-spin text-muted-foreground", className)} aria-hidden />;
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        tone === "ok" && "bg-success",
        tone === "warn" && "bg-warning",
        tone === "bad" && "bg-destructive",
        tone === "off" && "border border-muted-foreground",
        className,
      )}
    />
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
  icon: string;
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
            <Icon name={loading ? "Loading" : icon} className={cn("size-4", loading && "animate-spin")} aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** BB's chip: one small bordered word, as its machine picker and settings sections show one. */
export function Badge({ children, tone = "muted", className }: { children: ReactNode; tone?: "muted" | "warn"; className?: string }) {
  return <span className={cn("shrink-0 rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-2xs leading-none", tone === "warn" ? "text-warning-text" : "text-subtle-foreground", className)}>{children}</span>;
}

/** What a kind or a box has beyond its label, as badges: GPU, then what its boxes are (LXC, Docker, VM, Physical). */
export function KindBadges({ gpu, forms, className }: { gpu: boolean; forms: readonly string[]; className?: string }) {
  if (!gpu && !forms.length) return null;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", className)}>
      {gpu ? <Badge>GPU</Badge> : null}
      {forms.map((form) => (
        <Badge key={form}>{form}</Badge>
      ))}
    </span>
  );
}

/** BB's dashed empty panel. */
export function EmptyPanel({ title, children, className, role }: { title?: string; children?: ReactNode; className?: string; role?: string }) {
  return (
    <div role={role} className={cn("rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground", className)}>
      {title ? <p className="font-medium text-foreground">{title}</p> : null}
      {children}
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
