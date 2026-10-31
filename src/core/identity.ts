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

const IDENTITY_FILES_ROOT = "r=${BBBOX_IDENTITY_ROOT:-}";

const HELD_IDENTITY_FACTS = [
  IDENTITY_FILES_ROOT,
  `if [ -r "$r/etc/machine-id" ]; then printf 'machine_id=%s\\n' "$(sha256sum < "$r/etc/machine-id" | cut -d' ' -f1)"; fi`,
  `for f in "$r"/etc/ssh/ssh_host_*_key.pub; do [ -r "$f" ] && printf 'host_key=%s\\n' "$(cut -d' ' -f2 "$f" | sha256sum | cut -d' ' -f1)"; done`,
  ":",
];

const FORK_FACTS = [
  ...HELD_IDENTITY_FACTS.slice(0, -1),
  `for d in "$r"/home/*/.bb-machines/* "$r"/home/*/.bb-machines/.set-aside/* "$r"/root/.bb-machines/* "$r"/root/.bb-machines/.set-aside/*; do [ -d "$d" ] || continue; for f in host-id auth.json config.json; do [ -e "$d/$f" ] && printf 'bb_file=%s\\n' "\${d#"$r"}/$f"; done; done`,
  `for f in "$r"/home/*/.config/bb-box/env "$r"/root/.config/bb-box/env; do [ -e "$f" ] && printf 'access_file=%s\\n' "\${f#"$r"}"; done`,
  `if [ -r "$r/var/lib/tailscale/tailscaled.state" ] && grep -q -e '"_current-profile"' -e '"profile-' "$r/var/lib/tailscale/tailscaled.state"; then echo tailnet_node=yes; else echo tailnet_node=no; fi`,
  `if [ -r "$r/etc/bb-box/identity" ]; then sed -n 's/^mac /marker_mac=/p' "$r/etc/bb-box/identity"; fi`,
  ":",
];

function asRootShell(lines: readonly string[]): string {
  return `as_root sh -c ${quote(lines.join("\n"))}`;
}

export interface HeldIdentity {
  readonly machineId: string | null;
  readonly hostKeys: readonly string[];
}

export interface ForkSafety {
  readonly version: number | null;
  readonly identity: HeldIdentity | null;
}

function values(stdout: string, key: string): string[] {
  return stdout.split("\n").flatMap((line) => (line.startsWith(`${key}=`) ? [line.slice(key.length + 1).trim()] : [])).filter(Boolean);
}

function heldIdentityOf(stdout: string): HeldIdentity {
  return { machineId: values(stdout, "machine_id")[0] ?? null, hostKeys: [...new Set(values(stdout, "host_key"))].sort() };
}

export function forkSafetyScript(): string {
  return withTool([`as_root ${IDENTITY_TOOL} status || exit $?`, asRootShell(HELD_IDENTITY_FACTS)].join("\n"));
}

export async function readForkSafe(command: CommandTransport, signal?: AbortSignal): Promise<ForkSafety> {
  const ran = await command.run(forkSafetyScript(), { timeoutMs: FORK_SAFE_PROBE_MS, signal, maxOutputBytes: 8192 });
  const version = ran.exitCode === 0 ? forkSafeVersion(parseIdentityStatus(ran.stdout)) : null;
  return { version, identity: version === null ? null : heldIdentityOf(ran.stdout) };
}

export const FORK_CHECK_MS = 20_000;

export interface ForkSeen {
  readonly status: IdentityStatus | null;
  readonly exitCode: number | null;
  readonly markerMacs: readonly string[];
  readonly bbFiles: readonly string[];
  readonly accessFiles: readonly string[];
  readonly tailnetNode: boolean;
  readonly identity: HeldIdentity;
}

export interface ForkExpected {
  readonly forkMacs: readonly string[];
  readonly sourceMacs: readonly string[];
  readonly sourceBox: string;
  readonly sourceName: string;
  readonly held: HeldIdentity | null;
}

export type ForkVerdict = { readonly is: "ready" } | { readonly is: "wait"; readonly why: string } | { readonly is: "refused"; readonly why: string };

export function forkCheckScript(): string {
  return withTool([`as_root ${IDENTITY_TOOL} status || exit $?`, asRootShell(FORK_FACTS)].join("\n"));
}

export function parseForkSeen(stdout: string, exitCode: number | null): ForkSeen {
  return {
    status: exitCode === 0 ? parseIdentityStatus(stdout) : null,
    exitCode,
    markerMacs: values(stdout, "marker_mac").map((mac) => mac.toLowerCase()),
    bbFiles: values(stdout, "bb_file"),
    accessFiles: values(stdout, "access_file"),
    tailnetNode: values(stdout, "tailnet_node")[0] === "yes",
    identity: heldIdentityOf(stdout),
  };
}

export async function readForkSeen(command: CommandTransport, signal?: AbortSignal): Promise<ForkSeen> {
  const ran = await command.run(forkCheckScript(), { timeoutMs: FORK_CHECK_MS, signal, maxOutputBytes: 64 * 1024 });
  return parseForkSeen(ran.stdout, ran.timedOut ? null : ran.exitCode);
}

function listWords(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export function forkVerdict(seen: ForkSeen, expected: ForkExpected): ForkVerdict {
  const refused = (why: string): ForkVerdict => ({ is: "refused", why });
  const status = seen.status;
  if (!status) {
    if (seen.exitCode === IDENTITY_TOOL_MISSING) return refused("its disk has no identity reset");
    return refused(seen.exitCode === null ? "bb-box could not read its identity reset in time" : `reading its identity reset exited with ${seen.exitCode}`);
  }
  if (status.boot === "unknown") return { is: "wait", why: "its first boot could not tell yet whether it is a copy, so no reset has run" };
  if (status.pending) return { is: "wait", why: "its identity reset has begun and not finished" };
  if (status.boot !== "reset" && status.boot !== "kept") return refused(`its boot's identity check says "${status.boot}", not that it reset`);
  const forkMacs = new Set(expected.forkMacs.map((mac) => mac.toLowerCase()));
  const sourceMacs = new Set(expected.sourceMacs.map((mac) => mac.toLowerCase()));
  const shared = [...forkMacs].filter((mac) => sourceMacs.has(mac));
  if (shared.length) return refused(`it has ${expected.sourceName}'s MAC address ${listWords(shared)}, so its identity reset cannot tell it is a copy`);
  if (!seen.markerMacs.length || seen.markerMacs.some((mac) => !forkMacs.has(mac))) {
    return refused(`its identity marker names ${seen.markerMacs.length ? listWords(seen.markerMacs) : "no MAC address"}, not its own ${listWords([...forkMacs])}, so no reset of its own wrote it`);
  }
  if (status.box) return refused(`its identity marker names box ${status.box}${status.box === expected.sourceBox ? `, ${expected.sourceName}` : ""}, which a reset would have removed`);
  if (seen.bbFiles.length) return refused(`BB's machine credentials are still on its disk: ${listWords(seen.bbFiles)}`);
  if (seen.accessFiles.length) return refused(`the thread's access file is still on its disk: ${listWords(seen.accessFiles)}`);
  if (seen.tailnetNode) return refused("its Tailscale state still holds a tailnet node");
  if (expected.held?.machineId && seen.identity.machineId === expected.held.machineId) return refused(`its machine ID is ${expected.sourceName}'s`);
  const keys = new Set(expected.held?.hostKeys ?? []);
  if (seen.identity.hostKeys.some((key) => keys.has(key))) return refused(`it has ${expected.sourceName}'s SSH host keys`);
  return { is: "ready" };
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
