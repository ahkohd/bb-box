# 102: The viewer draws the agent's pointer where the desktop draws none

Status: accepted, 14 November 2026. Extends [060](060-every-desktop-streams-as-video-through-one-viewer.md) and [073](073-recordings-draw-the-pointer-keys-and-zooms-from-the-event-log.md).

## Context

On macOS and Windows, Cua Driver draws its own agent cursor on the screen at each action, so people watching a desktop see where the agent works. On Linux, BB Box runs Cua Driver with `--no-overlay`, since #1040, so a Linux desktop showed no agent cursor at all. A person watching saw the page change with nothing to say where the agent had clicked.

The overlay is off because of what it does on Xfce, which runs without a compositor: Cua Driver's image of a window, which the agent reads, has the cursor in it as a black shape over the page. Cua Driver 0.30.4 does the same. With Xfce's compositor on, window images are clean, but the image of the whole desktop has the cursor and its session badge in it, every image would need rebuilding, and the compositor costs a desktop drawn by the CPU.

BB Box already knows each of the agent's clicks and scrolls: it keeps them for recordings (073). It knows for sure where one lands only when the agent gave a place on the screen, as pixels of an image. An action by reference names an element, and Cua Driver clicks it through accessibility. Its frame from Cua Driver is in the screen's pixels on an unscaled desktop. On a scaled one it may be in points or in pixels, and nothing says which.

## Decision

- Where the desktop's driver draws no agent cursor, a Linux desktop with computer use, BB Box tells each viewer of the desktop where the agent clicks and scrolls by pixels, at the point Cua Driver used, in the screen's pixels, as `BB_AGENT,<click|scroll|at>,<x>,<y>`. It goes on the pointer stream a VNC viewer opens (060), which now stays open on such a desktop, and on the video stream. A viewer that connects later is told where the agent last acted, as `at`.
- The panel draws the agent's pointer there, over the picture, scaled and placed as the picture is. It is the arrow recordings draw (073), at a fixed 40 px, in BB's primary colour on its primary foreground, so it reads in both themes. Each click shows a ring that grows and fades within 0.6 seconds, with no motion when the person has asked for less. The pointer stays where the agent last acted, as Cua's does on macOS and Windows.
- The viewer with control does not see it: their own pointer stands for it.
- On macOS and Windows, nothing changes: Cua Driver's cursor is in the picture.
- On Linux, an action by reference has no place, at any scale: a click or scroll by reference shows no pointer, live or in a recording, and typing by reference is logged with no place for a recording to zoom to. BB Box does not guess, and reads nothing in the box for it, so the tool waits for nothing.
- An action that began before its box last stopped, restarted or was released is not shown, nor kept.

## Consequences

- Cua Driver's own image of a window, and of the desktop, stay free of any cursor, so the agent reads the page as before.
- The pointer is drawn only in BB Box's viewer. A recording draws its own, from the same events (073), so a clip shows one pointer, not two.
- It needs no new image: it works on every Linux desktop now running, on X11 and Wayland.
- The pointer shows where the agent clicked or scrolled by pixels, not where it acted by reference, typed or pressed keys, and it does not glide between places. An agent that works by reference, as most do, shows a pointer only for its clicks by pixels.
- On Linux, recordings lose the ring and zoom they drew for actions by reference, which were wrong on a scaled desktop.
- Two earlier forms were dropped (see the results). Doubling frames that lay outside their window and fitted it doubled put elements in the wrong place both ways. Reading whether the desktop is scaled missed an app's own scale, such as `GDK_SCALE` in its environment, took a failed read for unscaled, could show an old action after a restart, and held the tool for up to 10 seconds when the read stalled.
- What the agent last did is forgotten as its box stops, restarts or is released. A viewer that connects is told it only while the box is running.
- iOS and Android devices could show the agent's taps the same way, from the device's own events, on the device stream. That is not built yet.
