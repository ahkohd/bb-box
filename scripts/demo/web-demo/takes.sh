#!/bin/sh
set -e
usage="usage: takes.sh <steps.mjs> <takes dir> <reset command> [themes, dark light by default]"
steps="${1:?$usage}"
takes="${2:?$usage}"
reset="${3:?$usage}"
shift 3
themes="${*:-dark light}"
here="$(cd "$(dirname "$0")" && pwd)"
port="${WEB_DEMO_CDP_PORT:-9222}"
mkdir -p "$takes"

start_chrome() {
  WEB_DEMO_CDP_PORT="$port" sh "$here/chrome.sh" > "$takes/chrome.log" 2>&1 &
  chrome_pid=$!
  for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$port/json/version" > /dev/null && return; sleep 0.2; done
  echo "Chrome did not start; see $takes/chrome.log" >&2
  exit 1
}

stop_chrome() {
  kill "$chrome_pid" 2> /dev/null || true
  wait "$chrome_pid" 2> /dev/null || true
}

take() {
  start_chrome
  node "$here/record.mjs" "$steps" "$takes/$1" --theme "$2" --cdp "http://127.0.0.1:$port" || { stop_chrome; exit 1; }
  stop_chrome
  sh -c "$reset"
}

trap stop_chrome EXIT
first_theme="${themes%% *}"
take rehearsal "$first_theme"
for theme in $themes; do
  take "$theme" "$theme"
done
echo "takes in $takes: $themes"
