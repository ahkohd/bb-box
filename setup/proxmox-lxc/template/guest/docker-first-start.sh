#!/bin/bash
set -u
shopt -s nullglob
limit_ms=${BBBOX_DOCKER_START_LIMIT_MS:-2000}
ceiling_ms=${BBBOX_DOCKER_START_CEILING_MS:-30000}
cgroup_root=${BBBOX_CGROUP_ROOT:-/sys/fs/cgroup}
proc_root=${BBBOX_PROC_ROOT:-/proc}
systemd_run_dir=${BBBOX_SYSTEMD_RUN_DIR:-/run/systemd/system}
docker_units=(containerd.service docker.service)
sample_every_s=0.01
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

now_us() { echo "${EPOCHREALTIME/./}"; }

docker_unit_cgroups() {
  if [ -d "$systemd_run_dir" ]; then
    local unit
    for unit in "${docker_units[@]}"; do
      echo "$cgroup_root/$(systemctl show -p Slice --value "$unit")/$unit"
    done
  else
    echo "$cgroup_root"
  fi
}

docker_thread_stats() {
  local group pid
  if [ ! -d "$systemd_run_dir" ]; then
    printf '%s\n' "$proc_root"/[0-9]*/task/*/stat
    return
  fi
  for group in "$@"; do
    [ -r "$group/cgroup.procs" ] || continue
    while read -r pid; do printf '%s\n' "$proc_root/$pid/task/"*/stat; done <"$group/cgroup.procs"
  done
}

docker_waits_for_disk() {
  local stats=()
  mapfile -t stats < <(docker_thread_stats "$@")
  [ "${#stats[@]}" -gt 0 ] || return 1
  awk '$3 == "D" { found = 1; exit } END { exit !found }' "${stats[@]}" 2>/dev/null
}

time_docker_waited_for_disk_us() {
  local done_file=$1 waited=0 before after
  shift
  before=$(now_us)
  while [ ! -e "$done_file" ]; do
    if docker_waits_for_disk "$@"; then
      after=$(now_us)
      waited=$((waited + after - before))
      before=$after
    else
      before=$(now_us)
    fi
    sleep "$sample_every_s"
  done
  echo "$waited"
}

cpu_pressure_us() {
  local group total=0 stall
  for group in "$@"; do
    stall=$(awk '/^some / { for (i = 2; i <= NF; i++) if ($i ~ /^total=/) { sub(/^total=/, "", $i); print $i; exit } }' "$group/cpu.pressure" 2>/dev/null)
    total=$((total + ${stall:-0}))
  done
  echo "$total"
}

cpu_used_us() {
  local group total=0 used
  for group in "$@"; do
    used=$(awk '$1 == "usage_usec" { print $2 }' "$group/cpu.stat" 2>/dev/null)
    total=$((total + ${used:-0}))
  done
  echo "$total"
}

busy_and_stolen_ticks() {
  awk '$1 == "cpu" { print $2 + $3 + $4 + $7 + $8, ($9 == "" ? 0 : $9) }' "$proc_root/stat" 2>/dev/null || echo "0 0"
}

most_stolen_per_busy_milli=19000

stolen_from_work_us() {
  local work_us=$1 before=($2) after=($3)
  local busy=$((${after[0]} - ${before[0]})) stolen=$((${after[1]} - ${before[1]})) per_busy_milli
  [ "$stolen" -gt 0 ] || { echo 0; return; }
  per_busy_milli=$most_stolen_per_busy_milli
  [ "$busy" -le 0 ] || per_busy_milli=$((stolen * 1000 / busy))
  [ "$per_busy_milli" -le "$most_stolen_per_busy_milli" ] || per_busy_milli=$most_stolen_per_busy_milli
  echo $((work_us * per_busy_milli / 1000))
}

mapfile -t groups < <(docker_unit_cgroups)
docker --version >/dev/null 2>&1
cpu_stall_before=$(cpu_pressure_us "${groups[@]}")
ticks_before=$(busy_and_stolen_ticks)
time_docker_waited_for_disk_us "$work/answered" "${groups[@]}" >"$work/disk-wait" &
sampler=$!
started=$(now_us)
answered=yes
answer=$(timeout $((ceiling_ms / 1000 + 1)) docker version --format '{{.Server.Version}}' 2>&1) || answered=no
took_ms=$((($(now_us) - started) / 1000))
touch "$work/answered"
wait "$sampler"
if [ "$answered" = no ]; then
  echo "Docker did not answer through its socket: $answer"
  exit 1
fi

disk_us=$(cat "$work/disk-wait")
cpu_us=$(($(cpu_pressure_us "${groups[@]}") - cpu_stall_before))
steal_us=$(stolen_from_work_us "$(cpu_used_us "${groups[@]}")" "$ticks_before" "$(busy_and_stolen_ticks)")
waited_ms=$(((disk_us + cpu_us + steal_us) / 1000))
[ "$waited_ms" -le "$took_ms" ] || waited_ms=$took_ms
own_ms=$((took_ms - waited_ms))

echo "$own_ms ms of its own (limit $limit_ms), of $took_ms ms, $waited_ms ms of it waiting for the host's disk or CPU"
[ "$own_ms" -le "$limit_ms" ] && [ "$took_ms" -le "$ceiling_ms" ]
