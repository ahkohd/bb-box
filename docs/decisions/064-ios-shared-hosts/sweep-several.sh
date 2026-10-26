now() { python3 -c 'import time;print(time.time())'; }
for g in 3 4 5; do u=bbd-$g; pw=$(openssl rand -hex 16); printf '%s\n' "$pw" | sudo sysadminctl -addUser $u -fullName $u -UID $((80000+g)) -password - -home /Users/$u >/dev/null 2>&1; sudo createhomedir -c -u $u >/dev/null 2>&1
  sudo -u $u -H sh -c 'xcrun simctl list devices >/dev/null 2>&1; echo x > /tmp/left-$(id -u); mkdir -p /Users/Shared/left-$(id -u)'; done
for g in 3 4 5; do u=bbd-$g; uid=$((80000+g)); sudo launchctl bootout user/$uid 2>/dev/null; sudo pkill -9 -u $uid; sleep 0.5; sudo sysadminctl -deleteUser $u >/dev/null 2>&1; sudo rm -rf /Users/$u; done
t0=$(now); n1=$(sudo find /System/Volumes/Data -xdev -uid 80003 2>/dev/null | wc -l | tr -d ' '); t1=$(now)
n3=$(sudo find /System/Volumes/Data -xdev \( -uid 80003 -o -uid 80004 -o -uid 80005 \) -prune -print 2>/dev/null | tee /tmp/three.txt | wc -l | tr -d ' '); t2=$(now)
echo "one UID: $n1 paths in $(python3 -c "print(round($t1-$t0,1))") s; three UIDs in one pass: $n3 paths in $(python3 -c "print(round($t2-$t1,1))") s"
sudo sh -c 'while IFS= read -r p; do chflags -R nouchg,nouappnd "$p" 2>/dev/null; rm -rf "$p"; done < /tmp/three.txt'
t3=$(now); left=$(sudo find /System/Volumes/Data -xdev \( -uid 80003 -o -uid 80004 -o -uid 80005 \) 2>/dev/null | wc -l | tr -d ' '); echo "after the sweep: $left left; check $(python3 -c "print(round($(now)-$t3,1))") s"
