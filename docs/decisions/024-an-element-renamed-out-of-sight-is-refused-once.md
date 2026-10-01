# 024: An action on an element renamed out of sight is refused once

Status: accepted, 1 October 2026. Partly supersedes
[023](023-a-reference-follows-its-element-through-its-own-rename.md): what
an action on a reference does when its element was renamed.

## Context

Since 023 an element whose role no sibling shares is placed without its own
name, so its reference follows it through any rename. That keeps Mousepad's
text view, which is named after its text, on one reference. It also lets a
reference move to another control in the same spot. When a window's only
button there changes from "Cancel" to "Delete account", for example after
the page behind it changes, the new button takes the old one's reference.

The agent may never see the new name:

- Cua's tokens go stale whenever a window is read, so an action reads the
  window again before it acts.
- An image of a window reads its tree too, but the agent sees only pixels.
- An idle close or a reconnect makes every token stale.

In each case the reference follows the renamed element with no tree or list
of changes showing it. After a stale token, bb-box advises trying again, so
the worst path was short: try again, and bb-box clicks "Delete account".

The review of pull request #32 first suggested leaving the own name out of
the place only for elements that hold content, that is, have a value. On a
real box, Cua 0.28.3 gives Mousepad's text view no value: its entry has its
role, and its text as its name. Only the scroll bars have a value. That rule
would not keep 023's case.

## Decision

- For each reference, bb-box records the role and name it last showed the
  agent: in a tree, in an action's list of changes or read-back, in a
  popup's items, or in an action's result.
- An action on a reference whose element now has another role or name is
  refused, with both: "e5 is now push button 'Delete account', but bb-box
  last showed it as push button 'Cancel', so nothing was done."
- The refusal shows the new name, so the next action on the reference goes
  ahead.
- 023's places stand.

## Consequences

- Typing into a text area named after its text keeps working: each result
  reads the text area back, which shows its new name.
- An element renamed where the agent did not see it costs one refused call.
  So does one whose change fell past the 60 lines an action's list of
  changes holds.
- A reference whose element has gone is refused as no longer on screen,
  with the name the agent last saw.
