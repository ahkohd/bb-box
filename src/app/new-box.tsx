// "New box": a popover with one small form, the kind and the size, and one
// button. It remembers the last kind in the browser, keyed by plugin ID.

import { experimental_Icon as Icon, experimental_usePluginId } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { KindView } from "../plugin/views.ts";

function remembered(pluginId: string): string | null {
  try {
    return window.localStorage.getItem(`${pluginId}:new-box:kind`);
  } catch {
    return null;
  }
}

function remember(pluginId: string, kind: string): void {
  try {
    window.localStorage.setItem(`${pluginId}:new-box:kind`, kind);
  } catch {
    // Storage may be off. Then the form starts from the first kind each time.
  }
}

export function NewBox({
  kinds,
  make,
}: {
  kinds: readonly KindView[];
  /** Makes a box; resolves with the refusal to show, or null when the box was made. */
  make: (kind: string) => Promise<string | null>;
}) {
  const pluginId = experimental_usePluginId();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string>(() => remembered(pluginId) ?? "");
  const [making, setMaking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const options = useRef<(HTMLButtonElement | null)[]>([]);
  const kind = kinds.find((candidate) => candidate.id === chosen) ?? kinds[0] ?? null;
  const index = kind ? kinds.indexOf(kind) : -1;

  useEffect(() => {
    if (!open) setProblem(null);
  }, [open]);

  const choose = (next: KindView, focus = false) => {
    setChosen(next.id);
    setProblem(null);
    if (focus) options.current[kinds.indexOf(next)]?.focus();
  };
  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    if (!kinds.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      choose(kinds[(index + step + kinds.length) % kinds.length]!, true);
    }
  };
  const submit = async () => {
    if (!kind || making) return;
    setMaking(true);
    try {
      const refused = await make(kind.id);
      setProblem(refused);
      if (!refused) {
        remember(pluginId, kind.id);
        setOpen(false);
      }
    } finally {
      setMaking(false);
    }
  };

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
            <div role="radiogroup" aria-labelledby="new-box-kind" className="space-y-0.5" onKeyDown={onKey}>
              {kinds.map((candidate, position) => {
                const selected = candidate.id === kind?.id;
                return (
                  <button
                    key={candidate.id}
                    ref={(element) => {
                      options.current[position] = element;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => choose(candidate)}
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
              <p className="mb-1 text-xs text-muted-foreground">Size</p>
              <p className="text-xs text-foreground">{kind.size}</p>
            </div>
          ) : null}
          <Button type="submit" size="sm" className="w-full" disabled={!kind || making}>
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
