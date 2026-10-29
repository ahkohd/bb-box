import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { withoutSecretVersions, type Problem } from "../core/document.ts";
import type { ConfigState, Contract } from "../plugin/contract.ts";
import { Badge, message, relativeTime } from "./common.tsx";
import { useSettings } from "./settings-context.tsx";
import type { DraftRegistry, Outcome } from "./settings-drafts.ts";
import { IMPORT_PART, IMPORT_TEXT, exportedText, importChanges, importPlan, importValueWords, importedPaths, invalidWords, parseImport, secretsToGive, type ImportChange } from "./settings-import.ts";
import { Card, Group, RowNote, Rows, SettingRow } from "./settings-parts.tsx";
import { ConflictNote, RestoredNote, SaveBar, focusAfterRender, useDraft, useRegistry, type Draft, type SaveWords } from "./settings-saving.tsx";

const COPIED_SHOWN_MS = 1600;
const EDITOR = "import/editor";
const OPEN_IMPORT = "import/open";
const COPY_NOTE = "configuration/copy-note";
const COPY_BUTTON = "configuration/copy";
const IMPORT_RESULT = "import/result";

type CheckOutcome =
  | { readonly kind: "invalid"; readonly words: string }
  | { readonly kind: "unread"; readonly problems: readonly Problem[] }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "read"; readonly revision: number; readonly problems: readonly Problem[]; readonly blockers: readonly string[]; readonly unset: readonly string[] };

interface ImportCheck {
  readonly text: string;
  readonly outcome: CheckOutcome;
}

interface CopyRemoval {
  readonly removing: boolean;
  readonly note: { readonly text: string; readonly tone: "bad" | "info" } | null;
}

function memoryStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const lastCheck = memoryStore<ImportCheck | null>(null);
const checking = memoryStore<string | null>(null);
const copyRemoval = memoryStore<CopyRemoval>({ removing: false, note: null });
const opened = memoryStore(false);

export function forgetConfigurationPage(): void {
  lastCheck.set(null);
  checking.set(null);
  copyRemoval.set({ removing: false, note: null });
  opened.set(false);
}

function useStore<T>(store: ReturnType<typeof memoryStore<T>>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

function pastedText(draft: Draft): string | null {
  const value = draft.edit(IMPORT_TEXT);
  return value?.kind === "secret" ? value.text : null;
}

function plural(count: number, word: string): string {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}

function changesOf(draft: Draft): number {
  return importedPaths(draft.entry.edits).length;
}

function importWords(ready: boolean, current: ImportCheck | null, text: string | null): SaveWords {
  const kept = (draft: Draft) => (pastedText(draft) === null ? "" : " Your text is still here.");
  const newer = (draft: Draft) => (pastedText(draft) !== null ? " Your newer text is not applied yet." : "");
  const outcome = (outcome: Outcome, draft: Draft): string => {
    switch (outcome.kind) {
      case "saved": {
        const head = outcome.lostReply ? `Applied at revision ${outcome.revision}. The reply was lost; BB Box's receipt for this import confirms it.` : outcome.rebased ? `Applied at revision ${outcome.revision}, on top of a change made elsewhere.` : "Applied.";
        const since = outcome.changedElsewhere.length ? ` Since then, changed elsewhere: ${outcome.changedElsewhere.join(", ")}.` : "";
        return `${head}${since}${newer(draft)}`;
      }
      case "already":
        return `Already applied: the configuration had these values at revision ${outcome.revision}.${newer(draft)}`;
      case "conflicts":
        return conflicts(Math.max(outcome.count, draft.conflicts.length));
      case "problems":
        return `Not applied: fix the ${outcome.count === 1 ? "change" : `${outcome.count} changes`} marked.${kept(draft)}`;
      case "refused":
        return `Not applied: ${outcome.reason}${kept(draft)}`;
      case "exhausted":
        return `Not applied: the configuration changed three times while applying.${kept(draft)}`;
      case "expired":
        return changesOf(draft) ? "Not confirmed: this import is older than the receipts BB Box keeps, so it is not sent again. Check it again against what is saved now." : "Not confirmed: this import is older than the receipts BB Box keeps. What is saved now matches it.";
      case "unsendable":
        return "Not confirmed: BB Box has no receipt for this import yet. What you pasted was not kept when the page reloaded, so it cannot be sent again: paste it again, then check and apply it.";
    }
  };
  const conflicts = (count: number) => `${count === 1 ? "A setting the import changes was" : `${count} settings the import changes were`} changed elsewhere after you checked it. Choose for each, then apply.`;
  const pending = (draft: Draft): string => {
    if (!text) return "Paste a configuration, then check it to see what it changes.";
    if (!current || current.text !== text) return "Check it to see what it changes. Nothing is applied until you choose Apply.";
    if (current.outcome.kind !== "read") return "Fix the file, then check it again.";
    if (current.outcome.blockers.length) return "Fix the file as said above, then check it again.";
    const count = changesOf(draft);
    if (!count) return `It changes nothing against revision ${draft.latest.revision}.`;
    return ready ? `Apply makes ${plural(count, "change")}, as listed above.` : "Check it again.";
  };
  return {
    save: "Apply",
    again: "Apply again",
    saving: "Applying…",
    rebasing: "Someone saved first. Checking the import's changes against theirs…",
    looking: "Not confirmed: BB Box did not reply. Looking for this import's receipt…",
    unconfirmed: "Not confirmed: BB Box has no receipt for this import yet. Your text is still here. Applying again resends the same request, which BB Box applies at most once.",
    discard: "Closes the import and forgets the text you pasted. Nothing is applied.",
    pending,
    conflicts,
    outcome,
  };
}

function textIn(registry: DraftRegistry): string | null {
  const value = registry.part(IMPORT_PART).edits.get(IMPORT_TEXT)?.value;
  return value?.kind === "secret" ? value.text : null;
}

function replaceImported(registry: DraftRegistry, values: Parameters<DraftRegistry["replace"]>[2]): void {
  registry.replace(IMPORT_PART, (path) => path === IMPORT_TEXT, values);
}

async function checkText(rpc: ReturnType<typeof useRpc<Contract>>, registry: DraftRegistry, text: string): Promise<void> {
  const parsed = parseImport(text);
  if (!parsed.ok) {
    replaceImported(registry, []);
    lastCheck.set({ text, outcome: { kind: "invalid", words: invalidWords(parsed) } });
    return;
  }
  checking.set(text);
  try {
    const result = await rpc.call("config.check", { draft: parsed.value, read: true });
    const state = registry.latest;
    if (textIn(registry) !== text || !state) return;
    if (!result.read) {
      replaceImported(registry, []);
      lastCheck.set({ text, outcome: { kind: "unread", problems: result.problems } });
      return;
    }
    const plan = importPlan(state, result.read, parsed.value);
    replaceImported(registry, plan.values);
    lastCheck.set({ text, outcome: { kind: "read", revision: state.revision, problems: result.problems, blockers: plan.problems, unset: plan.unset } });
  } catch (caught) {
    lastCheck.set({ text, outcome: { kind: "failed", reason: message(caught).replace(/\.?$/, ".") } });
  } finally {
    if (checking.get() === text) checking.set(null);
  }
}

function closeImport(): void {
  opened.set(false);
  lastCheck.set(null);
  focusAfterRender(OPEN_IMPORT);
}

function useImportDraft(): Draft {
  const draft = useDraft(IMPORT_PART, "the import", { enterSaves: false });
  return {
    ...draft,
    discard: () => {
      draft.discard();
      closeImport();
    },
  };
}

type ImportDraft = Draft;

function ChangeRow({ draft, change }: { draft: ImportDraft; change: ImportChange }) {
  const conflict = draft.conflict(change.path);
  const problem = draft.problem(change.path);
  return (
    <div data-draft-path={change.path} tabIndex={-1} className="px-4 py-2 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring">
      <div className={cn("flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-4", change.under && "sm:pl-4")}>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-foreground">
          <span className="min-w-0 break-words">{change.label}</span>
          {change.secret ? <Badge>secret</Badge> : null}
        </span>
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-xs sm:max-w-[60%] sm:justify-end sm:text-right">
          <span className="break-words text-subtle-foreground">{change.before}</span>
          <span className="sr-only">becomes</span>
          <Icon name="ArrowRight" className="size-3 shrink-0 self-center text-subtle-foreground" aria-hidden />
          <span className="break-words text-foreground">{change.after}</span>
        </span>
      </div>
      {conflict ? (
        <ConflictNote
          conflict={conflict}
          shown={(value) => importValueWords(draft.latest, change.path, value)}
          onTheirs={() => {
            draft.forget(change.path);
            focusAfterRender(EDITOR);
          }}
          onMine={() => {
            draft.keepMine(change.path);
            focusAfterRender(change.path);
          }}
        />
      ) : null}
      {problem ? (
        <p role="alert" className="mt-1.5 text-xs text-destructive-text">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

function ProblemList({ title, items, tone }: { title: string; items: readonly string[]; tone: "bad" | "warn" | "info" }) {
  if (!items.length) return null;
  return (
    <div role={tone === "bad" ? "alert" : "status"} className="space-y-1 text-xs leading-snug">
      <p className={tone === "bad" ? "text-destructive-text" : tone === "warn" ? "text-warning-text" : "text-foreground"}>{title}</p>
      <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function problemWords(problems: readonly Problem[]): string[] {
  return [...new Set(problems.map((problem) => problem.message))];
}

function CheckResult({ draft, current, text }: { draft: ImportDraft; current: ImportCheck | null; text: string | null }) {
  const groups = importChanges(draft.latest, draft.entry.edits);
  const count = changesOf(draft);
  const restored = text === null && count > 0;
  const stale = current !== null && text !== null && current.text !== text;
  const outcome = current && !stale ? current.outcome : null;
  return (
    <div className="space-y-3">
      {stale && current.outcome.kind === "read" ? <p className="text-xs text-warning-text">Your text changed after you checked it, so what it changes was cleared. Check it again.</p> : null}
      {outcome?.kind === "invalid" ? (
        <p role="alert" className="text-xs text-destructive-text">
          {outcome.words}
        </p>
      ) : null}
      {outcome?.kind === "failed" ? (
        <p role="alert" className="text-xs text-destructive-text">
          Not checked: {outcome.reason} Your text is still here; check it again.
        </p>
      ) : null}
      {outcome?.kind === "unread" ? <ProblemList tone="bad" title="BB Box cannot read this file as its configuration, so nothing was compared. Fix these, then check it again:" items={problemWords(outcome.problems)} /> : null}
      {outcome?.kind === "read" ? (
        <>
          <ProblemList tone="bad" title="Apply waits until these are fixed in the file:" items={outcome.blockers} />
          <ProblemList tone="warn" title="BB Box's checks found these problems. A problem in a backend that is off is saved with it; any other stops Apply:" items={problemWords(outcome.problems)} />
          <ProblemList tone="info" title="Not in the file, so not set. Give each in the file, or on its page after:" items={outcome.unset} />
        </>
      ) : null}
      {count ? (
        <Group title={restored ? `What it would have changed: ${plural(count, "change")}` : `What it changes against revision ${outcome?.kind === "read" ? outcome.revision : draft.latest.revision}: ${plural(count, "change")}`} description="Secrets and file contents are never shown: a change to one says only that it is replaced.">
          <Card>
            <Rows>
              {groups.map((group) => (
                <div key={group.place} role="group" aria-label={group.place} className="py-1">
                  <p className="px-4 pb-0.5 pt-1.5 text-2xs font-medium text-muted-foreground">{group.place}</p>
                  {group.changes.map((change) => (
                    <ChangeRow key={change.path} draft={draft} change={change} />
                  ))}
                </div>
              ))}
            </Rows>
          </Card>
        </Group>
      ) : outcome?.kind === "read" && !outcome.blockers.length ? (
        <p role="status" className="text-xs text-muted-foreground">
          It changes nothing against revision {outcome.revision}.
        </p>
      ) : null}
    </div>
  );
}

function ImportEditor({ draft }: { draft: ImportDraft }) {
  const rpc = useRpc<Contract>();
  const registry = useRegistry();
  const current = useStore(lastCheck);
  const busyChecking = useStore(checking);
  const text = pastedText(draft);
  const files = useRef<HTMLInputElement>(null);
  const outcome = current && current.text === text ? current.outcome : null;
  const ready = outcome?.kind === "read" && !outcome.blockers.length && changesOf(draft) > 0 && !busyChecking;
  const setText = (next: string) => {
    draft.set(IMPORT_TEXT, { kind: "secret", text: next });
    if (importedPaths(registry.part(IMPORT_PART).edits).length && lastCheck.get()?.text !== next) replaceImported(registry, []);
  };
  const check = () => {
    if (text === null || busyChecking !== null) return;
    void checkText(rpc, registry, text);
  };
  const open = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    void file.text().then((read) => {
      setText(read);
      focusAfterRender(EDITOR);
    });
  };
  const restoredWords = draft.entry.restored ? (
    <>
      Your import is back{changesOf(draft) ? `: what it would have changed, ${plural(changesOf(draft), "change")}` : ""}.<span className="text-muted-foreground"> The configuration you pasted was not kept, as it may hold secrets; paste it again.</span>
    </>
  ) : null;
  return (
    <div className="space-y-3">
      <RestoredNote draft={draft} words={restoredWords} />
      <Card className="space-y-3 px-4 py-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="min-w-0 flex-1 basis-56">
            <label htmlFor="settings-import-text" className="text-sm text-foreground">
              Import a configuration
            </label>
            <p id="settings-import-help" className="mt-0.5 text-xs leading-snug text-subtle-foreground">
              Paste a file such as an export, or open one. It may hold secrets, so this tab keeps it in memory only, never in the browser's storage.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => files.current?.click()}>
            <Icon name="FolderOpen" aria-hidden />
            Open a file…
          </Button>
          <input ref={files} type="file" accept="application/json,.json" className="hidden" tabIndex={-1} aria-hidden onChange={open} />
        </div>
        <Textarea
          id="settings-import-text"
          data-draft-path={EDITOR}
          aria-describedby="settings-import-help"
          spellCheck={false}
          autoComplete="off"
          placeholder="Paste the configuration's JSON here"
          className="min-h-40 font-mono text-2xs leading-relaxed"
          value={text ?? ""}
          onChange={(event) => setText(event.target.value)}
        />
        <CheckResult draft={draft} current={current} text={text} />
        <SaveBar
          draft={draft}
          inline
          words={importWords(ready, current, text)}
          ready={ready}
          actions={
            <Button type="button" variant="outline" size="sm" className="h-7" disabled={!text} aria-disabled={busyChecking !== null || undefined} onClick={check}>
              {busyChecking !== null ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
              {outcome ? "Check again" : "Check"}
            </Button>
          }
        />
        {!draft.entry.edits.size && !draft.entry.operation ? (
          <Button type="button" variant="ghost" size="sm" className="h-7" onClick={closeImport}>
            Close
          </Button>
        ) : null}
      </Card>
    </div>
  );
}

function ExportRow() {
  const { state } = useSettings();
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  useEffect(() => {
    if (copied !== "copied") return;
    const timer = setTimeout(() => setCopied(null), COPIED_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const text = exportedText(withoutSecretVersions(state.document));
  const secrets = secretsToGive(state);
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `bb-box-revision-${state.revision}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return (
    <div>
      <SettingRow
        label="Export"
        description={
          <>
            The whole configuration at revision {state.revision} as JSON, as <code className="whitespace-nowrap font-mono">bb box config show --json</code> prints it. It has no secret in it: each shows only as set or not.
          </>
        }
      >
        <span role="status" aria-live="polite" className="text-2xs text-muted-foreground empty:hidden">
          {copied === "copied" ? "Copied" : null}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7"
          onClick={() => {
            if (!navigator.clipboard) return setCopied("failed");
            navigator.clipboard.writeText(text).then(
              () => setCopied("copied"),
              () => setCopied("failed"),
            );
          }}
        >
          <Icon name="Copy" aria-hidden />
          Copy as JSON
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-7" onClick={download}>
          <Icon name="Download" aria-hidden />
          Download
        </Button>
      </SettingRow>
      {copied === "failed" ? <RowNote note="The browser did not let the page copy it. Use Download, or bb box config show --json." className="px-4 pb-3" /> : null}
      <div className="px-4 pb-3 text-xs leading-snug text-subtle-foreground">
        {secrets.length ? (
          <>
            <p>To set BB Box up from it, give {secrets.length === 1 ? "this secret" : `these ${secrets.length} secrets`} again, in the file in place of {'{"set": true}'} or on their pages after:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {secrets.map((secret, index) => (
                <li key={index}>
                  {secret.owner}: {secret.what}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>It has no secret to give again.</p>
        )}
      </div>
    </div>
  );
}

function MovedCopyRow() {
  const { state, refresh } = useSettings();
  const rpc = useRpc<Contract>();
  const removal = useStore(copyRemoval);
  const [asking, setAsking] = useState(false);
  const copy = state.migrated;
  const remove = async () => {
    copyRemoval.set({ removing: true, note: null });
    let note: CopyRemoval["note"];
    try {
      const result = await rpc.call("config.migrated.remove", null);
      note = { text: result.removed ? "Removed the copy of BB's earlier settings." : "There was no copy left to remove: it was removed elsewhere.", tone: "info" };
    } catch (caught) {
      const reason = message(caught).replace(/\.+$/, "");
      try {
        const after = await rpc.call("config.get", null);
        note = after.migrated ? { text: `The copy was not removed: ${reason}. It is still kept; try again.`, tone: "bad" } : { text: "Removed the copy of BB's earlier settings. BB Box did not reply, and the configuration shows it gone.", tone: "info" };
      } catch {
        note = { text: `Not confirmed: BB Box did not reply (${reason}), and the configuration could not be read again. Reload the page to see whether the copy is kept.`, tone: "bad" };
      }
    }
    await refresh().catch(() => {});
    copyRemoval.set({ removing: false, note });
    focusAfterRender(COPY_NOTE, COPY_BUTTON);
  };
  return (
    <>
      {copy ? (
        <SettingRow
          label="Settings moved from BB"
          description={`BB Box kept a copy of BB's own settings for it when it moved them into this configuration, ${relativeTime(copy.at, Date.now())}, so a value that moved wrongly can be compared. It holds no secret. bb box config migrated shows it.`}
        >
          <Button type="button" variant="outline" size="sm" className="h-7" data-draft-path={COPY_BUTTON} disabled={removal.removing} onClick={() => setAsking(true)}>
            {removal.removing ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
            {removal.removing ? "Removing…" : "Remove copy…"}
          </Button>
        </SettingRow>
      ) : null}
      {removal.note ? (
        <p data-draft-path={COPY_NOTE} tabIndex={-1} role={removal.note.tone === "bad" ? "alert" : "status"} className={cn("px-4 py-3 text-xs leading-snug outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring", removal.note.tone === "bad" ? "text-destructive-text" : "text-foreground")}>
          {removal.note.text}
        </p>
      ) : null}
      <AlertDialog open={asking} onOpenChange={(open) => !open && setAsking(false)}>
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            const button = document.querySelector<HTMLElement>(`[data-draft-path="${COPY_BUTTON}"]`);
            if (!button) return;
            event.preventDefault();
            button.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the copy of BB's earlier settings?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>BB Box made it {copy ? relativeTime(copy.at, Date.now()) : ""}, when it moved BB's settings into this configuration. Everything in it is in the configuration now, and nothing reads it.</p>
                <p>Once removed it cannot be got back. To keep a record first, run bb box config migrated --json.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                setAsking(false);
                void remove();
              }}
            >
              Remove copy
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function ConfigurationOptions() {
  const { state } = useSettings();
  const draft = useImportDraft();
  const registry = useRegistry();
  const open = useStore(opened);
  const applied = draft.entry.outcome?.kind === "saved" || draft.entry.outcome?.kind === "already";
  const editing = draft.entry.edits.size > 0 || draft.entry.operation !== null || open;
  useEffect(() => {
    if (applied && !draft.entry.edits.size && opened.get()) {
      opened.set(false);
      lastCheck.set(null);
      focusAfterRender(IMPORT_RESULT);
    }
  }, [applied, draft.entry.edits.size]);
  const outcome = draft.entry.outcome;
  const result = !editing && outcome && (outcome.kind === "saved" || outcome.kind === "already" || outcome.kind === "expired") ? importWords(false, null, null).outcome(outcome, draft) : null;
  const commands: readonly (readonly [string, string])[] = [
    ["bb box config show --json > bb-box.json", "Export it"],
    ["bb box config check bb-box.json --test", "Check a file, and run each backend's checks against it"],
    ["bb box config apply bb-box.json", "Save a file as the whole configuration"],
    ...(state.migrated ? ([["bb box config migrated", "Show the copy of BB's earlier settings; --remove removes it"]] as const) : []),
  ];
  return (
    <div className="space-y-6">
      <Card>
        <Rows>
          <SettingRow label={`Revision ${state.revision}`} description="Each save names the revision it was made from. When someone saved first, the page checks your changes against theirs: their changes to other settings stay, and a setting changed both ways asks you which to keep.">
            {null}
          </SettingRow>
          <ExportRow />
          <SettingRow label="Import" description="Apply a JSON file to this configuration. BB Box checks it and lists what it changes, before and after, before anything is applied.">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7"
              data-draft-path={OPEN_IMPORT}
              disabled={editing}
              onClick={() => {
                if (!draft.entry.edits.size && !draft.entry.operation) registry.discard(IMPORT_PART);
                opened.set(true);
                focusAfterRender(EDITOR);
              }}
            >
              Import…
            </Button>
          </SettingRow>
          <MovedCopyRow />
        </Rows>
      </Card>
      {editing ? (
        <ImportEditor draft={draft} />
      ) : result ? (
        <p data-draft-path={IMPORT_RESULT} tabIndex={-1} role="status" className="flex items-start gap-1.5 rounded-sm px-1 text-xs leading-snug text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <Icon name="Check" className="mt-px size-3.5 shrink-0" aria-hidden />
          {result}
        </p>
      ) : null}
      <Group title="From a terminal" description="Agents and scripts change the configuration with these, through the same checks as this page.">
        <Card className="space-y-1.5 px-4 py-3">
          {commands.map(([command, what]) => (
            <p key={command} className="flex flex-wrap items-baseline gap-x-2 text-xs">
              <code className="font-mono text-foreground">{command}</code>
              <span className="text-subtle-foreground">{what}</span>
            </p>
          ))}
        </Card>
      </Group>
    </div>
  );
}
