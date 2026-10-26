set -u; u=${1:-bbd-1}; H=/Users/$u; D=$H/.bb-box/device; v=${2:-13}
now() { python3 -c 'import time;print(time.time())'; }
U0=$(xcrun simctl list devices -j | python3 -c 'import json,sys; print(next(d["udid"] for r in json.load(sys.stdin)["devices"].values() for d in r if d["name"]=="iPhone 18 Pro"))')
N=$(sudo -u $u -H xcrun simctl list devices -j | python3 -c 'import json,sys; print(next(d["udid"] for r in json.load(sys.stdin)["devices"].values() for d in r if d["name"]=="iPhone 18 Pro"))')
T=/private/var/tmp/com.apple.CoreSimulator.SimDevice.$N
sudo mkdir -p $T && sudo cp /private/var/tmp/com.apple.CoreSimulator.SimDevice.$U0/disabled.plist $T/ && sudo chown -R "${u}:wheel" $T && sudo chmod 700 $T
sudo mkdir -p $D/server; sudo cp -R $HOME/.bb-box/device/server/$v $D/server/$v; sudo cp $HOME/.bb-box/device/devices.json $HOME/.bb-box/device/choices.json $HOME/.bb-box/device/intent.json $D/; sudo ln -sfn server/$v $D/current; sudo chown -R "${u}:staff" $H/.bb-box; sudo chmod 700 $H/.bb-box $D
sudo tee /Library/LaunchDaemons/app.bb-box.device.$u.plist >/dev/null <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>app.bb-box.device.$u</string>
<key>UserName</key><string>$u</string>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>$H</string><key>PATH</key><string>/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>$D/current/src/device/bb-box-device.sh</string><string>serve</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>1</integer>
</dict></plist>
PL
t0=$(now)
sudo launchctl bootstrap system /Library/LaunchDaemons/app.bb-box.device.$u.plist
until sudo test -S $D/device.sock; do sleep 0.1; done
echo "socket after $(python3 -c "print(round($(now)-$t0,1))") s"
