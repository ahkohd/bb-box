import type { CardHolding, CardInUse } from "./types.ts";

export function cardTitle(index: number | null): string {
  return index === null ? "A card" : `Card ${index}`;
}

export function holdingName(holding: CardHolding): string {
  if (holding.is === "box") return holding.name;
  if (holding.is === "warm") return "a warm box";
  return `${holding.guest} (${holding.is === "other-install" ? "another install's" : "not bb-box's"})`;
}

function inWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export function boxesOver(card: Pick<CardInUse, "counted">, limit: number | null): number {
  return limit === null || limit <= 0 ? 0 : Math.max(0, card.counted - limit);
}

export function overLimitWords(card: Pick<CardInUse, "index" | "counted" | "holders">, limit: number, counts: "running" | "running-or-stopped"): string {
  const title = cardTitle(card.index);
  const name = title === "A card" ? "the card" : title.toLowerCase();
  const boxes = `${card.counted} ${card.counted === 1 ? "box" : "boxes"}${counts === "running" ? " running" : ""}`;
  const named = card.holders.length ? `: ${inWords(card.holders.map(holdingName))}` : "";
  return `${title} has ${boxes}, ${boxesOver(card, limit)} over the limit of ${limit}${named}. They keep running; no new box goes on ${name} until it has room.`;
}
