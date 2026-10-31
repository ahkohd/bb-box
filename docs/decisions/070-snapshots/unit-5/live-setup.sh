#!/bin/sh
set -e
cd "$HOME"
port=7801
version=${BB_APP_VERSION:-latest}
address=$(ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1)
subnet=$(ip -4 -o addr show eth0 | awk '{print $4}')
mkdir -p bbdata

sudo iptables -I INPUT -i eth0 -p tcp --dport $port -j DROP
sudo iptables -I INPUT -i eth0 -p tcp --dport $((port + 1)) -j DROP
sudo iptables -I INPUT -i eth0 -s "$subnet" -p tcp --dport $port -j ACCEPT
sudo iptables -I INPUT -i eth0 -s "$subnet" -p tcp --dport $((port + 1)) -j ACCEPT

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
./bbc plugin config provider-acp set customAgents '[{"id":"tools","displayName":"Tool caller","command":"/usr/local/bin/node","args":["/home/box/agent/acp-agent.mjs"]}]'
echo "BB on http://$address:$port, CLI ~/bbc"
