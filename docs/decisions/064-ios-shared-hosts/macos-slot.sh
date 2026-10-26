export PATH=/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:$PATH HOMEBREW_NO_AUTO_UPDATE=1
now() { python3 -c 'import time; print(f"{time.time():.3f}")'; }
t() { a=$(now); out=$("$@" 2>&1); rc=$?; echo "[$rc, $(python3 -c "print(round($(now)-$a,1))") s] $*: $(printf '%s' "$out" | tail -n 2 | tr '\n' ' ' | cut -c1-200)"; }
echo "user $(id -un), sudo: $(sudo -n true 2>&1 | head -1)"
t brew install tree
t sh -c 'npm install -g --prefix ~/.npm-global left-pad >/dev/null && ls ~/.npm-global/lib/node_modules'
t sh -c 'python3 -m venv ~/venv && ~/venv/bin/pip -q install six && echo ok'
t sh -c 'mkdir -p ~/cli && cd ~/cli && swift package init --type executable --name cli >/dev/null && swift build -c release'
t codesign -s - -f ~/cli/.build/release/cli
t security list-keychains
t security create-keychain -p bb ~/Library/Keychains/box.keychain-db
t open -a TextEdit
t osascript -e 'tell application "System Events" to get name of every process'
t screencapture -x /tmp/shot-$(id -un).png
t sh -c 'xcrun simctl list devices booted | grep -c Booted'
t sh -c 'rm -rf ~/probe && cp -R /Users/Shared/bb/probe ~/probe && xcodebuild -project ~/probe/BBProbe.xcodeproj -scheme BBProbe -destination "generic/platform=iOS Simulator" -derivedDataPath ~/probe-derived build-for-testing -quiet'
U=$(xcrun simctl list devices booted | sed -n 's/.*slot (\([-0-9A-F]*\)).*/\1/p')
t xcodebuild test-without-building -project ~/probe/BBProbe.xcodeproj -scheme BBProbe -destination "id=$U" -derivedDataPath ~/probe-derived -collect-test-diagnostics never -quiet
t sh -c 'nohup python3 -m http.server 8799 --bind 127.0.0.1 >/dev/null 2>&1 & sleep 1; curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8799/'
