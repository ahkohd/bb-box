// "New box": a plus that opens a popover with one small form, the kind (its
// glyph, name and badges) and the size, and one button. The size is a preset, or a custom one within the kind's largest
// (028). It remembers the last kind and size in the browser, keyed by
// plugin ID.

import { experimental_Icon as Icon, experimental_usePluginId } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { KindView, SizeView } from "../plugin/views.ts";
import { Badge } from "./common.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { GuestOs } from "../backends/types.ts";
import { accessWords, archAvailable, ARCHS, Chip, choiceOf, FORM_FILTERS, formFilterOf, gpuChoices, kindFor, nearest, offersShown, OptionCard, ProviderRow, runsOnOptions, RUNS_ON_WORDS, Step, summaryWords, systemsOf, TYPE_GLYPHS, typeAvailable, type Choice, type FormFilter, type RunsOn } from "./box-form.tsx";

/** What the acquire RPC takes: a preset, or the parts of a custom size. Nothing for the kind's default. */
export interface SizeRequest {
  readonly preset?: string;
  readonly cores?: number;
  readonly memoryGiB?: number;
  readonly diskGiB?: number;
}

type Choice2 = string;
const CUSTOM: Choice2 = "custom";

interface Fields {
  readonly cores: string;
  readonly memoryGiB: string;
  readonly diskGiB: string;
}

interface Remembered {
  readonly kind?: string;
  readonly size?: Choice2;
  /** The custom fields a person edited, by kind. */
  readonly custom?: Readonly<Record<string, Fields>>;
}

function remembered(key: string): Remembered {
  try {
    return JSON.parse(window.localStorage.getItem(key) ?? "{}") as Remembered;
  } catch {
    return {};
  }
}

function remember(key: string, value: Remembered): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be off. Then the form starts from the kind's default each time.
  }
}

/** "2 cores · 4 GiB memory · base disk". */
export function sizeLine(size: SizeView): string {
  return [`${size.cores} ${size.cores === 1 ? "core" : "cores"}`, `${size.memoryGiB} GiB memory`, size.diskGiB === null ? "base disk" : `${size.diskGiB} GiB disk`].join(" · ");
}

const PRESET_LABELS: Readonly<Record<string, string>> = { small: "Small", medium: "Medium", large: "Large" };


/** A whole number of at least 1, or null for an empty field; undefined when the text is not one. */
function whole(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 1 ? value : undefined;
}

/** Custom starts from a preset: its cores and memory, and its disk when it has one of its own. */
function fieldsOf(preset: SizeView): Fields {
  return { cores: String(preset.cores), memoryGiB: String(preset.memoryGiB), diskGiB: preset.diskGiB === null ? "" : String(preset.diskGiB) };
}

/** The custom size's fields as the RPC takes them, or null when a field is not a whole number. */
export function customSize(fields: Fields): SizeRequest | null {
  const cores = whole(fields.cores);
  const memoryGiB = whole(fields.memoryGiB);
  const diskGiB = whole(fields.diskGiB);
  if (cores === undefined || memoryGiB === undefined || diskGiB === undefined) return null;
  return { ...(cores !== null ? { cores } : {}), ...(memoryGiB !== null ? { memoryGiB } : {}), ...(diskGiB !== null ? { diskGiB } : {}) };
}

/** A machine's name (036): a hostname label of up to 32 characters, unique among your machines, which the server checks. */
export const MACHINE_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** Why a typed name will not do, or null when it will; an empty name lets bb-box pick one. */
export function nameProblem(name: string): string | null {
  if (!name) return null;
  if (!MACHINE_NAME.test(name)) return "Lowercase letters, digits and hyphens, starting with a letter, up to 32 characters.";
  if (name.endsWith("-")) return "A name cannot end with a hyphen.";
  return null;
}

export function NewBox({
  kinds,
  make,
  machine = false,
}: {
  kinds: readonly KindView[];
  /** Makes a box; resolves with the refusal to show, or null when the box was made. A machine's name goes with it (036). */
  make: (kind: string, size?: SizeRequest, name?: string, on?: string) => Promise<string | null>;
  /** "Add machine": a labelled button, and a Name field, for one of your machines (036). */
  machine?: boolean;
}) {
  const pluginId = experimental_usePluginId();
  const [open, setOpen] = useState(false);
  const [last] = useState(() => remembered(`${pluginId}:${machine ? "new-machine" : "new-box"}`));
  const [name, setName] = useState("");
  // The steps that pick the kind (the operator's redesign of 1 October 2026): the OS, the architecture, a desktop or not, a GPU.
  const [wanted, setWanted] = useState<Choice>(() => {
    const remembered = kinds.find((kind) => kind.id === last.kind);
    return remembered ? choiceOf(remembered) : { os: "linux", arch: "x86_64", desktop: false, gpu: false };
  });
  const [choice, setChoice] = useState<Choice2 | null>(last.size ?? null);
  /** The preset last chosen, which Custom starts from. */
  const [viewed, setViewed] = useState<string | null>(last.size && last.size !== CUSTOM ? last.size : null);
  // Custom fields belong to a kind: edited ones are kept per kind, and a
  // kind without edits starts from its own preset in view.
  const [edited, setEdited] = useState<Readonly<Record<string, Fields>>>(() => (last.custom && typeof last.custom === "object" ? last.custom : {}));
  const [making, setMaking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** The Provider step's filters: what the boxes are, and the machine they run on. */
  const [filter, setFilter] = useState<FormFilter>("all");
  const [runsOn, setRunsOn] = useState<RunsOn>("any");
  /** Where the box goes (044): a provider's backend ID, or null for the first with room. Not remembered; another kind resets it. */
  const [on, setOn] = useState<string | null>(null);
  const sizeOptions = useRef<(HTMLButtonElement | null)[]>([]);
  const providerOptions = useRef<(HTMLButtonElement | null)[]>([]);

  // Every step shows what exists; a choice snaps to the nearest that does.
  const picked = nearest(kinds, wanted);
  const kind = kindFor(kinds, picked);
  const systems = systemsOf(kinds);
  const gpus = gpuChoices(kinds, picked.os, picked.arch);
  const offers = kind?.offers ?? [];
  const runsOnChoices = runsOnOptions(offers);
  const effectiveRunsOn: RunsOn = runsOnChoices.includes(runsOn as GuestOs) ? runsOn : "any";
  const shown = offersShown(offers, filter, effectiveRunsOn);
  // One offer is no choice: its row stands alone, checked, and nothing goes as `on` (044's first with room is that one).
  const choiceless = offers.length <= 1;
  const onOffer = choiceless ? (shown[0] ?? null) : (shown.find((offer) => offer.backend === on) ?? null);
  const presets = kind?.presets ?? [];
  const choices: Choice2[] = [...presets.map((preset) => preset.name), CUSTOM];
  const size: Choice2 = choice && choices.includes(choice) ? choice : (kind?.defaultPreset ?? CUSTOM);
  const preset = presets.find((candidate) => candidate.name === size) ?? null;
  // The preset Custom starts from: the one chosen last, else the kind's default.
  const inView = preset ?? presets.find((candidate) => candidate.name === viewed) ?? presets.find((candidate) => candidate.name === kind?.defaultPreset) ?? null;
  const fields: Fields = (kind && edited[kind.id]) ?? (inView ? fieldsOf(inView) : { cores: "", memoryGiB: "", diskGiB: "" });
  const custom = size === CUSTOM ? customSize(fields) : null;
  const sizeIndex = choices.indexOf(size);

  useEffect(() => {
    if (open) return;
    // The provider choice and its filters are not remembered (044): the next box starts from the first with room.
    setProblem(null);
    setOn(null);
    setFilter("all");
    setRunsOn("any");
  }, [open]);

  const pick = (change: Partial<Choice>) => {
    setWanted((current) => nearest(kinds, { ...current, ...change }));
    setOn(null);
    setProblem(null);
  };
  const chooseSize = (next: Choice2, focus = false) => {
    setChoice(next);
    if (next !== CUSTOM) setViewed(next);
    setProblem(null);
    if (focus) sizeOptions.current[choices.indexOf(next)]?.focus();
  };
  const edit = (name: keyof Fields, value: string) => {
    if (!kind) return;
    setEdited((current) => ({ ...current, [kind.id]: { ...fields, [name]: value } }));
    setProblem(null);
  };
  const arrows = (event: KeyboardEvent<HTMLElement>, count: number, index: number, pick: (position: number) => void) => {
    if (!count) return;
    const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    pick((index + step + count) % count);
  };
  const typedName = name.trim();
  const nameWrong = machine ? nameProblem(typedName) : null;
  // "First with room" names no provider; with the filters leaving one, that one is named (044 takes one provider).
  const sendOn = choiceless ? undefined : (onOffer?.backend ?? (shown.length === 1 && shown.length < offers.length ? shown[0]!.backend : undefined));
  const submit = async () => {
    if (!kind || making || (size === CUSTOM && !custom) || nameWrong) return;
    setMaking(true);
    try {
      const request: SizeRequest | undefined = size === CUSTOM ? (custom ?? undefined) : size === kind.defaultPreset ? undefined : { preset: size };
      const refused = await make(kind.id, request, machine && typedName ? typedName : undefined, sendOn);
      setProblem(refused);
      if (!refused) {
        remember(`${pluginId}:${machine ? "new-machine" : "new-box"}`, { kind: kind.id, size, ...(Object.keys(edited).length ? { custom: edited } : {}) });
        setName("");
        setOpen(false);
      }
    } finally {
      setMaking(false);
    }
  };

  const largest = kind?.largest ?? null;
  const field = (name: "cores" | "memoryGiB" | "diskGiB", label: string, limit: number | null) => (
    <label className="flex min-w-0 flex-col gap-1 text-xs leading-snug text-subtle-foreground">
      <span>{label}</span>
      <Input
        inputMode="numeric"
        className="h-7 px-2 text-xs"
        value={fields[name]}
        placeholder={name === "diskGiB" ? "base" : ""}
        aria-invalid={whole(fields[name]) === undefined || undefined}
        onChange={(event) => edit(name, event.target.value)}
      />
      {limit !== null ? <span>up to {limit}</span> : null}
    </label>
  );
  const sizeWords = preset ? { cores: preset.cores, memoryGiB: preset.memoryGiB } : custom && custom.cores && custom.memoryGiB ? { cores: custom.cores, memoryGiB: custom.memoryGiB } : null;
  const summary = summaryWords(picked, kind, onOffer ?? (sendOn ? (shown[0] ?? null) : null), sizeWords);
  const access = accessWords(kind, picked);
  const providerValues: (string | null)[] = [...(choiceless ? [] : [null]), ...shown.map((offer) => offer.backend)];
  const providerIndex = Math.max(0, providerValues.indexOf(onOffer?.backend ?? null));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {machine ? (
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="h-7" disabled={!kinds.length}>
            <Icon name="Plus" aria-hidden />
            Add machine
          </Button>
        </PopoverTrigger>
      ) : (
        <TooltipProvider delayDuration={250}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className="size-7 p-0 text-muted-foreground hover:text-foreground" aria-label="New box" disabled={!kinds.length}>
                  <Icon name="Plus" className="size-4" aria-hidden />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>New box</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      <PopoverContent align="end" className="w-80 p-4 sm:w-[560px]" mobileTitle={machine ? "Add machine" : "New box"}>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Step label="System" hint={machine ? "Of the kinds whose boxes join BB." : undefined}>
            <div role="radiogroup" aria-label="System" className="flex flex-wrap gap-1.5" onKeyDown={(event) => arrows(event, systems.length, systems.findIndex((system) => system.os === picked.os), (position) => pick({ os: systems[position]!.os }))}>
              {systems.map((system) => (
                <OptionCard key={system.os} title={system.label} words={system.words} selected={system.os === picked.os} onClick={() => pick({ os: system.os })} />
              ))}
            </div>
          </Step>
          <Step label="Architecture">
            <div role="radiogroup" aria-label="Architecture" className="flex flex-wrap gap-1.5" onKeyDown={(event) => arrows(event, ARCHS.length, ARCHS.findIndex((arch) => arch.id === picked.arch), (position) => pick({ arch: ARCHS[position]!.id }))}>
              {ARCHS.map((arch) => (
                <OptionCard key={arch.id} title={arch.label} words={arch.words} selected={arch.id === picked.arch} available={archAvailable(kinds, picked.os, arch.id)} onClick={() => pick({ arch: arch.id })} />
              ))}
            </div>
          </Step>
          <Step label="Type">
            <div role="radiogroup" aria-label="Type" className="flex flex-wrap gap-1.5" onKeyDown={(event) => arrows(event, 2, picked.desktop ? 1 : 0, (position) => pick({ desktop: position === 1 }))}>
              <OptionCard title="Server" words="Terminal" glyph={TYPE_GLYPHS.server} selected={!picked.desktop} available={typeAvailable(kinds, picked.os, picked.arch, false)} onClick={() => pick({ desktop: false })} />
              <OptionCard title="Desktop" words="Screen · Terminal · Computer use" glyph={TYPE_GLYPHS.desktop} selected={picked.desktop} available={typeAvailable(kinds, picked.os, picked.arch, true)} onClick={() => pick({ desktop: true })} />
            </div>
          </Step>
          <Step label="Provider">
            <div className="space-y-1.5">
              <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5 text-2xs text-muted-foreground">
                <span id="new-box-kind-filter">Kind</span>
                <div className="flex flex-wrap gap-1" role="group" aria-labelledby="new-box-kind-filter">
                  {FORM_FILTERS.map((option) => {
                    const available = option.id === "all" || offers.some((offer) => formFilterOf(offer) === option.id);
                    return <Chip key={option.id} label={option.label} title={option.words} selected={filter === option.id} available={available} onClick={() => { setFilter(option.id); setOn(null); }} />;
                  })}
                </div>
                {filter !== "physical" ? (
                  <>
                    <span id="new-box-runs-on">Runs on</span>
                    <div>
                      <Select value={effectiveRunsOn} onValueChange={(value) => { setRunsOn(value as RunsOn); setOn(null); }}>
                        <SelectTrigger className="h-7 w-44 text-xs" aria-label="Runs on">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="any">Any machine</SelectItem>
                          {runsOnChoices.map((os) => (
                            <SelectItem key={os} value={os}>
                              {RUNS_ON_WORDS[os]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </>
                ) : null}
              </div>
              <div role="radiogroup" aria-label="Provider" className="space-y-1" onKeyDown={(event) => arrows(event, providerValues.length, providerIndex, (position) => { setOn(providerValues[position] ?? null); providerOptions.current[position]?.focus(); })}>
                {!choiceless ? (
                  <button
                    ref={(element) => {
                      providerOptions.current[0] = element;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={onOffer === null}
                    tabIndex={onOffer === null ? 0 : -1}
                    onClick={() => setOn(null)}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-md border px-2.5 py-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring",
                      onOffer === null ? "border-transparent bg-state-active" : "border-input hover:bg-state-hover",
                    )}
                  >
                    <Icon name="Check" className={cn("mt-0.5 size-3.5 shrink-0", onOffer === null ? "text-foreground" : "invisible")} aria-hidden />
                    <span className="min-w-0">
                      <span className="block text-xs font-medium text-foreground">First with room</span>
                      <span className="block text-2xs text-muted-foreground">
                        {/* The server takes one provider or none (044): a filter that leaves several cannot bind it, so the words say so. */}
                        {shown.length === offers.length ? `Any of the ${shown.length} below, in order` : shown.length === 1 ? "The one below" : shown.length ? `Any provider with room, not only these ${shown.length}` : "Any provider with room"}
                      </span>
                    </span>
                  </button>
                ) : null}
                {shown.map((offer, index) => (
                  <ProviderRow
                    key={offer.backend}
                    offer={offer}
                    selected={onOffer?.backend === offer.backend}
                    onClick={() => setOn(offer.backend)}
                    optionRef={(element) => {
                      providerOptions.current[index + (choiceless ? 0 : 1)] = element;
                    }}
                  />
                ))}
                {!shown.length ? <p className="px-1 text-2xs text-muted-foreground">No provider matches these filters.</p> : null}
              </div>
            </div>
          </Step>
          {kind ? (
            <Step label="Resources">
              <div role="radiogroup" aria-label="Size" className="flex flex-wrap gap-1.5" onKeyDown={(event) => arrows(event, choices.length, sizeIndex, (position) => chooseSize(choices[position]!, true))}>
                {choices.map((candidate, position) => {
                  const own = presets.find((item) => item.name === candidate) ?? null;
                  return (
                    <OptionCard
                      key={candidate}
                      optionRef={(element) => {
                        sizeOptions.current[position] = element;
                      }}
                      title={PRESET_LABELS[candidate] ?? (candidate === CUSTOM ? "Custom" : candidate)}
                      words={own ? `${own.cores} cores · ${own.memoryGiB} GiB` : largest ? `up to ${largest.cores} cores` : null}
                      selected={candidate === size}
                      onClick={() => chooseSize(candidate)}
                    />
                  );
                })}
              </div>
              {!preset ? (
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {field("cores", "Cores", largest?.cores ?? null)}
                  {field("memoryGiB", "Memory, GiB", largest?.memoryGiB ?? null)}
                  {field("diskGiB", "Disk, GiB", largest?.diskGiB ?? null)}
                </div>
              ) : null}
              {picked.desktop && gpus.none && gpus.gpu ? (
                <div className="mt-2 grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-x-2 text-2xs text-muted-foreground">
                  <span id="new-box-gpu">GPU</span>
                  <div role="radiogroup" aria-labelledby="new-box-gpu" className="flex gap-1">
                    <Chip label="None" selected={!picked.gpu} onClick={() => pick({ gpu: false })} />
                    <Chip label="1 GPU" selected={picked.gpu} onClick={() => pick({ gpu: true })} />
                  </div>
                </div>
              ) : null}
            </Step>
          ) : null}
          {machine ? (
            <Step label="Name" hint={nameWrong ? <span role="alert" className="text-destructive-text">{nameWrong}</span> : null}>
              <Input
                id="new-machine-name"
                aria-label="Name"
                className="h-7 px-2 text-xs"
                value={name}
                placeholder="optional; bb-box picks one"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={nameWrong !== null || undefined}
                onChange={(event) => {
                  setName(event.target.value);
                  setProblem(null);
                }}
              />
            </Step>
          ) : null}
          <div className="flex items-start justify-between gap-3 border-t border-border pt-3">
            <div className="min-w-0 space-y-1">
              <p className="text-xs leading-snug text-foreground">{summary}</p>
              <p className="flex flex-wrap items-center gap-1 text-2xs text-muted-foreground">
                <span className="mr-0.5">Access</span>
                {access.map((word) => (
                  <Badge key={word}>{word}</Badge>
                ))}
              </p>
            </div>
            <Button type="submit" size="sm" className="shrink-0" disabled={!kind || making || (size === CUSTOM && !custom) || nameWrong !== null}>
              {making ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
              {machine ? "Add" : "Create"}
            </Button>
          </div>
          {problem ? (
            <p role="alert" className="text-xs leading-snug text-destructive-text">
              {problem}
            </p>
          ) : null}
        </form>
      </PopoverContent>
    </Popover>
  );
}
