#!/bin/sh
set -u
previous=''
F=$FAKE_MAC_STATE
R=$FAKE_MAC_ROOT
tool=${0##*/}
as=${FAKE_AS:-root}
printf '%s %s\n' "$tool" "$*" >>"$F/calls"

flag() { [ -e "$F/flags/$1" ]; }
uid_of() {
  case $1 in
    root) echo 0 ;;
    *[!0-9]*) cat "$F/users/$1/UniqueID" 2>/dev/null ;;
    *) echo "$1" ;;
  esac
}
home_of() { cat "$F/users/$1/NFSHomeDirectory" 2>/dev/null; }
edit() {
  file=$1
  shift
  touch "$file"
  "$@" <"$file" >"$file.new.$$" || :
  mv -f "$file.new.$$" "$file"
}
next_number() {
  n=$(($(cat "$F/$1" 2>/dev/null || echo "$2") + 1))
  echo "$n" >"$F/$1"
  echo "$n"
}

sims=$F/sims/$as
device_value() { sed -n "s/^$2=//p" "$sims/$1" 2>/dev/null; }
set_device_value() { edit "$sims/$1" sed "s/^$2=.*/$2=$3/"; }
make_device() {
  mkdir -p "$sims"
  udid=$(printf '%08X-0000-4000-8000-%012X' "$(next_number udids 0)" "$(uid_of "$as")")
  printf 'name=%s\ntype=%s\nruntime=%s\nstate=Shutdown\n' "$1" "$2" "$3" >"$sims/$udid"
  echo "$udid"
}
boot_device() {
  [ -f "$sims/$1" ] || { echo "Invalid device: $1" >&2; exit 164; }
  [ "$(device_value "$1" state)" = Shutdown ] || { echo "Unable to boot device in current state: Booted" >&2; exit 149; }
  set_device_value "$1" state Booted
  pid=$(next_number pids 20000)
  echo "$pid $(uid_of "$as") launchd_sim 1" >>"$F/processes"
  mkdir -p "$F/commands"
  echo "launchd_sim $R/Users/$as/Library/Developer/CoreSimulator/Devices/$1/data/var/run/launchd_bootstrap.plist" >"$F/commands/$pid"
  echo "$pid" >"$sims/$1.pid"
}
shutdown_device() {
  [ "$(device_value "$1" state)" = Booted ] || return 0
  set_device_value "$1" state Shutdown
  pid=$(cat "$sims/$1.pid" 2>/dev/null)
  [ -z "$pid" ] || edit "$F/processes" awk -v p="$pid" '$1 != p'
  rm -f "$sims/$1.pid" "$F/commands/$pid"
}

case $tool in
  sudo)
    previous=''
    while [ $# -gt 0 ]; do
      case $1 in
        -n | -H) shift ;;
        -u) as=$2 && shift 2 ;;
        --) shift && break ;;
        *) break ;;
      esac
    done
    command=$1
    shift
    export FAKE_AS=$as
    if [ -x "$FAKE_MAC_BIN/${command##*/}" ]; then exec "$FAKE_MAC_BIN/${command##*/}" "$@"; fi
    exec "$command" "$@"
    ;;

  xcrun)
    [ "${1:-}" = simctl ] || exit 1
    shift
    flag simctl-fails && exit 1
    if [ ! -e "$sims/.listed" ] && [ "$as" != root ]; then
      mkdir -p "$sims"
      : >"$sims/.listed"
      for default in "iPhone 17" "iPad Air 11-inch (M4)" "Apple Watch Series 11 (46mm)"; do make_device "$default" "com.apple.CoreSimulator.SimDeviceType.default" com.apple.CoreSimulator.SimRuntime.iOS-27-0 >/dev/null; done
    fi
    case ${1:-} in
      list)
        if [ "${2:-}" = devicetypes ]; then
          echo "== Device Types =="
          flag no-iphone-18-pro || echo 'iPhone 18 Pro (com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro)'
          echo 'iPhone 17 (com.apple.CoreSimulator.SimDeviceType.iPhone-17)'
          echo 'iPad Pro 13-inch (M5) (com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB)'
          exit 0
        fi
        if [ "${2:-}" = runtimes ]; then
          flag no-ios-runtime || echo 'iOS 27.0 (27.0 - 24A434) - com.apple.CoreSimulator.SimRuntime.iOS-27-0'
          echo 'watchOS 27.0 (27.0 - 24R345) - com.apple.CoreSimulator.SimRuntime.watchOS-27-0'
          exit 0
        fi
        echo "== Devices =="
        echo "-- iOS 27.0 --"
        for file in "$sims"/*; do
          [ -f "$file" ] || continue
          case $file in *.pid) continue ;; esac
          udid=${file##*/}
          echo "    $(device_value "$udid" name) ($udid) ($(device_value "$udid" state))"
        done
        ;;
      create)
        flag simctl-create-fails && { echo "Invalid device type" >&2; exit 162; }
        make_device "$2" "$3" "$4"
        ;;
      delete)
        if [ "$2" = all ]; then
          for file in "$sims"/*; do
            [ -f "$file" ] || continue
            case $file in *.pid) continue ;; esac
            shutdown_device "${file##*/}"
            rm -f "$file"
          done
        else
          shutdown_device "$2"
          rm -f "$sims/$2"
        fi
        ;;
      boot)
        if [ -e "$F/flags/boot-fails" ]; then
          left=$(cat "$F/flags/boot-fails")
          if [ "${left:-0}" -gt 0 ]; then
            echo $((left - 1)) >"$F/flags/boot-fails"
            echo "Unable to boot the Simulator: launchd failed to respond." >&2
            exit 60
          fi
        fi
        boot_device "$2"
        ;;
      bootstatus) [ "$(device_value "$2" state)" = Booted ] ;;
      spawn)
        [ "$(device_value "$2" state)" = Booted ] || { echo "Device is not booted." >&2; exit 149; }
        [ "$3 $4" = "launchctl disable" ] || exit 1
        flag spawn-skips && exit 0
        store=$R/private/var/tmp/com.apple.CoreSimulator.SimDevice.$2
        mkdir -p "$store"
        echo "${5#system/}" >>"$store/labels"
        {
          printf '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n'
          sort -u "$store/labels" | sed 's|.*|\t<key>&</key>\n\t<true/>|'
          printf '</dict>\n</plist>\n'
        } >"$store/disabled.plist"
        ;;
      shutdown)
        if [ "$2" = all ]; then
          for file in "$sims"/*; do [ -f "$file" ] && case $file in *.pid) ;; *) shutdown_device "${file##*/}" ;; esac; done
        else
          shutdown_device "$2"
        fi
        ;;
      *) exit 1 ;;
    esac
    ;;

  launchctl)
    mkdir -p "$F/daemons"
    case ${1:-} in
      bootstrap)
        [ "$2" = system ] || exec "$FAKE_MACOS_BIN/launchctl" "$@"
        label=$(basename "$3" .plist)
        flag "bootstrap-fails-$label" && exit 5
        [ ! -e "$F/daemons/$label" ] || exit 5
        cp "$3" "$F/daemons/$label"
        ;;
      bootout)
        case $2 in
          system/*) rm -f "$F/daemons/${2#system/}" ;;
          *) exec "$FAKE_MACOS_BIN/launchctl" "$@" ;;
        esac
        ;;
      print)
        case $2 in
          system/app.bb-box.*) [ -e "$F/daemons/${2#system/}" ] ;;
          *) exec "$FAKE_MACOS_BIN/launchctl" "$@" ;;
        esac
        ;;
      *) exec "$FAKE_MACOS_BIN/launchctl" "$@" ;;
    esac
    ;;

  ps)
    case "$*" in
      "-o uid= -p "*) awk -v p="$4" '$1 == p { print "  " $2; found = 1 } END { exit !found }' "$F/processes" ;;
      "-ww -o command= -p "*) [ -f "$F/commands/$5" ] && cat "$F/commands/$5" ;;
      "-ww -axo uid=,pid=,command="*)
        while read -r pid uid name kills; do
          [ -n "$pid" ] || continue
          if [ -f "$F/commands/$pid" ]; then command=$(cat "$F/commands/$pid"); else command=$name; fi
          echo "$uid $pid $command"
        done <"$F/processes"
        ;;
      "-axo uid=,pcpu="*)
        while read -r pid uid name kills; do
          [ -n "$pid" ] || continue
          load=$(cat "$F/load/$pid" 2>/dev/null || echo "0.0 1024")
          echo "$uid ${load%% *}"
        done <"$F/processes"
        ;;
      "-axo uid=,rss="*)
        while read -r pid uid name kills; do
          [ -n "$pid" ] || continue
          load=$(cat "$F/load/$pid" 2>/dev/null || echo "0.0 1024")
          echo "$uid ${load##* }"
        done <"$F/processes"
        ;;
      *) exit 1 ;;
    esac
    ;;

  pkill)
    uid='' name=''
    for argument; do
      case $previous in -u) uid=$argument ;; -x) name=$argument ;; esac
      previous=$argument
    done
    [ -n "$name" ] || exec "$FAKE_MACOS_BIN/pkill" "$@"
    edit "$F/processes" awk -v u="$(uid_of "$uid")" -v n="$name" '!($2 == u && $3 == n)'
    ;;
  top) exit 1 ;;
  memory_pressure) echo "System-wide memory free percentage: $(cat "$F/flags/memory-free" 2>/dev/null || echo 60)%" ;;
  df)
    echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
    echo "/dev/disk3s5 488245288 100000000 $(cat "$F/flags/disk-free-kib" 2>/dev/null || echo 104857600) 20% /System/Volumes/Data"
    ;;
  taskpolicy)
    [ "$1" = -b ] && shift
    exec "$@"
    ;;
  plutil) exec "$FAKE_MACOS_BIN/plutil" "$@" ;;
  *)
    echo "fake-device-host.sh: no fake $tool" >&2
    exit 127
    ;;
esac
