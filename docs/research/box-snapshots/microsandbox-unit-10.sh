#!/bin/bash
set -uo pipefail
export PATH=$HOME/msb:$PATH LD_LIBRARY_PATH=$HOME/msb
[ "$(msb --version)" = "msb 0.7.7" ] || { echo "these checks measured msb 0.7.7; this is $(msb --version)"; exit 1; }
t() { local s=$(date +%s.%N); "$@"; local rc=$?; echo "TIME $(awk -v a=$s -v b=$(date +%s.%N) 'BEGIN{printf "%.2f", b-a}') s rc=$rc :: $*"; return $rc; }
sums() { msb exec "$1" -- sh -c 'md5sum /root/b* /data/d*; cat /root/gen'; }
msb pull alpine:3.20 >/dev/null
mkdir -p ~/disks && truncate -s 2G ~/disks/host.ext4 && mkfs.ext4 -q -F ~/disks/host.ext4
echo "== a Docker disk that is a file of the host's"
msb create alpine:3.20 --name hostdisk --quiet --cpus 1 --memory 1024M --tmpfs /run --mount-disk "$HOME/disks/host.ext4:/data"
msb exec hostdisk -- sh -c 'echo on-the-host-file > /data/d.txt; sync'
t msb snap create full --sandbox hostdisk --full
t msb snap create disk --sandbox hostdisk
t msb snap restore hostdisk:disk --name hostdisk-r --quiet --dangerously-inherit-resources
msb exec hostdisk-r -- sh -c 'cat /data/d.txt 2>&1; mount | grep " /data " || echo "no /data mount"'
echo "== msb's own disk, a chain of three, both parents force-removed"
msb create alpine:3.20 --name chain --quiet --cpus 1 --memory 1024M --tmpfs /run --mount-owned /data:kind=disk,size=2G
for i in 0 1 2; do msb exec chain -- sh -c "dd if=/dev/urandom of=/root/b$i bs=1M count=20 2>/dev/null; dd if=/dev/urandom of=/data/d$i bs=1M count=5 2>/dev/null; echo gen$i > /root/gen; sync"; t msb snap create c$i --sandbox chain --quiet; done
sums chain > /tmp/before.txt
msb snap ls --group chain --format json | python3 -c 'import json,sys; [print(s["name"], s["snapshot_id"], "parent", s["parent_digest"]) for s in json.load(sys.stdin)]'
msb snap rm chain:c0 2>&1 | tail -1
t msb snap rm --force chain:c0; t msb snap rm --force chain:c1; msb rm -f chain --quiet
t msb snap restore chain:c2 --name chain-r --quiet
sums chain-r > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt && echo "SAME: the leaf holds its own data"
echo "== the head, and a full snapshot booted from its disk only at another size"
msb create alpine:3.20 --name head --quiet --cpus 1 --memory 1024M --tmpfs /run
msb exec head -- sh -c 'echo x > /root/x; sync'
msb snap create one --sandbox head --quiet; msb snap create two --sandbox head --full --quiet
msb snap rm --force head:two 2>&1 | tail -1
t msb snap restore head:two --name head-r --quiet --disk-only --cpus 2 --memory 2048M
msb exec head-r -- sh -c 'cat /root/x'
msb snap restore head:two --name head-s --quiet --cpus 2 --memory 2048M 2>&1 | tail -1
msb snap head head:one --format json >/dev/null; t msb snap rm head:two
msb inspect head-r --format json | python3 -c 'import json,sys; c=json.load(sys.stdin)["config"]; print("labels", c["labels"], "env", [e["key"] for e in c["env"]], "mounts", [m["guest"] for m in c["mounts"]], "resources", c["resources"]["cpus"], c["resources"]["memory_mib"])'
echo "== a running sandbox restored from a snapshot that is then deleted"
fill() { msb exec "$1" -- sh -c "dd if=/dev/urandom of=/root/b bs=1M count=40 2>/dev/null; dd if=/dev/urandom of=/data/d bs=1M count=20 2>/dev/null; sync"; }
held() { msb exec "$1" -- sh -c 'md5sum /root/b /data/d'; }
msb create alpine:3.20 --name a-src --quiet --cpus 1 --memory 1024M --tmpfs /run --mount-owned /data:kind=disk,size=2G
fill a-src; msb snap create s1 --sandbox a-src --quiet; held a-src > /tmp/a.txt
msb snap restore a-src:s1 --name a-r --quiet; msb rm -f a-src --quiet
t msb snap rm a-src:s1
held a-r | diff /tmp/a.txt - && echo "A SAME running, after its snapshot and source went"
msb stop a-r --quiet; msb start a-r --quiet; held a-r | diff /tmp/a.txt - && echo "A SAME after a stop and start"
echo "== B: a capture of that sandbox names the deleted snapshot as its parent"
msb snap create t0 --sandbox a-r --quiet; msb snap create t1 --sandbox a-r --quiet
msb snap ls --group a-r --format json | python3 -c 'import json,sys; [print(s["name"], "parent", s["parent_digest"]) for s in json.load(sys.stdin)]'
t msb snap rm --force a-r:t0; msb rm -f a-r --quiet
t msb snap restore a-r:t1 --name b-r --quiet; held b-r | diff /tmp/a.txt - && echo "B SAME after its parent was removed with --force"
echo "== C: a parent removed with --force while a sandbox restored from it runs"
msb create alpine:3.20 --name c-src --quiet --cpus 1 --memory 1024M --tmpfs /run --mount-owned /data:kind=disk,size=2G
fill c-src; msb snap create p0 --sandbox c-src --quiet; held c-src > /tmp/c.txt; msb snap create p1 --sandbox c-src --quiet
msb snap restore c-src:p0 --name c-r --quiet
t msb snap rm --force c-src:p0
msb stop c-r --quiet; msb start c-r --quiet; held c-r | diff /tmp/c.txt - && echo "C SAME after a restart"
for s in hostdisk hostdisk-r chain-r head head-r head-s b-r c-src c-r; do msb rm -f "$s" --quiet; done
for id in $(msb snap ls --format json | python3 -c 'import json,sys; [print(s["snapshot_id"]) for s in json.load(sys.stdin)]'); do msb snap rm --force "$id" --quiet; done
rm -f ~/disks/host.ext4
echo "left: sandboxes $(msb ls --format json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))'), snapshots $(msb snap ls --format json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
