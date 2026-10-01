# 035: A box's terminal has its PTY on BB's server, and the plugin keeps the shell

Status: accepted, 1 October 2026. Extended by
[037](037-a-panel-keeps-a-boxs-desktop-and-terminal.md): the panel keeps a
hidden tab's terminal for 10 minutes.

## Context

#51 asks for a terminal in a box from the Box panel, for headless boxes
especially. BB's own terminal tab cannot be opened on a machine from a
plugin, and a session the SDK makes can only be polled
([BB request 9](../bb-requests.md#9-open-bbs-terminal-on-a-machine-from-a-plugin)).
It would also miss boxes that are not BB machines, such as Windows boxes.

A PTY in the box would need a program there for each guest OS, and a
command in the box for each resize. Tested on Linux on 1 October 2026:
`ssh -tt` and `docker exec -it`, run on a PTY on BB's server, pass that
PTY's size on to the box. A resize there reached the box's shell over
direct SSH, over a shared ControlMaster connection, and through
`docker exec`.

## Decision

- A command transport may have `terminal(size, signal)`, which returns a
  byte channel with `resize(size)`. SSH and Docker have it.
- It runs the transport's own command (`ssh -tt`, or `docker exec -it`)
  under `script` on BB's server. The first line `script` prints is the
  PTY's path. A resize is `stty` on that path. Closing the terminal kills
  `script` with SIGKILL, which hangs the box's shell up at once. A SIGTERM
  would make `script` print into the stream and wait.
- The panel reaches it over a plugin WebSocket, `/terminal`, as it reaches
  the desktop ([007](007-desktop-stream-is-a-typed-transport.md)).
- The plugin owns each shell, by box and by a session ID the tab keeps,
  because panel tabs remount when a person switches between them. A tab
  that comes back gets the last 256 KiB of output, and its size. A shell
  with no tab ends after 10 minutes. It also ends when it exits, when the
  box stops or is released, and when the plugin stops. The tab then says
  why, and offers a new shell.

## Consequences

- Nothing runs in the box, so every guest OS with SSH has a terminal,
  Windows included through OpenSSH's ConPTY (to check on the first
  Windows box).
- A shell does not survive a plugin restart, and is not in BB's terminal
  list.
- macOS spells `script` and `stty` differently. When BB runs on a Mac,
  this is untested.
