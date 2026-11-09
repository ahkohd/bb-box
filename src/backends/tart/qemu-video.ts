// A Windows VM's desktop as video from the Mac (#865): bb-box-stream's qemu
// mode reads the VM's QEMU VNC server on the Mac's loopback and encodes it
// with VideoToolbox, as Desktop Duplication in the guest gives only a few
// frames a second on the Mac's VirtIO GPU. It gives the person's pointer to
// QEMU's tablet, as the VNC display does. The guest's bb-box-stream.exe still
// takes the keys, and sends the clipboard and the pointer's shape.
//
// bb-box builds it on each Mac from setup/ssh-pool/mac-stream.swift, with the
// Command Line Tools' swiftc, into ~/.bb-box/qemu/bin, which only the host
// user can open. A build is named by its source's hash, so a new source is
// built again, and keeps its own hash beside it, which is checked before it
// runs. One runs for each VM while anyone watches it, as the VM's directory
// says in video.pid; it ends when the VM's QEMU does, when no viewer has come
// for a minute, or when bb-box saves, captures or deletes the VM, by that PID
// only, as the Mac is its owner's.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quote } from "../../transports/process.ts";
import { setupDir } from "../setup-dir.ts";
import { script, sections } from "./host.ts";
import { qemuScript } from "./qemu.ts";

/** bb-box-stream's source, as the pool Macs build it. */
export function qemuVideoSource(): string {
  return readFileSync(join(setupDir(), "ssh-pool", "mac-stream.swift"), "utf8");
}

/** The name a build of `source` has, from its hash. */
export function qemuVideoBuild(source: string): string {
  return `bb-box-stream-${createHash("sha256").update(source).digest("hex").slice(0, 16)}`;
}

/** Where builds are, and the build `build` there; and whether it is whole, as its hash beside it says. */
const BIN = String.raw`bin="$HOME/.bb-box/qemu/bin"
vok() { [ -x "$1" ] && [ -f "$1.sha256" ] && [ "$(shasum -a 256 < "$1" | cut -d ' ' -f 1)" = "$(cat "$1.sha256")" ] && [ -z "$(find "$1" -perm -022 2>/dev/null)" ]; }
`;

/**
 * What the state script adds: whether the Mac has the build `build`, after a
 * line @qemu-video. "ready", "no-tools" without the Command Line Tools'
 * swiftc, "failed <why>" when it did not build, or "missing".
 */
export function qemuVideoStateBody(build: string): string {
  return String.raw`${BIN}echo @qemu-video
b="$bin/"${quote(build)}
if vok "$b"; then echo ready
elif ! xcode-select -p >/dev/null 2>&1 || ! xcrun --find swiftc >/dev/null 2>&1; then echo no-tools
elif [ -f "$b.failed" ]; then echo "failed $(head -n 3 "$b.failed" | tr '\n' ' ')"
else echo missing; fi
`;
}

export type QemuVideo = { readonly status: "ready" | "no-tools" | "missing" } | { readonly status: "failed"; readonly why: string };

/** The state script's @qemu-video section; null when it has none, as when Windows boxes are off. */
export function parseQemuVideo(text: string): QemuVideo | null {
  const line = sections(text).get("qemu-video")?.trim();
  if (!line) return null;
  if (line === "ready" || line === "no-tools" || line === "missing") return { status: line };
  if (line.startsWith("failed")) return { status: "failed", why: line.slice("failed".length).trim() || "swiftc gave no reason." };
  return null;
}

/** Where the build's source goes before buildScript runs. */
export function qemuVideoSourcePath(build: string): string {
  return `.bb-box/qemu/bin/${build}.swift`;
}

/**
 * Builds `build` from its source at qemuVideoSourcePath, unless another build
 * of it runs. Older builds go: a bridge that runs keeps its file open. Prints
 * "built"; exits 4 when another build runs, and 1 with swiftc's errors, which
 * it keeps for the state script, when it fails.
 */
export function qemuVideoBuildScript(build: string): string {
  return script(String.raw`${BIN}b="$bin/"${quote(build)}; t="$bin/"${quote(`${build}.build`)}
mkdir -p "$bin" && chmod 700 "$HOME/.bb-box/qemu" "$bin" || exit 1
[ -f "$b.swift" ] || { echo "The source to build is not on the Mac." >&2; exit 1; }
# A build that died left its lock: one older than a quarter of an hour is taken over.
[ -n "$(find "$t.lock" -prune -mmin +15 2>/dev/null)" ] && rm -rf "$t.lock"
mkdir "$t.lock" 2>/dev/null || { echo "Another build of ${build} runs." >&2; exit 4; }
trap 'rm -rf "$t" "$t.lock" "$b.swift"' EXIT
rm -rf "$t"; mkdir "$t" || exit 1
if xcrun swiftc -O -swift-version 5 -o "$t/out" "$b.swift" > "$t/log" 2>&1; then
  shasum -a 256 < "$t/out" | cut -d ' ' -f 1 > "$t/sha" && chmod 700 "$t/out" && mv -f "$t/out" "$b" && mv -f "$t/sha" "$b.sha256" || exit 1
  rm -f "$b.failed"
  for o in "$bin"/bb-box-stream-*; do
    case "$o" in "$b" | "$b.sha256" | "$t" | "$t.lock") ;; *) rm -rf "$o" ;; esac
  done
  echo built
else
  { grep -m 3 'error:' "$t/log" || tail -n 3 "$t/log"; } > "$b.failed"
  cat "$b.failed" >&2
  exit 1
fi
`);
}

/**
 * Joins stdin and stdout to VM `vm`'s bridge, starting it first: one
 * viewer's video. The bridge reads the desktop from QEMU's D-Bus display
 * where the VM's QEMU runs one (#885), and from its VNC server on `port`
 * where it does not, or where the D-Bus bridge does not listen within 5 s.
 * Prints nothing else on stdout. Exits 3 when the build is not whole, and 1
 * when the VM is not there or the bridge does not start.
 */
export function qemuVideoOpenScript(vm: string, port: number, build: string): string {
  return qemuScript(String.raw`${BIN}vm=${quote(vm)}; v="$q/vms/$vm"; b="$bin/"${quote(build)}; s="$v/video.sock"
[ -d "$v" ] || { echo "The VM $vm is not on the Mac." >&2; exit 1; }
vok "$b" || { echo "BB Box's build of bb-box-stream on the Mac is not whole: $b." >&2; exit 3; }
if ! qvideo "$vm"; then
  i=0; until mkdir "$v/video.lock" 2>/dev/null; do i=$((i + 1)); [ "$i" -lt 50 ] || rm -rf "$v/video.lock"; sleep 0.1; done
  if ! qvideo "$vm"; then
    bridge() {
      rm -f "$s"
      nohup "$b" qemu ${port} "$s" "$@" > "$v/video.log" 2>&1 < /dev/null &
      echo $! > "$v/video.pid"
    }
    if ps -ww -p "$(cat "$v/pid" 2>/dev/null)" -o command= 2>/dev/null | grep -q -- '-display dbus,p2p=yes'; then
      bridge "$v/qmp"
      i=0; while qvideo "$vm" && [ ! -S "$s" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
      if [ ! -S "$s" ]; then
        qvideostop "$vm"
        mv -f "$v/video.log" "$v/video-dbus.log"
        bridge
      fi
    else
      bridge
    fi
  fi
  rmdir "$v/video.lock"
fi
i=0
until [ -S "$s" ]; do
  qvideo "$vm" || { echo "bb-box-stream did not start for $vm:" >&2; tail -n 5 "$v/video.log" >&2; exit 1; }
  i=$((i + 1)); [ "$i" -lt 100 ] || { echo "bb-box-stream did not listen for $vm within 10 s." >&2; exit 1; }
  sleep 0.1
done
exec "$b" attach "$s"
`);
}
