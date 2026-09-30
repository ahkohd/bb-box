# 005: The first backend runs Linux boxes as unprivileged LXC containers on Proxmox VE

Status: accepted, 30 September 2026.

## Context

The first boxes are Linux, headless and with a GPU desktop, and must be ready
in seconds. The options were containers, full VMs and microVMs.

| | LXC on Proxmox VE | QEMU VMs on Proxmox VE | microVMs (for example microsandbox) |
| --- | --- | --- | --- |
| Ready after start | about 1.2 s (measured) | a full boot with firmware (not measured here) | fast by design (not measured here) |
| Docker inside | yes, with `nesting=1` | yes | depends on the runtime |
| GPU | the host's driver, shared by several boxes | the whole GPU passed through to one VM | usually none |
| Host API | Proxmox API: linked clone, tags, pools | same | the runtime's own |

## Decision

- The first backend makes unprivileged LXC containers on a Proxmox VE host,
  by linked clone from one CT template per kind: `linux-headless` and
  `linux-desktop`.
- Root builds each template once with a script in this repository, including
  nesting and the GPU devices. bb-box's API token can only clone, configure,
  start, stop and delete in its own resource pool and guest ID range.
- Each box gets a static address derived from its guest ID, from a range in
  the settings, so there is no DHCP wait.
- Ownership is kept in Proxmox tags on the guest (box, thread and kind), so
  the sweep can find every box even if bb-box's storage is lost.
- The Proxmox API client is shared with the planned QEMU backend for Windows.
- microVM runtimes such as microsandbox are possible backends, not the first.

## Consequences

- Measured on Proxmox VE 9.2: clone 1 s, start 1 s, boot 0.8 s, SSH ready
  about 1.2 s after start.
- Containers share the host kernel. Kernel modules, a different kernel or
  another OS need the QEMU backend.
- The template's NVIDIA userspace driver must match the host's kernel driver
  exactly. A host driver upgrade means rebuilding the desktop template.
- Pool, guest ID range, bridge, storage, template IDs and address range are
  settings with generic defaults ([010](010-publishable-by-default.md)).
