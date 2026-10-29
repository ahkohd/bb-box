// The Backends section of the settings page: a row per backend with its
// switch and state, and its setup area with the driver's fields, hosts, a
// check against the draft, and the doctor's last report.

import { experimental_Icon as Icon, UrlLink } from "@get-bb/plugin-sdk/app";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { DoctorCheck, DoctorReport, FieldValue } from "../backends/types.ts";
import type { BackendConfig, HostConfig, Problem } from "../core/document.ts";
import type { BackendState, DriverView, FieldView } from "../plugin/configuration.ts";
import { Meta, relativeTime, StatusDot, type Tone } from "./common.tsx";
import { draftFields, formValue, groupFields, inheritedValues, problemAt, problemsLeft, type DraftBackend, type FormValue } from "./config.ts";
import { Chip, FieldControl, FieldShell, FormHeading } from "./settings-fields.tsx";

/** Where the setup guides and scripts are read, as pages. */
export const REPOSITORY_URL = "https://github.com/moonstead/bb-box/blob/main";

const CHECK_ICON: Record<DoctorCheck["status"], { icon: string; className: string }> = {
  ok: { icon: "CircleCheck", className: "text-success" },
  warn: { icon: "AlertTriangle", className: "text-warning" },
  fail: { icon: "X", className: "text-destructive" },
  skipped: { icon: "Minus", className: "text-subtle-foreground" },
};

export function Report({ report }: { report: DoctorReport }) {
  return (
    <ul className="space-y-1.5">
      {report.checks.map((check) => {
        const { icon, className } = CHECK_ICON[check.status];
        return (
          <li key={check.id} className="grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-2 text-xs leading-snug">
            <Icon name={icon} className={cn("mt-0.5 size-4", className)} aria-label={check.status} />
            <div className="min-w-0">
              <span className={cn(check.status === "skipped" ? "text-muted-foreground" : "text-foreground")}>{check.name}</span> <span className="text-muted-foreground">{check.detail}</span>
              {check.fix && check.status !== "ok" ? <div className="text-muted-foreground">Fix: {check.fix}</div> : null}
            </div>
          </li>
        );
      })}
      {report.notes.map((note) => (
        <li key={note} className="grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-2 text-xs leading-snug">
          <Icon name="Info" className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
          <pre className="min-w-0 whitespace-pre-wrap break-all rounded-md bg-surface-recessed px-2 py-1 font-mono text-2xs text-foreground">{note}</pre>
        </li>
      ))}
    </ul>
  );
}

/** A backend as the page sees it: the driver, the document's entry when it has one, and its live state. */
export interface BackendRowModel {
  readonly driver: DriverView;
  readonly config: BackendConfig | null;
  /** The backend of the type the driver inherits empty fields from, if the configuration has one. */
  readonly source?: BackendConfig | null;
  /** How the page names that backend in its "from" chips. */
  readonly sourceName?: string | null;
  readonly state: BackendState | null;
  /** Problems with the stored document under this backend. */
  readonly problems: readonly Problem[];
}

export function backendId(model: BackendRowModel): string {
  return model.config?.id ?? model.driver.type;
}

function stateOf(model: BackendRowModel): { tone: Tone; words: string; items: ReactNode[] } {
  const { driver, config, state } = model;
  if (!config) return { tone: "off", words: "Not set up", items: [driver.description] };
  if (!config.enabled) return { tone: "off", words: "Off", items: [driver.description] };
  if (state?.state === "misconfigured" || (state === null && model.problems.length)) {
    const first = state?.problems[0]?.message ?? model.problems[0]?.message ?? null;
    return { tone: "warn", words: "Needs setting up", items: [first] };
  }
  const report = state?.doctor;
  const attention = report ? !report.report.ok : false;
  const kinds = state?.kinds.length ?? 0;
  return {
    tone: attention ? "warn" : "ok",
    words: attention ? "Needs attention" : "Ready",
    items: [report?.report.summary, kinds ? `${kinds} ${kinds === 1 ? "kind" : "kinds"} on offer` : "no kind on offer", report ? `checked ${relativeTime(report.at, Date.now())}` : null],
  };
}

/**
 * The name in a backend's ID, as a second backend of a type has ("microsandbox:mac-mini"), for a chip beside its label;
 * null when it has none, or its label already says it ("microsandbox on mac-mini").
 */
export function backendName(id: string, label: string): string | null {
  const named = id.includes(":") ? id.slice(id.indexOf(":") + 1) : null;
  return named && !label.toLowerCase().includes(named.toLowerCase()) ? named : null;
}

export function BackendRow({
  model,
  open,
  onToggle,
  onSwitch,
  switching,
  children,
}: {
  model: BackendRowModel;
  open: boolean;
  onToggle: () => void;
  onSwitch: (on: boolean) => void;
  switching: boolean;
  children?: ReactNode;
}) {
  const { driver, config, state } = model;
  const { tone, words, items } = stateOf(model);
  const label = state?.label ?? config?.label ?? driver.label;
  const name = config ? backendName(config.id, label) : null;
  const boxes = state?.boxes ?? 0;
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-medium text-foreground">
            <span className="truncate">{label}</span>
            {name ? <Chip>{name}</Chip> : null}
            {boxes ? <Chip>{boxes === 1 ? "1 box" : `${boxes} boxes`}</Chip> : null}
          </p>
          <div className="mt-0.5 flex min-w-0 items-start gap-1.5 text-xs leading-snug text-muted-foreground">
            <StatusDot tone={tone} />
            <Meta
              items={[
                <span key="state" className={cn(tone === "warn" && "text-warning-text")}>
                  {words}
                </span>,
                ...items,
              ]}
            />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2" aria-expanded={open} aria-label={`Set up ${label}`} onClick={onToggle}>
            Set up
            <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5" aria-hidden />
          </Button>
          <Switch aria-label={`${label} on`} checked={config?.enabled ?? false} disabled={switching} onCheckedChange={onSwitch} />
        </div>
      </div>
      {open ? children : null}
    </div>
  );
}

interface HostDraft {
  readonly name: string;
  readonly enabled: boolean;
  readonly fields: Record<string, FormValue>;
}

export interface BackendDraft {
  readonly label: string;
  readonly fields: Record<string, FormValue>;
  readonly hosts: HostDraft[];
}

function draftOf(model: BackendRowModel): BackendDraft {
  const fields: Record<string, FormValue> = {};
  for (const field of model.driver.fields) fields[field.key] = formValue(model.config?.fields ?? {}, field);
  return {
    label: model.config?.label ?? "",
    fields,
    hosts: (model.config?.hosts ?? []).map((host) => {
      const values: Record<string, FormValue> = {};
      for (const field of model.driver.hostFields) values[field.key] = formValue(host.fields, field);
      return { name: host.name, enabled: host.enabled, fields: values };
    }),
  };
}

/** The backend's entry for the draft document, from the form. */
export function toBackendConfig(model: BackendRowModel, draft: BackendDraft): DraftBackend {
  const hostFields = model.driver.hostFields;
  const hosts: HostConfig[] | undefined = hostFields.length
    ? draft.hosts.map((host) => ({ name: host.name.trim(), enabled: host.enabled, fields: draftFields(host.fields, hostFields) as Record<string, FieldValue> }))
    : undefined;
  return {
    id: backendId(model),
    type: model.driver.type,
    ...(draft.label.trim() ? { label: draft.label.trim() } : {}),
    enabled: model.config?.enabled ?? false,
    fields: draftFields(draft.fields, model.driver.fields, model.config?.fields),
    ...(model.config?.warm ? { warm: model.config.warm } : {}),
    ...(hosts ? { hosts } : {}),
  };
}

export function BackendForm({
  model,
  onSave,
  onCheck,
  onClose,
}: {
  model: BackendRowModel;
  /** Saves the form's entry; resolves with whether it was saved and the problems left. */
  onSave: (config: DraftBackend) => Promise<{ readonly saved: boolean; readonly problems: readonly Problem[] }>;
  /** Checks the form's entry without saving, with the backend's doctor. */
  onCheck: (config: DraftBackend) => Promise<{ problems: readonly Problem[]; doctor: DoctorReport | null }>;
  onClose: () => void;
}) {
  const { driver } = model;
  const id = backendId(model);
  const path = `backends.${id}`;
  const [draft, setDraft] = useState<BackendDraft>(() => draftOf(model));
  const [problems, setProblems] = useState<readonly Problem[]>(model.problems);
  const [doctor, setDoctor] = useState<{ report: DoctorReport; at: number; fresh: boolean } | null>(model.state?.doctor ? { ...model.state.doctor, fresh: false } : null);
  const [busy, setBusy] = useState<"save" | "on" | "check" | null>(null);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<string | null>(null);

  const setField = (key: string, value: FormValue) => setDraft((current) => ({ ...current, fields: { ...current.fields, [key]: value } }));
  const setHost = (index: number, patch: Partial<HostDraft>) => setDraft((current) => ({ ...current, hosts: current.hosts.map((host, n) => (n === index ? { ...host, ...patch } : host)) }));
  const groups = groupFields(driver.fields);
  const inherited = inheritedValues(driver.fields, draft.fields, model.source ?? null);
  const shown = [...driver.fields.map((field) => `${path}.${field.key}`), ...draft.hosts.flatMap((_, n) => [`${path}.hosts.${n}.name`, ...driver.hostFields.map((field) => `${path}.hosts.${n}.${field.key}`)])];
  const rest = problemsLeft(problems, path, shown);

  const save = async () => {
    setBusy("save");
    setNotice(null);
    try {
      const { saved, problems: left } = await onSave(toBackendConfig(model, draft));
      setProblems(left);
      if (saved && !left.length) onClose();
      else if (saved) setNotice("Saved. It stays off until these are fixed.");
    } finally {
      setBusy(null);
    }
  };
  /** Saves the backend on in one go. The server refuses an on backend with problems, so a refusal saves nothing. */
  const saveOn = async () => {
    setBusy("on");
    setNotice(null);
    try {
      const { saved, problems: left } = await onSave({ ...toBackendConfig(model, draft), enabled: true });
      setProblems(left);
      if (saved && !left.length) onClose();
      else if (saved) setNotice("Saved. It stays off until these are fixed.");
      else if (left.length) setNotice("Not saved: it cannot be on with these. Save keeps it off while you fix them.");
    } finally {
      setBusy(null);
    }
  };
  const check = async () => {
    setBusy("check");
    setNotice(null);
    try {
      const result = await onCheck(toBackendConfig(model, draft));
      setProblems(result.problems);
      if (result.doctor) setDoctor({ report: result.doctor, at: Date.now(), fresh: true });
      else if (result.problems.length) setNotice("Fix the fields first; the check needs them.");
    } finally {
      setBusy(null);
    }
  };

  const guide = driver.setup.guide ? `${REPOSITORY_URL}/${driver.setup.guide}` : null;
  const off = !(model.config?.enabled ?? false);
  return (
    <form
      className="mt-3 space-y-4 border-t border-border pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        // Enter does what the main button does: Save and turn on while the backend is off, Save otherwise (#193).
        void (off ? saveOn() : save());
      }}
    >
      {guide ? (
        <p className="text-xs leading-snug text-muted-foreground">
          Follow the{" "}
          <UrlLink href={guide} className="text-foreground underline underline-offset-2">
            {driver.label} setup guide
          </UrlLink>
          ; it gives the values for this form.
          {driver.setup.scripts.length ? (
            <>
              {driver.setup.scripts.length === 1 ? " Its script: " : " Its scripts: "}
              {driver.setup.scripts.map((script, index) => (
                <span key={script}>
                  {index > 0 ? (index === driver.setup.scripts.length - 1 ? " and " : ", ") : ""}
                  <UrlLink href={`${REPOSITORY_URL}/${script}`} className="text-foreground underline underline-offset-2">
                    {script.split("/").pop()}
                  </UrlLink>
                </span>
              ))}
              .
            </>
          ) : null}
        </p>
      ) : null}
      {groups.map((group) => {
        const folded = group.id === "advanced" || group.id === "ios-hosts";
        const open = unfolded.has(group.id);
        const toggle = () => setUnfolded((current) => (current.has(group.id) ? new Set([...current].filter((id) => id !== group.id)) : new Set([...current, group.id])));
        return (
          <div key={group.id} className="space-y-2">
            <FormHeading open={open} onToggle={folded ? toggle : undefined}>
              {group.title}
            </FormHeading>
            {!folded || open ? (
              <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                {group.fields.map((field) => (
                  <FieldControl
                    key={field.key}
                    field={field}
                    value={field.key in draft.fields ? draft.fields[field.key]! : ""}
                    onChange={(value) => setField(field.key, value)}
                    problem={problemAt(problems, `${path}.${field.key}`)}
                    inherited={inherited[field.key]}
                    from={model.sourceName ?? undefined}
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
      {driver.hostFields.length ? (
        <div className="space-y-2">
          <FormHeading>Hosts</FormHeading>
          {draft.hosts.length ? null : <p className="text-xs text-muted-foreground">No host yet. A new box goes to the first host in the list with room.</p>}
          {draft.hosts.map((host, n) => (
            <div key={n} className="space-y-3 rounded-md border border-border bg-surface-recessed/70 p-3">
              <div className="flex items-end gap-3">
                <FieldShell label="Name" problem={problemAt(problems, `${path}.hosts.${n}.name`)} htmlFor={`${id}-host-${n}`}>
                  <Input id={`${id}-host-${n}`} className="h-8 text-xs" value={host.name} placeholder="for example studio" onChange={(event) => setHost(n, { name: event.target.value })} />
                </FieldShell>
                <label className="flex items-center gap-2 pb-2 text-xs text-foreground">
                  <Switch aria-label={`Host ${host.name || n + 1} on`} checked={host.enabled} onCheckedChange={(enabled) => setHost(n, { enabled })} />
                  On
                </label>
                <Button type="button" variant="ghost" size="sm" className="ml-auto h-8 text-muted-foreground" onClick={() => setDraft((current) => ({ ...current, hosts: current.hosts.filter((_, index) => index !== n) }))}>
                  <Icon name="Trash2" aria-hidden />
                  Remove
                </Button>
              </div>
              <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                {driver.hostFields.map((field) => (
                  <FieldControl
                    key={field.key}
                    field={field}
                    value={field.key in host.fields ? host.fields[field.key]! : ""}
                    onChange={(value) => setHost(n, { fields: { ...host.fields, [field.key]: value } })}
                    problem={problemAt(problems, `${path}.hosts.${n}.${field.key}`)}
                  />
                ))}
              </div>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => setDraft((current) => ({ ...current, hosts: [...current.hosts, { name: "", enabled: true, fields: {} }] }))}>
            <Icon name="Plus" aria-hidden />
            Add host
          </Button>
        </div>
      ) : null}
      {rest.length ? (
        <ul role="alert" className="space-y-0.5 text-xs leading-snug text-destructive-text">
          {rest.map((problem) => (
            <li key={`${problem.path} ${problem.message}`}>{problem.message}</li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {off ? (
          <Button type="submit" size="sm" className="h-7" disabled={busy !== null}>
            {busy === "on" ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
            Save and turn on
          </Button>
        ) : null}
        <Button type={off ? "button" : "submit"} variant={off ? "outline" : "default"} size="sm" className="h-7" disabled={busy !== null} onClick={off ? () => void save() : undefined}>
          {busy === "save" ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
          Save
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-7" disabled={busy !== null} onClick={() => void check()}>
          {busy === "check" ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
          {busy === "check" ? "Checking…" : "Check"}
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7" disabled={busy !== null} onClick={onClose}>
          Cancel
        </Button>
        {notice ? <span className="text-xs text-muted-foreground">{notice}</span> : null}
      </div>
      {doctor ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {doctor.report.summary}
            {" · "}
            {doctor.fresh ? "checked just now, against the form" : `checked ${relativeTime(doctor.at, Date.now())}`}
          </p>
          <Report report={doctor.report} />
        </div>
      ) : null}
    </form>
  );
}
