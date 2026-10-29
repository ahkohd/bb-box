import type { BackendDriver } from "../types.ts";
import { ProxmoxQemuBackend } from "./backend.ts";
import { QEMU_FIELDS, QEMU_INHERITS, QEMU_KINDS, parseQemuPart, type QemuConfig } from "./config.ts";

export const proxmoxQemuDriver: BackendDriver<QemuConfig> = {
  type: "proxmox-qemu",
  label: "Proxmox QEMU",
  family: "Proxmox",
  description: "Windows desktops, Linux boxes and Android emulators, as VMs on a Proxmox VE host.",
  nature: "virtual",
  form: "VM",
  kinds: QEMU_KINDS,
  warmKinds: ["windows-desktop"],
  fields: QEMU_FIELDS,
  offWhenEmpty: ["windows-templates", "linux-templates", "linux-desktop-templates", "android-templates"],
  inherits: QEMU_INHERITS,
  setup: { guide: "setup/proxmox-qemu/README.md", scripts: ["setup/proxmox-qemu/build.sh"], needs: "A Proxmox host set up for Proxmox LXC; a Windows 11 ISO only for Windows desktops." },
  parse: parseQemuPart,
  create: (config, context) => new ProxmoxQemuBackend(config, context),
};
