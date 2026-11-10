# Android snapshots use the existing unsaved marker

Status: accepted; boot-ID rule withdrawn before merge
Date: 10 November 2026

Checks and screenshots are in [the results](083-results.md).

## Context

A whole-VM snapshot can hold newer Android disk data than the emulator's
quick-boot save. Decision [063](063-device-boxes.md) already protects this
case with a marker written before every BB emulator start. Only a clean
save removes it. Each model keeps its own data and save together.

## Decision

Keep Android whole-VM disk snapshots and restores in place with a snapshot
undo. Use the existing unsaved marker to choose a cold boot. A running
model's marker survives a snapshot or the hard stop before an undo.
After a clean save, quick boot remains correct because the save matches
the Android data.

The boot-ID rule tried in 4efe1f73 is removed. It forced cold boots in new
boxes and after host restarts even when their saves matched the data.
The recorded timings in 063 imply about 11 to 15 seconds extra per affected
start. No restore through BB was found to need this rule.

This decision preserves 063's boot choice; it does not supersede it.
Starting the emulator service by hand bypasses BB's marker check.
Protection for that path is a separate follow-up.

## Consequences

Restores and undos of running models boot cold through the existing marker.
Clean saves and the image's checked saves remain eligible for quick boot.
Two live runs through BB at 7d01cfda confirmed restore and undo without
manual service starts. Linux and Windows QEMU paths do not change.
