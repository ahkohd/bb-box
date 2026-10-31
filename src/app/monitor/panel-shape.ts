import type { MonitorSnapshot } from "../../plugin/contract.ts";
import { MOST_CARDS } from "../../monitor/nvidia.ts";

export interface PanelShape {
  gpu: boolean;
  gpuCards: number;
  battery: boolean;
  tailscaleRows: number;
}

const NO_OPTIONAL_SECTIONS: PanelShape = { gpu: false, gpuCards: 0, battery: false, tailscaleRows: 0 };
const MAX_TAILSCALE_ROWS = 4;


function storageKey(machineId: string): string {
  return `bb-box:monitor:shape:${machineId}`;
}

export function hasGpuReadings(snapshot: MonitorSnapshot): boolean {
  const sensors = snapshot.sensors;
  return gpuCardCount(snapshot) > 0 || Boolean(sensors && (sensors.gpuPercent !== null || sensors.gpuTempC !== null));
}

export function gpuCardCount(snapshot: MonitorSnapshot): number {
  return snapshot.gpus?.cards.length ?? 0;
}

export function readPanelShape(machineId: string): PanelShape {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey(machineId)) ?? "null");
    if (typeof stored !== "object" || stored === null) return NO_OPTIONAL_SECTIONS;
    const shape = stored as Record<string, unknown>;
    const tailscaleRows = typeof shape.tailscaleRows === "number" ? Math.max(0, Math.min(MAX_TAILSCALE_ROWS, Math.floor(shape.tailscaleRows))) : 0;
    const gpuCards = typeof shape.gpuCards === "number" ? Math.max(0, Math.min(MOST_CARDS, Math.floor(shape.gpuCards))) : 0;
    return { gpu: shape.gpu === true, gpuCards, battery: shape.battery === true, tailscaleRows };
  } catch {
    return NO_OPTIONAL_SECTIONS;
  }
}

export function rememberPanelShape(machineId: string, shape: PanelShape): void {
  try {
    localStorage.setItem(storageKey(machineId), JSON.stringify(shape));
  } catch {
    return;
  }
}

function cardsKey(boxId: string): string {
  return `bb-box:activity:gpu-cards:${boxId}`;
}

export function rememberedGpuCards(boxId: string): number | null {
  try {
    const stored = Number(localStorage.getItem(cardsKey(boxId)));
    return localStorage.getItem(cardsKey(boxId)) === null || !Number.isFinite(stored) ? null : Math.max(0, Math.min(MOST_CARDS, Math.floor(stored)));
  } catch {
    return null;
  }
}

export function rememberGpuCards(boxId: string, cards: number): void {
  try {
    if (localStorage.getItem(cardsKey(boxId)) !== String(cards)) localStorage.setItem(cardsKey(boxId), String(cards));
  } catch {
    return;
  }
}
