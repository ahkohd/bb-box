#!/bin/sh
set -eu
udid=$1
list=$2
action=${3:-disable}
now() { python3 -c 'import time; print(f"{time.time():.3f}")'; }
state=$(xcrun simctl list devices | grep "$udid" | sed 's/.*(\([A-Za-z]*\)) *$/\1/')
if [ "$state" != "Booted" ]; then
  xcrun simctl boot "$udid"
  xcrun simctl bootstatus "$udid" -b > /dev/null
fi
start=$(now)
count=0
while read -r label; do
  [ -n "$label" ] || continue
  tries=0
  until xcrun simctl spawn "$udid" launchctl "$action" "system/$label"; do
    tries=$((tries + 1))
    [ "$tries" -lt 5 ] || exit 1
    sleep 2
  done
  count=$((count + 1))
done < "$list"
end=$(now)
python3 -c "print('$action', $count, 'labels in', round($end - $start, 1), 's')"
