import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quote } from "../transports/process.ts";
import { setupDir } from "./setup-dir.ts";
import { EXIT, fields, grantBlockOf, grantInput, parseGrant, parseGranted } from "./ssh-pool/protocol.ts";
import type { RunResult } from "../transports/types.ts";
import { BackendError, type BoxGrants, type GrantAnswer, type GrantBlock, type GrantRequest } from "./types.ts";

export type MacVmVerb = "vm-ready" | "vm-grant" | "vm-granted";

export interface MacVmCommand {
  run(script: string, options: { readonly stdin?: string; readonly timeoutMs: number; readonly signal?: AbortSignal; readonly maxOutputBytes: number }): Promise<RunResult>;
}

export interface MacGrantState {
  readonly blockedBy: GrantBlock | null;
  readonly macos: string | null;
  readonly signingIdentity: boolean;
}

const HELPER_TIMEOUT_MS = 60_000;
const HELPER_OUTPUT_BYTES = 64 * 1024;

export function macVmHelperCommand(): string {
  return `sudo -n /bin/sh -c ${quote(readFileSync(join(setupDir(), "ssh-pool", "machine-mac.sh"), "utf8"))} machine`;
}

export function parseGrantState(stdout: string): MacGrantState {
  const values = fields(stdout);
  return { blockedBy: grantBlockOf(values), macos: values.get("macos") || null, signingIdentity: values.get("signing") === "1" };
}

export class MacVmHelper {
  readonly #command: string;

  constructor(command: string = macVmHelperCommand()) {
    this.#command = command;
  }

  get hash(): string {
    return createHash("sha256").update(this.#command).digest("hex").slice(0, 16);
  }

  run(on: MacVmCommand, verb: MacVmVerb, input: string | null, signal?: AbortSignal): Promise<RunResult> {
    return on.run(`${this.#command} ${verb} "$(id -un)"`, {
      ...(input !== null ? { stdin: input } : {}),
      timeoutMs: HELPER_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
      maxOutputBytes: HELPER_OUTPUT_BYTES,
    });
  }

  async ready(on: MacVmCommand, signal?: AbortSignal): Promise<{ readonly state: MacGrantState | null; readonly failure: string | null }> {
    const result = await this.run(on, "vm-ready", null, signal).catch((error: unknown) => ({ exitCode: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
    if (result.exitCode !== 0) return { state: null, failure: result.stderr.trim() || `exit code ${result.exitCode}` };
    return { state: parseGrantState(result.stdout), failure: null };
  }

  async grant(on: MacVmCommand, machine: string, installId: string, box: string, request: GrantRequest, signal?: AbortSignal): Promise<GrantAnswer> {
    const result = await this.run(on, "vm-grant", grantInput(installId, box, request), signal);
    const said = result.stderr.trim() || `exit code ${result.exitCode}`;
    if (result.exitCode === EXIT.protected || result.exitCode === EXIT.refused) throw new BackendError("unsupported", said);
    if (result.exitCode !== 0) throw new Error(`${machine} did not grant: ${said}`);
    return parseGrant(result.stdout);
  }

  async grants(on: MacVmCommand, signal?: AbortSignal): Promise<{ readonly grants: BoxGrants; readonly state: MacGrantState } | null> {
    const result = await this.run(on, "vm-granted", null, signal).catch(() => null);
    if (result?.exitCode !== 0) return null;
    return { grants: parseGranted(result.stdout), state: parseGrantState(result.stdout) };
  }
}
