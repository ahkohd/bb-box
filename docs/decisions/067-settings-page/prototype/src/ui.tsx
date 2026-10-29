import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Badge, Meta, StatusDot, type Tone } from "@/src/app/common.tsx";
import dockerSvg from "@/assets/docker.svg?raw";
import laptopSvg from "@/assets/laptop.svg?raw";
import plugSvg from "@/assets/plug.svg?raw";
import proxmoxSvg from "@/assets/proxmox.svg?raw";
import serverSvg from "@/assets/server.svg?raw";
import boxSvg from "@/assets/icon.svg?raw";
import type { FieldView } from "./data";
import { isSecretEdit, type BarState, type Draft, type SecretEdit } from "./drafts";
import { isSecretState } from "./paths";
import { useNav } from "./nav";

export const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

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
  if (type === "hetzner" || type === "namespace") return <Icon name="Cloud" className={cn("size-4 shrink-0 text-muted-foreground", className)} aria-hidden />;
  return <span aria-hidden className={cn("inline-flex size-4 shrink-0 text-muted-foreground [&>svg]:size-full", className)} dangerouslySetInnerHTML={{ __html: GLYPHS[type] ?? boxSvg }} />;
}

export function Section({ title, description, action, children, id }: { title: string; description?: ReactNode; action?: ReactNode; children: ReactNode; id?: string }) {
  const headingId = useId();
  return (
    <section className="space-y-2.5" id={id} aria-labelledby={headingId}>
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
      <Meta items={[<span key="words" className={cn(tone === "warn" && "text-warning-text", tone === "bad" && "text-destructive-text")}>{words}</span>, ...(items ?? [])]} />
    </span>
  );
}

export function Chevron() {
  return <Icon name="ChevronRight" className="size-4 shrink-0 text-subtle-foreground" aria-hidden />;
}

export function PageHeading({ children, chips }: { children: ReactNode; chips?: ReactNode }) {
  return (
    <h2 tabIndex={-1} data-page-heading className="flex min-w-0 flex-wrap items-center gap-1.5 text-base font-medium leading-tight text-foreground focus:outline-none">
      <span className="min-w-0 break-words">{children}</span>
      {chips}
    </h2>
  );
}

export function PageHeader({ glyph, title, chips, description, aside, note }: { glyph?: ReactNode; title: string; chips?: ReactNode; description?: ReactNode; aside?: ReactNode; note?: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start gap-3">
        {glyph ? <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-raised">{glyph}</span> : null}
        <div className="min-w-0 flex-1">
          <PageHeading chips={chips}>{title}</PageHeading>
          {description ? <p className="mt-1 text-xs leading-snug text-subtle-foreground">{description}</p> : null}
        </div>
        {aside ? <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">{aside}</div> : null}
      </div>
      {note}
    </div>
  );
}

export function SavedTick({ show }: { show: boolean }) {
  return show ? (
    <span className="saved-tick inline-flex items-center gap-1 text-2xs text-muted-foreground" role="status">
      <Icon name="Check" className="size-3" aria-hidden />
      Saved
    </span>
  ) : null;
}

export function SaveRule() {
  return <p className="text-2xs text-subtle-foreground">Switches, and menus that stand alone, act at once. Fields, checkboxes and radio choices wait for Save.</p>;
}

function firstSentence(text: string): { lead: string; rest: string } {
  const match = text.match(/^(.+?[.!?])(\s+)(.+)$/s);
  if (!match || match[1]!.length < 24) return { lead: text, rest: "" };
  return { lead: match[1]!, rest: match[3]! };
}

export function Help({ text, id, label }: { text?: string; id?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  const { lead, rest } = firstSentence(text);
  return (
    <p id={id} className="mt-0.5 text-xs leading-snug text-subtle-foreground">
      {lead}
      {rest ? (
        <>
          {open ? ` ${rest}` : " "}
          <button type="button" aria-label={`${open ? "Less" : "More"} about ${label ?? "this setting"}`} className="rounded-sm text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
            {open ? "Less" : "More"}
          </button>
        </>
      ) : null}
    </p>
  );
}

interface RowContext {
  readonly controlId: string;
  readonly describedBy: string;
  readonly invalid: boolean;
}

const RowIds = createContext<RowContext | null>(null);

export function useRowIds(): RowContext | null {
  return useContext(RowIds);
}

export function SettingRow({ id, label, help, problem, conflict, children, stacked, chips, focus, onFocused }: { id?: string; label: string; help?: string; problem?: string | null; conflict?: ReactNode; children: ReactNode; stacked?: boolean; chips?: ReactNode; focus?: boolean; onFocused?: () => void }) {
  const nav = useNav();
  const ref = useRef<HTMLDivElement>(null);
  const controlId = useId();
  const helpId = useId();
  const problemId = useId();
  const found = id !== undefined && nav.found?.path === id;
  useEffect(() => {
    if (!found && !focus) return;
    const timer = setTimeout(() => {
      ref.current?.scrollIntoView({ block: "center", behavior: "auto" });
      const control = ref.current?.querySelector<HTMLElement>("input, textarea, button:not([aria-expanded]), [role=combobox]");
      control?.focus({ preventScroll: true });
      onFocused?.();
    }, 60);
    return () => clearTimeout(timer);
  }, [found, focus, nav.found?.nonce]);
  return (
    <RowIds.Provider value={{ controlId, describedBy: [help ? helpId : "", problem ? problemId : ""].filter(Boolean).join(" "), invalid: !!problem }}>
      <div ref={ref} data-setting={id} className={cn("px-4 py-3", found && "found", problem && "bg-surface-destructive", conflict && "bg-surface-warning")}>
        <div className={cn("flex flex-col gap-2", !stacked && "sm:flex-row sm:items-start sm:justify-between sm:gap-4")}>
          <div className="min-w-0 flex-1">
            <label htmlFor={controlId} className="flex flex-wrap items-center gap-1.5 text-sm text-foreground">
              {label}
              {chips}
            </label>
            <Help text={help} id={helpId} label={label} />
          </div>
          <div className={cn("flex min-w-0 items-center gap-2", stacked ? "w-full" : "w-full sm:w-auto sm:shrink-0")}>{children}</div>
        </div>
        {conflict}
        {problem ? (
          <p id={problemId} role="alert" className="mt-1.5 text-xs leading-snug text-destructive-text">
            {problem}
          </p>
        ) : null}
      </div>
    </RowIds.Provider>
  );
}

export function shown(value: unknown): string {
  if (isSecretState(value)) return value.set ? `a new value (revision ${value.version.replace(/^r/, "")})` : "nothing";
  if (value === undefined || value === null || value === "") return "empty";
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

export function ConflictNote({ saved, onUseSaved, onKeepMine, secret }: { saved: unknown; onUseSaved: () => void; onKeepMine: () => void; secret?: boolean }) {
  return (
    <div role="alert" className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-surface-warning-border px-3 py-2 text-xs leading-snug">
      <span className="min-w-0 flex-1 text-foreground">
        {secret ? <>Replaced elsewhere while you edited, at revision {isSecretState(saved) ? saved.version.replace(/^r/, "") : "?"}. Saving yours replaces that one.</> : <>Changed elsewhere to <span className="font-mono">{shown(saved)}</span> while you edited.</>}
      </span>
      <span className="flex shrink-0 gap-1.5">
        <Button type="button" variant="ghost" size="sm" className="h-7" onClick={onUseSaved}>
          {secret ? "Keep the saved one" : "Use theirs"}
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-7" onClick={onKeepMine}>
          Keep mine
        </Button>
      </span>
    </div>
  );
}

export function Checkbox({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean; id?: string }) {
  return <input id={id} type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="size-4 shrink-0 cursor-pointer rounded-sm accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed" />;
}

export function SecretInput({ value, stored, onChange, label }: { value: unknown; stored: unknown; onChange: (value: unknown) => void; label: string }) {
  const ids = useRowIds();
  const [replacing, setReplacing] = useState(false);
  const set = isSecretState(stored) && stored.set;
  if (isSecretEdit(value) && "clear" in value) {
    return (
      <span className="flex flex-wrap items-center gap-1.5 text-xs text-warning-text">
        Cleared when you save
        <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => onChange(stored)}>
          Undo
        </Button>
      </span>
    );
  }
  const typing = isSecretEdit(value) && "replace" in value;
  if (typing || !set || replacing) {
    return (
      <span className="flex w-full items-center gap-1.5 sm:w-72">
        <Input
          id={ids?.controlId}
          aria-describedby={ids?.describedBy || undefined}
          aria-invalid={ids?.invalid || undefined}
          type="password"
          autoComplete="new-password"
          aria-label={label}
          className="h-8 text-xs"
          placeholder={set || replacing ? "Paste the new value" : "Paste the value"}
          value={typing ? (value as { replace: string }).replace : ""}
          onChange={(event) => onChange(event.target.value ? ({ replace: event.target.value } satisfies SecretEdit) : stored)}
        />
        {set ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8"
            onClick={() => {
              setReplacing(false);
              onChange(stored);
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
      <Button type="button" variant="outline" size="sm" className="h-7" aria-label={`Replace the ${label}`} onClick={() => setReplacing(true)}>
        Replace
      </Button>
      <Button type="button" variant="ghost" size="sm" className="h-7 text-muted-foreground" aria-label={`Clear the ${label}`} onClick={() => onChange({ clear: true } satisfies SecretEdit)}>
        Clear
      </Button>
    </span>
  );
}

export function FieldInput({ field, value, stored, onChange, placeholder, disabled }: { field: FieldView; value: unknown; stored: unknown; onChange: (value: unknown) => void; placeholder?: string; disabled?: boolean }) {
  const ids = useRowIds();
  if (field.secret) return <SecretInput value={value} stored={stored} onChange={onChange} label={field.label} />;
  if (field.type === "boolean") return <Checkbox id={ids?.controlId} label={field.label} checked={value === true || ((value === undefined || value === "") && field.default === true)} onChange={onChange} disabled={disabled} />;
  if (field.type === "select") {
    return (
      <Select value={String(value ?? field.default ?? "")} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={ids?.controlId} className="h-8 w-full text-xs sm:w-64" aria-label={field.label}>
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
  const common = { id: ids?.controlId, "aria-describedby": ids?.describedBy || undefined, "aria-invalid": ids?.invalid || undefined, "aria-label": field.label, placeholder, disabled, value: text };
  if (field.experimental_multiline) return <Textarea {...common} className="min-h-16 w-full font-mono text-xs" rows={3} onChange={(event) => onChange(event.target.value)} />;
  return <Input {...common} inputMode={field.type === "number" ? "numeric" : undefined} className={cn("h-8 text-xs", field.type === "number" ? "w-full text-right tabular-nums sm:w-36" : "w-full sm:w-72")} onChange={(event) => onChange(field.type === "number" && event.target.value.trim() && Number.isFinite(Number(event.target.value)) ? Number(event.target.value) : event.target.value)} />;
}

function useEnterSaves(draft: Draft): void {
  const latest = useRef(draft);
  latest.current = draft;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "Enter" || event.isComposing || !target || target.tagName !== "INPUT" || target.getAttribute("role") === "combobox" || !target.closest("[data-setting], [data-form]")) return;
      if (target.closest("[data-part]")?.getAttribute("data-part") !== latest.current.part) return;
      if (!latest.current.changes || latest.current.bar.kind === "saving") return;
      event.preventDefault();
      latest.current.save();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

export function SaveBar({ draft, onCheck, checking, primary = "Save", secondary, hideIdle = true, inline = false }: { draft: Draft; onCheck?: () => void; checking?: boolean; primary?: string; secondary?: ReactNode; hideIdle?: boolean; inline?: boolean }) {
  useEnterSaves(draft);
  const { bar, changes } = draft;
  if (bar.kind === "idle" && hideIdle) return null;
  const busy = bar.kind === "saving";
  const words = barWords(bar, changes, draft.what);
  const bad = bar.kind === "error" || bar.kind === "problems";
  const retry = bar.kind === "error" || bar.kind === "unknown";
  return (
    <div className={inline ? "flex" : "pointer-events-none sticky bottom-3 z-20 mt-6 flex justify-center"}>
      <div role="region" aria-label={`Save ${draft.what}`} className="rise-in pointer-events-auto flex w-full max-w-xl flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-popover px-3 py-2 shadow-[0_2px_10px_rgb(0_0_0/0.25)]">
        <span role="status" aria-live="polite" className={cn("min-w-0 flex-1 text-xs leading-snug", bad ? "text-destructive-text" : bar.kind === "conflicts" || bar.kind === "unknown" ? "text-warning-text" : bar.kind === "saved" ? "text-foreground" : "text-muted-foreground")}>
          {bar.kind === "saved" ? <Icon name="Check" className="mr-1 inline size-3.5 align-[-2px]" aria-hidden /> : null}
          {busy ? <Icon name="Loading" className="mr-1 inline size-3.5 animate-spin align-[-2px]" aria-hidden /> : null}
          {words}
        </span>
        {bar.kind === "saved" ? null : (
          <span className="flex shrink-0 flex-wrap items-center gap-1.5">
            {bar.kind === "problems" || bar.kind === "conflicts" ? (
              <Button type="button" variant="ghost" size="sm" className="h-7" onClick={draft.revealFirst}>
                Show
              </Button>
            ) : null}
            <Button type="button" variant="ghost" size="sm" className="h-7" disabled={busy || !changes} onClick={draft.discard} aria-description="Puts back the saved values of the fields you changed here. Switches you already turned stay as they are.">
              Discard
            </Button>
            {onCheck ? (
              <Button type="button" variant="outline" size="sm" className="h-7" disabled={busy || checking} onClick={onCheck}>
                {checking ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
                {checking ? "Checking…" : "Check"}
              </Button>
            ) : null}
            {secondary}
            <Button type="button" size="sm" className="h-7" disabled={busy || (!changes && !retry)} onClick={draft.save}>
              {retry ? "Save again" : primary}
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}

function barWords(bar: BarState, changes: number, what: string): string {
  switch (bar.kind) {
    case "idle":
      return "No unsaved changes";
    case "dirty":
      return `${changes} ${changes === 1 ? "change" : "changes"} to ${what} not saved`;
    case "saving":
      return bar.words;
    case "saved":
      return bar.words;
    case "problems":
      return `Not saved: fix the ${bar.count === 1 ? "field" : `${bar.count} fields`} marked. Your changes are still here.`;
    case "conflicts":
      return `${bar.count === 1 ? "A field you changed was" : `${bar.count} fields you changed were`} changed elsewhere too. Choose for each, then save.`;
    case "error":
      return bar.message;
    case "unknown":
      return bar.words;
  }
}

export function RestoredNote({ draft }: { draft: Draft }) {
  const restored = draft.restored;
  if (!restored) return null;
  return (
    <div role="status" className="flex flex-wrap items-start gap-3 rounded-lg border border-border bg-surface-raised px-4 py-3 text-xs leading-snug">
      <Icon name="Info" className="mt-px size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 text-foreground">
        Your unsaved changes to {draft.what} are back{restored.count ? `: ${restored.count} ${restored.count === 1 ? "change" : "changes"}` : ""}.
        {restored.lostSecrets.length ? <span className="text-muted-foreground"> For safety the {restored.lostSecrets.join(" and ")} you pasted was not kept; paste it again.</span> : null}
      </span>
      <span className="flex gap-1.5">
        <Button type="button" variant="ghost" size="sm" className="h-7" onClick={draft.dismissRestored}>
          Keep them
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-7" onClick={draft.discard}>
          Discard them
        </Button>
      </span>
    </div>
  );
}

export function Confirm({ open, title, description, action, onConfirm, onCancel, destructive = true }: { open: boolean; title: string; description: ReactNode; action: string; onConfirm: () => void; onCancel: () => void; destructive?: boolean }) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction className={destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined} onClick={onConfirm}>
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function NavRow({ icon, title, value, onClick, external, tone, rowKey, trailing }: { icon: ReactNode; title: string; value?: ReactNode; onClick: () => void; external?: boolean; tone?: Tone; rowKey: string; trailing?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 pr-4 transition-colors duration-150 hover:bg-state-hover">
      <button type="button" data-row-key={rowKey} onClick={onClick} className={cn("flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-x-3 gap-y-0.5 py-2.5 pl-4 text-left", FOCUS_RING)}>
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1 text-sm text-foreground">{title}</span>
        {value ? (
          <span className={cn("flex min-w-0 basis-full items-center gap-1.5 pl-8 text-xs text-muted-foreground sm:basis-auto sm:pl-0", tone === "warn" && "text-warning-text")}>
            {tone ? <StatusDot tone={tone} /> : null}
            <span className="truncate">{value}</span>
          </span>
        ) : null}
        {external ? <Icon name="ArrowUpRight" className="size-4 shrink-0 text-subtle-foreground" aria-hidden /> : <Chevron />}
      </button>
      {trailing}
    </div>
  );
}

export { Badge, Icon };
