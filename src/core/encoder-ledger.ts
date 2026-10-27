import type { DoctorCheck } from "../backends/types.ts";
import type { CheckId } from "./checks.ts";
import { VIDEO_STEPS, VIDEO_STEP_SCALES, largerStep, smallerStep, type VideoSize, type VideoStep, type VideoWant, type WantFor } from "./device.ts";

export type { VideoWant, WantFor };
export type RoomFor = "control" | WantFor;

export const ROOM_ORDER: readonly RoomFor[] = ["control", "recording", "viewer", "wait"];

export interface LedgerStream {
  readonly box: string;
  readonly name: string;
  readonly pixels: VideoSize;
  readonly wants: readonly VideoWant[];
  readonly fps: number;
  readonly controlled: boolean;
}

export interface Allotted {
  readonly box: string;
  readonly wanted: VideoStep;
  readonly step: VideoStep;
  readonly room: RoomFor;
  readonly rate: number;
}

export interface Allotment {
  readonly streams: ReadonlyMap<string, Allotted>;
  readonly used: number;
  readonly cap: number;
  readonly beyond: boolean;
}

export const FPS_FLOOR = 20;
export const STILL_FPS_MOST = 5;
export const FULL_MOST = 2;
export const CAP_SHARE = 0.75;
export const RISE_AFTER_MS = 10_000;
export const VM_START_WARNING_MS = 30_000;
export const FULL_STREAM_FPS = 60;
export const NAMED_MOST = 4;
export const STEP_FLOOR: VideoStep = "third";
export const RECORDING_FLOOR: VideoStep = "half";

export const CHIP_BUDGETS: Readonly<Record<string, number>> = {
  "Apple M4 Max": 320,
  "Apple M5 Max": 375,
};

export const UNMEASURED_BUDGET = Math.min(...Object.values(CHIP_BUDGETS));

const FRAME_COSTS: readonly { readonly pixels: number; readonly cost: number }[] = [
  { pixels: 402 * 874, cost: 0.18 },
  { pixels: 604 * 1312, cost: 0.33 },
  { pixels: 804 * 1748, cost: 0.57 },
  { pixels: 1206 * 2622, cost: 1 },
  { pixels: 2064 * 2752, cost: 1.75 },
];

export function frameCost(pixels: number): number {
  const first = FRAME_COSTS[0]!;
  if (pixels <= first.pixels) return (first.cost * pixels) / first.pixels;
  for (let at = 1; at < FRAME_COSTS.length; at++) {
    const low = FRAME_COSTS[at - 1]!;
    const high = FRAME_COSTS[at]!;
    if (pixels <= high.pixels || at === FRAME_COSTS.length - 1) return low.cost + ((pixels - low.pixels) * (high.cost - low.cost)) / (high.pixels - low.pixels);
  }
  return first.cost;
}

export function stepPixels(device: VideoSize, step: VideoStep): number {
  const scale = VIDEO_STEP_SCALES[step];
  return Math.round(device.width * scale) * Math.round(device.height * scale);
}

export function streamRate(stream: Pick<LedgerStream, "pixels" | "fps">, step: VideoStep): number {
  return Math.max(stream.fps, FPS_FLOOR) * frameCost(stepPixels(stream.pixels, step));
}

export function budgetForChip(chip: string | null): number | null {
  return chip !== null && chip in CHIP_BUDGETS ? CHIP_BUDGETS[chip]! : null;
}

export function wantedStep(wants: readonly VideoWant[]): VideoStep | null {
  return wants.reduce<VideoStep | null>((most, want) => (most ? largerStep(most, want.step) : want.step), null);
}

export function roomOf(stream: Pick<LedgerStream, "wants" | "controlled">): RoomFor {
  if (stream.controlled && stream.wants.some((want) => want.for === "viewer")) return "control";
  return ROOM_ORDER.find((room) => stream.wants.some((want) => want.for === room)) ?? "wait";
}

function floorOf(stream: LedgerStream, wanted: VideoStep): VideoStep {
  const floor = stream.wants.some((want) => want.for === "recording") ? RECORDING_FLOOR : STEP_FLOOR;
  return smallerStep(floor, wanted);
}

function stepBelow(step: VideoStep): VideoStep {
  return VIDEO_STEPS[Math.max(0, VIDEO_STEPS.indexOf(step) - 1)]!;
}

function rank(room: RoomFor): number {
  return ROOM_ORDER.indexOf(room);
}

interface Working {
  readonly stream: LedgerStream;
  readonly wanted: VideoStep;
  readonly room: RoomFor;
  readonly floor: VideoStep;
  step: VideoStep;
  kept: boolean;
}

export function isStill(stream: Pick<LedgerStream, "fps">): boolean {
  return stream.fps <= STILL_FPS_MOST;
}

function fullPlaceClaim(each: Working, heldFull: ReadonlySet<string>, busyWaiting: ReadonlySet<string>): number {
  const held = heldFull.has(each.stream.box);
  if (held && !(isStill(each.stream) && busyWaiting.size > 0)) return 2;
  return busyWaiting.has(each.stream.box) ? 1 : 0;
}

export function allot(streams: readonly LedgerStream[], budget: number, heldFull: ReadonlySet<string> = new Set(), busyWaiting: ReadonlySet<string> = new Set()): Allotment {
  const cap = budget * CAP_SHARE;
  const working: Working[] = [];
  for (const stream of streams) {
    const wanted = wantedStep(stream.wants);
    if (!wanted) continue;
    working.push({ stream, wanted, room: roomOf(stream), floor: floorOf(stream, wanted), step: wanted, kept: false });
  }
  const wantFull = working.filter((each) => each.wanted === "full");
  wantFull.sort((a, b) => rank(a.room) - rank(b.room) || fullPlaceClaim(b, heldFull, busyWaiting) - fullPlaceClaim(a, heldFull, busyWaiting) || a.stream.box.localeCompare(b.stream.box));
  wantFull.forEach((each, at) => {
    if (at >= FULL_MOST) each.step = "two-thirds";
    else if (each.room === "control") each.kept = true;
  });
  const rateOf = (each: Working) => streamRate(each.stream, each.step);
  let used = working.reduce((sum, each) => sum + rateOf(each), 0);
  while (used > cap) {
    const lowerable = working.filter((each) => !each.kept && VIDEO_STEPS.indexOf(each.step) > VIDEO_STEPS.indexOf(each.floor));
    if (!lowerable.length) break;
    lowerable.sort((a, b) => rank(b.room) - rank(a.room) || rateOf(b) - rateOf(a) || a.stream.box.localeCompare(b.stream.box));
    const lowest = lowerable[0]!;
    const before = rateOf(lowest);
    lowest.step = stepBelow(lowest.step);
    used += rateOf(lowest) - before;
  }
  const allotted = new Map<string, Allotted>(working.map((each) => [each.stream.box, { box: each.stream.box, wanted: each.wanted, step: each.step, room: each.room, rate: rateOf(each) }]));
  return { streams: allotted, used, cap, beyond: used > cap };
}

export interface Held {
  readonly step: VideoStep;
  readonly wanted: VideoStep;
  readonly risingSince: number | null;
}

export function heldAfter(previous: Held | undefined, fresh: Allotted, now: number): Held {
  if (!previous || fresh.room === "control" || !lowered(previous)) return { step: fresh.step, wanted: fresh.wanted, risingSince: null };
  const from = VIDEO_STEPS.indexOf(previous.step);
  const to = VIDEO_STEPS.indexOf(fresh.step);
  if (to <= from) return { step: fresh.step, wanted: fresh.wanted, risingSince: null };
  const since = previous.risingSince ?? now;
  if (now - since >= RISE_AFTER_MS) return { step: fresh.step, wanted: fresh.wanted, risingSince: null };
  return { step: previous.step, wanted: fresh.wanted, risingSince: since };
}

export function lowered(held: Held): boolean {
  return VIDEO_STEPS.indexOf(held.step) < VIDEO_STEPS.indexOf(held.wanted);
}

export function namedBoxes(names: readonly string[]): string {
  const shown = names.slice(0, NAMED_MOST).map((name) => `box ${name}`);
  const more = names.length - shown.length;
  if (!more) return shown.join(", ");
  return `${shown.join(", ")} and ${more} more`;
}

export function loweredWords(others: readonly string[]): string {
  if (!others.length) return "Shown at a lower resolution: this Mac's video encoder is busy.";
  const devices = others.length === 1 ? "1 other device" : `${others.length} other devices`;
  return `Shown at a lower resolution: this Mac's video encoder is busy with ${devices} (${namedBoxes(others)}).`;
}

export const ENCODER_FULL_WORDS = "This Mac's video encoder is full, so frames come more slowly.";
export const VM_STARTING_WORDS = "A VM is starting on this Mac; video may slow for about 30 s.";

export function roomWords(used: number, budget: number): string {
  const inUse = used > 0 && used < FULL_STREAM_FPS / 2 ? "under 1" : String(Math.round(used / FULL_STREAM_FPS));
  return `On this Mac: ${inUse} of about ${Math.round(budget / FULL_STREAM_FPS)} full-size streams' room in use.`;
}

export function encoderKey(backend: string, mac: string): string {
  return `${backend}\u0000${mac}`;
}

export function encoderKeyParts(key: string): { readonly backend: string; readonly mac: string } {
  const at = key.indexOf("\u0000");
  return at < 0 ? { backend: key, mac: "" } : { backend: key.slice(0, at), mac: key.slice(at + 1) };
}

export interface EncoderPlace {
  readonly mac: string;
  readonly label: string;
  readonly chip: string | null;
}

export interface StreamReport {
  readonly pixels: VideoSize;
  readonly wants: readonly VideoWant[];
  readonly fps: number;
}

export interface Decision {
  readonly cap: VideoStep | null;
  readonly words: string | null;
}

export const NO_DECISION: Decision = { cap: null, words: null };

export interface EncoderLedgersDeps {
  on(): boolean;
  controlled(box: string): boolean;
  send(box: string, decision: Decision): void;
  probe(mac: string, signal: AbortSignal): Promise<number | null>;
  log(line: string): void;
  logError(operation: string, error: unknown): void;
  now?(): number;
}

interface Watched {
  readonly box: string;
  readonly name: string;
  readonly report: StreamReport;
}

interface MacLedger {
  place: EncoderPlace;
  readonly streams: Map<string, Watched>;
  readonly held: Map<string, Held>;
  readonly busyBelowFullSince: Map<string, number>;
  allotment: Allotment | null;
  startingUntil: number;
  startingTimer: ReturnType<typeof setTimeout> | null;
}

type BudgetSource = { readonly budget: number; readonly from: "chip" | "probe" | "assumed" };

export class EncoderLedgers {
  readonly #deps: EncoderLedgersDeps;
  readonly #macs = new Map<string, MacLedger>();
  readonly #macOf = new Map<string, string>();
  readonly #sent = new Map<string, Decision>();
  readonly #measured = new Map<string, number>();
  readonly #probing = new Map<string, Promise<void>>();
  readonly #unprobed = new Map<string, string>();
  readonly #stopping = new AbortController();

  constructor(deps: EncoderLedgersDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  get on(): boolean {
    return this.#deps.on();
  }

  #ledger(place: EncoderPlace): MacLedger {
    let ledger = this.#macs.get(place.mac);
    if (!ledger) {
      ledger = { place, streams: new Map(), held: new Map(), busyBelowFullSince: new Map(), allotment: null, startingUntil: 0, startingTimer: null };
      this.#macs.set(place.mac, ledger);
    }
    if (place.chip !== null || ledger.place.chip === null) ledger.place = place;
    return ledger;
  }

  budget(mac: string): BudgetSource {
    const chip = this.#macs.get(mac)?.place.chip ?? null;
    const fromChip = budgetForChip(chip);
    if (fromChip !== null) return { budget: fromChip, from: "chip" };
    const measured = chip !== null ? this.#measured.get(chip) : undefined;
    if (measured !== undefined) return { budget: measured, from: "probe" };
    return { budget: UNMEASURED_BUDGET, from: "assumed" };
  }

  report(box: { readonly id: string; readonly name: string }, place: EncoderPlace, report: StreamReport): void {
    const before = this.#macOf.get(box.id);
    if (before && before !== place.mac) this.forget(box.id);
    this.#macOf.set(box.id, place.mac);
    const ledger = this.#ledger(place);
    ledger.streams.set(box.id, { box: box.id, name: box.name, report });
    this.#update(place.mac);
  }

  controlChanged(boxId: string): void {
    const mac = this.#macOf.get(boxId);
    if (mac) this.#update(mac);
  }

  forget(boxId: string): void {
    const mac = this.#macOf.get(boxId);
    this.#macOf.delete(boxId);
    this.#sent.delete(boxId);
    if (!mac) return;
    const ledger = this.#macs.get(mac);
    ledger?.streams.delete(boxId);
    ledger?.held.delete(boxId);
    this.#update(mac);
  }

  vmStarting(mac: string, place?: Omit<EncoderPlace, "mac">): void {
    const ledger = this.#macs.get(mac) ?? (place ? this.#ledger({ mac, ...place }) : null);
    if (!ledger) return;
    ledger.startingUntil = this.#now() + VM_START_WARNING_MS;
    if (ledger.startingTimer) clearTimeout(ledger.startingTimer);
    ledger.startingTimer = setTimeout(() => {
      ledger.startingTimer = null;
      this.#update(mac);
    }, VM_START_WARNING_MS);
    ledger.startingTimer.unref?.();
    this.#deps.log(`A VM is starting on ${ledger.place.label}: its viewers are told that video may slow for about 30 s.`);
    this.#update(mac);
  }

  load(mac: string): number {
    return this.#macs.get(mac)?.allotment?.used ?? 0;
  }

  decision(boxId: string): Decision {
    return this.#sent.get(boxId) ?? NO_DECISION;
  }

  roomWords(boxId: string): string | null {
    const mac = this.#macOf.get(boxId);
    if (!mac || !this.on) return null;
    return roomWords(this.load(mac), this.budget(mac).budget);
  }

  refresh(): void {
    for (const mac of this.#macs.keys()) this.#update(mac);
  }

  #update(mac: string): void {
    const ledger = this.#macs.get(mac);
    if (!ledger) return;
    if (!this.on) {
      ledger.allotment = null;
      ledger.held.clear();
      for (const box of ledger.streams.keys()) this.#send(box, NO_DECISION);
      return;
    }
    const { budget } = this.budget(mac);
    const now = this.#now();
    const streams: LedgerStream[] = [...ledger.streams.values()].map((each) => ({ box: each.box, name: each.name, pixels: each.report.pixels, wants: each.report.wants, fps: each.report.fps, controlled: this.#deps.controlled(each.box) }));
    const heldFull = new Set([...ledger.held].filter(([, held]) => held.step === "full").map(([box]) => box));
    const busyWaiting = this.#busyWaitingForFull(ledger, streams, heldFull, now);
    const allotment = allot(streams, budget, heldFull, busyWaiting);
    ledger.allotment = allotment;
    for (const box of [...ledger.held.keys()]) if (!allotment.streams.has(box)) ledger.held.delete(box);
    const starting = now < ledger.startingUntil;
    const watching = streams.filter((stream) => allotment.streams.has(stream.box));
    for (const stream of streams) {
      const fresh = allotment.streams.get(stream.box);
      if (!fresh) {
        this.#send(stream.box, starting ? { cap: null, words: VM_STARTING_WORDS } : NO_DECISION);
        continue;
      }
      const previous = ledger.held.get(stream.box);
      const waitedSince = busyWaiting.has(stream.box) ? ledger.busyBelowFullSince.get(stream.box) : undefined;
      const held = heldAfter(previous && waitedSince !== undefined ? { ...previous, risingSince: Math.min(previous.risingSince ?? now, waitedSince) } : previous, fresh, now);
      ledger.held.set(stream.box, held);
      const isLowered = lowered(held);
      const others = watching.filter((other) => other.box !== stream.box).map((other) => other.name).sort();
      const words = [isLowered ? loweredWords(others) : null, allotment.beyond ? ENCODER_FULL_WORDS : null, starting ? VM_STARTING_WORDS : null].filter((each): each is string => each !== null);
      this.#send(stream.box, { cap: isLowered ? held.step : null, words: words.length ? words.join(" ") : null });
    }
    if (!watching.length) this.#probeIfUnknown(ledger);
  }

  #busyWaitingForFull(ledger: MacLedger, streams: readonly LedgerStream[], heldFull: ReadonlySet<string>, now: number): ReadonlySet<string> {
    const waiting = new Set<string>();
    for (const stream of streams) {
      if (isStill(stream) || wantedStep(stream.wants) !== "full" || heldFull.has(stream.box)) {
        ledger.busyBelowFullSince.delete(stream.box);
        continue;
      }
      const since = ledger.busyBelowFullSince.get(stream.box) ?? now;
      ledger.busyBelowFullSince.set(stream.box, since);
      if (now - since >= RISE_AFTER_MS) waiting.add(stream.box);
    }
    for (const box of [...ledger.busyBelowFullSince.keys()]) if (!streams.some((stream) => stream.box === box)) ledger.busyBelowFullSince.delete(box);
    return waiting;
  }

  #send(box: string, decision: Decision): void {
    const sent = this.#sent.get(box) ?? NO_DECISION;
    if (sent.cap === decision.cap && sent.words === decision.words) return;
    this.#sent.set(box, decision);
    this.#deps.send(box, decision);
  }

  #probeIfUnknown(ledger: MacLedger): void {
    const { mac, chip, label } = ledger.place;
    if (chip === null || budgetForChip(chip) !== null || this.#measured.has(chip) || this.#probing.has(mac) || this.#unprobed.has(chip)) return;
    const probing = (async () => {
      this.#deps.log(`The video encoder of ${label}, an ${chip}, is not in bb-box's table; measuring it for 15 s while nothing streams there.`);
      const measured = await this.#deps.probe(mac, this.#stopping.signal);
      if (measured === null || !(measured > 0)) {
        this.#unprobed.set(chip, `bb-box could not measure the video encoder of ${label}`);
        return;
      }
      this.#measured.set(chip, measured);
      this.#deps.log(`The video encoder of ${label}, an ${chip}, gave ${Math.round(measured)} full-size iPhone frames a second.`);
      this.#update(mac);
    })()
      .catch((error) => {
        this.#unprobed.set(chip, `measuring the video encoder of ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
        this.#deps.logError(`measure the video encoder of ${label}`, error);
      })
      .finally(() => this.#probing.delete(mac));
    this.#probing.set(mac, probing);
  }

  checks(): DoctorCheck[] {
    return [...this.#macs.values()].map((ledger) => this.#check(ledger));
  }

  #check(ledger: MacLedger): DoctorCheck {
    const { mac, chip, label } = ledger.place;
    const id = `encoder.${label}` as CheckId;
    const name = `Video encoder on ${label}`;
    if (!this.on) return { id, name, status: "skipped", detail: "The encoder ledger is off in bb-box's settings: shared ios boxes' streams are capped at two thirds, and nothing else is.", fix: null };
    const { budget, from } = this.budget(mac);
    const why = chip !== null ? this.#unprobed.get(chip) : undefined;
    const source = from === "chip" ? `an ${chip}, about ${budget} full-size iPhone frames a second` : from === "probe" ? `an ${chip}, measured at ${Math.round(budget)} full-size iPhone frames a second` : `${chip ? `an ${chip}, which is not in bb-box's table` : "a chip bb-box has not read"}; bb-box assumes ${budget} full-size iPhone frames a second`;
    const allotment = ledger.allotment;
    const lowered = [...ledger.held].filter(([, held]) => VIDEO_STEPS.indexOf(held.step) < VIDEO_STEPS.indexOf(held.wanted)).map(([box]) => ledger.streams.get(box)?.name ?? box).sort();
    const streams = allotment?.streams.size ?? 0;
    const loweredText = lowered.length ? ` Shown at a lower resolution: ${namedBoxes(lowered)}.` : "";
    const detail = `${roomWords(allotment?.used ?? 0, budget)} ${streams === 1 ? "1 stream" : `${streams} streams`}; ${source}.${loweredText}${allotment?.beyond ? ` ${ENCODER_FULL_WORDS}` : ""}${why ? ` ${why}.` : ""}`;
    const warn = from === "assumed" && chip !== null;
    return { id, name, status: allotment?.beyond || warn ? "warn" : "ok", detail, fix: warn ? `bb-box measures it with ffmpeg's h264_videotoolbox when nothing streams on ${label}. Install ffmpeg there, or add the chip to CHIP_BUDGETS in src/core/encoder-ledger.ts.` : null };
  }

  dispose(): void {
    this.#stopping.abort();
    for (const ledger of this.#macs.values()) if (ledger.startingTimer) clearTimeout(ledger.startingTimer);
  }
}
