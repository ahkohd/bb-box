import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { basename, dirname, rankEntries, type FlatEntry } from "./tree.ts";
import { FileGlyph } from "./FileGlyph.tsx";

const RESULT_LIMIT = 60;

export function QuickOpen({
  entries,
  filling = false,
  truncated = false,
  partial = false,
  error = null,
  onOpenFile,
  onClose,
}: {
  entries: readonly FlatEntry[];
  filling?: boolean;
  truncated?: boolean;
  partial?: boolean;
  error?: string | null;
  onOpenFile: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const listRef = useRef<HTMLUListElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const previous = document.activeElement;
    inputRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus();
      }
    };
  }, []);

  const files = useMemo(
    () => entries.filter((entry) => entry.kind === "file"),
    [entries],
  );

  const results = useMemo(() => {
    if (query.trim() === "") return files.slice(0, RESULT_LIMIT);
    return rankEntries(files, query, RESULT_LIMIT).matches;
  }, [files, query]);

  useEffect(() => setHighlighted(0), [query]);

  useEffect(() => {
    const row = listRef.current?.children[highlighted];
    if (row instanceof HTMLElement) row.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  const commit = (index: number) => {
    const match = results[index];
    if (match === undefined) return;
    onOpenFile(match.path);
    onClose();
  };

  return (
    <div
      className="absolute inset-0 z-20 flex justify-center bg-surface-scrim pt-[10vh]"

      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Quick open"
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;

          event.preventDefault();
          const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
            "input, button",
          );
          if (focusable === undefined || focusable.length === 0) return;
          const list = Array.from(focusable);
          const index = list.indexOf(document.activeElement as HTMLElement);
          const step = event.shiftKey ? -1 : 1;
          const next = list[(index + step + list.length) % list.length];
          next?.focus();
        }}
        className="flex max-h-[70%] w-[min(36rem,90%)] flex-col overflow-hidden rounded-lg border border-border bg-popover"
      >
        {error !== null && !filling ? <p role="status" className="px-3 py-1 text-xs text-destructive-text">{error}</p> : null}
        {partial && !filling ? <p role="status" className="px-3 py-1 text-xs text-muted-foreground">Some folders could not be read. Try a smaller folder.</p> : null}
        {truncated && !filling ? <p role="status" className="px-3 py-1 text-xs text-muted-foreground">Showing the first 20,000 names. Open a smaller folder to find more.</p> : null}
        {filling ? <p role="status" className="px-3 py-1 text-xs text-muted-foreground">File names are still filling.</p> : null}
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Icon name="Search" aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            spellCheck={false}
            placeholder="Go to file..."
            aria-label="Go to file"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onClose();
                return;
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setHighlighted((current) =>
                  results.length === 0 ? 0 : (current + 1) % results.length,
                );
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setHighlighted((current) =>
                  results.length === 0
                    ? 0
                    : (current - 1 + results.length) % results.length,
                );
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                commit(highlighted);
              }
            }}
            className="h-11 min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none"
          />
        </div>

        <ul ref={listRef} className="min-h-0 flex-1 overflow-auto py-1">
          {results.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted-foreground">
              No file matches "{query}".
            </li>
          ) : (
            results.map((match, index) => {
              const directory = dirname(match.path);
              return (
                <li key={match.path}>
                  <button
                    type="button"
                    onMouseEnter={() => setHighlighted(index)}
                    onClick={() => commit(index)}
                    className={cn(
                      "flex w-full cursor-pointer items-baseline gap-2 px-3 py-1.5 text-left text-[13px]",
                      index === highlighted
                        ? "bg-surface-selected text-foreground"
                        : "text-foreground/90",
                    )}
                  >
                    <FileGlyph
                      path={match.path}
                      kind="file"
                      className="translate-y-0.5"
                    />
                    <span className="truncate">{basename(match.path)}</span>
                    {directory === "" ? null : (
                      <span className="truncate text-xs text-muted-foreground">
                        {directory}
                      </span>
                    )}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
