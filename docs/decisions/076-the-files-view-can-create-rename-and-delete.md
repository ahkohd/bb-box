# 076: The files view can create, rename and delete, and a narrow window shows one surface

Status: accepted, 8 November 2026. Extends [075](075-the-files-view-is-the-editor-plugins-ui.md).

## Context

075 ported the editor plugin's view and left create, rename and delete off it, because that plugin has no such buttons. A person could not do them from the view. The tree was also too narrow for the search field, and on a phone the tree and the open file sat side by side.

## Decision

- The tree starts at 360 pixels, the width of the plugin's own preview, and its edge can still be dragged. The width is remembered.
- Below 700 pixels the view shows the tree or the open file, not both. The tree comes first. Opening a file replaces it, and the back arrow returns to the tree. The plugin no longer does this: it used to, and then stopped.
- New file and New folder sit with the tree's other icons. They create in the folder the path bar shows.
- Right-click a row, or select … on the row, for New file, New folder, Rename and Delete. Rename is a field on the row. Delete asks for confirmation. An empty folder stays in the tree.

## Consequences

- 074 still decides the transport, the limits and the hash guard. The same calls do the work.
- An agent still creates, renames and deletes with `box_run`.
