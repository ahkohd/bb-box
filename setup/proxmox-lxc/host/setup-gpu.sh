#!/bin/bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)

usage() {
  cat <<'EOF'
usage: setup-gpu.sh            install bb-box-gpu, the host's GPU helper, with writes off
       setup-gpu.sh --remove   remove it, and put back bb-box-gpu-memory.timer

This release installs the helper in a dry run only: its units run it with
--dry-run, so writes stay off whatever /etc/bb-box/gpu.conf says. It writes the
GPU report in the notes of VM bb-box-gpu-memory, as bb-box-gpu-memory.timer
did, with its own lines added, and logs each change it would make to a guest's
NVIDIA device lines. It changes no guest. The timer is retired only once the
helper has written a fresh report; if it does not, the helper is stopped, the
timer stays, and this exits 1. Run as root on the Proxmox host. Idempotent.
EOF
}

mode=install
case "${1:-}" in
  "") ;;
  --remove) mode=remove ;;
  -h | --help) usage && exit 0 ;;
  *) usage >&2 && exit 2 ;;
esac
[ $# -le 1 ] || { usage >&2; exit 2; }

. "$here/common.sh"

root=${BBBOX_ROOT:-}
units=$root/etc/systemd/system
sbin=$root/usr/local/sbin
program=$sbin/bb-box-gpu
conf=$root/etc/bb-box/gpu.conf
state=$root/var/lib/bb-box-gpu
qemu=$root/etc/pve/qemu-server
report_name=bb-box-gpu-memory
report_wait=${BBBOX_GPU_REPORT_WAIT:-30}
changed=0
report_line=""

said() {
  echo "setup-gpu.sh: $*"
  changed=1
}

put() {
  local mode=$1 from=$2 to=$3
  if [ -f "$to" ] && cmp -s "$from" "$to" && [ "$(stat -c %a "$to")" = "${mode#0}" ]; then return 0; fi
  install -m "$mode" "$from" "$to"
  said "installed $to"
}

report_vmid() {
  local found
  found=$(grep -lx "name: $report_name" "$qemu"/*.conf 2>/dev/null | head -1) || true
  [ -n "$found" ] && basename "$found" .conf
}

report_now() {
  local file="$qemu/$1.conf" at helper
  at=$(sed -n 's/^#[[:space:]]*at \([0-9]\{1,\}\)[[:space:]]*$/\1/p' "$file" 2>/dev/null | head -1)
  helper=$(sed -n 's/^#[[:space:]]*\(helper bb-box-gpu .*\)$/\1/p' "$file" 2>/dev/null | head -1)
  printf '%s|%s\n' "${at:-0}" "$helper"
}

wait_for_report() {
  local vmid=$1 since=$2 tries=0 at helper
  while [ "$tries" -lt $((report_wait * 4)) ]; do
    IFS='|' read -r at helper <<<"$(report_now "$vmid")"
    if [[ " $helper " == *" writes off "* ]] && [ "$at" -ge "$since" ]; then
      report_line=$helper
      return 0
    fi
    sleep 0.25
    tries=$((tries + 1))
  done
  return 1
}

unit_known() {
  [ -n "$(systemctl list-unit-files --no-legend "$1" 2>/dev/null)" ] || [ -e "$units/$1" ]
}

timer_present() {
  unit_known bb-box-gpu-memory.timer || [ -e "$sbin/bb-box-gpu-memory" ]
}

put_timer_back() {
  local before=$changed
  changed=0
  put 0755 "$here/bb-box-gpu-memory" "$sbin/bb-box-gpu-memory"
  put 0644 "$here/bb-box-gpu-memory.service" "$units/bb-box-gpu-memory.service"
  put 0644 "$here/bb-box-gpu-memory.timer" "$units/bb-box-gpu-memory.timer"
  local timer_changed=$changed
  changed=$((before | timer_changed))
  systemctl daemon-reload
  if [ "$timer_changed" = 1 ] || ! systemctl is-enabled --quiet bb-box-gpu-memory.timer 2>/dev/null ||
    ! systemctl is-active --quiet bb-box-gpu-memory.timer; then
    rm -f "$root/run/bb-box-gpu-memory"
    systemctl enable --quiet bb-box-gpu-memory.timer
    systemctl start bb-box-gpu-memory.timer
    said "put back bb-box-gpu-memory.timer, which writes the report every 15 s when a GPU's memory moves"
    systemctl start bb-box-gpu-memory.service 2>/dev/null ||
      echo "setup-gpu.sh: bb-box-gpu-memory.timer is back, but its first run failed: see journalctl -u bb-box-gpu-memory; it needs NVIDIA's driver loaded" >&2
  fi
}

stop_helper_for_handover() {
  local why=$1
  if ! systemctl disable --now --quiet bb-box-gpu.service bb-box-gpu-boot.service; then
    echo "setup-gpu.sh: $why; bb-box-gpu could not be stopped either: see systemctl status bb-box-gpu" >&2
    exit 1
  fi
  if timer_present; then
    systemctl is-enabled --quiet bb-box-gpu-memory.timer 2>/dev/null || systemctl enable --quiet bb-box-gpu-memory.timer
    systemctl is-active --quiet bb-box-gpu-memory.timer || systemctl start bb-box-gpu-memory.timer
  else
    put_timer_back
  fi
  echo "setup-gpu.sh: $why, so bb-box-gpu is stopped and disabled, and bb-box-gpu-memory.timer writes the report: see journalctl -u bb-box-gpu" >&2
  exit 1
}

wanted_pools() {
  local pools="" pool
  if [ -f "$conf" ]; then
    pools=$(sed -n 's/^[[:space:]]*pools[[:space:]]\{1,\}//p' "$conf" | tr -s ' \t\n' ' ')
  fi
  local seen=" " out=""
  for pool in $pools $BBBOX_POOL; do
    [[ "$seen" == *" $pool "* ]] && continue
    seen="$seen$pool "
    out="$out${out:+ }$pool"
  done
  echo "$out"
}

install_helper() {
  [ -d "$root/proc/driver/nvidia/gpus" ] || die "no NVIDIA driver loaded: there is no GPU for the helper"
  command -v nvidia-smi >/dev/null || die "nvidia-smi is missing (it comes with NVIDIA's driver)"
  perl -MPVE::LXC -MPVE::LXC::Config -MPVE::QemuConfig -MPVE::Cluster -MPVE::INotify -e 1 2>/dev/null ||
    die "Proxmox's Perl modules do not load: run this on a Proxmox VE host"
  perl -c "$here/bb-box-gpu" >/dev/null 2>&1 || die "$here/bb-box-gpu does not compile with this host's Perl"
  local vmid
  vmid=$(report_vmid) || true
  [ -n "$vmid" ] || die "no VM named $report_name on this node: run setup-gpu-report.sh first, which makes the report's VM"

  install -d -m 0755 "$root/etc/bb-box" "$units" "$sbin"
  local pools wanted
  pools=$(wanted_pools)
  wanted=$(printf 'pools %s\nwrites off' "$pools")
  if [ ! -f "$conf" ] || [ "$(cat "$conf")" != "$wanted" ]; then
    (umask 077 && printf '%s\n' "$wanted" >"$conf.new")
    mv "$conf.new" "$conf"
    said "wrote $conf: pools $pools, writes off"
  fi
  if [ "$(stat -c '%u %a' "$conf")" != "0 600" ]; then
    chown root:root "$conf"
    chmod 0600 "$conf"
    said "made $conf root's alone"
  fi
  if [ ! -d "$state" ]; then
    install -d -m 0700 "$state"
    said "made $state for the ledger"
  fi

  local before=$changed
  changed=0
  put 0755 "$here/bb-box-gpu" "$program"
  put 0644 "$here/bb-box-gpu.service" "$units/bb-box-gpu.service"
  put 0644 "$here/bb-box-gpu-boot.service" "$units/bb-box-gpu-boot.service"
  local files_changed=$changed
  changed=$((before | files_changed))
  systemctl daemon-reload
  if ! systemctl is-enabled --quiet bb-box-gpu-boot.service 2>/dev/null; then
    systemctl enable --quiet bb-box-gpu-boot.service
    said "enabled bb-box-gpu-boot.service, the boot pass before pve-guests.service, with writes off"
  fi
  if ! systemctl is-enabled --quiet bb-box-gpu.service 2>/dev/null; then
    systemctl enable --quiet bb-box-gpu.service
    said "enabled bb-box-gpu.service, with writes off"
  fi

  local since
  if [ "$files_changed" = 1 ] || ! systemctl is-active --quiet bb-box-gpu.service; then
    since=$(date +%s)
    systemctl restart bb-box-gpu.service || stop_helper_for_handover "bb-box-gpu.service did not start"
    said "started bb-box-gpu.service, with writes off"
  else
    since=$(($(date +%s) - 90))
  fi
  wait_for_report "$vmid" "$since" ||
    stop_helper_for_handover "bb-box-gpu wrote no fresh report with writes off in VM $vmid within $report_wait s"

  if timer_present; then
    systemctl disable --now --quiet bb-box-gpu-memory.timer ||
      stop_helper_for_handover "bb-box-gpu-memory.timer could not be stopped"
    systemctl stop bb-box-gpu-memory.service ||
      stop_helper_for_handover "bb-box-gpu-memory.service could not be stopped"
    rm -f "$units/bb-box-gpu-memory.timer" "$units/bb-box-gpu-memory.service" "$sbin/bb-box-gpu-memory"
    systemctl daemon-reload
    said "stopped, disabled and removed bb-box-gpu-memory.timer and its service, as bb-box-gpu writes the report; VM $vmid and the token's PVEAuditor on it stay"
    wait_for_report "$vmid" "$since" ||
      stop_helper_for_handover "bb-box-gpu's report in VM $vmid did not come back within $report_wait s once the timer stopped"
  fi

  echo "setup-gpu.sh: VM $vmid's report: $report_line"
  [ "$changed" = 1 ] || echo "setup-gpu.sh: nothing changed"
}

remove_helper() {
  local unit stuck=""
  for unit in bb-box-gpu.service bb-box-gpu-boot.service; do
    if unit_known "$unit"; then
      systemctl disable --now --quiet "$unit" || stuck="$stuck $unit"
      rm -f "$units/$unit"
      said "stopped, disabled and removed $unit"
    fi
  done
  if [ -e "$program" ]; then
    rm -f "$program"
    said "removed $program"
  fi
  systemctl daemon-reload
  install -d -m 0755 "$units" "$sbin"
  put_timer_back
  [ -z "$stuck" ] || { echo "setup-gpu.sh: could not stop$stuck: see systemctl status" >&2; exit 1; }
  if [ "$changed" = 1 ]; then
    echo "setup-gpu.sh: kept $conf and the ledger in $state; no guest's device lines or tags were changed"
  else
    echo "setup-gpu.sh: nothing changed"
  fi
}

if [ "$mode" = install ]; then install_helper; else remove_helper; fi
