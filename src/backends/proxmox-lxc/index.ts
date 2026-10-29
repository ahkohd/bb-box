import type { BackendDriver } from "../types.ts";
import { ProxmoxLxcBackend } from "./backend.ts";
import { FLAVOUR_KINDS, earlierLxcSizes, LXC_FIELDS, LXC_FLAVOURS, LXC_SETTINGS, parseLxcPart, readEarlierLxc, type LxcConfig } from "./config.ts";

export const proxmoxLxcDriver: BackendDriver<LxcConfig> = {
  type: "proxmox-lxc",
  label: "Proxmox LXC",
  family: "Proxmox",
  description: "Linux boxes, with or without a desktop, as containers on a Proxmox VE host.",
  nature: "virtual",
  form: "LXC",
  kinds: LXC_FLAVOURS.flatMap((flavour) => FLAVOUR_KINDS[flavour]),
  fields: LXC_FIELDS,
  offWhenEmpty: ["linux-templates", "desktop-templates", "desktop-cpu-templates", "desktop-wayland-cpu-templates"],
  setup: {
    guide: "setup/proxmox-lxc/README.md",
    scripts: [
      "setup/proxmox-lxc/host/setup-host.sh",
      "setup/proxmox-lxc/host/setup-network.sh",
      "setup/proxmox-lxc/template/build.sh",
      "setup/proxmox-lxc/host/setup-token.sh",
    ],
  },
  parse: parseLxcPart,
  create: (config, context) => new ProxmoxLxcBackend(config, context),
  earlier: { settings: LXC_SETTINGS, read: readEarlierLxc, sizes: earlierLxcSizes },
};
