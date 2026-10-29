import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { StatusDot } from "@/src/app/common.tsx";
import { kindOf, PRESET_LABELS, PRESETS, type BoxSize, type Document, type Preset } from "./data";
import { PageHeaderLite } from "./backend-page";
import { backendTitle, canMake, FORMS, gib, kindBadges, kindTitle } from "./model";
import { useNav } from "./nav";
import { useStore } from "./store";
import { Badge, Card, Icon, ProviderGlyph, Rows, SaveBar, SavedTick, Section, SettingRow, useEditing, useInstant } from "./ui";

interface SizeText {
  readonly cores: string;
  readonly memory: string;
  readonly disk: string;
}

interface KindDraft {
  readonly presets: Record<Preset, SizeText>;
  readonly largest: SizeText;
  readonly default: Preset;
  readonly warm: Record<string, string>;
  readonly spares: string;
}

function textOf(size: BoxSize): SizeText {
  return { cores: String(size.cores), memory: String(gib(size.memoryMiB)), disk: size.diskGiB === null ? "" : String(size.diskGiB) };
}

function sizeOf(text: SizeText, fallback: BoxSize): BoxSize {
  return { cores: Number(text.cores || fallback.cores), memoryMiB: Math.round(Number(text.memory || gib(fallback.memoryMiB)) * 1024), diskGiB: text.disk.trim() ? Number(text.disk) : fallback.diskGiB === null ? null : fallback.diskGiB };
}

function SizeCells({ value, onChange, label, problem, base }: { value: SizeText; onChange: (value: SizeText) => void; label: string; problem?: boolean; base?: boolean }) {
  const cell = "h-8 w-full text-right text-xs tabular-nums";
  return (
    <>
      <Input aria-label={`${label} cores`} aria-invalid={problem || undefined} className={cell} inputMode="numeric" value={value.cores} onChange={(event) => onChange({ ...value, cores: event.target.value })} />
      <Input aria-label={`${label} memory in GiB`} aria-invalid={problem || undefined} className={cell} inputMode="numeric" value={value.memory} onChange={(event) => onChange({ ...value, memory: event.target.value })} />
      <Input aria-label={`${label} disk in GiB`} className={cell} inputMode="numeric" placeholder={base ? "base" : undefined} value={value.disk} onChange={(event) => onChange({ ...value, disk: event.target.value })} />
    </>
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
  const path = `kinds.${id}`;
  const title = kindTitle(id);
  const editing = useEditing<KindDraft>({
    stored: {
      presets: { small: textOf(kind.presets.small), medium: textOf(kind.presets.medium), large: textOf(kind.presets.large) },
      largest: textOf(kind.largest),
      default: kind.default,
      warm: Object.fromEntries(makers.map((backend) => [backend.id, String(backend.warm?.[id] ?? 0)])),
      spares: String(kind.spares),
    },
    part: path,
    what: title,
    build: (doc: Document, draft) => ({
      ...doc,
      kinds: {
        ...doc.kinds,
        [id]: {
          ...doc.kinds[id]!,
          presets: { small: sizeOf(draft.presets.small, kind.presets.small), medium: sizeOf(draft.presets.medium, kind.presets.medium), large: sizeOf(draft.presets.large, kind.presets.large) },
          largest: sizeOf(draft.largest, kind.largest),
          default: draft.default,
          spares: Number(draft.spares || 0),
        },
      },
      backends: doc.backends.map((backend) => (backend.id in draft.warm ? { ...backend, warm: { ...backend.warm, [id]: Number(draft.warm[backend.id] || 0) } } : backend)),
    }),
  });
  const { draft, setDraft } = editing;
  const sizeProblem = (preset: string) => editing.problems.find((problem) => problem.path.startsWith(`${path}.presets.${preset}`))?.message ?? null;
  const device = info.device !== null;
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <PageHeaderLite
            title={title}
            chips={
              <>
                {kindBadges(id).map((badge) => (
                  <Badge key={badge}>{badge}</Badge>
                ))}
                {isDefault ? <Badge>Default kind</Badge> : null}
              </>
            }
            description={info.description}
          />
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-7">
          <SavedTick show={instant.saved !== null} />
          {!isDefault && kind.enabled ? (
            <Button type="button" variant="ghost" size="sm" className="h-7 text-muted-foreground" disabled={instant.pending !== null} onClick={() => void instant.run("default", "general", (doc) => ({ ...doc, general: { ...doc.general, defaultKind: id } }))}>
              Make default
            </Button>
          ) : null}
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            {kind.enabled ? "On" : "Off"}
            <Switch aria-label={`${title} on`} checked={kind.enabled} disabled={instant.pending === "enabled" || (isDefault && kind.enabled)} onCheckedChange={(enabled) => void instant.run("enabled", path, (doc) => ({ ...doc, kinds: { ...doc.kinds, [id]: { ...doc.kinds[id]!, enabled } } }))} />
          </label>
        </div>
      </div>
      {isDefault && kind.enabled ? <p className="-mt-3 text-xs text-subtle-foreground">The default kind stays on. Make another kind the default to turn this one off.</p> : null}

      <Section title="Sizes" description="A box asks for small, medium or large, or a custom size up to the largest. An empty disk keeps the image's own.">
        <Card className="px-4 py-3">
          <div role="radiogroup" aria-label="Default size" className="grid grid-cols-[6.5rem_repeat(3,minmax(0,1fr))_4.5rem] items-center gap-x-2 gap-y-2">
            <span />
            <span className="text-right text-2xs text-subtle-foreground">Cores</span>
            <span className="text-right text-2xs text-subtle-foreground">Memory, GiB</span>
            <span className="text-right text-2xs text-subtle-foreground">Disk, GiB</span>
            <span className="text-center text-2xs text-subtle-foreground">Default</span>
            {PRESETS.map((preset) => (
              <div key={preset} className="contents" data-problem={`${path}.presets.${preset}`}>
                <span className="text-sm text-foreground">{PRESET_LABELS[preset]}</span>
                <SizeCells label={PRESET_LABELS[preset]} base value={draft.presets[preset]} problem={!!sizeProblem(preset)} onChange={(value) => setDraft((current) => ({ ...current, presets: { ...current.presets, [preset]: value } }))} />
                <span className="flex justify-center">
                  <input type="radio" name="default-size" aria-label={`${PRESET_LABELS[preset]} is the default`} checked={draft.default === preset} onChange={() => setDraft((current) => ({ ...current, default: preset }))} className="size-3.5 cursor-pointer accent-foreground" />
                </span>
                {sizeProblem(preset) ? <p className="col-span-5 -mt-1 text-right text-xs text-destructive-text">{sizeProblem(preset)}</p> : null}
              </div>
            ))}
            <div className="col-span-5 my-1 border-t border-border" />
            <span className="text-sm text-foreground">Largest</span>
            <SizeCells label="Largest" value={draft.largest} onChange={(value) => setDraft((current) => ({ ...current, largest: value }))} />
            <span className="text-center text-2xs text-subtle-foreground">custom</span>
          </div>
        </Card>
      </Section>

      <Section title="Where it runs" description="Backends that can make it, first with room first. Warm boxes wait ready on a backend, so a new box takes a second.">
        <Card>
          <Rows>
            {makers.length ? (
              makers.map((backend) => {
                const offers = store.live[backend.id]?.offers.includes(id) ?? false;
                return (
                  <div key={backend.id} className="flex items-center gap-3 px-4 py-2.5">
                    <ProviderGlyph type={backend.type} />
                    <button type="button" className="min-w-0 flex-1 cursor-pointer text-left" onClick={() => nav.go({ page: "backend", id: backend.id })}>
                      <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
                        <span className="truncate hover:underline">{backendTitle(backend, store.live[backend.id])}</span>
                        <Badge>{FORMS[backend.type]}</Badge>
                      </span>
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <StatusDot tone={!backend.enabled ? "off" : offers ? "ok" : "warn"} />
                        <span className={cn(backend.enabled && !offers && "text-warning-text")}>{!backend.enabled ? "Off" : offers ? "Makes it" : "Cannot make it now"}</span>
                      </span>
                    </button>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      Warm
                      <Input aria-label={`Warm ${title} boxes on ${backendTitle(backend)}`} className="h-8 w-16 text-right text-xs tabular-nums" inputMode="numeric" value={draft.warm[backend.id] ?? "0"} onChange={(event) => setDraft((current) => ({ ...current, warm: { ...current.warm, [backend.id]: event.target.value } }))} />
                    </label>
                  </div>
                );
              })
            ) : (
              <p className="px-4 py-3 text-xs text-subtle-foreground">No backend you have can make it. {info.drivers.length ? `Add one of: ${info.drivers.join(", ")}.` : ""}</p>
            )}
          </Rows>
        </Card>
      </Section>

      <Section title="Spare boxes" description="Made ahead and added to BB as machines, so a thread gets one of the default size with its access at once.">
        <Card>
          <SettingRow id={`${path}.spares`} problemPath={`${path}.spares`} problem={editing.problemAt(`${path}.spares`)} label="Spares to keep" description={device ? "Off by default for device kinds: each spare keeps a booted device and its memory saved to disk." : "Each spare holds its memory while it waits. 0 keeps none."}>
            <Input aria-label="Spares to keep" className="h-8 w-16 text-right text-xs tabular-nums" inputMode="numeric" value={draft.spares} onChange={(event) => setDraft((current) => ({ ...current, spares: event.target.value }))} />
          </SettingRow>
          {kind.spares ? (
            <p className="flex items-center gap-1.5 border-t border-border px-4 py-2 text-xs text-muted-foreground">
              <StatusDot tone="ok" />
              {kind.spares} of {kind.spares} ready
            </p>
          ) : null}
        </Card>
      </Section>

      <SaveBar state={editing.bar} changes={editing.changes} what={title} onSave={editing.save} onDiscard={editing.discard} onKeepMine={editing.keepMine} onUseSaved={editing.discard} />
      {editing.bar.kind === "idle" ? (
        <p className="flex items-center gap-1 text-xs text-subtle-foreground">
          <Icon name="Info" className="size-3.5" aria-hidden />
          Changes to sizes reach new boxes; boxes already made keep theirs.
        </p>
      ) : null}
    </div>
  );
}
