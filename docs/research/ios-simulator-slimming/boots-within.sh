#!/bin/sh
udid=$1
limit=${2:-90}
xcrun simctl shutdown "$udid" 2>/dev/null
sleep 3
xcrun simctl boot "$udid"
start=$(date +%s)
xcrun simctl bootstatus "$udid" -b > /dev/null 2>&1 &
waiter=$!
while kill -0 "$waiter" 2>/dev/null; do
  if [ $(( $(date +%s) - start )) -ge "$limit" ]; then
    kill "$waiter"
    echo "not booted within $limit s"
    exit 1
  fi
  sleep 1
done
echo "booted in $(( $(date +%s) - start )) s"
