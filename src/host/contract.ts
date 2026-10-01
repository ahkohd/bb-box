// What bb-box's server asks of its host entry on a BB machine (src/host/access.ts).

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const hostContract = defineRpcContract({
  /**
   * Keeps a process holding the variables BB gives this call, of which
   * `names` matter, for the env file's loader. Says whether it started a new
   * one, and its process ID.
   */
  access: {
    input: z.object({ names: z.array(z.string().max(256)).max(1_000) }).strict(),
    output: z.object({ started: z.boolean(), pid: z.number().int().nullable() }).strict(),
  },
});
