#!/usr/bin/env bash
set -euo pipefail

AVD="${1:-phone}"
MODE="${2:-cold}"
GPU="${GPU:-swiftshader_indirect}"
PORT="${PORT:-5554}"
GRPC="${GRPC:-8554}"
WINDOW="${WINDOW:-no}"
export ANDROID_HOME="$HOME/android-sdk"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

case "$MODE" in
  cold) SNAPSHOT_FLAGS=(-no-snapshot-load) ;;
  snapshot) SNAPSHOT_FLAGS=() ;;
  wipe) SNAPSHOT_FLAGS=(-wipe-data -no-snapshot-load) ;;
esac
WINDOW_FLAGS=()
[ "$WINDOW" = no ] && WINDOW_FLAGS=(-no-window)

adb start-server >/dev/null 2>&1
start=$(date +%s.%N)
nohup emulator -avd "$AVD" -port "$PORT" -grpc "$GRPC" -gpu "$GPU" -no-audio -no-boot-anim \
  "${WINDOW_FLAGS[@]}" "${SNAPSHOT_FLAGS[@]}" >"$HOME/emulator-$AVD.log" 2>&1 &
echo "$!" >"$HOME/emulator-$AVD.pid"

serial="emulator-$PORT"
until adb -s "$serial" get-state 2>/dev/null | grep -q device; do sleep 0.2; done
adb_ready=$(date +%s.%N)
until [ "$(adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; do sleep 0.2; done
booted=$(date +%s.%N)
echo "avd=$AVD mode=$MODE gpu=$GPU adb_device_s=$(echo "$adb_ready - $start" | bc) boot_completed_s=$(echo "$booted - $start" | bc)"
