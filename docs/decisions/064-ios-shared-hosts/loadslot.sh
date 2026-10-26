#!/bin/sh
here=$HOME/bb-box/docs/research/ios-shared-hosts
out=$HOME/exp/runs/slotload; mkdir -p $out
$here/devices.sh up 4 2>/dev/null
node $here/multi.ts --targets $HOME/shared/targets.json --seconds 30 --label base-n4 --out $out/base.json --raw $out/raw-base | grep -v vm: > $out/summary.txt
python3 $here/analyse.py $out/raw-base | tail -1 >> $out/summary.txt
( sleep 6; $HOME/exp/makeslot.sh slt6 >> $out/summary.txt 2>&1 ) &
node $here/multi.ts --targets $HOME/shared/targets.json --seconds 40 --label make-n4 --out $out/make.json --raw $out/raw-make | grep -v vm: >> $out/summary.txt
python3 $here/analyse.py $out/raw-make | tail -1 >> $out/summary.txt
wait
