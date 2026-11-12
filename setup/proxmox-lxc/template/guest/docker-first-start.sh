#!/bin/bash
set -u
limit_ms=${BBBOX_DOCKER_START_LIMIT_MS:-2000}
deadline_ms=${BBBOX_DOCKER_START_DEADLINE_MS:-30000}
systemd_run_dir=${BBBOX_SYSTEMD_RUN_DIR:-/run/systemd/system}
docker_socket=${BBBOX_DOCKER_SOCKET:-/run/docker.sock}
docker_pid_file=${BBBOX_DOCKER_PID_FILE:-/var/run/docker.pid}
docker_units=(docker.service containerd.service)
kill_grace_ms=1000
poll_every_s=0.05
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

monotonic_ms() {
  local up _
  read -r up _ </proc/uptime
  echo $((10#${up/./} * 10))
}

deadline_at_ms=$(($(monotonic_ms) + deadline_ms))

before_deadline() { [ "$(monotonic_ms)" -lt "$deadline_at_ms" ]; }

as_seconds() { printf '%d.%03d' $(($1 / 1000)) $(($1 % 1000)); }

within_deadline() {
  local left_ms=$((deadline_at_ms - $(monotonic_ms) - kill_grace_ms)) group status
  [ "$left_ms" -gt 0 ] || return 124
  setsid timeout --kill-after="$(as_seconds "$kill_grace_ms")" "$(as_seconds "$left_ms")" "$@" 2>&1 &
  group=$!
  wait "$group" 2>/dev/null
  status=$?
  kill -KILL -- "-$group" 2>/dev/null
  return "$status"
}

time_first_start() {
  local began status
  began=$(monotonic_ms)
  within_deadline docker version --format '{{.Server.Version}}' >"$work/answer"
  status=$?
  took_ms=$(($(monotonic_ms) - began))
  read -r answer <<<"$(head -c 200 "$work/answer" | tr '\n' ' ')"
  case $status in
    0) outcome=answered ;;
    124 | 137) outcome=silent ;;
    *) outcome=refused ;;
  esac
}

docker_units_stopped() {
  local unit state
  for unit in "${docker_units[@]}"; do
    state=$(within_deadline systemctl show -p ActiveState --value "$unit") || return 1
    case $state in inactive | failed) ;; *) return 1 ;; esac
  done
}

stop_docker_under_systemd() {
  within_deadline sudo -n systemctl stop --no-block "${docker_units[@]}" >/dev/null 2>&1 || return 1
  until docker_units_stopped; do
    before_deadline || return 1
    sleep "$poll_every_s"
  done
}

docker_socket_listens() {
  awk -v path="$docker_socket" '$4 == "00010000" && $NF == path { found = 1 } END { exit !found }' /proc/net/unix
}

stop_docker_without_systemd() {
  local pid
  pid=$(cat "$docker_pid_file" 2>/dev/null) && [ -n "$pid" ] || return 1
  within_deadline sudo -n kill -TERM "$pid" >/dev/null 2>&1 || return 1
  while [ -d "/proc/$pid" ]; do
    before_deadline || return 1
    sleep "$poll_every_s"
  done
  until docker_socket_listens && [ -w "$docker_socket" ]; do
    before_deadline || return 1
    sleep "$poll_every_s"
  done
}

stop_docker_as_boot_leaves_it() {
  if [ -d "$systemd_run_dir" ]; then
    stop_docker_under_systemd
  else
    stop_docker_without_systemd
  fi
}

fail_without_answer() {
  local when=$1 said=${answer:+: $answer}
  case $outcome in
    silent) echo "no answer within $((deadline_ms / 1000)) s$when, so the check stopped the command$said" ;;
    refused) echo "refused the connection or has no socket$when$said" ;;
  esac
  exit 1
}

time_first_start
[ "$outcome" = answered ] || fail_without_answer ""
if [ "$took_ms" -le "$limit_ms" ]; then
  echo "answered in $took_ms ms (limit $limit_ms ms)"
  exit 0
fi

first_ms=$took_ms
if ! stop_docker_as_boot_leaves_it; then
  echo "answered in $first_ms ms (limit $limit_ms ms), then did not stop within $((deadline_ms / 1000)) s for a second first start"
  exit 1
fi

time_first_start
[ "$outcome" = answered ] || fail_without_answer " at a second first start, after $first_ms ms at the first"
if [ "$took_ms" -le "$limit_ms" ]; then
  echo "answered in $took_ms ms at a second first start; the first took $first_ms ms, slowed by a cold or busy host (limit $limit_ms ms)"
  exit 0
fi
echo "slow both times: $first_ms ms, then $took_ms ms at a second first start (limit $limit_ms ms)"
exit 1
