#!/bin/bash
# bb-box Wayland desktop template (048), run as root inside the CT after
# customize-base.sh and before finalize.sh; customize-desktop.sh hands over to
# it when DESKTOP_SESSION=wayland. Sway, headless on the CPU, as the box user,
# with floating windows, Waybar, a launcher (wofi) and a terminal (foot),
# streamed by wayvnc on port 5900 with Apple's sign-in (type 30), and as
# video by Selkies on 127.0.0.1:5980, capturing Sway (060); Chrome
# native on Wayland, Mousepad, Ristretto, Evince, Thunar, Cua Driver with its
# Wayland adapter, GPUI build dependencies and Rust. No Xwayland and no
# DISPLAY: one X11 window breaks Cua on Sway.
#
# usage: customize-desktop-wayland.sh <build-dir>
# build.env as for customize-base.sh. CPU only: DESKTOP_GPU must be none.
set -Eeuo pipefail
trap 'echo "customize-desktop-wayland: line $LINENO failed: $BASH_COMMAND" >&2' ERR
umask 022

build=$1
# shellcheck disable=SC1091
. "$build/build.env"
# shellcheck disable=SC1091
. "$(cd "$(dirname "$0")" && pwd)/apt.sh"
art=$build/artifacts
user=${BOX_USER:-box}
runtime=${BOX_RUNTIME:-lxc}
export DEBIAN_FRONTEND=noninteractive
die() { echo "customize-desktop-wayland: $*" >&2; exit 1; }
[ -f /etc/apt/apt.conf.d/50bb-box-build-snapshot ] || die "run customize-base.sh first (no apt snapshot)"
[ "${DESKTOP_GPU:-none}" = none ] || die "a Wayland desktop is CPU only for now (048): set DESKTOP_GPU=none"
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

# The Ubuntu release: 24.04, or 26.04, whose Sway and wayvnc carry the box's
# own pointer shapes. Some packages and pins differ between them.
release=$(. /etc/os-release && echo "$VERSION_ID")
case $release in 24.04 | 26.04) ;; *) die "the Wayland desktop is for Ubuntu 24.04 or 26.04, not $release" ;; esac

# Packages, without recommends: Sway's include Xwayland, which stays out.
# wf-recorder records the desktop for box_record (059). gsettings
# (libglib2.0-bin) switches GTK apps' cursor theme, to hide the pointer (#707).
desktop_packages="sway swaybg waybar wayvnc foot wofi wl-clipboard grim slurp wf-recorder wtype wayland-utils
  dbus-user-session at-spi2-core xdg-utils ffmpeg adwaita-icon-theme hicolor-icon-theme libglib2.0-bin
  fonts-dejavu-core fonts-liberation fonts-noto-color-emoji libvulkan1 vulkan-tools mesa-vulkan-drivers
  libgl1-mesa-dri libegl1 libgl1 libgles2 libglvnd0 pciutils"
# The small apps people and agents expect on a desktop, all GTK and so native
# on Wayland: a text editor, an image viewer, a PDF viewer and a file manager.
# gtk4-demo is the GTK 4 window the template's check reads with Cua.
desktop_packages="$desktop_packages mousepad ristretto evince thunar gtk-4-examples"
# Chinese, Japanese and Korean text, sans and serif, regular and bold (88 MiB).
desktop_packages="$desktop_packages fonts-noto-cjk"
# On 26.04, the Wayland protocols' XML, which bb-box's cursor helper builds
# against (ext-image-copy-capture), for the pointer's shape on video.
[ "$release" != 26.04 ] || desktop_packages="$desktop_packages wayland-protocols"
# What Zed's GPUI needs to build on Linux.
gpui_packages="clang cmake libxkbcommon-dev libxkbcommon-x11-dev libwayland-dev libx11-xcb-dev libxcb1-dev
  libfontconfig-dev libfreetype-dev libssl-dev libzstd-dev libvulkan-dev libasound2-dev"
chrome=$(check chrome)
# Selkies, the desktop's video (060): its package holds its own Python, in
# /opt/selkies. Its package is built for each Ubuntu release: the pin for
# 26.04 is selkies-ubuntu26.04, and for 24.04 selkies.
selkies_pin=selkies
[ "$release" != 26.04 ] || selkies_pin=selkies-ubuntu26.04
selkies=$(check "$selkies_pin")
# A refresh of a built image (049) may have a newer Chrome already, which
# Google's apt source brought: keep it rather than go back to the pin.
installed=$(dpkg-query -W -f='${Status} ${Version}' google-chrome-stable 2>/dev/null | sed -n 's/^install ok installed //p' || true)
if [ -n "$installed" ] && dpkg --compare-versions "$installed" ge "$(dpkg-deb -f "$chrome" Version)"; then
  echo "customize-desktop-wayland: keeping Chrome $installed, as new as the pin or newer"
  chrome=
fi
# Downloads are retried through snapshot.ubuntu.com's short outages, as in
# baseline.sh; files already downloaded stay in apt's cache.
opts=()
apt_acquire_options opts
# shellcheck disable=SC2086
apt_retry apt-get "${opts[@]}" install -y -q --no-install-recommends --download-only $desktop_packages $gpui_packages "$selkies" ${chrome:+"$chrome"}
# shellcheck disable=SC2086
apt_install -y -q --no-install-recommends $desktop_packages $gpui_packages "$selkies" ${chrome:+"$chrome"}
for package in $desktop_packages $gpui_packages selkies google-chrome-stable; do
  [ "$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null)" = "install ok installed" ] || die "$package is not installed"
done
! dpkg-query -W -f='${Status}' xwayland 2>/dev/null | grep -q "install ok installed" || die "xwayland is installed"
install -d -m 0755 /usr/share/bb-box
{
  echo "nvidia=none"
  echo "session=wayland"
  for package in sway wayvnc waybar; do echo "$package=$(dpkg-query -W -f='${Version}' "$package")"; done
  echo "selkies=$(file_of "$selkies_pin")"
  for name in chrome cua-driver rustup; do echo "$name=$(file_of "$name")"; done
} >"$build/extra-release"

# The display, its stream and their settings.
install -d -m 0755 /usr/local/libexec/bb-box /etc/bb-box
install -m 0755 "$build/guest/files/display-wayland" /usr/local/libexec/bb-box/display
install -m 0755 "$build/guest/files/vnc-password" /usr/local/libexec/bb-box/vnc-password
install -m 0755 "$build/guest/files/selkies-wayland" /usr/local/libexec/bb-box/selkies
# Typing with a US keyboard, which computer use's text takes (#707).
clang -O2 -Wall -Werror -o /usr/local/libexec/bb-box/type "$build/guest/files/bb-box-type.c" -lwayland-client -lxkbcommon ||
  die "bb-box-type did not build"
chmod 0755 /usr/local/libexec/bb-box/type
# The box's pointer, where Sway has ext-image-copy-capture, from 1.11 (060):
# its shape for the person in control, and the agent's pointer for people
# watching, which neither stream sends. Built from the system's protocol XML.
# 24.04's Sway 1.9 lacks the protocol, though its wayland-protocols has the
# XML, so its image has no helper, and bb-box hides the pointer from the
# picture as before (#707).
protocols=/usr/share/wayland-protocols/staging
if dpkg --compare-versions "$(dpkg-query -W -f='${Version}' sway)" ge 1.11 &&
  [ -f "$protocols/ext-image-copy-capture/ext-image-copy-capture-v1.xml" ]; then
  cursor_src=$(mktemp -d)
  for xml in ext-image-copy-capture/ext-image-copy-capture-v1 ext-image-capture-source/ext-image-capture-source-v1 ext-foreign-toplevel-list/ext-foreign-toplevel-list-v1; do
    wayland-scanner client-header "$protocols/$xml.xml" "$cursor_src/${xml##*/}-client-protocol.h"
    wayland-scanner private-code "$protocols/$xml.xml" "$cursor_src/${xml##*/}-protocol.c"
  done
  clang -O2 -Wall -Werror -I"$cursor_src" -o /usr/local/libexec/bb-box/cursor "$build/guest/files/bb-box-cursor.c" "$cursor_src"/*-protocol.c -lwayland-client ||
    die "bb-box-cursor did not build"
  chmod 0755 /usr/local/libexec/bb-box/cursor
  rm -rf "$cursor_src"
  echo "cursor=session" >>"$build/extra-release"
fi
# Selkies streams Sway at Sway's size and never resizes it (060).
selkies_ws=$(ls /opt/selkies/lib/python3*/site-packages/selkies/websockets_mode.py 2>/dev/null | head -1)
[ -n "$selkies_ws" ] || die "Selkies' websockets_mode.py is missing"
/opt/selkies/bin/python3 "$build/guest/files/selkies-host-size.py" "$selkies_ws" || die "Selkies could not be patched to keep Sway's size"
grep -q _bb_box_host_output_size "$selkies_ws" && grep -q _bb_box_viewer_host_size "$selkies_ws" || die "Selkies is not patched to keep Sway's size"
rm -rf "$(dirname "$selkies_ws")/__pycache__"
for f in cua-probe.mjs cua-launch-probe.mjs rfb-probe.mjs; do
  install -m 0644 "$build/guest/files/$f" "/usr/local/libexec/bb-box/$f"
done
cat >/etc/bb-box/desktop.env <<'EOF'
# bb-box Wayland desktop settings, read by bb-box-display.service and
# bb-box-vnc.service at each start.
# The screen's size at start; the backend resizes it to each viewer's.
DISPLAY_GEOMETRY=1920x1080
# VNC_AUTH: password (Apple's sign-in, type 30, as the box user with
# /var/lib/bb-box/vnc-password) or none.
VNC_AUTH=password
EOF
# Sway: headless, with floating windows that open at their own size, centred,
# with title bars, and Waybar for a taskbar, a launcher and a terminal.
cat >/etc/bb-box/sway.conf <<'EOF'
# bb-box: Sway for the Wayland desktop (048), started by
# /usr/local/libexec/bb-box/display. Its output's size comes from
# DISPLAY_GEOMETRY in /etc/bb-box/desktop.env.
include /run/bb-box/sway-output.conf
output HEADLESS-1 bg #2e3440 solid_color
# One X11 window breaks Cua on Sway; X11-only apps need linux-desktop-cpu.
xwayland disable
# A pointer theme from the start: Sway 1.11 draws no pointer until its seat
# has one, so the cursor session and wayvnc would have no image (060).
seat * xcursor_theme default 24
# A floating desktop: apps open at their own size, with title bars.
for_window [all] floating enable
default_border normal 2
default_floating_border normal 2
floating_modifier Mod4 normal
bindsym Mod4+Return exec foot
bindsym Mod4+d exec wofi --show drun
bindsym Mod4+Shift+q kill
bar {
  swaybar_command /usr/local/libexec/bb-box/waybar
}
# The box user's systemd and D-Bus activation environments get the session,
# so the accessibility bus and apps started through D-Bus are on it.
exec systemctl --user import-environment WAYLAND_DISPLAY SWAYSOCK XDG_SESSION_TYPE XDG_CURRENT_DESKTOP
exec dbus-update-activation-environment --systemd WAYLAND_DISPLAY SWAYSOCK XDG_SESSION_TYPE XDG_CURRENT_DESKTOP
exec /usr/local/libexec/bb-box/display ready
EOF
cat >/etc/bb-box/waybar.json <<'EOF'
{
  "layer": "top",
  "position": "bottom",
  "height": 30,
  "modules-left": ["custom/apps", "custom/terminal", "wlr/taskbar"],
  "modules-right": ["clock"],
  "custom/apps": { "format": "Apps", "on-click": "wofi --show drun", "tooltip": false },
  "custom/terminal": { "format": "Terminal", "on-click": "foot", "tooltip": false },
  "wlr/taskbar": { "format": "{title}", "on-click": "activate", "max-length": 40, "tooltip": false },
  "clock": { "format": "{:%H:%M}", "tooltip": false }
}
EOF
cat >/etc/bb-box/waybar.css <<'EOF'
* { font-family: "DejaVu Sans", sans-serif; font-size: 13px; min-height: 0; }
window#waybar { background: #20242c; color: #e5e9f0; }
#custom-apps, #custom-terminal, #clock { padding: 0 10px; }
#custom-apps:hover, #custom-terminal:hover { background: #3b4252; }
#taskbar button { padding: 0 8px; color: #d8dee9; border-radius: 0; }
#taskbar button.active { background: #434c5e; }
EOF
chmod 0644 /etc/bb-box/*
# Sway runs a bar command as one program, with its own -b argument.
cat >/usr/local/libexec/bb-box/waybar <<'EOF'
#!/bin/sh
# bb-box: Waybar with the Wayland desktop's own config, for Sway's bar.
exec waybar -c /etc/bb-box/waybar.json -s /etc/bb-box/waybar.css "$@"
EOF
chmod 0755 /usr/local/libexec/bb-box/waybar

cat >/etc/systemd/system/bb-box-vnc-password.service <<EOF
[Unit]
Description=bb-box: make this box's VNC password on first boot
ConditionPathExists=!/var/lib/bb-box/vnc-password
Before=bb-box-display.service

[Service]
Type=oneshot
ExecStart=/usr/local/libexec/bb-box/vnc-password $user

[Install]
WantedBy=multi-user.target
EOF
cat >/etc/systemd/system/bb-box-display.service <<EOF
[Unit]
Description=bb-box: the Wayland desktop (Sway, headless)
After=systemd-user-sessions.service bb-box-vnc-password.service user@$uid.service
Wants=bb-box-vnc-password.service user@$uid.service
# Bring the streams back whenever the display is up again.
Upholds=bb-box-vnc.service bb-box-selkies.service

[Service]
User=$user
Group=$user
# The PATH and variables the box user's commands have, as ~/.local/bin for npm's and uv's commands.
EnvironmentFile=-/etc/environment
EnvironmentFile=-/etc/bb-box/desktop.env
Environment=XDG_RUNTIME_DIR=/run/user/$uid DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus
RuntimeDirectory=bb-box
RuntimeDirectoryMode=0755
WorkingDirectory=~
ExecStart=/usr/local/libexec/bb-box/display
ExecStartPost=/usr/local/libexec/bb-box/display wait
# Cua Driver's daemon starts after Sway, with its socket, and stops with it.
ExecStartPost=-/usr/bin/systemctl --user restart bb-box-cua-driver.service
ExecStopPost=-/usr/bin/systemctl --user stop bb-box-cua-driver.service
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
EOF
cat >/etc/systemd/system/bb-box-vnc.service <<EOF
[Unit]
Description=bb-box: wayvnc on port 5900 for the Wayland desktop
After=bb-box-display.service
BindsTo=bb-box-display.service
# display resize ends it to take a new size with no viewer; it always comes back.
StartLimitIntervalSec=0

[Service]
User=$user
Group=$user
EnvironmentFile=-/etc/bb-box/desktop.env
EnvironmentFile=/run/bb-box/display.env
Environment=XDG_RUNTIME_DIR=/run/user/$uid
ExecStartPre=/usr/local/libexec/bb-box/display vnc-config
# wayvnc at 60 frames a second, ended when it loses Sway, so it starts again.
ExecStart=/usr/local/libexec/bb-box/display vnc
Restart=always
RestartSec=100ms

[Install]
WantedBy=multi-user.target
EOF
# Selkies' video of Sway, which starts and stops with it (060).
cat >/etc/systemd/system/bb-box-selkies.service <<EOF
[Unit]
Description=bb-box: Selkies' video of the Wayland desktop on 127.0.0.1:5980
After=bb-box-display.service
BindsTo=bb-box-display.service

[Service]
User=$user
Group=$user
Environment=XDG_RUNTIME_DIR=/run/user/$uid DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus
WorkingDirectory=~
ExecStart=/usr/local/libexec/bb-box/selkies
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
EOF
systemctl enable bb-box-vnc-password.service bb-box-display.service bb-box-vnc.service bb-box-selkies.service >/dev/null

# The desktop's environment for the box user's SSH commands and login shells,
# from /run/bb-box/display.env: WAYLAND_DISPLAY, SWAYSOCK and the session's
# XDG_ variables. bash reads ~/.bashrc for SSH commands, so this goes above
# Ubuntu's early return for non-interactive shells. No DISPLAY anywhere.
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
! grep -qs '^DISPLAY=' /etc/environment /etc/environment.d/* || die "DISPLAY is set in /etc/environment"

# Chrome without first-run screens, as in the X11 template (customize-desktop.sh).
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
# Chrome draws natively on Wayland when XDG_SESSION_TYPE=wayland is in its
# environment, as display.env has it. Its wrapper keeps the flags computer
# use and the CPU need, as on X11.
bin=/usr/bin/google-chrome-stable
dpkg-divert --local --rename --divert "$bin.distrib" --add "$bin" >/dev/null
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
inode/directory=thunar.desktop
EOF

# Cua Driver, the official Linux release, with both pinned checksums, and no
# telemetry or update check, as in the X11 template.
cua_tarball=$(check cua-driver)
cua_version=$(sed -n 's/.*cua-driver-rs-\([0-9.]*\)-linux.*/\1/p' <<<"$cua_tarball")
cua=/opt/cua-driver/$cua_version
rm -rf "$cua"
install -d -m 0755 /opt/cua-driver "$cua"
tar -xzf "$cua_tarball" -C "$cua" --no-same-owner
echo "$(pin cua-driver-binary)  $cua/cua-driver" | sha256sum -c --quiet - || die "cua-driver binary checksum mismatch"
ln -sfn "$cua/cua-driver" /usr/local/bin/cua-driver
grep -q '^CUA_DRIVER_RS_TELEMETRY_ENABLED=' /etc/environment ||
  printf 'CUA_DRIVER_RS_TELEMETRY_ENABLED=false\nCUA_DRIVER_RS_UPDATE_CHECK=false\n' >>/etc/environment
install -d -m 0755 /etc/environment.d
printf 'CUA_DRIVER_RS_TELEMETRY_ENABLED=false\nCUA_DRIVER_RS_UPDATE_CHECK=false\n' >/etc/environment.d/61-bb-box-cua-driver.conf
for home in /root "/home/$user"; do
  owner=root
  [ "$home" = /root ] || owner=$user
  install -d -m 0755 -o "$owner" -g "$owner" "$home/.cua-driver"
  printf '{\n  "telemetry_enabled": false,\n  "update_check_enabled": false\n}\n' >"$home/.cua-driver/config.json"
  chown "$owner:$owner" "$home/.cua-driver/config.json"
done
# One daemon per box in the box user's systemd manager, on Sway: its Wayland
# adapter finds windows through SWAYSOCK, from display.env. bb-box-display
# starts and stops it. It listens on ~/.cache/cua-driver/cua-driver.sock.
cat >/etc/systemd/user/bb-box-cua-driver.service <<'EOF'
[Unit]
Description=bb-box: Cua Driver daemon for the Wayland desktop

[Service]
EnvironmentFile=/run/bb-box/display.env
Environment=CUA_DRIVER_RS_ENABLE_WAYLAND=1 XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=sway
Environment=CUA_DRIVER_RS_TELEMETRY_ENABLED=false CUA_DRIVER_RS_UPDATE_CHECK=false
ExecStart=/usr/local/bin/cua-driver serve --no-overlay
Restart=always
RestartSec=1
EOF

# Rust for the box user, as in the X11 template.
install -m 0755 "$(check rustup)" /var/tmp/rustup-init
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

# A cursor theme of transparent pointers, under every name Adwaita has (#707).
# Sway's headless output paints the pointer into each frame wayvnc sends,
# and wayvnc 0.7.2 sends no cursor shape, so while a person holds control
# bb-box switches Sway and GTK to it: only their browser's pointer shows,
# not a painted one trailing it.
python3 - <<'PY'
import os, struct
d = "/usr/share/icons/bb-box-hidden/cursors"
os.makedirs(d, exist_ok=True)
image = struct.pack("<9I", 36, 0xFFFD0002, 24, 1, 1, 1, 0, 0, 0) + struct.pack("<I", 0)
with open(f"{d}/default", "wb") as f:
    f.write(b"Xcur" + struct.pack("<3I", 16, 0x10000, 1) + struct.pack("<3I", 0xFFFD0002, 24, 28) + image)
for name in os.listdir("/usr/share/icons/Adwaita/cursors"):
    if name != "default" and not os.path.lexists(f"{d}/{name}"):
        os.symlink("default", f"{d}/{name}")
with open("/usr/share/icons/bb-box-hidden/index.theme", "w") as f:
    f.write("[Icon Theme]\nName=bb-box-hidden\nComment=Transparent pointers, which bb-box uses while a person holds control\n")
PY
[ -e /usr/share/icons/bb-box-hidden/cursors/left_ptr ] || die "the hidden cursor theme has no left_ptr"

install -m 0755 "$build/guest/check-desktop-wayland.sh" /usr/local/bin/bb-box-check-desktop
rm -rf /home/*/.config/google-chrome /root/.config/google-chrome
echo "customize-desktop-wayland: done"
