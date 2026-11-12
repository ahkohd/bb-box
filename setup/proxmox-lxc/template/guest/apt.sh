#!/bin/bash

apt_retry_delay_supported() {
  if [ -n "${APT_RETRY_DELAY_SUPPORTED+x}" ]; then
    [ "$APT_RETRY_DELAY_SUPPORTED" = 1 ]
    return
  fi
  local lib
  for lib in /usr/lib/*/libapt-pkg.so.* /usr/lib/libapt-pkg.so.*; do
    [ -f "$lib" ] || continue
    if grep -a -q -F 'Acquire::Retries::Delay' "$lib"; then
      return 0
    fi
  done
  return 1
}

apt_acquire_options() {
  local -n _opts=$1
  _opts+=(-o Acquire::Retries=5)
  if apt_retry_delay_supported; then
    _opts+=(-o Acquire::Retries::Delay=true)
  fi
}

apt_retry_conf() {
  printf 'Acquire::Retries "5";\n'
  if apt_retry_delay_supported; then
    printf 'Acquire::Retries::Delay "true";\n'
  fi
}

apt_uptime_s() {
  local up _
  read -r up _ </proc/uptime
  echo "${up%%.*}"
}

apt_archive_did_not_serve() {
  grep -E -q \
    -e '[[:space:]]{2}(5[0-9]{2}|429)[[:space:]]{2}' \
    -e 'Connection (refused|failed|timed out)' \
    -e 'Connection reset by peer' \
    -e 'Remote end closed connection' \
    -e 'Temporary failure resolving' \
    -e 'Hash Sum mismatch' \
    -e 'File has unexpected size' \
    -e 'Mirror sync in progress' \
    "$1"
}

apt_retry() {
  local try tries status wait log began budget elapsed left
  tries=${APT_RETRY_TRIES:-5}
  budget=${APT_RETRY_BUDGET_S:-600}
  log=$(mktemp)
  began=$(apt_uptime_s)
  try=1
  while :; do
    left=$((budget - ($(apt_uptime_s) - began)))
    if [ "$left" -gt 0 ] && timeout --kill-after=10 "$left" "$@" >"$log" 2>&1; then
      cat "$log"
      rm -f "$log"
      return 0
    else
      status=$?
    fi
    elapsed=$(($(apt_uptime_s) - began))
    wait=$((try * ${APT_RETRY_SLEEP_SCALE:-30}))
    if [ "$status" -eq 124 ] || [ "$status" -eq 137 ] || [ "$left" -le 0 ]; then
      apt_give_up "$log" "apt: $* was stopped after $elapsed s, as its tries may take at most $budget s. The package archive did not serve it for that long: check the errors above, then build again."
      return 1
    fi
    if ! apt_archive_did_not_serve "$log"; then
      apt_give_up "$log" "apt: $* failed for a reason other than the package archive, so it was not tried again: see apt's message above."
      return "$status"
    fi
    if [ "$try" -ge "$tries" ] || [ $((elapsed + wait)) -ge "$budget" ]; then
      apt_give_up "$log" "apt: $* failed $try times over $elapsed s, with at most $budget s for its tries. The package archive did not serve it for that long: check the errors above, then build again."
      return "$status"
    fi
    echo "apt: $* failed (try $try of $tries), as the package archive did not serve it; retrying in ${wait} s" >&2
    sleep "$wait"
    try=$((try + 1))
  done
}

apt_give_up() {
  cat "$1" >&2
  rm -f "$1"
  echo "$2" >&2
}

apt_update() {
  local -a opts=()
  apt_acquire_options opts
  apt_retry apt-get "${opts[@]}" update "$@"
}

apt_install() {
  local -a opts=()
  apt_acquire_options opts
  apt_retry apt-get "${opts[@]}" install --download-only "$@" || return
  apt-get "${opts[@]}" install "$@"
}

if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

set -euo pipefail
if [ $# -lt 1 ]; then
  echo "usage: apt.sh update|install [apt-get arguments]" >&2
  exit 2
fi
sub=$1
shift
case $sub in
  update) apt_update "$@" ;;
  install) apt_install "$@" ;;
  *)
    echo "usage: apt.sh update|install [apt-get arguments]" >&2
    exit 2
    ;;
esac
