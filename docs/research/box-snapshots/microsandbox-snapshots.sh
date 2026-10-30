#!/bin/bash
set -uo pipefail
export PATH=$HOME/msb:$PATH LD_LIBRARY_PATH=$HOME/msb
now() { date +%s.%N; }
since() { awk -v a="$1" -v b="$(now)" 'BEGIN { printf "%.2f s", b - a }'; }
step() { local label=$1; shift; local t; t=$(now); "$@" >/tmp/step.out 2>&1; local rc=$?; echo "TIME $label: $(since "$t") (exit $rc)"; [ $rc -eq 0 ] || tail -4 /tmp/step.out; }
in_box() { msb exec "$1" -- sh -c "$2" 2>&1; }
HOME_MSB=${MSB_HOME:-$HOME/.microsandbox}
msb rm -f src child r1 r2 >/dev/null 2>&1
step "msb pull ubuntu:24.04" msb pull ubuntu:24.04
step "msb create src (1 vCPU default, 2 GiB)" msb create ubuntu:24.04 --name src --memory 2G
in_box src 'head -c 512M /dev/urandom > /dev/shm/ram.bin; head -c 512M /dev/urandom > /root/disk.bin; sync; nohup sh -c "i=0; while :; do echo \$i > /root/count; i=\$((i+1)); sleep 1; done" >/dev/null 2>&1 & echo started'
sleep 6; echo "count in src: $(in_box src 'cat /root/count')"
step "snapshot, disk only, running source" msb snap create disk1 --sandbox src
step "snapshot, full (memory), running source" msb snap create full1 --sandbox src --full
echo "count in src after the snapshots: $(in_box src 'cat /root/count')"
msb snap ls 2>&1 | head -8
du -sh "$HOME_MSB"/snapshots/* 2>/dev/null || du -sh "$HOME_MSB"/* 2>/dev/null | sort -h | tail -5
step "fork the running source" msb fork src --name child
echo "child: count $(in_box child 'cat /root/count'), shm $(in_box child 'ls -l /dev/shm/ram.bin | wc -l')"
step "restore full1 into a new sandbox" msb snap restore src:full1 --name r1
sleep 1; echo "r1: count $(in_box r1 'cat /root/count'), shm $(in_box r1 'ls /dev/shm/ram.bin')"
step "restore disk1 into a new sandbox (cold boot)" msb snap restore src:disk1 --name r2
echo "r2: disk.bin $(in_box r2 'ls -l /root/disk.bin | wc -l'), shm $(in_box r2 'ls /dev/shm/ram.bin 2>&1')"
step "export full1 to an archive" msb snap export src:full1 -o /tmp/full1.msb
ls -l --block-size=M /tmp/full1.msb | awk '{print "SIZE full1 archive: " $5}'
step "export disk1 to an archive" msb snap export src:disk1 -o /tmp/disk1.msb
ls -l --block-size=M /tmp/disk1.msb | awk '{print "SIZE disk1 archive: " $5}'
msb df 2>&1 | head -12
msb rm -f src child r1 r2 >/dev/null 2>&1; msb snap rm src:full1 src:disk1 >/dev/null 2>&1; rm -f /tmp/full1.msb /tmp/disk1.msb
echo "left: sandboxes $(msb ls -q 2>/dev/null | wc -l), snapshots $(msb snap ls 2>/dev/null | tail -n +2 | wc -l)"
