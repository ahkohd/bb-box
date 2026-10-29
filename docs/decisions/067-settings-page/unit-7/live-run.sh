#!/bin/sh
set -u
RUN=$1
DATA=$HOME/bb-run$RUN
SHOTS=$HOME/shots
export LIVE_RUN=$RUN LIVE_SHOTS=$SHOTS LIVE_MACHINE=$(hostname)
mkdir -p $SHOTS
stop_bb() {
  [ -f $DATA.pid ] && sudo kill "$(cat $DATA.pid)" 2>/dev/null
  for i in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:38990/ || break; sleep 1; done
  sleep 2
}
start_bb() {
  $HOME/start-bb.sh $DATA
  for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:38990/ && break; sleep 1; done
  sleep 5
}
phase() {
  (cd $HOME/pw && node live-check.mjs "$1") >> $SHOTS/run$RUN.log 2>&1
  echo "run $RUN $1: $?" | tee -a $SHOTS/summary.log
}
rm -rf $DATA $DATA.log
docker images --format '{{.Repository}}:{{.Tag}}' | grep '^bbbox/' | xargs -r docker rmi -f > /dev/null
sudo systemctl stop docker.socket docker
sudo mv /usr/bin/docker /usr/bin/docker.hidden
start_bb
BBDATA=$DATA $HOME/bbc.sh plugin install $HOME/bb-box --yes >> $SHOTS/run$RUN.log 2>&1
sleep 8
phase missing
sudo mv /usr/bin/docker.hidden /usr/bin/docker
sudo systemctl start docker.socket docker
sleep 3
phase missing-fixed
stop_bb
sudo gpasswd -d box docker > /dev/null
start_bb
phase access
stop_bb
sudo usermod -aG docker box
FREE=$(df --output=avail -B1G / | tail -1)
fallocate -l $((FREE - 6))G $HOME/fill.bin
start_bb
phase disk
rm -f $HOME/fill.bin
phase disk-fixed
phase saved-off
phase use-docker
phase resume
phase save-on
phase all-off
stop_bb
