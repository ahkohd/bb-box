# 023: A reference follows its element through its own rename

Status: accepted, 1 October 2026. Partly supersedes
[022](022-references-follow-renames-not-rows.md): what makes up an element's
place. Partly superseded by
[024](024-an-element-renamed-out-of-sight-is-refused-once.md): what an action
on a reference does when its element was renamed.

## Context

022 kept a reference when only its element's ancestors' names changed. The
place it matched on held the element's own name, so an element whose own
name changed got a new reference.

Some elements are named after their content. Mousepad names its text view
after its text. Typing into it three times on a real box gave the text area
three references, `e166`, then `e180`, then `e184`, so the second call to
type into the same reference was refused.

## Decision

- An element's place is its role and its position among siblings of its
  role, under ancestors placed the same way.
- An element, or an ancestor, that shares its role with a sibling keeps its
  name in the place, as rows in a list do in 022.
- The rest of 022 stands: a reference is first found by its fingerprint,
  the place must belong to one element in each snapshot, and the new
  element's fingerprint to it alone.

## Consequences

- Typing into a text area named after its text keeps its reference, however
  many times you type.
- A lone button whose name changes, such as Play becoming Pause, keeps its
  reference: it is the same control.
- A button in a list whose rows all changed still gets a new reference
  (022), because each row shares its role with the others.
- Of several fields of one role side by side, one whose name changes gets a
  new reference, as before.
