import { experimental_Icon as Icon, UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DoctorReport } from "../backends/types.ts";
import type { BackendConfig } from "../core/document.ts";
import type { Contract } from "../plugin/contract.ts";
import type { DriverView, FieldView } from "../plugin/configuration.ts";
import { Badge, StatusDot } from "./common.tsx";
import { groupFields, type FieldGroup } from "./config.ts";
import { CheckRow, clearedWords, draftEdits, draftLook, NoteBlock, passedWords, placedPaths } from "./settings-backend-page.tsx";
import { FieldCards, hasFormProblem, HostsSection, type BackendForm } from "./settings-backend-fields.tsx";
import { REPOSITORY_URL } from "./settings-backends.tsx";
import { bindingOf, fingerprintOf, formChecks } from "./settings-checks.ts";
import { useSettings } from "./settings-context.tsx";
import { unplacedProblems } from "./settings-draft-fields.tsx";
import { MachineOffersGroup, useMachineHosts } from "./settings-docker-hosts.tsx";
import { operationId, setupPart } from "./settings-drafts.ts";
import { Card, Chevron, FOCUS_RING, Group, NotHere, PageHeader, ProviderGlyph, Rows } from "./settings-parts.tsx";
import { backendAt, backendFieldPath, backendPath, candidateOf, freeBackendId, isNewBackendId, newBackendPath, type EditValue, type Path, type PathEdit } from "./settings-paths.ts";
import { barOf, RestoredNote, useDraft, useRegistry, type Draft } from "./settings-saving.tsx";
import { isMachineDocker, kindName, plural } from "./settings-status.ts";

interface AddGroup {
  readonly title: string;
  readonly description: string;
  readonly types: readonly string[];
}

const ADD_GROUPS: readonly AddGroup[] = [
  { title: "On BB's server or a machine you have", description: "Docker, microVMs, or your own machines over SSH.", types: ["docker", "microsandbox", "ssh-pool"] },
  { title: "On a Proxmox VE host", description: "Linux containers and VMs, Windows and Android, with GPU desktops.", types: ["proxmox-lxc", "proxmox-qemu"] },
  { title: "On your Macs with Apple silicon", description: "macOS, the iOS Simulator, and Linux and Windows on arm64.", types: ["tart"] },
  { title: "In the cloud, paid by use", description: "Machines made when a box needs one, and deleted after.", types: ["hetzner", "namespace", "boat"] },
];

function addGroups(drivers: readonly DriverView[]): { readonly title: string; readonly description: string; readonly drivers: readonly DriverView[] }[] {
  const grouped = ADD_GROUPS.map((group) => ({ ...group, drivers: group.types.flatMap((type) => drivers.filter((driver) => driver.type === type)) }));
  const placed = new Set(ADD_GROUPS.flatMap((group) => group.types));
  const others = drivers.filter((driver) => !placed.has(driver.type));
  return [...grouped, ...(others.length ? [{ title: "Others", description: "", drivers: others }] : [])].filter((group) => group.drivers.length);
}

function kindsWords(state: ReturnType<typeof useSettings>["state"], kinds: readonly string[]): string {
  const names = kinds.map((id) => state.kinds.find((kind) => kind.id === id)).filter((kind) => kind !== undefined).map((kind) => kindName(state.kinds, kind));
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function addedOf(state: ReturnType<typeof useSettings>["state"], driver: DriverView): readonly BackendConfig[] {
  return state.document.backends.filter((backend) => backend.type === driver.type && !isMachineDocker(backend));
}

export function AddBackendPage() {
  const { state, nav } = useSettings();
  const machines = useMachineHosts();
  return (
    <div className="space-y-7">
      <PageHeader title="Add a backend" description="Where boxes can run. Each says what it makes and what setting it up needs; Set up opens its guide and form, step by step." />
      <MachineOffersGroup machines={machines} />
      {addGroups(state.drivers).map((group) => (
        <Group key={group.title} title={group.title} description={group.description || undefined}>
          <Card>
            <Rows>
              {group.drivers.map((driver) => {
                const added = addedOf(state, driver);
                const only = !driver.several && added.length ? added[0]! : null;
                const rowKey = `add-${driver.type}`;
                const descriptionId = `settings-add-${driver.type}`;
                return (
                  <button
                    key={driver.type}
                    type="button"
                    data-row-key={rowKey}
                    aria-describedby={descriptionId}
                    onClick={() => nav.go(only ? { page: "backend", id: only.id } : { page: "setup", type: driver.type }, rowKey)}
                    className={`flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-state-hover ${FOCUS_RING}`}
                  >
                    <ProviderGlyph type={driver.type} className="mt-0.5" />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-foreground">
                        {driver.label}
                        {added.length && driver.several ? <Badge>{added.length} added</Badge> : null}
                      </span>
                      <span id={descriptionId} className="block">
                        <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">Makes {kindsWords(state, driver.kinds)}.</span>
                        {driver.setup.needs ? <span className="mt-1 block text-xs leading-snug text-subtle-foreground">You need: {driver.setup.needs}</span> : null}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2 self-center text-xs text-muted-foreground">
                      {only ? "Added: open it" : added.length ? "Add another" : "Set up"}
                      <Chevron />
                    </span>
                  </button>
                );
              })}
            </Rows>
          </Card>
        </Group>
      ))}
    </div>
  );
}

const provisionalMarks = new Map<string, string>();

function provisionalIdOf(draft: Draft, type: string): string {
  for (const path of draft.entry.edits.keys()) {
    const id = backendAt(path)?.id;
    if (id && isNewBackendId(id) && id.startsWith(`${type}@`)) return id;
  }
  const part = draft.part;
  let mark = provisionalMarks.get(part);
  if (!mark) {
    mark = operationId().slice(-8);
    provisionalMarks.set(part, mark);
  }
  return backendAt(newBackendPath(type, mark))!.id;
}

function newBackendEdit(draft: Draft, provisional: string): Extract<EditValue, { kind: "new-backend" }> | null {
  const value = draft.edit(backendPath(provisional));
  return value?.kind === "new-backend" ? value : null;
}

function Step({ number, title, description, children }: { number: number; title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <section className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3" aria-label={`Step ${number}: ${title}`}>
      <span aria-hidden className="mt-px flex size-5 items-center justify-center rounded-full border border-border text-2xs tabular-nums text-muted-foreground">
        {number}
      </span>
      <div className="min-w-0 space-y-4">
        <div>
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          {description ? <div className="mt-0.5 text-xs leading-snug text-subtle-foreground">{description}</div> : null}
        </div>
        {children}
      </div>
    </section>
  );
}

function PrepareStep({ driver }: { driver: DriverView }) {
  const guide = `${REPOSITORY_URL}/${driver.setup.guide}`;
  return (
    <Step
      number={1}
      title="Prepare"
      description={
        <>
          <p>
            Follow the{" "}
            <UrlLink href={guide} className="text-muted-foreground underline underline-offset-2 hover:text-foreground">
              {driver.label} setup guide
            </UrlLink>
            .{driver.setup.needs ? ` You need: ${driver.setup.needs}` : ""}
          </p>
          {driver.setup.scripts.length ? <p className="mt-0.5">{driver.setup.scripts.length === 1 ? "Its script prints" : "Its scripts run in this order and print"} the values the next step asks for.</p> : null}
        </>
      }
    >
      {driver.setup.scripts.length ? (
        <Card>
          <Rows>
            {driver.setup.scripts.map((script, index) => (
              <UrlLink key={script} href={`${REPOSITORY_URL}/${script}`} aria-label={`${script.split("/").pop()}, script ${index + 1} of ${driver.setup.scripts.length}`} className={cn("flex items-center gap-3 px-4 py-2 text-xs transition-colors hover:bg-state-hover", FOCUS_RING)}>
                <span className="w-4 text-right tabular-nums text-subtle-foreground">{index + 1}</span>
                <code className="min-w-0 flex-1 truncate font-mono text-foreground">{script.split("/").pop()}</code>
                <span className="hidden truncate text-subtle-foreground sm:inline">{script.split("/").slice(0, -1).join("/")}</span>
                <Icon name="ArrowUpRight" className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden />
              </UrlLink>
            ))}
          </Rows>
        </Card>
      ) : null}
    </Step>
  );
}

const CONNECT_GROUPS: ReadonlySet<FieldGroup> = new Set(["connection", "credentials"]);

function offeredWords(form: BackendForm, fields: readonly FieldView[]): string {
  const { draft, driver } = form;
  const state = draft.latest;
  const left = fields.filter((field) => field.offWhenEmpty && draft.current(backendFieldPath(form.config.id, field.key)) === "");
  const can = `It can make ${kindsWords(state, driver.kinds)}.`;
  if (left.length) return `${can} Left out, as you unticked Offer: ${left.map((field) => field.label).join(", ")}.`;
  return fields.some((field) => field.offWhenEmpty) ? `${can} Untick Offer to leave one out.` : can;
}

function useChecks() {
  const checks = formChecks();
  useSyncExternalStore(
    (listener) => checks.subscribe(listener),
    () => checks.serial,
    () => checks.serial,
  );
  return checks;
}

function CheckResult({ report, problems, failure, cleared }: { report: DoctorReport | null; problems: readonly { readonly path: string; readonly message: string }[]; failure: string | null; cleared: string | null }) {
  const [all, setAll] = useState(false);
  if (cleared) return <p className="text-xs leading-snug text-warning-text">{cleared}</p>;
  if (failure) return <p className="text-xs leading-snug text-destructive-text">The check could not run: {failure}</p>;
  if (!report) {
    return problems.length ? (
      <Card className="space-y-1 px-4 py-3 text-xs leading-snug">
        <p className="text-foreground">The checks need these fixed first:</p>
        <ul className="list-disc space-y-0.5 pl-5 text-destructive-text">
          {problems.map((problem) => (
            <li key={`${problem.path} ${problem.message}`}>{problem.message}</li>
          ))}
        </ul>
      </Card>
    ) : null;
  }
  const look = draftLook(report);
  const shown = report.checks.filter((check) => check.status === "fail" || check.status === "warn");
  const rest = report.checks.filter((check) => check.status !== "fail" && check.status !== "warn");
  return (
    <Card className={cn(look.tone === "bad" && "border-surface-destructive-border")}>
      <div className="px-4 py-3" role="status">
        <p className="flex items-start gap-1.5 text-sm text-foreground">
          <StatusDot tone={look.tone} />
          <span className={cn("font-medium", look.tone === "bad" && "text-destructive-text")}>{look.tone === "bad" ? "Not working with this form" : look.words.replace("Your changes pass", "This form passes")}</span>
        </p>
        <p className="mt-0.5 pl-3 text-xs leading-snug text-subtle-foreground">Checked just now, against this form. Nothing is saved yet. {passedWords(report)}.</p>
      </div>
      {shown.length ? (
        <ul className="space-y-3 border-t border-border px-4 py-3">
          {shown.map((check) => (
            <CheckRow key={check.id} check={check} />
          ))}
        </ul>
      ) : null}
      {report.notes.length ? (
        <div className="space-y-2 border-t border-border px-4 py-3">
          {report.notes.map((note) => (
            <NoteBlock key={note} text={note} />
          ))}
        </div>
      ) : null}
      {rest.length ? (
        <div className="border-t border-border">
          <button type="button" onClick={() => setAll((current) => !current)} aria-expanded={all} className={cn("flex w-full cursor-pointer items-center gap-1.5 px-4 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground", FOCUS_RING)}>
            <Icon name={all ? "ChevronDown" : "ChevronRight"} className="size-3.5" aria-hidden />
            {all ? "Hide the checks" : shown.length ? plural(rest.length, "other check") : `Show the ${plural(rest.length, "check")}`}
          </button>
          {all ? (
            <ul className="space-y-2.5 px-4 pb-3 pt-1">
              {rest.map((check) => (
                <CheckRow key={check.id} check={check} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function setupBarWords(draft: Draft, on: boolean | null): { readonly words: string; readonly tone: "quiet" | "busy" | "warn" | "bad" | "done"; readonly retry: boolean; readonly show: boolean } {
  const bar = barOf(draft, true);
  const outcome = draft.entry.outcome;
  if (bar && outcome?.kind === "problems" && !draft.conflicts.length && !draft.busy) {
    const fields = outcome.count === 1 ? "the field marked" : `the ${outcome.count} fields marked`;
    return { ...bar, words: on ? `Not saved: it cannot be on without ${fields}. Fix it, or save it off to finish later.` : `Not saved: fix ${fields}. Your form is still here.` };
  }
  if (bar && bar.tone !== "quiet") return bar;
  return { words: "Nothing is saved until you choose. Your form is kept if you leave this page.", tone: "quiet", retry: false, show: false };
}

function SetupBar({ draft, label, onSave, onDiscard, unplaced, on }: { draft: Draft; label: string; onSave: (on: boolean) => void; onDiscard: () => void; unplaced: readonly string[]; on: boolean | null }) {
  const bar = setupBarWords(draft, on);
  const busy = bar.tone === "busy";
  const blocked = busy || draft.conflicts.length > 0;
  return (
    <div className="pointer-events-none sticky bottom-3 z-20 mt-6 flex justify-center">
      <div role="region" aria-label={`Save ${label}`} className="pointer-events-auto flex w-full max-w-2xl flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-popover px-3 py-2 shadow-[0_2px_10px_rgb(0_0_0/0.25)]">
        <span role="status" aria-live="polite" className={cn("min-w-0 flex-1 basis-56 text-xs leading-snug", bar.tone === "bad" ? "text-destructive-text" : bar.tone === "warn" ? "text-warning-text" : "text-muted-foreground")}>
          {busy ? <Icon name="Loading" className="mr-1 inline size-3.5 animate-spin align-[-2px]" aria-hidden /> : null}
          {bar.words}
          {unplaced.length ? <span className="mt-1 block text-destructive-text">{unplaced.join(" ")}</span> : null}
        </span>
        <span className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          {bar.show ? (
            <Button type="button" variant="ghost" size="sm" className="h-7" onClick={draft.revealFirst}>
              Show
            </Button>
          ) : null}
          <Button type="button" variant="ghost" size="sm" className="h-7" aria-disabled={busy || undefined} onClick={() => !busy && onDiscard()}>
            Discard and go back
          </Button>
          {bar.retry && draft.entry.operation ? (
            <Button type="button" size="sm" className="h-7" aria-disabled={busy || undefined} onClick={() => !busy && draft.save()}>
              Save again
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" size="sm" className="h-7" aria-disabled={blocked || undefined} onClick={() => !blocked && onSave(false)}>
                Save, keep it off
              </Button>
              <Button type="button" size="sm" className="h-7" aria-disabled={blocked || undefined} onClick={() => !blocked && onSave(true)}>
                Save and turn on
              </Button>
            </>
          )}
        </span>
      </div>
    </div>
  );
}

function TakenNote({ draft, provisional, driver, onOpen }: { draft: Draft; provisional: string; driver: DriverView; onOpen: (id: string) => void }) {
  const path = backendPath(provisional);
  const conflict = draft.conflict(path);
  if (conflict?.kind !== "taken") return null;
  return (
    <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-warning/40 px-3 py-2 text-xs leading-snug">
      <span className="min-w-0 flex-1 basis-48 text-foreground">
        A {driver.label} backend, {conflict.id}, was added elsewhere while you set this up, so this form was not saved over it.
      </span>
      <span className="flex shrink-0 gap-1.5">
        <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => onOpen(conflict.id)}>
          Open {conflict.id}
        </Button>
        {driver.several ? (
          <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => draft.keepMine(path)}>
            Add mine beside it
          </Button>
        ) : null}
      </span>
    </div>
  );
}

export function SetupPage({ type }: { type: string }) {
  const { state, nav } = useSettings();
  const driver = state.drivers.find((candidate) => candidate.type === type);
  if (!driver) return <NotHere what="kind of backend" />;
  const only = driver.several ? null : (state.document.backends.find((backend) => backend.type === type) ?? null);
  return <SetupEditor key={type} driver={driver} only={only} onOpen={(id) => nav.replace({ page: "backend", id })} />;
}

function SetupEditor({ driver, only, onOpen }: { driver: DriverView; only: BackendConfig | null; onOpen: (id: string) => void }) {
  const { nav } = useSettings();
  const rpc = useRpc<Contract>();
  const registry = useRegistry();
  const checks = useChecks();
  const part = setupPart(driver.type);
  const draft = useDraft(part, `the ${driver.label} setup`, { enterSaves: false });
  const landed = registry.landing(part);
  useEffect(() => {
    if (!landed) return;
    registry.forgetLanding(part);
    provisionalMarks.delete(part);
    checks.forget(part);
    nav.replace({ page: "backend", id: landed });
  }, [landed, registry, part, nav, checks]);
  const provisional = provisionalIdOf(draft, driver.type);
  const created = newBackendEdit(draft, provisional);
  if (only && !created && !draft.entry.edits.size) {
    return (
      <div className="space-y-3">
        <PageHeader glyph={<ProviderGlyph type={driver.type} className="size-5" />} title={`${driver.label} is added`} description="It has its own page, with its settings and checks." />
        <Button type="button" variant="outline" size="sm" className="h-8" onClick={() => onOpen(only.id)}>
          Open {driver.label}
        </Button>
      </div>
    );
  }
  const latest = draft.latest;
  const config: BackendConfig = { id: provisional, type: driver.type, enabled: false, fields: {} };
  const form: BackendForm = { draft, state: latest, config, driver };
  const groups = groupFields(driver.fields);
  const connect = groups.filter((group) => CONNECT_GROUPS.has(group.id));
  const makes = groups.filter((group) => !CONNECT_GROUPS.has(group.id));
  const forced = (path: Path) => draft.edit(path) !== null || draft.conflict(path) !== null || hasFormProblem(form, path);
  const savedAs = created?.id ?? freeBackendId(latest.document, driver.type, driver.several);
  const withCreated = (enabled: boolean): PathEdit[] => [...draftEdits(draft).filter((edit) => edit.path !== backendPath(provisional)), { path: backendPath(provisional), value: { kind: "new-backend", type: driver.type, id: savedAs, enabled }, base: { kind: "gone" } }];
  const checkEdits = withCreated(false);
  const fingerprint = fingerprintOf(latest.revision, new Map(checkEdits.map((edit) => [edit.path, { value: edit.value, base: edit.base }])));
  const running = checks.running(part);
  const check = checks.last(part);
  const binding = check ? bindingOf(check, fingerprint) : null;
  const runCheck = () => {
    if (running) return;
    const candidate = candidateOf(latest, checkEdits);
    void checks.run(part, fingerprint, true, () => rpc.call("config.check", { draft: candidate.document, test: savedAs }), Date.now);
  };
  const save = (on: boolean) => {
    draft.set(backendPath(provisional), { kind: "new-backend", type: driver.type, id: created?.id && !draft.conflict(backendPath(provisional)) ? created.id : savedAs, enabled: on });
    draft.save();
  };
  const discard = () => {
    draft.discard();
    provisionalMarks.delete(part);
    checks.forget(part);
    nav.back();
  };
  const connectStep = connect.length > 0 || driver.hostFields.length > 0;
  return (
    <div className="space-y-8">
      <PageHeader
        glyph={<ProviderGlyph type={driver.type} className="size-5" />}
        title={`Set up ${driver.label}`}
        description={
          <>
            <p>{driver.description}</p>
            <p className="mt-1">Fields, checkboxes and radio choices wait for you to save. Nothing is saved until you choose Save and turn on, or Save, keep it off.</p>
          </>
        }
      />
      <RestoredNote draft={draft} />
      <TakenNote draft={draft} provisional={provisional} driver={driver} onOpen={onOpen} />
      <PrepareStep driver={driver} />
      {connectStep ? (
        <Step number={2} title="Connect" description="The values the guide gives, or its scripts printed.">
          <FieldCards form={form} groups={connect} forced={forced} />
          <HostsSection form={form} forced={forced} onRemove={() => {}} settingUp />
        </Step>
      ) : null}
      <Step number={connectStep ? 3 : 2} title="Choose what it makes" description={offeredWords(form, driver.fields)}>
        <FieldCards form={form} groups={makes} forced={forced} />
      </Step>
      <Step number={connectStep ? 4 : 3} title="Check it" description={`Runs all of ${driver.label}'s checks against this form, as it will be saved, up to 30 s. Nothing is saved.`}>
        <div>
          <Button type="button" variant="outline" size="sm" className="h-7" aria-disabled={running || undefined} onClick={runCheck}>
            {running ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
            {running ? "Checking…" : check ? "Check again" : "Check"}
          </Button>
        </div>
        {check && !running ? (
          <CheckResult report={binding === "current" ? (check.result?.doctor ?? null) : null} problems={binding === "current" ? (check.result?.problems ?? []) : []} failure={binding === "current" ? check.failure : null} cleared={binding && binding !== "current" ? clearedWords(binding) : null} />
        ) : null}
      </Step>
      <SetupBar draft={draft} label={driver.label} onSave={save} onDiscard={discard} unplaced={unplacedProblems(draft, placedPaths(form, driver.fields))} on={created?.enabled ?? null} />
    </div>
  );
}
