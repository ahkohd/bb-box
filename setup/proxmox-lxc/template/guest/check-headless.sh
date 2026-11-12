#!/bin/bash
# Checks a headless box (or a template before finalize) as the box user.
# Prints one line per check. usage: check-headless.sh [--compose]
set -u
t() { printf '%-34s ' "$1"; shift; out=$("$@" 2>&1) && echo "ok   ${out:0:150}" || echo "FAIL ${out:0:300}"; }
# Where it runs (#598): under systemd, as a Proxmox LXC box or a VM, or in a
# Docker or microsandbox box, whose bb-box-start does what the units do. A
# line that does not apply there says skip, which no reader takes for a FAIL.
if [ -d /run/systemd/system ]; then runtime=systemd
else case "$(tr '\0' ' ' </proc/1/cmdline 2>/dev/null)" in /init.krun*) runtime=microsandbox ;; *) runtime=docker ;; esac; fi
s() { printf '%-34s skip %s\n' "$1" "$2"; }
# Docker's lines, where the box has Docker: always under systemd (041), and in
# a Docker or microsandbox box when bb-box-start listens on its socket.
docker=; [ "$runtime" = systemd ] || [ -S /run/docker.sock ] && docker=1
d() { if [ -n "$docker" ]; then t "$@"; else s "$1" "this box has no Docker"; fi; }
t "whoami, groups" sh -c 'echo "$(id -un) uid=$(id -u) $(id -nG)"'
t "sudo without password" sudo -n true
if [ "$runtime" = systemd ]; then
  t "systemd state" sh -c 'systemctl is-system-running; systemctl --failed --no-legend --plain | head -3'
  t "boot time" sh -c 'systemd-analyze | head -1'
  t "dns (resolved stub)" sh -c 'readlink /etc/resolv.conf; resolvectl dns eth0 2>/dev/null | head -1; getent hosts github.com'
  t "address announced" sh -c 'systemctl cat bb-box-announce >/dev/null 2>&1 || { echo "not needed here (a VM keeps its own network)"; exit 0; }; [ "$(systemctl show -p Result --value bb-box-announce)" = success ] && echo "gratuitous ARP sent"'
else
  s "systemd state" "no systemd in a $runtime box: bb-box-start starts its services"
  s "boot time" "no systemd in a $runtime box"
  t "dns" sh -c 'a=$(getent hosts github.com) || exit 1; echo "$(awk "/^nameserver/ { print \$2; exit }" /etc/resolv.conf): $a"'
  s "address announced" "only a Proxmox LXC box announces its address"
fi
t "https reach" curl -sS -o /dev/null -m 10 -w '%{http_code}' https://example.com/
# A TUN device, for Tailscale and other VPNs (050): build.sh gives a
# template /dev/net/tun, a VM and a microsandbox box have their own, and a
# Docker box has its host's, where the host has one.
if [ "$runtime" = docker ] && [ ! -e /dev/net/tun ]; then s "TUN device" "none from this Docker host, so Tailscale runs in userspace (050)"
else t "TUN device" sh -c 'test -c /dev/net/tun || { echo "no /dev/net/tun"; exit 1; }; exec 3<>/dev/net/tun && echo "/dev/net/tun opens"'; fi
if [ -x /usr/local/sbin/bb-box-nvidia-drivers ]; then
  t "NVIDIA's userspace" sh -c 'states=$(/usr/local/sbin/bb-box-nvidia-drivers --check) || exit 1; if [ -e /dev/nvidiactl ]; then want=shown; else want=hidden; fi
    wrong=$(echo "$states" | grep -v "15_nvidia_gbm" | grep -v " $want$" || true); [ -z "$wrong" ] || { echo "$wrong"; exit 1; }
    echo "$(cat /usr/share/bb-box/nvidia-version), its EGL and Vulkan drivers $want"'
else
  s "NVIDIA's userspace" "none in this box"
fi
t "PATH" sh -c 'echo $PATH'
# BB's updater runs `npm install -g` as the box user for an agent CLI.
t "npm -g as the box user" sh -c 'p=$(npm config get prefix); [ "$p" = "$HOME/.local" ] && [ -w "$p/lib" ] && case ":$PATH:" in *":$p/bin:"*) echo "$p" ;; *) echo "$p/bin is not on PATH"; exit 1 ;; esac'
t "tools" sh -c 'for c in node npm pnpm yarn uv gh rg fd jj git-lfs claude codex pi docker psql redis-cli sqlite3 tree vim nvim; do command -v $c >/dev/null || { echo missing $c; exit 1; }; done; node --version; uv --version; claude --version | head -1'
# A new box installs packages without `apt-get update` first.
t "apt package lists" sh -c 'v=$(apt-cache policy cowsay | awk "/Candidate:/ { print \$2 }"); [ -n "$v" ] && [ "$v" != "(none)" ] && echo "cowsay $v installable, lists from $(date -u +%F -r "$(ls -t /var/lib/apt/lists/*_InRelease | head -1)")"'
t "bb-app pre-installed" sh -c 'ls ~/.bb-machines/*/host-artifact.sha256 2>/dev/null || echo "none (no BB server URL at build)"'
# Docker starts on first use (041): stopped after boot, then quick to start.
d "docker stopped after boot" sh -c '! pgrep -x dockerd >/dev/null || { echo "dockerd runs"; exit 1; }; ! pgrep -x containerd >/dev/null || { echo "containerd runs"; exit 1; }; if [ -d /run/systemd/system ]; then echo "docker.socket $(systemctl is-active docker.socket)"; else echo "bb-box-start listens on /run/docker.sock"; fi'
d "first docker command" /usr/local/libexec/bb-box/docker-first-start
d "docker info" docker info --format '{{.Driver}} {{.CgroupDriver}} {{json .SecurityOptions}} {{.ServerVersion}}'
d "docker offline probe" sh -c '
  libc=$(ldd /usr/bin/true | awk "/libc.so/ {print \$3}")
  ld=$(ldd /usr/bin/true | awk "/ld-linux/ {print \$1}")
  s=$(date +%s%N)
  tar -C / -ch usr/bin/true "${libc#/}" "${ld#/}" | docker import - bb-box-probe >/dev/null &&
  docker run --rm --network none bb-box-probe /usr/bin/true &&
  docker image rm bb-box-probe >/dev/null && echo "$(( ($(date +%s%N) - s) / 1000000 )) ms"'
d "docker run hello-world" sh -c 'docker run --rm hello-world | grep -m1 "Hello from Docker"'
d "compose, buildx" sh -c 'docker compose version --short; docker buildx version | cut -d" " -f2'
if [ "${1:-}" = --compose ]; then
  mkdir -p ~/probe && cd ~/probe
  cat >compose.yaml <<'EOF'
services:
  db:
    image: postgres:16
    environment: {POSTGRES_PASSWORD: probe}
    ports: ["127.0.0.1:5432:5432"]
    healthcheck: {test: ["CMD", "pg_isready", "-U", "postgres"], interval: 2s, retries: 30}
  cache:
    image: redis:7
    ports: ["127.0.0.1:6379:6379"]
    healthcheck: {test: ["CMD", "redis-cli", "ping"], interval: 2s, retries: 30}
EOF
  t "compose up --wait" sh -c 'docker compose up -d --wait --quiet-pull 2>&1 | tail -2'
  t "psql select 1" sh -c 'PGPASSWORD=probe psql -h 127.0.0.1 -U postgres -tAc "select 1"'
  t "redis ping" redis-cli -h 127.0.0.1 ping
  t "buildx build" sh -c 'printf "FROM busybox\nRUN echo ok\n" | docker buildx build -q -t probe-build - | cut -c1-20'
  t "compose down" sh -c 'docker compose down -v 2>&1 | tail -1'
  cd && rm -rf ~/probe
fi
