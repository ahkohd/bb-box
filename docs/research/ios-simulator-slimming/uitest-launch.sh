#!/bin/sh
udid=$1
project=${PROJECT:-$HOME/slim/ios-simulator-slimming/probe-app/SlimProbe.xcodeproj}
derived=${DERIVED:-$HOME/slim/dd}
log=$(mktemp)
xcodebuild test-without-building -project "$project" -scheme SlimProbe -destination "id=$udid" -derivedDataPath "$derived" \
  -only-testing:SlimProbeUITests/SlimProbeUITests/testTapsAreCounted > "$log" 2>&1
grep -E "Setting up automation session" "$log" | head -1 | sed 's/.*t = *\([0-9.]*\)s.*/launch to automation session: \1 s/'
grep -E "Test Case .*(passed|failed)" "$log" | sed 's/.*\(passed\|failed\)/\1/'
