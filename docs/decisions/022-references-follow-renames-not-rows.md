# 022: A reference follows its element through a rename, not into another row

Status: accepted, 30 September 2026. Partly supersedes
[015](015-computer-use-through-cua-driver.md): how an old reference is found
again.

## Context

015 gave each reference a fingerprint: its element's role and name, and its
ancestors' roles and names. An old reference is found again in the latest
tree, or refused if it matches none or several. With raw Cua tokens, a stale
reference in foreground mode clicked the wrong element.

An ancestor's name can change while its elements stay the same. The window's
title is the root's name, and an editor's tab gains a `*` once its document
is edited. Every element under them then lost its reference: typing one
character into an editor's text area made that area's reference stale.

Pull request #25 kept such references by place: the element's role and name,
its ancestors' roles, and its position among siblings of its role. That also
moved a reference into another row. Checked with the test driver, on a list
whose rows each have a button named "Delete":

| Step | With #25 | With this decision |
| --- | --- | --- |
| Observe: `e4` is the Delete button of row "Task 1" | | |
| The rows become "Invoice 7" to "Invoice 9", and another action reads the window | `e4` moves to row "Invoice 7"; the report shows only the rows changing | `e4` matches nothing |
| Click `e4` | deletes "Invoice 7" | refused: `e4` is no longer on screen |

## Decision

- An element keeps its reference while its role, its name and its
  ancestors' roles and names stay the same (015).
- When only ancestors' names changed, it keeps the reference of the element
  in its place in the window's last snapshot. The place is its role and
  name, its ancestors' roles, and its position among siblings of its role.
- An ancestor that shares its role with a sibling, such as a row in a list
  or one of several tabs, keeps its name in the place.
- The place must belong to one element in each snapshot, and the new
  element's fingerprint to it alone.

## Consequences

- An editor's text area keeps its reference while you type into its only
  document, and a page keeps its references when its title changes.
- A button in a list whose rows all changed gets a new reference, and the
  old one is refused.
- With several documents open in one editor window, typing that renames a
  tab loses the text area's reference, as before #25. The agent observes
  again.
- A list of one row whose row changes still moves that row's buttons'
  references, because its row has no sibling of its role.
- Core uses only roles, names and the tree's shape, with no list of roles
  per platform (001).
