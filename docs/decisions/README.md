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
