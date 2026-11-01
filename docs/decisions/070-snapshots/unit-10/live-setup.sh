#!/bin/sh
set -e
cd "$HOME"
port=7801
dev=$(ip -4 route show default | awk '{print $5; exit}')
address=$(ip -4 -o addr show "$dev" | awk '{print $4}' | cut -d/ -f1)
version=${BB_APP_VERSION:-latest}
mkdir -p bbdata

sudo iptables -I INPUT -i "$dev" -p tcp --dport $port -j DROP
sudo iptables -I INPUT -i "$dev" -p tcp --dport $((port + 1)) -j DROP

cat > start-bb.sh <<SCRIPT
#!/bin/sh
cd "\$HOME"
exec env -i HOME=$HOME PATH=/usr/local/bin:/usr/bin:/bin BB_BOX_LIVE_CHECKS=1 npx -y bb-app@$version --bundled --no-in-app-updates --data-dir $HOME/bbdata --server-bind-host 0.0.0.0 --server-port $port --host-daemon-port $((port + 1))
SCRIPT
chmod +x start-bb.sh
nohup ./start-bb.sh > bb.log 2>&1 &
until curl -s -o /dev/null http://127.0.0.1:$port/; do sleep 1; done
until [ -x bbdata/bin/bb ]; do sleep 1; done

cat > bbc <<SCRIPT
#!/bin/sh
exec env -i HOME=$HOME PATH=/usr/local/bin:/usr/bin:/bin BB_HOST_DAEMON_PORT=$((port + 1)) BB_SERVER_URL=http://127.0.0.1:$port BB_DATA_DIR=$HOME/bbdata $HOME/bbdata/bin/bb "\$@"
SCRIPT
chmod +x bbc

./bbc plugin install "path:$HOME/bb-box" --yes
./bbc settings general machineServerUrl "http://$address:$port"
./bbc settings general defaultMachineAccess direct
./bbc box backend add microsandbox --field desktop-image= --field reserve-memory-mib=2048
./bbc box option set general.identityResetBackends=microsandbox
./bbc --version
echo "BB on http://$address:$port, CLI ~/bbc"
