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

export interface MacVmHelperTimeouts {
  readonly readyMs: number;
  readonly grantMs: number;
}

export type MacHelperAnswer<T> = { readonly state: T; readonly failure: null } | { readonly state: null; readonly failure: string };

export const MAC_HELPER_TIMEOUTS: MacVmHelperTimeouts = { readyMs: 10_000, grantMs: 60_000 };
const HELPER_OUTPUT_BYTES = 64 * 1024;

export function macVmHelperCommand(): string {
  return `sudo -n /bin/sh -c ${quote(readFileSync(join(setupDir(), "ssh-pool", "machine-mac.sh"), "utf8"))} machine`;
}

export function parseGrantState(stdout: string): MacGrantState {
  const values = fields(stdout);
  return { blockedBy: grantBlockOf(values), macos: values.get("macos") || null, signingIdentity: values.get("signing") === "1" };
}

function failureOf(result: Pick<RunResult, "exitCode" | "stderr" | "timedOut">, timeoutMs: number): string {
  if (result.timedOut) return `the Mac helper did not answer within ${Math.round(timeoutMs / 1000)} seconds`;
  return result.stderr.trim() || `exit code ${result.exitCode}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MacVmHelper {
  readonly #command: string;
  readonly #timeouts: MacVmHelperTimeouts;

  constructor(command: string = macVmHelperCommand(), timeouts: Partial<MacVmHelperTimeouts> = {}) {
    this.#command = command;
    this.#timeouts = { ...MAC_HELPER_TIMEOUTS, ...timeouts };
  }

  get hash(): string {
    return createHash("sha256").update(this.#command).digest("hex").slice(0, 16);
  }

  #run(on: MacVmCommand, verb: MacVmVerb, input: string | null, timeoutMs: number, signal?: AbortSignal): Promise<RunResult> {
    return on.run(`${this.#command} ${verb} "$(id -un)"`, {
      ...(input !== null ? { stdin: input } : {}),
      timeoutMs,
      ...(signal ? { signal } : {}),
      maxOutputBytes: HELPER_OUTPUT_BYTES,
    });
  }

  async #answer(on: MacVmCommand, verb: MacVmVerb, timeoutMs: number, signal?: AbortSignal): Promise<MacHelperAnswer<string>> {
    const result = await this.#run(on, verb, null, timeoutMs, signal).catch((error: unknown) => ({ exitCode: null, stdout: "", stderr: messageOf(error), timedOut: false }));
    if (result.exitCode !== 0 || result.timedOut) return { state: null, failure: failureOf(result, timeoutMs) };
    return { state: result.stdout, failure: null };
  }

  async ready(on: MacVmCommand, signal?: AbortSignal): Promise<MacHelperAnswer<MacGrantState>> {
    const answer = await this.#answer(on, "vm-ready", this.#timeouts.readyMs, signal);
    return answer.state === null ? answer : { state: parseGrantState(answer.state), failure: null };
  }

  async grant(on: MacVmCommand, machine: string, installId: string, box: string, request: GrantRequest, signal?: AbortSignal): Promise<GrantAnswer> {
    const result = await this.#run(on, "vm-grant", grantInput(installId, box, request), this.#timeouts.grantMs, signal);
    const said = failureOf(result, this.#timeouts.grantMs);
    if (result.exitCode === EXIT.protected || result.exitCode === EXIT.refused) throw new BackendError("unsupported", said);
    if (result.exitCode !== 0) throw new Error(`${machine} did not grant: ${said}`);
    return parseGrant(result.stdout);
  }

  async measure(on: MacVmCommand, signal?: AbortSignal): Promise<MacHelperAnswer<{ readonly grants: BoxGrants; readonly state: MacGrantState }>> {
    const answer = await this.#answer(on, "vm-granted", this.#timeouts.grantMs, signal);
    return answer.state === null ? answer : { state: { grants: parseGranted(answer.state), state: parseGrantState(answer.state) }, failure: null };
  }

  async grants(on: MacVmCommand, signal?: AbortSignal): Promise<{ readonly grants: BoxGrants; readonly state: MacGrantState } | null> {
    return (await this.measure(on, signal)).state;
  }
}
