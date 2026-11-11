# 090: measurements

Measured on 11 November 2026 with the scripts in this folder, on boxes taken
for the spike and released afterwards. No pool machine was used.

- Linux: Proxmox QEMU VMs, 4 cores, 8 GiB memory, Ubuntu 24.04.5, kernel
  6.8.0-149, btrfs-progs and ZFS 2.2.2 from Ubuntu, on loop files.
- macOS: a Tart VM, 4 cores, 8 GiB memory, macOS 27.0 (26A428), APFS,
  FileVault off, Xcode 27 with the iOS 27.0 runtime. Spotlight indexing is
  off in this image, as `setup-mac.sh` turns it off on pool Macs.

Test users were made as the pool makes box users: `bbx-<n>` with UIDs from
70001, and on the Mac by `sysadminctl`, hidden, in `_developer`, signed in at
the console by the automatic login, as `machine-mac.sh` does.

## Linux, btrfs, each home a subvolume (`home-linux.sh`)

| What | Small home (4 MiB) | Large home (4 GiB, 20,000 small files) |
| --- | --- | --- |
| Take (read-only snapshot) | 41 to 88 ms | 43 to 56 ms |
| Disk used by 6 takes, `df` | 196,608 bytes in all | |
| After changing 1 GiB in the home | | `df` grew 1,075,871,744 bytes; the home 1.00 GiB exclusive, 3.00 GiB shared |
| Restore with undo, the user's processes ended first | | 589 ms: 254 ms to end processes, 231 ms undo and swap |
| Undo of that restore | | 352 ms, every file as before |
| Fork into a new user | | clone 158 ms, change of owner 268 ms, 0 bytes of its own |

At 220,000 files of 200 bytes: snapshot 137 ms, writable clone 76 ms, change
of owner 4,286 ms, delete 406 ms.

Restore without ending the user's processes first: the swap and even the
delete of the replaced subvolume succeed (`btrfs subvolume delete` exits 0).
A writer whose working folder was in the home kept it in the deleted
subvolume, and the files it opened by path (`~/work/writer.log`) were
written into the restored home.

A user service under linger (a stand-in for BB's daemon) is ended by the
restore and is not started again by restarting `user@<uid>.service` alone,
as it was a transient unit. BB's daemon is a unit in the home, which comes
back with the user manager.

Today's reset on a subvolume home:

- `userdel -r` deletes a home that is a subvolume (`Delete subvolume 275`).
- The read-only snapshots survive `rm -rf` ("Read-only file system") and
  `rm -rf --one-file-system` ("since it's on a different device"), which the
  helper's sweep uses.
- The helper's `dirt` check looks at `/home/bbx-*` only, so snapshots left
  in another folder would not stop the next claim. They would stay, holding
  the earlier box's files.

## Linux, ZFS, each home a dataset

| What | Large home (2 GiB, 10,000 small files) |
| --- | --- |
| Take | 51 to 64 ms; 3 takes added 110,592 bytes to the pool |
| Restore in place to an older snapshot | refused: "more recent snapshots or bookmarks exist" |
| Restore by clone and promote, with undo | 765 ms: 54 ms to end processes, 613 ms clone, promote and rename |
| Fork by `zfs send` and `receive` | 11,970 ms, a full copy (2.00 GiB) |
| Fork by `zfs clone` | 128 ms, but the source snapshot then cannot be deleted: "snapshot has dependent clones" |

After a clone and promote restore, the snapshots newer than the target
(`s2`, `s3` and the undo) belong to the replaced dataset, not the home.

## Machine scope, LVM thin hook (`snapshot-machine-lvm.sh`)

`check-hook.sh` run through `machine-snapshot.sh` against an 8 GiB thin
volume holding 1 GiB: 25 checks passed, 0 failed.

| What | Time |
| --- | --- |
| Take, through the helper's detached run | 1,183 ms, of which the filesystem was frozen 108 ms |
| Restore | 613 ms |
| Restore killed after each of its 3 steps, then asked again | finishes, data as at the take, hook launched twice |
| Machine restart during a restore (boot ID changed), then asked again | finishes, data as at the take |
| A second take or delete of the same snapshot | exits 0, same snapshot |
| Restore of a snapshot that is not there | exits 4 |

An earlier version of the hook froze the root filesystem: when its volume
was not mounted, `fsfreeze -f /srv/machine` froze the filesystem that
folder is on. The VM stopped answering and had to be released. The hook now
refuses to freeze a folder that is not a mount point (checked: exits 1 with
the reason).

## macOS, APFS clones of a home (`home-mac.sh`, `clone-tree.c`)

| What | Small home | Large home (4 GiB, 20,004 files) | 220,028 files |
| --- | --- | --- | --- |
| Take, `clonefile(2)` of the home folder | 9 to 11 ms | 114 to 129 ms | 3,761 ms |
| Data volume grew, `df` | 16 to 40 KiB | 4.2 to 6.4 MiB | 49 MiB |
| `cp -c -R -p` | | 1,358 ms, 4.8 MiB | |
| `ditto --clone` | | 1,613 ms, 2.5 MiB | 20,824 ms, 52 MiB |
| Read every entry's ACLs, `ls -leR` | | | 4,111 ms |
| Delete a clone | | | 8,340 ms |

What each way keeps, against the home: `clonefile` keeps files, owners,
modes, flags (`compressed`) and extended attributes, but none of the home's
15 ACL entries ("group:everyone deny delete" on Desktop, Documents, Library
and others), and gives every folder a new modification time. `ditto --clone`
keeps all 15 ACL entries; `cp -c -R -p` keeps 14.

Logged-in user (at the console, a full desktop session):

| What | Time |
| --- | --- |
| Take of the live home | 1,642 ms the first time, 153 ms the next |
| Take with all 227 of the user's processes stopped (`SIGSTOP`) | paused 263 ms: 53 ms to stop, 166 ms to clone; the session worked afterwards |
| Restore: end the session | 634 to 1,159 ms |
| Restore: undo and swap | 1,044 to 1,402 ms |
| Sign the same user in again, `launchctl kickstart -k system/com.apple.loginwindow` | 1,584 ms |
| Sign a new user (a fork) in: loginwindow alone | not within 30 s |
| Sign a new user in: `launchctl reboot userspace` | 20 s |

With the automatic login still naming the user, loginwindow signed the user
back in 2,559 ms after the session ended, before any swap would finish.
With the automatic login cleared first, the console stayed at the login
window for 15 s.

Swapping the home while the session runs: 120 or so of the user's
processes (Dock, WindowManager, cloudd, corespotlightd, knowledge agents and
more) kept files open in the moved-aside home. cfprefsd and `security`
reopened by path and read the restored files.

After a restore and sign-in, the preference, the file and the login
keychain item were as at the take; an item added after the take was gone;
the keychain was unlocked by the sign-in.

iOS Simulator, as a user with no desktop session, as slot users are:

| What | Result |
| --- | --- |
| Device data in the home | `~/Library/Developer/CoreSimulator/Devices/<udid>`, 223 MB after the first boot |
| First boot | 40 s |
| Shut down before a take | 4 s |
| Restore, with the device booted when the helper started | 3,559 to 3,795 ms to end processes (simctl shutdown), 2,593 ms undo and swap |
| After restore | `simctl list` showed the device as it was, and not the device made after the take; it booted in 14 s; the setting inside it was as at the take |
| Snapshot taken while the device was booted and paused | restored, booted in 14 s, setting as at the take |

Fork of a logged-in home into a new user, with BB-style files planted:

- Clone 180 ms, change of owner 694 ms.
- Removed by the reset: BB's `host-id`, `auth.json`, `config.json`, the
  access file, BB's launch agent, `login.keychain-db` and the keychain
  folder named by the Mac's hardware UUID.
- Kept: the user's SSH key and `gh` token, as 070 says of every fork.
- No file named the source user's GeneratedUID.
- 6 files named the source's home path, `/Users/bbx-1`: Photos libraries'
  `appPrivateData.plist`, CoreSpotlight's `EnabledIndexes`, a photolibraryd
  plist, and BB's launch agent before the reset.
- `ByHost` preferences name the Mac's hardware UUID, which a fork on the
  same Mac shares.
- After a userspace restart the fork was at the console, with a new login
  keychain that took new items, none of the source's keychain items, and
  the source's preferences.
- A copy of the source's login keychain did not unlock with either user's
  password from a command line outside the session. This is inconclusive;
  the fork deletes the keychain in any case.

What a Mac box user owned outside its home after a session:
`/private/var/folders/<xx>/<user>` (its temporary and cache folders, where
Xcode keeps its module cache), `/private/var/db/mds/messages/<uid>`,
`/private/var/protected/trustd/private/<GeneratedUID>`,
`/private/var/protected/sfanalytics/<GeneratedUID>`, 3 folders under
`/private/var/containers/Data/ProtectedSystem`, Trial assets under
`/Library/Trial`, launchd sockets in `/private/var/tmp`, and launchd's
`/private/var/db/com.apple.xpc.launchd/disabled.<uid>.plist`.
