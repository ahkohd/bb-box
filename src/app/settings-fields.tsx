import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { ReactNode } from "react";
import { Badge } from "./common.tsx";

export function Section({
  title,
  description,
  action,
  plain = false,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  plain?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-xs font-normal text-foreground">{title}</h3>
          {description ? <p className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">{description}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {plain ? (
        <div className="space-y-2">{children}</div>
      ) : (
        <div className="rounded-lg border border-border bg-card px-4 py-3.5">
          <div className="divide-y divide-border">{children}</div>
        </div>
      )}
    </section>
  );
}

export function Chip({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "warn" }) {
  return <Badge tone={tone}>{children}</Badge>;
}

export function FormHeading({ children, open, onToggle }: { children: ReactNode; open?: boolean; onToggle?: () => void }) {
  if (onToggle) {
    return (
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5" aria-hidden />
        {children}
      </button>
    );
  }
  return <p className="text-xs text-muted-foreground">{children}</p>;
}
