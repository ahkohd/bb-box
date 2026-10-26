#!/bin/bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: bb-box-clear-device-state <user>

Run as root before an Android image is captured, by customize-android.sh and
by finalize.sh. Stops the user's emulator and adb, then removes what each box
makes for itself: adb's keys, the emulator's console token, its discovery
files and locks, its metrics ID and update check, and bb-box-emulator's
state. The AVDs and their snapshots stay.
USAGE
  exit 2
}

[ $# -eq 1 ] || usage
user=$1
home=$(getent passwd "$user" | cut -d: -f6)
[ -n "$home" ] || { echo "bb-box-clear-device-state: no user $user" >&2; exit 1; }
uid=$(id -u "$user")
runuser -u "$user" -- env HOME="$home" /usr/local/bin/bb-box-emulator stop >/dev/null 2>&1 || true
runuser -u "$user" -- env HOME="$home" /usr/local/bin/adb kill-server >/dev/null 2>&1 </dev/null || true
rm -rf "$home/.android/avd/running" "$home/.android/adbkey" "$home/.android/adbkey.pub" "$home/.emulator_console_auth_token" \
  "$home/.android/emu-update-last-check.ini" "$home/.android/emulator-user.ini" "$home/.android/modem-nv-ram-"* \
  "$home/.android/cache" "$home/.android/.android" "$home/.android/userid" "$home/.android/adb.5037" \
  "$home/.android/emu-last-feature-flags.protobuf" "$home/.android/maps.key" "$home/.bb-box/device/emulator" \
  "/tmp/android-$user" "/run/user/$uid/avd"
[ ! -d "$home/.android/avd" ] || find "$home/.android/avd" -name '*.lock' -exec rm -rf {} +
[ ! -d "$home/.android" ] || chown -R "$user:$user" "$home/.android"
echo "bb-box-clear-device-state: cleared $user's device state"
