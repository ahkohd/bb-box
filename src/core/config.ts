// The general settings bb-box declared in BB's settings before its
// configuration document (029). They are read once, when the settings move
// into the document. Each backend's are with its driver under src/backends/.

import type { PluginSettingDescriptor } from "@get-bb/plugin-sdk";

export type { GeneralConfig } from "./document.ts";

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
