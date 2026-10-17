/**
 * bb-box-stream on a Mac (060): each box user's desktop as H.264 video, from
 * a server in their desktop session. setup-mac.sh builds it on a pool Mac,
 * and the Tart image's customize.sh in a macOS VM.
 */
import { command as inBoxCommand } from "../core/in-box.ts";

/** The desktop as video, beside the desktop's RFB. */
export const MAC_VIDEO = {
  id: "video",
  protocol: "selkies",
  resizable: false,
} as const;
/** Where it is built. */
export const MAC_STREAM = "/usr/local/bin/bb-box-stream";

/**
 * One connection to a Mac's video stream: bb-box-stream joins its stdin and stdout to the server in the box user's
 * desktop session, starting the server first. Its socket is in the box user's home, which only they can open.
 */
export function macStreamCommand(): string {
  return inBoxCommand("macos", `exec ${MAC_STREAM} connect`, {
    session: "desktop",
  });
}
