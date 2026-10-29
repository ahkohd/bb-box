import type { BackendDriver } from "../types.ts";
import { MsbBackend } from "./backend.ts";
import { MSB_FIELDS, MSB_KINDS, parseMsbPart, type MsbConfig } from "./config.ts";

export const microsandboxDriver: BackendDriver<MsbConfig> = {
  type: "microsandbox",
  label: "microsandbox",
  description: "Linux boxes, with or without a desktop, as microVMs that start in under a second, on a Linux host with KVM or a Mac. bb-box installs its own msb there.",
  nature: "virtual",
  form: "microVM",
  kinds: MSB_KINDS,
  fields: MSB_FIELDS,
  offWhenEmpty: ["linux-image", "desktop-image", "linux-arm64-image", "desktop-arm64-image"],
  setup: {
    guide: "setup/microsandbox/README.md",
    scripts: [],
  },
  parse: parseMsbPart,
  // One per host: a BB machine's (053), ssh://, or BB's server.
  several: (fields) => (typeof fields.host === "string" ? fields.host.trim() : ""),
  create: (config, context) => new MsbBackend(config, context),
};
