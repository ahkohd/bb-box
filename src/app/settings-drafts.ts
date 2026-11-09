import type { ConfigDocument } from "../core/document.ts";
import { receiptMayBeGone } from "../core/receipt-window.ts";
import type { ApplyResult, ConfigState } from "../plugin/configuration.ts";
import {
  backendAt,
  backendPath,
  candidateOf,
  conflictOf,
  documentValue,
  draftProblems,
  editProblems,
  fileIsStored,
  fileOfPath,
  filePath,
  freeBackendId,
  holdsSecret,
  hostPath,
  isChange,
  labelOf,
  newFilePath,
  sameValue,
  secretTextOf,
  storedAt,
  withoutSecretText,
  type Candidate,
  type Conflict,
  type DraftProblem,
  type Edit,
  type EditValue,
  type Path,
  type PathEdit,
  type Stored,
} from "./settings-paths.ts";

const LEADING_COMMON_WORD = /^(The|Its|It|This|There|An|A|Nothing)\b/;

export function reasonAfterColon(text: string): string {
  return text.replace(LEADING_COMMON_WORD, (word) => word.toLowerCase());
}

export const MOST_TRIES = 3;
export const SAVED_SHOWN_MS = 1600;
export const BOXES_PART = "option/boxes";
export const MONITOR_PART = "option/monitor";
export const SNAPSHOTS_PART = "option/snapshots";
export const NETWORK_PART = "option/network";
export const FILES_PART = "files";

export function backendPart(id: string): string {
  return `backend/${id}`;
}

const SETUP_PREFIX = "setup/";

export function setupPart(type: string): string {
  return `${SETUP_PREFIX}${type}`;
}

export interface Submission {
  readonly part: string;
  readonly edits: readonly PathEdit[];
}

export type Phase =
  | { readonly at: "sending"; readonly attempt: number; readonly rebased: boolean }
  | { readonly at: "looking"; readonly reason: string }
  | { readonly at: "unconfirmed"; readonly reason: string };

export interface Operation {
  readonly id: string;
  readonly submission: Submission;
  readonly firstSentOn: number;
  readonly startedAt: number;
  readonly resendable: boolean;
  readonly restored: boolean;
  readonly phase: Phase;
}

export type Outcome =
  | { readonly kind: "saved"; readonly revision: number; readonly lostReply: boolean; readonly rebased: boolean; readonly changedElsewhere: readonly string[]; readonly newer: number }
  | { readonly kind: "already"; readonly revision: number; readonly newer: number }
  | { readonly kind: "conflicts"; readonly count: number }
  | { readonly kind: "problems"; readonly count: number }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "exhausted" }
  | { readonly kind: "expired"; readonly left: number }
  | { readonly kind: "unsendable"; readonly left: number };

export interface Restored {
  readonly count: number;
  readonly lost: readonly Path[];
}

export interface PartState {
  readonly edits: ReadonlyMap<Path, Edit>;
  readonly operation: Operation | null;
  readonly outcome: Outcome | null;
  readonly outcomeShownAt: number | null;
  readonly problems: readonly DraftProblem[];
  readonly restored: Restored | null;
}

const EMPTY_PART: PartState = { edits: new Map(), operation: null, outcome: null, outcomeShownAt: null, problems: [], restored: null };

export interface ApplyRequest {
  readonly draft: ConfigDocument;
  readonly revision: number;
  readonly operation: string;
  readonly submission: unknown;
}

export interface SaveTransport {
  apply(request: ApplyRequest): Promise<ApplyResult>;
  read(): Promise<ConfigState>;
}

export interface Write {
  build(state: ConfigState): Candidate;
  send(transport: SaveTransport, built: Candidate, state: ConfigState, operation: Operation): Promise<ApplyResult>;
}

export type Finish =
  | { readonly kind: "applied"; readonly revision: number; readonly lostReply: boolean; readonly rebased: boolean; readonly state: ConfigState }
  | { readonly kind: "already"; readonly state: ConfigState }
  | { readonly kind: "conflicts"; readonly paths: readonly Path[]; readonly state: ConfigState }
  | { readonly kind: "problems"; readonly problems: readonly DraftProblem[] }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "exhausted"; readonly state: ConfigState }
  | { readonly kind: "unconfirmed"; readonly reason: string; readonly state: ConfigState | null }
  | { readonly kind: "expired"; readonly state: ConfigState };

export interface RunContext {
  readonly transport: SaveTransport;
  latest(): ConfigState;
  observe(state: ConfigState): void;
  now(): number;
  onPhase(phase: Phase): void;
}

export function wireSubmission(submission: Submission): unknown {
  return { part: submission.part, edits: submission.edits.map((edit) => ({ path: edit.path, value: edit.value, base: edit.base })) };
}

export function submittedWrite(submission: Submission): Write {
  return {
    build: (state) => candidateOf(state, submission.edits),
    send: (transport, built, state, operation) => transport.apply({ draft: built.document, revision: state.revision, operation: operation.id, submission: wireSubmission(submission) }),
  };
}

function receiptOf(state: ConfigState, operation: Operation) {
  return state.receipts.find((receipt) => receipt.operation === operation.id) ?? null;
}

function reasonOf(caught: unknown): string {
  const text = caught instanceof Error ? caught.message : String(caught);
  return text.replace(/\.+$/, "") || "no reason given";
}

export async function lookForReceipt(operation: Operation, reason: string, context: RunContext, rebased: boolean): Promise<Finish> {
  context.onPhase({ at: "looking", reason });
  let state: ConfigState;
  try {
    state = await context.transport.read();
  } catch {
    return { kind: "unconfirmed", reason: `${reason}, and the configuration could not be read again`, state: null };
  }
  context.observe(state);
  const receipt = receiptOf(state, operation);
  if (receipt) return { kind: "applied", revision: receipt.revision, lostReply: true, rebased, state };
  if (receiptMayBeGone(operation, state.receipts, context.now())) return { kind: "expired", state };
  return { kind: "unconfirmed", reason, state };
}

export async function runOperation(operation: Operation, write: Write, context: RunContext): Promise<Finish> {
  let state = context.latest();
  let rebased = false;
  for (let attempt = 1; attempt <= MOST_TRIES; attempt += 1) {
    context.onPhase({ at: "sending", attempt, rebased });
    const receipt = receiptOf(state, operation);
    if (receipt) return { kind: "applied", revision: receipt.revision, lostReply: true, rebased, state };
    const built = write.build(state);
    if (built.conflicts.length) return { kind: "conflicts", paths: built.conflicts, state };
    if (!built.needed) return { kind: "already", state };
    let result: ApplyResult;
    try {
      result = await write.send(context.transport, built, state, operation);
    } catch (caught) {
      return lookForReceipt(operation, reasonOf(caught), context, rebased);
    }
    if (result.ok) {
      context.observe(result.state);
      return { kind: "applied", revision: result.receipt?.revision ?? result.state.revision, lostReply: result.replayed === true, rebased, state: result.state };
    }
    if (result.reason === "problems") {
      const reused = result.problems.find((problem) => problem.path === "operation");
      if (reused) return { kind: "refused", reason: reused.message };
      return { kind: "problems", problems: draftProblems(result.problems, built.sentAs) };
    }
    context.observe(result.state);
    state = result.state;
    rebased = true;
  }
  return { kind: "exhausted", state };
}

export interface Completion {
  readonly edits: Map<Path, Edit>;
  readonly changedElsewhere: string[];
  readonly newer: number;
  readonly identities: Map<Path, Path>;
}

function savedBase(latest: ConfigState, savedPath: Path, edit: PathEdit, revision: number): Stored {
  if (edit.value.kind === "plain") return { kind: "value", value: documentValue(latest, savedPath, edit.value.value) };
  return { kind: "version", version: revision };
}

function createdBackend(submission: Submission): { readonly path: Path; readonly id: string } | null {
  const sent = submission.edits.find((edit) => edit.value.kind === "new-backend");
  return sent?.value.kind === "new-backend" ? { path: sent.path, id: sent.value.id } : null;
}

function identitiesOf(submission: Submission): Map<Path, Path> {
  const identities = new Map<Path, Path>();
  const created = createdBackend(submission);
  if (created) identities.set(created.path, backendPath(created.id));
  for (const sent of submission.edits) {
    if (sent.value.kind === "new-file") identities.set(sent.path, filePath(sent.value.path.trim()));
    const at = backendAt(sent.path);
    if (sent.value.kind === "new-host" && at) identities.set(sent.path, hostPath(created && backendPath(at.id) === created.path ? created.id : at.id, sent.value.name.trim()));
  }
  return identities;
}

function savedPathOf(identities: ReadonlyMap<Path, Path>, path: Path): Path {
  let best: { readonly from: Path; readonly to: Path } | null = null;
  for (const [from, to] of identities) {
    if ((path === from || path.startsWith(`${from}/`)) && (!best || from.length > best.from.length)) best = { from, to };
  }
  return best ? `${best.to}${path.slice(best.from.length)}` : path;
}

export function completeSave(edits: ReadonlyMap<Path, Edit>, submission: Submission, revision: number, latest: ConfigState, restoredLost: ReadonlySet<Path> = new Set()): Completion {
  const next = new Map(edits);
  const identities = identitiesOf(submission);
  for (const sent of submission.edits) {
    const savedPath = savedPathOf(identities, sent.path);
    const current = next.get(sent.path);
    if (!current) continue;
    next.delete(sent.path);
    const stillLostSinceReload = restoredLost.has(sent.path) && holdsSecret(current.value) && secretTextOf(current.value) === null && sameValue(withoutSecretText(current.value), withoutSecretText(sent.value));
    if (sameValue(current.value, sent.value) || stillLostSinceReload || sent.value.kind === "new-host" || sent.value.kind === "new-backend") continue;
    if (sent.value.kind === "new-file" && current.value.kind === "new-file") {
      next.set(savedPath, { value: { kind: "secret", text: current.value.text }, base: { kind: "version", version: revision } });
      continue;
    }
    next.set(savedPath, { value: current.value, base: savedBase(latest, savedPath, sent, revision) });
  }
  for (const [path, edit] of [...next]) {
    const savedPath = savedPathOf(identities, path);
    if (savedPath === path) continue;
    next.delete(path);
    next.set(savedPath, { value: edit.value, base: storedAt(latest, savedPath, edit.value) });
  }
  const changedElsewhere: string[] = [];
  for (const sent of submission.edits) {
    if (sent.value.kind === "removed" || sent.value.kind === "new-host" || sent.value.kind === "new-backend") continue;
    const savedPath = savedPathOf(identities, sent.path);
    const stored = storedAt(latest, savedPath);
    const label = labelOf(savedPath, undefined, latest);
    if (sent.value.kind === "plain") {
      if (isChange(latest, { path: savedPath, value: sent.value, base: stored })) changedElsewhere.push(label);
    } else if (stored.kind === "version") {
      if (stored.version === null) changedElsewhere.push(`${label} (removed)`);
      else if (stored.version !== revision) changedElsewhere.push(`${label} (revision ${stored.version})`);
    }
  }
  return { edits: next, changedElsewhere, newer: next.size, identities };
}

export interface StoredOperation {
  readonly id: string;
  readonly submission: Submission;
  readonly firstSentOn: number;
  readonly startedAt: number;
  readonly heldSecret: boolean;
}

export interface StoredPart {
  readonly v: 1;
  readonly edits: readonly (readonly [Path, Edit])[];
  readonly lost: readonly Path[];
  readonly operation: StoredOperation | null;
}

export interface DraftStorage {
  load(): Readonly<Record<string, StoredPart>>;
  save(part: string, value: StoredPart | null): void;
}

export function storablePart(part: PartState): StoredPart | null {
  const operation = part.operation;
  if (!part.edits.size && !operation) return null;
  const edits = [...part.edits].map(([path, edit]) => [path, { value: withoutSecretText(edit.value), base: edit.base }] as const);
  const lost = [...part.edits].filter(([, edit]) => holdsSecret(edit.value)).map(([path]) => path);
  return {
    v: 1,
    edits,
    lost,
    operation: operation
      ? {
          id: operation.id,
          submission: { part: operation.submission.part, edits: operation.submission.edits.map((edit) => ({ path: edit.path, value: withoutSecretText(edit.value), base: edit.base })) },
          firstSentOn: operation.firstSentOn,
          startedAt: operation.startedAt,
          heldSecret: !operation.resendable || operation.submission.edits.some((edit) => holdsSecret(edit.value)),
        }
      : null,
  };
}

export function restoredPart(stored: StoredPart): PartState {
  const edits = new Map<Path, Edit>(stored.edits.map(([path, edit]) => [path, edit]));
  const lost = stored.lost.filter((path) => edits.has(path));
  const operation: Operation | null = stored.operation
    ? {
        id: stored.operation.id,
        submission: stored.operation.submission,
        firstSentOn: stored.operation.firstSentOn,
        startedAt: stored.operation.startedAt,
        resendable: !stored.operation.heldSecret,
        restored: true,
        phase: { at: "looking", reason: "the page was reloaded while this save was out" },
      }
    : null;
  return { ...EMPTY_PART, edits, operation, restored: edits.size || lost.length ? { count: edits.size, lost } : null };
}

const STORAGE_PREFIX = "bb-box.settings.draft.";

export function sessionDraftStorage(storage: Storage | null): DraftStorage {
  return {
    load() {
      const parts: Record<string, StoredPart> = {};
      if (!storage) return parts;
      try {
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (!key?.startsWith(STORAGE_PREFIX)) continue;
          const parsed = JSON.parse(storage.getItem(key) ?? "null") as StoredPart | null;
          if (parsed?.v === 1) parts[key.slice(STORAGE_PREFIX.length)] = parsed;
        }
      } catch {
        return parts;
      }
      return parts;
    },
    save(part, value) {
      if (!storage) return;
      try {
        if (value) storage.setItem(STORAGE_PREFIX + part, JSON.stringify(value));
        else storage.removeItem(STORAGE_PREFIX + part);
      } catch {
        return;
      }
    },
  };
}

export interface InstantWrite extends Write {
  readonly key: string;
  readonly what: string;
  readonly pending: unknown;
  readonly undone?: "changed" | "removed";
  say(state: ConfigState): string;
}

export type InstantOutcome =
  | { readonly kind: "saved"; readonly revision: number }
  | { readonly kind: "already"; readonly revision: number }
  | { readonly kind: "refused" }
  | { readonly kind: "conflicts" }
  | { readonly kind: "exhausted" }
  | { readonly kind: "unconfirmed" };

export interface InstantNote {
  readonly text: string;
  readonly tone: "bad" | "info";
}

export interface InstantState {
  readonly pending: { readonly value: unknown } | null;
  readonly saved: boolean;
  readonly note: InstantNote | null;
  readonly operation: Operation | null;
}

const NO_INSTANT: InstantState = { pending: null, saved: false, note: null, operation: null };

interface InstantEntry {
  readonly write: InstantWrite;
  readonly state: InstantState;
}

export interface RegistryDeps {
  readonly storage: DraftStorage;
  now(): number;
  newId(): string;
  later(run: () => void, ms: number): void;
}

export class DraftRegistry {
  readonly #deps: RegistryDeps;
  readonly #parts = new Map<string, PartState>();
  readonly #instants = new Map<string, InstantEntry>();
  readonly #listeners = new Set<() => void>();
  readonly #identities = new Map<Path, Path>();
  readonly #landings = new Map<string, string>();
  #latest: ConfigState | null = null;
  #transport: SaveTransport | null = null;
  #serial = 0;

  constructor(deps: RegistryDeps) {
    this.#deps = deps;
    for (const [part, stored] of Object.entries(deps.storage.load())) this.#parts.set(part, restoredPart(stored));
  }

  get serial(): number {
    return this.#serial;
  }

  get latest(): ConfigState | null {
    return this.#latest;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  connect(transport: SaveTransport): void {
    this.#transport = transport;
  }

  part(part: string): PartState {
    return this.#parts.get(part) ?? EMPTY_PART;
  }

  instant(key: string): InstantState {
    return this.#instants.get(key)?.state ?? NO_INSTANT;
  }

  instantBusy(): boolean {
    return [...this.#instants.values()].some((entry) => entry.state.pending !== null);
  }

  savedIdentity(path: Path): Path {
    return this.#identities.get(path) ?? path;
  }

  landing(part: string): string | null {
    return this.#landings.get(part) ?? null;
  }

  forgetLanding(part: string): void {
    if (this.#landings.delete(part)) this.#notify();
  }

  partsWithDrafts(): string[] {
    return [...this.#parts].filter(([, part]) => part.edits.size > 0 || part.operation !== null).map(([part]) => part);
  }

  hasChanges(part: string): boolean {
    const entry = this.part(part);
    const latest = this.#latest;
    if (entry.operation) return true;
    return [...entry.edits].some(([path, edit]) => !latest || isChange(latest, { path, ...edit }));
  }

  changeCount(part: string): number {
    const latest = this.#latest;
    return [...this.part(part).edits].filter(([path, edit]) => !latest || isChange(latest, { path, ...edit })).length;
  }

  conflictAt(part: string, path: Path): Conflict | null {
    const edit = this.part(part).edits.get(path);
    if (!edit || !this.#latest) return null;
    return conflictOf(this.#latest, { path, ...edit });
  }

  conflicts(part: string): Path[] {
    const latest = this.#latest;
    if (!latest) return [];
    return [...this.part(part).edits].filter(([path, edit]) => conflictOf(latest, { path, ...edit }) !== null).map(([path]) => path);
  }

  #notify(): void {
    this.#serial += 1;
    for (const listener of this.#listeners) listener();
  }

  #put(part: string, next: PartState): void {
    const empty = !next.edits.size && !next.operation && !next.outcome && !next.problems.length && !next.restored;
    if (empty) this.#parts.delete(part);
    else this.#parts.set(part, next);
    this.#deps.storage.save(part, storablePart(next));
    this.#notify();
  }

  #update(part: string, change: (current: PartState) => PartState): void {
    this.#put(part, change(this.part(part)));
  }

  observe(state: ConfigState): void {
    if (this.#latest && state.revision < this.#latest.revision) return;
    this.#latest = state;
    for (const [part, entry] of [...this.#parts]) this.#settle(part, entry, state);
    for (const [key, entry] of [...this.#instants]) this.#settleInstant(key, entry, state);
    this.#notify();
  }

  #settle(part: string, entry: PartState, state: ConfigState): void {
    const operation = entry.operation;
    if (operation) {
      const receipt = receiptOf(state, operation);
      if (receipt) {
        const phase = operation.phase;
        this.#finish(part, operation, { kind: "applied", revision: receipt.revision, lostReply: phase.at !== "sending", rebased: phase.at === "sending" && phase.rebased, state });
        return;
      }
      const waiting = operation.phase.at === "unconfirmed" || (operation.restored && operation.phase.at === "looking");
      if (!waiting) return;
      if (receiptMayBeGone(operation, state.receipts, this.#deps.now())) {
        this.#finish(part, operation, { kind: "expired", state });
        return;
      }
      if (operation.restored && operation.phase.at === "looking") {
        if (!operation.resendable) {
          this.#put(part, { ...entry, operation: null, outcome: { kind: "unsendable", left: entry.edits.size }, outcomeShownAt: null });
          return;
        }
        this.#put(part, { ...entry, operation: { ...operation, phase: { at: "unconfirmed", reason: operation.phase.reason } } });
      }
      return;
    }
    const settled = new Map([...entry.edits].filter(([path, edit]) => edit.value.kind !== "plain" || isChange(state, { path, ...edit }) || conflictOf(state, { path, ...edit }) !== null));
    if (settled.size !== entry.edits.size) this.#put(part, { ...entry, edits: settled });
  }

  set(part: string, path: Path, value: EditValue): void {
    const latest = this.#latest;
    if (!latest) return;
    this.#update(part, (entry) => {
      const edits = new Map(entry.edits);
      const existing = edits.get(path);
      const rebaseOnPath = existing && existing.value.kind === "new-file" && value.kind === "new-file" && existing.value.path.trim() !== value.path.trim();
      const base = existing && !rebaseOnPath ? existing.base : storedAt(latest, path, value);
      const edit = { path, value, base };
      const quiet = value.kind === "plain" && !isChange(latest, edit) && conflictOf(latest, edit) === null && !entry.operation?.submission.edits.some((sent) => sent.path === path);
      if (quiet) edits.delete(path);
      else edits.set(path, { value, base });
      const problems = entry.problems.filter((problem) => problem.path !== path && !problem.path.startsWith(`${path}/`));
      const outcome = entry.outcome && (entry.outcome.kind === "saved" || entry.outcome.kind === "already") ? entry.outcome : null;
      return { ...entry, edits, problems, outcome };
    });
  }

  replace(part: string, keep: (path: Path) => boolean, values: readonly (readonly [Path, EditValue])[]): void {
    const latest = this.#latest;
    if (!latest) return;
    this.#update(part, (entry) => {
      const edits = new Map([...entry.edits].filter(([path]) => keep(path)));
      for (const [path, value] of values) edits.set(path, { value, base: storedAt(latest, path, value) });
      const outcome = entry.outcome && (entry.outcome.kind === "saved" || entry.outcome.kind === "already") ? entry.outcome : null;
      return { ...entry, edits, problems: [], outcome, restored: null };
    });
  }

  forgetUnder(part: string, path: Path): void {
    this.#update(part, (entry) => {
      const under = (each: Path) => each === path || each.startsWith(`${path}/`);
      return { ...entry, edits: new Map([...entry.edits].filter(([each]) => !under(each))), problems: entry.problems.filter((problem) => !under(problem.path)) };
    });
  }

  saving(part: string): boolean {
    const phase = this.part(part).operation?.phase.at;
    return phase === "sending" || phase === "looking";
  }

  forget(part: string, path: Path): void {
    this.#update(part, (entry) => {
      const edits = new Map(entry.edits);
      edits.delete(path);
      return { ...entry, edits, problems: entry.problems.filter((problem) => problem.path !== path && !problem.path.startsWith(`${path}/`)) };
    });
  }

  keepMine(part: string, path: Path): void {
    const latest = this.#latest;
    if (!latest) return;
    this.#update(part, (entry) => {
      const edit = entry.edits.get(path);
      if (!edit) return entry;
      const edits = new Map(entry.edits);
      const removedFile = edit.value.kind === "secret" && !fileIsStored(latest, path);
      if (removedFile) {
        const file = fileOfPath(path) ?? "";
        edits.delete(path);
        edits.set(newFilePath(this.#deps.newId().slice(-8)), { value: { kind: "new-file", path: file, text: edit.value.kind === "secret" ? edit.value.text : null }, base: { kind: "version", version: null } });
      } else if (edit.value.kind === "new-backend") {
        edits.set(path, { value: { ...edit.value, id: freeBackendId(latest.document, edit.value.type, true) }, base: edit.base });
      } else edits.set(path, { value: edit.value, base: storedAt(latest, path, edit.value) });
      return { ...entry, edits, outcome: entry.outcome?.kind === "conflicts" ? null : entry.outcome };
    });
  }

  discard(part: string): void {
    const entry = this.part(part);
    if (entry.operation?.phase.at === "sending" || entry.operation?.phase.at === "looking") return;
    this.#put(part, EMPTY_PART);
  }

  dismissRestored(part: string): void {
    this.#update(part, (entry) => ({ ...entry, restored: null }));
  }

  markOutcomeShown(part: string): void {
    const entry = this.part(part);
    if (!entry.outcome || entry.outcomeShownAt !== null) return;
    this.#parts.set(part, { ...entry, outcomeShownAt: this.#deps.now() });
    this.#notify();
  }

  async save(part: string): Promise<void> {
    const latest = this.#latest;
    const transport = this.#transport;
    if (!latest || !transport) return;
    const entry = this.part(part);
    const pending = entry.operation;
    if (pending && pending.phase.at !== "unconfirmed") return;
    if (pending && pending.resendable) {
      await this.#run(part, { ...pending, phase: { at: "sending", attempt: 1, rebased: false } }, transport);
      return;
    }
    const edits: PathEdit[] = [...entry.edits].map(([path, edit]) => ({ path, ...edit }));
    if (!edits.length) return;
    const problems = editProblems(latest, edits);
    if (problems.length) {
      this.#put(part, { ...entry, operation: null, problems, outcome: { kind: "problems", count: problems.length }, outcomeShownAt: null, restored: null });
      return;
    }
    const conflicts = this.conflicts(part);
    if (conflicts.length) {
      this.#put(part, { ...entry, operation: null, outcome: { kind: "conflicts", count: conflicts.length }, outcomeShownAt: null });
      return;
    }
    const operation: Operation = {
      id: this.#deps.newId(),
      submission: { part, edits },
      firstSentOn: latest.revision,
      startedAt: this.#deps.now(),
      resendable: true,
      restored: false,
      phase: { at: "sending", attempt: 1, rebased: false },
    };
    await this.#run(part, operation, transport);
  }

  async #run(part: string, operation: Operation, transport: SaveTransport): Promise<void> {
    this.#update(part, (entry) => ({ ...entry, operation, outcome: null, outcomeShownAt: null, problems: [], restored: null }));
    const finish = await runOperation(operation, submittedWrite(operation.submission), this.#context(transport, (phase) => this.#phase(part, operation.id, phase)));
    this.#finish(part, operation, finish);
  }

  #context(transport: SaveTransport, onPhase: (phase: Phase) => void): RunContext {
    return {
      transport,
      latest: () => this.#latest!,
      observe: (state) => this.observe(state),
      now: () => this.#deps.now(),
      onPhase,
    };
  }

  #phase(part: string, id: string, phase: Phase): void {
    const entry = this.part(part);
    if (entry.operation?.id !== id) return;
    this.#put(part, { ...entry, operation: { ...entry.operation, phase } });
  }

  #finish(part: string, operation: Operation, finish: Finish): void {
    const entry = this.part(part);
    if (entry.operation?.id !== operation.id) return;
    const ended = { ...entry, operation: null, outcomeShownAt: null };
    switch (finish.kind) {
      case "applied":
      case "already": {
        const revision = finish.kind === "applied" ? finish.revision : finish.state.revision;
        const lost = new Set(operation.restored ? operation.submission.edits.filter((edit) => holdsSecret(edit.value)).map((edit) => edit.path) : []);
        const done = completeSave(entry.edits, operation.submission, revision, this.#latest && this.#latest.revision >= finish.state.revision ? this.#latest : finish.state, lost);
        for (const [provisional, saved] of done.identities) this.#identities.set(provisional, saved);
        const outcome: Outcome =
          finish.kind === "applied"
            ? { kind: "saved", revision, lostReply: finish.lostReply, rebased: finish.rebased, changedElsewhere: done.changedElsewhere, newer: done.newer }
            : { kind: "already", revision, newer: done.newer };
        const created = createdBackend(operation.submission);
        const landed = created && part.startsWith(SETUP_PREFIX) ? backendPart(created.id) : null;
        if (landed && created) {
          const there = this.part(landed);
          this.#landings.set(part, created.id);
          this.#put(part, EMPTY_PART);
          this.#put(landed, { ...there, edits: new Map([...there.edits, ...done.edits]), outcome, outcomeShownAt: null, problems: [], restored: null });
          return;
        }
        this.#put(part, { ...ended, edits: done.edits, outcome, problems: [], restored: done.edits.size ? entry.restored : null });
        return;
      }
      case "conflicts":
        this.#put(part, { ...ended, outcome: { kind: "conflicts", count: finish.paths.length } });
        return;
      case "problems":
        this.#put(part, { ...ended, problems: finish.problems, outcome: { kind: "problems", count: finish.problems.length } });
        return;
      case "refused":
        this.#put(part, { ...ended, outcome: { kind: "refused", reason: finish.reason } });
        return;
      case "exhausted":
        this.#put(part, { ...ended, outcome: { kind: "exhausted" } });
        return;
      case "expired":
        this.#put(part, { ...ended, outcome: { kind: "expired", left: entry.edits.size } });
        if (this.#latest) this.#settle(part, this.part(part), this.#latest);
        return;
      case "unconfirmed":
        this.#put(part, { ...entry, operation: { ...operation, phase: { at: "unconfirmed", reason: finish.reason } } });
        return;
    }
  }

  async runInstant(write: InstantWrite): Promise<InstantOutcome | null> {
    const latest = this.#latest;
    const transport = this.#transport;
    if (!latest || !transport || this.instantBusy()) return null;
    const operation: Operation = {
      id: this.#deps.newId(),
      submission: { part: `instant:${write.key}`, edits: [] },
      firstSentOn: latest.revision,
      startedAt: this.#deps.now(),
      resendable: false,
      restored: false,
      phase: { at: "sending", attempt: 1, rebased: false },
    };
    this.#instants.set(write.key, { write, state: { pending: { value: write.pending }, saved: false, note: null, operation } });
    this.#notify();
    const finish = await runOperation(operation, write, this.#context(transport, () => {}));
    return this.#finishInstant(write.key, operation, finish);
  }

  #finishInstant(key: string, operation: Operation, finish: Finish): InstantOutcome | null {
    const entry = this.#instants.get(key);
    if (!entry || entry.state.operation?.id !== operation.id) return null;
    const { write } = entry;
    const now = finish.kind === "unconfirmed" ? finish.state : finish.kind === "problems" || finish.kind === "refused" ? this.#latest : finish.state;
    const set = (state: InstantState) => {
      this.#instants.set(key, { write, state });
      this.#notify();
    };
    const tick = () => {
      this.#deps.later(() => {
        const current = this.#instants.get(key);
        if (current?.state.saved) {
          this.#instants.set(key, { write, state: { ...current.state, saved: false } });
          this.#notify();
        }
      }, SAVED_SHOWN_MS);
    };
    const undone = write.undone ?? "changed";
    switch (finish.kind) {
      case "applied":
        set({ pending: null, saved: true, note: finish.lostReply ? { text: `Saved at revision ${finish.revision}: BB Box did not reply, and its receipt for this change confirms it.`, tone: "info" } : null, operation: null });
        tick();
        return { kind: "saved", revision: finish.revision };
      case "already":
        set({ pending: null, saved: true, note: { text: `Already ${write.say(finish.state)}: changed elsewhere at revision ${finish.state.revision}.`, tone: "info" }, operation: null });
        tick();
        return { kind: "already", revision: finish.state.revision };
      case "conflicts":
        set({ pending: null, saved: false, note: { text: `${write.what} was not ${undone}: it was changed elsewhere while you chose. It is ${write.say(finish.state)} now.`, tone: "bad" }, operation: null });
        return { kind: "conflicts" };
      case "problems":
        set({ pending: null, saved: false, note: { text: `${write.what} was not ${undone}: ${reasonAfterColon(finish.problems.map((problem) => problem.message).join(" ") || "BB Box gave no reason.")}`, tone: "bad" }, operation: null });
        return { kind: "refused" };
      case "refused":
        set({ pending: null, saved: false, note: { text: `${write.what} was not ${undone}: ${reasonAfterColon(finish.reason)}`, tone: "bad" }, operation: null });
        return { kind: "refused" };
      case "exhausted":
        set({ pending: null, saved: false, note: { text: `${write.what} was not ${undone}: the configuration changed ${MOST_TRIES} times while saving. It is ${write.say(finish.state)}; try again.`, tone: "bad" }, operation: null });
        return { kind: "exhausted" };
      case "unconfirmed":
      case "expired": {
        const reason = finish.kind === "unconfirmed" ? finish.reason : "its receipt is no longer kept";
        const text = now
          ? `Not confirmed: BB Box did not reply (${reason}), and has no receipt for this change. ${write.what} is ${write.say(now)} now, at revision ${now.revision}.`
          : `Not confirmed: BB Box did not reply (${reason}). Reload the page to see what is saved.`;
        set({ pending: null, saved: false, note: { text, tone: "bad" }, operation: finish.kind === "unconfirmed" ? { ...operation, phase: { at: "unconfirmed", reason } } : null });
        return { kind: "unconfirmed" };
      }
    }
  }

  #settleInstant(key: string, entry: InstantEntry, state: ConfigState): void {
    const operation = entry.state.operation;
    if (!operation || operation.phase.at !== "unconfirmed") return;
    const receipt = receiptOf(state, operation);
    if (!receipt) return;
    this.#instants.set(key, { write: entry.write, state: { pending: null, saved: false, note: { text: `Saved at revision ${receipt.revision}: BB Box did not reply, and its receipt for this change confirms it. ${entry.write.what} is ${entry.write.say(state)} now.`, tone: "info" }, operation: null } });
  }
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(values);
  return [...values].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function operationId(): string {
  return `page-${Date.now().toString(36)}-${randomHex(8)}`;
}

let shared: DraftRegistry | null = null;
let leaveWarningInstalled = false;

function installLeaveWarning(): void {
  if (leaveWarningInstalled || typeof window === "undefined") return;
  leaveWarningInstalled = true;
  window.addEventListener("beforeunload", (event) => {
    if (!shared?.partsWithDrafts().length) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

export function drafts(): DraftRegistry {
  installLeaveWarning();
  shared ??= new DraftRegistry({
    storage: sessionDraftStorage(typeof sessionStorage === "undefined" ? null : sessionStorage),
    now: () => Date.now(),
    newId: operationId,
    later: (run, ms) => void setTimeout(run, ms),
  });
  return shared;
}

export function forgetDrafts(): void {
  shared = null;
}
