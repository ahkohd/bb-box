#!/bin/sh
set -e
cd "$HOME"
port=7801
address=$(ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1)
mkdir -p shim flags bbdata live-results
cp bb-box/docs/decisions/069-boxes-page/unit-2/docker-shim.sh shim/docker
chmod +x shim/docker

sudo iptables -I INPUT -i eth0 -p tcp --dport $port -j DROP
sudo iptables -I INPUT -i eth0 -p tcp --dport $((port + 1)) -j DROP

cat > start-bb.sh <<EOF
#!/bin/sh
cd "\$HOME"
exec env -i HOME=$HOME PATH=$HOME/shim:/usr/local/bin:/usr/bin:/bin npx -y bb-app@0.48.1 --bundled --no-in-app-updates --data-dir $HOME/bbdata --server-bind-host 0.0.0.0 --server-port $port --host-daemon-port $((port + 1))
EOF
chmod +x start-bb.sh
nohup ./start-bb.sh > bb.log 2>&1 &
until curl -s -o /dev/null http://127.0.0.1:$port/; do sleep 1; done
until [ -x bbdata/bin/bb ]; do sleep 1; done

cat > bbc <<EOF
#!/bin/sh
exec env -i HOME=$HOME PATH=$HOME/shim:/usr/local/bin:/usr/bin:/bin BB_HOST_DAEMON_PORT=$((port + 1)) BB_SERVER_URL=http://127.0.0.1:$port BB_DATA_DIR=$HOME/bbdata $HOME/bbdata/bin/bb "\$@"
EOF
chmod +x bbc

./bbc plugin install "path:$HOME/bb-box" --yes
./bbc settings general machineServerUrl "http://$address:$port"
./bbc settings general defaultMachineAccess direct
./bbc box setup docker
./bbc box backend set docker --field reserve-memory-mib=512 --no-doctor

mkdir -p agent && cp bb-box/docs/decisions/069-boxes-page/unit-1b/acp-agent.mjs agent/
(cd agent && npm init -y > /dev/null && npm i @modelcontextprotocol/sdk@1 > /dev/null 2>&1)
./bbc plugin config provider-acp set customAgents "[{\"id\":\"tools\",\"displayName\":\"Tool caller\",\"command\":\"/usr/local/bin/node\",\"args\":[\"$HOME/agent/acp-agent.mjs\"]}]"

mkdir -p proj && (cd proj && git init -q && git -c user.email=a@example.com -c user.name=a commit -q --allow-empty -m init)
project=$(./bbc project create --name demo --root "$HOME/proj" --json | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).id))')
thread=$(./bbc thread spawn --project "$project" --environment "$HOME/proj" --provider acp-tools --prompt "CALL box_list" --json | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).id))')
echo "project $project thread $thread"

mkdir -p live && (cd live && npm init -y > /dev/null && npm i playwright@1 > /dev/null 2>&1 && sudo npx playwright install-deps chromium > /dev/null 2>&1 && npx playwright install chromium > /dev/null 2>&1)
cp bb-box/docs/decisions/069-boxes-page/unit-1c/live-lib.mjs bb-box/docs/decisions/069-boxes-page/unit-2/*.mjs live/
cp bb-box/docs/decisions/069-boxes-page/unit-1c/agent-call.sh .
chmod +x agent-call.sh
until [ -e agent-trace.log ] && grep -q "result box_list" agent-trace.log; do sleep 1; done
name() { ./agent-call.sh "$thread" box_acquire "$1" | sed -n 's/.*result box_acquire: Box \([a-z-]*\) (.*/\1/p'; }
a=$(name '{"kind":"linux","cores":4,"memory_gib":2}')
printf 'export LIVE_THREAD=%s\nexport A=%s\n' "$thread" "$a" > live/env.sh
cat live/env.sh
