#!/bin/bash
# Smoke test for a bb-box template, run as root on the Proxmox host. It uses
# only the plugin's API token (not pct), as the plugin would: linked-clone the
# template into the pool, give the box an address, start it, time each step,
# SSH in as the box user with the plugin's key, run the template's own check,
# and delete the box. Never prints the token.
#
# usage: smoke.sh <template-vmid> <box-vmid> <box-address> [--keep]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../host/common.sh
. "$here/../host/common.sh"
[ $# -ge 3 ] || die "usage: smoke.sh <template-vmid> <box-vmid> <box-address> [--keep]"
template=$1 vmid=$2 addr=$3 keep=${4:-}
# shellcheck disable=SC1090
. "$BBBOX_TOKEN_FILE"
api=https://127.0.0.1:8006/api2/json
node=$PROXMOX_NODE
headers=$(mktemp)
trap 'rm -f "$headers"' EXIT
printf 'Authorization: PVEAPIToken=%s=%s\n' "$PROXMOX_TOKEN_ID" "$PROXMOX_TOKEN_SECRET" >"$headers"
ms() { echo $(($(date +%s%N) / 1000000)); }
call() { # method path [curl args...]
  local method=$1 path=$2
  shift 2
  curl -sS --fail-with-body --cacert /etc/pve/pve-root-ca.pem -H @"$headers" -X "$method" "$api$path" "$@"
}
wait_task() { # poll every 50 ms; "OK" and "WARNINGS: n" are success
  local enc status
  enc=$(jq -rn --arg u "$1" '$u|@uri')
  while :; do
    status=$(call GET "/nodes/$node/tasks/$enc/status")
    if [ "$(jq -r .data.status <<<"$status")" = stopped ]; then
      case "$(jq -r .data.exitstatus <<<"$status")" in
        OK | WARNINGS:*) return 0 ;;
        *) die "task failed: $(jq -r .data.exitstatus <<<"$status")" ;;
      esac
    fi
    sleep 0.05
  done
}
ssh_box() {
  ssh -i "$BBBOX_SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
    -o BatchMode=yes -o ConnectTimeout=2 -o ConnectionAttempts=1 "box@$addr" "$@"
}

kind=headless
call GET "/nodes/$node/lxc/$template/config" | jq -e '.data | has("dev0")' >/dev/null && kind=desktop

t0=$(ms)
upid=$(call POST "/nodes/$node/lxc/$template/clone" --data-urlencode "newid=$vmid" \
  --data-urlencode "hostname=bb-box-smoke-$vmid" --data-urlencode "pool=$BBBOX_POOL" --data-urlencode "full=0" | jq -er .data)
wait_task "$upid"
t1=$(ms)
# Clones inherit the template's protection flag; clear it so the box can be
# deleted later.
call PUT "/nodes/$node/lxc/$vmid/config" \
  --data-urlencode "net0=name=eth0,bridge=$BBBOX_BRIDGE,ip=$addr/$BBBOX_PREFIX,gw=$BBBOX_GATEWAY,type=veth" \
  --data-urlencode "delete=protection" >/dev/null
# Tags only after the box is in the pool: Proxmox checks them on /vms/<id>.
call PUT "/nodes/$node/lxc/$vmid/config" --data-urlencode "tags=bb-box;smoke" >/dev/null
t2=$(ms)
upid=$(call POST "/nodes/$node/lxc/$vmid/status/start" | jq -er .data)
wait_task "$upid"
t3=$(ms)
# Probe port 22 with a short timeout first: an attempt made before the box
# has its address waits out ARP, which is longer than the box takes to boot.
until timeout 0.3 bash -c "exec 3<>/dev/tcp/$addr/22" 2>/dev/null && ssh_box true 2>/dev/null; do
  [ $(($(ms) - t3)) -lt 60000 ] || die "SSH was not ready within 60 s"
  sleep 0.1
done
t4=$(ms)
echo "clone $((t1 - t0)) ms, configure $((t2 - t1)) ms, start $((t3 - t2)) ms, SSH ready $((t4 - t3)) ms after start"
echo "config: $(call GET "/nodes/$node/lxc/$vmid/config" | jq -c '.data | with_entries(select(.key | test("^(features|dev[0-9]+|net0)$")))')"
ssh_box "systemctl is-system-running --wait >/dev/null; bb-box-check-$kind" | tee /tmp/bb-box-smoke-$vmid.txt
failed=$(grep -c ' FAIL ' /tmp/bb-box-smoke-$vmid.txt || true)
rm -f /tmp/bb-box-smoke-$vmid.txt

if [ "$keep" != --keep ]; then
  upid=$(call POST "/nodes/$node/lxc/$vmid/status/stop" | jq -er .data)
  wait_task "$upid"
  upid=$(call DELETE "/nodes/$node/lxc/$vmid?purge=1&destroy-unreferenced-disks=1" | jq -er .data)
  wait_task "$upid"
  echo "deleted box $vmid"
fi
[ "$failed" = 0 ] || die "$failed checks failed"
echo "smoke test passed"
