import type { BackendDriver } from "../types.ts";
import { ProxmoxLxcBackend } from "./backend.ts";
import { LXC_SETTINGS, parseLxcSettings, type LxcConfig } from "./config.ts";

export const proxmoxLxcDriver: BackendDriver<LxcConfig> = {
  type: "proxmox-lxc",
  label: "Proxmox LXC",
  nature: "virtual",
  settings: LXC_SETTINGS,
  setup: {
    guide: "setup/proxmox-lxc/README.md",
    scripts: [
      "setup/proxmox-lxc/host/setup-host.sh",
      "setup/proxmox-lxc/host/setup-network.sh",
      "setup/proxmox-lxc/template/build.sh",
      "setup/proxmox-lxc/host/setup-token.sh",
    ],
  },
  parse: parseLxcSettings,
  create: (config, context) => new ProxmoxLxcBackend(config, context),
};
