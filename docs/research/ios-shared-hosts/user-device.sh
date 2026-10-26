#!/bin/sh
set -u

here=$(cd "$(dirname "$0")" && pwd)
shared=/Users/Shared/bb-box/docs/research/ios-shared-hosts
now() { python3 -c 'import time; print(f"{time.time():.3f}")'; }
since() { python3 -c "import sys, time; print(f'{time.time() - float(sys.argv[1]):.1f}')" "$1"; }
as_user() { "$here/users.sh" run "$@"; }
template=$(xcrun simctl list devices -j | python3 -c 'import json,sys; print(next(d["udid"] for r in json.load(sys.stdin)["devices"].values() for d in r if d["name"]=="iPhone 18 Pro"))')

case ${1:-} in
  copy)
    name=${2:?user}
    started=$(now)
    xcrun simctl shutdown "$template" 2>/dev/null
    as_user "$name" 'xcrun simctl list devices >/dev/null'
    set_dir=/Users/$name/Library/Developer/CoreSimulator/Devices
    sudo cp -c -R "$HOME/Library/Developer/CoreSimulator/Devices/$template" "$set_dir/$template"
    sudo chown -R "$name:staff" "$set_dir/$template"
    copied=$(since "$started")
    as_user "$name" "pkill -x com.apple.CoreSimulator.CoreSimulatorService; sleep 1; xcrun simctl rename $template slim && xcrun simctl boot $template && xcrun simctl bootstatus $template -b >/dev/null && echo booted"
    booted=$(since "$started")
    disabled=$(as_user "$name" "sh $shared/slim-count.sh $template")
    echo "copy to $name: copied in $copied s, booted after $booted s, $disabled labels of the list disabled"
    ;;
  copy-new)
    name=${2:?user}
    started=$(now)
    xcrun simctl shutdown "$template" 2>/dev/null
    as_user "$name" 'xcrun simctl list devices >/dev/null'
    set_dir=/Users/$name/Library/Developer/CoreSimulator/Devices
    fresh=$(uuidgen)
    sudo cp -c -R "$HOME/Library/Developer/CoreSimulator/Devices/$template" "$set_dir/$fresh"
    sudo plutil -replace UDID -string "$fresh" "$set_dir/$fresh/device.plist"
    sudo chown -R "$name:staff" "$set_dir/$fresh"
    copied=$(since "$started")
    as_user "$name" "pkill -x com.apple.CoreSimulator.CoreSimulatorService; sleep 1; xcrun simctl rename $fresh slim && xcrun simctl boot $fresh && xcrun simctl bootstatus $fresh -b >/dev/null && echo booted"
    booted=$(since "$started")
    disabled=$(as_user "$name" "sh $shared/slim-count.sh $fresh")
    echo "copy with a new UDID to $name: copied in $copied s, booted after $booted s, $disabled labels of the list disabled"
    ;;
  create)
    name=${2:?user}
    started=$(now)
    udid=$(as_user "$name" 'xcrun simctl create slim com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro com.apple.CoreSimulator.SimRuntime.iOS-27-0')
    as_user "$name" "xcrun simctl boot $udid; xcrun simctl bootstatus $udid -b >/dev/null"
    first=$(since "$started")
    as_user "$name" "sh $shared/slim-apply.sh $udid"
    disabled=$(as_user "$name" "sh $shared/slim-count.sh $udid")
    echo "create for $name: first boot after $first s, slim after $(since "$started") s, $disabled labels of the list disabled"
    ;;
  *) echo "usage: user-device.sh copy|create <user>" >&2; exit 2 ;;
esac
