import type { DoctorCheck } from "../types.ts";

export const GPU_HELPER_PROTOCOL = 1;
export const GPU_HELPER_FRESH_MS = 3 * 60_000;
export const GPU_HELPER_CLOCK_AHEAD_MS = 60_000;

export interface ServedPools {
  readonly listed: readonly string[];
  readonly unlisted: number;
}

export interface GpuHelperState {
  readonly version: string | null;
  readonly protocol: number | null;
  readonly writes: "on" | "off" | null;
  readonly pveContainer: string | null;
  readonly tested: boolean | null;
  readonly serves: ServedPools | null;
}

const HELPER_HEAD = /^\s*helper bb-box-gpu(?:\s.*)?$/m;
const HELPER_LINE = /^\s*helper bb-box-gpu (\S+) protocol (\d+)(?: (.*?))?\s*$/m;
const PROTOCOL_1_HELPER_REST = /^writes (on|off) pve-container (\S+) (tested|untested)$/;
const SERVES_LINE = /^\s*serves (.+?)\s*$/m;
const MORE_POOLS = / and (\d+) more$/;

function servedPools(line: string | undefined): ServedPools | null {
  if (line === undefined) return null;
  if (line === "none") return { listed: [], unlisted: 0 };
  const more = MORE_POOLS.exec(line);
  const listed = more ? line.slice(0, more.index) : line;
  return { listed: listed.split(" ").filter(Boolean), unlisted: more ? Number(more[1]) : 0 };
}

export function parseGpuHelper(notes: string): GpuHelperState | null {
  if (!HELPER_HEAD.test(notes)) return null;
  const head = HELPER_LINE.exec(notes);
  if (!head) return { version: null, protocol: null, writes: null, pveContainer: null, tested: null, serves: null };
  const protocol = Number(head[2]);
  const rest = protocol === GPU_HELPER_PROTOCOL ? PROTOCOL_1_HELPER_REST.exec(head[3] ?? "") : null;
  return {
    version: head[1]!,
    protocol,
    writes: rest ? (rest[1] as "on" | "off") : null,
    pveContainer: rest ? rest[2]! : null,
    tested: rest ? rest[3] === "tested" : null,
    serves: protocol === GPU_HELPER_PROTOCOL ? servedPools(SERVES_LINE.exec(notes)?.[1]) : null,
  };
}

export const STOPS_ONLY_UNTESTED_FROM = [0, 4, 1];

export function atLeast(version: string | null, from: readonly number[]): boolean {
  if (!version) return false;
  const parts = version.split(".").map(Number);
  for (let at = 0; at < from.length; at++) {
    const part = parts[at] ?? 0;
    if (part !== from[at]) return part > from[at]!;
  }
  return true;
}

export interface GpuHelperSeen {
  readonly node: string;
  readonly pool: string;
  readonly vmid: number;
  readonly ageMs: number | null;
  readonly ago: (ms: number) => string;
}

export type GpuHelperVerdict = Pick<DoctorCheck, "status" | "detail" | "fix">;

function span(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

function poolsInWords(pools: readonly string[]): string {
  if (!pools.length) return "no pool";
  if (pools.length === 1) return `pool ${pools[0]}`;
  return `pools ${pools.slice(0, -1).join(", ")} and ${pools.at(-1)}`;
}

export function judgeGpuHelper(helper: GpuHelperState, seen: GpuHelperSeen): GpuHelperVerdict {
  const { node, pool, vmid, ageMs, ago } = seen;
  const named = `bb-box-gpu ${helper.version} on ${node}`;
  const setUpAgain = `Run host/setup-gpu.sh again, from this BB Box's setup guide, as root on ${node}.`;
  const checkClock = `Run systemctl status bb-box-gpu as root on ${node}, and check the host's clock.`;
  if (ageMs !== null && Number.isFinite(ageMs) && ageMs <= -GPU_HELPER_CLOCK_AHEAD_MS) {
    return { status: "fail", detail: `The GPU helper's report in VM ${vmid} is dated ${span(-ageMs)} ahead of this BB server's clock, so bb-box cannot tell whether the helper still runs.`, fix: checkClock };
  }
  if (ageMs === null || !Number.isFinite(ageMs) || ageMs >= GPU_HELPER_FRESH_MS) {
    return {
      status: "fail",
      detail: ageMs === null || !Number.isFinite(ageMs) ? `The GPU helper on ${node} has written no report in VM ${vmid}.` : `The GPU helper on ${node} last reported ${ago(ageMs)}, in VM ${vmid}.`,
      fix: checkClock,
    };
  }
  if (helper.protocol === null || helper.version === null) {
    return { status: "fail", detail: `VM ${vmid}'s report has a helper line this BB Box cannot read.`, fix: setUpAgain };
  }
  if (helper.protocol > GPU_HELPER_PROTOCOL) {
    return { status: "fail", detail: `The GPU helper on ${node}, bb-box-gpu ${helper.version}, speaks protocol ${helper.protocol}, newer than this BB Box's protocol ${GPU_HELPER_PROTOCOL}.`, fix: "Update BB Box." };
  }
  if (helper.protocol < GPU_HELPER_PROTOCOL) {
    return { status: "fail", detail: `The GPU helper on ${node}, bb-box-gpu ${helper.version}, speaks protocol ${helper.protocol}, older than this BB Box's protocol ${GPU_HELPER_PROTOCOL}.`, fix: setUpAgain };
  }
  if (helper.writes === null || helper.pveContainer === null || helper.tested === null) {
    return { status: "fail", detail: `VM ${vmid}'s report has a helper line this BB Box cannot read.`, fix: setUpAgain };
  }
  const served = helper.serves;
  if (!served?.listed.includes(pool)) {
    const serveIt = `Run host/setup-gpu.sh --pool ${pool} as root on ${node}.`;
    if (served && served.unlisted > 0) {
      return { status: "warn", detail: `${named} serves more pools than its report lists, so bb-box cannot tell whether it serves this install's pool ${pool}.`, fix: serveIt };
    }
    return { status: "fail", detail: `${named} serves ${poolsInWords(served?.listed ?? [])}, not this install's pool ${pool}.`, fix: serveIt };
  }
  if (!helper.tested && atLeast(helper.version, STOPS_ONLY_UNTESTED_FROM)) {
    return {
      status: "fail",
      detail: `${named} was not tested on pve-container ${helper.pveContainer}, so it changes no guest's lines, and only stops a GPU desktop or a guest with a GPU marker: those on ${node} are neither started nor released. Boxes with no GPU there are started, stopped and released through Proxmox's API meanwhile, as before 071.`,
      fix: `Install a bb-box-gpu release newer than ${helper.version} that was tested on pve-container ${helper.pveContainer}: run host/setup-gpu.sh from that BB Box release, as root on ${node}.`,
    };
  }
  if (!helper.tested) {
    return {
      status: "warn",
      detail: `${named} was not tested on pve-container ${helper.pveContainer}, so it changes no guest: it runs as with writes off, and bb-box moves no box to another card.`,
      fix: `Run host/setup-gpu.sh from a BB Box release tested on pve-container ${helper.pveContainer}, as root on ${node}.`,
    };
  }
  if (helper.writes === "off") {
    return {
      status: "warn",
      detail: `${named} runs with writes off, a dry run: it writes the GPU report, answers markers that need no write, and changes no guest. Until writes are on, bb-box moves no box to another card, and a stopped box starts on the card its lines name (071).`,
      fix: `Once bb box gpu mark has marked this install's guests and a day of dry run shows no write the helper would make, run host/setup-gpu.sh --writes on --check, then host/setup-gpu.sh --writes on, as root on ${node}.`,
    };
  }
  return { status: "ok", detail: `${named} reported ${ago(Math.max(ageMs, 0))}, with writes on, for pool ${pool}, on pve-container ${helper.pveContainer}, which it was tested on.`, fix: null };
}
