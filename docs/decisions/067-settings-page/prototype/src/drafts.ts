import { useEffect, useMemo, useRef, useState } from "react";
import type { Document } from "./data";
import { isSecretState, readPath, same, writePath, type Path } from "./paths";
import { LostReply, useStore, type Problem } from "./store";

export type SecretEdit = { readonly replace: string } | { readonly clear: true };
export interface NewFileEdit {
  readonly newFile: true;
  readonly path: string;
  readonly replace: string;
}

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
  | { readonly kind: "unknown"; readonly words: string }
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
  return typeof value === "object" && value !== null && !("newFile" in value) && ("replace" in value || "clear" in value);
}

export function isNewFile(value: unknown): value is NewFileEdit {
  return typeof value === "object" && value !== null && "newFile" in value;
}

function holdsSecret(value: unknown): boolean {
  return isSecretEdit(value) || isNewFile(value);
}

function persist(part: string, edits: Edits, labels: (path: Path) => string): void {
  memory.set(part, edits);
  listeners.forEach((listener) => listener());
  try {
    if (!Object.keys(edits).length) {
      sessionStorage.removeItem(storageKey(part));
      return;
    }
    const kept: Record<Path, unknown> = {};
    for (const [path, edit] of Object.entries(edits)) {
      if (isNewFile(edit.value)) kept[path] = { value: { ...edit.value, replace: "" }, base: edit.base, lost: `content of ~/${edit.value.path || "the new file"}` };
      else if (isSecretEdit(edit.value)) kept[path] = { lost: labels(path), base: edit.base };
      else kept[path] = edit;
    }
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
    const kept = JSON.parse(raw) as Record<Path, { value?: unknown; base: unknown; lost?: string }>;
    const edits: Record<Path, Edit> = {};
    const lostSecrets: string[] = [];
    for (const [path, entry] of Object.entries(kept)) {
      if (entry.lost) lostSecrets.push(entry.lost);
      if ("value" in entry) edits[path] = { value: entry.value, base: entry.base };
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
      if (key?.startsWith("bbbox-draft:") && !(memory.has(key.slice("bbbox-draft:".length)) && !Object.keys(memory.get(key.slice("bbbox-draft:".length))!).length)) parts.add(key.slice("bbbox-draft:".length));
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

export function newKey(prefix: string): string {
  return `${prefix}@new-${Math.random().toString(36).slice(2, 8)}`;
}

function baseOf(stored: unknown): unknown {
  return isSecretState(stored) ? stored.version : stored;
}

function conflicted(doc: Document, path: Path, edit: Edit): boolean {
  if (path.includes("@new-")) return false;
  return !same(baseOf(readPath(doc, path)), edit.base);
}

function applyEdits(doc: Document, edits: Edits): { doc: Document; secrets: Record<Path, string | null> } {
  let next = doc;
  const secrets: Record<Path, string | null> = {};
  const ordered = Object.entries(edits).sort(([a], [b]) => a.split("/").length - b.split("/").length);
  for (const [path, edit] of ordered) {
    if (isNewFile(edit.value)) {
      const filePath = edit.value.path.trim();
      next = { ...next, general: { ...next.general, files: [...next.general.files.filter((file) => file.path !== filePath), { path: filePath, content: { set: false, version: "pending" } }] } };
      secrets[`files/${encodeURIComponent(filePath)}`] = edit.value.replace;
      continue;
    }
    if (isSecretEdit(edit.value)) {
      secrets[path] = "replace" in edit.value ? edit.value.replace : null;
      continue;
    }
    next = writePath(next, path, edit.value);
  }
  return { doc: next, secrets };
}

function hash(text: string): string {
  let value = 5381;
  for (let index = 0; index < text.length; index += 1) value = ((value << 5) + value + text.charCodeAt(index)) | 0;
  return (value >>> 0).toString(36);
}

export function fingerprintOf(edits: Edits): string {
  return hash(JSON.stringify(Object.entries(edits).sort(([a], [b]) => a.localeCompare(b))));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type Outcome =
  | { readonly kind: "saved"; readonly revision: number; readonly rebased: boolean; readonly viaReceipt: boolean }
  | { readonly kind: "conflicts"; readonly paths: readonly Path[] }
  | { readonly kind: "problems"; readonly problems: readonly Problem[] }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "exhausted" }
  | { readonly kind: "unknown"; readonly operation: string };

type Built = { readonly doc: Document; readonly secrets: Record<Path, string | null> } | { readonly conflicts: readonly Path[] };

export function newOperation(): string {
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function writeWithReceipt(store: ReturnType<typeof useStore>, build: (latest: Document) => Built, onStatus: (words: string) => void, operation = newOperation()): Promise<Outcome> {
  let rebased = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = store.fetch();
    const built = build(latest);
    if ("conflicts" in built) return { kind: "conflicts", paths: built.conflicts };
    try {
      const result = await store.apply(built.doc, latest.revision, built.secrets, operation);
      if (result.ok) return { kind: "saved", revision: result.revision, rebased, viaReceipt: false };
      if (result.reason === "revision") {
        rebased = true;
        onStatus("Someone saved first. Checking your changes against theirs…");
        await wait(300);
        continue;
      }
      if (result.reason === "problems") return { kind: "problems", problems: result.problems };
      return { kind: "refused", message: result.message };
    } catch (error) {
      if (!(error instanceof LostReply)) throw error;
      onStatus("Save not confirmed: BB Box did not reply. Looking for this save's receipt…");
      for (let look = 0; look < 3; look += 1) {
        await wait(400);
        const revision = store.receipt(operation);
        if (revision !== null) return { kind: "saved", revision, rebased, viaReceipt: true };
      }
      return { kind: "unknown", operation };
    }
  }
  return { kind: "exhausted" };
}

export interface DraftOptions {
  readonly part: string;
  readonly what: string;
  readonly label?: (path: Path) => string;
}

export function useDraft({ part, what, label = (path) => path.split("/").pop() ?? path }: DraftOptions) {
  const store = useStore();
  const first = useMemo(() => recall(part), [part]);
  const [edits, setEditsState] = useState<Edits>(first.edits);
  const [restored, setRestored] = useState<Restored | null>(first.restored && (first.restored.count || first.restored.lostSecrets.length) ? first.restored : null);
  const [bar, setBar] = useState<BarState>({ kind: "idle" });
  const [problems, setProblems] = useState<readonly Problem[]>([]);
  const [focusPath, setFocusPath] = useState<Path | null>(null);
  const pendingOperation = useRef<string | null>(null);
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const doc = store.doc;

  const setEdits = (next: Edits) => {
    editsRef.current = next;
    setEditsState(next);
    persist(part, next, label);
  };

  useEffect(() => {
    const cleaned: Record<Path, Edit> = {};
    let changed = false;
    for (const [path, edit] of Object.entries(edits)) {
      if (!holdsSecret(edit.value) && !path.includes("@new-") && same(readPath(doc, path), edit.value)) {
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
    if (bar.kind === "saving" || bar.kind === "saved" || bar.kind === "error" || bar.kind === "unknown") return;
    if (conflicts.length) setBar({ kind: "conflicts", count: conflicts.length });
    else if (bar.kind === "problems" && changes) return;
    else setBar(changes ? { kind: "dirty" } : { kind: "idle" });
  }, [changes, conflicts.length]);

  useEffect(() => {
    if (bar.kind !== "saved") return;
    const timer = setTimeout(() => setBar(Object.keys(editsRef.current).length ? { kind: "dirty" } : { kind: "idle" }), 3200);
    return () => clearTimeout(timer);
  }, [bar]);

  const value = (path: Path): unknown => (path in edits ? edits[path]!.value : readPath(doc, path));

  const set = (path: Path, next: unknown) => {
    setProblems((current) => current.filter((problem) => problem.path !== path));
    if (bar.kind === "error" || bar.kind === "unknown") setBar({ kind: "dirty" });
    const current = editsRef.current;
    const stored = readPath(store.fetch(), path);
    const existing = current[path];
    if (!holdsSecret(next) && !path.includes("@new-") && same(stored, next) && (!existing || !conflicted(store.fetch(), path, existing))) {
      const { [path]: dropped, ...rest } = current;
      void dropped;
      setEdits(rest);
      return;
    }
    if (next === undefined && path.includes("@new-")) {
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

  const reveal = (path: Path | undefined) => {
    if (!path) return;
    setFocusPath(null);
    setTimeout(() => setFocusPath(path), 0);
  };

  const build = (prepare?: (doc: Document) => Document) => (latest: Document): Built => {
    const submitted = editsRef.current;
    const now = Object.entries(submitted).filter(([path, edit]) => conflicted(latest, path, edit)).map(([path]) => path);
    if (now.length) return { conflicts: now };
    return applyEdits(prepare ? prepare(latest) : latest, submitted);
  };

  const finishSaved = (submitted: Edits, revision: number, words: string) => {
    const remaining: Record<Path, Edit> = {};
    const latest = store.fetch();
    const changedSince: string[] = [];
    for (const [path, sent] of Object.entries(submitted)) {
      const stored = readPath(latest, path);
      if (isSecretEdit(sent.value) && isSecretState(stored) && stored.version !== `r${revision}`) changedSince.push(`${label(path)} (revision ${stored.version.replace(/^r/, "")})`);
      else if (!holdsSecret(sent.value) && !path.includes("@new-") && !same(stored, sent.value)) changedSince.push(label(path));
    }
    for (const [path, edit] of Object.entries(editsRef.current)) {
      const sent = submitted[path];
      if (sent && same(sent.value, edit.value)) continue;
      remaining[path] = sent ? { value: edit.value, base: path.includes("@new-") ? null : baseOf(readPath(latest, path)) } : edit;
    }
    setEdits(remaining);
    setProblems([]);
    setRestored(null);
    const left = Object.keys(remaining).length;
    const since = changedSince.length ? ` Since then, changed elsewhere: ${changedSince.join(", ")}.` : "";
    const newer = left ? ` Your newer ${left === 1 ? "change is" : `${left} changes are`} not saved yet.` : "";
    setBar({ kind: "saved", words: `${words}.${since}${newer}` });
  };

  const save = async (prepare?: (doc: Document) => Document): Promise<boolean> => {
    if (conflicts.length) {
      setBar({ kind: "conflicts", count: conflicts.length });
      reveal(conflicts[0]);
      return false;
    }
    const submitted = editsRef.current;
    setBar({ kind: "saving", words: "Saving…" });
    const outcome = await writeWithReceipt(store, build(prepare), (words) => setBar({ kind: "saving", words }), pendingOperation.current ?? undefined);
    pendingOperation.current = null;
    switch (outcome.kind) {
      case "saved":
        finishSaved(submitted, outcome.revision, outcome.viaReceipt ? `Saved at revision ${outcome.revision}. The reply was lost; BB Box's receipt for this save confirms it` : outcome.rebased ? `Saved at revision ${outcome.revision}, on top of a change made elsewhere` : "Saved");
        return true;
      case "conflicts":
        setBar({ kind: "conflicts", count: outcome.paths.length });
        reveal(outcome.paths[0]);
        return false;
      case "problems":
        setProblems(outcome.problems);
        setBar({ kind: "problems", count: outcome.problems.length });
        reveal(outcome.problems[0]?.path);
        return false;
      case "refused":
        setBar({ kind: "error", message: `Not saved: ${outcome.message} Your changes are still here.` });
        return false;
      case "exhausted":
        setBar({ kind: "error", message: "Not saved: the configuration changed three times while saving. Your changes are still here; save again." });
        return false;
      case "unknown":
        pendingOperation.current = outcome.operation;
        setBar({ kind: "unknown", words: "Save not confirmed: BB Box has no receipt for it yet. Your changes are still here. Saving again resends the same request, which BB Box applies at most once." });
        return false;
    }
  };

  const fingerprint = fingerprintOf(edits);

  return {
    part,
    what,
    value,
    stored: (path: Path) => readPath(doc, path),
    edited: (path: Path) => path in edits,
    editKeys: () => Object.keys(edits),
    set,
    conflictAt: (path: Path) => (path in edits && conflicted(doc, path, edits[path]!) ? { saved: readPath(doc, path) } : null),
    keepMine: (path: Path) => {
      const edit = editsRef.current[path];
      if (!edit) return;
      setEdits({ ...editsRef.current, [path]: { value: edit.value, base: baseOf(readPath(store.fetch(), path)) } });
    },
    useSaved: (path: Path) => forget(path),
    forget,
    changes,
    conflicts,
    bar,
    problems,
    problemAt: (path: Path) => problems.find((problem) => problem.path === path)?.message ?? null,
    focusPath,
    clearFocus: () => setFocusPath(null),
    revealFirst: () => reveal(conflicts[0] ?? problems[0]?.path),
    save: () => void save(),
    saveWith: (prepare: (doc: Document) => Document) => save(prepare),
    candidate: (prepare?: (doc: Document) => Document) => {
      const built = build(prepare)(store.fetch());
      return "conflicts" in built ? null : built;
    },
    fingerprint: `${doc.revision}:${fingerprint}`,
    discard: () => {
      setEdits({});
      setProblems([]);
      setBar({ kind: "idle" });
      setRestored(null);
      pendingOperation.current = null;
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

export function outcomeWords(outcome: Outcome, failed: string): string | null {
  switch (outcome.kind) {
    case "saved":
      return null;
    case "conflicts":
      return `${failed}: it was changed elsewhere first. Look again, then try.`;
    case "problems":
      return `${failed}: ${outcome.problems.map((problem) => problem.message).join(" ")}`;
    case "refused":
      return `${failed}: ${outcome.message}`;
    case "exhausted":
      return `${failed}: the configuration changed three times while saving. Try again.`;
    case "unknown":
      return "Not confirmed: BB Box has no receipt for this change yet. Try again; it is applied at most once.";
  }
}

export function useWrite() {
  const store = useStore();
  return async (change: (latest: Document) => Document | null, failed: string, secrets: Record<Path, string | null> = {}, onStatus: (words: string) => void = () => undefined): Promise<{ ok: true; revision: number } | { ok: false; message: string }> => {
    const outcome = await writeWithReceipt(
      store,
      (latest) => {
        const next = change(latest);
        return next ? { doc: next, secrets } : { conflicts: ["changed"] };
      },
      onStatus,
    );
    if (outcome.kind === "saved") return { ok: true, revision: outcome.revision };
    return { ok: false, message: outcomeWords(outcome, failed)! };
  };
}

export function useInstant() {
  const write = useWrite();
  const [pending, setPending] = useState<{ key: string; value: unknown } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ key: string; message: string } | null>(null);
  const run = async (key: string, changes: readonly (readonly [Path, unknown])[], what = "It"): Promise<boolean> => {
    setPending({ key, value: changes[0]?.[1] });
    setRefused(null);
    setSaved(null);
    const result = await write((latest) => changes.reduce((doc, [path, value]) => writePath(doc, path, value), latest), `${what} was not changed`);
    setPending(null);
    if (!result.ok) {
      setRefused({ key, message: result.message });
      return false;
    }
    setSaved(key);
    setTimeout(() => setSaved((current) => (current === key ? null : current)), 1600);
    return true;
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
