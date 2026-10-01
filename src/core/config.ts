// bb-box's own settings. Each backend's settings live with its driver under
// src/backends/.

import type { PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { parseSizeChanges, type SizeChanges } from "./sizes.ts";

export interface GeneralConfig {
  /** Most boxes one thread may hold, or null for no limit. */
  readonly perThreadLimit: number | null;
  /** Enrol boxes whose kind can enrol as BB machines. */
  readonly enrol: boolean;
  /** Changes to the shipped box sizes, by kind (028). */
  readonly sizes: SizeChanges;
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
  "box-sizes": {
    type: "string",
    experimental_multiline: true,
    label: "Box sizes",
    description:
      "Changes to each kind's presets as JSON. Leave empty for bb-box's own: small, medium and large are 2, 4 and 8 cores with 4, 8 and 16 GiB " +
      "for linux and linux-docker, and twice that for the desktops; the default is small, and the largest custom size is twice large with " +
      'a 256 GiB disk. For example {"linux": {"default": "medium", "large": {"cores": 12, "memoryMiB": 24576}, "largest": {"diskGiB": 512}}}.',
  },
} satisfies Record<string, PluginSettingDescriptor>;

/** Always a config: a setting with a problem takes its default, and the problem is returned for the doctor. */
export interface GeneralResult {
  readonly config: GeneralConfig;
  readonly problems: readonly string[];
}

export function parseGeneral(values: Readonly<Record<string, unknown>>): GeneralResult {
  const problems: string[] = [];
  const raw = values["boxes-per-thread"];
  let limit = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : 0;
  if (!Number.isInteger(limit) || limit < 0) {
    problems.push("Use a whole number of boxes per thread, or 0 for no limit.");
    limit = 0;
  }
  const sizes = parseSizeChanges(values["box-sizes"]);
  problems.push(...sizes.problems);
  return {
    config: {
      perThreadLimit: limit > 0 ? limit : null,
      enrol: typeof values["enrol-boxes"] === "boolean" ? values["enrol-boxes"] : true,
      sizes: sizes.changes,
    },
    problems,
  };
}
