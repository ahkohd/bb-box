import { OPERATOR, SPARES } from "../../core/boxes.ts";
import { CARD_CHECK_COMMAND, cardFactWords, judgeCardCheck, type CardCheck, type SeenCard } from "../card-check.ts";
import type { CardClaim, CardPlacement, CardRoom, GpuPart, GpuRefusal } from "../types.ts";
import { PRODUCT } from "../../brand.ts";

export { DESKTOP_GPU_MIB } from "../card-check.ts";
export const ALL_CARDS_DEVICE = "nvidia.com/gpu=all";
export const READING_FRESH_MS = 15_000;
export const READING_KEPT_MS = 60_000;
export const AVOID_CARD_MS = 10 * 60_000;

export type CardPart = Exclude<GpuPart, "none">;

export interface ProbedCard {
  readonly index: number;
  readonly uuid: string;
  readonly model: string;
  readonly totalMiB: number | null;
  readonly freeMiB: number | null;
}

export interface DockerCard {
  readonly uuid: string;
  readonly uuidKnown: boolean;
  readonly index: number | null;
  readonly model: string | null;
  readonly totalMiB: number | null;
  readonly freeMiB: number | null;
  readonly device: string;
}

export interface CardsOnHost {
  readonly cards: readonly DockerCard[];
  readonly oneDeviceForEveryCard: boolean;
  readonly readAt: number | null;
  readonly unread: string | null;
}

export interface CardHolder {
  readonly card: string;
  readonly part: CardPart;
  readonly name: string;
  readonly threadId: string | null;
  readonly otherInstall: boolean;
  readonly state: "running" | "stopped" | "making";
  readonly container: string;
  readonly needMiB: number;
}

export type CardBlock =
  | { readonly is: "whole"; readonly card: DockerCard; readonly holder: CardHolder }
  | { readonly is: "limit"; readonly card: DockerCard; readonly holders: readonly CardHolder[]; readonly count: number; readonly limit: number }
  | { readonly is: "held"; readonly card: DockerCard; readonly holders: readonly CardHolder[] }
  | { readonly is: "memory"; readonly card: DockerCard; readonly freeMiB: number; readonly needMiB: number; readonly what: BoxWhat }
  | { readonly is: "memory-unknown"; readonly card: DockerCard }
  | { readonly is: "avoided"; readonly card: DockerCard };

export type BoxWhat = "server" | "desktop";

export type CardPlacementResult = { readonly is: "placed"; readonly card: DockerCard } | { readonly is: "refused"; readonly blocks: readonly CardBlock[] };

export interface PlacementAsk {
  readonly part: CardPart;
  readonly needMiB: number;
  readonly what: BoxWhat;
  readonly cards: readonly DockerCard[];
  readonly holders: readonly CardHolder[];
  readonly perCard: number;
  readonly avoided: ReadonlySet<string>;
  readonly unplacedPerCard?: number;
  readonly only?: string;
  readonly except?: string;
}

export type Audience = { readonly to: "person" } | { readonly to: "agent"; readonly threadId: string | null };

export const PROBE_QUERY = "index,uuid,name,memory.total,memory.free";

export const PROBE_SCRIPT =
  "smi=$(command -v nvidia-smi || ls /usr/lib/wsl/lib/nvidia-smi /usr/lib/wsl/drivers/*/nvidia-smi 2>/dev/null | head -n 1); " +
  '[ -n "$smi" ] || { echo "no nvidia-smi in a container given the cards" >&2; exit 3; }; ' +
  `exec "$smi" --query-gpu=${PROBE_QUERY} --format=csv,noheader,nounits`;

export const CUDA_CARD_COMMAND =
  "if command -v python3 >/dev/null 2>&1; then python3 -c 'import ctypes as c; l = c.CDLL(\"libcuda.so.1\"); n = c.c_int(0); d = c.c_int(0); u = (c.c_ubyte * 16)(); " +
  "r = l.cuInit(0) or l.cuDeviceGetCount(c.byref(n)) or l.cuDeviceGet(c.byref(d), 0) or l.cuDeviceGetUuid(u, d); " +
  "print(\"cudacard\", r, n.value, bytes(u).hex() if r == 0 else \"none\")' 2>&1 | tail -n 1; fi; ";

export const DOCKER_CARD_CHECK = CUDA_CARD_COMMAND + CARD_CHECK_COMMAND;

function cardUuid(value: string): string | null {
  const match = /^(?:GPU-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(value.trim());
  return match ? match[1]!.toLowerCase() : null;
}

function mib(value: string | undefined): number | null {
  return value !== undefined && /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
}

export function parseProbe(text: string): ProbedCard[] {
  return text.split("\n").flatMap((line) => {
    const [index = "", uuid = "", model = "", total, free] = line.split(",").map((part) => part.trim());
    const card = cardUuid(uuid);
    return /^\d+$/.test(index) && card ? [{ index: Number(index), uuid: card, model, totalMiB: mib(total), freeMiB: mib(free) }] : [];
  });
}

export function cudaVisible(card: string): string {
  return `GPU-${card}`;
}

export function deviceCard(device: string): string | null {
  return cardUuid(device.slice(device.indexOf("=") + 1));
}

function deviceIndex(device: string): number | null {
  const value = device.slice(device.indexOf("=") + 1);
  return /^\d+$/.test(value) ? Number(value) : null;
}

export function cardsOnHost(input: { readonly devices: readonly string[]; readonly allListed: boolean; readonly probed: readonly ProbedCard[] | null; readonly readAt: number | null; readonly unread: string | null }): CardsOnHost {
  const { devices, allListed, probed } = input;
  const oneDeviceForEveryCard = !devices.length && allListed;
  const known = (card: Omit<DockerCard, "device" | "uuidKnown">, device: string): DockerCard => ({ ...card, uuidKnown: true, device });
  if (oneDeviceForEveryCard) {
    const cards = (probed ?? []).map((card) => known({ uuid: card.uuid, index: card.index, model: card.model, totalMiB: card.totalMiB, freeMiB: card.freeMiB }, ALL_CARDS_DEVICE));
    return { cards, oneDeviceForEveryCard, readAt: input.readAt, unread: input.unread };
  }
  const cards = devices.flatMap((device): DockerCard[] => {
    const uuid = deviceCard(device);
    const index = deviceIndex(device);
    const probe = (probed ?? []).find((card) => (uuid ? card.uuid === uuid : card.index === index));
    if (probe) return [known({ uuid: probe.uuid, index: probe.index, model: probe.model, totalMiB: probe.totalMiB, freeMiB: probe.freeMiB }, device)];
    if (uuid) return [known({ uuid, index: null, model: null, totalMiB: null, freeMiB: null }, device)];
    return index === null ? [] : [{ uuid: device, uuidKnown: false, index, model: null, totalMiB: null, freeMiB: null, device }];
  });
  return { cards: [...cards].sort(byIndex), oneDeviceForEveryCard, readAt: input.readAt, unread: input.unread };
}

function byIndex(a: DockerCard, b: DockerCard): number {
  return (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER) || a.uuid.localeCompare(b.uuid);
}

export function cardKeyOf(named: string | null, device: string | null, cards: readonly DockerCard[]): string | null {
  if (named && cards.some((card) => card.uuid === named)) return named;
  if (!device) return named;
  const byDevice = cards.filter((card) => card.device === device);
  if (byDevice.length === 1) return byDevice[0]!.uuid;
  return named ?? deviceCard(device);
}

export function cardOfLabels(labels: Readonly<Record<string, string>>, cards: readonly DockerCard[], cardLabel: string, deviceLabel: string): string | null {
  const named = labels[cardLabel] ? cardUuid(labels[cardLabel]!) : null;
  return cardKeyOf(named, labels[deviceLabel] ?? null, cards);
}

export function partOfLabel(value: string | undefined): CardPart {
  return value === "whole" ? "whole" : "shared";
}

export function cardName(card: Pick<DockerCard, "index" | "uuid">): string {
  return card.index === null ? `card ${cudaVisible(card.uuid)}` : `card ${card.index}`;
}

export function cardOfUuid(card: string): boolean {
  return cardUuid(card) === card;
}

function heldBy(holders: readonly CardHolder[], card: string, except?: string): CardHolder[] {
  return holders.filter((holder) => holder.card === card && holder.container !== except);
}

function reservedMiB(holders: readonly CardHolder[]): number {
  return holders.filter((holder) => holder.state === "making").reduce((sum, holder) => sum + holder.needMiB, 0);
}

function freeLessReserved(card: DockerCard, holders: readonly CardHolder[]): number | null {
  return card.freeMiB === null ? null : card.freeMiB - reservedMiB(holders);
}

function sharedBlock(ask: PlacementAsk, card: DockerCard): CardBlock | null {
  const holders = heldBy(ask.holders, card.uuid, ask.except);
  const whole = holders.find((holder) => holder.part === "whole");
  if (whole) return { is: "whole", card, holder: whole };
  const count = holders.length + (ask.unplacedPerCard ?? 0);
  if (count >= ask.perCard) return { is: "limit", card, holders, count, limit: ask.perCard };
  const free = freeLessReserved(card, holders);
  if (free !== null && free < ask.needMiB) return { is: "memory", card, freeMiB: free, needMiB: ask.needMiB, what: ask.what };
  if (ask.avoided.has(card.uuid)) return { is: "avoided", card };
  return null;
}

function wholeBlock(ask: PlacementAsk, card: DockerCard): CardBlock | null {
  const holders = heldBy(ask.holders, card.uuid, ask.except);
  const whole = holders.find((holder) => holder.part === "whole");
  if (whole) return { is: "whole", card, holder: whole };
  if (holders.length) return { is: "held", card, holders };
  if (ask.unplacedPerCard) return { is: "held", card, holders };
  const free = freeLessReserved(card, holders);
  if (free === null) return { is: "memory-unknown", card };
  if (free < ask.needMiB) return { is: "memory", card, freeMiB: free, needMiB: ask.needMiB, what: ask.what };
  if (ask.avoided.has(card.uuid)) return { is: "avoided", card };
  return null;
}

function usedMiB(card: DockerCard): number {
  return card.totalMiB !== null && card.freeMiB !== null ? card.totalMiB - card.freeMiB : Number.MAX_SAFE_INTEGER;
}

export function placeCard(ask: PlacementAsk): CardPlacementResult {
  const cards = ask.only ? ask.cards.filter((card) => card.uuid === ask.only) : ask.cards;
  const blocks: CardBlock[] = [];
  const open: DockerCard[] = [];
  for (const card of cards) {
    const block = ask.part === "whole" ? wholeBlock(ask, card) : sharedBlock(ask, card);
    if (block) blocks.push(block);
    else open.push(card);
  }
  if (!open.length) return { is: "refused", blocks };
  const count = (card: DockerCard) => heldBy(ask.holders, card.uuid, ask.except).length;
  const free = (card: DockerCard) => freeLessReserved(card, heldBy(ask.holders, card.uuid, ask.except)) ?? -1;
  const order = ask.part === "whole"
    ? (a: DockerCard, b: DockerCard) => usedMiB(a) - usedMiB(b) || free(b) - free(a) || byIndex(a, b)
    : (a: DockerCard, b: DockerCard) => count(a) - count(b) || free(b) - free(a) || byIndex(a, b);
  return { is: "placed", card: [...open].sort(order)[0]! };
}

function inWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export type ThreadTitles = ReadonlyMap<string, string | null>;

function threadWords(threadId: string | null, titles: ThreadTitles, inBrackets = false): string {
  if (threadId === null) return "";
  if (threadId === SPARES) return inBrackets ? " as a spare" : " (a spare)";
  if (threadId === OPERATOR) return inBrackets ? " as your machine" : " (your machine)";
  const title = titles.get(threadId) ?? null;
  if (!title) return "";
  return inBrackets ? ` in thread "${title}"` : ` (in thread "${title}")`;
}

export function holderName(holder: CardHolder, titles: ThreadTitles, audience: Audience, inBrackets = false): string {
  if (holder.otherInstall) return `${holder.name} of another install`;
  return audience.to === "person" ? `${holder.name}${threadWords(holder.threadId, titles, inBrackets)}` : holder.name;
}

function holdersWords(card: string, holders: readonly CardHolder[], titles: ThreadTitles, audience: Audience): string {
  const named = (list: readonly CardHolder[]) => inWords(list.map((holder) => holderName(holder, titles, audience)));
  const running = holders.filter((holder) => holder.state === "running");
  const stopped = holders.filter((holder) => holder.state === "stopped");
  const making = holders.filter((holder) => holder.state === "making");
  const parts = [
    ...(running.length ? [`${named(running)} running`] : []),
    ...(stopped.length ? [`${named(stopped)} holding it while stopped`] : []),
    ...(making.length ? [`${named(making)}, which ${PRODUCT} is making`] : []),
  ];
  return parts.length ? `${card} has ${parts.join(", and ")}` : `${card} has boxes being made`;
}

export function blockWords(block: CardBlock, titles: ThreadTitles, audience: Audience): string {
  const card = cardName(block.card);
  switch (block.is) {
    case "whole":
      if (block.holder.state === "making") return `${card} is kept whole for ${holderName(block.holder, titles, audience)}, which ${PRODUCT} is making`;
      return block.holder.otherInstall ? `${card} is held whole by ${holderName(block.holder, titles, audience)}` : `${card} is ${block.holder.name}'s whole card${audience.to === "person" ? threadWords(block.holder.threadId, titles) : ""}`;
    case "limit": {
      const names = block.holders.map((holder) => holderName(holder, titles, audience, true));
      const counting = block.count > block.holders.length ? ", counting boxes being made" : "";
      const most = block.count > block.limit ? `over the limit of ${block.limit}` : "the most a card may have";
      return `${card} has ${block.count} ${block.count === 1 ? "box" : "boxes"}${counting}, ${most}${names.length ? ` (${inWords(names)})` : ""}`;
    }
    case "held":
      return holdersWords(card, block.holders, titles, audience);
    case "memory":
      return `${card} has ${Math.max(0, block.freeMiB)} MiB free when last read, less than the ${block.needMiB} MiB a new ${block.what} needs`;
    case "memory-unknown":
      return `${card}'s free memory could not be read`;
    case "avoided":
      return `${card} is left out for now, as a box lately did not see it`;
  }
}

function holdersOf(block: CardBlock): readonly CardHolder[] {
  switch (block.is) {
    case "whole":
      return [block.holder];
    case "limit":
    case "held":
      return block.holders;
    default:
      return [];
  }
}

export function threadsNamed(blocks: readonly CardBlock[]): string[] {
  const named = blocks.flatMap(holdersOf).filter((holder) => !holder.otherInstall && holder.threadId !== null && holder.threadId !== SPARES && holder.threadId !== OPERATOR);
  return [...new Set(named.map((holder) => holder.threadId!))];
}

function ownBoxesWords(blocks: readonly CardBlock[], threadId: string | null): string | null {
  if (threadId === null) return null;
  const cards: string[] = [];
  const names: string[] = [];
  for (const block of blocks) {
    const own = holdersOf(block).filter((holder) => !holder.otherInstall && holder.threadId === threadId && holder.state !== "making");
    if (!own.length) continue;
    if (!cards.includes(cardName(block.card))) cards.push(cardName(block.card));
    for (const holder of own) if (!names.includes(holder.name)) names.push(holder.name);
  }
  return names.length ? `release one of your own boxes on ${inWords(cards)} (${inWords(names)})` : null;
}

function agentChoices(blocks: readonly CardBlock[], threadId: string | null, instead: string): string {
  const own = ownBoxesWords(blocks, threadId);
  return `${capitalised([...(own ? [own] : []), instead].join(", "))}, or ask the user.`;
}

function lead(host: string, part: CardPart): string {
  return part === "whole" ? `no card on ${host} is free for a whole card now` : `no card on ${host} can take a shared GPU now`;
}

export interface Instead {
  readonly person: string;
  readonly agent: string;
}

export function insteadOf(part: CardPart, what: BoxWhat): Instead {
  if (part === "whole") return { person: "Release a box on one of the cards, or ask for gpu shared.", agent: "ask for gpu shared" };
  if (what === "desktop") return { person: "Release a box on a card, ask for a linux-desktop-cpu box, or raise the boxes per card in BB Box's Docker settings.", agent: "ask for a linux-desktop-cpu box" };
  return { person: "Release a box on a card, ask for gpu none, or raise the boxes per card in BB Box's Docker settings.", agent: "ask for gpu none" };
}

export function placementRefusal(host: string, part: CardPart, what: BoxWhat, blocks: readonly CardBlock[], titles: ThreadTitles, threadId: string | null): GpuRefusal {
  const instead = insteadOf(part, what);
  const said = (audience: Audience) => inWords(blocks.map((block) => blockWords(block, titles, audience)));
  const person = said({ to: "person" });
  const agent = said({ to: "agent", threadId });
  return {
    person: `${capitalised(lead(host, part))}${person ? `: ${person}` : ""}. ${instead.person}`,
    agent: `Not made: ${lead(host, part)}${agent ? `: ${agent}` : ""}. ${agentChoices(blocks, threadId, instead.agent)} ${PRODUCT} changed nothing.`,
  };
}

export function noCardsRefusal(host: string, why: string, what: BoxWhat): GpuRefusal {
  const person = what === "desktop" ? "or ask for a linux-desktop-cpu box" : "or ask for gpu none";
  const agent = what === "desktop" ? "Ask for a linux-desktop-cpu box" : "Ask for gpu none";
  return {
    person: `${capitalised(host)} cannot give a box a GPU now: ${why}. Install the NVIDIA Container Toolkit and generate its CDI spec (setup/docker/README.md), ${person}.`,
    agent: `Not made: ${host} cannot give a box a GPU now: ${why}. ${agent}, or ask the user. ${PRODUCT} changed nothing.`,
  };
}

export function hostListsCards(info: { readonly gpus: readonly string[]; readonly allGpus: boolean }): boolean {
  return info.gpus.length > 0 || info.allGpus;
}

export function oneDeviceForEveryCardOf(info: { readonly gpus: readonly string[]; readonly allGpus: boolean }): boolean {
  return !info.gpus.length && info.allGpus;
}

export function reachWords(host: string, privileged: boolean, oneDeviceForEveryCard: boolean): string | null {
  if (privileged) return `On ${host}, every box with Docker in it can open every card, with a GPU or without. None and Whole card are what BB Box places, not what a box can reach.`;
  if (oneDeviceForEveryCard) return `On ${host}, Docker gives every card as one device, so every box with a GPU can open every card. Whole card is what BB Box places, not what a box can reach.`;
  return null;
}

export function seeItWords(card: Pick<DockerCard, "uuid" | "uuidKnown" | "index">): string {
  const named = card.uuidKnown ? cudaVisible(card.uuid) : String(card.index);
  return `Run nvidia-smi -i ${named} to see it; every card on the host is listed`;
}

export function placementOf(card: DockerCard): CardPlacement {
  return { card: card.uuid, index: card.index ?? -1, model: card.model ?? "", memoryMiB: card.totalMiB ?? 0 };
}

export function claimOf(card: string, part: CardPart, generation: number): CardClaim {
  return { card, part, generation, answer: "granted" };
}

export function factWords(part: CardPart, card: DockerCard | null, check: CardCheck | null): string {
  const seen: SeenCard | null = check?.ok ? check.card : card?.model ? { uuid: card.uuid, model: card.model, memoryMiB: card.totalMiB } : null;
  const words = cardFactWords(part, card?.index ?? null, seen);
  return check && !check.ok ? `${words}: ${check.why}` : words;
}

function cudaCardLine(output: string): { readonly result: string; readonly count: number; readonly card: string | null } | null {
  const line = output.split("\n").map((each) => each.trim()).find((each) => each.startsWith("cudacard "));
  const [, result = "", count = "", hex = ""] = line?.split(/\s+/) ?? [];
  if (!line) return null;
  const card = /^[0-9a-f]{32}$/.test(hex) ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : null;
  return { result, count: Number(count) || 0, card };
}

const CUDA_NO_DEVICE = "100";

export function judgeDockerCardCheck(output: string, card: string): CardCheck {
  const withoutCuda = output.split("\n").filter((line) => !line.trim().startsWith("cudacard ")).join("\n");
  const checked = judgeCardCheck(withoutCuda, card, null);
  const listed = checked.ok || (checked.reading === "cards" && checked.seen.includes(card));
  if (!listed) return checked;
  const lines = output.split("\n").map((line) => line.trim());
  if (lines.includes("cuinit no-python")) return checked;
  const cuda = cudaCardLine(output);
  const failed = (why: string): CardCheck => ({ ok: false, why, seen: [card], userspace: null, reading: "cards", userspaceOff: false });
  if (cuda && cuda.result === CUDA_NO_DEVICE) return failed(`CUDA in it found no card it may use with CUDA_VISIBLE_DEVICES=${cudaVisible(card)}: it returned ${cuda.result}`);
  if (cuda && cuda.result !== "0") return failed(`CUDA's driver did not initialise in it: it returned ${cuda.result || "nothing"}`);
  if (cuda && cuda.card !== card) return failed(`CUDA in it picks ${cuda.card ? cudaVisible(cuda.card) : "a card it cannot name"}, not its card ${cudaVisible(card)}`);
  if (!checked.ok) return lines.includes(`cuinit ${CUDA_NO_DEVICE}`) ? failed(`CUDA in it found no card it may use with CUDA_VISIBLE_DEVICES=${cudaVisible(card)}: cuInit returned ${CUDA_NO_DEVICE}`) : checked;
  if (!cuda) return failed("CUDA in it gave no answer for the card it picks");
  return checked;
}

export function wrongCard(check: CardCheck, card: string): boolean {
  if (check.ok || check.userspaceOff) return false;
  if (/^CUDA in it (picks|found no card)/.test(check.why)) return true;
  return (check.reading === "cards" || check.reading === "none") && !check.seen.includes(card);
}

export function environmentScript(card: string | null): string {
  const keys = "^(CUDA_VISIBLE_DEVICES|NVIDIA_VISIBLE_DEVICES)=";
  const lines = card ? `printf 'CUDA_VISIBLE_DEVICES="%s"\\nNVIDIA_VISIBLE_DEVICES="%s"\\n' '${cudaVisible(card)}' '${cudaVisible(card)}'` : ":";
  return `f=/etc/environment; t=$(mktemp) || exit 1; { grep -Ev '${keys}' "$f" 2>/dev/null; ${lines}; } >"$t" && cat "$t" >"$f"; s=$?; rm -f "$t"; exit $s`;
}

export function cardRooms(input: { readonly cards: readonly DockerCard[]; readonly holders: readonly CardHolder[]; readonly freeForWhole: (card: DockerCard) => boolean }): CardRoom[] {
  return input.cards.map((card) => {
    const holders = heldBy(input.holders, card.uuid);
    const whole = holders.find((holder) => holder.part === "whole") ?? null;
    return {
      index: card.index,
      boxes: holders.length,
      whole: whole !== null,
      freeMiB: freeLessReserved(card, holders),
      totalMiB: card.totalMiB,
      wholeBy: whole ? holderName(whole, new Map(), { to: "agent", threadId: null }) : null,
      freeForWhole: input.freeForWhole(card),
    };
  });
}

export interface CardAudit {
  readonly card: DockerCard;
  readonly whole: readonly CardHolder[];
  readonly others: readonly CardHolder[];
  readonly over: number;
  readonly holders: readonly CardHolder[];
}

export function wholeHoldersOnNoCard(holders: readonly CardHolder[], cards: readonly DockerCard[]): CardHolder[] {
  return holders.filter((holder) => holder.part === "whole" && !cards.some((card) => card.uuid === holder.card));
}

export function auditCards(cards: readonly DockerCard[], holders: readonly CardHolder[], perCard: number): CardAudit[] {
  return cards.map((card) => {
    const on = heldBy(holders, card.uuid).filter((holder) => holder.state !== "making");
    const whole = on.filter((holder) => holder.part === "whole");
    return { card, whole, others: on.filter((holder) => holder.part !== "whole"), over: Math.max(0, on.length - perCard), holders: on };
  });
}
