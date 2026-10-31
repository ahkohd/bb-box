import { BACKENDS, DESKTOP_GPU_MIB, type Backend, type BackendId, type Card, type FakeBox, type GpuPart, type GpuSettings } from "./data";

export interface World {
  readonly boxes: readonly FakeBox[];
  readonly cards: readonly Card[];
  readonly settings: Readonly<Record<BackendId, GpuSettings>>;
}

export interface Placed {
  readonly card: Card | null;
  readonly why: string | null;
}

export type GpuWay = "same" | "live" | "restart" | "no";

export interface GpuPlan {
  readonly from: GpuPart;
  readonly to: GpuPart;
  readonly fromCard: Card | null;
  readonly toCard: Card | null;
  readonly way: GpuWay;
  readonly others: readonly FakeBox[];
  readonly why: string | null;
}

export function backendOf(id: BackendId): Backend {
  return BACKENDS.find((backend) => backend.id === id)!;
}

export function cardsOf(world: World, backend: BackendId): Card[] {
  return world.cards.filter((card) => card.backend === backend).sort((a, b) => a.index - b.index);
}

export function cardById(world: World, id: string | null): Card | null {
  return id ? (world.cards.find((card) => card.id === id) ?? null) : null;
}

export function boxesOnCard(world: World, card: Card, except?: string): FakeBox[] {
  return world.boxes.filter((box) => box.card === card.id && box.id !== except);
}

export function usedMiB(world: World, card: Card): number {
  return card.outsideMiB + boxesOnCard(world, card).reduce((sum, box) => sum + (box.state === "stopped" ? 0 : box.processes.reduce((each, process) => each + process.mib, 0)), 0);
}

export function freeMiB(world: World, card: Card): number {
  return Math.max(0, card.memoryMiB - usedMiB(world, card));
}

export function needMiB(world: World, backend: BackendId, desktop: boolean): number {
  return desktop ? DESKTOP_GPU_MIB : world.settings[backend].gpuMemoryMiB;
}

export function gib(mib: number): string {
  if (mib < 1024) return `${Math.round(mib)} MiB`;
  const value = mib / 1024;
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} GiB`;
}

export function cardName(card: Card): string {
  return `card ${card.index}`;
}

export function capital(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function listed(words: readonly string[]): string {
  return words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

export function boxWord(box: FakeBox): string {
  return box.state === "stopped" ? `${box.name} (stopped)` : box.name;
}

function holder(world: World, card: Card, except?: string): FakeBox | null {
  return boxesOnCard(world, card, except).find((box) => box.gpu === "whole") ?? null;
}

function limit(world: World, backend: BackendId): number | null {
  const most = world.settings[backend].boxesPerCard;
  return most > 0 ? most : null;
}

export function cardState(world: World, card: Card, need: number, except?: string): string {
  const on = boxesOnCard(world, card, except);
  const whole = holder(world, card, except);
  const name = capital(cardName(card));
  if (whole) return `${name} is ${whole.name}'s whole card`;
  const most = limit(world, card.backend);
  if (most !== null && on.length >= most) return `${name} has ${on.length} boxes, the most a card may have: ${listed(on.map(boxWord))}`;
  const free = freeMiB(world, card);
  if (free < need) return `${name} has ${gib(free)} free, less than the ${gib(need)} a new box needs`;
  if (!on.length) return `${name} has no box`;
  return `${name} has ${listed(on.map(boxWord))}`;
}

export function place(world: World, backend: BackendId, gpu: GpuPart, desktop: boolean, except?: string): Placed {
  if (gpu === "none") return { card: null, why: null };
  const cards = cardsOf(world, backend);
  const host = backendOf(backend).host;
  if (!cards.length) return { card: null, why: `${host} has no cards.` };
  const need = needMiB(world, backend, desktop);
  if (gpu === "whole" && !world.settings[backend].wholeCards) {
    return { card: null, why: `Whole cards are off in bb-box's ${backendOf(backend).label} settings. Ask for a shared GPU.` };
  }
  const most = limit(world, backend);
  const fits = cards.filter((card) => {
    const on = boxesOnCard(world, card, except);
    if (freeMiB(world, card) < need) return false;
    if (gpu === "whole") return on.length === 0;
    return !holder(world, card, except) && (most === null || on.length < most);
  });
  const ranked = [...fits].sort((a, b) => boxesOnCard(world, a, except).length - boxesOnCard(world, b, except).length || freeMiB(world, b) - freeMiB(world, a) || a.index - b.index);
  const chosen = gpu === "whole" ? ([...fits].sort((a, b) => freeMiB(world, b) - freeMiB(world, a) || a.index - b.index)[0] ?? null) : (ranked[0] ?? null);
  if (chosen) return { card: chosen, why: null };
  const states = cards.map((card) => cardState(world, card, need, except));
  const fix = gpu === "whole" ? "Release one of them, or ask for a shared GPU." : "Release one of them, ask for no GPU, or raise the boxes per card in bb-box's settings.";
  return { card: null, why: `No card on ${host} can take ${gpu === "whole" ? "a whole card" : "a shared GPU"} now. ${states.join(". ")}. ${fix}` };
}

export function planGpu(world: World, box: FakeBox, to: GpuPart): GpuPlan {
  const fromCard = cardById(world, box.card);
  const base = { from: box.gpu, to, fromCard, others: fromCard ? boxesOnCard(world, fromCard, box.id) : [] };
  if (to === box.gpu) return { ...base, toCard: fromCard, way: "same", why: null };
  const backend = backendOf(box.backend);
  if (box.gpu === "none" || to === "none") {
    if (!backend.canChangeDevices) {
      return { ...base, toCard: null, way: "no", why: `Cannot change on ${backend.label}: a container's devices are fixed when it is made. Make a new box with the GPU you want.` };
    }
    if (to === "none") return { ...base, toCard: null, way: "restart", why: null };
    const placed = place(world, box.backend, to, box.desktop, box.id);
    return placed.card ? { ...base, others: boxesOnCard(world, placed.card, box.id), toCard: placed.card, way: "restart", why: null } : { ...base, toCard: null, way: "no", why: placed.why };
  }
  if (to === "shared") return { ...base, toCard: fromCard, way: "live", why: null };
  if (!world.settings[box.backend].wholeCards) {
    return { ...base, toCard: null, way: "no", why: `Whole cards are off in bb-box's ${backend.label} settings.` };
  }
  if (!base.others.length) return { ...base, toCard: fromCard, way: "live", why: null };
  const here = `${capital(cardName(fromCard!))} has ${base.others.length === 1 ? "another box" : `${base.others.length} other boxes`}: ${listed(base.others.map(boxWord))}.`;
  if (!backend.canChangeDevices) {
    return { ...base, toCard: null, way: "no", why: `${here} On ${backend.label} a box cannot move to another card. Keep the GPU shared, or make a new box with a whole card.` };
  }
  const placed = place(world, box.backend, "whole", box.desktop, box.id);
  if (placed.card && placed.card.id !== fromCard!.id) return { ...base, toCard: placed.card, way: "restart", why: null };
  const elsewhere = cardsOf(world, box.backend)
    .filter((card) => card.id !== fromCard!.id)
    .map((card) => `${cardState(world, card, needMiB(world, box.backend, box.desktop), box.id)}.`);
  return { ...base, toCard: null, way: "no", why: `No card is free for ${box.name} alone. ${here}${elsewhere.length ? ` ${elsewhere.join(" ")}` : ""} Release one of them, or keep the GPU shared.` };
}

export const GPU_WORDS: Readonly<Record<GpuPart, string>> = { none: "None", shared: "Shared", whole: "Whole card" };

export function gpuSizeWord(gpu: GpuPart): string | null {
  return gpu === "none" ? null : gpu === "shared" ? "shared GPU" : "whole card";
}
