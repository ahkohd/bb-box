import { PRODUCT } from "../../brand.ts";
import type { DoctorCheck } from "../types.ts";

const MIB = 2 ** 20;

export const IDLE_CACHE_RECLAIM_DEFAULT = true;
export const IDLE_CACHE_MINUTES_DEFAULT = 15;
export const IDLE_CACHE_MINUTES_MIN = 1;
export const IDLE_CACHE_MINUTES_MAX = 1440;

export const IDLE_CACHE_SWEEP_EVERY_MS = 60_000;
export const IDLE_CACHE_MAX_BOXES_PER_SWEEP = 3;
export const IDLE_CACHE_SWEEP_BUDGET_MS = 20_000;
export const IDLE_CACHE_SSH_TIMEOUT_MS = 10_000;
export const IDLE_CACHE_SAMPLE_TIMEOUT_MS = 5_000;
export const IDLE_CPU_MAX = 0.05;
export const IDLE_CACHE_FLOOR_BYTES = 128 * MIB;
export const IDLE_CACHE_MIN_RECLAIM_BYTES = 64 * MIB;
export const IDLE_CACHE_STEP_BYTES = 256 * MIB;
export const IDLE_CACHE_MAX_STEPS = 32;
export const IDLE_CACHE_MIN_PROGRESS_BYTES = 16 * MIB;
export const IDLE_CACHE_PRESSURE_AVG_LIMIT = 1;
export const IDLE_CACHE_FULL_PRESSURE_AVG_LIMIT = 0.5;
export const IDLE_CACHE_PRESSURE_TOTAL_DELTA_US = 50_000;
export const IDLE_CACHE_FULL_PRESSURE_TOTAL_DELTA_US = 10_000;
export const IDLE_CACHE_REFAULT_STOP_DELTA = 1024;
export const IDLE_CACHE_SWEEPS_KEPT = 10;
export const IDLE_CACHE_SWEEPS_KEY = "idle-cache-sweeps";

export interface ObservedIdleGuest {
  readonly vmid: number;
  readonly name: string;
  readonly uptimeSeconds: number;
  readonly cpu: number | null;
  readonly cpus: number;
  readonly memoryUsedBytes: number;
}

export type IdleCacheAction = "sample" | "reclaim";

export interface IdleCacheCandidate {
  readonly action: IdleCacheAction;
  readonly vmid: number;
  readonly name: string;
  readonly cpus: number;
  readonly prevCpuUsageUsec: number | null;
  readonly maxCpuDeltaUsec: number | null;
}

export type ReclaimStatus =
  | "sampled"
  | "reclaimed"
  | "below_floor"
  | "pressure"
  | "busy_cpu"
  | "unsupported"
  | "no_swappiness0"
  | "sudo_failed";

export interface ReclaimCommandResult {
  readonly status: ReclaimStatus;
  readonly mode: string;
  readonly stop: string;
  readonly steps: number;
  readonly fileBeforeBytes: number;
  readonly fileAfterBytes: number;
  readonly inactiveFileBeforeBytes: number;
  readonly inactiveFileAfterBytes: number;
  readonly activeFileBeforeBytes: number;
  readonly activeFileAfterBytes: number;
  readonly anonBeforeBytes: number;
  readonly anonAfterBytes: number;
  readonly shmemBeforeBytes: number;
  readonly shmemAfterBytes: number;
  readonly swapBeforeBytes: number;
  readonly swapAfterBytes: number;
  readonly refaultsBefore: number;
  readonly refaultsAfter: number;
  readonly pressureSomeBefore: string;
  readonly pressureSomeAfter: string;
  readonly pressureFullBefore: string;
  readonly pressureFullAfter: string;
  readonly cpuUsageUsec: number | null;
}

export interface IdleCacheSweepSummary {
  readonly at: number;
  readonly checked: number;
  readonly reclaimedBoxes: number;
  readonly freedBytes: number;
  readonly skippedBusy: number;
  readonly skippedPressure: number;
  readonly skippedFloor: number;
  readonly skippedUnsupported: number;
  readonly sudoFailed: number;
  readonly unanswered: number;
}

export interface ReclaimScriptOptions {
  readonly floorBytes?: number;
  readonly minReclaimBytes?: number;
  readonly stepBytes?: number;
  readonly maxSteps?: number;
  readonly minProgressBytes?: number;
  readonly pressureAvgLimit?: number;
  readonly fullPressureAvgLimit?: number;
  readonly pressureTotalDeltaUs?: number;
  readonly fullPressureTotalDeltaUs?: number;
  readonly refaultStopDelta?: number;
  readonly prevCpuUsageUsec: number;
  readonly maxCpuDeltaUsec: number;
  readonly timeoutSeconds?: number;
}

interface GuestActivity {
  lastUptimeSeconds: number;
  cpuBaseline: { readonly at: number; readonly usec: number } | null;
  cooldownUntil: number;
}

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "sampled",
  "reclaimed",
  "below_floor",
  "pressure",
  "busy_cpu",
  "unsupported",
  "no_swappiness0",
  "sudo_failed",
]);

function wholeNumber(value: string | undefined, fallback = 0): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

export function formatIdleBytes(bytes: number): string {
  const positive = Math.max(0, bytes);
  const mib = positive / MIB;
  if (mib < 1024) return `${Math.round(mib)} MiB`;
  return `${(mib / 1024).toFixed(1).replace(/\.0$/, "")} GiB`;
}

export function sampleIdleCpuScript(timeoutSeconds = 4): string {
  const limit = Math.max(1, Math.trunc(timeoutSeconds));
  return String.raw`timeout ${limit} sh -s <<'SAMPLE'
set -u
cg=/sys/fs/cgroup
if [ ! -r "$cg/cpu.stat" ]; then
  echo "status=unsupported"
  exit 0
fi
cpu_usec=$(awk '$1 == "usage_usec" { print $2; found = 1; exit } END { if (!found) print -1 }' "$cg/cpu.stat")
if [ "$cpu_usec" -lt 0 ]; then
  echo "status=unsupported"
  exit 0
fi
printf 'status=sampled\ncpu_usage_usec=%s\n' "$cpu_usec"
SAMPLE`;
}

export function reclaimIdleCacheScript(options: ReclaimScriptOptions): string {
  const floor = Math.max(0, Math.trunc(options.floorBytes ?? IDLE_CACHE_FLOOR_BYTES));
  const minReclaim = Math.max(0, Math.trunc(options.minReclaimBytes ?? IDLE_CACHE_MIN_RECLAIM_BYTES));
  const step = Math.max(4096, Math.trunc(options.stepBytes ?? IDLE_CACHE_STEP_BYTES));
  const maxSteps = Math.max(1, Math.trunc(options.maxSteps ?? IDLE_CACHE_MAX_STEPS));
  const minProgress = Math.max(4096, Math.trunc(options.minProgressBytes ?? IDLE_CACHE_MIN_PROGRESS_BYTES));
  const pressureAvg = options.pressureAvgLimit ?? IDLE_CACHE_PRESSURE_AVG_LIMIT;
  const fullPressureAvg = options.fullPressureAvgLimit ?? IDLE_CACHE_FULL_PRESSURE_AVG_LIMIT;
  const pressureDeltaUs = Math.max(1, Math.trunc(options.pressureTotalDeltaUs ?? IDLE_CACHE_PRESSURE_TOTAL_DELTA_US));
  const fullPressureDeltaUs = Math.max(1, Math.trunc(options.fullPressureTotalDeltaUs ?? IDLE_CACHE_FULL_PRESSURE_TOTAL_DELTA_US));
  const refaultDelta = Math.max(1, Math.trunc(options.refaultStopDelta ?? IDLE_CACHE_REFAULT_STOP_DELTA));
  const prevCpuUsec = Math.trunc(options.prevCpuUsageUsec);
  const maxCpuDeltaUsec = Math.trunc(options.maxCpuDeltaUsec);
  const innerTimeout = Math.max(1, Math.trunc(options.timeoutSeconds ?? Math.floor(IDLE_CACHE_SSH_TIMEOUT_MS / 1000) - 2));

  return String.raw`sudo -n true 2>/dev/null || { echo "status=sudo_failed"; exit 0; }
sudo -n timeout ${innerTimeout} sh -s -- ${floor} ${minReclaim} ${step} ${maxSteps} ${minProgress} ${pressureAvg} ${fullPressureAvg} ${pressureDeltaUs} ${fullPressureDeltaUs} ${refaultDelta} ${prevCpuUsec} ${maxCpuDeltaUsec} <<'RECLAIM'
set -u
floor=$1
min_reclaim=$2
step_bytes=$3
max_steps=$4
min_progress=$5
pressure_limit=$6
full_pressure_limit=$7
pressure_delta_us=$8
full_pressure_delta_us=$9
shift 9
refault_delta=$1
prev_cpu_usec=$2
max_cpu_delta=$3

cg=/sys/fs/cgroup
if [ ! -f "$cg/memory.reclaim" ] || [ ! -w "$cg/memory.reclaim" ] || [ ! -r "$cg/memory.stat" ] || [ ! -r "$cg/cpu.stat" ]; then
  echo "status=unsupported"
  exit 0
fi

read_stat() {
  awk '
    $1 == "file" { file = $2 }
    $1 == "inactive_file" { inactive_file = $2 }
    $1 == "active_file" { active_file = $2 }
    $1 == "anon" { anon = $2 }
    $1 == "shmem" { shmem = $2 }
    $1 == "workingset_refault_file" { refaults = $2 }
    END { printf "%d %d %d %d %d %d\n", file+0, inactive_file+0, active_file+0, anon+0, shmem+0, refaults+0 }
  ' "$cg/memory.stat"
}

read_pressure() {
  if [ ! -r "$cg/memory.pressure" ]; then
    echo "0.00 0.00 0.00 0 0.00 0.00 0.00 0"
    return
  fi
  awk '
    function val(s,  a) { split(s, a, "="); return a[2] }
    $1 == "some" { s10 = val($2); s60 = val($3); s300 = val($4); st = val($5) }
    $1 == "full" { f10 = val($2); f60 = val($3); f300 = val($4); ft = val($5) }
    END { printf "%.2f %.2f %.2f %d %.2f %.2f %.2f %d\n", s10+0, s60+0, s300+0, st+0, f10+0, f60+0, f300+0, ft+0 }
  ' "$cg/memory.pressure"
}

read_swap() {
  cur=0
  [ -r "$cg/memory.swap.current" ] && read -r cur < "$cg/memory.swap.current" || true
  [ -n "$cur" ] || cur=0
  printf '%s\n' "$cur"
}

read_cpu() {
  awk '$1 == "usage_usec" { print $2; found = 1; exit } END { if (!found) print -1 }' "$cg/cpu.stat"
}

reclaimable_budget() {
  non_shmem=$(( $1 - $2 ))
  if [ "$non_shmem" -lt 0 ]; then non_shmem=0; fi
  above_floor=$(( non_shmem - floor ))
  if [ "$above_floor" -lt 0 ]; then above_floor=0; fi
  if [ "$3" -lt "$above_floor" ]; then
    echo "$3"
  else
    echo "$above_floor"
  fi
}

is_initial_pressure_high() {
  awk -v s10="$s10_b" -v s60="$s60_b" -v f10="$f10_b" -v f60="$f60_b" -v lim="$pressure_limit" -v flim="$full_pressure_limit" \
    'BEGIN { exit !((s10 + 0 >= lim + 0) || (s60 + 0 >= lim + 0) || (f10 + 0 >= flim + 0) || (f60 + 0 >= flim + 0)) }'
}

is_step_pressure_high() {
  awk -v s10="$s10_c" -v f10="$f10_c" -v st="$st_c" -v pst="$st_prev" -v ft="$ft_c" -v pft="$ft_prev" \
    -v lim="$pressure_limit" -v flim="$full_pressure_limit" -v dlim="$pressure_delta_us" -v fdlim="$full_pressure_delta_us" \
    'BEGIN { exit !((s10 + 0 >= lim + 0) || (f10 + 0 >= flim + 0) || ((st - pst) >= dlim) || ((ft - pft) >= fdlim)) }'
}

cpu_usec=$(read_cpu)
if [ "$cpu_usec" -lt 0 ]; then
  echo "status=unsupported"
  exit 0
fi

read -r file_b inactive_b active_b anon_b shmem_b refaults_b <<EOF
$(read_stat)
EOF
read -r s10_b s60_b s300_b st_b f10_b f60_b f300_b ft_b <<EOF
$(read_pressure)
EOF
swap_b=$(read_swap)

file_c=$file_b
inactive_c=$inactive_b
active_c=$active_b
anon_c=$anon_b
shmem_c=$shmem_b
swap_c=$swap_b
refaults_c=$refaults_b
s10_c=$s10_b
s60_c=$s60_b
s300_c=$s300_b
st_c=$st_b
f10_c=$f10_b
f60_c=$f60_b
f300_c=$f300_b
ft_c=$ft_b

emit() {
  printf 'status=%s\nmode=%s\nstop=%s\nsteps=%d\nfile_before=%d\nfile_after=%d\ninactive_file_before=%d\ninactive_file_after=%d\nactive_file_before=%d\nactive_file_after=%d\nanon_before=%d\nanon_after=%d\nshmem_before=%d\nshmem_after=%d\nswap_before=%d\nswap_after=%d\nrefaults_before=%d\nrefaults_after=%d\npressure_some_before=%s/%s/%s/%d\npressure_some_after=%s/%s/%s/%d\npressure_full_before=%s/%s/%s/%d\npressure_full_after=%s/%s/%s/%d\ncpu_usage_usec=%s\n' \
    "$1" "$2" "$3" "$4" "$file_b" "$file_c" "$inactive_b" "$inactive_c" "$active_b" "$active_c" \
    "$anon_b" "$anon_c" "$shmem_b" "$shmem_c" "$swap_b" "$swap_c" "$refaults_b" "$refaults_c" \
    "$s10_b" "$s60_b" "$s300_b" "$st_b" "$s10_c" "$s60_c" "$s300_c" "$st_c" \
    "$f10_b" "$f60_b" "$f300_b" "$ft_b" "$f10_c" "$f60_c" "$f300_c" "$ft_c" "$cpu_usec"
}

if [ "$prev_cpu_usec" -lt 0 ] || [ "$max_cpu_delta" -lt 0 ] || [ "$cpu_usec" -lt "$prev_cpu_usec" ]; then
  emit "sampled" "none" "baseline" 0
  exit 0
fi

cpu_delta=$(( cpu_usec - prev_cpu_usec ))
if [ "$cpu_delta" -gt "$max_cpu_delta" ]; then
  emit "busy_cpu" "none" "busy_cpu" 0
  exit 0
fi

if is_initial_pressure_high; then
  emit "pressure" "none" "pressure" 0
  exit 0
fi

initial_budget=$(reclaimable_budget "$file_b" "$shmem_b" "$inactive_b")
if [ "$initial_budget" -lt "$min_reclaim" ]; then
  emit "below_floor" "none" "floor" 0
  exit 0
fi

if ! printf '0 swappiness=0\n' | dd of="$cg/memory.reclaim" bs=64 status=none 2>/dev/null; then
  emit "no_swappiness0" "none" "no_swappiness0" 0
  exit 0
fi

steps=0
stop="floor"
file_prev=$file_b
shmem_prev=$shmem_b
active_prev=$active_b
refaults_prev=$refaults_b
st_prev=$st_b
ft_prev=$ft_b

while [ "$steps" -lt "$max_steps" ]; do
  remaining=$(reclaimable_budget "$file_c" "$shmem_c" "$inactive_c")
  if [ "$remaining" -lt "$min_progress" ]; then
    stop="floor"
    break
  fi
  if [ "$remaining" -lt "$step_bytes" ]; then
    step=$remaining
  else
    step=$step_bytes
  fi
  if printf '%s swappiness=0\n' "$step" | dd of="$cg/memory.reclaim" bs=64 status=none 2>/dev/null; then
    rc=0
  else
    rc=1
  fi
  steps=$(( steps + 1 ))
  read -r file_c inactive_c active_c anon_c shmem_c refaults_c <<EOF
$(read_stat)
EOF
  read -r s10_c s60_c s300_c st_c f10_c f60_c f300_c ft_c <<EOF
$(read_pressure)
EOF
  swap_c=$(read_swap)
  if [ "$swap_c" -gt "$swap_b" ]; then
    stop="swap_grew"
    break
  fi
  if is_step_pressure_high; then
    stop="pressure"
    break
  fi
  if [ "$active_c" -lt "$active_prev" ]; then
    stop="active_file"
    break
  fi
  if [ $(( refaults_c - refaults_prev )) -ge "$refault_delta" ]; then
    stop="refaults"
    break
  fi
  if [ "$rc" -ne 0 ]; then
    stop="eagain"
    break
  fi
  prev_non_shmem=$(( file_prev - shmem_prev ))
  cur_non_shmem=$(( file_c - shmem_c ))
  if [ $(( prev_non_shmem - cur_non_shmem )) -lt "$min_progress" ]; then
    stop="stalled"
    break
  fi
  file_prev=$file_c
  shmem_prev=$shmem_c
  active_prev=$active_c
  refaults_prev=$refaults_c
  st_prev=$st_c
  ft_prev=$ft_c
  if [ "$steps" -ge "$max_steps" ]; then
    stop="step_limit"
  fi
done

emit "reclaimed" "swappiness0" "$stop" "$steps"
RECLAIM`;
}

export function parseReclaimOutput(stdout: string): ReclaimCommandResult | null {
  const fields = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    fields.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
  }

  const status = fields.get("status");
  if (!status || !VALID_STATUSES.has(status)) return null;

  const cpuRaw = wholeNumber(fields.get("cpu_usage_usec"), -1);
  return {
    status: status as ReclaimStatus,
    mode: fields.get("mode") ?? "none",
    stop: fields.get("stop") ?? "",
    steps: wholeNumber(fields.get("steps"), 0),
    fileBeforeBytes: wholeNumber(fields.get("file_before"), 0),
    fileAfterBytes: wholeNumber(fields.get("file_after"), 0),
    inactiveFileBeforeBytes: wholeNumber(fields.get("inactive_file_before"), 0),
    inactiveFileAfterBytes: wholeNumber(fields.get("inactive_file_after"), 0),
    activeFileBeforeBytes: wholeNumber(fields.get("active_file_before"), 0),
    activeFileAfterBytes: wholeNumber(fields.get("active_file_after"), 0),
    anonBeforeBytes: wholeNumber(fields.get("anon_before"), 0),
    anonAfterBytes: wholeNumber(fields.get("anon_after"), 0),
    shmemBeforeBytes: wholeNumber(fields.get("shmem_before"), 0),
    shmemAfterBytes: wholeNumber(fields.get("shmem_after"), 0),
    swapBeforeBytes: wholeNumber(fields.get("swap_before"), 0),
    swapAfterBytes: wholeNumber(fields.get("swap_after"), 0),
    refaultsBefore: wholeNumber(fields.get("refaults_before"), 0),
    refaultsAfter: wholeNumber(fields.get("refaults_after"), 0),
    pressureSomeBefore: fields.get("pressure_some_before") ?? "",
    pressureSomeAfter: fields.get("pressure_some_after") ?? "",
    pressureFullBefore: fields.get("pressure_full_before") ?? "",
    pressureFullAfter: fields.get("pressure_full_after") ?? "",
    cpuUsageUsec: cpuRaw >= 0 ? cpuRaw : null,
  };
}

export function freedBytesOf(result: ReclaimCommandResult): number {
  if (result.status !== "reclaimed") return 0;
  const before = Math.max(0, result.fileBeforeBytes - result.shmemBeforeBytes);
  const after = Math.max(0, result.fileAfterBytes - result.shmemAfterBytes);
  return Math.max(0, before - after);
}

export function reclaimLogLine(vmid: number, name: string, result: ReclaimCommandResult): string {
  const freed = freedBytesOf(result);
  const before = Math.max(0, result.fileBeforeBytes - result.shmemBeforeBytes);
  const after = Math.max(0, result.fileAfterBytes - result.shmemAfterBytes);
  const steps = `${result.steps} ${result.steps === 1 ? "step" : "steps"}`;
  const stop = result.stop ? `, stopped at ${result.stop}` : "";
  return `Reclaimed ${formatIdleBytes(freed)} of idle page cache from CT ${vmid} (${name}): file cache ${formatIdleBytes(before)} to ${formatIdleBytes(after)} in ${steps}${stop}.`;
}

export class IdleCacheTracker {
  readonly #guests = new Map<number, GuestActivity>();

  forget(vmid: number): void {
    this.#guests.delete(vmid);
  }

  observe(
    guests: readonly ObservedIdleGuest[],
    now: number,
    idleMs: number,
  ): { readonly candidates: IdleCacheCandidate[]; readonly skippedBusy: number; readonly skippedFloor: number } {
    const present = new Set<number>();
    const pending: (IdleCacheCandidate & { readonly priorityAt: number })[] = [];
    let skippedBusy = 0;
    let skippedFloor = 0;

    for (const guest of guests) {
      present.add(guest.vmid);
      let state = this.#guests.get(guest.vmid);
      const restarted = state !== undefined && guest.uptimeSeconds < state.lastUptimeSeconds;
      if (!state || restarted) {
        state = { lastUptimeSeconds: guest.uptimeSeconds, cpuBaseline: null, cooldownUntil: 0 };
        this.#guests.set(guest.vmid, state);
      }

      const tooYoung = guest.uptimeSeconds * 1000 < idleMs;
      const busyCpu = guest.cpu === null || guest.cpu > IDLE_CPU_MAX;
      if (tooYoung || busyCpu) {
        state.cpuBaseline = null;
        state.lastUptimeSeconds = guest.uptimeSeconds;
        if (!tooYoung && busyCpu) skippedBusy++;
        continue;
      }

      state.lastUptimeSeconds = guest.uptimeSeconds;

      if (now < state.cooldownUntil) continue;

      if (guest.memoryUsedBytes > 0 && guest.memoryUsedBytes <= IDLE_CACHE_FLOOR_BYTES + IDLE_CACHE_MIN_RECLAIM_BYTES) {
        skippedFloor++;
        continue;
      }

      const baseline = state.cpuBaseline;
      if (!baseline) {
        pending.push({
          action: "sample",
          vmid: guest.vmid,
          name: guest.name,
          cpus: Math.max(1, guest.cpus),
          prevCpuUsageUsec: null,
          maxCpuDeltaUsec: null,
          priorityAt: 0,
        });
        continue;
      }

      const elapsedMs = now - baseline.at;
      if (elapsedMs < idleMs) continue;

      const elapsedSec = elapsedMs / 1000;
      const maxCpuDeltaUsec = Math.floor(elapsedSec * Math.max(1, guest.cpus) * IDLE_CPU_MAX * 1_000_000);
      pending.push({
        action: "reclaim",
        vmid: guest.vmid,
        name: guest.name,
        cpus: Math.max(1, guest.cpus),
        prevCpuUsageUsec: baseline.usec,
        maxCpuDeltaUsec,
        priorityAt: baseline.at,
      });
    }

    for (const vmid of [...this.#guests.keys()]) {
      if (!present.has(vmid)) this.#guests.delete(vmid);
    }

    pending.sort((a, b) => {
      if (a.action !== b.action) return a.action === "reclaim" ? -1 : 1;
      if (a.priorityAt !== b.priorityAt) return a.priorityAt - b.priorityAt;
      return a.vmid - b.vmid;
    });

    const candidates: IdleCacheCandidate[] = pending.map(({ priorityAt: _priorityAt, ...candidate }) => candidate);
    return { candidates, skippedBusy, skippedFloor };
  }

  recordUnanswered(vmid: number, now: number, idleMs: number): void {
    const state = this.#guests.get(vmid);
    if (!state) return;
    state.cooldownUntil = now + idleMs;
  }

  recordOutcome(vmid: number, now: number, idleMs: number, result: ReclaimCommandResult): void {
    const state = this.#guests.get(vmid);
    if (!state) return;

    if (result.status === "sampled") {
      if (result.cpuUsageUsec !== null) {
        state.cpuBaseline = { at: now, usec: result.cpuUsageUsec };
      }
      return;
    }

    if (result.status === "busy_cpu") {
      state.cpuBaseline = result.cpuUsageUsec !== null ? { at: now, usec: result.cpuUsageUsec } : null;
      return;
    }

    if (result.status === "pressure") {
      state.cpuBaseline = result.cpuUsageUsec !== null ? { at: now, usec: result.cpuUsageUsec } : null;
      state.cooldownUntil = now + idleMs;
      return;
    }

    if (result.cpuUsageUsec !== null) {
      state.cpuBaseline = { at: now, usec: result.cpuUsageUsec };
    }
    state.cooldownUntil = now + idleMs;
  }
}

export function appendIdleCacheSweep(
  history: readonly IdleCacheSweepSummary[],
  summary: IdleCacheSweepSummary,
): IdleCacheSweepSummary[] {
  return [...history, summary].slice(-IDLE_CACHE_SWEEPS_KEPT);
}

export function idleCacheDoctorCheck(input: {
  readonly enabled: boolean;
  readonly idleMinutes: number;
  readonly sweeps: readonly IdleCacheSweepSummary[];
  readonly now: number;
  readonly ago: (ms: number) => string;
}): DoctorCheck {
  const id = "proxmox.idle-cache" as const;
  const name = "Idle page cache";

  if (!input.enabled) {
    return {
      id,
      name,
      status: "ok",
      detail: `Off in ${PRODUCT}'s settings. Set idle-cache-reclaim to true to reclaim cold page cache from idle containers.`,
      fix: null,
    };
  }

  const threshold = `${input.idleMinutes} ${input.idleMinutes === 1 ? "minute" : "minutes"}`;
  if (!input.sweeps.length) {
    return {
      id,
      name,
      status: "ok",
      detail: `On (idle after ${threshold}, keeping ${formatIdleBytes(IDLE_CACHE_FLOOR_BYTES)} warm). No idle container has been checked yet.`,
      fix: null,
    };
  }

  const last = input.sweeps.at(-1)!;
  const parts: string[] = [`On (idle after ${threshold}, keeping ${formatIdleBytes(IDLE_CACHE_FLOOR_BYTES)} warm).`];

  const when = input.ago(Math.max(0, input.now - last.at));
  const checkedWords = `${last.checked} idle ${last.checked === 1 ? "container" : "containers"}`;
  const reclaimedWords = `${last.reclaimedBoxes} ${last.reclaimedBoxes === 1 ? "container" : "containers"}`;
  parts.push(`Last sweep ${when} checked ${checkedWords} and freed ${formatIdleBytes(last.freedBytes)} from ${reclaimedWords}.`);

  const totalChecked = input.sweeps.reduce((sum, sweep) => sum + sweep.checked, 0);
  const totalFreed = input.sweeps.reduce((sum, sweep) => sum + sweep.freedBytes, 0);
  const totalBoxes = input.sweeps.reduce((sum, sweep) => sum + sweep.reclaimedBoxes, 0);
  const totalUnsupported = input.sweeps.reduce((sum, sweep) => sum + sweep.skippedUnsupported, 0);
  const totalSudoFailed = input.sweeps.reduce((sum, sweep) => sum + (sweep.sudoFailed ?? 0), 0);
  const totalUnanswered = input.sweeps.reduce((sum, sweep) => sum + sweep.unanswered, 0);

  if (input.sweeps.length > 1) {
    parts.push(
      `Across the last ${input.sweeps.length} sweeps, ${formatIdleBytes(totalFreed)} freed across ${totalBoxes} ${totalBoxes === 1 ? "container" : "containers"}.`,
    );
  }

  const lastSudoFailed = last.sudoFailed ?? 0;
  if (lastSudoFailed > 0) {
    parts.push(`${lastSudoFailed} failed sudo without a password.`);
  }

  if (last.unanswered > 0) {
    parts.push(`${last.unanswered} did not answer.`);
  }

  if (last.skippedUnsupported > 0) {
    parts.push(`${last.skippedUnsupported} skipped because the kernel does not support cgroup memory.reclaim with swappiness=0.`);
  }

  const allFailed = totalChecked > 0 && totalUnsupported + totalSudoFailed + totalUnanswered === totalChecked;
  if (allFailed) {
    const fix =
      totalSudoFailed > 0
        ? `Grant passwordless sudo to the box user in the Proxmox LXC templates, or set idle-cache-reclaim to false in ${PRODUCT}'s settings.`
        : totalUnsupported > 0
          ? `Idle page cache reclaim needs Linux 6.11 or later with cgroup v2 memory.reclaim swappiness=0 (such as Proxmox VE 9). Set idle-cache-reclaim to false on older hosts.`
          : `Check that ${PRODUCT} can reach running containers over SSH, or set idle-cache-reclaim to false in ${PRODUCT}'s settings.`;
    return { id, name, status: "warn", detail: parts.join(" "), fix };
  }

  return { id, name, status: "ok", detail: parts.join(" "), fix: null };
}
