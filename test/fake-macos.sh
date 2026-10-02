#!/bin/sh
# Fake macOS tools for the Mac helper's tests (test/ssh-pool-mac.test.ts).
# Each tool is a link to this script, which keeps the Mac's state in files
# under $FAKE_MAC_STATE and its disk under $FAKE_MAC_ROOT:
#
#   users/<name>/<attribute>   the local directory's users, one value a line
#   groups/<name>/<attribute>  its groups
#   secrets/<name>             each user's password, as sysadminctl was given it
#   defaults/<domain>/<key>    preferences, the domain's slashes made underscores
#   console                    the user at the console: root at the login window
#   owners                     "<uid> <path>" lines, the last for a path winning, which find -uid reads
#   processes                  "<pid> <uid> <name> <kills>" lines: a process ends at its last kill
#   at, ipc                    "<job> <owner>" and "<type> <id> <owner>" lines
#   clock                      what date +%s says, when it exists
#   flags/<name>               changes a tool, as each tool below says
#   calls                      each tool and its arguments, one a line

set -u
F=$FAKE_MAC_STATE
R=$FAKE_MAC_ROOT
tool=${0##*/}
printf '%s %s\n' "$tool" "$*" >>"$F/calls"

flag() { [ -e "$F/flags/$1" ]; }
uid_of() {
  case $1 in
    root) echo 0 ;;
    *[!0-9]*) cat "$F/users/$1/UniqueID" 2>/dev/null ;;
    *) echo "$1" ;;
  esac
}
values() { tr '\n' ' ' <"$1" | sed 's/ $//'; }
domain() { printf '%s' "$1" | tr / _; }
autologin_user() { cat "$F/defaults/_Library_Preferences_com.apple.loginwindow/autoLoginUser" 2>/dev/null; }
# Rewrites a state file through a filter.
edit() {
  file=$1
  shift
  touch "$file"
  "$@" <"$file" >"$file.new.$$" || :
  mv -f "$file.new.$$" "$file"
}
# Records that a UID owns paths: with -R, each path and everything under it.
own() {
  owner=$1 deep=$2
  shift 2
  for path; do
    real=$(readlink -f "$path") || continue
    if [ "$deep" = yes ]; then
      /usr/bin/find "$real" | sed "s|^|$owner |" >>"$F/owners"
    else
      echo "$owner $real" >>"$F/owners"
    fi
  done
}

case $tool in
  id)
    case ${1:-} in
      -u) if [ $# -ge 2 ]; then uid_of "$2" | grep . || exit 1; else echo 0; fi ;;
      -g) if [ $# -ge 2 ]; then cat "$F/users/$2/PrimaryGroupID" 2>/dev/null || exit 1; else echo 0; fi ;;
      -F) cat "$F/users/$2/RealName" 2>/dev/null || exit 1 ;;
      *) echo 'uid=0(root) gid=0(wheel)' ;;
    esac
    ;;

  dscl)
    # dscl . -read|-list|-create|-delete <record> [attribute [value...]]
    [ "${1:-}" = . ] || exit 64
    op=$2 record=${3:-}
    case $record in
      /Users) dir=$F/users ;;
      /Groups) dir=$F/groups ;;
      /Users/*) dir=$F/users/${record#/Users/} ;;
      /Groups/*) dir=$F/groups/${record#/Groups/} ;;
      *) exit 64 ;;
    esac
    attribute=${4:-}
    shift 3
    [ $# -eq 0 ] || shift
    case $op in
      -read)
        [ -d "$dir" ] || {
          echo "<dscl_cmd> DS Error: -14136 (eDSRecordNotFound)" >&2
          exit 56
        }
        if [ -n "$attribute" ]; then
          [ -f "$dir/$attribute" ] || {
            echo "No such key: $attribute" >&2
            exit 181
          }
          printf '%s: %s\n' "$attribute" "$(values "$dir/$attribute")"
        else
          for file in "$dir"/*; do if [ -f "$file" ]; then printf '%s: %s\n' "${file##*/}" "$(values "$file")"; fi; done
        fi
        ;;
      -list)
        for record in "$dir"/*; do
          [ -d "$record" ] || continue
          if [ -n "$attribute" ]; then printf '%s %s\n' "${record##*/}" "$(cat "$record/$attribute" 2>/dev/null)"; else echo "${record##*/}"; fi
        done
        ;;
      -create)
        mkdir -p "$dir"
        [ -z "$attribute" ] || printf '%s\n' "$@" >"$dir/$attribute"
        ;;
      -delete)
        [ -d "$dir" ] || exit 56
        if [ -n "$attribute" ]; then rm -f "$dir/$attribute"; else rm -rf "$dir"; fi
        ;;
      *) exit 64 ;;
    esac
    ;;

  sysadminctl)
    # flags/sysadminctl-fails: says it made a user, makes none, and exits 0, as sysadminctl can.
    case ${1:-} in
      -addUser)
        user=$2
        shift 2
        full='' uid='' password='' home=/Users/$user
        while [ $# -ge 2 ]; do
          case $1 in
            -fullName) full=$2 ;;
            -UID) uid=$2 ;;
            -password) password=$2 ;;
            -home) home=$2 ;;
          esac
          shift 2
        done
        echo "sysadminctl[1]: Creating user record..." >&2
        flag sysadminctl-fails && exit 0
        if [ -z "$uid" ]; then
          uid=501
          while dscl . -list /Users UniqueID | awk -v id="$uid" '$2 == id { found = 1 } END { exit !found }'; do uid=$((uid + 1)); done
        fi
        mkdir -p "$F/users/$user" "$F/secrets"
        echo "$uid" >"$F/users/$user/UniqueID"
        echo 20 >"$F/users/$user/PrimaryGroupID"
        echo "$full" >"$F/users/$user/RealName"
        echo "$home" >"$F/users/$user/NFSHomeDirectory"
        echo /bin/zsh >"$F/users/$user/UserShell"
        printf '%s\n' "$password" >"$F/secrets/$user"
        ;;
      -deleteUser)
        home=$(cat "$F/users/$2/NFSHomeDirectory" 2>/dev/null)
        rm -rf "$F/users/$2" "$F/secrets/$2"
        [ -z "$home" ] || rm -rf "$R$home"
        ;;
      -autologin)
        # -autologin set -userName <user> -password <password>. It needs the user's password, and FileVault off.
        case $2 in
          set)
            flag filevault-on && exit 0
            [ "$(cat "$F/secrets/$4" 2>/dev/null)" = "$6" ] || exit 0
            mkdir -p "$F/defaults/_Library_Preferences_com.apple.loginwindow"
            echo "$4" >"$F/defaults/_Library_Preferences_com.apple.loginwindow/autoLoginUser"
            echo obscured >"$R/etc/kcpassword"
            ;;
          off) rm -f "$F/defaults/_Library_Preferences_com.apple.loginwindow/autoLoginUser" "$R/etc/kcpassword" ;;
        esac
        ;;
    esac
    ;;

  dseditgroup)
    # dseditgroup -o edit -a|-d <user> -t user <group>
    change='' who='' group=''
    while [ $# -gt 0 ]; do
      case $1 in
        -o | -t) shift ;;
        -a) change=add who=$2 && shift ;;
        -d) change=remove who=$2 && shift ;;
        *) group=$1 ;;
      esac
      shift
    done
    [ -d "$F/groups/$group" ] || {
      echo "Group not found." >&2
      exit 64
    }
    edit "$F/groups/$group/GroupMembership" grep -vx "$who"
    [ "$change" = remove ] || echo "$who" >>"$F/groups/$group/GroupMembership"
    ;;

  createhomedir)
    # createhomedir -c -u <user>
    home=$(cat "$F/users/$3/NFSHomeDirectory" 2>/dev/null) || exit 1
    mkdir -p "$R$home/Library/Preferences" "$R$home/Library/Caches" "$R$home/Desktop"
    ;;

  defaults)
    case $1 in
      read) cat "$F/defaults/$(domain "$2")/$3" 2>/dev/null || exit 1 ;;
      write)
        mkdir -p "$F/defaults/$(domain "$2")"
        printf '%s\n' "$(eval "printf '%s' \"\${$#}\"")" >"$F/defaults/$(domain "$2")/$3"
        ;;
      delete) rm -f "$F/defaults/$(domain "$2")/$3" ;;
    esac
    ;;

  launchctl)
    case $1 in
      # flags/screensharing: Screen Sharing is on. flags/no-remote-login: Remote Login is off.
      print)
        case $2 in
          system/com.apple.screensharing) flag screensharing || exit 113 ;;
          system/com.openssh.sshd) if flag no-remote-login; then exit 113; fi ;;
          *) exit 113 ;;
        esac
        ;;
      asuser)
        shift 2
        command=$1
        shift
        if [ -x "$FAKE_MAC_BIN/${command##*/}" ]; then exec "$FAKE_MAC_BIN/${command##*/}" "$@"; fi
        exec "$R$command" "$@"
        ;;
      # loginwindow signs in the automatic login as it starts, unless flags/loginwindow-waits.
      kickstart)
        flag loginwindow-waits && exit 0
        user=$(autologin_user)
        if [ -n "$user" ] && [ -e "$R/etc/kcpassword" ] && [ -d "$F/users/$user" ]; then echo "$user" >"$F/console"; else echo root >"$F/console"; fi
        ;;
      # Logging a user out leaves its processes for pkill.
      bootout)
        uid=${2#*/}
        [ "$(uid_of "$(cat "$F/console")")" != "$uid" ] || echo root >"$F/console"
        ;;
    esac
    ;;

  sudo)
    while [ $# -gt 0 ]; do
      case $1 in
        -n | -H) shift ;;
        -u) shift 2 ;;
        --) shift && break ;;
        *) break ;;
      esac
    done
    command=$1
    shift
    if [ -x "$FAKE_MAC_BIN/${command##*/}" ]; then exec "$FAKE_MAC_BIN/${command##*/}" "$@"; fi
    if [ -x "$R$command" ]; then exec "$R$command" "$@"; fi
    exec "$command" "$@"
    ;;

  stat)
    # stat -f %Su <path>: the console's user, or flags/owner's for any other path.
    case $3 in
      /dev/console) cat "$F/console" ;;
      *) cat "$F/flags/owner" 2>/dev/null || echo root ;;
    esac
    ;;

  sysctl)
    case $2 in
      kern.bootsessionuuid) cat "$F/boot" 2>/dev/null || echo 6F0E2A1C-0000-4000-8000-000000000001 ;;
      hw.ncpu) echo 8 ;;
      hw.memsize) echo 17179869184 ;;
      *) exit 1 ;;
    esac
    ;;
  sw_vers) echo 26.0 ;;
  uname) case ${1:-} in -m) echo arm64 ;; *) echo Darwin ;; esac ;;
  fdesetup) if flag filevault-on; then echo "FileVault is On."; else echo "FileVault is Off."; fi ;;
  ioreg) echo '  |   "IOPlatformUUID" = "0A1B2C3D-0000-4000-8000-000000000001"' ;;
  visudo) ! flag visudo-refuses && grep -q NOPASSWD "$2" ;;
  chflags) ;;

  chown)
    deep=no
    [ "$1" != -R ] || {
      deep=yes
      shift
    }
    owner=$(uid_of "${1%%:*}")
    shift
    own "$owner" "$deep" "$@"
    ;;

  find)
    # find with -uid: the paths owners says the UID owns. Each argument is moved to the end once.
    count=$#
    while [ "$count" -gt 0 ]; do
      argument=$1
      shift
      count=$((count - 1))
      if [ "$argument" = -uid ]; then
        uid=$1
        shift
        count=$((count - 1))
        set -- "$@" "("
        for path in $(awk -v u="$uid" '{ p = substr($0, index($0, " ") + 1); o[p] = $1 } END { for (p in o) if (o[p] == u) print p }' "$F/owners" 2>/dev/null); do
          set -- "$@" -path "$path" -o
        done
        set -- "$@" -false ")"
      else
        set -- "$@" "$argument"
      fi
    done
    exec /usr/bin/find "$@"
    ;;

  crontab)
    # crontab -u <user> -r
    [ -e "$R/private/var/at/tabs/$2" ] || exit 1
    rm -f "$R/private/var/at/tabs/$2"
    ;;
  atq)
    [ -s "$F/at" ] || exit 0
    printf 'Date                            Owner           Queue   Job#\n'
    while read -r job owner; do printf 'Thu Oct  2 12:00:00 UTC 2026    %s  a  %s\n' "$owner" "$job"; done <"$F/at"
    ;;
  atrm) edit "$F/at" awk -v j="$1" '$1 != j' ;;
  ipcs)
    type=${1#-}
    printf 'IPC status from <running system> as of Thu Oct  2 12:00:00 UTC 2026\nT     ID     KEY        MODE       OWNER    GROUP\n'
    [ -e "$F/ipc" ] || exit 0
    awk -v t="$type" '$1 == t { printf "%s %6s 0x0000162e --rw-------  %8s    staff\n", $1, $2, $3 }' "$F/ipc"
    ;;
  ipcrm) edit "$F/ipc" awk -v t="${1#-}" -v id="$2" '!($1 == t && $2 == id)' ;;

  pgrep)
    # pgrep [-l] -u <uid>
    long=no
    [ "$1" != -l ] || {
      long=yes
      shift
    }
    [ -e "$F/processes" ] || exit 1
    awk -v u="$2" -v l="$long" '$2 == u { print (l == "yes" ? $1 " " $3 : $1); found = 1 } END { exit !found }' "$F/processes"
    ;;
  pkill)
    # pkill -KILL -u <uid>: each process loses a kill.
    edit "$F/processes" awk -v u="$3" '$2 == u { $4 -= 1; if ($4 <= 0) next } { print }'
    ;;

  date) if [ "${1:-}" = +%s ] && [ -e "$F/clock" ]; then cat "$F/clock"; else exec /bin/date "$@"; fi ;;
  shutdown) ;;
  node) echo v24.9.0 ;;
  npm | git | gh | brew | pmset | softwareupdate | mdutil | xcodebuild | DevToolsSecurity | open) ;;
  # xcode-select -p chooses the Xcode in /Applications, or the Command Line Tools without one.
  xcode-select)
    [ "${1:-}" = -p ] || exit 0
    if [ -d "$R/Applications/Xcode.app" ]; then echo /Applications/Xcode.app/Contents/Developer; else echo /Library/Developer/CommandLineTools; fi
    ;;
  # xcrun simctl list runtimes: iOS's, unless flags/no-ios-runtime, and watchOS's. It fails with flags/simctl-fails.
  xcrun)
    if flag simctl-fails; then exit 1; fi
    if ! flag no-ios-runtime; then echo 'iOS 26.0 (26.0 - 23A343) - com.apple.CoreSimulator.SimRuntime.iOS-26-0'; fi
    echo 'watchOS 26.0 (26.0 - 23R342) - com.apple.CoreSimulator.SimRuntime.watchOS-26-0'
    ;;
  scutil) echo Mac-Mini ;;
  ipconfig) [ "$2" = en0 ] && echo 192.0.2.30 ;;
  # curl -o <file> fetches Cua Driver's archive, from flags/cua.tgz; without -o, Homebrew's installer, from flags/install.sh.
  curl)
    out=''
    while [ $# -gt 0 ]; do
      [ "$1" != -o ] || out=$2
      shift
    done
    if [ -n "$out" ]; then cp "$F/flags/cua.tgz" "$out"; else cat "$F/flags/install.sh"; fi
    ;;
  shasum)
    cat >/dev/null
    ! flag bad-sha
    ;;
  *)
    echo "fake-macos.sh: no fake $tool" >&2
    exit 127
    ;;
esac
