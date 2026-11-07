import { useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Preset } from "../core/sizes.ts";
import type { ConfigState, KindInfoView } from "../plugin/configuration.ts";
import { Badge, isArm64Badge, KindBadges, lacksDocker, StatusDot } from "./common.tsx";
import { runsWayland } from "./boxes-filter.ts";
import { effectiveKind, PRESET_NAMES, warmShortWords } from "./config.ts";
import { switchKey, useSettings } from "./settings-context.tsx";
import { describedBy, DraftNumberRow, unplacedProblems } from "./settings-draft-fields.tsx";
import { KindSwitch, kindPart, MAKES_TONES, MAKES_WORDS, NO_WARM_WORDS, runsOn, sparesWords, useKindSwitch, type RunsOn } from "./settings-kinds.tsx";
import { Card, FOCUS_RING, Group, NotHere, PageHeader, ProviderGlyph, RowControl, RowNote, Rows, SavedTick, StateLine, TextLink } from "./settings-parts.tsx";
import { backendFieldPath, kindPath, plain, sizeName, sizePath, sizeRowPath, SIZE_PARTS, storedProblemPath, warmPath, type Path, type PlainValue, type SizeName, type SizePart } from "./settings-paths.ts";
import { ChangedChip, ConflictNote, focusAfterRender, RestoredNote, SAVING_RULE, SaveBar, saveOnEnter, useDraft, type Draft } from "./settings-saving.tsx";
import { kindAvailability, kindName } from "./settings-status.ts";
import { KindGpuCard } from "./settings-gpus.tsx";
import { kindHasGpuDefault } from "./gpu-settings-words.ts";

const PART_LABELS: Readonly<Record<SizePart, string>> = { cores: "Cores", memoryGiB: "Memory, GiB", diskGiB: "Disk, GiB" };
const PART_NAMES: Readonly<Record<SizePart, string>> = { cores: "cores", memoryGiB: "memory, in GiB", diskGiB: "disk, in GiB" };

function storedProblems(state: ConfigState, id: string): ReadonlyMap<Path, string> {
  const found = new Map<Path, string>();
  for (const problem of state.problems) {
    if (!problem.path.startsWith(`kinds.${id}.`) && !/^backends\.[^.]+\.warm\./.test(problem.path)) continue;
    const path = storedProblemPath(state, problem.path);
    if (!found.has(path)) found.set(path, problem.message);
  }
  return found;
}

function useProblems(draft: Draft, id: string) {
  const stored = storedProblems(draft.latest, id);
  return (path: Path) => draft.problem(path) ?? stored.get(path) ?? null;
}

function shownSize(part: SizePart) {
  return (value: PlainValue) => {
    if (value === null || value === "") return part === "diskGiB" ? "the image's own" : "empty";
    return part === "cores" ? String(value) : `${value} GiB`;
  };
}

function withName(name: string, message: string): string {
  const lowered = /^[A-Z][a-z]/.test(message) ? message[0]!.toLowerCase() + message.slice(1) : message;
  return `${name}: ${lowered}`;
}

function ConflictsAt({ draft, paths, label }: { draft: Draft; paths: readonly Path[]; label: (path: Path) => string }) {
  return (
    <>
      {paths.map((path) => {
        const conflict = draft.conflict(path);
        if (!conflict) return null;
        const part = SIZE_PARTS.find((each) => path.endsWith(`/${each}`)) ?? "cores";
        return (
          <div key={path}>
            <p className="mt-2 text-xs text-muted-foreground">{label(path)}</p>
            <ConflictNote
              conflict={conflict}
              shown={shownSize(part)}
              onTheirs={() => {
                draft.forget(path);
                focusAfterRender(path);
              }}
              onMine={() => {
                draft.keepMine(path);
                focusAfterRender(path);
              }}
            />
          </div>
        );
      })}
    </>
  );
}

function SizeCell({ draft, id, size, part, describe, invalid }: { draft: Draft; id: string; size: SizeName; part: SizePart; describe?: string; invalid: boolean }) {
  const path = sizePath(id, size, part);
  const name = sizeName(size);
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-2xs text-subtle-foreground sm:sr-only">{PART_LABELS[part]}</span>
      <Input
        data-draft-path={path}
        aria-label={`${name} size: ${PART_NAMES[part]}`}
        aria-describedby={describe}
        aria-invalid={invalid || undefined}
        className={cn("h-8 w-full min-w-0 text-right text-xs tabular-nums", draft.changed(path) && "border-warning/60")}
        inputMode="decimal"
        autoComplete="off"
        placeholder={part === "diskGiB" && size !== "largest" ? "Image's own" : undefined}
        value={draft.text(path)}
        onChange={(event) => draft.set(path, plain(event.target.value))}
        onKeyDown={saveOnEnter(draft)}
      />
    </label>
  );
}

function DefaultRadio({ draft, id, preset }: { draft: Draft; id: string; preset: Preset }) {
  const path = kindPath(id, "default");
  return (
    <input
      type="radio"
      name={`${id}-default-size`}
      data-draft-path={path}
      aria-label={`${sizeName(preset)} is the default size`}
      checked={draft.current(path) === preset}
      onChange={() => draft.set(path, plain(preset))}
      onKeyDown={saveOnEnter(draft)}
      className={cn("size-3.5 cursor-pointer accent-foreground", FOCUS_RING)}
    />
  );
}

function SizeRow({ draft, id, size, problemAt }: { draft: Draft; id: string; size: SizeName; problemAt: (path: Path) => string | null }) {
  const errorId = useId();
  const name = sizeName(size);
  const row = sizeRowPath(id, size);
  const cells = SIZE_PARTS.map((part) => sizePath(id, size, part));
  const problems = [row, ...cells].map((path) => problemAt(path)).filter((problem): problem is string => problem !== null);
  const conflicted = cells.filter((path) => draft.conflict(path));
  const defaultPath = kindPath(id, "default");
  const preset = size === "largest" ? null : size;
  const changed = cells.some((path) => draft.changed(path)) || (preset !== null && draft.changed(defaultPath) && draft.current(defaultPath) === preset);
  return (
    <div className="-mx-2 px-2 py-2" data-setting-row={row}>
      <div className="grid grid-cols-3 items-end gap-2 sm:grid-cols-[6rem_repeat(3,minmax(0,1fr))_4rem] sm:items-center">
        <span className="col-span-2 row-start-1 flex flex-wrap items-center gap-1.5 sm:col-span-1">
          <span className="text-sm text-foreground">{name}</span>
          <ChangedChip show={changed && !conflicted.length} />
        </span>
        {SIZE_PARTS.map((part) => {
          const path = sizePath(id, size, part);
          const invalid = problemAt(path) !== null || problemAt(row) !== null;
          return (
            <span key={part} className="row-start-2 sm:row-start-1">
              <SizeCell draft={draft} id={id} size={size} part={part} invalid={invalid} describe={invalid ? errorId : undefined} />
            </span>
          );
        })}
        {preset ? (
          <label className="col-start-3 row-start-1 flex cursor-pointer items-center justify-end gap-1.5 text-2xs text-muted-foreground sm:col-start-5 sm:justify-center">
            <DefaultRadio draft={draft} id={id} preset={preset} />
            <span className="sm:sr-only">Default</span>
          </label>
        ) : null}
      </div>
      {problems.length ? (
        <p id={errorId} role="alert" className="mt-1 text-xs leading-snug text-destructive-text">
          {problems.map((problem) => withName(name, problem)).join(" ")}
        </p>
      ) : null}
      <ConflictsAt draft={draft} paths={conflicted} label={(path) => `${name} ${PART_NAMES[SIZE_PARTS.find((part) => path.endsWith(`/${part}`)) ?? "cores"]}`} />
    </div>
  );
}

function SizesCard({ draft, id, problemAt }: { draft: Draft; id: string; problemAt: (path: Path) => string | null }) {
  return (
    <Group title="Sizes" description="A box asks for small, medium or large, or a custom size up to the largest. An empty disk keeps the image's own.">
      <Card className="px-4 py-2">
        <div role="radiogroup" aria-label="Default size">
          <div className="hidden grid-cols-[6rem_repeat(3,minmax(0,1fr))_4rem] gap-2 pt-1 sm:grid" aria-hidden>
            <span />
            {SIZE_PARTS.map((part) => (
              <span key={part} className="text-right text-2xs text-subtle-foreground">
                {PART_LABELS[part]}
              </span>
            ))}
            <span className="text-center text-2xs text-subtle-foreground">Default</span>
          </div>
          {PRESET_NAMES.map((preset) => (
            <SizeRow key={preset} draft={draft} id={id} size={preset} problemAt={problemAt} />
          ))}
        </div>
        <div className="border-t border-border">
          <SizeRow draft={draft} id={id} size="largest" problemAt={problemAt} />
        </div>
      </Card>
    </Group>
  );
}

function WarmField({ draft, row, kind, problem, describe }: { draft: Draft; row: RunsOn; kind: string; problem: string | null; describe?: string }) {
  const path = warmPath(row.config.id, kind);
  return (
    <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
      Warm
      <Input
        data-draft-path={path}
        aria-label={`Warm boxes on ${row.label}`}
        aria-describedby={describe}
        aria-invalid={problem ? true : undefined}
        className={cn("h-8 w-16 text-right text-xs tabular-nums", draft.changed(path) && "border-warning/60")}
        inputMode="numeric"
        autoComplete="off"
        placeholder="0"
        value={draft.text(path)}
        onChange={(event) => draft.set(path, plain(event.target.value))}
        onKeyDown={saveOnEnter(draft)}
      />
    </label>
  );
}

function RunsOnRow({ draft, row, info, problemAt }: { draft: Draft; row: RunsOn; info: KindInfoView; problemAt: (path: Path) => string | null }) {
  const { nav } = useSettings();
  const ids = useId();
  const path = warmPath(row.config.id, info.id);
  const problem = problemAt(path);
  const stored = draft.stored(path);
  const counted = typeof stored === "number" && stored > 0;
  const showsField = row.keepsWarm || counted || draft.edit(path) !== null;
  const rowKey = `runs-on-${row.config.id}`;
  const shortId = `${ids}-short`;
  const problemId = `${ids}-problem`;
  const noteId = `${ids}-note`;
  const chipsId = `${ids}-chips`;
  const conflict = draft.conflict(path);
  const openSharedHosts = () => nav.go({ page: "backend", id: row.config.id }, `${rowKey}-shared`, row.sharedIosField ? backendFieldPath(row.config.id, row.sharedIosField) : undefined);
  return (
    <div className="px-4 py-3" data-setting-row={path}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <ProviderGlyph type={row.config.type} className="mt-0.5" />
        <div className="min-w-0 flex-1 basis-48">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <button type="button" data-row-key={rowKey} aria-describedby={row.chip || row.bbMachine ? chipsId : undefined} onClick={() => nav.go({ page: "backend", id: row.config.id }, rowKey)} className={cn("min-w-0 cursor-pointer truncate rounded-sm text-left text-sm text-foreground underline-offset-2 hover:underline", FOCUS_RING)}>
              {row.label}
            </button>
            <span id={chipsId} className="flex items-center gap-1.5 empty:hidden">
              {row.chip ? <Badge>{row.chip}</Badge> : null}
              {row.bbMachine ? <Badge>BB machine</Badge> : null}
            </span>
            {row.form ? <Badge>{row.form}</Badge> : null}
            <ChangedChip show={draft.changed(path) && !conflict} />
          </span>
          <StateLine className="mt-0.5" tone={MAKES_TONES[row.makes]} words={MAKES_WORDS[row.makes]} items={row.problem ? [row.problem] : []} />
        </div>
        {showsField ? <WarmField draft={draft} row={row} kind={info.id} problem={problem} describe={describedBy(row.short && shortId, problem && problemId, !row.keepsWarm && noteId)} /> : null}
      </div>
      <div className="pl-7">
        {row.short ? (
          <p id={shortId} className="mt-1 text-xs leading-snug text-warning-text">
            {warmShortWords(row.short)}
          </p>
        ) : null}
        {!row.keepsWarm && row.noWarm ? (
          <p id={noteId} className={cn("mt-1 text-xs leading-snug", counted ? "text-warning-text" : "text-subtle-foreground")}>
            {NO_WARM_WORDS[row.noWarm]}
            {counted ? " This count does nothing here: set it to 0." : null}
            {row.noWarm === "shared-ios-hosts" ? (
              <>
                {" "}
                <TextLink onClick={openSharedHosts}>Open its shared iOS hosts</TextLink>
              </>
            ) : null}
          </p>
        ) : null}
        {problem ? (
          <p id={problemId} role="alert" className="mt-1 text-xs leading-snug text-destructive-text">
            {problem}
          </p>
        ) : null}
      </div>
      {conflict ? (
        <ConflictNote
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

function GoneRows({ draft, listed }: { draft: Draft; listed: readonly Path[] }) {
  const gone = [...draft.entry.edits.keys()].filter((path) => path.startsWith("backends/") && !listed.includes(path));
  return (
    <>
      {gone.map((path) => (
        <div key={path} role="status" className="flex flex-wrap items-center gap-3 px-4 py-3 text-xs">
          <span className="min-w-0 flex-1 text-foreground">{path.split("/")[1]} was removed elsewhere while you edited its warm boxes.</span>
          <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => draft.forget(path)}>
            Forget my count
          </Button>
        </div>
      ))}
    </>
  );
}

function WhereItRuns({ draft, info, rows, problemAt }: { draft: Draft; info: KindInfoView; rows: readonly RunsOn[]; problemAt: (path: Path) => string | null }) {
  const { state, nav } = useSettings();
  const makers = info.drivers.map((type) => state.drivers.find((driver) => driver.type === type)?.label ?? type);
  return (
    <Group title="Where it runs" description="A new box goes to the first backend in this list with room. Warm boxes wait ready there, so a new box takes a second; each holds its memory.">
      <Card>
        <Rows>
          {rows.map((row) => (
            <RunsOnRow key={row.config.id} draft={draft} row={row} info={info} problemAt={problemAt} />
          ))}
          <GoneRows draft={draft} listed={rows.map((row) => warmPath(row.config.id, info.id))} />
        </Rows>
        {rows.length ? null : (
          <p className="px-4 py-3 text-xs leading-snug text-subtle-foreground">
            No backend you have makes it.{makers.length ? ` ${makers.join(" or ")} ${makers.length === 1 ? "does" : "do"}.` : ""}{" "}
            <TextLink onClick={() => nav.go({ page: "add" }, "kind-add-backend")}>Add a backend</TextLink>
          </p>
        )}
      </Card>
    </Group>
  );
}

function SparesCard({ draft, info }: { draft: Draft; info: KindInfoView }) {
  const target = effectiveKind(draft.latest, info.id).spares;
  const now = sparesWords(target, info.spares);
  const making = target > 0 && info.spares.ready < target && info.spares.making > 0;
  return (
    <Group title="Spare boxes" description="Made ahead and added to BB as machines, so a thread gets one of the default size, with its access, at once.">
      <Card>
        <DraftNumberRow
          draft={draft}
          path={kindPath(info.id, "spares")}
          label="Spares to keep"
          description={info.device ? "Off by default for device kinds: each spare waits with its device booted and its memory saved to disk. 0 keeps none." : "Each spare waits as a whole box, holding its memory or, stopped, its disk. 0 keeps none."}
        />
        {now.length ? (
          <p className="flex items-center gap-1.5 border-t border-border px-4 py-2 text-xs text-muted-foreground">
            <StatusDot tone={making ? "busy" : "ok"} />
            {now.join(" · ")}
          </p>
        ) : null}
      </Card>
    </Group>
  );
}

function placedPaths(id: string, rows: readonly RunsOn[]): Path[] {
  const sizes: SizeName[] = [...PRESET_NAMES, "largest"];
  return [
    ...sizes.flatMap((size) => [sizeRowPath(id, size), ...SIZE_PARTS.map((part) => sizePath(id, size, part))]),
    kindPath(id, "default"),
    kindPath(id, "spares"),
    ...rows.map((row) => warmPath(row.config.id, id)),
  ];
}

function DefaultNote({ isDefault, enabled, noteId }: { isDefault: boolean; enabled: boolean; noteId: string }) {
  const { nav } = useSettings();
  if (!isDefault) return null;
  const choose = (words: string) => <TextLink onClick={() => nav.go({ page: "option", id: "boxes" }, "choose-default", "general/defaultKind")}>{words}</TextLink>;
  if (enabled) {
    return (
      <p id={noteId} className="text-xs leading-snug text-subtle-foreground">
        The default kind stays on. {choose("Choose another default")} to turn it off.
      </p>
    );
  }
  return (
    <p id={noteId} role="alert" className="text-xs leading-snug text-destructive-text">
      This is the default kind, but it is off, so a thread that names no kind gets no box. Turn it on, or {choose("choose another default")}.
    </p>
  );
}

function KindStateLine({ state, info, enabled, rows }: { state: ConfigState; info: KindInfoView; enabled: boolean; rows: readonly RunsOn[] }) {
  if (!enabled) return <StateLine tone="off" words="Off: no new boxes" items={["boxes it made keep working"]} />;
  const availability = kindAvailability(state, info.id);
  if (availability === "lost") return <StateLine tone="warn" words="Not offered now: its backends cannot make it" />;
  if (availability !== "none") return null;
  if (rows.length && rows.every((row) => row.makes === "off")) return <StateLine tone="off" words="Not offered: its backends are off" />;
  return <StateLine tone="off" words={rows.length ? "Not offered: its backends do not make it now" : "No backend you have makes it"} />;
}

export function KindPage({ id }: { id: string }) {
  const { state } = useSettings();
  const info = state.kinds.find((kind) => kind.id === id);
  if (!info) return <NotHere what="kind" />;
  return <KindEditor key={id} info={info} />;
}

function KindEditor({ info }: { info: KindInfoView }) {
  const { instant, writes } = useSettings();
  const kind = useKindSwitch(info);
  const draft = useDraft(kindPart(info.id), kind.name);
  const latest = draft.latest;
  const problemAt = useProblems(draft, info.id);
  const rows = runsOn(latest, info);
  const noteId = useId();
  const switchRef = useRef<HTMLButtonElement>(null);
  const defaultKey = switchKey.general("defaultKind");
  const forms = [...new Set(rows.filter((row) => row.makes === "makes").map((row) => row.form).filter((form): form is NonNullable<typeof form> => form !== null))];
  const makeDefault = () =>
    void instant.run(writes.general(latest, "defaultKind", info.id, "The default kind", (value) => kindName(latest.kinds, latest.kinds.find((each) => each.id === value) ?? info))).then((outcome) => {
      if (outcome?.kind === "saved" || outcome?.kind === "already") setTimeout(() => switchRef.current?.focus(), 0);
    });
  return (
    <div className="space-y-6">
      <PageHeader
        title={kind.name}
        chips={
          <>
            <KindBadges desktop={info.desktop} wayland={runsWayland({ desktop: info.desktop, kind: info.id })} gpu={info.gpu} noDocker={lacksDocker(info)} arm64={isArm64Badge(info.os, info.arch)} forms={forms} />
            {kind.isDefault ? <Badge>Default kind</Badge> : null}
          </>
        }
        description={
          <>
            <p>{info.description}</p>
            <p className="mt-1">Saved changes reach new boxes; boxes already made keep their size.</p>
            <p className="mt-1">{SAVING_RULE}</p>
          </>
        }
        aside={
          <>
            <SavedTick show={instant.isSaved(kind.key) || instant.isSaved(defaultKey)} />
            {!kind.isDefault && kind.enabled ? (
              <Button type="button" variant="outline" size="sm" className="h-7" aria-disabled={instant.pending !== null || undefined} onClick={makeDefault}>
                Make default
              </Button>
            ) : null}
            <label className="flex items-center gap-3 text-xs text-foreground">
              Offered to threads
              <RowControl>
                <KindSwitch ref={switchRef} info={info} describedBy={kind.isDefault ? noteId : undefined} />
              </RowControl>
            </label>
          </>
        }
      >
        <KindStateLine state={latest} info={info} enabled={kind.enabled} rows={rows} />
        <DefaultNote isDefault={kind.isDefault} enabled={kind.enabled} noteId={noteId} />
        <RowNote note={instant.note(kind.key)} />
        <RowNote note={instant.note(defaultKey)} />
      </PageHeader>
      <RestoredNote draft={draft} />
      <SizesCard draft={draft} id={info.id} problemAt={problemAt} />
      <WhereItRuns draft={draft} info={info} rows={rows} problemAt={problemAt} />
      <SparesCard draft={draft} info={info} />
      {kindHasGpuDefault(latest, info.id) ? <KindGpuCard kind={info.id} /> : null}
      <p className="px-1 text-xs leading-snug text-subtle-foreground">Sizes, the default size, warm boxes and spares are saved together with Save.</p>
      <SaveBar draft={draft} unplaced={unplacedProblems(draft, placedPaths(info.id, rows))} />
    </div>
  );
}
