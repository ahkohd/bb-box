#!/bin/bash
# Checks a desktop box as the box user: the display, VNC, the GPU, Chrome, the
# desktop's apps and Cua Driver. Prints one line per check.
# usage: bb-box-check-desktop [--gpui <binary>]
set -u
export DISPLAY=${DISPLAY:-:99} XAUTHORITY=${XAUTHORITY:-/run/bb-box/Xauthority}
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
# The environment programs on :99 get for the current display path.
if [ -r /run/bb-box/display.env ]; then set -a; . /run/bb-box/display.env; set +a; fi
t() { printf '%-26s ' "$1"; shift; out=$("$@" 2>&1) && echo "ok   ${out:0:400}" || echo "FAIL ${out:0:400}"; }

t "services" systemctl is-active bb-box-display bb-box-session
t "display mode" sh -c 'echo "$(cat /run/bb-box/display-mode): $(cat /run/bb-box/display-reason)"'
t "display :99" sh -c 'xdpyinfo | grep -m1 dimensions | tr -s " "; xdpyinfo -queryExtensions | grep -oE "NV-GLX|GLX|XTEST|RANDR" | sort -u | tr "\n" " "'
t "XFCE running" sh -c 'pgrep -u "$(id -un)" -x xfwm4 >/dev/null && pgrep -u "$(id -un)" -x xfce4-panel >/dev/null && echo xfwm4 xfce4-panel'
t "VNC on 5900" bash -c 'exec 3<>/dev/tcp/127.0.0.1/5900; head -c 12 <&3'
if [ -c /dev/nvidiactl ]; then
  t "nvidia-smi" nvidia-smi --query-gpu=name,driver_version,memory.used,memory.total --format=csv,noheader
else
  t "nvidia-smi" echo "no GPU in this box"
fi
t "GL renderer" sh -c 'glxinfo -B | grep -E "OpenGL renderer|available dedicated" | tr -s " "'
t "Vulkan present (vkcube)" sh -c 's=$(date +%s%N); timeout 20 vkcube --c 1000 >/dev/null 2>&1 && echo "1000 frames in $(( ($(date +%s%N) - s) / 1000000 )) ms"'

profile=$(mktemp -d)
google-chrome --no-first-run --no-default-browser-check --remote-debugging-port=9333 \
  --user-data-dir="$profile" about:blank >/dev/null 2>&1 &
chrome=$!
t "Chrome GPU" node /usr/local/libexec/bb-box/chrome-gpu.mjs 9333
kill "$chrome" 2>/dev/null
wait "$chrome" 2>/dev/null
sleep 1
rm -rf "$profile" 2>/dev/null || true

t "desktop apps" sh -c 'for c in mousepad ristretto evince xfce4-terminal thunar; do command -v $c >/dev/null || { echo missing $c; exit 1; }; done; for m in text/plain application/pdf image/png; do printf "%s " "$(xdg-mime query default $m)"; done'
# A new Mousepad window opens on :99 (in a Mousepad already running, if any),
# and is closed again.
t "Mousepad opens a window" sh -c '
  ids() { wmctrl -lx | awk "\$3 ~ /[Mm]ousepad/ { print \$1 }"; }
  before=$(ids)
  mousepad >/dev/null 2>&1 &
  for _ in $(seq 1 100); do
    new=$(ids | grep -vxF "$before" | head -1)
    [ -n "$new" ] && break
    sleep 0.1
  done
  [ -n "$new" ] && echo "$(wmctrl -l | awk -v w="$new" "\$1 == w { \$1 = \$2 = \$3 = \"\"; sub(/^ +/, \"\"); print }")" && wmctrl -ic "$new"'

home=$(getent passwd "$(id -un)" | cut -d: -f6)
t "Cua Driver daemon" sh -c 'systemctl --user is-active bb-box-cua-driver && cua-driver telemetry status | head -1'
t "Cua Driver over MCP" node /usr/local/libexec/bb-box/cua-probe.mjs --socket "$home/.cache/cua-driver/cua-driver.sock"

if [ "${1:-}" = --gpui ] && [ -n "${2:-}" ]; then
  "$2" >/tmp/bb-box-gpui.log 2>&1 &
  gpui=$!
  sleep 5
  t "GPUI on the GPU" sh -c "ls -l /proc/$gpui/fd | grep -c /dev/nvidia0 | sed 's/\$/ handles on \\/dev\\/nvidia0/'; grep -oE 'libnvidia-glcore[^ ]*' /proc/$gpui/maps | sort -u; kill -0 $gpui"
  kill "$gpui" 2>/dev/null
fi
