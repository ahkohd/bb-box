#!/bin/bash
# The host's report of each NVIDIA GPU's free memory, for bb-box (#603):
#
# - a VM named bb-box-gpu-memory, never started, whose notes carry the
#   report. It has no disk and no network, protection on, and is outside
#   bb-box's pool, so the token's role on the pool does not reach it. Its
#   VMID is BBBOX_GPU_REPORT_VMID, which must be set: the next free VMID is
#   where template builds work unless BBBOX_BUILD_VMID is set;
# - PVEAuditor on that VM alone for bb-box's user and token, so the token can
#   read its notes and change nothing new;
# - bb-box-gpu-memory and bb-box-gpu-memory.timer, which write the notes every
#   15 s when a GPU's free memory changes.
#
# Idempotent. usage: setup-gpu-report.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=common.sh
. "$here/common.sh"
root=${BBBOX_ROOT:-}
[ -d "$root/proc/driver/nvidia/gpus" ] || die "no NVIDIA driver loaded: there is no GPU to report"
name=bb-box-gpu-memory
tokenid="$BBBOX_API_USER!$BBBOX_API_TOKEN"

conf=$(grep -lx "name: $name" "$root"/etc/pve/qemu-server/*.conf 2>/dev/null | head -1) || true
if [ -n "$conf" ]; then
  vmid=$(basename "$conf" .conf)
else
  [ -n "$BBBOX_GPU_REPORT_VMID" ] ||
    die "set BBBOX_GPU_REPORT_VMID in $BBBOX_ENV to a free VMID outside bb-box's VMID range, not the next free one, which template builds borrow"
  vmid=$BBBOX_GPU_REPORT_VMID
  qm create "$vmid" --name "$name" --memory 16 --protection 1 --onboot 0 \
    --description "bb-box: each GPU's memory, from bb-box-gpu-memory.timer on this host. It is never started."
fi

# With privilege separation a token has the intersection of its own ACLs and
# its user's, so both get it.
pveum acl modify "/vms/$vmid" --users "$BBBOX_API_USER" --roles PVEAuditor
pveum acl modify "/vms/$vmid" --tokens "$tokenid" --roles PVEAuditor

if [ -e "$root/usr/local/sbin/bb-box-gpu" ] || [ -e "$root/etc/systemd/system/bb-box-gpu.service" ]; then
  echo "GPU report: VM $vmid ($name), read-only for $tokenid; bb-box-gpu writes it on this host (setup-gpu.sh), so bb-box-gpu-memory.timer is not put back"
  exit 0
fi
install -m 0755 "$here/bb-box-gpu-memory" "$root/usr/local/sbin/bb-box-gpu-memory"
install -m 0644 "$here/bb-box-gpu-memory.service" "$here/bb-box-gpu-memory.timer" "$root/etc/systemd/system/"
systemctl daemon-reload
systemctl enable --quiet bb-box-gpu-memory.timer
systemctl start bb-box-gpu-memory.service bb-box-gpu-memory.timer
echo "GPU report: VM $vmid ($name), read-only for $tokenid; bb-box-gpu-memory.timer every 15 s"
