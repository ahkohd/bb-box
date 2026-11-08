import { useEffect, useRef } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export interface FindBarProps {
  query: string;
  onQueryChange: (next: string) => void;
  caseSensitive: boolean;
  onCaseSensitiveChange: (next: boolean) => void;

  index: number;
  total: number;
  truncated: boolean;
  onStep: (direction: 1 | -1) => void;
  onClose: () => void;

  focusRequest: number;
}

export function FindBar({
  query,
  onQueryChange,
  caseSensitive,
  onCaseSensitiveChange,
  index,
  total,
  truncated,
  onStep,
  onClose,
  focusRequest,
}: FindBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    input.focus();

    input.select();
  }, [focusRequest]);

  const hasQuery = query !== "";
  const status = !hasQuery
    ? ""
    : total === 0
      ? "No results"
      : `${index + 1} of ${total}${truncated ? "+" : ""}`;

  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-surface-recessed px-2 py-1.5">
      <div className="relative flex min-w-0 flex-1 items-center">
        <Icon
          name="Search"
          aria-hidden
          className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground"
        />
        <input
          ref={inputRef}
          value={query}
          type="text"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="Find in file"
          aria-label="Find in file"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {

            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              onStep(event.shiftKey ? -1 : 1);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
          className={cn(
            "h-7 w-full min-w-0 rounded-md border border-border bg-background",
            "pr-2 pl-7 text-xs text-foreground placeholder:text-muted-foreground",
            "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
          )}
        />
      </div>

      <button
        type="button"
        aria-label="Match case"
        aria-pressed={caseSensitive}
        title="Match case"
        onClick={() => onCaseSensitiveChange(!caseSensitive)}
        className={cn(
          "h-6 w-6 shrink-0 cursor-pointer rounded font-mono text-[11px] leading-none",
          "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
          caseSensitive
            ? "bg-foreground/10 text-foreground"
            : "text-muted-foreground hover:bg-foreground/5",
        )}
      >
        Aa
      </button>

      <span
        role="status"
        className="w-[5.5rem] shrink-0 text-right text-[11px] tabular-nums text-muted-foreground"
      >
        {status}
      </span>

      <StepButton
        icon="ChevronUp"
        label="Previous match"
        disabled={total === 0}
        onClick={() => onStep(-1)}
      />
      <StepButton
        icon="ChevronDown"
        label="Next match"
        disabled={total === 0}
        onClick={() => onStep(1)}
      />
      <StepButton icon="X" label="Close find" onClick={onClose} />
    </div>
  );
}

function StepButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: "ChevronUp" | "ChevronDown" | "X";
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded",
        "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        "disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent",
      )}
    >
      <Icon name={icon} aria-hidden className="size-3.5" />
    </button>
  );
}
