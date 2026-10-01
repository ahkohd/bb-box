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
import { KindBadges } from "./common.tsx";
import { groupKinds, kindHasDocker, KindDetail, kindTitle, OfferMarks } from "./kind-picker.tsx";

/** What the acquire RPC takes: a preset, or the parts of a custom size. Nothing for the kind's default. */
export interface SizeRequest {
  readonly preset?: string;
  readonly cores?: number;
  readonly memoryGiB?: number;
  readonly diskGiB?: number;
}

type Choice = string;
const CUSTOM: Choice = "custom";

interface Fields {
  readonly cores: string;
  readonly memoryGiB: string;
  readonly diskGiB: string;
}

interface Remembered {
  readonly kind?: string;
  readonly size?: Choice;
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

/** The detail pane's element, which each kind option describes itself by. */
const DETAIL_ID = "new-box-kind-detail";

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
  make: (kind: string, size?: SizeRequest, name?: string) => Promise<string | null>;
  /** "Add machine": a labelled button, and a Name field, for one of your machines (036). */
  machine?: boolean;
}) {
  const pluginId = experimental_usePluginId();
  const [open, setOpen] = useState(false);
  const [last] = useState(() => remembered(`${pluginId}:${machine ? "new-machine" : "new-box"}`));
  const [name, setName] = useState("");
  const [chosenKind, setChosenKind] = useState<string>(last.kind ?? "");
  const [choice, setChoice] = useState<Choice | null>(last.size ?? null);
  /** The preset last chosen, which Custom starts from. */
  const [viewed, setViewed] = useState<string | null>(last.size && last.size !== CUSTOM ? last.size : null);
  // Custom fields belong to a kind: edited ones are kept per kind, and a
  // kind without edits starts from its own preset in view.
  const [edited, setEdited] = useState<Readonly<Record<string, Fields>>>(() => (last.custom && typeof last.custom === "object" ? last.custom : {}));
  const [making, setMaking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const kindOptions = useRef<(HTMLButtonElement | null)[]>([]);
  const sizeOptions = useRef<(HTMLButtonElement | null)[]>([]);

  /** The kind under the pointer or the keyboard focus, which the pane shows; the chosen kind otherwise. */
  const [peek, setPeek] = useState<string | null>(null);
  const groups = groupKinds(kinds);
  const ordered = groups.flatMap((group) => group.kinds);

  const kind = kinds.find((candidate) => candidate.id === chosenKind) ?? ordered[0] ?? null;
  const kindIndex = kind ? ordered.indexOf(kind) : -1;
  const shown = ordered.find((candidate) => candidate.id === peek) ?? kind;
  const presets = kind?.presets ?? [];
  const choices: Choice[] = [...presets.map((preset) => preset.name), CUSTOM];
  const size: Choice = choice && choices.includes(choice) ? choice : (kind?.defaultPreset ?? CUSTOM);
  const preset = presets.find((candidate) => candidate.name === size) ?? null;
  // The preset Custom starts from: the one chosen last, else the kind's default.
  const inView = preset ?? presets.find((candidate) => candidate.name === viewed) ?? presets.find((candidate) => candidate.name === kind?.defaultPreset) ?? null;
  const fields: Fields = (kind && edited[kind.id]) ?? (inView ? fieldsOf(inView) : { cores: "", memoryGiB: "", diskGiB: "" });
  const custom = size === CUSTOM ? customSize(fields) : null;
  const sizeIndex = choices.indexOf(size);

  useEffect(() => {
    if (!open) setProblem(null);
  }, [open]);

  const chooseKind = (next: KindView, focus = false) => {
    setChosenKind(next.id);
    setProblem(null);
    if (focus) kindOptions.current[ordered.indexOf(next)]?.focus();
  };
  const chooseSize = (next: Choice, focus = false) => {
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
  const submit = async () => {
    if (!kind || making || (size === CUSTOM && !custom) || nameWrong) return;
    setMaking(true);
    try {
      const request: SizeRequest | undefined = size === CUSTOM ? (custom ?? undefined) : size === kind.defaultPreset ? undefined : { preset: size };
      const refused = await make(kind.id, request, machine && typedName ? typedName : undefined);
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
      <PopoverContent align="end" className="w-80 p-4 sm:w-[640px]" mobileTitle={machine ? "Add machine" : "New box"}>
        {/* Two columns when there is room: the detail pane left of the list, as the operator asked; stacked under it otherwise. */}
        <form
          className="space-y-3 sm:grid sm:grid-cols-[240px_minmax(0,1fr)] sm:gap-x-4 sm:gap-y-3 sm:space-y-0"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="sm:col-start-2 sm:row-start-1">
            <p id="new-box-kind" className="mb-1.5 text-xs font-medium text-foreground">
              Kind
              {machine ? <span className="ml-1.5 font-normal text-muted-foreground">of the ones whose boxes join BB</span> : null}
            </p>
            <div
              role="radiogroup"
              aria-labelledby="new-box-kind"
              className="space-y-0.5"
              onKeyDown={(event) => arrows(event, ordered.length, kindIndex, (position) => chooseKind(ordered[position]!, true))}
              onMouseLeave={() => setPeek(null)}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPeek(null);
              }}
            >
              {groups.map((group, index) => (
                <div key={group.os} role="group" aria-label={group.label}>
                  <p className={cn("px-2 pb-0.5 text-2xs font-medium text-subtle-foreground", index === 0 ? "pt-0" : "pt-1.5")}>{group.label}</p>
                  {group.kinds.map((candidate) => {
                    const position = ordered.indexOf(candidate);
                    const selected = candidate.id === kind?.id;
                    return (
                      <button
                        key={candidate.id}
                        ref={(element) => {
                          kindOptions.current[position] = element;
                        }}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-describedby={DETAIL_ID}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => chooseKind(candidate)}
                        onMouseEnter={() => setPeek(candidate.id)}
                        onFocus={() => setPeek(candidate.id)}
                        className={cn(
                          "grid w-full grid-cols-[1rem_minmax(0,1fr)_auto_1rem] items-start gap-2 rounded-sm px-2 py-1.5 text-left outline-none hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring",
                          selected && "bg-state-active",
                        )}
                      >
                        <Icon name={`${pluginId}/${candidate.desktop ? "monitor" : "server"}`} className="size-4 text-muted-foreground" aria-hidden />
                        <span className="min-w-0">
                          <span className="block truncate text-xs text-foreground">{kindTitle(candidate)}</span>
                          {/* Badges on a line of their own: what the boxes are, and whether one is ready; the title says the rest. */}
                          <KindBadges gpu={false} noDocker={!kindHasDocker(candidate)} forms={candidate.forms} ready={candidate.spares.ready > 0} className="mt-0.5 flex-wrap" />
                        </span>
                        <OfferMarks offers={candidate.offers} pluginId={pluginId} />
                        {selected ? <Icon name="Check" className="size-4 text-foreground" aria-hidden /> : <span />}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
          {shown ? (
            <div className="sm:col-start-1 sm:row-span-4 sm:row-start-1 sm:border-r sm:border-border sm:pr-4">
              <KindDetail kind={shown} pluginId={pluginId} id={DETAIL_ID} />
            </div>
          ) : null}
          {kind ? (
            <div className="sm:col-start-2">
              <p id="new-box-size" className="mb-1.5 text-xs font-medium text-foreground">
                Size
              </p>
              <div role="radiogroup" aria-labelledby="new-box-size" className="flex gap-1" onKeyDown={(event) => arrows(event, choices.length, sizeIndex, (position) => chooseSize(choices[position]!, true))}>
                {choices.map((candidate, position) => {
                  const selected = candidate === size;
                  return (
                    <button
                      key={candidate}
                      ref={(element) => {
                        sizeOptions.current[position] = element;
                      }}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      tabIndex={selected ? 0 : -1}
                      onClick={() => chooseSize(candidate)}
                      className={cn(
                        "h-7 min-w-0 flex-1 rounded-md border border-input px-2 text-xs font-medium text-foreground outline-none hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring",
                        selected && "border-transparent bg-foreground text-background hover:bg-foreground/90",
                      )}
                    >
                      {PRESET_LABELS[candidate] ?? (candidate === CUSTOM ? "Custom" : candidate)}
                    </button>
                  );
                })}
              </div>
              {preset ? (
                <p className="mt-1.5 text-xs leading-snug text-subtle-foreground">{sizeLine(preset)}</p>
              ) : (
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {field("cores", "Cores", largest?.cores ?? null)}
                  {field("memoryGiB", "Memory, GiB", largest?.memoryGiB ?? null)}
                  {field("diskGiB", "Disk, GiB", largest?.diskGiB ?? null)}
                </div>
              )}
            </div>
          ) : null}
          {machine ? (
            <div className="sm:col-start-2">
              <label htmlFor="new-machine-name" className="mb-1.5 block text-xs font-medium text-foreground">
                Name
              </label>
              <Input
                id="new-machine-name"
                className="h-7 px-2 text-xs"
                value={name}
                placeholder="a name, or leave it to bb-box"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={nameWrong !== null || undefined}
                onChange={(event) => {
                  setName(event.target.value);
                  setProblem(null);
                }}
              />
              {nameWrong ? (
                <p role="alert" className="mt-1 text-xs leading-snug text-destructive-text">
                  {nameWrong}
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="space-y-3 sm:col-start-2">
            <Button type="submit" size="sm" className="w-full" disabled={!kind || making || (size === CUSTOM && !custom) || nameWrong !== null}>
              {making ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
              {machine ? "Add" : "Create"}
            </Button>
            {problem ? (
              <p role="alert" className="text-xs leading-snug text-destructive-text">
                {problem}
              </p>
            ) : null}
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
