import { OPERATOR, SPARES } from "../../core/boxes.ts";
import { cardName, type HelperCard, type HelperHolder } from "./gpu-marking.ts";
import type { Refusal } from "./gpu-servers.ts";

export interface BoxMaking {
  readonly name: string;
  readonly threadId: string;
  readonly starting?: boolean;
}

export type CardBlock =
  | { readonly is: "whole"; readonly card: HelperCard; readonly vmid: number }
  | { readonly is: "reserved-whole"; readonly card: HelperCard; readonly making: BoxMaking | null }
  | { readonly is: "unsettled"; readonly card: HelperCard; readonly vmids: readonly number[] }
  | { readonly is: "limit"; readonly card: HelperCard; readonly own: number; readonly vmids: readonly number[]; readonly making: readonly (BoxMaking | null)[] }
  | { readonly is: "unanswered"; readonly card: HelperCard; readonly vmid: number; readonly generation: number }
  | { readonly is: "held"; readonly card: HelperCard; readonly holders: readonly HelperHolder[] }
  | { readonly is: "placing"; readonly card: HelperCard; readonly making: readonly (BoxMaking | null)[] }
  | { readonly is: "memory"; readonly card: HelperCard; readonly freeMiB: number; readonly needMiB: number; readonly what: "server" | "desktop" }
  | { readonly is: "memory-unknown"; readonly card: HelperCard }
  | { readonly is: "refused"; readonly card: HelperCard }
  | { readonly is: "closed"; readonly card: HelperCard }
  | { readonly is: "avoided"; readonly card: HelperCard }
  | { readonly is: "said"; readonly words: string };

export type Holder =
  | { readonly is: "box"; readonly name: string; readonly threadId: string | null }
  | { readonly is: "warm" }
  | { readonly is: "other-install"; readonly vmid: number }
  | { readonly is: "not-bb-box"; readonly vmid: number };

export interface CardNamer {
  readonly guest: (vmid: number) => Holder;
  readonly title: (threadId: string) => string | null;
}

export type Audience = { readonly to: "person" } | { readonly to: "agent"; readonly threadId: string | null };

export const PERSON: Audience = { to: "person" };

function inWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function threadWords(threadId: string | null, namer: CardNamer): string {
  if (threadId === null) return "";
  if (threadId === SPARES) return " (a spare)";
  if (threadId === OPERATOR) return " (your machine)";
  const title = namer.title(threadId);
  return title ? ` (in thread "${title}")` : "";
}

function boxWords(name: string, threadId: string | null, namer: CardNamer, audience: Audience): string {
  return audience.to === "person" ? `${name}${threadWords(threadId, namer)}` : name;
}

export function holderWords(holder: Holder, namer: CardNamer, audience: Audience): string {
  if (holder.is === "box") return boxWords(holder.name, holder.threadId, namer, audience);
  if (holder.is === "warm") return "a warm desktop";
  if (holder.is === "other-install") return `CT ${holder.vmid} of another install`;
  return `CT ${holder.vmid}, which is not bb-box's`;
}

function makingWords(making: BoxMaking | null, namer: CardNamer, audience: Audience): string {
  return making ? boxWords(making.name, making.threadId, namer, audience) : "a box";
}

function guestWords(vmid: number, namer: CardNamer, audience: Audience): string {
  return holderWords(namer.guest(vmid), namer, audience);
}

function heldWords(card: string, holders: readonly HelperHolder[], namer: CardNamer, audience: Audience): string {
  const named = (list: readonly HelperHolder[]) => inWords(list.map((holder) => guestWords(holder.vmid, namer, audience)));
  const running = holders.filter((holder) => holder.running);
  const stopped = holders.filter((holder) => !holder.running);
  const parts = [...(running.length ? [`${named(running)} running`] : []), ...(stopped.length ? [`${named(stopped)} holding it while stopped`] : [])];
  return `${card} has ${parts.join(", and ")}`;
}

export function blockWords(block: CardBlock, namer: CardNamer, audience: Audience): string {
  if (block.is === "said") return block.words;
  const card = cardName(block.card);
  switch (block.is) {
    case "whole": {
      const holder = namer.guest(block.vmid);
      if (holder.is !== "box") return `${card} is held whole by ${holderWords(holder, namer, audience)}`;
      return `${card} is ${holder.name}'s whole card${audience.to === "person" ? threadWords(holder.threadId, namer) : ""}`;
    }
    case "reserved-whole":
      return `${card} is kept whole for ${makingWords(block.making, namer, audience)}, which bb-box is ${block.making?.starting ? "starting" : "making"}`;
    case "unsettled":
      return `${card} waits for ${inWords(block.vmids.map((vmid) => `CT ${vmid}`))} to ask again, as the GPU helper's ledger was lost and ${block.vmids.length === 1 ? "it" : "each"} may hold the card`;
    case "limit": {
      const names = [...block.vmids.map((vmid) => guestWords(vmid, namer, audience)), ...block.making.map((making) => makingWords(making, namer, audience))];
      return `${card} has ${block.own} of this install's boxes, the most a card may have${names.length ? ` (${inWords(names)})` : ""}`;
    }
    case "unanswered":
      return `the GPU helper has not answered CT ${block.vmid}'s request g${block.generation} on ${card}`;
    case "held":
      return heldWords(card, block.holders, namer, audience);
    case "placing": {
      const starting = block.making.filter((making) => making?.starting);
      const placing = block.making.filter((making) => !making?.starting);
      const said = [
        ...(placing.length ? [`bb-box is placing ${inWords(placing.map((making) => makingWords(making, namer, audience)))} on ${card}`] : []),
        ...(starting.length ? [`bb-box is starting ${inWords(starting.map((making) => makingWords(making, namer, audience)))} on ${card}`] : []),
      ];
      return said.join(", and ");
    }
    case "memory":
      return `${card} has ${block.freeMiB} MiB free when last read, less than the ${block.needMiB} MiB a new ${block.what} needs`;
    case "memory-unknown":
      return `${card}'s free memory is not known from the GPU helper's report`;
    case "refused":
      return `the GPU helper refused ${card} for this box`;
    case "closed":
      return `${card} takes no new box while a box there is on another card's lines or lists another card`;
    case "avoided":
      return `${card} is left out for now, as a box lately did not see it`;
  }
}

export function blocksWords(blocks: readonly CardBlock[], namer: CardNamer, audience: Audience): string {
  return inWords(blocks.map((block) => blockWords(block, namer, audience)));
}

function holdersOf(block: CardBlock, namer: CardNamer): { readonly name: string; readonly threadId: string | null }[] {
  const ofGuest = (vmid: number) => {
    const holder = namer.guest(vmid);
    return holder.is === "box" ? [{ name: holder.name, threadId: holder.threadId }] : [];
  };
  switch (block.is) {
    case "whole":
      return ofGuest(block.vmid);
    case "held":
      return block.holders.flatMap((holder) => ofGuest(holder.vmid));
    case "limit":
      return [...block.vmids.flatMap(ofGuest), ...block.making.flatMap((making) => (making ? [making] : []))];
    case "placing":
      return block.making.flatMap((making) => (making ? [making] : []));
    case "reserved-whole":
      return block.making ? [block.making] : [];
    default:
      return [];
  }
}

export function threadsNamed(blocks: readonly CardBlock[], namer: Pick<CardNamer, "guest">): string[] {
  const named = blocks.flatMap((block) => holdersOf(block, { ...namer, title: () => null }));
  return [...new Set(named.flatMap((holder) => (holder.threadId !== null && holder.threadId !== SPARES && holder.threadId !== OPERATOR ? [holder.threadId] : [])))];
}

export function ownBoxesWords(blocks: readonly CardBlock[], namer: CardNamer, threadId: string | null): string | null {
  if (threadId === null) return null;
  const cards: string[] = [];
  const names: string[] = [];
  for (const block of blocks) {
    if (block.is === "said") continue;
    const own = holdersOf(block, namer).filter((holder) => holder.threadId === threadId);
    if (!own.length) continue;
    if (!cards.includes(cardName(block.card))) cards.push(cardName(block.card));
    for (const holder of own) if (!names.includes(holder.name)) names.push(holder.name);
  }
  if (!names.length) return null;
  return `release one of your own boxes on ${inWords(cards)} (${inWords(names)})`;
}

export type PlacedPart = "shared" | "whole" | "box";

function lead(node: string, part: PlacedPart): string {
  if (part === "whole") return `no card on ${node} is free for a whole card now`;
  return part === "shared" ? `no card on ${node} can take a shared GPU now` : `no card on ${node} can take another box now`;
}

export function reasonSentence(node: string, part: PlacedPart, blocks: readonly CardBlock[], namer: CardNamer, audience: Audience): string {
  const said = blocksWords(blocks, namer, audience);
  return `${capitalised(lead(node, part))}${said ? `: ${said}` : ""}.`;
}

export function agentChoices(blocks: readonly CardBlock[], namer: CardNamer, threadId: string | null, instead: string | null): string {
  const own = ownBoxesWords(blocks, namer, threadId);
  const choices = [...(own ? [own] : []), ...(instead ? [instead] : [])];
  return `${capitalised(choices.length ? `${choices.join(", ")}, or ask the user` : "ask the user")}.`;
}

export function placementRefusal(input: {
  readonly node: string;
  readonly part: PlacedPart;
  readonly blocks: readonly CardBlock[];
  readonly namer: CardNamer;
  readonly threadId: string | null;
  readonly personFix: string;
  readonly agentInstead: string | null;
}): Refusal {
  const { node, part, blocks, namer, threadId } = input;
  return {
    person: `${reasonSentence(node, part, blocks, namer, PERSON)} ${input.personFix}`,
    agent: `Not made: ${lead(node, part)}${blocks.length ? `: ${blocksWords(blocks, namer, { to: "agent", threadId })}` : ""}. ${agentChoices(blocks, namer, threadId, input.agentInstead)} bb-box changed nothing.`,
  };
}

export const WHOLE_PERSON_FIX = "Release a box on one of the cards, ask for gpu shared, or ask for gpu none.";
export const WHOLE_AGENT_INSTEAD = "ask for gpu shared";
export const SHARED_PERSON_FIX = "Release a box on a card, ask for gpu none, or raise the boxes per card in BB Box's settings.";
export const SHARED_AGENT_INSTEAD = "ask for gpu none";
