#!/bin/bash
set -euo pipefail
[ $# -ge 1 ] || { echo "usage: HZ_TOKEN_FILE=<file holding the token> $0 <server-id, or find>" >&2; exit 2; }
SERVER=$1
API=https://api.hetzner.cloud/v1
TAG=bbsnap-research
WORK=$(mktemp -d); chmod 700 "$WORK"
printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "${HZ_TOKEN_FILE:?set HZ_TOKEN_FILE}")" > "$WORK/auth"
IMAGE= FORK=

now() { date +%s.%N; }
since() { awk -v a="$1" -v b="$(now)" 'BEGIN { printf "%.2f s", b - a }'; }
api() { curl -sS --fail-with-body -X "$1" "$API$2" -H @"$WORK/auth" -H 'Content-Type: application/json' ${3:+-d "$3"}; }
py() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
wait_action() {
  local id=$1 label=$2 t s; t=$(now)
  for _ in $(seq 1 1800); do s=$(api GET "/actions/$id" | py "d['action']['status']"); [ "$s" = running ] || break; sleep 1; done
  echo "TIME $label: $(since "$t") (action $s)"
}
cleanup() {
  [ -z "$FORK" ] || { api DELETE "/servers/$FORK" >/dev/null && echo "deleted server $FORK"; }
  [ -z "$IMAGE" ] || { for _ in $(seq 1 60); do api DELETE "/images/$IMAGE" >/dev/null 2>&1 && { echo "deleted image $IMAGE"; break; }; sleep 5; done; }
  echo "left with label $TAG: servers $(api GET "/servers?label_selector=$TAG" | py "len(d['servers'])"), images $(api GET "/images?type=snapshot&label_selector=$TAG" | py "len(d['images'])")"
  rm -rf "$WORK"
}
trap cleanup EXIT

if [ "$SERVER" = find ]; then
  SERVER=$(api GET "/servers?per_page=50" | python3 -c "import json,sys; s=[x for x in json.load(sys.stdin)['servers'] if x['name'].startswith('bb-box-hz-') and x['labels'].get('bbbox-role')!='image-build']; print(s[0]['id'] if len(s)==1 else '')")
  [ -n "$SERVER" ] || { echo "Not exactly one bb-box host; give its server ID." >&2; exit 1; }
  echo "server id: $SERVER"
fi
api GET "/servers/$SERVER" > "$WORK/server.json"
NAME=$(py "d['server']['name']" < "$WORK/server.json")
case "$NAME" in bb-box-hz-*) ;; *) echo "Server $SERVER ($NAME) is not a bb-box host; stopping." >&2; exit 1 ;; esac
TYPE=$(py "d['server']['server_type']['name']" < "$WORK/server.json")
LOCATION=$(py "(d['server'].get('location') or (d['server'].get('datacenter') or {}).get('location') or {}).get('name','')" < "$WORK/server.json")
[ -n "$LOCATION" ] || { echo "Server $SERVER has no location in its answer; stopping." >&2; exit 1; }
echo "source: $TYPE in $LOCATION, disk $(py "d['server']['server_type']['disk']" < "$WORK/server.json") GB, status $(py "d['server']['status']" < "$WORK/server.json"), created $(py "d['server']['created']" < "$WORK/server.json")"

t=$(now)
api POST "/servers/$SERVER/actions/create_image" "{\"type\":\"snapshot\",\"description\":\"$TAG\",\"labels\":{\"$TAG\":\"1\"}}" > "$WORK/image.json"
IMAGE=$(py "d['image']['id']" < "$WORK/image.json")
echo "TIME create_image call: $(since "$t")"
wait_action "$(py "d['action']['id']" < "$WORK/image.json")" "snapshot of the running host to done"
api GET "/images/$IMAGE" | py "'SIZE snapshot: image_size %s GB (compressed), disk_size %s GB, status %s' % (d['image']['image_size'], d['image']['disk_size'], d['image']['status'])"

t=$(now)
HOW="no network, started"
if ! api POST /servers "{\"name\":\"$TAG-fork\",\"server_type\":\"$TYPE\",\"image\":$IMAGE,\"location\":\"$LOCATION\",\"labels\":{\"$TAG\":\"1\"},\"start_after_create\":true,\"public_net\":{\"enable_ipv4\":false,\"enable_ipv6\":false}}" > "$WORK/fork.json"; then
  echo "refused with no network: $(cut -c1-200 "$WORK/fork.json")"
  HOW="IPv6 only, not started"; t=$(now)
  api POST /servers "{\"name\":\"$TAG-fork\",\"server_type\":\"$TYPE\",\"image\":$IMAGE,\"location\":\"$LOCATION\",\"labels\":{\"$TAG\":\"1\"},\"start_after_create\":false,\"public_net\":{\"enable_ipv4\":false,\"enable_ipv6\":true}}" > "$WORK/fork.json"
fi
FORK=$(py "d['server']['id']" < "$WORK/fork.json")
echo "TIME create server call: $(since "$t")"
wait_action "$(py "d['action']['id']" < "$WORK/fork.json")" "server from the snapshot ($HOW) to done"
echo "fork status: $(api GET "/servers/$FORK" | py "d['server']['status']")"
