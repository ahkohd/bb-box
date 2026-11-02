import type { MouseEvent } from "react";
import { kindNameInSettings } from "../core/largest-words.ts";
import { SettingsLink } from "./settings-link.tsx";

export interface LargestSize {
  readonly cores: number;
  readonly memoryGiB: number;
  readonly diskGiB: number | null;
}

export interface AskedParts {
  readonly cores?: number;
  readonly memoryGiB?: number;
  readonly diskGiB?: number;
}

export const CHANGE_LARGEST_WORDS = "Change it in Settings";

type Part = keyof LargestSize;

const PART_ORDER: readonly Part[] = ["cores", "memoryGiB", "diskGiB"];

function partWords(part: Part, amount: number): string {
  if (part === "cores") return `${amount} ${amount === 1 ? "core" : "cores"}`;
  return `${amount} GiB of ${part === "memoryGiB" ? "memory" : "disk"}`;
}

function listed(words: readonly string[]): string {
  return words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

export function partsAtLargest(largest: LargestSize, asked: AskedParts): Part[] {
  return PART_ORDER.filter((part) => {
    const limit = largest[part];
    const value = asked[part];
    return limit !== null && value !== undefined && value >= limit;
  });
}

export function largestWords(largest: LargestSize, parts: readonly Part[], kindLabel: string): string {
  const amounts = parts.flatMap((part) => (largest[part] === null ? [] : [partWords(part, largest[part]!)]));
  return `Up to ${listed(amounts)}, the largest for ${kindLabel} boxes.`;
}

export function LargestLine({ kind, largest, asked, onFollow }: { kind: string; largest: LargestSize; asked: AskedParts; onFollow?: () => void }) {
  const kindLabel = kindNameInSettings(kind);
  const reached = partsAtLargest(largest, asked);
  const roomFor = largestWords(largest, PART_ORDER, kindLabel);
  const follow = (event: MouseEvent) => {
    if (event.button === 0) onFollow?.();
  };
  return (
    <p className="grid text-xs leading-snug text-muted-foreground" data-largest-line>
      <span aria-hidden className="invisible col-start-1 row-start-1">
        {roomFor} {CHANGE_LARGEST_WORDS}
      </span>
      <span aria-live="polite" className="col-start-1 row-start-1">
        {reached.length ? (
          <>
            {largestWords(largest, reached, kindLabel)}{" "}
            <span onClickCapture={follow}>
              <SettingsLink view={{ page: "kind", id: kind }} className="text-foreground underline underline-offset-2 hover:text-foreground">
                {CHANGE_LARGEST_WORDS}
              </SettingsLink>
            </span>
          </>
        ) : null}
      </span>
    </p>
  );
}
