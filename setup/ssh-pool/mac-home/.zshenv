# Added by bb-box: the login PATH, Homebrew and Node for SSH commands, which skip ~/.zprofile.
if [ -x /usr/libexec/path_helper ]; then eval "$(/usr/libexec/path_helper -s)"; fi
if [ -d /opt/homebrew/bin ]; then
  export HOMEBREW_PREFIX=/opt/homebrew HOMEBREW_CELLAR=/opt/homebrew/Cellar HOMEBREW_REPOSITORY=/opt/homebrew
  PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"
fi
for d in /opt/homebrew/opt/node@24/bin /opt/homebrew/opt/node/bin; do if [ -d "$d" ]; then PATH="$d:$PATH"; break; fi; done
export PATH CUA_DRIVER_RS_TELEMETRY_ENABLED=false CUA_DRIVER_RS_UPDATE_CHECK=false
