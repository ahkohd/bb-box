# 095 results: box_grant on a Namespace Mac

Measured on 11 November 2026, on a small Namespace Mac (4 cores, 14 GB
memory), with macOS 26.3.1, as the user `runner`. The Mac was a `macos`
box, with no desktop shown.

## What the Mac is like

| What | Found |
| --- | --- |
| `csrutil status` | System Integrity Protection status: disabled |
| `sudo` | no password |
| System database | `/Library/Application Support/com.apple.TCC/TCC.db`, readable and writable by root |
| User database | `~/Library/Application Support/com.apple.TCC/TCC.db`, which `runner`'s `tccd` has open |
| `access` table | 17 columns: macOS 27's 19 without `one_time_reprompt_eligible` and `reminder_count` |
| `box_run`'s commands | children of `/opt/namespace/vmguest`, a root daemon, in the system's security session, whose keychain search list is the System keychain alone |
| Audio input | none, until BlackHole 2ch was installed with Homebrew and `coreaudiod` restarted |

The helper on main refused every grant there, with exit code 1: "TCC's
database is not as bb-box knows it on macOS 27, so it writes nothing there."

## The grants

The helper from this change ran as Namespace's backend runs it:
`sudo -n /bin/sh -c '<machine-mac.sh>' machine vm-ready "$(id -un)"`.

- `vm-ready` took 0.4 s and said `sip=0`, `tcc=1`, `macos=26.3.1` and
  `signing=1`.
- The probes: an app, `GrantProbe.app` (bundle ID `dev.example.grantprobe`),
  and a command-line program, `~/bin/micprobe`, both signed with "bb-box
  local code signing". Signing worked only in `runner`'s session, through
  `sudo launchctl asuser "$(id -u)" sudo -u "$(id -un)" codesign ...`:
  run straight from `box_run`, `codesign` found no identity.
- `vm-grant` gave the app Accessibility and Screen Recording, by bundle ID
  with its requirement (`identifier "dev.example.grantprobe" and
  certificate leaf = H"..."`), in the system database, and replaced the
  denied rows macOS had written when the app first asked. It gave the
  program the microphone, by path with its requirement, in the user's
  database.

| Probe | How it was started | Before the grant | After the grant |
| --- | --- | --- | --- |
| App | `open`, from `box_run` | `AXIsProcessTrusted` false; `CGPreflightScreenCaptureAccess` false; ScreenCaptureKit: "The user declined TCCs for application, window, display capture" | `AXIsProcessTrusted` true; reading the Dock's accessibility children succeeded; `CGPreflightScreenCaptureAccess` true; ScreenCaptureKit listed 12 windows. No prompt |
| App, rebuilt | `open`, after a new build signed with the same identity, so a new cdhash | | the same as above: the grant held |
| App | run directly by `box_run` | | `AXIsProcessTrusted` false: charged to Namespace's agent, not the app |
| Program | `launchctl submit` in `runner`'s session | | microphone status 3, authorised; recorded 2 s from BlackHole 2ch, 201 buffers, 102,912 frames. No prompt |
| Program | run directly by `box_run` | microphone status 2, denied: "Cannot use BlackHole 2ch" | |

`launchctl submit` straight from `box_run` failed, with exit code 1: the
command is outside `runner`'s launchd session.

The Mac had no display for ScreenCaptureKit, so the check stopped at its
permission: capturing a window there failed in macOS's display lookup,
granted or not.

## Through BB Box's code

The branch's `MacVmHelper` and the doctor's check, run on the Mac with
Node 25 and a command runner in place of SSH, said:

- `ready`: can grant, macOS 26.3.1, signing identity made;
- the app's and the program's grants, as above;
- `/usr/bin/say`: refused, as it is not in the user's home or
  `/Applications`;
- `/Applications/Safari.app`: refused, as it is Apple's;
- `grants`: the 3 grants, and nothing blocking;
- the doctor's check: "box_grant works: System Integrity Protection is off
  and TCC's database is one BB Box knows (macOS 26.3.1)."

Before the change, BB Box's `box_grant` on the same box answered:
"Namespace cannot grant macOS permissions: only Tart's macOS boxes and
Macs of the SSH host pool with SIP off can."

## Not measured

- A Namespace Mac with SIP on, or with a TCC schema the helper does not
  know: none was available. The tests cover both refusals, with the fake
  Mac and the fake helper.
- A Namespace backend in a separate BB acquiring the Mac: the live check
  ran the branch's helper and TypeScript on a Mac acquired from another
  BB, as a separate BB would need a Namespace token of its own.
