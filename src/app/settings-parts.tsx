import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { HugeiconsIcon } from "@hugeicons/react";
import { CloudIcon } from "@hugeicons/core-free-icons";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Meta, StatusDot, type Tone } from "./common.tsx";

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
          <h3 id={headingId} className="text-xs font-medium text-foreground">
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
    <h2 tabIndex={-1} data-page-heading className="flex min-w-0 flex-wrap items-center gap-1.5 text-base font-medium leading-tight text-foreground outline-none">
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

export function SavedTick({ show }: { show: boolean }) {
  return (
    <span role="status" aria-live="polite" className="inline-flex shrink-0 items-center empty:hidden">
      {show ? (
        <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
          <Icon name="Check" className="size-3" aria-hidden />
          Saved
        </span>
      ) : null}
    </span>
  );
}

export function RowNote({ note, className }: { note: string | null; className?: string }) {
  if (!note) return null;
  return (
    <p role="alert" className={cn("text-xs leading-snug text-destructive-text", className)}>
      {note}
    </p>
  );
}

export function NavRow({ icon, title, value, tone, onClick, outward = false, rowKey, trailing, valueId, switchColumn = false }: { icon: ReactNode; title: string; value?: ReactNode; tone?: Tone; onClick: () => void; outward?: boolean; rowKey: string; trailing?: ReactNode; valueId?: string; switchColumn?: boolean }) {
  return (
    <div className="flex items-center gap-3 pr-4 transition-colors duration-150 hover:bg-state-hover">
      <button type="button" data-row-key={rowKey} onClick={onClick} aria-describedby={value ? valueId : undefined} className={cn("flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-x-3 gap-y-0.5 py-2.5 pl-4 text-left", FOCUS_RING)}>
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1 text-sm text-foreground">{title}</span>
        {value ? (
          <span id={valueId} className={cn("flex min-w-0 basis-full items-center gap-1.5 pl-8 text-xs text-muted-foreground sm:basis-auto sm:pl-0", tone === "warn" && "text-warning-text")}>
            {tone ? <StatusDot tone={tone} /> : null}
            <span className="truncate">{value}</span>
          </span>
        ) : null}
        <Chevron outward={outward} />
      </button>
      {switchColumn ? <span className="flex w-7 shrink-0 justify-end">{trailing}</span> : trailing}
    </div>
  );
}

export function SettingRow({ label, description, problem, children, htmlFor }: { label: string; description?: ReactNode; problem?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-5">
      <div className="min-w-0 flex-1">
        <label htmlFor={htmlFor} className="text-sm text-foreground">
          {label}
        </label>
        {description ? <p className="mt-0.5 text-xs leading-snug text-subtle-foreground">{description}</p> : null}
        {problem ? (
          <p role="alert" className="mt-0.5 text-xs text-destructive-text">
            {problem}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
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
