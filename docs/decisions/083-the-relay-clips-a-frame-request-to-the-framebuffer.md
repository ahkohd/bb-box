# 083: The relay clips a frame request to the framebuffer

Status: accepted, 10 November 2026.
Extends [007](007-desktop-stream-is-a-typed-transport.md).

## Context

neatvnc 0.9.1 adds a viewer's framebuffer update request to that client's
damage as the request arrives. With ZRLE or raw, the encoder then reads
past the framebuffer and wayvnc exits with a segmentation fault, which
drops every viewer of the box. Tight walks its own tiles, so the same
request is clipped in effect and a frame is sent.

The rectangle can reach 32767 in x plus width, and in y plus height. Past
that, the library that keeps the damage rejects the rectangle and no frame
is sent.

The panel's viewer asks for Tight before ZRLE, so it does not hit this. A
viewer that asks for ZRLE or raw does. The relay was forwarding the request
unchanged.

## Decision

The desktop relay clips each framebuffer update request to the framebuffer
it can still track.

- The size starts as the server's first description of the desktop.
- The relay then follows DesktopSize and ExtendedDesktopSize rectangles in
  the server's stream. A refused resize does not change the size: that is
  an ExtendedDesktopSize rectangle whose reason is this client's request
  and whose status is not success.
- The relay reads the server's message boundaries so it can find those
  rectangles. It does not decode pixels. When an encoding arrives whose
  length it cannot measure, it stops clipping for that connection. A client
  SetPixelFormat message also stops tracking.
- A request that misses the framebuffer becomes a 1 by 1 request at 0,0,
  with its incremental flag kept. Only the server sends replies.

## Consequences

- ZRLE and raw sessions are protected while tracking remains active.
- Sessions the relay cannot follow are forwarded unchanged.
- After the server announces a new size, a request for that whole screen
  is sent whole. A larger one is clipped to the new size.
- A noVNC session whose request already fits is unchanged.
