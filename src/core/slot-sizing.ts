import { deviceModels } from "./device.ts";
import { CAP_SHARE, FULL_STREAM_FPS, SOFTWARE_SHARE, UNMEASURED_BUDGET, budgetForChip, frameCost, softwareCores, stepPixels } from "./encoder-ledger.ts";

export const BUSY_SIMULATOR_CORES = 1.3;
export const SLOT_MEMORY_GIB = 1.5;
export const HOST_OWN_MEMORY_GIB = 8;
export const SLOT_STREAM_STEP = "half" as const;
export const MOST_SLOTS = 64;

export interface SlotsSizedBy {
  readonly most?: number;
  readonly cores?: number;
  readonly memoryGiB?: number;
}

export interface MacForSlots {
  readonly name: string;
  readonly cores: number | null;
  readonly performanceCores: number | null;
  readonly memoryGiB: number | null;
  readonly chip: string | null;
  readonly hardware?: boolean | null;
}

export interface Sized {
  readonly value: number;
  readonly from: string;
}

export interface HostSizing {
  readonly most: Sized;
  readonly cores: Sized;
  readonly memoryGiB: Sized;
}

export interface MacSlotSizing {
  readonly most: Sized;
}

export interface SizingDefaults {
  readonly most: number;
  readonly cores: number;
  readonly memoryGiB: number;
}

const MAC_OVERRIDE = "set for this Mac";
const BACKEND_SETTING = "the backend's setting";

function slotScreen(): { readonly width: number; readonly height: number } {
  const model = deviceModels("ios")[0]!;
  return model.form === "foldable" ? model.outer.pixels : model.screen.pixels;
}

function streamPerSlot(): number {
  return FULL_STREAM_FPS * frameCost(stepPixels(slotScreen(), SLOT_STREAM_STEP));
}

export function slotsTheCpuAllows(cores: number): number {
  return Math.max(1, Math.floor((cores * SOFTWARE_SHARE) / softwareCores({ pixels: slotScreen(), fps: FULL_STREAM_FPS }, SLOT_STREAM_STEP)));
}

function videoCandidate(mac: MacForSlots, cores: number | null): { readonly slots: number; readonly why: string } {
  if (mac.hardware === false && cores) {
    const each = softwareCores({ pixels: slotScreen(), fps: FULL_STREAM_FPS }, SLOT_STREAM_STEP);
    return { slots: slotsTheCpuAllows(cores), why: `video in software, as it has no hardware H.264 encoder (each slot a stream at a half at ${FULL_STREAM_FPS} a second, about ${each.toFixed(2)} of a core, within a quarter of its ${cores} cores)` };
  }
  return { slots: slotsTheEncoderAllows(mac.chip).slots, why: encoderWhy(mac.chip) };
}

export function slotsTheEncoderAllows(chip: string | null): { readonly slots: number; readonly budget: number; readonly measured: boolean } {
  const known = budgetForChip(chip);
  const budget = known ?? UNMEASURED_BUDGET;
  return { slots: Math.max(1, Math.floor((budget * CAP_SHARE) / streamPerSlot())), budget, measured: known !== null };
}

function slotsTheCoresAllow(cores: number): number {
  return Math.max(1, Math.floor(cores / BUSY_SIMULATOR_CORES));
}

function slotsTheMemoryAllows(memoryGiB: number): number {
  return Math.max(1, Math.floor((memoryGiB - HOST_OWN_MEMORY_GIB) / SLOT_MEMORY_GIB));
}

function memoryForSlots(slots: number): number {
  return Math.ceil(HOST_OWN_MEMORY_GIB + slots * SLOT_MEMORY_GIB);
}

function fewest(candidates: readonly { readonly slots: number; readonly why: string }[]): Sized {
  const least = candidates.reduce((best, each) => (each.slots < best.slots ? each : best));
  return { value: Math.min(MOST_SLOTS, least.slots), from: `estimated: ${candidates.map((each) => `${each.slots} for ${each.why}`).join(", ")}; the fewest` };
}

function encoderWhy(chip: string | null): string {
  const { budget, measured } = slotsTheEncoderAllows(chip);
  return `the video encoder (${measured ? `an ${chip}` : "a chip not measured"}, about ${budget} full-size frames a second, each slot a stream at a half at ${FULL_STREAM_FPS} a second within three quarters of it)`;
}

function chosen(mac: number | undefined, backend: number | undefined): Sized | null {
  if (mac !== undefined) return { value: mac, from: MAC_OVERRIDE };
  if (backend !== undefined) return { value: backend, from: BACKEND_SETTING };
  return null;
}

export function sizeHost(mac: MacForSlots, macSet: SlotsSizedBy, backendSet: SlotsSizedBy, defaults: SizingDefaults, memoryLeftGiB: number | null): HostSizing {
  const performance = mac.performanceCores ?? mac.cores;
  const cores =
    chosen(macSet.cores, backendSet.cores) ??
    (performance ? { value: performance, from: `estimated: ${mac.name}'s ${mac.performanceCores ? "performance cores" : "cores"}` } : { value: defaults.cores, from: `${mac.name} did not say its cores, so the default` });
  const memorySet = chosen(macSet.memoryGiB, backendSet.memoryGiB);
  const most =
    chosen(macSet.most, backendSet.most) ??
    fewest([
      { slots: slotsTheCoresAllow(cores.value), why: `${cores.value} cores at ${BUSY_SIMULATOR_CORES} a busy device` },
      ...(memorySet
        ? [{ slots: slotsTheMemoryAllows(memorySet.value), why: `${memorySet.value} GiB at ${SLOT_MEMORY_GIB} GiB a device, after ${HOST_OWN_MEMORY_GIB} GiB for the host` }]
        : memoryLeftGiB !== null
          ? [{ slots: slotsTheMemoryAllows(memoryLeftGiB), why: `the ${memoryLeftGiB} GiB of ${mac.name}'s memory a host may have, at ${SLOT_MEMORY_GIB} GiB a device after ${HOST_OWN_MEMORY_GIB} GiB for the host` }]
          : []),
      videoCandidate(mac, cores.value),
    ]);
  const wanted = memoryForSlots(most.value);
  const memoryGiB =
    memorySet ??
    (memoryLeftGiB !== null && wanted > memoryLeftGiB
      ? { value: Math.max(8, memoryLeftGiB), from: `estimated: all ${mac.name} can give a host, ${memoryLeftGiB} GiB, short of the ${wanted} GiB its slots would take` }
      : { value: wanted, from: `estimated: ${HOST_OWN_MEMORY_GIB} GiB for the host and ${SLOT_MEMORY_GIB} GiB for each of its ${most.value} slots` });
  return { most, cores, memoryGiB };
}

export function sizeMacSlots(mac: MacForSlots, macSet: number | undefined, backendSet: number | undefined, fallback: number): MacSlotSizing {
  const set = chosen(macSet, backendSet);
  if (set) return { most: set };
  if (!mac.cores && !mac.memoryGiB) return { most: { value: fallback, from: `${mac.name} did not say its cores or memory yet, so the default` } };
  return {
    most: fewest([
      ...(mac.cores ? [{ slots: slotsTheCoresAllow(mac.cores), why: `${mac.cores} cores at ${BUSY_SIMULATOR_CORES} a busy device` }] : []),
      ...(mac.memoryGiB ? [{ slots: slotsTheMemoryAllows(mac.memoryGiB), why: `${mac.memoryGiB} GiB at ${SLOT_MEMORY_GIB} GiB a device after ${HOST_OWN_MEMORY_GIB} GiB for the Mac` }] : []),
      videoCandidate(mac, mac.cores),
    ]),
  };
}

export function hostSizingWords(sizing: HostSizing): string {
  return `${sizing.most.value} slots (${sizing.most.from}), ${sizing.cores.value} cores (${sizing.cores.from}), ${sizing.memoryGiB.value} GiB (${sizing.memoryGiB.from})`;
}

export function macSlotSizingWords(sizing: MacSlotSizing): string {
  return `${sizing.most.value} slots (${sizing.most.from})`;
}
