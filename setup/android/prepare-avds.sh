#!/bin/bash
set -Eeuo pipefail
trap 'echo "prepare-avds: line $LINENO failed: $BASH_COMMAND" >&2' ERR

usage() {
  cat >&2 <<'USAGE'
usage: prepare-avds.sh <pins.json> <devices.json>

Run as the box user in an Android image's build. Makes one AVD for each device
in pins.json with avdmanager, with a hardware keyboard, boots it cold, sets the
image's defaults in it, waits until Android has written the emulator's
AndroidWifi network to its Wi-Fi store, clears its clipboard and logcat, and
stops it, which saves its snapshot. Then boots it once from that snapshot to check that it
loads. Writes the image record's devices, with each runtime and the
snapshot's origin, to <devices.json>.
USAGE
  exit 2
}

[ $# -eq 2 ] || usage
pins=$1
out=$2
sdk=${ANDROID_HOME:-/opt/android-sdk}
export ANDROID_HOME=$sdk ANDROID_SDK_ROOT=$sdk
export PATH=$sdk/cmdline-tools/latest/bin:$sdk/platform-tools:$sdk/emulator:$PATH
serial=emulator-5554
package=$(jq -r .systemImage.package "$pins")
cores=$(jq -r .avd.cores "$pins")
ram=$(jq -r .avd.ramMiB "$pins")
emulator_version=$(emulator -version 2>/dev/null | sed -n 's/^Android emulator version \([0-9.]*\).*/\1/p' | head -1)
[ -n "$emulator_version" ] || { echo "prepare-avds: the emulator does not say its version" >&2; exit 1; }
cpu=$(sed -n 's/^model name[[:space:]]*: //p' /proc/cpuinfo | head -1)
log() { echo "$(date -u +%H:%M:%S) prepare-avds: $*"; }
trap 'bb-box-emulator stop >/dev/null 2>&1 || true' EXIT

shell() { adb -s "$serial" shell "$@" </dev/null; }

set_config() {
  local file=$1 key=$2 value=$3
  if grep -Eq "^${key//./\\.} *=" "$file"; then sed -Ei "s|^${key//./\\.} *=.*|$key=$value|" "$file"; else echo "$key=$value" >>"$file"; fi
}

apply_defaults() {
  shell settings put secure stylus_handwriting_enabled 0
  shell settings put secure spell_checker_enabled 0
  shell settings put system accelerometer_rotation 1
  shell settings put system screen_off_timeout 2147483647
  shell svc power stayon true
  shell locksettings set-disabled true >/dev/null
  shell input keyevent KEYCODE_WAKEUP
  shell wm dismiss-keyguard 2>/dev/null || true
}

wifi_written() {
  [ "$(shell su 0 grep -c AndroidWifi /data/misc/apexdata/com.android.wifi/WifiConfigStore.xml | tr -d '\r')" -gt 0 ] 2>/dev/null
}

wait_wifi_written() {
  local model=$1 began
  began=$(date +%s)
  until wifi_written; do
    [ $(($(date +%s) - began)) -lt 60 ] || { echo "prepare-avds: $model's AndroidWifi network was not in its Wi-Fi store 60 s after boot" >&2; return 1; }
    sleep 1
  done
  log "$model: AndroidWifi in its Wi-Fi store after $(($(date +%s) - began)) s"
}

check_defaults() {
  local failed=0 got
  for expect in "secure stylus_handwriting_enabled 0" "secure spell_checker_enabled 0" "system accelerometer_rotation 1" "system screen_off_timeout 2147483647"; do
    set -- $expect
    got=$(shell settings get "$1" "$2" | tr -d '\r')
    [ "$got" = "$3" ] || { echo "prepare-avds: $2 is $got, not $3" >&2; failed=1; }
  done
  shell dumpsys power | grep -q 'mStayOn=true' || { echo "prepare-avds: the device does not stay awake" >&2; failed=1; }
  return "$failed"
}

devices='[]'
count=$(jq '.devices | length' "$pins")
for i in $(seq 0 $((count - 1))); do
  model=$(jq -r ".devices[$i].model" "$pins")
  avd=$(jq -r ".devices[$i].avd" "$pins")
  profile=$(jq -r ".devices[$i].profile" "$pins")
  log "$model: making $avd from $profile"
  echo no | avdmanager --silent create avd --force -n "$avd" -k "$package" -d "$profile" >/dev/null
  config=$HOME/.android/avd/$avd.avd/config.ini
  set_config "$config" hw.keyboard yes
  set_config "$config" hw.cpu.ncore "$cores"
  set_config "$config" hw.ramSize "${ram}M"
  set_config "$config" hw.gpu.enabled yes
  set_config "$config" hw.gpu.mode swiftshader_indirect
  set_config "$config" showDeviceFrame no
  set_config "$config" fastboot.forceColdBoot no
  set_config "$config" fastboot.forceFastBoot yes

  booted=$(bb-box-emulator start "$avd" --cold)
  log "$model: $booted"
  for attempt in $(seq 1 10); do
    apply_defaults
    sleep 3
    if check_defaults 2>/dev/null; then break; fi
    [ "$attempt" -lt 10 ] || check_defaults
  done
  wait_wifi_written "$model"
  status=$(bb-box-emulator grpc setClipboard)
  [ "$status" = 0 ] || { echo "prepare-avds: setClipboard answered gRPC status ${status:-none}" >&2; exit 1; }
  shell logcat -c
  sleep 2
  started=$(date +%s%N)
  bb-box-emulator stop
  log "$model: stopped and saved its snapshot in $((($(date +%s%N) - started) / 1000000)) ms"
  made=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  [ -f "$HOME/.android/avd/$avd.avd/snapshots/default_boot/ram.bin" ] || { echo "prepare-avds: $avd has no snapshot after it stopped" >&2; exit 1; }

  booted=$(bb-box-emulator start "$avd" --no-save)
  log "$model: from its snapshot: $booted"
  case "$booted" in *snapshot=loaded*) ;; *) echo "prepare-avds: $avd did not boot from its snapshot" >&2; exit 1 ;; esac
  check_defaults
  wifi_written || { echo "prepare-avds: $avd's snapshot has no AndroidWifi in its Wi-Fi store" >&2; exit 1; }
  bb-box-emulator stop

  devices=$(jq -c --arg model "$model" --arg avd "$avd" --arg emulator "$emulator_version" --arg cpu "$cpu" --arg made "$made" \
    --argjson image "$(jq -c .systemImage "$pins")" \
    '. + [{model: $model, native: $avd,
      runtime: {platform: "android", api: $image.api, image: $image.image, revision: $image.revision, abi: $image.abi,
        emulator: $emulator, snapshot: {emulator: $emulator, cpu: $cpu, made: $made}}}]' <<<"$devices")
done

adb kill-server >/dev/null 2>&1 || true
echo "$devices" >"$out"
log "made $count AVDs"
