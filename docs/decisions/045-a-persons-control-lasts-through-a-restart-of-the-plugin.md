# 045: A person's control lasts through a restart of the plugin

Status: accepted, 1 October 2026. Partly supersedes
[008](008-shared-control.md): a restart of the plugin no longer gives
control back to the agent. Extends
[043](043-a-viewer-has-5-s-to-come-back-after-the-box-ends-its-connection.md).

## Context

Control lived in the plugin's memory only, so every update or reload of
bb-box gave each person's control back to the agent. Since #139 the plugin
also set each desktop back to the agent's size as it stopped. In the check
of #293, a deploy took control from the person and changed the size of the
desktop they were using.

BB starts a plugin's next instance before it stops the last one. It then
waits up to 5 s for each of the last instance's services before that
instance closes its viewers' connections. So the last instance cannot hand
its state over as it stops, and the new instance cannot know when the
viewer's connection closes. The viewer tries again after 1 s, then after
2 s, 4 s and 8 s more, and every 15 s after that.

## Decision

- Each person's control of a box's desktop is kept in plugin storage: the
  viewer that holds it, the desktop's size while the agent had control,
  and the screen of the holder's last resize. It is stored on every change
  of control, not as the plugin stops. An instance that has stopped stores
  nothing, so it never overwrites the next instance's.
- As it stops, the plugin lets go of the keys and buttons each holder holds
  down, and leaves the desktop at the person's size. If the latest store
  failed, it gives control back and sets the size back, as before.
- The next instance gives control to the same viewer, for each box that is
  still ready. The viewer has 60 s to connect again, as a viewer that goes
  away has. If it does, it keeps control and the desktop's size. If not,
  control goes back to the agent and the desktop's size is set back.
- A box that stopped or went while the plugin was away starts with the
  agent in control.
- The plugin log says, as the plugin stops and as it starts, which desktops
  a viewer keeps control of and for how long.

## Consequences

- An update or reload no longer takes control from a person whose viewer
  is open, nor changes their desktop's size.
- If the person closed the viewer while bb-box restarted, the agent waits
  up to 60 s, or takes control back with `computer_take_control` (038).
- A plugin that stops without disposing, as in a crash, leaves the latest
  stored control, so the next start gives the desktop's size back after
  60 s if the viewer does not return.
- 5 s, the time a box gives a viewer when it ends the connection (043), is
  too short here: it could end before the last instance closes the
  viewer's connection.
