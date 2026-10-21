// wayvnc 0.7.2, which Ubuntu 24.04 ships, can freeze at a viewer's sign-in
// right after a resize with no viewer has restarted it, until it crashes 5 s
// or more later (#411): 4 of 600 rounds in a Docker Wayland desktop. Killing
// it has the desktop start a new wayvnc, which signs viewers in, in about
// 0.2 s. As the box user, whose wayvnc it is.

import type { CommandTransport } from "../transports/types.ts";

const RESTART = `old=$(pgrep -u "$(id -u)" -x wayvnc | head -1)
[ -z "$old" ] || kill -KILL "$old"
for _ in $(seq 1 100); do
  new=$(pgrep -u "$(id -u)" -x wayvnc | head -1)
  [ -n "$new" ] && [ "$new" != "$old" ] && wayvncctl version >/dev/null 2>&1 && exit 0
  sleep 0.05
done
echo "wayvnc did not start again within 5 s" >&2
exit 1`;

/**
 * The cursor theme the Wayland images make, every cursor a transparent
 * pixel (#707). Sway's headless output has no cursor plane, so wlroots
 * paints the pointer into each frame wayvnc sends, and wayvnc 0.7.2 sends
 * no cursor shape: a person in control saw that painted pointer trail their
 * own. Sway takes the theme for the cursors it draws, and GTK apps, which
 * draw their own, take it from GSettings; both apply it at once.
 *
 * A seat command makes Sway apply seat0's configuration again, which
 * detaches every device the configuration does not attach: wayvnc's virtual
 * pointer and keyboard, which a viewer's input goes through, so a person who
 * had just taken control clicked and typed into nothing until a new VNC
 * connection made new ones. `attach "*"` keeps them, in this switch and every
 * later one.
 */
export const HIDDEN_CURSOR_THEME = "bb-box-hidden";

/** Takes the box's pointer out of the picture, or puts it back. As the box user, whose Sway and GSettings they are. */
export function waylandPointerScript(shown: boolean): string {
  const [sway, gtk] = shown ? ["default", "Adwaita"] : [HIDDEN_CURSOR_THEME, HIDDEN_CURSOR_THEME];
  return `export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"; export DBUS_SESSION_BUS_ADDRESS="\${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
set -a; [ ! -r /run/bb-box/display.env ] || . /run/bb-box/display.env; set +a
swaymsg -s "$SWAYSOCK" 'seat seat0 attach "*"; seat seat0 xcursor_theme ${sway}' >/dev/null || exit 1
! command -v gsettings >/dev/null || gsettings set org.gnome.desktop.interface cursor-theme ${gtk}`;
}

/** Shows or hides the box's pointer in a Wayland desktop's picture. */
export async function waylandPointer(command: CommandTransport, shown: boolean, signal?: AbortSignal): Promise<void> {
  const result = await command.run(waylandPointerScript(shown), { timeoutMs: 10_000, signal, maxOutputBytes: 4096 });
  if (result.exitCode !== 0) throw new Error(`The desktop's pointer could not be ${shown ? "shown" : "hidden"}: ${result.stderr.trim() || `exit code ${result.exitCode}`}.`);
}

/** Kills the box user's wayvnc, and waits for the desktop's next to answer. */
export async function restartWayvnc(command: CommandTransport, signal?: AbortSignal): Promise<void> {
  const result = await command.run(RESTART, { timeoutMs: 10_000, signal, maxOutputBytes: 4096 });
  if (result.exitCode !== 0) throw new Error(`wayvnc could not be started again: ${result.stderr.trim() || `exit code ${result.exitCode}`}.`);
}

/** wayvnc's outputs as JSON: `[]` once wayvnc 0.9.1 has lost Sway and detached, which it does not come back from. */
const OUTPUTS = `export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"; wayvncctl --json output-list`;

/**
 * Whether the box user's wayvnc is still attached to Sway: false when it
 * lists no output twice, 2 s apart, as wayvnc 0.9.1 does after it lost
 * Sway; it then sends viewers a grey placeholder and never attaches again
 * ("TODO: Re-attach" in its main.c). Twice, as a wayvnc a display resize
 * restarts lists none for a moment. Null when wayvncctl does not answer,
 * which says nothing either way. wayvnc 0.7.2 keeps its output listed after
 * the same failure, so this cannot see it: it sends a new viewer no frame.
 */
export async function wayvncAttached(command: CommandTransport, signal?: AbortSignal): Promise<boolean | null> {
  const read = async (): Promise<boolean | null> => {
    const result = await command.run(OUTPUTS, { timeoutMs: 10_000, signal, maxOutputBytes: 4096 }).catch(() => null);
    const out = result?.exitCode === 0 ? result.stdout.trim() : "";
    return out === "[]" ? false : out.startsWith("[") ? true : null;
  };
  if ((await read()) !== false) return true;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  return (await read()) === false ? false : true;
}
