// "New box": a popover with one small form, the kind and the size, and one
// button. The size is a preset, or a custom one within the kind's largest
// (028). It remembers the last kind and size in the browser, keyed by
// plugin ID.

import { experimental_Icon as Icon, experimental_usePluginId } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { KindView, SizeView } from "../plugin/views.ts";

/** What the acquire RPC takes: a preset, or the parts of a custom size. Nothing for the kind's default. */
export interface SizeRequest {
  readonly preset?: string;
  readonly cores?: number;
  readonly memoryGiB?: number;
  readonly diskGiB?: number;
}

type Choice = string;
const CUSTOM: Choice = "custom";

interface Remembered {
  readonly kind?: string;
  readonly size?: Choice;
  readonly custom?: { readonly cores?: string; readonly memoryGiB?: string; readonly diskGiB?: string };
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

/** The custom size's fields as the RPC takes them, or null when a field is not a whole number. */
export function customSize(fields: { cores: string; memoryGiB: string; diskGiB: string }): SizeRequest | null {
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
  const [fields, setFields] = useState({ cores: last.custom?.cores ?? "", memoryGiB: last.custom?.memoryGiB ?? "", diskGiB: last.custom?.diskGiB ?? "" });
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
    setProblem(null);
    if (next === CUSTOM && kind && !fields.cores && !fields.memoryGiB && !fields.diskGiB) {
      // Custom starts from the preset the person was looking at.
      const from = preset ?? presets.find((candidate) => candidate.name === kind.defaultPreset);
      if (from) setFields({ cores: String(from.cores), memoryGiB: String(from.memoryGiB), diskGiB: from.diskGiB === null ? "" : String(from.diskGiB) });
    }
    if (focus) sizeOptions.current[choices.indexOf(next)]?.focus();
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
        remember(pluginId, { kind: kind.id, size, custom: size === CUSTOM ? fields : undefined });
        setOpen(false);
      }
    } finally {
      setMaking(false);
    }
  };

  const largest = kind?.largest ?? null;
  const field = (name: "cores" | "memoryGiB" | "diskGiB", label: string, limit: number | null) => (
    <label className="flex min-w-0 flex-col gap-1 text-2xs text-muted-foreground">
      <span>{label}</span>
      <Input
        inputMode="numeric"
        className="h-7 px-2 text-xs"
        value={fields[name]}
        placeholder={name === "diskGiB" ? "base" : ""}
        aria-invalid={whole(fields[name]) === undefined || undefined}
        onChange={(event) => {
          setFields((current) => ({ ...current, [name]: event.target.value }));
          setProblem(null);
        }}
      />
      {limit !== null ? <span>up to {limit}</span> : null}
    </label>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={!kinds.length}>
          <Icon name="Plus" aria-hidden />
          New box
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-4" mobileTitle="New box">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p className="text-sm font-medium text-foreground">New box</p>
          <div>
            <p id="new-box-kind" className="mb-1.5 text-xs text-muted-foreground">
              Kind
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
                    <Icon name={`${pluginId}/${candidate.desktop ? "monitor" : "server"}`} className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
                    <span className="min-w-0">
                      <span className="block text-xs text-foreground">{candidate.label}</span>
                      <span className="block text-2xs leading-snug text-muted-foreground">{candidate.description}</span>
                    </span>
                    {selected ? <Icon name="Check" className="mt-0.5 size-4 text-foreground" aria-hidden /> : <span />}
                  </button>
                );
              })}
            </div>
          </div>
          {kind ? (
            <div>
              <p id="new-box-size" className="mb-1.5 text-xs text-muted-foreground">
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
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {sizeLine(preset)}
                  {preset.name === kind.defaultPreset ? " · the default" : ""}
                </p>
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
            Make box
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
