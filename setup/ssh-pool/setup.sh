#!/bin/sh
# Sets up a Linux machine for bb-box's SSH host pool. Copy this directory to
# the machine and run it there as root:
#
#   sudo sh setup.sh --key "ssh-ed25519 AAAA... bb-box" [--name build-1]
#     [--address 192.0.2.21] [--port 22] [--admin bbbox-admin]
#     [--reset-hook /path/to/reset-machine]
#
# --key is the public key bb-box's doctor shows. Give it once for each
# bb-box install that lends the machine. It:
#
# - makes bb-box's admin user, which accepts only those keys, with no
#   forwarding or terminal, and may run only bb-box's helper as root
# - installs the helper, machine.sh, as /usr/local/libexec/bb-box/machine,
#   and with --reset-hook the operator's whole-machine reset as
#   /usr/local/libexec/bb-box/reset-machine
# - clears BB's daemon lock and PID file in box homes at boot (017)
# - starts the machine's reset generation at 0
# - prints the line for bb-box's machines setting and the host keys
#
# Running it again updates the helper, the hook and the keys, and keeps the
# reset generation. It replaces the keys, so give every install's key again.

set -eu
umask 022
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

LIBEXEC=/usr/local/libexec/bb-box
here=$(cd "$(dirname "$0")" && pwd)
keys='' admin=bbbox-admin name='' address='' port='' hook=''

die() {
  printf 'setup.sh: %s\n' "$*" >&2
  exit 1
}
usage() { die "usage: setup.sh --key <public key> [--key <another install's key>] [--name <name>] [--address <host>] [--port <port>] [--admin <user>] [--reset-hook <path>]"; }

while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || usage
  case $1 in
    --key)
      case $2 in
        *"
"*) die "Give each --key one public key on one line." ;;
        "ssh-ed25519 "* | "ssh-rsa "* | "ecdsa-sha2-"*) ;;
        *) die "Give --key the public key bb-box's doctor shows, starting ssh-ed25519." ;;
      esac
      keys="$keys$2
"
      ;;
    --admin) admin=$2 ;;
    --name) name=$2 ;;
    --address) address=$2 ;;
    --port) port=$2 ;;
    --reset-hook) hook=$2 ;;
    *) usage ;;
  esac
  shift 2
done

[ "$(id -u)" = 0 ] || die "Run it as root, with sudo."
[ "$(uname -s)" = Linux ] || die "The SSH host pool lends Linux machines only."
[ -n "$keys" ] || die "Give --key the public key bb-box's doctor shows, starting ssh-ed25519."
printf '%s\n' "$admin" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$' || die "--admin must be a user name."
case $admin in bbx-*) die "bbx- names are for box users. Choose another admin user." ;; esac
[ -f "$here/machine.sh" ] || die "machine.sh must be beside setup.sh. Copy the whole setup/ssh-pool directory."
[ -z "$hook" ] || [ -f "$hook" ] || die "The reset hook $hook does not exist."

missing=''
for tool in sh tar flock setsid useradd userdel groupadd groupdel usermod pgrep pkill find getent sudo visudo; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || missing="$missing curl"
command -v sshd >/dev/null 2>&1 || [ -x /usr/sbin/sshd ] || missing="$missing sshd"
if [ -n "$missing" ]; then
  die "Install these first:$missing. On Debian or Ubuntu: apt-get install sudo util-linux procps findutils passwd tar curl openssh-server"
fi

# The admin user: no password, so only the key logs in, but not locked, which sshd refuses without PAM.
if getent passwd "$admin" >/dev/null; then
  [ "$(getent passwd "$admin" | cut -d: -f5)" = "bb-box admin" ] ||
    die "User $admin exists and setup.sh did not make it. Choose a new name for bb-box's admin user with --admin."
else
  useradd --system --create-home --home-dir "/var/lib/$admin" --shell /bin/sh --comment "bb-box admin" "$admin"
fi
usermod -p '*' "$admin"
home=$(getent passwd "$admin" | cut -d: -f6)
install -d -m 0700 -o "$admin" -g "$(id -g "$admin")" "$home/.ssh"
printf '%s' "$keys" | sed 's/^/restrict /' >"$home/.ssh/authorized_keys.new"
chown "$admin:$(id -g "$admin")" "$home/.ssh/authorized_keys.new"
chmod 0600 "$home/.ssh/authorized_keys.new"
mv -f "$home/.ssh/authorized_keys.new" "$home/.ssh/authorized_keys"

# The helper, and the operator's whole-machine reset.
install -d -m 0755 "$LIBEXEC"
install -m 0755 "$here/machine.sh" "$LIBEXEC/machine.new"
mv -f "$LIBEXEC/machine.new" "$LIBEXEC/machine"
if [ -n "$hook" ]; then
  install -m 0755 "$hook" "$LIBEXEC/reset-machine.new"
  mv -f "$LIBEXEC/reset-machine.new" "$LIBEXEC/reset-machine"
fi

# The admin user may run the helper as root, and nothing else.
rule=/etc/sudoers.d/bb-box
printf 'Defaults:%s !requiretty\n%s ALL=(root) NOPASSWD: %s/machine\n' "$admin" "$admin" "$LIBEXEC" >"$rule.new"
chmod 0440 "$rule.new"
visudo -cqf "$rule.new" >/dev/null || die "visudo refused the sudo rule in $rule.new."
mv -f "$rule.new" "$rule"

# 017: a box's BB daemon leaves its lock and PID file after a hard stop. Clear them at boot.
if [ -d /etc/tmpfiles.d ] || [ -d /run/systemd/system ]; then
  install -d -m 0755 /etc/tmpfiles.d
  cat >/etc/tmpfiles.d/bb-box.conf <<'EOF'
# bb-box: BB daemon state a hard stop leaves in box users' homes.
R /home/bbx-*/.bb-machines/*/daemon.lock.lock
r /home/bbx-*/.bb-machines/*/install-daemon.pid
EOF
fi

"$LIBEXEC/machine" init >/dev/null
status=$("$LIBEXEC/machine" status)
generation=$(printf '%s\n' "$status" | sed -n 's/^generation=//p')

# What sshd lets box users and the admin user do.
warnings=''
warn() { warnings="$warnings
- $*"; }
sshd=$(command -v sshd || echo /usr/sbin/sshd)
config=$("$sshd" -T 2>/dev/null || true)
if [ -z "$config" ]; then
  warn "sshd -T did not run, so its settings were not checked. Box users bbx-* and $admin must be able to log in with a key."
else
  value() { printf '%s\n' "$config" | sed -n "s/^$1 //p"; }
  [ "$(value pubkeyauthentication)" != no ] || warn "sshd has PubkeyAuthentication no. bb-box logs in with keys only."
  users=$(value allowusers) groups=$(value allowgroups)
  if [ -n "$users$groups" ]; then
    warn "sshd lets only some users log in (AllowUsers or AllowGroups). Allow $admin and bbx-*, for example AllowUsers $admin bbx-* followed by your own users."
  fi
  if value denyusers | grep -q .; then warn "sshd has DenyUsers. Check that it denies neither $admin nor bbx-*."; fi
fi

# What BB's installer and a box's GitHub access need.
node=$(printf '%s\n' "$status" | sed -n 's/^node=v\{0,1\}//p')
lacks=$(printf '%s\n' "$status" | sed -n 's/^lacks=//p' | sed 's/ /, /g')
if [ -z "$node" ]; then
  warn "Node.js is missing. BB's installer needs Node.js 22.19 or newer with npm, such as Node.js 24 from NodeSource. Debian's and Ubuntu's own nodejs is too old."
elif ! printf '%s\n' "$node" | awk -F. '{ exit !($1 > 22 || ($1 == 22 && $2 >= 19)) }'; then
  warn "Node.js is $node, but BB's installer needs 22.19 or newer with npm, such as Node.js 24 from NodeSource."
fi
[ -z "$lacks" ] || warn "This machine lacks $lacks. BB's installer needs npm, and boxes need git and gh for the thread's GitHub access. On Debian or Ubuntu: apt-get install git gh."

docker=no
command -v docker >/dev/null 2>&1 && getent group docker >/dev/null && docker=yes
if [ -x "$LIBEXEC/reset-machine" ]; then
  reset=machine
  kinds=linux
  [ "$docker" = no ] || kinds=linux,linux-docker
else
  reset=home
  kinds=linux
  [ "$docker" = no ] || warn "Docker is installed, but linux-docker needs a whole-machine reset: run setup.sh again with --reset-hook. Until then boxes here are not in the docker group."
fi

[ -n "$name" ] || name=$(hostname -s 2>/dev/null | tr 'A-Z_.' 'a-z--' || true)
[ -n "$name" ] || name=machine
[ -n "$address" ] || address=$(hostname -I 2>/dev/null | awk '{ print $1 }')
[ -n "$address" ] || address=$(hostname -f 2>/dev/null || hostname)
[ -n "$port" ] || port=$(printf '%s\n' "$config" | sed -n 's/^port //p' | head -n 1)
[ -n "$port" ] || port=22
case $address in *:*) target="[$address]" ;; *) target=$address ;; esac
[ "$port" = 22 ] || target="$target:$port"
known=$address
[ "$port" = 22 ] || known="[$address]:$port"
line="$name $admin@$target $kinds"
[ "$reset" = home ] || line="$line reset=machine"

echo "This machine is ready for bb-box's SSH host pool, at reset generation $generation."
echo
echo "Add this line to the SSH host pool's machines setting. Use another name or address if bb-box reaches it by another:"
echo
echo "  $line"
echo
echo "Add these lines to the SSH host pool's host keys setting:"
echo
for file in /etc/ssh/ssh_host_*_key.pub; do
  [ -f "$file" ] || continue
  printf '  %s %s\n' "$known" "$(cut -d' ' -f1,2 "$file")"
done
if [ -n "$warnings" ]; then
  echo
  echo "Check these before you add it:$warnings"
fi
