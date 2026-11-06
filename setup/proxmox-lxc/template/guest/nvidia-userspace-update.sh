#!/bin/bash
set -Eeuo pipefail
umask 022

die() { echo "nvidia-userspace-update: $*" >&2; exit 1; }
root=${BB_BOX_ROOT:-}
mode=${1:-}
host_driver=$root/sys/module/nvidia/version
desktop_env=$root/etc/bb-box/desktop.env
nvidia_base=${BBBOX_NVIDIA_BASE:-https://download.nvidia.com/XFree86/Linux-x86_64}

apt_packages() {
  { dpkg-query -W -f '${Package} ${Status}\n' 'nvidia-*' 'libnvidia-*' 'cuda-drivers*' 2>/dev/null || true; } |
    awk '$(NF-2) == "install" && $(NF-1) == "ok" && $NF == "installed" { print $1 }' | tr '\n' ' '
}

gpu_processes() {
  local proc pid
  for proc in /proc/[0-9]*; do
    pid=${proc#/proc/}
    [ "$pid" != "$$" ] || continue
    if find "$proc/fd" -maxdepth 1 -lname '/dev/nvidia*' 2>/dev/null | grep -q .; then
      echo "gpu-process $pid $(tr -d '\n' <"$proc/comm" 2>/dev/null || echo '?')"
    fi
  done
}

case "$mode" in
  check)
    echo "arch $(uname -m)"
    os_release=$(cat "$root/etc/os-release" 2>/dev/null || echo)
    os_id=$(sed -n 's/^ID=//p' <<<"$os_release" | tr -d '"')
    os_version=$(sed -n 's/^VERSION_ID=//p' <<<"$os_release" | tr -d '"')
    echo "os ${os_id:-unknown} ${os_version:-unknown}"
    if [ -e "$root/usr/share/bb-box/image.json" ]; then echo "image bb-box"; else echo "image other"; fi
    echo "free-mib $(df -Pm /var/tmp | awk 'NR == 2 { print $4 }')"
    echo "kernel-driver $(cat "$host_driver" 2>/dev/null || echo none)"
    packages=$(apt_packages)
    echo "apt ${packages:-none}"
    gpu_processes
    echo "check done"
    ;;
  fetch)
    dir=${2:?usage: nvidia-userspace-update.sh fetch <dir> <driver>}
    driver=${3:?usage: nvidia-userspace-update.sh fetch <dir> <driver>}
    [[ "$driver" =~ ^[0-9]+(\.[0-9]+)+$ ]] || die "$driver is not a driver version"
    seen=$(cat "$host_driver" 2>/dev/null) || die "the box sees no NVIDIA driver on its host"
    [ "$seen" = "$driver" ] || die "the box sees the host's driver $seen, not $driver"
    art=$dir/artifacts
    run=NVIDIA-Linux-x86_64-$driver.run
    mkdir -p "$art"
    curl -fsSL --connect-timeout 30 --retry 3 --max-time 120 -o "$art/$run.sha256sum" "$nvidia_base/$driver/$run.sha256sum" ||
      die "could not download NVIDIA's SHA-256 for $run from $nvidia_base/$driver"
    sha=$(awk -v f="$run" '$2 == f { print $1 }' "$art/$run.sha256sum")
    [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || die "NVIDIA gave no SHA-256 for $run"
    if [ -f "$art/$run" ] && echo "$sha  $art/$run" | sha256sum -c --quiet - 2>/dev/null; then
      echo "kept $run"
    else
      curl -fsSL --connect-timeout 30 --retry 3 --speed-limit 10240 --speed-time 30 --max-time 1800 -o "$art/$run.part" "$nvidia_base/$driver/$run" ||
        { rm -f "$art/$run.part"; die "could not download $run from $nvidia_base/$driver"; }
      echo "$sha  $art/$run.part" | sha256sum -c --quiet - || { rm -f "$art/$run.part"; die "$run from NVIDIA does not match NVIDIA's SHA-256"; }
      mv "$art/$run.part" "$art/$run"
      echo "fetched $run"
    fi
    ;;
  install)
    dir=${2:?usage: nvidia-userspace-update.sh install <dir>}
    installed=$(bash "$dir/guest/nvidia-userspace.sh" "$dir")
    if [ -f "$desktop_env" ]; then
      if grep -q '^DISPLAY_MODE=' "$desktop_env"; then
        sed -i 's/^DISPLAY_MODE=.*/DISPLAY_MODE=auto/' "$desktop_env"
      else
        echo DISPLAY_MODE=auto >>"$desktop_env"
      fi
      echo "display-mode auto"
    fi
    rm -rf -- "$dir"
    echo "installed $installed"
    ;;
  *)
    die "usage: nvidia-userspace-update.sh check | fetch <dir> <driver> | install <dir>"
    ;;
esac
