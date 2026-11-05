// What bb-box's server asks of its host entry on a BB machine (src/host/access.ts).

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { REFRESH_MS, snapshotSchema } from "../monitor/snapshot.ts";
import { lightReadingSchema } from "../monitor/light.ts";

export const hostContract = defineRpcContract({
  monitor: {
    input: z.object({ refreshIntervalMs: z.number().int().min(REFRESH_MS.least).max(REFRESH_MS.most), force: z.boolean(), scope: z.enum(["machine", "user"]).optional() }).strict(),
    output: snapshotSchema,
  },
  "monitor.light": {
    input: z.object({ own: z.boolean(), machine: z.boolean() }).strict(),
    output: lightReadingSchema,
  },
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
    input: z.object({ dockerHost: z.string().max(300).optional() }).strict(),
    output: z
      .object({
        endpoint: z.string(),
        found: z.boolean(),
        reason: z.string().nullable(),
        refused: z.boolean().optional(),
        attached: z.boolean().optional(),
        /** The machine's OS: windows for a Windows PC, whose BB daemon runs in WSL; macos for a Mac; else linux. */
        platform: z.enum(["linux", "macos", "windows"]).optional(),
        /** What first-run setup needs to know of the machine: who BB's daemon runs as and how it restarts, KVM, and free disk. */
        setup: z
          .object({
            hostname: z.string(),
            user: z.string(),
            socketGroup: z.string().nullable(),
            inSocketGroup: z.boolean().nullable(),
            restart: z.string().nullable(),
            kvm: z.enum(["ok", "denied", "absent"]),
            freeGb: z.number().nullable(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  },
  /**
   * Opens the Docker API relay (042): a WebSocket out to bb-box's route at
   * `path`, with `secret`, whose channels go to Docker on the machine. Says
   * where Docker is.
   */
  relay: {
    input: z.object({ secret: z.string().regex(/^[0-9a-f]{32}$/), path: z.string().regex(/^\/api\/v1\/plugins\/[^?#]+$/), dockerHost: z.string().max(300).optional() }).strict(),
    output: z.object({ endpoint: z.string() }).strict(),
  },
  /**
   * Runs one of bb-box's msb scripts on the machine (053,
   * src/backends/microsandbox/release.ts): install the pinned msb, report on
   * the machine, give Docker's IDs of images there, import one, make, list
   * and remove boxes' Docker disks, move an image from a builder microVM
   * into msb, or put a build under an image's name. `dir` is bb-box's msb
   * folder, in the plugin's data folder.
   */
  microsandbox: {
    input: z.object({ script: z.enum(["install", "status", "images", "import", "undisk", "disks", "memory", "oom", "transfer", "retag", "snapshots", "keep"]), args: z.array(z.string().max(512)).max(4) }).strict(),
    output: z.object({ dir: z.string(), exitCode: z.number().int().nullable(), stdout: z.string(), stderr: z.string() }).strict(),
  },
  /**
   * Opens the msb relay (053): a WebSocket out to bb-box's route at `path`,
   * with `secret`, each of whose channels is one run of bb-box's msb on the
   * machine (src/relay/msb.ts). Says where bb-box's msb folder is.
   */
  msbRelay: {
    input: z.object({ secret: z.string().regex(/^[0-9a-f]{32}$/), path: z.string().regex(/^\/api\/v1\/plugins\/[^?#]+$/) }).strict(),
    output: z.object({ dir: z.string() }).strict(),
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
