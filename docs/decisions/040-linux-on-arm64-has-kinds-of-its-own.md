# 040: Linux on arm64 has kinds of its own

Status: accepted, 1 October 2026. Extends
[027](027-a-kind-says-when-it-has-a-desktop.md): where an architecture
goes in a kind's ID; and [028](028-a-box-size-is-chosen-when-it-is-made.md):
the arm64 kinds' presets.

## Context

A spike ran Linux VMs on a Mac with Tart. A fresh clone answers SSH in
about 5.5 s, only macOS guests count against the two-VM limit, and
Docker, BB's host app, Chrome and Cua all run. But the boxes are arm64:
an amd64 image fails with "exec format error", and an x86_64 binary does
not run. Offers of one kind agree on `arch`
([012](012-offers-may-add-features.md)), so they cannot join `linux`.

| Option | For | Against |
| --- | --- | --- |
| Kinds of their own, such as `linux-arm64` | no interface change; `box_list` shows them; never arm64 by surprise | more kinds; no way to ask for "any Linux" |
| The architecture as an acquire option, as size is ([028](028-a-box-size-is-chosen-when-it-is-made.md)) | the kinds stay as they are | an interface change: the agreement rule, capacity per architecture, and `box_list` |
| The same kinds, with `arch` only in capabilities | nothing to add | an agent asking for `linux` gets arm64 when the x86_64 hosts are full, and its binaries fail |

Neither of the first two falls back across architectures, so either way
the Mac's Linux boxes serve only agents that ask for arm64.

## Decision

- A kind's ID names its architecture when it is not the OS's usual one.
  `-arm64` follows the OS, and the rest of the ID is the x86_64 kind's.
  Linux and Windows kinds without it are x86_64. macOS runs on arm64 only
  and keeps no qualifier.

| Kind | Promises |
| --- | --- |
| `linux-arm64` | Linux on arm64, no GPU |
| `linux-arm64-docker` | as above, plus the feature `docker` |
| `linux-arm64-desktop-cpu` | a Linux desktop on arm64, drawn by the CPU |

- Their descriptions say that amd64 images and x86_64 binaries do not run
  there.
- Their presets are those of the x86_64 kinds they follow.
- The panel shows arm64 as a badge, beside Desktop, GPU and Docker, so
  two Linux kinds in a list can be told apart.
- Any later arm64 offer, such as Docker on an arm64 host or an arm64
  machine in an SSH pool, uses these kinds.

## Consequences

- No interface change, and three more kinds where an offer serves them.
- An agent that can use either architecture names one. If arm64 offers
  become common, the architecture can become an acquire option later,
  with these IDs kept as aliases, as 027 keeps its old IDs.
- An arm64 desktop with a GPU, such as one on an NVIDIA arm64 machine,
  would be `linux-arm64-desktop`.
- Tart cannot resume a suspended Linux VM (2.30.0), so Tart's `stop`
  shuts a Linux box down rather than suspend it, and a warm Linux VM, if
  any, keeps running. A cold clone is ready for SSH in about 5.5 s.
- The Linux template's tool pins gain an architecture column.
