import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Badge, Meta, StatusDot, type Tone } from "@/src/app/common.tsx";
import dockerSvg from "@/assets/docker.svg?raw";
import laptopSvg from "@/assets/laptop.svg?raw";
import plugSvg from "@/assets/plug.svg?raw";
import proxmoxSvg from "@/assets/proxmox.svg?raw";
import serverSvg from "@/assets/server.svg?raw";
import boxSvg from "@/assets/icon.svg?raw";
import type { FieldValue, FieldView, Stored } from "./data";
import { useNav } from "./nav";
import { useStore, type Conflict, type Problem, type SaveResult } from "./store";
import type { Document } from "./data";

const GLYPHS: Record<string, string> = {
  "proxmox-lxc": proxmoxSvg,
  "proxmox-qemu": proxmoxSvg,
  docker: dockerSvg,
  tart: laptopSvg,
  "ssh-pool": serverSvg,
  microsandbox: plugSvg,
  box: boxSvg,
};

export function ProviderGlyph({ type, className }: { type: string; className?: string }) {
  if (type === "hetzner" || type === "namespace") return <Icon name="Cloud" className={cn("size-4 text-muted-foreground", className)} aria-hidden />;
  return <span aria-hidden className={cn("inline-flex size-4 text-muted-foreground [&>svg]:size-full", className)} dangerouslySetInnerHTML={{ __html: GLYPHS[type] ?? boxSvg }} />;
}

export function Section({ title, description, action, children, id }: { title: string; description?: ReactNode; action?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="space-y-2.5" id={id}>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-xs font-medium text-foreground">{title}</h3>
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

export function StateLine({ tone, words, items, className }: { tone: Tone; words: string; items?: readonly ReactNode[]; className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-start gap-1.5 text-xs leading-snug text-muted-foreground", className)}>
      <StatusDot tone={tone} />
      <Meta items={[<span key="words" className={cn(tone === "warn" && "text-warning-text", tone === "bad" && "text-destructive-text")}>{words}</span>, ...(items ?? [])]} />
    </div>
  );
}

export function Chevron() {
  return <Icon name="ChevronRight" className="size-4 shrink-0 text-subtle-foreground" aria-hidden />;
}

export function NavRow({ icon, title, value, onClick, external, tone }: { icon: ReactNode; title: string; value?: ReactNode; onClick: () => void; external?: boolean; tone?: Tone }) {
  return (
    <button type="button" onClick={onClick} className="pressable flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none">
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1 text-sm text-foreground">{title}</span>
      {value ? (
        <span className={cn("flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground", tone === "warn" && "text-warning-text")}>
          {tone ? <StatusDot tone={tone} /> : null}
          {value}
        </span>
      ) : null}
      {external ? <Icon name="ArrowUpRight" className="size-4 shrink-0 text-subtle-foreground" aria-hidden /> : <Chevron />}
    </button>
  );
}

export function BackLink() {
  const nav = useNav();
  return (
    <button type="button" onClick={nav.back} className="-ml-1 inline-flex cursor-pointer items-center gap-0.5 rounded-sm px-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
      <Icon name="ChevronLeft" className="size-3.5" aria-hidden />
      BB Box settings
    </button>
  );
}

export function PageHeader({ glyph, title, chips, description, aside }: { glyph?: ReactNode; title: string; chips?: ReactNode; description?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="space-y-3">
      <BackLink />
      <div className="flex items-start gap-3">
        {glyph ? <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-raised">{glyph}</span> : null}
        <div className="min-w-0 flex-1">
          <h2 className="flex min-w-0 flex-wrap items-center gap-1.5 text-base font-medium leading-tight text-foreground">
            <span className="truncate">{title}</span>
            {chips}
          </h2>
          {description ? <p className="mt-1 text-xs leading-snug text-subtle-foreground">{description}</p> : null}
        </div>
        {aside ? <div className="flex shrink-0 items-center gap-2">{aside}</div> : null}
      </div>
    </div>
  );
}

export function SavedTick({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="saved-tick inline-flex items-center gap-1 text-2xs text-muted-foreground" role="status">
      <Icon name="Check" className="size-3" aria-hidden />
      Saved
    </span>
  );
}

export function SettingRow({ id, label, description, problem, problemPath, children, stacked, chips }: { id?: string; label: string; description?: ReactNode; problem?: string | null; problemPath?: string; children: ReactNode; stacked?: boolean; chips?: ReactNode }) {
  const nav = useNav();
  const ref = useRef<HTMLDivElement>(null);
  const found = id !== undefined && nav.found === id;
  useEffect(() => {
    if (found) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [found]);
  return (
    <div ref={ref} data-setting={id} data-problem={problemPath} className={cn("px-4 py-3", found && "found", problem && "bg-surface-destructive")}>
      <div className={cn("flex gap-4", stacked ? "flex-col gap-2" : "items-start justify-between")}>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5 text-sm text-foreground">
            {label}
            {chips}
          </p>
          {description ? <p className="mt-0.5 text-xs leading-snug text-subtle-foreground">{description}</p> : null}
        </div>
        <div className={cn("flex shrink-0 items-center gap-2", stacked && "w-full")}>{children}</div>
      </div>
      {problem ? (
        <p role="alert" className="mt-1.5 text-xs leading-snug text-destructive-text">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

export type FormValue = FieldValue | { readonly set: boolean } | null;

export function SecretInput({ value, onChange, label }: { value: FormValue; onChange: (value: FormValue) => void; label: string }) {
  const [replacing, setReplacing] = useState(false);
  const set = typeof value === "object" && value !== null ? value.set : typeof value === "string" && value !== "";
  if (value === null) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-warning-text">
        Cleared when you save
        <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => onChange({ set: true })}>
          Undo
        </Button>
      </span>
    );
  }
  if (typeof value === "string" || !set || replacing) {
    return (
      <span className="flex w-64 items-center gap-1.5">
        <Input type="password" autoComplete="new-password" aria-label={label} className="h-8 text-xs" placeholder={set || replacing ? "Paste the new value" : "Paste the value"} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)} />
        {replacing ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8"
            onClick={() => {
              setReplacing(false);
              onChange({ set: true });
            }}
          >
            Keep
          </Button>
        ) : null}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-xs text-subtle-foreground">Set</span>
      <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => setReplacing(true)}>
        Replace
      </Button>
      <Button type="button" variant="ghost" size="sm" className="h-7 text-muted-foreground" onClick={() => onChange(null)}>
        Clear
      </Button>
    </span>
  );
}

export function FieldInput({ field, value, onChange, inherited, invalid }: { field: FieldView; value: FormValue; onChange: (value: FormValue) => void; inherited?: string; invalid?: boolean }) {
  const id = useId();
  if (field.secret) return <SecretInput value={value} onChange={onChange} label={field.label} />;
  if (field.type === "boolean") return <Switch id={id} aria-label={field.label} checked={value === true || (value === undefined && field.default === true)} onCheckedChange={onChange} />;
  if (field.type === "select") {
    return (
      <Select value={String(value ?? field.default ?? "")} onValueChange={onChange}>
        <SelectTrigger className="h-8 w-64 text-xs" aria-label={field.label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(field.options ?? []).map((option) => (
            <SelectItem key={option} value={option} className="text-xs">
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  const text = value === undefined || value === null || typeof value === "object" ? "" : String(value);
  const placeholder = inherited ?? (field.default !== undefined && field.default !== "" ? String(field.default) : undefined);
  if (field.experimental_multiline) {
    return <Textarea aria-label={field.label} aria-invalid={invalid || undefined} className="min-h-16 w-full font-mono text-xs" rows={3} value={text} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />;
  }
  return (
    <Input
      aria-label={field.label}
      aria-invalid={invalid || undefined}
      inputMode={field.type === "number" ? "numeric" : undefined}
      className={cn("h-8 text-xs", field.type === "number" ? "w-28 text-right tabular-nums" : "w-64")}
      value={text}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export type BarState =
  | { readonly kind: "idle" }
  | { readonly kind: "dirty" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved"; readonly rebased: boolean }
  | { readonly kind: "problems"; readonly count: number }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "conflict"; readonly conflicts: readonly Conflict[] };

export function SaveBar({ state, changes, what, onSave, onDiscard, onCheck, checking, onKeepMine, onUseSaved, primary = "Save", secondary }: { state: BarState; changes: number; what: string; onSave: () => void; onDiscard: () => void; onCheck?: () => void; checking?: boolean; onKeepMine?: () => void; onUseSaved?: () => void; primary?: string; secondary?: ReactNode }) {
  if (state.kind === "idle") return null;
  const busy = state.kind === "saving";
  return (
    <div className="pointer-events-none sticky bottom-4 z-20 mt-6 flex justify-center">
      <div role="region" aria-label={`Save ${what}`} className="rise-in pointer-events-auto flex max-w-full flex-col gap-2 rounded-lg border border-border bg-popover px-3 py-2 shadow-[var(--shadow-md,0_2px_8px_rgb(0_0_0/0.3))]">
        {state.kind === "conflict" ? (
          <div className="max-w-md space-y-1.5 text-xs leading-snug">
            <p className="text-foreground">Someone saved {what} while you edited it.</p>
            {state.conflicts.map((conflict) => (
              <p key={conflict.path} className="text-muted-foreground">
                {conflict.label}: saved as <span className="font-mono text-foreground">{conflict.saved}</span>, yours is <span className="font-mono text-foreground">{conflict.mine}</span>.
              </p>
            ))}
          </div>
        ) : null}
        <div className="flex items-center gap-3">
          <span role="status" className={cn("min-w-0 text-xs", state.kind === "error" || state.kind === "problems" ? "text-destructive-text" : "text-muted-foreground")}>
            {state.kind === "dirty" ? `${changes} ${changes === 1 ? "change" : "changes"} not saved` : null}
            {state.kind === "saving" ? "Saving…" : null}
            {state.kind === "saved" ? (
              <span className="inline-flex items-center gap-1 text-foreground">
                <Icon name="Check" className="size-3.5" aria-hidden />
                {state.rebased ? "Saved, after another change made elsewhere" : "Saved"}
              </span>
            ) : null}
            {state.kind === "problems" ? `Not saved: fix the ${state.count === 1 ? "field" : `${state.count} fields`} marked` : null}
            {state.kind === "error" ? state.message : null}
          </span>
          {state.kind === "conflict" ? (
            <div className="flex shrink-0 items-center gap-1.5">
              <Button type="button" variant="ghost" size="sm" className="h-7" onClick={onUseSaved}>
                Use the saved value
              </Button>
              <Button type="button" size="sm" className="h-7" onClick={onKeepMine}>
                Save mine
              </Button>
            </div>
          ) : state.kind === "saved" ? null : (
            <div className="flex shrink-0 items-center gap-1.5">
              <Button type="button" variant="ghost" size="sm" className="h-7" disabled={busy} onClick={onDiscard}>
                Discard
              </Button>
              {onCheck ? (
                <Button type="button" variant="outline" size="sm" className="h-7" disabled={busy || checking} onClick={onCheck}>
                  {checking ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
                  {checking ? "Checking…" : "Check"}
                </Button>
              ) : null}
              {secondary}
              <Button type="button" size="sm" className="h-7" disabled={busy} onClick={onSave}>
                {busy ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
                {state.kind === "error" ? "Try again" : primary}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function countChanges(stored: unknown, draft: unknown): number {
  if (typeof stored !== "object" || stored === null || typeof draft !== "object" || draft === null) return JSON.stringify(stored) === JSON.stringify(draft) ? 0 : 1;
  const keys = new Set([...Object.keys(stored), ...Object.keys(draft)]);
  let count = 0;
  for (const key of keys) {
    const a = (stored as Record<string, unknown>)[key];
    const b = (draft as Record<string, unknown>)[key];
    if (Array.isArray(a) || Array.isArray(b)) count += JSON.stringify(a) === JSON.stringify(b) ? 0 : 1;
    else if (typeof a === "object" && a !== null && typeof b === "object" && b !== null && !("set" in a)) count += countChanges(a, b);
    else if (JSON.stringify(a ?? "") !== JSON.stringify(b ?? "")) count += 1;
  }
  return count;
}

export function useEditing<T>({ stored, part, what, build }: { stored: T; part: string; what: string; build: (doc: Document, draft: T) => Document }) {
  const store = useStore();
  const nav = useNav();
  const [draft, setDraft] = useState<T>(stored);
  const [bar, setBar] = useState<BarState>({ kind: "idle" });
  const [problems, setProblems] = useState<readonly Problem[]>([]);
  const changes = countChanges(stored, draft);
  const dirtyRef = useRef(false);
  dirtyRef.current = changes > 0;

  useEffect(() => {
    nav.guard({ what, dirty: () => dirtyRef.current });
    return () => nav.guard(null);
  }, [what]);

  useEffect(() => {
    if (bar.kind === "idle" && changes > 0) setBar({ kind: "dirty" });
    if (bar.kind === "dirty" && changes === 0) setBar({ kind: "idle" });
  }, [changes, bar.kind]);

  useEffect(() => {
    if (bar.kind !== "saved") return;
    const timer = setTimeout(() => setBar({ kind: "idle" }), 1800);
    return () => clearTimeout(timer);
  }, [bar]);

  const finish = (result: SaveResult) => {
    if (result.ok) {
      setProblems([]);
      setBar({ kind: "saved", rebased: result.rebased });
      return;
    }
    if (result.reason === "problems") {
      setProblems(result.problems);
      setBar({ kind: "problems", count: result.problems.length });
      const first = document.querySelector(`[data-problem="${result.problems[0]?.path}"]`);
      first?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    if (result.reason === "conflict") {
      setBar({ kind: "conflict", conflicts: result.conflicts });
      return;
    }
    setBar({ kind: "error", message: result.message });
  };

  const save = async (force = false, next: T = draft) => {
    setBar({ kind: "saving" });
    finish(await store.save(part, (doc) => build(doc, next), { force }));
  };

  return {
    draft,
    setDraft,
    changes,
    bar,
    problems,
    problemAt: (path: string) => problems.find((problem) => problem.path === path)?.message ?? null,
    save: () => void save(),
    discard: () => {
      setDraft(stored);
      setProblems([]);
      setBar({ kind: "idle" });
    },
    keepMine: () => void save(true),
    useSaved: (fresh: T) => {
      setDraft(fresh);
      setBar({ kind: "idle" });
    },
    reset: (fresh: T) => setDraft(fresh),
  };
}

export function useInstant() {
  const store = useStore();
  const [pending, setPending] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ key: string; message: string } | null>(null);
  const run = async (key: string, part: string, change: (doc: Document) => Document) => {
    setPending(key);
    setRefused(null);
    setSaved(null);
    const result = await store.save(part, change, { force: true });
    setPending(null);
    if (result.ok) {
      setSaved(key);
      setTimeout(() => setSaved((current) => (current === key ? null : current)), 1600);
      return;
    }
    setRefused({ key, message: result.reason === "problems" ? result.problems.map((problem) => problem.message).join(" ") : result.reason === "error" ? result.message : "Someone saved first. Try again." });
  };
  return { pending, saved, refused, run, clear: () => setRefused(null) };
}

export { Badge, Icon };
export type { Stored };
