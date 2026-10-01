import type { BackendDriver } from "../types.ts";
import { SshPoolBackend } from "./backend.ts";
import { SSH_POOL_SETTINGS, parseSshPoolSettings, type SshPoolConfig } from "./config.ts";

export const sshPoolDriver: BackendDriver<SshPoolConfig> = {
  type: "ssh-pool",
  label: "SSH host pool",
  nature: "real",
  settings: SSH_POOL_SETTINGS,
  setup: {
    guide: "setup/ssh-pool/README.md",
    scripts: ["setup/ssh-pool/setup.sh", "setup/ssh-pool/machine.sh"],
  },
  parse: parseSshPoolSettings,
  create: (config, context) => new SshPoolBackend(config, context),
};
