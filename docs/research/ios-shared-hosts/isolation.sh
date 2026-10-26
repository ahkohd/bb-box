#!/bin/sh
set -u

here=$(cd "$(dirname "$0")" && pwd)
me=${1:-sbu1}
other=${2:-sbu2}
as_user() { "$here/users.sh" run "$@"; }
other_udid=$(as_user "$other" 'xcrun simctl list devices | sed -n "s/^ *slim (\([-0-9A-F]*\)).*/\1/p"')
other_pid=$(pgrep -u "$other" -f idb_companion | head -n 1)
as_user "$other" 'nohup python3 -m http.server 9102 --bind 127.0.0.1 --directory /tmp >/dev/null 2>&1 & echo $! > /tmp/isolation-server.pid'
sleep 1

check() {
  what=$1; shift
  result=$(as_user "$me" "$@" 2>&1 | tr '\n' ' ' | cut -c1-200)
  printf '%s\t%s\n' "$what" "$result"
}

check "list the other's home" "ls /Users/$other | head -5"
check "list the other's Library" "ls /Users/$other/Library 2>&1 | head -3"
check "list the other's device set" "ls /Users/$other/Library/Developer/CoreSimulator/Devices 2>&1 | head -3"
check "simctl on the other's set" "xcrun simctl --set /Users/$other/Library/Developer/CoreSimulator/Devices list devices 2>&1 | tail -3"
check "simctl on the other's device by UDID" "xcrun simctl io $other_udid screenshot /tmp/peek.png 2>&1 | tail -1"
check "connect to the other's idb socket" "python3 -c \"import socket; s=socket.socket(socket.AF_UNIX); s.connect('/Users/$other/s/idb.sock'); print('connected')\" 2>&1 | tail -1"
check "see the other's processes" "ps -A -o user=,command= | grep '^$other ' | grep -c launchd_sim"
check "see the other's device UDID in ps" "ps -A -o command= | grep -c $other_udid"
check "signal the other's companion" "kill -0 $other_pid 2>&1; echo exit \$?"
check "reach a server the other runs on loopback" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9102/"
check "the other's device reaches my loopback page" "echo n/a"
check "read the other's files in /tmp" "ls -la /tmp | grep $other | head -3"
check "read the other's keychain" "security list-keychains -d user; ls /Users/$other/Library/Keychains 2>&1 | head -2"
check "write into the other's home" "touch /Users/$other/probe 2>&1; echo exit \$?"
check "read the other's DerivedData" "ls /Users/$other/Library/Developer/Xcode/DerivedData 2>&1 | head -2"

as_user "$other" 'kill $(cat /tmp/isolation-server.pid); rm -f /tmp/isolation-server.pid'
