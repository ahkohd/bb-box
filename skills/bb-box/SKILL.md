---
name: bb-box
description: Boxes for BB threads, Linux, macOS or Windows computers for commands, builds, tests, servers and Docker, and the bb box command to set up, check and clean up their backends.
---

# bb-box

bb-box gives each BB thread its own boxes: Linux, macOS or Windows
computers that start in seconds. A box belongs to the thread that acquired
it. It goes when the thread releases it with `box_release`, or a few
minutes after the thread is archived or deleted. Boxes do not expire. Push
your work to Git, or copy it out, before a box goes: its disk goes with it.
To free a box's memory and CPU but keep its disk, stop it with `box_stop`.

Every tool's answer ends with a `Next:` line that says what to do next. The
tools, and each of their parameters, are in the
[tool reference](../../docs/reference/tools.md). This skill says what the
tools do not.

## Choosing a box

`box_list` shows the kinds on offer, their sizes, where each can come from
("On: ..."), and the project's images, with whether each has a spare ready
where it is built ahead, which its boxes claim at once (#440). The
[kinds reference](../../docs/reference/kinds.md) describes every kind.

- Ask for the kind's default size when you can. A kind can keep spare boxes
  ready at that size, and then a box is ready at once. On Proxmox's Windows
  VMs and Tart's macOS and Windows VMs, a spare waits stopped, and it takes
  a few seconds to resume.
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
  LLVM (`clang`), Rust (`cargo`, `rustc`), Node.js, and the Claude Code,
  Codex and Pi CLIs. They have no GPU: DirectX apps render on WARP,
  Windows' software renderer.

## Running commands

`box_run`'s description gives its timeout, its jobs after 270 s and how to
keep a server running. Its answers, and `box_job`'s, say what to do when
bb-box restarts. Beyond those:

- A command that exits with a non-zero code is not a tool error. A command
  that times out is.
- A box can stop on its own, as when its VM crashes. The tool's error and
  `box_status` say when and why. bb-box starts it again unless it crashed in
  the last 10 minutes.
- Each command reads `~/.config/bb-box/env`, which sets `BB_BOX_ID`,
  `BB_BOX_NAME`, `BB_BOX_KIND`, `BB_THREAD_ID`, and `BB_HOST_ID` once the box
  is a BB machine.
- On a Mac, only a desktop command (`desktop: true`) reaches the login
  keychain, which git's keychain helper and Xcode's signing use.

### Windows

The Windows kinds' descriptions in `box_list` say how commands run there.
Beyond those:

- A Windows box is a BB machine, as a Linux or macOS box is, so
  `box_thread` can start a thread there, on an agent CLI in its image. It
  takes a minute or two to join BB, or none from a spare.
- Type `pwsh` for PowerShell 7, never `powershell`, which is Windows
  PowerShell 5.1.
- `Start-Detached` gives the command it starts the environment variables,
  but not PowerShell variables: pass values in `$env:`.
- For a GUI program's window to show, call `Start-Detached` in a desktop
  command (`desktop: true`).

## Copying files

`box_copy`'s description gives its sizes and paths. Beyond those:

- A copy that fails leaves the target as it was.
- The machine that holds the workspace or storage folder must be connected
  to BB, as it is while the thread runs there.

## Desktops and computer use

Open an app or a URL with `computer_launch`, then read a window with
`computer_observe`, act on it with `computer_act` and type with
`computer_type`. Their descriptions say how. Beyond those:

- A person can take control of a desktop from BB. While they hold it, every
  computer tool refuses at once; call `computer_take_control` only when they
  ask you to continue or have clearly finished. Afterwards, observe the
  window again: the references and images from before are gone.
- A reference stays valid while its element is on screen. When it has gone,
  the tool says so: observe the window again.
- When an app refuses input in the background, bb-box uses the real pointer
  or keyboard, and says so. The desktop's focus may then have moved.
- On Windows, a window with no title gets the title "<app> (untitled)", as
  Cua reaches only windows with one: `computer_launch` names it at once, and
  `computer_windows` names it in the background and lists it on a later
  call, within about 15 s, and each says so. An app that draws everything
  itself, such as a GPUI app, has no accessibility tree: drive it with
  `computer_screenshot` and pixel actions.

## BB machines

A box joins BB as a machine a few seconds after it is ready, or a minute or
two for a Windows box, so threads and terminals can use it. `box_acquire`,
`box_start` and `box_run` wait up to 20 s for that.

- In a box that is a BB machine, each command gets `GH_TOKEN`,
  your git identity and BB's machine variables from BB. `git` fetches GitHub
  through `gh`, over HTTPS, even for SSH URLs.
- A project's own variables reach a box only while a thread of that project
  runs on it. A command that needs one can run in a thread on the box: start
  one with `box_thread`.
- `box_thread` starts the child on your thread's agent and model when the
  box has that agent's CLI, and on BB's default otherwise. It refuses a box
  with none of BB's agent CLIs, and names them.
- In BB's new-thread screen, "New box" starts a thread on a Linux or macOS
  box of its own, not a Windows one. From a terminal, `bb thread spawn`
  does the same with the environment provider `bb-box-new` and inputs such
  as `{"kind": "linux"}`; give `--model`, since a new box cannot list models
  until it exists.

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

The `bb box` command checks and sets up bb-box; the
[CLI reference](../../docs/reference/cli.md) lists it. An agent mostly needs:

- `bb box doctor`, which checks each backend and says how to fix what is
  wrong.
- `bb plugin logs bb-box`, which says why each box was released, and how long
  each step of joining BB took.
