# 077: Files draw one level before walking names

Status: accepted, 9 November 2026. Supersedes the recursive initial tree in [075](075-the-files-view-is-the-editor-plugins-ui.md).

## Context

A recursive listing delays the first tree. Starting one process per name makes a large home particularly slow. A timeout could leave a partial list treated as complete.

## Decision

The panel asks `files.tree` for the home path and its first level in one command. Opening a folder lists one level. Pointer dwell of 120 ms and keyboard focus prefetch that level. After the first draw, a separate names-only walk fills quick open. Hidden folders are pruned unless dotfiles are shown. No corpus or file contents are read to open the tree.

The plugin keeps an 8 MB byte-capped LRU of tree replies, separated by box, path, depth and hidden setting. A reopen returns cached entries before the panel requests a quiet refresh. Refresh is explicit and its icon stays still. Empty loading folders show bars at the height of rows, with animation only when reduced motion is off.

GNU find emits names and types in one pass. Other POSIX systems batch stat and encode records through one awk process. Windows enumerates each directory once and prunes before descending. A shallow listing keeps at most 5,000 entries; quick open keeps at most 20,000 names and states when capped. A completion marker and command status distinguish complete results from interrupted walks.

The tree sits to the right of the editor, with its resize handle on the left. The explorer toggle sits at the right of the breadcrumb bar. Below 700 px, the tree and file still alternate. The path row holds Up, Refresh and a create menu. Search has its own row with match toggles, quick open and dotfiles. The tab names the box.

## Consequences

The editor, hash-guarded saves, conflicts, box-user permissions and panel-only RPC remain as in 075. Cached names may be briefly stale while refreshing. Files still use their normal read and write calls. The measured boundaries and results are in [077-results](077-results.md).
