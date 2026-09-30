# 017: Boxes clear BB's daemon lock and PID file at boot

Status: accepted, 30 September 2026. Extends
[014](014-enrol-through-machine-providers.md).

## Context

The [enrolment measurements](../research/enrolment-and-warm-pools.md) timed
a box that restarts after a hard stop, which is how Proxmox LXC's `stop`
works and how a Docker box's daemon ends. BB's host daemon leaves two files
in its data directory:

| File | What goes wrong after the restart | Measured |
| --- | --- | --- |
| `daemon.lock.lock`, the daemon's lock | the daemon waits until the lock is 10 s old, so a quick restart waits most of that | 7.5 to 8.8 s |
| `install-daemon.pid`, written where there is no service manager | the installer's `--start` finds the old PID in use by another process and stops. In a container, PIDs repeat from boot to boot, so once it fails it fails every time | failed on 4 of 5 restarts in a row |

With both files removed at boot, `--start` returned in 0.47 s and the box
was connected to BB 0.50 s after the restart.

## Decision

Every template and image removes both files at boot, before BB's daemon can
start:

| Where | How |
| --- | --- |
| Linux with systemd | a `systemd-tmpfiles` rule, which runs before any user manager starts |
| Docker images without systemd | the start script, before anything else |
| macOS | a launch daemon that runs at boot, before automatic login (not yet tried) |

The rule for a box user `box`:

```
R /home/box/.bb-machines/*/daemon.lock.lock
r /home/box/.bb-machines/*/install-daemon.pid
```

## Consequences

- After a restart, bb-box calls `bootstrap` again with the same key, as
  [014](014-enrol-through-machine-providers.md) says. It no longer depends on
  PID numbers or a 10 s wait.
- Nothing is removed while a daemon runs, since the rule runs only at boot.
- The conformance suite stops and starts each kind that can, and checks that
  the box is connected to BB again within 3 s of being ready.
- This is asked of BB as well ([BB requests](../bb-requests.md)). When BB's
  installer and daemon handle a reboot themselves, the rule can go.
