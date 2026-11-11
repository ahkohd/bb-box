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
