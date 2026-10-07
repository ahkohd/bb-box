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
# A TUN device, for Tailscale and other VPNs (050): build.sh gives a
# template /dev/net/tun, and a VM has its own.
t "TUN device" sh -c 'test -c /dev/net/tun || { echo "no /dev/net/tun"; exit 1; }; exec 3<>/dev/net/tun && echo "/dev/net/tun opens"'
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
# As the backend resizes a viewer's desktop (021): display resize, then a new
# connection's ServerInit has the size. Larger with no viewer connected, as the
# conformance suite does; smaller while a viewer watches, as through the relay,
# which must stay connected.
size_of() { swaymsg -r -t get_outputs | python3 -c 'import json,sys; r=json.load(sys.stdin)[0]["rect"]; print("%dx%d" % (r["width"], r["height"]))'; }
init_size() { node $libexec/rfb-probe.mjs --user "$(id -un)" --password-file /var/lib/bb-box/vnc-password --init-only | python3 -c 'import json,sys; d=json.load(sys.stdin); print("%dx%d" % (d["width"], d["height"]))'; }
resize_to() { # size: resizes, and prints the time and what a new viewer has
  local s got
  s=$(date +%s%N); $libexec/display resize "$1" || return 1
  echo "$1 in $(( ($(date +%s%N) - s) / 1000000 )) ms"
  got=$(init_size); [ "$got" = "$1" ] || { echo "a new viewer has $got"; return 1; }
}
export -f size_of init_size resize_to; export libexec
t "resize larger, no viewer" bash -c '
  before=$(size_of); w=${before%x*}; h=${before#*x}
  resize_to $((w + 128))x$((h + 64)); ok=$?; resize_to "$before" >/dev/null || ok=1; exit $ok'
t "resize smaller, a viewer" bash -c '
  before=$(size_of)
  hold=$(mktemp); node $libexec/rfb-probe.mjs --user "$(id -un)" --password-file /var/lib/bb-box/vnc-password --hold >"$hold" 2>&1 &
  viewer=$!
  for _ in $(seq 1 100); do [ -s "$hold" ] && break; sleep 0.1; done
  resize_to 1233x677; ok=$?
  resize_to "$before" >/dev/null || ok=1
  kill -0 $viewer 2>/dev/null || { echo "the watching viewer was disconnected"; ok=1; }
  kill $viewer 2>/dev/null; rm -f "$hold"; exit $ok'
# A viewer that leaves just as the size changes, as the relay's own
# connection can, must not leave wayvnc for the next viewer to crash (#394).
t "viewer leaves at a resize" bash -c '
  before=$(size_of)
  hold=$(mktemp); node $libexec/rfb-probe.mjs --user "$(id -un)" --password-file /var/lib/bb-box/vnc-password --hold >"$hold" 2>&1 &
  viewer=$!
  for _ in $(seq 1 100); do [ -s "$hold" ] && break; sleep 0.1; done
  $libexec/display resize 1233x677; ok=$?
  kill $viewer 2>/dev/null; wait $viewer 2>/dev/null; rm -f "$hold"
  sleep 0.3; vnc=$(pgrep -u "$(id -u)" -x wayvnc)
  got=$(init_size); sleep 0.5
  [ "$(pgrep -u "$(id -u)" -x wayvnc)" = "$vnc" ] || { echo "a new viewer ended wayvnc"; ok=1; }
  [ "$got" = 1233x677 ] || { echo "a new viewer has $got"; ok=1; }
  resize_to "$before" >/dev/null || ok=1
  [ $ok = 0 ] && echo "a new viewer has $got, wayvnc runs on"; exit $ok'
t "at-spi bus" sh -c 'n=$(pgrep -u "$(id -un)" -c at-spi-bus-laun); a=$(busctl --user call org.a11y.Bus /org/a11y/bus org.a11y.Bus GetAddress) || exit 1; [ "$n" -le 1 ] || { echo "$n bus launchers"; exit 1; }; echo "$a" | cut -c1-60'
t "Cua Driver daemon" sh -c 'systemctl --user is-active bb-box-cua-driver && cua-driver telemetry status | sed -n 1p'
# Cua's get_screen_size is X11's; on Wayland it lists the windows through Sway.
t "Cua Driver over MCP" node $libexec/cua-probe.mjs --socket "$socket" --call list_windows
t "Cua: a GTK 4 window" node $libexec/cua-launch-probe.mjs --socket "$socket" --app gtk4-demo --min 10
# As the conformance suite does: type into the editor, in the foreground, and
# read the text back from its tree.
t "Cua: type into Mousepad" node $libexec/cua-launch-probe.mjs --socket "$socket" --app mousepad --type "bb-box typed on Wayland"
# The typed document is left unsaved, so Mousepad keeps it, and its session in
# dconf, and would ask to restore them. finalize.sh removes both; so does this,
# then a new Mousepad must open its editor, as on a fresh box.
mousepad_clean() {
  pkill -u "$(id -un)" -x mousepad; pkill -u "$(id -un)" -x dconf-service; sleep 0.3
  rm -rf "$home/.local/share/Mousepad" "$home/.config/dconf/user"
}
mousepad_clean
t "Mousepad opens its editor" node $libexec/cua-launch-probe.mjs --socket "$socket" --app mousepad --title "^Untitled"
mousepad_clean
t "Cua: Chrome, native" sh -c '
  node '"$libexec"'/cua-launch-probe.mjs --socket "'"$socket"'" --min 10 \
    --url "data:text/html,<title>bb-box check</title><h1>bb-box</h1><p>A page for the check.</p><button>OK</button><a href=%23>Link</a>" || exit 1
  # Native means an xdg-shell window, not an Xwayland one (which xwayland disable forbids anyway).
  swaymsg -t get_tree | grep -q "\"shell\": \"xwayland\"" && { echo "an Xwayland window is open"; exit 1; }; true'
rm -rf "$home/.config/google-chrome" 2>/dev/null || true
t "CJK fonts" sh -c 'for l in zh-cn zh-tw ja ko; do f=$(fc-match "sans-serif:lang=$l" family); case "$f" in *CJK*) printf "%s: %s; " "$l" "${f%%,*}" ;; *) echo "no CJK font for $l: $f"; exit 1 ;; esac; done'
t "desktop apps" sh -c 'for c in foot wofi mousepad ristretto evince thunar google-chrome; do command -v $c >/dev/null || { echo missing $c; exit 1; }; done; for m in text/plain application/pdf image/png; do printf "%s " "$(xdg-mime query default $m)"; done'
