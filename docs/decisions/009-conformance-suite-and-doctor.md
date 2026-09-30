# 009: A conformance suite and a doctor check for every backend

Status: accepted, 30 September 2026. Partly superseded by
[016](016-changes-from-building-v1.md): a backend's setup is a guide and the
scripts it runs.

## Context

"Any provider" is only true if every backend behaves the same way under the
core. A second backend written late tends to reveal assumptions the first one
baked in. People trying bb-box will also have different providers, and setup
is where most of them give up.

## Decision

- **Conformance suite.** One suite, in this repository, runs against any
  backend. It is configured from an env file and runs against a live
  backend. For each kind it checks:
  1. capacity reports and refuses correctly;
  2. acquire reaches ready, with claim, starting and timing hooks;
  3. a command runs, and files copy in and out;
  4. the box enrols in BB, if the kind says it can;
  5. the desktop stream connects and returns a frame, if the kind has one;
  6. computer use reads the accessibility tree and acts, if the kind has a
     desktop;
  7. power, stop and start, if the backend supports them;
  8. release, repeated, succeeds, and a missing guest counts as released;
  9. crash recovery: an acquire interrupted mid-way is resumed or released,
     and `held()` finds every guest.
- **Fake backend.** An in-memory backend passes the suite and is what the
  core's own tests use.
- **Early backends.** Docker (virtual) and an SSH host pool (real) come early,
  beside Proxmox LXC, so the interface is tested on three shapes of provider
  before it settles.
- **Setup.** Each backend has a setup script and a short guide. The settings
  page walks through configuring a backend. Each backend's `doctor()` checks
  the setup from end to end and says exactly what is missing and what to do.

## Consequences

- A new backend is done when it passes the suite, not when it runs once.
- The suite needs a BB server to test enrolment. It can skip that step with a
  clear note when none is configured.
- Setup scripts and `doctor` must stay in step with each backend's settings.
- The suite runs by hand or on a schedule against live providers, not on every
  commit.
