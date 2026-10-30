import type { IdentitySource } from "../backends/types.ts";
import type { CommandTransport } from "../transports/types.ts";
import { quote } from "../transports/process.ts";

export const IDENTITY_TOOL = "/usr/local/sbin/bb-box-identity";
export const IDENTITY_TOOL_MISSING = 64;
export const IDENTITY_VARIABLE = "BBBOX_IDENTITY";
export const MARKER_WRITE_MS = 20_000;
export const FORK_SAFE_PROBE_MS = 10_000;

const AS_ROOT = `as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi; }`;
const BOOT_CHECK_RAN = new Set(["kept", "unarmed", "reset"]);

export interface IdentityStatus {
  readonly version: number;
  readonly enabled: boolean;
  readonly boot: string;
  readonly marker: string;
  readonly armed: boolean;
  readonly pending: boolean;
  readonly box: string;
  readonly source: string;
}

function withTool(run: string): string {
  return [`[ -x ${IDENTITY_TOOL} ] || exit ${IDENTITY_TOOL_MISSING}`, AS_ROOT, run].join("\n");
}

export function writeMarkerScript(boxId: string, source: IdentitySource): string {
  return withTool(`as_root ${IDENTITY_TOOL} write --box ${quote(boxId)} --source ${source}`);
}

export function identityStatusScript(): string {
  return withTool(`as_root ${IDENTITY_TOOL} status`);
}

export function parseIdentityStatus(stdout: string): IdentityStatus | null {
  const fields = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const version = Number(fields.get("version"));
  if (!Number.isInteger(version) || version < 1) return null;
  return {
    version,
    enabled: fields.get("enabled") === "yes",
    boot: fields.get("boot") ?? "none",
    marker: fields.get("marker") ?? "missing",
    armed: fields.get("armed") === "yes",
    pending: fields.get("pending") === "yes",
    box: fields.get("box") ?? "",
    source: fields.get("source") ?? "",
  };
}

export function forkSafeVersion(status: IdentityStatus | null): number | null {
  if (!status) return null;
  return status.enabled && !status.pending && BOOT_CHECK_RAN.has(status.boot) && status.marker === "matches" && status.armed ? status.version : null;
}

export async function readForkSafe(command: CommandTransport, signal?: AbortSignal): Promise<number | null> {
  const ran = await command.run(identityStatusScript(), { timeoutMs: FORK_SAFE_PROBE_MS, signal, maxOutputBytes: 4096 });
  return ran.exitCode === 0 ? forkSafeVersion(parseIdentityStatus(ran.stdout)) : null;
}

export type MarkerWritten = { readonly written: true } | { readonly written: false; readonly why: string };

export async function writeIdentityMarker(command: CommandTransport, boxId: string, source: IdentitySource, signal?: AbortSignal): Promise<MarkerWritten> {
  const ran = await command.run(writeMarkerScript(boxId, source), { timeoutMs: MARKER_WRITE_MS, signal, maxOutputBytes: 4096 });
  if (ran.exitCode === 0) return { written: true };
  if (ran.exitCode === IDENTITY_TOOL_MISSING) return { written: false, why: "its image has no identity reset" };
  const said = (ran.stderr.trim() || ran.stdout.trim()).split("\n").at(-1) ?? "";
  return { written: false, why: ran.timedOut ? `writing it took over ${MARKER_WRITE_MS / 1000} s` : `writing it exited with ${ran.exitCode}${said ? `: ${said}` : ""}` };
}

export const IDENTITY_STATE = "/var/lib/bb-box";
export const IDENTITY_RESETS = `${IDENTITY_STATE}/identity-resets`;
export const IDENTITY_RESET_PENDING = `${IDENTITY_STATE}/identity-reset-pending`;
const RECORD_UNREADABLE = 3;
export const RESETS_READ_MS = 15_000;
const RESET_LINE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ) (.*); BB machines removed: (.*)$/;

export interface IdentityReset {
  readonly at: number;
  readonly why: string;
  readonly machines: readonly string[];
}

export function parseIdentityResets(text: string): IdentityReset[] {
  return text.split("\n").flatMap((line) => {
    const found = RESET_LINE.exec(line.trim());
    if (!found) return [];
    return [{ at: Date.parse(found[1]!), why: found[2]!, machines: found[3]!.split(/\s+/).filter((machine) => machine && machine !== "none") }];
  });
}

export function resetThatRemoved(resets: readonly IdentityReset[], machine: string): IdentityReset | null {
  return [...resets].reverse().find((reset) => reset.machines.includes(machine)) ?? null;
}

export function identityResetsScript(): string {
  return [
    `if [ -e ${IDENTITY_STATE} ] && ! { [ -d ${IDENTITY_STATE} ] && [ -r ${IDENTITY_STATE} ] && [ -x ${IDENTITY_STATE} ]; }; then exit ${RECORD_UNREADABLE}; fi`,
    `[ -e ${IDENTITY_RESETS} ] || [ -e ${IDENTITY_RESET_PENDING} ] || { echo absent; exit 0; }`,
    "echo present",
    `for record in ${IDENTITY_RESETS} ${IDENTITY_RESET_PENDING}; do`,
    '  [ -e "$record" ] || continue',
    `  { [ -f "$record" ] && [ -r "$record" ] && cat "$record"; } || exit ${RECORD_UNREADABLE}`,
    "done",
  ].join("\n");
}

export type ResetRecord = { readonly state: "absent" } | { readonly state: "read"; readonly resets: readonly IdentityReset[] };

export async function readIdentityResets(command: CommandTransport, signal?: AbortSignal): Promise<ResetRecord> {
  const ran = await command.run(identityResetsScript(), { timeoutMs: RESETS_READ_MS, signal, maxOutputBytes: 256 * 1024 });
  const [first, ...rest] = ran.stdout.split("\n");
  if (ran.exitCode === 0 && first === "absent") return { state: "absent" };
  if (ran.exitCode === 0 && first === "present") return { state: "read", resets: parseIdentityResets(rest.join("\n")) };
  throw new Error(`bb-box could not read ${IDENTITY_RESETS}: ${ran.timedOut ? "it took too long" : `the read exited with ${ran.exitCode}`}`);
}
