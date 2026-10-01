import type { BackendDriver } from "../types.ts";
import { TartBackend } from "./backend.ts";
import { TART_SETTINGS, parseTartSettings, type TartConfig } from "./config.ts";

export const tartDriver: BackendDriver<TartConfig> = {
  type: "tart",
  label: "Tart (macOS VMs)",
  nature: "virtual",
  settings: TART_SETTINGS,
  setup: {
    guide: "setup/tart/README.md",
    scripts: ["setup/tart/prepare-image.sh"],
  },
  parse: parseTartSettings,
  create: (config, context) => new TartBackend(config, context),
};
