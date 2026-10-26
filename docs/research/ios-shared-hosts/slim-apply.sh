#!/bin/sh
udid=${1:?udid}
list=${SLIM_LIST:-/usr/local/share/bb-box/ios/ios-27.0-24A434.txt}
for pass in 1 2; do
  while read -r label; do
    [ -n "$label" ] && xcrun simctl spawn "$udid" launchctl disable "system/$label" 2>/dev/null
  done <"$list"
  xcrun simctl reboot "$udid"
  xcrun simctl bootstatus "$udid" -b >/dev/null
done
