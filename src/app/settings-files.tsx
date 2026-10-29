import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { useId, useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { isSecretState } from "./config.ts";
import { switchKey, useSettings } from "./settings-context.tsx";
import { describedBy, unplacedProblems } from "./settings-draft-fields.tsx";
import { FILES_PART, operationId } from "./settings-drafts.ts";
import { Section } from "./settings-fields.tsx";
import { RowNote } from "./settings-parts.tsx";
import { filePath, newFilePath, storedAt, type Path } from "./settings-paths.ts";
import { ChangedChip, ConflictNote, RestoredNote, SaveBar, focusAfterRender, useDraft, type Draft } from "./settings-saving.tsx";

const CONTENT_PLACEHOLDER = "Paste the file's text. It is never shown again.";
const ADD_FILE = "files/add";

function newFileId(): string {
  return operationId().slice(-8);
}

function ContentEditor({ draft, path, label, onEmptied, onClose }: { draft: Draft; path: Path; label: string; onEmptied: () => void; onClose: () => void }) {
  const id = useId();
  const value = draft.edit(path);
  const text = value?.kind === "secret" ? (value.text ?? "") : "";
  const conflict = draft.conflict(path);
  const problem = draft.problem(`${path}/content`);
  return (
    <div className="mt-2 space-y-1.5">
      <Textarea
        id={id}
        data-draft-path={`${path}/content`}
        aria-label={label}
        aria-describedby={describedBy(problem && `${id}-problem`, conflict && `${id}-conflict`)}
        aria-invalid={problem ? true : undefined}
        className={cn("min-h-24 font-mono text-xs", value && "border-warning/60")}
        placeholder={CONTENT_PLACEHOLDER}
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={(event) => {
          if (event.target.value) {
            draft.set(path, { kind: "secret", text: event.target.value });
            onClose();
            return;
          }
          draft.forget(path);
          onEmptied();
        }}
      />
      {problem ? (
        <p id={`${id}-problem`} role="alert" className="text-xs text-destructive-text">
          {problem}
        </p>
      ) : null}
      {conflict ? (
        <ConflictNote
          id={`${id}-conflict`}
          conflict={conflict}
          onTheirs={() => {
            draft.forget(path);
            focusAfterRender(`${path}/content`, path, ADD_FILE);
          }}
          onMine={() => {
            draft.keepMine(path);
            focusAfterRender(`${path}/content`, ADD_FILE);
          }}
        />
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7"
        disabled={draft.beingSaved(path) && draft.busy}
        onClick={() => {
          draft.forget(path);
          onClose();
          focusAfterRender(path);
        }}
      >
        {value ? "Don't replace it" : "Cancel"}
      </Button>
    </div>
  );
}

function NewFileEditor({ draft, path }: { draft: Draft; path: Path }) {
  const id = useId();
  const value = draft.edit(path);
  const latest = draft.latest;
  if (value?.kind !== "new-file") return null;
  const pathProblem = draft.problem(`${path}/path`);
  const contentProblem = draft.problem(`${path}/content`);
  const conflict = draft.conflict(path);
  const stored = storedAt(latest, path, value);
  const replaces = !conflict && stored.kind === "version" && stored.version !== null;
  const typed = value.path.trim();
  const sending = draft.beingSaved(path) && draft.busy;
  return (
    <div className="space-y-1.5 bg-surface-raised px-4 py-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        A new file
        <ChangedChip show />
      </p>
      <Input
        id={`${id}-path`}
        data-draft-path={`${path}/path`}
        aria-label="New file's path under the box user's home"
        aria-describedby={describedBy(pathProblem && `${id}-path-problem`, replaces && `${id}-replaces`)}
        aria-invalid={pathProblem ? true : undefined}
        className="h-8 font-mono text-xs"
        placeholder=".config/tool/settings.json"
        disabled={sending}
        value={value.path}
        onChange={(event) => draft.set(path, { kind: "new-file", path: event.target.value, text: value.text })}
      />
      {pathProblem ? (
        <p id={`${id}-path-problem`} role="alert" className="text-xs text-destructive-text">
          {pathProblem}
        </p>
      ) : null}
      {replaces ? (
        <p id={`${id}-replaces`} className="text-xs text-warning-text">
          ~/{typed} is already a file here. Saving replaces it.
        </p>
      ) : null}
      <Textarea
        id={`${id}-content`}
        data-draft-path={`${path}/content`}
        aria-label={typed ? `Content of ~/${typed}` : "New file's content"}
        aria-describedby={describedBy(contentProblem && `${id}-content-problem`, conflict && `${id}-conflict`)}
        aria-invalid={contentProblem ? true : undefined}
        className="min-h-24 font-mono text-xs"
        placeholder={CONTENT_PLACEHOLDER}
        autoComplete="off"
        spellCheck={false}
        value={value.text ?? ""}
        onChange={(event) => draft.set(path, { kind: "new-file", path: value.path, text: event.target.value })}
      />
      {contentProblem ? (
        <p id={`${id}-content-problem`} role="alert" className="text-xs text-destructive-text">
          {contentProblem}
        </p>
      ) : null}
      {conflict ? (
        <ConflictNote
          id={`${id}-conflict`}
          conflict={conflict}
          onTheirs={() => {
            draft.forget(path);
            focusAfterRender(ADD_FILE);
          }}
          onMine={() => {
            draft.keepMine(path);
            focusAfterRender(`${path}/content`);
          }}
        />
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7"
        disabled={sending}
        onClick={() => {
          draft.forget(path);
          focusAfterRender(ADD_FILE);
        }}
      >
        Don't add it
      </Button>
    </div>
  );
}

export function BoxFilesSection() {
  const { state, instant, writes } = useSettings();
  const draft = useDraft(FILES_PART, "files for every box");
  const [opened, setOpened] = useState<readonly string[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removed, setRemoved] = useState<string | null>(null);
  const files = draft.latest.document.general.files ?? [];
  const newFiles = [...draft.entry.edits].filter(([, edit]) => edit.value.kind === "new-file").map(([path]) => path);
  const editing = (path: string) => opened.includes(path) || draft.edit(filePath(path))?.kind === "secret";
  const placed = [...draft.entry.edits.keys()].flatMap((path) => [path, `${path}/path`, `${path}/content`]);
  const removeKey = removed ? switchKey.removeFile(removed) : null;
  return (
    <Section
      title="Files for every box"
      description="Copied into each Linux and macOS box's home. Contents are kept secret."
      action={
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7"
          data-draft-path={ADD_FILE}
          onClick={() => {
            const path = newFilePath(newFileId());
            draft.set(path, { kind: "new-file", path: "", text: "" });
            focusAfterRender(`${path}/path`);
          }}
        >
          <Icon name="Plus" aria-hidden />
          Add file
        </Button>
      }
      plain={!files.length && !newFiles.length && !draft.entry.restored && !draft.entry.outcome && !draft.entry.problems.length}
    >
      <div className="space-y-2">
        <RestoredNote draft={draft} />
        {files.length || newFiles.length ? (
          <div className="divide-y divide-border">
            {files.map((file) => {
              const path = filePath(file.path);
              const set = isSecretState(file.content) && file.content.set;
              return (
                <div key={file.path} data-setting={path} className="py-2.5 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <code className="min-w-0 flex-1 truncate text-xs text-foreground">~/{file.path}</code>
                    <ChangedChip show={draft.edit(path) !== null} />
                    <span className="text-xs text-subtle-foreground">{set ? "Set" : "Not set"}</span>
                    {editing(file.path) ? null : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7"
                        data-draft-path={path}
                        aria-label={`Replace the content of ~/${file.path}`}
                        onClick={() => {
                          setOpened((current) => [...current, file.path]);
                          focusAfterRender(`${path}/content`);
                        }}
                      >
                        Replace…
                      </Button>
                    )}
                    <Button type="button" variant="ghost" size="sm" className="h-7 text-muted-foreground" aria-label={`Remove ~/${file.path}`} disabled={instant.pending !== null} onClick={() => setRemoving(file.path)}>
                      Remove…
                    </Button>
                  </div>
                  {editing(file.path) ? (
                    <ContentEditor
                      draft={draft}
                      path={path}
                      label={`New content for ~/${file.path}`}
                      onEmptied={() => setOpened((current) => (current.includes(file.path) ? current : [...current, file.path]))}
                      onClose={() => setOpened((current) => current.filter((each) => each !== file.path))}
                    />
                  ) : null}
                </div>
              );
            })}
            {newFiles.map((path) => (
              <NewFileEditor key={path} draft={draft} path={path} />
            ))}
          </div>
        ) : null}
        {removeKey ? <RowNote note={instant.note(removeKey)} /> : null}
        <SaveBar draft={draft} inline primary="Save files" unplaced={unplacedProblems(draft, placed)} />
      </div>
      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove ~/{removing}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>Boxes made from now on no longer get it. Boxes already made keep their copy.</p>
                <p>Its content is deleted from BB Box and cannot be shown or got back; to use it again, paste it again.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const path = removing;
                setRemoving(null);
                if (!path) return;
                setRemoved(path);
                void instant.run(writes.removeFile(state, path));
              }}
            >
              Remove file
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}
