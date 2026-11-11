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
# Where it runs (#598): under systemd, as a Proxmox LXC box or a VM, or in a
# Docker or microsandbox box, whose bb-box-start does what the units do. A
# line that does not apply there says skip, which no reader takes for a FAIL.
if [ -d /run/systemd/system ]; then runtime=systemd
else case "$(tr '\0' ' ' </proc/1/cmdline 2>/dev/null)" in /init.krun*) runtime=microsandbox ;; *) runtime=docker ;; esac; fi
s() { printf '%-26s skip %s\n' "$1" "$2"; }
# Docker's lines, where the box has Docker: always under systemd (041), and in
# a Docker or microsandbox box when bb-box-start listens on its socket.
docker=; [ "$runtime" = systemd ] || [ -S /run/docker.sock ] && docker=1
d() { if [ -n "$docker" ]; then t "$@"; else s "$1" "this box has no Docker"; fi; }

# Docker starts on first use (041): stopped after boot, then quick to start.
d "docker stopped after boot" sh -c '! pgrep -x dockerd >/dev/null || { echo "dockerd runs"; exit 1; }; ! pgrep -x containerd >/dev/null || { echo "containerd runs"; exit 1; }; if [ -d /run/systemd/system ]; then echo "docker.socket $(systemctl is-active docker.socket)"; else echo "bb-box-start listens on /run/docker.sock"; fi'
d "first docker command" /usr/local/libexec/bb-box/docker-first-start
# A TUN device, for Tailscale and other VPNs (050): build.sh gives a
# template /dev/net/tun, a VM and a microsandbox box have their own, and a
# Docker box has its host's, where the host has one.
if [ "$runtime" = docker ] && [ ! -e /dev/net/tun ]; then s "TUN device" "none from this Docker host, so Tailscale runs in userspace (050)"
else t "TUN device" sh -c 'test -c /dev/net/tun || { echo "no /dev/net/tun"; exit 1; }; exec 3<>/dev/net/tun && echo "/dev/net/tun opens"'; fi
if [ "$runtime" = systemd ]; then t "services" systemctl is-active bb-box-display bb-box-session
else s "services" "bb-box-start runs the display and the session, which the lines below check"; fi
t "display mode" sh -c 'echo "$(cat /run/bb-box/display-mode): $(cat /run/bb-box/display-reason)"'
t "display :99" sh -c 'xdpyinfo | grep -m1 dimensions | tr -s " "; xdpyinfo -queryExtensions | grep -oE "NV-GLX|GLX|XTEST|RANDR" | sort -u | tr "\n" " "'
t "XFCE running" sh -c 'pgrep -u "$(id -un)" -x xfwm4 >/dev/null && pgrep -u "$(id -un)" -x xfce4-panel >/dev/null && echo xfwm4 xfce4-panel'
t "VNC on 5900" bash -c 'exec 3<>/dev/tcp/127.0.0.1/5900; head -c 12 <&3'
# Selkies (056), on the GPU display path with NVENC (#863).
t "Selkies on 5980" sh -c 'for _ in $(seq 1 100); do code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5980/) && [ "$code" = 200 ] && break; sleep 0.1; done
  [ "$code" = 200 ] || { echo "no answer on 127.0.0.1:5980 (HTTP $code)"; exit 1; }
  echo "HTTP $code, $(/usr/bin/selkies --version 2>&1 | head -1)"'
# A viewer's video, and on the GPU path from NVENC: once a viewer asks, Selkies has NVIDIA's encoder loaded.
t "Selkies video" sh -c 'out=$(node /usr/local/libexec/bb-box/selkies-probe.mjs 5980 3) || exit 1
  echo "$out" | grep -q "\"frames\":[1-9]" || { echo "no frames: $out"; exit 1; }
  if [ "$(cat /run/bb-box/display-mode)" = gpu ]; then
    nvenc=; for pid in $(pgrep -u "$(id -un)" -x selkies) $(pgrep -u "$(id -un)" -x python3); do grep -q libnvidia-encode "/proc/$pid/maps" 2>/dev/null && nvenc=$pid; done
    [ -n "$nvenc" ] || { echo "not on NVENC: $out"; exit 1; }
    echo "NVENC, $out"
  else echo "x264, $out"; fi'
if [ -c /dev/nvidiactl ]; then
  t "nvidia-smi" nvidia-smi --query-gpu=name,driver_version,memory.used,memory.total --format=csv,noheader
else
  t "nvidia-smi" echo "no GPU in this box"
fi
if [ -x /usr/local/sbin/bb-box-nvidia-drivers ]; then
  t "NVIDIA's userspace" sh -c 'states=$(/usr/local/sbin/bb-box-nvidia-drivers --check) || exit 1; if [ -e /dev/nvidiactl ]; then want=shown; else want=hidden; fi
    wrong=$(echo "$states" | grep -v "15_nvidia_gbm" | grep -v " $want$" || true); [ -z "$wrong" ] || { echo "$wrong"; exit 1; }
    echo "$(cat /usr/share/bb-box/nvidia-version), its EGL and Vulkan drivers $want"'
else
  s "NVIDIA's userspace" "none in this box"
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

t "CJK fonts" sh -c 'for l in zh-cn zh-tw ja ko; do f=$(fc-match "sans-serif:lang=$l" family); case "$f" in *CJK*) printf "%s: %s; " "$l" "${f%%,*}" ;; *) echo "no CJK font for $l: $f"; exit 1 ;; esac; done'
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
t "Cua Driver daemon" sh -c 'if [ -d /run/systemd/system ]; then systemctl --user is-active bb-box-cua-driver; else pgrep -u "$(id -un)" -x cua-driver >/dev/null && echo "started by bb-box-start"; fi && cua-driver telemetry status | head -1'
t "Cua Driver over MCP" node /usr/local/libexec/bb-box/cua-probe.mjs --socket "$home/.cache/cua-driver/cua-driver.sock"

if [ "${1:-}" = --gpui ] && [ -n "${2:-}" ]; then
  "$2" >/tmp/bb-box-gpui.log 2>&1 &
  gpui=$!
  sleep 5
  t "GPUI on the GPU" sh -c "ls -l /proc/$gpui/fd | grep -c /dev/nvidia0 | sed 's/\$/ handles on \\/dev\\/nvidia0/'; grep -oE 'libnvidia-glcore[^ ]*' /proc/$gpui/maps | sort -u; kill -0 $gpui"
  kill "$gpui" 2>/dev/null
fi
