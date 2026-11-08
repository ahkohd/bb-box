import type { GpuCard, GpuProcess, GpuReading } from "../monitor/snapshot.ts";
import { PRODUCT } from "./product.ts";

export type BytesWords = (bytes: number) => string;

export function cardName(card: Pick<GpuCard, "index">, cards: number): string {
  return cards > 1 ? `GPU ${card.index}` : "GPU";
}

export function cardLabel(card: Pick<GpuCard, "index" | "shared">, cards: number): string {
  return card.shared ? `${cardName(card, cards)}, whole card` : cardName(card, cards);
}

export function cardMemoryWords(card: Pick<GpuCard, "memoryUsedBytes" | "memoryTotalBytes">, bytes: BytesWords): string | null {
  const { memoryUsedBytes: used, memoryTotalBytes: total } = card;
  if (used === null && total === null) return null;
  if (total === null) return `${bytes(used!)} used`;
  if (used === null) return `of ${bytes(total)}`;
  const [usedValue, usedUnit] = bytes(used).split(" ");
  const [totalValue, totalUnit] = bytes(total).split(" ");
  return usedUnit === totalUnit ? `${usedValue} of ${totalValue} ${totalUnit}` : `${bytes(used)} of ${bytes(total)}`;
}

export function wattsWords(watts: number | null): string | null {
  if (watts === null) return null;
  return `${watts < 10 ? watts.toFixed(1) : Math.round(watts)} W`;
}

export function powerWords(card: Pick<GpuCard, "powerWatts" | "powerLimitWatts">): string | null {
  const draw = wattsWords(card.powerWatts);
  if (draw === null) return null;
  return card.powerLimitWatts === null ? draw : `${draw} of ${wattsWords(card.powerLimitWatts)}`;
}

export function cardFoot(card: GpuCard, bytes: BytesWords, own = true): string {
  if (card.shared && own) {
    const used = card.memoryUsedBytes === null ? null : bytes(card.memoryUsedBytes);
    if (card.ownMemoryBytes === null) return used ? `Whole card: ${used} used` : "Whole card";
    return used ? `This box: ${bytes(card.ownMemoryBytes)} of ${used}` : `This box: ${bytes(card.ownMemoryBytes)}`;
  }
  return [cardMemoryWords(card, bytes), wattsWords(card.powerWatts)].filter(Boolean).join(" · ") || "Read";
}

export const SHARED_PILL = "shared card";

export function sharedCardWords(card: GpuCard, cards: number, bytes: BytesWords): string {
  const own = card.ownProcesses === null || card.ownMemoryBytes === null
    ? `${PRODUCT} could not read which of its processes are this box's.`
    : card.ownProcesses === 0
      ? "None of this box's processes use it now."
      : `This box's own ${card.ownProcesses === 1 ? "process uses" : `${card.ownProcesses} processes use`} ${bytes(card.ownMemoryBytes)} of its memory.`;
  const which = cards > 1 ? cardName(card, cards) : "its GPU";
  return `This box shares ${which} with other boxes or the host. Its numbers are the whole card's, every user's together. ${own} ${PRODUCT} cannot tell how much of the card's use is this box's, so a shared card never makes this box busy.`;
}

export function processesOnCard(reading: GpuReading | null | undefined, card: number): GpuProcess[] {
  return reading?.processes?.filter((process) => process.card === card) ?? [];
}

export function gpuMemoryOf(reading: GpuReading | null | undefined, pid: number): number | null {
  const own = reading?.processes?.filter((process) => process.pid === pid) ?? [];
  return own.length ? own.reduce((sum, process) => sum + (process.memoryBytes ?? 0), 0) : null;
}


export function cardSlots(read: readonly number[], expected: number): number[] {
  return [...new Set([...Array.from({ length: expected }, (_, slot) => slot), ...read])].sort((left, right) => left - right);
}
