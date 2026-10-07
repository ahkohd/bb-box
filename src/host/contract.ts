// What bb-box's server asks of its host entry on a BB machine (src/host/access.ts).

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const hostContract = defineRpcContract({
  /**
   * Keeps a process holding the variables BB gives this call, of which
   * `names` matter, for the env file's loader. Says whether it started a new
   * one, its process ID, and which of `names` this call did not bring.
   */
  access: {
    input: z.object({ names: z.array(z.string().max(256)).max(1_000) }).strict(),
    output: z.object({ started: z.boolean(), pid: z.number().int().nullable(), missing: z.array(z.string()).optional() }).strict(),
  },
  /**
   * Whether Docker is on the machine: finds it as the docker CLI would, and
   * connects to it and closes. It holds no lease and starts nothing, so the
   * settings list opens a relay only where there is Docker to read (042).
   * `refused` is set when Docker's socket refused BB's daemon: Docker is
   * there, but needs fixing.
   */
  docker: {
    input: z.object({}).strict(),
    output: z
      .object({
        endpoint: z.string(),
        found: z.boolean(),
        reason: z.string().nullable(),
        refused: z.boolean().optional(),
        /** The machine's OS: windows for a Windows PC, whose BB daemon runs in WSL; macos for a Mac; else linux. */
        platform: z.enum(["linux", "macos", "windows"]).optional(),
      })
      .strict(),
  },
  /**
   * Opens the Docker API relay (042): a WebSocket out to bb-box's route at
   * `path`, with `secret`, whose channels go to Docker on the machine. Says
   * where Docker is.
   */
  relay: {
    input: z.object({ secret: z.string().regex(/^[0-9a-f]{32}$/), path: z.string().regex(/^\/api\/v1\/plugins\/[^?#]+$/) }).strict(),
    output: z.object({ endpoint: z.string() }).strict(),
  },
  /**
   * Copies one file over a WebSocket out to bb-box's route at `path`, with
   * `secret` (#492): `send` streams `file` to bb-box, `receive` writes what
   * bb-box streams to it. `file` is absolute, and within `root` when given.
   * A received file replaces `file` only when it has `expect`'s size and
   * SHA-256. Answers once this side is done, with the bytes and their SHA-256.
   */
  file: {
    input: z
      .object({
        secret: z.string().regex(/^[0-9a-f]{32}$/),
        path: z.string().regex(/^\/api\/v1\/plugins\/[^?#]+$/),
        file: z.string().min(1).max(4096),
        root: z.string().min(1).max(4096).optional(),
        direction: z.enum(["send", "receive"]),
        expect: z.object({ bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict().optional(),
      })
      .strict(),
    output: z.object({ bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  },
});
