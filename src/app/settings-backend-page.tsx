import { experimental_Icon as Icon, UrlLink, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { DoctorCheck, DoctorReport } from "../backends/types.ts";
import type { BackendConfig } from "../core/document.ts";
import type { Contract } from "../plugin/contract.ts";
import type { ConfigState, DriverView, FieldView } from "../plugin/configuration.ts";
import { Badge, relativeTime, StatusDot, type Tone } from "./common.tsx";
import { groupFields, isSecretField, isSecretState } from "./config.ts";
import { REPOSITORY_URL } from "./settings-backends.tsx";
import { backendPart, FieldCards, hasFormProblem, HostsSection, RemoveHostDialog, type BackendForm } from "./settings-backend-fields.tsx";
import { bindingOf, fingerprintOf, formChecks, type FormCheck } from "./settings-checks.ts";
import { switchKey, useSettings } from "./settings-context.tsx";
import { unplacedProblems } from "./settings-draft-fields.tsx";
import { DockerHostsSection } from "./settings-docker-hosts.tsx";
import { drafts } from "./settings-drafts.ts";
import { Card, Group, NotHere, PageHeader, ProviderGlyph, RowControl, RowNote, Rows, SavedTick } from "./settings-parts.tsx";
import { backendAt, candidateOf, hostPath, type Path, type PathEdit } from "./settings-paths.ts";
import { RestoredNote, SAVING_RULE, SaveBar, useDraft, type Draft } from "./settings-saving.tsx";
import { backendHealth, backendLabel, hostChip, isMachineDocker, kindName, plural, type BackendHealth } from "./settings-status.ts";

const CHECK_LOOK: Record<DoctorCheck["status"], { icon: string; className: string; label: string }> = {
  ok: { icon: "CircleCheck", className: "text-success", label: "Passed" },
  warn: { icon: "AlertTriangle", className: "text-warning", label: "Warning" },
  fail: { icon: "X", className: "text-destructive", label: "Failed" },
  skipped: { icon: "Minus", className: "text-subtle-foreground", label: "Skipped" },
};

function useFormChecks() {
  const checks = formChecks();
  useSyncExternalStore(
    (listener) => checks.subscribe(listener),
    () => checks.serial,
    () => checks.serial,
  );
  return checks;
}

function CheckRow({ check }: { check: DoctorCheck }) {
  const look = CHECK_LOOK[check.status];
  return (
    <li className="grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-2.5 text-xs leading-snug">
      <Icon name={look.icon} className={cn("mt-px size-4", look.className)} aria-label={look.label} />
      <div className="min-w-0">
        <p className={cn("font-medium", check.status === "skipped" ? "text-muted-foreground" : "text-foreground")}>{check.name}</p>
        {check.detail ? <p className="break-words text-muted-foreground">{check.detail}</p> : null}
        {check.fix && check.status !== "ok" ? (
          <p className="mt-1 text-foreground">
            <span className="text-subtle-foreground">Fix: </span>
            {check.fix}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function NoteBlock({ text }: { text: string }) {
  const [lead, ...rest] = text.split("\n");
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">{lead}</p>
      {rest.length ? <pre className="min-w-0 whitespace-pre-wrap break-all rounded-md bg-surface-recessed px-2.5 py-2 font-mono text-2xs leading-relaxed text-foreground">{rest.join("\n")}</pre> : null}
    </div>
  );
}

function reportTone(report: DoctorReport): { readonly tone: Tone; readonly words: string } {
  if (report.checks.some((check) => check.status === "fail")) return { tone: "bad", words: "Not working" };
  if (report.checks.some((check) => check.status === "warn") || !report.ok) return { tone: "warn", words: "Needs attention" };
  return { tone: "ok", words: "Ready" };
}

function passedWords(report: DoctorReport): string {
  const passed = report.checks.filter((check) => check.status === "ok").length;
  return `${passed} of ${plural(report.checks.length, "check")} passed`;
}

function storedLine(health: BackendHealth, report: DoctorReport | null, now: number): string {
  const ago = health.checkedAt !== null ? relativeTime(health.checkedAt, now) : null;
  switch (health.status) {
    case "off":
      return "It takes no new boxes. Check it before you turn it on.";
    case "unfinished":
      return `${(health.detail ?? "Some settings are missing").replace(/\.$/, "")}. Finish its settings, then turn it on.`;
    case "never":
      return "Check runs all its checks against what is saved, up to 30 s.";
    case "changed":
      return report && ago ? `Its settings changed after its last check, ${ago}, which ${report.ok ? "passed" : "did not pass"}: ${passedWords(report)}. Check again to know.` : "Its settings changed after its last check. Check again to know.";
    case "stale":
      return report && ago ? `${passedWords(report)} · checked ${ago}, so it may have changed since` : "It may have changed since its last check.";
    default:
      return report && ago ? `${passedWords(report)} · checked ${ago}` : (health.detail ?? "");
  }
}

function clearedWords(binding: ReturnType<typeof bindingOf> | null): string | null {
  if (binding === "form-changed") return "Your form changed after you checked it, so that result was cleared. Check again.";
  if (binding === "configuration-changed") return "The configuration changed after you checked it, so that result was cleared. Check again.";
  return null;
}

function HealthCard({ form, check, running, onCheck, id }: { form: BackendForm; check: FormCheck | null; running: boolean; onCheck: () => void; id: string }) {
  const { state, config, draft } = form;
  const [all, setAll] = useState(false);
  const now = Date.now();
  const health = backendHealth(state, config, now);
  const live = state.backends.find((each) => each.id === config.id);
  const binding = check ? bindingOf(check, fingerprintOf(draft.latest.revision, draft.entry.edits)) : null;
  const ofDraft = check?.againstDraft && binding === "current" ? check : null;
  const cleared = check?.againstDraft && draft.changes > 0 && binding !== "current" ? clearedWords(binding) : null;
  const report = ofDraft ? (ofDraft.result?.doctor ?? null) : (live?.doctor?.report ?? null);
  const draftTone = ofDraft?.result?.doctor ? reportTone(ofDraft.result.doctor) : null;
  const look: { readonly tone: Tone; readonly words: string } = running
    ? { tone: "busy", words: "Checking…" }
    : draftTone
      ? { tone: draftTone.tone, words: draftTone.tone === "ok" ? "Your changes pass its checks" : draftTone.tone === "bad" ? "Not working with your changes" : "Needs attention with your changes" }
      : ofDraft
        ? { tone: "warn", words: "Could not check your changes" }
        : { tone: health.tone, words: health.words };
  const line = running
    ? `Running all its checks against ${draft.changes ? "your unsaved changes" : "what is saved"}, up to 30 s.`
    : ofDraft
      ? `Checked ${relativeTime(ofDraft.at, now)}, against your unsaved changes. Nothing is saved yet.${ofDraft.result?.doctor ? ` ${passedWords(ofDraft.result.doctor)}.` : ""}`
      : storedLine(health, report, now);
  const showChecks = !running && report !== null && (ofDraft !== null || health.status !== "off");
  const problems = showChecks ? report!.checks.filter((each) => each.status === "fail" || each.status === "warn") : [];
  const rest = showChecks ? report!.checks.filter((each) => each.status !== "fail" && each.status !== "warn") : [];
  const formProblems = ofDraft?.result && !ofDraft.result.doctor ? ofDraft.result.problems : [];
  const fixLine = !ofDraft && !running && health.fix && (health.status === "failing" || health.status === "attention") && !problems.length ? health.fix : null;
  const label = running ? "Checking…" : draft.changes ? "Check with my changes" : report ? "Check again" : "Check";
  return (
    <Card className={cn(look.tone === "bad" && "border-surface-destructive-border", look.tone === "warn" && "border-surface-warning-border")}>
      <div className="flex flex-wrap items-start gap-3 px-4 py-3">
        <div className="min-w-0 flex-1 basis-56" id={id} role="status" aria-live="polite">
          <p className="flex items-start gap-1.5 text-sm text-foreground">
            <StatusDot tone={look.tone} />
            <span className={cn("font-medium", look.tone === "bad" && "text-destructive-text", look.tone === "warn" && "text-warning-text")}>{look.words}</span>
            {report && !running && (ofDraft || health.status !== "off") ? <span className="hidden min-w-0 truncate text-muted-foreground sm:inline">· {report.summary}</span> : null}
          </p>
          <p className="mt-0.5 pl-3 text-xs leading-snug text-subtle-foreground">{line}</p>
          {cleared && !running ? <p className="mt-0.5 pl-3 text-xs leading-snug text-warning-text">{cleared}</p> : null}
          {ofDraft?.failure && !running ? <p className="mt-0.5 pl-3 text-xs leading-snug text-destructive-text">The check could not run: {ofDraft.failure}</p> : null}
          {!ofDraft && check?.failure && !running && !draft.changes ? <p className="mt-0.5 pl-3 text-xs leading-snug text-destructive-text">The check could not run: {check.failure}</p> : null}
          {health.detail && !ofDraft && !running && (health.status === "failing" || health.status === "attention") && !problems.length ? <p className="mt-0.5 pl-3 text-xs leading-snug text-foreground">{health.detail}</p> : null}
          {fixLine ? (
            <p className="mt-0.5 pl-3 text-xs leading-snug text-foreground">
              <span className="text-subtle-foreground">Fix: </span>
              {fixLine}
            </p>
          ) : null}
        </div>
        <Button type="button" variant={health.status === "changed" || health.status === "never" || health.status === "stale" ? "default" : "outline"} size="sm" className="h-7 shrink-0" aria-disabled={running || undefined} onClick={() => !running && onCheck()}>
          {running ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
          {label}
        </Button>
      </div>
      {formProblems.length && !running ? (
        <div className="space-y-1 border-t border-border px-4 py-3 text-xs leading-snug">
          <p className="text-foreground">The checks need these fixed first:</p>
          <ul className="list-disc space-y-0.5 pl-5 text-destructive-text">
            {formProblems.map((problem) => (
              <li key={`${problem.path} ${problem.message}`}>{problem.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {problems.length ? (
        <ul className="space-y-3 border-t border-border px-4 py-3">
          {problems.map((each) => (
            <CheckRow key={each.id} check={each} />
          ))}
        </ul>
      ) : null}
      {showChecks && report!.notes.length ? (
        <div className="space-y-2 border-t border-border px-4 py-3">
          {report!.notes.map((note) => (
            <NoteBlock key={note} text={note} />
          ))}
        </div>
      ) : null}
      {rest.length ? (
        <div className="border-t border-border">
          <button type="button" onClick={() => setAll((current) => !current)} aria-expanded={all} className="flex w-full cursor-pointer items-center gap-1.5 px-4 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring">
            <Icon name={all ? "ChevronDown" : "ChevronRight"} className="size-3.5" aria-hidden />
            {all ? "Hide the checks" : problems.length ? `${plural(rest.length, "other check")}` : `Show the ${plural(rest.length, "check")}`}
          </button>
          {all ? (
            <ul className="space-y-2.5 px-4 pb-3 pt-1">
              {rest.map((each) => (
                <CheckRow key={each.id} check={each} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function InUseCard({ state, config }: { state: ConfigState; config: BackendConfig }) {
  const { nav } = useSettings();
  const live = state.backends.find((each) => each.id === config.id);
  const kinds = live?.kinds ?? [];
  const warm = Object.entries(config.warm ?? {}).filter(([, count]) => count > 0);
  const nameOf = (kind: string) => {
    const info = state.kinds.find((each) => each.id === kind);
    return info ? kindName(state.kinds, info) : kind;
  };
  const rows: { readonly label: string; readonly value: ReactNode }[] = [
    { label: "Boxes now", value: live?.boxes ? plural(live.boxes, "box", "boxes") : "None" },
    {
      label: "Makes",
      value: kinds.length ? (
        <span className="flex flex-wrap justify-end gap-x-2 gap-y-1">
          {kinds.map((kind) => (
            <button key={kind} type="button" data-row-key={`makes-${kind}`} onClick={() => nav.go({ page: "kind", id: kind }, `makes-${kind}`)} className="cursor-pointer rounded-sm text-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
              {nameOf(kind)}
            </button>
          ))}
        </span>
      ) : config.enabled ? (
        <span className="text-warning-text">Nothing now</span>
      ) : (
        "Nothing while it is off"
      ),
    },
    {
      label: "Kept warm",
      value: warm.length ? (
        <span className="flex flex-col items-end gap-0.5">
          {warm.map(([kind, count]) => {
            const short = live?.warmShort.find((each) => each.kinds.includes(kind));
            return (
              <span key={kind} className={cn(short && "text-warning-text")}>
                {short ? `${short.have} of ${count} ${nameOf(kind)} ready: no room` : `${count} ${nameOf(kind)}`}
              </span>
            );
          })}
        </span>
      ) : (
        "None. Each kind's page sets it."
      ),
    },
  ];
  return (
    <Group title="In use">
      <Card>
        <Rows>
          {rows.map((row) => (
            <div key={row.label} className="flex items-start justify-between gap-4 px-4 py-2.5 text-xs">
              <span className="shrink-0 text-muted-foreground">{row.label}</span>
              <span className="min-w-0 text-right text-foreground">{row.value}</span>
            </div>
          ))}
        </Rows>
      </Card>
    </Group>
  );
}

function GuideLine({ driver }: { driver: DriverView }) {
  if (!driver.setup.guide) return null;
  return (
    <p className="px-1 text-xs leading-snug text-subtle-foreground">
      <UrlLink href={`${REPOSITORY_URL}/${driver.setup.guide}`} className="text-muted-foreground underline underline-offset-2 hover:text-foreground">
        {driver.label} setup guide
      </UrlLink>
      {driver.setup.scripts.length ? (
        <>
          {" · "}
          {driver.setup.scripts.map((script, index) => (
            <span key={script}>
              {index ? ", " : ""}
              <UrlLink href={`${REPOSITORY_URL}/${script}`} className="hover:text-foreground hover:underline">
                {script.split("/").pop()}
              </UrlLink>
            </span>
          ))}
        </>
      ) : null}
    </p>
  );
}

function savedJson(config: BackendConfig): string {
  const fields = Object.fromEntries(Object.entries(config.fields).map(([key, value]) => [key, isSecretState(value) ? { set: value.set } : value]));
  return JSON.stringify({ ...config, fields }, null, 2);
}

function secretsSet(driver: DriverView, config: BackendConfig): string[] {
  return driver.fields.filter((field) => isSecretField(field) && isSecretState(config.fields[field.key]) && (config.fields[field.key] as { set: boolean }).set).map((field) => `the ${field.label}`);
}

function focusMenuOf(id: string) {
  return (event: Event) => {
    event.preventDefault();
    document.querySelector<HTMLElement>(`[data-backend-menu="${CSS.escape(id)}"]`)?.focus();
  };
}

function RenameDialog({ open, label, id, driverLabel, onCancel, onSave }: { open: boolean; label: string; id: string; driverLabel: string; onCancel: () => void; onSave: (name: string) => void }) {
  const [name, setName] = useState(label);
  const field = useRef<HTMLInputElement>(null);
  const problem = name.trim().length > 64 ? "Give it a name of up to 64 characters." : null;
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          field.current?.focus();
          field.current?.select();
        }}
        onCloseAutoFocus={focusMenuOf(id)}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Rename {label}</AlertDialogTitle>
          <AlertDialogDescription>
            The name BB Box shows for it. Its ID, {id}, stays as it is, so nothing that uses it changes. Empty uses {driverLabel}.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          ref={field}
          aria-label="Name"
          aria-invalid={problem ? true : undefined}
          className="h-8 text-sm"
          value={name}
          placeholder={driverLabel}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || problem) return;
            event.preventDefault();
            onSave(name);
          }}
        />
        {problem ? (
          <p role="alert" className="text-xs text-destructive-text">
            {problem}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={problem !== null} onClick={() => onSave(name)}>
            Save name
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RemoveBackendDialog({ open, id, label, secrets, onCancel, onConfirm }: { open: boolean; id: string; label: string; secrets: readonly string[]; onCancel: () => void; onConfirm: () => void }) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent onCloseAutoFocus={focusMenuOf(id)}>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {label}?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>Its settings are deleted{secrets.length ? `, with ${secrets.join(" and ")}, which BB Box cannot show or get back` : ""}. Its warm boxes are released.</p>
              <p>Threads can no longer get boxes from it. To use it again you set it up again. There is no undo.</p>
              <p>BB Box refuses to remove a backend while it has boxes.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={onConfirm}>
            Remove backend
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function draftEdits(draft: Draft): PathEdit[] {
  return [...draft.entry.edits].map(([path, edit]) => ({ path, ...edit }));
}

function placedPaths(form: BackendForm, fields: readonly FieldView[]): Path[] {
  const id = form.config.id;
  const placed: Path[] = fields.map((field) => `backends/${id}/fields/${field.key}`);
  placed.push(`backends/${id}/hosts`);
  for (const problem of form.draft.entry.problems) {
    const at = backendAt(problem.path);
    if (at && (at.at === "host-field" || at.at === "host-name" || at.at === "host")) placed.push(problem.path);
  }
  return placed;
}

export function BackendPage({ id }: { id: string }) {
  const { state } = useSettings();
  const config = state.document.backends.find((backend) => backend.id === id);
  if (!config) return <NotHere what="backend" />;
  return <BackendEditor key={id} config={config} />;
}


function BackendEditor({ config }: { config: BackendConfig }) {
  const { state, nav, instant, writes, refresh } = useSettings();
  const rpc = useRpc<Contract>();
  const navigate = useBbNavigate();
  const checks = useFormChecks();
  const label = backendLabel(state, config);
  const part = backendPart(config.id);
  const draft = useDraft(part, label);
  const driver = state.drivers.find((candidate) => candidate.type === config.type);
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removingHost, setRemovingHost] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const chip = hostChip(config, label);
  const machine = isMachineDocker(config);
  const key = switchKey.backend(config.id);
  const pending = instant.pendingValue<boolean>(key);
  const live = state.backends.find((candidate) => candidate.id === config.id);
  const boxes = live?.boxes ?? 0;
  const healthId = `settings-backend-health-${config.id.replace(/[^a-z0-9]/gi, "-")}`;
  if (!driver) {
    return (
      <div className="space-y-6">
        <PageHeader glyph={<ProviderGlyph type={config.type} className="size-5" />} title={label} />
        <p className="text-xs text-destructive-text">This version of BB Box has no driver for {config.type}.</p>
      </div>
    );
  }
  const form: BackendForm = { draft, state: draft.latest, config: draft.latest.document.backends.find((each) => each.id === config.id) ?? config, driver };
  const fields = driver.fields.filter((field) => !(machine && field.key === "host"));
  const groups = groupFields(fields);
  const forced = (path: Path) => draft.edit(path) !== null || draft.conflict(path) !== null || hasFormProblem(form, path);
  const running = checks.running(part);
  const check = checks.last(part);
  const runCheck = () => {
    const candidate = candidateOf(draft.latest, draftEdits(draft));
    const fingerprint = fingerprintOf(draft.latest.revision, draft.entry.edits);
    void checks.run(part, fingerprint, draft.changes > 0, () => rpc.call("config.check", { draft: candidate.document, test: config.id }), Date.now).then(() => refresh());
  };
  const notes = [instant.note(key), instant.note(switchKey.backendLabel(config.id)), instant.note(switchKey.removeBackend(config.id))];
  const remove = () => {
    setRemoving(false);
    void instant.run(writes.removeBackend(draft.latest, config, label)).then((outcome) => {
      if (outcome?.kind !== "saved" && outcome?.kind !== "already") return;
      drafts().discard(part);
      checks.forget(part);
      nav.toOverview();
    });
  };
  const copy = () => {
    void navigator.clipboard
      ?.writeText(savedJson(config))
      .then(() => setCopied(`Copied ${label}'s saved settings as JSON. Secrets are not in it, only whether each is set.`))
      .catch(() => setCopied("The browser did not let BB Box copy."));
  };
  return (
    <div className="space-y-6">
      <PageHeader
        glyph={<ProviderGlyph type={config.type} className="size-5" />}
        title={label}
        chips={
          <>
            {chip ? <Badge>{chip}</Badge> : null}
            {machine ? <Badge>BB machine</Badge> : null}
          </>
        }
        description={
          <>
            <p>{driver.description}</p>
            <p className="mt-1">Saved changes reach new boxes; boxes already made keep theirs.</p>
            <p className="mt-1">{SAVING_RULE}</p>
          </>
        }
        aside={
          <>
            <SavedTick show={instant.isSaved(key) || instant.isSaved(switchKey.backendLabel(config.id))} />
            <label className="flex items-center gap-3 text-xs text-foreground">
              Takes new boxes
              <RowControl>
                <Switch aria-label={`${label}: takes new boxes`} aria-describedby={healthId} checked={pending ?? config.enabled} aria-disabled={instant.pending !== null || undefined} onCheckedChange={(on) => void instant.run(writes.backendOn(draft.latest, config, on, label))} />
              </RowControl>
            </label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className="size-7 p-0 text-muted-foreground hover:text-foreground" aria-label={`More for ${label}`} data-backend-menu={config.id}>
                  <Icon name="MoreHorizontal" className="size-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-max min-w-52">
                <DropdownMenuItem onSelect={() => setRenaming(true)}>
                  <Icon name="Pencil" aria-hidden />
                  Rename…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={copy}>
                  <Icon name="Copy" aria-hidden />
                  Copy saved settings as JSON
                </DropdownMenuItem>
                {driver.setup.guide ? (
                  <DropdownMenuItem onSelect={() => navigate.openUrl(`${REPOSITORY_URL}/${driver.setup.guide}`)}>
                    <Icon name="ArrowUpRight" aria-hidden />
                    Open the setup guide
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" disabled={boxes > 0} onSelect={() => setRemoving(true)}>
                  <Icon name="Trash2" aria-hidden />
                  {boxes ? `Remove: release its ${plural(boxes, "box", "boxes")} first` : "Remove backend…"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      >
        {notes.map((note, index) => (
          <RowNote key={index} note={note} />
        ))}
        {copied ? (
          <p role="status" className="text-xs text-muted-foreground">
            {copied}
          </p>
        ) : null}
      </PageHeader>
      <RestoredNote draft={draft} />
      <Group title="Health">
        <HealthCard form={form} check={check} running={running} onCheck={runCheck} id={healthId} />
      </Group>
      <InUseCard state={form.state} config={form.config} />
      <FieldCards form={form} groups={groups} forced={forced} />
      <HostsSection form={form} forced={forced} onRemove={setRemovingHost} />
      {machine ? <DockerHostsSection /> : null}
      <GuideLine driver={driver} />
      <SaveBar
        draft={draft}
        unplaced={unplacedProblems(draft, placedPaths(form, fields))}
        actions={
          <Button type="button" variant="outline" size="sm" className="h-7" aria-disabled={running || undefined} onClick={() => !running && runCheck()}>
            {running ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
            {running ? "Checking…" : "Check"}
          </Button>
        }
      />
      {renaming ? <RenameDialog open label={config.label ?? ""} id={config.id} driverLabel={driver.label} onCancel={() => setRenaming(false)} onSave={(name) => {
        setRenaming(false);
        void instant.run(writes.backendLabel(draft.latest, config, name, `The name of ${label}`));
      }} /> : null}
      <RemoveBackendDialog open={removing} id={config.id} label={label} secrets={secretsSet(driver, config)} onCancel={() => setRemoving(false)} onConfirm={remove} />
      <RemoveHostDialog
        name={removingHost}
        rowOf={(name) => hostPath(config.id, name)}
        noun={config.type === "tart" ? "Mac" : "host"}
        backend={label}
        onCancel={() => setRemovingHost(null)}
        onConfirm={(name) => {
          setRemovingHost(null);
          draft.set(hostPath(config.id, name), { kind: "removed" });
        }}
      />
    </div>
  );
}
