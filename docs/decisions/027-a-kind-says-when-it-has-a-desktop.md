# 027: A kind says when it has a desktop, and a plain box has no qualifier

Status: accepted, 1 October 2026. Partly supersedes
[012](012-offers-may-add-features.md): the IDs and labels of the kinds
without a desktop. Partly superseded by
[029](029-configuration-is-one-checked-document.md): the keys from before
027 are read once, when BB's settings move into bb-box's configuration.
Extended by [040](040-linux-on-arm64-has-kinds-of-its-own.md): where an
architecture goes in a kind's ID.

## Context

012 named the kinds without a desktop `linux-headless` and
`linux-headless-docker`. Most boxes are of these kinds, so the word is in
most tool calls and on most rows of the panel, and it names what the box
lacks. The operator asked for the plain box to have no qualifier and for
desktops to say so.

Existing boxes carry the old IDs: in bb-box's records, in the kind tag
Proxmox LXC writes on each guest, which the sweep reads to restore a lost
record ([019](019-lost-records-are-restored-from-guests.md)), and in
settings, scripts and habits.

## Decision

- A kind without a desktop has no qualifier. A kind with a desktop has
  `desktop` in its ID and label. The ID still names what the kind promises,
  as 012 says, and a required feature is a suffix.

| Kind | Label | Old ID |
| --- | --- | --- |
| `linux` | Linux | `linux-headless` |
| `linux-docker` | Linux with Docker | `linux-headless-docker` |
| `linux-desktop` | Linux desktop | unchanged |
| `linux-desktop-cpu` | Linux desktop (no GPU) | unchanged |

- The later kinds follow the rule: `macos`, `macos-desktop`,
  `windows-desktop`.
- The default kind is `linux`.
- The old IDs stay accepted as aliases everywhere an ID comes in:
  `box_acquire` and the panel, settings, stored records, and owners read from
  guests. Everything bb-box shows uses the new IDs and labels.
- Core keeps the one alias table and maps an ID where it comes in, so the
  registry, `capacity`, `transports` and the views see only the new IDs.
  Backends offer only the new IDs. A backend that reads a kind from its own
  guests for its own use maps it with the same table.
- An old ID is never given to another kind.
- Proxmox LXC's `headless` flavour becomes `linux`. Its settings become
  `proxmox-lxc-linux-templates`, `-cores`, `-memory-mib`, `-disk-gib` and
  `-warm`. Each reads its `proxmox-lxc-headless-` key when it is unset, so
  saved values carry over. The setup guide's "headless template" becomes
  the Linux template, and `build.sh headless` keeps working.

## Consequences

- Existing boxes keep working, and nothing rewrites their guests: a guest
  keeps its old tag until it is released, and core reads it as the new ID.
  A stored record shows the new ID and the kind's current label.
- BB's settings handle returns the keys bb-box declares, with a key's
  declared default when it is unset. So the old keys stay declared, labelled
  as replaced, until a later release drops them. The new keys declare no
  default: Proxmox LXC applies its defaults itself, and each key's
  description gives its default.
- The Docker, SSH host pool and Tart backends use the new IDs from the
  start.
- Decision records before this one keep the old IDs as they were written.
  The architecture, research, README, skill and setup guide use the new
  ones.
