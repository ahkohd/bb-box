#!/bin/bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)

usage() {
  cat <<'EOF'
usage: setup-gpu.sh [--pool <name>]... [--writes off] [--downgrade]
                        install or upgrade bb-box-gpu, the host's GPU helper
       setup-gpu.sh --remove
                        remove it, and put back bb-box-gpu-memory.timer

  --pool <name>   serve this pool as well as BBBOX_POOL and the pools
                  /etc/bb-box/gpu.conf already lists; give it once per pool
  --writes off    keep writes off. This release runs the helper with writes
                  off only, a dry run, so --writes on is refused
  --downgrade     install this release over a newer one, and set aside a
                  ledger a newer protocol wrote, which the helper then
                  rebuilds from the guests

Install puts in the program, its two units and /etc/bb-box/gpu.conf, makes
the ledger's folder and starts the helper. It writes the GPU report in the
notes of VM bb-box-gpu-memory, as bb-box-gpu-memory.timer did, with its own
lines added. The timer is retired only once the helper has written a fresh,
healthy report; if it does not, the helper is stopped, the timer stays, and
this exits 1.

Upgrade is running a newer release's setup-gpu.sh. It replaces the program,
restarts the helper, and keeps gpu.conf and the ledger. If the new helper
writes no fresh, healthy report, the one before is put back as it was, with
its ledger, and this exits 1. It refuses an older release, or a ledger from a
newer protocol, without --downgrade.

Removal starts the timer, and waits for it to write the report, before it
stops the helper. It keeps gpu.conf and the ledger.

Whenever the helper is stopped, the timer is already running, so the report
always has a writer, even if this run is killed. A run that is interrupted
or fails part way leaves a writer running and says which. It keeps the
install from before it in /var/lib/bb-box-gpu/setup-backup, and the next run
puts that back if its helper does not report.

No run changes a guest's device lines or tags. Run as root on the Proxmox
host. Idempotent: a run with nothing to do says "nothing changed".
EOF
}

refuse_usage() {
  echo "setup-gpu.sh: $*" >&2
  usage >&2
  exit 2
}

pool_name_pattern='^[A-Za-z0-9][A-Za-z0-9._/-]*$'
mode=install
asked_pools=()
asked_writes=""
downgrade=0
while [ $# -gt 0 ]; do
  case "$1" in
    --remove) mode=remove ;;
    --pool)
      [ $# -ge 2 ] || refuse_usage "--pool needs a pool's name"
      [[ "$2" =~ $pool_name_pattern ]] || refuse_usage "'$2' cannot be a pool's name"
      asked_pools+=("$2")
      shift
      ;;
    --writes)
      [ $# -ge 2 ] || refuse_usage "--writes needs on or off"
      case "$2" in
        on | off) asked_writes=$2 ;;
        *) refuse_usage "--writes takes on or off, not '$2'" ;;
      esac
      shift
      ;;
    --downgrade) downgrade=1 ;;
    -h | --help) usage && exit 0 ;;
    *) refuse_usage "cannot read '$1'" ;;
  esac
  shift
done
if [ "$mode" = remove ] && { [ "${#asked_pools[@]}" -gt 0 ] || [ -n "$asked_writes" ] || [ "$downgrade" = 1 ]; }; then
  refuse_usage "--remove takes no other option"
fi
if [ "$asked_writes" = on ]; then
  echo "setup-gpu.sh: this release runs bb-box-gpu with writes off only, a dry run. Writes come on in a later release, once bb-box has marked its guests and a day of dry run with the markers shows no write the helper would make. Nothing was changed." >&2
  exit 1
fi

helper_heartbeat=60
asked_wait=${BBBOX_GPU_REPORT_WAIT:-}
if [ -n "$asked_wait" ] && ! [[ "$asked_wait" =~ ^[1-9][0-9]{0,3}$ ]]; then
  refuse_usage "BBBOX_GPU_REPORT_WAIT, from this process's environment, must be a whole number of seconds from 1 to 9999, not '$asked_wait'"
fi
first_pass_wait=${asked_wait:-30}
heartbeat_wait=${asked_wait:-$((helper_heartbeat + 15))}

. "$here/common.sh"
[[ "$BBBOX_POOL" =~ $pool_name_pattern ]] || die "BBBOX_POOL, '$BBBOX_POOL', cannot be a pool's name"

root=${BBBOX_ROOT:-}
units=$root/etc/systemd/system
sbin=$root/usr/local/sbin
program=$sbin/bb-box-gpu
conf=$root/etc/bb-box/gpu.conf
state=$root/var/lib/bb-box-gpu
ledger=$state/ledger
backup=$state/setup-backup
timer_state=$root/run/bb-box-gpu-memory
qemu=$root/etc/pve/qemu-server
report_name=bb-box-gpu-memory
helper_units=(bb-box-gpu.service bb-box-gpu-boot.service)
unhealthy_report='^#[[:space:]]*error (the ledger is protocol|the pass could not finish|cannot write the helper.s state)'
changed=0
report_line=""
serves_line=""
vmid=""
new_version=""
new_protocol=""
old_version=""
old_protocol=""
backup_made_now=0
set_aside=""
timer_was_there=0
phase=checking
settled=0

said() {
  echo "setup-gpu.sh: $*"
  changed=1
}

put_quietly() {
  local mode=$1 from=$2 to=$3
  if [ -f "$to" ] && cmp -s "$from" "$to" && [ "$(stat -c %a "$to")" = "${mode#0}" ]; then return 1; fi
  install -m "$mode" "$from" "$to.setup-new"
  mv -f "$to.setup-new" "$to"
}

put() {
  if put_quietly "$@"; then said "installed $3"; fi
}

copy_into_place() {
  cp -p "$1" "$2.setup-new"
  mv -f "$2.setup-new" "$2"
}

writers_now() {
  local running=()
  if systemctl is-active --quiet bb-box-gpu.service; then running+=("bb-box-gpu"); fi
  if systemctl is-active --quiet bb-box-gpu-memory.timer; then running+=("bb-box-gpu-memory.timer"); fi
  echo "${running[*]}"
}

keep_a_writer() {
  local status=$1 writers
  writers=$(writers_now)
  if [ -z "$writers" ]; then
    install_timer >/dev/null 2>&1
    systemctl start bb-box-gpu-memory.timer >/dev/null 2>&1
    run_timer_once
    writers=$(writers_now)
    [ -n "$writers" ] || { [ -e "$program" ] && start_helper >/dev/null 2>&1; }
    writers=$(writers_now)
    writers=${writers:+$writers, started again just now}
  fi
  if [ -n "$writers" ]; then
    echo "setup-gpu.sh: stopped part way, while $phase (exit status $status); the report is written by ${writers// / and }" >&2
  else
    echo "setup-gpu.sh: stopped part way, while $phase (exit status $status), and neither bb-box-gpu nor bb-box-gpu-memory.timer could be started, so nothing writes the report: see systemctl status bb-box-gpu bb-box-gpu-memory.timer" >&2
  fi
  if [ -d "$backup" ]; then
    echo "setup-gpu.sh: the install from before this run is kept in $backup; run setup-gpu.sh again, and it is put back if the helper does not report" >&2
  fi
}

on_exit() {
  local status=$?
  trap - EXIT
  trap '' INT TERM HUP
  set +e
  rm -f "$conf.new" "$conf.setup-new" "$program.setup-new" "$sbin/bb-box-gpu-memory.setup-new" "$units"/bb-box-gpu*.setup-new "$ledger.setup-new" "$backup/ledger.setup-new"
  if [ "$settled" = 0 ] && [ "$phase" != checking ]; then keep_a_writer "$status"; fi
  rm -rf "$backup.new"
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

version_of() {
  local name version word protocol
  read -r name version word protocol _ < <(perl "$1" --version 2>/dev/null) || true
  if [ "${name:-}" = bb-box-gpu ] && [ "${word:-}" = protocol ] &&
    [[ "${version:-}" =~ ^[0-9]+(\.[0-9]+)*$ ]] && [[ "${protocol:-}" =~ ^[0-9]+$ ]]; then
    echo "$version $protocol"
  fi
}

newer_than() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]
}

ledger_protocol() {
  [ -f "$ledger" ] || return 0
  perl -MJSON::PP -e '
    local $/;
    open(my $fh, "<", $ARGV[0]) or exit 0;
    my $data = eval { JSON::PP->new->decode(<$fh>) };
    print $data->{protocol} if ref($data) eq "HASH" && defined $data->{protocol} && $data->{protocol} =~ /^\d+$/;
  ' "$ledger"
}

report_vmid() {
  local found
  found=$(grep -lx "name: $report_name" "$qemu"/*.conf 2>/dev/null | head -1) || true
  [ -n "$found" ] && basename "$found" .conf
}

description_text() {
  grep '^#' "$qemu/$1.conf" 2>/dev/null || true
}

line_of() {
  sed -n "s/^#[[:space:]]*\($2\)[[:space:]]*\$/\1/p" <<<"$1" | head -1
}

report_is_fresh() {
  local since=$1 version=$2 protocol=$3 unlike=${4:-} snapshot at helper
  snapshot=$(description_text "$vmid")
  at=$(line_of "$snapshot" 'at [0-9]\{1,\}')
  at=${at#at }
  helper=$(line_of "$snapshot" 'helper bb-box-gpu .*')
  if [[ "$helper" == "helper bb-box-gpu $version protocol $protocol writes off "* ]] && [ "${at:-0}" -ge "$since" ] &&
    { [ -z "$unlike" ] || [ "$snapshot" != "$unlike" ]; } && ! grep -Eq "$unhealthy_report" <<<"$snapshot"; then
    report_line=$helper
    serves_line=$(line_of "$snapshot" 'serves .*')
    return 0
  fi
  return 1
}

wait_for_report() {
  local seconds=$1 tries=0
  shift
  while [ "$tries" -lt $((seconds * 4)) ]; do
    report_is_fresh "$@" && return 0
    sleep 0.25
    tries=$((tries + 1))
  done
  return 1
}

start_helper() {
  systemctl reset-failed bb-box-gpu.service >/dev/null 2>&1 || true
  systemctl start bb-box-gpu.service
}

unit_known() {
  [ -n "$(systemctl list-unit-files --no-legend "$1" 2>/dev/null)" ] || [ -e "$units/$1" ]
}

timer_present() {
  unit_known bb-box-gpu-memory.timer || [ -e "$sbin/bb-box-gpu-memory" ]
}

timer_files_changed=0

install_timer() {
  local before=$changed
  changed=0
  install -d -m 0755 "$units" "$sbin"
  put 0755 "$here/bb-box-gpu-memory" "$sbin/bb-box-gpu-memory"
  put 0644 "$here/bb-box-gpu-memory.service" "$units/bb-box-gpu-memory.service"
  put 0644 "$here/bb-box-gpu-memory.timer" "$units/bb-box-gpu-memory.timer"
  timer_files_changed=$changed
  changed=$((before | timer_files_changed))
  systemctl daemon-reload
  systemctl is-enabled --quiet bb-box-gpu-memory.timer 2>/dev/null || systemctl enable --quiet bb-box-gpu-memory.timer
}

run_timer_once() {
  rm -f "$timer_state"
  systemctl reset-failed bb-box-gpu-memory.service >/dev/null 2>&1 || true
  systemctl start bb-box-gpu-memory.service >/dev/null 2>&1 && [ -s "$timer_state" ]
}

start_timer() {
  if [ "$timer_files_changed" = 0 ] && systemctl is-active --quiet bb-box-gpu-memory.timer; then return 0; fi
  systemctl start bb-box-gpu-memory.timer
  said "put back bb-box-gpu-memory.timer, which writes the report every 15 s when a GPU's memory moves"
}

start_fallback_timer() {
  systemctl is-active --quiet bb-box-gpu-memory.timer && return 0
  phase="starting bb-box-gpu-memory.timer, to write the report while bb-box-gpu restarts"
  local before=$changed
  install_timer >/dev/null
  changed=$before
  systemctl start bb-box-gpu-memory.timer
  said "started bb-box-gpu-memory.timer while bb-box-gpu restarts, so the report has a writer throughout"
}

retire_timer() {
  phase="retiring bb-box-gpu-memory.timer"
  systemctl disable --now --quiet bb-box-gpu-memory.timer ||
    hand_over_to_timer "bb-box-gpu-memory.timer could not be stopped"
  systemctl stop bb-box-gpu-memory.service ||
    hand_over_to_timer "bb-box-gpu-memory.service could not be stopped"
  rm -f "$units/bb-box-gpu-memory.timer" "$units/bb-box-gpu-memory.service" "$sbin/bb-box-gpu-memory"
  systemctl daemon-reload
}

finish() {
  rm -rf "$backup"
  settled=1
}

hand_over_to_timer() {
  local why=$1 stopped=1 wrote=1
  phase="handing the report to bb-box-gpu-memory.timer"
  install_timer
  if ! systemctl start bb-box-gpu-memory.timer || ! systemctl is-active --quiet bb-box-gpu-memory.timer; then
    finish
    echo "setup-gpu.sh: $why, and bb-box-gpu-memory.timer could not be started, so bb-box-gpu is left as it is: see systemctl status bb-box-gpu bb-box-gpu-memory.timer" >&2
    exit 1
  fi
  systemctl disable --now --quiet "${helper_units[@]}" || stopped=0
  run_timer_once || wrote=0
  finish
  local first=""
  [ "$wrote" = 1 ] || first="; its first run wrote no report: see journalctl -u bb-box-gpu-memory"
  if [ "$stopped" = 0 ]; then
    echo "setup-gpu.sh: $why; bb-box-gpu could not be stopped either, and bb-box-gpu-memory.timer writes the report too$first: see systemctl status bb-box-gpu" >&2
    exit 1
  fi
  echo "setup-gpu.sh: $why, so bb-box-gpu is stopped and disabled, and bb-box-gpu-memory.timer writes the report$first: see journalctl -u bb-box-gpu" >&2
  exit 1
}

begin_backup() {
  local installed=$1
  if [ -d "$backup" ]; then
    echo "setup-gpu.sh: an earlier run did not finish, so the install from before it, kept in $backup, is the one a rollback puts back"
  else
    rm -rf "$backup.new"
    install -d -m 0700 "$backup.new"
    local file
    for file in "$program" "$units/bb-box-gpu.service" "$units/bb-box-gpu-boot.service" "$conf" "$ledger"; do
      [ ! -e "$file" ] || cp -p "$file" "$backup.new/$(basename "$file")"
    done
    printf '%s\n' "$installed" >"$backup.new/installed"
    printf '%s\n' "$timer_was_there" >"$backup.new/timer-before"
    sync "$backup.new"/* "$backup.new"
    mv "$backup.new" "$backup"
    sync "$state"
    backup_made_now=1
  fi
  read -r old_version old_protocol <"$backup/installed" || true
  if [ -f "$backup/timer-before" ]; then read -r timer_was_there <"$backup/timer-before" || true; fi
  if [ ! -e "$backup/bb-box-gpu" ]; then old_version="" old_protocol=""; fi
}

keep_stopped_helpers_ledger() {
  if [ "$backup_made_now" = 1 ] && [ -e "$ledger" ]; then
    cp -p "$ledger" "$backup/ledger.setup-new"
    sync "$backup/ledger.setup-new"
    mv -f "$backup/ledger.setup-new" "$backup/ledger"
  fi
}

ledger_note=""

put_previous_back() {
  phase="putting back bb-box-gpu $old_version"
  copy_into_place "$backup/bb-box-gpu" "$program"
  local unit
  for unit in "${helper_units[@]}"; do
    if [ -e "$backup/$unit" ]; then copy_into_place "$backup/$unit" "$units/$unit"; fi
  done
  if [ -e "$backup/gpu.conf" ]; then copy_into_place "$backup/gpu.conf" "$conf"; fi
  local written_now
  written_now=$(ledger_protocol)
  if [ -n "$set_aside" ] || { [ -n "$written_now" ] && [ "$written_now" -gt "$old_protocol" ]; }; then
    if [ -e "$ledger" ]; then
      local kept_as
      kept_as=$ledger.from-$new_version-$(date +%s)
      mv "$ledger" "$kept_as"
      ledger_note="; the ledger bb-box-gpu $new_version wrote is kept as $kept_as"
    fi
    if [ -n "$set_aside" ]; then
      mv "$set_aside" "$ledger"
    elif [ -e "$backup/ledger" ]; then
      copy_into_place "$backup/ledger" "$ledger"
    fi
  fi
  systemctl daemon-reload
}

roll_back() {
  local why=$1
  if [ -z "$old_version" ]; then hand_over_to_timer "$why"; fi
  start_fallback_timer
  phase="stopping bb-box-gpu $new_version"
  systemctl stop bb-box-gpu.service || true
  put_previous_back
  phase="starting bb-box-gpu $old_version again"
  local since before
  since=$(date +%s)
  before=$(description_text "$vmid")
  if ! start_helper || ! wait_for_report "$heartbeat_wait" "$since" "$old_version" "$old_protocol" "$before"; then
    hand_over_to_timer "$why, and bb-box-gpu $old_version, put back, wrote no fresh, healthy report either"
  fi
  if [ "$timer_was_there" = 0 ] && timer_present; then
    retire_timer
    wait_for_report "$heartbeat_wait" "$since" "$old_version" "$old_protocol" ||
      hand_over_to_timer "$why, and bb-box-gpu $old_version's report did not come back once the timer stopped"
  fi
  finish
  echo "setup-gpu.sh: $why, so bb-box-gpu $old_version is back as it was, with its settings and ledger$ledger_note: see journalctl -u bb-box-gpu" >&2
  exit 1
}

wanted_pools() {
  local pools="" pool seen=" " out=""
  if [ -f "$conf" ]; then
    pools=$(sed -n 's/^[[:space:]]*pools[[:space:]]\{1,\}//p' "$conf" | tr -s ' \t\n' ' ')
  fi
  for pool in $pools "$BBBOX_POOL" "${asked_pools[@]}"; do
    [[ "$seen" == *" $pool "* ]] && continue
    seen="$seen$pool "
    out="$out${out:+ }$pool"
  done
  echo "$out"
}

pool_known() {
  grep -q "^pool:$1:" "$root/etc/pve/user.cfg" 2>/dev/null
}

install_helper() {
  [ -d "$root/proc/driver/nvidia/gpus" ] || die "no NVIDIA driver loaded: there is no GPU for the helper"
  command -v nvidia-smi >/dev/null || die "nvidia-smi is missing (it comes with NVIDIA's driver)"
  perl -MPVE::LXC -MPVE::LXC::Config -MPVE::QemuConfig -MPVE::Cluster -MPVE::INotify -e 1 2>/dev/null ||
    die "Proxmox's Perl modules do not load: run this on a Proxmox VE host"
  perl -c "$here/bb-box-gpu" >/dev/null 2>&1 || die "$here/bb-box-gpu does not compile with this host's Perl"
  local release installed="" current_version=""
  release=$(version_of "$here/bb-box-gpu")
  [ -n "$release" ] || die "$here/bb-box-gpu does not say its version"
  read -r new_version new_protocol <<<"$release"
  if [ -e "$program" ]; then installed=$(version_of "$program"); fi
  if [ -n "$installed" ]; then read -r current_version _ <<<"$installed"; fi
  if [ -n "$current_version" ] && newer_than "$current_version" "$new_version" && [ "$downgrade" = 0 ]; then
    die "bb-box-gpu $current_version is installed, newer than this release's $new_version: run the newer release's setup-gpu.sh, or give --downgrade to install $new_version. Nothing was changed."
  fi
  local written_by
  written_by=$(ledger_protocol)
  if [ -n "$written_by" ] && [ "$written_by" -gt "$new_protocol" ] && [ "$downgrade" = 0 ]; then
    die "the ledger, $ledger, was written by protocol $written_by, newer than this release's protocol $new_protocol: run the newer release's setup-gpu.sh, or give --downgrade to set the ledger aside, which bb-box-gpu $new_version then rebuilds from the guests. Nothing was changed."
  fi
  vmid=$(report_vmid) || true
  [ -n "$vmid" ] || die "no VM named $report_name on this node: run setup-gpu-report.sh first, which makes the report's VM"
  if timer_present; then timer_was_there=1; fi

  phase="keeping a copy of the install before this run"
  install -d -m 0755 "$root/etc/bb-box" "$units" "$sbin"
  if [ ! -d "$state" ]; then
    install -d -m 0700 "$state"
    said "made $state for the ledger"
  fi
  begin_backup "$installed"

  phase="writing gpu.conf"
  local pools wanted pool
  pools=$(wanted_pools)
  wanted=$(printf 'pools %s\nwrites off' "$pools")
  if [ ! -f "$conf" ] || [ "$(cat "$conf")" != "$wanted" ]; then
    local was_on=""
    if [ -f "$conf" ] && grep -Eq '^[[:space:]]*writes[[:space:]]+on[[:space:]]*$' "$conf"; then
      was_on=" (it said writes on, which this release does not run)"
    fi
    (umask 077 && printf '%s\n' "$wanted" >"$conf.new")
    mv "$conf.new" "$conf"
    said "wrote $conf: pools $pools, writes off$was_on"
    for pool in $pools; do
      pool_known "$pool" || echo "setup-gpu.sh: pool $pool is not in /etc/pve/user.cfg yet; the helper serves it once it is"
    done
  fi
  if [ "$(stat -c '%u %a' "$conf")" != "0 600" ]; then
    chown root:root "$conf"
    chmod 0600 "$conf"
    said "made $conf root's alone"
  fi

  phase="replacing the program and its units"
  put 0755 "$here/bb-box-gpu" "$program"
  put 0644 "$here/bb-box-gpu.service" "$units/bb-box-gpu.service"
  put 0644 "$here/bb-box-gpu-boot.service" "$units/bb-box-gpu-boot.service"
  systemctl daemon-reload
  if ! systemctl is-enabled --quiet bb-box-gpu-boot.service 2>/dev/null; then
    systemctl enable --quiet bb-box-gpu-boot.service
    said "enabled bb-box-gpu-boot.service, the boot pass before pve-guests.service, with writes off"
  fi
  if ! systemctl is-enabled --quiet bb-box-gpu.service 2>/dev/null; then
    systemctl enable --quiet bb-box-gpu.service
    said "enabled bb-box-gpu.service, with writes off"
  fi

  local since ledger_too_new=0 unproven=0
  if [ -n "$written_by" ] && [ "$written_by" -gt "$new_protocol" ]; then ledger_too_new=1; fi
  if [ "$backup_made_now" = 0 ] && ! report_is_fresh $(($(date +%s) - 90)) "$new_version" "$new_protocol"; then unproven=1; fi
  if [ "$changed" = 1 ] || [ "$ledger_too_new" = 1 ] || [ "$unproven" = 1 ] || ! systemctl is-active --quiet bb-box-gpu.service; then
    start_fallback_timer
    phase="stopping bb-box-gpu"
    systemctl stop bb-box-gpu.service || roll_back "bb-box-gpu.service could not be stopped"
    keep_stopped_helpers_ledger
    if [ "$ledger_too_new" = 1 ] && [ -e "$ledger" ]; then
      phase="setting the ledger aside"
      set_aside=$ledger.protocol-$written_by-$(date +%s)
      mv "$ledger" "$set_aside"
      said "set aside the ledger, written by protocol $written_by, as $set_aside: bb-box-gpu $new_version speaks protocol $new_protocol and rebuilds it from the guests"
    fi
    phase="starting bb-box-gpu $new_version"
    since=$(date +%s)
    local before
    before=$(description_text "$vmid")
    start_helper || roll_back "bb-box-gpu $new_version did not start"
    if [ -n "$old_version" ] && [ "$old_version" != "$new_version" ]; then
      said "restarted bb-box-gpu.service on $new_version, which was $old_version, with writes off; gpu.conf and the ledger are kept"
    else
      said "started bb-box-gpu.service, with writes off"
    fi
    phase="waiting for bb-box-gpu $new_version's report"
    wait_for_report "$first_pass_wait" "$since" "$new_version" "$new_protocol" "$before" ||
      roll_back "bb-box-gpu $new_version wrote no fresh, healthy report with writes off in VM $vmid within $first_pass_wait s"
  else
    phase="reading bb-box-gpu's report"
    since=$(($(date +%s) - 90))
    wait_for_report "$heartbeat_wait" "$since" "$new_version" "$new_protocol" ||
      hand_over_to_timer "bb-box-gpu wrote no fresh, healthy report with writes off in VM $vmid within $heartbeat_wait s"
  fi

  if timer_present; then
    retire_timer
    if [ "$timer_was_there" = 1 ]; then
      said "stopped, disabled and removed bb-box-gpu-memory.timer and its service, as bb-box-gpu writes the report; VM $vmid and the token's PVEAuditor on it stay"
    else
      said "stopped and removed bb-box-gpu-memory.timer again, as bb-box-gpu writes the report"
    fi
    phase="waiting for bb-box-gpu's report once the timer stopped"
    wait_for_report "$first_pass_wait" "$since" "$new_version" "$new_protocol" ||
      hand_over_to_timer "bb-box-gpu's report in VM $vmid did not come back within $first_pass_wait s once the timer stopped"
  fi
  finish

  echo "setup-gpu.sh: VM $vmid's report: $report_line"
  [ -z "$serves_line" ] || echo "setup-gpu.sh: VM $vmid's report: $serves_line"
  if [[ "$report_line" == *" untested" ]]; then
    echo "setup-gpu.sh: this release was not tested on the pve-container installed here, so its helper would change no guest on this host even with writes on"
  fi
  [ "$changed" = 1 ] || echo "setup-gpu.sh: nothing changed"
}

remove_helper() {
  phase="putting bb-box-gpu-memory.timer back"
  install_timer
  local helper_ran=0 unit stuck=""
  if systemctl is-active --quiet bb-box-gpu.service; then helper_ran=1; fi
  if [ "$helper_ran" = 1 ]; then
    if ! systemctl start bb-box-gpu-memory.timer || ! run_timer_once; then
      settled=1
      echo "setup-gpu.sh: bb-box-gpu-memory.timer is in place, but it could not be started or wrote no report: see journalctl -u bb-box-gpu-memory; it needs nvidia-smi to work. So bb-box-gpu was not stopped, and nothing of it was removed; run setup-gpu.sh --remove again once the timer can write the report" >&2
      exit 1
    fi
    said "put back bb-box-gpu-memory.timer, which writes the report every 15 s when a GPU's memory moves; it wrote the report before bb-box-gpu stopped"
  fi
  phase="stopping and removing bb-box-gpu"
  for unit in "${helper_units[@]}"; do
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
  [ "$helper_ran" = 1 ] || start_timer
  run_timer_once ||
    echo "setup-gpu.sh: bb-box-gpu-memory.timer runs, but its first run once bb-box-gpu was gone wrote no report: see journalctl -u bb-box-gpu-memory; it needs nvidia-smi to work" >&2
  settled=1
  [ -z "$stuck" ] || { echo "setup-gpu.sh: could not stop$stuck: see systemctl status" >&2; exit 1; }
  if [ "$changed" = 1 ]; then
    echo "setup-gpu.sh: kept $conf and the ledger in $state; no guest's device lines or tags were changed"
  else
    echo "setup-gpu.sh: nothing changed"
  fi
}

if [ "$mode" = install ]; then install_helper; else remove_helper; fi
