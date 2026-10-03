#!/bin/bash
# bb-box-feature (049): installs a Dev Container feature on this box as a dev
# container build would, for a project image's script. It fetches the feature
# from its OCI registry, anonymously as public features allow, or from a
# tarball URL, then runs its install.sh as root with:
# - its options as variables, upper-cased, with the defaults in its
#   devcontainer-feature.json for the options not given;
# - _REMOTE_USER, _CONTAINER_USER and their homes: the box user's.
# Its containerEnv goes in /etc/environment, where boxes' commands read their
# PATH and variables; a value that refers to another variable, other than
# PATH's ${PATH}, is left out with a note.
#
# usage: bb-box-feature <feature> [<option>=<value> ...]
#   <feature>: a registry reference such as ghcr.io/devcontainers/features/node:1,
#   one by digest (...@sha256:...), or a tarball's https:// URL.
#
# For tests: BB_BOX_FEATURE_SCHEME=http reaches a registry over HTTP,
# BB_BOX_FEATURE_ENVIRONMENT names another environment file, and
# BB_BOX_FEATURE_ANY_USER=1 runs it without root.
set -euo pipefail

die() {
  echo "bb-box-feature: $*" >&2
  exit 1
}
[ $# -ge 1 ] || die "usage: bb-box-feature <feature> [<option>=<value> ...]"
[ "$(id -u)" = 0 ] || [ "${BB_BOX_FEATURE_ANY_USER:-}" = 1 ] || die "run it as root: sudo bb-box-feature $*"
ref=$1
shift
environment=${BB_BOX_FEATURE_ENVIRONMENT:-/etc/environment}
scheme=${BB_BOX_FEATURE_SCHEME:-https}
# The box user: the first user's, as every bb-box image has it.
user=$(getent passwd 1000 | cut -d: -f1 || true)
user=${user:-box}
home=$(getent passwd 1000 | cut -d: -f6 || true)
home=${home:-/home/$user}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

case $ref in
  http://* | https://*)
    curl -fsSL "$ref" -o "$work/feature.tar"
    ;;
  ./* | ../* | /*)
    die "$ref is a feature in the project's repository, which a build cannot read: copy its install.sh into the script instead."
    ;;
  *)
    registry=${ref%%/*}
    rest=${ref#*/}
    if [[ $rest == *@* ]]; then
      repo=${rest%@*} tag=${rest#*@}
    elif [[ ${rest##*/} == *:* ]]; then
      repo=${rest%:*} tag=${rest##*:}
    else
      repo=$rest tag=latest
    fi
    # An anonymous pull token from the realm the registry names, as ghcr.io gives one.
    auth=()
    challenge=$(curl -sS -o /dev/null -D - "$scheme://$registry/v2/" | tr -d '\r' | grep -i '^www-authenticate: *bearer' || true)
    if [ -n "$challenge" ]; then
      realm=$(sed -n 's/.*realm="\([^"]*\)".*/\1/p' <<<"$challenge")
      service=$(sed -n 's/.*service="\([^"]*\)".*/\1/p' <<<"$challenge")
      token=$(curl -fsSL "$realm?service=$service&scope=repository:$repo:pull" | jq -r '.token // .access_token // empty')
      [ -n "$token" ] || die "$registry gave no token to pull $repo."
      auth=(-H "Authorization: Bearer $token")
    fi
    manifest=$(curl -fsSL "${auth[@]}" -H 'Accept: application/vnd.oci.image.manifest.v1+json' "$scheme://$registry/v2/$repo/manifests/$tag") ||
      die "$registry has no feature $repo:$tag."
    digest=$(jq -r '([.layers[] | select(.mediaType == "application/vnd.devcontainers.layer.v1+tar")][0] // .layers[0]).digest // empty' <<<"$manifest")
    [ -n "$digest" ] || die "$ref has no feature layer."
    curl -fsSL "${auth[@]}" "$scheme://$registry/v2/$repo/blobs/$digest" -o "$work/feature.tar"
    ;;
esac

mkdir "$work/feature"
tar -xf "$work/feature.tar" -C "$work/feature"
# install.sh at the top, or in the one directory a tarball may have.
found=$(find "$work/feature" -name install.sh -print | sort | head -n 1)
[ -n "$found" ] || die "$ref has no install.sh."
dir=$(dirname "$found")
spec=$dir/devcontainer-feature.json
[ -f "$spec" ] || echo '{}' >"$spec"
id=$(jq -r '.id // "feature"' "$spec")

# The spec's names: anything but letters, digits and _ becomes _, as does a leading digit, then upper case.
name_of() { sed -E 's/[^A-Za-z0-9_]/_/g; s/^[0-9_]+/_/' <<<"$1" | tr '[:lower:]' '[:upper:]'; }
declare -A values=()
while IFS=$'\t' read -r key value; do
  [ -n "$key" ] && values[$key]=$value
done < <(jq -r '.options // {} | to_entries[] | [.key, (if (.value | has("default")) then (.value.default | tostring) else "" end)] | @tsv' "$spec")
for pair in "$@"; do
  [[ $pair == *=* ]] || die "an option is <name>=<value>, not $pair."
  values[${pair%%=*}]=${pair#*=}
done
vars=(_REMOTE_USER="$user" _REMOTE_USER_HOME="$home" _CONTAINER_USER="$user" _CONTAINER_USER_HOME="$home")
for key in "${!values[@]}"; do vars+=("$(name_of "$key")=${values[$key]}"); done

echo "bb-box-feature: installing $id from $ref"
chmod +x "$dir/install.sh"
(cd "$dir" && env "${vars[@]}" ./install.sh)

# Its containerEnv, where boxes' commands read it.
touch "$environment"
# In place when the file has it, else at the end.
set_variable() {
  if grep -q "^$1=" "$environment"; then
    awk -v key="$1=" -v line="$1=\"$2\"" 'index($0, key) == 1 { print line; next } { print }' "$environment" >"$environment.new"
  else
    { cat "$environment"; printf '%s="%s"\n' "$1" "$2"; } >"$environment.new"
  fi
  cat "$environment.new" >"$environment" && rm -f "$environment.new"
}
while IFS=$'\t' read -r key value; do
  [ -n "$key" ] || continue
  if [ "$key" = PATH ]; then
    current=$(sed -n 's/^PATH="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' "$environment")
    [ -n "$current" ] || current=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    added=$(sed -e 's/\${PATH}//g; s/\$PATH//g' <<<"$value" | tr ':' '\n' | sed '/^$/d' | tac)
    for path in $added; do [[ ":$current:" == *":$path:"* ]] || current=$path:$current; done
    set_variable PATH "$current"
  elif [[ $value == *'$'* ]]; then
    echo "bb-box-feature: left out $key=$value, which refers to another variable: set it in the script." >&2
  else
    set_variable "$key" "$value"
  fi
done < <(jq -r '.containerEnv // {} | to_entries[] | [.key, .value] | @tsv' "$spec")
for unsupported in entrypoint mounts privileged capAdd securityOpt init; do
  jq -e --arg key "$unsupported" 'has($key)' "$spec" >/dev/null &&
    echo "bb-box-feature: $id asks for $unsupported, which a box's image cannot give; it may need it at run time." >&2
done
echo "bb-box-feature: installed $id"
