import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useState, type ReactNode } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ImageBake, ImageConfig } from "../core/document.ts";
import type { ConfigState } from "../plugin/configuration.ts";
import type { Contract, ImageFailure, ImagesStatus } from "../plugin/contract.ts";
import type { RunProgress } from "../plugin/images.ts";
import type { ImageOptionView } from "../plugin/views.ts";
import { Badge, message, relativeTime, useLive, type Tone } from "./common.tsx";
import { RebuildNow, RUN_TONE, isRunning, stateWords, type RunImage } from "./rebuild-now.tsx";
import { switchKey, useSettings } from "./settings-context.tsx";
import { Card, FOCUS_RING, Group, RowNote, Rows, SavedTick, StateLine } from "./settings-parts.tsx";
import { imageBakePath, type PlainValue } from "./settings-paths.ts";
import { backendLabel, hostChip, kindName, plural, type StatusItem } from "./settings-status.ts";

type StandardImage = ImagesStatus["images"][number];
type ImagesProgress = Pick<ImagesStatus, "progress" | "running" | "failures">;

export const BAKE_WORDS: Readonly<Record<ImageBake, string>> = {
  auto: "Built when used often",
  always: "Always built ahead",
  never: "Run at each box's start",
};

const BAKES = Object.keys(BAKE_WORDS) as ImageBake[];

const RUN_COUNT_WORDS: Readonly<Record<RunImage["state"], string>> = {
  next: "next",
  refreshing: "rebuilding",
  refreshed: "rebuilt",
  failed: "failed",
  waiting: "waited for room",
  skipped: "skipped",
  "not started": "not started",
};

export function useImagesProgress(): ImagesProgress | null {
  const rpc = useRpc<Contract>();
  return useLive<ImagesProgress>("images-progress", () => rpc.call("images.progress"), () => true).value;
}

function kindWords(state: ConfigState, kind: string | null): string | null {
  if (!kind) return null;
  const info = state.kinds.find((candidate) => candidate.id === kind);
  return info ? kindName(state.kinds, info) : kind;
}

function backendWords(state: ConfigState, id: string): string {
  const config = state.document.backends.find((backend) => backend.id === id);
  if (!config) return id;
  const label = backendLabel(state, config);
  const sharesItsLabel = state.document.backends.some((other) => other.id !== id && backendLabel(state, other) === label);
  const chip = sharesItsLabel ? hostChip(config, label) : null;
  return chip ? `${label} (${chip})` : label;
}

function bakeWords(value: PlainValue): string {
  return (BAKE_WORDS[value as ImageBake] ?? String(value)).toLowerCase();
}

function failureItem(state: ConfigState, failure: ImageFailure, now: number): StatusItem {
  const kind = kindWords(state, failure.kind);
  const backend = backendWords(state, failure.backend);
  const when = relativeTime(failure.at, now);
  if (failure.of === "project") {
    return {
      key: `image-build-${failure.name}-${failure.backend}-${failure.kind}`,
      tone: "warn",
      title: `The image ${failure.name} did not build for ${kind} on ${backend}`,
      detail: `Failed ${when}: ${failure.reason} Its boxes run its script as they start meanwhile.`,
      fix: `Fix its script, then set the image again with bb box image set ${failure.name}.`,
      open: { page: "option", id: "images" },
    };
  }
  return {
    key: `image-rebuild-${failure.name}`,
    tone: "warn",
    title: `${kind ? `The ${kind} image` : `The image ${failure.name}`} on ${backend} did not rebuild`,
    detail: `Failed ${when}: ${failure.reason} New boxes start from its last build meanwhile.`,
    fix: `Fix the cause, then Try again on the Images page, or run bb box images build ${failure.name}.`,
    open: { page: "option", id: "images" },
  };
}

export function imageStatusItems(state: ConfigState, progress: ImagesProgress | null, now: number): StatusItem[] {
  return (progress?.failures ?? []).map((failure) => failureItem(state, failure, now));
}

export function failedImagesWords(progress: ImagesProgress | null): string | null {
  const failures = progress?.failures.length ?? 0;
  return failures ? `${failures} failed` : null;
}

interface StandardRow {
  readonly name: string;
  readonly kind: string;
  readonly backend: string;
  readonly image: StandardImage | null;
  readonly run: RunImage | null;
}

function standardRows(list: readonly StandardImage[], progress: RunProgress | null): StandardRow[] {
  const ran = new Map((progress?.images ?? []).map((image) => [image.name, image]));
  const rows: StandardRow[] = list.map((image) => ({ name: image.name, kind: image.kind, backend: image.backend, image, run: ran.get(image.name) ?? null }));
  for (const run of progress?.images ?? []) {
    if (!list.some((image) => image.name === run.name)) rows.push({ name: run.name, kind: run.kind, backend: run.name.slice(0, run.name.indexOf("/")), image: null, run });
  }
  return rows;
}

function rowState(row: StandardRow, now: number): { readonly tone: Tone; readonly words: string; readonly saysWhyDue: boolean } {
  if (row.run) return { tone: RUN_TONE[row.run.state], words: stateWords(row.run), saysWhyDue: false };
  const image = row.image;
  const outcome = image?.outcome ?? null;
  if (outcome?.state === "failed") return { tone: "bad", words: `Its last rebuild failed ${relativeTime(outcome.at, now)}: ${outcome.reason ?? "no reason given"}`, saysWhyDue: false };
  if (outcome?.state === "waiting") return { tone: "warn", words: `Its last rebuild waited ${relativeTime(outcome.at, now)}: ${outcome.reason ?? "no room"}`, saysWhyDue: false };
  if (image?.due) return { tone: "warn", words: `Due: ${image.due}`, saysWhyDue: true };
  const ageUnknown = !image || image.built === "no record";
  return { tone: "ok", words: outcome?.state === "refreshed" && ageUnknown ? `Up to date, rebuilt ${relativeTime(outcome.at, now)}` : "Up to date", saysWhyDue: false };
}

function failedLast(row: StandardRow): boolean {
  if (row.run?.state === "refreshed") return false;
  return row.run?.state === "failed" || row.image?.outcome?.state === "failed";
}

function TryAgain({ name, label, running, onStarted }: { name: string; label: string; running: boolean; onStarted: () => void }) {
  const rpc = useRpc<Contract>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const start = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const answer = await rpc.call("images.build", { image: name });
      if (answer.started) onStarted();
      else setProblem(answer.message);
    } catch (caught) {
      setProblem(message(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button type="button" variant="outline" size="sm" className="h-7 shrink-0" aria-label={`Try ${label} again`} disabled={busy || running} onClick={() => void start()}>
        {busy ? <Icon name="Loading" className="animate-spin" aria-hidden /> : <Icon name="ArrowReloadHorizontal" aria-hidden />}
        Try again
      </Button>
      {problem ? (
        <p role="alert" className="basis-full text-xs leading-snug text-destructive-text">
          {problem}
        </p>
      ) : null}
    </>
  );
}

function StandardImageRow({ row, now, running, onStarted }: { row: StandardRow; now: number; running: boolean; onStarted: () => void }) {
  const { state } = useSettings();
  const { tone, words, saysWhyDue } = rowState(row, now);
  const kind = kindWords(state, row.kind) ?? row.kind;
  const backend = backendWords(state, row.backend);
  const items: ReactNode[] = [];
  if (row.image?.built) items.push(<span key="built">{row.image.built}</span>);
  if (row.image?.due && !saysWhyDue) items.push(<span key="due">due: {row.image.due}</span>);
  items.push(
    <code key="name" className="font-mono text-2xs text-subtle-foreground">
      {row.name}
    </code>,
  );
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5" data-image-row={row.name}>
      <div className="min-w-0 flex-1 basis-60">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm text-foreground">
          <span>{kind}</span>
          <span className="text-xs text-muted-foreground">on {backend}</span>
        </p>
        <StateLine tone={tone} words={words} items={items} className="mt-0.5 [&_span]:break-words" />
      </div>
      {failedLast(row) && row.image ? <TryAgain name={row.name} label={`the ${kind} image on ${backend}`} running={running} onStarted={onStarted} /> : null}
    </div>
  );
}

function lastRunWords(progress: RunProgress | null, now: number): string | null {
  if (!progress) return null;
  if (isRunning(progress)) return "A rebuild is going on.";
  const counts = new Map<RunImage["state"], number>();
  for (const image of progress.images) counts.set(image.state, (counts.get(image.state) ?? 0) + 1);
  const parts = (["refreshed", "waiting", "failed", "skipped", "not started"] as const).filter((each) => counts.get(each)).map((each) => `${counts.get(each)} ${RUN_COUNT_WORDS[each]}`);
  const ended = `The last rebuild ended ${relativeTime(progress.ended ?? now, now)}`;
  return parts.length ? `${ended}: ${parts.join(", ")}.` : `${ended}, with nothing to rebuild.`;
}

function StandardImages({ nightly }: { nightly: ReactNode }) {
  const rpc = useRpc<Contract>();
  const live = useImagesProgress();
  const progress = live?.progress ?? null;
  const ended = progress?.ended ?? null;
  const [list, setList] = useState<readonly StandardImage[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  const now = Date.now();
  useEffect(() => {
    let current = true;
    rpc.call("images.list").then(
      (answer) => {
        if (!current) return;
        setList(answer.images);
        setProblem(null);
      },
      (caught: unknown) => current && setProblem(message(caught)),
    );
    return () => {
      current = false;
    };
  }, [rpc, ended, asked]);
  const rows = list ? standardRows(list, progress) : [];
  const due = list?.filter((image) => image.due).length ?? 0;
  const summary = list === null ? (problem ?? "Reading the images…") : !rows.length ? "No backend that is on has images BB Box rebuilds." : [`${due} of ${plural(rows.length, "image")} due.`, lastRunWords(progress, now)].filter(Boolean).join(" ");
  return (
    <Group title="Standard images" description={summary}>
      <Card>
        <Rows>
          {nightly}
          {rows.map((row) => (
            <StandardImageRow key={row.name} row={row} now={now} running={isRunning(progress)} onStarted={() => setAsked((count) => count + 1)} />
          ))}
          {list !== null && rows.length ? <RebuildNow progress={progress} due={due} onStarted={() => setAsked((count) => count + 1)} /> : null}
        </Rows>
      </Card>
    </Group>
  );
}

function buildsWords(state: ConfigState, image: ImageConfig, view: ImageOptionView | null): { readonly tone: Tone; readonly words: string } {
  const failed = view?.failed ?? [];
  const builds = view?.builds ?? [];
  if (failed.length) {
    const first = failed[0]!;
    return { tone: "warn", words: `Its build for ${kindWords(state, first.kind)} on ${backendWords(state, first.backend)} failed${failed.length > 1 ? `, and ${plural(failed.length - 1, "other")}` : ""}` };
  }
  if ((image.bake ?? "auto") === "never") return { tone: "off", words: "Its script runs as each box starts" };
  if (builds.length) return { tone: "ok", words: builds.length === 1 ? `Built for ${kindWords(state, builds[0]!.kind)} on ${backendWords(state, builds[0]!.backend)}` : `${plural(builds.length, "build")} ready` };
  return { tone: "off", words: image.bake === "always" ? "Not built yet" : "Not built yet: it is built once two boxes use it within 14 days" };
}

function rowId(name: string): string {
  return `settings-image-${name}`;
}

const READING_BUILDS = "Reading its builds…";

function ProjectImageRow({ name, image, view, loaded, open, onToggle, onRemove }: { name: string; image: ImageConfig; view: ImageOptionView | null; loaded: boolean; open: boolean; onToggle: () => void; onRemove: () => void }) {
  const { state, instant, writes } = useSettings();
  const now = Date.now();
  const id = rowId(name);
  const bakeKey = switchKey.imageBake(name);
  const pendingBake = instant.pendingValue<ImageBake>(bakeKey);
  const bake = pendingBake ?? image.bake ?? "auto";
  const projects = loaded ? (view?.projects ?? image.projects.map((project) => ({ id: project, name: project }))) : [];
  const kinds = image.kinds.map((kind) => kindWords(state, kind) ?? kind);
  const line = loaded ? buildsWords(state, image, view) : { tone: "off" as const, words: READING_BUILDS };
  return (
    <div data-project-image={name} data-setting-row={imageBakePath(name)}>
      <div className="relative flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 transition-colors duration-150 hover:bg-state-hover">
        <button type="button" data-row-key={`image-${name}`} aria-label={name} aria-describedby={`${id}-projects ${id}-line`} aria-expanded={open} aria-controls={open ? `${id}-details` : undefined} onClick={onToggle} className={cn("absolute inset-0 cursor-pointer", FOCUS_RING)} />
        <span className="pointer-events-none min-w-0 flex-1 basis-48">
          <span className="flex flex-wrap items-center gap-1.5 text-sm text-foreground">
            <span aria-hidden>{name}</span>
            <span id={`${id}-projects`} className="flex flex-wrap items-center gap-1.5">
              {projects.length ? <span className="sr-only">For </span> : null}
              {projects.map((project) => (
                <Badge key={project.id}>{project.name}</Badge>
              ))}
            </span>
          </span>
          <StateLine id={`${id}-line`} tone={line.tone} words={line.words} items={[<span key="kinds">{inWords(kinds)}</span>]} className="mt-0.5" />
        </span>
        <span className="pointer-events-none">
          <SavedTick show={instant.isSaved(bakeKey)} />
        </span>
        <span className="relative z-10 shrink-0">
          <Select value={bake} onValueChange={(next) => void instant.run(writes.imageBake(state, name, next as ImageBake, bakeWords))}>
            <SelectTrigger className="h-7 w-48 text-xs" data-draft-path={imageBakePath(name)} aria-label={`When ${name} is built ahead`} aria-disabled={instant.pending !== null || undefined}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BAKES.map((each) => (
                <SelectItem key={each} value={each} className="text-xs">
                  {BAKE_WORDS[each]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </span>
        <span className="pointer-events-none flex size-4 shrink-0 items-center">
          <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-4 text-subtle-foreground" aria-hidden />
        </span>
      </div>
      <RowNote note={instant.note(bakeKey) ?? instant.note(switchKey.removeImage(name))} className="px-4 pb-2" />
      {open ? <ProjectImageDetails id={`${id}-details`} name={name} image={image} view={view} loaded={loaded} now={now} onRemove={onRemove} /> : null}
    </div>
  );
}

function Script({ label, named, text }: { label: string; named: string; text: string }) {
  return (
    <div className="space-y-1">
      <p className="text-2xs font-medium text-subtle-foreground">{label}</p>
      <pre tabIndex={0} aria-label={named} className={cn("max-h-56 overflow-auto rounded-md bg-surface-recessed px-3 py-2 font-mono text-2xs leading-relaxed text-foreground", FOCUS_RING)}>
        {text.trimEnd()}
      </pre>
    </div>
  );
}

function sourceWords(image: ImageConfig, now: number): string {
  const files = [image.source?.script, image.source?.check].filter((file): file is string => !!file);
  const from = files.length ? `From ${files.join(" and ")} in the project's repository` : "Set by hand";
  const updated = image.updated ? Date.parse(image.updated) : NaN;
  return Number.isFinite(updated) ? `${from}, set ${relativeTime(updated, now)}.` : `${from}.`;
}

function ProjectImageDetails({ id, name, image, view, loaded, now, onRemove }: { id: string; name: string; image: ImageConfig; view: ImageOptionView | null; loaded: boolean; now: number; onRemove: () => void }) {
  const { state, instant } = useSettings();
  const builds = view?.builds ?? [];
  const failed = view?.failed ?? [];
  return (
    <div id={id} className="space-y-3 border-t border-border bg-surface-raised px-4 py-3">
      <p className="text-xs leading-snug text-muted-foreground">{sourceWords(image, now)}</p>
      {builds.length || failed.length ? (
        <ul className="space-y-1 text-xs leading-snug">
          {builds.map((build) => (
            <li key={`${build.backend}-${build.kind}`} className="text-muted-foreground">
              <StateLine tone="ok" words={`Built for ${kindWords(state, build.kind)} on ${backendWords(state, build.backend)}`} items={[`${build.build ?? "a build"}, ${relativeTime(Date.parse(build.built), now)}`]} />
            </li>
          ))}
          {failed.map((failure) => (
            <li key={`failed-${failure.backend}-${failure.kind}`}>
              <StateLine tone="warn" words={`Its build for ${kindWords(state, failure.kind)} on ${backendWords(state, failure.backend)} failed ${relativeTime(failure.at, now)}: ${failure.reason}`} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs leading-snug text-subtle-foreground">{loaded ? "No build of it yet, so its boxes run its script as they start." : READING_BUILDS}</p>
      )}
      <Script label="Script, run as root" named={`Script of ${name}, run as root`} text={image.script} />
      {image.check ? <Script label="Check, run as the box user; the image fails when it fails" named={`Check of ${name}, run as the box user`} text={image.check} /> : <p className="text-xs text-subtle-foreground">No check: the image passes when its script does.</p>}
      <div className="flex justify-end">
        <Button type="button" variant="ghost" size="sm" className="h-7 text-muted-foreground" data-remove-image={name} disabled={instant.pending !== null} onClick={onRemove}>
          <Icon name="Trash2" aria-hidden />
          Remove {name}…
        </Button>
      </div>
    </div>
  );
}

function focusAfterRemoval(names: readonly string[], removed: string): void {
  const at = names.indexOf(removed);
  const next = names[at + 1] ?? names[at - 1] ?? null;
  requestAnimationFrame(() => {
    const target = next ? document.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(`image-${next}`)}"]`) : document.querySelector<HTMLElement>("[data-project-images-heading]");
    target?.focus();
  });
}

function inWords(names: readonly string[]): string {
  return names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function RemoveImageDialog({ name, image, view, onCancel, onConfirm }: { name: string | null; image: ImageConfig | null; view: ImageOptionView | null; onCancel: () => void; onConfirm: (name: string) => void }) {
  const { state } = useSettings();
  const [shown, setShown] = useState<{ name: string; image: ImageConfig; projects: readonly string[] } | null>(null);
  const projectNames = image ? image.projects.map((id) => view?.projects.find((project) => project.id === id)?.name ?? id) : [];
  if (name !== null && image && (shown?.name !== name || shown.projects.join("\n") !== projectNames.join("\n"))) setShown({ name, image, projects: projectNames });
  const kinds = shown ? inWords(shown.image.kinds.map((kind) => kindWords(state, kind) ?? kind)) : "";
  const projects = shown ? inWords(shown.projects) : "";
  return (
    <AlertDialog open={name !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          const row = shown ? document.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(`image-${shown.name}`)}"]`) : null;
          if (!row) return;
          event.preventDefault();
          row.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Remove the image {shown?.name}?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                New {kinds} boxes in {projects} start from the standard images again, without its script. Its builds are deleted.
              </p>
              <p>Boxes already made keep what they have. An agent can set it again from the project's files with bb box image set.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => shown && onConfirm(shown.name)}>
            Remove image
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ProjectImages() {
  const { state, instant, writes } = useSettings();
  const rpc = useRpc<Contract>();
  const { value: views, error: viewsProblem } = useLive<ImageOptionView[]>("project-images", () => rpc.call("images", {}), () => true);
  const loaded = views !== null || viewsProblem !== null;
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [removing, setRemoving] = useState<string | null>(null);
  const [removedNote, setRemovedNote] = useState<string | null>(null);
  const images = state.document.images ?? {};
  const names = Object.keys(images).sort((a, b) => a.localeCompare(b));
  const toggle = (name: string) => setOpen((current) => (current.has(name) ? new Set([...current].filter((each) => each !== name)) : new Set([...current, name])));
  const remove = (name: string) => {
    setRemoving(null);
    setRemovedNote(null);
    const before = names;
    void instant.run(writes.removeImage(state, name)).then((outcome) => {
      if (outcome?.kind !== "saved" && outcome?.kind !== "already") return;
      setRemovedNote(`Removed the image ${name}.`);
      focusAfterRemoval(before, name);
    });
  };
  const removedElsewhere = removing !== null && !images[removing];
  return (
    <section className="space-y-2.5" aria-labelledby="settings-project-images">
      <div>
        <h3 id="settings-project-images" tabIndex={-1} data-project-images-heading className="text-xs font-medium text-foreground outline-none">
          Projects' images
        </h3>
        <p className="mt-0.5 text-xs leading-snug text-subtle-foreground">A script run as root on a kind's standard image, for the boxes of a project's threads. Agents set them with bb box image set, from the project's files.</p>
      </div>
      {names.length ? (
        <Card>
          <Rows>
            {names.map((name) => (
              <ProjectImageRow key={name} name={name} image={images[name]!} view={views?.find((view) => view.name === name) ?? null} loaded={loaded} open={open.has(name)} onToggle={() => toggle(name)} onRemove={() => setRemoving(name)} />
            ))}
          </Rows>
        </Card>
      ) : (
        <p className="rounded-lg border border-dashed border-border px-4 py-3 text-xs text-subtle-foreground">No project has an image of its own. An agent makes one from a project's files with bb box image set.</p>
      )}
      {removedNote ? (
        <p role="status" className="px-1 text-xs text-muted-foreground">
          {removedNote}
        </p>
      ) : null}
      <RemoveImageDialog name={removedElsewhere ? null : removing} image={removing ? (images[removing] ?? null) : null} view={views?.find((view) => view.name === removing) ?? null} onCancel={() => setRemoving(null)} onConfirm={remove} />
    </section>
  );
}

export function ImagesPage({ nightly }: { nightly: ReactNode }) {
  return (
    <div className="space-y-6">
      <StandardImages nightly={nightly} />
      <ProjectImages />
    </div>
  );
}
