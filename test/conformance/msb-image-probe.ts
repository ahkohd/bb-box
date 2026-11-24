import { MsbCli, type MsbCliOptions } from "../../src/backends/microsandbox/cli.ts";
import type { MsbConfig } from "../../src/backends/microsandbox/config.ts";
import type { ReplacedImageProbe } from "./replaced-image-probe.ts";

export function msbReplacedImageProbe(config: MsbConfig, options: MsbCliOptions = {}): ReplacedImageProbe {
  const cli = new MsbCli(config.host, config.machine, undefined, options);
  return {
    currentId: async (_current, built) => built.ref,
    exists: async (id, signal) => (await cli.imageList(signal)).some((entry) => entry.reference === id),
  };
}
