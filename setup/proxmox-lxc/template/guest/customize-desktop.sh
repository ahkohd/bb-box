#!/bin/bash
# bb-box desktop template, run as root inside the CT after customize-base.sh
# and before finalize.sh: XFCE on :99 as the box user, Xorg with NVIDIA's
# driver (or Xtigervnc on the CPU as fallback) served over VNC on port 5900,
# Selkies' H.264 stream of it on 127.0.0.1:5980 (056), Chrome, Mousepad, Ristretto, Evince, Cua Driver, NVIDIA userspace matching
# the host, VirtualGL, GPUI build dependencies and Rust.
#
# usage: customize-desktop.sh <build-dir>
# build.env as for customize-base.sh, DESKTOP_GPU, and DESKTOP_SESSION:
# x11 (the default) or wayland, which customize-desktop-wayland.sh makes (048).
set -Eeuo pipefail
trap 'echo "customize-desktop: line $LINENO failed: $BASH_COMMAND" >&2' ERR
umask 022

build=$1
# shellcheck disable=SC1091
. "$build/build.env"
[ "${DESKTOP_SESSION:-x11}" != wayland ] || exec bash "$build/guest/customize-desktop-wayland.sh" "$build"
art=$build/artifacts
user=${BOX_USER:-box}
runtime=${BOX_RUNTIME:-lxc}
export DEBIAN_FRONTEND=noninteractive
die() { echo "customize-desktop: $*" >&2; exit 1; }
[ -f /etc/apt/apt.conf.d/50bb-box-build-snapshot ] || die "run customize-base.sh first (no apt snapshot)"
# 1000 except in a Tart VM, where the image's own user has it (customize-base.sh).
uid=$(id -u "$user") || die "no user $user (run customize-base.sh first)"

# desktop-pins.tsv columns: name, file, URL, SHA-256, architecture.
case "$(uname -m)" in
  x86_64) arch=x86_64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "no desktop artifacts are pinned for $(uname -m)" ;;
esac
pin() { awk -F'\t' -v n="$1" -v a="$arch" '$1 == n && $5 == a { print $4 }' "$build/desktop-pins.tsv"; }
file_of() { awk -F'\t' -v n="$1" -v a="$arch" '$1 == n && $5 == a { print $2 }' "$build/desktop-pins.tsv"; }
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
# The small apps people and agents expect on a desktop: a text editor, an
# image viewer, a PDF viewer and the panel's application finder (about 40 MiB).
desktop_packages="$desktop_packages mousepad ristretto evince xfce4-appfinder"
# Chinese, Japanese and Korean text, sans and serif, regular and bold (88 MiB).
# Without it web pages in Chrome show empty boxes for them.
desktop_packages="$desktop_packages fonts-noto-cjk"
# What Zed's GPUI needs to build on Linux.
gpui_packages="clang cmake libxkbcommon-dev libxkbcommon-x11-dev libwayland-dev libx11-xcb-dev libxcb1-dev
  libfontconfig-dev libfreetype-dev libssl-dev libzstd-dev libvulkan-dev libasound2-dev"
# TigerVNC comes from its own release: Ubuntu 24.04's 1.13 has no clipboard
# in x0vncserver and lacks later security fixes.
tigervnc=$(check tigervnc)
virtualgl=$(check virtualgl)
chrome=$(check chrome)
# Selkies, the desktop's second stream (056): its package holds its own
# Python, in /opt/selkies.
selkies=$(check selkies)
# A refresh of a built image (049) may have a newer Chrome already, which
# Google's apt source brought: keep it rather than go back to the pin. A
# build from a fresh image, as Tart's, has none yet.
installed=$(dpkg-query -W -f='${Status} ${Version}' google-chrome-stable 2>/dev/null | sed -n 's/^install ok installed //p' || true)
if [ -n "$installed" ] && dpkg --compare-versions "$installed" ge "$(dpkg-deb -f "$chrome" Version)"; then
  echo "customize-desktop: keeping Chrome $installed, as new as the pin or newer"
  chrome=
fi
# Downloads are retried through snapshot.ubuntu.com's short outages, as in
# baseline.sh; files already downloaded stay in apt's cache.
# shellcheck disable=SC2086
for try in 1 2 3 4 5; do
  apt-get install -y -q --no-install-recommends --download-only $desktop_packages $gpui_packages "$tigervnc" "$virtualgl" "$selkies" ${chrome:+"$chrome"} && break
  [ "$try" = 5 ] && exit 1
  echo "customize-desktop: download failed (try $try of 5); retrying in $((try * 30)) s" >&2
  sleep $((try * 30))
done
# shellcheck disable=SC2086
apt-get install -y -q --no-install-recommends $desktop_packages $gpui_packages "$tigervnc" "$virtualgl" "$selkies" ${chrome:+"$chrome"}
for package in $desktop_packages $gpui_packages tigervncserver virtualgl selkies google-chrome-stable; do
  [ "$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null)" = "install ok installed" ] || die "$package is not installed"
done

# NVIDIA userspace: exactly the host's version, no kernel modules. The display
# unit compares this record with the host's driver at every start. A CPU-only
# template (DESKTOP_GPU=none) has none, and its display always takes the CPU.
install -d -m 0755 /usr/share/bb-box
if [ "${DESKTOP_GPU:-nvidia}" = none ]; then
  nvidia=none
elif [ "$arch" != x86_64 ]; then
  die "a desktop on $arch is CPU-only: set DESKTOP_GPU=none"
else
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
  echo "$nvidia" >/usr/share/bb-box/nvidia-version
fi
{
  echo "nvidia=$nvidia"
  for name in tigervnc virtualgl selkies chrome cua-driver rustup; do echo "$name=$(file_of "$name")"; done
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
install -m 0755 "$build/guest/files/selkies" /usr/local/libexec/bb-box/selkies
install -m 0644 "$build/guest/files/chrome-gpu.mjs" /usr/local/libexec/bb-box/chrome-gpu.mjs
install -m 0644 "$build/guest/files/cua-probe.mjs" /usr/local/libexec/bb-box/cua-probe.mjs
display_mode=auto
[ "$nvidia" != none ] || display_mode=cpu
cat >/etc/bb-box/desktop.env <<EOF
# bb-box desktop settings, read by bb-box-display.service at each start.
# DISPLAY_MODE: auto (the GPU if usable, else the CPU), gpu or cpu.
DISPLAY_MODE=$display_mode
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
# Bring the session and Selkies back whenever the display is up again.
Upholds=bb-box-session.service bb-box-selkies.service

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
After=bb-box-display.service user@$uid.service
Requires=bb-box-display.service
Wants=user@$uid.service
PartOf=bb-box-display.service

[Service]
User=$user
Group=$user
WorkingDirectory=~
# The PATH and variables the box user's commands have, as ~/.local/bin for npm's and uv's commands.
EnvironmentFile=-/etc/environment
Environment=DISPLAY=:99 XAUTHORITY=/run/bb-box/Xauthority XDG_RUNTIME_DIR=/run/user/$uid
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus XDG_SESSION_TYPE=x11
Environment=XDG_CURRENT_DESKTOP=XFCE XDG_SESSION_DESKTOP=xfce
EnvironmentFile=-/run/bb-box/display.env
ExecStart=/usr/bin/xfce4-session
# Cua Driver's daemon lives and dies with the session (and its X connection).
ExecStartPost=-/usr/bin/systemctl --user restart bb-box-cua-driver.service
ExecStopPost=-/usr/bin/systemctl --user stop bb-box-cua-driver.service
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
EOF
# Selkies' stream of :99, which starts and stops with the display.
cat >/etc/systemd/system/bb-box-selkies.service <<EOF
[Unit]
Description=bb-box: Selkies' stream of :99 on 127.0.0.1:5980
After=bb-box-display.service
Requires=bb-box-display.service
PartOf=bb-box-display.service

[Service]
User=$user
Group=$user
WorkingDirectory=~
ExecStart=/usr/local/libexec/bb-box/selkies
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
EOF
systemctl enable bb-box-vnc-password.service bb-box-display.service bb-box-session.service \
  bb-box-selkies.service >/dev/null

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
# Chrome's sandbox needs namespaces that Docker's default seccomp profile
# refuses to an unprivileged container, so in a Docker box Chrome runs without
# it, and without the bar that warns of the flag on every window.
sandbox=
if [ "$runtime" = docker ]; then
  sandbox=" --no-sandbox"
  printf '{\n  "CommandLineFlagSecurityWarningsEnabled": false\n}\n' >/etc/opt/chrome/policies/managed/bb-box-docker.json
  chmod 0644 /etc/opt/chrome/policies/managed/bb-box-docker.json
  # A Docker host's own AppArmor policy can name /opt/google/chrome/chrome,
  # as Ubuntu's chrome profile does. A box with Docker runs privileged and
  # unconfined, so Chrome took that profile as it started, and its sockets
  # were refused there: no page loaded and DevTools did not start (#596).
  # Chrome lives elsewhere, and its old path is a link, which AppArmor
  # resolves before it matches; the wrapper and apt go through the link.
  install -d -m 0755 /opt/bb-box
  mv /opt/google/chrome /opt/bb-box/chrome
  ln -s /opt/bb-box/chrome /opt/google/chrome
fi
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
  exec $bin.distrib --force-renderer-accessibility$sandbox --ignore-gpu-blocklist "\$@"
fi
exec $bin.distrib --force-renderer-accessibility$sandbox "\$@"
EOF
chmod 0755 "$bin.bb-box"
mv -f "$bin.bb-box" "$bin"
# Chrome also claims images and PDFs; they open in the viewers made for them.
cat >/etc/xdg/mimeapps.list <<'EOF'
[Default Applications]
x-scheme-handler/http=google-chrome.desktop
x-scheme-handler/https=google-chrome.desktop
text/html=google-chrome.desktop
text/plain=org.xfce.mousepad.desktop
application/pdf=org.gnome.Evince.desktop
image/png=org.xfce.ristretto.desktop
image/jpeg=org.xfce.ristretto.desktop
image/gif=org.xfce.ristretto.desktop
image/bmp=org.xfce.ristretto.desktop
image/tiff=org.xfce.ristretto.desktop
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
# No telemetry and no update check, for every way it runs: the daemon, the
# plugin's `cua-driver mcp --socket` proxy over SSH and a person's shell. The
# environment covers SSH and user services; the config file covers the rest.
# Both are in place before Cua first runs.
grep -q '^CUA_DRIVER_RS_TELEMETRY_ENABLED=' /etc/environment ||
  printf 'CUA_DRIVER_RS_TELEMETRY_ENABLED=false\nCUA_DRIVER_RS_UPDATE_CHECK=false\n' >>/etc/environment
printf 'CUA_DRIVER_RS_TELEMETRY_ENABLED=false\nCUA_DRIVER_RS_UPDATE_CHECK=false\n' >/etc/environment.d/61-bb-box-cua-driver.conf
for home in /root "/home/$user"; do
  owner=root
  [ "$home" = /root ] || owner=$user
  install -d -m 0755 -o "$owner" -g "$owner" "$home/.cua-driver"
  printf '{\n  "telemetry_enabled": false,\n  "update_check_enabled": false\n}\n' >"$home/.cua-driver/config.json"
  chown "$owner:$owner" "$home/.cua-driver/config.json"
done
# One daemon per box in the box user's systemd manager, with the desktop's
# display; bb-box-session starts and stops it. It listens on
# ~/.cache/cua-driver/cua-driver.sock, and element references live as long
# as it does.
cat >/etc/systemd/user/bb-box-cua-driver.service <<'EOF'
[Unit]
Description=bb-box: Cua Driver daemon for the desktop on :99

[Service]
Environment=DISPLAY=:99 XAUTHORITY=/run/bb-box/Xauthority
Environment=CUA_DRIVER_RS_TELEMETRY_ENABLED=false CUA_DRIVER_RS_UPDATE_CHECK=false
EnvironmentFile=-/run/bb-box/display.env
ExecStart=/usr/local/bin/cua-driver serve
Restart=always
RestartSec=1
EOF

# Rust for the box user (GPUI and other native work). Projects'
# rust-toolchain.toml files pull their own toolchains on first use.
install -m 0755 "$(check rustup)" /var/tmp/rustup-init
# rustup downloads the toolchain itself; try again if the network drops.
for attempt in 1 2 3; do
  runuser -u "$user" -- env HOME="/home/$user" PATH=/usr/local/bin:/usr/bin:/bin \
    /var/tmp/rustup-init -y -q --profile minimal --default-toolchain stable -c rustfmt -c clippy \
    --no-modify-path && break
  [ "$attempt" -lt 3 ] || die "rustup could not install the stable toolchain"
  sleep 5
done
rm -f /var/tmp/rustup-init
grep -q "^PATH=\"/home/$user/.cargo/bin:" /etc/environment ||
  sed -i "s|^PATH=\"|PATH=\"/home/$user/.cargo/bin:|" /etc/environment
grep -q "^PATH=\"/home/$user/.cargo/bin:" /etc/environment || die "could not add cargo to PATH"

install -m 0755 "$build/guest/check-desktop.sh" /usr/local/bin/bb-box-check-desktop
rm -rf /home/*/.config/google-chrome /root/.config/google-chrome
echo "customize-desktop: done"
