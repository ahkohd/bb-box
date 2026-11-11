# 090: results of unit 2, home snapshots on Macs lent whole

Measured on 11 November 2026 on a test pool Mac: a Tart VM, 4 cores,
8 GiB memory, macOS 27.0 (26A428), APFS, FileVault off, System Integrity
Protection off, set up with this unit's `setup-mac.sh` as a pool Mac named
`mac-test`. A fresh BB 0.49.0 ran on the same Mac with bb-box from this
unit's branch, its SSH host pool reaching the Mac at `127.0.0.1`. The box was
a `macos-desktop` machine, `pool-mac-box`, whose user `bbx-0` was signed in
at the console.

## The helper's proof

`machine snapshot proof`, run on the free Mac through the self-contained
proof script, passed all 31 checks in 138 s, most of it the reset's sweep of
the Data volume for the 2 scratch users. Users with a UID of 500 or more
were the same before and after, and no snapshot store was left.

| Step | Time |
| --- | --- |
| Take, the scratch user's processes paused | 373 ms in all, paused 45 ms |
| Stop, ending the scratch user's processes | 1,192 ms |
| Restore, the swap | 107 ms |
| Fork into a second scratch user | 2,068 ms |

A first run failed one check: a process the scratch user ran under a root
`sudo` stayed stopped after the take. `sudo` stops itself when its command
stops, and the resume reached only the user's own processes. The take then
resumed every process that stopped during its pause, again 0.2 s later, and
the second run passed. The independent review showed that this also resumed
processes that others had stopped, so the take now records and resumes only
its own (see After the independent review).

## Through BB Box on the test Mac

| What | How | Result |
| --- | --- | --- |
| Take, signed in at the console | `bb box snapshot take --machine` | 0.8 s; the box paused 372 ms; later takes 405 and 418 ms |
| Restore with undo, signed in | `bb box snapshot restore --machine --replace` | 31 s in all; signed in again in 9.4 s by restarting the login window, with no userspace restart. A file, a login keychain item and a Chrome profile's local storage were as at the take |
| Restore the undo | `bb box snapshot restore --machine --replace` | 34 s; all three as before the restore |
| Take and restore of a user not signed in | the same commands, after clearing the automatic login and ending the user's session by hand | 15 s; the file as at the take, the user left signed out, the automatic login left as it was, sign-in 0.1 s |
| Take and restore from the panel | the box page's Take snapshot and Restore | "from-panel", by you; the restore put the file back and signed the user in again |
| A helper killed during a take's pause | `kill -9` of the helper with 150,000 files in the home | 220 of the user's 221 processes stayed stopped until the helper's next command, `status`, resumed every one and cleared the pause's mark |
| BB restarted during a restore | the launch daemon restarted 6 s into a restore, with the session ended | BB's recovery finished the restore: the file as at the take, the user signed in again in 11 s |
| Release | `bb box machines remove` | the reset deleted all 6 snapshots of `bbx-0` and the user, signed `bbx-1` in by a userspace restart, and BB's sweep moved the Mac to generation 1 |

The tool, `box_snapshot`, was not called live: the fresh BB had no agent to
call it, and BB's own install is not used for live checks. It calls the same
core as the command.

## After the independent review

The review found 3 faults in the helper. A take killed during its pause left
a root `sudo` stopped after the next command's recovery. A take's resume
reached processes that it had not stopped, of any user. The helper's `fork`,
aimed at an existing user, replaced that user and deleted its files. The
fixed helper was measured on 11 November 2026 on a second test pool Mac: a
Tart VM, 4 cores, 8 GiB memory, macOS 27.0 (26A428), APFS, made a pool Mac
by the helper's `init`, with box user `bbx-0`.

The self-contained proof script, version 2, passed all 49 checks in 143 s.
Users with a UID of 500 or more were the same before and after, and no
snapshot store was left. While a box held the Mac, it refused with exit 3
and changed nothing.

| Step | Time |
| --- | --- |
| Take, the scratch user's processes paused | 431 ms in all, paused 303 ms |
| Stop, ending the scratch user's processes | 1,178 ms |
| Restore, the swap | 137 ms |
| Fork into a second scratch user | 2,315 ms |

| Check | Result |
| --- | --- |
| A root `sudo` above the scratch user's command | stopped with its command during the take, and ran again after it |
| The scratch user's command stopped by someone else before the take | stayed stopped after the take and after a killed take's recovery |
| A root process stopped by someone else during a take's pause | stayed stopped |
| The helper killed by `kill -9` during a take's pause | its pause record stayed; the next helper command, `snapshot list`, resumed the user's command and the `sudo` above it, and nothing else, and removed the record |
| A fork aimed at the source's user, a user the helper does not reserve, or the fork's user once made | exit 5 with the reason; the users' UIDs and files as before |

Through the helper's own commands, with `bbx-0` lent: after a take that
paused it for 336 ms, a root `sudo` above a command of `bbx-0` ran again, and
a `sudo` and its command that the Mac's admin user had stopped before the
take stayed stopped. `snapshot fork` aimed at the admin user, with UID 501 or
70500, and at `bbx-0` exited 5 with the reason, and the admin user kept UID
501 and its files.

## After the second independent review

The second review found 3 more faults. The proof deleted an account that
was on the Mac already on the strength of its name. Its check that the Mac
was free ran before it took the helper's lock, so a claim could come in
between, and it never looked at iOS slots. A take removed its pause record
0.2 s after the resume, so a `sudo` that stopped itself later stayed stopped
with nothing to resume it.

The self-contained proof script, version 3, was run on 11 November 2026 on 2
test Macs, each made a pool Mac by the helper's `init`, with box user
`bbx-0`:

- a Tart VM, 4 cores, 8 GiB memory, macOS 27.0 (26A428), APFS, FileVault
  and System Integrity Protection off, the Mac's admin user at the console
- a Namespace VM, Apple M4 Pro (Virtual), 4 cores, 14 GiB memory, macOS
  26.3.1 (25D2128), APFS, FileVault and System Integrity Protection off

It passed all 53 checks on each, in 162 s and 139 s. Users with a UID of
500 or more were the same before and after, and no snapshot store or
record was left. The pause is now measured to the moment the take resumes
the user's processes; version 2's figure also held its 0.2 s second look.

| Step | macOS 27.0 | macOS 26.3.1 |
| --- | --- | --- |
| Take, in all, with 1 s of checks after the resume | 1,401 ms | 1,441 ms |
| The scratch user's processes paused | 71 ms | 54 ms |
| Stop, ending the scratch user's processes | 1,177 ms | 1,138 ms |
| Restore, the swap | 155 ms | 178 ms |
| Fork into a second scratch user | 2,368 ms | 2,183 ms |

| New check | Result on both |
| --- | --- |
| A root process above the scratch user's `sudo` that stops itself 3 s after the pause, later than the take's last check | stopped after the take; the take's record still named it; the next helper command, `snapshot list`, resumed it |
| What the proof made | each user recorded with its UID, `GeneratedUID` and home inode, and deleted by that record |

Its refusals were checked on the macOS 27.0 Mac. Each changed no user,
made no snapshot store and left no record.

| The Mac had | Exit | What it said, in short |
| --- | --- | --- |
| A user `bbbox-probe` with UID 70501 and a file in its home | 5 | the user is on the Mac, with UID 70501; the user, its `GeneratedUID` and the file were as before |
| Another user with UID 79999 | 5 | UID 79999 belongs to that user |
| A file of UID 79998 under `/Users/Shared` | 5 | files of UID 79999 or 79998 are on the Data volume, such as that file; the check took 38 s |
| A folder `/Users/bbbox-probe` with no account | 5 | the folder is on the Mac; its file was as before |
| An iOS slot held by a box, then one being made, in the device host's state, written by hand as the VM has no iOS slots | 3 | an iOS slot is held by a box, or being made, with its state file |
| A take's pause record with a stopped process of `bbx-0` | 3 | a pause record is left; the process stayed stopped and the record as it was |
| A holder of the helper's lock, which wrote the owner marker 2 s after the proof started waiting, then let go | 3 | a box holds the Mac |
| A box that holds the Mac, by the helper's `claim` | 3 | a box holds the Mac |
| The reset after that box's release, which could not sign the next user in with the admin user at the console | 3 | the Mac's reset is running |

## After the third independent review

The third review found 4 more faults. The proof's scan for files of its
scratch UIDs admitted it when the scan could not finish. Its clean-up swept
every file of a scratch UID, so it could delete another account's files
once that account held the UID, and it deleted a `sudo` rule's staging file
it had not made. An iOS slot claim sent before the proof could become held
while it ran. A second take dropped the first take's record of a process
above the box user's, and a recovery cut short after the minute could lose
a stopped process from the record before it resumed it.

The proof was made simpler instead: new scratch users each run, no scan,
clean-up only by its record, and the device host's lock held for the whole
run (see the decision). The self-contained proof script, version 4, was run
on 11 November 2026 on a test pool Mac: a Tart VM, 4 cores, 8 GiB memory,
macOS 27.0 (26A428), APFS, FileVault and System Integrity Protection off,
the Mac's admin user at the console, made a pool Mac by the helper's
`init`, with box user `bbx-0`.

It passed all 52 checks in 15 s; version 3 took 162 s, most of it the
scans and sweeps of the Data volume. Users with a UID of 500 or more were
the same before and after, and no snapshot store or record was left. Each
run left, as its note says, 2 empty temporary folders under
`/private/var/folders` and a Spotlight message folder, owned by the scratch
UIDs, which macOS made outside what the proof recorded.

| Step | Time |
| --- | --- |
| Take, in all, with 1 s of checks after the resume | 1,457 ms |
| The scratch user's processes paused | 71 ms |
| Stop, ending the scratch user's processes | 1,194 ms |
| Restore, the swap | 145 ms |
| Fork into a second scratch user | 2,230 ms |

Its refusals and recovery were checked on the same Mac. The iOS slot states
were written by hand, and a process holding the device host's lock stood in
for a slot command, as the VM has no iOS slots.

| The Mac had | Exit | What happened |
| --- | --- | --- |
| A box that holds the Mac, by the helper's `claim` | 3 | a box holds the Mac; users as before, no record |
| An iOS slot held by a box | 3 | an iOS slot is held by a box, with its state file |
| A slot command holding the device host's lock, which made its slot held 5 s later and let go | 3 | the proof waited 5 s for the lock, then saw the slot held |
| A slot command holding the device host's lock for 70 s | 3 | after 60 s: another command held the slots' lock |
| A slot command trying the device host's lock while the proof ran | 0 | the command could not take the lock; the proof passed and the slot stayed ready |
| A proof killed with `kill -9` after its first take | 0 | the next run removed what the record proved: 9 recorded processes, the scratch user, its home, password file and store; then it passed, and every user of the earlier record was gone |
| A record naming an account whose `GeneratedUID` is not the recorded one | 5 | the account, its file and the record stayed |

A run killed in the moment it starts its killed-take step leaves that
step's clone, a root `sleep 120` that the record does not name yet, which
ends by itself within 2 minutes.

## After the fourth independent review

The fourth review found three faults in version 4. Its restores cleared
the temporary and cache folders of the scratch user's UID, so they deleted
a file that was there before the proof ran. Its normal exit ended the
processes it started by process ID alone, before the clean-up that checks
each one's start time. And a recovery deleted what an earlier record
proved before it refused for what the record did not prove, or when it
could not list the Mac's users, then said it changed nothing.

Now one function signals, deletes and removes accounts, checking each
object's recorded identity at that moment (see the decision). A restore
clears only what the box user made in its temporary and cache folders
after macOS made the account, which the account's `creationTime` gives:
macOS makes the user's folder in `/private/var/folders` as it makes the
account, a second or two before the helper writes its password file, so
that file could not mark the user's start. The proof's restores clear only
the temporary files it recorded making. A recovery checks the whole record
and the list of users before it changes anything.

Version 5 was run on 11 November 2026 on a test pool Mac: a Tart VM, 4
cores, 8 GiB memory, macOS 27.0 (26A428), APFS, the Mac's admin user at the
console, made a pool Mac by the helper's `init`, with box user `bbx-0`. It
passed all 56 checks in 16 s, with users of UID 500 or more the same before
and after, and no snapshot store or record left.

| Step | Time |
| --- | --- |
| Take, in all, with 1 s of checks after the resume | 1,437 ms |
| The scratch user's processes paused | 166 ms |
| Stop, ending the scratch user's processes | 1,154 ms |
| Restore, the swap | 189 ms |
| Fork into a second scratch user | 2,218 ms |

The review's reproductions were run against version 5 on the same Mac.

| The Mac had | Exit | What happened |
| --- | --- | --- |
| A folder at the depth of a user's temporary folder for each UID from 90000 to 99999, each with a file in its `T` folder, made before the proof | 0 | all 10,000 files stayed |
| A file planted in the scratch user's own temporary folder, owned by its UID, once the proof had made the user | 0 | the file stayed; the restore cleared only the proof's recorded files |
| A record naming a folder with its right device and inode, and a file with another | 5 | it changed nothing: the folder, its file, the other file and the record stayed |
| A proof killed with `kill -9` after its first take | 0 | the next run checked the record, removed what it proved, and passed; every user of the earlier record was gone |

The review's two other cases ran against fakes of the Mac only. A process
whose recorded start time no longer matched stayed running at the proof's
normal exit, where version 4 ended it. And with the directory service down,
a run that found an earlier record refused with exit 5, and kept the
recorded folder and the record, where version 4 deleted the folder.
