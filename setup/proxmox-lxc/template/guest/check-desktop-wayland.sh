#!/bin/bash
# Checks a Wayland desktop box (048) as the box user: Sway, the bar, wayvnc's
# sign-in and first frame, a resize, Cua's trees of a GTK 4 window and of
# Chrome, and no Xwayland or DISPLAY. Prints one line per check. Installed as
# bb-box-check-desktop in the Wayland desktop template.
# usage: bb-box-check-desktop
set -u
# The box user's own runtime directory and session bus, whatever the caller's
# environment had (build.sh runs this through pct exec and runuser).
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
# The environment programs on the desktop get: WAYLAND_DISPLAY, SWAYSOCK.
if [ -r /run/bb-box/display.env ]; then set -a; . /run/bb-box/display.env; set +a; fi
t() { printf '%-26s ' "$1"; shift; out=$("$@" 2>&1) && echo "ok   ${out:0:400}" || echo "FAIL ${out:0:400}"; }
libexec=/usr/local/libexec/bb-box
home=$(getent passwd "$(id -un)" | cut -d: -f6)
socket=$home/.cache/cua-driver/cua-driver.sock

# Docker starts on first use (041): stopped after boot, then quick to start.
t "docker stopped after boot" sh -c '! pgrep -x dockerd >/dev/null || { echo "dockerd runs"; exit 1; }; ! pgrep -x containerd >/dev/null || { echo "containerd runs"; exit 1; }; echo "docker.socket $(systemctl is-active docker.socket)"'
t "first docker command" sh -c 's=$(date +%s%N); docker version --format "{{.Server.Version}}" >/dev/null || exit 1; ms=$(( ($(date +%s%N) - s) / 1000000 )); echo "$ms ms (limit 2000)"; [ "$ms" -le 2000 ]'
t "services" sh -c 'systemctl is-active bb-box-display bb-box-vnc | paste -sd " "'
t "display mode" sh -c 'echo "$(cat /run/bb-box/display-mode): $(cat /run/bb-box/display-reason)"'
t "Sway and its output" sh -c 'swaymsg -r -t get_version | python3 -c "import json,sys; print(json.load(sys.stdin)[\"human_readable\"])" | tr "\n" " "; swaymsg -r -t get_outputs | python3 -c "import json,sys; o=json.load(sys.stdin)[0]; print(o[\"name\"], \"%dx%d\" % (o[\"rect\"][\"width\"], o[\"rect\"][\"height\"]))"'
t "bar (Waybar)" sh -c 'pgrep -u "$(id -un)" -x waybar >/dev/null && echo waybar'
# No X server and no DISPLAY anywhere: one X11 window breaks Cua on Sway (048).
t "no Xwayland, no DISPLAY" sh -c '
  ! command -v Xwayland >/dev/null || { echo "Xwayland is installed"; exit 1; }
  ! pgrep -x Xwayland >/dev/null || { echo "Xwayland runs"; exit 1; }
  swaymsg -r -t get_config | python3 -c "import json,sys; print(json.load(sys.stdin)[\"config\"])" | grep -qx "xwayland disable" || { echo "Sway config lacks xwayland disable"; exit 1; }
  [ -z "${DISPLAY:-}" ] || { echo "DISPLAY=$DISPLAY in this shell"; exit 1; }
  ! grep -rqs "^DISPLAY=" /etc/environment /etc/environment.d || { echo "DISPLAY in /etc/environment"; exit 1; }
  ! systemctl --user show-environment | grep -q "^DISPLAY=" || { echo "DISPLAY in the user manager"; exit 1; }
  echo "none; WAYLAND_DISPLAY=$WAYLAND_DISPLAY"'
t "VNC sign-in, first frame" node $libexec/rfb-probe.mjs --user "$(id -un)" --password-file /var/lib/bb-box/vnc-password
# As the backend resizes a viewer's desktop (021): while a viewer watches, as
# the relay's does, the screen takes the new size, and a new connection has
# it. wayvnc 0.7.2 can crash when a viewer connects after a resize made with
# none connected (#394), which the backend does not do.
t "resize" sh -c '
  before=$(swaymsg -r -t get_outputs | python3 -c "import json,sys; r=json.load(sys.stdin)[0][\"rect\"]; print(\"%dx%d\" % (r[\"width\"], r[\"height\"]))")
  hold=$(mktemp); node '"$libexec"'/rfb-probe.mjs --user "$(id -un)" --password-file /var/lib/bb-box/vnc-password --hold >"$hold" 2>&1 &
  viewer=$!
  for _ in $(seq 1 100); do [ -s "$hold" ] && break; sleep 0.1; done
  s=$(date +%s%N); '"$libexec"'/display resize 1233x677 || { kill $viewer; exit 1; }; ms=$(( ($(date +%s%N) - s) / 1000000 ))
  got=$(node '"$libexec"'/rfb-probe.mjs --user "$(id -un)" --password-file /var/lib/bb-box/vnc-password | python3 -c "import json,sys; d=json.load(sys.stdin); print(\"%dx%d\" % (d[\"width\"], d[\"height\"]))")
  '"$libexec"'/display resize "$before"; back=$?
  kill -0 $viewer 2>/dev/null; alive=$?
  kill $viewer 2>/dev/null; rm -f "$hold"
  [ "$back" = 0 ] || exit 1
  [ "$got" = 1233x677 ] || { echo "a new viewer has $got after resizing to 1233x677"; exit 1; }
  [ "$alive" = 0 ] || { echo "the watching viewer was disconnected"; exit 1; }
  echo "1233x677 in $ms ms, a new viewer has it, the watching one stayed; back to $before"'
t "at-spi bus" sh -c 'n=$(pgrep -u "$(id -un)" -c at-spi-bus-laun); a=$(busctl --user call org.a11y.Bus /org/a11y/bus org.a11y.Bus GetAddress) || exit 1; [ "$n" -le 1 ] || { echo "$n bus launchers"; exit 1; }; echo "$a" | cut -c1-60'
t "Cua Driver daemon" sh -c 'systemctl --user is-active bb-box-cua-driver && cua-driver telemetry status | head -1'
# Cua's get_screen_size is X11's; on Wayland it lists the windows through Sway.
t "Cua Driver over MCP" node $libexec/cua-probe.mjs --socket "$socket" --call list_windows
t "Cua: a GTK 4 window" node $libexec/cua-launch-probe.mjs --socket "$socket" --app gtk4-demo --min 10
# As the conformance suite does: type into the editor, in the foreground, and
# read the text back from its tree.
t "Cua: type into Mousepad" node $libexec/cua-launch-probe.mjs --socket "$socket" --app mousepad --type "bb-box typed on Wayland"
t "Cua: Chrome, native" sh -c '
  node '"$libexec"'/cua-launch-probe.mjs --socket "'"$socket"'" --min 10 \
    --url "data:text/html,<title>bb-box check</title><h1>bb-box</h1><p>A page for the check.</p><button>OK</button><a href=%23>Link</a>" || exit 1
  # Native means an xdg-shell window, not an Xwayland one (which xwayland disable forbids anyway).
  swaymsg -t get_tree | grep -q "\"shell\": \"xwayland\"" && { echo "an Xwayland window is open"; exit 1; }; true'
rm -rf "$home/.config/google-chrome" 2>/dev/null || true
t "CJK fonts" sh -c 'for l in zh-cn zh-tw ja ko; do f=$(fc-match "sans-serif:lang=$l" family); case "$f" in *CJK*) printf "%s: %s; " "$l" "${f%%,*}" ;; *) echo "no CJK font for $l: $f"; exit 1 ;; esac; done'
t "desktop apps" sh -c 'for c in foot wofi mousepad ristretto evince thunar google-chrome; do command -v $c >/dev/null || { echo missing $c; exit 1; }; done; for m in text/plain application/pdf image/png; do printf "%s " "$(xdg-mime query default $m)"; done'
