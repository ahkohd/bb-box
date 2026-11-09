import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { Fragment, useEffect, useId, useState, type ReactNode } from "react";
import { BoxDialog, DialogButton } from "./box-dialog.tsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { helpParts, type FieldValue } from "../backends/types.ts";
import type { BackendConfig, HostConfig, SecretState } from "../core/document.ts";
import type { ConfigState, DriverView, FieldView } from "../plugin/configuration.ts";
import { Badge } from "./common.tsx";
import { GROUPS, inheritSource, inheritedValues, isSecretField, isSecretState, sourceName, type FieldGroup, type FormValue } from "./config.ts";
import { switchKey, useSettings } from "./settings-context.tsx";
import { describedBy, SecretControl } from "./settings-draft-fields.tsx";
import { backendPart, operationId } from "./settings-drafts.ts";
import { Card, FOCUS_RING, Group, ProviderGlyph, RowControl, RowNote, Rows, SavedTick } from "./settings-parts.tsx";
import { backendFieldPath, hostEnabledPath, hostFieldPath, hostNoun, hostPath, newHostPath, plain, storedProblemPath, type Path, type PlainValue } from "./settings-paths.ts";
import { ChangedChip, ConflictNote, focusAfterRender, saveOnEnter, type Draft } from "./settings-saving.tsx";
import { SideLabelField } from "./field-shell.tsx";
import { INVALID_BORDER } from "./size-field.ts";
import { plural } from "./settings-status.ts";
import { PRODUCT } from "./product.ts";

export { backendPart };

export const FOLDED_GROUPS: ReadonlySet<FieldGroup> = new Set(["ios-hosts", "advanced"]);

export const GROUP_WORDS: Readonly<Partial<Record<FieldGroup, string>>> = {
  credentials: "Kept secret: BB Box never shows them again, only whether each is set.",
  boxes: "What new boxes start from, and what they may do.",
  gpus: "Limits and defaults for the boxes on its cards. No setting here changes a box's own GPU: that is chosen when a box is made, and by Resize.",
  "ios-hosts": "iOS boxes as macOS users on a shared Mac or VM, ready in seconds.",
};

export interface Effective {
  readonly value: string;
  readonly from: string;
}

export interface BackendForm {
  readonly draft: Draft;
  readonly state: ConfigState;
  readonly config: BackendConfig;
  readonly driver: DriverView;
}

function storedProblems(state: ConfigState, id: string): ReadonlyMap<Path, string> {
  const problems = new Map<Path, string>();
  for (const problem of state.problems) {
    if (problem.path !== `backends.${id}` && !problem.path.startsWith(`backends.${id}.`)) continue;
    const path = storedProblemPath(state, problem.path);
    if (!problems.has(path)) problems.set(path, problem.message);
  }
  return problems;
}

function problemFor(form: BackendForm, path: Path): string | null {
  return form.draft.problem(path) ?? (form.draft.edit(path) ? null : (storedProblems(form.state, form.config.id).get(path) ?? null));
}

export function hasFormProblem(form: BackendForm, path: Path): boolean {
  return form.draft.problem(path) !== null || storedProblems(form.state, form.config.id).has(path);
}

function formValues(form: BackendForm): Record<string, FormValue> {
  const values: Record<string, FormValue> = {};
  for (const field of form.driver.fields) {
    const path = backendFieldPath(form.config.id, field.key);
    const edit = form.draft.edit(path);
    if (isSecretField(field)) {
      const stored = form.config.fields[field.key];
      values[field.key] = edit?.kind === "secret" ? (edit.text ?? "") : edit?.kind === "removed" ? null : isSecretState(stored) ? stored : { set: false };
    } else values[field.key] = form.draft.current(path) ?? "";
  }
  return values;
}

function shownValue(value: FieldValue | SecretState): string | null {
  if (isSecretState(value)) return null;
  return String(value);
}

function replacedValue(form: BackendForm, field: FieldView): FieldValue | null {
  if (!field.replaces) return null;
  const value = form.draft.current(backendFieldPath(form.config.id, field.replaces));
  return value === null || value === "" ? null : (value as FieldValue);
}

export function effectiveOf(form: BackendForm, field: FieldView): Effective | null {
  if (field.type === "boolean") return null;
  const replaced = replacedValue(form, field);
  if (replaced !== null) return { value: String(replaced), from: `from ${field.replaces}, the field it replaces` };
  const source = inheritSource(form.state.document, form.driver.fields, form.config.id);
  const inherited = source ? inheritedValues(form.driver.fields, formValues(form), source)[field.key] : undefined;
  if (inherited !== undefined && field.inherits && source) {
    const value = shownValue(inherited);
    const name = sourceName(form.state.document, source, field.inherits.label);
    return { value: value ?? "set", from: `from ${name}` };
  }
  if (field.default !== undefined && field.default !== "") return { value: String(field.default), from: "the default" };
  return null;
}

function withUnit(value: string | number, field: FieldView): string {
  const unit = /\((GiB|MiB)\)/.exec(field.label)?.[1];
  if (unit) return `${value} ${unit}`;
  const one = Number(value) === 1;
  if (/^cores\b/i.test(field.label)) return `${value} ${one ? "core" : "cores"}`;
  if (/^slots\b/i.test(field.label)) return `${value} ${one ? "slot" : "slots"}`;
  return String(value);
}

function Help({ id, text, label }: { id: string; text: string; label: string }) {
  const [more, setMore] = useState(false);
  const { lead, more: rest } = helpParts(text);
  if (!lead) return null;
  return (
    <p id={id} className="mt-0.5 text-xs leading-snug text-subtle-foreground">
      {lead}
      {rest ? (
        <>
          {more ? <span> {rest}</span> : null}{" "}
          <button type="button" aria-expanded={more} aria-label={more ? `Less about ${label}` : `More about ${label}`} onClick={() => setMore((current) => !current)} className="cursor-pointer rounded-sm text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            {more ? "Less" : "More"}
          </button>
        </>
      ) : null}
    </p>
  );
}

function Checkbox({ id, label, checked, disabled, onChange, path }: { id?: string; label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void; path?: Path }) {
  return (
    <input
      id={id}
      type="checkbox"
      data-draft-path={path}
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
      className="size-4 shrink-0 cursor-pointer rounded-sm accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
    />
  );
}

interface RowIds {
  readonly control: string;
  readonly help: string;
  readonly problem: string;
  readonly conflict: string;
  readonly effective: string;
}

function FieldShell({ draft, path, ids, label, help, chips, problem, stacked, onTheirs, children }: { draft: Draft; path: Path; ids: RowIds; label: string; help: string; chips?: ReactNode; problem: string | null; stacked?: boolean; onTheirs?: () => void; children: ReactNode }) {
  const conflict = draft.conflict(path);
  return (
    <SideLabelField
      path={path}
      htmlFor={ids.control}
      label={label}
      chips={chips}
      changed={<ChangedChip show={draft.changed(path) && !conflict} />}
      help={<Help id={ids.help} text={help} label={label} />}
      problem={problem}
      problemId={problem ? ids.problem : undefined}
      stacked={stacked}
      controlClassName={stacked ? "w-full" : "w-full sm:w-72 sm:items-end"}
      conflict={
        conflict ? (
          <ConflictNote
            id={ids.conflict}
            conflict={conflict}
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
      {children}
    </SideLabelField>
  );
}

function useRowIds(): RowIds {
  const id = useId();
  return { control: `${id}-control`, help: `${id}-help`, problem: `${id}-problem`, conflict: `${id}-conflict`, effective: `${id}-effective` };
}

function EffectiveLine({ id, effective }: { id: string; effective: Effective | null }) {
  if (!effective) return null;
  return (
    <span id={id} className="text-2xs leading-snug text-subtle-foreground sm:text-right">
      Empty: {effective.value ? <><span className="text-muted-foreground">{effective.value}</span>, </> : null}
      {effective.from}
    </span>
  );
}

function placeholderOf(effective: Effective | null, field: FieldView): string | undefined {
  if (!effective?.value) return undefined;
  if (field.type === "number") return effective.value.split(" ")[0];
  return effective.value;
}

export function PlainFieldRow({ form, field, path, label, effective, disabled }: { form: BackendForm; field: FieldView; path: Path; label: string; effective: Effective | null; disabled?: boolean }) {
  const { draft } = form;
  const ids = useRowIds();
  const problem = problemFor(form, path);
  const conflict = draft.conflict(path);
  const current = draft.current(path);
  const changed = draft.changed(path);
  const offable = field.offWhenEmpty === true;
  const off = offable && current === "";
  const blank = current === null || current === "";
  const describe = describedBy(ids.help, problem && ids.problem, conflict && ids.conflict, blank && !off && effective && ids.effective);
  const write = (value: PlainValue) => draft.set(path, plain(value));
  if (field.type === "boolean") {
    const replaced = replacedValue(form, field);
    const checked = current === null ? (replaced !== null ? replaced === true : field.default === true) : current === true;
    return (
      <FieldShell draft={draft} path={path} ids={ids} label={label} help={field.description ?? ""} problem={problem}>
        <Checkbox id={ids.control} path={path} label={label} checked={checked} disabled={disabled} onChange={(value) => write(value)} />
      </FieldShell>
    );
  }
  const text = current === null ? "" : String(current);
  const multiline = field.type === "string" && field.experimental_multiline === true;
  const control = multiline ? (
    <Textarea
      id={ids.control}
      data-draft-path={path}
      aria-describedby={describe}
      aria-invalid={problem ? true : undefined}
      className={cn("min-h-20 font-mono text-xs", problem && INVALID_BORDER)}
      spellCheck={false}
      autoComplete="off"
      disabled={disabled}
      placeholder={placeholderOf(effective, field)}
      value={text}
      onChange={(event) => write(event.target.value === "" ? null : event.target.value)}
    />
  ) : (
    <Input
      id={ids.control}
      data-draft-path={path}
      aria-describedby={describe}
      aria-invalid={problem ? true : undefined}
      className={cn("h-8 text-xs", field.type === "number" ? "w-full text-right tabular-nums sm:w-28" : "w-full", problem && INVALID_BORDER)}
      inputMode={field.type === "number" ? "numeric" : undefined}
      autoComplete="off"
      spellCheck={false}
      disabled={disabled || off}
      placeholder={off ? "Off" : placeholderOf(effective, field)}
      value={off ? "" : text}
      onChange={(event) => write(event.target.value === "" ? null : event.target.value)}
      onKeyDown={saveOnEnter(draft)}
    />
  );
  return (
    <FieldShell draft={draft} path={path} ids={ids} label={label} help={field.description ?? ""} problem={problem} stacked={multiline}>
      {offable ? (
        <span className="flex w-full items-center gap-2">
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox label={`Offer ${label}`} checked={!off} disabled={disabled} onChange={(offer) => write(offer ? null : "")} />
            Offer
          </label>
          {control}
        </span>
      ) : (
        control
      )}
      {off ? (
        <span className="text-2xs leading-snug text-subtle-foreground sm:text-right">Off: saved empty, so its boxes are not offered.</span>
      ) : blank ? (
        <EffectiveLine id={ids.effective} effective={effective} />
      ) : null}
    </FieldShell>
  );
}

function SecretFieldRow({ form, field, path }: { form: BackendForm; field: FieldView; path: Path }) {
  const { draft, config } = form;
  const ids = useRowIds();
  const [replacing, setReplacing] = useState(false);
  const problem = problemFor(form, path);
  const conflict = draft.conflict(path);
  const edit = draft.edit(path);
  const stored = config.fields[field.key];
  const set = isSecretState(stored) && stored.set;
  const inherited = effectiveOf(form, field);
  const chips = inherited && !set && !edit ? <Badge>{inherited.from}</Badge> : <Badge tone={!set && problem ? "warn" : "muted"}>{set ? "Set" : "Not set"}</Badge>;
  return (
    <FieldShell draft={draft} path={path} ids={ids} label={field.label} help={field.description ?? ""} chips={chips} problem={problem} onTheirs={() => setReplacing(false)}>
      <SecretControl
        draft={draft}
        path={path}
        label={field.label}
        set={set}
        controlId={ids.control}
        describedBy={describedBy(ids.help, problem && ids.problem, conflict && ids.conflict)}
        invalid={problem !== null}
        conflicted={conflict !== null}
        clearable
        replacing={replacing}
        onReplacing={setReplacing}
      />
    </FieldShell>
  );
}

export function BackendFieldRow({ form, field }: { form: BackendForm; field: FieldView }) {
  const path = backendFieldPath(form.config.id, field.key);
  if (isSecretField(field)) return <SecretFieldRow form={form} field={field} path={path} />;
  return <PlainFieldRow form={form} field={field} path={path} label={field.label} effective={effectiveOf(form, field)} />;
}

function setCount(form: BackendForm, fields: readonly FieldView[]): number {
  return fields.filter((field) => {
    const path = backendFieldPath(form.config.id, field.key);
    if (isSecretField(field)) return form.draft.edit(path) !== null || (isSecretState(form.config.fields[field.key]) && (form.config.fields[field.key] as SecretState).set);
    const value = form.draft.current(path);
    return value !== null && value !== "" && !(field.type === "boolean" && field.key.endsWith("-on"));
  }).length;
}

function groupSummary(form: BackendForm, fields: readonly FieldView[]): string {
  const set = setCount(form, fields);
  const sets = set ? `${plural(set, "setting")} set here` : "All at their defaults";
  const switchField = fields.find((field) => field.type === "boolean" && field.key.endsWith("ios-hosts-on"));
  if (!switchField) return sets;
  const on = form.draft.current(backendFieldPath(form.config.id, switchField.key)) === true || (form.draft.current(backendFieldPath(form.config.id, switchField.key)) === null && switchField.default === true);
  return `${on ? "On" : "Off"} · ${sets}`;
}

export type GroupRenderer = (group: { readonly id: FieldGroup; readonly title: string; readonly fields: readonly FieldView[] }) => ReactNode | null;

export function FieldCards({ form, groups, forced, custom }: { form: BackendForm; groups: readonly { readonly id: FieldGroup; readonly fields: readonly FieldView[] }[]; forced: (path: Path) => boolean; custom?: GroupRenderer }) {
  const { nav } = useSettings();
  const holding = (focus: Path | undefined) => groups.filter((group) => group.fields.some((field) => backendFieldPath(form.config.id, field.key) === focus)).map((group) => group.id);
  const [unfolded, setUnfolded] = useState<ReadonlySet<FieldGroup>>(() => new Set(holding(nav.arrival?.focus)));
  const found = nav.arrival?.kind === "found" ? nav.arrival : null;
  useEffect(() => {
    const opened = holding(found?.focus);
    if (opened.length) setUnfolded((current) => new Set([...current, ...opened]));
  }, [found?.serial]);
  return (
    <>
      {groups.map((group) => {
        const title = GROUPS.find((each) => each.id === group.id)?.title ?? group.id;
        const own = custom?.({ id: group.id, title, fields: group.fields });
        if (own) return <Fragment key={group.id}>{own}</Fragment>;
        const folded = FOLDED_GROUPS.has(group.id);
        const held = group.fields.some((field) => forced(backendFieldPath(form.config.id, field.key)));
        const open = !folded || held || unfolded.has(group.id);
        const words = GROUP_WORDS[group.id];
        const description = folded ? `${words ? `${words} ` : ""}${groupSummary(form, group.fields)}.` : words;
        const toggle =
          folded && !held ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-muted-foreground"
              aria-expanded={open}
              aria-label={open ? `Hide ${title}` : `Show ${title}: ${plural(group.fields.length, "setting")}`}
              onClick={() => setUnfolded((current) => (current.has(group.id) ? new Set([...current].filter((each) => each !== group.id)) : new Set([...current, group.id])))}
            >
              {open ? "Hide" : `Show ${plural(group.fields.length, "setting")}`}
              <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5" aria-hidden />
            </Button>
          ) : null;
        return (
          <Group key={group.id} title={title} description={description} action={toggle}>
            {open ? (
              <Card>
                <Rows>
                  {group.fields.map((field) => (
                    <BackendFieldRow key={field.key} form={form} field={field} />
                  ))}
                </Rows>
              </Card>
            ) : null}
          </Group>
        );
      })}
    </>
  );
}

function newHostMark(): string {
  return operationId().slice(-8);
}

interface HostRow {
  readonly path: Path;
  readonly name: string;
  readonly saved: HostConfig | null;
  readonly enabled: boolean;
}

export function hostRows(form: BackendForm): HostRow[] {
  const id = form.config.id;
  const saved = (form.config.hosts ?? []).map((host) => ({ path: hostPath(id, host.name), name: host.name, saved: host, enabled: host.enabled }));
  const added = [...form.draft.entry.edits].flatMap(([path, edit]) => (edit.value.kind === "new-host" && path.startsWith(`${hostPath(id, "")}`) ? [{ path, name: edit.value.name, saved: null, enabled: edit.value.enabled }] : []));
  return [...saved, ...added];
}

function hostEstimate(form: BackendForm, host: HostRow, field: FieldView): Effective {
  const noun = hostNoun(form.config.type);
  const own = form.draft.current(backendFieldPath(form.config.id, field.key));
  const backendField = form.driver.fields.find((each) => each.key === field.key);
  if (backendField && own !== null && own !== "") return { value: withUnit(own as string | number, field), from: `${form.driver.label}'s setting` };
  const name = host.saved ? host.name : host.name.trim() || `the new ${noun}`;
  const estimate = form.state.backends.find((each) => each.id === form.config.id)?.hostEstimates?.[host.saved ? host.name : ""]?.[field.key];
  if (estimate !== undefined) return { value: withUnit(estimate, field), from: `${PRODUCT}'s estimate for ${name}` };
  return { value: "", from: `${PRODUCT}'s estimate for ${name}, once it has read the ${noun}` };
}

function HostDetails({ form, host, noun }: { form: BackendForm; host: HostRow; noun: string }) {
  const { draft } = form;
  const name = host.saved ? host.name : host.name.trim() || `the new ${noun}`;
  const nameId = useId();
  const nameProblem = draft.problem(`${host.path}/name`);
  const sending = draft.beingSaved(host.path) && draft.busy;
  const main = form.driver.hostFields.filter((field) => field.group !== "ios-hosts");
  const sizes = form.driver.hostFields.filter((field) => field.group === "ios-hosts");
  return (
    <div className="border-t border-border bg-surface-raised">
      <Rows>
        {host.saved ? null : (
          <div className="px-4 py-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-5">
              <div className="min-w-0 flex-1">
                <label htmlFor={nameId} className="text-sm text-foreground">
                  Name of the new {noun}
                </label>
                <p id={`${nameId}-help`} className="mt-0.5 text-xs leading-snug text-subtle-foreground">
                  Lower-case letters, digits and "-". It stays once the {noun} has boxes.
                </p>
                {nameProblem ? (
                  <p id={`${nameId}-problem`} role="alert" className="mt-0.5 text-xs text-destructive-text">
                    {nameProblem}
                  </p>
                ) : null}
              </div>
              <Input
                id={nameId}
                data-draft-path={`${host.path}/name`}
                aria-describedby={describedBy(`${nameId}-help`, nameProblem && `${nameId}-problem`)}
                aria-invalid={nameProblem ? true : undefined}
                className="h-8 w-full text-xs sm:w-72"
                placeholder={`for example ${noun === "Mac" ? "mac-2" : "host-2"}`}
                autoComplete="off"
                spellCheck={false}
                disabled={sending}
                value={host.name}
                onChange={(event) => draft.set(host.path, { kind: "new-host", name: event.target.value, enabled: host.enabled })}
                onKeyDown={saveOnEnter(draft)}
              />
            </div>
          </div>
        )}
        {host.saved ? null : (
          <div className="flex items-start justify-between gap-5 px-4 py-3">
            <div className="min-w-0 flex-1">
              <label htmlFor={`${nameId}-takes`} className="text-sm text-foreground">
                Takes boxes
              </label>
              <p className="mt-0.5 text-xs leading-snug text-subtle-foreground">Unticked, the {noun} is added but takes no new box until its switch is turned on.</p>
            </div>
            <Checkbox id={`${nameId}-takes`} label={`${name}: takes boxes`} checked={host.enabled} disabled={sending} onChange={(enabled) => draft.set(host.path, { kind: "new-host", name: host.name, enabled })} />
          </div>
        )}
        {main.map((field) => (
          <PlainFieldRow key={field.key} form={form} field={field} path={hostFieldPath(host.path, field.key)} label={`${field.label} on ${name}`} effective={null} />
        ))}
        {sizes.length ? (
          <div className="px-4 pb-1 pt-3">
            <p className="text-xs font-normal text-foreground">Its own shared iOS host size</p>
            <p className="mt-0.5 text-xs leading-snug text-subtle-foreground">
              Empty takes {form.driver.label}'s setting, or {PRODUCT}'s estimate for this {noun}. A change reaches the next shared host made on it; one running now keeps its size.
            </p>
          </div>
        ) : null}
        {sizes.map((field) => (
          <PlainFieldRow key={field.key} form={form} field={field} path={hostFieldPath(host.path, field.key)} label={`${field.label} on ${name}`} effective={hostEstimate(form, host, field)} />
        ))}
      </Rows>
    </div>
  );
}

export function HostsSection({ form, forced, onRemove, settingUp = false }: { form: BackendForm; forced: (path: Path) => boolean; onRemove: (name: string) => void; settingUp?: boolean }) {
  const { draft, config, driver } = form;
  const { state, nav, instant, writes } = useSettings();
  const hostOf = (focus: Path | undefined) => (form.config.hosts ?? []).map((host) => hostPath(config.id, host.name)).filter((path) => focus?.startsWith(`${path}/fields/`));
  const [open, setOpen] = useState<ReadonlySet<Path>>(() => new Set(hostOf(nav.arrival?.focus)));
  const found = nav.arrival?.kind === "found" ? nav.arrival : null;
  useEffect(() => {
    const opened = hostOf(found?.focus);
    if (opened.length) setOpen((current) => new Set([...current, ...opened]));
  }, [found?.serial]);
  const noun = hostNoun(config.type);
  const nouns = noun === "Mac" ? "Macs" : "Hosts";
  if (!driver.hostFields.length) return null;
  const rows = hostRows(form);
  const listProblem = problemFor(form, `backends/${config.id}/hosts`);
  const toggle = (path: Path) => setOpen((current) => (current.has(path) ? new Set([...current].filter((each) => each !== path)) : new Set([...current, path])));
  const add = () => {
    const path = newHostPath(config.id, newHostMark());
    draft.set(path, { kind: "new-host", name: "", enabled: true });
    setOpen((current) => new Set([...current, path]));
    focusAfterRender(`${path}/name`);
  };
  return (
    <Group
      title={nouns}
      description={settingUp ? `A new box goes to the first ${noun} in the list with room. Each ${noun} is added with the backend when you save.` : `A new box goes to the first ${noun} in the list with room. A ${noun}'s switch acts at once; its fields wait for Save.`}
      action={
        <Button type="button" variant="outline" size="sm" className="h-7" onClick={add}>
          <Icon name="Plus" aria-hidden />
          Add {noun}
        </Button>
      }
    >
      {listProblem ? (
        <p role="alert" data-draft-path={`backends/${config.id}/hosts`} tabIndex={-1} className="text-xs text-destructive-text outline-none">
          {listProblem}
        </p>
      ) : null}
      {rows.length ? (
        <Card>
          <Rows>
            {rows.map((host) => {
              const removed = draft.edit(host.path)?.kind === "removed";
              const name = host.saved ? host.name : host.name.trim() || `New ${noun}`;
              const inside = (path: Path) => path === host.path || path.startsWith(`${host.path}/`);
              const held = !host.saved || [...draft.entry.edits.keys()].some((path) => inside(path) && path !== host.path) || draft.entry.problems.some((problem) => inside(problem.path)) || [...draft.entry.edits.keys()].some((path) => inside(path) && forced(path));
              const expanded = !removed && (held || open.has(host.path));
              const detailsId = `settings-host-${host.path.replace(/[^a-z0-9]/gi, "-")}`;
              const key = switchKey.host(config.id, host.name);
              const pending = instant.pendingValue<boolean>(key);
              const own = driver.hostFields.filter((field) => field.group === "ios-hosts").some((field) => {
                const value = draft.current(hostFieldPath(host.path, field.key));
                return value !== null && value !== "";
              });
              const address = draft.current(hostFieldPath(host.path, "address"));
              const user = draft.current(hostFieldPath(host.path, "user"));
              const reach = [user ? `${user}@` : "", address ?? ""].join("");
              const sending = draft.beingSaved(host.path) && draft.busy;
              return (
                <div key={host.path} className={cn(removed && "opacity-70")}>
                  <div className="relative flex items-center gap-3 px-4 py-2.5 transition-colors duration-150 hover:bg-state-hover">
                    <button
                      type="button"
                      aria-label={name}
                      data-host-row={host.path}
                      aria-describedby={`${detailsId}-badges ${detailsId}-line`}
                      aria-expanded={expanded}
                      aria-controls={expanded ? detailsId : undefined}
                      aria-disabled={removed || undefined}
                      onClick={() => (held || removed ? undefined : toggle(host.path))}
                      className={cn("absolute inset-0 cursor-pointer aria-disabled:cursor-default", FOCUS_RING)}
                    />
                    <ProviderGlyph type={config.type} className="pointer-events-none" />
                    <span className="pointer-events-none min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5 text-sm text-foreground">
                        <span aria-hidden>{name}</span>
                        <span id={`${detailsId}-badges`} className="flex items-center gap-1.5 empty:hidden">
                          {!host.saved ? <Badge tone="warn">Added when you save</Badge> : null}
                          {removed ? <Badge tone="warn">Removed when you save</Badge> : null}
                        </span>
                      </span>
                      <span id={`${detailsId}-line`} className="block truncate text-xs text-muted-foreground">
                        {[reach || "No address yet", own ? "its own shared iOS host size" : null].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <span className="pointer-events-none">
                      <SavedTick show={instant.isSaved(key)} />
                    </span>
                    {host.saved ? (
                      <RowControl>
                        <Switch
                          data-draft-path={hostEnabledPath(host.path)}
                          aria-label={`${noun} ${host.name}: takes new boxes`}
                          checked={pending ?? host.enabled}
                          disabled={removed}
                          aria-disabled={instant.pending !== null || undefined}
                          onCheckedChange={(on) => void instant.run(writes.hostOn(state, config, host.name, on, `${noun} ${host.name}`))}
                        />
                      </RowControl>
                    ) : null}
                    <span className="pointer-events-none flex size-4 shrink-0 items-center">{removed ? null : <Icon name={expanded ? "ChevronDown" : "ChevronRight"} className="size-4 text-subtle-foreground" aria-hidden />}</span>
                  </div>
                  <RowNote note={instant.note(key)} className="px-4 pb-2" />
                  {expanded ? (
                    <div id={detailsId}>
                      <HostDetails form={form} host={host} noun={noun} />
                      <div className="flex justify-end border-t border-border bg-surface-raised px-4 py-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 text-muted-foreground"
                          disabled={sending}
                          onClick={() => {
                            if (host.saved) onRemove(host.name);
                            else draft.forgetUnder(host.path);
                          }}
                        >
                          <Icon name="Trash2" aria-hidden />
                          {host.saved ? `Remove ${host.name}…` : "Don't add it"}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  {removed ? (
                    <div className="flex justify-end px-4 pb-2">
                      <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => draft.forget(host.path)}>
                        Keep {host.name}
                      </Button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </Rows>
        </Card>
      ) : (
        <p className="rounded-lg border border-dashed border-border px-4 py-3 text-xs text-subtle-foreground">No {noun} yet. Add {noun} names one and how {PRODUCT} reaches it.</p>
      )}
    </Group>
  );
}

export function RemoveHostDialog({ name, noun, backend, rowOf, onCancel, onConfirm }: { name: string | null; noun: string; backend: string; rowOf: (name: string) => Path; onCancel: () => void; onConfirm: (name: string) => void }) {
  const [last, setLast] = useState<string | null>(null);
  if (name !== null && name !== last) setLast(name);
  return (
    <BoxDialog
      open={name !== null}
      title={`Remove ${name ?? last ?? "it"} from ${backend} when you save?`}
      onClose={onCancel}
      onCloseAutoFocus={(event) => {
        if (!last) return;
        event.preventDefault();
        document.querySelector<HTMLElement>(`[data-host-row="${CSS.escape(rowOf(last))}"]`)?.focus();
      }}
      footer={
        <>
          <DialogButton variant="outline" onClick={onCancel}>
            Cancel
          </DialogButton>
          <DialogButton danger onClick={() => name && onConfirm(name)}>
            Remove when I save
          </DialogButton>
        </>
      }
    >
      <div className="space-y-2">
        <p>New boxes stop going to {name}. Its shared iOS host is deleted when its last box goes, and its warm VMs are released.</p>
        <p>BB Box refuses to remove a {noun} while boxes are on it: turn its switch off and release them first. The removal waits for Save, with the rest of the form.</p>
      </div>
    </BoxDialog>
  );
}
