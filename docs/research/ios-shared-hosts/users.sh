#!/bin/sh
set -u

key=$HOME/.ssh/shared_users
prefix=${USER_PREFIX:-sbu}
now() { python3 -c 'import time; print(f"{time.time():.3f}")'; }
since() { python3 -c "import sys, time; print(f'{time.time() - float(sys.argv[1]):.1f}')" "$1"; }
as_user() { name=$1; shift; ssh -q -i "$key" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes "$name@127.0.0.1" "$@"; }

make_user() {
  name=$1
  started=$(now)
  password=$(openssl rand -hex 16)
  printf '%s\n' "$password" | sudo sysadminctl -addUser "$name" -fullName "$name" -password - -home "/Users/$name" >/dev/null 2>&1 \
    || sudo sysadminctl -addUser "$name" -fullName "$name" -password "$password" -home "/Users/$name" >/dev/null 2>&1
  sudo createhomedir -c -u "$name" >/dev/null 2>&1
  sudo dseditgroup -o edit -a "$name" -t user _developer
  sudo dseditgroup -o edit -a "$name" -t user com.apple.access_ssh 2>/dev/null
  sudo install -d -m 700 -o "$name" -g staff "/Users/$name/.ssh"
  sudo install -m 600 -o "$name" -g staff "$key.pub" "/Users/$name/.ssh/authorized_keys"
  echo "user $name made in $(since "$started") s"
}

remove_user() {
  name=$1
  started=$(now)
  uid=$(id -u "$name" 2>/dev/null) || { echo "no user $name"; return; }
  sudo launchctl bootout "user/$uid" 2>/dev/null
  sudo pkill -9 -u "$uid" 2>/dev/null
  sleep 1
  sudo pkill -9 -u "$uid" 2>/dev/null
  size=$(sudo du -sk "/Users/$name" 2>/dev/null | cut -f1)
  sudo sysadminctl -deleteUser "$name" >/dev/null 2>&1
  sudo rm -rf "/Users/$name"
  left=$(sudo find /private/tmp /private/var/folders /Users/Shared -user "$uid" 2>/dev/null | wc -l | tr -d ' ')
  sudo find /private/tmp /Users/Shared -user "$uid" -delete 2>/dev/null
  echo "user $name removed in $(since "$started") s, home $((size / 1024)) MiB, files left elsewhere $left"
}

case ${1:-} in
  key)
    [ -f "$key" ] || ssh-keygen -q -t ed25519 -N '' -f "$key"
    ;;
  make)
    shift
    for name in "$@"; do make_user "$name"; done
    ;;
  remove)
    shift
    for name in "$@"; do remove_user "$name"; done
    ;;
  run)
    name=${2:?user}; shift 2
    as_user "$name" "$@"
    ;;
  *) echo "usage: users.sh key | make <name>... | remove <name>... | run <name> <command>" >&2; exit 2 ;;
esac
