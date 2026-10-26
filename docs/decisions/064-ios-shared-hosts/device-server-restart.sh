u=${1:-bbd-1}; D=/Users/$u/.bb-box/device
now() { python3 -c 'import time;print(time.time())'; }
spid() { pgrep -u $u -f "src/device/main.ts" | head -1; }
lines() { sudo grep -c "listening on" $D/server.log; }
for round in 1 2 3; do
  p=$(spid); n=$(lines); t0=$(now); sudo kill -TERM $p
  until [ "$(lines)" -gt "$n" ]; do sleep 0.05; done
  echo "restart $round: listening again after $(python3 -c "print(round($(now)-$t0,2))") s"
done
sudo cp -R $D/server/13 $D/server/14; sudo chown -R "${u}:staff" $D/server/14
p=$(spid); n=$(lines); t0=$(now); sudo -u $u ln -sfn server/14 $D/current; sudo kill -TERM $p
until [ "$(lines)" -gt "$n" ]; do sleep 0.05; done
echo "new version folder: listening after $(python3 -c "print(round($(now)-$t0,2))") s"
