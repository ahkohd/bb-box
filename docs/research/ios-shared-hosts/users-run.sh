#!/bin/sh
set -u

tag=${1:?tag}
shift
here=$(cd "$(dirname "$0")" && pwd)
shared=/Users/Shared/bb-box/docs/research/ios-shared-hosts
work=${SHARED_WORK:-$HOME/shared}
out=$work/runs/$tag
seconds=${SECONDS_EACH:-30}
mkdir -p "$out"
for name in "$@"; do "$here/users.sh" run "$name" "sh $shared/user-up.sh" | tee -a "$out/up.log"; done
sleep "${SETTLE:-20}"
start_at=$(python3 -c 'import time; print(int(time.time() * 1000) + 20000)')
for name in "$@"; do
  "$here/users.sh" run "$name" "/opt/homebrew/opt/node@24/bin/node $shared/multi.ts --targets \$HOME/targets.json --seconds $seconds --start-at $start_at --label $tag-$name --out /tmp/$tag-$name.json --raw /tmp/$tag-raw-$name ${MULTI_ARGS:-}" >"$out/$name.txt" 2>&1 &
done
node "$here/multi.ts" --seconds "$((seconds + 8))" --start-at "$((start_at + 3000))" --warm 0 --sample --label "$tag-vm" --out "$out/vm.json" >"$out/vm.txt" 2>&1
wait
mkdir -p "$out/raw"
for name in "$@"; do sudo cp "/tmp/$tag-$name.json" "$out/$name.json"; sudo cp /tmp/$tag-raw-$name/* "$out/raw/"; cat "$out/$name.txt"; done | tee "$out/summary.txt"
sudo chown -R "$(id -un)" "$out"
cat "$out/vm.txt" | tee -a "$out/summary.txt"
python3 "$here/analyse.py" "$out/raw" | tee -a "$out/summary.txt"
