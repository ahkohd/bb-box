import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageNotice({ tone, title, children, actions }: { tone: "bad" | "warn"; title: string; children?: ReactNode; actions?: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} data-notice={tone} className={cn("rounded-lg border px-4 py-3", tone === "bad" ? "border-surface-destructive-border bg-surface-destructive" : "border-warning/40 bg-warning/5")}>
      <h2 id={headingId} className={cn("text-sm font-normal", tone === "bad" ? "text-destructive-text" : "text-warning-text")}>
        {title}
      </h2>
      {children ? <div className="mt-1 break-words text-sm text-foreground">{children}</div> : null}
      {actions ? <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5">{actions}</div> : null}
    </section>
  );
}
