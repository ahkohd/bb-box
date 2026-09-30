---
name: bb-box
description: Use bb-box to give a BB thread fresh Linux boxes for commands, builds, tests, servers and Docker, and to set up, check or clean up bb-box's backends with the bb box command.
---

# bb-box

bb-box gives each BB thread its own boxes: small Linux computers that start
in seconds. A box belongs to the thread that acquired it. It stays until the
thread releases it, or until the thread is archived or deleted.

## Agent tools

Every result ends with a `Next:` line that says what to do next.

| Tool | Parameters | What it does |
| --- | --- | --- |
| `box_acquire` | `kind?`, `wait?` | Makes a box and waits until it answers. `kind` defaults to `linux-headless`. |
| `box_list` | | Lists the thread's boxes and the kinds on offer. |
| `box_status` | `box` | Shows one box, checking its power state with the backend. |
| `box_run` | `box`, `command`, `cwd?`, `timeout_seconds?`, `stdin?`, `desktop?` | Runs a shell script as the box user and returns the exit code, stdout and stderr. |
| `box_copy` | `box`, `direction`, `from`, `to?` | Copies one file between the thread's workspace and a box: `to_box` or `from_box`. |
| `box_stop` | `box` | Stops a box and keeps its disk. |
| `box_start` | `box` | Starts a stopped box again. |
| `box_release` | `box` | Releases a box. Its disk is deleted. |

`box` is the box's name or ID.

Limits:

- `box_run` waits 600 s by default and 3600 s at most. It keeps 32 KiB of
  each stream: the first 16 KiB and the last 16 KiB. Start a server in the
  background with `nohup`.
- A command that exits with a non-zero code is not a tool error. A command
  that times out is.
- `box_copy` moves one file of up to 16 MiB. Tar a directory first. A
  relative workspace path is under the thread's workspace directory. A
  relative box path, or one that starts with `~/`, is under the box user's
  home.
- The box user can use `sudo` without a password.
- Once a box is a BB machine, each command reads `~/.config/bb-box/env`,
  which sets `BB_BOX_ID`, `BB_BOX_NAME`, `BB_BOX_KIND`, `BB_THREAD_ID` and
  `BB_HOST_ID`.

## Kinds

`bb box kinds` and `box_list` show what the backends offer. The Proxmox LXC
backend offers:

- `linux-headless`: a Linux box without a desktop
- `linux-headless-docker`: the same, with Docker
- `linux-desktop`: a desktop with a GPU
- `linux-desktop-cpu`: a desktop without a GPU

A kind is on offer only when its templates are set.

## BB machines

When `enrol-boxes` is on, a ready box is added to BB as a machine, so threads
and terminals can use it and BB's own secrets and Git credentials reach it.
bb-box removes the machine before it releases the box.

## The bb box command

Commands about a thread's boxes use the thread they run in, or `--thread <id>`.
Most take `--json`.

| Command | What it does |
| --- | --- |
| `bb box doctor` | Checks each backend's settings, host and templates, and says how to fix what is wrong. Exits 1 when a check fails. |
| `bb box kinds` | Lists the kinds on offer. |
| `bb box list` | Lists the thread's boxes. `--all` lists every thread's boxes. |
| `bb box acquire <kind>` | Makes a box and waits for it. `--no-wait` returns at once. |
| `bb box status <box>` | Shows one box. |
| `bb box release <box>` | Releases a box. |
| `bb box sweep` | Runs the clean-up now. |

## The panel

The Boxes thread panel lists the thread's boxes. It makes a box of any kind
and stops, starts, checks and releases boxes. The Backends section in
bb-box's settings shows each backend's state and what it still needs, and
runs the doctor.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `boxes-per-thread` | `0` | The most boxes one thread may hold. 0 means no limit. |
| `enrol-boxes` | `true` | Adds ready boxes to BB as machines. |

Each backend's settings start with its name, for example `proxmox-lxc-url`.
`setup/proxmox-lxc/README.md` explains how to set up a Proxmox host, and its
section 7 lists every `proxmox-lxc-` setting.

A backend refuses a new box when the host would fall below its memory or disk
reserve, or has no free address or GPU. The refusal says what to do instead.

## Clean-up

- When a thread is archived or deleted, bb-box releases its boxes.
- Every 3 minutes a sweep releases the boxes of ended threads. It removes
  guests that bb-box made but no box owns, and rebuilds the record of a
  guest whose thread is still live.
- The sweep also finishes acquires and releases that a restart interrupted.
- A thread whose state BB cannot read keeps its boxes.
- Boxes do not expire.
