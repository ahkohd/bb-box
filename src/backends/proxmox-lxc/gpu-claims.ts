import type { CardClaim, GpuPart } from "../types.ts";
import { judgeGpuHelper, parseGpuHelper } from "./gpu-helper.ts";
import { answerTo, cardName, markerOf, markerTag, parseHelperLines, type ClaimMarker, type HelperCard, type HelperHolder, type HelperLines, type MarkAnswer } from "./gpu-marking.ts";

export const ANSWER_WAIT_MS = 10_000;
export const ANSWER_POLL_MS = 500;
export const SETTLE_WAIT_MS = 60_000;
export const SETTLE_POLL_MS = 1_000;
export const RESERVATION_LINGERS_MS = 2 * 60_000;

export interface CardMemory {
  readonly freeMiB: number;
  readonly totalMiB: number;
}

export type CardsView =
  | { readonly is: "none" }
  | { readonly is: "blocked"; readonly why: string; readonly fix: string | null }
  | { readonly is: "on"; readonly writes: boolean; readonly lines: HelperLines; readonly memory: ReadonlyMap<string, CardMemory>; readonly notes: string };

export interface ReportSeen {
  readonly node: string;
  readonly pool: string;
  readonly vmid: number;
  readonly now: number;
  readonly ago: (ms: number) => string;
}

export function cardUuid(id: string): string {
  return id.toLowerCase().replace(/^gpu-/, "");
}

function memoryOf(notes: string): Map<string, CardMemory> {
  const memory = new Map<string, CardMemory>();
  for (const [, uuid, free, total] of notes.matchAll(/^\s*gpu (\S+) \S+ \d+ (\d+) (\d+)\s*$/gm)) memory.set(cardUuid(uuid!), { freeMiB: Number(free), totalMiB: Number(total) });
  return memory;
}

export function cardsView(notes: string | null, seen: ReportSeen): CardsView {
  if (notes === null) return { is: "none" };
  const helper = parseGpuHelper(notes);
  if (!helper) return { is: "none" };
  const at = /^\s*at (\d+)\s*$/m.exec(notes);
  const untested = helper.tested === false;
  const judged = untested ? { ...helper, tested: true, writes: "off" as const } : helper;
  const verdict = judgeGpuHelper(judged, { node: seen.node, pool: seen.pool, vmid: seen.vmid, ageMs: at ? seen.now - Number(at[1]) * 1000 : null, ago: seen.ago });
  if (verdict.status === "fail") return { is: "blocked", why: verdict.detail, fix: verdict.fix };
  const lines = parseHelperLines(notes);
  if (lines.ledgerUnknown) {
    return { is: "blocked", why: `The GPU helper on ${seen.node} reports its ledger as unknown, as while it waits to rebuild a lost ledger from a full reading of every card, so bb-box cannot see its claims.`, fix: `Read why in VM ${seen.vmid}'s error lines, or with journalctl -u bb-box-gpu on ${seen.node}.` };
  }
  if (!lines.ledgerReported) {
    return { is: "blocked", why: `bb-box-gpu ${helper.version} on ${seen.node} does not report its ledger, which bb-box reads to claim a card.`, fix: `Run host/setup-gpu.sh from this BB Box's setup guide, as root on ${seen.node}.` };
  }
  if (lines.omitted.length) {
    return { is: "blocked", why: `VM ${seen.vmid}'s report leaves lines out (${lines.omitted.join("; ")}), so bb-box cannot see every guest that holds a card on ${seen.node}.`, fix: `Read what the helper says with journalctl -u bb-box-gpu on ${seen.node}.` };
  }
  if (!lines.cards.length) return { is: "blocked", why: `The GPU helper on ${seen.node} lists no card in VM ${seen.vmid}'s report.`, fix: `Run systemctl status bb-box-gpu and nvidia-smi as root on ${seen.node}.` };
  return { is: "on", writes: helper.writes === "on" && !untested, lines, memory: memoryOf(notes), notes };
}

const cardLocks = new Map<string, Promise<void>>();

export async function underCardLock<T>(node: string, run: () => Promise<T>): Promise<T> {
  const before = cardLocks.get(node) ?? Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>((resolve) => (done = resolve));
  const queued = before.then(() => mine);
  cardLocks.set(node, queued);
  await before;
  try {
    return await run();
  } finally {
    done();
    if (cardLocks.get(node) === queued) cardLocks.delete(node);
  }
}

export interface Reservation {
  readonly id: number;
  readonly card: string;
  readonly part: GpuPart;
  readonly memoryMiB: number;
  readonly boxId: string | null;
  vmid: number | null;
  settledAt: number | null;
}

export class CardReservations {
  #next = 1;
  readonly #held = new Map<number, Reservation>();
  readonly #deleted = new Map<number, number>();

  deleted(vmid: number, now: number): void {
    this.#deleted.set(vmid, now);
  }

  made(vmid: number): void {
    this.#deleted.delete(vmid);
  }

  gone(lines: HelperLines, now: number): Set<number> {
    for (const [vmid, at] of this.#deleted) {
      if (now - at >= RESERVATION_LINGERS_MS || !lines.holders.some((holder) => holder.vmid === vmid)) this.#deleted.delete(vmid);
    }
    return new Set(this.#deleted.keys());
  }

  add(card: string, part: GpuPart, memoryMiB: number, boxId: string | null, vmid: number | null): Reservation {
    const reservation: Reservation = { id: this.#next++, card, part, memoryMiB, boxId, vmid, settledAt: null };
    this.#held.set(reservation.id, reservation);
    return reservation;
  }

  drop(reservation: Reservation | null): void {
    if (reservation) this.#held.delete(reservation.id);
  }

  dropGuest(vmid: number): void {
    for (const [id, reservation] of this.#held) if (reservation.vmid === vmid) this.#held.delete(id);
  }

  dropStopped(vmid: number): void {
    for (const [id, reservation] of this.#held) if (reservation.vmid === vmid && reservation.part === "shared") this.#held.delete(id);
  }

  settle(reservation: Reservation | null, now: number): void {
    if (reservation && this.#held.has(reservation.id)) reservation.settledAt = now;
  }

  live(lines: HelperLines, now: number): Reservation[] {
    for (const [id, reservation] of this.#held) {
      if (reservation.settledAt === null) continue;
      const seen = reservation.vmid !== null && lines.holders.some((holder) => holder.vmid === reservation.vmid && holder.card === reservation.card && holder.running);
      if (seen || now - reservation.settledAt >= RESERVATION_LINGERS_MS) this.#held.delete(id);
    }
    return [...this.#held.values()];
  }

  inFlight(): Set<number> {
    return new Set([...this.#held.values()].flatMap((reservation) => (reservation.vmid !== null && reservation.settledAt === null ? [reservation.vmid] : [])));
  }
}

const reservationsByNode = new Map<string, CardReservations>();

export function reservationsOn(node: string): CardReservations {
  let reservations = reservationsByNode.get(node);
  if (!reservations) reservationsByNode.set(node, (reservations = new CardReservations()));
  return reservations;
}

export interface OwnGuest {
  readonly vmid: number;
  readonly tags: readonly string[];
}

export function outstandingRequests(lines: HelperLines, ours: readonly OwnGuest[], inFlight: ReadonlySet<number>): { readonly vmid: number; readonly marker: NonNullable<ReturnType<typeof markerOf>> }[] {
  return ours.flatMap((guest) => {
    const marker = markerOf(guest.tags);
    if (!marker || inFlight.has(guest.vmid)) return [];
    if (lines.would.some((line) => line.vmid === guest.vmid && line.words.endsWith(`for request g${marker.generation}`))) return [];
    return marker.generation > (lines.ledger.get(guest.vmid)?.answered ?? 0) ? [{ vmid: guest.vmid, marker }] : [];
  });
}

export interface PlaceInput {
  readonly lines: HelperLines;
  readonly memory: ReadonlyMap<string, CardMemory>;
  readonly installId: string;
  readonly reserved: readonly Reservation[];
  readonly limit: number | null;
  readonly needMiB: number;
  readonly candidates: ReadonlySet<string>;
  readonly prefer: string | null;
  readonly vmid: number | null;
  readonly outstanding: readonly { readonly vmid: number; readonly marker: { readonly card: string | null; readonly generation: number } }[];
  readonly gone?: ReadonlySet<number>;
}

export interface CardLoad {
  readonly card: HelperCard;
  readonly boxes: number;
  readonly own: number;
  readonly freeMiB: number | null;
}

export type Placed = { readonly is: "placed"; readonly card: HelperCard; readonly loads: readonly CardLoad[] } | { readonly is: "refused"; readonly reasons: readonly string[]; readonly loads: readonly CardLoad[] };

function holdsPlace(holder: HelperHolder): boolean {
  return holder.running || holder.part === "whole" || !holder.managed;
}

function inWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export function loadOf(card: HelperCard, input: Pick<PlaceInput, "lines" | "memory" | "installId" | "reserved" | "vmid" | "gone">): CardLoad & { readonly whole: HelperHolder | null } {
  const holders = input.lines.holders.filter((holder) => holder.card === card.uuid && holder.vmid !== input.vmid && !input.gone?.has(holder.vmid));
  const counted = holders.filter(holdsPlace);
  const seen = new Set(counted.map((holder) => holder.vmid));
  const others = input.reserved.filter((reservation) => reservation.card === card.uuid && (input.vmid === null || reservation.vmid !== input.vmid));
  const reserved = others.filter((reservation) => reservation.vmid === null || !seen.has(reservation.vmid));
  const own = new Set(counted.filter((holder) => holder.install === input.installId).map((holder) => holder.vmid)).size + reserved.length;
  const memory = input.memory.get(card.uuid);
  const reservedMiB = others.reduce((sum, reservation) => sum + reservation.memoryMiB, 0);
  return {
    card,
    boxes: seen.size + reserved.length,
    own,
    freeMiB: memory ? memory.freeMiB - reservedMiB : null,
    whole: holders.find((holder) => holder.part === "whole") ?? null,
  };
}

export function placeShared(input: PlaceInput): Placed {
  const cards = [...input.lines.cards].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const reasons: string[] = [];
  const loads: CardLoad[] = [];
  const open: CardLoad[] = [];
  for (const card of cards) {
    if (!input.candidates.has(card.uuid)) continue;
    const load = loadOf(card, input);
    loads.push(load);
    const waiting = input.outstanding.find((request) => request.marker.card === card.uuid);
    const unsettled = [...new Set(input.lines.unsettled.filter((line) => line.card === card.uuid && line.vmid !== input.vmid).map((line) => line.vmid))];
    if (load.whole) reasons.push(`${cardName(card)} is CT ${load.whole.vmid}'s whole card`);
    else if (unsettled.length) reasons.push(`${cardName(card)} waits for ${inWords(unsettled.map((vmid) => `CT ${vmid}`))} to ask again, as the GPU helper's ledger was lost and ${unsettled.length === 1 ? "it" : "each"} may hold the card`);
    else if (input.limit !== null && load.own >= input.limit) reasons.push(`${cardName(card)} has ${load.own} of this install's boxes, the most a card may have`);
    else if (waiting) reasons.push(`the GPU helper has not answered CT ${waiting.vmid}'s request g${waiting.marker.generation} on ${cardName(card)}`);
    else open.push(load);
  }
  if (!open.length) return { is: "refused", reasons, loads };
  const roomy = open.filter((load) => load.freeMiB === null || load.freeMiB >= input.needMiB);
  const choices = roomy.length ? roomy : open;
  const preferred = choices.find((load) => load.card.uuid === input.prefer);
  if (preferred) return { is: "placed", card: preferred.card, loads };
  const best = [...choices].sort((a, b) => a.boxes - b.boxes || (b.freeMiB ?? 0) - (a.freeMiB ?? 0) || (a.card.index ?? 0) - (b.card.index ?? 0))[0]!;
  return { is: "placed", card: best.card, loads };
}

export function refusalWords(node: string, reasons: readonly string[]): string {
  return reasons.length ? `No card on ${node} can take another box now: ${inWords(reasons)}.` : `No card on ${node} can take another box now.`;
}

export function nextGeneration(lines: HelperLines, vmid: number, onGuest: number, written: number): number {
  const entry = lines.ledger.get(vmid);
  const answered = lines.answers.filter((answer) => answer.vmid === vmid).map((answer) => answer.generation);
  return Math.max(entry?.answered ?? 0, entry?.claim?.generation ?? 0, onGuest, written, ...answered) + 1;
}

export function claimOf(marker: ClaimMarker, answer: CardClaim["answer"]): CardClaim {
  return { card: marker.card, part: marker.part, generation: marker.generation, answer };
}

export interface Answering {
  readonly read: () => Promise<HelperLines | null>;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
}

export async function waitForAnswer(answering: Answering, vmid: number, marker: ClaimMarker, waitMs = ANSWER_WAIT_MS, pollMs = ANSWER_POLL_MS): Promise<MarkAnswer> {
  for (let poll = 0; ; poll++) {
    const lines = await answering.read();
    const answer = lines ? answerTo(lines, vmid, marker, true) : ({ is: "unanswered" } as const);
    if (answer.is === "granted" || answer.is === "refused") return answer;
    if (poll * pollMs >= waitMs) return answer;
    await answering.sleep(pollMs, answering.signal);
  }
}

export function notAnsweredWords(node: string, answer: MarkAnswer, waitMs = ANSWER_WAIT_MS): string {
  if (answer.is === "would") return `The host's GPU helper on ${node} has writes off, and ${answer.why}. Run bb box doctor.`;
  return `The host's GPU helper on ${node} did not answer within ${Math.round(waitMs / 1000)} s. Run bb box doctor.`;
}

export async function settleOutstanding(answering: Answering, ours: () => Promise<readonly OwnGuest[]>, waitMs = SETTLE_WAIT_MS, pollMs = SETTLE_POLL_MS): Promise<{ readonly vmid: number; readonly marker: string }[]> {
  const guests = await ours();
  for (let poll = 0; ; poll++) {
    const lines = await answering.read();
    if (!lines?.ledgerReported) return [];
    const left = outstandingRequests(lines, guests, new Set());
    if (!left.length) return [];
    if (poll * pollMs >= waitMs) return left.map(({ vmid, marker }) => ({ vmid, marker: markerTag(marker) }));
    await answering.sleep(pollMs, answering.signal);
  }
}
