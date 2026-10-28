#!/bin/sh
set -eu

here=${1:?usage: build-ios.sh <the folder of build-ios.sh>}
: "${IDB_VERSION:?}" "${IDB_URL:?}" "${IDB_SHA256:?}"
die() { echo "build-ios: $*" >&2; exit 1; }
step() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
seconds_since() { python3 -c "import sys, time; print(f'{time.time() - float(sys.argv[1]):.1f}')" "$1"; }
now() { python3 -c 'import time; print(f"{time.time():.3f}")'; }

share=/usr/local/share/bb-box
sudo -n true 2>/dev/null || die "$(id -un) needs passwordless sudo while the image is built"
xcrun simctl help >/dev/null 2>&1 || die "this macOS image has no Xcode with the iOS Simulator"

install_idb_companion() {
  work=$(mktemp -d)
  curl -fsSL --retry 3 -o "$work/idb.tgz" "$IDB_URL"
  echo "$IDB_SHA256  $work/idb.tgz" | shasum -a 256 -c --quiet - || die "idb_companion's archive does not match IDB_SHA256"
  target=/usr/local/lib/idb_companion-$IDB_VERSION
  sudo rm -rf "$target"
  sudo mkdir -p "$target" /usr/local/bin "$share/notices"
  sudo tar -xzf "$work/idb.tgz" -C "$target"
  sudo chown -R root:wheel "$target"
  sudo ln -sfn "$target/idb_companion" /usr/local/bin/idb_companion
  sudo install -m 0644 "$here/idb-companion-LICENSE" "$share/notices/idb_companion-$IDB_VERSION-LICENSE"
  rm -rf "$work"
  /usr/local/bin/idb_companion --version >/dev/null 2>&1 || die "idb_companion $IDB_VERSION does not run"
}

newest_ios_runtime() {
  xcrun simctl list runtimes -j | python3 -c '
import json, sys
ios = [r for r in json.load(sys.stdin)["runtimes"] if r.get("platform") == "iOS" and r.get("isAvailable")]
if ios:
    r = ios[-1]
    print(r["identifier"], r["version"], r["buildversion"])
'
}

device_hub_off() {
  pkill -9 -x DeviceHub 2>/dev/null || :
  defaults delete com.apple.dt.Devices >/dev/null 2>&1 || :
  rm -rf "$HOME/Library/Containers/com.apple.dt.Devices" "$HOME/Library/Saved Application State/com.apple.dt.Devices.savedState" \
    "$HOME/Library/Caches/com.apple.dt.Devices" "$HOME/Library/HTTPStorages/com.apple.dt.Devices"
}

user_tcc_database() {
  pid=$(pgrep -u "$(id -u)" -x tccd | head -n 1)
  [ -n "$pid" ] || return 1
  sudo lsof -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p' | grep '/com\.apple\.TCC/TCC\.db$' | head -n 1
}

microphone_answered_for() {
  bundle_id=$1 app=$2
  db=$(user_tcc_database) || { echo "build-ios: the user's TCC database is not open, so $bundle_id may ask for the microphone" >&2; return 0; }
  [ -n "$db" ] || return 0
  requirement=$(codesign -d -r- "$app" 2>&1 | sed -n 's/^designated => //p' | head -n 1)
  [ -n "$requirement" ] || die "no code requirement for $app"
  blob=$(printf '%s' "$requirement" | csreq -r- -b /dev/stdout | xxd -p | tr -d '\n')
  stamp=$(date +%s)
  sudo sqlite3 "$db" "DELETE FROM access WHERE service = 'kTCCServiceMicrophone' AND client = '$bundle_id';
    INSERT INTO access (service, client, client_type, auth_value, auth_reason, auth_version, csreq, policy_id, indirect_object_identifier_type, indirect_object_identifier, indirect_object_code_identity, flags, last_modified, pid, pid_version, boot_uuid, last_reminded)
    VALUES ('kTCCServiceMicrophone', '$bundle_id', 0, 2, 4, 1, X'$blob', NULL, 0, 'UNUSED', NULL, 0, $stamp, NULL, NULL, 'UNUSED', $stamp);"
}

simulator_microphone_answered() {
  developer=$(xcode-select -p)
  trampoline=/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/XPCServices/SimulatorTrampoline.xpc
  hub="$developer/../Applications/DeviceHub.app"
  [ -d "$trampoline" ] && microphone_answered_for com.apple.CoreSimulator.SimulatorTrampoline "$trampoline"
  [ -d "$hub" ] && microphone_answered_for com.apple.dt.Devices "$hub"
}

xcode_components_sheet_answered() {
  for sdk in iphoneos appletvos watchos xros macosx; do
    build=$(xcodebuild -version -sdk "$sdk" ProductBuildVersion 2>/dev/null) || continue
    defaults write com.apple.dt.Xcode "IDEPlatformsFirstLaunchPresentedSDKVersions-$sdk" -array "$build"
    [ "$sdk" = macosx ] || defaults write com.apple.dt.Xcode "IDEPlatformsFirstLaunchSelected-$sdk" -bool NO
  done
}

booted() { xcrun simctl list devices | grep -F "($1)" | grep -q '(Booted)'; }

boot_and_wait() {
  udid=$1
  booted "$udid" || xcrun simctl boot "$udid"
  xcrun simctl bootstatus "$udid" -b >/dev/null
}

restart_device() {
  xcrun simctl shutdown "$1"
  boot_and_wait "$1"
}

spawn() { udid=$1; shift; xcrun simctl spawn "$udid" "$@"; }

keyboard_defaults() {
  udid=$1
  spawn "$udid" defaults write com.apple.keyboard.preferences KeyboardAutocorrection -bool NO
  spawn "$udid" defaults write com.apple.keyboard.preferences KeyboardPeriodShortcut -bool NO
  spawn "$udid" defaults write com.apple.keyboard.preferences SmartTyping -bool NO
  spawn "$udid" defaults write com.apple.keyboard.predictive KeyboardPrediction -bool NO
  spawn "$udid" defaults write com.apple.keyboard.predictive KeyboardInlineCompletion -bool NO
  spawn "$udid" defaults write com.apple.keyboard.ContinuousPath KeyboardContinuousPathEnabled -bool NO
  spawn "$udid" defaults write com.apple.Preferences DidShowContinuousPathIntroduction -bool YES
}

apply_slimming() {
  udid=$1 list=$2
  while read -r label; do
    [ -n "$label" ] || continue
    tries=0
    until spawn "$udid" launchctl disable "system/$label" 2>/dev/null; do
      tries=$((tries + 1))
      [ "$tries" -lt 5 ] || die "could not disable $label in $udid"
      sleep 2
    done
  done <"$list"
}

slimmed_count() {
  udid=$1 list=$2
  spawn "$udid" launchctl print-disabled system | python3 -c '
import re, sys
listed = {line.strip() for line in open(sys.argv[1]) if line.strip()}
disabled = {m.group(1) for m in re.finditer(r"\"([^\"]+)\" => (?:disabled|true)", sys.stdin.read())}
print(len(listed & disabled))
' "$list"
}

pasteboard_cleared() { printf '' | xcrun simctl pbcopy "$1"; }

step "installing idb_companion $IDB_VERSION"
install_idb_companion

h264="$here/../android/build-h264.sh"
[ -f "$h264" ] || die "found no $h264: copy setup/android beside setup/tart"
if [ "${H264_WITH_X264:-no}" = yes ]; then
  step "building bb-box-h264, with x264 from its pinned source, for iOS video where the Mac has no hardware encoder"
  sudo -n bash "$h264" /usr/local --with-x264 >&2 || die "bb-box-h264 did not build"
else
  step "building bb-box-h264, with Cisco's OpenH264, for iOS video where the Mac has no hardware encoder"
  sudo -n bash "$h264" /usr/local >&2 || die "bb-box-h264 did not build"
fi
software_encoder=$(/usr/local/bin/bb-box-h264 --version 2>&1 | head -n 1)
hardware_encoder=unknown
if command -v ffmpeg >/dev/null 2>&1; then
  if ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=1206x2622:rate=60 -frames:v 12 -c:v h264_videotoolbox -allow_sw 0 -f null - </dev/null >/dev/null 2>&1; then hardware_encoder=yes; else hardware_encoder=no; fi
fi
step "this VM's H.264 encoders: hardware $hardware_encoder, software $software_encoder"
device_hub_off
simulator_microphone_answered
xcode_components_sheet_answered

set -- $(newest_ios_runtime)
[ $# -eq 3 ] || die "Xcode has no iOS Simulator runtime"
runtime=$1 os=$2 build=$3
list="$here/slim/ios-$os-$build.txt"
[ -s "$list" ] || die "there is no slimming list for iOS $os ($build): make one from a stock device of this runtime, as docs/research/ios-simulator-slimming.md says, as setup/tart/ios/slim/ios-$os-$build.txt"
labels=$(grep -c . "$list")
list_name=$(basename "$list" .txt)
list_sha256=$(shasum -a 256 "$list" | cut -d' ' -f1)
xcode=$(xcodebuild -version | sed -n 's/^Xcode //p' | head -n 1)

step "removing the simulator devices Xcode made"
xcrun simctl shutdown all >/dev/null 2>&1 || :
xcrun simctl delete all

tab=$(printf '\t')
while IFS="$tab" read -r model type width height; do
  [ -n "$model" ] || continue
  step "$model: creating it on iOS $os ($build)"
  udid=$(xcrun simctl create "$model" "$type" "$runtime") || die "Xcode cannot make a $model ($type) on $runtime"
  started=$(now)
  boot_and_wait "$udid"
  first_boot=$(seconds_since "$started")
  step "$model: first boot in $first_boot s; writing its keyboard defaults and slimming it"
  keyboard_defaults "$udid"
  started=$(now)
  apply_slimming "$udid" "$list"
  restart_device "$udid"
  apply_slimming "$udid" "$list"
  slim_seconds=$(seconds_since "$started")
  count=$(slimmed_count "$udid" "$list")
  [ "$count" -eq "$labels" ] || die "$model has $count of the $labels labels of $list_name disabled after two passes"
  restart_device "$udid"
  count=$(slimmed_count "$udid" "$list")
  [ "$count" -eq "$labels" ] || die "$model has $count of the $labels labels of $list_name disabled after a reboot"
  pasteboard_cleared "$udid"
  xcrun simctl shutdown "$udid"
  step "$model: slim, $count labels disabled, in $slim_seconds s"
  printf 'device=%s\t%s\t%s\t%s\t%s\t%s\n' "$model" "$type" "$udid" "$first_boot" "$slim_seconds" "$count"
done <"$here/devices.tsv"

step "installing bb-box-check-ios and its probe app"
sudo install -d -m 0755 /usr/local/libexec/bb-box "$share/ios"
sudo install -m 0755 "$here/check-ios.sh" /usr/local/bin/bb-box-check-ios
sudo install -m 0755 "$here/slot-clipboard.sh" /usr/local/libexec/bb-box/slot-clipboard
sudo install -m 0644 "$here/devices.tsv" "$share/ios/devices.tsv"
sudo install -m 0644 "$list" "$share/ios/$list_name.txt"
sudo rm -rf "$share/ios/probe"
sudo cp -R "$here/probe" "$share/ios/probe"
sudo chmod -R a+rX "$share/ios"

step "adding device-host, each runtime's disabled.plist and the two carried slots"
sudo -n /bin/sh "$here/host-ios.sh" "$here" "$(id -un)" || die "adding device-host and the carried slots failed"

device_hub_off
rm -rf "$HOME/Library/Logs/CoreSimulator" "$HOME/Library/Developer/Xcode/DerivedData" /tmp/idb "$HOME/.idb" 2>/dev/null || :

printf 'runtime=%s\t%s\t%s\t%s\t%s\n' "$os" "$build" "$xcode" "$IDB_VERSION" "$runtime"
printf 'slim=%s\t%s\t%s\n' "$list_name" "$labels" "$list_sha256"
printf 'encoders=%s\t%s\n' "$hardware_encoder" "$software_encoder"
