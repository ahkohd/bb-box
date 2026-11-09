import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { plain, type Path, type PlainValue } from "./settings-paths.ts";
import { INVALID_BORDER } from "./size-field.ts";
import { SideLabelField } from "./field-shell.tsx";
import { ChangedChip, ConflictNote, focusAfterRender, saveOnEnter, type Draft } from "./settings-saving.tsx";

export function unplacedProblems(draft: Draft, placed: readonly Path[]): string[] {
  return draft.entry.problems.filter((problem) => !placed.includes(problem.path)).map((problem) => problem.message);
}

export function describedBy(...ids: readonly (string | null | false | undefined)[]): string | undefined {
  const joined = ids.filter(Boolean).join(" ");
  return joined || undefined;
}

export function DraftRow({
  draft,
  path,
  id,
  label,
  description,
  unit,
  chips,
  problem: shownProblem,
  wide,
  shown,
  onTheirs,
  children,
}: {
  draft: Draft;
  path: Path;
  id: string;
  label: string;
  description: ReactNode;
  unit?: string;
  chips?: ReactNode;
  problem?: string | null;
  wide?: boolean;
  shown?: (value: PlainValue) => string;
  onTheirs?: () => void;
  children: ReactNode;
}) {
  const conflict = draft.conflict(path);
  const problem = shownProblem === undefined ? draft.problem(path) : shownProblem;
  return (
    <SideLabelField
      path={path}
      htmlFor={id}
      label={label}
      chips={chips}
      changed={<ChangedChip show={draft.changed(path) && !conflict} />}
      help={
        <p id={`${id}-help`} className="mt-0.5 text-xs leading-snug text-subtle-foreground">
          {description}
        </p>
      }
      problem={problem}
      problemId={problem ? `${id}-problem` : undefined}
      controlClassName={cn("text-xs text-muted-foreground", wide ? "w-full sm:w-72" : undefined)}
      conflict={
        conflict ? (
          <ConflictNote
            id={`${id}-conflict`}
            conflict={conflict}
            shown={shown}
            onTheirs={() => {
              draft.forget(path);
              onTheirs?.();
              focusAfterRender(path);
            }}
            onMine={() => {
              draft.keepMine(path);
              focusAfterRender(path);
            }}
          />
        ) : null
      }
    >
      <div className={cn("flex items-center gap-1.5", wide && "sm:justify-end")}>
        {children}
        {unit}
      </div>
    </SideLabelField>
  );
}

export function DraftNumberRow({ draft, path, label, description, unit, unitWord, disabled, decimal = false }: { draft: Draft; path: Path; label: string; description: ReactNode; unit?: string; unitWord?: string; disabled?: boolean; decimal?: boolean }) {
  const id = useId();
  const problem = draft.problem(path);
  const conflict = draft.conflict(path);
  return (
    <DraftRow draft={draft} path={path} id={id} label={label} description={description} unit={unit}>
      <Input
        id={id}
        data-draft-path={path}
        aria-label={unitWord ? `${label}, in ${unitWord}` : undefined}
        aria-describedby={describedBy(`${id}-help`, problem && `${id}-problem`, conflict && `${id}-conflict`)}
        aria-invalid={problem ? true : undefined}
        className={cn("h-8 w-20 text-right text-xs tabular-nums", problem && INVALID_BORDER)}
        inputMode={decimal ? "decimal" : "numeric"}
        autoComplete="off"
        disabled={disabled}
        value={draft.text(path)}
        onChange={(event) => draft.set(path, plain(event.target.value))}
        onKeyDown={saveOnEnter(draft)}
      />
    </DraftRow>
  );
}

export function SecretControl({
  draft,
  path,
  label,
  set,
  controlId,
  describedBy: describe,
  invalid,
  conflicted,
  clearable,
  replacing,
  onReplacing,
}: {
  draft: Draft;
  path: Path;
  label: string;
  set: boolean;
  controlId: string;
  describedBy?: string;
  invalid: boolean;
  conflicted: boolean;
  clearable: boolean;
  replacing: boolean;
  onReplacing: (replacing: boolean) => void;
}) {
  const edit = draft.edit(path);
  const named = `the ${label}`;
  const typing = edit?.kind === "secret" || replacing;
  const inputFocused = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (typing || !inputFocused.current) return;
    inputFocused.current = false;
    if (document.activeElement === document.body || document.activeElement === null) button.current?.focus();
  }, [typing]);
  if (edit?.kind === "removed") {
    return (
      <span className="flex flex-wrap items-center gap-1.5 text-xs text-warning-text sm:justify-end">
        Cleared when you save.
        <Button type="button" variant="ghost" size="sm" className="h-7" data-draft-path={path} aria-describedby={describe} onClick={() => draft.forget(path)}>
          Keep it
        </Button>
      </span>
    );
  }
  if (typing) {
    const text = edit?.kind === "secret" ? (edit.text ?? "") : "";
    return (
      <span className="flex w-full items-center gap-1.5">
        <Input
          id={controlId}
          type="password"
          data-draft-path={path}
          aria-label={set ? `New ${label}` : label}
          aria-describedby={describe}
          aria-invalid={invalid ? true : undefined}
          className={cn("h-8 w-full text-xs", invalid && INVALID_BORDER)}
          autoComplete="new-password"
          placeholder={set ? "Paste the new value" : "Paste the value"}
          value={text}
          autoFocus={replacing && !edit}
          onFocus={() => {
            inputFocused.current = true;
          }}
          onBlur={(event) => {
            if (event.relatedTarget) inputFocused.current = false;
          }}
          onChange={(event) => {
            const typed = event.target.value;
            onReplacing(typed === "");
            if (typed === "") draft.forget(path);
            else draft.set(path, { kind: "secret", text: typed });
          }}
          onKeyDown={saveOnEnter(draft)}
        />
        {conflicted ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 shrink-0"
            aria-label={set ? `Keep the saved ${label}` : `Don't set ${named}`}
            onClick={() => {
              onReplacing(false);
              draft.forget(path);
              focusAfterRender(path);
            }}
          >
            {set ? "Keep the saved one" : "Cancel"}
          </Button>
        )}
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5 sm:justify-end">
      <Button ref={button} id={controlId} type="button" variant="outline" size="sm" className="h-7" data-draft-path={path} aria-label={`${set ? "Replace" : "Set"} ${named}`} aria-describedby={describe} onClick={() => onReplacing(true)}>
        {set ? "Replace" : "Set"}
      </Button>
      {set && clearable ? (
        <Button type="button" variant="ghost" size="sm" className="h-7" aria-label={`Clear ${named}`} onClick={() => draft.set(path, { kind: "removed" })}>
          Clear
        </Button>
      ) : null}
    </span>
  );
}
