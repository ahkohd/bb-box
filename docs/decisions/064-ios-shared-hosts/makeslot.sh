#!/bin/sh
cd ~/bb-box/docs/research/ios-shared-hosts
name=$1
now() { python3 -c 'import time; print(f"{time.time():.3f}")'; }
s=$(now)
./users.sh make $name >/dev/null
./users.sh run $name 'xcrun simctl delete all >/dev/null 2>&1; N=$(xcrun simctl create slot com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro com.apple.CoreSimulator.SimRuntime.iOS-27-0)
mkdir -p /private/var/tmp/com.apple.CoreSimulator.SimDevice.$N && cp /Users/Shared/bb-box/disabled.plist /private/var/tmp/com.apple.CoreSimulator.SimDevice.$N/
xcrun simctl boot $N; xcrun simctl bootstatus $N -b >/dev/null; echo "devices $(xcrun simctl list devices | grep -c "("), disabled $(sh /tmp/count.sh $N)"'
echo "slot $name made in $(python3 -c "print(round($(now)-$s,1))") s"
