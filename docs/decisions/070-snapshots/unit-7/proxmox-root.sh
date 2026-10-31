#!/bin/bash
set -euo pipefail
usage() {
  cat >&2 <<'TEXT'
The root steps of 070 unit 7's live check, on the Proxmox node. Each acts
only on the VMIDs in BBBOX_VMIDS, and only on guests that carry the tag
install.<BBBOX_INSTALL>, as bb-box's boxes and forks do.

  live: BBBOX_VMIDS="3170 3171" BBBOX_INSTALL=<id> proxmox-root.sh <command> [vmid]
  (card-late and sample take one VMID or several, quoted, and act on one)

  config <vmid>
      read only: prints the guest's onboot, template, lock, tags, hostname
      or name, network lines and SMBIOS UUID (gate G14: a fork starts with
      onboot set and its links up)
  card-late "<vmid>..." [seconds]
      for a fork, a container or a VM, that bb-box holds before its first
      start (bb box snapshot hold-next --at forked): waits up to 10 minutes
      for the first of the VMIDs given to exist as bb-box holds a fork, of
      the install, stopped, with no lock,
      onboot not set and its net0's link down, the same across 5 s; saves
      net0 in /root/unit7-<vmid>-net0, removes it, waits for bb-box to start
      it, waits the seconds given (75 by default) and puts the same net0
      back, with its link up, while it runs. With 75 s its first boot
      cannot tell whether it is a copy (gate G14: a fork whose first boot
      says unknown is not handed over as ready); with under 30 s the card
      comes back during the boot's own wait, so the boot must hold the
      copied network settings from its first look
  sample "<vmid>..." <seconds>
      read only: run before asking for the fork. Waits for a config to
      appear for the first of the VMIDs given that has none when it starts,
      then reads that config from /etc/pve every 0.1 s, with
      whether the guest runs, for up to the seconds given, and stops at
      bb-box's arm: the first sample with onboot 1 and no lock after the
      guest has run. Writes every change to /root/unit7-<vmid>-samples.log
      and says whether any sample before the arm had onboot 1 and no lock,
      and how long the clone was unlocked before bb-box disarmed it
  leftovers
      read only: lists every guest in BBBOX_VMIDS that carries the install's
      tag, with its status and tags, for the clean-up
  destroy <vmid>
      stops and destroys a guest of the install that bb-box no longer
      records, for the clean-up
TEXT
  exit 2
}
[ $# -ge 1 ] && [ -n "${BBBOX_VMIDS:-}" ] && [ -n "${BBBOX_INSTALL:-}" ] || usage
command=$1
node=$(hostname)

listed() { [[ " $BBBOX_VMIDS " == *" $1 "* ]] || { echo "VMID $1 is not in BBBOX_VMIDS: $BBBOX_VMIDS" >&2; exit 2; }; }
kind_of() {
  if [ -e "/etc/pve/nodes/$node/qemu-server/$1.conf" ]; then echo qm
  elif [ -e "/etc/pve/nodes/$node/lxc/$1.conf" ]; then echo pct
  else echo none; fi
}
ours() {
  local tool=$1 vmid=$2 tags
  tags=$($tool config "$vmid" | sed -n 's/^tags: //p')
  [[ ";$tags;" == *";install.$BBBOX_INSTALL;"* ]]
}
held() {
  local config
  config=$($1 config "$2") || return 1
  ! grep -q '^lock:' <<<"$config" && ! grep -q '^onboot: 1' <<<"$config" && $1 status "$2" | grep -q stopped || return 1
  sed -n 's/^net0: //p' <<<"$config" | grep 'link_down=1'
}
settled() {
  local first second
  first=$(held "$1" "$2") || return 1
  sleep 5
  second=$(held "$1" "$2") || return 1
  [ -n "$first" ] && [ "$first" = "$second" ]
}
link_up() { tr ',' '\n' <<<"$1" | grep -v '^link_down=' | paste -sd, -; }
conf_of() {
  if [ -e "/etc/pve/nodes/$node/qemu-server/$1.conf" ]; then echo "/etc/pve/nodes/$node/qemu-server/$1.conf"
  elif [ -e "/etc/pve/nodes/$node/lxc/$1.conf" ]; then echo "/etc/pve/nodes/$node/lxc/$1.conf"; fi
}
runs() {
  local pid
  case $1 in
    */lxc/*) lxc-info -n "$2" -s 2>/dev/null | grep -q RUNNING ;;
    *) pid=$(cat "/var/run/qemu-server/$2.pid" 2>/dev/null) && [ -n "$pid" ] && [ -d "/proc/$pid" ] ;;
  esac
}
state_of() {
  local main onboot lock links
  main=$(sed '/^\[/,$d' "$1" 2>/dev/null) || return 1
  onboot=$(sed -n 's/^onboot: //p' <<<"$main"); onboot=${onboot:-0}
  lock=$(sed -n 's/^lock: //p' <<<"$main"); lock=${lock:-none}
  links=$(grep -E '^net[0-9]+:' <<<"$main" | sed -E 's/^(net[0-9]+):.*/\1/' | while read -r key; do
    if grep -E "^$key:" <<<"$main" | grep -q 'link_down=1'; then echo "$key=down"; else echo "$key=up"; fi
  done | paste -sd' ' -)
  echo "onboot=$onboot lock=$lock links=${links:-none}"
}
must_be_ours() {
  local tool
  tool=$(kind_of "$1")
  [ "$tool" != none ] || { echo "no guest $1 on $node" >&2; exit 2; }
  ours "$tool" "$1" || { echo "guest $1 does not carry the tag install.$BBBOX_INSTALL" >&2; exit 2; }
  echo "$tool"
}

case $command in
  config)
    [ $# -eq 2 ] || usage
    listed "$2"
    tool=$(must_be_ours "$2")
    $tool config "$2" | grep -E '^(onboot|template|lock|tags|hostname|name|net[0-9]+|smbios1):' | sed -E 's/(serial=)[^,]*/\1(address)/'
    ;;
  card-late)
    [ $# -eq 2 ] || [ $# -eq 3 ] || usage
    for candidate in $2; do listed "$candidate"; done
    late=${3:-75}
    [[ "$late" =~ ^[0-9]+$ ]] || usage
    tool=none vmid=""
    for _ in $(seq 1 60); do
      for candidate in $2; do
        tool=$(kind_of "$candidate")
        if [ "$tool" != none ] && ours "$tool" "$candidate" && settled "$tool" "$candidate"; then vmid=$candidate; break 2; fi
      done
      tool=none
      sleep 5
    done
    [ -n "$vmid" ] || { echo "no held fork of the install appeared in $2" >&2; exit 1; }
    net0=$($tool config "$vmid" | sed -n 's/^net0: //p')
    [ -n "$net0" ] || { echo "guest $vmid has no net0" >&2; exit 1; }
    printf '%s\n' "$net0" > "/root/unit7-$vmid-net0"
    $tool set "$vmid" --delete net0 >/dev/null
    echo "$(date -u +%T.%3N) removed net0 of $vmid ($net0)"
    for _ in $(seq 1 3000); do $tool status "$vmid" | grep -q running && break; sleep 0.1; done
    echo "$(date -u +%T.%3N) $vmid is running, without a card"
    sleep "$late"
    $tool set "$vmid" --net0 "$(link_up "$(cat "/root/unit7-$vmid-net0")")" >/dev/null
    echo "$(date -u +%T.%3N) put net0 back on $vmid, its link up, while it runs: $($tool config "$vmid" | sed -n 's/^net0: //p')"
    rm -f "/root/unit7-$vmid-net0"
    ;;
  sample)
    [ $# -eq 3 ] || usage
    [[ "$3" =~ ^[0-9]+$ ]] || usage
    free=""
    for candidate in $2; do listed "$candidate"; [ -n "$(conf_of "$candidate")" ] || free+=" $candidate"; done
    [ -n "$free" ] || { echo "every VMID in $2 has a guest already" >&2; exit 1; }
    echo "$(date -u +%T.%3N) waiting for a guest in:$free"
    end=$(( $(date +%s) + $3 ))
    file="" vmid=""
    while [ -z "$file" ] && [ "$(date +%s)" -lt "$end" ]; do
      for candidate in $free; do file=$(conf_of "$candidate"); [ -z "$file" ] || { vmid=$candidate; break; }; done
      [ -n "$file" ] || sleep 0.1
    done
    [ -n "$file" ] || { echo "no guest appeared in$free within $3 s" >&2; exit 1; }
    echo "$(date -u +%T.%3N) guest $vmid appeared"
    log=/root/unit7-$vmid-samples.log
    : > "$log"
    samples=0 early=0 ran=no armed="" previous="" first="" last_locked="" unlocked="" disarmed="" gone=no
    while [ "$(date +%s)" -lt "$end" ]; do
      now=$(date -u +%T.%3N)
      if ! state=$(state_of "$file") || [ ! -e "$file" ]; then gone=yes; echo "$now gone" >> "$log"; break; fi
      if runs "$file" "$vmid"; then status=running; ran=yes; else status=stopped; fi
      samples=$((samples + 1))
      line="$state status=$status"
      [ -n "$first" ] || first="$now $line"
      [ "$line" = "$previous" ] || echo "$now $line" >> "$log"
      previous=$line
      case $line in
        *"lock=none"*) [ -n "$unlocked" ] || unlocked=$now ;;
        *) last_locked=$now ;;
      esac
      if [ -n "$unlocked" ] && [ -z "$disarmed" ] && [[ "$line" == *"onboot=0 lock=none"* ]]; then disarmed=$now; fi
      if [[ "$line" == *"onboot=1 lock=none"* ]]; then
        if [ "$ran" = yes ]; then armed=$now; break; fi
        early=$((early + 1))
        echo "$now BEFORE THE ARM: onboot 1 with no lock" >> "$log"
      fi
      sleep 0.1
    done
    cat "$log"
    echo "guest $vmid, named $(sed '/^\[/,$d' "$file" 2>/dev/null | sed -n 's/^hostname: //p;s/^name: //p' | head -1)"
    echo "samples: $samples, the first: $first"
    echo "last sample with a lock: ${last_locked:-none}; first without one: ${unlocked:-none}; first disarmed (onboot 0, no lock): ${disarmed:-none}"
    echo "the arm (onboot 1, no lock, after the guest ran): ${armed:-not seen}"
    [ "$gone" = no ] || echo "the guest's config went away"
    problems=""
    [[ "$first" != *"lock=none"* ]] || problems+=" the first sample had no lock, so sampling began after the clone's start;"
    [ -n "$armed" ] || problems+=" the arm was not seen;"
    [ "$early" -eq 0 ] || problems+=" $early samples before the arm had onboot 1 and no lock;"
    if [ -z "$problems" ]; then
      echo "PASS: from the clone's start to the arm, no sample had onboot 1 without a lock"
    else
      echo "FAIL:$problems"
      exit 1
    fi
    ;;
  leftovers)
    for vmid in $BBBOX_VMIDS; do
      tool=$(kind_of "$vmid")
      [ "$tool" != none ] || continue
      ours "$tool" "$vmid" || continue
      echo "$vmid $tool $($tool status "$vmid" | sed 's/^status: //') $($tool config "$vmid" | sed -n 's/^tags: //p')"
    done
    ;;
  destroy)
    [ $# -eq 2 ] || usage
    listed "$2"
    tool=$(must_be_ours "$2")
    $tool stop "$2" >/dev/null 2>&1 || :
    $tool destroy "$2" --purge
    echo "destroyed $2"
    ;;
  *) usage ;;
esac
