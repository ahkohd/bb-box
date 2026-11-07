#!/bin/sh
set -e
cd "$HOME"
port=7801
kit=$HOME/work/plugin/docs/decisions/072-voxl/v1
address=$(ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1)
mkdir -p bbdata live-results

sudo iptables -C INPUT -i eth0 -p tcp --dport $port -j DROP 2>/dev/null || sudo iptables -I INPUT -i eth0 -p tcp --dport $port -j DROP
sudo iptables -C INPUT -i eth0 -p tcp --dport $((port + 1)) -j DROP 2>/dev/null || sudo iptables -I INPUT -i eth0 -p tcp --dport $((port + 1)) -j DROP

cat > start-bb.sh <<EOF
#!/bin/sh
cd "\$HOME"
exec env -i HOME=$HOME PATH=/usr/local/bin:/usr/bin:/bin npx -y bb-app@0.48.1 --bundled --no-in-app-updates --data-dir $HOME/bbdata --server-bind-host 0.0.0.0 --server-port $port --host-daemon-port $((port + 1))
EOF
chmod +x start-bb.sh
nohup ./start-bb.sh > bb.log 2>&1 &
until curl -s -o /dev/null http://127.0.0.1:$port/; do sleep 1; done
until [ -x bbdata/bin/bb ]; do sleep 1; done

cat > bbc <<EOF
#!/bin/sh
exec env -i HOME=$HOME PATH=/usr/local/bin:/usr/bin:/bin BB_HOST_DAEMON_PORT=$((port + 1)) BB_SERVER_URL=http://127.0.0.1:$port BB_DATA_DIR=$HOME/bbdata $HOME/bbdata/bin/bb "\$@"
EOF
chmod +x bbc

./bbc plugin install "path:$HOME/work/plugin" --yes
./bbc settings general machineServerUrl "http://$address:$port"
./bbc settings general defaultMachineAccess direct
./bbc box backend add docker --field linux-image= --field wayland-desktop-image= --field desktop-image=bbbox/linux-desktop:1 --field reserve-memory-mib=512 --no-doctor

mkdir -p agent && cp "$kit/acp-agent.mjs" agent/
(cd agent && npm init -y > /dev/null && npm i @modelcontextprotocol/sdk@1 > /dev/null 2>&1)
./bbc plugin config provider-acp set customAgents "[{\"id\":\"tools\",\"displayName\":\"Tool caller\",\"command\":\"/usr/local/bin/node\",\"args\":[\"$HOME/agent/acp-agent.mjs\"]}]"

mkdir -p proj && (cd proj && git init -q && git -c user.email=a@example.com -c user.name=a commit -q --allow-empty -m init)
project=$(./bbc project create --name voxl --root "$HOME/proj" --json | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).id))')
thread=$(./bbc thread spawn --project "$project" --environment "$HOME/proj" --provider acp-tools --prompt "CALL box_list" --json | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).id))')
cp "$kit/agent-call.sh" . && chmod +x agent-call.sh
until [ -e agent-trace.log ] && grep -q "result box_list" agent-trace.log; do sleep 1; done
printf 'export LIVE_THREAD=%s\n' "$thread" > live-results/env.sh
cat live-results/env.sh
