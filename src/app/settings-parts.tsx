import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { HugeiconsIcon } from "@hugeicons/react";
import { CloudIcon } from "@hugeicons/core-free-icons";
import { useEffect, useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { BackendConfig } from "../core/document.ts";
import type { ConfigState } from "../plugin/configuration.ts";
import { Badge, Meta, StatusDot, type Tone } from "./common.tsx";
import { backendHostChip, onBbMachine } from "./settings-status.ts";
import { useSettings } from "./settings-context.tsx";

export const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

const PROVIDER_ICONS: Readonly<Record<string, string>> = {
  "proxmox-lxc": "bb-box/proxmox",
  "proxmox-qemu": "bb-box/proxmox",
  docker: "bb-box/docker",
  tart: "bb-box/laptop",
  "ssh-pool": "bb-box/server",
  microsandbox: "bb-box/plug",
};

const CLOUD_PROVIDERS = new Set(["hetzner", "namespace"]);

export function ProviderGlyph({ type, className }: { type: string; className?: string }) {
  if (CLOUD_PROVIDERS.has(type)) return <HugeiconsIcon icon={CloudIcon} className={cn("size-4 shrink-0 text-muted-foreground", className)} aria-hidden="true" />;
  return <Icon name={PROVIDER_ICONS[type] ?? "bb-box/box"} className={cn("size-4 shrink-0 text-muted-foreground", className)} aria-hidden />;
}

export function Group({ title, description, action, children }: { title: string; description?: ReactNode; action?: ReactNode; children: ReactNode }) {
  const headingId = useId();
  return (
    <section className="space-y-2.5" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <h3 id={headingId} className="text-xs font-normal text-foreground">
            {title}
          </h3>
          {description ? <p className="mt-0.5 text-xs leading-snug text-subtle-foreground">{description}</p> : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-1.5">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("overflow-hidden rounded-lg border border-border bg-card", className)}>{children}</div>;
}

export function Rows({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-border">{children}</div>;
}

export function StateLine({ tone, words, items, className, id }: { tone: Tone; words: string; items?: readonly ReactNode[]; className?: string; id?: string }) {
  return (
    <span id={id} className={cn("flex min-w-0 items-start gap-1.5 text-xs leading-snug text-muted-foreground", className)}>
      <StatusDot tone={tone} />
      <Meta
        items={[
          <span key="words" className={cn(tone === "warn" && "text-warning-text", tone === "bad" && "text-destructive-text")}>
            {words}
          </span>,
          ...(items ?? []),
        ]}
      />
    </span>
  );
}

export function Chevron({ outward = false }: { outward?: boolean }) {
  return <Icon name={outward ? "ArrowUpRight" : "ChevronRight"} className="size-4 shrink-0 text-subtle-foreground" aria-hidden />;
}

export function PageHeading({ children, chips }: { children: ReactNode; chips?: ReactNode }) {
  return (
    <h2 tabIndex={-1} data-page-heading className="flex min-w-0 flex-wrap items-center gap-1.5 text-base font-normal leading-tight text-foreground outline-none">
      <span className="min-w-0 break-words">{children}</span>
      {chips}
    </h2>
  );
}

export function PageHeader({ glyph, title, chips, description, aside, children }: { glyph?: ReactNode; title: string; chips?: ReactNode; description?: ReactNode; aside?: ReactNode; children?: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start gap-3">
        {glyph ? <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-raised">{glyph}</span> : null}
        <div className="min-w-0 flex-1">
          <PageHeading chips={chips}>{title}</PageHeading>
          {description ? <div className="mt-1 text-xs leading-snug text-subtle-foreground">{description}</div> : null}
        </div>
        {aside ? <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">{aside}</div> : null}
      </div>
      {children}
    </div>
  );
}

const SAVED_FADE_MS = 180;

export function SavedTick({ show }: { show: boolean }) {
  const [present, setPresent] = useState(show);
  const [visible, setVisible] = useState(show);
  useEffect(() => {
    if (show) {
      setPresent(true);
      const frame = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(frame);
    }
    const shown = present;
    setVisible(false);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    if (reduce || !shown) {
      setPresent(false);
      return;
    }
    const timer = window.setTimeout(() => setPresent(false), SAVED_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [show, present]);
  return (
    <span role="status" aria-live="polite" className="inline-flex shrink-0 items-center empty:hidden">
      {present ? (
        <span className={cn("inline-flex items-center gap-1 text-2xs text-muted-foreground transition-opacity duration-150 motion-reduce:transition-none", visible ? "opacity-100" : "opacity-0")}>
          <Icon name="Check" className="size-3" aria-hidden />
          Saved
        </span>
      ) : null}
    </span>
  );
}

export function RowNote({ note, className }: { note: string | { readonly text: string; readonly tone: "bad" | "info" } | null; className?: string }) {
  if (!note) return null;
  const { text, tone } = typeof note === "string" ? { text: note, tone: "bad" as const } : note;
  return (
    <p role={tone === "bad" ? "alert" : "status"} className={cn("text-xs leading-snug", tone === "bad" ? "text-destructive-text" : "text-muted-foreground", className)}>
      {text}
    </p>
  );
}

export function RowButton({ rowKey, label, describedBy, onClick }: { rowKey: string; label: string; describedBy?: string; onClick: () => void }) {
  return <button type="button" data-row-key={rowKey} aria-label={label} aria-describedby={describedBy} onClick={onClick} className={cn("absolute inset-0 cursor-pointer", FOCUS_RING)} />;
}

export function RowControl({ children }: { children: ReactNode }) {
  return <span className="relative z-10 flex w-7 shrink-0 items-center justify-end">{children}</span>;
}

export function NavRow({ icon, title, chips, value, tone, onClick, outward = false, rowKey, control, saved, valueId }: { icon: ReactNode; title: string; chips?: ReactNode; value?: ReactNode; tone?: Tone; onClick: () => void; outward?: boolean; rowKey: string; control?: ReactNode; saved?: ReactNode; valueId?: string }) {
  const chipsId = useId();
  return (
    <div className="relative flex flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-2.5 transition-colors duration-150 hover:bg-state-hover">
      <RowButton rowKey={rowKey} label={title} describedBy={[chips ? chipsId : null, value ? valueId : null].filter(Boolean).join(" ") || undefined} onClick={onClick} />
      <span className="pointer-events-none flex size-5 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
      <span className="pointer-events-none text-sm text-foreground" aria-hidden>
        {title}
      </span>
      {chips ? (
        <span id={chipsId} className="pointer-events-none flex items-center gap-1.5 empty:hidden">
          {chips}
        </span>
      ) : null}
      <span className="pointer-events-none min-w-0 flex-1" />
      {value ? (
        <span id={valueId} className={cn("pointer-events-none order-last flex min-w-0 basis-full items-center gap-1.5 pl-8 text-xs text-muted-foreground sm:order-none sm:basis-auto sm:pl-0", tone === "warn" && "text-warning-text")}>
          {tone ? <StatusDot tone={tone} /> : null}
          <span className="truncate">{value}</span>
        </span>
      ) : null}
      {saved ? <span className="pointer-events-none">{saved}</span> : null}
      {control ? <RowControl>{control}</RowControl> : null}
      <span className="pointer-events-none">
        <Chevron outward={outward} />
      </span>
    </div>
  );
}

export function SettingRow({ label, description, problem, children, htmlFor, path }: { label: string; description?: ReactNode; problem?: string | null; children: ReactNode; htmlFor?: string; path?: string }) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-5" data-setting-row={path}>
      <div className="min-w-0 flex-1">
        <label htmlFor={htmlFor} className="text-sm text-foreground">
          {label}
        </label>
        {description ? <p className="mt-0.5 text-xs leading-snug text-subtle-foreground">{description}</p> : null}
      </div>
      <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
        <div className="flex items-center gap-2">{children}</div>
        {problem ? (
          <p role="alert" className="text-xs text-destructive-text">
            {problem}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function TextLink({ onClick, children, className }: { onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <button type="button" onClick={onClick} className={cn("cursor-pointer rounded-sm text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", className)}>
      {children}
    </button>
  );
}

export function NotHere({ what }: { what: string }) {
  const { nav } = useSettings();
  return (
    <div className="space-y-3">
      <PageHeader title={`This ${what} is not here`} description={`BB Box's configuration has no such ${what}. It may have been removed, or the link may be wrong.`} />
      <Button type="button" variant="outline" size="sm" className="h-8" onClick={nav.toOverview}>
        Go to BB Box settings
      </Button>
    </div>
  );
}

export function BackendChips({ state, config }: { state: ConfigState; config: BackendConfig }) {
  const chip = backendHostChip(state, config);
  return (
    <>
      {chip ? <Badge>{chip}</Badge> : null}
      {onBbMachine(config) ? <Badge>BB machine</Badge> : null}
    </>
  );
}
