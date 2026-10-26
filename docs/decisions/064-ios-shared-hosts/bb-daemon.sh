set -u; u=${1:?slot user}; url=${2:?server url}; d=$(ls -d /Users/$u/.bb-machines/*/ | head -1); d=${d%/}; port=$(sudo cat $d/host-daemon-port)
[ -f $d/install-daemon.pid ] && sudo kill -TERM "$(sudo cat $d/install-daemon.pid)"
l=app.getbb.host-daemon.$u
sudo tee /Library/LaunchDaemons/$l.plist >/dev/null <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$l</string>
<key>UserName</key><string>$u</string>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>/Users/$u</string><key>PATH</key><string>/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin</string><key>BB_APP_NPM_PREFIX</key><string>$d/npm</string><key>BB_DATA_DIR</key><string>$d</string></dict>
<key>ProgramArguments</key><array><string>$d/npm/bin/bb-app</string><string>host-daemon</string><string>--auto-update</string><string>--host-daemon-port</string><string>$port</string><string>--server-url</string><string>$url</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$d/logs/launchd.log</string><key>StandardErrorPath</key><string>$d/logs/launchd.log</string>
</dict></plist>
PL
sudo launchctl bootstrap system /Library/LaunchDaemons/$l.plist
