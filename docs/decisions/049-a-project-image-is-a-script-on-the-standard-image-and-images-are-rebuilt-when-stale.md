# 049: A project's image is a script on the standard image, and images are rebuilt when stale

Status: accepted, 2 October 2026. Extends
[029](029-configuration-is-one-checked-document.md): the configuration
holds images; [033](033-a-thread-can-start-on-a-new-box.md): a new box
takes its project's image; [032](032-spare-boxes-are-enrolled-ahead.md):
spares can be of an image; and
[042](042-a-docker-host-can-be-a-bb-machine.md): Docker images are rebuilt
through the same relay. Extended by
[050](050-a-box-can-join-the-operators-tailnet-as-an-ephemeral-node.md):
standard Linux images carry Tailscale, stopped and with no state.

## Context

Every box of a kind starts from the same image: a Proxmox LXC template, a
Docker image, a Tart VM or a QEMU disk. The operator asked for two things.

- **Their own setup on top.** A project should be able to add what its
  threads need, such as Rust and Tailscale for a project that shares a
  keyboard and mouse over a tailnet, once for every backend, and have its
  threads' boxes start with it.
- **Freshness.** Images are rebuilt only when a person runs a setup
  script. Each should say when it was built and what is in it, the doctor
  should say when one is old, and a nightly job should rebuild them.

What exists:

- **Builds.** Proxmox LXC templates come from `template/build.sh`, run as
  root on the Proxmox host. It runs the guest scripts in a container
  (`customize-base.sh`, then `customize-desktop.sh` for a desktop), the
  kind's check as the box user, then `finalize.sh`. Docker images come from
  `setup/docker/build.sh`, which runs the same guest scripts, and which
  bb-box runs itself for a Docker host that is a BB machine (042). Tart's
  images come from `prepare-image.sh`, `prepare-linux-image.sh` (the same
  guest scripts) and `prepare-windows-image.sh`, run on the Mac.
- **Records.** `finalize.sh` writes `/usr/share/bb-box/template-release`
  (kind, date, apt snapshot, and each tool's version and SHA-256),
  `template-pins.json` and `template-packages.tsv`. LXC templates carry a
  build ID tag, which warm guests copy. Docker images carry labels with the
  layout version and the digest of BB's host app. Tart's builds are told
  apart by the disk's inode and time; Windows images have a `build.json`.
- **What is checked.** Warm guests are retired when their template's build
  ID changes, or Tart's image, Tart or macOS does. The Docker doctor says
  when an image is missing, from another layout or has another build of
  BB's app. A GPU desktop compares its NVIDIA userspace with the host's
  driver at each start.
- **Pins.** `pins.json` and `desktop-pins.tsv` pin each tool and the apt
  snapshot by hand. A rebuild with the same pins changes only BB's app and
  the apt lists.

A layer like the example project's, in a `linux` box on Proxmox LXC:

| Step | Time |
| --- | --- |
| Tailscale from its apt repository | 3.0 s |
| Rust's minimal toolchain with rustup | 17.7 s |
| clippy and rustfmt | 1.0 s |
| All, as a script at box start | 21.8 s, and 0.6 GB on disk |

A box from a spare or warm guest is ready in under 2 s, so the script
would be most of every box's wait. A script that also builds a project's
dependencies takes minutes.

## Decision

### The contract

Any image bb-box starts a box from, its own or a project's, must keep this
contract. The kind's check, which every build already runs, checks it.

1. **The box user.** `box`, with sudo without a password. On backends
   reached over SSH (Proxmox LXC, Tart, QEMU), bb-box's public key in its
   `authorized_keys` and `sshd` at boot. Docker boxes are reached through
   `docker exec` (031) and need neither.
2. **bb-box's boot units.** Clearing BB's daemon state at boot (017) and
   reading the names the backend gives the guest (018). The image itself
   names no install or box.
3. **BB's host app** with its digest file, so a box enrols in about 2 s
   rather than 5. Not on Windows, where BB's app does not run.
4. **Docker**, started on first use (041), on Linux.
5. **For desktop kinds**, the kind's desktop and its units (Xorg or
   Xtigervnc with XFCE, or Sway with wayvnc
   ([048](048-a-wayland-desktop-is-sway-with-floating-windows-streamed-by-wayvnc.md))),
   the display script that resizes (021), Chrome, and Cua Driver with its
   unit (015).
6. **Nothing of one machine.** No SSH host keys, machine ID, logs, caches,
   Docker state, BB daemon state or other per-machine keys, so each box
   makes its own.
7. **Its record**, below.

The contract has a version, in the record. The doctor fails an image whose
version is older than bb-box needs, as it does now for Docker's layout
version, which this replaces.

### A project's image

An image is a script run as root on a kind's standard image, built for
each backend that offers the kind.

- **In the configuration.** Each image has a name such as `rust-tailscale`,
  the kinds it builds on, a script for each OS family (Linux now; Windows
  in PowerShell and macOS later), an optional check run as the box user,
  how it is baked (below), and the projects it belongs to.
- **Set from the CLI or the page.** `bb box image set <name> --kinds
  linux,linux-desktop-cpu --script-file layer.sh [--check-file check.sh]
  --project <id>` keeps a copy of the files, as BB's script automations do.
  The settings page lists each image with its builds per backend, their
  dates, sizes and states, and the last build's output.
- **One script for every Linux backend.** It runs in a booted box with the
  network, on Proxmox LXC, Docker and Tart, x86_64 and arm64. It can read
  `BB_BOX_IMAGE`, `BB_BOX_KIND`, `BB_BOX_BACKEND` and `BB_BOX_ARCH` where it
  must differ. It removes any per-machine state it makes; finalizing
  removes only what bb-box knows of.
- **No secrets.** The build box is not a BB machine, so it has none of the
  project's variables, and what an image holds every box from it gets.
  Joining a tailnet is done per box, at start (050).

The example project's script:

    #!/bin/bash
    set -euo pipefail
    curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg \
      -o /usr/share/keyrings/tailscale-archive-keyring.gpg
    curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list \
      -o /etc/apt/sources.list.d/tailscale.list
    apt-get update && apt-get install -y tailscale
    # No node of its own: a box joins at start (050).
    systemctl disable --now tailscaled && rm -rf /var/lib/tailscale
    sudo -iu box sh -c 'curl -fsSL https://sh.rustup.rs |
      sh -s -- -y --profile minimal -c clippy -c rustfmt'

### Building an image: a box, the script, a check, a capture

bb-box builds a project's image with the access it already has: the
Proxmox API token, the `docker` CLI and SSH to the Mac. No backend needs
root on its host for it.

1. **A build box** of the base kind, from the current standard image: not
   a thread's and not enrolled. The panel shows it as "Building image
   rust-tailscale". On Proxmox LXC it is a linked clone on LVM-thin, which is
   as independent as a copy, and a full clone elsewhere, so the standard
   template can still be replaced.
2. **The script**, as root, with a time limit of 30 minutes by default.
   bb-box keeps its last 200 lines of output.
3. **Finalizing**, as `finalize.sh` does, and the record.
4. **The capture**, with the box stopped:
   - Proxmox LXC: the container becomes a template through the API, with
     the image's name and build ID in its tags and the record in its
     description.
   - Docker: `docker commit`, with the record in a label.
   - Tart: the VM is renamed to the image's name, as `prepare-image.sh`
     renames its build VM, and the record is written beside it.
5. **The checks** below, on a trial box. The new build replaces the last
   one only if they pass.

A project's image is always built on the current standard image, never on
its own last build, so its script runs once on top and rebuilds do not
pile up layers.

### Baked, at box start, or both

| | Baked | Script at box start | Both: at start, then baked (chosen) |
| --- | --- | --- | --- |
| A box's wait | as a standard box's; spares and warm guests work | the script's time, every box: 22 s for the example, minutes with a dependency build | the script's time for the first boxes on a backend, then as a standard box's |
| A changed script | after a rebuild | at once | at once, at start, until the rebuild passes |
| Disk | one image per backend and kind | none | only for images in use |
| A failing script | fails the build; the last build stays | fails each acquire | as baked, once baked |
| The operator's work | a build per backend | none | none |

- **At start.** A box of an image with no current build on its backend
  takes a box of the base kind, a spare if there is one, and runs the
  script as root before it is handed over. Acquire's progress says
  "Running rust-tailscale's script". If the script fails, the box is released
  and the acquire fails with the script's last 20 lines.
- **Baked when used.** bb-box bakes an image on a backend once two of its
  boxes started there within 14 days. The build runs in the background, and
  the next box after it starts as fast as a standard one. An image can say
  `always`, to keep a build on every backend that offers its kinds, or
  `never`, for a script that must run at each start.
- **A changed script** makes the image's builds out of date at once: new
  boxes run the new script at start, and a rebuild starts.
- **Unused builds go.** A build no box started from for 30 days is removed,
  and the next box runs the script again.
- **Spares and warm guests** can be kept per image once it is baked, as
  per kind now (032). None by default.
- **Backends without images**, such as the SSH host pool, always run the
  script at start.

### Choosing an image

- **A project's image is its default.** A thread in a project the image
  belongs to gets it for the kinds it covers: from New box, `box_acquire`,
  `bb box acquire`, and a thread started on a new box (033).
- **New box has an Image choice** when an image covers the chosen kind:
  the project's image first, marked "this project's", then Standard, then
  other images. BB's new-thread inputs have the same choice.
- **The agent's tools.** `box_acquire` takes `image` (a name or
  `standard`), and `box_list` shows each kind's images for the thread's
  project.
- **A box says which it has.** Its record and its details give the image
  and build, such as "rust-tailscale, built 2 October".

### The record

Every image, standard or a project's, has `/usr/share/bb-box/image.json`,
and a copy that can be read without starting it: the LXC template's
description, a Docker label, or a file beside the image on the Mac.
`template-release` and the packages list stay, for people.

    {
      "contract": 1,
      "image": "rust-tailscale",
      "kind": "linux-desktop-cpu",
      "arch": "x86_64",
      "build": "build.20261003-021500-3f9c",
      "built": "2026-10-03T02:15:00Z",
      "base": "build.20260928-020500-a1b2",
      "os": "Ubuntu 24.04.3 LTS",
      "aptSnapshot": "20260926T060000Z",
      "pins": "<SHA-256 of the pins it was built with>",
      "bbApp": "<SHA-256 of BB's host app>",
      "tools": { "node": "24.21.0", "claude-code": "2.1.283", "codex": "0.157.1",
                 "pi": "0.87.1", "gh": "2.101.0", "chrome": "154.0.8037.92",
                 "cua-driver": "0.28.3" },
      "nvidia": null,
      "layer": { "sha256": "<SHA-256 of the script>", "seconds": 22 },
      "sizeGiB": 3.3
    }

`base` is the standard image's build, for a project's image. `nvidia` is
the userspace's version where the image has one, as LXC GPU templates do;
Docker's GPU desktops get it from the host.

### When an image is stale

The doctor has a check for each image a backend uses.

| Finding | Status | What it costs |
| --- | --- | --- |
| The contract is older than bb-box needs | fail | its boxes may not work |
| The NVIDIA userspace is not the host driver's version, as the last GPU box saw it | fail | GPU desktops do not start (006) |
| No record: built before this decision | warn | nothing can be said of it |
| Older than twice its interval: 14 days for Linux, 60 for Windows and macOS | warn | tools and packages are behind |
| BB's app is not the server's | warn | each box downloads it as it enrols, 2 to 5 s more; spares hide it |
| Built with other pins than this bb-box's | warn | it lacks what a bb-box update brought |
| A project's image is on an older standard build, or its script changed | warn | rebuilt next |
| Its last rebuild failed | warn | with the reason and the output |

A check named "Nightly rebuilds" warns when none has run for 8 days.

### Rebuilding at night

- **The job.** `bb box images refresh` rebuilds stale images one at a time,
  most needed first, and starts none after its time limit, 4 hours by
  default. It ends with a line per image, and exits 1 if any failed.
- **Run by a BB automation**, which the setup guide gives:

      bb automation create --project <project> --name "bb-box images" \
        --cron "0 2 * * *" --timezone <zone> \
        --script "bb box images refresh" --timeout 4h

  BB lists its runs and output, and the operator can pause it, move it or
  run it now. If a script automation cannot run `bb box`, bb-box schedules
  the same job with the plugin SDK's `schedule()` instead.
- **What is due**, in this order:
  1. images that fail the doctor;
  2. standard images past their interval: 7 days for Linux on any backend,
     30 days for Windows and macOS;
  3. project images whose standard image was rebuilt;
  4. Linux images with another build of BB's app (a Docker rebuild
     changes only its last layer);
  5. images built with other pins.
- **How a standard image is rebuilt.**
  - Docker: `setup/docker/build.sh`, as bb-box runs it now (042).
  - Tart: its prepare script, run on the Mac over SSH as the user bb-box
    logs in as, from a copy of bb-box's setup directory.
  - Proxmox LXC: `build.sh` needs root on the host, which bb-box does not
    have, so bb-box refreshes the template from a box of it. The guest
    scripts run again with the current pins and BB's app, a GPU template
    gets the NVIDIA userspace for the host's driver from NVIDIA's site,
    checked against NVIDIA's SHA-256, then finalizing, a capture, and the
    template is replaced in place, keeping its VMID, as `build.sh
    --replace` does. A person runs `build.sh` only when the contract
    changes, which the doctor asks for.
  - Windows (039, 046): later, with PowerShell scripts.
- **Versions.** A rebuild takes the latest stable release of the tools
  that change often and that bb-box does not depend on: Claude Code,
  Codex, pi, gh and Chrome, and an apt snapshot of that day. Each is
  checked against its upstream's published SHA-256 or signature and
  recorded. Node, Cua Driver, the desktop stack and NVIDIA's userspace stay
  pinned, and change with bb-box releases. `--pinned` builds from the
  repository's pins alone.
- **Room.** A build starts only if its host keeps its disk reserve
  (`reserve-disk-gib` on Proxmox LXC and Tart) with the build box, the
  trial box and the new image beside the old one, and has room for both
  boxes as for any box. A Mac that must keep 60 GB free sets its reserve to
  60. Otherwise the image waits for the next night, and the doctor says
  why.
- **Checks before replacing.** All must pass on a trial box from the new
  build:
  1. the kind's check and the image's check, as the box user;
  2. the box answers within its kind's ready time, with BB's app at the
     recorded digest, and Docker answers on first use;
  3. for a desktop, the stream's first frame, and a screenshot through Cua
     that is not blank;
  4. it answers no more than 5 s slower than a box from the old build;
  5. the record is whole, and no tool is older than in the old build.
- **Replacing.** Proxmox LXC replaces the template in place, waiting on
  storage where boxes need it, as `build.sh` does. Docker moves the tag;
  the old image goes when no container uses it. Tart renames the new VM;
  boxes are copies on write and do not need the old one. Warm guests of
  the old build are retired as now, and idle spares are replaced.
- **A failure** keeps the old build and the output, and the image is not
  tried again until something it depends on changes or a person runs `bb
  box images build <name>`.

### To verify in the first PRs

- That the API token can make a container a template, remove a protected
  one and clone into its VMID (`VM.Allocate` and `VM.Config.Options` on
  the pool), and that a description holds the record.
- That `customize-base.sh` and `customize-desktop.sh` give the same
  packages and files when run again on a built template.
- That a BB script automation can run `bb box`.
- Whether the token can create a container from Ubuntu's container
  template with nesting. If so, bb-box can build headless and CPU desktop
  templates from nothing, without drift; GPU templates' device lines need
  root, so they stay refreshes.

## Consequences

- A project's boxes start with its tools: the example project's after
  22 s for its first boxes on a backend, then as fast as standard ones.
- Agent CLIs and Chrome in new boxes are at most a week old, and Windows
  and macOS images at most a month.
- The doctor says how old each image is and what is in it.
- More disk: one build per project image, backend and kind in use, full
  copies on Proxmox storage other than LVM-thin.
- Refreshing an LXC template from itself can drift from a fresh build. The
  packages list shows it, and `build.sh` resets it.
- A broken upstream release that the checks miss reaches new boxes until
  the next build. `--pinned` and a pin in the repository hold it back.
- Backends gain optional image operations: capture, replace, remove and
  list. Backends without them run scripts at start. The conformance suite
  builds a small image on each backend that has them.

### Plan of PRs

1. **The record**: `image.json` from `finalize.sh` and the Docker and Tart
   builds, the copies outside the image, and the doctor's checks of
   contract, age, BB's app, pins and the NVIDIA version.
2. **Versions**: the resolver for the tools that follow upstream, with
   their checksums.
3. **Image operations** on Proxmox LXC, Docker and Tart, the build box and
   the trial box, and their conformance test.
4. **The nightly job**: `bb box images refresh` and `build`, the order,
   the room check, the output, the "Nightly rebuilds" check, and the setup
   guide's automation.
5. **Project images**: the configuration, `bb box image set` and `remove`,
   the script at start, baking when used and removing when unused.
6. **Choosing**: New box's Image choice, `box_acquire`'s `image`,
   `box_list`, and the box's record and details.
7. **Docs**: the architecture, the setup guides and the kinds, with each
   PR.

Later: Windows and macOS scripts, and a project's script kept in its own
repository.
