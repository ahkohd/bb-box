import type { BackendDriver } from "../types.ts";
import { HetznerBackend, type HetznerConfig } from "./backend.ts";
import { HETZNER_FIELDS, HETZNER_KINDS, parseHetznerPart } from "./config.ts";

export const hetznerDriver: BackendDriver<HetznerConfig> = {
  type: "hetzner",
  label: "Hetzner Cloud",
  description: "Linux boxes on x86 or Arm, with or without a desktop, on Hetzner Cloud hosts bb-box makes as boxes need them. Each box is a container on a Docker host, and a host is deleted once it is idle.",
  nature: "virtual",
  form: "Docker",
  kinds: HETZNER_KINDS,
  fields: HETZNER_FIELDS,
  offWhenEmpty: ["linux-image", "desktop-image", "wayland-desktop-image"],
  setup: {
    guide: "docs/guide/hetzner.md",
    scripts: [],
  },
  parse: parseHetznerPart,
  create: (config, context) => new HetznerBackend(config, context, {}),
};
