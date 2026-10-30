#!/bin/bash
set -uo pipefail
now() { date +%s.%N; }
since() { awk -v a="$1" -v b="$(now)" 'BEGIN { printf "%.2f s", b - a }'; }
step() { local label=$1; shift; local t; t=$(now); "$@" >/tmp/step.out 2>&1; local rc=$?; echo "TIME $label: $(since "$t") (exit $rc)"; [ $rc -eq 0 ] || tail -3 /tmp/step.out; }
sudo python3 - <<'PY'
import json; p='/etc/docker/daemon.json'; d=json.load(open(p)); d['experimental']=True; json.dump(d,open(p,'w'))
PY
sudo systemctl restart docker; sleep 2
echo "experimental: $(docker version --format '{{.Server.Experimental}}')"
docker pull -q ubuntu:24.04 >/dev/null
docker rm -f snapsrc snapfork snaprestored >/dev/null 2>&1
docker run -d --name snapsrc --shm-size 2g ubuntu:24.04 bash -c 'head -c 1024M /dev/urandom > /dev/shm/ram.bin; head -c 1024M /dev/urandom > /root/disk.bin; i=0; while :; do echo $i > /root/count; i=$((i+1)); sleep 1; done' >/dev/null
sleep 25
echo "count before: $(docker exec snapsrc cat /root/count)"
docker system df --format '{{.Type}} {{.Size}}' | head -3
step "docker commit (pauses the container)" docker commit snapsrc snap:one
docker image inspect snap:one --format 'SIZE committed image: {{.Size}} bytes'
step "docker run a fork from the commit" docker run -d --name snapfork snap:one sleep infinity
echo "fork has disk.bin: $(docker exec snapfork ls -l --block-size=M /root/disk.bin | awk '{print $5}'), ram.bin: $(docker exec snapfork ls /dev/shm/ram.bin 2>&1)"
docker rm -f snapfork >/dev/null
step "docker checkpoint create, leave running" docker checkpoint create --leave-running snapsrc c1
sudo du -sm /var/lib/docker/containers/$(docker inspect -f '{{.Id}}' snapsrc)/checkpoints/c1 | awk '{print "SIZE checkpoint c1: " $1 " MiB"}'
echo "count after c1: $(docker exec snapsrc cat /root/count)"
sleep 5
echo "count before c2: $(docker exec snapsrc cat /root/count)"
step "docker checkpoint create, stopping" docker checkpoint create snapsrc c2
echo "state after c2: $(docker inspect -f '{{.State.Status}}' snapsrc)"
step "docker start from checkpoint c2" docker start --checkpoint c2 snapsrc
sleep 2; echo "count after restore (was about the c2 count, plus 2): $(docker exec snapsrc cat /root/count); ram.bin $(docker exec snapsrc ls -l --block-size=M /dev/shm/ram.bin | awk '{print $5}')"
docker checkpoint ls snapsrc
CK=/var/lib/docker/containers/$(docker inspect -f '{{.Id}}' snapsrc)/checkpoints
sudo mkdir -p /tmp/ckdir && sudo cp -a "$CK/c1" /tmp/ckdir/
docker create --name snaprestored --shm-size 2g snap:one bash -c 'sleep infinity' >/dev/null
step "docker start a new container from checkpoint c1 (checkpoint-dir)" docker start --checkpoint-dir /tmp/ckdir --checkpoint c1 snaprestored
echo "new container: $(docker inspect -f '{{.State.Status}}' snaprestored 2>&1), count $(docker exec snaprestored cat /root/count 2>&1)"
docker rm -f snapsrc snapfork snaprestored >/dev/null 2>&1; docker rmi -f snap:one >/dev/null; sudo rm -rf /tmp/ckdir
echo "left: $(docker ps -aq | wc -l) containers, $(docker images -q snap | wc -l) snap images"
