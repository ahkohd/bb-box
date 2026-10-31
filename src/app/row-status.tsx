import { useEffect, useRef, useState, type FocusEvent } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { StatusDot } from "./common.tsx";
import { WarningGlyph } from "./glyphs.tsx";
import { rowReasons, rowWords, type RowItem, type RowLine } from "./row-line.ts";

const TONE_TEXT: Readonly<Record<NonNullable<RowItem["tone"]>, string>> = { fg: "text-foreground", warn: "text-warning-text", danger: "text-destructive-text" };

export function reasonsId(lineId: string): string {
  return `${lineId}-why`;
}

export function rowDescribedBy(line: RowLine, lineId: string): string {
  return rowReasons(line).length ? `${lineId} ${reasonsId(lineId)}` : lineId;
}

function overflows(element: HTMLElement | null): boolean {
  return !!element && (element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1);
}

function Item({ item, first }: { item: RowItem; first: boolean }) {
  const marked = item.reason !== undefined && (item.tone === "warn" || item.tone === "danger");
  return (
    <span data-row-item className={cn("inline-flex min-w-0 items-start", item.tone ? "" : "whitespace-nowrap", first && "max-w-full")}>
      <span aria-hidden className="w-[1.25em] shrink-0 text-center text-subtle-foreground">
        ·
      </span>
      <span className={cn("min-w-0", first && "truncate", item.tone && TONE_TEXT[item.tone])}>{item.text}</span>
      {marked ? <WarningGlyph data-reason-mark className={cn("ml-1 mt-[0.15em] size-3", TONE_TEXT[item.tone!])} /> : null}
    </span>
  );
}

export function useWakeAt(at: number | null): number {
  const [woken, setWoken] = useState(0);
  useEffect(() => {
    if (at === null) return;
    const wait = at - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => setWoken(Date.now()), wait + 1);
    return () => clearTimeout(timer);
  }, [at]);
  return woken;
}

function focusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

export function useNameFocus(): { readonly focused: boolean; readonly onFocus: (event: FocusEvent<HTMLElement>) => void; readonly onBlur: () => void } {
  const [focused, setFocused] = useState(false);
  return { focused, onFocus: (event) => setFocused(focusVisible(event.currentTarget)), onBlur: () => setFocused(false) };
}

export function RowStatus({ line, id, nameFocused = false }: { line: RowLine; id: string; nameFocused?: boolean }) {
  const shown = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [cut, setCut] = useState(false);
  const reasons = rowReasons(line);
  const tells = (isCut: boolean) => isCut || reasons.length > 0;
  useEffect(() => {
    setDismissed(false);
    if (nameFocused) setCut(overflows(shown.current));
  }, [nameFocused]);
  const onOpenChange = (next: boolean) => {
    const isCut = overflows(shown.current);
    setCut(isCut);
    setHovered(next && tells(isCut));
    if (!next && nameFocused) setDismissed(true);
  };
  const open = hovered || (nameFocused && !dismissed && tells(cut));
  return (
    <div className="mt-0.5 flex min-w-0 items-start gap-1.5 text-xs leading-snug text-muted-foreground">
      <StatusDot tone={line.tone} className="motion-reduce:[&_*]:animate-none" />
      <TooltipProvider delayDuration={250}>
        <Tooltip open={open} onOpenChange={onOpenChange}>
          <TooltipTrigger asChild>
            <span ref={shown} id={id} data-row-line className="block max-h-[2.75em] min-w-0 overflow-hidden">
              <span className="-ml-[1.25em] flex min-w-0 flex-wrap items-start">
                {line.items.map((item, index) => (
                  <Item key={`${index}:${item.text}`} item={item} first={index === 0} />
                ))}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="start" className="max-w-sm space-y-1">
            {cut ? <p>{rowWords(line)}</p> : null}
            {reasons.map((reason) => (
              <p key={reason}>{reason}</p>
            ))}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {reasons.length ? (
        <span id={reasonsId(id)} className="sr-only">
          {reasons.join(" ")}
        </span>
      ) : null}
    </div>
  );
}
