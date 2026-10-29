import { useEffect, useMemo, useRef, useState } from "react";
import type { Document } from "./data";
import { isSecretState, readPath, same, writePath, type Path } from "./paths";
import { LostReply, useStore, type Problem } from "./store";

export type SecretEdit = { readonly replace: string } | { readonly clear: true };

interface Edit {
  readonly value: unknown;
  readonly base: unknown;
}

type Edits = Readonly<Record<Path, Edit>>;

export type BarState =
  | { readonly kind: "idle" }
  | { readonly kind: "dirty" }
  | { readonly kind: "saving"; readonly words: string }
  | { readonly kind: "saved"; readonly words: string }
  | { readonly kind: "problems"; readonly count: number }
  | { readonly kind: "conflicts"; readonly count: number }
  | { readonly kind: "error"; readonly message: string };

export interface Restored {
  readonly count: number;
  readonly lostSecrets: readonly string[];
}

const memory = new Map<string, Edits>();
const listeners = new Set<() => void>();

function storageKey(part: string): string {
  return `bbbox-draft:${part}`;
}

export function isSecretEdit(value: unknown): value is SecretEdit {
  return typeof value === "object" && value !== null && ("replace" in value || "clear" in value);
}

function persist(part: string, edits: Edits, secretPaths: ReadonlySet<Path>, labels: (path: Path) => string): void {
  memory.set(part, edits);
  listeners.forEach((listener) => listener());
  try {
    if (!Object.keys(edits).length) {
      sessionStorage.removeItem(storageKey(part));
      return;
    }
    const kept: Record<Path, Edit | { readonly lost: string; readonly base: unknown }> = {};
    for (const [path, edit] of Object.entries(edits)) kept[path] = secretPaths.has(path) || isSecretEdit(edit.value) ? { lost: labels(path), base: edit.base } : edit;
    sessionStorage.setItem(storageKey(part), JSON.stringify(kept));
  } catch {
    return;
  }
}

function recall(part: string): { edits: Edits; restored: Restored | null } {
  const held = memory.get(part);
  if (held) return { edits: held, restored: null };
  try {
    const raw = sessionStorage.getItem(storageKey(part));
    if (!raw) return { edits: {}, restored: null };
    const kept = JSON.parse(raw) as Record<Path, Edit | { lost: string; base: unknown }>;
    const edits: Record<Path, Edit> = {};
    const lostSecrets: string[] = [];
    for (const [path, entry] of Object.entries(kept)) {
      if ("lost" in entry) lostSecrets.push(entry.lost);
      else edits[path] = entry;
    }
    return { edits, restored: { count: Object.keys(edits).length, lostSecrets } };
  } catch {
    return { edits: {}, restored: null };
  }
}

export function forgetDrafts(): void {
  memory.clear();
  try {
    Object.keys(sessionStorage)
      .filter((key) => key.startsWith("bbbox-draft:"))
      .forEach((key) => sessionStorage.removeItem(key));
  } catch {
    return;
  }
  listeners.forEach((listener) => listener());
}

export function draftParts(): string[] {
  const parts = new Set<string>();
  for (const [part, edits] of memory) if (Object.keys(edits).length) parts.add(part);
  try {
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith("bbbox-draft:")) parts.add(key.slice("bbbox-draft:".length));
    }
  } catch {
    return [...parts];
  }
  return [...parts];
}

export function useDraftParts(): string[] {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((tick) => tick + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return draftParts();
}

function storedFor(doc: Document, path: Path): unknown {
  return readPath(doc, path);
}

function baseOf(stored: unknown): unknown {
  return isSecretState(stored) ? stored.version : stored;
}

function conflicted(doc: Document, path: Path, edit: Edit): boolean {
  const stored = storedFor(doc, path);
  return !same(baseOf(stored), edit.base);
}

function applyEdits(doc: Document, edits: Edits): { doc: Document; secrets: Record<Path, string | null> } {
  let next = doc;
  const secrets: Record<Path, string | null> = {};
  const ordered = Object.entries(edits).sort(([a], [b]) => a.split("/").length - b.split("/").length);
  for (const [path, edit] of ordered) {
    if (isSecretEdit(edit.value)) {
      secrets[path] = "replace" in edit.value ? edit.value.replace : null;
      continue;
    }
    next = writePath(next, path, edit.value);
  }
  return { doc: next, secrets };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface DraftOptions {
  readonly part: string;
  readonly what: string;
  readonly secretPaths?: ReadonlySet<Path>;
  readonly label?: (path: Path) => string;
}

export function useDraft({ part, what, secretPaths = new Set(), label = (path) => path.split("/").pop() ?? path }: DraftOptions) {
  const store = useStore();
  const first = useMemo(() => recall(part), [part]);
  const [edits, setEditsState] = useState<Edits>(first.edits);
  const [restored, setRestored] = useState<Restored | null>(first.restored && (first.restored.count || first.restored.lostSecrets.length) ? first.restored : null);
  const [bar, setBar] = useState<BarState>({ kind: "idle" });
  const [problems, setProblems] = useState<readonly Problem[]>([]);
  const [focusPath, setFocusPath] = useState<Path | null>(null);
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const doc = store.doc;

  const setEdits = (next: Edits) => {
    editsRef.current = next;
    setEditsState(next);
    persist(part, next, secretPaths, label);
  };

  useEffect(() => {
    const cleaned: Record<Path, Edit> = {};
    let changed = false;
    for (const [path, edit] of Object.entries(edits)) {
      const stored = storedFor(doc, path);
      if (!isSecretEdit(edit.value) && same(stored, edit.value)) {
        changed = true;
        continue;
      }
      cleaned[path] = edit;
    }
    if (changed) setEdits(cleaned);
  }, [doc.revision]);

  const conflicts = Object.entries(edits).filter(([path, edit]) => conflicted(doc, path, edit)).map(([path]) => path);
  const changes = Object.keys(edits).length;

  useEffect(() => {
    if (bar.kind === "saving" || bar.kind === "saved" || bar.kind === "error") return;
    if (conflicts.length) setBar({ kind: "conflicts", count: conflicts.length });
    else if (bar.kind === "problems" && changes) return;
    else setBar(changes ? { kind: "dirty" } : { kind: "idle" });
  }, [changes, conflicts.length]);

  useEffect(() => {
    if (bar.kind !== "saved") return;
    const timer = setTimeout(() => setBar(editsRef.current && Object.keys(editsRef.current).length ? { kind: "dirty" } : { kind: "idle" }), 2400);
    return () => clearTimeout(timer);
  }, [bar]);

  const value = (path: Path): unknown => (path in edits ? edits[path]!.value : storedFor(doc, path));

  const set = (path: Path, next: unknown) => {
    setProblems((current) => current.filter((problem) => problem.path !== path));
    const current = editsRef.current;
    const stored = storedFor(store.fetch(), path);
    const existing = current[path];
    if (!isSecretEdit(next) && same(stored, next) && (!existing || !conflicted(store.fetch(), path, existing))) {
      const { [path]: dropped, ...rest } = current;
      void dropped;
      setEdits(rest);
      return;
    }
    setEdits({ ...current, [path]: { value: next, base: existing ? existing.base : baseOf(stored) } });
  };

  const forget = (path: Path) => {
    const { [path]: dropped, ...rest } = editsRef.current;
    void dropped;
    setEdits(rest);
  };

  const finishSaved = (submitted: Edits, words: string) => {
    const remaining: Record<Path, Edit> = {};
    const latest = store.fetch();
    for (const [path, edit] of Object.entries(editsRef.current)) {
      const sent = submitted[path];
      if (sent && (same(sent.value, edit.value) || isSecretEdit(edit.value))) continue;
      remaining[path] = sent ? { value: edit.value, base: baseOf(storedFor(latest, path)) } : edit;
    }
    setEdits(remaining);
    setProblems([]);
    const left = Object.keys(remaining).length;
    setBar({ kind: "saved", words: left ? `${words}. Your newer ${left === 1 ? "change is" : `${left} changes are`} not saved yet.` : words });
  };

  const save = async (prepare?: (doc: Document) => Document): Promise<boolean> => {
    if (conflicts.length) {
      setBar({ kind: "conflicts", count: conflicts.length });
      setFocusPath(conflicts[0]!);
      return false;
    }
    const submitted = editsRef.current;
    setBar({ kind: "saving", words: "Saving…" });
    let rebased = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const latest = store.fetch();
      const now = Object.entries(submitted).filter(([path, edit]) => conflicted(latest, path, edit)).map(([path]) => path);
      if (now.length) {
        setBar({ kind: "conflicts", count: now.length });
        setFocusPath(now[0]!);
        return false;
      }
      const { doc: draft, secrets } = applyEdits(prepare ? prepare(latest) : latest, submitted);
      try {
        const result = await store.apply(draft, latest.revision, secrets);
        if (result.ok) {
          finishSaved(submitted, rebased ? "Saved, on top of a change made elsewhere" : "Saved");
          return true;
        }
        if (result.reason === "revision") {
          rebased = true;
          setBar({ kind: "saving", words: "Someone saved first. Checking your changes against theirs…" });
          await wait(400);
          continue;
        }
        if (result.reason === "problems") {
          setProblems(result.problems);
          setBar({ kind: "problems", count: result.problems.length });
          setFocusPath(result.problems[0]!.path);
          return false;
        }
        setBar({ kind: "error", message: `Not saved: ${result.message} Your changes are still here.` });
        return false;
      } catch (error) {
        if (!(error instanceof LostReply)) throw error;
        setBar({ kind: "saving", words: "Save not confirmed: BB Box did not reply. Checking whether it was saved…" });
        await wait(900);
        const after = store.fetch();
        const landed = Object.entries(submitted).every(([path, edit]) => {
          const stored = storedFor(after, path);
          if (isSecretEdit(edit.value)) return isSecretState(stored) && stored.version !== edit.base;
          return same(stored, edit.value);
        });
        if (landed) {
          finishSaved(submitted, "Saved. The reply was lost, so BB Box checked: your changes are there");
          return true;
        }
        setBar({ kind: "error", message: "Save not confirmed, and your changes are not in the configuration. Nothing is lost: save again." });
        return false;
      }
    }
    setBar({ kind: "error", message: "Not saved: the configuration kept changing while saving. Your changes are still here." });
    return false;
  };

  return {
    part,
    what,
    value,
    stored: (path: Path) => storedFor(doc, path),
    edited: (path: Path) => path in edits,
    set,
    conflictAt: (path: Path) => (path in edits && conflicted(doc, path, edits[path]!) ? { saved: storedFor(doc, path) } : null),
    keepMine: (path: Path) => {
      const edit = editsRef.current[path];
      if (!edit) return;
      setEdits({ ...editsRef.current, [path]: { value: edit.value, base: baseOf(storedFor(store.fetch(), path)) } });
    },
    useSaved: (path: Path) => forget(path),
    changes,
    conflicts,
    bar,
    problems,
    problemAt: (path: Path) => problems.find((problem) => problem.path === path)?.message ?? null,
    focusPath,
    clearFocus: () => setFocusPath(null),
    save: () => void save(),
    saveWith: (prepare: (doc: Document) => Document) => save(prepare),
    discard: () => {
      setEdits({});
      setProblems([]);
      setBar({ kind: "idle" });
      setRestored(null);
    },
    restored,
    dismissRestored: () => setRestored(null),
  };
}

export type Draft = ReturnType<typeof useDraft>;

export function useLeaveWarning(): void {
  const parts = useDraftParts();
  useEffect(() => {
    if (!parts.length) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [parts.length]);
}

export function useInstant() {
  const store = useStore();
  const [pending, setPending] = useState<{ key: string; value: unknown } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ key: string; message: string } | null>(null);
  const run = async (key: string, changes: readonly (readonly [Path, unknown])[], what = "It") => {
    setPending({ key, value: changes[0]?.[1] });
    setRefused(null);
    setSaved(null);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const latest = store.fetch();
      const draft = changes.reduce((doc, [path, value]) => writePath(doc, path, value), latest);
      try {
        const result = await store.apply(draft, latest.revision);
        if (result.ok) break;
        if (result.reason === "revision") continue;
        setPending(null);
        setRefused({ key, message: result.reason === "problems" ? `${what} was not changed: ${result.problems.map((problem) => problem.message).join(" ")}` : `${what} was not changed: ${result.message}` });
        return;
      } catch (error) {
        if (!(error instanceof LostReply)) throw error;
        const after = store.fetch();
        if (!changes.every(([path, value]) => same(readPath(after, path), value))) {
          setPending(null);
          setRefused({ key, message: `${what} was not changed: BB Box did not reply, and the change is not in the configuration. Try again.` });
          return;
        }
        break;
      }
    }
    setPending(null);
    setSaved(key);
    setTimeout(() => setSaved((current) => (current === key ? null : current)), 1600);
  };
  return {
    pending: pending?.key ?? null,
    pendingValue: (key: string) => (pending?.key === key ? pending.value : undefined),
    saved,
    refused,
    run,
    clear: () => setRefused(null),
  };
}
