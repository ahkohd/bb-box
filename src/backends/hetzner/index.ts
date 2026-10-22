import type { BackendDriver } from "../types.ts";
import { HetznerBackend, type HetznerConfig } from "./backend.ts";
import { HETZNER_FIELDS, HETZNER_KINDS, parseHetznerPart } from "./config.ts";

export const hetznerDriver: BackendDriver<HetznerConfig> = {
  type: "hetzner",
  label: "Hetzner Cloud",
  description: "Linux boxes, with or without a desktop, as containers on Docker hosts that bb-box makes in a Hetzner Cloud project as boxes need them, and deletes once they are idle.",
  nature: "virtual",
  form: "Docker",
  kinds: HETZNER_KINDS,
  fields: HETZNER_FIELDS,
  setup: {
    guide: "docs/guide/hetzner.md",
    scripts: [],
  },
  parse: parseHetznerPart,
  create: (config, context) => new HetznerBackend(config, context, {}),
};
