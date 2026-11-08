import type { ReactNode } from "react";

export function FieldProblem({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="text-xs leading-snug text-destructive-text">
      {children}
    </p>
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
      {description ? <span className="text-2xs leading-snug text-subtle-foreground/75">{description}</span> : null}
      {problem ? <FieldProblem id={problemId}>{problem}</FieldProblem> : null}
    </div>
  );
}
