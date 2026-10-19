// What bb-box's X11 desktop images run beside their VNC server (056), and its
// Wayland images beside wayvnc, capturing Sway (060): Selkies, which streams
// the desktop as H.264 over WebSockets on the box's loopback, so it is reached
// through the box's command transport. Its size is the RFB display's, which
// Selkies follows, so it has no resize of its own.

import type { DisplayCapability } from "./types.ts";
import type { CommandTransport, Display, Route } from "../transports/types.ts";

/** Where the image's bb-box-selkies.service listens, on 127.0.0.1 only. */
export const SELKIES_PORT = 5980;

/** The display an X11 desktop kind lists after its RFB one. */
export const SELKIES_DISPLAY: DisplayCapability = { id: "selkies", protocol: "selkies", resizable: true, cursor: "selkies" };

/**
 * The display a Wayland desktop kind lists after its RFB one (060), which the
 * viewer opens by default, as on X11: through BB it followed a drag 13 ms
 * closer on a LAN and 25 ms on a slow link than wayvnc, with no tearing and a
 * sixth of the bandwidth (measured 18 October 2026). It says no way to leave
 * the cursor out: Sway paints the pointer into each frame, as for wayvnc, and
 * the hidden cursor theme takes it out while a person holds control (#707).
 * Selkies on Sway sends the browser an arrow. Selkies is told a new size
 * before Sway takes it: told after, it sent black frames at the old size for
 * about 0.7 s through BB, and its new size came 1.25 s after the viewer's;
 * told first, it came in 0.05 to 0.2 s, with none black (measured 18 October
 * 2026).
 */
export const WAYLAND_SELKIES_DISPLAY: DisplayCapability = { id: "selkies", protocol: "selkies", resizable: true, tellSize: "first" };

/** Where a Wayland image runs Selkies from: an image built before it has none (060). */
export const SELKIES_LAUNCHER = "/usr/local/libexec/bb-box/selkies";

/**
 * Where a Wayland image with Sway 1.11 or later has bb-box-cursor (060): the
 * box's pointer, where it is and what it looks like. An image without it,
 * such as one on Ubuntu 24.04, has the pointer hidden from the picture while
 * a person holds control (#707), as before.
 */
export const CURSOR_HELPER = "/usr/local/libexec/bb-box/cursor";

/**
 * Whether each Wayland box's image has an executable, asked once a box: a box
 * keeps its image's. Keyed by the box, not by a reference a later box of
 * another image may reuse, such as a VMID; forgotten as the box is released.
 */
export class ImageFile {
  readonly #known = new Map<string, boolean>();
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  /** False, not kept, when the box cannot be asked. */
  async has(key: string, command: CommandTransport, signal?: AbortSignal): Promise<boolean> {
    const known = this.#known.get(key);
    if (known !== undefined) return known;
    const result = await command.run(`test -x '${this.#path.replaceAll("'", "'\\''")}'`, { timeoutMs: 15_000, signal, maxOutputBytes: 1024 }).catch(() => null);
    if (!result) return false;
    this.#known.set(key, result.exitCode === 0);
    return result.exitCode === 0;
  }

  forget(key: string): void {
    this.#known.delete(key);
  }
}

/** Whether each Wayland box's image has Selkies (060). */
export class SelkiesPresence extends ImageFile {
  /** `launcher`: where the image's launcher is, instead of SELKIES_LAUNCHER: one on the test machine, in tests. */
  constructor(launcher = SELKIES_LAUNCHER) {
    super(launcher);
  }
}

/** The box's Selkies display, given its command transport's route to a port in the box, as its kind declares it. */
export function selkiesDisplay(route: (port: number, signal?: AbortSignal) => Promise<Route>, declared: DisplayCapability = SELKIES_DISPLAY): Display {
  const { byChoice: _byChoice, ...capability } = declared;
  return {
    ...capability,
    label: "Desktop, as video",
    open: async (signal) => ({ route: await route(SELKIES_PORT, signal), auth: { type: "none" } }),
  };
}
