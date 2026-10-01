#!/bin/sh
# A pool of SSH machines in Docker on one computer, for testing the SSH host
# pool backend live. Each machine is set up with setup.sh, as an operator
# would set up a real one.
#
#   sh rig.sh up <dir>    builds the images, starts the machines and writes <dir>
#   sh rig.sh down        removes the machines, their network and volume
#
# The machines, each reached from this computer on 127.0.0.1:
#
#   plain    port 2221  sshd only, no systemd: linux, with the home reset
#   systemd  port 2222  systemd and Docker, privileged: linux and
#                       linux-docker, with reset-machine-docker.sh as its
#                       whole-machine reset
#   bastion  port 2220  a jump host, whose user "jump" may forward only to
#                       plain's sshd
#
# <dir> gets the key bb-box uses, settings.json with plain and systemd for
# scripts/conformance.ts and scripts/smoke.ts, docker.json with systemd
# alone, whose boxes have Docker, and via.json with plain reached through
# the bastion. A pool's boxes have Docker only when every machine gives it
# (041), so settings.json's do not. Keep <dir> out of the repository.
# Everything the rig makes is named bbbox-sshpool*.

set -eu
here=$(cd "$(dirname "$0")" && pwd)
setup=$(dirname "$here")
NAME=bbbox-sshpool
VOLUME=$NAME-docker

die() {
  printf 'rig.sh: %s\n' "$*" >&2
  exit 1
}

down() {
  for machine in bastion plain systemd; do docker rm -f "$NAME-$machine" >/dev/null 2>&1 || true; done
  docker network rm "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
}

# Waits until sshd in the container answers on its published port.
wait_ssh() {
  tries=0
  until ssh-keyscan -T 2 -p "$2" 127.0.0.1 2>/dev/null | grep -q .; do
    tries=$((tries + 1))
    [ "$tries" -le 60 ] || die "sshd in $NAME-$1 did not answer on port $2."
    sleep 1
  done
}

# Runs setup.sh in a machine and prints its output.
set_up() {
  machine=$1
  shift
  docker cp "$setup/." "$NAME-$machine:/root/ssh-pool" >/dev/null
  docker exec "$NAME-$machine" sh /root/ssh-pool/setup.sh --key "$key" --name "$machine" --address 127.0.0.1 "$@"
}

# The lines setup.sh printed under a heading: 1 the machines line, 2 the host keys.
block() {
  awk -v want="$1" '/^Add this line/ { at = 1; next } /^Add these lines/ { at = 2; next } /^Check these/ { at = 0 }
    at == want && /^  [^ ]/ { sub(/^  /, ""); print }'
}

json() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }

up() {
  dir=$1
  mkdir -p "$dir"
  dir=$(cd "$dir" && pwd)
  [ -f "$dir/id_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -C bb-box-rig -f "$dir/id_ed25519"
  key=$(cat "$dir/id_ed25519.pub")

  docker build -q --target plain -t "$NAME:plain" "$here" >/dev/null
  docker build -q --target systemd -t "$NAME:systemd" "$here" >/dev/null
  down
  docker network create "$NAME" >/dev/null
  docker run -d --name "$NAME-plain" --hostname plain --network "$NAME" -p 127.0.0.1:2221:22 "$NAME:plain" >/dev/null
  docker run -d --name "$NAME-bastion" --hostname bastion --network "$NAME" -p 127.0.0.1:2220:22 "$NAME:plain" >/dev/null
  docker run -d --name "$NAME-systemd" --hostname systemd --network "$NAME" -p 127.0.0.1:2222:22 \
    --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock -v "$VOLUME:/var/lib/docker" "$NAME:systemd" >/dev/null
  wait_ssh plain 2221
  wait_ssh bastion 2220
  wait_ssh systemd 2222
  docker exec "$NAME-systemd" systemctl is-system-running --wait >/dev/null || true
  docker exec "$NAME-systemd" sh -c 'until docker info >/dev/null 2>&1; do sleep 1; done'

  set_up plain --port 2221 >"$dir/plain.txt"
  set_up systemd --port 2222 --reset-hook /root/ssh-pool/test/reset-machine-docker.sh >"$dir/systemd.txt"

  # The bastion's user may only forward to plain's sshd.
  docker exec "$NAME-bastion" sh -c 'useradd -m -s /bin/sh jump && usermod -p "*" jump &&
    install -d -m 0700 -o jump -g jump /home/jump/.ssh &&
    printf "%s\n" "$1" >/home/jump/.ssh/authorized_keys && chown jump:jump /home/jump/.ssh/authorized_keys' \
    sh "restrict,port-forwarding,permitopen=\"$NAME-plain:22\" $key"

  machines=$(cat "$dir/plain.txt" "$dir/systemd.txt" | block 1)
  hosts=$(cat "$dir/plain.txt" "$dir/systemd.txt" | block 2)
  cat >"$dir/settings.json" <<EOF
{
  "ssh-pool-enabled": true,
  "ssh-pool-machines": $(json "$machines"),
  "ssh-pool-known-hosts": $(json "$hosts"),
  "ssh-pool-ssh-private-key": { "file": "id_ed25519" }
}
EOF
  cat >"$dir/docker.json" <<EOF
{
  "ssh-pool-enabled": true,
  "ssh-pool-machines": $(json "$(block 1 <"$dir/systemd.txt")"),
  "ssh-pool-known-hosts": $(json "$(block 2 <"$dir/systemd.txt")"),
  "ssh-pool-ssh-private-key": { "file": "id_ed25519" }
}
EOF
  bastion=$(docker exec "$NAME-bastion" sh -c 'for f in /etc/ssh/ssh_host_*_key.pub; do echo "[127.0.0.1]:2220 $(cut -d" " -f1,2 "$f")"; done')
  plain=$(docker exec "$NAME-plain" sh -c 'for f in /etc/ssh/ssh_host_*_key.pub; do echo "$1 $(cut -d" " -f1,2 "$f")"; done' sh "$NAME-plain")
  cat >"$dir/via.json" <<EOF
{
  "ssh-pool-enabled": true,
  "ssh-pool-machines": $(json "plain bbbox-admin@$NAME-plain linux via=jump@127.0.0.1:2220"),
  "ssh-pool-known-hosts": $(json "$bastion
$plain"),
  "ssh-pool-ssh-private-key": { "file": "id_ed25519" }
}
EOF
  echo "The pool is up. Settings: $dir/settings.json, with Docker: $dir/docker.json, and through the bastion: $dir/via.json"
  printf '%s\n' "$machines" | sed 's/^/  /'
}

case ${1:-} in
  up)
    [ $# -eq 2 ] || die "usage: rig.sh up <dir> | down"
    up "$2"
    ;;
  down) down ;;
  *) die "usage: rig.sh up <dir> | down" ;;
esac
