#!/bin/sh
udid=${1:?udid}
list=${SLIM_LIST:-/usr/local/share/bb-box/ios/ios-27.0-24A434.txt}
xcrun simctl spawn "$udid" launchctl print-disabled system | python3 -c '
import re, sys
listed = {l.strip() for l in open(sys.argv[1]) if l.strip()}
off = {m.group(1) for m in re.finditer(r"\"([^\"]+)\" => (?:disabled|true)", sys.stdin.read())}
print(len(listed & off))' "$list"
