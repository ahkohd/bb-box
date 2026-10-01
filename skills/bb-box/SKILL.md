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
| `box_acquire` | `kind?`, `wait?` | Makes a box and waits until it answers. `kind` defaults to `linux`. |
| `box_list` | | Lists the thread's boxes and the kinds on offer. |
| `box_status` | `box` | Shows one box, checking its power state with the backend. |
| `box_run` | `box`, `command`, `cwd?`, `timeout_seconds?`, `stdin?`, `desktop?` | Runs a shell script as the box user and returns the exit code, stdout and stderr. |
| `box_copy` | `box`, `direction`, `from`, `to?` | Copies one file between the thread's workspace and a box: `to_box` or `from_box`. |
| `box_stop` | `box` | Stops a box and keeps its disk. |
| `box_start` | `box` | Starts a stopped box again. |
| `box_release` | `box` | Releases a box. Its disk is deleted. |
| `computer_windows` | `box` | Lists the windows on a desktop box's screen, with their IDs. |
| `computer_observe` | `box`, `window`, `query?`, `limit?`, `screenshot?` | Reads a window's accessibility tree, with a reference such as `e12` for each element you can act on. |
| `computer_screenshot` | `box`, `window?` | Returns an image of a window, or of the whole desktop by default. |
| `computer_act` | `box`, `action`, `ref?`, `window?`, `x?`, `y?`, `value?`, `direction?`, `amount?`, `keys?` | Clicks, double-clicks, right-clicks, scrolls or sets a value, on a reference or at pixels, or presses `keys` with action `key`, and says what changed. |
| `computer_type` | `box`, `text?`, `keys?`, `ref?`, `window?` | Types text, or presses a key or chord such as `ctrl+a`, and says what the element reads afterwards. `window` can be `"desktop"`. |
| `computer_launch` | `box`, `app?`, `url?` | Opens an app or a URL and says which windows it opened. |

`box` is the box's name or ID.

Limits:

- `box_run` waits 600 s by default and 3600 s at most, then stops the
  command and everything it started. It keeps 32 KiB of each stream: the
  first 16 KiB and the last 16 KiB.
- `box_run` returns when the script's shell exits, even while something it
  started keeps running. What that writes afterwards is not captured. Start
  a server in the background with its output redirected,
  `nohup <cmd> >server.log 2>&1 &`. Without the redirect, the server's
  writes fail once `box_run` returns, and it may stop answering.
- A command that exits with a non-zero code is not a tool error. A command
  that times out is.
- `box_copy` moves one file of up to 16 MiB. Tar a directory first. A
  relative workspace path is under the thread's workspace directory. A
  relative box path, or one that starts with `~/`, is under the box user's
  home.
- The box user can use `sudo` without a password.
- Each command reads `~/.config/bb-box/env`, which sets `BB_BOX_ID`,
  `BB_BOX_NAME`, `BB_BOX_KIND` and `BB_THREAD_ID`, and `BB_HOST_ID` once the
  box is a BB machine.

## Kinds

`bb box kinds` and `box_list` show what the backends offer. The Proxmox LXC
backend offers:

- `linux`: a Linux box without a desktop
- `linux-docker`: the same, with Docker
- `linux-desktop`: a desktop with a GPU
- `linux-desktop-cpu`: a desktop without a GPU

A kind is on offer only when its templates are set. The earlier IDs
`linux-headless` and `linux-headless-docker` still work in `box_acquire`, as
`linux` and `linux-docker`.

Its boxes run Ubuntu 24.04 with build tools, Git, Python with `uv`, Node.js
with pnpm and Yarn, Docker, `gh`, `rg`, `fd`, `jj` and the Claude Code, Codex
and Pi CLIs. `sudo apt-get install -y <package>` works at once; if apt
answers 404 Not Found, run `sudo apt-get update` and try again. Desktops add
XFCE, Chrome, Mousepad, Ristretto, Evince and CJK fonts.

A `linux-desktop` box always has its GPU. One whose desktop started without
it is released and made again on another GPU; when no GPU is left, the
refusal suggests `linux-desktop-cpu`. `box_status` shows each desktop's GPU,
display mode and the reason for it.

## Desktops

A person can watch each desktop box live from the panel and take control of
its keyboard and mouse. While they hold control, their input goes to the box
and nobody else's does. Control goes back to the agent when they hand it
back or close the viewer for a minute.

## Computer use

The `computer_` tools drive the apps on a desktop box. Read a window as text
with `computer_observe` first, and act on its references. Take an image with
`computer_screenshot` only when appearance matters.

- A reference stays valid while its element is on screen, including after
  you type into it and its name changes. When the element has gone, the tool
  says so; observe the window again. When its name changed where you did not
  see it, the first action on it is refused with the new name: act again if
  it is still the one you want.
- `limit` counts lines of the tree. A web page can be long: pass `query` to
  see only the lines you need.
- Pixels count only in your latest image of that window, or of the desktop.
  No image is longer than 1568 pixels on either edge, so an image can be
  smaller than the screen. Each image and pixel action states the image's
  size, the window's or screen's size and the scale between them.
- A pixel action on the desktop says which windows opened, closed or
  changed. It reads the tree of the window under the point only when that
  tree is small; otherwise it says so. When it finds no change, take a
  screenshot to see what happened.
- An action that opens a menu or popup says so, with the menu's items and
  their references, and says when it closes. Some apps' menu items show in
  their window's tree instead: the result says so. A menu never becomes the active
  window: press keys in it, such as Escape, with its window ID or window
  `"desktop"`.
- Input goes in the background first. When the app refuses it there,
  bb-box uses the real pointer or keyboard, and the result says so: the
  desktop's focus may have moved.
- A URL opened in a browser that is already open waits up to 10 s for the
  page's title.
- Of two windows of one app a few pixels apart, the desktop reads one's tree
  for both. bb-box then moves the window you read a little way, and says so.
  It cannot move a maximised window: un-maximise or close one of the two.
- While a person holds control, every computer tool refuses at once. After
  they hand back, references and images are gone: observe again.

## BB machines

When `enrol-boxes` is on, a ready box is added to BB as a machine, so threads
and terminals can use it and BB's own secrets and Git credentials reach it.
This takes a few seconds after the box is ready; `box_acquire` and `box_run`
wait up to 10 s for it, and `box_status` shows how long it took.
`bb plugin logs bb-box` shows how long each step of it took.
bb-box removes the machine before it releases the box.

In a Linux box that is a BB machine, each command takes `GH_TOKEN` and BB's
machine variables, for the system and for the thread's project, from BB's
daemon in the box as it starts, so a change in BB reaches the next command.
The values are never written to disk. The box's `~/.bashrc` reads the env
file first, so SSH commands from the thread's machine get them too, and `git`
uses `gh` for GitHub credentials.

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
| `bb box install-id` | Shows this install's ID, which it records on its guests. `--set <id>` takes back the ID it had before it lost its storage, once no box holds a guest. |

## The panel

The Boxes thread panel lists the thread's boxes. It makes a box of any kind
and stops, starts, checks and releases boxes. For a desktop box it opens the
desktop in a panel tab of its own or in a new browser tab, and shows who has
control. The Desktops page lists every desktop box. The Backends section in
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
- Every 3 minutes a sweep releases the boxes of threads that BB says were
  archived or deleted. It removes guests that bb-box made that name no box,
  or whose box now has another guest.
- A guest whose record was lost, as when bb-box loses its storage, keeps
  running. The sweep restores its box from the guest's labels while its
  thread is live, and releases it only once BB says the thread ended. When
  `enrol-boxes` is on, a restored box is a BB machine again once it runs
  and answers. If the thread ended first, the guest goes, but its BB
  machine stays until someone removes it in BB.
  `bb plugin logs bb-box` shows each guest the sweep released, restored or
  kept, and why.
- The sweep also finishes acquires and releases that a restart interrupted.
- Each install records its ID on its guests and acts only on those. A guest
  of another install, or with no ID, is left alone but still takes capacity.
  The doctor counts them per install ID. An install that lost its storage
  starts with a new ID: take the old one back with
  `bb box install-id --set <id>` and run `bb box sweep`.
- A box whose guest was deleted, or whose guest's reference now holds
  another box, shows as gone. Releasing it leaves the other box alone.
- A thread whose state BB cannot read keeps its boxes. Only BB's "thread
  not found", or a thread BB returns archived or deleted, ends a thread.
- Boxes do not expire.
