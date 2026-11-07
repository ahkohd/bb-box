import { boxesOver, holdingName, overLimitWords } from "../backends/card-limit.ts";
import type { CardInUse, CardsInUse, LimitCounts } from "../backends/types.ts";

export interface SettingsCardHolder {
  readonly box: string | null;
  readonly name: string;
  readonly part: "shared" | "whole";
  readonly running: boolean;
  readonly ours: boolean;
  readonly counts: boolean;
}

export interface SettingsCard {
  readonly uuid: string;
  readonly index: number | null;
  readonly model: string | null;
  readonly totalMiB: number | null;
  readonly freeMiB: number | null;
  readonly outsideMiB: number | null;
  readonly counted: number;
  readonly over: number;
  readonly overWords: string | null;
  readonly holders: readonly SettingsCardHolder[];
}

export type SettingsCards =
  | { readonly is: "none" }
  | { readonly is: "unread"; readonly host: string | null; readonly why: string; readonly setup: string | null }
  | {
      readonly is: "read";
      readonly host: string;
      readonly source: "helper" | "docker";
      readonly at: number | null;
      readonly limit: number | null;
      readonly counts: LimitCounts;
      readonly cards: readonly SettingsCard[];
      readonly wholeKept: readonly { readonly box: string | null; readonly name: string }[];
    };

export interface KnownBox {
  readonly id: string;
  readonly name: string;
  readonly backend: string;
}

function outsideOf(card: CardInUse): number | null {
  if (card.holders.some((holding) => holding.is === "box" || holding.is === "warm")) return null;
  if (card.totalMiB === null || card.freeMiB === null) return null;
  const used = card.totalMiB - card.freeMiB;
  return used > 0 ? used : null;
}

export function settingsCards(inUse: CardsInUse, backend: string, boxes: readonly KnownBox[]): SettingsCards {
  if (inUse.is === "unread") return inUse;
  const ours = boxes.filter((box) => box.backend === backend);
  const idOf = (name: string) => ours.find((box) => box.name === name)?.id ?? null;
  const cards = inUse.cards.map((card): SettingsCard => {
    const over = boxesOver(card, inUse.limit);
    return {
      uuid: card.uuid,
      index: card.index,
      model: card.model,
      totalMiB: card.totalMiB,
      freeMiB: card.freeMiB,
      outsideMiB: outsideOf(card),
      counted: card.counted,
      over,
      overWords: over > 0 && inUse.limit !== null ? overLimitWords(card, inUse.limit, inUse.counts) : null,
      holders: card.holders.map((holding) => ({
        box: holding.is === "box" ? idOf(holding.name) : null,
        name: holdingName(holding),
        part: holding.part,
        running: holding.running,
        ours: holding.is === "box" || holding.is === "warm",
        counts: holding.counts,
      })),
    };
  });
  const wholeKept = cards.flatMap((card) => card.holders.filter((holder) => holder.ours && holder.part === "whole").map((holder) => ({ box: holder.box, name: holder.name })));
  return { is: "read", host: inUse.host, source: inUse.source, at: inUse.at, limit: inUse.limit, counts: inUse.counts, cards, wholeKept };
}
