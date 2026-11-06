import type { GpuPart } from "../backends/types.ts";
import type { BoxState } from "../core/boxes.ts";
import type { BoxView } from "./views.ts";

export interface GpuMate {
  readonly id: string;
  readonly name: string;
  readonly state: BoxState;
}

export interface ReadCard {
  readonly index: number;
  readonly part: "shared" | "whole";
  readonly model: string | null;
  readonly memory: string | null;
  readonly why: string | null;
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

export function readCardFact(value: string): ReadCard | null {
  const colon = value.indexOf(": ");
  const head = colon === -1 ? value : value.slice(0, colon);
  const why = colon === -1 ? null : value.slice(colon + 2);
  const match = /^card (\d+), (shared|whole)(?:, (.*))?$/.exec(head);
  if (!match) return null;
  const rest = match[3] ?? "";
  const memory = /^(.*?), (\d+ GiB)$/.exec(rest);
  const model = (memory ? memory[1] : rest).trim();
  return { index: Number(match[1]), part: match[2] as "shared" | "whole", model: model || null, memory: memory ? memory[2]! : null, why };
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
    const card = read ? `Card ${read.index}` : "Its card";
    return { first: `${card} when it starts, if it has room`, second: null };
  }
  if (!read) {
    const raw = gpuFactValue(box);
    return { first: part === "whole" ? "Whole card" : "Shared", second: raw && !raw.startsWith("card ") ? raw : null };
  }
  const first = `Card ${read.index}, ${part === "whole" ? "whole" : "shared"}`;
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

export function wrongCardNotice(box: Pick<BoxView, "name" | "state" | "facts">): string | null {
  const read = readCardFact(gpuFactValue(box) ?? "");
  const why = read?.why ?? "";
  if (!why || USERSPACE_GAP.test(why)) return null;
  const wrong = /not its card/.test(why) || /CUDA in it (picks|found no card)/.test(why) || /listed (no card|cards? )/.test(why);
  if (!wrong) return null;
  const said = closed(why);
  if (box.state === "stopped") return `${box.name} did not get card ${read!.index}: ${said} It is stopped, with its disk as it was. Start tries again.`;
  return `${box.name} is on the wrong card: ${said} Restart it to place it on its card again. bb-box does not stop it.`;
}

export function otherCheckNotice(box: Pick<BoxView, "name" | "facts">): string | null {
  const read = readCardFact(gpuFactValue(box) ?? "");
  const why = read?.why ?? "";
  if (!why || USERSPACE_GAP.test(why)) return null;
  const wrong = /not its card/.test(why) || /CUDA in it (picks|found no card)/.test(why) || /listed (no card|cards? )/.test(why);
  if (wrong) return null;
  return `${box.name}'s card check: ${closed(why)}`;
}

export function gpuProgramsWords(processes: readonly { readonly name: string; readonly pid: number }[]): string {
  if (!processes.length) return "";
  const listed = processes.map((process) => `${process.name} (${process.pid})`).join(", ");
  return `: ${listed} ${processes.length === 1 ? "has" : "have"} the GPU open`;
}

export function monitorCard<T extends { readonly index: number; readonly name: string }>(cards: readonly T[], model: string | null): T | null {
  if (!cards.length) return null;
  if (cards.length === 1) return cards[0]!;
  if (model) {
    const named = cards.find((card) => card.name === model);
    if (named) return named;
  }
  return cards[0]!;
}

export function cardHeading(box: CardBox): string {
  const read = readCardFact(gpuFactValue(box) ?? "");
  if (!read) {
    const raw = gpuFactValue(box);
    return raw && !raw.startsWith("card ") ? raw : partOf(box) === "whole" ? "Whole card" : "Shared";
  }
  return [`Card ${read.index}`, read.model, read.memory].filter(Boolean).join(" · ");
}
