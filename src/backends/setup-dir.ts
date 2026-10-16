// bb-box's setup/ folder, for backends that run its scripts.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * bb-box's setup/ folder: beside src/ in the repository; the plugin's
 * bundle, dist/server.js, has the plugin's files one up.
 */
export function setupDir(): string {
  const here = fileURLToPath(new URL("../../setup/", import.meta.url));
  return existsSync(join(here, "ssh-pool", "machine-mac.sh")) ? here : fileURLToPath(new URL("../setup/", import.meta.url));
}
