# 043: A viewer has 5 s to come back after the box ends its connection

Status: accepted, 1 October 2026. Partly supersedes
[020](020-control-belongs-to-a-viewer.md): a box that ends the holder's
connection no longer gives control back at once. Extended by
[045](045-a-persons-control-lasts-through-a-restart-of-the-plugin.md): after
a restart of the plugin, the holder's viewer has 60 s to connect again.

## Context

020 gave control back to the agent at once when a box ended the connection
of the viewer with control. Its reason was that a restarted desktop cannot
take the viewer back to the same session, so waiting held input for nobody.

In the recheck of #248, restoring a split pane made the box end the
holder's connection once. The viewer connected again by itself 2.5 s later,
but control had gone to the agent, so the person had to take it again. The
viewer tries again after 1 s, then after 2 s more.

A box that stops, starts or is released already gives control back at
once, because bb-box forgets the box's control then. So 020's case of a
restarted desktop is mostly covered without the hand-back at once.

## Decision

- A box that ends the holder's connection gives its viewer 5 s to connect
  again, which fits both of its tries. If it does, it keeps control, and
  the desktop keeps its size. If not, control goes back to the agent and
  the desktop's size is set back, as before.
- A viewer that goes away still has 60 s to come back.
- A box that stops, starts or is released still gives control back at
  once.
- The plugin log warns each time a box ends the holder's connection, with
  the reason and how long the viewer has.

## Consequences

- A short drop on the box's side, as when a pane is restored, no longer
  takes control from the person.
- A desktop that restarts in place while the box stays ready leaves the
  holder in control of the new session for up to 5 s, and the agent waits
  that long.
