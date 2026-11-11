# 095: Namespace's Macs grant macOS permissions through the Mac helper

Status: accepted
Date: 11 November 2026

Extends [058](058-a-mac-with-sip-off-grants-its-box-users-macos-permissions.md)
from pool Macs and Tart's macOS VMs to Namespace's Macs. Measurements are in
[095-results.md](095-results.md).

## Context

058 lets a Mac with System Integrity Protection off grant its box users'
programs the permissions macOS would ask a person for. The pool Mac's
helper, `setup/ssh-pool/machine-mac.sh`, writes the grants, and a Tart
macOS VM runs the same helper as its own box (`vm-ready`, `vm-grant`,
`vm-granted`).

Namespace's Macs had no `box_grant`. An agent on one stopped at macOS's
prompt, or asked a person to approve it in the desktop's viewer. Yet
Namespace's Macs run with SIP off, `runner` can use `sudo` with no password,
and root can read and write both TCC databases. BB Box already writes TCC
rows there for its desktop and Cua Driver.

Namespace's image differs from Tart's in ways that matter here:

- It runs macOS 26, whose TCC `access` table has 17 columns. The helper
  knew only macOS 27's 19, so it would have refused every grant.
- `box_run`'s commands run under Namespace's own agent,
  `/opt/namespace/vmguest`, a root daemon, not under `sshd`. They are
  charged to that agent, and run in the system's security session, where
  `runner`'s keychains are not on the search list.
- A future Namespace image could turn SIP on, or move to a macOS whose
  database BB Box does not know. BB Box cannot choose the image.

## Decision

**A Namespace Mac box runs the Mac helper as Tart's macOS VMs do, and BB
Box measures, per Mac, whether it can grant.**

1. **One writer.** Namespace runs the helper's `vm-ready`, `vm-grant` and
   `vm-granted` for `runner`, through `sudo`, as Tart does. Both backends
   share the code that runs it (`src/backends/mac-vm-helper.ts`). There is
   no second writer.
2. **The helper knows macOS 26's schema** as well as macOS 27's: the 17
   columns it writes, with or without macOS 27's 2 more. It refuses any
   other schema with exit code 7, the same as SIP on, and a reason that
   says what to do. It writes nothing then.
3. **It says whether it can grant.** `vm-ready`, `vm-granted` and the pool's
   `granted` print `sip=`, `tcc=` (1 when the system database is one it
   knows) and `macos=`. `box_status` says a box cannot grant because SIP is
   on, or because its database is unknown.
4. **Each Mac box's start runs `vm-ready`**, before its desktop is made
   ready: the box's signing identity, and a measurement. The doctor runs
   `vm-granted` again on each Mac box it holds. BB Box keeps what the last
   20 Macs said, across restarts, and the doctor's check **macOS
   permissions on Namespace's Macs** says whether `box_grant` worked on
   them, which macOS they ran, and why any refused.
5. **Shared iOS hosts grant nothing.** A slot's user has no desktop
   session, so there is no program for Accessibility or Screen Recording
   to act for. A grant in the system database is keyed by the program, not
   the user, so it would reach every slot on the host. The core refuses, as
   for other shared hosts, and Namespace's backend refuses too.
6. **What agents are told on Namespace.** As `box_run`'s commands run
   outside `runner`'s session, `codesign` with the box's identity, and
   `launchctl submit` for a granted command-line program, go through
   `sudo launchctl asuser "$(id -u)" sudo -u "$(id -un)"`. `open` works as
   it is. The tool's answer, the skill and the guide say so.

## Consequences

- `box_grant` works on Namespace's `macos` and `macos-desktop` boxes, with
  the same refusals as on Tart: Apple's programs, shells and interpreters,
  programs outside the user's home and `/Applications`.
- A Mac box's start takes about half a second more.
- `box_run`'s commands on Namespace do not get the microphone and the
  camera by default, as they do on Tart and pool Macs: the helper grants
  those to `sshd-keygen-wrapper`, which Namespace does not use. A program
  that needs them is granted, and started on its own.
- If Namespace's image changes, `box_grant` refuses with the reason, and the
  doctor's check turns to a warning that names the macOS it saw.
