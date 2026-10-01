# Decision records

Each record gives the context, the decision and its consequences. A decision
that changes gets a new record that supersedes the old one.

| | Decision |
| --- | --- |
| [001](001-provider-agnostic-core.md) | The core does not care who the provider is |
| [002](002-bb-is-the-coordinator.md) | BB is the coordinator |
| [003](003-boxes-live-until-released.md) | Boxes live until their thread ends or they are released |
| [004](004-acquire-and-release.md) | Acquire and release, for virtual and real machines |
| [005](005-linux-boxes-on-proxmox-lxc.md) | The first backend runs Linux boxes as unprivileged LXC containers on Proxmox VE |
| [006](006-gpu-desktop-on-xorg.md) | The Linux GPU desktop runs Xorg with NVIDIA's driver, streamed by x0vncserver |
| [007](007-desktop-stream-is-a-typed-transport.md) | The desktop stream is a typed transport, relayed through the plugin |
| [008](008-shared-control.md) | You and the agent share one desktop, with one controller at a time |
| [009](009-conformance-suite-and-doctor.md) | A conformance suite and a doctor check for every backend |
| [010](010-publishable-by-default.md) | The repository is publishable at all times |
| [011](011-interface-v1.md) | Interface v1: shared kinds, routes and displays |
| [012](012-offers-may-add-features.md) | A kind names what it promises, and offers may add features |
| [013](013-docker-boxes-run-unprivileged.md) | Docker boxes run unprivileged, without systemd |
| [014](014-enrol-through-machine-providers.md) | Boxes enrol through BB's machine provider API, when claimed |
| [015](015-computer-use-through-cua-driver.md) | Computer use drives a pinned Cua Driver through bb-box's own tools |
| [016](016-changes-from-building-v1.md) | Changes from building Interface v1: jump hosts, first keys, setup, stale releases, facts |
| [017](017-boxes-clear-bb-daemon-state-at-boot.md) | Boxes clear BB's daemon lock and PID file at boot |
| [018](018-guests-name-their-install-and-box.md) | Guests name their install and their box, and backends check both before acting |
| [019](019-lost-records-are-restored-from-guests.md) | The sweep restores lost records, and only BB ends a thread |
| [020](020-control-belongs-to-a-viewer.md) | Control belongs to one viewer, and a GPU desktop is retried on another GPU |
| [021](021-desktop-resize-through-the-backend.md) | A desktop whose VNC server cannot resize is resized by its backend |
| [022](022-references-follow-renames-not-rows.md) | A reference follows its element through a rename, not into another row |
| [023](023-a-reference-follows-its-element-through-its-own-rename.md) | A reference follows its element through its own rename |
| [024](024-an-element-renamed-out-of-sight-is-refused-once.md) | An action on an element renamed out of sight is refused once |
| [025](025-a-restored-box-enrols-again.md) | A restored box enrols again, keyed by its box ID |
| [026](026-a-restored-box-enrols-once-it-answers.md) | A restored box enrols once it answers |
| [027](027-a-kind-says-when-it-has-a-desktop.md) | A kind says when it has a desktop, and a plain box has no qualifier |
| [028](028-a-box-size-is-chosen-when-it-is-made.md) | A box's size is chosen when it is made, from presets per kind |
| [029](029-configuration-is-one-checked-document.md) | Configuration is one checked document in bb-box's storage, set through its page and CLI |
| [030](030-a-mac-runs-desktop-commands-through-launchctl-asuser.md) | A Mac runs desktop commands through `launchctl asuser` |
| [031](031-docker-boxes-are-reached-through-docker-exec.md) | Docker boxes are reached through `docker exec` |
