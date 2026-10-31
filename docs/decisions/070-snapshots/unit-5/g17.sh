#!/bin/sh
name="$1"; step="$2"; secs="$3"; msg="$4"; sendnow="$5"; span="${6:-150}"
. ~/live/ids.sh
out=~/live-results/g17-$name.txt
: > "$out"
log() { echo "$(date -u +%T.%3N) $*" | tee -a "$out"; }
holds=$(~/bbc plugin logs bb-box 2>/dev/null | grep -c "Holding snapshot operation")
if [ "$secs" = "-" ]; then ~/bbc box snapshot hold-next --at "$step" >/dev/null; else ~/bbc box snapshot hold-next --at "$step" --seconds "$secs" >/dev/null; fi
log "armed hold at $step for $secs s"
token="T$(date +%s%N | cut -c8-16)"
msg="$msg $token"
( ~/bbc box snapshot restore dev-desk "g17 base" --machine --replace --force > ~/live-results/g17-$name-restore.txt 2>&1; echo "restore command exit $?" >> ~/live-results/g17-$name-restore.txt ) &
log "restore started"
for i in $(seq 1 240); do
  now=$(~/bbc plugin logs bb-box 2>/dev/null | grep -c "Holding snapshot operation")
  [ "$now" -gt "$holds" ] && break
  sleep 0.5
done
log "held at $step"
~/bbc thread tell "$ASKING" "$msg" > /tmp/tell.txt 2>&1
log "tell said: $(tr '\n' ' ' < /tmp/tell.txt | cut -c1-300)"
sleep 1
q=$(~/bbc thread queue list "$ASKING" --json)
log "queue: $(echo "$q" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const rows=JSON.parse(s); console.log(rows.map(r=>`${r.id} waitingOn=${JSON.stringify(r.waitingOn)}`).join("; ")||"empty")})')"
if [ "$sendnow" = restart ]; then
  ~/bbc plugin reload bb-box > /tmp/reload.txt 2>&1
  log "reloaded bb-box"
  sleep 3
  log "queue after the reload: $(~/bbc thread queue list "$ASKING" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const rows=JSON.parse(s); console.log(rows.map(r=>`${r.id} ${r.state} waitingOn=${JSON.stringify(r.waitingOn)}`).join("; ")||"empty")})')"
fi
if [ "$sendnow" = yes ]; then
  id=$(echo "$q" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const rows=JSON.parse(s); console.log(rows[0]?.id ?? "")})')
  if [ -n "$id" ]; then ~/bbc thread queue send "$ASKING" "$id" > /tmp/sendnow.txt 2>&1; log "send now $id: $(tr '\n' ' ' < /tmp/sendnow.txt | cut -c1-200)"; else log "nothing queued to send now"; fi
fi
end=$(( $(date +%s) + span ))
last=""
while [ "$(date +%s)" -lt "$end" ]; do
  box=$(~/bbc box machines 2>&1 | grep dev-desk | cut -c1-70)
  th=$(~/bbc thread show "$ASKING" 2>/dev/null | sed -n 's/^  Status: //p' | head -1)
  qn=$(~/bbc thread queue list "$ASKING" --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).length)}catch{console.log("?")}})')
  host=$(~/bbc machine list 2>/dev/null | awk '/^dev-desk /{print $4}')
  ans=$(( $(~/bbc thread log "$ASKING" --limit 3 2>&1 | grep -c "$token") - 1 ))
  now="box=$box thread=$th queued=$qn machine=$host answers=$ans"
  [ "$now" != "$last" ] && log "$now"
  last="$now"
  grep -q "restore command exit" ~/live-results/g17-$name-restore.txt 2>/dev/null && [ "$ans" -gt 0 ] && [ "$qn" = 0 ] && break
  sleep 1
done
log "restore: $(tr '\n' ' ' < ~/live-results/g17-$name-restore.txt | cut -c1-600)"
