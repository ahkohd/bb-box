# 037: A panel keeps a box's desktop and terminal across tab switches

Status: accepted, 1 October 2026. Extends
[008](008-shared-control.md): a hidden tab counts as a viewer gone.
Extends [035](035-a-terminal-has-its-pty-on-bbs-server.md): how long a
hidden shell lives.

## Context

BB remounts a panel tab each time a person switches tabs, and a plugin
cannot keep one mounted. Each switch connected the desktop again, with a
handshake and a blank frame, and the terminal again, with its backlog
sent again. The operator saw it on every switch (#160).

## Decision

- The panel's app keeps each desktop's noVNC client and canvas, and each
  terminal's xterm and socket, in memory, by box and by viewer or session.
  A tab that mounts takes its kept session; a tab that goes leaves it
  hidden.
- A hidden session closes after 10 minutes, when it ends, when its box
  stops or goes, and when the app reloads. A hidden desktop never connects
  again by itself.
- A box on screen in two places at once, such as the Desktops page and a
  thread's panel, has a session in each, as their viewer IDs differ
  ([020](020-control-belongs-to-a-viewer.md)).
- **Control.** A hidden tab that holds a desktop's control counts as a
  viewer gone (008). After 60 s the panel hands control back to the agent,
  unless the person has come back or someone else holds it by then. The
  server does not change; its own 60 s still covers a closed socket.

## Consequences

- Switching back to a tab shows the desktop or shell at once.
- A hidden desktop costs what a visible one does, in the box's VNC encoder
  and the network, for up to 10 minutes. noVNC cannot pause a stream, so
  the choice was to keep it or close it.
- A hidden terminal's shell lives up to 20 minutes: 10 hidden in the
  panel, then 035's 10 with no tab.
- A reload of the app drops kept sessions, and tabs connect again as
  before.
