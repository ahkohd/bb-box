# 038: The agent can take control back when asked

Status: accepted, 1 October 2026. Partly supersedes
[008](008-shared-control.md): the agent need not wait while you hold
control. Extends [015](015-computer-use-through-cua-driver.md) and
[020](020-control-belongs-to-a-viewer.md).

## Context

While you hold a desktop's control, every computer tool refuses at once
(008, 015), and control returns only when you hand it back. You often take
control, finish, and then write "carry on" in the chat. The agent could
only ask you to find the viewer and press "Hand back". The operator asked
that the agent can take control back when asked, or when the chat makes
clear you have finished.

## Decision

- A new tool, `computer_take_control { box }`, takes control from you as a
  hand-back does:
  - the relay releases the keys and buttons your viewer holds down (008);
  - it restores the agent's desktop size (020);
  - every reference and image is dropped, so the agent observes again
    (015).
- Its description says to use it when you ask the agent to continue, or
  when the chat makes clear you have finished, and otherwise to wait. When
  you hold control, the computer tools' refusal names it as the way to
  continue once you ask.
- Your viewer then says "The agent took control", with "Take control
  again". Taking control does not change: you can take it straight back at
  any time.

## Consequences

- "Carry on" in the chat is enough. You need not go back to the viewer.
- You and the agent can take control from each other in turn. The last to
  take it has it, and the viewer says who that is.
- The pause stays cooperative (015): the tool's description, not the
  relay, keeps the agent from taking control while you work.
- A hidden tab's hand-back
  ([037](037-a-panel-keeps-a-boxs-desktop-and-terminal.md)) checks who
  holds control first, so it does not undo the agent's take.
