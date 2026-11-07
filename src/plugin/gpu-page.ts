import type { GpuPart } from "../backends/types.ts";
import type { BoxState } from "../core/boxes.ts";
import type { BoxView } from "./views.ts";

export interface GpuMate {
  readonly id: string;
  readonly name: string;
  readonly state: BoxState;
}

export interface ReadCard {
  readonly index: number | null;
  readonly part: "shared" | "whole";
  readonly model: string | null;
  readonly memory: string | null;
  readonly why: string | null;
}

export interface CardIdentity {
  readonly uuid: string | null;
  readonly index: number | null;
}

export interface NamedCard {
  readonly uuid: string;
  readonly index: number | null;
  readonly other?: boolean;
}

export interface GpuFactLines {
  readonly first: string;
  readonly second: string | null;
}

export interface UserspaceGap {
  readonly boxVersion: string;
  readonly host: string;
  readonly running: boolean;
}

export const HOLDS_NO_CARD = "holds no card while stopped";

export const USERSPACE_UPDATE_REFUSAL = "Not updated: updating NVIDIA's userspace is not offered from this page yet. Nothing changed.";

const USERSPACE_GAP = /its NVIDIA userspace is (\S+) and the host's driver (\S+)/;

type CardBox = Pick<BoxView, "gpu" | "gpuPart" | "state" | "form" | "claim" | "backendLabel" | "facts" | "name">;

export function partOf(box: Pick<BoxView, "gpuPart" | "claim">): GpuPart {
  return box.claim?.part ?? box.gpuPart ?? "none";
}

export function dockerGpuBox(box: Pick<BoxView, "form" | "backendLabel">): boolean {
  return box.form === "Docker" || box.backendLabel.startsWith("Docker");
}

export function lxcGpuBox(box: Pick<BoxView, "form" | "backendLabel">): boolean {
  return box.form === "LXC" || box.backendLabel.startsWith("Proxmox LXC");
}

export function holdsItsCard(box: Pick<BoxView, "gpu" | "gpuPart" | "state" | "form" | "claim" | "backendLabel">): boolean {
  if (!box.gpu) return false;
  const part = partOf(box);
  if (part === "none") return false;
  if (box.claim && (box.claim.answer !== "granted" || !box.claim.card)) return false;
  if (box.state === "stopped" && part === "shared" && !dockerGpuBox(box)) return false;
  return true;
}

export function holdsNoCardWhileStopped(box: Pick<BoxView, "gpu" | "gpuPart" | "state" | "form" | "claim" | "backendLabel">): boolean {
  return box.state === "stopped" && box.gpu && partOf(box) === "shared" && !dockerGpuBox(box);
}

export function gpuBadge(box: Pick<BoxView, "gpu" | "gpuPart" | "claim">): "GPU" | "Whole GPU" | null {
  if (!box.gpu) return null;
  return partOf(box) === "whole" ? "Whole GPU" : "GPU";
}

export function gpuMates(box: BoxView, others: readonly BoxView[]): GpuMate[] {
  const card = box.claim?.card;
  if (!card) return [];
  return others
    .filter((other) => other.id !== box.id && other.backendLabel === box.backendLabel && other.claim?.card === card && holdsItsCard(other))
    .map((other) => ({ id: other.id, name: other.name, state: other.state }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function gpuFactValue(box: Pick<BoxView, "facts">): string | null {
  return box.facts.find((fact) => fact.label === "GPU")?.value ?? null;
}

export function bareCardUuid(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(?:GPU-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(value.trim());
  return match ? match[1]!.toLowerCase() : null;
}

export function readCardFact(value: string): ReadCard | null {
  const colon = value.indexOf(": ");
  const head = colon === -1 ? value : value.slice(0, colon);
  const why = colon === -1 ? null : value.slice(colon + 2);
  const match = /^(?:card (\d+)|a card), (shared|whole)(?:, (.*))?$/.exec(head);
  if (!match) return null;
  const rest = match[3] ?? "";
  const memory = /^(.*?), (\d+ GiB)$/.exec(rest);
  const model = (memory ? memory[1] : rest).trim();
  return { index: match[1] === undefined ? null : Number(match[1]), part: match[2] as "shared" | "whole", model: model || null, memory: memory ? memory[2]! : null, why };
}

function cardWord(index: number | null): string {
  return index === null ? "Its card" : `Card ${index}`;
}

export function cardIdentity(box: Pick<BoxView, "claim" | "facts">): CardIdentity {
  const read = readCardFact(gpuFactValue(box) ?? "");
  return { uuid: bareCardUuid(box.claim?.card ?? null), index: read?.index ?? null };
}

export function cardNames(box: Pick<BoxView, "claim" | "facts" | "form" | "backendLabel">, seen: readonly { readonly uuid?: string | null; readonly index: number }[] = []): NamedCard[] {
  const identity = cardIdentity(box);
  const docker = dockerGpuBox(box);
  const names = new Map<string, NamedCard>();
  const keep = (uuid: string | null, index: number | null, other = false) => {
    if (!uuid) return;
    const known = names.get(uuid);
    if (!known) {
      names.set(uuid, { uuid, index: other ? null : index, other });
      return;
    }
    if (known.other && !other) names.set(uuid, { uuid, index, other: false });
    else if (!known.other && known.index === null && index !== null) names.set(uuid, { uuid, index, other: false });
  };
  keep(identity.uuid, identity.index);
  for (const card of seen) {
    const uuid = bareCardUuid(card.uuid);
    if (!uuid) continue;
    if (!docker) {
      if (uuid !== identity.uuid) keep(uuid, null, true);
      continue;
    }
    keep(uuid, card.index);
  }
  return [...names.values()];
}

export function nameCardsIn(why: string, named: readonly NamedCard[]): string {
  const byUuid = new Map(named.map((card) => [card.uuid, card]));
  const said = why.replace(/GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (found) => {
    const key = bareCardUuid(found);
    const card = key ? byUuid.get(key) : undefined;
    if (!card) return "a card";
    if (card.other) return "another card";
    return card.index === null ? "its card" : `card ${card.index}`;
  });
  return said
    .replace(/its card its card/g, "its card")
    .replace(/card card (\d+)/g, "card $1")
    .replace(/cards card (\d+)((?: and card \d+)*)/g, (_match, first: string, rest: string) => `cards ${first}${rest.replace(/ card /g, " ")}`)
    .replace(/card a card/g, "a card")
    .replace(/card another card/g, "another card");
}

export function everyCardLine(box: Pick<BoxView, "gpu" | "facts">): string | null {
  if (!box.gpu) return null;
  const words = box.facts.find((fact) => fact.label === "Cards")?.value ?? null;
  return words;
}

function namesOf(mates: readonly Pick<GpuMate, "name">[]): string {
  const names = mates.map((mate) => mate.name);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function gpuFactLines(box: CardBox, mates: readonly Pick<GpuMate, "name">[]): GpuFactLines | null {
  if (!box.gpu) return null;
  const part = partOf(box);
  const read = readCardFact(gpuFactValue(box) ?? "");
  if (box.state === "stopped" && part === "shared" && !dockerGpuBox(box)) {
    return { first: `${cardWord(read?.index ?? null)} when it starts, if it has room`, second: null };
  }
  if (!read) {
    const raw = gpuFactValue(box);
    return { first: part === "whole" ? "Whole card" : "Shared", second: raw && !/^(?:card \d+|a card),/.test(raw) ? raw : null };
  }
  const first = `${cardWord(read.index)}, ${part === "whole" ? "whole" : "shared"}`;
  if (part === "shared" && mates.length) return { first, second: `with ${namesOf(mates)}` };
  const under = [read.model, read.memory].filter(Boolean).join(" · ");
  return { first, second: under || null };
}

export function gpuFooter(box: CardBox, host: string | null): string {
  const part = partOf(box);
  const where = host ?? "its host";
  if (box.state === "stopped" && part === "whole") return "Stopped: the card stays its own, so it has it when it starts.";
  if (box.state === "stopped" && part === "shared" && dockerGpuBox(box)) return "Stopped: on Docker a box keeps its card while stopped, as its devices are fixed.";
  if (box.state === "stopped") return "Stopped: it holds no place on the card. When it starts it goes back to this card if there is room, or to another card.";
  if (part === "shared") return "Boxes on a card share its memory and its time: one box can take all of its memory. The figures are the whole card's, from the Monitor.";
  if (dockerGpuBox(box)) return "No other box is placed on this card. On Docker every box with Docker in it can still open it: a whole card here is where bb-box places boxes, not a fence.";
  if (lxcGpuBox(box)) return `No other guest on ${where} can open this card: on Proxmox LXC a whole card is fenced. Programs on the host itself can still use it.`;
  return "No other box is placed on this card.";
}

export function userspaceGap(box: Pick<BoxView, "state" | "facts">): UserspaceGap | null {
  const read = readCardFact(gpuFactValue(box) ?? "");
  const match = USERSPACE_GAP.exec(read?.why ?? "");
  if (!match) return null;
  return { boxVersion: match[1]!.replace(/\.$/, ""), host: match[2]!.replace(/\.$/, ""), running: box.state !== "stopped" && box.state !== "stopping" };
}

export function userspaceNotice(box: Pick<BoxView, "name" | "state" | "facts">): string | null {
  const gap = userspaceGap(box);
  if (!gap) return null;
  if (!gap.running) return `${box.name}'s NVIDIA userspace is ${gap.boxVersion}, from its record, and the host's driver is ${gap.host}: nvidia-smi will fail in it. Start it, then update it.`;
  return `nvidia-smi fails in ${box.name}: its NVIDIA userspace is ${gap.boxVersion}, and the host's driver is ${gap.host}.`;
}

function closed(why: string): string {
  const trimmed = why.trim().replace(/\.$/, "");
  return `${trimmed}.`;
}

type NoticeBox = Pick<BoxView, "name" | "state" | "facts" | "form" | "backendLabel" | "claim">;
type SeenCard = readonly { readonly uuid?: string | null; readonly index: number }[];

function noticeWhy(box: NoticeBox, why: string, seen: SeenCard): string {
  return closed(nameCardsIn(why, cardNames(box, seen)));
}

function wrongCardWhy(why: string): boolean {
  return /not its card/.test(why) || /CUDA in it (picks|found no card)/.test(why) || /listed (no card|cards? )/.test(why);
}

export function wrongCardNotice(box: NoticeBox, seen: SeenCard = []): string | null {
  const read = readCardFact(gpuFactValue(box) ?? "");
  const why = read?.why ?? "";
  if (!why || USERSPACE_GAP.test(why) || !wrongCardWhy(why)) return null;
  const said = noticeWhy(box, why, seen);
  if (box.state === "stopped") {
    if (!dockerGpuBox(box)) return null;
    return `${box.name}'s last start found it on the wrong card: ${said} A start checks again; its devices do not change.`;
  }
  return `${box.name} is on the wrong card: ${said} Restart it to place it on its card again. bb-box does not stop it.`;
}

export function otherCheckNotice(box: NoticeBox, seen: SeenCard = []): string | null {
  const read = readCardFact(gpuFactValue(box) ?? "");
  const why = read?.why ?? "";
  if (!why || USERSPACE_GAP.test(why) || wrongCardWhy(why)) return null;
  return `${box.name}'s card check: ${noticeWhy(box, why, seen)}`;
}

export function gpuProgramsWords(processes: readonly { readonly name: string; readonly pid: number }[]): string {
  if (!processes.length) return "";
  const listed = processes.map((process) => `${process.name} (${process.pid})`).join(", ");
  return `: ${listed} ${processes.length === 1 ? "has" : "have"} the GPU open`;
}

export function countsAsThisBox(box: Pick<BoxView, "form" | "backendLabel" | "claim" | "facts">, card: { readonly index: number; readonly uuid?: string | null }): boolean {
  if (dockerGpuBox(box)) return true;
  return monitorCard([card], cardIdentity(box)) !== null;
}

export function monitorCard<T extends { readonly index: number; readonly uuid?: string | null }>(cards: readonly T[], identity: CardIdentity): T | null {
  const wanted = bareCardUuid(identity.uuid);
  const readable = cards.filter((card) => bareCardUuid(card.uuid));
  if (wanted && readable.length) return readable.find((card) => bareCardUuid(card.uuid) === wanted) ?? null;
  if (identity.index !== null) return cards.find((card) => card.index === identity.index) ?? null;
  return null;
}

export function cardHeading(box: CardBox): string {
  const read = readCardFact(gpuFactValue(box) ?? "");
  if (!read) {
    const raw = gpuFactValue(box);
    return raw && !/^(?:card \d+|a card),/.test(raw) ? raw : partOf(box) === "whole" ? "Whole card" : "Shared";
  }
  return [cardWord(read.index), read.model, read.memory].filter(Boolean).join(" · ");
}
