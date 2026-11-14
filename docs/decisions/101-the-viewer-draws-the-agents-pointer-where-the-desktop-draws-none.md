# 101: The viewer draws the agent's pointer where the desktop draws none

Status: accepted, 14 November 2026. Extends [060](060-every-desktop-streams-as-video-through-one-viewer.md) and [073](073-recordings-draw-the-pointer-keys-and-zooms-from-the-event-log.md).

## Context

On macOS and Windows, Cua Driver draws its own agent cursor on the screen at each action, so people watching a desktop see where the agent works. On Linux, BB Box runs Cua Driver with `--no-overlay`, since #1040, so a Linux desktop showed no agent cursor at all. A person watching saw the page change with nothing to say where the agent had clicked.

The overlay is off because of what it does on Xfce, which runs without a compositor: Cua Driver's image of a window, which the agent reads, has the cursor in it as a black shape over the page. Cua Driver 0.30.4 does the same. With Xfce's compositor on, window images are clean, but the image of the whole desktop has the cursor and its session badge in it, every image would need rebuilding, and the compositor costs a desktop drawn by the CPU.

BB Box already knows each of the agent's clicks and scrolls, and where on the screen they land: it keeps them for recordings (073).

## Decision

- Where the desktop's driver draws no agent cursor, a Linux desktop with computer use, BB Box tells each viewer of the desktop where the agent clicks and scrolls, in the screen's pixels, as `BB_AGENT,<click|scroll|at>,<x>,<y>`. It goes on the pointer stream a VNC viewer opens (060), which now stays open on such a desktop, and on the video stream. A viewer that connects later is told where the agent last acted, as `at`.
- The panel draws the agent's pointer there, over the picture, scaled and placed as the picture is. It is the arrow recordings draw (073), at a fixed 40 px, in BB's primary colour on its primary foreground, so it reads in both themes. Each click shows a ring that grows and fades within 0.6 seconds, with no motion when the person has asked for less. The pointer stays where the agent last acted, as Cua's does on macOS and Windows.
- The viewer with control does not see it: their own pointer stands for it.
- On macOS and Windows, nothing changes: Cua Driver's cursor is in the picture.
- Where an element's frame lies outside its window, and inside it at twice its size, the frame is in a GTK app's points at Xfce's scale 2, as with High resolution. BB Box notes such a click at twice the frame, in the screen's pixels, for the live pointer and for recordings alike.

## Consequences

- Cua Driver's own image of a window, and of the desktop, stay free of any cursor, so the agent reads the page as before.
- The pointer is drawn only in BB Box's viewer. A recording draws its own, from the same events (073), so a clip shows one pointer, not two.
- It needs no new image: it works on every Linux desktop now running, on X11 and Wayland.
- The pointer shows where the agent clicked or scrolled, not where it typed or pressed keys, and it does not glide between places.
- iOS and Android devices could show the agent's taps the same way, from the device's own events, on the device stream. That is not built yet.
