import { useId, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { plain, type Path } from "./settings-paths.ts";
import { ChangedChip, ConflictNote, focusAfterRender, saveOnEnter, type Draft } from "./settings-saving.tsx";

export function unplacedProblems(draft: Draft, placed: readonly Path[]): string[] {
  return draft.entry.problems.filter((problem) => !placed.includes(problem.path)).map((problem) => problem.message);
}

export function describedBy(...ids: readonly (string | null | false | undefined)[]): string | undefined {
  const joined = ids.filter(Boolean).join(" ");
  return joined || undefined;
}

export function DraftRow({ draft, path, id, label, description, unit, children }: { draft: Draft; path: Path; id: string; label: string; description: ReactNode; unit?: string; children: ReactNode }) {
  const conflict = draft.conflict(path);
  const problem = draft.problem(path);
  return (
    <div className="px-4 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-5">
        <div className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <label htmlFor={id} className="text-sm text-foreground">
              {label}
            </label>
            <ChangedChip show={draft.changed(path) && !conflict} />
          </span>
          <p id={`${id}-help`} className="mt-0.5 text-xs leading-snug text-subtle-foreground">
            {description}
          </p>
          {problem ? (
            <p id={`${id}-problem`} role="alert" className="mt-0.5 text-xs text-destructive-text">
              {problem}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          {children}
          {unit}
        </div>
      </div>
      {conflict ? (
        <ConflictNote
          id={`${id}-conflict`}
          conflict={conflict}
          onTheirs={() => {
            draft.forget(path);
            focusAfterRender(path);
          }}
          onMine={() => {
            draft.keepMine(path);
            focusAfterRender(path);
          }}
        />
      ) : null}
    </div>
  );
}

export function DraftNumberRow({ draft, path, label, description, unit, unitWord, disabled }: { draft: Draft; path: Path; label: string; description: ReactNode; unit?: string; unitWord?: string; disabled?: boolean }) {
  const id = useId();
  const problem = draft.problem(path);
  const conflict = draft.conflict(path);
  const changed = draft.changed(path);
  return (
    <DraftRow draft={draft} path={path} id={id} label={label} description={description} unit={unit}>
      <Input
        id={id}
        data-draft-path={path}
        aria-label={unitWord ? `${label}, in ${unitWord}` : undefined}
        aria-describedby={describedBy(`${id}-help`, problem && `${id}-problem`, conflict && `${id}-conflict`)}
        aria-invalid={problem ? true : undefined}
        className={cn("h-8 w-20 text-right text-xs tabular-nums", changed && "border-warning/60")}
        inputMode="numeric"
        autoComplete="off"
        disabled={disabled}
        value={draft.text(path)}
        onChange={(event) => draft.set(path, plain(event.target.value))}
        onKeyDown={saveOnEnter(draft)}
      />
    </DraftRow>
  );
}
