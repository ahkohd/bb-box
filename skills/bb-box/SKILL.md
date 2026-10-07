---
name: bb-box
description: Boxes for BB threads, Linux or macOS computers for commands, builds, tests, servers and Docker, and the bb box command to set up, check and clean up their backends.
---

# bb-box

bb-box gives each BB thread its own boxes: computers, Linux or macOS, that
start in seconds. A box belongs to the thread that acquired it, until the
thread releases it or is archived or deleted.

## Agent tools

Every result ends with a `Next:` line that says what to do next.

| Tool | Parameters | What it does |
| --- | --- | --- |
| `box_acquire` | `kind?`, `size?`, `cores?`, `memory_gib?`, `disk_gib?`, `wait?`, `on?`, `image?` | Makes a box and waits until it answers. `kind` defaults to `linux`, and `size` to the kind's default preset. `on` names the provider to use, in the words `box_list` gives after "On:", or a list of them for the first with room among them, in that order (044): only they are tried, and a refusal says why each was out and names the others. Without it, the first with room. `image` is the image the box starts from: a project's image by name, as `box_list` gives them, or `standard`; without it, the box gets this project's image for the kind, if it has one. |
| `box_list` | | Lists the thread's boxes and the kinds on offer, with each kind's images where a project's image covers it: this project's first, the default, then `standard`, then other projects'. |
| `box_status` | `box` | Shows one box, checking its power state with the backend, and why it last stopped when bb-box did not stop it. |
| `box_run` | `box`, `command`, `cwd?`, `timeout_seconds?`, `stdin?`, `desktop?` | Runs a shell script as the box user and returns the exit code, stdout and stderr. |
| `box_job` | `box`, `job` | Gives the exit code and output of a `box_run` command that went on in its box as a job, after 270 s or when bb-box restarted, or the end of its output while it runs. |
| `box_copy` | `box`, `direction`, `from`, `to?` | Copies one file between the thread's workspace or storage folder and a box: `to_box` or `from_box`. |
| `box_stop` | `box` | Stops a box and keeps its disk. Refused while a thread is working on the box, naming it. |
| `box_start` | `box` | Starts a stopped box again. |
| `box_thread` | `box`, `prompt`, `title` | Starts a child thread on a box that is a BB machine, in a worktree of the project cloned onto the box. It is archived with this thread. |
| `box_release` | `box` | Releases a box. Its disk is deleted. Refused while a thread is working on the box, naming it; an idle thread there loses its machine, and the answer names it. |
| `box_image_draft` | `files` | Drafts a project image's script from the project's own files, which you read and pass with their paths: `devcontainer.json` and the Dockerfile it names, a Dockerfile, `.tool-versions`, `mise.toml`, `.nvmrc` or `.node-version`, `.python-version`, `rust-toolchain.toml`, `flake.nix` with `flake.lock`, or `shell.nix`. It returns a script for `.bb/box-setup.sh` with each part commented with its file, a check for `.bb/box-check.sh`, and what it left to you, also at the top of the script. Features standard images have are skipped; languages go through mise for the box user; other features through `bb-box-feature`. What needs the checkout, such as `npm ci`, stays in the thread. |
| `box_image_try` | `kind`, `script`, `check`, `name`, `on`, `keep` | Tries a project image's script as a build runs it, before `box_image_set`: in a new box of the kind's standard image on a backend that builds images (Proxmox LXC or Docker), the script as root with the `BB_BOX_*` variables, the check as the box user, then finalizing, which empties `/tmp`, `/var/tmp` and the caches. A box of the build then runs the check again and the kind's own check. It returns each check's result, the time and the build's last 200 lines, and removes what it made. With `keep: true` it leaves a box of what it built, of the build or, when the script failed, of the build box as the script left it, as one of the thread's boxes to look inside with `box_run`; its build goes when you release the box. Fix the script and try again until every check passes; each try starts clean. In the script, `bb-box-feature <feature> [<option>=<value> ...]` installs a Dev Container feature as a dev container build would, such as `bb-box-feature ghcr.io/devcontainers/features/go:1 version=1.22.5`, with the feature's PATH and variables for the box user. A feature in the project's repository (`./...`) cannot be read by a build: copy its `install.sh` into the script instead. |
| `box_image_set` | `name`, `kinds`, `script`, `check`, `bake`, `script_path`, `check_path` | Sets this thread's project's image: a script run as root on the standard image of its Linux kinds, so the project's boxes start with what it needs. Commit the files as `.bb/box-setup.sh` and `.bb/box-check.sh` and pass their text and paths. Setting it changes every new box of those kinds in the project, so ask the user first unless they asked for it. Each new box of those kinds in the project runs the script as root, then the check as the box user, as it starts and before it is handed over; its details say `Image: <name>`. A failing script or check fails the acquire with its last 20 lines. Once two of its boxes ran the script on a backend within 14 days (`bake: always`: at once), bb-box builds the image there in the background, and later boxes start from the build without running the script: `Image: <name>, baked`. Proxmox LXC and Docker bake; Tart, the SSH host pool and GPU desktops run the script at each start. A changed script runs at start until it is built again. |
| `computer_windows` | `box` | Lists the windows on a desktop box's screen, with their IDs. |
| `computer_observe` | `box`, `window`, `query?`, `limit?`, `screenshot?` | Reads a window's accessibility tree, with a reference such as `e12` for each element you can act on. |
| `computer_screenshot` | `box`, `window?` | Returns an image of a window, or of the whole desktop by default. |
| `computer_act` | `box`, `action`, `ref?`, `window?`, `x?`, `y?`, `value?`, `direction?`, `amount?`, `keys?` | Clicks, double-clicks, right-clicks, scrolls or sets a value, on a reference or at pixels, or presses `keys` with action `key`, and says what changed. |
| `computer_type` | `box`, `text?`, `keys?`, `ref?`, `window?` | Types text, or presses a key or chord such as `ctrl+a`, and says what the element reads afterwards. `window` can be `"desktop"`. |
| `computer_launch` | `box`, `app?`, `url?` | Opens an app or a URL and says which windows it opened. |
| `computer_take_control` | `box` | Takes a desktop back from a person who took control, as their hand-back would. Use it only when they ask you to continue, or the thread makes clear they have finished. |

`box` is the box's name or ID.

Limits:

- `box_run` waits 600 s by default and 3600 s at most, then stops the
  command and everything it started. It keeps 32 KiB of each stream: the
  first 16 KiB and the last 16 KiB.
- `box_run` returns when the script's shell exits, even while something it
  started keeps running. What that writes afterwards is not captured. Start
  a server in the background with its output redirected,
  `nohup <cmd> >server.log 2>&1 &`. Without the redirect, what it writes
  afterwards is lost.
- If bb-box restarts mid-command, as for an update, `box_run` waits up to 60 s
  for the command. One still running then goes on in the box as a job, and
  `box_run`'s error names it: `box_job` gives its exit code and output once it
  ends.
- BB ends a tool call at about five minutes, so `box_run` returns after 270 s.
  A command still running then goes on as a job: the answer names it and gives
  its output so far, and `box_job` gives the rest. On Windows too, since a job
  there starts outside the SSH session, which costs about a quarter of a
  second more per command; a Windows command in the desktop session has no
  job, and is stopped at 270 s with its output so far.
- On Windows, commands run in PowerShell 7, and what a command starts with
  `Start-Process`, `Start-Job` or `cmd /c start` ends with it. Start a
  server with `Start-Detached { <cmd> } server.log` instead, which returns
  its process ID. It gets the command's directory and environment
  variables, but not its PowerShell variables: pass values in `$env:`.
  A GUI program, such as an Electron app, starts the same way, with
  `Start-Detached { & <program> <args> } app.log`: its output reaches the
  log, though PowerShell does not wait for it. For its window to show on
  the desktop, call Start-Detached in a desktop command (`desktop: true`).
- A command that exits with a non-zero code is not a tool error. A command
  that times out is.
- A box can stop without a request, as when its VM crashes. `box_status`
  and the error a tool gives then say when and why. bb-box starts a box
  whose VM crashed again at once, unless it did so less than 10 minutes
  before: call `box_status` after a few seconds.
- `box_copy` moves one file of up to 16 MiB, as BB's file API takes a file
  whole and refuses one over 25 MB. Tar a directory first. Move a larger file
  in parts, as below. A relative workspace path is under the thread's
  workspace directory. A path in the thread's storage folder, absolute or
  starting with `$BB_THREAD_STORAGE/`, is there, both ways. A relative box
  path, or one that starts with `~/`, is under the box user's home.
- `box_status` says whether the box user can use `sudo`, and `box_list`
  says it for each kind. On Proxmox LXC boxes, Docker boxes and SSH host
  pool boxes with Docker it can, without a password; on pool boxes without
  Docker it cannot.
- Each command reads `~/.config/bb-box/env`, which sets `BB_BOX_ID`,
  `BB_BOX_NAME`, `BB_BOX_KIND` and `BB_THREAD_ID`, and `BB_HOST_ID` once the
  box is a BB machine.

### Files over 16 MiB

Plan for a large file, such as an installer or a build artifact, before
copying it: split it into parts of 15 MB, `box_copy` each part, join them on
the other side, and compare hashes. For `big.bin` going into the box:

- On this side: `split -b 15m big.bin big.bin.part-`, then `box_copy` each
  `big.bin.part-*` (`to_box`).
- In a Linux or macOS box, with `box_run`:
  `cat big.bin.part-* > big.bin && rm big.bin.part-*`, then compare
  `sha256sum big.bin` (`shasum -a 256` on macOS) with this side's.
- In a Windows box, with `box_run`:

  ```powershell
  $o = [IO.File]::Create("big.bin"); Get-ChildItem big.bin.part-* | Sort-Object Name | ForEach-Object { $b = [IO.File]::ReadAllBytes($_.FullName); $o.Write($b, 0, $b.Length) }; $o.Close()
  Get-FileHash big.bin
  ```

Coming out of the box, split it there, `box_copy` each part (`from_box`), then
`cat big.bin.part-* > big.bin` on this side. A Linux or macOS box splits with
`split -b 15m big.bin big.bin.part-`; a Windows box with:

```powershell
$i = [IO.File]::OpenRead("big.bin"); $b = New-Object byte[] 15MB; $n = 0; while (($r = $i.Read($b, 0, $b.Length)) -gt 0) { $o = [IO.File]::Create(("big.bin.part-{0:d3}" -f $n++)); $o.Write($b, 0, $r); $o.Close() }; $i.Close()
```

`box_copy`'s error for a file too large gives the same commands, with the
file's own name.

## Kinds

`bb box kinds` and `box_list` show what the backends offer, and each kind's
line ends with its providers in acquire order ("On: Proxmox LXC on pve1,
Docker on devpc"), the words `box_acquire`'s `on` takes (044). The kinds:

- `linux`: a Linux terminal box, with Docker (041), from Proxmox LXC, Docker
  or an SSH host pool
- `linux-desktop`: a Linux desktop on a GPU; `linux-desktop-cpu`: one drawn
  by the CPU
- `linux-desktop-wayland-cpu`: a Linux desktop on Wayland (Sway), drawn by
  the CPU, for apps built for Wayland; X11-only apps do not run there
- `linux-arm64` and `linux-arm64-desktop-cpu`: the same on arm64, as VMs on
  a Mac with Apple silicon (040)
- `macos` and `macos-desktop`: macOS VMs on a Mac
- `windows-desktop`: a Windows 11 desktop VM on Proxmox; commands run in
  PowerShell; not a BB machine yet
- `windows-arm64-desktop`: the same on arm64, as a VM on a Mac with Apple
  silicon (046); x64 apps run under Windows' emulation, more slowly

Windows boxes have build tools: Visual Studio Build Tools (MSVC and the
Windows SDK), LLVM (`clang`) and Rust (`cargo`, `rustc`, stable MSVC). They
have no GPU: DirectX apps, GPUI's included, render on WARP, Windows' software
renderer, smoothly at the box's screen size.

Both Linux desktops are labelled "Linux desktop" in `box_list`, `bb box
kinds` and `box_status`, with "(GPU)" after the GPU one; the panel names
every kind by its OS and shows Desktop, GPU, arm64 and the rest as badges.

Every Linux box has Docker, so `linux-docker` and `linux-arm64-docker` are
aliases of `linux` and `linux-arm64` that insist on it: an offer without
Docker (an SSH pool machine without a whole-machine reset, a Docker box on
rootless Docker) is skipped for them, and `box_list` says "Docker: no"
where that is so. The earlier IDs `linux-headless` and
`linux-headless-docker` still work in `box_acquire`. A kind is on offer only
when a backend that is on has it set up. A Docker box runs no systemd, so
`systemctl` does not work in it.

Its boxes run Ubuntu 24.04 with build tools, Git, Python with `uv`, Node.js
with pnpm and Yarn, Docker, `gh`, `rg`, `fd`, `jj` and the Claude Code, Codex
and Pi CLIs. `sudo apt-get install -y <package>` works at once; if apt
answers 404 Not Found, run `sudo apt-get update` and try again. Desktops add
XFCE, Chrome, Mousepad, Ristretto, Evince and CJK fonts.

A `linux-desktop` box always has its GPU. One whose desktop started without
it is released and made again on another GPU; when no GPU is left, the
refusal suggests `linux-desktop-cpu`. `box_status` shows each desktop's GPU,
display mode and the reason for it.

## Sizes

A box's size is chosen when it is made. Each kind has three presets. These
are bb-box's own; bb-box's configuration can change them, and `box_list`
and `bb box kinds` show the ones in use:

| Kind | small (the default) | medium | large | largest custom size |
| --- | --- | --- | --- | --- |
| `linux`, `linux-arm64` | 2 cores, 4 GiB | 4 cores, 8 GiB | 8 cores, 16 GiB | 16 cores, 32 GiB, 256 GiB disk |
| `linux-desktop`, `linux-desktop-cpu`, `linux-desktop-wayland-cpu`, `linux-arm64-desktop-cpu`, `windows-desktop`, `windows-arm64-desktop` | 4 cores, 8 GiB | 8 cores, 16 GiB | 16 cores, 32 GiB | 32 cores, 64 GiB, 256 GiB disk |
| `macos`, `macos-desktop` | 4 cores, 8 GiB | 6 cores, 16 GiB | 8 cores, 32 GiB | 16 cores, 64 GiB, 256 GiB disk |

A preset keeps the kind's own disk. For a custom size, give `cores`,
`memory_gib` or `disk_gib`; the parts you leave out come from `size`, or
from the default preset. A size above the largest is refused. A backend that
cannot make a size says so, and bb-box tries the next backend that offers
the kind. `box_status` shows the size the box has, read from its guest. The
SSH host pool lends the smallest free machine of at least the size, so its
box may have more. A Tart macOS or Linux box keeps its image's disk, so
Tart refuses it a `disk_gib` for now. A Docker box shares its host's disk,
so Docker refuses one too.

`bb box acquire <kind>` takes `--size`, `--cores`, `--memory-gib` and
`--disk-gib`.

A kind can keep spare boxes: boxes made and added to BB ahead, at the kind's
default size, that no thread owns yet. An acquire of the kind at its default
size takes a spare when there is one, so the box is ready, with the thread's
access, at once, and bb-box makes another spare. Any other size makes a new
box. When no backend has room for a thread's box, bb-box releases a spare
there to make room, as on a Mac, where a spare holds one of its two VM
slots. Another spare is made once there is room. BB lists a spare as a
machine named "<name> (spare)", and the machine takes the box's name when a
thread takes it.

## Desktops

A person can watch each desktop box live from the panel and take control of
its keyboard and mouse. While they hold control, their input goes to the box
and nobody else's does. Control goes back to the agent when they hand it
back or close the viewer for a minute, and the desktop gets back the size it
had before they took control. A reload or update of bb-box keeps their
control if the viewer connects again within a minute, as it does by itself. The agent can also take it
back with `computer_take_control`; their viewer then says "The agent took
control", and they can take it again at any time.

`box_run` with `desktop` starts the command in the desktop session, so it
can open windows, as when you test an app. On a Mac, only such a command
reaches the login keychain, which git's keychain helper and Xcode's signing
use. On Windows, it runs unelevated, as an app you open does, and returns
its output when it exits. What it opens with `Start-Process` stays open.

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
- On Windows, `computer_windows` lists only windows with a title: give the
  windows of an app you write one. An app that draws everything itself,
  such as a GPUI app, has no accessibility tree: `computer_observe` shows
  only its frame, so drive it with `computer_screenshot` and pixel actions.
- While a person holds control, every computer tool refuses at once. Wait,
  or call `computer_take_control` once they ask you to continue or have
  clearly finished. Either way, references and images are gone: observe
  again.

## BB machines

When enrolment is on, a ready box is added to BB as a machine, so threads
and terminals can use it and BB's own secrets and Git credentials reach it.
This takes a few seconds after the box is ready; `box_acquire` and `box_run`
wait up to 20 s for it, and `box_status` shows how long it took. A box you
start again joins BB again, and `box_start` and `box_run` wait for that too.
If BB's daemon stops as the box joins, as in a box with too little memory,
`box_status` says the enrolment failed and why.
`bb plugin logs bb-box` shows how long each step of it took.
bb-box removes the machine before it releases the box.

In a Linux or macOS box that is a BB machine, each command takes `GH_TOKEN`,
your git identity and BB's machine variables from BB's daemon in the box as it starts, so a change in BB
reaches the next command. The values are never written to disk. The box's
`~/.bashrc`, or `~/.zshenv` on macOS, reads the env file first, so SSH
commands from the thread's machine get them too. `git` uses `gh` for GitHub
credentials, and fetches GitHub's SSH URLs, such as `git@github.com:o/r.git`,
over HTTPS. On
macOS, a value holding a space then `NAME=`, or a backslash then three
digits, can read wrongly.

A variable set for a project, not for every project, reaches a box only
while a thread of that project runs on it, as with `box_thread` or a thread
started on a new box. BB gives a project's variables only to the threads
of that project, so a box your thread uses from another machine does not
have them. A command that needs one can run in a thread on the box.

## The bb box command

Commands about a thread's boxes use the thread they run in, or `--thread <id>`.
Most take `--json`.

| Command | What it does |
| --- | --- |
| `bb box doctor` | Checks each backend's settings, host and templates, and says how to fix what is wrong. Exits 1 when a check fails. |
| `bb box kinds` | Lists the kinds on offer. |
| `bb box list` | Lists the thread's boxes. `--all` lists every thread's boxes. |
| `bb box acquire <kind>` | Makes a box and waits for it. `--no-wait` returns at once. `--image <name>` or `--image standard` chooses its image. |
| `bb box status <box>` | Shows one box. |
| `bb box thread <box> --prompt <text>` | Starts a child thread on a box, as `box_thread` does. |
| `bb box release <box> [--force]` | Releases a box. A box a thread is working on needs `--force`. |
| `bb box sweep` | Runs the clean-up now. |
| `bb box install-id` | Shows this install's ID, which it records on its guests. `--set <id>` takes back the ID it had before it lost its storage, once no box holds a guest. |
| `bb box image try <name> [--kind <kind>] [--on <backend>]` | Tries an image already set, as `box_image_try` does, on its first kind or the one given. Exits 1 if a check failed. |
| `bb box image set <name> --kinds <kinds> --script-file <file> [--check-file <file>] --project <id> [--bake auto\|always\|never]` | Sets a project's image, as `box_image_set` does, from files. `bb box image list`, `show <name>` and `remove <name>` list, print and remove them; `list` shows each image's builds, and `remove` removes them too. |
| `bb box images list`, `refresh`, `build <image>` | The standard images bb-box rebuilds each night: what is due, a run, and one image now (`--try` checks without replacing). |

## Your machines

You can keep boxes of your own, as ordinary BB machines that no thread owns:
they show in BB's machine list and new-thread picker under the name you give,
and live until you remove them, whatever happens to threads. Add, stop and
remove them in BB Box's settings, or with `bb box machines`, `bb box machines
add <kind> [--name <name>]` and `bb box machines remove <name>`. Any kind that
can become a BB machine works, desktops included. A machine a thread is
working on is removed only when you confirm, or with `--force`. A spare box
that someone starts a thread on from BB's picker becomes one of your machines
as soon as the thread starts working, even a spare that has stopped.

## A thread on its own box

In BB's new-thread screen, "New box" starts a thread on a box of its own: pick
the kind and size, and BB clones the project onto the box. It serves projects
with a Git remote. The box is the thread's machine: `box_list` and the panel
say so, it does not count against the per-thread limit, and it is released
when the thread is archived or deleted.

BB lists "New box" at the end of the Environment picker's Machines list, which
scrolls: with several machines it is below the fold. Scroll that list down,
or type "new" in the picker's search, which leaves it alone in the list.

From a terminal, `bb thread spawn` can start one too: `bb environment
providers` lists it as `bb-box-new`, with inputs such as `{"kind": "linux"}`.
Give `--model` when the project has no remembered model, since the new box
cannot list models until it exists.

## A project's image

A project's image is a script run as root on the standard image of its Linux
kinds, so its boxes start with what it needs. A person never writes it: when
asked to "make a box image for this project", or sent by New box's "Ask an
agent to make one", follow these steps.

1. **Draft.** Read the project's files and pass them to `box_image_draft`:
   `.devcontainer/devcontainer.json` and the Dockerfile it names, a
   Dockerfile, `.tool-versions`, `mise.toml`, `.nvmrc`, `.python-version`,
   `rust-toolchain.toml`, `flake.nix` with `flake.lock`. For a box someone set
   up by hand, give its name as `box` too.
2. **Finish it.** Settle what the draft left to you, listed in its reply and
   at the top of the script. Keep out of it what needs the checkout, such as
   `npm ci` or `cargo fetch`: a build has no repository. Write the script to
   `.bb/box-setup.sh`, and a check that fails when the script did not do its
   work, such as `cargo --version`, to `.bb/box-check.sh`.
3. **Try it** with `box_image_try`, which builds it in a clean box of the
   standard image, as the build will. Fix and try again until every check
   passes. To look inside, acquire a box, run the script with
   `box_run` and `sudo bash`, and release the box after.
4. **Register it.** Commit the two files, then call `box_image_set` with their
   text and paths. It changes every new box of those kinds in the project, so
   ask the user first unless they asked for the image. bb-box runs the script
   as each box starts, and builds the image ahead once it is used.

## The panel

The Box thread panel lists the thread's boxes as rows: name, the OS, badges
(Desktop, GPU, arm64, and LXC, Container, VM or Physical for what the box
is), state, timings (the acquire's, and the last start's)
and whether the box is a BB machine. A row opens to its details. A thread that runs on a box's machine (one of
your machines, or another thread's) sees that box first, under "This thread
runs on it", with no Release or Stop: those are in settings, or the holding
thread's. The plus
button, "New box", makes a box of any kind, chosen by steps (the system,
the architecture, server or desktop, the provider and the size); each row's
actions stop, start, check and release it (release asks first). A desktop
box opens in a panel tab of its own, or in a browser tab, which shows who
has control. "Open terminal" opens a shell in a running box in a tab of its
own, "Terminal: <box>"; the shell runs over the box's transport with its
PTY on BB's server, stays while the tab is away, and ends after ten minutes
with no tab, when it exits, or when the box stops. The panel keeps each
desktop's and terminal's connection for ten minutes across tab switches,
so switching back is instant; a hidden tab that holds a desktop's control
hands it back after a minute. The Desktops page lists every desktop box.
The design is in `docs/design/panel.md`.

BB Box's settings page in BB has four parts: Your machines, boxes you own
kept as BB machines, each with its threads and actions, and "Add machine";
Backends, each with a switch,
its state in words and a setup area with the driver's fields, hosts,
write-only secrets and a check that runs the doctor against the form;
Kinds, each with a switch, its presets, largest size, warm counts and
spares;
General, the default kind, boxes per thread and enrolment; and Files for
every box. The design is in `docs/design/settings.md`.

## Configuration

bb-box's configuration is one document, which bb-box checks before every
write. Its settings page in BB edits it, and so does the CLI:

| Command | What it does |
| --- | --- |
| `bb box config show` | Shows the configuration. Secrets show only as set or not set. |
| `bb box config show --json` | Prints it as a file, with no secret in it: keep it to set bb-box up again. |
| `bb box config check <file> [--test]` | Checks a file without saving it. `--test` also runs the doctor of each backend in it that is on. |
| `bb box config apply <file> [--replace]` | Saves the file as the whole configuration. `--replace` saves over it whatever revision the file names, as when setting bb-box up again from an export. |
| `bb box config migrated [--remove]` | Shows, or removes, the copy of BB's settings bb-box kept when it moved them into the configuration. |

The file is read on the machine BB's server runs on, and a relative path is
from where you run `bb`. A `revision` in the file must be the current one;
leave it out to apply over what is there. In the file, give a secret as a
string to set it, `null` to clear it, or `{"set": true}` to keep it.

The document has three parts:

- `backends`: the backends, in the order bb-box tries them. Each has an `id`
  (its type, such as `proxmox-lxc`), its `type`, `enabled`, its `fields`,
  and `warm`, the ready boxes to keep per kind.
- `kinds`: each kind's `enabled`, its `presets` (`small`, `medium` and
  `large`, each with `cores`, `memoryMiB` and `diskGiB`, where `null` keeps
  the kind's own disk), its `default` preset, its `largest` custom size and
  `spares`, the boxes to keep ready and enrolled for the next acquire at the
  default size (0 to 10, 0 by default). Parts left out keep bb-box's own.
- `general`: `boxesPerThread` (0 means no limit), `enrol` (adds ready boxes to
  BB as machines, `true` by default), `defaultKind` (`linux` by default) and
  `files`, the files for every box: each a `path` under the box user's home
  and its `content`, a secret.

For example:

```json
{
  "backends": [{ "id": "proxmox-lxc", "type": "proxmox-lxc", "enabled": true, "fields": { "url": "https://192.0.2.10:8006" }, "warm": { "linux": 1 } }],
  "kinds": { "linux": { "default": "medium", "presets": { "large": { "cores": 12, "memoryMiB": 24576 } }, "largest": { "diskGiB": 512 } } },
  "general": { "boxesPerThread": 4 }
}
```

Files for every box carry the config a provider reads from its machine, which
BB does not carry there, such as pi's `.pi/agent/models.json` with its custom
providers and models. bb-box writes each into the home of every Linux and
macOS box as it joins BB or starts again, and into running boxes when the list
or a content changes, readable by the box user only and written over what the
box has. A file taken off the list stays in the boxes that have it. Windows
boxes get none yet. A content can hold an API key, so it is a secret:
write-only, and in no log, error or tool output. `bb box doctor` says how many
are set and whether the last write worked.

Turning a backend or a kind off stops new boxes only: boxes already made keep
working and can be released. A backend that is on, or has boxes, cannot be
saved with problems; one that is off and has none can, so its setup can stop
part way. A backend with boxes cannot be removed. `setup/proxmox-lxc/README.md`
explains how to set up a Proxmox host, and its section 7 lists every field.
`setup/docker/README.md` does the same for Docker.

A backend refuses a new box when the host would fall below its memory or disk
reserve, cannot make the size asked for, or has no free address or GPU. The
refusal says what to do instead.

Saving the configuration tops the warm pools up at once, rather than at the
next sweep. A warm pool left below its count because no host has room for
another says why: `bb plugin logs bb-box` has a line when it falls short,
when the reason changes and when it has room again, and `bb box doctor`
warns of it.

## Clean-up

- When a thread is archived or deleted, bb-box asks BB about the thread,
  and releases its boxes at once when BB returns it archived or deleted.
  When BB finds no such thread, the next sweep releases them if BB still
  finds none. While BB says the thread is live, or cannot say, they stay.
- Every 3 minutes a sweep releases the boxes of threads that BB says were
  archived or deleted at that sweep and the one before. One answer is not
  enough, so a box goes at the second sweep. It removes guests that bb-box
  made that name no box, or whose box now has another guest.
- Every release logs one line in `bb plugin logs bb-box` saying why: the
  tool, the panel, the CLI, the thread ending, trimming spares or making
  room for another box.
- A guest whose record was lost, as when bb-box loses its storage, keeps
  running. The sweep restores its box from the guest's labels while its
  thread is live, and releases it only once BB says at two sweeps that the
  thread ended. When enrolment is on, a restored box is a BB machine again
  once it runs and answers. A thread's own box from "New box" is that thread's BB
  machine again, as BB still has it. If the thread ended first, the guest
  goes, but its BB machine stays until someone removes it in BB.
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
  The log gives BB's answer each time bb-box keeps or releases boxes for
  this.
- Boxes do not expire.
