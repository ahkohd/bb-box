import { DockerCli } from "../../src/backends/docker/cli.ts";
import { boxVolumeName } from "../../src/backends/docker/box-container.ts";
import type { DockerConfig } from "../../src/backends/docker/config.ts";
import { RESTORE_COPY_NOTES } from "../../src/backends/docker/restore-copies.ts";
import { COPY_INTO } from "../../src/backends/docker/snapshots.ts";
import type { BackendStorage, Guest } from "../../src/backends/types.ts";
import type { RestoreCopyProbe } from "./restore-copy-probe.ts";

async function copiesInto(cli: DockerCli, volume: string, signal: AbortSignal) {
  return cli.list({ [COPY_INTO]: volume }, signal);
}

async function volumeExists(cli: DockerCli, volume: string, signal: AbortSignal): Promise<boolean> {
  const inspected = await cli.run(["volume", "inspect", volume], { timeoutMs: 30_000, signal });
  return inspected.exitCode === 0;
}

async function notesOf(storage: BackendStorage, volume: string): Promise<string[]> {
  return (await storage.list(RESTORE_COPY_NOTES)).filter((key) => key === `${RESTORE_COPY_NOTES}${volume}`);
}

export function dockerRestoreCopyProbe(config: DockerConfig): RestoreCopyProbe {
  const cli = new DockerCli(config.host);
  return {
    copying: async (claimed, signal) => (await copiesInto(cli, boxVolumeName(claimed.ref), signal)).some((copy) => copy.status === "running"),
    leftAfterRelease: async (claimed, storage, signal) => {
      const volume = boxVolumeName(claimed.ref);
      const copies = (await copiesInto(cli, volume, signal)).map((copy) => `the copy container ${copy.name}`);
      const volumes = (await volumeExists(cli, volume, signal)) ? [`the volume ${volume}`] : [];
      const notes = (await notesOf(storage, volume)).map((key) => `the note ${key}`);
      return [...copies, ...volumes, ...notes];
    },
  };
}
