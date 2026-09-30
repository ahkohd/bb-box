# 008: You and the agent share one desktop, with one controller at a time

Status: accepted, 30 September 2026.

## Context

You watch the agent work and sometimes take over: to log in, to fix a dialog,
or to show it something. Two drivers at once corrupt each other's input, and a
resize under the agent breaks the coordinates it is using.

## Decision

- Each desktop box has one controller: the agent (the default) or you.
- The agent drives through computer use inside the box. You drive through the
  stream. The stream never carries the agent's input.
- Taking control:
  1. the core marks the box as changing hands, so no new agent action starts;
  2. the agent's action in progress gets up to 5 s to finish, then it is
     ended; apps it started keep running;
  3. you become the controller.
- While you hold control, the agent's computer-use calls fail at once with a
  clear error saying you have control (JSON-RPC error -32001), and the agent
  waits or does other work.
- The relay drops input, clipboard and resize messages from every viewer
  that does not hold control (the message lists are in the research note).
  Frame acknowledgements and keyframe requests always pass.
- Resizing is allowed only while you hold control. The desktop returns to its
  default size when you hand back.
- Control returns to the agent when you hand back, or when your viewer
  disconnects or stops answering.

## Consequences

- You can open a box in several tabs; only the tab that took control sends
  input.
- The in-box computer-use service knows who holds control, and is written
  once per OS like everything else that runs in a box.
- Ending the agent's action in progress is per OS. On Linux it is a cgroup
  freeze and kill; Windows and macOS need their own way.
- Anything stale falls back to the agent, so a closed browser never leaves a
  box stuck under your control.
