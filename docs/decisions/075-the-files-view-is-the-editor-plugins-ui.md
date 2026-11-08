# 075: The files view is the editor plugin's own UI

Status: accepted, 8 November 2026. Supersedes the view-construction sentence of [074](074-a-box-has-a-files-view.md).

## Context

[074](074-a-box-has-a-files-view.md) took the behaviour of [bb-plugin-files-editor](https://github.com/abdoutelb/bb-plugin-files-editor) and built a different view from bb-box's components. That was the wrong cut. The view should look and work like that plugin. The reading and writing stay as 074 decided: the box user's own files, through the box's command transport.

## Decision

Ported as they are, with the plugin's comments removed:

- The explorer, the editor tabs, the file view, the find bar, quick open, the search results, the file glyphs, the workspace shell and the tab state.
- The helpers those need for the tree, for find in a file, for Markdown, and for the kind of a file.
- The layout, the spacing, the tabs, the search toggles, quick open, the find bar, Preview, Read and Edit, and the shortcuts: Ctrl or Command with P, with F, with Shift and F, and with S, and Escape. Alt with C, W or R still toggles match case, whole word and a regular expression.

Changed:

- The data source. The plugin's workspace calls are the box file calls from 074. The tree is `files.names` for the folder in the path bar. Opening is `files.read`. A file past the size limit can show its first 256 KB with `files.readRange`, and that slice cannot be saved. Saving is `files.write` with the hash guard. Search is `files.search`. [076](076-the-files-view-can-create-rename-and-delete.md) adds create, rename and delete to the view. This record had left them off the view, because the plugin has no such buttons.
- The workspace picker is a path bar. It opens at the box user's home. There is no project picker and no worktree picker. The folder button returns home. The up arrow opens the folder above.
- It still opens from the Files button on the box's row, on its page, and in the Files tab.
- Glyph colours use BB's theme tokens: foreground, warning text, destructive text, success, subtle foreground and muted foreground. The plugin's palette classes are not used.
- Names that start with a dot stay hidden until the eye is selected. The plugin showed them at first.
- The right-click menu on a tab is drawn by the panel. bb-box does not ship the context-menu package the plugin uses.
- BB's own icon is used. The plugin's copies of button, input, dialog, checkbox and overlay were not needed: this view's controls are the same plain buttons the plugin draws, and bb-box already has the icon.
- The path handed to BB's source view still ends in the real file name. A version sits in the directory in front of that name, so a reload shows the new text, and the colours still see the extension.

## Consequences

- 074 still decides the transport, the limits, the hash guard, the search corpus, device boxes, and what a failure may say. A listing of names does not count as that searchable copy: search keeps reading the box until the copy is warm.
- The save checks the file's hash and then writes through the file. The short window between that check and the write is accepted, as in common editors, since a writer that does not coordinate can always land in it.
- The plugin's copyright and permission notice on the [Third-party software](../../THIRD-PARTY.md) page covers this port.
- A person creates, renames or deletes from the view, as [076](076-the-files-view-can-create-rename-and-delete.md) decides. An agent still does it with `box_run`.
