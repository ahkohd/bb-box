// bb-box's own settings. Each backend's settings live with its driver under
// src/backends/.

import type { PluginSettingDescriptor } from "@get-bb/plugin-sdk";

export interface GeneralConfig {
  /** Most boxes one thread may hold, or null for no limit. */
  readonly perThreadLimit: number | null;
  /** Enrol boxes whose kind can enrol as BB machines. */
  readonly enrol: boolean;
}

export const GENERAL_SETTINGS = {
  "boxes-per-thread": {
    type: "number",
    label: "Boxes per thread",
    description: "Most boxes one thread may hold. 0 means no limit; each backend still refuses a box it has no room for.",
    default: 0,
  },
  "enrol-boxes": {
    type: "boolean",
    label: "Enrol boxes as BB machines",
    description: "Once a box answers, add it to BB as a machine so threads and terminals can use it.",
    default: true,
  },
} satisfies Record<string, PluginSettingDescriptor>;

export type GeneralResult = { ok: true; config: GeneralConfig } | { ok: false; problems: string[] };

export function parseGeneral(values: Readonly<Record<string, unknown>>): GeneralResult {
  const raw = values["boxes-per-thread"];
  const limit = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : 0;
  if (!Number.isInteger(limit) || limit < 0) return { ok: false, problems: ["Use a whole number of boxes per thread, or 0 for no limit."] };
  return {
    ok: true,
    config: {
      perThreadLimit: limit > 0 ? limit : null,
      enrol: typeof values["enrol-boxes"] === "boolean" ? values["enrol-boxes"] : true,
    },
  };
}
