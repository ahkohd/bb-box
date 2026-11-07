import type { DesktopDisplayCapability } from "./types.ts";
import type { CommandTransport, Display } from "../transports/types.ts";
import { ImageFile } from "./selkies.ts";

export const VOXL_PORT = 5981;
export const VOXL_LAUNCHER = "/usr/local/libexec/bb-box/voxl";
export type VoxlOffer = "off" | "offered" | "chosen";

export const VOXL_DISPLAY: DesktopDisplayCapability = { id: "voxl", protocol: "voxl", resizable: true, byChoice: true };
export const VOXL_START_TIMEOUT_MS = 15_000;

export class VoxlPresence extends ImageFile {
  constructor(launcher = VOXL_LAUNCHER) {
    super(launcher);
  }
}

function quoted(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

export async function startVoxl(command: CommandTransport, signal?: AbortSignal, launcher = VOXL_LAUNCHER): Promise<void> {
  const result = await command.run(`${quoted(launcher)} start`, { timeoutMs: VOXL_START_TIMEOUT_MS, signal, maxOutputBytes: 4096 });
  if (result.exitCode !== 0) throw new Error(`The box's voxl did not start: ${result.stderr.trim().split("\n").at(-1) || `exit code ${result.exitCode}`}`);
}

export function voxlDisplay(command: CommandTransport, opensFirst: boolean, launcher = VOXL_LAUNCHER): Display {
  return {
    id: VOXL_DISPLAY.id,
    label: "Desktop, through voxl",
    protocol: "voxl",
    resizable: true,
    opensFirst,
    open: async (signal) => {
      if (!command.route) throw new Error("bb-box cannot reach a port in this box.");
      await startVoxl(command, signal, launcher);
      return { route: await command.route(VOXL_PORT, signal), auth: { type: "none" } };
    },
  };
}
