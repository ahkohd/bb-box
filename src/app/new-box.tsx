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

function remembered(pluginId: string): Remembered {
  try {
    return JSON.parse(window.localStorage.getItem(`${pluginId}:new-box`) ?? "{}") as Remembered;
  } catch {
    return {};
  }
}

function remember(pluginId: string, value: Remembered): void {
  try {
    window.localStorage.setItem(`${pluginId}:new-box`, JSON.stringify(value));
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

export function NewBox({
  kinds,
  make,
}: {
  kinds: readonly KindView[];
  /** Makes a box; resolves with the refusal to show, or null when the box was made. */
  make: (kind: string, size?: SizeRequest) => Promise<string | null>;
}) {
  const pluginId = experimental_usePluginId();
  const [open, setOpen] = useState(false);
  const [last] = useState(() => remembered(pluginId));
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

  const kind = kinds.find((candidate) => candidate.id === chosenKind) ?? kinds[0] ?? null;
  const kindIndex = kind ? kinds.indexOf(kind) : -1;
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
    if (focus) kindOptions.current[kinds.indexOf(next)]?.focus();
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
  const submit = async () => {
    if (!kind || making || (size === CUSTOM && !custom)) return;
    setMaking(true);
    try {
      const request: SizeRequest | undefined = size === CUSTOM ? (custom ?? undefined) : size === kind.defaultPreset ? undefined : { preset: size };
      const refused = await make(kind.id, request);
      setProblem(refused);
      if (!refused) {
        remember(pluginId, { kind: kind.id, size, ...(Object.keys(edited).length ? { custom: edited } : {}) });
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
      <PopoverContent align="end" className="w-80 p-4" mobileTitle="New box">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div>
            <p id="new-box-kind" className="mb-1.5 text-xs font-medium text-foreground">
              Kind:
            </p>
            <div role="radiogroup" aria-labelledby="new-box-kind" className="space-y-0.5" onKeyDown={(event) => arrows(event, kinds.length, kindIndex, (position) => chooseKind(kinds[position]!, true))}>
              {kinds.map((candidate, position) => {
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
                    tabIndex={selected ? 0 : -1}
                    onClick={() => chooseKind(candidate)}
                    className={cn(
                      "grid w-full grid-cols-[1rem_minmax(0,1fr)_1rem] items-start gap-2 rounded-sm px-2 py-1.5 text-left outline-none hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring",
                      selected && "bg-state-active",
                    )}
                  >
                    <Icon name={`${pluginId}/${candidate.desktop ? "monitor" : "server"}`} className="size-4 text-muted-foreground" aria-hidden />
                    <span className="min-w-0">
                      <span className="block truncate text-xs text-foreground">{candidate.label}</span>
                      {/* Badges on a line of their own, so a kind with several never squeezes its name. */}
                      <KindBadges gpu={candidate.gpu} forms={candidate.forms} ready={candidate.spares.ready > 0} className="mt-1 flex flex-wrap" />
                    </span>
                    {selected ? <Icon name="Check" className="size-4 text-foreground" aria-hidden /> : <span />}
                  </button>
                );
              })}
            </div>
          </div>
          {kind ? (
            <div>
              <p id="new-box-size" className="mb-1.5 text-xs font-medium text-foreground">
                Size:
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
          <Button type="submit" size="sm" className="w-full" disabled={!kind || making || (size === CUSTOM && !custom)}>
            {making ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
            Create
          </Button>
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
