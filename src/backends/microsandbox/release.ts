// The microsandbox release bb-box runs, and the scripts it runs on an msb
// host (053): install that release, report on the host, give Docker's IDs
// of images there, and import an image from Docker. The same scripts run on BB's server, over ssh://, and
// on a BB machine through bb-box's host entry, which runs no others.
//
// msb is beta, so bb-box pins one release and checks its SHA-256 against
// the one it was tested with. msb, its guest agent and libkrunfw are one
// release, kept under bb-box's own data folder with msb's state and images
// (MSB_HOME), apart from a user's ~/.microsandbox. bb-box never runs
// `msb self update`: a new release is a change here that passes the
// conformance suite first.

import { quote } from "../../transports/process.ts";

export const MSB_VERSION = "0.7.7";

/** Each platform's release archive, as `uname -s`-`uname -m` names it, and its SHA-256 as the release publishes it. */
export const MSB_ARCHIVES: Readonly<Record<string, { readonly file: string; readonly sha256: string }>> = {
  "Linux-x86_64": { file: "microsandbox-linux-x86_64.tar.gz", sha256: "b3cc4a5e3f52dfdd938a6f67ac4a9a959ddfe304bab56de4964044b8613f01bb" },
  "Linux-aarch64": { file: "microsandbox-linux-aarch64.tar.gz", sha256: "8997b1ea76de58689fb6d0fa7b32af6fbe8cbc24612da40b168a5b433c7d8318" },
  "Darwin-arm64": { file: "microsandbox-darwin-aarch64.tar.gz", sha256: "eed5faa16217ad375ad9a4eb5e819656baeab8ccde0d3ab7e79c4af49319d403" },
};

export const MSB_DOWNLOAD = `https://github.com/superradcompany/microsandbox/releases/download/v${MSB_VERSION}`;

/**
 * Where bb-box keeps msb on a host where no folder is given: on BB's server
 * and over ssh://. A BB machine's host entry gives its own data folder.
 */
export const MSB_DEFAULT_DIR = "$HOME/.local/share/bb-box/microsandbox";

/**
 * msb puts its sockets under MSB_HOME, at up to 50 bytes more, and a unix
 * socket's path has at most 107. A longer home is reached through a
 * symlink of this user's in /tmp, which msb does not resolve (053).
 */
export const MSB_HOME_MAX = 57;

/** An image reference as bb-box passes it to docker and msb: no spaces or quotes, and no leading "-". */
export const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;

/** The scripts a host runs for bb-box, by name. */
export type MsbScript = "install" | "status" | "images" | "import";

/** Sets `dir` to bb-box's msb folder: BBBOX_MSB_DIR, or MSB_DEFAULT_DIR. */
const PRELUDE = `set -eu
dir=\${BBBOX_MSB_DIR:-${MSB_DEFAULT_DIR}}
version=${MSB_VERSION}
msb=$dir/bin/msb
`;

/**
 * bin/msb, which every call runs: the pinned msb, with MSB_HOME in bb-box's
 * folder, or a link to it when that path is too long for msb's sockets.
 */
function wrapper(): string {
  return `#!/bin/sh
# bb-box's msb ${MSB_VERSION} (053). Written by bb-box's install script.
dir=$(cd "$(dirname "$0")/.." && pwd)
home=$dir/home
mkdir -p "$home"
link=$home
if [ \${#home} -gt ${MSB_HOME_MAX} ]; then
  link=/tmp/bb-box-msb-$(id -u)
  if [ "$(readlink "$link" 2>/dev/null)" != "$home" ]; then
    if [ -e "$link" ] || [ -L "$link" ]; then
      if [ "$(ls -ldn "$link" | awk '{print $3}')" != "$(id -u)" ]; then
        echo "bb-box: $link belongs to another user, so msb cannot use it as its home." >&2
        exit 125
      fi
      rm -f "$link"
    fi
    ln -s "$home" "$link"
  fi
fi
MSB_HOME=$link exec "$dir/${MSB_VERSION}/msb" "$@"
`;
}

const SCRIPTS: Readonly<Record<MsbScript, () => string>> = {
  /**
   * Downloads the pinned release for this host, checks its SHA-256, and
   * unpacks it beside any other, then writes bin/msb. Does nothing when it
   * is there. Prints `installed=<version>`.
   */
  install: () => `${PRELUDE}platform=$(uname -s)-$(uname -m)
case $platform in
${Object.entries(MSB_ARCHIVES).map(([platform, { file, sha256 }]) => `  ${platform}) file=${file}; sha256=${sha256} ;;`).join("\n")}
  *) echo "msb ${MSB_VERSION} has no release bb-box can use for $platform." >&2; exit 2 ;;
esac
if [ ! -x "$dir/$version/msb" ] || ! "$dir/$version/msb" --version >/dev/null 2>&1; then
  for tool in curl tar; do
    command -v $tool >/dev/null || { echo "Installing msb needs $tool, which this host lacks." >&2; exit 2; }
  done
  mkdir -p "$dir"
  work=$(mktemp -d "$dir/.install.XXXXXX")
  trap 'rm -rf "$work"' EXIT
  curl -fsSL --retry 3 -o "$work/$file" "${MSB_DOWNLOAD}/$file"
  if command -v sha256sum >/dev/null; then got=$(sha256sum "$work/$file" | cut -d' ' -f1); else got=$(shasum -a 256 "$work/$file" | cut -d' ' -f1); fi
  if [ "$got" != "$sha256" ]; then
    echo "The msb ${MSB_VERSION} archive's SHA-256 is $got, not $sha256 as bb-box was tested with, so bb-box did not install it." >&2
    exit 3
  fi
  mkdir "$work/$version"
  tar -xzf "$work/$file" -C "$work/$version"
  "$work/$version/msb" --version >/dev/null
  rm -rf "$dir/$version"
  mv "$work/$version" "$dir/$version"
fi
mkdir -p "$dir/bin" "$dir/home"
cat >"$dir/bin/msb.new" <<'BBBOX_WRAPPER'
${wrapper()}BBBOX_WRAPPER
chmod 755 "$dir/bin/msb.new"
mv "$dir/bin/msb.new" "$dir/bin/msb"
echo "installed=$version"
`,

  /**
   * What the backend and its doctor need of the host, one key=value line
   * each: the msb installed, KVM, room, reflinks, Docker, and the disk msb
   * takes. Exits 0 when msb is not installed too.
   */
  status: () => `${PRELUDE}set +e
echo "pinned=$version"
echo "dir=$dir"
echo "os=$(uname -s)"
echo "arch=$(uname -m)"
echo "kernel=$(uname -r)"
if [ -x "$msb" ]; then echo "installed=$("$msb" --version 2>/dev/null | awk '{print $2}')"; else echo "installed="; fi
if [ "$(uname -s)" = Linux ]; then
  echo "cpus=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN)"
  echo "memory_kib=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
  if [ ! -e /dev/kvm ]; then echo "kvm=missing"
  elif [ -r /dev/kvm ] && [ -w /dev/kvm ]; then echo "kvm=ok"
  else echo "kvm=denied"; fi
  if [ -r /proc/1/environ ] && tr '\\0' '\\n' </proc/1/environ 2>/dev/null | grep -q '^container=lxc'; then echo "lxc=1"; else echo "lxc=0"; fi
else
  echo "cpus=$(sysctl -n hw.ncpu)"
  echo "memory_kib=$(( $(sysctl -n hw.memsize) / 1024 ))"
  echo "kvm=ok"
  echo "lxc=0"
fi
mkdir -p "$dir/home"
echo "free_kib=$(df -Pk "$dir/home" | awk 'NR==2 {print $4}')"
echo "used_kib=$(du -sk "$dir/home" 2>/dev/null | cut -f1)"
probe=$(mktemp "$dir/home/.reflink.XXXXXX")
echo bb-box >"$probe"
if cp --reflink=always "$probe" "$probe.copy" 2>/dev/null || cp -c "$probe" "$probe.copy" 2>/dev/null; then echo "reflink=1"; else echo "reflink=0"; fi
rm -f "$probe" "$probe.copy"
if command -v docker >/dev/null && docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then echo "docker=$(docker version --format '{{.Server.Version}}')"; else echo "docker="; fi
`,

  /** Docker's ID of each image named, `docker:<image>=<ID>`, empty for one Docker lacks. */
  images: () => `${PRELUDE}set +e
for image in "$@"; do
  echo "docker:$image=$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null)"
done
`,

  /**
   * Imports image $1 from Docker on the host into msb under the same
   * reference, with `docker save` and `msb load`. Prints Docker's ID of what
   * it imported.
   */
  import: () => `${PRELUDE}image=$1
[ -x "$msb" ] || { echo "msb is not installed in $dir." >&2; exit 2; }
id=$(docker image inspect --format '{{.Id}}' "$image") || { echo "Docker on this host has no image $image to import." >&2; exit 2; }
docker save "$image" | "$msb" load --quiet --tag "$image"
echo "imported=$id"
`,
};

/** A script's text, which takes its arguments as $1 and on. */
export function msbScript(name: MsbScript): string {
  return SCRIPTS[name]();
}

/** Whether `args` are what script `name` takes, so a host entry runs nothing else. */
export function scriptArgsOk(name: string, args: readonly string[]): name is MsbScript {
  if (name === "install" || name === "status") return args.length === 0;
  if (name === "import") return args.length === 1 && IMAGE_REF.test(args[0]!);
  if (name === "images") return args.length >= 1 && args.length <= 4 && args.every((arg) => IMAGE_REF.test(arg));
  return false;
}

/** Parses the key=value lines a script prints. */
export function scriptValues(stdout: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) values[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return values;
}

/** `sh -c` of script `name` with `args`, for a command line on BB's server or over ssh://. */
export function scriptCommand(name: MsbScript, args: readonly string[], dir?: string): string {
  const env = dir ? `BBBOX_MSB_DIR=${quote(dir)} ` : "";
  return `${env}sh -c ${quote(msbScript(name))} bb-box-msb ${args.map(quote).join(" ")}`.trimEnd();
}
