# 020: Control belongs to one viewer, and a GPU desktop is retried on another GPU

Status: accepted, 30 September 2026. Extends
[006](006-gpu-desktop-on-xorg.md), [008](008-shared-control.md) and
[011](011-interface-v1.md). Extended by
[038](038-the-agent-can-take-control-back.md): the agent can take control
from a viewer. Partly superseded by
[043](043-a-viewer-has-5-s-to-come-back-after-the-box-ends-its-connection.md):
a box that ends the holder's connection gives its viewer 5 s to connect
again. Extended by
[045](045-a-persons-control-lasts-through-a-restart-of-the-plugin.md): the
viewer that holds control keeps it through a restart of the plugin, and a
desktop it resized gets its size back if it does not connect again within 60
s, after a crash too. Extended by
[021](021-desktop-resize-through-the-backend.md): a desktop whose VNC server
cannot resize is resized by its backend.

## Context

Building the desktop viewer, shared control and the GPU check found four
places where the decisions said too little:

| Point | What the build found |
| --- | --- |
| Who holds control | BB authenticates the person, but the relay sees connections. You can open one box in a panel tab and a browser tab at once, and a panel tab remounts when you switch threads. |
| A box that ends the connection | When the box's desktop restarts, the viewer cannot come back to the same session, so waiting 60 s for it holds input for nobody. |
| The size to return to | 008 returns the desktop to "its default size" on hand-back. The relay does not know a template's default, and TigerVNC answers SetDesktopSize only from a client that asked for the ExtendedDesktopSize encoding. |
| Retrying on another GPU | An acquire must finish within its kind's `readyTimeoutMs` (30 s on Proxmox LXC). A GPU whose desktop fell back to the CPU usually does so for the next box too. |

## Decision

- **Control belongs to one viewer.** Each viewer has a random ID, kept in
  its browser tab's session storage, and connects with it. A panel tab that
  remounts keeps its ID, and so the control it took. Two viewers open at once
  never share an ID. Only a viewer connected to the box's desktop can take
  control. Taking control in a second viewer releases the keys and buttons
  the first holds down, then moves control.
- **A box that ends the connection** gives control back to the agent at once.
  A viewer that goes away still has 60 s to come back.
- **The size to return to** is the desktop's size when a viewer joined while
  the agent had control. When control goes back to the agent from a holder
  who resized it, by hand-back or because the holder's viewer went, the relay
  opens a connection of its own, asks for ExtendedDesktopSize, and sends
  SetDesktopSize with the screen the holder last used, if the size differs.
  A box that stops, starts or is released forgets its size.
- **The relay always joins the box's desktop as a shared client,** whatever
  the viewer asks, so one viewer never disconnects another or the agent.
- **Retrying on another GPU.** A `linux-desktop` box whose display mode is
  `cpu` is released, and the backend claims a guest from another GPU's
  template while the kind's `readyTimeoutMs` allows. Each guest is claimed
  again as it becomes the box's, so the box's record always names the guest
  it holds, with its GPU, display mode and reason as facts. New desktops
  avoid a GPU that fell back for 10 minutes, while another GPU has a
  template. When no GPU is left, the refusal gives each GPU's reason and
  names `linux-desktop-cpu`. A warm desktop is checked the same way before it
  is kept.

## Consequences

- Another tab of yours shows the desktop without input until it takes
  control.
- The panel shows control as yours only in the viewer that holds it.
- A desktop that was resized and not restored, because the plugin restarted,
  keeps its size until a viewer resizes it again.
- `start` of a stopped desktop does not check its display mode again, so its
  facts can be out of date until it is released.
- The smoke script opens a desktop box's desktop as the relay does, so a
  backend's VNC password and route are checked without BB.
