---
name: bb-box
description: Boxes for BB threads, Linux or macOS computers for commands, builds, tests, servers and Docker, and the bb box command to set up, check and clean up their backends.
---

# bb-box

bb-box gives each BB thread its own boxes: Linux, macOS or Windows
computers that start in seconds. A box belongs to the thread that acquired
it. It goes when the thread releases it, or a few minutes after the thread
is archived or deleted. Boxes do not expire. Push your work to Git, or copy
it out, before a box goes: its disk goes with it.

Every tool's answer ends with a `Next:` line that says what to do next. The
tools, and each of their parameters, are in the
[tool reference](../../docs/reference/tools.md). This skill says what the
tools do not.

## Choosing a box

`box_list` shows the kinds on offer, their sizes, where each can come from
("On: ..."), and the project's images. The
[kinds reference](../../docs/reference/kinds.md) describes every kind.

- Ask for the kind's default size when you can. A kind can keep spare boxes
  ready at that size, and then a box is ready at once.
- Linux boxes run Ubuntu 24.04 with build tools, Git, Python with `uv`,
  Node.js with pnpm and Yarn, Docker, `gh`, `rg`, `fd`, `jj`, and the Claude
  Code, Codex and Pi CLIs. Desktops add XFCE, Chrome, Mousepad, Ristretto,
  Evince and CJK fonts.
- `sudo apt-get install -y <package>` works at once. If apt answers 404 Not
  Found, run `sudo apt-get update` and try again. `box_status` says whether
  the box user can use `sudo`.
- Ask for `linux-docker` when you need Docker for sure: it skips offers
  without it. A box in Docker runs no systemd, so `systemctl` does not work
  there.
- A `linux-desktop` box always has its GPU. When no GPU is free, the refusal
  suggests `linux-desktop-cpu`.
- Windows boxes have Visual Studio Build Tools (MSVC and the Windows SDK),
  LLVM (`clang`) and Rust (`cargo`, `rustc`). They have no GPU: DirectX apps
  render on WARP, Windows' software renderer.

## Running commands

- `box_run` returns when the script's shell exits. What a command started in
  the background writes after that is lost unless you redirect it: start a
  server with `nohup <cmd> >server.log 2>&1 &`.
- A command that exits with a non-zero code is not a tool error. A command
  that times out is.
- BB ends a tool call after about five minutes, so `box_run` returns after
  270 s. A command still running then goes on in the box as a job. The answer
  names the job and gives its output so far; call `box_job` for the rest.
- When bb-box restarts, as for an update, a running command goes on as a job
  too, and the answer names it. bb-box is back within a minute. Until then a
  box may not answer: wait about 30 s and try again. Do not release it: its
  commands and jobs go on.
- A box can stop on its own, as when its VM crashes. The tool's error and
  `box_status` say when and why. bb-box starts it again unless it crashed in
  the last 10 minutes.
- Each command reads `~/.config/bb-box/env`, which sets `BB_BOX_ID`,
  `BB_BOX_NAME`, `BB_BOX_KIND`, `BB_THREAD_ID`, and `BB_HOST_ID` once the box
  is a BB machine.
- `desktop: true` runs the command in the desktop session, so it can open
  windows. On a Mac, only such a command reaches the login keychain, which
  git's keychain helper and Xcode's signing use.

### Windows

- Commands run in PowerShell 7, as an administrator.
- A Windows box is not a BB machine yet, so `box_thread` cannot start a
  thread there.
- What a command starts with `Start-Process`, `Start-Job` or `cmd /c start`
  ends with the command. Start a server with
  `Start-Detached { <cmd> } server.log` instead. It returns the process ID,
  and gets the command's directory and environment variables, but not its
  PowerShell variables: pass values in `$env:`.
- Start a GUI program the same way, in a desktop command (`desktop: true`) so
  its window shows: `Start-Detached { & <program> <args> } app.log`. Its
  output reaches the log.
- A desktop command runs unelevated, as an app you open does. It has no job:
  `box_run` stops it after 270 s, with its output so far.

## Copying files

`box_copy` copies one file of any size in one call; do not split it. Tar a
directory first.

- A file over 16 MiB streams through bb-box's worker on the thread's
  machine, and both ends check its SHA-256. A copy that fails leaves the
  target as it was.
- The machine that holds the file must be connected to BB, as it is while
  the thread runs there.
- A path in the thread's storage folder works both ways: give it in full, or
  starting with `$BB_THREAD_STORAGE/`.

## Desktops and computer use

A person can watch a desktop box from BB and take control of its keyboard
and mouse. While they hold control, every computer tool refuses at once.
Wait, or call `computer_take_control` only when they ask you to continue or
have clearly finished.

- Read a window as text with `computer_observe`, and act on its references,
  such as `e12`. Take an image with `computer_screenshot` only when
  appearance matters.
- A reference stays valid while its element is on screen. When it has gone,
  the tool says so: observe the window again. After a person held control,
  observe again too.
- A web page's tree can be long: pass `query` to see only the lines you
  need.
- Pixels count only in your latest image of that window, or of the desktop.
  An image is at most 1568 pixels on each edge, so it can be smaller than
  the screen; each answer gives the scale.
- An action that opens a menu or popup says so, with its items. A menu never
  becomes the active window: to press keys in it, such as Escape, give its
  window ID or window `"desktop"`.
- When an app refuses input in the background, bb-box uses the real pointer
  or keyboard, and says so. The desktop's focus may then have moved.
- On Windows, a window with no title gets the title "<app> (untitled)", as
  Cua reaches only windows with one: `computer_launch` names it at once, and
  `computer_windows` lists it from its next call on, and each says so. An
  app that draws everything itself, such as a GPUI app, has no accessibility
  tree: drive it with `computer_screenshot` and pixel actions.

## BB machines

A box joins BB as a machine a few seconds after it is ready, so threads and
terminals can use it. `box_acquire`, `box_start` and `box_run` wait up to
20 s for that.

- In a Linux or macOS box that is a BB machine, each command gets `GH_TOKEN`,
  your git identity and BB's machine variables from BB. `git` fetches GitHub
  through `gh`, over HTTPS, even for SSH URLs.
- A project's own variables reach a box only while a thread of that project
  runs on it. A command that needs one can run in a thread on the box: start
  one with `box_thread`.
- In BB's new-thread screen, "New box" starts a thread on a box of its own.
  From a terminal, `bb thread spawn` does the same with the environment
  provider `bb-box-new` and inputs such as `{"kind": "linux"}`; give
  `--model`, since a new box cannot list models until it exists.

## A project's image

A project's image is a script run as root on the standard image of its Linux
kinds, so the project's boxes start with what it needs. When asked to make
one, follow these steps:

1. **Draft.** Read the project's files and pass them to `box_image_draft`:
   `.devcontainer/devcontainer.json` and the Dockerfile it names, a
   Dockerfile, `.tool-versions`, `mise.toml`, `.nvmrc`, `.python-version`,
   `rust-toolchain.toml`, or `flake.nix` with `flake.lock`. For a box someone
   set up by hand, give its name as `box` too.
2. **Finish.** Settle what the draft left to you: its answer and the top of
   the script list it. Leave out what needs the checkout, such as `npm ci`:
   a build has no repository. Write the script to `.bb/box-setup.sh`, and a
   check that fails when the script did not do its work, such as
   `cargo --version`, to `.bb/box-check.sh`.
3. **Try.** Call `box_image_try`, which builds the script in a clean box as a
   build will. Fix the script and try again until every check passes. With
   `keep: true`, a box of what it built stays for you to look inside with
   `box_run`; release it after.
4. **Register.** Commit the two files, then call `box_image_set` with their
   text and paths. It changes every new box of those kinds in the project, so
   ask the user first unless they asked for the image. Proxmox LXC, Docker and
   Tart then build the image ahead once it is used, and later boxes start from
   the build; the SSH host pool and GPU desktops run the script as each box
   starts.

## The bb box command

The `bb box` command checks and sets up bb-box. The
[CLI reference](../../docs/reference/cli.md) lists every subcommand, and the
[configuration reference](../../docs/reference/configuration.md) every
setting.

- `bb box doctor` checks each backend and says how to fix what is wrong.
- `bb box config show --json` prints the configuration with no secret in it.
  `bb box config apply <file>` reads the file on the machine BB's server runs
  on.
- `bb box machines add <kind> --name <name>` keeps a box as one of your own
  BB machines, which no thread owns and which lives until you remove it.
- `bb plugin logs bb-box` says why each box was released, and how long each
  step of joining BB took.
