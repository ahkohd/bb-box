# 078: Verification results

9 November 2026.

The regression suite covers an immediate unmount and remount with a dirty draft, its original save hash, ordered tabs, selection direction, editor and tree scroll, expanded folders, root navigation, find, search options and results, explorer visibility and closed quick open. It also covers thread and box isolation, both cache limits, release while hidden or mounted, stale release replies, a pending file read, native text selection and React strict effect replay.

In an isolated copy, restoring the previous implementation produced eight failing regression tests. Removing each of the count limit, byte limit, release invalidation, stale-release guard and original-hash save separately also failed its test. Restoring the implementation passed all 13 new tests.

Chromium checked the built Files panel at 1440 and 390 pixels, in light and dark themes. The surrounding BB app used a harness. File operations used the production panel RPC handlers and Docker command transport against Ubuntu 24.04 in a local container. Each combination restored a dirty editor, a backward selection, 420 pixels of editor scroll, the find query, expanded folders and 320 pixels of tree scroll. A save sent the original open hash and wrote the draft to the container. The narrow view also restored 12 pixels of horizontal scroll. The name-only header was absent at both widths.

A separate check changed the file in the container before returning to the dirty editor. Saving reported a conflict, kept the external edit and wrote the draft to the conflict copy. Screenshots and command logs accompany the change as review artifacts. This checks the real Docker file path, but does not claim a test of BB's live tab host or its source renderer.
