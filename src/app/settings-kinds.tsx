// The Kinds section of the settings page: a row per kind with its switch,
// presets, largest size, warm counts and spares, and an editor for them.

import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { BoxForm, BoxSize } from "../backends/types.ts";
import type { Problem } from "../core/document.ts";
import type { Preset } from "../core/sizes.ts";
import type { BackendState, ConfigState, KindInfoView } from "../plugin/configuration.ts";
import { isArm64Badge, KindBadges, lacksDocker, Meta, osName, StatusDot } from "./common.tsx";
import { PRESET_LABELS, PRESET_NAMES, gib, mib, problemAt, problemsLeft, sizeWords, type KindSizes } from "./config.ts";
import { FieldShell, FormHeading } from "./settings-fields.tsx";

export interface KindRowModel {
  readonly info: KindInfoView;
  readonly sizes: KindSizes;
  /** The backends in the document that can make it, with what its boxes are there, whether each offers it now and its warm count. */
  readonly backends: readonly { readonly id: string; readonly label: string; readonly form: BoxForm | null; readonly offers: boolean; readonly warm: number }[];
  readonly problems: readonly Problem[];
}

export function kindRowModel(state: ConfigState, info: KindInfoView, sizes: KindSizes): KindRowModel {
  const backends = state.document.backends
    .filter((backend) => info.drivers.includes(backend.type))
    .map((backend) => {
      const live: BackendState | undefined = state.backends.find((candidate) => candidate.id === backend.id);
      return { id: backend.id, label: live?.label ?? backend.label ?? backend.type, form: live?.form ?? null, offers: live?.kinds.includes(info.id) ?? false, warm: backend.warm?.[info.id] ?? 0 };
    });
  return { info, sizes, backends, problems: state.problems.filter((problem) => problem.path === `kinds.${info.id}` || problem.path.startsWith(`kinds.${info.id}.`)) };
}

/** A kind's spares in its status line (032): "2 spares ready", "1 of 2 spares ready" or "2 spares, being made". */
export function sparesWords(target: number, now: { readonly ready: number; readonly making: number }): string[] {
  if (target <= 0) return [];
  const spares = `${target} ${target === 1 ? "spare" : "spares"}`;
  if (now.ready >= target) return [`${spares} ready`];
  if (now.ready > 0) return [`${now.ready} of ${spares} ready`];
  // None ready and none being made, as while its backend is off: the row's state says why.
  return now.making > 0 ? [`${spares}, being made`] : [];
}

export function KindRow({ model, open, onToggle, onSwitch, switching, children }: { model: KindRowModel; open: boolean; onToggle: () => void; onSwitch: (on: boolean) => void; switching: boolean; children?: ReactNode }) {
  const { info, sizes, backends } = model;
  const offering = backends.filter((backend) => backend.offers);
  const warm = backends.filter((backend) => backend.warm > 0).map((backend) => `${backend.warm} warm on ${backend.label}`);
  const spares = sparesWords(sizes.spares, info.spares);
  const presets = PRESET_NAMES.map((preset) => `${PRESET_LABELS[preset]} ${sizeWords(sizes.presets[preset])}${preset === sizes.default ? " (default)" : ""}`);
  // The badges say what its boxes are on the backends that offer it now, as the "From" line names them.
  const forms = [...new Set(offering.map((backend) => backend.form).filter((form): form is BoxForm => form !== null))];
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-start gap-3">
        <Switch aria-label={`${info.label} on`} className="mt-1" checked={sizes.enabled} disabled={switching} onCheckedChange={onSwitch} />
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-medium text-foreground">
            <span className="truncate">{osName(info.os)}</span>
            <KindBadges desktop={info.desktop} gpu={info.gpu} noDocker={lacksDocker(info)} arm64={isArm64Badge(info.os, info.arch)} forms={forms} />
          </p>
          <div className="mt-0.5 flex min-w-0 items-start gap-1.5 text-xs leading-snug text-muted-foreground">
            <StatusDot tone={!sizes.enabled ? "off" : offering.length ? "ok" : "warn"} />
            <Meta
              items={[
                !sizes.enabled ? "Off" : offering.length ? `From ${offering.map((backend) => backend.label).join(" and ")}` : <span className="text-warning-text">Not offered: no backend has it</span>,
                ...warm,
                ...spares,
              ]}
            />
          </div>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
            {presets.join(" · ")} · up to {sizeWords(sizes.largest)}
          </p>
          {model.problems.length && !open ? (
            <ul className="mt-0.5 text-xs leading-snug text-destructive-text">
              {model.problems.map((problem) => (
                <li key={problem.path + problem.message}>{problem.message}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-2" aria-expanded={open} onClick={onToggle}>
          Edit
          <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5" aria-hidden />
        </Button>
      </div>
      {open ? children : null}
    </div>
  );
}

interface SizeFields {
  readonly cores: string;
  readonly memoryGiB: string;
  readonly diskGiB: string;
}

function fieldsOf(size: BoxSize): SizeFields {
  return { cores: String(size.cores), memoryGiB: String(gib(size.memoryMiB)), diskGiB: size.diskGiB === null ? "" : String(size.diskGiB) };
}

/** A size from its fields, or null when a field is not a number. An empty disk is the base disk, or for the largest, unchanged. */
function sizeOf(fields: SizeFields, fallback: BoxSize, largest: boolean): BoxSize | null {
  const cores = Number(fields.cores.trim());
  const memory = Number(fields.memoryGiB.trim());
  if (!fields.cores.trim() || !fields.memoryGiB.trim() || !Number.isFinite(cores) || !Number.isFinite(memory)) return null;
  const disk = fields.diskGiB.trim();
  if (disk && !Number.isFinite(Number(disk))) return null;
  return { cores, memoryMiB: mib(memory), diskGiB: disk ? Number(disk) : largest ? fallback.diskGiB : null };
}

export interface KindEdit {
  readonly sizes: KindSizes;
  readonly warm: Readonly<Record<string, number>>;
}

export function KindForm({ model, onSave, onClose }: { model: KindRowModel; onSave: (edit: KindEdit) => Promise<{ readonly saved: boolean; readonly problems: readonly Problem[] }>; onClose: () => void }) {
  const { info, sizes } = model;
  const path = `kinds.${info.id}`;
  const [presets, setPresets] = useState<Record<Preset, SizeFields>>({ small: fieldsOf(sizes.presets.small), medium: fieldsOf(sizes.presets.medium), large: fieldsOf(sizes.presets.large) });
  const [largest, setLargest] = useState<SizeFields>(fieldsOf(sizes.largest));
  const [chosen, setChosen] = useState<Preset>(sizes.default);
  const [warm, setWarm] = useState<Record<string, string>>(Object.fromEntries(model.backends.map((backend) => [backend.id, String(backend.warm)])));
  const [spares, setSpares] = useState(String(sizes.spares));
  const [problems, setProblems] = useState<readonly Problem[]>(model.problems);
  const [busy, setBusy] = useState(false);

  const built = (): KindEdit | null => {
    const next = {} as Record<Preset, BoxSize>;
    for (const preset of PRESET_NAMES) {
      const size = sizeOf(presets[preset], sizes.presets[preset], false);
      if (!size) return null;
      next[preset] = size;
    }
    const top = sizeOf(largest, sizes.largest, true);
    if (!top) return null;
    const counts: Record<string, number> = {};
    for (const [id, text] of Object.entries(warm)) {
      const count = Number(text.trim() || "0");
      if (!Number.isFinite(count)) return null;
      counts[id] = count;
    }
    const spareCount = Number(spares.trim() || "0");
    if (!Number.isFinite(spareCount)) return null;
    return { sizes: { enabled: sizes.enabled, presets: next, default: chosen, largest: top, spares: spareCount }, warm: counts };
  };
  const edit = built();
  const save = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      const { saved, problems: left } = await onSave(edit);
      setProblems(left);
      if (saved) onClose();
    } finally {
      setBusy(false);
    }
  };
  const shown = [...PRESET_NAMES.flatMap((preset) => [`${path}.presets.${preset}`, `${path}.presets.${preset}.cores`, `${path}.presets.${preset}.memoryMiB`, `${path}.presets.${preset}.diskGiB`]), `${path}.largest`, `${path}.default`, `${path}.spares`];
  const rest = problemsLeft(problems, path, shown);
  const sizeRow = (label: string, key: Preset | "largest", fields: SizeFields, set: (next: SizeFields) => void, extra?: ReactNode) => {
    const at = key === "largest" ? `${path}.largest` : `${path}.presets.${key}`;
    const problem = [problemAt(problems, at), problemAt(problems, `${at}.cores`), problemAt(problems, `${at}.memoryMiB`), problemAt(problems, `${at}.diskGiB`)].find(Boolean) ?? null;
    return (
      <div key={key} className="grid grid-cols-[6rem_minmax(0,1fr)] items-start gap-3">
        <div className="pt-1.5 text-xs text-foreground">
          {label}
          {extra}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <FieldShell label="Cores">
            <Input className="h-8 text-xs" inputMode="numeric" aria-label={`${label} cores`} value={fields.cores} onChange={(event) => set({ ...fields, cores: event.target.value })} />
          </FieldShell>
          <FieldShell label="Memory, GiB">
            <Input className="h-8 text-xs" inputMode="numeric" aria-label={`${label} memory`} value={fields.memoryGiB} onChange={(event) => set({ ...fields, memoryGiB: event.target.value })} />
          </FieldShell>
          <FieldShell label="Disk, GiB" problem={problem}>
            <Input className="h-8 text-xs" inputMode="numeric" aria-label={`${label} disk`} value={fields.diskGiB} placeholder={key === "largest" ? undefined : "base"} onChange={(event) => set({ ...fields, diskGiB: event.target.value })} />
          </FieldShell>
        </div>
      </div>
    );
  };
  return (
    <form
      className="mt-3 space-y-4 border-t border-border pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="space-y-2">
        <FormHeading>Presets</FormHeading>
        <p className="text-2xs leading-snug text-subtle-foreground/75">An empty disk is the base disk.</p>
        <div role="radiogroup" aria-label="Default preset" className="space-y-2">
          {PRESET_NAMES.map((preset) =>
            sizeRow(
              PRESET_LABELS[preset],
              preset,
              presets[preset],
              (next) => setPresets((current) => ({ ...current, [preset]: next })),
              <label className="mt-1 flex items-center gap-1.5 text-2xs text-muted-foreground">
                <input type="radio" name={`${info.id}-default`} role="radio" aria-label={`${PRESET_LABELS[preset]} is the default`} aria-checked={chosen === preset} checked={chosen === preset} onChange={() => setChosen(preset)} className="size-3 accent-foreground" />
                default
              </label>,
            ),
          )}
        </div>
      </div>
      <div className="space-y-2">
        <FormHeading>Largest custom size</FormHeading>
        {sizeRow("Largest", "largest", largest, setLargest)}
      </div>
      {model.backends.length ? (
        <div className="space-y-2">
          <FormHeading>Warm boxes</FormHeading>
          <p className="text-2xs leading-snug text-subtle-foreground/75">Ready boxes kept waiting, so a new one is ready at once.</p>
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
            {model.backends.map((backend) => (
              <FieldShell key={backend.id} label={backend.label} problem={problemAt(problems, `backends.${backend.id}.warm.${info.id}`)}>
                <Input className="h-8 w-24 text-xs" inputMode="numeric" aria-label={`Warm ${info.label} boxes on ${backend.label}`} value={warm[backend.id] ?? "0"} onChange={(event) => setWarm((current) => ({ ...current, [backend.id]: event.target.value }))} />
              </FieldShell>
            ))}
          </div>
        </div>
      ) : null}
      <div className="space-y-2">
        <FormHeading>Spare boxes</FormHeading>
        <p className="text-2xs leading-snug text-subtle-foreground/75">
          Boxes made and added to BB ahead, so a box of the default size is ready with the thread's access at once. Each holds its memory, and BB lists it as a machine whose name ends in "(spare)" until a thread takes it. 0 keeps none.
        </p>
        <FieldShell label="Spares" problem={problemAt(problems, `${path}.spares`)}>
          <Input className="h-8 w-24 text-xs" inputMode="numeric" aria-label={`Spare ${info.label} boxes`} value={spares} onChange={(event) => setSpares(event.target.value)} />
        </FieldShell>
      </div>
      {rest.length ? (
        <ul role="alert" className="space-y-0.5 text-xs leading-snug text-destructive-text">
          {rest.map((problem) => (
            <li key={problem.path + problem.message}>{problem.message}</li>
          ))}
        </ul>
      ) : null}
      <div className={cn("flex items-center gap-2")}>
        <Button type="submit" size="sm" className="h-7" disabled={busy || !edit}>
          {busy ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
          Save
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
