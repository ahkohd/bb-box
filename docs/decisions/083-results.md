# Android snapshot checks

10 November 2026. Separate BB 0.49.0 in a Proxmox LXC Linux box, no account.
BB Box was built and installed from the branch. The Android VM used
LVM-thin storage and nested KVM, with 8 cores, 16 GiB memory and 48 GiB disk.
Only one Android box ran at a time.

The test box was a personal machine (`bb box machines add android`) because
a placeholder thread is swept when it does not exist in the separate BB.
Account enrolment was unavailable, but BB Box commands and the panel worked.

## Restore and undo

Commands used the separate BB's CLI wrapper. BOX and UNDO stand for the
box name and the undo ID returned by BB Box.

```sh
bb box machines add android --name android-check
bb box run BOX 'timeout 90 adb wait-for-device; adb shell "echo A > /data/local/tmp/marker; sync; cat /data/local/tmp/marker"; echo A > /home/box/host-marker' --machine
bb box snapshot take BOX --name marker-a --machine
bb box run BOX 'timeout 90 adb wait-for-device; adb shell "echo B > /data/local/tmp/marker; sync; cat /data/local/tmp/marker"; echo B > /home/box/host-marker; cat /home/box/host-marker' --machine
bb box snapshot restore BOX marker-a --replace --machine
bb box run BOX 'timeout 90 adb wait-for-device; adb shell cat /data/local/tmp/marker; cat /home/box/host-marker' --machine
bb box snapshot restore BOX UNDO --replace --machine
bb box run BOX 'timeout 90 adb wait-for-device; adb shell cat /data/local/tmp/marker; cat /home/box/host-marker' --machine
```

Outputs were B/B before restore, A/A after restore and B/B after undo.
The device started through BB each time. No manual service start or boot
flag was used. Its server log reported a cold boot after undo.

Memory snapshots, fork and Keep each refused with the disk-only or missing
identity reset reason. The Linux and Windows backend paths were unchanged.

## Panel

Playwright with headless Chromium opened the separate BB's Box panel at
1200 by 900 pixels. After undo, its device menu switched Pixel 8 to Pixel
Fold and back. The Fold's server log reported a cold boot. Both markers
still read B after switching back.

The panel's Home control returned to the launcher. A pointer click on the
Phone icon opened Phone through the panel's device input.

![Before the tap](083-images/before-tap.png)

![After the tap](083-images/after-tap.png)

![Pixel Fold after switching](083-images/pixel-fold.png)

![Pixel 8 after switching back](083-images/pixel-8-again.png)

## Checks of the withdrawn boot-ID rule

Typecheck passed. The Proxmox, snapshot, conformance and Android tests
passed: 772 passed, 242 skipped, none failed. The new host-boot regression
failed against the original emulator implementation: all four starts had
no cold-boot flag. With the change, the first three starts received the
flag and the fourth, within the same host boot after a saved stop, did not.
All 38 Android tests passed. Reference generation produced no diff.
The documentation site built and its link check passed.

## Evidence for the retained design

At 7d01cfda, before the boot-ID rule, two runs through BB restored A/A
and undid to B/B without a manual service start. The existing unsaved
marker selected cold boots. This is the live evidence for the retained
design from [063](063-device-boxes.md).

The first live failure used a manual
`systemctl --user start bb-box-emulator@pixel_8`. That bypassed
`Emulator.start()`, including its marker check and cold-boot flags.
The later clean stop removed the marker. The boot-ID rule does not fix
manual service starts.

The earlier failure to start the device automatically after undo remains
unexplained and was not reproduced. It is not evidence for the boot-ID rule.

The rule in 4efe1f73 was tried and removed before merge. Its test checked
a new rule, not stale data: after a clean save, quick boot was correct.
The rule also discarded the image's checked saves on every new box's first
start. The timings in 063 imply about 11 to 15 seconds extra for affected
starts; this pass did not measure that difference live.

## Checks after removing the rule

On a separate Linux test box with Node 24.21.0, typecheck passed.
The required Proxmox, snapshot, Android and conformance suite passed:
1,013 tests, 771 passed, 242 skipped, none failed. All 37 Android tests
also passed on their own. Restoring the 4efe1f73 emulator made the
first-start assertion fail: it expected quick boot but got cold boot.

Reference generation produced identical file hashes. The documentation
site built and checked 33,489 links and assets, none broken.
No new live backend run was made in this correction pass; the two
7d01cfda runs above are the evidence for the restored emulator code.
