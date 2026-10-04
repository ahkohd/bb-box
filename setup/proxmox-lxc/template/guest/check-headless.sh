#!/bin/bash
# Checks a headless box (or a template before finalize) as the box user.
# Prints one line per check. usage: check-headless.sh [--compose]
set -u
t() { printf '%-34s ' "$1"; shift; out=$("$@" 2>&1) && echo "ok   ${out:0:150}" || echo "FAIL ${out:0:300}"; }
t "whoami, groups" sh -c 'echo "$(id -un) uid=$(id -u) $(id -nG)"'
t "sudo without password" sudo -n true
t "systemd state" sh -c 'systemctl is-system-running; systemctl --failed --no-legend --plain | head -3'
t "boot time" sh -c 'systemd-analyze | head -1'
t "dns (resolved stub)" sh -c 'readlink /etc/resolv.conf; resolvectl dns eth0 2>/dev/null | head -1; getent hosts github.com'
t "address announced" sh -c 'systemctl cat bb-box-announce >/dev/null 2>&1 || { echo "not needed here (a VM keeps its own network)"; exit 0; }; [ "$(systemctl show -p Result --value bb-box-announce)" = success ] && echo "gratuitous ARP sent"'
t "https reach" curl -sS -o /dev/null -m 10 -w '%{http_code}' https://example.com/
# A TUN device, for Tailscale and other VPNs (050): build.sh gives a
# template /dev/net/tun, and a VM has its own.
t "TUN device" sh -c 'test -c /dev/net/tun || { echo "no /dev/net/tun"; exit 1; }; exec 3<>/dev/net/tun && echo "/dev/net/tun opens"'
t "PATH" sh -c 'echo $PATH'
# BB's updater runs `npm install -g` as the box user for an agent CLI.
t "npm -g as the box user" sh -c 'p=$(npm config get prefix); [ "$p" = "$HOME/.local" ] && [ -w "$p/lib" ] && case ":$PATH:" in *":$p/bin:"*) echo "$p" ;; *) echo "$p/bin is not on PATH"; exit 1 ;; esac'
t "tools" sh -c 'for c in node npm pnpm yarn uv gh rg fd jj git-lfs claude codex pi docker psql redis-cli sqlite3 tree vim nvim; do command -v $c >/dev/null || { echo missing $c; exit 1; }; done; node --version; uv --version; claude --version | head -1'
# A new box installs packages without `apt-get update` first.
t "apt package lists" sh -c 'v=$(apt-cache policy cowsay | awk "/Candidate:/ { print \$2 }"); [ -n "$v" ] && [ "$v" != "(none)" ] && echo "cowsay $v installable, lists from $(date -u +%F -r "$(ls -t /var/lib/apt/lists/*_InRelease | head -1)")"'
t "bb-app pre-installed" sh -c 'ls ~/.bb-machines/*/host-artifact.sha256 2>/dev/null || echo "none (no BB server URL at build)"'
# Docker starts on first use (041): stopped after boot, then quick to start.
t "docker stopped after boot" sh -c '! pgrep -x dockerd >/dev/null || { echo "dockerd runs"; exit 1; }; ! pgrep -x containerd >/dev/null || { echo "containerd runs"; exit 1; }; echo "docker.socket $(systemctl is-active docker.socket)"'
t "first docker command" sh -c 's=$(date +%s%N); docker version --format "{{.Server.Version}}" >/dev/null || exit 1; ms=$(( ($(date +%s%N) - s) / 1000000 )); echo "$ms ms (limit 2000)"; [ "$ms" -le 2000 ]'
t "docker info" docker info --format '{{.Driver}} {{.CgroupDriver}} {{json .SecurityOptions}} {{.ServerVersion}}'
t "docker offline probe" sh -c '
  libc=$(ldd /usr/bin/true | awk "/libc.so/ {print \$3}")
  ld=$(ldd /usr/bin/true | awk "/ld-linux/ {print \$1}")
  s=$(date +%s%N)
  tar -C / -ch usr/bin/true "${libc#/}" "${ld#/}" | docker import - bb-box-probe >/dev/null &&
  docker run --rm --network none bb-box-probe /usr/bin/true &&
  docker image rm bb-box-probe >/dev/null && echo "$(( ($(date +%s%N) - s) / 1000000 )) ms"'
t "docker run hello-world" sh -c 'docker run --rm hello-world | grep -m1 "Hello from Docker"'
t "compose, buildx" sh -c 'docker compose version --short; docker buildx version | cut -d" " -f2'
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
