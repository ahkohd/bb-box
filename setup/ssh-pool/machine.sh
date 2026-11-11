#!/bin/sh
# bb-box's helper on an SSH pool machine. bb-box's admin user runs it through
# sudo, and runs nothing else as root: it claims the machine for a box,
# resets the machine afterwards and reports its state. setup.sh installs it
# as /usr/local/libexec/bb-box/machine.
#
#   machine status
#   machine claim <generation> [docker]     stdin: install, box, thread, name, kind, created, key
#   machine release <generation> [machine]  stdin: install, and box unless the box is not known
#   machine reset [machine]                 stdin: install, or nothing when an operator runs it
#   machine init
#   machine version
#
# Input on stdin is one name=value per line. The state lives in
# /var/lib/bb-box, which a whole-machine reset must keep:
#
#   generation  completed resets, written last by each reset
#   owner       the box that holds the machine; made with ln, so one claim wins
#   resetting   the owner marker, renamed when its reset starts
#   restore/    a whole-machine reset that has started; its "restarting" file
#               says the hook restarts the machine to finish
#   restore.failed/  the last whole-machine reset that failed, with its log
#
# Each box gets a new user, bbx-<generation>, whose UID and GID are 70000
# plus the generation modulo 10000, so an ID comes back only after 10000
# boxes. A machine that is itself an unprivileged container may map only IDs
# 0 to 65535; there they are 60706 plus the generation modulo 478, between
# systemd's greeter users (60578 to 60705) and its dynamic users (61184 to
# 65519). A reset ends the user's sessions and processes, and removes its
# linger, crontab, at jobs, SysV IPC objects, sudo rule, every file it owns
# on a local filesystem, and the user. "machine" first runs the operator's
# reset-machine command, which restores the whole machine. A hook that
# restarts the machine to finish touches $BB_BOX_RESTARTING first.
#
# Exit codes: 0 done; 1 failed, with the reason on stderr; 2 usage; 3 another
# box holds the machine; 4 not this box's, so release does nothing; 5 not
# clean, with the reason on stderr; 6 the generation moved on; 10 the
# whole-machine reset is still running.

set -u
umask 022
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
LC_ALL=C
export PATH LC_ALL

VERSION=1
STATE=/var/lib/bb-box
HOOK=/usr/local/libexec/bb-box/reset-machine
SKEL=/etc/bb-box/skel
PREFIX=bbx-
HOMES=/home
SNAPSHOT_PROBE=1
SNAPSHOT_HOOK=/usr/local/libexec/bb-box/snapshot-machine
SNAPSHOT_HOOK_SECONDS=30
SNAPSHOT_HOOK_GRACE_SECONDS=2
SNAPSHOT_HOOK_OUT=$STATE/snapshot-hook.out.$$
SNAPSHOT_HOOK_ERR=$STATE/snapshot-hook.err
SNAPSHOT_REPORT=$STATE/snapshots
SNAPSHOT_TRIALS=$HOMES/.bb-box-snapshot-trials
SNAPSHOT_TRIAL=$SNAPSHOT_TRIALS/$$
# Container storage is never swept: its files belong to the containers' users.
SKIP="/proc /sys /var/lib/docker /var/lib/containerd /var/lib/containers /var/lib/lxc /var/lib/lxd /var/snap/lxd /var/lib/incus /var/lib/machines /var/lib/kubelet"

quit() {
  code=$1
  shift
  printf '%s\n' "$*" >&2
  exit "$code"
}
fail() { quit 1 "$@"; }
field() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -n 1; }
# Changes when the machine starts again. A container that restarts keeps the kernel's boot ID, but its PID 1 starts later.
boot_id() {
  printf '%s-%s\n' "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)" "$(sed 's/.*) //' /proc/1/stat 2>/dev/null | cut -d' ' -f20)"
}
generation() { cat "$STATE/generation" 2>/dev/null; }
number() { case ${1:-} in '' | *[!0-9]*) return 1 ;; esac; }
box_uid() { number "${1:-}" && { { [ "$1" -ge 70000 ] && [ "$1" -lt 80000 ]; } || { [ "$1" -ge 60706 ] && [ "$1" -lt 61184 ]; }; }; }
# Writes stdin to a file in one step.
put() { cat >"$1.new.$$" && mv -f "$1.new.$$" "$1"; }

lock() {
  mkdir -p "$STATE"
  exec 9>"$STATE/lock"
  flock "$@" 9 || quit 3 "Another bb-box command holds the machine's lock."
}

# True when the user namespace maps IDs $2 to $2 + $3 - 1 in map file $1, or the kernel has no maps.
mapped() {
  [ -r "$1" ] || return 0
  awk -v lo="$2" -v hi="$(($2 + $3 - 1))" '$1 <= lo && hi < $1 + $3 { found = 1 } END { exit !found }' "$1"
}

# Sets the IDs box users take: id_base to id_base + id_span - 1.
id_range() {
  if mapped /proc/self/uid_map 70000 10000 && mapped /proc/self/gid_map 70000 10000; then
    id_base=70000 id_span=10000
  else
    id_base=60706 id_span=478
  fi
}

# Reads name=value lines from stdin. "optional" allows no input, and reads none from a terminal.
read_input() {
  install='' box='' thread='' name='' kind='' created='' key=''
  if [ "${1:-}" = optional ] && [ -t 0 ]; then return 0; fi
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      install=*) install=${line#install=} ;;
      box=*) box=${line#box=} ;;
      thread=*) thread=${line#thread=} ;;
      name=*) name=${line#name=} ;;
      kind=*) kind=${line#kind=} ;;
      created=*) created=${line#created=} ;;
      key=*) key=${line#key=} ;;
      '') ;;
      *) quit 2 "Unknown input: ${line%%=*}." ;;
    esac
  done
  [ -n "$install" ] || [ "${1:-}" = optional ] || quit 2 "The input needs install=."
}

# What an earlier box left, one line each. Empty on a clean machine.
dirt() {
  getent passwd | cut -d: -f1 | grep "^$PREFIX" | sed 's/^/user /'
  for path in /home/"$PREFIX"* /etc/sudoers.d/"$PREFIX"* /var/lib/systemd/linger/"$PREFIX"* \
    /var/spool/cron/crontabs/"$PREFIX"* /var/spool/cron/"$PREFIX"*; do
    [ -e "$path" ] && echo "$path"
  done
  [ ! -e "$STATE/restore" ] || echo "$STATE/restore, from a whole-machine reset that did not finish"
  ipc_orphans | sed 's/^/a System V IPC object of removed UID /'
}

# System V IPC objects, one "<type> <id> <owner>" line each. An owner with no user shows as its UID.
ipc_objects() {
  command -v ipcs >/dev/null 2>&1 || return 0
  for t in m q s; do
    ipcs -"$t" 2>/dev/null | awk -v t="$t" '$1 ~ /^0x/ { print t, $2, $3 }'
  done
}

# The UIDs in the box users' range that own IPC objects but no longer have a user.
ipc_orphans() {
  id_range
  ipc_objects | awk -v lo="$id_base" -v hi="$((id_base + id_span))" '$3 ~ /^[0-9]+$/ && $3 >= lo && $3 < hi { print $3 }' | sort -u
}

# Removes the IPC objects of a user and UID. Root in a container may not
# have CAP_SYS_ADMIN, which removing another's object needs, so it falls
# back to removing them as their owner.
remove_ipc() {
  ipc_objects | while read -r t id owner; do
    [ "$owner" = "$1" ] || [ "$owner" = "$2" ] || continue
    ipcrm -"$t" "$id" 2>/dev/null ||
      setpriv --reuid="$2" --regid="$2" --clear-groups ipcrm -"$t" "$id" 2>/dev/null
  done
}

# The CPUs a process may use: those its CPU set allows, as nproc counts, and
# no more than its cgroup's CPU quota. A machine that is a container with a CPU
# limit has one or the other, and online CPUs would count the host's.
cores() (
  n=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null) || n=
  if [ -n "$n" ] && [ -r /sys/fs/cgroup/cpu.max ] && read -r quota period </sys/fs/cgroup/cpu.max && [ "$quota" != max ]; then
    q=$(((quota + period - 1) / period))
    [ "$q" -ge "$n" ] || n=$q
  fi
  echo "$n"
)

# The memory a process may use, in MiB: the machine's, and no more than its
# cgroup's memory limit. In a container with a memory limit, /proc/meminfo
# shows the host's.
memory() (
  m=$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo 2>/dev/null)
  if [ -n "$m" ] && [ -r /sys/fs/cgroup/memory.max ] && read -r limit </sys/fs/cgroup/memory.max && [ "$limit" != max ]; then
    l=$((limit / 1048576))
    [ "$l" -ge "$m" ] || m=$l
  fi
  echo "$m"
)

status() {
  echo "helper=$VERSION"
  echo "arch=$(uname -m)"
  echo "boot=$(boot_id)"
  echo "generation=$(generation)"
  if [ -e "$STATE/owner" ]; then
    marker=owner
  elif [ -e "$STATE/resetting" ]; then
    marker=resetting
  else
    marker=none
  fi
  echo "marker=$marker"
  [ "$marker" = none ] || sed 's/^/marker./' "$STATE/$marker"
  [ -x "$HOOK" ] && echo hook=1 || echo hook=0
  command -v docker >/dev/null 2>&1 && echo docker=1 || echo docker=0
  [ -d /run/systemd/system ] && echo systemd=1 || echo systemd=0
  # The machine's size: the cores and memory in MiB a box can use, and free disk under /home in GiB.
  echo "cores=$(cores)"
  echo "memory=$(memory)"
  echo "disk=$(df -Pk /home 2>/dev/null | awk 'NR == 2 { print int($4 / 1048576) }')"
  # Whether the machine is itself virtual, as a VPS is: systemd-detect-virt's word, "none" on bare metal.
  echo "virt=$(systemd-detect-virt 2>/dev/null)"
  missing=''
  for tool in sh tar flock setsid useradd userdel groupadd groupdel usermod pgrep pkill find getent; do
    command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
  done
  command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || missing="$missing curl-or-wget"
  echo "missing=${missing# }"
  # What BB's installer and a box's GitHub access need: Node.js with npm, git and gh.
  echo "node=$(node --version 2>/dev/null | head -n 1)"
  lacks=''
  for tool in npm git gh; do
    command -v "$tool" >/dev/null 2>&1 || lacks="$lacks $tool"
  done
  echo "lacks=${lacks# }"
  if [ "$marker" = none ]; then echo "dirty=$(dirt | head -n 1)"; else echo dirty=; fi
  [ ! -r "$SNAPSHOT_REPORT" ] || cat "$SNAPSHOT_REPORT"
}

filesystem_of() { findmnt -n -o FSTYPE -T "$1" 2>/dev/null || stat -f -c %T "$1" 2>/dev/null; }
free_kib() { df -Pk "$1" 2>/dev/null | awk 'NR == 2 { print $4 }'; }
zfs_dataset_mounted_at() { zfs list -H -o name,mountpoint 2>/dev/null | awk -v at="$1" '$2 == at { print $1; exit }'; }
last_line() { printf '%s\n' "$1" | tail -n 1; }

left_of_trial() {
  left=''
  for object in "$1/snapshot" "$1/subvolume" "$1"; do
    [ ! -e "$object" ] || left="$left $object"
  done
  printf '%s\n' "${left# }"
}

remove_trial() {
  for subvolume in "$1/snapshot" "$1/subvolume"; do
    [ ! -e "$subvolume" ] || btrfs subvolume delete "$subvolume" >/dev/null 2>&1
  done
  rmdir "$1" 2>/dev/null
  left_of_trial "$1"
}

trials_folder_is_the_helpers() {
  [ -d "$SNAPSHOT_TRIALS" ] || mkdir -m 700 "$SNAPSHOT_TRIALS" 2>/dev/null
  [ -d "$SNAPSHOT_TRIALS" ] && [ ! -L "$SNAPSHOT_TRIALS" ] && [ "$(stat -c %u "$SNAPSHOT_TRIALS" 2>/dev/null)" = 0 ]
}

abandoned_trials() {
  for trial in "$SNAPSHOT_TRIALS"/*; do
    probe=${trial##*/}
    [ -d "$trial" ] && number "$probe" && ! kill -0 "$probe" 2>/dev/null && printf '%s\n' "$trial"
  done
}

remove_abandoned_trials() {
  for trial in $(abandoned_trials); do
    left=$(remove_trial "$trial")
    [ -z "$left" ] || trial_left="$trial_left $left"
  done
}

try_btrfs_trial() {
  if ! mkdir "$SNAPSHOT_TRIAL" 2>/dev/null; then
    trial_failed="the helper could not make $SNAPSHOT_TRIAL"
  elif ! said=$(btrfs subvolume create "$SNAPSHOT_TRIAL/subvolume" 2>&1); then
    trial_failed=$(last_line "$said")
  elif ! said=$(btrfs subvolume snapshot -r "$SNAPSHOT_TRIAL/subvolume" "$SNAPSHOT_TRIAL/snapshot" 2>&1); then
    trial_failed=$(last_line "$said")
  fi
}

btrfs_trial() {
  trial_failed='' trial_left=''
  if ! trials_folder_is_the_helpers; then
    trial_failed="$SNAPSHOT_TRIALS is not a folder of root's own: remove it"
    return 1
  fi
  remove_abandoned_trials
  try_btrfs_trial
  trial_left=$(printf '%s %s\n' "$trial_left" "$(remove_trial "$SNAPSHOT_TRIAL")" | sed 's/^ *//; s/ *$//')
  [ -z "$trial_failed" ] && [ -z "$trial_left" ]
}

trial_left_words() {
  printf 'the helper could not remove its trial, which leaves %s: as root, delete each subvolume there with btrfs subvolume delete, then its folder with rmdir' "$(printf '%s\n' "$trial_left" | sed 's/ /, /g')"
}

home_snapshots_on_btrfs() {
  if ! command -v btrfs >/dev/null 2>&1; then
    printf 'snapshot.home=no\nsnapshot.home.why=box homes are on btrfs under %s, but the btrfs tool is missing: install btrfs-progs\n' "$HOMES"
  elif btrfs_trial; then
    printf 'snapshot.home=yes\nsnapshot.home.how=btrfs\n'
  elif [ -n "$trial_left" ]; then
    printf 'snapshot.home=no\nsnapshot.home.why=box homes are on btrfs under %s, but %s\nsnapshot.left=%s\n' "$HOMES" "$(trial_left_words)" "$trial_left"
  else
    printf 'snapshot.home=no\nsnapshot.home.why=box homes are on btrfs under %s, but a trial subvolume failed: %s\n' "$HOMES" "$trial_failed"
  fi
}

home_snapshots_on_zfs() {
  if ! command -v zfs >/dev/null 2>&1; then
    printf 'snapshot.home=no\nsnapshot.home.why=box homes are on ZFS under %s, but the zfs tool is missing\n' "$HOMES"
    return
  fi
  dataset=$(zfs_dataset_mounted_at "$HOMES")
  if [ -n "$dataset" ]; then
    printf 'snapshot.home=yes\nsnapshot.home.how=zfs\nsnapshot.zfs.dataset=%s\n' "$dataset"
  else
    printf 'snapshot.home=no\nsnapshot.home.why=box homes are on ZFS under %s, but no dataset is mounted there\n' "$HOMES"
  fi
}

home_snapshots() {
  case $(filesystem_of "$HOMES") in
    btrfs) home_snapshots_on_btrfs ;;
    zfs) home_snapshots_on_zfs ;;
    *) echo snapshot.home=no ;;
  esac
}

hook_running() { kill -0 "$1" 2>/dev/null || kill -s 0 -- "-$1" 2>/dev/null; }

end_hook() {
  kill -s TERM -- "-$1" 2>/dev/null
  grace=$((SNAPSHOT_HOOK_GRACE_SECONDS * 10))
  while [ "$grace" -gt 0 ] && hook_running "$1"; do
    sleep 0.1
    grace=$((grace - 1))
  done
  kill -s KILL -- "-$1" 2>/dev/null
}

describe_within_deadline() {
  setsid "$SNAPSHOT_HOOK" describe </dev/null >"$SNAPSHOT_HOOK_OUT" 2>"$SNAPSHOT_HOOK_ERR" 9>&- &
  hook=$!
  sleep "$SNAPSHOT_HOOK_SECONDS" </dev/null >/dev/null 2>&1 9>&- &
  deadline=$!
  while hook_running "$hook" && kill -0 "$deadline" 2>/dev/null; do sleep 0.1; done
  hook_timed_out=no
  if hook_running "$hook"; then
    hook_timed_out=yes
    end_hook "$hook"
  fi
  kill "$deadline" 2>/dev/null
  wait "$deadline" 2>/dev/null
  wait "$hook"
  hook_code=$?
  hook=''
}

hook_said() { tail -n 2 "$SNAPSHOT_HOOK_ERR" 2>/dev/null | tr '\n' ' ' | sed 's/ *$//'; }

snapshot_hook() {
  if [ ! -x "$SNAPSHOT_HOOK" ]; then
    echo snapshot.hook=none
    return
  fi
  describe_within_deadline 2>/dev/null
  if [ "$hook_timed_out" = yes ]; then
    printf 'snapshot.hook=failed\nsnapshot.hook.why=it did not finish within %s seconds, so the helper stopped it and everything it started\n' "$SNAPSHOT_HOOK_SECONDS"
  elif [ "$hook_code" = 0 ]; then
    printf 'snapshot.hook=found\nsnapshot.hook.describe=%s\n' "$(tr -d '\n' <"$SNAPSHOT_HOOK_OUT")"
  else
    printf 'snapshot.hook=failed\nsnapshot.hook.why=it exited with %s: %s\n' "$hook_code" "$(hook_said)"
  fi
  rm -f "$SNAPSHOT_HOOK_OUT"
}

snapshot_report() {
  echo "snapshot.probe=$SNAPSHOT_PROBE"
  echo "snapshot.at=$(date +%s)"
  echo "snapshot.homes=$HOMES"
  echo "snapshot.filesystem=$(filesystem_of "$HOMES")"
  echo "snapshot.free_kib=$(free_kib "$HOMES")"
  home_snapshots
  snapshot_hook
}

remove_abandoned_probe_files() {
  for file in "$SNAPSHOT_REPORT.new."* "$STATE/snapshot-hook.out."*; do
    probe=${file##*.}
    [ -f "$file" ] && number "$probe" && ! kill -0 "$probe" 2>/dev/null && rm -f "$file"
  done
}

end_snapshot_probe() {
  [ -z "${hook:-}" ] || end_hook "$hook"
  [ ! -d "$SNAPSHOT_TRIAL" ] || remove_trial "$SNAPSHOT_TRIAL" >/dev/null
  rm -f "$SNAPSHOT_HOOK_OUT" "$SNAPSHOT_REPORT.new.$$"
}

snapshot() {
  [ $# -eq 1 ] && [ "$1" = probe ] || quit 2 "usage: machine snapshot probe"
  mkdir -p "$STATE"
  trap end_snapshot_probe EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  remove_abandoned_probe_files
  snapshot_report >"$SNAPSHOT_REPORT.new.$$"
  mv -f "$SNAPSHOT_REPORT.new.$$" "$SNAPSHOT_REPORT"
  cat "$SNAPSHOT_REPORT"
}

make_user() {
  user=$1 uid=$2 key=$3 extra=$4
  shell=/bin/sh
  [ -x /bin/bash ] && shell=/bin/bash
  skel=/etc/skel
  [ -d "$SKEL" ] && skel=$SKEL
  groupadd -g "$uid" "$user" || return 1
  useradd -u "$uid" -g "$uid" -m -d "/home/$user" -k "$skel" -s "$shell" -c "bb-box box" "$user" || return 1
  # No password, but not locked: sshd refuses key logins to a locked account without PAM.
  usermod -p '*' "$user" || return 1
  chmod 700 "/home/$user" || return 1
  mkdir -p "/home/$user/.ssh" "/home/$user/.cache" || return 1
  printf '%s\n' "$key" >"/home/$user/.ssh/authorized_keys" || return 1
  chmod 700 "/home/$user/.ssh" && chmod 600 "/home/$user/.ssh/authorized_keys" || return 1
  chown -R "$uid:$uid" "/home/$user/.ssh" "/home/$user/.cache" || return 1
  if [ "$extra" = docker ]; then
    usermod -aG docker "$user" || return 1
    # sudo ignores names with a dot, so the rule counts only once it is checked and renamed.
    printf '%s ALL=(ALL:ALL) NOPASSWD: ALL\n' "$user" >"/etc/sudoers.d/$user.new" || return 1
    chmod 440 "/etc/sudoers.d/$user.new" && visudo -cqf "/etc/sudoers.d/$user.new" >/dev/null || return 1
    mv -f "/etc/sudoers.d/$user.new" "/etc/sudoers.d/$user" || return 1
  fi
  # Linger keeps the user's services, BB's among them, running after its sessions end.
  if [ -d /run/systemd/system ] && command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "$user" || return 1
  fi
}

claim() {
  expected=${1:-} extra=${2:-}
  number "$expected" || quit 2 "usage: machine claim <generation> [docker]"
  case $extra in '' | docker) ;; *) quit 2 "usage: machine claim <generation> [docker]" ;; esac
  read_input
  [ -n "$box" ] || quit 2 "The claim needs box=."
  case $key in
    "ssh-ed25519 "* | "ssh-rsa "* | "ecdsa-sha2-"* | "sk-ssh-ed25519@openssh.com "* | "sk-ecdsa-sha2-"*) ;;
    *) quit 2 "The claim needs key=, an OpenSSH public key." ;;
  esac
  lock -n
  if [ -e "$STATE/owner" ] || [ -e "$STATE/resetting" ]; then quit 3 "Another box holds the machine."; fi
  current=$(generation)
  number "$current" || quit 5 "The machine has no reset generation in $STATE. Run bb-box's setup.sh on it."
  [ "$current" = "$expected" ] || quit 6 "The machine is at reset generation $current, not $expected."
  problem=$(dirt | head -n 1)
  [ -z "$problem" ] || quit 5 "An earlier box left $problem."
  if [ "$extra" = docker ]; then
    [ -x "$HOOK" ] || quit 5 "Docker is offered only where reset-machine restores the whole machine, and $HOOK is missing."
    getent group docker >/dev/null || quit 5 "The docker group is missing. Install Docker on the machine."
  fi
  user=$PREFIX$current
  id_range
  uid=$((id_base + current % id_span))
  holder=$(getent passwd "$uid" | cut -d: -f1)
  [ -z "$holder" ] || quit 5 "UID $uid belongs to $holder. bb-box's box users take UIDs $id_base to $((id_base + id_span - 1))."
  holder=$(getent group "$uid" | cut -d: -f1)
  [ -z "$holder" ] || quit 5 "GID $uid belongs to group $holder. bb-box's box users take GIDs $id_base to $((id_base + id_span - 1))."
  printf 'install=%s\nbox=%s\nthread=%s\nname=%s\nkind=%s\ncreated=%s\ngeneration=%s\nuser=%s\nuid=%s\n' \
    "$install" "$box" "$thread" "$name" "$kind" "$created" "$current" "$user" "$uid" >"$STATE/owner.new.$$"
  if ! ln "$STATE/owner.new.$$" "$STATE/owner" 2>/dev/null; then
    rm -f "$STATE/owner.new.$$"
    quit 3 "Another box holds the machine."
  fi
  rm -f "$STATE/owner.new.$$"
  if ! make_user "$user" "$uid" "$key" "$extra"; then
    remove_user "$user" "$uid" >/dev/null 2>&1
    rm -f "$STATE/owner"
    fail "Could not make box user $user."
  fi
  printf 'user=%s\nuid=%s\n' "$user" "$uid"
}

# Removes files and directories owned by `uid` on each local filesystem.
sweep() {
  uid=$1
  if rm -rf --one-file-system "$STATE/.sweep-check" 2>/dev/null; then one=--one-file-system; else one=''; fi
  prune=''
  for path in $SKIP; do prune="$prune -path $path -o"; done
  awk '{ print $3, $2 }' /proc/mounts | sort -u | while read -r type mount; do
    case $type in
      ext2 | ext3 | ext4 | xfs | btrfs | zfs | f2fs | bcachefs | jfs | reiserfs | tmpfs | ramfs | mqueue) ;;
      # A container's root is an overlay; other overlays belong to containers.
      overlay) [ "$mount" = / ] || continue ;;
      *) continue ;;
    esac
    mount=$(printf '%b' "$mount")
    for path in $SKIP; do
      case $mount in "$path" | "$path"/*) continue 2 ;; esac
    done
    # shellcheck disable=SC2086
    find "$mount" -xdev \( $prune -false \) -prune -o -uid "$uid" -prune -exec rm -rf $one {} + 2>/dev/null
  done
  return 0
}

remove_user() {
  user=$1 uid=${2:-}
  [ -n "$uid" ] || uid=$(id -u "$user" 2>/dev/null) || uid=''
  if [ -d /run/systemd/system ] && command -v loginctl >/dev/null 2>&1; then
    loginctl disable-linger "$user" >/dev/null 2>&1
    loginctl terminate-user "$user" >/dev/null 2>&1
    # Stopped before its processes are killed, so the user's manager does not end as failed.
    if [ -n "$uid" ]; then
      systemctl stop "user@$uid.service" >/dev/null 2>&1
      systemctl reset-failed "user@$uid.service" "user-runtime-dir@$uid.service" >/dev/null 2>&1
    fi
  fi
  rm -f "/var/lib/systemd/linger/$user" "/etc/sudoers.d/$user" "/etc/sudoers.d/$user.new"
  if box_uid "$uid"; then
    tries=0
    while pgrep -u "$uid" >/dev/null 2>&1; do
      pkill -KILL -u "$uid" >/dev/null 2>&1
      tries=$((tries + 1))
      [ "$tries" -le 50 ] || fail "Processes of $user did not end: $(pgrep -l -u "$uid" | head -n 3 | tr '\n' ' ')"
      sleep 0.2
    done
  fi
  command -v crontab >/dev/null 2>&1 && crontab -r -u "$user" >/dev/null 2>&1
  rm -f "/var/spool/cron/crontabs/$user" "/var/spool/cron/$user"
  if command -v atq >/dev/null 2>&1; then
    atq 2>/dev/null | awk -v u="$user" '$NF == u { print $1 }' | while read -r job; do atrm "$job"; done
  fi
  [ -z "$uid" ] || remove_ipc "$user" "$uid"
  if getent passwd "$user" >/dev/null; then userdel -r "$user" >/dev/null 2>&1 || userdel "$user" >/dev/null 2>&1; fi
  ! getent passwd "$user" >/dev/null || fail "Could not remove user $user."
  if getent group "$user" >/dev/null; then groupdel "$user" >/dev/null 2>&1 || fail "Could not remove group $user."; fi
  [ -z "$uid" ] || sweep "$uid"
  rm -rf "/home/$user"
}

# Starts the operator's whole-machine reset, or checks on one that has started.
restore_machine() {
  dir=$STATE/restore
  if [ ! -e "$dir/boot" ]; then
    [ -x "$HOOK" ] || fail "$HOOK is missing, so the machine cannot be reset whole."
    mkdir -p "$dir"
    boot_id | put "$dir/boot"
    # Detached, without the lock, as it may restart the machine.
    BB_BOX_RESTARTING=$dir/restarting setsid sh -c '"$1" >"$2/log" 2>&1; echo $? >"$2/status.new" && mv -f "$2/status.new" "$2/status"' sh "$HOOK" "$dir" \
      </dev/null >/dev/null 2>&1 9>&- &
    echo restore=started
    exit 10
  fi
  code=$(cat "$dir/status" 2>/dev/null)
  if [ "$(cat "$dir/boot")" != "$(boot_id)" ]; then
    # The machine restarted. That finishes the reset only if the hook had
    # finished, or had said with the restarting file that it would restart.
    [ -e "$dir/restarting" ] || [ "$code" = 0 ] || restore_failed "The machine restarted before reset-machine finished."
  elif [ -n "$code" ] && [ "$code" != 0 ]; then
    restore_failed "$HOOK exited with $code: $(tail -n 3 "$dir/log" 2>/dev/null | tr '\n' ' ')"
  elif [ -z "$code" ] || [ -e "$dir/restarting" ]; then
    # Still running, or done and waiting for the restart it asked for.
    echo restore=running
    exit 10
  fi
}

# Reported once: the next reset runs the hook again. Its log stays for the operator.
restore_failed() {
  rm -rf "$STATE/restore.failed" && mv -f "$STATE/restore" "$STATE/restore.failed"
  fail "$1"
}

# Resets the machine from the marker that names the box. It is safe to run
# again: the resetting marker stays until the new generation is written.
finish() {
  marker=$1 mode=$2
  held=$(field "$marker" generation)
  number "$held" || fail "$marker has no generation."
  if [ "$marker" = "$STATE/owner" ]; then
    mv -f "$STATE/owner" "$STATE/resetting" || fail "Could not mark the machine as resetting."
    marker=$STATE/resetting
  fi
  [ "$mode" != machine ] || restore_machine
  user=$(field "$marker" user)
  [ -z "$user" ] || remove_user "$user" "$(field "$marker" uid)"
  for other in $(getent passwd | cut -d: -f1 | grep "^$PREFIX"); do remove_user "$other"; done
  for other in $(ipc_orphans); do remove_ipc "$other" "$other"; done
  rm -rf "$STATE/restore"
  problem=$(dirt | head -n 1)
  [ -z "$problem" ] || fail "The reset left $problem."
  next=$((held + 1))
  echo "$next" | put "$STATE/generation"
  rm -f "$STATE/resetting"
  echo "generation=$next"
  echo released=yes
}

release() {
  expected=${1:-} mode=${2:-}
  number "$expected" || quit 2 "usage: machine release <generation> [machine]"
  case $mode in '' | machine) ;; *) quit 2 "usage: machine release <generation> [machine]" ;; esac
  read_input
  lock -w 900
  if [ -e "$STATE/owner" ]; then
    marker=$STATE/owner
    # A guest that names no box never matches a box that holds the machine.
    [ -n "$box" ] || quit 4 "A box holds the machine."
  elif [ -e "$STATE/resetting" ]; then
    marker=$STATE/resetting
  else
    current=$(generation)
    echo "generation=$current"
    if number "$current" && [ "$current" -gt "$expected" ]; then echo released=already; else echo released=none; fi
    exit 0
  fi
  [ "$(field "$marker" install)" = "$install" ] || quit 4 "Another bb-box install holds the machine."
  [ -z "$box" ] || [ "$(field "$marker" box)" = "$box" ] || quit 4 "Another box holds the machine."
  [ "$(field "$marker" generation)" = "$expected" ] || quit 4 "The machine has moved on to a later box."
  finish "$marker" "$mode"
}

# For a machine out of service: resets whatever is on it. It leaves alone a
# machine a box holds, whoever asks, and from bb-box, a machine another
# install is resetting. An operator runs it with no input.
reset() {
  mode=${1:-}
  case $mode in '' | machine) ;; *) quit 2 "usage: machine reset [machine]" ;; esac
  read_input optional
  lock -w 900
  if [ -e "$STATE/owner" ]; then
    quit 4 "Box $(field "$STATE/owner" name) of bb-box install $(field "$STATE/owner" install) holds the machine. Release the box first."
  elif [ -e "$STATE/resetting" ]; then
    marker=$STATE/resetting
  else
    current=$(generation)
    number "$current" || current=0
    printf 'install=%s\ngeneration=%s\n' "$install" "$current" | put "$STATE/resetting"
    marker=$STATE/resetting
  fi
  other=$(field "$marker" install)
  if [ -n "$install" ] && [ "$other" != "$install" ]; then
    [ -n "$other" ] || quit 4 "An operator's reset of the machine has not finished. Run it again on the machine."
    quit 4 "Another bb-box install, $other, is resetting the machine."
  fi
  if [ -z "$install" ] && [ "$mode" = machine ]; then
    # An operator waits here for the whole-machine reset; bb-box asks again instead.
    while :; do
      (restore_machine >/dev/null)
      code=$?
      [ "$code" = 10 ] || break
      sleep 2
    done
    [ "$code" = 0 ] || exit "$code"
  fi
  finish "$marker" "$mode"
}

init() {
  lock -w 60
  number "$(generation)" || echo 0 | put "$STATE/generation"
  echo "generation=$(generation)"
}

[ "$(id -u)" = 0 ] || quit 2 "Run it as root, through sudo."
command -v flock >/dev/null 2>&1 || quit 1 "flock is missing. Install util-linux."
verb=${1:-}
[ $# -eq 0 ] || shift
case $verb in
  status) status ;;
  claim) claim "$@" ;;
  release) release "$@" ;;
  reset) reset "$@" ;;
  snapshot) snapshot "$@" ;;
  init) init ;;
  version) echo "$VERSION" ;;
  *) quit 2 "usage: machine status | claim | release | reset | snapshot probe | init | version" ;;
esac
