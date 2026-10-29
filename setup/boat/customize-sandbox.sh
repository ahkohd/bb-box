#!/bin/bash
set -euo pipefail
build=$1
. "$build/build.env"
user=${BOX_USER:-box}

for unit in lightdm.service sunshine.service moonlight-web.service gnome-remote-desktop.service ascii-streaming-audio.service; do
  systemctl disable --now "$unit" >/dev/null 2>&1 || :
  systemctl mask "$unit" >/dev/null 2>&1 || :
done
systemctl set-default multi-user.target >/dev/null

getent group kvm >/dev/null && usermod -aG kvm "$user"

find /etc/systemd/system -xtype l -delete

install -d -m 0755 /usr/local/lib/bb-box
cat >/usr/local/lib/bb-box/boat-ready <<'SCRIPT'
#!/bin/sh
systemctl reset-failed
if [ -e /usr/local/lib/bb-box/bin/cua-driver ] && [ "$(readlink -f /usr/local/bin/cua-driver)" != "$(readlink -f /usr/local/lib/bb-box/bin/cua-driver)" ]; then
  ln -sfn "$(readlink -f /usr/local/lib/bb-box/bin/cua-driver)" /usr/local/bin/cua-driver
fi
install -d -m 0755 /run/bb-box
touch /run/bb-box/boat-ready
SCRIPT
chmod 0755 /usr/local/lib/bb-box/boat-ready
cat >/etc/systemd/system/bb-box-boat-ready.service <<'UNIT'
[Unit]
Description=bb-box: the box as its template left it, once boat has restored its system files
After=docker.service ssh.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/lib/bb-box/boat-ready

[Install]
WantedBy=multi-user.target
UNIT
systemctl enable bb-box-boat-ready.service docker.service containerd.service >/dev/null
