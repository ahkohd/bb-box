#!/bin/bash
# Runs as root inside the WSL distribution that setup.ps1 imports, in two
# steps:
#
#   guest.sh conf <user>
#       writes /etc/wsl.conf: systemd, <user> as the default user, no
#       Windows PATH. WSL reads it when the distribution next starts, so
#       it prints "changed" when the file changed.
#   guest.sh install <user> <port> <public key>
#       with systemd running: Docker Engine, and sshd on <port> for <user>,
#       who may use Docker and logs in with the key alone.
#
# Running it again updates the packages and replaces the key.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

die() { echo "guest.sh: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run it as root"

conf() {
  local user=$1 want
  want=$(cat <<EOF
# Written by bb-box's setup/docker-wsl. WSL reads it at the distribution's start.
[boot]
systemd=true
[user]
default=$user
[interop]
appendWindowsPath=false
EOF
)
  [ "$(cat /etc/wsl.conf 2>/dev/null)" = "$want" ] && return
  printf '%s\n' "$want" >/etc/wsl.conf
  echo changed
}

install_all() {
  local user=$1 port=$2 key=$3 keys
  [ "$(ps -o comm= -p 1)" = systemd ] || die "systemd is not running: run 'guest.sh conf' and restart the distribution first"
  case $key in
    ssh-* | ecdsa-* | sk-*) ;;
    *) die "not a public SSH key: $key" ;;
  esac

  # No service starts while packages install: with mirrored networking,
  # Windows' own sshd holds port 22, so starting ssh.socket fails, and so
  # would openssh-server's install. This script starts them once set up.
  printf '#!/bin/sh\nexit 101\n' >/usr/sbin/policy-rc.d
  chmod 0755 /usr/sbin/policy-rc.d
  trap 'rm -f /usr/sbin/policy-rc.d' EXIT
  apt-get update -qq
  apt-get install -y -q ca-certificates curl openssh-server >/dev/null

  # Docker Engine from Docker's own repository, as bb-box was tested with.
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
    >/etc/apt/sources.list.d/docker.list
  # Keep Docker's networks off 192.168.0.0/16, which is often a home LAN:
  # with mirrored networking the Windows machine's routes are this VM's.
  install -d -m 0755 /etc/docker
  [ -e /etc/docker/daemon.json ] || cat >/etc/docker/daemon.json <<'EOF'
{
  "default-address-pools": [{ "base": "172.16.0.0/12", "size": 24 }]
}
EOF
  apt-get update -qq
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin >/dev/null
  rm -f /usr/sbin/policy-rc.d
  systemctl enable --now containerd.service docker.service >/dev/null

  # The user bb-box logs in as: Docker's group, a key, no password.
  id "$user" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$user"
  usermod -aG docker -p '*' "$user"
  install -d -m 0700 -o "$user" -g "$user" "/home/$user/.ssh"
  keys=/home/$user/.ssh/authorized_keys
  (umask 077 && printf '%s\n' "$key" >"$keys")
  chown "$user:" "$keys"
  [ "$(cat "$keys")" = "$key" ] || die "could not write $keys"

  # sshd as a plain service on <port>: Windows' own OpenSSH keeps port 22,
  # and with mirrored networking both listen on the Windows machine's
  # addresses. Docker's CLI opens one SSH session for each call.
  cat >/etc/ssh/sshd_config.d/10-bb-box.conf <<EOF
Port $port
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
MaxStartups 100:30:200
EOF
  systemctl disable --now ssh.socket >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/ssh.service.d/00-socket.conf /etc/systemd/system/ssh.socket.d/addresses.conf
  systemctl daemon-reload
  systemctl enable ssh.service >/dev/null
  systemctl restart ssh.service

  docker version --format 'Docker Engine {{.Server.Version}}'
  echo "sshd on port $port for $user"
}

case ${1:-} in
  conf) [ $# = 2 ] || die "usage: guest.sh conf <user>"; conf "$2" ;;
  install) [ $# = 4 ] || die "usage: guest.sh install <user> <port> <public key>"; install_all "$2" "$3" "$4" ;;
  *) die "usage: guest.sh conf <user> | install <user> <port> <public key>" ;;
esac
