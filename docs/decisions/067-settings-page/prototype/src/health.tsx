import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { StatusDot, type Tone } from "@/src/app/common.tsx";
import type { Check, Health } from "./data";
import { relative } from "./store";
import { Card, Icon } from "./ui";

const CHECK_ICON: Record<Check["status"], { icon: string; className: string; label: string }> = {
  ok: { icon: "CircleCheck", className: "text-success", label: "Passed" },
  warn: { icon: "AlertTriangle", className: "text-warning", label: "Warning" },
  fail: { icon: "X", className: "text-destructive", label: "Failed" },
  skipped: { icon: "Minus", className: "text-subtle-foreground", label: "Skipped" },
};

function CheckRow({ check }: { check: Check }) {
  const { icon, className, label } = CHECK_ICON[check.status];
  return (
    <li className="grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-2.5 text-xs leading-snug">
      <Icon name={icon} className={cn("mt-px size-4", className)} aria-label={label} />
      <div className="min-w-0">
        <p className={cn("font-medium", check.status === "skipped" ? "text-muted-foreground" : "text-foreground")}>{check.name}</p>
        <p className="text-muted-foreground">{check.detail}</p>
        {check.fix && check.status !== "ok" ? (
          <p className="mt-1 text-foreground">
            <span className="text-subtle-foreground">Fix: </span>
            {check.fix}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function Note({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [lead, ...rest] = text.split("\n");
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">{lead}</p>
      <div className="flex items-start gap-2 rounded-md bg-surface-recessed px-2.5 py-2">
        <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-2xs leading-relaxed text-foreground">{rest.join("\n")}</pre>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 px-2 text-2xs"
          onClick={() => {
            void navigator.clipboard?.writeText(rest.join("\n"));
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
        >
          <Icon name={copied ? "Check" : "Copy"} className="size-3.5" aria-hidden />
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

export function healthTone(health: Health | null, checking: boolean): { tone: Tone; words: string } {
  if (checking) return { tone: "busy", words: "Checking…" };
  if (!health) return { tone: "off", words: "Not checked" };
  if (health.checks.some((check) => check.status === "fail")) return { tone: "bad", words: "Not working" };
  if (health.checks.some((check) => check.status === "warn")) return { tone: "warn", words: "Needs attention" };
  return { tone: "ok", words: "Ready" };
}

export function HealthCard({ health, checking, onCheck, againstDraft, off }: { health: Health | null; checking: boolean; onCheck: () => void; againstDraft?: boolean; off?: boolean }) {
  const [all, setAll] = useState(false);
  const { tone, words } = off && !checking && !againstDraft ? { tone: "off" as Tone, words: "Off" } : healthTone(health, checking);
  const problems = health?.checks.filter((check) => check.status === "fail" || check.status === "warn") ?? [];
  const rest = health?.checks.filter((check) => !problems.includes(check)) ?? [];
  const passed = health?.checks.filter((check) => check.status === "ok").length ?? 0;
  return (
    <Card className={cn(tone === "bad" && "border-surface-destructive-border", tone === "warn" && "border-surface-warning-border")}>
      <div className="flex items-start gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-sm text-foreground">
            <StatusDot tone={tone} />
            <span className={cn("font-medium", tone === "bad" && "text-destructive-text", tone === "warn" && "text-warning-text")}>{words}</span>
            {health && !checking ? <span className="truncate text-muted-foreground">· {health.summary}</span> : null}
          </p>
          <p className="mt-0.5 pl-3 text-xs text-subtle-foreground">
            {checking
              ? "Running its checks, up to 30 s."
              : off && !againstDraft
                ? "Off: it takes no new boxes. Check it before you turn it on."
                : health
                  ? againstDraft
                    ? "Checked just now, against your changes. Nothing is saved yet."
                    : `${passed} of ${health.checks.length} checks passed · checked ${relative(health.checkedAt)}`
                  : "Not checked yet."}
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" className="h-7 shrink-0" disabled={checking} onClick={onCheck}>
          {checking ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
          {checking ? "Checking…" : health ? "Check again" : "Check"}
        </Button>
      </div>
      {!checking && problems.length ? (
        <ul className="space-y-3 border-t border-border px-4 py-3">
          {problems.map((check) => (
            <CheckRow key={check.id} check={check} />
          ))}
        </ul>
      ) : null}
      {!checking && health && (health.notes?.length ?? 0) > 0 ? (
        <div className="space-y-2 border-t border-border px-4 py-3">
          {health.notes!.map((note) => (
            <Note key={note} text={note} />
          ))}
        </div>
      ) : null}
      {!checking && rest.length ? (
        <div className="border-t border-border">
          <button type="button" onClick={() => setAll((current) => !current)} aria-expanded={all} className="flex w-full cursor-pointer items-center gap-1.5 px-4 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground">
            <Icon name={all ? "ChevronDown" : "ChevronRight"} className="size-3.5" aria-hidden />
            {all ? "Hide the checks" : problems.length ? `${rest.length} other checks` : `Show the ${rest.length} checks`}
          </button>
          {all ? (
            <ul className="space-y-2.5 px-4 pb-3 pt-1">
              {rest.map((check) => (
                <CheckRow key={check.id} check={check} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
