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
stops, and the resume reached only the user's own processes. The take now
resumes every process that stopped during its pause, again 0.2 s later, and
the second run passed.

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
