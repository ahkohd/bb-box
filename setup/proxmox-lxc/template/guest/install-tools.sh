#!/bin/bash
# Install the pinned tools into an image, as root, during the template build.
# Each archive or executable was downloaded into <artifact-dir> under its URL's
# file name and is checked against its pinned SHA-256 again here. Each tool is
# unpacked into its own directory, <prefix>/<name>-<version>, owned by root,
# and only its declared commands are linked into <bindir>.
#
# usage: install-tools.sh <pins.json> <artifact-dir> [<prefix>] [<bindir>]
set -euo pipefail
umask 022

pins=$1
artifacts=$2
prefix=${3:-/opt/bb-box-tools}
bindir=${4:-/usr/local/bin}

die() {
  echo "install-tools: $*" >&2
  exit 1
}

for tool in jq sha256sum tar xz; do
  command -v "$tool" >/dev/null || die "missing $tool"
done
install -d -m 0755 "$prefix" "$bindir"

count=$(jq -er '.tools | length' "$pins")
for index in $(seq 0 $((count - 1))); do
  entry=$(jq -c ".tools[$index]" "$pins")
  name=$(jq -er .name <<<"$entry")
  version=$(jq -er .version <<<"$entry")
  url=$(jq -er .url <<<"$entry")
  sha=$(jq -er .sha256 <<<"$entry")
  strip=$(jq -er .strip <<<"$entry")
  [[ "$name" =~ ^[a-z][a-z0-9-]{0,31}$ && "$version" =~ ^[0-9][0-9A-Za-z.+~-]*$ ]] || die "invalid name or version in entry $index"
  [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || die "$name has no SHA-256"
  file=$artifacts/${url##*/}
  [ -f "$file" ] || die "$name artifact ${url##*/} is missing"
  echo "$sha  $file" | sha256sum -c --quiet - || die "$name artifact does not match its pinned SHA-256"

  dest=$prefix/$name-$version
  [ ! -e "$dest" ] && [ ! -e "$dest.partial" ] || die "$dest already exists"
  mkdir -m 0755 "$dest.partial"
  case "$url" in
    *.tar.gz | *.tgz) tar -xzf "$file" -C "$dest.partial" --strip-components="$strip" --no-same-owner --no-same-permissions ;;
    *.tar.xz) tar -xJf "$file" -C "$dest.partial" --strip-components="$strip" --no-same-owner --no-same-permissions ;;
    *)
      target=$(jq -er .file <<<"$entry")
      [[ "$target" =~ ^[A-Za-z0-9._-]+$ ]] || die "$name has an invalid file name"
      install -m 0755 "$file" "$dest.partial/$target"
      ;;
  esac
  if [ "$(id -u)" = 0 ]; then chown -R root:root "$dest.partial"; fi
  chmod -R go-w "$dest.partial"
  mv "$dest.partial" "$dest"

  while IFS=$'\t' read -r command path; do
    [[ "$command" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || die "$name has an invalid command name"
    real=$(realpath -e "$dest/$path" 2>/dev/null) || die "$name does not contain $path"
    case "$real" in "$dest"/*) ;; *) die "$name link $command leaves $dest" ;; esac
    [ -f "$real" ] && [ -x "$real" ] || die "$name $path is not an executable file"
    link=$bindir/$command
    if [ -e "$link" ] || [ -L "$link" ]; then
      die "$link already exists"
    fi
    ln -s "$dest/$path" "$link"
  done < <(jq -r '.links | to_entries[] | "\(.key)\t\(.value)"' <<<"$entry")
  echo "installed $name $version in $dest"
done
