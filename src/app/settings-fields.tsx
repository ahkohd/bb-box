// Controls for a backend's fields, from the driver's descriptors: text,
// numbers, switches, choices, and secrets that never show their value.

import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Badge } from "./common.tsx";
import type { FieldValue } from "../backends/types.ts";
import type { SecretState } from "../core/document.ts";
import type { FieldView } from "../plugin/configuration.ts";
import { isSecretField, isSecretState, type FormValue } from "./config.ts";

/** BB's small badge beside a setting's label. */
/** A block of the page, titled as BB titles a plugin's settings sections, with room for one action beside the title. */
export function Section({
  title,
  description,
  action,
  plain = false,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  /** No card around the children: for an empty state, which has a dashed border of its own (the operator's note of 1 October 2026). */
  plain?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-xs text-foreground">{title}</h3>
          {description ? <p className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">{description}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {plain ? (
        <div className="space-y-2">{children}</div>
      ) : (
        <div className="rounded-lg border border-border bg-card px-4 py-3.5">
          <div className="divide-y divide-border">{children}</div>
        </div>
      )}
    </section>
  );
}

export function Chip({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "warn" }) {
  return <Badge tone={tone}>{children}</Badge>;
}

export function FieldShell({ label, chips, description, problem, children, wide, htmlFor }: { label: string; chips?: ReactNode; description?: string; problem?: string | null; children: ReactNode; wide?: boolean; htmlFor?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", wide && "sm:col-span-2")}>
      <label htmlFor={htmlFor} className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-foreground">
        <span>{label}</span>
        {chips}
      </label>
      {children}
      {description ? <span className="text-2xs leading-snug text-subtle-foreground/75">{description}</span> : null}
      {problem ? (
        <span role="alert" className="text-2xs leading-snug text-destructive-text">
          {problem}
        </span>
      ) : null}
    </div>
  );
}

/** A secret: write-only. It says whether one is set, and takes a new value or clears it. */
function SecretControl({ id, field, value, onChange }: { id: string; field: FieldView; value: FormValue; onChange: (value: FormValue) => void }) {
  const [replacing, setReplacing] = useState(false);
  const set = isSecretState(value) ? value.set : false;
  if (typeof value === "string" || (!set && value !== null) || replacing) {
    return (
      <div className="flex items-center gap-1.5">
        <Input
          id={id}
          type="password"
          className="h-8 text-xs"
          autoComplete="new-password"
          value={typeof value === "string" ? value : ""}
          placeholder={set || replacing ? "Paste the new value" : "Paste the value"}
          onChange={(event) => onChange(event.target.value)}
        />
        {replacing || typeof value === "string" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8"
            onClick={() => {
              setReplacing(false);
              onChange({ set });
            }}
          >
            Keep
          </Button>
        ) : null}
      </div>
    );
  }
  if (value === null) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-warning-text">
        <span>Will be cleared when you save.</span>
        <Button type="button" variant="ghost" size="sm" className="h-8" onClick={() => onChange({ set: true })}>
          Keep it
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <Button type="button" variant="outline" size="sm" className="h-8" onClick={() => setReplacing(true)}>
        Replace
      </Button>
      <Button type="button" variant="ghost" size="sm" className="h-8" onClick={() => onChange(null)}>
        Clear
      </Button>
    </div>
  );
}

/**
 * A field's control. `inherited` is what the field takes, while empty, from
 * the backend its driver inherits from: shown as a chip, and for text as the
 * placeholder.
 */
export function FieldControl({
  field,
  value,
  onChange,
  problem,
  inherited,
  from,
}: {
  field: FieldView;
  value: FormValue;
  onChange: (value: FormValue) => void;
  problem: string | null;
  inherited?: FieldValue | SecretState;
  /** The lending backend's name, when the driver's label alone does not say which. */
  from?: string;
}) {
  const id = useId();
  const chip = inherited !== undefined && field.inherits ? <Chip>from {from ?? field.inherits.label}</Chip> : null;
  const shown = inherited !== undefined && !isSecretState(inherited) ? inherited : field.default;
  const placeholder = shown !== undefined && shown !== "" ? String(shown) : undefined;
  if (isSecretField(field)) {
    const set = isSecretState(value) ? value.set : typeof value === "string" ? true : false;
    return (
      <FieldShell
        label={field.label}
        htmlFor={id}
        chips={
          <>
            <Chip>secret</Chip>
            {chip ?? <Chip tone={set ? "muted" : "warn"}>{set ? "set" : "not set"}</Chip>}
          </>
        }
        description={field.description}
        problem={problem}
      >
        <SecretControl id={id} field={field} value={value} onChange={onChange} />
      </FieldShell>
    );
  }
  if (field.type === "boolean") {
    return (
      <FieldShell label={field.label} htmlFor={id} description={field.description} problem={problem}>
        <Switch id={id} aria-label={field.label} checked={value === true} onCheckedChange={onChange} />
      </FieldShell>
    );
  }
  if (field.type === "select") {
    return (
      <FieldShell label={field.label} htmlFor={id} description={field.description} problem={problem}>
        <Select value={typeof value === "string" && value ? value : (placeholder ?? "")} onValueChange={onChange}>
          <SelectTrigger id={id} className="h-8 text-xs" aria-label={field.label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {field.options.map((option) => (
              <SelectItem key={option} value={option} className="text-xs">
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldShell>
    );
  }
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  if (field.type === "string" && field.experimental_multiline) {
    return (
      <FieldShell label={field.label} htmlFor={id} chips={chip} description={field.description} problem={problem} wide>
        <Textarea id={id} className="min-h-16 font-mono text-xs" rows={3} value={text} placeholder={placeholder} aria-invalid={problem ? true : undefined} onChange={(event) => onChange(event.target.value)} />
      </FieldShell>
    );
  }
  return (
    <FieldShell label={field.label} htmlFor={id} chips={chip} description={field.description} problem={problem}>
      <Input id={id} className="h-8 text-xs" inputMode={field.type === "number" ? "numeric" : undefined} value={text} placeholder={placeholder} aria-invalid={problem ? true : undefined} onChange={(event) => onChange(event.target.value)} />
    </FieldShell>
  );
}

/** A heading inside a form, in BB's section style, with an optional fold. */
export function FormHeading({ children, open, onToggle }: { children: ReactNode; open?: boolean; onToggle?: () => void }) {
  if (onToggle) {
    return (
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5" aria-hidden />
        {children}
      </button>
    );
  }
  return <p className="text-xs text-muted-foreground">{children}</p>;
}
