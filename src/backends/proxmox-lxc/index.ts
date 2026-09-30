import type { BackendDriver } from "../types.ts";
import { ProxmoxLxcBackend } from "./backend.ts";
import { LXC_SETTINGS, parseLxcSettings, type LxcConfig } from "./config.ts";

export const proxmoxLxcDriver: BackendDriver<LxcConfig> = {
  type: "proxmox-lxc",
  label: "Proxmox LXC",
  nature: "virtual",
  settings: LXC_SETTINGS,
  parse: parseLxcSettings,
  create: (config, context) => new ProxmoxLxcBackend(config, context),
};
