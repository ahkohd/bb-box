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
#   again                      each user loginwindow signed in again as it was logged out
#   ipc                        "<type> <id> <owner>" lines
#   clock                      what date +%s says, when it exists
#   sunlnk                     paths on the Mac's disk that stat -f %Sf says have the sunlnk flag
#   openfiles/<pid>            the files lsof says process <pid> has open
#   flags/sip-off              csrutil says System Integrity Protection is disabled
#   flags/no-import            security import fails, so no box user gets its signing identity
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
# The password in /etc/kcpassword, as loginwindow reads it: XORed with Apple's key, up to the first null.
kcpassword_of() {
  [ -s "$R/etc/kcpassword" ] || return 0
  perl -e '
    my @key = (0x7D, 0x89, 0x52, 0x23, 0xD2, 0xBC, 0xDD, 0xEA, 0xA3, 0xB9, 0x1F);
    local $/;
    my @bytes = unpack("C*", <STDIN>);
    my $password = pack("C*", map { $bytes[$_] ^ $key[$_ % 11] } 0 .. $#bytes);
    $password =~ s/\0.*//s;
    print $password;' <"$R/etc/kcpassword"
}
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
    # dscl . -read|-list|-create|-delete <record> [attribute [value...]]. flags/directory-down: the directory
    # service does not answer, as while userspace restarts.
    [ "${1:-}" = . ] || exit 64
    if flag directory-down; then
      echo "<dscl_cmd> DS Error: -14002 (eDSNodeNotFound)" >&2
      exit 70
    fi
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
          # As macOS, an attribute outside the standard set has dsAttrTypeNative: before it.
          case $attribute in IsHidden) prefix=dsAttrTypeNative: ;; *) prefix='' ;; esac
          printf '%s%s: %s\n' "$prefix" "$attribute" "$(values "$dir/$attribute")"
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
        if [ -z "$attribute" ]; then
          rm -rf "$dir"
        elif [ $# -eq 0 ]; then
          rm -f "$dir/$attribute"
        else
          grep -qxF "$1" "$dir/$attribute" 2>/dev/null || {
            echo "<dscl_cmd> DS Error: -14134 (eDSAttributeNotFound)" >&2
            exit 54
          }
          edit "$dir/$attribute" grep -vxF "$1"
        fi
        ;;
      *) exit 64 ;;
    esac
    ;;

  sysadminctl)
    # It writes as NSLog does. flags/sysadminctl-fails: says it made a user, makes none, and exits 0, as sysadminctl can.
    say() { echo "2026-01-01 00:00:00.000 sysadminctl[1:1] $*" >&2; }
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
        # -password - reads it from stdin.
        [ "$password" != - ] || IFS= read -r password || :
        say "Creating user record..."
        flag sysadminctl-fails && exit 0
        # It makes no user whose full name another user has, and exits 0.
        for name in "$F"/users/*/RealName; do
          [ -e "$name" ] && [ "$(cat "$name")" = "$full" ] || continue
          say "User with full name '$full' already exists."
          exit 0
        done
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
        # -autologin set -userName <user> -password <password>, as on macOS 27: it names the user, writes no
        # /etc/kcpassword, and exits 0.
        case $2 in
          set)
            mkdir -p "$F/defaults/_Library_Preferences_com.apple.loginwindow"
            echo "$4" >"$F/defaults/_Library_Preferences_com.apple.loginwindow/autoLoginUser"
            say "SACSetAutoLoginPassword error:22"
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
    [ -d "$F/users/$who" ] || {
      echo "Record was not found." >&2
      exit 200
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
      # loginwindow signs in the automatic login as it starts, when /etc/kcpassword holds its password, unless
      # flags/loginwindow-waits.
      kickstart)
        flag loginwindow-waits && exit 0
        user=$(autologin_user)
        if [ -n "$user" ] && [ -d "$F/users/$user" ] && [ "$(kcpassword_of)" = "$(cat "$F/secrets/$user" 2>/dev/null)" ]; then
          echo "$user" >"$F/console"
        else
          echo root >"$F/console"
        fi
        ;;
      # Logging a user out leaves its processes for pkill. loginwindow signs the user in again when it is
      # the automatic login, as macOS 27 does a few seconds later.
      bootout)
        uid=${2#*/} console=$(cat "$F/console")
        [ "$(uid_of "$console")" = "$uid" ] || exit 0
        if [ "$console" = "$(autologin_user)" ]; then echo "$console" >>"$F/again"; else echo root >"$F/console"; fi
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
    # stat -f %Sf <path>: sunlnk for a path sunlnk lists, as macOS 27 marks a user's /private/var/folders folders.
    if [ "$2" = %Sf ]; then
      grep -qxF "$3" "$F/sunlnk" 2>/dev/null && echo sunlnk || echo -
      exit 0
    fi
    # stat -f %Lp <path>: its permission bits, as macOS gives them; stat -f %g: staff's GID, 20, as a home's group is.
    if [ "$2" = %Lp ]; then exec /usr/bin/stat -c %a "$3"; fi
    if [ "$2" = %g ]; then echo 20; exit 0; fi
    # stat -f %u <path>: the UID owners says owns it, else root's.
    if [ "$2" = %u ]; then
      real=$(readlink -f "$3")
      awk -v p="$real" '{ q = substr($0, index($0, " ") + 1); if (q == p) o = $1 } END { print (o == "" ? 0 : o) }' "$F/owners" 2>/dev/null || echo 0
      exit 0
    fi
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
  # sw_vers: macOS 26.0, or the version in flags/macos.
  sw_vers) if [ "${1:-}" = -buildVersion ]; then echo 25A354; else cat "$F/flags/macos" 2>/dev/null || echo 26.0; fi ;;
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
    [ "$1" != -h ] || shift
    owner=$(uid_of "${1%%:*}")
    shift
    own "$owner" "$deep" "$@"
    ;;

  find)
    # find with -uid: the paths owners says the UID owns. Each argument is moved to the end once. flags/mds: once
    # a sweep of the Data volume has run, as Spotlight's mds does, a process of the user runs again and has made
    # its temporary folders again.
    start=${1:-} uid=''
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
    case $start in
      */private/var/folders) exec /usr/bin/find "$@" ;;
    esac
    [ -n "$uid" ] && flag mds || exec /usr/bin/find "$@"
    status=0
    /usr/bin/find "$@" || status=$?
    mkdir -p "$R/private/var/folders/zz/user$uid/T"
    own "$uid" yes "$R/private/var/folders/zz/user$uid"
    echo "9$uid $uid distnoted 1" >>"$F/processes"
    exit "$status"
    ;;

  crontab)
    # crontab -u <user> -r
    [ -e "$R/private/var/at/tabs/$2" ] || exit 1
    rm -f "$R/private/var/at/tabs/$2"
    ;;
  ipcs)
    type=${1#-}
    printf 'IPC status from <running system> as of Thu Oct  2 12:00:00 UTC 2026\nT     ID     KEY        MODE       OWNER    GROUP\n'
    [ -e "$F/ipc" ] || exit 0
    awk -v t="$type" '$1 == t { printf "%s %6s 0x0000162e --rw-------  %8s    staff\n", $1, $2, $3 }' "$F/ipc"
    ;;
  ipcrm) edit "$F/ipc" awk -v t="${1#-}" -v id="$2" '!($1 == t && $2 == id)' ;;

  pgrep)
    # pgrep [-l] -u <uid or user> [-x <name>]
    long=no who='' name=''
    while [ $# -gt 0 ]; do
      case $1 in -l) long=yes ;; -u) who=$(uid_of "$2"); shift ;; -x) name=$2; shift ;; esac
      shift
    done
    [ -e "$F/processes" ] || exit 1
    awk -v u="$who" -v n="$name" -v l="$long" '$2 == u && (n == "" || $3 == n) { print (l == "yes" ? $1 " " $3 : $1); found = 1 } END { exit !found }' "$F/processes"
    ;;
  csrutil)
    # csrutil status: flags/sip-off says it is disabled.
    if flag sip-off; then echo "System Integrity Protection status: disabled."; else echo "System Integrity Protection status: enabled."; fi
    ;;
  lsof)
    # lsof -p <pid> -Fn: the files openfiles/<pid> lists, as n lines.
    [ -f "$F/openfiles/$2" ] && sed 's/^/n/' "$F/openfiles/$2"
    ;;
  plutil)
    # plutil -extract <key> raw <plist>: a <key>'s <string> in an XML plist.
    # plutil -create xml1 <plist> makes an empty one, and plutil -replace
    # <key> -bool <YES|NO> <plist> sets a <key>, one line each.
    if [ "$1" = -convert ]; then exec cat "$5"; fi
    if [ "$1" = -create ]; then printf '<plist><dict>\n</dict></plist>\n' >"$3"; exit; fi
    if [ "$1" = -replace ]; then
      [ -f "$5" ] || exit 1
      grep -v "<key>$2</key>" "$5" | sed "s:^</dict></plist>$:<key>$2</key><bool>$4</bool>\n&:" >"$5.new" && mv -f "$5.new" "$5"
      exit
    fi
    sed -n "s:.*<key>$2</key><string>\([^<]*\)</string>.*:\1:p" "$4" | head -n 1
    ;;
  codesign)
    # codesign -dv <path> or codesign -d -r- <path>: from a signature file
    # beside the program, <path>.sig, with lines identifier=, requirement= and
    # team=. codesign --verify passes where there is one.
    path=$(eval "echo \${$#}")
    sig=$path.sig
    [ -f "$sig" ] || { echo "$path: code object is not signed at all" >&2; exit 1; }
    case $2 in
      -r-) echo "designated => $(sed -n 's/^requirement=//p' "$sig")" >&2 ;;
      *) echo "Identifier=$(sed -n 's/^identifier=//p' "$sig")" >&2; sed -n 's/^team=/TeamIdentifier=/p' "$sig" >&2 ;;
    esac
    ;;
  csreq)
    # csreq -r- -b <out>: the requirement's text, as its compiled form.
    cat
    ;;
  xxd)
    [ "$1" = -p ] || exit 2
    od -An -v -tx1 | tr -d ' \n'
    echo
    ;;
  clang | swiftc)
    # clang or swiftc ... -o <out> <source>: an executable that runs nothing, unless flags/no-clang.
    flag no-clang && exit 1
    out=''
    while [ $# -gt 0 ]; do [ "$1" != -o ] || out=$2; shift; done
    printf '#!/bin/sh\n' >"$out" && chmod 755 "$out"
    ;;
  security)
    # security create-keychain makes the keychain's file, import -k <keychain> puts the identity in it
    # unless flags/no-import, and find-identity -p codesigning <keychain> lists it; list-keychains -d user
    # [-s <keychains>] keeps the user's search list in keychains/<uid>, and gives it as security does,
    # each quoted on a line.
    case $1 in
      create-keychain) path=$(eval "echo \${$#}"); mkdir -p "$(dirname "$R$path")" && : >"$R$path" ;;
      import)
        flag no-import && exit 1
        [ -r "$2" ] || { echo "security: Error reading infile $2: Permission denied" >&2; exit 1; }
        echo identity >"$R$4"
        ;;
      find-identity) [ -s "$R$4" ] && printf '  1) F26BFAF6B29A8AFCF02CD1EC3DBE7E68864E1F4E "bb-box local code signing"\n' ;;
      list-keychains)
        list=$F/keychains/$(id -u)
        mkdir -p "$F/keychains"
        if [ "${4:-}" = -s ]; then shift 4; printf '%s\n' "$@" >"$list"; else [ -f "$list" ] && sed 's/.*/    "&"/' "$list"; fi
        ;;
    esac
    ;;
  pkill)
    # pkill -KILL -u <uid>: each process loses a kill.
    if [ "${4:-}" = -x ]; then
      edit "$F/processes" awk -v u="$(uid_of "$3")" -v n="$5" '$2 == u && $3 == n { $4 -= 1; if ($4 <= 0) next } { print }'
      exit 0
    fi
    edit "$F/processes" awk -v u="$3" '$2 == u { $4 -= 1; if ($4 <= 0) next } { print }'
    ;;

  date) if [ "${1:-}" = +%s ] && [ -e "$F/clock" ]; then cat "$F/clock"; else exec /bin/date "$@"; fi ;;
  shutdown) ;;
  node) echo v24.9.0 ;;
  npm | git | gh | brew | pmset | softwareupdate | mdutil | xcodebuild | DevToolsSecurity | open | dsmemberutil) ;;
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
  # The input probe's one-point move: the pointer moves unless flags/no-input, as without the Accessibility grant.
  osascript) if flag no-input; then echo 0; else echo 1; fi ;;
  ipconfig) [ "$2" = en0 ] && echo 192.0.2.30 ;;
  # curl -o <file> fetches Cua Driver's archive, from flags/cua.tgz; without -o, Homebrew's installer, from flags/install.sh.
  curl)
    # A download is flags/<the URL's file name> when there is one, else Cua's archive.
    out='' url=''
    while [ $# -gt 0 ]; do
      [ "$1" != -o ] || out=$2
      case $1 in https://*) url=$1 ;; esac
      shift
    done
    fixture=$F/flags/${url##*/}
    [ -n "$url" ] && [ -f "$fixture" ] || fixture=$F/flags/cua.tgz
    if [ -n "$out" ]; then cp "$fixture" "$out"; else cat "$F/flags/install.sh"; fi
    ;;
  shasum)
    cat >/dev/null
    ! flag bad-sha
    ;;
  # hdiutil attach ... -mountpoint <dir> <image>: the image is a tar of what it holds. detach: nothing to do.
  hdiutil)
    if [ "$1" = attach ]; then
      while [ $# -gt 1 ]; do [ "$1" != -mountpoint ] || dir=$2; shift; done
      tar -xf "$1" -C "$dir"
    fi
    ;;
  ditto) cp -R "$1" "$2" ;;
  diskutil) printf '   Device Node:              %s\n   Type (Bundle):             %s\n' "${2:-}" "$(cat "$F/flags/homes-fs" 2>/dev/null || echo apfs)" ;;
  cp)
    if [ "${1:-}" = -c ]; then
      shift
      ! flag no-clonefile || { echo "cp: $2: clonefile failed: Operation not supported" >&2; exit 1; }
      if flag slow-clonefile; then
        /bin/cp "$@"
        : >"$F/cloning"
        exec sleep 30
      fi
    fi
    exec /bin/cp "$@"
    ;;
  # Gatekeeper accepts what it is shown, unless flags/gatekeeper-refuses.
  spctl) ! flag gatekeeper-refuses ;;
  # installer -pkg <pkg> -target / and killall coreaudiod: recorded only.
  installer | killall) : ;;
  *)
    echo "fake-macos.sh: no fake $tool" >&2
    exit 127
    ;;
esac
