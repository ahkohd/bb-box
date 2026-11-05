#!/bin/bash
# bb-box base template, run as root inside a Proxmox Ubuntu 24.04 CT: the
# development baseline, pinned tools, Docker, the box user, SSH with the
# plugin's key, DNS and PATH. The desktop template runs this first too, and so
# does setup/docker/Dockerfile for the Docker backend's images, and
# setup/tart for Linux VMs on a Mac (040).
#
# usage: customize-base.sh <build-dir>
# <build-dir>/build.env sets BOX_USER, BOX_DNS and BB_URL (see build.sh), and
# BOX_RUNTIME: lxc (the default), docker, or vm (a Tart Linux VM), and
# LINUX_GPU: none (the default), or nvidia for NVIDIA's userspace (071).
set -Eeuo pipefail
trap 'echo "customize-base: line $LINENO failed: $BASH_COMMAND" >&2' ERR
umask 022

build=$1
# shellcheck disable=SC1091
. "$build/build.env"
# shellcheck disable=SC1091
. "$(cd "$(dirname "$0")" && pwd)/apt.sh"
user=${BOX_USER:-box}
runtime=${BOX_RUNTIME:-lxc}
export DEBIAN_FRONTEND=noninteractive
die() { echo "customize-base: $*" >&2; exit 1; }
case $runtime in lxc | docker | vm) ;; *) die "BOX_RUNTIME must be lxc, docker or vm" ;; esac
installed() { [ "$(dpkg-query -W -f='${Status}' "$1" 2>/dev/null)" = "install ok installed" ]; }

# The base image may lack CA certificates, which the https snapshot needs.
installed ca-certificates || { apt_update -q && apt_install -y -q --no-install-recommends ca-certificates; }

# What a container cannot use or does not need, removed before the upgrade.
purge=()
for package in cloud-init cloud-initramfs-copymods cloud-initramfs-dyn-netconf snapd lxd-installer \
  lxd-agent-loader multipath-tools open-iscsi open-vm-tools udisks2 fwupd modemmanager thermald \
  postfix sysstat ubuntu-pro-client ubuntu-advantage-tools unattended-upgrades; do
  installed "$package" && purge+=("$package")
done
[ "${#purge[@]}" -eq 0 ] || apt-get purge -y -q --auto-remove "${purge[@]}"
rm -rf /etc/cloud /var/lib/cloud /snap /var/snap /var/lib/snapd

# Baseline, Docker and everyday tools, from the pinned apt snapshot.
# bind9-dnsutils is dig and nslookup: Ubuntu 24.04's dnsutils is only a
# transitional name for it, which 26.04 dropped.
docker_packages="docker.io docker-compose-v2 docker-buildx pigz postgresql-client redis-tools sqlite3"
extra_packages="openssh-server sudo systemd-resolved less nano vim neovim iputils-ping iputils-arping bind9-dnsutils netcat-openbsd htop tmux file lsof strace"
# Ubuntu's container image has no systemd. A Docker box does not run it, but
# systemctl sets up the same units as in an LXC box, and the box's start script
# makes the machine ID with it.
[ "$runtime" != docker ] || extra_packages=${extra_packages/systemd-resolved/systemd}
# shellcheck disable=SC2086
bash "$build/guest/baseline.sh" "$build" $docker_packages $extra_packages
# npm's global packages go where they land on PATH; the box user's own are set
# up once it exists, below.
node_prefix=$(dirname "$(dirname "$(readlink -f /usr/local/bin/node)")")
install -d -m 0755 "$node_prefix/etc"
printf 'prefix=/usr/local\nupdate-notifier=false\nfund=false\n' >"$node_prefix/etc/npmrc"
# pnpm and Yarn through Corepack, which fetches the version a project's
# packageManager field names on first use. It does not ask first: an agent's
# terminal cannot answer. Corepack ships with Node.js 24 but not with Node.js
# 25 and later: when the Node pin moves past 24, install Corepack from npm,
# pinned, and drop its link from the Node entry in pins.json.
/usr/local/bin/node /usr/local/bin/corepack enable --install-directory /usr/local/bin
grep -q '^COREPACK_ENABLE_DOWNLOAD_PROMPT=' /etc/environment ||
  printf 'COREPACK_ENABLE_DOWNLOAD_PROMPT=0\n' >>/etc/environment
install -d -m 0755 /etc/environment.d
printf 'COREPACK_ENABLE_DOWNLOAD_PROMPT=0\n' >/etc/environment.d/50-bb-box-corepack.conf
# Git LFS for every user and repository, as `git lfs install` does for one user.
git lfs install --system --skip-repo >/dev/null

# A container shares the host's kernel; a VM keeps its own.
if [ "$runtime" != vm ] && dpkg-query -W -f='${Package} ${Status}\n' | awk '$4 == "installed" { print $1 }' |
  grep -Eq '^(linux-image-|linux-modules-|grub-)'; then
  die "the image contains a kernel or boot loader package"
fi

# Units that cost boot time or run apt, mail or maintenance jobs in a box.
# apt never runs at start: every package is baked in.
for unit in apt-daily.timer apt-daily-upgrade.timer motd-news.timer man-db.timer e2scrub_all.timer \
  e2scrub_reap.service fstrim.timer dpkg-db-backup.timer ua-timer.timer ua-reboot-cmds.service \
  ubuntu-advantage.service nftables.service systemd-sysupdate.timer systemd-sysupdate-reboot.timer; do
  systemctl disable "$unit" >/dev/null 2>&1 || true
done
systemctl mask apt-daily.service apt-daily-upgrade.service >/dev/null
# With nesting, the CT has its own AppArmor namespace, and loading every
# profile at each boot is slow. A VM keeps AppArmor.
[ "$runtime" = vm ] || systemctl mask apparmor.service >/dev/null
# A VM's own hostname is in /etc/hosts, as Proxmox puts a CT's: sudo looks it
# up, and early in a VM's boot systemd-resolved took 2.7 s to answer. Naming
# a box replaces the line (the Tart backend's nameScript).
if [ "$runtime" = vm ] && ! grep -q '^127[.]0[.]1[.]1[[:space:]]' /etc/hosts; then
  echo "127.0.1.1 $(hostname)" >>/etc/hosts
fi

# Docker: nesting=1 on the CT is all it needs. Keep its networks off
# 192.168.0.0/16, which is in Docker's default pools and often a home LAN.
install -d -m 0755 /etc/docker
cat >/etc/docker/daemon.json <<'EOF'
{
  "default-address-pools": [{ "base": "172.16.0.0/12", "size": 24 }]
}
EOF
# Docker starts on first use (041): docker.socket starts it, with containerd,
# at the first docker command, about 0.3 s, and an idle box pays nothing for
# it. A box with containers starts it at boot, so their restart policies work
# as before.
systemctl disable containerd.service docker.service >/dev/null 2>&1
systemctl enable docker.socket >/dev/null
cat >/etc/systemd/system/bb-box-docker-containers.service <<'EOF'
[Unit]
Description=bb-box: start Docker at boot when the box has containers
ConditionDirectoryNotEmpty=/var/lib/docker/containers
After=docker.socket

[Service]
Type=oneshot
ExecStart=/usr/bin/systemctl start --no-block docker.service

[Install]
WantedBy=multi-user.target
EOF
systemctl enable bb-box-docker-containers.service >/dev/null

# SSH: a plain service, keys only. The template holds no host keys; the
# service makes them before its first start in each clone, and again when a
# hard stop left them empty. Only ed25519 and ECDSA: an RSA key costs 200 ms
# at first boot.
systemctl disable ssh.socket >/dev/null 2>&1 || true
systemctl enable ssh.service >/dev/null
install -d -m 0755 /etc/ssh/sshd_config.d /etc/systemd/system/ssh.service.d
cat >/etc/ssh/sshd_config.d/10-bb-box.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
PermitEmptyPasswords no
HostKey /etc/ssh/ssh_host_ed25519_key
HostKey /etc/ssh/ssh_host_ecdsa_key
EOF
cat >/etc/systemd/system/ssh.service.d/50-bb-box-host-keys.conf <<'EOF'
[Service]
ExecStartPre=
ExecStartPre=/bin/sh -c 'test -s /etc/ssh/ssh_host_ed25519_key || { rm -f /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub; ssh-keygen -q -t ed25519 -N "" -f /etc/ssh/ssh_host_ed25519_key; }'
ExecStartPre=/bin/sh -c 'test -s /etc/ssh/ssh_host_ecdsa_key || { rm -f /etc/ssh/ssh_host_ecdsa_key /etc/ssh/ssh_host_ecdsa_key.pub; ssh-keygen -q -t ecdsa -N "" -f /etc/ssh/ssh_host_ecdsa_key; }'
ExecStartPre=/usr/sbin/sshd -t
EOF
install -d -m 0755 /run/sshd
for t in ed25519 ecdsa; do
  [ -s "/etc/ssh/ssh_host_${t}_key" ] || ssh-keygen -q -t "$t" -N '' -f "/etc/ssh/ssh_host_${t}_key"
done
sshd -t

# The box user: uid 1000, passwordless sudo, Docker without sudo. In a Tart
# VM uid 1000 is the image's own user, which Tart's guest agent runs as, so
# there the box user takes the next free uid and that user's password is
# locked.
if ! id -u "$user" >/dev/null 2>&1; then
  if [ "$runtime" = vm ] && getent passwd 1000 >/dev/null; then
    passwd -l "$(getent passwd 1000 | cut -d: -f1)" >/dev/null
    useradd --create-home --shell /bin/bash --user-group "$user"
  else
    useradd --create-home --shell /bin/bash --uid 1000 --user-group "$user"
  fi
fi
[ "$runtime" = vm ] || [ "$(id -u "$user")" = 1000 ] || die "$user must have uid 1000"
# In the sudo group too, so tools such as command-not-found say "sudo apt
# install". Its rule asks for a password, but sudoers reads sudoers.d last, so
# the user's own NOPASSWD rule below wins.
usermod -aG docker,adm,sudo "$user"
# npm's global packages. The box user's go in its ~/.local, whose bin is first
# on the PATH of its commands, terminals and BB's daemon: `npm install -g`, as
# BB's updater runs it for an agent CLI, needs no root, and the command it
# installs takes over from the pinned one in /usr/local/bin. Root's go in
# /usr/local, from root's own npmrc: sudo sets HOME to /root. The box user's
# prefix is in the global npmrc rather than ~/.npmrc, which npm also reads as a
# project's when a command runs in the home directory, sudo's too.
box_home=$(getent passwd "$user" | cut -d: -f6)
runuser -u "$user" -- mkdir -p "$box_home/.local/bin" "$box_home/.local/lib"
printf 'prefix=%s/.local\nupdate-notifier=false\nfund=false\n' "$box_home" >"$node_prefix/etc/npmrc"
{ grep -v '^prefix=' /root/.npmrc 2>/dev/null || :; echo "prefix=/usr/local"; } >/root/.npmrc.new
mv /root/.npmrc.new /root/.npmrc
passwd -l "$user" >/dev/null
passwd -l root >/dev/null
# sudo resets the environment, which drops the DEBIAN_FRONTEND bb-box's
# commands export, so `sudo apt-get install` would warn or prompt.
printf 'Defaults env_keep += "DEBIAN_FRONTEND"\n%s ALL=(ALL) NOPASSWD:ALL\n' "$user" >"/etc/sudoers.d/90-$user"
chmod 0440 "/etc/sudoers.d/90-$user"
visudo -cf "/etc/sudoers.d/90-$user" >/dev/null
# BB's host daemon runs as a systemd user service, so the user's manager
# starts at boot.
install -d -m 0755 /var/lib/systemd/linger
touch "/var/lib/systemd/linger/$user"
# After a hard stop BB's daemon leaves its lock (a new daemon then waits about
# 8 s for it to go stale) and, without a service manager, a pid file that may
# name another process after the restart. Clear both at boot.
cat >/etc/tmpfiles.d/bb-box.conf <<EOF
# bb-box: BB daemon state a hard stop leaves behind.
R /home/$user/.bb-machines/*/daemon.lock.lock
r /home/$user/.bb-machines/*/install-daemon.pid
EOF

# The plugin's key, for the box user and root: in a Proxmox LXC box and a
# Tart VM. A Docker box has no SSH server running and no key: bb-box reaches it
# through `docker exec`.
if [ "$runtime" != docker ]; then
  key=$(cat "$build/plugin-key.pub")
  [[ "$key" == ssh-ed25519\ * ]] || die "plugin-key.pub is not an ed25519 public key"
  for home in /root "/home/$user"; do
    owner=root
    [ "$home" = /root ] || owner=$user
    install -d -m 0700 -o "$owner" -g "$owner" "$home/.ssh"
    printf '%s\n' "$key" >"$home/.ssh/authorized_keys"
    chown "$owner:$owner" "$home/.ssh/authorized_keys"
    chmod 0600 "$home/.ssh/authorized_keys"
  done
fi

# The network, only in a Proxmox LXC box. Docker sets up a Docker box's DNS
# and network, and a Tart VM keeps its own, with DNS from the Mac's DHCP.
if [ "$runtime" = lxc ]; then
  # DNS: systemd-resolved with fixed resolvers. Proxmox rewrites
  # /etc/resolv.conf at every start unless the marker exists, and its networkd
  # file for eth0 carries no DNS.
  installed systemd-resolved || die "systemd-resolved is not installed"
  install -d -m 0755 /etc/systemd/resolved.conf.d
  printf '[Resolve]\nDNS=%s\n' "${BOX_DNS:-1.1.1.1 9.9.9.9}" >/etc/systemd/resolved.conf.d/10-bb-box.conf
  systemctl enable systemd-networkd.service systemd-resolved.service >/dev/null
  ln -sf ../run/systemd/resolve/stub-resolv.conf /etc/resolv.conf
  : >/etc/.pve-ignore.resolv.conf
  # Only IPv4 matters for network-online (Docker waits for it).
  install -d -m 0755 /etc/systemd/system/systemd-networkd-wait-online.service.d
  cat >/etc/systemd/system/systemd-networkd-wait-online.service.d/10-bb-box.conf <<'EOF'
[Service]
ExecStart=
ExecStart=/usr/lib/systemd/systemd-networkd-wait-online --any --ipv4 --timeout=10
EOF
  # IPv4 only on eth0: IPv6 link-local DAD held network-online (and Docker)
  # back by 1.4 s. Proxmox rewrites eth0.network at each start but leaves
  # drop-ins alone.
  install -d -m 0755 /etc/systemd/network/eth0.network.d
  cat >/etc/systemd/network/eth0.network.d/10-bb-box.conf <<'EOF'
# bb-box: IPv4 only; no IPv6 link-local DAD delaying network-online.
[Network]
LinkLocalAddressing=no
IPv6AcceptRA=no
EOF

  # A box's address is often one a deleted box had. Announce the new MAC with a
  # gratuitous ARP as soon as the address is up; otherwise the host keeps a
  # stale neighbour entry and sends to the old MAC for up to 8 s.
  install -d -m 0755 /usr/local/libexec/bb-box
  cat >/usr/local/libexec/bb-box/announce <<'EOF'
#!/bin/sh
# bb-box: announce eth0's IPv4 address (gratuitous ARP) once it is configured.
for _ in $(seq 1 50); do
  addr=$(ip -4 -o addr show dev eth0 2>/dev/null | awk '{ split($4, a, "/"); print a[1]; exit }')
  [ -n "$addr" ] && break
  sleep 0.1
done
[ -n "$addr" ] || exit 0
exec arping -q -U -c 2 -I eth0 "$addr"
EOF
  chmod 0755 /usr/local/libexec/bb-box/announce
  cat >/etc/systemd/system/bb-box-announce.service <<'EOF'
[Unit]
Description=bb-box: announce this box's address to its neighbours
After=systemd-networkd.service
Wants=systemd-networkd.service

[Service]
Type=oneshot
ExecStart=-/usr/local/libexec/bb-box/announce

[Install]
WantedBy=multi-user.target
EOF
  systemctl enable bb-box-announce.service >/dev/null
fi

# Locale for tools that complain without one.
printf 'LANG=C.UTF-8\n' >/etc/default/locale

# BB's host daemon package, pre-installed where BB's installer looks for it.
[ -z "${BB_URL:-}" ] || bash "$build/guest/install-bb-app.sh" "$user" "$BB_URL" "$build/artifacts"

# A health check the plugin (or a person) can run as the box user.
install -m 0755 "$build/guest/check-headless.sh" /usr/local/bin/bb-box-check-headless
# Dev Container features for a project image's script (049).
install -m 0755 "$build/guest/bb-box-feature.sh" /usr/local/bin/bb-box-feature

install -m 0755 "$build/guest/bb-box-identity.sh" /usr/local/sbin/bb-box-identity
/usr/local/sbin/bb-box-identity disable
if [ "${BOX_IDENTITY_RESET:-off}" = on ]; then
  identity_options=()
  [ "$runtime" != docker ] || identity_options+=(--no-unit)
  [ -z "${BOX_IDENTITY_VALUE_FILE:-}" ] || identity_options+=(--value-file "$BOX_IDENTITY_VALUE_FILE")
  [ "${BOX_IDENTITY_MACHINE:-own}" != provider ] || identity_options+=(--machine-from-provider)
  /usr/local/sbin/bb-box-identity enable "${identity_options[@]}"
fi

case "${LINUX_GPU:-none}" in
  none) ;;
  nvidia)
    nvidia=$(bash "$build/guest/nvidia-userspace.sh" "$build")
    echo "nvidia=$nvidia" >>"$build/extra-release"
    ;;
  *) die "LINUX_GPU must be none or nvidia" ;;
esac

# What `uv tool install` and pipx put in ~/.local/bin runs by name, as it
# does in a login shell. Once: a refresh (049) runs this on a built image,
# where a later step may have put another directory first.
[[ ":$(sed -n 's/^PATH="\([^"]*\)"$/\1/p' /etc/environment):" == *":/home/$user/.local/bin:"* ]] ||
  sed -i "s|^PATH=\"|PATH=\"/home/$user/.local/bin:|" /etc/environment

# Every command BB and agents use must be on the box user's PATH over SSH,
# where pam_env sets PATH from /etc/environment.
box_path=$(sed -n 's/^PATH="\([^"]*\)"$/\1/p' /etc/environment)
[[ ":$box_path:" == *:/usr/local/bin:* ]] || die "/etc/environment PATH lacks /usr/local/bin"
[[ ":$box_path:" == *:/home/$user/.local/bin:* ]] || die "/etc/environment PATH lacks ~/.local/bin"
# shellcheck disable=SC2016
for command in git git-lfs gh node npm npx pnpm yarn python3 pip3 uv uvx rg fd jj claude codex pi curl wget jq \
  zip unzip zstd rsync tree bc socat netstat make gcc pkg-config sudo sshd runuser docker psql redis-cli sqlite3 \
  tmux vim nvim bb-box-feature; do
  runuser -u "$user" -- env PATH="$box_path" sh -c 'command -v "$1" >/dev/null' sh "$command" ||
    die "$command is not on $user's PATH"
done
# With a PATH of their own, as npm runs node by name: pct exec gives a 26.04
# CT a PATH without /usr/local/bin.
[ "$(runuser -u "$user" -- env HOME="$box_home" PATH="$box_path" npm config get prefix)" = "$box_home/.local" ] || die "npm's global prefix for $user is not $box_home/.local"
[ "$(env HOME=/root PATH=/usr/local/bin:/usr/bin:/bin npm config get prefix)" = /usr/local ] || die "npm's global prefix for root is not /usr/local"
docker compose version >/dev/null
docker buildx version >/dev/null
echo "customize-base: done"
