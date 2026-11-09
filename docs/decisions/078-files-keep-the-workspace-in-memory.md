# 078: Files keep the workspace in memory across panel switches

Status: accepted, 9 November 2026. Extends [077](077-files-draw-one-level-before-walking-names.md).

## Context

BB unmounts a panel when the person switches tabs. The cached directory listing from 077 made the tree faster, but did not keep open files, unsaved text or the person's position.

## Decision

Keep a workspace snapshot in the app module, keyed by thread and box. Restore it synchronously before refreshing directory names quietly. Keep the root, expanded folders, ordered tabs and active file, drafts and their original hashes, editor position and selection, find, search and its results, tree position and explorer visibility. Quick open closes on return.

Retain at most eight hidden workspaces and 32 MiB of encoded snapshots. Drop the least recently used snapshots to fit both limits. A snapshot larger than that budget is not kept. Active workspaces are separate from this cache. File contents never enter browser storage. A reload clears the cache.

The app's Files lifetime overlay checks retained boxes after a change signal and after reconnection. A released box loses its snapshots in every thread. Replies belonging to an unmounted view cannot update the next view. A save after returning still uses the original open hash; refreshing names does not reload a draft.

The Files header appears only when it holds a back control or a Desktop or Terminal switcher. When shown, it still names the box. The thread tab already names it.

## Consequences

Switching panels keeps work in progress within the memory budget. This is not durable draft storage: save changes before reloading the app or opening enough other workspaces to evict an old one. A save interrupted by a panel switch can be retried with its original hash; if the first write completed, the guard reports a conflict rather than overwriting it silently.

Verification is recorded in [078-results](078-results.md).
