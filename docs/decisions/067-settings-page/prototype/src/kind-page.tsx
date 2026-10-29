import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { StatusDot } from "@/src/app/common.tsx";
import { driverOf, kindOf, PRESET_LABELS, PRESETS, type Preset } from "./data";
import { availability, backendTitle, canMake, FORMS, gib, kindBadges, kindName, kindTitle } from "./model";
import { useNav } from "./nav";
import { useStore } from "./store";
import { useDraft, useInstant, type Draft } from "./drafts";
import { Badge, Card, ConflictNote, FOCUS_RING, Icon, PageHeader, ProviderGlyph, RestoredNote, Rows, SaveBar, SaveRule, SavedTick, Section, SettingRow, shown } from "./ui";

type Part = "cores" | "memoryMiB" | "diskGiB";
const PARTS: readonly { readonly part: Part; readonly label: string }[] = [
  { part: "cores", label: "Cores" },
  { part: "memoryMiB", label: "Memory, GiB" },
  { part: "diskGiB", label: "Disk, GiB" },
];

function display(part: Part, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (part === "memoryMiB" && typeof value === "number") return String(gib(value));
  return String(value);
}

function parse(part: Part, text: string): unknown {
  const trimmed = text.trim();
  if (part === "diskGiB" && !trimmed) return null;
  if (!trimmed || !Number.isFinite(Number(trimmed))) return trimmed;
  return part === "memoryMiB" ? Math.round(Number(trimmed) * 1024) : Number(trimmed);
}

function SizeCell({ draft, path, part, label, base }: { draft: Draft; path: string; part: Part; label: string; base: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const nav = useNav();
  const problem = draft.problemAt(path);
  useEffect(() => {
    if (draft.focusPath !== path && nav.found !== path) return;
    ref.current?.scrollIntoView({ block: "center" });
    ref.current?.focus({ preventScroll: true });
    if (draft.focusPath === path) draft.clearFocus();
  }, [draft.focusPath, nav.found]);
  const partLabel = PARTS.find((each) => each.part === part)!.label;
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-2xs text-subtle-foreground sm:sr-only">{partLabel}</span>
      <Input
        ref={ref}
        aria-label={`${label} ${partLabel}`}
        aria-invalid={problem ? true : undefined}
        className={cn("h-8 w-full min-w-0 text-right text-xs tabular-nums", draft.edited(path) && "border-warning/60")}
        inputMode="decimal"
        placeholder={base && part === "diskGiB" ? "Image's own" : undefined}
        value={display(part, draft.value(path))}
        onChange={(event) => draft.set(path, parse(part, event.target.value))}
      />
    </label>
  );
}

export function KindPage({ id }: { id: string }) {
  const store = useStore();
  const nav = useNav();
  const instant = useInstant();
  const info = kindOf(id);
  const kind = store.doc.kinds[id]!;
  const makers = canMake(store.doc, id);
  const isDefault = store.doc.general.defaultKind === id;
  const name = kindName(id);
  const draft = useDraft({ part: `kinds/${id}`, what: name });
  const state = availability(store.doc, store.live, id);
  const device = info.device !== null;
  const presetPath = (preset: Preset, part: Part) => `kinds/${id}/presets/${preset}/${part}`;
  const largestPath = (part: Part) => `kinds/${id}/largest/${part}`;
  const rowProblems = (paths: readonly string[]) => paths.map((path) => draft.problemAt(path)).filter(Boolean) as string[];
  const rowConflicts = (paths: readonly string[]) => paths.filter((path) => draft.conflictAt(path));
  const pendingEnabled = instant.pendingValue("enabled");
  const enabled = pendingEnabled !== undefined ? (pendingEnabled as boolean) : kind.enabled;
  const spareNow = kind.spares ? (id === "windows-desktop" && store.scenario === "problem" ? `0 of ${kind.spares} ready, 1 being made` : `${kind.spares} of ${kind.spares} ready`) : null;
  const sizeRow = (label: string, paths: Record<Part, string>, preset: Preset | null) => {
    const problems = rowProblems(Object.values(paths));
    const conflicts = rowConflicts(Object.values(paths));
    return (
      <div key={label} className="py-1.5">
        <div className="grid grid-cols-3 items-end gap-2 sm:grid-cols-[6.5rem_repeat(3,minmax(0,1fr))_4.5rem] sm:items-center">
          <div className="col-span-3 flex items-center justify-between sm:col-span-1">
            <span className="text-sm text-foreground">{label}</span>
            {preset ? (
              <label className="flex items-center gap-1.5 text-2xs text-muted-foreground sm:hidden">
                <input type="radio" name="default-size-narrow" checked={draft.value(`kinds/${id}/default`) === preset} onChange={() => draft.set(`kinds/${id}/default`, preset)} className="size-3.5 accent-foreground" />
                Default
              </label>
            ) : null}
          </div>
          {PARTS.map(({ part }) => (
            <SizeCell key={part} draft={draft} path={paths[part]} part={part} label={label} base={preset !== null} />
          ))}
          <span className="hidden justify-center sm:flex">
            {preset ? <input type="radio" name="default-size" aria-label={`${label} is the default size`} checked={draft.value(`kinds/${id}/default`) === preset} onChange={() => draft.set(`kinds/${id}/default`, preset)} className={cn("size-3.5 cursor-pointer accent-foreground", FOCUS_RING)} /> : <span className="text-2xs text-subtle-foreground">custom</span>}
          </span>
        </div>
        {problems.map((problem) => (
          <p key={problem} role="alert" className="mt-1 text-xs text-destructive-text">
            {label}: {problem}
          </p>
        ))}
        {conflicts.map((path) => (
          <ConflictNote key={path} saved={draft.conflictAt(path)!.saved} onUseSaved={() => draft.useSaved(path)} onKeepMine={() => draft.keepMine(path)} />
        ))}
      </div>
    );
  };
  return (
    <div className="space-y-6">
      <PageHeader
        title={kindTitle(id)}
        chips={
          <>
            {kindBadges(id).map((badge) => (
              <Badge key={badge}>{badge}</Badge>
            ))}
            {isDefault ? <Badge>Default kind</Badge> : null}
          </>
        }
        description={info.description}
        aside={
          <>
            <SavedTick show={instant.saved !== null} />
            {!isDefault && kind.enabled ? (
              <Button type="button" variant="ghost" size="sm" className="h-7 text-muted-foreground" disabled={instant.pending !== null} onClick={() => void instant.run("default", [["general/defaultKind", id]], name)}>
                Make default
              </Button>
            ) : null}
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Offered to threads
              <Switch aria-label={`${name}: offered to threads`} aria-describedby={isDefault ? "default-kind-note" : undefined} checked={enabled} disabled={instant.pending === "enabled" || (isDefault && kind.enabled)} onCheckedChange={(next) => void instant.run("enabled", [[`kinds/${id}/enabled`, next]], name)} />
            </label>
          </>
        }
        note={
          <div className="space-y-1">
            {isDefault && kind.enabled ? (
              <p id="default-kind-note" className="text-xs text-subtle-foreground">
                The default kind stays on.{" "}
                <button type="button" className="rounded-sm text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => nav.go({ page: "option", id: "boxes" }, { found: "general/defaultKind" })}>
                  Choose another default
                </button>{" "}
                to turn it off.
              </p>
            ) : null}
            {isDefault && !kind.enabled ? (
              <p role="alert" className="text-xs text-destructive-text">
                This is the default kind, but it is off, so a thread that names no kind gets no box. Turn it on, or choose another default.
              </p>
            ) : null}
            {instant.refused ? (
              <p role="alert" className="text-xs text-destructive-text">
                {instant.refused.message}
              </p>
            ) : null}
            {state === "lost" ? <p className="text-xs text-warning-text">Not offered now: none of its backends can make it at the moment.</p> : null}
            <p className="text-xs text-subtle-foreground">Saved changes reach new boxes; boxes already made keep their size.</p>
            <SaveRule />
          </div>
        }
      />
      <RestoredNote draft={draft} />
      <Section title="Sizes" description="A box asks for small, medium or large, or a custom size up to the largest. An empty disk keeps the image's own.">
        <Card className="px-4 py-3">
          <div role="radiogroup" aria-label="Default size" data-form>
            <div className="hidden grid-cols-[6.5rem_repeat(3,minmax(0,1fr))_4.5rem] gap-2 pb-1 sm:grid">
              <span />
              {PARTS.map(({ label }) => (
                <span key={label} className="text-right text-2xs text-subtle-foreground">
                  {label}
                </span>
              ))}
              <span className="text-center text-2xs text-subtle-foreground">Default</span>
            </div>
            {PRESETS.map((preset) => sizeRow(PRESET_LABELS[preset], { cores: presetPath(preset, "cores"), memoryMiB: presetPath(preset, "memoryMiB"), diskGiB: presetPath(preset, "diskGiB") }, preset))}
            <div className="my-1.5 border-t border-border" />
            {sizeRow("Largest", { cores: largestPath("cores"), memoryMiB: largestPath("memoryMiB"), diskGiB: largestPath("diskGiB") }, null)}
          </div>
        </Card>
      </Section>

      <Section title="Where it runs" description="A new box goes to the first backend in this list with room. Warm boxes wait ready there, so a new box takes a second; each holds its memory.">
        <Card>
          <Rows>
            {makers.length ? (
              makers.map((backend) => {
                const live = store.live[backend.id];
                const offers = live?.offers.includes(id) ?? false;
                const path = `backends/${backend.id}/warm/${id}`;
                const short = live?.warmShort?.find((each) => each.kind === id);
                const conflict = draft.conflictAt(path);
                return (
                  <div key={backend.id} className="px-4 py-2.5" data-form>
                    <div className="flex flex-wrap items-center gap-3">
                      <ProviderGlyph type={backend.type} />
                      <button type="button" className={cn("min-w-0 flex-1 cursor-pointer rounded-sm text-left", FOCUS_RING)} onClick={() => nav.go({ page: "backend", id: backend.id })}>
                        <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm text-foreground">
                          <span className="truncate hover:underline">{backendTitle(backend, live)}</span>
                          <Badge>{FORMS[backend.type]}</Badge>
                        </span>
                        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <StatusDot tone={!backend.enabled ? "off" : offers ? "ok" : "warn"} />
                          <span className={cn(backend.enabled && !offers && "text-warning-text")}>{!backend.enabled ? "Off" : offers ? "Makes it now" : "Cannot make it now"}</span>
                        </span>
                      </button>
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        Warm
                        <Input aria-label={`Warm ${name} boxes on ${backendTitle(backend, live)}`} aria-invalid={draft.problemAt(path) ? true : undefined} className={cn("h-8 w-16 text-right text-xs tabular-nums", draft.edited(path) && "border-warning/60")} inputMode="numeric" value={String(draft.value(path) ?? 0)} onChange={(event) => draft.set(path, event.target.value.trim() && Number.isFinite(Number(event.target.value)) ? Number(event.target.value) : event.target.value)} />
                      </label>
                    </div>
                    {short ? (
                      <p className="mt-1 pl-7 text-xs leading-snug text-warning-text">
                        Has {short.ready} of {short.wanted} ready: no room. {short.reason}
                      </p>
                    ) : null}
                    {draft.problemAt(path) ? <p role="alert" className="mt-1 pl-7 text-xs text-destructive-text">{draft.problemAt(path)}</p> : null}
                    {conflict ? <ConflictNote saved={conflict.saved} onUseSaved={() => draft.useSaved(path)} onKeepMine={() => draft.keepMine(path)} /> : null}
                  </div>
                );
              })
            ) : (
              <p className="px-4 py-3 text-xs text-subtle-foreground">
                No backend you have makes it. {info.drivers.map((type) => driverOf(type).label).join(" or ")} {info.drivers.length === 1 ? "does" : "do"}.{" "}
                <button type="button" className="rounded-sm text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => nav.go({ page: "add" })}>
                  Add a backend
                </button>
              </p>
            )}
          </Rows>
        </Card>
      </Section>

      <Section title="Spare boxes" description="Made ahead and added to BB as machines, so a thread gets one of the default size, with its access, at once.">
        <Card>
          <SettingRow
            id={`kinds/${id}/spares`}
            label="Spares to keep"
            help={device ? "Off by default for device kinds: each spare keeps a booted device and its memory saved to disk." : "Each spare holds its memory while it waits. 0 keeps none."}
            problem={draft.problemAt(`kinds/${id}/spares`)}
            focus={draft.focusPath === `kinds/${id}/spares`}
            onFocused={draft.clearFocus}
            conflict={draft.conflictAt(`kinds/${id}/spares`) ? <ConflictNote saved={draft.conflictAt(`kinds/${id}/spares`)!.saved} onUseSaved={() => draft.useSaved(`kinds/${id}/spares`)} onKeepMine={() => draft.keepMine(`kinds/${id}/spares`)} /> : null}
          >
            <Input aria-label="Spares to keep" className={cn("h-8 w-20 text-right text-xs tabular-nums", draft.edited(`kinds/${id}/spares`) && "border-warning/60")} inputMode="numeric" value={shown(draft.value(`kinds/${id}/spares`)) === "empty" ? "" : String(draft.value(`kinds/${id}/spares`))} onChange={(event) => draft.set(`kinds/${id}/spares`, event.target.value.trim() && Number.isFinite(Number(event.target.value)) ? Number(event.target.value) : event.target.value)} />
          </SettingRow>
          {spareNow ? (
            <p className="flex items-center gap-1.5 border-t border-border px-4 py-2 text-xs text-muted-foreground">
              <StatusDot tone={spareNow.includes("being made") ? "busy" : "ok"} />
              {spareNow}
            </p>
          ) : null}
        </Card>
      </Section>

      <SaveBar draft={draft} />
      <p className="flex items-center gap-1 text-xs text-subtle-foreground">
        <Icon name="Info" className="size-3.5" aria-hidden />
        Sizes, the default size, warm boxes and spares are saved together with Save.
      </p>
    </div>
  );
}
