import { DockerCli } from "../../src/backends/docker/cli.ts";
import type { DockerConfig } from "../../src/backends/docker/config.ts";
import type { ReplacedImageProbe } from "./replaced-image-probe.ts";

export function dockerReplacedImageProbe(config: DockerConfig, binary?: string): ReplacedImageProbe {
  const cli = new DockerCli(config.host, binary);
  return {
    currentId: async (current, _built, signal) => {
      await cli.prepare(signal);
      const inspected = await cli.run(["image", "inspect", "--format", "{{.Id}}", current.ref], { timeoutMs: 30_000, signal });
      return inspected.exitCode === 0 ? inspected.stdout.trim() || null : null;
    },
    exists: async (id, signal) => {
      await cli.prepare(signal);
      const inspected = await cli.run(["image", "inspect", "--format", "{{.Id}}", id], { timeoutMs: 30_000, signal });
      return inspected.exitCode === 0;
    },
  };
}
