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
| [007](007-desktop-stream-is-a-typed-transport.md) | The desktop stream is a typed transport, relayed through the plugin | Partly superseded by 011 and 056 |
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
| [053](053-microsandbox-runs-light-linux-boxes-as-microvms.md) | microsandbox runs light Linux boxes as microVMs | Current, amended: an option beside Docker, not the default |
| [054](054-windows-images-are-refreshed-in-a-box-of-the-current-build.md) | Windows images are refreshed in a box of the current build | Being built |
| [055](055-cloud-boxes-run-on-cloud-hosts-first-and-a-cloud-vm-per-box-later.md) | Cloud boxes run on cloud hosts first, and a cloud VM per box later | Not built yet |
| [056](056-linux-x11-desktops-add-a-selkies-stream-and-rfb-stays-for-the-rest-tuned.md) | Linux X11 desktops add a Selkies stream, and RFB stays for the rest, tuned | Current, amended: video for every viewer, on by default |
| [057](057-linux-boxes-can-be-proxmox-vms-for-their-own-kernel.md) | Linux boxes can be Proxmox VMs, for their own kernel | Proposed |
| [058](058-a-mac-with-sip-off-grants-its-box-users-macos-permissions.md) | A Mac with SIP off grants its box users macOS permissions | Current |
| [059](059-agents-record-their-desktop-box-with-box-record.md) | Agents record their desktop box with box_record | Accepted |
| [060](060-every-desktop-streams-as-video-through-one-viewer.md) | Every desktop streams as video through one viewer | Accepted |
| [061](061-a-box-can-be-resized-live-where-its-backend-can-and-restarted-only-when-asked.md) | A box can be resized after it is made, live where its backend can, and restarted only when asked | Accepted |
| [062](062-docker-boxes-are-pinned-to-their-cores-and-see-their-memory-through-lxcfs.md) | Docker boxes are pinned to their cores, and see their memory through LXCFS where the host has it | Accepted |
| [063](063-device-boxes.md) | Device boxes: one iOS Simulator or Android emulator per box, in a frame in the panel, shared with the agent | Accepted; not built yet |
| [064](064-ios-shared-hosts.md) | iOS shared hosts: ios boxes as macOS users with their own device, many to a Mac, on pool Macs, Tart VMs and Namespace Macs | Proposed; decision 14 superseded by 065 |
| [065](065-macs-say-what-they-offer-and-ios-streams-in-software-where-they-must.md) | Macs say what they offer, measured, and iOS streams in software where a Mac has no encoder | Proposed |
| [066](066-the-monitor-is-beacon-moved-into-bb-box.md) | The Monitor is Beacon moved into bb-box, and a container is judged by its own cgroup | Accepted |
| [067](067-settings-page.md) | The settings page is an overview, with a page one step in for each backend, kind and option | Accepted; built |
| [068](068-boat-backend.md) | A boat.dev box is a sandbox forked from a template sandbox, held on a renewed auto-stop and deleted on release | Proposed; being built |
| [069](069-boxes-page.md) | A box has a page of its own, and the Boxes page says how each box is now | Accepted; being built |
| [070](070-snapshots.md) | A box's snapshots are bb-box's own records, taken by each backend's own mechanism, and kept with the box unless the person keeps them | Proposed; not built yet; ZFS restores off is superseded by 086 for Proxmox LXC; G16's condition is superseded by 093 only for what its run proves, and a failed rollback leaving the box stopped by 093 only for a rollback cut short by its node's restart |
| [071](071-gpu-boxes.md) | A GPU is part of a box's size, on any Linux box: none, shared or a whole card, chosen when it is made and changed by Resize | Accepted, with the owner's answers; not built yet |
| [072](072-voxl.md) | voxl streams Linux X11 desktops, beside today's streamers, as an option the owner picks | Withdrawn by the owner; unit V1 removed |
| [073](073-recordings-draw-the-pointer-keys-and-zooms-from-the-event-log.md) | Recordings draw the pointer, keys and zooms from the event log | Accepted; amended 8 November 2026, including Inter and the owner's icons; the still disc and a field too large to zoom are superseded by 079; a zoom before a window has painted, a result that stays until the next step, and two captions for one moment are superseded by 080; still stretches alone where the pointer is drawn, captions that keep their places, the wait before typing into a clicked field and a zoom held until a change elsewhere are superseded by 081; device boxes not yet |
| [074](074-a-box-has-a-files-view.md) | A box has a files view: the box user's own files, in the panel | Accepted; the view itself is superseded by 075 |
| [075](075-the-files-view-is-the-editor-plugins-ui.md) | The files view is the editor plugin's own UI, reading the box | Accepted; creating, renaming and a narrow window are in 076; initial loading and placement are superseded by 077 |
| [076](076-the-files-view-can-create-rename-and-delete.md) | The files view can create, rename and delete, and a narrow window shows one surface | Accepted |
| [077](077-files-draw-one-level-before-walking-names.md) | Files draw one level before walking names; cached reopen and a right-hand tree | Accepted |
| [078](078-files-keep-the-workspace-in-memory.md) | Files keep the workspace in memory across panel switches | Accepted |
| [079](079-a-click-ring-fades-and-a-large-field-zooms-on-its-line.md) | A click ring fades, and a large field zooms on its line | Accepted |
| [080](080-a-window-is-zoomed-once-it-has-painted-and-a-result-fades.md) | A window is zoomed once it has painted, and a result fades | Accepted; a result that fades after 2.5 seconds, and a flat window after a click in its field, are superseded by 081 |
| [081](081-a-recording-is-cut-to-its-actions-and-its-captions-keep-clear.md) | A recording is cut to its actions, and its captions keep clear | Accepted |
| [082](082-docker-snapshots.md) | A Docker snapshot is a paused commit of the box and a copy of its Docker volume, kept on its engine | Accepted; take, list, delete, restore, fork and Keep are built, and a fork holds every service until its check passes; a kept snapshot stays on the engine as it is, with one keep tag after any recovery; a fork of it after the release follows 087; Hetzner Cloud and Namespace take snapshots (items 7 and 8), extended by 089 |
| [083](083-android-devices-boot-cold-after-the-host-restarts.md) | Android snapshots use the existing unsaved marker | Accepted; preserves 063; boot-ID rule withdrawn |
| [084](084-a-take-says-how-long-it-pauses-the-box-before-and-after.md) | A take says how long it pauses the box, before and after | Accepted |
| [085](085-an-image-is-due-when-its-guest-folder-or-build-files-change.md) | An image is due when its guest folder or build files change | Accepted; extends 049 |
| [086](086-proxmox-lxc-boxes-restore-on-zfs-in-zfss-order.md) | Proxmox LXC boxes restore on ZFS in ZFS's order | Accepted; supersedes 070's "ZFS restores ship off" for Proxmox LXC; G16 accepted by the owner as unproved, and run in part in 093, which does not discharge it |
| [087](087-each-namespace-workspace-is-a-backend-that-labels-what-it-makes.md) | Each Namespace workspace is a backend that labels what it makes | Accepted; extends 042's several backends of a type to backends with no host |
| [088](088-a-fork-may-hold-its-gone-sources-address-when-its-provider-gave-it.md) | A fork may hold its gone source's address when its provider gave it | Accepted; extends 070's fork check |
| [089](089-windows-snapshots-on-tart-copy-a-disk-windows-shut-down.md) | Windows snapshots on Tart copy a disk Windows shut down | Accepted; extends 070 to Windows on Tart; fork and Keep wait for a Windows identity reset; image refreshes keep every build a box, snapshot or restore cut short stands on |
| [090](090-pool-machines-say-whether-they-snapshot.md) | Pool machines say whether they snapshot: home folders where they clone, or an operator's hook | Accepted, unit 1 of 5 built: machines report, and no pool snapshot is taken yet; extends 070 for the SSH host pool |
| [091](091-a-namespace-machine-with-snapshots-lives-while-its-box-has-a-container.md) | A Namespace machine with snapshots lives while its box has a container | Accepted; extends 082 with a release's scope, and Namespace's keep-alive, empty-machine and Docker outage rules |
| [092](092-a-backend-can-be-kept-for-bb-projects.md) | A backend can be kept for BB projects | Accepted |
| [093](093-proxmox-restores-recover-from-a-nodes-restart.md) | Proxmox restores recover from a node's restart | Accepted; G16 run in part on LVM-thin and ZFS, with root's steps where needed; supersedes 070's "a rollback task that failed leaves the box stopped" only for a rollback cut short by its node's restart, rolled back again once, with a second rollback whose answer was lost left open, not sent a third time; LVM-thin's rollback between its two steps needs root; a power cut can lose a recent undo, with no safe wait or recovery proved |
