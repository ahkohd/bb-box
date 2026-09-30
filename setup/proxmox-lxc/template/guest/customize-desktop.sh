#!/bin/bash
# bb-box desktop template, run as root inside the CT after customize-base.sh
# and before finalize.sh: XFCE on :99 as the box user, Xorg with NVIDIA's
# driver (or Xtigervnc on the CPU as fallback) served over VNC on port 5900,
# Chrome, Cua Driver, NVIDIA userspace matching the host, VirtualGL, GPUI build
# dependencies and Rust.
#
# usage: customize-desktop.sh <build-dir>
set -Eeuo pipefail
trap 'echo "customize-desktop: line $LINENO failed: $BASH_COMMAND" >&2' ERR
umask 022

build=$1
# shellcheck disable=SC1091
. "$build/build.env"
art=$build/artifacts
user=${BOX_USER:-box}
export DEBIAN_FRONTEND=noninteractive
die() { echo "customize-desktop: $*" >&2; exit 1; }
[ -f /etc/apt/apt.conf.d/50bb-box-build-snapshot ] || die "run customize-base.sh first (no apt snapshot)"

# desktop-pins.tsv columns: name, file, URL, SHA-256.
pin() { awk -F'\t' -v n="$1" '$1 == n { print $4 }' "$build/desktop-pins.tsv"; }
file_of() { awk -F'\t' -v n="$1" '$1 == n { print $2 }' "$build/desktop-pins.tsv"; }
check() { # pin name -> path of the checked artifact
  local f
  f=$art/$(file_of "$1")
  echo "$(pin "$1")  $f" | sha256sum -c --quiet - >&2 || die "$1 does not match its pinned SHA-256"
  echo "$f"
}

# Packages. Without recommends: no display manager, screensaver or power
# manager, and no Xorg input drivers (the virtual screen has none).
desktop_packages="xserver-xorg-core xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-terminal xfconf
  xfce4-settings thunar xauth dbus-x11 dbus-user-session x11-xserver-utils x11-utils xinput xterm scrot
  ffmpeg xdotool wmctrl xclip xsel xdg-utils fonts-dejavu-core fonts-liberation fonts-noto-color-emoji
  arc-theme at-spi2-core libvulkan1 vulkan-tools mesa-vulkan-drivers mesa-utils libegl1 libgl1 libgles2
  libglvnd0 libglx0 pciutils"
# What Zed's GPUI needs to build on Linux.
gpui_packages="clang cmake libxkbcommon-dev libxkbcommon-x11-dev libwayland-dev libx11-xcb-dev libxcb1-dev
  libfontconfig-dev libfreetype-dev libssl-dev libzstd-dev libvulkan-dev libasound2-dev"
tigervnc=$(check tigervnc)
virtualgl=$(check virtualgl)
chrome=$(check chrome)
# TigerVNC comes from its own release: Ubuntu 24.04's 1.13 has no clipboard
# in x0vncserver and lacks later security fixes.
# shellcheck disable=SC2086
apt-get install -y -q --no-install-recommends $desktop_packages $gpui_packages "$tigervnc" "$virtualgl" "$chrome"
for package in $desktop_packages $gpui_packages tigervncserver virtualgl google-chrome-stable; do
  [ "$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null)" = "install ok installed" ] || die "$package is not installed"
done

# NVIDIA userspace: exactly the host's version, no kernel modules. The display
# unit compares this record with the host's driver at every start.
nvidia=$(cat /sys/module/nvidia/version 2>/dev/null) || die "the host has no NVIDIA driver loaded"
run=$art/NVIDIA-Linux-x86_64-$nvidia.run
[ -f "$run" ] || die "$run is missing (fetch-artifacts.sh downloads the host's version)"
(cd "$art" && sha256sum -c --quiet "NVIDIA-Linux-x86_64-$nvidia.run.sha256sum") || die "NVIDIA installer checksum mismatch"
sh "$run" --silent --no-kernel-modules --no-kernel-module-source --no-nouveau-check --no-nvidia-modprobe \
  --no-systemd --no-rpms --no-backup --no-check-for-alternate-installs --no-x-check --no-distro-scripts \
  --no-dkms --no-install-libglvnd --glvnd-egl-config-path=/usr/share/glvnd/egl_vendor.d --tmpdir /var/tmp
for f in /usr/lib/xorg/modules/drivers/nvidia_drv.so /usr/lib/xorg/modules/extensions/libglxserver_nvidia.so \
  /etc/vulkan/icd.d/nvidia_icd.json /usr/share/glvnd/egl_vendor.d/10_nvidia.json /usr/bin/nvidia-smi; do
  [ -e "$f" ] || die "the NVIDIA installer did not install $f"
done
install -d -m 0755 /usr/share/bb-box
echo "$nvidia" >/usr/share/bb-box/nvidia-version
{
  echo "nvidia=$nvidia"
  for name in tigervnc virtualgl chrome cua-driver rustup; do echo "$name=$(file_of "$name")"; done
} >"$build/extra-release"

# Xorg on the one GPU the CT can see, with no display attached.
cat >/etc/X11/bb-box-xorg.conf <<'EOF'
# bb-box: Xorg with NVIDIA's driver on a virtual screen, for bb-box-display.
Section "ServerFlags"
  Option "AutoAddDevices" "false"
  Option "AutoAddGPU" "false"
  Option "DontVTSwitch" "true"
  Option "BlankTime" "0"
  Option "StandbyTime" "0"
  Option "SuspendTime" "0"
  Option "OffTime" "0"
EndSection
Section "Device"
  Identifier "nvidia"
  Driver "nvidia"
  Option "AllowEmptyInitialConfiguration" "true"
  Option "UseDisplayDevice" "none"
  Option "ProbeAllGpus" "false"
EndSection
Section "Screen"
  Identifier "screen"
  Device "nvidia"
  DefaultDepth 24
  Option "AllowEmptyInitialConfiguration" "true"
  SubSection "Display"
    Depth 24
    Virtual 1920 1080
  EndSubSection
EndSection
Section "ServerLayout"
  Identifier "layout"
  Screen 0 "screen"
EndSection
EOF

# The display and session units, both as the box user.
install -d -m 0755 /usr/local/libexec/bb-box /etc/bb-box
install -m 0755 "$build/guest/files/display" /usr/local/libexec/bb-box/display
install -m 0755 "$build/guest/files/vnc-password" /usr/local/libexec/bb-box/vnc-password
install -m 0644 "$build/guest/files/chrome-gpu.mjs" /usr/local/libexec/bb-box/chrome-gpu.mjs
install -m 0644 "$build/guest/files/cua-probe.mjs" /usr/local/libexec/bb-box/cua-probe.mjs
cat >/etc/bb-box/desktop.env <<'EOF'
# bb-box desktop settings, read by bb-box-display.service at each start.
# DISPLAY_MODE: auto (the GPU if usable, else the CPU), gpu or cpu.
DISPLAY_MODE=auto
# auto picks the CPU when the GPU has less free memory than this: enough for
# Xorg and Chrome's GPU process.
MIN_FREE_VRAM_MIB=384
# The CPU path's screen size; the GPU path is fixed by /etc/X11/bb-box-xorg.conf.
DISPLAY_GEOMETRY=1920x1080
# VNC_AUTH: password (from /var/lib/bb-box/vnc-password) or none.
VNC_AUTH=password
EOF
cat >/etc/systemd/system/bb-box-vnc-password.service <<EOF
[Unit]
Description=bb-box: make this box's VNC password on first boot
ConditionPathExists=!/var/lib/bb-box/vnc.passwd
Before=bb-box-display.service

[Service]
Type=oneshot
ExecStart=/usr/local/libexec/bb-box/vnc-password $user

[Install]
WantedBy=multi-user.target
EOF
cat >/etc/systemd/system/bb-box-display.service <<EOF
[Unit]
Description=bb-box: display :99 and VNC on port 5900
After=systemd-user-sessions.service bb-box-vnc-password.service
Wants=bb-box-vnc-password.service
# Bring the session back whenever the display is up again.
Upholds=bb-box-session.service

[Service]
User=$user
Group=$user
EnvironmentFile=-/etc/bb-box/desktop.env
RuntimeDirectory=bb-box
RuntimeDirectoryMode=0755
WorkingDirectory=~
ExecStart=/usr/local/libexec/bb-box/display
ExecStartPost=/usr/local/libexec/bb-box/display wait
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
EOF
cat >/etc/systemd/system/bb-box-session.service <<EOF
[Unit]
Description=bb-box: XFCE session on :99
After=bb-box-display.service user@1000.service
Requires=bb-box-display.service
Wants=user@1000.service
PartOf=bb-box-display.service

[Service]
User=$user
Group=$user
WorkingDirectory=~
Environment=DISPLAY=:99 XAUTHORITY=/run/bb-box/Xauthority XDG_RUNTIME_DIR=/run/user/1000
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus XDG_SESSION_TYPE=x11
Environment=XDG_CURRENT_DESKTOP=XFCE XDG_SESSION_DESKTOP=xfce
EnvironmentFile=-/run/bb-box/display.env
ExecStart=/usr/bin/xfce4-session
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
EOF
systemctl enable bb-box-vnc-password.service bb-box-display.service bb-box-session.service >/dev/null

# Everything the box user runs (SSH commands, BB's user services, Cua) lands
# on :99.
grep -q '^DISPLAY=' /etc/environment || printf 'DISPLAY=:99\nXAUTHORITY=/run/bb-box/Xauthority\n' >>/etc/environment
install -d -m 0755 /etc/environment.d
printf 'DISPLAY=:99\nXAUTHORITY=/run/bb-box/Xauthority\n' >/etc/environment.d/60-bb-box-display.conf
# The display path's own settings (see files/display), for login shells and
# for the box user's SSH commands: bash reads ~/.bashrc for those, so this
# goes above Ubuntu's early return for non-interactive shells.
cat >/etc/profile.d/bb-box-display.sh <<'EOF'
# bb-box: settings for the desktop's current display path.
if [ -r /run/bb-box/display.env ]; then set -a; . /run/bb-box/display.env; set +a; fi
EOF
bashrc=/home/$user/.bashrc
if ! grep -q bb-box-display "$bashrc"; then
  { echo '. /etc/profile.d/bb-box-display.sh  # bb-box-display'; cat "$bashrc"; } >"$bashrc.new"
  chown "$user:$user" "$bashrc.new"
  mv "$bashrc.new" "$bashrc"
fi

# XFCE for the box user: the default panel without the first-run question and
# no compositing (nothing to gain on a scraped screen).
xfconf=/home/$user/.config/xfce4/xfconf/xfce-perchannel-xml
install -d -o "$user" -g "$user" "/home/$user/.config" "/home/$user/.config/xfce4" \
  "/home/$user/.config/xfce4/xfconf" "$xfconf"
install -m 0644 -o "$user" -g "$user" /etc/xdg/xfce4/panel/default.xml "$xfconf/xfce4-panel.xml"
cat >"$xfconf/xfwm4.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfwm4" version="1.0">
  <property name="general" type="empty">
    <property name="use_compositing" type="bool" value="false"/>
    <property name="theme" type="string" value="Arc"/>
  </property>
</channel>
EOF
cat >"$xfconf/xsettings.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xsettings" version="1.0">
  <property name="Net" type="empty">
    <property name="ThemeName" type="string" value="Arc"/>
  </property>
</channel>
EOF
chown "$user:$user" "$xfconf/xfwm4.xml" "$xfconf/xsettings.xml"

# Chrome without first-run screens. The template's builder accepts Google
# Chrome's terms on the user's behalf (require_eula false); each policy below
# removes one first-run screen on a fresh profile. Remote debugging stays
# allowed: agents profile web apps over the DevTools protocol.
cat >/opt/google/chrome/initial_preferences <<'EOF'
{ "distribution": { "require_eula": false } }
EOF
install -d -m 0755 /etc/opt/chrome/policies/managed
cat >/etc/opt/chrome/policies/managed/bb-box-first-run.json <<'EOF'
{
  "MetricsReportingEnabled": false,
  "DefaultBrowserSettingEnabled": false,
  "PromotionsEnabled": false,
  "BrowserSignin": 0,
  "SyncDisabled": true
}
EOF
chmod 0644 /opt/google/chrome/initial_preferences /etc/opt/chrome/policies/managed/bb-box-first-run.json
# Computer use reads web pages through AT-SPI, which Chrome builds only with
# --force-renderer-accessibility. The diversion covers every way Chrome
# starts and survives upgrades.
bin=/usr/bin/google-chrome-stable
dpkg-divert --local --rename --divert "$bin.distrib" --add "$bin" >/dev/null
# On the CPU display path Chrome would turn off WebGL, WebGPU and compositing
# for Mesa's software renderer; --ignore-gpu-blocklist keeps them, slowly.
cat >"$bin.bb-box" <<EOF
#!/bin/sh
# bb-box: Chrome builds the accessibility tree computer use reads, and keeps
# WebGL on the CPU display path. Installed over a dpkg diversion by the bb-box
# desktop template.
if [ "\$(cat /run/bb-box/display-mode 2>/dev/null)" = cpu ]; then
  exec $bin.distrib --force-renderer-accessibility --ignore-gpu-blocklist "\$@"
fi
exec $bin.distrib --force-renderer-accessibility "\$@"
EOF
chmod 0755 "$bin.bb-box"
mv -f "$bin.bb-box" "$bin"
cat >/etc/xdg/mimeapps.list <<'EOF'
[Default Applications]
x-scheme-handler/http=google-chrome.desktop
x-scheme-handler/https=google-chrome.desktop
text/html=google-chrome.desktop
EOF
install -d -m 0755 /etc/xdg/xfce4
printf 'WebBrowser=google-chrome\nTerminalEmulator=xfce4-terminal\nFileManager=thunar\n' >/etc/xdg/xfce4/helpers.rc

# Cua Driver, the official Linux release, with both pinned checksums.
cua_tarball=$(check cua-driver)
cua_version=$(sed -n 's/.*cua-driver-rs-\([0-9.]*\)-linux.*/\1/p' <<<"$cua_tarball")
cua=/opt/cua-driver/$cua_version
rm -rf "$cua"
install -d -m 0755 /opt/cua-driver "$cua"
tar -xzf "$cua_tarball" -C "$cua" --no-same-owner
echo "$(pin cua-driver-binary)  $cua/cua-driver" | sha256sum -c --quiet - || die "cua-driver binary checksum mismatch"
ln -sfn "$cua/cua-driver" /usr/local/bin/cua-driver

# Rust for the box user (GPUI and other native work). Projects'
# rust-toolchain.toml files pull their own toolchains on first use.
install -m 0755 "$(check rustup)" /var/tmp/rustup-init
runuser -u "$user" -- env HOME="/home/$user" PATH=/usr/local/bin:/usr/bin:/bin \
  /var/tmp/rustup-init -y -q --profile minimal --default-toolchain stable -c rustfmt -c clippy --no-modify-path
rm -f /var/tmp/rustup-init
grep -q "^PATH=\"/home/$user/.cargo/bin:" /etc/environment ||
  sed -i "s|^PATH=\"|PATH=\"/home/$user/.cargo/bin:|" /etc/environment
grep -q "^PATH=\"/home/$user/.cargo/bin:" /etc/environment || die "could not add cargo to PATH"

install -m 0755 "$build/guest/check-desktop.sh" /usr/local/bin/bb-box-check-desktop
rm -rf /home/*/.config/google-chrome /root/.config/google-chrome
echo "customize-desktop: done"
