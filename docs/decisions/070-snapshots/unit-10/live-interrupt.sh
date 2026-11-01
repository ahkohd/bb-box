#!/bin/bash
set -uo pipefail
cd "$HOME"
B=./bbc
export PATH=$HOME/.local/share/bb-box/microsandbox/bin:$PATH
now() { date +%s.%N; }
$B box machines add linux --on microsandbox --name msb-cut | grep -E 'State|Timings'
$B box run msb-cut --machine 'echo before > ~/work.txt; sync'
$B box snapshot take msb-cut --machine --name before | head -1
$B box run msb-cut --machine 'echo after > ~/work.txt; sync'
old=$(msb ls --format json | python3 -c 'import json,sys; print([s["name"] for s in json.load(sys.stdin) if s["name"].startswith("bbbox-")][0])')
echo "old guest $old"
$B box snapshot hold-next --at answered
began=$(date +%s)
$B box snapshot restore msb-cut before --machine --replace > restore-cut.log 2>&1 &
fresh=
for _ in $(seq 1 240); do
  for s in $(msb ls --format json | python3 -c 'import json,sys; [print(s["name"]) for s in json.load(sys.stdin) if s["name"].startswith("'"$old"'-") and s["status"].lower()=="running"]'); do
    t=$(msb exec "$s" -- stat -c %Y /home/box/.config/bb-box/env 2>/dev/null || echo 0)
    [ "$t" -ge "$began" ] && fresh=$s
  done
  [ -n "$fresh" ] && break
  sleep 0.25
done
echo "new guest $fresh took its access file"
sleep 1
echo "ready file before the restart: $(msb exec "$fresh" -- sh -c '[ -e /run/bb-box/ready ] && echo yes || echo no')"
msb ls
$B plugin reload bb-box | head -1
wait
cat restore-cut.log
t=$(now); $B box sweep | tail -1; echo "recovery $(awk -v a=$t -v b=$(now) 'BEGIN { printf "%.2f s", b - a }')"
for _ in $(seq 1 60); do $B box machines 2>&1 | grep -q 'msb-cut.*ready' && break; sleep 1; done
$B box machines | grep msb-cut
msb ls
echo "box runs on: $($B box status msb-cut 2>/dev/null | grep -i guest)"
$B box run msb-cut --machine 'cat ~/work.txt; [ -e /run/bb-box/ready ] && echo ready-file; hostname; sudo bb-box-identity status | grep -E "^boot="'
$B machine list | grep msb-cut
grep -E 'msb-cut|'"$old" bbdata/logs/server.1.log | sed -E 's/.*"msg":"//' | grep -E 'Restored|Deleted guest|restart|recover|cut short|confirm' | tail -6 | cut -c1-250
