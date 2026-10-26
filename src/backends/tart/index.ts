import type { BackendDriver } from "../types.ts";
import { TartBackend } from "./backend.ts";
import { TART_FIELDS, TART_HOST_FIELDS, TART_KINDS, TART_SETTINGS, parseTartPart, readEarlierTart, type TartConfig } from "./config.ts";

export const tartDriver: BackendDriver<TartConfig> = {
  type: "tart",
  label: "Tart",
  description: "macOS boxes, and Linux and Windows boxes on arm64, as VMs on your Macs with Apple silicon.",
  nature: "virtual",
  form: "VM",
  kinds: TART_KINDS,
  fields: TART_FIELDS,
  hostFields: TART_HOST_FIELDS,
  setup: {
    guide: "setup/tart/README.md",
    scripts: ["setup/tart/prepare-image.sh", "setup/tart/prepare-linux-image.sh", "setup/tart/prepare-ios-image.sh"],
  },
  parse: parseTartPart,
  create: (config, context) => new TartBackend(config, context),
  earlier: { settings: TART_SETTINGS, read: readEarlierTart },
};
