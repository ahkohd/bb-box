import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function FieldProblem({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="text-xs leading-snug text-destructive-text">
      {children}
    </p>
  );
}

export function SideLabelField({
  label,
  htmlFor,
  chips,
  changed,
  help,
  problem,
  problemId,
  conflict,
  path,
  className,
  controlClassName,
  stacked = false,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  chips?: ReactNode;
  changed?: ReactNode;
  help?: ReactNode;
  problem?: ReactNode;
  problemId?: string;
  conflict?: ReactNode;
  path?: string;
  className?: string;
  controlClassName?: string;
  stacked?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn("px-4 py-3", className)} data-setting-row={path}>
      <div className={cn("flex flex-col gap-2 sm:items-start sm:justify-between", !stacked && "sm:flex-row sm:gap-5")}>
        <div className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <label htmlFor={htmlFor} className="text-sm text-foreground">
              {label}
            </label>
            {chips}
            {changed}
          </span>
          {typeof help === "string" ? <p className="mt-0.5 text-xs leading-snug text-subtle-foreground">{help}</p> : help}
        </div>
        <div className={cn("flex min-w-0 flex-col gap-1 sm:shrink-0", controlClassName)}>
          {children}
          {problem ? <FieldProblem id={problemId}>{problem}</FieldProblem> : null}
        </div>
      </div>
      {conflict}
    </div>
  );
}

export function FieldShell({
  label,
  htmlFor,
  chips,
  description,
  problem,
  problemId,
  wide,
  path,
  className,
  children,
}: {
  label?: ReactNode;
  htmlFor?: string;
  chips?: ReactNode;
  description?: ReactNode;
  problem?: ReactNode;
  problemId?: string;
  wide?: boolean;
  path?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className ?? `flex min-w-0 flex-col gap-1${wide ? " sm:col-span-2" : ""}`} data-setting-row={path}>
      {label ? (
        <label htmlFor={htmlFor} className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-foreground">
          <span>{label}</span>
          {chips}
        </label>
      ) : null}
      {children}
      {problem ? <FieldProblem id={problemId}>{problem}</FieldProblem> : null}
      {description ? <span className="text-2xs leading-snug text-subtle-foreground/75">{description}</span> : null}
    </div>
  );
}
