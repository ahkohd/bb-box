import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ConfigState } from "../plugin/configuration.ts";
import { Badge } from "./common.tsx";
import { useSettings } from "./settings-context.tsx";
import { drafts, type DraftRegistry, type InstantNote, type InstantOutcome, type InstantWrite, type Outcome, type PartState } from "./settings-drafts.ts";
import { isChange, labelOf, storedAt, type Conflict, type EditValue, type Path, type PlainValue } from "./settings-paths.ts";

export const SAVED_BAR_MS = 4000;
export const SAVING_RULE = "Switches, and menus that stand alone, act at once. Fields, checkboxes and radio choices wait for Save.";
export const DISCARD_WORDS = "Puts back the saved values of the fields you changed here. Switches you already turned stay as they are.";

export function useRegistry(): DraftRegistry {
  const registry = drafts();
  useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => registry.serial,
    () => registry.serial,
  );
  return registry;
}

export function newestState(state: ConfigState, registry: DraftRegistry): ConfigState {
  const latest = registry.latest;
  return latest && latest.revision > state.revision ? latest : state;
}

export interface Instant {
  readonly pending: string | null;
  pendingValue<T>(key: string): T | undefined;
  isSaved(key: string): boolean;
  note(key: string): InstantNote | null;
  run(write: InstantWrite): Promise<InstantOutcome | null>;
}

export function useInstant(): Instant {
  const registry = useRegistry();
  const busy = registry.instantBusy();
  return {
    pending: busy ? "busy" : null,
    pendingValue: <T,>(key: string) => {
      const pending = registry.instant(key).pending;
      return pending ? (pending.value as T) : undefined;
    },
    isSaved: (key) => registry.instant(key).saved,
    note: (key) => registry.instant(key).note,
    run: (write) => registry.runInstant(write),
  };
}

function settingElement(path: Path): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(`[data-draft-path="${CSS.escape(path)}"]`) ?? document.querySelector<HTMLElement>(`[data-draft-path^="${CSS.escape(`${path}/`)}"]`);
}

export function revealSetting(path: Path): boolean {
  const target = settingElement(path);
  if (!target) return false;
  target.scrollIntoView?.({ block: "center" });
  target.focus({ preventScroll: true });
  return true;
}

export function focusAfterRender(...paths: readonly Path[]): void {
  setTimeout(() => {
    for (const path of paths) {
      const target = settingElement(path);
      if (target) {
        target.focus();
        return;
      }
    }
  }, 0);
}

export interface Draft {
  readonly part: string;
  readonly what: string;
  readonly entry: PartState;
  readonly latest: ConfigState;
  readonly changes: number;
  readonly conflicts: readonly Path[];
  readonly busy: boolean;
  readonly enterSaves: boolean;
  edit(path: Path): EditValue | null;
  current(path: Path): PlainValue;
  text(path: Path): string;
  stored(path: Path): PlainValue;
  changed(path: Path): boolean;
  conflict(path: Path): Conflict | null;
  problem(path: Path): string | null;
  beingSaved(path: Path): boolean;
  set(path: Path, value: EditValue): void;
  forget(path: Path): void;
  forgetUnder(path: Path): void;
  keepMine(path: Path): void;
  discard(): void;
  save(): void;
  dismissRestored(): void;
  revealFirst(): void;
}

export function useDraft(part: string, what: string, { enterSaves = true }: { readonly enterSaves?: boolean } = {}): Draft {
  const { state } = useSettings();
  const registry = useRegistry();
  const latest = newestState(state, registry);
  const entry = registry.part(part);
  const ensure = () => {
    if (!registry.latest || registry.latest.revision < latest.revision) registry.observe(latest);
  };
  const conflicts = registry.latest ? registry.conflicts(part) : [];
  const operation = entry.operation;
  const draft: Draft = {
    part,
    what,
    entry,
    latest,
    changes: registry.latest ? registry.changeCount(part) : entry.edits.size,
    conflicts,
    busy: operation !== null && operation.phase.at !== "unconfirmed",
    enterSaves,
    edit: (path) => entry.edits.get(path)?.value ?? null,
    current: (path) => {
      const value = entry.edits.get(path)?.value;
      if (value?.kind === "plain") return value.value;
      const stored = storedAt(latest, path);
      return stored.kind === "value" ? stored.value : null;
    },
    text: (path) => {
      const value = entry.edits.get(path)?.value;
      if (value?.kind === "plain") return value.value === null ? "" : String(value.value);
      const stored = storedAt(latest, path);
      return stored.kind === "value" && stored.value !== null ? String(stored.value) : "";
    },
    stored: (path) => {
      const stored = storedAt(latest, path);
      return stored.kind === "value" ? stored.value : null;
    },
    changed: (path) => {
      const edit = entry.edits.get(path);
      return edit !== undefined && isChange(latest, { path, ...edit });
    },
    conflict: (path) => (registry.latest ? registry.conflictAt(part, path) : null),
    problem: (path) => entry.problems.find((problem) => problem.path === path)?.message ?? null,
    beingSaved: (path) => operation !== null && operation.submission.edits.some((edit) => edit.path === path),
    set: (path, value) => {
      ensure();
      registry.set(part, path, value);
    },
    forget: (path) => registry.forget(part, path),
    forgetUnder: (path) => registry.forgetUnder(part, path),
    keepMine: (path) => {
      ensure();
      registry.keepMine(part, path);
    },
    discard: () => registry.discard(part),
    save: () => {
      ensure();
      void registry.save(part).then(() => {
        const after = registry.part(part);
        const first = after.outcome?.kind === "problems" ? after.problems[0]?.path : after.outcome?.kind === "conflicts" ? registry.conflicts(part)[0] : undefined;
        if (first) setTimeout(() => revealSetting(first), 0);
      });
    },
    dismissRestored: () => registry.dismissRestored(part),
    revealFirst: () => {
      const first = conflicts[0] ?? entry.problems[0]?.path;
      if (first) revealSetting(first);
    },
  };
  return draft;
}

export function saveOnEnter(draft: Draft) {
  return (event: KeyboardEvent<HTMLElement>) => {
    if (!draft.enterSaves || event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    if (event.currentTarget instanceof HTMLTextAreaElement) return;
    event.preventDefault();
    draft.save();
  };
}

function changesWords(count: number): string {
  return `${count} ${count === 1 ? "change" : "changes"}`;
}

function newerWords(count: number): string {
  if (!count) return "";
  return count === 1 ? " Your newer change is not saved yet." : ` Your ${count} newer changes are not saved yet.`;
}

export interface SaveWords {
  readonly save: string;
  readonly again: string;
  readonly saving: string;
  readonly rebasing: string;
  readonly looking: string;
  readonly unconfirmed: string;
  readonly discard: string;
  pending(draft: Draft): string;
  conflicts(count: number): string;
  outcome(outcome: Outcome, draft: Draft): string;
}

function outcomeWords(outcome: Outcome, draft: Draft): string {
  switch (outcome.kind) {
    case "saved": {
      const head = outcome.lostReply
        ? `Saved at revision ${outcome.revision}. The reply was lost; BB Box's receipt for this save confirms it.`
        : outcome.rebased
          ? `Saved at revision ${outcome.revision}, on top of a change made elsewhere.`
          : "Saved.";
      const since = outcome.changedElsewhere.length ? ` Since then, changed elsewhere: ${outcome.changedElsewhere.join(", ")}.` : "";
      return `${head}${since}${newerWords(draft.changes)}`;
    }
    case "already":
      return `Already saved: the same was saved elsewhere, at revision ${outcome.revision}.${newerWords(draft.changes)}`;
    case "conflicts":
      return conflictWords(Math.max(outcome.count, draft.conflicts.length));
    case "problems":
      return `Not saved: fix the ${outcome.count === 1 ? "field" : `${outcome.count} fields`} marked. Your changes are still here.`;
    case "refused":
      return `Not saved: ${outcome.reason} Your changes are still here.`;
    case "exhausted":
      return "Not saved: the configuration changed three times while saving. Your changes are still here.";
    case "expired":
      return draft.changes
        ? "Save not confirmed: this save is older than the receipts BB Box keeps, so it is not sent again. Your changes are still here, checked against what is saved now."
        : "Save not confirmed: this save is older than the receipts BB Box keeps. What is saved now matches your changes.";
    case "unsendable":
      return "Save not confirmed: BB Box has no receipt for it yet. What you pasted was not kept when the page reloaded, so it cannot be sent again: paste it again, then save.";
  }
}

function conflictWords(count: number): string {
  return `${count === 1 ? "A setting you changed was" : `${count} settings you changed were`} changed elsewhere too. Choose for each, then save.`;
}

export const SAVE_WORDS: SaveWords = {
  save: "Save",
  again: "Save again",
  saving: "Saving…",
  rebasing: "Someone saved first. Checking your changes against theirs…",
  looking: "Save not confirmed: BB Box did not reply. Looking for this save's receipt…",
  unconfirmed: "Save not confirmed: BB Box has no receipt for it yet. Your changes are still here. Saving again resends the same request, which BB Box applies at most once.",
  discard: DISCARD_WORDS,
  pending: (draft) => `${changesWords(draft.changes)} to ${draft.what} not saved`,
  conflicts: conflictWords,
  outcome: outcomeWords,
};

type BarTone = "quiet" | "busy" | "warn" | "bad" | "done";

export function barOf(draft: Draft, savedShown: boolean, words: SaveWords = SAVE_WORDS): { readonly words: string; readonly tone: BarTone; readonly retry: boolean; readonly show: boolean } | null {
  const { entry } = draft;
  const operation = entry.operation;
  if (operation?.phase.at === "sending") return { words: operation.phase.rebased ? words.rebasing : words.saving, tone: "busy", retry: false, show: false };
  if (operation?.phase.at === "looking") return { words: words.looking, tone: "busy", retry: false, show: false };
  if (operation?.phase.at === "unconfirmed") return { words: words.unconfirmed, tone: "warn", retry: true, show: false };
  if (draft.conflicts.length) return { words: words.conflicts(draft.conflicts.length), tone: "warn", retry: false, show: true };
  const outcome = entry.outcome;
  if (outcome && (outcome.kind === "saved" || outcome.kind === "already")) {
    if (savedShown || draft.changes) return { words: words.outcome(outcome, draft), tone: "done", retry: false, show: false };
  } else if (outcome) {
    const bad = outcome.kind === "problems" || outcome.kind === "refused" || outcome.kind === "exhausted";
    return { words: words.outcome(outcome, draft), tone: bad ? "bad" : "warn", retry: bad, show: outcome.kind === "problems" };
  }
  if (draft.changes) return { words: words.pending(draft), tone: "quiet", retry: false, show: false };
  return null;
}

export function refusedInstant(outcome: InstantOutcome | null, note: InstantNote | null): string | null {
  if (outcome?.kind === "saved" || outcome?.kind === "already") return null;
  return note?.text ?? "Not removed. Nothing changed.";
}

export function SaveBar({ draft, primary, inline = false, unplaced = [], actions, words = SAVE_WORDS, ready = true, presentation, controls }: { draft: Draft; primary?: string; inline?: boolean; unplaced?: readonly string[]; actions?: ReactNode; words?: SaveWords; ready?: boolean; presentation?: { readonly words: string; readonly tone: BarTone; readonly retry: boolean; readonly show: boolean } | null; controls?: ReactNode }) {
  const registry = useRegistry();
  const outcome = draft.entry.outcome;
  const shownAt = draft.entry.outcomeShownAt;
  const [, setTick] = useState(0);
  const savedOutcome = outcome?.kind === "saved" || outcome?.kind === "already";
  useEffect(() => {
    if (savedOutcome && shownAt === null) registry.markOutcomeShown(draft.part);
  }, [savedOutcome, shownAt, registry, draft.part]);
  useEffect(() => {
    if (!savedOutcome || shownAt === null) return;
    const left = SAVED_BAR_MS - (Date.now() - shownAt);
    if (left <= 0) return;
    const timer = setTimeout(() => setTick((tick) => tick + 1), left);
    return () => clearTimeout(timer);
  }, [savedOutcome, shownAt]);
  const [focusWithin, setFocusWithin] = useState(false);
  const status = useRef<HTMLSpanElement>(null);
  const savedShown = savedOutcome && (shownAt === null || Date.now() - shownAt < SAVED_BAR_MS || focusWithin);
  const bar = presentation === undefined ? barOf(draft, savedShown, words) : presentation;
  const busy = bar?.tone === "busy";
  const showButtons = bar !== null && (bar.tone !== "done" || draft.changes > 0);
  useLayoutEffect(() => {
    if (focusWithin && !showButtons && document.activeElement === document.body) status.current?.focus();
  }, [focusWithin, showButtons]);
  if (!bar) return null;
  const canSave = !busy && !draft.conflicts.length && (bar.retry || (draft.changes > 0 && ready));
  return (
    <div className={inline ? "flex" : "pointer-events-none sticky bottom-3 z-20 mt-6 flex justify-center"}>
      <div
        role="region"
        aria-label={`${words.save} ${draft.what}`}
        onFocus={() => setFocusWithin(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false);
        }}
        className={cn("pointer-events-auto flex w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-popover px-3 py-2", controls ? "max-w-2xl" : "max-w-xl")}
      >
        <span ref={status} tabIndex={-1} role="status" aria-live="polite" className={cn("rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", "min-w-0 flex-1 basis-56 text-xs leading-snug", bar.tone === "bad" ? "text-destructive-text" : bar.tone === "warn" ? "text-warning-text" : bar.tone === "done" ? "text-foreground" : "text-muted-foreground")}>
          {bar.tone === "done" ? <Icon name="Check" className="mr-1 inline size-3.5 align-[-2px]" aria-hidden /> : null}
          {busy ? <Icon name="Loading" className="mr-1 inline size-3.5 animate-spin align-[-2px]" aria-hidden /> : null}
          {bar.words}
          {unplaced.length ? <span className="mt-1 block text-destructive-text">{unplaced.join(" ")}</span> : null}
        </span>
        {showButtons ? (
          <span className="ml-auto flex min-w-0 w-full max-w-full basis-full flex-wrap items-center justify-end gap-1.5 sm:w-auto sm:basis-auto">
            {actions}
            {bar.show ? (
              <Button type="button" variant="ghost" size="sm" className="h-7" onClick={draft.revealFirst}>
                Show
              </Button>
            ) : null}
            {controls ?? (
              <>
                <Button type="button" variant="ghost" size="sm" className="h-7" disabled={busy || !(draft.changes > 0 || draft.entry.operation !== null)} aria-description={words.discard} onClick={() => draft.discard()}>
                  Discard
                </Button>
                <Button type="button" size="sm" className="h-7" disabled={!canSave} onClick={() => draft.save()}>
                  {bar.retry ? words.again : (primary ?? words.save)}
                </Button>
              </>
            )}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function ChangedChip({ show }: { show: boolean }) {
  return show ? <Badge tone="warn">Changed</Badge> : null;
}

function conflictText(conflict: Conflict, shown: (value: PlainValue) => string): ReactNode {
  switch (conflict.kind) {
    case "changed":
      return (
        <>
          Changed elsewhere to <span className="font-mono">{shown(conflict.stored)}</span> while you edited.
        </>
      );
    case "replaced":
      return <>Replaced elsewhere while you edited, at revision {conflict.version}. Saving yours replaces that one.</>;
    case "added":
      return <>A file at this path was added elsewhere while you edited, at revision {conflict.version}. Saving yours replaces it.</>;
    case "removed":
      return <>Removed elsewhere while you edited.</>;
    case "taken":
      return <>A backend {conflict.id} was added elsewhere while you set this up.</>;
  }
}

export function ConflictNote({ conflict, onTheirs, onMine, shown = (value) => (value === null ? "empty" : String(value)), id }: { conflict: Conflict; onTheirs: () => void; onMine: () => void; shown?: (value: PlainValue) => string; id?: string }) {
  const versioned = conflict.kind !== "changed";
  return (
    <div id={id} role="status" aria-live="polite" className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-warning/40 px-3 py-2 text-xs leading-snug">
      <span className="min-w-0 flex-1 basis-48 text-foreground">{conflictText(conflict, shown)}</span>
      <span className="flex shrink-0 gap-1.5">
        <Button type="button" variant="ghost" size="sm" className="h-7" onClick={onTheirs}>
          {conflict.kind === "removed" ? "Keep it removed" : versioned ? "Keep the saved one" : "Use theirs"}
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-7" onClick={onMine}>
          {conflict.kind === "removed" ? "Add mine again" : "Keep mine"}
        </Button>
      </span>
    </div>
  );
}

export function RestoredNote({ draft, words }: { draft: Draft; words?: ReactNode }) {
  const restored = draft.entry.restored;
  if (!restored) return null;
  return (
    <div role="status" className="flex flex-wrap items-start gap-3 rounded-lg border border-border bg-surface-raised px-4 py-3 text-xs leading-snug">
      <Icon name="Info" className="mt-px size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 basis-56 text-foreground">
        {words ?? (
          <>
            Your unsaved changes to {draft.what} are back{restored.count ? `: ${changesWords(restored.count)}` : ""}.
            {restored.lost.length ? <span className="text-muted-foreground"> For safety {restored.lost.map((path) => labelOf(path, draft.entry.edits.get(path)?.value, draft.latest)).join(" and ")} you pasted was not kept; paste it again.</span> : null}
          </>
        )}
      </span>
      <span className="flex gap-1.5">
        <Button type="button" variant="ghost" size="sm" className="h-7" onClick={draft.dismissRestored}>
          Keep them
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-7" disabled={draft.busy} onClick={draft.discard}>
          Discard them
        </Button>
      </span>
    </div>
  );
}
