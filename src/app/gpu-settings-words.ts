import { boxesOver } from "../backends/card-limit.ts";
import { GPU_PARTS, type GpuPart } from "../backends/types.ts";
import { backendWholeCards, KINDS_WITH_GPU_DEFAULT, wholeCardsAnywhere, type BackendConfig, type ConfigDocument } from "../core/document.ts";
import { gpuWhenNotAsked } from "../core/gpu.ts";
import type { ConfigState } from "../plugin/configuration.ts";
import type { SettingsCard } from "../plugin/gpu-settings.ts";

export function wholeCardsNow(document: Pick<ConfigDocument, "general">, config: Pick<BackendConfig, "fields">, pending: boolean | null): { readonly on: boolean; readonly fromInstall: boolean } {
  const saved = backendWholeCards(config, document.general);
  return { on: pending ?? saved.on, fromInstall: pending === null && saved.from === "install" };
}

function inWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export function wholeKeptWords(kept: readonly { readonly name: string }[]): string {
  if (!kept.length) return "";
  return ` ${inWords(kept.map((box) => box.name))} ${kept.length === 1 ? "keeps its card" : "keep their cards"} until changed or released.`;
}

export function cardName(index: number | null): string {
  return index === null ? "the card" : `card ${index}`;
}

export function capitalised(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function gib(mib: number): string {
  const value = mib / 1024;
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} GiB`;
}

export function draftLimit(text: unknown): number | null {
  if (text === null || text === undefined || text === "") return null;
  const value = typeof text === "number" ? text : Number(String(text).trim());
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function loweredLimitWords(cards: readonly SettingsCard[], limit: number, saved: number | null, counts: "running" | "running-or-stopped"): string | null {
  if (limit <= 0 || (saved !== null && saved > 0 && limit >= saved)) return null;
  const over = cards.filter((card) => boxesOver(card, limit) > 0);
  if (!over.length) return null;
  const running = counts === "running" ? " running" : "";
  const each = over.map((card) => `${cardName(card.index)} has ${card.counted} ${card.counted === 1 ? "box" : "boxes"}${running}, ${boxesOver(card, limit)} over: ${inWords(card.holders.map((holder) => holder.name))}`);
  return `With ${limit}, ${inWords(each)}. They keep running; no new box goes on a card over the limit until it has room.`;
}

export function readAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
}

export const GPU_CHOICE_LABELS: Readonly<Record<GpuPart, string>> = { none: "None", shared: "Shared", whole: "Whole card" };

export function kindHasGpuDefault(state: Pick<ConfigState, "document" | "drivers">, kind: string): boolean {
  if (!KINDS_WITH_GPU_DEFAULT.includes(kind)) return false;
  const withCards = new Set(state.drivers.filter((driver) => driver.kinds.includes(kind) && driver.fields.some((field) => field.group === "gpus")).map((driver) => driver.type));
  return state.document.backends.some((backend) => withCards.has(backend.type));
}

export function kindGpuChoices(document: Pick<ConfigDocument, "backends" | "general">, current: GpuPart): readonly GpuPart[] {
  return wholeCardsAnywhere(document) || current === "whole" ? GPU_PARTS : GPU_PARTS.filter((part) => part !== "whole");
}

export function kindGpuWords(kind: string, gpu: GpuPart, wholeOn: boolean): string {
  const shipped = gpuWhenNotAsked(kind);
  const lead = "What a box of the kind gets when a request leaves gpu out, and the New box form's first choice until the person's own is remembered.";
  const since = gpu === shipped ? ` ${GPU_CHOICE_LABELS[shipped]} is bb-box's own default for ${kind}.` : "";
  const spares = gpu === "whole" ? " Spare boxes of the kind are made shared: a whole box never takes a spare." : "";
  const off = gpu === "whole" && !wholeOn ? " Whole cards are off on every backend, so a box that leaves gpu out is refused: choose None or Shared, or turn Whole cards on in a backend's GPUs section." : "";
  return `${lead}${since}${spares}${off}`;
}

