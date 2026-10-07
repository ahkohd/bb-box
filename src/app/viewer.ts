// What both desktop viewers share: noVNC's for RFB (desktop.tsx) and the
// video one for Selkies (selkies.ts, 056).

/** The longest wait between attempts to reconnect to a desktop. */
export const MAX_RETRY_MS = 15_000;
/** How long the viewer's size must hold before the desktop is asked for it again. */
export const SETTLE_MS = 250;
/** How long the paste chord waits after the text is sent, so a server that fetches the text (the extended clipboard) has it before the paste. */
export const PASTE_CHORD_DELAY_MS = 150;
/** How long a Cmd+V or Ctrl+V waits for the browser's paste event before the box pastes its own clipboard. */
export const PASTE_EVENT_WAIT_MS = 150;
export const XK_CONTROL_L = 0xffe3;
export const XK_META_L = 0xffe7;
export const XK_META_R = 0xffe8;
export const XK_SUPER_L = 0xffeb;
export const XK_SUPER_R = 0xffec;
export const XK_V = 0x76;

export type Connection = { readonly state: "connecting" } | { readonly state: "connected" } | { readonly state: "disconnected"; readonly reason: string; readonly retryMs: number };

/** Whether the browser runs on a Mac, where Cmd is the shortcut key. */
export function macBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
  return /Mac|iPhone|iPad/.test(platform);
}

/** Whether a keysym is Cmd's, Meta or Super, which stands for Ctrl in a box that is not a Mac. */
export function isCommandKey(keysym: number): boolean {
  return keysym === XK_META_L || keysym === XK_META_R || keysym === XK_SUPER_L || keysym === XK_SUPER_R;
}
