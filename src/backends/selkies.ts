// What bb-box's X11 desktop images run beside their VNC server (056), and its
// Wayland images beside wayvnc, capturing Sway (060): Selkies, which streams
// the desktop as H.264 over WebSockets on the box's loopback, so it is reached
// through the box's command transport. Its size is the RFB display's, which
// Selkies follows, so it has no resize of its own.

import type { DisplayCapability } from "./types.ts";
import type { BoxPointer, CommandTransport, Display, Route } from "../transports/types.ts";

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

/** A line bb-box-cursor writes, as a pointer event, or null for a line it cannot read. */
export function pointerEvent(line: string): BoxPointer | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.enter === true) return { type: "enter" };
    if (value.leave === true) return { type: "leave" };
    const at = value.position;
    if (Array.isArray(at) && at.length === 2 && at.every(Number.isInteger)) return { type: "position", x: at[0] as number, y: at[1] as number };
    const image = value.image as Record<string, unknown> | undefined;
    if (image && typeof image === "object") {
      const { width, height, hotspot, argb } = image;
      if (!Number.isInteger(width) || !Number.isInteger(height) || typeof argb !== "string" || !Array.isArray(hotspot) || hotspot.length !== 2) return null;
      const bytes = Buffer.from(argb, "base64");
      if (bytes.length !== (width as number) * (height as number) * 4) return null;
      return { type: "image", width: width as number, height: height as number, hotX: Number(hotspot[0]), hotY: Number(hotspot[1]), argb: bytes };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Runs bb-box-cursor in the box's session, as the box user, and passes on
 * each change of the pointer until `signal` ends it or the helper ends, as
 * when the desktop restarts.
 */
export async function followPointer(command: CommandTransport, onEvent: (event: BoxPointer) => void, signal: AbortSignal, helper = CURSOR_HELPER): Promise<void> {
  const script = `export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
set -a; [ ! -r /run/bb-box/display.env ] || . /run/bb-box/display.env; set +a
exec '${helper.replaceAll("'", "'\\''")}'`;
  let rest = "";
  const decoder = new TextDecoder();
  await command.stream(script, {
    signal,
    onOutput: (chunk, from) => {
      if (from !== "stdout") return;
      const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        const event = line ? pointerEvent(line) : null;
        if (event) onEvent(event);
      }
    },
  });
}

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
