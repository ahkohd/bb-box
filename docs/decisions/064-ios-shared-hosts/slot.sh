#!/bin/sh
g=${1:?generation}; user=bbd-$g; uid=$((80000 + g))
now() { python3 -c 'import time; print(f"{time.time():.3f}")'; }
t0=$(now)
pw=$(openssl rand -hex 16)
printf '%s\n' "$pw" | sysadminctl -addUser $user -fullName $user -UID $uid -password - -home /Users/$user >/dev/null 2>&1
createhomedir -c -u $user >/dev/null 2>&1; dseditgroup -o edit -a $user -t user _developer; dseditgroup -o edit -a $user -t user com.apple.access_ssh 2>/dev/null
chmod 700 /Users/$user
t1=$(now)
U() { sudo -u $user -H "$@"; }
U xcrun simctl delete all >/dev/null 2>&1; t2=$(now)
N=$(U xcrun simctl create slot com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro com.apple.CoreSimulator.SimRuntime.iOS-27-0); t3=$(now)
d=/private/var/tmp/com.apple.CoreSimulator.SimDevice.$N; mkdir -p $d; cp /Users/Shared/bb-seed.plist $d/disabled.plist; chown -R $user:wheel $d; chmod 700 $d
U xcrun simctl boot $N; U xcrun simctl bootstatus $N -b >/dev/null; t4=$(now)
cat > /Library/LaunchDaemons/app.bb-box.companion.$user.plist <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>app.bb-box.companion.$user</string>
<key>UserName</key><string>$user</string>
<key>ProgramArguments</key><array><string>/usr/local/bin/idb_companion</string><string>--udid</string><string>$N</string><string>--grpc-domain-sock</string><string>/Users/$user/idb.sock</string></array>
<key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>1</integer>
<key>StandardErrorPath</key><string>/Users/$user/companion.log</string>
</dict></plist>
PL
launchctl bootstrap system /Library/LaunchDaemons/app.bb-box.companion.$user.plist
until [ -S /Users/$user/idb.sock ]; do sleep 0.05; done; t5=$(now)
ff=$(cd /Users/Shared/bb/bb-box/docs/research/ios-shared-hosts && U node firstframe.ts /Users/$user/idb.sock)
t6=$(now)
p() { python3 -c "print(round($2-$1,1))"; }
echo "slot $user uid $uid: user $(p $t0 $t1) s, defaults $(p $t1 $t2) s, create $(p $t2 $t3) s, first boot $(p $t3 $t4) s, companion by daemon $(p $t4 $t5) s, $ff, first frame $(p $t5 $t6) s; whole $(p $t0 $t6) s; disabled $(U xcrun simctl spawn $N launchctl print-disabled system | grep -c '=> disabled\|=> true')"
