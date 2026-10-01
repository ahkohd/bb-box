import type { BackendDriver } from "../types.ts";
import { ProxmoxQemuBackend } from "./backend.ts";
import { QEMU_FIELDS, QEMU_KINDS, parseQemuPart, type QemuConfig } from "./config.ts";

export const proxmoxQemuDriver: BackendDriver<QemuConfig> = {
  type: "proxmox-qemu",
  label: "Proxmox QEMU",
  description: "Windows desktops as VMs on a Proxmox VE host.",
  nature: "virtual",
  form: "VM",
  kinds: QEMU_KINDS,
  fields: QEMU_FIELDS,
  setup: { guide: "setup/proxmox-qemu/README.md", scripts: ["setup/proxmox-qemu/build.sh"] },
  parse: parseQemuPart,
  create: (config, context) => new ProxmoxQemuBackend(config, context),
};
