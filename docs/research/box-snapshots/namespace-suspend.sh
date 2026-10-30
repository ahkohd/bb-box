#!/bin/bash
set -euo pipefail
[ $# -ge 2 ] || { echo "usage: NS_TOKEN_FILE=<file holding the token> [NS_REGION=us] $0 <instance-id, or find> <box-id>" >&2; exit 2; }
INSTANCE=$1 BOX=$2
ENDPOINT="https://${NS_REGION:-us}.compute.namespaceapis.com/namespace.cloud.compute.v1beta.ComputeService"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
chmod 700 "$WORK"
printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "${NS_TOKEN_FILE:?set NS_TOKEN_FILE}")" > "$WORK/auth"

now() { date +%s.%N; }
since() { awk -v a="$1" -v b="$(now)" 'BEGIN { printf "%.2f s", b - a }'; }
call() { curl -sS --fail-with-body -X POST "$ENDPOINT/$1" -H @"$WORK/auth" -H 'Content-Type: application/json' -H 'Connect-Protocol-Version: 1' -d "$2"; }
describe() { call DescribeInstance "{\"instanceId\":\"$INSTANCE\"}"; }
field() { python3 -c "import json,sys; m=json.load(sys.stdin).get('metadata',{}); print($1)"; }
status() { describe | field "m.get('status','')"; }
wait_for() {
  local want=$1 label=$2 t s; t=$(now)
  for _ in $(seq 1 1200); do s=$(status); [ "$s" = "$want" ] && break; sleep 0.5; done
  echo "TIME $label: $(since "$t") (status $s)"
}

if [ "$INSTANCE" = find ]; then
  INSTANCE=$(call ListInstances "{\"maxEntries\":50,\"labelFilter\":[{\"name\":\"bbbox-box\",\"value\":\"$BOX\",\"op\":\"EQUAL\"}]}" | python3 -c "import json,sys; i=json.load(sys.stdin).get('instances',[]); print(i[0]['instanceId'] if len(i)==1 else '')")
  [ -n "$INSTANCE" ] || { echo "No single instance carries box $BOX; stopping." >&2; exit 1; }
  echo "instance id: $INSTANCE"
fi
describe > "$WORK/first.json"
LABEL=$(field "next((l.get('value') for l in m.get('labels',[]) if l.get('name')=='bbbox-box'),'')" < "$WORK/first.json")
[ "$LABEL" = "$BOX" ] || { echo "Instance $INSTANCE is not box $BOX's; stopping." >&2; exit 1; }
echo "instance: $(field "m.get('shape')" < "$WORK/first.json"), status $(field "m.get('status')" < "$WORK/first.json"), deadline $(field "m.get('deadline')" < "$WORK/first.json")"

t=$(now); call SuspendInstance "{\"instanceId\":\"$INSTANCE\"}" >/dev/null; echo "TIME suspend call: $(since "$t")"
wait_for SUSPENDED "suspend to SUSPENDED"
echo "while suspended: deadline $(describe | field "m.get('deadline')")"
sleep 20
t=$(now); call WakeInstance "{\"instanceId\":\"$INSTANCE\"}" >/dev/null; echo "TIME wake call: $(since "$t")"
wait_for RUNNING "wake to RUNNING"
echo "after wake: status $(status), deadline $(describe | field "m.get('deadline')")"
