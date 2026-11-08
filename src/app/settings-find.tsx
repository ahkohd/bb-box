import { experimental_Icon as Icon, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Contract } from "../plugin/contract.ts";
import { DESKTOP_PAGE, MACHINES_TAB } from "./desktop.tsx";
import { useSettings } from "./settings-context.tsx";
import { FIND_SHOWN, pathFor, searchSettings, settingsIndex, type FindEntry } from "./settings-find-index.ts";
import { knownStandardImages, rememberStandardImages, type StandardImage } from "./settings-images.tsx";

export const FIND_ROW = "find-a-setting";

let keptQuery = "";

export function forgetFindQuery(): void {
  keptQuery = "";
}

function countWords(total: number): string {
  if (!total) return "No setting matches";
  const matches = `${total} ${total === 1 ? "setting matches" : "settings match"}`;
  return total > FIND_SHOWN ? `${matches}; the first ${FIND_SHOWN} are listed` : matches;
}

function hint(total: number, query: string): string {
  if (!total) return `No setting matches “${query.trim()}”. Try a word from its label, such as memory, template or spares.`;
  const count = `${total} ${total === 1 ? "match" : "matches"}`;
  return total > FIND_SHOWN ? `${count}, the first ${FIND_SHOWN} listed; add a word to narrow them` : `${count} · ↑ ↓ to move, Enter to open, Esc to clear`;
}

function useStandardImagesOnFocus(): { readonly images: readonly StandardImage[]; readonly ask: () => void } {
  const rpc = useRpc<Contract>();
  const [images, setImages] = useState<readonly StandardImage[]>(() => knownStandardImages() ?? []);
  const asked = useRef(false);
  const ask = () => {
    if (asked.current) return;
    asked.current = true;
    rpc.call("images.list").then(
      (answer) => {
        rememberStandardImages(answer.images);
        setImages(answer.images);
      },
      () => undefined,
    );
  };
  return { images, ask };
}

export function FindSettings({ wide = false }: { wide?: boolean }) {
  const { state, nav } = useSettings();
  const navigate = useBbNavigate();
  const [query, setQuery] = useState(() => keptQuery);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const standard = useStandardImagesOnFocus();
  const index = useMemo(() => settingsIndex(state, standard.images), [state, standard.images]);
  const results = useMemo(() => searchSettings(index, query), [index, query]);
  const shown = results.slice(0, FIND_SHOWN);
  const typed = query.trim() !== "";
  const listed = open && typed;
  const at = Math.min(active, Math.max(0, shown.length - 1));
  const optionId = (place: number) => `${listId}-option-${place}`;

  useLayoutEffect(() => {
    if (!listed) return;
    list.current?.querySelector<HTMLElement>(`[data-find-option="${at}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [listed, at]);

  const change = (next: string) => {
    keptQuery = next;
    setQuery(next);
    setActive(0);
    setOpen(true);
  };

  const choose = (found: FindEntry) => {
    setOpen(false);
    if ("machinesTab" in found.opens) {
      navigate.toPluginPanel(DESKTOP_PAGE, { subPath: MACHINES_TAB });
      return;
    }
    nav.find(found.opens.view, FIND_ROW, pathFor(found, query));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!typed) return;
      if (!open) {
        setOpen(true);
        return;
      }
      const last = Math.max(0, shown.length - 1);
      setActive(event.key === "ArrowDown" ? Math.min(at + 1, last) : Math.max(at - 1, 0));
    } else if (event.key === "Enter") {
      const found = listed ? shown[at] : undefined;
      if (!found) return;
      event.preventDefault();
      choose(found);
    } else if (event.key === "Escape") {
      if (!query) return;
      event.preventDefault();
      event.stopPropagation();
      change("");
    }
  };

  return (
    <div className={cn("relative min-w-0", wide ? "w-full" : "w-full sm:w-72")}>
      <Icon name="Search" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input
        ref={input}
        type="text"
        role="combobox"
        data-row-key={FIND_ROW}
        aria-label="Find a setting"
        aria-expanded={listed}
        aria-controls={listed ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={listed && shown.length ? optionId(at) : undefined}
        autoComplete="off"
        spellCheck={false}
        className={cn("h-8 truncate pl-8 text-sm focus:border-ring/60 focus:text-clip focus:ring-2 focus:ring-ring/20 focus-visible:ring-2 focus-visible:ring-ring/20", query && "pr-8")}
        placeholder="Find a setting: memory, template, tailnet…"
        value={query}
        onChange={(event) => change(event.target.value)}
        onFocus={() => {
          setOpen(true);
          standard.ask();
        }}
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {query ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Clear search"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            change("");
            input.current?.focus();
          }}
          className="absolute right-2 top-1/2 flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
        >
          <Icon name="X" className="size-3.5" aria-hidden />
        </button>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {typed ? countWords(results.length) : ""}
      </span>
      {listed ? (
        <div className={cn("absolute top-full z-30 mt-1 overflow-hidden rounded-lg border border-border bg-popover", wide ? "inset-x-0" : "right-0 w-[min(28rem,calc(100vw-2rem))]")}>
          <p className={cn("px-3 py-1.5 text-2xs text-subtle-foreground", shown.length && "border-b border-border")} aria-hidden>
            {hint(results.length, query)}
          </p>
          {shown.length ? (
            <ul ref={list} id={listId} role="listbox" aria-label="Settings that match" className="max-h-80 overflow-y-auto py-1">
              {shown.map((found, place) => (
                <li
                  key={found.key}
                  id={optionId(place)}
                  role="option"
                  aria-selected={place === at}
                  data-find-option={place}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    choose(found);
                  }}
                  onMouseMove={() => setActive(place)}
                  className={cn("flex cursor-pointer items-start gap-3 px-3 py-1.5", place === at && "bg-state-hover")}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-foreground">{found.label}</span>
                    <span className="block truncate text-2xs text-subtle-foreground">{found.where}</span>
                  </span>
                  {found.value ? <span className="max-w-[45%] shrink-0 truncate pt-px text-right text-2xs text-muted-foreground">{found.value}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
