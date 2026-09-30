# 001: The core does not care who the provider is

Status: accepted, 30 September 2026.

## Context

bb-box must give threads machines from many providers:

- containers and VMs on a hypervisor;
- Macs, physical or running macOS VMs;
- physical machines;
- Docker hosts, clouds and sandbox runtimes.

The principle, in the operator's words: "if we do the arch well, it shouldn't
care who the provider is: proxmox, crabbox, lxc, vm, physical; the abstraction
solves this as long as bb-box is concerned."

If the first backend's details leak into the rest of the code, every later
backend means rewriting the core, and nobody can run bb-box without that
provider.

## Decision

The code has three parts.

| Part | Owns | Never |
| --- | --- | --- |
| Core | registry, lifecycle, agent tools, panel, BB enrolment, thread access, computer use, desktop viewer | names a provider, hypervisor, container technology or transport |
| Transports | reaching inside a box: running commands and copying files, streaming a desktop | knows which provider made the box |
| Backends | adapting one provider: acquire and release, address, capacity, and which transports reach each box | runs anything inside a box on the core's behalf |

- The core depends only on the backend interface and the transport interface.
- A kind declares its capabilities: guest OS, desktop, GPU, Docker, command
  transport, desktop stream, and whether it enrols in BB. The panel and tools
  follow these declarations and never branch on the backend or transport name.
- Everything that runs inside a box is written once, per guest OS, and goes
  through the command transport. That covers BB enrolment, the thread's
  access, commands, file copies and computer use. The scripts are POSIX sh
  for Linux and macOS, and PowerShell for Windows.
- Transports are shared modules that backends compose. Commands and file
  copies go over SSH now; `docker exec`, WinRM or an in-box agent come later.
  The desktop streams over RFB (VNC) now, and Selkies later.
- Any provider can become a backend by implementing the interface.

## Consequences

- Adding a backend means one directory and one entry in the driver list.
  Nothing in the core changes.
- One conformance suite runs against every backend, so the principle is tested
  rather than assumed ([009](009-conformance-suite-and-doctor.md)).
- Reviews check it: code outside `src/backends/` and `src/transports/` that
  names Proxmox, LXC, Docker, SSH, VNC, a VMID or a Linux path is a defect.
- Some provider features stay unused until the interface grows a general
  capability for them (for example snapshots or suspend). Such a capability is
  added to the interface, never special-cased in the core.
