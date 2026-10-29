#!/bin/sh
B=$(dirname $(ls ~/.npm/_npx/*/node_modules/.bin/bb-app | head -1))
for r in 1 2 3; do
  D=$HOME/bb-off$r
  sudo -u box env -i HOME=$HOME PATH=$B:/usr/local/bin:/usr/bin:/bin BB_BOX_LIVE_CHECKS=1 $B/bb-app --data-dir $D --server-port 38990 --server-bind-host 0.0.0.0 --no-in-app-updates > $D.log 2>&1 &
  echo $! > $D.pid
  for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:38990/ && break; sleep 1; done; sleep 5
  env -i HOME=$HOME PATH=$B:/usr/local/bin:/usr/bin:/bin BB_SERVER_URL=http://127.0.0.1:38990 $B/bb plugin install $HOME/bb-box --yes > /dev/null 2>&1; sleep 8
  (cd ~/pw && LIVE_RUN=$r node all-off.mjs) >> ~/all-off.log 2>&1; echo "run $r: $?" >> ~/all-off.log
  sudo kill $(cat $D.pid); sleep 6
done
echo ALLDONE >> ~/all-off.log
