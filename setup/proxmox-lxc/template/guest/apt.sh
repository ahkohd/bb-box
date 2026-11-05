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

apt_retry() {
  local try tries status wait log
  tries=${APT_RETRY_TRIES:-5}
  log=$(mktemp)
  try=1
  while [ "$try" -le "$tries" ]; do
    if "$@" >"$log" 2>&1; then
      cat "$log"
      rm -f "$log"
      return 0
    else
      status=$?
    fi
    if [ "$try" -eq "$tries" ]; then
      cat "$log" >&2
      rm -f "$log"
      return "$status"
    fi
    wait=$((try * ${APT_RETRY_SLEEP_SCALE:-30}))
    echo "apt: $* failed (try $try of $tries); retrying in ${wait} s" >&2
    sleep "$wait"
    try=$((try + 1))
  done
}

apt_update() {
  local -a opts=()
  apt_acquire_options opts
  apt_retry apt-get "${opts[@]}" update "$@"
}

apt_install() {
  local -a opts=()
  apt_acquire_options opts
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
