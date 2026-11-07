import type { GpuPart, GpuResizing, GpuRoom, CardRoom } from "../backends/types.ts";

export const GPU_LINE_CLASS = "h-[3lh] overflow-hidden text-xs leading-snug @sm:h-[2lh]";

export const GPU_MENU_LABELS: Readonly<Record<GpuPart, string>> = { none: "None", shared: "Shared", whole: "Whole card" };

const DOCKER_REACH = "Boxes with Docker in them can still open every card.";

export interface GpuFormOffer {
  readonly host: string;
  readonly label: string;
  readonly gpuParts?: readonly GpuPart[] | null;
  readonly gpuRoom: GpuRoom | null;
  readonly unread: boolean;
  readonly failed?: boolean;
  readonly spare?: boolean;
  readonly reachesEveryCard: boolean;
  readonly canAddGpu: boolean;
  readonly addKnown?: boolean;
}

export type GpuLineState = "reading" | "none" | "shared" | "whole" | "refused" | "failed";

export interface GpuLine {
  readonly words: string;
  readonly blocked: boolean;
  readonly state: GpuLineState;
}

export function gpuMenuShows(kind: { readonly os: string; readonly arch: string; readonly desktop: boolean; readonly windowing: string } | null, offers: readonly GpuFormOffer[]): boolean {
  if (!kind || kind.os !== "linux" || kind.arch !== "x86_64") return false;
  if (kind.desktop && kind.windowing !== "x11") return false;
  return offers.some(hasCards);
}

export function gpuMenuParts(offers: readonly GpuFormOffer[], noneForCpuKind = false): readonly GpuPart[] {
  const listed = offers.flatMap((offer) => [...partsOf(offer)]);
  const parts: GpuPart[] = [];
  if (listed.includes("none") || noneForCpuKind) parts.push("none");
  if (listed.includes("shared") || listed.includes("whole")) parts.push("shared");
  if (offers.some((offer) => partsOf(offer).includes("whole") && offer.gpuRoom?.wholeOff !== true)) parts.push("whole");
  return parts;
}

export function readingWords(hosts: readonly string[]): string {
  return `Reading the cards on ${listed(hosts.length ? hosts : ["the provider"])}…`;
}

export function gpuFormLine(offers: readonly GpuFormOffer[], gpu: GpuPart, now: number): GpuLine {
  if (gpu === "none") {
    const offer = offers[0];
    const reach = offer?.reachesEveryCard ? ` ${DOCKER_REACH}` : "";
    const words = !offer || offer.canAddGpu
      ? `No GPU. You can add one later with Resize.${reach}`
      : offer.addKnown === false
        ? "No GPU."
        : `No GPU, and none can be added later on ${offer.label}.${offer.reachesEveryCard ? ` ${DOCKER_REACH}` : ""}`;
    return { words, blocked: false, state: "none" };
  }
  if (pending(offers)) return { words: readingWords(offers.map((offer) => offer.host)), blocked: true, state: "reading" };
  for (const offer of offers) {
    const card = placedCard(offer, gpu);
    if (!card) continue;
    const host = offer.gpuRoom?.host || offer.host;
    const reach = gpu === "whole" && offer.reachesEveryCard ? ` ${DOCKER_REACH}` : "";
    if (gpu === "whole") {
      const outside = outsideMiB(card);
      const words = outside ? `${cardTitle(card)} on ${host}, to itself. ${gibWords(outside)} of it is in use outside bb-box's boxes.${reach}` : `${cardTitle(card)} on ${host}, to itself: bb-box places no other box on it.${reach}`;
      return { words, blocked: false, state: "whole" };
    }
    const company = card.boxes === 0 ? "no other box" : card.boxes === 1 ? "1 box" : `${card.boxes} boxes`;
    const free = card.freeMiB === null ? "its free memory was not read" : `${gibWords(card.freeMiB)} free when read${offer.gpuRoom?.at ? `, ${ago(offer.gpuRoom.at, now)}` : ""}`;
    return { words: `${cardTitle(card)} on ${host}, shared with ${company}; ${free}. Boxes on a card share its memory.`, blocked: false, state: "shared" };
  }
  const spare = offers.find((offer) => offer.spare);
  if (spare) {
    const host = spare.gpuRoom?.host || spare.host;
    return { words: `A ready box on ${host} has this GPU, so Create takes that box.`, blocked: false, state: gpu === "whole" ? "whole" : "shared" };
  }
  if (offers.some((offer) => offer.failed)) return { words: "The cards could not be read.", blocked: true, state: "failed" };
  return { words: refusedWords(offers, gpu), blocked: true, state: "refused" };
}

export function gpuRowReason(offer: GpuFormOffer, gpu: GpuPart): string | null {
  if (gpu === "none") return null;
  if (offer.failed) return "The cards could not be read";
  if (offer.spare) return null;
  if (offer.unread && hasCards(offer)) return "Reading its cards…";
  if (placedCard(offer, gpu)) return null;
  return shortBlocks(offer, gpu);
}

export function gpuWaysLine(gpu: GpuResizing, form: string | null): string {
  const share = gpu.share === "live" ? "Shared and whole card switch at once where the card allows it." : gpu.share === "no" ? "Shared and whole card cannot switch here." : "Shared and whole card switch with a restart.";
  const fixed = gpu.add === "no" && gpu.move === "no";
  const rest = fixed
    ? form === "Docker"
      ? " On Docker a GPU cannot be added, removed or moved, and every box with Docker in it can open every card."
      : " A GPU cannot be added, removed or moved."
    : " Adding, removing or moving a card restarts the box; a stopped box stays stopped.";
  return `${share}${rest}`;
}

export function gpuAmount(part: GpuPart, index: number | null): string {
  if (part === "none") return "none";
  if (index === null) return part === "whole" ? "whole card" : "shared";
  return part === "whole" ? `whole card ${index}` : `shared, card ${index}`;
}

export function gpuExplanation(words: string): string {
  const match = /^GPU:.*?·\s*(?:Live|Restart|While stopped|Cannot change)\.\s*([\s\S]+)$/.exec(words);
  return (match?.[1] ?? words).trim();
}

export function withGpuPrograms(words: string, programs: string): string {
  if (!programs || /ha(?:s|ve) the GPU open/.test(words)) return words;
  return words.replace(/Everything running in (?:it|[^.]+) stops(?=\.)/, (said) => `${said}${programs}`);
}

function hasCards(offer: GpuFormOffer): boolean {
  return partsOf(offer).some((part) => part !== "none") || (offer.gpuRoom?.cards?.length ?? 0) > 0;
}

function partsOf(offer: GpuFormOffer): readonly GpuPart[] {
  return offer.gpuParts ?? offer.gpuRoom?.parts ?? [];
}

function pending(offers: readonly GpuFormOffer[]): boolean {
  return offers.some((offer) => offer.unread && hasCards(offer));
}

function placedCard(offer: GpuFormOffer, gpu: GpuPart): CardRoom | null {
  const room = offer.gpuRoom;
  if (!room?.cards?.length) return null;
  if (room.parts && !room.parts.includes(gpu)) return null;
  const open = room.cards.filter((card) => (gpu === "whole" ? canWhole(card, room) : canShare(card, room, offer.spare === true)));
  if (!open.length) return null;
  const byIndex = (card: CardRoom) => card.index ?? 0;
  const ranked = [...open].sort((left, right) => {
    if (gpu === "whole") {
      const outside = (card: CardRoom) => outsideMiB(card) ?? Number.MAX_SAFE_INTEGER;
      return outside(left) - outside(right) || (right.freeMiB ?? -1) - (left.freeMiB ?? -1) || byIndex(left) - byIndex(right);
    }
    return left.boxes - right.boxes || (right.freeMiB ?? -1) - (left.freeMiB ?? -1) || byIndex(left) - byIndex(right);
  });
  return ranked[0] ?? null;
}

function canShare(card: CardRoom, room: GpuRoom, spare: boolean): boolean {
  if (card.whole || card.wholeBy) return false;
  if (!spare && full(card, room)) return false;
  return card.freeMiB === null || card.freeMiB >= (room.neededMiB ?? 0);
}

function full(card: CardRoom, room: GpuRoom): boolean {
  return typeof room.limit === "number" && (card.own ?? card.boxes) >= room.limit;
}

function canWhole(card: CardRoom, room: GpuRoom): boolean {
  if (room.wholeOff) return false;
  if (card.freeForWhole === false) return false;
  if (card.freeForWhole === true) return card.freeMiB === null || card.freeMiB >= (room.neededMiB ?? 0);
  return !card.whole && !card.wholeBy && card.boxes === 0 && (card.freeMiB === null || card.freeMiB >= (room.neededMiB ?? 0));
}

function outsideMiB(card: CardRoom): number | null {
  if (card.boxes > 0 || card.freeMiB === null || card.totalMiB === null) return null;
  const used = card.totalMiB - card.freeMiB;
  return used > 0 ? used : null;
}

function cardTitle(card: CardRoom): string {
  return card.index === null ? "A card" : `Card ${card.index}`;
}

function refusedWords(offers: readonly GpuFormOffer[], gpu: GpuPart): string {
  if (offers.length > 1) return "No provider has a free card now: see each below.";
  const host = offers[0]?.gpuRoom?.host || offers[0]?.host || "This provider";
  return gpu === "whole" ? `${host} has no free card now: see below.` : `${host} has no card with room now: see below.`;
}

function shortBlocks(offer: GpuFormOffer, gpu: GpuPart): string | null {
  const room = offer.gpuRoom;
  if (!room) return "No card can take it";
  const cards = room.cards ?? [];
  if (!cards.length) return room.withheld ? firstSentence(room.withheld) : "No card can take it";
  const said = cards.map((card) => shortCard(card, room, gpu)).join("; ");
  return said.replace(/; Card /g, "; card ");
}

function shortCard(card: CardRoom, room: GpuRoom, gpu: GpuPart): string {
  const name = cardTitle(card);
  if (card.whole || card.wholeBy) return card.wholeBy ? `${name} is ${possessive(card.wholeBy)}` : `${name} is held whole`;
  if (full(card, room)) return `${name} is full`;
  if (card.freeMiB !== null && card.freeMiB < (room.neededMiB ?? 0)) return `${name} is short of memory`;
  if (gpu === "whole" || card.boxes > 0) return `${name} has ${card.boxes === 1 ? "1 box" : `${card.boxes} boxes`}`;
  return `${name} has no room`;
}

function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

function firstSentence(text: string): string {
  const end = text.search(/[.!?](\s|$)/);
  return end === -1 ? text : text.slice(0, end + 1);
}

function listed(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function gibWords(mib: number): string {
  const text = (mib / 1024).toFixed(1);
  return `${text.endsWith(".0") ? text.slice(0, -2) : text} GiB`;
}

function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 min ago" : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "1 h ago" : `${hours} h ago`;
}
