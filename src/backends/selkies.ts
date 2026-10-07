// What bb-box's X11 desktop images run beside their VNC server (056):
// Selkies, which streams the desktop as H.264 over WebSockets on the box's
// loopback, so it is reached through the box's command transport. Its size is
// the RFB display's, which Selkies follows, so it has no resize of its own.

import type { DisplayCapability } from "./types.ts";
import type { Display, Route } from "../transports/types.ts";

/** Where the image's bb-box-selkies.service listens, on 127.0.0.1 only. */
export const SELKIES_PORT = 5980;

/** The display an X11 desktop kind lists after its RFB one. */
export const SELKIES_DISPLAY: DisplayCapability = { id: "selkies", protocol: "selkies", resizable: true };

/** The box's Selkies display, given its command transport's route to a port in the box. */
export function selkiesDisplay(route: (port: number, signal?: AbortSignal) => Promise<Route>): Display {
  return {
    ...SELKIES_DISPLAY,
    label: "Desktop, as video",
    open: async (signal) => ({ route: await route(SELKIES_PORT, signal), auth: { type: "none" } }),
  };
}
