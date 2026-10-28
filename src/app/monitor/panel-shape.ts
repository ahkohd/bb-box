import type { MonitorSnapshot } from "../../plugin/contract.ts";

export interface PanelShape {
  gpu: boolean;
  battery: boolean;
  tailscaleRows: number;
}

const NO_OPTIONAL_SECTIONS: PanelShape = { gpu: false, battery: false, tailscaleRows: 0 };
const MAX_TAILSCALE_ROWS = 4;

function storageKey(machineId: string): string {
  return `bb-box:monitor:shape:${machineId}`;
}

export function hasGpuReadings(snapshot: MonitorSnapshot): boolean {
  const sensors = snapshot.sensors;
  return Boolean(sensors && (sensors.gpuPercent !== null || sensors.gpuTempC !== null));
}

export function readPanelShape(machineId: string): PanelShape {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey(machineId)) ?? "null");
    if (typeof stored !== "object" || stored === null) return NO_OPTIONAL_SECTIONS;
    const shape = stored as Record<string, unknown>;
    const tailscaleRows = typeof shape.tailscaleRows === "number" ? Math.max(0, Math.min(MAX_TAILSCALE_ROWS, Math.floor(shape.tailscaleRows))) : 0;
    return { gpu: shape.gpu === true, battery: shape.battery === true, tailscaleRows };
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
