# Decision records

Each record gives the context, the decision and its consequences, as they
were when it was made. A decision that changes gets a new record, and the
old one says which parts the new one supersedes or extends. "Now" says
which records still stand as written. The current design as a whole is in
[the architecture](../architecture.md).

| | Decision | Now |
| --- | --- | --- |
| [001](001-provider-agnostic-core.md) | The core does not care who the provider is | Current |
| [002](002-bb-is-the-coordinator.md) | BB is the coordinator | Current |
| [003](003-boxes-live-until-released.md) | Boxes live until their thread ends or they are released | Current |
| [004](004-acquire-and-release.md) | Acquire and release, for virtual and real machines | Current |
| [005](005-linux-boxes-on-proxmox-lxc.md) | The first backend runs Linux boxes as unprivileged LXC containers on Proxmox VE | Current |
| [006](006-gpu-desktop-on-xorg.md) | The Linux GPU desktop runs Xorg with NVIDIA's driver, streamed by x0vncserver | Partly superseded by 021 |
| [007](007-desktop-stream-is-a-typed-transport.md) | The desktop stream is a typed transport, relayed through the plugin | Partly superseded by 011 |
| [008](008-shared-control.md) | You and the agent share one desktop, with one controller at a time | Partly superseded by 015, 038 and 045 |
| [009](009-conformance-suite-and-doctor.md) | A conformance suite and a doctor check for every backend | Partly superseded by 016 |
| [010](010-publishable-by-default.md) | The repository is publishable at all times | Current |
| [011](011-interface-v1.md) | Interface v1: shared kinds, routes and displays | Partly superseded by 012, 015, 016 and 028 |
| [012](012-offers-may-add-features.md) | A kind names what it promises, and offers may add features | Partly superseded by 027 and 041 |
| [013](013-docker-boxes-run-unprivileged.md) | Docker boxes run unprivileged, without systemd | Superseded by 031 and 041, but for no systemd and no `dockerHost` |
| [014](014-enrol-through-machine-providers.md) | Boxes enrol through BB's machine provider API, when claimed | Partly superseded by 032 |
| [015](015-computer-use-through-cua-driver.md) | Computer use drives a pinned Cua Driver through bb-box's own tools | Partly superseded by 022 and 039 |
| [016](016-changes-from-building-v1.md) | Changes from building Interface v1: jump hosts, first keys, setup, stale releases, facts | Current |
| [017](017-boxes-clear-bb-daemon-state-at-boot.md) | Boxes clear BB's daemon lock and PID file at boot | Current |
| [018](018-guests-name-their-install-and-box.md) | Guests name their install and their box, and backends check both before acting | Current |
| [019](019-lost-records-are-restored-from-guests.md) | The sweep restores lost records, and only BB ends a thread | Partly superseded by 025 |
| [020](020-control-belongs-to-a-viewer.md) | Control belongs to one viewer, and a GPU desktop is retried on another GPU | Partly superseded by 043 |
| [021](021-desktop-resize-through-the-backend.md) | A desktop whose VNC server cannot resize is resized by its backend | Current |
| [022](022-references-follow-renames-not-rows.md) | A reference follows its element through a rename, not into another row | Partly superseded by 023 |
| [023](023-a-reference-follows-its-element-through-its-own-rename.md) | A reference follows its element through its own rename | Partly superseded by 024 |
| [024](024-an-element-renamed-out-of-sight-is-refused-once.md) | An action on an element renamed out of sight is refused once | Current |
| [025](025-a-restored-box-enrols-again.md) | A restored box enrols again, keyed by its box ID | Partly superseded by 026 |
| [026](026-a-restored-box-enrols-once-it-answers.md) | A restored box enrols once it answers | Current |
| [027](027-a-kind-says-when-it-has-a-desktop.md) | A kind says when it has a desktop, and a plain box has no qualifier | Partly superseded by 029 and 041 |
| [028](028-a-box-size-is-chosen-when-it-is-made.md) | A box's size is chosen when it is made, from presets per kind | Current |
| [029](029-configuration-is-one-checked-document.md) | Configuration is one checked document in bb-box's storage, set through its page and CLI | Current |
| [030](030-a-mac-runs-desktop-commands-through-launchctl-asuser.md) | A Mac runs desktop commands through `launchctl asuser` | Current |
| [031](031-docker-boxes-are-reached-through-docker-exec.md) | Docker boxes are reached through `docker exec` | Current |
| [032](032-spare-boxes-are-enrolled-ahead.md) | Spare boxes are enrolled ahead, and BB shows them until claimed | Current |
| [033](033-a-thread-can-start-on-a-new-box.md) | A thread can start on a new box, from BB's new-thread screen | Partly superseded by 034 |
| [034](034-a-working-thread-holds-its-box.md) | A box a thread is working on is released or stopped only when forced | Current |
| [035](035-a-terminal-has-its-pty-on-bbs-server.md) | A box's terminal has its PTY on BB's server, and the plugin keeps the shell | Current |
| [036](036-your-machines-are-boxes-you-own.md) | Your machines are boxes you own, kept as BB machines | Current |
| [037](037-a-panel-keeps-a-boxs-desktop-and-terminal.md) | A panel keeps a box's desktop and terminal across tab switches | Current |
| [038](038-the-agent-can-take-control-back.md) | The agent can take control back when asked | Current |
| [039](039-windows-desktops-are-clones-of-a-template-that-is-not-generalized.md) | Windows desktops are clones of a template that is not generalized | Current |
| [040](040-linux-on-arm64-has-kinds-of-its-own.md) | Linux on arm64 has kinds of its own | Partly superseded by 041 |
| [041](041-every-linux-box-has-docker.md) | Every Linux box has Docker, started on first use | Current |
| [042](042-a-docker-host-can-be-a-bb-machine.md) | A Docker host can be a BB machine, reached through BB | Current |
| [043](043-a-viewer-has-5-s-to-come-back-after-the-box-ends-its-connection.md) | A viewer has 5 s to come back after the box ends its connection | Current |
| [044](044-a-box-can-be-asked-for-on-one-provider.md) | A box can be asked for on one provider | Current |
| [045](045-a-persons-control-lasts-through-a-restart-of-the-plugin.md) | A person's control lasts through a restart of the plugin | Current |
| [046](046-windows-on-a-mac-runs-in-qemu-in-the-tart-backend.md) | Windows on a Mac runs in QEMU, in the Tart backend | Current |
| [047](047-a-physical-mac-is-an-ssh-pool-machine-lent-with-a-new-user-at-its-console.md) | A physical Mac is an SSH pool machine, lent with a new user at its console | Current; a real Mac's live check is to come |
| [048](048-a-wayland-desktop-is-sway-with-floating-windows-streamed-by-wayvnc.md) | A Wayland desktop is Sway with floating windows, streamed by wayvnc | Current |
| [049](049-a-project-image-is-a-script-on-the-standard-image-and-images-are-rebuilt-when-stale.md) | A project's image is a script on the standard image, and images are rebuilt when stale | Current |
| [050](050-a-box-can-join-the-operators-tailnet-as-an-ephemeral-node.md) | A box can join the operator's tailnet as an ephemeral node | Not built yet, but for TUN in Proxmox LXC templates |
| [053](053-microsandbox-is-a-later-backend-not-built-now.md) | microsandbox is a later backend, not built now | Not built yet |
