import type { BackendDriver } from "../types.ts";
import { TartBackend } from "./backend.ts";
import { TART_FIELDS, TART_HOST_FIELDS, TART_KINDS, TART_SETTINGS, parseTartPart, readEarlierTart, type TartConfig } from "./config.ts";

export const tartDriver: BackendDriver<TartConfig> = {
  type: "tart",
  label: "Tart (macOS VMs)",
  description: "macOS boxes as VMs on your Macs with Apple silicon.",
  nature: "virtual",
  form: "VM",
  kinds: TART_KINDS,
  fields: TART_FIELDS,
  hostFields: TART_HOST_FIELDS,
  setup: {
    guide: "setup/tart/README.md",
    scripts: ["setup/tart/prepare-image.sh"],
  },
  parse: parseTartPart,
  create: (config, context) => new TartBackend(config, context),
  earlier: { settings: TART_SETTINGS, read: readEarlierTart },
};
