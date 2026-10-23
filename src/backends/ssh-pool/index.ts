import type { BackendDriver } from "../types.ts";
import { SshPoolBackend } from "./backend.ts";
import { SSH_POOL_FIELDS, SSH_POOL_KINDS, SSH_POOL_SETTINGS, parseSshPoolPart, readEarlierSshPool, type SshPoolConfig } from "./config.ts";

export const sshPoolDriver: BackendDriver<SshPoolConfig> = {
  type: "ssh-pool",
  label: "SSH host pool",
  family: "SSH pool",
  description: "Your own Linux machines and Macs, reached over SSH and reset between boxes.",
  nature: "real",
  form: "Physical",
  kinds: SSH_POOL_KINDS,
  fields: SSH_POOL_FIELDS,
  setup: {
    guide: "setup/ssh-pool/README.md",
    scripts: ["setup/ssh-pool/setup.sh", "setup/ssh-pool/machine.sh", "setup/ssh-pool/setup-mac.sh", "setup/ssh-pool/machine-mac.sh"],
  },
  parse: parseSshPoolPart,
  create: (config, context) => new SshPoolBackend(config, context),
  earlier: { settings: SSH_POOL_SETTINGS, read: readEarlierSshPool },
};
