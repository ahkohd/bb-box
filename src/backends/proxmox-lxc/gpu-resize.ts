import type { CardPlacement, GpuPart, GpuRefusal, GpuResize, ResizeWay } from "../types.ts";
import type { CardMemory } from "./gpu-claims.ts";
import type { HelperCard } from "./gpu-marking.ts";
import { agentChoices, blockWords, PERSON, type CardBlock, type CardNamer } from "./gpu-refusals.ts";

export const GPU_RESTART_SECONDS = 15;

export interface PlanBox {
  readonly name: string;
  readonly desktop: boolean;
  readonly stopped: boolean;
  readonly threadId: string | null;
}

export interface OtherOnCard {
  readonly box: string | null;
  readonly name: string;
  readonly stopped: boolean;
}

export function placementOf(card: HelperCard, memory: ReadonlyMap<string, CardMemory>): CardPlacement {
  return { card: card.uuid, index: card.index ?? 0, model: "", memoryMiB: memory.get(card.uuid)?.totalMiB ?? 0 };
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function inWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function named(card: CardPlacement | null): string {
  return card ? `card ${card.index}` : "its card";
}

function sized(card: CardPlacement): string {
  return card.memoryMiB ? `${named(card)} (${Math.round(card.memoryMiB / 1024)} GiB)` : named(card);
}

function sharedWith(others: readonly OtherOnCard[]): string {
  const running = others.filter((other) => !other.stopped).length;
  if (!running) return "with no other box on it now";
  return `shared with ${running} other ${running === 1 ? "box" : "boxes"}`;
}

function yieldWords(others: readonly OtherOnCard[]): string {
  const stopped = others.filter((other) => other.stopped);
  if (!stopped.length) return "";
  const one = stopped.length === 1;
  return ` ${inWords(stopped.map((other) => `${other.name} (stopped)`))} ${one ? "is" : "are"} placed on another card when ${one ? "it next starts" : "they next start"}.`;
}

export interface GpuPlanInput {
  readonly box: PlanBox;
  readonly from: GpuPart;
  readonly to: GpuPart;
  readonly fromCard: CardPlacement | null;
  readonly toCard: CardPlacement | null;
  readonly way: ResizeWay;
  readonly others: readonly OtherOnCard[];
  readonly limit: number | null;
  readonly fromHeldBy: string | null;
}

export function gpuPlanWords(input: GpuPlanInput): string {
  const { box, from, to, fromCard, toCard, others } = input;
  const name = box.name;
  if (box.stopped) {
    if (to === "none") return `GPU: ${from}, ${named(fromCard)} → none · While stopped. ${capitalised(name)} is stopped: it has no GPU from its next start. Nothing starts now.`;
    if (to === "whole") {
      const was = from === "none" ? "none" : `${from}${fromCard && fromCard.card !== toCard?.card ? ` on ${named(fromCard)}` : ""}`;
      return `GPU: ${was} → whole ${named(toCard)} · While stopped. ${capitalised(named(toCard))} is claimed for ${name} now: no other box is placed on it while ${name} holds it. ${capitalised(name)} is stopped, and nothing starts now.${yieldWords(others)}`;
    }
    if (from === "whole") return `GPU: whole ${named(fromCard)} → shared · While stopped. ${capitalised(named(fromCard))} opens to other boxes now. ${capitalised(name)} is stopped: it goes on a card with room when it next starts, ${named(fromCard)} first. Nothing starts now.`;
    return `GPU: none → shared · While stopped. ${capitalised(name)} is stopped: it gets a shared GPU from its next start, on ${named(toCard)} if it has room then. Nothing starts now.`;
  }
  const seconds = `in about ${GPU_RESTART_SECONDS} s`;
  if (to === "none") {
    return `GPU: ${from}, ${named(fromCard)} → none · Restart. ${capitalised(name)} restarts without ${named(fromCard)}, ${seconds}. Everything running in it stops.${box.desktop ? " Its desktop is then drawn by the CPU." : ""}`;
  }
  if (from === "none" || !fromCard) {
    const how = to === "whole" ? "to itself" : sharedWith(others);
    return `GPU: ${from} → ${to}, ${named(toCard)} · Restart. ${capitalised(name)} restarts, gets ${toCard ? sized(toCard) : "a card"}, ${how}, ${seconds}. Everything running in it stops.${box.desktop ? " Its desktop is then drawn by the GPU." : ""}`;
  }
  if (to === "shared") {
    const up = input.limit === null ? "with no limit on how many" : `up to ${input.limit}`;
    return `GPU: whole ${named(fromCard)} → shared · Live. ${capitalised(named(fromCard))} opens to other boxes, ${up}. They share its memory and its time. Nothing in ${name} stops.`;
  }
  if (input.way === "live") {
    return `GPU: shared → whole ${named(toCard)} · Live. ${capitalised(named(toCard))} becomes ${name}'s alone: no other box is placed on it while ${name} holds it. Nothing in ${name} stops.${yieldWords(others)}`;
  }
  const held = input.fromHeldBy ? `${capitalised(input.fromHeldBy)}. ` : "";
  return `GPU: shared on ${named(fromCard)} → whole ${named(toCard)} · Restart. ${held}bb-box moves ${name} to ${named(toCard)}, which has no other box, ${seconds}. Everything running in ${name} stops.`;
}

export function plannedChange(input: GpuPlanInput, refusal: GpuRefusal | null = null): GpuResize {
  return {
    from: input.from,
    to: input.to,
    way: input.way,
    card: input.toCard ?? input.fromCard,
    fromCard: input.fromCard,
    toCard: input.toCard,
    stopped: input.box.stopped,
    installs: null,
    others: input.others,
    words: refusal ? refusal.person : gpuPlanWords(input),
    refusal,
  };
}

export function cardsWords(blocks: readonly CardBlock[], namer: CardNamer, to: "person" | "agent", threadId: string | null): string[] {
  return blocks.map((block) => blockWords(block, namer, to === "person" ? PERSON : { to: "agent", threadId }));
}

export function noWholeCardRefusal(box: PlanBox, blocks: readonly CardBlock[], namer: CardNamer, asking: string | null): GpuRefusal {
  const person = cardsWords(blocks, namer, "person", null).map(capitalised);
  const agent = cardsWords(blocks, namer, "agent", asking);
  const own = agentChoices(blocks, namer, asking, "keep the GPU shared");
  return {
    person: `No card is free for ${box.name} alone.${person.length ? ` ${person.join(". ")}.` : ""} Release one of them, or keep the GPU shared.`,
    agent: `Not resized: no card is free for ${box.name} alone.${agent.length ? ` ${capitalised(agent.join("; "))}.` : ""} ${own} bb-box changed nothing.`,
  };
}

export function noSharedCardRefusal(node: string, box: PlanBox, blocks: readonly CardBlock[], namer: CardNamer, asking: string | null): GpuRefusal {
  const person = cardsWords(blocks, namer, "person", null);
  const agent = cardsWords(blocks, namer, "agent", asking);
  const own = agentChoices(blocks, namer, asking, "keep it with no GPU");
  return {
    person: `No card on ${node} can take a shared GPU for ${box.name} now${person.length ? `: ${person.join("; ")}` : ""}. Release a box on a card, keep it with no GPU, or raise the boxes per card in BB Box's settings.`,
    agent: `Not resized: no card on ${node} can take a shared GPU for ${box.name} now${agent.length ? `: ${agent.join("; ")}` : ""}. ${own} bb-box changed nothing.`,
  };
}

export function helperNotReadyRefusal(node: string, box: PlanBox, why: string, fix: string): GpuRefusal {
  return {
    person: `${node} cannot change ${box.name}'s GPU now: ${why}. ${fix}`,
    agent: `Not resized: ${node} cannot change ${box.name}'s GPU now: ${why}. Keep its GPU as it is, or ask the user. bb-box changed nothing.`,
  };
}

export function unmarkedRefusal(box: PlanBox): GpuRefusal {
  return {
    person: `${capitalised(box.name)} has a card's device lines and no GPU marker, so bb-box does not know which claim it holds. Run bb box gpu mark, then resize it again.`,
    agent: `Not resized: ${box.name} has a card's device lines and no GPU marker, so bb-box does not know which claim it holds. Ask the user. bb-box changed nothing.`,
  };
}

export function userspaceRefusal(box: PlanBox, driver: string | null, userspace: string | null): GpuRefusal {
  const host = driver ?? "(not reported)";
  if (box.stopped && userspace === null) {
    return {
      person: `Start ${box.name} first: bb-box reads whether it has NVIDIA's userspace for the host's driver ${host} in a running box. Nothing changes.`,
      agent: `Not resized: ${box.name} is stopped, and bb-box reads whether it has NVIDIA's userspace for the host's driver ${host} only in a running box. Start it with box_start, or ask the user. bb-box changed nothing.`,
    };
  }
  const has = userspace === null ? "none" : userspace;
  return {
    person: `Not changed: ${box.name} has NVIDIA's userspace ${has}, not the host's driver ${host}, so a card would not work in it, and bb-box does not install it yet. Make a new box with the GPU it needs.`,
    agent: `Not resized: ${box.name} has NVIDIA's userspace ${has}, not the host's driver ${host}, so a card would not work in it. Acquire a new box with the GPU it needs, or ask the user. bb-box changed nothing.`,
  };
}
