#!/bin/sh
set -e
cd "$HOME"
port=7801
mkdir -p shim bbdata
cp bb-box/docs/decisions/067-settings-page/images-fold/docker-shim.sh shim/docker
chmod +x shim/docker
sudo iptables -I INPUT -i eth0 -p tcp --dport $port -j DROP
sudo iptables -I INPUT -i eth0 -p tcp --dport $((port + 1)) -j DROP

cat > start-bb.sh <<SCRIPT
#!/bin/sh
cd "\$HOME"
exec env -i HOME=$HOME PATH=$HOME/shim:/usr/local/bin:/usr/bin:/bin BB_BOX_LIVE_CHECKS=1 npx -y bb-app@0.48.1 --bundled --no-in-app-updates --data-dir $HOME/bbdata --server-port $port --host-daemon-port $((port + 1))
SCRIPT
chmod +x start-bb.sh
nohup ./start-bb.sh > bb.log 2>&1 &
until curl -s -o /dev/null http://127.0.0.1:$port/; do sleep 1; done
until [ -x bbdata/bin/bb ]; do sleep 1; done

cat > bbc <<SCRIPT
#!/bin/sh
exec env -i HOME=$HOME PATH=$HOME/shim:/usr/local/bin:/usr/bin:/bin BB_HOST_DAEMON_PORT=$((port + 1)) BB_SERVER_URL=http://127.0.0.1:$port BB_DATA_DIR=$HOME/bbdata $HOME/bbdata/bin/bb "\$@"
SCRIPT
chmod +x bbc

./bbc plugin install "path:$HOME/bb-box" --yes
./bbc box setup docker

for each in b c d e f g; do sudo ln -sf /var/run/docker.sock /run/bb-docker-$each.sock; done
printf 'FROM bbbox/linux:1\nLABEL bbbox.image-record=""\n' | docker build -q -t bb-live/due:1 - > /dev/null
printf 'FROM bbbox/linux:1\nLABEL bbbox.image-record=""\n' | docker build -q -t bb-live/fails:1 - > /dev/null
node bb-box/docs/decisions/067-settings-page/images-fold/add-backends.mjs
./bbc box images build docker:g/bb-live/fails:1 || true
