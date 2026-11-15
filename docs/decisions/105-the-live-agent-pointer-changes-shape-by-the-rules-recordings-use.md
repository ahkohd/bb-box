# 105: The live agent pointer changes shape by the rules recordings use

Status: accepted, 15 November 2026. Extends [102](102-the-viewer-draws-the-agents-pointer-where-the-desktop-draws-none.md) and [073](073-recordings-draw-the-pointer-keys-and-zooms-from-the-event-log.md).

## Context

Since 102, the Box panel draws the agent's pointer over a Linux desktop where the agent clicks or scrolls by pixels. It was always the arrow. A recording's pointer already changes shape (073): a hand on a link or button it clicks, a text cursor on a text field it clicks or types into, and drag cursors while a person drags, each held for at least 0.3 seconds. People watching live saw the agent click links and type into fields with an arrow that never changed, then saw the same work in a recording with a hand and a text cursor.

Two things stood in the way. A click by pixels named no element, so it had no role to take a shape from, in the live pointer or in a recording. And typing reached the viewers only after it ended, as recordings log it then.

## Decision

- One module, `src/core/pointer-shapes.ts`, holds the shape rules: a click's shape from its element's role, typing's shape, how long each is held, and how held shapes resolve over time. Recordings and the live pointer both use it, so they cannot disagree.
- A click on a link or button shows a hand for 0.3 seconds. A click on a text field shows a text cursor until the pointer moves to another place, for at least 0.3 seconds. Typing into a text field shows a text cursor from its start until 1 second after it ends. A secret, or typing whose field's role is not known, keeps the arrow. A shape shorter than 0.3 seconds is held to 0.3 seconds before the next.
- A click by pixels takes its role from the window's tree the action already read: the tree of the window under the point, read only when it is small, for a click on the desktop's pixels, or the tree read with the agent's image of the window, for a click on a window's pixels. A tree cut short is not used. BB Box reads nothing more for it, so an action takes no longer. Where the point is in no element whose role gives a shape, or the window was too large to read quickly, the pointer stays the arrow. The smallest element at the point whose role gives a shape wins, so a button inside a text field shows a hand.
- The role goes into the recording's log too, so a recording shows the same shape for a click by pixels as the live pointer did.
- Typing tells viewers as it starts and as it ends, as `BB_AGENT,typing,<x>,<y>` and `BB_AGENT,typed,<x>,<y>`, at the place the agent last clicked or scrolled by pixels. Where the agent has acted at no known place yet, nothing is shown, as in 102. Setting a value counts as typing that ends at once.
- A click's shape goes on its message as a fifth field: `BB_AGENT,click,<x>,<y>,hand` or `ibeam`. The arrow has none, so a panel from before this reads the message as before.
- The panel draws the hand and the text cursor from the same paths and hotspots as recordings, in BB's primary colour on its primary foreground, at 40 px. A change of shape is not animated, so it needs nothing for reduced motion. The click ring keeps its rule from 102.

## Consequences

- On macOS and Windows, Cua Driver draws its own cursor, and BB Box cannot change its shape. Their recordings now show a hand or a text cursor for a click by pixels, as they did for clicks by reference.
- iOS and Android boxes have no live agent pointer (102), and a touch screen has no pointer shape.
- The agent never drags, so the live pointer shows no drag cursor. Recordings still show them for a person's drags.
- On a scaled Linux desktop, an app's frames may be in points rather than pixels (102). A click by pixels there may take the role of another element, and show the wrong shape for 0.3 seconds. It never moves the pointer.
- A click on a web page by the desktop's pixels mostly keeps the arrow, as a page's tree is usually too large to read quickly. A click on the browser window's own pixels takes its role from the tree read with the agent's image of it.
- The text cursor while typing stands at the pointer's last place, which may not be over the field, as in a recording.
