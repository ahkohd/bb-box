// "New box": a plus that opens a popover with one form of sections that
// narrow each other (System, Architecture, Type, Provider, Resources, and
// Name for a machine) and one button. The size is a preset, or a custom one
// within the kind's largest (028). It remembers the last kind and size in
// the browser, keyed by plugin ID.

import { experimental_Icon as Icon, experimental_usePluginId } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { KindView, ProviderProfile, SizeView } from "../plugin/views.ts";
import { ProviderInfo, type Loaded } from "./provider-profile.tsx";
import { message } from "./common.tsx";
import type { GuestOs, Windowing } from "../backends/types.ts";
import { archAvailable, ARCHS, choiceOf, displayChoices, FORM_FILTERS, formFilterOf, FormSection, gpuChoices, kindFor, MenuSelect, nearest, useEscapeCloses, offersShown, OptionCard, ProviderRow, runsOnOptions, RUNS_ON_WORDS, systemsOf, TYPE_GLYPHS, typeAvailable, type Choice, type FormFilter, type RunsOn } from "./box-form.tsx";

/**
 * What "Ask an agent to make one" puts in a new thread's composer (049): the
 * skill's flow for a project's image, for the person to send.
 */
export const IMAGE_REQUEST =
  "Make a box image for this project with bb-box: draft .bb/box-setup.sh and .bb/box-check.sh with box_image_draft from the project's files, " +
  "try them with box_image_try until every check passes, commit them, then register them with box_image_set.";

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
  profile,
  askForImage,
}: {
  kinds: readonly KindView[];
  /** Makes a box; resolves with the refusal to show, or null when the box was made. A machine's name goes with it (036). */
  make: (kind: string, size?: SizeRequest, name?: string, on?: string | string[]) => Promise<string | null>;
  /** "Add machine": a labelled button, and a Name field, for one of your machines (036). */
  machine?: boolean;
  /** A provider's profile for the (i) on its row, asked when the popover opens. Without it, rows have no (i). */
  profile?: (backend: string) => Promise<ProviderProfile>;
  /** Asks an agent to make the project a box image (049), when it has none. */
  askForImage?: () => void;
}) {
  const pluginId = experimental_usePluginId();
  const [open, setOpen] = useState(false);
  useEscapeCloses(open, setOpen);
  const [last] = useState(() => remembered(`${pluginId}:${machine ? "new-machine" : "new-box"}`));
  const [name, setName] = useState("");
  // The steps that pick the kind (the operator's redesign of 1 October 2026): the OS, the architecture, a desktop or not, a GPU.
  const [wanted, setWanted] = useState<Choice>(() => {
    const remembered = kinds.find((kind) => kind.id === last.kind);
    return remembered ? choiceOf(remembered) : { os: "linux", arch: "x86_64", desktop: false, gpu: false, windowing: "x11" };
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
  // Every listed provider's profile, fetched in the background once the form has painted, all at once, and kept for the form's life, so the (i) opens filled (the operator's note of 2 October 2026). Nothing is fetched while the form is closed.
  const [profiles, setProfiles] = useState<ReadonlyMap<string, Loaded>>(() => new Map());
  const profilesNow = useRef(profiles);
  profilesNow.current = profiles;
  const inFlight = useRef(new Set<string>());
  const loadProfile = useCallback(
    (backend: string) => {
      if (!profile || inFlight.current.has(backend) || profilesNow.current.get(backend)?.profile) return;
      inFlight.current.add(backend);
      setProfiles((current) => new Map(current).set(backend, { profile: null, error: null, loading: true }));
      profile(backend)
        .then(
          (found) => setProfiles((current) => new Map(current).set(backend, { profile: found, error: null, loading: false })),
          (error: unknown) => setProfiles((current) => new Map(current).set(backend, { profile: null, error: message(error), loading: false })),
        )
        .finally(() => inFlight.current.delete(backend));
    },
    [profile],
  );
  const listed = kinds.flatMap((kind) => kind.offers.map((offer) => offer.backend)).join("\n");
  useEffect(() => {
    if (!open) {
      setProfiles(new Map());
      return;
    }
    const after = setTimeout(() => {
      for (const backend of new Set(listed.split("\n").filter(Boolean))) loadProfile(backend);
    }, 0);
    return () => clearTimeout(after);
  }, [open, listed, loadProfile]);

  // Every step shows what exists; a choice snaps to the nearest that does.
  const picked = nearest(kinds, wanted);
  const kind = kindFor(kinds, picked);
  const systems = systemsOf(kinds);
  const gpus = gpuChoices(kinds, picked.os, picked.arch, picked.windowing);
  /** A desktop whose system has a GPU desktop and a CPU one: the GPU is a choice. */
  const gpuChoice = picked.desktop && gpus.none && gpus.gpu;
  const displays = displayChoices(kinds, picked.os, picked.arch);
  /** A desktop whose system has both an X11 desktop and a Wayland one: the windowing is a choice (048). */
  const displayChoice = picked.desktop && displays.x11 && displays.wayland;
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
  // "First with room" with every provider shown names none; with the filters hiding some, it names the shown ones, as a list when there are several, so the box never lands outside the filter (044).
  const sendOn: string | string[] | undefined = choiceless
    ? undefined
    : onOffer
      ? onOffer.backend
      : shown.length && shown.length < offers.length
        ? shown.length === 1
          ? shown[0]!.backend
          : shown.map((offer) => offer.backend)
        : undefined;
  /** Filters that leave no provider: nothing to create. */
  const noMatch = !choiceless && !shown.length;
  const submit = async () => {
    if (!kind || making || noMatch || (size === CUSTOM && !custom) || nameWrong) return;
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
  // The provider choice: "First with room" when there is one to make, then the rows the filters leave.
  const providerValues: (string | null)[] = [...(choiceless || !shown.length ? [] : [null]), ...shown.map((offer) => offer.backend)];
  const providerIndex = Math.max(0, providerValues.indexOf(onOffer?.backend ?? null));
  const kindOptions = FORM_FILTERS.map((option) => ({ value: option.id, label: option.label, disabled: option.id !== "all" && !offers.some((offer) => formFilterOf(offer) === option.id) }));
  const runsOnChoiceList = [{ value: "any", label: "Any machine" }, ...runsOnChoices.map((os) => ({ value: os, label: RUNS_ON_WORDS[os] }))];
  // The footer says what stands in the way: a refusal, or filters that leave no provider.
  const standing = problem ?? (noMatch ? "No provider matches these filters." : null);
  const rowClass = (selected: boolean) =>
    cn(
      "flex w-full flex-col items-start rounded-md border px-3 py-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring",
      selected ? "border-transparent bg-state-active" : "border-input hover:bg-state-hover",
    );

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
      {/* The form may be taller than the window: it takes the height the popover has and scrolls inside, so a short window scrolls the form rather than losing its bottom. */}
      <PopoverContent align="end" className="max-h-[var(--radix-popover-content-available-height)] w-80 overflow-y-auto p-4 sm:w-[560px] sm:p-5" mobileTitle={machine ? "Add machine" : "New box"}>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FormSection title="System" description={machine ? "Of the kinds whose boxes join BB." : undefined}>
            <div role="radiogroup" aria-label="System" className="flex flex-wrap gap-2" onKeyDown={(event) => arrows(event, systems.length, systems.findIndex((system) => system.os === picked.os), (position) => pick({ os: systems[position]!.os }))}>
              {systems.map((system) => (
                <OptionCard key={system.os} title={system.label} words={system.words} selected={system.os === picked.os} onClick={() => pick({ os: system.os })} />
              ))}
            </div>
          </FormSection>
          <FormSection title="Architecture">
            <div role="radiogroup" aria-label="Architecture" className="flex flex-wrap gap-2" onKeyDown={(event) => arrows(event, ARCHS.length, ARCHS.findIndex((arch) => arch.id === picked.arch), (position) => pick({ arch: ARCHS[position]!.id }))}>
              {ARCHS.map((arch) => (
                <OptionCard key={arch.id} title={arch.label} words={arch.words} selected={arch.id === picked.arch} available={archAvailable(kinds, picked.os, arch.id)} onClick={() => pick({ arch: arch.id })} />
              ))}
            </div>
          </FormSection>
          <FormSection title="Type">
            <div role="radiogroup" aria-label="Type" className="flex flex-wrap gap-2" onKeyDown={(event) => arrows(event, 2, picked.desktop ? 1 : 0, (position) => pick({ desktop: position === 1 }))}>
              <OptionCard title="Server" words="Terminal" glyph={TYPE_GLYPHS.server} selected={!picked.desktop} available={typeAvailable(kinds, picked.os, picked.arch, false)} onClick={() => pick({ desktop: false })} />
              <OptionCard title="Desktop" words="Screen · Terminal · Computer use" glyph={TYPE_GLYPHS.desktop} selected={picked.desktop} available={typeAvailable(kinds, picked.os, picked.arch, true)} onClick={() => pick({ desktop: true })} />
            </div>
            {displayChoice ? (
              // The windowing is a detail of a desktop, as a GPU is of its resources (the operator's notes of 3 October 2026): a dim sub-label under
              // the cards, then the menu, with plain names and no description. Shown only when a system has both; X11 by default, so today's boxes are unchanged (048).
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Display</p>
                <MenuSelect
                  label="Display"
                  value={picked.windowing}
                  options={[
                    { value: "x11", label: "X11" },
                    { value: "wayland", label: "Wayland" },
                  ]}
                  onChange={(value) => pick({ windowing: value as Windowing })}
                />
              </div>
            ) : null}
          </FormSection>
          {kind ? (
            <FormSection title="Resources" description={`Configure the box's cores, memory${gpuChoice ? ", disk and GPU" : " and disk"}: pick a size, or Custom to set your own.`}>
              <div role="radiogroup" aria-label="Size" className="flex flex-wrap gap-2" onKeyDown={(event) => arrows(event, choices.length, sizeIndex, (position) => chooseSize(choices[position]!, true))}>
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
                <div className="grid grid-cols-3 gap-3">
                  {field("cores", "Cores", largest?.cores ?? null)}
                  {field("memoryGiB", "Memory, GiB", largest?.memoryGiB ?? null)}
                  {field("diskGiB", "Disk, GiB", largest?.diskGiB ?? null)}
                </div>
              ) : null}
              {gpuChoice ? (
                // A GPU is a resource: a dim sub-label of its own line under the presets, then the menu (the operator's note of 2 October 2026).
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">GPU</p>
                  <MenuSelect
                    label="GPU"
                    value={picked.gpu ? "1" : "0"}
                    options={[
                      { value: "0", label: "None" },
                      { value: "1", label: "1 GPU" },
                    ]}
                    onChange={(value) => pick({ gpu: value === "1" })}
                  />
                </div>
              ) : null}
            </FormSection>
          ) : null}
          <FormSection title="Provider" description="Where the box goes: the first with room for it, in this order, unless you choose one.">
            {/* The filters: a row of their own under the description, at the left, "Filter" at the menus' text size, wrapping on a narrow pane (the operator's notes of 2 October 2026). */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-2" role="group" aria-label="Filter">
              <span className="text-xs text-muted-foreground">Filter</span>
              <MenuSelect
                label="Kind"
                labelInside
                value={filter}
                options={kindOptions}
                onChange={(value) => {
                  setFilter(value as FormFilter);
                  setOn(null);
                }}
              />
              {filter !== "physical" ? (
                <MenuSelect
                  label="Runs on"
                  labelInside
                  value={effectiveRunsOn}
                  options={runsOnChoiceList}
                  onChange={(value) => {
                    setRunsOn(value as RunsOn);
                    setOn(null);
                  }}
                />
              ) : null}
            </div>
            <div role="radiogroup" aria-label="Provider" className="space-y-2" onKeyDown={(event) => arrows(event, providerValues.length, providerIndex, (position) => { setOn(providerValues[position] ?? null); providerOptions.current[position]?.focus(); })}>
              {!choiceless && shown.length ? (
                <button
                  ref={(element) => {
                    providerOptions.current[0] = element;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={onOffer === null}
                  tabIndex={onOffer === null ? 0 : -1}
                  onClick={() => setOn(null)}
                  className={rowClass(onOffer === null)}
                >
                  <span className="block text-xs font-medium text-foreground">First with room</span>
                  <span className="mt-0.5 block text-2xs text-muted-foreground">{shown.length === 1 ? "The one below" : `Any of the ${shown.length} below, in order`}</span>
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
                  info={profile ? <ProviderInfo offer={offer} loaded={profiles.get(offer.backend)} load={() => loadProfile(offer.backend)} /> : undefined}
                />
              ))}
            </div>
          </FormSection>
          {machine ? (
            <FormSection title="Name">
              <Input
                id="new-machine-name"
                aria-label="Name"
                aria-describedby="new-machine-name-hint"
                placeholder="Optional: bb-box picks a name like calm-tundra"
                className="h-7 px-2 text-xs"
                value={name}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={nameWrong !== null || undefined}
                onChange={(event) => {
                  setName(event.target.value);
                  setProblem(null);
                }}
              />
              <span id="new-machine-name-hint" className="sr-only">
                Optional. If left empty, bb-box picks a name.
              </span>
              {nameWrong ? (
                <p role="alert" className="text-2xs leading-snug text-destructive-text">
                  {nameWrong}
                </p>
              ) : null}
            </FormSection>
          ) : null}
          <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
            {standing ? (
              <p role={problem ? "alert" : undefined} className={cn("min-w-0 text-xs leading-snug", problem ? "text-destructive-text" : "text-muted-foreground")}>
                {standing}
              </p>
            ) : (
              <span />
            )}
            <Button type="submit" size="sm" className="shrink-0" disabled={!kind || making || noMatch || (size === CUSTOM && !custom) || nameWrong !== null}>
              {making ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
              {machine ? "Add machine" : "Create box"}
            </Button>
          </div>
          {askForImage && wanted.os === "linux" ? (
            <p className="text-2xs leading-snug text-muted-foreground">
              This project has no box image, so its boxes start with the standard tools.{" "}
              <button
                type="button"
                className="font-medium text-foreground underline underline-offset-2"
                onClick={() => {
                  setOpen(false);
                  askForImage();
                }}
              >
                Ask an agent to make one
              </button>
            </p>
          ) : null}
        </form>
      </PopoverContent>
    </Popover>
  );
}
