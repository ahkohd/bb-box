#!/bin/bash
# Checks a desktop box as the box user: the display, VNC, the GPU, Chrome and
# Cua Driver. Prints one line per check.
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
t "nvidia-smi" nvidia-smi --query-gpu=name,driver_version,memory.used,memory.total --format=csv,noheader
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

t "Cua Driver" node /usr/local/libexec/bb-box/cua-probe.mjs

if [ "${1:-}" = --gpui ] && [ -n "${2:-}" ]; then
  "$2" >/tmp/bb-box-gpui.log 2>&1 &
  gpui=$!
  sleep 5
  t "GPUI on the GPU" sh -c "ls -l /proc/$gpui/fd | grep -c /dev/nvidia0 | sed 's/\$/ handles on \\/dev\\/nvidia0/'; grep -oE 'libnvidia-glcore[^ ]*' /proc/$gpui/maps | sort -u; kill -0 $gpui"
  kill "$gpui" 2>/dev/null
fi
