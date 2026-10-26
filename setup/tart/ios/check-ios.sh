#!/bin/sh
set -u

share=/usr/local/share/bb-box
devices=$share/ios/devices.tsv
boot_limit_s=${BOOT_LIMIT_S:-60}
settle_s=${SETTLE_S:-60}
idle_window_s=${IDLE_WINDOW_S:-60}
idle_cores_most=${IDLE_CORES_MOST:-0.1}
launch_limit_s=${LAUNCH_LIMIT_S:-3}
uitest_most_s=${UITEST_MOST_S:-300}
simctl_most_s=${SIMCTL_MOST_S:-120}
failed=0

line() { printf '%s %s   %s\n' "$1" "$2" "$3"; }
ok() { line "$1" ok "$2"; }
fail() { line "$1" FAIL "$2"; failed=1; }
check() { name=$1; shift; if out=$("$@" 2>&1); then ok "$name" "$(echo "$out" | head -n 1)"; else fail "$name" "$(echo "$out" | head -n 1)"; fi; }
now() { python3 -c 'import time; print(f"{time.time():.3f}")'; }
simctl() { perl -e 'alarm shift; exec @ARGV' "$simctl_most_s" xcrun simctl "$@"; }


udid_of() {
  simctl list devices -j | python3 -c '
import json, sys
name, kind = sys.argv[1], sys.argv[2]
for runtime, devices in json.load(sys.stdin)["devices"].items():
    for d in devices:
        if d["name"] == name and d["deviceTypeIdentifier"] == kind and d.get("isAvailable"):
            print(d["udid"]); sys.exit()
' "$1" "$2"
}

booted() { simctl list devices | grep -F "($1)" | grep -q '(Booted)'; }

boots_within() {
  udid=$1
  booted "$udid" && simctl shutdown "$udid"
  started=$(now)
  simctl boot "$udid" || return 1
  xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1 &
  waiter=$!
  while kill -0 "$waiter" 2>/dev/null; do
    if python3 -c "import sys, time; sys.exit(0 if time.time() - $started < $boot_limit_s else 1)"; then sleep 0.5; continue; fi
    kill "$waiter" 2>/dev/null
    echo "simctl bootstatus did not return within $boot_limit_s s"
    return 1
  done
  python3 -c "import time; print(f'booted in {time.time() - $started:.1f} s, within {$boot_limit_s} s')"
}

slim_count() {
  udid=$1 list=$2
  simctl spawn "$udid" launchctl print-disabled system | python3 -c '
import re, sys
listed = {line.strip() for line in open(sys.argv[1]) if line.strip()}
disabled = {m.group(1) for m in re.finditer(r"\"([^\"]+)\" => (?:disabled|true)", sys.stdin.read())}
have = len(listed & disabled)
print(f"{have} of the {len(listed)} labels of {sys.argv[2]} disabled")
sys.exit(0 if have == len(listed) else 1)
' "$list" "$(basename "$list" .txt)"
}

needed_services_enabled() {
  udid=$1
  off=$(simctl spawn "$udid" launchctl print-disabled system | grep -oE '"com\.apple\.(nanoregistryd|sleepd|gamed)" => (disabled|true)' | cut -d'"' -f2)
  [ -z "$off" ] || { echo "$(echo $off) disabled; the device needs them"; return 1; }
  echo "nanoregistryd, sleepd and gamed enabled"
}

keyboard_defaults_hold() {
  udid=$1
  for setting in com.apple.keyboard.preferences:KeyboardAutocorrection com.apple.keyboard.preferences:SmartTyping \
    com.apple.keyboard.preferences:KeyboardPeriodShortcut com.apple.keyboard.predictive:KeyboardPrediction \
    com.apple.keyboard.ContinuousPath:KeyboardContinuousPathEnabled; do
    value=$(simctl spawn "$udid" defaults read "${setting%%:*}" "${setting#*:}" 2>/dev/null)
    [ "$value" = 0 ] || { echo "${setting#*:} is ${value:-unset}, not off"; return 1; }
  done
  [ "$(simctl spawn "$udid" defaults read com.apple.Preferences DidShowContinuousPathIntroduction 2>/dev/null)" = 1 ] ||
    { echo "the keyboard's slide to type sheet is not answered"; return 1; }
  echo "autocorrect, smart punctuation, predictions and slide to type off"
}

pixels_match() {
  udid=$1 width=$2 height=$3
  shot=$(mktemp -d)/screen.png
  simctl io "$udid" screenshot "$shot" >/dev/null 2>&1 || { echo "simctl took no screenshot"; return 1; }
  got=$(sips -g pixelWidth -g pixelHeight "$shot" | awk '/pixelWidth/ { w = $2 } /pixelHeight/ { h = $2 } END { print w "x" h }')
  rm -rf "$(dirname "$shot")"
  [ "$got" = "${width}x$height" ] || { echo "the screen is $got, and the model table says ${width}x$height"; return 1; }
  echo "$got, as the model table says"
}

content_sizes="extra-small small medium large extra-large extra-extra-large extra-extra-extra-large accessibility-medium accessibility-large accessibility-extra-large accessibility-extra-extra-large accessibility-extra-extra-extra-large"

ui_reads() { simctl ui "$1" "$2" 2>/dev/null | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]'; }

ui_sets_and_reads_back() {
  udid=$1 option=$2 values=$3
  was=$(ui_reads "$udid" "$option")
  [ -n "$was" ] || { echo "simctl ui $option read nothing"; return 1; }
  for value in $values; do
    simctl ui "$udid" "$option" "$value" >/dev/null 2>&1 || { echo "simctl ui $option $value failed"; simctl ui "$udid" "$option" "$was" >/dev/null 2>&1; return 1; }
    got=$(ui_reads "$udid" "$option")
    [ "$got" = "$value" ] || { echo "set to $value, it reads back ${got:-nothing}"; simctl ui "$udid" "$option" "$was" >/dev/null 2>&1; return 1; }
  done
  simctl ui "$udid" "$option" "$was" >/dev/null 2>&1 || { echo "simctl ui $option did not set it back to $was"; return 1; }
  echo "$(echo $values | wc -w | tr -d ' ') values set and read back, then $was again"
}

status_bar_overrides() { simctl status_bar "$1" list 2>/dev/null | grep -v -e '^[[:space:]]*$' -e '^Current Status Bar Overrides:$' -e '^=*$'; }

status_bar_reads_back() {
  udid=$1
  simctl status_bar "$udid" override --time 9:41 --batteryState discharging --batteryLevel 42 >/dev/null 2>&1 || { echo "simctl status_bar override failed"; return 1; }
  listed=$(status_bar_overrides "$udid")
  simctl status_bar "$udid" clear >/dev/null 2>&1 || { echo "simctl status_bar clear failed"; return 1; }
  printf '%s\n' "$listed" | grep -q '9:41' && printf '%s\n' "$listed" | grep -q '42' || { echo "overridden, it lists: $(printf '%s' "$listed" | tr '\n' ' ')"; return 1; }
  left=$(status_bar_overrides "$udid")
  [ -z "$left" ] || { echo "cleared, it still lists: $(printf '%s' "$left" | tr '\n' ' ')"; return 1; }
  echo "an override of the time and battery listed, then cleared"
}

lock_state_reads() {
  udid=$1
  value=$(simctl spawn "$udid" notifyutil -g com.apple.springboard.lockstate 2>/dev/null | awk '{ print $NF }')
  case $value in
    0) echo "unlocked, as the lock state reads 0" ;;
    1) echo "the device reads locked just after it booted"; return 1 ;;
    *) echo "notifyutil read the lock state as ${value:-nothing}"; return 1 ;;
  esac
}

tree_cpu_seconds() {
  udid=$1
  ps -axo pid=,ppid=,time=,command= | python3 -c '
import sys
udid = sys.argv[1]
rows = {}
for line in sys.stdin:
    parts = line.split(None, 3)
    if len(parts) < 4: continue
    pid, ppid, time, command = int(parts[0]), int(parts[1]), parts[2], parts[3]
    seconds = 0.0
    for part in time.replace("-", ":").split(":"): seconds = seconds * 60 + float(part)
    rows[pid] = (ppid, seconds, command)
roots = [pid for pid, (_, _, command) in rows.items() if "launchd_sim" in command and udid in command]
tree, frontier = set(roots), list(roots)
while frontier:
    parent = frontier.pop()
    for pid, (ppid, _, _) in rows.items():
        if ppid == parent and pid not in tree:
            tree.add(pid); frontier.append(pid)
for pid in tree: print(pid, rows[pid][1])
' "$udid"
}

idle_cpu_within() {
  udid=$1
  sleep "$settle_s"
  before=$(tree_cpu_seconds "$udid")
  [ -n "$before" ] || { echo "found no launchd_sim for $udid"; return 1; }
  sleep "$idle_window_s"
  after=$(tree_cpu_seconds "$udid")
  python3 -c '
import sys
def table(text): return {int(a): float(b) for a, b in (l.split() for l in text.splitlines() if l.strip())}
before, after, window, most = table(sys.argv[1]), table(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])
used = sum(seconds - before.get(pid, 0.0) for pid, seconds in after.items())
cores = used / window
print(f"{cores:.3f} of a core idle over {window:.0f} s, {len(after)} processes; at most {most}")
sys.exit(0 if cores <= most else 1)
' "$before" "$after" "$idle_window_s" "$idle_cores_most"
}

stopped_after() {
  pid=$1 most=$2 waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$most" ]; then
      pkill -P "$pid" 2>/dev/null
      kill "$pid" 2>/dev/null
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid" 2>/dev/null
}

probe_built=
build_probe() {
  [ -n "$probe_built" ] && return 0
  probe_work=$(mktemp -d)
  cp -R "$share/ios/probe" "$probe_work/probe"
  xcodebuild -project "$probe_work/probe/BBProbe.xcodeproj" -scheme BBProbe -destination "generic/platform=iOS Simulator" \
    -derivedDataPath "$probe_work/derived" build-for-testing -quiet >"$probe_work/build.log" 2>&1 || { tail -n 5 "$probe_work/build.log"; return 1; }
  probe_built=1
}

uitest_launch_within() {
  udid=$1
  build_probe || { echo "the probe app did not build"; return 1; }
  log=$probe_work/test-$udid.log
  xcodebuild test-without-building -project "$probe_work/probe/BBProbe.xcodeproj" -scheme BBProbe -destination "id=$udid" \
    -derivedDataPath "$probe_work/derived" -collect-test-diagnostics never \
    -only-testing:BBProbeUITests/BBProbeUITests/testLaunchAndTap >"$log" 2>&1 &
  stopped_after "$!" "$uitest_most_s"
  python3 -c '
import re, sys
text = open(sys.argv[1]).read()
launch = re.search(r"t = +([0-9.]+)s +Launch ", text)
session = re.search(r"t = +([0-9.]+)s +Setting up automation session", text)
passed = re.search(r"Test Case .*testLaunchAndTap\]. passed", text) is not None
if not (launch and session):
    print("the UI test showed no launch and automation session"); sys.exit(1)
took, limit = float(session.group(1)) - float(launch.group(1)), float(sys.argv[2])
print(f"an XCUITest launch reached its automation session in {took:.1f} s, within {limit:.0f} s" if took <= limit else f"an XCUITest launch took {took:.1f} s to reach its automation session, over {limit:.0f} s")
sys.exit(0 if took <= limit and passed else 1)
' "$log" "$launch_limit_s"
}

check "idb_companion" /usr/local/bin/idb_companion --version
check "idb_companion's notice" sh -c 'ls /usr/local/share/bb-box/notices/idb_companion-*-LICENSE'
check "device hub not running" sh -c '! pgrep -x DeviceHub >/dev/null || { echo "Device Hub runs"; exit 1; }; echo "Device Hub is not running"'
list=$(ls "$share"/ios/ios-*.txt 2>/dev/null | head -n 1)
[ -n "$list" ] || fail "slimming list" "the image has no slimming list in $share/ios"

tab=$(printf '\t')
models=${1:-}
while IFS="$tab" read -r model type width height; do
  [ -n "$model" ] || continue
  if [ -n "$models" ] && ! printf '%s\n' "$models" | tr ',' '\n' | grep -qxF "$model"; then continue; fi
  udid=$(udid_of "$model" "$type")
  if [ -z "$udid" ]; then fail "$model" "the image has no $model ($type)"; continue; fi
  was_booted=; booted "$udid" && was_booted=1
  if ! out=$(boots_within "$udid"); then
    fail "$model boots" "$out"
    simctl shutdown "$udid" >/dev/null 2>&1
    continue
  fi
  ok "$model boots" "$out"
  [ -z "$list" ] || check "$model slim" slim_count "$udid" "$list"
  check "$model needed services" needed_services_enabled "$udid"
  check "$model keyboard" keyboard_defaults_hold "$udid"
  check "$model pixels" pixels_match "$udid" "$width" "$height"
  check "$model appearance" ui_sets_and_reads_back "$udid" appearance "dark light"
  check "$model text size" ui_sets_and_reads_back "$udid" content_size "$content_sizes"
  check "$model status bar" status_bar_reads_back "$udid"
  check "$model lock state" lock_state_reads "$udid"
  check "$model idle cpu" idle_cpu_within "$udid"
  check "$model xcuitest launch" uitest_launch_within "$udid"
  [ -n "$was_booted" ] || simctl shutdown "$udid" 2>/dev/null || fail "$model shuts down" "simctl shutdown did not end within $simctl_most_s s"
done <"$devices"
[ -z "${probe_work:-}" ] || rm -rf "$probe_work"
exit "$failed"
