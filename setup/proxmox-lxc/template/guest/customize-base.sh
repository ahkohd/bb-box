#!/bin/bash
# bb-box base template, run as root inside a Proxmox Ubuntu 24.04 CT: the
# development baseline, pinned tools, Docker, the box user, SSH with the
# plugin's key, DNS and PATH. The desktop template runs this first too.
#
# usage: customize-base.sh <build-dir>
# <build-dir>/build.env sets BOX_USER, BOX_DNS and BB_URL (see build.sh).
set -Eeuo pipefail
trap 'echo "customize-base: line $LINENO failed: $BASH_COMMAND" >&2' ERR
umask 022

build=$1
# shellcheck disable=SC1091
. "$build/build.env"
user=${BOX_USER:-box}
export DEBIAN_FRONTEND=noninteractive
die() { echo "customize-base: $*" >&2; exit 1; }
installed() { [ "$(dpkg-query -W -f='${Status}' "$1" 2>/dev/null)" = "install ok installed" ]; }

# The base image may lack CA certificates, which the https snapshot needs.
installed ca-certificates || { apt-get update -q && apt-get install -y -q --no-install-recommends ca-certificates; }

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
docker_packages="docker.io docker-compose-v2 docker-buildx pigz postgresql-client redis-tools sqlite3"
extra_packages="openssh-server sudo systemd-resolved less nano vim-tiny iputils-ping iputils-arping dnsutils netcat-openbsd htop tmux file lsof strace"
# shellcheck disable=SC2086
bash "$build/guest/baseline.sh" "$build" $docker_packages $extra_packages
# npm installs global packages where they land on PATH (`sudo npm i -g x`).
node_prefix=$(dirname "$(dirname "$(readlink -f /usr/local/bin/node)")")
install -d -m 0755 "$node_prefix/etc"
printf 'prefix=/usr/local\nupdate-notifier=false\nfund=false\n' >"$node_prefix/etc/npmrc"

# The container shares the host's kernel.
if dpkg-query -W -f='${Package} ${Status}\n' | awk '$4 == "installed" { print $1 }' |
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
# profile at each boot is slow.
systemctl mask apparmor.service >/dev/null

# Docker: nesting=1 on the CT is all it needs. Keep its networks off
# 192.168.0.0/16, which is in Docker's default pools and often a home LAN.
install -d -m 0755 /etc/docker
cat >/etc/docker/daemon.json <<'EOF'
{
  "default-address-pools": [{ "base": "172.16.0.0/12", "size": 24 }]
}
EOF
systemctl enable containerd.service docker.service >/dev/null

# SSH: a plain service, keys only. The template holds no host keys; the
# service makes them before its first start in each clone. Only ed25519 and
# ECDSA: an RSA key costs 200 ms at first boot.
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
ExecStartPre=/bin/sh -c 'test -s /etc/ssh/ssh_host_ed25519_key || ssh-keygen -q -t ed25519 -N "" -f /etc/ssh/ssh_host_ed25519_key'
ExecStartPre=/bin/sh -c 'test -s /etc/ssh/ssh_host_ecdsa_key || ssh-keygen -q -t ecdsa -N "" -f /etc/ssh/ssh_host_ecdsa_key'
ExecStartPre=/usr/sbin/sshd -t
EOF
install -d -m 0755 /run/sshd
for t in ed25519 ecdsa; do
  [ -s "/etc/ssh/ssh_host_${t}_key" ] || ssh-keygen -q -t "$t" -N '' -f "/etc/ssh/ssh_host_${t}_key"
done
sshd -t

# The box user: uid 1000, passwordless sudo, Docker without sudo.
if ! id -u "$user" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --uid 1000 --user-group "$user"
fi
[ "$(id -u "$user")" = 1000 ] || die "$user must have uid 1000"
usermod -aG docker,adm "$user"
passwd -l "$user" >/dev/null
passwd -l root >/dev/null
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$user" >"/etc/sudoers.d/90-$user"
chmod 0440 "/etc/sudoers.d/90-$user"
visudo -cf "/etc/sudoers.d/90-$user" >/dev/null
# BB's host daemon runs as a systemd user service, so the user's manager
# starts at boot.
install -d -m 0755 /var/lib/systemd/linger
touch "/var/lib/systemd/linger/$user"

# The plugin's key, for the box user and root.
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

# Locale for tools that complain without one.
printf 'LANG=C.UTF-8\n' >/etc/default/locale

# BB's host daemon package, pre-installed where BB's installer looks for it.
# The installer then gets 304 for the same build and skips its download and
# npm install. A newer server build just downloads as usual.
if [ -n "${BB_URL:-}" ]; then
  # The directory name BB's installer derives from the server URL (its
  # `server_host`): the URL's host, port included, with anything outside
  # [A-Za-z0-9.-] replaced by "-".
  bb_host=$(/usr/local/bin/node -e \
    'process.stdout.write(new URL(process.argv[1]).host.replace(/[^a-zA-Z0-9.-]/gu, "-"))' "$BB_URL")
  [ -n "$bb_host" ] || die "cannot parse BB_URL $BB_URL"
  data_dir=/home/$user/.bb-machines/$bb_host
  digest=$(sed -n 's/^x-bb-artifact-sha256: *\([a-f0-9]\{64\}\).*/\1/Ip' "$build/artifacts/bb-app.headers" | tr -d '\r' | tail -1)
  [[ "$digest" =~ ^[a-f0-9]{64}$ ]] || die "no bb-app digest"
  echo "$digest  $build/artifacts/bb-app.tgz" | sha256sum -c --quiet - || die "bb-app.tgz does not match its digest"
  install -d -m 0755 -o "$user" -g "$user" "/home/$user/.bb-machines" "$data_dir"
  install -m 0644 -o "$user" -g "$user" "$build/artifacts/bb-app.tgz" "/home/$user/bb-app.tgz"
  runuser -u "$user" -- env HOME="/home/$user" PATH=/usr/local/bin:/usr/bin:/bin sh -c "
    cd \"\$HOME\" &&
    npm install -g --no-fund --no-audit --allow-scripts=better-sqlite3,node-pty,@parcel/watcher \
      --prefix '$data_dir/npm' \"\$HOME/bb-app.tgz\" &&
    node -e 'require(process.argv[1] + \"/node_modules/node-pty\"); require(process.argv[1] + \"/node_modules/@parcel/watcher\")' \
      '$data_dir/npm/lib/node_modules/bb-app' &&
    (umask 077 && printf '%s\n' '$digest' >'$data_dir/host-artifact.sha256')
  "
  rm -f "/home/$user/bb-app.tgz"
  for f in bin/bb-app bin/bb lib/node_modules/bb-app/host-daemon/dist/daemon-bundle.mjs; do
    [ -e "$data_dir/npm/$f" ] || die "bb-app is missing $f"
  done
fi

# A health check the plugin (or a person) can run as the box user.
install -m 0755 "$build/guest/check-headless.sh" /usr/local/bin/bb-box-check-headless

# Every command BB and agents use must be on the box user's PATH over SSH,
# where pam_env sets PATH from /etc/environment.
box_path=$(sed -n 's/^PATH="\([^"]*\)"$/\1/p' /etc/environment)
[[ ":$box_path:" == *:/usr/local/bin:* ]] || die "/etc/environment PATH lacks /usr/local/bin"
# shellcheck disable=SC2016
for command in git gh node npm npx python3 pip3 rg fd jj claude codex pi curl wget jq zip unzip rsync make gcc \
  pkg-config sudo sshd runuser docker psql redis-cli sqlite3 tmux; do
  runuser -u "$user" -- env PATH="$box_path" sh -c 'command -v "$1" >/dev/null' sh "$command" ||
    die "$command is not on $user's PATH"
done
docker compose version >/dev/null
docker buildx version >/dev/null
echo "customize-base: done"
