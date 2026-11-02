#!/bin/sh
set -e
checkout="$(cd "${1:?usage: stage.sh <bb-box checkout>}" && pwd)"
fresh="$HOME/fresh"
agent_dir="$HOME/demo-agent"
mkdir -p "$fresh" "$agent_dir"

cat > "$fresh/bb.sh" <<EOF
#!/bin/sh
exec env -i HOME="$fresh" PATH=/usr/local/bin:/usr/bin:/bin USER="\$(id -un)" BB_DATA_DIR="$fresh/data" BB_SERVER_URL=http://127.0.0.1:4999 npx -y --package bb-app@latest bb "\$@"
EOF
chmod +x "$fresh/bb.sh"
bb="$fresh/bb.sh"

cd "$fresh"
env -i HOME="$fresh" PATH=/usr/local/bin:/usr/bin:/bin USER="$(id -un)" nohup npx -y bb-app@latest --data-dir "$fresh/data" --server-bind-host 0.0.0.0 --server-port 4999 --host-daemon-port 4998 --no-in-app-updates > "$fresh/bb.log" 2>&1 &
for _ in $(seq 1 90); do curl -s -o /dev/null http://127.0.0.1:4999/ && break; sleep 2; done

cd "$checkout" && npm ci --no-audit --no-fund > "$fresh/npm-ci.log" 2>&1
"$bb" plugin install "path:$checkout" --yes > "$fresh/install.log" 2>&1

bridge=$(ip -4 addr show docker0 | sed -n 's/.*inet \([0-9.]*\)\/.*/\1/p')
"$bb" settings general machineServerUrl "http://$bridge:4999" > /dev/null
"$bb" settings general defaultMachineAccess direct > /dev/null
"$bb" settings general onboardingCompletedAt "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" > /dev/null
"$bb" settings general telemetryEnabled false > /dev/null

cp "$checkout/scripts/demo/agent.mjs" "$agent_dir/agent.mjs"
cd "$agent_dir" && { [ -f package.json ] || echo '{ "private": true }' > package.json; }
npm i @modelcontextprotocol/sdk@1 --no-audit --no-fund > /dev/null 2>&1
"$bb" plugin config provider-acp set customAgents "[{\"id\":\"demo\",\"displayName\":\"Demo agent\",\"command\":\"node\",\"args\":[\"$agent_dir/agent.mjs\"]}]" > /dev/null
sleep 3
"$bb" settings general defaultProviderId acp-demo > /dev/null

"$bb" box setup docker | tail -1
"$bb" box config show --json > "$fresh/config.json"
python3 - "$fresh/config.json" <<'EOF'
import json, sys
path = sys.argv[1]
config = json.load(open(path))
docker = next(backend for backend in config["backends"] if backend["type"] == "docker")
docker["fields"]["desktop-image"] = "bbbox/linux-desktop:1"
docker["fields"]["linux-image"] = ""
microsandbox = {"id": "microsandbox", "type": "microsandbox", "enabled": True, "fields": {"desktop-image": ""}}
config["backends"] = [microsandbox] + [backend for backend in config["backends"] if backend["type"] != "microsandbox"]
json.dump(config, open(path, "w"))
EOF
"$bb" box config apply "$fresh/config.json" | tail -1
"$bb" box option set monitor.refreshIntervalSeconds=2 | tail -1
machine=$("$bb" machine list --json | python3 -c "import json, sys; print(next(m['name'] for m in json.load(sys.stdin) if m.get('machineProviderId') is None))")
"$bb" box docker-build "$machine" > "$fresh/docker-build.log" 2>&1
tail -3 "$fresh/docker-build.log"
echo "stage ready: $machine"
