import { AGENT_THREAD, BACKENDS, DESKTOP_GPU_MIB, HOST_DRIVER, type Backend, type BackendId, type Card, type FakeBox, type GpuPart, type GpuSettings } from "./data";

export interface World {
  readonly boxes: readonly FakeBox[];
  readonly cards: readonly Card[];
  readonly settings: Readonly<Record<BackendId, GpuSettings>>;
}

export interface Placed {
  readonly card: Card | null;
  readonly person: string | null;
  readonly agent: string | null;
  readonly short: string | null;
  readonly states: string | null;
  readonly agentFix: string | null;
}

export type GpuWay = "same" | "live" | "restart" | "stopped" | "no";

export interface GpuPlan {
  readonly from: GpuPart;
  readonly to: GpuPart;
  readonly fromCard: Card | null;
  readonly toCard: Card | null;
  readonly way: GpuWay;
  readonly others: readonly FakeBox[];
  readonly yields: readonly FakeBox[];
  readonly installs: string | null;
  readonly person: string | null;
  readonly agent: string | null;
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

export function holdsItsCard(box: FakeBox): boolean {
  if (!box.card) return false;
  if (box.state !== "stopped") return true;
  return box.gpu === "whole" || !backendOf(box.backend).stoppedSharedYields;
}

export function holders(world: World, card: Card, except?: string): FakeBox[] {
  return world.boxes.filter((box) => box.card === card.id && box.id !== except && holdsItsCard(box));
}

export function waitingFor(world: World, card: Card, except?: string): FakeBox[] {
  return world.boxes.filter((box) => box.card === card.id && box.id !== except && !holdsItsCard(box));
}

export function usedMiB(world: World, card: Card): number {
  return card.outsideMiB + holders(world, card).reduce((sum, box) => sum + (box.state === "stopped" ? 0 : box.processes.reduce((each, process) => each + process.mib, 0)), 0);
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

export function readAgo(backend: BackendId): string {
  return `when read, ${backendOf(backend).readSecondsAgo} s ago`;
}

export function cardName(card: Card): string {
  return `card ${card.index}`;
}

export function capital(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function lowerFirst(words: string): string {
  return words.charAt(0).toLowerCase() + words.slice(1);
}

export function listed(words: readonly string[]): string {
  return words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

export function boxWord(box: FakeBox): string {
  return box.state === "stopped" ? `${box.name} (stopped)` : box.name;
}

function wholeHolder(world: World, card: Card, except?: string): FakeBox | null {
  return holders(world, card, except).find((box) => box.gpu === "whole") ?? null;
}

function limit(world: World, backend: BackendId): number | null {
  const most = world.settings[backend].boxesPerCard;
  return most > 0 ? most : null;
}

export function overLimit(world: World, card: Card): FakeBox[] {
  const most = limit(world, card.backend);
  const on = holders(world, card);
  return most === null || on.length <= most ? [] : on.slice(most);
}

export function cardState(world: World, card: Card, gpu: GpuPart, need: number, except?: string): string {
  const on = holders(world, card, except);
  const whole = wholeHolder(world, card, except);
  const name = capital(cardName(card));
  if (whole) return `${name} is ${whole.name}'s whole card`;
  if (gpu === "whole" && on.length) return `${name} has ${listed(on.map(boxWord))} on it`;
  const most = limit(world, card.backend);
  if (most !== null && on.length >= most) return `${name} has ${on.length} boxes, the most a card may have: ${listed(on.map(boxWord))}`;
  const free = freeMiB(world, card);
  if (free < need) return `${name} had ${gib(free)} free ${readAgo(card.backend)}, less than the ${gib(need)} a new box needs`;
  return `${name} has room`;
}

function shortState(world: World, card: Card, gpu: GpuPart, need: number, except?: string): string {
  const on = holders(world, card, except);
  const whole = wholeHolder(world, card, except);
  if (whole) return `${cardName(card)} is ${whole.name}'s`;
  if (gpu === "whole" && on.length) return `${cardName(card)} has ${on.length === 1 ? "1 box" : `${on.length} boxes`}`;
  const most = limit(world, card.backend);
  if (most !== null && on.length >= most) return `${cardName(card)} is full`;
  if (freeMiB(world, card) < need) return `${cardName(card)} is short of memory`;
  return `${cardName(card)} has room`;
}

function fits(world: World, card: Card, gpu: GpuPart, need: number, except?: string): boolean {
  if (freeMiB(world, card) < need) return false;
  const on = holders(world, card, except);
  if (gpu === "whole") return on.length === 0;
  const most = limit(world, card.backend);
  return !wholeHolder(world, card, except) && (most === null || on.length < most);
}

function ownBoxes(world: World, cards: readonly Card[], thread: string | undefined, except?: string): string[] {
  if (!thread) return [];
  return cards.flatMap((card) => holders(world, card, except)).filter((box) => box.thread === thread).map((box) => box.name);
}

export function place(world: World, backend: BackendId, gpu: GpuPart, desktop: boolean, options: { except?: string; prefer?: string | null; thread?: string } = {}): Placed {
  const { except, prefer, thread = AGENT_THREAD } = options;
  if (gpu === "none") return { card: null, person: null, agent: null, short: null, states: null, agentFix: null };
  const cards = cardsOf(world, backend);
  const info = backendOf(backend);
  const host = info.host;
  if (!cards.length) return { card: null, person: `${host} has no cards.`, agent: `${host} has no cards.`, short: "No cards", states: "it has no cards", agentFix: null };
  const need = needMiB(world, backend, desktop);
  if (gpu === "whole" && !world.settings[backend].wholeCards) {
    return {
      card: null,
      person: `Whole cards are off in BB Box's ${info.label} settings. Choose a shared GPU.`,
      agent: `Whole cards are off on ${host}. Ask for gpu shared, or ask the user. bb-box changed nothing.`,
      short: "Whole cards are off",
      states: "whole cards are off there",
      agentFix: "Ask for gpu shared, or ask the user.",
    };
  }
  const candidates = cards.filter((card) => fits(world, card, gpu, need, except));
  const ranked =
    gpu === "whole"
      ? [...candidates].sort((a, b) => a.outsideMiB - b.outsideMiB || freeMiB(world, b) - freeMiB(world, a) || a.index - b.index)
      : [...candidates].sort((a, b) => Number(b.id === prefer) - Number(a.id === prefer) || holders(world, a, except).length - holders(world, b, except).length || freeMiB(world, b) - freeMiB(world, a) || a.index - b.index);
  const chosen = ranked[0] ?? null;
  if (chosen) return { card: chosen, person: null, agent: null, short: null, states: null, agentFix: null };
  const what = gpu === "whole" ? "a whole card" : "a shared GPU";
  const states = cards.map((card) => cardState(world, card, gpu, need, except));
  const personFix = gpu === "whole" ? "Release one of them, or choose a shared GPU." : "Release one of them, choose no GPU, or raise the boxes per card in BB Box's settings.";
  const own = ownBoxes(world, cards, thread, except);
  const other = gpu === "whole" ? "ask for gpu shared" : "ask for gpu none";
  const agentFix = own.length ? `Release one of your own boxes there (${listed(own)}), ${other}, or ask the user.` : `${capital(other)}, or ask the user.`;
  return {
    card: null,
    person: `No card on ${host} can take ${what} now. ${states.join(". ")}. ${personFix}`,
    agent: `No card on ${host} can take ${what} now. ${states.map((each, index) => (index ? lowerFirst(each) : each)).join("; ")}. ${agentFix} bb-box changed nothing.`,
    short: capital(cards.map((card) => shortState(world, card, gpu, need, except)).join("; ")),
    states: states.map(lowerFirst).join("; "),
    agentFix,
  };
}

export function needsUserspace(box: FakeBox): string | null {
  return backendOf(box.backend).canChangeDevices && box.userspace !== HOST_DRIVER ? HOST_DRIVER : null;
}

export function planGpu(world: World, box: FakeBox, to: GpuPart): GpuPlan {
  const fromCard = cardById(world, box.card);
  const stopped = box.state === "stopped";
  const base = { from: box.gpu, to, fromCard, others: [] as FakeBox[], yields: [] as FakeBox[], installs: null as string | null };
  const refuse = (person: string, agent = `${person} bb-box changed nothing.`): GpuPlan => ({ ...base, toCard: null, way: "no", person, agent });
  if (to === box.gpu) return { ...base, toCard: fromCard, way: "same", person: null, agent: null };
  const backend = backendOf(box.backend);
  if (box.gpu === "none" || to === "none") {
    if (!backend.canChangeDevices) return refuse(`Cannot change on ${backend.label}: a container's devices are fixed when it is made. Make a new box with the GPU you want.`);
    if (to === "none") return { ...base, toCard: null, way: stopped ? "stopped" : "restart", person: null, agent: null };
    const installs = needsUserspace(box);
    if (installs && stopped) return refuse(`Start ${box.name} first: NVIDIA's userspace is installed in a running box.`);
    if (stopped && to === "shared") return { ...base, installs, toCard: null, way: "stopped", person: null, agent: null };
    const placed = place(world, box.backend, to, box.desktop, { except: box.id });
    if (!placed.card) return { ...base, toCard: null, way: "no", person: placed.person, agent: placed.agent };
    return { ...base, installs, others: holders(world, placed.card, box.id), yields: to === "whole" ? waitingFor(world, placed.card, box.id) : [], toCard: placed.card, way: stopped ? "stopped" : "restart", person: null, agent: null };
  }
  if (to === "shared") return { ...base, toCard: fromCard, others: fromCard ? holders(world, fromCard, box.id) : [], way: stopped ? "stopped" : "live", person: null, agent: null };
  if (!world.settings[box.backend].wholeCards) return refuse(`Whole cards are off in BB Box's ${backend.label} settings.`, `Whole cards are off on ${backend.host}. Keep the GPU shared, or ask the user. bb-box changed nothing.`);
  const here = fromCard ? holders(world, fromCard, box.id) : [];
  if (fromCard && !here.length) {
    return { ...base, toCard: fromCard, yields: waitingFor(world, fromCard, box.id), way: stopped ? "stopped" : "live", person: null, agent: null };
  }
  const hereWords = fromCard ? `${capital(cardName(fromCard))} has ${listed(here.map(boxWord))} on it.` : "";
  if (!backend.canChangeDevices) {
    return refuse(`${hereWords} On ${backend.label} a box cannot move to another card. Keep the GPU shared, or make a new box with a whole card.`, `${hereWords} On ${backend.label} a box cannot move to another card. Keep the GPU shared, or ask the user. bb-box changed nothing.`);
  }
  const placed = place(world, box.backend, "whole", box.desktop, { except: box.id });
  if (placed.card && placed.card.id !== fromCard?.id) {
    return { ...base, others: here, yields: waitingFor(world, placed.card, box.id), toCard: placed.card, way: stopped ? "stopped" : "restart", person: null, agent: null };
  }
  const elsewhere = cardsOf(world, box.backend)
    .filter((card) => card.id !== fromCard?.id)
    .map((card) => `${cardState(world, card, "whole", needMiB(world, box.backend, box.desktop), box.id)}.`);
  const own = ownBoxes(world, cardsOf(world, box.backend), AGENT_THREAD, box.id);
  return {
    ...base,
    toCard: null,
    way: "no",
    others: here,
    person: `No card is free for ${box.name} alone. ${hereWords}${elsewhere.length ? ` ${elsewhere.join(" ")}` : ""} Release one of them, or keep the GPU shared.`,
    agent: `No card is free for ${box.name} alone. ${hereWords}${elsewhere.length ? ` ${elsewhere.join(" ")}` : ""} ${own.length ? `Release one of your own boxes there (${listed(own)}), keep the GPU shared, or ask the user.` : "Keep the GPU shared, or ask the user."} bb-box changed nothing.`,
  };
}

export const GPU_WORDS: Readonly<Record<GpuPart, string>> = { none: "None", shared: "Shared", whole: "Whole card" };
